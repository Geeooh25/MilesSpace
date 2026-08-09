// routes/admin/giftAdminRoutes.js - COMPLETE VERSION
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');

// ─── ADMIN VERIFICATION MIDDLEWARE ───
function verifyAdminToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }
    try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'miles-exchange-secret-key-2024');
        const role = decoded.role || decoded.user?.role;
        if (role !== 'admin' && role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        req.adminId = decoded.userId || decoded.sub || decoded.id;
        req.adminRole = role;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

// ─── GET RECENT GIFT ORDERS (for dashboard) ───
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

        res.json({ success: true, data: orders });
    } catch (error) {
        console.error('Recent gift orders error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET ALL GIFT ORDERS ───
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
            ...order,
            user_username: order.profiles?.username || order.user_username || 'Unknown',
            user_email: order.profiles?.email || order.user_email || 'Unknown'
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

// ─── UPDATE GIFT ORDER STATUS ───
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

        if (order?.user_id) {
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

// ─── GET SINGLE GIFT ORDER ───
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

// ─── GET GIFT STATS ───
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

module.exports = router;