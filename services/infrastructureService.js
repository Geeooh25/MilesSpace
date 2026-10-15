'use strict';

const railway = require('./railwayService');
const appMetrics = require('./applicationMetricsService');
const providerFactory = require('./providers/providerFactory');
const { supabaseAdmin } = require('../db/supabase');

// Snapshot key in app_config, written by the scheduler every 10 min.
const SNAPSHOT_KEY = 'infrastructure_snapshot';

async function readSnapshot() {
    try {
        const { data } = await supabaseAdmin
            .from('app_config')
            .select('value, updated_at')
            .eq('key', SNAPSHOT_KEY)
            .maybeSingle();
        return data?.value ? { ...data.value, _updatedAt: data.updated_at } : null;
    } catch { return null; }
}

async function writeSnapshot(snapshot) {
    try {
        await supabaseAdmin.from('app_config').upsert({
            key: SNAPSHOT_KEY,
            value: snapshot,
            updated_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[infrastructure] snapshot write failed:', e.message);
    }
}

// ─── Provider summary ──────────────────────────────────────────
// Reads only from provider_health. Never calls a provider.
async function providerSummary() {
    try {
        const { data } = await supabaseAdmin
            .from('provider_health')
            .select('provider, label, status, critical, environment, latency_ms, last_checked_at');
        const rows = data || [];
        const out = rows.map(r => ({
            provider: r.provider,
            label: r.label || r.provider,
            status: r.status,
            critical: !!r.critical,
            environment: r.environment || null,
            latencyMs: r.latency_ms ?? null,
            lastCheckedAt: r.last_checked_at || null
        }));
        // Ensure every registered adapter appears.
        const seen = new Set(out.map(p => p.provider));
        for (const name of providerFactory.list()) {
            if (!seen.has(name)) {
                const adapter = providerFactory.get(name);
                out.push({
                    provider: name,
                    label: adapter?.label || name,
                    status: adapter?.isConfigured?.() ? 'configured' : 'not_configured',
                    critical: false,
                    environment: null,
                    latencyMs: null,
                    lastCheckedAt: null
                });
            }
        }
        const down = out.filter(p => ['unreachable','auth_failed','rate_limited','circuit_open'].includes(p.status));
        const criticalDown = down.filter(p => p.critical);
        return {
            providers: out.sort((a,b) => a.label.localeCompare(b.label)),
            total: out.length,
            down: down.length,
            criticalDown: criticalDown.length
        };
    } catch {
        return { providers: [], total: 0, down: 0, criticalDown: 0 };
    }
}

// ─── Database health ───────────────────────────────────────────
async function databaseHealth() {
    const started = Date.now();
    try {
        const { error } = await supabaseAdmin.from('profiles').select('id', { head: true, count: 'estimated' }).limit(1);
        return { status: error ? 'degraded' : 'operational', latencyMs: Date.now() - started };
    } catch {
        return { status: 'unreachable', latencyMs: Date.now() - started };
    }
}

// ─── Build the snapshot from Railway cached data ───────────────
async function refreshSnapshot() {
    const [usageRes, deployRes, metricsRes, dbHealth, providers] = await Promise.all([
        railway.getUsage(),
        railway.getDeployment(),
        railway.getMetrics(),
        databaseHealth(),
        providerSummary()
    ]);

    const usageRaw = usageRes.ok ? usageRes.data?.usage : null;
    const measurement = usageRaw?.measurement || {};
    const breakdown = usageRaw?.breakdown || {};
    const period = usageRaw?.currentPeriod || {};

    const usage = usageRes.ok ? {
        available: true,
        current: measurement.currentUsage ?? null,
        estimated: measurement.estimatedUsage ?? null,
        included: measurement.includedUsage ?? null,
        overage: measurement.overage ?? null,
        periodStart: period.startDate || null,
        periodEnd: period.endDate || null,
        breakdown: {
            cpu: breakdown.cpu ?? null,
            memory: breakdown.memory ?? null,
            network: breakdown.network ?? null,
            disk: breakdown.disk ?? null
        }
    } : { available: false, reason: usageRes.code || 'unavailable' };

    const deployNode = deployRes.ok ? deployRes.data?.deployments?.edges?.[0]?.node : null;
    const deployment = deployRes.ok ? {
        available: true,
        id: deployNode?.id || null,
        status: deployNode?.status || 'UNKNOWN',
        createdAt: deployNode?.createdAt || null,
        updatedAt: deployNode?.updatedAt || null,
        url: deployNode?.staticUrl || null
    } : { available: false, reason: deployRes.code || 'unavailable' };

    const metrics = metricsRes.ok ? railway.summarizeMetrics(metricsRes.data) : {};

    const snapshot = {
        generatedAt: new Date().toISOString(),
        railwayConfigured: railway.isConfigured(),
        railwayBreakers: railway.breakerSnapshot(),
        usage,
        deployment,
        metrics,
        database: dbHealth,
        providers,
        cachedAt: {
            usage: usageRes.ok ? (usageRes.ageMs ?? 0) : null,
            deployment: deployRes.ok ? (deployRes.ageMs ?? 0) : null,
            metrics: metricsRes.ok ? (metricsRes.ageMs ?? 0) : null
        }
    };

    await writeSnapshot(snapshot);
    return snapshot;
}

// ─── Public read API for the route layer ───────────────────────
async function getOverview() {
    const snap = await readSnapshot();
    const live = appMetrics.snapshot();
    return {
        api: {
            status: live.serverErrorRatePct != null && live.serverErrorRatePct > 5 ? 'degraded' : 'operational',
            ...live
        },
        database: snap?.database || { status: 'unknown', latencyMs: null },
        railway: {
            configured: snap?.railwayConfigured ?? railway.isConfigured(),
            deploymentStatus: snap?.deployment?.status || 'UNKNOWN',
            breakers: snap?.railwayBreakers || {}
        },
        providers: snap?.providers || { providers: [], total: 0, down: 0, criticalDown: 0 },
        lastSnapshotAt: snap?._updatedAt || null
    };
}

async function getUsage() {
    const snap = await readSnapshot();
    return snap?.usage || { available: false, reason: 'no_snapshot' };
}

async function getMetrics() {
    const snap = await readSnapshot();
    return {
        server: snap?.metrics || {},
        api: appMetrics.snapshot(),
        history: await appMetrics.history(24),
        lastSnapshotAt: snap?._updatedAt || null
    };
}

async function getDeployment() {
    const snap = await readSnapshot();
    return snap?.deployment || { available: false, reason: 'no_snapshot' };
}

async function getHealth() {
    const snap = await readSnapshot();
    const live = appMetrics.snapshot();
    const db = snap?.database || { status: 'unknown', latencyMs: null };
    const providers = snap?.providers || { down: 0, criticalDown: 0 };
    const criticalDown = providers.criticalDown || 0;
    const anyDown = (providers.down || 0) > 0;
    const apiDegraded = (live.serverErrorRatePct ?? 0) > 5;

    let overall = 'operational';
    if (criticalDown > 0 || db.status === 'unreachable') overall = 'major_outage';
    else if (anyDown || apiDegraded || db.status === 'degraded') overall = 'degraded';

    return {
        overall,
        api: live,
        database: db,
        providers: {
            down: providers.down || 0,
            criticalDown
        },
        lastSnapshotAt: snap?._updatedAt || null
    };
}

module.exports = {
    refreshSnapshot,
    getOverview,
    getUsage,
    getMetrics,
    getDeployment,
    getHealth
};