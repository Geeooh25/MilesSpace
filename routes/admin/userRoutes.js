// routes/admin/userRoutes.js
// ─────────────────────────────────────────────────────────────────
// User 360 admin API. Every route:
//   1. authenticates the admin via requirePermission()
//   2. validates the request shape
//   3. calls services/userAdminService
//   4. writes to admin_audit_logs on success (via service caller
//      for mutations, via recordAdminAction for reads that matter)
//
// No direct Supabase access. No `select('*')`. No silent empty
// arrays. Ledger is the only source of financial truth.
//
// Existing URLs preserved:
//   GET  /api/admin/users
//   GET  /api/admin/users/recent
//   GET  /api/admin/users/stats
//   GET  /api/admin/users/:id
//   GET  /api/admin/users/:id/detail
//   GET  /api/admin/users/:id/overview
//   GET  /api/admin/users/:id/wallets
//   GET  /api/admin/users/:id/ledger
//   GET  /api/admin/users/:id/transactions
//   GET  /api/admin/users/:id/security
//   GET  /api/admin/users/:id/support
//   GET  /api/admin/users/:id/notes
//   POST /api/admin/users/:id/notes
//   POST /api/admin/users/:id/restrictions
//   DELETE /api/admin/users/:id/restrictions/:restriction
//   POST /api/admin/users/:id/force-logout
//   POST /api/admin/users/:id/require-password-reset
//   POST /api/admin/users/:id/require-2fa
//   PUT  /api/admin/users/:id
//   PUT  /api/admin/users/:id/status
//   POST /api/admin/users/:id/wallet
//   GET  /api/admin/approvals
//   POST /api/admin/approvals/:id/approve
//   POST /api/admin/approvals/:id/reject
//
// New URLs:
//   GET  /api/admin/users/:id/orders
//   GET  /api/admin/users/:id/audit
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const svc = require('../../services/userAdminService');
const {
    requirePermission,
    recordAdminAction,
    PERMISSIONS
} = require('../../middleware/adminAuth');

// ─── Response helpers ───────────────────────────────────────────
function ok(res, payload) {
    if (!res.headersSent) res.json({ success: true, ...payload });
}
function fail(res, status, code, message, extra = {}) {
    if (res.headersSent) return;
    res.status(status).json({ success: false, error: message, code, ...extra });
}
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code   = err?.code || 'USER_ADMIN_ERROR';
    const message = status >= 500 ? 'Something went wrong. Please try again.' : (err?.message || 'Request failed');
    if (status >= 500) console.error('[ADMIN USERS]', code, err?.message);
    const body = { success: false, error: message, code };
    if (err?.allowed) body.allowed = err.allowed;
    res.status(status).json(body);
}

// ═══════════════════════════════════════════════════════════════
//  LIST ROUTES (before /:id)
// ═══════════════════════════════════════════════════════════════

router.get('/users',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const result = await svc.listUsers({
                page: req.query.page,
                limit: req.query.limit,
                search: req.query.search,
                status: req.query.status,
                role: req.query.role
            });
            ok(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.get('/users/recent',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const users = await svc.getRecentUsers(req.query.limit);
            ok(res, { data: users });
        } catch (err) { sendErr(res, err); }
    }
);

router.get('/users/stats',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const stats = await svc.getStats();
            ok(res, { stats });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  USER 360 DETAIL
// ═══════════════════════════════════════════════════════════════

// /users/:id/overview — the canonical detail endpoint.
router.get('/users/:id/overview',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const data = await svc.getUser360(req.params.id);
            ok(res, { data });
        } catch (err) { sendErr(res, err); }
    }
);

// /users/:id/detail — kept for backwards compatibility.
// Delegates to the same service function. Response shape matches
// /overview plus the extra legacy keys the old UI read.
router.get('/users/:id/detail',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const data = await svc.getUser360(req.params.id);

            // Legacy shape: recent transactions + sessions.
            let recent_tx = [];
            try {
                const tx = await svc.getTransactions(req.params.id, { limit: 10 });
                recent_tx = tx.transactions;
            } catch (_) {}

            let sessions = [];
            try {
                const sec = await svc.getSecurity(req.params.id, { limit: 5 });
                sessions = sec.sessions;
            } catch (_) {}

            ok(res, {
                data: {
                    user: {
                        ...data.profile,
                        wallet_ngn: data.wallet?.currencies?.NGN?.available ?? null,
                        wallet_usd: data.wallet?.currencies?.USD?.available ?? null
                    },
                    wallet: data.wallet,
                    presence: null,
                    stats: data.summary,
                    recent_transactions: recent_tx,
                    sessions
                }
            });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  SUB-RESOURCES
// ═══════════════════════════════════════════════════════════════

router.get('/users/:id/wallets',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const data = await svc.getWallets(req.params.id);
            ok(res, { data });
        } catch (err) { sendErr(res, err); }
    }
);

router.get('/users/:id/ledger',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const result = await svc.getLedger(req.params.id, {
                page: req.query.page,
                limit: req.query.limit,
                currency: req.query.currency,
                entry_type: req.query.entry_type
            });
            ok(res, {
                data: result.entries,
                accounts: result.accounts,
                available: result.available,
                count: result.count,
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages,
                ...(result.note ? { note: result.note } : {})
            });
        } catch (err) { sendErr(res, err); }
    }
);

router.get('/users/:id/transactions',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const result = await svc.getTransactions(req.params.id, {
                page: req.query.page,
                limit: req.query.limit,
                type: req.query.type,
                status: req.query.status,
                currency: req.query.currency
            });
            ok(res, {
                data: result.transactions,
                count: result.count,
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages
            });
        } catch (err) { sendErr(res, err); }
    }
);

router.get('/users/:id/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await svc.getOrders(req.params.id, {
                page: req.query.page,
                limit: req.query.limit,
                product_type: req.query.product_type,
                status: req.query.status
            });
            ok(res, {
                data: result.orders,
                count: result.count,
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages,
                ...(result.note ? { note: result.note } : {})
            });
        } catch (err) { sendErr(res, err); }
    }
);

router.get('/users/:id/security',
    requirePermission(PERMISSIONS.USERS_SECURITY_READ),
    async (req, res) => {
        try {
            const data = await svc.getSecurity(req.params.id, {
                limit: req.query.limit
            });
            ok(res, { data });
        } catch (err) { sendErr(res, err); }
    }
);

router.get('/users/:id/support',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const result = await svc.getSupport(req.params.id);
            ok(res, { data: result.tickets, ...(result.note ? { note: result.note } : {}) });
        } catch (err) { sendErr(res, err); }
    }
);

router.get('/users/:id/notes',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const notes = await svc.getNotes(req.params.id);
            ok(res, { data: notes });
        } catch (err) { sendErr(res, err); }
    }
);

router.post('/users/:id/notes',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const note = await svc.addNote({
                userId: req.params.id,
                authorId: req.adminContext.id,
                body: req.body?.body,
                tags: req.body?.tags
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.note_added',
                targetType: 'profile',
                targetId: req.params.id,
                after: { note_id: note.id, tags: note.tags },
                reason: 'internal note',
                req
            });
            ok(res, { data: note });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  RESTRICTIONS
// ═══════════════════════════════════════════════════════════════

router.post('/users/:id/restrictions',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const created = await svc.addRestriction({
                userId: req.params.id,
                adminId: req.adminContext.id,
                restriction: req.body?.restriction,
                reason: req.body?.reason
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.restriction_added',
                targetType: 'profile',
                targetId: req.params.id,
                after: { restriction: created.restriction, reason: created.reason },
                reason: created.reason,
                req
            });
            ok(res, { data: created });
        } catch (err) { sendErr(res, err); }
    }
);

router.delete('/users/:id/restrictions/:restriction',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const reason = req.body?.reason || req.query?.reason;
            const updated = await svc.removeRestriction({
                userId: req.params.id,
                adminId: req.adminContext.id,
                restriction: req.params.restriction,
                reason
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.restriction_lifted',
                targetType: 'profile',
                targetId: req.params.id,
                after: { restriction: updated.restriction, reason: updated.lifted_reason },
                reason: updated.lifted_reason,
                req
            });
            ok(res, { data: updated });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  SECURITY ACTIONS
// ═══════════════════════════════════════════════════════════════

router.post('/users/:id/force-logout',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const reason = req.body?.reason;
            const result = await svc.forceLogout({ userId: req.params.id, reason });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.force_logout',
                targetType: 'profile',
                targetId: req.params.id,
                after: { sessions_revoked: result.revoked },
                reason,
                req
            });
            ok(res, { revoked: result.revoked });
        } catch (err) { sendErr(res, err); }
    }
);

router.post('/users/:id/require-password-reset',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const reason = req.body?.reason;
            await svc.requirePasswordReset({ userId: req.params.id, reason });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.require_password_reset',
                targetType: 'profile',
                targetId: req.params.id,
                reason,
                req
            });
            ok(res, {});
        } catch (err) { sendErr(res, err); }
    }
);

router.post('/users/:id/require-2fa',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const reason = req.body?.reason;
            await svc.requireTwoFA({ userId: req.params.id, reason });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.require_2fa',
                targetType: 'profile',
                targetId: req.params.id,
                reason,
                req
            });
            ok(res, {});
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  SINGLE USER (after literals)
// ═══════════════════════════════════════════════════════════════

router.get('/users/:id',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const data = await svc.getUser360(req.params.id);

            // Legacy counts for the old UI
            const counts = {
                transactions: 0,
                campaigns: 0,
                giftOrders: 0,
                boostOrders: 0,
                smsOrders: 0
            };
            const tables = [
                ['transactions', 'transactions'],
                ['campaigns', 'campaigns'],
                ['gift_orders', 'giftOrders'],
                ['boost_orders', 'boostOrders'],
                ['sms_orders', 'smsOrders']
            ];
            await Promise.all(tables.map(async ([table, key]) => {
                try {
                    const { count } = await require('../../db/supabase').supabaseAdmin
                        .from(table).select('id', { count: 'exact', head: true }).eq('user_id', req.params.id);
                    counts[key] = count || 0;
                } catch (_) {}
            }));

            ok(res, { user: data.profile, stats: counts });
        } catch (err) { sendErr(res, err); }
    }
);

router.put('/users/:id',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const result = await svc.updateProfile({
                userId: req.params.id,
                body: req.body || {},
                actorIsSuperAdmin: !!req.adminContext.isSuperAdmin
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.update',
                targetType: 'profile',
                targetId: req.params.id,
                before: result.before,
                after: result.after,
                reason: req.body?.reason || null,
                req
            });
            ok(res, { user: result.updated });
        } catch (err) { sendErr(res, err); }
    }
);

router.put('/users/:id/status',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const result = await svc.setStatus({
                userId: req.params.id,
                status: req.body?.status,
                reason: req.body?.reason
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.status_change',
                targetType: 'profile',
                targetId: req.params.id,
                before: { status: result.before },
                after: { status: result.after },
                reason: req.body?.reason || null,
                req
            });
            ok(res, { user: result.user, message: `User ${result.after}` });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  WALLET ADJUSTMENT
// ═══════════════════════════════════════════════════════════════

router.post('/users/:id/wallet',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    async (req, res) => {
        try {
            const result = await svc.adjustWallet({
                userId: req.params.id,
                actorId: req.adminContext.id,
                actorEmail: req.adminContext.email,
                actorIsSuperAdmin: !!req.adminContext.isSuperAdmin,
                currency: req.body?.currency,
                amount: req.body?.amount,
                reason: req.body?.reason
            });

            if (result.pending_approval) {
                await recordAdminAction({
                    adminId: req.adminContext.id,
                    action: 'wallet.adjustment_pending_approval',
                    targetType: 'profile',
                    targetId: req.params.id,
                    after: { approval_id: result.approval_id, currency: req.body?.currency, amount: req.body?.amount },
                    reason: req.body?.reason,
                    req
                });
                return res.status(202).json({ success: true, ...result });
            }

            const isCredit = Number(req.body?.amount) > 0;
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: isCredit ? 'wallet.credit' : 'wallet.debit',
                targetType: 'profile',
                targetId: req.params.id,
                before: { currency: result.currency, balance: result.ledger?.balance_before ?? null },
                after: { currency: result.currency, balance: result.new_balance, delta: result.amount },
                reason: req.body?.reason,
                req
            });

            ok(res, {
                ...result,
                message: `Wallet ${isCredit ? 'funded' : 'debited'} successfully`
            });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  APPROVALS
// ═══════════════════════════════════════════════════════════════

router.get('/approvals',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    async (req, res) => {
        try {
            const list = await svc.listApprovals({
                status: req.query.status || 'pending',
                limit: req.query.limit
            });
            ok(res, { data: list });
        } catch (err) { sendErr(res, err); }
    }
);

router.post('/approvals/:id/approve',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    async (req, res) => {
        try {
            const result = await svc.approveApproval({
                id: req.params.id,
                actorId: req.adminContext.id,
                actorEmail: req.adminContext.email,
                actorIsSuperAdmin: !!req.adminContext.isSuperAdmin,
                reason: req.body?.reason
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'wallet.approval_executed',
                targetType: 'approval',
                targetId: req.params.id,
                after: { ledger_transaction_id: result.ledger?.transaction_id },
                reason: req.body?.reason || null,
                req
            });
            ok(res, { executed: true, ledger: result.ledger });
        } catch (err) { sendErr(res, err); }
    }
);

router.post('/approvals/:id/reject',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    async (req, res) => {
        try {
            const result = await svc.rejectApproval({
                id: req.params.id,
                actorId: req.adminContext.id,
                reason: req.body?.reason
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'wallet.approval_rejected',
                targetType: 'approval',
                targetId: req.params.id,
                reason: req.body?.reason,
                req
            });
            ok(res, { data: result });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  AUDIT TRAIL
// ═══════════════════════════════════════════════════════════════

router.get('/users/:id/audit',
    requirePermission(PERMISSIONS.USERS_AUDIT_READ),
    async (req, res) => {
        try {
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
            const { data, error } = await require('../../db/supabase').supabaseAdmin
                .rpc('get_user_audit_history', { p_user_id: req.params.id, p_limit: limit });
            if (error) return fail(res, 500, 'AUDIT_READ_FAILED', 'Failed to read audit history');
            ok(res, { data: data || [] });
        } catch (err) { sendErr(res, err); }
    }
);

module.exports = router;