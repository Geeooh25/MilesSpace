// scripts/apply-retention.js
// Promotes backups between tiers, then prunes each tier.
//
// Promotion rules (based on the backup's date folder):
//   - Sunday           → Weekly\YYYY-Www\
//   - 1st of month     → Monthly\YYYY-MM\
//
// Retention rules (from env, with safe defaults):
//   - Daily   keep 30 days
//   - Weekly  keep 12 weeks
//   - Monthly keep 12 months
//   - Manual  kept forever
//
// SAFETY:
//   - refuses to run if RETENTION_ENABLED !== 'true'
//   - refuses to delete a daily folder that isn't fully covered by
//     weekly or monthly (nothing is lost silently)
//   - --dry-run prints the plan, deletes nothing
//
// Usage:
//   node scripts/apply-retention.js --dry-run
//   node scripts/apply-retention.js

'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKUP_ROOT  = process.env.BACKUP_ROOT
    ? path.resolve(process.env.BACKUP_ROOT)
    : path.join(PROJECT_ROOT, 'backups');

const KEEP_DAILY   = Number(process.env.BACKUP_RETENTION_DAILY_DAYS   || 30);
const KEEP_WEEKLY  = Number(process.env.BACKUP_RETENTION_WEEKLY_WEEKS || 12);
const KEEP_MONTHLY = Number(process.env.BACKUP_RETENTION_MONTHLY_MONTHS || 12);

function log(line) { console.log(`[${new Date().toISOString()}] ${line}`); }

function listDirs(p) {
    if (!fs.existsSync(p)) return [];
    return fs.readdirSync(p)
        .filter(d => fs.statSync(path.join(p, d)).isDirectory())
        .sort();
}

function copyDirContents(srcDir, dstDir) {
    if (!fs.existsSync(srcDir)) return 0;
    fs.mkdirSync(dstDir, { recursive: true });
    let count = 0;
    for (const f of fs.readdirSync(srcDir)) {
        const s = path.join(srcDir, f);
        if (!fs.statSync(s).isFile()) continue;
        const d = path.join(dstDir, f);
        if (!fs.existsSync(d)) { fs.copyFileSync(s, d); count++; }
    }
    return count;
}

function ymdToDate(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function isoWeekLabel(date) {
    // ISO week number: Thursday-based
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function main() {
    if (process.env.RETENTION_ENABLED !== 'true' && !DRY_RUN) {
        log('[retention] RETENTION_ENABLED is not "true" — refusing to run.');
        log('[retention] set RETENTION_ENABLED=true in .env once you have completed a restore test.');
        process.exit(0);
    }

    const dailyRoot   = path.join(BACKUP_ROOT, 'Daily');
    const weeklyRoot  = path.join(BACKUP_ROOT, 'Weekly');
    const monthlyRoot = path.join(BACKUP_ROOT, 'Monthly');

    log(`[retention] dry-run=${DRY_RUN}`);
    log(`[retention] daily=${KEEP_DAILY}d weekly=${KEEP_WEEKLY}w monthly=${KEEP_MONTHLY}m`);

    // 1. Promote
    const dailyFolders = listDirs(dailyRoot);
    log(`[promote]  daily folders: ${dailyFolders.length}`);

    for (const folder of dailyFolders) {
        const date = ymdToDate(folder);
        const day = date.getUTCDay();   // 0 = Sunday

        if (day === 0) {
            const weekLabel = isoWeekLabel(date);
            const dst = path.join(weeklyRoot, weekLabel);
            if (DRY_RUN) log(`[promote]  (dry) daily/${folder} → Weekly/${weekLabel}`);
            else {
                const n = copyDirContents(path.join(dailyRoot, folder), dst);
                log(`[promote]  daily/${folder} → Weekly/${weekLabel} (${n} new files)`);
            }
        }
        if (date.getUTCDate() === 1) {
            const monthLabel = folder.slice(0, 7);   // YYYY-MM
            const dst = path.join(monthlyRoot, monthLabel);
            if (DRY_RUN) log(`[promote]  (dry) daily/${folder} → Monthly/${monthLabel}`);
            else {
                const n = copyDirContents(path.join(dailyRoot, folder), dst);
                log(`[promote]  daily/${folder} → Monthly/${monthLabel} (${n} new files)`);
            }
        }
    }

    // 2. Prune daily
    const dailyCutoff = new Date(Date.now() - KEEP_DAILY * 86400000);
    for (const folder of dailyFolders) {
        const date = ymdToDate(folder);
        if (date < dailyCutoff) {
            const weekLabel = isoWeekLabel(date);
            const monthLabel = folder.slice(0, 7);
            const inWeekly  = fs.existsSync(path.join(weeklyRoot, weekLabel));
            const inMonthly = fs.existsSync(path.join(monthlyRoot, monthLabel));
            const safeToDelete = inWeekly || inMonthly;
            if (!safeToDelete) {
                log(`[prune]    KEEP daily/${folder} (not yet covered by weekly or monthly)`);
                continue;
            }
            if (DRY_RUN) log(`[prune]    (dry) delete daily/${folder}`);
            else {
                fs.rmSync(path.join(dailyRoot, folder), { recursive: true, force: true });
                log(`[prune]    deleted daily/${folder}`);
            }
        }
    }

    // 3. Prune weekly
    const weeklyFolders = listDirs(weeklyRoot).sort();
    const excessWeekly = weeklyFolders.length - KEEP_WEEKLY;
    if (excessWeekly > 0) {
        for (let i = 0; i < excessWeekly; i++) {
            const folder = weeklyFolders[i];
            if (DRY_RUN) log(`[prune]    (dry) delete weekly/${folder}`);
            else {
                fs.rmSync(path.join(weeklyRoot, folder), { recursive: true, force: true });
                log(`[prune]    deleted weekly/${folder}`);
            }
        }
    }

    // 4. Prune monthly
    const monthlyFolders = listDirs(monthlyRoot).sort();
    const excessMonthly = monthlyFolders.length - KEEP_MONTHLY;
    if (excessMonthly > 0) {
        for (let i = 0; i < excessMonthly; i++) {
            const folder = monthlyFolders[i];
            if (DRY_RUN) log(`[prune]    (dry) delete monthly/${folder}`);
            else {
                fs.rmSync(path.join(monthlyRoot, folder), { recursive: true, force: true });
                log(`[prune]    deleted monthly/${folder}`);
            }
        }
    }

    log('[retention] done.');
}

main();