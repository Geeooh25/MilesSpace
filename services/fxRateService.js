// services/fxRateService.js
// Single source of truth for deposit conversion.
//
// Contract:
//   NGN   → NGN wallet, ₦50 fixed fee.
//   GHS   → USD wallet at admin rate.
//   KES   → USD wallet at admin rate.
//   ZAR   → USD wallet at admin rate.
//   XAF   → USD wallet at admin rate.
//   XOF   → USD wallet at admin rate.
//   TZS   → USD wallet at admin rate.
//   EGP   → USD wallet at admin rate.
//
// Rate direction is ALWAYS:
//   1 unit of payment currency = X USD
//
// Every conversion is snapshotted so a completed payment always
// credits the same amount that was quoted.

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');

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

async function getCurrencyConfig(code) {
    const ccy = String(code || '').toUpperCase();
    const map = await _loadCurrencyMap();
    const row = map[ccy];

    if (!row) throw Object.assign(new Error(`Unsupported currency: ${ccy}`), { code: 'UNSUPPORTED_CURRENCY' });
    if (!row.is_enabled) throw Object.assign(new Error(`Currency disabled: ${ccy}`), { code: 'UNSUPPORTED_CURRENCY' });
    if (!row.wallet_currency) throw Object.assign(new Error(`Currency ${ccy} misconfigured (wallet_currency missing)`), { code: 'CURRENCY_MISCONFIGURED' });

    if (ccy !== 'NGN') {
        const rate = Number(row.customer_rate);
        if (!Number.isFinite(rate) || rate <= 0) {
            throw Object.assign(new Error(`Currency ${ccy} has no rate configured`), { code: 'CURRENCY_MISCONFIGURED' });
        }
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

/**
 * Compute what the wallet credit will be.
 * Only wallet_amount is authoritative. Everything else is descriptive.
 */
function computeDepositBreakdown(cfg, paymentAmount) {
    const amt = Number(paymentAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
        throw Object.assign(new Error('Invalid amount'), { code: 'INVALID_AMOUNT' });
    }

    const paymentCcy  = String(cfg.code).toUpperCase();
    const walletCcy   = String(cfg.wallet_currency).toUpperCase();
    const paymentMu   = _minorUnit(cfg);

    // ─── NGN: fixed fee, wallet = amount - fee ─────────────
    if (paymentCcy === 'NGN' && walletCcy === 'NGN') {
        const feeType = String(cfg.deposit_fee_type || 'NONE').toUpperCase();
        const feeAmt  = feeType === 'FIXED' ? Number(cfg.deposit_fee || 0) : 0;

        if (amt <= feeAmt) {
            throw Object.assign(
                new Error(`Amount must be greater than the ₦${feeAmt} deposit fee`),
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
            rate_type:        'NONE',
            rate_source:      'NGN_FIXED_FEE'
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
        rate_type:        String(cfg.rate_type || 'MANUAL').toUpperCase(),
        rate_source:      'ADMIN'
    };
}

/**
 * Persist a rate snapshot for the deposit. Returns the reference.
 */
async function lockDepositRate({ cfg, paymentAmount, breakdown }) {
    const reference = 'RATE-' + crypto.randomBytes(6).toString('hex').toUpperCase();

    if (String(cfg.code).toUpperCase() === 'NGN') {
        // No rate to snapshot for NGN — the fee is the contract.
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
            source:         'ADMIN',
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
 * Admin: update a currency's rate + record history.
 */
async function setCurrencyRate({ code, rate, changedBy = null, reason = null }) {
    const ccy = String(code || '').toUpperCase();
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0) {
        throw Object.assign(new Error('Rate must be a positive number'), { code: 'INVALID_RATE' });
    }

    // Fetch current rate for history.
    const { data: current } = await supabaseAdmin
        .from('deposit_currencies')
        .select('customer_rate, wallet_currency')
        .eq('code', ccy)
        .maybeSingle();

    if (!current) {
        throw Object.assign(new Error(`Currency ${ccy} not found`), { code: 'UNSUPPORTED_CURRENCY' });
    }

    const { error: updErr } = await supabaseAdmin
        .from('deposit_currencies')
        .update({
            customer_rate: r,
            rate_type: 'MANUAL',
            rate_version: (Number(current.rate_version || 0) + 1),
            updated_by: changedBy,
            updated_at: new Date().toISOString()
        })
        .eq('code', ccy);

    if (updErr) throw updErr;

    await supabaseAdmin.from('currency_rate_history').insert({
        currency: ccy,
        target_currency: current.wallet_currency || 'USD',
        old_rate: current.customer_rate != null ? Number(current.customer_rate) : null,
        new_rate: r,
        changed_by: changedBy,
        reason: reason || 'Manual update'
    });

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