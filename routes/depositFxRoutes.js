// services/depositService.js
// Central completion for KoraPay deposits. Every path (webhook, callback,
// reconciliation) MUST route through completeKoraDeposit().

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const { createNotification } = require('./notificationService');
const korapayService = require('./korapayService');
const emailService = require('./emailService');

// ─── FIXED FEES ──────────────────────────────────────────────
// NGN deposits: ₦50 flat fee deducted before crediting.
// Non-NGN deposits: no fee at the deposit level (margin is
// already captured by the FX markup in deposit_currencies).
const NGN_FIXED_FEE = 50;

// ─── INTERNAL REFERENCE ──────────────────────────────────────
function buildInternalReference() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `MSDEP-${date}-${rand}`;
}

function buildMerchantReference() {
    return 'MK-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ─── COMPUTE FEE + NET AMOUNT ────────────────────────────────
function computeDepositFee(sourceCurrency, sourceAmount) {
    const ccy = String(sourceCurrency || '').toUpperCase();
    const amt = Number(sourceAmount) || 0;
    if (ccy === 'NGN') {
        return { fee: NGN_FIXED_FEE, netAmount: Math.max(0, amt - NGN_FIXED_FEE) };
    }
    return { fee: 0, netAmount: amt };
}

// ─── CREATE DEPOSIT ──────────────────────────────────────────
async function createDepositRequest({
    userId,
    sourceCurrency,
    sourceAmount,
    expectedTargetAmount,
    fxRate,
    fxRateSource,
    fxRateReference,
    fxMarkup
}) {
    const internalReference = buildInternalReference();
    const merchantReference = buildMerchantReference();

    // NEW: compute and persist the fee so the credited amount is
    // exactly the same across initialize / webhook / reconciliation.
    const { fee, netAmount } = computeDepositFee(sourceCurrency, sourceAmount);

    // The FX snapshot's final_amount is the pre-fee NGN figure.
    // Subtract the fee here so `expected_target_amount` already
    // reflects what the user will actually receive.
    const expectedAfterFee = +(Number(expectedTargetAmount) - fee).toFixed(2);

    const { data, error } = await supabaseAdmin
        .from('deposit_requests')
        .insert({
            user_id: userId,
            internal_reference: internalReference,
            provider: 'korapay',
            merchant_reference: merchantReference,
            source_currency: sourceCurrency,
            source_amount: sourceAmount,
            target_currency: sourceCurrency === 'NGN' ? 'NGN' : 'USD',
            expected_target_amount: expectedAfterFee,
            fx_rate: fxRate,
            fx_rate_source: fxRateSource,
            fx_rate_reference: fxRateReference,
            fx_markup: fxMarkup,
            provider_fee: fee,           // store the ₦50 fee
            status: 'pending'
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

// ─── COMPLETE DEPOSIT (idempotent) ───────────────────────────
async function completeKoraDeposit({ depositId, providerTransaction, source }) {
    // ─── 1. Load the deposit ───
    const { data: deposit, error: depErr } = await supabaseAdmin
        .from('deposit_requests')
        .select('*')
        .eq('id', depositId)
        .maybeSingle();

    if (depErr) throw depErr;
    if (!deposit) return { completed: false, reason: 'DEPOSIT_NOT_FOUND' };

    // ─── 2. Idempotency ───
    if (deposit.status === 'completed') {
        return {
            completed: true,
            already_completed: true,
            reason: 'DEPOSIT_ALREADY_COMPLETED',
            transaction_id: deposit.ledger_transaction_id
        };
    }

    // ─── 3. Validate provider reference ───
    const providerRef = providerTransaction?.reference || providerTransaction?.payment_reference;
    if (!providerRef) return { completed: false, reason: 'MISSING_PROVIDER_REFERENCE' };

    // ─── 4. Server-side verify if not already verified ───
    let verified = providerTransaction;
    if (!providerTransaction._verified) {
        try {
            verified = await korapayService.verifyTransaction(providerRef);
            verified._verified = true;
        } catch (err) {
            console.error('[DEPOSIT] Provider verification failed:', err.message);
            await supabaseAdmin
                .from('deposit_requests')
                .update({ status: 'processing', updated_at: new Date().toISOString() })
                .eq('id', deposit.id)
                .eq('status', 'pending');
            return { completed: false, reason: 'PAYMENT_NOT_VERIFIED' };
        }
    }

    // ─── 5. Provider status check ───
    const pStatus = String(verified.provider_status || verified.status || '').toLowerCase();
    if (!['success', 'successful', 'completed'].includes(pStatus)) {
        await supabaseAdmin
            .from('deposit_requests')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', deposit.id)
            .eq('status', 'pending');
        return { completed: false, reason: `PROVIDER_STATUS_${pStatus || 'UNKNOWN'}` };
    }

    // ─── 6. Validate currency + amount ───
    const sourceCurrency = String(verified.currency || '').toUpperCase();
    const sourcePaid     = Number(verified.amount || 0);

    if (sourceCurrency && sourceCurrency !== deposit.source_currency) {
        console.error(`[DEPOSIT] Currency mismatch: ${sourceCurrency} vs ${deposit.source_currency}`);
        await markManualReview(deposit.id, 'PAYMENT_CURRENCY_MISMATCH');
        return { completed: false, reason: 'PAYMENT_CURRENCY_MISMATCH' };
    }

    const expectedAmount = Number(deposit.source_amount);
    if (sourcePaid <= 0) {
        await markManualReview(deposit.id, 'PAYMENT_AMOUNT_MISMATCH');
        return { completed: false, reason: 'PAYMENT_AMOUNT_MISMATCH' };
    }

    const drift = Math.abs(sourcePaid - expectedAmount) / expectedAmount;
    if (drift > 0.02) {
        await markManualReview(deposit.id, sourcePaid < expectedAmount ? 'UNDERPAID' : 'OVERPAID');
        return { completed: false, reason: sourcePaid < expectedAmount ? 'UNDERPAID' : 'OVERPAID' };
    }

    // ─── 7. Compute the credited amount ───
    const lockedRate    = Number(deposit.fx_rate);
    const ngnEquivalent = +(sourcePaid * lockedRate).toFixed(2);

    // NEW: subtract the fixed NGN fee (only when the deposit lands in NGN)
    const { fee, netAmount } = computeDepositFee(deposit.source_currency, ngnEquivalent);

    let targetCredit;
    if (deposit.target_currency === 'USD') {
        // Convert the net NGN amount to USD using the admin rate
        const { data: rateRow } = await supabaseAdmin
            .from('app_config')
            .select('value')
            .eq('key', 'usd_to_ngn')
            .maybeSingle();
        const usdToNgn = Number(rateRow?.value || 1600);
        targetCredit = +(netAmount / usdToNgn).toFixed(2);
    } else {
        targetCredit = +netAmount.toFixed(2);
    }

    if (!Number.isFinite(targetCredit) || targetCredit <= 0) {
        await markManualReview(deposit.id, 'CREDIT_AMOUNT_INVALID');
        return { completed: false, reason: 'CREDIT_AMOUNT_INVALID' };
    }

    // ─── 8. Atomic ledger credit via RPC ───
    const account = await LedgerService.getOrCreateAccount(deposit.user_id, deposit.target_currency);

    const metadata = {
        source_currency:  deposit.source_currency,
        source_amount:    sourcePaid,
        target_currency:  deposit.target_currency,
        fx_rate:          lockedRate,
        fx_rate_source:   deposit.fx_rate_source,
        fx_rate_ref:      deposit.fx_rate_reference,
        fx_markup:        deposit.fx_markup,
        provider:         'korapay',
        provider_reference: providerRef,
        deposit_reference:  deposit.internal_reference,
        deposit_fee:      fee,
        net_amount_ngn:   netAmount,
        source
    };

    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc('process_deposit_credit', {
        p_user_id:            deposit.user_id,
        p_account_id:         account.id,
        p_currency:           deposit.target_currency,
        p_amount:             targetCredit,
        p_reference:          deposit.internal_reference,
        p_provider:           'korapay',
        p_provider_reference: providerRef,
        p_metadata:           metadata
    });

    if (rpcErr) {
        console.error('[DEPOSIT] Ledger RPC error:', rpcErr.message);
        return { completed: false, reason: 'LEDGER_CREDIT_FAILED' };
    }

    const transactionId     = rpcResult?.transaction_id || null;
    const alreadyProcessed  = rpcResult?.already_processed === true;

    // ─── 9. Update deposit row ───
    const now = new Date().toISOString();
    await supabaseAdmin
        .from('deposit_requests')
        .update({
            status: 'completed',
            provider_reference: providerRef,
            target_amount: targetCredit,
            amount_paid:   sourcePaid,
            provider_fee:  fee,
            ledger_transaction_id: transactionId,
            unified_transaction_id: transactionId,
            completed_at:  now,
            updated_at:    now
        })
        .eq('id', deposit.id)
        .eq('status', 'processing');

    await supabaseAdmin
        .from('deposit_requests')
        .update({
            status: 'completed',
            provider_reference: providerRef,
            target_amount: targetCredit,
            amount_paid:   sourcePaid,
            provider_fee:  fee,
            ledger_transaction_id: transactionId,
            unified_transaction_id: transactionId,
            completed_at:  now,
            updated_at:    now
        })
        .eq('id', deposit.id)
        .neq('status', 'completed');

    // ─── 10. Notifications + email (non-blocking) ───
    try {
        const creditedStr = deposit.target_currency === 'USD'
            ? `$${targetCredit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : `₦${targetCredit.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        const sourceStr = `${deposit.source_currency} ${sourcePaid.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        await createNotification(
            deposit.user_id,
            '💰 Wallet Funded',
            `Your wallet has been credited with ${creditedStr} from a ${sourceStr} deposit.`,
            'success',
            `/fund`
        );

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('email, username')
            .eq('id', deposit.user_id)
            .maybeSingle();

        if (profile?.email) {
            await emailService.sendPaymentReceived(
                profile.email,
                profile.username || 'User',
                targetCredit,
                deposit.target_currency,
                deposit.internal_reference,
                `${sourceStr} via KoraPay`
            );
        }
    } catch (notifyErr) {
        console.warn('[DEPOSIT] Notification/email error (non-fatal):', notifyErr.message);
    }

    return {
        completed: true,
        transaction_id: transactionId,
        already_processed: alreadyProcessed,
        target_amount: targetCredit,
        source_amount: sourcePaid,
        source_currency: deposit.source_currency,
        deposit_fee: fee,
        net_amount_ngn: netAmount
    };
}

async function markManualReview(depositId, reason) {
    await supabaseAdmin
        .from('deposit_requests')
        .update({
            status: 'manual_review',
            failure_reason: reason,
            updated_at: new Date().toISOString()
        })
        .eq('id', depositId);
}

module.exports = {
    buildInternalReference,
    buildMerchantReference,
    createDepositRequest,
    completeKoraDeposit,
    computeDepositFee
};