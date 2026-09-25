// middleware/supportAuth.js
//
// One authoritative middleware for /api/admin/support/*.
//
// It reuses the existing admin auth stack
// (middleware/adminAuth.js) so behaviour stays consistent with the
// rest of the admin panel:
//   - JWT signature/expiry
//   - DB role re-read (never trusts JWT role)
//   - session match (profiles.current_session_id)
//   - session active (user_sessions.is_active / revoked_at)
//   - permission resolution from admin_permissions, FAILS CLOSED
//
// On top of that it exposes helpers specific to support:
//   requireSupportPermission(permission)
//   requireSupportStepUp({ maxAgeSeconds })
//   attachSupportActor(req) → req.support = { adminId, email, role }

'use strict';

const {
    buildAdminContext,
    requirePermission,
    PERMISSIONS,
    adminAuth
} = require('./adminAuth');
const { requireStepUpAuth } = require('./adminStepUp');

// Support-specific permissions layered on the canonical permission
// registry. `adminAuth` reads the same DB tables for these, so they
// are treated identically to any other admin permission.
const SUPPORT_PERMISSIONS = Object.freeze({
    SUPPORT_READ:            'support.read',
    SUPPORT_REPLY:           'support.reply',
    SUPPORT_INTERNAL_NOTE:   'support.internal_note',
    SUPPORT_ASSIGN:          'support.assign',
    SUPPORT_CHANGE_STATUS:   'support.change_status',
    SUPPORT_CLOSE:           'support.close',
    SUPPORT_REOPEN:          'support.reopen',
    SUPPORT_ATTACHMENTS:     'support.attachments',
    SUPPORT_ATTACH_DELETE:   'support.delete_attachment',
    SUPPORT_MANAGE_CATEGORY: 'support.manage_categories',
    SUPPORT_VIEW_CUSTOMER:   'support.view_customer',
    SUPPORT_AUDIT_READ:      'support.audit.read'
});

/**
 * requireSupportPermission(permission)
 *   - auths the admin
 *   - checks the specific support permission
 *   - on failure returns 401 / 403 / 503 with a structured error
 */
function requireSupportPermission(permission) {
    if (!permission) {
        throw new Error('requireSupportPermission requires a permission string');
    }
    return async function supportPermissionMiddleware(req, res, next) {
        try {
            const ctx = await buildAdminContext(req, permission);
            req.support = {
                adminId: ctx.id,
                email:   ctx.email,
                role:    ctx.role,
                sessionId: ctx.sessionId
            };
            next();
        } catch (err) {
            const status = err?.status || 500;
            const code   = err?.code   || 'SUPPORT_AUTH_ERROR';
            const message = err?.message || 'Support authorization failed.';
            if (status >= 500) console.error('[SUPPORT AUTH]', code, message);
            if (!res.headersSent) {
                res.status(status).json({
                    success: false,
                    error: message,
                    code,
                    ...(err?.required ? { required: err.required } : {})
                });
            }
        }
    };
}

/**
 * requireSupportStepUp({ maxAgeSeconds })
 *   The caller must have recently verified MFA on the current session.
 *   Use for status changes to close/refund-adjacent actions.
 */
function requireSupportStepUp(options = {}) {
    return [
        adminAuth,
        requireStepUpAuth({ maxAgeSeconds: options.maxAgeSeconds || 300 })
    ];
}

module.exports = {
    requireSupportPermission,
    requireSupportStepUp,
    SUPPORT_PERMISSIONS,
    adminAuth,
    requirePermission,
    PERMISSIONS
};