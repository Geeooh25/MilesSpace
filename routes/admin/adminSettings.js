// routes/adminSettings.js
// ─────────────────────────────────────────────────────────────────
// Admin Settings API.
//
// This file does three things and nothing else:
//   1. Authenticate / authorize the caller
//   2. Validate the request shape
//   3. Call adminSettingsService and translate errors into responses
//
// No pricing math. No validation logic. No direct DB access.
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

const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
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
        adminId:    req.adminContext?.id    || null,
        adminEmail: req.adminContext?.email || null,
        ip:         req.ip || req.headers['x-forwarded-for'] || null,
        userAgent:  req.headers['user-agent'] || null,
        reason:     reason || null
    };
}

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/settings
//  Returns every section, keyed.
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
//  Query: key?, limit?
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
//  Also accepts a flat body: { key: value, ..., reason? }
// ═════════════════════════════════════════════════════════════════

router.patch(
    '/settings',
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    async (req, res) => {
        try {
            const body = req.body || {};
            const patch = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
                ? body.settings
                : (() => {
                    const clone = { ...body };
                    delete clone.reason;
                    return clone;
                })();

            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
                const e = new Error('settings must be an object');
                e.status = 422; e.code = 'INVALID_PATCH';
                throw e;
            }

            const ctx = ctxFrom(req, body.reason || null);
            const result = await settings.patchSettings(patch, ctx);

            sendOk(res, {
                updated: result.updated,
                unchanged: result.unchanged,
                version: result.version
            });
        } catch (err) { sendErr(res, err); }
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
        try {
            const key = String(req.params.key || '');
            const body = req.body || {};
            if (body.value === undefined) {
                const e = new Error('value is required');
                e.status = 422; e.code = 'VALUE_REQUIRED';
                throw e;
            }

            const ctx = ctxFrom(req, body.reason || null);
            const result = await settings.patchSettings({ [key]: body.value }, ctx);

            sendOk(res, {
                key,
                updated: result.updated.includes(key),
                unchanged: result.unchanged.includes(key),
                version: result.version
            });
        } catch (err) { sendErr(res, err); }
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
        try {
            const section = String(req.params.section || '').toLowerCase();
            const ctx = ctxFrom(req, req.body?.reason || null);
            const result = await settings.resetSection(section, ctx);
            sendOk(res, {
                section,
                reset: result.updated,
                unchanged: result.unchanged,
                version: result.version
            });
        } catch (err) { sendErr(res, err); }
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
        try {
            if (!req.adminContext?.isSuperAdmin) {
                const e = new Error('Super admin privileges required to reset all settings.');
                e.status = 403;
                e.code = 'SUPER_ADMIN_REQUIRED';
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
            sendOk(res, {
                reset: result.updated,
                unchanged: result.unchanged,
                version: result.version
            });
        } catch (err) { sendErr(res, err); }
    }
);

module.exports = router;