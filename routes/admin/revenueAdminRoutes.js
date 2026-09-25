// routes/admin/revenueAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Revenue analytics API. Routes only.
//
//   GET /api/admin/revenue/summary
//   GET /api/admin/revenue/timeseries
//   GET /api/admin/revenue/products
//   GET /api/admin/revenue/providers
//   GET /api/admin/revenue/refunds
//   GET /api/admin/revenue/customers
//   GET /api/admin/revenue/funding
//   GET /api/admin/revenue/daily
//   GET /api/admin/revenue/export
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const revenue = require('../../services/revenueService');

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function err(res, e) {
    if (res.headersSent) return;
    const status = e?.status || 500;
    if (status >= 500) console.error('[ADMIN REVENUE]', e?.message || e);
    res.status(status).json({
        success: false,
        code: e?.code || 'REVENUE_ERROR',
        error: e?.message || 'Revenue request failed.'
    });
}

function scopeFrom(req) {
    return {
        from: req.query.from || null,
        to: req.query.to || null,
        currency: req.query.currency && req.query.currency !== 'all'
            ? String(req.query.currency).toUpperCase()
            : null
    };
}

// ─── Summary ─────────────────────────────────────────────────────

router.get(
    '/revenue/summary',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const summary = await revenue.getSummary(scopeFrom(req));
            ok(res, { summary });
        } catch (e) { err(res, e); }
    }
);

// ─── Timeseries ──────────────────────────────────────────────────

router.get(
    '/revenue/timeseries',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getTimeseries({
                ...scopeFrom(req),
                granularity: req.query.granularity || 'day'
            });
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

// ─── By product ──────────────────────────────────────────────────

router.get(
    '/revenue/products',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getByProduct(scopeFrom(req));
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

// ─── By provider ─────────────────────────────────────────────────

router.get(
    '/revenue/providers',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getByProvider(scopeFrom(req));
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

// ─── Refunds ─────────────────────────────────────────────────────

router.get(
    '/revenue/refunds',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
            const data = await revenue.getRefunds({ ...scopeFrom(req), limit });
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

// ─── Top customers ───────────────────────────────────────────────

router.get(
    '/revenue/customers',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
            const data = await revenue.getTopCustomers({ ...scopeFrom(req), limit });
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

// ─── Funding (deposits ≠ revenue) ────────────────────────────────

router.get(
    '/revenue/funding',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getFunding(scopeFrom(req));
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

// ─── Daily table ─────────────────────────────────────────────────

router.get(
    '/revenue/daily',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getDailyTable(scopeFrom(req));
            ok(res, data);
        } catch (e) { err(res, e); }
    }
);

// ─── Export ──────────────────────────────────────────────────────

router.get(
    '/revenue/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    async (req, res) => {
        try {
            const kind = String(req.query.kind || 'summary').toLowerCase();
            const csv = await revenue.exportCsv({ ...scopeFrom(req), kind });
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=revenue_${kind}_${Date.now()}.csv`);
            res.send(csv);
        } catch (e) { err(res, e); }
    }
);

module.exports = router;