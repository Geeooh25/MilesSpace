// /public/js/admin-session.js - COMPLETE FIXED VERSION
// Single source of truth for admin authentication
// All paths correctly use /api/admin/*

(function() {
    'use strict';

    const ADMIN_SESSION_KEY = 'admin_sess';
    const LOGIN_URL = '/admin/index.html';
    const DASHBOARD_URL = '/admin/dashboard.html';

    // ─── PAGE DETECTION ──────────────────────────────────────────────
    const pathname = window.location.pathname;
    const IS_ADMIN_PAGE = pathname.startsWith('/admin');
    const IS_LOGIN_PAGE = pathname === '/admin' || 
                          pathname === '/admin/' || 
                          pathname === '/admin/index.html' ||
                          pathname === '/admin/index' ||
                          pathname === '/admin/login' ||
                          pathname === '/admin/login.html';
    const IS_DASHBOARD_PAGE = pathname === '/admin/dashboard' ||
                              pathname === '/admin/dashboard/' ||
                              pathname === '/admin/dashboard.html';

    if (!IS_ADMIN_PAGE) {
        return;
    }

    // ─── STATE ──────────────────────────────────────────────────────
    let isRedirecting = false;
    let heartbeatTimer = null;
    let initAttempted = false;
    let isVerifying = false;
    let refreshInProgress = false;

    // ─── SESSION HELPERS ─────────────────────────────────────────────

    function getAdminSession() {
        try {
            const raw = localStorage.getItem(ADMIN_SESSION_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            console.error('[ADMIN SESSION] Invalid session data:', e);
            return null;
        }
    }

    function getAdminToken() {
        const session = getAdminSession();
        return session?.token || null;
    }

    function getAdminUser() {
        const session = getAdminSession();
        return session?.user || null;
    }

    function getRefreshToken() {
        const session = getAdminSession();
        return session?.refreshToken || null;
    }

    function decodeJwtPayload(token) {
        try {
            if (!token) return null;
            const parts = token.split('.');
            if (parts.length !== 3) return null;
            let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            while (base64.length % 4 !== 0) base64 += '=';
            return JSON.parse(atob(base64));
        } catch (e) {
            return null;
        }
    }

    function getTokenExpiry(token) {
        const payload = decodeJwtPayload(token);
        if (!payload || !payload.exp) return null;
        return payload.exp * 1000;
    }

    function isTokenExpired(token) {
        const expiry = getTokenExpiry(token);
        if (!expiry) return true;
        return Date.now() >= expiry;
    }

    function isSessionValid() {
        const token = getAdminToken();
        if (!token) return false;
        return !isTokenExpired(token);
    }

    function clearAdminSession() {
        localStorage.removeItem(ADMIN_SESSION_KEY);
        sessionStorage.removeItem(ADMIN_SESSION_KEY);
        console.log('[ADMIN SESSION] Session cleared');
    }

    function saveAdminSession(token, user, refreshToken = null) {
        if (!token) {
            throw new Error('Cannot save empty admin token');
        }

        const expiresAt = getTokenExpiry(token);
        const session = {
            token: token,
            refreshToken: refreshToken || null,
            user: user || null,
            loggedAt: Date.now(),
            expiresAt: expiresAt
        };

        localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
        console.log('[ADMIN SESSION] Saved, expires:', expiresAt ? new Date(expiresAt).toLocaleString() : 'INVALID');
        return session;
    }

    // ─── REDIRECT ────────────────────────────────────────────────────

    function redirectToLogin() {
        if (IS_LOGIN_PAGE || isRedirecting) {
            return;
        }
        isRedirecting = true;
        stopHeartbeat();
        console.log('[ADMIN SESSION] Redirecting to login');
        window.location.replace(LOGIN_URL);
    }

    function redirectToDashboard() {
        if (IS_DASHBOARD_PAGE || isRedirecting) {
            return;
        }
        isRedirecting = true;
        console.log('[ADMIN SESSION] Redirecting to dashboard');
        window.location.replace(DASHBOARD_URL);
    }

    // ─── SERVER VERIFICATION ──────────────────────────────────────

    async function verifyAdminSession() {
        if (isVerifying) {
            console.log('[ADMIN SESSION] Verification already in progress');
            return true;
        }
        isVerifying = true;

        const token = getAdminToken();
        if (!token) {
            isVerifying = false;
            console.log('[ADMIN SESSION] No token found');
            return false;
        }

        try {
            console.log('[ADMIN SESSION] Verifying with server...');
            const response = await fetch('/api/admin/session', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                },
                cache: 'no-store'
            });

            if (response.ok) {
                const data = await response.json();
                console.log('[ADMIN SESSION] Server verification successful');
                isVerifying = false;
                return true;
            }

            // Handle specific error codes
            if (response.status === 401 || response.status === 403) {
                let errorData;
                try {
                    errorData = await response.json();
                } catch (e) {
                    errorData = {};
                }
                
                const errorCode = errorData.code || 'UNKNOWN';
                console.warn('[ADMIN SESSION] Server rejected session:', response.status, errorCode);
                
                // Only clear session for specific codes
                if (errorCode === 'SESSION_REVOKED' || 
                    errorCode === 'SESSION_EXPIRED' || 
                    errorCode === 'NO_ACTIVE_SESSION' ||
                    errorCode === 'INVALID_SESSION' ||
                    errorCode === 'NO_TOKEN') {
                    clearAdminSession();
                    redirectToLogin();
                }
                
                isVerifying = false;
                return false;
            }

            // Don't logout on 500/503/network errors
            console.warn('[ADMIN SESSION] Server error:', response.status);
            isVerifying = false;
            return true;

        } catch (error) {
            console.warn('[ADMIN SESSION] Network error, keeping session:', error.message);
            isVerifying = false;
            return true;
        }
    }

    // ─── TOKEN REFRESH ─────────────────────────────────────────────

    async function refreshAdminToken() {
        if (refreshInProgress) {
            console.log('[ADMIN SESSION] Refresh already in progress');
            return false;
        }

        const refreshToken = getRefreshToken();
        if (!refreshToken) {
            console.warn('[ADMIN SESSION] No refresh token available');
            return false;
        }

        refreshInProgress = true;
        console.log('[ADMIN SESSION] Attempting token refresh...');

        try {
            const response = await fetch('/api/admin/refresh', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ refresh_token: refreshToken })
            });

            if (response.ok) {
    const data = await response.json();
    const newToken = data.data?.access_token || data.access_token;
    const newRefresh = data.data?.refresh_token || data.refresh_token || refreshToken;
    // Prefer the user object from the refresh response (role may
    // have changed). Fall back to the cached user.
    const freshUser = data.data?.user || data.user || getAdminUser();

    if (newToken) {
        saveAdminSession(newToken, freshUser, newRefresh);
        console.log('[ADMIN SESSION] Token refreshed successfully');
        refreshInProgress = false;
        return true;
    }
}

            console.warn('[ADMIN SESSION] Refresh failed:', response.status);
            
            // If refresh fails with 401, clear session
            if (response.status === 401) {
                clearAdminSession();
                redirectToLogin();
            }
            
            refreshInProgress = false;
            return false;

        } catch (error) {
            console.warn('[ADMIN SESSION] Refresh error:', error.message);
            refreshInProgress = false;
            return false;
        }
    }

    // ─── HEARTBEAT ──────────────────────────────────────────────────

    function startHeartbeat() {
        stopHeartbeat();

        if (IS_LOGIN_PAGE) {
            return;
        }

        console.log('[ADMIN SESSION] Starting heartbeat');

        heartbeatTimer = setInterval(async () => {
            const token = getAdminToken();

            if (!token) {
                stopHeartbeat();
                redirectToLogin();
                return;
            }

            // Check token expiry
            const expiry = getTokenExpiry(token);
            if (expiry) {
                const timeLeft = expiry - Date.now();
                
                // If token is expired or expiring soon (within 5 minutes)
                if (timeLeft < 300000) {
                    if (timeLeft <= 0) {
                        // Token expired - try refresh
                        console.warn('[ADMIN SESSION] Token expired, attempting refresh...');
                        const refreshed = await refreshAdminToken();
                        if (!refreshed) {
                            clearAdminSession();
                            redirectToLogin();
                            return;
                        }
                    } else if (timeLeft > 0) {
                        // Token expiring soon - refresh proactively
                        console.log(`[ADMIN SESSION] Token expires in ${Math.round(timeLeft/1000)}s, refreshing...`);
                        await refreshAdminToken();
                    }
                    return;
                }
            }

            // Send heartbeat to keep session alive
            const tokenAfterRefresh = getAdminToken();
            if (tokenAfterRefresh) {
                try {
                    // Simple ping to keep session alive
                    await fetch('/api/admin/session', {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${tokenAfterRefresh}`,
                            'Cache-Control': 'no-cache'
                        },
                        cache: 'no-store'
                    });
                } catch (e) {
                    // Silently handle heartbeat errors
                }
            }

        }, 45000); // Every 45 seconds
    }

    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
            console.log('[ADMIN SESSION] Heartbeat stopped');
        }
    }

    // ─── ADMIN FETCH ─────────────────────────────────────────────────

    async function adminFetch(url, options = {}) {
        let token = getAdminToken();

        if (!token) {
            redirectToLogin();
            throw new Error('Admin authentication required');
        }

        // Check if token is expired or expiring soon
        const expiry = getTokenExpiry(token);
        if (expiry) {
            const timeLeft = expiry - Date.now();
            if (timeLeft < 300000) {
                // Try to refresh
                const refreshed = await refreshAdminToken();
                if (refreshed) {
                    token = getAdminToken();
                } else if (timeLeft <= 0) {
                    // Token expired and refresh failed
                    clearAdminSession();
                    redirectToLogin();
                    throw new Error('Admin session expired');
                }
            }
        }

        const headers = {
            ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
            ...(options.headers || {}),
            'Authorization': `Bearer ${token}`,
            'Cache-Control': 'no-cache'
        };

        const response = await fetch(url, { 
            ...options, 
            headers,
            cache: 'no-store'
        });

        // If unauthorized, clear session and redirect
               // 401 = not authenticated → logout.
        // 403 = authenticated but not authorized → DO NOT logout.
        //       Let the caller surface the error. Clearing the session
        //       on a 403 would silently log out a Finance admin who
        //       simply lacks wallets.adjust.
        if (response.status === 401) {
            clearAdminSession();
            redirectToLogin();
            throw new Error('Admin session expired');
        }
        if (response.status === 403) {
            let body = null;
            try { body = await response.clone().json(); } catch (_) {}
            const err = new Error(
                body?.error || 'You do not have permission to perform this action.'
            );
            err.code = body?.code || 'PERMISSION_DENIED';
            err.required = body?.required || null;
            err.status = 403;
            throw err;
        }

        return response;
    }

    // ─── LOGOUT ──────────────────────────────────────────────────────

    async function logoutAdmin() {
        const token = getAdminToken();
        stopHeartbeat();

        try {
            if (token) {
                await fetch('/api/admin/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    keepalive: true
                });
            }
        } catch (error) {
            console.warn('[ADMIN SESSION] Logout request failed:', error.message);
        } finally {
            clearAdminSession();
            window.location.replace(LOGIN_URL);
        }
    }

    // ─── INIT ──────────────────────────────────────────────────────

    async function init() {
        if (initAttempted) {
            console.log('[ADMIN SESSION] Already initialized');
            return;
        }
        initAttempted = true;

        console.log('[ADMIN SESSION] Initializing on:', pathname);
        console.log('[ADMIN SESSION] Is login page:', IS_LOGIN_PAGE);
        console.log('[ADMIN SESSION] Is dashboard page:', IS_DASHBOARD_PAGE);

        // ─── Login Page ────────────────────────────────────────────
        if (IS_LOGIN_PAGE) {
            console.log('[ADMIN SESSION] On login page');
            
            // Check if there's a valid session - if so, redirect to dashboard
            const session = getAdminSession();
            if (session && session.token) {
                const tokenValid = !isTokenExpired(session.token);
                if (tokenValid) {
                    // Verify with server before redirecting
                    const verified = await verifyAdminSession();
                    if (verified) {
                        console.log('[ADMIN SESSION] Valid session on login page, redirecting to dashboard');
                        redirectToDashboard();
                        return;
                    }
                } else {
                    // Token expired, clear it
                    clearAdminSession();
                }
            }
            
            console.log('[ADMIN SESSION] Login page ready');
            return;
        }

        // ─── Protected Admin Page ─────────────────────────────────
        console.log('[ADMIN SESSION] On protected page');

        const token = getAdminToken();
        console.log('[ADMIN SESSION] Token found:', !!token);

        if (!token) {
            console.warn('[ADMIN SESSION] No admin token');
            redirectToLogin();
            return;
        }

        // Check local token validity
        if (isTokenExpired(token)) {
            console.warn('[ADMIN SESSION] Admin token expired locally');
            
            // Try to refresh before redirecting
            const refreshed = await refreshAdminToken();
            if (!refreshed) {
                clearAdminSession();
                redirectToLogin();
                return;
            }
        }

        console.log('[ADMIN SESSION] Local token valid');

        // Verify with server - this is critical
        const verified = await verifyAdminSession();
        if (!verified) {
            console.warn('[ADMIN SESSION] Server verification failed');
            // Verification already handles redirect for failures
            return;
        }

        // Start heartbeat for session maintenance
        startHeartbeat();

        console.log('[ADMIN SESSION] Initialization complete - dashboard ready');
    }

    // ─── RUN ──────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        // Small delay to let page initialize
        setTimeout(init, 50);
    }

    // Handle page visibility change - re-verify when tab becomes visible
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !IS_LOGIN_PAGE) {
            const token = getAdminToken();
            if (token) {
                // Re-verify session when tab becomes visible
                setTimeout(() => {
                    verifyAdminSession();
                }, 500);
            }
        }
    });

    // ─── EXPOSE ──────────────────────────────────────────────────────

    window.AdminSession = {
        // Getters
        getSession: getAdminSession,
        getToken: getAdminToken,
        getUser: getAdminUser,
        getRefreshToken: getRefreshToken,
        
        // Session management
        save: saveAdminSession,
        clear: clearAdminSession,
        
        // Validation
        isValid: isSessionValid,
        isExpired: isTokenExpired,
        getExpiry: getTokenExpiry,
        
        // Server interactions
        verify: verifyAdminSession,
        refresh: refreshAdminToken,
        fetch: adminFetch,
        logout: logoutAdmin,
        
        // Navigation
        redirectToLogin: redirectToLogin,
        redirectToDashboard: redirectToDashboard,
        
        // Heartbeat
        startHeartbeat: startHeartbeat,
        stopHeartbeat: stopHeartbeat
    };

})();