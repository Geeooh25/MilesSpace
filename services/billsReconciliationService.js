// services/billsReconciliationService.js
// MilesSpace — Bills reconciliation worker
// Sweeps bill_payment_transactions for stuck orders

const { supabaseAdmin } = require('../db/supabase');
const vtpassService = require('./vtpassService');
const { LedgerService } = require('./ledgerService');

// ─── CONFIG ──────────────────────────────────────────────────────────
const INTERVAL_MS = Number(process.env.BILLS_RECONCILE_INTERVAL_MS || 5 * 60 * 1000);
const MIN_AGE_MS = Number(process.env.BILLS_RECONCILE_MIN_AGE_MS || 5 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.BILLS_RECONCILE_MAX_ATTEMPTS || 20);
const MAX_AGE_HOURS = Number(process.env.BILLS_RECONCILE_MAX_AGE_HOURS || 26);
const BATCH_SIZE = Number(process.env.BILLS_RECONCILE_BATCH_SIZE || 50);

let schedulerHandle = null;
let running = false;

// ─── FIND STUCK ORDERS ───────────────────────────────────────────────
async function findStuckOrders() {
    const cutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();

    const { data, error } = await supabaseAdmin
        .from('bill_payment_transactions')
        .select('*')
        .in('status', ['pending', 'processing', 'provider_unknown'])
        .lt('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE);

    if (error) throw error;
    return data || [];
}

// ─── UPDATE TRANSACTION ──────────────────────────────────────────────
async function updateTransaction(transactionId, updates) {
    const { data, error } = await supabaseAdmin
        .from('bill_payment_transactions')
        .update({
            ...updates,
            updated_at: new Date().toISOString()
        })
        .eq('id', transactionId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

// ─── CREATE NOTIFICATION ─────────────────────────────────────────────
async function createNotification(userId, title, message, type, link) {
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title,
            message,
            type,
            icon: type === 'success' ? '✅' : type === 'error' ? '❌' : '📌',
            link: link || '/bills',
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.error('Notification error:', e);
    }
}

// ─── RECONCILE ONE ORDER ─────────────────────────────────────────────
async function reconcileOne(order) {
    const logPrefix = `[BILLS RECON ${order.reference}]`;

    // Age cap
    const ageMs = Date.now() - new Date(order.created_at).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    if (ageHours >= MAX_AGE_HOURS) {
        console.warn(`${logPrefix} age ${ageHours.toFixed(1)}h exceeds cap → manual_review`);
        await updateTransaction(order.id, {
            status: 'manual_review',
            failure_reason: `Exceeded ${MAX_AGE_HOURS}h reconciliation window`
        });
        return { action: 'manual_review', orderId: order.id };
    }

    // Attempt cap
    if ((order.reconciliation_attempts || 0) >= MAX_ATTEMPTS) {
        console.warn(`${logPrefix} attempts ${order.reconciliation_attempts} >= ${MAX_ATTEMPTS} → manual_review`);
        await updateTransaction(order.id, {
            status: 'manual_review',
            failure_reason: `Exceeded ${MAX_ATTEMPTS} reconciliation attempts`
        });
        return { action: 'manual_review', orderId: order.id };
    }

    // No provider request id
    if (!order.provider_request_id) {
        await updateTransaction(order.id, {
            reconciliation_attempts: (order.reconciliation_attempts || 0) + 1,
            last_reconciliation_at: new Date().toISOString()
        });
        return { action: 'skipped', orderId: order.id, reason: 'no_provider_request_id' };
    }

    // Requery VTpass
    let requery;
    try {
        requery = await vtpassService.queryTransaction(order.provider_request_id);
    } catch (err) {
        console.warn(`${logPrefix} requery failed: ${err.message}`);
        await updateTransaction(order.id, {
            reconciliation_attempts: (order.reconciliation_attempts || 0) + 1,
            last_reconciliation_at: new Date().toISOString()
        });
        return { action: 'requery_failed', orderId: order.id, reason: err.message };
    }

    // Handle completed
    if (requery.state === 'completed') {
        await updateTransaction(order.id, {
            status: 'completed',
            provider_status: requery.providerStatus,
            provider_code: requery.code,
            provider_transaction_id: requery.transactionId || order.provider_transaction_id,
            token: requery.token || order.token,
            units: requery.units || order.units,
            completed_at: new Date().toISOString(),
            reconciliation_attempts: (order.reconciliation_attempts || 0) + 1,
            last_reconciliation_at: new Date().toISOString()
        });

        await createNotification(
            order.user_id,
            'Transaction Completed',
            `Your ${order.service_type} purchase of ₦${parseFloat(order.customer_amount).toFixed(2)} was completed successfully.`,
            'success'
        );

        return { action: 'completed', orderId: order.id };
    }

    // Handle failed
    if (requery.state === 'failed') {
        // Refund if we haven't already
        if (order.ledger_transaction_id && !order.refunded) {
            try {
                const refundResult = await LedgerService.refundTransaction({
                    userId: order.user_id,
                    transactionId: order.ledger_transaction_id,
                    reference: `${order.reference}-REFUND`,
                    reason: requery.friendlyError || 'Provider transaction failed'
                });

                await updateTransaction(order.id, {
                    status: 'failed',
                    provider_status: requery.providerStatus,
                    provider_code: requery.code,
                    failure_reason: requery.friendlyError,
                    failed_at: new Date().toISOString(),
                    refunded: refundResult.success,
                    refunded_at: refundResult.success ? new Date().toISOString() : null,
                    reconciliation_attempts: (order.reconciliation_attempts || 0) + 1,
                    last_reconciliation_at: new Date().toISOString()
                });

                if (refundResult.success) {
                    await createNotification(
                        order.user_id,
                        'Transaction Failed - Refunded',
                        `Your ${order.service_type} purchase of ₦${parseFloat(order.customer_amount).toFixed(2)} failed. Your wallet has been refunded.`,
                        'error'
                    );
                }
            } catch (refundError) {
                console.error(`${logPrefix} refund failed:`, refundError.message);
                await updateTransaction(order.id, {
                    status: 'manual_review',
                    failure_reason: `Refund failed: ${refundError.message}`,
                    reconciliation_attempts: (order.reconciliation_attempts || 0) + 1,
                    last_reconciliation_at: new Date().toISOString()
                });
                return { action: 'refund_failed', orderId: order.id };
            }
        } else {
            await updateTransaction(order.id, {
                status: 'failed',
                provider_status: requery.providerStatus,
                provider_code: requery.code,
                failure_reason: requery.friendlyError,
                failed_at: new Date().toISOString(),
                reconciliation_attempts: (order.reconciliation_attempts || 0) + 1,
                last_reconciliation_at: new Date().toISOString()
            });
        }

        return { action: 'failed_refunded', orderId: order.id };
    }

    // Still processing
    await updateTransaction(order.id, {
        status: 'processing',
        provider_status: requery.providerStatus,
        provider_code: requery.code,
        reconciliation_attempts: (order.reconciliation_attempts || 0) + 1,
        last_reconciliation_at: new Date().toISOString()
    });

    return { action: 'still_processing', orderId: order.id };
}

// ─── RUN SWEEP ───────────────────────────────────────────────────────
async function runSweep() {
    const startedAt = Date.now();

    const summary = {
        startedAt: new Date(startedAt).toISOString(),
        scanned: 0,
        completed: 0,
        refunded: 0,
        stillProcessing: 0,
        manualReview: 0,
        requeryFailed: 0,
        refundFailed: 0,
        errors: 0,
        durationMs: 0
    };

    let orders;
    try {
        orders = await findStuckOrders();
    } catch (err) {
        console.error('[BILLS RECON] findStuckOrders failed:', err.message);
        summary.errors++;
        summary.durationMs = Date.now() - startedAt;
        return summary;
    }

    summary.scanned = orders.length;

    for (const order of orders) {
        try {
            const result = await reconcileOne(order);

            switch (result.action) {
                case 'completed':
                    summary.completed++;
                    break;
                case 'failed_refunded':
                    summary.refunded++;
                    break;
                case 'still_processing':
                    summary.stillProcessing++;
                    break;
                case 'manual_review':
                    summary.manualReview++;
                    break;
                case 'requery_failed':
                    summary.requeryFailed++;
                    break;
                case 'refund_failed':
                    summary.refundFailed++;
                    break;
                default:
                    break;
            }
        } catch (err) {
            console.error(`[BILLS RECON ${order.reference}] reconcileOne threw:`, err.message);
            summary.errors++;
        }
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
}

// ─── SCHEDULER ───────────────────────────────────────────────────────
function startBillsReconciliationScheduler() {
    if (schedulerHandle) {
        console.log('[BILLS RECON] Scheduler already running');
        return schedulerHandle;
    }

    console.log(`[BILLS RECON] Starting scheduler (every ${Math.round(INTERVAL_MS / 1000)}s)`);

    // Initial sweep after 15 seconds
    setTimeout(() => {
        runSweep()
            .then((summary) => {
                console.log(`[BILLS RECON] Initial sweep: scanned=${summary.scanned} completed=${summary.completed} refunded=${summary.refunded} duration=${summary.durationMs}ms`);
            })
            .catch((err) => {
                console.error('[BILLS RECON] Initial sweep failed:', err.message);
            });
    }, 15000);

    schedulerHandle = setInterval(async () => {
        if (running) {
            console.warn('[BILLS RECON] Previous sweep still running — skipping');
            return;
        }

        running = true;
        try {
            const summary = await runSweep();
            if (summary.scanned > 0) {
                console.log(`[BILLS RECON] Sweep: scanned=${summary.scanned} completed=${summary.completed} refunded=${summary.refunded} still=${summary.stillProcessing} manual=${summary.manualReview} duration=${summary.durationMs}ms`);
            }
        } catch (err) {
            console.error('[BILLS RECON] Sweep error:', err.message);
        } finally {
            running = false;
        }
    }, INTERVAL_MS);

    return schedulerHandle;
}

function stopBillsReconciliationScheduler() {
    if (schedulerHandle) {
        clearInterval(schedulerHandle);
        schedulerHandle = null;
        console.log('[BILLS RECON] Scheduler stopped');
    }
}

module.exports = {
    startBillsReconciliationScheduler,
    stopBillsReconciliationScheduler,
    runSweep,
    reconcileOne
};