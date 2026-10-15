// scripts/verify-backup.js
// Verifies a MilesSpace backup: decrypts if needed, inspects with
// pg_restore, asserts every required table is present.
//
// Usage:
//   node scripts/verify-backup.js                              (latest across all tiers)
//   node scripts/verify-backup.js path/to/file.dump.enc        (explicit file)
//   node scripts/verify-backup.js path/to/file.dump            (plaintext)

'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pgRestorePath } = require('./lib/pgPath');
const { decryptFile } = require('./lib/encrypt');

const REQUIRED_TABLES = [
    'profiles','transactions','orders','ledger_accounts','ledger_entries',
    'deposit_requests','crypto_deposits','webhook_events','order_events',
    'notifications','chat_conversations','chat_messages','support_tickets',
    'ticket_messages','admin_audit_logs','admin_permissions','user_sessions'
];

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKUP_ROOT  = process.env.BACKUP_ROOT
    ? path.resolve(process.env.BACKUP_ROOT)
    : path.join(PROJECT_ROOT, 'backups');

function findLatest() {
    const tiers = ['Daily', 'Weekly', 'Monthly', 'Manual'];
    for (const tier of tiers) {
        const tierDir = path.join(BACKUP_ROOT, tier);
        if (!fs.existsSync(tierDir)) continue;

        const subdirs = fs.readdirSync(tierDir)
            .filter(d => fs.statSync(path.join(tierDir, d)).isDirectory())
            .sort();
        if (!subdirs.length) continue;

        const lastSub = subdirs[subdirs.length - 1];
        const dir = path.join(tierDir, lastSub);
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.dump.enc') || f.endsWith('.dump'))
            .sort();
        if (!files.length) continue;

        return path.join(dir, files[files.length - 1]);
    }
    throw new Error(`No backups found under ${BACKUP_ROOT}`);
}

function main() {
    const input = process.argv[2] ? path.resolve(process.argv[2]) : findLatest();
    if (!fs.existsSync(input)) {
        console.error(`[error] file not found: ${input}`);
        process.exit(1);
    }
    console.log(`[verify]  target: ${input}`);

    const isEncrypted = input.endsWith('.dump.enc');
    let dumpPath = input;
    let tempPath = null;

    if (isEncrypted) {
        const pass = process.env.BACKUP_ENCRYPTION_PASSPHRASE;
        if (!pass) { console.error('[error] BACKUP_ENCRYPTION_PASSPHRASE is not set'); process.exit(1); }
        tempPath = path.join(os.tmpdir(), `ms-verify-${Date.now()}.dump`);
        console.log('[verify]  decrypting...');
        try { decryptFile(input, tempPath, pass); }
        catch (e) { console.error(`[error] decryption failed: ${e.message}`); process.exit(1); }
        dumpPath = tempPath;
    }

    try {
        const bin = pgRestorePath();
        const r = spawnSync(bin, ['--list', dumpPath], { encoding: 'utf8' });
        if (r.status !== 0) { console.error(`[error] pg_restore --list failed: ${r.stderr}`); process.exit(1); }
        const listing = r.stdout || '';
        const missing = REQUIRED_TABLES.filter(t => !new RegExp(`\\b${t}\\b`, 'i').test(listing));
        const tables    = (listing.match(/TABLE DATA/gi) || []).length;
        const functions = (listing.match(/FUNCTION/gi)   || []).length;
        const triggers  = (listing.match(/TRIGGER/gi)    || []).length;

        console.log(`[verify]  tables: ${tables}, functions: ${functions}, triggers: ${triggers}`);
        if (missing.length) {
            console.error(`[error] missing required tables: ${missing.join(', ')}`);
            process.exit(1);
        }
        console.log(`[verify]  required tables present: ${REQUIRED_TABLES.length}/${REQUIRED_TABLES.length}`);
        console.log('VERIFIED — backup is intact and complete.');
        process.exit(0);
    } finally {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
}

main();