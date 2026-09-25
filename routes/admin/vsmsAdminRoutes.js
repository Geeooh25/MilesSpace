// routes/admin/vsmsAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Virtual SMS API — routes only.
//
//   GET    /api/admin/virtual-sms/stats
//   GET    /api/admin/virtual-sms/orders
//   GET    /api/admin/virtual-sms/orders/:id
//   GET    /api/admin/virtual-sms/orders/:id/events
//   GET    /api/admin/virtual-sms/orders/:id/provider-logs
//   POST   /api/admin/virtual-sms/orders/:id/sync
//   POST   /api/admin/virtual-sms/orders/:id/cancel
//   POST   /api/admin/virtual-sms/orders/:id/release
//   POST   /api/admin/virtual-sms/orders/:id/retry
//   POST   /api/admin/virtual-sms/orders/:id/refund
//   PATCH  /api/admin/virtual-sms/orders/:id/status
//   POST   /api/admin/virtual-sms/orders/:id/reveal
//   GET    /api/admin/virtual-sms/provider/health
//   POST   /api/admin/virtual-sms/provider/health-check
//
// Thin pass-through. Sanitized errors. Idempotency-Key on every
// mutating route via the existing admin_idempotency table.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { supabaseAdmin } = require('../../db/supabase');
const vsms = require('../../services/vsmsAdminService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use((req, res, next) => {
    req.vsmsRequestId = req.headers['x-request-id']
        || `VS-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    res.setHeader('X-Request-ID', req.vsmsRequestId);
    next();
});

const SAFE_MESSAGES = {
    INVALID_ID:                     'Invalid identifier.',
    REASON_REQUIRED:                'A reason is required.',
    VSMS_NOT_FOUND:                 'Virtual SMS order not found.',
    ALREADY_REFUNDED:               'This order is already refunded.',
    NOT_REFUNDABLE:                 'This order is not eligible for a refund.',
    NO_TRANSACTION:                 'This order has no wallet transaction.',
    TX_NOT_FOUND:                   'The original transaction could not be found.',
    TX_NOT_REFUNDABLE:              'The original transaction is not refundable.',
    ORDER_STATE_CHANGED:            'The order changed before this action completed. Reload and try again.',
    INVALID_STATUS_TRANSITION:      'That status change is not allowed.',
    AUDIT_WRITE_FAILED:             'The action was aborted because the audit log could not be written.',
    LEDGER_REFUND_FAILED:           'The wallet refund could not be completed.',
    REFUND_POST_CREDIT_FAILED:      'The refund was applied, but the order could not be finalized.',
    PROVIDER_NOT_CONFIGURED:        'The Virtual SMS provider is not configured.',
    PROVIDER_CANCEL_FAILED:         'The provider could not cancel the number.',
    PROVIDER_CANCEL_NOT_CONFIRMED:  'The provider did not confirm the cancellation.',
    PROVIDER_RELEASE_FAILED:        'The provider could not release the number.',
    PROVIDER_RETRY_FAILED:          'The provider could not resend the SMS.',
    NO_ACTIVATION:                  'This order has no number to act on.',
    ORDER_INACTIVE:                 'This order is already finished.',
    NOT_COMPLETED:                  'This action requires a completed order.',
    IDEMPOTENCY_CONFLICT:           'This idempotency key was already used with different parameters.'
};

function sendOk(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }

function sendErr(res, req, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'VSMS_ERROR';
    const message = SAFE_MESSAGES[code] || 'Virtual SMS request failed.';
    if (status >= 500 || !SAFE_MESSAGES[code]) {
        console.error('[ADMIN VSMS]', req.vsmsRequestId, code, err?.message || err);
    }
    const body = { success: false, code, message, request_id: req.vsmsRequestId };
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
    if (err?.expected_status) body.expected_status = err.expected_status;
    res.status(status).json(body);
}

function ctxFrom(req) {
    return {
        adminId:    req.adminContext?.id    || null,
        adminEmail: req.adminContext?.email || null,
        ip:         req.ip || req.headers['x-forwarded-for'] || null,
        userAgent:  req.headers['user-agent'] || null,
        requestId:  req.vsmsRequestId
    };
}

async function withIdempotency({ req, bodyHash }) {
    const key = req.headers['idempotency-key'];
    if (!key || String(key).length < 8) return { fresh: true, noKey: true };

    const adminId = req.adminContext?.id || 'anon';
    const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
    const trimmedKey = String(key).slice(0, 200);

    try {
        const { data: existing } = await supabaseAdmin
            .from('admin_idempotency')
            .select('response, status, request_hash')
            .eq('admin_id', adminId)
            .eq('endpoint', endpoint)
            .eq('idempotency_key', trimmedKey)
            .maybeSingle();

        if (existing) {
            if (existing.request_hash && bodyHash && existing.request_hash !== bodyHash) {
                const e = new Error('This idempotency key was already used with different parameters.');
                e.status = 409; e.code = 'IDEMPOTENCY_CONFLICT'; throw e;
            }
            if (existing.status === 'completed' && existing.response) {
                return { fresh: false, replay: existing.response };
            }
        }
    } catch (e) {
        if (e.code === 'IDEMPOTENCY_CONFLICT') throw e;
    }

    return {
        fresh: true,
        complete: async (response) => {
            try {
                await supabaseAdmin.from('admin_idempotency').insert({
                    admin_id: adminId, endpoint,
                    idempotency_key: trimmedKey,
                    request_hash: bodyHash || null,
                    response, status: 'completed',
                    created_at: new Date().toISOString(),
                    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
                });
            } catch (e) {
                console.warn('[ADMIN VSMS] idempotency insert failed:', e.message);
            }
        },
        release: async () => {}
    };
}

function hashBody(body) {
    try { return crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex'); }
    catch { return null; }
}

// ═════════════════════════════════════════════════════════════════
//  STATS + ORDERS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/virtual-sms/stats',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const stats = await vsms.getStats({
                from: req.query.from || null,
                to: req.query.to || null
            });
            sendOk(res, { stats });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/virtual-sms/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await vsms.listOrders({
                page: parseInt(req.query.page, 10) || 1,
                limit: parseInt(req.query.limit, 10) || 25,
                status: req.query.status || null,
                country: req.query.country || null,
                service: req.query.service || null,
                user_id: req.query.user_id || null,
                sms_received: req.query.sms_received || null,
                refunded: req.query.refunded || null,
                from: req.query.from || null,
                to: req.query.to || null,
                search: req.query.search || null
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/virtual-sms/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await vsms.getOrder(req.params.id, { revealSensitive: false });
            sendOk(res, data);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/virtual-sms/orders/:id/events',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const events = await vsms.getOrderEvents(req.params.id);
            sendOk(res, { events });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/virtual-sms/orders/:id/provider-logs',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const logs = await vsms.getProviderLogs(req.params.id);
            sendOk(res, { logs });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/virtual-sms/orders/:id/reveal',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await vsms.getOrder(req.params.id, { revealSensitive: true });
            sendOk(res, {
                sms_code: data.order.sms_code,
                sms_message: data.order.sms_message,
                sms_sender: data.order.sms_sender,
                phone_number: data.order.phone_number,
                provider_response: data.order.provider_response
            });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  SYNC
// ═════════════════════════════════════════════════════════════════

router.post(
    '/virtual-sms/orders/:id/sync',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await vsms.syncOrder({ orderId: req.params.id, ctx: ctxFrom(req) });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  CANCEL
// ═════════════════════════════════════════════════════════════════

router.post(
    '/virtual-sms/orders/:id/cancel',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const idem = await withIdempotency({ req, bodyHash: hashBody(req.body) });
            if (!idem.fresh) return res.json(idem.replay);
            try {
                const result = await vsms.cancelOrder({
                    orderId: req.params.id,
                    reason: String(reason).slice(0, 500),
                    ctx: ctxFrom(req)
                });
                const response = { success: true, ...result };
                await idem.complete?.(response);
                sendOk(res, result);
            } catch (inner) { await idem.release?.(); throw inner; }
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  RELEASE
// ═════════════════════════════════════════════════════════════════

router.post(
    '/virtual-sms/orders/:id/release',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const idem = await withIdempotency({ req, bodyHash: hashBody(req.body) });
            if (!idem.fresh) return res.json(idem.replay);
            try {
                const result = await vsms.releaseNumber({
                    orderId: req.params.id,
                    reason: String(reason).slice(0, 500),
                    ctx: ctxFrom(req)
                });
                const response = { success: true, ...result };
                await idem.complete?.(response);
                sendOk(res, result);
            } catch (inner) { await idem.release?.(); throw inner; }
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  RETRY
// ═════════════════════════════════════════════════════════════════

router.post(
    '/virtual-sms/orders/:id/retry',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const idem = await withIdempotency({ req, bodyHash: hashBody(req.body) });
            if (!idem.fresh) return res.json(idem.replay);
            try {
                const result = await vsms.retryOrder({
                    orderId: req.params.id,
                    reason: String(reason).slice(0, 500),
                    ctx: ctxFrom(req)
                });
                const response = { success: true, ...result };
                await idem.complete?.(response);
                sendOk(res, result);
            } catch (inner) { await idem.release?.(); throw inner; }
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  REFUND
// ═════════════════════════════════════════════════════════════════

router.post(
    '/virtual-sms/orders/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const idem = await withIdempotency({ req, bodyHash: hashBody(req.body) });
            if (!idem.fresh) return res.json(idem.replay);
            try {
                const result = await vsms.refundOrder({
                    orderId: req.params.id,
                    reason: String(reason).slice(0, 500),
                    ctx: ctxFrom(req)
                });
                const response = { success: true, ...result };
                await idem.complete?.(response);
                sendOk(res, result);
            } catch (inner) { await idem.release?.(); throw inner; }
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  MANUAL STATUS CHANGE
// ═════════════════════════════════════════════════════════════════

router.patch(
    '/virtual-sms/orders/:id/status',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { status, reason } = req.body || {};
            if (!status || typeof status !== 'string') {
                const e = new Error('A status is required.'); e.status = 422; e.code = 'STATUS_REQUIRED'; throw e;
            }
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const result = await vsms.changeStatus({
                orderId: req.params.id,
                nextStatus: String(status).toLowerCase(),
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

router.get(
    '/virtual-sms/provider/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const health = await vsms.getProviderHealth();
            sendOk(res, { health });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/virtual-sms/provider/health-check',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const result = await vsms.healthCheckProvider({ ctx: ctxFrom(req) });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

module.exports = router;