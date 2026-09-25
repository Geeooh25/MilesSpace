// routes/admin/presenceAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin presence — read-only.
//
//   - Online Now = last_seen within 90s.
//   - Active Today = last_seen since WAT midnight (separate query).
//   - Admin/customer classification uses profiles.role.
//   - No profiles fallback. A successful COUNT of 0 is a real 0.
//   - No fake active_5min / active_30min — those fields are honest.
//   - /heartbeat writes presence for admins the same way as users.
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { adminAuthMiddleware } = require('../../middleware/auth');

const ONLINE_THRESHOLD_MS = 90 * 1000;

// ─── Time helpers (WAT = UTC+1) ──────────────────────────────────
function watDayStartIso() {
    const OFFSET_MS = 60 * 60 * 1000;
    const now = new Date();
    const local = new Date(now.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const d = local.getUTCDate();
    return new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS).toISOString();
}

function formatTimeAgo(date) {
    if (!date) return 'Never';
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 60) return 'Just now';
    if (s < 120) return '1 minute ago';
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 7200) return '1 hour ago';
    if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
    if (s < 172800) return 'Yesterday';
    return `${Math.floor(s / 86400)} days ago`;
}

// ─── Admin heartbeat (writes to user_presence) ───────────────────
// Admin pages post here. Same table as customers; distinguished by
// the server-derived `is_admin` flag (from the authenticated role).

router.post('/heartbeat', adminAuthMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date().toISOString();
        const { page, action, tab_id } = req.body || {};
        const ua = req.headers['user-agent'] || '';

        // Server derives admin role from the authenticated user.
        const role = String(req.user.role || '').toLowerCase();
        const isAdmin = role === 'admin' || role === 'super_admin';

        const browser = /Edg/.test(ua) ? 'Edge'
            : /Firefox/.test(ua) ? 'Firefox'
            : /Chrome/.test(ua) ? 'Chrome'
            : /Safari/.test(ua) ? 'Safari'
            : 'Unknown';
        const os = /Windows/.test(ua) ? 'Windows'
            : /Mac OS X/.test(ua) ? 'macOS'
            : /Android/.test(ua) ? 'Android'
            : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
            : /Linux/.test(ua) ? 'Linux'
            : 'Unknown';
        const device = /Mobile/.test(ua) ? 'Mobile'
            : /Tablet|iPad/.test(ua) ? 'Tablet'
            : 'Desktop';

        const { error } = await supabaseAdmin
            .from('user_presence')
            .upsert({
                user_id: userId,
                last_seen: now,
                current_page: page || null,
                current_action: action || 'viewing admin',
                tab_id: tab_id || null,
                is_visible: true,
                is_admin: isAdmin,
                browser,
                os,
                device,
                ip_address: req.ip || null,
                updated_at: now,
                last_heartbeat: now
            }, { onConflict: 'user_id' });

        if (error) {
            console.error('[ADMIN PRESENCE] heartbeat error:', error.message);
            return res.status(500).json({ success: false, error: 'heartbeat failed', code: 'PRESENCE_UPSERT_FAILED' });
        }

        return res.json({ success: true, data: { user_id: userId, last_seen: now } });
    } catch (err) {
        console.error('[ADMIN PRESENCE] heartbeat exception:', err.message);
        return res.status(500).json({ success: false, error: 'heartbeat exception', code: 'PRESENCE_HEARTBEAT_EXCEPTION' });
    }
});

// ─── GET /api/admin/presence/online ──────────────────────────────

router.get('/online', adminAuthMiddleware, async (req, res) => {
    try {
        const onlineThreshold = new Date(Date.now() - ONLINE_THRESHOLD_MS).toISOString();

        // ─── 1. Online users (join profiles for role/username) ──
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
                profiles!user_presence_user_id_fkey (id, username, email, avatar_url, role)
            `)
            .gte('last_seen', onlineThreshold)
            .order('last_seen', { ascending: false })
            .limit(200);

        if (error) {
            console.error('[ADMIN PRESENCE] online query failed:', error.message);
            return res.status(503).json({ success: false, error: 'presence query failed', code: 'PRESENCE_QUERY_FAILED' });
        }

        const rows = (data || []).map(p => {
            const prof = p.profiles || {};
            const r = String(prof.role || 'user').toLowerCase();
            return {
                user_id: p.user_id,
                username: prof.username || prof.email?.split('@')[0] || 'Unknown',
                email: prof.email || '',
                avatar_url: prof.avatar_url || null,
                role: r,
                is_admin: r === 'admin' || r === 'super_admin',
                last_seen: p.last_seen,
                last_seen_human: formatTimeAgo(p.last_seen),
                current_page: p.current_page || '/dashboard',
                current_action: p.current_action || 'viewing',
                browser: p.browser || null,
                os: p.os || null,
                device: p.device || null
            };
        });

        // Dedupe by user_id (most recent wins).
        const byUser = new Map();
        for (const u of rows) {
            const existing = byUser.get(u.user_id);
            if (!existing || new Date(u.last_seen) > new Date(existing.last_seen)) {
                byUser.set(u.user_id, u);
            }
        }
        const distinct = [...byUser.values()];
        const customers = distinct.filter(u => !u.is_admin);
        const admins = distinct.filter(u => u.is_admin);

        // ─── 2. Active today (separate COUNT) ───────────────────
        const todayStart = watDayStartIso();
        const { count: activeTodayCount, error: activeErr } = await supabaseAdmin
            .from('user_presence')
            .select('user_id', { count: 'exact', head: true })
            .gte('last_seen', todayStart);

        if (activeErr) {
            console.warn('[ADMIN PRESENCE] active-today query failed:', activeErr.message);
        }

        return res.json({
            success: true,
            data: {
                online_now: distinct.length,
                online_users: customers.length,
                online_admins: admins.length,
                active_today: activeErr ? null : (activeTodayCount || 0),
                threshold_seconds: ONLINE_THRESHOLD_MS / 1000,
                timestamp: new Date().toISOString(),
                users: {
                    online_now: customers,
                    online_admins: admins,
                    all_online: distinct
                }
            }
        });
    } catch (err) {
        console.error('[ADMIN PRESENCE] online exception:', err.message);
        return res.status(500).json({ success: false, error: 'presence exception', code: 'PRESENCE_EXCEPTION' });
    }
});

// ─── GET /api/admin/presence/count ───────────────────────────────
// Cheap: uses COUNT only. For KPI tiles that just need a number.

router.get('/count', adminAuthMiddleware, async (req, res) => {
    try {
        const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS).toISOString();
        const { count, error } = await supabaseAdmin
            .from('user_presence')
            .select('user_id', { count: 'exact', head: true })
            .gte('last_seen', threshold);

        if (error) {
            console.error('[ADMIN PRESENCE] count failed:', error.message);
            return res.status(503).json({ success: false, error: 'count failed', code: 'PRESENCE_COUNT_FAILED' });
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
        console.error('[ADMIN PRESENCE] count exception:', err.message);
        return res.status(500).json({ success: false, error: 'count exception', code: 'PRESENCE_COUNT_EXCEPTION' });
    }
});

// NOTE: /offline has been intentionally REMOVED. Offline is decided
// by server-side aging of last_seen.

module.exports = router;