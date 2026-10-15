// routes/giftcardRoutes.js
// Gift Card Routes — MilesSpace
//
// FIXES FROM REVIEW:
//   #12 Unknown currency now fails closed (reject, not USD guess).
//   #14 Idempotency key must come from frontend; server-side
//        contract unchanged, but see frontend fix.
//   #19 Immediate synchronous DT One status query removed from
//        purchase. Webhook + polling handle reconciliation.
//   #37 Admin catalog endpoints now require admin permission.
//   #38 Rebuild endpoint rate-limited.
//   #6  MAX_QUANTITY stays at 1 (frontend must match).
//   #13/#14 Frontend sends stable Idempotency-Key (see JS below).
//
// FIX (this pass):
//   - Rebuild limiter now uses `ipKeyGenerator()` so it passes
//     express-rate-limit v7's IPv6 validation and stops throwing
//     ERR_ERL_KEY_GEN_IPV6 at module load.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission, PERMISSIONS } = require('../middleware/adminAuth');
const dtoneService = require('../services/dtoneService');
const { LedgerService, AdminConfigService } = require('../services/ledgerService');
const { computePrice } = require('../services/pricingService');

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const MAX_QUANTITY = 1;

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const CATALOG_TTL_MS = 10 * 60 * 1000;
const COUNTRIES_TTL_MS = 30 * 60 * 1000;

const IDEM_KEY_MIN_LEN = 16;
const IDEM_KEY_MAX_LEN = 100;

const CATALOG_MAX_PAGES = 100;
const CATALOG_PER_PAGE = 100;
const PER_PAGE_TIMEOUT_MS = 12000;
const CATALOG_TIME_BUDGET_MS = 120000;

const VALID_GIFT_CARD_TYPES = new Set([
    'FIXED_VALUE_PIN_PURCHASE',
    'FIXED_VALUE_RECHARGE',
    'FIXED_VALUE'
]);

const CRITICAL_COLUMNS = new Set([
    'status', 'ledger_transaction_id', 'provider_transaction_id',
    'dtone_external_id', 'refunded', 'refund_status', 'delivery_status',
    'email_status', 'voucher_code', 'voucher_serial',
    'completed_at', 'refunded_at', 'failed_at'
]);

// FX fallback only — DT One should always price in a known currency.
// Unknown currency now FAILS CLOSED (see normalizeWholesaleToNgn).
const FX_TO_USD = {
    USD: 1,
    EUR: 1.08, GBP: 1.27, CAD: 0.74, AUD: 0.66,
    JPY: 0.0067, INR: 0.012, ZAR: 0.054, KES: 0.0078, GHS: 0.083,
    BRL: 0.20, MXN: 0.058, AED: 0.27, SAR: 0.27, CHF: 1.12,
    SEK: 0.095, NOK: 0.093, DKK: 0.145, PLN: 0.25, TRY: 0.031,
    CNY: 0.14, HKD: 0.128, SGD: 0.74, NZD: 0.61, KRW: 0.00075,
    THB: 0.028, MYR: 0.22, IDR: 0.000063, PHP: 0.018, VND: 0.000040
};

const ISO3_TO_ISO2 = {
    USA:'US',GBR:'GB',CAN:'CA',AUS:'AU',DEU:'DE',FRA:'FR',ITA:'IT',ESP:'ES',NLD:'NL',BEL:'BE',
    CHE:'CH',AUT:'AT',SWE:'SE',NOR:'NO',DNK:'DK',FIN:'FI',IRL:'IE',PRT:'PT',POL:'PL',CZE:'CZ',
    GRC:'GR',TUR:'TR',RUS:'RU',UKR:'UA',JPN:'JP',KOR:'KR',CHN:'CN',IND:'IN',IDN:'ID',THA:'TH',
    VNM:'VN',PHL:'PH',MYS:'MY',SGP:'SG',HKG:'HK',TWN:'TW',NZL:'NZ',ZAF:'ZA',NGA:'NG',KEN:'KE',
    GHA:'GH',EGY:'EG',MAR:'MA',TUN:'TN',DZA:'DZ',SEN:'SN',CIV:'CI',CMR:'CM',UGA:'UG',TZA:'TZ',
    ZMB:'ZM',ZWE:'ZW',BWA:'BW',NAM:'NA',MOZ:'MZ',AGO:'AO',BRA:'BR',ARG:'AR',CHL:'CL',COL:'CO',
    PER:'PE',MEX:'MX',VEN:'VE',ECU:'EC',URY:'UY',PRY:'PY',BOL:'BO',CRI:'CR',PAN:'PA',GTM:'GT',
    DOM:'DO',JAM:'JM',TTO:'TT',BRB:'BB',BHS:'BS',ISR:'IL',SAU:'SA',ARE:'AE',QAT:'QA',KWT:'KW',
    BHR:'BH',OMN:'OM',JOR:'JO',LBN:'LB',IRQ:'IQ',IRN:'IR',PAK:'PK',BGD:'BD',LKA:'LK',NPL:'NP',
    KAZ:'KZ',UZB:'UZ',AZE:'AZ',GEO:'GE',ARM:'AM',MDA:'MD',ALB:'AL',MKD:'MK',SRB:'RS',BIH:'BA',
    HRV:'HR',SVN:'SI',SVK:'SK',ROU:'RO',BGR:'BG',HUN:'HU',LTU:'LT',LVA:'LV',EST:'EE',ISL:'IS',
    LUX:'LU',MLT:'MT',CYP:'CY',AND:'AD',MCO:'MC',SMR:'SM',LIE:'LI',VAT:'VA',AXX:'UN',EXX:'EU'
};

const SUPPORTED_DEBIT_CURRENCIES = new Set(['USD', 'NGN']);

const ORDER_STATES = Object.freeze({
    PENDING: 'pending',
    PROCESSING: 'processing',
    PROVIDER_UNKNOWN: 'provider_unknown',
    COMPLETED: 'completed',
    FAILED: 'failed',
    REFUNDED: 'refunded',
    CANCELLED: 'cancelled',
    REVERSED: 'reversed',
    MANUAL_REVIEW: 'manual_review'
});

const TERMINAL_STATES = new Set([
    ORDER_STATES.COMPLETED, ORDER_STATES.FAILED,
    ORDER_STATES.REFUNDED, ORDER_STATES.CANCELLED,
    ORDER_STATES.REVERSED
]);

// ═══════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function parseBalance(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function parsePage(v, fallback = 1) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function parseLimit(v, fallback = DEFAULT_PAGE_SIZE) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, MAX_PAGE_SIZE);
}
function stableRequestFingerprint({ productId, currency, quantity, deliveryEmail, countryIso3 }) {
    const payload = JSON.stringify({
        productId: String(productId || ''),
        currency: String(currency || '').toUpperCase(),
        quantity: Number(quantity) || 1,
        deliveryEmail: String(deliveryEmail || '').trim().toLowerCase(),
        countryIso3: String(countryIso3 || '').toUpperCase()
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}
function timingSafeEqualHex(a, b) {
    try {
        const aBuf = Buffer.from(String(a || ''), 'hex');
        const bBuf = Buffer.from(String(b || ''), 'hex');
        if (aBuf.length !== bBuf.length) return false;
        return crypto.timingSafeEqual(aBuf, bBuf);
    } catch { return false; }
}
function summarizeProviderResponse(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: raw.id,
        external_id: raw.external_id,
        status: raw.status?.message || raw.status?.class?.message || raw.status,
        status_id: raw.status?.id || null,
        status_class_id: raw.status?.class?.id || null,
        error_code: raw.error?.code || raw.errors?.[0]?.code || null,
        error_message: raw.error?.message || raw.errors?.[0]?.message || null,
        has_pin: Boolean(raw.pin?.code || raw.pin?.serial)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  FIX #12 — Unknown currency now FAILS CLOSED.
// ═══════════════════════════════════════════════════════════════════════════
function normalizeWholesaleToNgn(amount, currency, usdToNgn) {
    const amt = Number(amount);
    const cur = String(currency || '').toUpperCase();
    if (!Number.isFinite(amt) || amt <= 0) return null;

    if (cur === 'NGN') return amt;
    if (cur === 'USD') return amt * usdToNgn;

    const fx = FX_TO_USD[cur];
    if (fx) return amt * fx * usdToNgn;

    // FAIL CLOSED. Do not guess.
    console.warn(`⚠️ [GIFTCARDS] Unknown wholesale currency "${cur}" — rejecting product`);
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CACHES
// ═══════════════════════════════════════════════════════════════════════════

const productCache = {
    products: [], expiresAt: 0, promise: null, lastError: null,
    lastBuiltAt: 0, lastBuildDurationMs: 0, lastTruncated: false,
    lastTruncationReason: null, lastRawCount: 0, lastRejectedCount: 0,
    lastRejectionsByReason: {}, lastPagesFetched: 0
};

const countryCache = {
    countries: [], expiresAt: 0, promise: null, lastError: null, lastBuiltAt: 0
};

function isProductCacheFresh() {
    return productCache.products.length > 0 && Date.now() < productCache.expiresAt;
}
function isCountryCacheFresh() {
    return countryCache.countries.length > 0 && Date.now() < countryCache.expiresAt;
}
function invalidateGiftCardCatalog() {
    productCache.expiresAt = 0;
    countryCache.expiresAt = 0;
    console.log('🧹 [GIFTCARDS] Catalog cache invalidated');
}

// ═══════════════════════════════════════════════════════════════════════════
//  PRODUCT NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════

function normalizeProduct(p, usdToNgn, markupPct, rejections = null) {
    const reject = (reason) => {
        if (rejections) rejections.set(reason, (rejections.get(reason) || 0) + 1);
        return null;
    };

    if (!p) return reject('null_product');
    const productId = String(p.productId || p.id || '');
    if (!productId) return reject('no_id');

    if (p.productType && !VALID_GIFT_CARD_TYPES.has(p.productType)) {
        return reject(`wrong_type:${p.productType}`);
    }

    let name = String(p.name || '').trim();
    if (!name && Array.isArray(p.benefits) && p.benefits.length) {
        name = String(p.benefits[0]?.name || '').trim();
    }
    if (!name) return reject('no_name');

    let faceValue = Number(p.faceValue ?? 0);
    let faceCurrency = String(p.currency || 'USD').toUpperCase();

    if (Array.isArray(p.benefits) && p.benefits.length) {
        const benefit =
            p.benefits.find((b) =>
                ['VALUE', 'CURRENCY', 'AMOUNT'].includes(String(b.type || '').toUpperCase())
            ) || p.benefits[0];

        const bv = Number(
            benefit?.amount?.base ??
            benefit?.amount?.total_including_tax ??
            benefit?.amount?.total_excluding_tax ??
            benefit?.amount ?? 0
        );
        if (Number.isFinite(bv) && bv > 0) faceValue = bv;
        if (benefit?.unit) faceCurrency = String(benefit.unit).toUpperCase();
    }

    const wholesaleAmount = Number(p.wholesaleAmount ?? p.prices?.wholesale?.amount ?? 0);
    const wholesaleCurrency = String(
        p.wholesaleCurrency || p.prices?.wholesale?.unit || ''
    ).toUpperCase();

    const wholesaleNgn = normalizeWholesaleToNgn(wholesaleAmount, wholesaleCurrency, usdToNgn);
    if (!Number.isFinite(wholesaleNgn) || wholesaleNgn <= 0) {
        return reject(`no_wholesale:${wholesaleCurrency || 'unknown'}`);
    }

    const pricing = computePrice(wholesaleNgn, usdToNgn, markupPct);
    if (!Number.isFinite(pricing.priceNgn) || pricing.priceNgn <= 0) return reject('bad_price_ngn');
    if (!Number.isFinite(pricing.priceUsd) || pricing.priceUsd <= 0) return reject('bad_price_usd');

    const countryIso = String(
        p.countryIso || p.operator?.country?.iso_code || p.country?.iso_code || ''
    ).toUpperCase();

    const countryIso2 = String(
        p.countryIso2 || p.operator?.country?.iso2 || p.country?.iso2 ||
        (countryIso ? ISO3_TO_ISO2[countryIso] : '') || ''
    ).toUpperCase();

    const countryName = String(
        p.countryName || p.operator?.country?.name || p.country?.name || countryIso || 'Global'
    ).trim() || 'Global';

    const wholesaleUsd = wholesaleNgn / (usdToNgn || 1600);

    return {
        productId, name,
        faceValue: Number.isFinite(faceValue) ? faceValue : 0,
        currency: faceCurrency || 'USD',
        countryIso: countryIso || null,
        countryIso2: countryIso2 || null,
        countryName,
        operatorId: p.operatorId || null,
        operatorName: p.operatorName || null,
        logo: p.logo || null,
        description: p.description || null,
        instructions: p.instructions || null,
        priceUsd: pricing.priceUsd,
        priceNgn: pricing.priceNgn,
        wholesaleNgn: +wholesaleNgn.toFixed(4),
        wholesaleUsd: +wholesaleUsd.toFixed(4),
        productType: p.productType || 'FIXED_VALUE_PIN_PURCHASE'
    };
}

function sortProductList(a, b) {
    const cleanA = (a.name || '').replace(/^[^a-zA-Z]+/, '').toLowerCase();
    const cleanB = (b.name || '').replace(/^[^a-zA-Z]+/, '').toLowerCase();
    const cmp = cleanA.localeCompare(cleanB, 'en', { sensitivity: 'base', numeric: true });
    if (cmp !== 0) return cmp;
    const cA = (a.countryName || '').toLowerCase();
    const cB = (b.countryName || '').toLowerCase();
    const cmpC = cA.localeCompare(cB, 'en', { sensitivity: 'base' });
    if (cmpC !== 0) return cmpC;
    return (Number(a.faceValue) || 0) - (Number(b.faceValue) || 0);
}

// ═══════════════════════════════════════════════════════════════════════════
//  CATALOG BUILDER
// ═══════════════════════════════════════════════════════════════════════════

async function buildProductCatalog({ force = false } = {}) {
    if (!force && isProductCacheFresh()) return productCache;
    if (productCache.promise) return productCache.promise;

    productCache.promise = (async () => {
        const startTs = Date.now();
        try {
            const settings = await AdminConfigService.getSettings();
            const usdToNgn = Number(settings?.usd_to_ngn) || 1600;
            const markupPctRaw = Number(settings?.giftcard_markup_pct);
            const markupPct = Number.isFinite(markupPctRaw) && markupPctRaw >= 0
                ? markupPctRaw : 0.1570;

            console.log(
                `📦 [GIFTCARDS] Building complete catalog — ` +
                `up to ${CATALOG_MAX_PAGES} pages × ${CATALOG_PER_PAGE}`
            );

            const result = await dtoneService.getGiftCardProducts(null, {
                productType: 'FIXED_VALUE_PIN_PURCHASE',
                maxPages: CATALOG_MAX_PAGES,
                maxTotalMs: CATALOG_TIME_BUDGET_MS,
                requestTimeoutMs: PER_PAGE_TIMEOUT_MS,
                requireComplete: true
            });

            const rawList = Array.isArray(result?.products) ? result.products : [];
            const truncated = Boolean(result?.truncated);
            const truncationReason = result?.truncationReason || null;

            const products = [];
            const rejections = new Map();
            for (const p of rawList) {
                const normalized = normalizeProduct(p, usdToNgn, markupPct, rejections);
                if (normalized) products.push(normalized);
            }
            products.sort(sortProductList);

            const rejectionsObj = Object.fromEntries(rejections);
            const totalRejected = Object.values(rejectionsObj).reduce((a, b) => a + b, 0);

            console.log('════════ [GIFTCARDS] CATALOG BUILD ════════');
            console.log(`  Raw DT One:      ${rawList.length}`);
            console.log(`  Normalized:      ${products.length}`);
            console.log(`  Rejected:        ${totalRejected}`);
            if (totalRejected > 0) console.log('  Rejection reasons:', rejectionsObj);
            console.log(`  Pages fetched:   ${result?.pagesFetched ?? '?'}`);
            console.log(`  Truncated:       ${truncated}`);
            if (truncated) console.log(`  Truncation:      ${truncationReason}`);
            console.log(`  Elapsed:         ${Date.now() - startTs}ms`);
            console.log(`  Markup:          ${(markupPct * 100).toFixed(2)}%`);
            console.log(`  USD→NGN:         ₦${usdToNgn}`);
            console.log('════════════════════════════════════════════');

            const hadPrevious = productCache.products.length > 0;
            const gotProducts = products.length > 0;

            if (gotProducts && !truncated) {
                productCache.products = products;
                productCache.expiresAt = Date.now() + CATALOG_TTL_MS;
                productCache.lastBuiltAt = Date.now();
                productCache.lastBuildDurationMs = Date.now() - startTs;
                productCache.lastError = null;
                productCache.lastTruncated = false;
                productCache.lastTruncationReason = null;
                productCache.lastRawCount = rawList.length;
                productCache.lastRejectedCount = totalRejected;
                productCache.lastRejectionsByReason = rejectionsObj;
                productCache.lastPagesFetched = result?.pagesFetched ?? 0;
                if (!countryCache.countries.length) deriveCountriesFromProducts(products);
                console.log(`✅ [GIFTCARDS] Complete catalog cached: ${products.length} products`);
            } else if (gotProducts && truncated && !hadPrevious) {
                productCache.products = products;
                productCache.expiresAt = Date.now() + CATALOG_TTL_MS;
                productCache.lastBuiltAt = Date.now();
                productCache.lastBuildDurationMs = Date.now() - startTs;
                productCache.lastError = null;
                productCache.lastTruncated = true;
                productCache.lastTruncationReason = truncationReason;
                productCache.lastRawCount = rawList.length;
                productCache.lastRejectedCount = totalRejected;
                productCache.lastRejectionsByReason = rejectionsObj;
                productCache.lastPagesFetched = result?.pagesFetched ?? 0;
                if (!countryCache.countries.length) deriveCountriesFromProducts(products);
                console.warn(
                    `⚠️ [GIFTCARDS] First build TRUNCATED — cached ${products.length}. ` +
                    `Reason: ${truncationReason}`
                );
            } else if (gotProducts && truncated && hadPrevious) {
                productCache.expiresAt = Date.now() + CATALOG_TTL_MS;
                productCache.lastError = `Truncated refresh — kept previous (${productCache.products.length})`;
                console.warn(
                    `⚠️ [GIFTCARDS] Truncated refresh (${truncationReason}) — ` +
                    `keeping previous ${productCache.products.length}`
                );
            } else if (!gotProducts && hadPrevious) {
                productCache.expiresAt = Date.now() + CATALOG_TTL_MS;
                productCache.lastError = 'Latest build returned 0 — kept previous catalog';
                console.warn('⚠️ [GIFTCARDS] Latest build returned 0 — kept previous');
            } else {
                productCache.products = [];
                productCache.expiresAt = Date.now() + CATALOG_TTL_MS;
                productCache.lastBuiltAt = Date.now();
                productCache.lastError = 'Build returned 0 products';
                productCache.lastRejectionsByReason = rejectionsObj;
                console.warn('⚠️ [GIFTCARDS] First build returned 0 products');
            }
            return productCache;
        } catch (e) {
            productCache.lastError = e.message;
            console.error('❌ [GIFTCARDS] Catalog build failed:', e.message);
            if (productCache.products.length) {
                console.warn('⚠️ [GIFTCARDS] Keeping previous catalog after failure');
                return productCache;
            }
            throw e;
        } finally {
            productCache.promise = null;
        }
    })();

    return productCache.promise;
}

function deriveCountriesFromProducts(products) {
    const seen = new Map();
    for (const p of products) {
        const iso3 = String(p.countryIso || '').toUpperCase();
        if (!iso3 || iso3.length !== 3) continue;
        if (!seen.has(iso3)) {
            seen.set(iso3, { iso3, iso2: p.countryIso2 || null, name: p.countryName || iso3 });
        }
    }
    countryCache.countries = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
    countryCache.expiresAt = Date.now() + COUNTRIES_TTL_MS;
    countryCache.lastBuiltAt = Date.now();
    countryCache.lastError = null;
}

async function buildCountryCatalog({ force = false } = {}) {
    if (!force && isCountryCacheFresh()) return countryCache;
    if (countryCache.promise) return countryCache.promise;

    countryCache.promise = (async () => {
        try {
            if (productCache.products.length) {
                deriveCountriesFromProducts(productCache.products);
                return countryCache;
            }
            const raw = await dtoneService.getCountries('GIFT_CARD');
            const list = Array.isArray(raw) ? raw : [];
            const countries = [];
            const seen = new Set();
            for (const c of list) {
                const iso3 = String(c.iso3 || c.iso_code || '').toUpperCase();
                if (!iso3 || iso3.length !== 3 || seen.has(iso3)) continue;
                seen.add(iso3);
                countries.push({
                    iso3,
                    iso2: String(c.iso2 || ISO3_TO_ISO2[iso3] || '').toUpperCase() || null,
                    name: String(c.name || iso3).trim()
                });
            }
            countries.sort((a, b) => a.name.localeCompare(b.name));
            countryCache.countries = countries;
            countryCache.expiresAt = Date.now() + COUNTRIES_TTL_MS;
            countryCache.lastError = null;
            countryCache.lastBuiltAt = Date.now();
            return countryCache;
        } catch (e) {
            countryCache.lastError = e.message;
            if (productCache.products.length) {
                deriveCountriesFromProducts(productCache.products);
                return countryCache;
            }
            if (countryCache.countries.length) return countryCache;
            throw e;
        } finally {
            countryCache.promise = null;
        }
    })();

    return countryCache.promise;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PIN STATE — atomic RPCs
// ═══════════════════════════════════════════════════════════════════════════

async function getUserPinState(userId) {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('transaction_pin_hash, transaction_pin_locked_until, transaction_pin_attempts')
        .eq('id', userId)
        .maybeSingle();
    if (error) throw new Error('Could not load user PIN state');
    return data || {};
}

async function atomicRecordPinFailure(userId) {
    const { data, error } = await supabaseAdmin.rpc('record_pin_failure', { p_user_id: userId });
    if (error) {
        const e = new Error('Unable to verify transaction security right now.');
        e.code = 'PIN_SECURITY_ERROR';
        throw e;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.locked !== 'boolean' || !Number.isInteger(row.attempts_remaining)) {
        const e = new Error('Invalid PIN RPC response.');
        e.code = 'PIN_SECURITY_STATE_ERROR';
        throw e;
    }
    return row;
}

async function atomicResetPinAttempts(userId) {
    const { error } = await supabaseAdmin.rpc('reset_pin_attempts', { p_user_id: userId });
    if (error) console.error('[PIN RPC] reset_pin_attempts error:', error);
}

// ═══════════════════════════════════════════════════════════════════════════
//  DB WRITE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function updateOrderCritical(orderId, patch) {
    const { data, error } = await supabaseAdmin
        .from('giftcard_transactions')
        .update(patch)
        .eq('id', orderId)
        .select('id')
        .maybeSingle();

    if (error || !data) {
        const e = new Error(
            `Failed to persist order state for ${orderId}: ${error?.message || 'no rows updated'}`
        );
        e.code = 'ORDER_STATE_PERSIST_FAILED';
        e.missingColumn = extractMissingColumn(error?.message);
        throw e;
    }
    return data;
}

const _missingColumnWarned = new Set();

async function updateOrderDiagnostic(orderId, patch) {
    let { error } = await supabaseAdmin
        .from('giftcard_transactions')
        .update(patch)
        .eq('id', orderId);
    if (!error) return true;

    const col = extractMissingColumn(error.message);
    if (col && Object.prototype.hasOwnProperty.call(patch, col)) {
        if (CRITICAL_COLUMNS.has(col)) {
            console.error(`❌ [GIFTCARDS] Attempted metadata fallback for critical column '${col}'`);
            return false;
        }
        if (!_missingColumnWarned.has(col)) {
            console.warn(`⚠️ [GIFTCARDS] Diagnostic column '${col}' missing — writing to metadata`);
            _missingColumnWarned.add(col);
        }
        const { [col]: missingValue, ...rest } = patch;
        if (missingValue !== undefined) {
            try {
                const { data: current } = await supabaseAdmin
                    .from('giftcard_transactions')
                    .select('metadata')
                    .eq('id', orderId)
                    .maybeSingle();
                rest.metadata = { ...(current?.metadata || {}), [col]: missingValue };
            } catch {}
        }
        const retry = await supabaseAdmin
            .from('giftcard_transactions').update(rest).eq('id', orderId);
        if (retry.error) return false;
        return true;
    }
    return false;
}

function extractMissingColumn(msg) {
    if (!msg) return null;
    const m = msg.match(/Could not find the '([^']+)' column/);
    return m ? m[1] : null;
}

async function safeMarkFailed(orderId, reason) {
    try {
        await updateOrderCritical(orderId, {
            status: ORDER_STATES.FAILED,
            failure_reason: reason,
            failed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    } catch (e) {
        console.error(`[GIFTCARDS] Could not mark order ${orderId} failed:`, e.message);
    }
}

function getPublicCallbackUrl(pathname) {
    const base = String(process.env.APP_URL || '').replace(/\/+$/, '');
    if (!base || !base.startsWith('https://')) return null;
    return `${base}${pathname}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RATE LIMITERS
//
//  express-rate-limit v7+ requires custom keyGenerators that touch the
//  request IP to route it through ipKeyGenerator() for IPv6 safety.
//  Using req.ip directly raises ERR_ERL_KEY_GEN_IPV6 at module load.
// ═══════════════════════════════════════════════════════════════════════════

const adminCatalogRebuildLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Prefer the authenticated user id when available — this is
        // IPv6-safe because it does not depend on the IP at all.
        if (req.user?.id) return `rebuild:user:${req.user.id}`;
        // Fall back to an IPv6-safe IP key.
        return `rebuild:ip:${ipKeyGenerator(req)}`;
    },
    handler: (req, res) => res.status(429).json({
        success: false,
        code: 'REBUILD_RATE_LIMIT',
        error: 'Catalog rebuild is rate limited. Try again shortly.'
    })
});

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET /api/wallet/balances ────────────────────────────────────────────
router.get('/wallet/balances', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        if (typeof LedgerService.getAllBalances !== 'function') {
            return res.status(500).json({
                success: false,
                error: 'Ledger balance lookup not available',
                code: 'LEDGER_UNAVAILABLE'
            });
        }
        const balances = await LedgerService.getAllBalances(userId);
        const usd = parseBalance(balances?.USD);
        const ngn = parseBalance(balances?.NGN);
        if (usd === null || ngn === null) {
            return res.status(502).json({
                success: false,
                error: 'Wallet balances unavailable',
                code: 'WALLET_PARSE_FAILED'
            });
        }
        res.json({ success: true, data: { USD: usd, NGN: ngn } });
    } catch (e) {
        console.error('[WALLET] Balance fetch failed:', e.message);
        res.status(500).json({
            success: false,
            error: 'Could not load wallet balances',
            code: 'WALLET_ERROR'
        });
    }
});

// ─── GET /api/giftcards/countries ────────────────────────────────────────
router.get('/giftcards/countries', authMiddleware, async (req, res) => {
    const startTs = Date.now();
    if (isCountryCacheFresh()) {
        res.set('X-Cache', 'HIT');
        return res.json({ success: true, data: countryCache.countries });
    }
    if (countryCache.countries.length > 0) {
        buildCountryCatalog({ force: true }).catch(() => {});
        res.set('X-Cache', 'STALE');
        return res.json({ success: true, data: countryCache.countries });
    }
    try {
        const result = await buildCountryCatalog();
        res.set('X-Cache', 'MISS');
        res.set('X-Cache-Fill-Ms', String(Date.now() - startTs));
        res.json({ success: true, data: result.countries });
    } catch (e) {
        console.error('Countries error:', e.message);
        res.status(502).json({
            success: false,
            error: 'Could not load country list',
            code: 'COUNTRIES_FAILED'
        });
    }
});

// ─── GET /api/giftcards/products ─────────────────────────────────────────
router.get('/giftcards/products', authMiddleware, async (req, res) => {
    const startTs = Date.now();
    try {
        const page = parsePage(req.query.page, 1);
        const limit = parseLimit(req.query.limit, DEFAULT_PAGE_SIZE);
        const search = String(req.query.search || '').trim().toLowerCase();
        const country = String(req.query.country || '').toUpperCase() || null;

        let cacheState = 'HIT';
        let catalog;

        if (isProductCacheFresh()) {
            catalog = productCache;
        } else if (productCache.products.length > 0) {
            cacheState = 'STALE';
            catalog = productCache;
            buildProductCatalog({ force: true }).catch((e) =>
                console.warn('⚠️ [GIFTCARDS] BG product refresh failed:', e.message)
            );
        } else {
            cacheState = 'MISS';
            catalog = await buildProductCatalog();
        }

        const safeList = (catalog.products || []).filter((p) => {
            if (!p || !p.productId) return false;
            if (!String(p.name || '').trim()) return false;
            const usd = Number(p.priceUsd);
            const ngn = Number(p.priceNgn);
            if (!Number.isFinite(usd) && !Number.isFinite(ngn)) return false;
            return true;
        });

        let list = safeList;
        if (country) list = list.filter((p) => p.countryIso === country);
        if (search) {
            list = list.filter((p) =>
                (p.name || '').toLowerCase().includes(search) ||
                (p.countryName || '').toLowerCase().includes(search) ||
                (p.operatorName || '').toLowerCase().includes(search)
            );
        }

        const total = list.length;
        const start = (page - 1) * limit;
        const end = start + limit;
        const slice = list.slice(start, end);

        const items = slice.map((p) => ({
            productId: p.productId,
            name: p.name,
            faceValue: p.faceValue,
            currency: p.currency,
            countryIso: p.countryIso,
            countryIso2: p.countryIso2,
            countryName: p.countryName,
            operatorId: p.operatorId,
            operatorName: p.operatorName,
            logo: p.logo,
            description: p.description,
            priceUsd: p.priceUsd,
            priceNgn: p.priceNgn
        }));

        const hasMore = end < total;

        res.set('X-Cache', cacheState);
        res.set('X-Cache-Age-Ms', String(Date.now() - productCache.lastBuiltAt));
        res.set('X-Response-Ms', String(Date.now() - startTs));
        res.set('X-Catalog-Size', String(productCache.products.length));
        res.set('X-Catalog-Complete', String(!productCache.lastTruncated));

        res.json({
            success: true,
            data: items,
            meta: {
                page, limit, total, hasMore,
                returned: items.length,
                catalogComplete: !productCache.lastTruncated,
                catalogSize: productCache.products.length,
                lastBuildDurationMs: productCache.lastBuildDurationMs,
                rawDtOneCount: productCache.lastRawCount,
                rejectedCount: productCache.lastRejectedCount,
                rejectionsByReason: productCache.lastRejectionsByReason,
                pagesFetched: productCache.lastPagesFetched
            }
        });
    } catch (e) {
        console.error('Products error:', e.message);
        res.status(502).json({
            success: false,
            error: 'Gift cards are temporarily unavailable',
            code: 'PRODUCTS_FAILED'
        });
    }
});

// ─── GET /api/giftcards/admin/catalog-stats ─────────────────────────────
// FIX #37 — now requires admin permission.
router.get(
    '/giftcards/admin/catalog-stats',
    authMiddleware,
    requirePermission(PERMISSIONS.CATALOG_VIEW || 'catalog.view'),
    async (req, res) => {
        res.json({
            success: true,
            data: {
                cachedProducts: productCache.products.length,
                lastBuiltAt: productCache.lastBuiltAt
                    ? new Date(productCache.lastBuiltAt).toISOString() : null,
                cacheAgeMs: productCache.lastBuiltAt
                    ? Date.now() - productCache.lastBuiltAt : null,
                ttlMs: CATALOG_TTL_MS,
                isFresh: isProductCacheFresh(),
                isBuilding: Boolean(productCache.promise),
                lastError: productCache.lastError,
                lastTruncated: productCache.lastTruncated,
                lastTruncationReason: productCache.lastTruncationReason,
                lastBuildDurationMs: productCache.lastBuildDurationMs,
                rawDtOneCount: productCache.lastRawCount,
                rejectedCount: productCache.lastRejectedCount,
                rejectionsByReason: productCache.lastRejectionsByReason,
                pagesFetched: productCache.lastPagesFetched,
                countryCount: countryCache.countries.length
            }
        });
    }
);

// ─── POST /api/giftcards/admin/rebuild-catalog ───────────────────────────
// FIX #37 & #38 — admin permission + rate limit + single-flight lock.
router.post(
    '/giftcards/admin/rebuild-catalog',
    authMiddleware,
    requirePermission(PERMISSIONS.CATALOG_MANAGE || 'catalog.manage'),
    adminCatalogRebuildLimiter,
    async (req, res) => {
        try {
            if (productCache.promise) {
                return res.status(409).json({
                    success: false,
                    code: 'REBUILD_IN_PROGRESS',
                    error: 'A catalog rebuild is already in progress.'
                });
            }
            invalidateGiftCardCatalog();
            const catalog = await buildProductCatalog({ force: true });
            res.json({
                success: true,
                data: {
                    products: catalog.products.length,
                    rawDtOneCount: catalog.lastRawCount,
                    rejectedCount: catalog.lastRejectedCount,
                    rejectionsByReason: catalog.lastRejectionsByReason,
                    truncated: catalog.lastTruncated,
                    durationMs: catalog.lastBuildDurationMs
                }
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    }
);

// ─── POST /api/giftcards/purchase ────────────────────────────────────────
// FIX #19 — Removed the synchronous immediate `queryTransaction` call.
//           Webhook + polling handle reconciliation. Purchase returns
//           as soon as the provider has accepted the submission.
router.post('/giftcards/purchase', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const idemKey = String(req.headers['idempotency-key'] || '').trim();

    if (!idemKey) {
        return res.status(400).json({
            success: false,
            error: 'Idempotency-Key header is required',
            code: 'IDEMPOTENCY_KEY_REQUIRED'
        });
    }
    if (idemKey.length < IDEM_KEY_MIN_LEN || idemKey.length > IDEM_KEY_MAX_LEN) {
        return res.status(400).json({
            success: false,
            error: `Idempotency-Key must be ${IDEM_KEY_MIN_LEN}-${IDEM_KEY_MAX_LEN} characters`,
            code: 'IDEMPOTENCY_KEY_INVALID'
        });
    }

    const { productId, countryIso3, currency = 'USD', deliveryEmail, quantity = 1, pin } = req.body || {};

    if (!/^\d+$/.test(String(productId || ''))) {
        return res.status(400).json({ success: false, error: 'Invalid productId', code: 'INVALID_PRODUCT' });
    }

    const currencyUpper = String(currency).toUpperCase();
    if (!SUPPORTED_DEBIT_CURRENCIES.has(currencyUpper)) {
        return res.status(400).json({
            success: false,
            error: 'Unsupported currency. Must be USD or NGN.',
            code: 'INVALID_CURRENCY'
        });
    }

    const emailStr = String(deliveryEmail || '').trim();
    if (emailStr.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
        return res.status(400).json({
            success: false,
            error: 'A valid delivery email is required',
            code: 'INVALID_EMAIL'
        });
    }

    if (!/^\d{4}$/.test(String(pin || ''))) {
        return res.status(400).json({
            success: false,
            error: 'PIN must be 4 digits',
            code: 'INVALID_PIN_FORMAT'
        });
    }

    const qtyNum = parseInt(quantity, 10);
    if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > MAX_QUANTITY) {
        return res.status(400).json({
            success: false,
            error: `Quantity must be between 1 and ${MAX_QUANTITY}`,
            code: 'INVALID_QUANTITY'
        });
    }

    const debitCurrency = currencyUpper;
    const qty = qtyNum;

    const requestFingerprint = stableRequestFingerprint({
        productId, currency: debitCurrency, quantity: qty, deliveryEmail: emailStr, countryIso3
    });

    try {
        const { data: existing, error: existingErr } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('id, reference, status, request_fingerprint')
            .eq('user_id', userId)
            .eq('idempotency_key', idemKey)
            .maybeSingle();

        if (existingErr) {
            return res.status(500).json({
                success: false,
                error: 'Could not verify idempotency state',
                code: 'IDEMPOTENCY_LOOKUP_FAILED'
            });
        }

        if (existing) {
            if (existing.request_fingerprint && existing.request_fingerprint !== requestFingerprint) {
                return res.status(409).json({
                    success: false,
                    error: 'Idempotency-Key was reused with a different request payload',
                    code: 'IDEMPOTENCY_KEY_REUSE'
                });
            }
            return res.json({
                success: true,
                data: {
                    transactionId: existing.id,
                    reference: existing.reference,
                    status: existing.status,
                    replayed: true
                }
            });
        }

        const pinState = await getUserPinState(userId);

        if (pinState.transaction_pin_locked_until) {
            const until = new Date(pinState.transaction_pin_locked_until);
            if (until.getTime() > Date.now()) {
                const remaining = Math.ceil((until.getTime() - Date.now()) / 60000);
                return res.status(423).json({
                    success: false,
                    error: `PIN is locked. Try again in ${remaining} minutes.`,
                    code: 'PIN_LOCKED',
                    remaining_minutes: remaining
                });
            }
        }

        if (!pinState.transaction_pin_hash) {
            return res.status(400).json({
                success: false,
                error: 'You have not set a transaction PIN yet.',
                code: 'PIN_NOT_SET'
            });
        }

        const pinOk = await bcrypt.compare(String(pin), pinState.transaction_pin_hash);

        if (!pinOk) {
            let failure;
            try { failure = await atomicRecordPinFailure(userId); }
            catch (rpcErr) {
                return res.status(500).json({
                    success: false,
                    error: rpcErr.message || 'Unable to verify transaction security right now.',
                    code: rpcErr.code || 'PIN_SECURITY_ERROR'
                });
            }
            if (failure.locked) {
                return res.status(423).json({
                    success: false,
                    error: 'Too many incorrect attempts. PIN locked for 1 hour.',
                    code: 'PIN_LOCKED',
                    remaining_minutes: 60
                });
            }
            return res.status(401).json({
                success: false,
                error: 'Incorrect transaction PIN.',
                code: 'INVALID_PIN',
                attempts_remaining: failure.attempts_remaining
            });
        }

        await atomicResetPinAttempts(userId);

        const catalog = await buildProductCatalog();
        const product = catalog.products.find((p) => String(p.productId) === String(productId));

        if (!product) {
            return res.status(404).json({
                success: false,
                error: 'This gift card is no longer available.',
                code: 'PRODUCT_NOT_FOUND'
            });
        }

        if (!Number.isFinite(product.priceUsd) || product.priceUsd <= 0) {
            return res.status(500).json({
                success: false,
                error: 'This gift card is temporarily unavailable.',
                code: 'PRODUCT_PRICE_INVALID'
            });
        }

        const totalUsd = +(product.priceUsd * qty).toFixed(2);
        const totalNgn = +(product.priceNgn * qty).toFixed(2);

        if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
            return res.status(500).json({
                success: false,
                error: 'Pricing calculation failed',
                code: 'PRICING_ERROR'
            });
        }

        const debitAmount = debitCurrency === 'NGN' ? totalNgn : totalUsd;
        const reference = `GFT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

        const insertPayload = {
            user_id: userId,
            reference,
            idempotency_key: idemKey,
            request_fingerprint: requestFingerprint,
            country_iso3: product.countryIso || null,
            country_iso2: product.countryIso2 || null,
            country_name: product.countryName || null,
            product_id: product.productId,
            card_name: product.name,
            face_value: product.faceValue,
            face_currency: product.currency,
            quantity: qty,
            wholesale_usd: product.wholesaleUsd,
            price_usd: product.priceUsd,
            fee_usd: 0,
            total_usd: totalUsd,
            price_ngn: totalNgn,
            debit_currency: debitCurrency,
            debit_amount: debitAmount,
            delivery_email: emailStr,
            status: ORDER_STATES.PENDING,
            refund_status: 'not_applicable',
            refunded: false,
            delivery_status: 'pending',
            email_status: 'pending',
            reconciliation_attempts: 0,
            metadata: { product_snapshot: product }
        };

        const { data: order, error: insertErr } = await supabaseAdmin
            .from('giftcard_transactions')
            .insert(insertPayload)
            .select()
            .single();

        if (insertErr) {
            if (insertErr.code === '23505') {
                const { data: dup } = await supabaseAdmin
                    .from('giftcard_transactions')
                    .select('id, reference, status, request_fingerprint')
                    .eq('user_id', userId)
                    .eq('idempotency_key', idemKey)
                    .maybeSingle();
                if (dup) {
                    if (dup.request_fingerprint && dup.request_fingerprint !== requestFingerprint) {
                        return res.status(409).json({
                            success: false,
                            error: 'Idempotency-Key was reused with a different request payload',
                            code: 'IDEMPOTENCY_KEY_REUSE'
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            transactionId: dup.id,
                            reference: dup.reference,
                            status: dup.status,
                            replayed: true
                        }
                    });
                }
            }
            return res.status(500).json({
                success: false,
                error: 'Could not create order',
                code: 'ORDER_CREATE_FAILED'
            });
        }

        let ledgerResult;
        try {
            ledgerResult = await LedgerService.debitWallet(
                userId,
                debitAmount,
                debitCurrency,
                `Gift card purchase ${reference}`,
                {
                    type: 'giftcard_purchase',
                    order_id: order.id,
                    reference,
                    product_id: product.productId,
                    card_name: product.name
                }
            );
        } catch (debitErr) {
            await safeMarkFailed(order.id, `Wallet debit failed: ${debitErr.message}`);
            if (debitErr.code === 'INSUFFICIENT_BALANCE') {
                return res.status(400).json({
                    success: false,
                    error: 'Insufficient wallet balance.',
                    code: 'INSUFFICIENT_BALANCE'
                });
            }
            return res.status(500).json({
                success: false,
                error: 'Could not debit wallet',
                code: 'DEBIT_FAILED'
            });
        }

        if (!ledgerResult || ledgerResult.success !== true || !ledgerResult.transaction_id) {
            await safeMarkFailed(
                order.id,
                `Wallet debit not confirmed: ${ledgerResult?.error || ledgerResult?.code || 'unknown'}`
            );
            return res.status(500).json({
                success: false,
                error: 'Could not debit wallet',
                code: 'DEBIT_FAILED'
            });
        }

        await updateOrderCritical(order.id, {
            ledger_transaction_id: ledgerResult.transaction_id,
            status: ORDER_STATES.PROCESSING,
            updated_at: new Date().toISOString()
        });

        const callbackUrl = getPublicCallbackUrl('/api/webhooks/dtone/giftcard');

        let providerResult;
        try {
            providerResult = await dtoneService.purchaseGiftCard({
                productId: product.productId,
                countryIso3: product.countryIso,
                quantity: 1,
                externalId: reference,
                callbackUrl: callbackUrl || undefined,
                autoConfirm: true
            });
        } catch (providerErr) {
            const isDefinitive =
                providerErr.definitiveRejection === true ||
                providerErr.providerStatus === 'REJECTED';

            if (!isDefinitive && providerErr.code === 'PROVIDER_UNKNOWN') {
                await updateOrderCritical(order.id, {
                    status: ORDER_STATES.PROVIDER_UNKNOWN,
                    failure_reason: `Provider outcome unknown: ${providerErr.message}`,
                    updated_at: new Date().toISOString()
                });
                return res.status(202).json({
                    success: true,
                    data: {
                        transactionId: order.id,
                        reference,
                        status: ORDER_STATES.PROVIDER_UNKNOWN,
                        debitAmount,
                        debitCurrency,
                        totalUsd,
                        totalNgn
                    }
                });
            }

            try {
                const refundResult = await LedgerService.refundTransaction(
                    userId,
                    ledgerResult.transaction_id,
                    `Gift card rejected: ${providerErr.message}`
                );
                if (!refundResult || refundResult.success !== true) {
                    throw new Error(refundResult?.error || 'Refund did not succeed');
                }
                await updateOrderCritical(order.id, {
                    status: ORDER_STATES.REFUNDED,
                    refunded: true,
                    refund_status: 'completed',
                    refunded_at: new Date().toISOString(),
                    failure_reason: `Provider rejected: ${providerErr.message}`,
                    failed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });
                return res.status(502).json({
                    success: false,
                    error: 'This gift card could not be processed. Your wallet has been refunded.',
                    code: 'PROVIDER_REJECTED'
                });
            } catch (refundErr) {
                await updateOrderCritical(order.id, {
                    status: ORDER_STATES.MANUAL_REVIEW,
                    failure_reason: `Provider rejected and refund failed: ${refundErr.message}`,
                    refund_status: 'failed',
                    updated_at: new Date().toISOString()
                });
                return res.status(500).json({
                    success: false,
                    error: 'Purchase encountered a problem. Our team will resolve it.',
                    code: 'MANUAL_REVIEW'
                });
            }
        }

        const providerTxId = providerResult?.transactionId || null;
        const providerExternalId = providerResult?.externalId || reference;

        if (!providerTxId) {
            await updateOrderCritical(order.id, {
                status: ORDER_STATES.PROVIDER_UNKNOWN,
                dtone_external_id: providerExternalId,
                failure_reason: 'Provider returned no transaction ID',
                updated_at: new Date().toISOString()
            });
            return res.status(202).json({
                success: true,
                data: {
                    transactionId: order.id,
                    reference,
                    status: ORDER_STATES.PROVIDER_UNKNOWN,
                    debitAmount,
                    debitCurrency,
                    totalUsd,
                    totalNgn
                }
            });
        }

        await updateOrderCritical(order.id, {
            provider_transaction_id: String(providerTxId),
            dtone_external_id: providerExternalId,
            provider_status: providerResult.status || 'SUBMITTED',
            updated_at: new Date().toISOString()
        });

        await updateOrderDiagnostic(order.id, {
            provider_response_summary: summarizeProviderResponse(providerResult.raw)
        }).catch(() => {});

        // ─── FIX #19 ────────────────────────────────────────────────
        // No synchronous `queryTransaction` here. Provider webhooks
        // and the /status polling endpoint handle reconciliation.
        // The purchase endpoint returns as soon as the provider has
        // accepted the submission.

        return res.json({
            success: true,
            data: {
                transactionId: order.id,
                reference,
                status: ORDER_STATES.PROCESSING,
                debitAmount,
                debitCurrency,
                totalUsd,
                totalNgn
            }
        });

    } catch (e) {
        console.error('[PURCHASE] Unexpected error:', e);
        res.status(500).json({
            success: false,
            error: e.message || 'Purchase failed',
            code: e.code || 'PURCHASE_FAILED'
        });
    }
});

// ─── GET /api/giftcards/status/:id ───────────────────────────────────────
router.get('/giftcards/status/:id', authMiddleware, async (req, res) => {
    try {
        const { data: order, error } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('*')
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (error || !order) {
            return res.status(404).json({ success: false, error: 'Order not found', code: 'ORDER_NOT_FOUND' });
        }

        if (TERMINAL_STATES.has(order.status)) {
            return res.json({ success: true, data: shapeStatusResponse(order) });
        }

        if (!order.provider_transaction_id) {
            return res.json({ success: true, data: shapeStatusResponse(order) });
        }

        let result = null;
        try {
            result = await dtoneService.queryTransaction(order.provider_transaction_id);
        } catch (queryErr) {
            return res.json({ success: true, data: shapeStatusResponse(order) });
        }

        const reconciliation = require('../services/airtimeReconciliationService');

        if (result.status === 'completed') {
            try { await reconciliation.completeGiftCard(order, result); } catch {}
        } else if (result.isFinal && ['failed', 'cancelled', 'reversed'].includes(result.status)) {
            try { await reconciliation.refundGiftCard(order, result); } catch {}
        }

        const { data: fresh } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('*')
            .eq('id', order.id)
            .maybeSingle();

        return res.json({ success: true, data: shapeStatusResponse(fresh || order) });
    } catch (e) {
        return res.status(500).json({
            success: false,
            error: 'Could not check gift card status',
            code: 'STATUS_FAILED'
        });
    }
});

function shapeStatusResponse(t) {
    return {
        id: t.id,
        reference: t.reference,
        status: t.status,
        isFinal: TERMINAL_STATES.has(t.status),
        cardName: t.card_name,
        faceValue: Number(t.face_value) || 0,
        faceCurrency: t.face_currency,
        quantity: Number(t.quantity) || 1,
        voucherCode: t.status === ORDER_STATES.COMPLETED ? t.voucher_code : null,
        voucherSerial: t.status === ORDER_STATES.COMPLETED ? t.voucher_serial : null,
        instructions: t.instructions,
        errorMessage: t.failure_reason || null,
        totalUsd: Number(t.total_usd) || 0,
        totalNgn: Number(t.price_ngn) || 0,
        debitAmount: Number(t.debit_amount) || 0,
        debitCurrency: t.debit_currency,
        createdAt: t.created_at,
        completedAt: t.completed_at
    };
}

// ─── GET /api/giftcards/history ──────────────────────────────────────────
router.get('/giftcards/history', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('giftcard_transactions')
            .select(`
                id, reference, country_iso3, country_iso2, country_name,
                product_id, card_name, face_value, face_currency, quantity,
                total_usd, price_ngn, debit_amount, debit_currency, status,
                voucher_code, created_at, completed_at
            `)
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw error;

        const shaped = (data || []).map((t) => ({
            id: t.id,
            reference: t.reference,
            countryName: t.country_name,
            countryIso: t.country_iso3,
            countryIso2: t.country_iso2,
            productId: t.product_id,
            cardName: t.card_name,
            faceValue: Number(t.face_value) || 0,
            faceCurrency: t.face_currency,
            quantity: Number(t.quantity) || 1,
            totalUsd: Number(t.total_usd) || 0,
            totalNgn: Number(t.price_ngn) || 0,
            debitAmount: Number(t.debit_amount) || 0,
            debitCurrency: t.debit_currency,
            status: t.status,
            createdAt: t.created_at,
            completedAt: t.completed_at
        }));

        res.json({ success: true, data: shaped });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message, code: 'HISTORY_FAILED' });
    }
});

// ─── POST /api/webhooks/dtone/giftcard ───────────────────────────────────
router.post('/webhooks/dtone/giftcard', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const payload = req.body || {};
        const signature = String(
            req.headers['x-dtone-signature'] || req.headers['x-signature'] || ''
        ).trim();

        const secret = process.env.DTONE_WEBHOOK_SECRET;

        if (secret) {
            if (!signature) return res.status(401).json({ success: false, error: 'Missing signature' });
            const expected = crypto
                .createHmac('sha256', secret)
                .update(JSON.stringify(payload))
                .digest('hex');
            if (!timingSafeEqualHex(expected, signature)) {
                return res.status(401).json({ success: false, error: 'Invalid signature' });
            }
        } else if (process.env.NODE_ENV === 'production') {
            return res.status(401).json({ success: false, error: 'Webhook auth not configured' });
        }

        const dtoneTxId = payload?.transaction_id || payload?.id || payload?.transactionId;
        const externalId = payload?.external_id || payload?.externalId;
        if (!dtoneTxId && !externalId) {
            return res.status(400).json({ success: false, error: 'Missing transaction identifier' });
        }

        let order = null;
        if (dtoneTxId) {
            const { data } = await supabaseAdmin
                .from('giftcard_transactions').select('*')
                .eq('provider_transaction_id', String(dtoneTxId)).maybeSingle();
            order = data;
        }
        if (!order && externalId) {
            const { data } = await supabaseAdmin
                .from('giftcard_transactions').select('*')
                .eq('dtone_external_id', String(externalId)).maybeSingle();
            order = data;
        }

        if (!order) {
            return res.status(200).json({ success: true, note: 'Order not found' });
        }

        try {
            const reconciliation = require('../services/airtimeReconciliationService');
            const result = await reconciliation.forceReconcileTransaction(
                'giftcard_transactions',
                order.id
            );
            return res.status(200).json({ success: true, result });
        } catch (verifyErr) {
            return res.status(200).json({
                success: true,
                note: 'Verification failed, deferred to reconciliation'
            });
        }
    } catch (e) {
        res.status(200).json({ success: false, error: e.message });
    }
});

module.exports = router;
module.exports.invalidateGiftCardCatalog = invalidateGiftCardCatalog;