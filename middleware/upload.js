// middleware/upload.js
// ─────────────────────────────────────────────────────────────────
// Hardened multipart upload for support attachments.
//
// Validates:
//   - extension allowlist
//   - MIME allowlist
//   - magic bytes (first 8 bytes of the buffer)
//   - per-file size
//   - per-request total size
//   - file count
//
// Does NOT trust client-provided mimetype or extension alone.
// ─────────────────────────────────────────────────────────────────

'use strict';

const multer = require('multer');

const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB per file
const MAX_FILES      = 5;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;  // 25 MB total

// extension → allowed MIME types
const EXT_MIME = {
    jpg:  ['image/jpeg'],
    jpeg: ['image/jpeg'],
    png:  ['image/png'],
    gif:  ['image/gif'],
    webp: ['image/webp'],
    mp4:  ['video/mp4'],
    webm: ['video/webm'],
    mov:  ['video/quicktime'],
    pdf:  ['application/pdf'],
    txt:  ['text/plain'],
    doc:  ['application/msword'],
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']
};

// magic bytes by MIME
function detectMagic(buf) {
    const b = buf.subarray ? buf.subarray(0, 8) : buf.slice(0, 8);
    const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    if (hex.startsWith('ffd8ff')) return 'image/jpeg';
    if (hex.startsWith('89504e47')) return 'image/png';
    if (hex.startsWith('47494638')) return 'image/gif';
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'image/webp';
    if (hex.startsWith('25504446')) return 'application/pdf';
    if (hex.startsWith('255044')) return 'application/pdf';
    // mp4 / mov both start with ftyp at offset 4
    if (hex.slice(8, 16) === '66747970') return 'video/mp4';
    // webm starts 1a45dfa3
    if (hex.startsWith('1a45dfa3')) return 'video/webm';
    // docx/doc are ZIP containers: 504b0304
    if (hex.startsWith('504b0304')) return 'application/zip';
    // txt has no magic; skip
    return null;
}

function extOf(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
}

const storage = multer.memoryStorage();

const upload = multer({
    storage,
    limits: {
        fileSize: MAX_FILE_BYTES,
        files: MAX_FILES
    },
    fileFilter: (req, file, cb) => {
        const ext = extOf(file.originalname);
        if (!ext || !EXT_MIME[ext]) {
            return cb(new Error('UNSUPPORTED_FILE_TYPE'));
        }
        if (!EXT_MIME[ext].includes(file.mimetype)) {
            return cb(new Error('MIME_MISMATCH'));
        }
        cb(null, true);
    }
});

// Post-upload magic-byte validation. Run after multer.
function validateMagicBytes(req, res, next) {
    const files = req.files ? [...req.files] : (req.file ? [req.file] : []);
    if (!files.length) return next();

    let total = 0;
    for (const f of files) {
        total += f.size || 0;
        if (total > MAX_TOTAL_BYTES) {
            return res.status(413).json({
                success: false,
                code: 'TOTAL_SIZE_EXCEEDED',
                error: `Total upload size must not exceed ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)}MB.`
            });
        }

        const ext = extOf(f.originalname);
        const detected = detectMagic(f.buffer);

        // txt has no magic — skip
        if (ext === 'txt') continue;

        // docx/doc are ZIP — the extension allowlist already gates them.
        if (ext === 'doc' || ext === 'docx') {
            if (detected && detected !== 'application/zip') {
                return res.status(415).json({
                    success: false,
                    code: 'FILE_SIGNATURE_MISMATCH',
                    error: `File "${f.originalname}" does not match its declared type.`
                });
            }
            continue;
        }

        if (!detected) {
            return res.status(415).json({
                success: false,
                code: 'UNRECOGNISED_FILE',
                error: `File "${f.originalname}" could not be validated.`
            });
        }

        // For mp4/mov both report video/mp4; accept either for the mov extension.
        const allowedForExt = EXT_MIME[ext] || [];
        const acceptable = allowedForExt.includes(detected)
            || (ext === 'mov' && detected === 'video/mp4');
        if (!acceptable) {
            return res.status(415).json({
                success: false,
                code: 'FILE_SIGNATURE_MISMATCH',
                error: `File "${f.originalname}" content does not match its extension.`
            });
        }
    }

    next();
}

module.exports = {
    upload,
    validateMagicBytes,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_TOTAL_BYTES
};