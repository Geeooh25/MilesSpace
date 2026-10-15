// services/auditLogService.js
// ─────────────────────────────────────────────────────────────────
// Central audit log authority.
//
//   • record()       — insert one audit row (append-only).
//   • recordMany()   — batched insert (used for bulk actions).
//   • list()         — paginated read with filters.
//   • get()          — single row + admin/target context.
//   • summary()      — KPI counts (one RPC).
//   • facets()       — categories/actions/severities for filters.
//   • distinctAdmins — dropdown for the admin filter.
//
// Category and severity are derived from the action string if not
// supplied. This is the canonical mapping — no other file should
// invent one.
//
// Financial rows and rows marked critical cannot be updated or
// deleted. That is enforced by a database trigger as well.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORIES = Object.freeze([
    'security',
    'users',
    'wallets',
    'transactions',
    'payments',
    'crypto',
    'deposits',
    'refunds',
    'reconciliation',
    'pricing',
    'providers',
    'admin_management',
    'permissions',
    'settings',
    'reports',
    'system'
]);

const SEVERITIES = Object.freeze(['low','medium','high','critical']);
const RESULTS = Object.freeze(['success','failure','partial']);

// Action → { category, severity }. Anything not listed defaults to
// { category: 'system', severity: 'medium' }.
const ACTION_MAP = Object.freeze({
    // Security
    'admin.login':                    { category: 'security',          severity: 'low' },
    'admin.login_failed':             { category: 'security',          severity: 'high' },
    'admin.logout':                   { category: 'security',          severity: 'low' },
    'admin.session_refreshed':        { category: 'security',          severity: 'low' },
    'admin.mfa_enabled':              { category: 'security',          severity: 'high' },
    'admin.mfa_disabled':             { category: 'security',          severity: 'critical' },
    'admin.mfa_failed':               { category: 'security',          severity: 'high' },
    'admin.recovery_code_used':       { category: 'security',          severity: 'high' },
    'admin.recovery_codes_regenerated': { category: 'security',        severity: 'high' },
    'admin.password_changed':         { category: 'security',          severity: 'high' },

    // Users
    'user.update':                    { category: 'users',             severity: 'medium' },
    'user.status_change':             { category: 'users',             severity: 'high' },
    'user.note_added':                { category: 'users',             severity: 'low' },
    'user.restriction_added':         { category: 'users',             severity: 'high' },
    'user.restriction_lifted':        { category: 'users',             severity: 'high' },
    'user.force_logout':              { category: 'users',             severity: 'high' },
    'user.require_password_reset':    { category: 'users',             severity: 'high' },
    'user.require_2fa':               { category: 'users',             severity: 'high' },

    // Wallets
    'wallet.credit':                  { category: 'wallets',           severity: 'critical' },
    'wallet.debit':                   { category: 'wallets',           severity: 'critical' },
    'wallet.adjustment_pending_approval': { category: 'wallets',       severity: 'critical' },
    'wallet.approval_executed':       { category: 'wallets',           severity: 'critical' },
    'wallet.approval_rejected':       { category: 'wallets',           severity: 'high' },

    // Transactions
    'transaction.status_change':      { category: 'transactions',      severity: 'high' },
    'transaction.refund':             { category: 'refunds',           severity: 'critical' },
    'transaction.refund_noop':        { category: 'refunds',           severity: 'low' },
    'transaction.note':               { category: 'transactions',      severity: 'low' },
    'transactions.export':            { category: 'reports',           severity: 'medium' },

    // Orders
    'order.status_change':            { category: 'transactions',      severity: 'high' },
    'order.status_completed':         { category: 'transactions',      severity: 'high' },
    'order.status_cancelled':         { category: 'transactions',      severity: 'high' },
    'order.status_failed':            { category: 'transactions',      severity: 'high' },
    'order.refund':                   { category: 'refunds',           severity: 'critical' },
    'order.retry':                    { category: 'transactions',      severity: 'medium' },
    'order.note':                     { category: 'transactions',      severity: 'low' },

    // Providers
    'provider.test':                  { category: 'providers',         severity: 'low' },
    'provider.test_all':              { category: 'providers',         severity: 'low' },
    'provider.enabled':               { category: 'providers',         severity: 'high' },
    'provider.disabled':              { category: 'providers',         severity: 'high' },
    'provider.maintenance_on':        { category: 'providers',         severity: 'medium' },
    'provider.maintenance_off':       { category: 'providers',         severity: 'medium' },

    // Reconciliation
    'reconciliation.recheck':         { category: 'reconciliation',    severity: 'medium' },
    'reconciliation.recheck_failed':  { category: 'reconciliation',    severity: 'high' },
    'reconciliation.recheck_verify_only': { category: 'reconciliation',severity: 'medium' },
    'reconciliation.issue_resolved':  { category: 'reconciliation',    severity: 'high' },

    // Providers webhooks
    'webhook.reprocess':              { category: 'providers',         severity: 'high' },
    'webhook.ignore':                 { category: 'providers',         severity: 'medium' },

    // Settings
    'setting_change':                 { category: 'settings',          severity: 'high' },

    // Reports
    'report.export':                  { category: 'reports',           severity: 'medium' },

    // Admin management
    'admin.created':                  { category: 'admin_management',  severity: 'critical' },
    'admin.disabled':                 { category: 'admin_management',  severity: 'critical' },
    'admin.deleted':                  { category: 'admin_management',  severity: 'critical' },
    'admin.role_changed':             { category: 'admin_management',  severity: 'critical' },
    'admin.permission_granted':       { category: 'permissions',       severity: 'critical' },
    'admin.permission_revoked':       { category: 'permissions',       severity: 'critical' },

    // Emergency
    'emergency.toggle':               { category: 'system',            severity: 'critical' },
    'maintenance.toggle':             { category: 'system',            severity: 'high' }
});

// ─── Action classification ──────────────────────────────────────

function classify(action) {
    const a = String(action || '').trim();
    const direct = ACTION_MAP[a];
    if (direct) return direct;

    // Fall back by prefix so callers don't have to remember every name.
    const lower = a.toLowerCase();
    if (lower.startsWith('wallet.'))          return { category: 'wallets',           severity: 'critical' };
    if (lower.startsWith('transaction.'))     return { category: 'transactions',      severity: 'high' };
    if (lower.startsWith('order.'))           return { category: 'transactions',      severity: 'high' };
    if (lower.startsWith('user.'))            return { category: 'users',             severity: 'medium' };
    if (lower.startsWith('admin.'))           return { category: 'admin_management',  severity: 'high' };
    if (lower.startsWith('provider.'))        return { category: 'providers',         severity: 'medium' };
    if (lower.startsWith('reconciliation.'))  return { category: 'reconciliation',    severity: 'medium' };
    if (lower.startsWith('webhook.'))         return { category: 'providers',         severity: 'medium' };
    if (lower.startsWith('setting'))          return { category: 'settings',          severity: 'high' };
    if (lower.startsWith('report.'))          return { category: 'reports',           severity: 'medium' };

    return { category: 'system', severity: 'medium' };
}

function detectDevice(userAgent) {
    const ua = String(userAgent || '');
    if (!ua) return null;
    const os = /Windows/i.test(ua) ? 'Windows'
             : /Mac OS X/i.test(ua) ? 'macOS'
             : /Android/i.test(ua) ? 'Android'
             : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
             : /Linux/i.test(ua) ? 'Linux'
             : null;
    const browser = /Edg\//i.test(ua) ? 'Edge'
                  : /Chrome\//i.test(ua) ? 'Chrome'
                  : /Firefox\//i.test(ua) ? 'Firefox'
                  : /Safari\//i.test(ua) ? 'Safari'
                  : null;
    if (!os && !browser) return null;
    return [browser, os].filter(Boolean).join(' / ');
}

// ─── Write ──────────────────────────────────────────────────────

async function record({
    adminId = null,
    adminEmail = null,
    adminRole = null,
    action,
    category = null,
    severity = null,
    targetType = null,
    targetId = null,
    before = null,
    after = null,
    reason = null,
    adminNote = null,
    result = 'success',
    ip = null,
    userAgent = null,
    location = null,
    requestId = null,
    sessionId = null
} = {}) {
    if (!action) {
        const e = new Error('auditLogService.record: action is required');
        e.code = 'AUDIT_ACTION_REQUIRED';
        throw e;
    }
    const classification = classify(action);
    const cat = category || classification.category;
    const sev = severity || classification.severity;
    const res = RESULTS.includes(result) ? result : 'success';

    const row = {
        admin_id:    adminId || null,
        admin_email: adminEmail || null,
        admin_role:  adminRole || null,
        action:      String(action).slice(0, 120),
        category:    cat,
        severity:    sev,
        target_type: targetType || null,
        target_id:   targetId ? String(targetId).slice(0, 200) : null,
        before:      before || null,
        after:       after || null,
        reason:      reason ? String(reason).slice(0, 500) : null,
        admin_note:  adminNote ? String(adminNote).slice(0, 2000) : null,
        result:      res,
        ip_address:  ip || null,
        user_agent:  userAgent ? String(userAgent).slice(0, 500) : null,
        device:      detectDevice(userAgent),
        location:    location || null,
        request_id:  requestId || null,
        session_id:  sessionId || null,
        created_at:  new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert(row)
        .select('id')
        .maybeSingle();

    if (error) {
        console.error('[auditLog] insert failed:', error.message);
        const e = new Error('Failed to record audit entry.');
        e.status = 500;
        e.code = 'AUDIT_INSERT_FAILED';
        throw e;
    }
    return data?.id || null;
}

async function recordMany(rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const prepared = rows.map(r => {
        const classification = classify(r.action);
        return {
            admin_id:    r.adminId || null,
            admin_email: r.adminEmail || null,
            admin_role:  r.adminRole || null,
            action:      String(r.action || '').slice(0, 120),
            category:    r.category || classification.category,
            severity:    r.severity || classification.severity,
            target_type: r.targetType || null,
            target_id:   r.targetId ? String(r.targetId).slice(0, 200) : null,
            before:      r.before || null,
            after:       r.after || null,
            reason:      r.reason ? String(r.reason).slice(0, 500) : null,
            admin_note:  r.adminNote ? String(r.adminNote).slice(0, 2000) : null,
            result:      RESULTS.includes(r.result) ? r.result : 'success',
            ip_address:  r.ip || null,
            user_agent:  r.userAgent ? String(r.userAgent).slice(0, 500) : null,
            device:      detectDevice(r.userAgent),
            location:    r.location || null,
            request_id:  r.requestId || null,
            session_id:  r.sessionId || null,
            created_at:  new Date().toISOString()
        };
    });
    const { data, error } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert(prepared)
        .select('id');
    if (error) {
        console.error('[auditLog] batch insert failed:', error.message);
        const e = new Error('Failed to record audit entries.');
        e.status = 500;
        e.code = 'AUDIT_INSERT_FAILED';
        throw e;
    }
    return (data || []).map(r => r.id);
}

// ─── Read ───────────────────────────────────────────────────────

function clampLimit(v, def = 50, max = 200) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function clampPage(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

async function list({
    page = 1, limit = 50,
    search = null,
    adminId = null, category = null, action = null,
    severity = null, result = null,
    from = null, to = null
} = {}) {
    page = clampPage(page);
    limit = clampLimit(limit);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('admin_audit_logs')
        .select(
            'id, admin_id, admin_email, admin_role, action, category, severity, ' +
            'target_type, target_id, result, ip_address, device, request_id, created_at',
            { count: 'exact' }
        )
        .order('created_at', { ascending: false });

    if (adminId && UUID_RE.test(adminId)) q = q.eq('admin_id', adminId);
    if (category && category !== 'all')  q = q.eq('category', category);
    if (action   && action   !== 'all')  q = q.eq('action', action);
    if (severity && severity !== 'all')  q = q.eq('severity', severity);
    if (result   && result   !== 'all')  q = q.eq('result', result);
    if (from) q = q.gte('created_at', new Date(from).toISOString());
    if (to)   q = q.lte('created_at', new Date(to).toISOString());

    if (search) {
        const safe = String(search).trim().slice(0, 100).replace(/[%_]/g, m => '\\' + m);
        q = q.or(
            `action.ilike.%${safe}%,admin_email.ilike.%${safe}%,target_id.ilike.%${safe}%,request_id.ilike.%${safe}%,reason.ilike.%${safe}%`
        );
    }

    q = q.range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) {
        const e = new Error('Failed to load audit log.');
        e.status = 500; e.code = 'AUDIT_READ_FAILED'; e.cause = error.message;
        throw e;
    }

    // Enrich with admin display names in one round-trip.
    const adminIds = [...new Set((data || []).map(r => r.admin_id).filter(Boolean))];
    let adminsById = {};
    if (adminIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, role')
            .in('id', adminIds);
        (profiles || []).forEach(p => { adminsById[p.id] = p; });
    }

    return {
        entries: (data || []).map(r => ({
            ...r,
            admin_username: adminsById[r.admin_id]?.username || null,
            admin_display: adminsById[r.admin_id]?.username
                        || r.admin_email
                        || 'Unknown admin'
        })),
        count: count || 0,
        page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0)
    };
}

async function get(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid audit entry id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('admin_audit_logs')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) { const e = new Error('Failed to load audit entry.'); e.status = 500; e.code = 'AUDIT_READ_FAILED'; throw e; }
    if (!data) { const e = new Error('Audit entry not found.'); e.status = 404; e.code = 'AUDIT_NOT_FOUND'; throw e; }

    // Attach admin profile if available.
    let admin = null;
    if (data.admin_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, role')
            .eq('id', data.admin_id)
            .maybeSingle();
        admin = p || null;
    }

    // Attach target summary if we can find one.
    let target = null;
    if (data.target_type === 'profile' && UUID_RE.test(String(data.target_id || ''))) {
        const { data: u } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, status, role')
            .eq('id', data.target_id)
            .maybeSingle();
        target = u || null;
    } else if (data.target_type === 'transaction' && UUID_RE.test(String(data.target_id || ''))) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, reference, type, status, amount, currency, user_id')
            .eq('id', data.target_id)
            .maybeSingle();
        target = t || null;
    } else if (data.target_type === 'order' && /^\d+$/.test(String(data.target_id || ''))) {
        const { data: o } = await supabaseAdmin
            .from('orders')
            .select('id, order_ref, status, product_name, user_id')
            .eq('id', Number(data.target_id))
            .maybeSingle();
        target = o || null;
    }

    return { entry: data, admin, target };
}

async function summary(params = {}) {
    const { data, error } = await supabaseAdmin.rpc('admin_audit_summary', {
        p_from:     params.from     || null,
        p_to:       params.to       || null,
        p_admin_id: params.adminId  && UUID_RE.test(params.adminId) ? params.adminId : null,
        p_category: params.category && params.category !== 'all' ? params.category : null,
        p_severity: params.severity && params.severity !== 'all' ? params.severity : null,
        p_result:   params.result   && params.result   !== 'all' ? params.result   : null
    });
    if (error) {
        if (error.code === '42883' || error.code === 'PGRST202') {
            return { available: false, reason: 'RPC_NOT_DEPLOYED', total: null, today: null, critical: null, failed: null };
        }
        const e = new Error('Failed to summarize audit log.'); e.status = 500; e.code = 'AUDIT_SUMMARY_FAILED'; throw e;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
        available: true,
        total:    Number(row?.total    || 0),
        today:    Number(row?.today    || 0),
        critical: Number(row?.critical || 0),
        failed:   Number(row?.failed   || 0)
    };
}

async function distinctAdmins() {
    const { data, error } = await supabaseAdmin.rpc('admin_audit_distinct_admins');
    if (error) {
        if (error.code === '42883' || error.code === 'PGRST202') return [];
        return [];
    }
    return Array.isArray(data) ? data : [];
}

async function facets() {
    const { data, error } = await supabaseAdmin.rpc('admin_audit_facets');
    if (error) {
        if (error.code === '42883' || error.code === 'PGRST202') {
            return { categories: CATEGORIES, actions: Object.keys(ACTION_MAP), severities: SEVERITIES, results: RESULTS };
        }
        return { categories: CATEGORIES, actions: [], severities: SEVERITIES, results: RESULTS };
    }
    const row = Array.isArray(data) ? data[0] : (data || {});
    return {
        categories: row.categories || CATEGORIES,
        actions:    row.actions    || [],
        severities: row.severities || SEVERITIES,
        results:    row.results    || RESULTS
    };
}

module.exports = {
    CATEGORIES,
    SEVERITIES,
    RESULTS,
    ACTION_MAP,
    classify,
    record,
    recordMany,
    list,
    get,
    summary,
    distinctAdmins,
    facets
};