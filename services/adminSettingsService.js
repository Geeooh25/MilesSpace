// services/adminSettingsService.js
// ─────────────────────────────────────────────────────────────────
// MILESSPACE SETTINGS — SINGLE SOURCE OF TRUTH
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

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

    // ─── Primary FX Rates ────────────────────────────────────
    usd_to_ngn: { shape: 'decimal', section: 'rates', default: '1600', min: 1, max: 1_000_000, decimals: 2, financial: true, dangerous: true },
    giftcard_wholesale_currency: { shape: 'currency', section: 'rates', default: 'NGN' },

    // ─── Deposit Exchange Rates (USD per 1 Local Unit) ───────
    deposit_rate_NGN: { shape: 'decimal', section: 'fees', default: '0.000625', min: 0, max: 10_000, decimals: 8, financial: true, dangerous: true },
    deposit_rate_GHS: { shape: 'decimal', section: 'fees', default: '0.083',    min: 0, max: 10_000, decimals: 8, financial: true, dangerous: true },
    deposit_rate_KES: { shape: 'decimal', section: 'fees', default: '0.0077',   min: 0, max: 10_000, decimals: 8, financial: true, dangerous: true },
    deposit_rate_ZAR: { shape: 'decimal', section: 'fees', default: '0.054',    min: 0, max: 10_000, decimals: 8, financial: true, dangerous: true },
    deposit_rate_XOF: { shape: 'decimal', section: 'fees', default: '0.0016',   min: 0, max: 10_000, decimals: 8, financial: true, dangerous: true },
    deposit_rate_XAF: { shape: 'decimal', section: 'fees', default: '0.0016',   min: 0, max: 10_000, decimals: 8, financial: true, dangerous: true },
    deposit_rate_TZS: { shape: 'decimal', section: 'fees', default: '0.0004',   min: 0, max: 10_000, decimals: 8, financial: true, dangerous: true },
    deposit_rate_EGP: { shape: 'decimal', section: 'fees', default: '0.0204',   min: 0, max: 10_000, decimals: 8, financial: true, dangerous: true },

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

// ─── SUPER ADMIN ONLY SETTINGS ───────────────────────────────────
// These keys are restricted. Non-super-admins cannot read or write
// them, and the UI disables them for anyone who isn't super_admin.
const SUPER_ADMIN_ONLY_KEYS = new Set([
    // General (branding & maintenance)
    'platform_name',
    'company_name',
    'support_email',
    'support_phone',
    'website_url',
    'default_currency',
    'timezone',
    'maintenance_mode',
    'maintenance_message',

    // Rates
    'usd_to_ngn',
    'giftcard_wholesale_currency',

    // Deposit exchange rates
    'deposit_rate_NGN', 'deposit_rate_GHS', 'deposit_rate_KES', 'deposit_rate_ZAR',
    'deposit_rate_XOF', 'deposit_rate_XAF', 'deposit_rate_TZS', 'deposit_rate_EGP',

    // Emergency
    'emergency_stop_deposits', 'emergency_stop_purchases',
    'emergency_stop_provider_requests', 'emergency_stop_wallet_mutations'
]);

const SECTION_KEYS = (() => {
    const map = {};
    for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
        const s = spec.section || 'general';
        if (!map[s]) map[s] = [];
        map[s].push(key);
    }
    return Object.freeze(map);
})();

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

const ALL_KEYS = Object.keys(KEY_REGISTRY);

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

const CACHE_TTL_MS = 45 * 1000;
const _cache = { raw: null, fetchedAt: 0, promise: null };

function invalidateCache() {
    _cache.raw = null;
    _cache.fetchedAt = 0;
}

async function readRawFromDb() {
    const { data, error } = await supabaseAdmin.from('app_config').select('key, value').in('key', ALL_KEYS);
    if (error) throw new Error(`Failed to read app_config: ${error.message}`);
    const raw = {};
    for (const row of data || []) raw[row.key] = row.value;
    return raw;
}

async function getRawCached({ force = false } = {}) {
    if (!force && _cache.raw && (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS) return _cache.raw;
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

function displayValue(spec, raw) {
    switch (spec.shape) {
        case 'boolean': return raw === true || raw === 'true' || raw === '1' || raw === 1;
        case 'int': return Number.isFinite(parseInt(raw, 10)) ? parseInt(raw, 10) : parseInt(spec.default, 10);
        case 'decimal':
        case 'percent': return Number.isFinite(Number(raw)) ? Number(raw) : Number(spec.default);
        default: return raw == null ? '' : raw;
    }
}

async function getAllSettings() {
    const raw = await getRawCached();
    const out = {};
    for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
        out[key] = displayValue(spec, raw[key]);
    }
    return out;
}

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
    if (!all[section]) throw Object.assign(new Error(`Unknown section: ${section}`), { status: 404, code: 'UNKNOWN_SECTION' });
    return all[section];
}

async function getRaw(key) {
    if (!KEY_REGISTRY[key]) return undefined;
    const raw = await getRawCached();
    return raw[key];
}

async function getNumber(key) {
    const v = await getRaw(key);
    const n = Number(v);
    if (!Number.isFinite(n)) throw Object.assign(new Error(`Setting ${key} is not a finite number`), { status: 503, code: 'CONFIG_NOT_READY' });
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

async function readStoredRaw(keys) {
    if (!keys.length) return {};
    const { data, error } = await supabaseAdmin.from('app_config').select('key, value').in('key', keys);
    if (error) throw new Error(`Failed to read app_config: ${error.message}`);
    const out = {};
    for (const row of data || []) out[row.key] = row.value;
    return out;
}

function buildContext(req, { reason = null } = {}) {
    return {
        adminId: req?.adminContext?.id || null,
        adminEmail: req?.adminContext?.email || null,
        isSuperAdmin: !!req?.adminContext?.isSuperAdmin,
        ip: req?.ip || req?.headers?.['x-forwarded-for'] || null,
        userAgent: req?.headers?.['user-agent'] || null,
        reason: reason ? String(reason).slice(0, 500) : null
    };
}

function requiresReason(keys) {
    return keys.some(k => KEY_REGISTRY[k]?.financial || KEY_REGISTRY[k]?.dangerous);
}

async function patchSettings(patch, ctx = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw validationError('INVALID_PATCH', 'patch must be an object');
    }

    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
        if (k === 'reason') continue;
        clean[k] = v;
    }
    if (!Object.keys(clean).length) throw validationError('EMPTY_PATCH', 'No settings to update');

    // ─── SUPER ADMIN RESTRICTION ─────────────────────────────────────
    const isSuperAdmin = !!ctx.isSuperAdmin;
    if (!isSuperAdmin) {
        const restrictedKeys = Object.keys(clean).filter(k => SUPER_ADMIN_ONLY_KEYS.has(k));
        if (restrictedKeys.length > 0) {
            throw Object.assign(
                new Error(`Only Super Admins are allowed to change: ${restrictedKeys.join(', ')}`),
                { status: 403, code: 'SUPER_ADMIN_REQUIRED', keys: restrictedKeys }
            );
        }
    }
    // ─────────────────────────────────────────────────────────────────

    const normalized = {};
    for (const [key, rawValue] of Object.entries(clean)) {
        normalized[key] = normalize(key, rawValue);
    }

    const existing = await getRawCached();
    const merged = { ...existing, ...normalized };
    validateCrossField(merged);

    const touchedKeys = Object.keys(normalized);
    if (requiresReason(touchedKeys)) {
        if (!ctx.reason || String(ctx.reason).trim().length < 3) {
            throw validationError('REASON_REQUIRED', 'A reason is required for this change', { keys: touchedKeys });
        }
    }

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

    if (!toWrite.length) return { updated: [], unchanged };

    const currentVersion = Number(existing.config_version || '1');
    const nextVersion = String(currentVersion + 1);
    const payload = [
        ...toWrite.map(r => ({ key: r.key, value: r.value, updated_at: r.updated_at })),
        { key: 'config_version', value: nextVersion, updated_at: now }
    ];

    const { error: writeError } = await supabaseAdmin.from('app_config').upsert(payload, { onConflict: 'key' });

    if (writeError) throw new Error(`Failed to write app_config: ${writeError.message}`);

    const auditOk = await writeAudit(toWrite, ctx);
    const touchesFinancial = toWrite.some(r => KEY_REGISTRY[r.key]?.financial);

    if (!auditOk && touchesFinancial) {
        const rollbackRows = toWrite
            .filter(r => r.previous_value !== null)
            .map(r => ({ key: r.key, value: r.previous_value, updated_at: new Date().toISOString() }));
        try {
            await supabaseAdmin.from('app_config').upsert(rollbackRows, { onConflict: 'key' });
        } catch (rbErr) {
            console.error('[adminSettings] rollback after audit failure failed:', rbErr.message);
        }
        invalidateCache();
        throw Object.assign(new Error('Audit logging failed. Financial settings change was rolled back.'), { status: 500, code: 'AUDIT_FAILED_ROLLBACK' });
    }

    await writeRateHistory(toWrite, ctx);
    invalidateCache();

    return { updated: changed, unchanged, version: nextVersion };
}

async function resetSection(section, ctx = {}) {
    if (!SECTION_KEYS[section]) throw Object.assign(new Error(`Unknown section: ${section}`), { status: 404, code: 'UNKNOWN_SECTION' });
    const patch = {};
    for (const key of SECTION_KEYS[section]) {
        const spec = KEY_REGISTRY[key];
        if (spec) patch[key] = spec.default;
    }
    return patchSettings(patch, { ...ctx, reason: ctx.reason || `Reset ${section}` });
}

async function resetAll(ctx = {}) {
    const patch = {};
    for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
        if (key === 'config_version') continue;
        patch[key] = spec.default;
    }
    return patchSettings(patch, { ...ctx, reason: ctx.reason || 'Reset all settings' });
}

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
    let key = KEY_REGISTRY[dualKey] ? dualKey : (KEY_REGISTRY[singleKey] ? singleKey : null);

    if (!key) throw Object.assign(new Error(`No markup configured for service=${svc} currency=${cur}`), { status: 400, code: 'MARKUP_NOT_CONFIGURED' });
    const n = await getNumber(key);
    if (n < 0 || n > 1) throw Object.assign(new Error(`Markup for ${svc}/${cur} is out of range: ${n}`), { status: 503, code: 'MARKUP_INVALID' });
    return n;
}

async function getRate(sourceCurrency, targetCurrency) {
    const src = String(sourceCurrency || '').toUpperCase();
    const tgt = String(targetCurrency || '').toUpperCase();
    if (src === tgt) return 1;

    if (src === 'USD' && tgt === 'NGN') {
        const n = await getNumber('usd_to_ngn');
        if (!(n > 0)) throw Object.assign(new Error('usd_to_ngn is not configured'), { status: 503, code: 'RATE_NOT_CONFIGURED' });
        return n;
    }

    const e = new Error(`Unsupported rate pair: ${src} -> ${tgt}`);
    e.status = 400; e.code = 'RATE_NOT_CONFIGURED';
    throw e;
}

async function calculatePrice({ service, currency = 'NGN', wholesaleAmount }) {
    if (!service) throw Object.assign(new Error('service is required'), { status: 400, code: 'INVALID_INPUT' });
    if (wholesaleAmount === undefined || wholesaleAmount === null) throw Object.assign(new Error('wholesaleAmount is required'), { status: 400, code: 'INVALID_INPUT' });

    const cur = String(currency).toUpperCase();
    const wholesaleCents = toCents(wholesaleAmount);
    const markup = await getMarkup(service, cur);
    const markupBps = BigInt(Math.round(markup * 10_000));

    const customerCents = (wholesaleCents * (10_000n + markupBps)) / 10_000n;
    const profitCents   = customerCents - wholesaleCents;

    return {
        service: service,
        currency: cur,
        wholesaleAmount: fromCents(wholesaleCents),
        markup,
        customerPrice: fromCents(customerCents),
        profit: fromCents(profitCents),
        pricingVersion: Number(await getRaw('config_version') || '1')
    };
}

async function getFee(type) {
    const t = String(type || '').toLowerCase();
    if (t !== 'deposit') throw Object.assign(new Error(`Unknown fee type: ${type}`), { status: 400, code: 'INVALID_FEE_TYPE' });
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
    if (t !== 'min' && t !== 'max') throw Object.assign(new Error(`Limit type must be 'min' or 'max'`), { status: 400, code: 'INVALID_LIMIT_TYPE' });
    const key = `${svc}_${t === 'min' ? 'min' : 'max'}_ngn`;
    if (!KEY_REGISTRY[key]) throw Object.assign(new Error(`No limit configured for service=${svc} type=${t}`), { status: 400, code: 'LIMIT_NOT_CONFIGURED' });
    return fromCents(toCents(await getRaw(key)));
}

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
    let q = supabaseAdmin.from('fx_rate_history').select('*').order('changed_at', { ascending: false }).limit(Math.min(Number(limit) || 100, 500));
    if (key) q = q.eq('key', key);

    const { data, error } = await q;
    if (error) throw error;

    const adminIds = [...new Set((data || []).map(r => r.changed_by).filter(Boolean))];
    let adminsById = {};
    if (adminIds.length) {
        const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, email').in('id', adminIds);
        (profiles || []).forEach(p => { adminsById[p.id] = p; });
    }

    return (data || []).map(r => ({
        ...r,
        changed_by_username: adminsById[r.changed_by]?.username || null,
        changed_by_display: adminsById[r.changed_by]?.username || r.changed_by_email || 'Unknown'
    }));
}

async function isServiceEnabled(service) {
    const entry = SERVICE_REGISTRY[String(service || '').toLowerCase()];
    if (!entry) return false;
    return getBoolean(entry.enabledKey);
}

async function assertServiceEnabled(service) {
    const svc = String(service || '').toLowerCase();
    const entry = SERVICE_REGISTRY[svc];
    if (!entry) throw Object.assign(new Error(`Unknown service: ${svc}`), { status: 400, code: 'UNKNOWN_SERVICE' });
    if (!(await getBoolean(entry.enabledKey))) throw Object.assign(new Error(`${entry.label} is currently unavailable.`), { status: 503, code: 'SERVICE_DISABLED', service: svc });
}

async function getServiceStatusAll() {
    const out = {};
    for (const [key, entry] of Object.entries(SERVICE_REGISTRY)) {
        out[key] = { key, label: entry.label, enabled: await getBoolean(entry.enabledKey) };
    }
    return out;
}

function isProviderConfigured(providerKey) {
    const entry = PROVIDER_REGISTRY[providerKey];
    if (!entry) return false;
    return entry.secretEnv.every(envVar => Boolean(process.env[envVar]));
}

async function isProviderEnabled(provider) {
    const entry = PROVIDER_REGISTRY[String(provider || '').toLowerCase()];
    if (!entry || !isProviderConfigured(provider)) return false;
    return getBoolean(entry.enabledKey);
}

async function assertProviderEnabled(provider) {
    const key = String(provider || '').toLowerCase();
    const entry = PROVIDER_REGISTRY[key];
    if (!entry) throw Object.assign(new Error(`Unknown provider: ${key}`), { status: 400, code: 'UNKNOWN_PROVIDER' });
    if (!isProviderConfigured(key)) throw Object.assign(new Error(`${entry.label} is not configured.`), { status: 503, code: 'PROVIDER_NOT_CONFIGURED', provider: key });
    if (await getBoolean(entry.maintenanceKey)) throw Object.assign(new Error(`${entry.label} is in maintenance.`), { status: 503, code: 'PROVIDER_MAINTENANCE', provider: key });
    if (!(await getBoolean(entry.enabledKey))) throw Object.assign(new Error(`${entry.label} is disabled.`), { status: 503, code: 'PROVIDER_DISABLED', provider: key });
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

const OPERATION_KEYS = Object.freeze({
    deposit: 'emergency_stop_deposits',
    purchase: 'emergency_stop_purchases',
    provider_request: 'emergency_stop_provider_requests',
    wallet_mutation: 'emergency_stop_wallet_mutations'
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
    const e = new Error(op === 'maintenance' ? 'Platform is in maintenance mode.' : `Operation '${op}' is currently blocked by an emergency control.`);
    e.status = 503; e.code = 'OPERATION_BLOCKED'; e.operation = op;
    throw e;
}

async function writeAudit(rows, ctx) {
    try {
        const auditRows = rows.map(r => ({
            admin_id: ctx.adminId || null,
            admin_email: ctx.adminEmail || null,
            action: 'setting_change',
            target_type: 'app_config',
            target_id: r.key,
            before: { value: r.previous_value },
            after: { value: r.value },
            ip_address: ctx.ip || null,
            user_agent: ctx.userAgent || null,
            created_at: new Date().toISOString()
        }));
        const { error } = await supabaseAdmin.from('settings_audit').insert(auditRows);
        if (error) { console.error('[adminSettings] audit insert failed:', error.message); return false; }
        return true;
    } catch (e) {
        console.error('[adminSettings] audit insert exception:', e.message);
        return false;
    }
}

async function getAudit({ limit = 100 } = {}) {
    const { data, error } = await supabaseAdmin.from('settings_audit').select('*').order('created_at', { ascending: false }).limit(Math.min(Number(limit) || 100, 500));
    if (error) throw error;
    return data || [];
}

async function getHealth() {
    const out = { database: 'unknown', rates: 'unknown', fees: 'unknown', services: 'unknown', providers: 'unknown' };
    try { await readRawFromDb(); out.database = 'ok'; } catch { out.database = 'unavailable'; }
    if (out.database !== 'ok') return out;
    try { const usd = await getNumber('usd_to_ngn'); out.rates = usd > 0 ? 'configured' : 'invalid'; } catch { out.rates = 'missing'; }
    try { const fee = await getFee('deposit'); out.fees = (fee.flatNgn !== null && fee.minNgn !== null && fee.maxNgn !== null) ? 'configured' : 'missing'; } catch { out.fees = 'missing'; }
    try { const svc = await getServiceStatusAll(); out.services = Object.values(svc).filter(s => s.enabled).length > 0 ? 'ok' : 'all-disabled'; } catch { out.services = 'unknown'; }
    try { const prov = await getProviderStatusAll(); out.providers = Object.values(prov).filter(p => p.configured).length > 0 ? 'partial' : 'none-configured'; } catch { out.providers = 'unknown'; }
    return out;
}

module.exports = {
    KEY_REGISTRY, SECTION_KEYS, SERVICE_REGISTRY, PROVIDER_REGISTRY, ALL_KEYS, RATE_HISTORY_KEYS, SUPER_ADMIN_ONLY_KEYS,
    normalize, invalidateCache,
    getAllSettings, getSettingsBySectionAll, getSection, getRaw, getNumber, getBoolean, getString,
    patchSettings, resetSection, resetAll,
    getMarkup, getRate, calculatePrice, getFee, getLimit,
    isServiceEnabled, assertServiceEnabled, getServiceStatusAll,
    isProviderEnabled, assertProviderEnabled, getProviderStatusAll, isProviderConfigured,
    isOperationAllowed, assertOperationAllowed,
    getRateHistory, getAudit, getHealth
};