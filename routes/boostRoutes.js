// routes/boost.js
// ─────────────────────────────────────────────────────────────────
// User-facing Boost routes.
// Business logic lives in services/boostService.js and
// services/boostSyncService.js. This file is pass-through.
//
// User routes require authMiddleware. Admin routes are in
// routes/admin/boostAdminRoutes.js.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const boostService = require('../services/boostService');
const syncService  = require('../services/boostSyncService');

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function fail(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code   = err?.code   || 'BOOST_ERROR';
    if (status >= 500) console.error('[BOOST]', code, err?.message || err);
    const body = { success: false, error: err?.message || 'Boost request failed.', code };
    if (err?.required) body.required = err.required;
    if (err?.balance)  body.balance  = err.balance;
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
    res.status(status).json(body);
}

// ─── Config ──────────────────────────────────────────────────────

router.get('/config', async (req, res) => {
    try {
        const [usdRate, markup] = await Promise.all([
            boostService.getUsdToNgnRate(),
            boostService.getDefaultMarkup()
        ]);
        ok(res, { config: { usd_to_ngn: usdRate, markup_percent: markup * 100 } });
    } catch (err) { fail(res, err); }
});

// ─── Services ────────────────────────────────────────────────────

router.get('/services', authMiddleware, async (req, res) => {
    try {
        const result = await boostService.listServices({
            page: req.query.page, limit: req.query.limit,
            platform: req.query.platform, category: req.query.category,
            search: req.query.search
        }, { forUsersOnly: true });
        ok(res, { services: result.services, count: result.count, page: result.page, limit: result.limit, totalPages: result.totalPages });
    } catch (err) { fail(res, err); }
});

router.get('/services/:serviceId', authMiddleware, async (req, res) => {
    try {
        const { data: svc, error } = await supabaseAdmin
            .from('boost_services').select('*')
            .eq('provider_service_id', String(req.params.serviceId))
            .eq('active', true).eq('visible_to_users', true)
            .maybeSingle();
        if (error || !svc) return res.status(404).json({ success: false, error: 'Service not found', code: 'SERVICE_NOT_FOUND' });
        ok(res, { service: svc });
    } catch (err) { fail(res, err); }
});

// ─── Place order ─────────────────────────────────────────────────

router.post('/order', authMiddleware, async (req, res) => {
    try {
        const { service_id, link, quantity, wallet_type } = req.body || {};
        const idempotencyKey = req.headers['idempotency-key'] || null;

        if (!service_id || !link || !quantity) {
            return res.status(400).json({ success: false, error: 'Missing required fields: service_id, link, quantity', code: 'MISSING_FIELDS' });
        }
        const qty = parseInt(quantity, 10);
        if (!Number.isFinite(qty) || qty < 1) {
            return res.status(422).json({ success: false, error: 'Quantity must be a positive integer', code: 'INVALID_QUANTITY' });
        }

        const result = await boostService.placeOrder({
            userId: req.user.id,
            serviceId: service_id,
            link: String(link),
            quantity: qty,
            walletType: wallet_type || 'NGN',
            idempotencyKey
        });

        // Best-effort provider submission. If this fails, the order
        // stays in 'pending' / 'provider_unknown' and the sync worker
        // will retry.
        try {
            if (!result.idempotent) {
                await syncService.submitPendingBoostOrders({ limit: 5 });
            }
        } catch (e) {
            console.warn('[BOOST] immediate submission attempt failed:', e.message);
        }

        ok(res, { order: result.order, idempotent: !!result.idempotent });
    } catch (err) { fail(res, err); }
});

// ─── User orders ─────────────────────────────────────────────────

router.get('/orders', authMiddleware, async (req, res) => {
    try {
        const result = await boostService.listOrders(
            { page: req.query.page, limit: req.query.limit, status: req.query.status, from: req.query.from, to: req.query.to },
            { forUserId: req.user.id }
        );
        ok(res, { orders: result.orders, count: result.count, page: result.page, limit: result.limit, totalPages: result.totalPages });
    } catch (err) { fail(res, err); }
});

router.get('/orders/:orderRef', authMiddleware, async (req, res) => {
    try {
        const { data: order } = await supabaseAdmin
            .from('boost_orders').select('*')
            .eq('order_ref', String(req.params.orderRef))
            .eq('user_id', req.user.id)
            .maybeSingle();
        if (!order) return res.status(404).json({ success: false, error: 'Order not found', code: 'BOOST_NOT_FOUND' });

        // Refresh from provider.
        if (['pending','processing','in_progress','partial','provider_unknown'].includes(String(order.status))) {
            try { await syncService.syncBoostOrder(order); } catch (_) {}
        }

        const fresh = await boostService.getOrder(order.id);
        ok(res, fresh);
    } catch (err) { fail(res, err); }
});

router.post('/orders/:orderRef/refresh', authMiddleware, async (req, res) => {
    try {
        const { data: order } = await supabaseAdmin
            .from('boost_orders').select('*')
            .eq('order_ref', String(req.params.orderRef))
            .eq('user_id', req.user.id)
            .maybeSingle();
        if (!order) return res.status(404).json({ success: false, error: 'Order not found', code: 'BOOST_NOT_FOUND' });

        const r = await syncService.syncBoostOrder(order);
        const fresh = await boostService.getOrder(order.id);
        ok(res, { ...fresh, refreshed: !!r.updated });
    } catch (err) { fail(res, err); }
});

// ─── Stats ───────────────────────────────────────────────────────

router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('boost_orders')
            .select('status, total_amount, currency')
            .eq('user_id', req.user.id);
        if (error) throw error;

        let totalOrders = 0, completed = 0, pending = 0, failed = 0, processing = 0;
        let totalSpentNGN = 0, totalSpentUSD = 0;
        for (const o of data || []) {
            totalOrders++;
            const s = String(o.status || '').toLowerCase();
            if (s === 'completed') completed++;
            else if (s === 'pending') pending++;
            else if (['failed','cancelled','refunded'].includes(s)) failed++;
            else if (['processing','in_progress','partial'].includes(s)) processing++;
            const amt = Number(o.total_amount || 0);
            if (o.currency === 'NGN') totalSpentNGN += amt;
            else if (o.currency === 'USD') totalSpentUSD += amt;
        }
        ok(res, { stats: { totalOrders, completed, pending, processing, failed, totalSpentNGN, totalSpentUSD } });
    } catch (err) { fail(res, err); }
});

module.exports = router;