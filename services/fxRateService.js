// services/fxRateService.js
// ─────────────────────────────────────────────────────────────────
// Single source of truth for deposit conversion.
//
// PRICING AUTHORITY:
//   • Rates, deposit fee, and wallet-credit math are driven by
//     adminSettingsService on every call. No local cache of
//     `deposit_currencies.customer_rate`.
//   • The deposit_currencies table still determines:
//       — is_enabled, min_amount, max_amount, wallet_currency,
//         display_name, symbol, minor_unit, country
//     Those are catalog metadata, not pricing.
//   • The rate used for each currency comes from the new admin
//     settings keys: `deposit_rate_<CCY>` (value = USD per 1 unit
//     of the payment currency).
//
// Contract (unchanged externally):
//   NGN   → NGN wallet, fee from admin settings.
//   GHS   → USD wallet at admin rate.
//   KES   → USD wallet at admin rate.
//   ZAR   → USD wallet at admin rate.
//   XAF   → USD wallet at admin rate.
//   XOF   → USD wallet at admin rate.
//   TZS   → USD wallet at admin rate.
//   EGP   → USD wallet at admin rate.
//
// Every conversion is snapshotted so a completed payment always
// credits the same amount that was quoted.
// ─────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const adminSettings = require('./adminSettingsService');

// deposit_currencies catalog metadata (enabled/min/max/wallet_currency/etc).
// Short cache is fine — those rarely change and are NOT pricing.
const CACHE_MS = 30 * 1000;
let _cfgCache = null;
let _cfgCacheAt = 0;

function invalidateFxCache() {
    _cfgCache = null;
    _cfgCacheAt = 0;
}

async function _loadCurrencyMap() {
    if (_cfgCache && Date.now() - _cfgCacheAt < CACHE_MS) return _cfgCache;

    const { data, error } = await supabaseAdmin
        .from('deposit_currencies')
        .select('*');

    if (error) throw error;

    const map = {};
    (data || []).forEach(r => { map[r.code] = r; });
    _cfgCache = map;
    _cfgCacheAt = Date.now();
    return map;
}

// Fetch the customer-facing rate from admin settings. Falls back
// to the deposit_currencies.customer_rate value ONLY if the
// admin setting has not been saved yet AND the DB row has one.
// Once the admin saves `deposit_rate_<CCY>`, that value wins.
async function _getCustomerRate(ccy) {
    const settingKey = `deposit_rate_${String(ccy).toUpperCase()}`;
    try {
        const raw = await adminSettings.getRaw(settingKey);
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n;
    } catch { /* fall through */ }

    // Fallback to the deposit_currencies column for smooth first-run.
    try {
        const map = await _loadCurrencyMap();
        const row = map[ccy];
        const n = Number(row?.customer_rate);
        if (Number.isFinite(n) && n > 0) return n;
    } catch { /* fall through */ }

    throw Object.assign(
        new Error(`No rate configured for ${ccy}. Set it in Settings → Rates.`),
        { code: 'FX_RATE_UNAVAILABLE' }
    );
}

async function getCurrencyConfig(code) {
    const ccy = String(code || '').toUpperCase();
    const map = await _loadCurrencyMap();
    const row = map[ccy];

    if (!row) throw Object.assign(new Error(`Unsupported currency: ${ccy}`), { code: 'UNSUPPORTED_CURRENCY' });
    if (!row.is_enabled) throw Object.assign(new Error(`Currency disabled: ${ccy}`), { code: 'UNSUPPORTED_CURRENCY' });
    if (!row.wallet_currency) throw Object.assign(new Error(`Currency ${ccy} misconfigured (wallet_currency missing)`), { code: 'CURRENCY_MISCONFIGURED' });

    // For non-NGN currencies we require a rate — sourced from admin
    // settings first, then the fallback column.
    if (ccy !== 'NGN') {
        const rate = await _getCustomerRate(ccy);
        if (!Number.isFinite(rate) || rate <= 0) {
            throw Object.assign(new Error(`Currency ${ccy} has no rate configured`), { code: 'CURRENCY_MISCONFIGURED' });
        }
        // Override row.customer_rate so downstream code reads the
        // admin-settings-driven value.
        return { ...row, customer_rate: rate };
    }

    return row;
}

function _minorUnit(cfg) {
    const mu = Number(cfg.minor_unit);
    return Number.isInteger(mu) && mu >= 0 && mu <= 8 ? mu : 2;
}

function _roundToMinor(value, minorUnit) {
    const factor = Math.pow(10, minorUnit);
    return Math.round(Number(value) * factor) / factor;
}

// Pull the deposit fee configuration from admin settings.
// Returns { feeType: 'NONE' | 'FIXED' | 'PERCENT', fixedNgn, pct, minNgn, maxNgn }.
async function _getDepositFeeConfig() {
    let flatNgn = 0;
    let pct = 0;
    let minNgn = 0;
    let maxNgn = Number.POSITIVE_INFINITY;

    try {
        const raw = await adminSettings.getRaw('deposit_fee_flat_ngn');
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) flatNgn = n;
    } catch { /* ignore */ }

    try {
        const raw = await adminSettings.getRaw('deposit_fee_pct');
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) pct = n;
    } catch { /* ignore */ }

    try {
        const raw = await adminSettings.getRaw('deposit_fee_min_ngn');
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) minNgn = n;
    } catch { /* ignore */ }

    try {
        const raw = await adminSettings.getRaw('deposit_fee_max_ngn');
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) maxNgn = n;
    } catch { /* ignore */ }

    // Fee type: percent if pct > 0, else fixed if flatNgn > 0, else none.
    let feeType = 'NONE';
    if (pct > 0) feeType = 'PERCENT';
    else if (flatNgn > 0) feeType = 'FIXED';

    return { feeType, flatNgn, pct, minNgn, maxNgn };
}

/**
 * Compute what the wallet credit will be.
 *
 * For NGN: fee comes from admin settings (fixed or percent, clamped
 * between min_ngn and max_ngn).
 * For non-NGN: rate from admin settings, no fee.
 */
async function computeDepositBreakdown(cfg, paymentAmount) {
    const amt = Number(paymentAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
        throw Object.assign(new Error('Invalid amount'), { code: 'INVALID_AMOUNT' });
    }

    const paymentCcy  = String(cfg.code).toUpperCase();
    const walletCcy   = String(cfg.wallet_currency).toUpperCase();
    const paymentMu   = _minorUnit(cfg);

    // ─── NGN: fee from admin settings, wallet = amount - fee ────
    if (paymentCcy === 'NGN' && walletCcy === 'NGN') {
        const feeCfg = await _getDepositFeeConfig();

        let feeAmt = 0;
        if (feeCfg.feeType === 'PERCENT') {
            feeAmt = amt * feeCfg.pct;
            if (feeCfg.minNgn > 0) feeAmt = Math.max(feeAmt, feeCfg.minNgn);
            if (Number.isFinite(feeCfg.maxNgn)) feeAmt = Math.min(feeAmt, feeCfg.maxNgn);
        } else if (feeCfg.feeType === 'FIXED') {
            feeAmt = feeCfg.flatNgn;
        }

        feeAmt = _roundToMinor(feeAmt, 2);

        if (amt <= feeAmt) {
            throw Object.assign(
                new Error(`Amount must be greater than the ₦${feeAmt.toFixed(2)} deposit fee`),
                { code: 'AMOUNT_TOO_LOW' }
            );
        }

        const net = _roundToMinor(amt - feeAmt, 2);

        return {
            payment_currency: paymentCcy,
            payment_amount:   _roundToMinor(amt, paymentMu),
            wallet_currency:  walletCcy,
            wallet_amount:    net,
            customer_rate:    null,
            gross_amount:     _roundToMinor(amt, paymentMu),
            fee_amount:       feeAmt,
            fee_currency:     'NGN',
            net_amount:       net,
            rate_type:        feeCfg.feeType === 'PERCENT' ? 'PERCENT' : (feeCfg.feeType === 'FIXED' ? 'FIXED' : 'NONE'),
            rate_source:      'ADMIN_SETTINGS'
        };
    }

    // ─── Foreign: rate = 1 unit payment = X USD ─────────────
    if (walletCcy !== 'USD') {
        throw Object.assign(
            new Error(`Currency ${paymentCcy} must settle into USD`),
            { code: 'CURRENCY_MISCONFIGURED' }
        );
    }

    const rate = Number(cfg.customer_rate);
    if (!Number.isFinite(rate) || rate <= 0) {
        throw Object.assign(new Error(`No rate configured for ${paymentCcy}`), { code: 'FX_RATE_UNAVAILABLE' });
    }

    const rawUsd    = amt * rate;
    const walletAmt = _roundToMinor(rawUsd, 2);

    if (walletAmt <= 0) {
        throw Object.assign(new Error('Computed wallet amount is below minimum'), { code: 'AMOUNT_TOO_LOW' });
    }

    return {
        payment_currency: paymentCcy,
        payment_amount:   _roundToMinor(amt, paymentMu),
        wallet_currency:  walletCcy,
        wallet_amount:    walletAmt,
        customer_rate:    rate,
        gross_amount:     _roundToMinor(amt, paymentMu),
        fee_amount:       0,
        fee_currency:     paymentCcy,
        net_amount:       walletAmt,
        rate_type:        'ADMIN_SETTINGS',
        rate_source:      'ADMIN_SETTINGS'
    };
}

/**
 * Persist a rate snapshot for the deposit. Returns the reference.
 */
async function lockDepositRate({ cfg, paymentAmount, breakdown }) {
    const reference = 'RATE-' + crypto.randomBytes(6).toString('hex').toUpperCase();

    if (String(cfg.code).toUpperCase() === 'NGN') {
        return { reference, snapshot: null };
    }

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
        .from('fx_rate_snapshots')
        .insert({
            from_currency:  cfg.code,
            to_currency:    'USD',
            raw_rate:       breakdown.customer_rate,
            effective_rate: breakdown.customer_rate,
            markup:         0,
            source:         'ADMIN_SETTINGS',
            reference,
            metadata: {
                payment_amount: breakdown.payment_amount,
                wallet_amount:  breakdown.wallet_amount
            },
            expires_at: expiresAt
        })
        .select()
        .single();

    if (error) throw error;
    return { reference, snapshot: data };
}

/**
 * Admin: update a currency's rate.
 *
 * Now writes to the admin settings (which audits + rate-history logs
 * automatically) AND leaves the legacy `deposit_currencies.customer_rate`
 * column intact (as a fallback). Callers using setCurrencyRate still
 * work unchanged.
 */
async function setCurrencyRate({ code, rate, changedBy = null, reason = null }) {
    const ccy = String(code || '').toUpperCase();
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0) {
        throw Object.assign(new Error('Rate must be a positive number'), { code: 'INVALID_RATE' });
    }

    const settingKey = `deposit_rate_${ccy}`;

    // Reject if the key isn't registered — protects against typos.
    const { KEY_REGISTRY } = adminSettings;
    if (!KEY_REGISTRY || !KEY_REGISTRY[settingKey]) {
        throw Object.assign(
            new Error(`Deposit rate for ${ccy} is not a registered admin setting.`),
            { code: 'UNSUPPORTED_CURRENCY' }
        );
    }

    // Save via adminSettings so audit + fx_rate_history fire.
    await adminSettings.patchSettings(
        { [settingKey]: String(r) },
        {
            adminId: changedBy || null,
            adminEmail: null,
            ip: null,
            userAgent: null,
            reason: reason || 'Manual update'
        }
    );

    // Also update the legacy column so raw SQL readers see consistency.
    try {
        await supabaseAdmin
            .from('deposit_currencies')
            .update({
                customer_rate: r,
                rate_type: 'MANUAL',
                rate_version: 1 + Number((await supabaseAdmin
                    .from('deposit_currencies')
                    .select('rate_version')
                    .eq('code', ccy)
                    .maybeSingle()).data?.rate_version || 0),
                updated_by: changedBy,
                updated_at: new Date().toISOString()
            })
            .eq('code', ccy);
    } catch (e) {
        console.warn('[fxRateService] could not sync legacy customer_rate:', e.message);
    }

    invalidateFxCache();
    return { code: ccy, rate: r };
}

module.exports = {
    getCurrencyConfig,
    computeDepositBreakdown,
    lockDepositRate,
    setCurrencyRate,
    invalidateFxCache
};