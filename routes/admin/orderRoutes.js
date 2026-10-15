// routes/admin/orderRoutes.js
// ─────────────────────────────────────────────────────────────────
// Central admin Orders API. Thin routes over ordersService.
//
// All :orderId route params are integers in this schema. The guard
// is `/^\d+$/` — non-numeric ids fall through to the next router.
//
// Every mutation requires a permission. Refund additionally requires
// step-up MFA. Every mutation is audited with a request_id.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');
const ordersService = require('../../services/ordersService');
const providerRegistry = require('../../services/providers/providerRegistry');

const INT_RE = /^\d+$/;

const SAFE_MESSAGES = {
    INVALID_ID: 'Invalid identifier.',
    INVALID_USER: 'Invalid user.',
    INVALID_ORDER_REF: 'Invalid order reference.',
    ORDER_NOT_FOUND: 'Order not found.',
    ORDER_ALREADY_EXISTS: 'Order already exists.',
    INVALID_STATUS: 'Invalid status.',
    INVALID_STATUS_TRANSITION: 'That status change is not allowed.',
    ORDER_STATE_CHANGED: 'The order changed before this action completed. Reload and try again.',
    REASON_REQUIRED: 'A reason is required.',
    NOT_REFUNDABLE: 'This order is not eligible for a refund.',
    INVALID_AMOUNT: 'Invalid amount.',
    REFUND_EXCEEDS_ORDER: 'Refund amount exceeds order total.',
    LEDGER_REFUND_FAILED: 'Wallet refund failed.',
    REFUND_CLAIM_FAILED: 'Could not claim refund — try again.',
    NOTE_REQUIRED: 'Note text is required.',
    NOTE_SAVE_FAILED: 'Failed to save note.',
    NOT_RETRYABLE: 'This order cannot be retried.',
    RETRY_FAILED: 'Retry could not be created.',
    PROVIDER_NOT_SUPPORTED: 'Provider does not support this action.',
    AUDIT_INSERT_FAILED: 'Action recorded to ledger but audit failed. Escalate.'
};

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}
router.use('/orders', attachRequestId);

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function err(res, e) {
    if (res.headersSent) return;
    const status = e?.status || 500;
    const code = e?.code || 'ORDERS_ERROR';
    const message = SAFE_MESSAGES[code] || (status >= 500 ? 'Something went wrong. Please try again.' : (e?.message || 'Orders request failed.'));
    if (status >= 500) console.error('[ADMIN ORDERS]', code, e?.message || e);
    const body = { success: false, code, error: message };
    if (e?.allowed_transitions) body.allowed_transitions = e.allowed_transitions;
    res.status(status).json(body);
}
function ctxFrom(req) {
    return {
        adminId: req.adminContext?.id || null,
        adminEmail: req.adminContext?.email || null,
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.requestId || null
    };
}

// ─── List / stats / export ───────────────────────────────────────

router.get(
    '/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await ordersService.listOrders({
                page: req.query.page, limit: req.query.limit,
                status: req.query.status, payment_status: req.query.payment_status,
                provider: req.query.provider, product_type: req.query.product_type,
                currency: req.query.currency, user_id: req.query.user_id,
                from: req.query.from || req.query.date_from,
                to: req.query.to || req.query.date_to,
                sort: req.query.sort, order: req.query.order,
                search: req.query.search,
                failed_only: req.query.failed_only,
                provider_failed: req.query.provider_failed,
                webhook_failed: req.query.webhook_failed,
                manual_review: req.query.manual_review
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/orders/stats',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const stats = await ordersService.getStats({
                from: req.query.from || null,
                to: req.query.to || null
            });
            ok(res, { stats });
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/orders/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    async (req, res) => {
        try {
            const result = await ordersService.listOrders({
                page: 1, limit: 5000,
                status: req.query.status,
                provider: req.query.provider,
                product_type: req.query.product_type,
                currency: req.query.currency,
                from: req.query.from || req.query.date_from,
                to: req.query.to || req.query.date_to,
                search: req.query.search
            });
            const header = ['Order Ref','Customer','Email','Product','Provider','Provider Order ID','Amount','Currency','Status','Payment','Created','Completed','Failed'];
            const lines = [header.map(h => `"${h}"`).join(',')];
            for (const o of result.orders) {
                lines.push([
                    o.order_ref, o.user?.username || '', o.user?.email || '',
                    o.product_name, o.provider || '',
                    o.provider_order_id || '',
                    o.total_amount, o.currency, o.status, o.payment_status,
                    o.created_at, o.completed_at || '', o.failed_at || ''
                ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
            }
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=orders_${new Date().toISOString().slice(0,10)}.csv`);
            res.send(lines.join('\n'));
        } catch (e) { err(res, e); }
    }
);

// ─── Detail / timeline / webhooks / provider status ─────────────

router.get(
    '/orders/:orderId',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!INT_RE.test(String(req.params.orderId || ''))) return next();
        try {
            const data = await ordersService.getOrder(req.params.orderId);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/orders/:orderId/timeline',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!INT_RE.test(String(req.params.orderId || ''))) return next();
        try {
            const events = await ordersService.getTimeline(req.params.orderId);
            ok(res, { events });
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/orders/:orderId/webhooks',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!INT_RE.test(String(req.params.orderId || ''))) return next();
        try {
            const webhooks = await ordersService.getWebhooks(req.params.orderId);
            ok(res, { webhooks });
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/orders/:orderId/provider-status',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!INT_RE.test(String(req.params.orderId || ''))) return next();
        try {
            const data = await ordersService.getOrder(req.params.orderId);
            const adapter = providerRegistry.get(data.order.provider);
            if (!adapter || typeof adapter.getOrderStatus !== 'function') {
                return ok(res, {
                    local_status: data.order.status,
                    provider: data.order.provider,
                    provider_supported: false,
                    reason: 'PROVIDER_DOES_NOT_SUPPORT_STATUS'
                });
            }
            const providerState = await adapter.getOrderStatus(data.order);
            ok(res, {
                local_status: data.order.status,
                provider_status: providerState?.status || null,
                provider_order_id: data.order.provider_order_id,
                last_checked: new Date().toISOString()
            });
        } catch (e) { err(res, e); }
    }
);

// ─── Sync single ─────────────────────────────────────────────────

router.post(
    '/orders/:orderId/sync',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!INT_RE.test(String(req.params.orderId || ''))) return next();
        try {
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const data = await ordersService.getOrder(req.params.orderId);
            const adapter = providerRegistry.get(data.order.provider);
            if (!adapter || typeof adapter.getOrderStatus !== 'function') {
                const e = new Error('Provider does not support status check.');
                e.status = 400; e.code = 'PROVIDER_NOT_SUPPORTED'; throw e;
            }
            const providerState = await adapter.getOrderStatus(data.order);
            const result = await ordersService.processProviderUpdate({
                order: data.order,
                providerStatus: providerState?.status || null,
                providerResponse: providerState?.raw || null,
                source: 'admin_sync',
                actorType: 'admin',
                actorId: req.adminContext.id,
                ctx: ctxFrom(req)
            });
            ok(res, { updated: result.updated, status: result.status });
        } catch (e) { err(res, e); }
    }
);

// ─── Sync pending (bulk, capped) ─────────────────────────────────

router.post(
    '/orders/sync-pending',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
            const { data: rows, error } = await require('../../db/supabase').supabaseAdmin
                .from('orders')
                .select('id, order_ref, user_id, status, provider, provider_order_id, provider_reference, total_amount, currency, refund_status, metadata')
                .in('status', ['pending', 'paid', 'processing', 'in_progress', 'partial', 'provider_unknown'])
                .not('provider_order_id', 'is', null)
                .order('last_provider_sync_at', { ascending: true, nullsFirst: true })
                .limit(limit);
            if (error) throw error;

            let updated = 0;
            const results = [];
            for (const order of rows || []) {
                try {
                    const adapter = providerRegistry.get(order.provider);
                    if (!adapter || typeof adapter.getOrderStatus !== 'function') {
                        results.push({ order_ref: order.order_ref, skipped: true });
                        continue;
                    }
                    const providerState = await adapter.getOrderStatus(order);
                    const r = await ordersService.processProviderUpdate({
                        order,
                        providerStatus: providerState?.status || null,
                        providerResponse: providerState?.raw || null,
                        source: 'scheduled_sync',
                        actorType: 'system',
                        ctx: ctxFrom(req)
                    });
                    if (r.updated) updated++;
                    results.push({ order_ref: order.order_ref, ...r });
                } catch (e) {
                    results.push({ order_ref: order.order_ref, error: e.message });
                }
            }
            ok(res, { processed: (rows || []).length, updated, results });
        } catch (e) { err(res, e); }
    }
);

// ─── Status update ───────────────────────────────────────────────

router.put(
    '/orders/:orderId/status',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!INT_RE.test(String(req.params.orderId || ''))) return next();
        try {
            const { status, note } = req.body || {};
            const result = await ordersService.updateOrderStatus({
                orderId: req.params.orderId,
                status,
                note,
                ctx: ctxFrom(req)
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Refund — step-up ────────────────────────────────────────────

router.post(
    '/orders/:orderId/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!INT_RE.test(String(req.params.orderId || ''))) return next();
        try {
            const { reason, amount } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const result = await ordersService.refundOrder({
                orderId: req.params.orderId,
                reason: String(reason).slice(0, 500),
                forceAmount: amount != null ? Number(amount) : null,
                ctx: ctxFrom(req)
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Retry ───────────────────────────────────────────────────────

router.post(
    '/orders/:orderId/retry',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!INT_RE.test(String(req.params.orderId || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const result = await ordersService.retryOrder({
                orderId: req.params.orderId,
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req)
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Cancel ──────────────────────────────────────────────────────

router.post(
    '/orders/:orderId/cancel',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!INT_RE.test(String(req.params.orderId || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const result = await ordersService.cancelOrder({
                orderId: req.params.orderId,
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req)
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Note ────────────────────────────────────────────────────────

router.post(
    '/orders/:orderId/note',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!INT_RE.test(String(req.params.orderId || ''))) return next();
        try {
            const { note } = req.body || {};
            const result = await ordersService.addNote({
                orderId: req.params.orderId,
                note,
                ctx: ctxFrom(req)
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

module.exports = router;