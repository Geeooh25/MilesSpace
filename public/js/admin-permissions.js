// public/js/admin-permissions.js
// ─────────────────────────────────────────────────────────────────
// Frontend permission helpers. UX only — never security.
//
// The backend enforces every permission via requirePermission().
// This file exists so admin pages can (a) hide actions they can't
// perform and (b) show a clear "permission required" message.
//
// The login page is explicitly skipped — /api/admin/me requires a
// bearer token, and calling it while logged out returns 401 and
// spams the console.
// ─────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    // ─── Page guard ─────────────────────────────────────────
    const pathname = window.location.pathname;
    if (!pathname.startsWith('/admin')) return;

    const LOGIN_PATHS = new Set([
        '/admin', '/admin/',
        '/admin/index', '/admin/index.html',
        '/admin/login', '/admin/login.html'
    ]);
    if (LOGIN_PATHS.has(pathname)) return;

    // ─── State ──────────────────────────────────────────────
    const state = {
        loaded: false,
        loading: null,
        admin: null,
        permissions: {}
    };

    function getToken() {
        try {
            const raw = localStorage.getItem('admin_sess')
                || sessionStorage.getItem('admin_sess');
            if (!raw) return null;
            return JSON.parse(raw)?.token || null;
        } catch { return null; }
    }

    // ─── Load /api/admin/me ─────────────────────────────────
    async function load() {
        if (state.loaded) return state;
        if (state.loading) return state.loading;

        const token = getToken();
        if (!token) return state; // not logged in — do nothing, don't spam 401s

        state.loading = (async () => {
            try {
                const res = await fetch('/api/admin/me', {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Cache-Control': 'no-cache'
                    },
                    cache: 'no-store'
                });
                if (!res.ok) return state;
                const data = await res.json();
                state.admin = data.admin || data.user || null;
                state.permissions = data.permissions || {};
                state.loaded = true;
            } catch (_) {
                // Network failure — UI degrades to "locked" state.
                // Backend still enforces.
            } finally {
                state.loading = null;
            }
            return state;
        })();

        return state.loading;
    }

    // ─── Permission predicates ──────────────────────────────
    function can(permissionKey) {
        if (!state.loaded) return false;
        if (state.admin?.isSuperAdmin) return true;
        return !!state.permissions[permissionKey];
    }
    function canAny(keys) { return Array.isArray(keys) && keys.some(can); }
    function canAll(keys) { return Array.isArray(keys) && keys.every(can); }

    // ─── UI helpers ─────────────────────────────────────────
    function guard(permissionKey, el, onDenied) {
        if (!el) return;
        if (can(permissionKey)) return;
        if (typeof onDenied === 'function') onDenied(el);
        else el.style.display = 'none';
    }

    function lockedButton(el, permissionKey) {
        if (!el || can(permissionKey)) return;
        el.disabled = true;
        el.classList.add('admin-locked');
        el.setAttribute('title',
            `You don't have permission (${permissionKey}). Contact a super admin.`);
        if (!el.querySelector('.admin-lock-icon')) {
            const i = document.createElement('i');
            i.className = 'fas fa-lock admin-lock-icon';
            i.style.marginRight = '6px';
            i.style.opacity = '0.7';
            el.prepend(i);
        }
    }

    function lockedPanel(container, permissionKey, title) {
        if (!container || can(permissionKey)) return;
        container.innerHTML = `
            <div class="admin-perm-locked" style="
                border:1px solid rgba(12,61,74,0.12);
                border-radius:10px;padding:16px 18px;background:#f8fafb;
                color:#5b7480;font-size:13px;line-height:1.5;">
                <div style="font-weight:700;color:#0c3d4a;margin-bottom:6px;">
                    <i class="fas fa-lock" style="margin-right:6px;"></i>
                    ${title || 'Permission required'}
                </div>
                <div>You don't have permission to perform this action.</div>
                <div style="margin-top:6px;">Required: <code>${permissionKey}</code></div>
                <div style="margin-top:4px;">Your role: <strong>${state.admin?.role || 'unknown'}</strong></div>
            </div>`;
    }

    // ─── Error-code → message ───────────────────────────────
    const ERROR_MESSAGES = {
        AUTH_REQUIRED:     'Please sign in to continue.',
        SESSION_EXPIRED:   'Your session has expired. Please sign in again.',
        SESSION_REVOKED:   'Your session was ended on another device.',
        PERMISSION_DENIED: 'You do not have permission to perform this action.',
        MFA_REQUIRED:      'Additional verification required.',
        STEP_UP_EXPIRED:   'Your verification expired. Please verify again.',
        RATE_LIMITED:      'Too many requests. Please slow down.'
    };
    function describeError(code, fallback) {
        return ERROR_MESSAGES[code] || fallback || 'Request failed.';
    }

    // ─── Public API ─────────────────────────────────────────
    window.AdminPermissions = {
        load,
        can,
        canAny,
        canAll,
        guard,
        lockedButton,
        lockedPanel,
        describeError,
        get admin() { return state.admin; },
        get permissions() { return state.permissions; },
        get loaded() { return state.loaded; }
    };

    // Auto-load once the DOM is ready.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { load(); }, { once: true });
    } else {
        load();
    }
})();