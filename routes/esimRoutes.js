// routes/esimRoutes.js — COMPLETE PRODUCTION eSIM ROUTES
// Mounted at: /api/esim
// Webhook mounted separately at: /api/webhooks/dtone/esim
//
// PRICING AUTHORITY:
//   Every customer-facing price is recomputed from admin settings
//   on each request via adminSettingsService:
//     • esim_markup_pct_usd / esim_markup_pct_ngn → markup
//     • usd_to_ngn                               → FX
//     • service_esim_enabled                     → feature gate
//     • esim_min_ngn / esim_max_ngn              → per-order limits
//   There is no trust in any `selling_price_*` column anywhere.
//
// BALANCE SOURCE: profiles.wallet_ngn / wallet_usd
//   (matches /api/auth/me, /api/wallet/me, and the dashboard)
//
// HISTORY: reads esim_transactions, returns FULL detail per row
//   (QR, activation code, LPA string, serial, ICCID, install links)

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService } = require('../services/ledgerService');
const adminSettings = require('../services/adminSettingsService');
const emailService = require('../services/emailService');
const dtoneService = require('../services/dtoneService');

// ─── CONFIG ──────────────────────────────────────────────────────────────
const SERVICE_FEE_PCT = 0.02;
const CACHE_TTL = 5 * 60 * 1000;
const MAX_RECONCILE_ATTEMPTS = 20;
const MAX_AGE_MINUTES = 26 * 60;
const EMAIL_MAX_ATTEMPTS = 5;
const EMAIL_RETRY_BACKOFF_MIN = [2, 5, 15, 60, 240];
const QR_BUCKET = 'esim-qr';
const QR_SIGNED_URL_TTL_SEC = 60 * 60 * 24 * 7;
const STALE_SENDING_MS = 10 * 60 * 1000;

const MAX_PIN_ATTEMPTS = 4;
const PIN_LOCK_DURATION = 60 * 60 * 1000;

const cache = {
    countries: { data: null, timestamp: 0 },
    plans: new Map(),
    ttl: CACHE_TTL
};

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function makeErr(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    Object.assign(e, extra);
    return e;
}

// ════════════════════════════════════════════════════════════════════════
//  PRICING — resolved from admin settings
// ════════════════════════════════════════════════════════════════════════
//
// Compute the customer price for one plan. Uses the same integer-cent
// math as every other markup surface so the display, the preflight,
// and the debit can never disagree.
//
// Given a wholesale USD amount, returns { priceUsd, priceNgn, feeUsd,
// totalUsd, totalNgn, usdToNgn, markupUsd, markupNgn }.
async function resolveEsimPricing({ wholesaleUsd }) {
    const cost = Number(wholesaleUsd);
    if (!Number.isFinite(cost) || cost <= 0) {
        throw makeErr('PROVIDER_COST_MISSING',
            'Wholesale price is not configured for this plan.', 503);
    }

    // Markup is admin-controlled, USD and NGN tracked separately.
    const calcUsd = await adminSettings.calculatePrice({
        service: 'esim',
        currency: 'USD',
        wholesaleAmount: cost.toFixed(2)
    });
    const priceUsd = Number(calcUsd.customerPrice);
    const markupUsd = calcUsd.markup;

    // FX from admin settings.
    const usdToNgn = await adminSettings.getRate('USD', 'NGN');
    if (!Number.isFinite(usdToNgn) || usdToNgn <= 0) {
        throw makeErr('RATE_NOT_CONFIGURED',
            'USD→NGN rate is not configured.', 503);
    }

    // NGN price from its own admin markup, then reconciled with FX.
    // This mirrors how the plan list is displayed.
    const calcNgn = await adminSettings.calculatePrice({
        service: 'esim',
        currency: 'NGN',
        wholesaleAmount: (cost * usdToNgn).toFixed(2)
    });
    const priceNgn = Number(calcNgn.customerPrice);
    const markupNgn = calcNgn.markup;

    // Service fee (2%) is applied on top of the marked-up price, then
    // rounded to two decimals exactly like the customer sees it.
    const feeUsd = Number((priceUsd * SERVICE_FEE_PCT).toFixed(2));
    const totalUsd = Number((priceUsd + feeUsd).toFixed(2));
    const totalNgn = Number((priceNgn + (priceNgn * SERVICE_FEE_PCT)).toFixed(2));

    return {
        priceUsd,
        priceNgn,
        feeUsd,
        totalUsd,
        totalNgn,
        usdToNgn,
        markupUsd,
        markupNgn
    };
}

async function assertWithinLimits({ totalNgn, totalUsd, usdToNgn }) {
    const minNgn = Number(await adminSettings.getRaw('esim_min_ngn'));
    const maxNgn = Number(await adminSettings.getRaw('esim_max_ngn'));

    // The user picks a currency; enforce against the NGN equivalent
    // so the same limit works for both wallets.
    const ngnEquivalent = Number.isFinite(totalNgn)
        ? totalNgn
        : Number(totalUsd) * usdToNgn;

    if (Number.isFinite(minNgn) && minNgn > 0 && ngnEquivalent < minNgn) {
        throw makeErr('BELOW_MIN_LIMIT',
            `Minimum eSIM order is ₦${minNgn.toFixed(2)}.`,
            400, { min_ngn: minNgn });
    }
    if (Number.isFinite(maxNgn) && maxNgn > 0 && ngnEquivalent > maxNgn) {
        throw makeErr('ABOVE_MAX_LIMIT',
            `Maximum eSIM order is ₦${maxNgn.toFixed(2)}.`,
            400, { max_ngn: maxNgn });
    }
}

// ════════════════════════════════════════════════════════════════════════
//  PIN VERIFICATION
// ════════════════════════════════════════════════════════════════════════
async function verifyTransactionPin(userId, pin) {
    if (!userId) return { valid: false, error: 'User ID required', code: 'USER_ID_REQUIRED' };
    if (!pin || !/^\d{4}$/.test(String(pin))) {
        return { valid: false, error: 'PIN must be exactly 4 digits', code: 'INVALID_FORMAT' };
    }

    const { data: profile, error } = await supabaseAdmin
        .from('profiles')
        .select('transaction_pin_hash, transaction_pin_attempts, transaction_pin_locked_until')
        .eq('id', userId)
        .single();

    if (error || !profile) {
        return { valid: false, error: 'User not found', code: 'USER_NOT_FOUND' };
    }
    if (!profile.transaction_pin_hash) {
        return { valid: false, error: 'PIN not set', code: 'PIN_NOT_SET', pinNotSet: true };
    }

    if (profile.transaction_pin_locked_until) {
        const lockUntil = new Date(profile.transaction_pin_locked_until);
        if (lockUntil > new Date()) {
            const mins = Math.ceil((lockUntil.getTime() - Date.now()) / 60000);
            return {
                valid: false,
                error: `Try again in ${mins} minute(s).`,
                code: 'PIN_LOCKED',
                remaining_minutes: mins,
                can_reset: true
            };
        }
        await supabaseAdmin
            .from('profiles')
            .update({ transaction_pin_attempts: 0, transaction_pin_locked_until: null })
            .eq('id', userId);
    }

    const isValid = await bcrypt.compare(String(pin), profile.transaction_pin_hash);
    if (!isValid) {
        const attempts = Number(profile.transaction_pin_attempts || 0) + 1;

        if (attempts >= MAX_PIN_ATTEMPTS) {
            const lockUntil = new Date(Date.now() + PIN_LOCK_DURATION);
            await supabaseAdmin
                .from('profiles')
                .update({
                    transaction_pin_attempts: 0,
                    transaction_pin_locked_until: lockUntil.toISOString()
                })
                .eq('id', userId);

            return {
                valid: false,
                error: 'PIN locked for 1 hour.',
                code: 'PIN_LOCKED',
                remaining_minutes: 60,
                can_reset: true
            };
        }

        await supabaseAdmin
            .from('profiles')
            .update({ transaction_pin_attempts: attempts })
            .eq('id', userId);

        return {
            valid: false,
            error: `Incorrect PIN. ${MAX_PIN_ATTEMPTS - attempts} attempts left.`,
            code: 'INVALID_PIN',
            attempts_remaining: MAX_PIN_ATTEMPTS - attempts
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
}

// ════════════════════════════════════════════════════════════════════════
//  DESTINATION TYPE RESOLVER
// ════════════════════════════════════════════════════════════════════════
function resolveDestination(input) {
    if (!input) return null;
    const type = String(input.type || 'country').toLowerCase();
    const code = String(input.code || input.iso3 || '').toUpperCase();

    if (type === 'global' || code === 'GLOBAL' || code === 'WWW') {
        return { type: 'global', code: 'GLOBAL', iso3: null };
    }
    if (type === 'regional') {
        return { type: 'regional', code, iso3: null };
    }
    if (/^[A-Z]{3}$/.test(code)) {
        return { type: 'country', code, iso3: code };
    }
    return null;
}

// ════════════════════════════════════════════════════════════════════════
//  QR GENERATION — Private bucket + signed URL
// ════════════════════════════════════════════════════════════════════════
async function generateEsimQr(lpaString, reference) {
    if (!lpaString) throw new Error('Missing eSIM activation code');

    const buffer = await QRCode.toBuffer(lpaString, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 800,
        type: 'png'
    });

    const filename = `${reference || Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;

    const { error: uploadError } = await supabaseAdmin
        .storage
        .from(QR_BUCKET)
        .upload(filename, buffer, {
            contentType: 'image/png',
            cacheControl: '0',
            upsert: false
        });

    if (uploadError) {
        console.error('❌ QR upload failed:', uploadError.message);
        return await QRCode.toDataURL(lpaString, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 800
        });
    }

    const { data: signed, error: signError } = await supabaseAdmin
        .storage
        .from(QR_BUCKET)
        .createSignedUrl(filename, QR_SIGNED_URL_TTL_SEC);

    if (signError || !signed?.signedUrl) {
        console.error('❌ QR signed URL failed:', signError?.message);
        return await QRCode.toDataURL(lpaString, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 800
        });
    }

    console.log(`✅ QR uploaded + signed: ${filename}`);
    return signed.signedUrl;
}

// ════════════════════════════════════════════════════════════════════════
//  GET /me
// ════════════════════════════════════════════════════════════════════════
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const { data: user, error } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, wallet_ngn, wallet_usd, avatar_url, role, status, transaction_pin_hash')
            .eq('id', req.user.id)
            .single();

        if (error || !user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        if (user.status === 'suspended') {
            return res.status(403).json({ success: false, error: 'Account suspended' });
        }

        let walletNgn = num(user.wallet_ngn);
        let walletUsd = num(user.wallet_usd);

        if (walletNgn === 0 || walletUsd === 0) {
            try {
                const balances = await LedgerService.getAllBalances(user.id);
                if (walletNgn === 0 && num(balances.NGN) > 0) walletNgn = num(balances.NGN);
                if (walletUsd === 0 && num(balances.USD) > 0) walletUsd = num(balances.USD);
            } catch (e) {
                console.warn('[ESIM /me] ledger fallback failed:', e.message);
            }
        }

        res.json({
            success: true,
            data: {
                id: user.id,
                name: user.username || user.email?.split('@')[0] || 'Account',
                email: user.email || '',
                avatarUrl: user.avatar_url || null,
                walletBalanceUsd: walletUsd,
                walletBalanceNgn: walletNgn,
                role: user.role || 'user',
                hasPin: Boolean(user.transaction_pin_hash)
            }
        });
    } catch (error) {
        console.error('❌ GET /me error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch user' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /history
// ════════════════════════════════════════════════════════════════════════
router.get('/history', authMiddleware, async (req, res) => {
    try {
        const { data: txns, error } = await supabaseAdmin
            .from('esim_transactions')
            .select(`
                id, reference, dtone_external_id, provider_transaction_id,
                country_iso2, country_iso3, country_name, country_flag,
                plan_name, data_display, data_mb, validity_days,
                price_usd, fee_usd, total_usd, price_ngn,
                debit_currency, debit_amount, exchange_rate,
                status, delivery_status, email_status,
                qr_code_url, activation_code, lpa_string,
                serial_number, iccid, smdp_address, matching_id,
                installation_url, apple_universal_link, android_universal_link,
                instructions, failure_reason, refunded, refund_status,
                delivery_attempts, last_delivery_error,
                email_attempts, last_email_error,
                created_at, updated_at, completed_at, failed_at, refunded_at
            `)
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            if (error.code === '42P01') {
                return res.json({ success: true, data: [] });
            }
            throw error;
        }

        const formatted = (txns || []).map(t => ({
            id: t.id,
            reference: t.reference,
            externalId: t.dtone_external_id,
            providerTransactionId: t.provider_transaction_id,

            countryIso2: t.country_iso2,
            countryIso3: t.country_iso3,
            countryName: t.country_name,
            countryFlag: t.country_flag,

            planName: t.plan_name,
            dataAmount: t.data_display,
            dataMb: t.data_mb,
            validityDays: t.validity_days,

            priceUsd: num(t.price_usd),
            feeUsd: num(t.fee_usd),
            totalUsd: num(t.total_usd),
            priceNgn: num(t.price_ngn),
            debitCurrency: t.debit_currency,
            debitAmount: num(t.debit_amount),
            exchangeRate: num(t.exchange_rate),

            status: t.status,
            deliveryStatus: t.delivery_status,
            emailStatus: t.email_status,
            refunded: !!t.refunded,
            refundStatus: t.refund_status,
            failureReason: t.failure_reason || null,

            qrCodeUrl: t.qr_code_url || null,
            activationCode: t.activation_code || null,
            lpaString: t.lpa_string || null,
            smdpAddress: t.smdp_address || null,
            matchingId: t.matching_id || null,
            serial: t.serial_number || null,
            iccid: t.iccid || null,
            installationUrl: t.installation_url || null,
            appleUniversalLink: t.apple_universal_link || null,
            androidUniversalLink: t.android_universal_link || null,
            instructions: t.instructions || null,

            deliveryAttempts: t.delivery_attempts || 0,
            lastDeliveryError: t.last_delivery_error || null,
            emailAttempts: t.email_attempts || 0,
            lastEmailError: t.last_email_error || null,

            createdAt: t.created_at,
            updatedAt: t.updated_at,
            completedAt: t.completed_at,
            failedAt: t.failed_at,
            refundedAt: t.refunded_at
        }));

        res.json({
            success: true,
            data: formatted,
            meta: { count: formatted.length }
        });
    } catch (error) {
        console.error('❌ GET /history error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch eSIM history' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /countries
// ════════════════════════════════════════════════════════════════════════
router.get('/countries', authMiddleware, async (req, res) => {
    try {
        if (cache.countries.data && (Date.now() - cache.countries.timestamp) < CACHE_TTL) {
            return res.json({ success: true, data: cache.countries.data });
        }

        let countries;
        try {
            countries = await dtoneService.getCountries('ESIM');
        } catch (e) {
            console.warn('⚠️ DT One getCountries(ESIM) failed:', e.message);
            if (cache.countries.data) {
                return res.json({ success: true, data: cache.countries.data });
            }
            return res.status(503).json({
                success: false,
                error: 'eSIM country list is temporarily unavailable.',
                code: 'ESIM_PROVIDER_UNAVAILABLE'
            });
        }

        cache.countries.data = countries || [];
        cache.countries.timestamp = Date.now();
        res.json({ success: true, data: countries || [] });
    } catch (error) {
        console.error('❌ GET /countries error:', error.message);
        if (cache.countries.data) {
            return res.json({ success: true, data: cache.countries.data });
        }
        res.status(500).json({ success: false, error: 'Failed to fetch countries' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /plans — prices computed live from admin settings
// ════════════════════════════════════════════════════════════════════════
router.get('/plans', authMiddleware, async (req, res) => {
    const type = String(req.query.type || '').toLowerCase();
    const countryQ = String(req.query.country || '').toUpperCase();
    const regionQ = String(req.query.region || '').toUpperCase();

    let queryKey, providerKey;

    if (type === 'global' || countryQ === 'GLOBAL') {
        queryKey = 'GLOBAL';
        providerKey = 'GLOBAL';
    } else if (regionQ) {
        queryKey = `REGION:${regionQ}`;
        providerKey = regionQ;
    } else if (/^[A-Z]{3}$/.test(countryQ)) {
        queryKey = countryQ;
        providerKey = countryQ;
    } else {
        return res.status(400).json({ success: false, error: 'country (3-letter) or type=global or region required' });
    }

    try {
        // Feature gate — admin can turn off eSIM entirely.
        const enabled = await adminSettings.isServiceEnabled('esim');
        if (!enabled) {
            return res.json({
                success: true,
                data: [],
                enabled: false,
                reason: 'ESIM_DISABLED'
            });
        }

        const cached = cache.plans.get(queryKey);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            return res.json({ success: true, data: cached.data, enabled: true });
        }

        const usdToNgn = await adminSettings.getRate('USD', 'NGN');
        if (!Number.isFinite(usdToNgn) || usdToNgn <= 0) {
            return res.status(503).json({
                success: false,
                error: 'USD→NGN rate is not configured.',
                code: 'RATE_NOT_CONFIGURED'
            });
        }

        let rawProducts;
        try {
            rawProducts = await dtoneService.getEsimProducts(providerKey);
        } catch (e) {
            console.warn(`⚠️ DT One getEsimProducts failed for ${providerKey}:`, e.message);
            if (cached?.data) return res.json({ success: true, data: cached.data, enabled: true });
            return res.status(503).json({
                success: false,
                error: 'eSIM plans are temporarily unavailable.',
                code: 'ESIM_PROVIDER_UNAVAILABLE'
            });
        }

        // Every plan's price is computed via the same adminSettings math
        // the debit path uses.
        const plans = [];
        for (const p of rawProducts) {
            try {
                // Normalize wholesale to USD for the pricing call.
                let wholesaleUsd;
                if (p.wholesaleCurrency === 'USD') {
                    wholesaleUsd = p.wholesaleAmount;
                } else if (p.wholesaleCurrency === 'NGN') {
                    wholesaleUsd = p.wholesaleAmount / usdToNgn;
                } else {
                    continue;
                }
                if (!Number.isFinite(wholesaleUsd) || wholesaleUsd <= 0) continue;

                const priced = await resolveEsimPricing({ wholesaleUsd });

                plans.push({
                    productId: p.productId,
                    planName: p.planName,
                    description: p.description,
                    dataAmount: p.dataDisplay,
                    dataMb: p.dataMb,
                    validityDays: p.validityDays,
                    priceUsd: priced.priceUsd,
                    priceNgn: priced.priceNgn,
                    totalUsd: priced.totalUsd,
                    totalNgn: priced.totalNgn,
                    coverageType: p.coverageType,
                    coverageLabel: p.coverageLabel,
                    isGlobal: p.isGlobal,
                    isRegional: p.isRegional
                });
            } catch (err) {
                console.warn('[ESIM /plans] price resolve failed for', p.productId, err.message);
            }
        }

        plans.sort((a, b) => {
            const order = { country: 0, regional: 1, global: 2 };
            const diff = (order[a.coverageType] ?? 0) - (order[b.coverageType] ?? 0);
            if (diff !== 0) return diff;
            return a.priceUsd - b.priceUsd;
        });

        cache.plans.set(queryKey, { data: plans, timestamp: Date.now() });

        res.json({
            success: true,
            data: plans,
            enabled: true,
            meta: { query: queryKey, usdToNgn, count: plans.length }
        });
    } catch (error) {
        console.error(`❌ GET /plans error [${queryKey}]:`, error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch plans' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /rates
// ════════════════════════════════════════════════════════════════════════
router.get('/rates', authMiddleware, async (req, res) => {
    try {
        const usdToNgn = await adminSettings.getRate('USD', 'NGN');
        res.json({ success: true, data: { usdToNgn } });
    } catch {
        res.json({ success: true, data: { usdToNgn: 1600 } });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /purchase
// ════════════════════════════════════════════════════════════════════════
router.post('/purchase', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const {
        productId,
        countryIso3,
        destinationType,
        destinationCode,
        deliveryEmail,
        currency,
        pin
    } = req.body;

    if (!productId) return res.status(400).json({ success: false, error: 'productId is required' });
    if (!pin || !/^\d{4}$/.test(String(pin))) {
        return res.status(400).json({ success: false, error: 'Transaction PIN (4 digits) is required', code: 'PIN_REQUIRED' });
    }

    const destination = resolveDestination({
        type: destinationType,
        code: destinationCode || countryIso3
    });

    if (!destination) {
        return res.status(400).json({ success: false, error: 'Valid country or global destination is required' });
    }

    const idempotencyKey = req.headers['idempotency-key'] ||
        `${userId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

    const { data: existingOrder } = await supabaseAdmin
        .from('esim_transactions')
        .select('id, reference, status, dtone_external_id')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

    if (existingOrder) {
        console.log(`♻️ [PURCHASE] Idempotent replay for ${existingOrder.reference}`);
        return res.json({
            success: true,
            data: {
                transactionId: existingOrder.id,
                reference: existingOrder.reference,
                externalId: existingOrder.dtone_external_id,
                status: existingOrder.status,
                already_processed: true
            }
        });
    }

    const pinCheck = await verifyTransactionPin(userId, pin);
    if (!pinCheck.valid) {
        const status = pinCheck.code === 'PIN_LOCKED' ? 429 : 422;
        return res.status(status).json({
            success: false,
            error: pinCheck.error,
            code: pinCheck.code,
            attempts_remaining: pinCheck.attempts_remaining,
            remaining_minutes: pinCheck.remaining_minutes,
            can_reset: pinCheck.can_reset,
            pinNotSet: pinCheck.pinNotSet || false
        });
    }

    let orderId = null;
    let walletDebited = false;
    let debitResult = null;
    let providerTransactionId = null;

    try {
        // 1. Feature gate.
        await adminSettings.assertServiceEnabled('esim');

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, wallet_ngn, wallet_usd')
            .eq('id', userId)
            .single();

        if (!profile) return res.status(404).json({ success: false, error: 'User not found' });

        // 2. FX from admin settings.
        const usdToNgn = await adminSettings.getRate('USD', 'NGN');
        if (!Number.isFinite(usdToNgn) || usdToNgn <= 0) {
            return res.status(503).json({
                success: false,
                error: 'USD→NGN rate is not configured.',
                code: 'RATE_NOT_CONFIGURED'
            });
        }

        const email = (deliveryEmail || profile.email || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, error: 'Valid delivery email is required' });
        }

        // 3. Fetch the plan and compute the customer price.
        const planInfo = await lookupEsimPlan(destination, productId);
        if (!planInfo) {
            return res.status(404).json({ success: false, error: 'Plan not found or unavailable' });
        }

        const priced = await resolveEsimPricing({ wholesaleUsd: planInfo.wholesaleUsd });

        // 4. Enforce limits.
        await assertWithinLimits({
            totalUsd: priced.totalUsd,
            totalNgn: priced.totalNgn,
            usdToNgn: priced.usdToNgn
        });

        // 5. Read wallet — prefer profiles, fall back to ledger.
        let walletUsd = num(profile.wallet_usd);
        let walletNgn = num(profile.wallet_ngn);
        if (walletUsd === 0 || walletNgn === 0) {
            try {
                const balances = await LedgerService.getAllBalances(userId);
                if (walletUsd === 0) walletUsd = num(balances.USD);
                if (walletNgn === 0) walletNgn = num(balances.NGN);
            } catch (e) {
                console.warn('[ESIM /purchase] ledger fallback failed:', e.message);
            }
        }

        let debitCurrency, debitAmount;

        if (currency === 'USD') {
            if (walletUsd < priced.totalUsd) {
                return res.status(400).json({
                    success: false, code: 'INSUFFICIENT_BALANCE',
                    error: `Insufficient USD. Required: $${priced.totalUsd.toFixed(2)}, Available: $${walletUsd.toFixed(2)}`,
                    data: { requiredUsd: priced.totalUsd, availableUsd: walletUsd }
                });
            }
            debitCurrency = 'USD'; debitAmount = priced.totalUsd;
        } else if (currency === 'NGN') {
            if (walletNgn < priced.totalNgn) {
                return res.status(400).json({
                    success: false, code: 'INSUFFICIENT_BALANCE',
                    error: `Insufficient NGN. Required: ₦${priced.totalNgn.toFixed(2)}, Available: ₦${walletNgn.toFixed(2)}`,
                    data: { requiredNgn: priced.totalNgn, availableNgn: walletNgn }
                });
            }
            debitCurrency = 'NGN'; debitAmount = priced.totalNgn;
        } else {
            if (walletUsd >= priced.totalUsd) { debitCurrency = 'USD'; debitAmount = priced.totalUsd; }
            else if (walletNgn >= priced.totalNgn) { debitCurrency = 'NGN'; debitAmount = priced.totalNgn; }
            else {
                return res.status(400).json({
                    success: false, code: 'INSUFFICIENT_BALANCE',
                    error: `Insufficient balance. Required: $${priced.totalUsd.toFixed(2)} or ₦${priced.totalNgn.toFixed(2)}`,
                    data: {
                        requiredUsd: priced.totalUsd, availableUsd: walletUsd,
                        requiredNgn: priced.totalNgn, availableNgn: walletNgn
                    }
                });
            }
        }

        // 6. Create order with freshly-computed prices + FX.
        orderId = crypto.randomUUID();
        const reference = 'ESIM-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

        const { error: orderError } = await supabaseAdmin
            .from('esim_transactions')
            .insert({
                id: orderId,
                user_id: userId,
                reference,
                idempotency_key: idempotencyKey,
                country_iso2: planInfo.countryIso2 || '',
                country_iso3: destination.iso3 || destination.code,
                country_name: planInfo.countryName || destination.code,
                country_flag: planInfo.countryFlag || null,
                destination_type: destination.type,
                product_id: productId,
                plan_name: planInfo.planName,
                data_display: planInfo.dataDisplay,
                data_mb: planInfo.dataMb || 0,
                validity_days: planInfo.validityDays,
                wholesale_usd: planInfo.wholesaleUsd || 0,
                price_usd: priced.priceUsd,
                fee_usd: priced.feeUsd,
                total_usd: priced.totalUsd,
                exchange_rate: priced.usdToNgn,
                price_ngn: priced.totalNgn,
                debit_currency: debitCurrency,
                debit_amount: debitAmount,
                delivery_email: email,
                status: 'pending',
                delivery_status: 'pending',
                email_status: 'pending',
                refund_status: 'not_applicable',
                reconciliation_attempts: 0,
                delivery_attempts: 0,
                email_attempts: 0,
                refund_attempts: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

        if (orderError) {
            if (orderError.code === '23505') {
                const { data: dup } = await supabaseAdmin
                    .from('esim_transactions')
                    .select('id, reference, status, dtone_external_id')
                    .eq('user_id', userId)
                    .eq('idempotency_key', idempotencyKey)
                    .maybeSingle();
                if (dup) {
                    return res.json({
                        success: true,
                        data: {
                            transactionId: dup.id,
                            reference: dup.reference,
                            externalId: dup.dtone_external_id,
                            status: dup.status,
                            already_processed: true
                        }
                    });
                }
            }
            throw new Error(`Order insert failed: ${orderError.message}`);
        }

        debitResult = await LedgerService.debitWallet(
            userId, debitAmount, debitCurrency,
            `eSIM: ${planInfo.planName} (${planInfo.countryName})`,
            { order_id: orderId, reference, service: 'esim', product_id: productId, destination: destination.code }
        );

        if (!debitResult?.success) throw new Error(debitResult?.error || 'Wallet debit failed');
        walletDebited = true;

        await supabaseAdmin
            .from('esim_transactions')
            .update({
                ledger_transaction_id: debitResult.transaction_id,
                status: 'processing',
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);

        const quote = await dtoneService.createQuote({
            productId,
            phone: null,
            mode: 'FIXED',
            callbackUrl: getPublicCallbackUrl('/api/webhooks/dtone/esim'),
            orderReference: reference
        });

        if (!quote?.transactionId) throw new Error('DT One did not return a transaction ID');

        providerTransactionId = String(quote.transactionId);
        const dtoneExternalId = quote.externalId || null;

        await supabaseAdmin
            .from('esim_transactions')
            .update({
                provider_transaction_id: providerTransactionId,
                dtone_external_id: dtoneExternalId,
                provider_status: 'CREATED',
                provider_response: quote.raw || quote,
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);

        const confirmation = await dtoneService.confirmTransaction(providerTransactionId);
        const providerStatus = String(
            confirmation?.status?.message ||
            confirmation?.status?.class?.message ||
            'SUBMITTED'
        ).toUpperCase();

        await supabaseAdmin
            .from('esim_transactions')
            .update({
                provider_status: providerStatus,
                provider_response: confirmation || {},
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);

        const normalized = dtoneService.normalizeStatus(confirmation?.status || providerStatus);

        if (normalized.final && normalized.status === 'completed') {
            await finalizeEsimOrder(orderId, providerTransactionId);
            const { data: fresh } = await supabaseAdmin.from('esim_transactions').select('*').eq('id', orderId).single();
            return res.json({ success: true, data: shapeCompleted(fresh) });
        }

        if (normalized.final && ['failed', 'cancelled', 'reversed'].includes(normalized.status)) {
            await refundEsimOrder(userId, orderId, `Provider: ${normalized.code}`);
            return res.json({
                success: true,
                data: { transactionId: orderId, reference, externalId: dtoneExternalId, status: normalized.status }
            });
        }

        return res.json({
            success: true,
            data: { transactionId: orderId, reference, externalId: dtoneExternalId, status: 'processing' }
        });

    } catch (error) {
        console.error('❌ POST /purchase error:', error.message, error.providerData || '');

        if (orderId) {
            try {
                if (walletDebited && !providerTransactionId) {
                    await refundEsimOrder(userId, orderId, error.message || 'DT One transaction creation failed');
                } else if (walletDebited && providerTransactionId) {
                    await supabaseAdmin
                        .from('esim_transactions')
                        .update({
                            status: 'processing',
                            failure_reason: `Post-quote error: ${error.message}`,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', orderId);
                } else {
                    await supabaseAdmin
                        .from('esim_transactions')
                        .update({
                            status: 'failed',
                            failure_reason: error.message,
                            failed_at: new Date().toISOString(),
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', orderId);
                }
            } catch (cleanupErr) {
                console.error('❌ Cleanup failed:', cleanupErr.message);
            }
        }

        // If the error has a status/code from adminSettings, surface it.
        if (error.status && error.code) {
            return res.status(error.status).json({
                success: false,
                error: error.message,
                code: error.code,
                min_ngn: error.min_ngn,
                max_ngn: error.max_ngn,
                service: error.service
            });
        }

        return res.status(500).json({ success: false, error: error.message || 'Failed to create eSIM order' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /status/:transactionId
// ════════════════════════════════════════════════════════════════════════
router.get('/status/:transactionId', authMiddleware, async (req, res) => {
    try {
        const { transactionId } = req.params;

        const { data: order, error } = await supabaseAdmin
            .from('esim_transactions')
            .select('*')
            .eq('id', transactionId)
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (error || !order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        if (order.status === 'completed' && order.delivery_status === 'ready') {
            return res.json({ success: true, data: shapeCompleted(order) });
        }

        if (order.status === 'completed' && order.delivery_status !== 'ready') {
            return res.json({
                success: true,
                data: {
                    status: 'delivery_pending',
                    isFinal: false,
                    qrCodeUrl: null,
                    errorMessage: 'Your payment was successful. We are retrieving your eSIM details.'
                }
            });
        }

        if (['failed', 'refunded', 'cancelled', 'reversed', 'manual_review'].includes(order.status)) {
            return res.json({
                success: true,
                data: {
                    status: order.status,
                    isFinal: true,
                    qrCodeUrl: null,
                    errorMessage: order.failure_reason || 'Order could not be completed'
                }
            });
        }

        if (order.provider_transaction_id) {
            try {
                const dtoneResult = await dtoneService.queryTransaction(order.provider_transaction_id);

                if (dtoneResult.notFound && order.dtone_external_id) {
                    const alt = await dtoneService.getTransactionByExternalId(order.dtone_external_id);
                    if (alt) {
                        const altStatus = dtoneService.normalizeStatus(alt.status || alt);
                        if (altStatus.final && altStatus.status === 'completed') {
                            await finalizeEsimOrder(order.id, order.provider_transaction_id, { raw: alt });
                            const fresh = await supabaseAdmin.from('esim_transactions').select('*').eq('id', order.id).single();
                            return res.json({ success: true, data: shapeCompleted(fresh.data) });
                        }
                        if (altStatus.final && ['failed', 'cancelled', 'reversed'].includes(altStatus.status)) {
                            await refundEsimOrder(order.user_id, order.id, `External lookup: ${altStatus.code}`);
                            return res.json({
                                success: true,
                                data: { status: altStatus.status, isFinal: true, qrCodeUrl: null, errorMessage: 'Provider rejected order' }
                            });
                        }
                    }
                }

                if (dtoneResult.status === 'completed') {
                    await finalizeEsimOrder(order.id, order.provider_transaction_id, dtoneResult);
                    const fresh = await supabaseAdmin.from('esim_transactions').select('*').eq('id', order.id).single();
                    if (fresh?.delivery_status === 'ready') {
                        return res.json({ success: true, data: shapeCompleted(fresh.data) });
                    }
                    return res.json({
                        success: true,
                        data: {
                            status: 'delivery_pending',
                            isFinal: false,
                            qrCodeUrl: null,
                            errorMessage: 'Provider confirmed. Fetching your eSIM details now.'
                        }
                    });
                }

                if (dtoneResult.isFinal && ['failed', 'cancelled', 'reversed'].includes(dtoneResult.status)) {
                    await refundEsimOrder(req.user.id, order.id, dtoneResult.errorMessage || `Provider: ${dtoneResult.providerStatus}`);
                    return res.json({
                        success: true,
                        data: { status: dtoneResult.status, isFinal: true, qrCodeUrl: null, errorMessage: dtoneResult.errorMessage || 'Provider rejected order' }
                    });
                }

                await supabaseAdmin
                    .from('esim_transactions')
                    .update({
                        provider_status: dtoneResult.providerStatus,
                        provider_response: dtoneResult.raw,
                        reconciliation_attempts: (order.reconciliation_attempts || 0) + 1,
                        last_reconciled_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', order.id);

            } catch (dtoneErr) {
                console.warn('⚠️ DT One status query failed:', dtoneErr.message);
            }
        }

        const elapsedMin = (Date.now() - new Date(order.created_at).getTime()) / 60000;
        if (elapsedMin > MAX_AGE_MINUTES && (order.reconciliation_attempts || 0) >= MAX_RECONCILE_ATTEMPTS) {
            await supabaseAdmin
                .from('esim_transactions')
                .update({
                    status: 'manual_review',
                    failure_reason: `Exceeded ${MAX_AGE_MINUTES} min without final status`,
                    updated_at: new Date().toISOString()
                })
                .eq('id', order.id);

            return res.json({
                success: true,
                data: {
                    status: 'manual_review',
                    isFinal: true,
                    qrCodeUrl: null,
                    errorMessage: 'We are confirming this order with our provider. Our team will contact you shortly.'
                }
            });
        }

        res.json({ success: true, data: { status: 'processing', isFinal: false, qrCodeUrl: null, errorMessage: null } });

    } catch (error) {
        console.error('❌ GET /status error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to check order status' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════
function shapeCompleted(t) {
    if (!t) return null;
    return {
        transactionId: t.id,
        reference: t.reference,
        countryName: t.country_name,
        countryFlag: t.country_flag,
        planName: t.plan_name,
        dataAmount: t.data_display,
        validityDays: t.validity_days,
        totalUsd: parseFloat(t.total_usd) || 0,
        status: 'completed',
        isFinal: true,
        qrCodeUrl: t.qr_code_url,
        activationCode: t.activation_code,
        lpaString: t.lpa_string,
        serial: t.serial_number,
        iccid: t.iccid,
        installationUrl: t.installation_url,
        appleUniversalLink: t.apple_universal_link,
        androidUniversalLink: t.android_universal_link,
        smdpAddress: t.smdp_address,
        matchingId: t.matching_id,
        instructions: t.instructions,
        deliveryStatus: t.delivery_status,
        emailStatus: t.email_status,
        errorMessage: null
    };
}

async function finalizeEsimOrder(orderId, dtoneTxId, dtoneResultOverride = null) {
    const { data: existing } = await supabaseAdmin
        .from('esim_transactions')
        .select('*')
        .eq('id', orderId)
        .single();

    if (!existing) return { success: false };
    if (existing.status === 'completed' && existing.delivery_status === 'ready') {
        if (!existing.email_sent) queueEsimEmail(orderId);
        return { success: true, alreadyFinalized: true };
    }

    let dtoneResult = dtoneResultOverride;
    if (!dtoneResult) {
        try {
            dtoneResult = await dtoneService.queryTransaction(dtoneTxId);
        } catch (e) {
            console.warn('⚠️ DT One fetch failed:', e.message);
            dtoneResult = { raw: {} };
        }
    }

    const delivery = dtoneService.extractEsimDelivery(dtoneResult);

    if (!delivery?.lpaString) {
        console.error(`❌ [ESIM] Provider completed but no activation code found for ${orderId}`);
        await supabaseAdmin
            .from('esim_transactions')
            .update({
                provider_response: dtoneResult?.raw || {},
                provider_status: dtoneResult?.providerStatus || 'COMPLETED',
                delivery_status: 'pending',
                delivery_attempts: (existing.delivery_attempts || 0) + 1,
                last_delivery_error: 'Provider completed transaction but eSIM activation data was not found',
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);
        return { success: false, deliveryPending: true };
    }

    let qrCodeUrl = delivery.qrCodeUrl;
    if (!qrCodeUrl) {
        try {
            qrCodeUrl = await generateEsimQr(delivery.lpaString, existing.reference);
        } catch (qrErr) {
            console.error(`❌ QR generation failed for ${orderId}:`, qrErr.message);
            await supabaseAdmin
                .from('esim_transactions')
                .update({
                    delivery_status: 'pending',
                    delivery_attempts: (existing.delivery_attempts || 0) + 1,
                    last_delivery_error: `QR generation failed: ${qrErr.message}`,
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);
            return { success: false, deliveryPending: true };
        }
    }

    const now = new Date().toISOString();

    const { data: claimed } = await supabaseAdmin
        .from('esim_transactions')
        .update({
            status: 'completed',
            completed_at: now,
            qr_code_url: qrCodeUrl,
            activation_code: delivery.activationCode || delivery.lpaString,
            lpa_string: delivery.lpaString,
            serial_number: delivery.serial || null,
            iccid: delivery.iccid || null,
            installation_url: delivery.installationUrl || null,
            apple_universal_link: delivery.appleUniversalLink || null,
            android_universal_link: delivery.androidUniversalLink || null,
            smdp_address: delivery.smdpAddress || null,
            matching_id: delivery.matchingId || null,
            instructions: delivery.instructions || null,
            delivery_status: 'ready',
            delivery_attempts: (existing.delivery_attempts || 0) + 1,
            provider_response: dtoneResult.raw || existing.provider_response,
            provider_status: dtoneResult.providerStatus || 'COMPLETED',
            updated_at: now
        })
        .eq('id', orderId)
        .in('status', ['processing', 'pending', 'completed'])
        .select('*')
        .maybeSingle();

    if (!claimed) return { success: true, alreadyFinalized: true };

    console.log(`✅ eSIM ${orderId} finalized with QR`);
    queueEsimEmail(orderId);

    return { success: true };
}

function queueEsimEmail(orderId) {
    setImmediate(async () => {
        try {
            const { data: order } = await supabaseAdmin
                .from('esim_transactions')
                .select('*')
                .eq('id', orderId)
                .single();
            if (order) await trySendEsimEmail(order);
        } catch (e) {
            console.error(`❌ Email queue error for ${orderId}:`, e.message);
        }
    });
}

async function trySendEsimEmail(order) {
    if (!order || order.email_sent) return true;
    if (!order.delivery_email) return false;

    const isStaleSending =
        order.email_status === 'sending' &&
        order.updated_at &&
        (Date.now() - new Date(order.updated_at).getTime()) > STALE_SENDING_MS;

    if (order.email_status === 'sending' && !isStaleSending) return true;

    if ((order.email_attempts || 0) >= EMAIL_MAX_ATTEMPTS) {
        await supabaseAdmin
            .from('esim_transactions')
            .update({
                email_status: 'failed',
                last_email_error: 'Max attempts reached',
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);
        return false;
    }

    const { data: claimed } = await supabaseAdmin
        .from('esim_transactions')
        .update({
            email_status: 'sending',
            email_attempts: (order.email_attempts || 0) + 1,
            updated_at: new Date().toISOString()
        })
        .eq('id', order.id)
        .eq('email_sent', false)
        .or(`email_status.neq.sending,updated_at.lt.${new Date(Date.now() - STALE_SENDING_MS).toISOString()}`)
        .select('*')
        .maybeSingle();

    if (!claimed) return true;

    try {
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('username')
            .eq('id', claimed.user_id)
            .maybeSingle();

        const emailRes = await emailService.sendEsimDeliveryEmail({
            email: claimed.delivery_email,
            username: profile?.username || 'Traveller',
            reference: claimed.reference,
            countryName: claimed.country_name,
            planName: claimed.plan_name,
            dataDisplay: claimed.data_display,
            validityDays: claimed.validity_days,
            totalUsd: claimed.total_usd,
            totalNgn: claimed.price_ngn,
            debitCurrency: claimed.debit_currency,
            debitAmount: claimed.debit_amount,
            qrCodeUrl: claimed.qr_code_url,
            activationCode: claimed.activation_code,
            lpaString: claimed.lpa_string,
            smdpAddress: claimed.smdp_address,
            matchingId: claimed.matching_id,
            instructions: claimed.instructions
        });

        if (emailRes?.success) {
            await supabaseAdmin
                .from('esim_transactions')
                .update({
                    email_sent: true,
                    email_sent_at: new Date().toISOString(),
                    email_message_id: emailRes.messageId || null,
                    email_status: 'sent',
                    last_email_error: null,
                    next_email_retry_at: null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', order.id);
            console.log(`📧 eSIM email sent for ${claimed.reference}`);
            return true;
        }

        const attempt = claimed.email_attempts || 1;
        const backoffMin = EMAIL_RETRY_BACKOFF_MIN[Math.min(attempt - 1, EMAIL_RETRY_BACKOFF_MIN.length - 1)];
        const nextRetry = new Date(Date.now() + backoffMin * 60 * 1000);

        await supabaseAdmin
            .from('esim_transactions')
            .update({
                email_status: attempt >= EMAIL_MAX_ATTEMPTS ? 'failed' : 'pending',
                last_email_error: emailRes?.error || emailRes?.message || 'Unknown error',
                next_email_retry_at: attempt >= EMAIL_MAX_ATTEMPTS ? null : nextRetry.toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);

        return false;
    } catch (e) {
        const attempt = claimed.email_attempts || 1;
        const backoffMin = EMAIL_RETRY_BACKOFF_MIN[Math.min(attempt - 1, EMAIL_RETRY_BACKOFF_MIN.length - 1)];
        const nextRetry = new Date(Date.now() + backoffMin * 60 * 1000);

        await supabaseAdmin
            .from('esim_transactions')
            .update({
                email_status: attempt >= EMAIL_MAX_ATTEMPTS ? 'failed' : 'pending',
                last_email_error: e.message,
                next_email_retry_at: attempt >= EMAIL_MAX_ATTEMPTS ? null : nextRetry.toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);

        console.error(`❌ Email exception for ${claimed.reference}:`, e.message);
        return false;
    }
}

async function refundEsimOrder(userId, orderId, reason) {
    try {
        const { data: order } = await supabaseAdmin
            .from('esim_transactions')
            .select('*')
            .eq('id', orderId)
            .single();

        if (!order) return;
        if (order.refunded === true || order.status === 'refunded') return;
        if (order.refund_status === 'completed') return;

        const { data: claimed } = await supabaseAdmin
            .from('esim_transactions')
            .update({
                refund_status: 'processing',
                refund_attempts: (order.refund_attempts || 0) + 1,
                failure_reason: reason,
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId)
            .in('refund_status', ['not_applicable', 'failed'])
            .eq('refunded', false)
            .select('*')
            .maybeSingle();

        if (!claimed) return;

        try {
            if (claimed.ledger_transaction_id) {
                await LedgerService.refundTransaction(
                    claimed.user_id,
                    claimed.ledger_transaction_id,
                    `eSIM refund: ${reason}`
                );
            }

            await supabaseAdmin
                .from('esim_transactions')
                .update({
                    status: 'refunded',
                    refunded: true,
                    refund_status: 'completed',
                    refunded_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);

            console.log(`✅ eSIM ${orderId} refunded: ${reason}`);
        } catch (refundErr) {
            console.error(`❌ Refund failed for ${orderId}:`, refundErr.message);
            await supabaseAdmin
                .from('esim_transactions')
                .update({
                    refund_status: 'failed',
                    refund_error: refundErr.message,
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);
        }
    } catch (err) {
        console.error('❌ eSIM refund handler error:', err.message);
    }
}

// Look up the plan on DT One, return wholesale + metadata. Does NOT
// compute the customer price — the caller does that from admin settings.
async function lookupEsimPlan(destination, productId) {
    try {
        const providerKey = destination.type === 'global' ? 'GLOBAL' : destination.code;
        const products = await dtoneService.getEsimProducts(providerKey);
        const p = products.find(x => String(x.productId) === String(productId));
        if (!p) return null;

        const allCountries = cache.countries.data || [];
        const countryMeta = destination.iso3
            ? allCountries.find(c => c.iso3 === destination.iso3) || { iso3: destination.iso3, iso2: '', name: destination.iso3 }
            : { iso3: '', iso2: '', name: 'Global' };

        // Normalize wholesale to USD; the caller converts to NGN
        // using the admin-configured rate.
        let wholesaleUsd;
        if (p.wholesaleCurrency === 'USD') {
            wholesaleUsd = Number(p.wholesaleAmount);
        } else if (p.wholesaleCurrency === 'NGN') {
            const usdToNgn = await adminSettings.getRate('USD', 'NGN');
            wholesaleUsd = Number(p.wholesaleAmount) / usdToNgn;
        } else {
            return null;
        }

        if (!Number.isFinite(wholesaleUsd) || wholesaleUsd <= 0) return null;

        return {
            productId: p.productId,
            planName: p.planName,
            dataDisplay: p.dataDisplay,
            dataMb: p.dataMb,
            validityDays: p.validityDays,
            wholesaleUsd,
            countryIso2: countryMeta.iso2 || '',
            countryName: p.countryName || countryMeta.name || destination.code,
            countryFlag: null
        };
    } catch (e) {
        console.warn('⚠️ lookupEsimPlan failed:', e.message);
        return null;
    }
}

function getPublicCallbackUrl(path) {
    const base = process.env.APP_URL || '';
    if (!/^https:\/\//i.test(base)) return undefined;
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(base)) return undefined;
    return `${base.replace(/\/$/, '')}${path}`;
}

module.exports = router;