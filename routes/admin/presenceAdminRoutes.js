// routes/admin/presenceAdminRoutes.js - FIXED: Supabase auth + custom JWT fallback
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { supabase, supabaseAdmin } = require('../../db/supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'miles-exchange-secret-key-2024';

// ─── MIDDLEWARE: Verify Admin (Supabase first, custom JWT fallback) ───
async function verifyAdmin(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }

    try {
        // Try Supabase auth first
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (!error && user) {
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single();

            if (profile && (profile.role === 'admin' || profile.role === 'super_admin')) {
                req.userId = profile.id;
                req.user = profile;
                req.isAdmin = true;
                req.token = token;
                return next();
            }

            if (profile) {
                // Valid Supabase user, but not an admin — don't fall through to JWT
                return res.status(403).json({ success: false, error: 'Admin access required' });
            }
        }

        // Fallback: custom JWT (issued by /api/admin/login)
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }

        req.userId = decoded.userId;
        req.user = { id: decoded.userId, email: decoded.email, role: decoded.role };
        req.isAdmin = true;
        req.token = token;
        next();
    } catch (e) {
        if (e.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, error: 'Token expired' });
        }
        console.error('Admin auth error:', e.message);
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

// ─── GET ONLINE USERS ───
router.get('/online', verifyAdmin, async (req, res) => {
    try {
        const now = Date.now();
        const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();

        // Get all presence records with user profiles
        const { data: presenceData, error: presenceError } = await supabaseAdmin
            .from('user_presence')
            .select(`
                user_id,
                last_seen,
                current_page,
                current_action,
                browser,
                device,
                tab_id
            `)
            .gte('last_seen', fiveMinAgo)
            .order('last_seen', { ascending: false });

        if (presenceError) {
            console.error('Presence query error:', presenceError);
            // Fallback: get from profiles last_seen
            const { data: fallbackData } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email, avatar_url, last_seen, current_page, browser, device_type')
                .gte('last_seen', fiveMinAgo)
                .order('last_seen', { ascending: false })
                .limit(500);

            if (fallbackData) {
                const users = fallbackData.map(p => ({
                    user_id: p.id,
                    username: p.username || p.email?.split('@')[0] || 'Unknown',
                    email: p.email || '',
                    avatar_url: p.avatar_url || null,
                    location: 'N/A',
                    last_seen: p.last_seen,
                    current_page: p.current_page || '/',
                    current_action: 'viewing',
                    browser: p.browser || 'Unknown',
                    device: p.device_type || 'Desktop',
                    is_online: p.last_seen ? (Date.now() - new Date(p.last_seen).getTime()) < 90000 : false,
                    last_seen_human: p.last_seen ? formatTimeAgo(new Date(p.last_seen)) : 'Never'
                }));

                const onlineNow = users.filter(u => u.is_online);

                return res.json({
                    success: true,
                    data: {
                        users: users,
                        online_now: onlineNow.length,
                        active_5min: onlineNow.length,
                        active_30min: users.filter(u => (Date.now() - new Date(u.last_seen).getTime()) < 1800000).length,
                        active_today: users.filter(u => u.last_seen && new Date(u.last_seen).toDateString() === new Date().toDateString()).length,
                        total_users: users.length,
                        timestamp: new Date().toISOString()
                    }
                });
            }
            return res.status(500).json({ success: false, error: presenceError.message });
        }

        // Build user list
        const userIds = presenceData?.map(p => p.user_id).filter(Boolean) || [];
        let userMap = {};

        if (userIds.length > 0) {
            const { data: profiles } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email, avatar_url')
                .in('id', userIds);

            (profiles || []).forEach(p => {
                userMap[p.id] = p;
            });
        }

        const users = (presenceData || []).map(r => {
            const lastSeen = new Date(r.last_seen);
            const secondsAgo = (now - lastSeen.getTime()) / 1000;
            const profile = userMap[r.user_id] || {};

            return {
                user_id: r.user_id,
                username: profile.username || profile.email?.split('@')[0] || 'Unknown',
                email: profile.email || '',
                avatar_url: profile.avatar_url || null,
                location: 'N/A',
                last_seen: r.last_seen,
                current_page: r.current_page || '/',
                current_action: r.current_action || 'viewing',
                browser: r.browser || 'Unknown',
                device: r.device || 'Desktop',
                tab_id: r.tab_id || null,
                is_online: secondsAgo < 90,
                last_seen_human: formatTimeAgo(lastSeen),
                seconds_ago: Math.round(secondsAgo)
            };
        });

        // Count total users
        const { count: totalUsers } = await supabaseAdmin
            .from('profiles')
            .select('*', { count: 'exact', head: true });

        const onlineNow = users.filter(u => u.is_online);
        const active5min = users.filter(u => (Date.now() - new Date(u.last_seen).getTime()) < 300000);
        const active30min = users.filter(u => (Date.now() - new Date(u.last_seen).getTime()) < 1800000);
        const activeToday = users.filter(u =>
            u.last_seen && new Date(u.last_seen).toDateString() === new Date().toDateString()
        );

        res.json({
            success: true,
            data: {
                users: users,
                online_now: onlineNow.length,
                active_5min: active5min.length,
                active_30min: active30min.length,
                active_today: activeToday.length,
                total_users: totalUsers || 0,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Online users error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET USER ACTIVITY ───
router.get('/user/:userId', verifyAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        const { data, error } = await supabaseAdmin
            .from('user_presence')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error && error.code !== 'PGRST116') {
            return res.status(500).json({ success: false, error: error.message });
        }

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('username, email, avatar_url, last_seen, current_page')
            .eq('id', userId)
            .single();

        res.json({
            success: true,
            data: {
                user: profile,
                presence: data || null,
                is_online: data ? (Date.now() - new Date(data.last_seen).getTime()) < 90000 : false
            }
        });

    } catch (error) {
        console.error('User activity error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── HELPER: Format time ago ───
function formatTimeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
}

module.exports = router;