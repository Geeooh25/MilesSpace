const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const crypto = require('crypto');

// ─── ADMIN VERIFICATION ───
function verifyAdmin(req, res, next) {
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
        next();
    } catch (e) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

// ─── HELPERS ───
function generateId(prefix) {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ════════════════════════════════════════════════
// PRODUCT CRUD
// ════════════════════════════════════════════════

// GET /api/admin/marketplace/products
router.get('/products', verifyAdmin, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('marketplace_products')
            .select('*, marketplace_categories!marketplace_products_category_id_fkey(name, icon)')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Products query error:', error);
            throw error;
        }
        
        res.json({ success: true, products: data || [] });
    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/admin/marketplace/products
router.post('/products', verifyAdmin, async (req, res) => {
    try {
        const {
            name, category_id, description, country,
            price_usd, price_ngn, delivery_type,
            inventory_items, status = 'Active'
        } = req.body;

        if (!name || !category_id || price_usd === undefined) {
            return res.status(400).json({ success: false, error: 'Name, category, and price are required' });
        }

        const productId = generateId('PRD');
        const inventoryRaw = Array.isArray(inventory_items) ? inventory_items.join('\n') : '';

        // Create product
        const { data: product, error: prodErr } = await supabaseAdmin
            .from('marketplace_products')
            .insert({
                id: productId,
                name,
                category_id,
                description: description || '',
                country: country || 'Global',
                price_usd,
                price_ngn: price_ngn || Math.round(price_usd * 1600),
                stock: inventory_items ? inventory_items.length : 0,
                sold: 0,
                delivery_type: delivery_type || 'structured',
                inventory_raw: inventoryRaw,
                status,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();

        if (prodErr) {
            console.error('Product creation error:', prodErr);
            throw prodErr;
        }

        // Create inventory items
        if (inventory_items && inventory_items.length > 0) {
            const inventoryData = inventory_items.map(content => ({
                id: generateId('INV'),
                product_id: productId,
                product_name: name,
                delivery_type: delivery_type || 'structured',
                content: content,
                status: 'available',
                used_by: null,
                created_at: new Date().toISOString()
            }));

            const { error: invErr } = await supabaseAdmin
                .from('marketplace_inventory')
                .insert(inventoryData);

            if (invErr) {
                console.error('Inventory creation error:', invErr);
                // Don't fail the product creation, just log it
            }
        }

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, product });
    } catch (error) {
        console.error('Create product error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/admin/marketplace/products/:id
router.put('/products/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            name, category_id, description, country,
            price_usd, price_ngn, delivery_type,
            status, stock
        } = req.body;

        const { data, error } = await supabaseAdmin
            .from('marketplace_products')
            .update({
                name,
                category_id,
                description,
                country,
                price_usd,
                price_ngn: price_ngn || Math.round(price_usd * 1600),
                stock: stock || 0,
                delivery_type: delivery_type || 'structured',
                status: status || 'Active',
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            console.error('Update product error:', error);
            throw error;
        }

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, product: data });
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/admin/marketplace/products/:id
router.delete('/products/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Delete inventory items first
        await supabaseAdmin
            .from('marketplace_inventory')
            .delete()
            .eq('product_id', id);

        // Delete product
        const { error } = await supabaseAdmin
            .from('marketplace_products')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Delete product error:', error);
            throw error;
        }

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, message: 'Product deleted' });
    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ════════════════════════════════════════════════
// INVENTORY MANAGEMENT
// ════════════════════════════════════════════════

// GET /api/admin/marketplace/inventory/:productId
router.get('/inventory/:productId', verifyAdmin, async (req, res) => {
    try {
        const { productId } = req.params;
        const { status } = req.query;

        let query = supabaseAdmin
            .from('marketplace_inventory')
            .select('*')
            .eq('product_id', productId)
            .order('created_at', { ascending: false });

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        const { data, error } = await query;
        if (error) {
            console.error('Get inventory error:', error);
            throw error;
        }

        res.json({ success: true, inventory: data || [] });
    } catch (error) {
        console.error('Get inventory error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/admin/marketplace/inventory
router.post('/inventory', verifyAdmin, async (req, res) => {
    try {
        const { product_id, items, delivery_type } = req.body;

        if (!product_id || !items || !items.length) {
            return res.status(400).json({ success: false, error: 'Product ID and items required' });
        }

        // Get product details
        const { data: product, error: prodErr } = await supabaseAdmin
            .from('marketplace_products')
            .select('name, delivery_type, stock')
            .eq('id', product_id)
            .single();

        if (prodErr) {
            console.error('Get product error:', prodErr);
            throw prodErr;
        }

        const dtype = delivery_type || product.delivery_type || 'structured';
        const inventoryData = items.map(content => ({
            id: generateId('INV'),
            product_id: product_id,
            product_name: product.name,
            delivery_type: dtype,
            content: content,
            status: 'available',
            used_by: null,
            created_at: new Date().toISOString()
        }));

        const { error: invErr } = await supabaseAdmin
            .from('marketplace_inventory')
            .insert(inventoryData);

        if (invErr) {
            console.error('Inventory insert error:', invErr);
            throw invErr;
        }

        // Update product stock
        const newStock = (product.stock || 0) + items.length;
        await supabaseAdmin
            .from('marketplace_products')
            .update({ 
                stock: newStock,
                updated_at: new Date().toISOString()
            })
            .eq('id', product_id);

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ 
            success: true, 
            message: `${items.length} inventory items added`,
            added: items.length,
            new_stock: newStock
        });
    } catch (error) {
        console.error('Add inventory error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/admin/marketplace/inventory/:id
router.put('/inventory/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { content, status, used_by } = req.body;

        const { data, error } = await supabaseAdmin
            .from('marketplace_inventory')
            .update({
                content: content,
                status: status,
                used_by: used_by || null,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            console.error('Update inventory error:', error);
            throw error;
        }

        // Update product stock if status changed
        if (status === 'sold' || status === 'expired') {
            const { data: product } = await supabaseAdmin
                .from('marketplace_products')
                .select('stock')
                .eq('id', data.product_id)
                .single();

            if (product && product.stock > 0) {
                await supabaseAdmin
                    .from('marketplace_products')
                    .update({ 
                        stock: product.stock - 1,
                        sold: supabaseAdmin.raw('sold + 1'),
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', data.product_id);
            }
        }

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, inventory: data });
    } catch (error) {
        console.error('Update inventory error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/admin/marketplace/inventory/:id
router.delete('/inventory/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { data: item, error: findErr } = await supabaseAdmin
            .from('marketplace_inventory')
            .select('product_id')
            .eq('id', id)
            .single();

        if (findErr) {
            console.error('Find inventory error:', findErr);
            throw findErr;
        }

        // Delete item
        const { error } = await supabaseAdmin
            .from('marketplace_inventory')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Delete inventory error:', error);
            throw error;
        }

        // Update product stock
        if (item) {
            const { data: product } = await supabaseAdmin
                .from('marketplace_products')
                .select('stock')
                .eq('id', item.product_id)
                .single();

            if (product && product.stock > 0) {
                await supabaseAdmin
                    .from('marketplace_products')
                    .update({ 
                        stock: product.stock - 1,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', item.product_id);
            }
        }

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, message: 'Inventory item deleted' });
    } catch (error) {
        console.error('Delete inventory error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ════════════════════════════════════════════════
// CATEGORIES
// ════════════════════════════════════════════════

router.get('/categories', verifyAdmin, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('marketplace_categories')
            .select('*')
            .order('name');

        if (error) {
            console.error('Get categories error:', error);
            throw error;
        }
        
        res.json({ success: true, categories: data || [] });
    } catch (error) {
        console.error('Get categories error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/categories', verifyAdmin, async (req, res) => {
    try {
        const { name, icon, status = 'Active' } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, error: 'Name required' });
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

        if (error) {
            console.error('Create category error:', error);
            throw error;
        }

        res.json({ success: true, category: data });
    } catch (error) {
        console.error('Create category error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/categories/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, icon, status } = req.body;

        const { data, error } = await supabaseAdmin
            .from('marketplace_categories')
            .update({ 
                name, 
                icon, 
                status, 
                updated_at: new Date().toISOString() 
            })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            console.error('Update category error:', error);
            throw error;
        }

        res.json({ success: true, category: data });
    } catch (error) {
        console.error('Update category error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/categories/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('marketplace_categories')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Delete category error:', error);
            throw error;
        }

        res.json({ success: true, message: 'Category deleted' });
    } catch (error) {
        console.error('Delete category error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ════════════════════════════════════════════════
// DASHBOARD STATS
// ════════════════════════════════════════════════

router.get('/stats', verifyAdmin, async (req, res) => {
    try {
        // Get all products
        const { data: products, error: productsErr } = await supabaseAdmin
            .from('marketplace_products')
            .select('status, stock, sold, price_usd, price_ngn');

        if (productsErr) {
            console.error('Products stats error:', productsErr);
            // Return empty stats instead of failing
            return res.json({ 
                success: true, 
                stats: {
                    totalProducts: 0,
                    active: 0,
                    totalStock: 0,
                    totalSold: 0,
                    lowStock: 0,
                    outOfStock: 0,
                    totalOrders: 0,
                    pending: 0,
                    completed: 0,
                    usdRev: 0,
                    ngnRev: 0,
                    available: 0,
                    soldItems: 0
                }
            });
        }

        // Get all orders
        const { data: orders, error: ordersErr } = await supabaseAdmin
            .from('marketplace_orders')
            .select('status, total, currency, created_at');

        if (ordersErr) {
            console.error('Orders stats error:', ordersErr);
        }

        // Get all inventory
        const { data: inventory, error: invErr } = await supabaseAdmin
            .from('marketplace_inventory')
            .select('status');

        if (invErr) {
            console.error('Inventory stats error:', invErr);
        }

        const totalProducts = products?.length || 0;
        const active = products?.filter(p => p.status === 'Active').length || 0;
        const totalStock = products?.reduce((sum, p) => sum + (p.stock || 0), 0) || 0;
        const totalSold = products?.reduce((sum, p) => sum + (p.sold || 0), 0) || 0;
        const lowStock = products?.filter(p => p.stock > 0 && p.stock < 10).length || 0;
        const outOfStock = products?.filter(p => p.stock === 0).length || 0;

        const totalOrders = orders?.length || 0;
        const pending = orders?.filter(o => o.status === 'pending' || o.status === 'processing').length || 0;
        const completed = orders?.filter(o => o.status === 'completed').length || 0;

        const usdRev = orders?.filter(o => o.currency === 'USD' && o.status === 'completed')
            .reduce((sum, o) => sum + (o.total || 0), 0) || 0;
        const ngnRev = orders?.filter(o => o.currency === 'NGN' && o.status === 'completed')
            .reduce((sum, o) => sum + (o.total || 0), 0) || 0;

        const available = inventory?.filter(i => i.status === 'available').length || 0;
        const soldItems = inventory?.filter(i => i.status === 'sold').length || 0;

        res.json({
            success: true,
            stats: {
                totalProducts,
                active,
                totalStock,
                totalSold,
                lowStock,
                outOfStock,
                totalOrders,
                pending,
                completed,
                usdRev,
                ngnRev,
                available,
                soldItems
            }
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ════════════════════════════════════════════════
// ORDERS
// ════════════════════════════════════════════════

router.get('/orders', verifyAdmin, async (req, res) => {
    try {
        const { status, limit = 50, page = 1 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = supabaseAdmin
            .from('marketplace_orders')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false });

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        query = query.range(offset, offset + parseInt(limit) - 1);

        const { data, error, count } = await query;
        if (error) {
            console.error('Orders query error:', error);
            return res.json({ success: true, orders: [], count: 0 });
        }

        // Try to get user details if user_id exists
        let enrichedOrders = data || [];
        if (enrichedOrders.length > 0) {
            const userIds = enrichedOrders.map(o => o.user_id).filter(Boolean);
            if (userIds.length > 0) {
                const { data: users } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email')
                    .in('id', userIds);
                
                const userMap = {};
                (users || []).forEach(u => { userMap[u.id] = u; });
                
                enrichedOrders = enrichedOrders.map(o => ({
                    ...o,
                    user_name: userMap[o.user_id]?.username || o.customer_name || 'Unknown',
                    user_email: userMap[o.user_id]?.email || o.email || 'Unknown'
                }));
            }
        }

        res.json({
            success: true,
            orders: enrichedOrders,
            count: count || 0,
            page: parseInt(page),
            totalPages: Math.ceil((count || 0) / parseInt(limit))
        });
    } catch (error) {
        console.error('Orders error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ════════════════════════════════════════════════
// SEARCH
// ════════════════════════════════════════════════

router.get('/search', verifyAdmin, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) {
            return res.json({ success: true, results: { products: [], orders: [], inventory: [] } });
        }

        const searchTerm = `%${q}%`;

        // Search products
        const { data: products, error: prodErr } = await supabaseAdmin
            .from('marketplace_products')
            .select('id, name, category_id, price_usd, price_ngn, stock, status')
            .or(`name.ilike.${searchTerm},id.ilike.${searchTerm}`)
            .limit(10);

        if (prodErr) {
            console.error('Search products error:', prodErr);
        }

        // Search orders
        const { data: orders, error: orderErr } = await supabaseAdmin
            .from('marketplace_orders')
            .select('id, order_ref, customer_name, email, product_name, total, status')
            .or(`order_ref.ilike.${searchTerm},customer_name.ilike.${searchTerm},email.ilike.${searchTerm},product_name.ilike.${searchTerm}`)
            .limit(10);

        if (orderErr) {
            console.error('Search orders error:', orderErr);
        }

        // Search inventory
        const { data: inventory, error: invErr } = await supabaseAdmin
            .from('marketplace_inventory')
            .select('id, product_name, content, status')
            .or(`content.ilike.${searchTerm},product_name.ilike.${searchTerm},id.ilike.${searchTerm}`)
            .limit(10);

        if (invErr) {
            console.error('Search inventory error:', invErr);
        }

        res.json({
            success: true,
            results: {
                products: products || [],
                orders: orders || [],
                inventory: inventory || []
            }
        });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;