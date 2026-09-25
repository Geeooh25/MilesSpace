// public/js/admin-presence.js
// ─────────────────────────────────────────────────────────────────
// Admin-only presence heartbeat.
//
//   - 30s heartbeat while tab is visible.
//   - Pauses on hidden tab; sends one immediately on return.
//   - No offline beacon. Server ages last_seen (90s threshold).
//   - Does NOT send is_admin — the server derives admin state from
//     the authenticated user's role.
//   - Does NOT send session_id in the body — the server already has
//     it in the JWT (req.user.session_id).
// ─────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    const pathname = window.location.pathname;
    if (!pathname.startsWith('/admin')) return;

    const LOGIN_PATHS = new Set([
        '/admin', '/admin/', '/admin/login', '/admin/login.html',
        '/admin/index', '/admin/index.html'
    ]);
    if (LOGIN_PATHS.has(pathname)) return;

    const HEARTBEAT_MS = 30000;

    let timer = null;
    let lastSentAt = 0;
    let isSending = false;
    let isActive = false;

    function readSession() {
        try {
            const raw = localStorage.getItem('admin_sess') || sessionStorage.getItem('admin_sess');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch { return null; }
    }

    function currentToken() {
        return readSession()?.token || null;
    }

    function isTokenShapeOk(token) {
        return typeof token === 'string' && token.split('.').length === 3;
    }

    async function sendHeartbeat() {
        if (!isActive || isSending) return;
        const token = currentToken();
        if (!isTokenShapeOk(token)) { stop(); return; }

        isSending = true;
        try {
            await fetch('/api/admin/presence/heartbeat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    page: window.location.pathname,
                    action: 'viewing admin'
                }),
                credentials: 'same-origin'
            });
            lastSentAt = Date.now();
        } catch {
            // Silent — next tick retries. Server ages last_seen.
        } finally {
            isSending = false;
        }
    }

    function start() {
        if (isActive) return;
        isActive = true;
        timer = setInterval(() => {
            if (document.hidden) return;
            if (Date.now() - lastSentAt < HEARTBEAT_MS * 0.5) return;
            sendHeartbeat();
        }, HEARTBEAT_MS);
    }

    function stop() {
        isActive = false;
        if (timer) { clearInterval(timer); timer = null; }
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && isActive) sendHeartbeat();
    });
    window.addEventListener('focus', () => {
        if (isActive) sendHeartbeat();
    });

    // Boot
    setTimeout(() => {
        if (isTokenShapeOk(currentToken())) {
            start();
            sendHeartbeat();
        }
    }, 400);

    console.log(`[admin-presence] heartbeat=${HEARTBEAT_MS}ms`);
})();