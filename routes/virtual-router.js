// routes/virtual-router.js - COMPLETE PRODUCTION-READY VERSION
// ALL FEATURES:
// 1. ✅ Country listing with search
// 2. ✅ Services with prices (USD/NGN)
// 3. ✅ Multi-currency payment (NGN/USD)
// 4. ✅ Wallet balance check (NGN/USD)
// 5. ✅ Atomic wallet debit
// 6. ✅ Provider activation with orderId
// 7. ✅ Idempotency protection
// 8. ✅ Definite provider failures → refund
// 9. ✅ Correct cancellation (setStatus status=8)
// 10. ✅ Correct retry (setStatus status=3)
// 11. ✅ Order history with pagination
// 12. ✅ Active rental recovery
// 13. ✅ SMS status polling
// 14. ✅ Order events audit log
// 15. ✅ Reconciliation-ready
// 16. ✅ Admin settings (app_config)

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService } = require('../services/ledgerService');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────
const VSMS_BASE = 'https://api.virtualsms.de/stubs/handler_api';
const VSMS_API_KEY = process.env.VSMS_API_KEY || '';
const PROVIDER_TIMEOUT = 15000;
const CACHE_TTL = 5 * 60 * 1000;
const RECONCILIATION_INTERVAL = 2 * 60 * 1000;

// ─── IN-MEMORY CACHE ────────────────────────────────────────────────────
const cache = {
    countries: { data: null, timestamp: 0 },
    services: new Map(),
    settings: { data: null, timestamp: 0 },
    ttl: CACHE_TTL
};

// ─── GET SETTINGS (WITH FALLBACK) ──────────────────────────────────────
async function getSettings() {
    if (cache.settings.data && (Date.now() - cache.settings.timestamp) < CACHE_TTL) {
        return cache.settings.data;
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('app_config')
            .select('key, value');

        if (error) {
            console.warn('⚠️ [VSMS] Database settings error:', error.message);
            return getFallbackSettings();
        }

        const settings = {};
        (data || []).forEach(item => {
            settings[item.key] = item.value;
        });

        // Ensure required settings exist
        const defaults = {
            usd_to_ngn: '1600',
            boost_markup: '18',
            gift_card_markup: '10',
            virtual_sms_markup: '15',
            marketplace_markup: '20',
            cashback_rate: '5',
            min_redeem: '50',
            max_redeem: '100000',
            virtual_sms_enabled: 'true',
            virtual_sms_cheap_threshold: '2.00',
            virtual_sms_cheap_markup: '2.50',
            virtual_sms_expensive_markup: '1.50',
            virtual_sms_min_price_usd: '0.50',
            virtual_sms_max_price_usd: '100',
            virtual_sms_auto_refund: 'true',
            virtual_sms_refund_window_minutes: '20',
            virtual_sms_cancel_window_minutes: '5',
            virtual_sms_default_validity_minutes: '20'
        };

        for (const [key, defaultValue] of Object.entries(defaults)) {
            if (!settings[key]) {
                settings[key] = defaultValue;
            }
        }

        cache.settings.data = settings;
        cache.settings.timestamp = Date.now();
        return settings;

    } catch (error) {
        console.error('❌ [VSMS] Settings error:', error.message);
        return getFallbackSettings();
    }
}

function getFallbackSettings() {
    const fallback = {
        usd_to_ngn: '1600',
        boost_markup: '18',
        gift_card_markup: '10',
        virtual_sms_markup: '15',
        marketplace_markup: '20',
        cashback_rate: '5',
        min_redeem: '50',
        max_redeem: '100000',
        virtual_sms_enabled: 'true',
        virtual_sms_cheap_threshold: '2.00',
        virtual_sms_cheap_markup: '2.50',
        virtual_sms_expensive_markup: '1.50',
        virtual_sms_min_price_usd: '0.50',
        virtual_sms_max_price_usd: '100',
        virtual_sms_auto_refund: 'true',
        virtual_sms_refund_window_minutes: '20',
        virtual_sms_cancel_window_minutes: '5',
        virtual_sms_default_validity_minutes: '20'
    };

    cache.settings.data = fallback;
    cache.settings.timestamp = Date.now();
    console.warn('⚠️ [VSMS] Using fallback settings (usd_to_ngn: 1600)');
    return fallback;
}

// ─── PRICE CALCULATION ──────────────────────────────────────────────────
function calculatePrice(providerCost, settings) {
    const cost = parseFloat(providerCost) || 0;
    const rate = parseFloat(settings.usd_to_ngn) || 1600;
    const cheapThreshold = parseFloat(settings.virtual_sms_cheap_threshold) || 2.00;
    const cheapMarkup = parseFloat(settings.virtual_sms_cheap_markup) || 2.50;
    const expensiveMarkup = parseFloat(settings.virtual_sms_expensive_markup) || 1.50;

    const markup = cost < cheapThreshold ? cheapMarkup : expensiveMarkup;
    const usd = cost <= 0 ? 0 : +(cost * markup).toFixed(2);
    const ngn = +(usd * rate).toFixed(2);
    return { usd, ngn, rate, markup };
}

// ─── IDEMPOTENCY CHECK ──────────────────────────────────────────────────
async function checkIdempotency(userId, idempotencyKey) {
    if (!idempotencyKey) return null;

    const { data, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('id, status, created_at')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

    if (error) return null;
    return data;
}

// ─── MAP PROVIDER FAILURE ──────────────────────────────────────────────
function mapProviderFailure(error) {
    const body = String(error.providerBody || '').trim();
    const status = error.providerStatus || 0;

    // HTTP 4xx are definite failures
    if (status >= 400 && status < 500) {
        if (status === 429) {
            return { code: 'RATE_LIMITED', message: 'Provider is rate limiting. Please try again.', retryable: true, definiteFailure: false };
        }
        if (status === 401 || status === 403) {
            return { code: 'PROVIDER_AUTH_ERROR', message: 'Provider authentication error.', retryable: false, definiteFailure: true };
        }
        return { code: 'PROVIDER_ERROR', message: 'Service temporarily unavailable.', retryable: false, definiteFailure: true };
    }

    // Provider response codes
    switch (body) {
        case 'NO_NUMBERS':
            return { code: 'NO_NUMBERS', message: 'No numbers are currently available for this service.', retryable: false, definiteFailure: true, updateInventory: true };
        case 'NO_BALANCE':
            return { code: 'PROVIDER_NO_BALANCE', message: 'Provider is out of balance. Please try again later.', retryable: false, definiteFailure: true };
        case 'WRONG_SERVICE':
            return { code: 'WRONG_SERVICE', message: 'This service is currently unavailable.', retryable: false, definiteFailure: true };
        case 'WRONG_COUNTRY':
            return { code: 'WRONG_COUNTRY', message: 'This country is currently unavailable.', retryable: false, definiteFailure: true };
        case 'BAD_ACTION':
            return { code: 'BAD_ACTION', message: 'Invalid action requested.', retryable: false, definiteFailure: true };
        case 'BANNED':
            return { code: 'BANNED', message: 'This service has been banned.', retryable: false, definiteFailure: true };
        default:
            return { code: 'PROVIDER_ERROR', message: 'The SMS service is temporarily unavailable.', retryable: true, definiteFailure: false };
    }
}

// ════════════════════════════════════════════════════════════════════════
//  PROVIDER FETCHER WITH RESPONSE BODY CAPTURE
// ════════════════════════════════════════════════════════════════════════

let lastRequest = 0;

async function fetchProvider(params, retries = 2) {
    const now = Date.now();
    if (now - lastRequest < 1500) {
        await new Promise(r => setTimeout(r, 1500 - (now - lastRequest)));
    }
    lastRequest = Date.now();

    const url = new URL(VSMS_BASE);
    url.searchParams.append('api_key', VSMS_API_KEY);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.append(k, String(v));
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT);

        try {
            const response = await fetch(url.toString(), {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'User-Agent': 'MilesSpace/1.0'
                }
            });
            clearTimeout(timeout);

            const bodyText = await response.text();
            let body;
            try {
                body = JSON.parse(bodyText);
            } catch {
                body = bodyText;
            }

            if (!response.ok) {
                const error = new Error(`VirtualSMS HTTP ${response.status}`);
                error.providerStatus = response.status;
                error.providerBody = body;
                error.providerUrl = url.toString().replace(VSMS_API_KEY, 'REDACTED');

                console.error('❌ [VSMS] Provider error:', {
                    status: response.status,
                    body: body,
                    url: error.providerUrl
                });

                if (response.status >= 400 && response.status < 500) {
                    throw error;
                }

                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                    continue;
                }
                throw error;
            }

            return body;

        } catch (error) {
            clearTimeout(timeout);
            if (error.providerStatus && error.providerStatus >= 400 && error.providerStatus < 500) {
                throw error;
            }
            if (attempt >= retries) {
                console.error('❌ [VSMS] Provider request failed:', {
                    message: error.message,
                    status: error.providerStatus || null,
                    body: error.providerBody || null
                });
                throw error;
            }
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
    }
    throw new Error('PROVIDER_TIMEOUT');
}

// ─── CANCEL AND RETRY HELPERS ──────────────────────────────────────────

async function cancelWithProvider(activationId) {
    return await fetchProvider({
        action: 'setStatus',
        id: activationId,
        status: 8
    });
}

async function retryWithProvider(activationId) {
    return await fetchProvider({
        action: 'setStatus',
        id: activationId,
        status: 3
    });
}

// ─── ORDER EVENT LOGGER ────────────────────────────────────────────────
async function logOrderEvent(orderId, eventType, data = {}) {
    try {
        await supabaseAdmin
            .from('virtual_sms_order_events')
            .insert({
                order_id: orderId,
                event_type: eventType,
                old_status: data.oldStatus || null,
                new_status: data.newStatus || null,
                message: data.message || null,
                provider_response: data.providerResponse || null,
                metadata: data.metadata || {}
            });
    } catch (error) {
        console.warn('⚠️ Failed to log order event:', error.message);
    }
}

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/countries
// ════════════════════════════════════════════════════════════════════════

router.get('/countries', async (req, res) => {
    try {
        if (cache.countries.data && (Date.now() - cache.countries.timestamp) < CACHE_TTL) {
            return res.json(cache.countries.data);
        }

        const { data: dbCountries, error } = await supabaseAdmin
            .from('virtual_sms_countries')
            .select('id, name, flag, enabled, block_reason')
            .eq('enabled', true)
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true });

        if (!error && dbCountries && dbCountries.length > 0) {
            const countries = {};
            dbCountries.forEach(c => {
                countries[c.id] = {
                    id: c.id,
                    eng: c.name,
                    flag: c.flag || '🌐',
                    blocked: c.blocked || false,
                    block_reason: c.block_reason || null
                };
            });
            cache.countries.data = countries;
            cache.countries.timestamp = Date.now();
            return res.json(countries);
        }

        try {
            const data = await fetchProvider({ action: 'getCountries' });
            const countries = {};
            const entries = [];

            for (const [name, c] of Object.entries(data)) {
                if (c.visible === 1 || c.visible === '1' || c.visible === true) {
                    const id = parseInt(c.id);
                    const eng = c.eng || name;
                    // Block USA
                    if (eng === 'United States' && id !== 12) continue;
                    countries[id] = {
                        id,
                        eng,
                        flag: c.flag || getFlag(eng),
                        blocked: false,
                        block_reason: null
                    };
                    entries.push({
                        id,
                        name: eng,
                        flag: c.flag || getFlag(eng),
                        enabled: true,
                        sort_order: 0,
                        provider_name: 'virtualsms',
                        last_synced_at: new Date().toISOString()
                    });
                }
            }

            if (entries.length > 0) {
                await supabaseAdmin.from('virtual_sms_countries').upsert(entries, { onConflict: 'id' });
            }

            cache.countries.data = countries;
            cache.countries.timestamp = Date.now();
            return res.json(countries);
        } catch (providerError) {
            if (cache.countries.data) {
                return res.json(cache.countries.data);
            }
            throw providerError;
        }

    } catch (error) {
        console.error('❌ GET /countries error:', error.message);
        if (cache.countries.data) return res.json(cache.countries.data);
        res.status(500).json({ success: false, error: 'Failed to load countries' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/services-with-prices
// ════════════════════════════════════════════════════════════════════════

router.get('/services-with-prices', async (req, res) => {
    const countryId = req.query.country;
    if (!countryId) {
        return res.status(400).json({ success: false, error: 'country parameter required' });
    }

    if (parseInt(countryId) === 0 || parseInt(countryId) === 12) {
        return res.json({ success: true, services: [], blocked: true });
    }

    try {
        const cached = cache.services.get(String(countryId));
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            return res.json({ success: true, services: cached.data });
        }

        const { data: dbServices, error } = await supabaseAdmin
            .from('virtual_sms_services')
            .select('service_code, service_name, available_count, selling_price_usd, selling_price_ngn, provider_cost_usd')
            .eq('country_id', parseInt(countryId))
            .eq('enabled', true)
            .gt('available_count', 0)
            .order('service_name', { ascending: true });

        if (!error && dbServices && dbServices.length > 0) {
            const services = dbServices.map(s => ({
                code: s.service_code,
                name: s.service_name,
                count: s.available_count,
                sellingUSD: parseFloat(s.selling_price_usd) || 0,
                sellingNGN: parseFloat(s.selling_price_ngn) || 0,
                cost: parseFloat(s.provider_cost_usd) || 0,
                available: true
            }));
            cache.services.set(String(countryId), { data: services, timestamp: Date.now() });
            return res.json({ success: true, services });
        }

        try {
            const settings = await getSettings();
            const [svcData, priceData] = await Promise.all([
                fetchProvider({ action: 'getServicesList', country: countryId }),
                fetchProvider({ action: 'getPrices', country: countryId })
            ]);

            let rawServices = [];
            if (Array.isArray(svcData)) rawServices = svcData;
            else if (svcData?.services) rawServices = svcData.services;
            else if (typeof svcData === 'object') {
                rawServices = Object.entries(svcData)
                    .filter(([k]) => !['success', 'error', 'status'].includes(k))
                    .map(([code, info]) => ({ code, name: info?.name || code }));
            }

            const prices = priceData?.[String(countryId)] || priceData || {};

            const services = rawServices
                .map(s => {
                    const code = s.code || '';
                    const price = prices[code] || {};
                    const count = parseInt(price.count || 0);
                    const cost = parseFloat(price.cost || 0);
                    if (count <= 0 || cost <= 0) return null;
                    const calculated = calculatePrice(cost, settings);
                    return {
                        code,
                        name: s.name || code.toUpperCase(),
                        count,
                        sellingUSD: calculated.usd,
                        sellingNGN: calculated.ngn,
                        cost: cost,
                        available: true
                    };
                })
                .filter(Boolean)
                .sort((a, b) => a.name.localeCompare(b.name));

            if (services.length > 0) {
                const entries = services.map(s => ({
                    country_id: parseInt(countryId),
                    service_code: s.code,
                    service_name: s.name,
                    provider_cost_usd: parseFloat(prices[s.code]?.cost || 0),
                    selling_price_usd: s.sellingUSD,
                    selling_price_ngn: s.sellingNGN,
                    available_count: s.count,
                    enabled: true,
                    last_synced_at: new Date().toISOString()
                }));
                await supabaseAdmin.from('virtual_sms_services').upsert(entries, { onConflict: 'country_id,service_code' });
            }

            cache.services.set(String(countryId), { data: services, timestamp: Date.now() });
            return res.json({ success: true, services });

        } catch (providerError) {
            const cached = cache.services.get(String(countryId));
            if (cached && cached.data && cached.data.length > 0) {
                return res.json({ success: true, services: cached.data });
            }
            throw providerError;
        }

    } catch (error) {
        console.error(`❌ GET /services-with-prices error:`, error.message);
        const cached = cache.services.get(String(countryId));
        if (cached && cached.data && cached.data.length > 0) {
            return res.json({ success: true, services: cached.data });
        }
        res.json({ success: true, services: [] });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/virtual/order - Rent a number
// ════════════════════════════════════════════════════════════════════════

router.post('/order', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { country, service, currency = 'NGN' } = req.body;

        if (!country || !service) {
            return res.status(400).json({ success: false, error: 'country and service are required' });
        }

        // ─── Block USA ──────────────────────────────────────────────────
        if (parseInt(country) === 0 || parseInt(country) === 12) {
            return res.status(400).json({ success: false, error: 'United States is not supported', code: 'COUNTRY_BLOCKED' });
        }

        // ─── Get settings ──────────────────────────────────────────────
        const settings = await getSettings();

        // ─── Get service price ─────────────────────────────────────────
        let priceUsd = 0, priceNgn = 0, serviceName = service;
        let providerCost = 0;

        // Check database first
        const { data: serviceData } = await supabaseAdmin
            .from('virtual_sms_services')
            .select('service_name, selling_price_usd, selling_price_ngn, available_count, provider_cost_usd')
            .eq('country_id', parseInt(country))
            .eq('service_code', service)
            .eq('enabled', true)
            .maybeSingle();

        if (serviceData && serviceData.available_count > 0) {
            priceUsd = parseFloat(serviceData.selling_price_usd) || 0;
            priceNgn = parseFloat(serviceData.selling_price_ngn) || 0;
            serviceName = serviceData.service_name || service;
            providerCost = parseFloat(serviceData.provider_cost_usd) || 0;
        } else {
            // Fallback to provider
            try {
                const [svcData, priceData] = await Promise.all([
                    fetchProvider({ action: 'getServicesList', country }),
                    fetchProvider({ action: 'getPrices', country })
                ]);

                let rawServices = [];
                if (Array.isArray(svcData)) rawServices = svcData;
                else if (svcData?.services) rawServices = svcData.services;

                const found = rawServices.find(s => s.code === service);
                if (!found) {
                    return res.status(400).json({ success: false, error: 'Service not found', code: 'SERVICE_NOT_FOUND' });
                }

                serviceName = found.name || service;
                const prices = priceData?.[String(country)] || priceData || {};
                const price = prices[service] || {};
                const count = parseInt(price.count || 0);
                const cost = parseFloat(price.cost || 0);

                if (count <= 0 || cost <= 0) {
                    return res.status(400).json({ success: false, error: 'No numbers available', code: 'NO_INVENTORY' });
                }

                providerCost = cost;
                const calculated = calculatePrice(cost, settings);
                priceUsd = calculated.usd;
                priceNgn = calculated.ngn;
            } catch (providerError) {
                return res.status(503).json({
                    success: false,
                    error: 'Service temporarily unavailable',
                    code: 'PROVIDER_UNAVAILABLE'
                });
            }
        }

        if (priceUsd <= 0 || priceNgn <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid price for this service', code: 'INVALID_PRICE' });
        }

        // ─── Determine which currency to charge ────────────────────────
        let chargeAmount, chargeCurrency;
        if (currency === 'USD' && priceUsd > 0) {
            chargeAmount = priceUsd;
            chargeCurrency = 'USD';
        } else {
            chargeAmount = priceNgn;
            chargeCurrency = 'NGN';
        }

        if (chargeAmount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid charge amount', code: 'INVALID_PRICE' });
        }

        // ─── Check idempotency ──────────────────────────────────────────
        const idempotencyKey = req.headers['idempotency-key'] ||
            crypto.randomUUID?.() ||
            `${userId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

        const existingOrder = await checkIdempotency(userId, idempotencyKey);
        if (existingOrder) {
            return res.status(409).json({
                success: false,
                error: 'Duplicate request detected',
                code: 'DUPLICATE_REQUEST',
                data: { orderId: existingOrder.id, status: existingOrder.status }
            });
        }

        // ─── Check wallet balance ────────────────────────────────────────
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('wallet_ngn, wallet_usd')
            .eq('id', userId)
            .single();

        if (profileError || !profile) {
            return res.status(400).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
        }

        const walletNgn = parseFloat(profile.wallet_ngn) || 0;
        const walletUsd = parseFloat(profile.wallet_usd) || 0;

        console.log(`💰 [WALLET] NGN: ₦${walletNgn}, USD: $${walletUsd}, Charging: ${chargeCurrency} ${chargeAmount}`);

        let hasBalance = false;
        if (chargeCurrency === 'USD') {
            hasBalance = walletUsd >= chargeAmount;
        } else {
            hasBalance = walletNgn >= chargeAmount;
        }

        if (!hasBalance) {
            return res.status(400).json({
                success: false,
                error: `Insufficient ${chargeCurrency} balance. Required: ${chargeCurrency === 'USD' ? '$' : '₦'}${chargeAmount.toFixed(2)}, Available: ${chargeCurrency === 'USD' ? '$' : '₦'}${(chargeCurrency === 'USD' ? walletUsd : walletNgn).toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                data: {
                    required: chargeAmount,
                    available: chargeCurrency === 'USD' ? walletUsd : walletNgn,
                    currency: chargeCurrency,
                    wallet_ngn: walletNgn,
                    wallet_usd: walletUsd
                }
            });
        }

        // ─── Create order ──────────────────────────────────────────────
        const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
        const orderId = crypto.randomUUID();

        const { data: order, error: orderError } = await supabaseAdmin
            .from('virtual_sms_orders')
            .insert({
                id: orderId,
                user_id: userId,
                country_id: parseInt(country),
                service_code: service,
                service_name: serviceName,
                price_usd: priceUsd,
                price_ngn: priceNgn,
                provider_cost_usd: providerCost,
                charge_currency: chargeCurrency,
                charge_amount: chargeAmount,
                exchange_rate: parseFloat(settings.usd_to_ngn) || 1600,
                status: 'pending',
                idempotency_key: idempotencyKey,
                expires_at: expiresAt.toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                metadata: { source: 'api', currency_selected: currency }
            })
            .select()
            .single();

        if (orderError) {
            console.error('❌ Order creation error:', orderError);
            return res.status(500).json({ success: false, error: 'Failed to create order', code: 'ORDER_CREATE_FAILED' });
        }

        await logOrderEvent(orderId, 'order_created', {
            newStatus: 'pending',
            message: 'Order created',
            metadata: { country, service, priceUsd, priceNgn, chargeCurrency, chargeAmount }
        });

        // ─── Debit wallet ──────────────────────────────────────────────
        let debitResult;
        try {
            debitResult = await LedgerService.debitWallet(
                userId,
                chargeAmount,
                chargeCurrency,
                `Virtual SMS: ${serviceName} (${chargeCurrency})`,
                {
                    order_id: orderId,
                    service: 'virtual_sms',
                    service_code: service,
                    country_id: country,
                    price_usd: priceUsd,
                    price_ngn: priceNgn,
                    charge_currency: chargeCurrency,
                    charge_amount: chargeAmount
                }
            );

            if (!debitResult?.success) {
                throw new Error('Wallet debit failed');
            }

            console.log(`💳 [LEDGER] Debit result:`, {
                success: debitResult.success,
                transaction_id: debitResult.transaction_id,
                reference: debitResult.reference,
                amount: debitResult.amount,
                currency: chargeCurrency
            });

            if (!debitResult.transaction_id) {
                console.error('❌ No transaction_id in debit result:', debitResult);
                throw new Error('Debit result missing transaction_id');
            }

            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    ledger_transaction_id: debitResult.transaction_id,
                    status: 'processing',
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);

            await logOrderEvent(orderId, 'wallet_debited', {
                oldStatus: 'pending',
                newStatus: 'processing',
                message: `Wallet debited ${chargeCurrency} ${chargeAmount.toFixed(2)}`,
                metadata: {
                    transaction_id: debitResult.transaction_id,
                    reference: debitResult.reference,
                    currency: chargeCurrency
                }
            });

        } catch (debitError) {
            console.error('❌ Wallet debit error:', debitError);

            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    status: 'failed',
                    failure_message: debitError.message || 'Wallet debit failed',
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);

            return res.status(400).json({
                success: false,
                error: debitError.message || 'Insufficient balance',
                code: 'DEBIT_FAILED'
            });
        }

        // ─── Call provider ─────────────────────────────────────────────
        let providerResult;
        let providerError = null;

        try {
            console.log(`📡 [VSMS] Calling getNumberV2 for service ${service}, country ${country}`);
            console.log(`📡 [VSMS] Order ID: ${orderId}, Transaction ID: ${debitResult.transaction_id}`);

            providerResult = await fetchProvider({
                action: 'getNumberV2',
                service: service,
                country: country,
                orderId: orderId
            });

            const activationId = String(providerResult.activationId || providerResult.id || '');
            const phoneNumber = providerResult.phoneNumber || providerResult.phone || '';

            if (!activationId || !phoneNumber) {
                throw new Error('INVALID_PROVIDER_RESPONSE');
            }

            // ─── SUCCESS: Update order to active ──────────────────────
            const { error: updateError } = await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    activation_id: activationId,
                    phone_number: phoneNumber,
                    status: 'active',
                    activated_at: new Date().toISOString(),
                    provider_response: providerResult,
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);

            if (updateError) {
                console.error('❌ Failed to update order:', updateError);
                // Don't refund - provider already succeeded
                return res.status(500).json({
                    success: false,
                    error: 'Provider activated but database update failed. Support notified.',
                    code: 'DATABASE_UPDATE_FAILED',
                    data: { orderId, activationId, phoneNumber }
                });
            }

            await logOrderEvent(orderId, 'number_activated', {
                oldStatus: 'processing',
                newStatus: 'active',
                message: `Number activated: ${phoneNumber}`,
                providerResponse: providerResult,
                metadata: { activationId, phoneNumber }
            });

            return res.json({
                success: true,
                orderId: orderId,
                activationId: activationId,
                phoneNumber: phoneNumber,
                expiresAt: expiresAt.toISOString(),
                priceUsd: priceUsd,
                priceNgn: priceNgn,
                chargeCurrency: chargeCurrency,
                chargeAmount: chargeAmount,
                service: serviceName,
                status: 'active',
                transaction: {
                    id: debitResult.transaction_id,
                    reference: debitResult.reference
                }
            });

        } catch (error) {
            providerError = error;
            console.error('❌ Provider error:', error.message);
            if (error.providerBody) {
                console.error('❌ Provider response body:', JSON.stringify(error.providerBody));
            }
        }

        // ─── Handle provider failures ──────────────────────────────────
        const failure = mapProviderFailure(providerError);
        console.log(`🔄 [VSMS] Failure mapped:`, failure);

        // ─── Update inventory if NO_NUMBERS ────────────────────────────
        if (failure.code === 'NO_NUMBERS' && failure.updateInventory) {
            console.log(`🔄 [VSMS] Updating inventory for ${service} in country ${country} to 0`);
            try {
                await supabaseAdmin
                    .from('virtual_sms_services')
                    .update({
                        available_count: 0,
                        last_synced_at: new Date().toISOString()
                    })
                    .eq('country_id', parseInt(country))
                    .eq('service_code', service);
            } catch (invError) {
                console.warn('⚠️ Failed to update inventory:', invError.message);
            }
        }

        // ─── DEFINITE FAILURE: Refund the user ────────────────────────
        if (failure.definiteFailure) {
            console.log(`🔄 [VSMS] Definite failure, refunding user...`);
            console.log(`🔄 [VSMS] Transaction ID: ${debitResult.transaction_id}`);

            try {
                const refundResult = await LedgerService.refundTransaction(
                    userId,
                    debitResult.transaction_id,
                    `Virtual SMS failed: ${failure.code} - ${failure.message}`
                );

                console.log(`✅ [REFUND] Result:`, JSON.stringify(refundResult));

                if (!refundResult?.success && !refundResult?.alreadyRefunded) {
                    throw new Error('Refund failed');
                }

                const updateData = {
                    status: 'refunded',
                    refund_status: 'completed',
                    refund_transaction_id: refundResult.transaction_id,
                    refunded_at: new Date().toISOString(),
                    failure_code: failure.code,
                    failure_message: failure.message || providerError.message,
                    updated_at: new Date().toISOString()
                };

                await supabaseAdmin
                    .from('virtual_sms_orders')
                    .update(updateData)
                    .eq('id', orderId);

                await logOrderEvent(orderId, 'order_refunded', {
                    oldStatus: 'processing',
                    newStatus: 'refunded',
                    message: `Refunded: ${failure.message}`,
                    metadata: {
                        refund_transaction_id: refundResult.transaction_id,
                        failure_code: failure.code
                    }
                });

                return res.status(400).json({
                    success: false,
                    error: failure.message || 'Service temporarily unavailable. Your payment has been refunded.',
                    code: 'PROVIDER_FAILURE_REFUNDED',
                    data: {
                        orderId,
                        status: 'refunded',
                        refund_transaction_id: refundResult.transaction_id,
                        failure_code: failure.code
                    }
                });

            } catch (refundError) {
                console.error('❌ Refund error:', refundError);
                console.error('❌ Refund error stack:', refundError.stack);

                await supabaseAdmin
                    .from('virtual_sms_orders')
                    .update({
                        status: 'manual_review',
                        failure_code: failure.code,
                        failure_message: failure.message || providerError.message,
                        refund_status: 'failed',
                        failure_reason: refundError.message,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', orderId);

                return res.status(500).json({
                    success: false,
                    error: 'Payment failed. Support has been notified.',
                    code: 'MANUAL_REVIEW_NEEDED',
                    data: { orderId }
                });
            }
        }

        // ─── UNCERTAIN FAILURE: Keep as processing ──────────────────────
        console.log(`🔄 [VSMS] Uncertain failure, marking as processing for reconciliation`);

        await supabaseAdmin
            .from('virtual_sms_orders')
            .update({
                status: 'processing',
                failure_message: providerError.message || 'Provider request pending',
                provider_status: 'pending',
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);

        await logOrderEvent(orderId, 'provider_uncertain', {
            oldStatus: 'processing',
            newStatus: 'processing',
            message: `Provider uncertain: ${providerError.message}`,
            metadata: { error: providerError.message }
        });

        res.json({
            success: true,
            orderId: orderId,
            status: 'processing',
            message: 'Your order is being processed. Please wait.',
            expiresAt: expiresAt.toISOString(),
            priceUsd: priceUsd,
            priceNgn: priceNgn,
            chargeCurrency: chargeCurrency,
            chargeAmount: chargeAmount,
            transaction: {
                id: debitResult.transaction_id,
                reference: debitResult.reference
            }
        });

    } catch (error) {
        console.error('❌ POST /order error:', error);
        console.error('❌ POST /order error stack:', error.stack);
        res.status(500).json({ success: false, error: error.message || 'Failed to create order', code: 'ORDER_ERROR' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/orders - Get user's orders
// ════════════════════════════════════════════════════════════════════════

router.get('/orders', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);

        const { data: orders, error, count } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            if (error.code === '42P01') {
                return res.json({ success: true, orders: [], count: 0 });
            }
            throw error;
        }

        const countryIds = [...new Set(orders.map(o => o.country_id).filter(Boolean))];
        let countryMap = {};
        if (countryIds.length > 0) {
            const { data: countries } = await supabaseAdmin
                .from('virtual_sms_countries')
                .select('id, name')
                .in('id', countryIds);
            (countries || []).forEach(c => { countryMap[c.id] = c.name; });
        }

        const formattedOrders = orders.map(o => ({
            id: o.id,
            country: countryMap[o.country_id] || o.country_name || 'Unknown',
            service: o.service_name || o.service_code,
            phone: o.phone_number,
            price_usd: parseFloat(o.price_usd) || 0,
            price_ngn: parseFloat(o.price_ngn) || 0,
            charge_currency: o.charge_currency || 'NGN',
            charge_amount: parseFloat(o.charge_amount) || 0,
            status: o.status,
            sms_code: o.sms_code,
            created_at: o.created_at,
            expires_at: o.expires_at,
            completed_at: o.completed_at,
            cancelled_at: o.cancelled_at,
            refunded_at: o.refunded_at,
            ledger_transaction_id: o.ledger_transaction_id
        }));

        res.json({ success: true, orders: formattedOrders, pagination: { total: count || 0, limit, offset } });

    } catch (error) {
        console.error('❌ GET /orders error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to get orders' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/status - Check SMS status
// ════════════════════════════════════════════════════════════════════════

router.get('/status', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.query;

        if (!id) {
            return res.status(400).json({ success: false, error: 'id is required' });
        }

        const { data: order, error } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (error || !order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        if (order.sms_code) {
            return res.json({
                success: true,
                status: 'STATUS_OK',
                code: order.sms_code,
                sms_received_at: order.sms_received_at
            });
        }

        if (order.status === 'completed') {
            return res.json({ success: true, status: 'COMPLETED', code: order.sms_code });
        }

        if (order.status === 'cancelled' || order.status === 'expired' || order.status === 'refunded') {
            return res.json({ success: true, status: order.status.toUpperCase(), code: null });
        }

        if (!order.activation_id) {
            return res.json({ success: true, status: 'PENDING', code: null });
        }

        try {
            const providerResult = await fetchProvider({
                action: 'getStatusV2',
                id: order.activation_id
            });

            if (providerResult.status === 'STATUS_OK') {
                const smsCode = providerResult.code || providerResult.smsCode || '';
                if (smsCode) {
                    await supabaseAdmin
                        .from('virtual_sms_orders')
                        .update({
                            sms_code: smsCode,
                            status: 'sms_received',
                            sms_received_at: new Date().toISOString(),
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', order.id);

                    await logOrderEvent(order.id, 'sms_received', {
                        oldStatus: order.status,
                        newStatus: 'sms_received',
                        message: `SMS received: ${smsCode}`,
                        metadata: { smsCode }
                    });

                    return res.json({
                        success: true,
                        status: 'STATUS_OK',
                        code: smsCode,
                        sms_received_at: new Date().toISOString()
                    });
                }
            }

            return res.json({ success: true, status: providerResult.status || 'WAITING', code: null });

        } catch (providerError) {
            console.warn('⚠️ Provider status error:', providerError.message);
            return res.json({ success: true, status: 'WAITING', code: null });
        }

    } catch (error) {
        console.error('❌ GET /status error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to check status' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/virtual/cancel - Cancel rental (FIXED)
// ════════════════════════════════════════════════════════════════════════

router.post('/cancel', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ success: false, error: 'id is required' });
        }

        const { data: order, error } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (error || !order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        if (order.status === 'completed') {
            return res.status(400).json({ success: false, error: 'Cannot cancel a completed order', code: 'ORDER_COMPLETED' });
        }

        if (order.status === 'cancelled' || order.status === 'refunded') {
            return res.status(400).json({ success: false, error: 'Order already cancelled/refunded', code: 'ORDER_CANCELLED' });
        }

        const created = new Date(order.created_at);
        const elapsedMinutes = (Date.now() - created.getTime()) / 60000;

        if (elapsedMinutes < 5) {
            return res.status(400).json({
                success: false,
                error: `Cannot cancel within 5 minutes. Wait ${Math.ceil(5 - elapsedMinutes)} more minute(s).`,
                code: 'CANCEL_WINDOW',
                remainingMinutes: Math.ceil(5 - elapsedMinutes)
            });
        }

        // ─── Correct cancellation with setStatus ──────────────────────
        let cancelSuccess = false;
        if (order.activation_id) {
            try {
                const result = await cancelWithProvider(order.activation_id);
                if (result === 'ACCESS_CANCEL' || result.status === 'ACCESS_CANCEL') {
                    cancelSuccess = true;
                } else {
                    console.warn('⚠️ Cancel response:', result);
                }
            } catch (providerError) {
                console.error('❌ Provider cancel error:', providerError.message);
                return res.status(503).json({
                    success: false,
                    error: 'Provider cancellation failed. Please contact support.',
                    code: 'CANCEL_FAILED'
                });
            }
        } else {
            cancelSuccess = true;
        }

        if (!cancelSuccess) {
            return res.status(503).json({
                success: false,
                error: 'Provider cancellation failed. Please contact support.',
                code: 'CANCEL_FAILED'
            });
        }

        // ─── Process refund using creditWallet ────────────────────────
        try {
            // Use the charged amount and currency
            const refundAmount = parseFloat(order.charge_amount) || parseFloat(order.price_ngn) || 0;
            const refundCurrency = order.charge_currency || 'NGN';

            if (refundAmount <= 0) {
                throw new Error('Invalid refund amount');
            }

            console.log(`💸 [CANCEL] Refunding ${refundCurrency} ${refundAmount} for order ${order.id}`);

            const creditResult = await LedgerService.creditWallet(
                userId,
                refundAmount,
                refundCurrency,
                `Refund: Virtual SMS cancellation - ${order.service_name || order.service_code}`,
                {
                    order_id: order.id,
                    refund_reason: 'User cancellation',
                    original_amount: order.charge_amount,
                    original_currency: order.charge_currency
                }
            );

            if (!creditResult?.success) {
                throw new Error('Wallet credit failed');
            }

            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    status: 'refunded',
                    cancelled_at: new Date().toISOString(),
                    refund_status: 'completed',
                    refund_transaction_id: creditResult.transaction_id,
                    refunded_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', order.id);

            await logOrderEvent(order.id, 'order_cancelled_refunded', {
                oldStatus: order.status,
                newStatus: 'refunded',
                message: 'Order cancelled and refunded',
                metadata: { refund_transaction_id: creditResult.transaction_id }
            });

            res.json({
                success: true,
                message: `Order cancelled and refunded ${refundCurrency} ${refundAmount.toFixed(2)}`,
                refundTransactionId: creditResult.transaction_id,
                refundAmount: refundAmount,
                refundCurrency: refundCurrency
            });

        } catch (refundError) {
            console.error('❌ Refund error:', refundError);
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    status: 'manual_review',
                    cancelled_at: new Date().toISOString(),
                    refund_status: 'failed',
                    failure_message: refundError.message,
                    updated_at: new Date().toISOString()
                })
                .eq('id', order.id);

            res.status(500).json({
                success: false,
                error: 'Order cancelled but refund failed. Support notified.',
                code: 'REFUND_FAILED'
            });
        }

    } catch (error) {
        console.error('❌ POST /cancel error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to cancel order' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/virtual/retry - Resend SMS (FIXED)
// ════════════════════════════════════════════════════════════════════════

router.post('/retry', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ success: false, error: 'id is required' });
        }

        const { data: order, error } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (error || !order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        if (order.status === 'completed' || order.status === 'sms_received') {
            return res.status(400).json({ success: false, error: 'SMS already received', code: 'SMS_ALREADY_RECEIVED' });
        }

        if (order.status === 'cancelled' || order.status === 'expired' || order.status === 'refunded') {
            return res.status(400).json({ success: false, error: 'Cannot retry a cancelled/expired order', code: 'ORDER_INACTIVE' });
        }

        if (!order.activation_id) {
            return res.status(400).json({ success: false, error: 'No activation ID to retry', code: 'NO_ACTIVATION' });
        }

        try {
            const result = await retryWithProvider(order.activation_id);
            await logOrderEvent(order.id, 'sms_retry', {
                oldStatus: order.status,
                message: 'SMS resend requested',
                providerResponse: result
            });

            res.json({ success: true, message: 'SMS resend requested' });

        } catch (providerError) {
            console.error('❌ Retry provider error:', providerError.message);
            res.status(503).json({
                success: false,
                error: 'Provider temporarily unavailable',
                code: 'PROVIDER_UNAVAILABLE'
            });
        }

    } catch (error) {
        console.error('❌ POST /retry error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to retry SMS' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/active - Get active rental
// ════════════════════════════════════════════════════════════════════════

router.get('/active', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const { data: order, error } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*')
            .eq('user_id', userId)
            .in('status', ['processing', 'active', 'sms_received'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;

        if (!order) {
            return res.json({ success: true, active: false, order: null });
        }

        if (order.expires_at && new Date(order.expires_at) < new Date()) {
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({ status: 'expired', updated_at: new Date().toISOString() })
                .eq('id', order.id);
            return res.json({ success: true, active: false, order: null });
        }

        let countryName = order.country_name;
        if (!countryName) {
            const { data: country } = await supabaseAdmin
                .from('virtual_sms_countries')
                .select('name')
                .eq('id', order.country_id)
                .single();
            countryName = country?.name || 'Unknown';
        }

        res.json({
            success: true,
            active: true,
            order: {
                id: order.id,
                phone: order.phone_number,
                country: countryName,
                service: order.service_name || order.service_code,
                status: order.status,
                expiresAt: order.expires_at,
                smsCode: order.sms_code,
                createdAt: order.created_at,
                activatedAt: order.activated_at,
                charge_currency: order.charge_currency || 'NGN',
                charge_amount: parseFloat(order.charge_amount) || 0,
                ledger_transaction_id: order.ledger_transaction_id
            }
        });

    } catch (error) {
        console.error('❌ GET /active error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to get active rental' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/me - Current user
// ════════════════════════════════════════════════════════════════════════

router.get('/me', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const { data: user, error } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, wallet_ngn, wallet_usd, avatar_url, role, status')
            .eq('id', userId)
            .single();

        if (error || !user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        if (user.status === 'suspended') {
            return res.status(403).json({ success: false, error: 'Account suspended' });
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username || user.email?.split('@')[0] || 'User',
                email: user.email,
                avatar_url: user.avatar_url || null,
                wallet_usd: parseFloat(user.wallet_usd) || 0,
                wallet_ngn: parseFloat(user.wallet_ngn) || 0,
                role: user.role || 'user',
                isAdmin: user.role === 'admin' || user.role === 'super_admin'
            }
        });

    } catch (error) {
        console.error('❌ GET /me error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to get user info' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/health
// ════════════════════════════════════════════════════════════════════════

router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        cache: {
            countries: !!cache.countries.data,
            services: cache.services.size,
            settings: !!cache.settings.data
        }
    });
});

// ════════════════════════════════════════════════════════════════════════
//  FLAG MAP
// ════════════════════════════════════════════════════════════════════════

function getFlag(name) {
    const map = {
        'ukraine': '🇺🇦', 'united kingdom': '🇬🇧', 'germany': '🇩🇪',
        'france': '🇫🇷', 'spain': '🇪🇸', 'italy': '🇮🇹',
        'netherlands': '🇳🇱', 'poland': '🇵🇱', 'sweden': '🇸🇪',
        'ireland': '🇮🇪', 'austria': '🇦🇹', 'romania': '🇷🇴',
        'croatia': '🇭🇷', 'serbia': '🇷🇸', 'canada': '🇨🇦',
        'brazil': '🇧🇷', 'india': '🇮🇳', 'nigeria': '🇳🇬',
        'indonesia': '🇮🇩', 'philippines': '🇵🇭', 'vietnam': '🇻🇳',
        'egypt': '🇪🇬', 'south africa': '🇿🇦', 'kenya': '🇰🇪',
        'china': '🇨🇳', 'thailand': '🇹🇭', 'malaysia': '🇲🇾',
        'colombia': '🇨🇴', 'argentina': '🇦🇷'
    };
    if (!name) return '🌐';
    const key = name.toLowerCase().trim();
    if (map[key]) return map[key];
    for (const [k, v] of Object.entries(map)) {
        if (key.includes(k) || k.includes(key)) return v;
    }
    return '🌐';
}

module.exports = router;