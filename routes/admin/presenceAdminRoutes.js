// routes/admin/presenceAdminRoutes.js - COMPLETE FAST VERSION
// Online status = last_seen within 15 seconds

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { adminAuthMiddleware } = require('../../middleware/auth');

// ─── CONSTANTS ──────────────────────────────────────────────────────
const ONLINE_THRESHOLD_SECONDS = 15; // Matches presenceRoutes.js
const ADMIN_POLL_INTERVAL_MS = 2000; // 2 second polling for admin

// ─── TABLE CACHE ────────────────────────────────────────────────────

let tableExistsCache = null;
let tableExistsTime = 0;
const CACHE_TTL = 60000;

async function checkTableExists() {
    const now = Date.now();
    if (tableExistsCache !== null && (now - tableExistsTime) < CACHE_TTL) {
        return tableExistsCache;
    }

    try {
        const { error } = await supabaseAdmin
            .from('user_presence')
            .select('id')
            .limit(1);

        tableExistsCache = !error;
        tableExistsTime = now;
        return tableExistsCache;
    } catch {
        tableExistsCache = false;
        tableExistsTime = now;
        return false;
    }
}

// ─── HELPERS ──────────────────────────────────────────────────────

function formatTimeAgo(date) {
    if (!date) return 'Never';
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return 'Just now';
    if (seconds < 120) return '1 minute ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' minutes ago';
    if (seconds < 7200) return '1 hour ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' hours ago';
    if (seconds < 172800) return 'Yesterday';
    return Math.floor(seconds / 86400) + ' days ago';
}

function isOnline(lastSeen) {
    if (!lastSeen) return false;
    const age = Date.now() - new Date(lastSeen).getTime();
    return age <= ONLINE_THRESHOLD_SECONDS * 1000;
}

// ─── GET ONLINE USERS - FAST ──────────────────────────────────────

router.get('/online', adminAuthMiddleware, async (req, res) => {
    try {
        const now = Date.now();
        const fifteenSecondsAgo = new Date(now - ONLINE_THRESHOLD_SECONDS * 1000).toISOString();
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        let users = [];
        let source = 'profiles';

        // ─── Try user_presence first ──────────────────────────────────
        const tableOk = await checkTableExists();
        if (tableOk) {
            try {
                const { data, error } = await supabaseAdmin
                    .from('user_presence')
                    .select(`
                        user_id,
                        last_seen,
                        current_page,
                        current_action,
                        browser,
                        os,
                        device,
                        is_admin,
                        profiles (
                            id,
                            username,
                            email,
                            avatar_url,
                            last_login_location
                        )
                    `)
                    .gte('last_seen', fifteenSecondsAgo)
                    .order('last_seen', { ascending: false })
                    .limit(200);

                if (!error && data && data.length > 0) {
                    source = 'user_presence';
                    users = data.map(p => {
                        const profile = p.profiles || {};
                        return {
                            user_id: p.user_id,
                            username: profile.username || profile.email?.split('@')[0] || 'Unknown',
                            email: profile.email || '',
                            avatar_url: profile.avatar_url || null,
                            location: profile.last_login_location || 'Not available',
                            last_seen: p.last_seen,
                            last_seen_human: formatTimeAgo(new Date(p.last_seen)),
                            current_page: p.current_page || '/dashboard',
                            current_action: p.current_action || 'viewing',
                            browser: p.browser || 'Not available',
                            os: p.os || 'Not available',
                            device: p.device || 'Not available',
                            is_admin: p.is_admin || false,
                            is_online: true // They're in the query, so they're online
                        };
                    });
                }
            } catch (e) {
                console.log('⚠️ user_presence query error, falling back to profiles');
            }
        }

        // ─── FALLBACK: Use profiles ──────────────────────────────────
        if (users.length === 0) {
            const { data, error } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email, avatar_url, last_seen, current_page, last_login_location, last_login_browser, last_login_os, last_login_device, role')
                .gte('last_seen', fifteenSecondsAgo)
                .order('last_seen', { ascending: false })
                .limit(200);

            if (!error && data) {
                users = data.map(p => {
                    const isAdmin = p.role === 'admin' || p.role === 'super_admin';
                    return {
                        user_id: p.id,
                        username: p.username || p.email?.split('@')[0] || 'Unknown',
                        email: p.email || '',
                        avatar_url: p.avatar_url || null,
                        location: p.last_login_location || 'Not available',
                        last_seen: p.last_seen,
                        last_seen_human: p.last_seen ? formatTimeAgo(new Date(p.last_seen)) : 'Never',
                        current_page: p.current_page || '/dashboard',
                        current_action: 'viewing',
                        browser: p.last_login_browser || 'Not available',
                        os: p.last_login_os || 'Not available',
                        device: p.last_login_device || 'Not available',
                        is_admin: isAdmin,
                        is_online: true
                    };
                });
                source = 'profiles';
            }
        }

        // ─── Get total users count ────────────────────────────────────
        const { count: totalUsers } = await supabaseAdmin
            .from('profiles')
            .select('*', { count: 'exact', head: true });

        // ─── Count active today ──────────────────────────────────────
        const todayStr = todayStart.toISOString();
        const activeToday = users.filter(u => 
            u.last_seen && new Date(u.last_seen) >= new Date(todayStr)
        ).length;

        console.log(`📊 [ONLINE] Total: ${totalUsers || 0}, Online: ${users.length}`);

        res.json({
            success: true,
            data: {
                users: users,
                online_now: users.length,
                active_5min: users.length,
                active_30min: users.length,
                active_today: activeToday,
                total_users: totalUsers || 0,
                threshold_seconds: ONLINE_THRESHOLD_SECONDS,
                source: source,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ Online users error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ─── GET ONLINE COUNT (fast endpoint) ─────────────────────────────

router.get('/count', adminAuthMiddleware, async (req, res) => {
    try {
        const fifteenSecondsAgo = new Date(Date.now() - ONLINE_THRESHOLD_SECONDS * 1000).toISOString();

        let count = 0;
        let source = 'profiles';

        const tableOk = await checkTableExists();
        if (tableOk) {
            try {
                const { count: c, error } = await supabaseAdmin
                    .from('user_presence')
                    .select('*', { count: 'exact', head: true })
                    .gte('last_seen', fifteenSecondsAgo);

                if (!error) {
                    count = c || 0;
                    source = 'user_presence';
                }
            } catch (e) {
                // Fallback
            }
        }

        if (count === 0) {
            const { count: c, error } = await supabaseAdmin
                .from('profiles')
                .select('*', { count: 'exact', head: true })
                .gte('last_seen', fifteenSecondsAgo);

            if (!error) {
                count = c || 0;
                source = 'profiles';
            }
        }

        res.json({
            success: true,
            data: {
                online_count: count,
                threshold_seconds: ONLINE_THRESHOLD_SECONDS,
                source: source,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ Online count error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get online count'
        });
    }
});

module.exports = router;