'use strict';

// Canonical action registry. Every audit write must use one of
// these names. Free-form action names are rejected by the service
// in production mode.
//
// action:      the persisted action string
// category:    canonical category
// severity:    canonical minimum severity (caller may escalate, not downgrade)
// actorType:   the default actor type for actions of this kind
// strict:      if true, this action MUST be recorded with strict audit

const ACTIONS = Object.freeze({
    // ─── Security ────────────────────────────────────────────────
    ADMIN_LOGIN:               { action: 'admin.login',                    category: 'security',         severity: 'low',      actorType: 'admin' },
    ADMIN_LOGIN_FAILED:        { action: 'admin.login_failed',             category: 'security',         severity: 'high',     actorType: 'admin' },
    ADMIN_LOGOUT:              { action: 'admin.logout',                   category: 'security',         severity: 'low',      actorType: 'admin' },
    ADMIN_SESSION_REFRESHED:   { action: 'admin.session_refreshed',        category: 'security',         severity: 'low',      actorType: 'admin' },
    ADMIN_SESSION_REVOKED:     { action: 'admin.session_revoked',          category: 'security',         severity: 'high',     actorType: 'admin', strict: true },
    ADMIN_MFA_ENABLED:         { action: 'admin.mfa_enabled',              category: 'security',         severity: 'high',     actorType: 'admin', strict: true },
    ADMIN_MFA_DISABLED:        { action: 'admin.mfa_disabled',             category: 'security',         severity: 'critical', actorType: 'admin', strict: true },
    ADMIN_MFA_FAILED:          { action: 'admin.mfa_failed',               category: 'security',         severity: 'high',     actorType: 'admin' },
    ADMIN_RECOVERY_USED:       { action: 'admin.recovery_code_used',       category: 'security',         severity: 'high',     actorType: 'admin', strict: true },
    ADMIN_RECOVERY_REGEN:      { action: 'admin.recovery_codes_regenerated',category: 'security',        severity: 'high',     actorType: 'admin', strict: true },
    ADMIN_PASSWORD_CHANGED:    { action: 'admin.password_changed',         category: 'security',         severity: 'high',     actorType: 'admin', strict: true },

    // ─── Users ───────────────────────────────────────────────────
    USER_UPDATE:               { action: 'user.update',                    category: 'users',            severity: 'medium',   actorType: 'admin' },
    USER_STATUS_CHANGE:        { action: 'user.status_change',             category: 'users',            severity: 'high',     actorType: 'admin', strict: true },
    USER_NOTE_ADDED:           { action: 'user.note_added',                category: 'users',            severity: 'low',      actorType: 'admin' },
    USER_RESTRICTION_ADDED:    { action: 'user.restriction_added',         category: 'users',            severity: 'high',     actorType: 'admin', strict: true },
    USER_RESTRICTION_LIFTED:   { action: 'user.restriction_lifted',        category: 'users',            severity: 'high',     actorType: 'admin', strict: true },
    USER_FORCE_LOGOUT:         { action: 'user.force_logout',              category: 'users',            severity: 'high',     actorType: 'admin' },

    // ─── Wallets ─────────────────────────────────────────────────
    WALLET_CREDIT:             { action: 'wallet.credit',                  category: 'wallets',          severity: 'critical', actorType: 'admin', strict: true },
    WALLET_DEBIT:              { action: 'wallet.debit',                   category: 'wallets',          severity: 'critical', actorType: 'admin', strict: true },
    WALLET_ADJ_PENDING:        { action: 'wallet.adjustment_pending_approval', category: 'wallets',      severity: 'critical', actorType: 'admin', strict: true },
    WALLET_APPROVAL_EXECUTED:  { action: 'wallet.approval_executed',       category: 'wallets',          severity: 'critical', actorType: 'admin', strict: true },
    WALLET_APPROVAL_REJECTED:  { action: 'wallet.approval_rejected',       category: 'wallets',          severity: 'high',     actorType: 'admin', strict: true },

    // ─── Transactions ────────────────────────────────────────────
    TRANSACTION_STATUS:        { action: 'transaction.status_change',      category: 'transactions',     severity: 'high',     actorType: 'admin' },
    TRANSACTION_REFUND:        { action: 'transaction.refund',             category: 'refunds',          severity: 'critical', actorType: 'admin', strict: true },
    TRANSACTION_REFUND_NOOP:   { action: 'transaction.refund_noop',        category: 'refunds',          severity: 'low',      actorType: 'admin' },
    TRANSACTION_NOTE:          { action: 'transaction.note',               category: 'transactions',     severity: 'low',      actorType: 'admin' },
    TRANSACTIONS_EXPORT:       { action: 'transactions.export',            category: 'reports',          severity: 'medium',   actorType: 'admin' },

    // ─── Orders ──────────────────────────────────────────────────
    ORDER_STATUS_CHANGE:       { action: 'order.status_change',            category: 'transactions',     severity: 'high',     actorType: 'admin' },
    ORDER_REFUND:              { action: 'order.refund',                   category: 'refunds',          severity: 'critical', actorType: 'admin', strict: true },
    ORDER_RETRY:               { action: 'order.retry',                    category: 'transactions',     severity: 'medium',   actorType: 'admin' },
    ORDER_NOTE:                { action: 'order.note',                     category: 'transactions',     severity: 'low',      actorType: 'admin' },

    // ─── Providers ───────────────────────────────────────────────
    PROVIDER_TEST:             { action: 'provider.test',                  category: 'providers',        severity: 'low',      actorType: 'admin' },
    PROVIDER_TEST_ALL:         { action: 'provider.test_all',              category: 'providers',        severity: 'low',      actorType: 'admin' },
    PROVIDER_ENABLED:          { action: 'provider.enabled',               category: 'providers',        severity: 'high',     actorType: 'admin', strict: true },
    PROVIDER_DISABLED:         { action: 'provider.disabled',              category: 'providers',        severity: 'high',     actorType: 'admin', strict: true },
    PROVIDER_MAINTENANCE_ON:   { action: 'provider.maintenance_on',        category: 'providers',        severity: 'medium',   actorType: 'admin', strict: true },
    PROVIDER_MAINTENANCE_OFF:  { action: 'provider.maintenance_off',       category: 'providers',        severity: 'medium',   actorType: 'admin', strict: true },
    PROVIDER_RESET_CIRCUIT:    { action: 'provider.reset_circuit',         category: 'providers',        severity: 'medium',   actorType: 'admin' },
    PROVIDER_PRUNE_HEALTH:     { action: 'provider.prune_health_events',   category: 'providers',        severity: 'low',      actorType: 'admin' },

    // ─── Webhooks ────────────────────────────────────────────────
    WEBHOOK_REPROCESS:         { action: 'webhook.reprocess',              category: 'providers',        severity: 'high',     actorType: 'admin', strict: true },
    WEBHOOK_IGNORE:            { action: 'webhook.ignore',                 category: 'providers',        severity: 'medium',   actorType: 'admin' },
    WEBHOOK_RECEIVED:          { action: 'webhook.received',               category: 'providers',        severity: 'low',      actorType: 'webhook' },
    WEBHOOK_SIGNATURE_FAILED:  { action: 'webhook.signature_failed',       category: 'security',         severity: 'high',     actorType: 'webhook' },
    WEBHOOK_DUPLICATE:         { action: 'webhook.duplicate',              category: 'providers',        severity: 'low',      actorType: 'webhook' },

    // ─── Reconciliation ─────────────────────────────────────────
    RECON_CHECK:               { action: 'reconciliation.recheck',         category: 'reconciliation',   severity: 'medium',   actorType: 'admin' },
    RECON_CHECK_FAILED:        { action: 'reconciliation.recheck_failed',  category: 'reconciliation',   severity: 'high',     actorType: 'admin' },
    RECON_ISSUE_RESOLVED:      { action: 'reconciliation.issue_resolved',  category: 'reconciliation',   severity: 'high',     actorType: 'admin', strict: true },

    // ─── Settings ────────────────────────────────────────────────
    SETTING_CHANGE:            { action: 'setting_change',                 category: 'settings',         severity: 'high',     actorType: 'admin', strict: true },
    SETTING_READ:              { action: 'setting_read',                   category: 'settings',         severity: 'low',      actorType: 'admin' },

    // ─── Reports / Export ───────────────────────────────────────
    REPORT_EXPORT:             { action: 'report.export',                  category: 'reports',          severity: 'medium',   actorType: 'admin' },
    AUDIT_EXPORT:              { action: 'audit.export',                   category: 'reports',          severity: 'medium',   actorType: 'admin' },
    AUDIT_VIEW:                { action: 'audit.view',                     category: 'reports',          severity: 'low',      actorType: 'admin' },

    // ─── Admin management ───────────────────────────────────────
    ADMIN_CREATED:             { action: 'admin.created',                  category: 'admin_management', severity: 'critical', actorType: 'admin', strict: true },
    ADMIN_DISABLED:            { action: 'admin.disabled',                 category: 'admin_management', severity: 'critical', actorType: 'admin', strict: true },
    ADMIN_DELETED:             { action: 'admin.deleted',                  category: 'admin_management', severity: 'critical', actorType: 'admin', strict: true },
    ADMIN_ROLE_CHANGED:        { action: 'admin.role_changed',             category: 'admin_management', severity: 'critical', actorType: 'admin', strict: true },
    ADMIN_PERMISSION_GRANTED:  { action: 'admin.permission_granted',       category: 'permissions',      severity: 'critical', actorType: 'admin', strict: true },
    ADMIN_PERMISSION_REVOKED:  { action: 'admin.permission_revoked',       category: 'permissions',      severity: 'critical', actorType: 'admin', strict: true },

    // ─── Emergency ───────────────────────────────────────────────
    EMERGENCY_TOGGLE:          { action: 'emergency.toggle',               category: 'system',           severity: 'critical', actorType: 'admin', strict: true },
    MAINTENANCE_TOGGLE:        { action: 'maintenance.toggle',             category: 'system',           severity: 'high',     actorType: 'admin', strict: true },

    // ─── System / scheduler ─────────────────────────────────────
    SYSTEM_PROVIDER_CHECK:     { action: 'system.provider_check',          category: 'system',           severity: 'low',      actorType: 'scheduler' },
    SYSTEM_RECONCILIATION:     { action: 'system.reconciliation',          category: 'system',           severity: 'low',      actorType: 'scheduler' },
    SYSTEM_CLEANUP:            { action: 'system.cleanup',                 category: 'system',           severity: 'low',      actorType: 'scheduler' }
});

// Canonical severity ordering — used to prevent downgrades.
const SEVERITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });
const SEVERITY_VALUES = Object.freeze(['low','medium','high','critical']);

const CATEGORIES = Object.freeze([
    'security','users','wallets','transactions','payments','crypto',
    'deposits','refunds','reconciliation','pricing','providers',
    'admin_management','permissions','settings','reports','system'
]);

const RESULTS = Object.freeze(['success','failure','partial']);
const ACTOR_TYPES = Object.freeze(['admin','system','scheduler','webhook','provider','customer']);

// A stable map from action string to definition. Built once.
const BY_ACTION = Object.freeze(
    Object.values(ACTIONS).reduce((acc, def) => { acc[def.action] = def; return acc; }, {})
);

// Regex for on-the-fly classification of unrecognized actions.
// In non-production we allow these; in production they default to
// { category: 'system', severity: 'medium' } and are flagged.
const PREFIX_RULES = [
    { re: /^wallet\./,            category: 'wallets',           severity: 'critical' },
    { re: /^transaction\./,       category: 'transactions',      severity: 'high'     },
    { re: /^order\./,             category: 'transactions',      severity: 'high'     },
    { re: /^user\./,              category: 'users',             severity: 'medium'   },
    { re: /^admin\./,             category: 'admin_management',  severity: 'high'     },
    { re: /^provider\./,          category: 'providers',         severity: 'medium'   },
    { re: /^reconciliation\./,    category: 'reconciliation',    severity: 'medium'   },
    { re: /^webhook\./,           category: 'providers',         severity: 'medium'   },
    { re: /^setting/,             category: 'settings',          severity: 'high'     },
    { re: /^report\./,            category: 'reports',           severity: 'medium'   },
    { re: /^audit\./,             category: 'reports',           severity: 'medium'   },
    { re: /^system\./,            category: 'system',            severity: 'low'      }
];

// The strict list — actions that must never be recorded without
// strict audit. Read by the operation layer.
const STRICT_ACTIONS = Object.freeze(
    Object.values(ACTIONS).filter(a => a.strict).map(a => a.action)
);

function getAction(action) {
    return BY_ACTION[String(action || '').trim()] || null;
}

function isKnownAction(action) {
    return Boolean(getAction(action));
}

function isStrictAction(action) {
    return STRICT_ACTIONS.includes(String(action || '').trim());
}

function classify(action) {
    const a = String(action || '').trim();
    const known = BY_ACTION[a];
    if (known) return { ...known };

    for (const rule of PREFIX_RULES) {
        if (rule.re.test(a)) {
            return {
                action: a,
                category: rule.category,
                severity: rule.severity,
                actorType: 'admin',
                strict: false,
                unregistered: true
            };
        }
    }
    return {
        action: a,
        category: 'system',
        severity: 'medium',
        actorType: 'admin',
        strict: false,
        unregistered: true
    };
}

// Severity merge: caller can escalate, never downgrade.
function mergeSeverity(canonical, requested) {
    if (!requested) return canonical;
    const c = SEVERITY_RANK[canonical] || SEVERITY_RANK.medium;
    const r = SEVERITY_RANK[requested];
    if (!r) return canonical;
    return r > c ? requested : canonical;
}

module.exports = {
    ACTIONS,
    STRICT_ACTIONS,
    CATEGORIES,
    SEVERITIES: SEVERITY_VALUES,
    RESULTS,
    ACTOR_TYPES,
    SEVERITY_RANK,
    getAction,
    isKnownAction,
    isStrictAction,
    classify,
    mergeSeverity
};