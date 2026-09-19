// routes/tickerRoutes.js - Complete Ticker Management System
// FIXED: Uses actual table schema (active instead of status)

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────
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
        req.adminId = decoded.userId || decoded.sub || decoded.id || decoded.user?.id;
        req.adminRole = role;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

// ─── HELPER FUNCTIONS ───────────────────────────────────────────────

function parseLimit(value, defaultLimit = 20, maxLimit = 100) {
    const parsed = parseInt(value);
    if (isNaN(parsed) || parsed < 1) return defaultLimit;
    return Math.min(parsed, maxLimit);
}

// ═══════════════════════════════════════════════════════════════════
//  GET /api/ticker/items - Get all ticker items (public)
// ═══════════════════════════════════════════════════════════════════

router.get('/items', async (req, res) => {
    try {
        const limit = parseLimit(req.query.limit, 20, 100);
        const { data, error } = await supabaseAdmin
            .from('ticker_items')
            .select('*')
            .eq('active', true)
            .order('sort_order', { ascending: true })
            .limit(limit);

        if (error) {
            console.error('❌ Ticker items error:', error);
            return res.json({ success: true, data: [] });
        }

        res.json({ success: true, data: data || [] });

    } catch (error) {
        console.error('❌ Ticker items error:', error);
        res.json({ success: true, data: [] });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/ticker/active - Get active ticker items (public)
// ═══════════════════════════════════════════════════════════════════

router.get('/active', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('ticker_items')
            .select('*')
            .eq('active', true)
            .order('sort_order', { ascending: true });

        if (error) {
            console.error('❌ Active ticker error:', error);
            return res.json({ success: true, data: [] });
        }

        res.json({ success: true, data: data || [] });

    } catch (error) {
        console.error('❌ Active ticker error:', error);
        res.json({ success: true, data: [] });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/ticker/:id - Get single ticker item
// ═══════════════════════════════════════════════════════════════════

router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabaseAdmin
            .from('ticker_items')
            .select('*')
            .eq('id', id)
            .single();

        if (error) {
            return res.status(404).json({
                success: false,
                error: 'Ticker item not found'
            });
        }

        res.json({ success: true, data });

    } catch (error) {
        console.error('❌ Get ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/ticker - Get all ticker items (admin)
// ═══════════════════════════════════════════════════════════════════

router.get('/', verifyAdmin, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('ticker_items')
            .select('*')
            .order('sort_order', { ascending: true });

        if (error) {
            console.error('❌ Get all ticker error:', error);
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }

        res.json({ success: true, data: data || [] });

    } catch (error) {
        console.error('❌ Get all ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/ticker - Create ticker item (admin only)
// ═══════════════════════════════════════════════════════════════════

router.post('/', verifyAdmin, async (req, res) => {
    try {
        const { icon, text, badge, badge_color, link, title, sort_order, active } = req.body;

        if (!text) {
            return res.status(400).json({
                success: false,
                error: 'Text is required'
            });
        }

        const { data, error } = await supabaseAdmin
            .from('ticker_items')
            .insert({
                icon: icon || '📌',
                text: text,
                badge: badge || null,
                badge_color: badge_color || null,
                link: link || null,
                title: title || null,
                sort_order: sort_order || 999,
                active: active !== undefined ? active : true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            console.error('❌ Create ticker error:', error);
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }

        res.json({
            success: true,
            message: 'Ticker item created successfully',
            data
        });

    } catch (error) {
        console.error('❌ Create ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  PUT /api/ticker/:id - Update ticker item (admin only)
// ═══════════════════════════════════════════════════════════════════

router.put('/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { icon, text, badge, badge_color, link, title, sort_order, active } = req.body;

        const updateData = {};
        if (icon !== undefined) updateData.icon = icon;
        if (text !== undefined) updateData.text = text;
        if (badge !== undefined) updateData.badge = badge;
        if (badge_color !== undefined) updateData.badge_color = badge_color;
        if (link !== undefined) updateData.link = link;
        if (title !== undefined) updateData.title = title;
        if (sort_order !== undefined) updateData.sort_order = sort_order;
        if (active !== undefined) updateData.active = active;
        updateData.updated_at = new Date().toISOString();

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No fields to update'
            });
        }

        const { data, error } = await supabaseAdmin
            .from('ticker_items')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            console.error('❌ Update ticker error:', error);
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }

        res.json({
            success: true,
            message: 'Ticker item updated successfully',
            data
        });

    } catch (error) {
        console.error('❌ Update ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  DELETE /api/ticker/:id - Delete ticker item (admin only)
// ═══════════════════════════════════════════════════════════════════

router.delete('/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('ticker_items')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('❌ Delete ticker error:', error);
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }

        res.json({
            success: true,
            message: 'Ticker item deleted successfully'
        });

    } catch (error) {
        console.error('❌ Delete ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/ticker/bulk - Bulk create/update ticker items
// ═══════════════════════════════════════════════════════════════════

router.post('/bulk', verifyAdmin, async (req, res) => {
    try {
        const { items } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Items array is required'
            });
        }

        const now = new Date().toISOString();
        const results = [];

        for (const item of items) {
            if (item.id) {
                // Update existing
                const { data, error } = await supabaseAdmin
                    .from('ticker_items')
                    .update({
                        icon: item.icon || '📌',
                        text: item.text,
                        badge: item.badge || null,
                        badge_color: item.badge_color || null,
                        link: item.link || null,
                        title: item.title || null,
                        sort_order: item.sort_order || 999,
                        active: item.active !== undefined ? item.active : true,
                        updated_at: now
                    })
                    .eq('id', item.id)
                    .select()
                    .single();

                if (error) {
                    results.push({ id: item.id, error: error.message });
                } else {
                    results.push({ id: item.id, success: true, data });
                }
            } else {
                // Create new
                const { data, error } = await supabaseAdmin
                    .from('ticker_items')
                    .insert({
                        icon: item.icon || '📌',
                        text: item.text,
                        badge: item.badge || null,
                        badge_color: item.badge_color || null,
                        link: item.link || null,
                        title: item.title || null,
                        sort_order: item.sort_order || 999,
                        active: item.active !== undefined ? item.active : true,
                        created_at: now,
                        updated_at: now
                    })
                    .select()
                    .single();

                if (error) {
                    results.push({ text: item.text, error: error.message });
                } else {
                    results.push({ success: true, data });
                }
            }
        }

        res.json({
            success: true,
            message: `Processed ${results.length} items`,
            results
        });

    } catch (error) {
        console.error('❌ Bulk ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/ticker/reorder - Reorder ticker items
// ═══════════════════════════════════════════════════════════════════

router.post('/reorder', verifyAdmin, async (req, res) => {
    try {
        const { orders } = req.body;

        if (!orders || !Array.isArray(orders)) {
            return res.status(400).json({
                success: false,
                error: 'Orders array is required'
            });
        }

        const results = [];
        for (const item of orders) {
            const { data, error } = await supabaseAdmin
                .from('ticker_items')
                .update({ 
                    sort_order: item.sort_order || item.order || 999, 
                    updated_at: new Date().toISOString() 
                })
                .eq('id', item.id)
                .select()
                .single();

            if (error) {
                results.push({ id: item.id, error: error.message });
            } else {
                results.push({ id: item.id, success: true });
            }
        }

        res.json({
            success: true,
            message: 'Ticker items reordered',
            results
        });

    } catch (error) {
        console.error('❌ Reorder ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/ticker/toggle/:id - Toggle active status
// ═══════════════════════════════════════════════════════════════════

router.post('/toggle/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Get current status
        const { data: current, error: getError } = await supabaseAdmin
            .from('ticker_items')
            .select('active')
            .eq('id', id)
            .single();

        if (getError) {
            return res.status(404).json({
                success: false,
                error: 'Ticker item not found'
            });
        }

        const { data, error } = await supabaseAdmin
            .from('ticker_items')
            .update({
                active: !current.active,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            console.error('❌ Toggle ticker error:', error);
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }

        res.json({
            success: true,
            message: `Ticker item ${data.active ? 'activated' : 'deactivated'}`,
            data
        });

    } catch (error) {
        console.error('❌ Toggle ticker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;