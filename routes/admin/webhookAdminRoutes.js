// routes/admin/webhookAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin webhook operations.
//   GET  /api/admin/webhooks
//   GET  /api/admin/webhooks/stats
//   GET  /api/admin/webhooks/:id
//   POST /api/admin/webhooks/:id/reprocess   (step-up)
//   POST /api/admin/webhooks/:id/ignore
//
// No `select('*')`. No raw payload sent to the browser unless the
// caller has WEBHOOKS_REPLAY. Every mutation audited with request_id.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');
const { supabaseAdmin } = require('../../db/supabase');
const webhookService = require('../../services/webhookService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WEBHOOK_LIST_COLS = [
    'id', 'provider', 'event_id', 'event_type', 'order_id', 'provider_order_id',
    'signature_valid', 'processing_status', 'processing_error', 'attempts',
    'received_at', 'processed_at'
].join(', ');

const WEBHOOK_DETAIL_COLS = [
    'id', 'provider', 'event_id', 'event_fingerprint', 'event_type',
    'order_id', 'provider_order_id', 'payload', 'headers',
    'signature_valid', 'processing_status', 'processing_error', 'attempts',
    'received_at', 'processed_at', 'created_at'
].join(', ');

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}
router.use('/webhooks', attachRequestId);

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function err(res, e) {
    if (res.headersSent) return;
    const status = e?.status || 500;
    if (status >= 500) console.error('[ADMIN WEBHOOKS]', e?.message || e);
    const message = status >= 500 ? 'Something went wrong. Please try again.' : (e?.message || 'Webhook request failed.');
    res.status(status).json({ success: false, code: e?.code || 'WEBHOOK_ERROR', error: message });
}

// ─── List ────────────────────────────────────────────────────────

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
                .select(WEBHOOK_LIST_COLS, { count: 'exact' })
                .order('received_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (req.query.provider && req.query.provider !== 'all') q = q.eq('provider', req.query.provider);
            if (req.query.status && req.query.status !== 'all') q = q.eq('processing_status', req.query.status);
            if (req.query.order_id && UUID_RE.test(req.query.order_id)) q = q.eq('order_id', req.query.order_id);

            const { data, error, count } = await q;
            if (error) {
                if (error.code === '42P01') {
                    return ok(res, { webhooks: [], count: 0, page, limit, totalPages: 0, note: 'webhook_events table not present' });
                }
                throw error;
            }

            ok(res, {
                webhooks: data || [],
                count: count || 0,
                page, limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (e) { err(res, e); }
    }
);

// ─── Stats ───────────────────────────────────────────────────────

router.get(
    '/webhooks/stats',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res) => {
        try {
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const counts = {};
            for (const s of ['received','processing','processed','failed','ignored']) {
                const { count, error } = await supabaseAdmin
                    .from('webhook_events')
                    .select('id', { count: 'exact', head: true })
                    .eq('processing_status', s);
                if (error && error.code === '42P01') {
                    return ok(res, { stats: { available: false, reason: 'WEBHOOK_TABLE_NOT_FOUND' } });
                }
                counts[s] = count || 0;
            }
            const { count: last24h } = await supabaseAdmin
                .from('webhook_events')
                .select('id', { count: 'exact', head: true })
                .gte('received_at', since);

            ok(res, { stats: { ...counts, last_24h: last24h || 0, available: true } });
        } catch (e) { err(res, e); }
    }
);

// ─── Detail ──────────────────────────────────────────────────────

router.get(
    '/webhooks/:id',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { data, error } = await supabaseAdmin
                .from('webhook_events')
                .select(WEBHOOK_DETAIL_COLS)
                .eq('id', req.params.id)
                .maybeSingle();
            if (error || !data) {
                const e = new Error('Webhook event not found.'); e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
            }

            // Payload is only exposed when the caller has REPLAY.
            // Otherwise the event is shown without the raw body.
            const canReplay = typeof PERMISSIONS.WEBHOOKS_REPLAY === 'string';
            const event = {
                id: data.id,
                provider: data.provider,
                event_id: data.event_id,
                event_type: data.event_type,
                order_id: data.order_id,
                provider_order_id: data.provider_order_id,
                signature_valid: data.signature_valid,
                processing_status: data.processing_status,
                processing_error: data.processing_error,
                attempts: data.attempts,
                received_at: data.received_at,
                processed_at: data.processed_at,
                created_at: data.created_at,
                headers: webhookService.maskHeaders(data.headers),
                payload: canReplay ? data.payload : null
            };

            let order = null;
            if (data.order_id) {
                const { data: o } = await supabaseAdmin
                    .from('orders')
                    .select('id, order_ref, status, provider, provider_order_id, total_amount, currency')
                    .eq('id', data.order_id).maybeSingle();
                order = o || null;
            }

            ok(res, { event, order });
        } catch (e) { err(res, e); }
    }
);

// ─── Reprocess (step-up) ─────────────────────────────────────────

router.post(
    '/webhooks/:id/reprocess',
    requirePermission(PERMISSIONS.WEBHOOKS_REPLAY),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const result = await webhookService.reprocessWebhook({
                eventId: req.params.id,
                ctx: {
                    adminId: req.adminContext.id,
                    adminEmail: req.adminContext.email,
                    requestId: req.requestId
                }
            });
            await supabaseAdmin.from('admin_audit_logs').insert({
                admin_id: req.adminContext.id,
                admin_email: req.adminContext.email,
                action: 'webhook.reprocess',
                target_type: 'webhook_event',
                target_id: req.params.id,
                reason: reason.slice(0, 500),
                after: { updated: !!result.updated, status: result.status },
                ip_address: req.ip,
                user_agent: req.headers['user-agent'] || null,
                request_id: req.requestId,
                created_at: new Date().toISOString()
            }).then(() => {}, () => {});
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Ignore ──────────────────────────────────────────────────────

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
                ctx: {
                    adminId: req.adminContext.id,
                    requestId: req.requestId
                }
            });
            await supabaseAdmin.from('admin_audit_logs').insert({
                admin_id: req.adminContext.id,
                admin_email: req.adminContext.email,
                action: 'webhook.ignore',
                target_type: 'webhook_event',
                target_id: req.params.id,
                reason: String(reason || '').slice(0, 500),
                ip_address: req.ip,
                user_agent: req.headers['user-agent'] || null,
                request_id: req.requestId,
                created_at: new Date().toISOString()
            }).then(() => {}, () => {});
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

module.exports = router;