// routes/admin/giftcardAdminRoutes.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');                              // ← add
const { supabase, supabaseAdmin } = require('../../db/supabase'); // ← add `supabase`
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'miles-exchange-secret-key-2024'; // ← add

// ─── MIDDLEWARE: Verify Admin (Supabase first, custom JWT fallback) ───
async function verifyAdmin(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'No token provided', code: 'NO_TOKEN' });
    }

    try {
        // ← FIXED: use `supabase` (anon client), not `supabaseAdmin`
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (!authError && user) {
            const { data: profile, error: profileError } = await supabaseAdmin
                .from('profiles')
                .select('role, email, username')
                .eq('id', user.id)
                .single();

            if (!profileError && profile && (profile.role === 'admin' || profile.role === 'super_admin')) {
                req.adminId = user.id;
                req.adminEmail = profile.email || user.email;
                req.adminUsername = profile.username || user.email?.split('@')[0] || 'Admin';
                req.adminRole = profile.role;
                req.user = user;
                return next();
            }

            if (profile) {
                return res.status(403).json({ success: false, error: 'Admin access required', code: 'ADMIN_REQUIRED' });
            }
        }

        // ← ADDED: fallback to custom JWT (issued by /api/admin/login)
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required', code: 'ADMIN_REQUIRED' });
        }

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('role, email, username')
            .eq('id', decoded.userId)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({ success: false, error: 'User profile not found', code: 'PROFILE_NOT_FOUND' });
        }

        req.adminId = decoded.userId;
        req.adminEmail = profile.email || decoded.email;
        req.adminUsername = profile.username || decoded.email?.split('@')[0] || 'Admin';
        req.adminRole = profile.role;
        req.user = { id: decoded.userId, email: decoded.email };
        next();
    } catch (error) {
        console.error('Admin verification error:', error);
        return res.status(401).json({ success: false, error: 'Authentication failed', code: 'AUTH_FAILED' });
    }
}
// ─── HELPER: Generate Order ID ───
function generateOrderId() {
    const prefix = 'GC';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}${timestamp}${random}`;
}

// ─── HELPER: Enrich orders with user details ───
async function enrichOrdersWithUsers(orders) {
    if (!orders || orders.length === 0) return orders;
    
    const userIds = [...new Set(orders.map(o => o.user_id).filter(Boolean))];
    if (userIds.length === 0) return orders;
    
    const { data: users } = await supabaseAdmin
        .from('profiles')
        .select('id, email, username, avatar_url, phone')
        .in('id', userIds);
    
    const userMap = {};
    users?.forEach(u => userMap[u.id] = u);
    
    return orders.map(o => ({
        ...o,
        username: userMap[o.user_id]?.username || 'Unknown',
        email: userMap[o.user_id]?.email || 'Unknown',
        phone: userMap[o.user_id]?.phone || 'N/A',
        avatar_url: userMap[o.user_id]?.avatar_url || null
    }));
}

// ─── HELPER: Get gift card rates ───
async function getGiftCardRates() {
    const { data, error } = await supabaseAdmin
        .from('gift_card_rates')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
    
    if (error) {
        console.error('Error fetching rates:', error);
        return [];
    }
    return data || [];
}

// ============================================================
// 1. GET /admin/giftcards/stats - Dashboard Stats
// ============================================================
router.get('/giftcards/stats', verifyAdmin, async (req, res) => {
    try {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        // ─── Get all orders from gift_card_transactions ───
        const { data: allOrders } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*');

        // ─── Get today's orders ───
        const { data: todayOrders } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*')
            .gte('created_at', `${today}T00:00:00`)
            .lt('created_at', `${today}T23:59:59`);

        // ─── Get month's orders ───
        const { data: monthOrders } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*')
            .gte('created_at', monthStart);

        // ─── Get products from gift_card_rates ───
        const products = await getGiftCardRates();

        // ─── Get unique customers ───
        const uniqueCustomers = new Set(allOrders?.map(o => o.user_id) || []);

        // ─── Calculate stats ───
        const stats = {
            totalOrders: allOrders?.length || 0,
            pending: allOrders?.filter(o => o.status === 'pending' || o.status === 'submitted' || o.status === 'under_review').length || 0,
            processing: allOrders?.filter(o => ['processing', 'approved'].includes(o.status)).length || 0,
            delivered: allOrders?.filter(o => ['paid', 'completed'].includes(o.status)).length || 0,
            cancelled: allOrders?.filter(o => o.status === 'cancelled').length || 0,
            refunded: allOrders?.filter(o => o.status === 'refunded').length || 0,
            rejected: allOrders?.filter(o => o.status === 'rejected').length || 0,
            revenueNGN: allOrders?.reduce((sum, o) => sum + (o.wallet_type === 'NGN' ? (o.estimated_payout || 0) : 0), 0) || 0,
            revenueUSD: allOrders?.reduce((sum, o) => sum + (o.wallet_type === 'USD' ? (o.estimated_payout || 0) : 0), 0) || 0,
            totalCustomers: uniqueCustomers.size || 0,
            totalProducts: products?.length || 0,
            activeProducts: products?.filter(p => p.is_active !== false).length || 0
        };

        res.json({
            success: true,
            stats
        });

    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 2. GET /admin/gift-orders - Get All Orders
// ============================================================
router.get('/gift-orders', verifyAdmin, async (req, res) => {
    try {
        const {
            status,
            period,
            currency,
            country,
            supplier,
            wallet,
            search,
            limit = 100,
            page = 1
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = supabaseAdmin
            .from('gift_card_transactions')
            .select('*', { count: 'exact' });

        // ─── Apply filters ───
        if (status && status !== 'all') {
            if (status === 'pending') {
                query = query.in('status', ['pending', 'submitted', 'under_review']);
            } else if (status === 'processing') {
                query = query.in('status', ['processing', 'approved']);
            } else if (status === 'delivered') {
                query = query.in('status', ['paid', 'completed']);
            } else {
                query = query.eq('status', status);
            }
        }

        if (currency && currency !== 'all') {
            query = query.eq('card_currency', currency);
        }

        if (country && country !== 'all') {
            query = query.eq('card_country', country);
        }

        if (wallet && wallet !== 'all') {
            query = query.eq('wallet_type', wallet);
        }

        // ─── Period filter ───
        if (period && period !== 'all') {
            const now = new Date();
            let startDate;
            switch (period) {
                case 'today':
                    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    break;
                case 'yesterday':
                    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
                    break;
                case 'week':
                    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
                    break;
                case 'month':
                    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                    break;
                case 'year':
                    startDate = new Date(now.getFullYear(), 0, 1);
                    break;
                case '30days':
                    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
                    break;
                default:
                    startDate = null;
            }
            if (startDate) {
                query = query.gte('created_at', startDate.toISOString());
            }
        }

        // ─── Search ───
        if (search && search.length > 0) {
            query = query.or(`reference.ilike.%${search}%,card_brand.ilike.%${search}%,card_code.ilike.%${search}%`);
        }

        // ─── Get total count ───
        const { count: totalCount } = await query;
        query = query.order('created_at', { ascending: false });

        // ─── Paginate ───
        const { data: orders, error } = await query.range(offset, offset + parseInt(limit) - 1);

        if (error) throw error;

        // ─── Enrich with user details ───
        const enriched = await enrichOrdersWithUsers(orders || []);

        // ─── Map to frontend expected format ───
        const mappedOrders = enriched.map(o => ({
            id: o.reference || o.id,
            reference: o.reference,
            user_id: o.user_id,
            username: o.username || 'Unknown',
            email: o.email || 'Unknown',
            phone: o.phone || 'N/A',
            brand: o.card_brand || 'Unknown',
            country: o.card_country || 'USA',
            currency: o.card_currency || 'USD',
            denomination: o.card_amount || 0,
            quantity: o.quantity || 1,
            selling_price: o.wallet_type === 'NGN' ? o.estimated_payout : (o.estimated_payout || 0) / 1620,
            cost_price: o.final_payout || 0,
            profit: (o.wallet_type === 'NGN' ? o.estimated_payout : o.estimated_payout / 1620) - (o.final_payout || 0),
            wallet_type: o.wallet_type || 'NGN',
            supplier: 'Manual',
            delivery_method: 'Instant',
            status: o.status || 'pending',
            admin_notes: o.admin_notes || '',
            assigned_admin: 'System',
            wallet: o.wallet_type || 'NGN',
            created_at: o.created_at,
            updated_at: o.updated_at,
            fraud_score: o.fraud_score || 0,
            is_fraud_flagged: o.is_fraud_flagged || false
        }));

        res.json({
            success: true,
            orders: mappedOrders,
            total: totalCount || 0,
            page: parseInt(page),
            pageSize: parseInt(limit)
        });

    } catch (error) {
        console.error('Get orders error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 3. GET /admin/giftcards/products - Get All Products
// ============================================================
router.get('/giftcards/products', verifyAdmin, async (req, res) => {
    try {
        const { data: products, error } = await supabaseAdmin
            .from('gift_card_rates')
            .select('*')
            .eq('is_active', true)
            .order('sort_order', { ascending: true });

        if (error) throw error;

        // ─── Map to frontend format ───
        const mappedProducts = (products || []).map(p => ({
            id: p.id,
            brand_name: p.card_name || 'Unnamed',
            country: p.country || 'Global',
            currency: 'USD',
            category: p.card_type || 'Physical',
            description: `${p.card_name} gift card - ${p.country}`,
            image_url: '',
            delivery_time: 'Instant',
            supplier: 'Manual',
            stock: 100,
            price_ngn: p.rate_ngn * 1.1,
            price_usd: 1,
            cost_price: p.rate_ngn,
            margin: 8,
            fulfillment_mode: 'manual',
            popular: p.is_positive || false,
            featured: p.is_positive || false,
            active: p.is_active !== false,
            rate_ngn: p.rate_ngn,
            icon: p.icon || '🎁',
            change_percent: p.change_percent || '0.0%',
            is_positive: p.is_positive !== false
        }));

        res.json({
            success: true,
            products: mappedProducts
        });

    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 4. POST /admin/gifts/products - Create Product
// ============================================================
router.post('/admin/gifts/products', verifyAdmin, async (req, res) => {
    try {
        const {
            brand_name,
            country,
            currency,
            category,
            description,
            image_url,
            delivery_time,
            supplier,
            stock,
            price_ngn,
            price_usd,
            cost_price,
            margin,
            fulfillment_mode,
            popular,
            featured,
            active
        } = req.body;

        const { data: product, error } = await supabaseAdmin
            .from('gift_card_rates')
            .insert({
                card_name: brand_name || 'Unnamed',
                country: country || 'Global',
                rate_ngn: cost_price || 0,
                icon: '🎁',
                change_percent: '0.0%',
                is_positive: true,
                card_type: category || 'Physical',
                is_active: active !== false,
                sort_order: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) throw error;

        // ─── Log admin activity ───
        await supabaseAdmin
            .from('admin_activity')
            .insert({
                admin_id: req.adminId,
                action: 'gift_product_created',
                entity_type: 'gift_card_rates',
                entity_id: product.id,
                details: { card_name: product.card_name },
                ip_address: req.ip || 'unknown',
                created_at: new Date().toISOString()
            });

        res.json({
            success: true,
            message: 'Product created successfully',
            product
        });

    } catch (error) {
        console.error('Create product error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 5. PUT /admin/gifts/products/:id - Update Product
// ============================================================
router.put('/admin/gifts/products/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            brand_name,
            country,
            rate_ngn,
            icon,
            change_percent,
            is_positive,
            card_type,
            is_active,
            sort_order
        } = req.body;

        const updates = {
            card_name: brand_name,
            country: country || 'Global',
            rate_ngn: rate_ngn || 0,
            icon: icon || '🎁',
            change_percent: change_percent || '0.0%',
            is_positive: is_positive !== false,
            card_type: card_type || 'Physical',
            is_active: is_active !== false,
            sort_order: sort_order || 0,
            updated_at: new Date().toISOString()
        };

        const { data: product, error } = await supabaseAdmin
            .from('gift_card_rates')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // ─── Log admin activity ───
        await supabaseAdmin
            .from('admin_activity')
            .insert({
                admin_id: req.adminId,
                action: 'gift_product_updated',
                entity_type: 'gift_card_rates',
                entity_id: product.id,
                details: { card_name: product.card_name },
                ip_address: req.ip || 'unknown',
                created_at: new Date().toISOString()
            });

        res.json({
            success: true,
            message: 'Product updated successfully',
            product
        });

    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 6. DELETE /admin/gifts/products/:id - Delete Product
// ============================================================
router.delete('/admin/gifts/products/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Soft delete - just deactivate
        const { data: product, error } = await supabaseAdmin
            .from('gift_card_rates')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // ─── Log admin activity ───
        await supabaseAdmin
            .from('admin_activity')
            .insert({
                admin_id: req.adminId,
                action: 'gift_product_deleted',
                entity_type: 'gift_card_rates',
                entity_id: id,
                details: { card_name: product?.card_name || 'Unknown' },
                ip_address: req.ip || 'unknown',
                created_at: new Date().toISOString()
            });

        res.json({
            success: true,
            message: 'Product deleted successfully'
        });

    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 7. GET /ticker/items - Get Ticker Items (Public)
// ============================================================
router.get('/ticker/items', async (req, res) => {
    try {
        const { data: tickerItems, error } = await supabaseAdmin
            .from('ticker_items')
            .select('*')
            .eq('active', true)
            .order('sort_order', { ascending: true });

        if (error) {
            console.error('Ticker DB error:', error);
            return res.json({
                success: true,
                data: [
                    { id: '1', icon: '📢', text: 'Special promotion: 10% bonus on gift cards!', badge: 'HOT', badgeColor: '#ef4444', link: '/giftcards.html' },
                    { id: '2', icon: '🆕', text: 'New virtual numbers for UK and Canada now available', badge: 'NEW', badgeColor: '#3b82f6', link: '/virtual.html' },
                    { id: '3', icon: '🎉', text: 'Welcome bonus: Get $5 free when you fund your wallet', badge: 'FREE', badgeColor: '#10b981', link: '/fund.html' }
                ]
            });
        }

        res.json({
            success: true,
            data: tickerItems || []
        });

    } catch (error) {
        console.error('Ticker error:', error);
        res.json({
            success: true,
            data: [
                { id: '1', icon: '📢', text: 'Special promotion: 10% bonus on gift cards!', badge: 'HOT', badgeColor: '#ef4444', link: '/giftcards.html' },
                { id: '2', icon: '🆕', text: 'New virtual numbers for UK and Canada now available' },
                { id: '3', icon: '🎉', text: 'Welcome bonus: Get $5 free when you fund your wallet', badge: 'NEW' }
            ]
        });
    }
});

// ============================================================
// 8. POST /admin/ticker/items - Create Ticker Item
// ============================================================
router.post('/admin/ticker/items', verifyAdmin, async (req, res) => {
    try {
        const { icon, text, badge, badgeColor, link, sort_order } = req.body;

        if (!text) {
            return res.status(400).json({ success: false, error: 'Text is required' });
        }

        const { data: item, error } = await supabaseAdmin
            .from('ticker_items')
            .insert({
                icon: icon || '📌',
                text: text,
                badge: badge || null,
                badge_color: badgeColor || null,
                link: link || null,
                sort_order: sort_order || 999,
                active: true,
                created_at: new Date().toISOString(),
                created_by: req.adminId
            })
            .select()
            .single();

        if (error) throw error;

        // ─── Log admin activity ───
        await supabaseAdmin
            .from('admin_activity')
            .insert({
                admin_id: req.adminId,
                action: 'ticker_item_created',
                entity_type: 'ticker_items',
                entity_id: item.id,
                details: { text: text },
                ip_address: req.ip || 'unknown',
                created_at: new Date().toISOString()
            });

        res.json({
            success: true,
            message: 'Ticker item created successfully',
            data: item
        });

    } catch (error) {
        console.error('Create ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 9. PUT /admin/ticker/items/:id - Update Ticker Item
// ============================================================
router.put('/admin/ticker/items/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { icon, text, badge, badgeColor, link, sort_order, active } = req.body;

        const { data: item, error } = await supabaseAdmin
            .from('ticker_items')
            .update({
                icon: icon || '📌',
                text: text,
                badge: badge || null,
                badge_color: badgeColor || null,
                link: link || null,
                sort_order: sort_order || 999,
                active: active !== false,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // ─── Log admin activity ───
        await supabaseAdmin
            .from('admin_activity')
            .insert({
                admin_id: req.adminId,
                action: 'ticker_item_updated',
                entity_type: 'ticker_items',
                entity_id: id,
                details: { text: text },
                ip_address: req.ip || 'unknown',
                created_at: new Date().toISOString()
            });

        res.json({
            success: true,
            message: 'Ticker item updated successfully',
            data: item
        });

    } catch (error) {
        console.error('Update ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 10. DELETE /admin/ticker/items/:id - Delete Ticker Item
// ============================================================
router.delete('/admin/ticker/items/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('ticker_items')
            .delete()
            .eq('id', id);

        if (error) throw error;

        // ─── Log admin activity ───
        await supabaseAdmin
            .from('admin_activity')
            .insert({
                admin_id: req.adminId,
                action: 'ticker_item_deleted',
                entity_type: 'ticker_items',
                entity_id: id,
                ip_address: req.ip || 'unknown',
                created_at: new Date().toISOString()
            });

        res.json({
            success: true,
            message: 'Ticker item deleted successfully'
        });

    } catch (error) {
        console.error('Delete ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 11. PUT /admin/gift-orders/:id - Update Order Status
// ============================================================
router.put('/admin/gift-orders/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, admin_notes, assigned_admin } = req.body;

        // Find order by reference
        const { data: existingOrder, error: findError } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*')
            .eq('reference', id)
            .single();

        if (findError) {
            const { data: byId, error: idError } = await supabaseAdmin
                .from('gift_card_transactions')
                .select('*')
                .eq('id', id)
                .single();
            
            if (idError) {
                return res.status(404).json({ success: false, error: 'Order not found' });
            }
            existingOrder = byId;
        }

        const updates = {
            status: status,
            admin_notes: admin_notes || existingOrder.admin_notes || '',
            updated_at: new Date().toISOString()
        };

        if (status === 'approved' || status === 'paid') {
            updates.paid_at = new Date().toISOString();
        }

        if (status === 'rejected') {
            updates.reviewed_at = new Date().toISOString();
            updates.reviewed_by = req.adminId;
        }

        if (status === 'processing') {
            updates.review_status = 'processing';
        }

        const { data: order, error } = await supabaseAdmin
            .from('gift_card_transactions')
            .update(updates)
            .eq('id', existingOrder.id)
            .select()
            .single();

        if (error) throw error;

        // ─── Log admin activity ───
        await supabaseAdmin
            .from('admin_activity')
            .insert({
                admin_id: req.adminId,
                action: 'gift_order_status_updated',
                entity_type: 'gift_card_transactions',
                entity_id: order.id,
                details: { status: status, admin_notes: admin_notes },
                ip_address: req.ip || 'unknown',
                created_at: new Date().toISOString()
            });

        // ─── Create notification for user ───
        if (order.user_id) {
            await supabaseAdmin
                .from('notifications')
                .insert({
                    user_id: order.user_id,
                    title: `Gift Card Order ${status.toUpperCase()}`,
                    message: `Your gift card order (${order.reference}) has been ${status}. ${admin_notes || ''}`,
                    type: status === 'paid' || status === 'approved' ? 'success' : 'info',
                    icon: status === 'paid' || status === 'approved' ? '✅' : '📌',
                    link: `/giftcards/order/${order.reference}`,
                    is_read: false,
                    created_at: new Date().toISOString()
                });
        }

        res.json({
            success: true,
            message: 'Order updated successfully',
            order: {
                ...order,
                id: order.reference
            }
        });

    } catch (error) {
        console.error('Update order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 12. GET /admin/gift-orders/:id - Get Single Order
// ============================================================
router.get('/admin/gift-orders/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        let { data: order, error } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*')
            .eq('reference', id)
            .single();

        if (error) {
            const { data: byId, error: idError } = await supabaseAdmin
                .from('gift_card_transactions')
                .select('*')
                .eq('id', id)
                .single();
            
            if (idError) {
                return res.status(404).json({ success: false, error: 'Order not found' });
            }
            order = byId;
        }

        const [enriched] = await enrichOrdersWithUsers([order]);

        res.json({
            success: true,
            order: {
                ...enriched,
                id: enriched.reference
            }
        });

    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 13. GET /admin/giftcards/rates - Get Gift Card Rates
// ============================================================
router.get('/giftcards/rates', verifyAdmin, async (req, res) => {
    try {
        const rates = await getGiftCardRates();
        
        res.json({
            success: true,
            rates: rates.map(r => ({
                ...r,
                change_percent: r.change_percent || (Math.random() * 0.8 - 0.2).toFixed(2) + '%',
                is_positive: r.is_positive !== false
            }))
        });

    } catch (error) {
        console.error('Get rates error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 14. GET /admin/giftcards/orders/recent - Recent Orders (for dashboard)
// ============================================================
router.get('/giftcards/orders/recent', verifyAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 5;

        const { data: orders, error } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;

        const enriched = await enrichOrdersWithUsers(orders || []);

        const mappedOrders = enriched.map(o => ({
            id: o.reference || o.id,
            reference: o.reference,
            user_id: o.user_id,
            username: o.username || 'Unknown',
            email: o.email || 'Unknown',
            brand: o.card_brand || 'Unknown',
            country: o.card_country || 'USA',
            amount: o.card_amount || 0,
            currency: o.card_currency || 'USD',
            wallet_type: o.wallet_type || 'NGN',
            status: o.status || 'pending',
            created_at: o.created_at
        }));

        res.json({
            success: true,
            orders: mappedOrders
        });

    } catch (error) {
        console.error('Recent orders error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;