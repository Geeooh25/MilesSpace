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
const { requirePermission, PERMISSIONS, can } = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');
const { supabaseAdmin } = require('../../db/supabase');
const webhookService = require('../../services/webhookService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// ─── List (Merges all 3 tables) ─────────────────────────────────

router.get(
    '/webhooks',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res) => {
        try {
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
            const offset = (page - 1) * limit;

            // Fetch from all 3 tables
            const [generalRes, koraRes, npRes] = await Promise.all([
                supabaseAdmin.from('webhook_events').select('id, provider, event_type, order_id, processing_status, processing_error, received_at, signature_valid', { count: 'exact' }),
                supabaseAdmin.from('kora_webhook_events').select('id, provider, event_type, provider_reference, processing_status, processing_error, received_at, signature_valid', { count: 'exact' }),
                supabaseAdmin.from('provider_webhook_events').select('id, provider, event_type, payment_id, processing_status, processing_error, received_at, signature_valid', { count: 'exact' })
            ]);

            let allEvents = [];
            if (generalRes.data) allEvents.push(...generalRes.data.map(e => ({ ...e, provider: e.provider || 'general' })));
            if (koraRes.data) allEvents.push(...koraRes.data.map(e => ({ ...e, provider: 'korapay', order_id: e.provider_reference })));
            if (npRes.data) allEvents.push(...npRes.data.map(e => ({ ...e, provider: 'nowpayments', order_id: e.payment_id })));

            // Filter
            let filtered = allEvents;
            if (req.query.provider && req.query.provider !== 'all') filtered = filtered.filter(e => e.provider === req.query.provider);
            if (req.query.status && req.query.status !== 'all') filtered = filtered.filter(e => e.processing_status === req.query.status);
            if (req.query.order_id && UUID_RE.test(req.query.order_id)) filtered = filtered.filter(e => String(e.order_id) === req.query.order_id);

            // Sort & Paginate
            filtered.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
            const total = filtered.length;
            const paginated = filtered.slice(offset, offset + limit);

            ok(res, {
                webhooks: paginated,
                count: total,
                page, limit,
                totalPages: Math.ceil(total / limit)
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
            const counts = { received: 0, processing: 0, processed: 0, failed: 0, ignored: 0 };

            const tables = ['webhook_events', 'kora_webhook_events', 'provider_webhook_events'];
            let last24h = 0;

            for (const t of tables) {
                // Status counts
                for (const s of Object.keys(counts)) {
                    const { count } = await supabaseAdmin.from(t).select('id', { count: 'exact', head: true }).eq('processing_status', s);
                    if (count) counts[s] += count;
                }
                // Last 24h
                const { count: dayCount } = await supabaseAdmin.from(t).select('id', { count: 'exact', head: true }).gte('received_at', since);
                if (dayCount) last24h += dayCount;
            }

            ok(res, { stats: { ...counts, last_24h: last24h, available: true } });
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
            let event = null;
            let provider = null;
            const tables = ['webhook_events', 'kora_webhook_events', 'provider_webhook_events'];
            
            for (const t of tables) {
                const { data } = await supabaseAdmin.from(t).select('*').eq('id', req.params.id).maybeSingle();
                if (data) {
                    event = data;
                    provider = data.provider || (t === 'kora_webhook_events' ? 'korapay' : 'nowpayments');
                    break;
                }
            }

            if (!event) {
                const e = new Error('Webhook event not found.'); e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
            }

            // ─── CRITICAL FIX: Check actual admin permission ───
            const canReplay = can(req.adminContext, PERMISSIONS.WEBHOOKS_REPLAY);
            
            // Normalize the output
            const cleanEvent = {
                id: event.id,
                provider: provider,
                event_id: event.event_id || event.provider_event_ref || event.event_hash,
                event_type: event.event_type,
                order_id: event.order_id || event.provider_reference || event.payment_id,
                signature_valid: event.signature_valid,
                processing_status: event.processing_status,
                processing_error: event.processing_error,
                received_at: event.received_at,
                processed_at: event.processed_at,
                headers: webhookService.maskHeaders(event.headers || {}),
                payload: canReplay ? event.payload : null
            };

            let order = null;
            if (cleanEvent.order_id && UUID_RE.test(cleanEvent.order_id)) {
                const { data: o } = await supabaseAdmin
                    .from('orders')
                    .select('id, order_ref, status, provider, provider_order_id, total_amount, currency')
                    .eq('id', cleanEvent.order_id).maybeSingle();
                order = o || null;
            }

            ok(res, { event: cleanEvent, order });
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
                ctx: { adminId: req.adminContext.id, adminEmail: req.adminContext.email, requestId: req.requestId }
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
                ctx: { adminId: req.adminContext.id, requestId: req.requestId }
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