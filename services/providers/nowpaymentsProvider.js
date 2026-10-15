'use strict';

const crypto = require('crypto');
const axios = require('axios');
const {
    ProviderError, notSupported, withTimeout, TIMEOUTS,
    HEALTH_STRATEGY, sanitizeProviderError
} = require('./providerBase');

const NAME = 'nowpayments';
const LABEL = 'NowPayments';

function apiKey()    { return process.env.NOWPAYMENTS_API_KEY || null; }
function ipnSecret() { return process.env.NOWPAYMENTS_IPN_SECRET || null; }
function isSandbox() { return String(process.env.NOWPAYMENTS_ENV || '').toLowerCase() === 'sandbox'; }
function baseUrl() {
    return isSandbox()
        ? 'https://api-sandbox.nowpayments.io/v1'
        : 'https://api.nowpayments.io/v1';
}
function isConfigured() { return Boolean(apiKey()); }

async function callApi(method, path, body = null, { timeoutMs = TIMEOUTS.READ } = {}) {
    if (!isConfigured()) {
        throw new ProviderError('NOWPAYMENTS_API_KEY is not set.', {
            code: 'PROVIDER_NOT_CONFIGURED', category: 'CONFIGURATION', httpStatus: 503
        });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await axios({
            method,
            url: `${baseUrl()}${path}`,
            data: body,
            headers: {
                'x-api-key': apiKey(),
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            signal: controller.signal,
            validateStatus: () => true,
            timeout: timeoutMs
        });
        clearTimeout(timer);
        if (res.status >= 400) {
            const msg = res.data?.message || res.data?.error || `NowPayments HTTP ${res.status}`;
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
            throw new ProviderError('NowPayments request timed out', {
                code: 'PROVIDER_TIMEOUT', category: 'TIMEOUT', ambiguous: true, httpStatus: 504
            });
        }
        throw e;
    }
}

function normalizeStatus(providerStatus) {
    const s = String(providerStatus || '').toLowerCase();
    if (s === 'finished' || s === 'confirmed') return 'completed';
    if (s === 'failed' || s === 'expired' || s === 'refunded') return 'failed';
    if (s === 'partially_paid') return 'partial';
    if (['waiting','confirming','sending','processing'].includes(s)) return 'processing';
    return null;
}

async function getOrderStatus(order) {
    if (!order?.provider_order_id) return { status: null, raw: null };
    const data = await callApi('GET', `/payment/${encodeURIComponent(order.provider_order_id)}`);
    return { status: data?.payment_status || null, raw: data };
}

async function createOrder() { return notSupported('NOWPAYMENTS_INIT_HANDLED_ELSEWHERE'); }
async function cancelOrder() { return notSupported('NOWPAYMENTS_CANCEL_NOT_SUPPORTED'); }
async function refundOrder() { return notSupported('NOWPAYMENTS_REFUND_NOT_IMPLEMENTED'); }

async function getBalance() {
    try {
        const data = await callApi('GET', '/balance');
        return { supported: true, raw: data };
    } catch (e) {
        return { supported: false, error: sanitizeProviderError(e.message, 200) };
    }
}

function verifyWebhook({ rawBody, headers }) {
    const signature = headers?.['x-nowpayments-sig'];
    if (!signature) return { ok: false, signatureValid: false, reason: 'MISSING_SIGNATURE' };
    if (!ipnSecret()) return { ok: false, signatureValid: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {});
    const expected = crypto.createHmac('sha512', ipnSecret()).update(bodyStr).digest('hex');
    const ok = signature === expected;
    return { ok, signatureValid: true, reason: ok ? null : 'SIGNATURE_MISMATCH' };
}

function parseWebhook(payload) {
    const providerOrderId = payload?.payment_id ? String(payload.payment_id)
        : (payload?.order_id ? String(payload.order_id) : null);
    const status = payload?.payment_status || null;
    const eventId = payload?.payment_id ? `np-${payload.payment_id}-${payload.payment_status}` : null;
    return { providerOrderId, status, eventType: status ? `payment.${status}` : null, eventId, raw: payload };
}

function fingerprint(payload) {
    try {
        const id = payload?.payment_id;
        if (id) return `np-${id}-${payload?.payment_status || ''}`;
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
            errorMessage: 'NOWPAYMENTS_API_KEY missing'
        };
    }
    const started = Date.now();
    const env = isSandbox() ? 'sandbox' : 'live';

    try {
        await withTimeout(
            () => callApi('GET', '/balance', null, { timeoutMs: TIMEOUTS.HEALTH }),
            TIMEOUTS.HEALTH,
            'nowpayments.healthCheck'
        );
        return {
            configured: true, reachable: true, authenticated: true, functional: true,
            latencyMs: Date.now() - started, environment: env,
            healthStrategy: HEALTH_STRATEGY.BALANCE
        };
    } catch (e1) {
        const s1 = e1.status || e1.response?.status;
        if (!s1) {
            return {
                configured: true, reachable: false, authenticated: false, functional: false,
                latencyMs: Date.now() - started, environment: env,
                healthStrategy: HEALTH_STRATEGY.BALANCE,
                errorCode: e1.code || 'HEALTH_FAILED',
                errorCategory: e1.category || 'NETWORK',
                errorMessage: sanitizeProviderError(e1.message, 300)
            };
        }
        if (s1 === 401 || s1 === 403) {
            return {
                configured: true, reachable: false, authenticated: false, functional: false,
                latencyMs: Date.now() - started, environment: env,
                healthStrategy: HEALTH_STRATEGY.BALANCE,
                errorCode: 'AUTH_FAILED', errorCategory: 'AUTHENTICATION',
                errorMessage: 'NowPayments rejected the API key'
            };
        }
    }

    try {
        await withTimeout(
            () => callApi('GET', '/status', null, { timeoutMs: TIMEOUTS.HEALTH }),
            TIMEOUTS.HEALTH,
            'nowpayments.healthCheck.status'
        );
        return {
            configured: true, reachable: true, authenticated: true, functional: true,
            latencyMs: Date.now() - started, environment: env,
            healthStrategy: HEALTH_STRATEGY.STATUS,
            note: '/balance failed but /status succeeded'
        };
    } catch (e2) {
        const s2 = e2.status || e2.response?.status;
        const authFail = s2 === 401 || s2 === 403;
        return {
            configured: true, reachable: !authFail, authenticated: !authFail, functional: false,
            latencyMs: Date.now() - started, environment: env,
            healthStrategy: HEALTH_STRATEGY.BALANCE,
            errorCode: e2.code || (s2 ? `HTTP_${s2}` : 'HEALTH_FAILED'),
            errorCategory: authFail ? 'AUTHENTICATION' : 'UNKNOWN',
            errorMessage: sanitizeProviderError(e2.message, 300)
        };
    }
}

module.exports = {
    name: NAME, label: LABEL, isConfigured, healthCheck,
    healthStrategy: HEALTH_STRATEGY.BALANCE,
    getOrderStatus, createOrder, cancelOrder, refundOrder, getBalance,
    verifyWebhook, parseWebhook, normalizeStatus, fingerprint
};