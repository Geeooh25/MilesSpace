'use strict';

const breaker = require('./providerCircuitBreaker');
const { withTimeout, TIMEOUTS } = require('./providerBase');
const metadata = require('./providerMetadata');

const REGISTRY = Object.create(null);

for (const m of metadata.listMetadata()) {
    try {
        const adapter = require(m.path);
        if (adapter && typeof adapter === 'object') {
            REGISTRY[m.name] = {
                ...adapter,
                enabled: m.enabled,
                critical: m.critical,
                category: m.category,
                environment: adapter.environment || m.environment,
                healthStrategy: m.healthStrategy
            };
        }
    } catch (e) {
        console.warn(`[providerFactory] ${m.name} adapter not loaded:`, e.message);
    }
}

function get(name) { return REGISTRY[String(name || '').toLowerCase()] || null; }
function getOrThrow(name) {
    const a = get(name);
    if (!a) { const e = new Error(`Unknown provider: ${name}`); e.code = 'UNKNOWN_PROVIDER'; e.status = 400; throw e; }
    return a;
}
function list() { return Object.keys(REGISTRY); }
function labels() { const o = {}; for (const [k, a] of Object.entries(REGISTRY)) o[k] = a.label || k; return o; }

function describe(name) {
    const adapter = get(name);
    if (!adapter) return null;
    const meta = metadata.getMetadata(name) || {};
    return {
        name,
        label: adapter.label || name,
        enabled: !!meta.enabled,
        critical: !!meta.critical,
        category: meta.category || null,
        environment: meta.environment || null,
        healthStrategy: meta.healthStrategy || null,
        supportsWebhook: meta.supportsWebhook !== false,
        supportsBalance: !!meta.supportsBalance,
        services: meta.services || [],
        serviceAreas: meta.serviceAreas || [],
        lastSuccessfulOperationLabel: meta.lastSuccessfulOperationLabel || 'Last successful operation',
        incidentImpact: meta.incidentImpact || null
    };
}

async function healthOne(name) {
    const adapter = get(name);
    if (!adapter) {
        return {
            provider: name, label: name,
            status: 'unknown', configured: false, enabled: false,
            reachable: null, authenticated: null, functional: null, latencyMs: null,
            category: null, critical: false, environment: null,
            errorCode: 'UNKNOWN_PROVIDER', errorCategory: 'UNKNOWN', errorMessage: 'Adapter not loaded'
        };
    }

    const meta = metadata.getMetadata(name) || {};

    if (typeof adapter.isConfigured === 'function' && !adapter.isConfigured()) {
        return {
            provider: name, label: adapter.label || name,
            status: 'not_configured', configured: false, enabled: !!meta.enabled,
            reachable: null, authenticated: null, functional: null, latencyMs: null,
            category: meta.category || null, critical: !!meta.critical,
            environment: meta.environment || null,
            errorCode: 'NOT_CONFIGURED', errorCategory: 'CONFIGURATION',
            errorMessage: 'Missing credentials on the server'
        };
    }

    if (!breaker.allowRequest(name)) {
        return {
            provider: name, label: adapter.label || name,
            status: 'circuit_open', configured: true, enabled: !!meta.enabled,
            reachable: false, authenticated: null, functional: false, latencyMs: null,
            category: meta.category || null, critical: !!meta.critical,
            environment: meta.environment || null,
            errorCode: 'CIRCUIT_OPEN', errorCategory: 'CONFIGURATION',
            errorMessage: 'Circuit breaker is open — skipping provider call'
        };
    }

    const started = Date.now();
    try {
        const result = await withTimeout(() => adapter.healthCheck(), TIMEOUTS.HEALTH, `${name}.healthCheck`);
        const latencyMs = result?.latencyMs ?? (Date.now() - started);
        const reachable = result?.reachable === true;
        const authenticated = result?.authenticated !== false && reachable;
        const functional = result?.functional === true || (reachable && authenticated);

        if (reachable) breaker.recordSuccess(name); else breaker.recordFailure(name);

        const status = functional ? 'healthy'
                     : reachable && !authenticated ? 'auth_failed'
                     : reachable && !functional ? 'degraded'
                     : 'unreachable';

        return {
            provider: name, label: adapter.label || name,
            status, configured: true, enabled: !!meta.enabled,
            reachable, authenticated, functional, latencyMs,
            category: meta.category || null, critical: !!meta.critical,
            environment: result?.environment || meta.environment || null,
            errorCode: result?.errorCode || null,
            errorCategory: result?.errorCategory || null,
            errorMessage: result?.errorMessage || null,
            diagnostics: result?.diagnostics || null
        };
    } catch (e) {
        breaker.recordFailure(name);
        const latencyMs = Date.now() - started;
        let status = 'unreachable';
        if (e.code === 'PROVIDER_TIMEOUT') status = 'unreachable';
        if (e.status === 401 || e.status === 403) status = 'auth_failed';
        if (e.status === 429) status = 'rate_limited';
        return {
            provider: name, label: adapter.label || name,
            status, configured: true, enabled: !!meta.enabled,
            reachable: false, authenticated: false, functional: false, latencyMs,
            category: meta.category || null, critical: !!meta.critical,
            environment: meta.environment || null,
            errorCode: e.code || 'HEALTH_FAILED',
            errorCategory: e.category || 'UNKNOWN',
            errorMessage: String(e.message || '').slice(0, 300)
        };
    }
}

async function healthAll({ concurrency = 3 } = {}) {
    const names = list();
    const results = {};
    const queue = [...names];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }).map(async () => {
        while (queue.length) {
            const n = queue.shift();
            results[n] = await healthOne(n);
        }
    });
    await Promise.all(workers);
    return results;
}

module.exports = { get, getOrThrow, list, labels, describe, healthOne, healthAll };