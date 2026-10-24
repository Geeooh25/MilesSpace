// routes/marketRoutes.js
// MilesSpace Marketplace — Production router
// Handles: products, purchase (atomic), orders history, order detail, redownload.

'use strict';

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService, AdminConfigService } = require('../services/ledgerService');
const IdempotencyService = require('../services/idempotencyService');
const marketplace = require('../services/marketplaceService');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
//  GET /api/market/products
//  Auth: required
//  Query: page, limit, category, search, sort
// ═══════════════════════════════════════════════════════════════════
router.get('/products', authMiddleware, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 30));
        const offset = (page - 1) * limit;
        const category = (req.query.category || '').trim();
        const search = (req.query.search || '').trim();
        const sort = (req.query.sort || 'default').trim();

        // Explicit column selection — includes ALL detail fields
        let query = supabaseAdmin
            .from('marketplace_products')
            .select(`
                id,
                name,
                category_id,
                description,
                long_description,
                how_to_use,
                features,
                mail_access,
                login_tutorial,
                login_format,
                country,
                price_usd,
                price_ngn,
                stock,
                sold,
                delivery_type,
                status,
                created_at
            `, { count: 'exact' })
            .eq('status', 'Active');

        if (category && category !== 'all') {
            query = query.eq('category_id', category);
        }
        if (search) {
            const safe = search.replace(/[%_]/g, (m) => '\\' + m);
            query = query.ilike('name', `%${safe}%`);
        }

        if (sort === 'price-asc') query = query.order('price_usd', { ascending: true });
        else if (sort === 'price-desc') query = query.order('price_usd', { ascending: false });
        else if (sort === 'qty-desc') query = query.order('stock', { ascending: false });
        else if (sort === 'name-asc') query = query.order('name', { ascending: true });
        else query = query.order('created_at', { ascending: false });

        query = query.range(offset, offset + limit - 1);

        const { data, error, count } = await query;

        if (error) throw error;

        const products = (data || []).map(marketplace.sanitizeProduct);

        res.json({
            success: true,
            products,
            meta: {
                page,
                limit,
                total: count || 0,
                hasMore: offset + products.length < (count || 0),
            }
        });
    } catch (err) {
        console.error('[MARKET] /products error:', err.message);
        res.status(500).json({
            success: false,
            error: 'Could not load marketplace products',
            code: 'PRODUCTS_FETCH_FAILED'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/market/products/:id
// ═══════════════════════════════════════════════════════════════════
router.get('/products/:id', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('marketplace_products')
            .select(`
                id,
                name,
                category_id,
                description,
                long_description,
                how_to_use,
                features,
                mail_access,
                login_tutorial,
                login_format,
                country,
                price_usd,
                price_ngn,
                stock,
                sold,
                delivery_type,
                status,
                created_at
            `)
            .eq('id', req.params.id)
            .eq('status', 'Active')
            .maybeSingle();

        if (error) throw error;
        if (!data) {
            return res.status(404).json({ success: false, error: 'Product not found', code: 'NOT_FOUND' });
        }

        res.json({ success: true, product: marketplace.sanitizeProduct(data) });
    } catch (err) {
        console.error('[MARKET] /products/:id error:', err.message);
        res.status(500).json({ success: false, error: 'Could not load product', code: 'PRODUCT_FETCH_FAILED' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/market/purchase
// ═══════════════════════════════════════════════════════════════════
router.post('/purchase', authMiddleware, async (req, res) => {
    const userId = req.user?.id;
    const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotency_key;
    let createdOrderId = null;
    let ledgerTransactionId = null;
    let inventoryId = null;
    let unifiedTxId = null;

    try {
        const { product_id, wallet_type } = req.body || {};
        const wallet = String(wallet_type || '').toUpperCase();

        if (!product_id) {
            return res.status(400).json({ success: false, error: 'product_id is required', code: 'MISSING_PRODUCT' });
        }
        if (wallet !== 'NGN' && wallet !== 'USD') {
            return res.status(400).json({ success: false, error: 'wallet_type must be NGN or USD', code: 'INVALID_WALLET' });
        }

        // ─── 1. Idempotency ───
        const endpoint = '/api/market/purchase';
        if (idempotencyKey) {
            const existing = await IdempotencyService.check(userId, idempotencyKey, endpoint);
            if (existing) {
                return res.json({ success: true, already_processed: true, purchase: existing });
            }
        }

        // ─── 2. Fetch product ───
        const { data: product, error: prodErr } = await supabaseAdmin
            .from('marketplace_products')
            .select('id, name, category_id, price_usd, price_ngn, stock, status, delivery_type')
            .eq('id', product_id)
            .eq('status', 'Active')
            .maybeSingle();

        if (prodErr) throw prodErr;
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found', code: 'NOT_FOUND' });
        }

        // ─── 3. Price ───
        const pricing = await marketplace.computePrice(product, wallet);
        const requiredAmount = pricing.charge;

        if (!Number.isFinite(requiredAmount) || requiredAmount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid product price', code: 'INVALID_PRICE' });
        }

        // ─── 4. Balance ───
        const balance = await LedgerService.getBalance(userId, wallet);
        if (balance < requiredAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient ${wallet} balance. Need ${wallet === 'USD' ? '$' : '₦'}${requiredAmount.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE'
            });
        }

        // ─── 5. IDs ───
        const orderId = marketplace.generateOrderId();       // UUID
        const orderRef = marketplace.generateOrderRef();
        const downloadToken = marketplace.generateDownloadToken();

        // ─── 6. Allocate inventory ───
        const { data: allocRows, error: allocError } = await supabaseAdmin.rpc(
            'allocate_marketplace_inventory',
            {
                p_product_id: product.id,
                p_user_id: userId,
                p_order_id: orderId,
            }
        );

        if (allocError) throw allocError;
        if (!allocRows || allocRows.length === 0) {
            return res.status(400).json({ success: false, error: 'Out of stock', code: 'OUT_OF_STOCK' });
        }

        const inventoryRow = allocRows[0];
        inventoryId = inventoryRow.id;

        // ─── 7. Create order ───
        const deliveryPayload = marketplace.buildDeliveryPayload(inventoryRow, {
            product_title: product.name
        }, product);

        const { data: order, error: orderError } = await supabaseAdmin
            .from('marketplace_orders')
            .insert({
                id: orderId,                    // UUID
                order_ref: orderRef,
                user_id: userId,
                product_id: product.id,
                product_name: product.name,
                product_title: product.name,
                quantity: 1,
                total: requiredAmount,
                currency: wallet,
                wallet: wallet,
                wallet_used: wallet,
                price_usd: pricing.usd,
                price_ngn: pricing.ngn,
                status: 'pending',
                inventory_id: inventoryId,
                download_token: downloadToken,
                download_count: 0,
                delivered_data: deliveryPayload,
                idempotency_key: idempotencyKey || null,
                created_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (orderError) {
            await supabaseAdmin
                .from('marketplace_inventory')
                .update({ status: 'available', sold_to_user_id: null, sold_order_id: null, sold_at: null })
                .eq('id', inventoryId);
            throw orderError;
        }
        createdOrderId = order.id;

        // ─── 8. Debit wallet ───
        let txResult;
        try {
            txResult = await LedgerService.createTransaction({
                userId,
                type: 'marketplace_purchase',
                amount: -requiredAmount,
                currency: wallet,
                description: `Purchased: ${product.name}`,
                reference: orderRef,
                sourceType: 'order',
                sourceId: order.id,             // ← valid UUID
                provider: 'marketplace',
                metadata: {
                    product_id: product.id,
                    product_name: product.name,
                    order_ref: orderRef,
                    inventory_id: inventoryId,
                },
                idempotencyKey: idempotencyKey || IdempotencyService.generateKey('MP'),
            });
        } catch (txErr) {
            await supabaseAdmin.from('marketplace_orders').delete().eq('id', order.id);
            await supabaseAdmin
                .from('marketplace_inventory')
                .update({ status: 'available', sold_to_user_id: null, sold_order_id: null, sold_at: null })
                .eq('id', inventoryId);
            throw txErr;
        }

        if (!txResult?.success) {
            await supabaseAdmin.from('marketplace_orders').delete().eq('id', order.id);
            await supabaseAdmin
                .from('marketplace_inventory')
                .update({ status: 'available', sold_to_user_id: null, sold_order_id: null, sold_at: null })
                .eq('id', inventoryId);
            throw new Error(txResult?.error || 'Ledger debit failed');
        }
        ledgerTransactionId = txResult.transaction_id;

        // ─── 9. Mark order completed ───
        await supabaseAdmin
            .from('marketplace_orders')
            .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', order.id);

        // ─── 9b. Insert into UNIFIED transactions table ───
        try {
            const walletLabel = wallet === 'USD' ? 'USD' : 'NGN';
            const unifiedRow = {
                user_id: userId,
                reference: orderRef,
                type: 'marketplace_purchase',
                status: 'completed',
                currency: walletLabel,
                amount: requiredAmount,
                fee: 0,
                description: `Marketplace: ${product.name}`,
                source_type: 'marketplace',
                source_id: order.id,           // ← UUID
                provider: 'marketplace',
                provider_reference: null,
                metadata: {
                    product_id: product.id,
                    product_name: product.name,
                    order_ref: orderRef,
                    inventory_id: inventoryId,
                    ledger_transaction_id: ledgerTransactionId,
                },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
            };

            const { data: unifiedTx, error: unifiedErr } = await supabaseAdmin
                .from('transactions')
                .insert(unifiedRow)
                .select('id')
                .single();

            if (!unifiedErr && unifiedTx) {
                unifiedTxId = unifiedTx.id;
                await supabaseAdmin
                    .from('marketplace_orders')
                    .update({ unified_transaction_id: unifiedTxId })
                    .eq('id', order.id);
            } else if (unifiedErr) {
                console.warn('[MARKET] Unified tx insert failed (non-fatal):', unifiedErr.message);
            }
        } catch (e) {
            console.warn('[MARKET] Unified tx error (non-fatal):', e.message);
        }

        // ─── 10. Increment sold (best-effort) ───
        try {
            await supabaseAdmin.rpc('increment_marketplace_sold', { p_product_id: product.id });
        } catch {}

        // ─── 11. Save idempotency ───
        const purchaseResponse = {
            order_ref: orderRef,
            order_id: order.id,
            product_name: product.name,
            price: requiredAmount,
            currency: wallet,
            new_balance: txResult.balance_after,
            download_token: downloadToken,
            transaction_id: txResult.transaction_id,
            unified_transaction_id: unifiedTxId,
        };

        if (idempotencyKey) {
            await IdempotencyService.save(userId, idempotencyKey, endpoint, purchaseResponse);
        }

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, purchase: purchaseResponse });
    } catch (error) {
        console.error('[MARKET] Purchase error:', error);
        try {
            if (createdOrderId && !ledgerTransactionId) {
                await supabaseAdmin.from('marketplace_orders').delete().eq('id', createdOrderId);
            }
            if (inventoryId && !ledgerTransactionId) {
                await supabaseAdmin
                    .from('marketplace_inventory')
                    .update({ status: 'available', sold_to_user_id: null, sold_order_id: null, sold_at: null })
                    .eq('id', inventoryId);
            }
        } catch (cleanupErr) {
            console.error('[MARKET] Cleanup error:', cleanupErr.message);
        }
        res.status(500).json({
            success: false,
            error: error.message || 'Purchase failed',
            code: 'PURCHASE_FAILED'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/market/orders
// ═══════════════════════════════════════════════════════════════════
router.get('/orders', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const { data, error, count } = await supabaseAdmin
            .from('marketplace_orders')
            .select(`
                id,
                order_ref,
                product_id,
                product_name,
                product_title,
                quantity,
                total,
                currency,
                wallet,
                wallet_used,
                price_usd,
                price_ngn,
                status,
                download_count,
                last_download_at,
                created_at,
                completed_at
            `, { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        const orders = (data || []).map(marketplace.sanitizeOrderRow);

        res.json({
            success: true,
            data: orders,
            meta: {
                page,
                limit,
                total: count || 0,
                hasMore: offset + orders.length < (count || 0),
            }
        });
    } catch (err) {
        console.error('[MARKET] /orders error:', err.message);
        res.status(500).json({ success: false, error: 'Could not load orders', code: 'ORDERS_FETCH_FAILED' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/market/orders/:id
// ═══════════════════════════════════════════════════════════════════
router.get('/orders/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;

        const { data, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select(`
                id,
                order_ref,
                user_id,
                product_id,
                product_name,
                product_title,
                quantity,
                total,
                currency,
                wallet,
                wallet_used,
                price_usd,
                price_ngn,
                status,
                download_count,
                last_download_at,
                created_at,
                completed_at,
                delivered_data
            `)
            .eq('id', req.params.id)
            .eq('user_id', userId)  // ← ownership check
            .maybeSingle();

        if (error) throw error;
        if (!data) {
            return res.status(404).json({ success: false, error: 'Order not found', code: 'NOT_FOUND' });
        }

        const order = marketplace.sanitizeOrderRow(data);
        order.delivery = data.delivered_data || null;

        res.json({ success: true, order });
    } catch (err) {
        console.error('[MARKET] /orders/:id error:', err.message);
        res.status(500).json({ success: false, error: 'Could not load order', code: 'ORDER_FETCH_FAILED' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/market/orders/:id/download
// ═══════════════════════════════════════════════════════════════════
router.get('/orders/:id/download', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;

        const { data: order, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select(`
                id,
                order_ref,
                user_id,
                product_name,
                product_title,
                wallet,
                wallet_used,
                price_usd,
                price_ngn,
                status,
                download_count,
                delivered_data,
                created_at
            `)
            .eq('id', req.params.id)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found', code: 'NOT_FOUND' });
        }
        if (order.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Order is not completed', code: 'ORDER_NOT_COMPLETED' });
        }

        let downloadCount = (order.download_count || 0) + 1;
        try {
            const { data: newCount, error: incErr } = await supabaseAdmin.rpc(
                'increment_marketplace_download',
                { p_order_id: order.id }
            );
            if (!incErr && Number.isFinite(newCount)) downloadCount = newCount;
        } catch (incErr) {
            console.warn('[MARKET] Download counter RPC failed (non-fatal):', incErr.message);
        }

        const delivery = order.delivered_data || {};
        const wallet = order.wallet_used || order.wallet || 'NGN';
        const amount = wallet === 'USD'
            ? parseFloat(order.price_usd) || 0
            : parseFloat(order.price_ngn) || parseFloat(order.total) || 0;

        const lines = [
            '═══════════════════════════════════════════════',
            '  📦 MILESPACE ORDER DETAILS',
            '═══════════════════════════════════════════════',
            '',
            `Order ID:    ${order.order_ref}`,
            `Product:     ${order.product_title || order.product_name}`,
            `Date:        ${new Date(order.created_at).toLocaleString('en-NG')}`,
            `Wallet:      ${wallet}`,
            `Amount:      ${wallet === 'USD' ? '$' : '₦'}${amount.toFixed(2)}`,
            `Downloads:   ${downloadCount}`,
            '',
            '────────── DELIVERY DETAILS ──────────',
            '',
            `Format:      ${delivery.login_format || 'N/A'}`,
            '',
            'Instructions:',
            delivery.login_instructions || 'No instructions provided.',
            '',
            'Content:',
            typeof delivery.content === 'string'
                ? delivery.content
                : JSON.stringify(delivery.content || {}, null, 2),
            '',
            '───────────────────────────────────────',
            `Downloaded:  ${new Date().toISOString()}`,
            '═══════════════════════════════════════════════',
        ];

        const filename = `order_${order.order_ref}.txt`;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(lines.join('\n'));
    } catch (err) {
        console.error('[MARKET] /orders/:id/download error:', err.message);
        res.status(500).json({ success: false, error: 'Download failed', code: 'DOWNLOAD_FAILED' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  LEGACY: GET /api/market/download/:token
// ═══════════════════════════════════════════════════════════════════
router.get('/download/:token', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;

        const { data: order, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select('id')
            .eq('download_token', req.params.token)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found', code: 'NOT_FOUND' });
        }

        return res.redirect(`/api/market/orders/${order.id}/download`);
    } catch (err) {
        console.error('[MARKET] legacy /download error:', err.message);
        res.status(500).json({ success: false, error: 'Download failed', code: 'DOWNLOAD_FAILED' });
    }
});

module.exports = router;