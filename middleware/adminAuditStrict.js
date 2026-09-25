// middleware/adminAuditStrict.js
// ─────────────────────────────────────────────────────────────────
// Strict audit writer. Throws if the audit row cannot be inserted,
// so money-moving / security-critical operations can abort.
//
// Also writes a matching `admin_security_events` row for
// warning/critical actions so the Security dashboard can read them
// without scanning the entire audit table.
//
// Exports:
//   recordAdminActionStrict(opts)
//   CRITICAL_ACTIONS
//   scrub(value)
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

const CRITICAL_ACTIONS = new Set([
    'WALLET_ADJUSTED', 'WALLET_CREDITED', 'WALLET_DEBITED',
    'REFUND_CREATED', 'REFUND_FAILED', 'TRANSACTION_REVERSED',
    'ADMIN_CREATED', 'ADMIN_DELETED', 'ADMIN_SUSPENDED',
    'ROLE_CHANGED',
    'PERMISSION_GRANTED', 'PERMISSION_REVOKED',
    'PROVIDER_CREDENTIAL_CHANGED', 'PROVIDER_ENABLED', 'PROVIDER_DISABLED',
    'FX_RATE_CHANGED', 'PRICE_CHANGED',
    'SETTINGS_CHANGED', 'SECURITY_SETTINGS_CHANGED',
    'EMERGENCY_STOP_ENABLED', 'EMERGENCY_STOP_DISABLED',
    'MFA_ENABLED', 'MFA_DISABLED',
    'RECOVERY_CODES_REGENERATED',
    'ADMIN_SESSION_REVOKED', 'ADMIN_LOGOUT_ALL'
]);

const FORBIDDEN_KEYS = [
    'password', 'password_hash', 'token', 'access_token', 'refresh_token',
    'api_key', 'apikey', 'secret', 'webhook_secret',
    'mfa_secret', 'mfa_secret_encrypted',
    'mfa_pending_secret', 'mfa_pending_secret_encrypted',
    'mfa_recovery_codes_hash', 'recovery_codes',
    'private_key', 'authorization', 'cookie',
    'transaction_pin', 'pin', 'cvv', 'pan'
];

function scrub(value, depth = 0) {
    if (depth > 6) return '[depth-limit]';
    if (value == null) return value;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1));

    const clean = {};
    for (const [k, v] of Object.entries(value)) {
        const lower = k.toLowerCase();
        if (FORBIDDEN_KEYS.some(bad => lower.includes(bad))) {
            clean[k] = '[REDACTED]';
        } else if (v && typeof v === 'object') {
            clean[k] = scrub(v, depth + 1);
        } else {
            clean[k] = v;
        }
    }
    return clean;
}

function safeString(v, max) {
    if (v == null) return null;
    return String(v).slice(0, max);
}

/**
 * Insert an audit record atomically with the operation.
 * THROWS on failure — the caller must roll back.
 */
async function recordAdminActionStrict(opts) {
    const {
        adminId, action,
        adminEmail = null,
        targetType = null,
        targetId = null,
        before = null,
        after = null,
        reason = null,
        req = null,
        severity = CRITICAL_ACTIONS.has(String(action).toUpperCase()) ? 'critical' : 'info'
    } = opts || {};

    if (!adminId || !action) {
        const e = new Error('recordAdminActionStrict requires adminId and action');
        e.status = 500; e.code = 'AUDIT_CONFIG_ERROR';
        throw e;
    }

    const ip = req?.ip
        || req?.headers?.['x-forwarded-for']?.split?.(',')?.[0]?.trim?.()
        || null;
    const ua = req?.headers?.['user-agent'] || null;
    const reqId = req?.headers?.['x-request-id'] || req?.id || null;

    const payload = {
        admin_id: adminId,
        admin_email: safeString(adminEmail, 255),
        action: safeString(action, 120),
        target_type: safeString(targetType, 80),
        target_id: safeString(targetId, 120),
        before: scrub(before),
        after: scrub(after),
        reason: safeString(reason, 500),
        ip_address: safeString(ip, 64),
        user_agent: safeString(ua, 500),
        created_at: new Date().toISOString(),
        ...(reqId ? { note: `request_id=${safeString(reqId, 80)}` } : {})
    };

    const { error } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert(payload);

    if (error) {
        console.error('[AUDIT-STRICT] insert failed:', error.message);
        const e = new Error('Audit log could not be written. The action was aborted.');
        e.status = 500; e.code = 'AUDIT_WRITE_FAILED';
        e.cause = error;
        throw e;
    }

    if (severity === 'critical' || severity === 'warning') {
        // Best-effort sidecar write. Failure does not fail the primary.
        supabaseAdmin
            .from('admin_security_events')
            .insert({
                admin_id: adminId,
                admin_email: safeString(adminEmail, 255),
                event_type: safeString(action, 120),
                severity,
                detail: scrub({ targetType, targetId, before, after, reason }),
                ip_address: safeString(ip, 64),
                user_agent: safeString(ua, 500)
            })
            .then(() => {}, err => {
                console.warn('[AUDIT-STRICT] security event write failed:', err?.message);
            });
    }
}

module.exports = {
    recordAdminActionStrict,
    CRITICAL_ACTIONS,
    scrub
};