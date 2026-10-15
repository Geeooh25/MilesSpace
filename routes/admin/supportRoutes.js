'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');

const support = require('../../services/supportService');
const supportNotifications = require('../../services/supportNotificationService');
const cloudinarySvc = require('../../services/cloudinaryService');
const { requirePermission, PERMISSIONS, getClientIp } = require('../../middleware/adminAuth');
const { validateBatch } = require('../../middleware/supportUpload');

// Fail-closed: if any of these files is missing, the server must
// not start. Optional UI helpers are fine to skip; security
// middleware is not.
if (typeof validateBatch !== 'function') {
    throw new Error('supportUpload.validateBatch is required');
}

const P = {
    READ:           PERMISSIONS.SUPPORT_READ,
    REPLY:          PERMISSIONS.SUPPORT_REPLY,
    INTERNAL_NOTE:  PERMISSIONS.SUPPORT_INTERNAL_NOTE,
    ASSIGN:         PERMISSIONS.SUPPORT_ASSIGN,
    CHANGE_STATUS:  PERMISSIONS.SUPPORT_CHANGE_STATUS,
    CLOSE:          PERMISSIONS.SUPPORT_CLOSE,
    REOPEN:         PERMISSIONS.SUPPORT_REOPEN,
    ATTACHMENTS:    PERMISSIONS.SUPPORT_ATTACHMENTS,
    AUDIT_READ:     PERMISSIONS.SUPPORT_AUDIT_READ
};
for (const [name, key] of Object.entries(P)) {
    if (!key) throw new Error(`Support permission key missing: ${name}`);
}

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}
router.use('/support', attachRequestId);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 5 }
});

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'SUPPORT_ERROR';
    const message = status >= 500 ? 'Something went wrong. Please try again.' : (err?.message || 'Request failed');
    if (status >= 500) console.error('[ADMIN SUPPORT]', code, err?.message);
    const body = { success: false, code, error: message };
    if (err?.current_version != null) body.current_version = err.current_version;
    if (Array.isArray(err?.allowed)) body.allowed = err.allowed;
    res.status(status).json(body);
}

// ─── STATS ────────────────────────────────────────────────────
router.get('/support/stats', requirePermission(P.READ), async (req, res) => {
    try { ok(res, { data: await support.getStats() }); }
    catch (e) { sendErr(res, e); }
});

// ─── LIST ─────────────────────────────────────────────────────
router.get('/support/tickets', requirePermission(P.READ), async (req, res) => {
    try {
        const result = await support.listTickets({
            page: req.query.page, limit: req.query.limit,
            status: req.query.status, priority: req.query.priority,
            category: req.query.category, assigned: req.query.assigned,
            search: req.query.search, sort: req.query.sort,
            viewerId: req.adminContext.id
        });
        ok(res, result);
    } catch (e) { sendErr(res, e); }
});

// ─── DETAIL ───────────────────────────────────────────────────
router.get('/support/tickets/:id', requirePermission(P.READ), async (req, res) => {
    try {
        const result = await support.getTicket({
            id: req.params.id,
            viewerId: req.adminContext.id,
            viewerIsAdmin: true
        });
        ok(res, { data: { ...result.ticket, messages: result.messages } });
    } catch (e) { sendErr(res, e); }
});

// ─── MARK READ ────────────────────────────────────────────────
router.post('/support/tickets/:id/read', requirePermission(P.READ), async (req, res) => {
    try {
        const result = await support.markRead({ ticketId: req.params.id });
        ok(res, result);
    } catch (e) { sendErr(res, e); }
});

// ─── MESSAGES ─────────────────────────────────────────────────
router.post(
    '/support/tickets/:id/messages',
    requirePermission(P.REPLY),
    upload.array('attachments', 5),
    async (req, res) => {
        try {
            const message = String(req.body?.message || '').trim().slice(0, 10000);
            const isInternal = req.body?.is_internal === true || req.body?.is_internal === 'true';
            const files = req.files || [];

            // Validate every file BEFORE uploading any of them.
            const batch = validateBatch(files.map(f => ({
                buffer: f.buffer,
                mimetype: f.mimetype,
                originalname: f.originalname,
                size: f.size
            })));
            if (!batch.ok) {
                return res.status(400).json({ success: false, code: 'INVALID_FILE', error: batch.error });
            }

            const uploadedIds = [];
            const attachments = [];
            try {
                for (const f of files) {
                    const result = await cloudinarySvc.uploadSupportFile(f.buffer, {
                        ticketId: req.params.id,
                        mimetype: f.mimetype,
                        originalname: f.originalname
                    });
                    uploadedIds.push(result.public_id);
                    attachments.push({
                        id: crypto.randomUUID(),
                        name: String(f.originalname || 'attachment').slice(0, 200),
                        size: f.size,
                        mime: f.mimetype,
                        url: result.secure_url,
                        public_id: result.public_id,
                        resource_type: result.resource_type,
                        bytes: result.bytes,
                        created_at: result.created_at
                    });
                }
            } catch (uploadErr) {
                // Roll back: delete whatever was uploaded.
                if (uploadedIds.length) {
                    await cloudinarySvc.deleteMultipleFiles(uploadedIds);
                }
                console.error('[ADMIN SUPPORT] upload failed:', uploadErr.message);
                return res.status(500).json({
                    success: false, code: 'UPLOAD_FAILED',
                    error: 'Could not upload attachment.'
                });
            }

            let msg;
            try {
                msg = await support.createMessage({
                    ticketId: req.params.id,
                    adminId: req.adminContext.id,
                    adminEmail: req.adminContext.email,
                    adminRole: req.adminContext.role,
                    message, isInternal,
                    attachments,
                    req
                });
            } catch (dbErr) {
                // If the DB write fails, clean up the files.
                if (uploadedIds.length) {
                    await cloudinarySvc.deleteMultipleFiles(uploadedIds);
                }
                throw dbErr;
            }

            // Fire-and-forget customer notification + email.
            try {
                const { data: ticket } = await require('../../db/supabase').supabaseAdmin
                    .from('support_tickets')
                    .select('id, user_id, ticket_number, subject, status')
                    .eq('id', req.params.id).maybeSingle();
                if (ticket && !isInternal) {
                    await supportNotifications.notifyCustomer({
                        event: 'ticket_reply',
                        ticket,
                        messageId: msg.id
                    });
                    await supportNotifications.queueCustomerEmail({
                        ticket,
                        messageBody: message,
                        event: 'ticket_reply',
                        adminName: req.adminContext.username,
                        dedupeExtra: msg.id
                    });
                }
            } catch (e) {
                console.warn('[ADMIN SUPPORT] notification best-effort failed:', e.message);
            }

            ok(res, { data: msg });
        } catch (e) { sendErr(res, e); }
    }
);

// ─── INTERNAL NOTE ────────────────────────────────────────────
router.post(
    '/support/tickets/:id/internal-note',
    requirePermission(P.INTERNAL_NOTE),
    upload.array('attachments', 5),
    async (req, res) => {
        try {
            const message = String(req.body?.message || '').trim().slice(0, 10000);
            const files = req.files || [];

            const batch = validateBatch(files.map(f => ({
                buffer: f.buffer,
                mimetype: f.mimetype,
                originalname: f.originalname,
                size: f.size
            })));
            if (!batch.ok) {
                return res.status(400).json({ success: false, code: 'INVALID_FILE', error: batch.error });
            }

            const uploadedIds = [];
            const attachments = [];
            try {
                for (const f of files) {
                    const result = await cloudinarySvc.uploadSupportFile(f.buffer, {
                        ticketId: req.params.id,
                        mimetype: f.mimetype,
                        originalname: f.originalname
                    });
                    uploadedIds.push(result.public_id);
                    attachments.push({
                        id: crypto.randomUUID(),
                        name: String(f.originalname || 'attachment').slice(0, 200),
                        size: f.size,
                        mime: f.mimetype,
                        url: result.secure_url,
                        public_id: result.public_id,
                        resource_type: result.resource_type,
                        bytes: result.bytes,
                        created_at: result.created_at
                    });
                }
            } catch (uploadErr) {
                if (uploadedIds.length) await cloudinarySvc.deleteMultipleFiles(uploadedIds);
                return res.status(500).json({ success: false, code: 'UPLOAD_FAILED' });
            }

            let msg;
            try {
                msg = await support.createMessage({
                    ticketId: req.params.id,
                    adminId: req.adminContext.id,
                    adminEmail: req.adminContext.email,
                    adminRole: req.adminContext.role,
                    message,
                    isInternal: true,
                    attachments,
                    req
                });
            } catch (dbErr) {
                if (uploadedIds.length) await cloudinarySvc.deleteMultipleFiles(uploadedIds);
                throw dbErr;
            }

            // Never notify the customer for an internal note.
            ok(res, { data: msg });
        } catch (e) { sendErr(res, e); }
    }
);

// ─── STATUS ───────────────────────────────────────────────────
const changeStatusHandler = async (req, res) => {
    try {
        const expected = Number.isFinite(Number(req.body?.expected_version))
            ? Number(req.body.expected_version)
            : null;
        const result = await support.changeStatus({
            ticketId: req.params.id,
            nextStatus: String(req.body?.status || '').toLowerCase(),
            adminId: req.adminContext.id,
            reason: req.body?.reason || null,
            expectedVersion: expected,
            req
        });
        // Notify the customer with the appropriate event.
        try {
            const { supabaseAdmin } = require('../../db/supabase');
            const { data: ticket } = await supabaseAdmin
                .from('support_tickets')
                .select('id, user_id, ticket_number, subject, status')
                .eq('id', req.params.id).maybeSingle();
            if (ticket) {
                const event = result.status === 'resolved' ? 'ticket_resolved'
                            : result.status === 'closed'   ? 'ticket_closed'
                            : null;
                if (event) {
                    await supportNotifications.notifyCustomer({ event, ticket });
                    await supportNotifications.queueCustomerEmail({ ticket, event });
                }
            }
        } catch (e) {
            console.warn('[ADMIN SUPPORT] status notify failed:', e.message);
        }
        ok(res, result);
    } catch (e) { sendErr(res, e); }
};
router.patch('/support/tickets/:id/status', requirePermission(P.CHANGE_STATUS), changeStatusHandler);
router.put(  '/support/tickets/:id/status', requirePermission(P.CHANGE_STATUS), changeStatusHandler);

// ─── ASSIGN ───────────────────────────────────────────────────
const assignHandler = async (req, res) => {
    try {
        const expected = Number.isFinite(Number(req.body?.expected_version))
            ? Number(req.body.expected_version)
            : null;
        const result = await support.assignTicket({
            ticketId: req.params.id,
            adminId: req.adminContext.id,
            assignTo: req.body?.assigned_to || req.body?.admin_id,
            reason: req.body?.reason || null,
            expectedVersion: expected,
            req
        });
        try {
            const { supabaseAdmin } = require('../../db/supabase');
            const { data: ticket } = await supabaseAdmin
                .from('support_tickets')
                .select('id, user_id, ticket_number, subject, status')
                .eq('id', req.params.id).maybeSingle();
            const { data: agent } = await supabaseAdmin
                .from('profiles').select('username').eq('id', result.assigned_to).maybeSingle();
            if (ticket) {
                await supportNotifications.notifyCustomer({
                    event: 'ticket_assigned',
                    ticket,
                    extra: { agentId: result.assigned_to, agentName: agent?.username }
                });
            }
        } catch (e) {
            console.warn('[ADMIN SUPPORT] assign notify failed:', e.message);
        }
        ok(res, result);
    } catch (e) { sendErr(res, e); }
};
router.post('/support/tickets/:id/assign', requirePermission(P.ASSIGN), assignHandler);
router.put( '/support/tickets/:id/assign', requirePermission(P.ASSIGN), assignHandler);

// ─── CLOSE / REOPEN ───────────────────────────────────────────
router.post('/support/tickets/:id/close', requirePermission(P.CLOSE), async (req, res) => {
    try {
        const result = await support.changeStatus({
            ticketId: req.params.id,
            nextStatus: 'closed',
            adminId: req.adminContext.id,
            reason: req.body?.reason || 'Closed by admin',
            req
        });
        try {
            const { supabaseAdmin } = require('../../db/supabase');
            const { data: ticket } = await supabaseAdmin
                .from('support_tickets')
                .select('id, user_id, ticket_number, subject, status')
                .eq('id', req.params.id).maybeSingle();
            if (ticket) {
                await supportNotifications.notifyCustomer({ event: 'ticket_closed', ticket });
                await supportNotifications.queueCustomerEmail({ ticket, event: 'ticket_closed' });
            }
        } catch (e) { console.warn('[ADMIN SUPPORT] close notify failed:', e.message); }
        ok(res, result);
    } catch (e) { sendErr(res, e); }
});

router.post('/support/tickets/:id/reopen', requirePermission(P.REOPEN), async (req, res) => {
    try {
        const result = await support.changeStatus({
            ticketId: req.params.id,
            nextStatus: 'in_progress',
            adminId: req.adminContext.id,
            reason: req.body?.reason || 'Reopened by admin',
            req
        });
        try {
            const { supabaseAdmin } = require('../../db/supabase');
            const { data: ticket } = await supabaseAdmin
                .from('support_tickets')
                .select('id, user_id, ticket_number, subject, status')
                .eq('id', req.params.id).maybeSingle();
            if (ticket) {
                await supportNotifications.notifyCustomer({ event: 'ticket_reopened', ticket });
                await supportNotifications.queueCustomerEmail({ ticket, event: 'ticket_reopened' });
            }
        } catch (e) { console.warn('[ADMIN SUPPORT] reopen notify failed:', e.message); }
        ok(res, result);
    } catch (e) { sendErr(res, e); }
});

// ─── ADMINS ───────────────────────────────────────────────────
router.get('/support/admins', requirePermission(P.READ), async (req, res) => {
    try { ok(res, { data: await support.listAssignableAdmins() }); }
    catch (e) { sendErr(res, e); }
});

module.exports = router;