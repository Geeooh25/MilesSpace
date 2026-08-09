// ─── /public/js/session.js ───
// SINGLE SOURCE OF TRUTH FOR SESSION HANDLING
// Load this BEFORE presence.js and before any page-specific script.
// FIXED: Only logs out on REAL auth failures (NO_TOKEN, INVALID_TOKEN, SESSION_EXPIRED)

(function () {
  'use strict';

  const SESSION_KEY = 'mx_sess';
  const ADMIN_KEY = 'admin_sess';
  const LOGIN_PAGE = 'login.html';
  const ADMIN_LOGIN_PAGE = 'admin/login.html';

  // ─── BASE64URL-SAFE JWT DECODE ───
  function decodeJwtPayload(token) {
    try {
      const part = token.split('.')[1];
      if (!part) return null;
      let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      return JSON.parse(atob(b64));
    } catch (e) {
      return null;
    }
  }

  // ─── READ / WRITE SESSION ───
  function readRaw(key) {
    try {
      const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function getSession() {
    return readRaw(SESSION_KEY);
  }

  function getAdminSession() {
    return readRaw(ADMIN_KEY);
  }

  function getActiveSession() {
    const user = getSession();
    if (user) return { session: user, isAdmin: false };
    const admin = getAdminSession();
    if (admin) return { session: admin, isAdmin: true };
    return null;
  }

  function getToken() {
    return getSession()?.token || getAdminSession()?.token || '';
  }

  function saveSession(token, user, remember = false) {
    const data = JSON.stringify({ token, user, loggedAt: Date.now() });
    if (remember) localStorage.setItem(SESSION_KEY, data);
    else sessionStorage.setItem(SESSION_KEY, data);
  }

  function saveAdminSession(token, user) {
    const data = JSON.stringify({ token, user, loggedAt: Date.now() });
    localStorage.setItem(ADMIN_KEY, data);
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ADMIN_KEY);
    sessionStorage.removeItem(ADMIN_KEY);
    localStorage.removeItem('miles_token');
    localStorage.removeItem('miles_user');
  }

  function redirectToLogin() {
    const wasAdmin = !!getAdminSession();
    clearSession();
    window.location.href = wasAdmin ? ADMIN_LOGIN_PAGE : LOGIN_PAGE;
  }

  // ─── LOGOUT ───
  async function doLogout() {
    if (window.logoutPresence) {
      try { window.logoutPresence(); } catch (e) {}
    }

    try {
      const token = getToken();
      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          }
        });
      }
    } catch (e) {}

    clearSession();
    window.location.href = LOGIN_PAGE;
  }

  // ─── EXPIRY CHECK ───
  function getTokenExpiryMs() {
    const token = getToken();
    if (!token) return null;
    const payload = decodeJwtPayload(token);
    if (!payload || !payload.exp) return null;
    return payload.exp * 1000;
  }

  function isSessionExpired() {
    const expiry = getTokenExpiryMs();
    if (expiry === null) return false;
    return Date.now() >= expiry;
  }

  function checkSession() {
    const active = getActiveSession();
    if (!active) {
      if (!window.location.pathname.includes('/admin/')) {
        redirectToLogin();
        return false;
      }
      return false;
    }
    if (isSessionExpired()) {
      if (!window.location.pathname.includes('/admin/')) {
        redirectToLogin();
        return false;
      }
      return false;
    }
    return true;
  }

  // ─── SCHEDULE LOGOUT AT EXACT EXPIRY ───
  let expiryTimer = null;
  function scheduleExpiryLogout() {
    if (expiryTimer) clearTimeout(expiryTimer);
    const expiry = getTokenExpiryMs();
    if (!expiry) return;
    const timeLeft = expiry - Date.now();
    if (timeLeft <= 0) {
      if (!window.location.pathname.includes('/admin/')) {
        redirectToLogin();
      }
      return;
    }
    expiryTimer = setTimeout(() => {
      if (!window.location.pathname.includes('/admin/')) {
        redirectToLogin();
      }
    }, timeLeft);
  }

  // ─── SINGLE GLOBAL FETCH INTERCEPTOR ───
  // FIXED: Only redirects on REAL auth failures
  if (!window.__sessionFetchWrapped) {
    window.__sessionFetchWrapped = true;
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req && req.url) || '';
      const isPresenceCall = url.includes('/api/presence/');

      return originalFetch.apply(this, args).then(function (response) {
        // ─── FIXED: Only redirect on REAL auth failures ───
        if (response.status === 401 && !isPresenceCall) {
          // Clone response to read body without consuming it
          const clone = response.clone();
          return clone.json()
            .then(data => {
              // ─── Only redirect for these specific codes ───
              const REAL_AUTH_FAILURES = ['NO_TOKEN', 'INVALID_TOKEN', 'SESSION_EXPIRED'];
              const shouldRedirect = !data.code || REAL_AUTH_FAILURES.includes(data.code);
              
              if (shouldRedirect && !window.location.pathname.includes('/admin/')) {
                redirectToLogin();
              }
              // Return the original response for the caller
              return response;
            })
            .catch(() => {
              // If we can't parse JSON, treat as non-auth error
              return response;
            });
        }
        return response;
      });
    };
  }

  // ─── INIT ───
  checkSession();
  scheduleExpiryLogout();
  setInterval(checkSession, 30000);

  // ─── EXPOSE ───
  window.getSession = getSession;
  window.getAdminSession = getAdminSession;
  window.getActiveSession = getActiveSession;
  window.getToken = getToken;
  window.saveSession = saveSession;
  window.saveAdminSession = saveAdminSession;
  window.clearSession = clearSession;
  window.redirectToLogin = redirectToLogin;
  window.doLogout = doLogout;
  window.checkSession = checkSession;

  console.log('✅ Session manager loaded (fixed fetch interceptor)');
})();