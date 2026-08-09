// routes/messages.js - Complete Messaging System with Cloudinary
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

const JWT_SECRET = process.env.JWT_SECRET || 'miles-exchange-secret-key-2024';

// ─── CLOUDINARY CONFIG ───
if (process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    console.log('✅ Cloudinary configured successfully');
} else {
    console.warn('⚠️ Cloudinary not configured - attachments will be stored locally');
}

// ─── CLOUDINARY UPLOAD HELPER ───
const uploadToCloudinary = (fileBuffer, options = {}) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: 'auto',
                folder: 'milesspace/chat_attachments',
                ...options
            },
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );

        const readableStream = new Readable();
        readableStream.push(fileBuffer);
        readableStream.push(null);
        readableStream.pipe(uploadStream);
    });
};

// ─── MULTER CONFIG (Memory Storage for Cloudinary) ───
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: { 
        fileSize: 10 * 1024 * 1024 // 10MB max
    },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/webm', 'video/quicktime',
            'application/pdf', 'application/msword', 
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain'
        ];
        cb(null, allowed.includes(file.mimetype));
    }
});

// ─── HELPERS ───
function generateTicketNumber() {
    return `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

async function createNotification(userId, title, message, type = 'info', link = null) {
    try {
        const { data, error } = await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title,
            message,
            type,
            icon: type === 'success' ? '✅' : type === 'error' ? '❌' : '📌',
            link,
            is_read: false,
            created_at: new Date().toISOString()
        }).select().single();
        
        if (error) console.error('Notification error:', error);
        return data;
    } catch (e) {
        console.error('Create notification error:', e);
        return null;
    }
}

// ─── 1. GET CATEGORIES ───
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

// ─── 2. GET STATS ───
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const { data: conversations, error: convError } = await supabaseAdmin
            .from('chat_conversations')
            .select('*')
            .eq('user_id', userId);

        if (convError) throw convError;

        const stats = {
            total: conversations?.length || 0,
            open: conversations?.filter(c => c.status === 'open').length || 0,
            closed: conversations?.filter(c => c.status === 'closed').length || 0,
            unread_messages: conversations?.reduce((sum, c) => sum + (c.unread_count || 0), 0) || 0
        };

        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 3. GET CONVERSATIONS ───
router.get('/conversations', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { limit = 50, offset = 0 } = req.query;

        let query = supabaseAdmin
            .from('chat_conversations')
            .select(`
                *,
                user:profiles!user_id (
                    id,
                    email,
                    username,
                    avatar_url
                ),
                admin:profiles!admin_id (
                    id,
                    email,
                    username,
                    avatar_url
                ),
                messages:chat_messages (
                    id,
                    message,
                    created_at,
                    sender_id,
                    is_read,
                    attachment_url,
                    attachment_type
                )
            `)
            .eq('user_id', userId)
            .order('last_message_at', { ascending: false });

        if (limit) {
            query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
        }

        const { data, error } = await query;

        if (error) throw error;

        const conversations = (data || []).map(c => ({
            ...c,
            unread_count: c.messages?.filter(m => !m.is_read && m.sender_id !== userId).length || 0,
            messages: c.messages?.slice(0, 1) || []
        }));

        res.json({ success: true, data: conversations });
    } catch (error) {
        console.error('Get conversations error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 4. CREATE CONVERSATION ───
router.post('/conversations', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { subject, category, priority, message } = req.body;

        if (!subject || !message) {
            return res.status(400).json({
                success: false,
                error: 'Subject and message are required'
            });
        }

        const ticketNumber = generateTicketNumber();
        
        const { data: ticket, error: ticketError } = await supabaseAdmin
            .from('support_tickets')
            .insert({
                user_id: userId,
                ticket_number: ticketNumber,
                category: category || 'general',
                priority: priority || 'medium',
                subject: subject,
                description: message,
                status: 'open',
                ip_address: req.ip || req.socket?.remoteAddress || 'unknown',
                user_agent: req.headers['user-agent'] || '',
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (ticketError) throw ticketError;

        const { data: conversation, error: convError } = await supabaseAdmin
            .from('chat_conversations')
            .insert({
                user_id: userId,
                subject: subject,
                status: 'open',
                last_message: message,
                last_message_at: new Date().toISOString(),
                unread_count: 1,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (convError) throw convError;

        const { data: chatMessage, error: msgError } = await supabaseAdmin
            .from('chat_messages')
            .insert({
                conversation_id: conversation.id,
                sender_id: userId,
                message: message,
                is_read: false,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (msgError) throw msgError;

        await createNotification(
            userId,
            '🎫 Support Ticket Created',
            `Your ticket ${ticketNumber} has been created. We'll respond shortly.`,
            'success',
            `/messages`
        );

        if (global.io) {
            global.io.emit('admin:new_ticket', {
                ticket: {
                    id: ticket.id,
                    ticket_number: ticketNumber,
                    subject,
                    category,
                    priority,
                    user_id: userId,
                    created_at: ticket.created_at
                }
            });
            
            global.io.emit('notification:receive', {
                type: 'info',
                title: 'New Support Ticket',
                message: `Ticket ${ticketNumber}: ${subject}`,
                link: `/admin/messages`
            });
        }

        res.json({
            success: true,
            message: 'Conversation created successfully',
            data: {
                ticket,
                conversation,
                message: chatMessage
            }
        });

    } catch (error) {
        console.error('Create conversation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 5. GET CONVERSATION MESSAGES ───
router.get('/conversations/:id/messages', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const { limit = 100 } = req.query;

        const { data: conv, error: convError } = await supabaseAdmin
            .from('chat_conversations')
            .select('*')
            .eq('id', id)
            .single();

        if (convError) {
            return res.status(404).json({
                success: false,
                error: 'Conversation not found'
            });
        }

        if (conv.user_id !== userId) {
            const token = req.headers.authorization?.split(' ')[1];
            if (token) {
                const decoded = jwt.verify(token, JWT_SECRET);
                if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
                    return res.status(403).json({
                        success: false,
                        error: 'Access denied'
                    });
                }
            } else {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied'
                });
            }
        }

        const { data: messages, error: msgError } = await supabaseAdmin
            .from('chat_messages')
            .select(`
                *,
                sender:profiles!sender_id (
                    id,
                    email,
                    username,
                    avatar_url,
                    role
                )
            `)
            .eq('conversation_id', id)
            .order('created_at', { ascending: true })
            .limit(parseInt(limit));

        if (msgError) throw msgError;

        // Transform Cloudinary URLs to include transformations if needed
        const transformedMessages = (messages || []).map(m => {
            if (m.attachment_url && m.attachment_url.includes('cloudinary.com')) {
                // Add image optimization for better performance
                const url = new URL(m.attachment_url);
                if (m.attachment_type?.startsWith('image/')) {
                    // Add quality and format optimization
                    return {
                        ...m,
                        attachment_url: m.attachment_url,
                        attachment_optimized: m.attachment_url.replace(
                            '/upload/',
                            '/upload/q_auto:eco/f_auto/'
                        )
                    };
                }
            }
            return m;
        });

        // Mark messages as read
        const unreadIds = (messages || [])
            .filter(m => !m.is_read && m.sender_id !== userId)
            .map(m => m.id);

        if (unreadIds.length > 0) {
            await supabaseAdmin
                .from('chat_messages')
                .update({ is_read: true, read_at: new Date().toISOString() })
                .in('id', unreadIds);

            await supabaseAdmin
                .from('chat_conversations')
                .update({ unread_count: 0 })
                .eq('id', id);
        }

        res.json({
            success: true,
            data: transformedMessages || [],
            conversation: conv
        });

    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 6. SEND MESSAGE WITH CLOUDINARY ───
router.post('/conversations/:id/messages', authMiddleware, upload.single('attachment'), async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const { message } = req.body;
        const file = req.file;

        if (!message && !file) {
            return res.status(400).json({
                success: false,
                error: 'Message or attachment required'
            });
        }

        // Check conversation exists
        const { data: conv, error: convError } = await supabaseAdmin
            .from('chat_conversations')
            .select('*')
            .eq('id', id)
            .single();

        if (convError) {
            return res.status(404).json({
                success: false,
                error: 'Conversation not found'
            });
        }

        // Check permissions
        const token = req.headers.authorization?.split(' ')[1];
        let isAdmin = false;
        
        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                isAdmin = decoded.role === 'admin' || decoded.role === 'super_admin';
            } catch (e) {}
        }

        if (conv.user_id !== userId && !isAdmin) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        // Upload to Cloudinary if file exists
        let attachmentUrl = null;
        let attachmentType = null;
        let attachmentMetadata = null;

        if (file) {
            try {
                const result = await uploadToCloudinary(file.buffer, {
                    folder: `milesspace/chat/${id}`,
                    resource_type: 'auto',
                    use_filename: true,
                    unique_filename: true,
                });

                attachmentUrl = result.secure_url;
                attachmentType = file.mimetype;
                attachmentMetadata = {
                    original_name: file.originalname,
                    size: file.size,
                    format: result.format,
                    width: result.width || null,
                    height: result.height || null,
                    duration: result.duration || null,
                    bytes: result.bytes,
                    public_id: result.public_id
                };

                console.log('📎 Uploaded attachment to Cloudinary:', result.public_id);
            } catch (cloudinaryError) {
                console.error('Cloudinary upload error:', cloudinaryError);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to upload attachment'
                });
            }
        }

        // Create message in database
        const { data: msg, error: msgError } = await supabaseAdmin
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
            .select(`
                *,
                sender:profiles!sender_id (
                    id,
                    email,
                    username,
                    avatar_url,
                    role
                )
            `)
            .single();

        if (msgError) throw msgError;

        // Update conversation
        const updateData = {
            last_message: message || '📎 Attachment',
            last_message_at: new Date().toISOString()
        };

        if (!isAdmin) {
            updateData.unread_count = (conv.unread_count || 0) + 1;
        }

        await supabaseAdmin
            .from('chat_conversations')
            .update(updateData)
            .eq('id', id);

        // Create notification for receiver
        const receiverId = isAdmin ? conv.user_id : (conv.admin_id || null);
        if (receiverId) {
            const senderName = msg.sender?.username || msg.sender?.email || 'User';
            await createNotification(
                receiverId,
                isAdmin ? '📩 Admin Reply' : '📤 New Message',
                `${senderName}: ${message?.substring(0, 50) || '📎 Attachment'}`,
                'info',
                `/messages`
            );
        }

        // Emit via Socket.IO
        if (global.io) {
            global.io.to(`conversation:${id}`).emit('message:new', {
                message: msg,
                conversation_id: id
            });

            if (receiverId) {
                global.io.to(`user:${receiverId}`).emit('notification:receive', {
                    type: 'info',
                    title: 'New Message',
                    message: `${msg.sender?.username || 'User'}: ${message?.substring(0, 30) || '📎'}`,
                    link: `/messages`
                });
            }
        }

        res.json({
            success: true,
            message: 'Message sent',
            data: msg
        });

    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 7. UPLOAD MULTIPLE FILES ───
router.post('/conversations/:id/upload', authMiddleware, upload.array('attachments', 5), async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const files = req.files || [];

        if (!files.length) {
            return res.status(400).json({
                success: false,
                error: 'No files uploaded'
            });
        }

        // Check conversation exists and permissions
        const { data: conv, error: convError } = await supabaseAdmin
            .from('chat_conversations')
            .select('*')
            .eq('id', id)
            .single();

        if (convError) {
            return res.status(404).json({
                success: false,
                error: 'Conversation not found'
            });
        }

        const token = req.headers.authorization?.split(' ')[1];
        let isAdmin = false;
        
        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                isAdmin = decoded.role === 'admin' || decoded.role === 'super_admin';
            } catch (e) {}
        }

        if (conv.user_id !== userId && !isAdmin) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        // Upload all files to Cloudinary
        const uploadPromises = files.map(async (file) => {
            try {
                const result = await uploadToCloudinary(file.buffer, {
                    folder: `milesspace/chat/${id}`,
                    resource_type: 'auto',
                    use_filename: true,
                    unique_filename: true,
                });

                return {
                    success: true,
                    url: result.secure_url,
                    type: file.mimetype,
                    metadata: {
                        original_name: file.originalname,
                        size: file.size,
                        format: result.format,
                        width: result.width || null,
                        height: result.height || null,
                        duration: result.duration || null
                    }
                };
            } catch (error) {
                return {
                    success: false,
                    error: error.message,
                    original_name: file.originalname
                };
            }
        });

        const results = await Promise.all(uploadPromises);
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        // Create message for each successful upload
        if (successful.length) {
            const messageText = `📎 ${successful.length} file(s) uploaded`;
            
            const { data: msg, error: msgError } = await supabaseAdmin
                .from('chat_messages')
                .insert({
                    conversation_id: id,
                    sender_id: userId,
                    message: messageText,
                    attachment_url: successful.map(s => s.url).join(','),
                    attachment_type: 'multiple',
                    attachment_metadata: { files: successful },
                    is_read: false,
                    created_at: new Date().toISOString()
                })
                .select()
                .single();

            if (msgError) throw msgError;

            // Update conversation
            await supabaseAdmin
                .from('chat_conversations')
                .update({
                    last_message: messageText,
                    last_message_at: new Date().toISOString()
                })
                .eq('id', id);
        }

        res.json({
            success: true,
            data: {
                uploaded: successful,
                failed: failed,
                total: files.length,
                successful_count: successful.length,
                failed_count: failed.length
            }
        });

    } catch (error) {
        console.error('Multiple upload error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 8. DELETE ATTACHMENT ───
router.delete('/messages/:messageId/attachment', authMiddleware, async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        // Get message
        const { data: message, error: msgError } = await supabaseAdmin
            .from('chat_messages')
            .select('*')
            .eq('id', messageId)
            .single();

        if (msgError || !message) {
            return res.status(404).json({
                success: false,
                error: 'Message not found'
            });
        }

        // Check ownership
        if (message.sender_id !== userId) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        // Delete from Cloudinary if exists
        if (message.attachment_url && message.attachment_url.includes('cloudinary.com')) {
            try {
                // Extract public_id from URL
                const urlParts = message.attachment_url.split('/');
                const publicId = urlParts.slice(urlParts.indexOf('upload') + 2).join('/').split('.')[0];
                
                if (publicId) {
                    await cloudinary.uploader.destroy(publicId);
                    console.log('🗑️ Deleted from Cloudinary:', publicId);
                }
            } catch (cloudinaryError) {
                console.error('Cloudinary delete error:', cloudinaryError);
                // Continue even if Cloudinary delete fails
            }
        }

        // Update message to remove attachment
        await supabaseAdmin
            .from('chat_messages')
            .update({
                attachment_url: null,
                attachment_type: null,
                attachment_metadata: null
            })
            .eq('id', messageId);

        res.json({
            success: true,
            message: 'Attachment deleted successfully'
        });

    } catch (error) {
        console.error('Delete attachment error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 9. ADMIN: GET ALL CONVERSATIONS ───
router.get('/admin/conversations', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, error: 'No token' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }

        const { limit = 50, offset = 0, status, search } = req.query;

        let query = supabaseAdmin
            .from('chat_conversations')
            .select(`
                *,
                user:profiles!user_id (
                    id,
                    email,
                    username,
                    avatar_url
                ),
                admin:profiles!admin_id (
                    id,
                    email,
                    username,
                    avatar_url
                ),
                messages:chat_messages (
                    id,
                    message,
                    created_at,
                    sender_id,
                    is_read,
                    attachment_url
                )
            `)
            .order('last_message_at', { ascending: false });

        if (status) query = query.eq('status', status);
        if (search) {
            query = query.or(`subject.ilike.%${search}%,user.username.ilike.%${search}%,user.email.ilike.%${search}%`);
        }

        const { data, count, error } = await query
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (error) throw error;

        const conversations = (data || []).map(c => ({
            ...c,
            unread_count: c.messages?.filter(m => !m.is_read && m.sender_id !== decoded.userId).length || 0,
            messages: c.messages?.slice(0, 1) || []
        }));

        res.json({
            success: true,
            data: conversations,
            total: count || 0
        });

    } catch (error) {
        console.error('Admin conversations error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 10. ADMIN: UPDATE CONVERSATION STATUS ───
router.put('/admin/conversations/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, error: 'No token' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }

        const { id } = req.params;
        const { status, assigned_to } = req.body;

        if (!status) {
            return res.status(400).json({
                success: false,
                error: 'Status is required'
            });
        }

        const updates = {
            status,
            updated_at: new Date().toISOString()
        };

        if (assigned_to) {
            updates.admin_id = assigned_to;
        }

        const { data, error } = await supabaseAdmin
            .from('chat_conversations')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        await createNotification(
            data.user_id,
            '📋 Conversation Updated',
            `Your conversation status has been changed to ${status}`,
            'info',
            `/messages`
        );

        if (global.io) {
            global.io.emit(`conversation:${id}:status`, {
                conversation_id: id,
                status,
                updated_at: data.updated_at
            });
        }

        res.json({
            success: true,
            message: 'Conversation updated',
            data
        });

    } catch (error) {
        console.error('Update conversation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 11. ADMIN: GET TICKET STATS ───
router.get('/admin/stats', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, error: 'No token' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }

        const [
            { count: open },
            { count: assigned },
            { count: inProgress },
            { count: resolved },
            { count: closed },
            { count: highPriority },
            { count: urgent }
        ] = await Promise.all([
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'open'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'assigned'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'in_progress'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'resolved'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'closed'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('priority', 'high'),
            supabaseAdmin.from('support_tickets').select('*', { count: 'exact', head: true }).eq('priority', 'urgent')
        ]);

        res.json({
            success: true,
            data: {
                open: open || 0,
                assigned: assigned || 0,
                in_progress: inProgress || 0,
                resolved: resolved || 0,
                closed: closed || 0,
                high_priority: highPriority || 0,
                urgent: urgent || 0,
                total: (open || 0) + (assigned || 0) + (inProgress || 0) + (resolved || 0) + (closed || 0)
            }
        });

    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 12. GET CONVERSATION BY TICKET NUMBER ───
router.get('/ticket/:ticketNumber', authMiddleware, async (req, res) => {
    try {
        const { ticketNumber } = req.params;
        const userId = req.user.id;

        const { data: ticket, error } = await supabaseAdmin
            .from('support_tickets')
            .select(`
                *,
                messages:ticket_messages (
                    *,
                    sender:profiles!sender_id (
                        id,
                        email,
                        username,
                        avatar_url
                    )
                )
            `)
            .eq('ticket_number', ticketNumber)
            .single();

        if (error || !ticket) {
            return res.status(404).json({
                success: false,
                error: 'Ticket not found'
            });
        }

        if (ticket.user_id !== userId) {
            const token = req.headers.authorization?.split(' ')[1];
            if (token) {
                const decoded = jwt.verify(token, JWT_SECRET);
                if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
                    return res.status(403).json({
                        success: false,
                        error: 'Access denied'
                    });
                }
            } else {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied'
                });
            }
        }

        res.json({
            success: true,
            data: ticket
        });

    } catch (error) {
        console.error('Get ticket error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 13. ADMIN: REPLY TO TICKET ───
router.post('/admin/tickets/:id/reply', authMiddleware, upload.single('attachment'), async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, error: 'No token' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }

        const { id } = req.params;
        const { message, is_internal = false } = req.body;
        const file = req.file;

        if (!message && !file) {
            return res.status(400).json({
                success: false,
                error: 'Message or attachment required'
            });
        }

        const { data: ticket, error: ticketError } = await supabaseAdmin
            .from('support_tickets')
            .select('*')
            .eq('id', id)
            .single();

        if (ticketError) {
            return res.status(404).json({
                success: false,
                error: 'Ticket not found'
            });
        }

        // Upload attachment to Cloudinary if exists
        let attachmentUrl = null;
        if (file) {
            try {
                const result = await uploadToCloudinary(file.buffer, {
                    folder: `milesspace/tickets/${id}`,
                    resource_type: 'auto',
                });
                attachmentUrl = result.secure_url;
            } catch (cloudinaryError) {
                console.error('Cloudinary upload error:', cloudinaryError);
            }
        }

        const { data: msg, error: msgError } = await supabaseAdmin
            .from('ticket_messages')
            .insert({
                ticket_id: id,
                sender_id: decoded.userId,
                sender_type: 'admin',
                message: message || '📎 Attachment',
                attachments: attachmentUrl ? [{ url: attachmentUrl }] : null,
                is_internal: is_internal || false,
                is_read: false,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (msgError) throw msgError;

        if (!is_internal) {
            await supabaseAdmin
                .from('support_tickets')
                .update({
                    status: 'in_progress',
                    updated_at: new Date().toISOString()
                })
                .eq('id', id);
        }

        if (!is_internal) {
            await createNotification(
                ticket.user_id,
                '📩 Admin Reply',
                `Admin replied to your ticket: ${ticket.subject}`,
                'info',
                `/tickets/${ticket.ticket_number}`
            );
        }

        if (global.io) {
            global.io.emit(`ticket:${id}:reply`, {
                message: msg,
                ticket_id: id,
                is_internal
            });
        }

        res.json({
            success: true,
            message: 'Reply added',
            data: msg
        });

    } catch (error) {
        console.error('Admin reply error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 14. ADMIN: GET ALL TICKETS ───
router.get('/admin/tickets', authMiddleware, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, error: 'No token' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }

        const { limit = 50, offset = 0, status, priority, category } = req.query;

        let query = supabaseAdmin
            .from('support_tickets')
            .select(`
                *,
                user:profiles!user_id (
                    id,
                    email,
                    username,
                    avatar_url
                ),
                assigned:profiles!assigned_to (
                    id,
                    email,
                    username
                )
            `)
            .order('created_at', { ascending: false });

        if (status) query = query.eq('status', status);
        if (priority) query = query.eq('priority', priority);
        if (category) query = query.eq('category', category);

        const { data, count, error } = await query
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (error) throw error;

        res.json({
            success: true,
            data: data || [],
            total: count || 0
        });

    } catch (error) {
        console.error('Admin tickets error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── 15. CLOUDINARY WEBHOOK (Optional) ───
router.post('/cloudinary/webhook', express.json(), async (req, res) => {
    try {
        const { notification_type, public_id, secure_url } = req.body;
        
        if (notification_type === 'upload') {
            console.log('📎 File uploaded to Cloudinary:', public_id);
            // Update database with Cloudinary info if needed
        }
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Cloudinary webhook error:', error);
        res.status(500).json({ success: false });
    }
});

module.exports = router;