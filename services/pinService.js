// routes/esimRoutes.js — COMPLETE PRODUCTION eSIM ROUTES
// Uses services/pinService.js as-is (class instance with verifyPin/createPin/changePin).
// DT One eSIM (service 13), email delivery, reconciliation, webhooks.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService, AdminConfigService } = require('../services/ledgerService');
const pinService = require('../services/pinService');           // ← class instance
const emailService = require('../services/emailService');
const dtoneService = require('../services/dtoneService');

// ─── CONFIG ──────────────────────────────────────────────────────────────
const SERVICE_FEE_PCT = 0.02;          // 2% MilesSpace fee
const VENDOR_MARKUP_PCT = 0.15;        // 15% markup on DT One wholesale
const CACHE_TTL = 5 * 60 * 1000;
const MAX_RECONCILE_ATTEMPTS = 5;
const MAX_AGE_MINUTES = 25;

const cache = {
    countries: { data: null, timestamp: 0 },
    plans: new Map(),
    ttl: CACHE_TTL
};

// ════════════════════════════════════════════════════════════════════════
//  Helpers — translate pinService thrown errors into structured responses
// ════════════════════════════════════════════════════════════════════════

/**
 * Call pinService.verifyPin and normalize the outcome.
 * pinService throws on every failure mode, so we catch and map to a
 * structured object that routes can send back to the client.
 */
async function checkTransactionPin(userId, pin, action, req) {
    if (!userId) {
        return { valid: false, code: 'USER_ID_REQUIRED', error: 'User ID required', httpStatus: 400 };
    }
    if (!pin || !/^\d{4}$/.test(String(pin))) {
        return { valid: false, code: 'INVALID_FORMAT', error: 'PIN must be exactly 4 digits', httpStatus: 400 };
    }

    try {
        await pinService.verifyPin(userId, String(pin), action || 'esim_purchase', req);
        return { valid: true };
    } catch (err) {
        const msg = String(err?.message || 'PIN verification failed');

        // Map thrown messages to codes + HTTP statuses
        if (/not set/i.test(msg)) {
            return { valid: false, code: 'PIN_NOT_SET', error: msg, pinNotSet: true, httpStatus: 400 };
        }
        if (/locked for (\d+) minutes?/i.test(msg)) {
            const m = msg.match(/locked for (\d+) minutes?/i);
            const mins = m ? Number(m[1]) : 60;
            return { valid: false, code: 'PIN_LOCKED', error: msg, remaining_minutes: mins, can_reset: true, httpStatus: 401 };
        }
        if (/too many attempts/i.test(msg)) {
            return { valid: false, code: 'PIN_LOCKED', error: msg, remaining_minutes: 60, can_reset: true, httpStatus: 401 };
        }
        if (/Invalid PIN\. (\d+) attempts remaining/i.test(msg)) {
            const m = msg.match(/Invalid PIN\. (\d+) attempts remaining/i);
            const remaining = m ? Number(m[1]) : null;
            return {
                valid: false,
                code: 'INVALID_PIN',
                error: msg,
                attempts_remaining: remaining,
                httpStatus: 401
            };
        }

        return { valid: false, code: 'INVALID_PIN', error: msg, httpStatus: 401 };
    }
}

// ════════════════════════════════════════════════════════════════════════
//  GET /api/user/me
// ════════════════════════════════════════════════════════════════════════
router.get('/user/me', authMiddleware, async (req, res) => {
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

        res.json({
            success: true,
            data: {
                id: user.id,
                name: user.username || user.email?.split('@')[0] || 'Account',
                email: user.email,
                avatarUrl: user.avatar_url || null,
                walletBalanceUsd: parseFloat(user.wallet_usd) || 0,
                walletBalanceNgn: parseFloat(user.wallet_ngn) || 0,
                role: user.role || 'user',
                hasPin: Boolean(user.transaction_pin_hash)
            }
        });
    } catch (error) {
        console.error('❌ GET /user/me error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch user' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/esim/history
// ════════════════════════════════════════════════════════════════════════
router.get('/esim/history', authMiddleware, async (req, res) => {
    try {
        const { data: txns, error } = await supabaseAdmin
            .from('esim_transactions')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) {
            if (error.code === '42P01') return res.json({ success: true, data: [] });
            throw error;
        }

        const formatted = (txns || []).map(t => ({
            id: t.id,
            reference: t.reference,
            externalId: t.dtone_external_id,
            countryName: t.country_name,
            countryFlag: t.country_flag,
            planName: t.plan_name,
            dataAmount: t.data_display,
            validityDays: t.validity_days,
            totalUsd: parseFloat(t.total_usd) || 0,
            status: t.status,
            createdAt: t.created_at,
            qrCodeUrl: t.qr_code_url || null,
            activationCode: t.activation_code || null,
            lpaString: t.lpa_string || null
        }));

        res.json({ success: true, data: formatted });
    } catch (error) {
        console.error('❌ GET /esim/history error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch eSIM history' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/esim/countries
// ════════════════════════════════════════════════════════════════════════
router.get('/esim/countries', authMiddleware, async (req, res) => {
    try {
        if (cache.countries.data && (Date.now() - cache.countries.timestamp) < CACHE_TTL) {
            return res.json({ success: true, data: cache.countries.data });
        }

        let countries;
        try {
            countries = await dtoneService.getCountries('ESIM');
        } catch (e) {
            console.warn('⚠️ DT One getCountries(ESIM) failed:', e.message);
            if (cache.countries.data) return res.json({ success: true, data: cache.countries.data });
            return res.json({ success: true, data: [] });
        }

        cache.countries.data = countries;
        cache.countries.timestamp = Date.now();

        res.json({ success: true, data: countries });
    } catch (error) {
        console.error('❌ GET /esim/countries error:', error.message);
        if (cache.countries.data) return res.json({ success: true, data: cache.countries.data });
        res.status(500).json({ success: false, error: 'Failed to fetch countries' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/esim/plans?country=ISO3
// ════════════════════════════════════════════════════════════════════════
router.get('/esim/plans', authMiddleware, async (req, res) => {
    const query = String(req.query.country || '').toUpperCase();

    if (!query) {
        return res.status(400).json({ success: false, error: 'country (iso3) is required' });
    }

    try {
        const cached = cache.plans.get(query);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            return res.json({ success: true, data: cached.data });
        }

        const settings = await AdminConfigService.getSettings();
        const usdToNgn = parseFloat(settings.usd_to_ngn) || 1600;

        let rawProducts;
        try {
            rawProducts = await dtoneService.getEsimProducts(query);
        } catch (e) {
            console.warn(`⚠️ DT One getEsimProducts failed for ${query}:`, e.message);
            if (cached?.data) return res.json({ success: true, data: cached.data });
            return res.json({ success: true, data: [] });
        }

        const plans = rawProducts
            .map(p => {
                let wholesaleUsd = null, wholesaleNgn = null;

                if (p.wholesaleCurrency === 'USD') {
                    wholesaleUsd = p.wholesaleAmount;
                    wholesaleNgn = +(p.wholesaleAmount * usdToNgn).toFixed(2);
                } else if (p.wholesaleCurrency === 'NGN') {
                    wholesaleNgn = p.wholesaleAmount;
                    wholesaleUsd = +(p.wholesaleAmount / usdToNgn).toFixed(2);
                } else {
                    return null;
                }

                const priceUsd = +(wholesaleUsd * (1 + VENDOR_MARKUP_PCT)).toFixed(2);
                const priceNgn = +(wholesaleNgn * (1 + VENDOR_MARKUP_PCT)).toFixed(2);

                return {
                    productId: p.productId,
                    planName: p.planName,
                    description: p.description,
                    dataAmount: p.dataDisplay,
                    dataMb: p.dataMb,
                    validityDays: p.validityDays,
                    priceUsd,
                    priceNgn,
                    wholesaleUsd: +wholesaleUsd.toFixed(4),
                    wholesaleNgn: +wholesaleNgn.toFixed(2),
                    wholesaleCurrency: p.wholesaleCurrency,
                    operatorName: p.operatorName,
                    instructions: p.instructions,
                    coverageType: p.coverageType,
                    coverageLabel: p.coverageLabel,
                    coverageRegions: p.coverageRegions,
                    isGlobal: p.isGlobal,
                    isRegional: p.isRegional
                };
            })
            .filter(Boolean)
            .sort((a, b) => {
                const order = { country: 0, regional: 1, global: 2 };
                const diff = (order[a.coverageType] ?? 0) - (order[b.coverageType] ?? 0);
                if (diff !== 0) return diff;
                return a.priceUsd - b.priceUsd;
            });

        cache.plans.set(query, { data: plans, timestamp: Date.now() });

        res.json({
            success: true,
            data: plans,
            meta: { query, usdToNgn, count: plans.length }
        });
    } catch (error) {
        console.error(`❌ GET /esim/plans error [${query}]:`, error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch plans' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/esim/rates
// ════════════════════════════════════════════════════════════════════════
router.get('/esim/rates', authMiddleware, async (req, res) => {
    try {
        const settings = await AdminConfigService.getSettings();
        res.json({ success: true, data: { usdToNgn: parseFloat(settings.usd_to_ngn) || 1600 } });
    } catch {
        res.json({ success: true, data: { usdToNgn: 1600 } });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/esim/purchase
// ════════════════════════════════════════════════════════════════════════
router.post('/esim/purchase', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const { productId, countryIso3, deliveryEmail, currency, pin } = req.body;

    if (!productId) {
        return res.status(400).json({ success: false, error: 'productId is required' });
    }
    if (!countryIso3 || countryIso3.length !== 3) {
        return res.status(400).json({ success: false, error: 'countryIso3 is required' });
    }
    if (!pin || !/^\d{4}$/.test(String(pin))) {
        return res.status(400).json({ success: false, error: 'Transaction PIN (4 digits) is required', code: 'PIN_REQUIRED' });
    }

    // ─── 1. Verify PIN via pinService (class instance API)
    const pinCheck = await checkTransactionPin(userId, pin, 'esim_purchase', req);
    if (!pinCheck.valid) {
        return res.status(pinCheck.httpStatus || 401).json({
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
    let providerQuoteStarted = false;

    try {
        // ─── 2. Load profile + rates
        const [{ data: profile }, settings] = await Promise.all([
            supabaseAdmin
                .from('profiles')
                .select('id, username, email, wallet_ngn, wallet_usd')
                .eq('id', userId)
                .single(),
            AdminConfigService.getSettings()
        ]);

        if (!profile) return res.status(404).json({ success: false, error: 'User not found' });

        const usdToNgn = parseFloat(settings.usd_to_ngn) || 1600;
        const email = (deliveryEmail || profile.email || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, error: 'Valid delivery email is required' });
        }

        // ─── 3. Server-side plan lookup
        const planInfo = await lookupEsimPlan(countryIso3, productId, usdToNgn);
        if (!planInfo) {
            return res.status(404).json({ success: false, error: 'Plan not found or unavailable' });
        }

        const priceUsd = +planInfo.priceUsd.toFixed(2);
        const feeUsd = +(priceUsd * SERVICE_FEE_PCT).toFixed(2);
        const totalUsd = +(priceUsd + feeUsd).toFixed(2);
        const totalNgn = +(totalUsd * usdToNgn).toFixed(2);

        const walletUsd = parseFloat(profile.wallet_usd) || 0;
        const walletNgn = parseFloat(profile.wallet_ngn) || 0;

        // ─── 4. Currency selection
        let debitCurrency, debitAmount;

        if (currency === 'USD') {
            if (walletUsd < totalUsd) {
                return res.status(400).json({
                    success: false,
                    code: 'INSUFFICIENT_BALANCE',
                    error: `Insufficient USD. Required: $${totalUsd.toFixed(2)}, Available: $${walletUsd.toFixed(2)}`,
                    data: { requiredUsd: totalUsd, availableUsd: walletUsd }
                });
            }
            debitCurrency = 'USD'; debitAmount = totalUsd;
        } else if (currency === 'NGN') {
            if (walletNgn < totalNgn) {
                return res.status(400).json({
                    success: false,
                    code: 'INSUFFICIENT_BALANCE',
                    error: `Insufficient NGN. Required: ₦${totalNgn.toFixed(2)}, Available: ₦${walletNgn.toFixed(2)}`,
                    data: { requiredNgn: totalNgn, availableNgn: walletNgn }
                });
            }
            debitCurrency = 'NGN'; debitAmount = totalNgn;
        } else {
            if (walletUsd >= totalUsd) { debitCurrency = 'USD'; debitAmount = totalUsd; }
            else if (walletNgn >= totalNgn) { debitCurrency = 'NGN'; debitAmount = totalNgn; }
            else {
                return res.status(400).json({
                    success: false,
                    code: 'INSUFFICIENT_BALANCE',
                    error: `Insufficient balance. Required: $${totalUsd.toFixed(2)} or ₦${totalNgn.toFixed(2)}`,
                    data: {
                        requiredUsd: totalUsd, availableUsd: walletUsd,
                        requiredNgn: totalNgn, availableNgn: walletNgn
                    }
                });
            }
        }

        // ─── 5. Create order
        orderId = crypto.randomUUID();
        const reference = 'ESIM-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
        const idempotencyKey = req.headers['idempotency-key'] ||
            `${userId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

        const { error: orderError } = await supabaseAdmin
            .from('esim_transactions')
            .insert({
                id: orderId,
                user_id: userId,
                reference,
                idempotency_key: idempotencyKey,
                country_iso2: planInfo.countryIso2 || '',
                country_iso3: countryIso3,
                country_name: planInfo.countryName || countryIso3,
                country_flag: planInfo.countryFlag || null,
                product_id: productId,
                plan_name: planInfo.planName,
                data_display: planInfo.dataDisplay,
                data_mb: planInfo.dataMb || 0,
                validity_days: planInfo.validityDays,
                wholesale_usd: planInfo.wholesaleUsd || 0,
                price_usd: priceUsd,
                fee_usd: feeUsd,
                total_usd: totalUsd,
                exchange_rate: usdToNgn,
                price_ngn: totalNgn,
                debit_currency: debitCurrency,
                debit_amount: debitAmount,
                delivery_email: email,
                status: 'pending',
                reconciliation_attempts: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

        if (orderError) throw new Error(`Order insert failed: ${orderError.message}`);

        // ─── 6. Debit wallet
        debitResult = await LedgerService.debitWallet(
            userId,
            debitAmount,
            debitCurrency,
            `eSIM: ${planInfo.planName} (${planInfo.countryName})`,
            { order_id: orderId, reference, service: 'esim', product_id: productId, country_iso3: countryIso3 }
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

        // ─── 7. DT One quote (eSIM = no phone)
        providerQuoteStarted = true;

        const quote = await dtoneService.createQuote({
            productId,
            phone: null,
            mode: 'FIXED',
            callbackUrl: getPublicCallbackUrl('/api/webhooks/dtone/esim')
        });

        if (!quote?.transactionId) {
            throw new Error('DT One did not return a transaction ID');
        }

        const dtoneTxId = String(quote.transactionId);
        const dtoneExternalId = quote.externalId || null;

        await supabaseAdmin
            .from('esim_transactions')
            .update({
                provider_transaction_id: dtoneTxId,
                dtone_external_id: dtoneExternalId,
                provider_status: 'CREATED',
                provider_response: quote.raw || quote,
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);

        // ─── 8. Confirm
        const confirmation = await dtoneService.confirmTransaction(dtoneTxId);
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

        // ─── 9. Handle final status
        const normalized = dtoneService.normalizeStatus(confirmation?.status || providerStatus);

        if (normalized.final && normalized.status === 'completed') {
            await finalizeEsimOrder(orderId, dtoneTxId);
            return res.json({
                success: true,
                data: { transactionId: orderId, reference, externalId: dtoneExternalId, status: 'completed' }
            });
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
        console.error('❌ POST /esim/purchase error:', error.message, error.providerData || '');

        if (orderId) {
            try {
                if (walletDebited && !providerQuoteStarted) {
                    await refundEsimOrder(userId, orderId, error.message || 'Quote failed');
                } else if (walletDebited && providerQuoteStarted) {
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

        return res.status(500).json({ success: false, error: error.message || 'Failed to create eSIM order' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/esim/status/:transactionId
// ════════════════════════════════════════════════════════════════════════
router.get('/esim/status/:transactionId', authMiddleware, async (req, res) => {
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

        if (order.status === 'completed') {
            return res.json({
                success: true,
                data: {
                    status: 'completed',
                    isFinal: true,
                    qrCodeUrl: order.qr_code_url,
                    activationCode: order.activation_code,
                    lpaString: order.lpa_string,
                    smdpAddress: order.smdp_address,
                    matchingId: order.matching_id,
                    instructions: order.instructions,
                    errorMessage: null
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

        // ─── Active DT One query
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
                    }
                }

                if (dtoneResult.status === 'completed') {
                    await finalizeEsimOrder(order.id, order.provider_transaction_id, dtoneResult);
                    const fresh = await supabaseAdmin.from('esim_transactions').select('*').eq('id', order.id).single();
                    return res.json({ success: true, data: shapeCompleted(fresh.data) });
                }

                if (dtoneResult.isFinal && ['failed', 'cancelled', 'reversed'].includes(dtoneResult.status)) {
                    await refundEsimOrder(req.user.id, order.id, dtoneResult.errorMessage || `Provider: ${dtoneResult.providerStatus}`);
                    return res.json({
                        success: true,
                        data: {
                            status: dtoneResult.status,
                            isFinal: true,
                            qrCodeUrl: null,
                            errorMessage: dtoneResult.errorMessage || 'Provider rejected order'
                        }
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
        console.error('❌ GET /esim/status error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to check order status' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/webhooks/dtone/esim
// ════════════════════════════════════════════════════════════════════════
router.post('/webhooks/dtone/esim', async (req, res) => {
    res.status(200).json({ received: true });

    try {
        const payload = req.body || {};
        const externalId = payload.external_id || payload.transaction_id;
        const dtoneTxId = payload.id || payload.transaction_id;
        if (!dtoneTxId && !externalId) return;

        let query = supabaseAdmin.from('esim_transactions').select('*');
        if (externalId) query = query.eq('dtone_external_id', externalId);
        else            query = query.eq('provider_transaction_id', String(dtoneTxId));

        const { data: order } = await query.maybeSingle();
        if (!order) {
            console.warn('⚠️ Webhook for unknown eSIM order:', externalId || dtoneTxId);
            return;
        }

        await supabaseAdmin
            .from('esim_transactions')
            .update({
                provider_status: String(payload.status?.message || payload.status || 'UNKNOWN').toUpperCase(),
                provider_response: payload,
                metadata: { ...(order.metadata || {}), last_webhook: payload, received_at: new Date().toISOString() },
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);

        const normalized = dtoneService.normalizeStatus(payload.status || payload);

        if (normalized.final && normalized.status === 'completed') {
            const full = await dtoneService.queryTransaction(dtoneTxId).catch(() => null);
            await finalizeEsimOrder(order.id, String(dtoneTxId), full || { raw: payload });
        } else if (normalized.final && ['failed', 'cancelled', 'reversed'].includes(normalized.status)) {
            await refundEsimOrder(order.user_id, order.id, `Webhook: ${normalized.code}`);
        }
    } catch (err) {
        console.error('❌ Webhook processing error:', err.message);
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/admin/esim/force-reconcile-all
// ════════════════════════════════════════════════════════════════════════
router.post('/admin/esim/force-reconcile-all', authMiddleware, async (req, res) => {
    try {
        const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase());
        if (!adminEmails.includes((req.user.email || '').toLowerCase())) {
            return res.status(403).json({ success: false, error: 'Admin only' });
        }

        const { data: stuck } = await supabaseAdmin
            .from('esim_transactions')
            .select('*')
            .in('status', ['processing', 'pending'])
            .limit(100);

        let fixed = 0;
        for (const tx of (stuck || [])) {
            if (!tx.provider_transaction_id) continue;
            try {
                const dtoneResult = await dtoneService.queryTransaction(tx.provider_transaction_id);
                if (dtoneResult.status === 'completed') {
                    await finalizeEsimOrder(tx.id, tx.provider_transaction_id, dtoneResult);
                    fixed++;
                } else if (dtoneResult.isFinal && ['failed', 'cancelled', 'reversed'].includes(dtoneResult.status)) {
                    await refundEsimOrder(tx.user_id, tx.id, `Force reconcile: ${dtoneResult.providerStatus}`);
                    fixed++;
                }
            } catch (e) {
                console.warn(`Reconcile ${tx.id} failed: ${e.message}`);
            }
        }

        res.json({ success: true, data: { checked: stuck?.length || 0, fixed } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════

function shapeCompleted(t) {
    return {
        status: 'completed',
        isFinal: true,
        qrCodeUrl: t.qr_code_url,
        activationCode: t.activation_code,
        lpaString: t.lpa_string,
        smdpAddress: t.smdp_address,
        matchingId: t.matching_id,
        instructions: t.instructions,
        errorMessage: null
    };
}

async function finalizeEsimOrder(orderId, dtoneTxId, dtoneResultOverride = null) {
    const { data: claimed } = await supabaseAdmin
        .from('esim_transactions')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', orderId)
        .in('status', ['processing', 'pending'])
        .select('*')
        .maybeSingle();

    if (!claimed) return;

    let dtoneResult = dtoneResultOverride;
    if (!dtoneResult) {
        try {
            dtoneResult = await dtoneService.queryTransaction(dtoneTxId);
        } catch (e) {
            console.warn('⚠️ Post-complete DT One fetch failed:', e.message);
            dtoneResult = { raw: {} };
        }
    }

    const delivery = dtoneService.extractEsimDelivery(dtoneResult);

    await supabaseAdmin
        .from('esim_transactions')
        .update({
            qr_code_url: delivery.qrCodeUrl || claimed.qr_code_url,
            activation_code: delivery.activationCode || claimed.activation_code,
            lpa_string: delivery.lpaString || claimed.lpa_string,
            smdp_address: delivery.smdpAddress || claimed.smdp_address,
            matching_id: delivery.matchingId || claimed.matching_id,
            instructions: delivery.instructions || claimed.instructions,
            provider_response: dtoneResult.raw || claimed.provider_response,
            provider_status: dtoneResult.providerStatus || claimed.provider_status,
            updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

    // ─── Send delivery email (idempotent)
    try {
        const { data: fresh } = await supabaseAdmin
            .from('esim_transactions')
            .select('*')
            .eq('id', orderId)
            .single();

        if (fresh && !fresh.email_sent && fresh.delivery_email) {
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('username')
                .eq('id', fresh.user_id)
                .maybeSingle();

            const emailRes = await emailService.sendEsimDeliveryEmail({
                email: fresh.delivery_email,
                username: profile?.username || 'Traveller',
                reference: fresh.reference,
                countryName: fresh.country_name,
                planName: fresh.plan_name,
                dataDisplay: fresh.data_display,
                validityDays: fresh.validity_days,
                totalUsd: fresh.total_usd,
                totalNgn: fresh.price_ngn,
                debitCurrency: fresh.debit_currency,
                debitAmount: fresh.debit_amount,
                qrCodeUrl: fresh.qr_code_url,
                activationCode: fresh.activation_code,
                lpaString: fresh.lpa_string,
                smdpAddress: fresh.smdp_address,
                matchingId: fresh.matching_id,
                instructions: fresh.instructions
            });

            if (emailRes?.success) {
                await supabaseAdmin
                    .from('esim_transactions')
                    .update({
                        email_sent: true,
                        email_sent_at: new Date().toISOString(),
                        email_message_id: emailRes.messageId || null
                    })
                    .eq('id', orderId);
                console.log(`📧 eSIM delivery email sent for ${fresh.reference}`);
            } else {
                console.warn(`⚠️ eSIM email not sent for ${fresh.reference}:`, emailRes?.error || emailRes?.message);
            }
        }
    } catch (e) {
        console.error('❌ eSIM delivery email error:', e.message);
    }

    console.log(`✅ eSIM ${orderId} finalized`);
}

async function refundEsimOrder(userId, orderId, reason) {
    try {
        const { data: order } = await supabaseAdmin
            .from('esim_transactions')
            .select('id, user_id, reference, country_name, plan_name, total_usd, price_ngn, debit_currency, debit_amount, ledger_transaction_id, status, refunded, delivery_email')
            .eq('id', orderId)
            .single();

        if (!order) return;
        if (order.refunded === true || order.status === 'refunded') return;

        const { data: claimed } = await supabaseAdmin
            .from('esim_transactions')
            .update({ refunded: true, status: 'refunded', refunded_at: new Date().toISOString(), failure_reason: reason })
            .eq('id', orderId)
            .eq('refunded', false)
            .select('id')
            .maybeSingle();

        if (!claimed) return;

        if (order.ledger_transaction_id) {
            await LedgerService.refundTransaction(
                userId || order.user_id,
                order.ledger_transaction_id,
                `eSIM refund: ${reason}`
            );
        }

        try {
            if (order.delivery_email) {
                const { data: profile } = await supabaseAdmin
                    .from('profiles')
                    .select('username')
                    .eq('id', order.user_id)
                    .maybeSingle();

                await emailService.sendEsimFailureEmail({
                    email: order.delivery_email,
                    username: profile?.username || 'User',
                    reference: order.reference,
                    countryName: order.country_name,
                    planName: order.plan_name,
                    amountUsd: order.total_usd,
                    amountNgn: order.price_ngn,
                    debitCurrency: order.debit_currency,
                    reason,
                    refunded: true
                });
            }
        } catch (e) {
            console.warn('⚠️ Failure email not sent:', e.message);
        }

        console.log(`✅ eSIM ${orderId} refunded: ${reason}`);
    } catch (err) {
        console.error('❌ eSIM refund failed:', err.message);
        await supabaseAdmin
            .from('esim_transactions')
            .update({
                status: 'manual_review',
                failure_reason: `Refund error: ${err.message}. Original reason: ${reason}`,
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);
    }
}

async function lookupEsimPlan(iso3, productId, usdToNgn) {
    try {
        const products = await dtoneService.getEsimProducts(iso3);
        const p = products.find(x => x.productId === String(productId));
        if (!p) return null;

        const allCountries = cache.countries.data || [];
        const countryMeta = allCountries.find(c => c.iso3 === iso3) || { iso3, iso2: '', name: iso3 };

        let wholesaleUsd = null;
        let wholesaleNgn = null;
        if (p.wholesaleCurrency === 'USD') {
            wholesaleUsd = p.wholesaleAmount;
            wholesaleNgn = +(p.wholesaleAmount * usdToNgn).toFixed(2);
        } else if (p.wholesaleCurrency === 'NGN') {
            wholesaleNgn = p.wholesaleAmount;
            wholesaleUsd = +(p.wholesaleAmount / usdToNgn).toFixed(2);
        } else {
            return null;
        }

        const priceUsd = +(wholesaleUsd * (1 + VENDOR_MARKUP_PCT)).toFixed(2);

        return {
            productId: p.productId,
            planName: p.planName,
            dataDisplay: p.dataDisplay,
            dataMb: p.dataMb,
            validityDays: p.validityDays,
            priceUsd,
            wholesaleUsd,
            wholesaleNgn,
            countryIso2: countryMeta.iso2 || '',
            countryName: p.countryName || countryMeta.name || iso3,
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