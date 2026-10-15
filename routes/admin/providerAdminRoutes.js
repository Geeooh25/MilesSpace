// routes/admin/presenceAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin presence — heartbeat + aggregated views.
//
// Server-load design:
//   • /heartbeat is the only write route.
//   • /count returns a number — cheap, no joins.
//   • /online returns COUNTS by default. The full user list is
//     opt-in via ?include=users, capped at 100 rows, and cached
//     in-process for 15 s so N dashboard tabs do not cause N
//     database scans.
//
// Security:
//   • requirePermission on every route.
//   • Role classification via middleware/roles.js.
//   • Identity from req.adminContext only.
//   • UTC everywhere.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();
const { supabaseAdmin, withSupabaseRetry } = require('../../db/supabase');
const { requirePermission, PERMISSIONS }   = require('../../middleware/adminAuth');
const { classifyRole }                     = require('../../middleware/roles');

const ONLINE_THRESHOLD_MS = 90 * 1000;
const LIST_LIMIT          = 100;
const LIST_CACHE_MS       = 15 * 1000;

// ─── UTC helpers ─────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }
function parseUtc(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    const s = String(v);
    const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
    return Date.parse(hasTz ? s : s + 'Z');
}
function formatTimeAgo(v) {
    const t = parseUtc(v);
    if (!Number.isFinite(t)) return 'Never';
    const s = Math.floor((Date.now() - t) / 1000);
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
    return t ? t.slice(0, maxLen) : null;
}
function clientIp(req) {
    return req.ip
        || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || (req.socket && req.socket.remoteAddress)
        || null;
}

// ─── Tiny in-process cache for the list view ─────────────────────
const listCache = { at: 0, value: null };
function cacheGet() {
    if (Date.now() - listCache.at < LIST_CACHE_MS) return listCache.value;
    return null;
}
function cacheSet(v) { listCache.at = Date.now(); listCache.value = v; }
function cacheClear() { listCache.at = 0; listCache.value = null; }

// ─── UA parsing (shared with customer route conceptually) ────────
function uaParse(ua) {
    const s = String(ua || '');
    const browser = /Edg/.test(s) ? 'Edge'
        : /OPR|Opera/.test(s) ? 'Opera'
        : /Firefox/.test(s) ? 'Firefox'
        : /Chrome/.test(s) ? 'Chrome'
        : /Safari/.test(s) ? 'Safari' : 'Unknown';
    const os = /Windows/.test(s) ? 'Windows'
        : /Mac OS X/.test(s) ? 'macOS'
        : /Android/.test(s) ? 'Android'
        : /iPhone|iPad|iPod/.test(s) ? 'iOS'
        : /Linux/.test(s) ? 'Linux' : 'Unknown';
    const device = /iPad|Tablet/.test(s) ? 'Tablet'
        : /Mobile|iPhone/.test(s) ? 'Mobile'
        : 'Desktop';
    const device_type = device.toLowerCase();
    return { browser, os, device, device_type };
}

// ═══════════════════════════════════════════════════════════════════
//  POST /heartbeat
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/heartbeat',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    async (req, res) => {
        try {
            const userId = req.adminContext.id;
            const now    = nowIso();
            const page   = safeString(req.body?.page, 128) || '/admin/dashboard';
            const tab_id = safeString(req.body?.tab_id, 64);
            const ua     = req.headers['user-agent'] || '';
            const { browser, os, device, device_type } = uaParse(ua);
            const { isAdmin } = classifyRole(req.adminContext.role);

            const result = await withSupabaseRetry(() =>
                supabaseAdmin.from('user_presence').upsert({
                    user_id:        userId,
                    last_seen:      now,
                    last_heartbeat: now,
                    current_page:   page,
                    current_action: 'viewing admin',
                    tab_id,
                    is_visible:     true,
                    is_online:      true,
                    is_admin:       isAdmin,
                    browser, os, device,
                    device_type,
                    ip_address:     clientIp(req),
                    updated_at:     now
                }, { onConflict: 'user_id' })
            );

            if (result.error) {
                console.error('[ADMIN PRESENCE] heartbeat error:', result.error.message);
                return res.status(503).json({
                    success: false, error: 'heartbeat failed', code: 'PRESENCE_UPSERT_FAILED'
                });
            }

            cacheClear();   // next read refreshes

            return res.json({ success: true, data: { user_id: userId, last_seen: now } });
        } catch (err) {
            console.error('[ADMIN PRESENCE] heartbeat exception:', err.message);
            return res.status(500).json({
                success: false, error: 'heartbeat exception', code: 'PRESENCE_HEARTBEAT_EXCEPTION'
            });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /count   — cheap, no joins, no cache
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/count',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    async (req, res) => {
        try {
            const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS).toISOString();
            const { count, error } = await withSupabaseRetry(() =>
                supabaseAdmin
                    .from('user_presence')
                    .select('user_id', { count: 'exact', head: true })
                    .gte('last_seen', threshold)
            );
            if (error) {
                console.error('[ADMIN PRESENCE] count error:', error.message);
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
            console.error('[ADMIN PRESENCE] count exception:', err.message);
            return res.status(500).json({ success: false, error: 'count exception', code: 'PRESENCE_COUNT_EXCEPTION' });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /online
//
//  Default: counts only. Optional ?include=users returns a capped,
//  cached list. The list joins profiles; the counts do not.
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/online',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    async (req, res) => {
        try {
            const includeUsers = String(req.query.include || '').toLowerCase() === 'users';
            const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS).toISOString();

            // Counts: separate lightweight queries, no joins.
            const [{ count: totalCount, error: totalErr }, { count: adminCount, error: adminErr }] =
                await Promise.all([
                    withSupabaseRetry(() =>
                        supabaseAdmin
                            .from('user_presence')
                            .select('user_id', { count: 'exact', head: true })
                            .gte('last_seen', threshold)
                    ),
                    withSupabaseRetry(() =>
                        supabaseAdmin
                            .from('user_presence')
                            .select('user_id', { count: 'exact', head: true })
                            .eq('is_admin', true)
                            .gte('last_seen', threshold)
                    )
                ]);

            if (totalErr || adminErr) {
                console.error('[ADMIN PRESENCE] online counts error:',
                    (totalErr || adminErr).message);
                return res.status(503).json({
                    success: false, error: 'presence count failed', code: 'PRESENCE_QUERY_FAILED'
                });
            }

            const total  = totalCount || 0;
            const admins = adminCount || 0;
            const users  = Math.max(0, total - admins);

            // Optional capped, cached list.
            let list = null;
            if (includeUsers) {
                list = cacheGet();
                if (!list) {
                    const { data, error } = await withSupabaseRetry(() =>
                        supabaseAdmin
                            .from('user_presence')
                            .select(`
                                user_id, last_seen, current_page, current_action,
                                browser, os, device,
                                profiles!user_presence_user_id_fkey
                                  (id, username, email, avatar_url, role)
                            `)
                            .gte('last_seen', threshold)
                            .order('last_seen', { ascending: false })
                            .limit(LIST_LIMIT)
                    );
                    if (error) {
                        console.error('[ADMIN PRESENCE] online list error:', error.message);
                        return res.status(503).json({
                            success: false, error: 'presence list failed', code: 'PRESENCE_QUERY_FAILED'
                        });
                    }
                    list = (data || []).map(p => {
                        const prof = p.profiles || {};
                        const { role, isAdmin } = classifyRole(prof.role);
                        return {
                            user_id: p.user_id,
                            username: prof.username || (prof.email || '').split('@')[0] || 'Unknown',
                            email: prof.email || '',
                            avatar_url: prof.avatar_url || null,
                            role, is_admin: isAdmin,
                            last_seen: p.last_seen,
                            last_seen_human: formatTimeAgo(p.last_seen),
                            current_page: p.current_page || '/dashboard',
                            current_action: p.current_action || 'viewing',
                            browser: p.browser || null,
                            os: p.os || null,
                            device: p.device || null
                        };
                    });
                    cacheSet(list);
                }
            }

            return res.json({
                success: true,
                data: {
                    online_now: total,
                    online_users: users,
                    online_admins: admins,
                    threshold_seconds: ONLINE_THRESHOLD_MS / 1000,
                    timestamp: nowIso(),
                    list_included: includeUsers,
                    list_limit: LIST_LIMIT,
                    list_cache_seconds: LIST_CACHE_MS / 1000,
                    users: includeUsers ? (list || []) : undefined
                }
            });
        } catch (err) {
            console.error('[ADMIN PRESENCE] online exception:', err.message);
            return res.status(500).json({
                success: false, error: 'presence exception', code: 'PRESENCE_EXCEPTION'
            });
        }
    }
);

module.exports = router;