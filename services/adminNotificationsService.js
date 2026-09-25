// services/adminNotificationsService.js
// ─────────────────────────────────────────────────────────────────
// Admin Notification Center — the authority for admin/system alerts.
//
// Design rules:
//   • Separate from the user-facing `notifications` table.
//   • Every write goes through createNotification() which respects
//     dedupe_key so the same event is never spammed twice.
//   • Every read/mutation is admin-authenticated upstream.
//   • Admin actions are logged to admin_audit_logs when available.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TYPES = new Set([
    'info','success','warning','error',
    'payment','order','provider','webhook','security','system','announcement'
]);
const VALID_PRIORITIES = new Set(['low','normal','high','critical']);
const VALID_SOURCES = new Set([
    'payment','wallet','order','provider','webhook',
    'crypto','virtual_sms','esim','bills','gift_card','boost',
    'airtime','data','marketplace','security','system','admin'
]);
const VALID_RECIPIENT_TYPES = new Set(['all','admin','user','group']);

const TYPE_ICON = {
    info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌',
    payment: '💳', order: '🧾', provider: '🔌', webhook: '🪝',
    security: '🔒', system: '⚙️', announcement: '📣'
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 250;

// ─── Helpers ─────────────────────────────────────────────────────

function limitOf(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function pageOf(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}
function iso(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function sanitizeString(v, max) {
    if (v == null) return null;
    return String(v).trim().slice(0, max);
}

function normalizeType(type) {
    const t = String(type || 'info').toLowerCase();
    return VALID_TYPES.has(t) ? t : 'info';
}
function normalizePriority(priority) {
    const p = String(priority || 'normal').toLowerCase();
    return VALID_PRIORITIES.has(p) ? p : 'normal';
}
function normalizeSource(source) {
    const s = String(source || 'system').toLowerCase();
    return VALID_SOURCES.has(s) ? s : 'system';
}
function normalizeRecipientType(t) {
    const r = String(t || 'admin').toLowerCase();
    return VALID_RECIPIENT_TYPES.has(r) ? r : 'admin';
}

async function recordAudit({ adminId, action, targetId, metadata }) {
    try {
        await supabaseAdmin.from('admin_audit_logs').insert({
            admin_id: adminId || null,
            action,
            target_type: 'admin_notification',
            target_id: targetId || null,
            after: metadata || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[adminNotif] audit failed:', e.message);
    }
}

// ─── Create ──────────────────────────────────────────────────────

async function createNotification({
    title, message, type, priority, source, icon, link, reference,
    userId = null, orderId = null, transactionId = null,
    providerReference = null, webhookId = null,
    recipientType = 'admin', recipientId = null,
    dedupeKey = null, createdBy = null
}) {
    const cleanTitle = sanitizeString(title, 200);
    const cleanMessage = sanitizeString(message, 2000);
    if (!cleanTitle) {
        const e = new Error('Title is required.'); e.status = 422; e.code = 'TITLE_REQUIRED'; throw e;
    }
    if (!cleanMessage) {
        const e = new Error('Message is required.'); e.status = 422; e.code = 'MESSAGE_REQUIRED'; throw e;
    }

    const payload = {
        title: cleanTitle,
        message: cleanMessage,
        type: normalizeType(type),
        priority: normalizePriority(priority),
        source: normalizeSource(source),
        icon: sanitizeString(icon, 10) || TYPE_ICON[normalizeType(type)] || '📌',
        link: sanitizeString(link, 500),
        reference: sanitizeString(reference, 200),
        user_id: userId && UUID_RE.test(userId) ? userId : null,
        order_id: orderId && UUID_RE.test(orderId) ? orderId : null,
        transaction_id: transactionId && UUID_RE.test(transactionId) ? transactionId : null,
        provider_reference: sanitizeString(providerReference, 200),
        webhook_id: webhookId && UUID_RE.test(webhookId) ? webhookId : null,
        recipient_type: normalizeRecipientType(recipientType),
        recipient_id: recipientId && UUID_RE.test(recipientId) ? recipientId : null,
        dedupe_key: sanitizeString(dedupeKey, 200),
        created_by: createdBy && UUID_RE.test(createdBy) ? createdBy : null,
        is_read: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin
        .from('admin_notifications')
        .insert(payload)
        .select('*')
        .maybeSingle();

    if (error) {
        // Unique violation on dedupe_key means the event was already
        // recorded. Return the existing row instead of throwing.
        if (error.code === '23505' && payload.dedupe_key) {
            const { data: existing } = await supabaseAdmin
                .from('admin_notifications')
                .select('*')
                .eq('dedupe_key', payload.dedupe_key)
                .maybeSingle();
            return { notification: existing, deduplicated: true };
        }
        throw new Error(`Failed to create notification: ${error.message}`);
    }
    return { notification: data, deduplicated: false };
}

// ─── List ────────────────────────────────────────────────────────

async function listNotifications(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    const SORTABLE = {
        newest:    { col: 'created_at', asc: false },
        oldest:    { col: 'created_at', asc: true },
        priority:  { col: 'priority',   asc: true },   // alphabetical won't order by severity; the frontend reorders if needed
        unread:    { col: 'is_read',    asc: true }
    };
    const sortKey = String(query.sort || 'newest').toLowerCase();
    const sort = SORTABLE[sortKey] || SORTABLE.newest;

    let q = supabaseAdmin
        .from('admin_notifications')
        .select('*', { count: 'exact' })
        .order(sort.col, { ascending: sort.asc })
        .range(offset, offset + limit - 1);

    // Archived rows excluded unless explicitly requested.
    if (query.include_archived !== 'true') {
        q = q.is('archived_at', null);
    }

    if (query.status === 'read')   q = q.eq('is_read', true);
    if (query.status === 'unread') q = q.eq('is_read', false);
    if (query.type && query.type !== 'all' && VALID_TYPES.has(query.type)) q = q.eq('type', query.type);
    if (query.priority && query.priority !== 'all' && VALID_PRIORITIES.has(query.priority)) q = q.eq('priority', query.priority);
    if (query.source && query.source !== 'all' && VALID_SOURCES.has(query.source)) q = q.eq('source', query.source);
    if (query.recipient_type && query.recipient_type !== 'all' && VALID_RECIPIENT_TYPES.has(query.recipient_type)) {
        q = q.eq('recipient_type', query.recipient_type);
    }

    const fromIso = iso(query.from);
    const toIso   = iso(query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso)   q = q.lte('created_at', toIso);

    if (query.search) {
        const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
        q = q.or(`title.ilike.%${safe}%,message.ilike.%${safe}%,reference.ilike.%${safe}%,provider_reference.ilike.%${safe}%`);
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { notifications: [], total: 0, page, limit, totalPages: 0, available: false, reason: 'ADMIN_NOTIFICATIONS_TABLE_NOT_FOUND' };
        }
        throw new Error(`Failed to list notifications: ${error.message}`);
    }

    // For the priority sort key, re-order in Node using a severity map.
    let rows = data || [];
    if (sortKey === 'priority') {
        const order = { critical: 0, high: 1, normal: 2, low: 3 };
        rows = rows.slice().sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9));
    }
    if (sortKey === 'unread') {
        rows = rows.slice().sort((a, b) => Number(a.is_read) - Number(b.is_read));
    }

    return {
        notifications: rows,
        total: count || 0,
        page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0),
        available: true
    };
}

// ─── Detail ──────────────────────────────────────────────────────

async function getNotification(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('admin_notifications').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
        const e = new Error('Notification not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
    }

    // Linked resources, if any.
    let user = null, order = null, transaction = null, webhook = null;
    if (data.user_id) {
        const { data: p } = await supabaseAdmin.from('profiles')
            .select('id, username, email, status').eq('id', data.user_id).maybeSingle();
        user = p || null;
    }
    if (data.order_id) {
        const { data: o } = await supabaseAdmin.from('orders')
            .select('id, order_ref, status, total_amount, currency, provider, provider_order_id')
            .eq('id', data.order_id).maybeSingle();
        order = o || null;
    }
    if (data.transaction_id) {
        const { data: t } = await supabaseAdmin.from('transactions')
            .select('id, ref, reference, type, status, amount, currency, created_at')
            .eq('id', data.transaction_id).maybeSingle();
        transaction = t || null;
    }
    if (data.webhook_id) {
        const { data: w } = await supabaseAdmin.from('webhook_events')
            .select('id, provider, event_type, processing_status, received_at, processed_at')
            .eq('id', data.webhook_id).maybeSingle();
        webhook = w || null;
    }

    return { notification: data, user, order, transaction, webhook };
}

// ─── Stats ───────────────────────────────────────────────────────

async function getStats({ from, to } = {}) {
    const { data, error } = await supabaseAdmin.rpc('admin_notifications_stats', {
        p_from: iso(from),
        p_to: iso(to)
    });
    if (error) {
        if (['42883','PGRST202'].includes(error.code)) {
            return { available: false, reason: 'STATS_RPC_NOT_DEPLOYED' };
        }
        throw new Error(error.message);
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
        available: true,
        stats: {
            total:         Number(row?.total || 0),
            unread:        Number(row?.unread || 0),
            read:          Number(row?.read_count || 0),
            critical:      Number(row?.critical || 0),
            failed:        Number(row?.failed || 0),
            sentToday:     Number(row?.sent_today || 0),
            systemAlerts:  Number(row?.system_alerts || 0)
        }
    };
}

// ─── Mark read / unread ──────────────────────────────────────────

async function markRead(id, adminId) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('admin_notifications')
        .update({ is_read: true, read_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
        const e = new Error('Notification not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
    }
    await recordAudit({ adminId, action: 'admin_notification.read', targetId: id });
    return { notification: data };
}

async function markUnread(id, adminId) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('admin_notifications')
        .update({ is_read: false, read_at: null, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
        const e = new Error('Notification not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
    }
    await recordAudit({ adminId, action: 'admin_notification.unread', targetId: id });
    return { notification: data };
}

async function markAllRead(adminId) {
    const { error } = await supabaseAdmin
        .from('admin_notifications')
        .update({ is_read: true, read_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('is_read', false)
        .is('archived_at', null);
    if (error) throw new Error(error.message);
    await recordAudit({ adminId, action: 'admin_notification.read_all', targetId: null });
    return { ok: true };
}

// ─── Bulk ────────────────────────────────────────────────────────

const BULK_ACTIONS = new Set(['read','unread','archive']);

async function bulkAction({ ids, action, adminId }) {
    if (!Array.isArray(ids) || !ids.length) {
        const e = new Error('ids must be a non-empty array.'); e.status = 422; e.code = 'INVALID_IDS'; throw e;
    }
    const cleanIds = ids.filter(id => UUID_RE.test(id));
    if (!cleanIds.length) {
        const e = new Error('No valid ids provided.'); e.status = 422; e.code = 'INVALID_IDS'; throw e;
    }
    const act = String(action || '').toLowerCase();
    if (!BULK_ACTIONS.has(act)) {
        const e = new Error('Invalid action.'); e.status = 422; e.code = 'INVALID_ACTION'; throw e;
    }

    const patch = { updated_at: new Date().toISOString() };
    if (act === 'read')    { patch.is_read = true;  patch.read_at = new Date().toISOString(); }
    if (act === 'unread')  { patch.is_read = false; patch.read_at = null; }
    if (act === 'archive') { patch.archived_at = new Date().toISOString(); }

    const { error, count } = await supabaseAdmin
        .from('admin_notifications')
        .update(patch, { count: 'exact' })
        .in('id', cleanIds);

    if (error) throw new Error(error.message);
    await recordAudit({
        adminId, action: `admin_notification.bulk_${act}`,
        targetId: null, metadata: { ids: cleanIds, count }
    });
    return { updated: count || cleanIds.length, action: act };
}

// ─── Archive / Delete ────────────────────────────────────────────

async function archive(id, adminId) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('admin_notifications')
        .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
        const e = new Error('Notification not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
    }
    await recordAudit({ adminId, action: 'admin_notification.archive', targetId: id });
    return { notification: data };
}

async function remove(id, adminId) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('admin_notifications')
        .delete()
        .eq('id', id)
        .select('*')
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
        const e = new Error('Notification not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
    }
    await recordAudit({ adminId, action: 'admin_notification.delete', targetId: id });
    return { ok: true };
}

// ─── User search ─────────────────────────────────────────────────

async function searchUsers(query, limit = 20) {
    const q = String(query || '').trim();
    if (!q || q.length < 2) return { users: [] };
    const safe = q.replace(/[%_]/g, m => '\\' + m);

    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email, avatar_url, status')
        .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
        .is('deleted_at', null)
        .limit(Math.min(limit, 50));

    if (error) throw new Error(error.message);
    return {
        users: (data || []).map(u => ({
            id: u.id,
            email: u.email,
            username: u.username || (u.email ? u.email.split('@')[0] : null),
            avatar_url: u.avatar_url || null,
            status: u.status || 'active'
        }))
    };
}

// ─── Send to users (fan-out for announcements) ──────────────────

async function sendToUsers({ title, message, type, priority, link, reference, createdBy, recipientType, userId }) {
    if (recipientType === 'user') {
        if (!UUID_RE.test(String(userId || ''))) {
            const e = new Error('A valid user_id is required.'); e.status = 422; e.code = 'USER_REQUIRED'; throw e;
        }
        // Write to the user-facing notifications table.
        try {
            await supabaseAdmin.from('notifications').insert({
                user_id: userId,
                title: String(title).slice(0, 200),
                message: String(message).slice(0, 2000),
                type: 'admin_announcement',
                icon: TYPE_ICON[type] || '📢',
                link: link || null,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (e) {
            console.warn('[adminNotif] failed to write user notification:', e.message);
        }

        // Also keep an admin-side record for audit.
        return createNotification({
            title, message, type, priority, source: 'admin', link, reference,
            userId, recipientType: 'user', recipientId: userId, createdBy
        });
    }

    if (recipientType === 'all') {
        // NOTE: fan-out for "all users" writes to the user-facing
        // notifications table one row per user. That may be hundreds
        // of rows. This is intentional — it's an announcement.
        // The admin-side record is created once.
        const { data: users } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .is('deleted_at', null)
            .neq('status', 'suspended');

        const now = new Date().toISOString();
        const rows = (users || []).map(u => ({
            user_id: u.id,
            title: String(title).slice(0, 200),
            message: String(message).slice(0, 2000),
            type: 'admin_announcement',
            icon: TYPE_ICON[type] || '📢',
            link: link || null,
            is_read: false,
            created_at: now
        }));

        if (rows.length) {
            // Batch insert in chunks of 500 to avoid payload limits.
            for (let i = 0; i < rows.length; i += 500) {
                const chunk = rows.slice(i, i + 500);
                try {
                    await supabaseAdmin.from('notifications').insert(chunk);
                } catch (e) {
                    console.warn('[adminNotif] announcement batch failed:', e.message);
                }
            }
        }

        return createNotification({
            title, message, type, priority, source: 'admin', link, reference,
            recipientType: 'all', createdBy
        });
    }

    // Default: admin-only notification.
    return createNotification({
        title, message, type, priority, source: 'admin', link, reference,
        recipientType: 'admin', createdBy
    });
}

module.exports = {
    VALID_TYPES,
    VALID_PRIORITIES,
    VALID_SOURCES,

    createNotification,
    listNotifications,
    getNotification,
    getStats,
    markRead,
    markUnread,
    markAllRead,
    bulkAction,
    archive,
    remove,
    searchUsers,
    sendToUsers
};