// services/supportSocketService.js - Real-time support events
const { supabaseAdmin } = require('../db/supabase');

class SupportSocketService {
    constructor(io) {
        this.io = io;
        this.typingUsers = new Map(); // userId -> { ticketId, timeout }
        this.setupEvents();
    }

    setupEvents() {
        this.io.on('connection', (socket) => {
            // ─── TYPING INDICATORS ──────────────────────────────────
            socket.on('support:typing:start', async (data) => {
                const { ticketId } = data;
                const userId = socket.userId;
                const isAdmin = socket.userRole === 'admin' || socket.userRole === 'super_admin';

                if (!ticketId) return;

                // Clear existing timeout
                const key = `${userId}-${ticketId}`;
                if (this.typingUsers.has(key)) {
                    clearTimeout(this.typingUsers.get(key));
                }

                // Emit typing to other party
                const room = isAdmin ? `user:${socket.userId}` : 'admins';
                this.io.to(room).emit('support:typing:start', {
                    ticketId,
                    userId,
                    isAdmin,
                    username: socket.userName || 'User',
                });

                // Auto-stop after 3 seconds of inactivity
                const timeout = setTimeout(() => {
                    this.io.to(room).emit('support:typing:stop', {
                        ticketId,
                        userId,
                    });
                    this.typingUsers.delete(key);
                }, 3000);

                this.typingUsers.set(key, timeout);
            });

            socket.on('support:typing:stop', (data) => {
                const { ticketId } = data;
                const userId = socket.userId;
                const isAdmin = socket.userRole === 'admin' || socket.userRole === 'super_admin';

                const key = `${userId}-${ticketId}`;
                if (this.typingUsers.has(key)) {
                    clearTimeout(this.typingUsers.get(key));
                    this.typingUsers.delete(key);
                }

                const room = isAdmin ? `user:${socket.userId}` : 'admins';
                this.io.to(room).emit('support:typing:stop', {
                    ticketId,
                    userId,
                });
            });

            // ─── MESSAGE DELIVERY STATUS ──────────────────────────
            socket.on('support:message:delivered', async (data) => {
                const { messageId, ticketId } = data;
                // Update message delivered status in database
                await supabaseAdmin
                    .from('ticket_messages')
                    .update({ delivered_at: new Date().toISOString() })
                    .eq('id', messageId);
            });

            socket.on('support:message:read', async (data) => {
                const { messageId, ticketId } = data;
                // Update message read status
                const isAdmin = socket.userRole === 'admin' || socket.userRole === 'super_admin';
                const updateField = isAdmin ? 'read_by_admin_at' : 'read_by_user_at';
                
                await supabaseAdmin
                    .from('ticket_messages')
                    .update({ [updateField]: new Date().toISOString() })
                    .eq('id', messageId);
            });

            // ─── TICKET UPDATES ─────────────────────────────────────
            socket.on('support:ticket:view', async (data) => {
                const { ticketId } = data;
                const userId = socket.userId;
                const isAdmin = socket.userRole === 'admin' || socket.userRole === 'super_admin';

                // Mark messages as read
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
            });

            // ─── JOIN TICKET ROOM ──────────────────────────────────
            socket.on('support:ticket:join', (data) => {
                const { ticketId } = data;
                socket.join(`ticket:${ticketId}`);
            });

            socket.on('support:ticket:leave', (data) => {
                const { ticketId } = data;
                socket.leave(`ticket:${ticketId}`);
            });

            // ─── DISCONNECT ─────────────────────────────────────────
            socket.on('disconnect', () => {
                // Clear all typing indicators for this user
                for (const [key, timeout] of this.typingUsers) {
                    if (key.startsWith(socket.userId)) {
                        clearTimeout(timeout);
                        this.typingUsers.delete(key);
                    }
                }
            });
        });
    }

    // ─── EMIT NEW MESSAGE ────────────────────────────────────────────
    emitNewMessage(ticketId, message, senderId, isAdmin) {
        const room = `ticket:${ticketId}`;
        this.io.to(room).emit('support:message:new', {
            ticketId,
            message,
            senderId,
            isAdmin,
            timestamp: new Date().toISOString(),
        });
    }

    // ─── EMIT TICKET UPDATE ──────────────────────────────────────────
    emitTicketUpdate(ticketId, updateData) {
        const room = `ticket:${ticketId}`;
        this.io.to(room).emit('support:ticket:updated', {
            ticketId,
            ...updateData,
            timestamp: new Date().toISOString(),
        });
    }

    // ─── EMIT UNREAD UPDATE ──────────────────────────────────────────
    emitUnreadUpdate(userId, unreadCount) {
        this.io.to(`user:${userId}`).emit('support:unread:updated', {
            unreadCount,
            timestamp: new Date().toISOString(),
        });
    }

    // ─── EMIT TYPING ──────────────────────────────────────────────────
    emitTyping(ticketId, userId, username, isAdmin) {
        const room = `ticket:${ticketId}`;
        this.io.to(room).emit('support:typing', {
            ticketId,
            userId,
            username,
            isAdmin,
            timestamp: new Date().toISOString(),
        });
    }

    // ─── EMIT TICKET ASSIGNED ────────────────────────────────────────
    emitTicketAssigned(ticketId, assignedTo) {
        const room = `ticket:${ticketId}`;
        this.io.to(room).emit('support:ticket:assigned', {
            ticketId,
            assignedTo,
            timestamp: new Date().toISOString(),
        });
    }
}

module.exports = SupportSocketService;