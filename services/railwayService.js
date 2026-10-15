'use strict';

const axios = require('axios');
const { supabaseAdmin } = require('../db/supabase');

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

// Lazy env reads — module load order cannot freeze the token.
function apiToken() { return process.env.RAILWAY_API_TOKEN || null; }
function projectId() { return process.env.RAILWAY_PROJECT_ID || null; }
function environmentId() { return process.env.RAILWAY_ENVIRONMENT_ID || null; }
function serviceId() { return process.env.RAILWAY_SERVICE_ID || null; }

function isConfigured() {
    return Boolean(apiToken());
}

// Simple in-process circuit breaker, one per logical query name.
const _breaker = new Map();
const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 60_000;

function _allow(key) {
    const b = _breaker.get(key) || { fails: 0, openedAt: 0, state: 'CLOSED' };
    if (b.state === 'OPEN' && Date.now() - b.openedAt < BREAKER_COOLDOWN_MS) return false;
    if (b.state === 'OPEN') { b.state = 'HALF'; b.fails = 0; }
    _breaker.set(key, b);
    return true;
}
function _recordSuccess(key) {
    _breaker.set(key, { fails: 0, openedAt: 0, state: 'CLOSED' });
}
function _recordFailure(key) {
    const b = _breaker.get(key) || { fails: 0, openedAt: 0, state: 'CLOSED' };
    b.fails++;
    if (b.fails >= BREAKER_THRESHOLD) { b.state = 'OPEN'; b.openedAt = Date.now(); }
    _breaker.set(key, b);
}
function breakerSnapshot() {
    const out = {};
    for (const [k, v] of _breaker.entries()) out[k] = { state: v.state, fails: v.fails };
    return out;
}

async function graphql(query, variables = {}, { timeoutMs = 10_000 } = {}) {
    if (!isConfigured()) {
        const e = new Error('RAILWAY_API_TOKEN not set');
        e.code = 'RAILWAY_NOT_CONFIGURED';
        e.status = 503;
        throw e;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await axios.post(ENDPOINT, { query, variables }, {
            headers: {
                Authorization: `Bearer ${apiToken()}`,
                'Content-Type': 'application/json'
            },
            signal: controller.signal,
            timeout: timeoutMs,
            validateStatus: () => true
        });
        clearTimeout(timer);
        if (res.status >= 400) {
            const msg = res.data?.errors?.[0]?.message || `Railway HTTP ${res.status}`;
            const e = new Error(String(msg).slice(0, 300));
            e.status = res.status;
            e.code = `RAILWAY_HTTP_${res.status}`;
            throw e;
        }
        if (Array.isArray(res.data?.errors) && res.data.errors.length) {
            const e = new Error(String(res.data.errors[0].message || 'Railway GraphQL error').slice(0, 300));
            e.code = 'RAILWAY_GRAPHQL_ERROR';
            throw e;
        }
        return res.data?.data || {};
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') {
            const err = new Error('Railway request timed out');
            err.code = 'RAILWAY_TIMEOUT';
            err.status = 504;
            throw err;
        }
        throw e;
    }
}

// ─── Cached query runner ────────────────────────────────────────
// Every expensive Railway query is cached in `app_config` (small
// JSON blob), so a redeploy does not burst-call Railway.
async function cachedQuery({ cacheKey, ttlSeconds, query, variables = {} }) {
    const cacheFullKey = `railway_cache_${cacheKey}`;
    const now = Date.now();

    // 1. Try the cache first.
    try {
        const { data } = await supabaseAdmin
            .from('app_config')
            .select('value, updated_at')
            .eq('key', cacheFullKey)
            .maybeSingle();
        if (data?.value && data?.updated_at) {
            const ageMs = now - new Date(data.updated_at).getTime();
            if (ageMs < ttlSeconds * 1000) {
                return { ok: true, fromCache: true, data: data.value, ageMs };
            }
        }
    } catch (_) { /* cache read failure should never break the call */ }

    // 2. Circuit breaker.
    if (!_allow(cacheKey)) {
        return { ok: false, code: 'CIRCUIT_OPEN', error: 'Railway circuit open' };
    }

    // 3. Real call.
    try {
        const data = await graphql(query, variables);
        _recordSuccess(cacheKey);
        try {
            await supabaseAdmin.from('app_config').upsert({
                key: cacheFullKey,
                value: data,
                updated_at: new Date().toISOString()
            });
        } catch (_) { /* cache write is best-effort */ }
        return { ok: true, fromCache: false, data, ageMs: 0 };
    } catch (e) {
        _recordFailure(cacheKey);
        return { ok: false, code: e.code, error: e.message };
    }
}

// ─── Named queries ──────────────────────────────────────────────

// Usage / cost overview for the project.
const USAGE_QUERY = `
query ProjectUsage($projectId: String!) {
  usage: projectUsage(projectId: $projectId) {
    currentPeriod {
      startDate
      endDate
    }
    measurement {
      estimatedUsage
      currentUsage
      includedUsage
      overage
    }
    breakdown {
      cpu
      memory
      network
      disk
    }
  }
}`;

// Latest deployment for the environment.
const DEPLOYMENT_QUERY = `
query LatestDeployment($projectId: String!, $environmentId: String!) {
  deployments(first: 1, input: { projectId: $projectId, environmentId: $environmentId }) {
    edges {
      node {
        id
        status
        createdAt
        updatedAt
        staticUrl
        meta
      }
    }
  }
}`;

// Metrics for the service over the last hour.
const METRICS_QUERY = `
query ServiceMetrics($serviceId: String!, $start: DateTime!, $end: DateTime!) {
  metrics(
    serviceId: $serviceId
    startDate: $start
    endDate: $end
    measurements: [CPU_USAGE, MEMORY_USAGE_GB, NETWORK_TX_GB, NETWORK_RX_GB, DISK_USAGE_GB]
  ) {
    measurement
    values {
      ts
      value
    }
  }
}`;

async function getUsage() {
    if (!projectId()) return { ok: false, code: 'NOT_CONFIGURED', error: 'RAILWAY_PROJECT_ID missing' };
    return cachedQuery({
        cacheKey: 'usage',
        ttlSeconds: 15 * 60,
        query: USAGE_QUERY,
        variables: { projectId: projectId() }
    });
}

async function getDeployment() {
    if (!projectId() || !environmentId()) {
        return { ok: false, code: 'NOT_CONFIGURED', error: 'RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID missing' };
    }
    return cachedQuery({
        cacheKey: 'deployment',
        ttlSeconds: 60,
        query: DEPLOYMENT_QUERY,
        variables: { projectId: projectId(), environmentId: environmentId() }
    });
}

async function getMetrics() {
    if (!serviceId()) return { ok: false, code: 'NOT_CONFIGURED', error: 'RAILWAY_SERVICE_ID missing' };
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    return cachedQuery({
        cacheKey: 'metrics',
        ttlSeconds: 5 * 60,
        query: METRICS_QUERY,
        variables: {
            serviceId: serviceId(),
            start: start.toISOString(),
            end: end.toISOString()
        }
    });
}

// Normalize a metrics response into per-measurement {latest, avg, max}.
function summarizeMetrics(raw) {
    const out = {};
    const rows = raw?.metrics || [];
    for (const row of rows) {
        const key = String(row.measurement || '').toUpperCase();
        const values = (row.values || []).map(v => Number(v.value)).filter(Number.isFinite);
        if (!values.length) { out[key] = null; continue; }
        const latest = values[values.length - 1];
        const sum = values.reduce((a, b) => a + b, 0);
        out[key] = {
            latest,
            avg: sum / values.length,
            max: Math.max(...values),
            samples: values.length
        };
    }
    return out;
}

module.exports = {
    isConfigured,
    graphql,
    getUsage,
    getDeployment,
    getMetrics,
    summarizeMetrics,
    breakerSnapshot,
    _internal: { cachedQuery }
};