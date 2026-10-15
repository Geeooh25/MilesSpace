// routes/admin/transactionAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Transactions — ROUTES.
//
//   • Refund route requires step-up MFA.
//   • Refund route accepts an Idempotency-Key header.
//   • request_id is generated per request and propagated into
//     every service call.
//   • Export is audited.
//   • /transactions/:id returns refund_capability so the UI is
//     driven by the server.
//   • The summary route no longer 503s when the RPC is missing —
//     the service falls back transparently.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');
const txAdmin = require('../../services/transactionAdminService');
const refundSvc = require('../../services/refundService');
const { supabaseAdmin } = require('../../db/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Response helpers ────────────────────────────────────────────

function sendOk(res, payload) {
    if (!res.headersSent) res.json({ success: true, ...payload });
}

function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'TX_ADMIN_ERROR';
    const message = err?.message || 'Transaction request failed';
    const safe = { success: false, code, error: message };
    if (err?.allowed_transitions) safe.allowed_transitions = err.allowed_transitions;
    if (err?.current_status) safe.current_status = err.current_status;
    if (err?.transaction_type) safe.transaction_type = err.transaction_type;
    if (err?.ledger_transaction_id) safe.ledger_transaction_id = err.ledger_transaction_id;
    if (status >= 500) console.error('[ADMIN TX]', code, message);
    res.status(status).json(safe);
}

function adminCtx(req) {
    return {
        adminId: req.adminContext?.id || null,
        adminEmail: req.adminContext?.email || null,
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.requestId || null
    };
}

// ─── Request id middleware (scoped) ─────────────────────────────

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}

router.use('/transactions', attachRequestId);
router.use('/refunds', attachRequestId);

// ═════════════════════════════════════════════════════════════════
//  LITERAL ROUTES (declared before /:id)
// ═════════════════════════════════════════════════════════════════

router.get(
    '/transactions/recent',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
            const data = await txAdmin.getRecentTransactions({ limit });
            res.json({ success: true, transactions: data });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/transactions/summary',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const summary = await txAdmin.getSummary({
                from: req.query.from || null,
                to: req.query.to || null,
                currency: req.query.currency || null,
                type: req.query.type || null,
                provider: req.query.provider || null
            });
            sendOk(res, { summary });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/transactions/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    async (req, res) => {
        try {
            const csv = await txAdmin.exportTransactions({
                from: req.query.from || null,
                to: req.query.to || null,
                type: req.query.type || null,
                status: req.query.status || null,
                currency: req.query.currency || null,
                provider: req.query.provider || null
            });

            // Fire-and-forget audit (best effort).
            supabaseAdmin.from('admin_audit_logs').insert({
                admin_id: req.adminContext?.id || null,
                action: 'transaction.export',
                target_type: 'transactions_export',
                target_id: null,
                reason: `Exported transactions with filters: ${JSON.stringify(req.query)}`.slice(0, 500),
                ip_address: req.ip || null,
                user_agent: req.headers['user-agent'] || null,
                request_id: req.requestId || null
            }).then(() => {}).catch(() => {});

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=transactions_${Date.now()}.csv`);
            res.send(csv);
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  LIST
// ═════════════════════════════════════════════════════════════════

router.get(
    '/transactions',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const result = await txAdmin.getTransactions({
                page: parseInt(req.query.page, 10) || 1,
                limit: parseInt(req.query.limit, 10) || 25,
                search: req.query.search || null,
                type: req.query.type || null,
                status: req.query.status || null,
                currency: req.query.currency || null,
                provider: req.query.provider || null,
                user_id: req.query.user_id || null,
                from: req.query.from || null,
                to: req.query.to || null,
                sort: req.query.sort || 'created_at',
                order: req.query.order || 'desc'
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PARAM ROUTES — every one validates :id is a UUID
// ═════════════════════════════════════════════════════════════════

router.get(
    '/transactions/:id',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await txAdmin.getTransaction(req.params.id);
            sendOk(res, data);
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Status change ──────────────────────────────────────────────
router.put(
    '/transactions/:id/status',
    requirePermission(PERMISSIONS.TRANSACTIONS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { status, reason } = req.body || {};
            if (!status || typeof status !== 'string') {
                throw Object.assign(new Error('A status is required.'), { status: 422, code: 'STATUS_REQUIRED' });
            }
            if (!reason || String(reason).trim().length < 4) {
                throw Object.assign(new Error('A reason is required (min 4 characters).'), { status: 422, code: 'REASON_REQUIRED' });
            }
            const result = await txAdmin.changeStatus({
                transactionId: req.params.id,
                nextStatus: String(status).toLowerCase(),
                reason: String(reason).slice(0, 500),
                ctx: adminCtx(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Refund (step-up + idempotency) ─────────────────────────────
router.post(
    '/transactions/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { amount, reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                throw Object.assign(new Error('A refund reason is required (min 4 characters).'), { status: 422, code: 'REASON_REQUIRED' });
            }
            const idempotencyKey = req.headers['idempotency-key'] || null;
            const result = await txAdmin.refundTransaction({
                transactionId: req.params.id,
                amount: amount != null ? Number(amount) : undefined,
                reason: String(reason).slice(0, 500),
                ctx: adminCtx(req),
                idempotencyKey
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Note ───────────────────────────────────────────────────────
router.post(
    '/transactions/:id/note',
    requirePermission(PERMISSIONS.TRANSACTIONS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { note } = req.body || {};
            if (!note || String(note).trim().length < 2) {
                throw Object.assign(new Error('Note text is required.'), { status: 422, code: 'NOTE_REQUIRED' });
            }
            const result = await txAdmin.addNote({
                transactionId: req.params.id,
                note: String(note).slice(0, 1000),
                ctx: adminCtx(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  REFUNDS — listing for /admin/refunds
// ═════════════════════════════════════════════════════════════════

router.get(
    '/refunds',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const result = await refundSvc.listRefunds({
                status: req.query.status || 'all',
                limit: req.query.limit || 50,
                page: req.query.page || 1
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/refunds/:id',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const refund = await refundSvc.getRefund(req.params.id);
            sendOk(res, { refund });
        } catch (err) { sendErr(res, err); }
    }
);

module.exports = router;