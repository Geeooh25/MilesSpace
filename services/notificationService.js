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
// ─── ADMIN NEW-TICKET ALERT ─────────────────────────────────────
// Sends (via the outbox) one email to admins when a customer
// opens a ticket. Recipients and enable flag come from app_config
// so you can turn this on or off without a redeploy.
//
// ─── ADMIN NEW-TICKET ALERT ─────────────────────────────────────
// Sends (via the outbox) one email to admins when a customer
// opens a ticket. Recipients and enable flag come from app_config.
//
// Every branch logs so an empty queue is never a mystery.
async function notifyAdminsOfNewTicket({ ticket, firstMessage, customer, req }) {
    const TAG = '[NOTIFY ADMIN]';
    try {
        // ── Step 1: read app_config ─────────────────────────────
        let raw = null;
        let readError = null;
        try {
            const { data, error } = await supabaseAdmin
                .from('app_config')
                .select('value')
                .eq('key', 'support_admin_alert_recipients')
                .maybeSingle();
            if (error) readError = error;
            raw = data ? data.value : null;
        } catch (e) {
            readError = e;
        }

        if (readError) {
            console.warn(TAG, 'app_config read failed:', readError.message);
            return { queued: false, reason: 'config_unavailable', error: readError.message };
        }

        // app_config.value may be jsonb (object) or text (string).
        let config = raw;
        if (typeof config === 'string') {
            try { config = JSON.parse(config); }
            catch (e) { config = null; }
        }

        if (!config) {
            console.warn(TAG, 'no config row for key "support_admin_alert_recipients" — skipping admin alert.');
            return { queued: false, reason: 'no_config_row' };
        }

        if (config.enabled === false) {
            console.warn(TAG, 'config.enabled is false — skipping admin alert.');
            return { queued: false, reason: 'disabled' };
        }

        const recipients = Array.isArray(config.emails)
            ? config.emails.filter(function (e) {
                return typeof e === 'string' && e.indexOf('@') > 0;
            })
            : [];

        if (!recipients.length) {
            console.warn(TAG, 'config.emails is empty or has no valid addresses — skipping admin alert.');
            return { queued: false, reason: 'no_recipients' };
        }

        console.log(TAG, 'ticket', ticket.ticket_number, '→ queuing for', recipients.length, 'recipient(s)');

        // ── Step 2: build the email ─────────────────────────────
        const subjectText  = String(ticket.subject || '(no subject)').slice(0, 120);
        const categoryText = String(ticket.category || 'other');
        const priorityText = String(ticket.priority || 'medium');
        const ticketNumber = String(ticket.ticket_number || '');
        const customerName =
            (customer && (customer.username || customer.email)) ||
            (ticket.contact_name || ticket.contact_email) ||
            'Unknown';

        const summary =
            '<p><strong>' + escapeHtml(subjectText) + '</strong></p>' +
            '<table style="font-size:13px;color:#4a6070;border-collapse:collapse">' +
                '<tr><td style="padding:3px 10px 3px 0">Ticket</td>' +
                    '<td style="padding:3px 0;font-weight:700;color:#0c3d4a">' + escapeHtml(ticketNumber) + '</td></tr>' +
                '<tr><td style="padding:3px 10px 3px 0">Customer</td>' +
                    '<td style="padding:3px 0;font-weight:700;color:#0c3d4a">' + escapeHtml(customerName) + '</td></tr>' +
                '<tr><td style="padding:3px 10px 3px 0">Category</td>' +
                    '<td style="padding:3px 0;font-weight:700;color:#0c3d4a">' + escapeHtml(categoryText) + '</td></tr>' +
                '<tr><td style="padding:3px 10px 3px 0">Priority</td>' +
                    '<td style="padding:3px 0;font-weight:700;color:#0c3d4a">' + escapeHtml(priorityText) + '</td></tr>' +
            '</table>' +
            '<p style="margin-top:14px;background:#f4f7fb;padding:12px;border-radius:8px;white-space:pre-wrap">' +
                escapeHtml(String(firstMessage || ticket.description || '').slice(0, 1200)) +
            '</p>' +
            '<p style="margin-top:16px">' +
                '<a href="' + adminTicketUrl(ticket) + '" ' +
                   'style="display:inline-block;background:#0c3d4a;color:#fff;text-decoration:none;' +
                   'font-weight:700;font-size:13px;padding:10px 18px;border-radius:10px">' +
                   'Open in admin' +
                '</a>' +
            '</p>';

        const html =
            '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;' +
                        'background:#f4f6f8;padding:32px 20px;margin:0">' +
                '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;' +
                            'padding:28px 24px;box-shadow:0 4px 14px rgba(0,0,0,0.05)">' +
                    '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;' +
                                'color:#8fa3ab;font-weight:700;margin-bottom:6px">MilesSpace Support</div>' +
                    '<h2 style="margin:0 0 12px;font-size:18px;color:#0c3d4a">New support ticket</h2>' +
                    summary +
                    '<p style="color:#92a8b4;font-size:12px;margin-top:22px">' +
                        'You are receiving this because you are listed as a support alert recipient.' +
                    '</p>' +
                '</div>' +
            '</div>';

        // ── Step 3: insert one row per recipient ────────────────
        const queued = [];
        for (let i = 0; i < recipients.length; i++) {
            const to = recipients[i];
            const dedupeKey = 'support_admin_alert:' + ticket.id + ':' + to;
            try {
                const { data: inserted, error: insErr } = await supabaseAdmin
                    .from('email_outbox')
                    .insert({
                        to_email:    to,
                        subject:     '[Support] ' + ticketNumber + ' — ' + subjectText,
                        html:        html,
                        purpose:     'support_admin_alert',
                        dedupe_key:  dedupeKey,
                        status:      'pending',
                        attempts:    0,
                        created_at:  new Date().toISOString()
                    })
                    .select('id')
                    .single();

                if (insErr) {
                    // Unique-violation on dedupe_key means the email is
                    // already queued for this ticket + recipient.
                    if (insErr.code === '23505') {
                        console.log(TAG, 'row already queued for', to, '(dedupe)');
                        queued.push(to);
                        continue;
                    }
                    console.warn(TAG, 'outbox insert failed for', to, ':', insErr.message, insErr.code);
                    continue;
                }
                console.log(TAG, 'queued outbox row', inserted && inserted.id, '→', to);
                queued.push(to);
            } catch (e) {
                console.warn(TAG, 'outbox insert threw for', to, ':', e && e.message);
            }
        }

        return { queued: queued.length > 0, recipients: queued };
    } catch (e) {
        console.warn(TAG, 'unexpected failure:', e && e.message);
        return { queued: false, reason: 'error', error: e && e.message };
    }
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
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

function adminTicketUrl(ticket) {
    // Prefer the ticket number for readability, fall back to id.
    var base = process.env.APP_URL || process.env.SITE_URL || '';
    base = base.replace(/\/+$/, '');
    var ref = ticket && (ticket.ticket_number || ticket.id);
    return base + '/admin/support?ticket=' + encodeURIComponent(String(ref || ''));
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
    getTicketNotificationTemplates,
    notifyAdminsOfNewTicket
};