// routes/wallet/koraDeposits.js
//
// Kora deposit lifecycle.
//   NGN → NGN wallet (flat fee).
//   Foreign currency → USD wallet at admin rate snapshot.

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { supabaseAdmin } = require('../../db/supabase');
const { authMiddleware } = require('../../middleware/auth');
const IdempotencyService = require('../../services/idempotencyService');
const korapayService     = require('../../services/korapayService');
const fxService          = require('../../services/fxRateService');
const depositService     = require('../../services/depositService');

// ─── GET /api/wallet/deposit-currencies ────────────────────
router.get('/deposit-currencies', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('deposit_currencies')
            .select('*')
            .order('code', { ascending: true });

        if (error) throw error;

        const all = (data || []).map(c => ({
            code: c.code,
            display_name: c.display_name,
            symbol: c.symbol,
            country: c.country,
            enabled: !!c.is_enabled,
            min_amount: Number(c.min_amount),
            max_amount: Number(c.max_amount),
            wallet_currency: c.wallet_currency,
            customer_rate: c.customer_rate != null ? Number(c.customer_rate) : null,
            rate_type: c.rate_type,
            deposit_fee_type: c.deposit_fee_type,
            deposit_fee: Number(c.deposit_fee || 0),
            minor_unit: Number(c.minor_unit || 2)
        }));

        return res.json({
            success: true,
            default_currency: 'NGN',
            currencies: all.filter(c => c.enabled),
            all_currencies: all
        });
    } catch (e) {
        console.error('[DEPOSIT] currencies error:', e.message);
        return res.status(500).json({ success: false, error: 'Failed to load currencies' });
    }
});

// ─── POST /api/wallet/deposits/quote ───────────────────────
router.post('/deposits/quote', authMiddleware, async (req, res) => {
    try {
        const { currency, amount } = req.body || {};
        if (!currency || amount == null) {
            return res.status(400).json({ success: false, error: 'currency and amount required', code: 'MISSING_FIELDS' });
        }

        const cfg = await fxService.getCurrencyConfig(currency);
        const amtNum = Number(amount);

        if (!Number.isFinite(amtNum) || amtNum <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid amount', code: 'INVALID_AMOUNT' });
        }
        if (amtNum < Number(cfg.min_amount)) {
            return res.status(400).json({ success: false, error: `Minimum deposit for ${currency} is ${cfg.min_amount}`, code: 'AMOUNT_TOO_LOW' });
        }
        if (amtNum > Number(cfg.max_amount)) {
            return res.status(400).json({ success: false, error: `Maximum deposit for ${currency} is ${cfg.max_amount}`, code: 'AMOUNT_TOO_HIGH' });
        }

        const b = fxService.computeDepositBreakdown(cfg, amtNum);

        return res.json({
            success: true,
            data: {
                payment_currency: b.payment_currency,
                payment_amount:   b.payment_amount.toFixed(2),
                wallet_currency:  b.wallet_currency,
                wallet_amount:    b.wallet_amount.toFixed(2),
                customer_rate:    b.customer_rate != null ? String(b.customer_rate) : null,
                fee_amount:       b.fee_amount,
                fee_currency:     b.fee_currency,
                rate_type:        b.rate_type,
                rate_source:      b.rate_source
            }
        });
    } catch (e) {
        const code = e.code || 'QUOTE_FAILED';
        const status = ['UNSUPPORTED_CURRENCY','INVALID_AMOUNT','AMOUNT_TOO_LOW','AMOUNT_TOO_HIGH','CURRENCY_MISCONFIGURED'].includes(code) ? 400
                     : code === 'FX_RATE_UNAVAILABLE' ? 503 : 500;
        return res.status(status).json({ success: false, error: e.message, code });
    }
});

// ─── POST /api/wallet/deposits/kora/initialize ─────────────
router.post('/deposits/kora/initialize', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { currency, amount, idempotency_key } = req.body || {};

        if (!currency || amount == null) {
            return res.status(400).json({ success: false, error: 'currency and amount required', code: 'MISSING_FIELDS' });
        }
        if (!idempotency_key) {
            return res.status(400).json({ success: false, error: 'idempotency_key required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
        }

        const fingerprint = IdempotencyService.fingerprint
            ? IdempotencyService.fingerprint({ currency: String(currency).toUpperCase(), amount: Number(amount) })
            : crypto.createHash('sha256')
                .update(JSON.stringify({ currency: String(currency).toUpperCase(), amount: Number(amount) }))
                .digest('hex');

        try {
            const existing = await IdempotencyService.check(
                userId, idempotency_key, 'kora_deposit_initialize', fingerprint
            );
            if (existing && !existing.__in_flight) return res.json(existing);
        } catch (idemErr) {
            return res.status(409).json({
                success: false,
                error: idemErr.message,
                code: 'IDEMPOTENCY_KEY_REUSED'
            });
        }

        const cfg = await fxService.getCurrencyConfig(currency);
        const amtNum = Number(amount);

        if (!Number.isFinite(amtNum) || amtNum <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid amount', code: 'INVALID_AMOUNT' });
        }
        if (amtNum < Number(cfg.min_amount)) {
            return res.status(400).json({ success: false, error: `Minimum deposit for ${currency} is ${cfg.min_amount}`, code: 'AMOUNT_TOO_LOW' });
        }
        if (amtNum > Number(cfg.max_amount)) {
            return res.status(400).json({ success: false, error: `Maximum deposit for ${currency} is ${cfg.max_amount}`, code: 'AMOUNT_TOO_HIGH' });
        }

        const breakdown = fxService.computeDepositBreakdown(cfg, amtNum);
        const { reference: rateReference } = await fxService.lockDepositRate({ cfg, paymentAmount: amtNum, breakdown });

        const deposit = await depositService.createDepositRequest({
            userId, cfg, breakdown, rateReference
        });

        const profile = req.user;

        let koraResult;
        try {
            koraResult = await korapayService.initializeCheckout({
                amount: amtNum,
                currency: cfg.code,
                reference: deposit.merchant_reference,
                customerName:  profile.username || 'MilesSpace Customer',
                customerEmail: profile.email,
                narration:     `MilesSpace deposit — ${cfg.code} ${amtNum}`,
                metadata: {
                    milespace_deposit_id: deposit.id,
                    milespace_user_id:    userId,
                    payment_currency:     cfg.code,
                    wallet_currency:      breakdown.wallet_currency,
                    internal_reference:   deposit.internal_reference
                }
            });
        } catch (koraErr) {
            console.error('[DEPOSIT] Kora init failed:', koraErr.message);
            await supabaseAdmin
                .from('deposit_requests')
                .update({
                    status: 'failed',
                    failure_reason: 'KORA_INITIALIZATION_FAILED',
                    provider_payload: koraErr.provider || { error: koraErr.message },
                    failed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', deposit.id);
            return res.status(502).json({ success: false, error: 'Payment provider initialization failed', code: 'KORA_INITIALIZATION_FAILED' });
        }

        await supabaseAdmin
            .from('deposit_requests')
            .update({
                checkout_url: koraResult.checkout_url,
                provider_reference: koraResult.reference || null,
                provider_payload: koraResult.raw,
                updated_at: new Date().toISOString()
            })
            .eq('id', deposit.id);

        const responsePayload = {
            success: true,
            deposit: {
                reference:              deposit.internal_reference,
                merchant_reference:     deposit.merchant_reference,
                payment_currency:       breakdown.payment_currency,
                payment_amount:         breakdown.payment_amount.toFixed(2),
                wallet_currency:        breakdown.wallet_currency,
                wallet_amount:          breakdown.wallet_amount.toFixed(2),
                customer_rate:          breakdown.customer_rate != null ? String(breakdown.customer_rate) : null,
                fee_amount:             breakdown.fee_amount,
                fee_currency:           breakdown.fee_currency,
                status:                 'pending'
            },
            checkout_url: koraResult.checkout_url
        };

        await IdempotencyService.save(userId, idempotency_key, 'kora_deposit_initialize', responsePayload);

        return res.json(responsePayload);
    } catch (e) {
        const code = e.code || 'SERVER_ERROR';
        const status = ['UNSUPPORTED_CURRENCY','AMOUNT_TOO_LOW','AMOUNT_TOO_HIGH','INVALID_AMOUNT','CURRENCY_MISCONFIGURED'].includes(code) ? 400
                     : code === 'FX_RATE_UNAVAILABLE' ? 503 : 500;
        return res.status(status).json({ success: false, error: e.message, code });
    }
});

// ─── GET /api/wallet/deposits/kora/callback ────────────────
// Kora redirects here after checkout. ALWAYS verify with Kora.
router.get('/deposits/kora/callback', async (req, res) => {
    try {
        const ref = req.query.reference || req.query.merchant_reference;
        if (!ref) return res.redirect('/fund?deposit=missing_reference');

        const { data: deposit, error: findErr } = await supabaseAdmin
            .from('deposit_requests')
            .select('*')
            .or(`merchant_reference.eq.${ref},provider_reference.eq.${ref},internal_reference.eq.${ref}`)
            .maybeSingle();

        if (findErr) {
            console.error('[DEPOSIT CALLBACK] lookup failed:', findErr.message);
            return res.redirect('/fund?deposit=error');
        }
        if (!deposit) return res.redirect('/fund?deposit=not_found');

        if (deposit.status === 'completed') {
            return res.redirect('/fund?deposit=success&ref=' + encodeURIComponent(deposit.internal_reference));
        }

        try {
            const result = await depositService.completeKoraDeposit({
                depositId: deposit.id,
                providerTransaction: {
                    reference: deposit.provider_reference || ref
                },
                source: 'callback'
            });

            if (result.completed) {
                return res.redirect('/fund?deposit=success&ref=' + encodeURIComponent(deposit.internal_reference));
            }
            return res.redirect('/fund?deposit=pending&ref=' + encodeURIComponent(deposit.internal_reference));
        } catch (e) {
            console.error('[DEPOSIT CALLBACK] completeKoraDeposit threw:', e.message);
            return res.redirect('/fund?deposit=pending&ref=' + encodeURIComponent(deposit.internal_reference));
        }
    } catch (e) {
        console.error('[DEPOSIT CALLBACK] outer error:', e.message);
        return res.redirect('/fund?deposit=error');
    }
});

// ─── POST /api/wallet/deposits/kora/webhook ────────────────
// The route MUST capture the raw body BEFORE express.json() parses
// it. That is what `verify` does. The webhook handler then builds
// two candidate canonical strings and passes both to the verifier.
router.post(
    '/deposits/kora/webhook',
    express.json({
        verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
    }),
    async (req, res) => {
        // Ack immediately — Kora expects a fast 200.
        res.status(200).json({ received: true });

        let eventRowId = null;
        try {
            const signature = req.headers['x-korapay-signature'];
            const rawBody   = req.rawBody || '';
            const body      = req.body || {};

            const candidates = korapayService.extractCanonicalDataStrings({
                parsedBody: body,
                rawBody
            });

            const valid = korapayService.verifyWebhookSignature(candidates, signature);

            console.log('[KORA WEBHOOK] received', {
                event: body?.event || body?.type || null,
                reference: body?.data?.reference || body?.data?.payment_reference || null,
                signature_present: !!signature,
                candidates: candidates.length,
                valid
            });

            if (!candidates.length) {
                console.warn('[KORA WEBHOOK] no canonical candidate — body might not have arrived');
            }

            const parsed = korapayService.parseWebhook(body);
            const providerRef = parsed.provider_reference;
            if (!providerRef) {
                console.warn('[KORA WEBHOOK] no provider reference — ignoring');
                return;
            }

            const persisted = await persistKoraEvent({
                parsed,
                rawBody,
                signature,
                valid
            });

            if (persisted.duplicate && persisted.previousStatus === 'processed') {
                console.log('[KORA WEBHOOK] duplicate of a processed event — ignoring');
                return;
            }

            eventRowId = persisted.id || null;

            if (!valid) {
                console.warn('[KORA WEBHOOK] invalid signature — ignoring');
                await markKoraEvent(eventRowId, {
                    status: 'failed',
                    error: 'INVALID_SIGNATURE'
                });
                return;
            }

            const { data: deposit, error: findErr } = await supabaseAdmin
                .from('deposit_requests')
                .select('*')
                .or(`provider_reference.eq.${providerRef},merchant_reference.eq.${providerRef}`)
                .maybeSingle();

            if (findErr) {
                await markKoraEvent(eventRowId, {
                    status: 'failed',
                    error: `DEPOSIT_LOOKUP_FAILED: ${findErr.message}`.slice(0, 500)
                });
                return;
            }
            if (!deposit) {
                await markKoraEvent(eventRowId, {
                    status: 'failed',
                    error: 'DEPOSIT_NOT_FOUND'
                });
                return;
            }

            const verifiedData = {
                provider_status: parsed.status,
                amount: parsed.amount,
                currency: parsed.currency,
                reference: parsed.provider_reference
            };
            const digest = depositService.computeVerifiedDigest(verifiedData);

            const result = await depositService.completeKoraDeposit({
                depositId: deposit.id,
                providerTransaction: {
                    ...verifiedData,
                    _trustedVerified: true,
                    _verifiedDigest: digest
                },
                source: 'webhook'
            });

            await markKoraEvent(eventRowId, {
                status: result.completed ? 'processed' : 'failed',
                error: result.completed ? null : (result.reason || 'UNKNOWN')
            });
        } catch (e) {
            console.error('[KORA WEBHOOK] handler error:', e.message);
            try {
                await markKoraEvent(eventRowId, {
                    status: 'failed',
                    error: e.message.slice(0, 500)
                });
            } catch { /* ignore */ }
        }
    }
);

// ─── GET /api/wallet/deposits/:reference ──────────────────
router.get('/deposits/:reference', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { reference } = req.params;

        const { data: deposit, error } = await supabaseAdmin
            .from('deposit_requests')
            .select('*')
            .or(`internal_reference.eq.${reference},merchant_reference.eq.${reference}`)
            .eq('user_id', userId)
            .maybeSingle();

        if (error || !deposit) {
            return res.status(404).json({ success: false, error: 'Deposit not found', code: 'DEPOSIT_NOT_FOUND' });
        }

        return res.json({
            success: true,
            deposit: {
                reference:        deposit.internal_reference,
                merchant_reference: deposit.merchant_reference,
                payment_currency: deposit.payment_currency,
                payment_amount:   Number(deposit.payment_amount).toFixed(2),
                wallet_currency:  deposit.wallet_currency,
                wallet_amount:    deposit.wallet_amount ? Number(deposit.wallet_amount).toFixed(2) : null,
                customer_rate:    deposit.customer_rate != null ? String(deposit.customer_rate) : null,
                fee_amount:       Number(deposit.fee_amount || 0),
                fee_currency:     deposit.fee_currency,
                status:           deposit.status,
                failure_reason:   deposit.failure_reason,
                created_at:       deposit.created_at,
                completed_at:     deposit.completed_at
            }
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Failed to fetch deposit' });
    }
});

// ─── HELPERS ──────────────────────────────────────────────
async function persistKoraEvent({ parsed, rawBody, signature, valid }) {
    const eventHash = crypto
        .createHash('sha256')
        .update(rawBody || JSON.stringify(parsed.raw || {}))
        .digest('hex');

    const row = {
        provider:          'korapay',
        event_type:        parsed.event_type || null,
        provider_reference: parsed.provider_reference,
        provider_event_ref: parsed.provider_event_ref || eventHash,
        payload:           parsed.raw || {},
        signature:         signature || null,
        signature_valid:   !!valid,
        processing_status: 'received'
    };

    const { data, error } = await supabaseAdmin
        .from('kora_webhook_events')
        .insert(row)
        .select('id')
        .single();

    if (!error) return { id: data.id, duplicate: false };

    if (error.code === '23505') {
        const { data: existing } = await supabaseAdmin
            .from('kora_webhook_events')
            .select('id, processing_status')
            .eq('provider', 'korapay')
            .eq('provider_reference', parsed.provider_reference)
            .eq('provider_event_ref', row.provider_event_ref)
            .maybeSingle();

        return {
            id: existing?.id || null,
            duplicate: true,
            previousStatus: existing?.processing_status || null
        };
    }

    console.warn('[KORA WEBHOOK] persist failed:', error.message);
    return { id: null, duplicate: false };
}

async function markKoraEvent(id, { status, error }) {
    if (!id) return;
    try {
        await supabaseAdmin
            .from('kora_webhook_events')
            .update({
                processing_status: status,
                processing_error:  error || null,
                processed_at:      new Date().toISOString()
            })
            .eq('id', id);
    } catch (e) {
        console.warn('[KORA WEBHOOK] markKoraEvent failed:', e.message);
    }
}

module.exports = router;