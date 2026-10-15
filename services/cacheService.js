// services/cacheService.js
// ─────────────────────────────────────────────────────────────────
// Two-level cache: L1 = Node memory, L2 = Supabase system_cache.
//
// Behavior:
//   • get(key)        — L1 first, then L2. Returns value | null.
//   • getStale(key)   — allows expired entries. Returns
//                       { value, expired, expiresAt } | null.
//   • set(key, v, ttl)— writes L1 synchronously, L2 best-effort.
//                       Returns L2 row | null.
//   • delete(key)     — deletes from L1 and L2.
//   • clear()         — clears L1 and L2 (all keys).
//   • getStats()      — L2 row inventory.
//   • getOrSet(key, fn, ttl, opts) — cache-aside with request
//                       coalescing. Options:
//                         allowStale (default true)
//                         staleWhileRevalidate (default false)
//                         forceRefresh (default false)
//
// CHANGES IN THIS REVISION:
//   • L2 health gate. When system_cache errors, L2 is disabled
//     for 60s. During that window, get/set/delete skip the
//     Supabase round-trip entirely and rely on memory.
//   • Log noise reduced: one warning per 60s window on L2 failure
//     instead of one per operation.
//   • Rolling metrics via getMetrics() and CACHE_METRICS=true.
//   • No API contract change. Every existing method returns the
//     same shape as before.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

// ─── TUNABLES ───────────────────────────────────────────────────
const DEFAULT_TTL_SECONDS        = 60;
const MAX_MEMORY_ENTRIES         = 500;
const CLEANUP_INTERVAL_MS        = 5 * 60 * 1000;
const L2_FAILURE_WINDOW_MS       = 60 * 1000;   // disable L2 for 60s after a failure
const L2_WARN_INTERVAL_MS        = 60 * 1000;   // one warning per 60s
const METRICS_INTERVAL_MS        = 60 * 1000;
const METRICS_ENABLED            = process.env.CACHE_METRICS === 'true';
const L2_WRITE_ENABLED           = process.env.CACHE_L2_ENABLED !== 'false';

class CacheService {
    constructor() {
        this.defaultTTL = DEFAULT_TTL_SECONDS;
        this.memoryCache = new Map();
        this.inFlight = new Map();
        this.cleanupInterval = null;
        this.cleanupRunning = false;
        this.maxMemoryEntries = MAX_MEMORY_ENTRIES;

        // L2 health
        this._l2DisabledUntil = 0;
        this._lastL2WarnAt = 0;
        this._l2Enabled = L2_WRITE_ENABLED;

        // Rolling metrics
        this._resetMetrics();

        this.startCleanup();
        this._startMetricsLogger();
    }

    _resetMetrics() {
        this._metrics = {
            hitsL1: 0,
            hitsL2: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            l2Failures: 0,
            l2Skipped: 0,
            errors: 0,
            since: Date.now()
        };
    }

    // ─── MEMORY (L1) ──────────────────────────────────────────────

    _memoryGet(key, allowStale = false) {
        const item = this.memoryCache.get(key);
        if (!item) return null;

        const now = Date.now();
        const isExpired = item.expiresAt <= now;

        if (isExpired && !allowStale) {
            this.memoryCache.delete(key);
            return null;
        }

        return { value: item.value, expired: isExpired, expiresAt: item.expiresAt };
    }

    _memorySet(key, value, ttlSeconds) {
        const now = Date.now();

        if (!this.memoryCache.has(key) && this.memoryCache.size >= this.maxMemoryEntries) {
            const firstKey = this.memoryCache.keys().next().value;
            if (firstKey) this.memoryCache.delete(firstKey);
        }

        this.memoryCache.set(key, {
            value,
            createdAt: now,
            expiresAt: now + ttlSeconds * 1000
        });
    }

    _memoryDelete(key) {
        this.memoryCache.delete(key);
    }

    // ─── L2 HEALTH GATE ───────────────────────────────────────────

    _isL2Usable() {
        if (!this._l2Enabled) return false;
        return Date.now() >= this._l2DisabledUntil;
    }

    _noteL2Failure(reason) {
        this._metrics.l2Failures++;
        this._l2DisabledUntil = Date.now() + L2_FAILURE_WINDOW_MS;

        if (Date.now() - this._lastL2WarnAt > L2_WARN_INTERVAL_MS) {
            this._lastL2WarnAt = Date.now();
            console.warn(
                `⚠️ Cache L2 (system_cache) failing — disabling for ` +
                `${Math.round(L2_FAILURE_WINDOW_MS / 1000)}s. ` +
                `Reason: ${String(reason).slice(0, 140)}`
            );
        }
    }

    _noteL2Skipped() {
        this._metrics.l2Skipped++;
    }

    // ─── SUPABASE (L2) ────────────────────────────────────────────

    async _supabaseGet(key, allowStale = false) {
        if (!this._isL2Usable()) {
            this._noteL2Skipped();
            return null;
        }

        try {
            let query = supabaseAdmin
                .from('system_cache')
                .select('cache_value, expires_at, updated_at')
                .eq('cache_key', key)
                .maybeSingle();

            if (!allowStale) {
                query = query.gte('expires_at', new Date().toISOString());
            }

            const { data, error } = await query;
            if (error) {
                this._noteL2Failure(error.message);
                return null;
            }
            if (!data) return null;

            const expiresAt = new Date(data.expires_at).getTime();
            const expired = expiresAt <= Date.now();

            return {
                value: data.cache_value,
                expired,
                expiresAt,
                updatedAt: data.updated_at
            };

        } catch (error) {
            this._noteL2Failure(error.message);
            return null;
        }
    }

    async _supabaseSet(key, value, ttlSeconds) {
        if (!this._isL2Usable()) {
            this._noteL2Skipped();
            return null;
        }

        try {
            const now = new Date();
            const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

            const { data, error } = await supabaseAdmin
                .from('system_cache')
                .upsert({
                    cache_key: key,
                    cache_value: value,
                    expires_at: expiresAt,
                    updated_at: now.toISOString()
                }, { onConflict: 'cache_key' })
                .select('cache_key, expires_at, updated_at')
                .maybeSingle();

            if (error) {
                this._noteL2Failure(error.message);
                return null;
            }
            return data || null;

        } catch (error) {
            this._noteL2Failure(error.message);
            return null;
        }
    }

    async _supabaseDelete(key) {
        if (!this._isL2Usable()) {
            this._noteL2Skipped();
            return true;
        }

        try {
            const { error } = await supabaseAdmin
                .from('system_cache')
                .delete()
                .eq('cache_key', key);

            if (error) {
                this._noteL2Failure(error.message);
                return false;
            }
            return true;

        } catch (error) {
            this._noteL2Failure(error.message);
            return false;
        }
    }

    // ─── PUBLIC: READ ─────────────────────────────────────────────

    async get(key) {
        const memory = this._memoryGet(key, false);
        if (memory) {
            this._metrics.hitsL1++;
            return memory.value;
        }

        const db = await this._supabaseGet(key, false);
        if (!db) {
            this._metrics.misses++;
            return null;
        }

        this._metrics.hitsL2++;
        const remainingMs = Math.max(1000, db.expiresAt - Date.now());
        this._memorySet(key, db.value, remainingMs / 1000);
        return db.value;
    }

    async getStale(key) {
        const memory = this._memoryGet(key, true);
        if (memory) return memory;

        return await this._supabaseGet(key, true);
    }

    // ─── PUBLIC: WRITE ────────────────────────────────────────────

    async set(key, value, ttl = this.defaultTTL) {
        const ttlSeconds = Math.max(1, Number(ttl) || this.defaultTTL);
        this._memorySet(key, value, ttlSeconds);
        this._metrics.sets++;

        const dbResult = await this._supabaseSet(key, value, ttlSeconds);
        return dbResult;
    }

    async delete(key) {
        this._memoryDelete(key);
        this._metrics.deletes++;
        return await this._supabaseDelete(key);
    }

    async clear() {
        this.memoryCache.clear();

        if (!this._isL2Usable()) {
            this._noteL2Skipped();
            return true;
        }

        try {
            const { error } = await supabaseAdmin
                .from('system_cache')
                .delete()
                .not('cache_key', 'is', null);

            if (error) {
                this._noteL2Failure(error.message);
                return false;
            }
            return true;

        } catch (error) {
            this._noteL2Failure(error.message);
            return false;
        }
    }

    // ─── PUBLIC: INVENTORY ────────────────────────────────────────

    async getStats() {
        if (!this._isL2Usable()) {
            return {
                total: 0,
                expired: 0,
                valid: 0,
                memoryEntries: this.memoryCache.size,
                items: [],
                l2Disabled: true,
                l2DisabledUntil: new Date(this._l2DisabledUntil).toISOString()
            };
        }

        try {
            const { data, error } = await supabaseAdmin
                .from('system_cache')
                .select('cache_key, expires_at, updated_at')
                .order('expires_at', { ascending: true });

            if (error) {
                this._noteL2Failure(error.message);
                return null;
            }

            const now = Date.now();
            const items = data || [];

            return {
                total: items.length,
                expired: items.filter(i => new Date(i.expires_at).getTime() < now).length,
                valid: items.filter(i => new Date(i.expires_at).getTime() >= now).length,
                memoryEntries: this.memoryCache.size,
                items,
                l2Disabled: false
            };

        } catch (error) {
            this._noteL2Failure(error.message);
            return null;
        }
    }

    // ─── CACHE-ASIDE WITH COALESCING ──────────────────────────────

    async getOrSet(key, fetchFn, ttl = this.defaultTTL, options = {}) {
        const {
            allowStale = true,
            staleWhileRevalidate = false,
            forceRefresh = false
        } = options;

        if (!forceRefresh) {
            const fresh = await this.get(key);
            if (fresh !== null) return fresh;

            if (allowStale) {
                const stale = await this.getStale(key);
                if (stale && stale.value !== undefined) {
                    if (staleWhileRevalidate) {
                        this._refreshInBackground(key, fetchFn, ttl);
                    }
                    return stale.value;
                }
            }
        }

        // Coalesce concurrent misses for the same key.
        if (this.inFlight.has(key)) {
            return await this.inFlight.get(key);
        }

        const promise = (async () => {
            try {
                const freshValue = await fetchFn();
                await this.set(key, freshValue, ttl);
                return freshValue;
            } finally {
                this.inFlight.delete(key);
            }
        })();

        this.inFlight.set(key, promise);
        return await promise;
    }

    _refreshInBackground(key, fetchFn, ttl) {
        if (this.inFlight.has(key)) return;

        const promise = (async () => {
            try {
                const freshValue = await fetchFn();
                await this.set(key, freshValue, ttl);
            } catch (error) {
                this._metrics.errors++;
                if (process.env.NODE_ENV !== 'production') {
                    console.warn(`⚠️ Background cache refresh failed [${key}]:`, error.message);
                }
            } finally {
                this.inFlight.delete(key);
            }
        })();

        this.inFlight.set(key, promise);
    }

    // ─── CLEANUP ──────────────────────────────────────────────────

    async cleanup() {
        if (this.cleanupRunning) return 0;
        this.cleanupRunning = true;

        try {
            for (const [key, item] of this.memoryCache.entries()) {
                if (item.expiresAt <= Date.now()) this.memoryCache.delete(key);
            }

            if (!this._isL2Usable()) {
                this._noteL2Skipped();
                return 0;
            }

            const now = new Date().toISOString();
            const { count, error } = await supabaseAdmin
                .from('system_cache')
                .delete({ count: 'exact' })
                .lt('expires_at', now);

            if (error) {
                this._noteL2Failure(error.message);
                return 0;
            }

            return count || 0;

        } catch (error) {
            this._noteL2Failure(error.message);
            return 0;

        } finally {
            this.cleanupRunning = false;
        }
    }

    startCleanup() {
        this.stopCleanup();
        this.cleanupInterval = setInterval(() => {
            this.cleanup().catch(() => {});
        }, CLEANUP_INTERVAL_MS);
        if (this.cleanupInterval.unref) this.cleanupInterval.unref();
    }

    stopCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    // ─── METRICS ──────────────────────────────────────────────────

    getMetrics() {
        const windowMs = Date.now() - this._metrics.since;
        const totalLookups = this._metrics.hitsL1 + this._metrics.hitsL2 + this._metrics.misses;
        const hitRate = totalLookups > 0
            ? ((this._metrics.hitsL1 + this._metrics.hitsL2) / totalLookups * 100).toFixed(1)
            : '0.0';
        return {
            ...this._metrics,
            windowSeconds: Math.round(windowMs / 1000),
            totalLookups,
            hitRatePercent: Number(hitRate),
            memoryEntries: this.memoryCache.size,
            inFlight: this.inFlight.size,
            l2Disabled: !this._isL2Usable(),
            l2Enabled: this._l2Enabled
        };
    }

    resetMetrics() {
        this._resetMetrics();
    }

    _startMetricsLogger() {
        if (!METRICS_ENABLED) return;
        this._metricsInterval = setInterval(() => {
            const m = this.getMetrics();
            console.log(
                `[cache] L1=${m.hitsL1} L2=${m.hitsL2} miss=${m.misses} ` +
                `hit=${m.hitRatePercent}% l2Fail=${m.l2Failures} ` +
                `l2Skip=${m.l2Skipped} mem=${m.memoryEntries} ` +
                `inFlight=${m.inFlight} l2Disabled=${m.l2Disabled}`
            );
            this.resetMetrics();
        }, METRICS_INTERVAL_MS);
        if (this._metricsInterval.unref) this._metricsInterval.unref();
    }

    destroy() {
        this.stopCleanup();
        if (this._metricsInterval) {
            clearInterval(this._metricsInterval);
            this._metricsInterval = null;
        }
        this.memoryCache.clear();
        this.inFlight.clear();
    }
}

module.exports = new CacheService();