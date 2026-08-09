const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'miles-exchange-secret-key-2024';

// ─── HELPER: Generate Reference ───
function generateReference(prefix = 'GFT') {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
}

// ─── ADMIN VERIFICATION MIDDLEWARE (DEFINED FIRST) ───
function verifyAdminToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }
    try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, JWT_SECRET);
        const role = decoded.role || decoded.user?.role;
        if (role !== 'admin' && role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        req.adminId = decoded.userId || decoded.sub || decoded.id || decoded.user?.id;
        req.adminRole = role;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

// ─── CREATE TRANSACTION ───
async function createTransaction(userId, orderId, type, description, amountNGN, amountUSD, currency, status, ref, meta = {}) {
    try {
        const isUSD = currency === 'USD';
        const transactionData = {
            user_id: userId,
            order_id: orderId,
            type: type,
            category: 'debit',
            description: description,
            currency: currency,
            status: status,
            ref: ref,
            wallet_used: currency,
            meta: meta,
            created_at: new Date().toISOString()
        };

        if (isUSD) {
            transactionData.amount_ngn = 0;
            transactionData.amount_usd = -amountUSD;
            transactionData.revenue_ngn = 0;
            transactionData.revenue_usd = amountUSD;
        } else {
            transactionData.amount_ngn = -amountNGN;
            transactionData.amount_usd = 0;
            transactionData.revenue_ngn = amountNGN;
            transactionData.revenue_usd = 0;
        }

        const { data, error } = await supabaseAdmin
            .from('transactions')
            .insert(transactionData)
            .select()
            .single();

        if (error) {
            console.error('Transaction creation error:', error);
            return null;
        }
        return data;
    } catch (error) {
        console.error('Transaction error:', error);
        return null;
    }
}

// ─── CREATE NOTIFICATION ───
async function createNotification(userId, title, message, type = 'info', link = null) {
    try {
        const { data, error } = await supabaseAdmin
            .from('notifications')
            .insert({
                user_id: userId,
                title: title,
                message: message,
                type: type,
                icon: getNotificationIcon(type),
                link: link,
                is_read: false,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            console.error('Notification creation error:', error);
            return null;
        }
        return data;
    } catch (error) {
        console.error('Notification error:', error);
        return null;
    }
}

function getNotificationIcon(type) {
    const icons = {
        'gift_ordered': '🎁',
        'gift_shipped': '🚚',
        'gift_delivered': '✅',
        'gift_cancelled': '❌',
        'info': '📌',
        'success': '✅',
        'error': '❌',
        'warning': '⚠️'
    };
    return icons[type] || '📌';
}

// ════════════════════════════════════════════════
// USER ROUTES - Mounted at /api/gifts
// ════════════════════════════════════════════════

// ─── GET /api/gifts/products ───
router.get('/products', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('gift_products')
            .select('*')
            .eq('active', true)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, products: data || [] });
    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── POST /api/gifts/order ───
router.post('/order', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            product_id, product_name, image_url,
            recipient_name, recipient_phone, recipient_email,
            recipient_country, recipient_address, recipient_city,
            recipient_state, recipient_zip,
            message, quantity, price_ngn, price_usd,
            wallet_type, delivery_speed, gift_wrap,
            occasion, delivery_date
        } = req.body;

        if (!recipient_name || !recipient_country || !recipient_address) {
            return res.status(400).json({ success: false, error: 'Recipient details required' });
        }

        const isUSD = String(wallet_type || 'NGN').toUpperCase() === 'USD';
        const currencyLabel = isUSD ? 'USD' : 'NGN';
        const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';

        const totalNGN = (parseFloat(price_ngn) || 0) * (parseInt(quantity) || 1) + (gift_wrap ? 5000 : 0);
        const totalUSD = (parseFloat(price_usd) || 0) * (parseInt(quantity) || 1) + (gift_wrap ? 3 : 0);
        const requiredAmount = isUSD ? totalUSD : totalNGN;

        const { data: userData, error: userErr } = await supabaseAdmin
            .from('profiles')
            .select(`${walletField}, email, username`)
            .eq('id', userId)
            .single();

        if (userErr) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const balance = parseFloat(userData?.[walletField] || 0);
        if (balance < requiredAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient ${currencyLabel} balance. Need ${isUSD ? '$' : '₦'}${requiredAmount.toFixed(2)}`
            });
        }

        const newBalance = balance - requiredAmount;
        await supabaseAdmin
            .from('profiles')
            .update({ [walletField]: newBalance })
            .eq('id', userId);

        const orderRef = generateReference('GFT');

        const { data: order, error: orderErr } = await supabaseAdmin
            .from('gift_orders')
            .insert({
                user_id: userId,
                product_id: product_id || null,
                product_name: product_name || 'Gift Bundle',
                image_url: image_url || null,
                recipient_name,
                recipient_phone: recipient_phone || null,
                recipient_email: recipient_email || null,
                recipient_country,
                recipient_address,
                recipient_city: recipient_city || null,
                recipient_state: recipient_state || null,
                recipient_zip: recipient_zip || null,
                message: message || '',
                quantity: parseInt(quantity) || 1,
                price_ngn: totalNGN,
                price_usd: totalUSD,
                wallet_used: currencyLabel,
                delivery_speed: delivery_speed || 'standard',
                gift_wrap: gift_wrap || false,
                occasion: occasion || null,
                delivery_date: delivery_date || null,
                status: 'pending',
                order_ref: orderRef,
                created_at: new Date().toISOString(),
                user_email: userData.email,
                user_username: userData.username
            })
            .select()
            .single();

        if (orderErr) {
            console.error('Gift order creation error:', orderErr);
            await supabaseAdmin
                .from('profiles')
                .update({ [walletField]: balance })
                .eq('id', userId);
            return res.status(500).json({ success: false, error: 'Failed to create order' });
        }

        // ─── Create Transaction ───
        await createTransaction(
            userId,
            order.id,
            'gift',
            `Gift: ${product_name || 'Bundle'} to ${recipient_name} (${recipient_country})`,
            isUSD ? 0 : requiredAmount,
            isUSD ? requiredAmount : 0,
            currencyLabel,
            'completed',
            orderRef,
            {
                recipient_name,
                recipient_country,
                product_name: product_name || 'Gift Bundle',
                quantity: parseInt(quantity) || 1,
                delivery_speed: delivery_speed || 'standard',
                gift_wrap: gift_wrap || false,
                occasion: occasion || null
            }
        );

        // ─── Create Notification ───
        await createNotification(
            userId,
            'Gift Order Placed 🎁',
            `Your gift "${product_name || 'Bundle'}" for ${recipient_name} has been ordered.`,
            'gift_ordered',
            `/history`
        );

        if (global.invalidateDashboardCache) {
            global.invalidateDashboardCache();
        }

        res.json({
            success: true,
            message: 'Gift order placed successfully!',
            order: {
                id: order.id,
                order_ref: orderRef,
                product_name: order.product_name,
                recipient_name: order.recipient_name,
                recipient_country: order.recipient_country,
                status: 'pending',
                new_balance: newBalance,
                currency: currencyLabel,
                amount: requiredAmount
            }
        });

    } catch (error) {
        console.error('Gift order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/gifts/orders ───
router.get('/orders', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { status, limit = 20, page = 1 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = supabaseAdmin
            .from('gift_orders')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        query = query.range(offset, offset + parseInt(limit) - 1);

        const { data, error, count } = await query;

        if (error) throw error;

        res.json({
            success: true,
            orders: data || [],
            count: count || 0,
            page: parseInt(page),
            totalPages: Math.ceil((count || 0) / parseInt(limit))
        });
    } catch (error) {
        console.error('Gift orders error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/gifts/track ───
router.get('/track', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { query } = req.query;

        if (!query) {
            return res.status(400).json({ success: false, error: 'Order ID or email required' });
        }

        const { data: byRef } = await supabaseAdmin
            .from('gift_orders')
            .select('*')
            .eq('order_ref', query.toUpperCase())
            .eq('user_id', userId)
            .maybeSingle();

        if (byRef) {
            return res.json({ success: true, type: 'order', data: byRef });
        }

        const { data: byEmail } = await supabaseAdmin
            .from('gift_orders')
            .select('*')
            .eq('recipient_email', query)
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (byEmail && byEmail.length > 0) {
            return res.json({ success: true, type: 'orders', data: byEmail });
        }

        return res.status(404).json({ success: false, error: 'Order not found' });
    } catch (error) {
        console.error('Track error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/gifts/order/:id ───
router.get('/order/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const { data, error } = await supabaseAdmin
            .from('gift_orders')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        res.json({ success: true, data });
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── POST /api/gifts/cancel ───
router.post('/cancel', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { order_id } = req.body;

        if (!order_id) {
            return res.status(400).json({ success: false, error: 'Order ID required' });
        }

        const { data: order, error: orderErr } = await supabaseAdmin
            .from('gift_orders')
            .select('*')
            .eq('id', order_id)
            .eq('user_id', userId)
            .single();

        if (orderErr || !order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        if (order.status !== 'pending') {
            return res.status(400).json({ success: false, error: 'Order cannot be cancelled' });
        }

        const isUSD = order.wallet_used === 'USD';
        const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';
        const refundAmount = isUSD ? order.price_usd : order.price_ngn;

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select(walletField)
            .eq('id', userId)
            .single();

        await supabaseAdmin
            .from('profiles')
            .update({ [walletField]: (profile[walletField] || 0) + refundAmount })
            .eq('id', userId);

        await supabaseAdmin
            .from('gift_orders')
            .update({
                status: 'cancelled',
                cancelled_at: new Date().toISOString()
            })
            .eq('id', order_id);

        await supabaseAdmin
            .from('transactions')
            .update({
                status: 'refunded',
                revenue_ngn: 0,
                revenue_usd: 0,
                description: `Refunded: Gift order cancelled (${order.product_name})`
            })
            .eq('order_id', order_id)
            .eq('type', 'gift');

        await createNotification(
            userId,
            'Gift Order Cancelled ❌',
            `Your gift order ${order.order_ref} has been cancelled. Refund processed.`,
            'gift_cancelled',
            `/history`
        );

        if (global.invalidateDashboardCache) {
            global.invalidateDashboardCache();
        }

        res.json({
            success: true,
            message: 'Gift order cancelled. Refund processed.',
            new_balance: (profile[walletField] || 0) + refundAmount,
            currency: order.wallet_used || 'NGN'
        });
    } catch (error) {
        console.error('Cancel order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ════════════════════════════════════════════════
// ADMIN ROUTES - Mounted at /api/admin
// ════════════════════════════════════════════════

// ─── GET /api/admin/gift-orders/recent ───
// ✅ FIXED: This endpoint returns recent gift orders for the admin dashboard
router.get('/gift-orders/recent', verifyAdminToken, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 5;
        
        const { data, error } = await supabaseAdmin
            .from('gift_orders')
            .select(`
                id,
                order_ref,
                product_name,
                recipient_name,
                recipient_email,
                recipient_country,
                recipient_address,
                recipient_city,
                recipient_state,
                recipient_zip,
                price_ngn,
                price_usd,
                wallet_used,
                status,
                tracking_number,
                shipped_at,
                delivered_at,
                created_at,
                user_id,
                user_username,
                user_email
            `)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            if (error.code === '42P01') {
                return res.json({ success: true, data: [] });
            }
            throw error;
        }

        // Enrich with user details
        const orders = await Promise.all((data || []).map(async (order) => {
            if (!order.user_username && order.user_id) {
                const { data: user } = await supabaseAdmin
                    .from('profiles')
                    .select('username, email')
                    .eq('id', order.user_id)
                    .single();
                if (user) {
                    order.user_username = user.username;
                    order.user_email = user.email;
                }
            }
            return order;
        }));

        res.json({
            success: true,
            data: orders
        });
    } catch (error) {
        console.error('Recent gift orders error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/admin/gift-orders ───
router.get('/gift-orders', verifyAdminToken, async (req, res) => {
    try {
        const { status, limit = 50, page = 1, search } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = supabaseAdmin
            .from('gift_orders')
            .select('*, profiles!gift_orders_user_id_fkey (username, email)', { count: 'exact' })
            .order('created_at', { ascending: false });

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        if (search) {
            query = query.or(`order_ref.ilike.%${search}%,recipient_name.ilike.%${search}%,recipient_email.ilike.%${search}%,product_name.ilike.%${search}%`);
        }

        query = query.range(offset, offset + parseInt(limit) - 1);

        const { data, error, count } = await query;

        if (error) throw error;

        const formattedOrders = (data || []).map(order => ({
            id: order.id,
            order_ref: order.order_ref,
            product_name: order.product_name,
            product_id: order.product_id,
            image_url: order.image_url,
            recipient_name: order.recipient_name,
            recipient_phone: order.recipient_phone,
            recipient_email: order.recipient_email,
            recipient_country: order.recipient_country,
            recipient_address: order.recipient_address,
            recipient_city: order.recipient_city,
            recipient_state: order.recipient_state,
            recipient_zip: order.recipient_zip,
            message: order.message,
            quantity: order.quantity,
            price_ngn: order.price_ngn,
            price_usd: order.price_usd,
            wallet_used: order.wallet_used,
            delivery_speed: order.delivery_speed,
            gift_wrap: order.gift_wrap,
            occasion: order.occasion,
            delivery_date: order.delivery_date,
            status: order.status,
            tracking_number: order.tracking_number,
            shipped_at: order.shipped_at,
            delivered_at: order.delivered_at,
            created_at: order.created_at,
            user_id: order.user_id,
            user_username: order.user_username || order.profiles?.username || 'Unknown',
            user_email: order.user_email || order.profiles?.email || 'Unknown'
        }));

        res.json({
            success: true,
            orders: formattedOrders,
            count: count || 0,
            page: parseInt(page),
            totalPages: Math.ceil((count || 0) / parseInt(limit))
        });
    } catch (error) {
        console.error('Admin gift orders error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── PUT /api/admin/gift-orders/:id/status ───
router.put('/gift-orders/:id/status', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, tracking_number } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, error: 'Status required' });
        }

        const updateData = {
            status: status,
            updated_at: new Date().toISOString()
        };

        if (tracking_number) {
            updateData.tracking_number = tracking_number;
        }

        if (status === 'shipped') {
            updateData.shipped_at = new Date().toISOString();
        }

        if (status === 'delivered') {
            updateData.delivered_at = new Date().toISOString();
        }

        const { data: order, error } = await supabaseAdmin
            .from('gift_orders')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        if (order.user_id) {
            const statusMessages = {
                'processing': 'Your gift order is being processed 🎁',
                'shipped': `Your gift has been shipped! ${tracking_number ? `Tracking: ${tracking_number}` : ''} 🚚`,
                'delivered': 'Your gift has been delivered successfully ✅',
                'cancelled': 'Your gift order has been cancelled ❌'
            };
            
            if (statusMessages[status]) {
                await supabaseAdmin
                    .from('notifications')
                    .insert({
                        user_id: order.user_id,
                        title: `Gift Order ${status.charAt(0).toUpperCase() + status.slice(1)}`,
                        message: statusMessages[status],
                        type: status === 'delivered' ? 'success' : 'info',
                        icon: status === 'delivered' ? '✅' : status === 'shipped' ? '🚚' : '📌',
                        is_read: false,
                        created_at: new Date().toISOString()
                    });
            }
        }

        if (global.invalidateDashboardCache) {
            global.invalidateDashboardCache();
        }

        res.json({
            success: true,
            message: 'Order updated successfully',
            order: order
        });
    } catch (error) {
        console.error('Update order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/admin/gift-orders/:id ───
router.get('/gift-orders/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;

        const { data: order, error } = await supabaseAdmin
            .from('gift_orders')
            .select('*, profiles!gift_orders_user_id_fkey (username, email, wallet_ngn, wallet_usd, phone)')
            .eq('id', id)
            .single();

        if (error || !order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        res.json({
            success: true,
            order: {
                ...order,
                user: {
                    username: order.profiles?.username || order.user_username || 'Unknown',
                    email: order.profiles?.email || order.user_email || 'Unknown',
                    phone: order.profiles?.phone || null,
                    wallet_ngn: order.profiles?.wallet_ngn || 0,
                    wallet_usd: order.profiles?.wallet_usd || 0
                }
            }
        });
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/admin/gift-stats ───
router.get('/gift-stats', verifyAdminToken, async (req, res) => {
    try {
        const { data: allOrders } = await supabaseAdmin
            .from('gift_orders')
            .select('status, wallet_used, price_ngn, price_usd, created_at');

        const totalOrders = allOrders?.length || 0;
        const pending = allOrders?.filter(o => o.status === 'pending').length || 0;
        const processing = allOrders?.filter(o => o.status === 'processing').length || 0;
        const shipped = allOrders?.filter(o => o.status === 'shipped').length || 0;
        const delivered = allOrders?.filter(o => o.status === 'delivered').length || 0;
        const cancelled = allOrders?.filter(o => o.status === 'cancelled').length || 0;

        let revenueNGN = 0, revenueUSD = 0;
        allOrders?.forEach(o => {
            if (['completed', 'delivered', 'shipped'].includes(o.status)) {
                if (o.wallet_used === 'USD') revenueUSD += parseFloat(o.price_usd) || 0;
                else revenueNGN += parseFloat(o.price_ngn) || 0;
            }
        });

        const monthlyRevenue = [];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
        for (let i = 5; i >= 0; i--) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            const start = new Date(d.getFullYear(), d.getMonth(), 1);
            const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
            const monthOrders = allOrders?.filter(o => {
                const date = new Date(o.created_at);
                return date >= start && date <= end && ['completed', 'delivered', 'shipped'].includes(o.status);
            }) || [];
            let ngn = 0, usd = 0;
            monthOrders.forEach(o => {
                if (o.wallet_used === 'USD') usd += parseFloat(o.price_usd) || 0;
                else ngn += parseFloat(o.price_ngn) || 0;
            });
            monthlyRevenue.push({ month: months[i], ngn, usd });
        }

        res.json({
            success: true,
            stats: {
                totalOrders,
                pending,
                processing,
                shipped,
                delivered,
                cancelled,
                revenueNGN,
                revenueUSD,
                monthlyRevenue
            }
        });
    } catch (error) {
        console.error('Gift stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── ADMIN PRODUCT CRUD ───
router.post('/gift-products', verifyAdminToken, async (req, res) => {
    try {
        const { name, category, price_ngn, price_usd, stock, image_url, description, delivery, occasions, popular } = req.body;

        if (!name || !category || price_ngn === undefined) {
            return res.status(400).json({ success: false, error: 'Name, category, and price are required' });
        }

        const { data, error } = await supabaseAdmin
            .from('gift_products')
            .insert({
                name,
                category,
                price_ngn,
                price_usd: price_usd || 0,
                stock: stock || 0,
                image_url: image_url || '',
                description: description || '',
                delivery: delivery || '3-5 days',
                occasions: occasions || ['Birthday'],
                popular: popular || false,
                active: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) throw error;

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, product: data });
    } catch (error) {
        console.error('Create product error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/gift-products/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, category, price_ngn, price_usd, stock, image_url, description, delivery, occasions, popular } = req.body;

        const { data, error } = await supabaseAdmin
            .from('gift_products')
            .update({
                name,
                category,
                price_ngn,
                price_usd: price_usd || 0,
                stock: stock || 0,
                image_url: image_url || '',
                description: description || '',
                delivery: delivery || '3-5 days',
                occasions: occasions || ['Birthday'],
                popular: popular || false,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, product: data });
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/gift-products/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('gift_products')
            .delete()
            .eq('id', id);

        if (error) throw error;

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, message: 'Product deleted' });
    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ════════════════════════════════════════════════
// GIFT CARD ROUTES - Sell gift cards
// ════════════════════════════════════════════════

// ─── GET /api/giftcards/rates ───
router.get('/rates/giftcards', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('gift_card_rates')
            .select('*')
            .eq('is_active', true)
            .order('sort_order', { ascending: true });

        if (error) throw error;

        const rates = (data || []).map(r => ({
            ...r,
            change_percent: (Math.random() * 0.8 - 0.2).toFixed(2),
            is_positive: Math.random() > 0.3
        }));

        res.json({ success: true, rates });
    } catch (error) {
        console.error('Rates error:', error);
        res.json({
            success: true,
            rates: [
                { card_name: 'Amazon', rate_ngn: 1480, icon: '🛒' },
                { card_name: 'Steam', rate_ngn: 1440, icon: '🎮' },
                { card_name: 'iTunes / Apple', rate_ngn: 1460, icon: '🎵' },
                { card_name: 'Google Play', rate_ngn: 1420, icon: '▶️' },
            ]
        });
    }
});

// ─── POST /api/giftcards/sell ───
router.post('/sell', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            card_brand, card_amount, card_code, pin,
            wallet_type, country
        } = req.body;

        if (!card_brand || !card_amount || !card_code) {
            return res.status(400).json({
                success: false,
                error: 'Card brand, amount, and code are required'
            });
        }

        const amount = parseFloat(card_amount);
        if (isNaN(amount) || amount < 1) {
            return res.status(400).json({
                success: false,
                error: 'Please enter a valid card amount (minimum $1)'
            });
        }

        // ─── Get rate ───
        const { data: rateData } = await supabaseAdmin
            .from('gift_card_rates')
            .select('rate_ngn')
            .eq('card_name', card_brand)
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(1);

        const rate = rateData?.[0]?.rate_ngn || 1350;
        const basePayout = amount * rate;
        const fee = basePayout * 0.03;
        const estimatedPayout = basePayout - fee;

        const reference = generateReference('GC');

        const { data: transaction, error: txError } = await supabaseAdmin
            .from('gift_card_transactions')
            .insert({
                user_id: userId,
                reference,
                card_type: 'digital',
                card_brand: card_brand,
                card_amount: amount,
                card_code: card_code,
                card_pin: pin || null,
                estimated_rate: rate,
                estimated_payout: estimatedPayout,
                wallet_type: wallet_type || 'NGN',
                card_country: country || 'Nigeria',
                status: 'submitted',
                review_status: 'pending',
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (txError) {
            console.error('Transaction error:', txError);
            return res.status(500).json({
                success: false,
                error: 'Failed to submit gift card. Please try again.'
            });
        }

        // ─── Create Notification ───
        await createNotification(
            userId,
            'Gift Card Submitted 💳',
            `Your ${card_brand} gift card worth $${amount} has been submitted for verification.`,
            'info',
            `/giftcards/${reference}`
        );

        res.json({
            success: true,
            message: 'Gift card submitted successfully!',
            data: {
                transaction: {
                    id: transaction.id,
                    reference: transaction.reference,
                    card_brand: transaction.card_brand,
                    amount: transaction.card_amount,
                    estimated_payout: transaction.estimated_payout,
                    status: transaction.status,
                    created_at: transaction.created_at
                }
            }
        });

    } catch (error) {
        console.error('Sell gift card error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to submit gift card'
        });
    }
});

// ─── GET /api/giftcards/my-transactions ───
router.get('/my-transactions', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { limit = 20, page = 1, status } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = supabaseAdmin
            .from('gift_card_transactions')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (status) query = query.eq('status', status);

        const { data, count, error } = await query
            .range(offset, offset + parseInt(limit) - 1);

        if (error) throw error;

        res.json({
            success: true,
            data: data || [],
            total: count || 0,
            page: parseInt(page),
            pageSize: parseInt(limit)
        });

    } catch (error) {
        console.error('My transactions error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── GET /api/giftcards/transaction/:reference ───
router.get('/transaction/:reference', authMiddleware, async (req, res) => {
    try {
        const { reference } = req.params;
        const userId = req.user.id;

        const { data, error } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*')
            .eq('reference', reference)
            .single();

        if (error) throw error;

        if (data.user_id !== userId) {
            return res.status(403).json({
                success: false,
                error: 'You do not have permission to view this transaction'
            });
        }

        res.json({ success: true, data });
    } catch (error) {
        console.error('Transaction detail error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════
// ADMIN GIFT CARD ROUTES
// ════════════════════════════════════════════════

// ─── GET /api/admin/giftcards/transactions ───
router.get('/admin/giftcards/transactions', verifyAdminToken, async (req, res) => {
    try {
        const { limit = 50, page = 1, status, card_brand, country, user_id, start_date, end_date } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = supabaseAdmin
            .from('gift_card_transactions')
            .select('*, profiles!gift_card_transactions_user_id_fkey (id, email, username)')
            .order('created_at', { ascending: false });

        if (status) query = query.eq('status', status);
        if (card_brand) query = query.eq('card_brand', card_brand);
        if (country) query = query.eq('card_country', country);
        if (user_id) query = query.eq('user_id', user_id);
        if (start_date) query = query.gte('created_at', start_date);
        if (end_date) query = query.lte('created_at', end_date);

        const { data, count, error } = await query
            .range(offset, offset + parseInt(limit) - 1);

        if (error) throw error;

        res.json({
            success: true,
            data: data || [],
            total: count || 0,
            page: parseInt(page),
            pageSize: parseInt(limit)
        });
    } catch (error) {
        console.error('Admin transactions error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── PUT /api/admin/giftcards/transaction/:id ───
router.put('/admin/giftcards/transaction/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, admin_notes, rejection_reason, final_rate, final_payout } = req.body;

        const updates = {
            status: status,
            review_status: status === 'approved' ? 'approved' : status,
            admin_notes: admin_notes || null,
            reviewed_by: req.adminId,
            reviewed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        if (status === 'approved' || status === 'paid') {
            updates.final_rate = final_rate || null;
            updates.final_payout = final_payout || null;
        }

        if (status === 'rejected') {
            updates.rejection_reason = rejection_reason || null;
        }

        if (status === 'paid') {
            updates.paid_at = new Date().toISOString();
        }

        const { data: transaction, error } = await supabaseAdmin
            .from('gift_card_transactions')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // ─── If approved, update user wallet ───
        if (status === 'approved' || status === 'paid') {
            const payout = transaction.final_payout || transaction.estimated_payout;
            const walletType = transaction.wallet_type || 'NGN';
            const field = walletType === 'NGN' ? 'wallet_ngn' : 'wallet_usd';

            const { data: user } = await supabaseAdmin
                .from('profiles')
                .select(field)
                .eq('id', transaction.user_id)
                .single();

            if (user) {
                const newBalance = (user[field] || 0) + payout;
                await supabaseAdmin
                    .from('profiles')
                    .update({ [field]: newBalance })
                    .eq('id', transaction.user_id);
            }

            await createNotification(
                transaction.user_id,
                '🎉 Gift Card Approved!',
                `Your ${transaction.card_brand} gift card (${transaction.reference}) has been approved. ${walletType === 'NGN' ? '₦' : '$'}${payout.toFixed(2)} added to your wallet.`,
                'success',
                `/giftcards/${transaction.reference}`
            );
        }

        // ─── If rejected, notify user ───
        if (status === 'rejected') {
            await createNotification(
                transaction.user_id,
                '❌ Gift Card Rejected',
                `Your ${transaction.card_brand} gift card (${transaction.reference}) was rejected. Reason: ${rejection_reason || 'Unknown'}`,
                'error',
                `/giftcards/${transaction.reference}`
            );
        }

        if (global.invalidateDashboardCache) {
            global.invalidateDashboardCache();
        }

        res.json({
            success: true,
            message: 'Transaction updated successfully',
            data: transaction
        });
    } catch (error) {
        console.error('Update transaction error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/admin/giftcards/analytics ───
router.get('/admin/giftcards/analytics', verifyAdminToken, async (req, res) => {
    try {
        const { data: allTransactions } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*');

        const totalVolume = allTransactions?.reduce((sum, t) => sum + (t.card_amount || 0), 0) || 0;
        const totalApproved = allTransactions?.filter(t => t.status === 'approved' || t.status === 'paid').length || 0;
        const totalRejected = allTransactions?.filter(t => t.status === 'rejected').length || 0;
        const pendingReviews = allTransactions?.filter(t => t.status === 'submitted' || t.status === 'under_review').length || 0;

        // ─── Top brands ───
        const brandCount = {};
        allTransactions?.forEach(t => {
            const brand = t.card_brand || 'Unknown';
            brandCount[brand] = (brandCount[brand] || 0) + 1;
        });
        const topBrands = Object.entries(brandCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, count]) => ({ name, count }));

        res.json({
            success: true,
            data: {
                total_volume: totalVolume,
                pending_reviews: pendingReviews,
                total_approved: totalApproved,
                total_rejected: totalRejected,
                top_brands: topBrands,
                active_traders: allTransactions?.length || 0
            }
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;