// routes/admin/meRoutes.js
'use strict';
const express = require('express');
const router = express.Router();
const { adminAuth, PERMISSIONS } = require('../../middleware/adminAuth');
const { buildPermissionMap } = require('../../middleware/adminPermissions');
const { supabaseAdmin } = require('../../db/supabase');

router.get('/me', adminAuth, async (req, res) => {
    try {
        const ctx = req.adminContext;
        if (!ctx) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'AUTH_REQUIRED' });

        const permissions = buildPermissionMap
            ? buildPermissionMap(ctx)
            : Object.fromEntries(ctx.permissions.map(p => [p, true]));

        // Session MFA state
        let session = { id: ctx.sessionId, mfa_verified: false, mfa_verified_at: null };
        try {
            const { data } = await supabaseAdmin
                .from('user_sessions')
                .select('mfa_verified, mfa_verified_at, mfa_method')
                .eq('session_id', ctx.sessionId)
                .eq('user_id', ctx.id)
                .maybeSingle();
            if (data) {
                session.mfa_verified = !!data.mfa_verified;
                session.mfa_verified_at = data.mfa_verified_at;
                session.mfa_method = data.mfa_method;
            }
        } catch (_) {}

        res.json({
            success: true,
            // Legacy shape used by settings.html
            user: { id: ctx.id, email: ctx.email, username: ctx.username, role: ctx.role, isSuperAdmin: !!ctx.isSuperAdmin },
            isSuperAdmin: !!ctx.isSuperAdmin,
            admin: { id: ctx.id, email: ctx.email, username: ctx.username, role: ctx.role, isSuperAdmin: !!ctx.isSuperAdmin, session },
            permissions
        });
    } catch (err) {
        console.error('[ADMIN ME] error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load admin identity.', code: 'ADMIN_ME_ERROR' });
    }
});

module.exports = router;