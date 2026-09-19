// routes/presenceRoutes.js - COMPLETE FAST VERSION
// Heartbeat every 5 seconds, minimal database operations

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

// ─── CONSTANTS ──────────────────────────────────────────────────────
const ONLINE_THRESHOLD_SECONDS = 15; // 15 seconds = offline after 3 missed heartbeats
const HEARTBEAT_INTERVAL_MS = 5000; // 5 seconds

// ─── HELPERS ──────────────────────────────────────────────────────

function parseBrowser(ua) {
    if (!ua) return 'Unknown';
    const u = ua.toLowerCase();
    if (u.includes('edg')) return 'Edge';
    if (u.includes('opr') || u.includes('opera')) return 'Opera';
    if (u.includes('chrome') && !u.includes('edg') && !u.includes('brave')) return 'Chrome';
    if (u.includes('firefox')) return 'Firefox';
    if (u.includes('safari') && !u.includes('chrome')) return 'Safari';
    if (u.includes('brave')) return 'Brave';
    if (u.includes('samsung')) return 'Samsung Internet';
    if (u.includes('ucbrowser')) return 'UC Browser';
    return 'Unknown';
}

function parseOS(ua) {
    if (!ua) return 'Unknown';
    const u = ua.toLowerCase();
    if (u.includes('android')) return 'Android';
    if (u.includes('iphone') || u.includes('ipad') || u.includes('ipod')) return 'iOS';
    if (u.includes('windows')) return 'Windows';
    if (u.includes('mac os x') || u.includes('macintosh')) return 'macOS';
    if (u.includes('linux')) return 'Linux';
    if (u.includes('chrome os')) return 'Chrome OS';
    return 'Unknown';
}

function parseDevice(ua) {
    if (!ua) return 'Desktop';
    const u = ua.toLowerCase();
    if (u.includes('mobile') || u.includes('iphone') || (u.includes('android') && !u.includes('tablet'))) {
        return 'Mobile';
    }
    if (u.includes('tablet') || u.includes('ipad')) return 'Tablet';
    return 'Desktop';
}

function getUserAgentInfo(req) {
    const ua = req.headers['user-agent'] || '';
    return {
        browser: parseBrowser(ua),
        os: parseOS(ua),
        device: parseDevice(ua),
        raw: ua
    };
}

// ─── CHECK IF TABLE EXISTS (cached) ──────────────────────────────

let tableExistsCache = null;
let tableExistsTime = 0;
const CACHE_TTL = 60000; // 1 minute

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

// ═══════════════════════════════════════════════════════════════════
//  POST /api/presence/heartbeat - FAST (no extra queries)
// ═══════════════════════════════════════════════════════════════════

router.post('/heartbeat', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date().toISOString();
        
        const { page, action, tabId } = req.body || {};
        const uaInfo = getUserAgentInfo(req);

        // ─── Get admin status from JWT, NOT from browser ────────────
        const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';

        // ─── Check if user_presence table exists (cached) ───────────
        const tableOk = await checkTableExists();

        if (tableOk) {
            // ─── Upsert into user_presence ──────────────────────────
            await supabaseAdmin
                .from('user_presence')
                .upsert({
                    user_id: userId,
                    last_seen: now,
                    current_page: page || null,
                    current_action: action || null,
                    tab_id: tabId || null,
                    is_visible: true,
                    is_admin: isAdmin,
                    browser: uaInfo.browser,
                    os: uaInfo.os,
                    device: uaInfo.device,
                    ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                    is_online: true,
                    updated_at: now,
                    last_heartbeat: now
                }, {
                    onConflict: 'user_id'
                });
        }

        // ─── Always update profiles ──────────────────────────────────
        await supabaseAdmin
            .from('profiles')
            .update({
                last_seen: now,
                current_page: page || null,
                last_login_browser: uaInfo.browser,
                last_login_os: uaInfo.os,
                last_login_device: uaInfo.device,
                updated_at: now
            })
            .eq('id', userId);

        // ─── Return minimal response (NO count query) ───────────────
        res.json({
            success: true,
            message: 'Heartbeat received',
            data: {
                user_id: userId,
                last_seen: now,
                is_online: true
            }
        });

    } catch (error) {
        console.error('❌ Heartbeat error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process heartbeat'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/presence/offline - Mark user offline
// ═══════════════════════════════════════════════════════════════════

router.post('/offline', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date().toISOString();

        const tableOk = await checkTableExists();
        if (tableOk) {
            await supabaseAdmin
                .from('user_presence')
                .update({
                    is_online: false,
                    last_seen: now,
                    updated_at: now
                })
                .eq('user_id', userId);
        }

        await supabaseAdmin
            .from('profiles')
            .update({
                last_seen: now,
                updated_at: now
            })
            .eq('id', userId);

        res.json({
            success: true,
            message: 'User marked offline'
        });

    } catch (error) {
        console.error('❌ Offline error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to mark user offline'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/presence/offline-beacon - Beacon for page unload
// ═══════════════════════════════════════════════════════════════════

router.post('/offline-beacon', async (req, res) => {
    try {
        const { userId } = req.body || {};

        if (!userId) {
            return res.status(400).send('Missing userId');
        }

        const now = new Date().toISOString();

        const tableOk = await checkTableExists();
        if (tableOk) {
            await supabaseAdmin
                .from('user_presence')
                .update({
                    is_online: false,
                    last_seen: now,
                    updated_at: now
                })
                .eq('user_id', userId);
        }

        await supabaseAdmin
            .from('profiles')
            .update({
                last_seen: now,
                updated_at: now
            })
            .eq('id', userId);

        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ Beacon error:', error);
        res.status(500).send('Error');
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/presence/online-count - Fast count (NO rate limit)
// ═══════════════════════════════════════════════════════════════════

router.get('/online-count', authMiddleware, async (req, res) => {
    try {
        const fifteenSecondsAgo = new Date(Date.now() - ONLINE_THRESHOLD_SECONDS * 1000).toISOString();

        let count = 0;
        let source = 'profiles';

        // ─── Try user_presence first ──────────────────────────────────
        try {
            const tableOk = await checkTableExists();
            if (tableOk) {
                const { count: c, error } = await supabaseAdmin
                    .from('user_presence')
                    .select('*', { count: 'exact', head: true })
                    .gte('last_seen', fifteenSecondsAgo);

                if (!error) {
                    count = c || 0;
                    source = 'user_presence';
                }
            }
        } catch (e) {
            // Fallback to profiles
        }

        // ─── Fallback: use profiles ──────────────────────────────────
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