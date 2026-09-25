// services/boostSyncService.js
// ─────────────────────────────────────────────────────────────────
// Boost sync service.
//
// Called by:
//   • POST /api/admin/boost/sync (admin)
//   • POST /api/boost/orders/:orderRef/refresh (user)
//   • a cron worker (if you set one up)
//
// Provider rules:
//   • Provider timeout ≠ failed. Unknown outcomes become
//     provider_unknown and stay pending.
//   • Only explicit 'failed'/'canceled' from the provider triggers
//     a refund.
//   • Refund goes through boostService.refundOrder, which is atomic
//     and idempotent.
// ─────────────────────────────────────────────────────────────────

'use strict';

const axios = require('axios');
const { supabaseAdmin } = require('../db/supabase');
const boostService = require('./boostService');

const SMMWIZ_API_URL = 'https://smmwiz.com/api/v2';

function getApiKey() {
    return process.env.SMMWIZ_API_KEY || null;
}

function isProviderConfigured() {
    return Boolean(getApiKey());
}

function assertProviderConfigured() {
    if (!isProviderConfigured()) {
        const e = new Error('SMMWIZ_API_KEY is not set on this server. Add it to your environment and restart.');
        e.status = 503;
        e.code = 'PROVIDER_NOT_CONFIGURED';
        e.missing = 'SMMWIZ_API_KEY';
        throw e;
    }
}

async function callSmmWiz(params) {
    assertProviderConfigured();
    let res;
    try {
        res = await axios.post(SMMWIZ_API_URL, null, {
            params: { key: getApiKey(), ...params },
            timeout: 15000
        });
    } catch (err) {
        const status = err.response?.status;
        const providerMessage = err.response?.data?.error || err.message || 'Provider request failed';
        const e = new Error(providerMessage);
        e.code = status ? `PROVIDER_HTTP_${status}` : 'PROVIDER_NETWORK';
        e.ambiguous = !status || status >= 500;
        throw e;
    }
    if (res.data?.error) {
        const e = new Error(String(res.data.error));
        e.code = 'PROVIDER_ERROR';
        e.definitive = true;
        throw e;
    }
    return res.data;
}

// ─── Status normalization ────────────────────────────────────────

function normalizeBoostStatus(status) {
    const v = String(status || '').toLowerCase().trim();
    if (!v) return null;
    if (v === 'pending') return 'pending';
    if (v === 'in progress' || v === 'in_progress') return 'in_progress';
    if (v === 'processing' || v === 'started') return 'processing';
    if (v === 'partial' || v === 'partially completed') return 'partial';
    if (v === 'completed' || v === 'complete' || v === 'finished' || v === 'done') return 'completed';
    if (v === 'canceled' || v === 'cancelled') return 'cancelled';
    if (v === 'failed' || v === 'error') return 'failed';
    if (v === 'refunded') return 'refunded';
    return null;
}

// ─── Single order sync ──────────────────────────────────────────

async function syncBoostOrder(order) {
    if (!order || !order.api_order_id) {
        return { updated: false, reason: 'NO_PROVIDER_ORDER_ID' };
    }
    if (!isProviderConfigured()) {
        return { updated: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    }

    let providerStatus;
    try {
        providerStatus = await callSmmWiz({ action: 'status', order: order.api_order_id });
    } catch (err) {
        const now = new Date().toISOString();
        // Record the attempt so the admin can see something happened.
        // Ambiguous errors move the order to provider_unknown.
        await supabaseAdmin
            .from('boost_orders')
            .update({
                provider_last_checked_at: now,
                provider_response: { error: String(err.message || '').slice(0, 500) },
                updated_at: now,
                ...(order.status === 'pending' && err.ambiguous ? { status: 'provider_unknown' } : {})
            })
            .eq('id', order.id);

        return { updated: false, reason: 'PROVIDER_QUERY_FAILED', error: err.message };
    }

    const apiStatus = normalizeBoostStatus(providerStatus.status);
    const now = new Date().toISOString();

    const update = {
        provider_status: String(providerStatus.status || ''),
        provider_response: {
            status: providerStatus.status || null,
            start_count: providerStatus.start_count ?? null,
            remains: providerStatus.remains ?? null,
            charge: providerStatus.charge ?? null
        },
        provider_last_checked_at: now,
        updated_at: now,
        start_count: providerStatus.start_count ?? order.start_count ?? null,
        remains: providerStatus.remains ?? order.remains ?? null
    };

    if (!apiStatus || apiStatus === order.status) {
        await supabaseAdmin.from('boost_orders').update(update).eq('id', order.id);
        return { updated: false, status: apiStatus || order.status };
    }

    update.status = apiStatus;
    if (apiStatus === 'completed') update.completed_at = now;
    if (apiStatus === 'failed' || apiStatus === 'cancelled') update.failed_at = now;

    const { data: applied, error: updErr } = await supabaseAdmin
        .from('boost_orders')
        .update(update)
        .eq('id', order.id)
        .eq('status', order.status)
        .select('*')
        .maybeSingle();

    if (updErr || !applied) {
        return { updated: false, reason: 'STATE_CHANGED' };
    }

    try {
        const titles = {
            processing: 'Boost Processing',
            in_progress: 'Boost In Progress',
            partial: 'Boost Partially Delivered',
            completed: 'Boost Completed',
            failed: 'Boost Failed',
            cancelled: 'Boost Cancelled'
        };
        await supabaseAdmin.from('notifications').insert({
            user_id: applied.user_id,
            title: titles[apiStatus] || 'Boost Update',
            message: `Your ${applied.service_name} order ${applied.order_ref} is now ${apiStatus}.`,
            type: `boost_${apiStatus}`,
            icon: apiStatus === 'completed' ? '✅' : apiStatus === 'failed' ? '❌' : '📈',
            link: '/boost',
            is_read: false,
            created_at: now
        });
    } catch (_) {}

    if ((apiStatus === 'failed' || apiStatus === 'cancelled') && applied.refund_status !== 'refunded') {
        try {
            await boostService.refundOrder({
                orderId: applied.id,
                reason: `Provider reported ${apiStatus}`,
                ctx: null
            });
        } catch (refundErr) {
            console.error('[BOOST SYNC] refund failed for', applied.order_ref, refundErr.message);
        }
    }

    return { updated: true, status: apiStatus };
}

// ─── Sweep pending orders ───────────────────────────────────────

async function syncPendingBoostOrders({ limit = 50 } = {}) {
    if (!isProviderConfigured()) {
        return { ok: false, reason: 'PROVIDER_NOT_CONFIGURED', processed: 0 };
    }

    const { data: orders, error } = await supabaseAdmin
        .from('boost_orders')
        .select('*')
        .in('status', ['pending', 'processing', 'in_progress', 'partial', 'provider_unknown'])
        .not('api_order_id', 'is', null)
        .order('provider_last_checked_at', { ascending: true, nullsFirst: true })
        .limit(limit);

    if (error) return { ok: false, error: error.message, processed: 0 };
    if (!orders?.length) return { ok: true, processed: 0, updated: 0 };

    let updated = 0;
    const results = [];
    for (const order of orders) {
        try {
            const r = await syncBoostOrder(order);
            if (r.updated) updated++;
            results.push({ order_ref: order.order_ref, ...r });
        } catch (e) {
            results.push({ order_ref: order.order_ref, updated: false, error: e.message });
        }
    }
    return { ok: true, processed: orders.length, updated, results };
}

// ─── Submit pending orders to SMMWiz ────────────────────────────

async function submitPendingBoostOrders({ limit = 25 } = {}) {
    if (!isProviderConfigured()) {
        return { ok: false, reason: 'PROVIDER_NOT_CONFIGURED', submitted: 0 };
    }

    const { data: orders, error } = await supabaseAdmin
        .from('boost_orders')
        .select('*')
        .eq('status', 'pending')
        .is('api_order_id', null)
        .order('created_at', { ascending: true })
        .limit(limit);

    if (error) return { ok: false, error: error.message, submitted: 0 };
    if (!orders?.length) return { ok: true, submitted: 0 };

    let submitted = 0;
    for (const order of orders) {
        try {
            const res = await callSmmWiz({
                action: 'add',
                service: order.service_id,
                link: order.link,
                quantity: order.quantity
            });
            const apiOrderId = res.order || res.id;
            if (!apiOrderId) {
                throw Object.assign(new Error('Provider returned no order id'), { code: 'PROVIDER_NO_ORDER_ID' });
            }

            const now = new Date().toISOString();
            const { data: updated } = await supabaseAdmin
                .from('boost_orders')
                .update({
                    api_order_id: String(apiOrderId),
                    provider_status: 'pending',
                    provider_last_checked_at: now,
                    status: 'processing',
                    updated_at: now
                })
                .eq('id', order.id)
                .eq('status', 'pending')
                .is('api_order_id', null)
                .select('*')
                .maybeSingle();

            if (updated) {
                submitted++;
                try {
                    await supabaseAdmin.from('notifications').insert({
                        user_id: updated.user_id,
                        title: 'Boost Submitted',
                        message: `Your ${updated.service_name} order ${updated.order_ref} is now processing.`,
                        type: 'boost_processing',
                        icon: '⏳',
                        link: '/boost',
                        is_read: false,
                        created_at: now
                    });
                } catch (_) {}
            }
        } catch (e) {
            // Provider either definitively rejected or timed out.
            // Timeouts are ambiguous — do not refund yet.
            const now = new Date().toISOString();
            const definitive = e.definitive === true;

            await supabaseAdmin
                .from('boost_orders')
                .update({
                    status: definitive ? 'failed' : 'provider_unknown',
                    provider_response: { error: String(e.message || '').slice(0, 500), code: e.code || null },
                    provider_last_checked_at: now,
                    updated_at: now,
                    failure_reason: definitive ? String(e.message || '').slice(0, 500) : null
                })
                .eq('id', order.id)
                .eq('status', 'pending');

            if (definitive) {
                try {
                    await boostService.refundOrder({
                        orderId: order.id,
                        reason: `Provider rejected: ${String(e.message || '').slice(0, 200)}`,
                        ctx: null
                    });
                } catch (refundErr) {
                    console.error('[BOOST SYNC] refund after rejection failed:', refundErr.message);
                }
            } else {
                console.warn('[BOOST SYNC] submission ambiguous for', order.order_ref, e.message);
            }
        }
    }
    return { ok: true, submitted };
}

module.exports = {
    isProviderConfigured,
    assertProviderConfigured,
    callSmmWiz,
    normalizeBoostStatus,
    syncBoostOrder,
    syncPendingBoostOrders,
    submitPendingBoostOrders
};