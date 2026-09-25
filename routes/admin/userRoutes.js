// routes/admin/userRoutes.js — full rewrite
// ─────────────────────────────────────────────────────────────────
// Admin user management. One authoritative implementation.
//
// Existing endpoints (same URL, same envelope):
//   GET  /api/admin/users
//   GET  /api/admin/users/recent
//   GET  /api/admin/users/stats
//   GET  /api/admin/users/:id
//   GET  /api/admin/users/:id/detail
//   PUT  /api/admin/users/:id
//   PUT  /api/admin/users/:id/status
//   POST /api/admin/users/:id/wallet
//
// New endpoints:
//   GET  /api/admin/users/:id/overview
//   GET  /api/admin/users/:id/wallets
//   GET  /api/admin/users/:id/ledger
//   GET  /api/admin/users/:id/transactions
//   GET  /api/admin/users/:id/security
//   GET  /api/admin/users/:id/support
//   GET  /api/admin/users/:id/notes
//   POST /api/admin/users/:id/notes
//   POST /api/admin/users/:id/restrictions
//   DELETE /api/admin/users/:id/restrictions/:restriction
//   POST /api/admin/users/:id/force-logout
//   POST /api/admin/users/:id/require-password-reset
//   POST /api/admin/users/:id/require-2fa
//   GET  /api/admin/approvals
//   POST /api/admin/approvals/:id/approve
//   POST /api/admin/approvals/:id/reject
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const {
    requirePermission,
    recordAdminAction,
    PERMISSIONS
} = require('../../middleware/adminAuth');
const { LedgerService } = require('../../services/ledgerService');

// ─── CONSTANTS ───────────────────────────────────────────────────
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 20;
const MAX_WALLET_ADJUSTMENT = 100_000_000;
const APPROVAL_THRESHOLD = Number(process.env.ADMIN_APPROVAL_THRESHOLD || 100_000);
const ALLOWED_CURRENCIES = new Set(['NGN', 'USD']);
const ALLOWED_STATUS = new Set(['active', 'inactive', 'suspended', 'banned']);
const ALLOWED_ROLES = new Set(['user', 'admin', 'super_admin', 'finance', 'operations', 'support', 'auditor', 'read_only']);
const ALLOWED_RESTRICTIONS = new Set([
    'deposits', 'withdrawals', 'gift_cards', 'virtual_cards',
    'transactions', 'login', 'payouts', 'trading'
]);

// ─── HELPERS ─────────────────────────────────────────────────────
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
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function fail(res, status, code, message, extra) {
    if (res.headersSent) return;
    res.status(status).json({ success: false, error: message, code, ...(extra || {}) });
}

function invalidateAdminCache(pattern = '*') {
    try {
        if (typeof global.__adminCacheInvalidate === 'function') {
            global.__adminCacheInvalidate(pattern);
        }
    } catch (_) {}
}

async function loadProfileOr404(id, res) {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error || !data) {
        fail(res, 404, 'USER_NOT_FOUND', 'User not found');
        return null;
    }
    return data;
}

// ═════════════════════════════════════════════════════════════════
//  LIST ROUTES (must come BEFORE /:id)
// ═════════════════════════════════════════════════════════════════

// ─── GET /api/admin/users ────────────────────────────────────────
router.get('/users',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const page = parsePage(req.query.page);
            const limit = parseLimit(req.query.limit);
            const offset = (page - 1) * limit;
            const search = String(req.query.search || '').trim();
            const status = String(req.query.status || '').trim();
            const role = String(req.query.role || '').trim();

            let query = supabaseAdmin
                .from('profiles')
                .select(
                    'id, username, email, phone, role, status, is_verified, two_factor_enabled, risk_level, wallet_ngn, wallet_usd, created_at, last_seen, last_login, last_location, avatar_url, referral_code, deleted_at',
                    { count: 'exact' }
                )
                .is('deleted_at', null)
                .order('created_at', { ascending: false });

            if (search) {
                const safe = search.replace(/[%_]/g, m => '\\' + m);
                query = query.or(`username.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%`);
            }
            if (status && status !== 'all') query = query.eq('status', status);
            if (role && role !== 'all') query = query.eq('role', role);

            query = query.range(offset, offset + limit - 1);

            const { data, error, count } = await query;
            if (error) {
                console.error('[ADMIN USERS] list error:', error.message);
                return fail(res, 500, 'USERS_LIST_ERROR', 'Failed to load users');
            }

            // Bulk attach restriction counts so the list can show a lock icon.
            const ids = (data || []).map(u => u.id);
            const restrictionsByUser = {};
            if (ids.length) {
                try {
                    const { data: rs } = await supabaseAdmin
                        .from('user_restrictions')
                        .select('user_id, restriction')
                        .in('user_id', ids)
                        .eq('is_active', true);
                    (rs || []).forEach(r => {
                        (restrictionsByUser[r.user_id] ||= []).push(r.restriction);
                    });
                } catch (_) {}
            }

            const users = (data || []).map(u => ({
                ...u,
                restrictions: restrictionsByUser[u.id] || []
            }));

            res.json({
                success: true,
                users,
                count: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) {
            console.error('[ADMIN USERS] list exception:', err);
            fail(res, 500, 'USERS_LIST_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── GET /api/admin/users/recent ─────────────────────────────────
router.get('/users/recent',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const limit = parseLimit(req.query.limit, 6, 50);
            const { data, error } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email, created_at, last_location, wallet_ngn, wallet_usd, is_verified, status, avatar_url, role')
                .is('deleted_at', null)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) return fail(res, 500, 'USERS_RECENT_ERROR', 'Failed to load recent users');

            const ids = (data || []).map(u => u.id);
            const presenceMap = {};
            if (ids.length) {
                try {
                    const { data: pres } = await supabaseAdmin
                        .from('user_presence')
                        .select('user_id, last_seen, is_online, current_page')
                        .in('user_id', ids);
                    (pres || []).forEach(p => { presenceMap[p.user_id] = p; });
                } catch (_) {}
            }

            const now = Date.now();
            const users = (data || []).map(u => {
                const p = presenceMap[u.id];
                const isOnline = !!(p?.is_online && p?.last_seen &&
                    (now - new Date(p.last_seen).getTime()) < 30_000);
                return {
                    id: u.id,
                    username: u.username || (u.email ? u.email.split('@')[0] : 'User'),
                    email: u.email || '',
                    role: u.role || 'user',
                    created_at: u.created_at,
                    last_location: u.last_location || 'N/A',
                    wallet_ngn: num(u.wallet_ngn),
                    wallet_usd: num(u.wallet_usd),
                    is_verified: !!u.is_verified,
                    status: u.status || 'active',
                    avatar_url: u.avatar_url || null,
                    is_online: isOnline,
                    current_page: p?.current_page || null,
                    last_seen: p?.last_seen || u.created_at
                };
            });

            res.json({ success: true, data: users });
        } catch (err) {
            console.error('[ADMIN USERS] recent exception:', err);
            fail(res, 500, 'USERS_RECENT_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── GET /api/admin/users/stats ──────────────────────────────────
router.get('/users/stats',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);
            const weekAgo = new Date(Date.now() - 7 * 86400000);

            const [totalRes, activeRes, suspendedRes, verifiedRes, todayRes, weekRes] = await Promise.all([
                supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).is('deleted_at', null),
                supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'active').is('deleted_at', null),
                supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'suspended').is('deleted_at', null),
                supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('is_verified', true).is('deleted_at', null),
                supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', startOfToday.toISOString()).is('deleted_at', null),
                supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo.toISOString()).is('deleted_at', null)
            ]);

            // Wallet liability from the ledger (source of truth).
            let walletNgn = null, walletUsd = null;
            try {
                const { data: ledgers, error: ledgerErr } = await supabaseAdmin
                    .from('ledger_accounts')
                    .select('currency, available_balance')
                    .in('currency', ['NGN', 'USD']);
                if (!ledgerErr) {
                    let ngnCents = 0n, usdCents = 0n;
                    for (const row of ledgers || []) {
                        const cents = BigInt(Math.round(Number(row.available_balance) * 100));
                        if (row.currency === 'NGN') ngnCents += cents;
                        else if (row.currency === 'USD') usdCents += cents;
                    }
                    walletNgn = Number(ngnCents) / 100;
                    walletUsd = Number(usdCents) / 100;
                }
            } catch (_) {}

            // Fallback to profile mirror only if ledger is unavailable.
            if (walletNgn === null || walletUsd === null) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles').select('wallet_ngn, wallet_usd').is('deleted_at', null);
                let n = 0, u = 0;
                for (const p of profiles || []) { n += num(p.wallet_ngn); u += num(p.wallet_usd); }
                walletNgn = n; walletUsd = u;
            }

            res.json({
                success: true,
                stats: {
                    total: totalRes.count || 0,
                    active: activeRes.count || 0,
                    suspended: suspendedRes.count || 0,
                    verified: verifiedRes.count || 0,
                    newToday: todayRes.count || 0,
                    newThisWeek: weekRes.count || 0,
                    wallet_ngn: walletNgn,
                    wallet_usd: walletUsd
                }
            });
        } catch (err) {
            console.error('[ADMIN USERS] stats exception:', err);
            fail(res, 500, 'USERS_STATS_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── GET /api/admin/users/:id/detail ─────────────────────────────
// Rich view for the dashboard user drawer. Placed BEFORE /users/:id.
router.get('/users/:id/detail',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const { id } = req.params;
            const user = await loadProfileOr404(id, res);
            if (!user) return;

            let wallet = { ngn: null, usd: null, cashback: null };
            try {
                const balances = await LedgerService.getAllBalances(id);
                wallet.ngn = balances.NGN ?? 0;
                wallet.usd = balances.USD ?? 0;
                wallet.cashback = balances.CASHBACK ?? 0;
            } catch (e) {
                console.warn('[ADMIN USERS] ledger lookup failed:', e.message);
            }

            const { data: recentTx } = await supabaseAdmin
                .from('transactions')
                .select('id, type, status, currency, amount, description, ref, reference, created_at')
                .eq('user_id', id)
                .order('created_at', { ascending: false })
                .limit(10);

            let sessions = [];
            try {
                const { data: sess } = await supabaseAdmin
                    .from('user_sessions')
                    .select('id, device_type, browser, os, created_at, is_active, revoked_at')
                    .eq('user_id', id)
                    .order('created_at', { ascending: false })
                    .limit(5);
                sessions = sess || [];
            } catch (_) {}

            let presence = null;
            try {
                const { data: p } = await supabaseAdmin
                    .from('user_presence')
                    .select('last_seen, is_online, current_page, browser, os, device_type, ip_address')
                    .eq('user_id', id)
                    .maybeSingle();
                presence = p || null;
            } catch (_) {}

            // Aggregate stats via RPC (single DB round-trip).
            let stats = {
                total_transactions: 0,
                completed: 0, pending: 0, failed: 0,
                total_deposited_ngn: 0, total_deposited_usd: 0
            };
            try {
                const { data: statRow, error: statErr } = await supabaseAdmin
                    .rpc('admin_user_tx_stats', { p_user_id: id });
                if (!statErr) {
                    const row = Array.isArray(statRow) ? statRow[0] : statRow;
                    stats = {
                        total_transactions: Number(row?.total_count || 0),
                        completed: Number(row?.completed_count || 0),
                        pending: Number(row?.pending_count || 0),
                        failed: Number(row?.failed_count || 0),
                        total_deposited_ngn: Number(row?.deposited_ngn || 0),
                        total_deposited_usd: Number(row?.deposited_usd || 0)
                    };
                }
            } catch (_) {}

            res.json({
                success: true,
                data: {
                    user: {
                        ...user,
                        wallet_ngn: wallet.ngn ?? num(user.wallet_ngn),
                        wallet_usd: wallet.usd ?? num(user.wallet_usd)
                    },
                    wallet, presence, stats,
                    recent_transactions: recentTx || [],
                    sessions
                }
            });
        } catch (err) {
            console.error('[ADMIN USERS] detail exception:', err);
            fail(res, 500, 'USER_DETAIL_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── GET /api/admin/users/:id/overview ───────────────────────────
router.get('/users/:id/overview',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const { id } = req.params;
            const user = await loadProfileOr404(id, res);
            if (!user) return;

            let restrictions = [];
            try {
                const { data: rs } = await supabaseAdmin
                    .from('user_restrictions')
                    .select('id, restriction, reason, imposed_at, imposed_by')
                    .eq('user_id', id)
                    .eq('is_active', true);
                restrictions = rs || [];
            } catch (_) {}

            let wallet = { ngn: null, usd: null, cashback: null };
            try {
                const b = await LedgerService.getAllBalances(id);
                wallet.ngn = b.NGN ?? 0;
                wallet.usd = b.USD ?? 0;
                wallet.cashback = b.CASHBACK ?? 0;
            } catch (_) {}

            let pendingDeposits = 0, pendingWithdrawals = 0, activeSessions = 0, openTickets = 0;
            try {
                const { count } = await supabaseAdmin
                    .from('transactions')
                    .select('id', { count: 'exact', head: true })
                    .eq('user_id', id).eq('type', 'deposit').in('status', ['pending', 'processing']);
                pendingDeposits = count || 0;
            } catch (_) {}
            try {
                const { count } = await supabaseAdmin
                    .from('transactions')
                    .select('id', { count: 'exact', head: true })
                    .eq('user_id', id).eq('type', 'withdrawal').in('status', ['pending', 'processing']);
                pendingWithdrawals = count || 0;
            } catch (_) {}
            try {
                const { count } = await supabaseAdmin
                    .from('user_sessions')
                    .select('id', { count: 'exact', head: true })
                    .eq('user_id', id).eq('is_active', true).is('revoked_at', null);
                activeSessions = count || 0;
            } catch (_) {}
            try {
                const { count } = await supabaseAdmin
                    .from('support_tickets')
                    .select('id', { count: 'exact', head: true })
                    .eq('user_id', id).in('status', ['open', 'in_progress']);
                openTickets = count || 0;
            } catch (_) {}

            res.json({
                success: true,
                data: {
                    profile: {
                        id: user.id,
                        username: user.username,
                        email: user.email,
                        phone: user.phone,
                        role: user.role,
                        status: user.status,
                        is_verified: !!user.is_verified,
                        two_factor_enabled: user.two_factor_enabled ?? false,
                        risk_level: user.risk_level ?? null,
                        kyc_status: null,               // not tracked yet — honest null
                        referral_code: user.referral_code,
                        created_at: user.created_at,
                        last_login: user.last_login,
                        last_seen: user.last_seen,
                        last_location: user.last_location,
                        avatar_url: user.avatar_url,
                        login_count: user.login_count || 0
                    },
                    wallet,
                    restrictions,
                    pending: { deposits: pendingDeposits, withdrawals: pendingWithdrawals },
                    sessions_active: activeSessions,
                    support_open: openTickets
                }
            });
        } catch (err) {
            console.error('[ADMIN USERS] overview exception:', err);
            fail(res, 500, 'USER_OVERVIEW_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── GET /api/admin/users/:id/wallets ────────────────────────────
router.get('/users/:id/wallets',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const { id } = req.params;
            const wallets = {
                NGN: { available: null, held: null },
                USD: { available: null, held: null },
                CASHBACK: { available: null, held: null }
            };

            try {
                const { data } = await supabaseAdmin
                    .from('ledger_accounts')
                    .select('currency, available_balance, held_balance')
                    .eq('user_id', id);
                for (const row of data || []) {
                    if (wallets[row.currency]) {
                        wallets[row.currency].available = num(row.available_balance);
                        wallets[row.currency].held = num(row.held_balance);
                    }
                }
            } catch (_) {}

            let pendingDepositsNgn = 0, pendingDepositsUsd = 0;
            try {
                const { data: pd } = await supabaseAdmin
                    .from('transactions')
                    .select('currency, amount')
                    .eq('user_id', id).eq('type', 'deposit')
                    .in('status', ['pending', 'processing']);
                for (const r of pd || []) {
                    if (String(r.currency).toUpperCase() === 'USD') pendingDepositsUsd += num(r.amount);
                    else pendingDepositsNgn += num(r.amount);
                }
            } catch (_) {}

            res.json({
                success: true,
                data: {
                    wallets,
                    pending: { deposits_ngn: pendingDepositsNgn, deposits_usd: pendingDepositsUsd },
                    source: 'ledger_accounts'
                }
            });
        } catch (err) {
            fail(res, 500, 'USER_WALLETS_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── GET /api/admin/users/:id/ledger ─────────────────────────────
router.get('/users/:id/ledger',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const { id } = req.params;
            const limit = parseLimit(req.query.limit, 50, 200);
            const page = parsePage(req.query.page);
            const offset = (page - 1) * limit;
            const currency = String(req.query.currency || '').toUpperCase();
            const entryType = String(req.query.entry_type || '').toUpperCase();

            const { data: accounts } = await supabaseAdmin
                .from('ledger_accounts')
                .select('id, currency')
                .eq('user_id', id);

            if (!accounts || !accounts.length) {
                return res.json({ success: true, data: [], count: 0, page, limit, totalPages: 0 });
            }

            const accountIds = accounts
                .filter(a => !currency || a.currency === currency)
                .map(a => a.id);

            if (!accountIds.length) {
                return res.json({ success: true, data: [], count: 0, page, limit, totalPages: 0 });
            }

            let query = supabaseAdmin
                .from('ledger_entries')
                .select('*', { count: 'exact' })
                .in('account_id', accountIds)
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (entryType === 'CREDIT' || entryType === 'DEBIT') {
                query = query.eq('entry_type', entryType);
            }

            const { data, error, count } = await query;
            if (error) {
                if (error.code === '42P01') {
                    return res.json({ success: true, data: [], count: 0, page, limit, totalPages: 0, note: 'ledger_entries table not present' });
                }
                return fail(res, 500, 'LEDGER_QUERY_ERROR', 'Failed to load ledger');
            }

            res.json({
                success: true,
                data: data || [],
                count: count || 0,
                page, limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) {
            console.error('[ADMIN USERS] ledger exception:', err);
            fail(res, 500, 'LEDGER_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── GET /api/admin/users/:id/transactions ───────────────────────
router.get('/users/:id/transactions',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const { id } = req.params;
            const limit = parseLimit(req.query.limit, 30, 200);
            const page = parsePage(req.query.page);
            const offset = (page - 1) * limit;

            const type = String(req.query.type || '').trim();
            const status = String(req.query.status || '').trim();
            const currency = String(req.query.currency || '').toUpperCase();

            let query = supabaseAdmin
                .from('transactions')
                .select('id, type, status, currency, amount, fee, revenue_ngn, revenue_usd, description, ref, reference, provider, provider_reference, source_type, source_id, meta, metadata, created_at, completed_at, failed_at, failure_reason', { count: 'exact' })
                .eq('user_id', id)
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (type) query = query.eq('type', type);
            if (status) query = query.eq('status', status);
            if (currency) query = query.eq('currency', currency);

            const { data, error, count } = await query;
            if (error) return fail(res, 500, 'TRANSACTIONS_QUERY_ERROR', 'Failed to load transactions');

            res.json({
                success: true,
                data: data || [],
                count: count || 0,
                page, limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) {
            console.error('[ADMIN USERS] transactions exception:', err);
            fail(res, 500, 'TRANSACTIONS_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── GET /api/admin/users/:id/security ───────────────────────────
router.get('/users/:id/security',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const { id } = req.params;
            const limit = parseLimit(req.query.limit, 30, 100);

            let sessions = [];
            try {
                const { data } = await supabaseAdmin
                    .from('user_sessions')
                    .select('id, session_id, device_name, device_type, browser, os, ip, ip_address, location, created_at, last_activity_at, expires_at, revoked_at, is_active, is_current, user_agent')
                    .eq('user_id', id)
                    .order('created_at', { ascending: false })
                    .limit(limit);
                sessions = data || [];
            } catch (_) {}

            const loginEvents = sessions.map(s => ({
                id: s.id,
                session_id: s.session_id,
                created_at: s.created_at,
                last_activity_at: s.last_activity_at,
                expires_at: s.expires_at,
                revoked_at: s.revoked_at,
                is_active: s.is_active,
                is_current: s.is_current,
                ip: s.ip || s.ip_address || null,
                location: s.location || null,
                device_name: s.device_name || null,
                device_type: s.device_type || null,
                browser: s.browser || null,
                os: s.os || null,
                user_agent: s.user_agent || null
            }));

            const active = loginEvents.filter(s => s.is_active && !s.revoked_at);

            res.json({
                success: true,
                data: {
                    sessions: loginEvents,
                    active_sessions: active,
                    failed_logins: null,
                    failed_logins_available: false,
                    note: 'Failed login attempts are not currently logged in this system.'
                }
            });
        } catch (err) {
            console.error('[ADMIN USERS] security exception:', err);
            fail(res, 500, 'SECURITY_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── GET /api/admin/users/:id/support ────────────────────────────
router.get('/users/:id/support',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const { id } = req.params;
            let tickets = [];
            try {
                const { data } = await supabaseAdmin
                    .from('support_tickets')
                    .select('id, title, status, priority, created_at, updated_at, assigned_to, last_message')
                    .eq('user_id', id)
                    .order('created_at', { ascending: false })
                    .limit(50);
                tickets = data || [];
            } catch (_) {
                return res.json({ success: true, data: [], note: 'support_tickets table not present' });
            }
            res.json({ success: true, data: tickets });
        } catch (err) {
            fail(res, 500, 'SUPPORT_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── GET /api/admin/users/:id/notes ──────────────────────────────
router.get('/users/:id/notes',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const { id } = req.params;
            let notes = [];
            try {
                const { data } = await supabaseAdmin
                    .from('admin_user_notes')
                    .select('id, author_id, body, tags, created_at')
                    .eq('user_id', id)
                    .order('created_at', { ascending: false })
                    .limit(200);
                notes = data || [];
            } catch (_) {}
            res.json({ success: true, data: notes });
        } catch (err) {
            fail(res, 500, 'NOTES_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── POST /api/admin/users/:id/notes ─────────────────────────────
router.post('/users/:id/notes',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const body = String(req.body?.body || '').trim();
            const tags = Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 10) : [];

            if (body.length < 3) return fail(res, 422, 'BODY_REQUIRED', 'Note body required (min 3 chars)');
            if (body.length > 4000) return fail(res, 422, 'BODY_TOO_LONG', 'Note max 4000 chars');

            const user = await loadProfileOr404(id, res);
            if (!user) return;

            const { data: note, error } = await supabaseAdmin
                .from('admin_user_notes')
                .insert({ user_id: id, author_id: req.adminContext.id, body, tags })
                .select()
                .single();
            if (error) return fail(res, 500, 'NOTE_INSERT_ERROR', 'Failed to save note');

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.note_added',
                targetType: 'profile',
                targetId: id,
                after: { note_id: note.id, tags },
                reason: 'internal note',
                req
            });

            res.json({ success: true, data: note });
        } catch (err) {
            fail(res, 500, 'NOTE_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── POST /api/admin/users/:id/restrictions ──────────────────────
router.post('/users/:id/restrictions',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const restriction = String(req.body?.restriction || '').toLowerCase();
            const reason = String(req.body?.reason || '').trim();

            if (!ALLOWED_RESTRICTIONS.has(restriction)) {
                return fail(res, 422, 'INVALID_RESTRICTION', `Restriction must be one of: ${[...ALLOWED_RESTRICTIONS].join(', ')}`);
            }
            if (reason.length < 4) return fail(res, 422, 'REASON_REQUIRED', 'Reason required (min 4 chars)');

            const user = await loadProfileOr404(id, res);
            if (!user) return;

            const { data: existing } = await supabaseAdmin
                .from('user_restrictions')
                .select('id')
                .eq('user_id', id)
                .eq('restriction', restriction)
                .eq('is_active', true)
                .maybeSingle();
            if (existing) {
                return fail(res, 409, 'RESTRICTION_ALREADY_ACTIVE', 'This restriction is already active');
            }

            const { data: created, error } = await supabaseAdmin
                .from('user_restrictions')
                .insert({ user_id: id, restriction, is_active: true, reason, imposed_by: req.adminContext.id })
                .select()
                .single();
            if (error) return fail(res, 500, 'RESTRICTION_INSERT_ERROR', 'Failed to add restriction');

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.restriction_added',
                targetType: 'profile',
                targetId: id,
                after: { restriction, reason },
                reason,
                req
            });

            res.json({ success: true, data: created });
        } catch (err) {
            fail(res, 500, 'RESTRICTION_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── DELETE /api/admin/users/:id/restrictions/:restriction ───────
router.delete('/users/:id/restrictions/:restriction',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const { id, restriction } = req.params;
            const reason = String(req.body?.reason || req.query?.reason || '').trim();

            if (!ALLOWED_RESTRICTIONS.has(restriction.toLowerCase())) {
                return fail(res, 422, 'INVALID_RESTRICTION', 'Unknown restriction');
            }
            if (reason.length < 4) return fail(res, 422, 'REASON_REQUIRED', 'Reason required (min 4 chars)');

            const { data: updated, error } = await supabaseAdmin
                .from('user_restrictions')
                .update({
                    is_active: false,
                    lifted_at: new Date().toISOString(),
                    lifted_by: req.adminContext.id,
                    lifted_reason: reason
                })
                .eq('user_id', id)
                .eq('restriction', restriction.toLowerCase())
                .eq('is_active', true)
                .select()
                .maybeSingle();

            if (error) return fail(res, 500, 'RESTRICTION_UPDATE_ERROR', 'Failed to remove restriction');
            if (!updated) return fail(res, 404, 'RESTRICTION_NOT_FOUND', 'No active restriction found');

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.restriction_lifted',
                targetType: 'profile',
                targetId: id,
                after: { restriction: restriction.toLowerCase(), reason },
                reason,
                req
            });

            res.json({ success: true, data: updated });
        } catch (err) {
            fail(res, 500, 'RESTRICTION_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── POST /api/admin/users/:id/force-logout ──────────────────────
router.post('/users/:id/force-logout',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) return fail(res, 422, 'REASON_REQUIRED', 'Reason required (min 4 chars)');

            const now = new Date().toISOString();
            const { data: revoked, error } = await supabaseAdmin
                .from('user_sessions')
                .update({ is_active: false, revoked_at: now, revoked_reason: `admin force-logout: ${reason}` })
                .eq('user_id', id)
                .eq('is_active', true)
                .select('id');
            if (error) return fail(res, 500, 'FORCE_LOGOUT_ERROR', 'Failed to revoke sessions');

            try {
                await supabaseAdmin
                    .from('profiles')
                    .update({ current_session_id: null, session_expires_at: null })
                    .eq('id', id);
            } catch (_) {}

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.force_logout',
                targetType: 'profile',
                targetId: id,
                after: { sessions_revoked: (revoked || []).length },
                reason,
                req
            });

            res.json({ success: true, revoked: (revoked || []).length });
        } catch (err) {
            fail(res, 500, 'FORCE_LOGOUT_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── POST /api/admin/users/:id/require-password-reset ────────────
router.post('/users/:id/require-password-reset',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) return fail(res, 422, 'REASON_REQUIRED', 'Reason required (min 4 chars)');

            const { error } = await supabaseAdmin
                .from('profiles')
                .update({ password_hash: null, updated_at: new Date().toISOString() })
                .eq('id', id);
            if (error) return fail(res, 500, 'PASSWORD_RESET_ERROR', 'Failed to require reset');

            try {
                await supabaseAdmin
                    .from('user_sessions')
                    .update({ is_active: false, revoked_at: new Date().toISOString(), revoked_reason: 'admin required password reset' })
                    .eq('user_id', id)
                    .eq('is_active', true);
            } catch (_) {}

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.require_password_reset',
                targetType: 'profile',
                targetId: id,
                reason,
                req
            });

            res.json({ success: true });
        } catch (err) {
            fail(res, 500, 'PASSWORD_RESET_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── POST /api/admin/users/:id/require-2fa ───────────────────────
router.post('/users/:id/require-2fa',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) return fail(res, 422, 'REASON_REQUIRED', 'Reason required (min 4 chars)');

            const { error } = await supabaseAdmin
                .from('profiles')
                .update({ two_factor_enabled: false, updated_at: new Date().toISOString() })
                .eq('id', id);
            if (error) return fail(res, 500, 'TWOFA_ERROR', 'Failed to require 2FA');

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.require_2fa',
                targetType: 'profile',
                targetId: id,
                reason,
                req
            });

            res.json({ success: true });
        } catch (err) {
            fail(res, 500, 'TWOFA_EXCEPTION', 'Unexpected error');
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  SINGLE USER ROUTES (after list routes)
// ═════════════════════════════════════════════════════════════════

router.get('/users/:id',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const { id } = req.params;
            const user = await loadProfileOr404(id, res);
            if (!user) return;

            const counts = { transactions: 0, campaigns: 0, giftOrders: 0, boostOrders: 0, smsOrders: 0 };
            const tables = [
                ['transactions', 'transactions'],
                ['campaigns', 'campaigns'],
                ['gift_orders', 'giftOrders'],
                ['boost_orders', 'boostOrders'],
                ['sms_orders', 'smsOrders']
            ];
            await Promise.all(tables.map(async ([table, key]) => {
                try {
                    const { count } = await supabaseAdmin
                        .from(table).select('id', { count: 'exact', head: true }).eq('user_id', id);
                    counts[key] = count || 0;
                } catch (_) {}
            }));

            res.json({ success: true, user, stats: counts });
        } catch (err) {
            console.error('[ADMIN USERS] get exception:', err);
            fail(res, 500, 'USER_GET_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── PUT /api/admin/users/:id ────────────────────────────────────
router.put('/users/:id',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const body = req.body || {};

            const { data: existing, error: getErr } = await supabaseAdmin
                .from('profiles')
                .select('id, username, phone, status, is_verified, role')
                .eq('id', id)
                .single();
            if (getErr || !existing) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');

            const updateData = {};
            const before = {};
            const after = {};
            const assign = (field, value) => { updateData[field] = value; before[field] = existing[field]; after[field] = value; };

            if (body.username !== undefined) {
                const v = String(body.username).trim();
                if (v.length < 3 || v.length > 40) return fail(res, 422, 'INVALID_USERNAME', 'Username must be 3–40 characters');
                assign('username', v);
            }
            if (body.phone !== undefined) assign('phone', String(body.phone).trim().slice(0, 30));
            if (body.is_verified !== undefined) assign('is_verified', !!body.is_verified);
            if (body.status !== undefined) {
                const s = String(body.status).toLowerCase();
                if (!ALLOWED_STATUS.has(s)) return fail(res, 422, 'INVALID_STATUS', `Status must be one of: ${[...ALLOWED_STATUS].join(', ')}`);
                assign('status', s);
            }
            if (body.role !== undefined) {
                const r = String(body.role).toLowerCase();
                if (!ALLOWED_ROLES.has(r)) return fail(res, 422, 'INVALID_ROLE', `Role must be one of: ${[...ALLOWED_ROLES].join(', ')}`);
                if (!req.adminContext?.isSuperAdmin) return fail(res, 403, 'ROLE_CHANGE_FORBIDDEN', 'Only super admins can change roles');
                assign('role', r);
            }

            if (Object.keys(updateData).length === 0) return fail(res, 422, 'NO_CHANGES', 'No valid fields supplied');
            updateData.updated_at = new Date().toISOString();

            const { data: updated, error: updateErr } = await supabaseAdmin
                .from('profiles').update(updateData).eq('id', id).select().single();
            if (updateErr) return fail(res, 500, 'USER_UPDATE_ERROR', 'Failed to update user');

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.update',
                targetType: 'profile',
                targetId: id,
                before, after,
                reason: body.reason || null,
                req
            });

            invalidateAdminCache('users');
            res.json({ success: true, user: updated });
        } catch (err) {
            fail(res, 500, 'USER_UPDATE_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── PUT /api/admin/users/:id/status ─────────────────────────────
router.put('/users/:id/status',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const s = String(req.body?.status || '').toLowerCase();
            if (!ALLOWED_STATUS.has(s)) return fail(res, 422, 'INVALID_STATUS', 'Invalid status');

            const { data: existing } = await supabaseAdmin.from('profiles').select('id, status').eq('id', id).single();
            if (!existing) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');

            const { data: user, error } = await supabaseAdmin
                .from('profiles').update({ status: s, updated_at: new Date().toISOString() }).eq('id', id).select().single();
            if (error) return fail(res, 500, 'STATUS_UPDATE_ERROR', 'Failed to update status');

            try {
                await supabaseAdmin.from('notifications').insert({
                    user_id: id,
                    title: s === 'suspended' ? 'Account Suspended' : s === 'banned' ? 'Account Banned' : 'Account Activated',
                    message: s === 'suspended' ? 'Your account has been suspended.'
                        : s === 'banned' ? 'Your account has been banned.'
                        : 'Your account has been reactivated.',
                    type: s === 'active' ? 'success' : 'warning',
                    icon: s === 'active' ? '✅' : '⚠️',
                    is_read: false,
                    created_at: new Date().toISOString()
                });
            } catch (_) {}

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.status_change',
                targetType: 'profile',
                targetId: id,
                before: { status: existing.status },
                after: { status: s },
                reason: req.body?.reason || null,
                req
            });

            invalidateAdminCache('users');
            res.json({ success: true, user, message: `User ${s}` });
        } catch (err) {
            fail(res, 500, 'STATUS_UPDATE_EXCEPTION', 'Unexpected error');
        }
    }
);

// ─── POST /api/admin/users/:id/wallet ────────────────────────────
router.post('/users/:id/wallet',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    async (req, res) => {
        try {
            const { id } = req.params;
            const body = req.body || {};
            const currency = String(body.currency || '').toUpperCase();
            const amount = Number(body.amount);
            const reason = String(body.reason || '').trim();

            if (!ALLOWED_CURRENCIES.has(currency)) return fail(res, 422, 'INVALID_CURRENCY', 'Currency must be NGN or USD');
            if (!Number.isFinite(amount) || amount === 0) return fail(res, 422, 'INVALID_AMOUNT', 'Non-zero amount required');
            if (Math.abs(amount) > MAX_WALLET_ADJUSTMENT) return fail(res, 422, 'AMOUNT_TOO_LARGE', 'Amount too large');
            if (reason.length < 4) return fail(res, 422, 'REASON_REQUIRED', 'Reason required (min 4 chars)');

            const user = await loadProfileOr404(id, res);
            if (!user) return;

            const exceedsThreshold = Math.abs(amount) >= APPROVAL_THRESHOLD;
            const requiresApproval = exceedsThreshold && !req.adminContext?.isSuperAdmin;

            if (requiresApproval) {
                const { data: approval, error: apErr } = await supabaseAdmin
                    .from('admin_approvals')
                    .insert({
                        action: 'wallet_adjustment',
                        target_type: 'profile',
                        target_id: id,
                        requested_by: req.adminContext.id,
                        payload: { currency, amount, direction: amount > 0 ? 'credit' : 'debit', reason },
                        status: 'pending'
                    })
                    .select()
                    .single();
                if (apErr) return fail(res, 500, 'APPROVAL_CREATE_ERROR', 'Failed to create approval request');

                await recordAdminAction({
                    adminId: req.adminContext.id,
                    action: 'wallet.adjustment_pending_approval',
                    targetType: 'profile',
                    targetId: id,
                    after: { approval_id: approval.id, amount, currency },
                    reason,
                    req
                });

                return res.status(202).json({
                    success: true,
                    pending_approval: true,
                    approval_id: approval.id,
                    message: `Adjustment above ${APPROVAL_THRESHOLD} ${currency} requires a second approver.`
                });
            }

            // Ledger operation — the ledger is the source of truth.
            const isCredit = amount > 0;
            const absAmount = Math.abs(amount);
            const reference = `ADMIN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

            let ledgerResult;
            try {
                const commonArgs = {
                    userId: id,
                    amount: absAmount,
                    currency,
                    description: `Admin ${isCredit ? 'credit' : 'debit'} (${reason})`,
                    reference,
                    sourceType: 'admin_adjustment',
                    sourceId: req.adminContext.id,
                    metadata: { admin_id: req.adminContext.id, admin_email: req.adminContext.email, reason },
                    type: 'admin_adjustment'
                };
                ledgerResult = isCredit
                    ? await LedgerService.creditWallet(commonArgs)
                    : await LedgerService.debitWallet(commonArgs);
            } catch (ledgerErr) {
                return fail(res, 400, 'LEDGER_ADJUSTMENT_FAILED', ledgerErr.message || 'Ledger rejected adjustment');
            }

            const mirrorField = currency === 'USD' ? 'wallet_usd' : 'wallet_ngn';
            const newBalance = ledgerResult.balance_after ?? null;
            try {
                if (newBalance !== null) {
                    await supabaseAdmin.from('profiles')
                        .update({ [mirrorField]: newBalance, updated_at: new Date().toISOString() })
                        .eq('id', id);
                }
            } catch (_) {}

            try {
                await supabaseAdmin.from('notifications').insert({
                    user_id: id,
                    title: isCredit ? 'Wallet Funded' : 'Wallet Debited',
                    message: `${isCredit ? 'Added' : 'Removed'} ${absAmount} ${currency} (${reason})`,
                    type: isCredit ? 'success' : 'warning',
                    icon: isCredit ? '💰' : '📤',
                    is_read: false,
                    created_at: new Date().toISOString()
                });
            } catch (_) {}

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: isCredit ? 'wallet.credit' : 'wallet.debit',
                targetType: 'profile',
                targetId: id,
                before: { currency, balance: ledgerResult.balance_before ?? null },
                after: { currency, balance: newBalance, delta: amount },
                reason,
                req
            });

            invalidateAdminCache('users');
            invalidateAdminCache('ledger');

            res.json({
                success: true,
                currency, amount,
                new_balance: newBalance,
                ledger: {
                    transaction_id: ledgerResult.transaction_id,
                    reference: ledgerResult.reference,
                    balance_before: ledgerResult.balance_before,
                    balance_after: ledgerResult.balance_after
                },
                message: `Wallet ${isCredit ? 'funded' : 'debited'} successfully`
            });
        } catch (err) {
            console.error('[ADMIN USERS] wallet exception:', err);
            fail(res, 500, 'WALLET_ADJUST_EXCEPTION', 'Unexpected error');
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  APPROVALS QUEUE
// ═════════════════════════════════════════════════════════════════

router.get('/approvals',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    async (req, res) => {
        try {
            const status = String(req.query.status || 'pending').toLowerCase();
            const limit = parseLimit(req.query.limit, 50, 100);
            const { data, error } = await supabaseAdmin
                .from('admin_approvals')
                .select('*')
                .eq('status', status)
                .order('requested_at', { ascending: false })
                .limit(limit);
            if (error) {
                if (error.code === '42P01') return res.json({ success: true, data: [] });
                return fail(res, 500, 'APPROVALS_ERROR', 'Failed to load approvals');
            }
            res.json({ success: true, data: data || [] });
        } catch (err) {
            fail(res, 500, 'APPROVALS_EXCEPTION', 'Unexpected error');
        }
    }
);

router.post('/approvals/:id/approve',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    async (req, res) => {
        try {
            const { id } = req.params;
            const reason = String(req.body?.reason || '').trim();

            const { data: approval } = await supabaseAdmin
                .from('admin_approvals')
                .select('*')
                .eq('id', id)
                .eq('status', 'pending')
                .maybeSingle();
            if (!approval) return fail(res, 404, 'APPROVAL_NOT_FOUND', 'Pending approval not found');
            if (approval.requested_by === req.adminContext.id && !req.adminContext?.isSuperAdmin) {
                return fail(res, 403, 'SELF_APPROVAL_FORBIDDEN', 'Second approver must differ from requester');
            }

            const payload = approval.payload || {};
            const amount = Number(payload.amount);
            const currency = String(payload.currency || '').toUpperCase();
            const isCredit = amount > 0;
            if (!ALLOWED_CURRENCIES.has(currency) || !Number.isFinite(amount) || amount === 0) {
                return fail(res, 422, 'INVALID_PAYLOAD', 'Approval payload is invalid');
            }

            const absAmount = Math.abs(amount);
            const reference = `ADMIN-APV-${approval.id.slice(0, 8)}`;
            const idempotencyKey = `admin-approval-${approval.id}`;

            let ledgerResult;
            try {
                const commonArgs = {
                    userId: approval.target_id,
                    amount: absAmount,
                    currency,
                    description: `Admin approval ${isCredit ? 'credit' : 'debit'} (${payload.reason || 'approved'})`,
                    reference,
                    sourceType: 'admin_adjustment',
                    sourceId: req.adminContext.id,
                    metadata: {
                        admin_id: req.adminContext.id,
                        approval_id: approval.id,
                        requested_by: approval.requested_by,
                        reason: payload.reason
                    },
                    idempotencyKey,
                    type: 'admin_adjustment'
                };
                ledgerResult = isCredit
                    ? await LedgerService.creditWallet(commonArgs)
                    : await LedgerService.debitWallet(commonArgs);
            } catch (ledgerErr) {
                return fail(res, 400, 'LEDGER_APPROVAL_FAILED', ledgerErr.message || 'Ledger rejected');
            }

            const mirrorField = currency === 'USD' ? 'wallet_usd' : 'wallet_ngn';
            try {
                if (ledgerResult.balance_after != null) {
                    await supabaseAdmin.from('profiles')
                        .update({ [mirrorField]: ledgerResult.balance_after, updated_at: new Date().toISOString() })
                        .eq('id', approval.target_id);
                }
            } catch (_) {}

            await supabaseAdmin.from('admin_approvals')
                .update({
                    status: 'approved',
                    reviewed_by: req.adminContext.id,
                    reviewed_at: new Date().toISOString(),
                    review_reason: reason || null,
                    executed_at: new Date().toISOString(),
                    execution_result: { ledger_reference: ledgerResult.reference, ledger_transaction_id: ledgerResult.transaction_id },
                    execution_idempotency_key: idempotencyKey
                })
                .eq('id', id);

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'wallet.approval_executed',
                targetType: 'profile',
                targetId: approval.target_id,
                after: { approval_id: id, amount, currency },
                reason: reason || 'approved',
                req
            });

            res.json({ success: true, executed: true, ledger: ledgerResult });
        } catch (err) {
            fail(res, 500, 'APPROVAL_EXECUTE_EXCEPTION', 'Unexpected error');
        }
    }
);

router.post('/approvals/:id/reject',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    async (req, res) => {
        try {
            const { id } = req.params;
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) return fail(res, 422, 'REASON_REQUIRED', 'Reason required (min 4 chars)');

            const { data: updated, error } = await supabaseAdmin
                .from('admin_approvals')
                .update({
                    status: 'rejected',
                    reviewed_by: req.adminContext.id,
                    reviewed_at: new Date().toISOString(),
                    review_reason: reason
                })
                .eq('id', id)
                .eq('status', 'pending')
                .select()
                .maybeSingle();
            if (error) return fail(res, 500, 'APPROVAL_REJECT_ERROR', 'Failed to reject');
            if (!updated) return fail(res, 404, 'APPROVAL_NOT_FOUND', 'Pending approval not found');

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'wallet.approval_rejected',
                targetType: 'profile',
                targetId: updated.target_id,
                reason,
                req
            });

            res.json({ success: true, data: updated });
        } catch (err) {
            fail(res, 500, 'APPROVAL_REJECT_EXCEPTION', 'Unexpected error');
        }
    }
);

module.exports = router;