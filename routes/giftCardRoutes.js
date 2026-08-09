const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'miles-exchange-secret-key-2024';

// ─── MULTER CONFIG ───
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'uploads/giftcards/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = crypto.randomBytes(8).toString('hex');
        const ext = path.extname(file.originalname);
        cb(null, `gc_${Date.now()}_${unique}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, WEBP, and PDF allowed.'));
        }
    }
});

const fs = require('fs');

// ─── HELPER: Generate Reference ───
function generateReference() {
    const prefix = 'GC';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}${timestamp}${random}`;
}

// ─── ADMIN VERIFICATION MIDDLEWARE ───
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
        req.adminId = decoded.userId || decoded.sub || decoded.id;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
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
        if (error) console.error('Notification error:', error);
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
// GIFT PRODUCTS - USER ENDPOINTS
// ════════════════════════════════════════════════

// ─── GET /api/gifts/products ───
router.get('/products', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('gift_products')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, products: data || [] });
    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/gifts/products/:id ───
router.get('/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabaseAdmin
            .from('gift_products')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error) throw error;
        if (!data) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }
        res.json({ success: true, product: data });
    } catch (error) {
        console.error('Get product error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ════════════════════════════════════════════════
// ADMIN: GIFT PRODUCTS - CRUD
// ════════════════════════════════════════════════

// ─── POST /api/admin/gifts/products ───
router.post('/admin/gifts/products', verifyAdminToken, async (req, res) => {
    try {
        const { 
            name, category, price_ngn, price_usd, stock, 
            image_url, description, delivery, occasions, popular 
        } = req.body;

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

// ─── PUT /api/admin/gifts/products/:id ───
router.put('/admin/gifts/products/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            name, category, price_ngn, price_usd, stock, 
            image_url, description, delivery, occasions, popular 
        } = req.body;

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

// ─── DELETE /api/admin/gifts/products/:id ───
router.delete('/admin/gifts/products/:id', verifyAdminToken, async (req, res) => {
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
// ADMIN: GIFT ORDERS
// ════════════════════════════════════════════════

// ─── GET /api/admin/gift-orders ───
router.get('/admin/gift-orders', verifyAdminToken, async (req, res) => {
    try {
        const { status, limit = 50, page = 1, search } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = supabaseAdmin
            .from('gift_orders')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false });

        if (status && status !== 'all') query = query.eq('status', status);
        if (search) query = query.or(`order_ref.ilike.%${search}%,recipient_name.ilike.%${search}%,recipient_email.ilike.%${search}%,product_name.ilike.%${search}%`);

        query = query.range(offset, offset + parseInt(limit) - 1);

        const { data, error, count } = await query;
        if (error) throw error;

        // Manual user lookup
        let formattedOrders = data || [];
        if (formattedOrders.length > 0) {
            const userIds = [...new Set(formattedOrders.map(o => o.user_id).filter(Boolean))];
            if (userIds.length > 0) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email, wallet_ngn, wallet_usd, phone')
                    .in('id', userIds);
                
                const profileMap = {};
                (profiles || []).forEach(p => { profileMap[p.id] = p; });

                formattedOrders = formattedOrders.map(o => ({
                    ...o,
                    user_username: profileMap[o.user_id]?.username || o.user_username || 'Unknown',
                    user_email: profileMap[o.user_id]?.email || o.user_email || 'Unknown',
                    user_wallet_ngn: profileMap[o.user_id]?.wallet_ngn || 0,
                    user_wallet_usd: profileMap[o.user_id]?.wallet_usd || 0,
                    user_phone: profileMap[o.user_id]?.phone || null
                }));
            }
        }

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

// ─── GET /api/admin/gift-orders/:id ───
router.get('/admin/gift-orders/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;

        const { data: order, error } = await supabaseAdmin
            .from('gift_orders')
            .select('*')
            .eq('id', id)
            .single();

        if (error || !order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        let userData = null;
        if (order.user_id) {
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email, wallet_ngn, wallet_usd, phone')
                .eq('id', order.user_id)
                .maybeSingle();
            if (profile) userData = profile;
        }

        res.json({
            success: true,
            order: {
                ...order,
                user: userData ? {
                    username: userData.username || order.user_username || 'Unknown',
                    email: userData.email || order.user_email || 'Unknown',
                    phone: userData.phone || null,
                    wallet_ngn: userData.wallet_ngn || 0,
                    wallet_usd: userData.wallet_usd || 0
                } : {
                    username: order.user_username || 'Unknown',
                    email: order.user_email || 'Unknown',
                    phone: null,
                    wallet_ngn: 0,
                    wallet_usd: 0
                }
            }
        });
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── PUT /api/admin/gift-orders/:id/status ───
router.put('/admin/gift-orders/:id/status', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, tracking_number, notes } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, error: 'Status required' });
        }

        const updateData = {
            status: status,
            updated_at: new Date().toISOString()
        };

        if (tracking_number) updateData.tracking_number = tracking_number;
        if (notes) updateData.admin_notes = notes;
        if (status === 'shipped') updateData.shipped_at = new Date().toISOString();
        if (status === 'delivered') updateData.delivered_at = new Date().toISOString();
        if (status === 'cancelled') updateData.cancelled_at = new Date().toISOString();

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
                'shipped': `Your gift has been shipped! ${tracking_number ? `Tracking: ${tracking_number}` : ''}`,
                'delivered': 'Your gift has been delivered successfully ✅',
                'cancelled': 'Your gift order has been cancelled ❌'
            };
            if (statusMessages[status]) {
                await createNotification(
                    order.user_id,
                    status.charAt(0).toUpperCase() + status.slice(1) + ' Update',
                    statusMessages[status],
                    status === 'delivered' ? 'success' : 'info',
                    `/history`
                );
            }
        }

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, message: 'Order updated successfully', order });
    } catch (error) {
        console.error('Update order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ════════════════════════════════════════════════
// ADMIN: GIFT STATS
// ════════════════════════════════════════════════

// ─── GET /api/admin/gift-stats ───
router.get('/admin/gift-stats', verifyAdminToken, async (req, res) => {
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

// ════════════════════════════════════════════════
// GIFT CARD SELL - USER
// ════════════════════════════════════════════════

// ─── POST /api/giftcards/sell ───
router.post('/giftcards/sell', authMiddleware, upload.fields([
    { name: 'card_images', maxCount: 5 },
    { name: 'receipt', maxCount: 3 }
]), async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            card_name, amount_usd, country, subcategory,
            wallet_type, promo_code, card_code, pin,
            comment, quantity = 1
        } = req.body;

        if (!card_name || !amount_usd || !country) {
            return res.status(400).json({
                success: false,
                error: 'Card name, amount, and country are required'
            });
        }

        const amount = parseFloat(amount_usd);
        if (isNaN(amount) || amount < 1) {
            return res.status(400).json({
                success: false,
                error: 'Please enter a valid card amount (minimum $1)'
            });
        }

        // ─── Get Rate ───
        const { data: rateData } = await supabaseAdmin
            .from('gift_card_rates')
            .select('rate_ngn')
            .eq('card_name', card_name)
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(1);

        const rate = rateData?.[0]?.rate_ngn || 1350;
        const basePayout = amount * rate;
        const fee = basePayout * 0.03;
        const estimatedPayout = basePayout - fee;

        // ─── Process Images ───
        let frontImage = null, backImage = null, receiptImage = null;
        const cardImages = req.files?.['card_images'] || [];
        const receipts = req.files?.['receipt'] || [];

        if (cardImages.length > 0) {
            frontImage = `/uploads/giftcards/${cardImages[0].filename}`;
            if (cardImages.length > 1) backImage = `/uploads/giftcards/${cardImages[1].filename}`;
        }
        if (receipts.length > 0) {
            receiptImage = `/uploads/giftcards/${receipts[0].filename}`;
        }

        // ─── Check Duplicates ───
        if (card_code) {
            const { count: duplicateCount } = await supabaseAdmin
                .from('gift_card_transactions')
                .select('*', { count: 'exact', head: true })
                .eq('card_code', card_code)
                .neq('status', 'rejected');

            if (duplicateCount > 0) {
                return res.status(400).json({
                    success: false,
                    error: 'This card code has already been submitted.'
                });
            }
        }

        // ─── Create Transaction ───
        const reference = generateReference();
        const { data: transaction, error: txError } = await supabaseAdmin
            .from('gift_card_transactions')
            .insert({
                user_id: userId,
                reference,
                card_type: subcategory || 'digital',
                card_brand: card_name,
                card_country: country,
                card_amount: amount,
                quantity: parseInt(quantity) || 1,
                estimated_rate: rate,
                estimated_payout: estimatedPayout,
                card_code: card_code || null,
                card_pin: pin || null,
                front_image: frontImage,
                back_image: backImage,
                receipt_image: receiptImage,
                wallet_type: wallet_type || 'NGN',
                status: 'submitted',
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
            'Gift Card Submitted',
            `Your ${card_name} gift card worth $${amount} has been submitted for verification. Reference: ${reference}`,
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

// ─── GET /api/giftcards/rates ───
router.get('/giftcards/rates', async (req, res) => {
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
                { card_name: 'Xbox', rate_ngn: 1430, icon: '🕹️' },
                { card_name: 'PlayStation', rate_ngn: 1445, icon: '🎮' },
                { card_name: 'eBay', rate_ngn: 1390, icon: '📦' }
            ]
        });
    }
});

module.exports = router;