// services/revenueService.js
// ─────────────────────────────────────────────────────────────────
// Revenue analytics — financial authority for /admin/revenue.
//
// Definitions enforced here:
//   REVENUE      = money charged to users for a service.
//   PROVIDER COST= what we paid the external provider.
//   PROFIT       = revenue − provider cost.
//   REFUNDS      = money returned.
//   NET REVENUE  = revenue − refunds.
//   FUNDING      = wallet deposits (never revenue).
//   HELD FUNDS   = ledger_accounts.available_balance (liability).
//
// Every number comes from a Postgres RPC or a direct aggregate
// query — never from loading rows into Node.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

const EXCLUDED_PRODUCT_TYPES = ['deposit', 'wallet_funding', 'transfer', 'withdrawal'];

// ─── Config ──────────────────────────────────────────────────────

async function getUsdToNgnRate() {
    try {
        const { data } = await supabaseAdmin
            .from('app_config')
            .select('value')
            .eq('key', 'usd_to_ngn')
            .maybeSingle();
        if (data?.value) {
            const n = Number(data.value);
            if (Number.isFinite(n) && n > 0) return n;
        }
    } catch (_) {}
    return Number(process.env.MILESSPACE_USD_TO_NGN || 1600);
}

// ─── Helpers ─────────────────────────────────────────────────────

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

function previousPeriod(from, to) {
    const f = new Date(from).getTime();
    const t = new Date(to).getTime();
    const span = t - f;
    return {
        from: new Date(f - span).toISOString(),
        to:   new Date(f - 1).toISOString()
    };
}

function pctChange(current, previous) {
    const c = Number(current || 0);
    const p = Number(previous || 0);
    if (p === 0 && c === 0) return 0;
    if (p === 0) return null;
    return Math.round(((c - p) / p) * 10000) / 100;
}

// ─── Summary ─────────────────────────────────────────────────────

async function getSummary({ from, to, currency = null }) {
    const fromIso = iso(from) || watDayBounds().start;
    const toIso   = iso(to)   || watDayBounds().end;

    const [currentRpc, prevRpc, fundingRpc, heldRes] = await Promise.all([
        supabaseAdmin.rpc('revenue_summary', { p_from: fromIso, p_to: toIso, p_currency: currency }),
        supabaseAdmin.rpc('revenue_summary', { p_from: previousPeriod(fromIso, toIso).from, p_to: previousPeriod(fromIso, toIso).to, p_currency: currency }),
        supabaseAdmin.rpc('revenue_funding_summary', { p_from: fromIso, p_to: toIso, p_currency: currency }),
        supabaseAdmin.from('ledger_accounts').select('currency, available_balance')
    ]);

    // If the RPC is missing, the migration hasn't been run.
    const rpcMissing =
        (currentRpc.error && ['42883','PGRST202'].includes(currentRpc.error.code)) ||
        (prevRpc.error && ['42883','PGRST202'].includes(prevRpc.error.code));

    if (rpcMissing) {
        return {
            available: false,
            reason: 'REVENUE_RPC_NOT_DEPLOYED',
            message: 'Run migrations/2025_revenue_analytics.sql to enable revenue analytics.',
            from: fromIso, to: toIso, currency
        };
    }

    const cur = (currentRpc.data || []);
    const prev = (prevRpc.data || []);
    const funding = (fundingRpc.data || []);

    // Sum across currencies when `currency` filter is null.
    const sum = (rows, key) => rows.reduce((acc, r) => acc + Number(r[key] || 0), 0);
    const curRevenue = sum(cur, 'gross_revenue');
    const prevRevenue = sum(prev, 'gross_revenue');

    // Held funds (liability, not revenue). Always from ledger.
    let heldNgn = 0, heldUsd = 0;
    for (const a of heldRes.data || []) {
        if (a.currency === 'NGN') heldNgn += Number(a.available_balance || 0);
        if (a.currency === 'USD') heldUsd += Number(a.available_balance || 0);
    }

    const usdToNgn = await getUsdToNgnRate();

    return {
        available: true,
        from: fromIso,
        to: toIso,
        currency: currency || null,
        usdToNgn,

        // Service revenue (the real number).
        revenue: {
            gross:     String(sum(cur, 'gross_revenue').toFixed(2)),
            net:       String(sum(cur, 'net_revenue').toFixed(2)),
            providerCost: String(sum(cur, 'provider_cost').toFixed(2)),
            profit:    String(sum(cur, 'gross_profit').toFixed(2)),
            refunds:   String(sum(cur, 'refunds').toFixed(2)),
            changePct: pctChange(curRevenue, prevRevenue)
        },

        // Orders.
        orders: {
            total:      sum(cur, 'total_orders'),
            completed:  sum(cur, 'completed_orders'),
            pending:    sum(cur, 'pending_orders'),
            failed:     sum(cur, 'failed_orders'),
            refunded:   sum(cur, 'refunded_orders')
        },

        // Wallet funding (NOT revenue).
        funding: {
            depositsCount: sum(funding, 'deposits_count'),
            depositsTotal: String(sum(funding, 'deposits_total').toFixed(2)),
            avgDeposit:    funding.length ? String((sum(funding, 'deposits_total') / Math.max(sum(funding, 'deposits_count'), 1)).toFixed(2)) : '0.00',
            largestDeposit: String(Math.max(0, ...funding.map(r => Number(r.largest_deposit || 0))).toFixed(2))
        },

        // User funds held (liability, not revenue).
        heldFunds: {
            ngn: String(heldNgn.toFixed(2)),
            usd: String(heldUsd.toFixed(2))
        },

        // Per-currency breakdown so nothing is hidden by mixing.
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

// ─── Timeseries ──────────────────────────────────────────────────

async function getTimeseries({ from, to, currency = null, granularity = 'day' }) {
    const fromIso = iso(from) || watDayBounds().start;
    const toIso   = iso(to)   || watDayBounds().end;
    const grain = ['day','week','month'].includes(granularity) ? granularity : 'day';

    const { data, error } = await supabaseAdmin.rpc('revenue_timeseries', {
        p_from: fromIso, p_to: toIso,
        p_granularity: grain,
        p_currency: currency
    });

    if (error) {
        if (['42883','PGRST202'].includes(error.code)) {
            return { available: false, reason: 'REVENUE_RPC_NOT_DEPLOYED' };
        }
        throw new Error(`Timeseries failed: ${error.message}`);
    }

    // Fold rows by bucket, adding NGN and USD so the chart has one
    // series per currency and never mixes them.
    const byBucket = new Map();
    for (const r of data || []) {
        const key = r.bucket;
        if (!byBucket.has(key)) {
            byBucket.set(key, { bucket: key, NGN: null, USD: null, orders: 0 });
        }
        const entry = byBucket.get(key);
        entry[r.currency] = {
            revenue:      String(r.revenue || '0.00'),
            providerCost: String(r.provider_cost || '0.00'),
            refunds:      String(r.refunds || '0.00'),
            profit:       String(r.profit || '0.00')
        };
        entry.orders += Number(r.orders || 0);
    }

    return {
        available: true,
        granularity: grain,
        from: fromIso, to: toIso,
        points: Array.from(byBucket.values()).sort((a, b) => new Date(a.bucket) - new Date(b.bucket))
    };
}

// ─── By product ──────────────────────────────────────────────────

async function getByProduct({ from, to, currency = null }) {
    const fromIso = iso(from) || watDayBounds().start;
    const toIso   = iso(to)   || watDayBounds().end;

    const { data, error } = await supabaseAdmin.rpc('revenue_by_product', {
        p_from: fromIso, p_to: toIso, p_currency: currency
    });
    if (error) {
        if (['42883','PGRST202'].includes(error.code)) return { available: false, reason: 'REVENUE_RPC_NOT_DEPLOYED' };
        throw new Error(`Product breakdown failed: ${error.message}`);
    }
    return {
        available: true,
        from: fromIso, to: toIso,
        products: (data || []).map(r => ({
            product:       r.product,
            currency:      r.currency,
            orders:        Number(r.orders || 0),
            revenue:       String(r.revenue || '0.00'),
            providerCost:  String(r.provider_cost || '0.00'),
            refunds:       String(r.refunds || '0.00'),
            profit:        String(r.profit || '0.00'),
            marginPct:     Number(r.margin_pct || 0)
        }))
    };
}

// ─── By provider ─────────────────────────────────────────────────

async function getByProvider({ from, to, currency = null }) {
    const fromIso = iso(from) || watDayBounds().start;
    const toIso   = iso(to)   || watDayBounds().end;

    const { data, error } = await supabaseAdmin.rpc('revenue_by_provider', {
        p_from: fromIso, p_to: toIso, p_currency: currency
    });
    if (error) {
        if (['42883','PGRST202'].includes(error.code)) return { available: false, reason: 'REVENUE_RPC_NOT_DEPLOYED' };
        throw new Error(`Provider breakdown failed: ${error.message}`);
    }
    return {
        available: true,
        from: fromIso, to: toIso,
        providers: (data || []).map(r => ({
            provider:      r.provider,
            currency:      r.currency,
            orders:        Number(r.orders || 0),
            revenue:       String(r.revenue || '0.00'),
            providerCost:  String(r.provider_cost || '0.00'),
            refunds:       String(r.refunds || '0.00'),
            profit:        String(r.profit || '0.00'),
            failedOrders:  Number(r.failed_orders || 0)
        }))
    };
}

// ─── Refunds ─────────────────────────────────────────────────────

async function getRefunds({ from, to, currency = null, limit = 100 }) {
    const fromIso = iso(from) || watDayBounds().start;
    const toIso   = iso(to)   || watDayBounds().end;

    const { data, error } = await supabaseAdmin.rpc('revenue_refunds', {
        p_from: fromIso, p_to: toIso, p_currency: currency, p_limit: Math.min(limit, 500)
    });
    if (error) {
        if (['42883','PGRST202'].includes(error.code)) return { available: false, reason: 'REVENUE_RPC_NOT_DEPLOYED' };
        throw new Error(`Refunds query failed: ${error.message}`);
    }

    const userIds = [...new Set((data || []).map(r => r.user_id).filter(Boolean))];
    let profilesById = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles').select('id, username, email').in('id', userIds);
        for (const p of profiles || []) profilesById[p.id] = p;
    }

    return {
        available: true,
        from: fromIso, to: toIso,
        refunds: (data || []).map(r => {
            const p = profilesById[r.user_id] || {};
            return {
                orderRef:     r.order_ref,
                product:      r.product_type,
                provider:     r.provider,
                currency:     r.currency,
                amount:       String(r.refund_amount || '0.00'),
                reference:    r.refund_reference,
                refundedAt:   r.refunded_at,
                reason:       r.reason,
                user: {
                    id: r.user_id,
                    username: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    email: p.email || null
                }
            };
        })
    };
}

// ─── Top customers ───────────────────────────────────────────────

async function getTopCustomers({ from, to, limit = 20 }) {
    const fromIso = iso(from) || watDayBounds().start;
    const toIso   = iso(to)   || watDayBounds().end;

    const { data, error } = await supabaseAdmin.rpc('revenue_top_customers', {
        p_from: fromIso, p_to: toIso, p_limit: Math.min(limit, 100)
    });
    if (error) {
        if (['42883','PGRST202'].includes(error.code)) return { available: false, reason: 'REVENUE_RPC_NOT_DEPLOYED' };
        throw new Error(`Top customers failed: ${error.message}`);
    }

    const userIds = (data || []).map(r => r.user_id).filter(Boolean);
    let profilesById = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles').select('id, username, email').in('id', userIds);
        for (const p of profiles || []) profilesById[p.id] = p;
    }

    return {
        available: true,
        from: fromIso, to: toIso,
        customers: (data || []).map(r => {
            const p = profilesById[r.user_id] || {};
            return {
                user: {
                    id: r.user_id,
                    username: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    email: p.email || null
                },
                orders:    Number(r.orders || 0),
                spent:     String(r.spent || '0.00'),
                refunded:  String(r.refunded || '0.00'),
                netSpend:  String(r.net_spend || '0.00'),
                lastOrder: r.last_order
            };
        })
    };
}

// ─── Funding vs revenue ──────────────────────────────────────────

async function getFunding({ from, to, currency = null }) {
    const fromIso = iso(from) || watDayBounds().start;
    const toIso   = iso(to)   || watDayBounds().end;

    const { data, error } = await supabaseAdmin.rpc('revenue_funding_summary', {
        p_from: fromIso, p_to: toIso, p_currency: currency
    });
    if (error) {
        if (['42883','PGRST202'].includes(error.code)) return { available: false, reason: 'REVENUE_RPC_NOT_DEPLOYED' };
        throw new Error(`Funding failed: ${error.message}`);
    }
    return {
        available: true,
        from: fromIso, to: toIso,
        funding: (data || []).map(r => ({
            currency:       r.currency,
            depositsCount:  Number(r.deposits_count || 0),
            depositsTotal:  String(r.deposits_total || '0.00'),
            avgDeposit:     String(r.avg_deposit || '0.00'),
            largestDeposit: String(r.largest_deposit || '0.00')
        }))
    };
}

// ─── Daily table ─────────────────────────────────────────────────

async function getDailyTable({ from, to, currency = null }) {
    const ts = await getTimeseries({ from, to, currency, granularity: 'day' });
    if (!ts.available) return ts;
    return {
        available: true,
        from: ts.from, to: ts.to,
        days: ts.points
    };
}

// ─── Export ──────────────────────────────────────────────────────

async function exportCsv({ from, to, currency = null, kind = 'summary' }) {
    if (kind === 'products') {
        const r = await getByProduct({ from, to, currency });
        if (!r.available) throw new Error('Revenue RPCs not deployed.');
        const lines = [['Product','Currency','Orders','Revenue','Provider Cost','Refunds','Profit','Margin %'].join(',')];
        for (const p of r.products) {
            lines.push([p.product, p.currency, p.orders, p.revenue, p.providerCost, p.refunds, p.profit, p.marginPct]
                .map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
        }
        return lines.join('\n');
    }
    if (kind === 'providers') {
        const r = await getByProvider({ from, to, currency });
        if (!r.available) throw new Error('Revenue RPCs not deployed.');
        const lines = [['Provider','Currency','Orders','Revenue','Provider Cost','Refunds','Profit','Failed Orders'].join(',')];
        for (const p of r.providers) {
            lines.push([p.provider, p.currency, p.orders, p.revenue, p.providerCost, p.refunds, p.profit, p.failedOrders]
                .map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
        }
        return lines.join('\n');
    }
    if (kind === 'refunds') {
        const r = await getRefunds({ from, to, currency, limit: 500 });
        if (!r.available) throw new Error('Revenue RPCs not deployed.');
        const lines = [['Order','Customer','Email','Product','Provider','Currency','Amount','Reference','Reason','Refunded At'].join(',')];
        for (const x of r.refunds) {
            lines.push([x.orderRef, x.user.username, x.user.email || '', x.product, x.provider, x.currency, x.amount, x.reference || '', x.reason || '', x.refundedAt]
                .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
        }
        return lines.join('\n');
    }
    // Default: summary
    const r = await getSummary({ from, to, currency });
    if (!r.available) throw new Error('Revenue RPCs not deployed.');
    const rows = [
        ['Metric', 'Value'],
        ['Gross Revenue', r.revenue.gross],
        ['Net Revenue', r.revenue.net],
        ['Provider Cost', r.revenue.providerCost],
        ['Profit', r.revenue.profit],
        ['Refunds', r.revenue.refunds],
        ['Total Orders', r.orders.total],
        ['Completed Orders', r.orders.completed],
        ['Pending Orders', r.orders.pending],
        ['Failed Orders', r.orders.failed],
        ['Refunded Orders', r.orders.refunded],
        ['Wallet Deposits Count', r.funding.depositsCount],
        ['Wallet Deposits Total', r.funding.depositsTotal],
        ['User Funds Held (NGN)', r.heldFunds.ngn],
        ['User Funds Held (USD)', r.heldFunds.usd],
        ['FX Rate (USD → NGN)', r.usdToNgn]
    ];
    return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    getUsdToNgnRate,
    getSummary,
    getTimeseries,
    getByProduct,
    getByProvider,
    getRefunds,
    getTopCustomers,
    getFunding,
    getDailyTable,
    exportCsv
};