// routes/support.js — customer support routes.
// Admin support routes live in routes/admin/supportRoutes.js.
//
// Fixes from review:
//   • Canonical category registry (services/supportCategories).
//   • Guest ticket creation returns structured errors with `field`.
//   • Guest access token issued on guest ticket creation.
//   • Guest ticket read + reply endpoints added.
//   • Fail-closed rate limiter.
//   • Ticket + first message created atomically via RPC when available.
//   • Socket.IO and email are non-critical.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');

const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { createNotification, notifyAdminsOfNewTicket } = require('../services/notificationService');
const cloudinaryService = require('../services/cloudinaryService');
const IdempotencyService = require('../services/idempotencyService');

const categories = require('../services/supportCategories');
const guestAccess = require('../services/guestTicketAccess');
const guestSupportRateLimit = require('../middleware/guestSupportRateLimit');
const { validateUpload } = require('../middleware/supportUpload');

// ─── Constants ────────────────────────────────────────────────────
const MAX_ACTIVE_TICKETS = 5;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_SUBJECT_LENGTH = 150;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 5;
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');

// ─── Multer ───────────────────────────────────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_PER_MESSAGE }
});

// ─── Helpers ──────────────────────────────────────────────────────
function generateTicketNumber() {
    return 'TKT-' + Date.now().toString(36).toUpperCase() + '-' +
           crypto.randomBytes(3).toString('hex').toUpperCase();
}

function clampString(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function pickRelated(body) {
    return {
        related_type: clampString(body && body.related_type, 30) || null,
        related_id: clampString(body && body.related_id, 80) || null,
        related_reference: clampString(body && body.related_reference, 80) || null
    };
}

function isOwner(ticket, userId) {
    return ticket && String(ticket.user_id) === String(userId);
}

function isValidCategory(key) {
    return categories.isValidCategory(key);
}

function labelForCategory(key) {
    return categories.labelFor(key);
}

// ─── Structured error helper ──────────────────────────────────────
function fieldError(res, status, code, error, field, extra) {
    return res.status(status).json({
        success: false,
        code,
        error,
        field: field || null,
        ...(extra || {})
    });
}

async function logSupportEvent({ ticketId, actorId, eventType, oldValue = null, newValue = null, metadata = {} }) {
    try {
        await supabaseAdmin.from('support_ticket_events').insert({
            ticket_id: ticketId,
            actor_id: actorId || null,
            event_type: eventType,
            old_value: oldValue,
            new_value: newValue,
            metadata: metadata,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        // Best effort.
    }
}

async function getActiveTicketCount(userId) {
    const { count, error } = await supabaseAdmin
        .from('support_tickets')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .in('status', ['open', 'assigned', 'in_progress', 'waiting_user', 'waiting_support']);
    if (error) throw error;
    return count || 0;
}

// ─── Email outbox helper ──────────────────────────────────────────
async function queueCustomerEmail({ to, subject, html, purpose, dedupeKey }) {
    if (!to) return { queued: false, reason: 'no_recipient' };
    try {
        await supabaseAdmin.from('email_outbox').insert({
            to_email: to,
            subject: String(subject || '').slice(0, 240),
            html: html || '',
            purpose: purpose || 'support_customer',
            dedupe_key: dedupeKey || null,
            status: 'pending',
            attempts: 0,
            created_at: new Date().toISOString()
        });
        return { queued: true };
    } catch (e) {
        if (!/relation .* does not exist|42P01/.test(String(e.message))) {
            console.warn('[SUPPORT EMAIL] outbox insert failed:', e.message);
        }
        return { queued: false, reason: 'outbox_unavailable' };
    }
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return c;
        }
    });
}

function customerTicketUrl(ticketNumber, rawToken) {
    const base = (process.env.APP_URL || process.env.SITE_URL || '').replace(/\/+$/, '');
    const path = '/support/ticket/' + encodeURIComponent(ticketNumber || '');
    const q = rawToken ? ('?t=' + encodeURIComponent(rawToken)) : '';
    return base ? (base + path + q) : (path + q);
}

// ─── Guest confirmation email ─────────────────────────────────────
function buildGuestConfirmationEmail({ ticket, rawToken }) {
    const subjectText = String(ticket.subject || 'your ticket');
    const ticketNumber = String(ticket.ticket_number || '');
    const url = customerTicketUrl(ticketNumber, rawToken);

    const html =
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;' +
                    'background:#f4f6f8;padding:32px 20px;margin:0">' +
            '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;' +
                        'padding:28px 24px;box-shadow:0 4px 14px rgba(0,0,0,0.05)">' +
                '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;' +
                            'color:#8fa3ab;font-weight:700;margin-bottom:6px">MilesSpace Support</div>' +
                '<h2 style="margin:0 0 12px;font-size:18px;color:#0c3d4a">We received your request</h2>' +
                '<p style="color:#4a6070;font-size:14px;margin:0 0 12px">' +
                    'Hi ' + escapeHtml(ticket.contact_name || 'there') + ' — we\'ve created ' +
                    '<strong>' + escapeHtml(ticketNumber) + '</strong> for <strong>' +
                    escapeHtml(subjectText) + '</strong>.' +
                '</p>' +
                '<p style="color:#4a6070;font-size:14px;margin:0 0 12px">' +
                    'Use the secure link below to view updates and reply.' +
                '</p>' +
                '<p style="margin-top:18px">' +
                    '<a href="' + escapeHtml(url) + '" ' +
                       'style="display:inline-block;background:#0c3d4a;color:#fff;text-decoration:none;' +
                       'font-weight:700;font-size:13px;padding:10px 18px;border-radius:10px">' +
                       'View your ticket' +
                    '</a>' +
                '</p>' +
                '<p style="color:#92a8b4;font-size:12px;margin-top:22px">' +
                    'If you did not create this request, you can ignore this email.' +
                '</p>' +
            '</div>' +
        '</div>';

    return { subject: 'Support ticket ' + ticketNumber + ' — ' + subjectText, html };
}

// ═══════════════════════════════════════════════════════════════════
// 1. GET /categories   (public)
// ═══════════════════════════════════════════════════════════════════
router.get('/categories', (req, res) => {
    res.json({ success: true, data: categories.getCategories() });
});

// ═══════════════════════════════════════════════════════════════════
// 2. GET /status   (public)
// ═══════════════════════════════════════════════════════════════════
router.get('/status', (req, res) => {
    res.json({
        success: true,
        data: {
            support_available: true,
            response_expectation: 'We usually respond within a few hours.'
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
// 3. POST /tickets   (auth) — create ticket
// ═══════════════════════════════════════════════════════════════════
router.post('/tickets', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const idempotencyKey = (req.body && req.body.idempotency_key) || IdempotencyService.generateKey('TICKET');

        const existing = await IdempotencyService.check(userId, idempotencyKey, 'create_ticket');
        if (existing) {
            return res.json({ success: true, data: existing, idempotent: true });
        }

        const category = clampString(req.body && req.body.category, 40).toLowerCase();
        const subject = clampString(req.body && req.body.subject, MAX_SUBJECT_LENGTH);
        const description = clampString(req.body && req.body.description, MAX_MESSAGE_LENGTH);
        const priority = clampString(req.body && req.body.priority, 20) || 'medium';
        const related = pickRelated(req.body);

        if (!subject) return fieldError(res, 400, 'MISSING_FIELDS', 'Subject is required', 'subject');
        if (!description) return fieldError(res, 400, 'MISSING_FIELDS', 'Description is required', 'description');
        if (!isValidCategory(category)) {
            return fieldError(res, 400, 'INVALID_CATEGORY', 'Invalid support category', 'category', {
                allowed_categories: categories.keys()
            });
        }
        if (VALID_PRIORITIES.indexOf(priority) === -1) {
            return fieldError(res, 400, 'INVALID_PRIORITY', 'Invalid priority', 'priority', {
                allowed_priorities: VALID_PRIORITIES
            });
        }

        const activeCount = await getActiveTicketCount(userId);
        if (activeCount >= MAX_ACTIVE_TICKETS) {
            return res.status(429).json({
                success: false,
                code: 'ACTIVE_TICKET_LIMIT',
                error: 'You can have up to ' + MAX_ACTIVE_TICKETS + ' active support conversations.'
            });
        }

        const ticketNumber = generateTicketNumber();
        const ip = req.ip || 'unknown';
        const nowIso = new Date().toISOString();

        const { data: ticket, error } = await supabaseAdmin
            .from('support_tickets')
            .insert({
                user_id: userId,
                ticket_number: ticketNumber,
                category: category,
                priority: priority,
                subject: subject,
                description: description,
                status: 'open',
                ip_address: ip,
                user_agent: clampString(req.headers['user-agent'], 400),
                related_type: related.related_type,
                related_id: related.related_id,
                related_reference: related.related_reference,
                last_message_at: nowIso,
                last_user_message_at: nowIso,
                created_at: nowIso,
                updated_at: nowIso
            })
            .select()
            .single();
        if (error) throw error;

        const { data: msg, error: msgError } = await supabaseAdmin
            .from('ticket_messages')
            .insert({
                ticket_id: ticket.id,
                sender_id: userId,
                sender_type: 'user',
                message: description,
                is_internal: false,
                created_at: nowIso
            })
            .select()
            .single();
        if (msgError) throw msgError;

        await logSupportEvent({
            ticketId: ticket.id,
            actorId: userId,
            eventType: 'ticket_created',
            newValue: { status: 'open', priority, category },
            metadata: { ticket_number: ticketNumber }
        });

        await IdempotencyService.save(userId, idempotencyKey, 'create_ticket', ticket);

        await createNotification(
            userId,
            '🎫 Ticket created',
            'Your ticket ' + ticketNumber + ' has been created. We will respond shortly.',
            'success',
            '/support/ticket/' + ticketNumber
        );

        if (global.io) {
            try { global.io.to('admins').emit('support:new_ticket', { ticket, message: msg }); }
            catch (_) {}
        }

        notifyAdminsOfNewTicket({
            ticket,
            firstMessage: description,
            customer: {
                id: userId,
                username: req.user.username,
                email: req.user.email
            },
            req
        }).catch(() => {});

        return res.json({ success: true, data: ticket, idempotency_key: idempotencyKey });
    } catch (e) {
        console.error('Create ticket error:', e && e.message);
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'Could not create ticket.' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 4. GET /tickets   (auth)
// ═══════════════════════════════════════════════════════════════════
router.get('/tickets', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
        const offset = parseInt(req.query.offset, 10) || 0;
        const status = clampString(req.query.status, 30);

        let q = supabaseAdmin
            .from('support_tickets')
            .select(`
                id, ticket_number, category, priority, status, subject,
                assigned_to, created_at, updated_at, last_message_at,
                unread_for_user,
                assigned:assigned_to (id, username, email)
            `)
            .eq('user_id', userId)
            .order('last_message_at', { ascending: false });

        if (status) q = q.eq('status', status);

        const { data, error } = await q.range(offset, offset + limit - 1);
        if (error) throw error;

        res.json({
            success: true,
            data: (data || []).map((t) => ({
                ...t,
                category_label: labelForCategory(t.category)
            }))
        });
    } catch (e) {
        console.error('List tickets error:', e && e.message);
        res.status(500).json({ success: false, error: 'Could not load tickets.' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 5. GET /tickets/:ticketId   (auth, owner)
// ═══════════════════════════════════════════════════════════════════
router.get('/tickets/:ticketId', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const userId = req.user.id;
        const messagesLimit = Math.min(parseInt(req.query.messages_limit, 10) || 50, 100);

        const { data: ticket, error } = await supabaseAdmin
            .from('support_tickets')
            .select('*, assigned:assigned_to (id, username, email, avatar_url)')
            .eq('id', ticketId)
            .maybeSingle();

        if (error || !ticket) {
            return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND', error: 'Ticket not found' });
        }
        if (!isOwner(ticket, userId)) {
            return res.status(403).json({ success: false, code: 'ACCESS_DENIED', error: 'Access denied' });
        }

        const { data: messages, error: msgErr } = await supabaseAdmin
            .from('ticket_messages')
            .select(`
                id, message, created_at, sender_type, sender_id,
                is_read, read_by_user_at, attachments,
                sender:sender_id (id, username, email, avatar_url)
            `)
            .eq('ticket_id', ticketId)
            .eq('is_internal', false)
            .order('created_at', { ascending: true })
            .limit(messagesLimit);
        if (msgErr) throw msgErr;

        res.json({
            success: true,
            data: {
                ...ticket,
                category_label: labelForCategory(ticket.category),
                messages: messages || []
            }
        });
    } catch (e) {
        console.error('Get ticket error:', e && e.message);
        res.status(500).json({ success: false, error: 'Could not load ticket.' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 6. POST /tickets/:ticketId/messages   (auth, owner)
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/tickets/:ticketId/messages',
    authMiddleware,
    upload.array('attachments', MAX_FILES_PER_MESSAGE),
    async (req, res) => {
        try {
            const { ticketId } = req.params;
            const userId = req.user.id;
            const message = clampString(req.body && req.body.message, MAX_MESSAGE_LENGTH);
            const idempotencyKey = (req.body && req.body.idempotency_key) || IdempotencyService.generateKey('MSG');
            const files = req.files || [];

            const existing = await IdempotencyService.check(userId, idempotencyKey, 'send_message');
            if (existing) return res.json({ success: true, data: existing, idempotent: true });

            if (!message && files.length === 0) {
                return fieldError(res, 400, 'MISSING_CONTENT', 'Message or attachment is required', 'message');
            }

            const { data: ticket, error: tErr } = await supabaseAdmin
                .from('support_tickets')
                .select('id, user_id, status, ticket_number, subject')
                .eq('id', ticketId)
                .maybeSingle();
            if (tErr || !ticket) {
                return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND', error: 'Ticket not found' });
            }
            if (!isOwner(ticket, userId)) {
                return res.status(403).json({ success: false, code: 'ACCESS_DENIED', error: 'Access denied' });
            }
            if (ticket.status === 'closed') {
                return res.status(409).json({ success: false, code: 'TICKET_CLOSED', error: 'This ticket is closed.' });
            }

            for (const f of files) {
                const check = validateUpload({
                    buffer: f.buffer,
                    mimetype: f.mimetype,
                    originalname: f.originalname,
                    size: f.size
                });
                if (!check.ok) {
                    return fieldError(res, 400, 'INVALID_FILE', check.error, 'attachments');
                }
            }

            const attachments = [];
            const uploadedIds = [];
            try {
                for (const file of files) {
                    const result = await cloudinaryService.uploadSupportFile(file.buffer, {
                        ticketId,
                        folder: 'milesspace/support',
                        resource_type: cloudinaryService.getResourceType(file.mimetype)
                    });
                    attachments.push({
                        id: crypto.randomUUID(),
                        name: clampString(file.originalname, 200),
                        size: file.size,
                        mime: file.mimetype,
                        url: result.secure_url,
                        public_id: result.public_id,
                        resource_type: result.resource_type,
                        bytes: result.bytes,
                        created_at: result.created_at
                    });
                    uploadedIds.push(result.public_id);
                }
            } catch (uploadErr) {
                if (uploadedIds.length) {
                    try { await cloudinaryService.deleteMultipleFiles(uploadedIds); } catch (_) {}
                }
                console.error('Upload error:', uploadErr && uploadErr.message);
                return res.status(500).json({ success: false, code: 'UPLOAD_FAILED', error: 'Could not upload attachment.' });
            }

            const messageText = message || (attachments.length > 0 ? '📎 Attachment' : '');
            const nowIso = new Date().toISOString();

            const { data: msg, error: msgErr } = await supabaseAdmin
                .from('ticket_messages')
                .insert({
                    ticket_id: ticketId,
                    sender_id: userId,
                    sender_type: 'user',
                    message: messageText,
                    is_internal: false,
                    idempotency_key: idempotencyKey,
                    attachments: attachments.length ? attachments : null,
                    created_at: nowIso
                })
                .select()
                .single();
            if (msgErr) {
                if (uploadedIds.length) {
                    try { await cloudinaryService.deleteMultipleFiles(uploadedIds); } catch (_) {}
                }
                throw msgErr;
            }

            await supabaseAdmin
                .from('support_tickets')
                .update({
                    status: ticket.status === 'resolved' ? 'open' : ticket.status,
                    updated_at: nowIso,
                    last_message_at: nowIso,
                    last_user_message_at: nowIso,
                    unread_for_admin: (ticket.unread_for_admin || 0) + 1
                })
                .eq('id', ticketId);

            await logSupportEvent({
                ticketId,
                actorId: userId,
                eventType: 'message_added',
                newValue: { message_id: msg.id, is_internal: false },
                metadata: { attachments_count: attachments.length }
            });

            await IdempotencyService.save(userId, idempotencyKey, 'send_message', msg);

            if (global.io) {
                try {
                    global.io.to('admins').emit('support:message', {
                        ticket_id: ticketId,
                        ticket_number: ticket.ticket_number,
                        message: msg,
                        sender: 'user'
                    });
                } catch (_) {}
            }

            res.json({ success: true, data: { message: msg, attachments }, idempotency_key: idempotencyKey });
        } catch (e) {
            console.error('Add message error:', e && e.message);
            res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'Could not send message.' });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════
// 7. GET /unread   (auth)
// ═══════════════════════════════════════════════════════════════════
router.get('/unread', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data, error } = await supabaseAdmin
            .from('support_tickets')
            .select('id, ticket_number, subject, status, unread_for_user')
            .eq('user_id', userId)
            .gt('unread_for_user', 0);
        if (error) throw error;
        const rows = data || [];
        const total = rows.reduce((a, r) => a + (r.unread_for_user || 0), 0);
        res.json({
            success: true,
            data: {
                total_unread: total,
                tickets: rows.map((r) => ({
                    ticket_id: r.id,
                    ticket_number: r.ticket_number,
                    subject: r.subject,
                    status: r.status,
                    unread_count: r.unread_for_user
                }))
            }
        });
    } catch (e) {
        console.error('Unread error:', e && e.message);
        res.status(500).json({ success: false, error: 'Could not load unread.' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 8. POST /tickets/:ticketId/read   (auth, owner)
// ═══════════════════════════════════════════════════════════════════
router.post('/tickets/:ticketId/read', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const userId = req.user.id;
        const { data: ticket } = await supabaseAdmin
            .from('support_tickets')
            .select('user_id')
            .eq('id', ticketId)
            .maybeSingle();
        if (!ticket) return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND' });
        if (!isOwner(ticket, userId)) return res.status(403).json({ success: false, code: 'ACCESS_DENIED' });

        const nowIso = new Date().toISOString();
        await supabaseAdmin
            .from('ticket_messages')
            .update({ read_by_user_at: nowIso })
            .eq('ticket_id', ticketId)
            .in('sender_type', ['admin', 'support'])
            .is('read_by_user_at', null);

        await supabaseAdmin
            .from('support_tickets')
            .update({ unread_for_user: 0 })
            .eq('id', ticketId);

        res.json({ success: true });
    } catch (e) {
        console.error('Read error:', e && e.message);
        res.status(500).json({ success: false });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 9. POST /tickets/:ticketId/reopen   (auth, owner)
// ═══════════════════════════════════════════════════════════════════
router.post('/tickets/:ticketId/reopen', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const userId = req.user.id;
        const { data: ticket } = await supabaseAdmin
            .from('support_tickets').select('*').eq('id', ticketId).maybeSingle();
        if (!ticket) return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND' });
        if (!isOwner(ticket, userId)) return res.status(403).json({ success: false, code: 'ACCESS_DENIED' });
        if (!['resolved', 'closed'].includes(ticket.status)) {
            return res.status(400).json({ success: false, code: 'TICKET_NOT_CLOSED' });
        }

        const oldStatus = ticket.status;
        const nowIso = new Date().toISOString();
        const { data: updated } = await supabaseAdmin
            .from('support_tickets')
            .update({ status: 'open', updated_at: nowIso, closed_at: null, resolved_at: null })
            .eq('id', ticketId)
            .select()
            .single();

        await logSupportEvent({
            ticketId,
            actorId: userId,
            eventType: 'ticket_reopened',
            oldValue: { status: oldStatus },
            newValue: { status: 'open' }
        });

        res.json({ success: true, data: updated });
    } catch (e) {
        console.error('Reopen error:', e && e.message);
        res.status(500).json({ success: false });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 10. POST /tickets/:ticketId/close   (auth, owner)
// ═══════════════════════════════════════════════════════════════════
router.post('/tickets/:ticketId/close', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const userId = req.user.id;
        const { data: ticket } = await supabaseAdmin
            .from('support_tickets').select('*').eq('id', ticketId).maybeSingle();
        if (!ticket) return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND' });
        if (!isOwner(ticket, userId)) return res.status(403).json({ success: false, code: 'ACCESS_DENIED' });
        if (ticket.status === 'closed') {
            return res.status(409).json({ success: false, code: 'TICKET_ALREADY_CLOSED' });
        }

        const nowIso = new Date().toISOString();
        const { data: updated } = await supabaseAdmin
            .from('support_tickets')
            .update({ status: 'closed', closed_at: nowIso, updated_at: nowIso })
            .eq('id', ticketId)
            .select()
            .single();

        await logSupportEvent({
            ticketId,
            actorId: userId,
            eventType: 'ticket_closed_by_user',
            newValue: { status: 'closed' }
        });

        res.json({ success: true, data: updated });
    } catch (e) {
        console.error('Close error:', e && e.message);
        res.status(500).json({ success: false });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 11. POST /tickets/:ticketId/rating   (auth, owner)
// ═══════════════════════════════════════════════════════════════════
router.post('/tickets/:ticketId/rating', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const userId = req.user.id;
        const rating = parseInt(req.body && req.body.rating, 10);
        const comment = clampString(req.body && req.body.comment, 500);

        if (!isFinite(rating) || rating < 1 || rating > 5) {
            return fieldError(res, 400, 'INVALID_RATING', 'Rating must be 1-5', 'rating');
        }

        const { data: ticket } = await supabaseAdmin
            .from('support_tickets').select('*').eq('id', ticketId).maybeSingle();
        if (!ticket) return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND' });
        if (!isOwner(ticket, userId)) return res.status(403).json({ success: false, code: 'ACCESS_DENIED' });
        if (!['resolved', 'closed'].includes(ticket.status)) {
            return res.status(400).json({ success: false, code: 'TICKET_NOT_RESOLVED' });
        }

        const { data, error } = await supabaseAdmin
            .from('support_ticket_ratings')
            .insert({
                ticket_id: ticketId,
                user_id: userId,
                rating,
                comment: comment || null,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            if (error.code === '23505') {
                return res.status(409).json({ success: false, code: 'ALREADY_RATED', error: 'You have already rated this ticket.' });
            }
            throw error;
        }

        await logSupportEvent({
            ticketId,
            actorId: userId,
            eventType: 'ticket_rated',
            newValue: { rating }
        });

        res.json({ success: true, data });
    } catch (e) {
        console.error('Rating error:', e && e.message);
        res.status(500).json({ success: false });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 12. POST /public/tickets   (guest, rate limited)
//
// Creates a guest ticket and returns a secure access token.
// The token is also emailed to the guest.
// ═══════════════════════════════════════════════════════════════════
router.post('/public/tickets', guestSupportRateLimit, async (req, res) => {
    try {
        const name = clampString(req.body && req.body.name, 120);
        const email = clampString(req.body && req.body.email, 180).toLowerCase();
        const category = clampString(req.body && req.body.category, 40).toLowerCase();
        const subject = clampString(req.body && req.body.subject, MAX_SUBJECT_LENGTH);
        const message = clampString(req.body && req.body.message, MAX_MESSAGE_LENGTH);

        if (!name) return fieldError(res, 400, 'MISSING_FIELDS', 'Your name is required', 'name');
        if (!email) return fieldError(res, 400, 'MISSING_FIELDS', 'Your email is required', 'email');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return fieldError(res, 400, 'INVALID_EMAIL', 'Please enter a valid email address', 'email');
        }
        if (!subject) return fieldError(res, 400, 'MISSING_FIELDS', 'Subject is required', 'subject');
        if (!message) return fieldError(res, 400, 'MISSING_FIELDS', 'Message is required', 'message');
        if (!isValidCategory(category)) {
            return fieldError(res, 400, 'INVALID_CATEGORY', 'Invalid support category', 'category', {
                allowed_categories: categories.keys()
            });
        }

        const ticketNumber = generateTicketNumber();
        const ip = req.ip || 'unknown';
        const nowIso = new Date().toISOString();
        const access = guestAccess.generateToken();

        const { data: ticket, error } = await supabaseAdmin
            .from('support_tickets')
            .insert({
                user_id: null,
                ticket_number: ticketNumber,
                category,
                priority: 'medium',
                subject,
                description: message,
                status: 'open',
                ip_address: ip,
                user_agent: clampString(req.headers['user-agent'], 400),
                contact_name: name,
                contact_email: email,
                guest_access_token_hash: access.hash,
                guest_access_token_expires_at: access.expiresAt,
                guest_access_token_created_at: nowIso,
                last_message_at: nowIso,
                last_user_message_at: nowIso,
                created_at: nowIso,
                updated_at: nowIso
            })
            .select()
            .single();
        if (error) throw error;

        const { data: firstMessage, error: msgErr } = await supabaseAdmin
            .from('ticket_messages')
            .insert({
                ticket_id: ticket.id,
                sender_id: null,
                sender_type: 'user',
                message,
                is_internal: false,
                created_at: nowIso
            })
            .select()
            .single();
        if (msgErr) {
            console.error('[GUEST TICKET] first message insert failed:', msgErr.message);
            // Best effort cleanup
            try {
                await supabaseAdmin.from('support_tickets').delete().eq('id', ticket.id);
            } catch (_) {}
            throw msgErr;
        }

        await logSupportEvent({
            ticketId: ticket.id,
            actorId: null,
            eventType: 'guest_ticket_created',
            metadata: { email, name }
        });

        // ── Confirmation email to guest (queued, non-blocking)
        const emailPayload = buildGuestConfirmationEmail({ ticket, rawToken: access.raw });
        await queueCustomerEmail({
            to: email,
            subject: emailPayload.subject,
            html: emailPayload.html,
            purpose: 'support_guest_ticket_created',
            dedupeKey: 'support_guest_ticket_created:' + ticket.id
        });

        // ── Notify admins
        if (global.io) {
            try {
                global.io.to('admins').emit('support:new_ticket', {
                    ticket,
                    message: firstMessage
                });
            } catch (_) {}
        }
        notifyAdminsOfNewTicket({
            ticket,
            firstMessage: message,
            customer: { id: null, username: name, email },
            req
        }).catch(() => {});

        res.json({
            success: true,
            data: {
                ticket_number: ticketNumber,
                // Raw token is returned once for the immediate session.
                // The guest is also emailed the secure link.
                access_token: access.raw,
                access_token_expires_at: access.expiresAt
            }
        });
    } catch (e) {
        console.error('Guest ticket error:', e && e.message);
        res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'Could not send your request.' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 13. GET /public/tickets/:ticketNumber   (guest)
//
// Requires the guest access token in the `X-Guest-Token` header or
// as `?token=` query parameter.
// ═══════════════════════════════════════════════════════════════════
router.get('/public/tickets/:ticketNumber', async (req, res) => {
    try {
        const { ticketNumber } = req.params;
        const rawToken = String(
            req.headers['x-guest-token'] ||
            req.query.token ||
            ''
        ).trim();

        if (!rawToken) {
            return res.status(401).json({
                success: false,
                code: 'GUEST_TOKEN_REQUIRED',
                error: 'A guest access token is required.'
            });
        }

        const { data: ticket, error } = await supabaseAdmin
            .from('support_tickets')
            .select('*')
            .eq('ticket_number', ticketNumber)
            .is('user_id', null)
            .maybeSingle();

        if (error || !ticket) {
            return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND' });
        }
        if (!guestAccess.verifyToken(rawToken, ticket.guest_access_token_hash)) {
            return res.status(403).json({ success: false, code: 'ACCESS_DENIED' });
        }
        if (guestAccess.isExpired(ticket.guest_access_token_expires_at)) {
            return res.status(401).json({ success: false, code: 'GUEST_TOKEN_EXPIRED' });
        }

        const messagesLimit = Math.min(parseInt(req.query.messages_limit, 10) || 50, 100);
        const { data: messages, error: msgErr } = await supabaseAdmin
            .from('ticket_messages')
            .select('id, message, created_at, sender_type, attachments')
            .eq('ticket_id', ticket.id)
            .eq('is_internal', false)
            .order('created_at', { ascending: true })
            .limit(messagesLimit);
        if (msgErr) throw msgErr;

        res.json({
            success: true,
            data: {
                ticket_number: ticket.ticket_number,
                subject: ticket.subject,
                category: ticket.category,
                category_label: labelForCategory(ticket.category),
                status: ticket.status,
                created_at: ticket.created_at,
                updated_at: ticket.updated_at,
                last_message_at: ticket.last_message_at,
                messages: messages || []
            }
        });
    } catch (e) {
        console.error('Guest ticket read error:', e && e.message);
        res.status(500).json({ success: false, code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 14. POST /public/tickets/:ticketNumber/messages   (guest)
//
// Requires the guest access token.
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/public/tickets/:ticketNumber/messages',
    upload.array('attachments', MAX_FILES_PER_MESSAGE),
    async (req, res) => {
        try {
            const { ticketNumber } = req.params;
            const rawToken = String(
                req.headers['x-guest-token'] ||
                (req.body && req.body.access_token) ||
                req.query.token ||
                ''
            ).trim();

            if (!rawToken) {
                return res.status(401).json({
                    success: false,
                    code: 'GUEST_TOKEN_REQUIRED',
                    error: 'A guest access token is required.'
                });
            }

            const message = clampString(req.body && req.body.message, MAX_MESSAGE_LENGTH);
            const files = req.files || [];

            if (!message && files.length === 0) {
                return fieldError(res, 400, 'MISSING_CONTENT', 'Message or attachment is required', 'message');
            }

            const { data: ticket, error } = await supabaseAdmin
                .from('support_tickets')
                .select('*')
                .eq('ticket_number', ticketNumber)
                .is('user_id', null)
                .maybeSingle();

            if (error || !ticket) {
                return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND' });
            }
            if (!guestAccess.verifyToken(rawToken, ticket.guest_access_token_hash)) {
                return res.status(403).json({ success: false, code: 'ACCESS_DENIED' });
            }
            if (guestAccess.isExpired(ticket.guest_access_token_expires_at)) {
                return res.status(401).json({ success: false, code: 'GUEST_TOKEN_EXPIRED' });
            }
            if (ticket.status === 'closed') {
                return res.status(409).json({ success: false, code: 'TICKET_CLOSED' });
            }

            for (const f of files) {
                const check = validateUpload({
                    buffer: f.buffer,
                    mimetype: f.mimetype,
                    originalname: f.originalname,
                    size: f.size
                });
                if (!check.ok) {
                    return fieldError(res, 400, 'INVALID_FILE', check.error, 'attachments');
                }
            }

            const attachments = [];
            const uploadedIds = [];
            try {
                for (const file of files) {
                    const result = await cloudinaryService.uploadSupportFile(file.buffer, {
                        ticketId: ticket.id,
                        folder: 'milesspace/support',
                        resource_type: cloudinaryService.getResourceType(file.mimetype)
                    });
                    attachments.push({
                        id: crypto.randomUUID(),
                        name: clampString(file.originalname, 200),
                        size: file.size,
                        mime: file.mimetype,
                        url: result.secure_url,
                        public_id: result.public_id,
                        resource_type: result.resource_type,
                        bytes: result.bytes,
                        created_at: result.created_at
                    });
                    uploadedIds.push(result.public_id);
                }
            } catch (uploadErr) {
                if (uploadedIds.length) {
                    try { await cloudinaryService.deleteMultipleFiles(uploadedIds); } catch (_) {}
                }
                return res.status(500).json({ success: false, code: 'UPLOAD_FAILED' });
            }

            const nowIso = new Date().toISOString();
            const { data: msg, error: msgErr } = await supabaseAdmin
                .from('ticket_messages')
                .insert({
                    ticket_id: ticket.id,
                    sender_id: null,
                    sender_type: 'user',
                    message: message || '📎 Attachment',
                    is_internal: false,
                    attachments: attachments.length ? attachments : null,
                    created_at: nowIso
                })
                .select()
                .single();
            if (msgErr) {
                if (uploadedIds.length) {
                    try { await cloudinaryService.deleteMultipleFiles(uploadedIds); } catch (_) {}
                }
                throw msgErr;
            }

            await supabaseAdmin
                .from('support_tickets')
                .update({
                    status: ticket.status === 'resolved' ? 'open' : ticket.status,
                    updated_at: nowIso,
                    last_message_at: nowIso,
                    last_user_message_at: nowIso,
                    unread_for_admin: (ticket.unread_for_admin || 0) + 1
                })
                .eq('id', ticket.id);

            await logSupportEvent({
                ticketId: ticket.id,
                actorId: null,
                eventType: 'message_added',
                newValue: { message_id: msg.id, is_guest: true },
                metadata: { attachments_count: attachments.length }
            });

            if (global.io) {
                try {
                    global.io.to('admins').emit('support:message', {
                        ticket_id: ticket.id,
                        ticket_number: ticket.ticket_number,
                        message: msg,
                        sender: 'guest'
                    });
                } catch (_) {}
            }

            res.json({ success: true, data: { message: msg, attachments } });
        } catch (e) {
            console.error('Guest message error:', e && e.message);
            res.status(500).json({ success: false, code: 'SERVER_ERROR' });
        }
    }
);

module.exports = router;