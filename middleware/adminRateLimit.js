// middleware/adminRateLimit.js
// ─────────────────────────────────────────────────────────────────
// Admin-specific rate limiting.
//
// Keys on admin_id (from the JWT subject) so a leaked admin token
// can't be used to DoS the DB from many IPs, and so a shared office
// IP with several admins doesn't lock everyone out when one admin
// hammers the API.
//
// Falls back to IP for unauthenticated requests (login attempts).
// IPv6 fallback uses the library's `ipKeyGenerator` helper, which
// normalizes IPv6 to a /64 bucket so an attacker can't rotate
// through 2^64 addresses to bypass limits.
// ─────────────────────────────────────────────────────────────────

const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

// express-rate-limit v7+ requires that any keyGenerator using
// `req.ip` normalizes it via `ipKeyGenerator`. If the export isn't
// available (older versions), fall back to a defensive inline
// normalizer so we never throw at startup.
let ipKeyGenerator;
try {
    ({ ipKeyGenerator } = require('express-rate-limit'));
} catch (_) {
    // Older versions don't export it — no-op passthrough.
    ipKeyGenerator = (ip) => String(ip || 'unknown');
}
if (typeof ipKeyGenerator !== 'function') {
    ipKeyGenerator = (ip) => String(ip || 'unknown');
}

/**
 * Return a stable key for the current request.
 *   - If a bearer token with a user id is present → `admin:<id>`
 *   - Otherwise → `ip:<normalized ip>`
 */
function extractAdminKey(req) {
    try {
        const auth = req.headers.authorization;
        if (auth?.startsWith('Bearer ')) {
            const decoded = jwt.decode(auth.slice(7));
            const id = decoded?.id || decoded?.userId || decoded?.sub;
            if (id) return `admin:${id}`;
        }
    } catch (_) { /* fall through */ }

    return `ip:${ipKeyGenerator(req.ip)}`;
}

// ─── General admin API limiter ───────────────────────────────────
const adminApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: extractAdminKey,
    message: {
        success: false,
        error: 'Too many admin API requests. Please slow down.',
        code: 'ADMIN_RATE_LIMIT'
    },
    skip: (req) => req.method === 'OPTIONS'
});

// ─── Admin login limiter ─────────────────────────────────────────
// IP-keyed because there's no admin_id on unauthenticated attempts.
// Uses ipKeyGenerator so IPv6 is normalized to a /64 bucket.
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `adminlogin:${ipKeyGenerator(req.ip)}`,
    message: {
        success: false,
        error: 'Too many admin login attempts. Please try again in 15 minutes.',
        code: 'ADMIN_LOGIN_RATE_LIMIT'
    }
});

// ─── Heavy endpoint limiter ──────────────────────────────────────
const adminHeavyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: extractAdminKey,
    message: {
        success: false,
        error: 'Too many requests to this heavy endpoint. Please wait.',
        code: 'ADMIN_HEAVY_RATE_LIMIT'
    }
});

module.exports = {
    adminApiLimiter,
    adminLoginLimiter,
    adminHeavyLimiter
};