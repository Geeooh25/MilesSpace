// routes/notifications.js - Notification API Routes
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { 
    getNotifications, 
    getUnreadCount,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    deleteNotification,
    createNotification 
} = require('../services/notificationService');

// ─── GET /api/notifications ─────────────────────────────────────────

router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { limit = 50, unread_only = false, offset = 0 } = req.query;

        const result = await getNotifications(userId, {
            limit: parseInt(limit),
            unreadOnly: unread_only === 'true',
            offset: parseInt(offset)
        });

        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error });
        }

        res.json({
            success: true,
            data: result.data,
            total: result.count,
            unread: result.data.filter(n => !n.is_read).length
        });
    } catch (error) {
        console.error('Fetch notifications error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/notifications/unread-count ───────────────────────────

router.get('/unread-count', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await getUnreadCount(userId);

        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error });
        }

        res.json({ success: true, count: result.count });
    } catch (error) {
        console.error('Unread count error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── PUT /api/notifications/:id/read ───────────────────────────────

router.put('/:id/read', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const result = await markNotificationAsRead(userId, id);

        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error });
        }

        // Get updated unread count
        const unreadResult = await getUnreadCount(userId);

        res.json({
            success: true,
            message: 'Marked as read',
            unreadCount: unreadResult.success ? unreadResult.count : 0
        });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── PUT /api/notifications/read/all ───────────────────────────────

router.put('/read/all', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const result = await markAllNotificationsAsRead(userId);

        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error });
        }

        res.json({
            success: true,
            message: 'All marked as read',
            unreadCount: 0
        });
    } catch (error) {
        console.error('Mark all read error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── DELETE /api/notifications/:id ─────────────────────────────────

router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const result = await deleteNotification(userId, id);

        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error });
        }

        res.json({ success: true, message: 'Deleted' });
    } catch (error) {
        console.error('Delete notification error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── POST /api/notifications (Create notification - internal use) ──

router.post('/', async (req, res) => {
    try {
        const { user_id, title, message, type, icon, link, metadata } = req.body;

        if (!user_id || !title || !message) {
            return res.status(400).json({
                success: false,
                error: 'user_id, title, and message are required'
            });
        }

        const result = await createNotification(
            user_id,
            title,
            message,
            type || 'info',
            link || null,
            metadata || {}
        );

        if (!result) {
            return res.status(500).json({
                success: false,
                error: 'Failed to create notification'
            });
        }

        res.json({
            success: true,
            message: 'Notification created',
            data: result
        });
    } catch (error) {
        console.error('Create notification error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;