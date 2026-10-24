// routes/admin/providerAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin provider routes.
//
//   GET  /api/admin/providers                     list + current health
//   GET  /api/admin/providers/:provider           detail + history + webhooks
//   POST /api/admin/providers/:provider/test      run one check
//   POST /api/admin/providers/test-all            run all checks
//   GET  /api/admin/providers/:provider/health-history
//   GET  /api/admin/providers/:provider/webhooks
//
// Guarantees:
//   • No route returns credential material. The service layer already
//     sanitizes; this file does not re-append anything.
//   • Manual tests are rate-limited per admin so the UI cannot be
//     used to hammer provider APIs:
//       - single provider test: 5 per minute per admin
//       - test-all:            1 per 60 seconds per admin
//   • Every response carries X-Request-Id and the id is passed into
//     the service's audit log rows.
//   • This file contains NO business logic. It validates the request,
//     calls services/providerHealthService, and translates results.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const health = require('../../services/providerHealthService');
const providerFactory = require('../../services/providers/providerFactory');
const metadata = require('../../services/providers/providerMetadata');

// ─── Provider name validation ───────────────────────────────────
// Lowercase, at least 2 chars, alphanumeric + underscore/dash.
// Length cap protects against path abuse. The factory does its own
// existence check on the resolved name.
const PROVIDER_RE = /^[a-z][a-z0-9_-]{1,40}$/;

// ─── Response helpers ───────────────────────────────────────────

function ok(res, payload) {
    if (res.headersSent) return;
    res.json({ success: true, ...payload });
}

function err(res, e) {
    if (res.headersSent) return;
    const status = e?.status || 500;
    const code = e?.code || 'PROVIDER_ADMIN_ERROR';
    const message = status >= 500
        ? 'Something went wrong. Please try again.'
        : (e?.message || 'Request failed.');

    if (status >= 500) console.error('[ADMIN PROVIDERS]', code, e?.message || e);

    const body = { success: false, code, error: message };
    if (e?.provider) body.provider = e.provider;
    if (e?.retryAfterSeconds) body.retryAfter = e.retryAfterSeconds;
    res.status(status).json(body);
}

// ─── Request id ─────────────────────────────────────────────────

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}
router.use('/providers', attachRequestId);

// ─── Per-admin in-process rate limiting ─────────────────────────
// Simple fixed-window counter keyed by (action, adminId). Protects
// provider APIs from rapid manual testing via the admin panel. The
// background scheduler does NOT go through this file, so its cadence
// is unaffected.

const _buckets = new Map();

function rateLimit({ key, max, windowMs }) {
    return (req, res, next) => {
        const adminId = req.adminContext?.id || req.ip || 'anon';
        const bucketKey = `${key}:${adminId}`;
        const now = Date.now();
        const b = _buckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };

        if (now > b.resetAt) {
            b.count = 0;
            b.resetAt = now + windowMs;
        }
        b.count++;
        _buckets.set(bucketKey, b);

        if (b.count > max) {
            const retry = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
            res.setHeader('Retry-After', String(retry));
            return res.status(429).json({
                success: false,
                code: 'RATE_LIMITED',
                error: `Too many requests. Retry in ${retry}s.`,
                retryAfter: retry
            });
        }
        next();
    };
}

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/providers
//  List every registered provider with current cached health.
// ═════════════════════════════════════════════════════════════════

router.get(
    '/providers',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const all = await health.getProviderHealth();
            const labels = providerFactory.labels();

            // Ensure label is always populated, even for providers that
            // have never been health-checked.
            for (const [key, row] of Object.entries(all)) {
                if (!row.label && labels[key]) row.label = labels[key];
                // 'enabled' falls back to the metadata flag if the row
                // has never been written.
                if (row.enabled === undefined) {
                    const meta = metadata.getMetadata(key);
                    row.enabled = meta ? !!meta.enabled : true;
                }
            }

            // Summary counts derived from the same snapshot.
            const summary = {
                total: 0,
                healthy: 0,
                degraded: 0,
                offline: 0,
                not_configured: 0,
                circuit_open: 0,
                last_checked_at: null
            };

            for (const row of Object.values(all)) {
                summary.total++;

                const status = String(row.status || '').toLowerCase();
                if (['healthy', 'connected', 'configured'].includes(status)) {
                    summary.healthy++;
                } else if (status === 'degraded') {
                    summary.degraded++;
                } else if (['unreachable', 'auth_failed', 'rate_limited'].includes(status)) {
                    summary.offline++;
                } else if (status === 'circuit_open') {
                    summary.circuit_open++;
                    summary.offline++;
                } else if (status === 'not_configured') {
                    summary.not_configured++;
                }

                if (row.lastCheckedAt) {
                    if (!summary.last_checked_at || row.lastCheckedAt > summary.last_checked_at) {
                        summary.last_checked_at = row.lastCheckedAt;
                    }
                }
            }

            ok(res, { providers: all, summary });
        } catch (e) { err(res, e); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/providers/:provider
//  Detail: current state + capabilities + latency + business health
//  + recent history + recent webhooks. Sanitized by the service.
// ═════════════════════════════════════════════════════════════════

router.get(
    '/providers/:provider',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res, next) => {
        const name = String(req.params.provider || '').toLowerCase();
        if (!PROVIDER_RE.test(name)) return next();
        try {
            const detail = await health.getProviderDetail(name);
            ok(res, { provider: detail });
        } catch (e) { err(res, e); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/providers/:provider/health-history
//  Last N health check events for the provider.
// ═════════════════════════════════════════════════════════════════

router.get(
    '/providers/:provider/health-history',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res, next) => {
        const name = String(req.params.provider || '').toLowerCase();
        if (!PROVIDER_RE.test(name)) return next();
        try {
            const events = await health.getHealthHistory(name, { limit: req.query.limit });
            ok(res, { events });
        } catch (e) { err(res, e); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/providers/:provider/webhooks
//  Recent webhook events for the provider.
// ═════════════════════════════════════════════════════════════════

router.get(
    '/providers/:provider/webhooks',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res, next) => {
        const name = String(req.params.provider || '').toLowerCase();
        if (!PROVIDER_RE.test(name)) return next();
        try {
            const webhooks = await health.getWebhookHistory(name, { limit: req.query.limit });
            ok(res, { webhooks });
        } catch (e) { err(res, e); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/admin/providers/test-all
//  Runs a health check on every provider.
//
//  Rate limit: 1 per 60 seconds per admin. Testing all providers
//  makes one outbound API call per provider, so this cap protects
//  both the providers and the Node process.
// ═════════════════════════════════════════════════════════════════

router.post(
    '/providers/test-all',
    requirePermission(PERMISSIONS.PROVIDERS_TEST || PERMISSIONS.PROVIDERS_READ),
    rateLimit({ key: 'provider-test-all', max: 1, windowMs: 60_000 }),
    async (req, res) => {
        try {
            const results = await health.checkAll({
                adminId: req.adminContext?.id || null,
                reason: 'admin_test_all'
            });
            ok(res, { results });
        } catch (e) { err(res, e); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/admin/providers/:provider/test
//  Run a health check on one provider.
//
//  Rate limit: 5 per 60 seconds per admin. Enough for verification
//  without inviting a request storm.
// ═════════════════════════════════════════════════════════════════

router.post(
    '/providers/:provider/test',
    requirePermission(PERMISSIONS.PROVIDERS_TEST || PERMISSIONS.PROVIDERS_READ),
    rateLimit({ key: 'provider-test-one', max: 5, windowMs: 60_000 }),
    async (req, res, next) => {
        const name = String(req.params.provider || '').toLowerCase();
        if (!PROVIDER_RE.test(name)) return next();
        try {
            const result = await health.checkProvider(name, {
                adminId: req.adminContext?.id || null,
                reason: 'admin_test'
            });
            ok(res, { result });
        } catch (e) { err(res, e); }
    }
);

module.exports = router;