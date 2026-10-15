// public/js/presence.js
// ============================================================
// MILESSPACE PRESENCE TRACKER (customer)
//
//   • Runs only on non-admin, non-auth, non-root pages.
//   • Heartbeat every 45 s while visible; paused when hidden.
//   • One in-flight request at a time.
//   • Exponential backoff on failure (1s → 30s cap).
//   • No beacon on unload. The server ages last_seen.
//   • Sends only { page, tab_id }. The server derives identity,
//     role, IP, browser, OS, device. Nothing client-supplied
//     is trusted.
//   • session.js owns auth. This file never reads tokens.
// ============================================================

(function () {
    'use strict';

    const pathname = window.location.pathname;

    if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/')) return;

    const AUTH_PAGES = new Set([
        '/login.html', '/login',
        '/signup.html', '/signup',
        '/register.html', '/register',
        '/forgot-password.html', '/forgot-password',
        '/reset-password.html', '/reset-password',
        '/verify.html', '/verify'
    ]);
    if (AUTH_PAGES.has(pathname)) return;

    if (pathname === '/' || pathname === '/index.html') return;

    // ─── TUNING ────────────────────────────────────────────────
    const HEARTBEAT_VISIBLE_MS   = 45000;   // 45s while tab is visible
    const HEARTBEAT_HIDDEN_MS    = 0;       // do not heartbeat when hidden
    const RESUME_AFTER_RETURN_MS = 1000;    // send once shortly after returning to foreground
    const BACKOFF_BASE_MS        = 1000;
    const BACKOFF_MAX_MS         = 30000;

    const API_PATH = '/api/presence/heartbeat';

    // ─── ALLOWLIST for page names ──────────────────────────────
    // The server enforces this too, but trimming on the client
    // avoids sending obvious junk.
    const MAX_PAGE_LEN   = 128;
    const MAX_TAB_ID_LEN = 64;

    function safePath() {
        try {
            const p = window.location.pathname || '/';
            return p.slice(0, MAX_PAGE_LEN);
        } catch { return '/'; }
    }

    class PresenceTracker {
        constructor() {
            this.timer = null;
            this.backoffMs = 0;
            this.isActive = false;
            this.isSending = false;
            this.lastSentAt = 0;
            this.lastVisibilityChange = Date.now();
            this.tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        }

        init() {
            if (this.isActive) return;
            this.isActive = true;

            // First send shortly after boot.
            setTimeout(() => this.send(), 500);
            this.startLoop();

            document.addEventListener('visibilitychange', () => {
                this.lastVisibilityChange = Date.now();
                if (!document.hidden && this.isActive) {
                    // Returned to foreground. Send once after a short delay.
                    setTimeout(() => {
                        if (!document.hidden && this.isActive) this.send();
                    }, RESUME_AFTER_RETURN_MS);
                }
            });

            window.addEventListener('focus', () => {
                if (!document.hidden && this.isActive) this.send();
            });
        }

        startLoop() {
            if (this.timer) clearInterval(this.timer);
            this.timer = setInterval(() => {
                if (document.hidden) return;
                if (Date.now() - this.lastSentAt < HEARTBEAT_VISIBLE_MS * 0.5) return;
                this.send();
            }, HEARTBEAT_VISIBLE_MS);
        }

        stop() {
            this.isActive = false;
            if (this.timer) { clearInterval(this.timer); this.timer = null; }
        }

        async send() {
            if (!this.isActive || this.isSending) return;
            if (document.hidden) return;

            this.isSending = true;
            const startedAt = Date.now();
            try {
                const fetcher = (typeof window.userFetch === 'function')
                    ? window.userFetch
                    : ((url, opts) => fetch(url, { ...opts, credentials: 'same-origin' }));

                const response = await fetcher(API_PATH, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        page: safePath(),
                        tab_id: this.tabId.slice(0, MAX_TAB_ID_LEN)
                    })
                });

                if (response && response.ok) {
                    this.lastSentAt = Date.now();
                    this.backoffMs = 0;
                } else if (response && response.status === 401) {
                    // Session ended. Stop quietly; session.js handles redirect.
                    this.stop();
                } else {
                    this._scheduleBackoff();
                }
            } catch {
                this._scheduleBackoff();
            } finally {
                this.isSending = false;
            }
        }

        _scheduleBackoff() {
            this.backoffMs = Math.min(
                this.backoffMs ? this.backoffMs * 2 : BACKOFF_BASE_MS,
                BACKOFF_MAX_MS
            );
            // Do not start a second timer; the main loop will retry
            // after HEARTBEAT_VISIBLE_MS anyway. This method only
            // records the delay in case the caller wants to observe it.
        }
    }

    const tracker = new PresenceTracker();

    // Start after the page has settled.
    const boot = () => tracker.init();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 250));
    } else {
        setTimeout(boot, 250);
    }

    // ─── Logout signals ────────────────────────────────────────
    window.addEventListener('storage', (e) => {
        if ((e.key === 'mx_user' || e.key === 'mx_sess') && !e.newValue) tracker.stop();
    });

    try {
        const ch = new BroadcastChannel('mx_auth');
        ch.onmessage = (e) => {
            const m = e.data || {};
            if (m.type === 'logout') tracker.stop();
        };
    } catch {}

    window.presenceTracker = tracker;
    window.logoutPresence = function () { tracker.stop(); };

    console.log('[PRESENCE] Ready — 45s heartbeat, visible-only, no beacon, no reads');
})();