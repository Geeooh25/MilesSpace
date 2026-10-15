'use strict';

// One scrubber for the whole codebase. Every audit write funnels
// through here so a developer cannot accidentally persist a secret
// by passing `before: providerConfig`.
//
// Also normalizes JSON so it is stable, bounded and safe to store.

const SENSITIVE_KEY_RE = /(password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|private[_-]?key|webhook[_-]?secret|mfa[_-]?secret|totp[_-]?secret|recovery[_-]?code|authorization|cookie|set-cookie|pin|cvv|cvc|pan|card[_-]?number|iban|account[_-]?number|sort[_-]?code|signature|session[_-]?id|bearer)/i;

// Keys we DO want to keep even if they look sensitive — they are
// identifiers, not secrets. This prevents over-redaction.
const SAFE_KEY_ALLOW = new Set([
    'session_id_hint',  // explicit non-secret hint field
    'request_id',
    'correlation_id'
]);

const MAX_STRING = 4000;
const MAX_DEPTH = 6;
const MAX_KEYS = 200;
const MAX_ARRAY = 200;

function isPlainObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v) &&
           (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function scrubString(s) {
    if (typeof s !== 'string') return s;
    let out = s;
    // Redact bearer tokens and inline secrets in free text.
    out = out.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
    out = out.replace(/(authorization\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
    out = out.replace(/(api[_-]?key\s*[:=]\s*)[^\s,;&]+/gi, '$1[REDACTED]');
    out = out.replace(/(secret\s*[:=]\s*)[^\s,;&]+/gi, '$1[REDACTED]');
    out = out.replace(/(password\s*[:=]\s*)[^\s,;&]+/gi, '$1[REDACTED]');
    out = out.replace(/(token\s*[:=]\s*)[^\s,;&]+/gi, '$1[REDACTED]');
    if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + '…[truncated]';
    return out;
}

function scrub(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
    if (typeof value === 'string') return scrubString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'function' || typeof value === 'symbol') return '[UNSERIALIZABLE]';
    if (typeof value === 'object') {
        if (seen.has(value)) return '[CYCLE]';
        seen.add(value);

        if (Array.isArray(value)) {
            return value.slice(0, MAX_ARRAY).map(v => scrub(v, depth + 1, seen));
        }

        if (!isPlainObject(value)) {
            // Errors, Buffers, streams — keep a safe summary only.
            if (value instanceof Error) {
                return { name: value.name, message: scrubString(value.message), code: value.code || null };
            }
            return '[OPAQUE_OBJECT]';
        }

        const out = {};
        let count = 0;
        for (const [k, v] of Object.entries(value)) {
            if (count >= MAX_KEYS) { out['__truncated__'] = true; break; }
            count++;
            const key = String(k);
            if (SENSITIVE_KEY_RE.test(key) && !SAFE_KEY_ALLOW.has(key.toLowerCase())) {
                out[key] = '[REDACTED]';
                continue;
            }
            out[key] = scrub(v, depth + 1, seen);
        }
        return out;
    }
    return value;
}

function scrubRecord(before, after) {
    return {
        before: before === undefined ? null : scrub(before),
        after:  after  === undefined ? null : scrub(after)
    };
}

// Convenience for free-text fields (reason, admin_note, failure message).
function scrubText(s, max = 500) {
    if (s === null || s === undefined) return null;
    const cleaned = scrubString(String(s)).replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, max);
}

// Convert any value to a JSON-safe, scrubbed object.
function safeJson(value) {
    try { return scrub(value); }
    catch { return null; }
}

module.exports = {
    scrub,
    scrubRecord,
    scrubText,
    safeJson,
    scrubString
};