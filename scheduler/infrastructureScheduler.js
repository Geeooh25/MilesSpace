'use strict';

const infrastructure = require('../services/infrastructureService');
const appMetrics = require('../services/applicationMetricsService');

const ROLLUP_MS = 60 * 1000;
const SNAPSHOT_MS = 10 * 60 * 1000;

let _rollupTimer = null;
let _snapshotTimer = null;

function start() {
    // 5–25s jitter so redeploys don't fire all timers at once.
    const jitter = 5000 + Math.floor(Math.random() * 20000);

    setTimeout(() => {
        // Immediate first pass, then periodic.
        runSnapshot();
        runRollup();

        _rollupTimer = setInterval(() => runRollup(), ROLLUP_MS);
        _snapshotTimer = setInterval(() => runSnapshot(), SNAPSHOT_MS);
    }, jitter);

    console.log('[infrastructure] scheduler armed (rollup 60s, snapshot 10m)');
}

function stop() {
    if (_rollupTimer) clearInterval(_rollupTimer);
    if (_snapshotTimer) clearInterval(_snapshotTimer);
    _rollupTimer = null;
    _snapshotTimer = null;
}

async function runRollup() {
    try { await appMetrics.persistRollup(); }
    catch (e) { console.warn('[infrastructure] rollup failed:', e.message); }
}

async function runSnapshot() {
    try {
        await infrastructure.refreshSnapshot();
    } catch (e) {
        console.warn('[infrastructure] snapshot refresh failed:', e.message);
    }
}

module.exports = { start, stop, runRollup, runSnapshot };