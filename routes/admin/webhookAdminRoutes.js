// routes/admin/webhookAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin webhook operations.
//   GET  /api/admin/webhooks
//   GET  /api/admin/webhooks/stats
//   GET  /api/admin/webhooks/:id
//   POST /api/admin/webhooks/:id/reprocess
//   POST /api/admin/webhooks/:id/ignore
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { supabaseAdmin } = require('../../db/supabase');
const webhookService = require('../../services/webhookService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function err(res, e) {
    if (res.headersSent) return;
    const status = e?.status || 500;
    if (status >= 500) console.error('[ADMIN WEBHOOKS]', e?.message || e);
    res.status(status).json({ success: false, code: e?.code || 'WEBHOOK_ERROR', error: e?.message || 'Webhook request failed.' });
}

router.get(
    '/webhooks',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res) => {
        try {
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
            const offset = (page - 1) * limit;

            let q = supabaseAdmin
                .from('webhook_events')
                .select('id, provider, event_id, event_type, order_id, provider_order_id, signature_valid, processing_status, processing_error, received_at, processed_at', { count: 'exact' })
                .order('received_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (req.query.provider && req.query.provider !== 'all') q = q.eq('provider', req.query.provider);
            if (req.query.status && req.query.status !== 'all') q = q.eq('processing_status', req.query.status);
            if (req.query.order_id && UUID_RE.test(req.query.order_id)) q = q.eq('order_id', req.query.order_id);

            const { data, error, count } = await q;
            if (error) throw new Error(error.message);

            ok(res, {
                webhooks: data || [],
                count: count || 0,
                page, limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/webhooks/stats',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res) => {
        try {
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const counts = {};
            for (const s of ['received','processing','processed','failed','ignored','duplicate']) {
                const { count } = await supabaseAdmin
                    .from('webhook_events')
                    .select('id', { count: 'exact', head: true })
                    .eq('processing_status', s);
                counts[s] = count || 0;
            }
            const { count: last24h } = await supabaseAdmin
                .from('webhook_events')
                .select('id', { count: 'exact', head: true })
                .gte('received_at', since);

            ok(res, { stats: { ...counts, last_24h: last24h || 0 } });
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/webhooks/:id',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { data, error } = await supabaseAdmin
                .from('webhook_events')
                .select('*')
                .eq('id', req.params.id)
                .maybeSingle();
            if (error || !data) {
                const e = new Error('Webhook event not found.'); e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
            }

            let order = null;
            if (data.order_id) {
                const { data: o } = await supabaseAdmin.from('orders')
                    .select('id, order_ref, status, provider, provider_order_id, total_amount, currency')
                    .eq('id', data.order_id).maybeSingle();
                order = o || null;
            }

            ok(res, {
                event: {
                    ...data,
                    headers: webhookService.maskHeaders(data.headers)
                },
                order
            });
        } catch (e) { err(res, e); }
    }
);

router.post(
    '/webhooks/:id/reprocess',
    requirePermission(PERMISSIONS.WEBHOOKS_REPLAY),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await webhookService.reprocessWebhook({
                eventId: req.params.id,
                ctx: { adminId: req.adminContext.id, adminEmail: req.adminContext.email }
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

router.post(
    '/webhooks/:id/ignore',
    requirePermission(PERMISSIONS.WEBHOOKS_REPLAY),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            const result = await webhookService.ignoreWebhook({
                eventId: req.params.id,
                reason,
                ctx: { adminId: req.adminContext.id }
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

module.exports = router;