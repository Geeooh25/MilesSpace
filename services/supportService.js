// services/supportService.js
//
// Authoritative support service. Every admin support route goes
// through here. Customer routes do NOT touch this — they live in
// routes/messages.js and only ever read/write their own rows.
//
// Responsibilities:
//   - list tickets (paginated, filtered)
//   - get one ticket + its messages (with is_internal visible)
//   - create a message (reply or internal note)
//   - change status (with allowed transitions)
//   - assign (validated against assignable admin roles)
//   - close / reopen
//   - stats
//   - audit-write on every mutation via admin_audit_logs
//   - notification to the customer (or not, for internal notes)
//
// No JWT, no req, no res. Pure service.

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const emailSvc = require('./emailService');

const ASSIGNABLE_ROLES = ['super_admin', 'admin', 'finance', 'operations', 'support'];

const TICKET_STATUSES = ['open','assigned','in_progress','waiting_user','waiting_support','resolved','closed'];
const ALLOWED_TRANSITIONS = {
    open:            ['assigned','in_progress','waiting_user','waiting_support','resolved','closed'],
    assigned:        ['in_progress','waiting_user','waiting_support','resolved','closed'],
    in_progress:     ['waiting_user','waiting_support','resolved','closed'],
    waiting_user:    ['in_progress','waiting_support','resolved','closed'],
    waiting_support: ['in_progress','waiting_user','resolved','closed'],
    resolved:        ['closed','in_progress'],
    closed:          ['in_progress']
};

const PRIORITIES = ['low','medium','high','urgent'];

// ─── Helpers ────────────────────────────────────────────────────
function serviceError(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code; e.status = status;
    Object.assign(e, extra);
    return e;
}

function escapeLike(input) {
    return String(input || '').replace(/[%_]/g, m => '\\' + m).slice(0, 100);
}

async function writeAudit({ adminId, adminEmail, action, resourceType, resourceId, before = null, after = null, reason = null, req }) {
    try {
        await supabaseAdmin.from('admin_audit_logs').insert({
            admin_id: adminId,
            admin_email: adminEmail || null,
            action: String(action).slice(0, 120),
            target_type: resourceType || null,
            target_id: resourceId ? String(resourceId) : null,
            before: before || null,
            after: after || null,
            reason: reason ? String(reason).slice(0, 500) : null,
            ip_address: req?.ip || req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || null,
            user_agent: req?.headers?.['user-agent'] || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[SUPPORT AUDIT] insert failed:', e.message);
    }
}

async function notifyCustomer(userId, title, message, link = '/messages', type = 'info') {
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title, message, type, link,
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[SUPPORT NOTIFY] insert failed:', e.message);
    }
}

async function emailCustomer(userId, subject, html) {
    try {
        const { data: profile } = await supabaseAdmin
            .from('profiles').select('email, username').eq('id', userId).maybeSingle();
        if (profile?.email) await emailSvc.sendEmail(profile.email, subject, html);
    } catch (e) {
        console.warn('[SUPPORT EMAIL] failed:', e.message);
    }
}

// ─── LIST TICKETS ───────────────────────────────────────────────
async function listTickets({ page = 1, limit = 50, status, priority, category, assigned, search, sort = 'recent' } = {}) {
    limit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    page = Math.max(Number(page) || 1, 1);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('support_tickets')
        .select(`
            id, ticket_number, subject, description, status, priority, category,
            assigned_to, created_at, updated_at, sla_breached, sla_at_risk,
            user:profiles!user_id ( id, username, email, avatar_url ),
            assigned:profiles!assigned_to ( id, username, email )
        `, { count: 'exact' });

    if (status && TICKET_STATUSES.includes(status)) q = q.eq('status', status);
    if (priority && PRIORITIES.includes(priority)) q = q.eq('priority', priority);
    if (category) q = q.eq('category', category);
    if (assigned === 'unassigned') q = q.is('assigned_to', null);
    else if (assigned && assigned !== 'all' && assigned !== 'me') q = q.eq('assigned_to', assigned);

    if (search) {
        const s = escapeLike(search);
        q = q.or(`subject.ilike.%${s}%,ticket_number.ilike.%${s}%,description.ilike.%${s}%`);
    }

    if (sort === 'oldest') q = q.order('created_at', { ascending: true });
    else if (sort === 'priority') q = q.order('priority', { ascending: false }).order('created_at', { ascending: false });
    else q = q.order('updated_at', { ascending: false, nullsFirst: false });

    q = q.range(offset, offset + limit - 1);
    const { data, count, error } = await q;
    if (error) throw serviceError('LIST_FAILED', error.message, 500);

    // Unread count per ticket (from ticket_messages, not embedded).
    const ids = (data || []).map(t => t.id);
    let unreadMap = {};
    if (ids.length) {
        const { data: rows } = await supabaseAdmin
            .from('ticket_messages')
            .select('ticket_id, is_read, sender_type, is_internal')
            .in('ticket_id', ids);
        for (const r of rows || []) {
            if (r.is_internal) continue;
            if (r.sender_type === 'admin') continue;
            if (r.is_read) continue;
            unreadMap[r.ticket_id] = (unreadMap[r.ticket_id] || 0) + 1;
        }
    }

    const tickets = (data || []).map(t => ({
        ...t,
        unread_count: unreadMap[t.id] || 0,
        last_message: null // filled below
    }));

    // Latest public message per ticket.
    if (ids.length) {
        const { data: latest } = await supabaseAdmin
            .from('ticket_messages')
            .select('ticket_id, message, created_at, sender_type, is_internal')
            .in('ticket_id', ids)
            .eq('is_internal', false)
            .order('created_at', { ascending: false });
        const seen = new Set();
        for (const m of latest || []) {
            if (seen.has(m.ticket_id)) continue;
            seen.add(m.ticket_id);
            const t = tickets.find(x => x.id === m.ticket_id);
            if (t) t.last_message = m;
        }
    }

    return {
        tickets,
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
        hasNextPage: (count || 0) > offset + limit,
        hasPreviousPage: page > 1
    };
}

// ─── GET ONE TICKET ─────────────────────────────────────────────
async function getTicket({ id, viewerId }) {
    const { data: ticket, error } = await supabaseAdmin
        .from('support_tickets')
        .select(`
            id, user_id, ticket_number, subject, description, status, priority, category,
            assigned_to, created_at, updated_at, sla_breached, sla_at_risk,
            user:profiles!user_id ( id, username, email, avatar_url, wallet_ngn, wallet_usd, status, created_at ),
            assigned:profiles!assigned_to ( id, username, email )
        `)
        .eq('id', id)
        .maybeSingle();
    if (error) throw serviceError('GET_FAILED', error.message, 500);
    if (!ticket) throw serviceError('NOT_FOUND', 'Ticket not found', 404);

    const { data: messages, error: mErr } = await supabaseAdmin
        .from('ticket_messages')
        .select(`
            id, message, created_at, read_at, sender_id, sender_type, is_internal, attachments,
            sender:profiles!sender_id ( id, username, email, avatar_url, role )
        `)
        .eq('ticket_id', id)
        .order('created_at', { ascending: true });
    if (mErr) throw serviceError('MESSAGES_FAILED', mErr.message, 500);

    // Mark customer messages as read for the admin (best-effort).
    try {
        const unread = (messages || []).filter(m => !m.is_read && m.sender_type === 'user').map(m => m.id);
        if (unread.length) {
            await supabaseAdmin.from('ticket_messages')
                .update({ is_read: true, read_at: new Date().toISOString() })
                .in('id', unread);
        }
    } catch (_) {}

    return { ticket, messages: messages || [], viewerId: viewerId || null };
}

// ─── CREATE REPLY OR INTERNAL NOTE ──────────────────────────────
async function createMessage({ ticketId, adminId, adminEmail, message, isInternal = false, attachments = [], req }) {
    const body = String(message || '').trim().slice(0, 10000);
    if (!body && (!attachments || !attachments.length)) {
        throw serviceError('EMPTY_MESSAGE', 'Message or attachment required', 422);
    }

    const { data: ticket, error: tErr } = await supabaseAdmin
        .from('support_tickets')
        .select('id, user_id, ticket_number, subject, status')
        .eq('id', ticketId)
        .maybeSingle();
    if (tErr) throw serviceError('LOAD_FAILED', tErr.message, 500);
    if (!ticket) throw serviceError('NOT_FOUND', 'Ticket not found', 404);
    if (ticket.status === 'closed') throw serviceError('CLOSED', 'Ticket is closed', 409);

    const senderType = 'admin';

    const { data: msg, error } = await supabaseAdmin
        .from('ticket_messages')
        .insert({
            ticket_id: ticket.id,
            sender_id: adminId,
            sender_type: senderType,
            message: body || '📎 Attachment',
            attachments: attachments.length ? attachments : null,
            is_internal: !!isInternal,
            is_read: false,
            created_at: new Date().toISOString()
        })
        .select()
        .single();
    if (error) throw serviceError('INSERT_FAILED', error.message, 500);

    // Update the ticket: status + timestamp.
    const nextStatus = isInternal
        ? (ticket.status === 'closed' ? 'in_progress' : ticket.status)
        : 'waiting_user';
    await supabaseAdmin
        .from('support_tickets')
        .update({ status: nextStatus, updated_at: new Date().toISOString() })
        .eq('id', ticket.id);

    // Notify + email the customer, but NOT for internal notes.
    if (!isInternal) {
        await notifyCustomer(
            ticket.user_id,
            `📩 Reply on ${ticket.ticket_number}`,
            body.slice(0, 180) || '📎 Attachment',
            `/tickets/${ticket.ticket_number}`
        );
        try {
            await emailCustomer(
                ticket.user_id,
                `MilesSpace — Reply on ticket ${ticket.ticket_number}`,
                `<p>Hi,</p><p>You have a new reply on <strong>${ticket.ticket_number}</strong>.</p>
                 <p style="background:#f4f7fb;padding:12px;border-radius:8px">${body.replace(/</g,'&lt;') || '📎 Attachment'}</p>
                 <p>Sign in to view and respond.</p>`
            );
        } catch (_) {}
    }

    // Emit to authorized rooms only.
    if (global.io) {
        if (!isInternal) {
            global.io.to(`user:${ticket.user_id}`).emit('support:reply', { ticket_id: ticket.id, message: msg });
        }
        global.io.to('admins').emit('support:updated', { ticket_id: ticket.id, status: nextStatus, is_internal: !!isInternal });
    }

    await writeAudit({
        adminId, adminEmail,
        action: isInternal ? 'SUPPORT_INTERNAL_NOTE' : 'SUPPORT_TICKET_REPLY',
        resourceType: 'support_ticket', resourceId: ticket.id,
        after: { message: body.slice(0, 400), is_internal: !!isInternal, status: nextStatus },
        req
    });

    return msg;
}

// ─── CHANGE STATUS ──────────────────────────────────────────────
async function changeStatus({ ticketId, nextStatus, adminId, adminEmail, reason = null, req }) {
    if (!TICKET_STATUSES.includes(nextStatus)) {
        throw serviceError('INVALID_STATUS', `Invalid status: ${nextStatus}`, 422, { allowed: TICKET_STATUSES });
    }
    const { data: ticket } = await supabaseAdmin
        .from('support_tickets').select('id, user_id, ticket_number, status').eq('id', ticketId).maybeSingle();
    if (!ticket) throw serviceError('NOT_FOUND', 'Ticket not found', 404);

    const allowed = ALLOWED_TRANSITIONS[ticket.status] || [];
    if (!allowed.includes(nextStatus)) {
        throw serviceError('INVALID_TRANSITION', `Cannot move from ${ticket.status} to ${nextStatus}`, 409, { allowed });
    }

    const { error } = await supabaseAdmin
        .from('support_tickets')
        .update({ status: nextStatus, updated_at: new Date().toISOString() })
        .eq('id', ticket.id);
    if (error) throw serviceError('UPDATE_FAILED', error.message, 500);

    await notifyCustomer(
        ticket.user_id,
        `Ticket ${ticket.ticket_number} — ${nextStatus}`,
        `Your ticket status changed to ${nextStatus}.`,
        `/tickets/${ticket.ticket_number}`
    );

    if (global.io) {
        global.io.to(`user:${ticket.user_id}`).emit('support:status', { ticket_id: ticket.id, status: nextStatus });
        global.io.to('admins').emit('support:updated', { ticket_id: ticket.id, status: nextStatus });
    }

    await writeAudit({
        adminId, adminEmail,
        action: 'SUPPORT_STATUS_CHANGED',
        resourceType: 'support_ticket', resourceId: ticket.id,
        before: { status: ticket.status }, after: { status: nextStatus },
        reason, req
    });

    return { status: nextStatus };
}

// ─── ASSIGN ─────────────────────────────────────────────────────
async function assignTicket({ ticketId, adminId, adminEmail, assignTo, reason = null, req }) {
    const { data: target } = await supabaseAdmin
        .from('profiles').select('id, role, status, deleted_at').eq('id', assignTo).maybeSingle();
    if (!target) throw serviceError('AGENT_NOT_FOUND', 'Agent not found', 404);
    if (target.deleted_at || target.status === 'suspended') {
        throw serviceError('AGENT_INACTIVE', 'Agent is not active', 409);
    }
    if (!ASSIGNABLE_ROLES.includes(target.role)) {
        throw serviceError('NOT_ASSIGNABLE', 'User cannot be assigned tickets', 422);
    }

    const { data: ticket } = await supabaseAdmin
        .from('support_tickets').select('id, user_id, ticket_number, assigned_to, status')
        .eq('id', ticketId).maybeSingle();
    if (!ticket) throw serviceError('NOT_FOUND', 'Ticket not found', 404);

    const nextStatus = ticket.status === 'open' ? 'assigned' : ticket.status;

    const { error } = await supabaseAdmin
        .from('support_tickets')
        .update({ assigned_to: assignTo, status: nextStatus, updated_at: new Date().toISOString() })
        .eq('id', ticket.id);
    if (error) throw serviceError('UPDATE_FAILED', error.message, 500);

    await writeAudit({
        adminId, adminEmail,
        action: 'SUPPORT_TICKET_ASSIGNED',
        resourceType: 'support_ticket', resourceId: ticket.id,
        before: { assigned_to: ticket.assigned_to },
        after: { assigned_to: assignTo },
        reason, req
    });

    if (global.io) global.io.to('admins').emit('support:updated', { ticket_id: ticket.id });

    return { assigned_to: assignTo, status: nextStatus };
}

// ─── STATS ──────────────────────────────────────────────────────
async function getStats() {
    const counts = {};
    for (const status of TICKET_STATUSES) counts[status] = 0;
    try {
        const { data, error } = await supabaseAdmin.from('support_tickets').select('status');
        if (error) throw error;
        let total = 0;
        for (const row of data || []) {
            counts[row.status] = (counts[row.status] || 0) + 1;
            total += 1;
        }
        return {
            total,
            open: counts.open || 0,
            assigned: counts.assigned || 0,
            in_progress: counts.in_progress || 0,
            waiting_user: counts.waiting_user || 0,
            waiting_support: counts.waiting_support || 0,
            resolved: counts.resolved || 0,
            closed: counts.closed || 0,
            urgent: 0, high_priority: 0, sla_breached: 0, unassigned: 0
        };
    } catch (e) {
        console.error('[SUPPORT STATS] failed:', e.message);
        return { total: 0, open: 0, assigned: 0, in_progress: 0, waiting_user: 0, waiting_support: 0, resolved: 0, closed: 0, urgent: 0, high_priority: 0, sla_breached: 0, unassigned: 0 };
    }
}

// ─── ADMINS (assignable agents) ─────────────────────────────────
async function listAssignableAdmins() {
    const { data } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email, role, status')
        .in('role', ASSIGNABLE_ROLES)
        .is('deleted_at', null)
        .neq('status', 'suspended')
        .order('username', { ascending: true });
    return data || [];
}

module.exports = {
    listTickets,
    getTicket,
    createMessage,
    changeStatus,
    assignTicket,
    getStats,
    listAssignableAdmins,
    TICKET_STATUSES,
    PRIORITIES,
    ASSIGNABLE_ROLES
};