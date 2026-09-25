// services/totpService.js
// ─────────────────────────────────────────────────────────────────
// TOTP (Google Authenticator / Authy / MS Authenticator compatible).
//
// Storage:  secrets are AES-256-GCM encrypted at rest via mfaCrypto.
//           Nothing in this file writes a plaintext TOTP secret.
//
// Library:  otplib@12 (pin to "^12.0.1" in package.json)
//
// API:
//   generateEnrollment(adminId, email)     -> { secret, secretEncrypted, otpauthUrl }
//   generateQrDataUrl(otpauthUrl)          -> Promise<string dataUrl>
//   verifyCode({ secretEncrypted, code })  -> boolean
//   verifyCodePlain(secret, code)          -> boolean   (enrollment only)
//   generateRecoveryCodes()                -> { plaintext, hashed }
//   verifyRecoveryCode(hashes, code)       -> { ok, remainingHashes }
//   hashRecoveryCode(code)                 -> string
//   constantTimeEqual(a, b)                -> boolean
//
// Never returns a plaintext TOTP secret after enrollment is complete.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { authenticator } = require('otplib');
const crypto = require('crypto');
const QRCode = require('qrcode');
const mfaCrypto = require('./mfaCrypto');

authenticator.options = {
    window: 1,          // ±1 step (30s each) — Google Authenticator default
    step: 30,
    digits: 6,
    algorithm: 'sha1'
};

const ISSUER = 'MilesSpace Admin';
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 5;    // 5 bytes → 10 hex chars → "XXXX-XXXX-XX"

// ─── Enrollment ─────────────────────────────────────────────────
function generateEnrollment(adminId, email) {
    const secret = authenticator.generateSecret();
    const accountLabel = email || adminId;
    const otpauthUrl = authenticator.keyuri(accountLabel, ISSUER, secret);
    const secretEncrypted = mfaCrypto.encrypt(secret);
    // NOTE: `secret` is returned so the admin can manually enter it
    // during enrollment. Callers MUST NOT persist it — persist only
    // `secretEncrypted`.
    return { secret, secretEncrypted, otpauthUrl };
}

async function generateQrDataUrl(otpauthUrl) {
    return QRCode.toDataURL(otpauthUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 240,
        color: { dark: '#0c3d4a', light: '#ffffff' }
    });
}

// ─── Verification ───────────────────────────────────────────────
// Encrypted-secret path — used for every runtime check.
function verifyCode({ secretEncrypted, code }) {
    if (!secretEncrypted || !code) return false;
    const clean = String(code).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean)) return false;
    let secret;
    try {
        secret = mfaCrypto.decrypt(secretEncrypted);
    } catch (e) {
        console.warn('[TOTP] decrypt failed:', e.message);
        return false;
    }
    try {
        return authenticator.check(clean, secret);
    } catch {
        return false;
    }
}

// Plaintext-secret path — ONLY used during enrollment while the
// pending secret is still in memory and about to be encrypted.
function verifyCodePlain(secret, code) {
    if (!secret || !code) return false;
    const clean = String(code).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean)) return false;
    try {
        return authenticator.check(clean, secret);
    } catch {
        return false;
    }
}

// ─── Recovery codes ─────────────────────────────────────────────
function generateRecoveryCodes() {
    const plaintext = [];
    const hashed = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        const raw = crypto.randomBytes(RECOVERY_CODE_BYTES).toString('hex').toUpperCase();
        const code = raw.match(/.{1,4}/g).join('-');   // XXXX-XXXX-XX
        plaintext.push(code);
        hashed.push(hashRecoveryCode(code));
    }
    return { plaintext, hashed };
}

function hashRecoveryCode(code) {
    const normalized = String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

function verifyRecoveryCode(hashArray, inputCode) {
    if (!Array.isArray(hashArray) || !inputCode) {
        return { ok: false, remainingHashes: hashArray || [] };
    }
    const target = hashRecoveryCode(inputCode);
    const idx = hashArray.findIndex(h => constantTimeEqual(h, target));
    if (idx === -1) return { ok: false, remainingHashes: hashArray };
    const remaining = hashArray.slice();
    remaining.splice(idx, 1);
    return { ok: true, remainingHashes: remaining };
}

function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
        return false;
    }
}

module.exports = {
    generateEnrollment,
    generateQrDataUrl,
    verifyCode,
    verifyCodePlain,
    generateRecoveryCodes,
    verifyRecoveryCode,
    hashRecoveryCode,
    constantTimeEqual,
    ISSUER,
    RECOVERY_CODE_COUNT,
    // Exposed so mfaRoutes can build the "reuse pending enrollment" otpauth URL
    authenticator
};