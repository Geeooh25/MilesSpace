'use strict';

const { supabaseAdmin } = require('../db/supabase');
const providerFactory = require('./providers/providerFactory');
const breaker = require('./providers/providerCircuitBreaker');
const metadata = require('./providers/providerMetadata');
const { maskHeaders, sanitizeProviderError } = require('./providers/providerBase');

const WEBHOOK_WINDOW_HOURS = 24;
const STALE_AFTER_MS = 10 * 60 * 1000;
const SEVERELY_STALE_AFTER_MS = 30 * 60 * 1000;
const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 100;
const WEBHOOK_HISTORY_DEFAULT = 30;
const WEBHOOK_HISTORY_MAX = 200;

function computeStaleness(lastCheckedAt) {
    if (!lastCheckedAt) return 'unknown';
    const age = Date.now() - new Date(lastCheckedAt).getTime();
    if (age <= STALE_AFTER_MS) return 'current';
    if (age <= SEVERELY_STALE_AFTER_MS) return 'stale';
    return 'severely_stale';
}

function clampLimit(value, def, max) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.min(n, max);
}

// ─── Read (snapshot only — never calls providers) ──────────────

async function getProviderHealth() {
    const { data: rows, error } = await supabaseAdmin
        .from('provider_health')
        .select('provider, label, status, configured, enabled, reachable, authenticated, functional, latency_ms, last_checked_at, last_success_at, last_failure_at, consecutive_failures, consecutive_successes, error_code, error_category, error_message, webhook_status, last_webhook_at, failed_webhooks_24h, webhook_processing_latency_ms, webhook_signature_failures_24h, webhook_duplicates_24h, last_successful_operation_at, category, critical, environment, health_strategy, metadata, updated_at')
        .order('provider', { ascending: true });

    if (error && error.code !== '42P01') throw error;

    const out = {};
    for (const r of rows || []) out[r.provider] = shapeHealthRow(r);

    // Ensure every registered adapter appears even before its first
    // persisted check.
    for (const name of providerFactory.list()) {
        if (!out[name]) {
            const adapter = providerFactory.get(name);
            const meta = metadata.getMetadata(name) || {};
            out[name] = {
                provider: name,
                label: adapter?.label || name,
                status: adapter?.isConfigured?.() ? 'configured' : 'not_configured',
                configured: !!adapter?.isConfigured?.(),
                enabled: !!meta.enabled,
                reachable: null,
                authenticated: null,
                functional: null,
                latencyMs: null,
                lastCheckedAt: null,
                lastSuccessAt: null,
                lastFailureAt: null,
                consecutiveFailures: 0,
                consecutiveSuccesses: 0,
                errorCode: null,
                errorCategory: null,
                errorMessage: null,
                webhookStatus: meta.supportsWebhook ? 'never_seen' : 'not_applicable',
                lastWebhookAt: null,
                failedWebhooks24h: 0,
                webhookProcessingLatencyMs: null,
                webhookSignatureFailures24h: 0,
                webhookDuplicates24h: 0,
                lastSuccessfulOperationAt: null,
                category: meta.category || null,
                critical: !!meta.critical,
                environment: meta.environment || null,
                healthStrategy: meta.healthStrategy || null,
                metadata: {},
                updatedAt: null,
                staleness: 'unknown',
                breaker: breaker.snapshot()[name] || null
            };
        }
    }

    const snap = breaker.snapshot();
    for (const name of Object.keys(out)) {
        out[name].breaker = snap[name] || null;
        out[name].staleness = computeStaleness(out[name].lastCheckedAt);
        if (!out[name].healthStrategy) {
            const m = metadata.getMetadata(name);
            out[name].healthStrategy = m?.healthStrategy || null;
        }
    }

    return out;
}

function shapeHealthRow(r) {
    return {
        provider: r.provider,
        label: r.label || r.provider,
        status: r.status,
        configured: !!r.configured,
        enabled: r.enabled !== false,
        reachable: r.reachable,
        authenticated: r.authenticated,
        functional: r.functional,
        latencyMs: r.latency_ms,
        lastCheckedAt: r.last_checked_at,
        lastSuccessAt: r.last_success_at,
        lastFailureAt: r.last_failure_at,
        consecutiveFailures: r.consecutive_failures || 0,
        consecutiveSuccesses: r.consecutive_successes || 0,
        errorCode: r.error_code || null,
        errorCategory: r.error_category || null,
        errorMessage: r.error_message || null,
        webhookStatus: r.webhook_status || null,
        lastWebhookAt: r.last_webhook_at,
        failedWebhooks24h: r.failed_webhooks_24h || 0,
        webhookProcessingLatencyMs: r.webhook_processing_latency_ms ?? null,
        webhookSignatureFailures24h: r.webhook_signature_failures_24h || 0,
        webhookDuplicates24h: r.webhook_duplicates_24h || 0,
        lastSuccessfulOperationAt: r.last_successful_operation_at || null,
        category: r.category || null,
        critical: !!r.critical,
        environment: r.environment || null,
        healthStrategy: r.health_strategy || null,
        metadata: r.metadata || {},
        updatedAt: r.updated_at,
        staleness: computeStaleness(r.last_checked_at)
    };
}

// ─── System-level rollup (point 14) ────────────────────────────

function deriveSystemStatus(providers, summary) {
    if (!summary.total) return 'unknown';
    if (summary.critical_down > 0) return 'major_outage';
    if (summary.offline > 0 || summary.degraded > 0) return 'degraded';
    if (summary.healthy === summary.total) return 'operational';
    return 'unknown';
}

// ─── Check (only path that touches providers) ──────────────────

async function checkProvider(name, { adminId = null, reason = 'manual' } = {}) {
    const result = await providerFactory.healthOne(name);
    const webhookInfo = await getWebhookStatus(name);
    const lastOp = await getLastSuccessfulOperation(name);

    try {
        await supabaseAdmin.rpc('provider_health_upsert', {
            p_provider: name,
            p_label: result.label,
            p_status: result.status,
            p_configured: !!result.configured,
            p_enabled: result.enabled !== false,
            p_reachable: result.reachable,
            p_authenticated: result.authenticated,
            p_functional: result.functional,
            p_latency_ms: result.latencyMs,
            p_error_code: result.errorCode,
            p_error_category: result.errorCategory,
            p_error_message: sanitizeProviderError(result.errorMessage, 500),
            p_webhook_status: webhookInfo.status,
            p_category: result.category,
            p_critical: !!result.critical,
            p_environment: result.environment,
            p_health_strategy: result.healthStrategy || null,
            p_webhook_processing_latency_ms: webhookInfo.processingLatencyMs ?? null,
            p_webhook_signature_failures_24h: webhookInfo.signatureFailures ?? 0,
            p_webhook_duplicates_24h: webhookInfo.duplicates ?? 0,
            p_last_successful_operation_at: lastOp?.at || null,
            p_metadata: {
                reason,
                admin_id: adminId,
                diagnostics: result.diagnostics || null,
                note: result.note || null
            }
        });
    } catch (e) {
        console.warn('[providerHealth] upsert failed:', e.message);
    }

    try {
        await supabaseAdmin.from('provider_health_events').insert({
            provider: name,
            event_type: 'check',
            status: result.status,
            latency_ms: result.latencyMs,
            error_code: result.errorCode,
            error_category: result.errorCategory,
            error_message: sanitizeProviderError(result.errorMessage, 500),
            metadata: { reason, admin_id: adminId },
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[providerHealth] event insert failed:', e.message);
    }

    return result;
}

async function checkAll({ adminId = null, reason = 'manual', concurrency = 3 } = {}) {
    const names = providerFactory.list();
    const results = {};
    const queue = [...names];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }).map(async () => {
        while (queue.length) {
            const n = queue.shift();
            results[n] = await checkProvider(n, { adminId, reason });
        }
    });
    await Promise.all(workers);
    return results;
}

// Scheduler entry point: skip providers whose last check is still
// within their metadata-declared interval. This is the point-5 fix.
async function checkDueProviders({ adminId = null, reason = 'scheduler', now = Date.now() } = {}) {
    const snapshot = await getProviderHealth();
    const due = [];
    for (const name of providerFactory.list()) {
        const meta = metadata.getMetadata(name) || {};
        const interval = meta.healthIntervalMs || 5 * 60 * 1000;
        const last = snapshot[name]?.lastCheckedAt;
        if (!last) { due.push(name); continue; }
        if (now - new Date(last).getTime() >= interval) due.push(name);
    }
    const results = {};
    const queue = [...due];
    const workers = Array.from({ length: Math.min(3, queue.length) }).map(async () => {
        while (queue.length) {
            const n = queue.shift();
            results[n] = await checkProvider(n, { adminId, reason });
        }
    });
    await Promise.all(workers);
    return results;
}

// ─── Webhook state (points 11, 12) ─────────────────────────────

async function getWebhookStatus(provider) {
    const meta = metadata.getMetadata(provider) || {};
    if (meta.supportsWebhook === false) {
        return { status: 'not_applicable', lastAt: null, failed: 0, total: 0, processingLatencyMs: null, signatureFailures: 0, duplicates: 0 };
    }

    const since = new Date(Date.now() - WEBHOOK_WINDOW_HOURS * 3600 * 1000).toISOString();

    try {
        const [totalRes, failedRes, sigFailRes, dupRes, lastRes, latencyRes] = await Promise.all([
            supabaseAdmin.from('webhook_events').select('id', { count: 'exact', head: true }).eq('provider', provider).gte('received_at', since),
            supabaseAdmin.from('webhook_events').select('id', { count: 'exact', head: true }).eq('provider', provider).eq('processing_status', 'failed').gte('received_at', since),
            supabaseAdmin.from('webhook_events').select('id', { count: 'exact', head: true }).eq('provider', provider).eq('signature_valid', false).gte('received_at', since),
            supabaseAdmin.from('webhook_events').select('id', { count: 'exact', head: true }).eq('provider', provider).eq('duplicate', true).gte('received_at', since),
            supabaseAdmin.from('webhook_events').select('received_at').eq('provider', provider).order('received_at', { ascending: false }).limit(1).maybeSingle(),
            supabaseAdmin.from('webhook_events').select('received_at, processed_at').eq('provider', provider).not('processed_at', 'is', null).gte('received_at', since).order('received_at', { ascending: false }).limit(50)
        ]);

        const total = totalRes.count || 0;
        const failed = failedRes.count || 0;
        const sigFailures = sigFailRes.count || 0;
        const duplicates = dupRes.count || 0;
        const lastAt = lastRes.data?.received_at || null;

        let processingLatencyMs = null;
        if (latencyRes.data?.length) {
            const deltas = latencyRes.data
                .map(r => (new Date(r.processed_at).getTime() - new Date(r.received_at).getTime()))
                .filter(n => Number.isFinite(n) && n >= 0);
            if (deltas.length) processingLatencyMs = Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length);
        }

        let status;
        if (total === 0 && !lastAt) status = 'never_seen';
        else if (total === 0)       status = 'quiet';
        else if (failed === 0 && sigFailures === 0) status = 'healthy';
        else if (failed / total < 0.1) status = 'degraded';
        else                         status = 'failing';

        try {
            await supabaseAdmin.from('provider_health').update({
                webhook_status: status,
                last_webhook_at: lastAt,
                failed_webhooks_24h: failed,
                webhook_processing_latency_ms: processingLatencyMs,
                webhook_signature_failures_24h: sigFailures,
                webhook_duplicates_24h: duplicates,
                updated_at: new Date().toISOString()
            }).eq('provider', provider);
        } catch (_) {}

        return { status, lastAt, failed, total, processingLatencyMs, signatureFailures: sigFailures, duplicates };
    } catch (e) {
        return { status: 'unknown', lastAt: null, failed: 0, total: 0, processingLatencyMs: null, signatureFailures: 0, duplicates: 0 };
    }
}

// ─── Last successful business operation (point 38) ─────────────

async function getLastSuccessfulOperation(provider) {
    try {
        const { data } = await supabaseAdmin
            .from('orders')
            .select('completed_at, updated_at, created_at')
            .eq('provider', provider)
            .eq('status', 'completed')
            .order('completed_at', { ascending: false, nullsFirst: false })
            .limit(1)
            .maybeSingle();
        const at = data?.completed_at || data?.updated_at || data?.created_at || null;
        return at ? { at } : null;
    } catch {
        return null;
    }
}

// ─── History + aggregates (points 19, 37) ──────────────────────

async function getHealthHistory(provider, { limit = HISTORY_DEFAULT } = {}) {
    const lim = clampLimit(limit, HISTORY_DEFAULT, HISTORY_MAX);
    const { data, error } = await supabaseAdmin
        .from('provider_health_events')
        .select('id, event_type, status, latency_ms, error_code, error_category, error_message, created_at')
        .eq('provider', provider)
        .order('created_at', { ascending: false })
        .limit(lim);
    if (error) throw error;
    return data || [];
}

async function getLatencyStats(provider) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data } = await supabaseAdmin
        .from('provider_health_events')
        .select('latency_ms, created_at')
        .eq('provider', provider)
        .gte('created_at', since)
        .not('latency_ms', 'is', null);
    const rows = data || [];
    if (!rows.length) return { avg5m: null, avg1h: null, avg24h: null, p95: null, count: 0 };

    const now = Date.now();
    const bucket = (min) => rows.filter(r => now - new Date(r.created_at).getTime() <= min * 60 * 1000).map(r => r.latency_ms);
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    const sorted = rows.map(r => r.latency_ms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? null;
    return {
        avg5m: avg(bucket(5)),
        avg1h: avg(bucket(60)),
        avg24h: avg(sorted),
        p95,
        count: sorted.length
    };
}

async function getWebhookHistory(provider, { limit = WEBHOOK_HISTORY_DEFAULT } = {}) {
    const lim = clampLimit(limit, WEBHOOK_HISTORY_DEFAULT, WEBHOOK_HISTORY_MAX);
    const { data, error } = await supabaseAdmin
        .from('webhook_events')
        .select('id, event_type, signature_valid, processing_status, processing_error, received_at, processed_at')
        .eq('provider', provider)
        .order('received_at', { ascending: false })
        .limit(lim);
    if (error) throw error;
    return (data || []).map(r => ({
        ...r,
        processing_latency_ms: r.processed_at && r.received_at
            ? Math.max(0, new Date(r.processed_at).getTime() - new Date(r.received_at).getTime())
            : null
    }));
}

// ─── Business activity (points 35, 37, 39) ─────────────────────

async function getBusinessHealth(provider) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    try {
        const { data } = await supabaseAdmin
            .from('orders')
            .select('status, service_type, completed_at')
            .eq('provider', provider)
            .gte('created_at', since);

        const rows = data || [];
        const total = rows.length;
        const successful = rows.filter(r => r.status === 'completed').length;
        const failed = rows.filter(r => ['failed','cancelled'].includes(r.status)).length;
        const pending = rows.filter(r => ['pending','processing','in_progress','partial'].includes(r.status)).length;

        // Service-level breakdown (point 35)
        const meta = metadata.getMetadata(provider) || {};
        const areas = (meta.serviceAreas || []).map(a => {
            const inArea = rows.filter(r => String(r.service_type || '').toLowerCase() === a.key);
            const areaTotal = inArea.length;
            const areaDone = inArea.filter(r => r.status === 'completed').length;
            const areaFailed = inArea.filter(r => ['failed','cancelled'].includes(r.status)).length;
            let status = 'unknown';
            if (areaTotal === 0) status = 'no_traffic';
            else if (areaFailed === 0) status = 'healthy';
            else if (areaFailed / areaTotal < 0.2) status = 'degraded';
            else status = 'failing';
            return {
                key: a.key,
                label: a.label,
                orders24h: areaTotal,
                successful: areaDone,
                failed: areaFailed,
                status
            };
        });

        return {
            orders24h: total,
            successful,
            failed,
            pending,
            successRate: total > 0 ? +(successful / total * 100).toFixed(1) : null,
            areas
        };
    } catch {
        return { orders24h: 0, successful: 0, failed: 0, pending: 0, successRate: null, areas: [] };
    }
}

// ─── Sanitized detail ──────────────────────────────────────────

async function getProviderDetail(provider) {
    const adapter = providerFactory.get(provider);
    if (!adapter) { const e = new Error('Unknown provider.'); e.status = 404; e.code = 'UNKNOWN_PROVIDER'; throw e; }
    const all = await getProviderHealth();
    const base = all[provider] || { provider, label: adapter.label || provider, status: 'unknown' };

    const [history, webhooks, latency, business] = await Promise.all([
        getHealthHistory(provider, { limit: 50 }).catch(() => []),
        getWebhookHistory(provider, { limit: 30 }).catch(() => []),
        getLatencyStats(provider).catch(() => ({})),
        getBusinessHealth(provider).catch(() => ({}))
    ]);

    const meta = metadata.getMetadata(provider) || {};

    return {
        ...base,
        meta,
        capabilities: {
            hasBalance:     typeof adapter.getBalance === 'function',
            hasCreateOrder: typeof adapter.createOrder === 'function',
            hasCancelOrder: typeof adapter.cancelOrder === 'function',
            hasRefundOrder: typeof adapter.refundOrder === 'function',
            hasGetStatus:   typeof adapter.getOrderStatus === 'function',
            hasWebhooks:    typeof adapter.verifyWebhook === 'function'
        },
        latency,
        business,
        history,
        webhooks
    };
}

// ─── Retention helper (point 18) ───────────────────────────────

async function pruneOldHealthEvents({ retentionDays = 30 } = {}) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
    try {
        const { error } = await supabaseAdmin
            .from('provider_health_events')
            .delete()
            .lt('created_at', cutoff);
        if (error) throw error;
        return { ok: true, cutoff };
    } catch (e) {
        return { ok: false, error: e.message, cutoff };
    }
}

module.exports = {
    getProviderHealth,
    checkProvider,
    checkAll,
    checkDueProviders,
    getProviderDetail,
    getHealthHistory,
    getWebhookHistory,
    getLatencyStats,
    getBusinessHealth,
    getLastSuccessfulOperation,
    getWebhookStatus,
    pruneOldHealthEvents,
    deriveSystemStatus,
    maskHeaders
};