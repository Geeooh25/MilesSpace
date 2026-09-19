// services/idempotencyService.js
// Idempotency helper for all routes

const { supabaseAdmin } = require('../db/supabase');

const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000; // 24 hours

class IdempotencyService {
    
    /**
     * Check if request has been processed
     */
    static async check(userId, idempotencyKey, endpoint) {
        if (!idempotencyKey) return null;

        const { data, error } = await supabaseAdmin
            .from('idempotency_keys')
            .select('response, status, created_at, expires_at')
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .eq('endpoint', endpoint)
            .maybeSingle();

        if (error || !data) return null;

        // Check if expired
        if (data.expires_at && new Date(data.expires_at) < new Date()) {
            return null;
        }

        return data.response || { already_processed: true };
    }

    /**
     * Save idempotency key
     */
    static async save(userId, idempotencyKey, endpoint, response) {
        try {
            const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL);
            
            await supabaseAdmin
                .from('idempotency_keys')
                .insert({
                    user_id: userId,
                    idempotency_key: idempotencyKey,
                    endpoint: endpoint,
                    response: response,
                    status: 'completed',
                    created_at: new Date().toISOString(),
                    expires_at: expiresAt.toISOString()
                });
        } catch (error) {
            console.warn('Failed to save idempotency key:', error.message);
        }
    }

    /**
     * Generate idempotency key
     */
    static generateKey(prefix = '') {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 8);
        return `${prefix}-${timestamp}-${random}`.toUpperCase();
    }
}

module.exports = IdempotencyService;