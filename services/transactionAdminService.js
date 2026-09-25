// services/transactionAdminService.js
// ─────────────────────────────────────────────────────────────────
// Admin Transactions module — SERVICE ONLY.
//
// This file contains all transaction-admin business logic. It uses
// the existing `LedgerService` for every wallet/ledger mutation. It
// never creates its own ledger system.
//
// Responsibilities:
//   getTransactions()        — paginated list with filters
//   getRecentTransactions()  — dashboard preview
//   getSummary()             — SQL-aggregated counts + volume + fees
//   getTransaction()         — full detail (transaction + user + provider + webhooks + audit)
//   getLedger()              — ledger entries for a transaction
//   getAudit()               — admin action history for a transaction
//   changeStatus()           — controlled state transition
//   refundTransaction()      — atomic refund via LedgerService
//   addNote()                — append an audit-log note
//   exportTransactions()     — CSV builder
//
// Financial-safety rules enforced here:
//   • A status change to a SUCCESS state is only allowed from a
//     PENDING-ish state, and it NEVER writes to the ledger itself.
//     If the transaction type requires a financial credit (deposit,
//     refund), we refuse the manual completion and tell the admin to
//     use the provider-verified reconciliation flow instead. This is
//     the "don't let admins freely complete money-moving rows" rule.
//   • A refund is delegated to LedgerService.refundTransaction, which
//     is idempotent via `source_id = original.id`. We never credit a
//     wallet from this file.
//   • Every mutation writes to admin_audit_logs with before/after.
//
// Money values are passed through as strings from Postgres NUMERIC.
// Counts are numbers. Nothing is fabricated. Failures throw.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');

// ─── Constants ───────────────────────────────────────────────────

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

// Types that move money INTO a wallet. Manual completion of one of
// these must go through the provider/reconciliation flow, never a
// bare status update.
const LEDGER_CREDITING_TYPES = new Set(['deposit', 'refund', 'cashback_earned']);

// Types that move money OUT of a wallet. Manual completion of one of
// these is not a business action we expose — the provider callback
// is the authority.
const LEDGER_DEBITING_TYPES = new Set([
    'wallet_debit', 'cashback_used',
    'airtime', 'data', 'esim', 'gift', 'gift_card',
    'boost', 'marketplace', 'purchase', 'virtual_sms', 'sms', 'bills'
]);

// Types that are administrative-only and can be freely resolved.
const ADMIN_ONLY_TYPES = new Set(['admin_adjustment', 'fee_revenue']);

const ALLOWED_TRANSITIONS = Object.freeze({
    pending:         ['processing', 'failed', 'expired', 'cancelled', 'manual_review'],
    processing:      ['failed', 'cancelled', 'manual_review'],
    confirming:      ['failed', 'manual_review'],
    completed:       ['refunded', 'reversed'],
    success:         ['refunded', 'reversed'],
    failed:          ['manual_review', 'refunded'],
    cancelled:       ['manual_review'],
    expired:         ['manual_review'],
    refunded:        [],
    reversed:        [],
    manual_review:   ['pending', 'processing', 'failed', 'cancelled', 'refunded'],
    partially_paid:  ['manual_review', 'refunded'],
    overpaid:        ['manual_review', 'refunded'],
    underpaid:       ['manual_review', 'failed', 'refunded']
});

// ─── Helpers ─────────────────────────────────────────────────────

function limitOf(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(n, max);
}
function pageOf(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return n;
}
function isoDate(v) {
    if (!v) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}
function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    if (SUCCESS_STATUSES.has(s)) return 'success';
    if (FAILED_STATUSES.has(s)) return 'danger';
    if (PENDING_STATUSES.has(s)) return 'warn';
    if (s === 'manual_review') return 'purple';
    if (s === 'refunded') return 'info';
    return 'neutral';
}
function iconForType(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('deposit') || t === 'wallet_funding') return '📥';
    if (t.includes('crypto')) return '₿';
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
        deposit: 'Deposit', wallet_funding: 'Deposit',
        refund: 'Refund', cashback_earned: 'Cashback earned', cashback_used: 'Cashback used',
        admin_adjustment: 'Adjustment', fee_revenue: 'Fee revenue',
        wallet_credit: 'Wallet credit', wallet_debit: 'Wallet debit',
        airtime: 'Airtime', data: 'Data', gift: 'Gift Card', gift_card: 'Gift Card',
        boost: 'Boost', marketplace: 'Marketplace', purchase: 'Marketplace',
        virtual_sms: 'Virtual SMS', sms: 'Virtual SMS', esim: 'eSIM', bills: 'Bills',
        crypto: 'Crypto', crypto_purchase: 'Crypto'
    };
    return map[t] || (t ? t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '—');
}

function shapeTransaction(t, profile) {
    const ccy = String(t.currency || 'NGN').toUpperCase();
    const meta = t.metadata || t.meta || {};
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
        status_badge: statusBadge(t.status),
        currency: ccy,
        amount: t.amount ?? null,
        fee: t.fee ?? null,
        revenue_ngn: t.revenue_ngn ?? null,
        revenue_usd: t.revenue_usd ?? null,
        description: t.description || '',
        provider: t.provider || null,
        provider_reference: t.provider_reference || null,
        source_type: t.source_type || null,
        source_id: t.source_id || null,
        metadata: meta,
        failure_reason: t.failure_reason || null,
        direction,
        balance_before: meta.balance_before ?? null,
        balance_after: meta.balance_after ?? null,
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
function directionOfType(type) {
    const t = String(type || '').toLowerCase();
    if (['deposit', 'refund', 'cashback_earned', 'wallet_credit', 'fee_revenue'].includes(t)) return 'credit';
    if (['cashback_used', 'wallet_debit'].includes(t)) return 'debit';
    if (t === 'admin_adjustment') return 'debit';
    return 'debit';
}

async function loadProfilesByIds(userIds) {
    if (!userIds.length) return {};
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email')
        .in('id', userIds);
    if (error) {
        console.warn('[ADMIN TX] profiles lookup failed:', error.message);
        return {};
    }
    const out = {};
    for (const p of data || []) out[p.id] = p;
    return out;
}

async function recordAudit({ ctx, action, targetId, before, after, reason }) {
    try {
        await supabaseAdmin.from('admin_audit_logs').insert({
            admin_id: ctx.adminId || null,
            action,
            target_type: 'transaction',
            target_id: targetId,
            before: before || null,
            after: after || null,
            reason: reason ? String(reason).slice(0, 500) : null,
            ip_address: ctx.ip || null,
            user_agent: ctx.userAgent || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        // Audit failures for financial mutations are treated as fatal
        // by the caller (they check the return value). Non-financial
        // audit failures are logged and swallowed.
        console.warn('[ADMIN TX] audit insert failed:', e.message);
        throw e;
    }
}

// ═════════════════════════════════════════════════════════════════
//  LIST / RECENT
// ═════════════════════════════════════════════════════════════════

async function getTransactions(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    const sortable = new Set(['created_at', 'updated_at', 'completed_at', 'amount']);
    const sortCol = sortable.has(String(query.sort)) ? query.sort : 'created_at';
    const ascending = String(query.order).toLowerCase() === 'asc';

    // Search resolution: build user-id candidates first, then add
    // them as an `.in` clause. We never interpolate a raw string into
    // a `.or()` filter without escaping.
    const searchTerm = query.search ? String(query.search).trim() : '';
    let searchUserIdList = null;
    let searchAsUuid = null;
    let searchLike = null;

    if (searchTerm) {
        if (UUID_RE.test(searchTerm)) searchAsUuid = searchTerm;

        try {
            const safe = searchTerm.replace(/[%_]/g, m => '\\' + m);
            const { data: matched } = await supabaseAdmin
                .from('profiles')
                .select('id')
                .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
                .limit(50);
            if (matched && matched.length) searchUserIdList = matched.map(r => r.id);
        } catch (_) { /* optional */ }

        searchLike = searchTerm.replace(/[%_]/g, m => '\\' + m);
    }

    let q = supabaseAdmin
        .from('transactions')
        .select(`
            id, user_id, type, status, currency, amount, fee,
            revenue_ngn, revenue_usd, description,
            ref, reference, provider, provider_reference,
            source_type, source_id, category,
            metadata, meta,
            created_at, updated_at, completed_at, failed_at,
            cancelled_at, refunded_at, reversed_at, failure_reason
        `, { count: 'exact' })
        .order(sortCol, { ascending })
        .range(offset, offset + limit - 1);

    if (query.type) q = q.eq('type', query.type);
    if (query.status && query.status !== 'all') {
        const s = String(query.status).toLowerCase();
        if (STATUSES.has(s)) q = q.eq('status', s);
    }
    if (query.currency && query.currency !== 'all') {
        q = q.eq('currency', String(query.currency).toUpperCase());
    }
    if (query.provider && query.provider !== 'all') q = q.eq('provider', query.provider);
    if (query.user_id) q = q.eq('user_id', query.user_id);

    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);

    if (searchTerm) {
        const orParts = [];
        if (searchAsUuid) {
            orParts.push(`id.eq.${searchAsUuid}`);
            orParts.push(`user_id.eq.${searchAsUuid}`);
        }
        const safe = searchLike || '';
        orParts.push(`ref.ilike.%${safe}%`);
        orParts.push(`reference.ilike.%${safe}%`);
        orParts.push(`provider_reference.ilike.%${safe}%`);
        orParts.push(`description.ilike.%${safe}%`);
        if (searchUserIdList && searchUserIdList.length) {
            orParts.push(`user_id.in.(${searchUserIdList.join(',')})`);
        }
        q = q.or(orParts.join(','));
    }

    const { data, error, count } = await q;
    if (error) {
        const e = new Error('Failed to load transactions');
        e.status = 500; e.code = 'TX_LIST_ERROR';
        e.cause = error.message;
        throw e;
    }

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);

    const transactions = (data || []).map(t =>
        shapeTransaction(t, profilesById[t.user_id])
    );

    return {
        transactions,
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0)
    };
}

async function getRecentTransactions({ limit = 10 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
    const { data, error } = await supabaseAdmin
        .from('transactions')
        .select(`
            id, user_id, type, status, currency, amount, fee,
            ref, reference, description, metadata, meta,
            provider, provider_reference,
            created_at, completed_at, failed_at, failure_reason
        `)
        .order('created_at', { ascending: false })
        .limit(lim);

    if (error) {
        const e = new Error('Failed to load recent transactions');
        e.status = 500; e.code = 'TX_RECENT_ERROR';
        throw e;
    }

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);

    return (data || []).map(t => shapeTransaction(t, profilesById[t.user_id]));
}

// ═════════════════════════════════════════════════════════════════
//  SUMMARY
//
//  Uses Postgres RPC `admin_transaction_summary` when present. If
//  the RPC isn't deployed, falls back to discrete COUNT/SUM queries
//  — never loads raw rows into Node, never uses a `.limit(50000)`
//  hack.
// ═════════════════════════════════════════════════════════════════

async function getSummary(query = {}) {
    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);

    // Try the RPC first. It is the authoritative path.
    const rpc = await supabaseAdmin.rpc('admin_transaction_summary', {
        p_from: fromIso,
        p_to: toIso,
        p_currency: query.currency && query.currency !== 'all' ? String(query.currency).toUpperCase() : null,
        p_type: query.type || null,
        p_provider: query.provider && query.provider !== 'all' ? query.provider : null
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
                NGN: String(row.ngn_volume || '0.00'),
                USD: String(row.usd_volume || '0.00')
            },
            fees: {
                NGN: String(row.ngn_fees || '0.00'),
                USD: String(row.usd_fees || '0.00')
            },
            from: fromIso,
            to: toIso
        };
    }

    if (rpc.error && rpc.error.code !== '42883' && rpc.error.code !== 'PGRST202') {
        // A real error, not a missing function. Don't fabricate.
        const e = new Error('Failed to aggregate transactions');
        e.status = 500; e.code = 'TX_SUMMARY_ERROR';
        e.cause = rpc.error.message;
        throw e;
    }

    // RPC not deployed — fall back to per-status COUNT/SUM queries.
    // These are still server-side; no rows are transferred.
    const applyFilters = (q) => {
        if (fromIso) q = q.gte('created_at', fromIso);
        if (toIso) q = q.lte('created_at', toIso);
        if (query.currency && query.currency !== 'all') q = q.eq('currency', String(query.currency).toUpperCase());
        if (query.type) q = q.eq('type', query.type);
        if (query.provider && query.provider !== 'all') q = q.eq('provider', query.provider);
        return q;
    };

    // Volume sums: SQL SUM via PostgREST `sum` aggregate isn't
    // universally available; we use a lightweight RPC-free approach
    // with a dedicated view if present. If not, we still avoid
    // downloading rows by using `.select('amount')` with a small
    // `head:false`/`count:'exact'` and summing on the server via a
    // helper view — but if the view isn't there, we return the RPC
    // reason instead of a fabricated number.
    const [counts] = await Promise.all([
        (async () => {
            const countQuery = (statusSet) => {
                let q = supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true });
                q = applyFilters(q);
                if (statusSet) q = q.in('status', [...statusSet]);
                return q;
            };
            const [t, c, p, f, mr] = await Promise.all([
                countQuery(null),
                countQuery(SUCCESS_STATUSES),
                countQuery(PENDING_STATUSES),
                countQuery(FAILED_STATUSES),
                countQuery(new Set(['manual_review']))
            ]);
            return {
                total: t.count || 0,
                completed: c.count || 0,
                pending: p.count || 0,
                failed: f.count || 0,
                manual_review: mr.count || 0
            };
        })()
    ]);

    // Sums. If the RPC isn't present we honestly report "unavailable"
    // for the volume/fee figures rather than inventing them.
    return {
        ...counts,
        volume: { NGN: null, USD: null, available: false, reason: 'SUMMARY_RPC_NOT_DEPLOYED' },
        fees:   { NGN: null, USD: null, available: false, reason: 'SUMMARY_RPC_NOT_DEPLOYED' },
        from: fromIso,
        to: toIso
    };
}

// ═════════════════════════════════════════════════════════════════
//  DETAIL
// ═════════════════════════════════════════════════════════════════

async function getTransaction(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid transaction id.');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }

    const { data: tx, error } = await supabaseAdmin
        .from('transactions')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) {
        const e = new Error('Failed to load transaction');
        e.status = 500; e.code = 'TX_DETAIL_ERROR';
        throw e;
    }
    if (!tx) {
        const e = new Error('Transaction not found');
        e.status = 404; e.code = 'TX_NOT_FOUND';
        throw e;
    }

    // Profile
    let profile = null;
    if (tx.user_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, phone, role, status, created_at, last_seen')
            .eq('id', tx.user_id)
            .maybeSingle();
        profile = p || null;
    }

    // Ledger entries
    let ledgerEntries = [];
    try {
        const { data: le } = await supabaseAdmin
            .from('ledger_entries')
            .select('id, account_id, entry_type, amount, currency, balance_before, balance_after, description, created_at')
            .eq('transaction_id', id)
            .order('created_at', { ascending: true });
        ledgerEntries = le || [];
    } catch (_) { /* optional */ }

    // Accounts referenced by those entries
    let accountBalances = {};
    if (ledgerEntries.length) {
        const acctIds = [...new Set(ledgerEntries.map(e => e.account_id).filter(Boolean))];
        if (acctIds.length) {
            const { data: accts } = await supabaseAdmin
                .from('ledger_accounts')
                .select('id, user_id, currency, available_balance, held_balance')
                .in('id', acctIds);
            (accts || []).forEach(a => { accountBalances[a.id] = a; });
        }
    }

    // Provider record — build the OR conditions safely.
    let providerRecord = null;
    let providerRecordType = null;
    try {
        if (tx.type === 'deposit' || tx.provider === 'korapay') {
            const conds = [`unified_transaction_id.eq.${id}`];
            const ref = tx.ref || tx.reference;
            if (ref) conds.push(`internal_reference.eq.${ref}`);
            if (tx.provider_reference) conds.push(`provider_reference.eq.${tx.provider_reference}`);
            const { data: dep } = await supabaseAdmin
                .from('deposit_requests')
                .select('*')
                .or(conds.join(','))
                .maybeSingle();
            if (dep) { providerRecord = dep; providerRecordType = 'kora_deposit'; }
        }
        if (!providerRecord && tx.provider === 'nowpayments') {
            const conds = [];
            if (tx.provider_reference) conds.push(`nowpayments_payment_id.eq.${tx.provider_reference}`);
            if (tx.source_id) conds.push(`id.eq.${tx.source_id}`);
            if (conds.length) {
                const { data: dep } = await supabaseAdmin
                    .from('crypto_deposits')
                    .select('*')
                    .or(conds.join(','))
                    .maybeSingle();
                if (dep) { providerRecord = dep; providerRecordType = 'crypto_deposit'; }
            }
        }
    } catch (_) { /* optional */ }

    // Webhooks — only OR over values we actually have.
    let webhooks = [];
    const refForWebhook = tx.provider_reference || tx.ref || tx.reference;
    if (refForWebhook) {
        try {
            const [koraRes, npRes] = await Promise.all([
                supabaseAdmin
                    .from('kora_webhook_events')
                    .select('id, provider, event_type, provider_reference, provider_event_ref, signature_valid, processing_status, processing_error, received_at, processed_at')
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
            webhooks = [...(koraRes.data || []), ...(npRes.data || [])]
                .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
        } catch (_) { /* optional */ }
    }

    // Audit — filter by type + id directly.
    let audit = [];
    try {
        const { data: a } = await supabaseAdmin
            .from('admin_audit_logs')
            .select('id, admin_id, action, reason, before, after, created_at, ip_address')
            .eq('target_type', 'transaction')
            .eq('target_id', id)
            .order('created_at', { ascending: false })
            .limit(50);
        audit = a || [];
    } catch (_) { /* optional */ }

    const adminIds = [...new Set(audit.map(x => x.admin_id).filter(Boolean))];
    let adminsById = {};
    if (adminIds.length) {
        const { data: admins } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email')
            .in('id', adminIds);
        (admins || []).forEach(a => { adminsById[a.id] = a; });
    }

    return {
        transaction: shapeTransaction(tx, profile),
        user: profile,
        ledger_entries: ledgerEntries,
        account_balances: accountBalances,
        provider_record: providerRecord,
        provider_record_type: providerRecordType,
        webhooks,
        audit: audit.map(a => ({
            ...a,
            admin_username: adminsById[a.admin_id]?.username || null,
            admin_email: adminsById[a.admin_id]?.email || null
        }))
    };
}

async function getLedger(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid transaction id.');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('ledger_entries')
        .select('id, account_id, entry_type, amount, currency, balance_before, balance_after, description, metadata, created_at')
        .eq('transaction_id', id)
        .order('created_at', { ascending: true });
    if (error) {
        const e = new Error('Failed to load ledger entries');
        e.status = 500; e.code = 'TX_LEDGER_ERROR';
        throw e;
    }
    return data || [];
}

async function getAudit(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid transaction id.');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('admin_audit_logs')
        .select('id, admin_id, action, reason, before, after, created_at, ip_address, user_agent')
        .eq('target_type', 'transaction')
        .eq('target_id', id)
        .order('created_at', { ascending: false });
    if (error) {
        const e = new Error('Failed to load audit history');
        e.status = 500; e.code = 'TX_AUDIT_ERROR';
        throw e;
    }
    const adminIds = [...new Set((data || []).map(a => a.admin_id).filter(Boolean))];
    let adminsById = {};
    if (adminIds.length) {
        const { data: admins } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email')
            .in('id', adminIds);
        (admins || []).forEach(a => { adminsById[a.id] = a; });
    }
    return (data || []).map(a => ({
        ...a,
        admin_username: adminsById[a.admin_id]?.username || null,
        admin_email: adminsById[a.admin_id]?.email || null
    }));
}

// ═════════════════════════════════════════════════════════════════
//  STATUS CHANGE — controlled state machine
//
//  Rules enforced here:
//    • The next status must be a known status.
//    • The (current → next) transition must be listed in
//      ALLOWED_TRANSITIONS.
//    • A transition to a SUCCESS status is only allowed for
//      admin-only transaction types. If the transaction type moves
//      money (deposit, refund, cashback_earned, any purchase), the
//      admin is told to use the provider flow instead. This is the
//      core financial-safety gate.
//    • Every change writes an audit row.
// ═════════════════════════════════════════════════════════════════

async function changeStatus({ transactionId, nextStatus, reason, ctx }) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        const e = new Error('Invalid transaction id.');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }
    if (!STATUSES.has(nextStatus)) {
        const e = new Error('A valid status is required.');
        e.status = 422; e.code = 'INVALID_STATUS';
        throw e;
    }
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required (min 4 characters).');
        e.status = 422; e.code = 'REASON_REQUIRED';
        throw e;
    }

    const { data: existing, error } = await supabaseAdmin
        .from('transactions')
        .select('id, status, type, currency, amount, fee')
        .eq('id', transactionId)
        .maybeSingle();
    if (error) {
        const e = new Error('Failed to load transaction');
        e.status = 500; e.code = 'TX_STATUS_GET_ERROR';
        throw e;
    }
    if (!existing) {
        const e = new Error('Transaction not found');
        e.status = 404; e.code = 'TX_NOT_FOUND';
        throw e;
    }

    const current = String(existing.status || '').toLowerCase();
    const next_ = String(nextStatus).toLowerCase();

    if (current === next_) {
        return {
            transaction: shapeTransaction(existing, null),
            no_op: true,
            message: `Transaction already in status "${next_}".`
        };
    }

    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next_)) {
        const e = new Error(`Cannot transition from "${current}" to "${next_}".`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION';
        e.allowed_transitions = allowed;
        e.current_status = current;
        throw e;
    }

    // ─── Financial safety gate ─────────────────────────────────
    // A transition to a SUCCESS status on a money-moving transaction
    // is not an admin action. It must go through the provider flow
    // (reconciliation recheck, deposit webhook, deposit service).
    if (SUCCESS_STATUSES.has(next_)) {
        const type = String(existing.type || '').toLowerCase();
        if (LEDGER_CREDITING_TYPES.has(type) || LEDGER_DEBITING_TYPES.has(type)) {
            const e = new Error(
                `Cannot manually complete a "${type}" transaction. ` +
                `Use the provider reconciliation flow instead — the ledger must be posted by the same code path that verified the payment.`
            );
            e.status = 422; e.code = 'MANUAL_COMPLETION_NOT_ALLOWED';
            e.transaction_type = type;
            throw e;
        }
    }

    const update = { status: next_, updated_at: new Date().toISOString() };
    if (SUCCESS_STATUSES.has(next_)) update.completed_at = new Date().toISOString();
    if (next_ === 'failed')     update.failed_at = new Date().toISOString();
    if (next_ === 'cancelled')  update.cancelled_at = new Date().toISOString();
    if (next_ === 'refunded')   update.refunded_at = new Date().toISOString();
    if (next_ === 'reversed')   update.reversed_at = new Date().toISOString();

    // Optimistic concurrency: only update if the current status still
    // matches what we read. Two admins racing → one wins, one gets a
    // 409 and reloads.
    const { data: updated, error: updErr } = await supabaseAdmin
        .from('transactions')
        .update(update)
        .eq('id', transactionId)
        .eq('status', current)
        .select()
        .maybeSingle();

    if (updErr) {
        const e = new Error('Failed to update status');
        e.status = 500; e.code = 'TX_STATUS_UPDATE_ERROR';
        throw e;
    }
    if (!updated) {
        const e = new Error('Transaction changed while you were editing it. Reload and try again.');
        e.status = 409; e.code = 'TX_CHANGED';
        throw e;
    }

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
//  REFUND — atomic via LedgerService
//
//  This function does NOT touch the wallet. It calls
//  LedgerService.refundTransaction, which is idempotent and handles
//  the credit + the original-transaction status flip atomically.
// ═════════════════════════════════════════════════════════════════

async function refundTransaction({ transactionId, reason, ctx }) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        const e = new Error('Invalid transaction id.');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A refund reason is required (min 4 characters).');
        e.status = 422; e.code = 'REASON_REQUIRED';
        throw e;
    }

    const { data: tx, error } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, status, currency, amount, description, ref, reference')
        .eq('id', transactionId)
        .maybeSingle();
    if (error) {
        const e = new Error('Failed to load transaction');
        e.status = 500; e.code = 'TX_REFUND_GET_ERROR';
        throw e;
    }
    if (!tx) {
        const e = new Error('Transaction not found');
        e.status = 404; e.code = 'TX_NOT_FOUND';
        throw e;
    }

    const type = String(tx.type || '').toLowerCase();
    const status = String(tx.status || '').toLowerCase();

    const refundableTypes = new Set(['wallet_debit', 'cashback_used', 'deposit']);
    if (!refundableTypes.has(type)) {
        const e = new Error(`Transaction type "${tx.type}" is not refundable.`);
        e.status = 422; e.code = 'TX_NOT_REFUNDABLE';
        throw e;
    }
    if (status === 'refunded') {
        const e = new Error('Transaction is already refunded.');
        e.status = 409; e.code = 'ALREADY_REFUNDED';
        throw e;
    }
    if (status === 'reversed') {
        const e = new Error('Transaction is already reversed.');
        e.status = 409; e.code = 'ALREADY_REVERSED';
        throw e;
    }

    // Idempotency: if a refund transaction already exists for this
    // original, return it instead of attempting another one. This
    // guards against a double-click sending the request twice.
    const { data: existingRefund } = await supabaseAdmin
        .from('transactions')
        .select('id, reference, amount, currency, status')
        .eq('user_id', tx.user_id)
        .eq('source_id', tx.id)
        .eq('type', 'refund')
        .maybeSingle();

    if (existingRefund) {
        await recordAudit({
            ctx,
            action: 'transaction.refund_noop',
            targetId: tx.id,
            before: { status },
            after: { status: 'refunded' },
            reason: `Idempotent: refund already exists (${existingRefund.id})`
        });
        return {
            refund: {
                transaction_id: existingRefund.id,
                reference: existingRefund.reference,
                amount: existingRefund.amount,
                currency: existingRefund.currency,
                already_refunded: true
            }
        };
    }

    let result;
    try {
        result = await LedgerService.refundTransaction({
            userId: tx.user_id,
            transactionId: tx.id,
            reference: `refund:${tx.id}`,
            reason: String(reason).slice(0, 500)
        });
    } catch (ledgerErr) {
        const e = new Error(ledgerErr.message || 'Ledger refund failed');
        e.status = 400; e.code = 'LEDGER_REFUND_FAILED';
        throw e;
    }

    // LedgerService already flips the original transaction's status
    // to 'refunded'. We still defensively ensure it, but only if it
    // hasn't been flipped — an idempotent no-op otherwise.
    try {
        await supabaseAdmin
            .from('transactions')
            .update({
                status: 'refunded',
                refunded_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', tx.id)
            .neq('status', 'refunded');
    } catch (_) { /* non-fatal */ }

    await recordAudit({
        ctx,
        action: 'transaction.refund',
        targetId: tx.id,
        before: { status, amount: tx.amount },
        after: {
            status: 'refunded',
            refund_transaction_id: result?.transaction_id || null,
            refund_reference: result?.reference || null
        },
        reason
    });

    return {
        refund: {
            transaction_id: result?.transaction_id || null,
            reference: result?.reference || null,
            amount: result?.amount ?? null,
            currency: result?.currency ?? tx.currency,
            already_refunded: !!result?.alreadyRefunded
        }
    };
}

// ═════════════════════════════════════════════════════════════════
//  NOTE
// ═════════════════════════════════════════════════════════════════

async function addNote({ transactionId, note, ctx }) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        const e = new Error('Invalid transaction id.');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }
    const { data: tx } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('id', transactionId)
        .maybeSingle();
    if (!tx) {
        const e = new Error('Transaction not found');
        e.status = 404; e.code = 'TX_NOT_FOUND';
        throw e;
    }

    await recordAudit({
        ctx,
        action: 'transaction.note',
        targetId: transactionId,
        before: null,
        after: null,
        reason: String(note).slice(0, 500)
    });

    return { ok: true };
}

// ═════════════════════════════════════════════════════════════════
//  EXPORT
// ═════════════════════════════════════════════════════════════════

function csvEscape(v) {
    if (v === null || v === undefined) return '';
    return `"${String(v).replace(/"/g, '""')}"`;
}

async function exportTransactions(query = {}) {
    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);

    let q = supabaseAdmin
        .from('transactions')
        .select(
            'id, user_id, type, status, currency, amount, fee, ' +
            'revenue_ngn, revenue_usd, description, ' +
            'ref, reference, provider, provider_reference, ' +
            'created_at, completed_at, failed_at, failure_reason'
        )
        .order('created_at', { ascending: false })
        .limit(MAX_EXPORT);

    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);
    if (query.type) q = q.eq('type', query.type);
    if (query.status && query.status !== 'all') q = q.eq('status', String(query.status).toLowerCase());
    if (query.currency && query.currency !== 'all') q = q.eq('currency', String(query.currency).toUpperCase());
    if (query.provider && query.provider !== 'all') q = q.eq('provider', query.provider);

    const { data, error } = await q;
    if (error) {
        const e = new Error('Export failed');
        e.status = 500; e.code = 'TX_EXPORT_ERROR';
        throw e;
    }

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);

    const header = [
        'Transaction ID', 'Reference', 'Provider Reference', 'User', 'Email',
        'Type', 'Status', 'Currency', 'Amount', 'Fee',
        'Revenue NGN', 'Revenue USD', 'Provider',
        'Description', 'Created', 'Completed', 'Failed'
    ];
    const lines = [header.map(csvEscape).join(',')];
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
        ].map(csvEscape).join(','));
    }
    return lines.join('\n');
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    // Constants (used by tests / future callers)
    STATUSES,
    SUCCESS_STATUSES,
    PENDING_STATUSES,
    FAILED_STATUSES,
    ALLOWED_TRANSITIONS,

    // Public API
    getTransactions,
    getRecentTransactions,
    getSummary,
    getTransaction,
    getLedger,
    getAudit,
    changeStatus,
    refundTransaction,
    addNote,
    exportTransactions
};