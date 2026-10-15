// routes/presenceRoutes.js
// ─────────────────────────────────────────────────────────────────
// Customer presence — heartbeat + online count.
//
// Security & privacy:
//   • Every heartbeat is authenticated.
//   • Identity and role are derived server-side only.
//   • Body is whitelisted to { page, tab_id }.
//   • All timestamps are UTC ISO-8601.
//   • Uses service-role client to bypass RLS for the write path
//     after the server has authenticated the caller. This is the
//     documented design in the security brief §8.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();
const { supabaseAdmin, withSupabaseRetry } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { classifyRole }  = require('../middleware/roles');

const ONLINE_THRESHOLD_MS = 90 * 1000;

// ─── UTC helpers ─────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }

// ─── Input validation ───────────────────────────────────────────
function safeString(v, maxLen) {
    if (v == null || typeof v !== 'string') return null;
    const t = v.trim();
    if (!t) return null;
    return t.slice(0, maxLen);
}

// A minimal page allowlist. The frontend uses these paths; the
// server enforces them so a malicious client cannot inject
// arbitrary strings into the presence table.
const ALLOWED_PAGES = new Set([
    '/dashboard', '/dashboard.html',
    '/market', '/market.html',
    '/profile', '/profile.html',
    '/fund', '/fund.html',
    '/airtime', '/airtime.html',
    '/boost', '/boost.html',
    '/history', '/history.html',
    '/notifications', '/notifications.html',
    '/virtual', '/virtual.html',
    '/sellgift', '/sellgift.html',
    '/sendgift', '/sendgift.html',
    '/cashback', '/cashback.html',
    '/coin', '/coin.html',
    '/buy-crypto',
    '/usersettings', '/usersettings.html'
]);

function normalisePage(p) {
    const v = safeString(p, 128);
    if (!v) return '/dashboard';
    if (ALLOWED_PAGES.has(v)) return v;
    // Accept any /path under /dashboard tree; reject anything else.
    if (v.startsWith('/dashboard')) return '/dashboard';
    return '/other';
}

// ─── User-agent parsing ─────────────────────────────────────────
function parseBrowser(ua) {
    if (!ua) return 'Unknown';
    const u = ua.toLowerCase();
    if (u.includes('edg')) return 'Edge';
    if (u.includes('opr') || u.includes('opera')) return 'Opera';
    if (u.includes('samsung')) return 'Samsung Internet';
    if (u.includes('ucbrowser')) return 'UC Browser';
    if (u.includes('brave')) return 'Brave';
    if (u.includes('firefox')) return 'Firefox';
    if (u.includes('chrome')) return 'Chrome';
    if (u.includes('safari')) return 'Safari';
    return 'Unknown';
}
function parseOS(ua) {
    if (!ua) return 'Unknown';
    const u = ua.toLowerCase();
    if (u.includes('android')) return 'Android';
    if (u.includes('iphone') || u.includes('ipad') || u.includes('ipod')) return 'iOS';
    if (u.includes('windows')) return 'Windows';
    if (u.includes('mac os x') || u.includes('macintosh')) return 'macOS';
    if (u.includes('chrome os')) return 'Chrome OS';
    if (u.includes('linux')) return 'Linux';
    return 'Unknown';
}
function parseDevice(ua) {
    if (!ua) return 'Desktop';
    const u = ua.toLowerCase();
    if (u.includes('ipad') || u.includes('tablet')) return 'Tablet';
    if (u.includes('mobile') || u.includes('iphone')) return 'Mobile';
    if (u.includes('android') && !u.includes('tablet')) return 'Mobile';
    return 'Desktop';
}
function parseDeviceType(ua) {
    const d = parseDevice(ua);
    return d.toLowerCase();     // 'desktop' | 'mobile' | 'tablet'
}

// ─── Client IP ──────────────────────────────────────────────────
// Trust proxy is set at app level; req.ip already honours it.
function clientIp(req) {
    return req.ip
        || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || (req.socket && req.socket.remoteAddress)
        || null;
}

// ═══════════════════════════════════════════════════════════════════
//  POST /heartbeat
// ═══════════════════════════════════════════════════════════════════
router.post('/heartbeat', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const now    = nowIso();

        const page   = normalisePage(req.body?.page);
        const tab_id = safeString(req.body?.tab_id, 64);

        const ua = req.headers['user-agent'] || '';
        const browser    = parseBrowser(ua);
        const os         = parseOS(ua);
        const device     = parseDevice(ua);
        const deviceType = parseDeviceType(ua);

        const { isAdmin } = classifyRole(req.user.role);

        const result = await withSupabaseRetry(() =>
            supabaseAdmin
                .from('user_presence')
                .upsert({
                    user_id:        userId,
                    last_seen:      now,
                    last_heartbeat: now,
                    current_page:   page,
                    current_action: 'viewing',
                    tab_id,
                    is_visible:     true,
                    is_online:      true,
                    is_admin:       isAdmin,
                    browser,
                    os,
                    device,
                    device_type:    deviceType,
                    ip_address:     clientIp(req),
                    updated_at:     now
                }, { onConflict: 'user_id' })
        );

        if (result.error) {
            console.error('[PRESENCE] heartbeat upsert error:', result.error.message);
            return res.status(503).json({
                success: false,
                error: 'presence write failed',
                code: 'PRESENCE_UPSERT_FAILED'
            });
        }

        return res.json({
            success: true,
            data: { user_id: userId, last_seen: now }
        });
    } catch (err) {
        console.error('[PRESENCE] heartbeat exception:', err.message);
        return res.status(500).json({
            success: false,
            error: 'heartbeat exception',
            code: 'PRESENCE_HEARTBEAT_EXCEPTION'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /online-count
//
//  Returns ONLY a number. No user list. Safe for any authenticated
//  caller. Staff who need the list use /api/admin/presence/online.
// ═══════════════════════════════════════════════════════════════════
router.get('/online-count', authMiddleware, async (req, res) => {
    try {
        const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS).toISOString();
        const { count, error } = await withSupabaseRetry(() =>
            supabaseAdmin
                .from('user_presence')
                .select('user_id', { count: 'exact', head: true })
                .gte('last_seen', threshold)
        );
        if (error) {
            console.error('[PRESENCE] online-count error:', error.message);
            return res.status(503).json({ success: false, error: 'count failed', code: 'PRESENCE_COUNT_FAILED' });
        }
        return res.json({
            success: true,
            data: {
                online_count: count || 0,
                threshold_seconds: ONLINE_THRESHOLD_MS / 1000,
                timestamp: nowIso()
            }
        });
    } catch (err) {
        console.error('[PRESENCE] online-count exception:', err.message);
        return res.status(500).json({ success: false, error: 'count exception', code: 'PRESENCE_COUNT_EXCEPTION' });
    }
});

module.exports = { router, ONLINE_THRESHOLD_MS };