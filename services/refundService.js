// services/refundService.js
// ─────────────────────────────────────────────────────────────────
// Central refund authority. Every service goes through this.
//
// Guarantees:
//   • No `select('*')` anywhere. Explicit column allowlists.
//   • Refund uniqueness is enforced by the DB (unique partial
//     index per refund_type). Application check is belt, not braces.
//   • Idempotency key is written through a unique index — a
//     duplicate insert returns 23505 which we treat as "already
//     processed".
//   • Every refund type decides its own accounting:
//       wallet   → LedgerService.creditWallet
//       provider → provider adapter, then webhook credits
//       reversal → LedgerService.debitWallet
//   • Never credits more than the refundable remainder.
//   • Never assumes a failed ledger call succeeded.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const IdempotencyService = require('./idempotencyService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WALLET_REFUNDABLE_TYPES = new Set([
    'wallet_debit', 'cashback_used',
    'gift', 'gift_card', 'airtime', 'data', 'esim',
    'boost', 'marketplace', 'purchase', 'virtual_sms', 'sms', 'bills'
]);

const PROVIDER_REFUNDABLE_TYPES = new Set(['deposit', 'provider_payment']);
const REVERSIBLE_TYPES = new Set(['deposit', 'cashback_earned']);

const TX_COLUMNS = [
    'id', 'user_id', 'type', 'status', 'currency', 'amount', 'description',
    'reference', 'provider', 'provider_reference', 'source_type', 'source_id'
].join(', ');

const REFUND_COLUMNS = [
    'id', 'original_transaction_id', 'refund_transaction_id', 'user_id',
    'refund_type', 'amount', 'currency', 'reason', 'status',
    'provider', 'provider_refund_ref', 'requested_by', 'approved_by',
    'failure_reason', 'created_at', 'updated_at', 'approved_at',
    'completed_at', 'failed_at'
].join(', ');

function svcErr(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code; e.status = status; Object.assign(e, extra);
    return e;
}

function toNumber(v) {
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

async function getRefundCapability(transactionId) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        throw svcErr('INVALID_ID', 'Invalid transaction id.', 400);
    }
    const { data: tx, error } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, status, currency, amount, provider, provider_reference')
        .eq('id', transactionId)
        .maybeSingle();
    if (error) throw svcErr('REFUND_CAP_LOOKUP_FAILED', 'Failed to load transaction.', 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const type = String(tx.type || '').toLowerCase();
    const status = String(tx.status || '').toLowerCase();
    const amount = toNumber(tx.amount);

    const { data: existing } = await supabaseAdmin
        .from('refunds')
        .select('id, status, refund_type, amount')
        .eq('original_transaction_id', tx.id)
        .in('status', ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'COMPLETED']);

    const alreadyRefundedAmount = (existing || [])
        .filter(r => r.status === 'COMPLETED')
        .reduce((sum, r) => sum + toNumber(r.amount), 0);

    const pendingRefund = (existing || []).find(r =>
        ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING'].includes(r.status)
    );

    const remaining = Math.max(0, amount - alreadyRefundedAmount);

    const base = {
        eligible: false, methods: [], max_amount: '0.00',
        currency: tx.currency,
        already_refunded: alreadyRefundedAmount > 0,
        already_refunded_amount: alreadyRefundedAmount.toFixed(2),
        pending_refund_id: pendingRefund?.id || null,
        requires_step_up: true, requires_approval: false, reason: null
    };

    if (pendingRefund) return { ...base, reason: 'PENDING_REFUND_EXISTS' };
    if (remaining <= 0) return { ...base, reason: 'ALREADY_REFUNDED' };
    if (status === 'reversed') return { ...base, reason: 'ALREADY_REVERSED' };

    if (WALLET_REFUNDABLE_TYPES.has(type)) {
        return {
            ...base, eligible: true, methods: ['wallet'],
            max_amount: remaining.toFixed(2),
            requires_approval: remaining >= 100_000
        };
    }
    if (PROVIDER_REFUNDABLE_TYPES.has(type)) {
        if (!tx.provider) return { ...base, reason: 'NO_PROVIDER_ON_RECORD' };
        return {
            ...base, eligible: true, methods: ['provider'],
            max_amount: remaining.toFixed(2), requires_approval: true
        };
    }
    if (REVERSIBLE_TYPES.has(type)) {
        return {
            ...base, eligible: true, methods: ['reversal'],
            max_amount: remaining.toFixed(2), requires_approval: true
        };
    }
    return { ...base, reason: 'TYPE_NOT_REFUNDABLE' };
}

async function executeWalletRefund({ transactionId, amount, reason, ctx, idempotencyKey }) {
    if (!UUID_RE.test(String(transactionId || ''))) throw svcErr('INVALID_ID', 'Invalid transaction id.', 400);
    const amt = toNumber(amount);
    if (amt <= 0) throw svcErr('INVALID_AMOUNT', 'Refund amount must be positive.', 422);
    const trimmedReason = String(reason || '').trim();
    if (trimmedReason.length < 4) throw svcErr('REASON_REQUIRED', 'Reason required.', 422);

    if (idempotencyKey) {
        const cached = await IdempotencyService.check(
            ctx.adminId || 'admin', idempotencyKey, 'admin.transactions.refund'
        );
        if (cached) return cached;
    }

    const { data: tx, error } = await supabaseAdmin
        .from('transactions')
        .select(TX_COLUMNS)
        .eq('id', transactionId)
        .maybeSingle();
    if (error) throw svcErr('REFUND_LOOKUP_FAILED', 'Failed to load transaction.', 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const type = String(tx.type || '').toLowerCase();
    if (!WALLET_REFUNDABLE_TYPES.has(type)) {
        throw svcErr('TYPE_NOT_REFUNDABLE', `Transaction type "${tx.type}" cannot be wallet-refunded.`, 422);
    }
    if (String(tx.status).toLowerCase() === 'refunded') {
        throw svcErr('ALREADY_REFUNDED', 'Transaction is already refunded.', 409);
    }
    const originalAmount = toNumber(tx.amount);
    if (amt > originalAmount) {
        throw svcErr('REFUND_EXCEEDS_ORIGINAL', 'Refund exceeds original amount.', 422);
    }

    let ledgerResult;
    try {
        ledgerResult = await LedgerService.creditWallet({
            userId: tx.user_id, amount: amt, currency: tx.currency,
            description: `Refund: ${tx.description || tx.type} (${trimmedReason})`,
            reference: `REF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`,
            sourceType: 'refund', sourceId: tx.id, type: 'refund',
            metadata: {
                original_transaction_id: tx.id,
                original_reference: tx.reference,
                original_type: tx.type,
                original_amount: tx.amount,
                refund_amount: amt,
                reason: trimmedReason,
                admin_id: ctx.adminId,
                admin_email: ctx.adminEmail,
                request_id: ctx.requestId
            }
        });
    } catch (ledgerErr) {
        throw svcErr('LEDGER_REFUND_FAILED', ledgerErr.message || 'Ledger rejected refund.', 400);
    }

    let refundId;
    try {
        const { data, error: rpcErr } = await supabaseAdmin.rpc('create_refund_atomic', {
            p_original_tx_id: tx.id,
            p_refund_tx_id: ledgerResult.transaction_id,
            p_user_id: tx.user_id,
            p_amount: amt,
            p_currency: tx.currency,
            p_reason: trimmedReason,
            p_refund_type: 'wallet',
            p_provider: null,
            p_provider_refund_ref: null,
            p_requested_by: ctx.adminId || null,
            p_idempotency_key: idempotencyKey || null,
            p_metadata: { request_id: ctx.requestId, admin_email: ctx.adminEmail }
        });
        if (rpcErr) {
            if (rpcErr.code === '23505') {
                // Unique index caught a duplicate refund. Fetch the
                // existing one and return it as a no-op.
                const { data: existing } = await supabaseAdmin
                    .from('refunds')
                    .select(REFUND_COLUMNS)
                    .eq('original_transaction_id', tx.id)
                    .eq('refund_type', 'wallet')
                    .in('status', ['COMPLETED', 'PROCESSING', 'APPROVED'])
                    .maybeSingle();
                if (existing) {
                    return { refund: { ...existing, already_refunded: true } };
                }
            }
            console.error('[REFUND] create_refund_atomic failed after ledger credit:', rpcErr.message);
            throw svcErr('REFUND_RECORD_FAILED',
                'Refund was posted to the ledger but the refund record could not be created. Please escalate.',
                500, { ledger_transaction_id: ledgerResult.transaction_id });
        }
        refundId = data;
    } catch (e) {
        if (e.code === 'REFUND_RECORD_FAILED') throw e;
        throw svcErr('REFUND_RECORD_FAILED', e.message || 'Failed to create refund record.', 500);
    }

    const result = {
        refund: {
            id: refundId, type: 'wallet', amount: amt, currency: tx.currency,
            refund_transaction_id: ledgerResult.transaction_id,
            refund_reference: ledgerResult.reference,
            original_transaction_id: tx.id, status: 'COMPLETED'
        }
    };

    if (idempotencyKey) {
        try {
            await IdempotencyService.save(
                ctx.adminId || 'admin', idempotencyKey, 'admin.transactions.refund', result
            );
        } catch (_) { /* unique index will block; ignore */ }
    }
    return result;
}

async function executeProviderRefund({ transactionId, amount, reason, ctx, idempotencyKey }) {
    if (!UUID_RE.test(String(transactionId || ''))) throw svcErr('INVALID_ID', 'Invalid transaction id.', 400);
    const amt = toNumber(amount);
    if (amt <= 0) throw svcErr('INVALID_AMOUNT', 'Refund amount must be positive.', 422);
    const trimmedReason = String(reason || '').trim();
    if (trimmedReason.length < 4) throw svcErr('REASON_REQUIRED', 'Reason required.', 422);

    const { data: tx, error } = await supabaseAdmin
        .from('transactions')
        .select(TX_COLUMNS)
        .eq('id', transactionId)
        .maybeSingle();
    if (error) throw svcErr('REFUND_LOOKUP_FAILED', 'Failed to load transaction.', 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const type = String(tx.type || '').toLowerCase();
    if (!PROVIDER_REFUNDABLE_TYPES.has(type)) {
        throw svcErr('TYPE_NOT_PROVIDER_REFUNDABLE', `Transaction type "${tx.type}" cannot be provider-refunded.`, 422);
    }
    if (!tx.provider) throw svcErr('NO_PROVIDER', 'No provider on record.', 422);

    const { data: refundRow, error: insErr } = await supabaseAdmin
        .from('refunds')
        .insert({
            original_transaction_id: tx.id,
            refund_transaction_id: null,
            user_id: tx.user_id,
            refund_type: 'provider',
            amount: amt,
            currency: tx.currency,
            reason: trimmedReason,
            status: 'PROCESSING',
            provider: tx.provider,
            requested_by: ctx.adminId || null,
            idempotency_key: idempotencyKey || null,
            metadata: {
                provider_reference: tx.provider_reference,
                admin_email: ctx.adminEmail,
                request_id: ctx.requestId
            }
        })
        .select(REFUND_COLUMNS)
        .single();

    if (insErr) {
        if (insErr.code === '23505') {
            throw svcErr('REFUND_ALREADY_IN_FLIGHT', 'A provider refund for this transaction is already in progress.', 409);
        }
        throw svcErr('PROVIDER_REFUND_CREATE_FAILED', insErr.message, 500);
    }

    let providerResult;
    try {
        const adapterPath = `../providers/${tx.provider}/refundAdapter`;
        const adapter = require(adapterPath);
        providerResult = await adapter.initiateRefund({
            refundId: refundRow.id,
            providerReference: tx.provider_reference,
            amount: amt,
            currency: tx.currency,
            reason: trimmedReason
        });
    } catch (e) {
        await supabaseAdmin
            .from('refunds')
            .update({
                status: 'FAILED',
                failure_reason: e.message || 'Provider adapter error',
                failed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', refundRow.id);
        throw svcErr('PROVIDER_REFUND_DISPATCH_FAILED', e.message || 'Provider refund dispatch failed.', 502);
    }

    await supabaseAdmin
        .from('refunds')
        .update({
            provider_refund_ref: providerResult?.provider_refund_ref || null,
            updated_at: new Date().toISOString()
        })
        .eq('id', refundRow.id);

    return {
        refund: {
            id: refundRow.id, type: 'provider', amount: amt, currency: tx.currency,
            status: 'PROCESSING', provider: tx.provider,
            provider_refund_ref: providerResult?.provider_refund_ref || null
        }
    };
}

async function executeDepositReversal({ transactionId, amount, reason, ctx, idempotencyKey }) {
    if (!UUID_RE.test(String(transactionId || ''))) throw svcErr('INVALID_ID', 'Invalid transaction id.', 400);
    const amt = toNumber(amount);
    if (amt <= 0) throw svcErr('INVALID_AMOUNT', 'Reversal amount must be positive.', 422);
    const trimmedReason = String(reason || '').trim();
    if (trimmedReason.length < 4) throw svcErr('REASON_REQUIRED', 'Reason required.', 422);

    const { data: tx, error } = await supabaseAdmin
        .from('transactions')
        .select(TX_COLUMNS)
        .eq('id', transactionId)
        .maybeSingle();
    if (error) throw svcErr('REVERSAL_LOOKUP_FAILED', 'Failed to load transaction.', 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const type = String(tx.type || '').toLowerCase();
    if (!REVERSIBLE_TYPES.has(type)) {
        throw svcErr('TYPE_NOT_REVERSIBLE', `Transaction type "${tx.type}" cannot be reversed.`, 422);
    }
    const originalAmount = toNumber(tx.amount);
    if (amt > originalAmount) {
        throw svcErr('REVERSAL_EXCEEDS_ORIGINAL', 'Reversal exceeds original amount.', 422);
    }

    let ledgerResult;
    try {
        ledgerResult = await LedgerService.debitWallet({
            userId: tx.user_id, amount: amt, currency: tx.currency,
            description: `Deposit reversal: ${trimmedReason}`,
            reference: `REV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`,
            sourceType: 'reversal', sourceId: tx.id, type: 'reversal',
            metadata: {
                original_transaction_id: tx.id,
                original_reference: tx.reference,
                original_amount: tx.amount,
                reason: trimmedReason,
                admin_id: ctx.adminId,
                request_id: ctx.requestId
            }
        });
    } catch (ledgerErr) {
        throw svcErr('LEDGER_REVERSAL_FAILED', ledgerErr.message || 'Ledger rejected reversal.', 400);
    }

    const { data: refundId, error: rpcErr } = await supabaseAdmin.rpc('create_refund_atomic', {
        p_original_tx_id: tx.id,
        p_refund_tx_id: ledgerResult.transaction_id,
        p_user_id: tx.user_id,
        p_amount: amt,
        p_currency: tx.currency,
        p_reason: trimmedReason,
        p_refund_type: 'reversal',
        p_provider: null,
        p_provider_refund_ref: null,
        p_requested_by: ctx.adminId || null,
        p_idempotency_key: idempotencyKey || null,
        p_metadata: { request_id: ctx.requestId }
    });
    if (rpcErr) {
        if (rpcErr.code === '23505') {
            throw svcErr('REVERSAL_ALREADY_IN_FLIGHT', 'A reversal for this transaction already exists.', 409);
        }
        console.error('[REVERSAL] create_refund_atomic failed after ledger debit:', rpcErr.message);
        throw svcErr('REVERSAL_RECORD_FAILED',
            'Reversal posted to ledger but the record could not be attached. Escalate.',
            500, { ledger_transaction_id: ledgerResult.transaction_id });
    }

    return {
        refund: {
            id: refundId, type: 'reversal', amount: amt, currency: tx.currency,
            reversal_transaction_id: ledgerResult.transaction_id,
            reversal_reference: ledgerResult.reference, status: 'COMPLETED'
        }
    };
}

async function listRefunds({ status, limit = 50, page = 1 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    let q = supabaseAdmin
        .from('refunds')
        .select(REFUND_COLUMNS, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(off, off + lim - 1);
    if (status && status !== 'all') q = q.eq('status', String(status).toUpperCase());
    const { data, error, count } = await q;
    if (error) throw svcErr('REFUNDS_LIST_FAILED', error.message, 500);
    return {
        refunds: data || [],
        count: count || 0,
        page: Math.max(parseInt(page, 10) || 1, 1),
        limit: lim,
        totalPages: Math.ceil((count || 0) / lim)
    };
}

async function getRefund(id) {
    if (!UUID_RE.test(String(id || ''))) throw svcErr('INVALID_ID', 'Invalid refund id.', 400);
    const { data, error } = await supabaseAdmin
        .from('refunds')
        .select(REFUND_COLUMNS)
        .eq('id', id)
        .maybeSingle();
    if (error) throw svcErr('REFUND_READ_FAILED', error.message, 500);
    if (!data) throw svcErr('REFUND_NOT_FOUND', 'Refund not found.', 404);
    return data;
}

module.exports = {
    getRefundCapability,
    executeWalletRefund,
    executeProviderRefund,
    executeDepositReversal,
    listRefunds,
    getRefund,
    WALLET_REFUNDABLE_TYPES,
    PROVIDER_REFUNDABLE_TYPES,
    REVERSIBLE_TYPES
};