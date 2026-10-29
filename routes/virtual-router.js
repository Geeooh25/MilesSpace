// routes/virtual-router.js
// ─────────────────────────────────────────────────────────────────
// USER-FACING Virtual SMS ROUTER.
//
// PRICING AUTHORITY:
//   The customer price is ALWAYS recomputed from admin settings
//   (adminSettingsService) on every request. The catalogue row
//   only provides the provider's wholesale USD cost. There is
//   no "selling_price_*" trust anywhere in this file.
//
// MONEY RULES:
//   • Debit before the provider call, via LedgerService.
//   • Provider definite failure → refund via LedgerService.
//   • Provider ambiguous failure → leave processing; scheduler resolves.
//
// GATES ENFORCED HERE (all from admin settings):
//   • service_virtual_sms_enabled       → whole-feature on/off
//   • usd_to_ngn                        → FX for NGN pricing
//   • virtual_sms_markup_pct            → customer markup
//   • virtual_sms_min_ngn / _max_ngn    → per-order limits (NGN equiv)
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService } = require('../services/ledgerService');
const adminSettings = require('../services/adminSettingsService');

// ─── CONFIG ──────────────────────────────────────────────────────────────
const VSMS_BASE = 'https://api.virtualsms.de/stubs/handler_api';
const VSMS_API_KEY = process.env.VSMS_API_KEY || '';
const PROVIDER_TIMEOUT = 15000;
const CACHE_TTL = 5 * 60 * 1000;

// ─── IN-MEMORY CACHE ────────────────────────────────────────────────────
// Country + service catalogue caches. NOT settings — settings are
// always read via adminSettingsService so an admin change takes
// effect immediately (up to its own 45s cache, invalidated on write).
const cache = {
    countries: { data: null, timestamp: 0 },
    services: new Map(),
    ttl: CACHE_TTL
};

// ─── ERROR HELPERS ─────────────────────────────────────────────────────
function makeErr(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    Object.assign(e, extra);
    return e;
}

function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'VIRTUAL_SMS_ERROR';
    const message = err?.message || 'Virtual SMS request failed.';
    const body = { success: false, error: message, code };
    if (err?.min_ngn !== undefined) body.min_ngn = err.min_ngn;
    if (err?.max_ngn !== undefined) body.max_ngn = err.max_ngn;
    if (err?.service) body.service = err.service;

    if (status >= 500) {
        console.error('[VIRTUAL SMS]', code, message);
    }
    res.status(status).json(body);
}

// ─── PRICING ────────────────────────────────────────────────────────────
// Compute the customer price for one catalogue row. Uses the SAME
// integer-cent math as virtualSmsService so the display and debit
// can never disagree.
async function resolvePrice({ providerCostUsd }) {
    const wholesaleUsd = Number(providerCostUsd);
    if (!Number.isFinite(wholesaleUsd) || wholesaleUsd <= 0) {
        throw makeErr('PROVIDER_COST_MISSING',
            'Provider cost is not configured for this service.', 503);
    }

    const calcUsd = await adminSettings.calculatePrice({
        service: 'virtual_sms',
        currency: 'USD',
        wholesaleAmount: wholesaleUsd.toFixed(2)
    });

    const priceUsd = Number(calcUsd.customerPrice);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        throw makeErr('PRICE_COMPUTE_FAILED',
            'Computed USD price is invalid.', 503);
    }

    const usdToNgn = await adminSettings.getRate('USD', 'NGN');
    if (!Number.isFinite(usdToNgn) || usdToNgn <= 0) {
        throw makeErr('RATE_NOT_CONFIGURED',
            'USD→NGN rate is not configured.', 503);
    }

    const priceNgn = Number((priceUsd * usdToNgn).toFixed(2));

    return {
        priceUsd,
        priceNgn,
        wholesaleUsd,
        usdToNgn,
        markup: calcUsd.markup
    };
}

async function assertWithinLimits({ chargeAmount, chargeCurrency, usdToNgn }) {
    const minNgn = Number(await adminSettings.getRaw('virtual_sms_min_ngn'));
    const maxNgn = Number(await adminSettings.getRaw('virtual_sms_max_ngn'));

    const ngnEquivalent = String(chargeCurrency).toUpperCase() === 'USD'
        ? Number(chargeAmount) * usdToNgn
        : Number(chargeAmount);

    if (Number.isFinite(minNgn) && minNgn > 0 && ngnEquivalent < minNgn) {
        throw makeErr('BELOW_MIN_LIMIT',
            `Minimum order for Virtual SMS is ₦${minNgn.toFixed(2)}.`,
            400, { min_ngn: minNgn });
    }
    if (Number.isFinite(maxNgn) && maxNgn > 0 && ngnEquivalent > maxNgn) {
        throw makeErr('ABOVE_MAX_LIMIT',
            `Maximum order for Virtual SMS is ₦${maxNgn.toFixed(2)}.`,
            400, { max_ngn: maxNgn });
    }
}

// ─── PROVIDER FETCHER ──────────────────────────────────────────────────
// Same behaviour as the old file: throttle, retries, timeout, body
// capture. Only thing changed is that we never leak api_key.
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
    const redactedUrl = url.toString().replace(VSMS_API_KEY || '__NOKEY__', 'REDACTED');

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
            try { body = JSON.parse(bodyText); } catch { body = bodyText; }

            if (!response.ok) {
                const error = new Error(`VirtualSMS HTTP ${response.status}`);
                error.providerStatus = response.status;
                error.providerBody = body;
                error.providerUrl = redactedUrl;

                console.error('[VSMS] provider error', {
                    status: response.status, body, url: redactedUrl
                });

                if (response.status >= 400 && response.status < 500) throw error;

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
                console.error('[VSMS] provider request failed', {
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

// ─── CANCEL / RETRY ────────────────────────────────────────────────────
async function cancelWithProvider(activationId) {
    return await fetchProvider({ action: 'setStatus', id: activationId, status: 8 });
}
async function retryWithProvider(activationId) {
    return await fetchProvider({ action: 'setStatus', id: activationId, status: 3 });
}

// ─── FAILURE MAPPING ───────────────────────────────────────────────────
function mapProviderFailure(error) {
    const body = String(error?.providerBody || '').trim();
    const status = error?.providerStatus || 0;

    if (status >= 400 && status < 500) {
        if (status === 429) {
            return { code: 'RATE_LIMITED', message: 'Provider is rate limiting. Please try again.', retryable: true, definiteFailure: false };
        }
        if (status === 401 || status === 403) {
            return { code: 'PROVIDER_AUTH_ERROR', message: 'Provider authentication error.', retryable: false, definiteFailure: true };
        }
        return { code: 'PROVIDER_ERROR', message: 'Service temporarily unavailable.', retryable: false, definiteFailure: true };
    }

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

// ─── EVENT LOGGING ─────────────────────────────────────────────────────
async function logOrderEvent(orderId, eventType, data = {}) {
    try {
        await supabaseAdmin.from('virtual_sms_order_events').insert({
            order_id: orderId,
            event_type: eventType,
            old_status: data.oldStatus || null,
            new_status: data.newStatus || null,
            message: data.message || null,
            provider_response: data.providerResponse || null,
            metadata: data.metadata || {}
        });
    } catch (error) {
        console.warn('[VSMS] failed to log order event:', error.message);
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
                    blocked: false,
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

            for (const [name, c] of Object.entries(data || {})) {
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
            if (cache.countries.data) return res.json(cache.countries.data);
            throw providerError;
        }

    } catch (error) {
        console.error('[VSMS] GET /countries error:', error.message);
        if (cache.countries.data) return res.json(cache.countries.data);
        res.status(500).json({ success: false, error: 'Failed to load countries' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/services-with-prices?country=XXX
// ════════════════════════════════════════════════════════════════════════

router.get('/services-with-prices', async (req, res) => {
    try {
        // Feature gate — admin can turn off Virtual SMS entirely.
        const enabled = await adminSettings.isServiceEnabled('virtual_sms');
        if (!enabled) {
            return res.json({
                success: true,
                services: [],
                enabled: false,
                reason: 'VIRTUAL_SMS_DISABLED'
            });
        }

        const countryId = parseInt(req.query.country);
        if (!Number.isFinite(countryId) || countryId <= 0) {
            return res.status(400).json({ success: false, error: 'country parameter required' });
        }

        if (countryId === 12) {
            return res.json({ success: true, services: [], blocked: true });
        }

        const cached = cache.services.get(String(countryId));
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            return res.json({ success: true, services: cached.data, enabled: true });
        }

        // Pull catalogue. provider_cost_usd is the ONLY money field
        // we trust from this table; the rest is ignored.
        const { data: dbServices, error } = await supabaseAdmin
            .from('virtual_sms_services')
            .select('service_code, service_name, available_count, provider_cost_usd')
            .eq('country_id', countryId)
            .eq('enabled', true)
            .gt('available_count', 0)
            .order('service_name', { ascending: true });

        let rawServices = [];
        if (!error && dbServices && dbServices.length > 0) {
            rawServices = dbServices.map(s => ({
                code: s.service_code,
                name: s.service_name,
                count: s.available_count,
                cost: parseFloat(s.provider_cost_usd) || 0
            }));
        } else {
            // Fallback: hit the provider, then upsert the catalogue
            // with the wholesale cost only.
            try {
                const [svcData, priceData] = await Promise.all([
                    fetchProvider({ action: 'getServicesList', country: countryId }),
                    fetchProvider({ action: 'getPrices', country: countryId })
                ]);

                let list = [];
                if (Array.isArray(svcData)) list = svcData;
                else if (svcData?.services) list = svcData.services;
                else if (typeof svcData === 'object') {
                    list = Object.entries(svcData)
                        .filter(([k]) => !['success', 'error', 'status'].includes(k))
                        .map(([code, info]) => ({ code, name: info?.name || code }));
                }

                const prices = priceData?.[String(countryId)] || priceData || {};

                rawServices = list.map(s => {
                    const code = s.code || '';
                    const price = prices[code] || {};
                    return {
                        code,
                        name: s.name || code.toUpperCase(),
                        count: parseInt(price.count || 0),
                        cost: parseFloat(price.cost || 0)
                    };
                }).filter(r => r.code && r.count > 0 && r.cost > 0);

                if (rawServices.length > 0) {
                    const entries = rawServices.map(s => ({
                        country_id: countryId,
                        service_code: s.code,
                        service_name: s.name,
                        provider_cost_usd: s.cost,
                        // selling_price_* are kept for backwards
                        // compatibility with any raw SQL reader; they
                        // are NOT used by this router.
                        available_count: s.count,
                        enabled: true,
                        last_synced_at: new Date().toISOString()
                    }));
                    await supabaseAdmin
                        .from('virtual_sms_services')
                        .upsert(entries, { onConflict: 'country_id,service_code' });
                }
            } catch (providerError) {
                if (cached?.data?.length > 0) {
                    return res.json({ success: true, services: cached.data, enabled: true });
                }
                throw providerError;
            }
        }

        // Compute the customer price for every row.
        const services = [];
        for (const row of rawServices) {
            try {
                const priced = await resolvePrice({ providerCostUsd: row.cost });
                services.push({
                    code: row.code,
                    name: row.name,
                    count: row.count,
                    sellingUSD: priced.priceUsd,
                    sellingNGN: priced.priceNgn,
                    cost: priced.wholesaleUsd,
                    markup: priced.markup,
                    usd_to_ngn: priced.usdToNgn,
                    available: true
                });
            } catch (err) {
                // Skip rows whose cost is broken so the whole catalogue
                // does not fail because of one bad row.
                console.warn('[VSMS] price resolve failed for', row.code, err.message);
            }
        }

        cache.services.set(String(countryId), { data: services, timestamp: Date.now() });
        return res.json({ success: true, services, enabled: true });

    } catch (error) {
        console.error('[VSMS] GET /services-with-prices error:', error.message);
        const cached = cache.services.get(String(req.query.country));
        if (cached?.data?.length > 0) {
            return res.json({ success: true, services: cached.data, enabled: true });
        }
        return res.json({ success: true, services: [], enabled: true });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/virtual/order — Rent a number
// ════════════════════════════════════════════════════════════════════════

router.post('/order', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { country, service, currency = 'NGN' } = req.body || {};

        if (!country || !service) {
            return res.status(400).json({ success: false, error: 'country and service are required' });
        }

        const countryId = parseInt(country);
        if (!Number.isFinite(countryId) || countryId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid country' });
        }
        if (countryId === 12) {
            return res.status(400).json({ success: false, error: 'United States is not supported', code: 'COUNTRY_BLOCKED' });
        }

        // 1. Feature gate.
        await adminSettings.assertServiceEnabled('virtual_sms');

        // 2. Fetch catalogue row — cost only, no trusted price.
        let providerCost = 0, serviceName = service;
        const { data: serviceData } = await supabaseAdmin
            .from('virtual_sms_services')
            .select('service_name, available_count, provider_cost_usd')
            .eq('country_id', countryId)
            .eq('service_code', service)
            .eq('enabled', true)
            .maybeSingle();

        if (serviceData && serviceData.available_count > 0 && Number(serviceData.provider_cost_usd) > 0) {
            providerCost = Number(serviceData.provider_cost_usd);
            serviceName = serviceData.service_name || service;
        } else {
            // Fallback to provider — one round trip.
            try {
                const [svcData, priceData] = await Promise.all([
                    fetchProvider({ action: 'getServicesList', country: countryId }),
                    fetchProvider({ action: 'getPrices', country: countryId })
                ]);

                let list = [];
                if (Array.isArray(svcData)) list = svcData;
                else if (svcData?.services) list = svcData.services;

                const found = list.find(s => s.code === service);
                if (!found) {
                    return res.status(400).json({ success: false, error: 'Service not found', code: 'SERVICE_NOT_FOUND' });
                }

                serviceName = found.name || service;
                const prices = priceData?.[String(countryId)] || priceData || {};
                const price = prices[service] || {};
                const count = parseInt(price.count || 0);
                const cost = parseFloat(price.cost || 0);

                if (count <= 0 || cost <= 0) {
                    return res.status(400).json({ success: false, error: 'No numbers available', code: 'NO_INVENTORY' });
                }
                providerCost = cost;
            } catch (providerError) {
                return res.status(503).json({
                    success: false,
                    error: 'Service temporarily unavailable',
                    code: 'PROVIDER_UNAVAILABLE'
                });
            }
        }

        // 3. Compute customer price from admin settings — the one
        //    authoritative step.
        const priced = await resolvePrice({ providerCostUsd: providerCost });

        const chargeCurrency = currency === 'USD' ? 'USD' : 'NGN';
        const chargeAmount = chargeCurrency === 'USD' ? priced.priceUsd : priced.priceNgn;

        // 4. Limits.
        await assertWithinLimits({
            chargeAmount,
            chargeCurrency,
            usdToNgn: priced.usdToNgn
        });

        // 5. Idempotency.
        const idempotencyKey = req.headers['idempotency-key'] ||
            crypto.randomUUID?.() ||
            `${userId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

        const existing = await checkIdempotency(userId, idempotencyKey);
        if (existing) {
            return res.status(409).json({
                success: false,
                error: 'Duplicate request detected',
                code: 'DUPLICATE_REQUEST',
                data: { orderId: existing.id, status: existing.status }
            });
        }

        // 6. Wallet pre-check (defence in depth — LedgerService is
        //    still the authority at debit time).
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
        const available = chargeCurrency === 'USD' ? walletUsd : walletNgn;

        if (available < chargeAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient ${chargeCurrency} balance. Required: ${chargeCurrency === 'USD' ? '$' : '₦'}${chargeAmount.toFixed(2)}, Available: ${chargeCurrency === 'USD' ? '$' : '₦'}${available.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                data: {
                    required: chargeAmount,
                    available,
                    currency: chargeCurrency,
                    wallet_ngn: walletNgn,
                    wallet_usd: walletUsd
                }
            });
        }

        // 7. Create order row.
        const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
        const orderId = crypto.randomUUID();

        const { data: order, error: orderError } = await supabaseAdmin
            .from('virtual_sms_orders')
            .insert({
                id: orderId,
                user_id: userId,
                country_id: countryId,
                service_code: service,
                service_name: serviceName,
                price_usd: priced.priceUsd,
                price_ngn: priced.priceNgn,
                provider_cost_usd: priced.wholesaleUsd,
                exchange_rate: priced.usdToNgn,
                charge_currency: chargeCurrency,
                charge_amount: chargeAmount,
                status: 'pending',
                idempotency_key: idempotencyKey,
                expires_at: expiresAt.toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                metadata: {
                    source: 'api',
                    currency_selected: currency,
                    markup_applied: priced.markup
                }
            })
            .select()
            .single();

        if (orderError) {
            console.error('[VSMS] order create error:', orderError);
            return res.status(500).json({ success: false, error: 'Failed to create order', code: 'ORDER_CREATE_FAILED' });
        }

        await logOrderEvent(orderId, 'order_created', {
            newStatus: 'pending',
            message: 'Order created',
            metadata: {
                country: countryId,
                service,
                priceUsd: priced.priceUsd,
                priceNgn: priced.priceNgn,
                markup: priced.markup,
                chargeCurrency,
                chargeAmount
            }
        });

        // 8. Debit via LedgerService.
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
                    country_id: countryId,
                    price_usd: priced.priceUsd,
                    price_ngn: priced.priceNgn,
                    charge_currency: chargeCurrency,
                    charge_amount: chargeAmount
                }
            );

            if (!debitResult?.success || !debitResult.transaction_id) {
                throw new Error('Wallet debit failed');
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
            console.error('[VSMS] debit error:', debitError);
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

        // 9. Call provider.
        let providerError = null;
        try {
            const providerResult = await fetchProvider({
                action: 'getNumberV2',
                service,
                country: countryId,
                orderId
            });

            const activationId = String(providerResult.activationId || providerResult.id || '');
            const phoneNumber = providerResult.phoneNumber || providerResult.phone || '';

            if (!activationId || !phoneNumber) throw new Error('INVALID_PROVIDER_RESPONSE');

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
                console.error('[VSMS] failed to persist activation:', updateError);
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
                orderId,
                activationId,
                phoneNumber,
                expiresAt: expiresAt.toISOString(),
                priceUsd: priced.priceUsd,
                priceNgn: priced.priceNgn,
                chargeCurrency,
                chargeAmount,
                service: serviceName,
                status: 'active',
                transaction: {
                    id: debitResult.transaction_id,
                    reference: debitResult.reference
                }
            });

        } catch (error) {
            providerError = error;
            console.error('[VSMS] provider error:', error.message);
            if (error.providerBody) {
                console.error('[VSMS] provider body:', JSON.stringify(error.providerBody));
            }
        }

        // 10. Handle failures.
        const failure = mapProviderFailure(providerError);

        if (failure.code === 'NO_NUMBERS' && failure.updateInventory) {
            try {
                await supabaseAdmin
                    .from('virtual_sms_services')
                    .update({
                        available_count: 0,
                        last_synced_at: new Date().toISOString()
                    })
                    .eq('country_id', countryId)
                    .eq('service_code', service);
            } catch (invError) {
                console.warn('[VSMS] failed to update inventory:', invError.message);
            }
        }

        if (failure.definiteFailure) {
            try {
                const refundResult = await LedgerService.refundTransaction(
                    userId,
                    debitResult.transaction_id,
                    `Virtual SMS failed: ${failure.code} - ${failure.message}`
                );

                if (!refundResult?.success && !refundResult?.alreadyRefunded) {
                    throw new Error('Refund failed');
                }

                await supabaseAdmin
                    .from('virtual_sms_orders')
                    .update({
                        status: 'refunded',
                        refund_status: 'completed',
                        refund_transaction_id: refundResult.transaction_id || null,
                        refunded_at: new Date().toISOString(),
                        failure_code: failure.code,
                        failure_message: failure.message || providerError.message,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', orderId);

                await logOrderEvent(orderId, 'order_refunded', {
                    oldStatus: 'processing',
                    newStatus: 'refunded',
                    message: `Refunded: ${failure.message}`,
                    metadata: {
                        refund_transaction_id: refundResult.transaction_id || null,
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
                        refund_transaction_id: refundResult.transaction_id || null,
                        failure_code: failure.code
                    }
                });

            } catch (refundError) {
                console.error('[VSMS] refund error:', refundError);
                await supabaseAdmin
                    .from('virtual_sms_orders')
                    .update({
                        status: 'manual_review',
                        failure_code: failure.code,
                        failure_message: failure.message || providerError.message,
                        refund_status: 'failed',
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

        // Ambiguous — keep processing, scheduler resolves.
        await supabaseAdmin
            .from('virtual_sms_orders')
            .update({
                status: 'processing',
                failure_message: providerError.message || 'Provider request pending',
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);

        await logOrderEvent(orderId, 'provider_uncertain', {
            oldStatus: 'processing',
            newStatus: 'processing',
            message: `Provider uncertain: ${providerError.message}`,
            metadata: { error: providerError.message }
        });

        return res.json({
            success: true,
            orderId,
            status: 'processing',
            message: 'Your order is being processed. Please wait.',
            expiresAt: expiresAt.toISOString(),
            priceUsd: priced.priceUsd,
            priceNgn: priced.priceNgn,
            chargeCurrency,
            chargeAmount,
            transaction: {
                id: debitResult.transaction_id,
                reference: debitResult.reference
            }
        });

    } catch (error) {
        console.error('[VSMS] POST /order error:', error);
        return sendErr(res, error);
    }
});

// ════════════════════════════════════════════════════════════════════════
//  Idempotency helper
// ════════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/orders
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

        const countryIds = [...new Set((orders || []).map(o => o.country_id).filter(Boolean))];
        let countryMap = {};
        if (countryIds.length > 0) {
            const { data: countries } = await supabaseAdmin
                .from('virtual_sms_countries')
                .select('id, name')
                .in('id', countryIds);
            (countries || []).forEach(c => { countryMap[c.id] = c.name; });
        }

        const formatted = (orders || []).map(o => ({
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

        res.json({
            success: true,
            orders: formatted,
            pagination: { total: count || 0, limit, offset }
        });

    } catch (error) {
        console.error('[VSMS] GET /orders error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to get orders' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/status
// ════════════════════════════════════════════════════════════════════════

router.get('/status', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.query;
        if (!id) return res.status(400).json({ success: false, error: 'id is required' });

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
        if (['cancelled', 'expired', 'refunded'].includes(order.status)) {
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
            console.warn('[VSMS] provider status error:', providerError.message);
            return res.json({ success: true, status: 'WAITING', code: null });
        }

    } catch (error) {
        console.error('[VSMS] GET /status error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to check status' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/virtual/cancel
// ════════════════════════════════════════════════════════════════════════

router.post('/cancel', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.body || {};
        if (!id) return res.status(400).json({ success: false, error: 'id is required' });

        const { data: order, error } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (error || !order) return res.status(404).json({ success: false, error: 'Order not found' });

        if (order.status === 'completed') {
            return res.status(400).json({ success: false, error: 'Cannot cancel a completed order', code: 'ORDER_COMPLETED' });
        }
        if (['cancelled', 'refunded'].includes(order.status)) {
            return res.status(400).json({ success: false, error: 'Order already cancelled/refunded', code: 'ORDER_CANCELLED' });
        }

        const elapsedMinutes = (Date.now() - new Date(order.created_at).getTime()) / 60000;
        if (elapsedMinutes < 5) {
            return res.status(400).json({
                success: false,
                error: `Cannot cancel within 5 minutes. Wait ${Math.ceil(5 - elapsedMinutes)} more minute(s).`,
                code: 'CANCEL_WINDOW',
                remainingMinutes: Math.ceil(5 - elapsedMinutes)
            });
        }

        let cancelSuccess = false;
        if (order.activation_id) {
            try {
                const result = await cancelWithProvider(order.activation_id);
                cancelSuccess = result === 'ACCESS_CANCEL' || result?.status === 'ACCESS_CANCEL';
                if (!cancelSuccess) console.warn('[VSMS] cancel response:', result);
            } catch (providerError) {
                console.error('[VSMS] provider cancel error:', providerError.message);
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

        try {
            const refundAmount = parseFloat(order.charge_amount) || parseFloat(order.price_ngn) || 0;
            const refundCurrency = order.charge_currency || 'NGN';
            if (refundAmount <= 0) throw new Error('Invalid refund amount');

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

            if (!creditResult?.success) throw new Error('Wallet credit failed');

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

            return res.json({
                success: true,
                message: `Order cancelled and refunded ${refundCurrency} ${refundAmount.toFixed(2)}`,
                refundTransactionId: creditResult.transaction_id,
                refundAmount,
                refundCurrency
            });

        } catch (refundError) {
            console.error('[VSMS] refund error:', refundError);
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

            return res.status(500).json({
                success: false,
                error: 'Order cancelled but refund failed. Support notified.',
                code: 'REFUND_FAILED'
            });
        }

    } catch (error) {
        console.error('[VSMS] POST /cancel error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to cancel order' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/virtual/retry
// ════════════════════════════════════════════════════════════════════════

router.post('/retry', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.body || {};
        if (!id) return res.status(400).json({ success: false, error: 'id is required' });

        const { data: order, error } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (error || !order) return res.status(404).json({ success: false, error: 'Order not found' });

        if (['completed', 'sms_received'].includes(order.status)) {
            return res.status(400).json({ success: false, error: 'SMS already received', code: 'SMS_ALREADY_RECEIVED' });
        }
        if (['cancelled', 'expired', 'refunded'].includes(order.status)) {
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
            return res.json({ success: true, message: 'SMS resend requested' });
        } catch (providerError) {
            console.error('[VSMS] retry provider error:', providerError.message);
            return res.status(503).json({
                success: false,
                error: 'Provider temporarily unavailable',
                code: 'PROVIDER_UNAVAILABLE'
            });
        }

    } catch (error) {
        console.error('[VSMS] POST /retry error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to retry SMS' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/active
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

        if (!order) return res.json({ success: true, active: false, order: null });

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
        console.error('[VSMS] GET /active error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to get active rental' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/me
// ════════════════════════════════════════════════════════════════════════

router.get('/me', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: user, error } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, wallet_ngn, wallet_usd, avatar_url, role, status')
            .eq('id', userId)
            .single();

        if (error || !user) return res.status(404).json({ success: false, error: 'User not found' });
        if (user.status === 'suspended') return res.status(403).json({ success: false, error: 'Account suspended' });

        return res.json({
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
        console.error('[VSMS] GET /me error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to get user info' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/virtual/health
// ════════════════════════════════════════════════════════════════════════

router.get('/health', async (req, res) => {
    let enabled = null;
    try { enabled = await adminSettings.isServiceEnabled('virtual_sms'); } catch {}
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service_enabled: enabled,
        cache: {
            countries: !!cache.countries.data,
            services: cache.services.size
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
    const key = String(name).toLowerCase().trim();
    if (map[key]) return map[key];
    for (const [k, v] of Object.entries(map)) {
        if (key.includes(k) || k.includes(key)) return v;
    }
    return '🌐';
}

module.exports = router;