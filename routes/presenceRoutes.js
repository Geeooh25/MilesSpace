// routes/presenceRoutes.js
// ─────────────────────────────────────────────────────────────────
// Customer presence.
//
//   - Heartbeat writes ONLY to user_presence. No profiles writes.
//   - Online Now = last_seen within 90s (heartbeat is 30s → 3× margin).
//   - Never uses is_online as the online authority.
//   - No unauthenticated offline-beacon endpoint.
//   - is_admin comes from req.user.role, never from the body.
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

const ONLINE_THRESHOLD_MS = 90 * 1000;

// ─── User-agent parsing (kept, minimal) ──────────────────────────

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
    if (u.includes('mobile') || u.includes('iphone') || (u.includes('android') && !u.includes('tablet'))) return 'Mobile';
    if (u.includes('tablet') || u.includes('ipad')) return 'Tablet';
    return 'Desktop';
}

function uaInfo(req) {
    const ua = req.headers['user-agent'] || '';
    return {
        browser: parseBrowser(ua),
        os: parseOS(ua),
        device: parseDevice(ua)
    };
}

// ─── Heartbeat ───────────────────────────────────────────────────

router.post('/heartbeat', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date().toISOString();
        const { page, action, tab_id } = req.body || {};
        const info = uaInfo(req);

        // Derive admin from the authenticated role — never trust body.
        const role = String(req.user.role || 'user').toLowerCase();
        const isAdmin = role === 'admin' || role === 'super_admin';

        // Single write.
        const { error } = await supabaseAdmin
            .from('user_presence')
            .upsert({
                user_id: userId,
                last_seen: now,
                current_page: page || null,
                current_action: action || 'viewing page',
                tab_id: tab_id || null,
                is_visible: true,
                is_admin: isAdmin,
                browser: info.browser,
                os: info.os,
                device: info.device,
                ip_address: req.ip || null,
                updated_at: now,
                last_heartbeat: now
            }, { onConflict: 'user_id' });

        if (error) {
            console.error('[PRESENCE] heartbeat upsert error:', error.message);
            return res.status(500).json({ success: false, error: 'heartbeat failed', code: 'PRESENCE_UPSERT_FAILED' });
        }

        return res.json({
            success: true,
            data: { user_id: userId, last_seen: now }
        });
    } catch (err) {
        console.error('[PRESENCE] heartbeat exception:', err.message);
        return res.status(500).json({ success: false, error: 'heartbeat exception', code: 'PRESENCE_HEARTBEAT_EXCEPTION' });
    }
});

// ─── Online count ────────────────────────────────────────────────

router.get('/online-count', authMiddleware, async (req, res) => {
    try {
        const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS).toISOString();

        const { count, error } = await supabaseAdmin
            .from('user_presence')
            .select('user_id', { count: 'exact', head: true })
            .gte('last_seen', threshold);

        if (error) {
            console.error('[PRESENCE] online-count error:', error.message);
            return res.status(500).json({ success: false, error: 'count failed', code: 'PRESENCE_COUNT_FAILED' });
        }

        return res.json({
            success: true,
            data: {
                online_count: count || 0,
                threshold_seconds: ONLINE_THRESHOLD_MS / 1000,
                timestamp: new Date().toISOString()
            }
        });
    } catch (err) {
        console.error('[PRESENCE] online-count exception:', err.message);
        return res.status(500).json({ success: false, error: 'count exception', code: 'PRESENCE_COUNT_EXCEPTION' });
    }
});

// NOTE: /offline and /offline-beacon have been intentionally REMOVED.
// Offline is now decided by server-side aging of last_seen. The
// client cannot declare itself offline, and nobody can declare
// anyone else offline.

module.exports = router;