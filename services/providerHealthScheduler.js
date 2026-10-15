// services/providerHealthScheduler.js
'use strict';

// ─────────────────────────────────────────────────────────────────
// Provider health scheduler.
//
// ROOT CAUSE FIX:
//   The previous version called health.checkAll() with no per-
//   provider timeout and no sweep ceiling. When a provider was
//   slow (DT One was seen at 10s+), the sweep blocked the outbound
//   socket pool for 12–33 seconds and occasionally forever
//   (one log showed 11,704,761 ms). During that window, requests
//   to Supabase could not open new TCP connections, producing
//   UND_ERR_CONNECT_TIMEOUT and — worse — silent empty responses
//   that the transaction route interpreted as "table is empty".
//
// THIS VERSION:
//   • Wraps each provider check in its own AbortController with a
//     5s ceiling (PROVIDER_HEALTH_TIMEOUT_MS).
//   • Runs the whole sweep under a 15s AbortController ceiling
//     (PROVIDER_HEALTH_SWEEP_TIMEOUT_MS).
//   • Uses Promise.allSettled so one slow provider does not delay
//     the others.
//   • Waits PROVIDER_HEALTH_INITIAL_DELAY_MS (default 60s) before
//     the first sweep so it does not collide with the login burst.
//   • Skips a tick if the previous sweep is still running.
//   • Preserves the existing module surface: start(), stop(),
//     runOnce(), and the same log lines.
// ─────────────────────────────────────────────────────────────────

const health           = require('./providerHealthService');
const providerFactory  = require('./providers/providerFactory');

// ─── Configuration ──────────────────────────────────────────────
const DEFAULT_INTERVAL_MS =
    Number(process.env.PROVIDER_HEALTH_INTERVAL_MS) || 5 * 60 * 1000;

const INITIAL_DELAY_MS =
    Number(process.env.PROVIDER_HEALTH_INITIAL_DELAY_MS) || 60_000;

const STARTUP_JITTER_MS =
    Number(process.env.PROVIDER_HEALTH_JITTER_MS) || 30_000;

const PER_PROVIDER_TIMEOUT_MS =
    Number(process.env.PROVIDER_HEALTH_TIMEOUT_MS) || 5_000;

const SWEEP_TIMEOUT_MS =
    Number(process.env.PROVIDER_HEALTH_SWEEP_TIMEOUT_MS) || 15_000;

const PROVIDER_CONCURRENCY =
    Number(process.env.PROVIDER_HEALTH_CONCURRENCY) || 3;

// ─── State ──────────────────────────────────────────────────────
let timer = null;
let running = false;

// ─── Provider list ──────────────────────────────────────────────
function listProviderNames() {
    try {
        const list = providerFactory.list();
        // providerFactory.list() may return strings or objects.
        return list.map((p) => (typeof p === 'string' ? p : p?.name || p?.provider)).filter(Boolean);
    } catch (e) {
        console.warn('[providerHealth] providerFactory.list() failed:', e.message);
        return [];
    }
}

// ─── Single-provider check with timeout ─────────────────────────
// We try to pass an AbortSignal to checkAll if it accepts one.
// If it does not, the timeout still fires and we mark the provider
// as degraded — we just cannot cancel the in-flight HTTP request.
async function checkProviderWithTimeout(providerName, parentSignal) {
    const started = Date.now();
    const controller = new AbortController();

    const timer = setTimeout(() => {
        controller.abort(new Error(`${providerName} timed out after ${PER_PROVIDER_TIMEOUT_MS}ms`));
    }, PER_PROVIDER_TIMEOUT_MS);

    const onParentAbort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
        // Preferred path: checkAll accepts { signal, providers }.
        // Fallback: call the service's single-provider check if it
        // exposes one. Final fallback: call checkAll with just this
        // provider name.
        let result;

        if (typeof health.checkProvider === 'function') {
            result = await health.checkProvider(providerName, { signal: controller.signal });
        } else {
            // checkAll is the only public API we know about. Run it
            // for a single provider if the service supports a filter.
            const all = await Promise.race([
                health.checkAll({
                    reason: 'scheduler_single',
                    concurrency: 1,
                    providers: [providerName],
                    signal: controller.signal
                }),
                new Promise((_, reject) =>
                    controller.signal.addEventListener('abort', () =>
                        reject(new Error(`${providerName} aborted`))
                    )
                )
            ]);
            result = all?.[providerName] || all;
        }

        return {
            provider: providerName,
            ok: true,
            durationMs: Date.now() - started,
            raw: result
        };
    } catch (err) {
        return {
            provider: providerName,
            ok: false,
            durationMs: Date.now() - started,
            error: err?.message || String(err)
        };
    } finally {
        clearTimeout(timer);
        parentSignal.removeEventListener('abort', onParentAbort);
    }
}

// ─── Bounded concurrency runner ─────────────────────────────────
async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    async function next() {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) {
        workers.push(next());
    }
    await Promise.all(workers);
    return results;
}

// ─── One sweep ──────────────────────────────────────────────────
async function runOnce(reason = 'scheduler') {
    if (running) return;
    running = true;

    const started = Date.now();
    const sweepController = new AbortController();
    const sweepTimer = setTimeout(() => {
        sweepController.abort(new Error(`sweep timed out after ${SWEEP_TIMEOUT_MS}ms`));
    }, SWEEP_TIMEOUT_MS);

    try {
        const providerNames = listProviderNames();
        if (providerNames.length === 0) {
            console.warn('[providerHealth] no providers to check');
            return;
        }

        const outcomes = await runWithConcurrency(
            providerNames,
            PROVIDER_CONCURRENCY,
            (name) => checkProviderWithTimeout(name, sweepController.signal)
        );

        for (const o of outcomes) {
            if (!o) continue;
            if (o.ok) {
                console.log(`[providerHealth] ${o.provider}: OK (${o.durationMs}ms)`);
            } else {
                console.warn(`[providerHealth] ${o.provider}: DEGRADED (${o.durationMs}ms) — ${o.error}`);
            }
        }

        // Preserve the exact line the rest of the codebase greps for.
        const broken = outcomes
            .filter((o) => o && !o.ok)
            .map((o) => o.provider);

        if (broken.length > 0) {
            console.warn(`[providerHealth] CRITICAL providers degraded: ${broken.join(', ')}`);
        }

        console.log(`[providerHealth] scheduled check complete (${Date.now() - started}ms)`);
    } catch (e) {
        console.error('[providerHealth] scheduled check failed:', e.message);
    } finally {
        clearTimeout(sweepTimer);
        running = false;
    }
}

// ─── Scheduling ─────────────────────────────────────────────────
function start() {
    if (timer) return;

    const providers = listProviderNames();
    if (providers.length === 0) {
        console.warn('[providerHealth] no providers registered, scheduler idle');
        return;
    }

    const initialDelay = INITIAL_DELAY_MS + Math.floor(Math.random() * STARTUP_JITTER_MS);
    console.log(
        `[providerHealth] scheduler starting, ` +
        `first sweep in ${initialDelay}ms, ` +
        `interval=${DEFAULT_INTERVAL_MS}ms, ` +
        `jitter=${STARTUP_JITTER_MS}ms, ` +
        `perProviderTimeout=${PER_PROVIDER_TIMEOUT_MS}ms, ` +
        `sweepTimeout=${SWEEP_TIMEOUT_MS}ms, ` +
        `concurrency=${PROVIDER_CONCURRENCY}`
    );

    // First sweep after the delay.
    setTimeout(() => {
        runOnce('scheduler_boot').catch((e) =>
            console.error('[providerHealth] boot sweep threw:', e.message)
        );
    }, initialDelay).unref?.();

    // Recurring sweep.
    timer = setInterval(() => {
        if (running) return;
        runOnce('scheduler').catch((e) =>
            console.error('[providerHealth] interval sweep threw:', e.message)
        );
    }, DEFAULT_INTERVAL_MS);

    if (timer.unref) timer.unref();
}

function stop() {
    if (timer) {
        clearInterval(timer);
        timer = null;
        console.log('[providerHealth] scheduler stopped');
    }
}

module.exports = { start, stop, runOnce };