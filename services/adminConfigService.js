// services/adminConfigService.js
//
// Reads and caches the admin-configurable settings that live in the
// public.app_config table. Used by gift card, airtime, eSIM, and any
// other service that needs live rates / markup values.
//
// Table shape (public.app_config):
//   key   TEXT PRIMARY KEY
//   value JSONB (or TEXT — we handle both)
//
// Known keys this module exposes:
//   usd_to_ngn            → USD→NGN rate used across the platform
//   giftcard_markup_pct   → markup on gift card wholesale price
//   airtime_markup_pct    → markup on airtime wholesale price
//
// Defaults are returned when a key is missing so callers never crash.

const { supabaseAdmin } = require('../db/supabase');

// ═══════════════════════════════════════════════════════════════════════════
//  DEFAULTS — used when the DB row is missing or unreadable
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULTS = Object.freeze({
    usd_to_ngn: 1600,
    giftcard_markup_pct: 0.1570,
    airtime_markup_pct: 0.05
});

// In-memory cache so we don't hammer Postgres on every request
const CACHE_TTL_MS = 60 * 1000; // 60 seconds
let cache = {
    data: null,
    expiresAt: 0,
    promise: null
};

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Accepts whatever shape the DB returns for a value and coerces it to a
 * plain JS value. Postgres can return TEXT, JSONB, or a JSON-encoded string
 * depending on how the row was written.
 */
function coerceValue(raw) {
    if (raw === null || raw === undefined) return null;

    // Already a plain object / array / number / boolean
    if (typeof raw === 'object') return raw;

    // Number or boolean primitive
    if (typeof raw === 'number' || typeof raw === 'boolean') return raw;

    // String — try JSON.parse first, fall back to the raw string
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed === '') return null;

        // If it looks like a number, return a number
        if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

        // If it looks like JSON, parse it
        if (
            (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
            trimmed === 'true' || trimmed === 'false' || trimmed === 'null'
        ) {
            try { return JSON.parse(trimmed); } catch { /* fall through */ }
        }

        return trimmed;
    }

    return raw;
}

/**
 * Normalises a settings object so callers always get:
 *   - numbers for usd_to_ngn, giftcard_markup_pct, airtime_markup_pct
 *   - defaults when a key is missing or invalid
 */
function normaliseSettings(raw) {
    const merged = { ...DEFAULTS, ...(raw || {}) };

    const usdToNgn = Number(merged.usd_to_ngn);
    const giftMarkup = Number(merged.giftcard_markup_pct);
    const airtimeMarkup = Number(merged.airtime_markup_pct);

    return {
        ...merged,
        usd_to_ngn: Number.isFinite(usdToNgn) && usdToNgn > 0 ? usdToNgn : DEFAULTS.usd_to_ngn,
        giftcard_markup_pct:
            Number.isFinite(giftMarkup) && giftMarkup >= 0
                ? giftMarkup
                : DEFAULTS.giftcard_markup_pct,
        airtime_markup_pct:
            Number.isFinite(airtimeMarkup) && airtimeMarkup >= 0
                ? airtimeMarkup
                : DEFAULTS.airtime_markup_pct
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN CONFIG SERVICE
// ═══════════════════════════════════════════════════════════════════════════
const AdminConfigService = {
    /**
     * Returns the current live settings.
     *
     * Reads from public.app_config, normalises the values, caches the
     * result for 60 seconds. Concurrent callers within the TTL window
     * share a single in-flight promise.
     *
     * NEVER throws — falls back to defaults if the DB is unreachable.
     */
    async getSettings() {
        // Fresh cache
        if (cache.data && Date.now() < cache.expiresAt) {
            return cache.data;
        }

        // Share in-flight request
        if (cache.promise) {
            return cache.promise;
        }

        cache.promise = (async () => {
            try {
                const { data, error } = await supabaseAdmin
                    .from('app_config')
                    .select('key, value');

                if (error) {
                    // Table missing or no read permission — use defaults.
                    // This is common in dev before migrations are applied.
                    if (error.code === '42P01' || error.code === 'PGRST205') {
                        console.warn(
                            '⚠️ [ADMIN_CONFIG] app_config table missing — using defaults'
                        );
                    } else {
                        console.warn(
                            '⚠️ [ADMIN_CONFIG] Read failed — using defaults:',
                            error.message
                        );
                    }
                    cache.data = normaliseSettings(null);
                    cache.expiresAt = Date.now() + CACHE_TTL_MS;
                    return cache.data;
                }

                // Fold the key/value rows into a single object
                const raw = {};
                for (const row of data || []) {
                    if (!row || !row.key) continue;
                    raw[row.key] = coerceValue(row.value);
                }

                const normalised = normaliseSettings(raw);
                cache.data = normalised;
                cache.expiresAt = Date.now() + CACHE_TTL_MS;

                return normalised;
            } catch (e) {
                console.error(
                    '❌ [ADMIN_CONFIG] Unexpected error — using defaults:',
                    e.message
                );
                cache.data = normaliseSettings(null);
                cache.expiresAt = Date.now() + CACHE_TTL_MS;
                return cache.data;
            } finally {
                cache.promise = null;
            }
        })();

        return cache.promise;
    },

    /**
     * Convenience accessor for a single setting.
     * Returns the value from the current cache (populated on first call).
     */
    async get(key, fallback = null) {
        const settings = await this.getSettings();
        return Object.prototype.hasOwnProperty.call(settings, key)
            ? settings[key]
            : fallback;
    },

    /**
     * Writes one or more settings and invalidates the cache so the next
     * read sees the fresh values. Never throws — returns { success }.
     */
    async updateSettings(patch) {
        if (!patch || typeof patch !== 'object') {
            return { success: false, error: 'Invalid patch' };
        }

        try {
            const rows = Object.entries(patch).map(([key, value]) => ({
                key,
                value,
                updated_at: new Date().toISOString()
            }));

            const { error } = await supabaseAdmin
                .from('app_config')
                .upsert(rows, { onConflict: 'key' });

            if (error) {
                console.error('❌ [ADMIN_CONFIG] Upsert failed:', error.message);
                return { success: false, error: error.message };
            }

            // Bust the cache so the next caller sees the new values
            cache.data = null;
            cache.expiresAt = 0;

            return { success: true };
        } catch (e) {
            console.error('❌ [ADMIN_CONFIG] Update threw:', e.message);
            return { success: false, error: e.message };
        }
    },

    /**
     * Clears the in-memory cache — call after an admin edits settings.
     */
    invalidate() {
        cache.data = null;
        cache.expiresAt = 0;
    },

    /**
     * Debug helper — returns the cache state without hitting the DB.
     */
    getCacheState() {
        return {
            hasData: Boolean(cache.data),
            expiresAt: cache.expiresAt,
            ageMs: cache.data ? Date.now() - (cache.expiresAt - CACHE_TTL_MS) : null,
            inFlight: Boolean(cache.promise)
        };
    }
};

module.exports = { AdminConfigService };
module.exports.getSettings = () => AdminConfigService.getSettings();
module.exports.invalidateAdminConfig = () => AdminConfigService.invalidate();