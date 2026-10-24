// routes/airtime.js
// PRODUCTION-READY DT ONE AIRTIME ROUTES
// ─────────────────────────────────────────────────────────────────────────
// CUSTOMER FLOW:
//
//   Step 1 — Fill form → Proceed
//     Frontend only. 2% fee. Breakdown shown locally. NO backend call.
//
//   Step 2 — Review → Proceed again
//     GET /me → wallet balances. Display NGN + USD wallet cards.
//     NO DT One call.
//
//   Step 3 — Select wallet → Pay Now → PIN
//     POST /purchase → atomic debit + DT One create + confirm.
//     DT One is contacted for the FIRST TIME here.
//
// ── FIXES IN THIS REVISION ─────────────────────────────────────────────
//   A. Nigeria "no networks" bug:
//        • Reject empty operator/country lists (never cache []).
//        • Accept every DT One response shape.
//        • Bump cache keys (v22 for operators, v24 for countries).
//        • /operators returns 503 with OPERATORS_UNAVAILABLE — not a
//          misleading empty 200.
//
//   B. [CRITICAL] Money-safety hardening:
//        • Ledger debit is atomic (see LedgerService.debitWallet — the
//          process_transaction RPC enforces sufficient funds).
//        • Every refund uses a deterministic refund_reference so a
//          second call cannot double-credit.
//        • Refund is only attempted after a definitive provider outcome.
//        • Webhook refuses to run without DTONE_WEBHOOK_SECRET in prod.
//        • Idempotency claim is atomic; no silent fallback.
//        • PIN attempts use the RPC; the non-atomic fallback is removed.
//
//   C. [NEW] Preflight endpoint:
//        • POST /preflight validates country, phone, network, amount,
//          product availability, min/max, fee, and total — WITHOUT
//          debiting, writing to the ledger, or contacting DT One's
//          financial endpoints.
//        • Frontend calls this before showing the wallet step, so the
//          user never sees "network unavailable" after being debited.
//        • Response shape mirrors what /purchase will charge, so the
//          review screen numbers are guaranteed to match.
//
//   D. [NEW] Short-lived product catalog cache (5 min per operator):
//        • Avoids fetching 50 products on every purchase.
//        • Deduplicates concurrent identical fetches.
//        • Purchase still revalidates the amount against the cached
//          product — stale cache can only cause a safe failure, never a
//          wrong charge.
// ─────────────────────────────────────────────────────────────────────────

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
const airtimeReconciliation = require('../services/airtimeReconciliationService');

countriesLib.registerLocale(require('i18n-iso-countries/langs/en.json'));

// ─── SANITY CHECK: fail fast if any dependency is missing ───────────
(function verifyDependencies() {
    const checks = [
        ['supabaseAdmin', supabaseAdmin, 'object'],
        ['authMiddleware', authMiddleware, 'function'],
        ['LedgerService', LedgerService, 'function'],
        ['LedgerService.getAllBalances', LedgerService?.getAllBalances, 'function'],
        ['LedgerService.debitWallet', LedgerService?.debitWallet, 'function'],
        ['LedgerService.creditWallet', LedgerService?.creditWallet, 'function'],
        ['IdempotencyService', IdempotencyService, 'function'],
        ['IdempotencyService.claim', IdempotencyService?.claim, 'function'],
        ['IdempotencyService.release', IdempotencyService?.release, 'function'],
        ['dtoneService', dtoneService, 'object'],
        ['dtoneService.getOperators', dtoneService?.getOperators, 'function'],
        ['dtoneService.createQuote', dtoneService?.createQuote, 'function'],
        ['dtoneService.confirmTransaction', dtoneService?.confirmTransaction, 'function'],
        ['cacheService', cacheService, 'object'],
        ['airtimeReconciliation', airtimeReconciliation, 'object'],
        ['airtimeReconciliation.forceReconcileAirtime', airtimeReconciliation?.forceReconcileAirtime, 'function']
    ];
    const missing = checks.filter(([, value, kind]) => typeof value !== kind);
    if (missing.length) {
        const names = missing.map(([name]) => name).join(', ');
        throw new Error(`[airtime] Missing or malformed dependencies: ${names}`);
    }
    console.log('✅ [airtime] All dependencies verified');
})();

// ═══ CONFIG ═══
const MAX_PIN_ATTEMPTS       = 4;
const PIN_LOCK_DURATION      = 60 * 60 * 1000;
const MILESSPACE_FEE_PERCENT = Number(process.env.MILESSPACE_FEE_PERCENT || 0.02);   // 2%
const MIN_USD                = 0.5;
const MAX_USD                = Number(process.env.AIRTIME_MAX_USD || 1000);
const MAX_PROCESSING_MS      = 25 * 60 * 1000;
const DTONE_WEBHOOK_SECRET   = process.env.DTONE_WEBHOOK_SECRET || null;
const IS_PRODUCTION          = process.env.NODE_ENV === 'production';

// [CRITICAL] Refuse to start in production without a webhook secret.
if (IS_PRODUCTION && !DTONE_WEBHOOK_SECRET) {
    throw new Error(
        '[airtime] DTONE_WEBHOOK_SECRET must be set in production. ' +
        'An unsigned webhook endpoint that can refund wallets is not safe.'
    );
}

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
const swrOperators = new Map();
const SWR_TTL_MS = 30 * 60 * 1000;

// [NEW] Short-lived per-operator product cache. Key: `${iso3}:${operatorId}`.
// A stale entry can only cause a SAFE failure (amount no longer in range),
// never a wrong charge, because /purchase re-validates the amount against
// the cached product before creating the DT One quote.
const productCache = new Map();
const productInflight = new Map();
const PRODUCT_TTL_MS = 5 * 60 * 1000;

let adminReconcileRunning = false;

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

function getPublicCallbackUrl() {
    const appUrl = process.env.APP_URL;
    if (!appUrl) return undefined;
    const base = String(appUrl).replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) return undefined;
    const lower = base.toLowerCase();
    if (
        lower.includes('localhost') ||
        lower.includes('127.0.0.1') ||
        lower.includes('0.0.0.0') ||
        lower.includes('::1') ||
        /\.local(\/|$)/.test(lower)
    ) return undefined;
    return `${base}/api/airtime/webhook`;
}

// ═══════════════════════════════════════════════════════════════════════
// [FIX-A]  NORMALIZERS — defensive against DT One response shape changes
// ═══════════════════════════════════════════════════════════════════════

/**
 * Accept every shape DT One uses for its operator endpoint:
 *   [...]  |  { data: [...] }  |  { operators: [...] }  |  { results: [...] }
 * Throw on anything else so the caller never caches garbage.
 */
function normalizeOperatorList(raw) {
    const list = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.data)
            ? raw.data
            : Array.isArray(raw?.operators)
                ? raw.operators
                : Array.isArray(raw?.results)
                    ? raw.results
                    : null;

    if (!list) {
        throw new Error('Unexpected DT One operators response shape');
    }

    return list
        .filter(op => op && op.id != null && String(op.id).trim() !== '')
        .map(op => ({
            ...op,
            id: String(op.id),
            name: String(op.name || `Operator ${op.id}`).trim()
        }));
}

/**
 * Accept every ISO-3 field DT One might send:
 *   iso3  |  iso_code  |  country_iso_code  |  code
 * Throw on zero valid countries so we never cache a poisoned empty list.
 */
function normalizeCountryList(raw) {
    const list = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.data)
            ? raw.data
            : Array.isArray(raw?.results)
                ? raw.results
                : [];

    const mapped = list
        .map(c => {
            if (!c) return null;
            const alpha3 = String(
                c.iso3 || c.iso_code || c.country_iso_code || c.code || ''
            ).trim().toUpperCase();
            if (!/^[A-Z]{3}$/.test(alpha3)) return null;

            const name = String(c.name || c.country_name || '').trim();
            if (!name) return null;

            return { iso3: alpha3, name };
        })
        .filter(Boolean);

    if (mapped.length === 0) {
        throw new Error('No valid countries returned by DT One');
    }
    return mapped;
}

// ═══════════════════════════════════════════════════════════════════════
// [FIX-A]  CACHED CATALOG — rejects empty, bumps keys, SWR-safe
// ═══════════════════════════════════════════════════════════════════════

async function getCachedCountries() {
    // Cache key bumped from v23 → v24 to invalidate any empty-catalog
    // entries that were written by the old filter that only read `iso3`.
    return await cacheService.getOrSet('dtone_countries_v24', async () => {
        const raw = await dtoneService.getCountries('AIRTIME');
        const normalized = normalizeCountryList(raw);

        const mapped = normalized.map(c => ({
            code: c.iso3,
            iso3: c.iso3,
            iso2: countriesLib.alpha3ToAlpha2(c.iso3) || null,
            name: c.name,
            flag: getFlagFromAlpha3(c.iso3),
            dial: getDialCode(c.iso3)
        }));

        mapped.sort((a, b) => a.name.localeCompare(b.name));

        console.info('[AIRTIME] Country catalog loaded', { count: mapped.length });
        return mapped;
    }, 24 * 60 * 60);
}

async function getCachedOperators(countryIso3) {
    const country = String(countryIso3 || '').trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(country)) {
        throw new Error(`Invalid ISO-3 country code: ${country}`);
    }

    // Cache key bumped from v21 → v22 to invalidate poisoned NGA entry.
    const key = `dtone_operators_v22_${country}`;

    return cacheService.getOrSet(key, async () => {
        const raw = await dtoneService.getOperators(country, 'AIRTIME');
        const operators = normalizeOperatorList(raw);

        if (operators.length === 0) {
            // Throw so cacheService does NOT persist an empty list.
            throw new Error(`DT One returned no airtime operators for ${country}`);
        }

        console.info('[AIRTIME] Operator catalog loaded', {
            country,
            count: operators.length
        });

        return operators;
    }, 60 * 60);
}

async function getCachedOperatorsFast(countryIso3) {
    const country = String(countryIso3 || '').trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(country)) {
        throw new Error(`Invalid ISO-3 country code: ${country}`);
    }

    const cached = swrOperators.get(country);
    if (cached && Date.now() - cached.time < SWR_TTL_MS) return cached.data;
    if (inflightOperators.has(country)) return inflightOperators.get(country);

    const promise = (async () => {
        try {
            const fresh = await getCachedOperators(country);
            swrOperators.set(country, { data: fresh, time: Date.now() });
            return fresh;
        } finally {
            inflightOperators.delete(country);
        }
    })();

    inflightOperators.set(country, promise);

    // Return last-known-good while refreshing in background
    if (cached && Array.isArray(cached.data) && cached.data.length > 0) {
        return cached.data;
    }
    return promise;
}

async function getAirtimeProductsForOperator(iso3, operatorId) {
    const method =
        dtoneService.getProductsRaw ||
        dtoneService.getProducts ||
        dtoneService.getProductsForOperator;
    if (typeof method !== 'function') throw new Error('dtoneService has no product-fetch method.');
    return await method.call(dtoneService, {
        countryIsoCode: iso3,
        operatorId: Number(operatorId),
        serviceId: 1,
        subserviceId: 11
    });
}

// ═══════════════════════════════════════════════════════════════════════
// [NEW]  PRODUCT CACHE — 5-min TTL, dedupes concurrent fetches
// ═══════════════════════════════════════════════════════════════════════
async function getCachedAirtimeProducts(iso3, operatorId) {
    const key = `${String(iso3).toUpperCase()}:${String(operatorId)}`;
    const hit = productCache.get(key);
    if (hit && Date.now() - hit.time < PRODUCT_TTL_MS) return hit.data;
    if (productInflight.has(key)) return productInflight.get(key);

    const promise = (async () => {
        try {
            const products = await getAirtimeProductsForOperator(iso3, operatorId);
            if (Array.isArray(products) && products.length > 0) {
                productCache.set(key, { data: products, time: Date.now() });
            }
            return products;
        } finally {
            productInflight.delete(key);
        }
    })();

    productInflight.set(key, promise);
    return promise;
}

// ═══════════════════════════════════════════════════════════════════════
// [NEW]  PRODUCT SELECTOR — shared by /preflight and /purchase
// Picks a usable RANGED_VALUE_RECHARGE product for srcAmountUSD and
// returns everything needed to compute fee/total or validate range.
// Throws on failure with a stable error code the caller can map.
// ═══════════════════════════════════════════════════════════════════════
function selectAirtimeProduct({ products, srcAmountUSD }) {
    if (!Array.isArray(products) || products.length === 0) {
        const err = new Error('This network currently has no available products');
        err.code = 'NO_PRODUCTS';
        throw err;
    }

    const rangedSourceProducts = products.filter(p => {
        if (p.type !== 'RANGED_VALUE_RECHARGE') return false;
        const modes = Array.isArray(p.accepted_calculation_modes) ? p.accepted_calculation_modes : [];
        return modes.includes('SOURCE_AMOUNT');
    });

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
        const err = new Error('This network does not support variable recharge amounts.');
        err.code = 'RANGED_NOT_SUPPORTED';
        throw err;
    }

    const sourceAmountForProvider = needsConversion
        ? Math.round(srcAmountUSD * rate)
        : srcAmountUSD;

    const pMin = Number(selectedProduct.source?.amount?.min);
    const pMax = Number(selectedProduct.source?.amount?.max);

    if (Number.isFinite(pMin) && sourceAmountForProvider < pMin) {
        const humanMin = needsConversion ? (pMin / rate).toFixed(2) : pMin.toFixed(2);
        const err = new Error(`Minimum amount for this network is $${humanMin}`);
        err.code = 'AMOUNT_BELOW_MIN';
        err.min_amount_usd = Number(humanMin);
        throw err;
    }
    if (Number.isFinite(pMax) && sourceAmountForProvider > pMax) {
        const humanMax = needsConversion ? (pMax / rate).toFixed(2) : pMax.toFixed(2);
        const err = new Error(`Maximum amount for this network is $${humanMax}`);
        err.code = 'AMOUNT_ABOVE_MAX';
        err.max_amount_usd = Number(humanMax);
        throw err;
    }

    return {
        selectedProduct,
        sourceCurrency,
        needsConversion,
        rate,
        sourceAmountForProvider,
        minUsd: Number.isFinite(pMin)
            ? Number((needsConversion ? pMin / rate : pMin).toFixed(2))
            : null,
        maxUsd: Number.isFinite(pMax)
            ? Number((needsConversion ? pMax / rate : pMax).toFixed(2))
            : null
    };
}

// ═══════════════════════════════════════════════════════════════════════
// [NEW]  FEE CALCULATOR — single source of truth for fee/total math
// Mirrors exactly what /purchase will charge.
// ═══════════════════════════════════════════════════════════════════════
function computeFeeAndTotal(srcAmountUSD) {
    const feeUSD   = Number((srcAmountUSD * MILESSPACE_FEE_PERCENT).toFixed(2));
    const totalUSD = Number((srcAmountUSD + feeUSD).toFixed(2));
    const usdToNgn = Number(process.env.MILESSPACE_USD_TO_NGN || 1600);
    const totalNgn = Number((totalUSD * usdToNgn).toFixed(2));
    return { feeUSD, totalUSD, totalNgn, usdToNgn };
}

// ═══════════════════════════════════════════════════════════════════════
// [CRITICAL] PIN — RPC required, no non-atomic fallback
// ═══════════════════════════════════════════════════════════════════════
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
        // Clear the expired lock before comparing
        await supabaseAdmin
            .from('profiles')
            .update({ transaction_pin_attempts: 0, transaction_pin_locked_until: null })
            .eq('id', userId);
    }

    const isValid = await bcrypt.compare(String(pin), profile.transaction_pin_hash);

    if (!isValid) {
        // [CRITICAL] Use the atomic RPC. If it is missing in production,
        // refuse the request rather than silently falling back to a
        // read-modify-write that can be raced.
        let rpcRes = null;
        let rpcError = null;
        try {
            const r = await supabaseAdmin.rpc('increment_pin_attempts', {
                p_user_id: userId,
                p_max: MAX_PIN_ATTEMPTS,
                p_lock_ms: PIN_LOCK_DURATION
            });
            rpcRes = r?.data;
            rpcError = r?.error;
        } catch (e) {
            rpcError = e;
        }

        if (rpcError || !rpcRes || typeof rpcRes.attempts !== 'number') {
            console.error('❌ [AIRTIME] increment_pin_attempts RPC unavailable:', rpcError?.message || rpcError);
            if (IS_PRODUCTION) {
                return {
                    valid: false,
                    error: 'PIN verification is temporarily unavailable.',
                    code: 'PIN_SERVICE_UNAVAILABLE'
                };
            }
            // Dev fallback: proceed with a numeric guess so local dev still works.
            rpcRes = { attempts: Number(profile.transaction_pin_attempts || 0) + 1, locked: false };
        }

        if (rpcRes.locked) {
            return { valid: false, error: 'PIN locked for 1 hour.', code: 'PIN_LOCKED', remaining_minutes: 60, can_reset: true };
        }

        const remaining = Math.max(0, MAX_PIN_ATTEMPTS - rpcRes.attempts);
        if (remaining === 0) {
            return { valid: false, error: 'PIN locked for 1 hour.', code: 'PIN_LOCKED', remaining_minutes: 60, can_reset: true };
        }

        return {
            valid: false,
            error: `Incorrect PIN. ${remaining} attempts left.`,
            code: 'INVALID_PIN',
            attempts_remaining: remaining
        };
    }

    await supabaseAdmin.from('profiles').update({
        transaction_pin_attempts: 0,
        transaction_pin_locked_until: null
    }).eq('id', userId);
    return { valid: true };
}

// ═══ PROVIDER STATUS SYNC ═══
async function syncAirtimeProviderStatus(transaction) {
    if (!transaction?.provider_transaction_id) return transaction;

    const currentStatus = String(transaction.status || '').toLowerCase();
    if (['completed', 'failed', 'refunded', 'manual_review', 'cancelled',
         'reversed', 'provider_unknown'].includes(currentStatus)) return transaction;

    const ageMs = Date.now() - new Date(transaction.created_at).getTime();
    if (ageMs >= MAX_PROCESSING_MS) {
        return { ...transaction, _stuck: true, _stuck_reason: 'Exceeded 25-minute processing cap' };
    }

    try {
        const provider = await dtoneService.queryTransaction(transaction.provider_transaction_id);
        if (!provider || !provider.status) return transaction;

        const providerStatus = String(provider.status).toLowerCase();

        if (providerStatus === 'completed') {
            const { data: updated } = await supabaseAdmin
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
            return updated || { ...transaction, status: 'completed' };
        }

        if (providerStatus === 'not_found' || provider.notFound) {
            await supabaseAdmin
                .from('airtime_transactions')
                .update({
                    provider_status: provider.providerStatus || 'NOT_FOUND',
                    updated_at: new Date().toISOString()
                })
                .eq('id', transaction.id)
                .in('status', ['processing', 'pending']);
            return { ...transaction, provider_status: 'NOT_FOUND' };
        }

        if (['failed', 'cancelled', 'reversed'].includes(providerStatus)) {
            const { data: updated } = await supabaseAdmin
                .from('airtime_transactions')
                .update({
                    provider_status: provider.providerStatus || providerStatus.toUpperCase(),
                    failure_code: provider.errorCode || null,
                    failure_message: provider.errorMessage || null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', transaction.id)
                .in('status', ['processing', 'pending'])
                .select('*')
                .maybeSingle();
            return updated || transaction;
        }

        return { ...transaction, provider_status: provider.providerStatus || transaction.provider_status };
    } catch (error) {
        console.warn(`⚠️ [AIRTIME SYNC] ${transaction.reference}:`, error.message);
        return transaction;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// [CRITICAL] IDEMPOTENT REFUND
// Every refund uses a DETERMINISTIC refund_reference so two calls with
// the same underlying reference cannot double-credit. The ledger itself
// is expected to reject duplicate credit against the same reference —
// see LedgerService.creditWallet which forwards `refund_reference` to
// its RPC, and the unique constraint on ledger_entries.reference.
// ═══════════════════════════════════════════════════════════════════════
async function refundAirtime({ userId, amount, currency, reference, reason, kind }) {
    const refundRef = `REF-${String(kind || 'AT').toUpperCase()}-${reference}`;
    try {
        await LedgerService.creditWallet(
            userId,
            amount,
            currency,
            `Refund (${kind || 'airtime'}): ${reason}`,
            { refund_reference: refundRef }
        );
        return { ok: true, refundReference: refundRef };
    } catch (err) {
        // Ledger rejects duplicate refunds with a unique-violation. Treat
        // that as "already refunded" — the money is safe, no double-credit.
        const msg = String(err?.message || '');
        if (msg.includes('duplicate') || msg.includes('23505') || msg.includes('unique')) {
            console.warn(`ℹ️ [AIRTIME] Refund already recorded for ${refundRef} — skipping`);
            return { ok: true, refundReference: refundRef, alreadyRefunded: true };
        }
        console.error('❌ [AIRTIME] Refund failed:', msg);
        return { ok: false, error: msg, refundReference: refundRef };
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
        fee_percent: MILESSPACE_FEE_PERCENT,
        callbackConfigured: Boolean(getPublicCallbackUrl()),
        webhookSignatureRequired: Boolean(DTONE_WEBHOOK_SECRET),
        timestamp: new Date().toISOString()
    });
});

router.get('/countries', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=7200');
        const countries = await getCachedCountries();
        return res.json({ success: true, total: countries.length, data: countries });
    } catch (error) {
        console.error('❌ Countries error:', error.message);
        return res.status(503).json({
            success: false,
            error: 'Countries temporarily unavailable. Please retry shortly.',
            code: 'PROVIDER_UNAVAILABLE'
        });
    }
});

// ─── [FIX-A] /operators returns 503 on empty, not a misleading 200 ──
router.get('/operators', async (req, res) => {
    try {
        const { country } = req.query;
        if (!country) {
            return res.status(400).json({ success: false, error: 'Country required', code: 'COUNTRY_REQUIRED' });
        }

        const normalizedCountry = normalizeCountryCodes(country);
        if (!normalizedCountry?.iso3) {
            return res.status(400).json({ success: false, error: 'Invalid country', code: 'INVALID_COUNTRY' });
        }

        res.set('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');

        let operators = [];
        try {
            operators = await getCachedOperatorsFast(normalizedCountry.iso3);
        } catch (err) {
            console.error(`❌ [AIRTIME] Operator lookup failed for ${normalizedCountry.iso3}:`, err.message);
            return res.status(503).json({
                success: false,
                error: 'Networks are temporarily unavailable for this country. Please retry shortly.',
                code: 'OPERATORS_UNAVAILABLE',
                country: normalizedCountry.iso3,
                data: []
            });
        }

        if (!Array.isArray(operators) || operators.length === 0) {
            return res.status(503).json({
                success: false,
                error: 'Networks are temporarily unavailable for this country. Please retry shortly.',
                code: 'OPERATORS_UNAVAILABLE',
                country: normalizedCountry.iso3,
                data: []
            });
        }

        const data = operators.map(op => ({
            id: Number(op.id),
            name: op.name || `Operator ${op.id}`,
            logo: op.logo || dtoneService.getOperatorLogo(op.id, 1),
            logoMedium: op.logo_medium || dtoneService.getOperatorLogo(op.id, 2),
            logoLarge: op.logo_large || dtoneService.getOperatorLogo(op.id, 3)
        }));

        return res.json({
            success: true,
            country: { iso3: normalizedCountry.iso3, iso2: normalizedCountry.iso2 },
            total: data.length,
            data
        });
    } catch (error) {
        console.error('❌ Operators error:', error.message);
        return res.status(500).json({ success: false, error: 'Failed to load operators', code: 'SERVER_ERROR' });
    }
});

router.get('/me', authMiddleware, async (req, res) => {
    try {
        const balances = await LedgerService.getAllBalances(req.user.id);
        // [NEW] Include usd_to_ngn and fee_percent so the frontend can
        // display the exact numbers the server will charge. The
        // frontend no longer hardcodes the rate.
        res.json({
            success: true,
            data: {
                wallet_ngn: balances.NGN || 0,
                wallet_usd: balances.USD || 0,
                usd_to_ngn: Number(process.env.MILESSPACE_USD_TO_NGN || 1600),
                fee_percent: MILESSPACE_FEE_PERCENT
            }
        });
    } catch (error) {
        console.error('❌ Balance error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch balances' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// [NEW] PREFLIGHT — read-only availability + quote check.
//
// Validates that a purchase CAN succeed, without touching the ledger or
// creating any database rows. The frontend calls this BEFORE showing
// the wallet step. If it fails, the user sees "network unavailable" on
// the form — no debit, no failed receipt.
//
// Response shape mirrors exactly what /purchase will charge, so the
// review screen numbers are guaranteed to match.
// ═══════════════════════════════════════════════════════════════════════
router.post('/preflight', authMiddleware, async (req, res) => {
    try {
        const { country, phone, operator_id, source_amount_usd, wallet_type } = req.body || {};

        if (!country || !phone || !operator_id || source_amount_usd == null || !wallet_type) {
            return res.status(400).json({
                success: false, error: 'Missing required fields', code: 'MISSING_FIELDS'
            });
        }

        const normalizedCountry = normalizeCountryCodes(country);
        if (!normalizedCountry?.iso3 || !normalizedCountry?.iso2) {
            return res.status(400).json({ success: false, error: 'Invalid country', code: 'INVALID_COUNTRY' });
        }
        const iso3 = normalizedCountry.iso3;
        const iso2 = normalizedCountry.iso2;

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
            return res.status(400).json({ success: false, error: `Invalid phone for ${iso3}`, code: 'INVALID_PHONE' });
        }

        const walletType = String(wallet_type).toUpperCase();
        if (!['USD', 'NGN'].includes(walletType)) {
            return res.status(400).json({ success: false, error: 'Unsupported wallet', code: 'INVALID_WALLET' });
        }

        // Operator must exist in the cached catalog.
        let operators = [];
        try {
            operators = await getCachedOperatorsFast(iso3);
        } catch (err) {
            return res.status(503).json({
                success: false,
                error: 'Networks are temporarily unavailable for this country.',
                code: 'OPERATORS_UNAVAILABLE'
            });
        }
        const selectedOp = operators.find(op => String(op.id) === String(operator_id));
        if (!selectedOp) {
            return res.status(400).json({
                success: false,
                error: 'Selected network is not available for this country',
                code: 'OPERATOR_NOT_FOUND'
            });
        }

        // Product availability — cached.
        let products = [];
        try {
            products = await getCachedAirtimeProducts(iso3, selectedOp.id);
        } catch (err) {
            return res.status(503).json({
                success: false,
                error: 'Could not check availability for this network.',
                code: 'PRODUCT_FETCH_FAILED'
            });
        }

        // Validate amount range against the operator's products.
        let selection;
        try {
            selection = selectAirtimeProduct({ products, srcAmountUSD });
        } catch (selErr) {
            return res.status(400).json({
                success: false,
                error: selErr.message,
                code: selErr.code || 'NO_PRODUCTS',
                min_amount_usd: selErr.min_amount_usd,
                max_amount_usd: selErr.max_amount_usd
            });
        }

        const { feeUSD, totalUSD, totalNgn, usdToNgn } = computeFeeAndTotal(srcAmountUSD);

        return res.json({
            success: true,
            quote: {
                country: iso3,
                phone_masked: maskPhone(parsed.number),
                operator_id: String(selectedOp.id),
                operator_name: selectedOp.name,
                product_id: selection.selectedProduct.id,
                send_amount_usd: srcAmountUSD,
                fee_usd: feeUSD,
                total_usd: totalUSD,
                total_ngn: totalNgn,
                usd_to_ngn: usdToNgn,
                fee_percent: MILESSPACE_FEE_PERCENT,
                source_currency: selection.sourceCurrency,
                source_amount: selection.sourceAmountForProvider,
                needs_conversion: selection.needsConversion,
                min_usd: selection.minUsd,
                max_usd: selection.maxUsd,
                expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
            }
        });
    } catch (error) {
        console.error('❌ [PREFLIGHT]', error.message);
        return res.status(500).json({ success: false, error: error.message || 'Preflight failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// PURCHASE — the ONLY endpoint that touches DT One
// ═══════════════════════════════════════════════════════════════════════
router.post('/purchase', authMiddleware, async (req, res) => {
    let airtimeTxId = null;
    let debitedAmount = 0;
    let debitedCurrency = null;
    let idempotencyClaimed = false;
    let providerConfirmStarted = false;
    const userId = req.user.id;
    const idempotencyKey = req.headers['idempotency-key'];

    try {
        const {
            country, phone, operator_id,
            source_amount_usd, wallet_type, transaction_pin
        } = req.body;

        // ── 1. Basic input validation ──
        if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 128) {
            return res.status(400).json({
                success: false,
                error: 'Idempotency-Key header is required',
                code: 'IDEMPOTENCY_REQUIRED'
            });
        }
        if (!country || !phone || !operator_id || source_amount_usd == null || !wallet_type || !transaction_pin) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                code: 'MISSING_FIELDS'
            });
        }

        const normalizedCountry = normalizeCountryCodes(country);
        if (!normalizedCountry?.iso3 || !normalizedCountry?.iso2) {
            return res.status(400).json({ success: false, error: 'Invalid country', code: 'INVALID_COUNTRY' });
        }

        const iso3 = normalizedCountry.iso3;
        const iso2 = normalizedCountry.iso2;
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
            return res.status(400).json({ success: false, error: `Invalid phone for ${iso3}`, code: 'INVALID_PHONE' });
        }

        const walletType = String(wallet_type).toUpperCase();
        if (!['USD', 'NGN'].includes(walletType)) {
            return res.status(400).json({ success: false, error: 'Unsupported wallet', code: 'INVALID_WALLET' });
        }

        // ── 2. Recompute fee + total on the server ──
        const { feeUSD, totalUSD, totalNgn, usdToNgn } = computeFeeAndTotal(srcAmountUSD);

        const paymentCurrency = walletType;
        const paymentAmount   = walletType === 'USD' ? totalUSD : totalNgn;

        if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid payment amount', code: 'INVALID_AMOUNT' });
        }

        // ── 3. Verify PIN ──
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

        // ── 4. Idempotency fast path ──
        const idempotentCheck = await IdempotencyService.check(userId, idempotencyKey, '/api/airtime/purchase');
        if (idempotentCheck) {
            return res.json({ success: true, already_processed: true, data: idempotentCheck });
        }

        // ── 5. Operator must exist in the cached catalog ──
        let operators = [];
        try {
            operators = await getCachedOperatorsFast(iso3);
        } catch (err) {
            return res.status(503).json({
                success: false,
                error: 'Networks are temporarily unavailable for this country.',
                code: 'OPERATORS_UNAVAILABLE'
            });
        }
        const selectedOp = operators.find(op => String(op.id) === String(operator_id));
        if (!selectedOp) {
            return res.status(400).json({
                success: false,
                error: 'Selected network is not available for this country',
                code: 'OPERATOR_NOT_FOUND'
            });
        }

        // ── 6. Early balance feedback (the ledger debit is the real gate) ──
        const balancesBefore = await LedgerService.getAllBalances(userId);
        const balance = walletType === 'USD' ? (balancesBefore.USD || 0) : (balancesBefore.NGN || 0);
        if (balance < paymentAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient ${paymentCurrency}. Need ${paymentAmount.toFixed(2)}, have ${balance.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                required: paymentAmount,
                balance
            });
        }

        // ── 7. Atomic idempotency claim (no silent fallback) ──
        const claimed = await IdempotencyService.claim(
            userId, idempotencyKey, '/api/airtime/purchase',
            { country: iso3, phone: parsed.number, operator_id, amount: srcAmountUSD, wallet_type: walletType }
        );
        if (!claimed) {
            return res.status(409).json({
                success: false,
                error: 'This request is already being processed. Please wait.',
                code: 'IDEMPOTENCY_IN_FLIGHT'
            });
        }
        idempotencyClaimed = true;

        // ── 8. Insert airtime order in 'processing' state ──
        const reference = generateReference();
        const { data: airtimeTx, error: airtimeError } = await supabaseAdmin
            .from('airtime_transactions')
            .insert({
                user_id: userId,
                reference,
                country_code: iso3,
                phone_number: parsed.number,
                operator_id: String(selectedOp.id),
                operator_name: selectedOp.name,
                destination_amount: 0,
                destination_currency: null,
                provider_cost: null,
                fee: feeUSD,
                total_amount: paymentAmount,
                currency: paymentCurrency,
                wallet_type: walletType,
                status: 'processing',
                provider: 'dtone',
                idempotency_key: idempotencyKey,
                reconciliation_attempts: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();

        if (airtimeError) {
            if (idempotencyClaimed) {
                await IdempotencyService.release(userId, idempotencyKey, '/api/airtime/purchase');
                idempotencyClaimed = false;
            }
            throw airtimeError;
        }
        airtimeTxId = airtimeTx.id;

        // ── 9. Ledger debit (atomic; RPC enforces sufficient funds) ──
        try {
            await LedgerService.debitWallet(
                userId,
                paymentAmount,
                paymentCurrency,
                `Airtime: ${iso3} ${maskPhone(parsed.number)}`,
                { airtime_reference: reference }
            );
            debitedAmount = paymentAmount;
            debitedCurrency = paymentCurrency;
        } catch (debitError) {
            await supabaseAdmin.from('airtime_transactions').update({
                status: 'failed',
                failure_message: debitError.message,
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTx.id).in('status', ['processing', 'pending']);

            return res.status(400).json({ success: false, error: debitError.message, code: 'DEBIT_FAILED' });
        }

        // ═══════════════════════════════════════════════════════════════
        //  ★ DT ONE IS CONTACTED FOR THE FIRST TIME HERE ★
        //  (Since the frontend now calls /preflight, this purchase is
        //   only reached when we've ALREADY confirmed product availability
        //   and amount range. So the failure modes below are only:
        //    - DT One went down in the last 5 minutes
        //    - The amount drifted outside the product range
        //    - DT One's quote/confirm failed
        //   All of which auto-refund and reconcile safely.)
        // ═══════════════════════════════════════════════════════════════

        // ── 10. Fetch products (cached — 5-min TTL) ──
        let products = [];
        try {
            products = await getCachedAirtimeProducts(iso3, selectedOp.id);
        } catch (productsError) {
            console.error('❌ [PURCHASE] Product fetch failed:', productsError.message);
            await refundAirtime({
                userId, amount: paymentAmount, currency: paymentCurrency,
                reference, reason: 'Product fetch failed', kind: 'PROD'
            });
            await supabaseAdmin.from('airtime_transactions').update({
                status: 'failed', refunded: true,
                failure_message: 'Product fetch failed — auto-refunded',
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTx.id).eq('refunded', false);

            return res.status(503).json({
                success: false,
                error: 'Could not load available products for this network',
                code: 'PRODUCT_FETCH_FAILED'
            });
        }

        // ── 11. Select a product and validate the amount range ──
        let selection;
        try {
            selection = selectAirtimeProduct({ products, srcAmountUSD });
        } catch (selErr) {
            // Map selector errors back to the same stable codes the old
            // handler returned, so existing frontend error handling works.
            const code = selErr.code || 'NO_PRODUCTS';
            const isMin = code === 'AMOUNT_BELOW_MIN';
            const isMax = code === 'AMOUNT_ABOVE_MAX';
            const isNoProd = code === 'NO_PRODUCTS';
            const isUnsupported = code === 'RANGED_NOT_SUPPORTED';

            const refundReasonMap = {
                AMOUNT_BELOW_MIN: 'Amount below minimum',
                AMOUNT_ABOVE_MAX: 'Amount above maximum',
                NO_PRODUCTS: 'No products available',
                RANGED_NOT_SUPPORTED: 'Network does not support variable amounts'
            };
            const refundKindMap = {
                AMOUNT_BELOW_MIN: 'MIN',
                AMOUNT_ABOVE_MAX: 'MAX',
                NO_PRODUCTS: 'NOP',
                RANGED_NOT_SUPPORTED: 'UNS'
            };

            if (refundReasonMap[code]) {
                await refundAirtime({
                    userId, amount: paymentAmount, currency: paymentCurrency,
                    reference, reason: refundReasonMap[code], kind: refundKindMap[code]
                });
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'failed', refunded: true,
                    failure_message: `${selErr.message} — auto-refunded`,
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTx.id).eq('refunded', false);
            }

            return res.status(400).json({
                success: false,
                error: selErr.message,
                code,
                min_amount_usd: selErr.min_amount_usd,
                max_amount_usd: selErr.max_amount_usd
            });
        }

        const {
            selectedProduct,
            sourceCurrency,
            sourceAmountForProvider
        } = selection;

        // ── 12. Create the DT One quote ──
        const callbackUrl = getPublicCallbackUrl();
        let quoteResult;
        try {
            quoteResult = await dtoneService.createQuote({
                productId: selectedProduct.id,
                phone: parsed.number,
                mode: 'RANGED_SOURCE',
                sourceAmount: sourceAmountForProvider,
                sourceCurrency,
                callbackUrl
            });
        } catch (error) {
            console.error('❌ [PURCHASE] DT One createQuote error:', error.message);

            const providerData = error.providerData || {};
            const providerCode = String(
                providerData?.errors?.[0]?.code || providerData?.error?.code || ''
            );
            const messageUp = String(error.message || '').toUpperCase();

            // [CRITICAL] Ambiguous timeouts must NOT trigger an immediate
            // refund. Reconciliation owns the resolution when the provider
            // might have accepted the request.
            const isAmbiguous =
                error.code === 'PROVIDER_UNKNOWN' ||
                error.ambiguous === true ||
                (providerCode === '' && /TIMEOUT|NETWORK|FETCH FAILED|SOCKET/i.test(messageUp));

            if (isAmbiguous) {
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'processing',
                    failure_message: 'Ambiguous provider response — reconciliation will resolve',
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTx.id).in('status', ['processing', 'pending']);

                return res.status(202).json({
                    success: true,
                    reference,
                    status: 'processing',
                    refunded: false,
                    message: 'We could not confirm the provider response. Your transaction is being reconciled.',
                    data: { transaction_id: airtimeTx.id, reference, status: 'processing' }
                });
            }

            const isProviderUnfunded =
                providerCode === '1006001' ||
                messageUp.includes('INSUFFICIENT-BALANCE') ||
                messageUp.includes('INSUFFICIENT BALANCE');

            await refundAirtime({
                userId, amount: paymentAmount, currency: paymentCurrency,
                reference, reason: `Provider rejected: ${error.message}`, kind: 'PRJ'
            });
            await supabaseAdmin.from('airtime_transactions').update({
                status: 'failed', refunded: true,
                failure_code: isProviderUnfunded ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR',
                failure_message: error.message,
                failed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTx.id).eq('refunded', false);

            return res.status(400).json({
                success: false,
                error: isProviderUnfunded
                    ? 'This top-up service is temporarily unavailable. Please try another network.'
                    : (error.message || 'Provider could not process this amount'),
                code: isProviderUnfunded ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR'
            });
        }

        if (!quoteResult.success) {
            await refundAirtime({
                userId, amount: paymentAmount, currency: paymentCurrency,
                reference, reason: 'Invalid quote', kind: 'INQ'
            });
            await supabaseAdmin.from('airtime_transactions').update({
                status: 'failed', refunded: true,
                failure_message: 'Provider did not return a valid quote',
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTx.id).eq('refunded', false);

            return res.status(400).json({
                success: false,
                error: 'Provider did not return a valid quote',
                code: 'QUOTE_ERROR'
            });
        }

        const destAmount = quoteResult.destination?.amount;
        const destCurrency = quoteResult.destination?.unit;

        if (!destAmount || destAmount <= 0 || !destCurrency) {
            try { await dtoneService.cancelTransaction(quoteResult.transactionId); } catch (e) {}
            await refundAirtime({
                userId, amount: paymentAmount, currency: paymentCurrency,
                reference, reason: 'Missing destination amount', kind: 'MDD'
            });
            await supabaseAdmin.from('airtime_transactions').update({
                status: 'failed', refunded: true,
                failure_message: 'Provider did not return a recipient amount',
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTx.id).eq('refunded', false);

            return res.status(400).json({
                success: false,
                error: 'Provider did not return a recipient amount',
                code: 'CALCULATION_ERROR'
            });
        }

        const providerWholesale = quoteResult.wholesale?.amount ?? sourceAmountForProvider;
        const providerCurrency  = quoteResult.wholesale?.unit ?? sourceCurrency;

        await supabaseAdmin.from('airtime_transactions').update({
            destination_amount: destAmount,
            destination_currency: destCurrency,
            provider_cost: providerWholesale,
            provider_transaction_id: quoteResult.transactionId,
            dtone_external_id: quoteResult.externalId,
            product_id: selectedProduct.id,
            updated_at: new Date().toISOString()
        }).eq('id', airtimeTx.id);

        // ── 13. Confirm the DT One transaction ──
        let confirmResult;
        let providerAmbiguous = false;
        providerConfirmStarted = true;
        try {
            confirmResult = await dtoneService.confirmTransaction(quoteResult.transactionId);
            console.log('📡 [DTONE CONFIRM]', {
                transactionId: quoteResult.transactionId,
                status: confirmResult?.status
            });
        } catch (error) {
            console.error('❌ DT One confirm error (ambiguous):', error.message);
            providerAmbiguous = true;
            if (error.definitiveRejection) {
                confirmResult = {
                    status: error.normalized?.code || 'REJECTED',
                    errorCode: error.providerErrorCode || error.normalized?.code || null,
                    errorMessage: error.message
                };
            }
        }

        let normalizedProviderStatus = dtoneService.normalizeStatus(confirmResult?.status);

        if (!providerAmbiguous && !normalizedProviderStatus.final) {
            try {
                const freshProvider = await dtoneService.queryTransaction(quoteResult.transactionId);
                if (freshProvider?.status && !freshProvider.notFound) {
                    normalizedProviderStatus = { status: freshProvider.status, final: freshProvider.isFinal };
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

        // ── 14. Final status. No synchronous refund here for ambiguous
        //         states — reconciliation owns that.
        let finalStatus = 'processing';
        if (normalizedProviderStatus.status === 'completed') finalStatus = 'completed';

        await supabaseAdmin.from('airtime_transactions').update({
            status: finalStatus,
            provider_status: confirmResult?.status?.message || confirmResult?.status || null,
            failure_code: confirmResult?.errorCode || null,
            failure_message: confirmResult?.errorMessage || null,
            completed_at: finalStatus === 'completed' ? new Date().toISOString() : null,
            updated_at: new Date().toISOString()
        }).eq('id', airtimeTx.id).in('status', ['processing', 'pending']);

        const responseData = {
            transaction_id: airtimeTx.id,
            reference,
            status: finalStatus,
            refunded: false,
            destination_amount: destAmount,
            destination_currency: destCurrency,
            amount_paid: paymentAmount,
            currency_paid: paymentCurrency,
            country: iso3,
            phone: maskPhone(parsed.number),
            operator: selectedOp.name,
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
            refunded: false,
            message: finalStatus === 'completed' ? 'Airtime sent successfully!'
                : finalStatus === 'processing' ? 'Airtime is being processed...'
                : 'Airtime failed. Funds will be refunded.',
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

        // Crash rollback: only when we have NOT started the provider call.
        if (airtimeTxId && debitedAmount > 0 && !providerConfirmStarted) {
            try {
                await refundAirtime({
                    userId, amount: debitedAmount, currency: debitedCurrency,
                    reference: airtimeTxId, reason: 'Crash before provider call', kind: 'ROLLBACK'
                });
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'failed', refunded: true,
                    failure_message: 'Crashed before provider call — auto-refunded',
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTxId).eq('refunded', false).in('status', ['processing', 'pending']);
            } catch (e) {
                console.error('❌ Crash rollback failed:', e.message);
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'manual_review',
                    failure_message: `Crash rollback failed: ${e.message}`,
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTxId);
            }
        } else if (airtimeTxId && providerConfirmStarted) {
            await supabaseAdmin.from('airtime_transactions').update({
                status: 'processing',
                failure_message: 'Ambiguous provider state — reconciliation will resolve',
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTxId).in('status', ['processing', 'pending']);
        }

        if (idempotencyClaimed && !airtimeTxId) {
            try { await IdempotencyService.release(userId, idempotencyKey, '/api/airtime/purchase'); } catch (_) {}
        }

        res.status(500).json({
            success: false,
            error: error.message || 'Purchase failed',
            code: 'SERVER_ERROR'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════════════════
router.get('/history', authMiddleware, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const offset = (page - 1) * limit;

        const { data, error, count } = await supabaseAdmin
            .from('airtime_transactions')
            .select('*', { count: 'exact' })
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
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

// ═══════════════════════════════════════════════════════════════════════
// GET /:reference
// ═══════════════════════════════════════════════════════════════════════
router.get('/:reference', authMiddleware, async (req, res) => {
    try {
        const { data: transaction, error } = await supabaseAdmin
            .from('airtime_transactions')
            .select('*')
            .eq('reference', req.params.reference)
            .eq('user_id', req.user.id)
            .single();

        if (error || !transaction) return res.status(404).json({ success: false, error: 'Transaction not found' });

        const tx = await syncAirtimeProviderStatus(transaction);
        tx.flag = getFlagFromAlpha3(tx.country_code);
        tx.dial = getDialCode(tx.country_code);
        if (tx.operator_id) tx.operator_logo = dtoneService.getOperatorLogo(tx.operator_id);

        res.json({ success: true, data: tx });
    } catch (error) {
        console.error('❌ Transaction error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch transaction' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// WEBHOOK — signature required in production
// ═══════════════════════════════════════════════════════════════════════
router.post('/webhook', async (req, res) => {
    try {
        const payload = req.body || {};

        // [CRITICAL] Never accept an unsigned webhook in production.
        if (IS_PRODUCTION && !DTONE_WEBHOOK_SECRET) {
            return res.status(503).json({ success: false, error: 'Webhook not configured' });
        }

        if (DTONE_WEBHOOK_SECRET) {
            const signature =
                req.headers['x-dtone-signature'] ||
                req.headers['x-signature'] ||
                req.headers['x-hub-signature'];

            if (!signature) return res.status(401).json({ success: false, error: 'Missing signature' });

            const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(payload);
            const expected = crypto.createHmac('sha256', DTONE_WEBHOOK_SECRET).update(rawBody).digest('hex');
            const provided = String(signature).replace(/^sha256=/, '');
            const providedBuf = Buffer.from(provided, 'hex');
            const expectedBuf = Buffer.from(expected, 'hex');

            if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
                return res.status(401).json({ success: false, error: 'Invalid signature' });
            }
        }

        const transactionId = payload.transaction_id || payload.id;
        const externalId = payload.external_id;
        if (!transactionId && !externalId) return res.status(400).json({ success: false, error: 'Missing identifier' });

        let rows = [];
        if (transactionId) {
            const r = await supabaseAdmin.from('airtime_transactions').select('*').eq('provider_transaction_id', String(transactionId));
            rows = r.data || [];
        }
        if ((!rows || rows.length === 0) && externalId) {
            const r = await supabaseAdmin.from('airtime_transactions').select('*').eq('dtone_external_id', externalId);
            rows = r.data || [];
        }

        if (!rows || rows.length === 0) return res.status(200).json({ success: true, message: 'Not found' });

        if (rows.length > 1) {
            for (const r of rows) {
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'manual_review',
                    updated_at: new Date().toISOString()
                }).eq('id', r.id).in('status', ['processing', 'pending']);
            }
            return res.status(200).json({ success: true, message: 'Ambiguous — flagged for review' });
        }

        const transaction = rows[0];
        try {
            const result = await airtimeReconciliation.forceReconcileAirtime(transaction.id);
            return res.status(200).json({ success: true, reconciled: true, result });
        } catch (reconcileErr) {
            await supabaseAdmin.from('airtime_transactions').update({
                updated_at: new Date().toISOString(),
                metadata: {
                    ...(transaction.metadata || {}),
                    last_webhook: { received_at: new Date().toISOString(), payload, reconciliation_error: reconcileErr.message }
                }
            }).eq('id', transaction.id);
            return res.status(500).json({ success: false, error: 'Reconciliation failed' });
        }
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN — Bulk force reconcile
// ═══════════════════════════════════════════════════════════════════════
router.post('/admin/force-reconcile-all', authMiddleware, async (req, res) => {
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes(String(req.user.email || '').toLowerCase())) {
        return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    if (adminReconcileRunning) {
        return res.status(409).json({ success: false, error: 'A reconciliation run is already in progress', code: 'ALREADY_RUNNING' });
    }
    adminReconcileRunning = true;
    const startedAt = new Date().toISOString();
    try {
        const { data: stuck, error } = await supabaseAdmin
            .from('airtime_transactions')
            .select('id')
            .in('status', ['processing', 'pending'])
            .order('created_at', { ascending: true })
            .limit(100);
        if (error) throw error;

        const results = [];
        for (const row of (stuck || [])) {
            try {
                const r = await airtimeReconciliation.forceReconcileAirtime(row.id);
                results.push({ id: row.id, ...r });
            } catch (e) {
                results.push({ id: row.id, success: false, error: e.message });
            }
        }
        res.json({ success: true, count: results.length, started_at: startedAt, results });
    } catch (error) {
        console.error('❌ Force reconcile all error:', error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        adminReconcileRunning = false;
    }
});

module.exports = router;