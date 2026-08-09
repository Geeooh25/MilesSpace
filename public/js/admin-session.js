// js/admin-session.js - Admin Session Manager
// This handles admin authentication separately from user sessions

(function() {
    'use strict';

    const ADMIN_SESSION_KEY = 'admin_sess';
    const ADMIN_LOGIN_PAGE = '/admin';   // ← FIXED: was '/admin/login.html', which doesn't exist

    // ─── SESSION FUNCTIONS ───
    function getAdminSession() {
        try {
            const raw = localStorage.getItem(ADMIN_SESSION_KEY) || sessionStorage.getItem(ADMIN_SESSION_KEY) || 'null';
            return JSON.parse(raw);
        } catch (e) { return null; }
    }

    function getAdminToken() {
        const session = getAdminSession();
        return session?.token || '';
    }

    function clearAdminSession() {
        localStorage.removeItem(ADMIN_SESSION_KEY);
        sessionStorage.removeItem(ADMIN_SESSION_KEY);
        localStorage.removeItem('miles_token');
        localStorage.removeItem('miles_user');
        try { sessionStorage.clear(); } catch(e) {}
    }

    function redirectToAdminLogin() {
        clearAdminSession();
        if (!window._isRedirecting) {           // ← added guard (matches dashboard.html's inline version)
            window._isRedirecting = true;
            window.location.href = ADMIN_LOGIN_PAGE;
        }
    }

    function checkAdminSession() {
        const session = getAdminSession();
        if (!session || !session.token) {
            redirectToAdminLogin();
            return false;
        }
        return true;
    }

    // ─── LOGOUT ───
    window.doAdminLogout = async function() {
        if (window.logoutPresence) {
            window.logoutPresence();
        }
        try {
            const token = getAdminToken();
            if (token) {
                await fetch('/api/auth/admin/logout', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    }
                });
            }
        } catch (e) {}
        clearAdminSession();
        window.location.href = ADMIN_LOGIN_PAGE;
    };

    // ─── CHECK ON LOAD ───
    if (!checkAdminSession()) return;

    // ─── INTERCEPT FETCH (only once) ───
    if (!window._adminFetchIntercepted) {
        window._adminFetchIntercepted = true;
        const originalFetch = window.fetch;
        window.fetch = function(...args) {
            const req = args[0];
            const url = typeof req === 'string' ? req : (req && req.url) || '';
            const isPresenceCall = url.includes('/api/presence/');   // ← FIXED: don't logout on presence 401s

            return originalFetch.apply(this, args).then(function(response) {
                if ((response.status === 401 || response.status === 403) && !isPresenceCall) {
                    redirectToAdminLogin();
                }
                return response;
            });
        };
    }

    // ─── CHECK EVERY 2 MINUTES ───
    setInterval(checkAdminSession, 120000);

    // ─── EXPOSE ───
    window.getAdminSession = getAdminSession;
    window.getAdminToken = getAdminToken;
    window.clearAdminSession = clearAdminSession;
    window.redirectToAdminLogin = redirectToAdminLogin;
    window.checkAdminSession = checkAdminSession;

    console.log('✅ Admin Session Manager initialized');
})();