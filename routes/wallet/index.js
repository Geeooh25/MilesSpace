// routes/wallet/index.js

'use strict';

const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../../db/supabase');
const { authMiddleware } = require('../../middleware/auth');
const { LedgerService } = require('../../services/ledgerService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 100;
const MAX_SEARCH_LEN = 64;

const FINANCIAL_TYPES = Object.freeze([
    'deposit', 'wallet_debit', 'wallet_credit', 'withdrawal', 'refund', 'adjustment', 'cashback_redeem'
]);
const FINANCIAL_DEBIT_TYPES = Object.freeze(['wallet_debit', 'withdrawal']);

const CUSTOMER_STATUS_MAP = Object.freeze({
    completed: 'completed', success: 'completed', successful: 'completed', finished: 'completed',
    refunded: 'refunded', failed: 'failed', declined: 'failed', cancelled: 'cancelled',
    canceled: 'cancelled', reversed: 'reversed', pending: 'pending', processing: 'processing',
    submitted: 'processing', created: 'processing', confirmed: 'processing', manual_review: 'processing'
});

function parseLimit(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(n, max);
}

function parsePage(v) {
    const n = parseInt(v, 10);
    return (!Number.isFinite(n) || n < 1) ? 1 : n;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function up(v) { return String(v || '').toUpperCase(); }
function lower(v) { return String(v || '').toLowerCase(); }
function toCustomerStatus(s) { return CUSTOMER_STATUS_MAP[lower(s)] || 'processing'; }

const SEARCH_RE = /^[A-Za-z0-9_\- ]{1,64}$/;
function sanitizeSearch(value) {
    if (!value) return null;
    const s = String(value).trim();
    if (!s) return null;
    if (s.length > MAX_SEARCH_LEN) return null;
    if (!SEARCH_RE.test(s)) return null;
    return s;
}

function toCustomerFinancial(t) {
    const ccy = up(t.currency || t.wallet_used || 'NGN');
    let amount = num(t.amount);
    if (amount === 0) {
        const mirror = ccy === 'USD' ? num(t.amount_usd) : num(t.amount_ngn);
        if (mirror !== 0) amount = mirror;
    }
    const type = lower(t.type);
    let direction = 'credit';
    if (FINANCIAL_DEBIT_TYPES.includes(type)) direction = 'debit';

    const rawMeta = t.metadata || t.meta || {};
    const safeMeta = {};
    if (rawMeta.direction === 'credit' || rawMeta.direction === 'debit') safeMeta.direction = rawMeta.direction;
    if (typeof rawMeta.currency_type === 'string' && /^[A-Z]{3}$/.test(rawMeta.currency_type)) safeMeta.currency_type = rawMeta.currency_type;

    return {
        id: t.id, reference: t.reference || t.ref || t.id, type: t.type,
        status: toCustomerStatus(t.status), currency: ccy, amount, fee: num(t.fee),
        net_amount: Math.max(0, amount - num(t.fee)), direction,
        description: customerSafeDescription(t),
        created_at: t.created_at || null, updated_at: t.updated_at || t.created_at || null,
        completed_at: t.completed_at || null, failed_at: t.failed_at || null,
        cancelled_at: t.cancelled_at || null, refunded_at: t.refunded_at || null,
        metadata: safeMeta
    };
}

function customerSafeDescription(t) {
    const type = lower(t.type);
    if (type === 'deposit')        return 'Wallet deposit';
    if (type === 'wallet_debit')   return 'Wallet debit';
    if (type === 'wallet_credit')  return 'Wallet credit';
    if (type === 'withdrawal')     return 'Withdrawal';
    if (type === 'refund')         return 'Refund';
    if (type === 'adjustment')     return 'Balance adjustment';
    if (type === 'cashback_redeem')return 'Cashback redeemed';
    return 'Transaction';
}

// ═══════════════════════════════════════════════════════════════════
//  GET /api/wallet/me
// ═══════════════════════════════════════════════════════════════════
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        if (!UUID_RE.test(userId)) {
            return res.status(400).json({ success: false, code: 'INVALID_USER', error: 'Invalid user' });
        }

        // 1. Ledger — The TRUE authority.
        let displayNGN = 0;
        let displayUSD = 0;
        let ledgerBal = { NGN: 0, USD: 0 };
        let ledgerAvailable = false;

        try {
            const { data: rows, error: ledErr } = await supabaseAdmin
                .from('ledger_accounts')
                .select('currency, available_balance')
                .eq('user_id', userId);

            if (!ledErr) {
                ledgerAvailable = true;
                (rows || []).forEach(a => {
                    const c = String(a.currency).toUpperCase();
                    if (c === 'NGN') { ledgerBal.NGN = Number(a.available_balance) || 0; displayNGN = ledgerBal.NGN; }
                    if (c === 'USD') { ledgerBal.USD = Number(a.available_balance) || 0; displayUSD = ledgerBal.USD; }
                });
            } else {
                console.warn('[WALLET /me] ledger lookup failed:', ledErr.message);
            }
        } catch (e) {
            console.warn('[WALLET /me] ledger lookup threw:', e.message);
        }

        // 2. Fallback to profiles if ledger is empty (e.g. old accounts)
        if (displayNGN === 0 && displayUSD === 0) {
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('wallet_ngn, wallet_usd')
                .eq('id', userId)
                .maybeSingle();

            if (profile) {
                displayNGN = Number(profile.wallet_ngn) || 0;
                displayUSD = Number(profile.wallet_usd) || 0;
            }
        }

        return res.json({
            success: true,
            data: {
                wallet_ngn: displayNGN,
                wallet_usd: displayUSD,
                financial: true,
                source: 'ledger',
                ledger: ledgerBal,
                ledger_available: ledgerAvailable,
                as_of: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('[WALLET /me] error:', error.message);
        return res.status(500).json({ success: false, code: 'BALANCE_FAILED', error: 'Failed to fetch balances' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/wallet/balance  (alias)
// ═══════════════════════════════════════════════════════════════════
router.get('/balance', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        if (!UUID_RE.test(userId)) {
            return res.status(400).json({ success: false, code: 'INVALID_USER', error: 'Invalid user' });
        }

        const { data: profile, error } = await supabaseAdmin
            .from('profiles').select('wallet_ngn, wallet_usd').eq('id', userId).maybeSingle();

        if (error) {
            console.error('[WALLET /balance] profile error:', error.message);
            return res.status(503).json({ success: false, code: 'BALANCE_UNAVAILABLE', error: 'Balance is temporarily unavailable.' });
        }
        if (!profile) {
            return res.status(404).json({ success: false, code: 'PROFILE_NOT_FOUND', error: 'Profile not found.' });
        }

        const parseBal = (v) => {
            if (v === null || v === undefined) return 0;
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
        };

        return res.json({
            success: true,
            data: { ngn: parseBal(profile.wallet_ngn), usd: parseBal(profile.wallet_usd) }
        });
    } catch (error) {
        console.error('[WALLET /balance] error:', error.message);
        return res.status(500).json({ success: false, code: 'BALANCE_FAILED', error: 'Failed to fetch balance' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/wallet/transactions
// ═══════════════════════════════════════════════════════════════════
router.get('/transactions', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        if (!UUID_RE.test(userId)) {
            return res.status(400).json({ success: false, code: 'INVALID_USER', error: 'Invalid user' });
        }

        const limit = parseLimit(req.query.limit);
        const page = parsePage(req.query.page);
        const offset = (page - 1) * limit;

        const rawType = String(req.query.type || 'all').toLowerCase();
        const allowedTypes = new Set(['all', 'deposit', 'debit', 'credit', 'refund', 'withdrawal', 'adjustment']);
        if (!allowedTypes.has(rawType)) {
            return res.status(400).json({ success: false, code: 'INVALID_TYPE', error: `Invalid type` });
        }

        const rawCurrency = String(req.query.currency || 'all').toUpperCase();
        if (!['ALL', 'NGN', 'USD'].includes(rawCurrency)) {
            return res.status(400).json({ success: false, code: 'INVALID_CURRENCY', error: 'Invalid currency' });
        }

        const rawSearch = req.query.search;
        const search = sanitizeSearch(rawSearch);
        if (rawSearch && !search) {
            return res.status(400).json({ success: false, code: 'INVALID_SEARCH', error: 'Invalid search' });
        }

        let query = supabaseAdmin
            .from('transactions')
            .select(
                'id, user_id, type, status, currency, amount, fee, ' +
                'amount_ngn, amount_usd, reference, ref, description, ' +
                'metadata, meta, created_at, updated_at, completed_at, ' +
                'failed_at, cancelled_at, refunded_at, ' +
                'wallet_used, category, source_type, source_id',
                { count: 'exact' }
            )
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .in('type', FINANCIAL_TYPES);

        if (rawCurrency === 'NGN' || rawCurrency === 'USD') {
            query = query.eq('currency', rawCurrency);
        }

        if (rawType === 'deposit') {
            query = query.eq('type', 'deposit');
        } else if (rawType === 'debit') {
            query = query.in('type', FINANCIAL_DEBIT_TYPES);
        } else if (rawType === 'credit') {
            query = query.in('type', ['wallet_credit', 'refund', 'adjustment']);
        } else if (rawType === 'refund') {
            query = query.eq('type', 'refund');
        } else if (rawType === 'withdrawal') {
            query = query.eq('type', 'withdrawal');
        } else if (rawType === 'adjustment') {
            query = query.eq('type', 'adjustment');
        }

        if (search) {
            query = query.or(`reference.ilike.%${search}%,ref.ilike.%${search}%`);
        }

        const { data, error, count } = await query.range(offset, offset + limit - 1);

        if (error) {
            console.error('[WALLET /transactions] query error:', error.message);
            return res.status(503).json({ success: false, code: 'TRANSACTIONS_UNAVAILABLE', error: 'Unavailable' });
        }

        const customerRows = (data || []).map(toCustomerFinancial);
        const total = count || 0;

        return res.json({
            success: true,
            data: customerRows,
            count: total,
            pagination: {
                page, limit, total,
                totalPages: Math.ceil(total / limit) || 1,
                hasMore: page * limit < total
            }
        });
    } catch (error) {
        console.error('[WALLET /transactions] error:', error.message);
        return res.status(500).json({ success: false, code: 'TRANSACTIONS_FAILED', error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/wallet/debit
// ═══════════════════════════════════════════════════════════════════
router.post('/debit', authMiddleware, async (req, res) => {
    try {
        const { amount, currency = 'NGN' } = req.body || {};
        const amt = Number(amount);
        const ccy = up(currency);

        if (!Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ success: false, code: 'INVALID_AMOUNT', error: 'Invalid amount' });
        }
        if (!['NGN', 'USD'].includes(ccy)) {
            return res.status(400).json({ success: false, code: 'INVALID_CURRENCY', error: 'Invalid currency' });
        }

        const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotency_key || null;
        if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 128) {
            return res.status(400).json({ success: false, code: 'IDEMPOTENCY_REQUIRED', error: 'Idempotency-Key required' });
        }

        const result = await LedgerService.createTransaction({
            userId: req.user.id, type: 'wallet_debit', amount: -Math.abs(amt),
            currency: ccy, description: 'Wallet debit', idempotencyKey
        });

        return res.json({ success: true, data: result });
    } catch (error) {
        if (/Insufficient/i.test(error.message)) {
            return res.status(400).json({ success: false, code: 'INSUFFICIENT_BALANCE', error: 'Insufficient balance' });
        }
        if (/Duplicate transaction in progress/i.test(error.message)) {
            return res.status(409).json({ success: false, code: 'IDEMPOTENCY_IN_FLIGHT', error: 'Already processing' });
        }
        console.error('[WALLET /debit] error:', error.message);
        return res.status(500).json({ success: false, code: 'DEBIT_FAILED', error: 'Transaction failed' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/wallet/credit  — REMOVED
// ═══════════════════════════════════════════════════════════════════
router.post('/credit', authMiddleware, (req, res) => {
    return res.status(410).json({ success: false, code: 'ENDPOINT_REMOVED', error: 'Direct credit not permitted' });
});

// ═══════════════════════════════════════════════════════════════════
//  PUT /api/wallet/profile
// ═══════════════════════════════════════════════════════════════════
router.put('/profile', authMiddleware, async (req, res) => {
    try {
        const { username, full_name, phone, avatar_url } = req.body || {};
        const updates = {};
        if (username)   updates.username   = username;
        if (full_name)  updates.full_name  = full_name;
        if (phone)      updates.phone      = phone;
        if (avatar_url) updates.avatar_url = avatar_url;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, code: 'NO_FIELDS', error: 'No fields' });
        }

        const { data, error } = await supabaseAdmin
            .from('profiles').update(updates).eq('id', req.user.id)
            .select('id, username, full_name, phone, avatar_url').single();

        if (error) {
            console.error('[WALLET /profile] error:', error.message);
            return res.status(500).json({ success: false, code: 'PROFILE_UPDATE_FAILED', error: 'Failed' });
        }
        return res.json({ success: true, message: 'Profile updated', data });
    } catch (error) {
        return res.status(500).json({ success: false, code: 'PROFILE_UPDATE_FAILED', error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/wallet/save-destination
// ═══════════════════════════════════════════════════════════════════
router.post('/save-destination', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { wallet_type, bank_code, account_number, account_name, crypto_address, crypto_network } = req.body || {};

        const updateData = { updated_at: new Date().toISOString() };

        if (up(wallet_type) === 'NGN') {
            updateData.bank_code = bank_code || null;
            updateData.account_number = account_number || null;
            updateData.account_name = account_name || null;
        } else {
            updateData.crypto_address = crypto_address || null;
            updateData.crypto_network = crypto_network || null;
        }

        const { data, error } = await supabaseAdmin
            .from('profiles').update(updateData).eq('id', userId).select('id').single();

        if (error) {
            console.error('[WALLET save-destination] error:', error.message);
            return res.status(500).json({ success: false, code: 'DESTINATION_SAVE_FAILED', error: 'Failed' });
        }
        return res.json({ success: true, message: 'Destination saved', data });
    } catch (error) {
        return res.status(500).json({ success: false, code: 'DESTINATION_SAVE_FAILED', error: 'Failed' });
    }
});

module.exports = router;