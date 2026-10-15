'use strict';

const crypto = require('crypto');
const axios = require('axios');
const {
    ProviderError, notSupported, withTimeout, TIMEOUTS,
    HEALTH_STRATEGY, sanitizeProviderError
} = require('./providerBase');

const NAME = 'korapay';
const LABEL = 'KoraPay';

function secretKey() { return process.env.KORA_SECRET_KEY || null; }
function publicKey() { return process.env.KORA_PUBLIC_KEY || null; }
function baseUrl() {
    return (process.env.KORA_API_URL || 'https://api.korapay.com/merchant/api/v1').replace(/\/+$/, '');
}
function isConfigured() { return Boolean(secretKey()); }

async function callApi(method, path, body = null, { timeoutMs = TIMEOUTS.READ } = {}) {
    if (!isConfigured()) {
        throw new ProviderError('KORA_SECRET_KEY is not set.', {
            code: 'PROVIDER_NOT_CONFIGURED', category: 'CONFIGURATION', httpStatus: 503
        });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await axios({
            method,
            url: baseUrl() + path,
            data: body,
            headers: {
                Authorization: `Bearer ${secretKey()}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            signal: controller.signal,
            validateStatus: () => true,
            timeout: timeoutMs
        });
        clearTimeout(timer);
        if (res.status >= 400 && res.status !== 404) {
            const msg = res.data?.message || res.data?.error || `Kora HTTP ${res.status}`;
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
            throw new ProviderError('KoraPay request timed out', {
                code: 'PROVIDER_TIMEOUT', category: 'TIMEOUT', ambiguous: true, httpStatus: 504
            });
        }
        throw e;
    }
}

function normalizeStatus(providerStatus) {
    const s = String(providerStatus || '').toLowerCase();
    if (['success','successful','completed'].includes(s)) return 'completed';
    if (['failed','expired'].includes(s)) return 'failed';
    if (['pending','processing','initialized'].includes(s)) return 'processing';
    if (['cancelled','canceled'].includes(s)) return 'cancelled';
    return null;
}

async function getOrderStatus(order) {
    const ref = order?.provider_reference || order?.provider_order_id;
    if (!ref) return { status: null, raw: null };
    const data = await callApi('GET', `/charges/${encodeURIComponent(ref)}`);
    return { status: data?.data?.status || null, raw: data };
}

async function createOrder() { return notSupported('KORA_INIT_HANDLED_ELSEWHERE'); }
async function cancelOrder() { return notSupported('KORA_CANCEL_NOT_SUPPORTED'); }
async function refundOrder() { return notSupported('KORA_REFUND_NOT_IMPLEMENTED'); }

function verifyWebhook({ payload, headers }) {
    const signature = headers?.['x-korapay-signature'];
    if (!signature) return { ok: false, signatureValid: false, reason: 'MISSING_SIGNATURE' };
    if (!secretKey()) return { ok: false, signatureValid: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    const data = payload?.data || {};
    const expected = crypto.createHmac('sha256', secretKey()).update(JSON.stringify(data)).digest('hex');
    try {
        const a = Buffer.from(String(signature), 'hex');
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
        eventId: payload?.event ? `${payload.event}:${data.reference || ''}` : null,
        raw: payload
    };
}

function fingerprint(payload) {
    try {
        const data = payload?.data || {};
        const id = data.reference || data.transaction_reference;
        if (id) return `kora-${id}-${data.status || ''}`;
        const stable = JSON.stringify(payload, Object.keys(payload || {}).sort());
        return crypto.createHash('sha256').update(stable).digest('hex');
    } catch { return null; }
}

async function getBalance() {
    try {
        const data = await callApi('GET', '/balances');
        return { supported: true, raw: data?.data || data };
    } catch (e) {
        return { supported: false, error: sanitizeProviderError(e.message, 200) };
    }
}

// Health check: GET /charges/<probe-ref>. A 404 proves reachability
// and authentication without side effects.
async function healthCheck() {
    if (!isConfigured()) {
        return {
            configured: false, reachable: false, authenticated: false, functional: false,
            healthStrategy: HEALTH_STRATEGY.AUTHENTICATED_READ,
            errorCode: 'NOT_CONFIGURED', errorCategory: 'CONFIGURATION',
            errorMessage: 'KORA_SECRET_KEY missing'
        };
    }
    const started = Date.now();
    const probeRef = `MSPROBE-${Date.now().toString(36).toUpperCase()}`;
    try {
        await withTimeout(
            () => callApi('GET', `/charges/${encodeURIComponent(probeRef)}`, null, { timeoutMs: TIMEOUTS.HEALTH }),
            TIMEOUTS.HEALTH,
            'kora.healthCheck'
        );
        return {
            configured: true, reachable: true, authenticated: true, functional: true,
            latencyMs: Date.now() - started,
            environment: 'live',
            healthStrategy: HEALTH_STRATEGY.AUTHENTICATED_READ
        };
    } catch (e) {
        const status = e.status || e.response?.status;
        if (status === 404) {
            return {
                configured: true, reachable: true, authenticated: true, functional: true,
                latencyMs: Date.now() - started,
                environment: 'live',
                healthStrategy: HEALTH_STRATEGY.AUTHENTICATED_READ
            };
        }
        const authFail = status === 401 || status === 403;
        return {
            configured: true, reachable: !authFail, authenticated: !authFail, functional: false,
            latencyMs: Date.now() - started,
            environment: 'live',
            healthStrategy: HEALTH_STRATEGY.AUTHENTICATED_READ,
            errorCode: e.code || (status ? `HTTP_${status}` : 'HEALTH_FAILED'),
            errorCategory: authFail ? 'AUTHENTICATION' : 'UNKNOWN',
            errorMessage: sanitizeProviderError(e.message, 300)
        };
    }
}

module.exports = {
    name: NAME, label: LABEL, isConfigured, healthCheck,
    healthStrategy: HEALTH_STRATEGY.AUTHENTICATED_READ,
    getOrderStatus, createOrder, cancelOrder, refundOrder, getBalance,
    verifyWebhook, parseWebhook, normalizeStatus, fingerprint
};