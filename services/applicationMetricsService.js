'use strict';

const { supabaseAdmin } = require('../db/supabase');

// ─── In-process rolling window ──────────────────────────────────
// Buckets per minute, last 60 minutes. That is 60 small objects
// in memory, and it never grows beyond that.
const WINDOW_MIN = 60;
const _buckets = new Map(); // minuteIso -> { count, s2xx, s4xx, s5xx, sumMs, slow }

function bucketKey(d = new Date()) {
    const iso = new Date(d);
    iso.setSeconds(0, 0);
    return iso.toISOString();
}

function getBucket(k) {
    let b = _buckets.get(k);
    if (!b) {
        b = { count: 0, s2xx: 0, s4xx: 0, s5xx: 0, sumMs: 0, slow: 0 };
        _buckets.set(k, b);
    }
    return b;
}

function prune() {
    const cutoff = Date.now() - WINDOW_MIN * 60 * 1000;
    for (const k of _buckets.keys()) {
        if (new Date(k).getTime() < cutoff) _buckets.delete(k);
    }
}

function record({ status, durationMs }) {
    const b = getBucket(bucketKey());
    b.count++;
    if (status >= 200 && status < 300) b.s2xx++;
    else if (status >= 400 && status < 500) b.s4xx++;
    else if (status >= 500) b.s5xx++;
    b.sumMs += Number.isFinite(durationMs) ? durationMs : 0;
    if (durationMs > 1000) b.slow++;
}

function snapshot() {
    prune();
    let count = 0, s2xx = 0, s4xx = 0, s5xx = 0, sumMs = 0, slow = 0;
    for (const b of _buckets.values()) {
        count += b.count; s2xx += b.s2xx; s4xx += b.s4xx; s5xx += b.s5xx;
        sumMs += b.sumMs; slow += b.slow;
    }
    return {
        windowMinutes: WINDOW_MIN,
        requests: count,
        success: s2xx,
        errors4xx: s4xx,
        errors5xx: s5xx,
        slowRequests: slow,
        avgLatencyMs: count ? Math.round(sumMs / count) : null,
        errorRatePct: count ? +(((s4xx + s5xx) / count) * 100).toFixed(2) : null,
        serverErrorRatePct: count ? +((s5xx / count) * 100).toFixed(2) : null
    };
}

// ─── Persist a rollup every minute (called by the scheduler) ────
async function persistRollup() {
    const s = snapshot();
    const minuteIso = bucketKey();
    try {
        await supabaseAdmin.from('application_metrics').upsert({
            bucket: minuteIso,
            requests: s.requests,
            success: s.success,
            errors_4xx: s.errors4xx,
            errors_5xx: s.errors5xx,
            slow_requests: s.slowRequests,
            avg_latency_ms: s.avgLatencyMs,
            error_rate_pct: s.errorRatePct,
            server_error_rate_pct: s.serverErrorRatePct,
            updated_at: new Date().toISOString()
        });
    } catch (e) {
        // Best-effort. The in-memory window still works for the UI.
        if (!/relation .* does not exist|42P01/.test(String(e.message))) {
            console.warn('[appMetrics] rollup persist failed:', e.message);
        }
    }
}

// ─── Historical rollups from the DB ────────────────────────────
async function history(hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    try {
        const { data, error } = await supabaseAdmin
            .from('application_metrics')
            .select('bucket, requests, errors_5xx, avg_latency_ms')
            .gte('bucket', since)
            .order('bucket', { ascending: true });
        if (error) throw error;
        return data || [];
    } catch {
        return [];
    }
}

module.exports = {
    record,
    snapshot,
    persistRollup,
    history,
    _internal: { prune }
};