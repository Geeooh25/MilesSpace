// routes/admin/presenceAdminRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const { supabaseAdmin, withSupabaseRetry } = require('../../db/supabase');
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { classifyRole } = require('../../middleware/roles');

const ONLINE_THRESHOLD_MS = 90 * 1000;

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

function safeString(v, maxLen) {
    if (v == null || typeof v !== 'string') return null;
    const t = v.trim();
    if (!t) return null;
    return t.slice(0, maxLen);
}

// ─── POST /heartbeat ───────────────────────────────────────────
router.post('/heartbeat', requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ), async (req, res) => {
    try {
        const userId = req.adminContext.id;
        const now = new Date().toISOString();
        const page = safeString(req.body?.page, 128);
        const action = safeString(req.body?.action, 64) || 'viewing admin';
        const tab_id = safeString(req.body?.tab_id, 64);
        const ua = req.headers['user-agent'] || '';

        const { isAdmin } = classifyRole(req.adminContext.role);

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

        const result = await withSupabaseRetry(() =>
            supabaseAdmin.from('user_presence').upsert({
                user_id: userId,
                last_seen: now,
                current_page: page,
                current_action: action,
                tab_id,
                is_visible: true,
                is_admin: isAdmin,
                browser, os, device,
                ip_address: req.ip || null,
                updated_at: now,
                last_heartbeat: now
            }, { onConflict: 'user_id' })
        );

        if (result.error) {
            console.error('[ADMIN PRESENCE] heartbeat error:', result.error.message);
            return res.status(503).json({
                success: false,
                error: 'heartbeat failed',
                code: 'PRESENCE_UPSERT_FAILED'
            });
        }

        return res.json({ success: true, data: { user_id: userId, last_seen: now } });
    } catch (err) {
        console.error('[ADMIN PRESENCE] heartbeat exception:', err.message);
        return res.status(500).json({
            success: false,
            error: 'heartbeat exception',
            code: 'PRESENCE_HEARTBEAT_EXCEPTION'
        });
    }
});

// ─── GET /online ───────────────────────────────────────────────
router.get('/online', requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ), async (req, res) => {
    try {
        const onlineThreshold = new Date(Date.now() - ONLINE_THRESHOLD_MS).toISOString();

        const { data, error } = await withSupabaseRetry(() =>
            supabaseAdmin
                .from('user_presence')
                .select(`
                    user_id, last_seen, current_page, current_action,
                    browser, os, device,
                    profiles!user_presence_user_id_fkey (id, username, email, avatar_url, role)
                `)
                .gte('last_seen', onlineThreshold)
                .order('last_seen', { ascending: false })
                .limit(200)
        );

        if (error) {
            console.error('[ADMIN PRESENCE] online query failed:', error.message);
            return res.status(503).json({
                success: false,
                error: 'presence query failed',
                code: 'PRESENCE_QUERY_FAILED'
            });
        }

        const rows = (data || []).map(p => {
            const prof = p.profiles || {};
            const { role, isAdmin } = classifyRole(prof.role);
            return {
                user_id: p.user_id,
                username: prof.username || prof.email?.split('@')[0] || 'Unknown',
                email: prof.email || '',
                avatar_url: prof.avatar_url || null,
                role,
                is_admin: isAdmin,
                last_seen: p.last_seen,
                last_seen_human: formatTimeAgo(p.last_seen),
                current_page: p.current_page || '/dashboard',
                current_action: p.current_action || 'viewing',
                browser: p.browser || null,
                os: p.os || null,
                device: p.device || null
            };
        });

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

        const todayStart = watDayStartIso();
        const todayResult = await withSupabaseRetry(() =>
            supabaseAdmin
                .from('user_presence')
                .select('user_id', { count: 'exact', head: true })
                .gte('last_seen', todayStart)
        );

        const activeTodayCount = todayResult.error ? null : (todayResult.count || 0);
        if (todayResult.error) {
            console.warn('[ADMIN PRESENCE] active-today query failed:', todayResult.error.message);
        }

        return res.json({
            success: true,
            data: {
                online_now: distinct.length,
                online_users: customers.length,
                online_admins: admins.length,
                active_today: activeTodayCount,
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
        return res.status(500).json({
            success: false,
            error: 'presence exception',
            code: 'PRESENCE_EXCEPTION'
        });
    }
});

// ─── GET /count ────────────────────────────────────────────────
router.get('/count', requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ), async (req, res) => {
    try {
        const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS).toISOString();
        const { count, error } = await withSupabaseRetry(() =>
            supabaseAdmin
                .from('user_presence')
                .select('user_id', { count: 'exact', head: true })
                .gte('last_seen', threshold)
        );

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

module.exports = router;