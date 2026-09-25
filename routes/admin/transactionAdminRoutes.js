// routes/admin/transactionAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Transactions module — ROUTES ONLY.
//
// This file does four things and nothing else:
//   1. Authenticate / authorize the caller.
//   2. Validate the request shape (UUIDs, statuses, reason).
//   3. Call transactionAdminService.
//   4. Translate service errors into HTTP responses.
//
// There is NO business logic here. No pricing math. No DB writes.
// Every financial mutation goes through the service, which delegates
// to the existing LedgerService. This route file never touches the
// transactions table directly.
//
// Routes (literal paths are declared before /:id):
//   GET  /api/admin/transactions
//   GET  /api/admin/transactions/recent
//   GET  /api/admin/transactions/summary
//   GET  /api/admin/transactions/export
//   GET  /api/admin/transactions/:id
//   GET  /api/admin/transactions/:id/ledger
//   GET  /api/admin/transactions/:id/audit
//   PUT  /api/admin/transactions/:id/status
//   POST /api/admin/transactions/:id/refund
//   POST /api/admin/transactions/:id/note
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const {
    requirePermission,
    PERMISSIONS
} = require('../../middleware/adminAuth');
const txAdmin = require('../../services/transactionAdminService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Response helpers ────────────────────────────────────────────

function sendOk(res, payload) {
    if (res.headersSent) return;
    res.json({ success: true, ...payload });
}
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'TX_ADMIN_ERROR';
    const message = err?.message || 'Transaction request failed';

    const safe = { success: false, code, error: message };
    if (err?.allowed_transitions) safe.allowed_transitions = err.allowed_transitions;
    if (err?.current_status) safe.current_status = err.current_status;
    if (status >= 500) console.error('[ADMIN TX]', code, message);

    res.status(status).json(safe);
}

function adminCtx(req) {
    return {
        adminId: req.adminContext?.id || null,
        adminEmail: req.adminContext?.email || null,
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        userAgent: req.headers['user-agent'] || null
    };
}

// ═════════════════════════════════════════════════════════════════
//  LITERAL ROUTES — declared before /:id so Express never confuses
//  /recent, /summary, /export with a UUID.
// ═════════════════════════════════════════════════════════════════

router.get(
    '/transactions/recent',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
            const data = await txAdmin.getRecentTransactions({ limit });
            // Dashboard frontend expects `transactions` at the top level.
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
                to:   req.query.to   || null,
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
                to:   req.query.to   || null,
                type: req.query.type || null,
                status: req.query.status || null,
                currency: req.query.currency || null,
                provider: req.query.provider || null
            });
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=transactions_${Date.now()}.csv`);
            res.send(csv);
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/transactions
// ═════════════════════════════════════════════════════════════════

router.get(
    '/transactions',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const result = await txAdmin.getTransactions({
                page:  parseInt(req.query.page, 10) || 1,
                limit: parseInt(req.query.limit, 10) || 25,
                search:   req.query.search   || null,
                type:     req.query.type     || null,
                status:   req.query.status   || null,
                currency: req.query.currency || null,
                provider: req.query.provider || null,
                user_id:  req.query.user_id  || null,
                from:     req.query.from     || null,
                to:       req.query.to       || null,
                sort:     req.query.sort     || 'created_at',
                order:    req.query.order    || 'desc'
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PARAM ROUTES — every one validates the :id is a UUID.
//  If it isn't, next() falls through to whatever router is mounted
//  after this one. That prevents a literal path from ever reaching
//  the DB as a garbage ID.
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

router.get(
    '/transactions/:id/ledger',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const entries = await txAdmin.getLedger(req.params.id);
            sendOk(res, { entries });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/transactions/:id/audit',
    requirePermission(PERMISSIONS.AUDIT_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const audit = await txAdmin.getAudit(req.params.id);
            sendOk(res, { audit });
        } catch (err) { sendErr(res, err); }
    }
);

// ─── PUT /transactions/:id/status ───────────────────────────────
// The service decides whether the transition needs a financial
// operation (e.g. pending → completed on a deposit) or is purely
// administrative (e.g. manual_review → failed). The route only
// validates the shape.
router.put(
    '/transactions/:id/status',
    requirePermission(PERMISSIONS.TRANSACTIONS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { status, reason } = req.body || {};
            if (!status || typeof status !== 'string') {
                const e = new Error('A status is required.');
                e.status = 422; e.code = 'STATUS_REQUIRED';
                throw e;
            }
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required (min 4 characters).');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
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

// ─── POST /transactions/:id/refund ──────────────────────────────
router.post(
    '/transactions/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A refund reason is required (min 4 characters).');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }
            const result = await txAdmin.refundTransaction({
                transactionId: req.params.id,
                reason: String(reason).slice(0, 500),
                ctx: adminCtx(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

// ─── POST /transactions/:id/note ────────────────────────────────
router.post(
    '/transactions/:id/note',
    requirePermission(PERMISSIONS.TRANSACTIONS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { note } = req.body || {};
            if (!note || String(note).trim().length < 2) {
                const e = new Error('Note text is required.');
                e.status = 422; e.code = 'NOTE_REQUIRED';
                throw e;
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

module.exports = router;