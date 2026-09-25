// services/ordersService.js
// ─────────────────────────────────────────────────────────────────
// Central Orders service — the operational authority for every order.
//
// ONE pipeline: processProviderUpdate(). Webhooks, admin sync, and
// scheduled sync all feed into it. Financial actions (wallet debit,
// refund) happen exactly once because:
//   • The order row is updated with expected-status condition.
//   • Refunds are guarded by refund_status AND by the unique index
//     ux_refund_original_transaction.
//   • Webhook events have their own unique index on (provider, event_id).
//
// Money rules:
//   • Wallet mutation only via LedgerService.
//   • Provider timeout ≠ failed. Ambiguous outcomes stay in
//     processing / provider_unknown.
//   • Every status change writes an order_event.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const ORDER_STATUSES = new Set([
    'pending', 'paid', 'processing', 'in_progress', 'completed',
    'partial', 'failed', 'cancelled', 'refunding', 'refunded',
    'expired', 'manual_review', 'provider_unknown'
]);

const ALLOWED_TRANSITIONS = Object.freeze({
    pending:          ['paid', 'processing', 'cancelled', 'failed', 'expired'],
    paid:             ['processing', 'completed', 'cancelled', 'failed'],
    processing:       ['in_progress', 'partial', 'completed', 'failed', 'cancelled', 'provider_unknown', 'manual_review'],
    in_progress:      ['partial', 'completed', 'failed', 'provider_unknown', 'manual_review'],
    partial:          ['completed', 'failed', 'refunding'],
    provider_unknown: ['processing', 'in_progress', 'partial', 'completed', 'failed', 'manual_review'],
    manual_review:    ['completed', 'failed', 'cancelled', 'refunding', 'processing'],
    completed:        ['refunding'],
    failed:           ['refunding'],
    cancelled:        ['refunding'],
    refunding:        ['refunded', 'failed'],
    refunded:         [],
    expired:          ['failed']
});

// ─── Helpers ─────────────────────────────────────────────────────

function limitOf(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function pageOf(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}
function isoDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'completed') return 'success';
    if (['failed','cancelled','expired'].includes(s)) return 'danger';
    if (s === 'refunded') return 'info';
    if (['manual_review','provider_unknown'].includes(s)) return 'purple';
    if (['pending','paid','processing','in_progress','partial','refunding'].includes(s)) return 'warn';
    return 'neutral';
}

async function recordEvent({ orderId, eventType, oldStatus = null, newStatus = null, actorType = 'system', actorId = null, message = null, metadata = null }) {
    try {
        await supabaseAdmin.from('order_events').insert({
            order_id: orderId,
            event_type: eventType,
            old_status: oldStatus,
            new_status: newStatus,
            actor_type: actorType,
            actor_id: actorId,
            message: message ? String(message).slice(0, 500) : null,
            metadata: metadata || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[ORDERS] event insert failed:', e.message);
    }
}

async function recordAudit({ ctx, action, orderId, before, after, reason }) {
    try {
        await supabaseAdmin.from('admin_audit_logs').insert({
            admin_id:    ctx?.adminId || null,
            admin_email: ctx?.adminEmail || null,
            action,
            target_type: 'order',
            target_id:   orderId,
            before: before || null,
            after:  after  || null,
            reason: reason ? String(reason).slice(0, 500) : null,
            ip_address: ctx?.ip || null,
            user_agent: ctx?.userAgent || null,
            request_id: ctx?.requestId || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[ORDERS] audit insert failed:', e.message);
    }
}

async function createNotification({ userId, title, message, type, icon = '📌', link = '/history' }) {
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title, message, type, icon, link,
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (_) {}
}

// ─── Register a new order (called by service routes) ─────────────

async function registerOrder({
    orderRef, userId, productType, productName, serviceType,
    quantity = null, amount, fee = 0, totalAmount, currency,
    status = 'pending', paymentStatus = 'pending', fulfillmentStatus = 'pending',
    provider, providerOrderId = null, providerReference = null,
    sourceTable = null, sourceId = null, metadata = {}
}) {
    if (!userId || !UUID_RE.test(userId)) {
        const e = new Error('Invalid user id.'); e.status = 400; e.code = 'INVALID_USER'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('orders')
        .insert({
            order_ref: orderRef,
            user_id: userId,
            product_type: productType,
            product_name: productName || productType,
            service_type: serviceType || productType,
            quantity,
            amount,
            fee,
            total_amount: totalAmount ?? amount,
            currency,
            status,
            payment_status: paymentStatus,
            fulfillment_status: fulfillmentStatus,
            provider,
            provider_order_id: providerOrderId,
            provider_reference: providerReference,
            source_table: sourceTable,
            source_id: sourceId,
            metadata,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .select('*')
        .single();
    if (error) {
        const e = new Error(`Failed to register order: ${error.message}`);
        e.status = 500; e.code = 'ORDER_REGISTER_FAILED'; throw e;
    }
    await recordEvent({
        orderId: data.id,
        eventType: 'order_created',
        newStatus: status,
        actorType: 'user',
        message: `Order ${orderRef} created`
    });
    return data;
}

// ─── List / detail ───────────────────────────────────────────────

async function listOrders(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('orders')
        .select('*', { count: 'exact' })
        .order(query.sort || 'created_at', { ascending: String(query.order || 'desc').toLowerCase() === 'asc' })
        .range(offset, offset + limit - 1);

    if (query.status && query.status !== 'all') {
        if (ORDER_STATUSES.has(String(query.status).toLowerCase())) q = q.eq('status', String(query.status).toLowerCase());
    }
    if (query.payment_status && query.payment_status !== 'all') q = q.eq('payment_status', query.payment_status);
    if (query.provider && query.provider !== 'all') q = q.eq('provider', query.provider);
    if (query.product_type && query.product_type !== 'all') q = q.eq('product_type', query.product_type);
    if (query.currency && query.currency !== 'all') q = q.eq('currency', String(query.currency).toUpperCase());
    if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);

    const fromIso = isoDate(query.from || query.date_from);
    const toIso = isoDate(query.to || query.date_to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);

    if (query.failed_only === 'true') q = q.in('status', ['failed','cancelled']);
    if (query.provider_failed === 'true') q = q.not('provider_status', 'is', null).eq('status', 'failed');
    if (query.webhook_failed === 'true') q = q.eq('webhook_status', 'failed');
    if (query.manual_review === 'true') q = q.eq('status', 'manual_review');

    if (query.search) {
        const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
        const parts = [
            `order_ref.ilike.%${safe}%`,
            `provider_order_id.ilike.%${safe}%`,
            `provider_reference.ilike.%${safe}%`,
            `external_reference.ilike.%${safe}%`
        ];
        try {
            const { data: users } = await supabaseAdmin
                .from('profiles').select('id')
                .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
                .limit(50);
            if (users?.length) parts.push(`user_id.in.(${users.map(u => u.id).join(',')})`);
        } catch (_) {}
        q = q.or(parts.join(','));
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { orders: [], count: 0, page, limit, totalPages: 0, available: false, reason: 'ORDERS_TABLE_NOT_FOUND' };
        }
        const e = new Error('Failed to load orders.'); e.status = 500; e.code = 'ORDER_LIST_ERROR'; throw e;
    }

    const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
    let profilesById = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles').select('id, username, email').in('id', userIds);
        for (const p of profiles || []) profilesById[p.id] = p;
    }

    return {
        orders: (data || []).map(o => shapeOrder(o, profilesById[o.user_id])),
        count: count || 0, page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0),
        available: true
    };
}

function shapeOrder(o, profile) {
    return {
        id: o.id,
        order_ref: o.order_ref,
        user_id: o.user_id,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : null,
        product_type: o.product_type,
        product_name: o.product_name,
        service_type: o.service_type,
        quantity: o.quantity,
        amount: o.amount,
        fee: o.fee,
        total_amount: o.total_amount,
        currency: o.currency,
        status: o.status,
        status_badge: statusBadge(o.status),
        payment_status: o.payment_status,
        fulfillment_status: o.fulfillment_status,
        provider: o.provider,
        provider_order_id: o.provider_order_id,
        provider_reference: o.provider_reference,
        provider_status: o.provider_status,
        webhook_status: o.webhook_status,
        webhook_received_at: o.webhook_received_at,
        last_provider_sync_at: o.last_provider_sync_at,
        failure_reason: o.failure_reason,
        admin_note: o.admin_note,
        refund_status: o.refund_status,
        refund_amount: o.refund_amount,
        refund_reference: o.refund_reference,
        refund_transaction_id: o.refund_transaction_id,
        refunded_at: o.refunded_at,
        cancelled_at: o.cancelled_at,
        completed_at: o.completed_at,
        failed_at: o.failed_at,
        metadata: o.metadata,
        attempt_number: o.attempt_number,
        parent_order_id: o.parent_order_id,
        retry_reason: o.retry_reason,
        created_at: o.created_at,
        updated_at: o.updated_at
    };
}

async function getOrder(orderId) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data: order, error } = await supabaseAdmin
        .from('orders').select('*').eq('id', orderId).maybeSingle();
    if (error) { const e = new Error('Failed to load order.'); e.status = 500; e.code = 'ORDER_DETAIL_ERROR'; throw e; }
    if (!order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }

    const [profileRes, eventsRes, webhooksRes, txRes] = await Promise.all([
        order.user_id ? supabaseAdmin.from('profiles').select('id, username, email, status, created_at').eq('id', order.user_id).maybeSingle() : Promise.resolve({ data: null }),
        supabaseAdmin.from('order_events').select('*').eq('order_id', order.id).order('created_at', { ascending: true }),
        supabaseAdmin.from('order_webhook_events').select('id, provider, event_type, event_id, signature_valid, processing_status, processing_error, processed_at, created_at').eq('order_id', order.id).order('created_at', { ascending: false }),
        supabaseAdmin.from('transactions')
            .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
            .or(`metadata->>order_id.eq.${order.id},source_id.eq.${order.id}`)
            .order('created_at', { ascending: true })
    ]);

    const refundTx = (txRes.data || []).find(t => t.type === 'refund') || null;
    const primaryTx = (txRes.data || []).find(t => t.type !== 'refund') || null;

    return {
        order: shapeOrder(order, profileRes.data),
        user: profileRes.data,
        events: eventsRes.data || [],
        webhooks: webhooksRes.data || [],
        transactions: txRes.data || [],
        transaction: primaryTx,
        refund_transaction: refundTx
    };
}

async function getTimeline(orderId) {
    const { data, error } = await supabaseAdmin
        .from('order_events').select('*').eq('order_id', orderId).order('created_at', { ascending: true });
    if (error) { const e = new Error('Failed to load timeline.'); e.status = 500; e.code = 'TIMELINE_ERROR'; throw e; }
    return data || [];
}

async function getWebhooks(orderId) {
    const { data, error } = await supabaseAdmin
        .from('order_webhook_events').select('*').eq('order_id', orderId).order('created_at', { ascending: false });
    if (error) { const e = new Error('Failed to load webhooks.'); e.status = 500; e.code = 'WEBHOOK_LIST_ERROR'; throw e; }
    return data || [];
}

// ─── Stats ───────────────────────────────────────────────────────

async function getStats(query = {}) {
    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);

    const rpc = await supabaseAdmin.rpc('order_stats', { p_from: fromIso, p_to: toIso });
    if (!rpc.error && rpc.data) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        const startOfToday = startOfWatDay();
        const startOfWeek = new Date(Date.now() - 7 * 86400_000).toISOString();
        const startOfMonth = new Date(Date.now() - 30 * 86400_000).toISOString();
        const [todayCount, weekCount, monthCount, failedCount, providerFailCount, webhookPendingCount, webhookFailedCount] = await Promise.all([
            countOrders({ from: startOfToday }),
            countOrders({ from: startOfWeek }),
            countOrders({ from: startOfMonth }),
            countOrders({ status: 'failed' }),
            countOrders({ status: 'failed', has_provider: true }),
            countOrders({ webhook_status: 'received' }),
            countOrders({ webhook_status: 'failed' })
        ]);
        return {
            totalOrders: Number(row.total_orders || 0),
            pending: Number(row.pending_orders || 0),
            paid: Number(row.paid_orders || 0),
            processing: Number(row.processing_orders || 0),
            completed: Number(row.completed_orders || 0),
            partial: Number(row.partial_orders || 0),
            failed: Number(row.failed_orders || 0),
            cancelled: Number(row.cancelled_orders || 0),
            refunded: Number(row.refunded_orders || 0),
            manualReview: Number(row.manual_review_orders || 0),
            totalRevenueNgn: String(row.total_revenue_ngn || '0.00'),
            totalRevenueUsd: String(row.total_revenue_usd || '0.00'),
            totalRefundedNgn: String(row.total_refunded_ngn || '0.00'),
            totalRefundedUsd: String(row.total_refunded_usd || '0.00'),
            netRevenueNgn: String(row.net_revenue_ngn || '0.00'),
            netRevenueUsd: String(row.net_revenue_usd || '0.00'),
            ordersToday: todayCount,
            ordersThisWeek: weekCount,
            ordersThisMonth: monthCount,
            failedOrderCount: failedCount,
            providerFailureCount: providerFailCount,
            webhookPendingCount: webhookPendingCount,
            webhookFailedCount: webhookFailedCount,
            available: true
        };
    }
    if (rpc.error?.code !== '42883' && rpc.error?.code !== 'PGRST202') {
        const e = new Error('Failed to aggregate stats.'); e.status = 500; e.code = 'STATS_ERROR'; throw e;
    }

    // Fallback: counts only, money as null.
    const [total, pending, completed, failed, refunded] = await Promise.all([
        countOrders({}),
        countOrders({ status: 'pending' }),
        countOrders({ status: 'completed' }),
        countOrders({ status: 'failed' }),
        countOrders({ status: 'refunded' })
    ]);
    return {
        totalOrders: total,
        pending, completed, failed, refunded,
        paid: 0, processing: 0, partial: 0, cancelled: 0, manualReview: 0,
        totalRevenueNgn: null, totalRevenueUsd: null,
        totalRefundedNgn: null, totalRefundedUsd: null,
        netRevenueNgn: null, netRevenueUsd: null,
        ordersToday: 0, ordersThisWeek: 0, ordersThisMonth: 0,
        failedOrderCount: failed, providerFailureCount: 0,
        webhookPendingCount: 0, webhookFailedCount: 0,
        available: false, reason: 'STATS_RPC_NOT_DEPLOYED'
    };
}

async function countOrders({ from = null, status = null, webhook_status = null, has_provider = false }) {
    let q = supabaseAdmin.from('orders').select('id', { count: 'exact', head: true });
    if (from) q = q.gte('created_at', from);
    if (status) q = q.eq('status', status);
    if (webhook_status) q = q.eq('webhook_status', webhook_status);
    if (has_provider) q = q.not('provider_order_id', 'is', null);
    const { count } = await q;
    return count || 0;
}

function startOfWatDay() {
    const OFFSET_MS = 60 * 60 * 1000;
    const now = new Date();
    const local = new Date(now.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    return new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS).toISOString();
}

// ─── THE PIPELINE ────────────────────────────────────────────────
// Every source of provider state (webhook, admin sync, scheduled
// sync) calls this. It performs the state transition + financial
// action together, and it is safe to call twice.

async function processProviderUpdate({ order, providerStatus, providerResponse, source, actorId, actorType, ctx }) {
    const currentStatus = String(order.status || '').toLowerCase();
    const targetStatus = normalizeProviderStatus(providerStatus);

    // Map provider status → internal status.
    const internalTarget = mapProviderToInternal(targetStatus, currentStatus);
    const patch = {
        provider_status: String(providerStatus || '').toLowerCase(),
        provider_response: providerResponse || null,
        payment_status: (internalTarget === 'completed' ? 'paid' : order.payment_status),
        fulfillment_status: internalTarget
    };

    // If status isn't changing, just record provider metadata.
    if (!internalTarget || internalTarget === currentStatus) {
        await supabaseAdmin
            .from('orders')
            .update({
                provider_status: patch.provider_status,
                provider_response: patch.provider_response,
                last_provider_sync_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);
        await recordEvent({
            orderId: order.id,
            eventType: 'provider_status_synced',
            actorType: actorType || source,
            message: `Provider status ${providerStatus} (no change)`
        });
        return { updated: false, status: currentStatus };
    }

    // Enforce the state machine unless we're an admin override.
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (actorType !== 'admin' && !allowed.includes(internalTarget)) {
        await recordEvent({
            orderId: order.id,
            eventType: 'provider_status_ignored',
            actorType: actorType || source,
            message: `Ignored transition ${currentStatus} → ${internalTarget}`
        });
        return { updated: false, status: currentStatus, reason: 'INVALID_TRANSITION' };
    }

    const { error: rpcErr } = await supabaseAdmin.rpc('apply_order_provider_update', {
        p_order_id: order.id,
        p_expected_status: currentStatus,
        p_next_status: internalTarget,
        p_patch: patch,
        p_event_type: `provider_${internalTarget}`,
        p_actor_type: actorType || source,
        p_actor_id: actorId || null,
        p_message: `Provider reported ${providerStatus}`
    });

    if (rpcErr) {
        const msg = String(rpcErr.message || '');
        if (msg.includes('ORDER_STATE_CHANGED')) {
            return { updated: false, status: currentStatus, reason: 'STATE_CHANGED' };
        }
        throw new Error(`Failed to apply provider update: ${msg}`);
    }

    // Financial action: refund on failure.
    if ((internalTarget === 'failed' || internalTarget === 'cancelled') && order.refund_status !== 'refunded') {
        try {
            await refundOrder({
                orderId: order.id,
                reason: `Provider reported ${providerStatus}`,
                ctx: null,
                forceAmount: null
            });
        } catch (refundErr) {
            console.error('[ORDERS] auto-refund failed for', order.order_ref, refundErr.message);
            await recordEvent({
                orderId: order.id,
                eventType: 'refund_failed',
                actorType: 'system',
                message: refundErr.message
            });
        }
    }

    // User notification on terminal states.
    if (['completed','failed','cancelled','partial','refunded'].includes(internalTarget)) {
        const titles = {
            completed: 'Order Completed',
            failed: 'Order Failed',
            cancelled: 'Order Cancelled',
            partial: 'Order Partially Completed',
            refunded: 'Order Refunded'
        };
        const icons = { completed: '✅', failed: '❌', cancelled: '🚫', partial: '⚠️', refunded: '💰' };
        await createNotification({
            userId: order.user_id,
            title: titles[internalTarget],
            message: `Your order ${order.order_ref} is now ${internalTarget}.`,
            type: `order_${internalTarget}`,
            icon: icons[internalTarget],
            link: '/history'
        });
    }

    return { updated: true, status: internalTarget };
}

function normalizeProviderStatus(s) {
    return String(s || '').toLowerCase().trim();
}

function mapProviderToInternal(providerStatus, currentInternal) {
    const s = providerStatus;
    if (!s) return null;
    if (s === 'completed' || s === 'success' || s === 'successful' || s === 'delivered' || s === 'done' || s === 'finished') return 'completed';
    if (s === 'failed' || s === 'error' || s === 'rejected' || s === 'declined') return 'failed';
    if (s === 'cancelled' || s === 'canceled' || s === 'void') return 'cancelled';
    if (s === 'refunded') return 'refunded';
    if (s === 'partial' || s === 'partially_completed' || s === 'partially completed') return 'partial';
    if (s === 'in progress' || s === 'in_progress' || s === 'processing' || s === 'started') return 'processing';
    if (s === 'pending' || s === 'received' || s === 'submitted' || s === 'created') return currentInternal || 'pending';
    return null;
}

// ─── Admin mutations ─────────────────────────────────────────────

async function updateOrderStatus({ orderId, status, note, ctx, actorType = 'admin' }) {
    const next = String(status || '').toLowerCase();
    if (!ORDER_STATUSES.has(next)) {
        const e = new Error('Invalid status.'); e.status = 422; e.code = 'INVALID_STATUS'; throw e;
    }

    const { data: order } = await supabaseAdmin.from('orders').select('*').eq('id', orderId).maybeSingle();
    if (!order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }

    const current = String(order.status || '').toLowerCase();
    if (current === next) return { order: shapeOrder(order), no_op: true };

    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
        const e = new Error(`Cannot transition from "${current}" to "${next}".`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION';
        e.allowed_transitions = allowed; throw e;
    }

    const { error: rpcErr } = await supabaseAdmin.rpc('apply_order_provider_update', {
        p_order_id: orderId,
        p_expected_status: current,
        p_next_status: next,
        p_patch: { fulfillment_status: next, failure_reason: note || null },
        p_event_type: 'admin_status_change',
        p_actor_type: actorType,
        p_actor_id: ctx?.adminId || null,
        p_message: note ? String(note).slice(0, 500) : null
    });

    if (rpcErr) {
        const msg = String(rpcErr.message || '');
        if (msg.includes('ORDER_STATE_CHANGED')) {
            const e = new Error('Order changed before this action completed. Reload and try again.');
            e.status = 409; e.code = 'ORDER_STATE_CHANGED'; throw e;
        }
        throw new Error(`Failed to update order: ${msg}`);
    }

    if (note) {
        await supabaseAdmin.from('orders').update({ admin_note: String(note).slice(0, 1000) }).eq('id', orderId);
    }

    await recordAudit({
        ctx, action: `order.status_${next}`, orderId,
        before: { status: current }, after: { status: next }, reason: note
    });

    const fresh = await getOrder(orderId);
    return { order: fresh.order };
}

async function refundOrder({ orderId, reason, ctx, forceAmount = null }) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }

    const { data: order, error } = await supabaseAdmin.from('orders').select('*').eq('id', orderId).maybeSingle();
    if (error || !order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }

    if (order.refund_status === 'refunded') {
        return {
            refund: {
                reference: order.refund_reference,
                amount: order.refund_amount,
                currency: order.currency,
                already_refunded: true
            }
        };
    }

    const status = String(order.status || '').toLowerCase();
    const refundable = ['failed','cancelled','partial','completed','manual_review'];
    if (!refundable.includes(status)) {
        const e = new Error(`Order status "${status}" is not refundable.`);
        e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
    }

    const refundAmount = forceAmount != null ? Number(forceAmount) : Number(order.total_amount);
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
        const e = new Error('Invalid refund amount.'); e.status = 422; e.code = 'INVALID_AMOUNT'; throw e;
    }
    if (refundAmount > Number(order.total_amount)) {
        const e = new Error('Refund amount exceeds order total.');
        e.status = 422; e.code = 'REFUND_EXCEEDS_ORDER'; throw e;
    }

    const refundRef = `REFUND-${order.order_ref}`;

    // Claim the refund atomically first (unique index on refund_reference
    // provides a hard stop; the update below is defensive).
    const { data: claimed, error: claimErr } = await supabaseAdmin
        .from('orders')
        .update({
            refund_status: 'refunding',
            refund_amount: refundAmount,
            refund_reference: refundRef,
            updated_at: new Date().toISOString()
        })
        .eq('id', order.id)
        .neq('refund_status', 'refunded')
        .is('refund_reference', null)
        .select('*')
        .maybeSingle();

    if (claimErr || !claimed) {
        // Could be that another caller already claimed it.
        const { data: fresh } = await supabaseAdmin.from('orders').select('refund_reference, refund_amount, currency').eq('id', orderId).maybeSingle();
        return {
            refund: {
                reference: fresh?.refund_reference || refundRef,
                amount: fresh?.refund_amount || refundAmount,
                currency: fresh?.currency || order.currency,
                already_refunded: true
            }
        };
    }

    // Credit the wallet.
    let creditResult;
    try {
        creditResult = await LedgerService.creditWallet({
            userId: order.user_id,
            amount: refundAmount,
            currency: order.currency,
            description: `Refund for order ${order.order_ref}`,
            reference: refundRef,
            type: 'refund',
            sourceType: 'order',
            sourceId: order.id,
            metadata: { order_ref: order.order_ref, reason: String(reason).slice(0, 500) }
        });
    } catch (creditErr) {
        const msg = String(creditErr.message || '');
        if (msg.includes('duplicate') || msg.includes('unique')) {
            // Wallet already credited — treat as success.
            await supabaseAdmin.from('orders')
                .update({ refund_status: 'refunded', refunded_at: new Date().toISOString() })
                .eq('id', order.id);
            return {
                refund: { reference: refundRef, amount: refundAmount, currency: order.currency, already_refunded: true }
            };
        }
        // Real failure — roll the claim back so it can be retried.
        await supabaseAdmin.from('orders')
            .update({ refund_status: 'failed', refund_reference: null, updated_at: new Date().toISOString() })
            .eq('id', order.id);
        const e = new Error('Wallet refund failed.'); e.status = 500; e.code = 'LEDGER_REFUND_FAILED'; e.cause = msg; throw e;
    }

    // Mark refunded + write transaction + event.
    await supabaseAdmin.from('orders')
        .update({
            refund_status: 'refunded',
            refund_transaction_id: creditResult.transaction_id || null,
            refunded_at: new Date().toISOString(),
            status: order.status === 'completed' ? 'refunded' : order.status,
            updated_at: new Date().toISOString()
        })
        .eq('id', order.id);

    try {
        await supabaseAdmin.from('transactions').insert({
            user_id: order.user_id,
            type: 'refund',
            status: 'completed',
            currency: order.currency,
            amount: refundAmount,
            ref: refundRef,
            reference: refundRef,
            source_id: order.id,
            source_type: 'order',
            description: `Refund for order ${order.order_ref}`,
            metadata: { order_id: order.id, order_ref: order.order_ref, reason: String(reason).slice(0, 500) },
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    } catch (txErr) {
        if (!String(txErr.message || '').includes('duplicate')) {
            console.warn('[ORDERS] refund transaction insert failed (non-fatal):', txErr.message);
        }
    }

    await recordEvent({
        orderId: order.id,
        eventType: 'refund_created',
        actorType: ctx ? 'admin' : 'system',
        actorId: ctx?.adminId || null,
        message: `Refund of ${refundAmount} ${order.currency} — ${reason}`
    });

    if (ctx) {
        await recordAudit({
            ctx, action: 'order.refund', orderId: order.id,
            before: { refund_status: order.refund_status, amount: order.total_amount },
            after: { refund_status: 'refunded', refund_amount: refundAmount, refund_reference: refundRef },
            reason
        });
    }

    await createNotification({
        userId: order.user_id,
        title: 'Order Refunded',
        message: `A refund of ${refundAmount} ${order.currency} has been credited for order ${order.order_ref}.`,
        type: 'order_refunded', icon: '💰', link: '/history'
    });

    return {
        refund: {
            reference: refundRef,
            amount: refundAmount,
            currency: order.currency,
            already_refunded: false
        }
    };
}

async function cancelOrder({ orderId, reason, ctx }) {
    return updateOrderStatus({ orderId, status: 'cancelled', note: reason, ctx });
}

async function retryOrder({ orderId, reason, ctx }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const { data: order } = await supabaseAdmin.from('orders').select('*').eq('id', orderId).maybeSingle();
    if (!order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }
    if (!['failed','cancelled','expired'].includes(String(order.status))) {
        const e = new Error('Only failed/cancelled/expired orders can be retried.');
        e.status = 422; e.code = 'NOT_RETRYABLE'; throw e;
    }

    const attemptNumber = Number(order.attempt_number || 1) + 1;
    const { data: child, error } = await supabaseAdmin.from('orders').insert({
        order_ref: `${order.order_ref}-R${attemptNumber}`,
        user_id: order.user_id,
        product_type: order.product_type,
        product_name: order.product_name,
        service_type: order.service_type,
        quantity: order.quantity,
        amount: order.amount,
        fee: order.fee,
        total_amount: 0,
        currency: order.currency,
        status: 'pending',
        payment_status: 'paid',
        fulfillment_status: 'pending',
        provider: order.provider,
        provider_order_id: null,
        provider_reference: null,
        source_table: order.source_table,
        source_id: order.source_id,
        parent_order_id: order.id,
        attempt_number: attemptNumber,
        retry_reason: String(reason).slice(0, 500),
        metadata: { retried_from: order.order_ref },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    }).select('*').single();

    if (error) {
        const e = new Error('Failed to create retry order.'); e.status = 500; e.code = 'RETRY_FAILED'; throw e;
    }

    await recordEvent({
        orderId: child.id,
        eventType: 'retry_created',
        actorType: 'admin',
        actorId: ctx?.adminId || null,
        message: `Retry #${attemptNumber} of ${order.order_ref}`
    });

    await recordAudit({
        ctx, action: 'order.retry', orderId: order.id,
        before: { status: order.status },
        after: { retry_order_ref: child.order_ref, attempt_number: attemptNumber },
        reason
    });

    return { retry_order: shapeOrder(child) };
}

async function addNote({ orderId, note, ctx }) {
    if (!note || String(note).trim().length < 2) {
        const e = new Error('Note text is required.'); e.status = 422; e.code = 'NOTE_REQUIRED'; throw e;
    }
    const { data: updated, error } = await supabaseAdmin.from('orders')
        .update({ admin_note: String(note).slice(0, 1000), updated_at: new Date().toISOString() })
        .eq('id', orderId)
        .select('*')
        .maybeSingle();
    if (error || !updated) {
        const e = new Error('Failed to save note.'); e.status = 500; e.code = 'NOTE_SAVE_FAILED'; throw e;
    }
    await recordAudit({
        ctx, action: 'order.note', orderId,
        before: null, after: { admin_note: updated.admin_note }, reason: note
    });
    return { order: shapeOrder(updated) };
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    ORDER_STATUSES,
    ALLOWED_TRANSITIONS,

    registerOrder,
    listOrders,
    getOrder,
    getTimeline,
    getWebhooks,
    getStats,

    processProviderUpdate,
    updateOrderStatus,
    refundOrder,
    cancelOrder,
    retryOrder,
    addNote,

    recordEvent,
    shapeOrder,
    normalizeProviderStatus,
    mapProviderToInternal
};