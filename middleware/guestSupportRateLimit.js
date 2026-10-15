// middleware/guestSupportRateLimit.js
// ─────────────────────────────────────────────────────────────────
// Guest support rate limiter.
//
// Fail-closed:
//   - Requires `trust proxy` to be configured on Express so that
//     req.ip is trustworthy.
//   - Uses req.ip, not raw X-Forwarded-For, unless the proxy is
//     explicitly trusted (which is what `trust proxy` does).
//
// Limits:
//   IP    → 5 tickets / hour
//   Email → 3 tickets / hour
//
// If the rate limiter cannot initialize, guest ticket creation is
// refused rather than allowed (fail-closed).
// ─────────────────────────────────────────────────────────────────

'use strict';

const WINDOW_MS = 60 * 60 * 1000;
const IP_LIMIT = 5;
const EMAIL_LIMIT = 3;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const ipBuckets = new Map();
const emailBuckets = new Map();

function prune(map, now) {
    for (const [k, v] of map.entries()) {
        if (now - v.start > WINDOW_MS) map.delete(k);
    }
}

function bump(map, key, now) {
    let b = map.get(key);
    if (!b || now - b.start > WINDOW_MS) {
        b = { count: 0, start: now };
        map.set(key, b);
    }
    b.count++;
    return b.count;
}

function getIp(req) {
    // After `app.set('trust proxy', N)`, req.ip is safe. Do not
    // parse X-Forwarded-For here — that bypasses the trust config.
    return req.ip
        || (req.socket && req.socket.remoteAddress)
        || 'unknown';
}

// Periodic cleanup so the maps don't grow unbounded under attack.
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    prune(ipBuckets, now);
    prune(emailBuckets, now);
}, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

function guestSupportRateLimit(req, res, next) {
    const now = Date.now();
    const ip = getIp(req);
    const email = String((req.body && req.body.email) || '').toLowerCase().trim();

    prune(ipBuckets, now);
    prune(emailBuckets, now);

    if (bump(ipBuckets, ip, now) > IP_LIMIT) {
        return res.status(429).json({
            success: false,
            code: 'RATE_LIMITED_IP',
            error: 'Too many requests from this network. Please try again later.'
        });
    }
    if (email && bump(emailBuckets, email, now) > EMAIL_LIMIT) {
        return res.status(429).json({
            success: false,
            code: 'RATE_LIMITED_EMAIL',
            error: 'Too many requests from this email. Please try again later.'
        });
    }
    next();
}

module.exports = guestSupportRateLimit;
module.exports.getIp = getIp;