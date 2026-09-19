// routes/giftcardRoutes.js
// Gift Card Routes — MilesSpace
//
// PRICING (from public.app_config):
//   giftcard_markup_pct   (decimal, e.g. 0.1570)
//   usd_to_ngn            (integer, e.g. 1400)
//   → customer_price_ngn = wholesale_ngn × (1 + markup)
//   → customer_price_usd = customer_price_ngn / usd_to_ngn
//
// CATALOG STRATEGY (cold start + background fill):
//   1. First request: fetch 4 pages (~400 products, ~4s), cache, respond.
//   2. Background: keep fetching the rest one page at a time, append to cache.
//   3. Subsequent requests: instant (memory cache).
//   4. If a rebuild returns 0 products, keep the previous catalog.
//
// TRANSACTION LIFECYCLE:
//   - We send auto_confirm: true to DT One so the transaction advances
//     CREATED → CONFIRMED in a single API call.
//   - Immediately after creation we query DT One. If already final:
//       * completed → save voucher, queue email, mark completed
//       * failed/cancelled/declined → refund wallet, mark refunded
//   - If not yet final → order stays processing; the reconciliation
//     service sweeps it.
//
// SAFETY:
//   - Ledger debits/refunds verified before state transitions
//   - Idempotency with request fingerprint
//   - Webhook re-verifies with DT One before finalizing
//   - Explicit order state machine
//   - Critical columns always written via updateOrderCritical (never
//     silently moved into metadata)
//   - Optional diagnostic fields may go to metadata as a fallback

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const dtoneService = require('../services/dtoneService');
const { LedgerService } = require('../services/ledgerService');
const { getSettings } = require('../services/adminConfigService');
const { computePrice } = require('../services/pricingService');

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const MAX_QUANTITY = 1;
const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const COUNTRIES_TTL_MS = 30 * 60 * 1000;
const IDEM_KEY_MIN_LEN = 16;
const IDEM_KEY_MAX_LEN = 100;

const COLD_START_PAGES = 4;
const BACKGROUND_MAX_PAGES = 60;
const PER_PAGE_TIMEOUT_MS = 8000;
const COLD_START_TIME_BUDGET_MS = 15000;

// These fields MUST live as real columns. If a write to any of these
// fails, we log loudly and mark the order for review. We never quietly
// stuff them into metadata.
const CRITICAL_COLUMNS = new Set([
    'status',
    'ledger_transaction_id',
    'provider_transaction_id',
    'dtone_external_id',
    'refunded',
    'refund_status',
    'delivery_status',
    'email_status',
    'voucher_code',
    'voucher_serial',
    'completed_at',
    'refunded_at',
    'failed_at'
]);

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
    LUX:'LU',MLT:'MT',CYP:'CY',AND:'AD',MCO:'MC',SMR:'SM',LIE:'LI',VAT:'VA'
};

const SUPPORTED_DEBIT_CURRENCIES = new Set(['USD', 'NGN']);

// ═══════════════════════════════════════════════════════════════════════════
//  ORDER STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════
const ORDER_STATES = Object.freeze({
    PENDING:          'pending',
    PROCESSING:       'processing',
    PROVIDER_UNKNOWN: 'provider_unknown',
    COMPLETED:        'completed',
    FAILED:           'failed',
    REFUNDED:         'refunded',
    CANCELLED:        'cancelled',
    REVERSED:         'reversed',
    MANUAL_REVIEW:    'manual_review'
});

const TERMINAL_STATES = new Set([
    ORDER_STATES.COMPLETED,
    ORDER_STATES.FAILED,
    ORDER_STATES.REFUNDED,
    ORDER_STATES.CANCELLED,
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

function normalizeWholesaleToNgn(amount, currency, usdToNgn) {
    const amt = Number(amount);
    const cur = String(currency || '').toUpperCase();
    if (!Number.isFinite(amt) || amt <= 0) return null;

    if (cur === 'NGN') return amt;
    if (cur === 'USD') return amt * usdToNgn;

    const fx = FX_TO_USD[cur];
    if (fx) return amt * fx * usdToNgn;

    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CACHES
// ═══════════════════════════════════════════════════════════════════════════
const productCache = {
    products: [],
    expiresAt: 0,
    promise: null,
    lastError: null,
    lastBuiltAt: 0,
    isFilling: false,
    fillComplete: false,
    fillStartedAt: 0
};

const countryCache = {
    countries: [],
    expiresAt: 0,
    promise: null,
    lastError: null,
    lastBuiltAt: 0
};

function isProductCacheFresh() {
    return productCache.products.length > 0 && Date.now() < productCache.expiresAt;
}
function isCountryCacheFresh() {
    return countryCache.countries.length > 0 && Date.now() < countryCache.expiresAt;
}

/**
 * Exported so admin routes can force a rebuild after pricing changes.
 */
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

    if (p.productType && p.productType !== 'FIXED_VALUE_PIN_PURCHASE') {
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
            benefit?.amount ??
            0
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

    if (!Number.isFinite(pricing.priceNgn) || pricing.priceNgn <= 0) {
        return reject('bad_price_ngn');
    }
    if (!Number.isFinite(pricing.priceUsd) || pricing.priceUsd <= 0) {
        return reject('bad_price_usd');
    }

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

    const wholesaleUsd = wholesaleNgn / (usdToNgn || 1400);

    return {
        productId,
        name,
        faceValue: Number.isFinite(faceValue) ? faceValue : 0,
        currency: faceCurrency || 'USD',
        countryIso: countryIso || null,
        countryIso2: countryIso2 || null,
        countryName,
        operatorName: p.operatorName || null,
        description: p.description || null,
        instructions: p.instructions || null,

        priceUsd: pricing.priceUsd,
        priceNgn: pricing.priceNgn,

        // Stored directly — never reverse-engineered from selling prices
        wholesaleNgn: +wholesaleNgn.toFixed(4),
        wholesaleUsd: +wholesaleUsd.toFixed(4),

        productType: p.productType || 'FIXED_VALUE_PIN_PURCHASE'
    };
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
            const settings = await getSettings();
            const usdToNgn = Number(settings?.usd_to_ngn) || 1400;
            const markupPctRaw = Number(settings?.giftcard_markup_pct);
            const markupPct = Number.isFinite(markupPctRaw) && markupPctRaw >= 0
                ? markupPctRaw
                : 0.1570;

            console.log(`📦 [GIFTCARDS] Cold start — fetching first ${COLD_START_PAGES} pages…`);

            const raw = await dtoneService.getGiftCardProducts(null, {
                productType: 'FIXED_VALUE_PIN_PURCHASE',
                maxPages: COLD_START_PAGES,
                maxTotalMs: COLD_START_TIME_BUDGET_MS,
                requestTimeoutMs: PER_PAGE_TIMEOUT_MS
            });
            const list = Array.isArray(raw) ? raw : [];

            const products = [];
            const rejections = new Map();

            for (const p of list) {
                const normalized = normalizeProduct(p, usdToNgn, markupPct, rejections);
                if (normalized) products.push(normalized);
            }

            products.sort(sortProductList);

            const gotProducts = products.length > 0;
            const hadPrevious = productCache.products.length > 0;

            if (gotProducts || !hadPrevious) {
                productCache.products = products;
                productCache.expiresAt = Date.now() + CATALOG_TTL_MS;
                productCache.lastBuiltAt = Date.now();
                productCache.lastError = null;

                if (!countryCache.countries.length) {
                    deriveCountriesFromProducts(products);
                }
            } else {
                productCache.expiresAt = Date.now() + CATALOG_TTL_MS;
                productCache.lastError = 'Latest build returned 0 products; kept previous catalog';
                console.warn('⚠️ [GIFTCARDS] Latest build returned 0 products — kept previous catalog.');
            }

            const elapsed = Date.now() - startTs;
            console.log(
                `📦 [GIFTCARDS] Cold catalog: ${products.length} sellable / ${list.length} total ` +
                `in ${elapsed}ms (markup ${(markupPct * 100).toFixed(2)}%, rate ₦${usdToNgn})`
            );
            if (rejections.size) {
                console.warn('⚠️ [GIFTCARDS] Rejections:', Object.fromEntries(rejections));
            }

            if (products.length > 0 && !productCache.isFilling && !productCache.fillComplete) {
                scheduleBackgroundFill(usdToNgn, markupPct);
            }

            return productCache;
        } catch (e) {
            productCache.lastError = e.message;
            console.error('❌ [GIFTCARDS] Catalog build failed:', e.message);

            if (productCache.products.length) {
                console.warn('⚠️ [GIFTCARDS] Keeping previous catalog after failure.');
                return productCache;
            }
            throw e;
        } finally {
            productCache.promise = null;
        }
    })();

    return productCache.promise;
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

function scheduleBackgroundFill(usdToNgn, markupPct) {
    if (productCache.isFilling) return;

    productCache.isFilling = true;
    productCache.fillComplete = false;
    productCache.fillStartedAt = Date.now();

    setImmediate(() => {
        runBackgroundFill(usdToNgn, markupPct)
            .catch((e) => console.warn('⚠️ [GIFTCARDS] BG fill failed:', e.message))
            .finally(() => {
                productCache.isFilling = false;
            });
    });
}

async function runBackgroundFill(usdToNgn, markupPct) {
    console.log(`🔄 [GIFTCARDS] Background fill starting from page ${COLD_START_PAGES + 1}…`);

    const seenIds = new Set(productCache.products.map((p) => String(p.productId)));
    let totalAdded = 0;
    let consecutiveEmpty = 0;
    let consecutiveErrors = 0;

    const baseUrl = dtoneService.baseUrl;
    const client = dtoneService.client;

    for (let page = COLD_START_PAGES + 1; page <= BACKGROUND_MAX_PAGES; page++) {
        if (!productCache.isFilling) break;

        let items = [];
        try {
            const qs = new URLSearchParams({
                service_id: '4',
                type: 'FIXED_VALUE_PIN_PURCHASE',
                page: String(page),
                per_page: '100'
            });

            const res = await client.get(`${baseUrl}/products?${qs.toString()}`, {
                timeout: PER_PAGE_TIMEOUT_MS
            });

            const body = res.data;
            if (Array.isArray(body)) items = body;
            else if (Array.isArray(body?.items)) items = body.items;
            else if (Array.isArray(body?.data)) items = body.data;
            else if (Array.isArray(body?.results)) items = body.results;
        } catch (e) {
            consecutiveErrors++;
            if (consecutiveErrors >= 3) {
                console.warn(`⚠️ [GIFTCARDS] BG fill stopping after 3 consecutive errors`);
                break;
            }
            await new Promise((r) => setTimeout(r, 2000));
            continue;
        }
        consecutiveErrors = 0;

        if (!items.length) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= 2) break;
            continue;
        }
        consecutiveEmpty = 0;

        let added = 0;
        for (const p of items) {
            const described = dtoneService._describeGiftCardProduct(p);
            if (!described) continue;

            const key = String(described.productId);
            if (seenIds.has(key)) continue;

            const normalized = normalizeProduct(described, usdToNgn, markupPct);
            if (normalized) {
                productCache.products.push(normalized);
                seenIds.add(key);
                added++;
            }
        }

        totalAdded += added;
        await new Promise((r) => setTimeout(r, 250));
    }

    productCache.products.sort(sortProductList);
    productCache.lastBuiltAt = Date.now();
    productCache.fillComplete = true;

    console.log(
        `✅ [GIFTCARDS] Background fill complete: +${totalAdded} products ` +
        `(total ${productCache.products.length})`
    );
}

function deriveCountriesFromProducts(products) {
    const seen = new Map();
    for (const p of products) {
        const iso3 = String(p.countryIso || '').toUpperCase();
        if (!iso3 || iso3.length !== 3) continue;
        if (!seen.has(iso3)) {
            seen.set(iso3, {
                iso3,
                iso2: p.countryIso2 || null,
                name: p.countryName || iso3
            });
        }
    }
    countryCache.countries = Array.from(seen.values())
        .sort((a, b) => a.name.localeCompare(b.name));
    countryCache.expiresAt = Date.now() + COUNTRIES_TTL_MS;
    countryCache.lastBuiltAt = Date.now();
    countryCache.lastError = null;
}

async function buildCountryCatalog({ force = false } = {}) {
    if (!force && isCountryCacheFresh()) return countryCache;
    if (countryCache.promise) return countryCache.promise;

    countryCache.promise = (async () => {
        const startTs = Date.now();
        try {
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

            console.log(`🌍 [GIFTCARDS] Countries: ${countries.length} in ${Date.now() - startTs}ms`);
            return countryCache;
        } catch (e) {
            countryCache.lastError = e.message;
            console.warn('⚠️ [GIFTCARDS] /countries failed, deriving from products:', e.message);

            if (productCache.products.length) {
                deriveCountriesFromProducts(productCache.products);
                return countryCache;
            }
            try {
                await buildProductCatalog();
                if (productCache.products.length) {
                    deriveCountriesFromProducts(productCache.products);
                    return countryCache;
                }
            } catch (e2) {
                console.error('❌ [GIFTCARDS] Fallback failed:', e2.message);
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
        console.error('[PIN RPC] record_pin_failure error:', error);
        const e = new Error('Unable to verify transaction security right now.');
        e.code = 'PIN_SECURITY_ERROR';
        throw e;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
        const e = new Error('PIN security state unavailable.');
        e.code = 'PIN_SECURITY_STATE_ERROR';
        throw e;
    }
    if (typeof row.locked !== 'boolean' || !Number.isInteger(row.attempts_remaining)) {
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

/**
 * Verified write for CRITICAL columns.
 * Throws on any failure — the caller MUST handle the exception.
 * Never silently moves data into metadata.
 */
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

/**
 * Diagnostic-only fields MAY fall back to metadata if their column is
 * missing. This is NOT used for critical state transitions.
 */
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
            // Should never get here — critical writes go through updateOrderCritical
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

                rest.metadata = {
                    ...(current?.metadata || {}),
                    [col]: missingValue
                };
            } catch {}
        }

        const retry = await supabaseAdmin
            .from('giftcard_transactions')
            .update(rest)
            .eq('id', orderId);

        if (retry.error) {
            console.error('[updateOrderDiagnostic] Retry failed:', retry.error.message);
            return false;
        }
        return true;
    }

    console.error('[updateOrderDiagnostic] Failed:', error.message);
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
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// ─── WALLET BALANCES ─────────────────────────────────────────────────────
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

// ─── COUNTRIES ───────────────────────────────────────────────────────────
router.get('/giftcards/countries', authMiddleware, async (req, res) => {
    const startTs = Date.now();

    if (isCountryCacheFresh()) {
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-Age-Ms', String(Date.now() - countryCache.lastBuiltAt));
        return res.json({ success: true, data: countryCache.countries });
    }

    if (countryCache.countries.length > 0) {
        buildCountryCatalog({ force: true }).catch((e) =>
            console.warn('⚠️ [GIFTCARDS] BG country refresh failed:', e.message)
        );
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

// ─── PRODUCTS ────────────────────────────────────────────────────────────
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

        // Defensive: never return rows missing a name or a price.
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
                (p.countryName || '').toLowerCase().includes(search)
            );
        }

        const total = list.length;
        const start = (page - 1) * limit;
        const end = start + limit;

        const items = list.slice(start, end).map((p) => ({
            productId: p.productId,
            name: p.name,
            faceValue: p.faceValue,
            currency: p.currency,
            countryIso: p.countryIso,
            countryIso2: p.countryIso2,
            countryName: p.countryName,
            operatorName: p.operatorName,
            description: p.description,
            priceUsd: p.priceUsd,
            priceNgn: p.priceNgn
        }));

        const hasMore = end < total;

        res.set('X-Cache', cacheState);
        res.set('X-Cache-Age-Ms', String(Date.now() - productCache.lastBuiltAt));
        res.set('X-Response-Ms', String(Date.now() - startTs));
        res.set('X-Catalog-Size', String(productCache.products.length));
        res.set('X-BG-Filling', String(productCache.isFilling));

        res.json({
            success: true,
            data: items,
            meta: { page, limit, total, hasMore, returned: items.length }
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

// ─── PURCHASE ────────────────────────────────────────────────────────────
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
        // ── Idempotency replay check ──────────────────────────────
        const { data: existing, error: existingErr } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('id, reference, status, request_fingerprint')
            .eq('user_id', userId)
            .eq('idempotency_key', idemKey)
            .maybeSingle();

        if (existingErr) {
            console.error('[PURCHASE] Idempotency lookup failed:', existingErr);
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

        if (qty !== 1) {
            return res.status(400).json({
                success: false,
                error: 'Multiple quantity purchases are not yet supported for gift cards.',
                code: 'QUANTITY_NOT_SUPPORTED'
            });
        }

        // ── PIN verification ──────────────────────────────────────
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

        // ── Product lookup ────────────────────────────────────────
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
            console.error(`[PURCHASE] Product ${product.productId} has invalid priceUsd=${product.priceUsd}`);
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

        // ── Insert order ──────────────────────────────────────────
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
            console.error('[PURCHASE] Insert order error:', insertErr);
            return res.status(500).json({
                success: false,
                error: 'Could not create order',
                code: 'ORDER_CREATE_FAILED'
            });
        }

        // ── Ledger debit ──────────────────────────────────────────
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
            console.error('[PURCHASE] Debit threw:', debitErr.message);
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
            console.error('[PURCHASE] Debit returned non-success:', ledgerResult);
            await safeMarkFailed(
                order.id,
                `Wallet debit not confirmed: ${ledgerResult?.error || ledgerResult?.code || 'unknown'}`
            );
            if (ledgerResult?.code === 'INSUFFICIENT_BALANCE') {
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

        await updateOrderCritical(order.id, {
            ledger_transaction_id: ledgerResult.transaction_id,
            status: ORDER_STATES.PROCESSING,
            updated_at: new Date().toISOString()
        });

        // ── DT One submission (auto_confirm: true) ────────────────
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
            console.error(`[PURCHASE] DT One submit threw for ${reference}:`, providerErr.message);

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
                        message: 'Purchase is being confirmed with the provider. You will be notified shortly.',
                        debitAmount,
                        debitCurrency,
                        totalUsd,
                        totalNgn
                    }
                });
            }

            // ── Definitive rejection → refund immediately ─────────
            try {
                const refundResult = await LedgerService.refundTransaction(
                    userId,
                    ledgerResult.transaction_id,
                    `Gift card rejected by provider: ${providerErr.message}`
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
                console.error(`[PURCHASE] Refund failed for ${reference}:`, refundErr.message);
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

        // ── Persist provider transaction ID ───────────────────────
        await updateOrderCritical(order.id, {
            provider_transaction_id: String(providerTxId),
            dtone_external_id: providerExternalId,
            provider_status: providerResult.status || 'SUBMITTED',
            updated_at: new Date().toISOString()
        });

        // Optional diagnostic — provider response summary
        await updateOrderDiagnostic(order.id, {
            provider_response_summary: summarizeProviderResponse(providerResult.raw)
        }).catch((e) => console.warn('⚠️ [PURCHASE] diagnostic write failed:', e.message));

        // ── Immediate provider snapshot ───────────────────────────
        // auto_confirm usually advances us past CREATED in the same
        // round-trip, but DT One can still return CONFIRMED/SUBMITTED.
        // We query once more right away to catch fast completions and
        // fast rejections without waiting for the reconciliation worker.
        let providerSnapshot = null;
        try {
            providerSnapshot = await dtoneService.queryTransaction(providerTxId);
        } catch (snapshotErr) {
            console.warn(
                `[PURCHASE] Immediate DT One status check failed for ${reference}:`,
                snapshotErr.message
            );
        }

        if (providerSnapshot) {
            const reconciliation = require('../services/airtimeReconciliationService');

            if (providerSnapshot.status === 'completed') {
                // Voucher came back immediately — finalize now
                const localOrder = {
                    ...order,
                    status: ORDER_STATES.PROCESSING,
                    provider_transaction_id: String(providerTxId),
                    dtone_external_id: providerExternalId,
                    ledger_transaction_id: ledgerResult.transaction_id
                };

                try {
                    await reconciliation.completeGiftCard(localOrder, providerSnapshot);
                } catch (completeErr) {
                    console.error(
                        `[PURCHASE] Immediate completeGiftCard failed for ${reference}:`,
                        completeErr.message
                    );
                }
            } else if (
                providerSnapshot.isFinal &&
                ['failed', 'cancelled', 'reversed'].includes(providerSnapshot.status)
            ) {
                // Definitive rejection arrived in the same request
                const localOrder = {
                    ...order,
                    status: ORDER_STATES.PROCESSING,
                    provider_transaction_id: String(providerTxId),
                    dtone_external_id: providerExternalId,
                    ledger_transaction_id: ledgerResult.transaction_id
                };

                try {
                    await reconciliation.refundGiftCard(localOrder, providerSnapshot);
                } catch (refundErr) {
                    console.error(
                        `[PURCHASE] Immediate refundGiftCard failed for ${reference}:`,
                        refundErr.message
                    );
                }
            }
        }

        // ── Read final state and respond accordingly ──────────────
        const { data: freshOrder } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('*')
            .eq('id', order.id)
            .maybeSingle();

        if (freshOrder?.status === ORDER_STATES.COMPLETED) {
            return res.json({
                success: true,
                data: shapeStatusResponse(freshOrder)
            });
        }

        if (freshOrder?.status === ORDER_STATES.REFUNDED) {
            return res.json({
                success: true,
                data: shapeStatusResponse(freshOrder)
            });
        }

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

// ─── STATUS ──────────────────────────────────────────────────────────────
router.get('/giftcards/status/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const { data: order, error } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error('[STATUS] DB error:', error.message);
            return res.status(500).json({
                success: false,
                error: 'Could not load order status',
                code: 'STATUS_DB_FAILED'
            });
        }

        if (!order) {
            return res.status(404).json({
                success: false,
                error: 'Order not found',
                code: 'ORDER_NOT_FOUND'
            });
        }

        // Terminal — no need to query DT One
        if (TERMINAL_STATES.has(order.status)) {
            return res.json({ success: true, data: shapeStatusResponse(order) });
        }

        // No provider transaction yet — nothing to reconcile
        if (!order.provider_transaction_id) {
            return res.json({ success: true, data: shapeStatusResponse(order) });
        }

        // Active — query DT One directly and act on the result
        let result = null;
        try {
            result = await dtoneService.queryTransaction(order.provider_transaction_id);
        } catch (queryErr) {
            console.warn(`[STATUS] DT One query failed for ${order.reference}:`, queryErr.message);
            return res.json({ success: true, data: shapeStatusResponse(order) });
        }

        const reconciliation = require('../services/dtoneReconciliationService');

        if (result.status === 'completed') {
            try {
                await reconciliation.completeGiftCard(order, result);
            } catch (completeErr) {
                console.error(`[STATUS] completeGiftCard failed for ${order.reference}:`, completeErr.message);
            }
        } else if (
            result.isFinal &&
            ['failed', 'cancelled', 'reversed'].includes(result.status)
        ) {
            try {
                await reconciliation.refundGiftCard(order, result);
            } catch (refundErr) {
                console.error(`[STATUS] refundGiftCard failed for ${order.reference}:`, refundErr.message);
            }
        }

        const { data: fresh } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('*')
            .eq('id', order.id)
            .maybeSingle();

        return res.json({
            success: true,
            data: shapeStatusResponse(fresh || order)
        });

    } catch (e) {
        console.error('[STATUS] Error:', e.message);
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

// ─── HISTORY ─────────────────────────────────────────────────────────────
router.get('/giftcards/history', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data, error } = await supabaseAdmin
            .from('giftcard_transactions')
            .select(`
                id, reference, country_iso3, country_iso2, country_name,
                product_id, card_name, face_value, face_currency, quantity,
                total_usd, price_ngn, debit_amount, debit_currency, status,
                voucher_code, created_at, completed_at
            `)
            .eq('user_id', userId)
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
        console.error('History error:', e);
        res.status(500).json({ success: false, error: e.message, code: 'HISTORY_FAILED' });
    }
});

// ─── WEBHOOK ─────────────────────────────────────────────────────────────
router.post('/webhooks/dtone/giftcard', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const payload = req.body || {};
        const signature = String(
            req.headers['x-dtone-signature'] || req.headers['x-signature'] || ''
        ).trim();

        const secret = process.env.DTONE_WEBHOOK_SECRET;

        if (secret) {
            if (!signature) {
                console.warn('[WEBHOOK] Missing signature — rejecting');
                return res.status(401).json({ success: false, error: 'Missing signature' });
            }
            const expected = crypto
                .createHmac('sha256', secret)
                .update(JSON.stringify(payload))
                .digest('hex');
            if (!timingSafeEqualHex(expected, signature)) {
                console.warn('[WEBHOOK] Signature mismatch — rejecting');
                return res.status(401).json({ success: false, error: 'Invalid signature' });
            }
        } else if (process.env.NODE_ENV === 'production') {
            console.error('[WEBHOOK] DTONE_WEBHOOK_SECRET is not set in production — rejecting');
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
            console.warn('[WEBHOOK] Order not found:', { dtoneTxId, externalId });
            return res.status(200).json({ success: true, note: 'Order not found, ignored' });
        }

        // Never trust the webhook payload — always re-query DT One.
        try {
            const verified = await dtoneService.queryTransaction(
                order.provider_transaction_id || dtoneTxId
            );

            if (!verified) {
                return res.status(200).json({ success: true, note: 'Verification pending' });
            }

            const reconciliation = require('../services/dtoneReconciliationService');
            const result = await reconciliation.forceReconcileTransaction(
                'giftcard_transactions',
                order.id
            );

            return res.status(200).json({ success: true, result });
        } catch (verifyErr) {
            console.error(`[WEBHOOK] Verification failed for ${order.reference}:`, verifyErr.message);
            return res.status(200).json({
                success: true,
                note: 'Verification failed, deferred to reconciliation'
            });
        }
    } catch (e) {
        console.error('[WEBHOOK] Unexpected error:', e);
        res.status(200).json({ success: false, error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
module.exports = router;
module.exports.invalidateGiftCardCatalog = invalidateGiftCardCatalog;