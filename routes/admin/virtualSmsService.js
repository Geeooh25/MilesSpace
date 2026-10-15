// services/virtualSmsService.js
// ─────────────────────────────────────────────────────────────────
// User-facing VirtualSMS flow: rent a number → poll for the code.
//
// Money rules:
//   • Debit before the provider call, via LedgerService.
//   • Provider definite failure → refund the debit.
//   • Provider ambiguous failure → leave processing; scheduler resolves.
//   • The scheduler + admin can force a requery.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const virtualSms = require('../../services/providers/virtualSmsProvider');

const POLL_INTERVAL_SECONDS = 3;
const MAX_AGE_MINUTES = 20;

function assertNumber(n, name) {
    const v = Number(n);
    if (!Number.isInteger(v) || v <= 0) {
        const e = new Error(`Invalid ${name}`); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    return v;
}

// ─── Rent ───────────────────────────────────────────────────────

async function rentNumber({ userId, countryId, serviceCode, currency = 'NGN', idempotencyKey }) {
    if (!userId) { const e = new Error('User required'); e.status = 400; e.code = 'INVALID_USER'; throw e; }

    const idem = idempotencyKey || crypto.randomUUID();

    // Idempotency: if this key already created an order, return it.
    const { data: existing } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('id, status, phone_number, provider_order_id, charge_amount, charge_currency, price_usd, price_ngn, service_name, expires_at, created_at')
        .eq('user_id', userId)
        .eq('idempotency_key', idem)
        .maybeSingle();
    if (existing) return { reused: true, order: existing };

    // Fetch catalog price (from the DB cache — the scheduler keeps it fresh).
    const { data: pricing } = await supabaseAdmin
        .from('virtual_sms_services')
        .select('service_name, provider_cost_usd, selling_price_usd, selling_price_ngn, available_count')
        .eq('country_id', countryId)
        .eq('service_code', serviceCode)
        .eq('enabled', true)
        .maybeSingle();

    if (!pricing || (pricing.available_count || 0) <= 0) {
        const e = new Error('No numbers available for this service.');
        e.status = 400; e.code = 'NO_INVENTORY'; throw e;
    }

    const priceUsd = Number(pricing.selling_price_usd) || 0;
    const priceNgn = Number(pricing.selling_price_ngn) || 0;
    if (priceUsd <= 0 || priceNgn <= 0) {
        const e = new Error('Invalid price for this service.');
        e.status = 400; e.code = 'INVALID_PRICE'; throw e;
    }

    const chargeCurrency = currency === 'USD' ? 'USD' : 'NGN';
    const chargeAmount = chargeCurrency === 'USD' ? priceUsd : priceNgn;

    const expiresAt = new Date(Date.now() + MAX_AGE_MINUTES * 60 * 1000).toISOString();
    const orderId = crypto.randomUUID();

    const { data: order, error: orderErr } = await supabaseAdmin
        .from('virtual_sms_orders')
        .insert({
            id: orderId,
            user_id: userId,
            country_id: countryId,
            service_code: serviceCode,
            service_name: pricing.service_name || serviceCode,
            price_usd: priceUsd,
            price_ngn: priceNgn,
            provider_cost_usd: pricing.provider_cost_usd || 0,
            charge_currency: chargeCurrency,
            charge_amount: chargeAmount,
            status: 'pending',
            idempotency_key: idem,
            expires_at: expiresAt,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .select('*')
        .single();
    if (orderErr) {
        if (orderErr.code === '23505') {
            // Another concurrent request won the race — return theirs.
            const { data: sibling } = await supabaseAdmin
                .from('virtual_sms_orders')
                .select('*')
                .eq('user_id', userId)
                .eq('idempotency_key', idem)
                .maybeSingle();
            return { reused: true, order: sibling };
        }
        throw new Error('Failed to create order.');
    }

    // Debit the wallet via the ledger authority.
    let debit;
    try {
        debit = await LedgerService.debitWallet({
            userId,
            amount: chargeAmount,
            currency: chargeCurrency,
            description: `Virtual SMS: ${pricing.service_name || serviceCode}`,
            reference: `VSMS-DEBIT-${orderId}`,
            type: 'virtual_sms',
            sourceType: 'virtual_sms_order',
            sourceId: orderId,
            metadata: { country_id: countryId, service_code: serviceCode }
        });
    } catch (debitErr) {
        await supabaseAdmin
            .from('virtual_sms_orders')
            .update({ status: 'failed', failure_message: 'Insufficient balance', updated_at: new Date().toISOString() })
            .eq('id', orderId);
        const e = new Error(debitErr.message || 'Insufficient balance.');
        e.status = 400; e.code = 'INSUFFICIENT_BALANCE'; throw e;
    }

    await supabaseAdmin
        .from('virtual_sms_orders')
        .update({
            ledger_transaction_id: debit.transaction_id,
            status: 'processing',
            updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

    // Call the provider.
    let providerResult;
    try {
        providerResult = await virtualSms.createOrder({
            service: serviceCode,
            country: countryId,
            orderId
        });
    } catch (providerErr) {
        const definitive = providerErr.definitive === true;
        const code = providerErr.code || 'PROVIDER_ERROR';

        if (definitive) {
            // Refund and fail.
            try {
                await LedgerService.creditWallet({
                    userId,
                    amount: chargeAmount,
                    currency: chargeCurrency,
                    description: `Refund: Virtual SMS failed (${code})`,
                    reference: `VSMS-REFUND-${orderId}`,
                    type: 'refund',
                    sourceType: 'virtual_sms_order',
                    sourceId: orderId,
                    metadata: { original_transaction_id: debit.transaction_id, failure_code: code }
                });
            } catch (refundErr) {
                console.error('[vsms] refund failed', orderId, refundErr.message);
                await supabaseAdmin
                    .from('virtual_sms_orders')
                    .update({
                        status: 'manual_review',
                        failure_code: code,
                        failure_message: providerErr.message,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', orderId);
                const e = new Error('Payment failed. Support has been notified.');
                e.status = 500; e.code = 'MANUAL_REVIEW_NEEDED'; throw e;
            }

            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    status: 'refunded',
                    failure_code: code,
                    failure_message: providerErr.message,
                    refunded_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);

            const e = new Error(providerErr.message || 'Service temporarily unavailable. Your payment has been refunded.');
            e.status = 400; e.code = 'PROVIDER_FAILURE_REFUNDED'; throw e;
        }

        // Ambiguous — leave processing, scheduler will resolve.
        await supabaseAdmin
            .from('virtual_sms_orders')
            .update({
                status: 'processing',
                failure_message: providerErr.message,
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);

        return {
            order: {
                id: orderId,
                status: 'processing',
                charge_amount: chargeAmount,
                charge_currency: chargeCurrency,
                expires_at: expiresAt,
                ledger_transaction_id: debit.transaction_id
            },
            pending: true
        };
    }

    // Success.
    await supabaseAdmin
        .from('virtual_sms_orders')
        .update({
            provider_order_id: providerResult.providerOrderId,
            phone_number: providerResult.phoneNumber,
            provider_response: providerResult.raw,
            status: 'active',
            activated_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

    return {
        order: {
            id: orderId,
            status: 'active',
            phone_number: providerResult.phoneNumber,
            charge_amount: chargeAmount,
            charge_currency: chargeCurrency,
            expires_at: expiresAt,
            ledger_transaction_id: debit.transaction_id
        }
    };
}

// ─── Poll for code ──────────────────────────────────────────────

async function getSmsCode({ userId, orderId }) {
    const { data: order, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('id, user_id, status, provider_order_id, sms_code, sms_received_at, expires_at, charge_amount, charge_currency')
        .eq('id', orderId)
        .eq('user_id', userId)
        .maybeSingle();
    if (error || !order) { const e = new Error('Order not found'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }

    if (order.sms_code) {
        return { status: 'STATUS_OK', code: order.sms_code, received_at: order.sms_received_at };
    }
    if (['cancelled','refunded','expired','failed'].includes(order.status)) {
        return { status: order.status.toUpperCase(), code: null };
    }
    if (!order.provider_order_id) {
        return { status: 'PENDING', code: null };
    }

    let result;
    try {
        result = await virtualSms.getOrderStatus({ provider_order_id: order.provider_order_id });
    } catch (e) {
        return { status: 'WAITING', code: null, error: 'Provider temporarily unavailable' };
    }

    if (result.code) {
        await supabaseAdmin
            .from('virtual_sms_orders')
            .update({
                sms_code: result.code,
                sms_received_at: new Date().toISOString(),
                status: 'sms_received',
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);

        return { status: 'STATUS_OK', code: result.code, received_at: new Date().toISOString() };
    }

    return { status: result.providerStatus || 'WAITING', code: null };
}

module.exports = {
    rentNumber,
    getSmsCode,
    POLL_INTERVAL_SECONDS
};