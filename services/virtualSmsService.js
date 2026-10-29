// services/virtualSmsService.js
// ─────────────────────────────────────────────────────────────────
// User-facing VirtualSMS flow: rent a number → poll for the code.
//
// PRICING AUTHORITY:
//   • The admin settings page is the single source of truth for
//     the customer-facing price. This file calls
//     adminSettingsService on EVERY rent so a markup or FX change
//     takes effect on the next request — no row edits required.
//   • The `virtual_sms_services` row still stores the provider's
//     wholesale cost in USD (`provider_cost_usd`). That number
//     comes from the provider/scheduler and is not a price.
//   • Prices are computed with integer-cent arithmetic via
//     adminSettingsService.calculatePrice() so the result matches
//     what Postgres NUMERIC would produce.
//
// MONEY RULES:
//   • Debit before the provider call, via LedgerService.
//   • Provider definite failure → refund the debit.
//   • Provider ambiguous failure → leave processing; scheduler resolves.
//   • The scheduler + admin can force a requery.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const adminSettings = require('./adminSettingsService');
const virtualSms = require('./providers/virtualSmsProvider');

const POLL_INTERVAL_SECONDS = 3;
const MAX_AGE_MINUTES = 20;

function assertNumber(n, name) {
    const v = Number(n);
    if (!Number.isInteger(v) || v <= 0) {
        const e = new Error(`Invalid ${name}`); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    return v;
}

// ─── Pricing ────────────────────────────────────────────────────
//
// Resolve the customer-facing price for one catalogue row.
// Always recomputes from admin settings — never trusts a stale
// `selling_price_*` column.
//
// Returns { priceUsd, priceNgn, wholesaleUsd, usdToNgn, markup }.
async function resolvePriceForService({ providerCostUsd }) {
    const wholesaleUsd = Number(providerCostUsd);
    if (!Number.isFinite(wholesaleUsd) || wholesaleUsd <= 0) {
        const e = new Error('Provider cost is not configured for this service.');
        e.status = 503;
        e.code = 'PROVIDER_COST_MISSING';
        throw e;
    }

    // Markup is admin-controlled. `virtual_sms_markup_pct` is stored
    // as a decimal (e.g. 0.1500 = 15%).
    const calcUsd = await adminSettings.calculatePrice({
        service: 'virtual_sms',
        currency: 'USD',
        wholesaleAmount: wholesaleUsd.toFixed(2)
    });

    const priceUsd = Number(calcUsd.customerPrice);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        const e = new Error('Computed USD price is invalid.');
        e.status = 503;
        e.code = 'PRICE_COMPUTE_FAILED';
        throw e;
    }

    // FX is admin-controlled via `usd_to_ngn`. A single rate
    // converts the customer USD price into NGN — the same rate is
    // recorded on the order row so historical reports can be
    // reconciled against the FX that was in force at rent time.
    const usdToNgn = await adminSettings.getRate('USD', 'NGN');
    if (!Number.isFinite(usdToNgn) || usdToNgn <= 0) {
        const e = new Error('USD→NGN rate is not configured.');
        e.status = 503;
        e.code = 'RATE_NOT_CONFIGURED';
        throw e;
    }
    const priceNgn = Number((priceUsd * usdToNgn).toFixed(2));

    return {
        priceUsd,
        priceNgn,
        wholesaleUsd,
        usdToNgn,
        markup: calcUsd.markup
    };
}

// Enforce admin-configured per-order limits in NGN equivalent.
async function assertWithinLimits({ chargeAmount, chargeCurrency, usdToNgn }) {
    const minNgn = Number(await adminSettings.getRaw('virtual_sms_min_ngn'));
    const maxNgn = Number(await adminSettings.getRaw('virtual_sms_max_ngn'));

    const ngnEquivalent = String(chargeCurrency).toUpperCase() === 'USD'
        ? Number(chargeAmount) * usdToNgn
        : Number(chargeAmount);

    if (Number.isFinite(minNgn) && minNgn > 0 && ngnEquivalent < minNgn) {
        const e = new Error(`Minimum order for Virtual SMS is ₦${minNgn.toFixed(2)}.`);
        e.status = 400;
        e.code = 'BELOW_MIN_LIMIT';
        e.min_ngn = minNgn;
        throw e;
    }
    if (Number.isFinite(maxNgn) && maxNgn > 0 && ngnEquivalent > maxNgn) {
        const e = new Error(`Maximum order for Virtual SMS is ₦${maxNgn.toFixed(2)}.`);
        e.status = 400;
        e.code = 'ABOVE_MAX_LIMIT';
        e.max_ngn = maxNgn;
        throw e;
    }
}

// ─── Rent ───────────────────────────────────────────────────────

async function rentNumber({ userId, countryId, serviceCode, currency = 'NGN', idempotencyKey }) {
    if (!userId) { const e = new Error('User required'); e.status = 400; e.code = 'INVALID_USER'; throw e; }

    // 1. Service-enabled gate — admin can turn the whole feature off.
    await adminSettings.assertServiceEnabled('virtual_sms');

    const idem = idempotencyKey || crypto.randomUUID();

    // 2. Idempotency: if this key already created an order, return it.
    const { data: existing } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('id, status, phone_number, provider_order_id, charge_amount, charge_currency, price_usd, price_ngn, service_name, expires_at, created_at')
        .eq('user_id', userId)
        .eq('idempotency_key', idem)
        .maybeSingle();
    if (existing) return { reused: true, order: existing };

    // 3. Fetch the catalogue row. `provider_cost_usd` is the only
    //    monetary field we trust from this table. Everything we
    //    actually charge is derived below from admin settings.
    const { data: pricing } = await supabaseAdmin
        .from('virtual_sms_services')
        .select('service_name, provider_cost_usd, available_count')
        .eq('country_id', countryId)
        .eq('service_code', serviceCode)
        .eq('enabled', true)
        .maybeSingle();

    if (!pricing || (pricing.available_count || 0) <= 0) {
        const e = new Error('No numbers available for this service.');
        e.status = 400; e.code = 'NO_INVENTORY'; throw e;
    }

    // 4. Compute the customer-facing price from admin settings.
    const priced = await resolvePriceForService({
        providerCostUsd: pricing.provider_cost_usd
    });

    const chargeCurrency = currency === 'USD' ? 'USD' : 'NGN';
    const chargeAmount = chargeCurrency === 'USD' ? priced.priceUsd : priced.priceNgn;

    // 5. Enforce admin-configured limits.
    await assertWithinLimits({
        chargeAmount,
        chargeCurrency,
        usdToNgn: priced.usdToNgn
    });

    const expiresAt = new Date(Date.now() + MAX_AGE_MINUTES * 60 * 1000).toISOString();
    const orderId = crypto.randomUUID();

    // 6. Create the order with the freshly-computed prices. We also
    //    record the FX rate used so historical reports can reconcile.
    const { data: order, error: orderErr } = await supabaseAdmin
        .from('virtual_sms_orders')
        .insert({
            id: orderId,
            user_id: userId,
            country_id: countryId,
            service_code: serviceCode,
            service_name: pricing.service_name || serviceCode,
            price_usd: priced.priceUsd,
            price_ngn: priced.priceNgn,
            provider_cost_usd: priced.wholesaleUsd,
            exchange_rate: priced.usdToNgn,
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
            // Race: another concurrent request won — return theirs.
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

    // 7. Debit the wallet via the ledger authority.
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
            metadata: {
                country_id: countryId,
                service_code: serviceCode,
                exchange_rate: priced.usdToNgn,
                markup: priced.markup
            }
        });
    } catch (debitErr) {
        await supabaseAdmin
            .from('virtual_sms_orders')
            .update({
                status: 'failed',
                failure_message: 'Insufficient balance',
                updated_at: new Date().toISOString()
            })
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

    // 8. Call the provider.
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
                    metadata: {
                        original_transaction_id: debit.transaction_id,
                        failure_code: code
                    }
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

        // Ambiguous — leave processing, scheduler resolves.
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

    // 9. Success.
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
    if (['cancelled', 'refunded', 'expired', 'failed'].includes(order.status)) {
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
    POLL_INTERVAL_SECONDS,

    // Exported so the listing route and any future admin tool can
    // reuse the exact same pricing math the rent flow uses.
    resolvePriceForService,
    assertWithinLimits
};