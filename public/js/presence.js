// public/js/presence.js
// ============================================================
// MILESSPACE PRESENCE TRACKER (customer)
//
//   - Runs only on non-admin, non-auth pages.
//   - Heartbeat every 30s while the tab is visible.
//   - Pauses on hidden tab; sends one immediately on return.
//   - No offline beacon. The server decides offline from
//     last_seen aging (90s threshold).
//   - session.js owns auth. This file never makes auth decisions.
// ============================================================

(function () {
    'use strict';

    const pathname = window.location.pathname;

    if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/')) {
        return; // admin has its own presence script
    }

    const AUTH_PAGES = new Set([
        '/login.html', '/login',
        '/signup.html', '/signup',
        '/register.html', '/register',
        '/forgot-password.html', '/forgot-password',
        '/reset-password.html', '/reset-password',
        '/verify.html', '/verify'
    ]);
    if (AUTH_PAGES.has(pathname)) return;

    const IS_ROOT = pathname === '/' || pathname === '/index.html';
    if (IS_ROOT) return;

    const HEARTBEAT_MS = 30000;
    const API_BASE = '/api/presence';

    class PresenceTracker {
        constructor() {
            this.timer = null;
            this.lastSentAt = 0;
            this.isActive = false;
            this.isSending = false;
            this.tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        }

        getSession() {
            try {
                const raw = localStorage.getItem('mx_sess') || sessionStorage.getItem('mx_sess');
                return raw ? JSON.parse(raw) : null;
            } catch { return null; }
        }

        getToken() {
            if (typeof window.getUserToken === 'function') {
                try { return window.getUserToken(); } catch { /* fall through */ }
            }
            return this.getSession()?.token || null;
        }

        getUserId() {
            if (typeof window.getUser === 'function') {
                try { return window.getUser()?.id || null; } catch { /* fall through */ }
            }
            return this.getSession()?.user?.id || null;
        }

        isTokenShapeOk(token) {
            return typeof token === 'string' && token.split('.').length === 3;
        }

        init() {
            if (this.isActive) return;
            let attempts = 0;
            const max = 5;

            const tryInit = () => {
                attempts++;
                const token = this.getToken();
                const userId = this.getUserId();
                if (!token || !userId || !this.isTokenShapeOk(token)) {
                    if (attempts < max) return setTimeout(tryInit, 300);
                    return;
                }
                this.isActive = true;
                setTimeout(() => this.send(), 200);
                this.startLoop();
            };
            tryInit();
        }

        startLoop() {
            if (this.timer) clearInterval(this.timer);
            this.timer = setInterval(() => {
                if (document.hidden) return;
                // Skip if a focus event just sent one.
                if (Date.now() - this.lastSentAt < HEARTBEAT_MS * 0.5) return;
                this.send();
            }, HEARTBEAT_MS);
        }

        stop() {
            this.isActive = false;
            if (this.timer) { clearInterval(this.timer); this.timer = null; }
        }

        async send() {
            if (!this.isActive || this.isSending) return;
            const token = this.getToken();
            const userId = this.getUserId();
            if (!token || !userId) { this.stop(); return; }

            this.isSending = true;
            try {
                await fetch(`${API_BASE}/heartbeat`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        page: window.location.pathname,
                        tab_id: this.tabId
                    }),
                    credentials: 'same-origin'
                });
                this.lastSentAt = Date.now();
            } catch {
                // Silent — next tick retries. Server ages last_seen.
            } finally {
                this.isSending = false;
            }
        }
    }

    const tracker = new PresenceTracker();

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && tracker.isActive) tracker.send();
    });
    window.addEventListener('focus', () => {
        if (tracker.isActive) tracker.send();
    });

    // Boot when session is likely ready.
    const boot = () => tracker.init();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 100));
    } else {
        setTimeout(boot, 100);
    }

    // If session.js clears the session, we stop. It does not restart
    // unless the page reloads.
    window.addEventListener('storage', (e) => {
        if (e.key === 'mx_sess' && !e.newValue) tracker.stop();
    });

    window.presenceTracker = tracker;
    window.logoutPresence = function () { tracker.stop(); };

    console.log('[PRESENCE] Loaded (30s heartbeat, single write, no beacon)');
})();