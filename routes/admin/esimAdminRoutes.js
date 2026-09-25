// routes/admin/esimAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin eSIM API — routes only.
//
//   GET    /api/admin/esim/stats
//   GET    /api/admin/esim/orders
//   GET    /api/admin/esim/orders/:id
//   POST   /api/admin/esim/orders/:id/sync
//   POST   /api/admin/esim/orders/:id/refund
//   POST   /api/admin/esim/orders/:id/review
//   POST   /api/admin/esim/orders/:id/reveal
//   GET    /api/admin/esim/provider/health
//   POST   /api/admin/esim/provider/health-check
//
// No business logic here. Sanitized errors. Idempotency-Key
// supported on every mutating route via admin_idempotency.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { supabaseAdmin } = require('../../db/supabase');
const esim = require('../../services/esimAdminService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use((req, res, next) => {
    req.esimRequestId = req.headers['x-request-id']
        || `ES-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    res.setHeader('X-Request-ID', req.esimRequestId);
    next();
});

const SAFE_MESSAGES = {
    INVALID_ID:                 'Invalid identifier.',
    REASON_REQUIRED:            'A reason is required.',
    ESIM_NOT_FOUND:             'eSIM order not found.',
    ALREADY_REFUNDED:           'This order is already refunded.',
    NOT_REFUNDABLE:             'This order is not eligible for a refund.',
    NOT_COMPLETED:              'This action requires a completed order.',
    NO_TRANSACTION:             'This order has no wallet transaction.',
    TX_NOT_FOUND:               'The original transaction could not be found.',
    TX_NOT_REFUNDABLE:          'The original transaction is not refundable.',
    ORDER_STATE_CHANGED:        'The order changed before this action completed. Reload and try again.',
    INVALID_STATUS_TRANSITION:  'That status change is not allowed.',
    AUDIT_WRITE_FAILED:         'The action was aborted because the audit log could not be written.',
    LEDGER_REFUND_FAILED:       'The wallet refund could not be completed.',
    REFUND_POST_CREDIT_FAILED:  'The refund was applied, but the order could not be finalized.',
    IDEMPOTENCY_CONFLICT:       'This idempotency key was already used with different parameters.'
};

function sendOk(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }

function sendErr(res, req, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'ESIM_ERROR';
    const message = SAFE_MESSAGES[code] || 'eSIM request failed.';
    if (status >= 500 || !SAFE_MESSAGES[code]) {
        console.error('[ADMIN ESIM]', req.esimRequestId, code, err?.message || err);
    }
    const body = { success: false, code, message, request_id: req.esimRequestId };
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
        requestId:  req.esimRequestId
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
                console.warn('[ADMIN ESIM] idempotency insert failed:', e.message);
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
    '/esim/stats',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const stats = await esim.getStats({
                from: req.query.from || null,
                to: req.query.to || null
            });
            sendOk(res, { stats });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/esim/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await esim.listOrders({
                page: parseInt(req.query.page, 10) || 1,
                limit: parseInt(req.query.limit, 10) || 25,
                status: req.query.status || null,
                delivery_status: req.query.delivery_status || null,
                country: req.query.country || null,
                user_id: req.query.user_id || null,
                from: req.query.from || null,
                to: req.query.to || null,
                search: req.query.search || null
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/esim/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await esim.getOrder(req.params.id, { revealSensitive: false });
            sendOk(res, data);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/esim/orders/:id/reveal',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await esim.revealActivation({
                orderId: req.params.id,
                ctx: ctxFrom(req)
            });
            sendOk(res, data);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  SYNC  (read-only against provider; no idempotency needed)
// ═════════════════════════════════════════════════════════════════

router.post(
    '/esim/orders/:id/sync',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await esim.syncOrder({ orderId: req.params.id, ctx: ctxFrom(req) });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  REFUND  (mutating; idempotent)
// ═════════════════════════════════════════════════════════════════

router.post(
    '/esim/orders/:id/refund',
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
                const result = await esim.refundOrder({
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
//  MOVE TO MANUAL REVIEW
// ═════════════════════════════════════════════════════════════════

router.post(
    '/esim/orders/:id/review',
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
                const result = await esim.reviewOrder({
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
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

router.get(
    '/esim/provider/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const health = await esim.getProviderHealth();
            sendOk(res, { health });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/esim/provider/health-check',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const result = await esim.healthCheckProvider({ ctx: ctxFrom(req) });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

module.exports = router;