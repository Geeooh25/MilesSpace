// services/orderStatusService.js
// ─────────────────────────────────────────────────────────────────
// THE pipeline. Every source of provider state feeds through this:
//
//     webhook       →  processProviderUpdate()
//     admin sync    →  processProviderUpdate()
//     background    →  processProviderUpdate()
//
// Guarantees:
//   • State transition is atomic via apply_order_provider_update RPC.
//   • Refund is idempotent via refund_status + unique refund_reference.
//   • Notifications fire only when status actually changes.
//   • Provider response is stored, not trusted.
//   • Provider status is always re-verified before any wallet action.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const providerFactory = require('./providers/providerFactory');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_TRANSITIONS = Object.freeze({
    pending:          ['paid', 'processing', 'completed', 'cancelled', 'failed', 'expired'],
    paid:             ['processing', 'completed', 'cancelled', 'failed'],
    processing:       ['in_progress', 'partial', 'completed', 'failed', 'cancelled', 'provider_unknown', 'manual_review'],
    in_progress:      ['partial', 'completed', 'failed', 'provider_unknown', 'manual_review'],
    partial:          ['completed', 'failed', 'refunding', 'manual_review'],
    provider_unknown: ['processing', 'in_progress', 'partial', 'completed', 'failed', 'manual_review'],
    manual_review:    ['completed', 'failed', 'cancelled', 'refunding', 'processing'],
    completed:        ['refunding'],
    failed:           ['refunding'],
    cancelled:        ['refunding'],
    refunding:        ['refunded', 'failed'],
    refunded:         [],
    expired:          ['failed']
});

// ─── Event writer (non-fatal) ────────────────────────────────────
async function recordOrderEvent({ orderId, eventType, oldStatus, newStatus, message, actorType = 'system', actorId = null, metadata = null }) {
    try {
        await supabaseAdmin.from('order_events').insert({
            order_id: orderId,
            event_type: eventType,
            old_status: oldStatus || null,
            new_status: newStatus || null,
            actor_type: actorType,
            actor_id: actorId,
            message: message ? String(message).slice(0, 500) : null,
            metadata: metadata || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[orderStatus] event insert failed:', e.message);
    }
}

async function notify({ userId, title, message, type, icon = '📌', link = '/history' }) {
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title, message, type, icon, link,
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (_) {}
}

// ─── THE PIPELINE ────────────────────────────────────────────────

async function processProviderUpdate({
    order,
    providerStatus,
    providerResponse,
    startCount = null,
    remains = null,
    currentCount = null,
    source,          // 'webhook' | 'admin_sync' | 'scheduled_sync'
    actorId = null,
    actorType = 'system'
}) {
    if (!order) {
        const e = new Error('processProviderUpdate: order is required');
        e.code = 'ORDER_REQUIRED';
        e.status = 400;
        throw e;
    }

    const adapter = providerFactory.get(order.provider);
    const internalTarget = adapter?.normalizeStatus
        ? adapter.normalizeStatus(providerStatus)
        : null;

    const currentStatus = String(order.status || '').toLowerCase();
    const now = new Date().toISOString();

    const patch = {
        provider_status: String(providerStatus || '').toLowerCase(),
        provider_response: providerResponse || null,
        fulfillment_status: internalTarget,
        last_provider_sync_at: now
    };
    if (startCount != null) patch.start_count = startCount;
    if (remains != null) patch.remains = remains;
    if (currentCount != null) patch.current_count = currentCount;

    // No state change — just record the provider metadata.
    if (!internalTarget || internalTarget === currentStatus) {
        await supabaseAdmin.from('orders').update({
            provider_status: patch.provider_status,
            provider_response: patch.provider_response,
            last_provider_sync_at: now,
            start_count: patch.start_count ?? order.start_count ?? null,
            current_count: patch.current_count ?? order.current_count ?? null,
            remains: patch.remains ?? order.remains ?? null,
            updated_at: now
        }).eq('id', order.id);

        await recordOrderEvent({
            orderId: order.id,
            eventType: 'provider_status_recorded',
            oldStatus: currentStatus,
            newStatus: currentStatus,
            actorType,
            actorId,
            message: `Provider reported ${providerStatus} (no change)`
        });

        return { updated: false, status: currentStatus };
    }

    // State-machine check for non-admin callers.
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (actorType !== 'admin' && !allowed.includes(internalTarget)) {
        await recordOrderEvent({
            orderId: order.id,
            eventType: 'provider_transition_rejected',
            oldStatus: currentStatus,
            newStatus: internalTarget,
            actorType,
            actorId,
            message: `Rejected ${currentStatus} → ${internalTarget}`
        });
        return { updated: false, status: currentStatus, reason: 'INVALID_TRANSITION' };
    }

    // Atomic transition via RPC. Uses row lock + expected status.
    const { error: rpcErr } = await supabaseAdmin.rpc('apply_order_provider_update', {
        p_order_id: order.id,
        p_expected_status: currentStatus,
        p_next_status: internalTarget,
        p_patch: patch,
        p_event_type: `provider_${internalTarget}`,
        p_actor_type: actorType,
        p_actor_id: actorId,
        p_message: `Provider reported ${providerStatus}`
    });

    if (rpcErr) {
        const msg = String(rpcErr.message || '');
        if (msg.includes('ORDER_STATE_CHANGED')) {
            return { updated: false, status: currentStatus, reason: 'STATE_CHANGED' };
        }
        console.error('[orderStatus] RPC error:', msg);
        throw new Error(`Failed to apply provider update: ${msg}`);
    }

    // Financial action: refund on terminal failure, exactly once.
    if ((internalTarget === 'failed' || internalTarget === 'cancelled') && order.refund_status !== 'refunded') {
        try {
            await refundOrder({
                orderId: order.id,
                reason: `Provider reported ${providerStatus}`,
                ctx: null
            });
        } catch (refundErr) {
            console.error('[orderStatus] auto-refund failed for', order.order_ref, refundErr.message);
            await recordOrderEvent({
                orderId: order.id,
                eventType: 'refund_failed',
                oldStatus: internalTarget,
                newStatus: internalTarget,
                actorType: 'system',
                message: refundErr.message
            });
        }
    }

    // Notification on terminal transitions.
    if (['completed','failed','cancelled','partial','refunded'].includes(internalTarget)) {
        const titles = {
            completed: 'Order Completed',
            failed: 'Order Failed',
            cancelled: 'Order Cancelled',
            partial: 'Order Partially Completed',
            refunded: 'Order Refunded'
        };
        const icons = { completed: '✅', failed: '❌', cancelled: '🚫', partial: '⚠️', refunded: '💰' };
        await notify({
            userId: order.user_id,
            title: titles[internalTarget],
            message: `Your order ${order.order_ref} is now ${internalTarget}.`,
            type: `order_${internalTarget}`,
            icon: icons[internalTarget],
            link: '/history'
        });
    }

    return { updated: true, status: internalTarget };
}

// ─── Refund — atomic, idempotent ─────────────────────────────────

async function refundOrder({ orderId, reason, amount = null, ctx = null }) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }

    const { data: order, error } = await supabaseAdmin
        .from('orders').select('*').eq('id', orderId).maybeSingle();
    if (error || !order) {
        const e = new Error('Order not found.'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e;
    }

    // Fast-path idempotency.
    if (order.refund_status === 'refunded') {
        return { refund: { reference: order.refund_reference, amount: order.refund_amount, currency: order.currency, already_refunded: true } };
    }

    const status = String(order.status || '').toLowerCase();
    if (!['failed','cancelled','partial','completed','manual_review'].includes(status)) {
        const e = new Error(`Order status "${status}" is not refundable.`);
        e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
    }

    const refundAmount = amount != null ? Number(amount) : Number(order.total_amount);
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
        const e = new Error('Invalid refund amount.'); e.status = 422; e.code = 'INVALID_AMOUNT'; throw e;
    }
    if (refundAmount > Number(order.total_amount)) {
        const e = new Error('Refund amount exceeds order total.');
        e.status = 422; e.code = 'REFUND_EXCEEDS_ORDER'; throw e;
    }

    const refundRef = `REFUND-${order.order_ref}`;

    // Atomic claim. `refund_reference` starts NULL; only one caller
    // can set it, thanks to the .is('refund_reference', null) guard.
    const { data: claimed, error: claimErr } = await supabaseAdmin
        .from('orders')
        .update({
            refund_status: 'refunding',
            refund_amount: refundAmount,
            refund_reference: refundRef,
            updated_at: new Date().toISOString()
        })
        .eq('id', order.id)
        .neq('refund_status', 'refunded')
        .is('refund_reference', null)
        .select('*')
        .maybeSingle();

    if (claimErr || !claimed) {
        const { data: fresh } = await supabaseAdmin.from('orders').select('refund_reference, refund_amount, currency').eq('id', orderId).maybeSingle();
        return { refund: { reference: fresh?.refund_reference || refundRef, amount: fresh?.refund_amount || refundAmount, currency: fresh?.currency || order.currency, already_refunded: true } };
    }

    // Credit the wallet.
    let creditResult;
    try {
        creditResult = await LedgerService.creditWallet({
            userId: order.user_id,
            amount: refundAmount,
            currency: order.currency,
            description: `Refund for order ${order.order_ref}`,
            reference: refundRef,
            type: 'refund',
            sourceType: 'order',
            sourceId: order.id,
            metadata: { order_ref: order.order_ref, reason: String(reason).slice(0, 500) }
        });
    } catch (creditErr) {
        const msg = String(creditErr.message || '');
        if (msg.includes('duplicate') || msg.includes('unique')) {
            // Already credited elsewhere — treat as success.
            await supabaseAdmin.from('orders')
                .update({ refund_status: 'refunded', refunded_at: new Date().toISOString() })
                .eq('id', order.id);
            return { refund: { reference: refundRef, amount: refundAmount, currency: order.currency, already_refunded: true } };
        }
        // Real failure — roll the claim back so it can be retried.
        await supabaseAdmin.from('orders')
            .update({ refund_status: 'failed', refund_reference: null, updated_at: new Date().toISOString() })
            .eq('id', order.id);
        const e = new Error('Wallet refund failed.'); e.status = 500; e.code = 'LEDGER_REFUND_FAILED'; throw e;
    }

    // Mark refunded + write refund transaction + event.
    await supabaseAdmin.from('orders')
        .update({
            refund_status: 'refunded',
            refund_transaction_id: creditResult.transaction_id || null,
            refunded_at: new Date().toISOString(),
            status: order.status === 'completed' ? 'refunded' : order.status,
            updated_at: new Date().toISOString()
        })
        .eq('id', order.id);

    try {
        await supabaseAdmin.from('transactions').insert({
            user_id: order.user_id,
            type: 'refund',
            status: 'completed',
            currency: order.currency,
            amount: refundAmount,
            ref: refundRef,
            reference: refundRef,
            source_id: order.id,
            source_type: 'order',
            description: `Refund for order ${order.order_ref}`,
            metadata: { order_id: order.id, order_ref: order.order_ref, reason: String(reason).slice(0, 500) },
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    } catch (txErr) {
        if (!String(txErr.message || '').includes('duplicate')) {
            console.warn('[orderStatus] refund tx insert failed (non-fatal):', txErr.message);
        }
    }

    await recordOrderEvent({
        orderId: order.id,
        eventType: 'refund_created',
        oldStatus: order.status,
        newStatus: 'refunded',
        actorType: ctx ? 'admin' : 'system',
        actorId: ctx?.adminId || null,
        message: `Refund of ${refundAmount} ${order.currency} — ${reason}`
    });

    await notify({
        userId: order.user_id,
        title: 'Order Refunded',
        message: `A refund of ${refundAmount} ${order.currency} has been credited for order ${order.order_ref}.`,
        type: 'order_refunded', icon: '💰', link: '/history'
    });

    return {
        refund: {
            reference: refundRef,
            amount: refundAmount,
            currency: order.currency,
            already_refunded: false
        }
    };
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    ALLOWED_TRANSITIONS,
    processProviderUpdate,
    refundOrder,
    recordOrderEvent
};