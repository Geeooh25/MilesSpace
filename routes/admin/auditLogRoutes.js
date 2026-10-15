'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requirePermission, PERMISSIONS, getClientIp } = require('../../middleware/adminAuth');
const { recordAdminActionStrict } = require('../../middleware/adminAuditStrict');
const audit = require('../../services/auditLogService');

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}
router.use('/audit', attachRequestId);

function ok(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function err(res, e) {
    if (res.headersSent) return;
    const status = e?.status || 500;
    const code = e?.code || 'AUDIT_ADMIN_ERROR';
    const message = status >= 500 ? 'Something went wrong. Please try again.' : (e?.message || 'Request failed.');
    if (status >= 500) console.error('[ADMIN AUDIT]', code, e?.message || e);
    res.status(status).json({ success: false, code, error: message });
}

// ─── Bootstrap (point 30) — one request instead of four ────────
router.get('/audit/bootstrap',
    requirePermission(PERMISSIONS.AUDIT_READ),
    async (req, res) => {
        try {
            const [summary, facets, admins] = await Promise.all([
                audit.summary({
                    from:     req.query.from     || null,
                    to:       req.query.to       || null,
                    adminId:  req.query.admin_id || null,
                    category: req.query.category || null,
                    severity: req.query.severity || null,
                    result:   req.query.result   || null
                }).catch(() => ({ available: false })),
                audit.facets().catch(() => ({ categories: [], actions: [], severities: [], results: [], actorTypes: [] })),
                audit.distinctAdmins().catch(() => [])
            ]);

            // Best-effort audit of the view. Non-strict so a read
            // never fails because audit is slow.
            audit.record({
                adminId:  req.adminContext?.id,
                adminEmail: req.adminContext?.email,
                adminRole:  req.adminContext?.role,
                action: 'audit.view',
                targetType: 'audit_log',
                result: 'success',
                requestId: req.requestId,
                sessionId: req.adminContext?.sessionId,
                correlationId: req.correlationId,
                ip: getClientIp(req),
                userAgent: req.headers['user-agent']
            }).catch(() => {});

            ok(res, { summary, facets, admins });
        } catch (e) { err(res, e); }
    }
);

router.get('/audit/summary',
    requirePermission(PERMISSIONS.AUDIT_READ),
    async (req, res) => {
        try {
            const s = await audit.summary({
                from:     req.query.from     || null,
                to:       req.query.to       || null,
                adminId:  req.query.admin_id || null,
                category: req.query.category || null,
                severity: req.query.severity || null,
                result:   req.query.result   || null
            });
            ok(res, { summary: s });
        } catch (e) { err(res, e); }
    }
);

router.get('/audit/facets',
    requirePermission(PERMISSIONS.AUDIT_READ),
    async (req, res) => {
        try { ok(res, { facets: await audit.facets() }); }
        catch (e) { err(res, e); }
    }
);

router.get('/audit/admins',
    requirePermission(PERMISSIONS.AUDIT_READ),
    async (req, res) => {
        try { ok(res, { admins: await audit.distinctAdmins() }); }
        catch (e) { err(res, e); }
    }
);

// ─── Export — audited strictly (points 19, 20) ────────────────
router.get('/audit/export',
    requirePermission(PERMISSIONS.AUDIT_EXPORT),
    async (req, res) => {
        const started = Date.now();
        try {
            const result = await audit.exportCsv({
                search:   req.query.search   || null,
                adminId:  req.query.admin_id || null,
                category: req.query.category || null,
                action:   req.query.action   || null,
                severity: req.query.severity || null,
                result:   req.query.result   || null,
                actorType: req.query.actor_type || null,
                provider: req.query.provider || null,
                from:     req.query.from     || null,
                to:       req.query.to       || null,
                correlationId: req.query.correlation_id || null,
                requestId:     req.query.request_id     || null
            });

            // Strict audit of the export itself. If this fails the
            // export is aborted so we never hand out data without a
            // record of who took it.
            await recordAdminActionStrict({
                req,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                adminRole: req.adminContext.role,
                action: 'audit.export',
                targetType: 'audit_log',
                result: 'success',
                durationMs: Date.now() - started,
                metadata: {
                    filters: {
                        search:   req.query.search   || null,
                        admin_id: req.query.admin_id || null,
                        category: req.query.category || null,
                        action:   req.query.action   || null,
                        severity: req.query.severity || null,
                        result:   req.query.result   || null,
                        actor_type: req.query.actor_type || null,
                        provider: req.query.provider || null,
                        from:     req.query.from     || null,
                        to:       req.query.to       || null
                    },
                    row_count: result.rowCount,
                    truncated: result.truncated
                }
            });

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition',
                `attachment; filename=admin_audit_${new Date().toISOString().slice(0,10)}.csv`);
            res.setHeader('X-Export-Row-Count', String(result.rowCount));
            if (result.truncated) res.setHeader('X-Export-Truncated', 'true');
            res.send(result.csv);
        } catch (e) {
            err(res, e);
        }
    }
);

// ─── List ──────────────────────────────────────────────────────
router.get('/audit',
    requirePermission(PERMISSIONS.AUDIT_READ),
    async (req, res) => {
        try {
            const result = await audit.list({
                page:     req.query.page  || 1,
                limit:    req.query.limit || 50,
                search:   req.query.search   || null,
                adminId:  req.query.admin_id || null,
                category: req.query.category || null,
                action:   req.query.action   || null,
                severity: req.query.severity || null,
                result:   req.query.result   || null,
                actorType: req.query.actor_type || null,
                provider: req.query.provider || null,
                correlationId: req.query.correlation_id || null,
                requestId:     req.query.request_id     || null,
                from:     req.query.from     || null,
                to:       req.query.to       || null
            });
            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

// ─── Single entry ──────────────────────────────────────────────
router.get('/audit/:id',
    requirePermission(PERMISSIONS.AUDIT_READ),
    async (req, res, next) => {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.id || ''))) return next();
        try { ok(res, await audit.get(req.params.id)); }
        catch (e) { err(res, e); }
    }
);

module.exports = router;