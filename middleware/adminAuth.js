// middleware/adminAuth.js
// ─────────────────────────────────────────────────────────────────
// SINGLE ADMIN AUTH AUTHORITY.
//
// Guarantees:
//   - Never trusts req.body.role / req.body.isAdmin / req.body.permission.
//   - Re-reads role from `profiles` on every request.
//   - Permission resolution is DB-authoritative and FAILS CLOSED:
//       * admin_permissions read error → 503, deny
//       * profiles read error          → 503, deny
//       * super_admin                  → ['*']
//       * every other role             → role defaults + overrides,
//         and if overrides cannot be read → 503, deny
//   - Session must match profiles.current_session_id AND be active
//     in user_sessions.
//   - Only super_admin gets the wildcard.
//
// Exports:
//   adminAuth
//   superAdminAuth
//   requirePermission(permission)
//   requireStepUpAuth (re-export)
//   requireSuperAdmin (alias for superAdminAuth)
//   recordAdminAction          — fire-and-forget audit
//   recordAdminActionStrict    — throws if audit insert fails
//   buildAdminContext
//   getClientIp
//   ADMIN_ROLES, ADMIN_ROLE_VALUES, PERMISSIONS, ROLE_PERMISSIONS
//   roleHasPermission, isAdminRole, safeAdminIdentity
//   can, canAny, canAll        — programmatic helpers
// ─────────────────────────────────────────────────────────────────

'use strict';

const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../db/supabase');
const { requireStepUpAuth } = require('./adminStepUp');

// ─── JWT secret ─────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error(
        'JWT_SECRET must be set and at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
}

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

// ─── Permission registry ────────────────────────────────────────
const PERMISSIONS = Object.freeze({
    DASHBOARD_READ:         'dashboard.read',

    USERS_READ:             'users.read',
    USERS_MANAGE:           'users.manage',
    USERS_SUSPEND:          'users.suspend',

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

    SYSTEM_HEALTH_READ:     'system.health.read',

    // Security
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

// ─── Role → default permissions (BASELINE — overridable) ───────
const ROLE_PERMISSIONS = Object.freeze({
    [ADMIN_ROLES.SUPER_ADMIN]: ['*'],

    [ADMIN_ROLES.ADMIN]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ, PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_SUSPEND,
        PERMISSIONS.WALLETS_READ,
        PERMISSIONS.TRANSACTIONS_READ, PERMISSIONS.TRANSACTIONS_RESOLVE,
        PERMISSIONS.DEPOSITS_READ, PERMISSIONS.DEPOSITS_RESOLVE,
        PERMISSIONS.CRYPTO_READ, PERMISSIONS.CRYPTO_RESOLVE,
        PERMISSIONS.FX_READ,
        PERMISSIONS.PROVIDERS_READ,
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
        PERMISSIONS.PROVIDERS_READ,
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
        PERMISSIONS.AUDIT_READ,
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

function getClientIp(req) {
    if (!req) return null;
    if (typeof req.ip === 'string' && req.ip) return req.ip;
    const fwd = req.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string') return fwd.split(',')[0].trim();
    return req.socket?.remoteAddress || null;
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

// ─── JWT verification (signature + expiry + type) ───────────────
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
    if (!decoded.sid) {
        const e = new Error('Invalid session. Please sign in again.');
        e.status = 401; e.code = 'INVALID_SESSION';
        throw e;
    }
    return decoded;
}

// ─── buildAdminContext — throws; never grants on uncertainty ────
async function buildAdminContext(req, requiredPermission) {
    const decoded = verifyAdminJwt(req);

    // 1. Read profile — fail closed on any DB error.
    let profile, profileErr;
    try {
        const result = await supabaseAdmin
            .from('profiles')
            .select([
                'id', 'email', 'username', 'role', 'status', 'deleted_at',
                'current_session_id', 'session_expires_at', 'session_created_at'
            ].join(', '))
            .eq('id', decoded.id)
            .maybeSingle();
        profile = result.data;
        profileErr = result.error;
    } catch (dbErr) {
        const e = new Error('Authentication service temporarily unavailable.');
        e.status = 503; e.code = 'AUTH_SERVICE_UNAVAILABLE';
        throw e;
    }
    if (profileErr) {
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

    // 2. Session must match the DB pointer.
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
        if (sess) {
            if (sess.revoked_at || sess.is_active === false) {
                const e = new Error('Your session has been revoked. Please sign in again.');
                e.status = 401; e.code = 'SESSION_REVOKED';
                throw e;
            }
            if (sess.expires_at && new Date(sess.expires_at) < new Date()) {
                const e = new Error('Your session has expired. Please sign in again.');
                e.status = 401; e.code = 'SESSION_EXPIRED';
                throw e;
            }
        }
    } catch (e) {
        if (e && e.status) throw e;
        const err = new Error('Authentication service temporarily unavailable.');
        err.status = 503; err.code = 'AUTH_SERVICE_UNAVAILABLE';
        throw err;
    }

    // 4. Role check.
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
        effective = new Set(defaults);

        let overrides, ovErr;
        try {
            const result = await supabaseAdmin
                .from('admin_permissions')
                .select('permission, granted')
                .eq('user_id', profile.id);
            overrides = result.data;
            ovErr = result.error;
        } catch (e) {
            const err = new Error('Permission service temporarily unavailable.');
            err.status = 503; err.code = 'PERMISSION_SERVICE_UNAVAILABLE';
            throw err;
        }
        if (ovErr) {
            // Any read error — DENY. No fallback to role defaults.
            const err = new Error('Permission service temporarily unavailable.');
            err.status = 503; err.code = 'PERMISSION_SERVICE_UNAVAILABLE';
            throw err;
        }

        for (const o of overrides || []) {
            if (o.granted) effective.add(o.permission);
            else effective.delete(o.permission);
        }
        effective = Array.from(effective);
    }

    // 6. Attach canonical context.
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
        authTime: new Date().toISOString()
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
    buildAdminContext(req, null)
        .then(() => next())
        .catch(err => sendAdminError(res, err));
}

function superAdminAuth(req, res, next) {
    buildAdminContext(req, null)
        .then(() => {
            if (!req.adminContext.isSuperAdmin) {
                return sendAdminError(res, {
                    status: 403,
                    code: 'SUPER_ADMIN_REQUIRED',
                    message: 'Super admin privileges required.'
                });
            }
            next();
        })
        .catch(err => sendAdminError(res, err));
}

// Alias — some callers import `requireSuperAdmin`.
const requireSuperAdmin = superAdminAuth;

function requirePermission(permission) {
    return (req, res, next) => {
        buildAdminContext(req, permission)
            .then(() => next())
            .catch(err => sendAdminError(res, err));
    };
}

// ─── Audit — fire-and-forget ────────────────────────────────────
async function recordAdminAction({
    adminId, action, targetType, targetId,
    before = null, after = null, reason = null, req = null
}) {
    try {
        if (!adminId || !action) return;
        await supabaseAdmin.from('admin_audit_logs').insert({
            admin_id: adminId,
            action: String(action).slice(0, 120),
            target_type: targetType ? String(targetType).slice(0, 80) : null,
            target_id: targetId ? String(targetId).slice(0, 120) : null,
            before: before || null,
            after: after || null,
            reason: reason ? String(reason).slice(0, 500) : null,
            ip_address: getClientIp(req),
            user_agent: req?.headers?.['user-agent'] || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[ADMIN AUDIT] Failed to record action:', e.message);
    }
}

// ─── Audit — strict (throws on failure) ─────────────────────────
async function recordAdminActionStrict(opts) {
    const { recordAdminActionStrict: impl } = require('./adminAuditStrict');
    return impl(opts);
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