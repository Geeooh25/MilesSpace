// routes/admin/dashboardRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin dashboard endpoints. One authoritative implementation.
//
// URLs:
//   GET /api/admin/stats
//   GET /api/admin/recent-activity
//   GET /api/admin/users/recent
//   GET /api/admin/transactions/recent
//   GET /api/admin/charts
//   GET /api/admin/health
//   GET /api/admin/notifications/recent
//   GET /api/admin/me
//   GET /api/admin/services/performance
//   GET /api/admin/providers/health
//   GET /api/admin/needs-attention
//   GET /api/admin/orders/failed/recent
//   GET /api/admin/deposits/recent
//   GET /api/admin/deposits/today-summary
//   GET /api/admin/webhooks/recent
//   GET /api/admin/logins/today
//   GET /api/admin/reconciliation/exceptions/count
//
// Presence endpoints are NOT declared here — there are none.
//
// Nothing fabricated. Nothing swallowed.
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { adminAuth, requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { buildPermissionMap } = require('../../middleware/adminPermissions');
const agg = require('./dashboardAggregations');

// ─── Response helpers ────────────────────────────────────────────
function unwrap(field) {
    if (!field || typeof field !== 'object') return field ?? null;
    if (field.available === true) return field.value;
    return null;
}

function limitOf(q, def = 20, max = 100) {
    const n = parseInt(q, 10);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(n, max);
}

function fail(res, err) {
    const status = err?.status || 500;
    const code = err?.code || 'SERVER_ERROR';
    const message = err?.message || 'Unexpected error';
    console.error('[ADMIN DASHBOARD]', code, message);
    if (res.headersSent) return;
    res.status(status).json({ success: false, error: message, code });
}

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/stats
// ═════════════════════════════════════════════════════════════════

router.get(
    '/stats',
    requirePermission(PERMISSIONS.DASHBOARD_READ),
    async (req, res) => {
        try {
            const [users, wallet, deposits, tx, revenue, support, notif, logins, presence] = await Promise.all([
                agg.getUserStats(),
                agg.getWalletLiabilities(),
                agg.getDepositStats(),
                agg.getTransactionStats(),
                agg.getRevenueStats(),
                agg.getSupportStats(),
                agg.getNotificationStats(),
                agg.getLoginsTodayDetailed({ limit: 1 }),
                agg.getPresenceStats()
            ]);

            const meta = {
                users_total:                users.total.available,
                users_customers:            users.customers.available,
                users_new_today:            users.newToday.available,
                users_new_month:            users.newMonth.available,
                users_suspended:            users.suspended.available,
                users_active_today:         presence.activeToday.available,
                users_online_now:           presence.onlineNow.available,
                wallet_ngn_liability:       wallet.ngn.available,
                wallet_usd_liability:       wallet.usd.available,
                deposits_today:             deposits.today.count.available,
                transactions_today:         tx.today.count.available,
                revenue_today_ngn:          revenue.todayNgn.available,
                revenue_today_usd:          revenue.todayUsd.available,
                support_open:               support.open.available,
                notifications_unread:       notif.unread.available,
                logins_today:               logins.available,
                crypto_pending:             deposits.byProvider?.nowpayments?.pending?.available === true
            };

            const statsData = {
                // ─── Users ─────────────────────────────────────
                totalUsers:     unwrap(users.total),
                totalCustomers: unwrap(users.customers),
                newUsersToday:  unwrap(users.newToday),
                newUsersMonth:  unwrap(users.newMonth),
                suspendedUsers: unwrap(users.suspended),
                loginsToday:    logins.available ? (logins.total ?? null) : null,
                activeToday:    unwrap(presence.activeToday),
                onlineNow:      unwrap(presence.onlineNow),

                // ─── Wallet (ledger is source of truth) ────────
                walletBalance: {
                    ngn: unwrap(wallet.ngn),
                    usd: unwrap(wallet.usd)
                },

                // ─── Deposits ──────────────────────────────────
                deposits: {
                    today: {
                        count: unwrap(deposits.today.count),
                        ngn:   unwrap(deposits.today.ngn),
                        usd:   unwrap(deposits.today.usd)
                    },
                    month: {
                        count: unwrap(deposits.month.count),
                        ngn:   unwrap(deposits.month.ngn),
                        usd:   unwrap(deposits.month.usd)
                    },
                    pending:   unwrap(deposits.pending),
                    failed:    unwrap(deposits.failed),
                    completed: unwrap(deposits.completed),
                    byProvider: deposits.byProvider
                },

                // ─── Transactions ──────────────────────────────
                transactions: {
                    today: {
                        count: unwrap(tx.today.count),
                        ngn:   unwrap(tx.today.ngn),
                        usd:   unwrap(tx.today.usd)
                    },
                    month: {
                        count: unwrap(tx.month.count),
                        ngn:   unwrap(tx.month.ngn),
                        usd:   unwrap(tx.month.usd)
                    },
                    completed: unwrap(tx.byStatus.completed),
                    pending:   unwrap(tx.byStatus.pending),
                    failed:    unwrap(tx.byStatus.failed)
                },

                // ─── Revenue (fees + markup, NOT volume) ───────
                revenue: {
                    today:   { ngn: unwrap(revenue.todayNgn), usd: unwrap(revenue.todayUsd) },
                    monthly: { ngn: unwrap(revenue.monthNgn), usd: unwrap(revenue.monthUsd) }
                },

                // ─── Pending ───────────────────────────────────
                // cryptoOrders is null (not 0) when the backend could
                // not confirm the value. The frontend renders "—".
                pending: {
                    deposits:     unwrap(deposits.pending),
                    cryptoOrders: unwrap(deposits.byProvider?.nowpayments?.pending)
                },

                support:       { open: unwrap(support.open) },
                notifications: { unread: unwrap(notif.unread) },

                features: { withdrawals: false },

                _meta: meta,
                generatedAt: new Date().toISOString()
            };

            res.json({ success: true, data: statsData });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/recent-activity
// ═════════════════════════════════════════════════════════════════

router.get(
    '/recent-activity',
    requirePermission(PERMISSIONS.DASHBOARD_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 20, 100);

            // Fetch the transactions and their users separately so a
            // broken profile relationship never blocks the whole feed.
            const { data: txRows, error: txErr } = await supabaseAdmin
                .from('transactions')
                .select('id, user_id, type, status, currency, amount, description, ref, reference, created_at')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (txErr) {
                console.error('[ADMIN DASHBOARD] activity tx error:', txErr.message);
                return fail(res, { status: 500, code: 'ACTIVITY_ERROR', message: txErr.message });
            }

            const userIds = [...new Set((txRows || []).map(t => t.user_id).filter(Boolean))];
            let profilesById = {};
            if (userIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email')
                    .in('id', userIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const items = (txRows || []).map(t => {
                const p = profilesById[t.user_id] || {};
                const username = p.username || (p.email ? p.email.split('@')[0] : 'User');
                return {
                    id: t.id,
                    userId: t.user_id,
                    username,
                    userEmail: p.email || '',
                    action: t.type || 'transaction',
                    category: 'transaction',
                    description: `${username} — ${t.description || t.type}`,
                    details: {
                        amount: t.amount ?? null,
                        currency: t.currency || 'NGN',
                        reference: t.ref || t.reference,
                        status: t.status
                    },
                    created_at: t.created_at,
                    icon: iconForType(t.type),
                    statusBadge: badgeForStatus(t.status),
                    isSuccess: ['completed', 'success', 'delivered'].includes(String(t.status || '').toLowerCase())
                };
            });

            res.json({ success: true, data: items, total: items.length });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/users/recent
// ═════════════════════════════════════════════════════════════════

router.get(
    '/users/recent',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 10, 50);
            const { data, error } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email, phone, created_at, last_location, is_verified, status, role')
                .is('deleted_at', null)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) {
                console.error('[ADMIN DASHBOARD] recent users error:', error.message);
                return fail(res, { status: 500, code: 'USERS_QUERY_ERROR', message: error.message });
            }

            const users = (data || []).map(u => ({
                id: u.id,
                username: u.username || u.email?.split('@')[0] || 'User',
                email: u.email || '',
                phone: u.phone || 'N/A',
                created_at: u.created_at,
                last_location: u.last_location || 'N/A',
                is_verified: !!u.is_verified,
                status: u.status || 'active',
                role: u.role || 'user',
                initials: (u.username || u.email || 'U').charAt(0).toUpperCase()
            }));

            res.json({ success: true, data: users });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/transactions/recent
//  Dashboard preview. Never the complete history.
// ═════════════════════════════════════════════════════════════════

router.get(
    '/transactions/recent',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 10, 50);

            const { data, error } = await supabaseAdmin
                .from('transactions')
                .select(`
                    id, user_id, type, status, currency, amount, fee,
                    ref, reference, description, metadata, meta,
                    provider, provider_reference,
                    created_at, completed_at, failed_at, failure_reason
                `)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) {
                console.error('[ADMIN DASHBOARD] transactions error:', error.message);
                return fail(res, { status: 500, code: 'TRANSACTIONS_QUERY_FAILED', message: error.message });
            }

            const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
            let profilesById = {};
            if (userIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email')
                    .in('id', userIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const transactions = (data || []).map(tx => {
                const p = profilesById[tx.user_id] || {};
                return {
                    id: tx.id,
                    user_id: tx.user_id,
                    type: tx.type,
                    status: tx.status,
                    currency: tx.currency || 'NGN',
                    amount: tx.amount ?? null,
                    fee: tx.fee ?? null,
                    reference: tx.ref || tx.reference,
                    description: tx.description,
                    metadata: tx.metadata || tx.meta || {},
                    provider: tx.provider,
                    provider_reference: tx.provider_reference,
                    created_at: tx.created_at,
                    completed_at: tx.completed_at,
                    failed_at: tx.failed_at,
                    failure_reason: tx.failure_reason,
                    user: {
                        id: tx.user_id,
                        username: p.username || (p.email ? p.email.split('@')[0] : 'Unknown User'),
                        email: p.email || ''
                    }
                };
            });

            // Preserve the envelope shape the dashboard frontend reads.
            // The frontend also accepts `user_name` / `user_email`; both
            // are populated for backward compatibility.
            res.json({
                success: true,
                transactions: transactions.map(t => ({
                    ...t,
                    user_name: t.user.username,
                    user_email: t.user.email
                }))
            });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/charts
//  All aggregation happens in Postgres via RPC.
// ═════════════════════════════════════════════════════════════════

router.get(
    '/charts',
    requirePermission(PERMISSIONS.DASHBOARD_READ),
    async (req, res) => {
        try {
            const [revenueRpc, weeklyRpc, growthRpc, orderRpc] = await Promise.all([
                supabaseAdmin.rpc('admin_charts_revenue_12m'),
                supabaseAdmin.rpc('admin_charts_weekly'),
                supabaseAdmin.rpc('admin_charts_user_growth_12m'),
                supabaseAdmin.rpc('admin_charts_order_breakdown')
            ]);

            if (revenueRpc.error && revenueRpc.error.code === '42883') {
                return fail(res, {
                    status: 500,
                    code: 'CHARTS_RPC_NOT_DEPLOYED',
                    message: 'Charts RPC not deployed. Run migrations/2025_admin_agg.sql.'
                });
            }

            const revenueRows = revenueRpc.data || [];
            const weeklyRow = Array.isArray(weeklyRpc.data) ? weeklyRpc.data[0] : weeklyRpc.data;
            const growthRows = growthRpc.data || [];
            const orderRow = Array.isArray(orderRpc.data) ? orderRpc.data[0] : orderRpc.data;

            // Revenue: array of 12, one per month index (oldest first)
            const revenueNgn = new Array(12).fill('0.00');
            const revenueUsd = new Array(12).fill('0.00');
            for (const r of revenueRows) {
                const idx = Number(r.month_offset ?? 0);
                if (idx >= 0 && idx < 12) {
                    const slot = 11 - idx;   // oldest → index 0
                    if (r.currency === 'USD') revenueUsd[slot] = String(r.total || '0.00');
                    else revenueNgn[slot] = String(r.total || '0.00');
                }
            }

            // Weekly: 7 NGN daily buckets, oldest → newest
            const weeklyData = new Array(7).fill('0.00');
            const weeklyList = Array.isArray(weeklyRpc.data) ? weeklyRpc.data : [];
            for (const r of weeklyList) {
                const idx = Number(r.day_index ?? -1);
                if (idx >= 0 && idx < 7) weeklyData[idx] = String(r.total || '0.00');
            }

            // User growth: cumulative by month, oldest → newest
            const userGrowth = new Array(12).fill(0);
            for (const r of growthRows) {
                const idx = Number(r.month_offset ?? 0);
                if (idx >= 0 && idx < 12) userGrowth[11 - idx] = Number(r.cumulative || 0);
            }

            const order = orderRow || {};
            const cryptoOrders = {
                labels: ['Pending','Processing','Completed','Failed'],
                data: [
                    Number(order.crypto_pending || 0),
                    Number(order.crypto_processing || 0),
                    Number(order.crypto_completed || 0),
                    Number(order.crypto_failed || 0)
                ]
            };
            const boostOrders = {
                labels: ['Pending','Processing','Completed','Failed'],
                data: [
                    Number(order.boost_pending || 0),
                    Number(order.boost_processing || 0),
                    Number(order.boost_completed || 0),
                    Number(order.boost_failed || 0)
                ]
            };
            const smsOrders = {
                labels: ['Pending','Active','Completed'],
                data: [
                    Number(order.sms_pending || 0),
                    Number(order.sms_processing || 0),
                    Number(order.sms_completed || 0)
                ]
            };
            const marketOrders = {
                labels: ['Pending','Processing','Completed'],
                data: [
                    Number(order.market_pending || 0),
                    Number(order.market_processing || 0),
                    Number(order.market_completed || 0)
                ]
            };
            const giftOrders = {
                labels: ['Pending','Processing','Completed','Failed'],
                data: [
                    Number(order.gift_pending || 0),
                    Number(order.gift_processing || 0),
                    Number(order.gift_completed || 0),
                    Number(order.gift_failed || 0)
                ]
            };

            const chartData = {
                revenue: revenueNgn,
                revenueUSD: revenueUsd,
                userGrowth,
                weeklyRevenue: {
                    data: weeklyData,
                    labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
                },
                cryptoOrders,
                boostOrders,
                smsOrders,
                marketplaceOrders: marketOrders,
                giftCardSales: giftOrders,
                // Explicit "not implemented" markers. Never a fake zero.
                expenses: { available: false, reason: 'EXPENSE_LEDGER_NOT_IMPLEMENTED' },
                walletBreakdown: { available: false, reason: 'WITHDRAWALS_DISABLED' },
                cashbackActivity: { available: false, reason: 'CASHBACK_NOT_USED' },
                topCountries: { available: false, reason: 'NOT_IMPLEMENTED' },
                topCustomers: { available: false, reason: 'NOT_IMPLEMENTED' }
            };

            res.json({ success: true, data: chartData });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/health
// ═════════════════════════════════════════════════════════════════

router.get(
    '/health',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    async (req, res) => {
        try {
            const data = await agg.getSystemHealth();
            res.json({ success: true, data });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/notifications/recent
// ═════════════════════════════════════════════════════════════════

router.get(
    '/notifications/recent',
    requirePermission(PERMISSIONS.NOTIFICATIONS_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 5, 20);
            const { data, error } = await supabaseAdmin
                .from('notifications')
                .select('id, user_id, title, message, icon, type, is_read, created_at, metadata')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) {
                if (error.code === '42P01') {
                    return res.json({
                        success: true, data: [],
                        _meta: { available: false, reason: 'NOTIFICATIONS_TABLE_NOT_FOUND' }
                    });
                }
                console.error('[ADMIN DASHBOARD] notifications error:', error.message);
                return fail(res, { status: 500, code: 'NOTIFICATIONS_ERROR', message: error.message });
            }

            const notifications = (data || []).map(n => ({
                id: n.id,
                user_id: n.user_id,
                title: n.title || 'Notification',
                message: n.message || '',
                icon: n.icon || '📌',
                type: n.type || 'info',
                is_read: !!n.is_read,
                created_at: n.created_at,
                time_ago: humanTime(n.created_at),
                metadata: n.metadata || {}
            }));

            res.json({ success: true, data: notifications, _meta: { available: true } });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/me
// ═════════════════════════════════════════════════════════════════

router.get('/me', adminAuth, async (req, res) => {
    try {
        const ctx = req.adminContext;
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, role, avatar_url, created_at')
            .eq('id', ctx.id)
            .single();

        if (error) return fail(res, { status: 404, code: 'ADMIN_NOT_FOUND', message: 'Admin not found' });

        res.json({
            success: true,
            data: {
                user: {
                    id: data.id,
                    username: data.username || data.email?.split('@')[0] || 'Admin',
                    email: data.email || '',
                    role: data.role || 'admin',
                    avatar_url: data.avatar_url || null,
                    created_at: data.created_at
                },
                permissions: buildPermissionMap(ctx),
                role: ctx.role,
                isSuperAdmin: ctx.isSuperAdmin
            }
        });
    } catch (err) { fail(res, err); }
});

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/services/performance
//  Aggregated by RPC. NGN and USD kept separate.
// ═════════════════════════════════════════════════════════════════

router.get(
    '/services/performance',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const start = req.query.from || agg.watMonthBounds().start;
            const end   = req.query.to   || new Date().toISOString();

            const { data, error } = await supabaseAdmin.rpc('admin_services_performance', {
                p_from: start,
                p_to:   end
            });

            if (error) {
                if (error.code === '42883') {
                    return fail(res, {
                        status: 500,
                        code: 'SERVICES_PERF_RPC_NOT_DEPLOYED',
                        message: 'Run migrations/2025_admin_agg.sql.'
                    });
                }
                console.error('[ADMIN DASHBOARD] services perf error:', error.message);
                return fail(res, { status: 500, code: 'SERVICE_PERF_ERROR', message: error.message });
            }

            const rows = (data || []).map(r => ({
                service:     r.service,
                label:       prettyService(r.service),
                orders:      Number(r.orders || 0),
                completed:   Number(r.completed || 0),
                pending:     Number(r.pending || 0),
                failed:      Number(r.failed || 0),
                volumeNgn:   String(r.volume_ngn || '0.00'),
                volumeUsd:   String(r.volume_usd || '0.00'),
                revenueNgn:  String(r.revenue_ngn || '0.00'),
                revenueUsd:  String(r.revenue_usd || '0.00'),
                successRate: Number(r.orders || 0) > 0
                             ? +((Number(r.completed || 0) / Number(r.orders || 0)) * 100).toFixed(1)
                             : 0,
                route:       serviceRoute(r.service)
            }));

            res.json({ success: true, data: rows, from: start, to: end });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/providers/health
// ═════════════════════════════════════════════════════════════════

router.get(
    '/providers/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const providerConfigs = [
                { key: 'kora',        name: 'KoraPay',     envs: ['KORA_SECRET_KEY'],     table: 'deposit_requests', providerFilter: 'korapay', providerColumn: 'provider' },
                { key: 'nowpayments', name: 'NowPayments', envs: ['NOWPAYMENTS_API_KEY'], table: 'crypto_deposits',  providerFilter: null,     providerColumn: null },
                { key: 'vtpass',      name: 'VTpass',      envs: ['VTPASS_API_KEY'],      table: 'transactions',     providerFilter: 'vtpass', providerColumn: 'provider' },
                { key: 'dtone',       name: 'DT One',      envs: ['DTONE_API_KEY'],       table: 'transactions',     providerFilter: 'dtone',  providerColumn: 'provider' }
            ];

            const day = agg.watDayBounds();
            const providers = [];

            for (const p of providerConfigs) {
                const configured = p.envs.every(e => !!process.env[e]);
                let lastSuccess = null, lastFailure = null, recentCount = 0;

                if (configured) {
                    try {
                        let q = supabaseAdmin
                            .from(p.table)
                            .select('status, created_at')
                            .gte('created_at', day.start);
                        if (p.providerFilter && p.providerColumn) {
                            q = q.eq(p.providerColumn, p.providerFilter);
                        }
                        const { data, error } = await q.limit(200);
                        if (error) {
                            console.warn('[ADMIN DASHBOARD] provider health query error for', p.key, error.message);
                        }
                        for (const r of data || []) {
                            const st = String(r.status || '').toLowerCase();
                            const ts = r.created_at;
                            if (st === 'completed' || st === 'success') {
                                if (!lastSuccess || ts > lastSuccess) lastSuccess = ts;
                            } else if (st === 'failed' || st === 'cancelled') {
                                if (!lastFailure || ts > lastFailure) lastFailure = ts;
                            }
                        }
                        recentCount = (data || []).length;
                    } catch (e) {
                        console.warn('[ADMIN DASHBOARD] provider health exception for', p.key, e.message);
                    }
                }

                const status = !configured ? 'not_configured'
                    : (recentCount === 0) ? 'unknown'
                    : (!lastFailure && recentCount > 0) ? 'operational'
                    : (lastFailure && lastSuccess && lastSuccess > lastFailure) ? 'operational'
                    : (lastFailure && (!lastSuccess || lastFailure > lastSuccess)) ? 'degraded'
                    : 'unknown';

                providers.push({
                    key: p.key,
                    name: p.name,
                    status,
                    configured,
                    lastSuccess,
                    lastFailure,
                    recentCount,
                    lastChecked: new Date().toISOString(),
                    note: 'Heuristic: recent activity only. Not a live health check.'
                });
            }

            res.json({ success: true, data: providers });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/needs-attention
// ═════════════════════════════════════════════════════════════════

router.get(
    '/needs-attention',
    requirePermission(PERMISSIONS.DASHBOARD_READ),
    async (req, res) => {
        try {
            const items = [];
            const day = agg.watDayBounds();

            const tryCount = async (label, fn) => {
                try {
                    const { count, error } = await fn();
                    if (error) {
                        console.warn('[ADMIN DASHBOARD] needs-attention query failed:', label, error.message);
                        return null;
                    }
                    return count || 0;
                } catch (e) {
                    console.warn('[ADMIN DASHBOARD] needs-attention exception:', label, e.message);
                    return null;
                }
            };

            const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

            const stuckDeposits = await tryCount('stuck_deposits', () =>
                supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true })
                    .in('status', ['pending', 'processing']).lt('created_at', cutoff)
            );
            if (stuckDeposits && stuckDeposits > 0) items.push({
                type: 'stuck_deposits', severity: 'high',
                title: 'Stuck deposits',
                description: `${stuckDeposits} deposit(s) pending for >30 min`,
                count: stuckDeposits, route: '/admin/deposits?status=pending'
            });

            const cryptoReview = await tryCount('crypto_manual_review', () =>
                supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true })
                    .eq('status', 'manual_review')
            );
            if (cryptoReview && cryptoReview > 0) items.push({
                type: 'crypto_manual_review', severity: 'high',
                title: 'Crypto deposits in manual review',
                description: `${cryptoReview} case(s) need investigation`,
                count: cryptoReview, route: '/admin/crypto?status=manual_review'
            });

            const failedToday = await tryCount('failed_transactions_today', () =>
                supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true })
                    .eq('status', 'failed').gte('created_at', day.start)
            );
            if (failedToday && failedToday > 0) items.push({
                type: 'failed_transactions_today', severity: 'medium',
                title: 'Failed transactions today',
                description: `${failedToday} transaction(s) failed today`,
                count: failedToday, route: '/admin/transactions?status=failed&range=today'
            });

            const openTickets = await tryCount('open_support_tickets', () =>
                supabaseAdmin.from('support_tickets').select('id', { count: 'exact', head: true })
                    .in('status', ['open', 'in_progress'])
            );
            if (openTickets && openTickets > 0) items.push({
                type: 'open_support_tickets', severity: 'medium',
                title: 'Open support tickets',
                description: `${openTickets} ticket(s) awaiting response`,
                count: openTickets, route: '/admin/support'
            });

            res.json({ success: true, data: items });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/orders/failed/recent
// ═════════════════════════════════════════════════════════════════

router.get(
    '/orders/failed/recent',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 10, 50);

            const { data, error } = await supabaseAdmin
                .from('transactions')
                .select('id, user_id, type, status, currency, amount, description, ref, reference, provider, provider_reference, failure_reason, created_at')
                .eq('status', 'failed')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) {
                console.error('[ADMIN DASHBOARD] failed orders error:', error.message);
                return fail(res, { status: 500, code: 'FAILED_ORDERS_ERROR', message: error.message });
            }

            const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
            let profilesById = {};
            if (userIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email')
                    .in('id', userIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const rows = (data || []).map(t => {
                const p = profilesById[t.user_id] || {};
                return {
                    id: t.id,
                    orderRef: t.ref || t.reference,
                    reference: t.ref || t.reference,
                    customer: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    userEmail: p.email || '',
                    service: prettyService(t.type),
                    type: t.type,
                    amount: t.amount ?? null,
                    currency: t.currency || 'NGN',
                    provider: t.provider || null,
                    providerReference: t.provider_reference || null,
                    reason: t.failure_reason || 'No reason provided',
                    failureReason: t.failure_reason || null,
                    created_at: t.created_at
                };
            });

            res.json({ success: true, data: rows });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/deposits/recent
// ═════════════════════════════════════════════════════════════════

router.get(
    '/deposits/recent',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 20, 100);

            const [kora, crypto] = await Promise.all([
                supabaseAdmin
                    .from('deposit_requests')
                    .select('id, user_id, internal_reference, provider_reference, status, payment_currency, payment_amount, wallet_currency, wallet_amount, customer_rate, fee_amount, fee_currency, created_at, completed_at')
                    .order('created_at', { ascending: false })
                    .limit(limit),
                supabaseAdmin
                    .from('crypto_deposits')
                    .select('id, user_id, nowpayments_payment_id, status, requested_usd, required_usd, wallet_credit_usd, credited_amount, pay_currency, pay_network, fee_usd, fee_percent, created_at, completed_at')
                    .order('created_at', { ascending: false })
                    .limit(limit)
            ]);

            // Profiles fetched in one pass.
            const allUserIds = [
                ...(kora.data || []).map(r => r.user_id),
                ...(crypto.data || []).map(r => r.user_id)
            ].filter(Boolean);
            const uniqueIds = [...new Set(allUserIds)];
            let profilesById = {};
            if (uniqueIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email')
                    .in('id', uniqueIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const koraRows = (kora.data || []).map(r => {
                const p = profilesById[r.user_id] || {};
                return {
                    id: r.id,
                    source: 'kora',
                    reference: r.internal_reference,
                    providerReference: r.provider_reference,
                    customer: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    userEmail: p.email || '',
                    paymentCurrency: r.payment_currency || null,
                    paymentAmount: r.payment_amount ?? null,
                    walletCurrency: r.wallet_currency || null,
                    walletAmount: r.wallet_amount ?? null,
                    customerRate: r.customer_rate ?? null,
                    feeAmount: r.fee_amount ?? null,
                    feeCurrency: r.fee_currency || null,
                    status: r.status,
                    method: 'KoraPay',
                    created_at: r.created_at,
                    completed_at: r.completed_at
                };
            });

            const cryptoRows = (crypto.data || []).map(r => {
                const p = profilesById[r.user_id] || {};
                return {
                    id: r.id,
                    source: 'crypto',
                    reference: r.nowpayments_payment_id,
                    providerReference: r.nowpayments_payment_id,
                    customer: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    userEmail: p.email || '',
                    paymentCurrency: r.pay_currency,
                    paymentAmount: null,
                    walletCurrency: 'USD',
                    walletAmount: r.credited_amount ?? r.wallet_credit_usd ?? r.requested_usd ?? null,
                    requestedUsd: r.requested_usd ?? null,
                    requiredUsd: r.required_usd ?? null,
                    feeUsd: r.fee_usd ?? null,
                    feePercent: r.fee_percent ?? null,
                    payNetwork: r.pay_network,
                    status: r.status,
                    method: 'NowPayments',
                    created_at: r.created_at,
                    completed_at: r.completed_at
                };
            });

            const merged = [...koraRows, ...cryptoRows]
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                .slice(0, limit);

            res.json({ success: true, data: merged });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/deposits/today-summary
// ═════════════════════════════════════════════════════════════════

router.get(
    '/deposits/today-summary',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const d = await agg.getDepositStats();
            res.json({
                success: true,
                data: {
                    today: {
                        count: unwrap(d.today.count),
                        ngn:   unwrap(d.today.ngn),
                        usd:   unwrap(d.today.usd)
                    },
                    pending:   unwrap(d.pending),
                    failed:    unwrap(d.failed),
                    completed: unwrap(d.completed),
                    byProvider: d.byProvider
                }
            });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/webhooks/recent
// ═════════════════════════════════════════════════════════════════

router.get(
    '/webhooks/recent',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 20, 100);
            const { data, error } = await supabaseAdmin
                .from('provider_webhook_events')
                .select('id, provider, event_type, payment_id, order_id, signature_valid, processing_status, processing_error, received_at, processed_at')
                .order('received_at', { ascending: false })
                .limit(limit);

            if (error) {
                if (error.code === '42P01') {
                    return res.json({
                        success: true, data: [],
                        _meta: { available: false, reason: 'WEBHOOK_TABLE_NOT_FOUND' }
                    });
                }
                console.error('[ADMIN DASHBOARD] webhooks error:', error.message);
                return fail(res, { status: 500, code: 'WEBHOOKS_ERROR', message: error.message });
            }

            const rows = (data || []).map(w => ({
                id: w.id,
                provider: w.provider,
                event: w.event_type,
                reference: w.payment_id || w.order_id,
                signatureVerified: !!w.signature_valid,
                status: mapWebhookStatus(w.processing_status),
                processingStatus: w.processing_status,
                error: w.processing_error || null,
                received_at: w.received_at,
                processed_at: w.processed_at
            }));

            res.json({ success: true, data: rows, _meta: { available: true } });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/logins/today
// ═════════════════════════════════════════════════════════════════

router.get(
    '/logins/today',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 50, 200);
            const result = await agg.getLoginsTodayDetailed({ limit });

            if (!result.available) {
                return res.status(503).json({
                    success: false,
                    error: 'Unable to load login data.',
                    code: 'LOGINS_QUERY_FAILED',
                    reason: result.reason
                });
            }

            res.json({
                success: true,
                data: {
                    count: result.total,
                    users: result.value,
                    deviceBreakdown: result.deviceBreakdown || {},
                    from: result.from,
                    to: result.to
                }
            });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/reconciliation/exceptions/count
//  Single RPC. Never partial.
// ═════════════════════════════════════════════════════════════════

router.get(
    '/reconciliation/exceptions/count',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const { data, error } = await supabaseAdmin.rpc('admin_reconciliation_summary');
            if (error) {
                if (error.code === '42883') {
                    return res.json({
                        success: true,
                        data: { count: null, available: false, reasons: ['RPC_NOT_DEPLOYED'] }
                    });
                }
                console.error('[ADMIN DASHBOARD] reconciliation error:', error.message);
                return fail(res, { status: 500, code: 'RECONCILIATION_ERROR', message: error.message });
            }
            const row = Array.isArray(data) ? data[0] : data;
            res.json({
                success: true,
                data: {
                    count: Number(row?.total || 0),
                    available: true,
                    breakdown: {
                        kora_manual_review: Number(row?.kora_manual_review || 0),
                        kora_underpaid:     Number(row?.kora_underpaid || 0),
                        kora_overpaid:      Number(row?.kora_overpaid || 0),
                        crypto_manual_review: Number(row?.crypto_manual_review || 0),
                        crypto_partially_paid: Number(row?.crypto_partially_paid || 0)
                    }
                }
            });
        } catch (err) { fail(res, err); }
    }
);

// ─── Internal helpers ────────────────────────────────────────────

function humanTime(iso) {
    if (!iso) return 'Never';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'Just now';
    if (s < 120) return '1 minute ago';
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 7200) return '1 hour ago';
    if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
    if (s < 172800) return 'Yesterday';
    return `${Math.floor(s / 86400)} days ago`;
}
function badgeForStatus(status) {
    const s = String(status || '').toLowerCase();
    if (['completed', 'success', 'successful', 'delivered'].includes(s)) return 'success';
    if (['failed', 'cancelled', 'reversed'].includes(s)) return 'danger';
    if (['pending', 'processing', 'confirming', 'partially_paid'].includes(s)) return 'warn';
    if (s === 'manual_review') return 'purple';
    return 'neutral';
}
function iconForType(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('deposit') || t === 'wallet_funding') return '📥';
    if (t.includes('crypto')) return '₿';
    if (t.includes('gift')) return '🎁';
    if (t.includes('airtime') || t.includes('data')) return '📱';
    if (t.includes('boost')) return '📈';
    if (t.includes('sms')) return '📩';
    return '💳';
}
function prettyService(key) {
    const map = {
        crypto: 'Crypto', gift_cards: 'Gift Cards', gift: 'Gift Cards',
        marketplace: 'Marketplace', boost: 'Boost', virtual_sms: 'Virtual SMS',
        airtime: 'Airtime', data: 'Data', esim: 'eSIM', bills: 'Bills & Utilities'
    };
    return map[key] || (key ? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Other');
}
function serviceRoute(key) {
    const map = {
        crypto: '/admin/crypto', gift_cards: '/admin/sellgift', gift: '/admin/sellgift',
        marketplace: '/admin/marketplace-products', boost: '/admin/boost',
        virtual_sms: '/admin/virtual-sms', airtime: '/admin/airtime-data',
        data: '/admin/airtime-data', esim: '/admin/esim', bills: '/admin/bills'
    };
    return map[key] || null;
}
function mapWebhookStatus(s) {
    if (s === 'processed' || s === 'success') return 'processed';
    if (s === 'failed' || s === 'error') return 'failed';
    if (s === 'received') return 'received';
    return s || 'unknown';
}

module.exports = router;