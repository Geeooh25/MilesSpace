// services/depositService.js
//
// KoraPay deposit lifecycle.
//
// Guarantees:
//   • A deposit_requests row is written before Kora is contacted.
//   • A pending transaction row exists for every deposit, always.
//     If it cannot be inserted, the deposit creation throws.
//   • Success path:
//       1. Verify with Kora (unless the caller is the webhook and
//          supplies a sealed trusted digest — see _isTrustedVerified).
//       2. claim_kora_deposit_for_credit → single winner.
//       3. LedgerService.createTransaction (reference KORA-<ref>).
//       4. finalize_kora_deposit → status='completed', tx_id saved.
//       5. Rewrite pending history row to completed.
//       6. Book fee revenue (idempotent).
//       7. Notify + email ONCE per deposit (deposit_notified flag).
//   • Failure path (ledger failure, validation fail) releases the
//     claim to `pending` so a later webhook can retry.
//   • Duplicate webhooks/races: second caller gets claimed=false.

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const { createNotification } = require('./notificationService');
const korapayService = require('./korapayService');
const emailService = require('./emailService');

const EXACT_BAND = 0.02;

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

function finalRefFor(providerRef) {
    return `KORA-${providerRef}`;
}

function num(v) {
    const n = Number(String(v ?? '0').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}

// ─── TRUSTED VERIFICATION DIGEST ─────────────────────────────
// A webhook handler may compute this from the signed raw payload
// to signal to completeKoraDeposit that verification was already
// done. It is a plain HMAC over the fields we care about.
function computeVerifiedDigest(verified) {
    const secret = process.env.KORA_WEBHOOK_SECRET || process.env.KORA_SECRET_KEY || '';
    if (!secret) return null;
    const body = JSON.stringify({
        provider_status: String(verified.provider_status || verified.status || '').toLowerCase(),
        amount:          String(verified.amount ?? ''),
        currency:        String(verified.currency || '').toUpperCase(),
        reference:       String(verified.reference || verified.payment_reference || '')
    });
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function _isTrustedVerified(providerTransaction) {
    if (!providerTransaction || providerTransaction._trustedVerified !== true) return false;
    const expected = computeVerifiedDigest(providerTransaction);
    if (!expected) return false;
    return crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(String(providerTransaction._verifiedDigest || ''), 'hex')
    );
}

// ─── PENDING TRANSACTION ROW ────────────────────────────────
// Idempotent by reference. Returns row ID or throws.
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

    const { data: existing, error: readErr } = await supabaseAdmin
        .from('transactions')
        .select('id, status')
        .eq('reference', ref)
        .maybeSingle();

    if (readErr) {
        throw new Error(`upsertPendingTransaction: read failed — ${readErr.message}`);
    }

    if (existing) {
        // If a previous attempt already completed the row, do not
        // touch its amount. Otherwise refresh.
        if (existing.status === 'completed') return existing.id;

        const { error: updErr } = await supabaseAdmin
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
        if (updErr) {
            throw new Error(`upsertPendingTransaction: update failed — ${updErr.message}`);
        }
        return existing.id;
    }

    const { data, error } = await supabaseAdmin
        .from('transactions')
        .insert({
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
        })
        .select('id')
        .single();

    if (error) {
        if (error.code === '23505') {
            const { data: raced, error: reErr } = await supabaseAdmin
                .from('transactions')
                .select('id')
                .eq('reference', ref)
                .maybeSingle();
            if (reErr) throw new Error(`upsertPendingTransaction: reread failed — ${reErr.message}`);
            if (raced) return raced.id;
        }
        throw new Error(`upsertPendingTransaction: insert failed — ${error.message}`);
    }
    return data.id;
}

// ─── FINALIZE COMPLETED ────────────────────────────────────
// Called AFTER the ledger has already succeeded. On every branch,
// the caller MUST have already verified the ledger row (by ref).
async function finalizeTransactionCompleted(deposit, { providerRef, walletCredit, walletCurrency, feeAmount }) {
    const now = new Date().toISOString();
    const pendingRef = pendingRefFor(deposit.internal_reference);
    const finalRef = finalRefFor(providerRef);
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

    // 1. Try to rewrite the pending row.
    const { data: pendingRow, error: prErr } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('reference', pendingRef)
        .maybeSingle();
    if (prErr) throw new Error(`finalizeTransactionCompleted: read pending failed — ${prErr.message}`);

    if (pendingRow) {
        const { error: updErr } = await supabaseAdmin
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

        if (!updErr) return pendingRow.id;
        if (updErr.code !== '23505') {
            throw new Error(`finalizeTransactionCompleted: update failed — ${updErr.message}`);
        }
    }

    // 2. The final row may already exist (idempotent retry). Only
    //    return it if the fields match.
    const { data: existingFinal, error: efErr } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, amount, currency, source_id')
        .eq('reference', finalRef)
        .maybeSingle();
    if (efErr) throw new Error(`finalizeTransactionCompleted: read final failed — ${efErr.message}`);

    if (existingFinal) {
        const matches =
            String(existingFinal.user_id) === String(deposit.user_id) &&
            Math.abs(num(existingFinal.amount) - walletCredit) < 0.005 &&
            String(existingFinal.currency).toUpperCase() === String(walletCurrency).toUpperCase() &&
            String(existingFinal.source_id || '') === String(deposit.id);

        if (!matches) {
            throw new Error(
                `finalizeTransactionCompleted: reference ${finalRef} exists but does not match the intended deposit`
            );
        }
        return existingFinal.id;
    }

    // 3. No pending row. Insert a completed one.
    const { data: inserted, error: insErr } = await supabaseAdmin
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

    if (insErr) {
        if (insErr.code === '23505') {
            const { data: dupe, error: dupErr } = await supabaseAdmin
                .from('transactions')
                .select('id')
                .eq('reference', finalRef)
                .maybeSingle();
            if (dupErr) throw new Error(`finalizeTransactionCompleted: reread failed — ${dupErr.message}`);
            if (dupe) return dupe.id;
        }
        throw new Error(`finalizeTransactionCompleted: insert failed — ${insErr.message}`);
    }
    return inserted.id;
}

// ─── FEE REVENUE ───────────────────────────────────────────
async function bookFeeRevenue(deposit, { providerRef, feeAmount }) {
    const fee = num(feeAmount || 0);
    if (fee <= 0) return null;
    if (String(deposit.fee_currency || '').toUpperCase() !== 'NGN') return null;

    const now = new Date().toISOString();
    const feeRef = `FEE-${providerRef}`;

    const { data: existing, error: readErr } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, amount, currency')
        .eq('reference', feeRef)
        .maybeSingle();
    if (readErr) throw new Error(`bookFeeRevenue: read failed — ${readErr.message}`);

    if (existing) {
        const matches =
            String(existing.user_id) === String(deposit.user_id) &&
            Math.abs(num(existing.amount) - fee) < 0.005 &&
            String(existing.currency).toUpperCase() === 'NGN';
        if (!matches) {
            throw new Error(`bookFeeRevenue: reference ${feeRef} exists but does not match`);
        }
        return existing.id;
    }

    const meta = {
        provider: 'korapay',
        deposit_id: deposit.id,
        deposit_reference: deposit.internal_reference,
        fee_currency: 'NGN'
    };

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
            meta,
            metadata: meta,
            created_at: now,
            completed_at: now,
            updated_at: now
        })
        .select('id')
        .single();

    if (error) {
        if (error.code === '23505') {
            const { data: dupe } = await supabaseAdmin
                .from('transactions')
                .select('id')
                .eq('reference', feeRef)
                .maybeSingle();
            if (dupe) return dupe.id;
        }
        throw new Error(`bookFeeRevenue: insert failed — ${error.message}`);
    }
    return data.id;
}

// ─── FINALIZE NON-SUCCESS ──────────────────────────────────
async function finalizeTransactionNonSuccess(deposit, { status, reason }) {
    const now = new Date().toISOString();
    const pendingRef = pendingRefFor(deposit.internal_reference);

    const { error } = await supabaseAdmin
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
        .eq('reference', pendingRef)
        .neq('status', 'completed');

    if (error) {
        console.warn('[DEPOSIT] finalizeTransactionNonSuccess failed:', error.message);
        // Non-fatal: the history row's state is cosmetic. The
        // authoritative state is deposit_requests.status.
    }
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

    const { data, error } = await supabaseAdmin
        .from('deposit_requests')
        .insert({
            user_id: userId,
            internal_reference: internalReference,
            provider: 'korapay',
            merchant_reference: merchantReference,

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

    // If the pending transaction row cannot be written, abandon the
    // deposit. Do not leave a bare deposit_requests row behind.
    try {
        await upsertPendingTransaction(data);
    } catch (pendingErr) {
        await supabaseAdmin
            .from('deposit_requests')
            .update({
                status: 'failed',
                failure_reason: `PENDING_TX_FAILED: ${pendingErr.message}`.slice(0, 500),
                failed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', data.id);
        throw new Error(`Failed to create pending transaction: ${pendingErr.message}`);
    }

    return data;
}

// ─── COMPLETE DEPOSIT ───────────────────────────────────────
async function completeKoraDeposit({ depositId, providerTransaction, source }) {
    const providerRef = providerTransaction?.reference || providerTransaction?.payment_reference;
    if (!providerRef) return { completed: false, reason: 'MISSING_PROVIDER_REFERENCE' };

    // ── 1. Verification. Only the webhook route may set
    //       _trustedVerified + _verifiedDigest (from a signed raw
    //       payload). Anyone else: always verify.
    let verified = providerTransaction;
    if (!_isTrustedVerified(providerTransaction)) {
        try {
            verified = await korapayService.verifyTransaction(providerRef);
            verified._verified = true;
        } catch (err) {
            console.error('[DEPOSIT] verify failed:', err.message);
            return { completed: false, reason: 'PAYMENT_NOT_VERIFIED' };
        }
    }

    const pStatus = String(verified.provider_status || verified.status || '').toLowerCase();
    if (!['success', 'successful', 'completed'].includes(pStatus)) {
        // Guarded transition — only move out of `pending`.
        await supabaseAdmin
            .from('deposit_requests')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', depositId)
            .eq('status', 'pending');
        return { completed: false, reason: `PROVIDER_STATUS_${pStatus || 'UNKNOWN'}` };
    }

    // ── 2. Atomic claim. Only one caller wins.
    const { data: claimResult, error: claimErr } = await supabaseAdmin
        .rpc('claim_kora_deposit_for_credit', { p_provider_ref: providerRef });

    if (claimErr) {
        console.error('[DEPOSIT] claim failed:', claimErr.message);
        return { completed: false, reason: 'CLAIM_FAILED' };
    }

    const claim = Array.isArray(claimResult) ? claimResult[0] : claimResult;
    if (!claim) return { completed: false, reason: 'DEPOSIT_NOT_FOUND' };

    if (!claim.claimed) {
        const alreadyCompleted = claim.existing_status === 'completed';
        return {
            completed: alreadyCompleted,
            already_completed: alreadyCompleted,
            reason: alreadyCompleted ? 'DEPOSIT_ALREADY_COMPLETED' : 'CLAIMED_ELSEWHERE'
        };
    }

    // ── 3. Read the full row.
    const { data: deposit, error: depErr } = await supabaseAdmin
        .from('deposit_requests')
        .select('*')
        .eq('id', claim.deposit_id)
        .maybeSingle();

    if (depErr || !deposit) {
        await supabaseAdmin.rpc('release_kora_deposit_claim', {
            p_deposit_id: claim.deposit_id,
            p_reason: 'DEPOSIT_READ_FAILED'
        });
        return { completed: false, reason: 'DEPOSIT_READ_FAILED' };
    }

    // ── 4. Validate provider response.
    const providerCurrency = String(verified.currency || '').toUpperCase();
    const providerAmount   = Number(verified.amount);
    const expectedCcy      = String(deposit.payment_currency || deposit.source_currency || '').toUpperCase();
    const expectedAmt      = num(deposit.payment_amount || deposit.source_amount);

    if (!providerCurrency) {
        await _releaseAndMark(claim.deposit_id, 'manual_review', 'MISSING_PROVIDER_CURRENCY');
        return { completed: false, reason: 'MISSING_PROVIDER_CURRENCY' };
    }
    if (!Number.isFinite(providerAmount) || providerAmount <= 0) {
        await _releaseAndMark(claim.deposit_id, 'manual_review', 'MISSING_PROVIDER_AMOUNT');
        return { completed: false, reason: 'MISSING_PROVIDER_AMOUNT' };
    }
    if (providerCurrency !== expectedCcy) {
        await _releaseAndMark(claim.deposit_id, 'manual_review', 'PAYMENT_CURRENCY_MISMATCH');
        return { completed: false, reason: 'PAYMENT_CURRENCY_MISMATCH' };
    }
    if (expectedAmt <= 0) {
        await _releaseAndMark(claim.deposit_id, 'manual_review', 'INVALID_EXPECTED_AMOUNT');
        return { completed: false, reason: 'INVALID_EXPECTED_AMOUNT' };
    }

    const drift = Math.abs(providerAmount - expectedAmt) / expectedAmt;
    if (drift > EXACT_BAND) {
        const reason = providerAmount < expectedAmt ? 'UNDERPAID' : 'OVERPAID';
        await _releaseAndMark(claim.deposit_id, 'manual_review', reason);
        return { completed: false, reason };
    }

    // ── 5. Credit the LOCKED wallet_amount.
    const walletCurrency = String(deposit.wallet_currency || deposit.target_currency || 'NGN').toUpperCase();
    const walletCredit   = num(deposit.wallet_amount || deposit.target_amount || deposit.expected_target_amount);

    if (!Number.isFinite(walletCredit) || walletCredit <= 0) {
        await _releaseAndMark(claim.deposit_id, 'manual_review', 'INVALID_WALLET_AMOUNT');
        return { completed: false, reason: 'INVALID_WALLET_AMOUNT' };
    }

    let ledgerResult;
    try {
        ledgerResult = await LedgerService.createTransaction({
            userId: deposit.user_id,
            type: 'deposit',
            amount: walletCredit,
            currency: walletCurrency,
            description: `Deposit — ${deposit.payment_currency || deposit.source_currency} ${num(deposit.payment_amount || deposit.source_amount).toFixed(2)}`,
            reference: finalRefFor(providerRef),
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
        console.error('[DEPOSIT] LEDGER CREDIT FAILED:', ledgerErr.message);
        // Release the claim so a later webhook can retry.
        await supabaseAdmin.rpc('release_kora_deposit_claim', {
            p_deposit_id: claim.deposit_id,
            p_reason: `LEDGER_CREDIT_FAILED: ${ledgerErr.message}`.slice(0, 500)
        });
        return { completed: false, reason: 'LEDGER_CREDIT_FAILED' };
    }

    if (!ledgerResult || (!ledgerResult.transaction_id && !ledgerResult.already_exists)) {
        await supabaseAdmin.rpc('release_kora_deposit_claim', {
            p_deposit_id: claim.deposit_id,
            p_reason: 'LEDGER_NO_TRANSACTION_ID'
        });
        return { completed: false, reason: 'LEDGER_NO_TRANSACTION_ID' };
    }

    const txId = ledgerResult.transaction_id || null;
    const now  = new Date().toISOString();

    // ── 6. Finalize the deposit. Check the RPC result.
    const { data: finalizeResult, error: finalizeErr } = await supabaseAdmin
        .rpc('finalize_kora_deposit', {
            p_deposit_id: claim.deposit_id,
            p_new_status: 'completed',
            p_tx_id: txId,
            p_reason: null,
            p_amount_paid: providerAmount
        });

    if (finalizeErr) {
        console.error('[DEPOSIT] finalize RPC failed:', finalizeErr.message);
        // Ledger succeeded. Cannot roll it back. The deposit is stuck
        // in `processing_credit` and will be repaired on the next
        // webhook retry (ledger's 23505 + finalize will then work).
        return { completed: false, reason: 'FINALIZE_FAILED', transaction_id: txId };
    }
    if (!finalizeResult || finalizeResult.updated !== true) {
        // The row may already have been `completed` — verify with a read.
        const { data: confirmed } = await supabaseAdmin
            .from('deposit_requests')
            .select('status, ledger_transaction_id')
            .eq('id', claim.deposit_id)
            .maybeSingle();
        if (!confirmed || confirmed.status !== 'completed') {
            console.error('[DEPOSIT] finalize did not mark completed:', { finalizeResult, confirmed });
            return { completed: false, reason: 'FINALIZE_NO_EFFECT', transaction_id: txId };
        }
    }

    // ── 7. Flip the pending history row.
    try {
        await finalizeTransactionCompleted(deposit, {
            providerRef,
            walletCredit,
            walletCurrency,
            feeAmount: num(deposit.fee_amount || 0)
        });
    } catch (histErr) {
        console.error('[DEPOSIT] history finalize failed:', histErr.message);
        // History is cosmetic. Notify and return success.
    }

    // ── 8. Book fee (best-effort, idempotent).
    try {
        await bookFeeRevenue(deposit, {
            providerRef,
            feeAmount: num(deposit.fee_amount || 0)
        });
    } catch (feeErr) {
        console.warn('[DEPOSIT] fee booking failed:', feeErr.message);
    }

    // ── 9. Notification + email, ONCE per deposit.
    await _notifyDepositOnce(deposit, walletCredit, walletCurrency, now);

    return {
        completed: true,
        transaction_id: txId,
        wallet_currency: walletCurrency,
        wallet_amount: walletCredit,
        already_exists: !!ledgerResult.already_exists
    };
}

// ─── RELEASE + MARK ────────────────────────────────────────
async function _releaseAndMark(depositId, status, reason) {
    await supabaseAdmin.rpc('finalize_kora_deposit', {
        p_deposit_id: depositId,
        p_new_status: status,
        p_tx_id: null,
        p_reason: reason,
        p_amount_paid: null
    });
    const { data: dep } = await supabaseAdmin
        .from('deposit_requests')
        .select('*')
        .eq('id', depositId)
        .maybeSingle();
    if (dep) await finalizeTransactionNonSuccess(dep, { status, reason });
}

// ─── NOTIFY ONCE ───────────────────────────────────────────
// Uses deposit_requests.deposit_notified to guarantee exactly one
// notification + one email per deposit even if the deposit is
// credited from a retry path.
async function _notifyDepositOnce(deposit, walletCredit, walletCurrency, completedAtIso) {
    // Atomic claim of the notification slot.
    const { data: updated, error } = await supabaseAdmin
        .from('deposit_requests')
        .update({ deposit_notified: true })
        .eq('id', deposit.id)
        .eq('deposit_notified', false)
        .select('id');

    if (error) {
        console.warn('[DEPOSIT] notification claim failed:', error.message);
        return;
    }
    if (!updated || updated.length === 0) {
        // Somebody else already notified.
        return;
    }

    const walletStr = walletCurrency === 'USD'
        ? `$${walletCredit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `₦${walletCredit.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const paymentStr = `${deposit.payment_currency || deposit.source_currency} ${num(deposit.payment_amount || deposit.source_amount).toFixed(2)}`;

    try {
        await createNotification(
            deposit.user_id,
            '💰 Wallet Funded',
            `Your ${walletCurrency} wallet has been credited with ${walletStr} from a ${paymentStr} deposit.`,
            'success',
            '/fund'
        );
    } catch (notifyErr) {
        console.warn('[DEPOSIT] notification error:', notifyErr.message);
    }

    try {
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('email, username')
            .eq('id', deposit.user_id)
            .maybeSingle();

        if (profile?.email && typeof emailService.sendDepositConfirmation === 'function') {
            await emailService.sendDepositConfirmation({
                email: profile.email,
                username: profile.username || 'User',
                internalReference: deposit.internal_reference,
                sourceCurrency: deposit.payment_currency || deposit.source_currency || 'NGN',
                sourceAmount: num(deposit.payment_amount || deposit.source_amount),
                targetCurrency: walletCurrency,
                creditedAmount: walletCredit,
                fxRate: deposit.customer_rate != null ? num(deposit.customer_rate) : 1,
                fxSource: deposit.fx_rate_source || 'NONE',
                completedAt: completedAtIso
            });
        }
    } catch (emailErr) {
        console.warn('[DEPOSIT] email error:', emailErr.message);
    }
}

// ─── MARK STATES ────────────────────────────────────────────
// Only `pending` and `processing` can be moved to failed or manual.
// `processing_credit` is owned by the credit-in-progress path, and
// `completed` is terminal.
async function markManualReview(depositId, reason) {
    const { data: deposit } = await supabaseAdmin
        .from('deposit_requests')
        .update({
            status: 'manual_review',
            failure_reason: reason,
            updated_at: new Date().toISOString()
        })
        .eq('id', depositId)
        .in('status', ['pending', 'processing'])
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
        .in('status', ['pending', 'processing'])
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
    bookFeeRevenue,
    computeVerifiedDigest
};