// routes/support.js - COMPLETE FIXED VERSION
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware, adminAuthMiddleware } = require('../middleware/auth');
const { createNotification } = require('../services/notificationService');
const cloudinaryService = require('../services/cloudinaryService');
const IdempotencyService = require('../services/idempotencyService');

// ─── VALIDATION CONSTANTS ───
const VALID_CATEGORIES = ['wallet', 'deposit', 'withdrawal', 'giftcard', 'crypto', 'marketplace', 'boost', 'virtual', 'account', 'other'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const VALID_STATUSES = ['open', 'assigned', 'in_progress', 'waiting_user', 'waiting_support', 'resolved', 'closed'];
const MAX_ACTIVE_TICKETS = 5;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_SUBJECT_LENGTH = 150;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 5;

// ─── JWT SECRET - NO FALLBACK ───
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
}
const JWT_SECRET = process.env.JWT_SECRET;

// ─── MULTER CONFIG ───
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: MAX_FILES_PER_MESSAGE,
    },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf', 'text/plain', 'text/csv',
        ];
        if (file.mimetype.startsWith('image/')) {
            const isValidImage = validateImageSignature(file.buffer);
            if (!isValidImage) {
                return cb(new Error('Invalid image file'), false);
            }
        }
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported file type'), false);
        }
    },
});

// ─── HELPERS ──────────────────────────────────────────────────────────

function validateImageSignature(buffer) {
    if (!buffer || buffer.length < 8) return false;
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return true;
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return true;
    return false;
}

function generateTicketNumber() {
    return `TKT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           'unknown';
}

function clampString(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
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
            created_at: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Failed to log support event:', error);
    }
}

async function logAdminAction(adminId, action, details, req) {
    try {
        await supabaseAdmin.from('admin_activity').insert({
            admin_id: adminId,
            action: action,
            details: details || {},
            ip_address: getClientIp(req),
            user_agent: req.headers['user-agent'] || 'unknown',
            created_at: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Failed to log admin action:', error);
    }
}

async function getActiveTicketCount(userId) {
    const { count, error } = await supabaseAdmin
        .from('support_tickets')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .in('status', ['open', 'assigned', 'in_progress', 'waiting_user', 'waiting_support']);

    if (error) throw error;
    return count || 0;
}

function validateCategory(category) {
    return VALID_CATEGORIES.includes(category);
}

function validatePriority(priority) {
    return VALID_PRIORITIES.includes(priority);
}

function validateStatus(status) {
    return VALID_STATUSES.includes(status);
}

function isValidStatusTransition(oldStatus, newStatus) {
    const transitions = {
        'open': ['assigned', 'in_progress', 'waiting_user', 'waiting_support', 'resolved', 'closed'],
        'assigned': ['in_progress', 'waiting_user', 'waiting_support', 'resolved', 'closed'],
        'in_progress': ['waiting_user', 'waiting_support', 'resolved', 'closed'],
        'waiting_user': ['in_progress', 'waiting_support', 'resolved', 'closed'],
        'waiting_support': ['in_progress', 'waiting_user', 'resolved', 'closed'],
        'resolved': ['closed', 'open'],
        'closed': ['open'],
    };
    return transitions[oldStatus]?.includes(newStatus) || false;
}

// ─── 1. GET CATEGORIES ──────────────────────────────────────────────

router.get('/categories', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('ticket_categories')
            .select('*')
            .eq('is_active', true)
            .order('sort_order', { ascending: true });

        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 2. GET SUPPORT STATUS ──────────────────────────────────────────

router.get('/status', async (req, res) => {
    try {
        let agentsOnline = 0;
        if (global.presenceManager) {
            const online = global.presenceManager.getOnlineUsers();
            agentsOnline = online?.admins?.length || 0;
        }

        res.json({
            success: true,
            data: {
                online: agentsOnline > 0,
                agents_online: agentsOnline,
                is_open: true,
                average_response_minutes: 8,
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 3. CREATE TICKET ───────────────────────────────────────────────

router.post('/tickets', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const actorId = req.user.id;
        const idempotencyKey = req.body.idempotency_key || IdempotencyService.generateKey('TICKET');

        const existingResponse = await IdempotencyService.check(userId, idempotencyKey, 'create_ticket');
        if (existingResponse) {
            return res.status(200).json({
                success: true,
                message: 'Ticket already created',
                data: existingResponse,
                idempotent: true,
            });
        }

        const category = clampString(req.body.category, 40) || 'general';
        const subject = clampString(req.body.subject, MAX_SUBJECT_LENGTH);
        const description = clampString(req.body.description, MAX_MESSAGE_LENGTH);
        const priority = clampString(req.body.priority, 20) || 'medium';
        const relatedType = clampString(req.body.related_type, 30) || null;
        const relatedId = clampString(req.body.related_id, 50) || null;
        const relatedReference = clampString(req.body.related_reference, 50) || null;

        if (!subject || !description) {
            return res.status(400).json({
                success: false,
                code: 'MISSING_FIELDS',
                error: 'Subject and description are required',
            });
        }

        if (!validateCategory(category)) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_CATEGORY',
                error: 'Invalid category',
            });
        }

        if (!validatePriority(priority)) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_PRIORITY',
                error: 'Invalid priority',
            });
        }

        // Check active ticket limit - NO APPENDING
        const activeCount = await getActiveTicketCount(userId);
        if (activeCount >= MAX_ACTIVE_TICKETS) {
            return res.status(429).json({
                success: false,
                code: 'ACTIVE_TICKET_LIMIT',
                error: `You can have up to ${MAX_ACTIVE_TICKETS} active support conversations.`,
            });
        }

        const ticketNumber = generateTicketNumber();
        const ip = getClientIp(req);

        const { data: ticket, error } = await supabaseAdmin
            .from('support_tickets')
            .insert({
                user_id: userId,
                ticket_number: ticketNumber,
                category,
                priority,
                subject,
                description,
                status: 'open',
                ip_address: ip,
                user_agent: req.headers['user-agent'] || '',
                related_type: relatedType,
                related_id: relatedId,
                related_reference: relatedReference,
                last_message_at: new Date().toISOString(),
                last_user_message_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (error) throw error;

        // Create initial message
        const { data: msg, error: msgError } = await supabaseAdmin
            .from('ticket_messages')
            .insert({
                ticket_id: ticket.id,
                sender_id: userId,
                sender_type: 'user',
                message: description,
                created_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (msgError) throw msgError;

        await logSupportEvent({
            ticketId: ticket.id,
            actorId: actorId,
            eventType: 'ticket_created',
            newValue: { status: 'open', priority, category },
            metadata: { ticket_number: ticketNumber },
        });

        await IdempotencyService.save(userId, idempotencyKey, 'create_ticket', ticket);

        await createNotification(
            userId,
            '🎫 Ticket Created',
            `Your ticket ${ticketNumber} has been created. We'll respond shortly.`,
            'success',
            `/support/ticket/${ticketNumber}`
        );

        if (global.io) {
            global.io.to('admins').emit('support:new_ticket', {
                ticket: ticket,
                message: msg,
            });
        }

        res.json({
            success: true,
            message: 'Ticket created successfully',
            data: ticket,
            idempotency_key: idempotencyKey,
        });

    } catch (error) {
        console.error('Create ticket error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            error: error.message,
        });
    }
});

// ─── 4. GET USER TICKETS ────────────────────────────────────────────

router.get('/tickets', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { status, limit = 20, offset = 0 } = req.query;

        let query = supabaseAdmin
            .from('support_tickets')
            .select(`
                id,
                ticket_number,
                category,
                priority,
                status,
                subject,
                assigned_to,
                created_at,
                updated_at,
                last_message_at,
                assigned:assigned_to (id, username, email)
            `)
            .eq('user_id', userId)
            .order('last_message_at', { ascending: false });

        if (status) query = query.eq('status', status);

        const safeLimit = Math.min(parseInt(limit, 10) || 20, 50);
        const { data, count, error } = await query
            .range(parseInt(offset, 10) || 0, (parseInt(offset, 10) || 0) + safeLimit - 1);

        if (error) throw error;

        res.json({ success: true, data: data || [], total: count || 0 });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 5. GET TICKET BY ID ─────────────────────────────────────────────
// routes/support.js - FIXED SECTION (around line 380-400)

router.get('/tickets/:ticketId', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const userId = req.user.id;
        const isAdmin = req.user.isAdmin || false;
        const messagesLimit = Math.min(parseInt(req.query.messages_limit, 10) || 50, 100);

        const { data: ticket, error } = await supabaseAdmin
            .from('support_tickets')
            .select(`
                *,
                assigned:assigned_to (id, username, email, avatar_url),
                user:user_id (id, username, email, avatar_url, wallet_ngn, wallet_usd, status, created_at)
            `)
            .eq('id', ticketId)
            .single();

        if (error || !ticket) {
            return res.status(404).json({
                success: false,
                code: 'TICKET_NOT_FOUND',
                error: 'Ticket not found',
            });
        }

        if (ticket.user_id !== userId && !isAdmin) {
            return res.status(403).json({
                success: false,
                code: 'ACCESS_DENIED',
                error: 'Access denied',
            });
        }

        // ─── FIXED: Properly filter internal notes ──────────────────
        let messageQuery = supabaseAdmin
            .from('ticket_messages')
            .select(`
                id,
                message,
                created_at,
                sender_type,
                sender_id,
                is_read,
                is_internal,
                read_by_user_at,
                read_by_admin_at,
                attachments,
                sender:sender_id (id, username, email, avatar_url)
            `)
            .eq('ticket_id', ticketId)
            .order('created_at', { ascending: true })
            .limit(messagesLimit);

        // ✅ FIX: Only filter internal notes for non-admins
        if (!isAdmin) {
            messageQuery = messageQuery.eq('is_internal', false);
        }
        // For admins, we don't filter (they see everything)

        const { data: messages, error: msgError } = await messageQuery;

        if (msgError) throw msgError;

        const unreadForUser = (messages || []).filter(m =>
            (m.sender_type === 'admin' || m.sender_type === 'support') &&
            !m.read_by_user_at
        ).length;

        const unreadForAdmin = (messages || []).filter(m =>
            m.sender_type === 'user' &&
            !m.read_by_admin_at
        ).length;

        res.json({
            success: true,
            data: {
                ...ticket,
                messages: messages || [],
                unread_for_user: unreadForUser,
                unread_for_admin: unreadForAdmin,
            },
        });
    } catch (error) {
        console.error('Get ticket error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// ─── 6. ADD MESSAGE TO TICKET ─────────────────────────────────────

router.post(
    '/tickets/:ticketId/messages',
    authMiddleware,
    upload.array('attachments', MAX_FILES_PER_MESSAGE),
    async (req, res) => {
        try {
            const { ticketId } = req.params;
            const actorId = req.user.id;
            const isAdmin = req.user.isAdmin || false;
            const message = clampString(req.body?.message || '', MAX_MESSAGE_LENGTH);
            const isInternal = req.body?.is_internal === 'true' || req.body?.is_internal === true;
            const idempotencyKey = req.body?.idempotency_key || IdempotencyService.generateKey('MSG');
            const files = req.files || [];

            const existingResponse = await IdempotencyService.check(actorId, idempotencyKey, 'send_message');
            if (existingResponse) {
                return res.status(200).json({
                    success: true,
                    message: 'Message already sent',
                    data: existingResponse,
                    idempotent: true,
                });
            }

            if (!message && files.length === 0) {
                return res.status(400).json({
                    success: false,
                    code: 'MISSING_CONTENT',
                    error: 'Message or attachment is required',
                });
            }

            const { data: ticket, error: ticketError } = await supabaseAdmin
                .from('support_tickets')
                .select('*')
                .eq('id', ticketId)
                .single();

            if (ticketError || !ticket) {
                return res.status(404).json({
                    success: false,
                    code: 'TICKET_NOT_FOUND',
                    error: 'Ticket not found',
                });
            }

            if (ticket.status === 'closed') {
                return res.status(400).json({
                    success: false,
                    code: 'TICKET_CLOSED',
                    error: 'This ticket is closed and cannot be replied to.',
                });
            }

            if (ticket.user_id !== actorId && !isAdmin) {
                return res.status(403).json({
                    success: false,
                    code: 'ACCESS_DENIED',
                    error: 'Access denied',
                });
            }

            if (isInternal && !isAdmin) {
                return res.status(403).json({
                    success: false,
                    code: 'ACCESS_DENIED',
                    error: 'Only admins can create internal notes',
                });
            }

            const senderType = isAdmin ? 'admin' : 'user';

            // Upload files to Cloudinary
            let uploadedFiles = [];
            let attachments = [];

            if (files.length > 0) {
                for (const file of files) {
                    try {
                        const result = await cloudinaryService.uploadSupportFile(file.buffer, {
                            ticketId: ticketId,
                            folder: 'milesspace/support',
                            resource_type: cloudinaryService.getResourceType(file.mimetype),
                        });

                        const attachmentData = {
                            id: crypto.randomUUID(),
                            name: file.originalname,
                            size: file.size,
                            mime: file.mimetype,
                            url: result.secure_url,
                            public_id: result.public_id,
                            resource_type: result.resource_type,
                            format: result.format,
                            bytes: result.bytes,
                            width: result.width,
                            height: result.height,
                            created_at: result.created_at,
                        };

                        attachments.push(attachmentData);
                        uploadedFiles.push(result.public_id);
                    } catch (uploadError) {
                        console.error('❌ Cloudinary upload error:', uploadError);
                        if (uploadedFiles.length > 0) {
                            await cloudinaryService.deleteMultipleFiles(uploadedFiles);
                        }
                        return res.status(500).json({
                            success: false,
                            code: 'UPLOAD_FAILED',
                            error: `Failed to upload ${file.originalname}. Please try again.`,
                        });
                    }
                }
            }

            const messageText = message || (attachments.length > 0 ? '📎 Attachment' : '');
            const { data: msg, error: msgError } = await supabaseAdmin
                .from('ticket_messages')
                .insert({
                    ticket_id: ticketId,
                    sender_id: actorId,
                    sender_type: senderType,
                    message: messageText,
                    is_internal: isInternal || false,
                    idempotency_key: idempotencyKey,
                    attachments: attachments.length > 0 ? attachments : null,
                    created_at: new Date().toISOString(),
                })
                .select()
                .single();

            if (msgError) {
                if (uploadedFiles.length > 0) {
                    await cloudinaryService.deleteMultipleFiles(uploadedFiles);
                }
                throw msgError;
            }

            // Update ticket
            const updateData = {
                updated_at: new Date().toISOString(),
                last_message_at: new Date().toISOString(),
            };

            if (isAdmin) {
                updateData.status = ticket.status === 'resolved' ? 'resolved' : 'in_progress';
                updateData.last_admin_message_at = new Date().toISOString();
                if (!ticket.first_response_at) {
                    updateData.first_response_at = new Date().toISOString();
                }
            } else {
                updateData.status = ticket.status === 'resolved' ? 'open' : 'open';
                updateData.last_user_message_at = new Date().toISOString();
            }

            await supabaseAdmin
                .from('support_tickets')
                .update(updateData)
                .eq('id', ticketId);

            await logSupportEvent({
                ticketId: ticketId,
                actorId: actorId,
                eventType: 'message_added',
                newValue: { message_id: msg.id, is_internal: isInternal },
                metadata: { attachments_count: attachments.length },
            });

            await IdempotencyService.save(actorId, idempotencyKey, 'send_message', msg);

            // Notifications
            if (isAdmin) {
                if (ticket.user_id) {
                    await createNotification(
                        ticket.user_id,
                        '📩 Admin Reply',
                        `Admin replied to your ticket: ${ticket.subject}`,
                        'info',
                        `/support/ticket/${ticket.ticket_number}`
                    );
                }
                if (global.io && ticket.user_id) {
                    global.io.to(`user:${ticket.user_id}`).emit('support:message', {
                        ticket_id: ticketId,
                        ticket_number: ticket.ticket_number,
                        message: msg,
                        sender: 'admin',
                    });
                }
            } else {
                if (ticket.assigned_to) {
                    await createNotification(
                        ticket.assigned_to,
                        '📤 New Message',
                        `User replied to ticket ${ticket.ticket_number}`,
                        'info',
                        `/admin/support/ticket/${ticket.id}`
                    );
                }
                if (global.io) {
                    global.io.to('admins').emit('support:message', {
                        ticket_id: ticketId,
                        ticket_number: ticket.ticket_number,
                        message: msg,
                        sender: 'user',
                    });
                }
            }

            res.json({
                success: true,
                message: 'Message sent',
                data: {
                    message: msg,
                    attachments: attachments,
                },
                idempotency_key: idempotencyKey,
            });
        } catch (error) {
            console.error('Add message error:', error);
            res.status(500).json({
                success: false,
                code: 'SERVER_ERROR',
                error: error.message,
            });
        }
    }
);

// ─── 7. GET UNREAD COUNT ────────────────────────────────────────────

router.get('/unread', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const { data: tickets, error } = await supabaseAdmin
            .from('support_tickets')
            .select(`
                id,
                ticket_number,
                subject,
                status,
                messages:ticket_messages (
                    id,
                    sender_type,
                    read_by_user_at
                )
            `)
            .eq('user_id', userId)
            .in('status', ['open', 'assigned', 'in_progress', 'waiting_user', 'waiting_support', 'resolved']);

        if (error) throw error;

        let totalUnread = 0;
        const ticketUnread = (tickets || []).map(t => {
            const unreadCount = (t.messages || []).filter(m =>
                (m.sender_type === 'admin' || m.sender_type === 'support') &&
                !m.read_by_user_at
            ).length;
            totalUnread += unreadCount;
            return {
                ticket_id: t.id,
                ticket_number: t.ticket_number,
                subject: t.subject,
                status: t.status,
                unread_count: unreadCount,
            };
        }).filter(t => t.unread_count > 0);

        res.json({
            success: true,
            data: {
                total_unread: totalUnread,
                tickets: ticketUnread,
            },
        });
    } catch (error) {
        console.error('Unread count error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 8. MARK TICKET AS READ ──────────────────────────────────────────

router.post('/tickets/:ticketId/read', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const userId = req.user.id;
        const isAdmin = req.user.isAdmin || false;

        const { data: ticket, error: ticketError } = await supabaseAdmin
            .from('support_tickets')
            .select('*')
            .eq('id', ticketId)
            .single();

        if (ticketError || !ticket) {
            return res.status(404).json({
                success: false,
                code: 'TICKET_NOT_FOUND',
                error: 'Ticket not found',
            });
        }

        if (ticket.user_id !== userId && !isAdmin) {
            return res.status(403).json({
                success: false,
                code: 'ACCESS_DENIED',
                error: 'Access denied',
            });
        }

        if (isAdmin) {
            await supabaseAdmin
                .from('ticket_messages')
                .update({ read_by_admin_at: new Date().toISOString() })
                .eq('ticket_id', ticketId)
                .eq('sender_type', 'user')
                .is('read_by_admin_at', null);
        } else {
            await supabaseAdmin
                .from('ticket_messages')
                .update({ read_by_user_at: new Date().toISOString() })
                .eq('ticket_id', ticketId)
                .in('sender_type', ['admin', 'support'])
                .is('read_by_user_at', null);
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 9. REOPEN TICKET ───────────────────────────────────────────────

router.post('/tickets/:ticketId/reopen', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const userId = req.user.id;
        const isAdmin = req.user.isAdmin || false;

        const { data: ticket, error: ticketError } = await supabaseAdmin
            .from('support_tickets')
            .select('*')
            .eq('id', ticketId)
            .single();

        if (ticketError || !ticket) {
            return res.status(404).json({
                success: false,
                code: 'TICKET_NOT_FOUND',
                error: 'Ticket not found',
            });
        }

        if (ticket.user_id !== userId && !isAdmin) {
            return res.status(403).json({
                success: false,
                code: 'ACCESS_DENIED',
                error: 'Access denied',
            });
        }

        if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
            return res.status(400).json({
                success: false,
                code: 'TICKET_NOT_CLOSED',
                error: 'Only resolved or closed tickets can be reopened',
            });
        }

        const oldStatus = ticket.status;
        const { data: updated, error } = await supabaseAdmin
            .from('support_tickets')
            .update({
                status: 'open',
                updated_at: new Date().toISOString(),
                closed_at: null,
                resolved_at: null,
            })
            .eq('id', ticketId)
            .select()
            .single();

        if (error) throw error;

        await logSupportEvent({
            ticketId: ticketId,
            actorId: userId,
            eventType: 'ticket_reopened',
            oldValue: { status: oldStatus },
            newValue: { status: 'open' },
        });

        await createNotification(
            ticket.user_id,
            '🔄 Ticket Reopened',
            `Your ticket ${ticket.ticket_number} has been reopened.`,
            'info',
            `/support/ticket/${ticket.ticket_number}`
        );

        if (global.io) {
            global.io.to('admins').emit('support:ticket_reopened', {
                ticket: updated,
            });
            if (ticket.user_id) {
                global.io.to(`user:${ticket.user_id}`).emit('support:ticket_reopened', {
                    ticket: updated,
                });
            }
        }

        res.json({
            success: true,
            message: 'Ticket reopened',
            data: updated,
        });
    } catch (error) {
        console.error('Reopen ticket error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 10. CLOSE TICKET (user) ─────────────────────────────────────────

router.post('/tickets/:ticketId/close', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const userId = req.user.id;

        const { data: ticket, error: ticketError } = await supabaseAdmin
            .from('support_tickets')
            .select('*')
            .eq('id', ticketId)
            .single();

        if (ticketError || !ticket) {
            return res.status(404).json({
                success: false,
                code: 'TICKET_NOT_FOUND',
                error: 'Ticket not found',
            });
        }

        if (ticket.user_id !== userId) {
            return res.status(403).json({
                success: false,
                code: 'ACCESS_DENIED',
                error: 'Access denied',
            });
        }

        if (ticket.status === 'closed') {
            return res.status(400).json({
                success: false,
                code: 'TICKET_ALREADY_CLOSED',
                error: 'This ticket is already closed',
            });
        }

        const { data: updated, error } = await supabaseAdmin
            .from('support_tickets')
            .update({
                status: 'closed',
                closed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', ticketId)
            .select()
            .single();

        if (error) throw error;

        await logSupportEvent({
            ticketId: ticketId,
            actorId: userId,
            eventType: 'ticket_closed_by_user',
            newValue: { status: 'closed' },
        });

        res.json({
            success: true,
            message: 'Ticket closed',
            data: updated,
        });
    } catch (error) {
        console.error('Close ticket error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 11. ADD TICKET RATING ──────────────────────────────────────────

router.post('/tickets/:ticketId/rating', authMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const userId = req.user.id;
        const { rating, comment } = req.body;

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_RATING',
                error: 'Rating must be between 1 and 5',
            });
        }

        const { data: ticket, error: ticketError } = await supabaseAdmin
            .from('support_tickets')
            .select('*')
            .eq('id', ticketId)
            .single();

        if (ticketError || !ticket) {
            return res.status(404).json({
                success: false,
                code: 'TICKET_NOT_FOUND',
                error: 'Ticket not found',
            });
        }

        if (ticket.user_id !== userId) {
            return res.status(403).json({
                success: false,
                code: 'ACCESS_DENIED',
                error: 'Access denied',
            });
        }

        if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
            return res.status(400).json({
                success: false,
                code: 'TICKET_NOT_RESOLVED',
                error: 'Only resolved or closed tickets can be rated',
            });
        }

        const { data, error } = await supabaseAdmin
            .from('support_ticket_ratings')
            .insert({
                ticket_id: ticketId,
                user_id: userId,
                rating: rating,
                comment: comment ? clampString(comment, 500) : null,
                created_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (error) throw error;

        await logSupportEvent({
            ticketId: ticketId,
            actorId: userId,
            eventType: 'ticket_rated',
            newValue: { rating },
        });

        res.json({
            success: true,
            message: 'Rating submitted',
            data: data,
        });
    } catch (error) {
        console.error('Add rating error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── ADMIN ROUTES ────────────────────────────────────────────────────

// ─── 12. ADMIN: GET ALL TICKETS ─────────────────────────────────────

// routes/support.js - COMPLETE FIXED VERSION with all admin endpoints

// ─── ADMIN: GET ALL TICKETS ─────────────────────────────────────

router.get('/admin/tickets', adminAuthMiddleware, async (req, res) => {
    try {
        const { status, priority, category, search, assigned_to, limit = 50, offset = 0 } = req.query;
        const safeLimit = Math.min(parseInt(limit, 10) || 50, 100);
        const adminId = req.user.id;

        // ✅ FIX: Use simple field names without aliases
        let query = supabaseAdmin
            .from('support_tickets')
            .select(`
                *,
                user:user_id (
                    id,
                    email,
                    username,
                    avatar_url,
                    wallet_ngn,
                    wallet_usd,
                    status,
                    created_at
                ),
                assigned:assigned_to (
                    id,
                    username,
                    email
                ),
                messages:ticket_messages (
                    id,
                    message,
                    created_at,
                    sender_type,
                    is_read,
                    read_by_user_at,
                    read_by_admin_at,
                    is_internal
                )
            `)
            .order('last_message_at', { ascending: false });

        if (status) query = query.eq('status', status);
        if (priority) query = query.eq('priority', priority);
        if (category) query = query.eq('category', category);
        if (assigned_to === 'unassigned') {
            query = query.is('assigned_to', null);
        } else if (assigned_to === 'me') {
            query = query.eq('assigned_to', adminId);
        } else if (assigned_to) {
            query = query.eq('assigned_to', assigned_to);
        }
        if (search) {
            const s = clampString(search, 100).replace(/[%_]/g, '');
            query = query.or(`subject.ilike.%${s}%,ticket_number.ilike.%${s}%,guest_email.ilike.%${s}%`);
        }

        const { data, count, error } = await query
            .range(parseInt(offset, 10) || 0, (parseInt(offset, 10) || 0) + safeLimit - 1);

        if (error) {
            console.error('Admin tickets query error:', error);
            throw error;
        }

        // ✅ FIX: Calculate unread counts from the returned data
        const ticketsWithUnread = (data || []).map(t => {
            const adminUnread = (t.messages || []).filter(m =>
                m.sender_type === 'user' && !m.read_by_admin_at && !m.is_internal
            ).length;
            const userUnread = (t.messages || []).filter(m =>
                (m.sender_type === 'admin' || m.sender_type === 'support') && !m.read_by_user_at && !m.is_internal
            ).length;
            return {
                ...t,
                admin_unread_count: adminUnread,
                user_unread_count: userUnread,
            };
        });

        res.json({
            success: true,
            data: ticketsWithUnread || [],
            total: count || 0,
        });
    } catch (error) {
        console.error('Admin tickets error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            error: error.message,
        });
    }
});

// ─── ADMIN: GET TICKET STATS ────────────────────────────────────

router.get('/admin/stats', adminAuthMiddleware, async (req, res) => {
    try {
        const adminId = req.user.id;

        const [
            { count: open },
            { count: assigned },
            { count: inProgress },
            { count: waitingUser },
            { count: waitingSupport },
            { count: resolved },
            { count: closed },
            { count: highPriority },
            { count: urgent },
            { count: total },
            { count: unassigned },
            { count: assignedToMe },
            { count: resolvedToday },
            { count: slaBreached },
        ] = await Promise.all([
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'open'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'assigned'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'in_progress'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'waiting_user'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'waiting_support'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'resolved'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'closed'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('priority', 'high'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('priority', 'urgent'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).is('assigned_to', null).in('status', ['open', 'assigned', 'in_progress']),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('assigned_to', adminId).in('status', ['open', 'assigned', 'in_progress', 'waiting_user', 'waiting_support']),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'resolved').gte('resolved_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('sla_breached', true),
        ]);

        res.json({
            success: true,
            data: {
                open: open || 0,
                assigned: assigned || 0,
                in_progress: inProgress || 0,
                waiting_user: waitingUser || 0,
                waiting_support: waitingSupport || 0,
                resolved: resolved || 0,
                closed: closed || 0,
                high_priority: highPriority || 0,
                urgent: urgent || 0,
                total: total || 0,
                unassigned: unassigned || 0,
                assigned_to_me: assignedToMe || 0,
                resolved_today: resolvedToday || 0,
                sla_breached: slaBreached || 0,
            },
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 14. ADMIN: UPDATE TICKET STATUS ───────────────────────────────

router.put('/admin/tickets/:ticketId/status', adminAuthMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const adminId = req.user.id;
        const { status } = req.body;

        if (!status || !validateStatus(status)) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_STATUS',
                error: 'Valid status is required',
            });
        }

        const { data: ticket, error: getError } = await supabaseAdmin
            .from('support_tickets')
            .select('*')
            .eq('id', ticketId)
            .single();

        if (getError || !ticket) {
            return res.status(404).json({
                success: false,
                code: 'TICKET_NOT_FOUND',
                error: 'Ticket not found',
            });
        }

        if (!isValidStatusTransition(ticket.status, status)) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_STATUS_TRANSITION',
                error: `Cannot transition from ${ticket.status} to ${status}`,
            });
        }

        const oldStatus = ticket.status;
        const updateData = {
            status,
            updated_at: new Date().toISOString(),
        };

        if (status === 'resolved') {
            updateData.resolved_at = new Date().toISOString();
        } else if (status === 'closed') {
            updateData.closed_at = new Date().toISOString();
        }

        const { data: updated, error } = await supabaseAdmin
            .from('support_tickets')
            .update(updateData)
            .eq('id', ticketId)
            .select()
            .single();

        if (error) throw error;

        await logAdminAction(adminId, 'UPDATE_TICKET_STATUS', {
            ticket_id: ticketId,
            old_status: oldStatus,
            new_status: status,
            ticket_number: ticket.ticket_number,
        }, req);

        await logSupportEvent({
            ticketId: ticketId,
            actorId: adminId,
            eventType: 'status_changed',
            oldValue: { status: oldStatus },
            newValue: { status },
        });

        if (ticket.user_id) {
            await createNotification(
                ticket.user_id,
                `📋 Ticket ${status}`,
                `Your ticket ${ticket.ticket_number} status has been updated to ${status}.`,
                'info',
                `/support/ticket/${ticket.ticket_number}`
            );
        }

        if (global.io) {
            global.io.to('admins').emit('support:ticket_updated', {
                ticket: updated,
                changes: { status },
            });
            if (ticket.user_id) {
                global.io.to(`user:${ticket.user_id}`).emit('support:ticket_updated', {
                    ticket: updated,
                    changes: { status },
                });
            }
        }

        res.json({
            success: true,
            message: 'Ticket status updated',
            data: updated,
        });
    } catch (error) {
        console.error('Update status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 15. ADMIN: GET TICKET STATS ────────────────────────────────────

router.get('/admin/stats', adminAuthMiddleware, async (req, res) => {
    try {
        const adminId = req.user.id;

        const [
            { count: open },
            { count: assigned },
            { count: inProgress },
            { count: waitingUser },
            { count: waitingSupport },
            { count: resolved },
            { count: closed },
            { count: highPriority },
            { count: urgent },
            { count: total },
            { count: unassigned },
            { count: assignedToMe },
            { count: resolvedToday },
        ] = await Promise.all([
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'open'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'assigned'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'in_progress'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'waiting_user'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'waiting_support'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'resolved'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'closed'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('priority', 'high'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('priority', 'urgent'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).is('assigned_to', null).in('status', ['open', 'assigned', 'in_progress']),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('assigned_to', adminId).in('status', ['open', 'assigned', 'in_progress', 'waiting_user', 'waiting_support']),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'resolved').gte('resolved_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
        ]);

        res.json({
            success: true,
            data: {
                open: open || 0,
                assigned: assigned || 0,
                in_progress: inProgress || 0,
                waiting_user: waitingUser || 0,
                waiting_support: waitingSupport || 0,
                resolved: resolved || 0,
                closed: closed || 0,
                high_priority: highPriority || 0,
                urgent: urgent || 0,
                total: total || 0,
                unassigned: unassigned || 0,
                assigned_to_me: assignedToMe || 0,
                resolved_today: resolvedToday || 0,
            },
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});



// ─── 16. ADMIN: RESOLVE TICKET ─────────────────────────────────────

router.put('/admin/tickets/:ticketId/resolve', adminAuthMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const adminId = req.user.id;

        const { data: ticket, error } = await supabaseAdmin
            .from('support_tickets')
            .update({
                status: 'resolved',
                resolved_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', ticketId)
            .select()
            .single();

        if (error) throw error;

        await logAdminAction(adminId, 'RESOLVE_TICKET', {
            ticket_id: ticketId,
            ticket_number: ticket.ticket_number,
        }, req);

        await logSupportEvent({
            ticketId: ticketId,
            actorId: adminId,
            eventType: 'ticket_resolved',
        });

        if (ticket.user_id) {
            await createNotification(
                ticket.user_id,
                '✅ Ticket Resolved',
                `Your ticket ${ticket.ticket_number} has been resolved.`,
                'success',
                `/support/ticket/${ticket.ticket_number}`
            );
        }

        if (global.io) {
            global.io.to('admins').emit('support:ticket_resolved', {
                ticket: ticket,
            });
            if (ticket.user_id) {
                global.io.to(`user:${ticket.user_id}`).emit('support:ticket_resolved', {
                    ticket: ticket,
                });
            }
        }

        res.json({
            success: true,
            message: 'Ticket resolved successfully',
            data: ticket,
        });
    } catch (error) {
        console.error('Resolve ticket error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 17. ADMIN: CLOSE TICKET ──────────────────────────────────────

router.put('/admin/tickets/:ticketId/close', adminAuthMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const adminId = req.user.id;

        const { data: ticket, error } = await supabaseAdmin
            .from('support_tickets')
            .update({
                status: 'closed',
                closed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', ticketId)
            .select()
            .single();

        if (error) throw error;

        await logAdminAction(adminId, 'CLOSE_TICKET', {
            ticket_id: ticketId,
            ticket_number: ticket.ticket_number,
        }, req);

        await logSupportEvent({
            ticketId: ticketId,
            actorId: adminId,
            eventType: 'ticket_closed_by_admin',
        });

        res.json({
            success: true,
            message: 'Ticket closed successfully',
            data: ticket,
        });
    } catch (error) {
        console.error('Close ticket error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 18. ADMIN: DELETE ATTACHMENT ───────────────────────────────────

router.delete('/admin/attachments/:attachmentId', adminAuthMiddleware, async (req, res) => {
    try {
        const { attachmentId } = req.params;
        const adminId = req.user.id;

        const { data: messages, error: findError } = await supabaseAdmin
            .from('ticket_messages')
            .select('id, attachments, ticket_id')
            .contains('attachments', [{ id: attachmentId }]);

        if (findError || !messages || messages.length === 0) {
            return res.status(404).json({
                success: false,
                code: 'ATTACHMENT_NOT_FOUND',
                error: 'Attachment not found',
            });
        }

        let targetMessage = null;
        let attachmentIndex = -1;
        for (const msg of messages) {
            const idx = (msg.attachments || []).findIndex(a => a.id === attachmentId);
            if (idx !== -1) {
                targetMessage = msg;
                attachmentIndex = idx;
                break;
            }
        }

        if (!targetMessage || attachmentIndex === -1) {
            return res.status(404).json({
                success: false,
                code: 'ATTACHMENT_NOT_FOUND',
                error: 'Attachment not found',
            });
        }

        const removed = targetMessage.attachments[attachmentIndex];
        targetMessage.attachments.splice(attachmentIndex, 1);

        if (removed.public_id) {
            await cloudinaryService.deleteSupportFile(removed.public_id);
        }

        await supabaseAdmin
            .from('ticket_messages')
            .update({
                attachments: targetMessage.attachments.length > 0 ? targetMessage.attachments : null,
            })
            .eq('id', targetMessage.id);

        await logAdminAction(adminId, 'DELETE_ATTACHMENT', {
            attachment_id: attachmentId,
            public_id: removed.public_id,
            message_id: targetMessage.id,
        }, req);

        res.json({
            success: true,
            message: 'Attachment deleted',
        });
    } catch (error) {
        console.error('Delete attachment error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 19. ADMIN: GET TICKET EVENTS ──────────────────────────────────

router.get('/admin/tickets/:ticketId/events', adminAuthMiddleware, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { limit = 50, offset = 0 } = req.query;

        const { data, count, error } = await supabaseAdmin
            .from('support_ticket_events')
            .select(`
                *,
                actor:actor_id (id, username, email)
            `)
            .eq('ticket_id', ticketId)
            .order('created_at', { ascending: true })
            .range(parseInt(offset, 10) || 0, (parseInt(offset, 10) || 0) + parseInt(limit, 10) - 1);

        if (error) throw error;

        res.json({
            success: true,
            data: data || [],
            total: count || 0,
        });
    } catch (error) {
        console.error('Get events error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 20. ADMIN: GET CUSTOMER CONTEXT ────────────────────────────────

router.get('/admin/customer/:userId/context', adminAuthMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, phone, wallet_ngn, wallet_usd, status, created_at, last_login')
            .eq('id', userId)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({
                success: false,
                code: 'USER_NOT_FOUND',
                error: 'User not found',
            });
        }

        const { data: tickets, error: ticketsError } = await supabaseAdmin
            .from('support_tickets')
            .select('id, ticket_number, subject, status, priority, created_at, updated_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(5);

        if (ticketsError) throw ticketsError;

        const { data: transactions, error: txError } = await supabaseAdmin
            .from('transactions')
            .select('id, type, amount, currency, status, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(5);

        if (txError) throw txError;

        res.json({
            success: true,
            data: {
                profile: {
                    ...profile,
                    wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
                    wallet_usd: parseFloat(profile.wallet_usd) || 0,
                },
                recent_tickets: tickets || [],
                recent_transactions: transactions || [],
            },
        });
    } catch (error) {
        console.error('Customer context error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;