// services/mfaCrypto.js
// ─────────────────────────────────────────────────────────────────
// Authenticated encryption for TOTP secrets at rest.
//
// Cipher: AES-256-GCM (authenticated — tamper-evident)
// Key:    32 raw bytes, supplied as base64 in MFA_ENCRYPTION_KEY
// Nonce:  12 bytes, random per encryption, stored alongside ciphertext
// Format: v1:<base64(nonce)>:<base64(ciphertext)>:<base64(tag)>
//
// Key MUST come from env / secret manager. It is NEVER written to the
// database and NEVER sent to a browser. If MFA_ENCRYPTION_KEY is
// missing in production, the app must fail to start (see server.js).
//
// The "v1:" prefix allows future key rotation without ambiguity.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');

const KEY_B64 = process.env.MFA_ENCRYPTION_KEY;
if (!KEY_B64) {
    throw new Error(
        'MFA_ENCRYPTION_KEY is required. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
}

let KEY;
try {
    KEY = Buffer.from(KEY_B64, 'base64');
} catch {
    throw new Error('MFA_ENCRYPTION_KEY is not valid base64.');
}
if (KEY.length !== 32) {
    throw new Error(
        `MFA_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${KEY.length}). ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
}

const PREFIX = 'v1';
const NONCE_LEN = 12;
const TAG_LEN = 16;

function encrypt(plaintext) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
        throw new Error('encrypt() requires a non-empty string');
    }
    const nonce = crypto.randomBytes(NONCE_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}:${nonce.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

function decrypt(payload) {
    if (typeof payload !== 'string' || !payload.startsWith(`${PREFIX}:`)) {
        throw new Error('decrypt() received an unrecognised payload');
    }
    const parts = payload.split(':');
    if (parts.length !== 4) throw new Error('Malformed encrypted payload');
    const [, nonceB64, ctB64, tagB64] = parts;
    const nonce = Buffer.from(nonceB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (nonce.length !== NONCE_LEN || tag.length !== TAG_LEN) {
        throw new Error('Malformed encrypted payload (bad nonce/tag length)');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, nonce);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
}

// True if the string looks like one of our ciphertexts.
function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

module.exports = { encrypt, decrypt, isEncrypted };