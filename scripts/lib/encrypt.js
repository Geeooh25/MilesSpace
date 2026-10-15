// scripts/lib/encrypt.js
// AES-256-GCM file encryption using node:crypto.
// No OpenSSL, no 7-Zip, no external dependencies.
//
// Format: "MSBK1\n" + 12-byte nonce + 16-byte auth tag + ciphertext
// The magic header lets future versions detect and migrate.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const MAGIC = Buffer.from('MSBK1\n');         // MilesSpace BacKup v1
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const CHUNK_SIZE = 1024 * 1024;               // 1 MB streaming chunks

function deriveKey(passphrase) {
    if (!passphrase || typeof passphrase !== 'string') {
        throw new Error('Encryption passphrase must be a non-empty string');
    }
    // PBKDF2 with a fixed app salt. High iteration count for a
    // financial-grade workload. 600k ≈ 250ms on modern hardware.
    const salt = Buffer.from('milesspace-backup-v1-salt');
    return crypto.pbkdf2Sync(passphrase, salt, 600000, KEY_LEN, 'sha256');
}

function encryptFile(inputPath, outputPath, passphrase) {
    const key = deriveKey(passphrase);
    const nonce = crypto.randomBytes(NONCE_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);

    const inFd = fs.openSync(inputPath, 'r');
    const outFd = fs.openSync(outputPath, 'w');

    try {
        fs.writeSync(outFd, MAGIC);
        fs.writeSync(outFd, nonce);

        const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const n = fs.readSync(inFd, buffer, 0, CHUNK_SIZE, null);
            if (n === 0) break;
            const chunk = buffer.subarray(0, n);
            const enc = cipher.update(chunk);
            if (enc.length) fs.writeSync(outFd, enc);
        }

        const final = cipher.final();
        if (final.length) fs.writeSync(outFd, final);

        const tag = cipher.getAuthTag();
        fs.writeSync(outFd, tag);
    } finally {
        fs.closeSync(inFd);
        fs.closeSync(outFd);
    }
}

function decryptFile(inputPath, outputPath, passphrase) {
    const key = deriveKey(passphrase);
    const stat = fs.statSync(inputPath);
    if (stat.size < MAGIC.length + NONCE_LEN + TAG_LEN + 1) {
        throw new Error('Encrypted file is too small to be valid');
    }

    const inFd = fs.openSync(inputPath, 'r');
    const outFd = fs.openSync(outputPath, 'w');

    try {
        const header = Buffer.alloc(MAGIC.length);
        fs.readSync(inFd, header, 0, MAGIC.length, 0);
        if (!header.equals(MAGIC)) {
            throw new Error('File is not a MilesSpace backup (bad magic header)');
        }

        const nonce = Buffer.alloc(NONCE_LEN);
        fs.readSync(inFd, nonce, 0, NONCE_LEN, MAGIC.length);

        const cipherStart = MAGIC.length + NONCE_LEN;
        const cipherEnd = stat.size - TAG_LEN;
        const cipherLen = cipherEnd - cipherStart;

        const tag = Buffer.alloc(TAG_LEN);
        fs.readSync(inFd, tag, 0, TAG_LEN, cipherEnd);

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(tag);

        let pos = cipherStart;
        const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
        while (pos < cipherEnd) {
            const toRead = Math.min(CHUNK_SIZE, cipherEnd - pos);
            const n = fs.readSync(inFd, buffer, 0, toRead, pos);
            if (n === 0) break;
            const dec = decipher.update(buffer.subarray(0, n));
            if (dec.length) fs.writeSync(outFd, dec);
            pos += n;
        }

        const final = decipher.final();
        if (final.length) fs.writeSync(outFd, final);
    } finally {
        fs.closeSync(inFd);
        fs.closeSync(outFd);
    }
}

module.exports = { encryptFile, decryptFile };