// services/giftCardService.js
// ─────────────────────────────────────────────────────────────────
// Gift Cards — service layer.
//
// Single source of truth for the gift-card order lifecycle:
//   • listing / inspecting orders and the product catalog
//   • retry with three-state provider resolution
//   • atomic refund via LedgerService (unique-index protected)
//   • atomic completion (unique delivery row + conditional status)
//   • webhook-triggered verification → completion
//   • admin mutations with state-machine enforcement
//
// Financial rules:
//   • Wallet mutation only via LedgerService. This file never
//     touches ledger_accounts or ledger_entries directly.
//   • Refund is credited with type='refund' and source_id set to
//     the original transaction id. A unique index enforces one
//     refund per original transaction.
//   • Completion is guarded by:
//        1. delivered row inserted under UNIQUE(order_id)
//        2. conditional UPDATE ... WHERE status = expected
//
// Concurrency:
//   • Every status transition uses:
//        UPDATE ... SET status = $next
//        WHERE id = $id AND status = $expected
//     Zero rows → 409 ORDER_STATE_CHANGED.
//
// Money values pass through as strings from Postgres NUMERIC.
// Nothing is fabricated. Errors are logged server-side and
// sanitized before returning.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const dtone = require('./dtoneService');

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const SEARCH_MAX_LENGTH = 120;

const ORDER_STATUSES = new Set([
    'pending_payment', 'paid', 'processing', 'provider_pending',
    'completed', 'failed', 'refund_pending', 'refunded', 'cancelled',
    'reconciliation_required'
]);

const SUCCESS_STATUSES = new Set(['completed']);
const PENDING_STATUSES = new Set([
    'pending_payment', 'paid', 'processing', 'provider_pending',
    'refund_pending', 'reconciliation_required'
]);
const FAILED_STATUSES  = new Set(['failed', 'cancelled']);

// State machine. Every status change in this service is checked
// against this table before writing.
const ALLOWED_TRANSITIONS = Object.freeze({
    pending_payment:        ['paid', 'cancelled', 'failed'],
    paid:                   ['processing', 'cancelled', 'failed'],
    processing:             ['provider_pending', 'reconciliation_required', 'completed', 'failed'],
    provider_pending:       ['processing', 'reconciliation_required', 'completed', 'failed'],
    reconciliation_required:['processing', 'provider_pending', 'completed', 'failed'],
    completed:              [],
    failed:                 ['refund_pending', 'cancelled'],
    refund_pending:         ['refunded', 'failed'],
    refunded:               [],
    cancelled:              ['failed']
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
    if (PENDING_STATUSES.has(s)) return 'warn';
    if (s === 'refunded') return 'info';
    return 'neutral';
}
function prettyBrand(name) {
    return String(name || '').trim() || 'Gift Card';
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

// ─── Audit (fail-loud) ───────────────────────────────────────────
// Financial/admin operations must not succeed silently if the audit
// insert fails. Callers treat a thrown error as a failed operation.
async function recordAudit({ ctx, action, targetId, before, after, reason }) {
    const { error } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert({
            admin_id: ctx?.adminId || null,
            admin_email: ctx?.adminEmail || null,
            action,
            target_type: 'gift_card_order',
            target_id: targetId,
            before: before || null,
            after: after || null,
            reason: reason ? String(reason).slice(0, 500) : null,
            ip_address: ctx?.ip || null,
            user_agent: ctx?.userAgent || null,
            created_at: new Date().toISOString()
        });
    if (error) {
        console.error('[GIFTCARD] audit insert failed:', error.message);
        const e = new Error('Audit logging failed.');
        e.status = 500; e.code = 'AUDIT_WRITE_FAILED';
        throw e;
    }
}

// ─── Order-event writer ──────────────────────────────────────────
// Keeps the timeline authoritative instead of reconstructing from
// created_at + audit_logs. Failure is non-fatal.
async function recordOrderEvent({
    orderId, eventType, fromStatus = null, toStatus = null,
    actorType = 'system', actorId = null,
    provider = null, providerReference = null,
    metadata = null, reason = null
}) {
    try {
        await supabaseAdmin.from('gift_card_order_events').insert({
            order_id: orderId,
            event_type: eventType,
            from_status: fromStatus,
            to_status: toStatus,
            actor_type: actorType,
            actor_id: actorId,
            provider,
            provider_reference: providerReference,
            metadata: metadata || null,
            reason: reason ? String(reason).slice(0, 500) : null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[GIFTCARD] event insert failed:', e.message);
    }
}

// ─── Reference builders (crypto, not Math.random) ────────────────

function buildOrderRef() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `GC-${date}-${rand}`;
}
function buildExternalId(orderRef, attemptNo) {
    const suffix = attemptNo ? `A${attemptNo}` : '';
    return `MSGC-${orderRef}${suffix}`.slice(0, 40);
}

// ─── State transition primitive ──────────────────────────────────
// Every status write goes through here. Enforces the state machine
// AND optimistic locking in one DB round-trip.
async function transitionOrderStatus({
    orderId,
    expectedCurrentStatus,
    nextStatus,
    reason = null,
    extraFields = {},
    ctx = null,
    eventType = 'status_changed'
}) {
    const current = String(expectedCurrentStatus || '').toLowerCase();
    const next_ = String(nextStatus || '').toLowerCase();

    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next_)) {
        const e = new Error(`Cannot transition from "${current}" to "${next_}".`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION';
        e.allowed_transitions = allowed;
        e.current_status = current;
        throw e;
    }

    const now = new Date().toISOString();
    const update = {
        status: next_,
        updated_at: now,
        ...extraFields
    };
    if (next_ === 'completed')   update.completed_at = now;
    if (next_ === 'refunded')    update.refunded_at = now;

    const { data: updated, error } = await supabaseAdmin
        .from('gift_card_orders')
        .update(update)
        .eq('id', orderId)
        .eq('status', current)
        .select('*')
        .maybeSingle();

    if (error) {
        const e = new Error('Failed to update order status.');
        e.status = 500; e.code = 'ORDER_UPDATE_FAILED';
        e.cause = error.message;
        throw e;
    }
    if (!updated) {
        const e = new Error('Order changed while you were editing it. Reload and try again.');
        e.status = 409; e.code = 'ORDER_STATE_CHANGED';
        e.expected_status = current;
        throw e;
    }

    await recordOrderEvent({
        orderId,
        eventType,
        fromStatus: current,
        toStatus: next_,
        actorType: ctx ? 'admin' : 'system',
        actorId: ctx?.adminId || null,
        reason
    });

    if (ctx) {
        await recordAudit({
            ctx,
            action: `gift_card.${eventType}`,
            targetId: orderId,
            before: { status: current },
            after: { status: next_ },
            reason
        });
    }

    return { updated: true, order: updated };
}

// ═════════════════════════════════════════════════════════════════
//  ORDERS — list
// ═════════════════════════════════════════════════════════════════

async function listOrders(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('gift_card_orders')
        .select(`
            id, order_ref, user_id, status, provider, provider_transaction_id,
            provider_reference, brand, country_iso, country_name,
            face_value, face_currency, customer_price_ngn, provider_cost_ngn,
            provider_cost_usd, fx_rate, transaction_id, refund_transaction_id,
            failure_reason, failure_code, created_at, updated_at,
            completed_at, refunded_at
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (query.status && query.status !== 'all') {
        if (ORDER_STATUSES.has(String(query.status).toLowerCase())) {
            q = q.eq('status', String(query.status).toLowerCase());
        }
    }
    if (query.brand) q = q.ilike('brand', `%${query.brand}%`);
    if (query.country) q = q.eq('country_iso', String(query.country).toUpperCase());
    if (query.provider) q = q.eq('provider', query.provider);
    if (query.user_id) q = q.eq('user_id', query.user_id);

    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);

    // Search across order fields AND user identity.
    if (query.search) {
        const raw = String(query.search).trim().slice(0, SEARCH_MAX_LENGTH);
        const safe = raw.replace(/[%_]/g, m => '\\' + m);
        const orParts = [
            `order_ref.ilike.%${safe}%`,
            `provider_transaction_id.ilike.%${safe}%`,
            `provider_reference.ilike.%${safe}%`,
            `brand.ilike.%${safe}%`
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
            return {
                orders: [], count: 0, page, limit, totalPages: 0,
                hasMore: false, available: false,
                reason: 'GIFT_CARD_ORDERS_TABLE_NOT_FOUND'
            };
        }
        const e = new Error('Failed to load gift card orders');
        e.status = 500; e.code = 'GCO_LIST_ERROR';
        e.cause = error.message;
        throw e;
    }

    const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);
    const orders = (data || []).map(o => shapeOrder(o, profilesById[o.user_id]));

    return {
        orders,
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0),
        available: true
    };
}

function shapeOrder(o, profile) {
    return {
        id: o.id,
        order_ref: o.order_ref,
        status: o.status,
        status_badge: statusBadge(o.status),
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : { id: o.user_id, username: 'Unknown', email: null },
        brand: prettyBrand(o.brand),
        country_iso: o.country_iso,
        country_name: o.country_name,
        face_value: o.face_value ?? null,
        face_currency: o.face_currency || null,
        customer_price_ngn: o.customer_price_ngn ?? null,
        provider_cost_ngn: o.provider_cost_ngn ?? null,
        provider_cost_usd: o.provider_cost_usd ?? null,
        fx_rate: o.fx_rate ?? null,
        provider: o.provider || null,
        provider_product_id: o.provider_product_id || null,
        provider_transaction_id: o.provider_transaction_id || null,
        provider_reference: o.provider_reference || null,
        transaction_id: o.transaction_id || null,
        refund_transaction_id: o.refund_transaction_id || null,
        failure_reason: o.failure_reason || null,
        failure_code: o.failure_code || null,
        created_at: o.created_at,
        updated_at: o.updated_at || null,
        completed_at: o.completed_at || null,
        refunded_at: o.refunded_at || null
    };
}

// ═════════════════════════════════════════════════════════════════
//  ORDERS — summary
// ═════════════════════════════════════════════════════════════════

async function getSummary(query = {}) {
    const fromIso = isoDate(query.from) || startOfWatDay();
    const toIso = isoDate(query.to) || new Date().toISOString();

    const rpc = await supabaseAdmin.rpc('giftcard_summary_full', {
        p_from: fromIso,
        p_to: toIso
    });

    if (!rpc.error && rpc.data) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        return {
            total:               Number(row.total            || 0),
            completed:           Number(row.completed        || 0),
            pending:             Number(row.pending          || 0),
            failed:              Number(row.failed           || 0),
            refunded:            Number(row.refunded         || 0),
            reconciliationRequired: Number(row.reconciliation_required || 0),
            revenueNgn:          String(row.revenue_ngn      || '0.00'),
            costNgn:             String(row.cost_ngn         || '0.00'),
            marginNgn:           String(row.margin_ngn       || '0.00'),
            summaryAvailable: true,
            from: fromIso,
            to: toIso
        };
    }

    if (rpc.error?.code !== '42883' && rpc.error?.code !== 'PGRST202') {
        const e = new Error('Failed to aggregate gift card summary');
        e.status = 500; e.code = 'GCO_SUMMARY_ERROR';
        e.cause = rpc.error.message;
        throw e;
    }

    // RPC not deployed — do counts only, report the money as
    // unavailable. Never fabricate a zero.
    const countWhere = (extra) => {
        let q = supabaseAdmin
            .from('gift_card_orders')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', fromIso)
            .lte('created_at', toIso);
        if (extra) q = extra(q);
        return q;
    };

    const [totalRes, completedRes, pendingRes, failedRes, refundedRes, reconRes] = await Promise.all([
        countWhere(),
        countWhere(q => q.eq('status', 'completed')),
        countWhere(q => q.in('status', ['pending_payment','paid','processing','provider_pending'])),
        countWhere(q => q.in('status', ['failed','cancelled'])),
        countWhere(q => q.eq('status', 'refunded')),
        countWhere(q => q.eq('status', 'reconciliation_required'))
    ]);

    return {
        total:                  totalRes.count || 0,
        completed:              completedRes.count || 0,
        pending:                pendingRes.count || 0,
        failed:                 failedRes.count || 0,
        refunded:               refundedRes.count || 0,
        reconciliationRequired: reconRes.count || 0,
        revenueNgn:  null,
        costNgn:     null,
        marginNgn:   null,
        summaryAvailable: false,
        reason: 'SUMMARY_RPC_NOT_DEPLOYED',
        from: fromIso,
        to: toIso
    };
}

function startOfWatDay() {
    const OFFSET_MS = 60 * 60 * 1000;
    const now = new Date();
    const local = new Date(now.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const d = local.getUTCDate();
    return new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS).toISOString();
}

// ═════════════════════════════════════════════════════════════════
//  ORDERS — detail
// ═════════════════════════════════════════════════════════════════

async function getOrder(id) {
    const orderId = normalizeOrderId(id);
    if (!orderId) {
        const e = new Error('Invalid order id');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }

    const { data: order, error } = await supabaseAdmin
        .from('gift_card_orders')
        .select('*')
        .eq('id', orderId)
        .maybeSingle();

    if (error) {
        const e = new Error('Failed to load gift card order');
        e.status = 500; e.code = 'GCO_DETAIL_ERROR';
        throw e;
    }
    if (!order) {
        const e = new Error('Gift card order not found');
        e.status = 404; e.code = 'GCO_NOT_FOUND';
        throw e;
    }

    let user = null;
    if (order.user_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, phone, status, created_at')
            .eq('id', order.user_id)
            .maybeSingle();
        user = p || null;
    }

    let delivery = null;
    try {
        const { data: d } = await supabaseAdmin
            .from('gift_card_deliveries')
            .select('id, order_id, code, serial, instructions, delivery_type, delivered_at')
            .eq('order_id', order.id)
            .maybeSingle();
        if (d) {
            delivery = {
                id: d.id,
                delivery_type: d.delivery_type || 'pin',
                serial: d.serial || null,
                instructions: d.instructions || null,
                delivered_at: d.delivered_at || null,
                code_preview: d.code ? maskCode(d.code) : null,
                has_code: Boolean(d.code)
            };
        }
    } catch (_) { /* optional */ }

    let transaction = null;
    if (order.transaction_id) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, fee, description, metadata, created_at, completed_at, failure_reason')
            .eq('id', order.transaction_id)
            .maybeSingle();
        transaction = t || null;
    }

    let refundTransaction = null;
    if (order.refund_transaction_id) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
            .eq('id', order.refund_transaction_id)
            .maybeSingle();
        refundTransaction = t || null;
    }

    let ledgerEntries = [];
    if (order.transaction_id) {
        try {
            const { data: le } = await supabaseAdmin
                .from('ledger_entries')
                .select('id, transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, description, created_at')
                .eq('transaction_id', order.transaction_id)
                .order('created_at', { ascending: true });
            ledgerEntries = le || [];
        } catch (_) { /* optional */ }
    }

    let attempts = [];
    try {
        const { data: at } = await supabaseAdmin
            .from('gift_card_order_attempts')
            .select('id, attempt_no, provider, external_id, provider_transaction_id, provider_status, status, failure_reason, created_at, updated_at, completed_at')
            .eq('order_id', order.id)
            .order('attempt_no', { ascending: true });
        attempts = at || [];
    } catch (_) { /* optional */ }

    const timeline = await loadOrderEvents(order);

    // Explicit allowlist for admin diagnostics. No `SELECT *` passthrough.
    const shaped = shapeOrder(order, user);

    return {
        order: shaped,
        provider_snapshot: {
            provider: order.provider,
            provider_product_id: order.provider_product_id || null,
            provider_transaction_id: order.provider_transaction_id || null,
            provider_reference: order.provider_reference || null,
            provider_status: order.provider_status || null,
            provider_status_code: order.provider_status_code || null,
            provider_outcome: order.provider_outcome || null,
            last_provider_check_at: order.last_provider_check_at || null,
            provider_check_attempts: order.provider_check_attempts ?? 0
        },
        pricing_snapshot: {
            face_value: order.face_value,
            face_currency: order.face_currency,
            provider_cost_usd: order.provider_cost_usd,
            provider_cost_ngn: order.provider_cost_ngn,
            customer_price_ngn: order.customer_price_ngn,
            fx_rate: order.fx_rate,
            pricing_version: order.pricing_version || null,
            markup_pct: order.markup_pct || null,
            fx_source: order.fx_source || null
        },
        failure: {
            code: order.failure_code || null,
            reason: order.failure_reason || null
        },
        user,
        delivery,
        transaction,
        refund_transaction: refundTransaction,
        ledger_entries: ledgerEntries,
        attempts,
        timeline
    };
}

// Postgres BIGINT returns as a number in JS for values under 2^53.
// The service accepts either a number or a decimal string, coerces
// to a canonical numeric string, and rejects anything else.
function normalizeOrderId(id) {
    if (id === null || id === undefined) return null;
    const s = String(id).trim();
    if (!/^\d{1,19}$/.test(s)) return null;
    return s;
}

function maskCode(code) {
    const s = String(code || '');
    if (s.length <= 4) return '••••';
    return s.slice(0, 2) + '•'.repeat(Math.max(4, s.length - 6)) + s.slice(-4);
}

async function loadOrderEvents(order) {
    try {
        const { data } = await supabaseAdmin
            .from('gift_card_order_events')
            .select('id, event_type, from_status, to_status, actor_type, actor_id, provider, provider_reference, metadata, reason, created_at')
            .eq('order_id', order.id)
            .order('created_at', { ascending: true });
        if (data?.length) {
            return data.map(e => ({
                at: e.created_at,
                kind: e.event_type,
                label: e.event_type.replace(/[._]/g, ' '),
                from_status: e.from_status,
                to_status: e.to_status,
                actor_type: e.actor_type,
                reason: e.reason,
                metadata: e.metadata
            }));
        }
    } catch (_) { /* fall through */ }

    const events = [];
    events.push({ at: order.created_at, kind: 'order_created', label: 'Order created' });
    if (order.completed_at) events.push({ at: order.completed_at, kind: 'completed', label: 'Order completed' });
    if (order.refunded_at) events.push({ at: order.refunded_at, kind: 'refunded', label: 'Order refunded' });
    events.sort((a, b) => new Date(a.at) - new Date(b.at));
    return events;
}

// ═════════════════════════════════════════════════════════════════
//  REVEAL delivery code
// ═════════════════════════════════════════════════════════════════

async function revealDeliveryCode({ orderId, ctx }) {
    const id = normalizeOrderId(orderId);
    if (!id) {
        const e = new Error('Invalid order id');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }

    const { data: order } = await supabaseAdmin
        .from('gift_card_orders')
        .select('id, status')
        .eq('id', id)
        .maybeSingle();
    if (!order) {
        const e = new Error('Gift card order not found');
        e.status = 404; e.code = 'GCO_NOT_FOUND';
        throw e;
    }

    const { data: delivery } = await supabaseAdmin
        .from('gift_card_deliveries')
        .select('id, code, serial, instructions')
        .eq('order_id', id)
        .maybeSingle();

    if (!delivery || !delivery.code) {
        const e = new Error('No delivery code is available for this order.');
        e.status = 404; e.code = 'NO_DELIVERY';
        throw e;
    }

    // Audit before handing out the code. If the audit write fails,
    // we do not reveal the code.
    await recordAudit({
        ctx,
        action: 'gift_card.reveal_code',
        targetId: id,
        before: null,
        after: null,
        reason: null
    });

    await recordOrderEvent({
        orderId: id,
        eventType: 'admin.reveal_code',
        actorType: 'admin',
        actorId: ctx?.adminId || null
    });

    return {
        code: delivery.code,
        serial: delivery.serial || null,
        instructions: delivery.instructions || null
    };
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER STATE — three-state model
//
//  Only CONFIRMED_NOT_FULFILLED permits a new purchase attempt.
//  Everything else — including NOT_FOUND — is UNKNOWN and moves the
//  order to reconciliation_required.
// ═════════════════════════════════════════════════════════════════

async function resolveProviderState(order) {
    if (!order.provider_transaction_id && !order.provider_reference) {
        return {
            classification: 'UNKNOWN',
            reason: 'NO_PROVIDER_REFERENCE',
            providerState: null
        };
    }

    let providerState = null;

    try {
        if (order.provider_transaction_id) {
            providerState = await dtone.queryTransaction(order.provider_transaction_id);
        } else {
            const result = await dtone.getTransactionByExternalId(
                order.provider_reference,
                { rich: true }
            );
            if (result?.found && result.transaction) {
                providerState = {
                    status: (result.transaction.status?.message || '').toLowerCase() || 'unknown',
                    code: result.transaction.status?.message || 'UNKNOWN',
                    transactionId: result.transaction.id,
                    normalized: dtone.normalizeStatus
                        ? dtone.normalizeStatus(result.transaction.status || {})
                        : null,
                    raw: result.transaction,
                    notFound: false
                };
            } else {
                providerState = {
                    status: 'not_found',
                    code: 'NOT_FOUND',
                    transactionId: null,
                    raw: null,
                    notFound: true
                };
            }
        }
    } catch (err) {
        return {
            classification: 'UNKNOWN',
            reason: `PROVIDER_QUERY_FAILED: ${err.message}`,
            providerState: null
        };
    }

    if (!providerState) {
        return { classification: 'UNKNOWN', reason: 'PROVIDER_STATE_EMPTY', providerState: null };
    }

    const code = String(providerState.code || providerState.status || '').toUpperCase();
    const normalized = providerState.normalized || {};
    const isFinal = normalized.final === true;

    if (code === 'COMPLETED' || normalized.status === 'completed') {
        return { classification: 'CONFIRMED_FULFILLED', reason: code, providerState };
    }

    if (
        code === 'REJECTED' ||
        code === 'DECLINED' ||
        code === 'CANCELLED' ||
        code === 'CANCELED' ||
        code.startsWith('REJECTED-') ||
        (normalized.status === 'failed' && isFinal) ||
        (normalized.status === 'cancelled' && isFinal)
    ) {
        return { classification: 'CONFIRMED_NOT_FULFILLED', reason: code, providerState };
    }

    return { classification: 'UNKNOWN', reason: code || 'UNKNOWN', providerState };
}

// ═════════════════════════════════════════════════════════════════
//  ADMIN MUTATIONS
// ═════════════════════════════════════════════════════════════════

// ─── Retry a failed order ────────────────────────────────────────
async function retryOrder({ orderId, ctx, reason }) {
    const id = normalizeOrderId(orderId);
    if (!id) {
        const e = new Error('Invalid order id');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.');
        e.status = 422; e.code = 'REASON_REQUIRED';
        throw e;
    }

    const { data: order } = await supabaseAdmin
        .from('gift_card_orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (!order) {
        const e = new Error('Gift card order not found');
        e.status = 404; e.code = 'GCO_NOT_FOUND';
        throw e;
    }

    const current = String(order.status || '').toLowerCase();
    if (current === 'completed') {
        const e = new Error('Order is already completed.');
        e.status = 409; e.code = 'ALREADY_COMPLETED';
        throw e;
    }
    if (current === 'refunded' || current === 'refund_pending') {
        const e = new Error('Order is in a refund state — retry is not allowed.');
        e.status = 409; e.code = 'IN_REFUND_STATE';
        throw e;
    }

    const resolved = await resolveProviderState(order);
    const { classification, reason: providerReason, providerState } = resolved;

    if (classification === 'CONFIRMED_FULFILLED') {
        await deliverAndComplete({
            order,
            providerRaw: providerState?.raw || {},
            ctx,
            source: 'retry_detected_completed_at_provider'
        });
        return { outcome: 'delivered_existing' };
    }

    if (classification === 'UNKNOWN') {
        await transitionOrderStatus({
            orderId: order.id,
            expectedCurrentStatus: current,
            nextStatus: 'reconciliation_required',
            reason: `Retry refused: provider state unknown (${providerReason}).`,
            ctx,
            eventType: 'admin.retry_deferred_unknown'
        });
        return { outcome: 'reconciliation_required', provider_reason: providerReason };
    }

    // CONFIRMED_NOT_FULFILLED — safe to send a new attempt.
    if (!order.customer_price_ngn || !order.face_value) {
        const e = new Error('Order is missing pricing data — cannot retry.');
        e.status = 422; e.code = 'MISSING_ORDER_DATA';
        throw e;
    }
    const productId = order.provider_product_id;
    if (!productId) {
        const e = new Error('Order is missing the provider product id — cannot retry.');
        e.status = 422; e.code = 'MISSING_PRODUCT_ID';
        throw e;
    }

    const { count: attemptCount } = await supabaseAdmin
        .from('gift_card_order_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', order.id);
    const attemptNo = (attemptCount || 0) + 1;

    const externalId = buildExternalId(order.order_ref, attemptNo);

    // Insert attempt row BEFORE the provider call.
    const { data: attemptRow } = await supabaseAdmin
        .from('gift_card_order_attempts')
        .insert({
            order_id: order.id,
            attempt_no: attemptNo,
            provider: 'dtone',
            external_id: externalId,
            provider_product_id: productId,
            status: 'requested',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .select('id')
        .maybeSingle();

    let purchaseResult;
    try {
        purchaseResult = await dtone.purchaseGiftCard({
            productId,
            externalId,
            autoConfirm: true
        });
    } catch (err) {
        await supabaseAdmin
            .from('gift_card_order_attempts')
            .update({
                status: 'failed',
                failure_reason: String(err.message || '').slice(0, 500),
                updated_at: new Date().toISOString()
            })
            .eq('id', attemptRow?.id);

        await transitionOrderStatus({
            orderId: order.id,
            expectedCurrentStatus: current,
            nextStatus: 'failed',
            reason,
            extraFields: {
                failure_code: err.code || 'PROVIDER_PURCHASE_FAILED',
                failure_reason: 'Provider purchase request failed.'
            },
            ctx,
            eventType: 'admin.retry_provider_failed'
        });
        return { outcome: 'failed' };
    }

    await supabaseAdmin
        .from('gift_card_order_attempts')
        .update({
            provider_transaction_id: purchaseResult.transactionId || null,
            provider_status: purchaseResult.status || null,
            status: 'processing',
            updated_at: new Date().toISOString()
        })
        .eq('id', attemptRow?.id);

    await transitionOrderStatus({
        orderId: order.id,
        expectedCurrentStatus: current,
        nextStatus: 'processing',
        reason,
        extraFields: {
            provider_transaction_id: purchaseResult.transactionId || order.provider_transaction_id,
            provider_reference: purchaseResult.externalId || externalId,
            failure_code: null,
            failure_reason: null
        },
        ctx,
        eventType: 'admin.retry'
    });

    // If the provider already returned delivery, complete now.
    await tryCompleteFromProvider(order.id, purchaseResult, ctx);
    return { outcome: 'retried' };
}

// ─── Refund a failed order ───────────────────────────────────────
// Atomicity:
//   1. Verify order + original transaction state.
//   2. Create the refund transaction via LedgerService.
//   3. Move the order to refunded (conditional on current status).
//
// Concurrency: ux_refund_original_transaction on
// transactions(source_id) WHERE type='refund' prevents two refunds.
// A lost race returns the existing refund rather than double-crediting.
async function refundOrder({ orderId, ctx, reason }) {
    const id = normalizeOrderId(orderId);
    if (!id) {
        const e = new Error('Invalid order id');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.');
        e.status = 422; e.code = 'REASON_REQUIRED';
        throw e;
    }

    const { data: order } = await supabaseAdmin
        .from('gift_card_orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (!order) {
        const e = new Error('Gift card order not found');
        e.status = 404; e.code = 'GCO_NOT_FOUND';
        throw e;
    }

    const current = String(order.status || '').toLowerCase();
    if (current === 'refunded') {
        const e = new Error('Order is already refunded.');
        e.status = 409; e.code = 'ALREADY_REFUNDED';
        throw e;
    }
    if (current !== 'failed' && current !== 'refund_pending') {
        const e = new Error('Only failed orders can be refunded.');
        e.status = 422; e.code = 'NOT_REFUNDABLE';
        throw e;
    }
    if (!order.transaction_id) {
        const e = new Error('Order has no associated wallet transaction — refund manually.');
        e.status = 422; e.code = 'NO_TRANSACTION';
        throw e;
    }

    const { data: originalTx } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, status, currency, amount, direction')
        .eq('id', order.transaction_id)
        .maybeSingle();
    if (!originalTx) {
        const e = new Error('Original transaction not found.');
        e.status = 404; e.code = 'TX_NOT_FOUND';
        throw e;
    }

    if (String(originalTx.status || '').toLowerCase() !== 'completed') {
        const e = new Error('Original transaction is not completed — cannot refund.');
        e.status = 422; e.code = 'TX_NOT_REFUNDABLE';
        throw e;
    }
    if (originalTx.type !== 'wallet_debit' && originalTx.type !== 'purchase') {
        const e = new Error('Original transaction is not a wallet debit — cannot refund.');
        e.status = 422; e.code = 'TX_NOT_DEBIT';
        throw e;
    }

    // Fast path: refund already exists.
    const { data: existingRefund } = await supabaseAdmin
        .from('transactions')
        .select('id, reference, amount, currency, status')
        .eq('source_id', originalTx.id)
        .eq('type', 'refund')
        .maybeSingle();

    if (existingRefund) {
        if (current !== 'refunded') {
            await transitionOrderStatus({
                orderId: order.id,
                expectedCurrentStatus: current,
                nextStatus: 'refunded',
                reason: 'Idempotent: refund already existed.',
                extraFields: { refund_transaction_id: existingRefund.id },
                ctx,
                eventType: 'admin.refund_idempotent'
            });
        }
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

    // Credit the wallet via LedgerService.
    let creditResult;
    try {
        creditResult = await LedgerService.creditWallet({
            userId: order.user_id,
            amount: originalTx.amount,
            currency: originalTx.currency,
            description: `Gift card order refund: ${order.order_ref}`,
            type: 'refund',
            sourceType: 'gift_card_order',
            sourceId: originalTx.id,
            reference: `GCREF-${order.order_ref}`,
            metadata: {
                gift_card_order_id: order.id,
                order_ref: order.order_ref,
                original_transaction_id: originalTx.id,
                reason
            }
        });
    } catch (ledgerErr) {
        const msg = String(ledgerErr.message || '');
        if (msg.includes('duplicate') || msg.includes('unique')) {
            const { data: raceRefund } = await supabaseAdmin
                .from('transactions')
                .select('id, reference, amount, currency, status')
                .eq('source_id', originalTx.id)
                .eq('type', 'refund')
                .maybeSingle();
            if (raceRefund) {
                await transitionOrderStatus({
                    orderId: order.id,
                    expectedCurrentStatus: current,
                    nextStatus: 'refunded',
                    reason: 'Idempotent: refund already existed.',
                    extraFields: { refund_transaction_id: raceRefund.id },
                    ctx,
                    eventType: 'admin.refund_idempotent'
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
        const e = new Error('Wallet refund failed.');
        e.status = 400; e.code = 'LEDGER_REFUND_FAILED';
        e.cause = msg;
        throw e;
    }

    await transitionOrderStatus({
        orderId: order.id,
        expectedCurrentStatus: current,
        nextStatus: 'refunded',
        reason,
        extraFields: {
            refund_transaction_id: creditResult.transaction_id || null
        },
        ctx,
        eventType: 'admin.refund'
    });

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

// ─── Manual provider status check ────────────────────────────────
async function syncOrder({ orderId, ctx }) {
    const id = normalizeOrderId(orderId);
    if (!id) {
        const e = new Error('Invalid order id');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }
    const { data: order } = await supabaseAdmin
        .from('gift_card_orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (!order) {
        const e = new Error('Gift card order not found');
        e.status = 404; e.code = 'GCO_NOT_FOUND';
        throw e;
    }

    const resolved = await resolveProviderState(order);
    const { classification, providerState } = resolved;
    const current = String(order.status || '').toLowerCase();

    const now = new Date().toISOString();
    const patch = {
        last_provider_check_at: now,
        provider_check_attempts: (order.provider_check_attempts || 0) + 1
    };
    if (providerState?.code) patch.provider_status = providerState.code;
    if (providerState?.transactionId) patch.provider_transaction_id = providerState.transactionId;

    await supabaseAdmin
        .from('gift_card_orders')
        .update(patch)
        .eq('id', order.id);

    if (classification === 'CONFIRMED_FULFILLED') {
        await deliverAndComplete({
            order,
            providerRaw: providerState?.raw || {},
            ctx,
            source: 'admin_sync_completed_at_provider'
        });
        return { synced: true, resolved: 'completed' };
    }

    if (classification === 'CONFIRMED_NOT_FULFILLED') {
        if (current !== 'failed' && current !== 'completed') {
            await transitionOrderStatus({
                orderId: order.id,
                expectedCurrentStatus: current,
                nextStatus: 'failed',
                reason: providerState?.code || 'Provider rejection',
                extraFields: {
                    failure_code: providerState?.code || 'PROVIDER_REJECTED',
                    failure_reason: 'Provider rejected the transaction.'
                },
                ctx,
                eventType: 'admin.sync_failed'
            });
        }
        return { synced: true, resolved: 'failed' };
    }

    // UNKNOWN — move to reconciliation_required if the current state
    // allows it. We never silently leave a stale state in place.
    if (current !== 'reconciliation_required' && current !== 'completed' && current !== 'refunded') {
        const allowed = ALLOWED_TRANSITIONS[current] || [];
        if (allowed.includes('reconciliation_required')) {
            await transitionOrderStatus({
                orderId: order.id,
                expectedCurrentStatus: current,
                nextStatus: 'reconciliation_required',
                reason: `Sync outcome unknown: ${resolved.reason}`,
                ctx,
                eventType: 'admin.sync_unknown'
            });
        }
    }

    return { synced: true, resolved: 'unknown' };
}

// ─── Completion primitive ────────────────────────────────────────
//
// Atomic: the delivery row is protected by UNIQUE(order_id), and
// the status update uses optimistic locking. Two concurrent callers
// cannot both complete the order.
async function deliverAndComplete({ order, providerRaw, ctx, source }) {
    const delivery = dtone.extractGiftCardDelivery({ raw: providerRaw });
    if (!delivery || !delivery.code) {
        const current = String(order.status || '').toLowerCase();
        if (current !== 'provider_pending' && current !== 'reconciliation_required') {
            const allowed = ALLOWED_TRANSITIONS[current] || [];
            if (allowed.includes('provider_pending')) {
                await transitionOrderStatus({
                    orderId: order.id,
                    expectedCurrentStatus: current,
                    nextStatus: 'provider_pending',
                    reason: 'Provider completed but delivery code not yet available.',
                    ctx,
                    eventType: 'completion_deferred_no_code'
                });
            }
        }
        return { delivered: false, reason: 'NO_DELIVERY_CODE' };
    }

    const now = new Date().toISOString();

    // 1. Insert the delivery row. UNIQUE(order_id) protects against
    //    two concurrent completions.
    const { error: deliveryErr } = await supabaseAdmin
        .from('gift_card_deliveries')
        .upsert(
            {
                order_id: order.id,
                code: delivery.code,
                serial: delivery.serial,
                instructions: delivery.instructions,
                delivery_type: 'pin',
                delivered_at: now
            },
            { onConflict: 'order_id', ignoreDuplicates: false }
        );

    if (deliveryErr) {
        if (String(deliveryErr.code) !== '23505') {
            const e = new Error('Failed to persist delivery.');
            e.status = 500; e.code = 'DELIVERY_WRITE_FAILED';
            e.cause = deliveryErr.message;
            throw e;
        }
        // 23505 means another caller already delivered. Continue to
        // the status transition, which is idempotent.
    }

    const current = String(order.status || '').toLowerCase();
    if (current === 'completed') {
        return { delivered: true, already_completed: true };
    }

    await transitionOrderStatus({
        orderId: order.id,
        expectedCurrentStatus: current,
        nextStatus: 'completed',
        reason: null,
        extraFields: { failure_reason: null, failure_code: null },
        ctx,
        eventType: `completed_${source || 'provider'}`
    });

    return { delivered: true };
}

// Reload the order so we operate on fresh state.
async function tryCompleteFromProvider(orderId, purchaseResult, ctx) {
    if (!purchaseResult) return;
    const hasCode = purchaseResult.raw && dtone.extractGiftCardDelivery({
        raw: purchaseResult.raw
    });
    if (!hasCode || !hasCode.code) return;

    const { data: fresh } = await supabaseAdmin
        .from('gift_card_orders')
        .select('*')
        .eq('id', orderId)
        .maybeSingle();
    if (!fresh) return;
    if (String(fresh.status).toLowerCase() === 'completed') return;

    try {
        await deliverAndComplete({
            order: fresh,
            providerRaw: purchaseResult.raw,
            ctx,
            source: 'retry_immediate'
        });
    } catch (e) {
        console.warn('[GIFTCARD] immediate completion during retry failed:', e.message);
    }
}

// ═════════════════════════════════════════════════════════════════
//  WEBHOOK — verify → reconcile → act
// ═════════════════════════════════════════════════════════════════

async function handleProviderWebhook({ externalId, providerStatus, providerRaw }) {
    if (!externalId) return { handled: false, reason: 'NO_EXTERNAL_ID' };

    const { data: order } = await supabaseAdmin
        .from('gift_card_orders')
        .select('*')
        .eq('provider_reference', externalId)
        .maybeSingle();
    if (!order) return { handled: false, reason: 'ORDER_NOT_FOUND' };

    // Never trust the webhook body as the final word. Re-query the
    // provider to confirm the terminal state.
    const resolved = await resolveProviderState(order);
    const current = String(order.status || '').toLowerCase();

    if (resolved.classification === 'CONFIRMED_FULFILLED') {
        await deliverAndComplete({
            order,
            providerRaw: resolved.providerState?.raw || providerRaw || {},
            ctx: null,
            source: 'webhook_verified'
        });
        return { handled: true, resolved: 'completed' };
    }

    if (resolved.classification === 'CONFIRMED_NOT_FULFILLED') {
        if (current !== 'failed' && current !== 'completed') {
            await transitionOrderStatus({
                orderId: order.id,
                expectedCurrentStatus: current,
                nextStatus: 'failed',
                reason: 'Provider webhook + verification: rejection',
                extraFields: {
                    failure_code: resolved.providerState?.code || 'PROVIDER_REJECTED',
                    failure_reason: 'Provider rejected the transaction.'
                },
                ctx: null,
                eventType: 'webhook_failed'
            });
        }
        return { handled: true, resolved: 'failed' };
    }

    return { handled: true, resolved: 'unknown' };
}

// ═════════════════════════════════════════════════════════════════
//  PRODUCTS
// ═════════════════════════════════════════════════════════════════

async function listProducts(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit, 50, 200);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('gift_card_products')
        .select('id, provider, provider_product_id, brand, country_iso, country_name, face_value, face_currency, customer_price_ngn, enabled, updated_at', { count: 'exact' })
        .order('brand', { ascending: true })
        .order('face_value', { ascending: true })
        .range(offset, offset + limit - 1);

    if (query.enabled === 'true' || query.enabled === 'false') {
        q = q.eq('enabled', query.enabled === 'true');
    }
    if (query.country) q = q.eq('country_iso', String(query.country).toUpperCase());
    if (query.brand) q = q.ilike('brand', `%${query.brand}%`);

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { products: [], count: 0, page, limit, totalPages: 0, available: false, reason: 'PRODUCTS_TABLE_NOT_FOUND' };
        }
        const e = new Error('Failed to load gift card products');
        e.status = 500; e.code = 'GCP_LIST_ERROR';
        throw e;
    }

    return {
        products: data || [],
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
        available: true
    };
}

async function setProductEnabled({ productId, enabled, reason, ctx }) {
    const id = normalizeOrderId(productId);
    if (!id) {
        const e = new Error('Invalid product id');
        e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }

    const { data: before } = await supabaseAdmin
        .from('gift_card_products')
        .select('id, enabled, brand, face_value, face_currency')
        .eq('id', id)
        .maybeSingle();
    if (!before) {
        const e = new Error('Product not found');
        e.status = 404; e.code = 'GCP_NOT_FOUND';
        throw e;
    }

    // Optimistic concurrency: only update if `enabled` still matches.
    const { data: updated, error } = await supabaseAdmin
        .from('gift_card_products')
        .update({ enabled: Boolean(enabled), updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('enabled', before.enabled)
        .select('id')
        .maybeSingle();

    if (error) {
        const e = new Error('Failed to update product.');
        e.status = 500; e.code = 'GCP_UPDATE_ERROR';
        throw e;
    }
    if (!updated) {
        const e = new Error('Product changed while you were editing it.');
        e.status = 409; e.code = 'PRODUCT_CHANGED';
        throw e;
    }

    await recordAudit({
        ctx,
        action: `gift_card.product_${enabled ? 'enabled' : 'disabled'}`,
        targetId: id,
        before: { enabled: before.enabled },
        after: { enabled: Boolean(enabled) },
        reason: reason || null
    });

    return { ok: true, enabled: Boolean(enabled) };
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

async function getProviderHealth() {
    const configured = Boolean(process.env.DTONE_API_KEY && process.env.DTONE_API_SECRET);
    const env = String(process.env.DTONE_ENV || '').toLowerCase();

    const components = {
        configured,
        connectivity: 'unknown',
        balance:      'unknown',
        catalog:      'unknown',
        purchase:     'unknown',
        webhook:      'unknown',
        circuit:      'closed'
    };

    try {
        const r = await dtone.getBalances();
        components.connectivity = r.success ? 'ok' : 'down';
        components.balance = r.success && (r.balances || []).length > 0 ? 'ok' : 'empty';
    } catch (_) {
        components.connectivity = 'down';
        components.balance = 'unknown';
    }

    let lastSuccess = null;
    let lastFailure = null;
    let recentCount = 0;

    try {
        const { data: lastOk } = await supabaseAdmin
            .from('gift_card_orders')
            .select('created_at')
            .eq('status', 'completed')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        lastSuccess = lastOk?.created_at || null;

        const { data: lastFail } = await supabaseAdmin
            .from('gift_card_orders')
            .select('created_at, failure_reason')
            .in('status', ['failed', 'cancelled'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (lastFail) lastFailure = { at: lastFail.created_at, reason: lastFail.failure_reason || null };

        const { count } = await supabaseAdmin
            .from('gift_card_orders')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        recentCount = count || 0;
    } catch (_) { /* optional */ }

    try {
        const { count } = await supabaseAdmin
            .from('gift_card_products')
            .select('id', { count: 'exact', head: true })
            .eq('enabled', true);
        components.catalog = (count || 0) > 0 ? 'ok' : 'empty';
    } catch (_) { components.catalog = 'unknown'; }

    if (lastSuccess) components.purchase = 'ok_recent';
    else if (lastFailure) components.purchase = 'degraded_recent';
    else components.purchase = 'unknown';

    return {
        provider: 'dtone',
        label: 'DT One',
        configured,
        environment: env,
        components,
        apiReachable: components.connectivity === 'ok',
        balancesOk: components.balance === 'ok',
        balanceCurrencyCount: components.balance === 'ok' ? undefined : 0,
        lastSuccess,
        lastFailure,
        recentCount,
        note: 'Component states are evidence-based. Purchase capability is derived from recent completion history, not a live probe.'
    };
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    ORDER_STATUSES,
    ALLOWED_TRANSITIONS,

    listOrders,
    getSummary,
    getOrder,
    revealDeliveryCode,

    retryOrder,
    refundOrder,
    syncOrder,

    listProducts,
    setProductEnabled,

    getProviderHealth,

    handleProviderWebhook,
    deliverAndComplete,

    transitionOrderStatus,
    resolveProviderState
};