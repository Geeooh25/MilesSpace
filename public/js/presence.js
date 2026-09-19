// public/js/presence.js
// ============================================================
// MILESSPACE PRESENCE TRACKER
// Admin pages skipped. Defers ALL auth decisions to session.js.
// ============================================================

(function () {
    'use strict';

    // ─── PAGE DETECTION ────────────────────────────────────────
    const pathname = window.location.pathname;
    const IS_ADMIN_PAGE =
        pathname === '/admin' ||
        pathname === '/admin/' ||
        pathname.startsWith('/admin/');

    if (IS_ADMIN_PAGE) {
        console.log('[PRESENCE] Admin page — skipped');
        return;
    }

    // NOTE: The old window.fetch monkey-patch has been REMOVED.
    // Presence does not make auth decisions. session.js is the sole authority.

    const AUTH_PAGES = new Set([
        '/login.html', '/login',
        '/signup.html', '/signup',
        '/register.html', '/register',
        '/forgot-password.html', '/forgot-password',
        '/reset-password.html', '/reset-password',
        '/verify.html', '/verify'
    ]);

    const IS_AUTH_PAGE = AUTH_PAGES.has(pathname);
    const IS_ROOT_PAGE = pathname === '/' || pathname === '/index.html';

    // ─── PRESENCE TRACKER ──────────────────────────────────────

    class PresenceTracker {
        constructor() {
            this.userId = null;
            this.token = null;
            this.heartbeatInterval = null;
            this.isActive = false;
            this.lastPage = window.location.pathname;
            this.apiBase = '/api/presence';
            this.tabId = this.generateTabId();
            this.offlineSent = false;
            this.isPaused = false;
            this.isNetworkOffline = false;
            this.heartbeatCount = 0;
            this.failedAttempts = 0;
            this.maxFailedAttempts = 3;
            this.baseHeartbeatMs = 30000;   // 30s instead of 5s
            this.currentBackoffMs = 30000;
            this.maxBackoffMs = 5 * 60 * 1000; // cap at 5 min
        }

        generateTabId() {
            return 'tab_' + Date.now() + '_' +
                Math.random().toString(36).slice(2, 8);
        }

        // ─── SESSION LOOKUP ────────────────────────────────────

        getActiveSession() {
            if (typeof window.getUserSession === 'function') {
                return window.getUserSession();
            }
            try {
                const raw =
                    localStorage.getItem('mx_sess') ||
                    sessionStorage.getItem('mx_sess');
                return raw ? JSON.parse(raw) : null;
            } catch {
                return null;
            }
        }

        getToken() {
            if (typeof window.getUserToken === 'function') {
                return window.getUserToken();
            }
            return this.getActiveSession()?.token || '';
        }

        getUserId() {
            if (typeof window.getUser === 'function') {
                return window.getUser()?.id || null;
            }
            const s = this.getActiveSession();
            return s?.user?.id || null;
        }

        // ─── INIT ──────────────────────────────────────────────

        init() {
            if (IS_AUTH_PAGE || IS_ROOT_PAGE) {
                console.log('[PRESENCE] Auth/root page — skipped');
                return;
            }

            if (this.isActive && this.userId) return;

            const maxAttempts = 5;
            let attempts = 0;

            const tryInit = () => {
                attempts++;
                const token = this.getToken();
                const userId = this.getUserId();

                if (!token || !userId) {
                    if (attempts < maxAttempts) {
                        setTimeout(tryInit, 300);
                        return;
                    }
                    console.warn('[PRESENCE] No user session found');
                    return;
                }

                this.userId = userId;
                this.token = token;
                console.log('[PRESENCE] Session found:', userId);

                this.startTracking();
                this.setupLogoutDetection();
                this.setupPageChangeDetection();
            };

            tryInit();
        }

        // ─── START TRACKING ────────────────────────────────────

        startTracking() {
            if (!this.userId || !this.token) return;

            console.log('[PRESENCE] Tracking started (30s heartbeat)');
            this.isActive = true;
            this.offlineSent = false;
            this.isPaused = false;
            this.isNetworkOffline = false;
            this.heartbeatCount = 0;
            this.failedAttempts = 0;
            this.currentBackoffMs = this.baseHeartbeatMs;

            setTimeout(() => this.sendPresence(), 200);
            this.scheduleNext();

            window.addEventListener('pagehide', () => this.sendOffline());
            window.addEventListener('beforeunload', () => this.sendOffline());
        }

        // ─── LOGOUT DETECTION ──────────────────────────────────

        setupLogoutDetection() {
            const handler = (e) => {
                if (e.key === 'mx_sess' && !e.newValue) {
                    console.log('[PRESENCE] Session cleared in another tab');
                    this.sendOffline();
                    this.stop();
                }
            };
            window.addEventListener('storage', handler);
            this._storageHandler = handler;
        }

        // ─── PAGE CHANGE ───────────────────────────────────────

        setupPageChangeDetection() {
            const origPush = history.pushState;
            const origReplace = history.replaceState;

            history.pushState = (...args) => {
                origPush.apply(this, args);
                this.onLocationChange();
            };
            history.replaceState = (...args) => {
                origReplace.apply(this, args);
                this.onLocationChange();
            };

            window.addEventListener('popstate', () => this.onLocationChange());
        }

        onLocationChange() {
            const current = window.location.pathname;
            if (current !== this.lastPage) {
                this.lastPage = current;
                if (!this.offlineSent && this.isActive) {
                    this.sendPresence();
                }
            }
        }

        // ─── SEND HEARTBEAT ────────────────────────────────────

        async sendPresence(extra = {}) {
            if (this.isPaused || !this.isActive || this.offlineSent) return;
            if (this.isNetworkOffline) return;

            const token = this.getToken();
            const userId = this.getUserId();

            if (!token || !userId) {
                this.stop();
                return;
            }

            const page = window.location.pathname;
            const payload = {
                page,
                action: this.getPageAction(page),
                tabId: this.tabId,
                ...extra
            };

            this.heartbeatCount++;

            try {
                const res = await fetch(`${this.apiBase}/heartbeat`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                    },
                    body: JSON.stringify(payload)
                });

                // ─── 429: rate limited → back off hard ────────
                if (res.status === 429) {
                    this.failedAttempts++;
                    this.currentBackoffMs = Math.min(
                        this.currentBackoffMs * 2,
                        this.maxBackoffMs
                    );
                    console.warn(
                        `[PRESENCE] 429 — backing off to ${this.currentBackoffMs / 1000}s`
                    );
                    return;
                }

                // ─── 503: service unavailable → back off gently
                if (res.status === 503) {
                    this.failedAttempts++;
                    this.currentBackoffMs = Math.min(
                        this.currentBackoffMs * 1.5,
                        this.maxBackoffMs
                    );
                    console.warn('[PRESENCE] 503 — service unavailable');
                    return;
                }

                // ─── 401: stop presence, let session.js decide auth
                if (res.status === 401) {
                    console.warn('[PRESENCE] 401 — stopping presence, deferring to session.js');
                    this.stop();
                    return;
                }

                // ─── Success ───────────────────────────────────
                if (res.ok) {
                    this.failedAttempts = 0;
                    this.currentBackoffMs = this.baseHeartbeatMs;
                    if (this.heartbeatCount % 10 === 0) {
                        console.log(`[PRESENCE] Heartbeat #${this.heartbeatCount} ok`);
                    }
                }
            } catch (err) {
                // Network failure — keep session, back off
                this.failedAttempts++;
                this.currentBackoffMs = Math.min(
                    this.currentBackoffMs * 1.5,
                    this.maxBackoffMs
                );
                console.warn('[PRESENCE] Network error — will retry');
            }
        }

        // ─── SEND OFFLINE ──────────────────────────────────────

        sendOffline() {
            if (this.offlineSent || !this.userId) return;
            this.offlineSent = true;

            const token = this.getToken();
            if (!token) return;

            try {
                fetch(`${this.apiBase}/offline`, {
                    method: 'POST',
                    keepalive: true,
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                    },
                    body: JSON.stringify({ tabId: this.tabId })
                }).catch(() => {});
            } catch (e) {
                try {
                    const blob = new Blob(
                        [JSON.stringify({ tabId: this.tabId })],
                        { type: 'application/json' }
                    );
                    navigator.sendBeacon(
                        `${this.apiBase}/offline-beacon`,
                        blob
                    );
                } catch (e2) {}
            }
        }

        // ─── SCHEDULE LOOP (self-correcting, respects backoff) ─

        scheduleNext() {
            if (this.heartbeatInterval) clearTimeout(this.heartbeatInterval);

            this.heartbeatInterval = setTimeout(async () => {
                if (!this.offlineSent && !this.isPaused) {
                    await this.sendPresence();
                }
                // Re-schedule with current (possibly backed-off) delay
                if (this.isActive) this.scheduleNext();
            }, this.currentBackoffMs);
        }

        // ─── OFFLINE INTEGRATION (called by session.js) ────────

        pauseForOffline() {
            this.isNetworkOffline = true;
            console.log('[PRESENCE] Paused (offline)');
        }

        resumeFromOffline() {
            this.isNetworkOffline = false;
            this.failedAttempts = 0;
            this.currentBackoffMs = this.baseHeartbeatMs;
            console.log('[PRESENCE] Resumed (online)');
            if (this.isActive) this.sendPresence();
        }

        // ─── PAGE ACTION ───────────────────────────────────────

        getPageAction(page) {
            const actions = {
                '/dashboard': 'viewing dashboard',
                '/wallet': 'managing wallet',
                '/fund': 'funding wallet',
                '/market': 'browsing marketplace',
                '/boost': 'browsing boosts',
                '/giftcards': 'browsing gift cards',
                '/gifts': 'browsing gifts',
                '/virtual': 'buying virtual number',
                '/history': 'viewing history',
                '/profile': 'viewing profile',
                '/usersettings': 'viewing settings',
                '/bills': 'paying bills',
                '/esim': 'buying esim',
                '/airtime': 'buying airtime'
            };
            for (const [path, action] of Object.entries(actions)) {
                if (page === path || page.startsWith(path + '/')) return action;
            }
            return 'viewing page';
        }

        // ─── STOP / RESTART ────────────────────────────────────

        stop() {
            this.isActive = false;
            if (this.heartbeatInterval) {
                clearTimeout(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            console.log('[PRESENCE] Stopped');
        }

        restart() {
            this.stop();
            this.offlineSent = false;
            this.isPaused = false;
            this.isNetworkOffline = false;
            this.failedAttempts = 0;
            this.currentBackoffMs = this.baseHeartbeatMs;
            setTimeout(() => this.init(), 100);
        }
    }

    // ─── GLOBAL HOOKS ─────────────────────────────────────────

    window.logoutPresence = function () {
        if (window.presenceTracker) {
            window.presenceTracker.sendOffline();
            window.presenceTracker.stop();
            delete window.presenceTracker;
        }
    };

    // ─── BOOT ──────────────────────────────────────────────────

    function boot() {
        if (!window.presenceTracker) {
            const t = new PresenceTracker();
            t.init();
            window.presenceTracker = t;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 100));
    } else {
        setTimeout(boot, 100);
    }

    window.addEventListener('pagehide', () => {
        window.presenceTracker?.sendOffline();
    });

    window.addEventListener('pageshow', (e) => {
        if (e.persisted && window.presenceTracker) {
            window.presenceTracker.offlineSent = false;
            window.presenceTracker.failedAttempts = 0;
            window.presenceTracker.currentBackoffMs =
                window.presenceTracker.baseHeartbeatMs;
            setTimeout(() => window.presenceTracker.sendPresence(), 500);
            window.presenceTracker.scheduleNext();
        }
    });

    console.log('[PRESENCE] Loaded (30s heartbeat, no fetch monkey-patch)');
})();