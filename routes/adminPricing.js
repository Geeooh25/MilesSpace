// routes/adminPricing.js
// Admin endpoints for updating pricing keys in public.app_config.

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { adminAuthMiddleware } = require('../middleware/auth');
const { invalidateSettingsCache, PRICING_KEYS } = require('../services/adminConfigService');

// Whitelist — only these keys can be written by this endpoint
const ALLOWED_KEYS = new Set([
    'usd_to_ngn',
    'giftcard_markup_pct',
    'esim_markup_pct',
    'airtime_markup_pct',
    'giftcard_wholesale_currency'
]);

// ─── GET /api/admin/pricing-settings ─────────────────────────────────────
router.get('/pricing-settings', adminAuthMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('app_config')
            .select('key, value, description, updated_at')
            .in('key', [...ALLOWED_KEYS]);

        if (error) throw error;

        const settings = {};
        for (const row of data || []) {
            settings[row.key] = {
                value: row.value,
                description: row.description,
                updated_at: row.updated_at
            };
        }

        res.json({ success: true, data: settings });
    } catch (e) {
        console.error('[adminPricing] get failed:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── PATCH /api/admin/pricing-settings ───────────────────────────────────
router.patch('/pricing-settings', adminAuthMiddleware, async (req, res) => {
    try {
        const body = req.body || {};
        const patch = {};

        for (const key of Object.keys(body)) {
            if (!ALLOWED_KEYS.has(key)) continue;

            let val = body[key];

            // ── Validation per key ────────────────────────────────
            if (key === 'usd_to_ngn') {
                const n = Number(val);
                if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) {
                    return res.status(400).json({
                        success: false,
                        error: 'usd_to_ngn must be a positive number under 1,000,000'
                    });
                }
                val = String(n);
            } else if (key.endsWith('_markup_pct')) {
                let n = Number(val);

                // Accept both "15.7" (percent) and "0.157" (decimal)
                if (n > 1) n = n / 100;

                if (!Number.isFinite(n) || n < 0 || n > 0.9) {
                    return res.status(400).json({
                        success: false,
                        error: `${key} must be between 0 and 90% (0 to 0.9)`
                    });
                }
                val = n.toFixed(4);  // store as "0.1570"
            } else if (key === 'giftcard_wholesale_currency') {
                const s = String(val).toUpperCase();
                if (!/^[A-Z]{3}$/.test(s)) {
                    return res.status(400).json({
                        success: false,
                        error: 'giftcard_wholesale_currency must be a 3-letter code (e.g. NGN)'
                    });
                }
                val = s;
            }

            patch[key] = val;
        }

        if (!Object.keys(patch).length) {
            return res.status(400).json({
                success: false,
                error: `No valid keys in request. Allowed: ${[...ALLOWED_KEYS].join(', ')}`
            });
        }

        // ── Upsert each key ───────────────────────────────────────
        const errors = [];
        const updated = [];

        for (const [key, value] of Object.entries(patch)) {
            const { error } = await supabaseAdmin
                .from('app_config')
                .upsert({
                    key,
                    value,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'key' });

            if (error) {
                errors.push({ key, error: error.message });
            } else {
                updated.push({ key, value });
            }
        }

        // ── Invalidate cache so next request picks up new values ──
        if (updated.length) invalidateSettingsCache();

        // ── Optional: log to admin activity table ─────────────────
        try {
            await supabaseAdmin.from('admin_activity').insert({
                admin_id: req.adminId,
                admin_email: req.adminEmail || 'unknown',
                action: 'pricing_settings_updated',
                details: { updated, count: updated.length },
                ip_address: req.ip || 'unknown',
                user_agent: req.headers['user-agent'] || 'unknown',
                created_at: new Date().toISOString()
            });
        } catch (logErr) {
            console.warn('[adminPricing] activity log failed:', logErr.message);
        }

        res.json({
            success: true,
            updated,
            errors: errors.length ? errors : undefined
        });
    } catch (e) {
        console.error('[adminPricing] patch failed:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── POST /api/admin/pricing-settings/reset ──────────────────────────────
// Reverts all pricing keys to their defaults.
router.post('/pricing-settings/reset', adminAuthMiddleware, async (req, res) => {
    const DEFAULTS = {
        usd_to_ngn: '1400',
        giftcard_markup_pct: '0.1570',
        esim_markup_pct: '0.1500',
        airtime_markup_pct: '0.0500',
        giftcard_wholesale_currency: 'NGN'
    };

    try {
        for (const [key, value] of Object.entries(DEFAULTS)) {
            await supabaseAdmin
                .from('app_config')
                .upsert({
                    key,
                    value,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'key' });
        }

        invalidateSettingsCache();

        res.json({ success: true, message: 'Pricing settings reset to defaults', data: DEFAULTS });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;