// routes/admin/moneyAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Money area endpoints. Four concerns, one file, zero duplication.
//
//   /api/admin/transactions/*     — operational history
//   /api/admin/deposits/*         — how money entered MilesSpace
//   /api/admin/ledger/*           — accounting entries (append-only)
//   /api/admin/reconciliation/*   — do our records match the provider?
//
// Wallet adjustments and withdrawals are NOT here. Withdrawals are
// disabled on MilesSpace; wallet adjustments go through
// routes/admin/userRoutes.js (ledger-based).
//
// Every route requires a permission. No route mutates money directly
// — the two mutations here are:
//   * reconciliation.resolve → creates a ledger adjustment transaction
//     via LedgerService (never direct wallet write)
//   * reconciliation.recheck → re-queries the provider, updates the
//     deposit row status, never touches the wallet
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const providerFactory = require('../../services/providers/providerFactory');
const providerHealth  = require('../../services/providerHealthService');
const {
    requirePermission,
    recordAdminAction,
    PERMISSIONS
} = require('../../middleware/adminAuth');
const { LedgerService } = require('../../services/ledgerService');

// ─── Constants ───────────────────────────────────────────────────
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const MAX_EXPORT_ROWS = 10000;

// ─── Helpers ─────────────────────────────────────────────────────

function parseLimit(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(n, max);
}
function parsePage(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return n;
}
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
function isoDate(v, fallback) {
    if (!v) return fallback;
    const d = new Date(v);
    if (isNaN(d.getTime())) return fallback;
    return d.toISOString();
}
function fail(res, status, code, message, extra = {}) {
    if (res.headersSent) return;
    res.status(status).json({ success: false, error: message, code, ...extra });
}

// Standard classification of a transaction row for the list view.
function classifyTransaction(t) {
    const type = String(t.type || '').toLowerCase();
    if (type === 'deposit') return 'deposit';
    if (type === 'refund') return 'refund';
    if (type === 'cashback_earned' || type === 'cashback_used') return 'cashback';
    if (type === 'admin_adjustment') return 'adjustment';
    if (type === 'fee_revenue') return 'fee';
    if (type === 'wallet_credit' || type === 'wallet_debit') return 'wallet';
    return 'purchase'; // airtime, data, esim, gift, boost, marketplace, sms
}

// Direction: is money entering (credit) or leaving (debit) the wallet?
function directionOf(t) {
    const meta = t.metadata || t.meta || {};
    if (meta.direction === 'credit' || meta.direction === 'debit') return meta.direction;
    const type = String(t.type || '').toLowerCase();
    if (['deposit', 'refund', 'cashback_earned', 'wallet_credit', 'fee_revenue'].includes(type)) return 'credit';
    if (['cashback_used', 'wallet_debit'].includes(type)) return 'debit';
    if (type === 'admin_adjustment') {
        return t.category === 'credit' ? 'credit' : 'debit';
    }
    return 'debit'; // purchases
}

function shapeTransaction(t) {
    const meta = t.metadata || t.meta || {};
    const currency = String(t.currency || 'NGN').toUpperCase();
    const amount = num(t.amount);
    const fee = num(t.fee);
    const direction = directionOf(t);
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
        direction,
        currency,
        amount,
        fee,
        net_amount: direction === 'credit' ? amount - fee : amount + fee,
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

function shapeDeposit(d, source) {
    // `source` is 'kora' or 'crypto'
    if (source === 'kora') {
        const paymentCurrency = d.payment_currency || d.source_currency || null;
        const paymentAmount = d.payment_amount != null ? num(d.payment_amount) : num(d.source_amount);
        const walletCurrency = d.wallet_currency || d.target_currency || 'NGN';
        const walletAmount = d.wallet_amount != null ? num(d.wallet_amount) : num(d.target_amount);
        return {
            id: d.id,
            source: 'kora',
            method: 'Bank Transfer / Kora',
            reference: d.internal_reference,
            provider_reference: d.provider_reference || null,
            merchant_reference: d.merchant_reference || null,
            user: {
                id: d.user_id,
                username: d.profiles?.username || (d.profiles?.email ? d.profiles.email.split('@')[0] : 'User'),
                email: d.profiles?.email || null
            },
            payment_currency: paymentCurrency,
            payment_amount: paymentAmount,
            wallet_currency: walletCurrency,
            wallet_amount: walletAmount,
            customer_rate: d.customer_rate != null ? num(d.customer_rate) : null,
            fee_amount: num(d.fee_amount),
            fee_currency: d.fee_currency || null,
            fx_rate: d.fx_rate != null ? num(d.fx_rate) : null,
            status: d.status,
            unified_transaction_id: d.unified_transaction_id || null,
            ledger_transaction_id: d.ledger_transaction_id || null,
            created_at: d.created_at,
            completed_at: d.completed_at || null,
            failed_at: d.failed_at || null,
            failure_reason: d.failure_reason || null
        };
    }
    // crypto
    return {
        id: d.id,
        source: 'crypto',
        method: 'Crypto (NowPayments)',
        reference: d.nowpayments_payment_id || d.id,
        provider_reference: d.nowpayments_payment_id || null,
        merchant_reference: d.nowpayments_order_id || null,
        user: {
            id: d.user_id,
            username: d.profiles?.username || (d.profiles?.email ? d.profiles.email.split('@')[0] : 'User'),
            email: d.profiles?.email || null
        },
        payment_currency: d.pay_currency || null,
        payment_amount: d.pay_amount != null ? num(d.pay_amount) : null,
        wallet_currency: 'USD',
        wallet_amount: num(d.credited_amount || d.wallet_credit_usd || d.requested_usd),
        requested_usd: num(d.requested_usd || d.requested_amount),
        required_usd: num(d.required_usd || d.gross_amount),
        fee_usd: num(d.fee_usd),
        fee_percent: num(d.fee_percent),
        pay_network: d.pay_network || null,
        pay_address: d.pay_address || null,
        actually_paid_crypto: d.actually_paid_crypto != null ? num(d.actually_paid_crypto) : null,
        outcome_usd: d.outcome_usd != null ? num(d.outcome_usd) : null,
        status: d.status,
        unified_transaction_id: null,
        ledger_transaction_id: d.ledger_transaction_id || null,
        created_at: d.created_at,
        completed_at: d.completed_at || null,
        failed_at: d.failed_at || null,
        failure_reason: d.failure_reason || null
    };
}

// ═════════════════════════════════════════════════════════════════
//  TRANSACTIONS
// ═════════════════════════════════════════════════════════════════



router.get(
    '/orders/providers/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const providers = await providerHealth.getProviderHealth();
            res.json({ success: true, providers });
        } catch (err) {
            console.error('[ADMIN ORDERS] provider health failed:', err.message);
            res.status(500).json({ success: false, code: 'PROVIDER_HEALTH_FAILED', error: 'Failed to load provider health.' });
        }
    }
);

router.get(
    '/providers/:provider/health-check',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const name = String(req.params.provider || '').toLowerCase();
            const adapter = providerFactory.get(name);
            if (!adapter) return res.status(404).json({ success: false, code: 'UNKNOWN_PROVIDER', error: 'Unknown provider' });
            const result = await adapter.healthCheck();
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, code: 'HEALTH_FAILED', error: err.message });
        }
    }
);

router.post(
    '/providers/health-check-all',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const all = await providerFactory.healthAll();
            res.json({ success: true, results: all });
        } catch (err) {
            res.status(500).json({ success: false, code: 'HEALTH_FAILED', error: err.message });
        }
    }
);
// GET /api/admin/transactions
router.get(
    '/transactions',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const page = parsePage(req.query.page);
            const limit = parseLimit(req.query.limit);
            const offset = (page - 1) * limit;

            const {
                search, status, currency, type, category,
                direction, from, to, user_id
            } = req.query;

            let q = supabaseAdmin
                .from('transactions')
                .select(`
                    id, user_id, type, status, currency, amount, fee,
                    ref, reference, description, metadata, meta,
                    provider, provider_reference, source_type, source_id,
                    category, created_at, completed_at, failed_at, failure_reason,
                    profiles!transactions_user_id_fkey (username, email)
                `, { count: 'exact' })
                .order('created_at', { ascending: false });

            if (status && status !== 'all') q = q.eq('status', String(status).toLowerCase());
            if (currency && currency !== 'all') q = q.eq('currency', String(currency).toUpperCase());
            if (type) q = q.eq('type', String(type).toLowerCase());
            if (user_id) q = q.eq('user_id', user_id);

            const fromIso = isoDate(from);
            const toIso = isoDate(to);
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            if (search) {
                const safe = String(search).trim().replace(/[%_]/g, m => '\\' + m);
                q = q.or(`ref.ilike.%${safe}%,reference.ilike.%${safe}%,provider_reference.ilike.%${safe}%,description.ilike.%${safe}%`);
            }

            // Category filter is client-driven. We translate to a set of
            // transaction.type values.
            if (category && category !== 'all') {
                const map = {
                    deposit: ['deposit'],
                    refund: ['refund'],
                    cashback: ['cashback_earned', 'cashback_used'],
                    adjustment: ['admin_adjustment'],
                    wallet: ['wallet_credit', 'wallet_debit'],
                    purchase: ['airtime', 'data', 'esim', 'gift', 'gift_card', 'boost', 'marketplace', 'virtual_sms', 'sms']
                };
                const types = map[category];
                if (types) q = q.in('type', types);
            }

            q = q.range(offset, offset + limit - 1);

            const { data, error, count } = await q;
            if (error) {
                console.error('[MONEY TX] list error:', error.message);
                return fail(res, 500, 'TX_LIST_ERROR', 'Failed to load transactions');
            }

            let rows = (data || []).map(shapeTransaction);

            // Direction filter applied in-memory because it depends on
            // classification logic that isn't a column.
            if (direction && direction !== 'all') {
                rows = rows.filter(r => r.direction === direction);
            }

            res.json({
                success: true,
                transactions: rows,
                count: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) {
            console.error('[MONEY TX] exception:', err);
            fail(res, 500, 'TX_LIST_EXCEPTION', 'Unexpected error');
        }
    }
);

// GET /api/admin/transactions/stats
router.get(
    '/transactions/stats',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const { from, to } = req.query;
            const fromIso = isoDate(from);
            const toIso = isoDate(to);

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
            console.error('[MONEY TX] stats exception:', err);
            fail(res, 500, 'TX_STATS_EXCEPTION', 'Unexpected error');
        }
    }
);

// GET /api/admin/transactions/:id
// Full detail with webhooks, ledger entries, and related rows.
router.get(
    '/transactions/:id',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const { id } = req.params;

            const { data: tx, error } = await supabaseAdmin
                .from('transactions')
                .select(`
                    *,
                    profiles!transactions_user_id_fkey (id, username, email, phone, role, status)
                `)
                .eq('id', id)
                .maybeSingle();

            if (error || !tx) {
                return fail(res, 404, 'TX_NOT_FOUND', 'Transaction not found');
            }

            // Ledger entries created by this transaction
            let ledgerEntries = [];
            try {
                const { data: le } = await supabaseAdmin
                    .from('ledger_entries')
                    .select('id, transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, description, created_at')
                    .eq('transaction_id', id)
                    .order('created_at', { ascending: true });
                ledgerEntries = le || [];
            } catch (_) {}

            // Webhook events — try both provider tables
            let webhooks = [];
            const providerRef = tx.provider_reference || tx.ref || tx.reference;
            if (providerRef) {
                try {
                    const [koraRes, genericRes] = await Promise.all([
                        supabaseAdmin
                            .from('kora_webhook_events')
                            .select('id, provider, event_type, provider_reference, provider_event_ref, signature_valid, processing_status, processing_error, received_at, processed_at')
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
                    webhooks = [...(koraRes.data || []), ...(genericRes.data || [])]
                        .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
                } catch (_) {}
            }

            // Related deposit (Kora) or crypto deposit
            let deposit = null;
            if (tx.source_type === 'kora_deposit' || tx.provider === 'korapay') {
                const { data: dep } = await supabaseAdmin
                    .from('deposit_requests')
                    .select('*')
                    .or(`unified_transaction_id.eq.${id},ledger_transaction_id.eq.${id},internal_reference.eq.${tx.ref}`)
                    .maybeSingle();
                deposit = dep || null;
            } else if (tx.provider === 'nowpayments' || tx.source_type === 'crypto_deposit') {
                const { data: dep } = await supabaseAdmin
                    .from('crypto_deposits')
                    .select('*')
                    .or(`nowpayments_payment_id.eq.${tx.provider_reference},id.eq.${tx.source_id}`)
                    .maybeSingle();
                deposit = dep || null;
            }

            res.json({
                success: true,
                transaction: shapeTransaction(tx),
                raw: tx,
                user: tx.profiles || null,
                ledger_entries: ledgerEntries,
                webhooks,
                deposit
            });
        } catch (err) {
            console.error('[MONEY TX] detail exception:', err);
            fail(res, 500, 'TX_DETAIL_EXCEPTION', 'Unexpected error');
        }
    }
);

// GET /api/admin/transactions/export
router.get(
    '/transactions/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    async (req, res) => {
        try {
            const { from, to, status, currency } = req.query;
            const fromIso = isoDate(from);
            const toIso = isoDate(to);

            let q = supabaseAdmin
                .from('transactions')
                .select('id, ref, reference, provider_reference, type, status, currency, amount, fee, provider, description, created_at, completed_at')
                .order('created_at', { ascending: false })
                .limit(MAX_EXPORT_ROWS);

            if (status && status !== 'all') q = q.eq('status', String(status).toLowerCase());
            if (currency && currency !== 'all') q = q.eq('currency', String(currency).toUpperCase());
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            const { data, error } = await q;
            if (error) return fail(res, 500, 'EXPORT_ERROR', 'Export failed');

            const rows = [
                ['Reference', 'Provider Reference', 'Type', 'Status', 'Currency', 'Amount', 'Fee', 'Provider', 'Description', 'Created', 'Completed']
            ];
            for (const t of data || []) {
                rows.push([
                    t.ref || t.reference || '',
                    t.provider_reference || '',
                    t.type || '',
                    t.status || '',
                    t.currency || '',
                    t.amount ?? '',
                    t.fee ?? '',
                    t.provider || '',
                    (t.description || '').replace(/"/g, '""'),
                    t.created_at || '',
                    t.completed_at || ''
                ]);
            }
            const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=transactions_${Date.now()}.csv`);
            res.send(csv);
        } catch (err) {
            console.error('[MONEY TX] export exception:', err);
            fail(res, 500, 'EXPORT_EXCEPTION', 'Unexpected error');
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  DEPOSITS
// ═════════════════════════════════════════════════════════════════

// GET /api/admin/deposits
// Unified: Kora + Crypto. Filter by source or view both.
router.get(
    '/deposits',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const page = parsePage(req.query.page);
            const limit = parseLimit(req.query.limit);
            const offset = (page - 1) * limit;
            const { search, status, source, wallet_currency, from, to } = req.query;

            const fromIso = isoDate(from);
            const toIso = isoDate(to);
            const wantKora = !source || source === 'all' || source === 'kora';
            const wantCrypto = !source || source === 'all' || source === 'crypto';

            const koraQ = () => {
                let q = supabaseAdmin
                    .from('deposit_requests')
                    .select(`
                        id, user_id, internal_reference, provider_reference, merchant_reference,
                        payment_currency, payment_amount, wallet_currency, wallet_amount,
                        customer_rate, fx_rate, fee_amount, fee_currency,
                        status, unified_transaction_id, ledger_transaction_id,
                        created_at, completed_at, failed_at, failure_reason,
                        profiles!deposit_requests_user_id_fkey (username, email)
                    `, { count: 'exact' })
                    .order('created_at', { ascending: false })
                    .limit(MAX_LIMIT);
                if (status && status !== 'all') q = q.eq('status', String(status).toLowerCase());
                if (wallet_currency && wallet_currency !== 'all') q = q.eq('wallet_currency', String(wallet_currency).toUpperCase());
                if (fromIso) q = q.gte('created_at', fromIso);
                if (toIso) q = q.lte('created_at', toIso);
                if (search) {
                    const safe = String(search).trim().replace(/[%_]/g, m => '\\' + m);
                    q = q.or(`internal_reference.ilike.%${safe}%,provider_reference.ilike.%${safe}%,merchant_reference.ilike.%${safe}%`);
                }
                return q;
            };

            const cryptoQ = () => {
                let q = supabaseAdmin
                    .from('crypto_deposits')
                    .select(`
                        id, user_id, nowpayments_payment_id, nowpayments_order_id,
                        pay_currency, pay_network, pay_amount, pay_address,
                        requested_usd, required_usd, fee_usd, fee_percent,
                        credited_amount, wallet_credit_usd, actually_paid_crypto, outcome_usd,
                        status, ledger_transaction_id,
                        created_at, completed_at, failed_at, failure_reason,
                        profiles!crypto_deposits_user_id_fkey (username, email)
                    `, { count: 'exact' })
                    .order('created_at', { ascending: false })
                    .limit(MAX_LIMIT);
                if (status && status !== 'all') q = q.eq('status', String(status).toLowerCase());
                if (fromIso) q = q.gte('created_at', fromIso);
                if (toIso) q = q.lte('created_at', toIso);
                if (search) {
                    const safe = String(search).trim().replace(/[%_]/g, m => '\\' + m);
                    q = q.or(`nowpayments_payment_id.ilike.%${safe}%,nowpayments_order_id.ilike.%${safe}%,pay_currency.ilike.%${safe}%`);
                }
                return q;
            };

            const [koraRes, cryptoRes] = await Promise.all([
                wantKora ? koraQ() : Promise.resolve({ data: [], count: 0 }),
                wantCrypto ? cryptoQ() : Promise.resolve({ data: [], count: 0 })
            ]);

            let rows = [];
            if (koraRes.data) rows.push(...koraRes.data.map(d => shapeDeposit(d, 'kora')));
            if (cryptoRes.data) rows.push(...cryptoRes.data.map(d => shapeDeposit(d, 'crypto')));

            rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            const totalCount = (koraRes.count || 0) + (cryptoRes.count || 0);
            const paged = rows.slice(offset, offset + limit);

            res.json({
                success: true,
                deposits: paged,
                count: totalCount,
                page,
                limit,
                totalPages: Math.ceil(totalCount / limit)
            });
        } catch (err) {
            console.error('[MONEY DEP] list exception:', err);
            fail(res, 500, 'DEP_LIST_EXCEPTION', 'Unexpected error');
        }
    }
);

// GET /api/admin/deposits/stats
router.get(
    '/deposits/stats',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const { from, to } = req.query;
            const fromIso = isoDate(from);
            const toIso = isoDate(to);

            const [koraCompleted, koraPending, koraFailed, cryptoCompleted, cryptoPending, cryptoManual] = await Promise.all([
                supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
                supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing']),
                supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true }).in('status', ['failed', 'expired', 'cancelled']),
                supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
                supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing', 'partially_paid']),
                supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true }).eq('status', 'manual_review')
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
                    }
                }
            });
        } catch (err) {
            console.error('[MONEY DEP] stats exception:', err);
            fail(res, 500, 'DEP_STATS_EXCEPTION', 'Unexpected error');
        }
    }
);

// GET /api/admin/deposits/:source/:id
// source = 'kora' | 'crypto'
router.get(
    '/deposits/:source/:id',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const { source, id } = req.params;
            if (source !== 'kora' && source !== 'crypto') {
                return fail(res, 422, 'INVALID_SOURCE', 'Source must be kora or crypto');
            }

            const table = source === 'kora' ? 'deposit_requests' : 'crypto_deposits';
            const { data: dep, error } = await supabaseAdmin
                .from(table)
                .select(`*, profiles!${table}_user_id_fkey (id, username, email, phone)`)
                .eq('id', id)
                .maybeSingle();

            if (error || !dep) return fail(res, 404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');

            // Webhook events for this deposit
            const providerRef = source === 'kora' ? dep.provider_reference : dep.nowpayments_payment_id;
            let webhooks = [];
            if (providerRef) {
                try {
                    const [koraRes, npRes] = await Promise.all([
                        supabaseAdmin.from('kora_webhook_events')
                            .select('*')
                            .eq('provider_reference', providerRef)
                            .order('received_at', { ascending: false })
                            .limit(20),
                        supabaseAdmin.from('provider_webhook_events')
                            .select('*')
                            .or(`payment_id.eq.${providerRef},order_id.eq.${providerRef}`)
                            .order('received_at', { ascending: false })
                            .limit(20)
                    ]);
                    webhooks = [...(koraRes.data || []), ...(npRes.data || [])]
                        .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
                } catch (_) {}
            }

            // Linked unified transaction
            let transaction = null;
            const txId = source === 'kora' ? dep.unified_transaction_id : null;
            const txRef = source === 'crypto' ? dep.nowpayments_payment_id : null;
            if (txId) {
                const { data: t } = await supabaseAdmin.from('transactions').select('*').eq('id', txId).maybeSingle();
                transaction = t || null;
            } else if (txRef) {
                const { data: t } = await supabaseAdmin.from('transactions')
                    .select('*')
                    .or(`ref.eq.${txRef},reference.eq.${txRef}`)
                    .eq('type', 'deposit')
                    .maybeSingle();
                transaction = t || null;
            }

            res.json({
                success: true,
                deposit: shapeDeposit(dep, source),
                raw: dep,
                user: dep.profiles || null,
                webhooks,
                transaction: transaction ? shapeTransaction(transaction) : null
            });
        } catch (err) {
            console.error('[MONEY DEP] detail exception:', err);
            fail(res, 500, 'DEP_DETAIL_EXCEPTION', 'Unexpected error');
        }
    }
);

// GET /api/admin/deposits/export
router.get(
    '/deposits/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    async (req, res) => {
        try {
            const { status, source, from, to } = req.query;
            const fromIso = isoDate(from);
            const toIso = isoDate(to);
            const wantKora = !source || source === 'all' || source === 'kora';
            const wantCrypto = !source || source === 'all' || source === 'crypto';

            const rowsOut = [['Source', 'Reference', 'Provider Reference', 'User', 'Payment Currency', 'Payment Amount', 'Wallet Currency', 'Wallet Amount', 'Fee', 'Status', 'Created', 'Completed']];

            if (wantKora) {
                let q = supabaseAdmin.from('deposit_requests')
                    .select('internal_reference, provider_reference, payment_currency, payment_amount, wallet_currency, wallet_amount, fee_amount, fee_currency, status, created_at, completed_at, profiles!deposit_requests_user_id_fkey (username, email)')
                    .order('created_at', { ascending: false })
                    .limit(MAX_EXPORT_ROWS);
                if (status && status !== 'all') q = q.eq('status', String(status).toLowerCase());
                if (fromIso) q = q.gte('created_at', fromIso);
                if (toIso) q = q.lte('created_at', toIso);
                const { data } = await q;
                for (const d of data || []) {
                    rowsOut.push([
                        'kora', d.internal_reference || '', d.provider_reference || '',
                        d.profiles?.username || d.profiles?.email || '',
                        d.payment_currency || '', d.payment_amount ?? '',
                        d.wallet_currency || '', d.wallet_amount ?? '',
                        `${d.fee_amount ?? ''} ${d.fee_currency || ''}`.trim(),
                        d.status || '', d.created_at || '', d.completed_at || ''
                    ]);
                }
            }
            if (wantCrypto) {
                let q = supabaseAdmin.from('crypto_deposits')
                    .select('nowpayments_payment_id, pay_currency, pay_amount, requested_usd, required_usd, credited_amount, fee_usd, status, created_at, completed_at, profiles!crypto_deposits_user_id_fkey (username, email)')
                    .order('created_at', { ascending: false })
                    .limit(MAX_EXPORT_ROWS);
                if (status && status !== 'all') q = q.eq('status', String(status).toLowerCase());
                if (fromIso) q = q.gte('created_at', fromIso);
                if (toIso) q = q.lte('created_at', toIso);
                const { data } = await q;
                for (const d of data || []) {
                    rowsOut.push([
                        'crypto', d.nowpayments_payment_id || '', d.nowpayments_payment_id || '',
                        d.profiles?.username || d.profiles?.email || '',
                        d.pay_currency || '', d.pay_amount ?? '',
                        'USD', d.credited_amount ?? d.requested_usd ?? '',
                        d.fee_usd ?? '', d.status || '', d.created_at || '', d.completed_at || ''
                    ]);
                }
            }

            const csv = rowsOut.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=deposits_${Date.now()}.csv`);
            res.send(csv);
        } catch (err) {
            console.error('[MONEY DEP] export exception:', err);
            fail(res, 500, 'DEP_EXPORT_EXCEPTION', 'Unexpected error');
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  LEDGER
// ═════════════════════════════════════════════════════════════════

// GET /api/admin/ledger
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
                    id, transaction_id, account_id, entry_type, amount, currency,
                    balance_before, balance_after, description, metadata, created_at,
                    ledger_accounts!inner (user_id, currency, profiles (id, username, email)),
                    transactions!inner (id, ref, reference, type, status, provider, description)
                `, { count: 'exact' })
                .order('created_at', { ascending: false });

            if (currency && currency !== 'all') q = q.eq('currency', String(currency).toUpperCase());
            if (direction && direction !== 'all') q = q.eq('entry_type', direction === 'credit' ? 'CREDIT' : 'DEBIT');
            if (user_id) q = q.eq('ledger_accounts.user_id', user_id);
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            if (search) {
                const safe = String(search).trim().replace(/[%_]/g, m => '\\' + m);
                q = q.or(`description.ilike.%${safe}%,transaction_id.ilike.%${safe}%`);
            }

            q = q.range(offset, offset + limit - 1);

            const { data, error, count } = await q;
            if (error) {
                console.error('[MONEY LEDGER] list error:', error.message);
                return fail(res, 500, 'LEDGER_LIST_ERROR', 'Failed to load ledger entries');
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
                    metadata: e.metadata || {},
                    provider: tx.provider || null,
                    created_at: e.created_at
                };
            });

            res.json({
                success: true,
                entries,
                count: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) {
            console.error('[MONEY LEDGER] exception:', err);
            fail(res, 500, 'LEDGER_LIST_EXCEPTION', 'Unexpected error');
        }
    }
);

// GET /api/admin/ledger/balances
// Customer wallet liabilities from the ledger — the source of truth.
router.get(
    '/ledger/balances',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const { data, error } = await supabaseAdmin
                .from('ledger_accounts')
                .select('currency, available_balance, held_balance');

            if (error) return fail(res, 500, 'BALANCES_ERROR', 'Failed to load balances');

            // Sum using BigInt cents to avoid float drift.
            const totals = {};
            for (const row of data || []) {
                const ccy = row.currency || 'NGN';
                if (!totals[ccy]) totals[ccy] = { available: 0n, held: 0n };
                totals[ccy].available += BigInt(Math.round(num(row.available_balance) * 100));
                totals[ccy].held += BigInt(Math.round(num(row.held_balance) * 100));
            }

            const out = {};
            for (const [ccy, t] of Object.entries(totals)) {
                out[ccy] = {
                    available: (Number(t.available) / 100).toFixed(2),
                    held: (Number(t.held) / 100).toFixed(2),
                    total: (Number(t.available + t.held) / 100).toFixed(2)
                };
            }

            res.json({ success: true, balances: out });
        } catch (err) {
            console.error('[MONEY LEDGER] balances exception:', err);
            fail(res, 500, 'BALANCES_EXCEPTION', 'Unexpected error');
        }
    }
);

// GET /api/admin/ledger/user/:userId
// Per-user ledger view with running totals.
router.get(
    '/ledger/user/:userId',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const { userId } = req.params;
            const { currency, from, to } = req.query;
            const limit = parseLimit(req.query.limit, 100, 500);
            const fromIso = isoDate(from);
            const toIso = isoDate(to);

            // Resolve the account(s) for this user.
            let accountsQ = supabaseAdmin.from('ledger_accounts').select('id, currency, available_balance, held_balance').eq('user_id', userId);
            if (currency && currency !== 'all') accountsQ = accountsQ.eq('currency', String(currency).toUpperCase());
            const { data: accounts } = await accountsQ;

            if (!accounts || !accounts.length) {
                return res.json({ success: true, accounts: [], entries: [] });
            }

            const accountIds = accounts.map(a => a.id);

            let q = supabaseAdmin
                .from('ledger_entries')
                .select('id, transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, description, metadata, created_at, transactions!inner (id, ref, reference, type, status, provider)')
                .in('account_id', accountIds)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            const { data: entries } = await q;

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
            console.error('[MONEY LEDGER] user exception:', err);
            fail(res, 500, 'LEDGER_USER_EXCEPTION', 'Unexpected error');
        }
    }
);

// GET /api/admin/ledger/export
router.get(
    '/ledger/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    async (req, res) => {
        try {
            const { from, to, currency, direction } = req.query;
            const fromIso = isoDate(from);
            const toIso = isoDate(to);

            let q = supabaseAdmin.from('ledger_entries')
                .select('id, transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, description, created_at')
                .order('created_at', { ascending: false })
                .limit(MAX_EXPORT_ROWS);
            if (currency && currency !== 'all') q = q.eq('currency', String(currency).toUpperCase());
            if (direction && direction !== 'all') q = q.eq('entry_type', direction === 'credit' ? 'CREDIT' : 'DEBIT');
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            const { data } = await q;
            const rows = [['Entry ID', 'Transaction ID', 'Account ID', 'Type', 'Amount', 'Currency', 'Balance Before', 'Balance After', 'Description', 'Created']];
            for (const e of data || []) {
                rows.push([
                    e.id, e.transaction_id, e.account_id, e.entry_type,
                    e.amount ?? '', e.currency, e.balance_before ?? '', e.balance_after ?? '',
                    (e.description || '').replace(/"/g, '""'), e.created_at
                ]);
            }
            const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=ledger_${Date.now()}.csv`);
            res.send(csv);
        } catch (err) {
            console.error('[MONEY LEDGER] export exception:', err);
            fail(res, 500, 'LEDGER_EXPORT_EXCEPTION', 'Unexpected error');
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  RECONCILIATION
// ═════════════════════════════════════════════════════════════════

// GET /api/admin/reconciliation/summary
// Runs a lightweight match over a date range for Kora deposits.
// Does not query the provider — matches internal rows to webhook events.
router.get(
    '/reconciliation/summary',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const { from, to, provider = 'kora' } = req.query;
            const fromIso = isoDate(from, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
            const toIso = isoDate(to, new Date().toISOString());

            if (provider !== 'kora' && provider !== 'nowpayments') {
                return fail(res, 422, 'INVALID_PROVIDER', 'Provider must be kora or nowpayments');
            }

            if (provider === 'kora') {
                const { data: deposits } = await supabaseAdmin
                    .from('deposit_requests')
                    .select('id, internal_reference, provider_reference, wallet_amount, wallet_currency, status, created_at, unified_transaction_id')
                    .gte('created_at', fromIso)
                    .lte('created_at', toIso);

                const { data: webhooks } = await supabaseAdmin
                    .from('kora_webhook_events')
                    .select('provider_reference, processing_status, signature_valid, received_at')
                    .gte('received_at', fromIso)
                    .lte('received_at', toIso);

                const webhookMap = new Map();
                for (const w of webhooks || []) {
                    if (!webhookMap.has(w.provider_reference)) webhookMap.set(w.provider_reference, []);
                    webhookMap.get(w.provider_reference).push(w);
                }

                let matched = 0, missingWebhook = 0, unverifiedSignature = 0, unresolved = 0;
                const exceptions = [];

                for (const d of deposits || []) {
                    const pr = d.provider_reference;
                    const hooks = pr ? webhookMap.get(pr) : null;
                    const completed = String(d.status || '').toLowerCase() === 'completed';

                    if (!hooks) {
                        if (completed) {
                            matched++;
                        } else {
                            missingWebhook++;
                            exceptions.push({
                                issue_type: 'MISSING_AT_PROVIDER',
                                reference: d.internal_reference,
                                provider_reference: pr,
                                status: d.status,
                                created_at: d.created_at
                            });
                        }
                        continue;
                    }
                    const anyVerified = hooks.some(h => h.signature_valid);
                    if (!anyVerified) {
                        unverifiedSignature++;
                        exceptions.push({
                            issue_type: 'STATUS_MISMATCH',
                            reference: d.internal_reference,
                            provider_reference: pr,
                            status: d.status,
                            reason: 'No verified webhook for this deposit'
                        });
                        continue;
                    }
                    if (completed) {
                        matched++;
                    } else {
                        unresolved++;
                        exceptions.push({
                            issue_type: 'STATUS_MISMATCH',
                            reference: d.internal_reference,
                            provider_reference: pr,
                            status: d.status,
                            reason: 'Verified webhook but internal status not completed'
                        });
                    }
                }

                return res.json({
                    success: true,
                    provider: 'kora',
                    summary: {
                        total_provider: webhooks?.length || 0,
                        total_internal: deposits?.length || 0,
                        matched,
                        missing_webhook: missingWebhook,
                        unverified_signature: unverifiedSignature,
                        unresolved,
                        exceptions: exceptions.slice(0, 100)
                    },
                    from: fromIso,
                    to: toIso
                });
            }

            // nowpayments
            const { data: deposits } = await supabaseAdmin
                .from('crypto_deposits')
                .select('id, nowpayments_payment_id, required_usd, requested_usd, status, created_at, ledger_transaction_id')
                .gte('created_at', fromIso)
                .lte('created_at', toIso);

            const { data: webhooks } = await supabaseAdmin
                .from('provider_webhook_events')
                .select('payment_id, processing_status, signature_valid, received_at')
                .eq('provider', 'nowpayments')
                .gte('received_at', fromIso)
                .lte('received_at', toIso);

            const webhookMap = new Map();
            for (const w of webhooks || []) {
                if (!webhookMap.has(w.payment_id)) webhookMap.set(w.payment_id, []);
                webhookMap.get(w.payment_id).push(w);
            }

            let matched = 0, missingWebhook = 0, unverifiedSignature = 0, unresolved = 0, manualReview = 0;
            const exceptions = [];

            for (const d of deposits || []) {
                const pid = d.nowpayments_payment_id;
                const hooks = pid ? webhookMap.get(pid) : null;
                const st = String(d.status || '').toLowerCase();

                if (st === 'manual_review' || st === 'partially_paid') {
                    manualReview++;
                    exceptions.push({
                        issue_type: 'AMOUNT_MISMATCH',
                        reference: pid,
                        status: st,
                        expected_amount: d.required_usd
                    });
                    continue;
                }

                if (!hooks) {
                    if (st === 'completed') matched++;
                    else {
                        missingWebhook++;
                        exceptions.push({ issue_type: 'MISSING_AT_PROVIDER', reference: pid, status: st });
                    }
                    continue;
                }
                const anyVerified = hooks.some(h => h.signature_valid);
                if (!anyVerified) {
                    unverifiedSignature++;
                    exceptions.push({ issue_type: 'STATUS_MISMATCH', reference: pid, status: st, reason: 'Unverified webhook' });
                    continue;
                }
                if (st === 'completed') matched++;
                else {
                    unresolved++;
                    exceptions.push({ issue_type: 'STATUS_MISMATCH', reference: pid, status: st });
                }
            }

            res.json({
                success: true,
                provider: 'nowpayments',
                summary: {
                    total_provider: webhooks?.length || 0,
                    total_internal: deposits?.length || 0,
                    matched,
                    missing_webhook: missingWebhook,
                    unverified_signature: unverifiedSignature,
                    unresolved,
                    manual_review: manualReview,
                    exceptions: exceptions.slice(0, 100)
                },
                from: fromIso,
                to: toIso
            });
        } catch (err) {
            console.error('[MONEY RECON] summary exception:', err);
            fail(res, 500, 'RECON_SUMMARY_EXCEPTION', 'Unexpected error');
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
                .select('*', { count: 'exact' })
                .order('created_at', { ascending: false });

            if (status && status !== 'all') q = q.eq('status', status);
            if (provider) q = q.eq('provider', provider);
            if (severity) q = q.eq('severity', severity);

            q = q.range(offset, offset + limit - 1);
            const { data, error, count } = await q;
            if (error) {
                // Table might not exist yet.
                if (error.code === '42P01') {
                    return res.json({ success: true, issues: [], count: 0, page, limit, totalPages: 0 });
                }
                return fail(res, 500, 'ISSUES_ERROR', 'Failed to load issues');
            }

            res.json({
                success: true,
                issues: data || [],
                count: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) {
            console.error('[MONEY RECON] issues exception:', err);
            fail(res, 500, 'ISSUES_EXCEPTION', 'Unexpected error');
        }
    }
);

// POST /api/admin/reconciliation/recheck/:source/:id
// Re-verifies a deposit with the provider and syncs its status.
// source = 'kora' | 'crypto'. Never touches the wallet directly.
router.post(
    '/reconciliation/recheck/:source/:id',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    async (req, res) => {
        try {
            const { source, id } = req.params;
            if (source !== 'kora' && source !== 'crypto') {
                return fail(res, 422, 'INVALID_SOURCE', 'Source must be kora or crypto');
            }

            // Load the deposit row first.
            const table = source === 'kora' ? 'deposit_requests' : 'crypto_deposits';
            const { data: dep, error } = await supabaseAdmin
                .from(table)
                .select('*')
                .eq('id', id)
                .maybeSingle();
            if (error || !dep) return fail(res, 404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');

            let result;
            try {
                if (source === 'kora') {
                    const korapayService = require('../../services/korapayService');
                    const depositService = require('../../services/depositService');
                    const ref = dep.provider_reference || dep.merchant_reference;
                    const verified = await korapayService.verifyTransaction(ref);
                    verified._verified = true;
                    result = await depositService.completeKoraDeposit({
                        depositId: dep.id,
                        providerTransaction: verified,
                        source: 'admin_recheck'
                    });
                } else {
                    const cryptoDepositService = require('../../services/cryptoDepositService');
                    result = await cryptoDepositService.verifyAndComplete(dep.nowpayments_payment_id, 'admin_recheck');
                }
            } catch (providerErr) {
                console.error('[MONEY RECON] recheck provider error:', providerErr.message);
                await recordAdminAction({
                    adminId: req.adminContext.id,
                    action: 'reconciliation.recheck_failed',
                    targetType: 'deposit',
                    targetId: id,
                    reason: req.body?.reason || 'Admin recheck',
                    after: { error: providerErr.message },
                    req
                });
                return fail(res, 502, 'PROVIDER_ERROR', providerErr.message);
            }

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'reconciliation.recheck',
                targetType: 'deposit',
                targetId: id,
                reason: req.body?.reason || 'Admin recheck',
                after: { result, source },
                req
            });

            res.json({ success: true, source, deposit_id: id, result });
        } catch (err) {
            console.error('[MONEY RECON] recheck exception:', err);
            fail(res, 500, 'RECHECK_EXCEPTION', 'Unexpected error');
        }
    }
);

// POST /api/admin/reconciliation/issues/:id/resolve
// Marks an issue resolved. If the resolution is "credit customer",
// the caller must supply `apply_credit: true` and the amount — the
// credit is applied through LedgerService, never a direct write.
router.post(
    '/reconciliation/issues/:id/resolve',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { resolution_notes, apply_credit, credit_amount, credit_currency, credit_user_id } = req.body || {};

            if (!resolution_notes || String(resolution_notes).trim().length < 4) {
                return fail(res, 422, 'NOTES_REQUIRED', 'Resolution notes are required (min 4 chars)');
            }

            const { data: issue, error } = await supabaseAdmin
                .from('reconciliation_issues')
                .select('*')
                .eq('id', id)
                .maybeSingle();
            if (error || !issue) return fail(res, 404, 'ISSUE_NOT_FOUND', 'Issue not found');
            if (issue.status === 'resolved') return fail(res, 409, 'ALREADY_RESOLVED', 'Issue already resolved');

            let ledgerResult = null;
            if (apply_credit) {
                if (!credit_user_id || !credit_amount || !credit_currency) {
                    return fail(res, 422, 'CREDIT_FIELDS_REQUIRED', 'user_id, amount, currency required when apply_credit is true');
                }
                if (!['NGN', 'USD'].includes(String(credit_currency).toUpperCase())) {
                    return fail(res, 422, 'INVALID_CREDIT_CURRENCY', 'Currency must be NGN or USD');
                }
                const amt = Number(credit_amount);
                if (!Number.isFinite(amt) || amt <= 0) {
                    return fail(res, 422, 'INVALID_CREDIT_AMOUNT', 'Credit amount must be positive');
                }

                try {
                    ledgerResult = await LedgerService.creditWallet({
                        userId: credit_user_id,
                        amount: amt,
                        currency: String(credit_currency).toUpperCase(),
                        description: `Reconciliation credit: ${resolution_notes}`,
                        reference: `RECON-${issue.id}`,
                        sourceType: 'reconciliation_credit',
                        sourceId: issue.id,
                        metadata: {
                            admin_id: req.adminContext.id,
                            issue_id: issue.id,
                            issue_type: issue.issue_type
                        },
                        type: 'admin_adjustment'
                    });
                } catch (ledgerErr) {
                    return fail(res, 400, 'LEDGER_CREDIT_FAILED', ledgerErr.message);
                }
            }

            await supabaseAdmin
                .from('reconciliation_issues')
                .update({
                    status: 'resolved',
                    resolution_notes,
                    resolved_by: req.adminContext.id,
                    resolved_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', id);

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'reconciliation.issue_resolved',
                targetType: 'reconciliation_issue',
                targetId: id,
                before: { status: issue.status },
                after: { status: 'resolved', credit_applied: !!ledgerResult },
                reason: resolution_notes,
                req
            });

            res.json({
                success: true,
                issue_id: id,
                credit_applied: !!ledgerResult,
                ledger: ledgerResult
            });
        } catch (err) {
            console.error('[MONEY RECON] resolve exception:', err);
            fail(res, 500, 'RESOLVE_EXCEPTION', 'Unexpected error');
        }
    }
);

// GET /api/admin/reconciliation/export
router.get(
    '/reconciliation/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    async (req, res) => {
        try {
            const { status, provider } = req.query;
            let q = supabaseAdmin.from('reconciliation_issues').select('*').order('created_at', { ascending: false }).limit(MAX_EXPORT_ROWS);
            if (status && status !== 'all') q = q.eq('status', status);
            if (provider) q = q.eq('provider', provider);
            const { data } = await q;
            const rows = [['Issue ID', 'Provider', 'Type', 'Severity', 'Status', 'Reference', 'Provider Reference', 'Currency', 'Expected', 'Provider Amount', 'Difference', 'Created', 'Resolved']];
            for (const i of data || []) {
                rows.push([
                    i.id, i.provider, i.issue_type, i.severity, i.status,
                    i.internal_reference || '', i.provider_reference || '',
                    i.currency || '', i.expected_amount ?? '', i.provider_amount ?? '', i.difference ?? '',
                    i.created_at, i.resolved_at || ''
                ]);
            }
            const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=reconciliation_${Date.now()}.csv`);
            res.send(csv);
        } catch (err) {
            console.error('[MONEY RECON] export exception:', err);
            fail(res, 500, 'RECON_EXPORT_EXCEPTION', 'Unexpected error');
        }
    }
);

module.exports = router;