// routes/admin/refundAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Refunds — ROUTES.
//
// This is the dedicated /admin/refunds surface. It exposes the
// refunds table as a first-class operational queue: everything
// that Finance needs to work through, without having to open each
// transaction drawer.
//
// Responsibilities:
//   GET  /api/admin/refunds               — paginated list with filters
//   GET  /api/admin/refunds/summary       — pending / processing / completed counts
//   GET  /api/admin/refunds/:id           — single refund with full context
//   POST /api/admin/refunds/:id/cancel    — cancel a REQUESTED / PENDING_APPROVAL refund
//   POST /api/admin/refunds/:id/approve   — approve a PENDING_APPROVAL refund (second approver)
//   POST /api/admin/refunds/:id/retry     — retry a FAILED provider refund
//
// Every mutation:
//   • requires the appropriate permission
//   • requires a reason (min 4 chars)
//   • requires step-up MFA
//   • writes to admin_audit_logs with request_id
//
// The actual financial execution is delegated to refundService.
// This file never touches the wallet, the ledger, or the provider
// directly.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');
const refundSvc = require('../../services/refundService');
const { supabaseAdmin } = require('../../db/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Response helpers ────────────────────────────────────────────

function sendOk(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'REFUND_ADMIN_ERROR';
    const message = err?.message || 'Refund request failed';
    const safe = { success: false, code, error: message };
    if (status >= 500) console.error('[ADMIN REFUND]', code, message);
    res.status(status).json(safe);
}

function adminCtx(req) {
    return {
        adminId: req.adminContext?.id || null,
        adminEmail: req.adminContext?.email || null,
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.requestId || null
    };
}

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}

router.use('/refunds', attachRequestId);

// ─── Audit helper ────────────────────────────────────────────────

async function recordAudit({ ctx, action, refundId, before, after, reason }) {
    const { error } = await supabaseAdmin.from('admin_audit_logs').insert({
        admin_id: ctx.adminId || null,
        action,
        target_type: 'refund',
        target_id: refundId,
        before: before || null,
        after: after || null,
        reason: reason ? String(reason).slice(0, 500) : null,
        ip_address: ctx.ip || null,
        user_agent: ctx.userAgent || null,
        request_id: ctx.requestId || null,
        created_at: new Date().toISOString()
    });
    if (error) {
        const e = new Error('Failed to record audit entry.');
        e.code = 'AUDIT_INSERT_FAILED';
        e.status = 500;
        throw e;
    }
}

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/refunds
// ═════════════════════════════════════════════════════════════════

router.get(
    '/refunds',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
            const offset = (page - 1) * limit;

            let q = supabaseAdmin
                .from('refunds')
                .select(
                    'id, original_transaction_id, refund_transaction_id, user_id, ' +
                    'refund_type, amount, currency, reason, status, ' +
                    'provider, provider_refund_ref, requested_by, approved_by, ' +
                    'failure_reason, created_at, updated_at, approved_at, ' +
                    'completed_at, failed_at',
                    { count: 'exact' }
                )
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (req.query.status && req.query.status !== 'all') {
                q = q.eq('status', String(req.query.status).toUpperCase());
            }
            if (req.query.refund_type && req.query.refund_type !== 'all') {
                q = q.eq('refund_type', String(req.query.refund_type).toLowerCase());
            }
            if (req.query.currency && req.query.currency !== 'all') {
                q = q.eq('currency', String(req.query.currency).toUpperCase());
            }
            if (req.query.provider && req.query.provider !== 'all') {
                q = q.eq('provider', req.query.provider);
            }

            const fromIso = req.query.from ? new Date(req.query.from).toISOString() : null;
            const toIso = req.query.to ? new Date(req.query.to).toISOString() : null;
            if (fromIso) q = q.gte('created_at', fromIso);
            if (toIso) q = q.lte('created_at', toIso);

            const { data, error, count } = await q;
            if (error) {
                if (error.code === '42P01') {
                    return sendErr(res, Object.assign(new Error('Refunds table not deployed.'), {
                        status: 503, code: 'REFUNDS_TABLE_NOT_DEPLOYED'
                    }));
                }
                throw error;
            }

            // Enrich with user + original transaction reference in one round-trip each.
            const userIds = [...new Set((data || []).map(r => r.user_id).filter(Boolean))];
            const txIds = [...new Set((data || []).map(r => r.original_transaction_id).filter(Boolean))];

            let profilesById = {};
            if (userIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email')
                    .in('id', userIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            let txById = {};
            if (txIds.length) {
                const { data: txs } = await supabaseAdmin
                    .from('transactions')
                    .select('id, reference, type, status, amount, currency, provider, provider_reference')
                    .in('id', txIds);
                (txs || []).forEach(t => { txById[t.id] = t; });
            }

            const refunds = (data || []).map(r => ({
                ...r,
                amount: r.amount != null ? String(r.amount) : null,
                user: profilesById[r.user_id] || null,
                original_transaction: txById[r.original_transaction_id] || null
            }));

            sendOk(res, {
                refunds,
                count: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/refunds/summary
// ═════════════════════════════════════════════════════════════════

router.get(
    '/refunds/summary',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const countFor = async (statusSet) => {
                let q = supabaseAdmin
                    .from('refunds')
                    .select('id', { count: 'exact', head: true });
                if (statusSet) q = q.in('status', [...statusSet]);
                const { count, error } = await q;
                if (error) {
                    if (error.code === '42P01') {
                        const e = new Error('Refunds table not deployed.');
                        e.code = 'REFUNDS_TABLE_NOT_DEPLOYED';
                        e.status = 503;
                        throw e;
                    }
                    throw error;
                }
                return count || 0;
            };

            const [total, pendingApproval, processing, completed, failed, requested] =
                await Promise.all([
                    countFor(null),
                    countFor(new Set(['PENDING_APPROVAL'])),
                    countFor(new Set(['PROCESSING'])),
                    countFor(new Set(['COMPLETED'])),
                    countFor(new Set(['FAILED'])),
                    countFor(new Set(['REQUESTED']))
                ]);

            sendOk(res, {
                summary: {
                    total,
                    pending_approval: pendingApproval,
                    processing,
                    completed,
                    failed,
                    requested
                }
            });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/refunds/:id
// ═════════════════════════════════════════════════════════════════

router.get(
    '/refunds/:id',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const refund = await refundSvc.getRefund(req.params.id);

            // Enrich.
            let user = null, originalTx = null, refundTx = null, audit = [];

            if (refund.user_id) {
                const { data } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email, phone, status')
                    .eq('id', refund.user_id)
                    .maybeSingle();
                user = data || null;
            }
            if (refund.original_transaction_id) {
                const { data } = await supabaseAdmin
                    .from('transactions')
                    .select('id, reference, type, status, amount, currency, provider, provider_reference, description, created_at')
                    .eq('id', refund.original_transaction_id)
                    .maybeSingle();
                originalTx = data || null;
            }
            if (refund.refund_transaction_id) {
                const { data } = await supabaseAdmin
                    .from('transactions')
                    .select('id, reference, type, status, amount, currency, created_at')
                    .eq('id', refund.refund_transaction_id)
                    .maybeSingle();
                refundTx = data || null;
            }

            const { data: auditRows } = await supabaseAdmin
                .from('admin_audit_logs')
                .select('id, admin_id, action, reason, before, after, created_at, request_id')
                .eq('target_type', 'refund')
                .eq('target_id', refund.id)
                .order('created_at', { ascending: false })
                .limit(50);
            audit = auditRows || [];

            const adminIds = [...new Set(audit.map(a => a.admin_id).filter(Boolean))];
            let adminsById = {};
            if (adminIds.length) {
                const { data: admins } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email')
                    .in('id', adminIds);
                (admins || []).forEach(a => { adminsById[a.id] = a; });
            }

            sendOk(res, {
                refund: { ...refund, amount: refund.amount != null ? String(refund.amount) : null },
                user,
                original_transaction: originalTx,
                refund_transaction: refundTx,
                audit: audit.map(a => ({
                    ...a,
                    admin_username: adminsById[a.admin_id]?.username || null,
                    admin_email: adminsById[a.admin_id]?.email || null
                }))
            });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/admin/refunds/:id/approve
//
//  Second-approver action for refunds that require dual control.
//  Executes the refund via refundService only if the current admin
//  is NOT the one who requested it.
// ═════════════════════════════════════════════════════════════════

router.post(
    '/refunds/:id/approve',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) {
                throw Object.assign(new Error('A reason is required (min 4 characters).'), {
                    status: 422, code: 'REASON_REQUIRED'
                });
            }

            const ctx = adminCtx(req);
            const { data: refund, error } = await supabaseAdmin
                .from('refunds')
                .select('*')
                .eq('id', req.params.id)
                .maybeSingle();
            if (error) throw error;
            if (!refund) {
                throw Object.assign(new Error('Refund not found.'), { status: 404, code: 'REFUND_NOT_FOUND' });
            }
            if (refund.status !== 'PENDING_APPROVAL') {
                throw Object.assign(new Error(`Cannot approve a refund in status "${refund.status}".`), {
                    status: 409, code: 'INVALID_STATE'
                });
            }
            if (refund.requested_by && refund.requested_by === ctx.adminId) {
                throw Object.assign(new Error('The approver must differ from the requester.'), {
                    status: 403, code: 'SELF_APPROVAL_FORBIDDEN'
                });
            }

            // Mark approved, then execute.
            await supabaseAdmin
                .from('refunds')
                .update({
                    status: 'APPROVED',
                    approved_by: ctx.adminId,
                    approved_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', refund.id);

            await recordAudit({
                ctx,
                action: 'refund.approved',
                refundId: refund.id,
                before: { status: 'PENDING_APPROVAL' },
                after: { status: 'APPROVED' },
                reason
            });

            // Execute based on the refund_type that was recorded.
            let result;
            const idem = refund.idempotency_key || `admin-refund-${refund.id}`;
            if (refund.refund_type === 'wallet') {
                result = await refundSvc.executeWalletRefund({
                    transactionId: refund.original_transaction_id,
                    amount: Number(refund.amount),
                    reason: refund.reason,
                    ctx,
                    idempotencyKey: idem
                });
            } else if (refund.refund_type === 'provider') {
                result = await refundSvc.executeProviderRefund({
                    transactionId: refund.original_transaction_id,
                    amount: Number(refund.amount),
                    reason: refund.reason,
                    ctx,
                    idempotencyKey: idem
                });
            } else if (refund.refund_type === 'reversal') {
                result = await refundSvc.executeDepositReversal({
                    transactionId: refund.original_transaction_id,
                    amount: Number(refund.amount),
                    reason: refund.reason,
                    ctx,
                    idempotencyKey: idem
                });
            } else {
                throw Object.assign(new Error(`Unknown refund type "${refund.refund_type}".`), {
                    status: 500, code: 'REFUND_TYPE_UNKNOWN'
                });
            }

            sendOk(res, { executed: true, refund: result.refund });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/admin/refunds/:id/cancel
//
//  Cancels a REQUESTED or PENDING_APPROVAL refund. Only the
//  requester (or a super admin) can cancel.
// ═════════════════════════════════════════════════════════════════

router.post(
    '/refunds/:id/cancel',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) {
                throw Object.assign(new Error('A reason is required (min 4 characters).'), {
                    status: 422, code: 'REASON_REQUIRED'
                });
            }

            const ctx = adminCtx(req);
            const { data: refund, error } = await supabaseAdmin
                .from('refunds')
                .select('id, status, requested_by')
                .eq('id', req.params.id)
                .maybeSingle();
            if (error) throw error;
            if (!refund) {
                throw Object.assign(new Error('Refund not found.'), { status: 404, code: 'REFUND_NOT_FOUND' });
            }
            if (!['REQUESTED', 'PENDING_APPROVAL'].includes(refund.status)) {
                throw Object.assign(new Error(`Cannot cancel a refund in status "${refund.status}".`), {
                    status: 409, code: 'INVALID_STATE'
                });
            }

            await supabaseAdmin
                .from('refunds')
                .update({
                    status: 'CANCELLED',
                    failure_reason: reason,
                    updated_at: new Date().toISOString()
                })
                .eq('id', refund.id)
                .in('status', ['REQUESTED', 'PENDING_APPROVAL']);

            await recordAudit({
                ctx,
                action: 'refund.cancelled',
                refundId: refund.id,
                before: { status: refund.status },
                after: { status: 'CANCELLED' },
                reason
            });

            sendOk(res, { cancelled: true });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/admin/refunds/:id/retry
//
//  Retries a FAILED provider refund. Wallet refunds are handled
//  via the transaction drawer — those failures should be escalated,
//  not retried, because they mean the ledger was posted but the
//  record didn't attach.
// ═════════════════════════════════════════════════════════════════

router.post(
    '/refunds/:id/retry',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) {
                throw Object.assign(new Error('A reason is required (min 4 characters).'), {
                    status: 422, code: 'REASON_REQUIRED'
                });
            }

            const ctx = adminCtx(req);
            const { data: refund, error } = await supabaseAdmin
                .from('refunds')
                .select('*')
                .eq('id', req.params.id)
                .maybeSingle();
            if (error) throw error;
            if (!refund) {
                throw Object.assign(new Error('Refund not found.'), { status: 404, code: 'REFUND_NOT_FOUND' });
            }
            if (refund.status !== 'FAILED') {
                throw Object.assign(new Error(`Only FAILED refunds can be retried (current: ${refund.status}).`), {
                    status: 409, code: 'INVALID_STATE'
                });
            }
            if (refund.refund_type !== 'provider') {
                throw Object.assign(new Error('Only provider refunds can be retried from this page. Escalate wallet refund failures.'), {
                    status: 422, code: 'RETRY_NOT_ALLOWED'
                });
            }

            // Mark back to PROCESSING and re-invoke the adapter.
            await supabaseAdmin
                .from('refunds')
                .update({
                    status: 'PROCESSING',
                    failure_reason: null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', refund.id);

            await recordAudit({
                ctx,
                action: 'refund.retry_requested',
                refundId: refund.id,
                before: { status: 'FAILED' },
                after: { status: 'PROCESSING' },
                reason
            });

            // Re-run through refundService, which will call the provider adapter again.
            const result = await refundSvc.executeProviderRefund({
                transactionId: refund.original_transaction_id,
                amount: Number(refund.amount),
                reason: refund.reason || reason,
                ctx,
                idempotencyKey: `retry-${refund.id}-${Date.now()}`
            });

            sendOk(res, { retried: true, refund: result.refund });
        } catch (err) { sendErr(res, err); }
    }
);

module.exports = router;