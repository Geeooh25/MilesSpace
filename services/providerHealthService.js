// services/providerHealthService.js
// ─────────────────────────────────────────────────────────────────
// Provider health snapshot. Called by the admin dashboard and
// background sync. Cached for 60s so repeated page loads don't
// hammer providers.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const providerFactory = require('./providers/providerFactory');

const CACHE_TTL_MS = 60 * 1000;
let _cache = { at: 0, data: null };

async function getProviderHealth({ force = false } = {}) {
    if (!force && _cache.data && Date.now() - _cache.at < CACHE_TTL_MS) {
        return _cache.data;
    }
    const live = await providerFactory.healthAll();
    const out = {};

    for (const [name, health] of Object.entries(live)) {
        // Recent activity from orders.
        let lastSuccess = null, lastFailure = null, recentCount = 0;
        try {
            const { data: ok } = await supabaseAdmin.from('orders')
                .select('updated_at').eq('provider', name).eq('status', 'completed')
                .order('updated_at', { ascending: false }).limit(1).maybeSingle();
            lastSuccess = ok?.updated_at || null;

            const { data: bad } = await supabaseAdmin.from('orders')
                .select('updated_at, failure_reason').eq('provider', name).eq('status', 'failed')
                .order('updated_at', { ascending: false }).limit(1).maybeSingle();
            if (bad) lastFailure = { at: bad.updated_at, reason: bad.failure_reason || null };

            const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const { count } = await supabaseAdmin.from('orders')
                .select('id', { count: 'exact', head: true })
                .eq('provider', name).gte('created_at', since);
            recentCount = count || 0;
        } catch (_) {}

        // Webhook activity.
        let lastWebhook = null, failedWebhooks = 0;
        try {
            const { data: wh } = await supabaseAdmin.from('webhook_events')
                .select('received_at, processing_status').eq('provider', name)
                .order('received_at', { ascending: false }).limit(1).maybeSingle();
            lastWebhook = wh?.received_at || null;

            const { count } = await supabaseAdmin.from('webhook_events')
                .select('id', { count: 'exact', head: true })
                .eq('provider', name).eq('processing_status', 'failed');
            failedWebhooks = count || 0;
        } catch (_) {}

        const status =
            !health.configured ? 'not_configured' :
            !health.reachable  ? 'unavailable' :
            lastFailure && (!lastSuccess || new Date(lastFailure.at) > new Date(lastSuccess))
                ? 'degraded'
                : 'operational';

        out[name] = {
            provider: name,
            status,
            configured: health.configured,
            reachable: health.reachable,
            lastSuccess,
            lastFailure,
            recentCount,
            lastError: health.lastError || null,
            lastWebhook,
            failedWebhooks
        };
    }

    _cache = { at: Date.now(), data: out };
    return out;
}

module.exports = { getProviderHealth };