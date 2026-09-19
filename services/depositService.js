// services/depositService.js
// Central service for KoraPay deposits.
//
// Guarantees:
//   • Every deposit has a matching pending transaction row from the
//     moment it is initialised.
//   • On completion, that same row is flipped to 'completed' and the
//     NGN flat fee is booked as a separate fee_revenue row.
//   • On failure, the pending row is flipped to 'failed'.
//   • On manual review, the pending row is flipped to 'manual_review'.
//   • The wallet credit uses the LOCKED wallet_amount — never
//     recalculated from today's rate.
//   • Idempotent per provider_reference.

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const { createNotification } = require('./notificationService');
const korapayService = require('./korapayService');
const emailService = require('./emailService');

// ─── REFERENCES ─────────────────────────────────────────────
function buildInternalReference() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `MSDEP-${date}-${rand}`;
}

function buildMerchantReference() {
    return 'MK-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function pendingRefFor(internalReference) {
    return `PENDING-${internalReference}`;
}

function num(v) {
    const n = Number(String(v ?? '0').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}

// ─── TRANSACTION HELPERS ────────────────────────────────────
/**
 * Insert (or refresh) the pending transaction row for a deposit.
 * Called at creation time and defensively on completion / failure.
 * Writes both `ref` and `reference`; sets `amount`, `amount_ngn`,
 * `amount_usd` so the row is never zero for the user.
 */
async function upsertPendingTransaction(deposit) {
    const walletCcy     = String(deposit.wallet_currency || deposit.target_currency || 'NGN').toUpperCase();
    const isNGNWallet   = walletCcy === 'NGN';
    const pendingAmount = num(deposit.wallet_amount || deposit.target_amount || deposit.expected_target_amount || 0);

    const ref = pendingRefFor(deposit.internal_reference);
    const now = new Date().toISOString();

    const meta = {
        provider: 'korapay',
        deposit_id: deposit.id,
        internal_reference: deposit.internal_reference,
        merchant_reference: deposit.merchant_reference,
        payment_currency: deposit.payment_currency || deposit.source_currency,
        payment_amount: num(deposit.payment_amount || deposit.source_amount),
        wallet_currency: walletCcy,
        expected_wallet_amount: pendingAmount,
        customer_rate: deposit.customer_rate != null ? num(deposit.customer_rate) : null,
        fee_amount: num(deposit.fee_amount || 0),
        fee_currency: deposit.fee_currency || null
    };

    const payload = {
        user_id: deposit.user_id,
        type: 'deposit',
        category: 'credit',
        description: `Deposit — ${(deposit.payment_currency || deposit.source_currency || 'NGN')} ${num(deposit.payment_amount || deposit.source_amount).toFixed(2)}`,
        currency: walletCcy,
        status: 'pending',
        ref,
        reference: ref,
        wallet_used: walletCcy,
        amount: pendingAmount,
        amount_ngn: isNGNWallet ? pendingAmount : 0,
        amount_usd: isNGNWallet ? 0 : pendingAmount,
        fee: 0,
        revenue_ngn: 0,
        revenue_usd: 0,
        meta,
        metadata: meta,
        created_at: now,
        updated_at: now
    };

    // Update-first so retries don't create duplicates.
    const { data: existing } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .or(`ref.eq.${ref},reference.eq.${ref}`)
        .eq('type', 'deposit')
        .maybeSingle();

    if (existing) {
        await supabaseAdmin
            .from('transactions')
            .update({
                amount: pendingAmount,
                amount_ngn: isNGNWallet ? pendingAmount : 0,
                amount_usd: isNGNWallet ? 0 : pendingAmount,
                meta,
                metadata: meta,
                updated_at: now
            })
            .eq('id', existing.id);
        return existing.id;
    }

    const { data, error } = await supabaseAdmin
        .from('transactions')
        .insert(payload)
        .select('id')
        .single();

    if (error) {
        console.warn('[DEPOSIT] pending transaction insert failed:', error.message);
        return null;
    }
    return data.id;
}

/**
 * Flip the pending row to completed (or insert a completed row if
 * none exists). Sets the credited amount and the fee.
 */
async function finalizeTransactionCompleted(deposit, { providerRef, walletCredit, walletCurrency, feeAmount }) {
    const now = new Date().toISOString();
    const pendingRef = pendingRefFor(deposit.internal_reference);
    const finalRef = `KORA-${providerRef}`;
    const isNGN = walletCurrency === 'NGN';
    const fee   = num(feeAmount || 0);

    const meta = {
        provider: 'korapay',
        deposit_id: deposit.id,
        internal_reference: deposit.internal_reference,
        merchant_reference: deposit.merchant_reference,
        payment_currency: deposit.payment_currency || deposit.source_currency,
        payment_amount: num(deposit.payment_amount || deposit.source_amount),
        wallet_currency: walletCurrency,
        credited_amount: walletCredit,
        customer_rate: deposit.customer_rate != null ? num(deposit.customer_rate) : null,
        fee_amount: fee,
        fee_currency: deposit.fee_currency || null,
        provider_reference: providerRef
    };

    // Try to flip the pending row.
    const { data: pendingRow } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .or(`ref.eq.${pendingRef},reference.eq.${pendingRef}`)
        .eq('type', 'deposit')
        .maybeSingle();

    if (pendingRow) {
        await supabaseAdmin
            .from('transactions')
            .update({
                status: 'completed',
                ref: finalRef,
                reference: finalRef,
                amount: walletCredit,
                amount_ngn: isNGN ? walletCredit : 0,
                amount_usd: !isNGN ? walletCredit : 0,
                fee: isNGN ? fee : 0,
                revenue_ngn: isNGN ? fee : 0,
                revenue_usd: 0,
                wallet_used: walletCurrency,
                meta,
                metadata: meta,
                completed_at: now,
                updated_at: now
            })
            .eq('id', pendingRow.id);
        return pendingRow.id;
    }

    // No pending row — insert a completed one so the user still sees it.
    const { data: inserted } = await supabaseAdmin
        .from('transactions')
        .insert({
            user_id: deposit.user_id,
            type: 'deposit',
            category: 'credit',
            description: `Deposit — ${(deposit.payment_currency || deposit.source_currency || 'NGN')} ${num(deposit.payment_amount || deposit.source_amount).toFixed(2)}`,
            currency: walletCurrency,
            status: 'completed',
            ref: finalRef,
            reference: finalRef,
            wallet_used: walletCurrency,
            amount: walletCredit,
            amount_ngn: isNGN ? walletCredit : 0,
            amount_usd: !isNGN ? walletCredit : 0,
            fee: isNGN ? fee : 0,
            revenue_ngn: isNGN ? fee : 0,
            revenue_usd: 0,
            meta,
            metadata: meta,
            created_at: now,
            completed_at: now,
            updated_at: now
        })
        .select('id')
        .single();

    return inserted?.id || null;
}

/**
 * Book the flat fee as a separate revenue row (NGN only).
 * Idempotent per `FEE-${providerRef}`.
 */
async function bookFeeRevenue(deposit, { providerRef, feeAmount }) {
    const fee = num(feeAmount || 0);
    if (fee <= 0) return null;
    if (String(deposit.fee_currency || '').toUpperCase() !== 'NGN') return null;

    const now = new Date().toISOString();
    const feeRef = `FEE-${providerRef}`;

    const { data: existing } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .or(`ref.eq.${feeRef},reference.eq.${feeRef}`)
        .eq('type', 'fee_revenue')
        .maybeSingle();

    if (existing) return existing.id;

    const { data, error } = await supabaseAdmin
        .from('transactions')
        .insert({
            user_id: deposit.user_id,
            type: 'fee_revenue',
            category: 'credit',
            description: `Deposit fee — ${deposit.internal_reference}`,
            currency: 'NGN',
            status: 'completed',
            ref: feeRef,
            reference: feeRef,
            wallet_used: 'NGN',
            amount: fee,
            amount_ngn: fee,
            amount_usd: 0,
            fee: 0,
            revenue_ngn: fee,
            revenue_usd: 0,
            meta: {
                provider: 'korapay',
                deposit_id: deposit.id,
                deposit_reference: deposit.internal_reference,
                fee_currency: 'NGN'
            },
            metadata: {
                provider: 'korapay',
                deposit_id: deposit.id,
                deposit_reference: deposit.internal_reference,
                fee_currency: 'NGN'
            },
            created_at: now,
            completed_at: now,
            updated_at: now
        })
        .select('id')
        .single();

    if (error) {
        console.warn('[DEPOSIT] fee_revenue insert failed:', error.message);
        return null;
    }
    return data.id;
}

/**
 * Flip a pending row to a non-success state.
 */
async function finalizeTransactionNonSuccess(deposit, { status, reason }) {
    const now = new Date().toISOString();
    const pendingRef = pendingRefFor(deposit.internal_reference);

    await supabaseAdmin
        .from('transactions')
        .update({
            status,
            updated_at: now,
            failed_at: status === 'failed' ? now : null,
            cancelled_at: status === 'cancelled' ? now : null,
            meta: {
                provider: 'korapay',
                deposit_id: deposit.id,
                internal_reference: deposit.internal_reference,
                failure_reason: reason || status,
                updated_at: now
            },
            metadata: {
                provider: 'korapay',
                deposit_id: deposit.id,
                internal_reference: deposit.internal_reference,
                failure_reason: reason || status,
                updated_at: now
            }
        })
        .or(`ref.eq.${pendingRef},reference.eq.${pendingRef}`)
        .eq('type', 'deposit')
        .neq('status', 'completed');
}

// ─── CREATE DEPOSIT ─────────────────────────────────────────
async function createDepositRequest({
    userId,
    cfg,
    breakdown,
    rateReference,
    quoteId = null,
    quoteExpiresAt = null
}) {
    const internalReference = buildInternalReference();
    const merchantReference = buildMerchantReference();
    const now = new Date().toISOString();

    // ─── 1. Insert deposit_requests ─────────────────────────
    const { data, error } = await supabaseAdmin
        .from('deposit_requests')
        .insert({
            user_id: userId,
            internal_reference: internalReference,
            provider: 'korapay',
            merchant_reference: merchantReference,

            // Canonical fields
            payment_currency: breakdown.payment_currency,
            payment_amount:   breakdown.payment_amount,
            wallet_currency:  breakdown.wallet_currency,
            wallet_amount:    breakdown.wallet_amount,
            customer_rate:    breakdown.customer_rate ?? null,
            rate_reference:   rateReference || null,
            fee_amount:       breakdown.fee_amount || 0,
            fee_currency:     breakdown.fee_currency || null,
            gross_amount:     breakdown.gross_amount,
            net_amount:       breakdown.net_amount,
            quote_id:         quoteId,
            quote_expires_at: quoteExpiresAt,

            // Legacy mirrors
            source_currency:        cfg.code,
            source_amount:          breakdown.payment_amount,
            target_currency:        breakdown.wallet_currency,
            target_amount:          breakdown.wallet_amount,
            expected_target_amount: breakdown.wallet_amount,
            fx_rate:                breakdown.customer_rate ?? null,
            fx_rate_source:         breakdown.rate_source || 'NONE',
            fx_rate_reference:      rateReference || null,
            fx_markup:              0,

            status: 'pending',
            created_at: now,
            updated_at: now
        })
        .select()
        .single();

    if (error) throw error;

    // ─── 2. Insert pending transaction row ──────────────────
    await upsertPendingTransaction(data);

    return data;
}

// ─── COMPLETE DEPOSIT ───────────────────────────────────────
async function completeKoraDeposit({ depositId, providerTransaction, source }) {
    // ─── 1. Lock deposit row ────────────────────────────────
    const { data: deposit, error: depErr } = await supabaseAdmin
        .from('deposit_requests')
        .select('*')
        .eq('id', depositId)
        .maybeSingle();

    if (depErr) throw depErr;
    if (!deposit) return { completed: false, reason: 'DEPOSIT_NOT_FOUND' };

    if (deposit.status === 'completed') {
        return {
            completed: true,
            already_completed: true,
            reason: 'DEPOSIT_ALREADY_COMPLETED',
            transaction_id: deposit.ledger_transaction_id
        };
    }

    const providerRef = providerTransaction?.reference || providerTransaction?.payment_reference;
    if (!providerRef) return { completed: false, reason: 'MISSING_PROVIDER_REFERENCE' };

    // ─── 2. Server-side verification ────────────────────────
    let verified = providerTransaction;
    if (!providerTransaction._verified) {
        try {
            verified = await korapayService.verifyTransaction(providerRef);
            verified._verified = true;
        } catch (err) {
            console.error('[DEPOSIT] verify failed:', err.message);
            await supabaseAdmin
                .from('deposit_requests')
                .update({ status: 'processing', updated_at: new Date().toISOString() })
                .eq('id', deposit.id)
                .eq('status', 'pending');
            return { completed: false, reason: 'PAYMENT_NOT_VERIFIED' };
        }
    }

    // ─── 3. Provider status ─────────────────────────────────
    const pStatus = String(verified.provider_status || verified.status || '').toLowerCase();
    if (!['success', 'successful', 'completed'].includes(pStatus)) {
        await supabaseAdmin
            .from('deposit_requests')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', deposit.id)
            .eq('status', 'pending');
        return { completed: false, reason: `PROVIDER_STATUS_${pStatus || 'UNKNOWN'}` };
    }

    // ─── 4. Verify currency + amount ────────────────────────
    const providerCurrency = String(verified.currency || '').toUpperCase();
    const providerAmount   = num(verified.amount);
    const expectedCcy      = String(deposit.payment_currency || deposit.source_currency || '').toUpperCase();
    const expectedAmt      = num(deposit.payment_amount || deposit.source_amount);

    if (providerCurrency && expectedCcy && providerCurrency !== expectedCcy) {
        await markManualReview(deposit.id, 'PAYMENT_CURRENCY_MISMATCH');
        return { completed: false, reason: 'PAYMENT_CURRENCY_MISMATCH' };
    }
    if (!providerAmount) {
        await markManualReview(deposit.id, 'MISSING_PROVIDER_AMOUNT');
        return { completed: false, reason: 'MISSING_PROVIDER_AMOUNT' };
    }

    const drift = expectedAmt > 0 ? Math.abs(providerAmount - expectedAmt) / expectedAmt : 1;
    if (drift > 0.02) {
        await markManualReview(deposit.id, providerAmount < expectedAmt ? 'UNDERPAID' : 'OVERPAID');
        return { completed: false, reason: providerAmount < expectedAmt ? 'UNDERPAID' : 'OVERPAID' };
    }

    // ─── 5. Credit the LOCKED wallet_amount ─────────────────
    const walletCurrency = String(deposit.wallet_currency || deposit.target_currency || 'NGN').toUpperCase();
    const walletCredit   = num(deposit.wallet_amount || deposit.target_amount || deposit.expected_target_amount);

    if (!Number.isFinite(walletCredit) || walletCredit <= 0) {
        await markManualReview(deposit.id, 'INVALID_WALLET_AMOUNT');
        return { completed: false, reason: 'INVALID_WALLET_AMOUNT' };
    }

    const account = await LedgerService.getOrCreateAccount(deposit.user_id, walletCurrency);

    let ledgerResult;
    try {
        ledgerResult = await LedgerService.createTransaction({
            userId: deposit.user_id,
            type: 'deposit',
            amount: walletCredit,
            currency: walletCurrency,
            description: `Deposit — ${deposit.payment_currency || deposit.source_currency} ${num(deposit.payment_amount || deposit.source_amount).toFixed(2)}`,
            reference: `KORA-${providerRef}`,
            sourceType: 'kora_deposit',
            sourceId: deposit.id,
            provider: 'korapay',
            providerReference: String(providerRef),
            metadata: {
                payment_currency: deposit.payment_currency || deposit.source_currency,
                payment_amount:   num(deposit.payment_amount || deposit.source_amount),
                wallet_currency:  walletCurrency,
                customer_rate:    deposit.customer_rate != null ? num(deposit.customer_rate) : null,
                rate_reference:   deposit.rate_reference || null,
                fee_amount:       num(deposit.fee_amount || 0),
                fee_currency:     deposit.fee_currency || null,
                provider:         'korapay',
                provider_reference: providerRef,
                deposit_reference:  deposit.internal_reference,
                source
            },
            idempotencyKey: `kora-deposit-${providerRef}`
        });
    } catch (ledgerErr) {
        console.error('[DEPOSIT] ledger credit failed:', ledgerErr.message);
        await supabaseAdmin
            .from('deposit_requests')
            .update({
                status: 'processing',
                failure_reason: 'LEDGER_CREDIT_FAILED',
                updated_at: new Date().toISOString()
            })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        return { completed: false, reason: 'LEDGER_CREDIT_FAILED' };
    }

    // ─── 6. Mark deposit completed ──────────────────────────
    const now = new Date().toISOString();
    await supabaseAdmin
        .from('deposit_requests')
        .update({
            status: 'completed',
            provider_reference: providerRef,
            amount_paid: providerAmount,
            ledger_transaction_id: ledgerResult?.transaction_id || null,
            unified_transaction_id: ledgerResult?.transaction_id || null,
            completed_at: now,
            updated_at: now
        })
        .eq('id', deposit.id)
        .neq('status', 'completed');

    // ─── 7. Flip the pending user-facing row to completed ───
    await finalizeTransactionCompleted(deposit, {
        providerRef,
        walletCredit,
        walletCurrency,
        feeAmount: num(deposit.fee_amount || 0)
    });

    // ─── 8. Book the flat fee as revenue (NGN only) ─────────
    await bookFeeRevenue(deposit, {
        providerRef,
        feeAmount: num(deposit.fee_amount || 0)
    });

    // ─── 9. Notify + email (non-fatal) ──────────────────────
    try {
        const walletStr = walletCurrency === 'USD'
            ? `$${walletCredit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : `₦${walletCredit.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        const paymentStr = `${deposit.payment_currency || deposit.source_currency} ${num(deposit.payment_amount || deposit.source_amount).toFixed(2)}`;

        await createNotification(
            deposit.user_id,
            '💰 Wallet Funded',
            `Your ${walletCurrency} wallet has been credited with ${walletStr} from a ${paymentStr} deposit.`,
            'success',
            '/fund'
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
                walletCredit,
                walletCurrency,
                deposit.internal_reference,
                `${paymentStr} via KoraPay`
            );
        }
    } catch (notifyErr) {
        console.warn('[DEPOSIT] post-credit notification error:', notifyErr.message);
    }

    return {
        completed: true,
        transaction_id: ledgerResult?.transaction_id || null,
        wallet_currency: walletCurrency,
        wallet_amount: walletCredit
    };
}

// ─── MARK STATES ────────────────────────────────────────────
async function markManualReview(depositId, reason) {
    const { data: deposit } = await supabaseAdmin
        .from('deposit_requests')
        .update({
            status: 'manual_review',
            failure_reason: reason,
            updated_at: new Date().toISOString()
        })
        .eq('id', depositId)
        .select('*')
        .maybeSingle();

    if (deposit) {
        await finalizeTransactionNonSuccess(deposit, { status: 'manual_review', reason });
    }
}

async function markDepositFailed(depositId, reason) {
    const { data: deposit } = await supabaseAdmin
        .from('deposit_requests')
        .update({
            status: 'failed',
            failure_reason: reason,
            failed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', depositId)
        .neq('status', 'completed')
        .select('*')
        .maybeSingle();

    if (deposit) {
        await finalizeTransactionNonSuccess(deposit, { status: 'failed', reason });
    }
}

module.exports = {
    buildInternalReference,
    buildMerchantReference,
    createDepositRequest,
    completeKoraDeposit,
    markManualReview,
    markDepositFailed,
    upsertPendingTransaction,
    finalizeTransactionCompleted,
    finalizeTransactionNonSuccess,
    bookFeeRevenue
};