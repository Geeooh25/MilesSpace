const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

// ─── GET /api/notifications ───
router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { limit = 50, unread_only = false } = req.query;

        let query = supabaseAdmin
            .from('notifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (unread_only === 'true') {
            query = query.eq('is_read', false);
        }

        const { data, error } = await query;

        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error('Fetch notifications error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/notifications/unread-count ───
router.get('/unread-count', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const { count, error } = await supabaseAdmin
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        if (error) throw error;
        res.json({ success: true, count: count || 0 });
    } catch (error) {
        console.error('Unread count error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── PUT /api/notifications/:id/read ───
router.put('/:id/read', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('notifications')
            .update({
                is_read: true,
                read_at: new Date().toISOString()
            })
            .eq('id', id)
            .eq('user_id', userId);

        if (error) throw error;
        res.json({ success: true, message: 'Marked as read' });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── PUT /api/notifications/read/all ───
router.put('/read/all', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const { error } = await supabaseAdmin
            .from('notifications')
            .update({
                is_read: true,
                read_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('is_read', false);

        if (error) throw error;
        res.json({ success: true, message: 'All marked as read' });
    } catch (error) {
        console.error('Mark all read error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── DELETE /api/notifications/:id ───
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('notifications')
            .delete()
            .eq('id', id)
            .eq('user_id', userId);

        if (error) throw error;
        res.json({ success: true, message: 'Deleted' });
    } catch (error) {
        console.error('Delete notification error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── POST /api/notifications (Create notification - internal use) ───
router.post('/', async (req, res) => {
    try {
        const { user_id, title, message, type, icon, link, metadata } = req.body;

        if (!user_id || !title || !message) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        const payload = {
            user_id,
            title,
            message,
            type: type || 'info',
            icon: icon || '📌',
            link: link || null,
            metadata: metadata || {},
            is_read: false,
            created_at: new Date().toISOString()
        };

        const { data, error } = await supabaseAdmin
            .from('notifications')
            .insert(payload)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, data });
    } catch (error) {
        console.error('Create notification error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;