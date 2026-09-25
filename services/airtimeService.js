// services/airtimeService.js
// ─────────────────────────────────────────────────────────────────
// Airtime — service layer.
//
// The Airtime admin shows a UNION of TWO provider tables:
//
//   • airtime_transactions        — DT One (Global Airtime)
//   • bill_payment_transactions   — VTpass, service_type = 'airtime'
//
// Read paths merge both. Write paths (sync, retry, refund, review)
// dispatch to the correct table based on the row's `provider` field.
//
// Everything else — the state machine, atomic finalization, safe
// retry, provider health — is unchanged and provider-agnostic.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');

const dtoneAdapter  = require('./airtimeProviders/dtoneAdapter');
const vtpassAdapter = require('./airtimeProviders/vtpassAdapter');

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Airtime order statuses across both providers. DT One + VTpass
// together produce this set. The admin treats them all as valid.
const ORDER_STATUSES = new Set([
    'pending', 'processing', 'completed', 'failed', 'refunded',
    'manual_review', 'cancelled', 'reversed', 'provider_unknown',
    'pending_payment', 'paid', 'provider_pending',
    'reconciliation_required', 'refund_pending'
]);

const PENDING_STATUSES = new Set([
    'pending', 'processing', 'provider_unknown', 'pending_payment',
    'paid', 'provider_pending', 'refund_pending', 'reconciliation_required'
]);
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'reversed']);

// State machine used only for admin-initiated transitions. The
// customer flows write their own statuses; we never rewrite them
// from here unless the admin is explicitly acting.
const ALLOWED_TRANSITIONS = Object.freeze({
    pending:                 ['processing', 'cancelled', 'failed', 'reconciliation_required'],
    processing:              ['provider_pending', 'reconciliation_required', 'completed', 'failed'],
    provider_pending:        ['processing', 'reconciliation_required', 'completed', 'failed'],
    provider_unknown:        ['processing', 'reconciliation_required', 'completed', 'failed'],
    reconciliation_required: ['processing', 'provider_pending', 'completed', 'failed', 'refunded'],
    manual_review:           ['processing', 'failed', 'refunded', 'cancelled'],
    completed:               [],
    failed:                  ['refund_pending', 'cancelled'],
    refund_pending:          ['refunded', 'failed'],
    refunded:                [],
    cancelled:               ['failed'],
    reversed:                ['refunded']
});

const PROVIDERS = { dtone: dtoneAdapter, vtpass: vtpassAdapter };

// ─── Helpers ─────────────────────────────────────────────────────

function limitOf(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(n, max);
}
function pageOf(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return n;
}
function isoDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'completed') return 'success';
    if (FAILED_STATUSES.has(s)) return 'danger';
    if (PENDING_STATUSES.has(s)) return 'warn';
    if (s === 'refunded') return 'info';
    return 'neutral';
}
function maskPhone(phone) {
    if (!phone) return '—';
    const s = String(phone);
    if (s.length <= 4) return s;
    return `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}
function buildAttemptReference(provider, orderRef, attemptNo) {
    const prefix = provider === 'vtpass' ? 'VTP' : 'DT';
    return `${prefix}-${orderRef}-A${attemptNo}`.slice(0, 40);
}

// ─── Audit (fail-loud) ───────────────────────────────────────────

async function recordAudit({ ctx, action, targetId, before, after, reason }) {
    const { error } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert({
            admin_id:    ctx?.adminId || null,
            admin_email: ctx?.adminEmail || null,
            action,
            target_type: 'airtime_order',
            target_id:   targetId,
            before:      before || null,
            after:       after || null,
            reason:      reason ? String(reason).slice(0, 500) : null,
            ip_address:  ctx?.ip || null,
            user_agent:  ctx?.userAgent || null,
            request_id:  ctx?.requestId || null,
            created_at:  new Date().toISOString()
        });
    if (error) {
        console.error('[AIRTIME] audit insert failed:', error.message);
        const e = new Error('Audit logging failed.');
        e.status = 500; e.code = 'AUDIT_WRITE_FAILED';
        throw e;
    }
}

// ─── Provider events (best-effort) ───────────────────────────────

async function recordProviderEvent({
    orderId, attemptId = null, provider, eventId = null,
    eventType, providerStatus = null, providerTransactionId = null,
    providerReference = null, payload = null, processingStatus = 'processed'
}) {
    try {
        await supabaseAdmin.from('airtime_provider_events').insert({
            order_id: orderId,
            attempt_id: attemptId,
            provider,
            event_id: eventId,
            event_type: eventType,
            provider_status: providerStatus,
            provider_transaction_id: providerTransactionId,
            provider_reference: providerReference,
            payload_summary: payload ? summarizeProviderPayload(payload) : null,
            processing_status: processingStatus,
            received_at: new Date().toISOString(),
            processed_at: new Date().toISOString()
        });
    } catch (e) {
        if (!String(e.message || '').includes('duplicate')) {
            console.warn('[AIRTIME] provider event insert failed:', e.message);
        }
    }
}

function summarizeProviderPayload(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const k of ['id', 'transactionId', 'transaction_id', 'external_id', 'status', 'code']) {
        if (raw[k] !== undefined) out[k] = raw[k];
    }
    if (raw.content?.transactions) {
        const tx = raw.content.transactions;
        out.vtpass = {
            transactionId: tx.transactionId || tx.transaction_id || null,
            status: tx.status || null,
            unique_element: tx.unique_element || null
        };
    }
    if (raw.status && typeof raw.status === 'object') {
        out.dtone = {
            status_id: raw.status.id || null,
            class_id: raw.status.class?.id || null,
            message: raw.status.message || raw.status.class?.message || null
        };
    }
    return out;
}

// ═════════════════════════════════════════════════════════════════
//  ROUTING — still backed by airtime_provider_routes, but reads
//  a fallback default so the module works even before that table
//  is populated.
// ═════════════════════════════════════════════════════════════════

async function resolveProvider({ countryIso3, networkCode = null }) {
    const country = String(countryIso3 || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(country)) {
        const e = new Error('countryIso3 must be a 3-letter ISO code.');
        e.status = 422; e.code = 'INVALID_COUNTRY'; throw e;
    }

    let query = supabaseAdmin
        .from('airtime_provider_routes')
        .select('provider, priority, network_code, country_iso3, enabled')
        .eq('country_iso3', country)
        .eq('enabled', true);

    if (networkCode) {
        query = query.or(`network_code.eq.${String(networkCode).toUpperCase()},network_code.is.null`);
    } else {
        query = query.is('network_code', null);
    }
    query = query.order('network_code', { ascending: false, nullsFirst: false })
                 .order('priority', { ascending: true })
                 .limit(1);

    const { data, error } = await query.maybeSingle();

    if (error && error.code !== 'PGRST116') {
        const e = new Error('Failed to resolve airtime provider route.');
        e.status = 500; e.code = 'ROUTING_READ_FAILED'; e.cause = error.message;
        throw e;
    }

    if (data?.provider) return String(data.provider).toLowerCase();

    // Fallback defaults so the module is usable without a routing table.
    if (country === 'NGA') return 'vtpass';
    return 'dtone';
}

async function listRouting() {
    const { data, error } = await supabaseAdmin
        .from('airtime_provider_routes')
        .select('id, country_iso3, network_code, provider, priority, enabled, reason, updated_by, updated_at, version')
        .order('country_iso3', { ascending: true })
        .order('network_code', { ascending: true, nullsFirst: true })
        .order('priority', { ascending: true });

    if (error) {
        // Table missing — return the hardcoded defaults so the UI still works.
        if (error.code === '42P01') {
            return [
                { country: 'NGA', network: null, provider: 'vtpass', priority: 1, enabled: true, source: 'default' },
                { country: 'GHA', network: null, provider: 'dtone',  priority: 1, enabled: true, source: 'default' },
                { country: 'KEN', network: null, provider: 'dtone',  priority: 1, enabled: true, source: 'default' },
                { country: 'ZAF', network: null, provider: 'dtone',  priority: 1, enabled: true, source: 'default' }
            ];
        }
        const e = new Error('Failed to list routing.'); e.status = 500; e.code = 'ROUTING_READ_FAILED'; throw e;
    }
    return (data || []).map(r => ({
        id: r.id,
        country: r.country_iso3,
        network: r.network_code || null,
        provider: r.provider,
        priority: r.priority,
        enabled: r.enabled,
        reason: r.reason,
        updated_by: r.updated_by,
        updated_at: r.updated_at,
        version: r.version
    }));
}

async function setRouting({ countryIso3, networkCode = null, primaryProvider, enabled = true, priority = 1, expectedVersion = null, ctx, reason }) {
    const country = String(countryIso3 || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(country)) {
        const e = new Error('countryIso3 must be a 3-letter ISO code.');
        e.status = 422; e.code = 'INVALID_COUNTRY'; throw e;
    }
    const provider = String(primaryProvider || '').toLowerCase();
    if (!PROVIDERS[provider]) {
        const e = new Error(`Unknown provider: ${primaryProvider}`);
        e.status = 422; e.code = 'INVALID_PROVIDER'; throw e;
    }
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }

    const network = networkCode ? String(networkCode).toUpperCase() : null;
    const nowIso = new Date().toISOString();

    let lookup = supabaseAdmin
        .from('airtime_provider_routes')
        .select('id, version')
        .eq('country_iso3', country);
    lookup = network ? lookup.eq('network_code', network) : lookup.is('network_code', null);

    const { data: existing } = await lookup.maybeSingle();

    if (existing) {
        if (expectedVersion != null && Number(existing.version) !== Number(expectedVersion)) {
            const e = new Error('Routing config changed while you were editing it. Reload and try again.');
            e.status = 409; e.code = 'CONFIGURATION_CHANGED';
            e.current_version = existing.version; throw e;
        }
        const { data: updated, error } = await supabaseAdmin
            .from('airtime_provider_routes')
            .update({
                provider, priority, enabled,
                reason: String(reason).slice(0, 500),
                updated_by: ctx?.adminId || null,
                updated_at: nowIso,
                version: (existing.version || 1) + 1
            })
            .eq('id', existing.id)
            .eq('version', existing.version)
            .select('*')
            .maybeSingle();

        if (error) { const e = new Error('Failed to update routing.'); e.status = 500; e.code = 'ROUTING_WRITE_FAILED'; throw e; }
        if (!updated) {
            const e = new Error('Routing config changed while you were editing it. Reload and try again.');
            e.status = 409; e.code = 'CONFIGURATION_CHANGED'; throw e;
        }

        await recordAudit({
            ctx, action: 'airtime.routing_updated',
            targetId: updated.id,
            before: { version: existing.version },
            after: { provider, priority, enabled, version: updated.version },
            reason
        });
        return { country, network, provider, priority, enabled, version: updated.version };
    }

    const { data: inserted, error } = await supabaseAdmin
        .from('airtime_provider_routes')
        .insert({
            country_iso3: country, network_code: network,
            provider, priority, enabled,
            reason: String(reason).slice(0, 500),
            updated_by: ctx?.adminId || null,
            updated_at: nowIso, version: 1
        })
        .select('*')
        .single();

    if (error) {
        if (error.code === '23505') {
            const e = new Error('A route for this country/network already exists.');
            e.status = 409; e.code = 'ROUTE_EXISTS'; throw e;
        }
        const e = new Error('Failed to insert routing.'); e.status = 500; e.code = 'ROUTING_WRITE_FAILED'; throw e;
    }

    await recordAudit({
        ctx, action: 'airtime.routing_created',
        targetId: inserted.id, before: null,
        after: { provider, priority, enabled }, reason
    });
    return { country, network, provider, priority, enabled, version: 1 };
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER STATE — three-state classification
// ═════════════════════════════════════════════════════════════════

async function resolveProviderState(order) {
    const provider = PROVIDERS[order.provider];
    if (!provider) return { classification: 'UNKNOWN', reason: 'UNKNOWN_PROVIDER' };

    try {
        const result = await provider.getStatus({
            providerTransactionId: order.provider_transaction_id,
            providerReference:     order.provider_reference
        });

        const classification = result.classification || 'UNKNOWN';

        await recordProviderEvent({
            orderId: order.id,
            provider: order.provider,
            eventType: 'status_query',
            providerStatus: result.providerStatus || null,
            providerTransactionId: result.providerTransactionId || null,
            providerReference: order.provider_reference,
            payload: result.rawResponse || null
        });

        return {
            classification,
            providerStatus: result.providerStatus || null,
            providerTransactionId: result.providerTransactionId || null,
            rawResponse: result.rawResponse || null
        };
    } catch (e) {
        await recordProviderEvent({
            orderId: order.id,
            provider: order.provider,
            eventType: 'status_query_failed',
            providerReference: order.provider_reference,
            processingStatus: 'failed'
        });
        return { classification: 'UNKNOWN', reason: `PROVIDER_QUERY_FAILED: ${e.message}` };
    }
}

// ═════════════════════════════════════════════════════════════════
//  ROW NORMALIZATION
//
//  Both underlying tables are shaped differently. `normalizeRow`
//  produces a single canonical shape so the rest of the service,
//  and the admin UI, never have to care where the row came from.
// ═════════════════════════════════════════════════════════════════

function normalizeRow(raw, source, profile) {
    if (source === 'dtone') {
        // From airtime_transactions
        return {
            id: raw.id,
            source: 'dtone',
            order_ref: raw.reference,
            provider: 'dtone',
            provider_transaction_id: raw.provider_transaction_id || null,
            provider_reference: raw.dtone_external_id || raw.provider_reference || null,
            status: raw.status,
            status_badge: statusBadge(raw.status),
            user_id: raw.user_id,
            user: profile ? {
                id: profile.id,
                username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
                email: profile.email || null
            } : { id: raw.user_id, username: 'Unknown', email: null },
            country_iso3: raw.country_code || null,
            country_name: null,
            network_code: raw.operator_id ? String(raw.operator_id) : null,
            network_name: raw.operator_name || null,
            phone_masked: maskPhone(raw.phone_number),
            amount: raw.destination_amount ?? null,
            currency: raw.destination_currency || null,
            customer_price_ngn: raw.currency === 'NGN' ? (raw.total_amount ?? null) : null,
            provider_cost_ngn: raw.provider_currency === 'NGN' ? (raw.provider_cost ?? null) : null,
            provider_cost_usd: raw.provider_currency === 'USD' ? (raw.provider_cost ?? null) : null,
            fx_rate: raw.exchange_rate ?? null,
            failure_code: raw.failure_code || null,
            failure_reason: raw.failure_message || null,
            transaction_id: raw.ledger_transaction_id || null,
            refund_transaction_id: raw.refund_transaction_id || null,
            refunded: Boolean(raw.refunded),
            created_at: raw.created_at,
            updated_at: raw.updated_at || null,
            completed_at: raw.completed_at || null,
            failed_at: raw.failed_at || null,
            refunded_at: raw.refunded_at || null,
            raw
        };
    }

    // From bill_payment_transactions (VTpass airtime)
    return {
        id: raw.id,
        source: 'vtpass',
        order_ref: raw.reference,
        provider: 'vtpass',
        provider_transaction_id: raw.provider_transaction_id || null,
        provider_reference: raw.provider_request_id || null,
        status: raw.status,
        status_badge: statusBadge(raw.status),
        user_id: raw.user_id,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : { id: raw.user_id, username: 'Unknown', email: null },
        country_iso3: 'NGA',
        country_name: 'Nigeria',
        network_code: raw.network || null,
        network_name: raw.network ? String(raw.network).toUpperCase() : null,
        phone_masked: maskPhone(raw.recipient),
        amount: raw.base_amount ?? null,
        currency: raw.currency || 'NGN',
        customer_price_ngn: raw.customer_amount ?? null,
        provider_cost_ngn: raw.provider_amount ?? null,
        provider_cost_usd: null,
        fx_rate: null,
        failure_code: raw.provider_code || null,
        failure_reason: raw.failure_reason || null,
        transaction_id: raw.ledger_transaction_id || null,
        refund_transaction_id: raw.refund_transaction_id || null,
        refunded: Boolean(raw.refunded),
        created_at: raw.created_at,
        updated_at: raw.updated_at || null,
        completed_at: raw.completed_at || null,
        failed_at: raw.failed_at || null,
        refunded_at: raw.refunded_at || null,
        raw
    };
}

// ═════════════════════════════════════════════════════════════════
//  ORDERS — list (UNION of both tables)
// ═════════════════════════════════════════════════════════════════

async function listOrders(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);
    const providerFilter = query.provider && query.provider !== 'all'
        ? String(query.provider).toLowerCase()
        : null;
    const statusFilter = query.status && query.status !== 'all'
        ? String(query.status).toLowerCase()
        : null;

    const wantDtone  = !providerFilter || providerFilter === 'dtone';
    const wantVtpass = !providerFilter || providerFilter === 'vtpass';
    const isNigerianOnly = query.country && String(query.country).toUpperCase() !== 'NGA';
    const includeVtpass = wantVtpass && !isNigerianOnly;

    // ── Query DT One table ──────────────────────────────────────
    const dtonePromise = wantDtone
        ? (async () => {
            let q = supabaseAdmin
                .from('airtime_transactions')
                .select('*', { count: 'exact' })
                .order('created_at', { ascending: false })
                .limit(Math.min(MAX_LIMIT, limit * 4)); // fetch extra for the merge

            if (statusFilter && ORDER_STATUSES.has(statusFilter)) q = q.eq('status', statusFilter);
            if (query.country) q = q.eq('country_code', String(query.country).toUpperCase());
            if (query.network) q = q.eq('operator_id', query.network);
            if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);
            if (query.search) {
                const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
                q = q.or(`reference.ilike.%${safe}%,phone_number.ilike.%${safe}%,provider_transaction_id.ilike.%${safe}%,dtone_external_id.ilike.%${safe}%`);
            }
            const { data, error } = await q;
            if (error) {
                if (error.code === '42P01') return [];
                console.warn('[AIRTIME] dtone list error:', error.message);
                return [];
            }
            return (data || []).map(r => normalizeRow(r, 'dtone', null));
        })()
        : Promise.resolve([]);

    // ── Query VTpass table ─────────────────────────────────────
    // VTpass airtime is stored with service_type='airtime'.
    const vtpassPromise = includeVtpass
        ? (async () => {
            let q = supabaseAdmin
                .from('bill_payment_transactions')
                .select('*', { count: 'exact' })
                .eq('service_type', 'airtime')
                .order('created_at', { ascending: false })
                .limit(Math.min(MAX_LIMIT, limit * 4));

            if (statusFilter && ORDER_STATUSES.has(statusFilter)) q = q.eq('status', statusFilter);
            if (query.network) q = q.eq('network', query.network);
            if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);
            if (query.search) {
                const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
                q = q.or(`reference.ilike.%${safe}%,recipient.ilike.%${safe}%,provider_request_id.ilike.%${safe}%,provider_transaction_id.ilike.%${safe}%`);
            }
            const { data, error } = await q;
            if (error) {
                if (error.code === '42P01') return [];
                console.warn('[AIRTIME] vtpass list error:', error.message);
                return [];
            }
            return (data || []).map(r => normalizeRow(r, 'vtpass', null));
        })()
        : Promise.resolve([]);

    const [dtoneRows, vtpassRows] = await Promise.all([dtonePromise, vtpassPromise]);

    // Merge + sort + paginate in Node.
    const merged = [...dtoneRows, ...vtpassRows]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const total = merged.length;
    const pageRows = merged.slice(offset, offset + limit);

    // Load profiles once for the page.
    const userIds = [...new Set(pageRows.map(o => o.user_id).filter(Boolean))];
    let profilesById = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email')
            .in('id', userIds);
        for (const p of profiles || []) profilesById[p.id] = p;
    }

    const orders = pageRows.map(o => {
        const profile = profilesById[o.user_id];
        if (profile) {
            o.user = {
                id: profile.id,
                username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
                email: profile.email || null
            };
        }
        return o;
    });

    return {
        orders,
        count: total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
        available: true
    };
}

// ═════════════════════════════════════════════════════════════════
//  OVERVIEW
// ═════════════════════════════════════════════════════════════════

async function getOverview(query = {}) {
    const fromIso = isoDate(query.from) || startOfWatDay();
    const toIso = isoDate(query.to) || new Date().toISOString();

    // Try the RPC first, in case it's deployed against airtime_transactions.
    const rpc = await supabaseAdmin.rpc('airtime_overview', { p_from: fromIso, p_to: toIso });
    if (!rpc.error && rpc.data) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        return {
            total: Number(row.total || 0),
            completed: Number(row.completed || 0),
            pending: Number(row.pending || 0),
            failed: Number(row.failed || 0),
            refunded: Number(row.refunded || 0),
            salesNgn:  String(row.sales_ngn  || '0.00'),
            costNgn:   String(row.cost_ngn   || '0.00'),
            marginNgn: String(row.margin_ngn || '0.00'),
            providers: {
                dtone: {
                    orders: Number(row.dtone_orders || 0),
                    completed: Number(row.dtone_completed || 0),
                    pending: Number(row.dtone_pending || 0),
                    failed: Number(row.dtone_failed || 0),
                    salesNgn: String(row.dtone_sales_ngn || '0.00'),
                    costNgn: String(row.dtone_cost_ngn || '0.00'),
                    marginNgn: String(row.dtone_margin_ngn || '0.00')
                },
                vtpass: {
                    orders: Number(row.vtpass_orders || 0),
                    completed: Number(row.vtpass_completed || 0),
                    pending: Number(row.vtpass_pending || 0),
                    failed: Number(row.vtpass_failed || 0),
                    salesNgn: String(row.vtpass_sales_ngn || '0.00'),
                    costNgn: String(row.vtpass_cost_ngn || '0.00'),
                    marginNgn: String(row.vtpass_margin_ngn || '0.00')
                }
            },
            summaryAvailable: true,
            from: fromIso, to: toIso
        };
    }

    // Compute the overview by fetching lightweight rows from both
    // tables and folding them in Node. Acceptable at admin scale; if
    // the tables grow, migrate to the RPC.
    const buildFromTable = async (table, source, extraEq = {}) => {
        let q = supabaseAdmin
            .from(table)
            .select('id, status, total_amount, customer_amount, provider_cost, provider_amount, currency, provider_currency, created_at')
            .gte('created_at', fromIso)
            .lte('created_at', toIso);
        for (const [k, v] of Object.entries(extraEq)) q = q.eq(k, v);
        const { data, error } = await q;
        if (error) {
            if (error.code === '42P01') return [];
            console.warn(`[AIRTIME] overview ${table} error:`, error.message);
            return [];
        }
        return (data || []).map(r => ({
            source,
            status: String(r.status || '').toLowerCase(),
            salesNgn: r.currency === 'NGN' ? Number(r.total_amount ?? r.customer_amount ?? 0) : 0,
            costNgn:  r.provider_currency === 'NGN'
                ? Number(r.provider_cost ?? 0)
                : (r.currency === 'NGN' ? Number(r.provider_amount ?? 0) : 0),
            createdAt: r.created_at
        }));
    };

    const [dtoneRows, vtpassRows] = await Promise.all([
        buildFromTable('airtime_transactions', 'dtone'),
        buildFromTable('bill_payment_transactions', 'vtpass', { service_type: 'airtime' })
    ]);

    const all = [...dtoneRows, ...vtpassRows];

    const isCompleted = s => s === 'completed';
    const isFailed    = s => s === 'failed' || s === 'cancelled' || s === 'reversed';
    const isRefunded  = s => s === 'refunded';
    const isPending   = s => !isCompleted(s) && !isFailed(s) && !isRefunded(s);

    const summarize = (rows) => {
        const completed = rows.filter(r => isCompleted(r.status));
        const pending   = rows.filter(r => isPending(r.status));
        const failed    = rows.filter(r => isFailed(r.status));
        const refunded  = rows.filter(r => isRefunded(r.status));
        const sales  = completed.reduce((a, r) => a + (r.salesNgn || 0), 0);
        const cost   = completed.reduce((a, r) => a + (r.costNgn  || 0), 0);
        return {
            orders: rows.length,
            completed: completed.length,
            pending: pending.length,
            failed: failed.length,
            refunded: refunded.length,
            salesNgn: sales.toFixed(2),
            costNgn:  cost.toFixed(2),
            marginNgn: (sales - cost).toFixed(2)
        };
    };

    const dtone  = summarize(dtoneRows);
    const vtpass = summarize(vtpassRows);
    const total  = summarize(all);

    return {
        total: total.orders,
        completed: total.completed,
        pending: total.pending,
        failed: total.failed,
        refunded: total.refunded,
        salesNgn: total.salesNgn,
        costNgn: total.costNgn,
        marginNgn: total.marginNgn,
        providers: { dtone, vtpass },
        summaryAvailable: true,
        from: fromIso, to: toIso
    };
}

function startOfWatDay() {
    const OFFSET_MS = 60 * 60 * 1000;
    const now = new Date();
    const local = new Date(now.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    return new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS).toISOString();
}

// ═════════════════════════════════════════════════════════════════
//  ORDER DETAIL
// ═════════════════════════════════════════════════════════════════

async function getOrder(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }

    // Try DT One first.
    let raw = null, source = null;
    {
        const { data, error } = await supabaseAdmin
            .from('airtime_transactions')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (!error && data) { raw = data; source = 'dtone'; }
    }

    // Then VTpass.
    if (!raw) {
        const { data, error } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('*')
            .eq('id', id)
            .eq('service_type', 'airtime')
            .maybeSingle();
        if (!error && data) { raw = data; source = 'vtpass'; }
    }

    if (!raw) {
        const e = new Error('Airtime order not found'); e.status = 404; e.code = 'AO_NOT_FOUND'; throw e;
    }

    // User
    let user = null;
    if (raw.user_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, status, created_at')
            .eq('id', raw.user_id)
            .maybeSingle();
        user = p || null;
    }

    // Transaction record
    let transaction = null;
    if (raw.ledger_transaction_id) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, fee, description, metadata, created_at, completed_at, failure_reason')
            .eq('id', raw.ledger_transaction_id)
            .maybeSingle();
        transaction = t || null;
    }

    // Refund
    let refundTransaction = null;
    if (raw.refund_transaction_id) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
            .eq('id', raw.refund_transaction_id)
            .maybeSingle();
        refundTransaction = t || null;
    }

    // Ledger entries
    let ledgerEntries = [];
    if (raw.ledger_transaction_id) {
        try {
            const { data: le } = await supabaseAdmin
                .from('ledger_entries')
                .select('id, transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, description, created_at')
                .eq('transaction_id', raw.ledger_transaction_id)
                .order('created_at', { ascending: true });
            ledgerEntries = le || [];
        } catch (_) { /* optional */ }
    }

    // Provider attempts (only DT One has these)
    let attempts = [];
    if (source === 'dtone') {
        try {
            const { data: at } = await supabaseAdmin
                .from('airtime_order_attempts')
                .select('id, attempt_no, provider, external_id, provider_transaction_id, provider_status, status, failure_reason, created_at, updated_at, completed_at')
                .eq('order_id', id)
                .order('attempt_no', { ascending: true });
            attempts = at || [];
        } catch (_) { /* optional */ }
    }

    // Provider events
    let providerEvents = [];
    try {
        const { data: pe } = await supabaseAdmin
            .from('airtime_provider_events')
            .select('id, event_type, provider, provider_status, provider_transaction_id, provider_reference, processing_status, received_at')
            .eq('order_id', id)
            .order('received_at', { ascending: true })
            .limit(100);
        providerEvents = pe || [];
    } catch (_) { /* optional */ }

    const timeline = buildTimeline(raw, source);

    const normalized = normalizeRow(raw, source, user);

    return {
        order: normalized,
        user,
        provider_snapshot: {
            provider: normalized.provider,
            provider_product_id: source === 'dtone' ? (raw.product_id || null) : (raw.variation_code || null),
            provider_transaction_id: normalized.provider_transaction_id,
            provider_reference: normalized.provider_reference,
            provider_status: raw.provider_status || null,
            last_provider_check_at: source === 'dtone' ? (raw.last_reconciliation_at || null) : (raw.last_reconciliation_at || null),
            provider_check_attempts: raw.reconciliation_attempts ?? 0
        },
        pricing_snapshot: {
            amount: raw.amount ?? raw.base_amount ?? null,
            currency: normalized.currency,
            customer_price_ngn: normalized.customer_price_ngn,
            provider_cost_ngn: normalized.provider_cost_ngn,
            provider_cost_usd: normalized.provider_cost_usd,
            fx_rate: normalized.fx_rate
        },
        failure: {
            code: normalized.failure_code,
            reason: normalized.failure_reason
        },
        delivery: {
            phone_masked: normalized.phone_masked,
            network_code: normalized.network_code,
            network_name: normalized.network_name,
            country_iso3: normalized.country_iso3,
            country_name: normalized.country_name
        },
        transaction,
        refund_transaction: refundTransaction,
        ledger_entries: ledgerEntries,
        attempts,
        provider_events: providerEvents,
        timeline
    };
}

function buildTimeline(raw, source) {
    const events = [];
    if (raw.created_at) events.push({ at: raw.created_at, kind: 'order_created', label: 'Order created' });
    if (raw.processing_at) events.push({ at: raw.processing_at, kind: 'processing', label: 'Processing started' });
    if (raw.completed_at) events.push({ at: raw.completed_at, kind: 'completed', label: 'Order completed' });
    if (raw.failed_at) events.push({ at: raw.failed_at, kind: 'failed', label: `Order failed${raw.failure_message ? ' — ' + raw.failure_message : ''}` });
    if (raw.refunded_at) events.push({ at: raw.refunded_at, kind: 'refunded', label: 'Order refunded' });
    events.sort((a, b) => new Date(a.at) - new Date(b.at));
    return events;
}

// ═════════════════════════════════════════════════════════════════
//  MUTATIONS
//
//  Every mutation reloads the row from the correct table, determines
//  its source, and either applies the change directly (if the
//  provider's own reconciliation is the authority) or routes it
//  through the admin finalize RPC (if we're applying a human decision).
//
//  Note: because the two tables have different shapes, the
//  finalize RPC in the migration handles BOTH by name. The admin
//  actions below are thin wrappers over that RPC.
// ═════════════════════════════════════════════════════════════════

async function loadOrderByAnyId(orderId) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }

    {
        const { data, error } = await supabaseAdmin
            .from('airtime_transactions').select('*').eq('id', orderId).maybeSingle();
        if (!error && data) return { raw: data, source: 'dtone' };
    }
    {
        const { data, error } = await supabaseAdmin
            .from('bill_payment_transactions').select('*')
            .eq('id', orderId).eq('service_type', 'airtime').maybeSingle();
        if (!error && data) return { raw: data, source: 'vtpass' };
    }
    const e = new Error('Airtime order not found'); e.status = 404; e.code = 'AO_NOT_FOUND'; throw e;
}

// ─── Retry ───────────────────────────────────────────────────────
// Only proceeds after CONFIRMED_NOT_FULFILLED. Ambiguous outcomes
// move the order to reconciliation_required.

async function retryOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const { raw: order, source } = await loadOrderByAnyId(orderId);

    const current = String(order.status || '').toLowerCase();
    if (current === 'completed') {
        const e = new Error('Order is already completed.'); e.status = 409; e.code = 'ALREADY_COMPLETED'; throw e;
    }
    if (current === 'refunded' || current === 'refund_pending') {
        const e = new Error('Order is in a refund state — retry is not allowed.');
        e.status = 409; e.code = 'IN_REFUND_STATE'; throw e;
    }

    const normalized = normalizeRow(order, source, null);
    const providerState = await resolveProviderState(normalized);

    if (providerState.classification === 'CONFIRMED_FULFILLED') {
        await completeOrder(source, order, ctx, 'retry_detected_completed_at_provider');
        return { outcome: 'delivered_existing' };
    }

    if (providerState.classification === 'UNKNOWN') {
        await markReconciliation(source, order, ctx,
            `Retry refused: provider state unknown (${providerState.reason || providerState.providerStatus || 'unknown'}).`);
        return { outcome: 'reconciliation_required' };
    }

    // CONFIRMED_NOT_FULFILLED — safe to send a new purchase.
    // The customer flow already sends a fresh request; for the admin
    // path we call the provider adapter again.
    const adapter = PROVIDERS[normalized.provider];
    if (!adapter) {
        const e = new Error('Unknown provider on order.'); e.status = 422; e.code = 'UNKNOWN_PROVIDER'; throw e;
    }

    const attemptNo = Number(order.reconciliation_attempts || 0) + 1;
    const externalId = buildAttemptReference(normalized.provider, normalized.order_ref, attemptNo);

    let purchaseResult;
    try {
        purchaseResult = await adapter.purchase({
            order: {
                phone_number: order.phone_number || order.recipient,
                network_code: order.operator_id ? String(order.operator_id) : order.network,
                wholesale_amount: order.destination_amount || order.base_amount,
                wholesale_currency: order.destination_currency || order.currency,
                provider_product_id: order.product_id || order.variation_code,
                product_mode: 'RANGED_SOURCE'
            },
            attempt: { provider_reference: externalId },
            callbackUrl: null
        });
    } catch (e) {
        if (e.ambiguous) {
            await markReconciliation(source, order, ctx, 'Provider request outcome is unknown.');
            return { outcome: 'reconciliation_required' };
        }
        await markFailed(source, order, ctx, e.code || 'PROVIDER_PURCHASE_REJECTED',
            'Provider rejected the purchase request.', reason);
        return { outcome: 'failed' };
    }

    // Accepted — write new provider ids.
    const patch = source === 'dtone'
        ? {
            provider_transaction_id: purchaseResult.providerTransactionId || order.provider_transaction_id,
            dtone_external_id: purchaseResult.providerReference || externalId,
            provider_status: purchaseResult.providerStatus || null,
            status: 'processing',
            failure_code: null,
            failure_message: null,
            updated_at: new Date().toISOString(),
            reconciliation_attempts: (order.reconciliation_attempts || 0) + 1
        }
        : {
            provider_transaction_id: purchaseResult.providerTransactionId || order.provider_transaction_id,
            provider_request_id: purchaseResult.providerReference || externalId,
            provider_status: purchaseResult.providerStatus || null,
            status: 'processing',
            failure_reason: null,
            updated_at: new Date().toISOString(),
            reconciliation_attempts: (order.reconciliation_attempts || 0) + 1
        };

    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    await supabaseAdmin.from(table).update(patch).eq('id', order.id);

    await recordAudit({
        ctx, action: 'airtime.retry', targetId: order.id,
        before: { status: current }, after: { status: 'processing' }, reason
    });

    return { outcome: 'retried' };
}

// ─── Sync ────────────────────────────────────────────────────────
async function syncOrder({ orderId, ctx }) {
    const { raw: order, source } = await loadOrderByAnyId(orderId);
    const normalized = normalizeRow(order, source, null);
    const providerState = await resolveProviderState(normalized);

    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    const now = new Date().toISOString();

    await supabaseAdmin.from(table).update({
        last_reconciliation_at: now,
        reconciliation_attempts: (order.reconciliation_attempts || 0) + 1,
        provider_status: providerState.providerStatus || order.provider_status
    }).eq('id', order.id);

    if (providerState.classification === 'CONFIRMED_FULFILLED') {
        await completeOrder(source, order, ctx, 'admin_sync_completed_at_provider');
        return { synced: true, resolved: 'completed' };
    }

    if (providerState.classification === 'CONFIRMED_NOT_FULFILLED') {
        await markFailed(source, order, ctx,
            providerState.providerStatus || 'PROVIDER_REJECTED',
            'Provider confirmed the transaction was not fulfilled.', null);
        return { synced: true, resolved: 'failed' };
    }

    await markReconciliation(source, order, ctx,
        `Sync outcome unknown: ${providerState.reason || providerState.providerStatus || 'unknown'}`);
    return { synced: true, resolved: 'unknown' };
}

// ─── Refund ──────────────────────────────────────────────────────
async function refundOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const { raw: order, source } = await loadOrderByAnyId(orderId);
    const current = String(order.status || '').toLowerCase();

    if (current === 'refunded') {
        const e = new Error('Order is already refunded.'); e.status = 409; e.code = 'ALREADY_REFUNDED'; throw e;
    }
    if (current !== 'failed' && current !== 'refund_pending') {
        const e = new Error('Only failed orders can be refunded.'); e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
    }
    if (!order.ledger_transaction_id) {
        const e = new Error('Order has no wallet transaction.'); e.status = 422; e.code = 'NO_TRANSACTION'; throw e;
    }

    const { data: originalTx } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, status, currency, amount')
        .eq('id', order.ledger_transaction_id)
        .maybeSingle();
    if (!originalTx) { const e = new Error('Original transaction not found.'); e.status = 404; e.code = 'TX_NOT_FOUND'; throw e; }
    if (String(originalTx.status).toLowerCase() !== 'completed') {
        const e = new Error('Original transaction is not completed — cannot refund.'); e.status = 422; e.code = 'TX_NOT_REFUNDABLE'; throw e;
    }

    const { data: existingRefund } = await supabaseAdmin
        .from('transactions')
        .select('id, reference, amount, currency')
        .eq('source_id', originalTx.id)
        .eq('type', 'refund')
        .maybeSingle();

    if (existingRefund) {
        await applyRefundPatch(source, order, existingRefund, ctx, reason, true);
        return {
            refund: {
                transaction_id: existingRefund.id,
                reference: existingRefund.reference,
                amount: existingRefund.amount,
                currency: existingRefund.currency,
                already_refunded: true
            }
        };
    }

    let creditResult;
    try {
        creditResult = await LedgerService.creditWallet({
            userId: order.user_id,
            amount: originalTx.amount,
            currency: originalTx.currency,
            description: `Airtime order refund: ${order.reference}`,
            type: 'refund',
            sourceType: 'airtime_order',
            sourceId: originalTx.id,
            reference: `AIRREF-${order.reference}`,
            metadata: { airtime_order_id: order.id, order_ref: order.reference, reason, source }
        });
    } catch (ledgerErr) {
        const msg = String(ledgerErr.message || '');
        if (msg.includes('duplicate') || msg.includes('unique')) {
            const { data: raceRefund } = await supabaseAdmin
                .from('transactions')
                .select('id, reference, amount, currency')
                .eq('source_id', originalTx.id)
                .eq('type', 'refund')
                .maybeSingle();
            if (raceRefund) {
                await applyRefundPatch(source, order, raceRefund, ctx, reason, true);
                return {
                    refund: {
                        transaction_id: raceRefund.id,
                        reference: raceRefund.reference,
                        amount: raceRefund.amount,
                        currency: raceRefund.currency,
                        already_refunded: true
                    }
                };
            }
        }
        const e = new Error('Wallet refund failed.'); e.status = 400; e.code = 'LEDGER_REFUND_FAILED'; e.cause = msg; throw e;
    }

    await applyRefundPatch(source, order, creditResult, ctx, reason, false);

    return {
        refund: {
            transaction_id: creditResult.transaction_id || null,
            reference: creditResult.reference || null,
            amount: originalTx.amount,
            currency: originalTx.currency,
            already_refunded: false
        }
    };
}

async function applyRefundPatch(source, order, refundResult, ctx, reason, alreadyRefunded) {
    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    const now = new Date().toISOString();

    const patch = source === 'dtone'
        ? {
            status: 'refunded',
            refunded: true,
            refund_status: 'completed',
            refund_transaction_id: refundResult.transaction_id || null,
            refunded_at: now,
            updated_at: now
        }
        : {
            status: 'refunded',
            refunded: true,
            refund_transaction_id: refundResult.transaction_id || null,
            refunded_at: now,
            updated_at: now
        };

    await supabaseAdmin.from(table).update(patch).eq('id', order.id);

    await recordAudit({
        ctx,
        action: alreadyRefunded ? 'airtime.refund_idempotent' : 'airtime.refund',
        targetId: order.id,
        before: { status: order.status, amount: refundResult.amount },
        after: { status: 'refunded', refund_transaction_id: refundResult.transaction_id || null },
        reason
    });
}

// ─── Move to reconciliation ──────────────────────────────────────
async function reviewOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const { raw: order, source } = await loadOrderByAnyId(orderId);
    const current = String(order.status || '').toLowerCase();

    if (current === 'completed' || current === 'refunded') {
        const e = new Error(`Cannot move a ${current} order to reconciliation.`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION'; throw e;
    }

    await markReconciliation(source, order, ctx, reason);
    return { reviewed: true };
}

// ─── State writers ───────────────────────────────────────────────

async function completeOrder(source, order, ctx, eventLabel) {
    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    const now = new Date().toISOString();
    const patch = source === 'dtone'
        ? { status: 'completed', provider_status: 'COMPLETED', completed_at: now, updated_at: now, failure_code: null, failure_message: null }
        : { status: 'completed', provider_status: 'COMPLETED', completed_at: now, updated_at: now, failure_reason: null };

    await supabaseAdmin.from(table).update(patch).eq('id', order.id);

    await recordAudit({
        ctx: ctx || { adminId: null, adminEmail: null },
        action: `airtime.${eventLabel || 'completed'}`,
        targetId: order.id,
        before: { status: order.status },
        after: { status: 'completed' },
        reason: null
    });
}

async function markFailed(source, order, ctx, failureCode, failureReason, reason) {
    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    const now = new Date().toISOString();
    const patch = source === 'dtone'
        ? {
            status: 'failed',
            failed_at: now,
            failure_code: failureCode || 'PROVIDER_FAILED',
            failure_message: failureReason || 'Provider rejected the transaction.',
            updated_at: now
        }
        : {
            status: 'failed',
            failed_at: now,
            failure_reason: failureReason || 'Provider rejected the transaction.',
            updated_at: now
        };

    await supabaseAdmin.from(table).update(patch).eq('id', order.id);

    await recordAudit({
        ctx: ctx || { adminId: null, adminEmail: null },
        action: 'airtime.failed',
        targetId: order.id,
        before: { status: order.status },
        after: { status: 'failed', failure_code: failureCode },
        reason
    });
}

async function markReconciliation(source, order, ctx, reason) {
    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    const now = new Date().toISOString();
    const patch = source === 'dtone'
        ? {
            status: 'manual_review',
            failure_code: 'RECONCILIATION_REQUIRED',
            failure_message: String(reason || '').slice(0, 500),
            updated_at: now
        }
        : {
            status: 'manual_review',
            failure_reason: String(reason || '').slice(0, 500),
            updated_at: now
        };

    await supabaseAdmin.from(table).update(patch).eq('id', order.id);

    await recordAudit({
        ctx: ctx || { adminId: null, adminEmail: null },
        action: 'airtime.reconciliation_required',
        targetId: order.id,
        before: { status: order.status },
        after: { status: 'manual_review' },
        reason
    });
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

async function getProviderHealth() {
    const { data, error } = await supabaseAdmin
        .from('airtime_provider_health')
        .select('*');

    const cached = error?.code === '42P01' ? [] : (data || []);

    const out = {};
    for (const name of Object.keys(PROVIDERS)) {
        const row = (cached || []).find(r => r.provider === name);
        if (row) {
            out[name] = {
                provider: name,
                status: row.status || 'unknown',
                configured: row.configured ?? null,
                reachable: row.reachable ?? null,
                lastSuccess: row.last_success || null,
                lastFailure: row.last_failure_at ? { at: row.last_failure_at, reason: row.last_failure_reason || null } : null,
                recentCount: row.recent_orders_24h || 0,
                latencyMs: row.latency_ms ?? null,
                lastHealthCheck: row.last_health_check || null,
                consecutiveFailures: row.consecutive_failures ?? 0,
                circuitState: row.circuit_state || 'closed',
                lastError: row.last_error || null
            };
        } else {
            out[name] = {
                provider: name,
                status: 'unknown',
                configured: null, reachable: null,
                lastSuccess: null, lastFailure: null, recentCount: 0,
                latencyMs: null, lastHealthCheck: null,
                consecutiveFailures: 0, circuitState: 'closed', lastError: null
            };
        }
    }
    return out;
}

async function healthCheckProvider({ provider, ctx }) {
    const adapter = PROVIDERS[provider];
    if (!adapter) { const e = new Error(`Unknown provider: ${provider}`); e.status = 400; e.code = 'UNKNOWN_PROVIDER'; throw e; }

    const startedAt = Date.now();
    let live;
    try { live = await adapter.healthCheck(); }
    catch (e) { live = { configured: true, reachable: false, lastError: e.message }; }
    const latencyMs = Date.now() - startedAt;
    const now = new Date().toISOString();

    try {
        await supabaseAdmin
            .from('airtime_provider_health')
            .upsert({
                provider,
                configured: live.configured,
                reachable: live.reachable,
                last_health_check: now,
                last_error: live.lastError || null,
                latency_ms: latencyMs,
                updated_at: now
            }, { onConflict: 'provider' });
    } catch (e) {
        if (!String(e.message || '').includes('42P01')) {
            console.warn('[AIRTIME] health upsert failed:', e.message);
        }
    }

    await recordAudit({
        ctx, action: `airtime.health_check_${provider}`,
        targetId: provider, before: null, after: live, reason: null
    });

    return { ...live, latencyMs };
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    ORDER_STATUSES,
    ALLOWED_TRANSITIONS,

    resolveProvider,
    listRouting,
    setRouting,

    listOrders,
    getOverview,
    getOrder,

    retryOrder,
    refundOrder,
    syncOrder,
    reviewOrder,

    getProviderHealth,
    healthCheckProvider,

    resolveProviderState
};