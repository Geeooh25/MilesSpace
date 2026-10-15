// middleware/adminAuth.js
// ─────────────────────────────────────────────────────────────────
// SINGLE ADMIN AUTH AUTHORITY.
//
// Guarantees:
//   • Never trusts req.body.role / req.body.isAdmin / req.body.permission.
//   • Re-reads role from `profiles` on every request.
//   • Permission resolution is DB-authoritative and FAILS CLOSED:
//       * admin_permissions read error → 503, deny
//       * profiles read error          → 503, deny
//       * super_admin                  → ['*']
//       * every other role             → role defaults + overrides,
//         and if overrides cannot be read → 503, deny
//   • Session must match profiles.current_session_id AND be active
//     in user_sessions.
//   • Only super_admin gets the wildcard.
//   • Audit is delegated to services/auditLogService — no direct
//     writes to admin_audit_logs from this file.
//   • `sid` on the JWT must be a UUID. A malformed sid is rejected
//     before any DB call.
//   • Every request gets a correlation id (from x-correlation-id
//     when provided, generated otherwise) so the audit chain can
//     be reassembled later.
//
// Exports:
//   adminAuth
//   superAdminAuth
//   requireSuperAdmin         — alias
//   requirePermission(permission)
//   requireStepUpAuth         — re-export from ./adminStepUp
//   recordAdminAction         — fire-and-forget audit
//   recordAdminActionStrict   — throws if audit insert fails
//   buildAdminContext
//   getClientIp
//   safeAdminIdentity
//   ADMIN_ROLES, ADMIN_ROLE_VALUES, PERMISSIONS, ROLE_PERMISSIONS
//   roleHasPermission, isAdminRole, can, canAny, canAll
// ─────────────────────────────────────────────────────────────────

'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const auditLog = require('../services/auditLogService');

// ─── Step-up (re-export) — guarded so a future signature change is caught ───
let requireStepUpAuth;
try {
    const stepUp = require('./adminStepUp');
    if (!stepUp || typeof stepUp.requireStepUpAuth !== 'function') {
        throw new Error('adminStepUp.js must export requireStepUpAuth as a function');
    }
    requireStepUpAuth = stepUp.requireStepUpAuth;
} catch (err) {
    // Do not crash on load — the middleware is only used by routes
    // that opt in. But make the failure loud so it is caught in CI.
    console.error('[ADMIN AUTH] requireStepUpAuth unavailable:', err.message);
    requireStepUpAuth = (req, res, next) => {
        const e = new Error('Step-up authentication is not configured on this server.');
        e.status = 503;
        e.code = 'STEP_UP_NOT_CONFIGURED';
        throw e;
    };
}

// ─── JWT secret ─────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error(
        'JWT_SECRET must be set and at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
}

// ─── UUID shape (session ids are uuid in this schema) ───────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Roles ──────────────────────────────────────────────────────
const ADMIN_ROLES = Object.freeze({
    SUPER_ADMIN: 'super_admin',
    ADMIN:       'admin',
    FINANCE:     'finance',
    OPERATIONS:  'operations',
    SUPPORT:     'support',
    AUDITOR:     'auditor',
    READ_ONLY:   'read_only'
});
const ADMIN_ROLE_VALUES = Object.freeze(Object.values(ADMIN_ROLES));

// ─── Permission registry (single definition per key) ────────────
const PERMISSIONS = Object.freeze({
    DASHBOARD_READ:         'dashboard.read',

    USERS_READ:             'users.read',
    USERS_MANAGE:           'users.manage',
    USERS_SUSPEND:          'users.suspend',
    USERS_SECURITY_READ:    'users.security.read',
    USERS_AUDIT_READ:       'users.audit.read',

    WALLETS_READ:           'wallets.read',
    WALLETS_ADJUST:         'wallets.adjust',

    TRANSACTIONS_READ:      'transactions.read',
    TRANSACTIONS_RESOLVE:   'transactions.resolve',
    TRANSACTIONS_REFUND:    'transactions.refund',

    DEPOSITS_READ:          'deposits.read',
    DEPOSITS_RESOLVE:       'deposits.resolve',

    CRYPTO_READ:            'crypto.read',
    CRYPTO_RESOLVE:         'crypto.resolve',

    FX_READ:                'fx.read',
    FX_MANAGE:              'fx.manage',

    PROVIDERS_READ:         'providers.read',
    PROVIDERS_MANAGE:       'providers.manage',
    PROVIDERS_TEST:         'providers.test',

    SERVICES_READ:          'services.read',
    SERVICES_MANAGE:        'services.manage',

    ORDERS_READ:            'orders.read',
    ORDERS_RESOLVE:         'orders.resolve',

    WEBHOOKS_READ:          'webhooks.read',
    WEBHOOKS_REPLAY:        'webhooks.replay',

    RECONCILIATION_READ:    'reconciliation.read',
    RECONCILIATION_RESOLVE: 'reconciliation.resolve',

    REPORTS_READ:           'reports.read',
    REPORTS_EXPORT:         'reports.export',

    NOTIFICATIONS_READ:     'notifications.read',
    NOTIFICATIONS_MANAGE:   'notifications.manage',

    SETTINGS_READ:          'settings.read',
    SETTINGS_MANAGE:        'settings.manage',

    ADMINS_READ:            'admins.read',
    ADMINS_MANAGE:          'admins.manage',

    AUDIT_READ:             'audit.read',
    AUDIT_EXPORT:           'audit.export',

    SYSTEM_HEALTH_READ:     'system.health.read',

    SECURITY_READ:          'security.read',
    SECURITY_MANAGE:        'security.manage',
    SESSIONS_READ:          'sessions.read',
    SESSIONS_REVOKE:        'sessions.revoke',

    // Support
    SUPPORT_READ:               'support.read',
    SUPPORT_REPLY:              'support.reply',
    SUPPORT_INTERNAL_NOTE:      'support.internal_note',
    SUPPORT_ASSIGN:             'support.assign',
    SUPPORT_CHANGE_STATUS:      'support.change_status',
    SUPPORT_CLOSE:              'support.close',
    SUPPORT_REOPEN:             'support.reopen',
    SUPPORT_ATTACHMENTS:        'support.attachments',
    SUPPORT_DELETE_ATTACHMENT:  'support.delete_attachment',
    SUPPORT_MANAGE_CATEGORIES:  'support.manage_categories',
    SUPPORT_VIEW_CUSTOMER:      'support.view_customer',
    SUPPORT_AUDIT_READ:         'support.audit.read'
});

// ─── Role → baseline permissions ────────────────────────────────
const ROLE_PERMISSIONS = Object.freeze({
    [ADMIN_ROLES.SUPER_ADMIN]: ['*'],

    [ADMIN_ROLES.ADMIN]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ, PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_SUSPEND,
        PERMISSIONS.USERS_SECURITY_READ, PERMISSIONS.USERS_AUDIT_READ,
        PERMISSIONS.WALLETS_READ,
        PERMISSIONS.TRANSACTIONS_READ, PERMISSIONS.TRANSACTIONS_RESOLVE,
        PERMISSIONS.DEPOSITS_READ, PERMISSIONS.DEPOSITS_RESOLVE,
        PERMISSIONS.CRYPTO_READ, PERMISSIONS.CRYPTO_RESOLVE,
        PERMISSIONS.FX_READ,
        PERMISSIONS.PROVIDERS_READ, PERMISSIONS.PROVIDERS_TEST,
        PERMISSIONS.SERVICES_READ, PERMISSIONS.SERVICES_MANAGE,
        PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDERS_RESOLVE,
        PERMISSIONS.WEBHOOKS_READ,
        PERMISSIONS.RECONCILIATION_READ,
        PERMISSIONS.REPORTS_READ, PERMISSIONS.REPORTS_EXPORT,
        PERMISSIONS.NOTIFICATIONS_READ, PERMISSIONS.NOTIFICATIONS_MANAGE,
        PERMISSIONS.SETTINGS_READ,
        PERMISSIONS.SYSTEM_HEALTH_READ,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ,
        PERMISSIONS.SUPPORT_REPLY,
        PERMISSIONS.SUPPORT_INTERNAL_NOTE,
        PERMISSIONS.SUPPORT_ASSIGN,
        PERMISSIONS.SUPPORT_CHANGE_STATUS,
        PERMISSIONS.SUPPORT_CLOSE,
        PERMISSIONS.SUPPORT_REOPEN,
        PERMISSIONS.SUPPORT_ATTACHMENTS,
        PERMISSIONS.SUPPORT_VIEW_CUSTOMER,
        PERMISSIONS.SUPPORT_AUDIT_READ
    ],

    [ADMIN_ROLES.FINANCE]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.WALLETS_READ, PERMISSIONS.WALLETS_ADJUST,
        PERMISSIONS.TRANSACTIONS_READ, PERMISSIONS.TRANSACTIONS_RESOLVE, PERMISSIONS.TRANSACTIONS_REFUND,
        PERMISSIONS.DEPOSITS_READ, PERMISSIONS.DEPOSITS_RESOLVE,
        PERMISSIONS.CRYPTO_READ, PERMISSIONS.CRYPTO_RESOLVE,
        PERMISSIONS.FX_READ, PERMISSIONS.FX_MANAGE,
        PERMISSIONS.RECONCILIATION_READ, PERMISSIONS.RECONCILIATION_RESOLVE,
        PERMISSIONS.REPORTS_READ, PERMISSIONS.REPORTS_EXPORT,
        PERMISSIONS.AUDIT_READ,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ,
        PERMISSIONS.SUPPORT_VIEW_CUSTOMER
    ],

    [ADMIN_ROLES.OPERATIONS]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.TRANSACTIONS_READ,
        PERMISSIONS.DEPOSITS_READ,
        PERMISSIONS.CRYPTO_READ,
        PERMISSIONS.PROVIDERS_READ, PERMISSIONS.PROVIDERS_TEST,
        PERMISSIONS.SERVICES_READ,
        PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDERS_RESOLVE,
        PERMISSIONS.WEBHOOKS_READ, PERMISSIONS.WEBHOOKS_REPLAY,
        PERMISSIONS.RECONCILIATION_READ,
        PERMISSIONS.REPORTS_READ,
        PERMISSIONS.SYSTEM_HEALTH_READ,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ,
        PERMISSIONS.SUPPORT_REPLY,
        PERMISSIONS.SUPPORT_INTERNAL_NOTE,
        PERMISSIONS.SUPPORT_ATTACHMENTS,
        PERMISSIONS.SUPPORT_VIEW_CUSTOMER
    ],

    [ADMIN_ROLES.SUPPORT]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.TRANSACTIONS_READ,
        PERMISSIONS.DEPOSITS_READ,
        PERMISSIONS.CRYPTO_READ,
        PERMISSIONS.ORDERS_READ,
        PERMISSIONS.NOTIFICATIONS_READ, PERMISSIONS.NOTIFICATIONS_MANAGE,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ,
        PERMISSIONS.SUPPORT_REPLY,
        PERMISSIONS.SUPPORT_INTERNAL_NOTE,
        PERMISSIONS.SUPPORT_CHANGE_STATUS,
        PERMISSIONS.SUPPORT_ASSIGN,
        PERMISSIONS.SUPPORT_CLOSE,
        PERMISSIONS.SUPPORT_REOPEN,
        PERMISSIONS.SUPPORT_ATTACHMENTS,
        PERMISSIONS.SUPPORT_VIEW_CUSTOMER
    ],

    [ADMIN_ROLES.AUDITOR]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.TRANSACTIONS_READ,
        PERMISSIONS.DEPOSITS_READ,
        PERMISSIONS.CRYPTO_READ,
        PERMISSIONS.RECONCILIATION_READ,
        PERMISSIONS.REPORTS_READ, PERMISSIONS.REPORTS_EXPORT,
        PERMISSIONS.AUDIT_READ, PERMISSIONS.AUDIT_EXPORT,
        PERMISSIONS.SYSTEM_HEALTH_READ,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ,
        PERMISSIONS.SUPPORT_AUDIT_READ
    ],

    [ADMIN_ROLES.READ_ONLY]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.TRANSACTIONS_READ,
        PERMISSIONS.DEPOSITS_READ,
        PERMISSIONS.CRYPTO_READ,
        PERMISSIONS.REPORTS_READ,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ
    ]
});

// ─── Small helpers ──────────────────────────────────────────────
function isAdminRole(role) {
    return ADMIN_ROLE_VALUES.includes(String(role || '').toLowerCase());
}

function roleHasPermission(role, permission) {
    const perms = ROLE_PERMISSIONS[role] || [];
    if (perms.includes('*')) return true;
    return perms.includes(permission);
}

// Normalize the client IP. If we only have a loopback address,
// returning null is more honest than persisting `::1`.
function getClientIp(req) {
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

function safeAdminIdentity(user) {
    if (!user) return null;
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        isAdmin: user.isAdmin,
        isSuperAdmin: user.isSuperAdmin
    };
}

// ─── Correlation id ─────────────────────────────────────────────
// Prefer an inbound x-correlation-id from the caller (for example
// an internal admin tool that already has one). Otherwise generate.
// Always set the response header so a browser devtools session can
// tie the request to the audit row.
function ensureCorrelationId(req, res) {
    const inbound = req.headers?.['x-correlation-id'];
    const corr = (typeof inbound === 'string' && inbound.trim())
        ? inbound.trim().slice(0, 80)
        : crypto.randomUUID();
    req.correlationId = corr;
    if (res && typeof res.setHeader === 'function' && !res.headersSent) {
        res.setHeader('X-Correlation-Id', corr);
    }
    return corr;
}

// ─── JWT verification (signature + expiry + type + sid shape) ───
function verifyAdminJwt(req) {
    const auth = req.headers?.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        const e = new Error('Authentication required.');
        e.status = 401; e.code = 'NO_TOKEN';
        throw e;
    }
    const token = auth.slice(7);
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        const expired = err.name === 'TokenExpiredError';
        const e = new Error(expired
            ? 'Your session has expired. Please sign in again.'
            : 'Invalid or expired token.');
        e.status = 401;
        e.code = expired ? 'SESSION_EXPIRED' : 'INVALID_TOKEN';
        throw e;
    }
    if (decoded.type !== 'admin') {
        const e = new Error('Admin access required.');
        e.status = 403; e.code = 'ADMIN_REQUIRED';
        throw e;
    }
    if (!decoded.id || typeof decoded.id !== 'string') {
        const e = new Error('Invalid session. Please sign in again.');
        e.status = 401; e.code = 'INVALID_SESSION';
        throw e;
    }
    if (!decoded.sid || typeof decoded.sid !== 'string' || !UUID_RE.test(decoded.sid)) {
        // Session ids are uuid in this schema. A malformed sid would
        // otherwise trigger a DB type error on the .eq('session_id', ...)
        // filter further down. Reject it here before any DB call.
        const e = new Error('Invalid session. Please sign in again.');
        e.status = 401; e.code = 'INVALID_SESSION';
        throw e;
    }
    return decoded;
}

// ─── buildAdminContext — throws on every failure ────────────────
async function buildAdminContext(req, requiredPermission) {
    const decoded = verifyAdminJwt(req);

    // Correlation id — always set before any further work so even a
    // rejected request is traceable.
    const correlationId = ensureCorrelationId(req, req.res);

    // 1. Read the profile. Any DB-level failure is a hard 503.
    let profile;
    try {
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select([
                'id', 'email', 'username', 'role', 'status', 'deleted_at',
                'current_session_id', 'session_expires_at', 'session_created_at'
            ].join(', '))
            .eq('id', decoded.id)
            .maybeSingle();
        if (error) {
            const e = new Error('Authentication service temporarily unavailable.');
            e.status = 503; e.code = 'AUTH_SERVICE_UNAVAILABLE';
            throw e;
        }
        profile = data;
    } catch (dbErr) {
        if (dbErr && dbErr.status) throw dbErr;
        const e = new Error('Authentication service temporarily unavailable.');
        e.status = 503; e.code = 'AUTH_SERVICE_UNAVAILABLE';
        throw e;
    }

    if (!profile) {
        const e = new Error('Admin profile not found.');
        e.status = 403; e.code = 'USER_NOT_FOUND';
        throw e;
    }
    if (profile.deleted_at) {
        const e = new Error('This admin account has been deleted.');
        e.status = 403; e.code = 'ACCOUNT_DELETED';
        throw e;
    }
    if (String(profile.status || '').toLowerCase() === 'suspended') {
        const e = new Error('This admin account has been suspended.');
        e.status = 403; e.code = 'ACCOUNT_SUSPENDED';
        throw e;
    }

    // 2. Session must match the DB pointer exactly.
    if (!profile.current_session_id || profile.current_session_id !== decoded.sid) {
        const e = new Error('Your session has been revoked. Please sign in again.');
        e.status = 401; e.code = 'SESSION_REVOKED';
        throw e;
    }
    if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
        const e = new Error('Your session has expired. Please sign in again.');
        e.status = 401; e.code = 'SESSION_EXPIRED';
        throw e;
    }

    // 3. Session must be active in user_sessions.
    try {
        const { data: sess, error: sessErr } = await supabaseAdmin
            .from('user_sessions')
            .select('is_active, revoked_at, expires_at')
            .eq('session_id', decoded.sid)
            .eq('user_id', profile.id)
            .maybeSingle();

        if (sessErr) {
            const e = new Error('Authentication service temporarily unavailable.');
            e.status = 503; e.code = 'AUTH_SERVICE_UNAVAILABLE';
            throw e;
        }
        if (!sess) {
            const e = new Error('Your session could not be found. Please sign in again.');
            e.status = 401; e.code = 'SESSION_NOT_FOUND';
            throw e;
        }
        if (sess.revoked_at || sess.is_active !== true) {
            const e = new Error('Your session has been revoked. Please sign in again.');
            e.status = 401; e.code = 'SESSION_REVOKED';
            throw e;
        }
        if (sess.expires_at && new Date(sess.expires_at) <= new Date()) {
            const e = new Error('Your session has expired. Please sign in again.');
            e.status = 401; e.code = 'SESSION_EXPIRED';
            throw e;
        }
    } catch (e) {
        if (e && e.status) throw e;
        const err = new Error('Authentication service temporarily unavailable.');
        err.status = 503; err.code = 'AUTH_SERVICE_UNAVAILABLE';
        throw err;
    }

    // 4. Role must be an admin role.
    const role = String(profile.role || '').toLowerCase();
    if (!isAdminRole(role)) {
        const e = new Error('Admin access required.');
        e.status = 403; e.code = 'ADMIN_REQUIRED';
        throw e;
    }

    // 5. Effective permissions — FAIL CLOSED.
    let effective;
    if (role === ADMIN_ROLES.SUPER_ADMIN) {
        effective = ['*'];
    } else {
        const defaults = ROLE_PERMISSIONS[role] || [];
        const merged = new Set(defaults);

        let overrides;
        try {
            const { data, error } = await supabaseAdmin
                .from('admin_permissions')
                .select('permission, granted')
                .eq('user_id', profile.id);
            if (error) {
                const e = new Error('Permission service temporarily unavailable.');
                e.status = 503; e.code = 'PERMISSION_SERVICE_UNAVAILABLE';
                throw e;
            }
            overrides = data || [];
        } catch (e) {
            if (e && e.status) throw e;
            const err = new Error('Permission service temporarily unavailable.');
            err.status = 503; err.code = 'PERMISSION_SERVICE_UNAVAILABLE';
            throw err;
        }

        for (const o of overrides) {
            if (o.granted) merged.add(o.permission);
            else merged.delete(o.permission);
        }
        effective = Array.from(merged);
    }

    // 6. Canonical context.
    req.user = req.user || {};
    req.user.id = profile.id;
    req.user.email = profile.email;
    req.user.username = profile.username;
    req.user.role = role;
    req.user.isAdmin = true;
    req.user.isSuperAdmin = role === ADMIN_ROLES.SUPER_ADMIN;
    req.user.session_id = decoded.sid;

    req.adminContext = {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        role,
        isSuperAdmin: role === ADMIN_ROLES.SUPER_ADMIN,
        permissions: effective,
        sessionId: decoded.sid,
        authTime: new Date().toISOString(),
        correlationId,
        ip: getClientIp(req)
    };

    // 7. Enforce permission if requested.
    if (requiredPermission) {
        const has = effective.includes('*') || effective.includes(requiredPermission);
        if (!has) {
            const e = new Error('You do not have permission to perform this action.');
            e.status = 403;
            e.code = 'PERMISSION_DENIED';
            e.required = requiredPermission;
            throw e;
        }
    }

    return req.adminContext;
}

// ─── Programmatic permission helpers ────────────────────────────
function can(ctx, permission) {
    if (!ctx) return false;
    if (ctx.isSuperAdmin) return true;
    if (!Array.isArray(ctx.permissions)) return false;
    if (ctx.permissions.includes('*')) return true;
    return ctx.permissions.includes(permission);
}
function canAny(ctx, perms) {
    return Array.isArray(perms) && perms.some(p => can(ctx, p));
}
function canAll(ctx, perms) {
    return Array.isArray(perms) && perms.every(p => can(ctx, p));
}

// ─── Error sender ───────────────────────────────────────────────
function sendAdminError(res, err) {
    const status = err?.status || 500;
    const code = err?.code || 'ADMIN_AUTH_ERROR';
    const message = err?.message || 'Admin authorization failed.';

    // Log security-relevant denials (4xx) at info level with the
    // required permission, and 5xx at error level. This is the
    // single line that shows up for every rejected admin request.
    if (status >= 500) {
        console.error('[ADMIN AUTH]', code, message);
    } else if (status === 401 || status === 403) {
        try {
            const adminId = err?.adminId || null;
            console.warn('[ADMIN AUTH DENIED]', code, err?.required ? `required=${err.required}` : '', adminId ? `admin=${adminId}` : '');
        } catch (_) { /* never throw from logging */ }
    }

    if (res && typeof res.status === 'function' && !res.headersSent) {
        return res.status(status).json({
            success: false,
            error: message,
            code,
            ...(err?.required ? { required: err.required } : {})
        });
    }
    console.error('[ADMIN AUTH] Unreported error:', code, message);
}

// ─── Middleware factories ───────────────────────────────────────
function adminAuth(req, res, next) {
    req.res = req.res || res;
    buildAdminContext(req, null)
        .then(() => next())
        .catch(err => sendAdminError(res, err));
}

function superAdminAuth(req, res, next) {
    req.res = req.res || res;
    buildAdminContext(req, null)
        .then(() => {
            if (!req.adminContext.isSuperAdmin) {
                return sendAdminError(res, {
                    status: 403,
                    code: 'SUPER_ADMIN_REQUIRED',
                    message: 'Super admin privileges required.',
                    adminId: req.adminContext.id
                });
            }
            next();
        })
        .catch(err => sendAdminError(res, err));
}

const requireSuperAdmin = superAdminAuth;

function requirePermission(permission) {
    return (req, res, next) => {
        req.res = req.res || res;
        buildAdminContext(req, permission)
            .then(() => next())
            .catch(err => sendAdminError(res, {
                ...err,
                adminId: err?.adminId || null
            }));
    };
}

// ─── Audit — fire-and-forget (delegated to auditLogService) ─────
async function recordAdminAction({
    adminId, adminEmail, adminRole, actorType,
    action, targetType, targetId,
    before = null, after = null, reason = null,
    adminNote = null, result = 'success',
    failureCode = null, durationMs = null,
    correlationId = null, requestId = null, sessionId = null,
    provider = null, operation = null, metadata = null,
    ip = null, userAgent = null, location = null,
    req = null
}) {
    if (!adminId || !action) return;
    try {
        await auditLog.record({
            adminId,
            adminEmail: adminEmail || req?.adminContext?.email || null,
            adminRole:  adminRole  || req?.adminContext?.role  || null,
            actorType:  actorType  || (req?.adminContext ? 'admin' : 'system'),

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

            correlationId: correlationId || req?.correlationId || null,
            requestId:     requestId     || req?.requestId || req?.headers?.['x-request-id'] || null,
            sessionId:     sessionId     || req?.adminContext?.sessionId || null,

            provider,
            operation,
            metadata,

            ip:        ip        || getClientIp(req),
            userAgent: userAgent || req?.headers?.['user-agent'] || null,
            location
        });
    } catch (e) {
        // Fire-and-forget: never break the request because audit
        // failed. Strict callers use recordAdminActionStrict.
        console.warn('[ADMIN AUDIT] Failed to record action:', e.message);
    }
}

// ─── Audit — strict (throws on failure) ─────────────────────────
async function recordAdminActionStrict(opts) {
    const mod = require('./adminAuditStrict');
    if (!mod || typeof mod.recordAdminActionStrict !== 'function') {
        const e = new Error('Audit strict middleware is not configured.');
        e.code = 'AUDIT_STRICT_NOT_CONFIGURED';
        e.status = 503;
        throw e;
    }
    return mod.recordAdminActionStrict(opts);
}

// ─── Exports ────────────────────────────────────────────────────
module.exports = {
    // middleware
    adminAuth,
    superAdminAuth,
    requireSuperAdmin,
    requirePermission,
    requireStepUpAuth,

    // audit
    recordAdminAction,
    recordAdminActionStrict,

    // context builders / helpers
    buildAdminContext,
    getClientIp,
    safeAdminIdentity,
    isAdminRole,
    roleHasPermission,
    can,
    canAny,
    canAll,

    // registries
    ADMIN_ROLES,
    ADMIN_ROLE_VALUES,
    PERMISSIONS,
    ROLE_PERMISSIONS
};