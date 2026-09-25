// routes/admin/boostAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Boost API.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const { requirePermission, PERMISSIONS, recordAdminAction } = require('../../middleware/adminAuth');
const { supabaseAdmin } = require('../../db/supabase');
const boostService = require('../../services/boostService');
const syncService  = require('../../services/boostSyncService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAFE_MESSAGES = {
    PROVIDER_NOT_CONFIGURED:   'SMMWiz is not configured on this server. Set SMMWIZ_API_KEY and restart.',
    PROVIDER_NETWORK:          'SMMWiz could not be reached. Try again shortly.',
    PROVIDER_ERROR:            'SMMWiz rejected the request.',
    SERVICE_NOT_FOUND:         'Service not found.',
    SERVICE_UPDATE_FAILED:     'Failed to update service.',
    BOOST_NOT_FOUND:           'Boost order not found.',
    NOT_REFUNDABLE:            'This order is not eligible for a refund.',
    ORDER_STATE_CHANGED:       'The order changed before this action completed. Reload and try again.',
    INVALID_STATUS_TRANSITION: 'That status change is not allowed.',
    INVALID_ID:                'Invalid identifier.',
    REASON_REQUIRED:           'A reason is required.',
    NOTE_REQUIRED:             'Note text is required.',
    NOTE_SAVE_FAILED:          'Failed to save note.'
};

function sendOk(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'BOOST_ADMIN_ERROR';
    const message = SAFE_MESSAGES[code] || err?.message || 'Boost admin request failed.';
    if (status >= 500 || !SAFE_MESSAGES[code]) {
        console.error('[ADMIN BOOST]', code, err?.message || err);
    }
    const body = { success: false, code, error: message };
    if (err?.missing) body.missing = err.missing;
    res.status(status).json(body);
}
function ctxFrom(req) {
    return {
        adminId: req.adminContext?.id || null,
        adminEmail: req.adminContext?.email || null,
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.headers['x-request-id'] || null
    };
}

// ─── Overview ────────────────────────────────────────────────────

router.get(
    '/boost/overview',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const overview = await boostService.getOverview({
                from: req.query.from || null,
                to: req.query.to || null
            });
            sendOk(res, { overview });
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Orders ──────────────────────────────────────────────────────

router.get(
    '/boost/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await boostService.listOrders({
                page: req.query.page, limit: req.query.limit,
                status: req.query.status, platform: req.query.platform,
                category: req.query.category, currency: req.query.currency,
                user_id: req.query.user_id, from: req.query.from,
                to: req.query.to, search: req.query.search
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/boost/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await boostService.getOrder(req.params.id);
            sendOk(res, data);
        } catch (err) { sendErr(res, err); }
    }
);

router.put(
    '/boost/orders/:id/status',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { status, note } = req.body || {};
            const result = await boostService.updateOrderStatus({
                orderId: req.params.id, status, note, ctx: ctxFrom(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/boost/orders/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason, allow_non_failed } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }
            const result = await boostService.refundOrder({
                orderId: req.params.id,
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req),
                allowNonFailed: !!allow_non_failed
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/boost/orders/:id/note',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { note } = req.body || {};
            if (!note || String(note).trim().length < 2) {
                const e = new Error('Note text is required.');
                e.status = 422; e.code = 'NOTE_REQUIRED';
                throw e;
            }
            const { data: updated, error } = await supabaseAdmin
                .from('boost_orders')
                .update({ admin_note: String(note).slice(0, 1000), updated_at: new Date().toISOString() })
                .eq('id', req.params.id)
                .select('*')
                .maybeSingle();
            if (error || !updated) {
                const e = new Error('Failed to save note.');
                e.status = 500; e.code = 'NOTE_SAVE_FAILED';
                throw e;
            }
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'boost.order_note',
                targetType: 'boost_order',
                targetId: req.params.id,
                reason: String(note).slice(0, 500),
                req
            });
            sendOk(res, { order: boostService.shapeOrder(updated) });
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Sync ────────────────────────────────────────────────────────
// Returns honest diagnostics when SMMWiz isn't configured.

router.post(
    '/boost/sync',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res) => {
        try {
            if (!syncService.isProviderConfigured()) {
                return res.status(503).json({
                    success: false,
                    code: 'PROVIDER_NOT_CONFIGURED',
                    error: 'SMMWiz is not configured on this server. Set SMMWIZ_API_KEY and restart.',
                    missing: 'SMMWIZ_API_KEY'
                });
            }
            const submit = await syncService.submitPendingBoostOrders({ limit: 25 });
            const sweep  = await syncService.syncPendingBoostOrders({ limit: 100 });
            sendOk(res, { submit, sweep });
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Services ────────────────────────────────────────────────────

router.get(
    '/boost/services',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const result = await boostService.listServices({
                page: req.query.page, limit: req.query.limit,
                active: req.query.active, visible: req.query.visible,
                platform: req.query.platform, category: req.query.category,
                search: req.query.search
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.put(
    '/boost/services/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await boostService.updateService({
                serviceId: req.params.id,
                patch: req.body || {},
                ctx: ctxFrom(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/boost/services/sync',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            if (!syncService.isProviderConfigured()) {
                return res.status(503).json({
                    success: false,
                    code: 'PROVIDER_NOT_CONFIGURED',
                    error: 'SMMWiz is not configured on this server. Set SMMWIZ_API_KEY and restart.',
                    missing: 'SMMWIZ_API_KEY'
                });
            }
            const raw = await syncService.callSmmWiz({ action: 'services' });
            const list = Array.isArray(raw) ? raw : (raw?.services || []);

            let created = 0, updated = 0;
            const errors = [];

            for (const s of list) {
                try {
                    const providerServiceId = String(s.service);
                    const platform = detectPlatform(s.name, s.category);
                    const category = detectCategory(s.name, s.category);

                    const { data: existing } = await supabaseAdmin
                        .from('boost_services')
                        .select('id, active, visible_to_users, markup_percent, custom_price, min_quantity, max_quantity, name, description')
                        .eq('provider', 'smmwiz')
                        .eq('provider_service_id', providerServiceId)
                        .maybeSingle();

                    if (existing) {
                        await supabaseAdmin
                            .from('boost_services')
                            .update({
                                provider_rate: Number(s.rate) || null,
                                min_quantity: existing.min_quantity ?? (Number(s.min) || null),
                                max_quantity: existing.max_quantity ?? (Number(s.max) || null),
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', existing.id);
                        updated++;
                    } else {
                        await supabaseAdmin
                            .from('boost_services')
                            .insert({
                                provider: 'smmwiz',
                                provider_service_id: providerServiceId,
                                name: String(s.name || `Service ${providerServiceId}`).slice(0, 200),
                                description: String(s.name || '').slice(0, 500),
                                platform,
                                category,
                                active: false,
                                visible_to_users: false,
                                provider_rate: Number(s.rate) || null,
                                min_quantity: Number(s.min) || null,
                                max_quantity: Number(s.max) || null,
                                refill_allowed: Boolean(s.refill),
                                sort_order: 100,
                                created_at: new Date().toISOString(),
                                updated_at: new Date().toISOString()
                            });
                        created++;
                    }
                } catch (e) {
                    errors.push({ service: s.service, message: e.message });
                }
            }
            sendOk(res, { created, updated, errors, total_provider_services: list.length });
        } catch (err) { sendErr(res, err); }
    }
);

function detectPlatform(name, category) {
    const src = `${name || ''} ${category || ''}`.toLowerCase();
    if (src.includes('instagram')) return 'instagram';
    if (src.includes('tiktok'))    return 'tiktok';
    if (src.includes('youtube'))   return 'youtube';
    if (src.includes('facebook'))  return 'facebook';
    if (src.includes('twitter') || src.includes(' x ')) return 'twitter';
    if (src.includes('telegram'))  return 'telegram';
    if (src.includes('whatsapp'))  return 'whatsapp';
    if (src.includes('discord'))   return 'discord';
    if (src.includes('spotify'))   return 'spotify';
    return 'other';
}
function detectCategory(name, category) {
    const src = `${name || ''} ${category || ''}`.toLowerCase();
    if (src.includes('follower'))   return 'followers';
    if (src.includes('like'))       return 'likes';
    if (src.includes('view') || src.includes('impression')) return 'views';
    if (src.includes('comment'))    return 'comments';
    if (src.includes('share'))      return 'shares';
    if (src.includes('subscriber')) return 'subscribers';
    if (src.includes('member'))     return 'members';
    return 'other';
}

// ─── Config ──────────────────────────────────────────────────────

router.get(
    '/boost/config',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const [usdRate, markup] = await Promise.all([
                boostService.getUsdToNgnRate(),
                boostService.getDefaultMarkup()
            ]);
            const keys = ['boost_system_enabled', 'boost_allow_ngn', 'boost_allow_usd', 'boost_auto_sync_enabled'];
            const { data } = await supabaseAdmin.from('app_config').select('key, value').in('key', keys);
            const flags = {};
            for (const r of data || []) {
                flags[r.key] = r.value === 'true' || r.value === true;
            }
            sendOk(res, {
                config: {
                    usd_to_ngn: usdRate,
                    markup_percent: markup * 100,
                    smmwiz_configured: syncService.isProviderConfigured(),
                    enabled: flags.boost_system_enabled ?? true,
                    allow_ngn: flags.boost_allow_ngn ?? true,
                    allow_usd: flags.boost_allow_usd ?? true,
                    auto_sync_enabled: flags.boost_auto_sync_enabled ?? true
                }
            });
        } catch (err) { sendErr(res, err); }
    }
);

router.put(
    '/boost/config',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const b = req.body || {};
            const now = new Date().toISOString();
            const rows = [];
            if (b.usd_to_ngn !== undefined) rows.push({ key: 'usd_to_ngn', value: String(b.usd_to_ngn), updated_at: now });
            if (b.markup_percent !== undefined) {
                const pct = Number(b.markup_percent);
                if (Number.isFinite(pct)) {
                    const dec = pct > 1 ? pct / 100 : pct;
                    rows.push({ key: 'boost_markup_pct', value: String(dec), updated_at: now });
                }
            }
            if (b.enabled !== undefined) rows.push({ key: 'boost_system_enabled', value: String(!!b.enabled), updated_at: now });
            if (b.allow_ngn !== undefined) rows.push({ key: 'boost_allow_ngn', value: String(!!b.allow_ngn), updated_at: now });
            if (b.allow_usd !== undefined) rows.push({ key: 'boost_allow_usd', value: String(!!b.allow_usd), updated_at: now });
            if (b.auto_sync_enabled !== undefined) rows.push({ key: 'boost_auto_sync_enabled', value: String(!!b.auto_sync_enabled), updated_at: now });

            if (rows.length) {
                const { error } = await supabaseAdmin.from('app_config').upsert(rows, { onConflict: 'key' });
                if (error) throw error;
            }

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'boost.config_update',
                targetType: 'boost_config',
                targetId: 'global',
                after: b,
                req
            });

            sendOk(res, { ok: true });
        } catch (err) { sendErr(res, err); }
    }
);

module.exports = router;