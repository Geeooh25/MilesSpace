// services/vsmsAdminService.js
// ─────────────────────────────────────────────────────────────────
// Admin Virtual SMS — service layer.
//
// Reads the same virtual_sms_orders table the customer flow writes
// to. Adds admin-only operations on top:
//
//   • stats / list / detail / events / provider logs
//   • sync       — re-query the provider for a single order
//   • cancel     — call provider setStatus=8, refund atomically
//   • release    — release the number without refund (order stays)
//   • retry      — call provider setStatus=3 to resend SMS
//   • refund     — atomic via LedgerService
//   • status     — controlled manual transitions with audit
//
// Provider calls only ever go through fetchProvider() in this file.
// Wallet mutations only ever go through LedgerService.
//
// Money is strings from NUMERIC columns.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const PROVIDER_BASE = 'https://api.virtualsms.de/stubs/handler_api';
const PROVIDER_TIMEOUT_MS = 15000;

const PENDING_STATUSES = new Set([
    'pending', 'processing', 'active', 'sms_received', 'manual_review'
]);
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'expired', 'reversed']);

// Allowed manual transitions in the admin UI. Provider-driven
// transitions are handled in sync/retry and don't go through this
// map.
const ALLOWED_TRANSITIONS = Object.freeze({
    pending:       ['processing', 'active', 'failed', 'cancelled', 'expired', 'manual_review'],
    processing:    ['active', 'sms_received', 'failed', 'cancelled', 'expired', 'manual_review'],
    active:        ['sms_received', 'completed', 'failed', 'cancelled', 'expired', 'refunded', 'manual_review'],
    sms_received:  ['completed', 'failed', 'cancelled', 'refunded', 'manual_review'],
    completed:     ['refunded'],
    failed:        ['refunded', 'manual_review'],
    cancelled:     ['refunded'],
    expired:       ['refunded', 'manual_review'],
    reversed:      ['refunded'],
    refunded:      [],
    manual_review: ['active', 'completed', 'failed', 'cancelled', 'refunded']
});

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
    if (s === 'refunded') return 'info';
    if (s === 'manual_review') return 'purple';
    if (s === 'sms_received') return 'success';
    if (s === 'active') return 'success';
    if (PENDING_STATUSES.has(s)) return 'warn';
    return 'neutral';
}
function maskPhone(p) {
    if (!p) return '—';
    const s = String(p);
    if (s.length <= 4) return s;
    return '••••' + s.slice(-4);
}
function maskEmail(e) {
    if (!e) return null;
    const s = String(e);
    const at = s.indexOf('@');
    if (at <= 0) return '•••';
    const user = s.slice(0, at);
    const domain = s.slice(at);
    const head = user.slice(0, 2);
    return head + '•••' + domain;
}

async function recordAudit({ ctx, action, targetId, before, after, reason }) {
    const { error } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert({
            admin_id:    ctx?.adminId || null,
            admin_email: ctx?.adminEmail || null,
            action,
            target_type: 'virtual_sms_order',
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
        console.error('[VSMS ADMIN] audit insert failed:', error.message);
        const e = new Error('Audit logging failed.');
        e.status = 500; e.code = 'AUDIT_WRITE_FAILED';
        throw e;
    }
}

// Record an admin action in the dedicated table too, so the order
// detail page can show "who changed what" without joining
// admin_audit_logs (which contains everything system-wide).
async function recordAdminAction({ ctx, orderId, action, oldStatus, newStatus, reason, metadata }) {
    try {
        await supabaseAdmin.from('virtual_sms_admin_actions').insert({
            admin_id:   ctx?.adminId || null,
            order_id:   orderId,
            action,
            old_status: oldStatus || null,
            new_status: newStatus || null,
            reason:     reason ? String(reason).slice(0, 500) : null,
            metadata:   metadata || null,
            ip_address: ctx?.ip || null,
            user_agent: ctx?.userAgent || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[VSMS ADMIN] admin-action insert failed:', e.message);
    }
}

// Record a lifecycle event (same table the customer flow uses).
async function recordOrderEvent({ orderId, eventType, oldStatus, newStatus, message, providerResponse, metadata }) {
    try {
        await supabaseAdmin.from('virtual_sms_order_events').insert({
            order_id: orderId,
            event_type: eventType,
            old_status: oldStatus || null,
            new_status: newStatus || null,
            message: message || null,
            provider_response: providerResponse || null,
            metadata: metadata || {}
        });
    } catch (e) {
        console.warn('[VSMS ADMIN] event insert failed:', e.message);
    }
}

// Record a provider call for diagnostics. Never store secrets.
function redactForLog(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    let copy;
    try { copy = JSON.parse(JSON.stringify(obj)); } catch { return null; }
    const KEYS = ['api_key', 'apikey', 'key', 'token', 'authorization', 'secret'];
    const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        for (const k of Object.keys(o)) {
            if (KEYS.includes(String(k).toLowerCase())) o[k] = 'REDACTED';
            else if (typeof o[k] === 'object') walk(o[k]);
        }
    };
    walk(copy);
    return copy;
}
async function recordProviderLog({ orderId, action, endpointName, requestPayload, responsePayload, responseStatus, success, errorCode, errorMessage, durationMs }) {
    try {
        await supabaseAdmin.from('virtual_sms_provider_logs').insert({
            order_id: orderId,
            provider: 'virtualsms',
            action,
            endpoint_name: endpointName,
            request_payload: redactForLog(requestPayload),
            response_payload: redactForLog(responsePayload),
            response_status: responseStatus ?? null,
            success: !!success,
            error_code: errorCode || null,
            error_message: errorMessage ? String(errorMessage).slice(0, 500) : null,
            duration_ms: durationMs ?? null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        if (!String(e.message || '').includes('42P01')) {
            console.warn('[VSMS ADMIN] provider-log insert failed:', e.message);
        }
    }
}

// ─── Provider fetch ──────────────────────────────────────────────

async function fetchProvider(params) {
    const apiKey = process.env.VSMS_API_KEY;
    if (!apiKey) {
        const e = new Error('VSMS_API_KEY not configured.');
        e.status = 500; e.code = 'PROVIDER_NOT_CONFIGURED';
        throw e;
    }

    const url = new URL(PROVIDER_BASE);
    url.searchParams.append('api_key', apiKey);
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        url.searchParams.append(k, String(v));
    }

    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

    try {
        const res = await fetch(url.toString(), {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'MilesSpace-Admin/1.0'
            }
        });
        clearTimeout(timeout);

        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }

        if (!res.ok) {
            const err = new Error(`Provider HTTP ${res.status}`);
            err.providerStatus = res.status;
            err.providerBody = body;
            err.durationMs = Date.now() - started;
            throw err;
        }

        return { body, durationMs: Date.now() - started };
    } catch (err) {
        clearTimeout(timeout);
        if (!err.durationMs) err.durationMs = Date.now() - started;
        throw err;
    }
}

// ─── Row shaping ─────────────────────────────────────────────────

function shapeOrder(raw, profile, { includeSensitive = false } = {}) {
    const o = {
        id: raw.id,
        user_id: raw.user_id,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : { id: raw.user_id, username: 'Unknown', email: null },
        email_masked: profile ? maskEmail(profile.email) : null,

        country_id: raw.country_id ?? null,
        country_name: raw.country_name || null,
        service_code: raw.service_code,
        service_name: raw.service_name || raw.service_code,

        phone_number: raw.phone_number || null,
        phone_masked: maskPhone(raw.phone_number),
        activation_id: raw.activation_id || null,
        provider: 'virtualsms',

        status: raw.status,
        status_badge: statusBadge(raw.status),
        sms_status: raw.sms_status || (raw.sms_code ? 'received' : 'waiting'),
        otp_status: raw.otp_status || (raw.sms_code ? 'received' : 'pending'),
        refund_status: raw.refund_status || null,

        price_usd: raw.price_usd ?? null,
        price_ngn: raw.price_ngn ?? null,
        provider_cost_usd: raw.provider_cost_usd ?? null,
        charge_currency: raw.charge_currency || 'NGN',
        charge_amount: raw.charge_amount ?? null,
        exchange_rate: raw.exchange_rate ?? null,

        ledger_transaction_id: raw.ledger_transaction_id || null,
        refund_transaction_id: raw.refund_transaction_id || null,

        has_sms_code: Boolean(raw.sms_code),
        sms_received_at: raw.sms_received_at || null,
        failure_code: raw.failure_code || null,
        failure_message: raw.failure_message || null,

        created_at: raw.created_at,
        updated_at: raw.updated_at || null,
        activated_at: raw.activated_at || null,
        completed_at: raw.completed_at || null,
        cancelled_at: raw.cancelled_at || null,
        refunded_at: raw.refunded_at || null,
        expires_at: raw.expires_at || null,

        // Profit, computed in Node from stored strings so we never
        // coerce floats in a financial field.
        profit_usd: computeProfitUsd(raw)
    };

    if (includeSensitive) {
        o.sms_code = raw.sms_code || null;
        o.sms_message = raw.sms_message || null;
        o.sms_sender = raw.sms_sender || null;
        o.provider_response = raw.provider_response || null;
    }

    return o;
}

function computeProfitUsd(raw) {
    const priceUsd = Number(raw.price_usd);
    const costUsd = Number(raw.provider_cost_usd);
    if (!Number.isFinite(priceUsd) || !Number.isFinite(costUsd)) return null;
    return (priceUsd - costUsd).toFixed(2);
}

async function loadProfilesByIds(userIds) {
    if (!userIds.length) return {};
    const { data } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email')
        .in('id', userIds);
    const out = {};
    for (const p of data || []) out[p.id] = p;
    return out;
}

// ═════════════════════════════════════════════════════════════════
//  STATS
// ═════════════════════════════════════════════════════════════════

function startOfWatDay() {
    const OFFSET_MS = 60 * 60 * 1000;
    const now = new Date();
    const local = new Date(now.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    return new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS).toISOString();
}

async function getStats(query = {}) {
    const fromIso = isoDate(query.from) || startOfWatDay();
    const toIso = isoDate(query.to) || new Date().toISOString();

    const rpc = await supabaseAdmin.rpc('virtual_sms_admin_stats', {
        p_from: fromIso, p_to: toIso
    });

    if (!rpc.error && rpc.data) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        return {
            total: Number(row.total || 0),
            requested: Number(row.requested || 0),
            active: Number(row.active || 0),
            waiting_sms: Number(row.waiting_sms || 0),
            sms_received: Number(row.sms_received || 0),
            completed: Number(row.completed || 0),
            failed: Number(row.failed || 0),
            expired: Number(row.expired || 0),
            cancelled: Number(row.cancelled || 0),
            refunded: Number(row.refunded || 0),
            manual_review: Number(row.manual_review || 0),
            today_orders: Number(row.today_orders || 0),
            today_revenue_ngn: String(row.today_revenue_ngn || '0.00'),
            today_cost_ngn: String(row.today_cost_ngn || '0.00'),
            today_profit_ngn: String(row.today_profit_ngn || '0.00'),
            month_orders: Number(row.month_orders || 0),
            month_revenue_ngn: String(row.month_revenue_ngn || '0.00'),
            month_profit_ngn: String(row.month_profit_ngn || '0.00'),
            summaryAvailable: true,
            from: fromIso, to: toIso
        };
    }

    if (rpc.error?.code !== '42883' && rpc.error?.code !== 'PGRST202') {
        const e = new Error('Failed to aggregate VSMS stats');
        e.status = 500; e.code = 'VSMS_STATS_ERROR'; e.cause = rpc.error.message;
        throw e;
    }

    // Fallback: bounded read + Node aggregation.
    const { data, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('id, status, sms_code, charge_currency, charge_amount, price_ngn, provider_cost_usd, exchange_rate, created_at, expires_at')
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .limit(5000);

    if (error) {
        if (error.code === '42P01') return emptyStats(fromIso, toIso, 'VSMS_TABLE_NOT_FOUND');
        const e = new Error('Failed to read VSMS orders');
        e.status = 500; e.code = 'VSMS_STATS_ERROR'; throw e;
    }

    const rows = data || [];
    const todayStart = startOfWatDay();
    const monthStart = (() => {
        const OFFSET_MS = 60 * 60 * 1000;
        const now = new Date();
        const local = new Date(now.getTime() + OFFSET_MS);
        const y = local.getUTCFullYear(), m = local.getUTCMonth();
        return new Date(Date.UTC(y, m, 1, 0, 0, 0) - OFFSET_MS).toISOString();
    })();

    const num = v => Number(v || 0);
    const sumRevenueNgn = arr => arr.reduce((a, r) =>
        a + (r.charge_currency === 'NGN' ? num(r.charge_amount) : 0), 0);
    const sumCostNgn = arr => arr.reduce((a, r) =>
        a + (num(r.provider_cost_usd) * num(r.exchange_rate || 1600)), 0);

    const completed = rows.filter(r => r.status === 'completed');
    const today = rows.filter(r => new Date(r.created_at).toISOString() >= todayStart);
    const month = rows.filter(r => new Date(r.created_at).toISOString() >= monthStart);

    return {
        total: rows.length,
        requested: rows.filter(r => r.status === 'pending').length,
        active: rows.filter(r => r.status === 'active').length,
        waiting_sms: rows.filter(r => ['processing','active'].includes(r.status) && !r.sms_code).length,
        sms_received: rows.filter(r => r.sms_code || r.status === 'sms_received').length,
        completed: completed.length,
        failed: rows.filter(r => r.status === 'failed').length,
        expired: rows.filter(r => r.status === 'expired').length,
        cancelled: rows.filter(r => r.status === 'cancelled').length,
        refunded: rows.filter(r => r.status === 'refunded').length,
        manual_review: rows.filter(r => r.status === 'manual_review').length,
        today_orders: today.length,
        today_revenue_ngn: sumRevenueNgn(today.filter(r => r.status === 'completed')).toFixed(2),
        today_cost_ngn: sumCostNgn(today.filter(r => r.status === 'completed')).toFixed(2),
        today_profit_ngn: (sumRevenueNgn(today.filter(r => r.status === 'completed'))
                          - sumCostNgn(today.filter(r => r.status === 'completed'))).toFixed(2),
        month_orders: month.length,
        month_revenue_ngn: sumRevenueNgn(month.filter(r => r.status === 'completed')).toFixed(2),
        month_profit_ngn: (sumRevenueNgn(month.filter(r => r.status === 'completed'))
                           - sumCostNgn(month.filter(r => r.status === 'completed'))).toFixed(2),
        summaryAvailable: true,
        from: fromIso, to: toIso
    };
}

function emptyStats(fromIso, toIso, reason) {
    return {
        total: 0, requested: 0, active: 0, waiting_sms: 0, sms_received: 0,
        completed: 0, failed: 0, expired: 0, cancelled: 0, refunded: 0, manual_review: 0,
        today_orders: 0, today_revenue_ngn: '0.00', today_cost_ngn: '0.00', today_profit_ngn: '0.00',
        month_orders: 0, month_revenue_ngn: '0.00', month_profit_ngn: '0.00',
        summaryAvailable: false, reason, from: fromIso, to: toIso
    };
}

// ═════════════════════════════════════════════════════════════════
//  LIST
// ═════════════════════════════════════════════════════════════════

async function listOrders(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('virtual_sms_orders')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    const status = String(query.status || '').toLowerCase();
    if (status && status !== 'all') q = q.eq('status', status);

    if (query.country) q = q.eq('country_id', Number(query.country));
    if (query.service) q = q.eq('service_code', query.service);
    if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);

    if (query.sms_received === 'yes') q = q.not('sms_code', 'is', null);
    else if (query.sms_received === 'no') q = q.is('sms_code', null);

    if (query.refunded === 'yes') q = q.eq('status', 'refunded');
    else if (query.refunded === 'no') q = q.neq('status', 'refunded');

    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);

    if (query.search) {
        const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
        const orParts = [
            `id::text.ilike.%${safe}%`,
            `phone_number.ilike.%${safe}%`,
            `activation_id.ilike.%${safe}%`,
            `service_code.ilike.%${safe}%`,
            `service_name.ilike.%${safe}%`
        ];
        try {
            const { data: users } = await supabaseAdmin
                .from('profiles')
                .select('id')
                .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
                .limit(50);
            if (users?.length) {
                orParts.push(`user_id.in.(${users.map(u => u.id).join(',')})`);
            }
        } catch (_) { /* optional */ }
        q = q.or(orParts.join(','));
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { orders: [], count: 0, page, limit, totalPages: 0, hasMore: false, available: false, reason: 'VSMS_TABLE_NOT_FOUND' };
        }
        const e = new Error('Failed to load VSMS orders');
        e.status = 500; e.code = 'VSMS_LIST_ERROR'; e.cause = error.message;
        throw e;
    }

    const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);
    const orders = (data || []).map(o => shapeOrder(o, profilesById[o.user_id]));

    return {
        orders, count: count || 0, page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0),
        available: true
    };
}

// ═════════════════════════════════════════════════════════════════
//  DETAIL
// ═════════════════════════════════════════════════════════════════

async function getOrder(id, { revealSensitive = false } = {}) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }

    const { data: raw, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();

    if (error) {
        const e = new Error('Failed to load VSMS order');
        e.status = 500; e.code = 'VSMS_DETAIL_ERROR'; throw e;
    }
    if (!raw) {
        const e = new Error('VSMS order not found');
        e.status = 404; e.code = 'VSMS_NOT_FOUND'; throw e;
    }

    let user = null;
    if (raw.user_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, status, created_at, last_location')
            .eq('id', raw.user_id)
            .maybeSingle();
        user = p || null;
    }

    let transaction = null;
    if (raw.ledger_transaction_id) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, fee, description, created_at, completed_at, failure_reason')
            .eq('id', raw.ledger_transaction_id)
            .maybeSingle();
        transaction = t || null;
    }

    let refundTransaction = null;
    if (raw.refund_transaction_id) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
            .eq('id', raw.refund_transaction_id)
            .maybeSingle();
        refundTransaction = t || null;
    }

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

    const events = await getOrderEvents(id);
    const providerLogs = await getProviderLogs(id);
    const adminActions = await getAdminActions(id);

    return {
        order: shapeOrder(raw, user, { includeSensitive: revealSensitive }),
        user,
        transaction,
        refund_transaction: refundTransaction,
        ledger_entries: ledgerEntries,
        events,
        provider_logs: providerLogs,
        admin_actions: adminActions,
        timeline: buildTimeline(raw, events)
    };
}

function buildTimeline(raw, events) {
    const list = [];
    if (raw.created_at)    list.push({ at: raw.created_at,    kind: 'order_created',  label: 'Order created' });
    if (raw.activated_at)  list.push({ at: raw.activated_at,  kind: 'number_activated', label: `Number assigned${raw.phone_number ? ': ' + maskPhone(raw.phone_number) : ''}` });
    if (raw.sms_received_at) list.push({ at: raw.sms_received_at, kind: 'sms_received', label: 'SMS received' });
    if (raw.completed_at)  list.push({ at: raw.completed_at,  kind: 'completed',  label: 'Order completed' });
    if (raw.cancelled_at)  list.push({ at: raw.cancelled_at,  kind: 'cancelled',  label: 'Order cancelled' });
    if (raw.refunded_at)   list.push({ at: raw.refunded_at,   kind: 'refunded',   label: 'Order refunded' });

    for (const e of events || []) {
        list.push({
            at: e.created_at,
            kind: e.event_type || 'event',
            label: e.message || e.event_type,
            old_status: e.old_status,
            new_status: e.new_status
        });
    }

    list.sort((a, b) => new Date(a.at) - new Date(b.at));
    return list;
}

async function getOrderEvents(id) {
    if (!UUID_RE.test(String(id || ''))) return [];
    try {
        const { data, error } = await supabaseAdmin
            .from('virtual_sms_order_events')
            .select('id, event_type, old_status, new_status, message, provider_response, metadata, created_at')
            .eq('order_id', id)
            .order('created_at', { ascending: true });
        if (error) {
            if (error.code === '42P01') return [];
            console.warn('[VSMS ADMIN] events read failed:', error.message);
            return [];
        }
        return data || [];
    } catch (_) { return []; }
}

async function getProviderLogs(id) {
    if (!UUID_RE.test(String(id || ''))) return [];
    try {
        const { data, error } = await supabaseAdmin
            .from('virtual_sms_provider_logs')
            .select('id, action, endpoint_name, response_status, success, error_code, error_message, duration_ms, created_at')
            .eq('order_id', id)
            .order('created_at', { ascending: true });
        if (error) {
            if (error.code === '42P01') return [];
            console.warn('[VSMS ADMIN] provider logs read failed:', error.message);
            return [];
        }
        return data || [];
    } catch (_) { return []; }
}

async function getAdminActions(id) {
    if (!UUID_RE.test(String(id || ''))) return [];
    try {
        const { data, error } = await supabaseAdmin
            .from('virtual_sms_admin_actions')
            .select('id, admin_id, action, old_status, new_status, reason, metadata, created_at')
            .eq('order_id', id)
            .order('created_at', { ascending: true });
        if (error) {
            if (error.code === '42P01') return [];
            console.warn('[VSMS ADMIN] admin actions read failed:', error.message);
            return [];
        }
        return data || [];
    } catch (_) { return []; }
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER STATE CLASSIFICATION
// ═════════════════════════════════════════════════════════════════

async function resolveProviderState(order) {
    if (!order.activation_id) {
        return { classification: 'UNKNOWN', reason: 'NO_ACTIVATION_ID' };
    }

    let result;
    try {
        const r = await fetchProvider({ action: 'getStatusV2', id: order.activation_id });
        result = r.body;
    } catch (e) {
        await recordProviderLog({
            orderId: order.id,
            action: 'getStatusV2',
            endpointName: 'getStatusV2',
            requestPayload: { id: order.activation_id },
            responseStatus: e.providerStatus || null,
            success: false,
            errorCode: e.code || 'PROVIDER_QUERY_FAILED',
            errorMessage: e.message,
            durationMs: e.durationMs
        });
        return { classification: 'UNKNOWN', reason: `PROVIDER_QUERY_FAILED: ${e.message}` };
    }

    await recordProviderLog({
        orderId: order.id,
        action: 'getStatusV2',
        endpointName: 'getStatusV2',
        requestPayload: { id: order.activation_id },
        responsePayload: result,
        responseStatus: 200,
        success: true,
        durationMs: 0
    });

    const status = String(result?.status || '').toUpperCase();

    if (status === 'STATUS_OK') {
        return {
            classification: 'CONFIRMED_FULFILLED',
            smsCode: result.code || result.smsCode || null,
            raw: result
        };
    }
    if (status === 'STATUS_CANCEL' || status === 'STATUS_WAIT_CODE') {
        // STATUS_WAIT_CODE means "still waiting" — not terminal.
        if (status === 'STATUS_CANCEL') {
            return { classification: 'CONFIRMED_NOT_FULFILLED', raw: result };
        }
        return { classification: 'UNKNOWN', raw: result };
    }
    if (status === 'STATUS_WAIT_RETRY' || status === 'STATUS_WAIT_RESEND') {
        return { classification: 'UNKNOWN', raw: result };
    }
    return { classification: 'UNKNOWN', raw: result };
}

// ═════════════════════════════════════════════════════════════════
//  STATE WRITER
// ═════════════════════════════════════════════════════════════════

async function loadVsmsById(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) { const e = new Error('Failed to load VSMS order'); e.status = 500; e.code = 'VSMS_DETAIL_ERROR'; throw e; }
    if (!data) { const e = new Error('VSMS order not found'); e.status = 404; e.code = 'VSMS_NOT_FOUND'; throw e; }
    return data;
}

async function transitionVsms({ orderId, expectedCurrentStatus, nextStatus, extraFields = {}, ctx, eventType, reason = null }) {
    const current = String(expectedCurrentStatus || '').toLowerCase();
    const next_ = String(nextStatus || '').toLowerCase();

    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next_)) {
        const e = new Error(`Cannot transition from "${current}" to "${next_}".`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION';
        e.allowed_transitions = allowed;
        throw e;
    }

    const now = new Date().toISOString();
    const patch = { ...extraFields, status: next_, updated_at: now };
    if (next_ === 'completed')  patch.completed_at = now;
    if (next_ === 'cancelled')  patch.cancelled_at = now;
    if (next_ === 'refunded')   patch.refunded_at = now;

    const { data: updated, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .update(patch)
        .eq('id', orderId)
        .eq('status', current)
        .select('*')
        .maybeSingle();

    if (error) {
        const e = new Error('Failed to update VSMS order');
        e.status = 500; e.code = 'VSMS_UPDATE_ERROR'; e.cause = error.message; throw e;
    }
    if (!updated) {
        const e = new Error('Order changed while you were editing it. Reload and try again.');
        e.status = 409; e.code = 'ORDER_STATE_CHANGED';
        e.expected_status = current; throw e;
    }

    await recordOrderEvent({
        orderId,
        eventType: eventType || next_,
        oldStatus: current,
        newStatus: next_,
        message: reason || null
    });

    if (ctx) {
        await recordAudit({
            ctx,
            action: `virtual_sms.${eventType || next_}`,
            targetId: orderId,
            before: { status: current },
            after: { status: next_ },
            reason
        });
        await recordAdminAction({
            ctx,
            orderId,
            action: eventType || next_,
            oldStatus: current,
            newStatus: next_,
            reason
        });
    }

    return updated;
}

// ═════════════════════════════════════════════════════════════════
//  SYNC
// ═════════════════════════════════════════════════════════════════

async function syncOrder({ orderId, ctx }) {
    const raw = await loadVsmsById(orderId);
    const current = String(raw.status || '').toLowerCase();

    const provider = await resolveProviderState(raw);

    if (provider.classification === 'CONFIRMED_FULFILLED' && provider.smsCode) {
        if (!raw.sms_code) {
            const patch = {
                sms_code: provider.smsCode,
                sms_status: 'received',
                otp_status: 'received',
                sms_received_at: new Date().toISOString(),
                provider_response: provider.raw || raw.provider_response,
                updated_at: new Date().toISOString()
            };
            if (current === 'active' || current === 'processing') patch.status = 'sms_received';
            await supabaseAdmin.from('virtual_sms_orders').update(patch).eq('id', raw.id);
            await recordOrderEvent({
                orderId: raw.id,
                eventType: 'sms_received',
                oldStatus: current,
                newStatus: patch.status || current,
                message: 'SMS received via admin sync'
            });
        }
        return { synced: true, resolved: 'sms_received' };
    }

    if (provider.classification === 'CONFIRMED_NOT_FULFILLED') {
        if (current !== 'cancelled' && current !== 'failed' && current !== 'refunded') {
            await transitionVsms({
                orderId: raw.id,
                expectedCurrentStatus: current,
                nextStatus: 'failed',
                extraFields: {
                    failure_code: 'PROVIDER_CANCEL',
                    failure_message: 'Provider reported the number was cancelled.'
                },
                ctx,
                eventType: 'sync_failed',
                reason: 'Provider reported cancellation'
            });
        }
        return { synced: true, resolved: 'failed' };
    }

    // UNKNOWN — leave status, record the check.
    return { synced: true, resolved: 'unknown', reason: provider.reason || null };
}

// ═════════════════════════════════════════════════════════════════
//  CANCEL (provider + refund)
// ═════════════════════════════════════════════════════════════════

async function cancelOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }

    const raw = await loadVsmsById(orderId);
    const current = String(raw.status || '').toLowerCase();

    if (['cancelled', 'refunded', 'expired'].includes(current)) {
        const e = new Error(`Order is already ${current}.`); e.status = 409; e.code = 'ORDER_INACTIVE'; throw e;
    }

    // 1. Provider cancel (setStatus=8). If it fails we abort — this
    //    is a state-changing request and we must know whether it
    //    succeeded before refunding.
    if (raw.activation_id) {
        let r;
        try {
            r = await fetchProvider({ action: 'setStatus', id: raw.activation_id, status: 8 });
        } catch (err) {
            await recordProviderLog({
                orderId: raw.id,
                action: 'setStatus=8',
                endpointName: 'setStatus',
                requestPayload: { id: raw.activation_id, status: 8 },
                responseStatus: err.providerStatus || null,
                success: false,
                errorCode: 'PROVIDER_CANCEL_FAILED',
                errorMessage: err.message,
                durationMs: err.durationMs
            });
            const e = new Error('Provider cancellation failed.'); e.status = 502; e.code = 'PROVIDER_CANCEL_FAILED'; throw e;
        }

        const body = r.body;
        const ok = body === 'ACCESS_CANCEL' || body?.status === 'ACCESS_CANCEL';
        await recordProviderLog({
            orderId: raw.id,
            action: 'setStatus=8',
            endpointName: 'setStatus',
            requestPayload: { id: raw.activation_id, status: 8 },
            responsePayload: body,
            responseStatus: 200,
            success: ok,
            durationMs: r.durationMs
        });

        if (!ok) {
            const e = new Error('Provider cancellation was not confirmed.');
            e.status = 502; e.code = 'PROVIDER_CANCEL_NOT_CONFIRMED'; throw e;
        }
    }

    // 2. Refund.
    if (!raw.ledger_transaction_id) {
        const e = new Error('Order has no wallet transaction.');
        e.status = 422; e.code = 'NO_TRANSACTION'; throw e;
    }

    const { data: originalTx } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, status, currency, amount')
        .eq('id', raw.ledger_transaction_id)
        .maybeSingle();
    if (!originalTx) { const e = new Error('Original transaction not found.'); e.status = 404; e.code = 'TX_NOT_FOUND'; throw e; }
    if (String(originalTx.status).toLowerCase() !== 'completed') {
        const e = new Error('Original transaction is not completed — cannot refund.'); e.status = 422; e.code = 'TX_NOT_REFUNDABLE'; throw e;
    }

    // Idempotency: unique index on transactions(source_id) WHERE type='refund'.
    const { data: existingRefund } = await supabaseAdmin
        .from('transactions')
        .select('id, reference, amount, currency')
        .eq('source_id', originalTx.id)
        .eq('type', 'refund')
        .maybeSingle();

    if (existingRefund) {
        await transitionVsms({
            orderId: raw.id,
            expectedCurrentStatus: current,
            nextStatus: 'refunded',
            extraFields: {
                refund_status: 'completed',
                refund_transaction_id: existingRefund.id
            },
            ctx, eventType: 'refund_idempotent',
            reason: 'Idempotent: refund already existed'
        });
        return {
            cancelled: true,
            refund: {
                transaction_id: existingRefund.id,
                reference: existingRefund.reference,
                amount: existingRefund.amount,
                currency: existingRefund.currency,
                already_refunded: true
            }
        };
    }

    let credit;
    try {
        credit = await LedgerService.creditWallet({
            userId: raw.user_id,
            amount: originalTx.amount,
            currency: originalTx.currency,
            description: `VSMS cancel refund — ${raw.service_name || raw.service_code}`,
            type: 'refund',
            sourceType: 'virtual_sms_order',
            sourceId: originalTx.id,
            reference: `VSMSREF-${raw.id}`,
            metadata: { order_id: raw.id, reason }
        });
    } catch (err) {
        const msg = String(err.message || '');
        if (msg.includes('duplicate') || msg.includes('unique')) {
            const { data: raceRefund } = await supabaseAdmin
                .from('transactions')
                .select('id, reference, amount, currency')
                .eq('source_id', originalTx.id)
                .eq('type', 'refund')
                .maybeSingle();
            if (raceRefund) {
                await transitionVsms({
                    orderId: raw.id,
                    expectedCurrentStatus: current,
                    nextStatus: 'refunded',
                    extraFields: { refund_status: 'completed', refund_transaction_id: raceRefund.id },
                    ctx, eventType: 'refund_idempotent',
                    reason: 'Idempotent: refund already existed (race)'
                });
                return {
                    cancelled: true,
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

    await transitionVsms({
        orderId: raw.id,
        expectedCurrentStatus: current,
        nextStatus: 'refunded',
        extraFields: {
            refund_status: 'completed',
            refund_transaction_id: credit.transaction_id || null
        },
        ctx, eventType: 'cancel_refunded', reason
    });

    return {
        cancelled: true,
        refund: {
            transaction_id: credit.transaction_id || null,
            reference: credit.reference || null,
            amount: originalTx.amount,
            currency: originalTx.currency,
            already_refunded: false
        }
    };
}

// ═════════════════════════════════════════════════════════════════
//  RELEASE (provider releases number, no refund)
// ═════════════════════════════════════════════════════════════════

async function releaseNumber({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const raw = await loadVsmsById(orderId);

    if (!raw.activation_id) {
        const e = new Error('Order has no number to release.');
        e.status = 422; e.code = 'NO_ACTIVATION';
        throw e;
    }

    let r;
    try {
        r = await fetchProvider({ action: 'setStatus', id: raw.activation_id, status: 8 });
    } catch (err) {
        const e = new Error('Provider release failed.'); e.status = 502; e.code = 'PROVIDER_RELEASE_FAILED'; throw e;
    }

    await recordProviderLog({
        orderId: raw.id,
        action: 'release',
        endpointName: 'setStatus',
        requestPayload: { id: raw.activation_id, status: 8 },
        responsePayload: r.body,
        responseStatus: 200,
        success: true,
        durationMs: r.durationMs
    });

    await recordOrderEvent({
        orderId: raw.id,
        eventType: 'number_released',
        oldStatus: raw.status,
        newStatus: raw.status,
        message: 'Number released by admin'
    });

    await recordAudit({
        ctx, action: 'virtual_sms.release_number',
        targetId: raw.id, before: null,
        after: { activation_id: raw.activation_id }, reason
    });
    await recordAdminAction({
        ctx, orderId: raw.id, action: 'release_number',
        oldStatus: raw.status, newStatus: raw.status, reason
    });

    return { released: true };
}

// ═════════════════════════════════════════════════════════════════
//  RETRY (ask provider to resend)
// ═════════════════════════════════════════════════════════════════

async function retryOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const raw = await loadVsmsById(orderId);

    if (!raw.activation_id) {
        const e = new Error('Order has no activation to retry.');
        e.status = 422; e.code = 'NO_ACTIVATION'; throw e;
    }

    let r;
    try {
        r = await fetchProvider({ action: 'setStatus', id: raw.activation_id, status: 3 });
    } catch (err) {
        const e = new Error('Provider retry failed.'); e.status = 502; e.code = 'PROVIDER_RETRY_FAILED'; throw e;
    }

    await recordProviderLog({
        orderId: raw.id,
        action: 'retry',
        endpointName: 'setStatus',
        requestPayload: { id: raw.activation_id, status: 3 },
        responsePayload: r.body,
        responseStatus: 200,
        success: true,
        durationMs: r.durationMs
    });

    await recordOrderEvent({
        orderId: raw.id,
        eventType: 'sms_retry',
        oldStatus: raw.status,
        newStatus: raw.status,
        message: 'SMS resend requested by admin'
    });

    await recordAudit({
        ctx, action: 'virtual_sms.retry',
        targetId: raw.id, before: null, after: null, reason
    });
    await recordAdminAction({
        ctx, orderId: raw.id, action: 'retry',
        oldStatus: raw.status, newStatus: raw.status, reason
    });

    return { retried: true };
}

// ═════════════════════════════════════════════════════════════════
//  REFUND (without touching the provider)
// ═════════════════════════════════════════════════════════════════

async function refundOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const raw = await loadVsmsById(orderId);
    const current = String(raw.status || '').toLowerCase();

    if (current === 'refunded') {
        const e = new Error('Order is already refunded.'); e.status = 409; e.code = 'ALREADY_REFUNDED'; throw e;
    }
    if (!['failed', 'cancelled', 'expired', 'manual_review'].includes(current)) {
        const e = new Error('Only failed, cancelled, expired, or manual-review orders can be refunded.');
        e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
    }
    if (!raw.ledger_transaction_id) {
        const e = new Error('Order has no wallet transaction.'); e.status = 422; e.code = 'NO_TRANSACTION'; throw e;
    }

    const { data: originalTx } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, status, currency, amount')
        .eq('id', raw.ledger_transaction_id)
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
        await transitionVsms({
            orderId: raw.id,
            expectedCurrentStatus: current,
            nextStatus: 'refunded',
            extraFields: {
                refund_status: 'completed',
                refund_transaction_id: existingRefund.id
            },
            ctx, eventType: 'refund_idempotent',
            reason: 'Idempotent: refund already existed'
        });
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

    let credit;
    try {
        credit = await LedgerService.creditWallet({
            userId: raw.user_id,
            amount: originalTx.amount,
            currency: originalTx.currency,
            description: `VSMS refund — ${raw.service_name || raw.service_code}`,
            type: 'refund',
            sourceType: 'virtual_sms_order',
            sourceId: originalTx.id,
            reference: `VSMSREF-${raw.id}`,
            metadata: { order_id: raw.id, reason }
        });
    } catch (err) {
        const msg = String(err.message || '');
        if (msg.includes('duplicate') || msg.includes('unique')) {
            const { data: raceRefund } = await supabaseAdmin
                .from('transactions')
                .select('id, reference, amount, currency')
                .eq('source_id', originalTx.id)
                .eq('type', 'refund')
                .maybeSingle();
            if (raceRefund) {
                await transitionVsms({
                    orderId: raw.id,
                    expectedCurrentStatus: current,
                    nextStatus: 'refunded',
                    extraFields: { refund_status: 'completed', refund_transaction_id: raceRefund.id },
                    ctx, eventType: 'refund_idempotent',
                    reason: 'Idempotent: refund already existed (race)'
                });
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

    await transitionVsms({
        orderId: raw.id,
        expectedCurrentStatus: current,
        nextStatus: 'refunded',
        extraFields: {
            refund_status: 'completed',
            refund_transaction_id: credit.transaction_id || null
        },
        ctx, eventType: 'refund', reason
    });

    return {
        refund: {
            transaction_id: credit.transaction_id || null,
            reference: credit.reference || null,
            amount: originalTx.amount,
            currency: originalTx.currency,
            already_refunded: false
        }
    };
}

// ═════════════════════════════════════════════════════════════════
//  MANUAL STATUS CHANGE
// ═════════════════════════════════════════════════════════════════

async function changeStatus({ orderId, nextStatus, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const raw = await loadVsmsById(orderId);
    const current = String(raw.status || '').toLowerCase();
    const next_ = String(nextStatus || '').toLowerCase();

    if (current === next_) {
        return { order: shapeOrder(raw, null), no_op: true };
    }

    const updated = await transitionVsms({
        orderId: raw.id,
        expectedCurrentStatus: current,
        nextStatus: next_,
        ctx,
        eventType: 'admin_status_change',
        reason
    });

    return { order: shapeOrder(updated, null) };
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

async function getProviderHealth() {
    const configured = Boolean(process.env.VSMS_API_KEY);

    let live = { reachable: false, lastError: null, latencyMs: null };
    const started = Date.now();
    try {
        const r = await fetchProvider({ action: 'getCountries' });
        live.reachable = !!r.body;
        live.latencyMs = Date.now() - started;
    } catch (e) {
        live.lastError = e.message;
        live.latencyMs = Date.now() - started;
    }

    let lastSuccess = null, lastFailure = null, recentCount = 0;
    try {
        const { data: ok } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('sms_received_at')
            .not('sms_received_at', 'is', null)
            .order('sms_received_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        lastSuccess = ok?.sms_received_at || null;

        const { data: bad } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('updated_at, failure_message')
            .in('status', ['failed','manual_review'])
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (bad) lastFailure = { at: bad.updated_at, reason: bad.failure_message || null };

        const { count } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        recentCount = count || 0;
    } catch (_) {}

    const status = !configured ? 'not_configured'
        : !live.reachable ? 'unreachable'
        : lastFailure && (!lastSuccess || new Date(lastFailure.at) > new Date(lastSuccess))
            ? 'degraded'
            : 'operational';

    return {
        provider: 'virtualsms',
        label: 'VirtualSMS',
        status,
        configured,
        reachable: live.reachable,
        latencyMs: live.latencyMs,
        lastSuccess,
        lastFailure,
        recentCount,
        lastError: live.lastError
    };
}

async function healthCheckProvider({ ctx }) {
    const started = Date.now();
    let live = { reachable: false, error: null };
    try {
        await fetchProvider({ action: 'getCountries' });
        live.reachable = true;
    } catch (e) {
        live.error = e.message;
    }
    const result = {
        configured: Boolean(process.env.VSMS_API_KEY),
        reachable: live.reachable,
        latencyMs: Date.now() - started,
        lastError: live.error
    };
    await recordAudit({
        ctx, action: 'virtual_sms.health_check',
        targetId: 'virtualsms', before: null, after: result, reason: null
    });
    return result;
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    ALLOWED_TRANSITIONS,

    getStats,
    listOrders,
    getOrder,
    getOrderEvents,
    getProviderLogs,
    getAdminActions,

    syncOrder,
    cancelOrder,
    releaseNumber,
    retryOrder,
    refundOrder,
    changeStatus,

    getProviderHealth,
    healthCheckProvider,

    maskPhone,
    maskEmail
};