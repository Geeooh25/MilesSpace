// public/js/admin-presence.js - Admin-only presence
// Only loads on admin pages

(function() {
    'use strict';

    const pathname = window.location.pathname;
    const IS_ADMIN_PAGE = pathname.startsWith('/admin');

    if (!IS_ADMIN_PAGE) {
        console.log('⏭️ [ADMIN PRESENCE] Not on admin page, skipping');
        return;
    }

    console.log('🟢 [ADMIN PRESENCE] Initializing');

    const IS_LOGIN_PAGE = pathname === '/admin' || 
                          pathname === '/admin/' || 
                          pathname === '/admin/login' ||
                          pathname === '/admin/login.html' ||
                          pathname === '/admin/index.html';

    if (IS_LOGIN_PAGE) {
        console.log('⏭️ [ADMIN PRESENCE] On login page, skipping');
        return;
    }

    let heartbeatInterval = null;

    function getAdminToken() {
        try {
            const session = localStorage.getItem('admin_sess') || sessionStorage.getItem('admin_sess');
            if (!session) return null;
            const data = JSON.parse(session);
            return data?.token || null;
        } catch { return null; }
    }

    function sendAdminHeartbeat() {
        const token = getAdminToken();
        if (!token) {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            return;
        }

        fetch('/api/admin/presence/heartbeat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                page: window.location.pathname,
                action: 'viewing admin',
                isAdmin: true
            })
        }).catch(() => {});
    }

    // Send initial heartbeat
    setTimeout(sendAdminHeartbeat, 500);

    // Start interval
    heartbeatInterval = setInterval(sendAdminHeartbeat, 30000);

    // Send on page unload
    window.addEventListener('beforeunload', () => {
        const token = getAdminToken();
        if (!token) return;
        fetch('/api/admin/presence/offline', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            keepalive: true
        }).catch(() => {});
    });

    console.log('✅ [ADMIN PRESENCE] Started (30s heartbeat)');
})();