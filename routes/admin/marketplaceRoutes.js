// routes/admin/marketAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Marketplace API — routes only.
//
//   GET    /api/admin/marketplace/stats
//   GET    /api/admin/marketplace/products
//   GET    /api/admin/marketplace/products/:id
//   POST   /api/admin/marketplace/products
//   PUT    /api/admin/marketplace/products/:id
//   DELETE /api/admin/marketplace/products/:id
//
//   GET    /api/admin/marketplace/categories
//   POST   /api/admin/marketplace/categories
//   PUT    /api/admin/marketplace/categories/:id
//   DELETE /api/admin/marketplace/categories/:id
//
//   GET    /api/admin/marketplace/inventory/:productId
//   POST   /api/admin/marketplace/inventory
//   PUT    /api/admin/marketplace/inventory/:id
//   DELETE /api/admin/marketplace/inventory/:id
//
//   GET    /api/admin/marketplace/orders
//   GET    /api/admin/marketplace/orders/:id
//   POST   /api/admin/marketplace/orders/:id/refund
//   POST   /api/admin/marketplace/orders/:id/complete
//   POST   /api/admin/marketplace/orders/:id/fail
//
//   GET    /api/admin/marketplace/search
//
// Uses the SAME admin authentication as the rest of the admin
// (requirePermission from middleware/adminAuth.js). Do not roll a
// second auth system.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { supabaseAdmin } = require('../../db/supabase');
const { requirePermission, PERMISSIONS, recordAdminAction } = require('../../middleware/adminAuth');
const { LedgerService } = require('../../services/ledgerService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Helpers ─────────────────────────────────────────────────────

function generateId(prefix) {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function sendOk(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }

function sendErr(res, req, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'MARKETPLACE_ERROR';
    const message = err?.message || 'Marketplace request failed';
    if (status >= 500) console.error('[ADMIN MARKET]', code, message);
    res.status(status).json({
        success: false,
        code,
        error: message,
        request_id: req.marketRequestId || null
    });
}

router.use((req, res, next) => {
    req.marketRequestId = req.headers['x-request-id']
        || `MK-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    res.setHeader('X-Request-ID', req.marketRequestId);
    next();
});

function ctxFrom(req) {
    return {
        adminId:    req.adminContext?.id    || null,
        adminEmail: req.adminContext?.email || null,
        ip:         req.ip || req.headers['x-forwarded-for'] || null,
        userAgent:  req.headers['user-agent'] || null,
        requestId:  req.marketRequestId
    };
}

// ═════════════════════════════════════════════════════════════════
//  STATS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/stats',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const [productsRes, ordersRes, inventoryRes] = await Promise.all([
                supabaseAdmin.from('marketplace_products').select('status, stock, sold, price_usd, price_ngn'),
                supabaseAdmin.from('marketplace_orders').select('status, total, currency, created_at'),
                supabaseAdmin.from('marketplace_inventory').select('status')
            ]);

            const products = productsRes.data || [];
            const orders = ordersRes.data || [];
            const inventory = inventoryRes.data || [];

            const totalProducts = products.length;
            const active = products.filter(p => p.status === 'Active').length;
            const totalStock = products.reduce((s, p) => s + (p.stock || 0), 0);
            const totalSold = products.reduce((s, p) => s + (p.sold || 0), 0);
            const lowStock = products.filter(p => p.stock > 0 && p.stock < 10).length;
            const outOfStock = products.filter(p => p.stock === 0).length;

            const totalOrders = orders.length;
            const pending = orders.filter(o => ['pending', 'processing'].includes(String(o.status || '').toLowerCase())).length;
            const completed = orders.filter(o => String(o.status || '').toLowerCase() === 'completed').length;

            const usdRev = orders
                .filter(o => o.currency === 'USD' && o.status === 'completed')
                .reduce((s, o) => s + Number(o.total || 0), 0);
            const ngnRev = orders
                .filter(o => o.currency === 'NGN' && o.status === 'completed')
                .reduce((s, o) => s + Number(o.total || 0), 0);

            const available = inventory.filter(i => i.status === 'available').length;
            const soldItems = inventory.filter(i => i.status === 'sold').length;

            sendOk(res, {
                stats: {
                    totalProducts, active, totalStock, totalSold,
                    lowStock, outOfStock,
                    totalOrders, pending, completed,
                    usdRev: usdRev.toFixed(2),
                    ngnRev: ngnRev.toFixed(2),
                    available, soldItems
                }
            });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PRODUCTS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/products',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const { data, error } = await supabaseAdmin
                .from('marketplace_products')
                .select('*, marketplace_categories!marketplace_products_category_id_fkey(name, icon)')
                .order('created_at', { ascending: false });
            if (error) throw error;

            const products = (data || []).map(p => ({
                ...p,
                category_name: p.marketplace_categories?.name || null,
                category_icon: p.marketplace_categories?.icon || '📦',
                marketplace_categories: undefined
            }));

            sendOk(res, { products });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/marketplace/products/:id',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const { data, error } = await supabaseAdmin
                .from('marketplace_products')
                .select('*')
                .eq('id', req.params.id)
                .maybeSingle();
            if (error) throw error;
            if (!data) {
                const e = new Error('Product not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
            }
            sendOk(res, { product: data });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/products',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const {
                name, category_id, description,
                long_description, how_to_use, features,
                country, price_usd, price_ngn,
                delivery_type, inventory_items = [],
                status = 'Active'
            } = req.body || {};

            if (!name || !category_id || price_usd === undefined) {
                const e = new Error('name, category_id, and price_usd are required');
                e.status = 422; e.code = 'MISSING_FIELDS'; throw e;
            }

            const productId = generateId('PRD');
            const inventoryRaw = Array.isArray(inventory_items) ? inventory_items.join('\n') : '';

            const { data: product, error: prodErr } = await supabaseAdmin
                .from('marketplace_products')
                .insert({
                    id: productId,
                    name,
                    category_id,
                    description: description || '',
                    long_description: long_description || '',
                    how_to_use: how_to_use || '',
                    features: features || '',
                    country: country || 'Global',
                    price_usd,
                    price_ngn: price_ngn || Math.round(Number(price_usd) * 1600),
                    stock: inventory_items.length,
                    sold: 0,
                    delivery_type: delivery_type || 'structured',
                    inventory_raw: inventoryRaw,
                    status,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .select()
                .single();

            if (prodErr) throw prodErr;

            if (inventory_items.length > 0) {
                const inventoryData = inventory_items.map(content => ({
                    id: generateId('INV'),
                    product_id: productId,
                    product_name: name,
                    delivery_type: delivery_type || 'structured',
                    content,
                    status: 'available',
                    used_by: null,
                    created_at: new Date().toISOString()
                }));
                await supabaseAdmin.from('marketplace_inventory').insert(inventoryData);
            }

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.product_create',
                targetType: 'marketplace_product',
                targetId: productId,
                after: { name, price_usd, category_id },
                req
            });

            sendOk(res, { product });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.put(
    '/marketplace/products/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const patch = { ...req.body, updated_at: new Date().toISOString() };
            delete patch.id;

            if (patch.price_usd !== undefined && patch.price_ngn === undefined) {
                patch.price_ngn = Math.round(Number(patch.price_usd) * 1600);
            }

            const { data, error } = await supabaseAdmin
                .from('marketplace_products')
                .update(patch)
                .eq('id', id)
                .select()
                .single();
            if (error) throw error;

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.product_update',
                targetType: 'marketplace_product',
                targetId: id,
                after: patch,
                req
            });

            sendOk(res, { product: data });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.delete(
    '/marketplace/products/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            await supabaseAdmin.from('marketplace_inventory').delete().eq('product_id', id);
            const { error } = await supabaseAdmin.from('marketplace_products').delete().eq('id', id);
            if (error) throw error;

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.product_delete',
                targetType: 'marketplace_product',
                targetId: id,
                req
            });

            sendOk(res, { message: 'Product deleted' });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  CATEGORIES
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/categories',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const { data, error } = await supabaseAdmin
                .from('marketplace_categories')
                .select('*')
                .order('name');
            if (error) throw error;
            sendOk(res, { categories: data || [] });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/categories',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const { name, icon, status = 'Active' } = req.body || {};
            if (!name) {
                const e = new Error('name is required'); e.status = 422; e.code = 'MISSING_NAME'; throw e;
            }
            const { data, error } = await supabaseAdmin
                .from('marketplace_categories')
                .insert({
                    id: generateId('CAT'),
                    name,
                    icon: icon || '📦',
                    status,
                    created_at: new Date().toISOString()
                })
                .select()
                .single();
            if (error) throw error;

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.category_create',
                targetType: 'marketplace_category',
                targetId: data.id,
                after: { name, icon },
                req
            });

            sendOk(res, { category: data });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.put(
    '/marketplace/categories/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { name, icon, status } = req.body || {};
            const { data, error } = await supabaseAdmin
                .from('marketplace_categories')
                .update({ name, icon, status, updated_at: new Date().toISOString() })
                .eq('id', id)
                .select()
                .single();
            if (error) throw error;

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.category_update',
                targetType: 'marketplace_category',
                targetId: id,
                after: { name, icon, status },
                req
            });

            sendOk(res, { category: data });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.delete(
    '/marketplace/categories/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const { error } = await supabaseAdmin
                .from('marketplace_categories')
                .delete()
                .eq('id', req.params.id);
            if (error) throw error;

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.category_delete',
                targetType: 'marketplace_category',
                targetId: req.params.id,
                req
            });

            sendOk(res, { message: 'Category deleted' });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  INVENTORY
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/inventory/:productId',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const { productId } = req.params;
            const { status } = req.query;
            let q = supabaseAdmin
                .from('marketplace_inventory')
                .select('*')
                .eq('product_id', productId)
                .order('created_at', { ascending: false });
            if (status && status !== 'all') q = q.eq('status', status);
            const { data, error } = await q;
            if (error) throw error;
            sendOk(res, { inventory: data || [] });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/inventory',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const { product_id, items, delivery_type } = req.body || {};
            if (!product_id || !Array.isArray(items) || items.length === 0) {
                const e = new Error('product_id and items[] are required'); e.status = 422; e.code = 'MISSING_FIELDS'; throw e;
            }

            const { data: product, error: prodErr } = await supabaseAdmin
                .from('marketplace_products')
                .select('name, delivery_type, stock')
                .eq('id', product_id)
                .single();
            if (prodErr) throw prodErr;

            const dtype = delivery_type || product.delivery_type || 'structured';
            const inventoryData = items.map(content => ({
                id: generateId('INV'),
                product_id,
                product_name: product.name,
                delivery_type: dtype,
                content,
                status: 'available',
                used_by: null,
                created_at: new Date().toISOString()
            }));

            const { error: invErr } = await supabaseAdmin
                .from('marketplace_inventory')
                .insert(inventoryData);
            if (invErr) throw invErr;

            const newStock = (product.stock || 0) + items.length;
            await supabaseAdmin
                .from('marketplace_products')
                .update({ stock: newStock, updated_at: new Date().toISOString() })
                .eq('id', product_id);

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.inventory_add',
                targetType: 'marketplace_product',
                targetId: product_id,
                after: { added: items.length, new_stock: newStock },
                req
            });

            sendOk(res, { added: items.length, new_stock: newStock });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.put(
    '/marketplace/inventory/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { content, status, used_by } = req.body || {};
            const { data, error } = await supabaseAdmin
                .from('marketplace_inventory')
                .update({ content, status, used_by: used_by || null, updated_at: new Date().toISOString() })
                .eq('id', id)
                .select()
                .single();
            if (error) throw error;

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.inventory_update',
                targetType: 'marketplace_inventory',
                targetId: id,
                after: { status },
                req
            });

            sendOk(res, { inventory: data });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.delete(
    '/marketplace/inventory/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { data: item, error: findErr } = await supabaseAdmin
                .from('marketplace_inventory')
                .select('product_id')
                .eq('id', id)
                .single();
            if (findErr) throw findErr;

            const { error } = await supabaseAdmin.from('marketplace_inventory').delete().eq('id', id);
            if (error) throw error;

            if (item) {
                const { data: product } = await supabaseAdmin
                    .from('marketplace_products')
                    .select('stock')
                    .eq('id', item.product_id)
                    .single();
                if (product && product.stock > 0) {
                    await supabaseAdmin
                        .from('marketplace_products')
                        .update({ stock: product.stock - 1, updated_at: new Date().toISOString() })
                        .eq('id', item.product_id);
                }
            }

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.inventory_delete',
                targetType: 'marketplace_inventory',
                targetId: id,
                req
            });

            sendOk(res, { message: 'Inventory item deleted' });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  ORDERS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const { status, limit = 50, page = 1 } = req.query;
            const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

            let q = supabaseAdmin
                .from('marketplace_orders')
                .select('*', { count: 'exact' })
                .order('created_at', { ascending: false });
            if (status && status !== 'all') q = q.eq('status', status);
            q = q.range(offset, offset + parseInt(limit, 10) - 1);

            const { data, error, count } = await q;
            if (error) throw error;

            const rows = data || [];
            const userIds = [...new Set(rows.map(o => o.user_id).filter(Boolean))];
            let usersById = {};
            if (userIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email')
                    .in('id', userIds);
                (profiles || []).forEach(p => { usersById[p.id] = p; });
            }

            const orders = rows.map(o => ({
                ...o,
                user_name: usersById[o.user_id]?.username || o.customer_name || 'Unknown',
                user_email: usersById[o.user_id]?.email || o.email || null
            }));

            sendOk(res, {
                orders,
                count: count || 0,
                page: parseInt(page, 10),
                totalPages: Math.ceil((count || 0) / parseInt(limit, 10))
            });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/marketplace/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { data, error } = await supabaseAdmin
                .from('marketplace_orders')
                .select('*')
                .eq('id', req.params.id)
                .maybeSingle();
            if (error) throw error;
            if (!data) {
                const e = new Error('Order not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
            }

            let transaction = null;
            if (data.unified_transaction_id) {
                const { data: tx } = await supabaseAdmin
                    .from('transactions')
                    .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
                    .eq('id', data.unified_transaction_id)
                    .maybeSingle();
                transaction = tx || null;
            }

            sendOk(res, { order: data, transaction });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/orders/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }

            const { data: order, error: fetchErr } = await supabaseAdmin
                .from('marketplace_orders')
                .select('id, user_id, product_name, total, currency, status, unified_transaction_id')
                .eq('id', req.params.id)
                .maybeSingle();
            if (fetchErr) throw fetchErr;
            if (!order) {
                const e = new Error('Order not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
            }
            const current = String(order.status || '').toLowerCase();
            if (current === 'refunded') {
                const e = new Error('Order is already refunded'); e.status = 409; e.code = 'ALREADY_REFUNDED'; throw e;
            }
            if (current !== 'completed' && current !== 'failed' && current !== 'cancelled') {
                const e = new Error('Only completed, failed, or cancelled orders can be refunded');
                e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
            }
            if (!order.unified_transaction_id) {
                const e = new Error('Order has no wallet transaction'); e.status = 422; e.code = 'NO_TRANSACTION'; throw e;
            }

            const { data: originalTx } = await supabaseAdmin
                .from('transactions')
                .select('id, user_id, type, status, currency, amount')
                .eq('id', order.unified_transaction_id)
                .maybeSingle();
            if (!originalTx) {
                const e = new Error('Original transaction not found'); e.status = 404; e.code = 'TX_NOT_FOUND'; throw e;
            }
            if (String(originalTx.status).toLowerCase() !== 'completed') {
                const e = new Error('Original transaction is not completed'); e.status = 422; e.code = 'TX_NOT_REFUNDABLE'; throw e;
            }

            const { data: existingRefund } = await supabaseAdmin
                .from('transactions')
                .select('id, reference, amount, currency')
                .eq('source_id', originalTx.id)
                .eq('type', 'refund')
                .maybeSingle();

            if (existingRefund) {
                await supabaseAdmin
                    .from('marketplace_orders')
                    .update({ status: 'refunded', refunded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    .neq('status', 'refunded');
                return sendOk(res, {
                    refund: {
                        transaction_id: existingRefund.id,
                        reference: existingRefund.reference,
                        amount: existingRefund.amount,
                        currency: existingRefund.currency,
                        already_refunded: true
                    }
                });
            }

            let credit;
            try {
                credit = await LedgerService.creditWallet({
                    userId: order.user_id,
                    amount: originalTx.amount,
                    currency: originalTx.currency,
                    description: `Marketplace refund — ${order.product_name}`,
                    type: 'refund',
                    sourceType: 'marketplace_order',
                    sourceId: originalTx.id,
                    reference: `MKTREF-${order.id}`,
                    metadata: { order_id: order.id, reason }
                });
            } catch (ledgerErr) {
                const e = new Error(ledgerErr.message || 'Wallet refund failed');
                e.status = 400; e.code = 'LEDGER_REFUND_FAILED'; throw e;
            }

            await supabaseAdmin
                .from('marketplace_orders')
                .update({
                    status: 'refunded',
                    refunded_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', order.id);

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.order_refund',
                targetType: 'marketplace_order',
                targetId: order.id,
                before: { status: current },
                after: { status: 'refunded', refund_transaction_id: credit.transaction_id },
                reason,
                req
            });

            sendOk(res, {
                refund: {
                    transaction_id: credit.transaction_id || null,
                    reference: credit.reference || null,
                    amount: originalTx.amount,
                    currency: originalTx.currency,
                    already_refunded: false
                }
            });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/orders/:id/complete',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const { data: order } = await supabaseAdmin
                .from('marketplace_orders')
                .select('id, status')
                .eq('id', req.params.id)
                .maybeSingle();
            if (!order) {
                const e = new Error('Order not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
            }
            const current = String(order.status || '').toLowerCase();
            if (current === 'completed') return sendOk(res, { no_op: true });
            if (!['pending', 'processing'].includes(current)) {
                const e = new Error(`Cannot complete a ${current} order`);
                e.status = 422; e.code = 'INVALID_TRANSITION'; throw e;
            }

            await supabaseAdmin
                .from('marketplace_orders')
                .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', order.id);

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.order_complete',
                targetType: 'marketplace_order',
                targetId: order.id,
                before: { status: current },
                after: { status: 'completed' },
                reason,
                req
            });

            sendOk(res, { message: 'Order marked completed' });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/orders/:id/fail',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const { data: order } = await supabaseAdmin
                .from('marketplace_orders')
                .select('id, status')
                .eq('id', req.params.id)
                .maybeSingle();
            if (!order) {
                const e = new Error('Order not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
            }
            const current = String(order.status || '').toLowerCase();
            if (current === 'failed') return sendOk(res, { no_op: true });
            if (!['pending', 'processing'].includes(current)) {
                const e = new Error(`Cannot fail a ${current} order`);
                e.status = 422; e.code = 'INVALID_TRANSITION'; throw e;
            }

            await supabaseAdmin
                .from('marketplace_orders')
                .update({ status: 'failed', failed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', order.id);

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'marketplace.order_fail',
                targetType: 'marketplace_order',
                targetId: order.id,
                before: { status: current },
                after: { status: 'failed' },
                reason,
                req
            });

            sendOk(res, { message: 'Order marked failed' });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  SEARCH
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/search',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const q = String(req.query.q || '').trim();
            if (!q || q.length < 2) {
                return sendOk(res, { results: { products: [], orders: [], inventory: [] } });
            }
            const safe = q.replace(/[%_]/g, m => '\\' + m);
            const term = `%${safe}%`;

            const [prodRes, orderRes, invRes] = await Promise.all([
                supabaseAdmin
                    .from('marketplace_products')
                    .select('id, name, category_id, price_usd, price_ngn, stock, status')
                    .or(`name.ilike.${term},id.ilike.${term}`)
                    .limit(10),
                supabaseAdmin
                    .from('marketplace_orders')
                    .select('id, order_ref, customer_name, email, product_name, total, status')
                    .or(`order_ref.ilike.${term},customer_name.ilike.${term},email.ilike.${term},product_name.ilike.${term}`)
                    .limit(10),
                supabaseAdmin
                    .from('marketplace_inventory')
                    .select('id, product_name, content, status')
                    .or(`content.ilike.${term},product_name.ilike.${term},id.ilike.${term}`)
                    .limit(10)
            ]);

            sendOk(res, {
                results: {
                    products: prodRes.data || [],
                    orders: orderRes.data || [],
                    inventory: invRes.data || []
                }
            });
        } catch (err) { sendErr(res, req, err); }
    }
);

module.exports = router;