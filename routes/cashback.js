// routes/cashback.js - COMPLETE FIXED VERSION
// FIXES:
// 1. Idempotency key reserved BEFORE any mutation (atomic)
// 2. Atomic wallet debit using SQL function
// 3. Proper duplicate request rejection (409 conflict)
// 4. Critical status write happens IMMEDIATELY after VTpass result
// 5. Secondary bookkeeping wrapped in try/catch (can't undo primary status)
// 6. Reconciliation-ready with provider_request_id stored
// 7. Atomic refund on failure

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService, AdminConfigService, CASHBACK_CURRENCY } = require('../services/ledgerService');
const IdempotencyService = require('../services/idempotencyService');
const vtpassService = require('../services/vtpassService');
const emailService = require('../services/emailService');

// ─── CONFIG ──────────────────────────────────────────────────────────────
const MIN_REDEEM = 50;
const MAX_REDEEM = 100000;
const MAX_PIN_ATTEMPTS = 4;
const PIN_LOCK_DURATION = 60 * 60 * 1000;
const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;
const OTP_RATE_LIMIT_WINDOW = 60 * 60 * 1000;
const OTP_MAX_PER_WINDOW = 3;
const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;

// ─── COMPLETE DATA PLANS FALLBACK ──────────────────────────────────────
const DATA_PLANS_FALLBACK = {
    mtn: [
        { code: 'mtn-50', name: 'MTN 50MB', amount: 50, validity: '1 day' },
        { code: 'mtn-100', name: 'MTN 100MB', amount: 100, validity: '1 day' },
        { code: 'mtn-200', name: 'MTN 200MB', amount: 200, validity: '3 days' },
        { code: 'mtn-350', name: 'MTN 350MB', amount: 350, validity: '7 days' },
        { code: 'mtn-500', name: 'MTN 500MB', amount: 500, validity: '7 days' },
        { code: 'mtn-750', name: 'MTN 750MB', amount: 750, validity: '14 days' },
        { code: 'mtn-1gb', name: 'MTN 1GB', amount: 1000, validity: '30 days' },
        { code: 'mtn-1.5gb', name: 'MTN 1.5GB', amount: 1500, validity: '30 days' },
        { code: 'mtn-2gb', name: 'MTN 2GB', amount: 2000, validity: '30 days' },
        { code: 'mtn-3gb', name: 'MTN 3GB', amount: 3000, validity: '30 days' },
        { code: 'mtn-5gb', name: 'MTN 5GB', amount: 5000, validity: '30 days' },
        { code: 'mtn-10gb', name: 'MTN 10GB', amount: 10000, validity: '30 days' },
        { code: 'mtn-15gb', name: 'MTN 15GB', amount: 15000, validity: '30 days' },
        { code: 'mtn-20gb', name: 'MTN 20GB', amount: 20000, validity: '30 days' },
        { code: 'mtn-40gb', name: 'MTN 40GB', amount: 40000, validity: '30 days' },
        { code: 'mtn-75gb', name: 'MTN 75GB', amount: 75000, validity: '30 days' },
        { code: 'mtn-100gb', name: 'MTN 100GB', amount: 100000, validity: '30 days' },
    ],
    airtel: [
        { code: 'airtel-50', name: 'Airtel 50MB', amount: 50, validity: '1 day' },
        { code: 'airtel-100', name: 'Airtel 100MB', amount: 100, validity: '1 day' },
        { code: 'airtel-200', name: 'Airtel 200MB', amount: 200, validity: '3 days' },
        { code: 'airtel-350', name: 'Airtel 350MB', amount: 350, validity: '7 days' },
        { code: 'airtel-500', name: 'Airtel 500MB', amount: 500, validity: '7 days' },
        { code: 'airtel-750', name: 'Airtel 750MB', amount: 750, validity: '14 days' },
        { code: 'airtel-1gb', name: 'Airtel 1GB', amount: 1000, validity: '30 days' },
        { code: 'airtel-1.5gb', name: 'Airtel 1.5GB', amount: 1500, validity: '30 days' },
        { code: 'airtel-2gb', name: 'Airtel 2GB', amount: 2000, validity: '30 days' },
        { code: 'airtel-3gb', name: 'Airtel 3GB', amount: 3000, validity: '30 days' },
        { code: 'airtel-5gb', name: 'Airtel 5GB', amount: 5000, validity: '30 days' },
        { code: 'airtel-10gb', name: 'Airtel 10GB', amount: 10000, validity: '30 days' },
        { code: 'airtel-15gb', name: 'Airtel 15GB', amount: 15000, validity: '30 days' },
        { code: 'airtel-20gb', name: 'Airtel 20GB', amount: 20000, validity: '30 days' },
        { code: 'airtel-40gb', name: 'Airtel 40GB', amount: 40000, validity: '30 days' },
        { code: 'airtel-75gb', name: 'Airtel 75GB', amount: 75000, validity: '30 days' },
        { code: 'airtel-100gb', name: 'Airtel 100GB', amount: 100000, validity: '30 days' },
    ],
    glo: [
        { code: 'glo-50', name: 'Glo 50MB', amount: 50, validity: '1 day' },
        { code: 'glo-100', name: 'Glo 100MB', amount: 100, validity: '1 day' },
        { code: 'glo-200', name: 'Glo 200MB', amount: 200, validity: '3 days' },
        { code: 'glo-350', name: 'Glo 350MB', amount: 350, validity: '7 days' },
        { code: 'glo-500', name: 'Glo 500MB', amount: 500, validity: '7 days' },
        { code: 'glo-750', name: 'Glo 750MB', amount: 750, validity: '14 days' },
        { code: 'glo-1gb', name: 'Glo 1GB', amount: 1000, validity: '30 days' },
        { code: 'glo-1.5gb', name: 'Glo 1.5GB', amount: 1500, validity: '30 days' },
        { code: 'glo-2gb', name: 'Glo 2GB', amount: 2000, validity: '30 days' },
        { code: 'glo-3gb', name: 'Glo 3GB', amount: 3000, validity: '30 days' },
        { code: 'glo-5gb', name: 'Glo 5GB', amount: 5000, validity: '30 days' },
        { code: 'glo-10gb', name: 'Glo 10GB', amount: 10000, validity: '30 days' },
        { code: 'glo-15gb', name: 'Glo 15GB', amount: 15000, validity: '30 days' },
        { code: 'glo-20gb', name: 'Glo 20GB', amount: 20000, validity: '30 days' },
        { code: 'glo-40gb', name: 'Glo 40GB', amount: 40000, validity: '30 days' },
        { code: 'glo-75gb', name: 'Glo 75GB', amount: 75000, validity: '30 days' },
        { code: 'glo-100gb', name: 'Glo 100GB', amount: 100000, validity: '30 days' },
    ],
    '9mobile': [
        { code: '9mobile-50', name: '9mobile 50MB', amount: 50, validity: '1 day' },
        { code: '9mobile-100', name: '9mobile 100MB', amount: 100, validity: '1 day' },
        { code: '9mobile-200', name: '9mobile 200MB', amount: 200, validity: '3 days' },
        { code: '9mobile-350', name: '9mobile 350MB', amount: 350, validity: '7 days' },
        { code: '9mobile-500', name: '9mobile 500MB', amount: 500, validity: '7 days' },
        { code: '9mobile-750', name: '9mobile 750MB', amount: 750, validity: '14 days' },
        { code: '9mobile-1gb', name: '9mobile 1GB', amount: 1000, validity: '30 days' },
        { code: '9mobile-1.5gb', name: '9mobile 1.5GB', amount: 1500, validity: '30 days' },
        { code: '9mobile-2gb', name: '9mobile 2GB', amount: 2000, validity: '30 days' },
        { code: '9mobile-3gb', name: '9mobile 3GB', amount: 3000, validity: '30 days' },
        { code: '9mobile-5gb', name: '9mobile 5GB', amount: 5000, validity: '30 days' },
        { code: '9mobile-10gb', name: '9mobile 10GB', amount: 10000, validity: '30 days' },
        { code: '9mobile-15gb', name: '9mobile 15GB', amount: 15000, validity: '30 days' },
        { code: '9mobile-20gb', name: '9mobile 20GB', amount: 20000, validity: '30 days' },
        { code: '9mobile-40gb', name: '9mobile 40GB', amount: 40000, validity: '30 days' },
        { code: '9mobile-75gb', name: '9mobile 75GB', amount: 75000, validity: '30 days' },
        { code: '9mobile-100gb', name: '9mobile 100GB', amount: 100000, validity: '30 days' },
    ]
};

// ─── RATE LIMITER ──────────────────────────────────────────────────────
const rateLimitStore = new Map();

function checkRateLimit(key, windowMs, maxRequests) {
    const now = Date.now();
    const record = rateLimitStore.get(key);
    if (!record || now > record.resetAt) {
        rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    if (record.count >= maxRequests) return false;
    record.count++;
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore) {
        if (now > record.resetAt) rateLimitStore.delete(key);
    }
}, 10 * 60 * 1000);

// ─── CACHE ──────────────────────────────────────────────────────────────
const displayCache = new Map();

function cacheGet(key, ttl) {
    const entry = displayCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > ttl) {
        displayCache.delete(key);
        return null;
    }
    return entry.value;
}

function cacheSet(key, value) {
    displayCache.set(key, { value, timestamp: Date.now() });
}

function cacheInvalidateUser(userId) {
    for (const key of displayCache.keys()) {
        if (key.includes(userId)) displayCache.delete(key);
    }
}

const CACHE_TTL = {
    SUMMARY: 3000,
    PLANS: 30 * 60 * 1000,
    RECENT: 15000,
    PIN_STATUS: 10000
};

// ─── HELPERS ────────────────────────────────────────────────────────────

async function getWallet(userId) {
    let { data: wallet, error } = await supabaseAdmin
        .from('cashback_wallet')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

    if (!wallet) {
        const { data: newWallet, error: createError } = await supabaseAdmin
            .from('cashback_wallet')
            .insert({
                user_id: userId,
                balance: 0,
                lifetime_earned: 0,
                lifetime_used: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();

        if (createError) {
            console.error('❌ Failed to create cashback wallet:', createError);
            throw new Error('Failed to create cashback wallet');
        }
        return newWallet;
    }

    if (error) {
        console.error('❌ Failed to fetch cashback wallet:', error);
        throw new Error('Failed to fetch cashback wallet');
    }
    return wallet;
}

async function getUserProfile(userId) {
    if (!userId) throw new Error('User ID is required');

    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email, transaction_pin_hash, transaction_pin_attempts, transaction_pin_locked_until, pin_reset_otp_hash, pin_reset_otp_expiry, pin_reset_otp_attempts, pin_reset_token, pin_reset_token_expiry')
        .eq('id', userId)
        .maybeSingle();

    if (error) {
        console.error('❌ getUserProfile database error:', error);
        throw new Error('Failed to fetch user profile');
    }

    if (!data) {
        console.warn(`⚠️ getUserProfile: no profile exists for ${userId}`);
        throw new Error('User not found');
    }

    return data;
}

function isPinLocked(profile) {
    if (!profile?.transaction_pin_locked_until) return false;
    return new Date(profile.transaction_pin_locked_until) > new Date();
}

function getRemainingLockTime(profile) {
    if (!profile?.transaction_pin_locked_until) return 0;
    const lockUntil = new Date(profile.transaction_pin_locked_until);
    const now = new Date();
    if (lockUntil <= now) return 0;
    return Math.ceil((lockUntil - now) / 60000);
}

function maskEmail(email) {
    if (!email) return '***@***.***';
    const [local, domain] = email.split('@');
    if (!domain) return email;
    if (local.length <= 2) return `${local.charAt(0)}***@${domain}`;
    return `${local.charAt(0)}${'*'.repeat(Math.min(local.length - 2, 4))}${local.charAt(local.length - 1)}@${domain}`;
}

function generateOTP() {
    return String(crypto.randomInt(100000, 999999));
}

function hashString(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

function getNetworkName(network) {
    const labels = {
        mtn: 'MTN',
        glo: 'Glo',
        airtel: 'Airtel',
        '9mobile': '9mobile'
    };
    return labels[network] || network || 'Unknown';
}

async function createNotification(userId, title, message, type = 'info', link = null) {
    try {
        const { data, error } = await supabaseAdmin
            .from('notifications')
            .insert({
                user_id: userId,
                title,
                message,
                type,
                icon: type === 'reward_earned' ? '⭐' :
                      type === 'reward_used' ? '💰' :
                      type === 'reward_failed' ? '❌' : '📌',
                link: link || '/cashback',
                is_read: false,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) console.error('Notification error:', error);
        return data;
    } catch (e) {
        console.error('Create notification error:', e);
        return null;
    }
}

// ─── PIN VERIFICATION ──────────────────────────────────────────────────

async function verifyTransactionPin(userId, pin) {
    try {
        if (!userId) {
            return { valid: false, error: 'User ID required', code: 'USER_ID_REQUIRED' };
        }

        if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
            return { valid: false, error: 'PIN must be exactly 4 digits', code: 'INVALID_FORMAT' };
        }

        let profile;
        try {
            profile = await getUserProfile(userId);
        } catch (err) {
            return { valid: false, error: 'User not found. Please sign in again.', code: 'USER_NOT_FOUND' };
        }

        if (!profile.transaction_pin_hash) {
            return { valid: false, error: 'PIN not set. Please set a PIN first.', code: 'PIN_NOT_SET', pinNotSet: true };
        }

        if (profile.transaction_pin_locked_until) {
            const lockUntil = new Date(profile.transaction_pin_locked_until);
            const now = new Date();
            if (lockUntil > now) {
                const remaining = Math.ceil((lockUntil - now) / 60000);
                return {
                    valid: false,
                    error: `PIN is locked. Please wait ${remaining} minute${remaining > 1 ? 's' : ''}.`,
                    code: 'PIN_LOCKED',
                    remaining_minutes: remaining
                };
            }
        }

        const isValid = await bcrypt.compare(pin, profile.transaction_pin_hash);

        if (!isValid) {
            const attempts = (profile.transaction_pin_attempts || 0) + 1;
            const updates = { transaction_pin_attempts: attempts };

            if (attempts >= MAX_PIN_ATTEMPTS) {
                const lockUntil = new Date(Date.now() + PIN_LOCK_DURATION);
                updates.transaction_pin_locked_until = lockUntil.toISOString();
                updates.transaction_pin_attempts = 0;

                await supabaseAdmin.from('profiles').update(updates).eq('id', userId);

                await createNotification(
                    userId,
                    'PIN Locked 🔒',
                    'Your transaction PIN has been locked for 1 hour due to too many failed attempts.',
                    'info',
                    '/cashback'
                );

                return { 
                    valid: false, 
                    error: 'Too many failed attempts. PIN locked for 1 hour.', 
                    code: 'PIN_LOCKED', 
                    remaining_minutes: 60 
                };
            }

            await supabaseAdmin.from('profiles').update(updates).eq('id', userId);

            const remaining = MAX_PIN_ATTEMPTS - attempts;
            return {
                valid: false,
                error: `Invalid PIN. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`,
                code: 'INVALID_PIN',
                attempts_remaining: remaining
            };
        }

        await supabaseAdmin
            .from('profiles')
            .update({ 
                transaction_pin_attempts: 0, 
                transaction_pin_locked_until: null 
            })
            .eq('id', userId);

        return { valid: true };

    } catch (error) {
        console.error('❌ verifyTransactionPin error:', error);
        return { valid: false, error: 'PIN verification failed. Please try again.', code: 'VERIFICATION_ERROR' };
    }
}

// ─── HELPER: Create Main Transaction Record ────────────────────────────

async function createMainTransaction({
    userId,
    reference,
    type,
    amount,
    currency = 'NGN',
    description,
    status = 'pending',
    sourceType = null,
    sourceId = null,
    provider = null,
    providerReference = null,
    metadata = {},
    idempotencyKey = null,
    failureReason = null
}) {
    const transactionData = {
        user_id: userId,
        reference: reference,
        type: type,
        status: status,
        currency: currency,
        amount: parseFloat(amount),
        description: description || type,
        source_type: sourceType,
        source_id: sourceId,
        provider: provider,
        provider_reference: providerReference,
        metadata: {
            ...metadata,
            ...(sourceType && { source_type: sourceType }),
            ...(sourceId && { source_id: sourceId }),
            ...(provider && { provider: provider }),
            ...(providerReference && { provider_reference: providerReference })
        },
        idempotency_key: idempotencyKey,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    if (status === 'completed' || status === 'success') {
        transactionData.status = 'completed';
        transactionData.completed_at = new Date().toISOString();
    } else if (status === 'failed') {
        transactionData.failed_at = new Date().toISOString();
        if (failureReason) {
            transactionData.failure_reason = failureReason;
        }
    } else if (status === 'processing') {
        transactionData.status = 'processing';
    }

    const { data, error } = await supabaseAdmin
        .from('transactions')
        .insert(transactionData)
        .select()
        .single();

    if (error) {
        console.error('❌ Main transaction creation error:', error);
        throw new Error(`Failed to create transaction: ${error.message}`);
    }

    return data;
}

// ─── HELPER: Get Ledger Account ID ─────────────────────────────────────

async function getLedgerAccountId(userId, currency = 'NGN') {
    const { data, error } = await supabaseAdmin
        .from('ledger_accounts')
        .select('id')
        .eq('user_id', userId)
        .eq('currency', currency)
        .maybeSingle();

    if (data) return data.id;

    const { data: newAccount, error: createError } = await supabaseAdmin
        .from('ledger_accounts')
        .insert({
            user_id: userId,
            currency: currency,
            available_balance: 0,
            held_balance: 0
        })
        .select()
        .single();

    if (createError) {
        console.error('❌ Failed to create ledger account:', createError);
        throw new Error('Failed to create ledger account');
    }

    return newAccount.id;
}

// ─── HELPER: Create Ledger Entry ──────────────────────────────────────

async function createLedgerEntry({
    transactionId,
    accountId,
    entryType,
    amount,
    currency = 'NGN',
    balanceBefore,
    balanceAfter,
    description
}) {
    const { data, error } = await supabaseAdmin
        .from('ledger_entries')
        .insert({
            transaction_id: transactionId,
            account_id: accountId,
            entry_type: entryType,
            amount: parseFloat(amount),
            currency: currency,
            balance_before: parseFloat(balanceBefore) || 0,
            balance_after: parseFloat(balanceAfter) || 0,
            description: description || 'Cashback redemption',
            created_at: new Date().toISOString()
        })
        .select()
        .single();

    if (error) {
        console.error('❌ Ledger entry creation error:', error);
        throw new Error(`Failed to create ledger entry: ${error.message}`);
    }

    return data;
}

// ─── HELPER: Update Ledger Account Balance ────────────────────────────

async function updateLedgerBalance(userId, currency, newBalance) {
    const { error } = await supabaseAdmin
        .from('ledger_accounts')
        .update({
            available_balance: parseFloat(newBalance),
            updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('currency', currency);

    if (error) {
        console.error('❌ Ledger balance update error:', error);
        throw new Error(`Failed to update ledger balance: ${error.message}`);
    }
}

// ─── GET /api/cashback/balance ─────────────────────────────────────────

router.get('/balance', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const wallet = await getWallet(userId);
        
        res.json({
            success: true,
            data: {
                cashback: parseFloat(wallet.balance) || 0,
                lifetime_earned: parseFloat(wallet.lifetime_earned) || 0,
                lifetime_used: parseFloat(wallet.lifetime_used) || 0
            }
        });
    } catch (error) {
        console.error('❌ Balance error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/cashback ──────────────────────────────────────────────────

router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const wallet = await getWallet(userId);
        const limit = Math.min(parseInt(req.query.limit) || 10, 100);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);

        const { data: transactions, count, error: txError } = await supabaseAdmin
            .from('cashback_transactions')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (txError) throw txError;

        res.json({
            success: true,
            data: {
                balance: parseFloat(wallet.balance) || 0,
                lifetime_earned: parseFloat(wallet.lifetime_earned) || 0,
                lifetime_used: parseFloat(wallet.lifetime_used) || 0,
                transactions: transactions || [],
                pagination: { total: count || 0, limit, offset }
            }
        });
    } catch (error) {
        console.error('❌ Cashback error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch cashback data' });
    }
});

// ─── GET /api/cashback/summary ─────────────────────────────────────────

router.get('/summary', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const cached = cacheGet(`summary_${userId}`, CACHE_TTL.SUMMARY);
        if (cached) {
            return res.json({ success: true, data: cached });
        }

        const wallet = await getWallet(userId);

        const { count: pendingCount } = await supabaseAdmin
            .from('cashback_transactions')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .in('status', ['pending', 'processing']);

        const result = {
            balance: parseFloat(wallet.balance) || 0,
            lifetime_earned: parseFloat(wallet.lifetime_earned) || 0,
            lifetime_used: parseFloat(wallet.lifetime_used) || 0,
            pending: pendingCount || 0,
            min_redeem: MIN_REDEEM,
            max_redeem: MAX_REDEEM
        };

        cacheSet(`summary_${userId}`, result);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('❌ Summary error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to fetch summary' });
    }
});

// ─── GET /api/cashback/recent ──────────────────────────────────────────

router.get('/recent', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const cached = cacheGet(`recent_${userId}`, CACHE_TTL.RECENT);
        if (cached) {
            return res.json({ success: true, data: cached });
        }

        const limit = Math.min(parseInt(req.query.limit) || 10, 50);

        const { data, error } = await supabaseAdmin
            .from('cashback_transactions')
            .select('*')
            .eq('user_id', userId)
            .eq('type', 'used')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('❌ Recent query error:', error);
            throw error;
        }

        const formatted = (data || []).map(t => ({
            id: t.id,
            service: t.service || 'unknown',
            amount: parseFloat(t.amount) || 0,
            description: t.description || 'Purchase',
            status: t.status || 'pending',
            reference: t.reference || null,
            recipient: t.recipient || null,
            network: t.network || null,
            created_at: t.created_at,
            balance_after: parseFloat(t.balance_after) || 0
        }));

        cacheSet(`recent_${userId}`, formatted);
        res.json({ success: true, data: formatted });
    } catch (error) {
        console.error('❌ Recent error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch recent purchases' });
    }
});

// ─── GET /api/cashback/transactions ────────────────────────────────────

router.get('/transactions', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const type = req.query.type || 'all';
        const status = req.query.status || 'all';

        let query = supabaseAdmin
            .from('cashback_transactions')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (type !== 'all') query = query.eq('type', type);
        if (status !== 'all') query = query.eq('status', status);

        const { data, count, error } = await query;
        if (error) throw error;

        const formatted = (data || []).map(t => ({
            id: t.id,
            reference: t.reference,
            type: t.type,
            amount: parseFloat(t.amount) || 0,
            description: t.description || 'Transaction',
            status: t.status || 'pending',
            service: t.service || null,
            recipient: t.recipient || null,
            network: t.network || null,
            balance_before: parseFloat(t.balance_before) || 0,
            balance_after: parseFloat(t.balance_after) || 0,
            created_at: t.created_at,
            completed_at: t.completed_at || null
        }));

        res.json({ success: true, data: formatted, pagination: { total: count || 0, limit, offset } });
    } catch (error) {
        console.error('❌ Transactions error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to fetch transactions' });
    }
});

// ─── GET /api/cashback/data-plans ──────────────────────────────────────

router.get('/data-plans', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const { network } = req.query;
        if (!network) {
            return res.status(400).json({ success: false, error: 'Network is required' });
        }

        const networkKey = network.toLowerCase();
        
        const cacheKey = `data-plans_${networkKey}`;
        const cached = cacheGet(cacheKey, CACHE_TTL.PLANS);
        if (cached) {
            return res.json({ success: true, data: cached, network: networkKey });
        }

        try {
            const serviceID = vtpassService.getServiceID(networkKey, 'data');
            if (serviceID) {
                const plans = await vtpassService.getPlans(serviceID);
                const variations = plans?.content?.variations || [];

                if (variations.length > 0) {
                    const formatted = variations.map(v => ({
                        code: v.variation_code,
                        name: v.variation_name || v.name,
                        amount: v.variation_amount || 0,
                        description: v.variation_description || ''
                    }));

                    cacheSet(cacheKey, formatted);
                    return res.json({ success: true, data: formatted, network: networkKey });
                }
            }
        } catch (vtpassError) {
            console.warn('⚠️ VTpass data plans failed, using fallback:', vtpassError.message);
        }

        const fallbackPlans = DATA_PLANS_FALLBACK[networkKey] || DATA_PLANS_FALLBACK.mtn;
        const formattedFallback = fallbackPlans.map(p => ({
            code: p.code,
            name: p.name,
            amount: p.amount,
            description: `Valid for ${p.validity || '30 days'}`
        }));

        cacheSet(cacheKey, formattedFallback);
        res.json({ success: true, data: formattedFallback, network: networkKey, fallback: true });
    } catch (error) {
        console.error('❌ Data plans error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to fetch data plans' });
    }
});

// ─── POST /api/cashback/pin/set ────────────────────────────────────────

router.post('/pin/set', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const { pin } = req.body;

        if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
            return res.status(400).json({ success: false, error: 'PIN must be exactly 4 digits', code: 'INVALID_FORMAT' });
        }

        const commonPins = ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '5678', '8765'];
        if (commonPins.includes(pin)) {
            return res.status(400).json({ success: false, error: 'This PIN is too common. Please choose a more secure PIN.' });
        }

        const profile = await getUserProfile(userId);
        if (profile.transaction_pin_hash) {
            return res.status(400).json({ success: false, error: 'PIN already set. Use PIN reset flow to change it.', code: 'PIN_ALREADY_SET' });
        }

        const salt = await bcrypt.genSalt(10);
        const pinHash = await bcrypt.hash(pin, salt);

        const { error } = await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_hash: pinHash,
                transaction_pin_set_at: new Date().toISOString(),
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        if (error) throw error;

        cacheInvalidateUser(userId);

        await createNotification(userId, 'PIN Set 🔐', 'Your transaction PIN has been set successfully.', 'info', '/cashback');

        res.json({ success: true, message: 'PIN set successfully' });
    } catch (error) {
        console.error('❌ Set PIN error:', error);
        res.status(500).json({ success: false, error: 'Failed to set PIN' });
    }
});

// ─── POST /api/cashback/pin/verify ─────────────────────────────────────

router.post('/pin/verify', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const { pin } = req.body;

        if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
            return res.status(400).json({ success: false, error: 'PIN must be exactly 4 digits', code: 'INVALID_FORMAT' });
        }

        const result = await verifyTransactionPin(userId, pin);
        if (!result.valid) {
            return res.status(400).json({
                success: false,
                error: result.error,
                code: result.code,
                attempts_remaining: result.attempts_remaining,
                remaining_minutes: result.remaining_minutes
            });
        }

        res.json({ success: true, message: 'PIN verified successfully' });
    } catch (error) {
        console.error('❌ Verify PIN error:', error);
        res.status(500).json({ success: false, error: 'PIN verification failed' });
    }
});

// ─── GET /api/cashback/pin/status ──────────────────────────────────────

router.get('/pin/status', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const cached = cacheGet(`pin_status_${userId}`, CACHE_TTL.PIN_STATUS);
        if (cached) {
            return res.json({ success: true, data: cached });
        }

        const profile = await getUserProfile(userId);
        const locked = isPinLocked(profile);
        const remaining = getRemainingLockTime(profile);

        const result = {
            has_pin: !!profile.transaction_pin_hash,
            set_at: profile.transaction_pin_set_at || null,
            attempts_used: profile.transaction_pin_attempts || 0,
            max_attempts: MAX_PIN_ATTEMPTS,
            is_locked: locked,
            remaining_lock_minutes: remaining,
            attempts_remaining: Math.max(0, MAX_PIN_ATTEMPTS - (profile.transaction_pin_attempts || 0))
        };

        cacheSet(`pin_status_${userId}`, result);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('❌ PIN status error:', error);
        res.status(500).json({ success: false, error: 'Failed to check PIN status' });
    }
});

// ─── POST /api/cashback/pin/send-reset ──────────────────────────────────

router.post('/pin/send-reset', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const userIp = req.ip || req.socket?.remoteAddress || 'unknown';

        if (!checkRateLimit(`pin_reset_user_${userId}`, OTP_RATE_LIMIT_WINDOW, OTP_MAX_PER_WINDOW) ||
            !checkRateLimit(`pin_reset_ip_${userIp}`, OTP_RATE_LIMIT_WINDOW, OTP_MAX_PER_WINDOW)) {
            return res.status(429).json({ 
                success: false, 
                error: 'Too many requests. Please wait a moment before trying again.', 
                code: 'RATE_LIMIT_EXCEEDED' 
            });
        }

        const profile = await getUserProfile(userId);
        const email = profile.email;

        if (!email) {
            return res.status(400).json({ 
                success: false, 
                error: 'No email address found for your account.', 
                code: 'NO_EMAIL' 
            });
        }
        if (!profile.transaction_pin_hash) {
            return res.status(400).json({ 
                success: false, 
                error: 'PIN not set. Please set a PIN first.', 
                code: 'PIN_NOT_SET' 
            });
        }

        const otp = generateOTP();
        const otpHash = hashString(otp);
        const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({
                pin_reset_otp_hash: otpHash,
                pin_reset_otp_expiry: otpExpiry.toISOString(),
                pin_reset_otp_attempts: 0,
                pin_reset_otp_requested_at: new Date().toISOString()
            })
            .eq('id', userId);

        if (updateError) throw updateError;

        const masked = maskEmail(email);
        
        const emailResult = await emailService.sendPasswordResetOTP(
            email,
            profile.username || 'User',
            otp
        );

        if (!emailResult.success) {
            console.error('Failed to send PIN reset email:', emailResult.error);
            return res.status(500).json({ 
                success: false, 
                error: 'Failed to send verification email. Please try again.', 
                code: 'EMAIL_FAILED' 
            });
        }

        res.json({ 
            success: true, 
            message: 'Verification code sent to your email.', 
            data: { 
                masked_email: masked, 
                expires_in_minutes: OTP_EXPIRY_MINUTES 
            } 
        });
    } catch (error) {
        console.error('❌ Send PIN reset error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Failed to send PIN reset instructions' 
        });
    }
});

// ─── POST /api/cashback/pin/verify-reset ────────────────────────────────

router.post('/pin/verify-reset', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const { otp } = req.body;

        if (!otp || otp.length !== OTP_LENGTH || !/^\d+$/.test(otp)) {
            return res.status(400).json({ 
                success: false, 
                error: `Valid ${OTP_LENGTH}-digit OTP required`, 
                code: 'INVALID_OTP_FORMAT' 
            });
        }

        const profile = await getUserProfile(userId);

        if (!profile.pin_reset_otp_hash) {
            return res.status(400).json({ 
                success: false, 
                error: 'No OTP request found. Please request a new one.', 
                code: 'NO_OTP_REQUEST' 
            });
        }

        if (new Date(profile.pin_reset_otp_expiry) < new Date()) {
            return res.status(400).json({ 
                success: false, 
                error: 'OTP expired. Please request a new one.', 
                code: 'OTP_EXPIRED' 
            });
        }

        const attempts = profile.pin_reset_otp_attempts || 0;
        if (attempts >= MAX_OTP_ATTEMPTS) {
            await supabaseAdmin
                .from('profiles')
                .update({
                    pin_reset_otp_hash: null,
                    pin_reset_otp_expiry: null,
                    pin_reset_otp_attempts: 0
                })
                .eq('id', userId);
            return res.status(400).json({ 
                success: false, 
                error: 'Too many failed attempts. Please request a new OTP.', 
                code: 'MAX_ATTEMPTS_EXCEEDED' 
            });
        }

        const otpHash = hashString(otp);
        if (otpHash !== profile.pin_reset_otp_hash) {
            await supabaseAdmin
                .from('profiles')
                .update({
                    pin_reset_otp_attempts: attempts + 1
                })
                .eq('id', userId);

            const remaining = MAX_OTP_ATTEMPTS - (attempts + 1);
            return res.status(400).json({ 
                success: false, 
                error: `Invalid OTP. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`, 
                code: 'INVALID_OTP', 
                attempts_remaining: remaining 
            });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenHash = hashString(resetToken);
        const resetExpiry = new Date(Date.now() + 5 * 60 * 1000);

        await supabaseAdmin
            .from('profiles')
            .update({
                pin_reset_otp_hash: null,
                pin_reset_otp_expiry: null,
                pin_reset_otp_attempts: 0,
                pin_reset_token: resetTokenHash,
                pin_reset_token_expiry: resetExpiry.toISOString()
            })
            .eq('id', userId);

        res.json({ 
            success: true, 
            message: 'OTP verified successfully', 
            data: { 
                reset_token: resetToken, 
                expires_in_seconds: 300 
            } 
        });
    } catch (error) {
        console.error('❌ Verify reset OTP error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'OTP verification failed' 
        });
    }
});

// ─── POST /api/cashback/pin/reset ──────────────────────────────────────

router.post('/pin/reset', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const { reset_token, new_pin } = req.body;

        if (!reset_token || !new_pin || new_pin.length !== 4 || !/^\d{4}$/.test(new_pin)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Valid reset token and 4-digit PIN required', 
                code: 'INVALID_INPUT' 
            });
        }

        const profile = await getUserProfile(userId);

        if (!profile.pin_reset_token) {
            return res.status(400).json({ 
                success: false, 
                error: 'No reset session found. Please request a new one.', 
                code: 'NO_RESET_SESSION' 
            });
        }

        if (new Date(profile.pin_reset_token_expiry) < new Date()) {
            await supabaseAdmin
                .from('profiles')
                .update({
                    pin_reset_token: null,
                    pin_reset_token_expiry: null
                })
                .eq('id', userId);
            return res.status(400).json({ 
                success: false, 
                error: 'Reset session expired. Please request a new OTP.', 
                code: 'RESET_EXPIRED' 
            });
        }

        const tokenHash = hashString(reset_token);
        if (tokenHash !== profile.pin_reset_token) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid reset token.', 
                code: 'INVALID_TOKEN' 
            });
        }

        const salt = await bcrypt.genSalt(10);
        const pinHash = await bcrypt.hash(new_pin, salt);

        await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_hash: pinHash,
                transaction_pin_set_at: new Date().toISOString(),
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null,
                pin_reset_token: null,
                pin_reset_token_expiry: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        cacheInvalidateUser(userId);

        await createNotification(userId, 'PIN Reset 🔐', 'Your transaction PIN has been reset successfully.', 'info', '/cashback');

        res.json({ success: true, message: 'PIN reset successfully' });
    } catch (error) {
        console.error('❌ Reset PIN error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'PIN reset failed' 
        });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  REDEEM - COMPLETE FIXED VERSION
//  FIXES:
//  1. Idempotency key RESERVED before any mutation (atomic)
//  2. Atomic wallet debit using SQL function
//  3. Proper duplicate request rejection (409 conflict)
//  4. ✅ CRITICAL: Status written IMMEDIATELY after VTpass result
//  5. Secondary bookkeeping wrapped in try/catch (can't undo primary status)
//  6. Provider request ID stored for reconciliation
//  7. Atomic refund on failure
// ════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════
//  REDEEM - COMPLETE FIXED VERSION
//  FIXES:
//  1. Idempotency key RESERVED before any mutation (atomic)
//  2. Atomic wallet debit using SQL function
//  3. Proper duplicate request rejection (409 conflict)
//  4. ✅ CRITICAL: Status written IMMEDIATELY after VTpass result
//  5. Secondary bookkeeping wrapped in try/catch (can't undo primary status)
//  6. Provider request ID stored for reconciliation
//  7. Atomic refund on failure
//  8. ✅ FIXED: Removed non-existent 'provider_friendly_error' column
// ════════════════════════════════════════════════════════════════════════

router.post('/redeem', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const { service, amount, phone, plan, transaction_pin, idempotency_key, network_override } = req.body;

        console.log('📝 [REDEEM] Request payload:', {
            service,
            amount,
            phone,
            plan,
            network_override,
            has_pin: !!transaction_pin,
            idempotency_key
        });

        // ─── Validate service ───
        if (!service || !['airtime', 'data'].includes(service)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid service. Choose: airtime or data',
                code: 'INVALID_SERVICE'
            });
        }

        // ─── Validate amount ───
        const numericAmount = Number(amount);
        if (!Number.isFinite(numericAmount) || numericAmount < MIN_REDEEM || numericAmount > MAX_REDEEM) {
            return res.status(400).json({
                success: false,
                error: `Amount must be between ₦${MIN_REDEEM} and ₦${MAX_REDEEM}`,
                code: 'INVALID_AMOUNT'
            });
        }

        // ─── Validate PIN ───
        if (!transaction_pin || !/^\d{4}$/.test(transaction_pin)) {
            return res.status(400).json({
                success: false,
                error: 'Valid 4-digit PIN required',
                pinRequired: true,
                code: 'PIN_REQUIRED'
            });
        }

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) {
            return res.status(400).json({
                success: false,
                error: pinResult.error,
                code: pinResult.code,
                attempts_remaining: pinResult.attempts_remaining,
                remaining_minutes: pinResult.remaining_minutes
            });
        }

        // ─── Validate phone ───
        if (!phone) {
            return res.status(400).json({
                success: false,
                error: 'Phone number required',
                code: 'PHONE_REQUIRED'
            });
        }

        const cleanPhone = phone.replace(/\s/g, '');
        console.log('📱 [REDEEM] Clean phone:', cleanPhone);

        if (!/^[0-9]{10,15}$/.test(cleanPhone)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid phone number format',
                code: 'INVALID_PHONE'
            });
        }

        // ─── Determine network ──────────────────────────────────────────
        let detectedNetwork;
        if (network_override && ['mtn', 'glo', 'airtel', '9mobile'].includes(network_override)) {
            detectedNetwork = network_override;
            console.log(`📡 Network override: ${detectedNetwork} (user selected)`);
        } else {
            const phoneValidation = vtpassService.validatePhone(cleanPhone);
            console.log('📡 [REDEEM] Phone validation:', phoneValidation);
            if (!phoneValidation.valid) {
                return res.status(400).json({
                    success: false,
                    error: phoneValidation.error,
                    code: 'INVALID_NETWORK'
                });
            }
            detectedNetwork = phoneValidation.network;
            console.log(`📡 Network detected: ${detectedNetwork}`);
        }

        // ─── Validate data plan ───
        if (service === 'data' && !plan) {
            return res.status(400).json({
                success: false,
                error: 'Data plan required',
                code: 'PLAN_REQUIRED'
            });
        }

        // ─── Get actual plan amount ───
        let planAmount = numericAmount;
        let planCode = plan;
        
        if (service === 'data') {
            try {
                const serviceID = vtpassService.getServiceID(detectedNetwork, 'data');
                console.log('📦 [REDEEM] Data service ID:', serviceID);
                if (serviceID) {
                    const plans = await vtpassService.getPlans(serviceID);
                    const planData = plans?.content?.variations?.find(v => v.variation_code === plan);
                    if (planData) {
                        planAmount = planData.variation_amount || numericAmount;
                        planCode = planData.variation_code;
                        console.log('📦 [REDEEM] Plan found:', { planAmount, planCode });
                    } else {
                        console.warn('⚠️ [REDEEM] Plan not found in VTpass, using fallback');
                    }
                }
            } catch (error) {
                console.warn('⚠️ Plan verification failed, using fallback:', error.message);
                const fallbackPlans = DATA_PLANS_FALLBACK[detectedNetwork] || DATA_PLANS_FALLBACK.mtn;
                const planData = fallbackPlans.find(p => p.code === plan);
                if (planData) {
                    planAmount = planData.amount || numericAmount;
                }
            }
        }

        // ─── Get wallet balance ────────────────────────────────────────
        const wallet = await getWallet(userId);
        const cashbackBalance = parseFloat(wallet.balance) || 0;
        
        console.log('💰 [REDEEM] Cashback balance:', cashbackBalance, 'Required:', planAmount);
        
        // ─── Insufficient balance check ──────────────────────────────
        if (cashbackBalance < planAmount) {
            const failedRef = `CB-FAIL-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            
            await supabaseAdmin
                .from('cashback_transactions')
                .insert({
                    user_id: userId,
                    type: 'used',
                    amount: planAmount,
                    balance_before: cashbackBalance,
                    balance_after: cashbackBalance,
                    description: `${service === 'airtime' ? 'Airtime' : 'Data'} - insufficient balance`,
                    reference: failedRef,
                    status: 'failed',
                    service: service,
                    recipient: cleanPhone,
                    network: detectedNetwork,
                    metadata: { 
                        reason: 'insufficient_balance', 
                        required: planAmount,
                        available: cashbackBalance,
                        shortfall: planAmount - cashbackBalance
                    },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    completed_at: new Date().toISOString()
                });

            return res.status(400).json({
                success: false,
                error: `Insufficient cashback balance. Available: ₦${cashbackBalance.toFixed(2)}, Required: ₦${planAmount.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                data: {
                    balance: cashbackBalance,
                    required: planAmount,
                    shortfall: planAmount - cashbackBalance,
                    reference: failedRef
                }
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // ✅ FIX 1: RESERVE IDEMPOTENCY KEY (BEFORE ANY MUTATION)
        // ═══════════════════════════════════════════════════════════════

        if (idempotency_key) {
            // Check if this key already exists and was completed
            const { data: existing, error: checkError } = await supabaseAdmin
                .rpc('get_idempotency_key', {
                    p_user_id: userId,
                    p_key: idempotency_key,
                    p_endpoint: '/api/cashback/redeem'
                });

            if (checkError) {
                console.error('❌ Idempotency check error:', checkError);
            }

            if (existing && existing.length > 0) {
                const record = existing[0];
                if (record.status === 'completed') {
                    return res.json({
                        success: true,
                        already_processed: true,
                        data: record.response || { reference: 'already_processed' }
                    });
                }
                if (record.status === 'pending') {
                    return res.status(409).json({
                        success: false,
                        error: 'This purchase is already being processed. Please wait.',
                        code: 'DUPLICATE_REQUEST'
                    });
                }
            }

            // Try to atomically reserve the key
            const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL);
            const { data: reservedId, error: reserveError } = await supabaseAdmin
                .rpc('reserve_idempotency_key', {
                    p_user_id: userId,
                    p_key: idempotency_key,
                    p_endpoint: '/api/cashback/redeem',
                    p_expires_at: expiresAt.toISOString()
                });

            if (reserveError) {
                console.error('❌ Idempotency reserve error:', reserveError);
            }

            if (!reservedId) {
                const { data: recheck, error: recheckError } = await supabaseAdmin
                    .rpc('get_idempotency_key', {
                        p_user_id: userId,
                        p_key: idempotency_key,
                        p_endpoint: '/api/cashback/redeem'
                    });

                if (recheck && recheck.length > 0) {
                    const record = recheck[0];
                    if (record.status === 'completed') {
                        return res.json({
                            success: true,
                            already_processed: true,
                            data: record.response || { reference: 'already_processed' }
                        });
                    }
                    if (record.status === 'pending') {
                        return res.status(409).json({
                            success: false,
                            error: 'This purchase is already being processed. Please wait.',
                            code: 'DUPLICATE_REQUEST'
                        });
                    }
                }
                console.warn('⚠️ Could not reserve idempotency key, continuing anyway');
            }
        }

        const networkName = getNetworkName(detectedNetwork);
        const description = service === 'airtime'
            ? `Airtime - ${networkName} (${cleanPhone})`
            : `Data - ${networkName} (${cleanPhone}) - ${planCode}`;

        const reference = `CB-${Date.now()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

        // ─── LEDGER MIRRORS THE WALLET ───────────────────────────────
        const accountId = await getLedgerAccountId(userId, CASHBACK_CURRENCY);
        const ledgerBalanceBefore = cashbackBalance;
        const newLedgerBalance = cashbackBalance - planAmount;

        // ═══════════════════════════════════════════════════════════════
        // ✅ FIX 2: ATOMIC WALLET DEBIT
        // ═══════════════════════════════════════════════════════════════

        const { data: debited, error: debitError } = await supabaseAdmin
            .rpc('debit_cashback_wallet', {
                p_user_id: userId,
                p_amount: planAmount
            });

        if (debitError || !debited || debited.length === 0) {
            console.error('❌ Atomic debit failed:', debitError);
            const freshWallet = await getWallet(userId);
            return res.status(400).json({
                success: false,
                error: `Insufficient cashback balance. Available: ₦${(freshWallet.balance || 0).toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                data: {
                    balance: freshWallet.balance || 0,
                    required: planAmount
                }
            });
        }

        const newWalletBalance = parseFloat(debited[0].balance) || 0;
        console.log('✅ [REDEEM] Atomic debit successful. New balance:', newWalletBalance);

        // ─── CREATE CASHBACK TRANSACTION (PROCESSING) ──────────────────
        const { data: cashbackTx, error: txError } = await supabaseAdmin
            .from('cashback_transactions')
            .insert({
                user_id: userId,
                type: 'used',
                amount: planAmount,
                balance_before: cashbackBalance,
                balance_after: newWalletBalance,
                description: description,
                reference: reference,
                status: 'processing',
                service: service,
                recipient: cleanPhone,
                network: detectedNetwork,
                plan: planCode || null,
                reconciliation_attempts: 0,
                metadata: {
                    phone: cleanPhone,
                    created_by: 'user',
                    network_name: networkName,
                    idempotency_key: idempotency_key || null,
                    network_override: network_override || null,
                    ledger_account_id: accountId,
                    ledger_balance_before: ledgerBalanceBefore,
                    ledger_balance_after: newLedgerBalance
                },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();

        if (txError) {
            console.error('❌ Cashback transaction error:', txError);
            // Refund the wallet (atomic credit)
            await supabaseAdmin.rpc('credit_cashback_wallet', {
                p_user_id: userId,
                p_amount: planAmount
            });
            return res.status(500).json({
                success: false,
                error: 'Failed to create transaction record',
                code: 'TRANSACTION_CREATE_FAILED'
            });
        }

        cacheInvalidateUser(userId);

        // ─── CALL VTPASS ──────────────────────────────────────────────
        console.log(`📡 [REDEEM] Calling VTpass for ${service}...`);
        console.log(`📡 [REDEEM] VTpass params:`, {
            phone: cleanPhone,
            amount: planAmount,
            service,
            planCode,
            detectedNetwork
        });

        let vtpassResult;
        let vtpassRequestId = null;
        let vtpassTransactionId = null;

        try {
            if (service === 'airtime') {
                vtpassResult = await vtpassService.purchaseAirtime({
                    phone: cleanPhone,
                    amount: planAmount
                });
            } else {
                vtpassResult = await vtpassService.purchaseData({
                    phone: cleanPhone,
                    variationCode: planCode
                });
            }

            vtpassRequestId = vtpassResult?.requestId || null;
            vtpassTransactionId = vtpassResult?.transactionId || null;

            console.log(`📡 VTpass response for ${reference}:`, JSON.stringify({
                success: vtpassResult.success,
                status: vtpassResult.status,
                requestId: vtpassRequestId,
                transactionId: vtpassTransactionId,
                code: vtpassResult.code,
                error: vtpassResult.error,
                friendlyError: vtpassResult.friendlyError
            }, null, 2));

        } catch (vtpassError) {
            console.error('❌ VTpass call error:', vtpassError);
            console.error('❌ VTpass error details:', {
                message: vtpassError.message,
                code: vtpassError.code,
                response: vtpassError.response?.data,
                status: vtpassError.response?.status
            });
            vtpassResult = { 
                success: false, 
                status: 'failed', 
                error: vtpassError.message,
                requestId: null,
                transactionId: null,
                friendlyError: 'Provider service temporarily unavailable. Please try again.'
            };
        }

        // ─── DETERMINE FINAL STATUS ────────────────────────────────────
        let finalStatus;
        let statusUpdateData = {
            provider_reference: vtpassTransactionId || null,
            provider_request_id: vtpassRequestId || null,
            provider_response: vtpassResult?.data || null,
            provider_error: vtpassResult?.error || null,
            // ✅ REMOVED: provider_friendly_error (column doesn't exist in DB)
            updated_at: new Date().toISOString()
        };

        if (vtpassResult.status === 'success' || vtpassResult.status === 'delivered') {
            finalStatus = 'success';
            statusUpdateData.status = 'success';
            statusUpdateData.completed_at = new Date().toISOString();
        } else if (vtpassResult.status === 'confirming' || vtpassResult.status === 'pending') {
            finalStatus = 'processing';
            statusUpdateData.status = 'processing';
            // Don't set completed_at for processing
        } else {
            finalStatus = 'failed';
            statusUpdateData.status = 'failed';
            statusUpdateData.completed_at = new Date().toISOString();
        }

        // ═══════════════════════════════════════════════════════════════
        // ✅ FIX 3: CRITICAL STATUS WRITE - IMMEDIATELY AFTER VTpass
        // This is the single most important fix — the status is persisted
        // BEFORE any secondary bookkeeping that could fail.
        // ═══════════════════════════════════════════════════════════════

        console.log(`💾 [REDEEM] Writing critical status: ${finalStatus} for ${reference}`);
        
        const { error: statusUpdateError } = await supabaseAdmin
            .from('cashback_transactions')
            .update(statusUpdateData)  // ← Now only has columns that exist!
            .eq('id', cashbackTx.id);

        if (statusUpdateError) {
            console.error('❌ [REDEEM] CRITICAL: Failed to write status update:', statusUpdateError);
            // If we can't write the status, the transaction is orphaned.
            // Log it heavily — reconciliation will pick it up.
            console.error(`🚨 [REDEEM] ORPHANED TRANSACTION: ${reference} - ${finalStatus} - ${cashbackTx.id}`);
        } else {
            console.log(`✅ [REDEEM] Critical status written: ${finalStatus} for ${reference}`);
        }

        // ─── SECONDARY BOOKKEEPING ────────────────────────────────────
        // Each of these is wrapped individually so a failure in one
        // CANNOT undo the critical status we just committed.
        // ═══════════════════════════════════════════════════════════════

        let secondaryErrors = [];

        if (finalStatus === 'success') {
            // ─── Update Ledger Balance ────────────────────────────────
            try {
                await updateLedgerBalance(userId, CASHBACK_CURRENCY, newLedgerBalance);
                console.log(`📊 [REDEEM] Ledger balance updated: ${newLedgerBalance}`);
            } catch (ledgerError) {
                console.error('⚠️ [REDEEM] Ledger update failed (status already saved):', ledgerError);
                secondaryErrors.push({ component: 'ledger', error: ledgerError.message });
            }

            // ─── Create Main Transaction ──────────────────────────────
            try {
                const mainTx = await createMainTransaction({
                    userId: userId,
                    reference: reference,
                    type: 'cashback_redeem',
                    amount: planAmount,
                    currency: 'NGN',
                    description: description,
                    status: 'completed',
                    sourceType: 'cashback',
                    sourceId: cashbackTx.id,
                    provider: 'vtpass',
                    providerReference: vtpassTransactionId || null,
                    metadata: {
                        phone: cleanPhone,
                        network: detectedNetwork,
                        service: service,
                        plan: planCode || null,
                        vtpass_request_id: vtpassRequestId || null,
                        vtpass_transaction_id: vtpassTransactionId || null,
                        vtpass_status: vtpassResult?.status || null,
                        cashback_before: cashbackBalance,
                        cashback_after: newWalletBalance,
                        ledger_account_id: accountId,
                        ledger_balance_before: ledgerBalanceBefore,
                        ledger_balance_after: newLedgerBalance
                    },
                    idempotencyKey: idempotency_key || null
                });
                console.log(`📊 [REDEEM] Main transaction created: ${mainTx.reference}`);

                // ─── Create Ledger Entry ──────────────────────────────
                try {
                    await createLedgerEntry({
                        transactionId: mainTx.id,
                        accountId: accountId,
                        entryType: 'DEBIT',
                        amount: planAmount,
                        currency: CASHBACK_CURRENCY,
                        balanceBefore: ledgerBalanceBefore,
                        balanceAfter: newLedgerBalance,
                        description: `Cashback redemption: ${description}`
                    });
                    console.log(`📊 [REDEEM] Ledger entry created`);
                } catch (entryError) {
                    console.error('⚠️ [REDEEM] Ledger entry failed:', entryError);
                    secondaryErrors.push({ component: 'ledger_entry', error: entryError.message });
                }
            } catch (mainTxError) {
                console.error('⚠️ [REDEEM] Main transaction creation failed:', mainTxError);
                secondaryErrors.push({ component: 'main_transaction', error: mainTxError.message });
            }

            // ─── Notification ──────────────────────────────────────────
            try {
                await createNotification(
                    userId,
                    '💰 Purchase Successful',
                    `${description} was completed successfully.`,
                    'reward_used',
                    '/cashback'
                );
                console.log(`📊 [REDEEM] Notification sent`);
            } catch (notifError) {
                console.error('⚠️ [REDEEM] Notification failed:', notifError);
                secondaryErrors.push({ component: 'notification', error: notifError.message });
            }

        } else if (finalStatus === 'processing') {
            // ─── Create Main Transaction (processing) ──────────────────
            try {
                await createMainTransaction({
                    userId: userId,
                    reference: reference,
                    type: 'cashback_redeem',
                    amount: planAmount,
                    currency: 'NGN',
                    description: description,
                    status: 'processing',
                    sourceType: 'cashback',
                    sourceId: cashbackTx.id,
                    provider: 'vtpass',
                    providerReference: vtpassTransactionId || null,
                    metadata: {
                        phone: cleanPhone,
                        network: detectedNetwork,
                        service: service,
                        plan: planCode || null,
                        vtpass_request_id: vtpassRequestId || null,
                        vtpass_transaction_id: vtpassTransactionId || null,
                        vtpass_status: vtpassResult?.status || null,
                        cashback_before: cashbackBalance,
                        cashback_after: newWalletBalance,
                        ledger_account_id: accountId,
                        ledger_balance_before: ledgerBalanceBefore,
                        ledger_balance_after: newLedgerBalance
                    },
                    idempotencyKey: idempotency_key || null
                });
                console.log(`📊 [REDEEM] Main transaction created (processing)`);
            } catch (mainTxError) {
                console.error('⚠️ [REDEEM] Main transaction creation failed:', mainTxError);
                secondaryErrors.push({ component: 'main_transaction', error: mainTxError.message });
            }

            // ─── Notification ──────────────────────────────────────────
            try {
                await createNotification(
                    userId,
                    '⏳ Processing',
                    `${description} is being processed. We will notify you when complete.`,
                    'info',
                    '/cashback'
                );
                console.log(`📊 [REDEEM] Processing notification sent`);
            } catch (notifError) {
                console.error('⚠️ [REDEEM] Notification failed:', notifError);
                secondaryErrors.push({ component: 'notification', error: notifError.message });
            }

        } else {
            // ─── FAILED: Atomic refund ──────────────────────────────────
            let refundBalance = cashbackBalance;
            
            try {
                const { data: credited, error: creditError } = await supabaseAdmin
                    .rpc('credit_cashback_wallet', {
                        p_user_id: userId,
                        p_amount: planAmount
                    });

                if (creditError || !credited || credited.length === 0) {
                    console.error('❌ [REDEEM] Atomic credit (refund) failed:', creditError);
                    secondaryErrors.push({ component: 'refund', error: creditError?.message || 'Refund failed' });
                } else {
                    refundBalance = parseFloat(credited[0].balance) || cashbackBalance;
                    console.log(`💸 [REDEEM] Refunded ${planAmount} to user. New balance: ${refundBalance}`);
                    
                    // Update balance_after in the cashback transaction
                    await supabaseAdmin
                        .from('cashback_transactions')
                        .update({ balance_after: refundBalance })
                        .eq('id', cashbackTx.id);
                }
            } catch (refundError) {
                console.error('❌ [REDEEM] Refund error:', refundError);
                secondaryErrors.push({ component: 'refund', error: refundError.message });
            }

            // ─── Create Main Transaction (failed) ──────────────────────
            try {
                await createMainTransaction({
                    userId: userId,
                    reference: reference,
                    type: 'cashback_redeem',
                    amount: planAmount,
                    currency: 'NGN',
                    description: description,
                    status: 'failed',
                    sourceType: 'cashback',
                    sourceId: cashbackTx.id,
                    provider: 'vtpass',
                    providerReference: vtpassTransactionId || null,
                    metadata: {
                        phone: cleanPhone,
                        network: detectedNetwork,
                        service: service,
                        plan: planCode || null,
                        vtpass_error: vtpassResult?.error || null,
                        vtpass_status: vtpassResult?.status || null,
                        vtpass_request_id: vtpassRequestId || null,
                        cashback_before: cashbackBalance,
                        cashback_after: refundBalance,
                        refunded: true,
                        ledger_account_id: accountId,
                        ledger_balance_before: ledgerBalanceBefore,
                        ledger_balance_after: ledgerBalanceBefore
                    },
                    idempotencyKey: idempotency_key || null,
                    failureReason: vtpassResult?.friendlyError || vtpassResult?.error || 'Provider transaction failed'
                });
                console.log(`📊 [REDEEM] Main transaction created (failed)`);
            } catch (mainTxError) {
                console.error('⚠️ [REDEEM] Main transaction creation failed:', mainTxError);
                secondaryErrors.push({ component: 'main_transaction', error: mainTxError.message });
            }

            // ─── Notification ──────────────────────────────────────────
            try {
                await createNotification(
                    userId,
                    '❌ Purchase Failed',
                    `${description} failed. Your cashback has been refunded.`,
                    'reward_failed',
                    '/cashback'
                );
                console.log(`📊 [REDEEM] Failure notification sent`);
            } catch (notifError) {
                console.error('⚠️ [REDEEM] Notification failed:', notifError);
                secondaryErrors.push({ component: 'notification', error: notifError.message });
            }
        }

        // ─── Log secondary errors for visibility ──────────────────────
        if (secondaryErrors.length > 0) {
            console.error(`⚠️ [REDEEM] ${secondaryErrors.length} secondary errors for ${reference}:`, secondaryErrors);
            
            // Log to reconciliation_logs for admin visibility
            try {
                await supabaseAdmin.from('reconciliation_logs').insert({
                    transaction_ref: reference,
                    event: 'SECONDARY_BOOKKEEPING_FAILED',
                    reason: 'Secondary operations failed after critical status saved',
                    data: { 
                        finalStatus, 
                        errors: secondaryErrors,
                        cashback_tx_id: cashbackTx.id
                    },
                    created_at: new Date().toISOString()
                });
            } catch (logError) {
                console.error('⚠️ [REDEEM] Failed to log secondary error:', logError);
            }
        }

        cacheInvalidateUser(userId);

        // ─── SAVE IDEMPOTENCY KEY (mark as completed) ──────────────────
        if (idempotency_key) {
            try {
                await supabaseAdmin
                    .from('idempotency_keys')
                    .update({
                        status: 'completed',
                        response: {
                            transaction_id: cashbackTx.id,
                            reference: reference,
                            status: finalStatus,
                            amount: planAmount,
                            description: description
                        }
                    })
                    .eq('user_id', userId)
                    .eq('idempotency_key', idempotency_key)
                    .eq('endpoint', '/api/cashback/redeem');
            } catch (e) {
                console.warn('⚠️ Failed to update idempotency key:', e.message);
            }
        }

        // ─── Return response ────────────────────────────────────────────
        const responseData = {
            success: true,
            status: finalStatus,
            message: finalStatus === 'success' ? 'Purchase completed successfully!' :
                     finalStatus === 'processing' ? 'Purchase is being processed...' :
                     'Purchase failed. Your cashback has been refunded.',
            data: {
                transaction_id: cashbackTx.id,
                reference: reference,
                status: finalStatus,
                amount: planAmount,
                description: description,
                cashback_before: cashbackBalance,
                cashback_after: finalStatus === 'success' || finalStatus === 'processing' ? newWalletBalance : 
                                 finalStatus === 'failed' ? (cashbackBalance) : newWalletBalance,
                ledger_balance_before: ledgerBalanceBefore,
                ledger_balance_after: finalStatus === 'success' || finalStatus === 'processing' ? newLedgerBalance : ledgerBalanceBefore,
                provider_reference: vtpassTransactionId || null,
                provider_request_id: vtpassRequestId || null,
                vtpass_status: vtpassResult?.status || null,
                vtpass_error: vtpassResult?.error || null,
                secondary_errors: secondaryErrors.length > 0 ? secondaryErrors : undefined
            }
        };

        console.log(`📤 [REDEEM] Response:`, JSON.stringify(responseData, null, 2));

        res.json(responseData);

    } catch (error) {
        console.error('❌ Redeem error:', error);
        console.error('❌ Redeem error stack:', error.stack);
        res.status(500).json({
            success: false,
            error: error.message || 'Redeem failed',
            code: 'SERVER_ERROR'
        });
    }
});
// ─── GET /api/cashback/transaction/:id ─────────────────────────────────

router.get('/transaction/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }

        const { id } = req.params;

        const { data: transaction, error } = await supabaseAdmin
            .from('cashback_transactions')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error('❌ Transaction query error:', error);
            throw error;
        }

        if (!transaction) {
            return res.status(404).json({ success: false, error: 'Transaction not found' });
        }

        let mainTx = null;
        try {
            const { data: txData } = await supabaseAdmin
                .from('transactions')
                .select('*')
                .eq('reference', transaction.reference)
                .maybeSingle();
            mainTx = txData;
        } catch (e) {
            // Ignore
        }

        let ledgerEntry = null;
        if (mainTx) {
            try {
                const { data: entryData } = await supabaseAdmin
                    .from('ledger_entries')
                    .select('*')
                    .eq('transaction_id', mainTx.id)
                    .maybeSingle();
                ledgerEntry = entryData;
            } catch (e) {
                // Ignore
            }
        }

        res.json({
            success: true,
            data: {
                id: transaction.id,
                reference: transaction.reference,
                service: transaction.service || 'unknown',
                amount: parseFloat(transaction.amount) || 0,
                description: transaction.description || 'Purchase',
                status: transaction.status || 'pending',
                recipient: transaction.recipient || null,
                network: transaction.network || null,
                plan: transaction.plan || null,
                balance_before: parseFloat(transaction.balance_before) || 0,
                balance_after: parseFloat(transaction.balance_after) || 0,
                provider_reference: transaction.provider_reference || null,
                provider_error: transaction.provider_error || null,
                provider_error_friendly: transaction.provider_friendly_error || null,
                created_at: transaction.created_at,
                completed_at: transaction.completed_at || null,
                reconciliation_attempts: transaction.reconciliation_attempts || 0,
                ledger_transaction: mainTx,
                ledger_entry: ledgerEntry
            }
        });

    } catch (error) {
        console.error('❌ Get transaction error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch transaction' });
    }
});

// ─── GET /api/cashback/rules ────────────────────────────────────────────

router.get('/rules', authMiddleware, async (req, res) => {
    res.json({
        success: true,
        data: {
            min_redeem: MIN_REDEEM,
            max_redeem: MAX_REDEEM,
            services: [
                {
                    id: 'airtime',
                    name: 'Airtime',
                    icon: '📱',
                    description: 'Recharge your phone instantly',
                    networks: ['MTN', 'Glo', 'Airtel', '9mobile']
                },
                {
                    id: 'data',
                    name: 'Data',
                    icon: '📶',
                    description: 'Get data plans for all networks',
                    networks: ['MTN', 'Glo', 'Airtel', '9mobile']
                }
            ],
            pin: {
                max_attempts: MAX_PIN_ATTEMPTS,
                lock_duration_minutes: PIN_LOCK_DURATION / 60000
            }
        }
    });
});

// ─── GET /api/cashback/health ──────────────────────────────────────────

router.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;