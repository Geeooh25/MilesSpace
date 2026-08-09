// services/cacheService.js
const { supabaseAdmin } = require('../db/supabase');

class CacheService {
    constructor() {
        this.defaultTTL = 60; // 60 seconds default
        this.cleanupInterval = null;
        
        // Start cleanup job every 5 minutes
        this.startCleanup();
    }

    // Get cached value
    async get(key) {
        try {
            const { data, error } = await supabaseAdmin
                .from('system_cache')
                .select('cache_value')
                .eq('cache_key', key)
                .gte('expires_at', new Date().toISOString())
                .single();

            if (error || !data) {
                return null;
            }

            return data.cache_value;
        } catch (error) {
            console.error('Cache get error:', error);
            return null;
        }
    }

    // Set cache with TTL in seconds
    async set(key, value, ttl = this.defaultTTL) {
        try {
            const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
            
            const { data, error } = await supabaseAdmin
                .from('system_cache')
                .upsert({
                    cache_key: key,
                    cache_value: value,
                    expires_at: expiresAt,
                    updated_at: new Date().toISOString()
                }, {
                    onConflict: 'cache_key'
                })
                .select()
                .single();

            if (error) {
                console.error('Cache set error:', error);
                return null;
            }

            return data;
        } catch (error) {
            console.error('Cache set error:', error);
            return null;
        }
    }

    // Delete cache entry
    async delete(key) {
        try {
            const { error } = await supabaseAdmin
                .from('system_cache')
                .delete()
                .eq('cache_key', key);

            if (error) {
                console.error('Cache delete error:', error);
                return false;
            }

            return true;
        } catch (error) {
            console.error('Cache delete error:', error);
            return false;
        }
    }

    // Delete all cache entries
    async clear() {
        try {
            const { error } = await supabaseAdmin
                .from('system_cache')
                .delete()
                .neq('id', 0); // Delete all

            if (error) {
                console.error('Cache clear error:', error);
                return false;
            }

            return true;
        } catch (error) {
            console.error('Cache clear error:', error);
            return false;
        }
    }

    // Get cache statistics
    async getStats() {
        try {
            const { data, error } = await supabaseAdmin
                .from('system_cache')
                .select('cache_key, expires_at, updated_at')
                .order('expires_at', { ascending: true });

            if (error) {
                console.error('Cache stats error:', error);
                return null;
            }

            const now = new Date();
            const stats = {
                total: data.length,
                expired: data.filter(item => new Date(item.expires_at) < now).length,
                valid: data.filter(item => new Date(item.expires_at) >= now).length,
                items: data
            };

            return stats;
        } catch (error) {
            console.error('Cache stats error:', error);
            return null;
        }
    }

    // Cleanup expired entries
    async cleanup() {
        try {
            const { data, error } = await supabaseAdmin
                .from('system_cache')
                .delete()
                .lt('expires_at', new Date().toISOString())
                .select();

            if (error) {
                console.error('Cache cleanup error:', error);
                return 0;
            }

            const deleted = data?.length || 0;
            if (deleted > 0) {
                console.log(`🧹 Cleaned up ${deleted} expired cache entries`);
            }
            
            return deleted;
        } catch (error) {
            console.error('Cache cleanup error:', error);
            return 0;
        }
    }

    // Start automatic cleanup
    startCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        // Run cleanup every 5 minutes
        this.cleanupInterval = setInterval(async () => {
            await this.cleanup();
        }, 5 * 60 * 1000);
        
        console.log('🔄 Cache cleanup scheduler started (every 5 minutes)');
    }

    // Stop cleanup scheduler
    stopCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            console.log('🛑 Cache cleanup scheduler stopped');
        }
    }

    // Cache helper for API calls
    async getOrSet(key, fetchFn, ttl = this.defaultTTL) {
        try {
            // Try to get from cache first
            const cached = await this.get(key);
            if (cached !== null) {
                console.log(`📦 Cache hit: ${key}`);
                return cached;
            }

            // Fetch fresh data
            console.log(`📡 Cache miss: ${key}, fetching...`);
            const fresh = await fetchFn();
            
            // Store in cache
            await this.set(key, fresh, ttl);
            
            return fresh;
        } catch (error) {
            console.error(`Cache getOrSet error for ${key}:`, error);
            throw error;
        }
    }
}

// Create singleton instance
const cacheService = new CacheService();

module.exports = cacheService;