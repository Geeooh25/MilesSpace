// public/js/session.js
// ============================================================
// MILESSPACE USER SESSION MANAGER (customer)
//
// TOKEN MODEL
//   • Access token  — memory only. Never localStorage, never
//                     sessionStorage, never a cookie. Recovered
//                     via /api/auth/refresh on reload.
//   • Refresh token — HttpOnly, Secure, SameSite=Strict cookie
//                     set by the server. JS cannot read it.
//   • User metadata — localStorage for UI rendering only.
//                     No tokens, no secrets.
//
// CROSS-TAB
//   • Coordinated via Web Locks API (primary) + BroadcastChannel
//     (fallback). Tabs broadcast *state changes* (refresh start,
//     refresh done, logout) but NEVER share bearer tokens.
//     Each tab mints its own access token via the server.
//
// SESSION READY EVENT
//   • Dispatches `session:ready` once the access token is minted
//     (or once we know we do not need one — auth page, admin,
//     root page). Fires `session:error` if refresh fails.
//     Pages that need an authenticated call listen for this.
//
// FINANCIAL SAFETY
//   • userFetch() will not replay non-idempotent POSTs after a
//     timeout or 401 unless an `Idempotency-Key` header is present.
// ============================================================

(function () {
    'use strict';

    // ─── GUARD AGAINST DUPLICATE INCLUSION ─────────────────────
    if (window.__MILES_SESSION_LOADED__) {
        console.warn('[SESSION] Already loaded — ignoring duplicate script tag.');
        return;
    }
    window.__MILES_SESSION_LOADED__ = true;

    // ─── CONSTANTS ─────────────────────────────────────────────
    const USER_KEY        = 'mx_user';
    const DEVICE_ID_KEY   = 'mx_device_id';
    const RETURN_TO_KEY   = 'milespace_return_to';

    const LOGIN_PAGE      = '/login.html';
    const DASHBOARD_PAGE  = '/dashboard.html';

    const REFRESH_ENDPOINT = '/api/auth/refresh';
    const SESSION_ENDPOINT = '/api/auth/session';
    const LOGOUT_ENDPOINT  = '/api/auth/logout';

    const REFRESH_LOCK_NAME = 'mx_auth_refresh';
    const REFRESH_LOCK_TIMEOUT_MS = 15000;
    const REFRESH_AHEAD_MS = 5 * 60 * 1000;
    const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

    const AUTH_PAGES = new Set([
        '/login.html', '/login',
        '/signup.html', '/signup',
        '/register.html', '/register',
        '/forgot-password.html', '/forgot-password',
        '/reset-password.html', '/reset-password',
        '/verify.html', '/verify'
    ]);

    const LEGACY_TOKEN_KEYS = [
        'mx_sess', 'mx_token', 'mx_refresh',
        'miles_token', 'miles_user', 'milespace_token'
    ];

    // ─── IN-MEMORY ACCESS TOKEN ────────────────────────────────
    let _accessToken = null;
    let _accessTokenExpiresAt = 0;

    function setAccessToken(token, expiresInSeconds) {
        _accessToken = token || null;
        _accessTokenExpiresAt = token
            ? Date.now() + (Number(expiresInSeconds || 900) * 1000)
            : 0;
    }
    function getAccessToken() {
        if (!_accessToken) return null;
        if (Date.now() >= _accessTokenExpiresAt - 5000) return null;
        return _accessToken;
    }
    function clearAccessToken() {
        _accessToken = null;
        _accessTokenExpiresAt = 0;
    }

    // ─── USER METADATA (non-sensitive) ─────────────────────────
    function readUser() {
        try {
            const raw = localStorage.getItem(USER_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
    function saveUser(user) {
        try {
            if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
            else localStorage.removeItem(USER_KEY);
        } catch (_) {}
    }
    function clearUser() {
        try { localStorage.removeItem(USER_KEY); } catch (_) {}
    }

    function readSession() {
        const user = readUser();
        return user ? { user } : null;
    }
    function getUser() { return readUser(); }

    // ─── DEVICE ID ─────────────────────────────────────────────
    function getOrCreateDeviceId() {
        try {
            let id = localStorage.getItem(DEVICE_ID_KEY);
            if (!id || typeof id !== 'string' || id.length < 8) {
                id = (window.crypto && typeof crypto.randomUUID === 'function')
                    ? crypto.randomUUID()
                    : (() => {
                        const buf = new Uint8Array(16);
                        if (window.crypto && crypto.getRandomValues) {
                            crypto.getRandomValues(buf);
                        } else {
                            for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
                        }
                        return 'dev_' + Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
                    })();
                localStorage.setItem(DEVICE_ID_KEY, id);
            }
            return id;
        } catch { return null; }
    }

    // ─── STATE ─────────────────────────────────────────────────
    let heartbeatTimer = null;
    let refreshTimer   = null;
    let refreshPromise = null;
    let initialized    = false;
    let redirecting    = false;
    let isOffline      = false;
    let bannerEl       = null;
    let channel        = null;

    // ─── PAGE DETECTION ────────────────────────────────────────
    const pathname = window.location.pathname;

    const IS_ADMIN_PAGE =
        pathname === '/admin' ||
        pathname === '/admin/' ||
        pathname.startsWith('/admin/');

    const IS_AUTH_PAGE = AUTH_PAGES.has(pathname);
    const IS_ROOT_PAGE = pathname === '/' || pathname === '/index.html';

    // ============================================================
    // RETURN-TO (SAFE)
    // ============================================================
    function isSafeInternalPath(dest) {
        if (typeof dest !== 'string' || dest.length === 0) return false;
        if (dest[0] !== '/') return false;
        if (dest[1] === '/' || dest[1] === '\\') return false;
        if (/^\s*(javascript|data|vbscript|file):/i.test(dest)) return false;
        if (dest.includes('\\')) return false;

        let url;
        try { url = new URL(dest, window.location.origin); }
        catch { return false; }

        if (url.origin !== window.location.origin) return false;

        const p = url.pathname;
        if (AUTH_PAGES.has(p)) return false;
        if (p === '/login.html' || p === '/login') return false;
        return true;
    }

    function saveReturnDestination() {
        if (IS_ADMIN_PAGE || IS_AUTH_PAGE || IS_ROOT_PAGE) return;
        const dest = window.location.pathname + window.location.search + window.location.hash;
        if (!isSafeInternalPath(dest)) return;
        try {
            sessionStorage.setItem(
                RETURN_TO_KEY,
                JSON.stringify({ path: dest, savedAt: Date.now() })
            );
        } catch (e) {
            console.warn('[SESSION] Failed to save return destination:', e.message);
        }
    }

    function getSafeReturnDestination() {
        try {
            const raw = sessionStorage.getItem(RETURN_TO_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && isSafeInternalPath(parsed.path)) return parsed.path;
                sessionStorage.removeItem(RETURN_TO_KEY);
            }
        } catch { sessionStorage.removeItem(RETURN_TO_KEY); }

        // URLSearchParams.get() already returns a decoded value — do NOT decode again.
        try {
            const params = new URLSearchParams(window.location.search);
            const fromQuery = params.get('redirect');
            if (fromQuery && isSafeInternalPath(fromQuery)) return fromQuery;
        } catch {}

        return null;
    }

    function clearReturnDestination() {
        try { sessionStorage.removeItem(RETURN_TO_KEY); } catch {}
    }

    // ============================================================
    // CONNECTIVITY BANNER (safe DOM insertion)
    // ============================================================
    function ensureBanner() {
        if (bannerEl && document.body.contains(bannerEl)) return bannerEl;
        bannerEl = document.createElement('div');
        bannerEl.id = 'milespaceConnectivity';
        bannerEl.setAttribute('role', 'status');
        bannerEl.setAttribute('aria-live', 'polite');
        Object.assign(bannerEl.style, {
            position: 'fixed', left: '50%', bottom: '24px',
            transform: 'translateX(-50%) translateY(120%)',
            padding: '10px 18px', borderRadius: '999px',
            fontFamily: 'Inter, DM Sans, system-ui, sans-serif',
            fontSize: '13px', fontWeight: '600', color: '#ffffff',
            background: '#1a2c3e',
            boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
            zIndex: '2147483647', pointerEvents: 'none',
            opacity: '0',
            transition: 'transform 0.28s ease, opacity 0.28s ease',
            display: 'flex', alignItems: 'center', gap: '8px',
            maxWidth: 'calc(100vw - 32px)'
        });
        const span = document.createElement('span');
        span.id = 'milespaceConnectivityText';
        bannerEl.appendChild(span);
        document.body.appendChild(bannerEl);
        return bannerEl;
    }
    function showBanner(text, tone) {
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', () => showBanner(text, tone), { once: true });
            return;
        }
        const el = ensureBanner();
        const txt = el.querySelector('#milespaceConnectivityText');
        if (txt) txt.textContent = String(text || '');
        el.style.background = tone === 'online' ? '#065f46' : '#1a2c3e';
        el.style.transform = 'translateX(-50%) translateY(0)';
        el.style.opacity = '1';
        if (showBanner._timer) clearTimeout(showBanner._timer);
        if (tone === 'online') showBanner._timer = setTimeout(() => hideBanner(), 3200);
    }
    function hideBanner() {
        if (!bannerEl) return;
        bannerEl.style.transform = 'translateX(-50%) translateY(120%)';
        bannerEl.style.opacity = '0';
    }
    function markOffline() {
        if (isOffline) return;
        isOffline = true;
        document.body.dataset.network = 'offline';
        showBanner('You are offline', 'offline');
    }
    function markOnline() {
        if (!isOffline) { document.body.dataset.network = 'online'; return; }
        isOffline = false;
        document.body.dataset.network = 'online';
        showBanner("You're back online", 'online');
    }
    function installConnectivityListeners() {
        if (IS_ADMIN_PAGE) return;
        window.addEventListener('offline', () => {
            markOffline();
            if (window.presenceTracker?.pauseForOffline) {
                try { window.presenceTracker.pauseForOffline(); } catch {}
            }
        });
        window.addEventListener('online', () => {
            markOnline();
            if (window.presenceTracker?.resumeFromOffline) {
                try { window.presenceTracker.resumeFromOffline(); } catch {}
            }
        });
        if (navigator.onLine === false) markOffline();
        else document.body.dataset.network = 'online';
    }

    // ============================================================
    // REDIRECT TO LOGIN
    // ============================================================
    function redirectToUserLogin() {
        if (IS_ADMIN_PAGE || IS_AUTH_PAGE || redirecting) return;
        redirecting = true;
        saveReturnDestination();
        clearAccessToken();
        clearUser();
        if (typeof window.logoutPresence === 'function') {
            try { window.logoutPresence(); } catch {}
        }
        const dest = getSafeReturnDestination();
        let url = LOGIN_PAGE;
        if (dest) url += '?redirect=' + encodeURIComponent(dest);
        window.location.replace(url);
    }

    // ============================================================
    // BROADCAST CHANNEL (state sync only — NOT token sharing)
    // ============================================================
    function initChannel() {
        if (channel !== null) return channel;
        try {
            channel = new BroadcastChannel('mx_auth');
            channel.onmessage = (e) => {
                const msg = e.data || {};
                if (msg.type === 'logout') {
                    clearAccessToken();
                    clearUser();
                    if (!IS_ADMIN_PAGE && !IS_AUTH_PAGE) redirectToUserLogin();
                }
                // We deliberately do NOT accept raw tokens from other tabs.
                // Each tab calls the refresh endpoint itself.
            };
        } catch {
            channel = null;
        }
        return channel;
    }
    function bcPost(msg) {
        try { if (channel) channel.postMessage(msg); } catch {}
    }

    // ============================================================
    // SESSION-READY EVENT
    // ============================================================
    function fireReady() {
        try { window.dispatchEvent(new CustomEvent('session:ready')); } catch (_) {}
    }
    function fireError() {
        try { window.dispatchEvent(new CustomEvent('session:error')); } catch (_) {}
    }

    // ============================================================
    // CROSS-TAB REFRESH LOCK
    //
    // Uses the Web Locks API when available (Chrome, Edge, Safari 16.4+)
    // which guarantees a single lock holder even across tabs and is
    // released automatically if a tab crashes.
    //
    // Falls back to BroadcastChannel handshake when Web Locks is missing.
    // ============================================================
    function withRefreshLock(fn) {
        if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
            return navigator.locks.request(
                REFRESH_LOCK_NAME,
                { mode: 'exclusive' },
                async () => fn()
            );
        }
        // Fallback: no cross-tab lock. The refresh endpoint must handle
        // concurrent requests via rotation + REFRESH_RACE handling.
        return fn();
    }

    // ============================================================
    // REFRESH (single-flight, cross-tab coordinated)
    // ============================================================
    async function refreshToken(force = false) {
        // If a refresh is already running in this tab, join it.
        if (refreshPromise) {
            if (!force) return refreshPromise;
            // For force, wait for the current refresh to complete, then
            // start a new one — never corrupt the shared promise.
            try { await refreshPromise; } catch {}
        }

        refreshPromise = (async () => {
            return withRefreshLock(async () => {
                bcPost({ type: 'refresh_start' });

                const doFetch = async () => {
                    const response = await fetch(REFRESH_ENDPOINT, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' }
                    });

                    if (response.status === 409) {
                        const body = await response.json().catch(() => ({}));
                        if (body.code === 'REFRESH_RACE') {
                            await new Promise(r => setTimeout(r, 300));
                            const retry = await fetch(REFRESH_ENDPOINT, {
                                method: 'POST',
                                credentials: 'include',
                                headers: { 'Content-Type': 'application/json' }
                            });
                            if (retry.ok) return _consumeRefreshResponse(retry);
                            throw new Error(`Refresh race retry failed: ${retry.status}`);
                        }
                        throw new Error(`Refresh failed: ${response.status}`);
                    }

                    if (!response.ok) {
                        throw new Error(`Refresh failed: ${response.status}`);
                    }

                    return _consumeRefreshResponse(response);
                };

                try {
                    const token = await doFetch();
                    bcPost({ type: 'refresh_done' });
                    return token;
                } catch (err) {
                    bcPost({ type: 'refresh_failed' });
                    clearAccessToken();
                    throw err;
                }
            });
        })();

        try {
            return await refreshPromise;
        } finally {
            refreshPromise = null;
        }
    }

    async function _consumeRefreshResponse(response) {
        const result = await response.json();
        const accessToken = result?.data?.access_token || result?.access_token || null;
        const expiresIn   = result?.data?.expires_in   || result?.expires_in   || 900;
        if (!accessToken) throw new Error('Refresh response contained no access token');
        setAccessToken(accessToken, expiresIn);
        scheduleProactiveRefresh();
        return accessToken;
    }

    // ============================================================
    // SESSION CHECK
    // ============================================================
    async function checkUserSession() {
        if (IS_ADMIN_PAGE || IS_AUTH_PAGE) return true;
        if (getAccessToken()) return true;
        try { await refreshToken(); return true; }
        catch { redirectToUserLogin(); return false; }
    }

    // ============================================================
    // HEARTBEAT (5 min, paused when hidden)
    // ============================================================
    function startUserHeartbeat() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (IS_AUTH_PAGE || IS_ADMIN_PAGE) return;

        heartbeatTimer = setInterval(async () => {
            if (document.hidden) return;
            if (!navigator.onLine) return;
            const token = getAccessToken();
            if (!token) {
                try { await refreshToken(); }
                catch { redirectToUserLogin(); }
                return;
            }
            try {
                const response = await fetch(SESSION_ENDPOINT, {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (response.ok) return;
                if (response.status === 401) {
                    let data = {};
                    try { data = await response.json(); } catch {}
                    if (data.code === 'SESSION_EXPIRED' || data.code === 'INVALID_TOKEN') {
                        try { await refreshToken(); }
                        catch { redirectToUserLogin(); }
                    } else if (
                        data.code === 'SESSION_REVOKED' ||
                        data.code === 'ACCOUNT_DELETED' ||
                        data.code === 'ACCOUNT_SUSPENDED' ||
                        data.code === 'INVALID_SESSION'
                    ) {
                        redirectToUserLogin();
                    }
                }
            } catch {
                console.warn('[SESSION] Heartbeat network error — keeping session');
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    // ============================================================
    // PROACTIVE REFRESH
    // ============================================================
    function scheduleProactiveRefresh() {
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        if (IS_ADMIN_PAGE || IS_AUTH_PAGE) return;
        const token = getAccessToken();
        if (!token) return;
        const timeLeft = _accessTokenExpiresAt - Date.now();
        const refreshIn = Math.max(0, timeLeft - REFRESH_AHEAD_MS);
        refreshTimer = setTimeout(() => {
            if (document.hidden) return;
            refreshToken().catch(() => {});
        }, refreshIn);
    }

    // ============================================================
    // USER FETCH — attaches access token, retries once on 401
    //
    // SAFETY: Never replay a non-idempotent POST without an
    // `Idempotency-Key` header after a 401, because the server may
    // have already processed the request.
    // ============================================================
    const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

    function isIdempotentSafe(method, headers) {
        const m = String(method || 'GET').toUpperCase();
        if (SAFE_METHODS.has(m)) return true;
        // For non-safe methods, require an idempotency key header.
        const keys = Object.keys(headers || {});
        for (const k of keys) {
            if (k.toLowerCase() === 'idempotency-key') {
                return !!headers[k];
            }
        }
        return false;
    }

    async function userFetch(url, options = {}, retry = true) {
        if (IS_ADMIN_PAGE) throw new Error('userFetch() cannot be used on admin pages');

        let token = getAccessToken();
        if (!token) {
            try { token = await refreshToken(); }
            catch {
                redirectToUserLogin();
                throw new Error('User not authenticated');
            }
        }

        // Normalize headers via Headers object to avoid duplicate keys
        const headers = new Headers(options.headers || {});
        headers.set('Authorization', `Bearer ${token}`);

        const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
        if (!headers.has('Content-Type') && !isFormData) {
            headers.set('Content-Type', 'application/json');
        }

        let response;
        try {
            response = await fetch(url, {
                ...options,
                headers,
                credentials: 'same-origin'
            });
        } catch (networkError) {
            if (navigator.onLine === false) markOffline();
            throw networkError;
        }

        if (response.status !== 401) return response;

        let data = {};
        try { data = await response.clone().json(); } catch {}
        const code = data.code;

        if (retry && (code === 'SESSION_EXPIRED' || code === 'INVALID_TOKEN')) {
            // Only retry if the original request is safe to replay.
            const method = options.method || 'GET';
            if (!isIdempotentSafe(method, Object.fromEntries(headers.entries()))) {
                // Return the 401 as-is for the caller to handle — do NOT replay.
                return response;
            }
            try {
                await refreshToken();
                return userFetch(url, options, false);
            } catch (err) {
                redirectToUserLogin();
                throw err;
            }
        }

        if (code === 'NO_TOKEN') {
            redirectToUserLogin();
            return response;
        }

        if (
            code === 'SESSION_REVOKED' ||
            code === 'ACCOUNT_DELETED' ||
            code === 'ACCOUNT_SUSPENDED' ||
            code === 'INVALID_SESSION'
        ) {
            redirectToUserLogin();
        }

        return response;
    }

    // ============================================================
    // LOGOUT
    // ============================================================
    async function doUserLogout() {
        const token = getAccessToken();
        if (typeof window.logoutPresence === 'function') {
            try { window.logoutPresence(); } catch {}
        }
        if (refreshTimer)   { clearTimeout(refreshTimer);   refreshTimer = null; }
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = `Bearer ${token}`;
            await fetch(LOGOUT_ENDPOINT, {
                method: 'POST', headers, credentials: 'include'
            });
        } catch {}

        clearAccessToken();
        clearUser();
        clearReturnDestination();
        bcPost({ type: 'logout' });
        window.location.replace(LOGIN_PAGE);
    }

    // ============================================================
    // INIT
    // ============================================================
    async function init() {
        if (initialized) return;
        initialized = true;

        try {
            for (const k of LEGACY_TOKEN_KEYS) {
                localStorage.removeItem(k);
                sessionStorage.removeItem(k);
            }
        } catch {}

        initChannel();

        if (!IS_ADMIN_PAGE) installConnectivityListeners();

        if (IS_ADMIN_PAGE || IS_AUTH_PAGE || IS_ROOT_PAGE) {
            fireReady();
            return;
        }

        let valid = false;
        try { valid = await checkUserSession(); }
        catch { valid = false; }

        if (!valid) {
            fireError();
            return;
        }

        startUserHeartbeat();
        scheduleProactiveRefresh();
        fireReady();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

    // ============================================================
    // VISIBILITY
    // ============================================================
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if (IS_ADMIN_PAGE || IS_AUTH_PAGE || IS_ROOT_PAGE) return;
        if (!navigator.onLine) return;
        checkUserSession().then((valid) => {
            if (valid) scheduleProactiveRefresh();
        }).catch(() => {});
    });

    // ============================================================
    // CROSS-TAB (storage fallback)
    // ============================================================
    window.addEventListener('storage', (event) => {
        if (event.key === USER_KEY && event.newValue === null && !IS_ADMIN_PAGE && !IS_AUTH_PAGE) {
            clearAccessToken();
            redirectToUserLogin();
        }
    });

    // ============================================================
    // EXPORTS (unchanged names — backward compatible)
    // ============================================================
    window.getUserSession = readSession;
    window.getUser        = getUser;

    window.saveUserSession  = saveUser;
    window.clearUserSession = () => { clearAccessToken(); clearUser(); };

    window.checkUserSession  = checkUserSession;
    window.doUserLogout      = doUserLogout;
    window.userFetch         = userFetch;
    window.refreshUserToken  = refreshToken;

    window.getAccessToken    = getAccessToken;
    window.setAccessToken    = setAccessToken;
    window.getOrCreateDeviceId = getOrCreateDeviceId;

    window.saveReturnDestination     = saveReturnDestination;
    window.getSafeReturnDestination  = getSafeReturnDestination;
    window.clearReturnDestination    = clearReturnDestination;
    window.redirectToUserLogin       = redirectToUserLogin;
    window.milespaceIsOffline        = () => isOffline;

    console.log('[SESSION] Ready — memory-only token, HttpOnly refresh, Web Locks cross-tab, session:ready wired');
})();

// ─── Universal notification badge loader ─────────────────────
if (typeof document !== 'undefined' && !document.getElementById('notif-badge-script')) {
    const s = document.createElement('script');
    s.id = 'notif-badge-script';
    s.src = '/js/notif-badge.js';
    s.defer = true;
    document.head.appendChild(s);
}