// scripts/check-backup-env.js
// One-shot verification that the backup environment is complete.
// Run after setting up .env and folders, before the first backup.
//
//   node scripts/check-backup-env.js

'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { pgDumpPath, pgRestorePath } = require('./lib/pgPath');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKUP_ROOT  = process.env.BACKUP_ROOT
    ? path.resolve(process.env.BACKUP_ROOT)
    : path.join(PROJECT_ROOT, 'backups');

let failCount = 0;
function ok(label, extra = '')   { console.log(`✅ ${label}${extra ? ' — ' + extra : ''}`); }
function bad(label, extra = '')  { console.log(`❌ ${label}${extra ? ' — ' + extra : ''}`); failCount++; }
function warn(label, extra = '') { console.log(`⚠️  ${label}${extra ? ' — ' + extra : ''}`); }

console.log('\nMilesSpace backup environment check\n');

// 1. Node
ok('Node.js', process.version);

// 2. PostgreSQL client tools
try { const p = pgDumpPath(); ok('pg_dump', p); } catch (e) { bad('pg_dump', e.message); }
try { const p = pgRestorePath(); ok('pg_restore', p); } catch (e) { bad('pg_restore', e.message); }

// 3. Env vars
const required = ['SUPABASE_DB_HOST', 'SUPABASE_DB_PORT', 'SUPABASE_DB_USER', 'SUPABASE_DB_PASSWORD', 'SUPABASE_DB_NAME', 'BACKUP_ENCRYPTION_PASSPHRASE'];
for (const k of required) {
    if (process.env[k]) ok(k);
    else bad(k, 'missing in .env');
}

// 4. Folders
const folders = ['Daily', 'Weekly', 'Monthly', 'Manual'];
for (const f of folders) {
    const p = path.join(BACKUP_ROOT, f);
    if (fs.existsSync(p)) ok(`folder ${f}`, p);
    else {
        try { fs.mkdirSync(p, { recursive: true }); ok(`folder ${f} (created)`, p); }
        catch (e) { bad(`folder ${f}`, e.message); }
    }
}

// 5. Writable?
try {
    const probe = path.join(BACKUP_ROOT, '.writable-probe');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    ok('backup root writable', BACKUP_ROOT);
} catch (e) { bad('backup root writable', e.message); }

// 6. External drive (optional)
if (process.env.EXTERNAL_BACKUP_DRIVE) {
    if (fs.existsSync(process.env.EXTERNAL_BACKUP_DRIVE)) {
        ok('external drive', process.env.EXTERNAL_BACKUP_DRIVE);
    } else {
        warn('external drive not connected', process.env.EXTERNAL_BACKUP_DRIVE);
    }
} else {
    warn('EXTERNAL_BACKUP_DRIVE not set', 'backups will not be copied to external drive');
}

// 7. Retention
if (process.env.RETENTION_ENABLED === 'true') {
    ok('RETENTION_ENABLED = true');
} else {
    warn('RETENTION_ENABLED is not "true"', 'retention will not run');
}

console.log('');
if (failCount === 0) {
    console.log('Environment OK. You can run: npm run backup:db');
    process.exit(0);
} else {
    console.log(`${failCount} problem(s) found. Fix the ❌ items above.`);
    process.exit(1);
}