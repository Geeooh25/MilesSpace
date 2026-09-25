// routes/webhooks.js
// ─────────────────────────────────────────────────────────────────
// Public webhook endpoints. NO user authentication — providers
// cannot log in. Signature verification is the gate.
//
// IMPORTANT: signature verification must run against the RAW body
// for most providers, so this router uses express.raw() instead of
// the default JSON body parser.
//
//   POST /api/webhooks/:provider
//
// The `:provider` param must match an adapter in the registry.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const webhookService = require('../services/webhookService');
const providerFactory = require('../services/providers/providerFactory');

// Raw body capture for HMAC verification. The default JSON parser
// upstream has already consumed the body — we stash the raw buffer
// from req.body via a bodyParser on this router.
router.use(express.raw({ type: '*/*', limit: '2mb' }));

router.post('/:provider', async (req, res) => {
    const provider = String(req.params.provider || '').toLowerCase();

    if (!providerFactory.get(provider)) {
        console.warn('[webhook] Unknown provider:', provider);
        return res.status(404).json({ success: false, error: 'Unknown provider' });
    }

    // req.body is the raw Buffer here; parse JSON ourselves.
    let payload = null;
    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : null);
    if (rawBody) {
        try { payload = JSON.parse(rawBody); } catch { payload = null; }
    } else if (req.body && typeof req.body === 'object') {
        payload = req.body;
    }

    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ success: false, error: 'Invalid payload' });
    }

    try {
        const result = await webhookService.handleWebhook({
            provider,
            rawBody,
            payload,
            headers: req.headers,
            req
        });

        // Never return non-200 to providers unless the event is
        // genuinely un-processable; most providers retry on 5xx.
        if (result.ok === false && result.code === 'INVALID_SIGNATURE') {
            return res.status(401).json({ success: false, error: 'Invalid signature' });
        }
        if (result.ok === false && result.code === 'PROCESSING_FAILED') {
            // Return 200 with error metadata so we don't spam retries.
            // The event is already persisted for admin review.
            return res.status(200).json({ success: true, processed: false, error: result.reason });
        }
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        console.error(`[webhook] ${provider} error:`, err.message);
        return res.status(500).json({ success: false, error: 'Webhook processing failed' });
    }
});

module.exports = router;