// routes/admin/giftcardAdminRoutes.js
// COMPLETE PRODUCTION-READY GIFT CARD ADMIN ROUTES
// All routes mounted under /api/admin

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { supabase, supabaseAdmin } = require('../../db/supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'miles-exchange-secret-key-2024';

// ─── CONFIG ──────────────────────────────────────────────────────────
const USD_NGN_RATE = process.env.USD_NGN_RATE || 1620; // Should come from FX service

// ─── HELPER: Generate Order ID ────────────────────────────────────
function generateOrderId() {
    const prefix = 'GC';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}${timestamp}${random}`;
}

// ─── HELPER: Generate Reference ──────────────────────────────────
function generateReference() {
    const prefix = 'GC';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}${timestamp}${random}`;
}

// ─── HELPER: Get Notification Icon ──────────────────────────────
function getNotificationIcon(type) {
    const icons = {
        'gift_ordered': '🎁',
        'gift_shipped': '🚚',
        'gift_delivered': '✅',
        'gift_cancelled': '❌',
        'gift_approved': '✅',
        'gift_rejected': '❌',
        'gift_paid': '💰',
        'info': '📌',
        'success': '✅',
        'error': '❌',
        'warning': '⚠️'
    };
    return icons[type] || '📌';
}

// ─── HELPER: Create Notification ────────────────────────────────
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
        if (error) console.error('Notification error:', error);
        return data;
    } catch (error) {
        console.error('Notification error:', error);
        return null;
    }
}

// ─── HELPER: Log Admin Activity ─────────────────────────────────
async function logAdminActivity({ admin_id, action, details, ip, severity = 'info' }) {
    try {
        await supabaseAdmin
            .from('admin_activity')
            .insert({
                admin_id: admin_id,
                action: action,
                details: details || {},
                severity: severity || 'info',
                ip_address: ip || 'unknown',
                created_at: new Date().toISOString()
            });
    } catch (error) {
        console.error('Failed to log admin activity:', error.message);
    }
}

// ─── HELPER: Get Gift Card Rates ────────────────────────────────
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

// ─── HELPER: Enrich Orders with User Details ────────────────────
async function enrichOrdersWithUsers(orders) {
    if (!orders || orders.length === 0) return orders;

    const userIds = [...new Set(orders.map(o => o.user_id).filter(Boolean))];
    if (userIds.length === 0) return orders;

    const { data: users } = await supabaseAdmin
        .from('profiles')
        .select('id, email, username, avatar_url, phone, wallet_ngn, wallet_usd')
        .in('id', userIds);

    const userMap = {};
    users?.forEach(u => userMap[u.id] = u);

    return orders.map(o => ({
        ...o,
        username: userMap[o.user_id]?.username || 'Unknown',
        email: userMap[o.user_id]?.email || 'Unknown',
        phone: userMap[o.user_id]?.phone || 'N/A',
        avatar_url: userMap[o.user_id]?.avatar_url || null,
        user_wallet_ngn: userMap[o.user_id]?.wallet_ngn || 0,
        user_wallet_usd: userMap[o.user_id]?.wallet_usd || 0
    }));
}

// ─── HELPER: Get Actual USD/NGN Rate ────────────────────────────
async function getUsdNgnRate() {
    try {
        // Try to get from database config
        const { data } = await supabaseAdmin
            .from('system_config')
            .select('value')
            .eq('key', 'usd_ngn_rate')
            .maybeSingle();

        if (data?.value) {
            return parseFloat(data.value);
        }
        return USD_NGN_RATE;
    } catch (error) {
        console.error('Error fetching USD/NGN rate:', error);
        return USD_NGN_RATE;
    }
}

// ─── VALID STATUS TRANSITIONS ────────────────────────────────────
const VALID_STATUS_TRANSITIONS = {
    'submitted': ['under_review', 'rejected', 'cancelled'],
    'under_review': ['approved', 'rejected', 'cancelled'],
    'approved': ['processing', 'cancelled'],
    'processing': ['paid', 'failed', 'cancelled'],
    'paid': ['completed', 'refunded'],
    'completed': ['refunded'],
    'rejected': [],
    'cancelled': [],
    'refunded': [],
    'failed': []
};

// ─── ADMIN VERIFICATION MIDDLEWARE ──────────────────────────────
async function verifyAdmin(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'No token provided',
            code: 'NO_TOKEN'
        });
    }

    try {
        // Try Supabase Auth first
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (!authError && user) {
            const { data: profile, error: profileError } = await supabaseAdmin
                .from('profiles')
                .select('role, email, username, status, deleted_at')
                .eq('id', user.id)
                .single();

            if (!profileError && profile) {
                if (profile.deleted_at) {
                    return res.status(403).json({
                        success: false,
                        error: 'Account deleted',
                        code: 'ACCOUNT_DELETED'
                    });
                }
                if (profile.status === 'suspended') {
                    return res.status(403).json({
                        success: false,
                        error: 'Account suspended',
                        code: 'ACCOUNT_SUSPENDED'
                    });
                }
                if (profile.role === 'admin' || profile.role === 'super_admin') {
                    req.adminId = user.id;
                    req.adminEmail = profile.email || user.email;
                    req.adminUsername = profile.username || user.email?.split('@')[0] || 'Admin';
                    req.adminRole = profile.role;
                    req.user = user;
                    return next();
                }
                return res.status(403).json({
                    success: false,
                    error: 'Admin access required',
                    code: 'ADMIN_REQUIRED'
                });
            }
        }

        // Fallback to custom JWT (issued by /api/admin/login)
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.type !== 'admin' && decoded.role !== 'admin' && decoded.role !== 'super_admin') {
            return res.status(403).json({
                success: false,
                error: 'Admin access required',
                code: 'ADMIN_REQUIRED'
            });
        }

        const userId = decoded.userId || decoded.id || decoded.sub;
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('role, email, username, status, deleted_at')
            .eq('id', userId)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({
                success: false,
                error: 'User profile not found',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        if (profile.deleted_at) {
            return res.status(403).json({
                success: false,
                error: 'Account deleted',
                code: 'ACCOUNT_DELETED'
            });
        }
        if (profile.status === 'suspended') {
            return res.status(403).json({
                success: false,
                error: 'Account suspended',
                code: 'ACCOUNT_SUSPENDED'
            });
        }

        req.adminId = userId;
        req.adminEmail = profile.email || decoded.email;
        req.adminUsername = profile.username || decoded.email?.split('@')[0] || 'Admin';
        req.adminRole = profile.role;
        req.user = { id: userId, email: decoded.email };
        next();

    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                error: 'Token expired',
                code: 'TOKEN_EXPIRED'
            });
        }
        console.error('Admin verification error:', error);
        return res.status(401).json({
            success: false,
            error: 'Authentication failed',
            code: 'AUTH_FAILED'
        });
    }
}

// ════════════════════════════════════════════════════════════════════
// 1. GET /api/admin/giftcards/stats - Dashboard Stats
// ════════════════════════════════════════════════════════════════════

router.get('/giftcards/stats', verifyAdmin, async (req, res) => {
    try {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        // ─── Get all orders ───
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

        // ─── Get products ───
        const products = await getGiftCardRates();

        // ─── Get unique customers ───
        const uniqueCustomers = new Set(allOrders?.map(o => o.user_id) || []);

        // ─── Calculate stats ───
        const usdRate = await getUsdNgnRate();

        // Revenue calculations - FIXED: Use actual revenue, not estimated_payout
        let revenueNGN = 0;
        let revenueUSD = 0;
        let totalPayoutNGN = 0;
        let totalPayoutUSD = 0;

        allOrders?.forEach(o => {
            const status = o.status || 'pending';
            if (['paid', 'completed', 'delivered'].includes(status)) {
                if (o.wallet_type === 'NGN') {
                    revenueNGN += parseFloat(o.selling_price || o.estimated_payout || 0);
                    totalPayoutNGN += parseFloat(o.final_payout || o.estimated_payout || 0);
                } else {
                    revenueUSD += parseFloat(o.selling_price || o.estimated_payout || 0);
                    totalPayoutUSD += parseFloat(o.final_payout || o.estimated_payout || 0);
                }
            }
        });

        // Gross profit
        const grossProfitNGN = revenueNGN - totalPayoutNGN;
        const grossProfitUSD = revenueUSD - totalPayoutUSD;

        const stats = {
            totalOrders: allOrders?.length || 0,
            pending: allOrders?.filter(o => ['pending', 'submitted', 'under_review'].includes(o.status || 'pending')).length || 0,
            processing: allOrders?.filter(o => ['processing', 'approved'].includes(o.status || '')).length || 0,
            delivered: allOrders?.filter(o => ['paid', 'completed', 'delivered'].includes(o.status || '')).length || 0,
            cancelled: allOrders?.filter(o => o.status === 'cancelled').length || 0,
            refunded: allOrders?.filter(o => o.status === 'refunded').length || 0,
            rejected: allOrders?.filter(o => o.status === 'rejected').length || 0,
            failed: allOrders?.filter(o => o.status === 'failed').length || 0,

            // Revenue (what you earn)
            revenueNGN: revenueNGN,
            revenueUSD: revenueUSD,

            // Payouts (what you pay customers)
            totalPayoutNGN: totalPayoutNGN,
            totalPayoutUSD: totalPayoutUSD,

            // Gross profit
            grossProfitNGN: grossProfitNGN,
            grossProfitUSD: grossProfitUSD,

            totalCustomers: uniqueCustomers.size || 0,
            totalProducts: products?.length || 0,
            activeProducts: products?.filter(p => p.is_active !== false).length || 0,

            // Today's stats
            todayOrders: todayOrders?.length || 0,
            todayRevenueNGN: todayOrders?.reduce((sum, o) => {
                if (['paid', 'completed', 'delivered'].includes(o.status || '')) {
                    return sum + (o.wallet_type === 'NGN' ? (o.selling_price || o.estimated_payout || 0) : 0);
                }
                return sum;
            }, 0) || 0,
            todayRevenueUSD: todayOrders?.reduce((sum, o) => {
                if (['paid', 'completed', 'delivered'].includes(o.status || '')) {
                    return sum + (o.wallet_type === 'USD' ? (o.selling_price || o.estimated_payout || 0) : 0);
                }
                return sum;
            }, 0) || 0,

            // Month stats
            monthOrders: monthOrders?.length || 0,
            monthRevenueNGN: monthOrders?.reduce((sum, o) => {
                if (['paid', 'completed', 'delivered'].includes(o.status || '')) {
                    return sum + (o.wallet_type === 'NGN' ? (o.selling_price || o.estimated_payout || 0) : 0);
                }
                return sum;
            }, 0) || 0,
            monthRevenueUSD: monthOrders?.reduce((sum, o) => {
                if (['paid', 'completed', 'delivered'].includes(o.status || '')) {
                    return sum + (o.wallet_type === 'USD' ? (o.selling_price || o.estimated_payout || 0) : 0);
                }
                return sum;
            }, 0) || 0
        };

        res.json({
            success: true,
            stats
        });

    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 2. GET /api/admin/gift-orders - Get All Orders
// ════════════════════════════════════════════════════════════════════

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
                query = query.in('status', ['paid', 'completed', 'delivered']);
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
        // REMOVED: card_code.ilike - don't expose card codes in search
        if (search && search.length > 0) {
            query = query.or(
                `reference.ilike.%${search}%,` +
                `card_brand.ilike.%${search}%,` +
                `user_id::text.ilike.%${search}%`
            );
        }

        // ─── Get total count ───
        const { count: totalCount } = await query;
        query = query.order('created_at', { ascending: false });

        // ─── Paginate ───
        const { data: orders, error } = await query.range(offset, offset + parseInt(limit) - 1);

        if (error) throw error;

        // ─── Enrich with user details ───
        const enriched = await enrichOrdersWithUsers(orders || []);
        const usdRate = await getUsdNgnRate();

        // ─── Map to frontend format ───
        const mappedOrders = enriched.map(o => {
            const isNGN = o.wallet_type === 'NGN';
            const payout = parseFloat(o.estimated_payout || 0);
            const costPrice = parseFloat(o.final_payout || o.estimated_payout || 0);

            // Use real calculations
            const sellingPrice = isNGN ? payout : payout / usdRate;
            const cost = isNGN ? costPrice : costPrice / usdRate;
            const profit = sellingPrice - cost;

            return {
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
                selling_price: sellingPrice,
                cost_price: cost,
                profit: profit,
                wallet_type: o.wallet_type || 'NGN',
                supplier: 'Manual',
                delivery_method: 'Instant',
                status: o.status || 'pending',
                admin_notes: o.admin_notes || '',
                assigned_admin: o.assigned_admin || null,
                wallet: o.wallet_type || 'NGN',
                created_at: o.created_at,
                updated_at: o.updated_at,
                fraud_score: o.fraud_score || 0,
                is_fraud_flagged: o.is_fraud_flagged || false,
                card_code: o.card_code ? '****' : null, // Never expose full card code
                card_pin: o.card_pin ? '****' : null     // Never expose PIN
            };
        });

        res.json({
            success: true,
            orders: mappedOrders,
            total: totalCount || 0,
            page: parseInt(page),
            pageSize: parseInt(limit),
            totalPages: Math.ceil((totalCount || 0) / parseInt(limit))
        });

    } catch (error) {
        console.error('Get orders error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 3. GET /api/admin/giftcards/products - Get All Products
// ════════════════════════════════════════════════════════════════════

router.get('/giftcards/products', verifyAdmin, async (req, res) => {
    try {
        const { data: products, error } = await supabaseAdmin
            .from('gift_card_rates')
            .select('*')
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
            image_url: p.image_url || '',
            delivery_time: 'Instant',
            supplier: 'Manual',
            stock: p.stock || 100,
            price_ngn: p.rate_ngn * 1.1,
            price_usd: p.rate_usd || 1,
            cost_price: p.rate_ngn,
            margin: p.margin || 8,
            fulfillment_mode: 'manual',
            popular: p.popular || p.is_positive || false,
            featured: p.featured || p.is_positive || false,
            active: p.is_active !== false,
            rate_ngn: p.rate_ngn,
            rate_usd: p.rate_usd || (p.rate_ngn / USD_NGN_RATE),
            icon: p.icon || '🎁',
            change_percent: p.change_percent || '0.0',
            is_positive: p.is_positive !== false,
            sort_order: p.sort_order || 0,
            created_at: p.created_at,
            updated_at: p.updated_at
        }));

        res.json({
            success: true,
            products: mappedProducts
        });

    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 4. POST /api/admin/giftcards/products - Create Product
// ════════════════════════════════════════════════════════════════════

router.post('/giftcards/products', verifyAdmin, async (req, res) => {
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
            active,
            rate_ngn,
            rate_usd,
            icon
        } = req.body;

        // ─── Validate required fields ───
        if (!brand_name) {
            return res.status(400).json({
                success: false,
                error: 'Brand name is required'
            });
        }

        if (cost_price === undefined && rate_ngn === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Cost price (rate_ngn) is required'
            });
        }

        const insertData = {
            card_name: brand_name,
            country: country || 'Global',
            rate_ngn: rate_ngn || cost_price || 0,
            rate_usd: rate_usd || price_usd || 0,
            icon: icon || '🎁',
            change_percent: '0.0',
            is_positive: true,
            card_type: category || 'Physical',
            is_active: active !== false,
            sort_order: 0,
            stock: stock || 0,
            margin: margin || 0,
            popular: popular || false,
            featured: featured || false,
            image_url: image_url || '',
            description: description || '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const { data: product, error } = await supabaseAdmin
            .from('gift_card_rates')
            .insert(insertData)
            .select()
            .single();

        if (error) throw error;

        // ─── Log admin activity ───
        await logAdminActivity({
            admin_id: req.adminId,
            action: 'gift_product_created',
            details: {
                card_name: product.card_name,
                rate_ngn: product.rate_ngn,
                country: product.country
            },
            ip: req.ip || 'unknown'
        });

        res.json({
            success: true,
            message: 'Product created successfully',
            product: {
                ...product,
                id: product.id
            }
        });

    } catch (error) {
        console.error('Create product error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 5. PUT /api/admin/giftcards/products/:id - Update Product
// ════════════════════════════════════════════════════════════════════

router.put('/giftcards/products/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            brand_name,
            country,
            rate_ngn,
            rate_usd,
            icon,
            change_percent,
            is_positive,
            card_type,
            is_active,
            sort_order,
            stock,
            margin,
            popular,
            featured,
            image_url,
            description
        } = req.body;

        // ─── Check if product exists ───
        const { data: existing, error: findError } = await supabaseAdmin
            .from('gift_card_rates')
            .select('id')
            .eq('id', id)
            .maybeSingle();

        if (findError || !existing) {
            return res.status(404).json({
                success: false,
                error: 'Product not found'
            });
        }

        const updates = {
            card_name: brand_name,
            country: country || 'Global',
            rate_ngn: rate_ngn !== undefined ? rate_ngn : 0,
            rate_usd: rate_usd || 0,
            icon: icon || '🎁',
            change_percent: change_percent || '0.0',
            is_positive: is_positive !== false,
            card_type: card_type || 'Physical',
            is_active: is_active !== false,
            sort_order: sort_order || 0,
            stock: stock || 0,
            margin: margin || 0,
            popular: popular || false,
            featured: featured || false,
            image_url: image_url || '',
            description: description || '',
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
        await logAdminActivity({
            admin_id: req.adminId,
            action: 'gift_product_updated',
            details: {
                card_name: product.card_name,
                rate_ngn: product.rate_ngn
            },
            ip: req.ip || 'unknown'
        });

        res.json({
            success: true,
            message: 'Product updated successfully',
            product: {
                ...product,
                id: product.id
            }
        });

    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 6. DELETE /api/admin/giftcards/products/:id - Delete Product
// ════════════════════════════════════════════════════════════════════

router.delete('/giftcards/products/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // ─── Check if product exists ───
        const { data: existing, error: findError } = await supabaseAdmin
            .from('gift_card_rates')
            .select('id, card_name')
            .eq('id', id)
            .maybeSingle();

        if (findError || !existing) {
            return res.status(404).json({
                success: false,
                error: 'Product not found'
            });
        }

        // Soft delete - deactivate
        const { error } = await supabaseAdmin
            .from('gift_card_rates')
            .update({
                is_active: false,
                updated_at: new Date().toISOString()
            })
            .eq('id', id);

        if (error) throw error;

        // ─── Log admin activity ───
        await logAdminActivity({
            admin_id: req.adminId,
            action: 'gift_product_deleted',
            details: {
                card_name: existing.card_name || 'Unknown'
            },
            ip: req.ip || 'unknown'
        });

        res.json({
            success: true,
            message: 'Product deleted successfully'
        });

    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 7. GET /api/admin/gift-orders/:id - Get Single Order
// ════════════════════════════════════════════════════════════════════

router.get('/gift-orders/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Try reference first, then ID
        let order = null;
        let error = null;

        // Try by reference
        const { data: byRef, error: refError } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*')
            .eq('reference', id)
            .maybeSingle();

        if (!refError && byRef) {
            order = byRef;
        } else {
            // Try by ID
            const { data: byId, error: idError } = await supabaseAdmin
                .from('gift_card_transactions')
                .select('*')
                .eq('id', id)
                .maybeSingle();

            if (idError || !byId) {
                return res.status(404).json({
                    success: false,
                    error: 'Order not found'
                });
            }
            order = byId;
        }

        // ─── Enrich with user details ───
        const [enriched] = await enrichOrdersWithUsers([order]);
        const usdRate = await getUsdNgnRate();

        // ─── Return with safe data ───
        res.json({
            success: true,
            order: {
                ...enriched,
                id: enriched.reference || enriched.id,
                // Hide sensitive data - only show if admin needs it
                card_code: enriched.card_code ? '****' : null,
                card_pin: enriched.card_pin ? '****' : null,
                // Include images
                front_image: enriched.front_image || null,
                back_image: enriched.back_image || null,
                receipt_image: enriched.receipt_image || null,
                // Calculations
                selling_price: enriched.wallet_type === 'NGN'
                    ? parseFloat(enriched.estimated_payout || 0)
                    : parseFloat(enriched.estimated_payout || 0) / usdRate,
                cost_price: enriched.wallet_type === 'NGN'
                    ? parseFloat(enriched.final_payout || enriched.estimated_payout || 0)
                    : parseFloat(enriched.final_payout || enriched.estimated_payout || 0) / usdRate
            }
        });

    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 8. PUT /api/admin/gift-orders/:id - Update Order Status
// ════════════════════════════════════════════════════════════════════

router.put('/gift-orders/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, admin_notes, assigned_admin } = req.body;

        if (!status) {
            return res.status(400).json({
                success: false,
                error: 'Status is required'
            });
        }

        // ─── Find order ───
        let order = null;

        // Try by reference
        const { data: byRef, error: refError } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*')
            .eq('reference', id)
            .maybeSingle();

        if (!refError && byRef) {
            order = byRef;
        } else {
            // Try by ID
            const { data: byId, error: idError } = await supabaseAdmin
                .from('gift_card_transactions')
                .select('*')
                .eq('id', id)
                .maybeSingle();

            if (idError || !byId) {
                return res.status(404).json({
                    success: false,
                    error: 'Order not found'
                });
            }
            order = byId;
        }

        const currentStatus = order.status || 'submitted';

        // ─── Validate status transition ───
        const allowedTransitions = VALID_STATUS_TRANSITIONS[currentStatus] || [];

        if (!allowedTransitions.includes(status) && currentStatus !== status) {
            return res.status(400).json({
                success: false,
                error: `Cannot transition from '${currentStatus}' to '${status}'`,
                allowedTransitions: allowedTransitions
            });
        }

        // ─── Build update data ───
        const updates = {
            status: status,
            admin_notes: admin_notes || order.admin_notes || '',
            updated_at: new Date().toISOString()
        };

        if (assigned_admin) {
            updates.assigned_admin = assigned_admin;
        }

        // ─── Status-specific updates ───
        const now = new Date().toISOString();
        switch (status) {
            case 'approved':
                updates.reviewed_at = now;
                updates.reviewed_by = req.adminId;
                updates.review_status = 'approved';
                break;
            case 'rejected':
                updates.reviewed_at = now;
                updates.reviewed_by = req.adminId;
                updates.review_status = 'rejected';
                break;
            case 'processing':
                updates.review_status = 'processing';
                updates.processed_at = now;
                break;
            case 'paid':
                updates.paid_at = now;
                updates.payment_processed_by = req.adminId;
                // ─── TODO: Credit user wallet here ───
                // This should call a separate wallet service
                break;
            case 'completed':
                updates.completed_at = now;
                break;
            case 'refunded':
                updates.refunded_at = now;
                updates.refunded_by = req.adminId;
                // ─── TODO: Refund user wallet here ───
                break;
            case 'cancelled':
                updates.cancelled_at = now;
                updates.cancelled_by = req.adminId;
                break;
            case 'failed':
                updates.failed_at = now;
                break;
        }

        // ─── Execute update ───
        const { data: updatedOrder, error } = await supabaseAdmin
            .from('gift_card_transactions')
            .update(updates)
            .eq('id', order.id)
            .select()
            .single();

        if (error) throw error;

        // ─── Log admin activity ───
        await logAdminActivity({
            admin_id: req.adminId,
            action: 'gift_order_status_updated',
            details: {
                order_id: order.id,
                reference: order.reference,
                old_status: currentStatus,
                new_status: status,
                admin_notes: admin_notes
            },
            ip: req.ip || 'unknown'
        });

        // ─── Create notification for user ───
        if (order.user_id) {
            const statusMessages = {
                'under_review': 'Your gift card is now under review 🔍',
                'approved': 'Your gift card has been approved ✅',
                'rejected': 'Your gift card has been rejected ❌',
                'processing': 'Your gift card is being processed 🎁',
                'paid': 'Your gift card payment has been processed 💰',
                'completed': 'Your gift card order is complete ✅',
                'cancelled': 'Your gift card order has been cancelled ❌',
                'refunded': 'Your gift card payment has been refunded 💰',
                'failed': 'Your gift card processing failed ❌'
            };

            const titleMap = {
                'under_review': 'Gift Card Under Review',
                'approved': 'Gift Card Approved',
                'rejected': 'Gift Card Rejected',
                'processing': 'Gift Card Processing',
                'paid': 'Gift Card Payment Processed',
                'completed': 'Gift Card Complete',
                'cancelled': 'Gift Card Cancelled',
                'refunded': 'Gift Card Refunded',
                'failed': 'Gift Card Failed'
            };

            const message = statusMessages[status] ||
                `Your gift card order (${order.reference}) has been updated to ${status}`;

            const type = ['paid', 'completed', 'approved'].includes(status) ? 'success' :
                         ['rejected', 'cancelled', 'failed'].includes(status) ? 'error' : 'info';

            await createNotification(
                order.user_id,
                titleMap[status] || `Order ${status.toUpperCase()}`,
                message,
                type,
                `/giftcards/order/${order.reference}`
            );
        }

        res.json({
            success: true,
            message: 'Order updated successfully',
            order: {
                ...updatedOrder,
                id: updatedOrder.reference || updatedOrder.id
            }
        });

    } catch (error) {
        console.error('Update order error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 9. GET /api/admin/giftcards/rates - Get Gift Card Rates
// ════════════════════════════════════════════════════════════════════

router.get('/giftcards/rates', verifyAdmin, async (req, res) => {
    try {
        const rates = await getGiftCardRates();

        res.json({
            success: true,
            rates: rates.map(r => ({
                ...r,
                // Calculate real change if available, otherwise 0
                change_percent: r.change_percent || '0.0',
                is_positive: r.is_positive !== false
            }))
        });

    } catch (error) {
        console.error('Get rates error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 10. GET /api/admin/giftcards/orders/recent - Recent Orders
// ════════════════════════════════════════════════════════════════════

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
        const usdRate = await getUsdNgnRate();

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
            created_at: o.created_at,
            estimated_payout: o.estimated_payout || 0
        }));

        res.json({
            success: true,
            orders: mappedOrders
        });

    } catch (error) {
        console.error('Recent orders error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 11. GET /api/admin/giftcards/statuses - Get Available Statuses
// ════════════════════════════════════════════════════════════════════

router.get('/giftcards/statuses', verifyAdmin, async (req, res) => {
    try {
        res.json({
            success: true,
            statuses: Object.keys(VALID_STATUS_TRANSITIONS),
            transitions: VALID_STATUS_TRANSITIONS
        });
    } catch (error) {
        console.error('Get statuses error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════
// 12. GET /api/admin/giftcards/metrics - Advanced Metrics
// ════════════════════════════════════════════════════════════════════

router.get('/giftcards/metrics', verifyAdmin, async (req, res) => {
    try {
        const { period = '30d' } = req.query;

        let startDate = new Date();
        switch (period) {
            case '7d':
                startDate.setDate(startDate.getDate() - 7);
                break;
            case '30d':
                startDate.setDate(startDate.getDate() - 30);
                break;
            case '90d':
                startDate.setDate(startDate.getDate() - 90);
                break;
            case '1y':
                startDate.setFullYear(startDate.getFullYear() - 1);
                break;
            default:
                startDate.setDate(startDate.getDate() - 30);
        }

        const { data: orders } = await supabaseAdmin
            .from('gift_card_transactions')
            .select('*')
            .gte('created_at', startDate.toISOString());

        const usdRate = await getUsdNgnRate();

        // ─── Daily breakdown ───
        const dailyData = {};
        (orders || []).forEach(o => {
            const date = new Date(o.created_at).toISOString().split('T')[0];
            if (!dailyData[date]) {
                dailyData[date] = {
                    date,
                    orders: 0,
                    revenueNGN: 0,
                    revenueUSD: 0,
                    payouts: 0
                };
            }
            dailyData[date].orders++;

            if (['paid', 'completed', 'delivered'].includes(o.status || '')) {
                if (o.wallet_type === 'NGN') {
                    dailyData[date].revenueNGN += parseFloat(o.selling_price || o.estimated_payout || 0);
                } else {
                    dailyData[date].revenueUSD += parseFloat(o.selling_price || o.estimated_payout || 0);
                }
            }
        });

        const dailyBreakdown = Object.values(dailyData).sort((a, b) =>
            a.date.localeCompare(b.date)
        );

        // ─── Top brands ───
        const brandStats = {};
        (orders || []).forEach(o => {
            const brand = o.card_brand || 'Unknown';
            if (!brandStats[brand]) {
                brandStats[brand] = {
                    brand,
                    orders: 0,
                    totalValue: 0
                };
            }
            brandStats[brand].orders++;
            brandStats[brand].totalValue += parseFloat(o.card_amount || 0);
        });

        const topBrands = Object.values(brandStats)
            .sort((a, b) => b.orders - a.orders)
            .slice(0, 10);

        res.json({
            success: true,
            metrics: {
                dailyBreakdown,
                topBrands,
                totalOrders: orders?.length || 0,
                period: period
            }
        });

    } catch (error) {
        console.error('Metrics error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;