// routes/messages.js — CUSTOMER side only.
// Admins use /api/admin/support (routes/admin/supportRoutes.js).
//
// Every route here is a customer route: it authenticates a customer
// via the existing authMiddleware (req.user set), and enforces that
// the caller owns the ticket/conversation they are touching.
//
// No JWT is decoded inside route handlers. No admin logic here.
// No admin secrets. No admin return shape.

'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

// ─── Cloudinary config (only if present) ───────────────────────
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
    console.log('✅ Cloudinary configured (customer chat)');
} else {
    console.warn('⚠️ Cloudinary not configured — customer attachments disabled');
}

function uploadToCloudinary(buffer, options = {}) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'auto', folder: 'milesspace/chat_attachments', ...options },
            (err, result) => err ? reject(err) : resolve(result)
        );
        const readable = new Readable();
        readable.push(buffer);
        readable.push(null);
        readable.pipe(stream);
    });
}

// ─── Multer: memory, strict limits ──────────────────────────────
const ALLOWED_MIME = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf', 'text/plain', 'text/csv'
]);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 3 },
    fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype))
});

// ─── Helpers ────────────────────────────────────────────────────
function newTicketNumber() {
    return `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function ok(res, payload) {
    if (res.headersSent) return;
    res.json({ success: true, ...payload });
}
function fail(res, status, code, message, extra = {}) {
    if (res.headersSent) return;
    res.status(status).json({ success: false, code, error: message, ...extra });
}

// Notifications written for the customer's own bell.
async function notifyUser(userId, title, message, type = 'info', link = null) {
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title,
            message,
            type,
            icon: type === 'success' ? '✅' : type === 'error' ? '❌' : '📌',
            link: link || null,
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[CUSTOMER MESSAGES] notify failed:', e.message);
    }
}

// ─── GET /categories ────────────────────────────────────────────
router.get('/categories', authMiddleware, async (req, res) => {
    try {
        const { data } = await supabaseAdmin
            .from('ticket_categories')
            .select('id, name, slug, description, sort_order')
            .eq('is_active', true)
            .order('sort_order', { ascending: true });
        ok(res, { data: data || [] });
    } catch (e) {
        fail(res, 500, 'CATEGORIES_FAILED', 'Failed to load categories');
    }
});

// ─── GET /stats ─────────────────────────────────────────────────
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: convos } = await supabaseAdmin
            .from('chat_conversations')
            .select('id, status, unread_count')
            .eq('user_id', userId);

        const stats = {
            total: convos?.length || 0,
            open: (convos || []).filter(c => c.status === 'open').length,
            closed: (convos || []).filter(c => c.status === 'closed').length,
            unread_messages: (convos || []).reduce((s, c) => s + (c.unread_count || 0), 0)
        };
        ok(res, { data: stats });
    } catch (e) {
        fail(res, 500, 'STATS_FAILED', 'Failed to load stats');
    }
});

// ─── GET /conversations ────────────────────────────────────────
router.get('/conversations', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = Math.min(Number(req.query.limit) || 50, 100);
        const offset = Math.max(Number(req.query.offset) || 0, 0);

        const { data, error } = await supabaseAdmin
            .from('chat_conversations')
            .select(`
                id, subject, status, unread_count, last_message, last_message_at,
                created_at, updated_at,
                messages:chat_messages (
                    id, message, created_at, sender_id, is_read,
                    attachment_url, attachment_type
                )
            `)
            .eq('user_id', userId)
            .order('last_message_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        const conversations = (data || []).map(c => ({
            ...c,
            unread_count: c.messages?.filter(m => !m.is_read && m.sender_id !== userId).length || 0,
            messages: (c.messages || []).slice(0, 1)
        }));

        ok(res, { data: conversations });
    } catch (e) {
        console.error('[CUSTOMER MESSAGES] conversations failed:', e.message);
        fail(res, 500, 'CONVERSATIONS_FAILED', 'Failed to load conversations');
    }
});

// ─── POST /conversations ───────────────────────────────────────
router.post('/conversations', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const subject = String(req.body?.subject || '').trim().slice(0, 200);
        const message = String(req.body?.message || '').trim().slice(0, 10000);
        const category = String(req.body?.category || 'general').toLowerCase().slice(0, 60);
        const priority = ['low','medium','high','urgent'].includes(String(req.body?.priority || '').toLowerCase())
            ? String(req.body.priority).toLowerCase()
            : 'medium';

        if (!subject || subject.length < 2) return fail(res, 422, 'SUBJECT_REQUIRED', 'Subject is required');
        if (!message || message.length < 2) return fail(res, 422, 'MESSAGE_REQUIRED', 'Message is required');

        const ticketNumber = newTicketNumber();
        const nowIso = new Date().toISOString();

        const { data: ticket, error: tErr } = await supabaseAdmin
            .from('support_tickets')
            .insert({
                user_id: userId,
                ticket_number: ticketNumber,
                category,
                priority,
                subject,
                description: message,
                status: 'open',
                ip_address: req.ip || req.socket?.remoteAddress || null,
                user_agent: req.headers['user-agent'] || null,
                created_at: nowIso
            })
            .select()
            .single();
        if (tErr) throw tErr;

        const { data: conversation, error: cErr } = await supabaseAdmin
            .from('chat_conversations')
            .insert({
                user_id: userId,
                subject,
                status: 'open',
                last_message: message,
                last_message_at: nowIso,
                unread_count: 1,
                created_at: nowIso
            })
            .select()
            .single();
        if (cErr) throw cErr;

        const { data: chatMessage, error: mErr } = await supabaseAdmin
            .from('chat_messages')
            .insert({
                conversation_id: conversation.id,
                sender_id: userId,
                message,
                is_read: false,
                created_at: nowIso
            })
            .select()
            .single();
        if (mErr) throw mErr;

        await notifyUser(userId, '🎫 Support Ticket Created', `Your ticket ${ticketNumber} has been created. We'll respond shortly.`, 'success', '/messages');

        if (global.io) {
            global.io.to('admins').emit('support:new_ticket', {
                id: ticket.id, ticket_number: ticketNumber, subject, priority, category, user_id: userId, created_at: ticket.created_at
            });
        }

        ok(res, { data: { ticket, conversation, message: chatMessage } });
    } catch (e) {
        console.error('[CUSTOMER MESSAGES] create failed:', e.message);
        fail(res, 500, 'CREATE_FAILED', 'Failed to create conversation');
    }
});

// ─── GET /conversations/:id/messages ────────────────────────────
router.get('/conversations/:id/messages', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const limit = Math.min(Number(req.query.limit) || 100, 200);

        const { data: conv } = await supabaseAdmin
            .from('chat_conversations').select('id, user_id').eq('id', id).maybeSingle();
        if (!conv) return fail(res, 404, 'NOT_FOUND', 'Conversation not found');
        if (conv.user_id !== userId) return fail(res, 403, 'FORBIDDEN', 'Access denied');

        const { data: messages, error } = await supabaseAdmin
            .from('chat_messages')
            .select(`
                id, message, created_at, sender_id, is_read,
                attachment_url, attachment_type, attachment_metadata,
                sender:profiles!sender_id ( id, username, avatar_url, role )
            `)
            .eq('conversation_id', id)
            .order('created_at', { ascending: true })
            .limit(limit);
        if (error) throw error;

        const unreadIds = (messages || []).filter(m => !m.is_read && m.sender_id !== userId).map(m => m.id);
        if (unreadIds.length) {
            await supabaseAdmin.from('chat_messages').update({ is_read: true, read_at: new Date().toISOString() }).in('id', unreadIds);
            await supabaseAdmin.from('chat_conversations').update({ unread_count: 0 }).eq('id', id);
        }

        ok(res, { data: messages || [], conversation: { id: conv.id } });
    } catch (e) {
        console.error('[CUSTOMER MESSAGES] list failed:', e.message);
        fail(res, 500, 'LIST_FAILED', 'Failed to load messages');
    }
});

// ─── POST /conversations/:id/messages ───────────────────────────
router.post('/conversations/:id/messages', authMiddleware, upload.single('attachment'), async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const message = String(req.body?.message || '').trim().slice(0, 10000);
        const file = req.file;

        if (!message && !file) return fail(res, 400, 'EMPTY', 'Message or attachment required');

        const { data: conv } = await supabaseAdmin
            .from('chat_conversations').select('id, user_id').eq('id', id).maybeSingle();
        if (!conv) return fail(res, 404, 'NOT_FOUND', 'Conversation not found');
        if (conv.user_id !== userId) return fail(res, 403, 'FORBIDDEN', 'Access denied');

        let attachmentUrl = null, attachmentType = null, attachmentMetadata = null;
        if (file && CLOUDINARY_ENABLED) {
            const r = await uploadToCloudinary(file.buffer, { folder: `milesspace/chat/${id}` });
            attachmentUrl = r.secure_url;
            attachmentType = file.mimetype;
            attachmentMetadata = {
                original_name: file.originalname, size: file.size,
                format: r.format, width: r.width || null, height: r.height || null,
                public_id: r.public_id, resource_type: r.resource_type
            };
        }

        const { data: msg, error } = await supabaseAdmin
            .from('chat_messages')
            .insert({
                conversation_id: id,
                sender_id: userId,
                message: message || (file ? '📎 Attachment' : ''),
                attachment_url: attachmentUrl,
                attachment_type: attachmentType,
                attachment_metadata: attachmentMetadata,
                is_read: false,
                created_at: new Date().toISOString()
            })
            .select()
            .single();
        if (error) throw error;

        await supabaseAdmin.from('chat_conversations').update({
            last_message: message || '📎 Attachment',
            last_message_at: new Date().toISOString(),
            unread_count: 1
        }).eq('id', id);

        if (global.io) {
            global.io.to(`conversation:${id}`).emit('message:new', { message: msg, conversation_id: id });
            global.io.to('admins').emit('support:new_message', { conversation_id: id, message: msg });
        }

        ok(res, { data: msg });
    } catch (e) {
        console.error('[CUSTOMER MESSAGES] send failed:', e.message);
        fail(res, 500, 'SEND_FAILED', 'Failed to send message');
    }
});

// ─── POST /conversations/:id/upload ─────────────────────────────
router.post('/conversations/:id/upload', authMiddleware, upload.array('attachments', 3), async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const files = req.files || [];
        if (!files.length) return fail(res, 400, 'EMPTY', 'No files uploaded');

        const { data: conv } = await supabaseAdmin
            .from('chat_conversations').select('id, user_id').eq('id', id).maybeSingle();
        if (!conv) return fail(res, 404, 'NOT_FOUND', 'Conversation not found');
        if (conv.user_id !== userId) return fail(res, 403, 'FORBIDDEN', 'Access denied');
        if (!CLOUDINARY_ENABLED) return fail(res, 503, 'NO_STORAGE', 'Uploads are not configured');

        const results = await Promise.all(files.map(async file => {
            try {
                const r = await uploadToCloudinary(file.buffer, { folder: `milesspace/chat/${id}` });
                return { success: true, url: r.secure_url, type: file.mimetype, name: file.originalname,
                         size: file.size, format: r.format, public_id: r.public_id, resource_type: r.resource_type };
            } catch (err) {
                return { success: false, error: err.message, name: file.originalname };
            }
        }));

        const good = results.filter(r => r.success);
        const bad = results.filter(r => !r.success);

        if (good.length) {
            await supabaseAdmin.from('chat_messages').insert({
                conversation_id: id,
                sender_id: userId,
                message: `📎 ${good.length} file(s)`,
                attachment_url: good.map(g => g.url).join(','),
                attachment_type: 'multiple',
                attachment_metadata: { files: good },
                is_read: false,
                created_at: new Date().toISOString()
            });
            await supabaseAdmin.from('chat_conversations').update({
                last_message: `📎 ${good.length} file(s)`,
                last_message_at: new Date().toISOString(),
                unread_count: 1
            }).eq('id', id);
        }

        ok(res, { data: { uploaded: good, failed: bad, total: files.length } });
    } catch (e) {
        console.error('[CUSTOMER MESSAGES] upload failed:', e.message);
        fail(res, 500, 'UPLOAD_FAILED', 'Failed to upload');
    }
});

// ─── GET /ticket/:ticketNumber ─────────────────────────────────
// Customer sees only their own ticket. Admins use /api/admin/support.
router.get('/ticket/:ticketNumber', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: ticket } = await supabaseAdmin
            .from('support_tickets')
            .select(`
                id, ticket_number, subject, description, status, priority, category, created_at, updated_at,
                messages:ticket_messages (
                    id, message, created_at, sender_id, is_internal,
                    sender:profiles!sender_id ( id, username, avatar_url )
                )
            `)
            .eq('ticket_number', req.params.ticketNumber)
            .eq('user_id', userId)
            .maybeSingle();
        if (!ticket) return fail(res, 404, 'NOT_FOUND', 'Ticket not found');

        // Never return internal messages to the customer.
        ticket.messages = (ticket.messages || []).filter(m => !m.is_internal);

        ok(res, { data: ticket });
    } catch (e) {
        console.error('[CUSTOMER MESSAGES] ticket failed:', e.message);
        fail(res, 500, 'TICKET_FAILED', 'Failed to load ticket');
    }
});

// ─── Support ticket paths the customer frontend already uses ────
// /api/support/tickets*
//
// These are thin wrappers over the SAME customer-side logic above.
// The customer frontend calls them. We do NOT expose any admin
// behaviour on these routes.

router.get('/tickets', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = Math.min(Number(req.query.limit) || 50, 100);
        const { data } = await supabaseAdmin
            .from('support_tickets')
            .select('id, ticket_number, subject, description, status, priority, category, created_at, updated_at')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false })
            .limit(limit);
        ok(res, { data: data || [] });
    } catch (e) {
        fail(res, 500, 'TICKETS_FAILED', 'Failed to load tickets');
    }
});

router.get('/tickets/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = Math.min(Number(req.query.messages_limit) || 100, 200);

        const { data: ticket } = await supabaseAdmin
            .from('support_tickets')
            .select('id, user_id, ticket_number, subject, description, status, priority, category, created_at, updated_at')
            .eq('id', req.params.id)
            .maybeSingle();
        if (!ticket) return fail(res, 404, 'NOT_FOUND', 'Ticket not found');
        if (ticket.user_id !== userId) return fail(res, 403, 'FORBIDDEN', 'Access denied');

        const { data: messages } = await supabaseAdmin
            .from('ticket_messages')
            .select(`
                id, message, created_at, sender_id, sender_type, is_internal,
                attachments,
                sender:profiles!sender_id ( id, username, avatar_url, role )
            `)
            .eq('ticket_id', ticket.id)
            .eq('is_internal', false)  // never expose internal notes
            .order('created_at', { ascending: true })
            .limit(limit);

        ticket.messages = messages || [];
        ok(res, { data: ticket });
    } catch (e) {
        fail(res, 500, 'TICKET_FAILED', 'Failed to load ticket');
    }
});

router.post('/tickets/:id/messages', authMiddleware, upload.array('attachments', 3), async (req, res) => {
    try {
        const userId = req.user.id;
        const message = String(req.body?.message || '').trim().slice(0, 10000);
        const files = req.files || [];
        if (!message && !files.length) return fail(res, 400, 'EMPTY', 'Message or attachment required');

        const { data: ticket } = await supabaseAdmin
            .from('support_tickets').select('id, user_id, ticket_number, status')
            .eq('id', req.params.id).maybeSingle();
        if (!ticket) return fail(res, 404, 'NOT_FOUND', 'Ticket not found');
        if (ticket.user_id !== userId) return fail(res, 403, 'FORBIDDEN', 'Access denied');
        if (['closed','resolved'].includes(ticket.status)) return fail(res, 409, 'CLOSED', 'Ticket is closed');

        const attachments = [];
        if (files.length && CLOUDINARY_ENABLED) {
            for (const f of files) {
                try {
                    const r = await uploadToCloudinary(f.buffer, { folder: `milesspace/tickets/${ticket.id}` });
                    attachments.push({ url: r.secure_url, type: f.mimetype, name: f.originalname, size: f.size, public_id: r.public_id, resource_type: r.resource_type });
                } catch (_) {}
            }
        }

        const { data: msg, error } = await supabaseAdmin
            .from('ticket_messages')
            .insert({
                ticket_id: ticket.id,
                sender_id: userId,
                sender_type: 'user',
                message: message || '📎 Attachment',
                attachments: attachments.length ? attachments : null,
                is_internal: false,
                is_read: false,
                created_at: new Date().toISOString()
            })
            .select()
            .single();
        if (error) throw error;

        await supabaseAdmin
            .from('support_tickets')
            .update({ status: 'waiting_support', updated_at: new Date().toISOString() })
            .eq('id', ticket.id);

        if (global.io) {
            global.io.to('admins').emit('support:new_message', { ticket_id: ticket.id, message: msg });
        }
        ok(res, { data: msg });
    } catch (e) {
        console.error('[CUSTOMER MESSAGES] ticket message failed:', e.message);
        fail(res, 500, 'SEND_FAILED', 'Failed to send message');
    }
});

router.post('/tickets/:id/read', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: ticket } = await supabaseAdmin
            .from('support_tickets').select('id, user_id').eq('id', req.params.id).maybeSingle();
        if (!ticket) return fail(res, 404, 'NOT_FOUND', 'Ticket not found');
        if (ticket.user_id !== userId) return fail(res, 403, 'FORBIDDEN', 'Access denied');

        await supabaseAdmin
            .from('ticket_messages')
            .update({ is_read: true, read_at: new Date().toISOString() })
            .eq('ticket_id', ticket.id)
            .neq('sender_id', userId)
            .eq('is_read', false);

        ok(res, { read: true });
    } catch (e) {
        fail(res, 500, 'READ_FAILED', 'Failed to mark read');
    }
});

module.exports = router;