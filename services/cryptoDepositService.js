// services/cryptoDepositService.js
// Crypto deposits via NowPayments.
//
// Business rule (gross-up):
//   Customer requests $5.00 USD wallet credit.
//   Provider fee = 1% of $5.00.
//   Provider must receive: 5.00 / (1 - 0.01) = $5.05050505
//   Wallet gets $5.00 on successful payment.
//
// The fee is an INTERNAL MilesSpace/treasury concept. It is never
// surfaced to the frontend.
//
// Partial payments → manual_review. Never auto-credit less.
// Overpayments → credit the customer's locked requested amount.
// Surplus retained on the deposit row for accounting.

const crypto = require('crypto');
const axios = require('axios');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const { createNotification } = require('./notificationService');
const emailService = require('./emailService');

const NOWPAYMENTS_API_KEY    = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_API_BASE   = 'https://api.nowpayments.io/v1';
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;

// ─── Fee configuration ────────────────────────────────────
const FEE_RATE_SINGLE   = Number(process.env.NOWPAYMENTS_DEPOSIT_FEE_RATE || 0.01);
const FEE_RATE_AUTOCONV = Number(process.env.NOWPAYMENTS_DEPOSIT_FEE_RATE_AUTOCONVERT || 0.015);

const MIN_USD = Number(process.env.CRYPTO_MIN_USD || 5);
const MAX_USD = Number(process.env.CRYPTO_MAX_USD || 100000);

const EXACT_BAND = 0.02; // ±2% tolerance

// Curated catalog.
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

// ─── Minimum cache ────────────────────────────────────────
const _minCache = new Map();
const MIN_CACHE_MS = 60 * 1000;

// ─── MATH ─────────────────────────────────────────────────
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

// ─── CATALOG + MINIMUM ────────────────────────────────────
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
            id: c.id,
            symbol: c.symbol,
            label: c.label,
            network: c.network,
            networks: c.networks,
            minUsd
        });
    }
    return coins;
}

// ─── CREATE DEPOSIT ───────────────────────────────────────
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

    // ─── 1. Basic validation ───────────────────────────────
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

    // ─── 2. Effective minimum (MilesSpace vs provider) ─────
    const { minUsd } = await getNowPaymentsMinimum(entry.id);
    if (requested < minUsd) {
        throw Object.assign(new Error(`Minimum deposit for ${entry.symbol} is $${minUsd}`), { code: 'AMOUNT_TOO_LOW', minUsd });
    }

    // ─── 3. Gross-up fee ───────────────────────────────────
    const { requiredUsd, feeUsd, feeRate } = computeFeeAndRequired(requested, paymentType);

    // ─── 4. Idempotency ────────────────────────────────────
    const finalIk = idempotencyKey || `cik_${userId.slice(0,8)}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

    const { data: existing } = await supabaseAdmin
        .from('crypto_deposits')
        .select('*')
        .eq('user_id', userId)
        .eq('idempotency_key', finalIk)
        .maybeSingle();

    if (existing) {
        if (['pending', 'processing', 'completed'].includes(existing.status)) {
            return existing.public_payload || buildPublicPayload(existing);
        }
    }

    // ─── 5. User lookup ────────────────────────────────────
    const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('email, username')
        .eq('id', userId)
        .single();
    if (!profile) {
        throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });
    }

    // ─── 6. Provider call ──────────────────────────────────
    const npPayload = {
        price_amount: requiredUsd,
        price_currency: 'USD',
        pay_currency: entry.id,
        ipn_callback_url: ipnCallbackUrl || process.env.NOWPAYMENTS_WEBHOOK_URL,
        order_id: `MSCR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
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
        throw Object.assign(new Error('Payment provider returned an incomplete payment'), { code: 'PROVIDER_INCOMPLETE' });
    }

    // ─── 7. Expiration ─────────────────────────────────────
    const now = new Date();
    let expiresAt;
    if (np.expiration_estimate_date) {
        expiresAt = new Date(np.expiration_estimate_date);
    } else if (np.expiration_estimate) {
        expiresAt = new Date(now.getTime() + Number(np.expiration_estimate) * 1000);
    } else {
        expiresAt = new Date(now.getTime() + 20 * 60 * 1000);
    }

    // ─── 8. Public payload ─────────────────────────────────
    const publicPayload = {
        paymentId,
        payCurrency: entry.symbol,
        payCurrencyId: entry.id,
        payNetwork: chosenNetwork,
        payAmount: expectedCrypto.toFixed(8),
        payAddress,
        requestedAmount: requested.toFixed(2),
        currency: 'USD',
        expiresAt: expiresAt.toISOString(),
        orderId: npPayload.order_id
    };

    // ─── 9. Persist internal record ────────────────────────
    const { data: deposit, error: depErr } = await supabaseAdmin
        .from('crypto_deposits')
        .insert({
            user_id: userId,

            // Canonical fields
            requested_usd:        requested,
            fee_percent:          feeRate,
            fee_usd:              feeUsd,
            required_usd:         requiredUsd,
            wallet_credit_usd:    requested,
            pay_amount:           expectedCrypto,
            pay_currency:         entry.id,
            pay_network:          chosenNetwork,
            pay_address:          payAddress,
            nowpayments_payment_id: String(paymentId),
            nowpayments_order_id:   npPayload.order_id,
            status: 'pending',
            expires_at: expiresAt.toISOString(),
            idempotency_key: finalIk,
            provider_payload: np,
            public_payload: publicPayload,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),

            // Legacy mirrors
            requested_amount: requested,
            requested_currency: 'USD',
            gross_amount: requiredUsd,
            expected_crypto_amount: expectedCrypto
        })
        .select()
        .single();

    if (depErr) {
        if (depErr.code === '23505') {
            const { data: dup } = await supabaseAdmin
                .from('crypto_deposits')
                .select('*')
                .eq('nowpayments_payment_id', String(paymentId))
                .maybeSingle();
            if (dup) return dup.public_payload || buildPublicPayload(dup);
        }
        throw Object.assign(new Error('Failed to save deposit'), { code: 'DB_ERROR' });
    }

    // ─── 10. Pending transaction row (read model) ──────────
    // Show the requested amount immediately so the user sees a
    // meaningful row while the payment is pending.
    try {
        const meta = {
            provider: 'nowpayments',
            pay_currency: entry.id,
            pay_network: chosenNetwork,
            requested_amount: requested,
            idempotency_key: finalIk
        };

        await supabaseAdmin.from('transactions').insert({
            user_id: userId,
            type: 'deposit',
            category: 'credit',
            description: `Crypto deposit — ${entry.symbol}`,
            currency: 'USD',
            status: 'pending',
            ref: String(paymentId),
            reference: String(paymentId),
            wallet_used: 'USD',
            amount: requested,
            amount_usd: requested,
            amount_ngn: 0,
            fee: 0,
            revenue_usd: 0,
            revenue_ngn: 0,
            meta,
            metadata: meta,
            created_at: now.toISOString()
        });
    } catch (e) {
        console.warn('[CRYPTO] pending transaction insert failed (non-fatal):', e.message);
    }

    return publicPayload;
}

function buildPublicPayload(deposit) {
    const catalog = COIN_CATALOG.find(c => c.id === deposit.pay_currency) || {};
    return {
        paymentId: deposit.nowpayments_payment_id,
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

// ─── PARSE PROVIDER PAYMENT ───────────────────────────────
function parseProviderPayment(p) {
    const status = String(p?.payment_status || p?.status || '').toLowerCase();

    const actuallyPaid = p?.actually_paid != null && p.actually_paid !== ''
        ? parseFloat(p.actually_paid) : null;

    const outcomeAmount = p?.outcome_amount != null && p.outcome_amount !== ''
        ? parseFloat(p.outcome_amount) : null;
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

// ─── DECIDE CREDIT ────────────────────────────────────────
function decideCredit(deposit, parsed) {
    const walletCredit = num(deposit.wallet_credit_usd || deposit.requested_usd || deposit.requested_amount);
    const requiredUsd  = num(deposit.required_usd || deposit.gross_amount);

    let paidUsd = null;
    if (parsed.outcomeAmount != null && parsed.outcomeCurrency === 'USD') paidUsd = parsed.outcomeAmount;
    else if (parsed.priceAmount != null && parsed.priceCurrency === 'USD') paidUsd = parsed.priceAmount;

    if (paidUsd == null && parsed.actuallyPaid != null && num(deposit.pay_amount) > 0) {
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

// ─── VERIFY + COMPLETE ────────────────────────────────────
async function verifyAndComplete(paymentId, source = 'status') {
    if (!paymentId) return { completed: false, reason: 'MISSING_PAYMENT_ID' };

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

    let provider;
    try {
        const { data } = await axios.get(`${NOWPAYMENTS_API_BASE}/payment/${paymentId}`, {
            headers: { 'x-api-key': NOWPAYMENTS_API_KEY },
            timeout: 10000
        });
        provider = data || {};
    } catch (err) {
        return { completed: false, reason: 'PROVIDER_FETCH_FAILED' };
    }

    const parsed = parseProviderPayment(provider);

    if (parsed.status === 'failed' || parsed.status === 'refunded') {
        await supabaseAdmin
            .from('crypto_deposits')
            .update({ status: parsed.status, failure_reason: parsed.status.toUpperCase(), provider_payload: provider, updated_at: new Date().toISOString() })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        await syncUserFacingTransaction(deposit, 'failed', parsed);
        return { completed: false, reason: parsed.status.toUpperCase() };
    }

    if (parsed.status === 'expired') {
        await supabaseAdmin
            .from('crypto_deposits')
            .update({ status: 'expired', provider_payload: provider, updated_at: new Date().toISOString() })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        await syncUserFacingTransaction(deposit, 'expired', parsed);
        return { completed: false, reason: 'EXPIRED' };
    }

    if (parsed.status === 'wrong_asset') {
        await supabaseAdmin
            .from('crypto_deposits')
            .update({ status: 'manual_review', failure_reason: 'WRONG_ASSET', provider_payload: provider, updated_at: new Date().toISOString() })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        await syncUserFacingTransaction(deposit, 'manual_review', parsed);
        return { completed: false, reason: 'WRONG_ASSET' };
    }

    if (parsed.status === 'partially_paid') {
        await supabaseAdmin
            .from('crypto_deposits')
            .update({
                status: 'partially_paid',
                actually_paid_crypto: parsed.actuallyPaid,
                outcome_usd: parsed.outcomeAmount ?? null,
                failure_reason: 'UNDERPAID',
                provider_payload: provider,
                updated_at: new Date().toISOString()
            })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        await syncUserFacingTransaction(deposit, 'partially_paid', parsed);
        return { completed: false, reason: 'PARTIALLY_PAID' };
    }

    if (parsed.status !== 'finished' && parsed.status !== 'confirmed') {
        await supabaseAdmin
            .from('crypto_deposits')
            .update({ status: 'processing', provider_payload: provider, updated_at: new Date().toISOString() })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        return { completed: false, reason: `PROVIDER_${parsed.status.toUpperCase()}` };
    }

    const decision = decideCredit(deposit, parsed);

    if (decision.action === 'hold') {
        await supabaseAdmin
            .from('crypto_deposits')
            .update({
                status: 'manual_review',
                failure_reason: decision.reason,
                actually_paid_crypto: parsed.actuallyPaid,
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

    const creditUsd = decision.amountUsd;

    try {
        const result = await LedgerService.createTransaction({
            userId: deposit.user_id,
            type: 'deposit',
            amount: creditUsd,
            currency: 'USD',
            description: `Crypto deposit — ${deposit.pay_currency}`,
            reference: `CRYPTO-${paymentId}`,
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
                required_usd: num(deposit.required_usd || deposit.gross_amount),
                credited_usd: creditUsd,
                decision_reason: decision.reason,
                actually_paid_crypto: parsed.actuallyPaid,
                outcome_usd: parsed.outcomeAmount,
                source
            },
            idempotencyKey: `crypto-deposit-${paymentId}`
        });

        const nowIso = new Date().toISOString();

        await supabaseAdmin
            .from('crypto_deposits')
            .update({
                status: 'completed',
                credited_amount: creditUsd,
                ledger_transaction_id: result?.transaction_id || null,
                completed_at: nowIso,
                provider_payload: provider,
                actually_paid_crypto: parsed.actuallyPaid,
                outcome_usd: parsed.outcomeAmount ?? creditUsd,
                updated_at: nowIso
            })
            .eq('id', deposit.id)
            .neq('status', 'completed');

        // Flip the user-facing transaction row to completed.
        await syncUserFacingTransaction(deposit, 'completed', parsed, {
            creditedUsd: creditUsd,
            ledgerTransactionId: result?.transaction_id || null
        });

        try {
            await createNotification(
                deposit.user_id,
                '💰 Crypto deposit received',
                `Your USD wallet has been credited with $${creditUsd.toFixed(2)}.`,
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
                    creditUsd,
                    'USD',
                    `CRYPTO-${paymentId}`,
                    `Crypto deposit (${deposit.pay_currency}) via NowPayments`
                );
            }
        } catch (notifyErr) {
            console.warn('[CRYPTO] post-credit notification error:', notifyErr.message);
        }

        return { completed: true, creditedUsd: creditUsd, reason: decision.reason };
    } catch (ledgerErr) {
        console.error('[CRYPTO] ledger credit failed:', ledgerErr.message);
        await supabaseAdmin
            .from('crypto_deposits')
            .update({ status: 'processing', failure_reason: 'LEDGER_CREDIT_FAILED', updated_at: new Date().toISOString() })
            .eq('id', deposit.id)
            .neq('status', 'completed');
        return { completed: false, reason: 'LEDGER_CREDIT_FAILED' };
    }
}

// ─── SYNC USER-FACING TRANSACTION ROW ─────────────────────
// Guarantees the transaction history shows the correct amount and
// status for every crypto deposit, regardless of provider outcome.
async function syncUserFacingTransaction(deposit, status, parsed, extra = {}) {
    try {
        const paymentId = deposit.nowpayments_payment_id;
        const requested = num(deposit.requested_usd || deposit.requested_amount);
        const credited  = num(extra.creditedUsd || deposit.credited_amount || 0);

        const amount = credited > 0 ? credited : requested;
        const nowIso = new Date().toISOString();

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

        const updateData = {
            status,
            amount,
            amount_usd: amount,
            meta,
            metadata: meta,
            updated_at: nowIso
        };

        if (status === 'completed') {
            updateData.completed_at = nowIso;
        } else if (status === 'failed') {
            updateData.failed_at = nowIso;
        } else if (status === 'cancelled') {
            updateData.cancelled_at = nowIso;
        }

        // Update by ref OR reference so we catch rows written by either
        // older or newer code paths.
        await supabaseAdmin
            .from('transactions')
            .update(updateData)
            .or(`ref.eq.${String(paymentId)},reference.eq.${String(paymentId)}`)
            .eq('type', 'deposit')
            .neq('status', status); // no-op if already in target state
    } catch (e) {
        console.warn('[CRYPTO] syncUserFacingTransaction failed:', e.message);
    }
}

// ─── WEBHOOK SIGNATURE ────────────────────────────────────
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
    } catch (e) {
        return false;
    }
}

// ─── WEBHOOK EVENT PERSISTENCE ────────────────────────────
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
        .select()
        .single();

    if (error) {
        if (error.code === '23505') return { duplicate: true };
        return { error: true };
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
    } catch (e) {}
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