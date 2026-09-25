// routes/admin/giftCardAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Gift Cards API — routes only.
//
//   GET  /api/admin/gift-cards/summary
//   GET  /api/admin/gift-cards/orders
//   GET  /api/admin/gift-cards/orders/:id
//   POST /api/admin/gift-cards/orders/:id/reveal-code
//   POST /api/admin/gift-cards/orders/:id/retry
//   POST /api/admin/gift-cards/orders/:id/refund
//   POST /api/admin/gift-cards/orders/:id/sync
//   GET  /api/admin/gift-cards/products
//   PUT  /api/admin/gift-cards/products/:id/enabled
//   GET  /api/admin/gift-cards/provider/health
//
// No business logic here. No direct DB writes. The service is the
// only place that touches the order or the wallet.
//
// Error responses are sanitized — internal error messages never
// reach the admin client. The full message is logged server-side
// with the request id so support can correlate.
//
// Response shape (single canonical form):
//   Success:  { success: true, data: {...} }
//   Error:    { success: false, code, message, request_id }
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const giftCards = require('../../services/giftCardService');

// ─── Identifier validation ───────────────────────────────────────
// gift_card_orders.id is BIGINT in this deployment. Products are
// also integer-keyed. If you migrate to UUID later, swap this regex
// for the UUID pattern in ONE place.
const ORDER_ID_RE = /^\d{1,19}$/;

// ─── Request ID middleware (per request) ─────────────────────────
router.use((req, res, next) => {
    req.gcRequestId = req.headers['x-request-id']
        || `GC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    res.setHeader('X-Request-ID', req.gcRequestId);
    next();
});

// ─── Response helpers ────────────────────────────────────────────

// Every successful response uses the same envelope.
function sendOk(res, payload) {
    if (res.headersSent) return;
    res.json({ success: true, data: payload });
}

// Safe messages keyed by stable code. Never send raw err.message.
const SAFE_MESSAGES = {
    INVALID_ID:                 'Invalid identifier.',
    REASON_REQUIRED:            'A reason is required.',
    NOT_FOUND:                  'Resource not found.',
    GCO_NOT_FOUND:              'Gift card order not found.',
    GCP_NOT_FOUND:              'Gift card product not found.',
    NO_DELIVERY:                'No delivery is available for this order.',
    ALREADY_COMPLETED:          'This order is already completed.',
    ALREADY_REFUNDED:           'This order is already refunded.',
    IN_REFUND_STATE:            'This order is in a refund state.',
    NOT_REFUNDABLE:             'This order is not eligible for a refund.',
    NO_TRANSACTION:             'This order has no associated wallet transaction.',
    TX_NOT_FOUND:               'The original transaction could not be found.',
    TX_NOT_REFUNDABLE:          'The original transaction is not refundable.',
    TX_NOT_DEBIT:               'The original transaction is not a wallet debit.',
    MISSING_ORDER_DATA:         'Order is missing required data.',
    MISSING_PRODUCT_ID:         'Order is missing the provider product id.',
    ORDER_STATE_CHANGED:        'The order changed before this action completed. Reload and try again.',
    INVALID_STATUS_TRANSITION:  'That status change is not allowed.',
    PRODUCT_CHANGED:            'The product changed before this action completed.',
    AUDIT_WRITE_FAILED:         'The action was aborted because the audit log could not be written.',
    LEDGER_REFUND_FAILED:       'The wallet refund could not be completed.',
    DELIVERY_WRITE_FAILED:      'The delivery could not be persisted.',
    PROVIDER_QUERY_FAILED:      'The provider could not be reached.',
    PROVIDER_STATE_UNKNOWN:     'The provider state is unknown — reconciliation is required.',
    PROVIDER_PURCHASE_FAILED:   'The provider rejected the purchase request.',
    INVALID_ENABLED:            'The enabled field must be a boolean.',
    IDEMPOTENCY_CONFLICT:       'This request key was already used with different parameters.',
    IDEMPOTENCY_IN_PROGRESS:    'A matching request is already in progress.',
    UNKNOWN_ERROR:              'An unexpected error occurred.'
};

function sendErr(res, req, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'GIFTCARD_ERROR';
    const clientMessage = SAFE_MESSAGES[code] || 'Gift card request failed.';

    // Full detail goes to the server log, correlated by request id.
    if (status >= 500 || !SAFE_MESSAGES[code]) {
        console.error('[ADMIN GIFTCARD]', req.gcRequestId, code, err?.message || err);
    }

    const body = {
        success: false,
        code,
        message: clientMessage,
        request_id: req.gcRequestId
    };
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
    if (err?.current_status) body.current_status = err.current_status;
    if (err?.expected_status) body.expected_status = err.expected_status;

    res.status(status).json(body);
}

function ctxFrom(req) {
    return {
        adminId: req.adminContext?.id || null,
        adminEmail: req.adminContext?.email || null,
        adminRole: req.adminContext?.role || null,
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.gcRequestId
    };
}

// ─── Validation helpers ──────────────────────────────────────────

function validateIdParam(req, res, next) {
    const raw = String(req.params.id || '');
    if (!ORDER_ID_RE.test(raw)) {
        const e = new Error('Invalid order identifier.');
        e.status = 400;
        e.code = 'INVALID_ID';
        return sendErr(res, req, e);
    }
    next();
}

function validateQueryDates(req, res, next) {
    const { from, to } = req.query;
    if (from) {
        const d = new Date(from);
        if (isNaN(d.getTime())) {
            const e = new Error('Invalid from date.');
            e.status = 422; e.code = 'INVALID_DATE';
            return sendErr(res, req, e);
        }
    }
    if (to) {
        const d = new Date(to);
        if (isNaN(d.getTime())) {
            const e = new Error('Invalid to date.');
            e.status = 422; e.code = 'INVALID_DATE';
            return sendErr(res, req, e);
        }
    }
    if (from && to && new Date(from) > new Date(to)) {
        const e = new Error('from must be before to.');
        e.status = 422; e.code = 'INVALID_DATE_RANGE';
        return sendErr(res, req, e);
    }
    next();
}

// ─── Idempotency ─────────────────────────────────────────────────
//
// Correctness notes:
//   • The unique index on (admin_id, endpoint, idempotency_key)
//     is the atomic guard. Two concurrent requests with the same
//     key: one wins the INSERT, the other sees a conflict.
//   • The stored response is replayed when the same key arrives
//     again with the same request hash.
//   • Same key + different request body → 409 IDEMPOTENCY_CONFLICT.
//   • We do not swallow DB errors during persist — idempotency
//     that silently fails is worse than no idempotency at all.

function hashRequest({ adminId, endpoint, body, params, query }) {
    const canonical = JSON.stringify({
        adminId,
        endpoint,
        body: body || {},
        params: params || {},
        query: query || {}
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function withIdempotency({ req, operationName }) {
    const key = req.headers['idempotency-key'];
    if (!key || String(key).length < 8) {
        // No key provided — operate without idempotency.
        return { fresh: true, enabled: false };
    }

    const adminId = req.adminContext?.id || 'anon';
    const endpoint = `${req.method} ${req.baseUrl}${req.path.replace(/\/\d+(\/|$)/, '/:id$1')}`;
    const idemKey = String(key).slice(0, 200);
    const requestHash = hashRequest({
        adminId,
        endpoint,
        body: req.body,
        params: { id: req.params.id },
        query: { operation: operationName }
    });

    const { supabaseAdmin } = require('../../db/supabase');

    // 1. Look up an existing record.
    const { data: existing, error: lookupErr } = await supabaseAdmin
        .from('admin_idempotency')
        .select('id, request_hash, status, response, expires_at')
        .eq('admin_id', adminId)
        .eq('endpoint', endpoint)
        .eq('idempotency_key', idemKey)
        .maybeSingle();

    if (lookupErr) {
        const e = new Error('Idempotency lookup failed.');
        e.status = 500; e.code = 'IDEMPOTENCY_LOOKUP_FAILED';
        e.cause = lookupErr.message;
        throw e;
    }

    if (existing && (!existing.expires_at || new Date(existing.expires_at) > new Date())) {
        // Same key was used before.
        if (existing.request_hash && existing.request_hash !== requestHash) {
            const e = new Error('Idempotency key reused with different parameters.');
            e.status = 409; e.code = 'IDEMPOTENCY_CONFLICT';
            throw e;
        }
        if (existing.status === 'completed' && existing.response) {
            return { fresh: false, replay: existing.response, enabled: true };
        }
        if (existing.status === 'processing') {
            const e = new Error('A matching request is already in progress.');
            e.status = 409; e.code = 'IDEMPOTENCY_IN_PROGRESS';
            throw e;
        }
        // status === 'failed' — fall through and allow retry.
    }

    // 2. Atomically claim the key. The unique index protects us.
    const insertRow = {
        admin_id: adminId,
        endpoint,
        idempotency_key: idemKey,
        request_hash: requestHash,
        status: 'processing',
        response: null,
        status_code: null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    const { error: insertErr } = await supabaseAdmin
        .from('admin_idempotency')
        .insert(insertRow);

    if (insertErr) {
        if (String(insertErr.code) === '23505') {
            // Lost the race. Another request claimed the key. Re-read
            // and replay if it is completed.
            const { data: re } = await supabaseAdmin
                .from('admin_idempotency')
                .select('status, response, request_hash')
                .eq('admin_id', adminId)
                .eq('endpoint', endpoint)
                .eq('idempotency_key', idemKey)
                .maybeSingle();
            if (re?.status === 'completed' && re.response) {
                return { fresh: false, replay: re.response, enabled: true };
            }
            const e = new Error('A matching request is already in progress.');
            e.status = 409; e.code = 'IDEMPOTENCY_IN_PROGRESS';
            throw e;
        }
        const e = new Error('Idempotency claim failed.');
        e.status = 500; e.code = 'IDEMPOTENCY_CLAIM_FAILED';
        e.cause = insertErr.message;
        throw e;
    }

    return {
        fresh: true,
        enabled: true,
        persist: async (response, statusCode = 200) => {
            const { error: updErr } = await supabaseAdmin
                .from('admin_idempotency')
                .update({
                    status: 'completed',
                    response,
                    status_code: statusCode
                })
                .eq('admin_id', adminId)
                .eq('endpoint', endpoint)
                .eq('idempotency_key', idemKey);
            if (updErr) {
                console.warn('[ADMIN GIFTCARD] idempotency persist failed:', updErr.message);
            }
        },
        fail: async () => {
            await supabaseAdmin
                .from('admin_idempotency')
                .update({ status: 'failed' })
                .eq('admin_id', adminId)
                .eq('endpoint', endpoint)
                .eq('idempotency_key', idemKey);
        }
    };
}

// ═════════════════════════════════════════════════════════════════
//  SUMMARY
// ═════════════════════════════════════════════════════════════════

router.get(
    '/gift-cards/summary',
    requirePermission(PERMISSIONS.SERVICES_READ),
    validateQueryDates,
    async (req, res) => {
        try {
            const summary = await giftCards.getSummary({
                from: req.query.from || null,
                to: req.query.to || null
            });
            sendOk(res, { summary });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  ORDERS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/gift-cards/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    validateQueryDates,
    async (req, res) => {
        try {
            const result = await giftCards.listOrders({
                page: parseInt(req.query.page, 10) || 1,
                limit: parseInt(req.query.limit, 10) || 25,
                status: req.query.status || null,
                brand: req.query.brand || null,
                country: req.query.country || null,
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
    '/gift-cards/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    validateIdParam,
    async (req, res) => {
        try {
            const data = await giftCards.getOrder(req.params.id);
            sendOk(res, data);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ─── Reveal code ─────────────────────────────────────────────────
router.post(
    '/gift-cards/orders/:id/reveal-code',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    validateIdParam,
    async (req, res) => {
        let idem = null;
        try {
            idem = await withIdempotency({ req, operationName: 'reveal-code' });
            if (!idem.fresh) return res.json(idem.replay);

            const data = await giftCards.revealDeliveryCode({
                orderId: req.params.id,
                ctx: ctxFrom(req)
            });
            const response = { success: true, data };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, data);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ─── Retry ───────────────────────────────────────────────────────
router.post(
    '/gift-cards/orders/:id/retry',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    validateIdParam,
    async (req, res) => {
        let idem = null;
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            idem = await withIdempotency({ req, operationName: 'retry' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await giftCards.retryOrder({
                orderId: req.params.id,
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req)
            });
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ─── Refund ──────────────────────────────────────────────────────
router.post(
    '/gift-cards/orders/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    validateIdParam,
    async (req, res) => {
        let idem = null;
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            idem = await withIdempotency({ req, operationName: 'refund' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await giftCards.refundOrder({
                orderId: req.params.id,
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req)
            });
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ─── Sync ────────────────────────────────────────────────────────
// Sync is a read/reconciliation operation. It is safe to call
// repeatedly; the service is idempotent. We do not gate it on
// Idempotency-Key because it does not create side effects.
router.post(
    '/gift-cards/orders/:id/sync',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    validateIdParam,
    async (req, res) => {
        try {
            const result = await giftCards.syncOrder({
                orderId: req.params.id,
                ctx: ctxFrom(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PRODUCTS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/gift-cards/products',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const result = await giftCards.listProducts({
                page: parseInt(req.query.page, 10) || 1,
                limit: parseInt(req.query.limit, 10) || 50,
                enabled: req.query.enabled || null,
                country: req.query.country || null,
                brand: req.query.brand || null
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.put(
    '/gift-cards/products/:id/enabled',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    validateIdParam,
    async (req, res) => {
        let idem = null;
        try {
            const { enabled, reason } = req.body || {};
            if (typeof enabled !== 'boolean') {
                const e = new Error('enabled must be a boolean.');
                e.status = 422; e.code = 'INVALID_ENABLED';
                throw e;
            }
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            idem = await withIdempotency({ req, operationName: 'product-enabled' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await giftCards.setProductEnabled({
                productId: req.params.id,
                enabled,
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req)
            });
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

router.get(
    '/gift-cards/provider/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const health = await giftCards.getProviderHealth();
            sendOk(res, { health });
        } catch (err) { sendErr(res, req, err); }
    }
);

module.exports = router;