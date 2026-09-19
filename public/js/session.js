// /public/js/session.js
// ============================================================
// MILESSPACE USER SESSION MANAGER
// USER ONLY - NEVER TOUCHES ADMIN SESSION
// Single authority for auth + connectivity.
// ============================================================

(function () {
    'use strict';

    // ─── CONSTANTS ─────────────────────────────────────────────
    const SESSION_KEY = 'mx_sess';
    const RETURN_TO_KEY = 'milespace_return_to';

    const LOGIN_PAGE = '/login.html';
    const DASHBOARD_PAGE = '/dashboard.html';

    const REFRESH_ENDPOINT = '/api/auth/refresh';
    const SESSION_ENDPOINT = '/api/auth/session';
    const LOGOUT_ENDPOINT = '/api/auth/logout';

    // Auth/OTP pages must never be saved as return destination.
    const AUTH_PAGES = new Set([
        '/login.html',
        '/login',
        '/signup.html',
        '/signup',
        '/register.html',
        '/register',
        '/forgot-password.html',
        '/forgot-password',
        '/reset-password.html',
        '/reset-password',
        '/verify.html',
        '/verify'
    ]);

    // ─── STATE ─────────────────────────────────────────────────
    let heartbeatTimer = null;
    let expiryTimer = null;
    let refreshPromise = null;
    let initialized = false;
    let redirecting = false;
    let isOffline = false;
    let bannerEl = null;

    // ─── PAGE DETECTION ────────────────────────────────────────
    const pathname = window.location.pathname;

    const IS_ADMIN_PAGE =
        pathname === '/admin' ||
        pathname === '/admin/' ||
        pathname.startsWith('/admin/');

    const IS_USER_LOGIN_PAGE =
        pathname === '/login.html' ||
        pathname === '/login';

    const IS_AUTH_PAGE = AUTH_PAGES.has(pathname);

    const IS_ROOT_PAGE =
        pathname === '/' || pathname === '/index.html';

    // ============================================================
    // RETURN-TO / DESTINATION HANDLING
    // ============================================================

    /**
     * Reject anything that isn't a same-origin relative path.
     * Blocks: https://, http://, //, javascript:, data:, vbscript:
     * Also blocks login loops and auth pages.
     */
    function isSafeInternalPath(dest) {
        if (typeof dest !== 'string' || dest.length === 0) return false;

        // Must start with a single slash, not // or /\
        if (dest[0] !== '/') return false;
        if (dest[1] === '/') return false;
        if (dest[1] === '\\') return false;

        // Reject protocol-relative and pseudo-protocols
        if (/^\/\/|^\/\\/.test(dest)) return false;
        if (/^\s*(javascript|data|vbscript|file):/i.test(dest)) return false;

        // Reject backslashes anywhere (some browsers treat as path sep)
        if (dest.includes('\\')) return false;

        // Normalize path portion only
        let pathOnly;
        try {
            pathOnly = new URL(dest, window.location.origin).pathname;
        } catch {
            return false;
        }

        // Reject auth pages as destination (loop prevention)
        if (AUTH_PAGES.has(pathOnly)) return false;

        // Reject nested redirect params: /login.html?redirect=...
        if (pathOnly === '/login.html' || pathOnly === '/login') return false;

        return true;
    }

    /**
     * Save current page (path + search + hash) as return destination.
     * Skips auth pages, admin pages, and root.
     */
    function saveReturnDestination() {
        if (IS_ADMIN_PAGE) return;
        if (IS_AUTH_PAGE) return;
        if (IS_ROOT_PAGE) return;

        const dest =
            window.location.pathname +
            window.location.search +
            window.location.hash;

        if (!isSafeInternalPath(dest)) {
            console.warn('[SESSION] Refusing to save unsafe return dest:', dest);
            return;
        }

        try {
            sessionStorage.setItem(
                RETURN_TO_KEY,
                JSON.stringify({ path: dest, savedAt: Date.now() })
            );
            console.log('[SESSION] Saving return destination:', dest);
        } catch (e) {
            console.warn('[SESSION] Failed to save return destination:', e);
        }
    }

    /**
     * Read + validate return destination.
     * Priority: sessionStorage → ?redirect= query param.
     * Returns null if nothing safe.
     */
    function getSafeReturnDestination() {
        // 1. sessionStorage
        try {
            const raw = sessionStorage.getItem(RETURN_TO_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && isSafeInternalPath(parsed.path)) {
                    return parsed.path;
                }
                // Corrupt / unsafe — drop it
                sessionStorage.removeItem(RETURN_TO_KEY);
            }
        } catch (e) {
            sessionStorage.removeItem(RETURN_TO_KEY);
        }

        // 2. ?redirect= query param
        try {
            const params = new URLSearchParams(window.location.search);
            const fromQuery = params.get('redirect');
            if (fromQuery) {
                const decoded = decodeURIComponent(fromQuery);
                if (isSafeInternalPath(decoded)) {
                    return decoded;
                }
            }
        } catch (e) {
            // ignore
        }

        return null;
    }

    function clearReturnDestination() {
        try {
            sessionStorage.removeItem(RETURN_TO_KEY);
        } catch (e) {
            // ignore
        }
    }

    // ============================================================
    // JWT
    // ============================================================

    function decodeJwtPayload(token) {
        try {
            if (!token) return null;
            const parts = token.split('.');
            if (parts.length !== 3) return null;
            let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            while (base64.length % 4) base64 += '=';
            return JSON.parse(atob(base64));
        } catch (error) {
            return null;
        }
    }

    function getTokenExpiryMs(token) {
        const payload = decodeJwtPayload(token);
        if (!payload || !payload.exp) return null;
        return payload.exp * 1000;
    }

    function isTokenExpired(token) {
        const expiry = getTokenExpiryMs(token);
        if (expiry === null) return true;
        return Date.now() >= expiry;
    }

    // ============================================================
    // SESSION READ
    // ============================================================

    function readSession() {
        try {
            const local = localStorage.getItem(SESSION_KEY);
            if (local) return JSON.parse(local);

            const session = sessionStorage.getItem(SESSION_KEY);
            if (session) return JSON.parse(session);

            return null;
        } catch (error) {
            console.error('[SESSION] Failed to read session');
            return null;
        }
    }

    function getUserToken() {
        return readSession()?.token || '';
    }

    // Support both camelCase (session.js) and snake_case (legacy login.html)
    function getRefreshToken() {
        const s = readSession();
        if (!s) return null;
        return s.refreshToken || s.refresh_token || null;
    }

    function getUser() {
        return readSession()?.user || null;
    }

    // ============================================================
    // SAVE SESSION
    // ============================================================

    function saveSession(token, user, remember = false, refreshToken = null) {
        if (!token) throw new Error('Cannot save empty user token');

        localStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SESSION_KEY);

        const expiresAt = getTokenExpiryMs(token);

        const sessionData = {
            token,
            refreshToken: refreshToken || null,
            user: user || null,
            loggedAt: Date.now(),
            expiresAt,
            remember: !!remember
        };

        const json = JSON.stringify(sessionData);

        if (remember) {
            localStorage.setItem(SESSION_KEY, json);
        } else {
            sessionStorage.setItem(SESSION_KEY, json);
        }

        console.log(
            '[SESSION] Saved:',
            user?.email || user?.username || 'user'
        );

        return sessionData;
    }

    // ============================================================
    // CLEAR USER SESSION
    // ============================================================

    function clearUserSession() {
        localStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SESSION_KEY);

        // Legacy keys
        localStorage.removeItem('miles_token');
        localStorage.removeItem('miles_user');

        // Do NOT clear return destination here — logout decides that.
        console.log('[SESSION] Cleared');
    }

    // ============================================================
    // CONNECTIVITY BANNER
    // ============================================================

    function ensureBanner() {
        if (bannerEl && document.body.contains(bannerEl)) return bannerEl;

        bannerEl = document.createElement('div');
        bannerEl.id = 'milespaceConnectivity';
        bannerEl.setAttribute('role', 'status');
        bannerEl.setAttribute('aria-live', 'polite');

        Object.assign(bannerEl.style, {
            position: 'fixed',
            left: '50%',
            bottom: '24px',
            transform: 'translateX(-50%) translateY(120%)',
            padding: '10px 18px',
            borderRadius: '999px',
            fontFamily: 'Inter, DM Sans, system-ui, sans-serif',
            fontSize: '13px',
            fontWeight: '600',
            letterSpacing: '0.01em',
            color: '#ffffff',
            background: '#1a2c3e',
            boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
            zIndex: '2147483647',
            pointerEvents: 'none',
            opacity: '0',
            transition: 'transform 0.28s ease, opacity 0.28s ease',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            maxWidth: 'calc(100vw - 32px)'
        });

        bannerEl.innerHTML = '<span id="milespaceConnectivityText"></span>';

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
        if (txt) txt.textContent = text;

        // Tone: 'offline' | 'online'
        if (tone === 'offline') {
            el.style.background = '#1a2c3e';
        } else if (tone === 'online') {
            el.style.background = '#065f46';
        }

        el.style.transform = 'translateX(-50%) translateY(0)';
        el.style.opacity = '1';

        if (showBanner._timer) clearTimeout(showBanner._timer);

        // Auto-hide only for "back online"
        if (tone === 'online') {
            showBanner._timer = setTimeout(() => hideBanner(), 3200);
        }
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
        console.log('[NETWORK] Offline');
        showBanner('You are offline', 'offline');
    }

    function markOnline() {
        if (!isOffline) {
            // Still update dataset for consistency
            document.body.dataset.network = 'online';
            return;
        }
        isOffline = false;
        document.body.dataset.network = 'online';
        console.log('[NETWORK] Back online');
        showBanner("You're back online", 'online');
    }

    function installConnectivityListeners() {
        if (IS_ADMIN_PAGE) return; // admin has its own system

        window.addEventListener('offline', () => {
            markOffline();
            if (window.presenceTracker?.pauseForOffline) {
                try { window.presenceTracker.pauseForOffline(); } catch (e) {}
            }
        });

        window.addEventListener('online', () => {
            markOnline();
            if (window.presenceTracker?.resumeFromOffline) {
                try { window.presenceTracker.resumeFromOffline(); } catch (e) {}
            }
        });

        // Initial signal
        if (navigator.onLine === false) {
            markOffline();
        } else {
            document.body.dataset.network = 'online';
        }
    }

    // ============================================================
    // REDIRECT TO LOGIN (with return destination)
    // ============================================================

    function redirectToUserLogin() {
        if (IS_ADMIN_PAGE) return;
        if (IS_AUTH_PAGE) return;
        if (redirecting) return;

        redirecting = true;

        // CRITICAL: save destination BEFORE clearing session.
        saveReturnDestination();

        clearUserSession();

        if (typeof window.logoutPresence === 'function') {
            try { window.logoutPresence(); } catch (e) {}
        }

        const dest = (() => {
            try {
                const raw = sessionStorage.getItem(RETURN_TO_KEY);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                return parsed?.path && isSafeInternalPath(parsed.path)
                    ? parsed.path
                    : null;
            } catch {
                return null;
            }
        })();

        let url = LOGIN_PAGE;
        if (dest) {
            url += '?redirect=' + encodeURIComponent(dest);
            console.log('[SESSION] Redirecting to login, return to:', dest);
        } else {
            console.log('[SESSION] Redirecting to login (no return dest)');
        }

        // Use replace — never leave login in history
        window.location.replace(url);
    }

    // ============================================================
    // SESSION VALIDATION
    // ============================================================

    function isSessionValid() {
        const token = getUserToken();
        if (!token) return false;
        return !isTokenExpired(token);
    }

    // ============================================================
    // REFRESH TOKEN (single-flight)
    // ============================================================

    async function refreshToken() {
        if (refreshPromise) return refreshPromise;

        const oldRefreshToken = getRefreshToken();
        if (!oldRefreshToken) throw new Error('No refresh token');

        refreshPromise = (async () => {
            try {
                console.log('[SESSION] Attempting refresh');

                const response = await fetch(REFRESH_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refresh_token: oldRefreshToken })
                });

                if (!response.ok) {
                    throw new Error(`Refresh failed: ${response.status}`);
                }

                const result = await response.json();

                const newAccessToken =
                    result?.data?.access_token || result?.access_token;
                const newRefreshToken =
                    result?.data?.refresh_token ||
                    result?.refresh_token ||
                    oldRefreshToken;

                if (!newAccessToken) {
                    throw new Error('Refresh response contains no access token');
                }

                const session = readSession();

                saveSession(
                    newAccessToken,
                    session?.user || null,
                    session?.remember === true,
                    newRefreshToken
                );

                console.log('[SESSION] Refresh successful');
                scheduleProactiveRefresh();
                return newAccessToken;
            } catch (error) {
                console.error('[SESSION] Refresh failed:', error.message);
                throw error;
            } finally {
                refreshPromise = null;
            }
        })();

        return refreshPromise;
    }

    // ============================================================
    // CHECK SESSION
    // ============================================================

    async function checkUserSession() {
        if (IS_ADMIN_PAGE) return true;
        if (IS_AUTH_PAGE) return true;

        const token = getUserToken();
        if (!token) {
            redirectToUserLogin();
            return false;
        }

        if (!isTokenExpired(token)) return true;

        if (getRefreshToken()) {
            try {
                await refreshToken();
                return true;
            } catch (error) {
                redirectToUserLogin();
                return false;
            }
        }

        redirectToUserLogin();
        return false;
    }

    // ============================================================
    // HEARTBEAT (session probe, 60s)
    // ============================================================

    function startUserHeartbeat() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);

        if (IS_AUTH_PAGE || IS_ADMIN_PAGE) return;

        heartbeatTimer = setInterval(async () => {
            const token = getUserToken();
            if (!token) {
                clearInterval(heartbeatTimer);
                return;
            }

            // Refresh before expiry
            const expiry = getTokenExpiryMs(token);
            if (expiry) {
                const timeLeft = expiry - Date.now();
                if (timeLeft <= 60000 && timeLeft > 0) {
                    try { await refreshToken(); } catch (e) {}
                    return;
                }
            }

            try {
                const response = await fetch(SESSION_ENDPOINT, {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${token}` }
                });

                if (response.ok) return;

                if (response.status === 401) {
                    let data = {};
                    try { data = await response.json(); } catch (e) {}

                    if (
                        data.code === 'SESSION_EXPIRED' ||
                        data.code === 'INVALID_TOKEN'
                    ) {
                        if (getRefreshToken()) {
                            try { await refreshToken(); }
                            catch (e) { redirectToUserLogin(); }
                        } else {
                            redirectToUserLogin();
                        }
                    } else if (
                        data.code === 'SESSION_REVOKED' ||
                        data.code === 'ACCOUNT_DELETED' ||
                        data.code === 'ACCOUNT_SUSPENDED'
                    ) {
                        redirectToUserLogin();
                    }
                }
                // 503, 500, etc → leave alone; connectivity layer handles offline
            } catch (error) {
                // Network failure is NOT auth failure
                console.warn('[SESSION] Heartbeat network error — keeping session');
            }
        }, 60000);
    }

    // ============================================================
    // PROACTIVE REFRESH
    // ============================================================

    function scheduleProactiveRefresh() {
        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
        }

        if (IS_ADMIN_PAGE || IS_AUTH_PAGE) return;

        const token = getUserToken();
        if (!token) return;

        const expiry = getTokenExpiryMs(token);
        if (!expiry) return;

        const timeLeft = expiry - Date.now();

        if (timeLeft <= 0) {
            if (getRefreshToken()) refreshToken().catch(() => {});
            return;
        }

        const REFRESH_AHEAD_MS = 5 * 60 * 1000; // 5 minutes before expiry
        const refreshIn = timeLeft - REFRESH_AHEAD_MS;

        if (refreshIn > 0) {
            expiryTimer = setTimeout(() => {
                if (getRefreshToken()) refreshToken().catch(() => {});
            }, refreshIn);
        } else {
            if (getRefreshToken()) refreshToken().catch(() => {});
        }
    }

    // ============================================================
    // USER FETCH
    // ============================================================

    async function userFetch(url, options = {}, retry = true) {
        if (IS_ADMIN_PAGE) {
            throw new Error('userFetch() cannot be used on admin pages');
        }

        const token = getUserToken();
        if (!token) {
            redirectToUserLogin();
            throw new Error('User not authenticated');
        }

        const headers = {
            ...(options.headers || {}),
            Authorization: `Bearer ${token}`
        };

        if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
        }

        let response;
        try {
            response = await fetch(url, { ...options, headers });
        } catch (networkError) {
            // Network failure — do NOT redirect. Surface the error.
            console.warn('[NETWORK] Fetch failed:', networkError.message);
            if (navigator.onLine === false) markOffline();
            throw networkError;
        }

        // Success or non-auth error → return as-is
        if (response.status !== 401) {
            return response;
        }

        // 401 → inspect code
        let data = {};
        try { data = await response.clone().json(); } catch (e) {}

        const code = data.code;

        if (
            retry &&
            (code === 'SESSION_EXPIRED' || code === 'INVALID_TOKEN') &&
            getRefreshToken()
        ) {
            try {
                await refreshToken();
                return userFetch(url, options, false); // one retry only
            } catch (err) {
                redirectToUserLogin();
                throw err;
            }
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
        const token = getUserToken();
        const refreshTokenValue = getRefreshToken();

        if (typeof window.logoutPresence === 'function') {
            try { window.logoutPresence(); } catch (e) {}
        }

        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
        }
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }

        try {
            if (token) {
                await fetch(LOGOUT_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                    },
                    body: JSON.stringify(
                        refreshTokenValue
                            ? { refresh_token: refreshTokenValue }
                            : {}
                    )
                });
            }
        } catch (error) {
            // server logout failure shouldn't block local logout
        }

        clearUserSession();
        clearReturnDestination(); // logout = no auto-restore

        window.location.replace(LOGIN_PAGE);
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    async function init() {
        if (initialized) return;
        initialized = true;

        // Connectivity listeners run on all non-admin pages, including auth.
        if (!IS_ADMIN_PAGE) {
            installConnectivityListeners();
        }

        if (IS_ADMIN_PAGE) {
            console.log('[SESSION] Admin page — skipped');
            return;
        }

        if (IS_AUTH_PAGE || IS_ROOT_PAGE) {
            console.log('[SESSION] Auth/root page — guard skipped');
            return;
        }

        console.log('[SESSION] Initializing');

        const valid = await checkUserSession();
        if (!valid) return;

        startUserHeartbeat();
        scheduleProactiveRefresh();

        console.log('[SESSION] Loaded');
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
        if (
            !document.hidden &&
            !IS_ADMIN_PAGE &&
            !IS_AUTH_PAGE &&
            !IS_ROOT_PAGE
        ) {
            checkUserSession().then((valid) => {
                if (valid) scheduleProactiveRefresh();
            });
        }
    });

    // ============================================================
    // CROSS-TAB
    // ============================================================

    window.addEventListener('storage', (event) => {
        if (
            event.key === SESSION_KEY &&
            event.newValue === null &&
            !IS_ADMIN_PAGE &&
            !IS_AUTH_PAGE
        ) {
            console.log('[SESSION] Session removed in another tab');
            redirectToUserLogin();
        }
    });

    // ============================================================
    // EXPORTS
    // ============================================================

    window.getUserSession = readSession;
    window.getUserToken = getUserToken;
    window.getRefreshToken = getRefreshToken;
    window.getUser = getUser;

    window.saveUserSession = saveSession;
    window.clearUserSession = clearUserSession;

    window.checkUserSession = checkUserSession;
    window.doUserLogout = doUserLogout;
    window.userFetch = userFetch;
    window.refreshUserToken = refreshToken;

    // Return-destination API (used by login.html + anywhere)
    window.saveReturnDestination = saveReturnDestination;
    window.getSafeReturnDestination = getSafeReturnDestination;
    window.clearReturnDestination = clearReturnDestination;

    // Auth redirect API (used by presence.js if needed)
    window.redirectToUserLogin = redirectToUserLogin;

    // Connectivity API
    window.milespaceIsOffline = () => isOffline;

    console.log('[SESSION] Exported — isolated from admin');
})();