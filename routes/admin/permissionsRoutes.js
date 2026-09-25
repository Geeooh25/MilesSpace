// routes/admin/permissionsRoutes.js
'use strict';
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const {
    requirePermission, PERMISSIONS, ROLE_PERMISSIONS, ADMIN_ROLE_VALUES, recordAdminActionStrict
} = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_PERMISSIONS = Array.from(new Set(Object.values(ROLE_PERMISSIONS).flat().filter(p => p !== '*'))).sort();

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function fail(res, status, code, message, extra = {}) { if (res.headersSent) return; res.status(status).json({ success: false, error: message, code, ...extra }); }

router.get('/permissions/registry', requirePermission(PERMISSIONS.ADMINS_READ), async (req, res) => {
    const roles = {};
    for (const role of ADMIN_ROLE_VALUES) roles[role] = ROLE_PERMISSIONS[role] || [];
    ok(res, { permissions: ALL_PERMISSIONS, roles });
});

router.get('/permissions/:userId', requirePermission(PERMISSIONS.ADMINS_READ), async (req, res, next) => {
    if (!UUID_RE.test(req.params.userId || '')) return next();
    const { data: profile, error } = await supabaseAdmin
        .from('profiles').select('id, email, username, role, status').eq('id', req.params.userId).maybeSingle();
    if (error || !profile) return fail(res, 404, 'ADMIN_NOT_FOUND', 'Admin not found.');
    if (!ADMIN_ROLE_VALUES.includes(profile.role)) return fail(res, 400, 'NOT_AN_ADMIN', 'That user is not an admin.');

    const roleDefaults = ROLE_PERMISSIONS[profile.role] || [];
    const isSuper = profile.role === 'super_admin';
    const { data: overrides } = await supabaseAdmin
        .from('admin_permissions')
        .select('permission, granted, reason, granted_by, created_at, updated_at')
        .eq('user_id', profile.id);
    const overrideMap = {};
    for (const o of overrides || []) overrideMap[o.permission] = o;
    const effective = new Set(isSuper ? ALL_PERMISSIONS : roleDefaults);
    if (!isSuper) for (const o of overrides || []) (o.granted ? effective.add(o.permission) : effective.delete(o.permission));

    ok(res, { admin: profile, isSuperAdmin: isSuper, permissions: ALL_PERMISSIONS, role_defaults: roleDefaults, overrides: overrideMap, effective: Array.from(effective).sort() });
});

router.put('/permissions/:userId',
    requirePermission(PERMISSIONS.ADMINS_MANAGE),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!UUID_RE.test(req.params.userId || '')) return next();
        const { permission, granted, reason } = req.body || {};
        if (!permission || typeof permission !== 'string') return fail(res, 422, 'PERMISSION_REQUIRED', 'A permission string is required.');
        if (!ALL_PERMISSIONS.includes(permission)) return fail(res, 422, 'UNKNOWN_PERMISSION', 'Unknown permission string.', { allowed: ALL_PERMISSIONS });
        if (typeof granted !== 'boolean') return fail(res, 422, 'GRANTED_REQUIRED', 'granted must be a boolean.');
        if (!reason || String(reason).trim().length < 4) return fail(res, 422, 'REASON_REQUIRED', 'A reason is required (min 4 chars).');
        if (req.params.userId === req.adminContext.id) return fail(res, 403, 'SELF_MODIFICATION_BLOCKED', 'You cannot modify your own permissions.');

        const { data: target } = await supabaseAdmin.from('profiles').select('id, email, username, role').eq('id', req.params.userId).maybeSingle();
        if (!target) return fail(res, 404, 'ADMIN_NOT_FOUND', 'Admin not found.');
        if (!ADMIN_ROLE_VALUES.includes(target.role)) return fail(res, 400, 'NOT_AN_ADMIN', 'That user is not an admin.');
        if (target.role === 'super_admin') return fail(res, 403, 'SUPER_ADMIN_PROTECTED', 'super_admin permissions are role-defined.');

        const { data: prior } = await supabaseAdmin
            .from('admin_permissions').select('granted, reason')
            .eq('user_id', target.id).eq('permission', permission).maybeSingle();

        const { error: upErr } = await supabaseAdmin
            .from('admin_permissions')
            .upsert({
                user_id: target.id, permission, granted,
                granted_by: req.adminContext.id,
                reason: String(reason).slice(0, 500),
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id,permission' });
        if (upErr) return fail(res, 500, 'PERMS_WRITE_ERROR', 'Failed to save permission.');

        try {
            await recordAdminActionStrict({
                adminId: req.adminContext.id, adminEmail: req.adminContext.email,
                action: granted ? 'PERMISSION_GRANTED' : 'PERMISSION_REVOKED',
                targetType: 'admin', targetId: target.id,
                before: prior || null, after: { permission, granted, reason },
                reason, req, severity: 'critical'
            });
        } catch (e) {
            return fail(res, 500, 'AUDIT_WRITE_FAILED', 'Permission saved but audit failed. Contact super admin.');
        }

        ok(res, { user_id: target.id, permission, granted, reason });
    });

module.exports = router;