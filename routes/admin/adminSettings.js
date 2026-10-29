// routes/adminSettings.js
// ─────────────────────────────────────────────────────────────────
// Admin Settings API.
//
// This file does three things and nothing else:
//   1. Authenticate / authorize the caller
//   2. Validate the request shape
//   3. Call adminSettingsService, translate errors, and strictly
//      log the result (success or failure) to the audit trail.
//
// Routes:
//   GET    /api/admin/settings
//   GET    /api/admin/settings/section/:name
//   GET    /api/admin/settings/rates/history
//   GET    /api/admin/settings/audit
//   GET    /api/admin/settings/health
//   PATCH  /api/admin/settings
//   PUT    /api/admin/settings/:key
//   POST   /api/admin/settings/reset/:section
//   POST   /api/admin/settings/reset-all
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { recordAdminActionStrict } = require('../../middleware/adminAuditStrict');
const settings = require('../../services/adminSettingsService');

// ─── Response helpers ────────────────────────────────────────────

function sendOk(res, data) {
    if (res.headersSent) return;
    res.json({ success: true, data });
}

function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'SETTINGS_ERROR';
    const message = err?.message || 'Settings request failed';

    // Never leak stack traces or secrets.
    const safe = { success: false, code, message };
    if (err?.key) safe.key = err.key;
    if (err?.allowed) safe.allowed = err.allowed;
    if (err?.keys) safe.keys = err.keys;
    if (err?.service) safe.service = err.service;
    if (err?.provider) safe.provider = err.provider;
    if (err?.operation) safe.operation = err.operation;

    if (status >= 500) {
        console.error('[ADMIN SETTINGS]', code, message);
    }
    res.status(status).json(safe);
}

function ctxFrom(req, reason = null) {
    return {
        adminId:      req.adminContext?.id    || null,
        adminEmail:   req.adminContext?.email || null,
        isSuperAdmin: !!req.adminContext?.isSuperAdmin,
        ip:           req.ip || req.headers['x-forwarded-for'] || null,
        userAgent:    req.headers['user-agent'] || null,
        reason:       reason || null
    };
}

// ─── Audit helper ────────────────────────────────────────────────
// Wraps the strict audit call so a failure to log doesn't crash
// the response — but it DOES emit an error to the server log so we
// know the audit chain is broken.
async function logSettingsAction({ req, action, result, reason, failureCode = null, metadata = null, durationMs = null }) {
    try {
        await recordAdminActionStrict({
            req,
            adminId:    req.adminContext.id,
            adminEmail: req.adminContext.email,
            adminRole:  req.adminContext.role,
            action,
            targetType: 'app_config',
            result,
            failureCode,
            reason: reason || null,
            durationMs,
            metadata: metadata || null
        });
    } catch (err) {
        // Do not fail the request because audit failed — but log loudly.
        console.error(`[ADMIN SETTINGS] Failed to write audit for ${action}:`, err.message);
    }
}

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/settings
// ═════════════════════════════════════════════════════════════════

router.get(
    '/settings',
    requirePermission(PERMISSIONS.SETTINGS_READ),
    async (req, res) => {
        try {
            const sectioned = await settings.getSettingsBySectionAll();
            const version = Number(await settings.getRaw('config_version')) || 1;
            sendOk(res, {
                sections: sectioned,
                version,
                updatedAt: new Date().toISOString()
            });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/settings/section/:name
// ═════════════════════════════════════════════════════════════════

router.get(
    '/settings/section/:name',
    requirePermission(PERMISSIONS.SETTINGS_READ),
    async (req, res) => {
        try {
            const section = String(req.params.name || '').toLowerCase();
            const values = await settings.getSection(section);
            sendOk(res, { section, values });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/settings/rates/history
// ═════════════════════════════════════════════════════════════════

router.get(
    '/settings/rates/history',
    requirePermission(PERMISSIONS.SETTINGS_READ),
    async (req, res) => {
        try {
            const key = req.query.key ? String(req.query.key) : null;
            const limit = parseInt(req.query.limit, 10) || 100;
            const history = await settings.getRateHistory({ key, limit });
            sendOk(res, history);
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/settings/audit
// ═════════════════════════════════════════════════════════════════

router.get(
    '/settings/audit',
    requirePermission(PERMISSIONS.SETTINGS_READ),
    async (req, res) => {
        try {
            const limit = parseInt(req.query.limit, 10) || 100;
            const rows = await settings.getAudit({ limit });
            sendOk(res, rows);
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/settings/health
// ═════════════════════════════════════════════════════════════════

router.get(
    '/settings/health',
    requirePermission(PERMISSIONS.SETTINGS_READ),
    async (req, res) => {
        try {
            const health = await settings.getHealth();
            sendOk(res, { configuration: health });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PATCH /api/admin/settings
//  Body: { settings: { key: value, ... }, reason? }
// ═════════════════════════════════════════════════════════════════

router.patch(
    '/settings',
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    async (req, res) => {
        const started = Date.now();
        const body = req.body || {};
        const reason = body.reason || null;
        const patch = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
            ? body.settings
            : (() => {
                const clone = { ...body };
                delete clone.reason;
                return clone;
            })();

        try {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
                const e = new Error('settings must be an object');
                e.status = 422; e.code = 'INVALID_PATCH';
                throw e;
            }

            const ctx = ctxFrom(req, reason);
            const result = await settings.patchSettings(patch, ctx);

            // Successful change with at least one key updated.
            if (result.updated && result.updated.length > 0) {
                await logSettingsAction({
                    req,
                    action: 'settings.update',
                    result: 'success',
                    reason: reason || 'No reason provided',
                    durationMs: Date.now() - started,
                    metadata: {
                        updated_keys: result.updated,
                        unchanged_keys: result.unchanged || [],
                        version: result.version
                    }
                });
            }

            sendOk(res, {
                updated: result.updated,
                unchanged: result.unchanged,
                version: result.version
            });
        } catch (err) {
            // Log permission denials and any other failure the admin
            // was blocked by. Include the reason the server rejected it.
            const isPermissionError = err.code === 'SUPER_ADMIN_REQUIRED'
                || err.code === 'PERMISSION_DENIED'
                || err.status === 403;

            const isValidationError = err.status === 422;

            if (isPermissionError || isValidationError) {
                await logSettingsAction({
                    req,
                    action: 'settings.update_failed',
                    result: 'failure',
                    failureCode: err.code || 'SETTINGS_WRITE_FAILED',
                    reason: err.message || 'Settings change was rejected.',
                    durationMs: Date.now() - started,
                    metadata: {
                        attempted_keys: Object.keys(patch),
                        attempted_reason: reason || null
                    }
                });
            }

            sendErr(res, err);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PUT /api/admin/settings/:key
//  Body: { value, reason? }
// ═════════════════════════════════════════════════════════════════

router.put(
    '/settings/:key',
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    async (req, res) => {
        const started = Date.now();
        const key = String(req.params.key || '');
        const body = req.body || {};
        const reason = body.reason || null;

        try {
            if (body.value === undefined) {
                const e = new Error('value is required');
                e.status = 422; e.code = 'VALUE_REQUIRED';
                throw e;
            }

            const ctx = ctxFrom(req, reason);
            const result = await settings.patchSettings({ [key]: body.value }, ctx);

            if (result.updated && result.updated.includes(key)) {
                await logSettingsAction({
                    req,
                    action: 'settings.update',
                    result: 'success',
                    reason: reason || 'No reason provided',
                    durationMs: Date.now() - started,
                    metadata: {
                        updated_keys: [key],
                        version: result.version
                    }
                });
            }

            sendOk(res, {
                key,
                updated: result.updated.includes(key),
                unchanged: result.unchanged.includes(key),
                version: result.version
            });
        } catch (err) {
            const isPermissionError = err.code === 'SUPER_ADMIN_REQUIRED'
                || err.code === 'PERMISSION_DENIED'
                || err.status === 403;
            const isValidationError = err.status === 422;

            if (isPermissionError || isValidationError) {
                await logSettingsAction({
                    req,
                    action: 'settings.update_failed',
                    result: 'failure',
                    failureCode: err.code || 'SETTINGS_WRITE_FAILED',
                    reason: err.message || 'Settings change was rejected.',
                    durationMs: Date.now() - started,
                    metadata: {
                        attempted_key: key,
                        attempted_reason: reason || null
                    }
                });
            }

            sendErr(res, err);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/admin/settings/reset/:section
//  Body: { reason? }
// ═════════════════════════════════════════════════════════════════

router.post(
    '/settings/reset/:section',
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    async (req, res) => {
        const started = Date.now();
        const section = String(req.params.section || '').toLowerCase();
        const reason = (req.body && req.body.reason) || `Reset ${section}`;

        try {
            const ctx = ctxFrom(req, reason);
            const result = await settings.resetSection(section, ctx);

            if (result.updated && result.updated.length > 0) {
                await logSettingsAction({
                    req,
                    action: 'settings.reset_section',
                    result: 'success',
                    reason,
                    durationMs: Date.now() - started,
                    metadata: {
                        section,
                        reset_keys: result.updated,
                        version: result.version
                    }
                });
            }

            sendOk(res, {
                section,
                reset: result.updated,
                unchanged: result.unchanged,
                version: result.version
            });
        } catch (err) {
            const isPermissionError = err.code === 'SUPER_ADMIN_REQUIRED'
                || err.code === 'PERMISSION_DENIED'
                || err.status === 403;

            if (isPermissionError) {
                await logSettingsAction({
                    req,
                    action: 'settings.reset_section_failed',
                    result: 'failure',
                    failureCode: err.code,
                    reason: err.message || 'Reset was rejected.',
                    durationMs: Date.now() - started,
                    metadata: { attempted_section: section }
                });
            }

            sendErr(res, err);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/admin/settings/reset-all
//  Body: { confirm: "RESET ALL", reason }
//  Super-admin only.
// ═════════════════════════════════════════════════════════════════

router.post(
    '/settings/reset-all',
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    async (req, res) => {
        const started = Date.now();

        try {
            if (!req.adminContext?.isSuperAdmin) {
                const e = new Error('Super admin privileges required to reset all settings.');
                e.status = 403;
                e.code = 'SUPER_ADMIN_REQUIRED';

                await logSettingsAction({
                    req,
                    action: 'settings.reset_all_failed',
                    result: 'failure',
                    failureCode: e.code,
                    reason: e.message,
                    durationMs: Date.now() - started
                });

                throw e;
            }

            const body = req.body || {};
            if (String(body.confirm || '').trim().toUpperCase() !== 'RESET ALL') {
                const e = new Error('Confirmation string "RESET ALL" is required.');
                e.status = 422;
                e.code = 'CONFIRMATION_REQUIRED';
                throw e;
            }
            if (!body.reason || String(body.reason).trim().length < 3) {
                const e = new Error('A reason is required.');
                e.status = 422;
                e.code = 'REASON_REQUIRED';
                throw e;
            }

            const ctx = ctxFrom(req, body.reason);
            const result = await settings.resetAll(ctx);

            await logSettingsAction({
                req,
                action: 'settings.reset_all',
                result: 'success',
                reason: body.reason,
                durationMs: Date.now() - started,
                metadata: {
                    reset_keys_count: (result.updated || []).length,
                    version: result.version
                }
            });

            sendOk(res, {
                reset: result.updated,
                unchanged: result.unchanged,
                version: result.version
            });
        } catch (err) {
            sendErr(res, err);
        }
    }
);

module.exports = router;