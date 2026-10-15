'use strict';

const { supabaseAdmin } = require('../db/supabase');
const support = require('./supportService');

const MAX_TYPING_ENTRIES = 500;

class SupportSocketService {
    constructor(io) {
        this.io = io;
        this.typingUsers = new Map(); // `${userId}-${ticketId}` -> timeout
        this.setupEvents();
    }

    setupEvents() {
        this.io.on('connection', (socket) => {
            const userId   = socket.userId;
            const userRole = socket.userRole;
            const userName = socket.userName || 'User';
            const isAdmin  = userRole === 'admin' || userRole === 'super_admin';

            // ─── TYPING ─────────────────────────────────────────
            socket.on('support:typing:start', (data) => {
                const ticketId = data?.ticketId;
                if (!ticketId) return;

                const key = `${userId}-${ticketId}`;
                const prev = this.typingUsers.get(key);
                if (prev) clearTimeout(prev);

                const room = isAdmin ? `user:${userId}` : 'admins';
                this.io.to(room).emit('support:typing:start', {
                    ticketId, userId, isAdmin, username: userName
                });

                const timeout = setTimeout(() => {
                    this.io.to(room).emit('support:typing:stop', { ticketId, userId });
                    this.typingUsers.delete(key);
                }, 3000);
                this.typingUsers.set(key, timeout);

                // Bounded — refuse to hold more than MAX_TYPING_ENTRIES.
                if (this.typingUsers.size > MAX_TYPING_ENTRIES) {
                    const oldest = this.typingUsers.keys().next().value;
                    clearTimeout(this.typingUsers.get(oldest));
                    this.typingUsers.delete(oldest);
                }
            });

            socket.on('support:typing:stop', (data) => {
                const ticketId = data?.ticketId;
                if (!ticketId) return;
                const key = `${userId}-${ticketId}`;
                const prev = this.typingUsers.get(key);
                if (prev) clearTimeout(prev);
                this.typingUsers.delete(key);

                const room = isAdmin ? `user:${userId}` : 'admins';
                this.io.to(room).emit('support:typing:stop', { ticketId, userId });
            });

            // ─── DELIVERY + READ ────────────────────────────────
            socket.on('support:message:delivered', async (data) => {
                const messageId = data?.messageId;
                if (!messageId) return;
                try {
                    await supabaseAdmin
                        .from('ticket_messages')
                        .update({ delivered_at: new Date().toISOString() })
                        .eq('id', messageId);
                } catch (_) {}
            });

            socket.on('support:message:read', async (data) => {
                const messageId = data?.messageId;
                const ticketId  = data?.ticketId;
                if (!messageId) return;
                try {
                    const patch = isAdmin
                        ? { read_at: new Date().toISOString(), is_read: true, read_by_admin_at: new Date().toISOString() }
                        : { read_at: new Date().toISOString(), is_read: true, read_by_user_at:  new Date().toISOString() };
                    await supabaseAdmin
                        .from('ticket_messages')
                        .update(patch)
                        .eq('id', messageId);

                    if (ticketId && isAdmin) {
                        await supabaseAdmin
                            .from('support_tickets')
                            .update({ last_read_by_admin_at: new Date().toISOString() })
                            .eq('id', ticketId);
                    }
                } catch (_) {}
            });

            // ─── JOIN / LEAVE TICKET ROOMS ──────────────────────
            socket.on('support:ticket:join', (data) => {
                const ticketId = data?.ticketId;
                if (ticketId) socket.join(`ticket:${ticketId}`);
            });
            socket.on('support:ticket:leave', (data) => {
                const ticketId = data?.ticketId;
                if (ticketId) socket.leave(`ticket:${ticketId}`);
            });

            socket.on('support:ticket:view', async (data) => {
                const ticketId = data?.ticketId;
                if (!ticketId) return;
                // Route through the service so there is one writer.
                try {
                    await support.getTicket({ id: ticketId, viewerId: userId });
                } catch (_) {}
            });

            socket.on('disconnect', () => {
                for (const [key, timeout] of this.typingUsers) {
                    if (key.startsWith(`${userId}-`)) {
                        clearTimeout(timeout);
                        this.typingUsers.delete(key);
                    }
                }
            });
        });
    }

    emitNewMessage(ticketId, message, senderId, isAdmin) {
        this.io.to(`ticket:${ticketId}`).emit('support:message:new', {
            ticketId, message, senderId, isAdmin,
            timestamp: new Date().toISOString()
        });
    }

    emitTicketUpdate(ticketId, updateData) {
        this.io.to(`ticket:${ticketId}`).emit('support:ticket:updated', {
            ticketId, ...updateData,
            timestamp: new Date().toISOString()
        });
    }

    emitUnreadUpdate(userId, unreadCount) {
        this.io.to(`user:${userId}`).emit('support:unread:updated', {
            unreadCount,
            timestamp: new Date().toISOString()
        });
    }

    emitTyping(ticketId, userId, username, isAdmin) {
        this.io.to(`ticket:${ticketId}`).emit('support:typing', {
            ticketId, userId, username, isAdmin,
            timestamp: new Date().toISOString()
        });
    }

    emitTicketAssigned(ticketId, assignedTo) {
        this.io.to(`ticket:${ticketId}`).emit('support:ticket:assigned', {
            ticketId, assignedTo,
            timestamp: new Date().toISOString()
        });
    }
}

module.exports = SupportSocketService;