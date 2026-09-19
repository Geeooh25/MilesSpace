// routes/ratesRoutes.js
// Public read-only exchange rates. No auth required (rates are public).
// The admin edits these values in app_config; this route just exposes them.

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');

// In-memory cache so we don't hammer Supabase for every page load.
const cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

async function loadRates() {
    if (cache.data && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
        return cache.data;
    }

    const keys = [
        'usd_to_ngn',
        'gbp_to_ngn',
        'eur_to_ngn',
        'cad_to_ngn',
        'fx_rate_GHS_NGN',
        'fx_rate_KES_NGN',
        'fx_rate_ZAR_NGN',
        'fx_rate_XAF_NGN',
        'fx_rate_XOF_NGN',
        'fx_rate_TZS_NGN',
        'fx_rate_EGP_NGN',
        'exchange_rate_updated_at'
    ];

    const { data, error } = await supabaseAdmin
        .from('app_config')
        .select('key, value')
        .in('key', keys);

    if (error) throw error;

    const flat = {};
    for (const row of data || []) flat[row.key] = row.value;

    const parsed = {
        usd_to_ngn: parseFloat(flat.usd_to_ngn) || 1600,
        gbp_to_ngn: parseFloat(flat.gbp_to_ngn) || 2050,
        eur_to_ngn: parseFloat(flat.eur_to_ngn) || 1750,
        cad_to_ngn: parseFloat(flat.cad_to_ngn) || 1200,
        GHS: parseFloat(flat.fx_rate_GHS_NGN) || null,
        KES: parseFloat(flat.fx_rate_KES_NGN) || null,
        ZAR: parseFloat(flat.fx_rate_ZAR_NGN) || null,
        XAF: parseFloat(flat.fx_rate_XAF_NGN) || null,
        XOF: parseFloat(flat.fx_rate_XOF_NGN) || null,
        TZS: parseFloat(flat.fx_rate_TZS_NGN) || null,
        EGP: parseFloat(flat.fx_rate_EGP_NGN) || null,
        updated_at: flat.exchange_rate_updated_at || new Date().toISOString()
    };

    cache.data = parsed;
    cache.fetchedAt = Date.now();
    return parsed;
}

// ─── GET /api/rates/usd-ngn ───────────────────────────────────────────
// The frontend hits this to compute the USD-equivalent display for the
// multi-currency top-up flow.
router.get('/usd-ngn', async (req, res) => {
    try {
        const rates = await loadRates();
        res.json({
            success: true,
            data: {
                rate: rates.usd_to_ngn,
                updated_at: rates.updated_at
            }
        });
    } catch (e) {
        console.error('[RATES] usd-ngn error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── GET /api/rates/all ───────────────────────────────────────────────
// Convenience for any page that wants every rate at once.
router.get('/all', async (req, res) => {
    try {
        const rates = await loadRates();
        res.json({ success: true, data: rates });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── GET /api/rates/:pair  (e.g. /api/rates/GHS-NGN) ──────────────────
router.get('/:pair', async (req, res) => {
    try {
        const pair = String(req.params.pair || '').toUpperCase();
        const [from, to] = pair.split('-');
        if (!from || !to) {
            return res.status(400).json({ success: false, error: 'Use format FROM-TO, e.g. GHS-NGN' });
        }

        const rates = await loadRates();
        let rate = null;

        if (from === 'USD' && to === 'NGN') rate = rates.usd_to_ngn;
        else if (from === 'GBP' && to === 'NGN') rate = rates.gbp_to_ngn;
        else if (from === 'EUR' && to === 'NGN') rate = rates.eur_to_ngn;
        else if (from === 'CAD' && to === 'NGN') rate = rates.cad_to_ngn;
        else if (to === 'NGN' && rates[from] != null) rate = rates[from];

        if (!rate) {
            return res.status(404).json({ success: false, error: `No rate for ${pair}` });
        }

        res.json({
            success: true,
            data: { from, to, rate, updated_at: rates.updated_at }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;