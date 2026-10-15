'use strict';

class ProviderError extends Error {
    constructor(message, {
        code = 'PROVIDER_ERROR',
        category = null,
        ambiguous = false,
        definitive = false,
        httpStatus = 502,
        providerData = null,
        retryAfterMs = null
    } = {}) {
        super(message);
        this.name = 'ProviderError';
        this.code = code;
        this.category = category || categorize(code, httpStatus);
        this.ambiguous = ambiguous;
        this.definitive = definitive;
        this.status = httpStatus;
        this.providerData = providerData;
        this.retryAfterMs = retryAfterMs;
    }
}

function categorize(code, httpStatus) {
    if (code === 'PROVIDER_TIMEOUT') return 'TIMEOUT';
    if (code === 'NETWORK') return 'NETWORK';
    if (code === 'PROVIDER_NOT_CONFIGURED' || code === 'NOT_CONFIGURED' || code === 'INVALID_ENV') return 'CONFIGURATION';
    if (code === 'AUTH_FAILED') return 'AUTHENTICATION';
    if (code === 'CIRCUIT_OPEN') return 'CONFIGURATION';
    if (code === 'RATE_LIMIT') return 'RATE_LIMIT';
    if (httpStatus === 401) return 'AUTHENTICATION';
    if (httpStatus === 403) return 'AUTHORIZATION';
    if (httpStatus === 422) return 'VALIDATION';
    if (httpStatus === 429) return 'RATE_LIMIT';
    if (httpStatus >= 500) return 'PROVIDER_5XX';
    if (httpStatus >= 400) return 'PROVIDER_4XX';
    return 'UNKNOWN';
}

function notSupported(reason) {
    return { supported: false, reason: reason || 'NOT_SUPPORTED' };
}

const TIMEOUTS = Object.freeze({
    HEALTH:     8000,
    READ:       15000,
    WRITE:      30000,
    LONG_WRITE: 45000
});

// Health strategies — every adapter declares which one it uses.
// This makes the health contract explicit and auditable.
const HEALTH_STRATEGY = Object.freeze({
    AUTHENTICATED_READ: 'authenticated_read',
    BALANCE:            'balance',
    CATALOGUE:          'catalogue',
    STATUS:             'status'
});

function withTimeout(promiseFactory, ms, label = 'operation') {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new ProviderError(`${label} timed out after ${ms}ms`, {
                code: 'PROVIDER_TIMEOUT',
                category: 'TIMEOUT',
                ambiguous: true,
                httpStatus: 504
            }));
        }, ms);

        Promise.resolve()
            .then(promiseFactory)
            .then(v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } })
            .catch(e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    });
}

function shapeProviderError(err, fallback = 'Provider request failed') {
    const status = err?.response?.status || err?.status || null;
    const body = err?.response?.data || err?.providerData || null;
    const providerMessage =
        (body && (body.message || body.error || body.response_description)) ||
        err?.message ||
        fallback;

    return {
        code: err?.code || (status ? `HTTP_${status}` : 'NETWORK'),
        category: err?.category || categorize(err?.code, status),
        httpStatus: status,
        message: String(providerMessage).slice(0, 300),
        ambiguous: err?.ambiguous === true || (!status || status >= 500),
        definitive: err?.definitive === true || (status >= 400 && status < 500)
    };
}

// ─── Error redaction ────────────────────────────────────────────
// Any string that will be persisted to provider_health.error_message
// or logged goes through here first. Provider exception bodies can
// contain "Authorization: Bearer x", "api_key=...", "secret=...".
const SECRET_PATTERNS = [
    /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
    /(authorization\s*[:=]\s*)[^\s,;]+/gi,
    /(api[_-]?key\s*[:=]\s*)[^\s,;&]+/gi,
    /(secret\s*[:=]\s*)[^\s,;&]+/gi,
    /(password\s*[:=]\s*)[^\s,;&]+/gi,
    /(token\s*[:=]\s*)[^\s,;&]+/gi,
    /(x-api-key\s*[:=]\s*)[^\s,;&]+/gi
];

function redactSecrets(input) {
    if (input === null || input === undefined) return input;
    let s = String(input);
    for (const re of SECRET_PATTERNS) {
        s = s.replace(re, (_, prefix) => `${prefix}[REDACTED]`);
    }
    return s;
}

function sanitizeProviderError(message, maxLen = 500) {
    if (!message) return null;
    const cleaned = redactSecrets(String(message)).replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, maxLen);
}

const SENSITIVE_HEADER_PARTS = [
    'authorization', 'cookie', 'secret', 'api-key', 'api_key', 'apikey',
    'x-signature', 'x-hub-signature', 'x-korapay-signature',
    'x-paystack-signature', 'x-nowpayments-sig', 'x-vsms-signature',
    'x-smmwiz-signature'
];

function maskHeaders(headers) {
    if (!headers || typeof headers !== 'object') return null;
    const out = {};
    for (const k of Object.keys(headers)) {
        const lk = String(k).toLowerCase();
        if (SENSITIVE_HEADER_PARTS.some(p => lk.includes(p))) out[k] = '[MASKED]';
        else out[k] = headers[k];
    }
    return out;
}

function sanitizeDiagnostics({ httpStatus = null, providerCode = null, requestDurationMs = null, environment = null }) {
    return { httpStatus, providerCode, requestDurationMs, environment };
}

module.exports = {
    ProviderError,
    notSupported,
    withTimeout,
    TIMEOUTS,
    HEALTH_STRATEGY,
    maskHeaders,
    categorize,
    shapeProviderError,
    redactSecrets,
    sanitizeProviderError,
    sanitizeDiagnostics
};