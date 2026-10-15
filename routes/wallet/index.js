// routes/wallet/index.js
// ─────────────────────────────────────────────────────────────────
// Wallet balances + financial transaction history.
//
// BALANCE SOURCE: profiles.wallet_ngn / profiles.wallet_usd
//   (this is what /api/auth/me returns, so the wallet page and the
//    dashboard always agree — see the drift check in /me).
//
// WHAT CHANGED IN THIS REVISION:
//
//   CRITICAL
//   • Customer responses no longer include `provider` or
//     `provider_reference`. Those stay in the database for admin,
//     reconciliation, and support. The customer DTO is built by an
//     explicit allowlist (`toCustomerFinancial`).
//   • `metadata` is no longer returned raw. Only a small, safe
//     subset is echoed (direction + a couple of display fields).
//     `reason`, `failure_reason`, `refund_reason`, and `provider`
//     are stripped because their VALUES can contain provider names
//     or internal error text.
//
//   HIGH
//   • Search is now applied in the database query (before `.range`),
//     not on the fetched page. A matching row on page 2 is now
//     findable from page 1's search box.
//   • Invalid `type` / `currency` values return 400, not a silent
//     fallback to "all".
//   • `/debit` requires an `Idempotency-Key` header. Anonymous or
//     duplicate debits are rejected.
//   • `/debit` no longer returns the raw exception message for
//     unexpected failures — the client gets a generic error, the
//     server logs the detail.
//
//   MEDIUM
//   • `/me` distinguishes "profile missing" from "balance is zero"
//     instead of `parseFloat(...) || 0` collapsing both to 0.
//   • Response shape preserved for the frontend: `wallet_ngn`,
//     `wallet_usd`, plus the diagnostic `ledger` block remain.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../../db/supabase');
const { authMiddleware } = require('../../middleware/auth');
const { LedgerService } = require('../../services/ledgerService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══ CONFIG ═══
const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 100;
const MAX_SEARCH_LEN = 64;

// Financial types this endpoint owns. Everything else belongs to
// /api/transactions (service activity) or admin routes.
const FINANCIAL_TYPES = Object.freeze([
    'deposit',
    'wallet_debit',
    'wallet_credit',
    'withdrawal',
    'refund',
    'adjustment',
    'cashback_redeem'
]);

const FINANCIAL_DEBIT_TYPES = Object.freeze(['wallet_debit', 'withdrawal']);

// Allowlist of customer-safe statuses. Anything else → 'processing'.
const CUSTOMER_STATUS_MAP = Object.freeze({
    completed:  'completed',
    success:    'completed',
    successful: 'completed',
    finished:   'completed',
    refunded:   'refunded',
    failed:     'failed',
    declined:   'failed',
    cancelled:  'cancelled',
    canceled:   'cancelled',
    reversed:   'reversed',
    pending:    'pending',
    processing: 'processing',
    submitted:  'processing',
    created:    'processing',
    confirmed:  'processing',
    manual_review: 'processing'
});

// ═══ HELPERS ═══
function parseLimit(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(n, max);
}

function parsePage(v) {
    const n = parseInt(v, 10);
    return (!Number.isFinite(n) || n < 1) ? 1 : n;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function up(v) { return String(v || '').toUpperCase(); }
function lower(v) { return String(v || '').toLowerCase(); }

function toCustomerStatus(s) {
    return CUSTOMER_STATUS_MAP[lower(s)] || 'processing';
}

// PostgREST `.or()` treats commas/parens/dots as syntax. Reject
// anything outside a conservative allowlist.
const SEARCH_RE = /^[A-Za-z0-9_\- ]{1,64}$/;
function sanitizeSearch(value) {
    if (!value) return null;
    const s = String(value).trim();
    if (!s) return null;
    if (s.length > MAX_SEARCH_LEN) return null;
    if (!SEARCH_RE.test(s)) return null;
    return s;
}

// ─── CUSTOMER DTO ────────────────────────────────────────────────
// Explicit allowlist. Anything not named here never leaves the server.
function toCustomerFinancial(t) {
    const ccy = up(t.currency || t.wallet_used || 'NGN');

    // Authoritative amount: `amount` first, mirror column only as a
    // fallback when `amount` is zero.
    let amount = num(t.amount);
    if (amount === 0) {
        const mirror = ccy === 'USD' ? num(t.amount_usd) : num(t.amount_ngn);
        if (mirror !== 0) amount = mirror;
    }

    const type = lower(t.type);
    let direction = 'credit';
    if (FINANCIAL_DEBIT_TYPES.includes(type)) direction = 'debit';

    // Small, safe display fields only. We deliberately do NOT pass
    // through reason / failure_reason / refund_reason / provider.
    const rawMeta = t.metadata || t.meta || {};
    const safeMeta = {};
    if (rawMeta.direction === 'credit' || rawMeta.direction === 'debit') {
        safeMeta.direction = rawMeta.direction;
    }
    if (typeof rawMeta.currency_type === 'string' && /^[A-Z]{3}$/.test(rawMeta.currency_type)) {
        safeMeta.currency_type = rawMeta.currency_type;
    }

    return {
        id: t.id,
        reference: t.reference || t.ref || t.id,
        type: t.type,
        status: toCustomerStatus(t.status),
        currency: ccy,
        amount,
        fee: num(t.fee),
        net_amount: Math.max(0, amount - num(t.fee)),
        direction,
        description: customerSafeDescription(t),
        created_at: t.created_at || null,
        updated_at: t.updated_at || t.created_at || null,
        completed_at: t.completed_at || null,
        failed_at: t.failed_at || null,
        cancelled_at: t.cancelled_at || null,
        refunded_at: t.refunded_at || null,
        metadata: safeMeta
    };
}

// Never repeat a raw description that might contain a provider name.
// Recognised financial types get a fixed, human-readable phrase.
function customerSafeDescription(t) {
    const type = lower(t.type);
    if (type === 'deposit')        return 'Wallet deposit';
    if (type === 'wallet_debit')   return 'Wallet debit';
    if (type === 'wallet_credit')  return 'Wallet credit';
    if (type === 'withdrawal')     return 'Withdrawal';
    if (type === 'refund')         return 'Refund';
    if (type === 'adjustment')     return 'Balance adjustment';
    if (type === 'cashback_redeem')return 'Cashback redeemed';

    // Fallback for a type we don't recognise: use a generic phrase,
    // not the raw stored description.
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

        // 1. Profiles — the current authoritative source.
        const { data: profile, error: profErr } = await supabaseAdmin
            .from('profiles')
            .select('wallet_ngn, wallet_usd')
            .eq('id', userId)
            .maybeSingle();

        if (profErr) {
            console.error('[WALLET /me] profile error:', profErr.message);
            return res.status(503).json({
                success: false,
                code: 'BALANCE_UNAVAILABLE',
                error: 'Balance is temporarily unavailable. Please try again in a moment.'
            });
        }
        if (!profile) {
            return res.status(404).json({
                success: false,
                code: 'PROFILE_NOT_FOUND',
                error: 'Profile not found.'
            });
        }

        // Distinguish a real 0 from an invalid/missing value.
        const parseBal = (v) => {
            if (v === null || v === undefined) return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        const profileBal = {
            NGN: parseBal(profile.wallet_ngn),
            USD: parseBal(profile.wallet_usd)
        };

        // 2. Ledger — for the diagnostic field only.
        let ledgerBal = { NGN: null, USD: null };
        let ledgerAvailable = true;
        try {
            const { data: rows, error: ledErr } = await supabaseAdmin
                .from('ledger_accounts')
                .select('currency, available_balance')
                .eq('user_id', userId);

            if (ledErr) {
                ledgerAvailable = false;
                console.warn('[WALLET /me] ledger lookup failed:', ledErr.message);
            } else {
                (rows || []).forEach(a => {
                    const c = up(a.currency);
                    if (c === 'NGN' || c === 'USD') {
                        ledgerBal[c] = parseBal(a.available_balance);
                    }
                });
            }
        } catch (ledgerErr) {
            ledgerAvailable = false;
            console.warn('[WALLET /me] ledger lookup threw:', ledgerErr.message);
        }

        // If a balance is genuinely missing, that's a bug we should
        // report — not a zero. Fall back to 0 for the customer's
        // displayed number only if BOTH sources are unavailable.
        const displayNGN = profileBal.NGN ?? ledgerBal.NGN ?? 0;
        const displayUSD = profileBal.USD ?? ledgerBal.USD ?? 0;

        return res.json({
            success: true,
            data: {
                wallet_ngn: displayNGN,
                wallet_usd: displayUSD,
                financial: true,
                source: profileBal.NGN !== null ? 'profiles' : 'ledger',
                ledger: ledgerBal,
                profile: profileBal,
                ledger_available: ledgerAvailable,
                as_of: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('[WALLET /me] error:', error.message);
        return res.status(500).json({
            success: false,
            code: 'BALANCE_FAILED',
            error: 'Failed to fetch balances'
        });
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
            .from('profiles')
            .select('wallet_ngn, wallet_usd')
            .eq('id', userId)
            .maybeSingle();

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
            data: {
                ngn: parseBal(profile.wallet_ngn),
                usd: parseBal(profile.wallet_usd)
            }
        });
    } catch (error) {
        console.error('[WALLET /balance] error:', error.message);
        return res.status(500).json({ success: false, code: 'BALANCE_FAILED', error: 'Failed to fetch balance' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/wallet/transactions
//
//  Financial history only. Search is applied in the DB before the
//  range, so a match on page 2 shows up when the user searches.
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

        // ─── Validate the type filter ─────────────────────────────
        const rawType = String(req.query.type || 'all').toLowerCase();
        const allowedTypes = new Set(['all', 'deposit', 'debit', 'credit', 'refund', 'withdrawal', 'adjustment']);
        if (!allowedTypes.has(rawType)) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_TYPE',
                error: `Invalid type. Allowed: ${Array.from(allowedTypes).join(', ')}`
            });
        }

        // ─── Validate the currency filter ────────────────────────
        const rawCurrency = String(req.query.currency || 'all').toUpperCase();
        if (!['ALL', 'NGN', 'USD'].includes(rawCurrency)) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_CURRENCY',
                error: 'Invalid currency. Allowed: all, NGN, USD'
            });
        }

        // ─── Validate the search string ──────────────────────────
        const rawSearch = req.query.search;
        const search = sanitizeSearch(rawSearch);
        if (rawSearch && !search) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_SEARCH',
                error: 'Search must be 1-64 characters: letters, numbers, hyphens, underscores, or spaces.'
            });
        }

        // ─── Build the query ─────────────────────────────────────
        let query = supabaseAdmin
            .from('transactions')
            .select(
                'id, user_id, type, status, currency, amount, fee, ' +
                'amount_ngn, amount_usd, reference, ref, description, ' +
                'metadata, meta, created_at, updated_at, completed_at, ' +
                'failed_at, cancelled_at, refunded_at, ' +
                'wallet_used, category, ' +
                'source_type, source_id',
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

        // Apply search IN THE DATABASE — before pagination.
        if (search) {
            query = query.or(
                `reference.ilike.%${search}%,ref.ilike.%${search}%`
            );
        }

        const { data, error, count } = await query.range(offset, offset + limit - 1);

        if (error) {
            console.error('[WALLET /transactions] query error:', error.message);
            return res.status(503).json({
                success: false,
                code: 'TRANSACTIONS_UNAVAILABLE',
                error: 'Your transactions are temporarily unavailable. Please try again in a moment.'
            });
        }

        // ─── Sanitize through the customer DTO ───────────────────
        const customerRows = (data || []).map(toCustomerFinancial);

        const total = count || 0;

        return res.json({
            success: true,
            data: customerRows,
            count: total,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit) || 1,
                hasMore: page * limit < total
            }
        });
    } catch (error) {
        console.error('[WALLET /transactions] error:', error.message);
        return res.status(500).json({
            success: false,
            code: 'TRANSACTIONS_FAILED',
            error: 'Failed to fetch transactions'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/wallet/debit
//
//  Requires an Idempotency-Key header. Without it, a double-click
//  would create two debits.
// ═══════════════════════════════════════════════════════════════════
router.post('/debit', authMiddleware, async (req, res) => {
    try {
        const { amount, currency = 'NGN' } = req.body || {};
        const amt = Number(amount);
        const ccy = up(currency);

        // ─── Validate input ──────────────────────────────────────
        if (!Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ success: false, code: 'INVALID_AMOUNT', error: 'Invalid amount' });
        }
        if (!['NGN', 'USD'].includes(ccy)) {
            return res.status(400).json({ success: false, code: 'INVALID_CURRENCY', error: 'Invalid currency' });
        }

        const idempotencyKey =
            req.headers['idempotency-key'] ||
            req.body?.idempotency_key ||
            null;

        if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 128) {
            return res.status(400).json({
                success: false,
                code: 'IDEMPOTENCY_REQUIRED',
                error: 'Idempotency-Key header is required for wallet debits.'
            });
        }

        const result = await LedgerService.createTransaction({
            userId: req.user.id,
            type: 'wallet_debit',
            amount: -Math.abs(amt),
            currency: ccy,
            description: 'Wallet debit',
            idempotencyKey
        });

        return res.json({ success: true, data: result });
    } catch (error) {
        // Only surface a specific message for the insufficient-funds
        // case, which is a real user-facing condition.
        if (/Insufficient/i.test(error.message)) {
            return res.status(400).json({
                success: false,
                code: 'INSUFFICIENT_BALANCE',
                error: 'Insufficient balance'
            });
        }
        if (/Duplicate transaction in progress/i.test(error.message)) {
            return res.status(409).json({
                success: false,
                code: 'IDEMPOTENCY_IN_FLIGHT',
                error: 'This debit is already being processed.'
            });
        }

        // Anything else: log the real message, tell the client a
        // generic error so internal text is never leaked.
        console.error('[WALLET /debit] unexpected error:', error.message);
        return res.status(500).json({
            success: false,
            code: 'DEBIT_FAILED',
            error: 'Transaction failed. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/wallet/credit  — REMOVED
// ═══════════════════════════════════════════════════════════════════
router.post('/credit', authMiddleware, (req, res) => {
    return res.status(410).json({
        success: false,
        code: 'ENDPOINT_REMOVED',
        error: 'Direct wallet credit is not permitted.'
    });
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
            return res.status(400).json({ success: false, code: 'NO_FIELDS', error: 'No fields to update' });
        }

        const { data, error } = await supabaseAdmin
            .from('profiles')
            .update(updates)
            .eq('id', req.user.id)
            .select('id, username, full_name, phone, avatar_url')
            .single();

        if (error) {
            console.error('[WALLET /profile] update error:', error.message);
            return res.status(500).json({ success: false, code: 'PROFILE_UPDATE_FAILED', error: 'Failed to update profile' });
        }
        return res.json({ success: true, message: 'Profile updated', data });
    } catch (error) {
        console.error('[WALLET /profile] error:', error.message);
        return res.status(500).json({ success: false, code: 'PROFILE_UPDATE_FAILED', error: 'Failed to update profile' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/wallet/save-destination
// ═══════════════════════════════════════════════════════════════════
router.post('/save-destination', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            wallet_type, bank_code, account_number, account_name,
            crypto_address, crypto_network
        } = req.body || {};

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
            .from('profiles')
            .update(updateData)
            .eq('id', userId)
            .select('id')
            .single();

        if (error) {
            console.error('[WALLET save-destination] error:', error.message);
            return res.status(500).json({ success: false, code: 'DESTINATION_SAVE_FAILED', error: 'Failed to save destination' });
        }
        return res.json({ success: true, message: 'Destination saved successfully', data });
    } catch (error) {
        console.error('[WALLET save-destination] error:', error.message);
        return res.status(500).json({ success: false, code: 'DESTINATION_SAVE_FAILED', error: 'Failed to save destination' });
    }
});

module.exports = router;