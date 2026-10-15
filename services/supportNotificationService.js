'use strict';

const { supabaseAdmin } = require('../db/supabase');

// ─────────────────────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────────────────────
// A "burst" is a window of conversation activity. Once we send a
// reply email, we will not send another for BURST_WINDOW_MINUTES.
// Lifecycle events (resolved, closed, reopened, created, assigned)
// always email — they are discrete, not chatter.
const BURST_WINDOW_MINUTES = 30;
const BURST_COLUMN = 'last_reply_email_at';

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
//  Notification templates
// ─────────────────────────────────────────────────────────────
var TPL = {
    ticket_created: function (t) {
        return {
            title: '🎫 Ticket created',
            message: 'Your ticket ' + t.ticket_number + ' has been created. We will respond shortly.'
        };
    },
    ticket_assigned: function (t, agent) {
        return {
            title: '📋 Ticket assigned',
            message: 'Your ticket ' + t.ticket_number + ' has been assigned' + (agent ? ' to ' + agent : '') + '.'
        };
    },
    ticket_reply: function (t) {
        return {
            title: '📩 New reply',
            message: 'Support replied on ticket ' + t.ticket_number + '.'
        };
    },
    ticket_resolved: function (t) {
        return {
            title: '✅ Ticket resolved',
            message: 'Your ticket ' + t.ticket_number + ' has been resolved.'
        };
    },
    ticket_closed: function (t) {
        return {
            title: '📁 Ticket closed',
            message: 'Your ticket ' + t.ticket_number + ' has been closed.'
        };
    },
    ticket_reopened: function (t) {
        return {
            title: '🔄 Ticket reopened',
            message: 'Your ticket ' + t.ticket_number + ' has been reopened.'
        };
    }
};

function buildDedupe(event, ticket, messageId, extra) {
    if (event === 'ticket_reply') return 'ticket_reply:' + messageId;
    if (event === 'ticket_assigned') return 'ticket_assigned:' + ticket.id + ':' + ((extra && extra.agentId) || '');
    return event + ':' + ticket.id;
}

// ─────────────────────────────────────────────────────────────
//  Burst window
// ─────────────────────────────────────────────────────────────
// True when a new reply email may be sent for this ticket. Reads
// support_tickets.last_reply_email_at.
//
// Callers should always pass a freshly-read ticket row that
// includes last_reply_email_at. If the column is missing from the
// row, we treat it as "never sent" and allow the email — the
// burst check is best-effort, not a hard gate that could silence
// a legitimate first email.
function shouldSendReplyEmail(ticket) {
    if (!ticket) return true;
    var raw = ticket[BURST_COLUMN];
    if (!raw) return true;
    var last = new Date(raw).getTime();
    if (!Number.isFinite(last)) return true;
    return (Date.now() - last) > (BURST_WINDOW_MINUTES * 60 * 1000);
}

// Persist the moment we sent a reply email. Called right after the
// email_outbox row is inserted, so a retry of the same logical
// send cannot double-log.
async function markReplyEmailSent(ticketId) {
    if (!ticketId) return;
    try {
        await supabaseAdmin
            .from('support_tickets')
            .update({ last_reply_email_at: new Date().toISOString() })
            .eq('id', ticketId);
    } catch (e) {
        console.warn('[supportNotifications] markReplyEmailSent failed:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────
//  In-app customer notification (deduped)
// ─────────────────────────────────────────────────────────────
async function notifyCustomer(opts) {
    opts = opts || {};
    var event = opts.event;
    var ticket = opts.ticket;
    var messageId = opts.messageId;
    var extra = opts.extra;

    if (!ticket || !ticket.user_id) return { ok: true, skipped: 'no_user' };
    var tpl = TPL[event];
    if (!tpl) return { ok: false, reason: 'unknown_event' };

    var data = tpl(ticket, extra && extra.agentName);
    var dedupeKey = buildDedupe(event, ticket, messageId, extra);

    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: ticket.user_id,
            title: data.title,
            message: data.message,
            type: event,
            link: '/support/ticket/' + ticket.ticket_number,
            metadata: { ticket_id: ticket.id },
            is_read: false,
            dedupe_key: dedupeKey,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        // 23505 = already exists. Any other error is logged.
        if (!/23505|duplicate/.test(String(e.message))) {
            console.warn('[supportNotifications] insert failed:', e.message);
        }
    }

    if (global.io) {
        try {
            global.io.to('user:' + ticket.user_id).emit('notification:receive', {
                title: data.title,
                message: data.message,
                link: '/support/ticket/' + ticket.ticket_number,
                created_at: new Date().toISOString()
            });
        } catch (_) {}
    }
    return { ok: true };
}

// ─────────────────────────────────────────────────────────────
//  Customer email (queued via email_outbox)
// ─────────────────────────────────────────────────────────────
// Reply emails are bursted. Lifecycle emails are not.
async function queueCustomerEmail(opts) {
    opts = opts || {};
    var ticket = opts.ticket;
    var messageBody = opts.messageBody;
    var event = opts.event;
    var dedupeExtra = opts.dedupeExtra;

    if (!ticket || !ticket.user_id) return { queued: false, reason: 'no_user' };

    // Burst gate: only for the reply event.
    if (event === 'ticket_reply' && !shouldSendReplyEmail(ticket)) {
        return { queued: false, reason: 'burst_suppressed' };
    }

    var profileResult;
    try {
        profileResult = await supabaseAdmin
            .from('profiles')
            .select('email, username')
            .eq('id', ticket.user_id)
            .maybeSingle();
    } catch (e) {
        console.warn('[supportNotifications] profile lookup failed:', e.message);
        return { queued: false, reason: 'profile_lookup_failed' };
    }
    var profile = profileResult && profileResult.data;
    if (!profile || !profile.email) return { queued: false, reason: 'no_email' };

    var base = (process.env.APP_URL || process.env.SITE_URL || '').replace(/\/+$/, '');
    var url = base + '/support/ticket/' + encodeURIComponent(ticket.ticket_number);

    var subjectMap = {
        ticket_reply:    'Reply on ' + ticket.ticket_number + ' — ' + ticket.subject,
        ticket_resolved: 'Ticket ' + ticket.ticket_number + ' resolved',
        ticket_closed:   'Ticket ' + ticket.ticket_number + ' closed',
        ticket_reopened: 'Ticket ' + ticket.ticket_number + ' reopened',
        ticket_assigned: 'Ticket ' + ticket.ticket_number + ' assigned',
        ticket_created:  'Ticket ' + ticket.ticket_number + ' received'
    };
    var subject = String(subjectMap[event] || ('Update on ' + ticket.ticket_number)).slice(0, 200);

    var bodyBlock = messageBody
        ? '<div style="background:#f4f7fb;padding:14px 16px;border-radius:10px;white-space:pre-wrap;color:#0c3d4a;font-size:14px;line-height:1.55">' +
          escapeHtml(String(messageBody).slice(0, 2000)) +
          '</div>'
        : '<p style="color:#4a6070;font-size:14px">' +
          escapeHtml(TPL[event] ? TPL[event](ticket).message : 'Your ticket has been updated.') +
          '</p>';

    var html =
        '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6f8;padding:32px 20px">' +
            '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 24px">' +
                '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8fa3ab;font-weight:700;margin-bottom:6px">MilesSpace Support</div>' +
                '<h2 style="margin:0 0 12px;font-size:18px;color:#0c3d4a">' + escapeHtml(subject) + '</h2>' +
                '<p style="color:#4a6070;font-size:14px">Hi — an update on <strong>' + escapeHtml(ticket.subject) + '</strong> (' + escapeHtml(ticket.ticket_number) + ').</p>' +
                bodyBlock +
                '<p style="margin-top:18px"><a href="' + escapeHtml(url) + '" style="display:inline-block;background:#0c3d4a;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 18px;border-radius:10px">Open your ticket</a></p>' +
            '</div>' +
        '</div>';

    var dedupeKey = event === 'ticket_reply'
        ? 'support_reply:' + ticket.id + ':' + (dedupeExtra || '')
        : 'support_' + event + ':' + ticket.id + ':' + profile.email;

    try {
        await supabaseAdmin.from('email_outbox').insert({
            to_email: profile.email,
            subject: subject,
            html: html,
            purpose: 'support_' + event,
            dedupe_key: dedupeKey,
            status: 'pending',
            attempts: 0,
            created_at: new Date().toISOString()
        });

        if (event === 'ticket_reply') {
            await markReplyEmailSent(ticket.id);
        }

        return { queued: true };
    } catch (e) {
        if (!/23505|duplicate/.test(String(e.message))) {
            console.warn('[supportNotifications] email queue failed:', e.message);
        }
        return { queued: false };
    }
}

// ─────────────────────────────────────────────────────────────
//  Guest access link
// ─────────────────────────────────────────────────────────────
async function queueGuestAccessEmail(opts) {
    opts = opts || {};
    var ticket = opts.ticket;
    var guestEmail = opts.guestEmail;
    var guestName = opts.guestName;
    var rawToken = opts.rawToken;

    if (!guestEmail) return { queued: false };

    var base = (process.env.APP_URL || process.env.SITE_URL || '').replace(/\/+$/, '');
    var url = base + '/support/guest?token=' + encodeURIComponent(rawToken);

    var html =
        '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6f8;padding:32px 20px">' +
            '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 24px">' +
                '<h2 style="margin:0 0 12px;font-size:18px;color:#0c3d4a">We have your request</h2>' +
                '<p style="color:#4a6070;font-size:14px">Hi ' + escapeHtml(guestName || 'there') + ' — ticket ' + escapeHtml(ticket.ticket_number) + ' was created. Use the secure link below to view updates and reply.</p>' +
                '<p style="margin-top:18px"><a href="' + escapeHtml(url) + '" style="display:inline-block;background:#0c3d4a;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 18px;border-radius:10px">Open your ticket</a></p>' +
                '<p style="color:#92a8b4;font-size:12px;margin-top:22px">This link is unique to you. Do not share it.</p>' +
            '</div>' +
        '</div>';

    try {
        await supabaseAdmin.from('email_outbox').insert({
            to_email: guestEmail,
            subject: ('Your support ticket — ' + ticket.ticket_number).slice(0, 200),
            html: html,
            purpose: 'support_guest_access',
            dedupe_key: 'support_guest_access:' + ticket.id + ':' + guestEmail,
            status: 'pending',
            attempts: 0,
            created_at: new Date().toISOString()
        });
        return { queued: true };
    } catch (e) {
        if (!/23505|duplicate/.test(String(e.message))) {
            console.warn('[supportNotifications] guest email failed:', e.message);
        }
        return { queued: false };
    }
}

module.exports = {
    notifyCustomer: notifyCustomer,
    queueCustomerEmail: queueCustomerEmail,
    queueGuestAccessEmail: queueGuestAccessEmail,
    escapeHtml: escapeHtml,
    shouldSendReplyEmail: shouldSendReplyEmail,
    markReplyEmailSent: markReplyEmailSent,
    BURST_WINDOW_MINUTES: BURST_WINDOW_MINUTES
};