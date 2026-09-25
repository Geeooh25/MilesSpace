// routes/admin/airtimeAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Airtime & Data API — routes only.
//
// The admin Airtime view shows a UNION of two underlying tables:
//
//   airtime_transactions        — DT One (Global Airtime)
//   bill_payment_transactions   — VTpass (service_type = 'airtime')
//
// This file is a thin pass-through. It:
//   • authenticates / authorizes the caller
//   • validates request shape
//   • calls airtimeService
//   • translates errors into a stable response contract
//
// No business logic. No DB access. No provider SDK calls.
//
// Routes:
//   GET    /api/admin/airtime/overview
//   GET    /api/admin/airtime/orders
//   GET    /api/admin/airtime/orders/:id
//   POST   /api/admin/airtime/orders/:id/sync
//   POST   /api/admin/airtime/orders/:id/retry
//   POST   /api/admin/airtime/orders/:id/refund
//   POST   /api/admin/airtime/orders/:id/review
//   GET    /api/admin/airtime/routing
//   PUT    /api/admin/airtime/routing
//   GET    /api/admin/airtime/providers
//   GET    /api/admin/airtime/providers/:provider/health
//   POST   /api/admin/airtime/providers/:provider/health-check
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { supabaseAdmin } = require('../../db/supabase');
const airtime = require('../../services/airtimeService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Request id middleware ───────────────────────────────────────
// Every response carries a stable X-Request-ID. Server logs use the
// same id so support can correlate without exposing internals.
router.use((req, res, next) => {
    req.atRequestId = req.headers['x-request-id']
        || `AT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    res.setHeader('X-Request-ID', req.atRequestId);
    next();
});

// ─── Safe error messages ─────────────────────────────────────────
// Only codes listed here produce a specific client-facing message.
// Any other code falls through to a generic message; the full error
// is logged server-side with the request id.
const SAFE_MESSAGES = {
    INVALID_ID:                 'Invalid identifier.',
    REASON_REQUIRED:            'A reason is required.',
    AO_NOT_FOUND:               'Airtime order not found.',
    ALREADY_COMPLETED:          'This order is already completed.',
    ALREADY_REFUNDED:           'This order is already refunded.',
    IN_REFUND_STATE:            'This order is in a refund state.',
    NOT_REFUNDABLE:             'This order is not eligible for a refund.',
    NO_TRANSACTION:             'This order has no wallet transaction.',
    TX_NOT_FOUND:               'The original transaction could not be found.',
    TX_NOT_REFUNDABLE:          'The original transaction is not refundable.',
    MISSING_ORDER_DATA:         'Order is missing required data.',
    UNKNOWN_PROVIDER:           'Unknown provider.',
    ORDER_STATE_CHANGED:        'The order changed before this action completed. Reload and try again.',
    INVALID_STATUS_TRANSITION:  'That status change is not allowed.',
    AUDIT_WRITE_FAILED:         'The action was aborted because the audit log could not be written.',
    LEDGER_REFUND_FAILED:       'The wallet refund could not be completed.',
    REFUND_POST_CREDIT_FAILED:  'The refund was applied, but the order could not be finalized. Marked for reconciliation.',
    INVALID_COUNTRY:            'Invalid country code.',
    INVALID_PROVIDER:           'Invalid provider.',
    ROUTING_WRITE_FAILED:       'Failed to persist routing.',
    ROUTING_READ_FAILED:        'Failed to read routing.',
    ROUTE_EXISTS:               'A route for this country/network already exists.',
    CONFIGURATION_CHANGED:      'The configuration changed before this action completed. Reload and try again.',
    UNSUPPORTED_ROUTE:          'No provider route is configured for this request.',
    PROVIDER_QUERY_FAILED:      'The provider could not be reached.',
    ATTEMPT_ALLOC_FAILED:       'Failed to allocate attempt number.',
    ATTEMPT_INSERT_FAILED:      'Failed to record attempt.',
    RETRY_IN_PROGRESS:          'A retry for this order is already in progress.',
    IDEMPOTENCY_CONFLICT:       'This idempotency key was already used with different parameters.',
    IDEMPOTENCY_CLAIM_FAILED:   'Idempotency check failed.',
    HEALTH_READ_FAILED:         'Failed to read provider health.',
    HEALTH_WRITE_FAILED:        'Failed to persist provider health.'
};

// ─── Response helpers ────────────────────────────────────────────
function sendOk(res, payload) {
    if (res.headersSent) return;
    res.json({ success: true, ...payload });
}

function sendErr(res, req, err) {
    if (res.headersSent) return;

    const status = err?.status || 500;
    const code = err?.code || 'AIRTIME_ERROR';
    const message = SAFE_MESSAGES[code] || 'Airtime request failed.';

    if (status >= 500 || !SAFE_MESSAGES[code]) {
        console.error('[ADMIN AIRTIME]', req.atRequestId, code, err?.message || err);
    }

    const body = {
        success: false,
        code,
        message,
        request_id: req.atRequestId
    };
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
    if (err?.current_status)      body.current_status = err.current_status;
    if (err?.expected_status)     body.expected_status = err.expected_status;
    if (err?.current_version)     body.current_version = err.current_version;

    res.status(status).json(body);
}

function ctxFrom(req) {
    return {
        adminId:    req.adminContext?.id    || null,
        adminEmail: req.adminContext?.email || null,
        ip:         req.ip || req.headers['x-forwarded-for'] || null,
        userAgent:  req.headers['user-agent'] || null,
        requestId:  req.atRequestId
    };
}

// ─── Idempotency ─────────────────────────────────────────────────
// Uses the airtime_idempotency_claim RPC when it exists. Falls back
// to a simple SELECT-then-INSERT if the RPC isn't deployed, so the
// routes still work in a partially-migrated environment.
async function withIdempotency({ req, bodyHash }) {
    const key = req.headers['idempotency-key'];
    if (!key || String(key).length < 8) return { fresh: true, noKey: true };

    const adminId = req.adminContext?.id || 'anon';
    const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
    const trimmedKey = String(key).slice(0, 200);

    // Try the atomic RPC first.
    let rpc;
    try {
        rpc = await supabaseAdmin.rpc('airtime_idempotency_claim', {
            p_admin_id: adminId,
            p_endpoint: endpoint,
            p_idempotency_key: trimmedKey,
            p_request_hash: bodyHash || null
        });
    } catch (e) {
        rpc = { error: e };
    }

    if (!rpc.error) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        if (row?.replay) return { fresh: false, replay: row.response };
        if (row?.claimed) {
            return {
                fresh: true,
                complete: async (response) => {
                    try {
                        await supabaseAdmin
                            .from('admin_idempotency')
                            .update({
                                response,
                                status: 'completed',
                                updated_at: new Date().toISOString()
                            })
                            .eq('admin_id', adminId)
                            .eq('endpoint', endpoint)
                            .eq('idempotency_key', trimmedKey);
                    } catch (e) {
                        console.warn('[ADMIN AIRTIME] idempotency complete failed:', e.message);
                    }
                },
                release: async () => {
                    try {
                        await supabaseAdmin
                            .from('admin_idempotency')
                            .delete()
                            .eq('admin_id', adminId)
                            .eq('endpoint', endpoint)
                            .eq('idempotency_key', trimmedKey);
                    } catch (e) {
                        console.warn('[ADMIN AIRTIME] idempotency release failed:', e.message);
                    }
                }
            };
        }
        return { fresh: true };
    }

    const msg = String(rpc.error?.message || '');
    if (msg.includes('IDEMPOTENCY_CONFLICT')) {
        const e = new Error('This idempotency key was already used with different parameters.');
        e.status = 409; e.code = 'IDEMPOTENCY_CONFLICT';
        throw e;
    }

    // RPC not deployed — degrade to best-effort SELECT-then-INSERT.
    // Not atomic, but functional. Upgrade to the RPC when the
    // migration is applied.
    try {
        const { data: existing } = await supabaseAdmin
            .from('admin_idempotency')
            .select('response, status, expires_at, request_hash')
            .eq('admin_id', adminId)
            .eq('endpoint', endpoint)
            .eq('idempotency_key', trimmedKey)
            .maybeSingle();

        if (existing) {
            if (existing.request_hash && bodyHash && existing.request_hash !== bodyHash) {
                const e = new Error('This idempotency key was already used with different parameters.');
                e.status = 409; e.code = 'IDEMPOTENCY_CONFLICT';
                throw e;
            }
            if (existing.status === 'completed' && existing.response) {
                return { fresh: false, replay: existing.response };
            }
        }
    } catch (e) {
        if (e.code === 'IDEMPOTENCY_CONFLICT') throw e;
        // Table missing — fall through, no idempotency.
    }

    return {
        fresh: true,
        complete: async (response) => {
            try {
                await supabaseAdmin.from('admin_idempotency').insert({
                    admin_id: adminId,
                    endpoint,
                    idempotency_key: trimmedKey,
                    request_hash: bodyHash || null,
                    response,
                    status: 'completed',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
                });
            } catch (e) {
                console.warn('[ADMIN AIRTIME] idempotency insert failed:', e.message);
            }
        },
        release: async () => {}
    };
}

function hashBody(body) {
    try {
        return crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
    } catch {
        return null;
    }
}

// ═════════════════════════════════════════════════════════════════
//  Overview
// ═════════════════════════════════════════════════════════════════

router.get(
    '/airtime/overview',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const overview = await airtime.getOverview({
                from: req.query.from || null,
                to:   req.query.to   || null
            });
            sendOk(res, { overview });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  Orders
// ═════════════════════════════════════════════════════════════════

router.get(
    '/airtime/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await airtime.listOrders({
                page:      parseInt(req.query.page, 10) || 1,
                limit:     parseInt(req.query.limit, 10) || 25,
                status:    req.query.status    || null,
                provider:  req.query.provider  || null,
                country:   req.query.country   || null,
                network:   req.query.network   || null,
                currency:  req.query.currency  || null,
                user_id:   req.query.user_id   || null,
                from:      req.query.from      || null,
                to:        req.query.to        || null,
                amountMin: req.query.amountMin || null,
                amountMax: req.query.amountMax || null,
                search:    req.query.search    || null
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/airtime/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await airtime.getOrder(req.params.id);
            sendOk(res, data);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  Sync  — read-only against the provider; no idempotency needed
// ═════════════════════════════════════════════════════════════════

router.post(
    '/airtime/orders/:id/sync',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await airtime.syncOrder({
                orderId: req.params.id,
                ctx: ctxFrom(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  Retry  — mutating, idempotent
// ═════════════════════════════════════════════════════════════════

router.post(
    '/airtime/orders/:id/retry',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            const idem = await withIdempotency({ req, bodyHash: hashBody(req.body) });
            if (!idem.fresh) return res.json(idem.replay);

            try {
                const result = await airtime.retryOrder({
                    orderId: req.params.id,
                    reason: String(reason).slice(0, 500),
                    ctx: ctxFrom(req)
                });
                const response = { success: true, ...result };
                await idem.complete?.(response);
                sendOk(res, result);
            } catch (inner) {
                await idem.release?.();
                throw inner;
            }
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  Refund  — mutating, idempotent
// ═════════════════════════════════════════════════════════════════

router.post(
    '/airtime/orders/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            const idem = await withIdempotency({ req, bodyHash: hashBody(req.body) });
            if (!idem.fresh) return res.json(idem.replay);

            try {
                const result = await airtime.refundOrder({
                    orderId: req.params.id,
                    reason: String(reason).slice(0, 500),
                    ctx: ctxFrom(req)
                });
                const response = { success: true, ...result };
                await idem.complete?.(response);
                sendOk(res, result);
            } catch (inner) {
                await idem.release?.();
                throw inner;
            }
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  Move to reconciliation  — mutating, idempotent
// ═════════════════════════════════════════════════════════════════

router.post(
    '/airtime/orders/:id/review',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            const idem = await withIdempotency({ req, bodyHash: hashBody(req.body) });
            if (!idem.fresh) return res.json(idem.replay);

            try {
                const result = await airtime.reviewOrder({
                    orderId: req.params.id,
                    reason: String(reason).slice(0, 500),
                    ctx: ctxFrom(req)
                });
                const response = { success: true, ...result };
                await idem.complete?.(response);
                sendOk(res, result);
            } catch (inner) {
                await idem.release?.();
                throw inner;
            }
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  Routing
// ═════════════════════════════════════════════════════════════════

router.get(
    '/airtime/routing',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const routing = await airtime.listRouting();
            sendOk(res, { routing });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.put(
    '/airtime/routing',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const {
                country, network, provider, reason,
                enabled, priority, expected_version
            } = req.body || {};

            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            const idem = await withIdempotency({ req, bodyHash: hashBody(req.body) });
            if (!idem.fresh) return res.json(idem.replay);

            try {
                const result = await airtime.setRouting({
                    countryIso3:     country,
                    networkCode:     network || null,
                    primaryProvider: provider,
                    enabled:         enabled !== undefined ? Boolean(enabled) : true,
                    priority:        Number.isFinite(Number(priority)) ? Number(priority) : 1,
                    expectedVersion: expected_version != null ? Number(expected_version) : null,
                    ctx:             ctxFrom(req),
                    reason
                });
                const response = { success: true, ...result };
                await idem.complete?.(response);
                sendOk(res, result);
            } catch (inner) {
                await idem.release?.();
                throw inner;
            }
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  Providers
// ═════════════════════════════════════════════════════════════════

router.get(
    '/airtime/providers',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const providers = await airtime.getProviderHealth();
            sendOk(res, { providers });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/airtime/providers/:provider/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const all = await airtime.getProviderHealth();
            const name = String(req.params.provider || '').toLowerCase();
            if (!all[name]) {
                const e = new Error('Unknown provider.');
                e.status = 404; e.code = 'UNKNOWN_PROVIDER';
                throw e;
            }
            sendOk(res, { provider: name, health: all[name] });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/airtime/providers/:provider/health-check',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const result = await airtime.healthCheckProvider({
                provider: String(req.params.provider || '').toLowerCase(),
                ctx: ctxFrom(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

module.exports = router;