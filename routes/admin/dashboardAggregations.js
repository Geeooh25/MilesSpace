// routes/admin/dashboardAggregations.js
// ─────────────────────────────────────────────────────────────────
// Server-side aggregation helpers.
//
// All heavy lifting lives in Postgres RPC functions (migrations/
// 2025_admin_agg.sql). This module:
//   - resolves WAT day/month boundaries
//   - calls the right RPC for each question
//   - normalises responses into { available, value } shapes
//
// CONTRACTS:
//   • Money values are returned as 2-decimal STRINGS from Postgres
//     NUMERIC columns. Never Number().
//   • Counts are returned as NUMBERS (fit in 2^53).
//   • Failures produce { available: false, reason }. Never 0.
//   • Nothing fabricated. Nothing silently swallowed.
// ─────────────────────────────────────────────────────────────────

const { supabaseAdmin } = require('../../db/supabase');

// ─── WAT boundaries (UTC+1, no DST in Nigeria) ───────────────────
function watDayBounds(date = new Date()) {
    const OFFSET_MS = 60 * 60 * 1000;
    const local = new Date(date.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const d = local.getUTCDate();
    const startUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS);
    const endUtc   = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - OFFSET_MS);
    return { start: startUtc.toISOString(), end: endUtc.toISOString() };
}

function watMonthBounds(date = new Date()) {
    const OFFSET_MS = 60 * 60 * 1000;
    const local = new Date(date.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const startUtc = new Date(Date.UTC(y, m, 1, 0, 0, 0) - OFFSET_MS);
    const endUtc   = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0) - OFFSET_MS - 1);
    return { start: startUtc.toISOString(), end: endUtc.toISOString() };
}

function isIsoDate(s) {
    if (!s) return false;
    const d = new Date(s);
    return !isNaN(d.getTime());
}

// ─── Response shapes ─────────────────────────────────────────────
function unavailable(reason) {
    return { available: false, reason: reason || 'NOT_AVAILABLE' };
}
function ok(value, extra = {}) {
    return { available: true, value, ...extra };
}

// ─── RPC caller ──────────────────────────────────────────────────
// Wraps supabaseAdmin.rpc, translating Postgres error codes into
// stable reasons. Missing RPC → RPC_NOT_DEPLOYED (signals that the
// migration hasn't been run yet).
async function callRpc(fnName, params = {}) {
    try {
        const { data, error } = await supabaseAdmin.rpc(fnName, params);
        if (error) {
            const code = error.code || 'RPC_ERROR';
            if (code === '42883' || code === 'PGRST202') {
                return unavailable('RPC_NOT_DEPLOYED');
            }
            console.error(`[AGG] rpc ${fnName} error:`, error.message);
            return unavailable(code);
        }
        // RPC functions that return a table come back as an array of rows.
        // RPC functions that return a scalar come back as the value
        // directly. Callers know which one they expect.
        return ok(data);
    } catch (e) {
        console.error(`[AGG] rpc ${fnName} exception:`, e.message);
        return unavailable('EXCEPTION');
    }
}

function unwrapRpcRow(row) {
    // Some RPCs return a single row object; supabase may hand it back
    // as `[ { ... } ]`. This normalises both cases.
    if (Array.isArray(row)) return row[0] || {};
    return row || {};
}

// ─── USERS ───────────────────────────────────────────────────────
async function getUserStats() {
    const day = watDayBounds();
    const month = watMonthBounds();

    const r = await callRpc('admin_user_summary', {
        p_day_start:   day.start,
        p_month_start: month.start
    });
    if (!r.available) {
        return {
            total: unavailable(r.reason),
            customers: unavailable(r.reason),
            newToday: unavailable(r.reason),
            newMonth: unavailable(r.reason),
            suspended: unavailable(r.reason)
        };
    }
    const row = unwrapRpcRow(r.value);
    return {
        total:     ok(Number(row.total_users || 0)),
        customers: ok(Number(row.customer_users || 0)),
        newToday:  ok(Number(row.new_today || 0)),
        newMonth:  ok(Number(row.new_month || 0)),
        suspended: ok(Number(row.suspended_users || 0))
    };
}

// ─── PRESENCE: Active Today + Online Now ─────────────────────────
// Active Today  = unique non-deleted users whose last_seen fell inside
//                 the current WAT calendar day.
// Online Now    = unique users whose last_seen is within the online
//                 threshold (default 90s).
//
// Both come from one RPC so the two numbers are computed against the
// same snapshot. Presence is NOT logins and NOT transactions.
//
// If the RPC isn't deployed the caller gets { available: false }, and
// the frontend renders "Unavailable" — never a fabricated 0.
async function getPresenceStats({ onlineThresholdSec = 90 } = {}) {
    const day = watDayBounds();

    const r = await callRpc('admin_presence_summary', {
        p_day_start:          day.start,
        p_day_end:            day.end,
        p_online_threshold_s: onlineThresholdSec
    });

    if (!r.available) {
        return {
            activeToday: unavailable(r.reason),
            onlineNow:   unavailable(r.reason)
        };
    }

    const row = unwrapRpcRow(r.value);
    return {
        activeToday: ok(Number(row.active_today || 0)),
        onlineNow:   ok(Number(row.online_now   || 0))
    };
}

// ─── WALLET LIABILITIES ──────────────────────────────────────────
async function getWalletLiabilities() {
    const r = await callRpc('admin_wallet_liabilities');
    if (!r.available) {
        return {
            ngn: unavailable(r.reason),
            usd: unavailable(r.reason)
        };
    }
    // RPC returns rows: [{ currency, available, held }, ...]
    const rows = Array.isArray(r.value) ? r.value : [];
    let ngn = null, usd = null;
    for (const row of rows) {
        if (row.currency === 'NGN') ngn = String(row.available ?? '0.00');
        if (row.currency === 'USD') usd = String(row.available ?? '0.00');
    }
    return {
        ngn: ngn === null ? unavailable('NO_NGN_ACCOUNTS') : ok(ngn),
        usd: usd === null ? unavailable('NO_USD_ACCOUNTS') : ok(usd)
    };
}

// ─── DEPOSITS ────────────────────────────────────────────────────
async function getDepositStats() {
    const day = watDayBounds();
    const month = watMonthBounds();

    const [kora, crypto, koraOpen, cryptoOpen] = await Promise.all([
        callRpc('admin_kora_deposit_summary', {
            p_day_start:   day.start,
            p_day_end:     day.end,
            p_month_start: month.start
        }),
        callRpc('admin_crypto_deposit_summary', {
            p_day_start:   day.start,
            p_day_end:     day.end,
            p_month_start: month.start
        }),
        callRpc('admin_kora_open_deposits'),
        callRpc('admin_crypto_open_deposits')
    ]);

    const koraRow = kora.available ? unwrapRpcRow(kora.value) : {};
    const cryptoRow = crypto.available ? unwrapRpcRow(crypto.value) : {};

    // Combine today counts/amounts
    const todayCount = (kora.available ? Number(koraRow.today_count || 0) : null)
                     + (crypto.available ? Number(cryptoRow.today_count || 0) : null);
    const monthCount = (kora.available ? Number(koraRow.month_count || 0) : null)
                     + (crypto.available ? Number(cryptoRow.month_count || 0) : null);

    // Amounts: sum strings via cents
    const sumMoney = (a, b) => {
        if (a == null && b == null) return null;
        const toCents = v => {
            if (v == null || v === '') return 0n;
            const [i, f = ''] = String(v).split('.');
            const frac2 = (f + '00').slice(0, 2);
            const sign = i.startsWith('-') ? -1n : 1n;
            try { return sign * (BigInt(i.replace('-', '') || '0') * 100n + BigInt(frac2 || '0')); }
            catch (_) { return 0n; }
        };
        const cents = toCents(a) + toCents(b);
        const neg = cents < 0n;
        const abs = neg ? -cents : cents;
        return (neg ? '-' : '') + (abs / 100n).toString() + '.' + (abs % 100n).toString().padStart(2, '0');
    };

    const todayNgn = kora.available ? sumMoney(koraRow.today_ngn, null) : null;
    const todayUsd = sumMoney(
        kora.available ? koraRow.today_usd : null,
        crypto.available ? cryptoRow.today_usd : null
    );
    const monthNgn = kora.available ? sumMoney(koraRow.month_ngn, null) : null;
    const monthUsd = sumMoney(
        kora.available ? koraRow.month_usd : null,
        crypto.available ? cryptoRow.month_usd : null
    );

    const pendingTotal = (koraOpen.available ? Number(unwrapRpcRow(koraOpen.value).count || 0) : null)
                       + (cryptoOpen.available ? Number(unwrapRpcRow(cryptoOpen.value).count || 0) : null);

    const failedTotal = (kora.available ? Number(koraRow.failed_count || 0) : null)
                      + (crypto.available ? Number(cryptoRow.failed_count || 0) : null);

    const completedTotal = (kora.available ? Number(koraRow.completed_count || 0) : null)
                         + (crypto.available ? Number(cryptoRow.completed_count || 0) : null);

    // Per-provider breakdown (honest — includes pending for each).
    const byProvider = {};
    if (kora.available) {
        byProvider.kora = {
            todayCount: ok(Number(koraRow.today_count || 0)),
            todayNgn:   ok(String(koraRow.today_ngn || '0.00')),
            todayUsd:   ok(String(koraRow.today_usd || '0.00')),
            pending:    ok(Number(koraOpen.available ? unwrapRpcRow(koraOpen.value).count || 0 : 0)),
            completed:  ok(Number(koraRow.completed_count || 0)),
            failed:     ok(Number(koraRow.failed_count || 0))
        };
    }
    if (crypto.available) {
        byProvider.nowpayments = {
            todayCount:   ok(Number(cryptoRow.today_count || 0)),
            todayUsd:     ok(String(cryptoRow.today_usd || '0.00')),
            pending:      ok(Number(cryptoOpen.available ? unwrapRpcRow(cryptoOpen.value).count || 0 : 0)),
            completed:    ok(Number(cryptoRow.completed_count || 0)),
            failed:       ok(Number(cryptoRow.failed_count || 0)),
            manualReview: ok(Number(cryptoRow.manual_review_count || 0))
        };
    }

    return {
        today: {
            count: (kora.available || crypto.available) ? ok(todayCount) : unavailable('NO_PROVIDER_DATA'),
            ngn:   todayNgn === null ? unavailable('NO_KORA_DATA') : ok(todayNgn),
            usd:   todayUsd === null ? unavailable('NO_PROVIDER_DATA') : ok(todayUsd)
        },
        month: {
            count: (kora.available || crypto.available) ? ok(monthCount) : unavailable('NO_PROVIDER_DATA'),
            ngn:   monthNgn === null ? unavailable('NO_KORA_DATA') : ok(monthNgn),
            usd:   monthUsd === null ? unavailable('NO_PROVIDER_DATA') : ok(monthUsd)
        },
        pending:   (koraOpen.available || cryptoOpen.available) ? ok(pendingTotal) : unavailable('NO_OPEN_QUERY'),
        failed:    (kora.available || crypto.available) ? ok(failedTotal) : unavailable('NO_PROVIDER_DATA'),
        completed: (kora.available || crypto.available) ? ok(completedTotal) : unavailable('NO_PROVIDER_DATA'),
        byProvider
    };
}

// ─── TRANSACTIONS ────────────────────────────────────────────────
async function getTransactionStats() {
    const day = watDayBounds();
    const month = watMonthBounds();

    const r = await callRpc('admin_transaction_summary', {
        p_day_start:   day.start,
        p_day_end:     day.end,
        p_month_start: month.start
    });

    if (!r.available) {
        return {
            today:     { count: unavailable(r.reason), ngn: unavailable(r.reason), usd: unavailable(r.reason) },
            month:     { count: unavailable(r.reason), ngn: unavailable(r.reason), usd: unavailable(r.reason) },
            byStatus:  { completed: unavailable(r.reason), pending: unavailable(r.reason), failed: unavailable(r.reason) }
        };
    }
    const row = unwrapRpcRow(r.value);
    return {
        today: {
            count: ok(Number(row.today_count || 0)),
            ngn:   ok(String(row.today_ngn || '0.00')),
            usd:   ok(String(row.today_usd || '0.00'))
        },
        month: {
            count: ok(Number(row.month_count || 0)),
            ngn:   ok(String(row.month_ngn || '0.00')),
            usd:   ok(String(row.month_usd || '0.00'))
        },
        byStatus: {
            completed: ok(Number(row.completed_count || 0)),
            pending:   ok(Number(row.pending_count || 0)),
            failed:    ok(Number(row.failed_count || 0))
        }
    };
}

// ─── REVENUE ─────────────────────────────────────────────────────
async function getRevenueStats() {
    const day = watDayBounds();
    const month = watMonthBounds();

    const r = await callRpc('admin_revenue_summary', {
        p_day_start:   day.start,
        p_day_end:     day.end,
        p_month_start: month.start
    });

    if (!r.available) {
        return {
            todayNgn: unavailable(r.reason),
            todayUsd: unavailable(r.reason),
            monthNgn: unavailable(r.reason),
            monthUsd: unavailable(r.reason)
        };
    }
    const row = unwrapRpcRow(r.value);
    return {
        todayNgn: ok(String(row.today_ngn || '0.00')),
        todayUsd: ok(String(row.today_usd || '0.00')),
        monthNgn: ok(String(row.month_ngn || '0.00')),
        monthUsd: ok(String(row.month_usd || '0.00'))
    };
}

// ─── SUPPORT & NOTIFICATIONS ─────────────────────────────────────
async function getSupportStats() {
    const r = await callRpc('admin_support_summary');
    if (!r.available) return { open: unavailable(r.reason) };
    const row = unwrapRpcRow(r.value);
    return { open: ok(Number(row.open_count || 0)) };
}

async function getNotificationStats() {
    const r = await callRpc('admin_notification_summary');
    if (!r.available) return { unread: unavailable(r.reason) };
    const row = unwrapRpcRow(r.value);
    return { unread: ok(Number(row.unread_count || 0)) };
}

// ─── LOGINS TODAY ────────────────────────────────────────────────
// Count + first-N detail. Both from RPCs.
async function getLoginsTodayDetailed({ limit = 50 } = {}) {
    const day = watDayBounds();

    const [countRpc, rowsRpc] = await Promise.all([
        callRpc('admin_logins_today_count', {
            p_day_start: day.start,
            p_day_end:   day.end
        }),
        callRpc('admin_logins_today_users', {
            p_day_start: day.start,
            p_day_end:   day.end,
            p_limit:     Math.min(limit, 200)
        })
    ]);

    if (!countRpc.available) return unavailable(countRpc.reason);

    const countRow = unwrapRpcRow(countRpc.value);
    const users = rowsRpc.available && Array.isArray(rowsRpc.value) ? rowsRpc.value : [];

    return ok(users, {
        total: Number(countRow.total || 0),
        deviceBreakdown: {},   // Computed server-side if you want; UI shows count only when empty
        from: day.start,
        to: day.end
    });
}

// ─── SYSTEM HEALTH ───────────────────────────────────────────────
async function getSystemHealth() {
    const start = Date.now();
    let dbLatency = -1;
    let dbHealth = 'unknown';

    try {
        const t = Date.now();
        const { error } = await supabaseAdmin
            .from('profiles')
            .select('id', { count: 'exact', head: true });
        dbLatency = Date.now() - t;
        dbHealth = error ? 'error' : (dbLatency < 500 ? 'healthy' : dbLatency < 2000 ? 'degraded' : 'slow');
    } catch (_) {
        dbHealth = 'error';
    }

    const mem = process.memoryUsage();
    const memPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);

    return {
        status: dbHealth === 'error' ? 'degraded' : 'operational',
        api_latency: `${Date.now() - start}ms`,
        db_latency: dbLatency >= 0 ? `${dbLatency}ms` : 'Error',
        database_health: dbHealth,
        server_uptime: `${Math.floor(process.uptime())} seconds`,
        memory_usage: `${memPercent}%`,
        heap_used: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
        heap_total: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
        rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
        timestamp: new Date().toISOString()
    };
}

module.exports = {
    watDayBounds,
    watMonthBounds,
    isIsoDate,
    unavailable,
    ok,
    getUserStats,
    getWalletLiabilities,
    getPresenceStats,
    getDepositStats,
    getTransactionStats,
    getRevenueStats,
    getSupportStats,
    getNotificationStats,
    getLoginsTodayDetailed,
    getSystemHealth
};