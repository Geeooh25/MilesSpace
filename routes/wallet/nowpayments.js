// routes/wallet/nowpayments.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { authMiddleware } = require('../../middleware/auth');
const crypto = require('crypto');
const axios = require('axios');

const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;

// ─── Normalize a NowPayments payment object ───
function normalizePayment(raw, fallbackPayCurrency) {
    if (!raw) return null;
    return {
        id: raw.payment_id ?? raw.id ?? null,
        status: raw.payment_status ?? raw.status ?? null,
        address: raw.pay_address ?? raw.address ?? raw.payment_address ?? null,
        pay_amount: parseFloat(raw.pay_amount) || 0,
        pay_currency: raw.pay_currency || fallbackPayCurrency,
        price_amount: parseFloat(raw.price_amount) || 0,
        price_currency: raw.price_currency || 'USD',
        expiration_estimate: raw.expiration_estimate_date || raw.expiration_estimate || 3600,
        created_at: raw.created_at || null
    };
}

// ─── Helpers ───
async function createTransaction(userId, orderId, type, description, amountNGN, amountUSD, currency, status, ref, meta = {}) {
    const isUSD = currency === 'USD';
    let orderIdValue = null;
    if (orderId && typeof orderId === 'number' && Number.isInteger(orderId) && orderId > 0) {
        orderIdValue = orderId;
    }

    const transactionData = {
        user_id: userId,
        type: type,
        category: type === 'deposit' ? 'credit' : 'debit',
        description: description,
        currency: currency,
        status: status,
        ref: ref,
        wallet_used: currency,
        meta: meta,
        created_at: new Date().toISOString()
    };
    if (orderIdValue !== null) transactionData.order_id = orderIdValue;

    if (isUSD) {
        transactionData.amount_ngn = 0;
        transactionData.amount_usd = type === 'deposit' ? amountUSD : -amountUSD;
        transactionData.revenue_ngn = 0;
        transactionData.revenue_usd = type === 'deposit' ? amountUSD : 0;
    } else {
        transactionData.amount_ngn = type === 'deposit' ? amountNGN : -amountNGN;
        transactionData.amount_usd = 0;
        transactionData.revenue_ngn = type === 'deposit' ? amountNGN : 0;
        transactionData.revenue_usd = 0;
    }

    const { data, error } = await supabaseAdmin.from('transactions').insert(transactionData).select().single();
    if (error) { console.error('Transaction creation error:', error); return null; }
    return data;
}

async function createNotification(userId, title, message, type = 'info', link = null) {
    const { data, error } = await supabaseAdmin.from('notifications').insert({
        user_id: userId,
        title: title,
        message: message,
        type: type,
        icon: type === 'deposit_completed' ? '✅' : type === 'deposit_failed' ? '❌' : '📌',
        link: link,
        is_read: false,
        created_at: new Date().toISOString()
    }).select().single();
    if (error) console.error('Notification error:', error);
    return data;
}

function generateIdempotencyKey(userId, amount) {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(8).toString('hex');
    return `ik_${userId.slice(0, 8)}_${amount}_${timestamp}_${random}`;
}

// ─── GET MINIMUM AMOUNT FROM NOWPAYMENTS ───
async function getMinAmount(payCurrency, toCurrency = 'USD') {
    try {
        const response = await axios.get(
            `https://api.nowpayments.io/v1/min-amount?currency_from=${payCurrency}&currency_to=${toCurrency}&fiat_equivalent=${toCurrency}`,
            {
                headers: { 'x-api-key': NOWPAYMENTS_API_KEY },
                timeout: 5000
            }
        );
        // response.data.min_amount is in payCurrency, but we also have fiat_equivalent
        return {
            minAmount: parseFloat(response.data.min_amount) || 0,
            minFiat: parseFloat(response.data.fiat_equivalent) || 0
        };
    } catch (error) {
        console.warn('Failed to get min amount, using fallback:', error.message);
        // fallback for common coins
        const fallbacks = { LTC: 5, BTC: 20, ETH: 15, USDT: 10, TRX: 5, XRP: 5, BCH: 20, DOGE: 10, ADA: 15, SOL: 15 };
        return {
            minAmount: 0,
            minFiat: fallbacks[payCurrency] || 10
        };
    }
}

// ─── POST /api/wallet/nowpayments/deposit ───
router.post('/deposit', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { amount, currency = 'USD', pay_currency = 'LTC', ipn_callback_url, idempotency_key } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid amount' });
        }

        // ─── Get minimum amount for this currency ───
        const minInfo = await getMinAmount(pay_currency);
        if (amount < minInfo.minFiat) {
            return res.status(400).json({
                success: false,
                error: `Minimum deposit for ${pay_currency} is $${minInfo.minFiat.toFixed(2)}. Please increase your amount or choose a different coin (e.g., LTC or TRX have lower minimums).`
            });
        }

        const finalIdempotencyKey = idempotency_key || generateIdempotencyKey(userId, amount);

        // ── Check for existing deposit ──
        const { data: existingDeposit, error: findError } = await supabaseAdmin
            .from('deposit_requests')
            .select('*')
            .eq('idempotency_key', finalIdempotencyKey)
            .maybeSingle();

        if (findError && findError.code !== 'PGRST116') throw findError;

        if (existingDeposit && (existingDeposit.status === 'pending' || existingDeposit.status === 'completed')) {
            const providerData = existingDeposit.provider_data || {};
            const payId = providerData.payment_id || providerData.id || existingDeposit.provider_reference;
            const address = providerData.pay_address || providerData.address || null;
            return res.json({
                success: true,
                idempotent: true,
                data: {
                    id: payId,
                    address: address,
                    pay_amount: parseFloat(providerData.pay_amount) || 0,
                    pay_currency: providerData.pay_currency || pay_currency,
                    price_amount: parseFloat(providerData.price_amount) || amount,
                    price_currency: providerData.price_currency || 'USD',
                    expiration_estimate: providerData.expiration_estimate || 3600
                }
            });
        }

        // ── Get user profile ──
        const { data: profile, error: profileErr } = await supabaseAdmin
            .from('profiles')
            .select('email, username')
            .eq('id', userId)
            .single();
        if (profileErr || !profile) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // ── Create NowPayments payment ──
        const nowPaymentsPayload = {
            price_amount: amount,
            price_currency: currency,
            pay_currency: pay_currency,
            ipn_callback_url: ipn_callback_url || process.env.NOWPAYMENTS_WEBHOOK_URL,
            order_id: `DEP-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
            order_description: `MilesSpace Wallet Deposit - ${profile.email}`
        };

        let paymentResponse;
        try {
            paymentResponse = await axios.post(
                'https://api.nowpayments.io/v1/payment',
                nowPaymentsPayload,
                {
                    headers: {
                        'x-api-key': NOWPAYMENTS_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000
                }
            );
        } catch (paymentError) {
            let errMsg = paymentError.response?.data?.message || paymentError.message || 'Payment creation failed';
            console.error('Payment creation error:', errMsg);
            
            // Handle specific error: amount too small
            if (errMsg.toLowerCase().includes('less than minimal')) {
                // Try to get fresh min amount
                const freshMin = await getMinAmount(pay_currency);
                const minFiat = freshMin.minFiat || 5;
                errMsg = `The amount is too small for ${pay_currency}. Minimum is $${minFiat}. Please increase the amount or choose LTC/TRX.`;
            } else if (errMsg.toLowerCase().includes('not allowed') || errMsg.toLowerCase().includes('invalid currency')) {
                errMsg = `The currency "${pay_currency}" is not enabled for your account. Please use one of: BTC, ETH, LTC, USDTTRC20, XRP, etc.`;
            }
            return res.status(400).json({ success: false, error: errMsg });
        }

        const rawPayment = paymentResponse.data;
        console.log('🔎 RAW NowPayments payment object:', JSON.stringify(rawPayment, null, 2));

        // ── Extract fields ──
        const normalized = normalizePayment(rawPayment, pay_currency);
        if (!normalized || !normalized.id) {
            console.error('❌ No payment_id/id in NowPayments response:', rawPayment);
            return res.status(502).json({
                success: false,
                error: 'NowPayments did not return a payment ID. Please try again.'
            });
        }
        if (!normalized.address) {
            console.error('❌ No pay_address/address in NowPayments response:', rawPayment);
            return res.status(502).json({
                success: false,
                error: `No deposit address was returned for ${pay_currency}. This usually means the coin isn't enabled on your NowPayments account, or the amount is below its minimum. Try LTC or a larger amount.`
            });
        }

        // ── Save deposit request ──
        const { data: deposit, error: depError } = await supabaseAdmin
            .from('deposit_requests')
            .insert({
                user_id: userId,
                amount_usd: normalized.price_amount || amount,
                currency: 'USD',
                status: 'pending',
                provider: 'nowpayments',
                provider_reference: normalized.id,
                provider_data: rawPayment,
                idempotency_key: finalIdempotencyKey,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (depError) {
            console.error('Deposit request insert error:', depError);
            return res.status(500).json({ success: false, error: 'Failed to save deposit request' });
        }

        // ── Create pending transaction ──
        await createTransaction(
            userId,
            null,
            'deposit',
            `USD Deposit via NowPayments - ${normalized.id}`,
            0,
            normalized.price_amount || amount,
            'USD',
            'pending',
            normalized.id,
            { provider: 'nowpayments', payment_id: normalized.id, pay_currency: normalized.pay_currency }
        );

        // ── Return payment data ──
        res.json({
            success: true,
            data: {
                id: normalized.id,
                address: normalized.address,
                pay_amount: normalized.pay_amount,
                pay_currency: normalized.pay_currency,
                price_amount: normalized.price_amount || amount,
                price_currency: normalized.price_currency,
                expiration_estimate: normalized.expiration_estimate
            }
        });

    } catch (error) {
        console.error('NowPayments deposit error:', error);
        const msg = error.response?.data?.message || error.message || 'Payment creation failed';
        res.status(500).json({ success: false, error: msg });
    }
});

// ─── GET /api/wallet/nowpayments/status/:paymentId ───
router.get('/status/:paymentId', authMiddleware, async (req, res) => {
    try {
        const { paymentId } = req.params;

        // First check our local deposit_requests
        const { data: localDeposit, error: localErr } = await supabaseAdmin
            .from('deposit_requests')
            .select('*')
            .eq('provider_reference', paymentId)
            .maybeSingle();

        if (localDeposit) {
            const providerData = localDeposit.provider_data || {};
            const status = localDeposit.status;
            return res.json({
                success: true,
                data: {
                    id: paymentId,
                    status: status,
                    price_amount: localDeposit.amount_usd || 0,
                    price_currency: 'USD',
                    pay_amount: parseFloat(providerData.pay_amount) || 0,
                    pay_currency: providerData.pay_currency || 'LTC',
                    address: providerData.pay_address || providerData.address || null,
                    created_at: localDeposit.created_at
                }
            });
        }

        // If not in our DB, fetch from NowPayments
        const response = await axios.get(
            `https://api.nowpayments.io/v1/payment/${paymentId}`,
            { headers: { 'x-api-key': NOWPAYMENTS_API_KEY }, timeout: 10000 }
        );
        const rawPayment = response.data;
        const normalized = normalizePayment(rawPayment, 'LTC');

        // If payment is finished and not yet processed, we can auto-credit here
        // (this is a safety net, webhook should handle it)
        if (normalized.status === 'finished' || normalized.status === 'confirmed') {
            // Check if we have a deposit request in our DB
            const { data: deposit, error: depErr } = await supabaseAdmin
                .from('deposit_requests')
                .select('*')
                .eq('provider_reference', paymentId)
                .maybeSingle();

            if (deposit && deposit.status !== 'completed') {
                // Credit the user
                const { data: profile } = await supabaseAdmin
                    .from('profiles')
                    .select('wallet_usd')
                    .eq('id', deposit.user_id)
                    .single();
                if (profile) {
                    const newBalance = parseFloat(profile.wallet_usd || 0) + parseFloat(normalized.price_amount || 0);
                    await supabaseAdmin.from('profiles').update({ wallet_usd: newBalance }).eq('id', deposit.user_id);
                    await supabaseAdmin.from('deposit_requests').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', deposit.id);
                    await supabaseAdmin.from('transactions').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('ref', paymentId).eq('type', 'deposit');
                    await createNotification(deposit.user_id, 'Deposit Completed ✅', `Your deposit of $${normalized.price_amount} has been credited.`, 'deposit_completed', '/wallet');
                    if (global.invalidateDashboardCache) global.invalidateDashboardCache();
                }
            }
        }

        res.json({
            success: true,
            data: {
                id: normalized.id,
                status: normalized.status,
                price_amount: normalized.price_amount,
                price_currency: normalized.price_currency,
                pay_amount: normalized.pay_amount,
                pay_currency: normalized.pay_currency,
                created_at: normalized.created_at,
                address: normalized.address
            }
        });
    } catch (error) {
        console.error('Status check error:', error);
        if (error.response?.status === 404) {
            return res.status(404).json({ success: false, error: 'Payment not found' });
        }
        res.status(500).json({ success: false, error: error.response?.data?.message || error.message || 'Status check failed' });
    }
});

// ─── POST /api/wallet/nowpayments/webhook ───
router.post('/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-nowpayments-sig'];
        const body = req.body;

        if (NOWPAYMENTS_IPN_SECRET) {
            const sortedKeys = Object.keys(body).sort();
            const sortedParams = {};
            sortedKeys.forEach(key => { sortedParams[key] = body[key]; });
            const stringToSign = JSON.stringify(sortedParams);
            const computedSignature = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET).update(stringToSign).digest('hex');
            if (computedSignature !== signature) {
                console.error('Invalid webhook signature');
                return res.status(401).json({ error: 'Invalid signature' });
            }
        }

        console.log('📩 NowPayments webhook received:', body);
        const payment_id = body.payment_id ?? body.id;
        const payment_status = body.payment_status ?? body.status;
        const price_amount = body.price_amount;

        const { data: existingDeposit, error: findErr } = await supabaseAdmin
            .from('deposit_requests')
            .select('status')
            .eq('provider_reference', payment_id)
            .maybeSingle();

        if (findErr) {
            console.error('Webhook DB error:', findErr);
            return res.status(500).json({ error: 'Database error' });
        }

        if (existingDeposit && existingDeposit.status === 'completed') {
            console.log(`Payment ${payment_id} already processed, ignoring webhook.`);
            return res.status(200).json({ success: true, message: 'Already processed' });
        }

        if (payment_status === 'finished' || payment_status === 'confirmed') {
            const { data: deposit, error: depErr } = await supabaseAdmin
                .from('deposit_requests')
                .select('*')
                .eq('provider_reference', payment_id)
                .single();

            if (depErr) {
                console.error('Webhook deposit fetch error:', depErr);
                return res.status(500).json({ error: 'Deposit not found' });
            }

            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('wallet_usd')
                .eq('id', deposit.user_id)
                .single();

            if (!profile) {
                console.error('User not found for deposit', deposit.user_id);
                return res.status(500).json({ error: 'User not found' });
            }

            const amount = parseFloat(price_amount) || parseFloat(deposit.amount_usd) || 0;
            const newBalance = parseFloat(profile.wallet_usd || 0) + amount;
            await supabaseAdmin.from('profiles').update({ wallet_usd: newBalance }).eq('id', deposit.user_id);
            await supabaseAdmin.from('deposit_requests').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', deposit.id);
            await supabaseAdmin.from('transactions').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('ref', payment_id).eq('type', 'deposit');
            await createNotification(deposit.user_id, 'Deposit Completed ✅', `Your deposit of $${amount.toFixed(2)} has been credited.`, 'deposit_completed', '/wallet');
            if (global.invalidateDashboardCache) global.invalidateDashboardCache();

            console.log(`✅ Deposit ${payment_id} processed for user ${deposit.user_id}`);
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ─── GET /api/wallet/nowpayments/coins ───
router.get('/coins', authMiddleware, async (req, res) => {
    try {
        const response = await axios.get(
            'https://api.nowpayments.io/v1/merchant/coins',
            {
                headers: { 'x-api-key': NOWPAYMENTS_API_KEY },
                timeout: 10000
            }
        );
        const coins = response.data.currencies || [];
        res.json({
            success: true,
            coins: coins
        });
    } catch (error) {
        console.error('Error fetching coins:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch coins' });
    }
});

module.exports = router;