// routes/admin/billsAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Bills & Utilities API — routes only.
//
//   GET    /api/admin/bills/stats
//   GET    /api/admin/bills/orders
//   GET    /api/admin/bills/orders/:id
//   POST   /api/admin/bills/orders/:id/sync
//   POST   /api/admin/bills/orders/:id/retry
//   POST   /api/admin/bills/orders/:id/refund
//   POST   /api/admin/bills/orders/:id/review
//
//   GET    /api/admin/bills/electricity/providers
//   GET    /api/admin/bills/cable/providers
//   GET    /api/admin/bills/cable/packages
//
//   GET    /api/admin/bills/providers/health
//   POST   /api/admin/bills/providers/health-check
//
// Thin pass-through. Sanitized errors. Idempotency-Key supported on
// all mutating routes via the existing admin_idempotency table.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { supabaseAdmin } = require('../../db/supabase');
const bills = require('../../services/billsAdminService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use((req, res, next) => {
    req.billRequestId = req.headers['x-request-id']
        || `BI-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    res.setHeader('X-Request-ID', req.billRequestId);
    next();
});

const SAFE_MESSAGES = {
    INVALID_ID:                 'Invalid identifier.',
    REASON_REQUIRED:            'A reason is required.',
    BILL_NOT_FOUND:             'Bill transaction not found.',
    ALREADY_COMPLETED:          'This order is already completed.',
    ALREADY_REFUNDED:           'This order is already refunded.',
    NOT_REFUNDABLE:             'This order is not eligible for a refund.',
    NO_TRANSACTION:             'This order has no wallet transaction.',
    TX_NOT_FOUND:               'The original transaction could not be found.',
    TX_NOT_REFUNDABLE:          'The original transaction is not refundable.',
    ORDER_STATE_CHANGED:        'The order changed before this action completed. Reload and try again.',
    INVALID_STATUS_TRANSITION:  'That status change is not allowed.',
    AUDIT_WRITE_FAILED:         'The action was aborted because the audit log could not be written.',
    LEDGER_REFUND_FAILED:       'The wallet refund could not be completed.',
    REFUND_POST_CREDIT_FAILED:  'The refund was applied, but the order could not be finalized.',
    PROVIDER_PACKAGES_FAILED:   'The provider could not return packages.',
    UNSUPPORTED_SERVICE:        'This service type is not supported by the admin module.',
    IDEMPOTENCY_CONFLICT:       'This idempotency key was already used with different parameters.'
};

function sendOk(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }

function sendErr(res, req, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'BILLS_ERROR';
    const message = SAFE_MESSAGES[code] || 'Bill request failed.';
    if (status >= 500 || !SAFE_MESSAGES[code]) {
        console.error('[ADMIN BILLS]', req.billRequestId, code, err?.message || err);
    }
    const body = { success: false, code, message, request_id: req.billRequestId };
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
        requestId:  req.billRequestId
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
        // table missing — degrade
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
                console.warn('[ADMIN BILLS] idempotency insert failed:', e.message);
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
    '/bills/stats',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const stats = await bills.getStats({
                from: req.query.from || null,
                to: req.query.to || null
            });
            sendOk(res, { stats });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/bills/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await bills.listOrders({
                page: parseInt(req.query.page, 10) || 1,
                limit: parseInt(req.query.limit, 10) || 25,
                category: req.query.category || null,
                status: req.query.status || null,
                provider: req.query.provider || null,
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
    '/bills/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await bills.getOrder(req.params.id);
            sendOk(res, data);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/bills/orders/:id/sync',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await bills.syncOrder({ orderId: req.params.id, ctx: ctxFrom(req) });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/bills/orders/:id/retry',
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
                const result = await bills.retryOrder({
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

router.post(
    '/bills/orders/:id/refund',
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
                const result = await bills.refundOrder({
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

router.post(
    '/bills/orders/:id/review',
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
                const result = await bills.reviewOrder({
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
//  CATALOGS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/bills/electricity/providers',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const providers = await bills.getElectricityProviders();
            sendOk(res, { providers });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/bills/cable/providers',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const providers = await bills.getCableProviders();
            sendOk(res, { providers });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/bills/cable/packages',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const packages = await bills.getCablePackages(req.query.provider || null);
            sendOk(res, { packages });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

router.get(
    '/bills/providers/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const health = await bills.getProviderHealth();
            sendOk(res, { health });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/bills/providers/health-check',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const result = await bills.healthCheckProvider({ ctx: ctxFrom(req) });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

module.exports = router;