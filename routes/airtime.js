// routes/airtime.js
// PRODUCTION-READY DT ONE AIRTIME ROUTES
//
// FIXES APPLIED:
// 1. NULL-safe reconciliation (.or + is.null on the sweep query handled in service)
// 2. 25-minute hard age cap (not 20) so DT One has time to finalize SUBMITTED
// 3. NOT_FOUND is a distinct state
// 4. No premature refund on ambiguous DECLINED from provider
// 5. Crash rollback only when provider confirm was NEVER started
// 6. Webhook stores raw payload in metadata
// 7. Admin route to bulk force-reconcile stuck transactions
// 8. /operators returns NETWORKS ONLY
// 9. /quote parses source.amount.min/max correctly, captures real wholesale
// 10. CALLBACK_URL GUARD — DT One rejects localhost / HTTP URLs.
//     We only register callback_url when it's a public HTTPS URL.
// 11. GET /:reference syncs with DT One only within the 25-minute window

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const countriesLib = require('i18n-iso-countries');

const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService } = require('../services/ledgerService');
const IdempotencyService = require('../services/idempotencyService');
const dtoneService = require('../services/dtoneService');
const cacheService = require('../services/cacheService');

countriesLib.registerLocale(require('i18n-iso-countries/langs/en.json'));

const QUOTE_EXPIRY_SECONDS   = 300;
const MAX_PIN_ATTEMPTS       = 4;
const PIN_LOCK_DURATION      = 60 * 60 * 1000;
const MILESSPACE_FEE_PERCENT = Number(process.env.MILESSPACE_FEE_PERCENT || 0.05);
const MIN_USD                = 0.5;
const MAX_USD                = Number(process.env.AIRTIME_MAX_USD || 1000);
const MAX_PROCESSING_MS      = 25 * 60 * 1000; // 25-min hard cap (matches reconciliation)

// ═══ FX TABLE ═══
const USD_TO_LOCAL = {
    USD: 1,
    NGN: Number(process.env.MILESSPACE_USD_TO_NGN || 1600),
    GHS: Number(process.env.MILESSPACE_USD_TO_GHS || 15),
    KES: Number(process.env.MILESSPACE_USD_TO_KES || 129),
    ZAR: Number(process.env.MILESSPACE_USD_TO_ZAR || 18),
    INR: Number(process.env.MILESSPACE_USD_TO_INR || 83),
    AFN: Number(process.env.MILESSPACE_USD_TO_AFN || 70),
    EUR: Number(process.env.MILESSPACE_USD_TO_EUR || 0.92),
    GBP: Number(process.env.MILESSPACE_USD_TO_GBP || 0.79),
    PHP: Number(process.env.MILESSPACE_USD_TO_PHP || 58),
    IDR: Number(process.env.MILESSPACE_USD_TO_IDR || 16000),
    VND: Number(process.env.MILESSPACE_USD_TO_VND || 25000),
    PKR: Number(process.env.MILESSPACE_USD_TO_PKR || 278),
    BDT: Number(process.env.MILESSPACE_USD_TO_BDT || 120),
    EGP: Number(process.env.MILESSPACE_USD_TO_EGP || 49),
    TRY: Number(process.env.MILESSPACE_USD_TO_TRY || 34),
    MXN: Number(process.env.MILESSPACE_USD_TO_MXN || 20),
    BRL: Number(process.env.MILESSPACE_USD_TO_BRL || 5.5),
    RUB: Number(process.env.MILESSPACE_USD_TO_RUB || 95)
};

function getLocalRate(currency) {
    const c = String(currency || '').toUpperCase();
    const rate = USD_TO_LOCAL[c];
    if (!rate || !Number.isFinite(rate) || rate <= 0) return null;
    return rate;
}

// ═══ CACHES ═══
const inflightOperators = new Map();
const inflightCountries = { promise: null };
const swrOperators = new Map();
const SWR_TTL_MS = 30 * 60 * 1000;

// ═══ HELPERS ═══
function generateReference() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
    return `AT-${ts}-${rand}`;
}

function maskPhone(phone) {
    if (!phone) return 'N/A';
    return `****${String(phone).slice(-4)}`;
}

function getFlagFromAlpha3(alpha3) {
    try {
        const alpha2 = countriesLib.alpha3ToAlpha2(alpha3);
        if (!alpha2) return '🌐';
        return alpha2.toUpperCase().split('').map(c =>
            String.fromCodePoint(127397 + c.charCodeAt(0))
        ).join('');
    } catch { return '🌐'; }
}

function getDialCode(alpha3) {
    try {
        const alpha2 = countriesLib.alpha3ToAlpha2(alpha3);
        if (!alpha2) return '+' + alpha3;
        const map = {
            'NG': '+234', 'GH': '+233', 'KE': '+254', 'ZA': '+27', 'US': '+1',
            'GB': '+44', 'CA': '+1', 'AU': '+61', 'IN': '+91', 'PK': '+92',
            'BD': '+880', 'BR': '+55', 'MX': '+52', 'EG': '+20', 'SA': '+966',
            'AE': '+971', 'FR': '+33', 'DE': '+49', 'IT': '+39', 'ES': '+34',
            'JP': '+81', 'KR': '+82', 'CN': '+86', 'RU': '+7', 'TR': '+90',
            'AF': '+93', 'TZ': '+255', 'UG': '+256', 'PH': '+63', 'ID': '+62',
            'VN': '+84'
        };
        return map[alpha2] || '+' + alpha3;
    } catch { return '+' + alpha3; }
}

function normalizeCountryCodes(value) {
    if (!value) return null;
    const input = String(value).trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(input)) return { iso3: input, iso2: countriesLib.alpha3ToAlpha2(input) || null };
    if (/^[A-Z]{2}$/.test(input)) return { iso2: input, iso3: countriesLib.alpha2ToAlpha3(input) || null };
    return null;
}

// ═══ CALLBACK URL HELPER ═══
// DT One rejects localhost, HTTP, and non-public URLs.
// Only return a callback URL if it's a public HTTPS URL.
function getPublicCallbackUrl() {
    const appUrl = process.env.APP_URL;
    if (!appUrl) {
        console.log('ℹ️ [CALLBACK] No APP_URL set — callback will not be registered');
        return undefined;
    }

    const base = String(appUrl).replace(/\/+$/, '');

    // Must be HTTPS
    if (!/^https:\/\//i.test(base)) {
        console.warn(`⚠️ [CALLBACK] Skipping callback_url — APP_URL is not HTTPS: ${base}`);
        return undefined;
    }

    // Must not be localhost / loopback / private
    const lower = base.toLowerCase();
    if (
        lower.includes('localhost') ||
        lower.includes('127.0.0.1') ||
        lower.includes('0.0.0.0') ||
        lower.includes('::1') ||
        /\.local(\/|$)/.test(lower)
    ) {
        console.warn(`⚠️ [CALLBACK] Skipping callback_url — APP_URL points to local: ${base}`);
        return undefined;
    }

    return `${base}/api/airtime/webhook`;
}

// ═══ CACHED DATA ═══
async function getCachedCountries() {
    return await cacheService.getOrSet('dtone_countries_v21', async () => {
        const countries = await dtoneService.getCountries('AIRTIME');
        countries.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        return countries
            .filter(c => c?.iso_code && c?.name)
            .map(c => {
                const alpha3 = String(c.iso_code).toUpperCase();
                const iso2 = countriesLib.alpha3ToAlpha2(alpha3);
                return {
                    code: alpha3,
                    iso2: iso2 || null,
                    name: c.name,
                    flag: getFlagFromAlpha3(alpha3),
                    dial: getDialCode(alpha3)
                };
            });
    }, 24 * 60 * 60);
}

async function getCachedOperators(countryIso3) {
    const key = `dtone_operators_v21_${countryIso3.toUpperCase()}`;
    return await cacheService.getOrSet(key, async () => {
        return await dtoneService.getOperators(countryIso3.toUpperCase(), 'AIRTIME');
    }, 60 * 60);
}

async function getCachedOperatorsFast(countryIso3) {
    const key = countryIso3.toUpperCase();
    const cached = swrOperators.get(key);

    if (cached && (Date.now() - cached.time) < SWR_TTL_MS) {
        return cached.data;
    }
    if (inflightOperators.has(key)) {
        return inflightOperators.get(key);
    }
    if (cached) {
        const refreshPromise = (async () => {
            try {
                const fresh = await getCachedOperators(key);
                swrOperators.set(key, { data: fresh, time: Date.now() });
                return fresh;
            } catch (e) {
                console.error(`❌ Background refresh failed for ${key}:`, e.message);
                return cached.data;
            } finally {
                inflightOperators.delete(key);
            }
        })();
        inflightOperators.set(key, refreshPromise);
        return cached.data;
    }
    const promise = (async () => {
        try {
            const fresh = await getCachedOperators(key);
            swrOperators.set(key, { data: fresh, time: Date.now() });
            return fresh;
        } finally {
            inflightOperators.delete(key);
        }
    })();
    inflightOperators.set(key, promise);
    return promise;
}

async function getAirtimeProductsForOperator(iso3, operatorId) {
    return await dtoneService.getProducts({
        countryIsoCode: iso3,
        operatorId: Number(operatorId),
        serviceId: 1,
        subserviceId: 11
    });
}

// ═══ QUOTE DB ═══
async function createQuoteRecord(data) {
    const { data: quote, error } = await supabaseAdmin
        .from('airtime_quotes')
        .insert({
            quote_id: data.quote_id,
            user_id: data.user_id,
            dtone_transaction_id: data.dtone_transaction_id,
            dtone_external_id: data.dtone_external_id,
            country_iso3: data.country_iso3,
            country_iso2: data.country_iso2,
            operator_id: data.operator_id,
            operator_name: data.operator_name,
            product_id: data.product_id,
            product_type: data.product_type,
            phone_number: data.phone_number,
            source_amount: data.source_amount,
            source_currency: data.source_currency,
            destination_amount: data.destination_amount,
            destination_currency: data.destination_currency,
            provider_wholesale: data.provider_wholesale,
            provider_currency: data.provider_currency,
            milespace_fee: data.milespace_fee,
            customer_usd: data.customer_usd,
            customer_ngn: data.customer_ngn,
            status: 'created',
            expires_at: data.expires_at,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .select()
        .single();
    if (error) throw new Error('Failed to save quote: ' + error.message);
    return quote;
}

async function getQuoteForUser(quoteId, userId) {
    const { data, error } = await supabaseAdmin
        .from('airtime_quotes')
        .select('*')
        .eq('quote_id', quoteId)
        .eq('user_id', userId)
        .single();
    if (error || !data) return null;
    return data;
}

async function consumeQuote(quoteId) {
    const { data, error } = await supabaseAdmin
        .from('airtime_quotes')
        .update({
            status: 'consumed',
            consumed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('quote_id', quoteId)
        .eq('status', 'created')
        .select()
        .maybeSingle();
    if (error) return null;
    return data;
}

// ═══ PIN ═══
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

    if (error || !profile) return { valid: false, error: 'User not found', code: 'USER_NOT_FOUND' };
    if (!profile.transaction_pin_hash) return { valid: false, error: 'PIN not set', code: 'PIN_NOT_SET', pinNotSet: true };

    if (profile.transaction_pin_locked_until) {
        const lockUntil = new Date(profile.transaction_pin_locked_until);
        if (lockUntil > new Date()) {
            const mins = Math.ceil((lockUntil.getTime() - Date.now()) / 60000);
            return { valid: false, error: `Try again in ${mins} minute(s).`, code: 'PIN_LOCKED', remaining_minutes: mins, can_reset: true };
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
            await supabaseAdmin.from('profiles').update({
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: lockUntil.toISOString()
            }).eq('id', userId);
            return { valid: false, error: 'PIN locked for 1 hour.', code: 'PIN_LOCKED', remaining_minutes: 60, can_reset: true };
        }
        await supabaseAdmin.from('profiles').update({ transaction_pin_attempts: attempts }).eq('id', userId);
        return { valid: false, error: `Incorrect PIN. ${MAX_PIN_ATTEMPTS - attempts} attempts left.`, code: 'INVALID_PIN', attempts_remaining: MAX_PIN_ATTEMPTS - attempts };
    }

    await supabaseAdmin.from('profiles').update({
        transaction_pin_attempts: 0,
        transaction_pin_locked_until: null
    }).eq('id', userId);
    return { valid: true };
}

// ═══════════════════════════════════════════════════════════════════════
// PROVIDER STATUS SYNC
// ═══════════════════════════════════════════════════════════════════════
async function syncAirtimeProviderStatus(transaction) {
    if (!transaction?.provider_transaction_id) {
        return transaction;
    }

    const currentStatus = String(transaction.status || '').toLowerCase();
    if (['completed', 'failed', 'refunded', 'manual_review', 'cancelled', 'reversed'].includes(currentStatus)) {
        return transaction;
    }

    // HARD 25-MINUTE CAP
    const ageMs = Date.now() - new Date(transaction.created_at).getTime();
    if (ageMs >= MAX_PROCESSING_MS) {
        console.log(`⏰ [AIRTIME SYNC] ${transaction.reference} exceeded 25-minute cap`);
        return {
            ...transaction,
            _stuck: true,
            _stuck_reason: 'Exceeded 25-minute processing cap'
        };
    }

    try {
        const provider = await dtoneService.queryTransaction(
            transaction.provider_transaction_id
        );

        console.log('📡 [AIRTIME SYNC]', {
            reference: transaction.reference,
            providerStatus: provider?.providerStatus,
            normalizedStatus: provider?.status,
            errorCode: provider?.errorCode,
            errorMessage: provider?.errorMessage,
            notFound: provider?.notFound
        });

        if (!provider || !provider.status) {
            return transaction;
        }

        const normalizedStatus = String(provider.status).toLowerCase();

        if (normalizedStatus === 'completed') {
            const { data: updated, error } = await supabaseAdmin
                .from('airtime_transactions')
                .update({
                    status: 'completed',
                    provider_status: provider.providerStatus || 'COMPLETED',
                    completed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', transaction.id)
                .in('status', ['processing', 'pending'])
                .select('*')
                .maybeSingle();

            if (error) {
                console.error('❌ Sync completed update failed:', error.message);
                return transaction;
            }

            return updated || {
                ...transaction,
                status: 'completed',
                provider_status: provider.providerStatus || 'COMPLETED',
                completed_at: new Date().toISOString()
            };
        }

        if (normalizedStatus === 'not_found' || provider.notFound) {
            console.warn(`⚠️ [AIRTIME SYNC] ${transaction.reference} not found by DT One ID — reconciliation will retry`);

            await supabaseAdmin
                .from('airtime_transactions')
                .update({
                    provider_status: provider.providerStatus || 'NOT_FOUND',
                    updated_at: new Date().toISOString(),
                    metadata: {
                        ...(transaction.metadata || {}),
                        last_sync_status: 'not_found',
                        last_sync_at: new Date().toISOString(),
                        needs_external_id_lookup: true
                    }
                })
                .eq('id', transaction.id);

            return {
                ...transaction,
                provider_status: 'NOT_FOUND',
                metadata: {
                    ...(transaction.metadata || {}),
                    last_sync_status: 'not_found',
                    last_sync_at: new Date().toISOString(),
                    needs_external_id_lookup: true
                }
            };
        }

        if (
            normalizedStatus === 'failed' ||
            normalizedStatus === 'cancelled' ||
            normalizedStatus === 'reversed'
        ) {
            const { data: updated, error } = await supabaseAdmin
                .from('airtime_transactions')
                .update({
                    provider_status: provider.providerStatus || normalizedStatus.toUpperCase(),
                    failure_code: provider.errorCode || null,
                    failure_message: provider.errorMessage || null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', transaction.id)
                .select('*')
                .maybeSingle();

            if (error) {
                console.error('❌ Sync failed update failed:', error.message);
                return transaction;
            }

            return updated || transaction;
        }

        return {
            ...transaction,
            provider_status: provider.providerStatus || transaction.provider_status
        };

    } catch (error) {
        console.warn(`⚠️ [AIRTIME SYNC] ${transaction.reference}:`, error.message);
        return transaction;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════

router.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        service: 'airtime',
        provider: 'dtone',
        env: dtoneService.env,
        callbackConfigured: Boolean(getPublicCallbackUrl()),
        timestamp: new Date().toISOString()
    });
});

router.get('/countries', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=7200');
        if (inflightCountries.promise) {
            const countries = await inflightCountries.promise;
            return res.json({ success: true, total: countries.length, data: countries });
        }
        inflightCountries.promise = getCachedCountries();
        try {
            const countries = await inflightCountries.promise;
            res.json({ success: true, total: countries.length, data: countries });
        } finally {
            inflightCountries.promise = null;
        }
    } catch (error) {
        console.error('❌ Countries error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to load countries', code: 'SERVER_ERROR' });
    }
});

router.get('/operators', async (req, res) => {
    try {
        const { country } = req.query;
        if (!country) {
            return res.status(400).json({
                success: false,
                error: 'Country required',
                code: 'COUNTRY_REQUIRED'
            });
        }

        const normalized = normalizeCountryCodes(country);
        if (!normalized?.iso3) {
            return res.status(400).json({
                success: false,
                error: 'Invalid country',
                code: 'INVALID_COUNTRY'
            });
        }

        res.set('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');

        const operators = await getCachedOperatorsFast(normalized.iso3);

        const data = operators.map(op => ({
            id: Number(op.id),
            name: op.name || `Operator ${op.id}`,
            logo: op.logo || dtoneService.getOperatorLogo(op.id, 1),
            logoMedium: op.logo_medium || dtoneService.getOperatorLogo(op.id, 2),
            logoLarge: op.logo_large || dtoneService.getOperatorLogo(op.id, 3)
        }));

        res.json({
            success: true,
            country: {
                iso3: normalized.iso3,
                iso2: normalized.iso2
            },
            total: data.length,
            data
        });

    } catch (error) {
        console.error('❌ Operators error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to load operators',
            code: 'SERVER_ERROR'
        });
    }
});

router.get('/me', authMiddleware, async (req, res) => {
    try {
        const balances = await LedgerService.getAllBalances(req.user.id);
        res.json({
            success: true,
            data: {
                wallet_ngn: balances.NGN || 0,
                wallet_usd: balances.USD || 0,
                cashback: balances.CASHBACK || 0
            }
        });
    } catch (error) {
        console.error('❌ Balance error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch balances' });
    }
});

router.post('/quote', authMiddleware, async (req, res) => {
    try {
        const { country, phone, operator_id, source_amount_usd } = req.body;

        console.log('\n═══════════════════════════════════════════════');
        console.log('📡 [QUOTE REQUEST]', {
            country,
            phone: maskPhone(phone),
            operator_id,
            source_amount_usd
        });

        if (!country || !phone || !operator_id || source_amount_usd == null) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                code: 'REQUIRED_FIELDS'
            });
        }

        const normalized = normalizeCountryCodes(country);
        if (!normalized?.iso3 || !normalized?.iso2) {
            return res.status(400).json({
                success: false,
                error: 'Invalid country',
                code: 'INVALID_COUNTRY'
            });
        }

        const iso3 = normalized.iso3;
        const iso2 = normalized.iso2;
        const srcAmountUSD = Number(source_amount_usd);

        if (!Number.isFinite(srcAmountUSD) || srcAmountUSD < MIN_USD || srcAmountUSD > MAX_USD) {
            return res.status(400).json({
                success: false,
                error: `Amount must be between $${MIN_USD} and $${MAX_USD}`,
                code: 'INVALID_AMOUNT'
            });
        }

        const parsed = parsePhoneNumberFromString(phone, iso2);
        if (!parsed || !parsed.isValid()) {
            return res.status(400).json({
                success: false,
                error: `Invalid phone for ${iso3}`,
                code: 'INVALID_PHONE'
            });
        }

        const operators = await getCachedOperatorsFast(iso3);
        const selectedOp = operators.find(op => String(op.id) === String(operator_id));
        if (!selectedOp) {
            return res.status(400).json({
                success: false,
                error: 'Selected network is not available for this country',
                code: 'OPERATOR_NOT_FOUND'
            });
        }

        let products = [];
        try {
            products = await getAirtimeProductsForOperator(iso3, operator_id);
        } catch (productsError) {
            console.error('❌ [QUOTE] Product fetch failed:', productsError.message);
            return res.status(400).json({
                success: false,
                error: 'Could not load available products for this network',
                code: 'PRODUCT_FETCH_FAILED'
            });
        }

        if (!Array.isArray(products) || products.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'This network currently has no available products',
                code: 'NO_PRODUCTS'
            });
        }

        const rangedSourceProducts = products.filter(product => {
            if (product.type !== 'RANGED_VALUE_RECHARGE') return false;
            const modes = Array.isArray(product.accepted_calculation_modes)
                ? product.accepted_calculation_modes
                : [];
            return modes.includes('SOURCE_AMOUNT');
        });

        if (rangedSourceProducts.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'This network does not support variable recharge amounts. Please select another network.',
                code: 'RANGED_NOT_SUPPORTED'
            });
        }

        let selectedProduct = rangedSourceProducts.find(p =>
            String(p.source?.unit || '').toUpperCase() === 'USD'
        );

        let sourceCurrency = 'USD';
        let needsConversion = false;
        let rate = 1;

        if (!selectedProduct) {
            for (const candidate of rangedSourceProducts) {
                const cur = String(candidate.source?.unit || '').toUpperCase();
                const r = getLocalRate(cur);
                if (r) {
                    selectedProduct = candidate;
                    sourceCurrency = cur;
                    needsConversion = true;
                    rate = r;
                    break;
                }
            }
        }

        if (!selectedProduct) {
            return res.status(400).json({
                success: false,
                error: 'This network does not support a variable amount in a supported currency.',
                code: 'NO_SUPPORTED_CURRENCY'
            });
        }

        const sourceAmountForProvider = needsConversion
            ? Math.round(srcAmountUSD * rate)
            : srcAmountUSD;

        // source.amount is an object { min, max } per DT One docs
        const pMin = Number(selectedProduct.source?.amount?.min);
        const pMax = Number(selectedProduct.source?.amount?.max);

        if (Number.isFinite(pMin) && sourceAmountForProvider < pMin) {
            const humanMin = needsConversion ? (pMin / rate).toFixed(2) : pMin.toFixed(2);
            return res.status(400).json({
                success: false,
                error: `Minimum amount for this network is $${humanMin}`,
                code: 'AMOUNT_BELOW_MIN'
            });
        }
        if (Number.isFinite(pMax) && sourceAmountForProvider > pMax) {
            const humanMax = needsConversion ? (pMax / rate).toFixed(2) : pMax.toFixed(2);
            return res.status(400).json({
                success: false,
                error: `Maximum amount for this network is $${humanMax}`,
                code: 'AMOUNT_ABOVE_MAX'
            });
        }

        console.log(`📡 [QUOTE] Product=${selectedProduct.id} sourceCurrency=${sourceCurrency} amount=${sourceAmountForProvider}`);

        // ═══ CALLBACK URL GUARD — DT One requires public HTTPS ═══
        const callbackUrl = getPublicCallbackUrl();
        if (callbackUrl) {
            console.log(`🔔 [QUOTE] Callback URL: ${callbackUrl}`);
        } else {
            console.log('ℹ️ [QUOTE] No callback URL — status will be polled by reconciliation');
        }

        let quoteResult;
        try {
            quoteResult = await dtoneService.createQuote({
                productId: selectedProduct.id,
                phone: parsed.number,
                mode: 'RANGED_SOURCE',
                sourceAmount: sourceAmountForProvider,
                sourceCurrency: sourceCurrency,
                callbackUrl
            });
        } catch (error) {
            console.error('❌ [QUOTE] DT One error:', error.message);
            return res.status(400).json({
                success: false,
                error: error.message || 'Provider could not process this amount',
                code: 'PROVIDER_ERROR'
            });
        }

        if (!quoteResult.success) {
            return res.status(400).json({
                success: false,
                error: 'Provider did not return a valid quote',
                code: 'QUOTE_ERROR'
            });
        }

        const destAmount = quoteResult.destination?.amount;
        const destCurrency = quoteResult.destination?.unit;

        if (!destAmount || destAmount <= 0 || !destCurrency) {
            console.error('❌ [QUOTE] Missing destination amount');
            try { await dtoneService.cancelTransaction(quoteResult.transactionId); } catch (e) {}
            return res.status(400).json({
                success: false,
                error: 'Provider did not return a recipient amount',
                code: 'CALCULATION_ERROR'
            });
        }

        // Capture ACTUAL DT One wholesale price when returned
        const providerWholesale =
            quoteResult.wholesale?.amount ??
            sourceAmountForProvider;
        const providerCurrency =
            quoteResult.wholesale?.unit ??
            sourceCurrency;

        const feeUSD = Number((srcAmountUSD * MILESSPACE_FEE_PERCENT).toFixed(2));
        const totalPriceUSD = Number((srcAmountUSD + feeUSD).toFixed(2));
        const usdToNgn = Number(process.env.MILESSPACE_USD_TO_NGN || 1600);
        const customerNgn = Number((totalPriceUSD * usdToNgn).toFixed(2));

        const balances = await LedgerService.getAllBalances(req.user.id);
        const usdBalance = balances.USD || 0;
        const ngnBalance = balances.NGN || 0;

        const quoteId = generateReference();
        const expiresAt = new Date(Date.now() + QUOTE_EXPIRY_SECONDS * 1000);

        try {
            await createQuoteRecord({
                quote_id: quoteId,
                user_id: req.user.id,
                dtone_transaction_id: quoteResult.transactionId,
                dtone_external_id: quoteResult.externalId,
                country_iso3: iso3,
                country_iso2: iso2,
                operator_id: selectedOp.id,
                operator_name: selectedOp.name,
                product_id: selectedProduct.id,
                product_type: 'RANGED_SOURCE',
                phone_number: parsed.number,
                source_amount: sourceAmountForProvider,
                source_currency: sourceCurrency,
                destination_amount: destAmount,
                destination_currency: destCurrency,
                provider_wholesale: providerWholesale,
                provider_currency: providerCurrency,
                milespace_fee: feeUSD,
                customer_usd: totalPriceUSD,
                customer_ngn: customerNgn,
                expires_at: expiresAt.toISOString()
            });
        } catch (dbError) {
            console.error('❌ Quote save failed:', dbError.message);
            try { await dtoneService.cancelTransaction(quoteResult.transactionId); } catch (e) {}
            return res.status(503).json({
                success: false,
                error: 'Unable to create quote. Try again.',
                code: 'QUOTE_SAVE_FAILED'
            });
        }

        res.json({
            success: true,
            data: {
                quote_id: quoteId,
                expires_at: expiresAt.toISOString(),
                seconds_remaining: QUOTE_EXPIRY_SECONDS,
                country: {
                    iso3, iso2,
                    name: countriesLib.getName(iso3, 'en') || iso3,
                    flag: getFlagFromAlpha3(iso3),
                    dial: getDialCode(iso3)
                },
                operator: {
                    id: selectedOp.id,
                    name: selectedOp.name,
                    logo: dtoneService.getOperatorLogo(selectedOp.id)
                },
                phone_masked: maskPhone(parsed.number),
                source: { amount: srcAmountUSD, currency: 'USD' },
                destination: { amount: destAmount, currency: destCurrency },
                pricing: {
                    provider_cost: { amount: srcAmountUSD, currency: 'USD' },
                    platform_fee: { amount: feeUSD, currency: 'USD' },
                    customer_total: { amount: totalPriceUSD, currency: 'USD' }
                },
                wallets: {
                    USD: {
                        balance: usdBalance,
                        debit: totalPriceUSD,
                        remaining: usdBalance - totalPriceUSD,
                        sufficient: usdBalance >= totalPriceUSD
                    },
                    NGN: {
                        balance: ngnBalance,
                        debit: customerNgn,
                        remaining: ngnBalance - customerNgn,
                        sufficient: ngnBalance >= customerNgn
                    }
                },
                quote_mode: 'RANGED_SOURCE'
            }
        });
    } catch (error) {
        console.error('❌ Quote error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to generate quote',
            code: 'SERVER_ERROR'
        });
    }
});

router.post('/purchase', authMiddleware, async (req, res) => {
    let airtimeTxId = null;
    let debitedAmount = 0;
    let debitedCurrency = null;
    let providerConfirmStarted = false;

    try {
        const userId = req.user.id;
        const { quote_id, wallet_type, transaction_pin } = req.body;
        const idempotencyKey = req.headers['idempotency-key'];

        if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 128) {
            return res.status(400).json({
                success: false,
                error: 'Idempotency-Key header is required',
                code: 'IDEMPOTENCY_REQUIRED'
            });
        }
        if (!quote_id || !wallet_type || !transaction_pin) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                code: 'MISSING_FIELDS'
            });
        }

        const walletType = String(wallet_type).toUpperCase();
        if (!['USD', 'NGN'].includes(walletType)) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported wallet',
                code: 'INVALID_WALLET'
            });
        }

        const idempotentCheck = await IdempotencyService.check(userId, idempotencyKey, '/api/airtime/purchase');
        if (idempotentCheck) {
            return res.json({ success: true, already_processed: true, data: idempotentCheck });
        }

        const quote = await getQuoteForUser(quote_id, userId);
        if (!quote) return res.status(400).json({ success: false, error: 'Invalid quote', code: 'QUOTE_INVALID' });
        if (new Date(quote.expires_at) < new Date()) {
            return res.status(400).json({ success: false, error: 'Quote expired', code: 'QUOTE_EXPIRED' });
        }
        if (quote.status !== 'created') {
            return res.status(400).json({ success: false, error: 'Quote already used', code: 'QUOTE_CONSUMED' });
        }

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) {
            return res.status(400).json({
                success: false,
                error: pinResult.error,
                code: pinResult.code,
                attempts_remaining: pinResult.attempts_remaining,
                can_reset: pinResult.can_reset
            });
        }

        let paymentCurrency, paymentAmount;
        if (walletType === 'USD') {
            paymentCurrency = 'USD';
            paymentAmount = parseFloat(quote.customer_usd);
        } else {
            paymentCurrency = 'NGN';
            const usdToNgn = Number(process.env.MILESSPACE_USD_TO_NGN || 1600);
            paymentAmount = Number((parseFloat(quote.customer_usd) * usdToNgn).toFixed(2));
        }

        if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid payment amount', code: 'INVALID_AMOUNT' });
        }

        const balances = await LedgerService.getAllBalances(userId);
        const balance = paymentCurrency === 'USD' ? (balances.USD || 0) : (balances.NGN || 0);
        if (balance < paymentAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient ${paymentCurrency}. Need ${paymentAmount.toFixed(2)}, have ${balance.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                required: paymentAmount,
                balance
            });
        }

        const consumedQuote = await consumeQuote(quote_id);
        if (!consumedQuote) {
            return res.status(409).json({
                success: false,
                error: 'Quote already in use',
                code: 'QUOTE_CONCURRENT_USE'
            });
        }

        const reference = generateReference();
        const { data: airtimeTx, error: airtimeError } = await supabaseAdmin
            .from('airtime_transactions')
            .insert({
                user_id: userId,
                reference,
                quote_id,
                country_code: quote.country_iso3,
                phone_number: quote.phone_number,
                operator_id: String(quote.operator_id),
                operator_name: quote.operator_name,
                destination_amount: quote.destination_amount,
                destination_currency: quote.destination_currency,
                provider_cost: quote.provider_wholesale,
                fee: quote.milespace_fee,
                total_amount: paymentAmount,
                currency: paymentCurrency,
                wallet_type: walletType,
                status: 'processing',
                provider: 'dtone',
                product_id: quote.product_id,
                idempotency_key: idempotencyKey,
                provider_transaction_id: quote.dtone_transaction_id,
                dtone_external_id: quote.dtone_external_id,
                reconciliation_attempts: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();

        if (airtimeError) throw airtimeError;
        airtimeTxId = airtimeTx.id;

        try {
            await LedgerService.debitWallet(
                userId,
                paymentAmount,
                paymentCurrency,
                `Airtime: ${quote.country_iso3} ${maskPhone(quote.phone_number)}`,
                {
                    airtime_reference: reference,
                    quote_id,
                    dtone_transaction_id: quote.dtone_transaction_id
                }
            );
            debitedAmount = paymentAmount;
            debitedCurrency = paymentCurrency;
        } catch (debitError) {
            try {
                await dtoneService.cancelTransaction(quote.dtone_transaction_id);
            } catch (cancelError) {
                console.error('❌ Failed to cancel DT One quote after debit failure:', cancelError.message);
            }

            await supabaseAdmin.from('airtime_transactions').update({
                status: 'failed',
                failure_message: debitError.message,
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTx.id);

            return res.status(400).json({
                success: false,
                error: debitError.message,
                code: 'DEBIT_FAILED'
            });
        }

        // ── Confirm with DT One ──
        let confirmResult;
        let providerAmbiguous = false;
        providerConfirmStarted = true;
        try {
            confirmResult = await dtoneService.confirmTransaction(quote.dtone_transaction_id);
            console.log('📡 [DTONE CONFIRM]', {
                transactionId: quote.dtone_transaction_id,
                status: confirmResult?.status
            });
        } catch (error) {
            console.error('❌ DT One confirm error (ambiguous):', error.message);
            providerAmbiguous = true;
        }

        let normalized = dtoneService.normalizeStatus(confirmResult?.status);

        // Post-confirm status check
        if (!providerAmbiguous && !normalized.final) {
            try {
                const freshProvider = await dtoneService.queryTransaction(
                    quote.dtone_transaction_id
                );
                console.log('📡 [DTONE POST-CONFIRM STATUS]', {
                    transactionId: quote.dtone_transaction_id,
                    status: freshProvider.status,
                    providerStatus: freshProvider.providerStatus,
                    errorCode: freshProvider.errorCode,
                    errorMessage: freshProvider.errorMessage,
                    notFound: freshProvider.notFound
                });
                if (freshProvider?.status && !freshProvider.notFound) {
                    normalized = {
                        status: freshProvider.status,
                        final: freshProvider.isFinal
                    };
                    confirmResult = {
                        ...confirmResult,
                        status: freshProvider.providerStatus || freshProvider.status,
                        errorCode: freshProvider.errorCode || null,
                        errorMessage: freshProvider.errorMessage || null
                    };
                }
            } catch (statusError) {
                console.warn('⚠️ Post-confirm status check failed:', statusError.message);
            }
        }

        let finalStatus = 'processing';
        let refunded = false;

        if (normalized.status === 'completed') {
            finalStatus = 'completed';
        } else if (!providerAmbiguous && (normalized.status === 'failed' || normalized.status === 'cancelled')) {
            finalStatus = 'failed';
            refunded = true;
        }

        // DO NOT REFUND ON AMBIGUOUS FAILURE
        // Only refund synchronously if failure is 100% final and unambiguous.
        if (refunded && normalized.final && !providerAmbiguous) {
            try {
                const { data: updated } = await supabaseAdmin
                    .from('airtime_transactions')
                    .update({
                        status: 'failed',
                        refunded: true,
                        failed_at: new Date().toISOString(),
                        failure_code: confirmResult?.errorCode || null,
                        failure_message: confirmResult?.errorMessage || 'Provider declined',
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', airtimeTx.id)
                    .eq('refunded', false)
                    .select('id')
                    .maybeSingle();

                if (updated) {
                    await LedgerService.creditWallet(
                        userId,
                        paymentAmount,
                        paymentCurrency,
                        `Refund: ${reference}`,
                        { refund_reference: `REF-${reference}` }
                    );
                } else {
                    refunded = false;
                    finalStatus = 'manual_review';
                }
            } catch (refundError) {
                finalStatus = 'manual_review';
                refunded = false;
                console.error('❌ Refund failed:', refundError.message);
            }
        } else if (refunded) {
            console.log(`⏳ [PURCHASE] ${reference} ambiguous failure state — reconciliation will resolve`);
            refunded = false;
            finalStatus = 'processing';
        }

        if (finalStatus !== 'failed') {
            await supabaseAdmin.from('airtime_transactions').update({
                status: finalStatus,
                provider_status: confirmResult?.status?.message || confirmResult?.status || null,
                failure_code: confirmResult?.errorCode || null,
                failure_message: confirmResult?.errorMessage || null,
                completed_at: finalStatus === 'completed' ? new Date().toISOString() : null,
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTx.id);
        }

        const responseData = {
            transaction_id: airtimeTx.id,
            reference,
            status: finalStatus,
            refunded,
            destination_amount: quote.destination_amount,
            destination_currency: quote.destination_currency,
            amount_paid: paymentAmount,
            currency_paid: paymentCurrency,
            country: quote.country_iso3,
            phone: maskPhone(quote.phone_number),
            operator: quote.operator_name,
            provider_ambiguous: providerAmbiguous,
            failure_code: confirmResult?.errorCode || null,
            failure_message: confirmResult?.errorMessage || null
        };

        await IdempotencyService.save(userId, idempotencyKey, '/api/airtime/purchase', responseData);

        const balancesAfter = await LedgerService.getAllBalances(userId);

        res.json({
            success: true,
            reference,
            status: finalStatus,
            refunded,
            message: finalStatus === 'completed' ? 'Airtime sent successfully!'
                : finalStatus === 'processing' ? 'Airtime is being processed...'
                : finalStatus === 'manual_review' ? 'Transaction under review.'
                : 'Airtime failed. Funds refunded.',
            data: {
                ...responseData,
                wallet_balance: {
                    USD: balancesAfter.USD || 0,
                    NGN: balancesAfter.NGN || 0
                }
            }
        });
    } catch (error) {
        console.error('❌ Purchase error:', error.message);

        if (airtimeTxId && debitedAmount > 0 && !providerConfirmStarted) {
            try {
                await LedgerService.creditWallet(
                    req.user.id,
                    debitedAmount,
                    debitedCurrency,
                    `Rollback (crash before provider call): ${airtimeTxId}`,
                    { refund_reference: `ROLLBACK-${airtimeTxId}` }
                );
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'failed',
                    refunded: true,
                    failure_message: 'Crashed before provider confirm — auto-refunded',
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTxId).eq('refunded', false);
            } catch (e) {
                console.error('❌ Crash rollback failed:', e.message);
            }
        } else if (airtimeTxId && providerConfirmStarted) {
            console.warn(`⚠️ [PURCHASE] Ambiguous provider state for ${airtimeTxId} — reconciliation will resolve`);
            await supabaseAdmin.from('airtime_transactions').update({
                status: 'processing',
                failure_message: 'Ambiguous provider state — reconciliation will resolve',
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTxId).in('status', ['processing', 'pending']);
        }

        res.status(500).json({
            success: false,
            error: error.message || 'Purchase failed',
            code: 'SERVER_ERROR'
        });
    }
});

router.get('/history', authMiddleware, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = (page - 1) * limit;

        const { data, error, count } = await supabaseAdmin
            .from('airtime_transactions')
            .select('*', { count: 'exact' })
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        const enrichedData = (data || []).map(tx => ({
            ...tx,
            flag: getFlagFromAlpha3(tx.country_code),
            dial: getDialCode(tx.country_code)
        }));

        res.json({
            success: true,
            data: enrichedData,
            pagination: {
                page, limit,
                total: count || 0,
                totalPages: Math.ceil((count || 0) / limit) || 1,
                hasMore: (offset + limit) < (count || 0)
            }
        });
    } catch (error) {
        console.error('❌ History error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch history' });
    }
});

router.get('/:reference', authMiddleware, async (req, res) => {
    try {
        const { data: transaction, error } = await supabaseAdmin
            .from('airtime_transactions')
            .select('*')
            .eq('reference', req.params.reference)
            .eq('user_id', req.user.id)
            .single();

        if (error || !transaction) {
            return res.status(404).json({
                success: false,
                error: 'Transaction not found'
            });
        }

        const tx = await syncAirtimeProviderStatus(transaction);

        tx.flag = getFlagFromAlpha3(tx.country_code);
        tx.dial = getDialCode(tx.country_code);

        if (tx.operator_id) {
            tx.operator_logo = dtoneService.getOperatorLogo(tx.operator_id);
        }

        res.json({
            success: true,
            data: tx
        });
    } catch (error) {
        console.error('❌ Transaction error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch transaction'
        });
    }
});

router.post('/webhook', async (req, res) => {
    try {
        const payload = req.body;
        console.log('📡 Webhook received');

        const transactionId = payload.transaction_id || payload.id;
        const externalId = payload.external_id;
        const status = payload.status?.message || payload.status?.class?.message || payload.status || payload.state;

        if (!transactionId && !externalId) {
            return res.status(400).json({ success: false, error: 'Missing identifier' });
        }

        let query = supabaseAdmin.from('airtime_transactions').select('*');
        if (transactionId) query = query.eq('provider_transaction_id', String(transactionId));
        else if (externalId) query = query.eq('dtone_external_id', externalId);

        const { data: transactions, error: findError } = await query;
        if (findError || !transactions || !transactions.length) {
            return res.status(200).json({ success: true, message: 'Not found' });
        }

        const transaction = transactions[0];
        if (['completed', 'failed', 'refunded'].includes(transaction.status)) {
            return res.status(200).json({ success: true, message: 'Already processed' });
        }

        const normalized = dtoneService.normalizeStatus(status);
        let newStatus = 'processing';
        let doRefund = false;

        if (normalized.status === 'completed') newStatus = 'completed';
        else if (normalized.status === 'failed' || normalized.status === 'cancelled') {
            newStatus = 'failed';
            doRefund = true;
        }

        const lastWebhook = {
            received_at: new Date().toISOString(),
            payload
        };

        if (doRefund && !transaction.refunded) {
            try {
                const { data: updated } = await supabaseAdmin
                    .from('airtime_transactions')
                    .update({
                        status: 'failed',
                        refunded: true,
                        provider_status: status,
                        failed_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        metadata: {
                            ...(transaction.metadata || {}),
                            last_webhook: lastWebhook
                        }
                    })
                    .eq('id', transaction.id)
                    .eq('refunded', false)
                    .select('id')
                    .maybeSingle();

                if (updated) {
                    await LedgerService.creditWallet(
                        transaction.user_id,
                        parseFloat(transaction.total_amount),
                        transaction.currency,
                        `Refund (webhook): ${transaction.reference}`,
                        { refund_reference: `REF-WEBHOOK-${transaction.reference}` }
                    );
                }
            } catch (refundError) {
                console.error('❌ Webhook refund failed:', refundError.message);
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'manual_review',
                    provider_status: status,
                    updated_at: new Date().toISOString()
                }).eq('id', transaction.id);
            }
        } else {
            await supabaseAdmin.from('airtime_transactions').update({
                status: newStatus,
                provider_status: status,
                completed_at: newStatus === 'completed' ? new Date().toISOString() : null,
                updated_at: new Date().toISOString(),
                metadata: {
                    ...(transaction.metadata || {}),
                    last_webhook: lastWebhook
                }
            }).eq('id', transaction.id);
        }

        res.json({ success: true, status: newStatus });
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        res.status(200).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN — Bulk force reconcile
// ═══════════════════════════════════════════════════════════════════════
router.post('/admin/force-reconcile-all', authMiddleware, async (req, res) => {
    const adminEmails = (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

    if (!adminEmails.includes(String(req.user.email || '').toLowerCase())) {
        return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    try {
        const { data: stuck, error } = await supabaseAdmin
            .from('airtime_transactions')
            .select('id')
            .in('status', ['processing', 'pending'])
            .order('created_at', { ascending: true })
            .limit(100);

        if (error) throw error;

        const reconciliation = require('../services/dtoneReconciliationService');
        const results = [];

        for (const row of (stuck || [])) {
            try {
                const r = await reconciliation.forceReconcileAirtime(row.id);
                results.push({ id: row.id, ...r });
            } catch (e) {
                results.push({ id: row.id, success: false, error: e.message });
            }
        }

        res.json({ success: true, count: results.length, results });
    } catch (error) {
        console.error('❌ Force reconcile all error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;