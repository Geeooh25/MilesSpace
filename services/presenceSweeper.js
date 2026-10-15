// services/presenceSweeper.js
// ─────────────────────────────────────────────────────────────────
// Deletes presence rows older than 24 hours. Without this, dead
// sessions accumulate. Run on a 5-minute interval from server.js.
//
// Brief §8: "Implement presence expiry and stale-row cleanup using
// an efficient scheduled job. Do not create a permanent row for
// every heartbeat."
// ─────────────────────────────────────────────────────────────────

'use strict';
const { supabaseAdmin } = require('../db/supabase');

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;   // 24 hours
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;      // 5 minutes

async function sweepOnce() {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
    const { error, count } = await supabaseAdmin
        .from('user_presence')
        .delete({ count: 'exact' })
        .lt('last_seen', cutoff);

    if (error) {
        console.error('[PRESENCE SWEEPER] delete failed:', error.message);
        return { ok: false, deleted: 0 };
    }
    if (count && count > 0) {
        console.log(`[PRESENCE SWEEPER] deleted ${count} stale rows`);
    }
    return { ok: true, deleted: count || 0 };
}

function start() {
    // Run once shortly after boot, then on the interval.
    setTimeout(() => sweepOnce().catch(() => {}), 30 * 1000);
    const timer = setInterval(() => sweepOnce().catch(() => {}), SWEEP_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

module.exports = { sweepOnce, start };