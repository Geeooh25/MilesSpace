// routes/admin/notificationsRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Notification Center API.
//
//   GET    /api/admin/notifications
//   GET    /api/admin/notifications/stats
//   GET    /api/admin/notifications/users/search
//   GET    /api/admin/notifications/:id
//   POST   /api/admin/notifications
//   PUT    /api/admin/notifications/:id/read
//   PUT    /api/admin/notifications/:id/unread
//   PUT    /api/admin/notifications/read-all
//   POST   /api/admin/notifications/bulk
//   PATCH  /api/admin/notifications/:id/archive
//   DELETE /api/admin/notifications/:id
//
// Literal paths are declared before /:id so they aren't captured.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const adminNotif = require('../../services/adminNotificationsService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function err(res, e) {
    if (res.headersSent) return;
    const status = e?.status || 500;
    if (status >= 500) console.error('[ADMIN NOTIFICATIONS]', e?.message || e);
    res.status(status).json({
        success: false,
        code: e?.code || 'NOTIFICATION_ERROR',
        error: e?.message || 'Notification request failed.'
    });
}
function adminId(req) { return req.adminContext?.id || null; }

// ─── List ────────────────────────────────────────────────────────

router.get(
    '/',
    requirePermission(PERMISSIONS.NOTIFICATIONS_READ),
    async (req, res) => {
        try {
            const result = await adminNotif.listNotifications({
                page: req.query.page,
                limit: req.query.limit,
                search: req.query.search,
                status: req.query.status,
                type: req.query.type,
                priority: req.query.priority,
                source: req.query.source,
                recipient_type: req.query.recipient_type,
                from: req.query.from,
                to: req.query.to,
                sort: req.query.sort,
                include_archived: req.query.include_archived
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Stats ───────────────────────────────────────────────────────

router.get(
    '/stats',
    requirePermission(PERMISSIONS.NOTIFICATIONS_READ),
    async (req, res) => {
        try {
            const result = await adminNotif.getStats({
                from: req.query.from || null,
                to: req.query.to || null
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── User search ─────────────────────────────────────────────────

router.get(
    '/users/search',
    requirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE),
    async (req, res) => {
        try {
            const result = await adminNotif.searchUsers(req.query.q, 20);
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Read all ────────────────────────────────────────────────────
// Must come BEFORE /:id routes.

router.put(
    '/read-all',
    requirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE),
    async (req, res) => {
        try {
            const result = await adminNotif.markAllRead(adminId(req));
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Bulk ────────────────────────────────────────────────────────

router.post(
    '/bulk',
    requirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE),
    async (req, res) => {
        try {
            const { ids, action } = req.body || {};
            const result = await adminNotif.bulkAction({ ids, action, adminId: adminId(req) });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Create ──────────────────────────────────────────────────────
// Two shapes:
//   POST / with { recipient_type: 'admin' } → admin-only notification
//   POST / with { recipient_type: 'user', user_id } → user notification
//   POST / with { recipient_type: 'all' } → announcement fan-out
router.post(
    '/',
    requirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE),
    async (req, res) => {
        try {
            const body = req.body || {};
            const {
                title, message, type, priority, source,
                link, reference, icon,
                recipient_type, user_id,
                order_id, transaction_id, provider_reference, webhook_id,
                dedupe_key,
                send_email,                  // ← new: default true
                email_only                   // ← new: skip in-app when true
            } = body;

            if (!title || String(title).trim().length < 2) {
                const e = new Error('Title is required.'); e.status = 422; e.code = 'TITLE_REQUIRED'; throw e;
            }
            if (!message || String(message).trim().length < 2) {
                const e = new Error('Message is required.'); e.status = 422; e.code = 'MESSAGE_REQUIRED'; throw e;
            }

            const raw = String(recipient_type || 'admin').toLowerCase();
            // Accept 'both' in addition to the existing three modes.
            const allowed = ['admin', 'user', 'all', 'both'];
            const recipientType = allowed.includes(raw) ? raw : 'admin';

            // ─── 1. Persist via the existing in-app service ──────
            // For 'both', we persist to users via the in-app service
            // AND separately email both admins and users.
            let inAppResult = null;
            try {
                inAppResult = await adminNotif.sendToUsers({
                    title, message, type, priority, link, reference,
                    source: source || 'admin',
                    icon,
                    recipientType: recipientType === 'both' ? 'all' : recipientType,
                    userId: user_id,
                    orderId: order_id,
                    transactionId: transaction_id,
                    providerReference: provider_reference,
                    webhookId: webhook_id,
                    dedupeKey: dedupe_key,
                    createdBy: adminId(req)
                });
            } catch (e) {
                // In-app persistence failure should not block email.
                console.warn('[ADMIN NOTIFICATIONS] in-app persist failed:', e.message);
            }

            // ─── 2. Email fan-out (non-blocking) ─────────────────
            const shouldEmail = send_email !== false;
            let fanoutHandle = null;
            if (shouldEmail) {
                const { fanoutAsync } = require('../../services/notificationFanoutService');
                fanoutHandle = fanoutAsync({
                    recipientType,
                    userId: user_id || null,
                    title,
                    message,
                    type,
                    priority: priority || 'normal',
                    link: link || null,
                    reference: reference || null,
                    source: source || 'admin',
                    skipEmail: false
                });
            }

            // ─── 3. Respond immediately ─────────────────────────
            ok(res, {
                ...(inAppResult || {}),
                email: shouldEmail
                    ? { queued: true, mode: recipientType }
                    : { skipped: true },
                _fanout: fanoutHandle
            });
        } catch (e) { err(res, e); }
    }
);
// ─── Detail ──────────────────────────────────────────────────────

router.get(
    '/:id',
    requirePermission(PERMISSIONS.NOTIFICATIONS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await adminNotif.getNotification(req.params.id);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

// ─── Mark read ───────────────────────────────────────────────────

router.put(
    '/:id/read',
    requirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await adminNotif.markRead(req.params.id, adminId(req));
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

router.put(
    '/:id/unread',
    requirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await adminNotif.markUnread(req.params.id, adminId(req));
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Archive / Delete ────────────────────────────────────────────

router.patch(
    '/:id/archive',
    requirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await adminNotif.archive(req.params.id, adminId(req));
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await adminNotif.remove(req.params.id, adminId(req));
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

module.exports = router;