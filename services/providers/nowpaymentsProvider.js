// services/providers/nowpaymentsProvider.js
// ─────────────────────────────────────────────────────────────────
// NowPayments adapter — crypto deposits + IPN verification.
//
// Signature: HMAC-SHA512 over the RAW request body using the
// IPN secret. Header: `x-nowpayments-sig`.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { ProviderError, notSupported } = require('./providerBase');

const NAME = 'nowpayments';

function apiKey() { return process.env.NOWPAYMENTS_API_KEY || null; }
function ipnSecret() { return process.env.NOWPAYMENTS_IPN_SECRET || null; }
function isConfigured() { return Boolean(apiKey()); }

async function callApi(method, path, body = null) {
    if (!isConfigured()) {
        throw new ProviderError('NOWPAYMENTS_API_KEY is not set.', { code: 'PROVIDER_NOT_CONFIGURED', httpStatus: 503 });
    }
    const res = await axios({
        method,
        url: `https://api.nowpayments.io/v1${path}`,
        data: body,
        headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
        timeout: 20000
    });
    return res.data;
}

function normalizeStatus(providerStatus) {
    const s = String(providerStatus || '').toLowerCase();
    if (s === 'finished' || s === 'confirmed') return 'completed';
    if (s === 'failed' || s === 'expired' || s === 'refunded') return 'failed';
    if (s === 'partially_paid') return 'partial';
    if (s === 'waiting' || s === 'confirming' || s === 'sending' || s === 'processing') return 'processing';
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
        return { supported: false, error: e.message };
    }
}

function verifyWebhook({ rawBody, headers }) {
    const signature = headers?.['x-nowpayments-sig'];
    if (!signature) return { ok: false, reason: 'MISSING_SIGNATURE' };
    if (!ipnSecret()) return { ok: false, reason: 'PROVIDER_NOT_CONFIGURED' };

    const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {});
    const expected = crypto.createHmac('sha512', ipnSecret()).update(bodyStr).digest('hex');
    const ok = signature === expected;
    return { ok, signatureValid: true, reason: ok ? null : 'SIGNATURE_MISMATCH' };
}

function parseWebhook(payload) {
    const providerOrderId = payload?.payment_id ? String(payload.payment_id) : (payload?.order_id ? String(payload.order_id) : null);
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
    if (!isConfigured()) return { configured: false, reachable: false, lastError: 'NOWPAYMENTS_API_KEY missing' };
    try {
        await callApi('GET', '/status');
        return { configured: true, reachable: true, lastError: null };
    } catch (e) {
        return { configured: true, reachable: false, lastError: e.message };
    }
}

module.exports = {
    name: NAME, isConfigured,
    getOrderStatus, createOrder, cancelOrder, refundOrder, getBalance,
    verifyWebhook, parseWebhook, normalizeStatus, fingerprint, healthCheck
};