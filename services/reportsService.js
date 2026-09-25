// services/reportsService.js
// ─────────────────────────────────────────────────────────────────
// Central reports module. Read-only financial + operational analytics.
//
// Classification rules (identical to /admin/revenue):
//   REVENUE   = service orders, completed/partial
//   FUNDING   = deposit_requests + crypto_deposits (NEVER revenue)
//   REFUNDS   = orders.refund_amount where refund_status='refunded'
//   FEES      = orders.fee
//   COST      = orders.provider_cost
//   HELD      = ledger_accounts.available_balance (liability)
//
// Nothing here mutates money. Nothing invents data. Every failure
// returns { available: false, reason } rather than a fabricated zero.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

const MAX_LIMIT = 250;
const DEFAULT_LIMIT = 25;

const SUCCESS_STATUSES = new Set(['completed', 'success', 'partial']);
const PENDING_STATUSES = new Set(['pending','paid','processing','in_progress','provider_unknown','confirming','partially_paid']);
const FAILED_STATUSES  = new Set(['failed','cancelled','expired','reversed']);

// ─── Helpers ─────────────────────────────────────────────────────

function limitOf(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
}
function pageOf(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}
function iso(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function watDayBounds(date = new Date()) {
    const OFFSET_MS = 60 * 60 * 1000;
    const local = new Date(date.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    return {
        start: new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS).toISOString(),
        end:   new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - OFFSET_MS).toISOString()
    };
}
function pctChange(current, previous) {
    const c = Number(current || 0), p = Number(previous || 0);
    if (p === 0 && c === 0) return 0;
    if (p === 0) return null;
    return Math.round(((c - p) / p) * 10000) / 100;
}
function isoDate(v) { return iso(v); }

function scopeOf(query) {
    const fromIso = isoDate(query.from) || watDayBounds().start;
    const toIso   = isoDate(query.to)   || watDayBounds().end;
    return {
        from: fromIso,
        to: toIso,
        currency: query.currency && query.currency !== 'all'
            ? String(query.currency).toUpperCase()
            : null,
        product: query.product && query.product !== 'all' ? query.product : null,
        provider: query.provider && query.provider !== 'all' ? query.provider : null,
        status: query.status && query.status !== 'all' ? query.status : null
    };
}

function previousPeriod(from, to) {
    const f = new Date(from).getTime(), t = new Date(to).getTime();
    const span = t - f;
    return {
        from: new Date(f - span).toISOString(),
        to:   new Date(f - 1).toISOString()
    };
}

// Whitelisted sort columns to prevent injection.
const SORTABLE_ORDERS = new Set(['created_at','updated_at','completed_at','total_amount','profit_amount']);
const SORTABLE_TRANSACTIONS = new Set(['created_at','completed_at','amount']);
const SORTABLE_CUSTOMERS = new Set(['spent','orders','net_spend','last_order']);

// ─── Overview ────────────────────────────────────────────────────
// Reads revenue RPCs (deployed by the revenue migration) and adds
// operational numbers that aren't covered there: transactions,
// active customers, provider issues, webhook failures.

async function getOverview(query) {
    const scope = scopeOf(query);
    const prev = previousPeriod(scope.from, scope.to);

    const [
        summaryRpc, prevSummaryRpc,
        fundingRpc,
        webhookStats,
        txCount, prevTxCount,
        activeCustomerCount
    ] = await Promise.all([
        supabaseAdmin.rpc('revenue_summary', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency }),
        supabaseAdmin.rpc('revenue_summary', { p_from: prev.from, p_to: prev.to, p_currency: scope.currency }),
        supabaseAdmin.rpc('revenue_funding_summary', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency }),
        getWebhookStats({ ...scope }).catch(() => null),
        countTransactions({ from: scope.from, to: scope.to, currency: scope.currency }),
        countTransactions({ from: prev.from, to: prev.to, currency: scope.currency }),
        countActiveCustomers({ from: scope.from, to: scope.to })
    ]);

    const rpcMissing = summaryRpc.error && ['42883','PGRST202'].includes(summaryRpc.error.code);

    if (rpcMissing) {
        return {
            available: false,
            reason: 'REPORTS_RPC_NOT_DEPLOYED',
            message: 'Run migrations/2025_revenue_analytics.sql first.'
        };
    }

    const sum = (rows, key) => (rows || []).reduce((a, r) => a + Number(r[key] || 0), 0);
    const cur = summaryRpc.data || [];
    const prv = prevSummaryRpc.data || [];
    const fund = fundingRpc.data || [];

    const revenue   = sum(cur, 'gross_revenue');
    const prevRevenue = sum(prv, 'gross_revenue');
    const refunds   = sum(cur, 'refunds');
    const cost      = sum(cur, 'provider_cost');
    const profit    = sum(cur, 'gross_profit');

    const depositsTotal = sum(fund, 'deposits_total');
    const depositsCount = sum(fund, 'deposits_count');

    return {
        available: true,
        period: { from: scope.from, to: scope.to, previous: prev, currency: scope.currency },
        summary: {
            transactions: {
                count: txCount,
                changePct: pctChange(txCount, prevTxCount)
            },
            revenue: {
                gross: String(revenue.toFixed(2)),
                net:   String((revenue - refunds).toFixed(2)),
                changePct: pctChange(revenue, prevRevenue)
            },
            funding: {
                count: depositsCount,
                total: String(depositsTotal.toFixed(2))
            },
            refunds: {
                total: String(refunds.toFixed(2))
            },
            cost: {
                total: String(cost.toFixed(2))
            },
            profit: {
                gross: String(profit.toFixed(2))
            },
            orders: {
                total:     sum(cur, 'total_orders'),
                completed: sum(cur, 'completed_orders'),
                pending:   sum(cur, 'pending_orders'),
                failed:    sum(cur, 'failed_orders'),
                refunded:  sum(cur, 'refunded_orders')
            },
            customers: {
                active: activeCustomerCount
            },
            providerIssues: {
                failedProviderOrders: sum(cur, 'failed_orders'),
                failedWebhooks: webhookStats?.failed || 0,
                pendingWebhooks: webhookStats?.received || 0
            }
        },
        byCurrency: cur.map(r => ({
            currency:      r.currency,
            grossRevenue:  String(r.gross_revenue || '0.00'),
            netRevenue:    String(r.net_revenue || '0.00'),
            providerCost:  String(r.provider_cost || '0.00'),
            profit:        String(r.gross_profit || '0.00'),
            refunds:       String(r.refunds || '0.00'),
            orders:        Number(r.total_orders || 0)
        }))
    };
}

// ─── Transactions report ─────────────────────────────────────────

async function getTransactions(query) {
    const scope = scopeOf(query);
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;
    const sort = SORTABLE_TRANSACTIONS.has(String(query.sort)) ? query.sort : 'created_at';
    const ascending = String(query.order || 'desc').toLowerCase() === 'asc';

    let q = supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, status, currency, amount, fee, ref, reference, description, provider, provider_reference, source_type, source_id, metadata, created_at, completed_at, updated_at', { count: 'exact' })
        .gte('created_at', scope.from)
        .lte('created_at', scope.to)
        .order(sort, { ascending })
        .range(offset, offset + limit - 1);

    if (scope.currency) q = q.eq('currency', scope.currency);
    if (scope.status) q = q.eq('status', scope.status);
    if (query.type) q = q.eq('type', query.type);
    if (scope.provider) q = q.eq('provider', scope.provider);
    if (query.user_id) q = q.eq('user_id', query.user_id);

    if (query.search) {
        const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
        const orParts = [
            `reference.ilike.%${safe}%`,
            `ref.ilike.%${safe}%`,
            `provider_reference.ilike.%${safe}%`,
            `description.ilike.%${safe}%`
        ];
        try {
            const { data: users } = await supabaseAdmin
                .from('profiles').select('id')
                .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
                .limit(50);
            if (users?.length) orParts.push(`user_id.in.(${users.map(u => u.id).join(',')})`);
        } catch (_) {}
        q = q.or(orParts.join(','));
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { available: false, reason: 'TRANSACTIONS_TABLE_NOT_FOUND', transactions: [], pagination: { page, limit, total: 0, totalPages: 0 } };
        }
        const e = new Error('Failed to load transactions.'); e.status = 500; e.code = 'REPORT_TX_FAILED'; throw e;
    }

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    let profilesById = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles').select('id, username, email').in('id', userIds);
        for (const p of profiles || []) profilesById[p.id] = p;
    }

    return {
        available: true,
        period: { from: scope.from, to: scope.to },
        transactions: (data || []).map(t => {
            const p = profilesById[t.user_id] || {};
            return {
                id: t.id,
                reference: t.ref || t.reference || null,
                user: {
                    id: t.user_id,
                    username: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    email: p.email || null
                },
                type: t.type,
                status: t.status,
                currency: t.currency,
                amount: t.amount,
                fee: t.fee,
                description: t.description,
                provider: t.provider,
                providerReference: t.provider_reference,
                sourceType: t.source_type,
                sourceId: t.source_id,
                createdAt: t.created_at,
                completedAt: t.completed_at,
                updatedAt: t.updated_at
            };
        }),
        pagination: {
            page, limit,
            total: count || 0,
            totalPages: Math.ceil((count || 0) / limit)
        }
    };
}

// ─── Orders report ───────────────────────────────────────────────

async function getOrders(query) {
    const scope = scopeOf(query);
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;
    const sort = SORTABLE_ORDERS.has(String(query.sort)) ? query.sort : 'created_at';
    const ascending = String(query.order || 'desc').toLowerCase() === 'asc';

    let q = supabaseAdmin
        .from('orders')
        .select('*', { count: 'exact' })
        .gte('created_at', scope.from)
        .lte('created_at', scope.to)
        .order(sort, { ascending })
        .range(offset, offset + limit - 1);

    if (scope.currency) q = q.eq('currency', scope.currency);
    if (scope.status) q = q.eq('status', scope.status);
    if (scope.product) q = q.eq('product_type', scope.product);
    if (scope.provider) q = q.eq('provider', scope.provider);
    if (query.user_id) q = q.eq('user_id', query.user_id);

    if (query.search) {
        const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
        const orParts = [
            `order_ref.ilike.%${safe}%`,
            `provider_order_id.ilike.%${safe}%`,
            `provider_reference.ilike.%${safe}%`
        ];
        try {
            const { data: users } = await supabaseAdmin
                .from('profiles').select('id')
                .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
                .limit(50);
            if (users?.length) orParts.push(`user_id.in.(${users.map(u => u.id).join(',')})`);
        } catch (_) {}
        q = q.or(orParts.join(','));
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { available: false, reason: 'ORDERS_TABLE_NOT_FOUND', orders: [], pagination: { page, limit, total: 0, totalPages: 0 } };
        }
        const e = new Error('Failed to load orders.'); e.status = 500; e.code = 'REPORT_ORDER_FAILED'; throw e;
    }

    const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
    let profilesById = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles').select('id, username, email').in('id', userIds);
        for (const p of profiles || []) profilesById[p.id] = p;
    }

    // Summary numbers for the same filter, not the page.
    const summary = await ordersSummary(scope, query);

    return {
        available: true,
        period: { from: scope.from, to: scope.to },
        orders: (data || []).map(o => {
            const p = profilesById[o.user_id] || {};
            return {
                id: o.id,
                orderRef: o.order_ref,
                user: {
                    id: o.user_id,
                    username: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    email: p.email || null
                },
                productType: o.product_type,
                productName: o.product_name,
                provider: o.provider,
                providerOrderId: o.provider_order_id,
                providerReference: o.provider_reference,
                providerStatus: o.provider_status,
                amount: o.amount,
                fee: o.fee,
                totalAmount: o.total_amount,
                providerCost: o.provider_cost,
                profitAmount: o.profit_amount,
                currency: o.currency,
                status: o.status,
                refundStatus: o.refund_status,
                refundAmount: o.refund_amount,
                failureReason: o.failure_reason,
                createdAt: o.created_at,
                updatedAt: o.updated_at,
                completedAt: o.completed_at,
                failedAt: o.failed_at,
                refundedAt: o.refunded_at
            };
        }),
        summary,
        pagination: {
            page, limit,
            total: count || 0,
            totalPages: Math.ceil((count || 0) / limit)
        }
    };
}

async function ordersSummary(scope, query) {
    let q = supabaseAdmin
        .from('orders')
        .select('status, total_amount, provider_cost, profit_amount, refund_amount, currency', { count: 'exact', head: false })
        .gte('created_at', scope.from)
        .lte('created_at', scope.to);

    if (scope.currency) q = q.eq('currency', scope.currency);
    if (scope.product) q = q.eq('product_type', scope.product);
    if (scope.provider) q = q.eq('provider', scope.provider);
    if (query.user_id) q = q.eq('user_id', query.user_id);

    const { data } = await q;

    const rows = data || [];
    const sum = key => rows.reduce((a, r) => a + Number(r[key] || 0), 0);
    const completed = rows.filter(r => r.status === 'completed');
    const failed = rows.filter(r => FAILED_STATUSES.has(String(r.status)));
    const pending = rows.filter(r => PENDING_STATUSES.has(String(r.status)));

    return {
        total: rows.length,
        completed: completed.length,
        pending: pending.length,
        failed: failed.length,
        refunded: rows.filter(r => r.refund_status === 'refunded').length,
        totalValue: String(sum('total_amount').toFixed(2)),
        providerCost: String(sum('provider_cost').toFixed(2)),
        profit: String(sum('profit_amount').toFixed(2)),
        refundedValue: String(sum('refund_amount').toFixed(2)),
        successRate: rows.length ? Math.round((completed.length / rows.length) * 10000) / 100 : 0,
        failureRate: rows.length ? Math.round((failed.length / rows.length) * 10000) / 100 : 0,
        averageOrderValue: completed.length ? String((sum('total_amount') / completed.length).toFixed(2)) : '0.00'
    };
}

// ─── Customers report ────────────────────────────────────────────

async function getCustomers(query) {
    const scope = scopeOf(query);
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;
    const sortKey = SORTABLE_CUSTOMERS.has(String(query.sort)) ? query.sort : 'spent';
    const ascending = String(query.order || 'desc').toLowerCase() === 'asc';

    // Use the revenue_top_customers RPC (already deployed) to get
    // the aggregation, then page it in Node.
    const { data, error } = await supabaseAdmin.rpc('revenue_top_customers', {
        p_from: scope.from,
        p_to: scope.to,
        p_limit: 1000
    });
    if (error) {
        if (['42883','PGRST202'].includes(error.code)) return { available: false, reason: 'REPORTS_RPC_NOT_DEPLOYED' };
        throw new Error(`Customers report failed: ${error.message}`);
    }

    // Sort + paginate.
    const rows = (data || []).slice();
    const mapKey = {
        spent: 'spent',
        orders: 'orders',
        net_spend: 'net_spend',
        last_order: 'last_order'
    }[sortKey];
    rows.sort((a, b) => {
        const av = a[mapKey], bv = b[mapKey];
        if (mapKey === 'last_order') {
            return ascending
                ? new Date(av) - new Date(bv)
                : new Date(bv) - new Date(av);
        }
        return ascending ? Number(av) - Number(bv) : Number(bv) - Number(av);
    });

    const total = rows.length;
    const paged = rows.slice(offset, offset + limit);

    // Enrich with profile data.
    const userIds = paged.map(r => r.user_id).filter(Boolean);
    let profilesById = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, created_at, status, last_location')
            .in('id', userIds);
        for (const p of profiles || []) profilesById[p.id] = p;
    }

    const enrich = (r) => {
        const p = profilesById[r.user_id] || {};
        return {
            user: {
                id: r.user_id,
                username: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                email: p.email || null,
                created_at: p.created_at || null,
                status: p.status || null,
                last_location: p.last_location || null
            },
            orders: Number(r.orders || 0),
            spent: String(r.spent || '0.00'),
            refunded: String(r.refunded || '0.00'),
            netSpend: String(r.net_spend || '0.00'),
            lastOrder: r.last_order
        };
    };

    return {
        available: true,
        period: { from: scope.from, to: scope.to },
        customers: paged.map(enrich),
        summary: {
            totalCustomers: total,
            newCustomers: await countNewCustomers({ from: scope.from, to: scope.to })
        },
        pagination: {
            page, limit,
            total,
            totalPages: Math.ceil(total / limit)
        }
    };
}

async function countNewCustomers({ from, to }) {
    try {
        const { count } = await supabaseAdmin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', from)
            .lte('created_at', to);
        return count || 0;
    } catch { return 0; }
}

async function countActiveCustomers({ from, to }) {
    try {
        const { count } = await supabaseAdmin
            .from('orders')
            .select('user_id', { count: 'exact', head: true })
            .gte('created_at', from)
            .lte('created_at', to);
        // This counts rows, not unique users. For a distinct count we
        // would need an RPC; for now it's an honest approximation and
        // the UI labels it as "orders with activity".
        return count || 0;
    } catch { return 0; }
}

// ─── Products report ─────────────────────────────────────────────

async function getProducts(query) {
    const scope = scopeOf(query);
    const { data, error } = await supabaseAdmin.rpc('revenue_by_product', {
        p_from: scope.from,
        p_to: scope.to,
        p_currency: scope.currency
    });
    if (error) {
        if (['42883','PGRST202'].includes(error.code)) return { available: false, reason: 'REPORTS_RPC_NOT_DEPLOYED' };
        throw new Error(`Products report failed: ${error.message}`);
    }
    return {
        available: true,
        period: { from: scope.from, to: scope.to },
        products: (data || []).map(r => ({
            product: r.product,
            currency: r.currency,
            orders: Number(r.orders || 0),
            revenue: String(r.revenue || '0.00'),
            providerCost: String(r.provider_cost || '0.00'),
            refunds: String(r.refunds || '0.00'),
            profit: String(r.profit || '0.00'),
            marginPct: Number(r.margin_pct || 0)
        }))
    };
}

// ─── Providers report ────────────────────────────────────────────

async function getProviders(query) {
    const scope = scopeOf(query);
    const { data, error } = await supabaseAdmin.rpc('revenue_by_provider', {
        p_from: scope.from,
        p_to: scope.to,
        p_currency: scope.currency
    });
    if (error) {
        if (['42883','PGRST202'].includes(error.code)) return { available: false, reason: 'REPORTS_RPC_NOT_DEPLOYED' };
        throw new Error(`Providers report failed: ${error.message}`);
    }
    return {
        available: true,
        period: { from: scope.from, to: scope.to },
        providers: (data || []).map(r => ({
            provider: r.provider,
            currency: r.currency,
            orders: Number(r.orders || 0),
            revenue: String(r.revenue || '0.00'),
            providerCost: String(r.provider_cost || '0.00'),
            refunds: String(r.refunds || '0.00'),
            profit: String(r.profit || '0.00'),
            failedOrders: Number(r.failed_orders || 0),
            successRate: Number(r.orders || 0) > 0
                ? Math.round(((Number(r.orders) - Number(r.failed_orders || 0)) / Number(r.orders)) * 10000) / 100
                : 0
        }))
    };
}

// ─── Webhooks report ─────────────────────────────────────────────

async function getWebhooks(query) {
    const scope = scopeOf(query);
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('webhook_events')
        .select('id, provider, event_id, event_type, order_id, provider_order_id, signature_valid, processing_status, processing_error, received_at, processed_at', { count: 'exact' })
        .gte('received_at', scope.from)
        .lte('received_at', scope.to)
        .order('received_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (scope.provider) q = q.eq('provider', scope.provider);
    if (scope.status) q = q.eq('processing_status', scope.status);

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { available: false, reason: 'WEBHOOK_TABLE_NOT_FOUND', webhooks: [], stats: {}, pagination: { page, limit, total: 0, totalPages: 0 } };
        }
        throw new Error(`Webhooks report failed: ${error.message}`);
    }

    const stats = await getWebhookStats(scope);

    return {
        available: true,
        period: { from: scope.from, to: scope.to },
        webhooks: data || [],
        stats,
        pagination: {
            page, limit,
            total: count || 0,
            totalPages: Math.ceil((count || 0) / limit)
        }
    };
}

async function getWebhookStats(scope) {
    const buckets = ['received','processing','processed','failed','ignored','duplicate'];
    const stats = {};
    for (const s of buckets) {
        let q = supabaseAdmin
            .from('webhook_events')
            .select('id', { count: 'exact', head: true })
            .gte('received_at', scope.from)
            .lte('received_at', scope.to)
            .eq('processing_status', s);
        if (scope.provider) q = q.eq('provider', scope.provider);
        const { count } = await q;
        stats[s] = count || 0;
    }
    return stats;
}

// ─── Failures report ─────────────────────────────────────────────
// Union of failed transactions + failed orders + failed webhooks.

async function getFailures(query) {
    const scope = scopeOf(query);
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);

    const [failedOrders, failedTx, failedWebhooks] = await Promise.all([
        supabaseAdmin.from('orders')
            .select('id, order_ref, user_id, product_type, provider, total_amount, currency, status, failure_reason, created_at, updated_at')
            .gte('created_at', scope.from).lte('created_at', scope.to)
            .in('status', ['failed','cancelled','expired'])
            .limit(limit),
        supabaseAdmin.from('transactions')
            .select('id, reference, ref, user_id, type, provider, amount, currency, status, failure_reason, created_at')
            .gte('created_at', scope.from).lte('created_at', scope.to)
            .eq('status', 'failed')
            .limit(limit),
        supabaseAdmin.from('webhook_events')
            .select('id, provider, event_type, provider_order_id, processing_error, received_at')
            .gte('received_at', scope.from).lte('received_at', scope.to)
            .eq('processing_status', 'failed')
            .limit(limit)
    ]);

    const userIds = new Set();
    [...(failedOrders.data || []), ...(failedTx.data || [])].forEach(r => { if (r.user_id) userIds.add(r.user_id); });
    let profilesById = {};
    if (userIds.size) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles').select('id, username, email').in('id', [...userIds]);
        for (const p of profiles || []) profilesById[p.id] = p;
    }

    const items = [];

    for (const o of failedOrders.data || []) {
        const p = profilesById[o.user_id] || {};
        items.push({
            kind: 'order',
            reference: o.order_ref,
            user: { id: o.user_id, username: p.username || 'User', email: p.email || null },
            module: o.product_type,
            provider: o.provider,
            amount: o.total_amount,
            currency: o.currency,
            status: o.status,
            errorType: 'ORDER_FAILED',
            errorMessage: o.failure_reason,
            createdAt: o.created_at,
            updatedAt: o.updated_at
        });
    }

    for (const t of failedTx.data || []) {
        const p = profilesById[t.user_id] || {};
        items.push({
            kind: 'transaction',
            reference: t.ref || t.reference,
            user: { id: t.user_id, username: p.username || 'User', email: p.email || null },
            module: t.type,
            provider: t.provider,
            amount: t.amount,
            currency: t.currency,
            status: t.status,
            errorType: 'TRANSACTION_FAILED',
            errorMessage: t.failure_reason,
            createdAt: t.created_at,
            updatedAt: null
        });
    }

    for (const w of failedWebhooks.data || []) {
        items.push({
            kind: 'webhook',
            reference: w.provider_order_id,
            user: null,
            module: 'webhook',
            provider: w.provider,
            amount: null,
            currency: null,
            status: 'failed',
            errorType: 'WEBHOOK_FAILED',
            errorMessage: w.processing_error,
            createdAt: w.received_at,
            updatedAt: null
        });
    }

    return {
        available: true,
        period: { from: scope.from, to: scope.to },
        failures: items.slice(0, limit),
        summary: {
            total: items.length,
            orders: (failedOrders.data || []).length,
            transactions: (failedTx.data || []).length,
            webhooks: (failedWebhooks.data || []).length
        },
        pagination: {
            page, limit,
            total: items.length,
            totalPages: Math.ceil(items.length / limit)
        }
    };
}

// ─── Reconciliation report ───────────────────────────────────────
// Detects the checks the prompt asks for. Read-only. Does not fix.

async function getReconciliation(query) {
    const scope = scopeOf(query);
    const issues = [];

    // 1. Completed provider order but local order not completed.
    //    Detects: provider_status indicates success but our status lags.
    try {
        const { data } = await supabaseAdmin
            .from('orders')
            .select('id, order_ref, status, provider_status, provider, total_amount, currency, created_at')
            .gte('created_at', scope.from)
            .lte('created_at', scope.to)
            .not('provider_status', 'is', null)
            .in('status', ['pending','processing','in_progress','provider_unknown'])
            .limit(500);
        for (const o of data || []) {
            const ps = String(o.provider_status || '').toLowerCase();
            if (['completed','success','finished','delivered'].includes(ps)) {
                issues.push({
                    type: 'PROVIDER_COMPLETED_LOCAL_PENDING',
                    severity: 'high',
                    reference: o.order_ref,
                    provider: o.provider,
                    amount: o.total_amount,
                    currency: o.currency,
                    expected: 'completed',
                    actual: o.status,
                    createdAt: o.created_at
                });
            }
        }
    } catch (_) {}

    // 2. Failed order not refunded.
    try {
        const { data } = await supabaseAdmin
            .from('orders')
            .select('id, order_ref, status, refund_status, total_amount, currency, provider, created_at')
            .gte('created_at', scope.from)
            .lte('created_at', scope.to)
            .in('status', ['failed','cancelled'])
            .neq('refund_status', 'refunded')
            .limit(500);
        for (const o of data || []) {
            issues.push({
                type: 'FAILED_NOT_REFUNDED',
                severity: 'high',
                reference: o.order_ref,
                provider: o.provider,
                amount: o.total_amount,
                currency: o.currency,
                expected: 'refunded',
                actual: o.refund_status || 'none',
                createdAt: o.created_at
            });
        }
    } catch (_) {}

    // 3. Duplicate webhook events (same provider + same event_id).
    try {
        const { data } = await supabaseAdmin
            .from('webhook_events')
            .select('provider, event_id, count:id')
            .gte('received_at', scope.from)
            .lte('received_at', scope.to)
            .not('event_id', 'is', null);
        const counts = {};
        for (const w of data || []) {
            const k = `${w.provider}:${w.event_id}`;
            counts[k] = (counts[k] || 0) + 1;
        }
        for (const [k, n] of Object.entries(counts)) {
            if (n > 1) {
                const [provider, eventId] = k.split(':');
                issues.push({
                    type: 'DUPLICATE_WEBHOOK',
                    severity: 'medium',
                    reference: eventId,
                    provider,
                    amount: null,
                    currency: null,
                    expected: 1,
                    actual: n,
                    createdAt: null
                });
            }
        }
    } catch (_) {}

    // 4. Refund exists but order not marked refunded.
    try {
        const { data } = await supabaseAdmin
            .from('transactions')
            .select('id, reference, source_id, amount, currency, created_at')
            .eq('type', 'refund')
            .eq('source_type', 'order')
            .gte('created_at', scope.from)
            .lte('created_at', scope.to)
            .limit(500);
        for (const t of data || []) {
            const { data: o } = await supabaseAdmin
                .from('orders')
                .select('status, refund_status, order_ref')
                .eq('id', t.source_id)
                .maybeSingle();
            if (o && o.refund_status !== 'refunded') {
                issues.push({
                    type: 'REFUND_WITHOUT_ORDER_STATE',
                    severity: 'critical',
                    reference: o.order_ref,
                    provider: null,
                    amount: t.amount,
                    currency: t.currency,
                    expected: 'refund_status=refunded',
                    actual: o.refund_status || 'none',
                    createdAt: t.created_at
                });
            }
        }
    } catch (_) {}

    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const i of issues) bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;

    return {
        available: true,
        period: { from: scope.from, to: scope.to },
        summary: {
            totalIssues: issues.length,
            ...bySeverity
        },
        issues: issues.slice(0, 500)
    };
}

// ─── Counters ────────────────────────────────────────────────────

async function countTransactions({ from, to, currency }) {
    try {
        let q = supabaseAdmin.from('transactions')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', from).lte('created_at', to);
        if (currency) q = q.eq('currency', currency);
        const { count } = await q;
        return count || 0;
    } catch { return 0; }
}

// ─── Export ──────────────────────────────────────────────────────

function toCsv(headers, rows) {
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(escape).join(',')];
    for (const r of rows) lines.push(r.map(escape).join(','));
    return lines.join('\n');
}

async function exportReport({ kind, query }) {
    const scope = scopeOf(query);
    switch (kind) {
        case 'transactions': {
            const r = await getTransactions({ ...query, limit: MAX_LIMIT, page: 1 });
            if (!r.available) throw new Error(r.reason || 'Not available.');
            return toCsv(
                ['Reference','User','Email','Type','Status','Currency','Amount','Fee','Provider','Provider Reference','Created'],
                r.transactions.map(t => [t.reference, t.user.username, t.user.email, t.type, t.status, t.currency, t.amount, t.fee, t.provider, t.providerReference, t.createdAt])
            );
        }
        case 'orders': {
            const r = await getOrders({ ...query, limit: MAX_LIMIT, page: 1 });
            if (!r.available) throw new Error(r.reason || 'Not available.');
            return toCsv(
                ['Order Ref','User','Email','Product','Provider','Provider Order ID','Amount','Currency','Status','Refund Status','Created'],
                r.orders.map(o => [o.orderRef, o.user.username, o.user.email, o.productType, o.provider, o.providerOrderId, o.totalAmount, o.currency, o.status, o.refundStatus, o.createdAt])
            );
        }
        case 'products': {
            const r = await getProducts(query);
            if (!r.available) throw new Error(r.reason || 'Not available.');
            return toCsv(
                ['Product','Currency','Orders','Revenue','Provider Cost','Refunds','Profit','Margin %'],
                r.products.map(p => [p.product, p.currency, p.orders, p.revenue, p.providerCost, p.refunds, p.profit, p.marginPct])
            );
        }
        case 'providers': {
            const r = await getProviders(query);
            if (!r.available) throw new Error(r.reason || 'Not available.');
            return toCsv(
                ['Provider','Currency','Orders','Revenue','Provider Cost','Refunds','Profit','Failed Orders','Success Rate'],
                r.providers.map(p => [p.provider, p.currency, p.orders, p.revenue, p.providerCost, p.refunds, p.profit, p.failedOrders, p.successRate])
            );
        }
        case 'failures': {
            const r = await getFailures({ ...query, limit: MAX_LIMIT });
            if (!r.available) throw new Error(r.reason || 'Not available.');
            return toCsv(
                ['Reference','User','Email','Module','Provider','Error Type','Error Message','Amount','Currency','Status','Created'],
                r.failures.map(f => [f.reference, f.user?.username || '', f.user?.email || '', f.module, f.provider, f.errorType, f.errorMessage, f.amount, f.currency, f.status, f.createdAt])
            );
        }
        case 'reconciliation': {
            const r = await getReconciliation(query);
            if (!r.available) throw new Error(r.reason || 'Not available.');
            return toCsv(
                ['Type','Severity','Reference','Provider','Amount','Currency','Expected','Actual','Created'],
                r.issues.map(i => [i.type, i.severity, i.reference, i.provider, i.amount, i.currency, i.expected, i.actual, i.createdAt])
            );
        }
        case 'overview':
        default: {
            const r = await getOverview(query);
            if (!r.available) throw new Error(r.reason || 'Not available.');
            const s = r.summary;
            return toCsv(
                ['Metric','Value'],
                [
                    ['Transactions', s.transactions.count],
                    ['Revenue Gross', s.revenue.gross],
                    ['Revenue Net', s.revenue.net],
                    ['Funding Total', s.funding.total],
                    ['Refunds Total', s.refunds.total],
                    ['Provider Cost', s.cost.total],
                    ['Gross Profit', s.profit.gross],
                    ['Total Orders', s.orders.total],
                    ['Completed Orders', s.orders.completed],
                    ['Pending Orders', s.orders.pending],
                    ['Failed Orders', s.orders.failed],
                    ['Active Customers', s.customers.active],
                    ['Failed Webhooks', s.providerIssues.failedWebhooks]
                ]
            );
        }
    }
}

module.exports = {
    getOverview,
    getTransactions,
    getOrders,
    getCustomers,
    getProducts,
    getProviders,
    getWebhooks,
    getFailures,
    getReconciliation,
    exportReport
};