// services/korapayService.js
// Handles all KoraPay HTTP communication. NO wallet credit lives here.
// The deposit completion + ledger flow lives in depositService.js.

const crypto = require('crypto');

// ─── CONFIG ─────────────────────────────────────────────────────
const KORA_API_URL      = (process.env.KORA_API_URL || 'https://api.korapay.com/merchant/api/v1').replace(/\/+$/, '');
const KORA_SECRET_KEY   = process.env.KORA_SECRET_KEY;
const KORA_TIMEOUT_MS   = parseInt(process.env.KORA_TIMEOUT_MS || '20000', 10);
const KORA_REDIRECT_URL = process.env.KORA_REDIRECT_URL || '';
const KORA_WEBHOOK_URL  = process.env.KORA_WEBHOOK_URL  || '';

if (!KORA_SECRET_KEY) {
    console.warn('⚠️  KORA_SECRET_KEY not set — KoraPay deposits will fail.');
}
if (!KORA_REDIRECT_URL) {
    console.warn('⚠️  KORA_REDIRECT_URL not set — Kora may reject checkout initialization.');
}
if (!KORA_WEBHOOK_URL) {
    console.warn('⚠️  KORA_WEBHOOK_URL not set — Kora may reject checkout initialization.');
}

// ─── CURRENCY MINOR-UNIT MAP ────────────────────────────────────
// Kora expects the amount in the MAJOR unit with 2 decimals for most
// currencies. Zero-decimal currencies are rounded to integer.
// NOTE: this is a sanity fallback. The authoritative currency config
// lives in MilesSpace's deposit_currencies table.
const ZERO_DECIMAL = new Set(['XAF', 'XOF', 'JPY', 'KRW', 'VND', 'CLP']);

function roundAmount(amount, currency) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
        throw Object.assign(new Error('Amount must be a positive number'), { code: 'INVALID_AMOUNT' });
    }
    const ccy = String(currency || '').toUpperCase();
    return ZERO_DECIMAL.has(ccy) ? Math.round(n) : Math.round(n * 100) / 100;
}

function authHeaders() {
    return {
        'Authorization': `Bearer ${KORA_SECRET_KEY}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
    };
}

async function timedFetch(url, options = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), KORA_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(t);
    }
}

// ─── PRE-FLIGHT VALIDATION ──────────────────────────────────────
function validateInitPayload(p) {
    const errors = [];

    if (!p.amount || !(Number(p.amount) > 0)) {
        errors.push('amount must be > 0');
    }
    if (!p.currency || !/^[A-Z]{3}$/.test(String(p.currency).toUpperCase())) {
        errors.push('currency must be a 3-letter ISO code');
    }
    if (!p.reference || String(p.reference).length < 5 || String(p.reference).length > 50) {
        errors.push('reference must be 5–50 chars');
    }
    if (!p.customer?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.customer.email)) {
        errors.push('customer.email invalid');
    }
    if (!KORA_REDIRECT_URL || !/^https?:\/\//i.test(KORA_REDIRECT_URL)) {
        errors.push('KORA_REDIRECT_URL must be an absolute http(s) URL');
    }
    if (!KORA_WEBHOOK_URL || !/^https?:\/\//i.test(KORA_WEBHOOK_URL)) {
        errors.push('KORA_WEBHOOK_URL must be an absolute http(s) URL');
    }
    if (!KORA_SECRET_KEY) {
        errors.push('KORA_SECRET_KEY missing');
    }

    if (errors.length) {
        const msg = 'Kora init payload invalid: ' + errors.join('; ');
        throw Object.assign(new Error(msg), { code: 'KORA_PAYLOAD_INVALID', details: errors });
    }
}

// ─── INITIALIZE CHECKOUT ────────────────────────────────────────
async function initializeCheckout({
    amount,
    currency,
    reference,
    customerName,
    customerEmail,
    narration,
    metadata = {},
    channels
}) {
    const ccy = String(currency || '').toUpperCase();
    const amt = roundAmount(amount, ccy);

    const payload = {
        amount: amt,
        currency: ccy,
        reference: String(reference),
        narration: narration || 'MilesSpace wallet deposit',
        redirect_url: KORA_REDIRECT_URL,
        notification_url: KORA_WEBHOOK_URL,
        customer: {
            name: String(customerName || 'MilesSpace Customer').slice(0, 80),
            email: String(customerEmail || '').trim().toLowerCase()
        },
        metadata: Object.fromEntries(
            Object.entries(metadata || {}).map(([k, v]) => [k, v == null ? '' : String(v)])
        )
    };
    if (channels && channels.length) payload.channels = channels;

    validateInitPayload(payload);

    // Sanitized log — never log the secret or the customer's email in full.
    console.log('[KORA] initialize →', {
        url: `${KORA_API_URL}/charges/initialize`,
        amount: payload.amount,
        currency: payload.currency,
        reference: payload.reference,
        redirect_url: payload.redirect_url,
        notification_url: payload.notification_url
    });

    const resp = await timedFetch(`${KORA_API_URL}/charges/initialize`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload)
    });

    const text = await resp.text().catch(() => '');
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!resp.ok || data?.status === false) {
        console.error('[KORA] initialize FAILED', {
            http_status: resp.status,
            kora_body: data,
            kora_raw: text?.slice(0, 500)
        });

        const koraMsg =
            data?.message ||
            data?.error ||
            (data?.errors ? JSON.stringify(data.errors) : null) ||
            `Kora init failed (HTTP ${resp.status})`;

        throw Object.assign(
            new Error(koraMsg),
            { status: resp.status, provider: data, code: 'KORA_INITIALIZATION_FAILED' }
        );
    }

    const d = data.data || data;
    return {
        checkout_url: d.checkout_url || d.checkoutUrl,
        reference:    d.reference    || payload.reference,
        raw:          data
    };
}

// ─── VERIFY TRANSACTION ─────────────────────────────────────────
// Amount is returned as a STRING so the DB can cast to NUMERIC without
// floating-point loss. Callers convert with Number() only when needed.
async function verifyTransaction(providerReference) {
    if (!providerReference) {
        throw Object.assign(new Error('verifyTransaction: providerReference required'), { code: 'MISSING_REFERENCE' });
    }

    const resp = await timedFetch(
        `${KORA_API_URL}/charges/${encodeURIComponent(providerReference)}`,
        { method: 'GET', headers: authHeaders() }
    );

    const text = await resp.text().catch(() => '');
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!resp.ok) {
        const msg = data?.message || `Kora verify failed (HTTP ${resp.status})`;
        throw Object.assign(new Error(msg), { status: resp.status, provider: data });
    }

    const tx = data.data || data;

    return {
        provider_status:    String(tx.status || '').toLowerCase(),
        amount:             String(tx.amount ?? '0'),
        currency:           String(tx.currency || '').toUpperCase(),
        reference:          tx.reference || null,
        payment_reference:  tx.payment_reference || null,
        raw:                tx
    };
}

// ─── PARSE WEBHOOK ──────────────────────────────────────────────
// No `charge.success` fallback. Missing event → treated as malformed,
// which the caller records but does NOT act on.
function parseWebhook(body) {
    const event = body?.event || body?.type || null;
    const data  = body?.data || body || {};

    return {
        event_type:          event,
        provider_reference:  data?.reference || data?.payment_reference || null,
        status:              String(data?.status || '').toLowerCase(),
        amount:              String(data?.amount ?? '0'),
        currency:            String(data?.currency || '').toUpperCase(),
        customer: {
            email: data?.customer?.email || null,
            name:  data?.customer?.name  || null
        },
        metadata:            data?.metadata || {},
        raw:                 data,
        provider_event_ref:  data?.id || data?.event_id || null
    };
}

// ─── VERIFY WEBHOOK SIGNATURE ───────────────────────────────────
// Kora signs JSON.stringify(req.body.data) with HMAC-SHA256 and puts
// the hex digest in `x-korapay-signature`.
function verifyWebhookSignature(payload, signatureHeader) {
    if (!signatureHeader) return false;
    if (!KORA_SECRET_KEY) return false;

    try {
        const expected = crypto
            .createHmac('sha256', KORA_SECRET_KEY)
            .update(JSON.stringify(payload))
            .digest('hex');

        const received = String(signatureHeader).trim().toLowerCase();
        const a = Buffer.from(expected, 'utf8');
        const b = Buffer.from(received, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch (e) {
        console.warn('[KORA] Signature verify error:', e.message);
        return false;
    }
}

module.exports = {
    initializeCheckout,
    verifyTransaction,
    parseWebhook,
    verifyWebhookSignature,
    roundAmount
};