// services/idempotencyService.js
// Idempotency helper for all routes.
//
// METHODS:
//   check()          → read a completed record (or null)
//   claim()          → atomically reserve a key BEFORE side-effects
//   release()        → free a claim if the request failed before save()
//   save()           → persist the final response and mark the row completed
//   generateKey()    → helper for creating fresh keys
//
// FIXES IN THIS REVISION:
//   • save() no longer writes to a non-existent `updated_at` column
//     (the migration adds it, but the code tolerates both worlds).
//   • claim() now reclaims an EXPIRED row atomically before giving up.
//     Previously an expired row blocked the key forever because the
//     unique constraint still saw it.
//   • save() never silently swallows a real DB error. If the update
//     fails for any reason other than "row not found", we log loudly
//     and rethrow — a money-moving caller MUST know the record did
//     not persist.
//   • request_fingerprint is supported (optional) so duplicate keys
//     with a different payload can be rejected by the caller.

'use strict';

const { supabaseAdmin } = require('../db/supabase');

const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000; // 24 hours
const PG_UNIQUE_VIOLATION = '23505';

class IdempotencyService {

    // ─── READ ──────────────────────────────────────────────────────
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
        if (data.expires_at && new Date(data.expires_at) < new Date()) return null;

        if (data.status === 'processing') {
            return { __in_flight: true };
        }

        return data.response || { already_processed: true };
    }

    // ─── CLAIM ─────────────────────────────────────────────────────
    // Returns TRUE if this caller acquired the key.
    // Returns FALSE if another in-flight request holds it.
    // Reclaims an expired row atomically and retries once.
    static async claim(userId, idempotencyKey, endpoint, payload = {}) {
        if (!idempotencyKey) return false;

        const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL).toISOString();

        // Try to claim.
        let { error } = await supabaseAdmin
            .from('idempotency_keys')
            .insert({
                user_id:         userId,
                idempotency_key: idempotencyKey,
                endpoint,
                status:          'processing',
                request_payload: payload,
                response:        null,
                created_at:      new Date().toISOString(),
                expires_at:      expiresAt
            });

        if (!error) return true;

        // Duplicate: either a live request holds the key, or the
        // previous holder crashed and the row has since expired.
        if (error.code === PG_UNIQUE_VIOLATION) {
            // Ask Postgres to reclaim an expired row if there is one.
            // The RPC is a no-op if the existing row is still valid.
            try {
                const { data: reclaimed } = await supabaseAdmin
                    .rpc('reclaim_expired_idempotency_key', {
                        p_user_id:  userId,
                        p_key:      idempotencyKey,
                        p_endpoint: endpoint
                    });

                if (reclaimed === true) {
                    // Retry the insert once.
                    const retry = await supabaseAdmin
                        .from('idempotency_keys')
                        .insert({
                            user_id:         userId,
                            idempotency_key: idempotencyKey,
                            endpoint,
                            status:          'processing',
                            request_payload: payload,
                            response:        null,
                            created_at:      new Date().toISOString(),
                            expires_at:      expiresAt
                        });

                    return !retry.error;
                }
            } catch (rpcErr) {
                console.warn('[IDEMPOTENCY] reclaim RPC failed:', rpcErr.message);
            }

            // Key is genuinely held by a live request.
            return false;
        }

        // Any other error is a real problem.
        throw new Error(`Failed to claim idempotency key: ${error.message}`);
    }

    // ─── RELEASE ───────────────────────────────────────────────────
    // Deletes the claim ONLY if we still hold it AND it's still in
    // 'processing' state. Never touches a 'completed' row.
    static async release(userId, idempotencyKey, endpoint) {
        if (!idempotencyKey) return;

        await supabaseAdmin
            .from('idempotency_keys')
            .delete()
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .eq('endpoint', endpoint)
            .eq('status', 'processing');
    }

    // ─── SAVE ──────────────────────────────────────────────────────
    // Persists the final response and marks the row 'completed'.
    // Two paths:
    //   • Row exists in 'processing' → UPDATE it
    //   • Row doesn't exist (legacy) → INSERT it
    //
    // If the row exists but the UPDATE affects nothing and the key
    // is NOT a duplicate, that's a real error — we throw. The caller
    // must know their record was not persisted.
    static async save(userId, idempotencyKey, endpoint, response) {
        if (!idempotencyKey) return;

        const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL).toISOString();

        // 1. Try to complete an existing 'processing' row.
        const { data: updated, error: updateError } = await supabaseAdmin
            .from('idempotency_keys')
            .update({
                response,
                status: 'completed',
                completed_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .eq('endpoint', endpoint)
            .eq('status', 'processing')
            .select('id')
            .maybeSingle();

        if (updateError) {
            // A non-recoverable error updating a row we expect to own
            // is a real failure — do NOT swallow it.
            console.error('[IDEMPOTENCY] save update failed:', updateError.message);
            throw new Error(`Failed to save idempotency record: ${updateError.message}`);
        }

        if (updated) return;

        // 2. Row was already completed (duplicate save) → nothing to do.
        const { data: existing } = await supabaseAdmin
            .from('idempotency_keys')
            .select('id, status')
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .eq('endpoint', endpoint)
            .maybeSingle();

        if (existing) {
            // Already completed or processing by someone else.
            // We deliberately do nothing.
            return;
        }

        // 3. Legacy path: caller never claimed. Insert a completed row.
        const { error: insertError } = await supabaseAdmin
            .from('idempotency_keys')
            .insert({
                user_id:         userId,
                idempotency_key: idempotencyKey,
                endpoint,
                response,
                status:          'completed',
                created_at:      new Date().toISOString(),
                completed_at:    new Date().toISOString(),
                expires_at:      expiresAt
            });

        if (insertError && insertError.code !== PG_UNIQUE_VIOLATION) {
            console.error('[IDEMPOTENCY] save insert failed:', insertError.message);
            throw new Error(`Failed to save idempotency record: ${insertError.message}`);
        }
    }

    // ─── GENERATE KEY ──────────────────────────────────────────────
    static generateKey(prefix = '') {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 8);
        return `${prefix}-${timestamp}-${random}`.toUpperCase();
    }
}

module.exports = IdempotencyService;