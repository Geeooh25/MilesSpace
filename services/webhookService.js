// services/webhookService.js
// ─────────────────────────────────────────────────────────────────
// Webhook receipt + idempotent processing.
//
//   1. Save the raw event (unique on provider+event_id or fingerprint).
//   2. If duplicate → return already_processed.
//   3. Find the local order.
//   4. Hand to orderStatusService.processProviderUpdate().
//   5. Mark the event processed/failed/ignored.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const providerFactory = require('./providers/providerFactory');
const orderStatus = require('./orderStatusService');

function maskHeaders(h) {
    if (!h || typeof h !== 'object') return h;
    const out = {};
    for (const [k, v] of Object.entries(h)) {
        const lk = k.toLowerCase();
        if (lk.includes('authorization') || lk.includes('cookie') || lk.includes('secret') || lk.includes('key')) {
            out[k] = '[MASKED]';
        } else {
            out[k] = v;
        }
    }
    return out;
}

async function persistWebhook({ provider, eventId, fingerprint, eventType, providerOrderId, payload, headers, signatureValid }) {
    // Atomic insert with the unique index as the source of truth for
    // idempotency. If (provider, event_id) or (provider, fingerprint)
    // already exists, we get a 23505 and treat it as a duplicate.
    const row = {
        provider,
        event_id: eventId || null,
        event_fingerprint: fingerprint || null,
        event_type: eventType || null,
        provider_order_id: providerOrderId || null,
        payload: payload || null,
        headers: maskHeaders(headers),
        signature_valid: Boolean(signatureValid),
        processing_status: 'received',
        received_at: new Date().toISOString(),
        created_at: new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin
        .from('webhook_events')
        .insert(row)
        .select('*')
        .maybeSingle();

    if (error) {
        if (error.code === '23505') {
            return { duplicate: true };
        }
        throw new Error(`Failed to persist webhook: ${error.message}`);
    }
    return { duplicate: false, event: data };
}

async function findOrder({ providerOrderId, provider }) {
    if (!providerOrderId) return null;
    const { data } = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('provider', provider)
        .eq('provider_order_id', String(providerOrderId))
        .maybeSingle();
    if (data) return data;

    // Fallback: provider_reference or external_reference.
    const { data: byRef } = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('provider', provider)
        .or(`provider_reference.eq.${providerOrderId},external_reference.eq.${providerOrderId}`)
        .maybeSingle();
    return byRef || null;
}

async function markEvent(id, patch) {
    try {
        await supabaseAdmin.from('webhook_events')
            .update({ ...patch, processed_at: new Date().toISOString() })
            .eq('id', id);
    } catch (e) {
        console.warn('[webhook] markEvent failed:', e.message);
    }
}

// ─── The public entry point every webhook route calls ────────────

async function handleWebhook({ provider: providerName, rawBody, payload, headers, req }) {
    const adapter = providerFactory.get(providerName);
    if (!adapter) {
        return { ok: false, code: 'UNKNOWN_PROVIDER' };
    }

    // 1. Signature verification (if supported by the adapter).
    let verify = { ok: true, signatureValid: false };
    if (typeof adapter.verifyWebhook === 'function') {
        try {
            verify = await adapter.verifyWebhook({ rawBody, payload, headers });
        } catch (e) {
            verify = { ok: false, signatureValid: false, reason: e.message };
        }
    }
    if (verify.ok === false) {
        // Persist the failed attempt as an event with signature_valid=false.
        await persistWebhook({
            provider: providerName,
            eventId: null,
            fingerprint: crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex'),
            eventType: payload?.event || payload?.event_type || null,
            providerOrderId: null,
            payload, headers,
            signatureValid: false
        }).catch(() => {});

        return { ok: false, code: 'INVALID_SIGNATURE', reason: verify.reason };
    }

    // 2. Parse the payload.
    const parsed = adapter.parseWebhook(payload) || {};
    const eventId = parsed.eventId || null;
    const fingerprint = adapter.fingerprint
        ? adapter.fingerprint(payload)
        : crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');

    // 3. Persist (idempotency).
    const persisted = await persistWebhook({
        provider: providerName,
        eventId,
        fingerprint,
        eventType: parsed.eventType,
        providerOrderId: parsed.providerOrderId,
        payload, headers,
        signatureValid: verify.signatureValid
    });

    if (persisted.duplicate) {
        return { ok: true, already_processed: true };
    }
    const event = persisted.event;

    // 4. Find the order.
    const order = await findOrder({ providerOrderId: parsed.providerOrderId, provider: providerName });
    if (!order) {
        await markEvent(event.id, {
            processing_status: 'ignored',
            processing_error: 'No matching local order'
        });
        return { ok: true, ignored: true, reason: 'NO_ORDER' };
    }

    await supabaseAdmin.from('webhook_events')
        .update({ order_id: order.id, processing_status: 'processing' })
        .eq('id', event.id);

    // 5. Run the pipeline.
    try {
        const result = await orderStatus.processProviderUpdate({
            order,
            providerStatus: parsed.status,
            providerResponse: parsed.raw,
            source: 'webhook',
            actorType: 'webhook'
        });

        await supabaseAdmin.from('orders').update({
            webhook_status: 'processed',
            webhook_received_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }).eq('id', order.id);

        await markEvent(event.id, {
            processing_status: 'processed',
            processing_error: null
        });

        return { ok: true, updated: !!result.updated, status: result.status };
    } catch (err) {
        await supabaseAdmin.from('orders').update({
            webhook_status: 'failed',
            webhook_received_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }).eq('id', order.id).catch(() => {});

        await markEvent(event.id, {
            processing_status: 'failed',
            processing_error: String(err.message || '').slice(0, 500)
        });

        console.error('[webhook] processing error:', err.message);
        return { ok: false, code: 'PROCESSING_FAILED', reason: err.message };
    }
}

// ─── Admin: reprocess a failed event ─────────────────────────────

async function reprocessWebhook({ eventId, ctx = null }) {
    const { data: event, error } = await supabaseAdmin
        .from('webhook_events')
        .select('*')
        .eq('id', eventId)
        .maybeSingle();
    if (error || !event) {
        const e = new Error('Webhook event not found.'); e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
    }
    if (event.processing_status === 'processed') {
        return { already_processed: true };
    }

    await supabaseAdmin.from('webhook_events')
        .update({ processing_status: 'processing', processing_error: null })
        .eq('id', eventId);

    return await handleWebhook({
        provider: event.provider,
        rawBody: null,
        payload: event.payload,
        headers: event.headers || {},
        req: null
    });
}

async function ignoreWebhook({ eventId, reason, ctx = null }) {
    const { data, error } = await supabaseAdmin
        .from('webhook_events')
        .update({
            processing_status: 'ignored',
            processing_error: reason ? String(reason).slice(0, 500) : 'Ignored by admin',
            processed_at: new Date().toISOString()
        })
        .eq('id', eventId)
        .select('*')
        .maybeSingle();
    if (error || !data) {
        const e = new Error('Webhook event not found.'); e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
    }
    return { event: data };
}

module.exports = {
    handleWebhook,
    reprocessWebhook,
    ignoreWebhook,
    maskHeaders
};