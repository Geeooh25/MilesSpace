// services/notificationFanoutService.js
// ─────────────────────────────────────────────────────────────────
// Fan-out layer for admin-created notifications.
//
// Responsibilities:
//   - Given a notification, resolve the recipient set:
//       recipient_type = 'admin'  → all admin roles
//       recipient_type = 'user'   → one user by id
//       recipient_type = 'all'    → all users (paginated)
//       recipient_type = 'both'   → admins + all users
//   - Send an email to each recipient using emailService.sendEmail.
//   - Insert a row into `notifications` for every USER recipient
//     so they see it in their in-app bell (existing behaviour).
//   - Emit Socket.IO to user:{id} for live in-app delivery.
//
// Never blocks the caller — dispatch is fire-and-forget.
// Failures are logged and counted but never bubble up.
//
// Caps:
//   MAX_BULK_EMAILS   — hard ceiling per fan-out (default 5000)
//   BATCH_SIZE        — rows per page when listing users
//   CONCURRENCY       — parallel email sends (SMTP pools don't like
//                       hundreds at once; 8 is safe for Gmail)
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const emailService = require('./emailService');

const MAX_BULK_EMAILS = Number(process.env.NOTIFICATION_MAX_BULK_EMAILS) || 5000;
const BATCH_SIZE      = 500;
const CONCURRENCY     = 8;

const ADMIN_ROLES = ['super_admin','admin','finance','operations','support','auditor','read_only'];

// ─── HTML template ──────────────────────────────────────────────
function renderEmailHtml({ title, message, type, link, reference, priority }) {
    const SITE_URL = process.env.SITE_URL || 'https://milesspace.com';
    const safe = (v) => String(v == null ? '' : v)
        .replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

    const accent = ({
        error:   '#dc2626',
        warning: '#f59e0b',
        success: '#16a34a',
        info:    '#2563a8'
    }[String(type || 'info').toLowerCase()]) || '#0f4c5c';

    const cta = link
        ? `<div style="text-align:center;margin-top:24px">
             <a href="${safe(link.startsWith('http') ? link : SITE_URL + link)}"
                style="display:inline-block;background:#0f4c5c;color:#fff;text-decoration:none;
                       font-weight:600;font-size:13.5px;padding:12px 22px;border-radius:10px">
                Open in MilesSpace
             </a>
           </div>`
        : '';

    const refBlock = reference
        ? `<p style="font-size:12px;color:#92a8b4;text-align:center;margin:14px 0 0">
             Reference: <span style="font-family:monospace;color:#0c3d4a">${safe(reference)}</span>
           </p>`
        : '';

    const priorityBadge = (priority && priority !== 'normal')
        ? `<div style="text-align:center;margin-bottom:12px">
             <span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;
                          text-transform:uppercase;padding:3px 10px;border-radius:99px;
                          background:${accent};color:#fff">${safe(priority)}</span>
           </div>`
        : '';

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
             background:#f4f6f8;padding:40px 20px;margin:0">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;
              padding:40px 32px;box-shadow:0 4px 14px rgba(0,0,0,.06)">
    ${priorityBadge}
    <h2 style="font-size:20px;font-weight:700;color:#0c3d4a;margin:0 0 12px;text-align:center">
      ${safe(title)}
    </h2>
    <div style="height:3px;width:44px;margin:0 auto 20px;background:${accent};border-radius:2px"></div>
    <div style="color:#4a6070;font-size:14.5px;line-height:1.65;white-space:pre-wrap">
      ${safe(message)}
    </div>
    ${refBlock}
    ${cta}
    <div style="border-top:1px solid #e4e8ec;padding-top:16px;margin-top:26px">
      <p style="color:#92a8b4;font-size:12px;text-align:center;margin:0">
        You received this because you have a MilesSpace account.<br>
        © ${new Date().getFullYear()} MilesSpace. All rights reserved.
      </p>
    </div>
  </div>
</body></html>`;
}

// ─── Recipient resolution ───────────────────────────────────────
async function resolveAdminRecipients() {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, email, username, role')
        .in('role', ADMIN_ROLES)
        .is('deleted_at', null)
        .neq('status', 'suspended');
    if (error) {
        console.warn('[FANOUT] admin lookup failed:', error.message);
        return [];
    }
    return (data || []).filter(u => u.email);
}

async function resolveOneUser(userId) {
    if (!userId) return null;
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, email, username')
        .eq('id', userId)
        .is('deleted_at', null)
        .neq('status', 'suspended')
        .maybeSingle();
    if (error || !data) return null;
    return data.email ? data : null;
}

// Paginated read of all users who have an email and aren't deleted.
async function* iterateAllUsers() {
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username')
            .not('email', 'is', null)
            .is('deleted_at', null)
            .neq('status', 'suspended')
            .range(offset, offset + BATCH_SIZE - 1);
        if (error) {
            console.warn('[FANOUT] user page failed:', error.message);
            return;
        }
        if (!data || data.length === 0) return;
        for (const u of data) if (u.email) yield u;
        if (data.length < BATCH_SIZE) return;
        offset += BATCH_SIZE;
    }
}

// ─── Bounded-concurrency email dispatch ─────────────────────────
async function dispatchEmails(recipients, { subject, html }) {
    const queue = recipients.slice();
    let sent = 0, failed = 0;

    async function worker() {
        while (queue.length) {
            const r = queue.shift();
            try {
                const res = await emailService.sendEmail(r.email, subject, html);
                if (res && res.success) sent++;
                else failed++;
            } catch (e) {
                failed++;
                console.warn('[FANOUT] send failed for', r.email, ':', e.message);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return { sent, failed, total: recipients.length };
}

// ─── In-app notification persistence ────────────────────────────
// Insert one row per user in `notifications` so the existing bell
// works for them. Admins don't need a row unless the caller also
// wants them to receive in-app notifications — by default, admin
// fan-out is email-only.
async function persistUserNotifications(users, { title, message, type, link, reference, source }) {
    if (!users.length) return 0;
    const now = new Date().toISOString();
    const rows = users.map(u => ({
        user_id: u.id,
        title: title || 'Notification',
        message: message || '',
        type: type || 'info',
        icon: null,
        link: link || null,
        metadata: { reference: reference || null, source: source || 'admin' },
        is_read: false,
        created_at: now
    }));
    const CHUNK = 200;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await supabaseAdmin.from('notifications').insert(rows.slice(i, i + CHUNK));
        if (error) console.warn('[FANOUT] in-app insert failed:', error.message);
        else inserted += Math.min(CHUNK, rows.length - i);
    }
    return inserted;
}

function emitRealtime(users, payload) {
    if (!global.io) return;
    for (const u of users) {
        try {
            global.io.to(`user:${u.id}`).emit('notification:receive', payload);
        } catch (_) {}
    }
}

// ─── Public API ─────────────────────────────────────────────────
/**
 * fanout({ recipientType, userId, title, message, type, priority,
 *          link, reference, source, skipEmail })
 *
 * recipientType:
 *   'admin'  → email + (no in-app bell)
 *   'user'   → email + in-app bell for one user
 *   'all'    → email + in-app bell for every user
 *   'both'   → admins by email, all users by email + in-app bell
 *
 * Returns { ok, sent, failed, recipients, deliveredInApp }.
 * This is fire-and-forget from the route's perspective — the route
 * returns immediately with the summary BEFORE the emails complete
 * if you want it to; see notificationsRoutes for the exact usage.
 */
async function fanout(opts) {
    const {
        recipientType = 'admin',
        userId = null,
        title, message,
        type = 'info', priority = 'normal',
        link = null, reference = null,
        source = 'admin',
        skipEmail = false
    } = opts || {};

    if (!title || !message) {
        return { ok: false, error: 'title and message are required' };
    }

    const subject = `MilesSpace — ${title}`;
    const html = renderEmailHtml({ title, message, type, link, reference, priority });
    const inAppPayload = {
        title, message, type,
        link: link || null,
        created_at: new Date().toISOString()
    };

    let adminRecipients = [];
    let userRecipients  = [];
    let modeLabel       = recipientType;

    if (recipientType === 'admin') {
        adminRecipients = await resolveAdminRecipients();
    } else if (recipientType === 'user') {
        const u = await resolveOneUser(userId);
        if (!u) return { ok: false, error: 'User not found or has no email' };
        userRecipients = [u];
    } else if (recipientType === 'all') {
        // Enumerate, capped at MAX_BULK_EMAILS.
        for await (const u of iterateAllUsers()) {
            userRecipients.push(u);
            if (userRecipients.length >= MAX_BULK_EMAILS) break;
        }
    } else if (recipientType === 'both') {
        adminRecipients = await resolveAdminRecipients();
        for await (const u of iterateAllUsers()) {
            userRecipients.push(u);
            if (userRecipients.length >= MAX_BULK_EMAILS) break;
        }
    } else {
        return { ok: false, error: `Unknown recipient_type: ${recipientType}` };
    }

    // Persist in-app notifications for user recipients (and for
    // admins only when mode is 'both' and the admin is also a user).
    let inAppInserted = 0;
    if (userRecipients.length && recipientType !== 'admin') {
        inAppInserted = await persistUserNotifications(userRecipients, {
            title, message, type, link, reference, source
        });
        emitRealtime(userRecipients, inAppPayload);
    }

    // Email dispatch
    let emailStats = { sent: 0, failed: 0, total: 0 };
    if (!skipEmail) {
        const all = [...adminRecipients, ...userRecipients];
        // Dedup by email so an admin who is also a user gets one email.
        const seen = new Set();
        const unique = all.filter(r => {
            const key = String(r.email).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        emailStats = await dispatchEmails(unique, { subject, html });
    }

    return {
        ok: true,
        mode: modeLabel,
        admins: adminRecipients.length,
        users: userRecipients.length,
        recipients: adminRecipients.length + userRecipients.length,
        email: emailStats,
        deliveredInApp: inAppInserted
    };
}

/**
 * fanoutAsync — same as fanout but kicks the work off and returns a
 * promise-like handle. The route uses this so the HTTP response is
 * not blocked by SMTP.
 */
function fanoutAsync(opts) {
    // Return a stable shape immediately, run fan-out in the background.
    const started = Date.now();
    setImmediate(() => {
        fanout(opts).then(summary => {
            console.log('[FANOUT] done in', Date.now() - started, 'ms',
                JSON.stringify(summary));
        }).catch(err => {
            console.error('[FANOUT] failed:', err.message);
        });
    });
    return { queued: true, started_at: new Date(started).toISOString() };
}

module.exports = { fanout, fanoutAsync, renderEmailHtml, ADMIN_ROLES };