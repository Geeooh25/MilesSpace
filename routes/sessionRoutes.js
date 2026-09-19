// routes/sessionRoutes.js - Session management with Redis
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { 
    setSession, 
    getSession, 
    deleteSession,
    cacheGet,
    cacheSet
} = require('../db/redis');

// ─── GET CURRENT SESSION ───
router.get('/session', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const session = await getSession(userId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Session not found'
            });
        }
        
        res.json({
            success: true,
            data: session
        });
    } catch (error) {
        console.error('Get session error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── UPDATE SESSION ───
router.post('/session/update', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data } = req.body;
        
        await setSession(userId, data, 3600);
        
        res.json({
            success: true,
            message: 'Session updated'
        });
    } catch (error) {
        console.error('Update session error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── DELETE SESSION ───
router.post('/session/delete', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        await deleteSession(userId);
        
        res.json({
            success: true,
            message: 'Session deleted'
        });
    } catch (error) {
        console.error('Delete session error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});