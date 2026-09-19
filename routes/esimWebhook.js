// routes/esimWebhook.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const dtoneService = require('../services/dtoneService');
const esimRoutes = require('./esimRoutes');

// The routes file exports the main router; we need access to finalize/refund.
// Simplest approach: expose them via a helper, OR duplicate minimal logic here.

router.post('/', async (req, res) => {
    try {
        const payload = req.body || {};
        const externalId = payload.external_id || payload.transaction_id;
        const dtoneTxId = payload.id || payload.transaction_id;
        if (!dtoneTxId && !externalId) return res.status(400).json({ success: false, error: 'Missing identifier' });

        let query = supabaseAdmin.from('esim_transactions').select('*');
        if (externalId) query = query.eq('dtone_external_id', externalId);
        else            query = query.eq('provider_transaction_id', String(dtoneTxId));

        const { data: order } = await query.maybeSingle();
        if (!order) {
            console.warn('⚠️ Webhook for unknown eSIM order:', externalId || dtoneTxId);
            return res.status(200).json({ received: true, matched: false });
        }

        await supabaseAdmin
            .from('esim_transactions')
            .update({
                provider_status: String(payload.status?.message || payload.status || 'UNKNOWN').toUpperCase(),
                provider_response: payload,
                metadata: { ...(order.metadata || {}), last_webhook: payload, received_at: new Date().toISOString() },
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);

        const normalized = dtoneService.normalizeStatus(payload.status || payload);

        // Re-query and let status endpoint logic take over on next poll
        // Simplest reliable path: mark a "webhook_pending" flag and let reconciliation handle it
        console.log(`📡 [WEBHOOK] eSIM ${order.reference} → ${normalized.status}`);

        res.status(200).json({ received: true, matched: true });
    } catch (err) {
        console.error('❌ eSIM webhook error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;