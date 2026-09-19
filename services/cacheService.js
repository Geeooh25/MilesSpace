// services/cacheService.js
// Production-oriented two-level cache:
// L1 = Node.js memory (RAM)
// L2 = Supabase system_cache
// Designed for reference data with stale-while-revalidate

const { supabaseAdmin } = require('../db/supabase');

class CacheService {
    constructor() {
        this.defaultTTL = 60;
        this.memoryCache = new Map();
        this.inFlight = new Map();
        this.cleanupInterval = null;
        this.cleanupRunning = false;
        this.maxMemoryEntries = 500;
        this.startCleanup();
    }

    // ─── MEMORY CACHE ─────────────────────────────────────────────────────

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

    // ─── SUPABASE CACHE ──────────────────────────────────────────────────

    async _supabaseGet(key, allowStale = false) {
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
            if (error || !data) return null;

            const expiresAt = new Date(data.expires_at).getTime();
            const expired = expiresAt <= Date.now();

            return {
                value: data.cache_value,
                expired,
                expiresAt,
                updatedAt: data.updated_at
            };

        } catch (error) {
            console.warn(`⚠️ Cache Supabase GET failed [${key}]:`, error.message);
            return null;
        }
    }

    // ─── PUBLIC METHODS ──────────────────────────────────────────────────

    async get(key) {
        const memory = this._memoryGet(key, false);
        if (memory) return memory.value;

        const database = await this._supabaseGet(key, false);
        if (!database) return null;

        const remainingMs = Math.max(1000, database.expiresAt - Date.now());
        this._memorySet(key, database.value, remainingMs / 1000);

        return database.value;
    }

    async getStale(key) {
        const memory = this._memoryGet(key, true);
        if (memory) return memory;

        return await this._supabaseGet(key, true);
    }

    async set(key, value, ttl = this.defaultTTL) {
        const ttlSeconds = Math.max(1, Number(ttl) || this.defaultTTL);
        this._memorySet(key, value, ttlSeconds);

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
                console.warn(`⚠️ Cache SET failed [${key}]:`, error.message);
                return null;
            }

            return data || null;

        } catch (error) {
            console.warn(`⚠️ Cache SET exception [${key}]:`, error.message);
            return null;
        }
    }

    async delete(key) {
        this._memoryDelete(key);

        try {
            const { error } = await supabaseAdmin
                .from('system_cache')
                .delete()
                .eq('cache_key', key);

            if (error) {
                console.warn(`⚠️ Cache DELETE failed [${key}]:`, error.message);
                return false;
            }

            return true;

        } catch (error) {
            console.warn(`⚠️ Cache DELETE exception [${key}]:`, error.message);
            return false;
        }
    }

    async clear() {
        this.memoryCache.clear();

        try {
            const { error } = await supabaseAdmin
                .from('system_cache')
                .delete()
                .not('cache_key', 'is', null);

            if (error) {
                console.warn('⚠️ Cache CLEAR failed:', error.message);
                return false;
            }

            return true;

        } catch (error) {
            console.warn('⚠️ Cache CLEAR exception:', error.message);
            return false;
        }
    }

    async getStats() {
        try {
            const { data, error } = await supabaseAdmin
                .from('system_cache')
                .select('cache_key, expires_at, updated_at')
                .order('expires_at', { ascending: true });

            if (error) {
                console.warn('⚠️ Cache stats failed:', error.message);
                return null;
            }

            const now = Date.now();
            const items = data || [];

            return {
                total: items.length,
                expired: items.filter(item => new Date(item.expires_at).getTime() < now).length,
                valid: items.filter(item => new Date(item.expires_at).getTime() >= now).length,
                memoryEntries: this.memoryCache.size,
                items
            };

        } catch (error) {
            console.warn('⚠️ Cache stats exception:', error.message);
            return null;
        }
    }

    // ─── CLEANUP ──────────────────────────────────────────────────────────

    async cleanup() {
        if (this.cleanupRunning) {
            console.log('⏭️ Cache cleanup already running');
            return 0;
        }

        this.cleanupRunning = true;

        try {
            const now = new Date().toISOString();

            for (const [key, item] of this.memoryCache.entries()) {
                if (item.expiresAt <= Date.now()) {
                    this.memoryCache.delete(key);
                }
            }

            const { count, error } = await supabaseAdmin
                .from('system_cache')
                .delete({ count: 'exact' })
                .lt('expires_at', now);

            if (error) {
                console.warn('⚠️ Cache cleanup database error:', error.message);
                return 0;
            }

            const deleted = count || 0;
            if (deleted > 0) {
                console.log(`🧹 Cleaned ${deleted} expired cache entries`);
            }

            return deleted;

        } catch (error) {
            console.warn('⚠️ Cache cleanup exception:', error.message);
            return 0;

        } finally {
            this.cleanupRunning = false;
        }
    }

    // ─── GET OR SET WITH REQUEST COALESCING ─────────────────────────────

    async getOrSet(key, fetchFn, ttl = this.defaultTTL, options = {}) {
        const { allowStale = true, staleWhileRevalidate = false } = options;

        const fresh = await this.get(key);
        if (fresh !== null) return fresh;

        if (allowStale) {
            const stale = await this.getStale(key);
            if (stale?.value !== undefined) {
                if (staleWhileRevalidate) {
                    this._refreshInBackground(key, fetchFn, ttl);
                }
                return stale.value;
            }
        }

        if (this.inFlight.has(key)) {
            return await this.inFlight.get(key);
        }

        const promise = (async () => {
            try {
                console.log(`📡 Cache miss: ${key}, fetching...`);
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

    // ─── BACKGROUND REFRESH ──────────────────────────────────────────────

    _refreshInBackground(key, fetchFn, ttl) {
        if (this.inFlight.has(key)) return;

        const promise = (async () => {
            try {
                console.log(`🔄 Background cache refresh: ${key}`);
                const freshValue = await fetchFn();
                await this.set(key, freshValue, ttl);
            } catch (error) {
                console.warn(`⚠️ Background cache refresh failed [${key}]:`, error.message);
            } finally {
                this.inFlight.delete(key);
            }
        })();

        this.inFlight.set(key, promise);
    }

    // ─── SCHEDULER ──────────────────────────────────────────────────────

    startCleanup() {
        this.stopCleanup();

        this.cleanupInterval = setInterval(() => {
            this.cleanup().catch(error => {
                console.warn('⚠️ Cache cleanup scheduler error:', error.message);
            });
        }, 5 * 60 * 1000);

        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref();
        }

        console.log('🔄 Cache cleanup scheduler started (every 5 minutes)');
    }

    stopCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    destroy() {
        this.stopCleanup();
        this.memoryCache.clear();
        this.inFlight.clear();
        console.log('🛑 Cache service destroyed');
    }
}

module.exports = new CacheService();