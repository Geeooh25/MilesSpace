// services/esimAdminService.js
// ─────────────────────────────────────────────────────────────────
// Admin eSIM — service layer.
//
// The customer eSIM flow already writes to `esim_transactions` from
// routes/esimRoutes.js. This module reads that table and provides
// admin-only operations on top of it:
//
//   • stats / list / detail
//   • sync       — re-query DT One, update local row
//   • refund     — atomic via LedgerService.refundTransaction
//   • review     — move to manual_review
//
// Plan / provider / country CRUD is NOT implemented here, because
// the DT One catalogue is remote. There is no local plan table to
// write to. When you add one, extend this service.
//
// Money is strings from Postgres NUMERIC.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const dtone = require('./dtoneService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const PENDING_STATUSES = new Set([
    'pending', 'processing', 'delivery_pending', 'manual_review'
]);
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'reversed']);

const ALLOWED_TRANSITIONS = Object.freeze({
    pending:            ['processing', 'failed', 'cancelled', 'manual_review'],
    processing:         ['completed', 'failed', 'cancelled', 'manual_review'],
    delivery_pending:   ['completed', 'failed', 'manual_review'],
    manual_review:      ['processing', 'completed', 'failed', 'cancelled', 'refunded'],
    completed:          ['refunded'],
    failed:             ['refunded', 'manual_review'],
    cancelled:          ['refunded'],
    reversed:           ['refunded'],
    refunded:           []
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
function mask(value) {
    if (!value) return null;
    const s = String(value);
    if (s.length <= 4) return '••••';
    return '••••' + s.slice(-4);
}

async function recordAudit({ ctx, action, targetId, before, after, reason }) {
    const { error } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert({
            admin_id:    ctx?.adminId || null,
            admin_email: ctx?.adminEmail || null,
            action,
            target_type: 'esim_order',
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
        console.error('[ESIM ADMIN] audit insert failed:', error.message);
        const e = new Error('Audit logging failed.');
        e.status = 500; e.code = 'AUDIT_WRITE_FAILED';
        throw e;
    }
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

function shapeOrder(raw, profile, { includeSensitive = false } = {}) {
    const o = {
        id: raw.id,
        reference: raw.reference,
        status: raw.status,
        status_badge: statusBadge(raw.status),
        delivery_status: raw.delivery_status || null,
        email_status: raw.email_status || null,
        refund_status: raw.refund_status || null,
        refunded: Boolean(raw.refunded),
        provider: 'dtone',
        provider_transaction_id: raw.provider_transaction_id || null,
        dtone_external_id: raw.dtone_external_id || null,
        provider_status: raw.provider_status || null,

        user_id: raw.user_id,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : { id: raw.user_id, username: 'Unknown', email: null },

        country_iso3: raw.country_iso3 || null,
        country_name: raw.country_name || null,
        country_flag: raw.country_flag || null,
        destination_type: raw.destination_type || 'country',
        product_id: raw.product_id || null,
        plan_name: raw.plan_name || null,
        data_display: raw.data_display || null,
        validity_days: raw.validity_days ?? null,

        wholesale_usd: raw.wholesale_usd ?? null,
        price_usd: raw.price_usd ?? null,
        fee_usd: raw.fee_usd ?? null,
        total_usd: raw.total_usd ?? null,
        exchange_rate: raw.exchange_rate ?? null,
        price_ngn: raw.price_ngn ?? null,
        debit_currency: raw.debit_currency || null,
        debit_amount: raw.debit_amount ?? null,

        ledger_transaction_id: raw.ledger_transaction_id || null,
        refund_transaction_id: raw.refund_transaction_id || null,
        idempotency_key: raw.idempotency_key || null,

        iccid_masked: mask(raw.iccid),
        has_qr: Boolean(raw.qr_code_url),
        has_activation: Boolean(raw.lpa_string || raw.activation_code),

        failure_reason: raw.failure_reason || null,
        delivery_attempts: raw.delivery_attempts ?? 0,
        email_attempts: raw.email_attempts ?? 0,
        reconciliation_attempts: raw.reconciliation_attempts ?? 0,

        created_at: raw.created_at,
        updated_at: raw.updated_at || null,
        completed_at: raw.completed_at || null,
        refunded_at: raw.refunded_at || null
    };

    if (includeSensitive) {
        o.iccid = raw.iccid || null;
        o.lpa_string = raw.lpa_string || null;
        o.activation_code = raw.activation_code || null;
        o.smdp_address = raw.smdp_address || null;
        o.matching_id = raw.matching_id || null;
        o.serial_number = raw.serial_number || null;
        o.qr_code_url = raw.qr_code_url || null;
        o.installation_url = raw.installation_url || null;
        o.apple_universal_link = raw.apple_universal_link || null;
        o.android_universal_link = raw.android_universal_link || null;
        o.instructions = raw.instructions || null;
    }

    return o;
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
function startOfWatMonth() {
    const OFFSET_MS = 60 * 60 * 1000;
    const now = new Date();
    const local = new Date(now.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear(), m = local.getUTCMonth();
    return new Date(Date.UTC(y, m, 1, 0, 0, 0) - OFFSET_MS).toISOString();
}

async function getStats(query = {}) {
    const fromIso = isoDate(query.from) || startOfWatDay();
    const toIso = isoDate(query.to) || new Date().toISOString();

    // Try RPC first.
    const rpc = await supabaseAdmin.rpc('esim_admin_stats', { p_from: fromIso, p_to: toIso });
    if (!rpc.error && rpc.data) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        return {
            total: Number(row.total || 0),
            pending: Number(row.pending || 0),
            processing: Number(row.processing || 0),
            completed: Number(row.completed || 0),
            failed: Number(row.failed || 0),
            refunded: Number(row.refunded || 0),
            manual_review: Number(row.manual_review || 0),
            delivery_pending: Number(row.delivery_pending || 0),
            today_orders: Number(row.today_orders || 0),
            today_revenue_usd: String(row.today_revenue_usd || '0.00'),
            today_revenue_ngn: String(row.today_revenue_ngn || '0.00'),
            today_profit_usd: String(row.today_profit_usd || '0.00'),
            monthly_orders: Number(row.monthly_orders || 0),
            monthly_revenue_usd: String(row.monthly_revenue_usd || '0.00'),
            monthly_profit_usd: String(row.monthly_profit_usd || '0.00'),
            summaryAvailable: true,
            from: fromIso,
            to: toIso
        };
    }

    if (rpc.error?.code !== '42883' && rpc.error?.code !== 'PGRST202') {
        const e = new Error('Failed to aggregate eSIM stats');
        e.status = 500; e.code = 'ESIM_STATS_ERROR';
        e.cause = rpc.error.message;
        throw e;
    }

    // Fallback: bounded read + Node aggregation. Admin scale only.
    const { data, error } = await supabaseAdmin
        .from('esim_transactions')
        .select('id, status, total_usd, wholesale_usd, price_usd, created_at')
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .limit(5000);

    if (error) {
        if (error.code === '42P01') {
            return emptyStats(fromIso, toIso, 'ESIM_TABLE_NOT_FOUND');
        }
        const e = new Error('Failed to read eSIM transactions');
        e.status = 500; e.code = 'ESIM_STATS_ERROR';
        throw e;
    }

    const rows = data || [];
    const todayStart = startOfWatDay();
    const monthStart = startOfWatMonth();

    const sumUsd = (arr) => arr.reduce((a, r) => a + Number(r.total_usd || 0), 0);
    const profitOf = (arr) => arr.reduce((a, r) =>
        a + (Number(r.price_usd || 0) - Number(r.wholesale_usd || 0)), 0);

    const completed = rows.filter(r => r.status === 'completed');
    const today = rows.filter(r => new Date(r.created_at).toISOString() >= todayStart);
    const month = rows.filter(r => new Date(r.created_at).toISOString() >= monthStart);

    return {
        total: rows.length,
        pending: rows.filter(r => r.status === 'pending').length,
        processing: rows.filter(r => r.status === 'processing').length,
        completed: completed.length,
        failed: rows.filter(r => r.status === 'failed').length,
        refunded: rows.filter(r => r.status === 'refunded').length,
        manual_review: rows.filter(r => r.status === 'manual_review').length,
        delivery_pending: rows.filter(r => r.delivery_status === 'pending').length,
        today_orders: today.length,
        today_revenue_usd: sumUsd(today.filter(r => r.status === 'completed')).toFixed(2),
        today_revenue_ngn: '0.00',
        today_profit_usd: profitOf(today.filter(r => r.status === 'completed')).toFixed(2),
        monthly_orders: month.length,
        monthly_revenue_usd: sumUsd(month.filter(r => r.status === 'completed')).toFixed(2),
        monthly_profit_usd: profitOf(month.filter(r => r.status === 'completed')).toFixed(2),
        summaryAvailable: true,
        from: fromIso,
        to: toIso
    };
}

function emptyStats(fromIso, toIso, reason) {
    return {
        total: 0, pending: 0, processing: 0, completed: 0, failed: 0,
        refunded: 0, manual_review: 0, delivery_pending: 0,
        today_orders: 0, today_revenue_usd: '0.00', today_revenue_ngn: '0.00', today_profit_usd: '0.00',
        monthly_orders: 0, monthly_revenue_usd: '0.00', monthly_profit_usd: '0.00',
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
        .from('esim_transactions')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    const status = String(query.status || '').toLowerCase();
    if (status && status !== 'all') q = q.eq('status', status);

    if (query.delivery_status && query.delivery_status !== 'all') {
        q = q.eq('delivery_status', query.delivery_status);
    }
    if (query.country) q = q.eq('country_iso3', String(query.country).toUpperCase());
    if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);

    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);

    if (query.search) {
        const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
        const orParts = [
            `reference.ilike.%${safe}%`,
            `provider_transaction_id.ilike.%${safe}%`,
            `dtone_external_id.ilike.%${safe}%`,
            `iccid.ilike.%${safe}%`,
            `plan_name.ilike.%${safe}%`
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
            return { orders: [], count: 0, page, limit, totalPages: 0, hasMore: false, available: false, reason: 'ESIM_TABLE_NOT_FOUND' };
        }
        const e = new Error('Failed to load eSIM orders');
        e.status = 500; e.code = 'ESIM_LIST_ERROR';
        e.cause = error.message;
        throw e;
    }

    const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);

    const orders = (data || []).map(o =>
        shapeOrder(o, profilesById[o.user_id], { includeSensitive: false })
    );

    return {
        orders,
        count: count || 0,
        page, limit,
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
        .from('esim_transactions')
        .select('*')
        .eq('id', id)
        .maybeSingle();

    if (error) {
        const e = new Error('Failed to load eSIM order');
        e.status = 500; e.code = 'ESIM_DETAIL_ERROR';
        throw e;
    }
    if (!raw) {
        const e = new Error('eSIM order not found');
        e.status = 404; e.code = 'ESIM_NOT_FOUND';
        throw e;
    }

    let user = null;
    if (raw.user_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, status, created_at')
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

    const order = shapeOrder(raw, user, { includeSensitive: revealSensitive });

    return {
        order,
        user,
        transaction,
        refund_transaction: refundTransaction,
        ledger_entries: ledgerEntries,
        timeline: buildTimeline(raw)
    };
}

function buildTimeline(raw) {
    const events = [];
    if (raw.created_at)   events.push({ at: raw.created_at,  kind: 'order_created', label: 'Order created' });
    if (raw.updated_at && raw.updated_at !== raw.created_at) {
        events.push({ at: raw.updated_at, kind: 'updated', label: 'Order updated' });
    }
    if (raw.delivery_status === 'ready' && raw.completed_at) {
        events.push({ at: raw.completed_at, kind: 'delivered', label: 'eSIM delivery ready' });
    } else if (raw.completed_at) {
        events.push({ at: raw.completed_at, kind: 'completed', label: 'Order completed' });
    }
    if (raw.failed_at)   events.push({ at: raw.failed_at,   kind: 'failed',   label: `Order failed${raw.failure_reason ? ' — ' + raw.failure_reason : ''}` });
    if (raw.refunded_at) events.push({ at: raw.refunded_at, kind: 'refunded', label: 'Refund applied' });
    events.sort((a, b) => new Date(a.at) - new Date(b.at));
    return events;
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER STATE — three-state classification
// ═════════════════════════════════════════════════════════════════

async function resolveProviderState(order) {
    if (!order.provider_transaction_id) {
        return { classification: 'UNKNOWN', reason: 'NO_PROVIDER_TRANSACTION_ID' };
    }
    try {
        const result = await dtone.queryTransaction(order.provider_transaction_id);
        const status = String(result.status || '').toLowerCase();

        if (status === 'completed') {
            return {
                classification: 'CONFIRMED_FULFILLED',
                providerStatus: result.providerStatus || 'COMPLETED',
                raw: result.raw || null
            };
        }
        if (status === 'failed' || status === 'cancelled' || status === 'reversed') {
            return {
                classification: 'CONFIRMED_NOT_FULFILLED',
                providerStatus: result.providerStatus || status.toUpperCase(),
                error: result.errorMessage || null,
                raw: result.raw || null
            };
        }
        return {
            classification: 'UNKNOWN',
            providerStatus: result.providerStatus || 'processing',
            raw: result.raw || null
        };
    } catch (e) {
        return { classification: 'UNKNOWN', reason: `PROVIDER_QUERY_FAILED: ${e.message}` };
    }
}

// ═════════════════════════════════════════════════════════════════
//  STATE WRITERS
// ═════════════════════════════════════════════════════════════════

async function loadEsimById(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('esim_transactions')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) { const e = new Error('Failed to load eSIM order'); e.status = 500; e.code = 'ESIM_DETAIL_ERROR'; throw e; }
    if (!data) { const e = new Error('eSIM order not found'); e.status = 404; e.code = 'ESIM_NOT_FOUND'; throw e; }
    return data;
}

async function transitionEsim({ orderId, expectedCurrentStatus, nextStatus, extraFields = {}, ctx, eventType, reason = null }) {
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
    if (next_ === 'completed') patch.completed_at = now;
    if (next_ === 'refunded')  patch.refunded_at  = now;

    const { data: updated, error } = await supabaseAdmin
        .from('esim_transactions')
        .update(patch)
        .eq('id', orderId)
        .eq('status', current)
        .select('*')
        .maybeSingle();

    if (error) {
        const e = new Error('Failed to update eSIM order');
        e.status = 500; e.code = 'ESIM_UPDATE_ERROR';
        e.cause = error.message;
        throw e;
    }
    if (!updated) {
        const e = new Error('Order changed while you were editing it. Reload and try again.');
        e.status = 409; e.code = 'ORDER_STATE_CHANGED';
        e.expected_status = current;
        throw e;
    }

    await recordAudit({
        ctx,
        action: `esim.${eventType || next_}`,
        targetId: orderId,
        before: { status: current },
        after: { status: next_ },
        reason
    });

    return updated;
}

// ═════════════════════════════════════════════════════════════════
//  SYNC
// ═════════════════════════════════════════════════════════════════

async function syncOrder({ orderId, ctx }) {
    const raw = await loadEsimById(orderId);
    const current = String(raw.status || '').toLowerCase();

    const provider = await resolveProviderState(raw);

    // Always record the check.
    const now = new Date().toISOString();
    await supabaseAdmin
        .from('esim_transactions')
        .update({
            last_reconciled_at: now,
            reconciliation_attempts: (raw.reconciliation_attempts || 0) + 1,
            provider_status: provider.providerStatus || raw.provider_status,
            provider_response: provider.raw || raw.provider_response
        })
        .eq('id', raw.id);

    if (provider.classification === 'CONFIRMED_FULFILLED') {
        if (current !== 'completed') {
            await transitionEsim({
                orderId: raw.id,
                expectedCurrentStatus: current,
                nextStatus: 'completed',
                extraFields: {
                    provider_status: provider.providerStatus || 'COMPLETED',
                    failure_reason: null
                },
                ctx, eventType: 'sync_completed',
                reason: 'Provider confirmed completion'
            });
        }
        return { synced: true, resolved: 'completed' };
    }

    if (provider.classification === 'CONFIRMED_NOT_FULFILLED') {
        if (current !== 'failed' && current !== 'refunded') {
            await transitionEsim({
                orderId: raw.id,
                expectedCurrentStatus: current,
                nextStatus: 'failed',
                extraFields: {
                    failure_reason: provider.error || 'Provider rejected the transaction',
                    provider_status: provider.providerStatus || 'FAILED'
                },
                ctx, eventType: 'sync_failed',
                reason: provider.error || 'Provider rejection'
            });
        }
        return { synced: true, resolved: 'failed' };
    }

    // UNKNOWN — leave status; the admin can move to review manually.
    return { synced: true, resolved: 'unknown', reason: provider.reason || null };
}

// ═════════════════════════════════════════════════════════════════
//  REFUND
// ═════════════════════════════════════════════════════════════════

async function refundOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const raw = await loadEsimById(orderId);
    const current = String(raw.status || '').toLowerCase();

    if (current === 'refunded' || raw.refunded) {
        const e = new Error('Order is already refunded.'); e.status = 409; e.code = 'ALREADY_REFUNDED'; throw e;
    }
    if (current !== 'failed' && current !== 'cancelled' && current !== 'manual_review') {
        const e = new Error('Only failed, cancelled, or manual-review orders can be refunded.');
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

    // Idempotency fast path.
    const { data: existingRefund } = await supabaseAdmin
        .from('transactions')
        .select('id, reference, amount, currency')
        .eq('source_id', originalTx.id)
        .eq('type', 'refund')
        .maybeSingle();

    if (existingRefund) {
        if (current !== 'refunded') {
            await transitionEsim({
                orderId: raw.id,
                expectedCurrentStatus: current,
                nextStatus: 'refunded',
                extraFields: {
                    refunded: true,
                    refund_status: 'completed',
                    refund_transaction_id: existingRefund.id
                },
                ctx, eventType: 'refund_idempotent',
                reason: 'Idempotent: refund already existed'
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

    let credit;
    try {
        credit = await LedgerService.creditWallet({
            userId: raw.user_id,
            amount: originalTx.amount,
            currency: originalTx.currency,
            description: `eSIM refund — ${raw.reference}`,
            type: 'refund',
            sourceType: 'esim_order',
            sourceId: originalTx.id,
            reference: `ESIMREF-${raw.reference}`,
            metadata: { esim_order_id: raw.id, reason }
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
                await transitionEsim({
                    orderId: raw.id,
                    expectedCurrentStatus: current,
                    nextStatus: 'refunded',
                    extraFields: {
                        refunded: true,
                        refund_status: 'completed',
                        refund_transaction_id: raceRefund.id
                    },
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

    try {
        await transitionEsim({
            orderId: raw.id,
            expectedCurrentStatus: current,
            nextStatus: 'refunded',
            extraFields: {
                refunded: true,
                refund_status: 'completed',
                refund_transaction_id: credit.transaction_id || null
            },
            ctx, eventType: 'refund', reason
        });
    } catch (postErr) {
        await supabaseAdmin
            .from('esim_transactions')
            .update({
                status: 'manual_review',
                refund_status: 'completed',
                failure_reason: 'Wallet refund succeeded but order status update failed.',
                updated_at: new Date().toISOString()
            })
            .eq('id', raw.id)
            .neq('status', 'refunded');

        const e = new Error('Wallet refund succeeded but order could not be finalized. Marked for manual review.');
        e.status = 500; e.code = 'REFUND_POST_CREDIT_FAILED';
        throw e;
    }

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
//  MOVE TO MANUAL REVIEW
// ═════════════════════════════════════════════════════════════════

async function reviewOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const raw = await loadEsimById(orderId);
    const current = String(raw.status || '').toLowerCase();

    if (current === 'completed' || current === 'refunded') {
        const e = new Error(`Cannot move a ${current} order to manual review.`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION'; throw e;
    }
    if (current === 'manual_review') {
        return { reviewed: true, already: true };
    }

    await transitionEsim({
        orderId: raw.id,
        expectedCurrentStatus: current,
        nextStatus: 'manual_review',
        extraFields: { failure_reason: String(reason).slice(0, 500) },
        ctx, eventType: 'manual_review', reason
    });

    return { reviewed: true };
}

// ═════════════════════════════════════════════════════════════════
//  SENSITIVE DATA REVEAL
// ═════════════════════════════════════════════════════════════════

async function revealActivation({ orderId, ctx }) {
    const raw = await loadEsimById(orderId);
    const current = String(raw.status || '').toLowerCase();

    if (current !== 'completed') {
        const e = new Error('Activation data is only available for completed orders.');
        e.status = 422; e.code = 'NOT_COMPLETED'; throw e;
    }

    await recordAudit({
        ctx,
        action: 'esim.reveal_activation',
        targetId: orderId,
        before: null,
        after: null,
        reason: 'Admin revealed activation details'
    });

    return {
        iccid: raw.iccid || null,
        lpa_string: raw.lpa_string || null,
        activation_code: raw.activation_code || null,
        smdp_address: raw.smdp_address || null,
        matching_id: raw.matching_id || null,
        serial_number: raw.serial_number || null,
        qr_code_url: raw.qr_code_url || null,
        installation_url: raw.installation_url || null,
        apple_universal_link: raw.apple_universal_link || null,
        android_universal_link: raw.android_universal_link || null,
        instructions: raw.instructions || null
    };
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

async function getProviderHealth() {
    const configured = Boolean(process.env.DTONE_API_KEY && process.env.DTONE_API_SECRET);

    let live = { configured, reachable: false, lastError: null, latencyMs: null };
    const startedAt = Date.now();
    try {
        const r = await dtone.getBalances();
        live.reachable = !!r.success;
        live.lastError = r.success ? null : (r.error || 'Unknown');
        live.latencyMs = Date.now() - startedAt;
    } catch (e) {
        live.lastError = e.message;
    }

    let lastSuccess = null;
    let lastFailure = null;
    let recentCount = 0;

    try {
        const { data: ok } = await supabaseAdmin
            .from('esim_transactions')
            .select('completed_at')
            .eq('status', 'completed')
            .order('completed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        lastSuccess = ok?.completed_at || null;

        const { data: bad } = await supabaseAdmin
            .from('esim_transactions')
            .select('failed_at, failure_reason')
            .eq('status', 'failed')
            .order('failed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (bad) lastFailure = { at: bad.failed_at, reason: bad.failure_reason || null };

        const { count } = await supabaseAdmin
            .from('esim_transactions')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        recentCount = count || 0;
    } catch (_) { /* optional */ }

    const status = !configured ? 'not_configured'
        : !live.reachable ? 'unreachable'
        : lastFailure && (!lastSuccess || new Date(lastFailure.at) > new Date(lastSuccess))
            ? 'degraded'
            : 'operational';

    return {
        provider: 'dtone',
        label: 'DT One',
        status,
        configured,
        reachable: live.reachable,
        environment: process.env.DTONE_ENV || null,
        latencyMs: live.latencyMs,
        lastSuccess,
        lastFailure,
        recentCount,
        lastError: live.lastError
    };
}

async function healthCheckProvider({ ctx }) {
    const startedAt = Date.now();
    let live;
    try { live = await dtone.getBalances(); }
    catch (e) { live = { success: false, error: e.message }; }

    const result = {
        configured: Boolean(process.env.DTONE_API_KEY && process.env.DTONE_API_SECRET),
        reachable: !!live.success,
        latencyMs: Date.now() - startedAt,
        lastError: live.success ? null : (live.error || null)
    };

    await recordAudit({
        ctx, action: 'esim.health_check',
        targetId: 'dtone', before: null, after: result, reason: null
    });

    return result;
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    ALLOWED_TRANSITIONS,

    getStats,
    listOrders,
    getOrder,

    syncOrder,
    refundOrder,
    reviewOrder,
    revealActivation,

    getProviderHealth,
    healthCheckProvider
};