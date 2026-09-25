// routes/admin/reportsRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Reports API — read-only operational + financial reporting.
//
//   GET /api/admin/reports/overview
//   GET /api/admin/reports/transactions
//   GET /api/admin/reports/orders
//   GET /api/admin/reports/customers
//   GET /api/admin/reports/products
//   GET /api/admin/reports/providers
//   GET /api/admin/reports/webhooks
//   GET /api/admin/reports/failures
//   GET /api/admin/reports/reconciliation
//   GET /api/admin/reports/export
//
// Every route requires admin. No route mutates money. Nothing here
// invents data — missing tables produce { available: false }.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const { requirePermission, PERMISSIONS, recordAdminAction } = require('../../middleware/adminAuth');
const reports = require('../../services/reportsService');

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function err(res, e) {
    if (res.headersSent) return;
    const status = e?.status || 500;
    if (status >= 500) console.error('[ADMIN REPORTS]', e?.message || e);
    res.status(status).json({
        success: false,
        code: e?.code || 'REPORTS_ERROR',
        error: e?.message || 'Reports request failed.'
    });
}

router.get(
    '/overview',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await reports.getOverview(req.query);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/transactions',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await reports.getTransactions(req.query);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/orders',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await reports.getOrders(req.query);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/customers',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await reports.getCustomers(req.query);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/products',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await reports.getProducts(req.query);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/providers',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await reports.getProviders(req.query);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/webhooks',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await reports.getWebhooks(req.query);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/failures',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await reports.getFailures(req.query);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/reconciliation',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await reports.getReconciliation(req.query);
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    async (req, res) => {
        try {
            const kind = String(req.query.type || 'overview').toLowerCase();
            const csv = await reports.exportReport({ kind, query: req.query });

            // Audit the export — reports contain PII and financial rows.
            try {
                await recordAdminAction({
                    adminId: req.adminContext.id,
                    action: 'reports.export',
                    targetType: 'report',
                    targetId: kind,
                    after: { format: 'csv', from: req.query.from || null, to: req.query.to || null, currency: req.query.currency || null },
                    req
                });
            } catch (_) {}

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=report_${kind}_${Date.now()}.csv`);
            res.send(csv);
        } catch (e) { err(res, e); }
    }
);

module.exports = router;