// services/adminSettingsService.js
// ─────────────────────────────────────────────────────────────────
// MILESSPACE SETTINGS — SINGLE SOURCE OF TRUTH
//
// This file is the ONLY authority for:
//   • reading/writing app_config settings
//   • validating and normalizing setting values
//   • FX rates and rate history
//   • service pricing markups
//   • deposit fees
//   • wallet/deposit limits
//   • service enable/disable gates
//   • provider enable/disable gates
//   • emergency operation gates
//   • maintenance mode
//   • audit logging
//   • health reporting
//
// It does NOT:
//   • touch ledger_accounts, transactions, wallet balances
//   • call providers
//   • price historical transactions
//
// Sections in this file, in order:
//   1.  Registry (KEY_REGISTRY)
//   2.  Section map (SECTION_KEYS)
//   3.  Service registry (SERVICE_REGISTRY)
//   4.  Provider registry (PROVIDER_REGISTRY)
//   5.  Defaults
//   6.  Validation & normalization
//   7.  Cache
//   8.  Reads
//   9.  Writes (patch, reset)
//   10. Pricing (calculatePrice)
//   11. FX (getRate, snapshot)
//   12. Services (isServiceEnabled, assertServiceEnabled)
//   13. Providers (isProviderEnabled, assertProviderEnabled)
//   14. Emergency (isOperationAllowed, assertOperationAllowed)
//   15. Audit & rate history
//   16. Health
//   17. Exports
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

// ═════════════════════════════════════════════════════════════════
// 1. KEY_REGISTRY — every writable setting
// ═════════════════════════════════════════════════════════════════
//
// shape:
//   'value'    — free string (length-capped)
//   'email'    — validated email
//   'url'      — validated URL
//   'int'      — integer, min/max
//   'decimal'  — number, decimals, min/max
//   'percent'  — number stored as decimal (15.7 → 0.157); decimals: 4
//   'boolean'  — strict true/false
//   'enum'     — one of values
//   'currency' — 3-letter ISO
//
// flags:
//   section     — which UI section this belongs to
//   financial   — pricing/FX/fee key; audit failure is fatal
//   dangerous   — requires a reason; supersensitive
//   secretRef   — env var name; never stored in DB, only rendered as
//                 "configured / not configured"

const KEY_REGISTRY = Object.freeze({
    // ─── General ─────────────────────────────────────────────
    platform_name:        { shape: 'value',   section: 'general', default: 'MilesSpace', maxLength: 60 },
    company_name:         { shape: 'value',   section: 'general', default: 'MilesSpace Digital Technology', maxLength: 120 },
    support_email:        { shape: 'email',   section: 'general', default: 'support@milesspace.com' },
    support_phone:        { shape: 'value',   section: 'general', default: '+234 800 000 0000', maxLength: 30 },
    website_url:          { shape: 'url',     section: 'general', default: 'https://milesspace.com' },
    default_currency:     { shape: 'enum',    section: 'general', default: 'NGN', values: ['NGN', 'USD'] },
    timezone:             { shape: 'enum',    section: 'general', default: 'Africa/Lagos',
                            values: ['Africa/Lagos', 'UTC', 'Europe/London', 'America/New_York'] },
    maintenance_mode:     { shape: 'boolean', section: 'general', default: 'false' },
    maintenance_message:  { shape: 'value',   section: 'general', maxLength: 500,
                            default: 'MilesSpace is currently undergoing scheduled maintenance. Please try again later.' },

    // ─── FX rates ────────────────────────────────────────────
    usd_to_ngn: { shape: 'decimal', section: 'rates', default: '1600', min: 1, max: 1_000_000, decimals: 2, financial: true, dangerous: true },
    ghs_to_ngn: { shape: 'decimal', section: 'rates', default: '0',    min: 0, max: 1_000_000, decimals: 4, financial: true, dangerous: true },
    kes_to_ngn: { shape: 'decimal', section: 'rates', default: '0',    min: 0, max: 1_000_000, decimals: 4, financial: true, dangerous: true },
    zar_to_ngn: { shape: 'decimal', section: 'rates', default: '0',    min: 0, max: 1_000_000, decimals: 4, financial: true, dangerous: true },
    xof_to_ngn: { shape: 'decimal', section: 'rates', default: '0',    min: 0, max: 1_000_000, decimals: 6, financial: true, dangerous: true },
    xaf_to_ngn: { shape: 'decimal', section: 'rates', default: '0',    min: 0, max: 1_000_000, decimals: 6, financial: true, dangerous: true },
    tzs_to_ngn: { shape: 'decimal', section: 'rates', default: '0',    min: 0, max: 1_000_000, decimals: 4, financial: true, dangerous: true },
    egp_to_ngn: { shape: 'decimal', section: 'rates', default: '0',    min: 0, max: 1_000_000, decimals: 4, financial: true, dangerous: true },

    giftcard_wholesale_currency: { shape: 'currency', section: 'rates', default: 'NGN' },

    // ─── Fees ────────────────────────────────────────────────
    deposit_fee_flat_ngn: { shape: 'decimal', section: 'fees', default: '50',   min: 0, max: 100_000,     decimals: 2, financial: true },
    deposit_fee_pct:      { shape: 'percent', section: 'fees', default: '0',    min: 0, max: 0.10,        decimals: 4, financial: true },
    deposit_fee_min_ngn:  { shape: 'decimal', section: 'fees', default: '50',   min: 0, max: 1_000_000,   decimals: 2, financial: true },
    deposit_fee_max_ngn:  { shape: 'decimal', section: 'fees', default: '2000', min: 0, max: 10_000_000,  decimals: 2, financial: true },

    // ─── Service pricing markups ─────────────────────────────
    giftcard_markup_pct_usd:  { shape: 'percent', section: 'pricing', default: '0.1570', min: 0, max: 0.90, decimals: 4, financial: true },
    giftcard_markup_pct_ngn:  { shape: 'percent', section: 'pricing', default: '0.1570', min: 0, max: 0.90, decimals: 4, financial: true },
    esim_markup_pct_usd:      { shape: 'percent', section: 'pricing', default: '0.1500', min: 0, max: 0.90, decimals: 4, financial: true },
    esim_markup_pct_ngn:      { shape: 'percent', section: 'pricing', default: '0.1500', min: 0, max: 0.90, decimals: 4, financial: true },
    airtime_markup_pct_usd:   { shape: 'percent', section: 'pricing', default: '0.0500', min: 0, max: 0.90, decimals: 4, financial: true },
    airtime_markup_pct_ngn:   { shape: 'percent', section: 'pricing', default: '0.0500', min: 0, max: 0.90, decimals: 4, financial: true },
    boost_markup_pct:         { shape: 'percent', section: 'pricing', default: '0.1800', min: 0, max: 0.90, decimals: 4, financial: true },
    marketplace_markup_pct:   { shape: 'percent', section: 'pricing', default: '0.2000', min: 0, max: 0.90, decimals: 4, financial: true },
    virtual_sms_markup_pct:   { shape: 'percent', section: 'pricing', default: '0.1500', min: 0, max: 0.90, decimals: 4, financial: true },
    crypto_markup_pct:        { shape: 'percent', section: 'pricing', default: '0.0800', min: 0, max: 0.90, decimals: 4, financial: true },
    cashback_rate_pct:        { shape: 'percent', section: 'pricing', default: '0.0500', min: 0, max: 0.50, decimals: 4, financial: true },

    // ─── Wallet & deposits ───────────────────────────────────
    min_deposit_ngn:         { shape: 'decimal', section: 'wallet', default: '1000',    min: 0, max: 1_000_000_000, decimals: 2, financial: true },
    max_deposit_ngn:         { shape: 'decimal', section: 'wallet', default: '5000000', min: 0, max: 1_000_000_000, decimals: 2, financial: true },
    daily_deposit_limit_ngn: { shape: 'decimal', section: 'wallet', default: '10000000', min: 0, max: 1_000_000_000, decimals: 2, financial: true },

    // ─── Transaction limits ──────────────────────────────────
    giftcard_min_trade_ngn: { shape: 'decimal', section: 'limits', default: '5000',    min: 0, max: 1_000_000_000, decimals: 2 },
    giftcard_max_trade_ngn: { shape: 'decimal', section: 'limits', default: '1000000', min: 0, max: 1_000_000_000, decimals: 2 },
    airtime_min_ngn:        { shape: 'decimal', section: 'limits', default: '50',      min: 0, max: 1_000_000,     decimals: 2 },
    airtime_max_ngn:        { shape: 'decimal', section: 'limits', default: '100000',  min: 0, max: 1_000_000_000, decimals: 2 },
    esim_min_ngn:           { shape: 'decimal', section: 'limits', default: '5000',    min: 0, max: 1_000_000_000, decimals: 2 },
    esim_max_ngn:           { shape: 'decimal', section: 'limits', default: '500000',  min: 0, max: 1_000_000_000, decimals: 2 },
    virtual_sms_min_ngn:    { shape: 'decimal', section: 'limits', default: '500',     min: 0, max: 100_000_000,   decimals: 2 },
    virtual_sms_max_ngn:    { shape: 'decimal', section: 'limits', default: '100000',  min: 0, max: 1_000_000_000, decimals: 2 },
    boost_min_ngn:          { shape: 'decimal', section: 'limits', default: '1000',    min: 0, max: 1_000_000_000, decimals: 2 },
    boost_max_ngn:          { shape: 'decimal', section: 'limits', default: '1000000', min: 0, max: 1_000_000_000, decimals: 2 },

    // ─── Service flags ───────────────────────────────────────
    service_giftcards_enabled:     { shape: 'boolean', section: 'services', default: 'true'  },
    service_airtime_enabled:       { shape: 'boolean', section: 'services', default: 'true'  },
    service_bills_enabled:         { shape: 'boolean', section: 'services', default: 'true'  },
    service_esim_enabled:          { shape: 'boolean', section: 'services', default: 'true'  },
    service_virtual_sms_enabled:   { shape: 'boolean', section: 'services', default: 'true'  },
    service_boost_enabled:         { shape: 'boolean', section: 'services', default: 'true'  },
    service_marketplace_enabled:   { shape: 'boolean', section: 'services', default: 'true'  },
    service_crypto_enabled:        { shape: 'boolean', section: 'services', default: 'false' },
    service_virtual_cards_enabled: { shape: 'boolean', section: 'services', default: 'false' },
    service_withdrawals_enabled:   { shape: 'boolean', section: 'services', default: 'false' },
    service_kyc_enabled:           { shape: 'boolean', section: 'services', default: 'false' },

    // ─── Provider gates ──────────────────────────────────────
    provider_kora_enabled:        { shape: 'boolean', section: 'providers', default: 'true'  },
    provider_kora_maintenance:    { shape: 'boolean', section: 'providers', default: 'false' },
    provider_kora_timeout_ms:     { shape: 'int',     section: 'providers', default: '20000', min: 1000, max: 120000 },
    provider_kora_retry_count:    { shape: 'int',     section: 'providers', default: '2',     min: 0,    max: 5 },

    provider_nowpayments_enabled:     { shape: 'boolean', section: 'providers', default: 'true'  },
    provider_nowpayments_maintenance: { shape: 'boolean', section: 'providers', default: 'false' },
    provider_nowpayments_timeout_ms:  { shape: 'int',     section: 'providers', default: '20000', min: 1000, max: 120000 },

    provider_vtpass_enabled:      { shape: 'boolean', section: 'providers', default: 'true'  },
    provider_vtpass_maintenance:  { shape: 'boolean', section: 'providers', default: 'false' },
    provider_vtpass_timeout_ms:   { shape: 'int',     section: 'providers', default: '20000', min: 1000, max: 120000 },

    provider_dtone_enabled:       { shape: 'boolean', section: 'providers', default: 'true'  },
    provider_dtone_maintenance:   { shape: 'boolean', section: 'providers', default: 'false' },
    provider_dtone_timeout_ms:    { shape: 'int',     section: 'providers', default: '20000', min: 1000, max: 120000 },

    // ─── Notifications ───────────────────────────────────────
    notify_deposit_success:               { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_deposit_failed:                { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_purchase_success:              { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_purchase_failed:               { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_refund_completed:              { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_login_alert:                   { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_password_changed:              { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_2fa_enabled:                   { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_admin_webhook_failure:         { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_admin_provider_outage:         { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_admin_large_deposit:           { shape: 'boolean', section: 'notifications', default: 'true' },
    notify_admin_reconciliation_mismatch: { shape: 'boolean', section: 'notifications', default: 'true' },

    // ─── Security ────────────────────────────────────────────
    session_timeout_hours: { shape: 'int',     section: 'security', default: '8', min: 1, max: 168 },
    failed_login_attempts: { shape: 'int',     section: 'security', default: '5', min: 3, max: 20 },
    require_2fa:           { shape: 'boolean', section: 'security', default: 'true'  },
    email_verification:    { shape: 'boolean', section: 'security', default: 'true'  },

    // ─── Emergency ───────────────────────────────────────────
    emergency_stop_deposits:         { shape: 'boolean', section: 'emergency', default: 'false', dangerous: true },
    emergency_stop_purchases:        { shape: 'boolean', section: 'emergency', default: 'false', dangerous: true },
    emergency_stop_provider_requests:{ shape: 'boolean', section: 'emergency', default: 'false', dangerous: true },
    emergency_stop_wallet_mutations: { shape: 'boolean', section: 'emergency', default: 'false', dangerous: true },

    // ─── Config version ──────────────────────────────────────
    config_version: { shape: 'int', section: 'internal', default: '1', min: 1, max: 9_999_999_999 }
});

// ═════════════════════════════════════════════════════════════════
// 2. SECTION_KEYS — which keys each UI section owns
// ═════════════════════════════════════════════════════════════════

const SECTION_KEYS = (() => {
    const map = {};
    for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
        const s = spec.section || 'general';
        if (!map[s]) map[s] = [];
        map[s].push(key);
    }
    return Object.freeze(map);
})();

// ═════════════════════════════════════════════════════════════════
// 3. SERVICE_REGISTRY — every service actually in the repo
// ═════════════════════════════════════════════════════════════════

const SERVICE_REGISTRY = Object.freeze({
    giftcards:    { label: 'Gift Cards',       enabledKey: 'service_giftcards_enabled' },
    airtime:      { label: 'Airtime & Data',   enabledKey: 'service_airtime_enabled' },
    bills:        { label: 'Bills & Utilities', enabledKey: 'service_bills_enabled' },
    esim:         { label: 'eSIM',             enabledKey: 'service_esim_enabled' },
    virtual_sms:  { label: 'Virtual SMS',      enabledKey: 'service_virtual_sms_enabled' },
    boost:        { label: 'Boost',            enabledKey: 'service_boost_enabled' },
    marketplace:  { label: 'Marketplace',      enabledKey: 'service_marketplace_enabled' },
    crypto:       { label: 'Crypto',           enabledKey: 'service_crypto_enabled' },
    virtual_cards: { label: 'Virtual Cards',   enabledKey: 'service_virtual_cards_enabled' },
    withdrawals:  { label: 'Withdrawals',      enabledKey: 'service_withdrawals_enabled' },
    kyc:          { label: 'KYC',              enabledKey: 'service_kyc_enabled' }
});

// ═════════════════════════════════════════════════════════════════
// 4. PROVIDER_REGISTRY — providers actually in the repo
// ═════════════════════════════════════════════════════════════════
//
// secretEnv: the env var(s) that must be present. Values are NEVER
// read into app_config or returned to the frontend — only the
// boolean "configured" flag is derived from process.env here.

const PROVIDER_REGISTRY = Object.freeze({
    kora: {
        label: 'KoraPay',
        enabledKey:     'provider_kora_enabled',
        maintenanceKey: 'provider_kora_maintenance',
        timeoutKey:     'provider_kora_timeout_ms',
        retryKey:       'provider_kora_retry_count',
        secretEnv:      ['KORA_SECRET_KEY', 'KORA_PUBLIC_KEY']
    },
    nowpayments: {
        label: 'NowPayments',
        enabledKey:     'provider_nowpayments_enabled',
        maintenanceKey: 'provider_nowpayments_maintenance',
        timeoutKey:     'provider_nowpayments_timeout_ms',
        secretEnv:      ['NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET']
    },
    vtpass: {
        label: 'VTpass',
        enabledKey:     'provider_vtpass_enabled',
        maintenanceKey: 'provider_vtpass_maintenance',
        timeoutKey:     'provider_vtpass_timeout_ms',
        secretEnv:      ['VTPASS_API_KEY', 'VTPASS_PUBLIC_KEY', 'VTPASS_SECRET_KEY']
    },
    dtone: {
        label: 'DT One',
        enabledKey:     'provider_dtone_enabled',
        maintenanceKey: 'provider_dtone_maintenance',
        timeoutKey:     'provider_dtone_timeout_ms',
        secretEnv:      ['DTONE_API_KEY', 'DTONE_API_SECRET', 'DTONE_WEBHOOK_SECRET']
    }
});

// ═════════════════════════════════════════════════════════════════
// 5. DEFAULTS
// ═════════════════════════════════════════════════════════════════

const ALL_KEYS = Object.keys(KEY_REGISTRY);

// ═════════════════════════════════════════════════════════════════
// 6. VALIDATION & NORMALIZATION
// ═════════════════════════════════════════════════════════════════

function validationError(code, message, extra = {}) {
    const e = new Error(message);
    e.status = 422;
    e.code = code;
    Object.assign(e, extra);
    return e;
}

function normalize(key, rawValue) {
    const spec = KEY_REGISTRY[key];
    if (!spec) {
        throw validationError('UNKNOWN_SETTING_KEY', `Unknown setting key: ${key}`, { key });
    }

    switch (spec.shape) {
        case 'boolean': {
            if (rawValue === true  || rawValue === 'true'  || rawValue === 1 || rawValue === '1')  return 'true';
            if (rawValue === false || rawValue === 'false' || rawValue === 0 || rawValue === '0')  return 'false';
            throw validationError('INVALID_BOOLEAN', `${key} must be true or false`, { key });
        }

        case 'int': {
            if (rawValue === '' || rawValue === null || rawValue === undefined) {
                throw validationError('INVALID_INT', `${key} must be an integer`, { key });
            }
            const n = Number(rawValue);
            if (!Number.isInteger(n) || !Number.isFinite(n)) {
                throw validationError('INVALID_INT', `${key} must be an integer`, { key });
            }
            if (n < spec.min || n > spec.max) {
                throw validationError('OUT_OF_RANGE', `${key} must be between ${spec.min} and ${spec.max}`, { key, min: spec.min, max: spec.max });
            }
            return String(n);
        }

        case 'decimal': {
            if (rawValue === '' || rawValue === null || rawValue === undefined) {
                throw validationError('INVALID_NUMBER', `${key} must be a number`, { key });
            }
            const n = Number(rawValue);
            if (!Number.isFinite(n)) {
                throw validationError('INVALID_NUMBER', `${key} must be a number`, { key });
            }
            if (n < spec.min || n > spec.max) {
                throw validationError('OUT_OF_RANGE', `${key} must be between ${spec.min} and ${spec.max}`, { key, min: spec.min, max: spec.max });
            }
            return n.toFixed(spec.decimals);
        }

        case 'percent': {
            if (rawValue === '' || rawValue === null || rawValue === undefined) {
                throw validationError('INVALID_PERCENT', `${key} must be a number`, { key });
            }
            let n = Number(rawValue);
            if (!Number.isFinite(n)) {
                throw validationError('INVALID_PERCENT', `${key} must be a number`, { key });
            }
            // Frontend sends 15.7 to mean 15.7%. Values > 1 are treated as percent.
            // Values ≤ 1 are already decimals. This is the documented rule.
            if (n > 1) n = n / 100;
            if (n < spec.min || n > spec.max) {
                throw validationError('OUT_OF_RANGE', `${key} must be between ${spec.min} and ${spec.max} (as a decimal)`, { key, min: spec.min, max: spec.max });
            }
            return n.toFixed(spec.decimals);
        }

        case 'currency': {
            const s = String(rawValue || '').trim().toUpperCase();
            if (!/^[A-Z]{3}$/.test(s)) {
                throw validationError('INVALID_CURRENCY', `${key} must be a 3-letter ISO currency code`, { key });
            }
            return s;
        }

        case 'email': {
            const s = String(rawValue || '').trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 200) {
                throw validationError('INVALID_EMAIL', `${key} must be a valid email address`, { key });
            }
            return s;
        }

        case 'url': {
            const s = String(rawValue || '').trim();
            try {
                const u = new URL(s);
                if (!/^https?:$/.test(u.protocol) || s.length > 500) throw new Error('bad');
                return s;
            } catch {
                throw validationError('INVALID_URL', `${key} must be a valid http(s) URL`, { key });
            }
        }

        case 'enum': {
            const s = String(rawValue);
            if (!spec.values.includes(s)) {
                throw validationError('INVALID_ENUM', `${key} must be one of: ${spec.values.join(', ')}`, { key, allowed: spec.values });
            }
            return s;
        }

        case 'value':
        default: {
            const s = String(rawValue == null ? '' : rawValue);
            if (spec.maxLength && s.length > spec.maxLength) {
                throw validationError('TOO_LONG', `${key} must be at most ${spec.maxLength} characters`, { key, maxLength: spec.maxLength });
            }
            return s;
        }
    }
}

// Cross-field validation. Throws on the first violation.
function validateCrossField(mergedPatch) {
    const num = (k) => {
        const v = mergedPatch[k];
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const cmp = (aKey, bKey, label) => {
        const a = num(aKey), b = num(bKey);
        if (a === null || b === null) return;
        if (a > b) {
            throw validationError('CROSS_FIELD_INVALID', `${label}: ${aKey} (${a}) must be ≤ ${bKey} (${b})`, { aKey, bKey });
        }
    };

    cmp('min_deposit_ngn',         'max_deposit_ngn',              'Deposit range');
    cmp('max_deposit_ngn',         'daily_deposit_limit_ngn',      'Daily limit');
    cmp('deposit_fee_min_ngn',     'deposit_fee_max_ngn',          'Deposit fee range');
    cmp('giftcard_min_trade_ngn',  'giftcard_max_trade_ngn',       'Gift card range');
    cmp('airtime_min_ngn',         'airtime_max_ngn',              'Airtime range');
    cmp('esim_min_ngn',            'esim_max_ngn',                 'eSIM range');
    cmp('virtual_sms_min_ngn',     'virtual_sms_max_ngn',          'Virtual SMS range');
    cmp('boost_min_ngn',           'boost_max_ngn',                'Boost range');
}

// ═════════════════════════════════════════════════════════════════
// 7. CACHE
// ═════════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 45 * 1000;

const _cache = {
    raw: null,          // { key: storedStringValue }
    fetchedAt: 0,
    promise: null
};

function invalidateCache() {
    _cache.raw = null;
    _cache.fetchedAt = 0;
}

async function readRawFromDb() {
    const { data, error } = await supabaseAdmin
        .from('app_config')
        .select('key, value')
        .in('key', ALL_KEYS);

    if (error) {
        const e = new Error(`Failed to read app_config: ${error.message}`);
        e.status = 503;
        e.code = 'SETTINGS_READ_FAILED';
        throw e;
    }

    const raw = {};
    for (const row of data || []) raw[row.key] = row.value;
    return raw;
}

/**
 * Returns the raw app_config map, filling in registry defaults for
 * keys that don't exist yet. Defaults here are for DISPLAY and
 * FIRST-RUN seeding only. Once a financial key exists in the DB,
 * it is never silently replaced by its default.
 */
async function getRawCached({ force = false } = {}) {
    if (!force && _cache.raw && (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS) {
        return _cache.raw;
    }
    if (_cache.promise) return _cache.promise;

    _cache.promise = (async () => {
        try {
            const stored = await readRawFromDb();
            const merged = {};
            for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
                merged[key] = stored[key] !== undefined ? stored[key] : spec.default;
            }
            _cache.raw = merged;
            _cache.fetchedAt = Date.now();
            return merged;
        } finally {
            _cache.promise = null;
        }
    })();

    return _cache.promise;
}

// ═════════════════════════════════════════════════════════════════
// 8. READS
// ═════════════════════════════════════════════════════════════════

function displayValue(spec, raw) {
    switch (spec.shape) {
        case 'boolean': {
            return raw === true || raw === 'true' || raw === '1' || raw === 1;
        }
        case 'int': {
            const n = parseInt(raw, 10);
            return Number.isFinite(n) ? n : parseInt(spec.default, 10);
        }
        case 'decimal':
        case 'percent': {
            const n = Number(raw);
            return Number.isFinite(n) ? n : Number(spec.default);
        }
        default:
            return raw == null ? '' : raw;
    }
}

/**
 * Flat object keyed by setting name, with JS-typed values.
 */
async function getAllSettings() {
    const raw = await getRawCached();
    const out = {};
    for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
        out[key] = displayValue(spec, raw[key]);
    }
    return out;
}

/**
 * Sectioned object keyed by section name.
 */
async function getSettingsBySectionAll() {
    const flat = await getAllSettings();
    const out = {};
    for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
        const s = spec.section || 'general';
        if (!out[s]) out[s] = {};
        out[s][key] = flat[key];
    }
    return out;
}

async function getSection(section) {
    const all = await getSettingsBySectionAll();
    if (!all[section]) {
        const e = new Error(`Unknown section: ${section}`);
        e.status = 404;
        e.code = 'UNKNOWN_SECTION';
        throw e;
    }
    return all[section];
}

async function getRaw(key) {
    const spec = KEY_REGISTRY[key];
    if (!spec) return undefined;
    const raw = await getRawCached();
    return raw[key];
}

async function getNumber(key) {
    const v = await getRaw(key);
    const n = Number(v);
    if (!Number.isFinite(n)) {
        const e = new Error(`Setting ${key} is not a finite number`);
        e.status = 503;
        e.code = 'CONFIG_NOT_READY';
        e.key = key;
        throw e;
    }
    return n;
}

async function getBoolean(key) {
    const v = await getRaw(key);
    return v === true || v === 'true' || v === '1' || v === 1;
}

async function getString(key) {
    const v = await getRaw(key);
    return v == null ? '' : String(v);
}

// ═════════════════════════════════════════════════════════════════
// 9. WRITES
// ═════════════════════════════════════════════════════════════════

async function readStoredRaw(keys) {
    if (!keys.length) return {};
    const { data, error } = await supabaseAdmin
        .from('app_config')
        .select('key, value')
        .in('key', keys);
    if (error) {
        const e = new Error(`Failed to read app_config: ${error.message}`);
        e.status = 503;
        e.code = 'SETTINGS_READ_FAILED';
        throw e;
    }
    const out = {};
    for (const row of data || []) out[row.key] = row.value;
    return out;
}

function buildContext(req, { reason = null } = {}) {
    return {
        adminId:    req?.adminContext?.id    || null,
        adminEmail: req?.adminContext?.email || null,
        ip:         req?.ip || req?.headers?.['x-forwarded-for'] || null,
        userAgent:  req?.headers?.['user-agent'] || null,
        reason:     reason ? String(reason).slice(0, 500) : null
    };
}

function requiresReason(keys) {
    return keys.some(k => KEY_REGISTRY[k]?.financial || KEY_REGISTRY[k]?.dangerous);
}

/**
 * patchSettings(patch, ctx)
 *
 *   patch — { key: rawValue, ... }
 *   ctx   — { adminId, adminEmail, ip, userAgent, reason }
 *
 * Returns { updated: [key], unchanged: [key] }.
 * Throws on the first validation error. No partial writes for invalid input.
 */
async function patchSettings(patch, ctx = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw validationError('INVALID_PATCH', 'patch must be an object');
    }

    // Strip non-settings control fields.
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
        if (k === 'reason') continue;
        clean[k] = v;
    }
    if (!Object.keys(clean).length) {
        throw validationError('EMPTY_PATCH', 'No settings to update');
    }

    // 1. Normalize every key.
    const normalized = {};
    for (const [key, rawValue] of Object.entries(clean)) {
        normalized[key] = normalize(key, rawValue);
    }

    // 2. Cross-field validation against existing values.
    const existing = await getRawCached();
    const merged = { ...existing, ...normalized };
    validateCrossField(merged);

    // 3. Reason required for financial/dangerous keys.
    const touchedKeys = Object.keys(normalized);
    if (requiresReason(touchedKeys)) {
        if (!ctx.reason || String(ctx.reason).trim().length < 3) {
            throw validationError('REASON_REQUIRED', 'A reason is required for this change', { keys: touchedKeys });
        }
    }

    // 4. Diff against stored values.
    const stored = await readStoredRaw(touchedKeys);
    const now = new Date().toISOString();
    const toWrite = [];
    const changed = [];
    const unchanged = [];

    for (const [key, value] of Object.entries(normalized)) {
        const before = stored[key];
        if (before !== undefined && String(before) === String(value)) {
            unchanged.push(key);
            continue;
        }
        toWrite.push({ key, value, updated_at: now, previous_value: before ?? null });
        changed.push(key);
    }

    if (!toWrite.length) {
        return { updated: [], unchanged };
    }

    // 5. Bump config version when any key changes.
    const currentVersion = Number(existing.config_version || '1');
    const nextVersion = String(currentVersion + 1);
    const versionRow = {
        key: 'config_version',
        value: nextVersion,
        updated_at: now,
        previous_value: String(currentVersion)
    };
    const payload = [
        ...toWrite.map(r => ({ key: r.key, value: r.value, updated_at: r.updated_at })),
        { key: 'config_version', value: nextVersion, updated_at: now }
    ];

    // 6. Write first, then audit. If audit fails for a financial key,
    //    we roll back by restoring the previous values.
    const { error: writeError } = await supabaseAdmin
        .from('app_config')
        .upsert(payload, { onConflict: 'key' });

    if (writeError) {
        const e = new Error(`Failed to write app_config: ${writeError.message}`);
        e.status = 503;
        e.code = 'SETTINGS_WRITE_FAILED';
        throw e;
    }

    // 7. Audit. Financial-key audit failures roll back the write.
    const auditOk = await writeAudit(toWrite, ctx);
    const touchesFinancial = toWrite.some(r => KEY_REGISTRY[r.key]?.financial);

    if (!auditOk && touchesFinancial) {
        // Roll back.
        const rollbackRows = toWrite
            .filter(r => r.previous_value !== null)
            .map(r => ({ key: r.key, value: r.previous_value, updated_at: new Date().toISOString() }));
        try {
            await supabaseAdmin.from('app_config').upsert(rollbackRows, { onConflict: 'key' });
        } catch (rbErr) {
            console.error('[adminSettings] rollback after audit failure failed:', rbErr.message);
        }
        invalidateCache();
        const e = new Error('Audit logging failed. Financial settings change was rolled back.');
        e.status = 500;
        e.code = 'AUDIT_FAILED_ROLLBACK';
        throw e;
    }

    // 8. Rate history for FX/markup keys.
    await writeRateHistory(toWrite, ctx);

    // 9. Invalidate cache so the next read sees the new values.
    invalidateCache();

    // 10. Return.
    return {
        updated: changed,
        unchanged,
        version: nextVersion
    };
}

async function resetSection(section, ctx = {}) {
    if (!SECTION_KEYS[section]) {
        const e = new Error(`Unknown section: ${section}`);
        e.status = 404;
        e.code = 'UNKNOWN_SECTION';
        throw e;
    }
    const patch = {};
    for (const key of SECTION_KEYS[section]) {
        const spec = KEY_REGISTRY[key];
        if (!spec) continue;
        // Send the registry default as the raw target. patchSettings will
        // normalize it, so a string like 'true' becomes 'true' and
        // '0.1570' stays a decimal.
        patch[key] = spec.default;
    }
    return patchSettings(patch, { ...ctx, reason: ctx.reason || `Reset ${section}` });
}

async function resetAll(ctx = {}) {
    // Guard at route layer too, but enforce here as well.
    const patch = {};
    for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
        if (key === 'config_version') continue; // never reset the counter itself
        patch[key] = spec.default;
    }
    return patchSettings(patch, { ...ctx, reason: ctx.reason || 'Reset all settings' });
}

// ═════════════════════════════════════════════════════════════════
// 10. PRICING
// ═════════════════════════════════════════════════════════════════
//
// calculatePrice({
//   service: 'giftcard',        // must match a suffix in the registry
//   currency: 'NGN' | 'USD',
//   wholesaleAmount: 10000      // in the given currency
// })
//
// Returns decimal strings for all money fields.

function toCents(v) {
    const s = String(v);
    const neg = s.startsWith('-');
    const [i, f = ''] = s.replace('-', '').split('.');
    const frac = (f + '00').slice(0, 2);
    return (neg ? -1n : 1n) * (BigInt(i || '0') * 100n + BigInt(frac || '0'));
}
function fromCents(c) {
    const neg = c < 0n;
    const abs = neg ? -c : c;
    return (neg ? '-' : '') + (abs / 100n).toString() + '.' + (abs % 100n).toString().padStart(2, '0');
}

async function getMarkup(service, currency) {
    const svc = String(service || '').toLowerCase();
    const cur = String(currency || '').toUpperCase() === 'NGN' ? 'ngn' : 'usd';
    const dualKey = `${svc}_markup_pct_${cur}`;
    const singleKey = `${svc}_markup_pct`;

    let key = null;
    if (KEY_REGISTRY[dualKey]) key = dualKey;
    else if (KEY_REGISTRY[singleKey]) key = singleKey;

    if (!key) {
        const e = new Error(`No markup configured for service=${svc} currency=${cur}`);
        e.status = 400;
        e.code = 'MARKUP_NOT_CONFIGURED';
        throw e;
    }
    const n = await getNumber(key);
    if (n < 0 || n > 1) {
        const e = new Error(`Markup for ${svc}/${cur} is out of range: ${n}`);
        e.status = 503;
        e.code = 'MARKUP_INVALID';
        throw e;
    }
    return n;
}

async function getRate(sourceCurrency, targetCurrency) {
    const src = String(sourceCurrency || '').toUpperCase();
    const tgt = String(targetCurrency || '').toUpperCase();
    if (src === tgt) return 1;

    if (src === 'USD' && tgt === 'NGN') {
        const n = await getNumber('usd_to_ngn');
        if (!(n > 0)) {
            const e = new Error('usd_to_ngn is not configured');
            e.status = 503;
            e.code = 'RATE_NOT_CONFIGURED';
            throw e;
        }
        return n;
    }

    if (tgt === 'NGN') {
        const key = `${src.toLowerCase()}_to_ngn`;
        if (!KEY_REGISTRY[key]) {
            const e = new Error(`No configured rate from ${src} to NGN`);
            e.status = 400;
            e.code = 'RATE_NOT_CONFIGURED';
            throw e;
        }
        const n = await getNumber(key);
        if (!(n > 0)) {
            const e = new Error(`${key} is not configured`);
            e.status = 503;
            e.code = 'RATE_NOT_CONFIGURED';
            throw e;
        }
        return n;
    }

    const e = new Error(`Unsupported rate pair: ${src} -> ${tgt}`);
    e.status = 400;
    e.code = 'RATE_NOT_CONFIGURED';
    throw e;
}

/**
 * Calculates the customer-facing price for a wholesale amount.
 *
 *   customerPrice = wholesale * (1 + markup)
 *
 * Uses integer cents for the arithmetic so the result matches what
 * Postgres NUMERIC would produce. All amounts are returned as
 * 2-decimal strings.
 */
async function calculatePrice({ service, currency = 'NGN', wholesaleAmount }) {
    if (!service) {
        const e = new Error('service is required');
        e.status = 400;
        e.code = 'INVALID_INPUT';
        throw e;
    }
    if (wholesaleAmount === undefined || wholesaleAmount === null) {
        const e = new Error('wholesaleAmount is required');
        e.status = 400;
        e.code = 'INVALID_INPUT';
        throw e;
    }

    const cur = String(currency).toUpperCase();
    const wholesaleCents = toCents(wholesaleAmount);
    const markup = await getMarkup(service, cur);
    const markupBps = BigInt(Math.round(markup * 10_000));

    const customerCents = (wholesaleCents * (10_000n + markupBps)) / 10_000n;
    const profitCents   = customerCents - wholesaleCents;

    const wholesaleStr = fromCents(wholesaleCents);
    const customerStr  = fromCents(customerCents);
    const profitStr    = fromCents(profitCents);

    const version = Number(await getRaw('config_version') || '1');

    return {
        service: service,
        currency: cur,
        wholesaleAmount: wholesaleStr,
        markup,
        customerPrice: customerStr,
        profit: profitStr,
        pricingVersion: version
    };
}

async function getFee(type) {
    const t = String(type || '').toLowerCase();
    if (t !== 'deposit') {
        const e = new Error(`Unknown fee type: ${type}`);
        e.status = 400;
        e.code = 'INVALID_FEE_TYPE';
        throw e;
    }
    return {
        flatNgn:  fromCents(toCents(await getRaw('deposit_fee_flat_ngn'))),
        pct:      Number(await getRaw('deposit_fee_pct')),
        minNgn:   fromCents(toCents(await getRaw('deposit_fee_min_ngn'))),
        maxNgn:   fromCents(toCents(await getRaw('deposit_fee_max_ngn')))
    };
}

async function getLimit(service, type) {
    const svc = String(service || '').toLowerCase();
    const t = String(type || '').toLowerCase();
    if (t !== 'min' && t !== 'max') {
        const e = new Error(`Limit type must be 'min' or 'max'`);
        e.status = 400;
        e.code = 'INVALID_LIMIT_TYPE';
        throw e;
    }
    const key = `${svc}_${t === 'min' ? 'min' : 'max'}_ngn`;
    if (!KEY_REGISTRY[key]) {
        const e = new Error(`No limit configured for service=${svc} type=${t}`);
        e.status = 400;
        e.code = 'LIMIT_NOT_CONFIGURED';
        throw e;
    }
    return fromCents(toCents(await getRaw(key)));
}

// ═════════════════════════════════════════════════════════════════
// 11. FX HISTORY
// ═════════════════════════════════════════════════════════════════

const RATE_HISTORY_KEYS = new Set(
    Object.entries(KEY_REGISTRY)
        .filter(([, spec]) => spec.financial && (spec.section === 'rates' || spec.section === 'pricing' || spec.section === 'fees'))
        .map(([key]) => key)
);

async function writeRateHistory(rows, ctx) {
    const rateRows = rows
        .filter(r => RATE_HISTORY_KEYS.has(r.key))
        .map(r => ({
            key: r.key,
            previous_value: r.previous_value,
            new_value: r.value,
            changed_by: ctx.adminId || null,
            changed_by_email: ctx.adminEmail || null,
            reason: ctx.reason || null,
            changed_at: new Date().toISOString()
        }));
    if (!rateRows.length) return;
    try {
        await supabaseAdmin.from('fx_rate_history').insert(rateRows);
    } catch (e) {
        console.warn('[adminSettings] rate history insert failed:', e.message);
    }
}

async function getRateHistory({ key = null, limit = 100 } = {}) {
    let q = supabaseAdmin
        .from('fx_rate_history')
        .select('id, key, previous_value, new_value, changed_by, changed_by_email, reason, changed_at')
        .order('changed_at', { ascending: false })
        .limit(Math.min(Number(limit) || 100, 500));
    if (key) q = q.eq('key', key);

    const { data, error } = await q;
    if (error) throw error;

    const adminIds = [...new Set((data || []).map(r => r.changed_by).filter(Boolean))];
    let adminsById = {};
    if (adminIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email')
            .in('id', adminIds);
        (profiles || []).forEach(p => { adminsById[p.id] = p; });
    }

    return (data || []).map(r => ({
        ...r,
        changed_by_username: adminsById[r.changed_by]?.username || null,
        changed_by_display:  adminsById[r.changed_by]?.username
                             || r.changed_by_email
                             || 'Unknown'
    }));
}

// ═════════════════════════════════════════════════════════════════
// 12. SERVICES
// ═════════════════════════════════════════════════════════════════

async function isServiceEnabled(service) {
    const entry = SERVICE_REGISTRY[String(service || '').toLowerCase()];
    if (!entry) return false;
    return getBoolean(entry.enabledKey);
}

async function assertServiceEnabled(service) {
    const svc = String(service || '').toLowerCase();
    const entry = SERVICE_REGISTRY[svc];
    if (!entry) {
        const e = new Error(`Unknown service: ${svc}`);
        e.status = 400;
        e.code = 'UNKNOWN_SERVICE';
        throw e;
    }
    if (!(await getBoolean(entry.enabledKey))) {
        const e = new Error(`${entry.label} is currently unavailable.`);
        e.status = 503;
        e.code = 'SERVICE_DISABLED';
        e.service = svc;
        throw e;
    }
}

async function getServiceStatusAll() {
    const out = {};
    for (const [key, entry] of Object.entries(SERVICE_REGISTRY)) {
        out[key] = {
            key,
            label: entry.label,
            enabled: await getBoolean(entry.enabledKey)
        };
    }
    return out;
}

// ═════════════════════════════════════════════════════════════════
// 13. PROVIDERS
// ═════════════════════════════════════════════════════════════════

function isProviderConfigured(providerKey) {
    const entry = PROVIDER_REGISTRY[providerKey];
    if (!entry) return false;
    return entry.secretEnv.every(envVar => Boolean(process.env[envVar]));
}

async function isProviderEnabled(provider) {
    const entry = PROVIDER_REGISTRY[String(provider || '').toLowerCase()];
    if (!entry) return false;
    if (!isProviderConfigured(provider)) return false;
    return getBoolean(entry.enabledKey);
}

async function assertProviderEnabled(provider) {
    const key = String(provider || '').toLowerCase();
    const entry = PROVIDER_REGISTRY[key];
    if (!entry) {
        const e = new Error(`Unknown provider: ${key}`);
        e.status = 400;
        e.code = 'UNKNOWN_PROVIDER';
        throw e;
    }
    if (!isProviderConfigured(key)) {
        const e = new Error(`${entry.label} is not configured.`);
        e.status = 503;
        e.code = 'PROVIDER_NOT_CONFIGURED';
        e.provider = key;
        throw e;
    }
    if (await getBoolean(entry.maintenanceKey)) {
        const e = new Error(`${entry.label} is in maintenance.`);
        e.status = 503;
        e.code = 'PROVIDER_MAINTENANCE';
        e.provider = key;
        throw e;
    }
    if (!(await getBoolean(entry.enabledKey))) {
        const e = new Error(`${entry.label} is disabled.`);
        e.status = 503;
        e.code = 'PROVIDER_DISABLED';
        e.provider = key;
        throw e;
    }
}

async function getProviderStatusAll() {
    const out = {};
    for (const [key, entry] of Object.entries(PROVIDER_REGISTRY)) {
        out[key] = {
            key,
            label: entry.label,
            configured: isProviderConfigured(key),
            enabled:     await getBoolean(entry.enabledKey),
            maintenance: await getBoolean(entry.maintenanceKey),
            timeoutMs:   Number(await getRaw(entry.timeoutKey)) || null
        };
    }
    return out;
}

// ═════════════════════════════════════════════════════════════════
// 14. EMERGENCY OPERATION GATES
// ═════════════════════════════════════════════════════════════════

const OPERATION_KEYS = Object.freeze({
    deposit:          'emergency_stop_deposits',
    purchase:         'emergency_stop_purchases',
    provider_request: 'emergency_stop_provider_requests',
    wallet_mutation:  'emergency_stop_wallet_mutations'
});

async function isOperationAllowed(operation) {
    const op = String(operation || '').toLowerCase();
    if (op === 'maintenance') return !(await getBoolean('maintenance_mode'));
    const key = OPERATION_KEYS[op];
    if (!key) return true;
    if (await getBoolean('maintenance_mode')) return false;
    return !(await getBoolean(key));
}

async function assertOperationAllowed(operation) {
    if (await isOperationAllowed(operation)) return;
    const op = String(operation || '').toLowerCase();
    const e = new Error(
        op === 'maintenance'
            ? 'Platform is in maintenance mode.'
            : `Operation '${op}' is currently blocked by an emergency control.`
    );
    e.status = 503;
    e.code = 'OPERATION_BLOCKED';
    e.operation = op;
    throw e;
}

// ═════════════════════════════════════════════════════════════════
// 15. AUDIT
// ═════════════════════════════════════════════════════════════════

async function writeAudit(rows, ctx) {
    try {
        const auditRows = rows.map(r => ({
            admin_id:    ctx.adminId || null,
            admin_email: ctx.adminEmail || null,
            action:      'setting_change',
            target_type: 'app_config',
            target_id:   r.key,
            before:      { value: r.previous_value },
            after:       { value: r.value },
            ip_address:  ctx.ip || null,
            user_agent:  ctx.userAgent || null,
            created_at:  new Date().toISOString()
        }));
        const { error } = await supabaseAdmin.from('settings_audit').insert(auditRows);
        if (error) {
            console.error('[adminSettings] audit insert failed:', error.message);
            return false;
        }
        return true;
    } catch (e) {
        console.error('[adminSettings] audit insert exception:', e.message);
        return false;
    }
}

async function getAudit({ limit = 100 } = {}) {
    const { data, error } = await supabaseAdmin
        .from('settings_audit')
        .select('id, admin_id, admin_email, action, target_type, target_id, before, after, ip_address, user_agent, created_at')
        .order('created_at', { ascending: false })
        .limit(Math.min(Number(limit) || 100, 500));
    if (error) throw error;
    return data || [];
}

// ═════════════════════════════════════════════════════════════════
// 16. HEALTH
// ═════════════════════════════════════════════════════════════════

async function getHealth() {
    const out = {
        database: 'unknown',
        rates: 'unknown',
        fees: 'unknown',
        services: 'unknown',
        providers: 'unknown'
    };

    // Database read.
    try {
        await readRawFromDb();
        out.database = 'ok';
    } catch {
        out.database = 'unavailable';
    }

    if (out.database !== 'ok') {
        return out;
    }

    // Rates.
    try {
        const usd = await getNumber('usd_to_ngn');
        out.rates = usd > 0 ? 'configured' : 'invalid';
    } catch {
        out.rates = 'missing';
    }

    // Fees.
    try {
        const fee = await getFee('deposit');
        out.fees = (fee.flatNgn !== null && fee.minNgn !== null && fee.maxNgn !== null) ? 'configured' : 'missing';
    } catch {
        out.fees = 'missing';
    }

    // Services — at least one enabled.
    try {
        const svc = await getServiceStatusAll();
        const enabled = Object.values(svc).filter(s => s.enabled).length;
        out.services = enabled > 0 ? 'ok' : 'all-disabled';
    } catch {
        out.services = 'unknown';
    }

    // Providers — reported as configured/enabled but never as "healthy".
    try {
        const prov = await getProviderStatusAll();
        const configured = Object.values(prov).filter(p => p.configured).length;
        out.providers = configured > 0 ? 'partial' : 'none-configured';
    } catch {
        out.providers = 'unknown';
    }

    return out;
}

// ═════════════════════════════════════════════════════════════════
// 17. EXPORTS
// ═════════════════════════════════════════════════════════════════

module.exports = {
    // Registries
    KEY_REGISTRY,
    SECTION_KEYS,
    SERVICE_REGISTRY,
    PROVIDER_REGISTRY,
    ALL_KEYS,
    RATE_HISTORY_KEYS,

    // Validation
    normalize,

    // Cache
    invalidateCache,

    // Reads
    getAllSettings,
    getSettingsBySectionAll,
    getSection,
    getRaw,
    getNumber,
    getBoolean,
    getString,

    // Writes
    patchSettings,
    resetSection,
    resetAll,

    // Pricing
    getMarkup,
    getRate,
    calculatePrice,
    getFee,
    getLimit,

    // Services
    isServiceEnabled,
    assertServiceEnabled,
    getServiceStatusAll,

    // Providers
    isProviderEnabled,
    assertProviderEnabled,
    getProviderStatusAll,
    isProviderConfigured,

    // Emergency
    isOperationAllowed,
    assertOperationAllowed,

    // Audit / history
    getRateHistory,
    getAudit,

    // Health
    getHealth
};