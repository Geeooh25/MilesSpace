// scripts/restore-backup.js
// Restores a MilesSpace backup into a target database.
//
// SAFETY:
//   - requires --confirm-restore
//   - refuses if target host == SUPABASE_DB_HOST
//   - dry run by default
//
// Usage:
//   node scripts/restore-backup.js --target-url "postgresql://..." --confirm-restore
//   node scripts/restore-backup.js --target-url "postgresql://..."             (dry run)
//   node scripts/restore-backup.js --file path\to\backup.dump.enc --target-url "..." --confirm-restore

'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pgRestorePath } = require('./lib/pgPath');
const { decryptFile } = require('./lib/encrypt');
const { redactUrl } = require('./lib/redact');

const ARGS = process.argv.slice(2);
function arg(name) { const i = ARGS.indexOf(name); return i >= 0 ? ARGS[i + 1] : null; }
const TARGET_URL = arg('--target-url');
const FILE_ARG   = arg('--file');
const CONFIRM    = ARGS.includes('--confirm-restore');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKUP_ROOT  = process.env.BACKUP_ROOT
    ? path.resolve(process.env.BACKUP_ROOT)
    : path.join(PROJECT_ROOT, 'backups');

function findLatestBackup() {
    const tiers = ['Daily', 'Weekly', 'Monthly', 'Manual'];
    for (const tier of tiers) {
        const tierDir = path.join(BACKUP_ROOT, tier);
        if (!fs.existsSync(tierDir)) continue;
        const subdirs = fs.readdirSync(tierDir)
            .filter(d => fs.statSync(path.join(tierDir, d)).isDirectory())
            .sort();
        if (!subdirs.length) continue;
        const dir = path.join(tierDir, subdirs[subdirs.length - 1]);
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.dump.enc') || f.endsWith('.dump'))
            .sort();
        if (files.length) return path.join(dir, files[files.length - 1]);
    }
    throw new Error(`No backups found under ${BACKUP_ROOT}`);
}

function parseHost(url) { try { return new URL(url).hostname; } catch { return null; } }

function main() {
    if (!TARGET_URL) {
        console.error('Usage: node scripts/restore-backup.js --target-url <url> [--file <path>] [--confirm-restore]');
        process.exit(2);
    }

    // Hard guard against restoring onto production.
    const targetHost = parseHost(TARGET_URL);
    const productionHost = process.env.SUPABASE_DB_HOST;
    if (targetHost && productionHost && targetHost === productionHost) {
        console.error(`[error] refuse: --target-url points at the production host (${productionHost}).`);
        console.error('[error] use a separate restore-test database.');
        process.exit(1);
    }

    const input = FILE_ARG ? path.resolve(FILE_ARG) : findLatestBackup();
    if (!fs.existsSync(input)) { console.error(`[error] backup file not found: ${input}`); process.exit(1); }

    console.log(`[restore] source: ${input}`);
    console.log(`[restore] target: ${redactUrl(TARGET_URL)}`);
    console.log(`[restore] mode:   ${CONFIRM ? 'REAL RESTORE' : 'DRY RUN (no --confirm-restore)'}`);

    let dumpPath = input;
    let tempPath = null;
    if (input.endsWith('.dump.enc')) {
        const pass = process.env.BACKUP_ENCRYPTION_PASSPHRASE;
        if (!pass) { console.error('[error] BACKUP_ENCRYPTION_PASSPHRASE not set'); process.exit(1); }
        tempPath = path.join(os.tmpdir(), `ms-restore-${Date.now()}.dump`);
        console.log('[restore] decrypting...');
        decryptFile(input, tempPath, pass);
        dumpPath = tempPath;
    }

    try {
        const bin = pgRestorePath();
        const args = [
            '--no-owner', '--no-privileges',
            '--clean', '--if-exists',
            '--dbname', TARGET_URL,
            dumpPath
        ];

        if (!CONFIRM) {
            console.log('[restore] DRY RUN — command that would run:');
            console.log(`          "${bin}" ${args.map(a => a === TARGET_URL ? '[TARGET_URL]' : a).join(' ')}`);
            console.log('[restore] pass --confirm-restore to actually restore.');
            process.exit(0);
        }

        console.log('[restore] running pg_restore...');
        const r = spawnSync(bin, args, { stdio: 'inherit' });
        if (r.status !== 0) { console.error(`[error] pg_restore exited with code ${r.status}`); process.exit(1); }
        console.log('[restore] done.');
    } finally {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
}

main();