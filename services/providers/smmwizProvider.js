// services/providers/smmwizProvider.js
// ─────────────────────────────────────────────────────────────────
// SMMWiz provider adapter.
//
// IMPORTANT — SIGNATURE
//   SMMWiz's public documentation does not expose a webhook
//   signature scheme in the same way Paystack/Kora do. If SMMWiz
//   signs webhooks (HMAC header, shared secret, IP allowlist),
//   fill in `verifyWebhook()` below with the actual mechanism.
//
//   Until then, this adapter treats webhooks as unverified and
//   relies on:
//     • the unique (provider, event_id) index
//     • the state machine refusing invalid transitions
//     • a defensive re-query of the provider status before any
//       wallet operation runs
//
//   That is safer than accepting a webhook at face value, but you
//   should still configure the provider's own webhook secret once
//   you have it.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { ProviderError, notSupported } = require('./providerBase');

const NAME = 'smmwiz';
const API_URL = 'https://smmwiz.com/api/v2';

function apiKey() { return process.env.SMMWIZ_API_KEY || null; }
function isConfigured() { return Boolean(apiKey()); }

async function callApi(params) {
    if (!isConfigured()) {
        throw new ProviderError(
            'SMMWIZ_API_KEY is not set on this server.',
            { code: 'PROVIDER_NOT_CONFIGURED', httpStatus: 503 }
        );
    }
    let res;
    try {
        res = await axios.post(API_URL, null, {
            params: { key: apiKey(), ...params },
            timeout: 15000
        });
    } catch (err) {
        const status = err.response?.status;
        const ambiguous = !status || status >= 500;
        throw new ProviderError(
            err.response?.data?.error || err.message || 'Provider request failed',
            {
                code: status ? `HTTP_${status}` : 'NETWORK',
                ambiguous,
                httpStatus: 502,
                providerData: err.response?.data || null
            }
        );
    }
    if (res.data?.error) {
        throw new ProviderError(String(res.data.error), {
            code: 'PROVIDER_REJECTED',
            definitive: true,
            httpStatus: 422,
            providerData: res.data
        });
    }
    return res.data;
}

// ─── status normalization ────────────────────────────────────────

function normalizeStatus(providerStatus) {
    const s = String(providerStatus || '').toLowerCase().trim();
    if (!s) return null;
    if (s === 'pending') return 'pending';
    if (s === 'in progress' || s === 'in_progress') return 'in_progress';
    if (s === 'processing' || s === 'started') return 'processing';
    if (s === 'partial' || s === 'partially completed') return 'partial';
    if (s === 'completed' || s === 'complete' || s === 'finished' || s === 'done') return 'completed';
    if (s === 'canceled' || s === 'cancelled') return 'cancelled';
    if (s === 'failed' || s === 'error') return 'failed';
    if (s === 'refunded') return 'refunded';
    return null;
}

// ─── adapter methods ─────────────────────────────────────────────

async function getOrderStatus(order) {
    if (!order?.provider_order_id) return { status: null, raw: null };
    const data = await callApi({ action: 'status', order: order.provider_order_id });
    return {
        status: String(data?.status || '').toLowerCase() || null,
        start_count: data?.start_count ?? null,
        remains: data?.remains ?? null,
        charge: data?.charge ?? null,
        currency: data?.currency || null,
        raw: data
    };
}

async function createOrder({ serviceId, link, quantity }) {
    const data = await callApi({ action: 'add', service: serviceId, link, quantity });
    const providerOrderId = data?.order || data?.id;
    if (!providerOrderId) {
        throw new ProviderError('Provider did not return an order id.', {
            code: 'MISSING_PROVIDER_ORDER_ID',
            ambiguous: true
        });
    }
    return { providerOrderId: String(providerOrderId), raw: data };
}

async function cancelOrder() { return notSupported('SMMWIZ_CANCEL_NOT_DOCUMENTED'); }
async function refundOrder() { return notSupported('SMMWIZ_REFUND_NOT_DOCUMENTED'); }
async function getBalance() { return notSupported('SMMWIZ_BALANCE_NOT_DOCUMENTED'); }

// ─── webhook verification ────────────────────────────────────────
//
// REPLACE THIS with SMMWiz's real webhook verification once
// documented. Common patterns:
//
//   A. HMAC header
//        const sig = headers['x-smmwiz-signature'];
//        const expected = crypto.createHmac('sha256', secret)
//                               .update(rawBody).digest('hex');
//        return sig === expected;
//
//   B. Shared secret in payload
//        return payload.secret === process.env.SMMWIZ_WEBHOOK_SECRET;
//
//   C. IP allowlist — verify req.ip against a list.
//
// While this returns ok:true with signatureValid:false, webhook
// processing is still safe because:
//   • event_id uniqueness prevents double-processing
//   • order status is re-verified against the provider before any
//     wallet operation runs
//   • invalid transitions are rejected by the state machine

async function verifyWebhook({ payload }) {
    const secret = process.env.SMMWIZ_WEBHOOK_SECRET;

    if (!secret) {
        return {
            ok: true,
            signatureValid: false,
            reason: 'SMMWIZ_WEBHOOK_SECRET not set — payload accepted but unverified'
        };
    }

    // TODO: implement the real check. Example HMAC pattern:
    // const sig = String(headers?.['x-smmwiz-signature'] || '');
    // const expected = crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex');
    // return { ok: crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)), signatureValid: true };

    return {
        ok: true,
        signatureValid: false,
        reason: 'SMMWiz webhook verification is not yet implemented; secret present but unused'
    };
}

// ─── webhook payload parsing ─────────────────────────────────────
//
// SMMWiz webhooks are not documented publicly, so we accept several
// common shapes and pull out the fields we need. If SMMWiz sends a
// specific shape, tighten this function to match it exactly.

function parseWebhook(payload) {
    if (!payload || typeof payload !== 'object') {
        return { providerOrderId: null, status: null, eventType: null, raw: payload };
    }

    const providerOrderId = String(
        payload.order ||
        payload.order_id ||
        payload.orderId ||
        payload.id ||
        ''
    ) || null;

    const status = String(
        payload.status ||
        payload.state ||
        ''
    ).toLowerCase() || null;

    const eventType = String(
        payload.event ||
        payload.event_type ||
        payload.type ||
        (status ? `order.${status}` : '')
    ) || null;

    return { providerOrderId, status, eventType, raw: payload };
}

// ─── fingerprint for idempotency when no event_id is present ─────

function fingerprint(payload) {
    try {
        const stable = JSON.stringify(payload, Object.keys(payload || {}).sort());
        return crypto.createHash('sha256').update(stable).digest('hex');
    } catch {
        return null;
    }
}

// ─── health check ────────────────────────────────────────────────

async function healthCheck() {
    if (!isConfigured()) return { configured: false, reachable: false, lastError: 'SMMWIZ_API_KEY missing' };
    try {
        await callApi({ action: 'services' });
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