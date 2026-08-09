// routes/presenceRoutes.js - Complete Fixed Version
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

// ─── PARSE USER AGENT ───
function parseBrowser(ua) {
    if (!ua) return 'Unknown';
    if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) return 'Chrome';
    if (/Firefox/i.test(ua)) return 'Firefox';
    if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
    if (/Edg/i.test(ua)) return 'Edge';
    if (/Opera|OPR/i.test(ua)) return 'Opera';
    return 'Unknown';
}

function parseDevice(ua) {
    if (!ua) return 'Desktop';
    if (/Mobile|Android|iPhone|iPad|iPod/i.test(ua)) return 'Mobile';
    if (/Tablet/i.test(ua)) return 'Tablet';
    return 'Desktop';
}

// ─── HEARTBEAT ───
// ✅ Uses the main authMiddleware (which handles Supabase + JWT fallback)
router.post('/heartbeat', authMiddleware, async (req, res) => {
    try {
        const { page, action, tabId } = req.body || {};
        const ua = req.headers['user-agent'] || '';
        const now = new Date().toISOString();

        const userId = req.user.id;

        // Upsert presence record
        const { data, error } = await supabaseAdmin
            .from('user_presence')
            .upsert({
                user_id: userId,
                last_seen: now,
                current_page: page || null,
                current_action: action || null,
                tab_id: tabId || null,
                browser: parseBrowser(ua),
                device: parseDevice(ua),
                updated_at: now,
            }, {
                onConflict: 'user_id',
                ignoreDuplicates: false
            })
            .select()
            .single();

        if (error) {
            console.error('Presence upsert error:', error);
            // Don't fail the request - presence is non-critical
            return res.json({ 
                success: true, 
                message: 'Heartbeat received (with warning)',
                user_id: userId,
                last_seen: now,
                warning: error.message
            });
        }

        // Update profiles (async, don't wait)
        supabaseAdmin
            .from('profiles')
            .update({
                last_seen: now,
                current_page: page || null,
                browser: parseBrowser(ua),
                device_type: parseDevice(ua)
            })
            .eq('id', userId)
            .then(() => {})
            .catch(() => {});

        res.json({
            success: true,
            message: 'Heartbeat received',
            user_id: userId,
            last_seen: now
        });

    } catch (error) {
        console.error('Heartbeat error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ─── OFFLINE ───
router.post('/offline', authMiddleware, async (req, res) => {
    try {
        const pastTime = new Date(Date.now() - 120000).toISOString();

        await supabaseAdmin
            .from('user_presence')
            .update({
                last_seen: pastTime,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', req.user.id);

        res.json({ success: true, message: 'User marked offline' });

    } catch (error) {
        console.error('Offline error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;