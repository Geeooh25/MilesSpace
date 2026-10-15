'use strict';

const { supabaseAdmin } = require('../db/supabase');

const ASSIGNABLE_ROLES = ['super_admin','admin','finance','operations','support'];
const LIMIT_DEFAULT = 25;
const LIMIT_MAX = 100;

function serviceError(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}
function clampLimit(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) return LIMIT_DEFAULT;
    return Math.min(n, LIMIT_MAX);
}
function clampPage(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return n;
}
function escapeLike(s) {
    return String(s || '').replace(/[%_\\]/g, m => '\\' + m).slice(0, 100);
}

// ─── LIST (admin) ───────────────────────────────────────────────
async function listTickets({
    page = 1, limit = LIMIT_DEFAULT,
    status, priority, category,
    assigned, search, sort = 'recent',
    viewerId = null
} = {}) {
    limit = clampLimit(limit);
    page = clampPage(page);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('support_tickets')
        .select(`
            id, ticket_number, subject, description, status, priority, category,
            assigned_to, assigned_at, first_response_at, resolved_at, closed_at,
            created_at, updated_at, last_message_at, last_user_message_at, last_admin_message_at,
            unread_for_admin, sla_breached, sla_at_risk, version,
            related_type, related_id, related_reference,
            provider, payment_reference, transaction_id, deposit_id,
            user_id, contact_name, contact_email,
            user:profiles!user_id (id, username, email, avatar_url),
            assigned:profiles!assigned_to (id, username, email)
        `, { count: 'planned' });

    if (status && status !== 'all') q = q.eq('status', status);
    if (priority && priority !== 'all') q = q.eq('priority', priority);
    if (category && category !== 'all') q = q.eq('category', category);

    if (assigned === 'unassigned') q = q.is('assigned_to', null);
    else if (assigned === 'me' && viewerId) q = q.eq('assigned_to', viewerId);
    else if (assigned && assigned !== 'all') q = q.eq('assigned_to', assigned);

    if (search) {
        const s = escapeLike(search);
        q = q.or(
            `subject.ilike.%${s}%,ticket_number.ilike.%${s}%,description.ilike.%${s}%,contact_email.ilike.%${s}%,contact_name.ilike.%${s}%`
        );
    }

    if (sort === 'oldest') {
        q = q.order('created_at', { ascending: true });
    } else if (sort === 'priority') {
        q = q.order('priority', { ascending: false })
             .order('last_message_at', { ascending: false, nullsFirst: false });
    } else {
        q = q.order('last_message_at', { ascending: false, nullsFirst: false })
             .order('created_at', { ascending: false });
    }

    q = q.range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) throw serviceError('LIST_FAILED', error.message, 500);

    return {
        tickets: data || [],
        page,
        limit,
        total: (data || []).length,
        totalPages: 1,
        hasNextPage: (data || []).length === limit,
        hasPreviousPage: page > 1
    };
}

// ─── GET ONE ────────────────────────────────────────────────────
async function getTicket({ id, viewerId, viewerIsAdmin = false }) {
    const { data: ticket, error } = await supabaseAdmin
        .from('support_tickets')
        .select(`
            *,
            user_id,
            contact_name,
            contact_email,
            user:profiles!user_id (id, username, email, avatar_url, wallet_ngn, wallet_usd, status, created_at),
            assigned:profiles!assigned_to (id, username, email)
        `)
        .eq('id', id)
        .maybeSingle();
    if (error) throw serviceError('GET_FAILED', error.message, 500);
    if (!ticket) throw serviceError('NOT_FOUND', 'Ticket not found', 404);

    if (!viewerIsAdmin && viewerId && String(ticket.user_id) !== String(viewerId)) {
        throw serviceError('ACCESS_DENIED', 'Access denied', 403);
    }

    let q = supabaseAdmin
        .from('ticket_messages')
        .select(`
            id, message, created_at, read_by_admin_at, read_by_user_at,
            sender_id, sender_type, is_internal, attachments,
            deleted_at, deleted_by, deletion_reason,
            sender:profiles!sender_id (id, username, email, avatar_url, role)
        `)
        .eq('ticket_id', id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true });

    if (!viewerIsAdmin) q = q.eq('is_internal', false);

    const { data: messages, error: mErr } = await q;
    if (mErr) throw serviceError('MESSAGES_FAILED', mErr.message, 500);

    return {
        ticket,
        messages: messages || [],
        viewerId: viewerId || null
    };
}

// ─── MARK READ (admin) ──────────────────────────────────────────
async function markRead({ ticketId }) {
    const nowIso = new Date().toISOString();
    await supabaseAdmin
        .from('ticket_messages')
        .update({ read_by_admin_at: nowIso })
        .eq('ticket_id', ticketId)
        .eq('sender_type', 'user')
        .is('read_by_admin_at', null);
    await supabaseAdmin
        .from('support_tickets')
        .update({ unread_for_admin: 0, last_read_by_admin_at: nowIso })
        .eq('id', ticketId);
    return { read: true };
}

// ─── CREATE MESSAGE (atomic via RPC) ────────────────────────────
async function createMessage({
    ticketId, adminId, adminEmail, adminRole,
    message, isInternal = false,
    attachments = [], req = null
}) {
    const body = String(message || '').trim().slice(0, 10000);
    if (!body && (!attachments || !attachments.length)) {
        throw serviceError('EMPTY_MESSAGE', 'Message or attachment required', 422);
    }

    const { data, error } = await supabaseAdmin.rpc('add_support_message', {
        p_ticket_id:       ticketId,
        p_sender_id:       adminId,
        p_sender_type:     'admin',
        p_message:         body || '📎 Attachment',
        p_is_internal:     !!isInternal,
        p_attachments:     attachments.length ? attachments : null,
        p_idempotency_key: null,
        p_ip_address:      req ? (req.ip || null) : null,
        p_user_agent:      req ? (req.headers['user-agent'] || null) : null,
        p_request_id:      req ? (req.requestId || null) : null
    });

    if (error) throw serviceError('MESSAGE_FAILED', error.message, 500);
    if (!data || data.ok !== true) {
        const err = (data && data.error) || 'MESSAGE_FAILED';
        if (err === 'TICKET_NOT_FOUND') throw serviceError('NOT_FOUND', 'Ticket not found', 404);
        if (err === 'TICKET_CLOSED')    throw serviceError('CLOSED', 'Ticket is closed', 409);
        throw serviceError('MESSAGE_FAILED', err, 500);
    }
    return data.message;
}

// ─── CHANGE STATUS (atomic via RPC) ─────────────────────────────
async function changeStatus({
    ticketId, nextStatus, adminId, reason = null,
    expectedVersion = null, req = null
}) {
    const { data, error } = await supabaseAdmin.rpc('change_support_status', {
        p_ticket_id:        ticketId,
        p_next_status:      nextStatus,
        p_actor_id:         adminId,
        p_actor_type:       'admin',
        p_reason:           reason,
        p_expected_version: expectedVersion,
        p_request_id:       req ? (req.requestId || null) : null,
        p_ip_address:       req ? (req.ip || null) : null
    });
    if (error) throw serviceError('STATUS_FAILED', error.message, 500);
    if (!data) throw serviceError('STATUS_FAILED', 'No response', 500);

    if (data.ok === true) {
        return { status: data.status, version: data.version };
    }
    if (data.error === 'INVALID_TRANSITION') {
        throw serviceError(
            'INVALID_TRANSITION',
            `Cannot move from ${data.from} to ${data.to}`,
            409
        );
    }
    if (data.error === 'STALE_VERSION') {
        throw serviceError(
            'STALE_VERSION',
            'Someone else updated this ticket. Reload and try again.',
            409,
            { current_version: data.current_version }
        );
    }
    if (data.error === 'TICKET_NOT_FOUND') {
        throw serviceError('NOT_FOUND', 'Ticket not found', 404);
    }
    throw serviceError('STATUS_FAILED', data.error || 'Unknown', 500);
}

// ─── ASSIGN (atomic via RPC) ────────────────────────────────────
async function assignTicket({
    ticketId, adminId, assignTo, reason = null,
    expectedVersion = null, req = null
}) {
    const { data: target, error: tErr } = await supabaseAdmin
        .from('profiles')
        .select('id, role, status, deleted_at')
        .eq('id', assignTo)
        .maybeSingle();
    if (tErr) throw serviceError('LOOKUP_FAILED', tErr.message, 500);
    if (!target) throw serviceError('AGENT_NOT_FOUND', 'Agent not found', 404);
    if (target.deleted_at || target.status === 'suspended') {
        throw serviceError('AGENT_INACTIVE', 'Agent is not active', 409);
    }
    if (!ASSIGNABLE_ROLES.includes(target.role)) {
        throw serviceError('NOT_ASSIGNABLE', 'User cannot be assigned tickets', 422);
    }

    const { data, error } = await supabaseAdmin.rpc('assign_support_ticket', {
        p_ticket_id:        ticketId,
        p_assign_to:        assignTo,
        p_actor_id:         adminId,
        p_reason:           reason,
        p_expected_version: expectedVersion,
        p_request_id:       req ? (req.requestId || null) : null
    });
    if (error) throw serviceError('ASSIGN_FAILED', error.message, 500);
    if (!data || data.ok !== true) {
        const err = (data && data.error) || 'ASSIGN_FAILED';
        if (err === 'TICKET_NOT_FOUND') {
            throw serviceError('NOT_FOUND', 'Ticket not found', 404);
        }
        if (err === 'STALE_VERSION') {
            throw serviceError(
                'STALE_VERSION',
                'Someone else updated this ticket. Reload and try again.',
                409,
                { current_version: data.current_version }
            );
        }
        throw serviceError('ASSIGN_FAILED', err, 500);
    }
    return {
        assigned_to: data.assigned_to,
        status: data.status,
        version: data.version
    };
}

// ─── STATS ──────────────────────────────────────────────────────
async function getStats() {
    const zero = {
        total: 0, open: 0, assigned: 0, in_progress: 0,
        waiting_user: 0, waiting_support: 0, resolved: 0, closed: 0,
        urgent: 0, high_priority: 0, unassigned: 0, unread: 0,
        sla_breached: 0, sla_at_risk: 0,
        avg_first_response_minutes: null
    };
    try {
        const { data, error } = await supabaseAdmin
            .from('support_tickets')
            .select(
                'status, priority, assigned_to, sla_breached, sla_at_risk, ' +
                'unread_for_admin, first_response_at, created_at'
            );
        if (error) throw error;

        const out = { ...zero };
        let responseSum = 0;
        let responseCount = 0;

        for (const r of (data || [])) {
            out.total++;
            if (out[r.status] !== undefined) out[r.status]++;
            if (r.priority === 'urgent') out.urgent++;
            if (r.priority === 'high')   out.high_priority++;
            if (!r.assigned_to)          out.unassigned++;
            if (r.unread_for_admin > 0)  out.unread++;
            if (r.sla_breached)          out.sla_breached++;
            if (r.sla_at_risk)           out.sla_at_risk++;

            if (r.first_response_at && r.created_at) {
                const ms = new Date(r.first_response_at) - new Date(r.created_at);
                if (Number.isFinite(ms) && ms >= 0) {
                    responseSum += ms / 60000;
                    responseCount++;
                }
            }
        }
        out.avg_first_response_minutes = responseCount
            ? Math.round(responseSum / responseCount)
            : null;
        return out;
    } catch (e) {
        console.warn('[supportService.getStats] failed:', e.message);
        return zero;
    }
}

// ─── ASSIGNABLE ADMINS ──────────────────────────────────────────
async function listAssignableAdmins() {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email, role, status')
        .in('role', ASSIGNABLE_ROLES)
        .is('deleted_at', null)
        .neq('status', 'suspended')
        .order('username', { ascending: true });
    if (error) {
        console.warn('[supportService.listAssignableAdmins] failed:', error.message);
        return [];
    }
    return data || [];
}

module.exports = {
    listTickets,
    getTicket,
    markRead,
    createMessage,
    changeStatus,
    assignTicket,
    getStats,
    listAssignableAdmins,
    ASSIGNABLE_ROLES,
    LIMIT_DEFAULT,
    LIMIT_MAX
};