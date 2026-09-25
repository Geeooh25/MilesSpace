// routes/admin/meRoutes.js
// GET /api/admin/me
//
// Returns the authenticated admin's identity and an effective
// permission map. The frontend uses this for UX only. Every API
// route still enforces its own permission via requirePermission().
//
// Response shape:
// {
//   success: true,
//   admin: { id, email, username, role, isSuperAdmin, session },
//   permissions: { DASHBOARD_READ: true, WALLETS_ADJUST: false, ... }
// }

'use strict';

const express = require('express');
const router = express.Router();
const { adminAuth } = require('../../middleware/adminAuth');
const { buildPermissionMap } = require('../../middleware/adminPermissions');

router.get(
    '/me',
    adminAuth,
    async (req, res) => {
        try {
            const ctx = req.adminContext;
            if (!ctx) {
                return res.status(401).json({
                    success: false,
                    error: 'Authentication required.',
                    code: 'AUTH_REQUIRED'
                });
            }

            // buildPermissionMap returns UPPER_SNAKE keys mapped to
            // booleans. It never returns the raw permission strings,
            // so the frontend cannot accidentally send them back and
            // expect server trust.
            const permissions = buildPermissionMap(ctx);

            res.json({
                success: true,
                admin: {
                    id: ctx.id,
                    email: ctx.email,
                    username: ctx.username,
                    role: ctx.role,
                    isSuperAdmin: !!ctx.isSuperAdmin,
                    session: {
                        id: ctx.sessionId,
                        authTime: ctx.authTime
                    }
                },
                permissions
            });
        } catch (err) {
            console.error('[ADMIN ME] error:', err.message);
            res.status(500).json({
                success: false,
                error: 'Failed to load admin identity.',
                code: 'ADMIN_ME_ERROR'
            });
        }
    }
);

module.exports = router;