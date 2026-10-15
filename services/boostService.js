// services/boostService.js
// ─────────────────────────────────────────────────────────────────
// Boost — single authority for boost orders, pricing, and refunds.
//
// Ledger contract (matches routes/airtime.js and routes/esimRoutes.js):
//   LedgerService.debitWallet(userId, amount, currency, description, metadata)
//   LedgerService.creditWallet(userId, amount, currency, description, metadata)
//
// The reference/source_id that go to the ledger are DERIVED INSIDE
// the ledger service from the metadata you pass in. We do NOT pass a
// "BST-..." string as source_id — the ledger expects a UUID.
//
// If your LedgerService signature differs, adjust the two wrapper
// helpers at the bottom of this file (debitWallet, creditWallet).
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER_STATUSES = new Set([
    'pending', 'processing', 'in_progress', 'partial',
    'completed', 'failed', 'refunded', 'cancelled',
    'provider_unknown', 'manual_review'
]);

const PENDING_STATUSES = new Set(['pending', 'processing', 'in_progress', 'partial', 'provider_unknown']);
const FAILED_STATUSES  = new Set(['failed', 'cancelled']);
const SUCCESS_STATUSES = new Set(['completed']);

const ALLOWED_TRANSITIONS = Object.freeze({
    pending:           ['processing', 'in_progress', 'completed', 'failed', 'cancelled', 'provider_unknown'],
    processing:        ['in_progress', 'partial', 'completed', 'failed', 'provider_unknown'],
    in_progress:       ['partial', 'completed', 'failed', 'provider_unknown'],
    partial:           ['completed', 'failed'],
    provider_unknown:  ['processing', 'in_progress', 'partial', 'completed', 'failed', 'manual_review'],
    manual_review:     ['completed', 'failed', 'refunded', 'processing'],
    completed:         [],
    failed:            ['refunded'],
    refunded:          [],
    cancelled:         ['refunded']
});

// ─── Helpers ─────────────────────────────────────────────────────

function limitOf(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function pageOf(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}
function isoDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'completed') return 'success';
    if (FAILED_STATUSES.has(s)) return 'danger';
    if (s === 'refunded') return 'info';
    if (s === 'provider_unknown' || s === 'manual_review') return 'purple';
    if (PENDING_STATUSES.has(s)) return 'warn';
    return 'neutral';
}
function buildOrderRef() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `BST-${date}-${rand}`;
}

async function recordAudit({ ctx, action, targetId, before, after, reason }) {
    try {
        await supabaseAdmin.from('admin_audit_logs').insert({
            admin_id:    ctx?.adminId    || null,
            admin_email: ctx?.adminEmail || null,
            action,
            target_type: 'boost_order',
            target_id:   targetId,
            before: before || null,
            after:  after  || null,
            reason: reason ? String(reason).slice(0, 500) : null,
            ip_address: ctx?.ip || null,
            user_agent: ctx?.userAgent || null,
            request_id: ctx?.requestId || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[BOOST] audit insert failed:', e.message);
    }
}

// ─── Config ──────────────────────────────────────────────────────

async function getUsdToNgnRate() {
    try {
        const { data } = await supabaseAdmin
            .from('app_config')
            .select('value')
            .eq('key', 'usd_to_ngn')
            .maybeSingle();
        if (data?.value) {
            const n = Number(data.value);
            if (Number.isFinite(n) && n > 0) return n;
        }
    } catch (_) {}
    return Number(process.env.MILESSPACE_USD_TO_NGN || 1600);
}

async function getDefaultMarkup() {
    try {
        const { data } = await supabaseAdmin
            .from('app_config')
            .select('value')
            .eq('key', 'boost_markup_pct')
            .maybeSingle();
        if (data?.value != null) {
            const raw = Number(data.value);
            if (Number.isFinite(raw)) return raw > 1 ? raw / 100 : raw;
        }
    } catch (_) {}
    return 0.18;
}

// ─── Pricing ─────────────────────────────────────────────────────

async function computePrice({ service, quantity, walletCurrency }) {
    const usdRate = await getUsdToNgnRate();
    const defaultMarkup = await getDefaultMarkup();
    const markupPct = Number(service.markup_percent ?? defaultMarkup);

    const providerRate = Number(service.provider_rate || 0);
    if (!Number.isFinite(providerRate) || providerRate <= 0) {
        const e = new Error('Service has no valid provider rate.');
        e.status = 422; e.code = 'INVALID_SERVICE_RATE';
        throw e;
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
        const e = new Error('Quantity must be a positive integer.');
        e.status = 422; e.code = 'INVALID_QUANTITY';
        throw e;
    }
    if (service.min_quantity && quantity < service.min_quantity) {
        const e = new Error(`Minimum quantity is ${service.min_quantity}.`);
        e.status = 422; e.code = 'QUANTITY_BELOW_MIN';
        throw e;
    }
    if (service.max_quantity && quantity > service.max_quantity) {
        const e = new Error(`Maximum quantity is ${service.max_quantity}.`);
        e.status = 422; e.code = 'QUANTITY_ABOVE_MAX';
        throw e;
    }

    const providerCostUsd = (providerRate / 1000) * quantity;
    const providerCostNgn = providerCostUsd * usdRate;

    const hasCustom = service.custom_price != null && Number(service.custom_price) > 0;
    const customerUsd = hasCustom
        ? (Number(service.custom_price) / 1000) * quantity
        : providerCostUsd * (1 + markupPct);

    const customerNgn = customerUsd * usdRate;

    const currency = String(walletCurrency || 'NGN').toUpperCase();
    const chargeAmount = currency === 'USD' ? customerUsd : customerNgn;
    const providerCostInChargeCurrency = currency === 'USD' ? providerCostUsd : providerCostNgn;

    return {
        quantity,
        currency,
        usdRate,
        markupPercent: markupPct,
        providerRate,
        providerCostUsd: providerCostUsd.toFixed(2),
        providerCostNgn: providerCostNgn.toFixed(2),
        customerUsd: customerUsd.toFixed(2),
        customerNgn: customerNgn.toFixed(2),
        chargeAmount: chargeAmount.toFixed(2),
        providerCost: providerCostInChargeCurrency.toFixed(2),
        profit: (chargeAmount - providerCostInChargeCurrency).toFixed(2)
    };
}

// ═══════════════════════════════════════════════════════════════════
// LEDGER WRAPPERS
// ─────────────────────────────────────────────────────────────────
// Two small adapters so boostService always talks to LedgerService
// with the same argument shape your airtime and eSIM services use.
//
// If your LedgerService.debitWallet expects positional args:
//     debitWallet(userId, amount, currency, description, metadata)
// Then these wrappers work as-is.
//
// If it expects an object:
//     debitWallet({ userId, amount, currency, description, metadata })
// Then swap the two lines in each wrapper.
// ═══════════════════════════════════════════════════════════════════

async function ledgerDebit({ userId, amount, currency, description, metadata }) {
    return LedgerService.debitWallet(
        userId,
        amount,
        currency,
        description,
        metadata || {}
    );
}

async function ledgerCredit({ userId, amount, currency, description, metadata }) {
    if (typeof LedgerService.creditWallet === 'function') {
        return LedgerService.creditWallet(
            userId,
            amount,
            currency,
            description,
            metadata || {}
        );
    }
    if (typeof LedgerService.refundTransaction === 'function' && metadata?.originalTransactionId) {
        return LedgerService.refundTransaction(
            userId,
            metadata.originalTransactionId,
            description
        );
    }
    throw new Error('LedgerService has no credit or refund method');
}

// ─── Order placement ─────────────────────────────────────────────

async function placeOrder({ userId, serviceId, link, quantity, walletType, idempotencyKey }) {
    if (!userId || !UUID_RE.test(userId)) {
        const e = new Error('Invalid user.'); e.status = 400; e.code = 'INVALID_USER'; throw e;
    }
    if (!link || typeof link !== 'string' || !/^https?:\/\//i.test(link)) {
        const e = new Error('URL must start with http:// or https://'); e.status = 422; e.code = 'INVALID_LINK'; throw e;
    }
    const currency = String(walletType || 'NGN').toUpperCase();
    if (!['NGN', 'USD'].includes(currency)) {
        const e = new Error('Invalid wallet.'); e.status = 422; e.code = 'INVALID_WALLET'; throw e;
    }

    // Idempotency
    if (idempotencyKey) {
        const { data: existing } = await supabaseAdmin
            .from('boost_orders')
            .select('*')
            .eq('user_id', userId)
            .eq('idempotency_key', String(idempotencyKey).slice(0, 128))
            .maybeSingle();
        if (existing) {
            return { order: shapeOrder(existing), idempotent: true };
        }
    }

    // Load service
    const { data: service, error: svcErr } = await supabaseAdmin
        .from('boost_services')
        .select('*')
        .eq('provider_service_id', String(serviceId))
        .eq('active', true)
        .eq('visible_to_users', true)
        .maybeSingle();
    if (svcErr || !service) {
        const e = new Error('Service not available.'); e.status = 404; e.code = 'SERVICE_NOT_FOUND'; throw e;
    }

    const price = await computePrice({ service, quantity, walletCurrency: currency });

    // Balance check
    const balances = await LedgerService.getAllBalances(userId);
    const balance = currency === 'USD' ? Number(balances.USD || 0) : Number(balances.NGN || 0);
    const chargeAmount = Number(price.chargeAmount);
    if (balance < chargeAmount) {
        const e = new Error(`Insufficient ${currency} balance.`);
        e.status = 400; e.code = 'INSUFFICIENT_BALANCE';
        e.required = chargeAmount; e.balance = balance;
        throw e;
    }

    // ─── Generate IDs ──────────────────────────────────────────────
    // orderRef  — human-readable, goes into boost_orders.order_ref
    // orderId   — real UUID, goes into boost_orders.id AND is used
    //             as the ledger's sourceId
    const orderRef = buildOrderRef();
    const orderId = crypto.randomUUID();

    // ─── Debit via the positional-arg wrapper ──────────────────────
    let debitResult;
    try {
        debitResult = await ledgerDebit({
            userId,
            amount: chargeAmount,
            currency,
            description: `Social boost: ${service.name} × ${quantity}`,
            metadata: {
                type: 'boost_order',
                order_id: orderId,
                order_ref: orderRef,
                service_id: service.provider_service_id,
                service_name: service.name,
                quantity,
            },
        });
    } catch (debitErr) {
        console.error('[BOOST] ledger debit failed:', debitErr.message);
        const e = new Error(debitErr.message || 'Failed to debit wallet.');
        e.status = 400; e.code = 'DEBIT_FAILED';
        throw e;
    }

    const debitTxId = debitResult?.transaction_id || debitResult?.transactionId || null;

    // ─── Insert order ──────────────────────────────────────────────
    const { data: orderRow, error: insertErr } = await supabaseAdmin
        .from('boost_orders')
        .insert({
            id: orderId,
            user_id: userId,
            order_ref: orderRef,
            service_id: String(service.provider_service_id),
            service_name: service.name,
            platform: service.platform || 'other',
            category: service.category || 'other',
            link,
            quantity,
            total_amount: chargeAmount,
            currency,
            provider_rate: price.providerRate,
            markup_percent: price.markupPercent,
            usd_rate: price.usdRate,
            provider_cost: Number(price.providerCost),
            profit_amount: Number(price.profit),
            status: 'pending',
            provider: 'smmwiz',
            idempotency_key: idempotencyKey ? String(idempotencyKey).slice(0, 128) : null,
            refund_status: 'none',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .select('*')
        .single();

    if (insertErr) {
        console.error('[BOOST] order insert failed:', insertErr.message);

        // Refund because we can't record the order.
        try {
            await ledgerCredit({
                userId,
                amount: chargeAmount,
                currency,
                description: `Boost refund — order recording failed`,
                metadata: {
                    type: 'boost_refund',
                    order_ref: orderRef,
                    reason: 'order_insert_failed',
                    originalTransactionId: debitTxId,
                },
            });
        } catch (refundErr) {
            console.error('[BOOST] refund after insert failure failed:', refundErr.message);
        }

        const e = new Error('Failed to record order.'); e.status = 500; e.code = 'ORDER_INSERT_FAILED'; throw e;
    }

    // ─── Transaction record (non-fatal) ────────────────────────────
    try {
        await supabaseAdmin.from('transactions').insert({
            user_id: userId,
            type: 'boost',
            status: 'completed',
            currency,
            amount: chargeAmount,
            ref: orderRef,
            reference: orderRef,
            description: `Social boost: ${service.name} × ${quantity}`,
            provider: 'smmwiz',
            metadata: {
                order_id: orderRow.id,
                service_id: service.provider_service_id,
                service_name: service.name,
                quantity,
                link,
                provider_cost: Number(price.providerCost),
                markup: price.markupPercent,
                usd_rate: price.usdRate
            },
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    } catch (txErr) {
        console.warn('[BOOST] transaction insert failed (non-fatal):', txErr.message);
    }

    // ─── Notification (non-fatal) ──────────────────────────────────
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title: 'Boost Order Placed',
            message: `Your ${service.name} order ${orderRef} has been received and is being queued.`,
            type: 'boost_placed',
            icon: '📈',
            link: '/boost',
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (_) {}

    return { order: shapeOrder(orderRow), idempotent: false };
}

// ─── Shape ───────────────────────────────────────────────────────

function shapeOrder(o, profile) {
    return {
        id: o.id,
        order_ref: o.order_ref,
        status: o.status,
        status_badge: statusBadge(o.status),
        user_id: o.user_id,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : null,
        service_id: o.service_id,
        service_name: o.service_name,
        platform: o.platform,
        category: o.category,
        link: o.link,
        quantity: o.quantity,
        total_amount: o.total_amount,
        currency: o.currency,
        provider_rate: o.provider_rate,
        markup_percent: o.markup_percent,
        usd_rate: o.usd_rate,
        provider_cost: o.provider_cost,
        profit_amount: o.profit_amount,
        provider: o.provider,
        api_order_id: o.api_order_id,
        provider_status: o.provider_status,
        start_count: o.start_count,
        remains: o.remains,
        admin_note: o.admin_note,
        failure_reason: o.failure_reason,
        refund_status: o.refund_status,
        refund_reference: o.refund_reference,
        refund_processed_at: o.refund_processed_at,
        provider_last_checked_at: o.provider_last_checked_at,
        created_at: o.created_at,
        updated_at: o.updated_at,
        completed_at: o.completed_at,
        failed_at: o.failed_at,
        cancelled_at: o.cancelled_at
    };
}

// ─── List / detail ───────────────────────────────────────────────

async function listOrders(query = {}, { forUserId = null } = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('boost_orders')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (forUserId) q = q.eq('user_id', forUserId);
    else if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);

    if (query.status && query.status !== 'all' && ORDER_STATUSES.has(String(query.status).toLowerCase())) {
        q = q.eq('status', String(query.status).toLowerCase());
    }
    if (query.platform && query.platform !== 'all') q = q.eq('platform', query.platform);
    if (query.category && query.category !== 'all') q = q.eq('category', query.category);
    if (query.currency && query.currency !== 'all') q = q.eq('currency', String(query.currency).toUpperCase());

    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);

    if (query.search) {
        const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
        const parts = [
            `order_ref.ilike.%${safe}%`,
            `service_name.ilike.%${safe}%`,
            `link.ilike.%${safe}%`,
            `api_order_id.ilike.%${safe}%`
        ];
        try {
            const { data: users } = await supabaseAdmin
                .from('profiles')
                .select('id')
                .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
                .limit(50);
            if (users?.length) parts.push(`user_id.in.(${users.map(u => u.id).join(',')})`);
        } catch (_) {}
        q = q.or(parts.join(','));
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { orders: [], count: 0, page, limit, totalPages: 0, available: false };
        }
        const e = new Error('Failed to load boost orders.'); e.status = 500; e.code = 'BOOST_LIST_ERROR'; throw e;
    }

    const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
    let profilesById = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles').select('id, username, email').in('id', userIds);
        for (const p of profiles || []) profilesById[p.id] = p;
    }

    return {
        orders: (data || []).map(o => shapeOrder(o, profilesById[o.user_id])),
        count: count || 0, page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0),
        available: true
    };
}

async function getOrder(orderId) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data: order, error } = await supabaseAdmin
        .from('boost_orders').select('*').eq('id', orderId).maybeSingle();
    if (error) { const e = new Error('Failed to load order.'); e.status = 500; e.code = 'BOOST_DETAIL_ERROR'; throw e; }
    if (!order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'BOOST_NOT_FOUND'; throw e; }

    let profile = null;
    if (order.user_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, status, created_at')
            .eq('id', order.user_id).maybeSingle();
        profile = p || null;
    }

    let transaction = null;
    try {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
            .eq('metadata->>order_id', order.id)
            .eq('type', 'boost')
            .maybeSingle();
        transaction = t || null;
    } catch (_) {}

    let refundTransaction = null;
    if (order.refund_reference) {
        try {
            const { data: t } = await supabaseAdmin
                .from('transactions')
                .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
                .eq('reference', order.refund_reference)
                .maybeSingle();
            refundTransaction = t || null;
        } catch (_) {}
    }

    return {
        order: shapeOrder(order, profile),
        user: profile,
        transaction,
        refund_transaction: refundTransaction
    };
}

// ─── Refund (atomic, idempotent) ─────────────────────────────────

async function refundOrder({ orderId, reason, ctx, allowNonFailed = false }) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }

    const { data: order, error } = await supabaseAdmin
        .from('boost_orders').select('*').eq('id', orderId).maybeSingle();
    if (error || !order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'BOOST_NOT_FOUND'; throw e; }

    if (order.refund_reference) {
        return {
            refund: {
                reference: order.refund_reference,
                amount: order.total_amount,
                currency: order.currency,
                already_refunded: true
            }
        };
    }

    const status = String(order.status || '').toLowerCase();
    const refundableStatuses = allowNonFailed
        ? new Set(['failed', 'cancelled', 'provider_unknown', 'manual_review', 'partial'])
        : new Set(['failed', 'cancelled']);
    if (!refundableStatuses.has(status)) {
        const e = new Error(`Order status "${status}" is not refundable.`);
        e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
    }

    const refundRef = `BOOSTREF-${order.order_ref}`;
    const chargeAmount = Number(order.total_amount);
    const currency = order.currency;

    const { data: rpcRow, error: rpcErr } = await supabaseAdmin.rpc('boost_finalize_refund', {
        p_order_id: order.id,
        p_expected_status: status,
        p_refund_ref: refundRef,
        p_reason: String(reason).slice(0, 500)
    });

    if (rpcErr) {
        const msg = String(rpcErr.message || '');
        if (msg.includes('ORDER_STATE_CHANGED')) {
            const e = new Error('Order changed before the refund completed. Reload and try again.');
            e.status = 409; e.code = 'ORDER_STATE_CHANGED'; throw e;
        }
        const e = new Error('Failed to claim refund.');
        e.status = 500; e.code = 'REFUND_CLAIM_FAILED'; e.cause = msg; throw e;
    }

    const row = Array.isArray(rpcRow) ? rpcRow[0] : rpcRow;
    if (row?.already_refunded) {
        return {
            refund: { reference: refundRef, amount: chargeAmount, currency, already_refunded: true }
        };
    }

    let creditResult;
    try {
        creditResult = await ledgerCredit({
            userId: order.user_id,
            amount: chargeAmount,
            currency,
            description: `Boost refund for ${order.order_ref}`,
            metadata: {
                type: 'boost_refund',
                order_id: order.id,
                order_ref: order.order_ref,
                reason: String(reason).slice(0, 500),
            },
        });
    } catch (creditErr) {
        const msg = String(creditErr.message || '');
        if (msg.includes('duplicate') || msg.includes('unique')) {
            return { refund: { reference: refundRef, amount: chargeAmount, currency, already_refunded: true } };
        }
        await supabaseAdmin
            .from('boost_orders')
            .update({
                refund_status: 'failed',
                refund_reference: null,
                refund_processed_at: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);
        const e = new Error('Wallet refund failed.'); e.status = 500; e.code = 'LEDGER_REFUND_FAILED'; e.cause = msg; throw e;
    }

    try {
        await supabaseAdmin.from('transactions').insert({
            user_id: order.user_id,
            type: 'refund',
            status: 'completed',
            currency,
            amount: chargeAmount,
            ref: refundRef,
            reference: refundRef,
            source_id: order.id,
            source_type: 'boost_order',
            description: `Refund for boost ${order.order_ref}`,
            metadata: {
                order_id: order.id,
                order_ref: order.order_ref,
                reason: String(reason).slice(0, 500)
            },
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    } catch (txErr) {
        if (!String(txErr.message || '').includes('duplicate')) {
            console.warn('[BOOST] refund transaction insert failed (non-fatal):', txErr.message);
        }
    }

    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: order.user_id,
            title: 'Boost Refunded',
            message: `Your ${order.service_name} order ${order.order_ref} has been refunded.`,
            type: 'boost_refunded',
            icon: '💰',
            link: '/boost',
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (_) {}

    if (ctx) {
        await recordAudit({
            ctx, action: 'boost.refund', targetId: order.id,
            before: { status, refund_status: order.refund_status },
            after:  { status: 'refunded', refund_reference: refundRef },
            reason
        });
    }

    return {
        refund: {
            reference: refundRef,
            amount: chargeAmount,
            currency,
            already_refunded: false
        }
    };
}

// ─── Status update ───────────────────────────────────────────────

async function updateOrderStatus({ orderId, status, note, ctx }) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const next = String(status || '').toLowerCase();
    if (!ORDER_STATUSES.has(next)) {
        const e = new Error('Invalid status.'); e.status = 422; e.code = 'INVALID_STATUS'; throw e;
    }

    const { data: order } = await supabaseAdmin
        .from('boost_orders').select('*').eq('id', orderId).maybeSingle();
    if (!order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'BOOST_NOT_FOUND'; throw e; }

    const current = String(order.status || '').toLowerCase();
    if (current === next) {
        return { order: shapeOrder(order), no_op: true };
    }

    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
        const e = new Error(`Cannot transition from "${current}" to "${next}".`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION';
        e.allowed_transitions = allowed;
        throw e;
    }

    const now = new Date().toISOString();
    const patch = { status: next, updated_at: now };
    if (note) patch.admin_note = String(note).slice(0, 1000);
    if (next === 'completed') patch.completed_at = now;
    if (next === 'failed' || next === 'cancelled') patch.failed_at = now;
    if (next === 'cancelled') patch.cancelled_at = now;

    const { data: updated, error: updErr } = await supabaseAdmin
        .from('boost_orders')
        .update(patch)
        .eq('id', orderId)
        .eq('status', current)
        .select('*')
        .maybeSingle();

    if (updErr) {
        const e = new Error('Failed to update order.'); e.status = 500; e.code = 'ORDER_UPDATE_FAILED'; throw e;
    }
    if (!updated) {
        const e = new Error('Order changed while you were editing it.'); e.status = 409; e.code = 'ORDER_STATE_CHANGED'; throw e;
    }

    await recordAudit({
        ctx, action: `boost.status_${next}`, targetId: order.id,
        before: { status: current }, after: { status: next }, reason: note
    });

    return { order: shapeOrder(updated) };
}

// ─── Overview ────────────────────────────────────────────────────

async function getOverview(query = {}) {
    const fromIso = isoDate(query.from) || startOfWatDay();
    const toIso = isoDate(query.to) || new Date().toISOString();

    const rpc = await supabaseAdmin.rpc('boost_overview', { p_from: fromIso, p_to: toIso });
    if (!rpc.error && rpc.data) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        return {
            total: Number(row.total || 0),
            pending: Number(row.pending || 0),
            processing: Number(row.processing || 0),
            completed: Number(row.completed || 0),
            failed: Number(row.failed || 0),
            refunded: Number(row.refunded || 0),
            revenueNgn: String(row.revenue_ngn || '0.00'),
            revenueUsd: String(row.revenue_usd || '0.00'),
            costNgn: String(row.cost_ngn || '0.00'),
            costUsd: String(row.cost_usd || '0.00'),
            profitNgn: String(row.profit_ngn || '0.00'),
            profitUsd: String(row.profit_usd || '0.00'),
            refundsNgn: String(row.refunds_ngn || '0.00'),
            refundsUsd: String(row.refunds_usd || '0.00'),
            uniqueCustomers: Number(row.unique_customers || 0),
            summaryAvailable: true,
            from: fromIso, to: toIso
        };
    }
    if (rpc.error?.code !== '42883' && rpc.error?.code !== 'PGRST202') {
        const e = new Error('Failed to aggregate overview.'); e.status = 500; e.code = 'OVERVIEW_ERROR'; throw e;
    }

    const countWhere = (extra) => {
        let q = supabaseAdmin.from('boost_orders').select('id', { count: 'exact', head: true })
            .gte('created_at', fromIso).lte('created_at', toIso);
        if (extra) q = extra(q);
        return q;
    };
    const [total, pending, processing, completed, failed, refunded] = await Promise.all([
        countWhere(),
        countWhere(q => q.eq('status', 'pending')),
        countWhere(q => q.in('status', ['processing', 'in_progress', 'partial'])),
        countWhere(q => q.eq('status', 'completed')),
        countWhere(q => q.eq('status', 'failed')),
        countWhere(q => q.eq('status', 'refunded'))
    ]);

    return {
        total: total.count || 0,
        pending: pending.count || 0,
        processing: processing.count || 0,
        completed: completed.count || 0,
        failed: failed.count || 0,
        refunded: refunded.count || 0,
        revenueNgn: null, revenueUsd: null,
        costNgn: null, costUsd: null,
        profitNgn: null, profitUsd: null,
        refundsNgn: null, refundsUsd: null,
        uniqueCustomers: 0,
        summaryAvailable: false,
        reason: 'OVERVIEW_RPC_NOT_DEPLOYED',
        from: fromIso, to: toIso
    };
}

function startOfWatDay() {
    const OFFSET_MS = 60 * 60 * 1000;
    const now = new Date();
    const local = new Date(now.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    return new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS).toISOString();
}

// ─── Services ────────────────────────────────────────────────────

async function listServices(query = {}, { forUsersOnly = false } = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit, 50, 200);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('boost_services')
        .select('*', { count: 'exact' })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true })
        .range(offset, offset + limit - 1);

    if (forUsersOnly) {
        q = q.eq('active', true).eq('visible_to_users', true);
    } else {
        if (query.active === 'true' || query.active === 'false') q = q.eq('active', query.active === 'true');
        if (query.visible === 'true' || query.visible === 'false') q = q.eq('visible_to_users', query.visible === 'true');
    }
    if (query.platform && query.platform !== 'all') q = q.eq('platform', query.platform);
    if (query.category && query.category !== 'all') q = q.eq('category', query.category);
    if (query.search) {
        const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
        q = q.or(`name.ilike.%${safe}%,provider_service_id.ilike.%${safe}%,description.ilike.%${safe}%`);
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { services: [], count: 0, page, limit, totalPages: 0, available: false, reason: 'BOOST_SERVICES_TABLE_NOT_FOUND' };
        }
        const e = new Error('Failed to load services.'); e.status = 500; e.code = 'SERVICE_LIST_ERROR'; throw e;
    }

    return {
        services: data || [], count: count || 0, page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        available: true
    };
}

async function updateService({ serviceId, patch, ctx }) {
    if (!UUID_RE.test(String(serviceId || ''))) {
        const e = new Error('Invalid service id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const allowed = ['name', 'description', 'platform', 'category', 'active', 'visible_to_users',
                     'markup_percent', 'custom_price', 'min_quantity', 'max_quantity', 'sort_order',
                     'refill_allowed', 'refill_days', 'dripfeed_allowed', 'average_time'];
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
    if (!Object.keys(clean).length) {
        const e = new Error('No recognized fields to update.'); e.status = 422; e.code = 'EMPTY_PATCH'; throw e;
    }
    clean.updated_at = new Date().toISOString();

    const { data: before } = await supabaseAdmin
        .from('boost_services').select('*').eq('id', serviceId).maybeSingle();
    if (!before) { const e = new Error('Service not found.'); e.status = 404; e.code = 'SERVICE_NOT_FOUND'; throw e; }

    const { data: updated, error } = await supabaseAdmin
        .from('boost_services').update(clean).eq('id', serviceId).select('*').single();
    if (error) { const e = new Error('Failed to update service.'); e.status = 500; e.code = 'SERVICE_UPDATE_FAILED'; throw e; }

    await recordAudit({
        ctx, action: 'boost.service_update', targetId: serviceId,
        before: pickDiffable(before), after: clean, reason: null
    });

    return { service: updated };
}

function pickDiffable(svc) {
    return {
        name: svc.name, platform: svc.platform, category: svc.category,
        active: svc.active, visible_to_users: svc.visible_to_users,
        markup_percent: svc.markup_percent, custom_price: svc.custom_price,
        min_quantity: svc.min_quantity, max_quantity: svc.max_quantity
    };
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    ORDER_STATUSES,
    ALLOWED_TRANSITIONS,
    PENDING_STATUSES,
    FAILED_STATUSES,

    getUsdToNgnRate,
    getDefaultMarkup,
    computePrice,

    placeOrder,
    listOrders,
    getOrder,
    refundOrder,
    updateOrderStatus,
    getOverview,

    listServices,
    updateService,

    shapeOrder
};