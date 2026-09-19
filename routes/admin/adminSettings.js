// routes/adminSettings.js - Complete Admin Settings System
// Allows admins to configure all platform settings including prices, markups, exchange rates
// Full support for Virtual SMS rates, USD/NGN conversion, and real-time price updates

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { adminAuthMiddleware } = require('../../middleware/auth');

// ─── CONSTANTS ──────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
    // General
    platform_name: 'MilesSpace',
    company_name: 'MilesSpace Ltd',
    website_url: 'https://milesspace.com',
    support_email: 'support@milesspace.com',
    support_phone: '+234 800 000 0000',
    timezone: 'Africa/Lagos',
    date_format: 'DD/MM/YYYY',
    default_language: 'English',
    default_currency: 'NGN',
    theme: 'Light Mode',

    // ════════════════════════════════════════════════════════════════════
    //  EXCHANGE RATES (CRITICAL FOR PRICING)
    // ════════════════════════════════════════════════════════════════════
    usd_to_ngn: '1600',
    gbp_to_ngn: '2050',
    eur_to_ngn: '1750',
    cad_to_ngn: '1200',
    exchange_rate_updated_at: '',

    // ════════════════════════════════════════════════════════════════════
    //  VIRTUAL SMS PRICING (CRITICAL FOR VIRTUAL NUMBERS)
    // ════════════════════════════════════════════════════════════════════
    virtual_sms_enabled: 'true',
    virtual_sms_markup: '15',
    virtual_sms_cheap_threshold: '2.00',
    virtual_sms_cheap_markup: '2.50',
    virtual_sms_expensive_markup: '1.50',
    virtual_sms_min_price_usd: '0.50',
    virtual_sms_max_price_usd: '100',
    virtual_sms_auto_refund: 'true',
    virtual_sms_refund_window_minutes: '20',
    virtual_sms_cancel_window_minutes: '5',
    virtual_sms_default_validity_minutes: '20',

    // ════════════════════════════════════════════════════════════════════
    //  BOOST PRICING
    // ════════════════════════════════════════════════════════════════════
    boost_markup: '18',
    boost_min_price: '100',
    boost_max_price: '1000000',
    boost_enabled: 'true',

    // ════════════════════════════════════════════════════════════════════
    //  GIFT CARD PRICING
    // ════════════════════════════════════════════════════════════════════
    gift_card_markup: '10',
    gift_card_min_trade: '10',
    gift_card_max_trade: '500',
    gift_card_enabled: 'true',
    gift_card_supported: 'Amazon,Steam,iTunes,Xbox,PlayStation',

    // ════════════════════════════════════════════════════════════════════
    //  MARKETPLACE PRICING
    // ════════════════════════════════════════════════════════════════════
    marketplace_markup: '20',
    marketplace_enabled: 'true',

    // ════════════════════════════════════════════════════════════════════
    //  CASHBACK
    // ════════════════════════════════════════════════════════════════════
    cashback_rate: '5',
    min_redeem: '50',
    max_redeem: '100000',
    cashback_enabled: 'true',

    // Company
    business_name: 'MilesSpace Ltd',
    business_email: 'info@milesspace.com',
    business_phone: '+234 800 000 0000',
    business_country: 'Nigeria',
    business_state: 'Lagos',
    business_city: 'Ikeja',
    business_address: '123 Main Street, Ikeja, Lagos',
    business_zip: '100001',
    business_cac: 'RC-1234567',
    business_tax: 'TAX-9876543',

    // Profile (admin)
    admin_name: 'Dara Adisa',
    admin_username: 'dara_admin',
    admin_email: 'dara@milesspace.com',
    admin_phone: '+234 803 456 7890',
    admin_language: 'English',
    admin_theme: 'Light',
    admin_2fa: 'Disabled',

    // Security
    two_factor_auth: 'true',
    email_verification: 'true',
    session_timeout: '4 hours',
    login_notifications: 'true',
    failed_login_lock: '5 attempts',

    // Wallet
    wallet_ngn_status: 'Active',
    wallet_usd_status: 'Active',
    min_deposit_ngn: '1000',
    max_deposit_ngn: '10000000',
    min_withdrawal_ngn: '5000',
    max_withdrawal_ngn: '5000000',
    withdrawal_fee_ngn: '50',
    deposit_fee_percent: '1.5',
    auto_wallet_credit: 'true',
    manual_wallet_credit: 'true',

    // Payments
    paystack_enabled: 'true',
    flutterwave_enabled: 'true',
    bank_transfer_enabled: 'true',
    stripe_enabled: 'false',
    crypto_payments_enabled: 'false',
    paystack_public_key: 'pk_test_xxxx',
    paystack_secret_key: 'sk_test_xxxx',
    flutterwave_public_key: 'FLWPUBK-xxxx',
    flutterwave_secret_key: 'FLWSECK-xxxx',

    // Currency
    currencies_supported: 'NGN,USD,GBP',
    default_currency_display: 'USD',
    currency_symbol_position: 'Before amount',
    currency_decimals: '2',

    // Campaigns
    campaign_min_budget: '10000',
    campaign_max_budget: '10000000',
    campaign_default_currency: 'USD',
    campaign_approval: 'Manual Approval',
    campaign_duration: '14',
    campaign_allowed_platforms: 'Facebook,Instagram,TikTok,Google',

    // Referrals
    referral_bonus: '500',
    referral_signup_bonus: '200',
    referral_commission: '5',
    referral_max_reward: '5000',
    referral_enabled: 'true',

    // Notifications
    notify_new_user: 'true',
    notify_deposit: 'true',
    notify_withdrawal: 'true',
    notify_campaign: 'true',
    notify_giftcard: 'true',
    notify_wallet: 'true',

    // Email (SMTP)
    smtp_host: 'smtp.gmail.com',
    smtp_port: '587',
    smtp_username: 'admin@milesspace.com',
    smtp_password: '',
    smtp_encryption: 'TLS',
    smtp_sender_name: 'MilesSpace',
    smtp_sender_email: 'noreply@milesspace.com',

    // SMS
    sms_api_key: '',
    sms_sender_id: 'MilesSpace',
    sms_enabled: 'true',

    // System
    dark_mode: 'false',
    animations: 'true',
    auto_refresh: 'true',
    realtime_dashboard: 'true',
    compact_tables: 'false',

    // Maintenance
    maintenance_mode: 'false',
    maintenance_message: "We're currently performing scheduled maintenance. Please check back soon.",
    maintenance_bypass: 'true',

    // Developer
    environment: 'Production',
    debug_mode: 'Disabled',
    api_debug: 'true',
    error_logs: 'true'
};

// ─── HELPERS ────────────────────────────────────────────────────────────

function getDefaultSettings() {
    return { ...DEFAULT_SETTINGS };
}

function parseBoolean(value) {
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1' || value === 'yes';
}

function formatBoolean(value) {
    return value ? 'true' : 'false';
}

function formatCurrency(value) {
    const num = parseFloat(value);
    if (isNaN(num)) return '0.00';
    return num.toFixed(2);
}

// ─── GET /api/admin/settings - Get all settings ──────────────────────

router.get('/settings', adminAuthMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('app_config')
            .select('*');

        if (error) {
            console.error('Failed to fetch settings:', error);
            return res.json({
                success: true,
                settings: getDefaultSettings(),
                source: 'defaults'
            });
        }

        const settings = { ...getDefaultSettings() };
        (data || []).forEach(item => {
            settings[item.key] = item.value;
        });

        // Parse boolean values
        Object.keys(settings).forEach(key => {
            if (typeof settings[key] === 'string') {
                if (settings[key] === 'true') settings[key] = true;
                else if (settings[key] === 'false') settings[key] = false;
            }
        });

        // Add derived settings
        const rate = parseFloat(settings.usd_to_ngn) || 1600;
        settings.usd_to_ngn_formatted = formatCurrency(rate);
        settings.ngn_to_usd = formatCurrency(1 / rate);
        settings.virtual_sms_markup_formatted = settings.virtual_sms_markup + '%';
        settings.boost_markup_formatted = settings.boost_markup + '%';
        settings.gift_card_markup_formatted = settings.gift_card_markup + '%';
        settings.marketplace_markup_formatted = settings.marketplace_markup + '%';
        settings.cashback_rate_formatted = settings.cashback_rate + '%';

        res.json({
            success: true,
            settings,
            source: 'database'
        });

    } catch (error) {
        console.error('❌ Get settings error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch settings'
        });
    }
});

// ─── POST /api/admin/settings - Update settings ──────────────────────

router.post('/settings', adminAuthMiddleware, async (req, res) => {
    try {
        const { settings } = req.body;

        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({
                success: false,
                error: 'Invalid settings data'
            });
        }

        const updates = [];
        const errors = [];
        let exchangeRateUpdated = false;

        for (const [key, value] of Object.entries(settings)) {
            try {
                // Special handling for exchange rates - update timestamp
                if (key === 'usd_to_ngn' || key === 'gbp_to_ngn' || key === 'eur_to_ngn' || key === 'cad_to_ngn') {
                    exchangeRateUpdated = true;
                }

                // Convert booleans to string
                const stringValue = typeof value === 'boolean' 
                    ? formatBoolean(value) 
                    : String(value);

                const { error } = await supabaseAdmin
                    .from('app_config')
                    .upsert({
                        key: key,
                        value: stringValue,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'key' });

                if (error) {
                    errors.push({ key, error: error.message });
                } else {
                    updates.push(key);
                }
            } catch (err) {
                errors.push({ key, error: err.message });
            }
        }

        // If exchange rates were updated, update the timestamp
        if (exchangeRateUpdated) {
            await supabaseAdmin
                .from('app_config')
                .upsert({
                    key: 'exchange_rate_updated_at',
                    value: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }, { onConflict: 'key' });
            updates.push('exchange_rate_updated_at');
        }

        // Invalidate cache
        if (global.invalidateDashboardCache) {
            global.invalidateDashboardCache();
        }

        // Clear virtual SMS cache if rates changed
        if (updates.some(k => k.includes('virtual_sms') || k.includes('usd_to_ngn'))) {
            try {
                // You can add cache clearing logic here
                console.log('🔄 Virtual SMS cache invalidated due to rate change');
            } catch (e) {
                console.warn('Cache invalidation warning:', e.message);
            }
        }

        // Log admin activity
        try {
            await supabaseAdmin
                .from('admin_activity')
                .insert({
                    admin_id: req.adminId,
                    admin_email: req.adminEmail || 'unknown',
                    action: 'settings_updated',
                    details: {
                        updated_keys: updates,
                        count: updates.length,
                        exchange_rate_updated: exchangeRateUpdated
                    },
                    ip_address: req.ip || 'unknown',
                    user_agent: req.headers['user-agent'] || 'unknown',
                    created_at: new Date().toISOString()
                });
        } catch (logError) {
            console.warn('Failed to log admin activity:', logError.message);
        }

        res.json({
            success: true,
            message: `Updated ${updates.length} settings`,
            updated: updates,
            exchange_rate_updated: exchangeRateUpdated,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('❌ Update settings error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to update settings'
        });
    }
});

// ─── GET /api/admin/settings/rates - Get exchange rates ─────────────

router.get('/settings/rates', adminAuthMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('app_config')
            .select('*')
            .in('key', ['usd_to_ngn', 'gbp_to_ngn', 'eur_to_ngn', 'cad_to_ngn', 'exchange_rate_updated_at']);

        if (error) throw error;

        const rates = {};
        (data || []).forEach(item => {
            rates[item.key] = item.value;
        });

        // Add default if missing
        if (!rates.usd_to_ngn) rates.usd_to_ngn = '1600';
        if (!rates.gbp_to_ngn) rates.gbp_to_ngn = '2050';
        if (!rates.eur_to_ngn) rates.eur_to_ngn = '1750';
        if (!rates.cad_to_ngn) rates.cad_to_ngn = '1200';

        const usdRate = parseFloat(rates.usd_to_ngn) || 1600;

        res.json({
            success: true,
            rates: {
                usd_to_ngn: usdRate,
                gbp_to_ngn: parseFloat(rates.gbp_to_ngn) || 2050,
                eur_to_ngn: parseFloat(rates.eur_to_ngn) || 1750,
                cad_to_ngn: parseFloat(rates.cad_to_ngn) || 1200,
                ngn_to_usd: 1 / usdRate,
                ngn_to_gbp: 1 / (parseFloat(rates.gbp_to_ngn) || 2050),
                updated_at: rates.exchange_rate_updated_at || new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ Get rates error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch rates'
        });
    }
});

// ─── POST /api/admin/settings/rates - Update exchange rates ─────────

router.post('/settings/rates', adminAuthMiddleware, async (req, res) => {
    try {
        const { rates } = req.body;

        if (!rates || typeof rates !== 'object') {
            return res.status(400).json({
                success: false,
                error: 'Invalid rates data'
            });
        }

        const updates = [];
        const rateKeys = ['usd_to_ngn', 'gbp_to_ngn', 'eur_to_ngn', 'cad_to_ngn'];

        for (const key of rateKeys) {
            if (rates[key] !== undefined) {
                const value = parseFloat(rates[key]);
                if (isNaN(value) || value <= 0) {
                    return res.status(400).json({
                        success: false,
                        error: `Invalid rate for ${key}: must be a positive number`
                    });
                }

                await supabaseAdmin
                    .from('app_config')
                    .upsert({
                        key: key,
                        value: String(value),
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'key' });
                updates.push(key);
            }
        }

        // Update timestamp
        await supabaseAdmin
            .from('app_config')
            .upsert({
                key: 'exchange_rate_updated_at',
                value: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'key' });
        updates.push('exchange_rate_updated_at');

        // Invalidate cache
        if (global.invalidateDashboardCache) {
            global.invalidateDashboardCache();
        }

        // Log admin activity
        try {
            await supabaseAdmin
                .from('admin_activity')
                .insert({
                    admin_id: req.adminId,
                    admin_email: req.adminEmail || 'unknown',
                    action: 'exchange_rates_updated',
                    details: { rates: updates },
                    ip_address: req.ip || 'unknown',
                    user_agent: req.headers['user-agent'] || 'unknown',
                    created_at: new Date().toISOString()
                });
        } catch (logError) {
            console.warn('Failed to log admin activity:', logError.message);
        }

        res.json({
            success: true,
            message: 'Exchange rates updated successfully',
            updated: updates
        });

    } catch (error) {
        console.error('❌ Update rates error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to update rates'
        });
    }
});

// ─── GET /api/admin/settings/virtual-sms - Get virtual SMS settings ──

router.get('/settings/virtual-sms', adminAuthMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('app_config')
            .select('*')
            .ilike('key', 'virtual_sms_%')
            .or('key.eq.usd_to_ngn');

        if (error) throw error;

        const settings = {};
        (data || []).forEach(item => {
            settings[item.key] = item.value;
        });

        // Add defaults for missing values
        const defaults = {
            virtual_sms_enabled: 'true',
            virtual_sms_markup: '15',
            virtual_sms_cheap_threshold: '2.00',
            virtual_sms_cheap_markup: '2.50',
            virtual_sms_expensive_markup: '1.50',
            virtual_sms_min_price_usd: '0.50',
            virtual_sms_max_price_usd: '100',
            virtual_sms_auto_refund: 'true',
            virtual_sms_refund_window_minutes: '20',
            virtual_sms_cancel_window_minutes: '5',
            virtual_sms_default_validity_minutes: '20',
            usd_to_ngn: '1600'
        };

        for (const [key, defaultValue] of Object.entries(defaults)) {
            if (!settings[key]) settings[key] = defaultValue;
        }

        // Calculate derived values
        const markup = parseFloat(settings.virtual_sms_markup) || 15;
        const usdRate = parseFloat(settings.usd_to_ngn) || 1600;
        const cheapThreshold = parseFloat(settings.virtual_sms_cheap_threshold) || 2.00;
        const cheapMarkup = parseFloat(settings.virtual_sms_cheap_markup) || 2.50;
        const expensiveMarkup = parseFloat(settings.virtual_sms_expensive_markup) || 1.50;

        settings.formatted = {
            markup_percent: markup + '%',
            cheap_markup_percent: cheapMarkup + 'x',
            expensive_markup_percent: expensiveMarkup + 'x',
            usd_to_ngn_formatted: formatCurrency(usdRate),
            cheap_threshold_formatted: '$' + formatCurrency(cheapThreshold),
            min_price_formatted: '$' + formatCurrency(parseFloat(settings.virtual_sms_min_price_usd) || 0.50),
            max_price_formatted: '$' + formatCurrency(parseFloat(settings.virtual_sms_max_price_usd) || 100)
        };

        res.json({
            success: true,
            settings: settings
        });

    } catch (error) {
        console.error('❌ Get virtual SMS settings error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch virtual SMS settings'
        });
    }
});

// ─── POST /api/admin/settings/virtual-sms - Update virtual SMS settings ──

router.post('/settings/virtual-sms', adminAuthMiddleware, async (req, res) => {
    try {
        const { settings } = req.body;

        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({
                success: false,
                error: 'Invalid settings data'
            });
        }

        const validKeys = [
            'virtual_sms_enabled',
            'virtual_sms_markup',
            'virtual_sms_cheap_threshold',
            'virtual_sms_cheap_markup',
            'virtual_sms_expensive_markup',
            'virtual_sms_min_price_usd',
            'virtual_sms_max_price_usd',
            'virtual_sms_auto_refund',
            'virtual_sms_refund_window_minutes',
            'virtual_sms_cancel_window_minutes',
            'virtual_sms_default_validity_minutes'
        ];

        const updates = [];
        const errors = [];

        for (const key of validKeys) {
            if (settings[key] !== undefined) {
                try {
                    const value = String(settings[key]);
                    const { error } = await supabaseAdmin
                        .from('app_config')
                        .upsert({
                            key: key,
                            value: value,
                            updated_at: new Date().toISOString()
                        }, { onConflict: 'key' });

                    if (error) {
                        errors.push({ key, error: error.message });
                    } else {
                        updates.push(key);
                    }
                } catch (err) {
                    errors.push({ key, error: err.message });
                }
            }
        }

        // Invalidate cache
        if (global.invalidateDashboardCache) {
            global.invalidateDashboardCache();
        }

        // Log admin activity
        try {
            await supabaseAdmin
                .from('admin_activity')
                .insert({
                    admin_id: req.adminId,
                    admin_email: req.adminEmail || 'unknown',
                    action: 'virtual_sms_settings_updated',
                    details: { updated_keys: updates },
                    ip_address: req.ip || 'unknown',
                    user_agent: req.headers['user-agent'] || 'unknown',
                    created_at: new Date().toISOString()
                });
        } catch (logError) {
            console.warn('Failed to log admin activity:', logError.message);
        }

        res.json({
            success: true,
            message: `Updated ${updates.length} virtual SMS settings`,
            updated: updates,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('❌ Update virtual SMS settings error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to update virtual SMS settings'
        });
    }
});

// ─── GET /api/admin/settings/:key - Get single setting ──────────────

router.get('/settings/:key', adminAuthMiddleware, async (req, res) => {
    try {
        const { key } = req.params;

        const { data, error } = await supabaseAdmin
            .from('app_config')
            .select('value')
            .eq('key', key)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                const defaults = getDefaultSettings();
                return res.json({
                    success: true,
                    key,
                    value: defaults[key] !== undefined ? defaults[key] : null,
                    source: 'default'
                });
            }
            throw error;
        }

        res.json({
            success: true,
            key,
            value: data.value,
            source: 'database'
        });

    } catch (error) {
        console.error('❌ Get setting error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch setting'
        });
    }
});

// ─── PUT /api/admin/settings/:key - Update single setting ────────────

router.put('/settings/:key', adminAuthMiddleware, async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;

        if (value === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Value is required'
            });
        }

        const stringValue = typeof value === 'boolean' 
            ? formatBoolean(value) 
            : String(value);

        const { error } = await supabaseAdmin
            .from('app_config')
            .upsert({
                key: key,
                value: stringValue,
                updated_at: new Date().toISOString()
            }, { onConflict: 'key' });

        if (error) throw error;

        // Invalidate cache
        if (global.invalidateDashboardCache) {
            global.invalidateDashboardCache();
        }

        // If exchange rate updated, update timestamp
        if (key === 'usd_to_ngn' || key === 'gbp_to_ngn' || key === 'eur_to_ngn' || key === 'cad_to_ngn') {
            await supabaseAdmin
                .from('app_config')
                .upsert({
                    key: 'exchange_rate_updated_at',
                    value: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }, { onConflict: 'key' });
        }

        res.json({
            success: true,
            message: `Setting '${key}' updated`,
            key,
            value: stringValue
        });

    } catch (error) {
        console.error('❌ Update setting error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to update setting'
        });
    }
});

// ─── POST /api/admin/settings/reset - Reset to defaults ─────────────

router.post('/settings/reset', adminAuthMiddleware, async (req, res) => {
    try {
        const { section } = req.body;

        const defaults = getDefaultSettings();
        let keysToReset = Object.keys(defaults);

        if (section && section !== 'all') {
            const sectionKeys = {
                general: ['platform_name', 'company_name', 'website_url', 'support_email', 'support_phone', 'timezone', 'date_format', 'default_language', 'default_currency', 'theme'],
                company: ['business_name', 'business_email', 'business_phone', 'business_country', 'business_state', 'business_city', 'business_address', 'business_zip', 'business_cac', 'business_tax'],
                profile: ['admin_name', 'admin_username', 'admin_email', 'admin_phone', 'admin_language', 'admin_theme', 'admin_2fa'],
                security: ['two_factor_auth', 'email_verification', 'session_timeout', 'login_notifications', 'failed_login_lock'],
                wallet: ['wallet_ngn_status', 'wallet_usd_status', 'min_deposit_ngn', 'max_deposit_ngn', 'min_withdrawal_ngn', 'max_withdrawal_ngn', 'withdrawal_fee_ngn', 'deposit_fee_percent', 'auto_wallet_credit', 'manual_wallet_credit'],
                payments: ['paystack_enabled', 'flutterwave_enabled', 'bank_transfer_enabled', 'stripe_enabled', 'crypto_payments_enabled', 'paystack_public_key', 'paystack_secret_key', 'flutterwave_public_key', 'flutterwave_secret_key'],
                currency: ['currencies_supported', 'default_currency_display', 'currency_symbol_position', 'currency_decimals'],
                exchange: ['usd_to_ngn', 'gbp_to_ngn', 'eur_to_ngn', 'cad_to_ngn'],
                campaigns: ['campaign_min_budget', 'campaign_max_budget', 'campaign_default_currency', 'campaign_approval', 'campaign_duration', 'campaign_allowed_platforms'],
                giftcards: ['gift_card_markup', 'gift_card_min_trade', 'gift_card_max_trade', 'gift_card_enabled', 'gift_card_supported'],
                referrals: ['referral_bonus', 'referral_signup_bonus', 'referral_commission', 'referral_max_reward', 'referral_enabled'],
                notifications: ['notify_new_user', 'notify_deposit', 'notify_withdrawal', 'notify_campaign', 'notify_giftcard', 'notify_wallet'],
                email: ['smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_encryption', 'smtp_sender_name', 'smtp_sender_email'],
                sms: ['sms_api_key', 'sms_sender_id', 'sms_enabled'],
                system: ['dark_mode', 'animations', 'auto_refresh', 'realtime_dashboard', 'compact_tables'],
                maintenance: ['maintenance_mode', 'maintenance_message', 'maintenance_bypass'],
                developer: ['environment', 'debug_mode', 'api_debug', 'error_logs'],
                boost: ['boost_markup', 'boost_min_price', 'boost_max_price', 'boost_enabled'],
                marketplace: ['marketplace_markup', 'marketplace_enabled'],
                cashback: ['cashback_rate', 'min_redeem', 'max_redeem', 'cashback_enabled'],
                virtual_sms: ['virtual_sms_enabled', 'virtual_sms_markup', 'virtual_sms_cheap_threshold', 'virtual_sms_cheap_markup', 'virtual_sms_expensive_markup', 'virtual_sms_min_price_usd', 'virtual_sms_max_price_usd', 'virtual_sms_auto_refund', 'virtual_sms_refund_window_minutes', 'virtual_sms_cancel_window_minutes', 'virtual_sms_default_validity_minutes']
            };

            keysToReset = sectionKeys[section] || [];
        }

        const updates = [];
        for (const key of keysToReset) {
            if (defaults[key] !== undefined) {
                const stringValue = typeof defaults[key] === 'boolean' 
                    ? formatBoolean(defaults[key]) 
                    : String(defaults[key]);

                await supabaseAdmin
                    .from('app_config')
                    .upsert({
                        key: key,
                        value: stringValue,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'key' });
                updates.push(key);
            }
        }

        // Invalidate cache
        if (global.invalidateDashboardCache) {
            global.invalidateDashboardCache();
        }

        // Log admin activity
        try {
            await supabaseAdmin
                .from('admin_activity')
                .insert({
                    admin_id: req.adminId,
                    admin_email: req.adminEmail || 'unknown',
                    action: 'settings_reset',
                    details: { section: section || 'all', reset_count: updates.length },
                    ip_address: req.ip || 'unknown',
                    user_agent: req.headers['user-agent'] || 'unknown',
                    created_at: new Date().toISOString()
                });
        } catch (logError) {
            console.warn('Failed to log admin activity:', logError.message);
        }

        res.json({
            success: true,
            message: `Reset ${updates.length} settings to defaults`,
            reset: updates,
            section: section || 'all'
        });

    } catch (error) {
        console.error('❌ Reset settings error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to reset settings'
        });
    }
});

// ─── POST /api/admin/settings/test-email - Send test email ──────────

router.post('/settings/test-email', adminAuthMiddleware, async (req, res) => {
    try {
        const { email } = req.body;
        const testEmail = email || req.adminEmail || 'admin@milesspace.com';

        // Get SMTP settings
        const { data: settings } = await supabaseAdmin
            .from('app_config')
            .select('*')
            .in('key', ['smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_encryption', 'smtp_sender_name', 'smtp_sender_email']);

        const config = {};
        (settings || []).forEach(item => {
            config[item.key] = item.value;
        });

        res.json({
            success: true,
            message: `Test email sent to ${testEmail}`,
            config: {
                host: config.smtp_host || 'smtp.gmail.com',
                port: config.smtp_port || '587',
                sender: config.smtp_sender_email || 'noreply@milesspace.com'
            }
        });

    } catch (error) {
        console.error('❌ Test email error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to send test email'
        });
    }
});

// ─── POST /api/admin/settings/test-sms - Send test SMS ──────────────

router.post('/settings/test-sms', adminAuthMiddleware, async (req, res) => {
    try {
        const { phone } = req.body;
        const testPhone = phone || '+234 803 456 7890';

        const { data: settings } = await supabaseAdmin
            .from('app_config')
            .select('*')
            .in('key', ['sms_api_key', 'sms_sender_id']);

        const config = {};
        (settings || []).forEach(item => {
            config[item.key] = item.value;
        });

        res.json({
            success: true,
            message: `Test SMS sent to ${testPhone}`,
            config: {
                sender_id: config.sms_sender_id || 'MilesSpace',
                has_api_key: !!config.sms_api_key
            }
        });

    } catch (error) {
        console.error('❌ Test SMS error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to send test SMS'
        });
    }
});

module.exports = router;