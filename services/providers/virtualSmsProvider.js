'use strict';

const crypto = require('crypto');
const {
    ProviderError, withTimeout, TIMEOUTS,
    HEALTH_STRATEGY, shapeProviderError, sanitizeProviderError
} = require('./providerBase');

const NAME = 'virtualsms';
const LABEL = 'VirtualSMS';
const BASE = 'https://api.virtualsms.de/stubs/handler_api';

function apiKey() { return process.env.VSMS_API_KEY || null; }
function isConfigured() { return Boolean(apiKey()); }

async function _call(params, { timeoutMs = TIMEOUTS.READ } = {}) {
    if (!isConfigured()) throw new ProviderError('VSMS_API_KEY is not set.', { code: 'PROVIDER_NOT_CONFIGURED', category: 'CONFIGURATION', httpStatus: 503 });

    const url = new URL(BASE);
    url.searchParams.append('api_key', apiKey());
    for (const [k, v] of Object.entries(params)) url.searchParams.append(k, String(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url.toString(), { signal: controller.signal, headers: { Accept: 'application/json, text/plain, */*' } });
        clearTimeout(timer);
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }

        if (!res.ok) {
            throw new ProviderError(`VirtualSMS HTTP ${res.status}`, {
                code: `HTTP_${res.status}`, httpStatus: 502,
                ambiguous: res.status >= 500, definitive: res.status >= 400 && res.status < 500,
                providerData: body
            });
        }
        if (typeof body === 'string' && /^[A-Z_]+$/.test(body.trim())) {
            throw new ProviderError(body.trim(), { code: body.trim(), category: 'VALIDATION', httpStatus: 422, definitive: true, providerData: body });
        }
        return body;
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') throw new ProviderError('VirtualSMS request timed out', { code: 'PROVIDER_TIMEOUT', category: 'TIMEOUT', ambiguous: true, httpStatus: 504 });
        if (e instanceof ProviderError) throw e;
        throw new ProviderError(sanitizeProviderError(e.message || 'VirtualSMS request failed', 300), { code: 'NETWORK', category: 'NETWORK', ambiguous: true, httpStatus: 502 });
    }
}

async function getCountries()     { return await _call({ action: 'getCountries' }); }
async function getServicesList(c) { return await _call({ action: 'getServicesList', country: c }); }
async function getPrices(c)       { return await _call({ action: 'getPrices', country: c }); }

async function getBalance() {
    try { return { supported: true, raw: await _call({ action: 'getBalance' }) }; }
    catch (e) { return { supported: false, error: sanitizeProviderError(e.message, 200) }; }
}

async function createOrder({ service, country, orderId }) {
    const data = await _call({ action: 'getNumberV2', service, country, orderId });
    const activationId = String(data?.activationId || data?.id || '');
    const phoneNumber  = data?.phoneNumber || data?.phone || '';
    if (!activationId || !phoneNumber) {
        throw new ProviderError('VirtualSMS did not return an activation id and phone number.', { code: 'INVALID_PROVIDER_RESPONSE', category: 'PROVIDER_5XX', ambiguous: true, httpStatus: 502, providerData: data });
    }
    return { providerOrderId: activationId, phoneNumber, cost: data?.activationCost ?? data?.cost ?? null, raw: data };
}

async function getOrderStatus(order) {
    const activationId = order?.provider_order_id || order?.activation_id;
    if (!activationId) return { status: null, raw: null };
    const data = await _call({ action: 'getStatusV2', id: activationId });
    const providerStatus = String(data?.status || '').toUpperCase();
    const mapped = providerStatus === 'STATUS_OK' ? 'completed'
                 : providerStatus === 'STATUS_CANCEL' ? 'cancelled'
                 : 'processing';
    return { status: mapped, providerStatus, code: data?.code || null, raw: data };
}

async function cancelOrder(order) {
    const activationId = order?.provider_order_id || order?.activation_id;
    if (!activationId) return { supported: false, reason: 'NO_ACTIVATION_ID' };
    return { supported: true, raw: await _call({ action: 'setStatus', id: activationId, status: 8 }) };
}

async function retryOrder(order) {
    const activationId = order?.provider_order_id || order?.activation_id;
    if (!activationId) return { supported: false, reason: 'NO_ACTIVATION_ID' };
    return { supported: true, raw: await _call({ action: 'setStatus', id: activationId, status: 3 }) };
}

async function refundOrder() { return { supported: false, reason: 'VIRTUALSMS_HAS_NO_PROVIDER_REFUND' }; }

function verifyWebhook({ payload, headers }) {
    const secret = process.env.VSMS_WEBHOOK_SECRET;
    if (!secret) {
        if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
            return { ok: false, signatureValid: false, reason: 'MISSING_WEBHOOK_SECRET' };
        }
        return { ok: true, signatureValid: false, reason: 'VSMS_WEBHOOK_SECRET not set — dev mode, accepted unverified' };
    }
    const sig = String(headers?.['x-vsms-signature'] || '').trim();
    if (!sig) return { ok: false, signatureValid: false, reason: 'MISSING_SIGNATURE' };
    const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(payload || {})).digest('hex');
    try {
        const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
        return { ok, signatureValid: true, reason: ok ? null : 'SIGNATURE_MISMATCH' };
    } catch {
        return { ok: false, signatureValid: false, reason: 'SIGNATURE_INVALID' };
    }
}

function parseWebhook(payload) {
    const providerOrderId = String(payload?.id || payload?.activationId || '').trim() || null;
    const status = String(payload?.status || '').toLowerCase() || null;
    return { providerOrderId, status, eventType: status ? `sms.${status}` : null, eventId: payload?.event_id ? String(payload.event_id) : null, raw: payload };
}

function normalizeStatus(providerStatus) {
    const s = String(providerStatus || '').toUpperCase();
    if (s === 'STATUS_OK') return 'completed';
    if (s === 'STATUS_CANCEL') return 'cancelled';
    return null;
}

function fingerprint(payload) {
    try {
        const id = payload?.id || payload?.activationId;
        if (id) return `vsms-${id}-${payload?.status || ''}`;
        const stable = JSON.stringify(payload, Object.keys(payload || {}).sort());
        return crypto.createHash('sha256').update(stable).digest('hex');
    } catch { return null; }
}

async function healthCheck() {
    if (!isConfigured()) {
        return {
            configured: false, reachable: false, authenticated: false, functional: false,
            healthStrategy: HEALTH_STRATEGY.BALANCE,
            errorCode: 'NOT_CONFIGURED', errorCategory: 'CONFIGURATION',
            errorMessage: 'VSMS_API_KEY missing'
        };
    }
    const started = Date.now();
    try {
        await withTimeout(() => _call({ action: 'getBalance' }, { timeoutMs: TIMEOUTS.HEALTH }), TIMEOUTS.HEALTH, 'virtualsms.healthCheck');
        return {
            configured: true, reachable: true, authenticated: true, functional: true,
            latencyMs: Date.now() - started,
            environment: 'live',
            healthStrategy: HEALTH_STRATEGY.BALANCE
        };
    } catch (e) {
        const shaped = shapeProviderError(e);
        const authFail = shaped.httpStatus === 401 || shaped.httpStatus === 403;
        return {
            configured: true, reachable: !authFail, authenticated: !authFail, functional: false,
            latencyMs: Date.now() - started,
            environment: 'live',
            healthStrategy: HEALTH_STRATEGY.BALANCE,
            errorCode: shaped.code,
            errorCategory: shaped.category,
            errorMessage: sanitizeProviderError(shaped.message, 300)
        };
    }
}

module.exports = {
    name: NAME, label: LABEL, isConfigured, healthCheck,
    healthStrategy: HEALTH_STRATEGY.BALANCE,
    getCountries, getServicesList, getPrices, getBalance,
    createOrder, getOrderStatus, cancelOrder, retryOrder, refundOrder,
    verifyWebhook, parseWebhook, normalizeStatus, fingerprint
};