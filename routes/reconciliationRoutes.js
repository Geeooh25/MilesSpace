// routes/reconciliationRoutes.js
// COMPLETE RECONCILIATION ROUTES — matches reconciliationService.js exports

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

// ─── IMPORT RECONCILIATION SERVICE ───
const reconciliationService = require('../services/reconciliationService');

// ─── ADMIN CHECK MIDDLEWARE ───
async function adminOnly(req, res, next) {
    try {
        if (!req.user?.id) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .eq('id', req.user.id)
            .single();

        if (error || !profile) {
            return res.status(403).json({ success: false, error: 'Profile not found' });
        }

        if (!['admin', 'super_admin'].includes(profile.role)) {
            return res.status(403).json({
                success: false,
                error: 'Admin access required',
                code: 'ADMIN_ONLY'
            });
        }

        req.adminProfile = profile;
        next();
    } catch (error) {
        console.error('❌ [RECONCILE ROUTE] Admin check failed:', error.message);
        res.status(500).json({ success: false, error: 'Authorization failed' });
    }
}

// ═══════════════════════════════════════════════════════════════════════
// AIRTIME RECONCILIATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

// ─── GET /api/reconciliation/airtime/pending ───
// Lists all stuck airtime transactions for admin review.
router.get('/airtime/pending', authMiddleware, adminOnly, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);

        const { data, error } = await supabaseAdmin
            .from('airtime_transactions')
            .select(`
                id,
                reference,
                user_id,
                country_code,
                phone_number,
                operator_id,
                operator_name,
                destination_amount,
                destination_currency,
                total_amount,
                currency,
                wallet_type,
                provider,
                provider_transaction_id,
                dtone_external_id,
                status,
                provider_status,
                refunded,
                failure_code,
                failure_message,
                reconciliation_attempts,
                last_reconciliation_at,
                created_at,
                updated_at
            `)
            .in('status', ['processing', 'pending'])
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('❌ [RECONCILE ROUTE] Pending list error:', error.message);
            return res.status(500).json({ success: false, error: error.message });
        }

        res.json({
            success: true,
            total: data?.length || 0,
            data: data || []
        });
    } catch (error) {
        console.error('❌ [RECONCILE ROUTE] Pending error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to list pending transactions' });
    }
});

// ─── POST /api/reconciliation/airtime/sweep ───
// Manually triggers the reconciliation sweep for stuck airtime transactions.
router.post('/airtime/sweep', authMiddleware, adminOnly, async (req, res) => {
    try {
        console.log('🔄 [RECONCILE ROUTE] Manual sweep triggered by', req.user.email);

        const result = await reconciliationService.reconcileStuckAirtimeTransactions();

        res.json({
            success: true,
            message: 'Airtime reconciliation sweep complete',
            result: result || { processed: 0 }
        });
    } catch (error) {
        console.error('❌ [RECONCILE ROUTE] Sweep error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Sweep failed',
            details: error.message
        });
    }
});

// ─── POST /api/reconciliation/airtime/force/:id ───
// Force reconcile a single airtime transaction by ID.
router.post('/airtime/force/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ success: false, error: 'Transaction ID required' });
        }

        console.log(`🔄 [RECONCILE ROUTE] Force reconcile ${id} by ${req.user.email}`);

        const result = await reconciliationService.forceReconcile(
            id,
            'airtime_transactions'
        );

        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error || 'Force reconcile failed'
            });
        }

        res.json({
            success: true,
            message: result.message || 'Force reconcile complete',
            newStatus: result.newStatus,
            refunded: result.refunded || false
        });
    } catch (error) {
        console.error('❌ [RECONCILE ROUTE] Force error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/reconciliation/airtime/stats ───
// Returns counts of transactions in each state.
router.get('/airtime/stats', authMiddleware, adminOnly, async (req, res) => {
    try {
        const statuses = ['processing', 'pending', 'manual_review', 'completed', 'failed', 'refunded'];
        const statusMap = {};

        for (const status of statuses) {
            const { count, error } = await supabaseAdmin
                .from('airtime_transactions')
                .select('*', { count: 'exact', head: true })
                .eq('status', status);

            if (error) {
                console.warn(`⚠️ [RECONCILE ROUTE] Stats count failed for ${status}:`, error.message);
                statusMap[status] = 0;
            } else {
                statusMap[status] = count || 0;
            }
        }

        // Also count refunded separately
        const { count: refundedCount } = await supabaseAdmin
            .from('airtime_transactions')
            .select('*', { count: 'exact', head: true })
            .eq('refunded', true);

        res.json({
            success: true,
            data: {
                processing: statusMap.processing,
                pending: statusMap.pending,
                manual_review: statusMap.manual_review,
                completed: statusMap.completed,
                failed: statusMap.failed,
                refunded: statusMap.refunded,
                total_refunded: refundedCount || 0,
                total_stuck: statusMap.processing + statusMap.pending,
                total_all: Object.values(statusMap).reduce((a, b) => a + b, 0)
            }
        });
    } catch (error) {
        console.error('❌ [RECONCILE ROUTE] Stats error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to compute stats' });
    }
});

// ─── POST /api/reconciliation/airtime/bulk ───
// Force reconcile multiple transactions at once.
// Body: { ids: [1, 2, 3] } or { references: ['AT-...', 'AT-...'] }
router.post('/airtime/bulk', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { ids, references } = req.body;

        if (!Array.isArray(ids) && !Array.isArray(references)) {
            return res.status(400).json({
                success: false,
                error: 'Provide either an "ids" array or a "references" array'
            });
        }

        // Resolve references to IDs if needed
        let transactionIds = ids || [];

        if (!transactionIds.length && references?.length) {
            const { data: found, error } = await supabaseAdmin
                .from('airtime_transactions')
                .select('id')
                .in('reference', references);

            if (error) {
                console.error('❌ [RECONCILE ROUTE] Bulk lookup error:', error.message);
                return res.status(500).json({ success: false, error: error.message });
            }

            transactionIds = (found || []).map(t => t.id);
        }

        if (!transactionIds.length) {
            return res.status(400).json({ success: false, error: 'No matching transactions found' });
        }

        console.log(
            `🔄 [RECONCILE ROUTE] Bulk reconcile ${transactionIds.length} transactions by ${req.user.email}`
        );

        const results = {
            total: transactionIds.length,
            success: 0,
            failed: 0,
            refunded: 0,
            manual_review: 0,
            still_processing: 0,
            details: []
        };

        for (const transactionId of transactionIds) {
            try {
                const r = await reconciliationService.forceReconcile(
                    transactionId,
                    'airtime_transactions'
                );

                if (r.success) {
                    if (r.newStatus === 'completed') results.success++;
                    else if (r.newStatus === 'failed') {
                        results.failed++;
                        if (r.refunded) results.refunded++;
                    }
                    else if (r.newStatus === 'manual_review') results.manual_review++;
                    else if (r.newStatus === 'processing') results.still_processing++;
                } else {
                    results.failed++;
                }

                results.details.push({
                    id: transactionId,
                    success: r.success,
                    newStatus: r.newStatus || null,
                    refunded: r.refunded || false,
                    error: r.error || null
                });
            } catch (itemError) {
                results.failed++;
                results.details.push({
                    id: transactionId,
                    success: false,
                    error: itemError.message
                });
            }
        }

        res.json({
            success: true,
            message: 'Bulk reconciliation complete',
            results
        });
    } catch (error) {
        console.error('❌ [RECONCILE ROUTE] Bulk error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// CASHBACK RECONCILIATION ENDPOINTS (optional but useful)
// ═══════════════════════════════════════════════════════════════════════

// ─── POST /api/reconciliation/cashback/sweep ───
router.post('/cashback/sweep', authMiddleware, adminOnly, async (req, res) => {
    try {
        console.log('🔄 [RECONCILE ROUTE] Cashback sweep triggered by', req.user.email);

        const result = await reconciliationService.reconcileStuckCashbackTransactions();

        res.json({
            success: true,
            message: 'Cashback reconciliation sweep complete',
            result: result || { processed: 0 }
        });
    } catch (error) {
        console.error('❌ [RECONCILE ROUTE] Cashback sweep error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/reconciliation/cashback/pending ───
router.get('/cashback/pending', authMiddleware, adminOnly, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);

        const { data, error } = await supabaseAdmin
            .from('cashback_transactions')
            .select('*')
            .eq('status', 'processing')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            return res.status(500).json({ success: false, error: error.message });
        }

        res.json({
            success: true,
            total: data?.length || 0,
            data: data || []
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL RECONCILIATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

// ─── POST /api/reconciliation/full-sweep ───
// Runs full reconciliation (cashback + airtime) in one call.
router.post('/full-sweep', authMiddleware, adminOnly, async (req, res) => {
    try {
        console.log('🔄 [RECONCILE ROUTE] Full sweep triggered by', req.user.email);

        const result = await reconciliationService.runFullReconciliation();

        res.json({
            success: true,
            message: 'Full reconciliation complete',
            result
        });
    } catch (error) {
        console.error('❌ [RECONCILE ROUTE] Full sweep error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/reconciliation/health ───
router.get('/health', authMiddleware, adminOnly, async (req, res) => {
    try {
        // Quick counts
        const { count: stuckAirtime } = await supabaseAdmin
            .from('airtime_transactions')
            .select('*', { count: 'exact', head: true })
            .in('status', ['processing', 'pending']);

        const { count: stuckCashback } = await supabaseAdmin
            .from('cashback_transactions')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'processing');

        res.json({
            success: true,
            status: 'healthy',
            service: 'reconciliation',
            stuck_airtime: stuckAirtime || 0,
            stuck_cashback: stuckCashback || 0,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;