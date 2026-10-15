'use strict';

const crypto = require('crypto');
const axios = require('axios');
const {
    ProviderError, notSupported, withTimeout, TIMEOUTS,
    HEALTH_STRATEGY, shapeProviderError, sanitizeProviderError
} = require('./providerBase');

const NAME = 'paystack';
const LABEL = 'Paystack';

function secretKey() { return process.env.PAYSTACK_SECRET_KEY || null; }
function webhookSec() { return process.env.PAYSTACK_WEBHOOK_SECRET || null; }
function isConfigured() { return Boolean(secretKey()); }

async function callApi(method, path, body = null, { timeoutMs = TIMEOUTS.READ } = {}) {
    if (!isConfigured()) {
        throw new ProviderError('PAYSTACK_SECRET_KEY is not set.', { code: 'PROVIDER_NOT_CONFIGURED', category: 'CONFIGURATION', httpStatus: 503 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await axios({
            method,
            url: `https://api.paystack.co${path}`,
            data: body,
            headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/json' },
            signal: controller.signal,
            validateStatus: () => true
        });
        clearTimeout(timer);
        if (res.status >= 400) {
            const msg = res.data?.message || `Paystack HTTP ${res.status}`;
            const err = new ProviderError(sanitizeProviderError(msg, 300), {
                code: `HTTP_${res.status}`,
                httpStatus: res.status,
                ambiguous: res.status >= 500,
                definitive: res.status >= 400 && res.status < 500,
                providerData: res.data
            });
            err.response = res;
            throw err;
        }
        return res.data;
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') {
            throw new ProviderError('Paystack request timed out', { code: 'PROVIDER_TIMEOUT', category: 'TIMEOUT', ambiguous: true, httpStatus: 504 });
        }
        throw e;
    }
}

function normalizeStatus(providerStatus) {
    const s = String(providerStatus || '').toLowerCase();
    if (s === 'success') return 'completed';
    if (s === 'failed' || s === 'abandoned') return 'failed';
    if (s === 'pending' || s === 'ongoing') return 'processing';
    if (s === 'reversed') return 'cancelled';
    return null;
}

async function getOrderStatus(order) {
    if (!order?.provider_reference) return { status: null, raw: null };
    const data = await callApi('GET', `/transaction/verify/${encodeURIComponent(order.provider_reference)}`);
    return { status: data?.data?.status || null, raw: data };
}

async function createOrder() { return notSupported('PAYSTACK_INIT_HANDLED_ELSEWHERE'); }
async function cancelOrder() { return notSupported('PAYSTACK_CANCEL_NOT_SUPPORTED'); }
async function refundOrder() { return notSupported('PAYSTACK_REFUND_NOT_IMPLEMENTED'); }

function verifyWebhook({ rawBody, headers }) {
    const signature = headers?.['x-paystack-signature'];
    if (!signature) return { ok: false, signatureValid: false, reason: 'MISSING_SIGNATURE' };
    const key = webhookSec() || secretKey();
    if (!key) return { ok: false, signatureValid: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {});
    const expected = crypto.createHmac('sha512', key).update(bodyStr).digest('hex');
    try {
        const a = Buffer.from(signature, 'hex');
        const b = Buffer.from(expected, 'hex');
        const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
        return { ok, signatureValid: true, reason: ok ? null : 'SIGNATURE_MISMATCH' };
    } catch {
        return { ok: false, signatureValid: false, reason: 'SIGNATURE_INVALID' };
    }
}

function parseWebhook(payload) {
    const data = payload?.data || {};
    return {
        providerOrderId: data?.reference ? String(data.reference) : null,
        status: data?.status || null,
        eventType: payload?.event || null,
        eventId: payload?.id ? String(payload.id) : null,
        raw: payload
    };
}

function fingerprint(payload) {
    try {
        const id = payload?.id || payload?.data?.id || payload?.data?.reference;
        if (id) return `paystack-${id}`;
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
            errorMessage: 'PAYSTACK_SECRET_KEY missing'
        };
    }
    const started = Date.now();
    try {
        await withTimeout(() => callApi('GET', '/balance', null, { timeoutMs: TIMEOUTS.HEALTH }), TIMEOUTS.HEALTH, 'paystack.healthCheck');
        return {
            configured: true, reachable: true, authenticated: true, functional: true,
            latencyMs: Date.now() - started,
            healthStrategy: HEALTH_STRATEGY.BALANCE
        };
    } catch (e) {
        const shaped = shapeProviderError(e);
        const authFail = shaped.httpStatus === 401 || shaped.httpStatus === 403;
        return {
            configured: true, reachable: !authFail, authenticated: !authFail, functional: false,
            latencyMs: Date.now() - started,
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
    getOrderStatus, createOrder, cancelOrder, refundOrder,
    verifyWebhook, parseWebhook, normalizeStatus, fingerprint
};