// services/dtoneReconciliationService.js
// UNIFIED DT ONE RECONCILIATION — AIRTIME + eSIM + GIFT CARDS
//
// PRODUCTION-SAFE PRINCIPLES:
//   1. Provider state is the source of truth. Never guess.
//   2. Never trust webhook payloads — always re-query DT One.
//   3. Refunds are atomic: claim before credit.
//   4. Email is durable: state machine + backoff + stale recovery.
//   5. PROVIDER_UNKNOWN is a first-class state, not "failed".
//   6. Only provider CLASS ids 3, 4, 7, 9 are terminal.
//   7. Voucher extraction only from COMPLETED.
//   8. Raw provider payloads are stored as summaries, not full blobs.
//   9. Never double-refund, never double-send email.
//  10. Confirm CREATED transactions automatically.
//  11. Definitive provider rejections (30500 / class 3) refund immediately.
//  12. Stale refund/email claims are recoverable (lease pattern).

const { supabaseAdmin } = require('../db/supabase');
const dtoneService = require('./dtoneService');
const { LedgerService } = require('./ledgerService');
const emailService = require('./emailService');
const QRCode = require('qrcode');

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const STUCK_AFTER_MS              = 5 * 60 * 1000;
const MAX_RECONCILIATION_ATTEMPTS = 20;
const MAX_AGE_BEFORE_MANUAL_MS    = 26 * 60 * 60 * 1000;
const BATCH_SIZE                  = 50;
const CONCURRENT_LIMIT            = 3;
const PROVIDER_QUERY_TIMEOUT_MS   = 15000;
const EMAIL_MAX_ATTEMPTS          = 5;
const EMAIL_RETRY_BACKOFF_MIN     = [2, 5, 15, 60, 240];
const STALE_SENDING_MS            = 10 * 60 * 1000;
const STALE_REFUND_MS             = 10 * 60 * 1000;
const SCHEDULER_INTERVAL_MS       = 5 * 60 * 1000;

// If a transaction stays in CREATED longer than this, we auto-fail it.
// DT One cancels CREATED transactions after 60 minutes; we don't want to
// hold customer money that long, so we intervene sooner.
const NEVER_CONFIRMED_MS          = 10 * 60 * 1000;

const FINAL_FAILED_STATUSES = new Set(['failed', 'cancelled', 'reversed']);
const FINAL_SUCCESS_STATUSES = new Set(['completed']);

// ═══════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function maskPhone(phone) {
    if (!phone) return 'N/A';
    const str = String(phone);
    if (str.length <= 4) return str;
    return `${'*'.repeat(str.length - 4)}${str.slice(-4)}`;
}

function summarizeProviderResponse(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: raw.id,
        external_id: raw.external_id,
        status: raw.status?.message || raw.status?.class?.message || raw.status,
        status_id: raw.status?.id || null,
        status_class_id: raw.status?.class?.id || null,
        error_code: raw.error?.code || raw.errors?.[0]?.code || null,
        error_message: raw.error?.message || raw.errors?.[0]?.message || null,
        has_pin: Boolean(raw.pin?.code || raw.pin?.serial),
        provider_updated_at: raw.updated_at || null
    };
}

async function createNotification(userId, title, message, type, link) {
    try {
        const iconMap = {
            airtime_sent: '📱',
            airtime_failed: '❌',
            airtime_refunded: '💰',
            airtime_reconciled: '✅',
            esim_sent: '📶',
            esim_failed: '❌',
            esim_refunded: '💰',
            giftcard_sent: '🎁',
            giftcard_failed: '❌',
            giftcard_refunded: '💰'
        };
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title,
            message,
            type,
            icon: iconMap[type] || '📌',
            link: link || '/',
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.error('❌ [RECONCILE] notification insert failed:', e.message);
    }
}

async function generateEsimQr(lpaString, reference) {
    if (!lpaString) throw new Error('Missing eSIM activation code');

    const buffer = await QRCode.toBuffer(lpaString, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 800,
        type: 'png'
    });

    try {
        const filename = `${reference || Date.now()}-${Date.now()}.png`;
        const { error: uploadError } = await supabaseAdmin
            .storage
            .from('esim-qr')
            .upload(filename, buffer, {
                contentType: 'image/png',
                cacheControl: '31536000',
                upsert: false
            });

        if (uploadError) throw uploadError;

        const { data: signed } = await supabaseAdmin
            .storage
            .from('esim-qr')
            .createSignedUrl(filename, 60 * 60 * 24 * 7);

        if (signed?.signedUrl) return signed.signedUrl;
    } catch (e) {
        console.warn('⚠️ [RECONCILE] eSIM QR storage upload failed, using data URI:', e.message);
    }

    return await QRCode.toDataURL(lpaString, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 800
    });
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROVIDER QUERY
// ═══════════════════════════════════════════════════════════════════════════
async function queryDTOneTransaction(tx) {
    if (tx.provider_transaction_id) {
        try {
            const result = await Promise.race([
                dtoneService.queryTransaction(tx.provider_transaction_id),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('provider timeout')),
                    PROVIDER_QUERY_TIMEOUT_MS
                ))
            ]);

            if (result && !result.notFound && result.status !== 'not_found') {
                return {
                    success: true,
                    id: tx.provider_transaction_id,
                    status: result.status || 'processing',
                    providerStatus: result.providerStatus || null,
                    isFinal: !!result.isFinal,
                    code: result.code || null,
                    statusId: result.statusId || null,
                    statusClassId: result.statusClassId || null,
                    errorCode: result.errorCode || null,
                    errorMessage: result.errorMessage || null,
                    definitiveRejection: !!result.definitiveRejection,
                    raw: result.raw || null,
                    source: 'dtone_transaction_id'
                };
            }

            console.warn(
                `⚠️ [RECONCILE] ${tx.reference} — DT One NOT_FOUND by ID, trying external_id`
            );
        } catch (e) {
            console.warn(`⚠️ [RECONCILE] ${tx.reference} — ID lookup failed:`, e.message);
        }
    }

    const externalId = tx.dtone_external_id;
    if (!externalId) {
        return {
            success: false,
            status: 'not_found',
            providerStatus: 'NOT_FOUND',
            error: 'No external_id available'
        };
    }

    try {
        const externalResult = await Promise.race([
            dtoneService.getTransactionByExternalId(externalId),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('provider timeout')),
                PROVIDER_QUERY_TIMEOUT_MS
            ))
        ]);

        if (!externalResult) {
            return {
                success: false,
                status: 'not_found',
                providerStatus: 'NOT_FOUND',
                error: 'Not found by ID or external_id'
            };
        }

        const transaction = Array.isArray(externalResult)
            ? externalResult[0]
            : (externalResult?.items?.[0] || externalResult?.data?.[0] || externalResult);

        if (!transaction) {
            return {
                success: false,
                status: 'not_found',
                providerStatus: 'NOT_FOUND',
                error: 'Empty provider response'
            };
        }

        const statusObj = transaction?.status || {};
        const providerStatus = String(
            statusObj.message || statusObj.class?.message || ''
        ).toUpperCase();

        const errorCode =
            transaction?.error?.code ??
            transaction?.errors?.[0]?.code ??
            statusObj?.error?.code ?? null;

        const errorMessage =
            transaction?.error?.message ??
            transaction?.errors?.[0]?.message ??
            statusObj?.error?.message ?? null;

        const normalized = dtoneService.normalizeStatus(statusObj);

        return {
            success: true,
            id: transaction?.id || transaction?.transaction_id || tx.provider_transaction_id,
            status: normalized.status,
            providerStatus: providerStatus || normalized.code,
            isFinal: normalized.final,
            code: normalized.code,
            statusId: normalized.statusId,
            statusClassId: normalized.statusClassId,
            errorCode,
            errorMessage,
            definitiveRejection: !!normalized.definitiveRejection,
            raw: transaction,
            source: 'dtone_external_id'
        };
    } catch (error) {
        console.error(`⚠️ [RECONCILE] ${tx.reference} — external_id lookup failed:`, error.message);
        return {
            success: false,
            status: 'provider_error',
            providerStatus: 'QUERY_ERROR',
            error: error.message
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIRM STUCK CREATED TRANSACTION
// ═══════════════════════════════════════════════════════════════════════════
async function tryConfirmStuckTransaction(tx, providerResult) {
    const statusId = Number(providerResult?.statusId ?? 0) || null;
    const statusClassId = Number(providerResult?.statusClassId ?? 0) || null;
    const providerStatus = String(providerResult?.providerStatus || '').toUpperCase();

    const isCreated =
        statusId === 10000 ||
        statusId === 1 ||
        statusClassId === 1 ||
        providerStatus === 'CREATED';

    if (!isCreated) return { skipped: true };

    const providerTxId = tx.provider_transaction_id;
    if (!providerTxId) return { skipped: true };

    console.log(`🔔 [RECONCILE] ${tx.reference} → confirming stuck CREATED tx`);

    let confirmResult;
    try {
        confirmResult = await dtoneService.confirmTransaction(providerTxId);
    } catch (e) {
        if (e.definitiveRejection) {
            return {
                terminal: true,
                code: e.normalized?.code || e.providerErrorCode || 'PROVIDER_REJECTED',
                errorCode: e.providerErrorCode || null,
                error: e.message,
                raw: e.providerData || null
            };
        }
        if (e.ambiguous) return { pending: true };
        return { pending: true };
    }

    if (confirmResult?.success) return { confirmed: true };
    if (confirmResult?.definitiveRejection) {
        return {
            terminal: true,
            code: confirmResult.normalized?.code || 'PROVIDER_REJECTED',
            errorCode: confirmResult.normalized?.code || null,
            error: 'Confirm returned definitive rejection',
            raw: confirmResult.raw || null
        };
    }
    return { pending: true };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ATTEMPT TRACKING / MANUAL REVIEW
// ═══════════════════════════════════════════════════════════════════════════
async function incrementAttempts(table, transactionId, errorMessage) {
    const { data: tx, error } = await supabaseAdmin
        .from(table)
        .select('reconciliation_attempts, metadata')
        .eq('id', transactionId)
        .single();

    if (error || !tx) return;

    const newAttempts = (tx.reconciliation_attempts || 0) + 1;
    const now = new Date().toISOString();

    await supabaseAdmin.from(table).update({
        reconciliation_attempts: newAttempts,
        last_reconciliation_at: now,
        last_reconciled_at: now,
        updated_at: now,
        metadata: {
            ...(tx.metadata || {}),
            last_reconciliation_error: errorMessage,
            last_reconciliation_error_at: now,
            reconciliation_attempt: newAttempts
        }
    }).eq('id', transactionId);
}

async function moveToManualReview(table, tx, reason) {
    const now = new Date().toISOString();

    await supabaseAdmin.from(table).update({
        status: 'manual_review',
        updated_at: now,
        last_reconciliation_at: now,
        last_reconciled_at: now,
        failure_reason: reason,
        metadata: {
            ...(tx.metadata || {}),
            manual_review_at: now,
            manual_review_reason: reason,
            reconciliation_source: 'auto_sweep'
        }
    }).eq('id', tx.id);

    await createNotification(
        tx.user_id,
        '⏳ Order Under Review',
        `Your order ${tx.reference} requires manual review. Our team will be in touch.`,
        `${table.split('_')[0]}_reconciled`,
        `/${table.split('_')[0]}/order/${tx.reference}`
    );

    console.log(`📋 [RECONCILE] ${tx.reference} (${table}) → MANUAL_REVIEW (${reason})`);
    return { manualReview: true };
}

async function moveToProviderUnknown(table, tx, reason) {
    const now = new Date().toISOString();

    await supabaseAdmin.from(table).update({
        status: 'provider_unknown',
        updated_at: now,
        last_reconciliation_at: now,
        last_reconciled_at: now,
        failure_reason: reason,
        metadata: {
            ...(tx.metadata || {}),
            provider_unknown_at: now,
            provider_unknown_reason: reason
        }
    }).eq('id', tx.id);

    console.log(`❓ [RECONCILE] ${tx.reference} (${table}) → PROVIDER_UNKNOWN`);
    return { providerUnknown: true };
}

// ═══════════════════════════════════════════════════════════════════════════
//  IDEMPOTENT REFUND HELPER
// ═══════════════════════════════════════════════════════════════════════════
async function checkRefundExists(reference) {
    const { data } = await supabaseAdmin
        .from('ledger_transactions')
        .select('id')
        .eq('reference', `REF-${reference}`)
        .eq('type', 'refund')
        .maybeSingle();
    return !!data;
}

/**
 * Attempt a refund with full verification:
 *   - ensure the ledger actually credits
 *   - only then mark the order refunded
 *   - on failure, mark refund_status = failed and return manualReview
 */
async function performVerifiedRefund(table, tx, ledgerTransactionId, reason) {
    const now = new Date().toISOString();

    if (!ledgerTransactionId) {
        // No ledger transaction to refund against — flag for review
        await supabaseAdmin.from(table).update({
            refund_status: 'failed',
            refund_error: 'No ledger_transaction_id on record',
            status: 'manual_review',
            updated_at: now
        }).eq('id', tx.id);
        return { manualReview: true, refundError: 'No ledger_transaction_id' };
    }

    let refundResult;
    try {
        refundResult = await LedgerService.refundTransaction(
            tx.user_id,
            ledgerTransactionId,
            reason
        );
    } catch (e) {
        await supabaseAdmin.from(table).update({
            refund_status: 'failed',
            refund_error: e.message,
            status: 'manual_review',
            updated_at: now
        }).eq('id', tx.id);
        return { manualReview: true, refundError: e.message };
    }

    if (!refundResult || refundResult.success !== true) {
        const err = refundResult?.error || 'Ledger refund did not succeed';
        await supabaseAdmin.from(table).update({
            refund_status: 'failed',
            refund_error: err,
            status: 'manual_review',
            updated_at: now
        }).eq('id', tx.id);
        return { manualReview: true, refundError: err };
    }

    // Ledger confirmed — safe to mark refunded
    await supabaseAdmin.from(table).update({
        status: 'refunded',
        refunded: true,
        refund_status: 'completed',
        refund_transaction_id: refundResult.transaction_id || null,
        refunded_at: now,
        updated_at: now
    }).eq('id', tx.id);

    return { refunded: true };
}

// ═══════════════════════════════════════════════════════════════════════════
//  AIRTIME — complete / refund
// ═══════════════════════════════════════════════════════════════════════════
async function completeAirtime(tx, result) {
    const now = new Date().toISOString();
    if (tx.status === 'completed') return { alreadyCompleted: true };

    const { data: updated } = await supabaseAdmin
        .from('airtime_transactions')
        .update({
            status: 'completed',
            provider_status: result.providerStatus || result.status || 'COMPLETED',
            provider_transaction_id: result.id || tx.provider_transaction_id,
            completed_at: now,
            updated_at: now,
            last_reconciliation_at: now,
            reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
            metadata: {
                ...(tx.metadata || {}),
                reconciled_at: now,
                reconciled_status: result.status,
                reconciliation_source: 'auto_sweep',
                provider_response_summary: summarizeProviderResponse(result.raw)
            }
        })
        .eq('id', tx.id)
        .in('status', ['processing', 'pending', 'provider_unknown'])
        .select('id')
        .maybeSingle();

    if (!updated) return { alreadyFinalized: true };

    await createNotification(
        tx.user_id,
        '📱 Airtime Delivered',
        `Airtime to ${tx.country_code} ${maskPhone(tx.phone_number)} was delivered successfully.`,
        'airtime_sent',
        `/airtime/order/${tx.reference}`
    );

    console.log(`✅ [RECONCILE] AIRTIME ${tx.reference} → COMPLETED`);
    return { completed: true };
}

async function refundAirtime(tx, result) {
    const now = new Date().toISOString();

    if (tx.refunded) return { alreadyRefunded: true };
    if (await checkRefundExists(tx.reference)) {
        await supabaseAdmin
            .from('airtime_transactions')
            .update({ refunded: true, updated_at: now })
            .eq('id', tx.id);
        return { alreadyRefunded: true };
    }

    // Atomic claim
    const { data: claimed } = await supabaseAdmin
        .from('airtime_transactions')
        .update({
            status: 'failed',
            provider_status: result.providerStatus || result.status || 'FAILED',
            failed_at: now,
            updated_at: now,
            last_reconciliation_at: now,
            reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
            refund_status: 'processing',
            refund_attempts: (tx.refund_attempts || 0) + 1,
            refund_started_at: now,
            failure_code: result.code || result.errorCode || 'PROVIDER_FAILED',
            failure_message: result.errorMessage || result.error || 'Provider transaction failed',
            metadata: {
                ...(tx.metadata || {}),
                reconciled_at: now,
                reconciled_status: result.status,
                provider_response_summary: summarizeProviderResponse(result.raw)
            }
        })
        .eq('id', tx.id)
        .in('refund_status', ['not_applicable', 'failed'])
        .eq('refunded', false)
        .select('*')
        .maybeSingle();

    if (!claimed) return { alreadyRefunded: true };

    const refundOutcome = await performVerifiedRefund(
        'airtime_transactions',
        claimed,
        claimed.ledger_transaction_id,
        `Auto-refund for airtime ${claimed.reference}: ${result.errorMessage || 'Provider failed'}`
    );

    if (refundOutcome.refunded) {
        await createNotification(
            claimed.user_id,
            '💰 Airtime Refunded',
            `Airtime to ${claimed.country_code} ${maskPhone(claimed.phone_number)} failed. Your funds have been refunded.`,
            'airtime_refunded',
            `/airtime/order/${claimed.reference}`
        );

        console.log(`💸 [RECONCILE] AIRTIME ${claimed.reference} → FAILED, refunded`);
        return { refunded: true };
    }

    return refundOutcome;
}

// ═══════════════════════════════════════════════════════════════════════════
//  eSIM — complete / refund
// ═══════════════════════════════════════════════════════════════════════════
async function completeEsim(tx, result) {
    const now = new Date().toISOString();

    if (tx.status === 'completed' && tx.delivery_status === 'ready') {
        if (!tx.email_sent) queueEsimEmail(tx.id);
        return { alreadyCompleted: true };
    }

    const delivery = dtoneService.extractEsimDelivery(result);

    if (!delivery?.lpaString) {
        console.error(`❌ [RECONCILE] eSIM ${tx.reference} provider completed but no LPA string`);

        await supabaseAdmin.from('esim_transactions').update({
            provider_response: summarizeProviderResponse(result.raw),
            provider_status: result.providerStatus || 'COMPLETED',
            delivery_status: 'pending',
            delivery_attempts: (tx.delivery_attempts || 0) + 1,
            last_delivery_error: 'No LPA string in provider response',
            reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
            last_reconciled_at: now,
            updated_at: now
        }).eq('id', tx.id);

        return { deliveryPending: true };
    }

    let qrCodeUrl = delivery.qrCodeUrl;
    if (!qrCodeUrl) {
        try {
            qrCodeUrl = await generateEsimQr(delivery.lpaString, tx.reference);
        } catch (qrErr) {
            console.error(`❌ [RECONCILE] eSIM QR generation failed for ${tx.reference}:`, qrErr.message);

            await supabaseAdmin.from('esim_transactions').update({
                delivery_status: 'pending',
                delivery_attempts: (tx.delivery_attempts || 0) + 1,
                last_delivery_error: `QR generation failed: ${qrErr.message}`,
                updated_at: now
            }).eq('id', tx.id);

            return { deliveryPending: true };
        }
    }

    const { data: claimed } = await supabaseAdmin
        .from('esim_transactions')
        .update({
            status: 'completed',
            completed_at: now,
            qr_code_url: qrCodeUrl,
            activation_code: delivery.activationCode || delivery.lpaString,
            lpa_string: delivery.lpaString,
            serial_number: delivery.serial || null,
            iccid: delivery.iccid || null,
            installation_url: delivery.installationUrl || null,
            apple_universal_link: delivery.appleUniversalLink || null,
            android_universal_link: delivery.androidUniversalLink || null,
            smdp_address: delivery.smdpAddress || null,
            matching_id: delivery.matchingId || null,
            instructions: delivery.instructions || null,
            delivery_status: 'ready',
            delivery_attempts: (tx.delivery_attempts || 0) + 1,
            provider_response: summarizeProviderResponse(result.raw),
            provider_status: result.providerStatus || 'COMPLETED',
            reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
            last_reconciled_at: now,
            updated_at: now
        })
        .eq('id', tx.id)
        .in('status', ['processing', 'pending', 'provider_unknown'])
        .select('*')
        .maybeSingle();

    if (!claimed) return { alreadyFinalized: true };

    console.log(`✅ [RECONCILE] eSIM ${tx.reference} → COMPLETED, QR ready`);
    queueEsimEmail(tx.id);

    await createNotification(
        tx.user_id,
        '📶 eSIM Ready',
        `Your eSIM for ${tx.country_name} is ready. Check your email for the QR code.`,
        'esim_sent',
        `/esim/order/${tx.reference}`
    );

    return { completed: true };
}

async function refundEsim(tx, result) {
    const now = new Date().toISOString();
    if (tx.refunded || tx.status === 'refunded') return { alreadyRefunded: true };
    if (tx.refund_status === 'completed') return { alreadyRefunded: true };

    const { data: claimed } = await supabaseAdmin
        .from('esim_transactions')
        .update({
            refund_status: 'processing',
            refund_attempts: (tx.refund_attempts || 0) + 1,
            refund_started_at: now,
            failure_reason: result.errorMessage || result.error || 'Provider transaction failed',
            reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
            last_reconciled_at: now,
            updated_at: now
        })
        .eq('id', tx.id)
        .in('refund_status', ['not_applicable', 'failed'])
        .eq('refunded', false)
        .select('*')
        .maybeSingle();

    if (!claimed) return { alreadyRefunded: true };

    const refundOutcome = await performVerifiedRefund(
        'esim_transactions',
        claimed,
        claimed.ledger_transaction_id,
        `eSIM refund: ${result.errorMessage || 'Provider failed'}`
    );

    if (refundOutcome.refunded) {
        queueEsimFailureEmail(claimed, result.errorMessage || 'Provider rejected order');

        await createNotification(
            claimed.user_id,
            '💰 eSIM Refunded',
            `Your eSIM order for ${claimed.country_name} failed. Funds refunded.`,
            'esim_refunded',
            `/esim/order/${claimed.reference}`
        );

        console.log(`💸 [RECONCILE] eSIM ${claimed.reference} → FAILED, refunded`);
    }

    return refundOutcome;
}

// ═══════════════════════════════════════════════════════════════════════════
//  GIFT CARDS — complete / refund
// ═══════════════════════════════════════════════════════════════════════════
async function completeGiftCard(tx, result) {
    const now = new Date().toISOString();

    if (tx.status === 'completed' && tx.voucher_code) {
        if (!tx.email_sent) queueGiftCardEmail(tx.id);
        return { alreadyCompleted: true };
    }

    const delivery = dtoneService.extractGiftCardDelivery(result);

    if (!delivery?.code) {
        console.error(`❌ [RECONCILE] Gift card ${tx.reference} provider completed but no voucher code`);

        await supabaseAdmin.from('giftcard_transactions').update({
            provider_response: summarizeProviderResponse(result.raw),
            provider_status: result.providerStatus || 'COMPLETED',
            delivery_status: 'pending',
            delivery_attempts: (tx.delivery_attempts || 0) + 1,
            failure_reason: 'Provider completed transaction but voucher code is missing',
            reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
            last_reconciled_at: now,
            updated_at: now
        }).eq('id', tx.id);

        return { deliveryPending: true };
    }

    const { data: claimed } = await supabaseAdmin
        .from('giftcard_transactions')
        .update({
            status: 'completed',
            completed_at: now,
            voucher_code: delivery.code,
            voucher_serial: delivery.serial || null,
            instructions: delivery.instructions || null,
            delivery_status: 'ready',
            delivery_attempts: (tx.delivery_attempts || 0) + 1,
            provider_response: summarizeProviderResponse(result.raw),
            provider_status: result.providerStatus || 'COMPLETED',
            reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
            last_reconciled_at: now,
            updated_at: now
        })
        .eq('id', tx.id)
        .in('status', ['processing', 'pending', 'provider_unknown'])
        .is('voucher_code', null)
        .select('*')
        .maybeSingle();

    if (!claimed) return { alreadyFinalized: true };

    console.log(`✅ [RECONCILE] GIFT CARD ${tx.reference} → COMPLETED, voucher saved`);
    queueGiftCardEmail(tx.id);

    await createNotification(
        tx.user_id,
        '🎁 Gift Card Ready',
        `Your ${tx.card_name} gift card is ready. Check your email for the voucher code.`,
        'giftcard_sent',
        `/giftcard/order/${tx.reference}`
    );

    return { completed: true };
}

async function refundGiftCard(tx, result) {
    const now = new Date().toISOString();
    if (tx.refunded || tx.status === 'refunded') return { alreadyRefunded: true };
    if (tx.refund_status === 'completed') return { alreadyRefunded: true };

    const { data: claimed } = await supabaseAdmin
        .from('giftcard_transactions')
        .update({
            refund_status: 'processing',
            refund_attempts: (tx.refund_attempts || 0) + 1,
            refund_started_at: now,
            failure_reason: result.errorMessage || result.error || 'Provider transaction failed',
            reconciliation_attempts: (tx.reconciliation_attempts || 0) + 1,
            last_reconciled_at: now,
            updated_at: now
        })
        .eq('id', tx.id)
        .in('refund_status', ['not_applicable', 'failed'])
        .eq('refunded', false)
        .select('*')
        .maybeSingle();

    if (!claimed) return { alreadyRefunded: true };

    const refundOutcome = await performVerifiedRefund(
        'giftcard_transactions',
        claimed,
        claimed.ledger_transaction_id,
        `Gift card refund: ${result.errorMessage || 'Provider failed'}`
    );

    if (refundOutcome.refunded) {
        queueGiftCardFailureEmail(claimed, result.errorMessage || 'Provider rejected order');

        await createNotification(
            claimed.user_id,
            '💰 Gift Card Refunded',
            `Your ${claimed.card_name} order failed. Funds refunded.`,
            'giftcard_refunded',
            `/giftcard/order/${claimed.reference}`
        );

        console.log(`💸 [RECONCILE] GIFT CARD ${claimed.reference} → FAILED, refunded`);
    }

    return refundOutcome;
}

// ═══════════════════════════════════════════════════════════════════════════
//  EMAIL DELIVERY
// ═══════════════════════════════════════════════════════════════════════════
function queueEsimEmail(orderId) {
    setImmediate(async () => {
        try {
            const { data: order } = await supabaseAdmin
                .from('esim_transactions')
                .select('*')
                .eq('id', orderId)
                .single();
            if (order) await trySendEsimEmail(order);
        } catch (e) {
            console.error(`❌ [RECONCILE] eSIM email queue failed for ${orderId}:`, e.message);
        }
    });
}

function queueEsimFailureEmail(order, reason) {
    setImmediate(async () => {
        try {
            if (!order.delivery_email) return;
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('username')
                .eq('id', order.user_id)
                .maybeSingle();

            await emailService.sendEsimFailureEmail({
                email: order.delivery_email,
                username: profile?.username || 'User',
                reference: order.reference,
                countryName: order.country_name,
                planName: order.plan_name,
                amountUsd: order.total_usd,
                amountNgn: order.price_ngn,
                debitCurrency: order.debit_currency,
                reason,
                refunded: true
            });
        } catch (e) {
            console.warn('⚠️ [RECONCILE] eSIM failure email not sent:', e.message);
        }
    });
}

async function trySendEsimEmail(order) {
    if (!order || order.email_sent) return true;
    if (!order.delivery_email) return false;

    const isStaleSending =
        order.email_status === 'sending' &&
        order.updated_at &&
        (Date.now() - new Date(order.updated_at).getTime()) > STALE_SENDING_MS;

    if (order.email_status === 'sending' && !isStaleSending) return true;

    if ((order.email_attempts || 0) >= EMAIL_MAX_ATTEMPTS) {
        await supabaseAdmin.from('esim_transactions').update({
            email_status: 'failed',
            last_email_error: 'Max attempts reached',
            updated_at: new Date().toISOString()
        }).eq('id', order.id);
        return false;
    }

    const { data: claimed } = await supabaseAdmin
        .from('esim_transactions')
        .update({
            email_status: 'sending',
            email_attempts: (order.email_attempts || 0) + 1,
            updated_at: new Date().toISOString()
        })
        .eq('id', order.id)
        .eq('email_sent', false)
        .select('*')
        .maybeSingle();

    if (!claimed) return true;

    try {
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('username')
            .eq('id', claimed.user_id)
            .maybeSingle();

        const emailRes = await emailService.sendEsimDeliveryEmail({
            email: claimed.delivery_email,
            username: profile?.username || 'Traveller',
            reference: claimed.reference,
            countryName: claimed.country_name,
            planName: claimed.plan_name,
            dataDisplay: claimed.data_display,
            validityDays: claimed.validity_days,
            totalUsd: claimed.total_usd,
            totalNgn: claimed.price_ngn,
            debitCurrency: claimed.debit_currency,
            debitAmount: claimed.debit_amount,
            qrCodeUrl: claimed.qr_code_url,
            activationCode: claimed.activation_code,
            lpaString: claimed.lpa_string,
            smdpAddress: claimed.smdp_address,
            matchingId: claimed.matching_id,
            instructions: claimed.instructions
        });

        if (emailRes?.success) {
            await supabaseAdmin.from('esim_transactions').update({
                email_sent: true,
                email_sent_at: new Date().toISOString(),
                email_message_id: emailRes.messageId || null,
                email_status: 'sent',
                last_email_error: null,
                next_email_retry_at: null,
                updated_at: new Date().toISOString()
            }).eq('id', order.id);

            console.log(`📧 [RECONCILE] eSIM email sent for ${claimed.reference}`);
            return true;
        }

        const attempt = claimed.email_attempts || 1;
        const backoffMin = EMAIL_RETRY_BACKOFF_MIN[
            Math.min(attempt - 1, EMAIL_RETRY_BACKOFF_MIN.length - 1)
        ];
        const nextRetry = new Date(Date.now() + backoffMin * 60000);

        await supabaseAdmin.from('esim_transactions').update({
            email_status: attempt >= EMAIL_MAX_ATTEMPTS ? 'failed' : 'pending',
            last_email_error: emailRes?.error || emailRes?.message || 'Unknown error',
            next_email_retry_at: attempt >= EMAIL_MAX_ATTEMPTS ? null : nextRetry.toISOString(),
            updated_at: new Date().toISOString()
        }).eq('id', order.id);

        return false;
    } catch (e) {
        console.error(`❌ [RECONCILE] eSIM email exception for ${claimed.reference}:`, e.message);

        const attempt = claimed.email_attempts || 1;
        const backoffMin = EMAIL_RETRY_BACKOFF_MIN[
            Math.min(attempt - 1, EMAIL_RETRY_BACKOFF_MIN.length - 1)
        ];
        const nextRetry = new Date(Date.now() + backoffMin * 60000);

        await supabaseAdmin.from('esim_transactions').update({
            email_status: attempt >= EMAIL_MAX_ATTEMPTS ? 'failed' : 'pending',
            last_email_error: e.message,
            next_email_retry_at: attempt >= EMAIL_MAX_ATTEMPTS ? null : nextRetry.toISOString(),
            updated_at: new Date().toISOString()
        }).eq('id', order.id);

        return false;
    }
}

function queueGiftCardEmail(orderId) {
    setImmediate(async () => {
        try {
            const { data: order } = await supabaseAdmin
                .from('giftcard_transactions')
                .select('*')
                .eq('id', orderId)
                .single();
            if (order) await trySendGiftCardEmail(order);
        } catch (e) {
            console.error(`❌ [RECONCILE] gift card email queue failed for ${orderId}:`, e.message);
        }
    });
}

function queueGiftCardFailureEmail(order, reason) {
    setImmediate(async () => {
        try {
            if (!order.delivery_email) return;
            if (typeof emailService.sendGiftCardFailureEmail !== 'function') {
                console.warn('⚠️ [RECONCILE] sendGiftCardFailureEmail not implemented');
                return;
            }

            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('username')
                .eq('id', order.user_id)
                .maybeSingle();

            await emailService.sendGiftCardFailureEmail({
                email: order.delivery_email,
                username: profile?.username || 'Customer',
                reference: order.reference,
                cardName: order.card_name,
                faceValue: order.face_value,
                currency: order.face_currency,
                reason,
                refunded: true
            });
        } catch (e) {
            console.warn('⚠️ [RECONCILE] gift card failure email not sent:', e.message);
        }
    });
}

async function trySendGiftCardEmail(order) {
    if (!order || order.email_sent) return true;
    if (!order.delivery_email) return false;

    const isStaleSending =
        order.email_status === 'sending' &&
        order.updated_at &&
        (Date.now() - new Date(order.updated_at).getTime()) > STALE_SENDING_MS;

    if (order.email_status === 'sending' && !isStaleSending) return true;

    if ((order.email_attempts || 0) >= EMAIL_MAX_ATTEMPTS) {
        await supabaseAdmin.from('giftcard_transactions').update({
            email_status: 'failed',
            last_email_error: 'Max attempts reached',
            updated_at: new Date().toISOString()
        }).eq('id', order.id);
        return false;
    }

    const { data: claimed } = await supabaseAdmin
        .from('giftcard_transactions')
        .update({
            email_status: 'sending',
            email_attempts: (order.email_attempts || 0) + 1,
            updated_at: new Date().toISOString()
        })
        .eq('id', order.id)
        .eq('email_sent', false)
        .select('*')
        .maybeSingle();

    if (!claimed) return true;

    try {
        if (typeof emailService.sendGiftCardDeliveryEmail !== 'function') {
            console.warn('⚠️ [RECONCILE] sendGiftCardDeliveryEmail not implemented');
            return false;
        }

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('username')
            .eq('id', claimed.user_id)
            .maybeSingle();

        const emailRes = await emailService.sendGiftCardDeliveryEmail({
            email: claimed.delivery_email,
            username: profile?.username || 'Customer',
            reference: claimed.reference,
            cardName: claimed.card_name,
            faceValue: claimed.face_value,
            currency: claimed.face_currency,
            voucherCode: claimed.voucher_code,
            voucherSerial: claimed.voucher_serial,
            instructions: claimed.instructions,
            totalUsd: claimed.total_usd,
            totalNgn: claimed.price_ngn,
            debitCurrency: claimed.debit_currency,
            debitAmount: claimed.debit_amount
        });

        if (emailRes?.success) {
            await supabaseAdmin.from('giftcard_transactions').update({
                email_sent: true,
                email_sent_at: new Date().toISOString(),
                email_message_id: emailRes.messageId || null,
                email_status: 'sent',
                last_email_error: null,
                next_email_retry_at: null,
                updated_at: new Date().toISOString()
            }).eq('id', order.id);

            console.log(`📧 [RECONCILE] Gift card email sent for ${claimed.reference}`);
            return true;
        }

        const attempt = claimed.email_attempts || 1;
        const backoffMin = EMAIL_RETRY_BACKOFF_MIN[
            Math.min(attempt - 1, EMAIL_RETRY_BACKOFF_MIN.length - 1)
        ];
        const nextRetry = new Date(Date.now() + backoffMin * 60000);

        await supabaseAdmin.from('giftcard_transactions').update({
            email_status: attempt >= EMAIL_MAX_ATTEMPTS ? 'failed' : 'pending',
            last_email_error: emailRes?.error || 'Unknown error',
            next_email_retry_at: attempt >= EMAIL_MAX_ATTEMPTS ? null : nextRetry.toISOString(),
            updated_at: new Date().toISOString()
        }).eq('id', order.id);

        return false;
    } catch (e) {
        console.error(`❌ [RECONCILE] gift card email exception for ${claimed.reference}:`, e.message);

        const attempt = claimed.email_attempts || 1;
        const backoffMin = EMAIL_RETRY_BACKOFF_MIN[
            Math.min(attempt - 1, EMAIL_RETRY_BACKOFF_MIN.length - 1)
        ];
        const nextRetry = new Date(Date.now() + backoffMin * 60000);

        await supabaseAdmin.from('giftcard_transactions').update({
            email_status: attempt >= EMAIL_MAX_ATTEMPTS ? 'failed' : 'pending',
            last_email_error: e.message,
            next_email_retry_at: attempt >= EMAIL_MAX_ATTEMPTS ? null : nextRetry.toISOString(),
            updated_at: new Date().toISOString()
        }).eq('id', order.id);

        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  STALE REFUND / EMAIL RECOVERY
// ═══════════════════════════════════════════════════════════════════════════
async function recoverStaleRefunds(table) {
    const cutoff = new Date(Date.now() - STALE_REFUND_MS).toISOString();

    const { data: stale, error } = await supabaseAdmin
        .from(table)
        .select('id')
        .eq('refund_status', 'processing')
        .lt('refund_started_at', cutoff)
        .eq('refunded', false)
        .limit(25);

    if (error || !stale?.length) return 0;

    // Reset them so the next pass retries
    const ids = stale.map((s) => s.id);
    await supabaseAdmin
        .from(table)
        .update({
            refund_status: 'failed',
            refund_error: 'Stale processing — reset for retry',
            updated_at: new Date().toISOString()
        })
        .in('id', ids);

    console.warn(`⚠️ [RECONCILE] Reset ${ids.length} stale refund claims on ${table}`);
    return ids.length;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PER-SERVICE ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════
async function processTransaction(tx, service) {
    if (tx.refunded) return { skipped: true };

    const ageMs = Date.now() - new Date(tx.created_at).getTime();

    // ── Age cap for stuck CREATED transactions ────────────────────
    const providerStatusUpper = String(tx.provider_status || '').toUpperCase();
    const statusIsCreated = providerStatusUpper === 'CREATED';
    if (statusIsCreated && ageMs >= NEVER_CONFIRMED_MS) {
        console.warn(
            `⏰ [RECONCILE] ${service.name} ${tx.reference} stuck in CREATED for ${Math.round(ageMs / 60000)}m — auto-failing`
        );
        return await service.onFail(tx, {
            status: 'failed',
            providerStatus: 'CREATED_TIMEOUT',
            code: 'CREATED_TIMEOUT',
            errorCode: 'CREATED_TIMEOUT',
            errorMessage: 'Transaction never left CREATED state (likely insufficient provider balance)',
            raw: null,
            definitiveRejection: true
        });
    }

    if (ageMs >= MAX_AGE_BEFORE_MANUAL_MS) {
        console.log(`⏰ [RECONCILE] ${service.name} ${tx.reference} exceeded ${MAX_AGE_BEFORE_MANUAL_MS / 3600000}h cap`);
        return await moveToManualReview(
            service.table,
            tx,
            `Exceeded ${MAX_AGE_BEFORE_MANUAL_MS / 3600000}h processing cap`
        );
    }

    let providerResult = await queryDTOneTransaction(tx);

    // ── Try confirming stuck CREATED transactions ─────────────────
    if (providerResult?.success) {
        const confirmAttempt = await tryConfirmStuckTransaction(tx, providerResult);

        if (confirmAttempt.terminal) {
            console.warn(
                `❌ [RECONCILE] ${service.name} ${tx.reference} → terminal confirm failure: ` +
                `${confirmAttempt.code} — ${confirmAttempt.error}`
            );
            return await service.onFail(tx, {
                status: 'failed',
                providerStatus: 'REJECTED',
                code: confirmAttempt.code || 'PROVIDER_REJECTED',
                errorCode: confirmAttempt.errorCode || confirmAttempt.code,
                errorMessage: confirmAttempt.error || 'Provider rejected at confirm',
                raw: confirmAttempt.raw || null,
                definitiveRejection: true
            });
        }

        if (confirmAttempt.confirmed) {
            await new Promise((r) => setTimeout(r, 1500));
            try {
                const refreshed = await queryDTOneTransaction(tx);
                if (refreshed?.success) providerResult = refreshed;
            } catch (e) {
                console.warn(`⚠️ [RECONCILE] Re-query after confirm failed for ${tx.reference}:`, e.message);
            }
        }
    }

    // ── NOT_FOUND ─────────────────────────────────────────────────
    if (!providerResult.success && providerResult.status === 'not_found') {
        const newAttempts = (tx.reconciliation_attempts || 0) + 1;
        await incrementAttempts(service.table, tx.id, 'DT One not found by ID or external_id');

        if (newAttempts >= MAX_RECONCILIATION_ATTEMPTS) {
            return await moveToManualReview(
                service.table,
                tx,
                'DT One not found after multiple attempts'
            );
        }
        return { notFound: true };
    }

    if (!providerResult.success) {
        const newAttempts = (tx.reconciliation_attempts || 0) + 1;
        await incrementAttempts(
            service.table,
            tx.id,
            `Provider query failed: ${providerResult.error}`
        );

        if (newAttempts >= MAX_RECONCILIATION_ATTEMPTS) {
            return await moveToProviderUnknown(
                service.table,
                tx,
                `Provider query failed after ${MAX_RECONCILIATION_ATTEMPTS} attempts: ${providerResult.error}`
            );
        }
        return { queryFailed: true };
    }

    const providerStatus = String(providerResult.status || '').toLowerCase();
    console.log(`📡 [RECONCILE] ${service.name} ${tx.reference} → ${providerStatus}`);

    // ── Definitive rejection ──────────────────────────────────────
    if (FINAL_FAILED_STATUSES.has(providerStatus)) {
        return await service.onFail(tx, providerResult);
    }

    // ── Final success ─────────────────────────────────────────────
    if (FINAL_SUCCESS_STATUSES.has(providerStatus)) {
        return await service.onComplete(tx, providerResult);
    }

    // ── Unknown — treat as provider_unknown ──────────────────────
    if (providerStatus === 'provider_unknown') {
        const newAttempts = (tx.reconciliation_attempts || 0) + 1;
        await incrementAttempts(service.table, tx.id, 'Provider returned unknown status');
        if (newAttempts >= MAX_RECONCILIATION_ATTEMPTS) {
            return await moveToProviderUnknown(
                service.table,
                tx,
                `Unknown provider status after ${MAX_RECONCILIATION_ATTEMPTS} attempts`
            );
        }
        return { providerUnknown: true };
    }

    // ── Still processing ──────────────────────────────────────────
    const newAttempts = (tx.reconciliation_attempts || 0) + 1;
    if (newAttempts >= MAX_RECONCILIATION_ATTEMPTS) {
        return await moveToManualReview(
            service.table,
            tx,
            `Still processing after ${MAX_RECONCILIATION_ATTEMPTS} attempts`
        );
    }

    await incrementAttempts(service.table, tx.id, `Still ${providerStatus}`);
    return { processing: true };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SERVICE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════
const SERVICES = [
    {
        name: 'AIRTIME',
        table: 'airtime_transactions',
        onComplete: completeAirtime,
        onFail: refundAirtime
    },
    {
        name: 'ESIM',
        table: 'esim_transactions',
        onComplete: completeEsim,
        onFail: refundEsim
    },
    {
        name: 'GIFTCARD',
        table: 'giftcard_transactions',
        onComplete: completeGiftCard,
        onFail: refundGiftCard
    }
];

// ═══════════════════════════════════════════════════════════════════════════
//  SWEEP
// ═══════════════════════════════════════════════════════════════════════════
async function sweepService(service) {
    // First, recover stale refund claims
    await recoverStaleRefunds(service.table).catch(() => {});

    const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();

    const { data: stuck, error } = await supabaseAdmin
        .from(service.table)
        .select('*')
        .in('status', ['processing', 'pending', 'provider_unknown'])
        .lt('created_at', cutoff)
        .or(`reconciliation_attempts.lt.${MAX_RECONCILIATION_ATTEMPTS},reconciliation_attempts.is.null`)
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE);

    if (error) {
        console.error(`❌ [RECONCILE] ${service.name} query error:`, error.message);
        return { success: false, error: error.message, processed: 0 };
    }

    if (!stuck || stuck.length === 0) {
        return { success: true, processed: 0 };
    }

    console.log(`🔄 [RECONCILE] ${service.name}: ${stuck.length} stuck transactions`);

    let processed = 0, completed = 0, refunded = 0, manualReview = 0, notFound = 0, providerUnknown = 0;

    for (let i = 0; i < stuck.length; i += CONCURRENT_LIMIT) {
        const batch = stuck.slice(i, i + CONCURRENT_LIMIT);
        const results = await Promise.all(batch.map(async (tx) => {
            try {
                return await processTransaction(tx, service);
            } catch (e) {
                console.error(`❌ [RECONCILE] ${service.name} ${tx.reference}:`, e.message);
                try { await incrementAttempts(service.table, tx.id, e.message); } catch {}
                return { error: true };
            }
        }));

        for (const r of results) {
            processed++;
            if (r.completed) completed++;
            if (r.refunded) refunded++;
            if (r.manualReview) manualReview++;
            if (r.notFound) notFound++;
            if (r.providerUnknown) providerUnknown++;
        }
    }

    console.log(
        `✅ [RECONCILE] ${service.name}: ${completed} completed, ${refunded} refunded, ` +
        `${manualReview} manual_review, ${notFound} not_found, ${providerUnknown} provider_unknown`
    );

    return { success: true, processed, completed, refunded, manualReview, notFound, providerUnknown };
}

async function reconcileAllTransactions() {
    const results = {};
    for (const service of SERVICES) {
        try {
            results[service.name] = await sweepService(service);
        } catch (e) {
            console.error(`❌ [RECONCILE] ${service.name} sweep failed:`, e.message);
            results[service.name] = { success: false, error: e.message };
        }
    }
    return { success: true, results };
}

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════
async function getStuckTransactions(table, limit = 50) {
    const { data, error } = await supabaseAdmin
        .from(table)
        .select('*')
        .in('status', ['processing', 'pending', 'provider_unknown'])
        .order('created_at', { ascending: false })
        .limit(Math.min(parseInt(limit) || 50, 100));
    if (error) return { success: false, error: error.message };
    return { success: true, data: data || [] };
}

async function forceReconcileTransaction(table, transactionId) {
    const service = SERVICES.find(s => s.table === table);
    if (!service) return { success: false, error: `Unknown table: ${table}` };

    const { data: tx, error } = await supabaseAdmin
        .from(table)
        .select('*')
        .eq('id', transactionId)
        .single();

    if (error || !tx) return { success: false, error: 'Transaction not found' };
    if (tx.status === 'completed') return { success: true, message: 'Already completed' };
    if (tx.refunded) return { success: false, error: 'Already refunded' };

    const result = await processTransaction(tx, service);

    if (result.completed) return { success: true, newStatus: 'completed' };
    if (result.refunded) return { success: true, newStatus: 'refunded' };
    if (result.manualReview) return { success: true, newStatus: 'manual_review' };
    if (result.providerUnknown) return { success: true, newStatus: 'provider_unknown' };
    if (result.notFound) return { success: true, newStatus: 'not_found' };
    if (result.deliveryPending) return { success: true, newStatus: 'delivery_pending' };

    return { success: false, newStatus: 'processing', message: 'Still processing' };
}

async function getReconciliationStats() {
    try {
        const stats = {};
        for (const service of SERVICES) {
            const statusMap = {};
            for (const status of ['processing', 'pending', 'provider_unknown', 'manual_review', 'completed', 'failed', 'refunded']) {
                const { count } = await supabaseAdmin
                    .from(service.table)
                    .select('*', { count: 'exact', head: true })
                    .eq('status', status);
                statusMap[status] = count || 0;
            }
            stats[service.name.toLowerCase()] = {
                ...statusMap,
                total_stuck: (statusMap.processing || 0) + (statusMap.pending || 0) + (statusMap.provider_unknown || 0)
            };
        }
        return { success: true, data: stats };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SCHEDULER
// ═══════════════════════════════════════════════════════════════════════════
let intervalHandle = null;

function startReconciliationScheduler() {
    if (intervalHandle) return intervalHandle;

    setTimeout(async () => {
        console.log('🔄 [SCHEDULER] Initial reconciliation run...');
        try {
            await reconcileAllTransactions();
        } catch (e) {
            console.error('❌ [SCHEDULER] Initial run failed:', e.message);
        }
    }, 10000);

    intervalHandle = setInterval(async () => {
        console.log('🔄 [SCHEDULER] Running unified reconciliation...');
        try {
            await reconcileAllTransactions();
        } catch (e) {
            console.error('❌ [SCHEDULER] Failed:', e.message);
        }
    }, SCHEDULER_INTERVAL_MS);

    return intervalHandle;
}

async function startAirtimeReconciliationScheduler() {
    return startReconciliationScheduler();
}

async function reconcileStuckAirtimeTransactions() {
    const service = SERVICES.find(s => s.table === 'airtime_transactions');
    return await sweepService(service);
}

async function getStuckAirtimeTransactions(limit = 50) {
    return await getStuckTransactions('airtime_transactions', limit);
}

async function forceReconcileAirtime(transactionId) {
    return await forceReconcileTransaction('airtime_transactions', transactionId);
}

module.exports = {
    reconcileAllTransactions,
    startReconciliationScheduler,
    getStuckTransactions,
    forceReconcileTransaction,
    getReconciliationStats,

    startAirtimeReconciliationScheduler,
    reconcileStuckAirtimeTransactions,
    getStuckAirtimeTransactions,
    forceReconcileAirtime,

    processTransaction,
    sweepService,
    queryDTOneTransaction,
    SERVICES,

    completeAirtime,
    refundAirtime,
    completeEsim,
    refundEsim,
    completeGiftCard,
    refundGiftCard,
    trySendEsimEmail,
    trySendGiftCardEmail,
    queueEsimEmail,
    queueGiftCardEmail,

    moveToManualReview,
    moveToProviderUnknown,
    incrementAttempts,
    tryConfirmStuckTransaction,
    performVerifiedRefund
};