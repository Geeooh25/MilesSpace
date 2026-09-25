// services/providers/paystackProvider.js
// ─────────────────────────────────────────────────────────────────
// Paystack adapter — deposit funding + webhook verification.
//
// Signature: HMAC-SHA512 over the RAW request body, using the secret
// key as the HMAC key. The signature arrives in the
// `x-paystack-signature` header. This is Paystack's documented
// scheme; treat it as required, not optional.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { ProviderError, notSupported } = require('./providerBase');

const NAME = 'paystack';

function secretKey() { return process.env.PAYSTACK_SECRET_KEY || null; }
function isConfigured() { return Boolean(secretKey()); }

async function callApi(method, path, body = null) {
    if (!isConfigured()) {
        throw new ProviderError('PAYSTACK_SECRET_KEY is not set.', { code: 'PROVIDER_NOT_CONFIGURED', httpStatus: 503 });
    }
    const res = await axios({
        method,
        url: `https://api.paystack.co${path}`,
        data: body,
        headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/json' },
        timeout: 20000
    });
    return res.data;
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
    return {
        status: data?.data?.status || null,
        raw: data
    };
}

async function createOrder() {
    // Paystack uses /transaction/initialize, but the deposit initiator
    // already exists in this codebase. Return unsupported so the
    // pipeline doesn't try to call this.
    return notSupported('PAYSTACK_INIT_HANDLED_ELSEWHERE');
}

async function cancelOrder() { return notSupported('PAYSTACK_CANCEL_NOT_SUPPORTED'); }
async function refundOrder() { return notSupported('PAYSTACK_REFUND_NOT_IMPLEMENTED'); }
async function getBalance() { return notSupported('PAYSTACK_BALANCE_NOT_IMPLEMENTED'); }

function verifyWebhook({ rawBody, headers }) {
    const signature = headers?.['x-paystack-signature'];
    if (!signature) return { ok: false, reason: 'MISSING_SIGNATURE' };
    if (!secretKey()) return { ok: false, reason: 'PROVIDER_NOT_CONFIGURED' };

    const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {});
    const expected = crypto.createHmac('sha512', secretKey()).update(bodyStr).digest('hex');

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
    const eventType = payload?.event || null;
    const data = payload?.data || {};
    const providerOrderId = data?.reference ? String(data.reference) : null;
    const status = data?.status || null;
    const eventId = payload?.id ? String(payload.id) : null;
    return { providerOrderId, status, eventType, eventId, raw: payload };
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
    if (!isConfigured()) return { configured: false, reachable: false, lastError: 'PAYSTACK_SECRET_KEY missing' };
    try {
        await callApi('GET', '/balance');
        return { configured: true, reachable: true, lastError: null };
    } catch (e) {
        return { configured: true, reachable: false, lastError: e.message };
    }
}

module.exports = {
    name: NAME,
    isConfigured,
    getOrderStatus,
    createOrder,
    cancelOrder,
    refundOrder,
    getBalance,
    verifyWebhook,
    parseWebhook,
    normalizeStatus,
    fingerprint,
    healthCheck
};