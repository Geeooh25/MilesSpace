// services/reconciliationService.js
// COMPLETE RECONCILIATION SERVICE — CASHBACK + AIRTIME
// Uses VTpass for cashback, DT One for airtime.
// No DingConnect references.

const { supabaseAdmin } = require('../db/supabase');
const vtpassService = require('./vtpassService');
const dtoneService = require('./dtoneService');
const { LedgerService } = require('./ledgerService');

// ─── CONFIG ──────────────────────────────────────────────────────────────
const STUCK_AFTER_MS = 5 * 60 * 1000;
const MAX_RECONCILIATION_ATTEMPTS = 5;
const BATCH_SIZE = 50;
const PROVIDER_QUERY_TIMEOUT_MS = 15000;

// ─── LOGGING ─────────────────────────────────────────────────────────────
function logReconciliation(message, data = {}) {
    console.log(`🔄 [RECONCILE] ${message}`, data);
}
function logError(message, error) {
    console.error(`❌ [RECONCILE] ${message}`, error);
}

// ─── NORMALIZATION ───────────────────────────────────────────────────────
function normalizeAirtimeProviderStatus(result) {
    const raw = String(
        result?.status ||
        result?.providerStatus ||
        result?.state ||
        ''
    ).toLowerCase().trim();

    if (['completed', 'complete', 'success', 'successful', 'delivered', 'sent', 'processed'].includes(raw)) {
        return { status: 'completed', final: true, display: 'Completed' };
    }
    if (['failed', 'declined', 'rejected', 'cancelled', 'canceled', 'error', 'timeout', 'expired', 'reversed'].includes(raw)) {
        return { status: 'failed', final: true, display: 'Failed' };
    }
    if (['pending', 'processing', 'submitted', 'created', 'in_progress', 'initiated', 'queued', 'waiting'].includes(raw)) {
        return { status: 'processing', final: false, display: 'Processing' };
    }
    return { status: 'processing', final: false, display: 'Unknown', raw };
}

// ═══════════════════════════════════════════════════════════════════════
// CASHBACK RECONCILIATION (VTpass)
// ═══════════════════════════════════════════════════════════════════════
async function reconcileStuckCashbackTransactions() {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();

    const { data: stuck, error } = await supabaseAdmin
        .from('cashback_transactions')
        .select('*')
        .eq('status', 'processing')
        .lt('created_at', cutoff)
        .lt('reconciliation_attempts', MAX_RECONCILIATION_ATTEMPTS)
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE);

    if (error) {
        logError('Cashback query error:', error);
        return { success: false, error: error.message };
    }

    if (!stuck || stuck.length === 0) {
        logReconciliation('No stuck cashback transactions found');
        return { success: true, processed: 0 };
    }

    logReconciliation(`Found ${stuck.length} stuck cashback transactions to reconcile`);

    let processed = 0, successCount = 0, failedCount = 0, skippedCount = 0;

    for (const tx of stuck) {
        try {
            const result = await reconcileSingleCashbackTransaction(tx);
            processed++;
            if (result.status === 'success') successCount++;
            else if (result.status === 'failed') failedCount++;
            else skippedCount++;
        } catch (error) {
            logError(`Error processing cashback ${tx.reference}:`, error);
            try {
                await supabaseAdmin
                    .from('cashback_transactions')
                    .update({
                        reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
                        last_reconciliation_at: new Date().toISOString(),
                        metadata: {
                            ...(tx.metadata || {}),
                            reconciliation_error: error.message,
                            reconciliation_error_at: new Date().toISOString()
                        }
                    })
                    .eq('id', tx.id);
                skippedCount++;
            } catch (updateError) {
                logError(`Failed to update attempts for ${tx.reference}:`, updateError);
            }
        }
    }

    logReconciliation(`Cashback complete: ${successCount} success, ${failedCount} failed, ${skippedCount} skipped`);
    return { success: true, processed, successCount, failedCount, skippedCount };
}

async function reconcileSingleCashbackTransaction(tx) {
    const requestId = tx.metadata?.vtpass_request_id ||
                      tx.provider_reference ||
                      tx.metadata?.request_id;

    if (!requestId) {
        logReconciliation(`No request ID for ${tx.reference}, skipping`);
        await supabaseAdmin
            .from('cashback_transactions')
            .update({
                reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
                last_reconciliation_at: new Date().toISOString(),
                metadata: {
                    ...(tx.metadata || {}),
                    reconciliation_error: 'No provider request ID found'
                }
            })
            .eq('id', tx.id);
        return { status: 'skipped', reason: 'No request ID' };
    }

    logReconciliation(`Querying VTpass for ${tx.reference} (${requestId})`);
    const result = await vtpassService.queryTransaction(requestId);

    logReconciliation(`VTpass result for ${tx.reference}:`, {
        status: result.status,
        transactionId: result.transactionId,
        error: result.error
    });

    if (result.status === 'success' || result.status === 'delivered') {
        await supabaseAdmin
            .from('cashback_transactions')
            .update({
                status: 'success',
                provider_reference: result.transactionId || tx.provider_reference,
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
                last_reconciliation_at: new Date().toISOString(),
                metadata: {
                    ...(tx.metadata || {}),
                    reconciled_at: new Date().toISOString(),
                    reconciled_status: result.status,
                    reconciliation_success: true
                }
            })
            .eq('id', tx.id);

        await createNotification(
            tx.user_id,
            '✅ Cashback Delivered',
            `Your cashback redemption of ₦${tx.amount} was confirmed by provider.`,
            'cashback_completed',
            `/cashback/transaction/${tx.id}`
        );
        logReconciliation(`✅ ${tx.reference} → SUCCESS (VTpass confirmed)`);
        return { status: 'success' };
    }

    if (result.status === 'failed' || result.status === 'error') {
        return await refundCashbackTransaction(tx, result);
    }

    const attempts = (tx.reconciliation_attempts || 0) + 1;
    await supabaseAdmin
        .from('cashback_transactions')
        .update({
            reconciliation_attempts: attempts,
            last_reconciliation_at: new Date().toISOString(),
            metadata: {
                ...(tx.metadata || {}),
                last_reconciliation_attempt: new Date().toISOString(),
                reconciliation_status: result.status || 'unknown'
            }
        })
        .eq('id', tx.id);

    logReconciliation(`⏳ ${tx.reference} still ${result.status || 'processing'} (attempt ${attempts}/${MAX_RECONCILIATION_ATTEMPTS})`);
    return { status: 'pending' };
}

async function refundCashbackTransaction(tx, providerResult = null) {
    const { data: credited, error: creditError } = await supabaseAdmin
        .rpc('credit_cashback_wallet_atomic', {
            p_user_id: tx.user_id,
            p_amount: tx.amount,
            p_source: 'reconciliation_refund',
            p_metadata: {
                original_reference: tx.reference,
                original_type: 'cashback_redeem',
                provider_status: providerResult?.status || 'failed',
                reason: providerResult?.error || 'Provider reported failure'
            },
            p_reference: `REF-${tx.reference}`
        });

    if (creditError) {
        logError(`Refund failed for ${tx.reference}:`, creditError);
        await supabaseAdmin
            .from('cashback_transactions')
            .update({
                status: 'manual_review',
                reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
                last_reconciliation_at: new Date().toISOString(),
                metadata: {
                    ...(tx.metadata || {}),
                    reconciliation_error: `Refund failed: ${creditError.message}`,
                    reconciled_at: new Date().toISOString()
                }
            })
            .eq('id', tx.id);
        return { status: 'failed', reason: 'Refund error' };
    }

    const refundBalance = credited?.[0]?.balance ?? tx.balance_before;

    await supabaseAdmin
        .from('cashback_transactions')
        .update({
            status: 'failed',
            balance_after: refundBalance,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
            last_reconciliation_at: new Date().toISOString(),
            metadata: {
                ...(tx.metadata || {}),
                refunded: true,
                refunded_at: new Date().toISOString(),
                reconciled_at: new Date().toISOString(),
                reconciled_status: providerResult?.status || 'failed',
                reconciliation_error: providerResult?.friendlyError || providerResult?.error || 'Provider reported failure'
            }
        })
        .eq('id', tx.id);

    await createNotification(
        tx.user_id,
        '💸 Cashback Refunded',
        `Your cashback redemption of ₦${tx.amount} failed and has been refunded to your wallet.`,
        'cashback_refunded',
        `/cashback/transaction/${tx.id}`
    );

    logReconciliation(`💸 ${tx.reference} → FAILED, refunded ₦${tx.amount}`);
    return { status: 'failed', refunded: true };
}

// ═══════════════════════════════════════════════════════════════════════
// AIRTIME RECONCILIATION (DT One)
// ═══════════════════════════════════════════════════════════════════════
async function reconcileStuckAirtimeTransactions() {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();

    const { data: stuck, error } = await supabaseAdmin
        .from('airtime_transactions')
        .select('*')
        .in('status', ['processing', 'pending'])
        .lt('created_at', cutoff)
        .lt('reconciliation_attempts', MAX_RECONCILIATION_ATTEMPTS)
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE);

    if (error) {
        logError('Airtime query error:', error);
        return { success: false, error: error.message };
    }

    if (!stuck || stuck.length === 0) {
        logReconciliation('No stuck airtime transactions found');
        return { success: true, processed: 0 };
    }

    logReconciliation(`Found ${stuck.length} stuck airtime transactions to reconcile`);

    let processed = 0, successCount = 0, failedCount = 0, skippedCount = 0;

    for (const tx of stuck) {
        try {
            const result = await reconcileSingleAirtimeTransaction(tx);
            processed++;
            if (result.status === 'success') successCount++;
            else if (result.status === 'failed') failedCount++;
            else skippedCount++;
        } catch (error) {
            logError(`Error processing airtime ${tx.reference}:`, error);
            await incrementAirtimeAttempts(tx, error.message);
            skippedCount++;
        }
    }

    logReconciliation(`Airtime complete: ${successCount} success, ${failedCount} failed, ${skippedCount} skipped`);
    return { success: true, processed, successCount, failedCount, skippedCount };
}

async function reconcileSingleAirtimeTransaction(tx) {
    // DT One uses provider_transaction_id (async ID) as the primary identifier
    const providerTxId = tx.provider_transaction_id;
    const externalId = tx.dtone_external_id;

    if (!providerTxId && !externalId) {
        logReconciliation(`No DT One identifier for ${tx.reference}, skipping`);
        await incrementAirtimeAttempts(tx, 'No DT One transaction ID or external ID');
        return { status: 'skipped', reason: 'No DT One identifier' };
    }

    logReconciliation(`Querying DT One for ${tx.reference}`, {
        provider_transaction_id: providerTxId,
        dtone_external_id: externalId
    });

    let result;
    try {
        if (providerTxId) {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Provider query timeout')), PROVIDER_QUERY_TIMEOUT_MS)
            );
            const queryPromise = dtoneService.queryTransaction(providerTxId);
            result = await Promise.race([queryPromise, timeoutPromise]);
        } else {
            // Fallback to external ID lookup
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Provider query timeout')), PROVIDER_QUERY_TIMEOUT_MS)
            );
            const lookupPromise = dtoneService.getTransactionByExternalId(externalId);
            const raw = await Promise.race([lookupPromise, timeoutPromise]);
            const transaction = Array.isArray(raw) ? raw[0] : raw;
            if (!transaction) throw new Error('Transaction not found by external ID');
            const statusObj = transaction?.status || {};
            const providerStatus = String(statusObj.message || statusObj.class?.message || '').toUpperCase();
            const normalized = dtoneService.normalizeStatus(statusObj);
            result = {
                status: normalized.status,
                providerStatus: providerStatus || normalized.code,
                isFinal: normalized.final,
                code: normalized.code,
                raw: transaction
            };
        }
    } catch (error) {
        logError(`DT One query failed for ${tx.reference}:`, error);
        await incrementAirtimeAttempts(tx, error.message);
        return { status: 'pending', reason: 'Provider query failed' };
    }

    logReconciliation(`DT One result for ${tx.reference}:`, {
        status: result?.status,
        providerStatus: result?.providerStatus,
        isFinal: result?.isFinal
    });

    const normalized = normalizeAirtimeProviderStatus(result);

    if (normalized.status === 'completed') {
        await supabaseAdmin
            .from('airtime_transactions')
            .update({
                status: 'completed',
                provider_status: result.providerStatus || 'COMPLETED',
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
                last_reconciliation_at: new Date().toISOString(),
                metadata: {
                    ...(tx.metadata || {}),
                    reconciled_at: new Date().toISOString(),
                    reconciled_status: result.status,
                    reconciliation_success: true,
                    provider_response: result.raw || null
                }
            })
            .eq('id', tx.id);

        await createNotification(
            tx.user_id,
            '📱 Airtime Delivered',
            `Airtime to ${tx.country_code} was delivered successfully.`,
            'airtime_sent',
            `/airtime/order/${tx.reference}`
        );

        logReconciliation(`✅ ${tx.reference} → SUCCESS (DT One confirmed)`);
        return { status: 'success' };
    }

    if (normalized.status === 'failed') {
        return await refundAirtimeTransaction(tx, result);
    }

    await incrementAirtimeAttempts(tx, normalized.display || 'processing');
    logReconciliation(`⏳ ${tx.reference} still ${normalized.display} (attempt ${(tx.reconciliation_attempts || 0) + 1}/${MAX_RECONCILIATION_ATTEMPTS})`);
    return { status: 'pending' };
}

async function refundAirtimeTransaction(tx, providerResult = null) {
    const userId = tx.user_id;
    const currency = tx.currency || 'USD';
    const refundAmount = parseFloat(tx.total_amount) || 0;

    if (tx.refunded) {
        logReconciliation(`⏭️ ${tx.reference} already refunded`);
        return { status: 'failed', refunded: true };
    }

    try {
        await LedgerService.creditWallet(
            userId,
            refundAmount,
            currency,
            `Auto-refund for airtime ${tx.reference}`,
            {
                original_reference: tx.reference,
                original_transaction_id: tx.id,
                original_type: 'airtime_purchase',
                reason: providerResult?.error || 'Provider reported failure',
                refund_type: 'auto_reconciliation'
            }
        );
    } catch (creditError) {
        logError(`Refund failed for ${tx.reference}:`, creditError);
        await supabaseAdmin
            .from('airtime_transactions')
            .update({
                status: 'manual_review',
                reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
                last_reconciliation_at: new Date().toISOString(),
                metadata: {
                    ...(tx.metadata || {}),
                    reconciliation_error: `Refund failed: ${creditError.message}`
                }
            })
            .eq('id', tx.id);
        return { status: 'failed', reason: 'Refund error' };
    }

    await supabaseAdmin
        .from('airtime_transactions')
        .update({
            status: 'failed',
            provider_status: providerResult?.providerStatus || 'FAILED',
            failed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            refunded: true,
            failure_code: providerResult?.code || 'RECONCILIATION_FAILED',
            failure_message: providerResult?.error || 'Provider reported failure',
            reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
            last_reconciliation_at: new Date().toISOString(),
            metadata: {
                ...(tx.metadata || {}),
                refunded: true,
                refunded_at: new Date().toISOString(),
                reconciled_at: new Date().toISOString(),
                reconciled_status: providerResult?.status || 'failed'
            }
        })
        .eq('id', tx.id)
        .eq('refunded', false);

    await createNotification(
        tx.user_id,
        '💸 Airtime Refunded',
        `Airtime to ${tx.country_code} failed and has been refunded to your wallet.`,
        'airtime_refunded',
        `/airtime/order/${tx.reference}`
    );

    logReconciliation(`💸 ${tx.reference} → FAILED, refunded ${currency} ${refundAmount}`);
    return { status: 'failed', refunded: true };
}

// ─── UTILITY ─────────────────────────────────────────────────────────────
async function incrementAirtimeAttempts(tx, error = null) {
    const attempts = (tx.reconciliation_attempts || 0) + 1;
    const updates = {
        reconciliation_attempts: attempts,
        last_reconciliation_at: new Date().toISOString()
    };
    if (error) {
        updates.metadata = {
            ...(tx.metadata || {}),
            last_reconciliation_error: typeof error === 'string' ? error : error.message,
            last_reconciliation_error_at: new Date().toISOString()
        };
    }
    await supabaseAdmin
        .from('airtime_transactions')
        .update(updates)
        .eq('id', tx.id);
}

async function incrementReconciliationAttempts(tx, error = null) {
    const table = tx.type === 'airtime' ? 'airtime_transactions' : 'cashback_transactions';
    const attempts = (tx.reconciliation_attempts || 0) + 1;
    const updates = {
        reconciliation_attempts: attempts,
        last_reconciliation_at: new Date().toISOString()
    };
    if (error) {
        updates.metadata = {
            ...(tx.metadata || {}),
            last_reconciliation_error: typeof error === 'string' ? error : error.message,
            last_reconciliation_error_at: new Date().toISOString()
        };
    }
    await supabaseAdmin.from(table).update(updates).eq('id', tx.id);
}

async function createNotification(userId, title, message, type = 'info', link = null) {
    try {
        const iconMap = {
            cashback_completed: '✅',
            cashback_refunded: '💸',
            airtime_sent: '📱',
            airtime_processing: '⏳',
            airtime_failed: '❌',
            airtime_refunded: '💸',
            info: '📌'
        };
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title,
            message,
            type,
            icon: iconMap[type] || iconMap.info,
            link: link || '/',
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        logError('Notification error:', e);
    }
}

// ─── MAIN ────────────────────────────────────────────────────────────────
async function runFullReconciliation() {
    logReconciliation('Starting full reconciliation...');
    const results = {
        cashback: null,
        airtime: null,
        timestamp: new Date().toISOString()
    };

    try {
        results.cashback = await reconcileStuckCashbackTransactions();
    } catch (error) {
        logError('Cashback reconciliation failed:', error);
        results.cashback = { success: false, error: error.message };
    }

    try {
        results.airtime = await reconcileStuckAirtimeTransactions();
    } catch (error) {
        logError('Airtime reconciliation failed:', error);
        results.airtime = { success: false, error: error.message };
    }

    logReconciliation('Full reconciliation complete:', results);
    return results;
}

async function forceReconcile(transactionId, table = 'cashback_transactions') {
    const { data: tx, error } = await supabaseAdmin
        .from(table)
        .select('*')
        .eq('id', transactionId)
        .single();

    if (error || !tx) return { success: false, error: 'Transaction not found' };

    if (table === 'cashback_transactions') {
        const result = await reconcileSingleCashbackTransaction(tx);
        return { success: true, newStatus: result.status, message: result.reason || 'Done' };
    }
    if (table === 'airtime_transactions') {
        const result = await reconcileSingleAirtimeTransaction(tx);
        return { success: true, newStatus: result.status, message: result.reason || 'Done' };
    }
    return { success: false, error: 'Unsupported table' };
}

async function getStuckTransactions(table = 'cashback_transactions', limit = 50) {
    const { data, error } = await supabaseAdmin
        .from(table)
        .select('*')
        .eq('status', 'processing')
        .lt('reconciliation_attempts', MAX_RECONCILIATION_ATTEMPTS)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        logError('Get stuck query error:', error);
        return { success: false, error: error.message };
    }
    return { success: true, data };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────
module.exports = {
    // Cashback
    reconcileStuckCashbackTransactions,
    reconcileSingleCashbackTransaction,
    refundCashbackTransaction,

    // Airtime
    reconcileStuckAirtimeTransactions,
    reconcileSingleAirtimeTransaction,
    refundAirtimeTransaction,

    // Main
    runFullReconciliation,
    forceReconcile,
    getStuckTransactions,

    // Utilities
    incrementReconciliationAttempts
};