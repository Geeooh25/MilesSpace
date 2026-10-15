// middleware/supportUpload.js
// ─────────────────────────────────────────────────────────────────
// Upload validation for support attachments.
// Used by both authenticated and guest message endpoints.
// ─────────────────────────────────────────────────────────────────

'use strict';

const SIGNATURES = [
    { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
    { mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
    { mime: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
    { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], extra: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
    { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }
];

const ALLOWED_MIME = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf', 'text/plain', 'text/csv'
]);
const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'txt', 'csv']);
const MAX_FILENAME_LEN = 200;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;

function startsWith(buffer, bytes, offset = 0) {
    if (buffer.length < offset + bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) {
        if (buffer[offset + i] !== bytes[i]) return false;
    }
    return true;
}

function sniff(buffer) {
    for (const sig of SIGNATURES) {
        if (startsWith(buffer, sig.bytes)) {
            if (sig.extra) {
                if (startsWith(buffer, sig.extra.bytes, sig.extra.offset)) return sig.mime;
                continue;
            }
            return sig.mime;
        }
    }
    return null;
}

function looksLikeText(buffer) {
    const sample = buffer.slice(0, Math.min(buffer.length, 1024));
    for (const b of sample) if (b === 0x00) return false;
    let printable = 0;
    for (const b of sample) {
        if ((b >= 0x09 && b <= 0x7E) || b === 0x0A || b === 0x0D) printable++;
    }
    return sample.length === 0 || (printable / sample.length) > 0.9;
}

function validateUpload({ buffer, mimetype, originalname, size }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return { ok: false, error: 'File is empty.' };
    }
    const reportedSize = Number(size) || buffer.length;
    if (reportedSize > MAX_FILE_SIZE) {
        return { ok: false, error: 'File is too large (max 10MB).' };
    }
    const name = String(originalname || '').trim();
    if (!name || name.length > MAX_FILENAME_LEN) {
        return { ok: false, error: 'Filename is invalid or too long.' };
    }
    if (/[\/\\\0]/.test(name)) {
        return { ok: false, error: 'Filename contains invalid characters.' };
    }
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
        return { ok: false, error: `Extension .${ext} is not allowed.` };
    }
    const declared = mimetype === 'image/jpg' ? 'image/jpeg' : String(mimetype || '');
    if (!ALLOWED_MIME.has(declared)) {
        return { ok: false, error: 'Unsupported file type.' };
    }
    const sniffed = sniff(buffer);
    if (sniffed) {
        if (sniffed !== declared) {
            return { ok: false, error: 'File contents do not match its type.' };
        }
    } else {
        if ((declared === 'text/plain' || declared === 'text/csv') && !looksLikeText(buffer)) {
            return { ok: false, error: 'Text file contains binary data.' };
        }
        if (declared !== 'text/plain' && declared !== 'text/csv') {
            return { ok: false, error: 'File type is not recognised.' };
        }
    }
    return { ok: true };
}

function validateBatch(files) {
    if (!Array.isArray(files)) return { ok: true, files: [] };
    if (files.length > MAX_FILES) {
        return { ok: false, error: `Maximum ${MAX_FILES} files per message.` };
    }
    for (const f of files) {
        const check = validateUpload(f);
        if (!check.ok) return check;
    }
    return { ok: true, files };
}

module.exports = {
    validateUpload,
    validateBatch,
    MAX_FILE_SIZE,
    MAX_FILES,
    ALLOWED_MIME,
    ALLOWED_EXT
};