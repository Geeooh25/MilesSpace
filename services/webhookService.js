// services/webhookService.js
// ─────────────────────────────────────────────────────────────────
// Webhook receipt + idempotent processing.
//
// Guarantees:
//   • Signature verification is REQUIRED for any adapter that
//     declares one. Missing signature = rejected.
//   • The event is persisted BEFORE any business logic runs.
//   • Idempotency is enforced by two unique indexes on
//     webhook_events: (provider, event_id) and (provider, hash).
//   • No email or user notification is sent from this file. That
//     work happens in the order pipeline and a small background
//     worker.
//   • Errors during provider call or handler do not leave the event
//     in "processing" forever — the exception path marks it failed.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const providerFactory = require('./providers/providerFactory');
const orderStatus = require('./orderStatusService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keys whose values are never written to the stored headers JSON.
const SENSITIVE_HEADER_PARTS = ['authorization', 'cookie', 'secret', 'key', 'x-signature', 'x-hub-signature'];

function maskHeaders(h) {
    if (!h || typeof h !== 'object') return null;
    const out = {};
    for (const k of Object.keys(h)) {
        const lk = String(k).toLowerCase();
        if (SENSITIVE_HEADER_PARTS.some(p => lk.includes(p))) {
            out[k] = '[MASKED]';
        } else {
            const v = h[k];
            out[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
        }
    }
    return out;
}

function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

// ─── Persist (idempotent) ────────────────────────────────────────

async function persistWebhook({
    provider, eventId, fingerprint, eventType, providerOrderId,
    payload, headers, signatureValid
}) {
    const now = new Date().toISOString();
    const row = {
        provider,
        event_id: eventId || null,
        event_fingerprint: fingerprint || null,
        event_type: eventType || null,
        provider_order_id: providerOrderId || null,
        payload: payload || null,
        headers: maskHeaders(headers),
        signature_valid: !!signatureValid,
        processing_status: 'received',
        received_at: now,
        created_at: now
    };

    const { data, error } = await supabaseAdmin
        .from('webhook_events')
        .insert(row)
        .select('id, provider, event_id, event_fingerprint, event_type, provider_order_id, signature_valid, processing_status, received_at')
        .maybeSingle();

    if (error) {
        // 23505 = unique violation → duplicate.
        if (error.code === '23505') {
            return { duplicate: true };
        }
        throw new Error(`Failed to persist webhook: ${error.message}`);
    }
    return { duplicate: false, event: data };
}

async function markEvent(id, patch) {
    try {
        await supabaseAdmin
            .from('webhook_events')
            .update({ ...patch, processed_at: new Date().toISOString() })
            .eq('id', id);
    } catch (e) {
        console.warn('[webhook] markEvent failed:', e.message);
    }
}

// ─── Order lookup ────────────────────────────────────────────────

async function findOrder({ providerOrderId, provider }) {
    if (!providerOrderId) return null;

    let { data } = await supabaseAdmin
        .from('orders')
        .select('id, order_ref, user_id, status, payment_status, fulfillment_status, refund_status, refund_reference, total_amount, currency, provider, provider_order_id, provider_reference, metadata, attempt_number, parent_order_id')
        .eq('provider', provider)
        .eq('provider_order_id', String(providerOrderId))
        .maybeSingle();
    if (data) return data;

    const { data: byRef } = await supabaseAdmin
        .from('orders')
        .select('id, order_ref, user_id, status, payment_status, fulfillment_status, refund_status, refund_reference, total_amount, currency, provider, provider_order_id, provider_reference, metadata, attempt_number, parent_order_id')
        .eq('provider', provider)
        .or(`provider_reference.eq.${providerOrderId},external_reference.eq.${providerOrderId}`)
        .maybeSingle();
    return byRef || null;
}

// ─── Public entry point ──────────────────────────────────────────

async function handleWebhook({ provider: providerName, rawBody, payload, headers, req }) {
    const adapter = providerFactory.get(providerName);
    if (!adapter) return { ok: false, code: 'UNKNOWN_PROVIDER' };

    // ─── 1. Signature verification (required when the adapter
    //        declares it) ────────────────────────────────────────
    if (typeof adapter.verifyWebhook === 'function') {
        let verify;
        try {
            verify = await adapter.verifyWebhook({ rawBody, payload, headers });
        } catch (e) {
            verify = { ok: false, signatureValid: false, reason: e.message || 'verify_threw' };
        }
        if (verify.ok === false) {
            // Persist the failed attempt so it's visible in the admin.
            const fingerprint = sha256Hex(typeof rawBody === 'string' ? rawBody : JSON.stringify(payload || {}));
            await persistWebhook({
                provider: providerName,
                eventId: null,
                fingerprint,
                eventType: payload?.event || payload?.event_type || null,
                providerOrderId: null,
                payload,
                headers,
                signatureValid: false
            }).catch(() => {});
            return { ok: false, code: 'INVALID_SIGNATURE', reason: verify.reason || 'INVALID_SIGNATURE' };
        }
    }

    // ─── 2. Parse ──────────────────────────────────────────────
    const parsed = adapter.parseWebhook ? (adapter.parseWebhook(payload) || {}) : {};
    const eventId = parsed.eventId || null;
    const rawForHash = typeof rawBody === 'string' ? rawBody : JSON.stringify(payload || {});
    const fingerprint = adapter.fingerprint
        ? adapter.fingerprint(payload)
        : sha256Hex(rawForHash);

    // ─── 3. Persist (idempotency) ──────────────────────────────
    let persisted;
    try {
        persisted = await persistWebhook({
            provider: providerName,
            eventId,
            fingerprint,
            eventType: parsed.eventType || null,
            providerOrderId: parsed.providerOrderId || null,
            payload,
            headers,
            signatureValid: true
        });
    } catch (e) {
        console.error('[webhook] persist failed:', e.message);
        return { ok: false, code: 'PERSIST_FAILED' };
    }
    if (persisted.duplicate) {
        return { ok: true, already_processed: true };
    }
    const event = persisted.event;

    // ─── 4. Find order ─────────────────────────────────────────
    const order = await findOrder({ providerOrderId: parsed.providerOrderId, provider: providerName });
    if (!order) {
        await markEvent(event.id, {
            processing_status: 'ignored',
            processing_error: 'No matching local order'
        });
        return { ok: true, ignored: true, reason: 'NO_ORDER' };
    }

    await supabaseAdmin
        .from('webhook_events')
        .update({ order_id: order.id, processing_status: 'processing' })
        .eq('id', event.id);

    // ─── 5. Run the pipeline (no side effects on this process other
    //        than the state transition + refund via ledger) ───────
    try {
        const result = await orderStatus.processProviderUpdate({
            order,
            providerStatus: parsed.status,
            providerResponse: parsed.raw,
            source: 'webhook',
            actorType: 'webhook'
        });

        await supabaseAdmin
            .from('orders')
            .update({
                webhook_status: 'processed',
                webhook_received_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);

        await markEvent(event.id, {
            processing_status: 'processed',
            processing_error: null
        });

        return { ok: true, updated: !!result.updated, status: result.status };
    } catch (err) {
        await supabaseAdmin
            .from('orders')
            .update({
                webhook_status: 'failed',
                webhook_received_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id)
            .then(() => {}, () => {});

        await markEvent(event.id, {
            processing_status: 'failed',
            processing_error: String(err.message || '').slice(0, 500)
        });

        console.error('[webhook] processing error:', err.message);
        return { ok: false, code: 'PROCESSING_FAILED', reason: err.message };
    }
}

// ─── Admin: reprocess / ignore ───────────────────────────────────

async function reprocessWebhook({ eventId, ctx }) {
    if (!UUID_RE.test(String(eventId || ''))) {
        const e = new Error('Invalid event id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data: event, error } = await supabaseAdmin
        .from('webhook_events')
        .select('id, provider, event_id, payload, headers, processing_status, signature_valid')
        .eq('id', eventId)
        .maybeSingle();
    if (error || !event) {
        const e = new Error('Webhook event not found.'); e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
    }
    if (event.processing_status === 'processed') {
        return { already_processed: true };
    }
    if (!event.signature_valid) {
        const e = new Error('Cannot reprocess a webhook whose signature was invalid.');
        e.status = 422; e.code = 'INVALID_SIGNATURE'; throw e;
    }

    await supabaseAdmin
        .from('webhook_events')
        .update({ processing_status: 'processing', processing_error: null, attempts: (event.attempts || 0) + 1 })
        .eq('id', eventId);

    return await handleWebhook({
        provider: event.provider,
        rawBody: null,
        payload: event.payload,
        headers: event.headers || {},
        req: null
    });
}

async function ignoreWebhook({ eventId, reason, ctx }) {
    if (!UUID_RE.test(String(eventId || ''))) {
        const e = new Error('Invalid event id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('webhook_events')
        .update({
            processing_status: 'ignored',
            processing_error: trimmed.slice(0, 500),
            processed_at: new Date().toISOString()
        })
        .eq('id', eventId)
        .select('id, provider, processing_status, processing_error, processed_at')
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