// services/depositService.js
// KoraPay deposit lifecycle.

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
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
    const ts = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `MSK-${ts}-${rand}`;
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

    const providedDigest = String(providerTransaction._verifiedDigest || '');
    if (providedDigest.length !== expected.length) return false;
    if (!/^[0-9a-f]+$/i.test(providedDigest)) return false;

    return crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(providedDigest, 'hex')
    );
}

// ─── PENDING TRANSACTION ROW ────────────────────────────────
// The pending row is created once, up-front, and identified for
// the rest of its life by:
//   source_type = 'kora_deposit'
//   source_id   = deposit_requests.id
//   type        = 'deposit'
// Its `reference` (PENDING-...) is stable and is never rewritten.
// This is what prevents the "duplicate history" bug — the pending
// row and the final row are the same physical row, updated in
// place, not two separate rows.
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

    // Look up by immutable identity so we cannot miss the row if
    // it was ever touched by other code.
    const { data: existing, error: readErr } = await supabaseAdmin
        .from('transactions')
        .select('id, status, reference')
        .eq('source_type', 'kora_deposit')
        .eq('source_id', deposit.id)
        .eq('type', 'deposit')
        .maybeSingle();

    if (readErr) {
        throw new Error(`upsertPendingTransaction: read failed — ${readErr.message}`);
    }

    if (existing) {
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

            // ─── IMMUTABLE IDENTITY ───
            // completeKoraDeposit finds the pending row by these two
            // columns. Both must be written at insert time. If they
            // are missing, the webhook logs PENDING_TX_MISSING and
            // the deposit stays in pending forever.
            source_type: 'kora_deposit',
            source_id: deposit.id,

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

    // Update by immutable identity, not by reference.
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
        .eq('source_type', 'kora_deposit')
        .eq('source_id', deposit.id)
        .eq('type', 'deposit')
        .neq('status', 'completed');

    if (error) {
        console.warn('[DEPOSIT] finalizeTransactionNonSuccess failed:', error.message);
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
        await supabaseAdmin
            .from('deposit_requests')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', depositId)
            .eq('status', 'pending');
        return { completed: false, reason: `PROVIDER_STATUS_${pStatus || 'UNKNOWN'}` };
    }

    // ─── AMBIGUITY GUARD ───
    const { data: matches } = await supabaseAdmin
        .from('deposit_requests')
        .select('id, status')
        .or(`provider_reference.eq.${providerRef},merchant_reference.eq.${providerRef}`);

    if (!matches || matches.length === 0) {
        return { completed: false, reason: 'DEPOSIT_NOT_FOUND' };
    }
    if (matches.length > 1) {
        for (const m of matches) {
            if (m.status === 'completed') continue;
            await supabaseAdmin
                .from('deposit_requests')
                .update({
                    status: 'manual_review',
                    failure_reason: 'AMBIGUOUS_REFERENCE',
                    updated_at: new Date().toISOString()
                })
                .eq('id', m.id)
                .neq('status', 'completed');
        }
        return { completed: false, reason: 'AMBIGUOUS_REFERENCE' };
    }

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

    const walletCurrency = String(deposit.wallet_currency || deposit.target_currency || 'NGN').toUpperCase();
    const walletCredit   = num(deposit.wallet_amount || deposit.target_amount || deposit.expected_target_amount);

    if (!Number.isFinite(walletCredit) || walletCredit <= 0) {
        await _releaseAndMark(claim.deposit_id, 'manual_review', 'INVALID_WALLET_AMOUNT');
        return { completed: false, reason: 'INVALID_WALLET_AMOUNT' };
    }

    // ─── ATOMIC LEDGER UPDATE VIA RPC ───
    const { data: pendingTx, error: pendingTxErr } = await supabaseAdmin
        .from('transactions')
        .select('id, reference')
        .eq('source_type', 'kora_deposit')
        .eq('source_id', deposit.id)
        .eq('type', 'deposit')
        .maybeSingle();

    if (pendingTxErr || !pendingTx) {
        console.error('[DEPOSIT] Missing pending tx row:', pendingTxErr?.message || 'no row');
        await _releaseAndMark(claim.deposit_id, 'manual_review', 'PENDING_TX_MISSING');
        return { completed: false, reason: 'PENDING_TX_MISSING' };
    }

    const { data: account, error: acctErr } = await supabaseAdmin
        .from('ledger_accounts')
        .select('id')
        .eq('user_id', deposit.user_id)
        .eq('currency', walletCurrency)
        .maybeSingle();

    if (acctErr || !account) {
        await _releaseAndMark(claim.deposit_id, 'manual_review', 'LEDGER_ACCOUNT_MISSING');
        return { completed: false, reason: 'LEDGER_ACCOUNT_MISSING' };
    }

    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc('process_transaction_v2', {
        p_user_id: deposit.user_id,
        p_account_id: account.id,
        p_transaction_data: {
            id: pendingTx.id,
            user_id: deposit.user_id,
            type: 'deposit',
            status: 'completed',
            currency: walletCurrency,
            amount: walletCredit,
            description: `Deposit — ${deposit.payment_currency || deposit.source_currency} ${num(deposit.payment_amount || deposit.source_amount).toFixed(2)}`,
            reference: pendingTx.reference,
            source_type: 'kora_deposit',
            source_id: deposit.id,
            provider: 'korapay',
            provider_reference: String(providerRef),
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
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: new Date().toISOString()
        },
        p_entry_type: 'CREDIT',
        p_amount: walletCredit,
        p_currency: walletCurrency
    });

    if (rpcErr) {
        console.error('[DEPOSIT] LEDGER CREDIT FAILED:', rpcErr.message);
        await supabaseAdmin.rpc('release_kora_deposit_claim', {
            p_deposit_id: claim.deposit_id,
            p_reason: `LEDGER_CREDIT_FAILED: ${rpcErr.message}`.slice(0, 500)
        });
        return { completed: false, reason: 'LEDGER_CREDIT_FAILED' };
    }

    const txId = pendingTx.id;
    const now  = new Date().toISOString();

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
        return { completed: false, reason: 'FINALIZE_FAILED', transaction_id: txId };
    }
    if (!finalizeResult || finalizeResult.updated !== true) {
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

    try {
        await bookFeeRevenue(deposit, {
            providerRef,
            feeAmount: num(deposit.fee_amount || 0)
        });
    } catch (feeErr) {
        console.warn('[DEPOSIT] fee booking failed:', feeErr.message);
    }

    await _notifyDepositOnce(deposit, walletCredit, walletCurrency, now);

    return {
        completed: true,
        transaction_id: txId,
        wallet_currency: walletCurrency,
        wallet_amount: walletCredit,
        already_exists: false
    };
}

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

async function _notifyDepositOnce(deposit, walletCredit, walletCurrency, completedAtIso) {
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
    if (!updated || updated.length === 0) return;

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
    finalizeTransactionNonSuccess,
    bookFeeRevenue,
    computeVerifiedDigest
};