// routes/wallet/nowpayments.js
// Thin HTTP layer over cryptoDepositService.

const express = require('express');
const router  = express.Router();
const axios   = require('axios');

const { authMiddleware } = require('../../middleware/auth');
const cryptoDepositService = require('../../services/cryptoDepositService');

const NOWPAYMENTS_API_KEY  = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_API_BASE = 'https://api.nowpayments.io/v1';

// ────────────────────────────────────────────────────────────
// POST /api/wallet/nowpayments/deposit
// Body: { amount, currency, payCurrency, network?, idempotencyKey? }
// Returns ONLY what the user needs to send the crypto.
// ────────────────────────────────────────────────────────────
router.post('/deposit', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            amount,
            currency = 'USD',
            payCurrency,
            pay_currency,
            network,
            idempotencyKey,
            idempotency_key
        } = req.body || {};

        const selectedPay = payCurrency || pay_currency;

        if (!amount || !selectedPay) {
            return res.status(400).json({
                success: false,
                code: 'MISSING_FIELDS',
                error: 'Amount and cryptocurrency are required.'
            });
        }
        if (String(currency).toUpperCase() !== 'USD') {
            return res.status(400).json({
                success: false,
                code: 'UNSUPPORTED_CURRENCY',
                error: 'Only USD is supported for crypto deposits.'
            });
        }

        const publicPayload = await cryptoDepositService.createCryptoDeposit({
            userId,
            requestedAmountUsd: amount,
            payCurrency: selectedPay,
            network: network || undefined,
            idempotencyKey: idempotencyKey || idempotency_key,
            ipnCallbackUrl: process.env.NOWPAYMENTS_WEBHOOK_URL,
            paymentType: 'single'
        });

        return res.json({
            success: true,
            data: {
                paymentId:       publicPayload.paymentId,
                payCurrency:     publicPayload.payCurrency,
                payCurrencyId:   publicPayload.payCurrencyId,
                payNetwork:      publicPayload.payNetwork,
                payAmount:       publicPayload.payAmount,
                payAddress:      publicPayload.payAddress,
                requestedAmount: publicPayload.requestedAmount,
                currency:        publicPayload.currency,
                expiresAt:       publicPayload.expiresAt
            }
        });
    } catch (err) {
        console.error('[CRYPTO] deposit route error:', err.code || '', err.message);

        const code   = err.code || 'SERVER_ERROR';
        const status =
            ['INVALID_AMOUNT','AMOUNT_TOO_LOW','AMOUNT_TOO_HIGH','UNSUPPORTED_CURRENCY',
             'MISSING_PAY_CURRENCY','PAY_CURRENCY_NOT_SUPPORTED','NETWORK_NOT_SUPPORTED']
                .includes(code) ? 400 : 500;

        let message = 'Could not start deposit. Please try again.';
        if (code === 'AMOUNT_TOO_LOW')             message = err.message;
        if (code === 'AMOUNT_TOO_HIGH')            message = err.message;
        if (code === 'INVALID_AMOUNT')             message = 'Please enter a valid amount.';
        if (code === 'PAY_CURRENCY_NOT_SUPPORTED') message = err.message;
        if (code === 'NETWORK_NOT_SUPPORTED')      message = err.message;
        if (code === 'PROVIDER_ERROR' || code === 'PROVIDER_INCOMPLETE')
            message = 'Payment provider is temporarily unavailable. Please try again.';

        return res.status(status).json({ success: false, code, error: message });
    }
});

// ────────────────────────────────────────────────────────────
// GET /api/wallet/nowpayments/status/:paymentId
// The frontend polls this. It verifies with the provider and,
// when final, credits the wallet.
// ────────────────────────────────────────────────────────────
router.get('/status/:paymentId', authMiddleware, async (req, res) => {
    try {
        const { paymentId } = req.params;
        const userId = req.user.id;

        const { data: dep } = await require('../../db/supabase').supabaseAdmin
            .from('crypto_deposits')
            .select('user_id, status, requested_usd, requested_amount, requested_currency, pay_currency, pay_address, expires_at, credited_amount')
            .eq('nowpayments_payment_id', String(paymentId))
            .maybeSingle();

        if (!dep) return res.status(404).json({ success: false, error: 'Payment not found' });
        if (dep.user_id !== userId) return res.status(403).json({ success: false, error: 'Not your payment' });

        if (dep.status !== 'completed' && dep.status !== 'manual_review' && dep.status !== 'expired') {
            try { await cryptoDepositService.verifyAndComplete(paymentId, 'status'); }
            catch (e) { console.warn('[CRYPTO] status verify error:', e.message); }
        }

        const { data: fresh } = await require('../../db/supabase').supabaseAdmin
            .from('crypto_deposits')
            .select('status, requested_usd, requested_amount, requested_currency, pay_currency, pay_address, expires_at, credited_amount')
            .eq('nowpayments_payment_id', String(paymentId))
            .maybeSingle();

        return res.json({
            success: true,
            data: {
                paymentId,
                status: fresh?.status || dep.status,
                requestedAmount: Number(fresh?.requested_usd ?? fresh?.requested_amount ?? dep.requested_usd ?? dep.requested_amount ?? 0).toFixed(2),
                currency: fresh?.requested_currency || 'USD',
                payCurrency: fresh?.pay_currency || dep.pay_currency,
                payAddress: fresh?.pay_address || dep.pay_address,
                expiresAt: fresh?.expires_at || dep.expires_at,
                creditedAmount: fresh?.credited_amount != null
                    ? Number(fresh.credited_amount).toFixed(2) : null
            }
        });
    } catch (err) {
        console.error('[CRYPTO] status route error:', err.message);
        return res.status(500).json({ success: false, error: 'Status check failed' });
    }
});

// ────────────────────────────────────────────────────────────
// POST /api/wallet/nowpayments/webhook
// NowPayments IPN. Signature verified. Idempotent.
// ────────────────────────────────────────────────────────────
router.post('/webhook', express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}), async (req, res) => {
    // Acknowledge immediately so retries don't pile up.
    res.status(200).json({ received: true });

    let eventRowId = null;
    try {
        const signature = req.headers['x-nowpayments-sig'];
        const rawBody   = req.rawBody || JSON.stringify(req.body || {});

        const valid = cryptoDepositService.verifyWebhookSignature(rawBody, signature);

        const persisted = await cryptoDepositService.persistWebhookEvent({
            provider: 'nowpayments',
            eventType: req.body?.payment_status || req.body?.status || null,
            payload: req.body || {},
            signature: signature || null,
            signatureValid: valid
        });

        if (persisted.duplicate) {
            // Same event already received. Nothing to do.
            return;
        }
        if (persisted.error) {
            console.warn('[CRYPTO] webhook persist failed');
        } else {
            eventRowId = persisted.id;
        }

        if (!valid) {
            console.warn('[CRYPTO] webhook signature invalid — ignoring');
            await cryptoDepositService.markWebhookProcessed(eventRowId, {
                status: 'failed',
                error: 'INVALID_SIGNATURE'
            });
            return;
        }

        const paymentId = req.body?.payment_id || req.body?.id;
        if (!paymentId) {
            await cryptoDepositService.markWebhookProcessed(eventRowId, {
                status: 'failed',
                error: 'MISSING_PAYMENT_ID'
            });
            return;
        }

        const result = await cryptoDepositService.verifyAndComplete(paymentId, 'webhook');
        console.log('[CRYPTO] webhook processed:', paymentId, result);

        await cryptoDepositService.markWebhookProcessed(eventRowId, {
            status: result.completed ? 'processed' : 'failed',
            error: result.completed ? null : (result.reason || null)
        });
    } catch (e) {
        console.error('[CRYPTO] webhook handler error:', e.message);
        try {
            await cryptoDepositService.markWebhookProcessed(eventRowId, {
                status: 'failed',
                error: e.message
            });
        } catch {}
    }
});

// ────────────────────────────────────────────────────────────
// GET /api/wallet/nowpayments/coins
// Returns the coin catalog with live minimums.
// ────────────────────────────────────────────────────────────
router.get('/coins', authMiddleware, async (req, res) => {
    try {
        const coins = await cryptoDepositService.getCoinCatalogWithMins();
        return res.json({ success: true, coins });
    } catch (err) {
        console.warn('[CRYPTO] coins fetch error:', err.message);
        return res.json({
            success: true,
            coins: cryptoDepositService.COIN_CATALOG.map(c => ({
                id: c.id,
                symbol: c.symbol,
                label: c.label,
                network: c.network,
                networks: c.networks,
                minUsd: cryptoDepositService.MIN_USD
            }))
        });
    }
});

module.exports = router;