// middleware/adminAuditStrict.js
// ─────────────────────────────────────────────────────────────────
// Strict audit writer. Throws if the audit row cannot be inserted,
// so money-moving / security-critical operations can abort.
//
// Delegates all writes to services/auditLogService.record() so the
// canonical scrubber, canonical action registry, and severity-merge
// rules are the single authority. This file never writes to
// admin_audit_logs directly.
//
// Also writes a matching `admin_security_events` row for
// security-relevant actions so the Security dashboard can read them
// without scanning the entire audit table. The security mirror is
// best-effort — the canonical record is admin_audit_logs.
//
// Exports:
//   recordAdminActionStrict(opts)
//   CRITICAL_ACTIONS
//   scrub(value)
// ─────────────────────────────────────────────────────────────────

'use strict';

const auditLog   = require('../services/auditLogService');
const auditActions = require('../services/auditActions');
const scrubber   = require('../services/auditScrubber');
const { supabaseAdmin } = require('../db/supabase');

// ─── Legacy alias set ───────────────────────────────────────────
// Old callers used uppercase names like 'WALLET_ADJUSTED'. The
// canonical registry uses lowercase dotted names like
// 'wallet.credit'. This map keeps old call sites working without
// duplicating the classification in two places.
const LEGACY_TO_CANONICAL = Object.freeze({
    'WALLET_ADJUSTED':               'wallet.credit',
    'WALLET_CREDITED':               'wallet.credit',
    'WALLET_DEBITED':                'wallet.debit',
    'REFUND_CREATED':                'transaction.refund',
    'REFUND_FAILED':                 'transaction.refund',
    'TRANSACTION_REVERSED':          'transaction.status_change',
    'ADMIN_CREATED':                 'admin.created',
    'ADMIN_DELETED':                 'admin.deleted',
    'ADMIN_SUSPENDED':               'admin.disabled',
    'ROLE_CHANGED':                  'admin.role_changed',
    'PERMISSION_GRANTED':            'admin.permission_granted',
    'PERMISSION_REVOKED':            'admin.permission_revoked',
    'PROVIDER_CREDENTIAL_CHANGED':   'provider.enabled',
    'PROVIDER_ENABLED':              'provider.enabled',
    'PROVIDER_DISABLED':             'provider.disabled',
    'FX_RATE_CHANGED':               'setting_change',
    'PRICE_CHANGED':                 'setting_change',
    'SETTINGS_CHANGED':              'setting_change',
    'SECURITY_SETTINGS_CHANGED':     'setting_change',
    'EMERGENCY_STOP_ENABLED':        'emergency.toggle',
    'EMERGENCY_STOP_DISABLED':       'emergency.toggle',
    'MFA_ENABLED':                   'admin.mfa_enabled',
    'MFA_DISABLED':                  'admin.mfa_disabled',
    'RECOVERY_CODES_REGENERATED':    'admin.recovery_codes_regenerated',
    'ADMIN_SESSION_REVOKED':         'admin.session_revoked',
    'ADMIN_LOGOUT_ALL':              'admin.session_revoked'
});

// CRITICAL_ACTIONS is kept exported for backwards compatibility.
// It is now derived from the canonical registry — do not edit here.
const CRITICAL_ACTIONS = new Set([
    ...auditActions.STRICT_ACTIONS,
    ...Object.keys(LEGACY_TO_CANONICAL)
]);

// Legacy alias for the scrub function — delegates to the canonical
// scrubber so callers do not bypass the registry.
function scrub(value, depth = 0) {
    return scrubber.scrub(value);
}

function safeString(v, max) {
    if (v == null) return null;
    return String(v).slice(0, max);
}

function resolveActionName(action) {
    const raw = String(action || '').trim();
    if (!raw) return raw;
    // Exact canonical match first.
    if (auditActions.isKnownAction(raw)) return raw;
    // Legacy uppercase alias.
    const legacy = LEGACY_TO_CANONICAL[raw.toUpperCase()];
    if (legacy) return legacy;
    // Unknown — return as-is. The service will reject it in
    // production; in dev it is classified by prefix rule.
    return raw;
}

function isSecurityAction(action) {
    const def = auditActions.getAction(action);
    if (!def) return false;
    return def.category === 'security'
        || def.category === 'permissions'
        || def.category === 'admin_management';
}

async function mirrorSecurityEvent({
    action, entryId,
    adminId, adminEmail,
    result, reason, severity,
    ip, requestId, sessionId,
    targetType, targetId
}) {
    try {
        await supabaseAdmin.from('admin_security_events').insert({
            audit_id:    entryId || null,
            admin_id:    adminId || null,
            admin_email: safeString(adminEmail, 255),
            action:      safeString(action, 120),
            severity:    severity || null,
            result:      result || 'success',
            reason:      safeString(reason, 500),
            ip_address:  safeString(ip, 64),
            request_id:  safeString(requestId, 80),
            session_id:  sessionId || null,
            target_type: safeString(targetType, 80),
            target_id:   safeString(targetId, 120),
            created_at:  new Date().toISOString()
        });
    } catch (e) {
        // Best-effort only. The audit row is already durable.
        // Suppress "table does not exist" so a fresh deploy that has
        // not yet run the admin_security_events migration does not
        // spam the logs.
        if (!/relation .* does not exist|42P01/.test(String(e.message))) {
            console.warn('[AUDIT-STRICT] security event write failed:', e.message);
        }
    }
}

/**
 * Insert an audit record atomically with the operation.
 * THROWS on failure — the caller must roll back.
 *
 * Accepts the legacy shape (uppercase action, `note` for request id)
 * as well as the new shape (canonical action, explicit correlation
 * id / failure code / duration / provider / operation / metadata).
 */
async function recordAdminActionStrict(opts) {
    const options = opts || {};
    const {
        adminId,
        action: rawAction,
        adminEmail = null,
        adminRole  = null,
        actorType  = null,

        targetType = null,
        targetId   = null,

        before = null,
        after  = null,

        reason    = null,
        adminNote = null,

        result     = 'success',
        failureCode = null,
        durationMs  = null,

        correlationId = null,
        requestId     = null,
        sessionId     = null,

        provider  = null,
        operation = null,
        metadata  = null,

        ip        = null,
        userAgent = null,
        location  = null,

        req = null
    } = options;

    if (!adminId || !rawAction) {
        const e = new Error('recordAdminActionStrict requires adminId and action');
        e.status = 500;
        e.code = 'AUDIT_CONFIG_ERROR';
        throw e;
    }

    const action = resolveActionName(rawAction);

    // Validate against the canonical registry. In production an
    // unregistered action is a hard failure so the registry stays
    // authoritative. Legacy uppercase names are resolved above, so
    // they pass this check.
    if (!auditActions.isKnownAction(action)) {
        const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
        if (isProd) {
            const e = new Error(`recordAdminActionStrict: unregistered action "${rawAction}".`);
            e.status = 500;
            e.code = 'AUDIT_ACTION_UNREGISTERED';
            throw e;
        }
        // In dev, allow the prefix classification to continue, but
        // warn so the developer adds it to the registry.
        console.warn(`[AUDIT-STRICT] action "${rawAction}" is not in the registry; recording under best-effort classification.`);
    }

    // Resolve request-scoped fields from the Express request when
    // the caller did not pass them explicitly.
    const ctx = req?.adminContext || null;
    const finalIp        = ip        || ctx?.ip        || getReqIp(req) || null;
    const finalUa        = userAgent || req?.headers?.['user-agent'] || null;
    const finalRequestId = requestId || req?.requestId || req?.headers?.['x-request-id'] || null;
    const finalSessionId = sessionId || ctx?.sessionId || null;
    const finalCorrId    = correlationId || req?.correlationId || null;

    const finalAdminEmail = adminEmail || ctx?.email || null;
    const finalAdminRole  = adminRole  || ctx?.role  || null;
    const finalActorType  = actorType  || (ctx ? 'admin' : 'system');

    let entryId;
    try {
        entryId = await auditLog.record({
            adminId,
            adminEmail: finalAdminEmail,
            adminRole:  finalAdminRole,
            actorType:  finalActorType,

            action,
            targetType,
            targetId,

            before,
            after,

            reason,
            adminNote,

            result,
            failureCode,
            durationMs,

            correlationId: finalCorrId,
            requestId:     finalRequestId,
            sessionId:     finalSessionId,

            provider,
            operation,
            metadata,

            ip: finalIp,
            userAgent: finalUa,
            location
        });
    } catch (e) {
        // Translate the service error into the strict contract.
        if (e.code === 'AUDIT_INSERT_FAILED'
            || e.code === 'AUDIT_ACTION_UNREGISTERED'
            || e.code === 'AUDIT_ACTION_REQUIRED') {
            console.error('[AUDIT-STRICT] insert failed:', e.message);
            const err = new Error('Audit log could not be written. The action was aborted.');
            err.status = 503;
            err.code = 'AUDIT_WRITE_FAILED';
            err.cause = e.message;
            throw err;
        }
        throw e;
    }

    // Mirror to admin_security_events for security-relevant actions.
    if (isSecurityAction(action)) {
        await mirrorSecurityEvent({
            action,
            entryId,
            adminId,
            adminEmail: finalAdminEmail,
            result,
            reason,
            severity: auditActions.getAction(action)?.severity || null,
            ip: finalIp,
            requestId: finalRequestId,
            sessionId: finalSessionId,
            targetType,
            targetId
        });
    }

    return entryId;
}

// ─── Request IP helper (local, so this file has no dependency on
//     adminAuth) ────────────────────────────────────────────────
function getReqIp(req) {
    if (!req) return null;
    const raw = (() => {
        if (typeof req.ip === 'string' && req.ip) return req.ip;
        const fwd = req.headers?.['x-forwarded-for'];
        if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
        return req.socket?.remoteAddress || null;
    })();
    if (!raw) return null;
    const normalized = raw.replace(/^::ffff:/, '');
    if (normalized === '::1' || normalized === '127.0.0.1' || normalized === 'localhost') return null;
    return raw;
}

module.exports = {
    recordAdminActionStrict,
    CRITICAL_ACTIONS,
    scrub
};