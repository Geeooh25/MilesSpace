// services/notificationService.js - Complete Notification System
const { supabaseAdmin } = require('../db/supabase');

// ─── CREATE NOTIFICATION ────────────────────────────────────────────

async function createNotification(userId, title, message, type = 'info', link = null, metadata = {}) {
    try {
        if (!userId) {
            console.warn('⚠️ createNotification called without userId');
            return null;
        }

        const payload = {
            user_id: userId,
            title: title || 'Notification',
            message: message || '',
            type: type || 'info',
            icon: getIconForType(type),
            link: link || null,
            metadata: metadata || {},
            is_read: false,
            created_at: new Date().toISOString()
        };

        const { data, error } = await supabaseAdmin
            .from('notifications')
            .insert(payload)
            .select()
            .single();

        if (error) {
            console.error('❌ Create notification error:', error);
            return null;
        }

        // Emit via Socket.IO if available
        if (global.io) {
            global.io.to(`user:${userId}`).emit('notification:receive', {
                id: data.id,
                title: data.title,
                message: data.message,
                type: data.type,
                icon: data.icon,
                link: data.link,
                created_at: data.created_at
            });
        }

        return data;
    } catch (error) {
        console.error('❌ createNotification error:', error);
        return null;
    }
}

// ─── GET ICON FOR TYPE ─────────────────────────────────────────────

function getIconForType(type) {
    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: '📌',
        ticket: '🎫',
        reply: '📩',
        resolved: '🎉',
        closed: '📁',
        payment: '💰',
        withdrawal: '💸',
        crypto: '₿',
        gift: '🎁',
        cashback: '⭐',
        security: '🔐',
        account: '👤'
    };
    return icons[type] || '📌';
}

// ─── GET NOTIFICATIONS ─────────────────────────────────────────────

async function getNotifications(userId, options = {}) {
    const { limit = 50, unreadOnly = false, offset = 0 } = options;

    try {
        let query = supabaseAdmin
            .from('notifications')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (unreadOnly) {
            query = query.eq('is_read', false);
        }

        const { data, count, error } = await query
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (error) throw error;
        return { success: true, data: data || [], count: count || 0 };
    } catch (error) {
        console.error('❌ getNotifications error:', error);
        return { success: false, data: [], count: 0, error: error.message };
    }
}

// ─── GET UNREAD COUNT ──────────────────────────────────────────────

async function getUnreadCount(userId) {
    try {
        const { count, error } = await supabaseAdmin
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        if (error) throw error;
        return { success: true, count: count || 0 };
    } catch (error) {
        console.error('❌ getUnreadCount error:', error);
        return { success: false, count: 0, error: error.message };
    }
}

// ─── MARK AS READ ──────────────────────────────────────────────────

async function markNotificationAsRead(userId, notificationId) {
    try {
        const { error } = await supabaseAdmin
            .from('notifications')
            .update({
                is_read: true,
                read_at: new Date().toISOString()
            })
            .eq('id', notificationId)
            .eq('user_id', userId);

        if (error) throw error;
        return { success: true };
    } catch (error) {
        console.error('❌ markNotificationAsRead error:', error);
        return { success: false, error: error.message };
    }
}

// ─── MARK ALL AS READ ──────────────────────────────────────────────

async function markAllNotificationsAsRead(userId) {
    try {
        const { error } = await supabaseAdmin
            .from('notifications')
            .update({
                is_read: true,
                read_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('is_read', false);

        if (error) throw error;
        return { success: true };
    } catch (error) {
        console.error('❌ markAllNotificationsAsRead error:', error);
        return { success: false, error: error.message };
    }
}

// ─── DELETE NOTIFICATION ──────────────────────────────────────────

async function deleteNotification(userId, notificationId) {
    try {
        const { error } = await supabaseAdmin
            .from('notifications')
            .delete()
            .eq('id', notificationId)
            .eq('user_id', userId);

        if (error) throw error;
        return { success: true };
    } catch (error) {
        console.error('❌ deleteNotification error:', error);
        return { success: false, error: error.message };
    }
}

// ─── NOTIFICATION TEMPLATES ────────────────────────────────────────

function getTicketNotificationTemplates() {
    return {
        ticketCreated: (ticketNumber, subject) => ({
            title: '🎫 Ticket Created',
            message: `Your ticket ${ticketNumber} has been created. We'll respond shortly.`,
            type: 'ticket',
            link: `/support/ticket/${ticketNumber}`
        }),
        ticketAssigned: (ticketNumber, agentName) => ({
            title: '📋 Ticket Assigned',
            message: `Your ticket ${ticketNumber} has been assigned to ${agentName}.`,
            type: 'info',
            link: `/support/ticket/${ticketNumber}`
        }),
        adminReply: (ticketNumber, subject) => ({
            title: '📩 Admin Reply',
            message: `Admin replied to your ticket: ${subject}`,
            type: 'reply',
            link: `/support/ticket/${ticketNumber}`
        }),
        userReply: (ticketNumber, username) => ({
            title: '📤 New Message',
            message: `${username} replied to ticket ${ticketNumber}`,
            type: 'reply',
            link: `/admin/support/ticket/${ticketNumber}`
        }),
        ticketResolved: (ticketNumber) => ({
            title: '✅ Ticket Resolved',
            message: `Your ticket ${ticketNumber} has been resolved.`,
            type: 'resolved',
            link: `/support/ticket/${ticketNumber}`
        }),
        ticketClosed: (ticketNumber) => ({
            title: '📁 Ticket Closed',
            message: `Your ticket ${ticketNumber} has been closed.`,
            type: 'closed',
            link: `/support/ticket/${ticketNumber}`
        })
    };
}

// ─── EXPORT ──────────────────────────────────────────────────────

module.exports = {
    createNotification,
    getNotifications,
    getUnreadCount,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    deleteNotification,
    getIconForType,
    getTicketNotificationTemplates
};