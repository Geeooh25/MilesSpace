// services/cryptoDepositService.js
//
// Crypto deposits via NowPayments.
//
// Business rule (gross-up):
//   Customer requests $5.00 USD wallet credit.
//   Provider fee = 1%.
//   Provider receives: 5.00 / (1 - 0.01) = $5.05050505
//   Wallet gets $5.00 on successful payment.
//
// The fee is an INTERNAL concept. Never surfaced to the frontend.
//
// Partial / underpaid / wrong-asset → manual_review.
// Overpayment → credit the customer's LOCKED requested amount.
//
// IDEMPOTENCY:
//   • crypto_deposits has ONE row per NowPayments payment.
//   • The claim RPC flips `pending → processing_credit` atomically.
//   • transactions.reference = NP-<paymentId> is unique.
//   • A second webhook cannot reach the ledger because the first
//     one already holds the claim; if it somehow does, the unique
//     reference makes the second ledger call return already_exists.
//
// NOTIFICATION:
//   deposit_notified flag ensures exactly one notification + one
//   email, even across retries.

const crypto = require('crypto');
const axios = require('axios');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const { createNotification } = require('./notificationService');
const emailService = require('./emailService');

const NOWPAYMENTS_API_KEY    = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_API_BASE   = 'https://api.nowpayments.io/v1';
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;

const FEE_RATE_SINGLE   = Number(process.env.NOWPAYMENTS_DEPOSIT_FEE_RATE || 0.01);
const FEE_RATE_AUTOCONV = Number(process.env.NOWPAYMENTS_DEPOSIT_FEE_RATE_AUTOCONVERT || 0.015);

const MIN_USD = Number(process.env.CRYPTO_MIN_USD || 5);
const MAX_USD = Number(process.env.CRYPTO_MAX_USD || 100000);

const EXACT_BAND = 0.02;

const COIN_CATALOG = [
    { id: 'BTC',       symbol: 'BTC',  label: 'Bitcoin',        network: 'Bitcoin',  networks: ['Bitcoin']  },
    { id: 'ETH',       symbol: 'ETH',  label: 'Ethereum',       network: 'ERC20',    networks: ['ERC20']    },
    { id: 'LTC',       symbol: 'LTC',  label: 'Litecoin',       network: 'Litecoin', networks: ['Litecoin'] },
    { id: 'USDTTRC20', symbol: 'USDT', label: 'Tether (TRC20)', network: 'TRC20',    networks: ['TRC20']    },
    { id: 'BNB',       symbol: 'BNB',  label: 'Binance Coin',   network: 'BEP20',    networks: ['BEP20']    },
    { id: 'TRX',       symbol: 'TRX',  label: 'Tron',           network: 'TRC20',    networks: ['TRC20']    },
    { id: 'USDC',      symbol: 'USDC', label: 'USD Coin',       network: 'ERC20',    networks: ['ERC20']    },
    { id: 'DAI',       symbol: 'DAI',  label: 'DAI',            network: 'ERC20',    networks: ['ERC20']    },
    { id: 'DOGE',      symbol: 'DOGE', label: 'Dogecoin',       network: 'Dogecoin', networks: ['Dogecoin'] },
    { id: 'POL',       symbol: 'POL',  label: 'Polygon',        network: 'Polygon',  networks: ['Polygon']  },
    { id: 'SOL',       symbol: 'SOL',  label: 'Solana',         network: 'Solana',   networks: ['Solana']   },
    { id: 'TON',       symbol: 'TON',  label: 'TON',            network: 'TON',      networks: ['TON']      }
];

const _minCache = new Map();
const MIN_CACHE_MS = 60 * 1000;

function getFeeRate(paymentType = 'single') {
    switch (paymentType) {
        case 'single':      return FEE_RATE_SINGLE;
        case 'autoconvert':
        case 'fixed-rate':  return FEE_RATE_AUTOCONV;
        default:            return FEE_RATE_SINGLE;
    }
}

function computeFeeAndRequired(requestedUsd, paymentType = 'single') {
    const req = Number(requestedUsd);
    const feeRate = getFeeRate(paymentType);
    if (!Number.isFinite(req) || req <= 0) {
        throw Object.assign(new Error('Invalid amount'), { code: 'INVALID_AMOUNT' });
    }
    if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) {
        throw Object.assign(new Error('Invalid fee rate'), { code: 'INVALID_FEE_RATE' });
    }
    const requiredUsd = +(req / (1 - feeRate)).toFixed(8);
    const feeUsd      = +(requiredUsd - req).toFixed(8);
    return { requestedUsd: req, requiredUsd, feeUsd, feeRate };
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function findCatalogEntry(idOrSymbol) {
    const key = String(idOrSymbol || '').toUpperCase();
    return COIN_CATALOG.find(c => c.id === key || c.symbol === key);
}

async function getNowPaymentsMinimum(payCurrencyId, { force = false } = {}) {
    const key = String(payCurrencyId).toUpperCase();
    const cached = _minCache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached;

    let liveUsd = null;
    try {
        const { data } = await axios.get(`${NOWPAYMENTS_API_BASE}/min-amount`, {
            params: { currency_from: payCurrencyId, currency_to: 'USD', fiat_equivalent: 'USD' },
            headers: { 'x-api-key': NOWPAYMENTS_API_KEY },
            timeout: 8000
        });
        const fiat = parseFloat(data?.fiat_equivalent);
        if (Number.isFinite(fiat) && fiat > 0) liveUsd = fiat;
    } catch (err) {
        console.warn('[CRYPTO] min-amount lookup failed for', payCurrencyId, '—', err.message);
    }

    const minUsd = Math.max(MIN_USD, liveUsd || 0);
    const result = { minUsd: Number(minUsd.toFixed(2)), liveUsd: liveUsd || null };
    _minCache.set(key, { ...result, expiresAt: Date.now() + MIN_CACHE_MS });
    return result;
}

async function getCoinCatalogWithMins({ force = false } = {}) {
    const coins = [];
    for (const c of COIN_CATALOG) {
        const { minUsd } = await getNowPaymentsMinimum(c.id, { force });
        coins.push({
            id: c.id, symbol: c.symbol, label: c.label,
            network: c.network, networks: c.networks, minUsd
        });
    }
    return coins;
}

// ─── CREATE DEPOSIT ─────────────────────────────────────
async function createCryptoDeposit({
    userId,
    requestedAmountUsd,
    payCurrency,
    network,
    idempotencyKey,
    ipnCallbackUrl,
    paymentType = 'single'
}) {
    const requested = Number(requestedAmountUsd);
    const coinKey   = String(payCurrency || '').toUpperCase();

    if (!Number.isFinite(requested) || requested <= 0) {
        throw Object.assign(new Error('Invalid amount'), { code: 'INVALID_AMOUNT' });
    }
    if (requested < MIN_USD) {
        throw Object.assign(new Error(`Minimum deposit is $${MIN_USD}`), { code: 'AMOUNT_TOO_LOW', minUsd: MIN_USD });
    }
    if (requested > MAX_USD) {
        throw Object.assign(new Error(`Maximum deposit is $${MAX_USD}`), { code: 'AMOUNT_TOO_HIGH' });
    }

    const entry = findCatalogEntry(coinKey);
    if (!entry) {
        throw Object.assign(new Error(`${payCurrency} is not supported`), { code: 'PAY_CURRENCY_NOT_SUPPORTED' });
    }

    let chosenNetwork = entry.network || null;
    if (network) {
        const norm = String(network).toUpperCase();
        const allowed = (entry.networks || []).map(n => n.toUpperCase());
        if (allowed.length && !allowed.includes(norm)) {
            throw Object.assign(new Error(`Network ${network} is not available for ${entry.symbol}`), { code: 'NETWORK_NOT_SUPPORTED' });
        }
        chosenNetwork = (entry.networks || []).find(n => n.toUpperCase() === norm) || network;
    }

    const { minUsd } = await getNowPaymentsMinimum(entry.id);
    if (requested < minUsd) {
        throw Object.assign(new Error(`Minimum deposit for ${entry.symbol} is $${minUsd}`), { code: 'AMOUNT_TOO_LOW', minUsd });
    }

    const { requiredUsd, feeUsd, feeRate } = computeFeeAndRequired(requested, paymentType);

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
        throw Object.assign(new Error('idempotencyKey is required'), { code: 'MISSING_IDEMPOTENCY_KEY' });
    }
    const finalIk = idempotencyKey;

    const { data: existing } = await supabaseAdmin
        .from('crypto_deposits')
        .select('*')
        .eq('user_id', userId)
        .eq('idempotency_key', finalIk)
        .maybeSingle();

    if (existing) {
        if (['failed','expired','cancelled'].includes(existing.status)) {
            throw Object.assign(new Error('This deposit attempt already ended. Start a new one.'), { code: 'IDEMPOTENCY_KEY_REUSED' });
        }
        return buildPublicPayload(existing);
    }

    const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('email, username')
        .eq('id', userId)
        .single();
    if (!profile) {
        throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });
    }

    // ── Reserve: status='awaiting_payment_id', payment_id=NULL.
    const orderId = `MSCR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const { data: reserved, error: reserveErr } = await supabaseAdmin
        .from('crypto_deposits')
        .insert({
            user_id: userId,
            requested_usd: requested,
            requested_amount: requested,
            requested_currency: 'USD',
            fee_percent: feeRate,
            fee_usd: feeUsd,
            required_usd: requiredUsd,
            gross_amount: requiredUsd,
            pay_currency: entry.id,
            pay_network: chosenNetwork,
            nowpayments_order_id: orderId,
            idempotency_key: finalIk,
            status: 'awaiting_payment_id',
            nowpayments_payment_id: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .select()
        .single();

    if (reserveErr) {
        if (reserveErr.code === '23505') {
            const { data: raced } = await supabaseAdmin
                .from('crypto_deposits')
                .select('*')
                .eq('user_id', userId)
                .eq('idempotency_key', finalIk)
                .maybeSingle();
            if (raced) return buildPublicPayload(raced);
        }
        console.error('[CRYPTO] reserve failed:', reserveErr.message);
        throw Object.assign(new Error('Could not save deposit'), { code: 'DB_ERROR' });
    }

    // ── Call provider.
    const npPayload = {
        price_amount: requiredUsd,
        price_currency: 'USD',
        pay_currency: entry.id,
        ipn_callback_url: ipnCallbackUrl || process.env.NOWPAYMENTS_WEBHOOK_URL,
        order_id: orderId,
        order_description: 'MilesSpace wallet deposit',
        is_fixed_rate: false,
        is_fee_paid_by_user: false
    };

    let npResponse;
    try {
        npResponse = await axios.post(`${NOWPAYMENTS_API_BASE}/payment`, npPayload, {
            headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
            timeout: 15000
        });
    } catch (err) {
        const providerMsg = err.response?.data?.message || err.message || 'Payment creation failed';
        console.error('[CRYPTO] NowPayments create failed:', providerMsg);

        await supabaseAdmin
            .from('crypto_deposits')
            .update({
                status: 'failed',
                failure_reason: 'PROVIDER_CREATE_FAILED',
                updated_at: new Date().toISOString()
            })
            .eq('id', reserved.id);

        const lc = String(providerMsg).toLowerCase();
        if (lc.includes('less than minimal')) {
            const fresh = await getNowPaymentsMinimum(entry.id, { force: true });
            throw Object.assign(new Error(`Minimum deposit for ${entry.symbol} is $${fresh.minUsd}`), { code: 'AMOUNT_TOO_LOW', minUsd: fresh.minUsd });
        }
        if (lc.includes('not allowed') || lc.includes('invalid currency')) {
            throw Object.assign(new Error(`${entry.symbol} is not enabled on our account.`), { code: 'PAY_CURRENCY_NOT_SUPPORTED' });
        }
        throw Object.assign(new Error('Payment provider is temporarily unavailable.'), { code: 'PROVIDER_ERROR' });
    }

    const np = npResponse.data || {};
    const paymentId      = np.payment_id || np.id;
    const payAddress     = np.pay_address || np.address;
    const expectedCrypto = parseFloat(np.pay_amount) || 0;

    if (!paymentId || !payAddress) {
        await supabaseAdmin
            .from('crypto_deposits')
            .update({
                status: 'failed',
                failure_reason: 'PROVIDER_INCOMPLETE',
                updated_at: new Date().toISOString()
            })
            .eq('id', reserved.id);
        throw Object.assign(new Error('Payment provider returned an incomplete payment'), { code: 'PROVIDER_INCOMPLETE' });
    }

    const now = new Date();
    let expiresAt;
    if (np.expiration_estimate_date) {
        expiresAt = new Date(np.expiration_estimate_date);
    } else if (np.expiration_estimate) {
        expiresAt = new Date(now.getTime() + Number(np.expiration_estimate) * 1000);
    } else {
        expiresAt = new Date(now.getTime() + 20 * 60 * 1000);
    }

    const publicPayload = {
        paymentId: String(paymentId),
        payCurrency: entry.symbol,
        payCurrencyId: entry.id,
        payNetwork: chosenNetwork,
        payAmount: expectedCrypto.toFixed(8),
        payAddress,
        requestedAmount: requested.toFixed(2),
        currency: 'USD',
        expiresAt: expiresAt.toISOString(),
        orderId: orderId
    };

    const { data: updated, error: updErr } = await supabaseAdmin
        .from('crypto_deposits')
        .update({
            nowpayments_payment_id: String(paymentId),
            pay_address: payAddress,
            pay_amount: expectedCrypto,
            expected_crypto_amount: expectedCrypto,
            expires_at: expiresAt.toISOString(),
            status: 'pending',
            provider_payload: np,
            public_payload: publicPayload,
            updated_at: now.toISOString()
        })
        .eq('id', reserved.id)
        .select()
        .single();

    if (updErr) {
        // Row still exists with order_id + idempotency_key.
        // A reconciler can find it by order_id and complete the update.
        console.error('[CRYPTO] post-provider save failed:', updErr.message);
        return publicPayload;
    }

    await insertPendingTransactionRow(updated, expectedCrypto);

    return publicPayload;
}

async function insertPendingTransactionRow(deposit, _expectedCrypto) {
    const paymentId = String(deposit.nowpayments_payment_id || '');
    if (!paymentId) return;

    const requested = num(deposit.requested_usd || deposit.requested_amount);

    const meta = {
        provider: 'nowpayments',
        pay_currency: deposit.pay_currency,
        pay_network: deposit.pay_network,
        requested_amount: requested,
        idempotency_key: deposit.idempotency_key
    };

    const { error } = await supabaseAdmin.from('transactions').insert({
        user_id: deposit.user_id,
        type: 'deposit',
        category: 'credit',
        description: `Crypto deposit — ${deposit.pay_currency}`,
        currency: 'USD',
        status: 'pending',
        ref: `NP-PENDING-${paymentId}`,
        reference: `NP-PENDING-${paymentId}`,
        wallet_used: 'USD',
        amount: requested,
        amount_usd: requested,
        amount_ngn: 0,
        fee: 0,
        revenue_usd: 0,
        revenue_ngn: 0,
        meta,
        metadata: meta,
        created_at: new Date().toISOString()
    });
    if (error && error.code !== '23505') {
        console.warn('[CRYPTO] pending row insert failed:', error.message);
    }
}

function buildPublicPayload(deposit) {
    const catalog = COIN_CATALOG.find(c => c.id === deposit.pay_currency) || {};
    return {
        paymentId: String(deposit.nowpayments_payment_id || ''),
        payCurrency: catalog.symbol || deposit.pay_currency,
        payCurrencyId: deposit.pay_currency,
        payNetwork: deposit.pay_network || catalog.network || '',
        payAmount: Number(deposit.pay_amount || deposit.expected_crypto_amount || 0).toFixed(8),
        payAddress: deposit.pay_address,
        requestedAmount: Number(deposit.requested_usd || deposit.requested_amount).toFixed(2),
        currency: 'USD',
        expiresAt: deposit.expires_at,
        orderId: deposit.nowpayments_order_id
    };
}

function parseProviderPayment(p) {
    const status = String(p?.payment_status || p?.status || '').toLowerCase();
    const actuallyPaid = p?.actually_paid != null && p.actually_paid !== '' ? parseFloat(p.actually_paid) : null;
    const outcomeAmount = p?.outcome_amount != null && p.outcome_amount !== '' ? parseFloat(p.outcome_amount) : null;
    const outcomeCurrency = String(p?.outcome_currency || '').toUpperCase() || null;
    const priceAmount = p?.price_amount != null ? parseFloat(p.price_amount) : null;
    const priceCurrency = String(p?.price_currency || '').toUpperCase() || null;
    const payAmount = p?.pay_amount != null ? parseFloat(p.pay_amount) : null;

    return {
        status,
        actuallyPaid: Number.isFinite(actuallyPaid) ? actuallyPaid : null,
        outcomeAmount: Number.isFinite(outcomeAmount) ? outcomeAmount : null,
        outcomeCurrency,
        priceAmount: Number.isFinite(priceAmount) ? priceAmount : null,
        priceCurrency,
        payAmount: Number.isFinite(payAmount) ? payAmount : null,
        raw: p
    };
}

function decideCredit(deposit, parsed) {
    const walletCredit = num(deposit.requested_usd || deposit.requested_amount);
    const requiredUsd  = num(deposit.required_usd);

    if (walletCredit <= 0) {
        return { action: 'hold', reason: 'INVALID_WALLET_AMOUNT' };
    }

    let paidUsd = null;
    if (parsed.outcomeAmount != null && parsed.outcomeCurrency === 'USD') {
        paidUsd = parsed.outcomeAmount;
    } else if (parsed.priceAmount != null && parsed.priceCurrency === 'USD') {
        paidUsd = parsed.priceAmount;
    } else if (parsed.actuallyPaid != null && num(deposit.pay_amount) > 0) {
        const ratio = parsed.actuallyPaid / num(deposit.pay_amount);
        paidUsd = +(requiredUsd * ratio).toFixed(8);
    }

    if (paidUsd == null || !Number.isFinite(paidUsd) || paidUsd <= 0) {
        return { action: 'hold', reason: 'MISSING_ACTUAL_VALUE' };
    }

    const ratio = requiredUsd > 0 ? paidUsd / requiredUsd : 0;

    if (ratio > (1 + EXACT_BAND)) {
        return { action: 'credit', amountUsd: walletCredit, reason: 'OVERPAID_CREDIT_REQUESTED' };
    }
    if (ratio < (1 - EXACT_BAND)) {
        return { action: 'hold', reason: 'UNDERPAID' };
    }
    return { action: 'credit', amountUsd: walletCredit, reason: 'EXACT' };
}

// ─── VERIFY + COMPLETE ──────────────────────────────────
async function verifyAndComplete(paymentId, source = 'status') {
    if (!paymentId) return { completed: false, reason: 'MISSING_PAYMENT_ID' };

    // 1. Verify with NowPayments FIRST. Never trust a webhook's
    //    claimed status or amount.
    let provider;
    try {
        const { data } = await axios.get(`${NOWPAYMENTS_API_BASE}/payment/${paymentId}`, {
            headers: { 'x-api-key': NOWPAYMENTS_API_KEY },
            timeout: 10000
        });
        provider = data || {};
    } catch (err) {
        console.warn('[CRYPTO] provider fetch failed:', err.message);
        return { completed: false, reason: 'PROVIDER_FETCH_FAILED' };
    }

    if (String(provider.payment_id) !== String(paymentId)) {
        return { completed: false, reason: 'PROVIDER_MISMATCH' };
    }

    const parsed = parseProviderPayment(provider);

    // 2. Load the local deposit row.
    const { data: deposit, error } = await supabaseAdmin
        .from('crypto_deposits')
        .select('*')
        .eq('nowpayments_payment_id', String(paymentId))
        .maybeSingle();

    if (error) throw error;
    if (!deposit) return { completed: false, reason: 'DEPOSIT_NOT_FOUND' };

    if (deposit.status === 'completed') {
        return { completed: true, already_completed: true, reason: 'ALREADY_COMPLETED' };
    }

    // 3. Route non-terminal states.
    const nonSuccessStatuses = {
        failed: 'failed',
        refunded: 'failed',
        expired: 'expired',
        wrong_asset: 'manual_review',
        partially_paid: 'manual_review'
    };

    if (nonSuccessStatuses[parsed.status]) {
        const targetStatus = nonSuccessStatuses[parsed.status];
        const reason = parsed.status === 'partially_paid' ? 'UNDERPAID' : parsed.status.toUpperCase();
        await supabaseAdmin
            .from('crypto_deposits')
            .update({
                status: targetStatus,
                failure_reason: reason,
                actually_paid_crypto: parsed.actuallyPaid,
                actual_crypto_received: parsed.actuallyPaid,
                outcome_usd: parsed.outcomeAmount ?? null,
                provider_payload: provider,
                updated_at: new Date().toISOString()
            })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        await syncUserFacingTransaction(deposit, targetStatus, parsed);
        return { completed: false, reason };
    }

    if (parsed.status !== 'finished' && parsed.status !== 'confirmed') {
        await supabaseAdmin
            .from('crypto_deposits')
            .update({
                status: 'processing',
                provider_payload: provider,
                updated_at: new Date().toISOString()
            })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        return { completed: false, reason: `PROVIDER_${parsed.status.toUpperCase()}` };
    }

    // 4. Decide credit.
    const decision = decideCredit(deposit, parsed);

    if (decision.action === 'hold') {
        await supabaseAdmin
            .from('crypto_deposits')
            .update({
                status: 'manual_review',
                failure_reason: decision.reason,
                actually_paid_crypto: parsed.actuallyPaid,
                actual_crypto_received: parsed.actuallyPaid,
                outcome_usd: parsed.outcomeAmount ?? null,
                provider_payload: provider,
                updated_at: new Date().toISOString()
            })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        await syncUserFacingTransaction(deposit, 'manual_review', parsed);
        console.warn(`[CRYPTO] Held for review: ${paymentId} reason=${decision.reason}`);
        return { completed: false, reason: decision.reason };
    }

    const creditUsd = Number(decision.amountUsd);
    if (!Number.isFinite(creditUsd) || creditUsd <= 0) {
        console.error('[CRYPTO] refusing to credit — invalid amount', { paymentId, creditUsd });
        return { completed: false, reason: 'INVALID_CREDIT_AMOUNT' };
    }

    const reference = `NP-${paymentId}`;

    // 5. Ledger credit. Idempotent at the DB layer via unique
    //    transactions.reference. A second call with the same
    //    reference gets 23505 → returns existing row → we treat
    //    it as success.
    let ledgerResult;
    try {
        ledgerResult = await LedgerService.createTransaction({
            userId: deposit.user_id,
            type: 'deposit',
            amount: creditUsd,
            currency: 'USD',
            description: `Crypto deposit — ${deposit.pay_currency}`,
            reference,
            sourceType: 'crypto_deposit',
            sourceId: deposit.id,
            provider: 'nowpayments',
            providerReference: String(paymentId),
            metadata: {
                pay_currency: deposit.pay_currency,
                pay_network: deposit.pay_network,
                requested_usd: num(deposit.requested_usd || deposit.requested_amount),
                fee_percent: num(deposit.fee_percent || FEE_RATE_SINGLE),
                fee_usd: num(deposit.fee_usd || 0),
                required_usd: num(deposit.required_usd),
                credited_usd: creditUsd,
                decision_reason: decision.reason,
                actually_paid_crypto: parsed.actuallyPaid,
                outcome_usd: parsed.outcomeAmount,
                source
            },
            idempotencyKey: `crypto-deposit-${paymentId}`
        });
    } catch (ledgerErr) {
        console.error('[CRYPTO] LEDGER CREDIT FAILED:', { paymentId, creditUsd, error: ledgerErr.message });
        await supabaseAdmin
            .from('crypto_deposits')
            .update({
                status: 'pending',
                failure_reason: `LEDGER_CREDIT_FAILED: ${ledgerErr.message}`.slice(0, 500),
                updated_at: new Date().toISOString()
            })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        return { completed: false, reason: 'LEDGER_CREDIT_FAILED' };
    }

    if (!ledgerResult || (!ledgerResult.transaction_id && !ledgerResult.already_exists)) {
        await supabaseAdmin
            .from('crypto_deposits')
            .update({
                status: 'pending',
                failure_reason: 'LEDGER_NO_TRANSACTION_ID',
                updated_at: new Date().toISOString()
            })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        return { completed: false, reason: 'LEDGER_NO_TRANSACTION_ID' };
    }

    const nowIso = new Date().toISOString();

    // 6. Mark the deposit completed. Idempotent via neq('status','completed').
    await supabaseAdmin
        .from('crypto_deposits')
        .update({
            status: 'completed',
            credited_amount: creditUsd,
            ledger_transaction_id: ledgerResult.transaction_id || null,
            completed_at: nowIso,
            provider_payload: provider,
            actually_paid_crypto: parsed.actuallyPaid,
            actual_crypto_received: parsed.actuallyPaid,
            outcome_usd: parsed.outcomeAmount ?? creditUsd,
            updated_at: nowIso
        })
        .eq('id', deposit.id)
        .neq('status', 'completed');

    // 7. Flip the pending history row. If the ledger already wrote
    //    a final row (23505 on update), that's fine — history is
    //    done.
    await syncUserFacingTransaction(deposit, 'completed', parsed, {
        creditedUsd: creditUsd,
        ledgerTransactionId: ledgerResult.transaction_id || null,
        finalReference: reference
    });

    // 8. Notification + email, ONCE per deposit.
    await _notifyCryptoDepositOnce(deposit, creditUsd, nowIso);

    return { completed: true, creditedUsd: creditUsd, reason: decision.reason };
}

// ─── NOTIFY ONCE ───────────────────────────────────────
// Atomic claim on a `deposit_notified` boolean added to
// crypto_deposits. If the column doesn't exist yet, we fall back
// to sending once per call (email will dedupe at the transport
// layer if you configure an outbox — not required for v1).
async function _notifyCryptoDepositOnce(deposit, creditUsd, completedAtIso) {
    // Try to claim the notification slot.
    let claimed = false;
    try {
        const { data: updated, error } = await supabaseAdmin
            .from('crypto_deposits')
            .update({ deposit_notified: true })
            .eq('id', deposit.id)
            .eq('deposit_notified', false)
            .select('id');

        if (error) {
            // Column may not exist on older deployments. Fall back
            // to sending once (this call).
            if (error.code === '42703' || /deposit_notified/.test(error.message)) {
                claimed = true;
            } else {
                console.warn('[CRYPTO] notification claim failed:', error.message);
                return;
            }
        } else {
            claimed = Array.isArray(updated) && updated.length > 0;
        }
    } catch (e) {
        console.warn('[CRYPTO] notification claim threw:', e.message);
        return;
    }

    if (!claimed) return;

    try {
        await createNotification(
            deposit.user_id,
            '💰 Crypto deposit received',
            `Your USD wallet has been credited with $${creditUsd.toFixed(2)}.`,
            'success',
            '/fund'
        );
    } catch (notifyErr) {
        console.warn('[CRYPTO] notification error:', notifyErr.message);
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
                internalReference: `NP-${deposit.nowpayments_payment_id}`,
                sourceCurrency: deposit.pay_currency || 'CRYPTO',
                sourceAmount: num(deposit.pay_amount || deposit.actually_paid_crypto || 0),
                targetCurrency: 'USD',
                creditedAmount: creditUsd,
                fxRate: 1,
                fxSource: 'NOWPAYMENTS',
                completedAt: completedAtIso
            });
        }
    } catch (emailErr) {
        console.warn('[CRYPTO] email error:', emailErr.message);
    }
}

// ─── HISTORY SYNC ──────────────────────────────────────
// Reads the pending row by reference, updates it, or inserts a
// final row if none exists. Treats 23505 as success (ledger
// already wrote the final row).
async function syncUserFacingTransaction(deposit, status, parsed, extra = {}) {
    try {
        const paymentId = String(deposit.nowpayments_payment_id || '');
        if (!paymentId) return;

        const requested = num(deposit.requested_usd || deposit.requested_amount);
        const credited  = num(extra.creditedUsd || deposit.credited_amount || 0);
        const amount    = credited > 0 ? credited : requested;
        const nowIso    = new Date().toISOString();

        const meta = {
            provider: 'nowpayments',
            pay_currency: deposit.pay_currency,
            pay_network: deposit.pay_network || null,
            requested_amount: requested,
            credited_amount: credited || null,
            actually_paid_crypto: parsed?.actuallyPaid ?? null,
            outcome_usd: parsed?.outcomeAmount ?? null,
            ledger_transaction_id: extra.ledgerTransactionId || deposit.ledger_transaction_id || null,
            status_updated_at: nowIso
        };

        const pendingRef = `NP-PENDING-${paymentId}`;
        const finalRef = extra.finalReference || `NP-${paymentId}`;

        const { data: pendingRow, error: readErr } = await supabaseAdmin
            .from('transactions')
            .select('id')
            .eq('reference', pendingRef)
            .maybeSingle();

        if (readErr) {
            console.warn('[CRYPTO] pending row read failed:', readErr.message);
            return;
        }

        if (pendingRow) {
            const updateData = {
                status,
                amount,
                amount_usd: amount,
                meta,
                metadata: meta,
                updated_at: nowIso
            };
            if (status === 'completed') {
                updateData.ref = finalRef;
                updateData.reference = finalRef;
                updateData.completed_at = nowIso;
            } else if (status === 'failed') {
                updateData.failed_at = nowIso;
            }

            const { error: updErr } = await supabaseAdmin
                .from('transactions')
                .update(updateData)
                .eq('id', pendingRow.id);

            if (updErr && updErr.code !== '23505') {
                console.warn('[CRYPTO] syncUserFacingTransaction update failed:', updErr.message);
            }
            return;
        }

        const insertRef = status === 'completed' ? finalRef : pendingRef;
        const { error: insErr } = await supabaseAdmin.from('transactions').insert({
            user_id: deposit.user_id,
            type: 'deposit',
            category: 'credit',
            description: `Crypto deposit — ${deposit.pay_currency}`,
            currency: 'USD',
            status,
            ref: insertRef,
            reference: insertRef,
            wallet_used: 'USD',
            amount,
            amount_usd: amount,
            amount_ngn: 0,
            fee: 0,
            revenue_usd: 0,
            revenue_ngn: 0,
            meta,
            metadata: meta,
            created_at: nowIso,
            completed_at: status === 'completed' ? nowIso : null,
            failed_at: status === 'failed' ? nowIso : null
        });
        if (insErr && insErr.code !== '23505') {
            console.warn('[CRYPTO] syncUserFacingTransaction insert failed:', insErr.message);
        }
    } catch (e) {
        console.warn('[CRYPTO] syncUserFacingTransaction failed:', e.message);
    }
}

// ─── WEBHOOK SIGNATURE ─────────────────────────────────
function verifyWebhookSignature(rawBodyString, signatureHeader) {
    if (!NOWPAYMENTS_IPN_SECRET) return false;
    if (!signatureHeader) return false;
    try {
        const expected = crypto
            .createHmac('sha512', NOWPAYMENTS_IPN_SECRET)
            .update(rawBodyString)
            .digest('hex');
        const a = Buffer.from(expected, 'utf8');
        const b = Buffer.from(String(signatureHeader), 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

// ─── WEBHOOK EVENT PERSISTENCE ─────────────────────────
async function persistWebhookEvent({ provider, eventType, payload, signature, signatureValid }) {
    const eventHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const paymentId = payload?.payment_id || payload?.id || null;
    const orderId   = payload?.order_id || null;

    const { data, error } = await supabaseAdmin
        .from('provider_webhook_events')
        .insert({
            provider,
            event_type: eventType || null,
            event_hash: eventHash,
            payment_id: paymentId,
            order_id: orderId,
            payload,
            signature: signature || null,
            signature_valid: !!signatureValid,
            processing_status: 'received'
        })
        .select('id')
        .single();

    if (error) {
        if (error.code === '23505') {
            const { data: existing } = await supabaseAdmin
                .from('provider_webhook_events')
                .select('id, processing_status')
                .eq('provider', provider)
                .eq('event_hash', eventHash)
                .maybeSingle();
            return {
                duplicate: true,
                id: existing?.id || null,
                previousStatus: existing?.processing_status || null
            };
        }
        return { error: true, message: error.message };
    }
    return { id: data.id, duplicate: false };
}

async function markWebhookProcessed(id, { status, error }) {
    if (!id) return;
    try {
        await supabaseAdmin
            .from('provider_webhook_events')
            .update({
                processing_status: status,
                processing_error: error || null,
                processed_at: new Date().toISOString()
            })
            .eq('id', id);
    } catch {}
}

module.exports = {
    createCryptoDeposit,
    verifyAndComplete,
    verifyWebhookSignature,
    persistWebhookEvent,
    markWebhookProcessed,
    computeFeeAndRequired,
    getCoinCatalogWithMins,
    getNowPaymentsMinimum,
    FEE_RATE_SINGLE,
    MIN_USD,
    MAX_USD,
    COIN_CATALOG
};