// services/adminConfigService.js
//
// Reads pricing-related keys from public.app_config.
// 60-second in-memory cache; explicit invalidation on admin writes.
//
// MARKUP MODEL:
//   Each service has TWO markup keys — one for USD, one for NGN:
//     {service}_markup_pct_usd
//     {service}_markup_pct_ngn
//
//   Legacy single-key values ({service}_markup_pct) are still read
//   as a fallback so existing deployments don't break.

const { supabaseAdmin } = require('../db/supabase');

const CACHE_TTL_MS = 60 * 1000;

// Only the keys the pricing pipeline cares about.
const PRICING_KEYS = [
    'usd_to_ngn',
    'giftcard_wholesale_currency',

    // New dual-currency markup keys
    'giftcard_markup_pct_usd',
    'giftcard_markup_pct_ngn',
    'esim_markup_pct_usd',
    'esim_markup_pct_ngn',
    'airtime_markup_pct_usd',
    'airtime_markup_pct_ngn',

    // Legacy fallbacks (still respected if the new keys are missing)
    'giftcard_markup_pct',
    'esim_markup_pct',
    'airtime_markup_pct'
];

const _cache = {
    settings: null,
    fetchedAt: 0,
    promise: null
};

/**
 * Returns a flat object like:
 *   {
 *     usd_to_ngn: 1400,
 *     giftcard_wholesale_currency: 'NGN',
 *     markup: {
 *       giftcard: { usd: 0.1570, ngn: 0.1570 },
 *       esim:     { usd: 0.1500, ngn: 0.1500 },
 *       airtime:  { usd: 0.0500, ngn: 0.0500 }
 *     }
 *   }
 */
async function getSettings({ force = false } = {}) {
    if (!force && _cache.settings && (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS) {
        return _cache.settings;
    }
    if (_cache.promise) return _cache.promise;

    _cache.promise = (async () => {
        try {
            const { data, error } = await supabaseAdmin
                .from('app_config')
                .select('key, value')
                .in('key', PRICING_KEYS);

            if (error) {
                console.error('[adminConfig] read error:', error.message);
                return _cache.settings || defaultSettings();
            }

            const flat = {};
            for (const row of data || []) {
                flat[row.key] = row.value;
            }

            const parsed = parseSettings(flat);

            _cache.settings = parsed;
            _cache.fetchedAt = Date.now();
            return parsed;
        } catch (e) {
            console.error('[adminConfig] read exception:', e.message);
            return _cache.settings || defaultSettings();
        } finally {
            _cache.promise = null;
        }
    })();

    return _cache.promise;
}

function parseSettings(flat) {
    const usdToNgn = parsePositiveNumber(flat.usd_to_ngn, 1400);

    const markup = {
        giftcard: {
            usd: parseMarkup(flat.giftcard_markup_pct_usd, null)
              ?? parseMarkup(flat.giftcard_markup_pct, 0.1570),
            ngn: parseMarkup(flat.giftcard_markup_pct_ngn, null)
              ?? parseMarkup(flat.giftcard_markup_pct, 0.1570)
        },
        esim: {
            usd: parseMarkup(flat.esim_markup_pct_usd, null)
              ?? parseMarkup(flat.esim_markup_pct, 0.1500),
            ngn: parseMarkup(flat.esim_markup_pct_ngn, null)
              ?? parseMarkup(flat.esim_markup_pct, 0.1500)
        },
        airtime: {
            usd: parseMarkup(flat.airtime_markup_pct_usd, null)
              ?? parseMarkup(flat.airtime_markup_pct, 0.0500),
            ngn: parseMarkup(flat.airtime_markup_pct_ngn, null)
              ?? parseMarkup(flat.airtime_markup_pct, 0.0500)
        }
    };

    return {
        usd_to_ngn: usdToNgn,
        giftcard_wholesale_currency: String(
            flat.giftcard_wholesale_currency || 'NGN'
        ).toUpperCase(),
        markup,

        // Convenience accessors for the existing giftcard route
        giftcard_markup_pct_usd: markup.giftcard.usd,
        giftcard_markup_pct_ngn: markup.giftcard.ngn,
        esim_markup_pct_usd:     markup.esim.usd,
        esim_markup_pct_ngn:     markup.esim.ngn,
        airtime_markup_pct_usd:  markup.airtime.usd,
        airtime_markup_pct_ngn:  markup.airtime.ngn
    };
}

function defaultSettings() {
    return parseSettings({});
}

/**
 * Markup can be stored either as "0.1570" (decimal) or "15.7" (percent).
 * If the raw value is > 1, treat it as percent and divide by 100.
 */
function parseMarkup(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return fallback;
    if (n > 1) return n / 100;   // admin typed "15.7"
    return n;                    // already a decimal
}

function parsePositiveNumber(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
}

/** Force next read to hit the database. */
function invalidateSettingsCache() {
    _cache.settings = null;
    _cache.fetchedAt = 0;
}

/**
 * Convenience: returns markup decimal for {service} + {currency}.
 *   getMarkup('giftcard', 'USD') → 0.1570
 *   getMarkup('giftcard', 'NGN') → 0.1570
 */
async function getMarkup(service, currency) {
    const settings = await getSettings();
    const svc = String(service || '').toLowerCase();
    const cur = String(currency || '').toUpperCase() === 'NGN' ? 'ngn' : 'usd';
    return settings?.markup?.[svc]?.[cur] ?? 0.15;
}

module.exports = {
    getSettings,
    getMarkup,
    invalidateSettingsCache,
    PRICING_KEYS
};