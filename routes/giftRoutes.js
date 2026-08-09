const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const crypto = require('crypto');

// ─── HELPERS ───
function generateRef(prefix = 'GFT') {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ─── SAMPLE PRODUCTS (Fallback) ───
const SAMPLE_PRODUCTS = [
    {
        id: 1,
        name: 'Luxury Gift Basket',
        category: 'Luxury Gifts',
        price_ngn: 15000,
        price_usd: 10,
        stock: 50,
        image_url: '',
        description: 'A beautiful luxury gift basket with premium items',
        delivery: '3-5 days',
        occasions: ['Birthday', 'Anniversary', 'Corporate'],
        popular: true
    },
    {
        id: 2,
        name: 'Fresh Flowers Bouquet',
        category: 'Flowers',
        price_ngn: 8500,
        price_usd: 5.50,
        stock: 100,
        image_url: '',
        description: 'Fresh flowers for any occasion',
        delivery: '1-2 days',
        occasions: ['Birthday', 'Anniversary', 'Just Because'],
        popular: true
    },
    {
        id: 3,
        name: 'Premium Chocolates Box',
        category: 'Chocolates',
        price_ngn: 12000,
        price_usd: 8,
        stock: 75,
        image_url: '',
        description: 'Assorted premium chocolates in a beautiful box',
        delivery: '2-3 days',
        occasions: ['Birthday', 'Anniversary', 'Sympathy'],
        popular: false
    },
    {
        id: 4,
        name: 'Personalized Gift Mug',
        category: 'Personalized Gifts',
        price_ngn: 6000,
        price_usd: 4,
        stock: 200,
        image_url: '',
        description: 'Custom printed mug with personalized message',
        delivery: '3-5 days',
        occasions: ['Birthday', 'Just Because'],
        popular: false
    },
    {
        id: 5,
        name: 'Birthday Gift Hamper',
        category: 'Birthday Gifts',
        price_ngn: 20000,
        price_usd: 13,
        stock: 30,
        image_url: '',
        description: 'Complete birthday gift hamper with cake, flowers, and gifts',
        delivery: '2-4 days',
        occasions: ['Birthday'],
        popular: true
    },
    {
        id: 6,
        name: 'Anniversary Gift Set',
        category: 'Anniversary Gifts',
        price_ngn: 18000,
        price_usd: 12,
        stock: 40,
        image_url: '',
        description: 'Romantic anniversary gift set with flowers and chocolates',
        delivery: '2-3 days',
        occasions: ['Anniversary'],
        popular: true
    }
];

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
// ✅ FIXED: Safe version that never crashes
router.get('/products', async (req, res) => {
    try {
        let products = [];
        
        // Try to fetch from database
        const { data, error } = await supabaseAdmin
            .from('gift_products')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.warn('Products table error:', error.message);
            // Return sample products if table doesn't exist
            return res.json({ 
                success: true, 
                products: SAMPLE_PRODUCTS,
                from_sample: true
            });
        }

        if (data && data.length > 0) {
            products = data;
        } else {
            products = SAMPLE_PRODUCTS;
        }
        
        res.json({ success: true, products });
    } catch (error) {
        console.error('Get products error:', error);
        // Always return sample products, never crash
        res.json({ 
            success: true, 
            products: SAMPLE_PRODUCTS,
            from_sample: true
        });
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

        const orderRef = generateRef('GFT');

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

module.exports = router;