'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requirePermission, PERMISSIONS, getClientIp } = require('../../middleware/adminAuth');
const { recordAdminAction } = require('../../middleware/adminAuth');
const infrastructure = require('../../services/infrastructureService');

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}
router.use('/infrastructure', attachRequestId);

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function err(res, e) {
    if (res.headersSent) return;
    const status = e?.status || 500;
    const code = e?.code || 'INFRA_ERROR';
    const message = status >= 500 ? 'Something went wrong. Please try again.' : (e?.message || 'Request failed.');
    if (status >= 500) console.error('[ADMIN INFRA]', code, e?.message || e);
    res.status(status).json({ success: false, code, error: message });
}

function auditView(req, action, targetId = 'railway') {
    // Fire-and-forget: a view must never fail because audit is slow.
    recordAdminAction({
        req,
        adminId: req.adminContext.id,
        action,
        targetType: 'infrastructure',
        targetId,
        result: 'success'
    }).catch(() => {});
}

// ─── Overview ──────────────────────────────────────────────────
router.get('/infrastructure/overview',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    async (req, res) => {
        try {
            const data = await infrastructure.getOverview();
            auditView(req, 'infrastructure.overview_viewed');
            ok(res, { overview: data });
        } catch (e) { err(res, e); }
    }
);

// ─── Usage / cost ─────────────────────────────────────────────
router.get('/infrastructure/usage',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    async (req, res) => {
        try {
            const data = await infrastructure.getUsage();
            auditView(req, 'infrastructure.usage_viewed');
            ok(res, { usage: data });
        } catch (e) { err(res, e); }
    }
);

// ─── Metrics (server + api) ───────────────────────────────────
router.get('/infrastructure/metrics',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    async (req, res) => {
        try {
            const data = await infrastructure.getMetrics();
            auditView(req, 'infrastructure.metrics_viewed');
            ok(res, { metrics: data });
        } catch (e) { err(res, e); }
    }
);

// ─── Deployment ────────────────────────────────────────────────
router.get('/infrastructure/deployment',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    async (req, res) => {
        try {
            const data = await infrastructure.getDeployment();
            auditView(req, 'infrastructure.deployment_viewed');
            ok(res, { deployment: data });
        } catch (e) { err(res, e); }
    }
);

// ─── Health (fast, read-only, safe) ───────────────────────────
router.get('/infrastructure/health',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    async (req, res) => {
        try {
            const data = await infrastructure.getHealth();
            ok(res, { health: data });
        } catch (e) { err(res, e); }
    }
);

module.exports = router;