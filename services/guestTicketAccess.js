// services/guestTicketAccess.js
// ─────────────────────────────────────────────────────────────────
// Guest ticket access tokens.
//
// Security model:
//   - Tokens are cryptographically random (32 bytes → 43 chars base64url).
//   - Only the SHA-256 hash is stored in the DB.
//   - Raw token is sent to the guest via email (or returned once on creation
//     for the immediate session — never stored client-side persistently).
//   - Comparison is constant-time.
//   - Tokens have an expiry.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateToken() {
    const raw = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const hash = hashToken(raw);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    return { raw, hash, expiresAt };
}

function hashToken(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function verifyToken(raw, storedHash) {
    if (!raw || !storedHash) return false;
    const computed = hashToken(raw);
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function isExpired(expiresAt) {
    if (!expiresAt) return true;
    return new Date(expiresAt).getTime() < Date.now();
}

module.exports = { generateToken, hashToken, verifyToken, isExpired, TOKEN_TTL_MS };