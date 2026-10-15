// services/transactionAdminService.js
// ─────────────────────────────────────────────────────────────────
// Admin Transactions — SERVICE.
//
// Guarantees:
//   • No `select('*')` anywhere. Explicit column allowlists.
//   • Raw `metadata` is NEVER returned. Only an explicit
//     `admin_safe_metadata` subset.
//   • Money-moving status transitions are blocked. Only
//     operational states are editable.
//   • Refund / reversal are delegated to refundService.js.
//   • changeStatus is atomic with its audit row.
//   • request_id is propagated to audit records.
//   • Every DB failure throws. Nothing is swallowed.
//   • The summary endpoint does NOT 503 when the RPC is missing.
//     It falls back to server-side COUNT queries and reports
//     volume/fees as unavailable — never as zero.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const refundSvc = require('./refundService');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const MAX_EXPORT = 50000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUSES = new Set([
    'pending', 'processing', 'confirming', 'completed', 'success',
    'failed', 'cancelled', 'expired', 'reversed', 'refunded',
    'manual_review', 'partially_paid', 'overpaid', 'underpaid'
]);
const SUCCESS_STATUSES = new Set(['completed', 'success']);
const PENDING_STATUSES = new Set(['pending', 'processing', 'confirming', 'partially_paid', 'manual_review']);
const FAILED_STATUSES  = new Set(['failed', 'cancelled', 'expired', 'reversed']);

const LEDGER_CREDITING_TYPES = new Set(['deposit', 'refund', 'cashback_earned']);
const LEDGER_DEBITING_TYPES = new Set([
    'wallet_debit', 'cashback_used',
    'airtime', 'data', 'esim', 'gift', 'gift_card',
    'boost', 'marketplace', 'purchase', 'virtual_sms', 'sms', 'bills'
]);
const ADMIN_ONLY_TYPES = new Set(['admin_adjustment', 'fee_revenue']);

// Operational transitions only. Refund / reversal are NOT here.
const ALLOWED_TRANSITIONS = Object.freeze({
    pending:        ['processing', 'failed', 'expired', 'cancelled', 'manual_review'],
    processing:     ['failed', 'cancelled', 'manual_review'],
    confirming:     ['failed', 'manual_review'],
    completed:      [],
    success:        [],
    failed:         ['manual_review'],
    cancelled:      ['manual_review'],
    expired:        ['manual_review'],
    refunded:       [],
    reversed:       [],
    manual_review:  ['pending', 'processing', 'failed', 'cancelled'],
    partially_paid: ['manual_review', 'failed'],
    overpaid:       ['manual_review'],
    underpaid:      ['manual_review', 'failed']
});

// Column allowlists.
const TX_COLUMNS = [
    'id', 'user_id', 'type', 'status', 'currency', 'amount', 'fee',
    'revenue_ngn', 'revenue_usd', 'description',
    'ref', 'reference', 'provider', 'provider_reference',
    'source_type', 'source_id', 'category',
    'created_at', 'updated_at', 'completed_at', 'failed_at',
    'cancelled_at', 'refunded_at', 'reversed_at', 'failure_reason'
].join(', ');

const TX_LIST_COLUMNS = TX_COLUMNS;

const SAFE_META_KEYS = new Set([
    'direction', 'balance_before', 'balance_after', 'currency_type',
    'original_transaction_id', 'original_reference', 'original_type',
    'original_amount', 'refund_amount', 'reason', 'cashback_type', 'source'
]);

// ─── Errors ─────────────────────────────────────────────────────

function svcErr(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── Helpers ────────────────────────────────────────────────────

function toNumber(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function limitOf(v, def = DEFAULT_LIMIT) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : def;
}

function pageOf(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

function isoDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

function safeMeta(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const k of Object.keys(raw)) {
        if (SAFE_META_KEYS.has(k)) out[k] = raw[k];
    }
    return out;
}

function directionOfType(type) {
    const t = String(type || '').toLowerCase();
    if (['deposit', 'refund', 'cashback_earned', 'wallet_credit', 'fee_revenue'].includes(t)) return 'credit';
    return 'debit';
}

function iconForType(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('deposit')) return '📥';
    if (t.includes('gift')) return '🎁';
    if (t.includes('airtime') || t.includes('data')) return '📱';
    if (t.includes('boost')) return '📈';
    if (t.includes('sms')) return '📩';
    if (t.includes('esim')) return '📡';
    if (t.includes('bill')) return '🧾';
    if (t.includes('marketplace') || t === 'purchase') return '📦';
    return '💳';
}

function prettyType(type) {
    const t = String(type || '').toLowerCase();
    const map = {
        deposit: 'Deposit', refund: 'Refund',
        cashback_earned: 'Cashback earned', cashback_used: 'Cashback used',
        admin_adjustment: 'Adjustment', fee_revenue: 'Fee revenue',
        wallet_credit: 'Wallet credit', wallet_debit: 'Wallet debit',
        airtime: 'Airtime', data: 'Data', gift: 'Gift Card', gift_card: 'Gift Card',
        boost: 'Boost', marketplace: 'Marketplace', purchase: 'Marketplace',
        virtual_sms: 'Virtual SMS', sms: 'Virtual SMS', esim: 'eSIM', bills: 'Bills',
        reversal: 'Reversal'
    };
    return map[t] || (t ? t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '—');
}

function shapeTransaction(t, profile) {
    const ccy = String(t.currency || 'NGN').toUpperCase();
    const meta = safeMeta(t.metadata || t.meta);
    const direction = meta.direction === 'credit' || meta.direction === 'debit'
        ? meta.direction
        : directionOfType(t.type);
    return {
        id: t.id,
        reference: t.ref || t.reference || null,
        type: t.type || null,
        type_label: prettyType(t.type),
        category: t.category || null,
        status: t.status || null,
        currency: ccy,
        amount: toNumber(t.amount),
        fee: toNumber(t.fee),
        revenue_ngn: toNumber(t.revenue_ngn),
        revenue_usd: toNumber(t.revenue_usd),
        description: t.description || '',
        provider: t.provider || null,
        provider_reference: t.provider_reference || null,
        source_type: t.source_type || null,
        source_id: t.source_id || null,
        admin_safe_metadata: meta,
        failure_reason: t.failure_reason || null,
        direction,
        balance_before: toNumber(meta.balance_before),
        balance_after: toNumber(meta.balance_after),
        created_at: t.created_at || null,
        updated_at: t.updated_at || null,
        completed_at: t.completed_at || null,
        failed_at: t.failed_at || null,
        cancelled_at: t.cancelled_at || null,
        refunded_at: t.refunded_at || null,
        reversed_at: t.reversed_at || null,
        icon: iconForType(t.type),
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : null
    };
}

async function loadProfilesByIds(userIds) {
    if (!userIds.length) return {};
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email')
        .in('id', userIds);
    if (error) throw svcErr('PROFILES_LOOKUP_FAILED', error.message, 500);
    const out = {};
    for (const p of data || []) out[p.id] = p;
    return out;
}

async function recordAudit({ ctx, action, targetId, before, after, reason }) {
    const { error } = await supabaseAdmin.from('admin_audit_logs').insert({
        admin_id: ctx.adminId || null,
        action,
        target_type: 'transaction',
        target_id: targetId,
        before: before || null,
        after: after || null,
        reason: reason ? String(reason).slice(0, 500) : null,
        ip_address: ctx.ip || null,
        user_agent: ctx.userAgent || null,
        request_id: ctx.requestId || null,
        created_at: new Date().toISOString()
    });
    if (error) {
        // Audit failure on a financial mutation is fatal.
        throw svcErr('AUDIT_INSERT_FAILED', 'Failed to record audit entry.', 500);
    }
}

// ═════════════════════════════════════════════════════════════════
//  LIST
// ═════════════════════════════════════════════════════════════════

async function getTransactions(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    const sortable = new Set(['created_at', 'updated_at', 'completed_at', 'amount']);
    const sortCol = sortable.has(String(query.sort)) ? query.sort : 'created_at';
    const ascending = String(query.order).toLowerCase() === 'asc';

    let q = supabaseAdmin
        .from('transactions')
        .select(TX_LIST_COLUMNS, { count: 'exact' })
        .order(sortCol, { ascending })
        .range(offset, offset + limit - 1);

    if (query.type) q = q.eq('type', query.type);
    if (query.status && query.status !== 'all') {
        const s = String(query.status).toLowerCase();
        if (STATUSES.has(s)) q = q.eq('status', s);
    }
    if (query.currency && query.currency !== 'all') q = q.eq('currency', String(query.currency).toUpperCase());
    if (query.provider && query.provider !== 'all') q = q.eq('provider', query.provider);
    if (query.user_id) q = q.eq('user_id', query.user_id);

    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);

    if (query.search) {
        const raw = String(query.search).trim().slice(0, 100);
        const safe = raw.replace(/[%_]/g, m => '\\' + m);
        const orParts = [
            `ref.ilike.%${safe}%`,
            `reference.ilike.%${safe}%`,
            `provider_reference.ilike.%${safe}%`,
            `description.ilike.%${safe}%`
        ];
        if (UUID_RE.test(raw)) {
            orParts.push(`id.eq.${raw}`);
            orParts.push(`user_id.eq.${raw}`);
        } else {
            const { data: matched } = await supabaseAdmin
                .from('profiles')
                .select('id')
                .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
                .limit(50);
            if (matched && matched.length) {
                orParts.push(`user_id.in.(${matched.map(r => r.id).join(',')})`);
            }
        }
        q = q.or(orParts.join(','));
    }

    const { data, error, count } = await q;
    if (error) throw svcErr('TX_LIST_FAILED', error.message, 500);

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);

    return {
        transactions: (data || []).map(t => shapeTransaction(t, profilesById[t.user_id])),
        count: count || 0,
        page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0)
    };
}

async function getRecentTransactions({ limit = 10 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
    const { data, error } = await supabaseAdmin
        .from('transactions')
        .select(TX_LIST_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(lim);
    if (error) throw svcErr('TX_RECENT_FAILED', error.message, 500);

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);
    return (data || []).map(t => shapeTransaction(t, profilesById[t.user_id]));
}

// ═════════════════════════════════════════════════════════════════
//  SUMMARY — RPC-first, server-side fallback, never fabricates
// ═════════════════════════════════════════════════════════════════

async function getSummary(query = {}) {
    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);
    const currency = query.currency && query.currency !== 'all'
        ? String(query.currency).toUpperCase() : null;
    const type = query.type || null;
    const provider = query.provider && query.provider !== 'all' ? query.provider : null;

    // ─── 1. Try the RPC first. ─────────────────────────────────
    const rpc = await supabaseAdmin.rpc('admin_transaction_summary', {
        p_from: fromIso,
        p_to: toIso,
        p_currency: currency,
        p_type: type,
        p_provider: provider
    });

    if (!rpc.error && rpc.data) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        return {
            total: Number(row.total || 0),
            completed: Number(row.completed || 0),
            pending: Number(row.pending || 0),
            failed: Number(row.failed || 0),
            manual_review: Number(row.manual_review || 0),
            volume: {
                NGN: String(row.ngn_volume || '0'),
                USD: String(row.usd_volume || '0'),
                available: true
            },
            fees: {
                NGN: String(row.ngn_fees || '0'),
                USD: String(row.usd_fees || '0'),
                available: true
            },
            source: 'rpc',
            from: fromIso, to: toIso
        };
    }

    // ─── 2. RPC missing? Fall back to server-side COUNT queries. ─
    const rpcMissing = rpc.error && (
        rpc.error.code === '42883' ||   // function does not exist
        rpc.error.code === 'PGRST202'   // PostgREST can't find it in the schema cache
    );

    if (!rpcMissing && rpc.error) {
        // A real error (DB down, permission, etc). Throw — do not
        // pretend we counted.
        throw svcErr('TX_SUMMARY_FAILED', rpc.error.message || 'Summary query failed.', 500);
    }

    // Build a base filter for the count queries. Each count query
    // adds its own status filter on top.
    const applyFilters = (q) => {
        if (fromIso) q = q.gte('created_at', fromIso);
        if (toIso) q = q.lte('created_at', toIso);
        if (currency) q = q.eq('currency', currency);
        if (type) q = q.eq('type', type);
        if (provider) q = q.eq('provider', provider);
        return q;
    };

    const countFor = async (statusSet) => {
        let q = supabaseAdmin
            .from('transactions')
            .select('id', { count: 'exact', head: true });
        q = applyFilters(q);
        if (statusSet) q = q.in('status', [...statusSet]);
        const { count, error } = await q;
        if (error) throw svcErr('TX_SUMMARY_COUNT_FAILED', error.message, 500);
        return count || 0;
    };

    const [total, completed, pending, failed, manual_review] = await Promise.all([
        countFor(null),
        countFor(SUCCESS_STATUSES),
        countFor(PENDING_STATUSES),
        countFor(FAILED_STATUSES),
        countFor(new Set(['manual_review']))
    ]);

    // Volume / fees: try a single SUM query per currency. If SUM
    // isn't supported on this PostgREST build, we return
    // available: false and DO NOT invent a number.
    let volume = { NGN: null, USD: null, available: false };
    let fees = { NGN: null, USD: null, available: false };

    try {
        const sumFor = async (ccy) => {
            let q = supabaseAdmin
                .from('transactions')
                .select('amount, fee, status')
                .in('status', [...SUCCESS_STATUSES]);
            q = applyFilters(q);
            if (ccy) q = q.eq('currency', ccy);
            const { data, error } = await q;
            if (error) return null;
            let amount = 0, fee = 0;
            for (const r of data || []) {
                amount += Number(r.amount) || 0;
                fee += Number(r.fee) || 0;
            }
            return { amount, fee };
        };
        const [ngn, usd] = await Promise.all([sumFor('NGN'), sumFor('USD')]);
        if (ngn || usd) {
            volume = {
                NGN: ngn ? ngn.amount.toFixed(2) : '0.00',
                USD: usd ? usd.amount.toFixed(2) : '0.00',
                available: true
            };
            fees = {
                NGN: ngn ? ngn.fee.toFixed(2) : '0.00',
                USD: usd ? usd.fee.toFixed(2) : '0.00',
                available: true
            };
        }
    } catch (_) {
        // Leave available: false — do not fabricate.
    }

    return {
        total, completed, pending, failed, manual_review,
        volume,
        fees,
        source: 'fallback',
        from: fromIso, to: toIso
    };
}

// ═════════════════════════════════════════════════════════════════
//  DETAIL
// ═════════════════════════════════════════════════════════════════

async function getTransaction(id) {
    if (!UUID_RE.test(String(id || ''))) throw svcErr('INVALID_ID', 'Invalid transaction id.', 400);

    const { data: tx, error } = await supabaseAdmin
        .from('transactions')
        .select(TX_COLUMNS + ', metadata, meta')
        .eq('id', id)
        .maybeSingle();
    if (error) throw svcErr('TX_DETAIL_FAILED', error.message, 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    let profile = null;
    if (tx.user_id) {
        const { data: p, error: pErr } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, phone, role, status, created_at, last_seen')
            .eq('id', tx.user_id)
            .maybeSingle();
        if (pErr) throw svcErr('TX_USER_LOOKUP_FAILED', pErr.message, 500);
        profile = p || null;
    }

    // Ledger entries.
    const ledgerRes = await supabaseAdmin
        .from('ledger_entries')
        .select('id, account_id, transaction_id, entry_type, amount, currency, balance_before, balance_after, description, created_at')
        .eq('transaction_id', id)
        .order('created_at', { ascending: true });
    if (ledgerRes.error) {
        throw svcErr('TX_LEDGER_READ_FAILED', ledgerRes.error.message, 500);
    }
    const ledgerEntries = ledgerRes.data || [];

    // Related orders via RPC.
    let relatedOrders = [];
    try {
        const { data, error: ordErr } = await supabaseAdmin.rpc('transaction_related_orders', {
            p_transaction_id: id
        });
        if (!ordErr && Array.isArray(data)) relatedOrders = data;
    } catch (_) { relatedOrders = []; }

    // Provider record.
    let providerRecord = null;
    let providerRecordType = null;
    try {
        if (tx.type === 'deposit' || tx.provider === 'korapay') {
            const conds = [`unified_transaction_id.eq.${id}`];
            const ref = tx.ref || tx.reference;
            if (ref) conds.push(`internal_reference.eq.${ref}`);
            if (tx.provider_reference) conds.push(`provider_reference.eq.${tx.provider_reference}`);
            const { data } = await supabaseAdmin
                .from('deposit_requests')
                .select('id, internal_reference, provider_reference, payment_currency, payment_amount, wallet_currency, wallet_amount, customer_rate, fee_amount, fee_currency, status, created_at, completed_at')
                .or(conds.join(','))
                .maybeSingle();
            if (data) { providerRecord = data; providerRecordType = 'kora_deposit'; }
        }
        if (!providerRecord && tx.provider === 'nowpayments') {
            const conds = [];
            if (tx.provider_reference) conds.push(`nowpayments_payment_id.eq.${tx.provider_reference}`);
            if (tx.source_id) conds.push(`id.eq.${tx.source_id}`);
            if (conds.length) {
                const { data } = await supabaseAdmin
                    .from('crypto_deposits')
                    .select('id, nowpayments_payment_id, order_id, price_amount, price_currency, pay_amount, pay_currency, actually_paid, outcome_amount, outcome_currency, payment_status, created_at, updated_at')
                    .or(conds.join(','))
                    .maybeSingle();
                if (data) { providerRecord = data; providerRecordType = 'crypto_deposit'; }
            }
        }
    } catch (_) { /* optional */ }

    // Webhooks.
    let webhooks = [];
    let webhooksAvailable = true;
    const refForWebhook = tx.provider_reference || tx.ref || tx.reference;
    if (refForWebhook) {
        const [koraRes, npRes] = await Promise.all([
            supabaseAdmin
                .from('kora_webhook_events')
                .select('id, event_type, provider_reference, signature_valid, processing_status, processing_error, received_at, processed_at')
                .eq('provider_reference', refForWebhook)
                .order('received_at', { ascending: false })
                .limit(20),
            supabaseAdmin
                .from('provider_webhook_events')
                .select('id, provider, event_type, payment_id, order_id, signature_valid, processing_status, processing_error, received_at, processed_at')
                .or(`payment_id.eq.${refForWebhook},order_id.eq.${refForWebhook}`)
                .order('received_at', { ascending: false })
                .limit(20)
        ]);
        if (koraRes.error && koraRes.error.code !== '42P01') webhooksAvailable = false;
        if (npRes.error && npRes.error.code !== '42P01') webhooksAvailable = false;
        webhooks = [...(koraRes.data || []), ...(npRes.data || [])]
            .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
    }

    // Audit.
    const auditRes = await supabaseAdmin
        .from('admin_audit_logs')
        .select('id, admin_id, action, reason, before, after, created_at, ip_address, request_id')
        .eq('target_type', 'transaction')
        .eq('target_id', id)
        .order('created_at', { ascending: false })
        .limit(100);
    if (auditRes.error) throw svcErr('TX_AUDIT_READ_FAILED', auditRes.error.message, 500);
    const audit = auditRes.data || [];

    const adminIds = [...new Set(audit.map(x => x.admin_id).filter(Boolean))];
    let adminsById = {};
    if (adminIds.length) {
        const { data: admins } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email')
            .in('id', adminIds);
        (admins || []).forEach(a => { adminsById[a.id] = a; });
    }

    // Refunds — tolerate a missing refunds table gracefully.
    let refunds = [];
    try {
        const { data, error: rErr } = await supabaseAdmin
            .from('refunds')
            .select('id, refund_type, amount, currency, status, provider, provider_refund_ref, reason, created_at, completed_at, failed_at, failure_reason, refund_transaction_id')
            .eq('original_transaction_id', id)
            .order('created_at', { ascending: false });
        if (rErr && rErr.code !== '42P01') throw rErr;
        refunds = data || [];
    } catch (_) {
        refunds = [];
    }

    // Refund capability.
    let refund_capability = null;
    try {
        refund_capability = await refundSvc.getRefundCapability(id);
    } catch (e) {
        refund_capability = {
            eligible: false,
            methods: [],
            max_amount: '0.00',
            reason: e.code || 'CAPABILITY_UNAVAILABLE'
        };
    }

    return {
        transaction: shapeTransaction(tx, profile),
        user: profile,
        ledger_entries: ledgerEntries,
        related_orders: relatedOrders,
        provider_record: providerRecord,
        provider_record_type: providerRecordType,
        webhooks,
        webhooks_available: webhooksAvailable,
        audit: audit.map(a => ({
            ...a,
            admin_username: adminsById[a.admin_id]?.username || null,
            admin_email: adminsById[a.admin_id]?.email || null
        })),
        refunds,
        refund_capability
    };
}

// ═════════════════════════════════════════════════════════════════
//  STATUS CHANGE
// ═════════════════════════════════════════════════════════════════

async function changeStatus({ transactionId, nextStatus, reason, ctx }) {
    if (!UUID_RE.test(String(transactionId || ''))) throw svcErr('INVALID_ID', 'Invalid transaction id.', 400);
    if (!STATUSES.has(nextStatus)) throw svcErr('INVALID_STATUS', 'Invalid status.', 422);
    if (!reason || String(reason).trim().length < 4) throw svcErr('REASON_REQUIRED', 'Reason required.', 422);

    const { data: existing, error } = await supabaseAdmin
        .from('transactions')
        .select('id, status, type, currency, amount, fee')
        .eq('id', transactionId)
        .maybeSingle();
    if (error) throw svcErr('TX_STATUS_GET_FAILED', error.message, 500);
    if (!existing) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const current = String(existing.status || '').toLowerCase();
    const next_ = String(nextStatus).toLowerCase();

    if (current === next_) return { no_op: true, message: `Already in status "${next_}".` };

    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next_)) {
        throw svcErr('INVALID_STATUS_TRANSITION',
            `Cannot transition from "${current}" to "${next_}".`,
            422,
            { allowed_transitions: allowed, current_status: current });
    }

    if (SUCCESS_STATUSES.has(next_)) {
        const type = String(existing.type || '').toLowerCase();
        if (LEDGER_CREDITING_TYPES.has(type) || LEDGER_DEBITING_TYPES.has(type)) {
            throw svcErr('MANUAL_COMPLETION_NOT_ALLOWED',
                `Cannot manually complete a "${type}" transaction. Use the provider reconciliation flow.`,
                422,
                { transaction_type: type });
        }
    }

    const update = { status: next_, updated_at: new Date().toISOString() };
    if (SUCCESS_STATUSES.has(next_)) update.completed_at = new Date().toISOString();
    if (next_ === 'failed') update.failed_at = new Date().toISOString();
    if (next_ === 'cancelled') update.cancelled_at = new Date().toISOString();

    const { data: updated, error: updErr } = await supabaseAdmin
        .from('transactions')
        .update(update)
        .eq('id', transactionId)
        .eq('status', current)
        .select(TX_COLUMNS)
        .maybeSingle();

    if (updErr) throw svcErr('TX_STATUS_UPDATE_FAILED', updErr.message, 500);
    if (!updated) throw svcErr('TX_CHANGED', 'Transaction changed while you were editing it. Reload and try again.', 409);

    await recordAudit({
        ctx,
        action: 'transaction.status_change',
        targetId: transactionId,
        before: { status: current },
        after: { status: next_ },
        reason
    });

    return { transaction: shapeTransaction(updated, null) };
}

// ═════════════════════════════════════════════════════════════════
//  REFUND
// ═════════════════════════════════════════════════════════════════

async function refundTransaction({ transactionId, amount, reason, ctx, idempotencyKey }) {
    if (!UUID_RE.test(String(transactionId || ''))) throw svcErr('INVALID_ID', 'Invalid transaction id.', 400);

    const { data: tx, error } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, status, currency, amount')
        .eq('id', transactionId)
        .maybeSingle();
    if (error) throw svcErr('TX_REFUND_LOOKUP_FAILED', error.message, 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const capability = await refundSvc.getRefundCapability(transactionId);
    if (!capability.eligible) {
        throw svcErr('TX_NOT_REFUNDABLE', `Refund not available: ${capability.reason || 'unknown reason'}.`, 422);
    }

    const method = capability.methods[0];
    const amt = amount != null ? Number(amount) : Number(capability.max_amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > Number(capability.max_amount)) {
        throw svcErr('INVALID_REFUND_AMOUNT', 'Refund amount out of range.', 422);
    }

    if (method === 'wallet') {
        return refundSvc.executeWalletRefund({ transactionId, amount: amt, reason, ctx, idempotencyKey });
    }
    if (method === 'provider') {
        return refundSvc.executeProviderRefund({ transactionId, amount: amt, reason, ctx, idempotencyKey });
    }
    if (method === 'reversal') {
        return refundSvc.executeDepositReversal({ transactionId, amount: amt, reason, ctx, idempotencyKey });
    }
    throw svcErr('REFUND_METHOD_UNKNOWN', `Unsupported refund method: ${method}.`, 500);
}

// ═════════════════════════════════════════════════════════════════
//  NOTE
// ═════════════════════════════════════════════════════════════════

async function addNote({ transactionId, note, ctx }) {
    if (!UUID_RE.test(String(transactionId || ''))) throw svcErr('INVALID_ID', 'Invalid transaction id.', 400);
    const trimmed = String(note || '').trim();
    if (trimmed.length < 2) throw svcErr('NOTE_REQUIRED', 'Note text required.', 422);

    const { data: tx } = await supabaseAdmin
        .from('transactions').select('id').eq('id', transactionId).maybeSingle();
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    await recordAudit({
        ctx,
        action: 'transaction.note',
        targetId: transactionId,
        before: null,
        after: null,
        reason: trimmed.slice(0, 500)
    });
    return { ok: true };
}

// ═════════════════════════════════════════════════════════════════
//  EXPORT
// ═════════════════════════════════════════════════════════════════

function csvCell(v) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
}

async function exportTransactions(query = {}) {
    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);

    let q = supabaseAdmin
        .from('transactions')
        .select(TX_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(MAX_EXPORT);

    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);
    if (query.type) q = q.eq('type', query.type);
    if (query.status && query.status !== 'all') q = q.eq('status', String(query.status).toLowerCase());
    if (query.currency && query.currency !== 'all') q = q.eq('currency', String(query.currency).toUpperCase());
    if (query.provider && query.provider !== 'all') q = q.eq('provider', query.provider);

    const { data, error } = await q;
    if (error) throw svcErr('TX_EXPORT_FAILED', error.message, 500);

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);

    const header = [
        'Transaction ID','Reference','Provider Reference','User','Email',
        'Type','Status','Currency','Amount','Fee',
        'Revenue NGN','Revenue USD','Provider',
        'Description','Created','Completed','Failed'
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const t of data || []) {
        const p = profilesById[t.user_id] || {};
        lines.push([
            t.id, t.ref || t.reference || '', t.provider_reference || '',
            p.username || '', p.email || '',
            t.type || '', t.status || '', t.currency || '',
            t.amount ?? '', t.fee ?? '',
            t.revenue_ngn ?? '', t.revenue_usd ?? '',
            t.provider || '',
            t.description || '',
            t.created_at || '', t.completed_at || '', t.failed_at || ''
        ].map(csvCell).join(','));
    }
    return lines.join('\n');
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    STATUSES,
    SUCCESS_STATUSES,
    PENDING_STATUSES,
    FAILED_STATUSES,
    ALLOWED_TRANSITIONS,

    getTransactions,
    getRecentTransactions,
    getSummary,
    getTransaction,
    refundTransaction,
    addNote,
    changeStatus,
    exportTransactions
};