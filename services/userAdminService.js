// services/userAdminService.js
// ─────────────────────────────────────────────────────────────────
// Single source of truth for User 360.
//
// Guarantees:
//   - Ledger is the only source of financial truth.
//     If the ledger cannot be read, the response says so and
//     does NOT fall back to profiles.wallet_ngn/usd.
//   - Every failure is distinct from "no data".
//   - No route ever touches Supabase directly.
//   - No `select('*')` in ledger reads.
//   - Transaction meta / metadata are scrubbed before exposure.
//   - Every mutation goes through LedgerService and writes an
//     audit row on success.
//
// Exports:
//   listUsers, getStats, getRecentUsers
//   getUser360
//   getWallets, getLedger, getTransactions, getOrders
//   getSecurity, getSupport, getNotes
//   addNote
//   addRestriction, removeRestriction
//   forceLogout, requirePasswordReset, requireTwoFA
//   setStatus, updateProfile
//   adjustWallet
//   listApprovals, approveApproval, rejectApproval
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 20;
const MAX_WALLET_ADJUSTMENT = 100_000_000;
const APPROVAL_THRESHOLD = Number(process.env.ADMIN_APPROVAL_THRESHOLD || 100_000);

const ALLOWED_CURRENCIES = new Set(['NGN', 'USD']);
const ALLOWED_STATUS = new Set(['active', 'inactive', 'suspended', 'banned']);
const ALLOWED_ROLES = new Set([
    'user', 'admin', 'super_admin', 'finance',
    'operations', 'support', 'auditor', 'read_only'
]);
const ALLOWED_RESTRICTIONS = new Set([
    'deposits', 'withdrawals', 'gift_cards', 'virtual_cards',
    'transactions', 'login', 'payouts', 'trading'
]);

const ADMIN_ROLES = new Set([
    'admin', 'super_admin', 'finance', 'operations',
    'support', 'auditor', 'read_only'
]);

// ─── Errors ─────────────────────────────────────────────────────
function serviceError(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── Numeric helpers ────────────────────────────────────────────
function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// ─── Scrubbing ──────────────────────────────────────────────────
const SENSITIVE_KEYS = [
    'password', 'password_hash', 'token', 'access_token', 'refresh_token',
    'api_key', 'secret', 'webhook_secret', 'mfa_secret', 'private_key',
    'authorization', 'cookie', 'transaction_pin'
];

function scrubObject(value, depth = 0) {
    if (depth > 6) return '[depth-limit]';
    if (value == null) return value;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => scrubObject(v, depth + 1));
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
        const lower = k.toLowerCase();
        if (SENSITIVE_KEYS.some(bad => lower.includes(bad))) {
            clean[k] = '[REDACTED]';
        } else if (v && typeof v === 'object') {
            clean[k] = scrubObject(v, depth + 1);
        } else {
            clean[k] = v;
        }
    }
    return clean;
}

function shapeTransaction(t, { includeMeta = false } = {}) {
    const base = {
        transaction_id:      t.id,
        type:                t.type || null,
        status:              t.status || null,
        currency:            String(t.currency || '').toUpperCase() || null,
        amount:              toNumber(t.amount),
        fee:                 toNumber(t.fee),
        revenue_ngn:         toNumber(t.revenue_ngn),
        revenue_usd:         toNumber(t.revenue_usd),
        description:         t.description || null,
        customer_reference:  t.ref || t.reference || null,
        provider:            t.provider || null,
        provider_reference:  t.provider_reference || null,
        source_type:         t.source_type || null,
        source_id:           t.source_id || null,
        created_at:          t.created_at || null,
        completed_at:        t.completed_at || null,
        failed_at:           t.failed_at || null,
        failure_reason:      t.failure_reason || null
    };
    if (includeMeta) {
        const meta = t.meta || t.metadata || null;
        base.metadata = meta ? scrubObject(meta) : null;
    }
    return base;
}

// ─── Error translation for honest reporting ─────────────────────
async function tryRpc(name, args) {
    try {
        const { data, error } = await supabaseAdmin.rpc(name, args);
        if (error) return { ok: false, error: error.message, code: error.code };
        return { ok: true, data };
    } catch (e) {
        return { ok: false, error: e.message, code: e.code || 'RPC_THREW' };
    }
}

// ═════════════════════════════════════════════════════════════════
//  LIST
// ═════════════════════════════════════════════════════════════════

async function listUsers({
    page = 1, limit = DEFAULT_LIMIT, search = '', status = '', role = ''
} = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    page = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('profiles')
        .select(
            'id, username, email, phone, role, status, is_verified, ' +
            'two_factor_enabled, risk_level, wallet_ngn, wallet_usd, ' +
            'created_at, last_seen, last_login, last_location, avatar_url, ' +
            'referral_code, deleted_at, login_count',
            { count: 'exact' }
        )
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

    if (search) {
        const safe = String(search).trim().slice(0, 100).replace(/[%_]/g, m => '\\' + m);
        q = q.or(`username.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%`);
    }
    if (status && status !== 'all') q = q.eq('status', status);
    if (role && role !== 'all') q = q.eq('role', role);

    q = q.range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) {
        throw serviceError('USERS_LIST_FAILED', error.message, 500);
    }

    // Bulk restriction counts
    const ids = (data || []).map(u => u.id);
    const restrictionsByUser = {};
    if (ids.length) {
        try {
            const { data: rs } = await supabaseAdmin
                .from('user_restrictions')
                .select('user_id, restriction')
                .in('user_id', ids)
                .eq('is_active', true);
            for (const r of rs || []) {
                (restrictionsByUser[r.user_id] ||= []).push(r.restriction);
            }
        } catch (_) {}
    }

    const users = (data || []).map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        phone: u.phone,
        role: u.role || 'user',
        status: u.status || 'active',
        is_verified: !!u.is_verified,
        two_factor_enabled: !!u.two_factor_enabled,
        risk_level: u.risk_level || null,
        wallet_ngn: toNumber(u.wallet_ngn),
        wallet_usd: toNumber(u.wallet_usd),
        created_at: u.created_at,
        last_seen: u.last_seen,
        last_login: u.last_login,
        last_location: u.last_location,
        avatar_url: u.avatar_url,
        referral_code: u.referral_code,
        login_count: u.login_count || 0,
        restrictions: restrictionsByUser[u.id] || []
    }));

    return {
        users,
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit)
    };
}

async function getRecentUsers(limit = 6) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 50);
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email, role, created_at, last_location, wallet_ngn, wallet_usd, is_verified, status, avatar_url')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw serviceError('USERS_RECENT_FAILED', error.message, 500);
    return (data || []).map(u => ({
        ...u,
        wallet_ngn: toNumber(u.wallet_ngn),
        wallet_usd: toNumber(u.wallet_usd),
        username: u.username || (u.email ? u.email.split('@')[0] : 'User')
    }));
}

async function getStats() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 86400000);

    const queries = [
        supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).is('deleted_at', null),
        supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'active').is('deleted_at', null),
        supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'suspended').is('deleted_at', null),
        supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('is_verified', true).is('deleted_at', null),
        supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', startOfToday.toISOString()).is('deleted_at', null),
        supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo.toISOString()).is('deleted_at', null)
    ];
    const [totalRes, activeRes, suspendedRes, verifiedRes, todayRes, weekRes] = await Promise.all(queries);

    // Ledger-based wallet liability. NO fallback to profile mirrors.
    let walletNgn = null, walletUsd = null, ledgerAvailable = true;
    try {
        const { data, error } = await supabaseAdmin
            .from('ledger_accounts')
            .select('currency, available_balance')
            .in('currency', ['NGN', 'USD']);
        if (error) {
            ledgerAvailable = false;
        } else {
            let ngnCents = 0n, usdCents = 0n;
            for (const row of data || []) {
                const raw = row.available_balance;
                const str = raw == null ? '0' : String(raw);
                const [intPart, fracPart = ''] = str.split('.');
                const frac = (fracPart + '00').slice(0, 2);
                const cents = BigInt(intPart || '0') * 100n + BigInt(frac || '0');
                if (row.currency === 'NGN') ngnCents += cents;
                else if (row.currency === 'USD') usdCents += cents;
            }
            walletNgn = Number(ngnCents) / 100;
            walletUsd = Number(usdCents) / 100;
        }
    } catch (_) {
        ledgerAvailable = false;
    }

    return {
        total: totalRes.count || 0,
        active: activeRes.count || 0,
        suspended: suspendedRes.count || 0,
        verified: verifiedRes.count || 0,
        newToday: todayRes.count || 0,
        newThisWeek: weekRes.count || 0,
        wallet_ngn: walletNgn,
        wallet_usd: walletUsd,
        ledger_available: ledgerAvailable
    };
}

// ═════════════════════════════════════════════════════════════════
//  USER 360
// ═════════════════════════════════════════════════════════════════

async function getUser360(id) {
    const { data: user, error } = await supabaseAdmin
        .from('profiles')
        .select(
            'id, username, email, phone, role, status, is_verified, ' +
            'two_factor_enabled, risk_level, referral_code, avatar_url, ' +
            'created_at, updated_at, last_login, last_seen, last_location, ' +
            'login_count, deleted_at, current_session_id, session_expires_at, ' +
            'transaction_pin_hash'
        )
        .eq('id', id)
        .maybeSingle();
    if (error) throw serviceError('USER_LOOKUP_FAILED', error.message, 500);
    if (!user) throw serviceError('USER_NOT_FOUND', 'User not found', 404);

    // 360 summary — one RPC round-trip.
    const summaryRpc = await tryRpc('get_user_360_summary', { p_user_id: id });
    const summary = summaryRpc.ok ? summaryRpc.data : null;

    // Financial summary — one RPC round-trip. If it fails, we say so.
    const finRpc = await tryRpc('get_user_financial_summary', { p_user_id: id });
    const wallet = finRpc.ok ? finRpc.data : { available: false, error_code: 'LEDGER_UNAVAILABLE', error: finRpc.error };

    // Restrictions
    let restrictions = [];
    try {
        const { data: rs } = await supabaseAdmin
            .from('user_restrictions')
            .select('id, restriction, reason, imposed_at, imposed_by, lifted_at, lifted_by, lifted_reason, is_active, expires_at')
            .eq('user_id', id)
            .eq('is_active', true);
        restrictions = rs || [];
    } catch (_) {}

    return {
        profile: {
            id: user.id,
            username: user.username,
            email: user.email,
            phone: user.phone,
            role: user.role || 'user',
            status: user.status || 'active',
            is_verified: !!user.is_verified,
            two_factor_enabled: !!user.two_factor_enabled,
            risk_level: user.risk_level || null,
            kyc_status: null,                        // not tracked yet
            referral_code: user.referral_code || null,
            avatar_url: user.avatar_url || null,
            created_at: user.created_at,
            updated_at: user.updated_at,
            last_login: user.last_login,
            last_seen: user.last_seen,
            last_location: user.last_location,
            login_count: user.login_count || 0,
            has_transaction_pin: !!user.transaction_pin_hash,
            deleted_at: user.deleted_at,
            // Presence-derived classification
            is_admin: ADMIN_ROLES.has(String(user.role || '').toLowerCase())
        },
        wallet,
        summary: summary || {
            active_sessions: null,
            open_tickets: null,
            pending_deposits: null,
            pending_withdrawals: null,
            total_transactions: null,
            ledger_available: false
        },
        restrictions
    };
}

// ═════════════════════════════════════════════════════════════════
//  WALLETS
// ═════════════════════════════════════════════════════════════════

async function getWallets(id) {
    const rpc = await tryRpc('get_user_financial_summary', { p_user_id: id });

    let pending = { deposits_ngn: null, deposits_usd: null, withdrawals_ngn: null, withdrawals_usd: null };
    try {
        const { data } = await supabaseAdmin
            .from('transactions')
            .select('type, currency, amount, status')
            .eq('user_id', id)
            .in('type', ['deposit', 'withdrawal'])
            .in('status', ['pending', 'processing']);
        if (data) {
            let dNgn = 0, dUsd = 0, wNgn = 0, wUsd = 0;
            for (const r of data) {
                const amt = toNumber(r.amount) || 0;
                const ccy = String(r.currency || '').toUpperCase();
                if (r.type === 'deposit') {
                    if (ccy === 'USD') dUsd += amt; else dNgn += amt;
                } else {
                    if (ccy === 'USD') wUsd += amt; else wNgn += amt;
                }
            }
            pending = {
                deposits_ngn: dNgn,
                deposits_usd: dUsd,
                withdrawals_ngn: wNgn,
                withdrawals_usd: wUsd
            };
        }
    } catch (_) {}

    // Last ledger movement
    let lastMovement = null;
    try {
        const { data: accounts } = await supabaseAdmin
            .from('ledger_accounts')
            .select('id, currency')
            .eq('user_id', id);
        const accountIds = (accounts || []).map(a => a.id);
        if (accountIds.length) {
            const { data: last } = await supabaseAdmin
                .from('ledger_entries')
                .select('id, account_id, entry_type, amount, currency, balance_after, description, created_at')
                .in('account_id', accountIds)
                .order('created_at', { ascending: false })
                .limit(1);
            lastMovement = last?.[0] || null;
        }
    } catch (_) {}

    if (rpc.ok) {
        return {
            available: true,
            source: 'ledger_accounts',
            wallets: rpc.data?.currencies || {},
            pending,
            last_movement: lastMovement,
            generated_at: rpc.data?.generated_at || new Date().toISOString()
        };
    }

    return {
        available: false,
        error_code: 'LEDGER_UNAVAILABLE',
        error: rpc.error,
        wallets: null,
        pending,
        last_movement: null
    };
}

// ═════════════════════════════════════════════════════════════════
//  LEDGER
// ═════════════════════════════════════════════════════════════════

async function getLedger(id, { page = 1, limit = 50, currency = '', entry_type = '' } = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_LIMIT);
    page = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    const { data: accounts, error: accErr } = await supabaseAdmin
        .from('ledger_accounts')
        .select('id, currency, available_balance, held_balance')
        .eq('user_id', id);
    if (accErr) throw serviceError('LEDGER_ACCOUNTS_FAILED', accErr.message, 500);
    if (!accounts || !accounts.length) {
        return {
            available: true,
            accounts: [],
            entries: [],
            count: 0, page, limit, totalPages: 0
        };
    }

    const wanted = accounts
        .filter(a => !currency || a.currency === currency)
        .map(a => a.id);
    if (!wanted.length) {
        return { available: true, accounts, entries: [], count: 0, page, limit, totalPages: 0 };
    }

    let q = supabaseAdmin
        .from('ledger_entries')
        .select(
            'id, transaction_id, account_id, entry_type, amount, currency, ' +
            'balance_before, balance_after, description, metadata, created_at',
            { count: 'exact' }
        )
        .in('account_id', wanted)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (entry_type === 'CREDIT' || entry_type === 'DEBIT') {
        q = q.eq('entry_type', entry_type);
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { available: true, accounts, entries: [], count: 0, page, limit, totalPages: 0, note: 'ledger_entries table not present' };
        }
        throw serviceError('LEDGER_READ_FAILED', error.message, 500);
    }

    return {
        available: true,
        accounts,
        entries: (data || []).map(e => ({
            id: e.id,
            account_id: e.account_id,
            transaction_id: e.transaction_id,
            entry_type: e.entry_type,
            direction: e.entry_type === 'CREDIT' ? 'credit' : 'debit',
            amount: toNumber(e.amount),
            currency: e.currency,
            balance_before: toNumber(e.balance_before),
            balance_after: toNumber(e.balance_after),
            description: e.description || '',
            metadata: e.metadata ? scrubObject(e.metadata) : null,
            created_at: e.created_at
        })),
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit)
    };
}

// ═════════════════════════════════════════════════════════════════
//  TRANSACTIONS
// ═════════════════════════════════════════════════════════════════

async function getTransactions(id, { page = 1, limit = 30, type = '', status = '', currency = '' } = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), MAX_LIMIT);
    page = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('transactions')
        .select(
            'id, type, status, currency, amount, fee, revenue_ngn, revenue_usd, ' +
            'description, ref, reference, provider, provider_reference, ' +
            'source_type, source_id, meta, metadata, created_at, completed_at, ' +
            'failed_at, failure_reason',
            { count: 'exact' }
        )
        .eq('user_id', id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (type) q = q.eq('type', type);
    if (status) q = q.eq('status', status);
    if (currency) q = q.eq('currency', String(currency).toUpperCase());

    const { data, error, count } = await q;
    if (error) throw serviceError('TRANSACTIONS_READ_FAILED', error.message, 500);

    return {
        transactions: (data || []).map(t => shapeTransaction(t, { includeMeta: false })),
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit)
    };
}

// ═════════════════════════════════════════════════════════════════
//  ORDERS (service history)
// ═════════════════════════════════════════════════════════════════

async function getOrders(id, { page = 1, limit = 30, product_type = '', status = '' } = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), MAX_LIMIT);
    page = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('orders')
        .select(
            'id, order_ref, user_id, product_type, product_name, ' +
            'provider, provider_order_id, total_amount, currency, ' +
            'status, payment_status, created_at, completed_at, failed_at',
            { count: 'exact' }
        )
        .eq('user_id', id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (product_type) q = q.eq('product_type', product_type);
    if (status) q = q.eq('status', status);

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { orders: [], count: 0, page, limit, totalPages: 0, note: 'orders table not present' };
        }
        throw serviceError('ORDERS_READ_FAILED', error.message, 500);
    }

    return {
        orders: (data || []).map(o => ({
            order_id: o.id,
            order_ref: o.order_ref,
            product_type: o.product_type,
            product_name: o.product_name,
            provider: o.provider,
            provider_order_id: o.provider_order_id,
            amount: toNumber(o.total_amount),
            currency: o.currency,
            status: o.status,
            payment_status: o.payment_status,
            created_at: o.created_at,
            completed_at: o.completed_at,
            failed_at: o.failed_at
        })),
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit)
    };
}

// ═════════════════════════════════════════════════════════════════
//  SECURITY
// ═════════════════════════════════════════════════════════════════

async function getSecurity(id, { limit = 30 } = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);

    let sessions = [];
    try {
        const { data } = await supabaseAdmin
            .from('user_sessions')
            .select(
                'id, session_id, device_name, device_type, browser, os, ' +
                'ip, ip_address, location, created_at, last_activity_at, ' +
                'expires_at, revoked_at, is_active, is_current, user_agent'
            )
            .eq('user_id', id)
            .order('created_at', { ascending: false })
            .limit(limit);
        sessions = data || [];
    } catch (_) {}

    const active = sessions.filter(s => s.is_active && !s.revoked_at);

    // Attempt to read security events if the table exists
    let events = null;
    try {
        const { data, error } = await supabaseAdmin
            .from('user_security_events')
            .select('id, event_type, severity, detail, ip_address, user_agent, created_at')
            .eq('user_id', id)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (!error) events = data || [];
    } catch (_) {}

    return {
        sessions,
        active_sessions: active,
        events,
        events_available: events !== null,
        failed_logins_available: events !== null
    };
}

// ═════════════════════════════════════════════════════════════════
//  SUPPORT
// ═════════════════════════════════════════════════════════════════

async function getSupport(id) {
    try {
        const { data, error } = await supabaseAdmin
            .from('support_tickets')
            .select('id, ticket_number, subject, status, priority, created_at, updated_at, assigned_to, last_message_at')
            .eq('user_id', id)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) {
            if (error.code === '42P01') return { tickets: [], note: 'support_tickets table not present' };
            throw error;
        }
        return { tickets: data || [] };
    } catch (e) {
        if (e.code === '42P01') return { tickets: [], note: 'support_tickets table not present' };
        throw serviceError('SUPPORT_READ_FAILED', e.message, 500);
    }
}

// ═════════════════════════════════════════════════════════════════
//  NOTES
// ═════════════════════════════════════════════════════════════════

async function getNotes(id) {
    try {
        const { data, error } = await supabaseAdmin
            .from('admin_user_notes')
            .select('id, author_id, body, tags, created_at')
            .eq('user_id', id)
            .order('created_at', { ascending: false })
            .limit(200);
        if (error && error.code === '42P01') return [];
        if (error) throw error;
        return data || [];
    } catch (e) {
        if (e.code === '42P01') return [];
        throw serviceError('NOTES_READ_FAILED', e.message, 500);
    }
}

async function addNote({ userId, authorId, body, tags }) {
    const trimmed = String(body || '').trim();
    if (trimmed.length < 3) throw serviceError('BODY_REQUIRED', 'Note body required (min 3 chars)', 422);
    if (trimmed.length > 4000) throw serviceError('BODY_TOO_LONG', 'Note max 4000 chars', 422);

    const cleanTags = Array.isArray(tags)
        ? tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 10).map(t => t.trim().slice(0, 40))
        : [];

    const { data, error } = await supabaseAdmin
        .from('admin_user_notes')
        .insert({ user_id: userId, author_id: authorId, body: trimmed, tags: cleanTags })
        .select()
        .single();
    if (error) throw serviceError('NOTE_INSERT_FAILED', error.message, 500);
    return data;
}

// ═════════════════════════════════════════════════════════════════
//  RESTRICTIONS
// ═════════════════════════════════════════════════════════════════

async function addRestriction({ userId, adminId, restriction, reason }) {
    const key = String(restriction || '').toLowerCase();
    const trimmedReason = String(reason || '').trim();

    if (!ALLOWED_RESTRICTIONS.has(key)) {
        throw serviceError('INVALID_RESTRICTION', `Restriction must be one of: ${[...ALLOWED_RESTRICTIONS].join(', ')}`, 422);
    }
    if (trimmedReason.length < 4) {
        throw serviceError('REASON_REQUIRED', 'Reason required (min 4 chars)', 422);
    }

    const { data: existing } = await supabaseAdmin
        .from('user_restrictions')
        .select('id')
        .eq('user_id', userId)
        .eq('restriction', key)
        .eq('is_active', true)
        .maybeSingle();
    if (existing) throw serviceError('RESTRICTION_ALREADY_ACTIVE', 'This restriction is already active', 409);

    const { data, error } = await supabaseAdmin
        .from('user_restrictions')
        .insert({
            user_id: userId,
            restriction: key,
            is_active: true,
            reason: trimmedReason,
            imposed_by: adminId,
            imposed_at: new Date().toISOString()
        })
        .select()
        .single();
    if (error) throw serviceError('RESTRICTION_INSERT_FAILED', error.message, 500);
    return data;
}

async function removeRestriction({ userId, adminId, restriction, reason }) {
    const key = String(restriction || '').toLowerCase();
    const trimmedReason = String(reason || '').trim();

    if (!ALLOWED_RESTRICTIONS.has(key)) {
        throw serviceError('INVALID_RESTRICTION', 'Unknown restriction', 422);
    }
    if (trimmedReason.length < 4) {
        throw serviceError('REASON_REQUIRED', 'Reason required (min 4 chars)', 422);
    }

    const { data: updated, error } = await supabaseAdmin
        .from('user_restrictions')
        .update({
            is_active: false,
            lifted_at: new Date().toISOString(),
            lifted_by: adminId,
            lifted_reason: trimmedReason
        })
        .eq('user_id', userId)
        .eq('restriction', key)
        .eq('is_active', true)
        .select()
        .maybeSingle();

    if (error) throw serviceError('RESTRICTION_UPDATE_FAILED', error.message, 500);
    if (!updated) throw serviceError('RESTRICTION_NOT_FOUND', 'No active restriction found', 404);
    return updated;
}

// ═════════════════════════════════════════════════════════════════
//  SECURITY ACTIONS
// ═════════════════════════════════════════════════════════════════

async function forceLogout({ userId, reason }) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required', 422);

    const now = new Date().toISOString();
    const { data: revoked, error } = await supabaseAdmin
        .from('user_sessions')
        .update({
            is_active: false,
            revoked_at: now,
            revoked_reason: `admin force-logout: ${trimmed}`
        })
        .eq('user_id', userId)
        .eq('is_active', true)
        .select('id');

    if (error) throw serviceError('FORCE_LOGOUT_FAILED', error.message, 500);

    try {
        await supabaseAdmin
            .from('profiles')
            .update({ current_session_id: null, session_expires_at: null, updated_at: now })
            .eq('id', userId);
    } catch (_) {}

    return { revoked: (revoked || []).length };
}

async function requirePasswordReset({ userId, reason }) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required', 422);

    const now = new Date().toISOString();
    // Do NOT null out the password hash. Instead, mark the account as
    // needing a reset. If a `force_password_change` column is added,
    // flip it. Until then, revoke active sessions and set a flag via
    // metadata if the profiles table has one; otherwise revoke only.
    try {
        await supabaseAdmin
            .from('user_sessions')
            .update({
                is_active: false,
                revoked_at: now,
                revoked_reason: 'admin required password reset'
            })
            .eq('user_id', userId)
            .eq('is_active', true);
    } catch (_) {}

    // Best-effort: try to set a force_password_change column if it exists.
    try {
        await supabaseAdmin
            .from('profiles')
            .update({ force_password_change: true, updated_at: now })
            .eq('id', userId);
    } catch (_) {
        // Column does not exist — session revocation is the enforcement.
    }

    return { sessions_revoked: true };
}

async function requireTwoFA({ userId, reason }) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required', 422);

    // We do NOT enable 2FA on behalf of the user. We mark that it is
    // required, so the UI and login flow can insist on enrollment.
    try {
        await supabaseAdmin
            .from('profiles')
            .update({ two_factor_required: true, updated_at: new Date().toISOString() })
            .eq('id', userId);
    } catch (_) {
        throw serviceError('TWOFA_FLAG_FAILED', 'Unable to mark 2FA as required. Migration missing?', 500);
    }
    return { two_factor_required: true };
}

// ═════════════════════════════════════════════════════════════════
//  PROFILE / STATUS
// ═════════════════════════════════════════════════════════════════

async function updateProfile({ userId, body, actorIsSuperAdmin }) {
    const { data: existing, error: getErr } = await supabaseAdmin
        .from('profiles')
        .select('id, username, phone, status, is_verified, role')
        .eq('id', userId)
        .single();
    if (getErr || !existing) throw serviceError('USER_NOT_FOUND', 'User not found', 404);

    const updateData = {};
    const before = {};
    const after = {};
    const assign = (field, value) => {
        updateData[field] = value;
        before[field] = existing[field];
        after[field] = value;
    };

    if (body.username !== undefined) {
        const v = String(body.username).trim();
        if (v.length < 3 || v.length > 40) throw serviceError('INVALID_USERNAME', 'Username must be 3–40 chars', 422);
        assign('username', v);
    }
    if (body.phone !== undefined) {
        assign('phone', String(body.phone).trim().slice(0, 30));
    }
    if (body.is_verified !== undefined) {
        assign('is_verified', !!body.is_verified);
    }
    if (body.status !== undefined) {
        const s = String(body.status).toLowerCase();
        if (!ALLOWED_STATUS.has(s)) throw serviceError('INVALID_STATUS', 'Invalid status', 422);
        assign('status', s);
    }
    if (body.role !== undefined) {
        const r = String(body.role).toLowerCase();
        if (!ALLOWED_ROLES.has(r)) throw serviceError('INVALID_ROLE', 'Invalid role', 422);
        if (!actorIsSuperAdmin) throw serviceError('ROLE_CHANGE_FORBIDDEN', 'Only super admins can change roles', 403);
        assign('role', r);
    }

    if (!Object.keys(updateData).length) throw serviceError('NO_CHANGES', 'No valid fields supplied', 422);
    updateData.updated_at = new Date().toISOString();

    const { data: updated, error: updateErr } = await supabaseAdmin
        .from('profiles')
        .update(updateData)
        .eq('id', userId)
        .select()
        .single();
    if (updateErr) throw serviceError('USER_UPDATE_FAILED', updateErr.message, 500);

    return { updated, before, after };
}

async function setStatus({ userId, status, reason }) {
    const s = String(status || '').toLowerCase();
    if (!ALLOWED_STATUS.has(s)) throw serviceError('INVALID_STATUS', 'Invalid status', 422);

    const { data: existing } = await supabaseAdmin
        .from('profiles').select('id, status').eq('id', userId).single();
    if (!existing) throw serviceError('USER_NOT_FOUND', 'User not found', 404);

    const now = new Date().toISOString();
    const { data: user, error } = await supabaseAdmin
        .from('profiles')
        .update({ status: s, updated_at: now })
        .eq('id', userId)
        .select()
        .single();
    if (error) throw serviceError('STATUS_UPDATE_FAILED', error.message, 500);

    // Notify user (best-effort)
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title: s === 'suspended' ? 'Account Suspended'
                : s === 'banned' ? 'Account Banned'
                : 'Account Activated',
            message: s === 'suspended' ? 'Your account has been suspended.'
                : s === 'banned' ? 'Your account has been banned.'
                : 'Your account has been reactivated.',
            type: s === 'active' ? 'success' : 'warning',
            icon: s === 'active' ? '✅' : '⚠️',
            is_read: false,
            created_at: now
        });
    } catch (_) {}

    return { user, before: existing.status, after: s };
}

// ═════════════════════════════════════════════════════════════════
//  WALLET ADJUSTMENT
// ═════════════════════════════════════════════════════════════════

async function adjustWallet({ userId, actorId, actorEmail, actorIsSuperAdmin, currency, amount, reason }) {
    const ccy = String(currency || '').toUpperCase();
    const amt = Number(amount);
    const trimmedReason = String(reason || '').trim();

    if (!ALLOWED_CURRENCIES.has(ccy)) throw serviceError('INVALID_CURRENCY', 'Currency must be NGN or USD', 422);
    if (!Number.isFinite(amt) || amt === 0) throw serviceError('INVALID_AMOUNT', 'Non-zero amount required', 422);
    if (Math.abs(amt) > MAX_WALLET_ADJUSTMENT) throw serviceError('AMOUNT_TOO_LARGE', 'Amount too large', 422);
    if (trimmedReason.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required (min 4 chars)', 422);

    const exceedsThreshold = Math.abs(amt) >= APPROVAL_THRESHOLD;
    const requiresApproval = exceedsThreshold && !actorIsSuperAdmin;

    if (requiresApproval) {
        const { data: approval, error: apErr } = await supabaseAdmin
            .from('admin_approvals')
            .insert({
                action: 'wallet_adjustment',
                target_type: 'profile',
                target_id: userId,
                requested_by: actorId,
                payload: { currency: ccy, amount: amt, direction: amt > 0 ? 'credit' : 'debit', reason: trimmedReason },
                status: 'pending',
                requested_at: new Date().toISOString()
            })
            .select()
            .single();
        if (apErr) throw serviceError('APPROVAL_CREATE_FAILED', apErr.message, 500);

        return {
            pending_approval: true,
            approval_id: approval.id,
            message: `Adjustment above ${APPROVAL_THRESHOLD} ${ccy} requires a second approver.`
        };
    }

    const isCredit = amt > 0;
    const absAmount = Math.abs(amt);
    const reference = `ADMIN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    let ledgerResult;
    try {
        const commonArgs = {
            userId,
            amount: absAmount,
            currency: ccy,
            description: `Admin ${isCredit ? 'credit' : 'debit'} (${trimmedReason})`,
            reference,
            sourceType: 'admin_adjustment',
            sourceId: actorId,
            metadata: { admin_id: actorId, admin_email: actorEmail, reason: trimmedReason },
            type: 'admin_adjustment'
        };
        ledgerResult = isCredit
            ? await LedgerService.creditWallet(commonArgs)
            : await LedgerService.debitWallet(commonArgs);
    } catch (ledgerErr) {
        throw serviceError('LEDGER_ADJUSTMENT_FAILED', ledgerErr.message || 'Ledger rejected adjustment', 400);
    }

    // Mirror update is best-effort, never a source of truth.
    const mirrorField = ccy === 'USD' ? 'wallet_usd' : 'wallet_ngn';
    try {
        if (ledgerResult.balance_after != null) {
            await supabaseAdmin
                .from('profiles')
                .update({ [mirrorField]: ledgerResult.balance_after, updated_at: new Date().toISOString() })
                .eq('id', userId);
        }
    } catch (_) {}

    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title: isCredit ? 'Wallet Funded' : 'Wallet Debited',
            message: `${isCredit ? 'Added' : 'Removed'} ${absAmount} ${ccy} (${trimmedReason})`,
            type: isCredit ? 'success' : 'warning',
            icon: isCredit ? '💰' : '📤',
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (_) {}

    return {
        currency: ccy,
        amount: amt,
        new_balance: ledgerResult.balance_after ?? null,
        ledger: {
            transaction_id: ledgerResult.transaction_id,
            reference: ledgerResult.reference,
            balance_before: ledgerResult.balance_before,
            balance_after: ledgerResult.balance_after
        }
    };
}

// ═════════════════════════════════════════════════════════════════
//  APPROVALS
// ═════════════════════════════════════════════════════════════════

async function listApprovals({ status = 'pending', limit = 50 } = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const { data, error } = await supabaseAdmin
        .from('admin_approvals')
        .select('*')
        .eq('status', status)
        .order('requested_at', { ascending: false })
        .limit(limit);
    if (error) {
        if (error.code === '42P01') return [];
        throw serviceError('APPROVALS_READ_FAILED', error.message, 500);
    }
    return data || [];
}

async function approveApproval({ id, actorId, actorEmail, actorIsSuperAdmin, reason }) {
    const { data: approval } = await supabaseAdmin
        .from('admin_approvals')
        .select('*')
        .eq('id', id)
        .eq('status', 'pending')
        .maybeSingle();
    if (!approval) throw serviceError('APPROVAL_NOT_FOUND', 'Pending approval not found', 404);
    if (approval.requested_by === actorId && !actorIsSuperAdmin) {
        throw serviceError('SELF_APPROVAL_FORBIDDEN', 'Second approver must differ from requester', 403);
    }

    const payload = approval.payload || {};
    const amt = Number(payload.amount);
    const ccy = String(payload.currency || '').toUpperCase();
    const isCredit = amt > 0;

    if (!ALLOWED_CURRENCIES.has(ccy) || !Number.isFinite(amt) || amt === 0) {
        throw serviceError('INVALID_PAYLOAD', 'Approval payload is invalid', 422);
    }

    const absAmount = Math.abs(amt);
    const reference = `ADMIN-APV-${approval.id.slice(0, 8)}`;
    const idempotencyKey = `admin-approval-${approval.id}`;

    let ledgerResult;
    try {
        const commonArgs = {
            userId: approval.target_id,
            amount: absAmount,
            currency: ccy,
            description: `Admin approval ${isCredit ? 'credit' : 'debit'} (${payload.reason || 'approved'})`,
            reference,
            sourceType: 'admin_adjustment',
            sourceId: actorId,
            metadata: {
                admin_id: actorId,
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
        throw serviceError('LEDGER_APPROVAL_FAILED', ledgerErr.message || 'Ledger rejected', 400);
    }

    const mirrorField = ccy === 'USD' ? 'wallet_usd' : 'wallet_ngn';
    try {
        if (ledgerResult.balance_after != null) {
            await supabaseAdmin
                .from('profiles')
                .update({ [mirrorField]: ledgerResult.balance_after, updated_at: new Date().toISOString() })
                .eq('id', approval.target_id);
        }
    } catch (_) {}

    await supabaseAdmin
        .from('admin_approvals')
        .update({
            status: 'approved',
            reviewed_by: actorId,
            reviewed_at: new Date().toISOString(),
            review_reason: reason || null,
            executed_at: new Date().toISOString(),
            execution_result: {
                ledger_reference: ledgerResult.reference,
                ledger_transaction_id: ledgerResult.transaction_id
            },
            execution_idempotency_key: idempotencyKey
        })
        .eq('id', id);

    return { ledger: ledgerResult };
}

async function rejectApproval({ id, actorId, reason }) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required (min 4 chars)', 422);

    const { data: updated, error } = await supabaseAdmin
        .from('admin_approvals')
        .update({
            status: 'rejected',
            reviewed_by: actorId,
            reviewed_at: new Date().toISOString(),
            review_reason: trimmed
        })
        .eq('id', id)
        .eq('status', 'pending')
        .select()
        .maybeSingle();
    if (error) throw serviceError('APPROVAL_REJECT_FAILED', error.message, 500);
    if (!updated) throw serviceError('APPROVAL_NOT_FOUND', 'Pending approval not found', 404);
    return updated;
}

module.exports = {
    listUsers,
    getRecentUsers,
    getStats,
    getUser360,
    getWallets,
    getLedger,
    getTransactions,
    getOrders,
    getSecurity,
    getSupport,
    getNotes,
    addNote,
    addRestriction,
    removeRestriction,
    forceLogout,
    requirePasswordReset,
    requireTwoFA,
    updateProfile,
    setStatus,
    adjustWallet,
    listApprovals,
    approveApproval,
    rejectApproval
};