// routes/admin/supportRoutes.js
//
// Mounted at /api/admin/support in server.js.
//
// Every route:
//   - authenticates the admin via adminAuth (DB role, session, permissions)
//   - checks a specific support permission
//   - calls services/supportService
//   - writes to admin_audit_logs on every mutation
//
// No JWT is decoded in this file.

'use strict';

const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const router = express.Router();

const support = require('../../services/supportService');
const { requireSupportPermission, SUPPORT_PERMISSIONS } = require('../../middleware/supportAuth');

// ─── Cloudinary (attachments) ───────────────────────────────────
const CLOUDINARY_ENABLED = Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);
if (CLOUDINARY_ENABLED) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}
function uploadToCloudinary(buffer, opts = {}) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'auto', folder: 'milesspace/support', ...opts },
            (err, r) => err ? reject(err) : resolve(r)
        );
        const readable = new Readable();
        readable.push(buffer);
        readable.push(null);
        readable.pipe(stream);
    });
}

const ALLOWED_MIME = new Set([
    'image/jpeg','image/png','image/gif','image/webp',
    'application/pdf','text/plain','text/csv'
]);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 3 },
    fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype))
});

// ─── Response helpers ───────────────────────────────────────────
function ok(res, payload) {
    if (!res.headersSent) res.json({ success: true, ...payload });
}
function fail(res, status, code, message, extra = {}) {
    if (res.headersSent) return;
    res.status(status).json({ success: false, error: message, code, ...extra });
}
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'SUPPORT_ERROR';
    const message = status >= 500 ? 'Something went wrong. Please try again.' : (err?.message || 'Request failed');
    if (status >= 500) console.error('[ADMIN SUPPORT]', code, err?.message);
    const body = { success: false, error: message, code };
    if (err?.allowed) body.allowed = err.allowed;
    res.status(status).json(body);
}

// ═══════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════
router.get(
    '/stats',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_READ),
    async (req, res) => {
        try {
            const stats = await support.getStats();
            ok(res, { data: stats });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
// TICKETS — LIST / DETAIL / MESSAGES / STATUS / ASSIGN / READ
// ═══════════════════════════════════════════════════════════════

router.get(
    '/tickets',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_READ),
    async (req, res) => {
        try {
            const result = await support.listTickets({
                page: req.query.page,
                limit: req.query.limit,
                status: req.query.status,
                priority: req.query.priority,
                category: req.query.category,
                assigned: req.query.assigned,
                search: req.query.search,
                sort: req.query.sort
            });
            ok(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/tickets/:id',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_READ),
    async (req, res) => {
        try {
            const result = await support.getTicket({ id: req.params.id, viewerId: req.support.adminId });
            ok(res, { data: { ...result.ticket, messages: result.messages } });
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/tickets/:id/messages',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_REPLY),
    upload.array('attachments', 3),
    async (req, res) => {
        try {
            const isInternal = req.body?.is_internal === true || req.body?.is_internal === 'true';
            const message = String(req.body?.message || '').trim();
            const files = req.files || [];

            const attachments = [];
            if (files.length && CLOUDINARY_ENABLED) {
                for (const f of files) {
                    try {
                        const r = await uploadToCloudinary(f.buffer, { folder: `milesspace/support/${req.params.id}` });
                        attachments.push({
                            url: r.secure_url, type: f.mimetype,
                            name: f.originalname, size: f.size,
                            public_id: r.public_id, resource_type: r.resource_type
                        });
                    } catch (e) {
                        console.warn('[ADMIN SUPPORT] upload failed:', e.message);
                    }
                }
            }

            const msg = await support.createMessage({
                ticketId: req.params.id,
                adminId: req.support.adminId,
                adminEmail: req.support.email,
                message, isInternal, attachments,
                req
            });
            ok(res, { data: msg });
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/tickets/:id/internal-note',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_INTERNAL_NOTE),
    upload.array('attachments', 3),
    async (req, res) => {
        try {
            const message = String(req.body?.message || '').trim();
            const files = req.files || [];
            const attachments = [];
            if (files.length && CLOUDINARY_ENABLED) {
                for (const f of files) {
                    try {
                        const r = await uploadToCloudinary(f.buffer, { folder: `milesspace/support/${req.params.id}/internal` });
                        attachments.push({ url: r.secure_url, type: f.mimetype, name: f.originalname, size: f.size, public_id: r.public_id, resource_type: r.resource_type });
                    } catch (_) {}
                }
            }
            const msg = await support.createMessage({
                ticketId: req.params.id,
                adminId: req.support.adminId,
                adminEmail: req.support.email,
                message, isInternal: true, attachments, req
            });
            ok(res, { data: msg });
        } catch (err) { sendErr(res, err); }
    }
);

router.patch(
    '/tickets/:id/status',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_CHANGE_STATUS),
    async (req, res) => {
        try {
            const result = await support.changeStatus({
                ticketId: req.params.id,
                nextStatus: String(req.body?.status || '').toLowerCase(),
                adminId: req.support.adminId,
                adminEmail: req.support.email,
                reason: req.body?.reason || null,
                req
            });
            ok(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/tickets/:id/assign',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_ASSIGN),
    async (req, res) => {
        try {
            const result = await support.assignTicket({
                ticketId: req.params.id,
                adminId: req.support.adminId,
                adminEmail: req.support.email,
                assignTo: req.body?.assigned_to || req.body?.admin_id,
                reason: req.body?.reason || null,
                req
            });
            ok(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/tickets/:id/close',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_CLOSE),
    async (req, res) => {
        try {
            const result = await support.changeStatus({
                ticketId: req.params.id, nextStatus: 'closed',
                adminId: req.support.adminId, adminEmail: req.support.email,
                reason: req.body?.reason || 'Closed by admin', req
            });
            ok(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/tickets/:id/reopen',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_REOPEN),
    async (req, res) => {
        try {
            const result = await support.changeStatus({
                ticketId: req.params.id, nextStatus: 'in_progress',
                adminId: req.support.adminId, adminEmail: req.support.email,
                reason: req.body?.reason || 'Reopened by admin', req
            });
            ok(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/tickets/:id/read',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_READ),
    async (req, res) => {
        // Read marking happens inside getTicket; this route exists so the
        // frontend can call it explicitly without a full reload.
        try {
            await support.getTicket({ id: req.params.id, viewerId: req.support.adminId });
            ok(res, { read: true });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
// CONVERSATIONS — thin aliases over tickets for the existing UI
// ═══════════════════════════════════════════════════════════════
router.get(
    '/conversations',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_READ),
    async (req, res) => {
        try {
            const result = await support.listTickets({
                page: req.query.page, limit: req.query.limit,
                status: req.query.status, priority: req.query.priority,
                search: req.query.search, sort: req.query.sort
            });
            ok(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
// AGENTS — assignable admins
// ═══════════════════════════════════════════════════════════════
router.get(
    '/admins',
    requireSupportPermission(SUPPORT_PERMISSIONS.SUPPORT_READ),
    async (req, res) => {
        try {
            const admins = await support.listAssignableAdmins();
            ok(res, { data: admins });
        } catch (err) { sendErr(res, err); }
    }
);

module.exports = router;