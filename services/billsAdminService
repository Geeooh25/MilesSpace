// services/billsAdminService.js
// ─────────────────────────────────────────────────────────────────
// Admin Bills & Utilities — service layer.
//
// This module manages bill payments where service_type is either
// 'electricity' or 'tv'. Airtime and Data belong to the Airtime
// admin module and are NOT touched here.
//
// Everything reads/writes bill_payment_transactions. The provider
// is VTpass, called through services/vtpassService.js. Wallet
// mutations go through LedgerService.
//
// Behaviours:
//   • listOrders / getOrder / getStats read only.
//   • syncOrder  — re-queries VTpass and updates local state.
//   • retryOrder — provider state checked first; only CONFIRMED_
//                  NOT_FULFILLED triggers a new purchase request.
//   • refundOrder — atomic via LedgerService.refundTransaction,
//                   guarded by a unique index in the migration.
//   • reviewOrder — moves an ambiguous order to manual_review.
//
// Money is strings from Postgres NUMERIC.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const vtpass = require('./vtpassService');

const BILL_CATEGORIES = new Set(['electricity', 'tv']);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PENDING_STATUSES = new Set([
    'pending', 'processing', 'manual_review', 'provider_unknown'
]);
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'reversed']);

const ALLOWED_TRANSITIONS = Object.freeze({
    pending:             ['processing', 'cancelled', 'failed', 'manual_review'],
    processing:          ['completed', 'failed', 'manual_review'],
    provider_unknown:    ['processing', 'completed', 'failed', 'manual_review'],
    manual_review:       ['processing', 'completed', 'failed', 'cancelled', 'refunded'],
    completed:           ['refunded'],
    failed:              ['refunded', 'manual_review'],
    cancelled:           ['refunded'],
    reversed:            ['refunded'],
    refunded:            []
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
    if (!value) return '—';
    const s = String(value);
    if (s.length <= 4) return s;
    return `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}
function categoryLabel(serviceType) {
    if (serviceType === 'electricity') return 'Electricity';
    if (serviceType === 'tv') return 'Cable TV';
    return serviceType || '—';
}
function isBillCategory(serviceType) {
    return BILL_CATEGORIES.has(String(serviceType || '').toLowerCase());
}

// ─── Audit (fail-loud for financial, best-effort otherwise) ──────

async function recordAudit({ ctx, action, targetId, before, after, reason }) {
    const { error } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert({
            admin_id:    ctx?.adminId || null,
            admin_email: ctx?.adminEmail || null,
            action,
            target_type: 'bill_payment',
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
        console.error('[BILLS ADMIN] audit insert failed:', error.message);
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

// ─── Row shaping ─────────────────────────────────────────────────

function shapeOrder(raw, profile) {
    const svcType = String(raw.service_type || '').toLowerCase();
    return {
        id: raw.id,
        reference: raw.reference,
        service_type: svcType,
        category: categoryLabel(svcType),
        service_id: raw.service_id,
        provider: raw.provider || 'vtpass',
        provider_request_id: raw.provider_request_id || null,
        provider_transaction_id: raw.provider_transaction_id || null,
        provider_status: raw.provider_status || null,
        provider_code: raw.provider_code || null,
        status: raw.status,
        status_badge: statusBadge(raw.status),
        user_id: raw.user_id,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : { id: raw.user_id, username: 'Unknown', email: null },
        recipient: raw.recipient || null,
        recipient_masked: mask(raw.recipient),
        network: raw.network || null,
        variation_code: raw.variation_code || null,
        currency: raw.currency || 'NGN',
        base_amount: raw.base_amount ?? null,
        provider_amount: raw.provider_amount ?? null,
        markup_amount: raw.markup_amount ?? null,
        service_fee: raw.service_fee ?? null,
        customer_amount: raw.customer_amount ?? null,
        profit: computeProfit(raw),
        token: raw.token || null,
        units: raw.units || null,
        failure_reason: raw.failure_reason || null,
        refunded: Boolean(raw.refunded),
        refunded_at: raw.refunded_at || null,
        ledger_transaction_id: raw.ledger_transaction_id || null,
        refund_transaction_id: raw.refund_transaction_id || null,
        metadata: raw.metadata || {},
        created_at: raw.created_at,
        updated_at: raw.updated_at || null,
        completed_at: raw.completed_at || null,
        failed_at: raw.failed_at || null,
        reconciliation_attempts: raw.reconciliation_attempts ?? 0,
        last_reconciliation_at: raw.last_reconciliation_at || null
    };
}

function computeProfit(raw) {
    const customer = Number(raw.customer_amount || 0);
    const provider = Number(raw.provider_amount || 0);
    if (!Number.isFinite(customer) || !Number.isFinite(provider)) return null;
    const profit = customer - provider;
    return profit.toFixed(2);
}

// ═════════════════════════════════════════════════════════════════
//  STATS
// ═════════════════════════════════════════════════════════════════

async function getStats(query = {}) {
    const fromIso = isoDate(query.from) || startOfWatDay();
    const toIso = isoDate(query.to) || new Date().toISOString();

    // Try RPC first.
    const rpc = await supabaseAdmin.rpc('bills_admin_stats', { p_from: fromIso, p_to: toIso });
    if (!rpc.error && rpc.data) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        return {
            total: Number(row.total || 0),
            pending: Number(row.pending || 0),
            processing: Number(row.processing || 0),
            completed: Number(row.completed || 0),
            failed: Number(row.failed || 0),
            cancelled: Number(row.cancelled || 0),
            manual_review: Number(row.manual_review || 0),
            today_transactions: Number(row.today_transactions || 0),
            today_revenue: String(row.today_revenue || '0.00'),
            today_profit: String(row.today_profit || '0.00'),
            monthly_transactions: Number(row.monthly_transactions || 0),
            monthly_revenue: String(row.monthly_revenue || '0.00'),
            monthly_profit: String(row.monthly_profit || '0.00'),
            electricity_transactions: Number(row.electricity_transactions || 0),
            cable_transactions: Number(row.cable_transactions || 0),
            average_transaction_value: String(row.average_transaction_value || '0.00'),
            success_rate: Number(row.success_rate || 0),
            summaryAvailable: true,
            from: fromIso,
            to: toIso
        };
    }

    if (rpc.error?.code !== '42883' && rpc.error?.code !== 'PGRST202') {
        const e = new Error('Failed to aggregate bills stats');
        e.status = 500; e.code = 'BILLS_STATS_ERROR'; e.cause = rpc.error.message;
        throw e;
    }

    // Fallback: aggregate in Node from a bounded fetch. Admin scale only.
    let q = supabaseAdmin
        .from('bill_payment_transactions')
        .select('id, status, service_type, customer_amount, provider_amount, created_at')
        .in('service_type', ['electricity', 'tv'])
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .limit(5000);

    const { data, error } = await q;
    if (error) {
        if (error.code === '42P01') {
            return emptyStats(fromIso, toIso, 'BILL_TABLE_NOT_FOUND');
        }
        const e = new Error('Failed to read bill transactions');
        e.status = 500; e.code = 'BILLS_STATS_ERROR'; throw e;
    }

    const rows = data || [];
    const todayIso = startOfWatDay();

    const completed = rows.filter(r => r.status === 'completed');
    const today = rows.filter(r => new Date(r.created_at).toISOString() >= todayIso);
    const monthly = rows.filter(r => new Date(r.created_at).toISOString() >= startOfWatMonth());
    const sum = (arr, key) => arr.reduce((a, r) => a + Number(r[key] || 0), 0);
    const profitOf = (arr) => arr.reduce((a, r) => a + (Number(r.customer_amount || 0) - Number(r.provider_amount || 0)), 0);

    return {
        total: rows.length,
        pending: rows.filter(r => r.status === 'pending').length,
        processing: rows.filter(r => r.status === 'processing').length,
        completed: completed.length,
        failed: rows.filter(r => r.status === 'failed').length,
        cancelled: rows.filter(r => r.status === 'cancelled').length,
        manual_review: rows.filter(r => r.status === 'manual_review').length,
        today_transactions: today.length,
        today_revenue: sum(today.filter(r => r.status === 'completed'), 'customer_amount').toFixed(2),
        today_profit: profitOf(today.filter(r => r.status === 'completed')).toFixed(2),
        monthly_transactions: monthly.length,
        monthly_revenue: sum(monthly.filter(r => r.status === 'completed'), 'customer_amount').toFixed(2),
        monthly_profit: profitOf(monthly.filter(r => r.status === 'completed')).toFixed(2),
        electricity_transactions: rows.filter(r => r.service_type === 'electricity').length,
        cable_transactions: rows.filter(r => r.service_type === 'tv').length,
        average_transaction_value: rows.length ? (sum(rows, 'customer_amount') / rows.length).toFixed(2) : '0.00',
        success_rate: rows.length ? +(completed.length / rows.length * 100).toFixed(1) : 0,
        summaryAvailable: true,
        from: fromIso,
        to: toIso
    };
}

function emptyStats(fromIso, toIso, reason) {
    return {
        total: 0, pending: 0, processing: 0, completed: 0, failed: 0,
        cancelled: 0, manual_review: 0, today_transactions: 0,
        today_revenue: '0.00', today_profit: '0.00',
        monthly_transactions: 0, monthly_revenue: '0.00', monthly_profit: '0.00',
        electricity_transactions: 0, cable_transactions: 0,
        average_transaction_value: '0.00', success_rate: 0,
        summaryAvailable: false, reason, from: fromIso, to: toIso
    };
}

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

// ═════════════════════════════════════════════════════════════════
//  LIST
// ═════════════════════════════════════════════════════════════════

async function listOrders(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('bill_payment_transactions')
        .select('*', { count: 'exact' })
        .in('service_type', ['electricity', 'tv'])
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    const category = String(query.category || '').toLowerCase();
    if (category && category !== 'all' && BILL_CATEGORIES.has(category)) {
        q = q.eq('service_type', category);
    }

    const status = String(query.status || '').toLowerCase();
    if (status && status !== 'all') q = q.eq('status', status);

    if (query.provider && query.provider !== 'all') q = q.eq('provider', query.provider);
    if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);

    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);

    if (query.search) {
        const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
        const orParts = [
            `reference.ilike.%${safe}%`,
            `provider_request_id.ilike.%${safe}%`,
            `provider_transaction_id.ilike.%${safe}%`,
            `recipient.ilike.%${safe}%`
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
            return { orders: [], count: 0, page, limit, totalPages: 0, hasMore: false, available: false, reason: 'BILL_TABLE_NOT_FOUND' };
        }
        const e = new Error('Failed to load bill transactions');
        e.status = 500; e.code = 'BILLS_LIST_ERROR'; e.cause = error.message;
        throw e;
    }

    const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);

    const orders = (data || []).map(o => shapeOrder(o, profilesById[o.user_id]));

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

async function getOrder(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }

    const { data: raw, error } = await supabaseAdmin
        .from('bill_payment_transactions')
        .select('*')
        .eq('id', id)
        .in('service_type', ['electricity', 'tv'])
        .maybeSingle();

    if (error) {
        const e = new Error('Failed to load bill transaction'); e.status = 500; e.code = 'BILLS_DETAIL_ERROR'; throw e;
    }
    if (!raw) {
        const e = new Error('Bill transaction not found'); e.status = 404; e.code = 'BILL_NOT_FOUND'; throw e;
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

    const shaped = shapeOrder(raw, user);

    return {
        order: shaped,
        user,
        service_detail: buildServiceDetail(raw),
        transaction,
        refund_transaction: refundTransaction,
        ledger_entries: ledgerEntries,
        timeline: buildTimeline(raw)
    };
}

function buildServiceDetail(raw) {
    const svc = String(raw.service_type || '').toLowerCase();
    if (svc === 'electricity') {
        const meta = raw.metadata || {};
        return {
            category: 'electricity',
            disco: raw.service_id,
            meter_number_masked: mask(raw.recipient),
            meter_type: raw.variation_code || meta.meter_type || null,
            customer_name: meta.customer_name || null,
            customer_address: meta.customer_address || null,
            token: raw.token || null,
            units: raw.units || null
        };
    }
    if (svc === 'tv') {
        const meta = raw.metadata || {};
        return {
            category: 'tv',
            provider: raw.service_id,
            smartcard_masked: mask(raw.recipient),
            package: meta.package_name || null,
            current_package: meta.current_package || null,
            subscription_type: meta.subscription_type || null
        };
    }
    return { category: svc };
}

function buildTimeline(raw) {
    const events = [];
    if (raw.created_at)  events.push({ at: raw.created_at,  kind: 'order_created',  label: 'Order created' });
    if (raw.updated_at && raw.updated_at !== raw.created_at) {
        events.push({ at: raw.updated_at, kind: 'updated', label: 'Order updated' });
    }
    if (raw.completed_at) events.push({ at: raw.completed_at, kind: 'completed', label: 'Order completed' });
    if (raw.failed_at)    events.push({ at: raw.failed_at,    kind: 'failed',    label: `Order failed${raw.failure_reason ? ' — ' + raw.failure_reason : ''}` });
    if (raw.refunded_at)  events.push({ at: raw.refunded_at,  kind: 'refunded',  label: 'Refund applied' });
    events.sort((a, b) => new Date(a.at) - new Date(b.at));
    return events;
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER STATE — three-state classification
// ═════════════════════════════════════════════════════════════════

async function resolveProviderState(order) {
    if (!order.provider_request_id) {
        return { classification: 'UNKNOWN', reason: 'NO_REQUEST_ID' };
    }
    try {
        const result = await vtpass.queryTransaction(order.provider_request_id);
        const state = String(result.state || '').toLowerCase();

        if (state === 'completed') {
            return {
                classification: 'CONFIRMED_FULFILLED',
                providerStatus: result.providerStatus || 'delivered',
                providerCode: result.code || '000',
                raw: result
            };
        }
        if (state === 'failed') {
            return {
                classification: 'CONFIRMED_NOT_FULFILLED',
                providerStatus: result.providerStatus || 'failed',
                providerCode: result.code || null,
                error: result.error || null,
                friendlyError: result.friendlyError || null,
                raw: result
            };
        }
        // processing / pending / unknown
        return {
            classification: 'UNKNOWN',
            providerStatus: result.providerStatus || 'processing',
            providerCode: result.code || null,
            raw: result
        };
    } catch (e) {
        return { classification: 'UNKNOWN', reason: `PROVIDER_QUERY_FAILED: ${e.message}` };
    }
}

// ═════════════════════════════════════════════════════════════════
//  STATE WRITERS
// ═════════════════════════════════════════════════════════════════

async function loadBillById(orderId) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('bill_payment_transactions')
        .select('*')
        .eq('id', orderId)
        .in('service_type', ['electricity', 'tv'])
        .maybeSingle();
    if (error) { const e = new Error('Failed to load bill transaction'); e.status = 500; e.code = 'BILLS_DETAIL_ERROR'; throw e; }
    if (!data) { const e = new Error('Bill transaction not found'); e.status = 404; e.code = 'BILL_NOT_FOUND'; throw e; }
    return data;
}

async function transitionBill({ orderId, expectedCurrentStatus, nextStatus, extraFields = {}, ctx, eventType, reason = null }) {
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
    const patch = {
        ...extraFields,
        status: next_,
        updated_at: now
    };
    if (next_ === 'completed') patch.completed_at = now;
    if (next_ === 'failed')    patch.failed_at    = now;
    if (next_ === 'refunded')  patch.refunded_at  = now;

    const { data: updated, error } = await supabaseAdmin
        .from('bill_payment_transactions')
        .update(patch)
        .eq('id', orderId)
        .eq('status', current)
        .select('*')
        .maybeSingle();

    if (error) {
        const e = new Error('Failed to update bill transaction'); e.status = 500; e.code = 'BILLS_UPDATE_ERROR'; e.cause = error.message; throw e;
    }
    if (!updated) {
        const e = new Error('Order changed while you were editing it. Reload and try again.');
        e.status = 409; e.code = 'ORDER_STATE_CHANGED';
        e.expected_status = current;
        throw e;
    }

    await recordAudit({
        ctx,
        action: `bill.${eventType || next_}`,
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
    const raw = await loadBillById(orderId);
    const current = String(raw.status || '').toLowerCase();

    const provider = await resolveProviderState(raw);

    // Always stamp the check.
    const now = new Date().toISOString();
    await supabaseAdmin
        .from('bill_payment_transactions')
        .update({
            last_reconciliation_at: now,
            reconciliation_attempts: (raw.reconciliation_attempts || 0) + 1,
            provider_status: provider.providerStatus || raw.provider_status,
            provider_code: provider.providerCode || raw.provider_code
        })
        .eq('id', raw.id);

    if (provider.classification === 'CONFIRMED_FULFILLED') {
        if (current !== 'completed') {
            await transitionBill({
                orderId: raw.id,
                expectedCurrentStatus: current,
                nextStatus: 'completed',
                extraFields: {
                    provider_status: provider.providerStatus || 'delivered',
                    provider_code: provider.providerCode || '000',
                    failure_reason: null
                },
                ctx, eventType: 'sync_completed', reason: 'Provider confirmed completion'
            });
        }
        return { synced: true, resolved: 'completed' };
    }

    if (provider.classification === 'CONFIRMED_NOT_FULFILLED') {
        if (current !== 'failed' && current !== 'completed') {
            await transitionBill({
                orderId: raw.id,
                expectedCurrentStatus: current,
                nextStatus: 'failed',
                extraFields: {
                    failure_reason: provider.error || provider.friendlyError || 'Provider rejected the transaction',
                    provider_status: provider.providerStatus || 'failed',
                    provider_code: provider.providerCode || null
                },
                ctx, eventType: 'sync_failed',
                reason: provider.error || provider.friendlyError || 'Provider rejection'
            });
        }
        return { synced: true, resolved: 'failed' };
    }

    // UNKNOWN — do not change status, but record the check.
    return { synced: true, resolved: 'unknown', reason: provider.reason || null };
}

// ═════════════════════════════════════════════════════════════════
//  RETRY
//
//  Only CONFIRMED_NOT_FULFILLED triggers a new provider request.
//  UNKNOWN moves to manual_review.
// ═════════════════════════════════════════════════════════════════

async function retryOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const raw = await loadBillById(orderId);
    const current = String(raw.status || '').toLowerCase();

    if (current === 'completed') {
        const e = new Error('Order is already completed.'); e.status = 409; e.code = 'ALREADY_COMPLETED'; throw e;
    }
    if (current === 'refunded') {
        const e = new Error('Order is already refunded.'); e.status = 409; e.code = 'ALREADY_REFUNDED'; throw e;
    }

    const provider = await resolveProviderState(raw);

    if (provider.classification === 'CONFIRMED_FULFILLED') {
        if (current !== 'completed') {
            await transitionBill({
                orderId: raw.id,
                expectedCurrentStatus: current,
                nextStatus: 'completed',
                extraFields: {
                    provider_status: provider.providerStatus || 'delivered',
                    provider_code: provider.providerCode || '000'
                },
                ctx, eventType: 'retry_completed_at_provider',
                reason: 'Provider already fulfilled'
            });
        }
        return { outcome: 'delivered_existing' };
    }

    if (provider.classification === 'UNKNOWN') {
        if (current !== 'manual_review') {
            await transitionBill({
                orderId: raw.id,
                expectedCurrentStatus: current,
                nextStatus: 'manual_review',
                extraFields: {
                    failure_reason: provider.reason || 'Provider state is unknown'
                },
                ctx, eventType: 'retry_deferred_unknown',
                reason: `Retry refused: provider state unknown (${provider.reason || 'unknown'})`
            });
        }
        return { outcome: 'manual_review' };
    }

    // CONFIRMED_NOT_FULFILLED — safe to send a new purchase.
    let purchase;
    try {
        if (raw.service_type === 'electricity') {
            purchase = await vtpass.purchaseElectricity({
                provider: raw.service_id,
                meterNumber: raw.recipient,
                meterType: raw.variation_code || (raw.metadata || {}).meter_type || 'prepaid',
                amount: Number(raw.base_amount),
                phone: null
            });
        } else if (raw.service_type === 'tv') {
            purchase = await vtpass.purchaseTv({
                provider: raw.service_id,
                customerId: raw.recipient,
                variationCode: raw.variation_code,
                amount: Number(raw.base_amount),
                subscriptionType: (raw.metadata || {}).subscription_type || 'renew'
            });
        } else {
            const e = new Error('Unsupported service type for retry.'); e.status = 422; e.code = 'UNSUPPORTED_SERVICE'; throw e;
        }
    } catch (e) {
        await transitionBill({
            orderId: raw.id,
            expectedCurrentStatus: current,
            nextStatus: 'failed',
            extraFields: {
                failure_reason: `Retry request failed: ${e.message || 'unknown error'}`
            },
            ctx, eventType: 'retry_provider_threw',
            reason
        });
        return { outcome: 'failed', error: e.message };
    }

    // Map result.
    const state = String(purchase.state || '').toLowerCase();

    if (state === 'completed') {
        await transitionBill({
            orderId: raw.id,
            expectedCurrentStatus: current,
            nextStatus: 'completed',
            extraFields: {
                provider_request_id: purchase.requestId || null,
                provider_transaction_id: purchase.transactionId || null,
                provider_status: purchase.providerStatus || 'delivered',
                provider_code: purchase.code || '000',
                token: purchase.token || raw.token,
                units: purchase.units || raw.units,
                failure_reason: null
            },
            ctx, eventType: 'retry_completed',
            reason
        });
        return { outcome: 'retried_completed' };
    }

    if (state === 'processing') {
        await transitionBill({
            orderId: raw.id,
            expectedCurrentStatus: current,
            nextStatus: 'processing',
            extraFields: {
                provider_request_id: purchase.requestId || null,
                provider_transaction_id: purchase.transactionId || null,
                provider_status: purchase.providerStatus || 'processing',
                provider_code: purchase.code || null
            },
            ctx, eventType: 'retry_processing',
            reason
        });
        return { outcome: 'retried_processing' };
    }

    // failure
    await transitionBill({
        orderId: raw.id,
        expectedCurrentStatus: current,
        nextStatus: 'failed',
        extraFields: {
            provider_request_id: purchase.requestId || null,
            provider_status: purchase.providerStatus || 'failed',
            provider_code: purchase.code || null,
            failure_reason: purchase.friendlyError || purchase.error || 'Provider rejected the retry'
        },
        ctx, eventType: 'retry_failed',
        reason
    });
    return { outcome: 'retried_failed' };
}

// ═════════════════════════════════════════════════════════════════
//  REFUND
// ═════════════════════════════════════════════════════════════════

async function refundOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const raw = await loadBillById(orderId);
    const current = String(raw.status || '').toLowerCase();

    if (current === 'refunded') {
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

    // Idempotency fast path — unique index in the migration guarantees safety.
    const { data: existingRefund } = await supabaseAdmin
        .from('transactions')
        .select('id, reference, amount, currency')
        .eq('source_id', originalTx.id)
        .eq('type', 'refund')
        .maybeSingle();

    if (existingRefund) {
        if (current !== 'refunded') {
            await transitionBill({
                orderId: raw.id,
                expectedCurrentStatus: current,
                nextStatus: 'refunded',
                extraFields: {
                    refunded: true,
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
            description: `Bill refund — ${raw.reference}`,
            type: 'refund',
            sourceType: 'bill_payment',
            sourceId: originalTx.id,
            reference: `BILLREF-${raw.reference}`,
            metadata: { bill_transaction_id: raw.id, reason }
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
                await transitionBill({
                    orderId: raw.id,
                    expectedCurrentStatus: current,
                    nextStatus: 'refunded',
                    extraFields: { refunded: true, refund_transaction_id: raceRefund.id },
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
        await transitionBill({
            orderId: raw.id,
            expectedCurrentStatus: current,
            nextStatus: 'refunded',
            extraFields: {
                refunded: true,
                refund_transaction_id: credit.transaction_id || null
            },
            ctx, eventType: 'refund', reason
        });
    } catch (postErr) {
        // Wallet was credited but order didn't transition. Flag it.
        await supabaseAdmin
            .from('bill_payment_transactions')
            .update({
                status: 'manual_review',
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
    const raw = await loadBillById(orderId);
    const current = String(raw.status || '').toLowerCase();

    if (current === 'completed' || current === 'refunded') {
        const e = new Error(`Cannot move a ${current} order to manual review.`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION'; throw e;
    }
    if (current === 'manual_review') {
        return { reviewed: true, already: true };
    }

    await transitionBill({
        orderId: raw.id,
        expectedCurrentStatus: current,
        nextStatus: 'manual_review',
        extraFields: { failure_reason: String(reason).slice(0, 500) },
        ctx, eventType: 'manual_review', reason
    });

    return { reviewed: true };
}

// ═════════════════════════════════════════════════════════════════
//  CATALOGS
// ═════════════════════════════════════════════════════════════════

async function getElectricityProviders() {
    const rows = vtpass.getElectricityProviders();
    return rows.map(r => ({
        id: r.id,
        name: r.name,
        country: 'NGA',
        currency: 'NGN',
        provider: 'vtpass',
        enabled: true,
        meter_types: ['prepaid', 'postpaid'],
        source: 'static'
    }));
}

async function getCableProviders() {
    const rows = vtpass.getTvProviders();
    return rows.map(r => ({
        id: r.id,
        name: r.name,
        country: 'NGA',
        currency: 'NGN',
        provider: 'vtpass',
        enabled: true,
        source: 'static'
    }));
}

async function getCablePackages(providerId) {
    if (!providerId) {
        const e = new Error('Provider id is required.'); e.status = 422; e.code = 'MISSING_PROVIDER'; throw e;
    }
    const result = await vtpass.getTvPackages(String(providerId).toLowerCase());
    if (!result?.success) {
        const e = new Error(result?.error || 'Unable to fetch packages');
        e.status = 502; e.code = 'PROVIDER_PACKAGES_FAILED'; throw e;
    }
    return (result.packages || []).map(p => ({
        provider: String(providerId).toLowerCase(),
        variation_code: p.variation_code,
        name: p.name,
        amount: p.amount,
        currency: 'NGN',
        description: p.description || null,
        source: 'provider'
    }));
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

async function getProviderHealth() {
    let live;
    try {
        live = await vtpass.healthCheck();
    } catch (e) {
        live = { configured: vtpass.isConfigured(), connectivity: false, error: e.message };
    }

    let lastSuccess = null;
    let lastFailure = null;
    let recentCount = 0;
    try {
        const { data: ok } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('completed_at')
            .in('service_type', ['electricity', 'tv'])
            .eq('status', 'completed')
            .order('completed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        lastSuccess = ok?.completed_at || null;

        const { data: bad } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('failed_at, failure_reason')
            .in('service_type', ['electricity', 'tv'])
            .eq('status', 'failed')
            .order('failed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (bad) lastFailure = { at: bad.failed_at, reason: bad.failure_reason || null };

        const { count } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('id', { count: 'exact', head: true })
            .in('service_type', ['electricity', 'tv'])
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        recentCount = count || 0;
    } catch (_) { /* optional */ }

    const status = !live.configured ? 'not_configured'
        : !live.connectivity ? 'unreachable'
        : lastFailure && (!lastSuccess || new Date(lastFailure.at) > new Date(lastSuccess))
            ? 'degraded'
            : 'operational';

    return {
        provider: 'vtpass',
        label: 'VTpass',
        category: 'Bills & Utilities',
        status,
        configured: live.configured,
        reachable: live.connectivity,
        environment: live.environment || null,
        latencyMs: live.responseTime || null,
        lastSuccess,
        lastFailure,
        recentCount,
        lastError: live.error || null
    };
}

async function healthCheckProvider({ ctx }) {
    const result = await vtpass.healthCheck();
    await recordAudit({
        ctx, action: 'bill.health_check_vtpass',
        targetId: 'vtpass', before: null, after: result, reason: null
    });
    return result;
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    BILL_CATEGORIES,
    ALLOWED_TRANSITIONS,

    getStats,
    listOrders,
    getOrder,

    syncOrder,
    retryOrder,
    refundOrder,
    reviewOrder,

    getElectricityProviders,
    getCableProviders,
    getCablePackages,

    getProviderHealth,
    healthCheckProvider
};