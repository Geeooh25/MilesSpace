// services/idempotencyService.js
// Idempotency helper for all money-moving routes.
//
// GUARANTEES:
//   • claim() is atomic. Only one caller acquires a key.
//   • check() verifies the request fingerprint when one is supplied,
//     so a reused key with a different payload is rejected — not
//     silently returned as the old result.
//   • release() deletes ONLY a still-'processing' row owned by the
//     caller. It NEVER touches a 'completed' row.
//   • save() persists the final response. If a completed row already
//     exists for the same key, it is left untouched (duplicate save).
//
// This file is NOT the sole protection against double credits.
// The unique index on `transactions.reference` is authoritative.
// Idempotency here is for returning the SAME response on retry.

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');

const IDEMPOTENCY_TTL    = 24 * 60 * 60 * 1000; // 24 hours
const PG_UNIQUE_VIOLATION = '23505';

// Stable fingerprint of an arbitrary JSON-serialisable payload.
// Order-independent, so {a:1,b:2} and {b:2,a:1} hash the same.
function stableHash(payload) {
    if (payload == null) return null;
    try {
        const sorted = JSON.stringify(payload, (k, v) => {
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                return Object.keys(v).sort().reduce((o, key) => { o[key] = v[key]; return o; }, {});
            }
            return v;
        });
        return crypto.createHash('sha256').update(sorted).digest('hex');
    } catch {
        return null;
    }
}

class IdempotencyService {

    // ─── READ ──────────────────────────────────────────────────
    // Returns:
    //   • null                        → no record
    //   • { __in_flight: true }       → another request holds the key
    //   • { already_processed: true } → completed but no response saved
    //   • response object             → cached success response
    //
    // If `expectedFingerprint` is provided, the stored fingerprint
    // MUST match, or this throws an idempotency conflict. This is
    // how a reused key with a different amount gets rejected.
    static async check(userId, idempotencyKey, endpoint, expectedFingerprint = null) {
        if (!idempotencyKey) return null;

        const { data, error } = await supabaseAdmin
            .from('idempotency_keys')
            .select('response, status, created_at, expires_at, request_fingerprint')
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .eq('endpoint', endpoint)
            .maybeSingle();

        if (error) {
            // A DB read failure is a real problem — don't pretend
            // there's no record and retry the operation blindly.
            console.error('[IDEMPOTENCY] check read failed:', error.message);
            throw new Error(`Idempotency check failed: ${error.message}`);
        }
        if (!data) return null;
        if (data.expires_at && new Date(data.expires_at) < new Date()) return null;

        if (data.status === 'processing') {
            return { __in_flight: true };
        }

        // If a fingerprint was supplied, the stored one must match.
        if (expectedFingerprint && data.request_fingerprint) {
            if (data.request_fingerprint !== expectedFingerprint) {
                throw new Error(
                    `Idempotency conflict: this key was already used with a different request payload.`
                );
            }
        }

        return data.response || { already_processed: true };
    }

    // ─── CLAIM ─────────────────────────────────────────────────
    // Returns true  → this caller owns the key.
    // Returns false → another live request holds the key.
    // Throws        → unexpected DB failure (must be surfaced).
    //
    // `payload`     = the operation parameters (for logging/audit).
    // `fingerprint` = stable hash of the operation (for conflict detection).
    // If `fingerprint` is omitted, one is derived from `payload`.
    static async claim(userId, idempotencyKey, endpoint, payload = {}, fingerprint = null) {
        if (!idempotencyKey) return false;

        const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL).toISOString();
        const fp = fingerprint || stableHash(payload);

        const row = {
            user_id:             userId,
            idempotency_key:     idempotencyKey,
            endpoint:            endpoint,
            status:              'processing',
            request_payload:     payload,
            request_fingerprint: fp,
            response:            null,
            created_at:          new Date().toISOString(),
            expires_at:          expiresAt
        };

        // First attempt.
        let { error } = await supabaseAdmin
            .from('idempotency_keys')
            .insert(row);

        if (!error) return true;

        // Duplicate key — either a live request holds it, or the
        // previous holder crashed and the row has since expired.
        if (error.code === PG_UNIQUE_VIOLATION) {

            // Look at the existing row to distinguish the two cases.
            const { data: existing, error: readErr } = await supabaseAdmin
                .from('idempotency_keys')
                .select('status, request_fingerprint, expires_at')
                .eq('user_id', userId)
                .eq('idempotency_key', idempotencyKey)
                .eq('endpoint', endpoint)
                .maybeSingle();

            if (readErr) {
                console.error('[IDEMPOTENCY] claim reread failed:', readErr.message);
                return false;
            }

            if (!existing) {
                // Row disappeared between insert and reread. Retry once.
                const retry = await supabaseAdmin.from('idempotency_keys').insert(row);
                return !retry.error;
            }

            // If a fingerprint was supplied and the existing one
            // doesn't match, this is a conflict, not a retry.
            if (fp && existing.request_fingerprint && existing.request_fingerprint !== fp) {
                throw new Error(
                    `Idempotency conflict: this key was already used with a different request payload.`
                );
            }

            // If the row is expired, reclaim it.
            const isExpired = existing.expires_at && new Date(existing.expires_at) < new Date();
            if (isExpired) {
                try {
                    const { data: reclaimed } = await supabaseAdmin
                        .rpc('reclaim_expired_idempotency_key', {
                            p_user_id:  userId,
                            p_key:      idempotencyKey,
                            p_endpoint: endpoint
                        });

                    if (reclaimed === true) {
                        const retry = await supabaseAdmin.from('idempotency_keys').insert(row);
                        return !retry.error;
                    }
                } catch (rpcErr) {
                    // Fall back to a plain UPDATE — reclaim is an
                    // optimization, not a requirement.
                    console.warn('[IDEMPOTENCY] reclaim RPC failed, using update fallback:', rpcErr.message);
                    const { error: delErr } = await supabaseAdmin
                        .from('idempotency_keys')
                        .delete()
                        .eq('user_id', userId)
                        .eq('idempotency_key', idempotencyKey)
                        .eq('endpoint', endpoint)
                        .lt('expires_at', new Date().toISOString());

                    if (!delErr) {
                        const retry = await supabaseAdmin.from('idempotency_keys').insert(row);
                        return !retry.error;
                    }
                }
            }

            // Live row exists. This caller does not own the key.
            return false;
        }

        console.error('[IDEMPOTENCY] claim failed:', error.message);
        throw new Error(`Failed to claim idempotency key: ${error.message}`);
    }

    // ─── RELEASE ───────────────────────────────────────────────
    // Deletes the claim ONLY if it is still 'processing'. Never
    // touches a 'completed' row — the money already moved.
    static async release(userId, idempotencyKey, endpoint) {
        if (!idempotencyKey) return;

        const { error } = await supabaseAdmin
            .from('idempotency_keys')
            .delete()
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .eq('endpoint', endpoint)
            .eq('status', 'processing');

        if (error) {
            console.warn('[IDEMPOTENCY] release failed:', error.message);
        }
    }

    // ─── SAVE ──────────────────────────────────────────────────
    // Persists the final response and marks the row 'completed'.
    //
    // Three paths:
    //   1. Row is 'processing'  → UPDATE it to 'completed'.
    //   2. Row is 'completed'   → already saved, no-op.
    //   3. No row (legacy)      → INSERT as 'completed'.
    //
    // Real DB errors are surfaced. A money-moving caller MUST know
    // that its response record did not persist — the ledger is the
    // authority, but the caller needs this for its return value.
    static async save(userId, idempotencyKey, endpoint, response) {
        if (!idempotencyKey) return;

        const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL).toISOString();

        // 1. Try to complete a row we own.
        const { data: updated, error: updateError } = await supabaseAdmin
            .from('idempotency_keys')
            .update({
                response:     response,
                status:       'completed',
                completed_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .eq('endpoint', endpoint)
            .eq('status', 'processing')
            .select('id')
            .maybeSingle();

        if (updateError) {
            console.error('[IDEMPOTENCY] save update failed:', updateError.message);
            throw new Error(`Failed to save idempotency record: ${updateError.message}`);
        }

        if (updated) return;

        // 2. Row is already 'completed' → nothing to do.
        const { data: existing, error: readErr } = await supabaseAdmin
            .from('idempotency_keys')
            .select('id, status')
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .eq('endpoint', endpoint)
            .maybeSingle();

        if (readErr) {
            console.error('[IDEMPOTENCY] save reread failed:', readErr.message);
            throw new Error(`Failed to verify idempotency record: ${readErr.message}`);
        }

        if (existing) return; // already completed (or held by another)

        // 3. Legacy path: insert a completed row.
        const { error: insertError } = await supabaseAdmin
            .from('idempotency_keys')
            .insert({
                user_id:         userId,
                idempotency_key: idempotencyKey,
                endpoint:        endpoint,
                response:        response,
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

    // ─── RECOVER ───────────────────────────────────────────────
    // Called by a money-moving caller AFTER a ledger operation has
    // succeeded but the idempotency row may be missing or stuck.
    // Looks up the existing ledger transaction by reference and
    // hydrates the idempotency row with its details so future
    // retries get the same response.
    //
    // This is what closes the crash window between ledger write
    // and idempotency save. It does NOT move money; it only reads
    // and records.
    static async recover(userId, idempotencyKey, endpoint, reference, expectedShape) {
        if (!idempotencyKey || !reference) return null;

        // Look up the idempotency row first.
        const { data: row } = await supabaseAdmin
            .from('idempotency_keys')
            .select('status, response')
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .eq('endpoint', endpoint)
            .maybeSingle();

        if (row && row.status === 'completed' && row.response) {
            return row.response;
        }

        // Look up the transaction by reference.
        const { data: tx, error: txErr } = await supabaseAdmin
            .from('transactions')
            .select('id, reference, amount, currency, type, user_id')
            .eq('reference', reference)
            .maybeSingle();

        if (txErr || !tx) return null;
        if (String(tx.user_id) !== String(userId)) return null;

        // Sanity: match the caller's expectation if provided.
        if (expectedShape) {
            if (expectedShape.amount != null &&
                Math.abs(Number(tx.amount) - Number(expectedShape.amount)) > 0.005) {
                return null;
            }
            if (expectedShape.currency &&
                String(tx.currency).toUpperCase() !== String(expectedShape.currency).toUpperCase()) {
                return null;
            }
        }

        const response = {
            success: true,
            recovered: true,
            transaction_id: tx.id,
            reference: tx.reference,
            amount: Number(tx.amount),
            currency: tx.currency
        };

        // Persist the recovered response so future retries hit the
        // cached path.
        try {
            const { error: updErr } = await supabaseAdmin
                .from('idempotency_keys')
                .update({
                    response:     response,
                    status:       'completed',
                    completed_at: new Date().toISOString()
                })
                .eq('user_id', userId)
                .eq('idempotency_key', idempotencyKey)
                .eq('endpoint', endpoint)
                .eq('status', 'processing');

            if (updErr) {
                console.warn('[IDEMPOTENCY] recover persist failed:', updErr.message);
            }
        } catch (e) {
            console.warn('[IDEMPOTENCY] recover persist threw:', e.message);
        }

        return response;
    }

    // ─── GENERATE KEY ──────────────────────────────────────────
    static generateKey(prefix = '') {
        const timestamp = Date.now().toString(36);
        const random = crypto.randomBytes(6).toString('hex');
        return `${prefix}-${timestamp}-${random}`.toUpperCase();
    }

    // ─── FINGERPRINT (exposed for callers) ─────────────────────
    static fingerprint(payload) {
        return stableHash(payload);
    }
}

module.exports = IdempotencyService;