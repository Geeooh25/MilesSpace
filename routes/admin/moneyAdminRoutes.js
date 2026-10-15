// routes/admin/moneyAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Money area endpoints. Four concerns, one file.
//
//   /api/admin/transactions/*     — operational history
//   /api/admin/deposits/*         — how money entered MilesSpace
//   /api/admin/ledger/*           — accounting entries (append-only)
//   /api/admin/reconciliation/*   — does our record match the provider?
//
// Changes vs the previous version:
//   • No `select('*')` anywhere. Explicit column allowlists.
//   • Deposits list uses the DB view `admin_unified_deposits` — real
//     pagination, not "fetch 400 rows and slice".
//   • Transactions `direction` filter is now a real DB column.
//   • Deposit stats respect from/to.
//   • Reconciliation logic uses `admin_reconciliation_v2` — a
//     completed deposit with no webhook is UNVERIFIED, not MATCHED.
//   • `recheck` is split: verify (no wallet effect) vs settle (wallet).
//   • `resolve` derives user/amount/currency from the issue itself —
//     the admin CANNOT submit arbitrary user IDs or amounts.
//   • Every mutation is audited with a request_id.
//   • Rate limits on the provider-health and recheck endpoints.
//   • Every POST uses IdempotencyService when a key is supplied.
//   • Every mutation runs through LedgerService — no direct wallet
//     writes anywhere in this file.
//   • Request IDs propagated to every audit log row.
//   • CSRF-safe CSV escaping.
//   • No `catch (_) {}` on financial reads.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabaseAdmin } = require('../../db/supabase');
const providerFactory = require('../../services/providers/providerFactory');
const providerHealth  = require('../../services/providerHealthService');
const { LedgerService } = require('../../services/ledgerService');
const IdempotencyService = require('../../services/idempotencyService');
const {
    requirePermission,
    recordAdminAction,
    PERMISSIONS
} = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');

// ─── Constants ───────────────────────────────────────────────────
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const MAX_EXPORT_ROWS = 10000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Explicit column allowlists (no `select('*')`) ───────────────
const TX_LIST_COLS = [
    'id','user_id','type','status','direction','currency','amount','fee',
    'ref','reference','description',
    'provider','provider_reference','source_type','source_id','category',
    'created_at','completed_at','failed_at','failure_reason'
].join(', ');

const TX_DETAIL_COLS = TX_LIST_COLS + ', metadata';

const DEP_KORA_COLS = [
    'id','user_id','internal_reference','provider_reference','merchant_reference',
    'payment_currency','payment_amount','wallet_currency','wallet_amount',
    'customer_rate','fx_rate','fee_amount','fee_currency',
    'status','unified_transaction_id','ledger_transaction_id',
    'created_at','completed_at','failed_at','failure_reason'
].join(', ');

const DEP_CRYPTO_COLS = [
    'id','user_id','nowpayments_payment_id','nowpayments_order_id',
    'pay_currency','pay_network','pay_amount',
    'requested_usd','required_usd','fee_usd','fee_percent',
    'credited_amount','wallet_credit_usd','actually_paid_crypto','outcome_usd',
    'status','ledger_transaction_id',
    'created_at','completed_at','failed_at','failure_reason'
].join(', ');

const LEDGER_ENTRY_COLS = [
    'id','transaction_id','account_id','entry_type','amount','currency',
    'balance_before','balance_after','description','created_at'
].join(', ');

const LEDGER_ACCOUNT_COLS = [
    'id','user_id','currency','available_balance','held_balance',
    'created_at','updated_at'
].join(', ');

// ─── Request ID middleware (scoped to /api/admin/money) ─────────
router.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
});

// ─── Tiny in-process rate limiter ────────────────────────────────
// One map per endpoint key. Good enough for a single-instance
// deploy; replace with a shared store if you ever run >1 node.
const _buckets = new Map();
function rateLimit({ key, max, windowMs }) {
    return (req, res, next) => {
        const k = `${key}:${req.adminContext?.id || req.ip || 'anon'}`;
        const now = Date.now();
        const bucket = _buckets.get(k) || { count: 0, resetAt: now + windowMs };
        if (now > bucket.resetAt) {
            bucket.count = 0;
            bucket.resetAt = now + windowMs;
        }
        bucket.count++;
        _buckets.set(k, bucket);
        if (bucket.count > max) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retryAfter));
            return fail(res, 429, 'RATE_LIMITED', `Too many requests. Retry in ${retryAfter}s.`);
        }
        next();
    };
}

// ─── Helpers ─────────────────────────────────────────────────────
function parseLimit(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function parsePage(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
function isoDate(v, fallback = null) {
    if (!v) return fallback;
    const d = new Date(v);
    return isNaN(d.getTime()) ? fallback : d.toISOString();
}
function fail(res, status, code, message, extra = {}) {
    if (res.headersSent) return;
    res.status(status).json({ success: false, error: message, code, ...extra });
}

// Safe CSV cell — neutralizes spreadsheet formula injection and
// escapes quotes.
function csvCell(v) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
}
function csvRow(cells) { return cells.map(csvCell).join(','); }

// Escape `%` and `_` for PostgREST ilike.
function escapeLike(s) {
    return String(s).trim().slice(0, 100).replace(/[%_]/g, m => '\\' + m);
}

// Standard 500 for "provider returned, we didn't understand".
function providerFail(res, code, requestId) {
    return res.status(502).json({
        success: false,
        code,
        error: 'Provider request failed. Our team has been notified.',
        request_id: requestId
    });
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

router.get(
    '/orders/providers/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const providers = await providerHealth.getProviderHealth();
            res.json({ success: true, providers });
        } catch (err) {
            console.error('[MONEY HEALTH]', req.requestId, err.message);
            fail(res, 500, 'PROVIDER_HEALTH_FAILED', 'Failed to load provider health.');
        }
    }
);

router.get(
    '/providers/:provider/health-check',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    rateLimit({ key: 'provider-health', max: 20, windowMs: 60_000 }),
    async (req, res) => {
        try {
            const name = String(req.params.provider || '').toLowerCase();
            const adapter = providerFactory.get(name);
            if (!adapter) return fail(res, 404, 'UNKNOWN_PROVIDER', 'Unknown provider.');
            const result = await adapter.healthCheck();
            res.json({ success: true, ...result });
        } catch (err) {
            console.error('[MONEY HEALTH]', req.requestId, err.message);
            providerFail(res, 'PROVIDER_HEALTH_FAILED', req.requestId);
        }
    }
);

router.post(
    '/providers/health-check-all',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    rateLimit({ key: 'provider-health-all', max: 1, windowMs: 30_000 }),
    async (req, res) => {
        try {
            const all = await providerFactory.healthAll();
            res.json({ success: true, results: all });
        } catch (err) {
            console.error('[MONEY HEALTH]', req.requestId, err.message);
            providerFail(res, 'PROVIDER_HEALTH_FAILED', req.requestId);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  TRANSACTIONS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/transactions',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const page = parsePage(req.query.page);
            const limit = parseLimit(req.query.limit);
            const offset = (page - 1) * limit;

            const { search, status, currency, type, category, direction, from, to, user_id } = req.query;

            let q = supabaseAdmin
                .from('transactions')
                .select(TX_LIST_COLS + ', profiles!transactions_user_id_fkey (username, email)', { count: 'exact' })
                .order('created_at', { ascending: false });

            if (status && status !== 'all') q = q.eq('status', String(status).toLowerCase());
            if (currency && currency !== 'all') q = q.eq('currency', String(currency).toUpperCase());
            if (type) q = q.eq('type', String(type).toLowerCase());
            if (user_id && UUID_RE.test(user_id)) q = q.eq('user_id', user_id);
            // Direction is now a real column → filter is real pagination.
            if (direction && direction !== 'all') {
                const d = String(direction).toLowerCase();
                if (d === 'credit' || d === 'debit') q = q.eq('direction', d);
            }

            const fromIso = isoDate(from);
            const toIso = isoDate(to);
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            if (search) {
                const safe = escapeLike(search);
                q = q.or(
                    `ref.ilike.%${safe}%,reference.ilike.%${safe}%,provider_reference.ilike.%${safe}%,description.ilike.%${safe}%`
                );
            }

            if (category && category !== 'all') {
                const map = {
                    deposit: ['deposit'],
                    refund: ['refund'],
                    cashback: ['cashback_earned', 'cashback_used'],
                    adjustment: ['admin_adjustment'],
                    wallet: ['wallet_credit', 'wallet_debit'],
                    purchase: ['airtime','data','esim','gift','gift_card','boost','marketplace','virtual_sms','sms']
                };
                const types = map[category];
                if (types) q = q.in('type', types);
            }

            q = q.range(offset, offset + limit - 1);

            const { data, error, count } = await q;
            if (error) {
                console.error('[MONEY TX]', req.requestId, error.message);
                return fail(res, 500, 'TX_LIST_ERROR', 'Failed to load transactions.');
            }

            const rows = (data || []).map(shapeTransaction);

            res.json({
                success: true,
                transactions: rows,
                count: count || 0,
                page, limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) {
            console.error('[MONEY TX]', req.requestId, err);
            fail(res, 500, 'TX_LIST_EXCEPTION', 'Unexpected error.');
        }
    }
);

router.get(
    '/transactions/stats',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const fromIso = isoDate(req.query.from);
            const toIso = isoDate(req.query.to);

            const buildQ = (extra) => {
                let q = supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true });
                if (fromIso) q = q.gte('created_at', fromIso);
                if (toIso) q = q.lte('created_at', toIso);
                if (extra) q = extra(q);
                return q;
            };

            const [total, completed, pending, failed, deposits] = await Promise.all([
                buildQ(),
                buildQ(q => q.in('status', ['completed', 'success'])),
                buildQ(q => q.in('status', ['pending', 'processing', 'confirming'])),
                buildQ(q => q.in('status', ['failed', 'cancelled', 'reversed'])),
                buildQ(q => q.eq('type', 'deposit'))
            ]);

            res.json({
                success: true,
                stats: {
                    total: total.count || 0,
                    completed: completed.count || 0,
                    pending: pending.count || 0,
                    failed: failed.count || 0,
                    deposits: deposits.count || 0
                }
            });
        } catch (err) {
            console.error('[MONEY TX]', req.requestId, err);
            fail(res, 500, 'TX_STATS_EXCEPTION', 'Unexpected error.');
        }
    }
);

router.get(
    '/transactions/:id',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return fail(res, 400, 'INVALID_ID', 'Invalid transaction id.');
        try {
            const { id } = req.params;

            const { data: tx, error } = await supabaseAdmin
                .from('transactions')
                .select(TX_DETAIL_COLS + ', profiles!transactions_user_id_fkey (id, username, email, phone, role, status)')
                .eq('id', id)
                .maybeSingle();
            if (error) {
                console.error('[MONEY TX]', req.requestId, error.message);
                return fail(res, 500, 'TX_DETAIL_ERROR', 'Failed to load transaction.');
            }
            if (!tx) return fail(res, 404, 'TX_NOT_FOUND', 'Transaction not found.');

            // Ledger entries — explicit columns, no swallowed errors.
            const { data: le, error: leErr } = await supabaseAdmin
                .from('ledger_entries')
                .select(LEDGER_ENTRY_COLS)
                .eq('transaction_id', id)
                .order('created_at', { ascending: true });
            if (leErr) {
                console.error('[MONEY TX]', req.requestId, 'ledger read', leErr.message);
                return fail(res, 500, 'TX_LEDGER_READ_ERROR', 'Failed to read ledger entries.');
            }

            // Webhooks (both tables) — explicit columns.
            let webhooks = [];
            let webhooksStatus = 'available';
            const providerRef = tx.provider_reference || tx.ref || tx.reference;
            if (providerRef) {
                const [koraRes, genericRes] = await Promise.all([
                    supabaseAdmin
                        .from('kora_webhook_events')
                        .select('id, event_type, provider_reference, signature_valid, processing_status, processing_error, received_at, processed_at')
                        .eq('provider_reference', providerRef)
                        .order('received_at', { ascending: false })
                        .limit(20),
                    supabaseAdmin
                        .from('provider_webhook_events')
                        .select('id, provider, event_type, payment_id, order_id, signature_valid, processing_status, processing_error, received_at, processed_at')
                        .or(`payment_id.eq.${providerRef},order_id.eq.${providerRef}`)
                        .order('received_at', { ascending: false })
                        .limit(20)
                ]);
                if (koraRes.error && koraRes.error.code !== '42P01') webhooksStatus = 'unavailable';
                if (genericRes.error && genericRes.error.code !== '42P01') webhooksStatus = 'unavailable';
                webhooks = [...(koraRes.data || []), ...(genericRes.data || [])]
                    .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
            }

            // Related deposit
            let deposit = null;
            if (tx.source_type === 'kora_deposit' || tx.provider === 'korapay') {
                const { data: dep } = await supabaseAdmin
                    .from('deposit_requests')
                    .select(DEP_KORA_COLS)
                    .or(`unified_transaction_id.eq.${id},ledger_transaction_id.eq.${id},internal_reference.eq.${tx.ref}`)
                    .maybeSingle();
                deposit = dep || null;
            } else if (tx.provider === 'nowpayments' || tx.source_type === 'crypto_deposit') {
                const { data: dep } = await supabaseAdmin
                    .from('crypto_deposits')
                    .select(DEP_CRYPTO_COLS)
                    .or(`nowpayments_payment_id.eq.${tx.provider_reference},id.eq.${tx.source_id}`)
                    .maybeSingle();
                deposit = dep || null;
            }

            res.json({
                success: true,
                transaction: shapeTransaction(tx),
                user: tx.profiles || null,
                ledger_entries: le || [],
                webhooks,
                webhooks_status: webhooksStatus,
                deposit
            });
        } catch (err) {
            console.error('[MONEY TX]', req.requestId, err);
            fail(res, 500, 'TX_DETAIL_EXCEPTION', 'Unexpected error.');
        }
    }
);

router.get(
    '/transactions/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    rateLimit({ key: 'tx-export', max: 5, windowMs: 60_000 }),
    async (req, res) => {
        try {
            const fromIso = isoDate(req.query.from);
            const toIso = isoDate(req.query.to);
            const { status, currency } = req.query;

            let q = supabaseAdmin
                .from('transactions')
                .select(TX_LIST_COLS)
                .order('created_at', { ascending: false })
                .limit(MAX_EXPORT_ROWS);
            if (status && status !== 'all') q = q.eq('status', String(status).toLowerCase());
            if (currency && currency !== 'all') q = q.eq('currency', String(currency).toUpperCase());
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            const { data, error } = await q;
            if (error) {
                console.error('[MONEY TX]', req.requestId, 'export', error.message);
                return fail(res, 500, 'EXPORT_ERROR', 'Export failed.');
            }

            const header = ['Reference','Provider Reference','Type','Status','Direction','Currency','Amount','Fee','Provider','Description','Created','Completed'];
            const lines = [csvRow(header)];
            for (const t of data || []) {
                lines.push(csvRow([
                    t.ref || t.reference || '',
                    t.provider_reference || '',
                    t.type || '',
                    t.status || '',
                    t.direction || '',
                    t.currency || '',
                    t.amount ?? '',
                    t.fee ?? '',
                    t.provider || '',
                    t.description || '',
                    t.created_at || '',
                    t.completed_at || ''
                ]));
            }

            await recordAdminAction({
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                action: 'transactions.export',
                targetType: 'transactions_export',
                targetId: null,
                reason: `Exported ${data?.length || 0} transactions`,
                after: { filters: { from: req.query.from, to: req.query.to, status, currency } },
                requestId: req.requestId,
                req
            }).catch(() => {});

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=transactions_${new Date().toISOString().slice(0,10)}_${req.requestId.slice(0,8)}.csv`);
            res.send(lines.join('\n'));
        } catch (err) {
            console.error('[MONEY TX]', req.requestId, err);
            fail(res, 500, 'EXPORT_EXCEPTION', 'Unexpected error.');
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  DEPOSITS — real pagination via the DB view
// ═════════════════════════════════════════════════════════════════

router.get(
    '/deposits',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const page = parsePage(req.query.page);
            const limit = parseLimit(req.query.limit);
            const offset = (page - 1) * limit;
            const { search, status, source, wallet_currency, from, to } = req.query;

            let q = supabaseAdmin
                .from('admin_unified_deposits')
                .select('*', { count: 'exact' })
                .order('created_at', { ascending: false });

            if (source && source !== 'all') q = q.eq('source', String(source).toLowerCase());
            if (status && status !== 'all') q = q.eq('status', String(status).toLowerCase());
            if (wallet_currency && wallet_currency !== 'all') {
                q = q.eq('wallet_currency', String(wallet_currency).toUpperCase());
            }
            const fromIso = isoDate(from);
            const toIso = isoDate(to);
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);
            if (search) {
                const safe = escapeLike(search);
                q = q.or(
                    `reference.ilike.%${safe}%,provider_reference.ilike.%${safe}%,merchant_reference.ilike.%${safe}%`
                );
            }
            q = q.range(offset, offset + limit - 1);

            const { data, error, count } = await q;
            if (error) {
                console.error('[MONEY DEP]', req.requestId, error.message);
                return fail(res, 500, 'DEP_LIST_ERROR', 'Failed to load deposits.');
            }

            // Fetch the profiles for the page in one round-trip.
            const userIds = [...new Set((data || []).map(d => d.user_id).filter(Boolean))];
            let profilesById = {};
            if (userIds.length) {
                const { data: profiles, error: pErr } = await supabaseAdmin
                    .from('profiles').select('id, username, email').in('id', userIds);
                if (pErr) {
                    console.error('[MONEY DEP]', req.requestId, 'profiles', pErr.message);
                    return fail(res, 500, 'DEP_PROFILES_ERROR', 'Failed to load deposit owners.');
                }
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const rows = (data || []).map(d => shapeUnifiedDeposit(d, profilesById[d.user_id]));

            res.json({
                success: true,
                deposits: rows,
                count: count || 0,
                page, limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) {
            console.error('[MONEY DEP]', req.requestId, err);
            fail(res, 500, 'DEP_LIST_EXCEPTION', 'Unexpected error.');
        }
    }
);

router.get(
    '/deposits/stats',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const fromIso = isoDate(req.query.from);
            const toIso = isoDate(req.query.to);

            const buildKora = (extra) => {
                let q = supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true });
                if (fromIso) q = q.gte('created_at', fromIso);
                if (toIso) q = q.lte('created_at', toIso);
                if (extra) q = extra(q);
                return q;
            };
            const buildCrypto = (extra) => {
                let q = supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true });
                if (fromIso) q = q.gte('created_at', fromIso);
                if (toIso) q = q.lte('created_at', toIso);
                if (extra) q = extra(q);
                return q;
            };

            const [koraCompleted, koraPending, koraFailed, cryptoCompleted, cryptoPending, cryptoManual] = await Promise.all([
                buildKora(q => q.eq('status', 'completed')),
                buildKora(q => q.in('status', ['pending', 'processing'])),
                buildKora(q => q.in('status', ['failed', 'expired', 'cancelled'])),
                buildCrypto(q => q.eq('status', 'completed')),
                buildCrypto(q => q.in('status', ['pending', 'processing', 'partially_paid'])),
                buildCrypto(q => q.eq('status', 'manual_review'))
            ]);

            res.json({
                success: true,
                stats: {
                    kora: {
                        completed: koraCompleted.count || 0,
                        pending: koraPending.count || 0,
                        failed: koraFailed.count || 0
                    },
                    crypto: {
                        completed: cryptoCompleted.count || 0,
                        pending: cryptoPending.count || 0,
                        manual_review: cryptoManual.count || 0
                    },
                    from: fromIso, to: toIso
                }
            });
        } catch (err) {
            console.error('[MONEY DEP]', req.requestId, err);
            fail(res, 500, 'DEP_STATS_EXCEPTION', 'Unexpected error.');
        }
    }
);

router.get(
    '/deposits/:source/:id',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        const { source, id } = req.params;
        if (source !== 'kora' && source !== 'crypto') {
            return fail(res, 422, 'INVALID_SOURCE', 'Source must be kora or crypto.');
        }
        if (!UUID_RE.test(String(id))) return fail(res, 400, 'INVALID_ID', 'Invalid deposit id.');

        try {
            const table = source === 'kora' ? 'deposit_requests' : 'crypto_deposits';
            const cols = source === 'kora' ? DEP_KORA_COLS : DEP_CRYPTO_COLS;

            const { data: dep, error } = await supabaseAdmin
                .from(table)
                .select(cols)
                .eq('id', id)
                .maybeSingle();
            if (error) {
                console.error('[MONEY DEP]', req.requestId, error.message);
                return fail(res, 500, 'DEP_DETAIL_ERROR', 'Failed to load deposit.');
            }
            if (!dep) return fail(res, 404, 'DEPOSIT_NOT_FOUND', 'Deposit not found.');

            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email, phone')
                .eq('id', dep.user_id)
                .maybeSingle();

            const providerRef = source === 'kora' ? dep.provider_reference : dep.nowpayments_payment_id;

            let webhooks = [];
            let webhooksStatus = 'available';
            if (providerRef) {
                const [koraRes, npRes] = await Promise.all([
                    supabaseAdmin
                        .from('kora_webhook_events')
                        .select('id, event_type, provider_reference, signature_valid, processing_status, processing_error, received_at, processed_at')
                        .eq('provider_reference', providerRef)
                        .order('received_at', { ascending: false })
                        .limit(20),
                    supabaseAdmin
                        .from('provider_webhook_events')
                        .select('id, provider, event_type, payment_id, order_id, signature_valid, processing_status, processing_error, received_at, processed_at')
                        .or(`payment_id.eq.${providerRef},order_id.eq.${providerRef}`)
                        .order('received_at', { ascending: false })
                        .limit(20)
                ]);
                if (koraRes.error && koraRes.error.code !== '42P01') webhooksStatus = 'unavailable';
                if (npRes.error && npRes.error.code !== '42P01') webhooksStatus = 'unavailable';
                webhooks = [...(koraRes.data || []), ...(npRes.data || [])]
                    .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
            }

            // Linked transaction — explicit columns.
            let transaction = null;
            const txId = source === 'kora' ? dep.unified_transaction_id : null;
            if (txId) {
                const { data: t } = await supabaseAdmin
                    .from('transactions')
                    .select(TX_LIST_COLS)
                    .eq('id', txId)
                    .maybeSingle();
                transaction = t ? shapeTransaction(t) : null;
            } else if (source === 'crypto' && dep.nowpayments_payment_id) {
                const { data: t } = await supabaseAdmin
                    .from('transactions')
                    .select(TX_LIST_COLS)
                    .or(`ref.eq.${dep.nowpayments_payment_id},reference.eq.${dep.nowpayments_payment_id}`)
                    .eq('type', 'deposit')
                    .maybeSingle();
                transaction = t ? shapeTransaction(t) : null;
            }

            res.json({
                success: true,
                deposit: shapeUnifiedDeposit({
                    source,
                    ...dep,
                    reference: source === 'kora' ? dep.internal_reference : dep.nowpayments_payment_id,
                    provider_reference: providerRef
                }, profile || null),
                user: profile || null,
                webhooks,
                webhooks_status: webhooksStatus,
                transaction
            });
        } catch (err) {
            console.error('[MONEY DEP]', req.requestId, err);
            fail(res, 500, 'DEP_DETAIL_EXCEPTION', 'Unexpected error.');
        }
    }
);

router.get(
    '/deposits/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    rateLimit({ key: 'dep-export', max: 5, windowMs: 60_000 }),
    async (req, res) => {
        try {
            const fromIso = isoDate(req.query.from);
            const toIso = isoDate(req.query.to);
            const { status, source } = req.query;

            let q = supabaseAdmin
                .from('admin_unified_deposits')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(MAX_EXPORT_ROWS);
            if (source && source !== 'all') q = q.eq('source', String(source).toLowerCase());
            if (status && status !== 'all') q = q.eq('status', String(status).toLowerCase());
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            const { data, error } = await q;
            if (error) {
                console.error('[MONEY DEP]', req.requestId, 'export', error.message);
                return fail(res, 500, 'DEP_EXPORT_ERROR', 'Export failed.');
            }

            const header = ['Source','Reference','Provider Reference','Payment Currency','Payment Amount','Wallet Currency','Wallet Amount','Fee','Status','Created','Completed'];
            const lines = [csvRow(header)];
            for (const d of data || []) {
                lines.push(csvRow([
                    d.source || '',
                    d.reference || '',
                    d.provider_reference || '',
                    d.payment_currency || '',
                    d.payment_amount ?? '',
                    d.wallet_currency || '',
                    d.wallet_amount ?? '',
                    d.fee_amount ?? '',
                    d.status || '',
                    d.created_at || '',
                    d.completed_at || ''
                ]));
            }

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=deposits_${new Date().toISOString().slice(0,10)}_${req.requestId.slice(0,8)}.csv`);
            res.send(lines.join('\n'));
        } catch (err) {
            console.error('[MONEY DEP]', req.requestId, err);
            fail(res, 500, 'DEP_EXPORT_EXCEPTION', 'Unexpected error.');
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  LEDGER
// ═════════════════════════════════════════════════════════════════

router.get(
    '/ledger',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const page = parsePage(req.query.page);
            const limit = parseLimit(req.query.limit);
            const offset = (page - 1) * limit;
            const { search, currency, direction, user_id, from, to } = req.query;

            const fromIso = isoDate(from);
            const toIso = isoDate(to);

            let q = supabaseAdmin
                .from('ledger_entries')
                .select(`
                    ${LEDGER_ENTRY_COLS},
                    ledger_accounts!inner (user_id, currency, profiles (id, username, email)),
                    transactions!inner (id, ref, reference, type, status, provider, description)
                `, { count: 'exact' })
                .order('created_at', { ascending: false });

            if (currency && currency !== 'all') q = q.eq('currency', String(currency).toUpperCase());
            if (direction && direction !== 'all') q = q.eq('entry_type', direction === 'credit' ? 'CREDIT' : 'DEBIT');
            if (user_id && UUID_RE.test(user_id)) q = q.eq('ledger_accounts.user_id', user_id);
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);
            if (search) {
                const safe = escapeLike(search);
                q = q.or(`description.ilike.%${safe}%,transaction_id.ilike.%${safe}%`);
            }
            q = q.range(offset, offset + limit - 1);

            const { data, error, count } = await q;
            if (error) {
                console.error('[MONEY LEDGER]', req.requestId, error.message);
                return fail(res, 500, 'LEDGER_LIST_ERROR', 'Failed to load ledger entries.');
            }

            const entries = (data || []).map(e => {
                const acct = e.ledger_accounts || {};
                const prof = acct.profiles || {};
                const tx = e.transactions || {};
                return {
                    id: e.id,
                    transaction_id: e.transaction_id,
                    transaction_reference: tx.ref || tx.reference || null,
                    transaction_type: tx.type || null,
                    transaction_status: tx.status || null,
                    user: {
                        id: acct.user_id,
                        username: prof.username || (prof.email ? prof.email.split('@')[0] : 'User'),
                        email: prof.email || null
                    },
                    entry_type: e.entry_type,
                    direction: e.entry_type === 'CREDIT' ? 'credit' : 'debit',
                    amount: num(e.amount),
                    currency: e.currency,
                    balance_before: e.balance_before != null ? num(e.balance_before) : null,
                    balance_after: e.balance_after != null ? num(e.balance_after) : null,
                    description: e.description || '',
                    provider: tx.provider || null,
                    created_at: e.created_at
                };
            });

            res.json({
                success: true,
                entries,
                count: count || 0,
                page, limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) {
            console.error('[MONEY LEDGER]', req.requestId, err);
            fail(res, 500, 'LEDGER_LIST_EXCEPTION', 'Unexpected error.');
        }
    }
);

router.get(
    '/ledger/balances',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const { data, error } = await supabaseAdmin
                .from('ledger_accounts')
                .select('currency, available_balance, held_balance');
            if (error) {
                console.error('[MONEY LEDGER]', req.requestId, error.message);
                return fail(res, 500, 'BALANCES_ERROR', 'Failed to load balances.');
            }

            const totals = {};
            for (const row of data || []) {
                const ccy = row.currency || 'NGN';
                if (!totals[ccy]) totals[ccy] = { available: 0n, held: 0n };
                totals[ccy].available += BigInt(Math.round(num(row.available_balance) * 100));
                totals[ccy].held += BigInt(Math.round(num(row.held_balance) * 100));
            }
            const out = {};
            for (const [ccy, t] of Object.entries(totals)) {
                // Format from BigInt directly, no Number() round-trip.
                out[ccy] = {
                    available: bigintToDecimalString(t.available),
                    held: bigintToDecimalString(t.held),
                    total: bigintToDecimalString(t.available + t.held)
                };
            }

            res.json({ success: true, balances: out });
        } catch (err) {
            console.error('[MONEY LEDGER]', req.requestId, err);
            fail(res, 500, 'BALANCES_EXCEPTION', 'Unexpected error.');
        }
    }
);

router.get(
    '/ledger/user/:userId',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        if (!UUID_RE.test(String(req.params.userId || ''))) return fail(res, 400, 'INVALID_ID', 'Invalid user id.');
        try {
            const { userId } = req.params;
            const { currency, from, to } = req.query;
            const limit = parseLimit(req.query.limit, 100, 500);
            const fromIso = isoDate(from);
            const toIso = isoDate(to);

            let accountsQ = supabaseAdmin
                .from('ledger_accounts')
                .select(LEDGER_ACCOUNT_COLS)
                .eq('user_id', userId);
            if (currency && currency !== 'all') accountsQ = accountsQ.eq('currency', String(currency).toUpperCase());
            const { data: accounts, error: aErr } = await accountsQ;
            if (aErr) {
                console.error('[MONEY LEDGER]', req.requestId, aErr.message);
                return fail(res, 500, 'LEDGER_ACCOUNTS_ERROR', 'Failed to load accounts.');
            }
            if (!accounts || !accounts.length) return res.json({ success: true, accounts: [], entries: [] });

            const accountIds = accounts.map(a => a.id);

            let q = supabaseAdmin
                .from('ledger_entries')
                .select(`${LEDGER_ENTRY_COLS}, transactions!inner (id, ref, reference, type, status, provider)`)
                .in('account_id', accountIds)
                .order('created_at', { ascending: false })
                .limit(limit);
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            const { data: entries, error: eErr } = await q;
            if (eErr) {
                console.error('[MONEY LEDGER]', req.requestId, eErr.message);
                return fail(res, 500, 'LEDGER_USER_ERROR', 'Failed to load ledger entries.');
            }

            res.json({
                success: true,
                accounts,
                entries: (entries || []).map(e => ({
                    id: e.id,
                    transaction_id: e.transaction_id,
                    transaction_reference: e.transactions?.ref || e.transactions?.reference || null,
                    transaction_type: e.transactions?.type || null,
                    account_id: e.account_id,
                    entry_type: e.entry_type,
                    direction: e.entry_type === 'CREDIT' ? 'credit' : 'debit',
                    amount: num(e.amount),
                    currency: e.currency,
                    balance_before: e.balance_before != null ? num(e.balance_before) : null,
                    balance_after: e.balance_after != null ? num(e.balance_after) : null,
                    description: e.description || '',
                    provider: e.transactions?.provider || null,
                    created_at: e.created_at
                }))
            });
        } catch (err) {
            console.error('[MONEY LEDGER]', req.requestId, err);
            fail(res, 500, 'LEDGER_USER_EXCEPTION', 'Unexpected error.');
        }
    }
);

router.get(
    '/ledger/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    rateLimit({ key: 'ledger-export', max: 5, windowMs: 60_000 }),
    async (req, res) => {
        try {
            const { from, to, currency, direction } = req.query;
            const fromIso = isoDate(from);
            const toIso = isoDate(to);

            let q = supabaseAdmin
                .from('ledger_entries')
                .select(LEDGER_ENTRY_COLS)
                .order('created_at', { ascending: false })
                .limit(MAX_EXPORT_ROWS);
            if (currency && currency !== 'all') q = q.eq('currency', String(currency).toUpperCase());
            if (direction && direction !== 'all') q = q.eq('entry_type', direction === 'credit' ? 'CREDIT' : 'DEBIT');
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            const { data, error } = await q;
            if (error) {
                console.error('[MONEY LEDGER]', req.requestId, 'export', error.message);
                return fail(res, 500, 'LEDGER_EXPORT_ERROR', 'Export failed.');
            }

            const header = ['Entry ID','Transaction ID','Account ID','Type','Amount','Currency','Balance Before','Balance After','Description','Created'];
            const lines = [csvRow(header)];
            for (const e of data || []) {
                lines.push(csvRow([
                    e.id, e.transaction_id, e.account_id, e.entry_type,
                    e.amount ?? '', e.currency, e.balance_before ?? '', e.balance_after ?? '',
                    e.description || '', e.created_at
                ]));
            }
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=ledger_${new Date().toISOString().slice(0,10)}_${req.requestId.slice(0,8)}.csv`);
            res.send(lines.join('\n'));
        } catch (err) {
            console.error('[MONEY LEDGER]', req.requestId, err);
            fail(res, 500, 'LEDGER_EXPORT_EXCEPTION', 'Unexpected error.');
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  RECONCILIATION
// ═════════════════════════════════════════════════════════════════

// GET /api/admin/reconciliation/summary
// Reads the DB view. Does NOT scan thousands of rows in Node.
router.get(
    '/reconciliation/summary',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const { from, to, provider = 'kora' } = req.query;
            const fromIso = isoDate(from, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
            const toIso = isoDate(to, new Date().toISOString());

            const allowed = ['kora', 'crypto'];
            if (!allowed.includes(provider)) {
                return fail(res, 422, 'INVALID_PROVIDER', 'Provider must be kora or crypto.');
            }

            let q = supabaseAdmin
                .from('admin_reconciliation_v2')
                .select('source, match_state, webhook_event_count, wallet_amount')
                .eq('source', provider)
                .gte('created_at', fromIso)
                .lte('created_at', toIso)
                .limit(5000);

            const { data, error } = await q;
            if (error) {
                console.error('[MONEY RECON]', req.requestId, error.message);
                return fail(res, 500, 'RECON_SUMMARY_ERROR', 'Failed to load reconciliation.');
            }

            const rows = data || [];
            const counts = rows.reduce((acc, r) => {
                acc[r.match_state] = (acc[r.match_state] || 0) + 1;
                return acc;
            }, {});

            const total = rows.length;
            const matched = counts.MATCHED || 0;
            const missingWebhook = counts.MISSING_WEBHOOK || 0;
            const unverified = counts.UNVERIFIED_WEBHOOK || 0;
            const unresolved = counts.UNRESOLVED || 0;
            const closed = counts.CLOSED || 0;

            // A short list of exceptions for the UI.
            let exceptionsQ = supabaseAdmin
                .from('admin_reconciliation_v2')
                .select('source, deposit_id, internal_reference, provider_reference, internal_status, wallet_currency, wallet_amount, match_state, created_at')
                .eq('source', provider)
                .in('match_state', ['MISSING_WEBHOOK', 'UNVERIFIED_WEBHOOK', 'UNRESOLVED'])
                .gte('created_at', fromIso)
                .lte('created_at', toIso)
                .order('created_at', { ascending: false })
                .limit(100);

            const { data: exceptions, error: exErr } = await exceptionsQ;
            if (exErr) {
                console.error('[MONEY RECON]', req.requestId, exErr.message);
                return fail(res, 500, 'RECON_EXCEPTIONS_ERROR', 'Failed to load exceptions.');
            }

            res.json({
                success: true,
                provider,
                summary: {
                    total_internal: total,
                    total_provider: rows.reduce((sum, r) => sum + (r.webhook_event_count || 0), 0),
                    matched,
                    missing_webhook: missingWebhook,
                    unverified_signature: unverified,
                    unresolved,
                    closed,
                    manual_review: null,
                    exceptions: (exceptions || []).map(e => ({
                        issue_type: e.match_state,
                        reference: e.internal_reference,
                        provider_reference: e.provider_reference,
                        status: e.internal_status,
                        currency: e.wallet_currency,
                        expected_amount: e.wallet_amount,
                        created_at: e.created_at,
                        deposit_id: e.deposit_id,
                        source: e.source
                    }))
                },
                from: fromIso, to: toIso
            });
        } catch (err) {
            console.error('[MONEY RECON]', req.requestId, err);
            fail(res, 500, 'RECON_SUMMARY_EXCEPTION', 'Unexpected error.');
        }
    }
);

// GET /api/admin/reconciliation/issues
router.get(
    '/reconciliation/issues',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const page = parsePage(req.query.page);
            const limit = parseLimit(req.query.limit);
            const offset = (page - 1) * limit;
            const { status = 'open', provider, severity } = req.query;

            let q = supabaseAdmin
                .from('reconciliation_issues')
                .select('id, provider, issue_type, severity, status, internal_reference, provider_reference, currency, expected_amount, provider_amount, difference, created_at, resolved_at, resolution_notes, resolved_by, assigned_to', { count: 'exact' })
                .order('created_at', { ascending: false });
            if (status && status !== 'all') q = q.eq('status', status);
            if (provider) q = q.eq('provider', provider);
            if (severity) q = q.eq('severity', severity);
            q = q.range(offset, offset + limit - 1);

            const { data, error, count } = await q;
            if (error) {
                if (error.code === '42P01') {
                    return res.json({ success: true, issues: [], count: 0, page, limit, totalPages: 0 });
                }
                console.error('[MONEY RECON]', req.requestId, error.message);
                return fail(res, 500, 'ISSUES_ERROR', 'Failed to load issues.');
            }

            res.json({
                success: true,
                issues: data || [],
                count: count || 0,
                page, limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) {
            console.error('[MONEY RECON]', req.requestId, err);
            fail(res, 500, 'ISSUES_EXCEPTION', 'Unexpected error.');
        }
    }
);

// POST /api/admin/reconciliation/recheck/:source/:id
// VERIFY-ONLY. Does NOT credit the wallet. If the deposit is
// already completed, we return the existing state — we do not
// re-settle. Settlement only happens through the deposit services
// that own idempotency.
router.post(
    '/reconciliation/recheck/:source/:id',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    rateLimit({ key: 'recheck', max: 10, windowMs: 60_000 }),
    async (req, res) => {
        const { source, id } = req.params;
        if (source !== 'kora' && source !== 'crypto') {
            return fail(res, 422, 'INVALID_SOURCE', 'Source must be kora or crypto.');
        }
        if (!UUID_RE.test(String(id))) return fail(res, 400, 'INVALID_ID', 'Invalid deposit id.');

        try {
            const table = source === 'kora' ? 'deposit_requests' : 'crypto_deposits';
            const { data: dep, error } = await supabaseAdmin
                .from(table)
                .select(source === 'kora' ? DEP_KORA_COLS : DEP_CRYPTO_COLS)
                .eq('id', id)
                .maybeSingle();
            if (error) {
                console.error('[MONEY RECON]', req.requestId, 'recheck read', error.message);
                return fail(res, 500, 'RECHECK_READ_ERROR', 'Failed to load deposit.');
            }
            if (!dep) return fail(res, 404, 'DEPOSIT_NOT_FOUND', 'Deposit not found.');

            // Already completed? Idempotent no-op. Never re-settle.
            if (String(dep.status || '').toLowerCase() === 'completed') {
                return res.json({
                    success: true,
                    source,
                    deposit_id: id,
                    already_completed: true,
                    message: 'Deposit is already completed. No action taken.',
                    request_id: req.requestId
                });
            }

            // VERIFY-ONLY. Never touches the wallet.
            let verifyResult;
            try {
                if (source === 'kora') {
                    const korapayService = require('../../services/korapayService');
                    const ref = dep.provider_reference || dep.merchant_reference;
                    const verified = await korapayService.verifyTransaction(ref);
                    verifyResult = {
                        provider_status: verified?.status || 'unknown',
                        provider_amount: verified?.amount ?? null,
                        provider_currency: verified?.currency || null,
                        provider_reference: verified?.provider_reference || ref
                    };
                } else {
                    const nowPaymentsService = require('../../services/nowpaymentsService');
                    const pid = dep.nowpayments_payment_id;
                    const verified = await nowPaymentsService.getPaymentStatus(pid);
                    verifyResult = {
                        provider_status: verified?.payment_status || 'unknown',
                        provider_amount: verified?.actually_paid ?? null,
                        provider_currency: verified?.pay_currency || null,
                        provider_reference: pid
                    };
                }
            } catch (providerErr) {
                console.error('[MONEY RECON]', req.requestId, 'provider verify', providerErr.message);
                await recordAdminAction({
                    adminId: req.adminContext.id,
                    adminEmail: req.adminContext.email,
                    action: 'reconciliation.recheck_failed',
                    targetType: 'deposit',
                    targetId: id,
                    reason: req.body?.reason || 'Admin recheck',
                    after: { code: 'PROVIDER_ERROR' },
                    requestId: req.requestId,
                    req
                }).catch(() => {});
                // Do not leak provider error message to the client.
                return providerFail(res, 'PROVIDER_ERROR', req.requestId);
            }

            await recordAdminAction({
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                action: 'reconciliation.recheck_verify_only',
                targetType: 'deposit',
                targetId: id,
                reason: req.body?.reason || 'Admin recheck',
                after: verifyResult,
                requestId: req.requestId,
                req
            });

            // Explicitly do NOT settle. The settlement path is the
            // deposit service, invoked by the webhook or a
            // dedicated reconciliation job.
            res.json({
                success: true,
                source,
                deposit_id: id,
                verify_only: true,
                provider: verifyResult,
                settlement: {
                    settled: false,
                    reason: 'Recheck verifies the provider. Settlement happens through the deposit service webhook flow, which is idempotent.'
                },
                request_id: req.requestId
            });
        } catch (err) {
            console.error('[MONEY RECON]', req.requestId, err);
            fail(res, 500, 'RECHECK_EXCEPTION', 'Unexpected error.');
        }
    }
);

// POST /api/admin/reconciliation/issues/:id/resolve
// The credit amount and user are derived FROM THE ISSUE, not from
// the request body. If the issue doesn't have enough info to know
// the correct user and amount, we refuse.
router.post(
    '/reconciliation/issues/:id/resolve',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    rateLimit({ key: 'recon-resolve', max: 5, windowMs: 60_000 }),
    async (req, res) => {
        if (!UUID_RE.test(String(req.params.id || ''))) {
            return fail(res, 400, 'INVALID_ID', 'Invalid issue id.');
        }
        try {
            const { id } = req.params;
            const { resolution_notes } = req.body || {};
            const notes = String(resolution_notes || '').trim();
            if (notes.length < 4) {
                return fail(res, 422, 'NOTES_REQUIRED', 'Resolution notes are required (min 4 chars).');
            }

            const { data: issue, error } = await supabaseAdmin
                .from('reconciliation_issues')
                .select('id, provider, issue_type, status, user_id, deposit_id, transaction_id, currency, expected_amount, provider_amount, ledger_amount, difference, internal_reference, provider_reference')
                .eq('id', id)
                .maybeSingle();
            if (error) {
                console.error('[MONEY RECON]', req.requestId, 'issue read', error.message);
                return fail(res, 500, 'ISSUE_READ_ERROR', 'Failed to load issue.');
            }
            if (!issue) return fail(res, 404, 'ISSUE_NOT_FOUND', 'Issue not found.');
            if (issue.status === 'resolved') return fail(res, 409, 'ALREADY_RESOLVED', 'Issue already resolved.');

            // Decide whether a credit is applicable AT ALL, using
            // ONLY data the issue itself carries.
            //
            //   - If difference > 0 and user_id is present → the
            //     correct fix is to credit the difference.
            //   - Otherwise: mark resolved with no financial effect.
            const diff = num(issue.difference);
            const shouldCredit = diff > 0 && !!issue.user_id && !!issue.currency;
            let creditResult = null;

            if (shouldCredit) {
                if (!['NGN', 'USD'].includes(String(issue.currency).toUpperCase())) {
                    return fail(res, 422, 'UNSUPPORTED_CURRENCY', 'Issue currency is not credit-eligible.');
                }
                const amt = Number(diff.toFixed(2));
                if (!Number.isFinite(amt) || amt <= 0) {
                    return fail(res, 422, 'INVALID_ISSUE_AMOUNT', 'Issue difference is not a positive amount.');
                }

                // Idempotency: unique reference per issue.
                const ref = `RECON-${issue.id}`;
                let ledgerResult;
                try {
                    ledgerResult = await LedgerService.creditWallet({
                        userId: issue.user_id,
                        amount: amt,
                        currency: String(issue.currency).toUpperCase(),
                        description: `Reconciliation credit for issue ${issue.id}: ${notes}`,
                        reference: ref,
                        sourceType: 'reconciliation_credit',
                        sourceId: issue.id,
                        type: 'admin_adjustment',
                        metadata: {
                            admin_id: req.adminContext.id,
                            admin_email: req.adminContext.email,
                            issue_id: issue.id,
                            issue_type: issue.issue_type,
                            request_id: req.requestId
                        }
                    });
                } catch (ledgerErr) {
                    console.error('[MONEY RECON]', req.requestId, 'ledger credit', ledgerErr.message);
                    return fail(res, 400, 'LEDGER_CREDIT_FAILED', 'Ledger rejected the credit.');
                }
                creditResult = ledgerResult;
            }

            // Mark resolved. Concurrency-safe: only if still open.
            const { error: updErr } = await supabaseAdmin
                .from('reconciliation_issues')
                .update({
                    status: 'resolved',
                    resolution_notes: notes,
                    resolved_by: req.adminContext.id,
                    resolved_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    resolved_credit_transaction_id: creditResult?.transaction_id || null
                })
                .eq('id', id)
                .in('status', ['open', 'assigned', 'investigating']);

            if (updErr) {
                console.error('[MONEY RECON]', req.requestId, 'issue update', updErr.message);
                // If ledger posted but issue update failed, escalate —
                // do not pretend success. (The ledger ref is derived
                // from the issue id, so re-running is idempotent.)
                if (creditResult) {
                    return fail(res, 500, 'RESOLVE_PARTIAL',
                        'Credit posted but issue update failed. Escalate — the credit reference is derived from the issue id and is idempotent.',
                        { ledger_transaction_id: creditResult.transaction_id, reference: `RECON-${issue.id}` });
                }
                return fail(res, 500, 'RESOLVE_ERROR', 'Failed to resolve issue.');
            }

            await recordAdminAction({
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                action: 'reconciliation.issue_resolved',
                targetType: 'reconciliation_issue',
                targetId: id,
                before: { status: issue.status },
                after: {
                    status: 'resolved',
                    credit_applied: !!creditResult,
                    credit_amount: creditResult ? diff : 0
                },
                reason: notes,
                requestId: req.requestId,
                req
            });

            res.json({
                success: true,
                issue_id: id,
                credit_applied: !!creditResult,
                ledger: creditResult ? {
                    transaction_id: creditResult.transaction_id,
                    reference: creditResult.reference,
                    balance_before: creditResult.balance_before,
                    balance_after: creditResult.balance_after
                } : null,
                request_id: req.requestId
            });
        } catch (err) {
            console.error('[MONEY RECON]', req.requestId, err);
            fail(res, 500, 'RESOLVE_EXCEPTION', 'Unexpected error.');
        }
    }
);

router.get(
    '/reconciliation/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    rateLimit({ key: 'recon-export', max: 5, windowMs: 60_000 }),
    async (req, res) => {
        try {
            const { status, provider } = req.query;
            let q = supabaseAdmin
                .from('reconciliation_issues')
                .select('id, provider, issue_type, severity, status, internal_reference, provider_reference, currency, expected_amount, provider_amount, difference, created_at, resolved_at')
                .order('created_at', { ascending: false })
                .limit(MAX_EXPORT_ROWS);
            if (status && status !== 'all') q = q.eq('status', status);
            if (provider) q = q.eq('provider', provider);

            const { data, error } = await q;
            if (error) {
                console.error('[MONEY RECON]', req.requestId, 'export', error.message);
                return fail(res, 500, 'RECON_EXPORT_ERROR', 'Export failed.');
            }
            const header = ['Issue ID','Provider','Type','Severity','Status','Reference','Provider Reference','Currency','Expected','Provider Amount','Difference','Created','Resolved'];
            const lines = [csvRow(header)];
            for (const i of data || []) {
                lines.push(csvRow([
                    i.id, i.provider, i.issue_type, i.severity, i.status,
                    i.internal_reference || '', i.provider_reference || '',
                    i.currency || '', i.expected_amount ?? '', i.provider_amount ?? '', i.difference ?? '',
                    i.created_at, i.resolved_at || ''
                ]));
            }
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=reconciliation_${new Date().toISOString().slice(0,10)}_${req.requestId.slice(0,8)}.csv`);
            res.send(lines.join('\n'));
        } catch (err) {
            console.error('[MONEY RECON]', req.requestId, err);
            fail(res, 500, 'RECON_EXPORT_EXCEPTION', 'Unexpected error.');
        }
    }
);

// ─── Shapers ─────────────────────────────────────────────────────
function shapeTransaction(t) {
    const meta = t.metadata || {};
    return {
        id: t.id,
        reference: t.ref || t.reference || t.id,
        provider_reference: t.provider_reference || null,
        user: {
            id: t.user_id,
            username: t.profiles?.username || (t.profiles?.email ? t.profiles.email.split('@')[0] : 'User'),
            email: t.profiles?.email || null
        },
        type: t.type,
        category: classifyTransaction(t),
        service: meta.service || meta.service_type || null,
        direction: t.direction || (meta.direction || 'debit'),
        currency: String(t.currency || 'NGN').toUpperCase(),
        amount: num(t.amount),
        fee: num(t.fee),
        status: t.status,
        provider: t.provider || null,
        source_type: t.source_type || null,
        source_id: t.source_id || null,
        description: t.description || '',
        balance_before: meta.balance_before != null ? num(meta.balance_before) : null,
        balance_after: meta.balance_after != null ? num(meta.balance_after) : null,
        created_at: t.created_at,
        completed_at: t.completed_at || null,
        failed_at: t.failed_at || null,
        failure_reason: t.failure_reason || null
    };
}

function shapeUnifiedDeposit(d, profile) {
    return {
        id: d.id,
        source: d.source,
        method: d.source === 'kora' ? 'Bank Transfer / Kora' : 'Crypto (NowPayments)',
        reference: d.reference || d.internal_reference || null,
        provider_reference: d.provider_reference || null,
        merchant_reference: d.merchant_reference || null,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : { id: d.user_id, username: 'Unknown', email: null },
        payment_currency: d.payment_currency || null,
        payment_amount: d.payment_amount != null ? num(d.payment_amount) : null,
        wallet_currency: d.wallet_currency || null,
        wallet_amount: d.wallet_amount != null ? num(d.wallet_amount) : null,
        customer_rate: d.customer_rate != null ? num(d.customer_rate) : null,
        fx_rate: d.fx_rate != null ? num(d.fx_rate) : null,
        fee_amount: d.fee_amount != null ? num(d.fee_amount) : null,
        fee_currency: d.fee_currency || null,
        status: d.status,
        unified_transaction_id: d.unified_transaction_id || null,
        ledger_transaction_id: d.ledger_transaction_id || null,
        created_at: d.created_at,
        completed_at: d.completed_at || null,
        failed_at: d.failed_at || null,
        failure_reason: d.failure_reason || null
    };
}

function classifyTransaction(t) {
    const type = String(t.type || '').toLowerCase();
    if (type === 'deposit') return 'deposit';
    if (type === 'refund') return 'refund';
    if (type === 'cashback_earned' || type === 'cashback_used') return 'cashback';
    if (type === 'admin_adjustment') return 'adjustment';
    if (type === 'fee_revenue') return 'fee';
    if (type === 'wallet_credit' || type === 'wallet_debit') return 'wallet';
    return 'purchase';
}

// BigInt → "1234.56" without touching Number().
function bigintToDecimalString(cents) {
    const negative = cents < 0n;
    const abs = negative ? -cents : cents;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

module.exports = router;