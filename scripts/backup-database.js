// scripts/backup-database.js
// MilesSpace database backup.
//
//   Reads from Supabase Postgres via pg_dump.
//   Verifies the archive with pg_restore --list.
//   Encrypts with BACKUP_ENCRYPTION_PASSPHRASE (AES-256-GCM).
//   Writes to  <BACKUP_ROOT>\Daily\YYYY-MM-DD\MilesSpace-DB-YYYY-MM-DD.dump.enc
//   Appends a row to <BACKUP_ROOT>\Backup-Log.csv
//   Optionally copies to EXTERNAL_BACKUP_DRIVE if set and reachable.
//
// Usage:
//   node scripts/backup-database.js                  real backup, encrypted
//   node scripts/backup-database.js --dry-run        print plan, write nothing
//   node scripts/backup-database.js --no-encrypt     skip encryption (discouraged)
//   node scripts/backup-database.js --keep-plaintext keep unencrypted .dump too
//   node scripts/backup-database.js --manual "Before-Production-Migration"
//                                                    write into Manual\<label>-<date>\
//   node scripts/backup-database.js --no-external    skip external drive copy

'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pgDumpPath, pgRestorePath } = require('./lib/pgPath');
const { encryptFile } = require('./lib/encrypt');

// ─── Args ───────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const DRY_RUN        = ARGS.includes('--dry-run');
const NO_ENCRYPT     = ARGS.includes('--no-encrypt');
const KEEP_PLAINTEXT = ARGS.includes('--keep-plaintext');
const NO_EXTERNAL    = ARGS.includes('--no-external');
function argValue(name) {
    const i = ARGS.indexOf(name);
    return i >= 0 ? ARGS[i + 1] : null;
}
const MANUAL_LABEL = argValue('--manual');

// ─── Paths ──────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKUP_ROOT  = process.env.BACKUP_ROOT
    ? path.resolve(process.env.BACKUP_ROOT)
    : path.join(PROJECT_ROOT, 'backups');
const LOG_DIR      = path.resolve(PROJECT_ROOT, process.env.BACKUP_LOG_DIR || 'logs');
const EXTERNAL_DRIVE = process.env.EXTERNAL_BACKUP_DRIVE || null;

// ─── Constants ──────────────────────────────────────────────────
const REQUIRED_TABLES = [
    'profiles', 'transactions', 'orders', 'ledger_accounts', 'ledger_entries',
    'deposit_requests', 'crypto_deposits', 'webhook_events', 'order_events',
    'notifications', 'chat_conversations', 'chat_messages', 'support_tickets',
    'ticket_messages', 'admin_audit_logs', 'admin_permissions', 'user_sessions'
];

// ─── Helpers ────────────────────────────────────────────────────
function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function todayYmd() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function log(logFile, line) {
    const full = `[${new Date().toISOString()}] ${line}`;
    console.log(full);
    if (logFile) fs.appendFileSync(logFile, full + '\n');
}

function humanBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
    return `${(b / 1073741824).toFixed(2)} GB`;
}

function sha256(filePath) {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        while (true) {
            const n = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (n === 0) break;
            h.update(buffer.subarray(0, n));
        }
    } finally {
        fs.closeSync(fd);
    }
    return h.digest('hex');
}

// ─── Env check ──────────────────────────────────────────────────
function envCheck() {
    const required = ['SUPABASE_DB_HOST', 'SUPABASE_DB_PORT', 'SUPABASE_DB_USER', 'SUPABASE_DB_PASSWORD', 'SUPABASE_DB_NAME'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
    if (!NO_ENCRYPT && !process.env.BACKUP_ENCRYPTION_PASSPHRASE) {
        throw new Error('BACKUP_ENCRYPTION_PASSPHRASE is not set. Set it in .env or pass --no-encrypt.');
    }
}

// ─── pg_dump ────────────────────────────────────────────────────
function runPgDump(dumpPath) {
    const bin = pgDumpPath();
    const args = [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--host', process.env.SUPABASE_DB_HOST,
        '--port', String(process.env.SUPABASE_DB_PORT),
        '--username', process.env.SUPABASE_DB_USER,
        '--dbname', process.env.SUPABASE_DB_NAME,
        '--file', dumpPath
    ];
    if (DRY_RUN) {
        console.log('[plan] command:');
        console.log(`       "${bin}" ${args.join(' ')}`);
        console.log('[plan] password: provided via PGPASSWORD (not shown)');
        return;
    }
    const r = spawnSync(bin, args, {
        stdio: 'inherit',
        env: { ...process.env, PGPASSWORD: process.env.SUPABASE_DB_PASSWORD }
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`pg_dump exited with code ${r.status}`);
}

// ─── Verify archive ─────────────────────────────────────────────
function verifyDump(dumpPath) {
    const bin = pgRestorePath();
    const r = spawnSync(bin, ['--list', dumpPath], { encoding: 'utf8' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`pg_restore --list failed: ${r.stderr || 'unknown error'}`);
    const listing = r.stdout || '';
    const missing = REQUIRED_TABLES.filter(t => !new RegExp(`\\b${t}\\b`, 'i').test(listing));
    if (missing.length) throw new Error(`Dump is missing required tables: ${missing.join(', ')}`);
    return {
        tables:    (listing.match(/TABLE DATA/gi) || []).length,
        functions: (listing.match(/FUNCTION/gi)   || []).length,
        triggers:  (listing.match(/TRIGGER/gi)    || []).length
    };
}

// ─── Backup-Log.csv ─────────────────────────────────────────────
function appendBackupLog({ date, type, file, size, local, external, verified, sha256hex }) {
    const csvPath = path.join(BACKUP_ROOT, 'Backup-Log.csv');
    ensureDir(BACKUP_ROOT);
    if (!fs.existsSync(csvPath)) {
        fs.writeFileSync(csvPath,
            'timestamp,date,type,file,size_bytes,local,external,verified,sha256\n');
    }
    const row = [
        new Date().toISOString(), date, type, file,
        size, local ? 'OK' : 'MISSING',
        external ? 'OK' : (NO_EXTERNAL ? 'SKIPPED' : 'MISSING'),
        verified ? 'OK' : 'FAILED',
        sha256hex
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    fs.appendFileSync(csvPath, row + '\n');
}

// ─── External drive copy ────────────────────────────────────────
function copyToExternal(sourceFile, relativeSubdir) {
    if (NO_EXTERNAL || !EXTERNAL_DRIVE) return null;
    if (!fs.existsSync(EXTERNAL_DRIVE)) {
        console.log(`[external] drive ${EXTERNAL_DRIVE} not present — skipping`);
        return null;
    }
    const destDir = path.join(EXTERNAL_DRIVE, 'MilesSpace-Backups', relativeSubdir);
    ensureDir(destDir);
    const destFile = path.join(destDir, path.basename(sourceFile));
    fs.copyFileSync(sourceFile, destFile);

    // verify copy
    const srcHash = sha256(sourceFile);
    const dstHash = sha256(destFile);
    if (srcHash !== dstHash) {
        throw new Error(`external copy hash mismatch (src=${srcHash.slice(0,12)} dst=${dstHash.slice(0,12)})`);
    }
    console.log(`[external] copied and verified → ${destFile}`);
    return destFile;
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
    const startedAt = Date.now();
    ensureDir(LOG_DIR);
    const logFile = path.join(LOG_DIR, `backup-${todayYmd()}.log`);

    log(logFile, '[start]   MilesSpace database backup');
    log(logFile, `[start]   mode: ${DRY_RUN ? 'DRY RUN' : 'REAL'}${NO_ENCRYPT ? ' (no encryption)' : ''}${MANUAL_LABEL ? ` manual="${MANUAL_LABEL}"` : ''}`);

    try {
        envCheck();
        log(logFile, '[check]   environment variables present');

        const dumpBin = pgDumpPath();
        const restoreBin = pgRestorePath();
        log(logFile, `[check]   pg_dump:    ${dumpBin}`);
        log(logFile, `[check]   pg_restore: ${restoreBin}`);
        log(logFile, `[check]   host:       ${process.env.SUPABASE_DB_HOST}:${process.env.SUPABASE_DB_PORT}`);
        log(logFile, `[check]   db/user:    ${process.env.SUPABASE_DB_NAME} / ${process.env.SUPABASE_DB_USER}`);
        log(logFile, `[check]   backup root: ${BACKUP_ROOT}`);
        if (EXTERNAL_DRIVE) log(logFile, `[check]   external:   ${EXTERNAL_DRIVE}`);

        // Determine where this run writes.
        const date = todayYmd();
        let subdir;             // relative to BACKUP_ROOT
        let baseName;           // filename stem without extension
        let type;               // "Daily" | "Manual"

        if (MANUAL_LABEL) {
            const label = String(MANUAL_LABEL).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
            subdir = path.join('Manual', `${label}-${date}`);
            baseName = `MilesSpace-DB-MANUAL-${date}`;
            type = 'Manual';
        } else {
            subdir = path.join('Daily', date);
            baseName = `MilesSpace-DB-${date}`;
            type = 'Daily';
        }

        const outDir = path.join(BACKUP_ROOT, subdir);
        ensureDir(outDir);

        const tmpDump   = path.join(outDir, `${baseName}.dump.tmp`);
        const finalDump = path.join(outDir, `${baseName}.dump`);
        const encFile   = path.join(outDir, `${baseName}.dump.enc`);
        const metaFile  = path.join(outDir, `${baseName}.meta.json`);

        log(logFile, `[plan]    type:     ${type}`);
        log(logFile, `[plan]    dir:      ${outDir}`);
        log(logFile, `[plan]    file:     ${path.basename(encFile)}`);
        log(logFile, `[plan]    encrypt:  ${NO_ENCRYPT ? 'NO' : 'YES'}`);

        if (DRY_RUN) {
            runPgDump(tmpDump);
            log(logFile, '[plan]    DRY RUN — nothing written.');
            process.exit(0);
        }

        // 1. Dump
        log(logFile, '[dump]    running pg_dump...');
        runPgDump(tmpDump);
        const dumpSize = fs.statSync(tmpDump).size;
        log(logFile, `[dump]    wrote ${humanBytes(dumpSize)} to temp file`);

        // 2. Verify archive
        log(logFile, '[verify]  inspecting archive...');
        const info = verifyDump(tmpDump);
        log(logFile, `[verify]  tables=${info.tables} functions=${info.functions} triggers=${info.triggers}`);
        log(logFile, `[verify]  required tables present: ${REQUIRED_TABLES.length}/${REQUIRED_TABLES.length}`);

        fs.renameSync(tmpDump, finalDump);

        // 3. Encrypt
        let finalPath = finalDump;
        if (!NO_ENCRYPT) {
            log(logFile, '[encrypt] encrypting with AES-256-GCM...');
            encryptFile(finalDump, encFile, process.env.BACKUP_ENCRYPTION_PASSPHRASE);
            log(logFile, `[encrypt] wrote ${humanBytes(fs.statSync(encFile).size)} to ${path.basename(encFile)}`);
            if (!KEEP_PLAINTEXT) {
                fs.unlinkSync(finalDump);
                log(logFile, '[cleanup] removed plaintext .dump');
            } else {
                log(logFile, '[cleanup] keeping plaintext .dump (--keep-plaintext)');
            }
            finalPath = encFile;
        }

        const finalSize = fs.statSync(finalPath).size;
        const hash = sha256(finalPath);

        // 4. Meta sidecar
        const meta = {
            created_at: new Date().toISOString(),
            duration_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
            type,
            file: path.basename(finalPath),
            dump_bytes: dumpSize,
            final_bytes: finalSize,
            sha256: hash,
            tables: info.tables, functions: info.functions, triggers: info.triggers,
            required_tables_verified: REQUIRED_TABLES
        };
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
        log(logFile, `[meta]    ${path.basename(metaFile)}`);

        // 5. External drive copy (best-effort)
        let externalOk = false;
        try {
            const ext = copyToExternal(finalPath, subdir);
            if (ext) externalOk = true;
        } catch (e) {
            log(logFile, `[external] FAILED: ${e.message}`);
        }

        // 6. Backup-Log.csv
        appendBackupLog({
            date,
            type,
            file: path.basename(finalPath),
            size: finalSize,
            local: true,
            external: externalOk,
            verified: true,
            sha256hex: hash
        });
        log(logFile, `[log]     appended to Backup-Log.csv`);

        log(logFile, `[done]    backup completed in ${meta.duration_seconds}s`);
        log(logFile, `[done]    final file: ${finalPath}`);
        process.exit(0);

    } catch (err) {
        log(logFile, `[error]   ${err.message}`);
        log(logFile, `[error]   previous good backups were NOT touched`);
        process.exit(1);
    }
}

main();