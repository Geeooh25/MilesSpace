// services/providers/koraProvider.js
// ─────────────────────────────────────────────────────────────────
// KoraPay adapter — deposit funding + webhook verification.
//
// Signature: HMAC-SHA256 over `JSON.stringify(body.data)` using the
// secret key. Signature arrives in `x-korapay-signature`.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { ProviderError, notSupported } = require('./providerBase');

const NAME = 'korapay';

function secretKey() { return process.env.KORA_SECRET_KEY || null; }
function isConfigured() { return Boolean(secretKey()); }

async function callApi(method, path, body = null) {
    if (!isConfigured()) {
        throw new ProviderError('KORA_SECRET_KEY is not set.', { code: 'PROVIDER_NOT_CONFIGURED', httpStatus: 503 });
    }
    const base = process.env.KORA_API_URL || 'https://api.korapay.com/merchant/api/v1';
    const res = await axios({
        method,
        url: base + path,
        data: body,
        headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/json' },
        timeout: 20000
    });
    return res.data;
}

function normalizeStatus(providerStatus) {
    const s = String(providerStatus || '').toLowerCase();
    if (s === 'success' || s === 'successful' || s === 'completed') return 'completed';
    if (s === 'failed' || s === 'expired') return 'failed';
    if (s === 'pending' || s === 'processing') return 'processing';
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
async function getBalance() { return notSupported('KORA_BALANCE_NOT_IMPLEMENTED'); }

function verifyWebhook({ payload, headers }) {
    const signature = headers?.['x-korapay-signature'];
    if (!signature) return { ok: false, reason: 'MISSING_SIGNATURE' };
    if (!secretKey()) return { ok: false, reason: 'PROVIDER_NOT_CONFIGURED' };

    const data = payload?.data || {};
    const expected = crypto.createHmac('sha256', secretKey())
        .update(JSON.stringify(data))
        .digest('hex');

    const a = Buffer.from(String(signature), 'hex');
    const b = Buffer.from(expected, 'hex');
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, signatureValid: true, reason: ok ? null : 'SIGNATURE_MISMATCH' };
}

function parseWebhook(payload) {
    const data = payload?.data || {};
    const providerOrderId = data?.reference ? String(data.reference) : null;
    const status = data?.status || null;
    const eventId = payload?.event || null;   // Kora does not always send event_id
    const eventType = payload?.event || null;
    return { providerOrderId, status, eventType, eventId, raw: payload };
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

async function healthCheck() {
    if (!isConfigured()) return { configured: false, reachable: false, lastError: 'KORA_SECRET_KEY missing' };
    try {
        await callApi('GET', '/balances');
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