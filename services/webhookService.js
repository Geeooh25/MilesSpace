// services/webhookService.js
// ─────────────────────────────────────────────────────────────────
// Webhook receipt + idempotent processing.
// Handles routing to the correct table (webhook_events, kora_webhook_events, provider_webhook_events)
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const providerFactory = require('./providers/providerFactory');
const orderStatus = require('./orderStatusService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// ─── Table Routing Helpers ──────────────────────────────────────

function getTableName(provider) {
    const p = String(provider).toLowerCase();
    if (p === 'korapay') return 'kora_webhook_events';
    if (p === 'nowpayments') return 'provider_webhook_events';
    return 'webhook_events';
}

function getTableColumns(provider) {
    const p = String(provider).toLowerCase();
    if (p === 'korapay') {
        return {
            id: 'id', provider: 'provider', eventId: 'provider_event_ref', fingerprint: 'provider_event_ref',
            eventType: 'event_type', orderId: 'provider_reference', payload: 'payload', headers: 'signature',
            signatureValid: 'signature_valid', status: 'processing_status', error: 'processing_error',
            receivedAt: 'received_at', processedAt: 'processed_at', createdAt: 'received_at'
        };
    }
    if (p === 'nowpayments') {
        return {
            id: 'id', provider: 'provider', eventId: 'event_hash', fingerprint: 'event_hash',
            eventType: 'event_type', orderId: 'payment_id', payload: 'payload', headers: 'signature',
            signatureValid: 'signature_valid', status: 'processing_status', error: 'processing_error',
            receivedAt: 'received_at', processedAt: 'processed_at', createdAt: 'received_at'
        };
    }
    return {
        id: 'id', provider: 'provider', eventId: 'event_id', fingerprint: 'event_fingerprint',
        eventType: 'event_type', orderId: 'order_id', payload: 'payload', headers: 'headers',
        signatureValid: 'signature_valid', status: 'processing_status', error: 'processing_error',
        receivedAt: 'received_at', processedAt: 'processed_at', createdAt: 'created_at'
    };
}

// ─── Persist (idempotent) ────────────────────────────────────────

async function persistWebhook({
    provider, eventId, fingerprint, eventType, providerOrderId,
    payload, headers, signatureValid
}) {
    const now = new Date().toISOString();
    const table = getTableName(provider);
    const cols = getTableColumns(provider);

    const row = {};
    row[cols.provider] = provider;
    row[cols.eventType] = eventType || null;
    row[cols.orderId] = providerOrderId || null;
    row[cols.payload] = payload || null;
    row[cols.signatureValid] = !!signatureValid;
    row[cols.status] = 'received';
    row[cols.receivedAt] = now;

    if (cols.eventId) row[cols.eventId] = eventId || null;
    if (cols.fingerprint) row[cols.fingerprint] = fingerprint || null;
    if (cols.headers) row[cols.headers] = maskHeaders(headers);
    if (cols.createdAt && cols.createdAt !== cols.receivedAt) row[cols.createdAt] = now;

    const { data, error } = await supabaseAdmin
        .from(table)
        .insert(row)
        .select('*')
        .maybeSingle();

    if (error) {
        if (error.code === '23505') {
            return { duplicate: true };
        }
        throw new Error(`Failed to persist webhook to ${table}: ${error.message}`);
    }
    return { duplicate: false, event: data };
}

async function markEvent(provider, id, patch) {
    const table = getTableName(provider);
    const cols = getTableColumns(provider);
    
    const dbPatch = {};
    if (patch.processing_status) dbPatch[cols.status] = patch.processing_status;
    if (patch.processing_error) dbPatch[cols.error] = patch.processing_error;
    if (patch.order_id) dbPatch[cols.orderId] = patch.order_id;
    dbPatch[cols.processedAt] = new Date().toISOString();

    try {
        await supabaseAdmin.from(table).update(dbPatch).eq(cols.id, id);
    } catch (e) {
        console.warn(`[webhook] markEvent failed on ${table}:`, e.message);
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

    // 1. Signature verification
    if (typeof adapter.verifyWebhook === 'function') {
        let verify;
        try {
            verify = await adapter.verifyWebhook({ rawBody, payload, headers });
        } catch (e) {
            verify = { ok: false, signatureValid: false, reason: e.message || 'verify_threw' };
        }
        if (verify.ok === false) {
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

    // 2. Parse
    const parsed = adapter.parseWebhook ? (adapter.parseWebhook(payload) || {}) : {};
    const eventId = parsed.eventId || null;
    const rawForHash = typeof rawBody === 'string' ? rawBody : JSON.stringify(payload || {});
    const fingerprint = adapter.fingerprint
        ? adapter.fingerprint(payload)
        : sha256Hex(rawForHash);

    // 3. Persist
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

    // 4. Find order
    const order = await findOrder({ providerOrderId: parsed.providerOrderId, provider: providerName });
    if (!order) {
        await markEvent(providerName, event.id, {
            processing_status: 'ignored',
            processing_error: 'No matching local order'
        });
        return { ok: true, ignored: true, reason: 'NO_ORDER' };
    }

    const table = getTableName(providerName);
    const cols = getTableColumns(providerName);
    await supabaseAdmin
        .from(table)
        .update({ [cols.orderId]: order.id, [cols.status]: 'processing' })
        .eq(cols.id, event.id);

    // 5. Run the pipeline
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

        await markEvent(providerName, event.id, {
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

        await markEvent(providerName, event.id, {
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

    let event = null;
    let provider = null;
    let table = null;

    const tables = ['webhook_events', 'kora_webhook_events', 'provider_webhook_events'];
    for (const t of tables) {
        const { data } = await supabaseAdmin.from(t).select('*').eq('id', eventId).maybeSingle();
        if (data) {
            event = data;
            provider = data.provider || (t === 'kora_webhook_events' ? 'korapay' : 'nowpayments');
            table = t;
            break;
        }
    }

    if (!event) {
        const e = new Error('Webhook event not found.'); e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
    }

    const cols = getTableColumns(provider);

    if (event[cols.status] === 'processed') {
        return { already_processed: true };
    }
    if (!event[cols.signatureValid]) {
        const e = new Error('Cannot reprocess a webhook whose signature was invalid.');
        e.status = 422; e.code = 'INVALID_SIGNATURE'; throw e;
    }

    // ─── CRITICAL FIX ───
    // Do NOT call handleWebhook because it would hit the idempotency duplicate check.
    // Instead, we manually resume the processing pipeline for the existing event.
    
    await supabaseAdmin
        .from(table)
        .update({ [cols.status]: 'processing', [cols.error]: null })
        .eq(cols.id, eventId);

    const adapter = providerFactory.get(provider);
    const parsed = adapter.parseWebhook ? (adapter.parseWebhook(event[cols.payload]) || {}) : {};
    const order = await findOrder({ providerOrderId: parsed.providerOrderId, provider });

    if (!order) {
        await markEvent(provider, eventId, {
            processing_status: 'ignored',
            processing_error: 'No matching local order'
        });
        return { ok: true, ignored: true, reason: 'NO_ORDER' };
    }

    try {
        const result = await orderStatus.processProviderUpdate({
            order,
            providerStatus: parsed.status,
            providerResponse: parsed.raw,
            source: 'admin_replay',
            actorType: 'admin',
            actorId: ctx?.adminId
        });

        await supabaseAdmin
            .from('orders')
            .update({
                webhook_status: 'processed',
                webhook_received_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);

        await markEvent(provider, eventId, {
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
            .eq('id', order.id);

        await markEvent(provider, eventId, {
            processing_status: 'failed',
            processing_error: String(err.message || '').slice(0, 500)
        });

        throw err;
    }
}

async function ignoreWebhook({ eventId, reason, ctx }) {
    if (!UUID_RE.test(String(eventId || ''))) {
        const e = new Error('Invalid event id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }

    let event = null;
    let provider = null;
    const tables = ['webhook_events', 'kora_webhook_events', 'provider_webhook_events'];
    
    for (const t of tables) {
        const { data } = await supabaseAdmin.from(t).select('*').eq('id', eventId).maybeSingle();
        if (data) {
            event = data;
            provider = data.provider || (t === 'kora_webhook_events' ? 'korapay' : 'nowpayments');
            break;
        }
    }

    if (!event) {
        const e = new Error('Webhook event not found.'); e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
    }

    const cols = getTableColumns(provider);
    
    const { data, error } = await supabaseAdmin
        .from(getTableName(provider))
        .update({
            [cols.status]: 'ignored',
            [cols.error]: trimmed.slice(0, 500),
            [cols.processedAt]: new Date().toISOString()
        })
        .eq(cols.id, eventId)
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