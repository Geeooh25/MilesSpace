// public/js/settings.js
// ─────────────────────────────────────────────────────────────────
// Customer account settings controller.
//
// ENDPOINTS USED (implemented in routes/userSettingsRoutes.js):
//   GET    /api/user/settings
//   PUT    /api/user/notifications
//   PUT    /api/user/phone
//   PUT    /api/user/password
//   PUT    /api/user/pin
//   POST   /api/user/pin/forgot/request|verify|reset
//   POST   /api/user/email/change-request|change-verify
//   POST   /api/user/2fa/email/setup|verify|resend
//   POST   /api/user/2fa/email/disable/request|verify
//   DELETE /api/user/sessions/:sessionId
//   POST   /api/user/sessions/logout-others
//   GET    /api/user/activity
//   GET    /api/user/security-alerts
//   POST   /api/user/security-alerts/:id/read
//   POST   /api/user/deactivate
//
// NEW (permanent deletion):
//   POST   /api/user/delete/request
//   POST   /api/user/delete/verify
//   POST   /api/user/delete/confirm
// ─────────────────────────────────────────────────────────────────

'use strict';

// ─── STATE ────────────────────────────────────────────────────────
const State = {
    profile: null,
    settings: null,
    sessions: [],
    activity: [],
    activityPage: 1,
    activityHasMore: false,
    securityAlerts: [],
    currentSessionId: null,
    loaded: { settings: false, activity: false, alerts: false },
    pinReset: { resetId: null, verified: false },
    deletion: { requestId: null, verified: false, submitting: false }
};

// ─── CANONICAL NOTIFICATION KEYS ──────────────────────────────────
const NOTIF_ITEMS = [
    { key: 'transaction_completed',   label: 'Transaction completed' },
    { key: 'deposit_received',        label: 'Deposit received' },
    { key: 'gift_order_update',       label: 'Gift card order update' },
    { key: 'marketplace_order_update',label: 'Marketplace order update' },
    { key: 'milesspace_updates',      label: 'Product updates from MilesSpace' },
    { key: 'security_alerts',         label: 'Security alerts', required: true }
];

// ─── AUTH HELPERS (delegate to /js/session.js) ────────────────────
function getCurrentUser() {
    return (typeof window.getUser === 'function') ? window.getUser() : null;
}

function redirectToLogin() {
    if (typeof window.redirectToUserLogin === 'function') {
        window.redirectToUserLogin();
    } else {
        window.location.replace('/login.html');
    }
}

// ─── API WRAPPER ──────────────────────────────────────────────────
async function apiFetch(endpoint, options = {}) {
    const fetcher = (typeof window.userFetch === 'function')
        ? window.userFetch
        : (url, o) => fetch(url, { ...o, credentials: 'include' });

    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };

    let response;
    try {
        response = await fetcher(`/api/user${endpoint}`, { ...options, headers });
    } catch (err) {
        if (err.name === 'TypeError' || /failed to fetch/i.test(err.message || '')) {
            const e = new Error('Network error. Please try again.');
            e.code = 'NETWORK_ERROR';
            throw e;
        }
        throw err;
    }

    if (response.status === 401) {
        redirectToLogin();
        const e = new Error('Session expired');
        e.code = 'SESSION_EXPIRED';
        throw e;
    }

    let data = {};
    try { data = await response.json(); } catch { /* non-JSON */ }

    if (!response.ok || data.success === false) {
        const e = new Error(data.error || data.message || `Request failed (${response.status})`);
        e.code = data.code || null;
        e.status = response.status;
        e.data = data.data || null;
        throw e;
    }
    return data;
}

// ─── HELPERS ──────────────────────────────────────────────────────
function timeAgo(date) {
    if (!date) return 'just now';
    const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return Math.floor(diff / 604800) + 'w ago';
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function showToast(message, type = 'info') {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span></span>`;
    el.querySelector('span:last-child').textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(30px)';
        el.style.transition = 'all .25s ease';
        setTimeout(() => el.remove(), 260);
    }, 3200);
}

function setLoading(btn, loading, loadingText = 'Working…') {
    if (!btn) return;
    if (loading) {
        if (!btn.dataset._original) btn.dataset._original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> ' + loadingText;
    } else {
        btn.disabled = false;
        if (btn.dataset._original) {
            btn.innerHTML = btn.dataset._original;
            delete btn.dataset._original;
        }
    }
}

function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';

    modal.querySelectorAll('input').forEach(inp => {
        if (inp.type !== 'hidden') inp.value = '';
        inp.classList.remove('error');
    });

    if (id === 'twofaModal') {
        document.getElementById('twofaSetupStep').style.display = 'block';
        document.getElementById('twofaVerifyStep').style.display = 'none';
        document.getElementById('twofaSuccessStep').style.display = 'none';
        const st = document.getElementById('twofaStatusText');
        if (st) { st.style.display = 'none'; st.textContent = ''; st.className = 'twofa-status-text'; }
    }
    if (id === 'disable2faModal') {
        const st = document.getElementById('disable2faStatus');
        if (st) { st.style.display = 'none'; st.textContent = ''; st.className = 'twofa-status-text'; }
    }
    if (id === 'pinModal') {
        const hint = document.getElementById('pinIntroHint');
        if (hint) hint.textContent = '';
        const err = document.getElementById('pinErrorText');
        if (err) { err.style.display = 'none'; err.textContent = ''; }
    }
    if (id === 'forgotPinModal') {
        State.pinReset.resetId = null;
        State.pinReset.verified = false;
        ['forgotPinStep1', 'forgotPinStep2', 'forgotPinStep3'].forEach((sid, idx) => {
            const el = document.getElementById(sid);
            if (el) el.style.display = idx === 0 ? 'block' : 'none';
        });
        const status = document.getElementById('forgotPinStatus');
        if (status) { status.style.display = 'none'; status.textContent = ''; status.className = 'twofa-status-text'; }
    }
    if (id === 'deleteAccountModal') {
        State.deletion.requestId = null;
        State.deletion.verified = false;
        State.deletion.submitting = false;
        ['delStep1', 'delStep2', 'delStep3'].forEach((sid, idx) => {
            const el = document.getElementById(sid);
            if (el) el.style.display = idx === 0 ? 'block' : 'none';
        });
        const st = document.getElementById('deleteStatus');
        if (st) { st.style.display = 'none'; st.textContent = ''; st.className = 'twofa-status-text'; }
        const confirmInput = document.getElementById('deleteConfirmInput');
        if (confirmInput) confirmInput.value = '';
    }
}

// ─── THEME ────────────────────────────────────────────────────────
function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('mx_theme'); } catch {}
    if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    updateThemeIcon();
}
function updateThemeIcon() {
    const btn = document.getElementById('darkToggle');
    if (!btn) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.textContent = isDark ? '☀️' : '🌙';
}
function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        try { localStorage.setItem('mx_theme', 'light'); } catch {}
    } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        try { localStorage.setItem('mx_theme', 'dark'); } catch {}
    }
    updateThemeIcon();
}

// ─── SECTION TOGGLE ───────────────────────────────────────────────
function toggleSection(header) {
    const body = header.nextElementSibling;
    const chevron = header.querySelector('.chevron');
    if (body) body.classList.toggle('open');
    if (chevron) chevron.classList.toggle('open');
}

// ─── LOADERS ──────────────────────────────────────────────────────
async function loadSettings() {
    try {
        const result = await apiFetch('/settings');
        const data = result.data || {};
        State.profile = data.profile || null;
        State.settings = data.settings || null;
        State.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        State.currentSessionId = data.current_session_id || null;
        State.loaded.settings = true;
        renderAll();
    } catch (err) {
        console.error('[SETTINGS] load failed:', err);
        State.loaded.settings = false;
        renderSettingsErrorStates();
        showToast('Failed to load settings: ' + err.message, 'error');
    }
}

async function loadActivity(page = 1) {
    try {
        const result = await apiFetch(`/activity?page=${page}&limit=10`);
        const items = Array.isArray(result.data) ? result.data : [];
        const meta = result.meta || {};
        State.activity = (page === 1) ? items : State.activity.concat(items);
        State.activityPage = page;
        State.activityHasMore = !!meta.has_more;
        State.loaded.activity = true;
        renderActivity();
    } catch (err) {
        State.loaded.activity = false;
        renderActivityError();
        console.warn('[SETTINGS] activity load failed:', err.message);
    }
}

async function loadAlerts() {
    try {
        const result = await apiFetch('/security-alerts');
        State.securityAlerts = Array.isArray(result.data) ? result.data : [];
        State.loaded.alerts = true;
        renderSecurityAlerts();
    } catch (err) {
        State.loaded.alerts = false;
        renderAlertsError();
        console.warn('[SETTINGS] alerts load failed:', err.message);
    }
}

// ─── RENDER ROOT ──────────────────────────────────────────────────
function renderAll() {
    renderPersonalInfo();
    renderNotifications();
    renderPinStatus();
    renderTwoFAStatus();
    renderLoginDetails();
    renderAccountStatus();
}

function renderSettingsErrorStates() {
    const s = document.getElementById('sessionsList');
    if (s) s.innerHTML = '<div class="error-state">Unable to load sessions. <button type="button" onclick="window.loadSettings()">Retry</button></div>';
    const a = document.getElementById('activityList');
    if (a) a.innerHTML = '<div class="error-state">Unable to load activity. <button type="button" onclick="window.loadActivity(1)">Retry</button></div>';
    const al = document.getElementById('alertList');
    if (al) al.innerHTML = '<div class="error-state">Unable to load security alerts. <button type="button" onclick="window.loadAlerts()">Retry</button></div>';
}

function renderPersonalInfo() {
    const p = State.profile;
    if (!p) return;
    const $ = (id) => document.getElementById(id);
    if ($('usernameDisplay')) $('usernameDisplay').textContent = p.username || 'Not set';
    if ($('emailDisplay'))    $('emailDisplay').textContent = p.email || '—';
    if ($('phoneDisplay'))    $('phoneDisplay').textContent = p.phone || 'Not set';
    if ($('referralCode'))    $('referralCode').textContent = p.referral_code || 'N/A';
    if ($('joinedDate'))      $('joinedDate').textContent = p.created_at
        ? new Date(p.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
        : '—';
}

function renderNotifications() {
    const prefs = (State.settings && State.settings.notification_preferences) || {};
    const container = document.getElementById('notifToggles');
    if (!container) return;
    container.innerHTML = NOTIF_ITEMS.map((item) => {
        const isOn = prefs[item.key] !== undefined ? !!prefs[item.key] : true;
        const disabled = item.required ? 'disabled' : '';
        return `
            <div class="notif-item">
                <span class="notif-label">
                    ${escapeHtml(item.label)}
                    ${item.required ? '<span class="required-badge">Required</span>' : ''}
                </span>
                <label class="toggle-switch">
                    <input type="checkbox"
                           class="notif-checkbox"
                           data-key="${escapeHtml(item.key)}"
                           ${isOn ? 'checked' : ''}
                           ${disabled}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
        `;
    }).join('');
}

// ═══════════════════════════════════════════════════════════════════
// PIN STATUS RENDERING — three states
// ═══════════════════════════════════════════════════════════════════
function renderPinStatus() {
    const hasPin = !!(State.profile && State.profile.has_transaction_pin);

    const banner    = document.getElementById('setupPinBanner');
    const pinRow    = document.getElementById('pinRow');
    const forgotRow = document.getElementById('forgotPinRow');
    const badge     = document.getElementById('pinStatus');
    const changeBtn = document.getElementById('changePinBtn');

    if (banner)    banner.style.display    = hasPin ? 'none' : 'flex';
    if (pinRow)    pinRow.style.display    = hasPin ? '' : 'none';
    if (forgotRow) forgotRow.style.display = hasPin ? '' : 'none';

    if (badge) {
        badge.textContent = hasPin ? '✅ Set' : '❌ Not Set';
        badge.className = `status-badge ${hasPin ? 'set' : 'not-set'}`;
    }

    if (changeBtn) changeBtn.textContent = hasPin ? 'Change PIN' : 'Set PIN';
}

function renderTwoFAStatus() {
    const enabled = !!(
        (State.settings && State.settings.email_2fa_enabled) ||
        (State.profile && State.profile.two_factor_enabled)
    );
    const el = document.getElementById('twofaStatus');
    const enableBtn = document.getElementById('enable2faBtn');
    const disableBtn = document.getElementById('disable2faBtn');
    if (!el) return;
    el.textContent = enabled ? '✅ Enabled' : '❌ Disabled';
    el.className = `status-badge ${enabled ? 'enabled' : 'disabled'}`;
    if (enableBtn)  enableBtn.style.display  = enabled ? 'none' : 'inline-flex';
    if (disableBtn) disableBtn.style.display = enabled ? 'inline-flex' : 'none';
}

function renderLoginDetails() {
    const p = State.profile || {};
    const lastLoginEl = document.getElementById('lastLoginInfo');
    if (lastLoginEl) {
        const lastLogin = p.last_login ? new Date(p.last_login).toLocaleString() : 'Never';
        lastLoginEl.innerHTML = `
            <div><strong>${escapeHtml(lastLogin)}</strong></div>
            <div style="color:var(--text-muted);">
                ${escapeHtml(p.last_login_location || 'Unknown location')}
                &nbsp;·&nbsp;
                ${escapeHtml(p.last_login_device || 'Unknown device')}
            </div>
        `;
    }

    const list = document.getElementById('sessionsList');
    if (!list) return;
    if (!State.loaded.settings) {
        list.innerHTML = '<div class="empty-state">Loading…</div>';
        return;
    }
    if (!State.sessions.length) {
        list.innerHTML = '<div class="empty-state">No active sessions</div>';
        return;
    }
    list.innerHTML = State.sessions.map((s) => {
        const isCurrent = s.session_id === State.currentSessionId;
        return `
            <div class="session-item ${isCurrent ? 'current' : ''}">
                <div class="session-info">
                    <div class="session-device">${escapeHtml(s.browser || 'Unknown')} · ${escapeHtml(s.os || 'Unknown')}</div>
                    <div class="session-detail">${escapeHtml(s.ip_address || 'Unknown IP')}</div>
                    <div class="session-detail">Last active: ${s.last_activity_at ? timeAgo(s.last_activity_at) : 'Just now'}</div>
                </div>
                <div>
                    ${isCurrent ? '<span class="current-badge">Current</span>' : ''}
                    ${!isCurrent ? `<button type="button" class="revoke-btn" data-id="${escapeHtml(s.session_id)}">Log out</button>` : ''}
                </div>
            </div>
        `;
    }).join('');

    list.querySelectorAll('.revoke-btn').forEach((btn) => {
        btn.addEventListener('click', () => revokeSession(btn.dataset.id));
    });
}

function renderActivity() {
    const list = document.getElementById('activityList');
    const moreBtn = document.getElementById('loadMoreActivityBtn');
    if (!list) return;
    if (!State.loaded.activity) {
        list.innerHTML = '<div class="empty-state">Loading…</div>';
        if (moreBtn) moreBtn.style.display = 'none';
        return;
    }
    if (!State.activity.length) {
        list.innerHTML = '<div class="empty-state">No account activity yet</div>';
        if (moreBtn) moreBtn.style.display = 'none';
        return;
    }
    list.innerHTML = State.activity.map((a) => `
        <div class="activity-item">
            <div class="activity-icon">${escapeHtml(getActivityIcon(a.activity_type))}</div>
            <div class="activity-info">
                <div class="activity-desc">${escapeHtml(a.description || a.activity_type || 'Activity')}</div>
                <div class="activity-meta">
                    <span>${timeAgo(a.created_at)}</span>
                    ${a.location ? `<span>· ${escapeHtml(a.location)}</span>` : ''}
                </div>
            </div>
        </div>
    `).join('');
    if (moreBtn) moreBtn.style.display = State.activityHasMore ? 'inline-flex' : 'none';
}

function renderActivityError() {
    const list = document.getElementById('activityList');
    if (list) list.innerHTML = '<div class="error-state">Unable to load activity. <button type="button" onclick="window.loadActivity(1)">Retry</button></div>';
}

function renderSecurityAlerts() {
    const list = document.getElementById('alertList');
    if (!list) return;
    if (!State.loaded.alerts) {
        list.innerHTML = '<div class="empty-state">Loading…</div>';
        return;
    }
    if (!State.securityAlerts.length) {
        list.innerHTML = '<div class="empty-state">No security alerts</div>';
        return;
    }
    list.innerHTML = State.securityAlerts.slice(0, 20).map((a) => `
        <div class="alert-item severity-${escapeHtml(a.severity || 'medium')} ${!a.is_read ? 'unread' : ''}">
            <div class="alert-icon">${escapeHtml(getAlertIcon(a.alert_type))}</div>
            <div class="alert-info">
                <div class="alert-desc">${escapeHtml(a.description || a.alert_type || 'Security event')}</div>
                <div class="alert-meta">
                    <span>${timeAgo(a.created_at)}</span>
                    <span class="alert-severity ${escapeHtml(a.severity || 'medium')}">${escapeHtml(a.severity || 'medium')}</span>
                </div>
            </div>
            ${!a.is_read ? `<button type="button" class="mark-read-btn" data-id="${escapeHtml(a.id)}" aria-label="Mark as read">✓</button>` : ''}
        </div>
    `).join('');
    list.querySelectorAll('.mark-read-btn').forEach((btn) => {
        btn.addEventListener('click', () => markAlertRead(btn.dataset.id));
    });
}

function renderAlertsError() {
    const list = document.getElementById('alertList');
    if (list) list.innerHTML = '<div class="error-state">Unable to load alerts. <button type="button" onclick="window.loadAlerts()">Retry</button></div>';
}

function renderAccountStatus() {
    const status = (State.profile && State.profile.status) || 'active';
    const map = {
        active:      { label: 'Active',       cls: 'success' },
        suspended:   { label: 'Suspended',    cls: 'danger' },
        restricted:  { label: 'Restricted',   cls: 'warn' },
        pending:     { label: 'Pending',      cls: 'warn' },
        deactivated: { label: 'Deactivated',  cls: 'danger' },
        deleted:     { label: 'Deleted',      cls: 'danger' }
    };
    const info = map[status] || map.active;
    const badge = document.getElementById('statusBadge');
    if (badge) {
        badge.textContent = info.label;
        badge.className = `status-badge ${info.cls}`;
    }
    const verified = !!(State.profile && State.profile.is_verified);
    const v = document.getElementById('verificationBadge');
    if (v) {
        v.textContent = verified ? '✅ Verified' : '⏳ Pending';
        v.className = `status-badge ${verified ? 'success' : 'warn'}`;
    }
}

function getActivityIcon(type) {
    const icons = {
        password_changed: '🔐',
        email_changed: '📧',
        phone_changed: '📱',
        transaction_pin_changed: '🔢',
        pin_reset_requested: '🔢',
        twofa_enabled: '🔑',
        twofa_disabled: '🔑',
        session_revoked: '🚪',
        login: '👤',
        logout: '👋',
        account_deactivated: '⚠️',
        account_reactivated: '✅',
        account_deletion_requested: '🗑️',
        account_deletion_completed: '🗑️'
    };
    return icons[type] || '•';
}

function getAlertIcon(type) {
    const icons = {
        new_login: '🔔',
        new_device: '📱',
        password_changed: '🔐',
        twofa_disabled: '⚠️',
        suspicious_activity: '🚨',
        multiple_failed_logins: '🚫',
        pin_reset: '🔢'
    };
    return icons[type] || '🛡️';
}

// ─── SESSIONS ─────────────────────────────────────────────────────
async function revokeSession(sessionId) {
    if (!confirm('Log this device out? You will need to sign in again on that device.')) return;
    try {
        await apiFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
        State.sessions = State.sessions.filter((s) => s.session_id !== sessionId);
        renderLoginDetails();
        showToast('Device logged out', 'success');
    } catch (err) {
        showToast(err.message || 'Could not revoke session', 'error');
    }
}

async function logoutAllOthers() {
    if (!confirm('Log out of every device except this one?')) return;
    const btn = document.getElementById('logoutAllBtn');
    setLoading(btn, true, 'Logging out…');
    try {
        await apiFetch('/sessions/logout-others', { method: 'POST' });
        State.sessions = State.sessions.filter((s) => s.session_id === State.currentSessionId);
        renderLoginDetails();
        showToast('Other devices signed out', 'success');
    } catch (err) {
        showToast(err.message || 'Could not sign out other devices', 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function markAlertRead(id) {
    try {
        await apiFetch(`/security-alerts/${encodeURIComponent(id)}/read`, { method: 'POST' });
        const a = State.securityAlerts.find((x) => String(x.id) === String(id));
        if (a) a.is_read = true;
        renderSecurityAlerts();
    } catch (err) {
        showToast(err.message || 'Could not mark alert', 'error');
    }
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────
async function saveNotificationPreferences() {
    const btn = document.getElementById('saveNotifBtn');
    const prefs = {};
    document.querySelectorAll('.notif-checkbox').forEach((cb) => {
        prefs[cb.dataset.key] = cb.checked;
    });
    setLoading(btn, true, 'Saving…');
    try {
        await apiFetch('/notifications', {
            method: 'PUT',
            body: JSON.stringify({ notification_preferences: prefs })
        });
        State.settings = State.settings || {};
        State.settings.notification_preferences = prefs;
        showToast('Preferences saved', 'success');
    } catch (err) {
        showToast(err.message || 'Could not save preferences', 'error');
    } finally {
        setLoading(btn, false);
    }
}

// ─── EMAIL CHANGE ─────────────────────────────────────────────────
async function sendEmailChangeOtp() {
    const emailInput = document.getElementById('newEmailInput');
    const email = (emailInput.value || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showToast('Enter a valid email address', 'error');
        emailInput.focus();
        return;
    }
    const btn = document.getElementById('sendOtpBtn');
    setLoading(btn, true, 'Sending…');
    try {
        const res = await apiFetch('/email/change-request', {
            method: 'POST',
            body: JSON.stringify({ new_email: email })
        });
        const requestId = res.data && res.data.request_id;
        if (requestId) document.getElementById('emailChangeRequestId').value = requestId;
        const otpInput = document.getElementById('otpInput');
        otpInput.disabled = false;
        document.getElementById('verifyOtpBtn').disabled = false;
        showToast('Verification code sent to ' + email, 'success');
        otpInput.focus();
    } catch (err) {
        showToast(err.message || 'Could not send code', 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function verifyEmailChange() {
    const code = (document.getElementById('otpInput').value || '').trim();
    const requestId = document.getElementById('emailChangeRequestId').value;
    if (!/^\d{6}$/.test(code)) {
        showToast('Enter the 6-digit code', 'error');
        return;
    }
    const btn = document.getElementById('verifyOtpBtn');
    setLoading(btn, true, 'Verifying…');
    try {
        await apiFetch('/email/change-verify', {
            method: 'POST',
            body: JSON.stringify({ request_id: requestId, code })
        });
        showToast('Email updated', 'success');
        closeModal('emailModal');
        await loadSettings();
    } catch (err) {
        showToast(err.message || 'Verification failed', 'error');
    } finally {
        setLoading(btn, false);
    }
}

// ─── PHONE ────────────────────────────────────────────────────────
async function savePhone() {
    const phone = (document.getElementById('newPhoneInput').value || '').trim();
    if (!phone || !/^\+?\d{7,15}$/.test(phone)) {
        showToast('Enter a valid phone number with country code', 'error');
        return;
    }
    const btn = document.getElementById('savePhoneBtn');
    setLoading(btn, true, 'Saving…');
    try {
        await apiFetch('/phone', { method: 'PUT', body: JSON.stringify({ phone }) });
        showToast('Phone updated', 'success');
        closeModal('phoneModal');
        await loadSettings();
    } catch (err) {
        showToast(err.message || 'Could not update phone', 'error');
    } finally {
        setLoading(btn, false);
    }
}

// ─── PASSWORD ─────────────────────────────────────────────────────
async function changePassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (!currentPassword || !newPassword || !confirmPassword) {
        showToast('All fields are required', 'error');
        return;
    }
    if (newPassword.length < 8) {
        showToast('New password must be at least 8 characters', 'error');
        return;
    }
    if (newPassword !== confirmPassword) {
        showToast('Passwords do not match', 'error');
        return;
    }
    const btn = document.getElementById('savePasswordBtn');
    setLoading(btn, true, 'Changing…');
    try {
        await apiFetch('/password', {
            method: 'PUT',
            body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
        });
        showToast('Password updated', 'success');
        closeModal('passwordModal');
        await loadSettings();
    } catch (err) {
        showToast(err.message || 'Could not change password', 'error');
    } finally {
        setLoading(btn, false);
    }
}

// ─── PIN (change or set for the first time) ───────────────────────
function openPinModal() {
    const hasPin = !!(State.profile && State.profile.has_transaction_pin);
    const title = document.getElementById('pinModalTitle');
    const currentWrap = document.getElementById('currentPinWrap');
    const hint = document.getElementById('pinIntroHint');
    const errBox = document.getElementById('pinErrorText');

    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }

    if (hasPin) {
        if (title) title.textContent = 'Change Transaction PIN';
        if (currentWrap) currentWrap.style.display = '';
        if (hint) hint.textContent = 'Enter your current 4-digit PIN and choose a new one.';
    } else {
        if (title) title.textContent = 'Set Transaction PIN';
        if (currentWrap) currentWrap.style.display = 'none';
        if (hint) hint.textContent = 'Choose a 4-digit PIN. You will use it to authorize payments and transactions.';
    }
    openModal('pinModal');
}

async function submitPin() {
    const hasPin = !!(State.profile && State.profile.has_transaction_pin);
    const currentPin = document.getElementById('currentPinInput').value.trim();
    const newPin = document.getElementById('newPinInput').value.trim();
    const confirmPin = document.getElementById('confirmPinInput').value.trim();
    const errBox = document.getElementById('pinErrorText');

    const setErr = (msg) => {
        if (!errBox) return;
        if (msg) { errBox.textContent = msg; errBox.style.display = 'block'; }
        else { errBox.textContent = ''; errBox.style.display = 'none'; }
    };
    setErr(null);

    if (!/^\d{4}$/.test(newPin))    { setErr('New PIN must be exactly 4 digits'); return; }
    if (newPin !== confirmPin)      { setErr('PINs do not match'); return; }

    const weak = ['0000','1111','2222','3333','4444','5555','6666','7777','8888','9999','1234','4321','1212','2121'];
    if (weak.includes(newPin)) {
        setErr('That PIN is too easy to guess. Choose a less predictable one.');
        return;
    }

    if (hasPin && !/^\d{4}$/.test(currentPin)) {
        setErr('Enter your current 4-digit PIN');
        document.getElementById('currentPinInput').focus();
        return;
    }

    const btn = document.getElementById('savePinBtn');
    setLoading(btn, true, hasPin ? 'Changing…' : 'Setting…');
    try {
        const body = { new_pin: newPin };
        if (hasPin) body.current_pin = currentPin;

        await apiFetch('/pin', { method: 'PUT', body: JSON.stringify(body) });
        showToast(hasPin ? 'PIN updated' : 'PIN set successfully', 'success');
        closeModal('pinModal');
        await loadSettings();
    } catch (err) {
        setErr(err.message || 'Could not update PIN');
    } finally {
        setLoading(btn, false);
    }
}

// ═══════════════════════════════════════════════════════════════════
// FORGOT PIN FLOW (3 steps)
// ═══════════════════════════════════════════════════════════════════
function openForgotPinModal() {
    State.pinReset.resetId = null;
    State.pinReset.verified = false;

    ['forgotPinStep1','forgotPinStep2','forgotPinStep3'].forEach((sid, idx) => {
        const el = document.getElementById(sid);
        if (el) el.style.display = idx === 0 ? 'block' : 'none';
    });
    const status = document.getElementById('forgotPinStatus');
    if (status) { status.style.display = 'none'; status.textContent = ''; status.className = 'twofa-status-text'; }

    const email = (State.profile && State.profile.email) || '';
    const emailEl = document.getElementById('forgotPinEmail');
    if (emailEl) {
        const [local, domain] = String(email).split('@');
        emailEl.textContent = domain
            ? `${local.length <= 2 ? '**' : local.slice(0, 2) + '***'}@${domain}`
            : email || 'your email';
    }

    openModal('forgotPinModal');
}

async function forgotPinSendCode() {
    const btn = document.getElementById('forgotPinSendBtn');
    const status = document.getElementById('forgotPinStatus');
    setLoading(btn, true, 'Sending…');
    try {
        const res = await apiFetch('/pin/forgot/request', { method: 'POST' });
        const resetId = (res.data && res.data.reset_id) || null;
        const masked  = (res.data && res.data.masked_email) || 'your email';
        if (!resetId) throw new Error('Server did not return reset_id');

        State.pinReset.resetId = resetId;
        State.pinReset.verified = false;

        const emailEl = document.getElementById('forgotPinEmail');
        if (emailEl) emailEl.textContent = masked;

        document.getElementById('forgotPinStep1').style.display = 'none';
        document.getElementById('forgotPinStep2').style.display = 'block';
        document.getElementById('forgotPinCodeInput').focus();
        showToast('Verification code sent to ' + masked, 'success');
    } catch (err) {
        if (status) {
            status.textContent = err.message || 'Could not send code';
            status.className = 'twofa-status-text error';
            status.style.display = 'block';
        } else {
            showToast(err.message || 'Could not send code', 'error');
        }
    } finally {
        setLoading(btn, false);
    }
}

async function forgotPinVerifyCode() {
    const code = (document.getElementById('forgotPinCodeInput').value || '').trim();
    const status = document.getElementById('forgotPinStatus');
    if (!/^\d{6}$/.test(code)) { showToast('Enter the 6-digit code', 'error'); return; }
    if (!State.pinReset.resetId) {
        showToast('Reset session expired. Please start again.', 'error');
        closeModal('forgotPinModal');
        return;
    }

    const btn = document.getElementById('forgotPinVerifyBtn');
    setLoading(btn, true, 'Verifying…');
    try {
        await apiFetch('/pin/forgot/verify', {
            method: 'POST',
            body: JSON.stringify({ reset_id: State.pinReset.resetId, code })
        });
        State.pinReset.verified = true;
        document.getElementById('forgotPinStep2').style.display = 'none';
        document.getElementById('forgotPinStep3').style.display = 'block';
        document.getElementById('forgotPinNewPin').focus();
        if (status) { status.style.display = 'none'; status.textContent = ''; }
    } catch (err) {
        if (status) {
            status.textContent = err.message || 'Verification failed';
            status.className = 'twofa-status-text error';
            status.style.display = 'block';
        } else {
            showToast(err.message || 'Verification failed', 'error');
        }
    } finally {
        setLoading(btn, false);
    }
}

async function forgotPinResetPin() {
    const newPin = (document.getElementById('forgotPinNewPin').value || '').trim();
    const confirmPin = (document.getElementById('forgotPinNewPinConfirm').value || '').trim();
    const status = document.getElementById('forgotPinStatus');

    if (!/^\d{4}$/.test(newPin))     { showToast('New PIN must be exactly 4 digits', 'error'); return; }
    if (newPin !== confirmPin)       { showToast('PINs do not match', 'error'); return; }

    const weak = ['0000','1111','2222','3333','4444','5555','6666','7777','8888','9999','1234','4321','1212','2121'];
    if (weak.includes(newPin)) { showToast('That PIN is too easy to guess. Choose a less predictable one.', 'error'); return; }

    if (!State.pinReset.resetId || !State.pinReset.verified) {
        showToast('Reset session expired. Please start again.', 'error');
        closeModal('forgotPinModal');
        return;
    }

    const btn = document.getElementById('forgotPinResetBtn');
    setLoading(btn, true, 'Resetting…');
    try {
        await apiFetch('/pin/forgot/reset', {
            method: 'POST',
            body: JSON.stringify({ reset_id: State.pinReset.resetId, new_pin: newPin })
        });
        showToast('PIN reset successful', 'success');
        closeModal('forgotPinModal');
        await loadSettings();
    } catch (err) {
        if (status) {
            status.textContent = err.message || 'Could not reset PIN';
            status.className = 'twofa-status-text error';
            status.style.display = 'block';
        } else {
            showToast(err.message || 'Could not reset PIN', 'error');
        }
    } finally {
        setLoading(btn, false);
    }
}

async function forgotPinResendCode() {
    const btn = document.getElementById('forgotPinResendBtn');
    setLoading(btn, true, 'Sending…');
    try {
        const res = await apiFetch('/pin/forgot/request', { method: 'POST' });
        const resetId = (res.data && res.data.reset_id) || null;
        const masked  = (res.data && res.data.masked_email) || 'your email';
        if (!resetId) throw new Error('Server did not return reset_id');
        State.pinReset.resetId = resetId;
        State.pinReset.verified = false;
        document.getElementById('forgotPinCodeInput').value = '';
        document.getElementById('forgotPinCodeInput').focus();
        showToast('New code sent to ' + masked, 'success');
    } catch (err) {
        showToast(err.message || 'Could not resend code', 'error');
    } finally {
        setLoading(btn, false);
    }
}

// ─── 2FA ──────────────────────────────────────────────────────────
async function start2faSetup() {
    const btn = document.getElementById('twofaSendBtn');
    setLoading(btn, true, 'Sending…');
    try {
        const res = await apiFetch('/2fa/email/setup', { method: 'POST' });
        const email = (res.data && res.data.masked_email) || (State.profile && State.profile.email) || 'your email';
        document.getElementById('twofaEmailDisplay').textContent = email;
        document.getElementById('twofaSetupStep').style.display = 'none';
        document.getElementById('twofaVerifyStep').style.display = 'block';
        document.getElementById('twofaCodeInput').focus();
    } catch (err) {
        showToast(err.message || 'Could not start 2FA setup', 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function verify2faSetup() {
    const code = (document.getElementById('twofaCodeInput').value || '').trim();
    if (!/^\d{6}$/.test(code)) { showToast('Enter the 6-digit code', 'error'); return; }
    const btn = document.getElementById('twofaVerifyBtn');
    const status = document.getElementById('twofaStatusText');
    setLoading(btn, true, 'Verifying…');
    try {
        await apiFetch('/2fa/email/verify', { method: 'POST', body: JSON.stringify({ code }) });
        document.getElementById('twofaVerifyStep').style.display = 'none';
        document.getElementById('twofaSuccessStep').style.display = 'block';
        await loadSettings();
    } catch (err) {
        status.textContent = err.message || 'Verification failed';
        status.className = 'twofa-status-text error';
        status.style.display = 'block';
    } finally {
        setLoading(btn, false);
    }
}

async function resend2fa() {
    const btn = document.getElementById('twofaResendBtn');
    setLoading(btn, true, 'Sending…');
    try {
        await apiFetch('/2fa/email/resend', { method: 'POST' });
        showToast('New code sent', 'success');
    } catch (err) {
        showToast(err.message || 'Could not resend code', 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function requestDisable2fa() {
    const btn = document.getElementById('disable2faBtn');
    setLoading(btn, true, 'Requesting…');
    try {
        await apiFetch('/2fa/email/disable/request', { method: 'POST' });
        openModal('disable2faModal');
        document.getElementById('disable2faOtpInput').focus();
    } catch (err) {
        showToast(err.message || 'Could not start disable flow', 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function confirmDisable2fa() {
    const code = (document.getElementById('disable2faOtpInput').value || '').trim();
    if (!/^\d{6}$/.test(code)) { showToast('Enter the 6-digit code', 'error'); return; }
    const btn = document.getElementById('disable2faConfirmBtn');
    const status = document.getElementById('disable2faStatus');
    setLoading(btn, true, 'Disabling…');
    try {
        await apiFetch('/2fa/email/disable/verify', { method: 'POST', body: JSON.stringify({ code }) });
        showToast('2FA disabled', 'success');
        closeModal('disable2faModal');
        await loadSettings();
    } catch (err) {
        status.textContent = err.message || 'Could not disable 2FA';
        status.className = 'twofa-status-text error';
        status.style.display = 'block';
    } finally {
        setLoading(btn, false);
    }
}

// ─── DEACTIVATE (unchanged behaviour; copy clarifies it's reversible) ──
async function deactivateAccount() {
    if (!confirm('Deactivate your account? You will be signed out everywhere. Contact support to reactivate. This is NOT the same as permanently deleting your account.')) return;
    const btn = document.getElementById('deactivateBtn');
    setLoading(btn, true, 'Deactivating…');
    try {
        await apiFetch('/deactivate', { method: 'POST' });
        showToast('Account deactivated. Signing out…', 'success');
        setTimeout(() => {
            if (typeof window.doUserLogout === 'function') window.doUserLogout();
            else window.location.replace('/login.html');
        }, 1500);
    } catch (err) {
        showToast(err.message || 'Could not deactivate account', 'error');
        setLoading(btn, false);
    }
}

// ═══════════════════════════════════════════════════════════════════
// PERMANENT ACCOUNT DELETION — 3-step wizard
// ═══════════════════════════════════════════════════════════════════
function openDeleteAccountModal() {
    State.deletion.requestId = null;
    State.deletion.verified = false;
    State.deletion.submitting = false;

    ['delStep1','delStep2','delStep3'].forEach((sid, idx) => {
        const el = document.getElementById(sid);
        if (el) el.style.display = idx === 0 ? 'block' : 'none';
    });
    const st = document.getElementById('deleteStatus');
    if (st) { st.style.display = 'none'; st.textContent = ''; st.className = 'twofa-status-text'; }
    const confirmInput = document.getElementById('deleteConfirmInput');
    if (confirmInput) confirmInput.value = '';

    openModal('deleteAccountModal');
}

async function deleteStepSendCode() {
    const btn = document.getElementById('deleteSendBtn');
    const status = document.getElementById('deleteStatus');
    setLoading(btn, true, 'Checking account…');
    try {
        const res = await apiFetch('/delete/request', { method: 'POST' });

        const requestId = (res.data && res.data.request_id) || null;
        const masked    = (res.data && res.data.masked_email) || 'your email';
        if (!requestId) throw new Error('Server did not return request_id');

        State.deletion.requestId = requestId;

        const emailEl = document.getElementById('deleteEmailDisplay');
        if (emailEl) emailEl.textContent = masked;

        document.getElementById('delStep1').style.display = 'none';
        document.getElementById('delStep2').style.display = 'block';
        document.getElementById('deleteCodeInput').focus();
        if (status) { status.style.display = 'none'; status.textContent = ''; }
    } catch (err) {
        // Show settlement blockers clearly if the server returned them.
        const blockers = (err.data && err.data.blockers) || null;
        const msg = err.message || 'Could not start deletion.';

        if (status) {
            status.textContent = blockers && blockers.length
                ? msg + ' Issues: ' + blockers.map((b) => b.label || b.code).join(', ')
                : msg;
            status.className = 'twofa-status-text error';
            status.style.display = 'block';
        } else {
            showToast(msg, 'error');
        }
    } finally {
        setLoading(btn, false);
    }
}

async function deleteStepVerifyCode() {
    const code = (document.getElementById('deleteCodeInput').value || '').trim();
    const status = document.getElementById('deleteStatus');
    if (!/^\d{6}$/.test(code)) { showToast('Enter the 6-digit code', 'error'); return; }
    if (!State.deletion.requestId) { showToast('Session expired. Start over.', 'error'); closeModal('deleteAccountModal'); return; }

    const btn = document.getElementById('deleteVerifyBtn');
    setLoading(btn, true, 'Verifying…');
    try {
        await apiFetch('/delete/verify', {
            method: 'POST',
            body: JSON.stringify({ request_id: State.deletion.requestId, code })
        });
        State.deletion.verified = true;
        document.getElementById('delStep2').style.display = 'none';
        document.getElementById('delStep3').style.display = 'block';
        document.getElementById('deleteConfirmInput').focus();
        if (status) { status.style.display = 'none'; status.textContent = ''; }
    } catch (err) {
        if (status) {
            status.textContent = err.message || 'Verification failed';
            status.className = 'twofa-status-text error';
            status.style.display = 'block';
        } else {
            showToast(err.message || 'Verification failed', 'error');
        }
    } finally {
        setLoading(btn, false);
    }
}

async function deleteStepConfirm() {
    if (State.deletion.submitting) return;

    const typed = (document.getElementById('deleteConfirmInput').value || '').trim();
    const expected = (State.profile && State.profile.username) || '';
    const status = document.getElementById('deleteStatus');

    if (!State.deletion.requestId || !State.deletion.verified) {
        if (status) {
            status.textContent = 'Session expired. Please start again.';
            status.className = 'twofa-status-text error';
            status.style.display = 'block';
        }
        return;
    }

    if (typed.toLowerCase() !== expected.toLowerCase()) {
        if (status) {
            status.textContent = `Type your username exactly (${expected}) to confirm.`;
            status.className = 'twofa-status-text error';
            status.style.display = 'block';
        }
        return;
    }

    State.deletion.submitting = true;
    const btn = document.getElementById('deleteConfirmBtn');
    setLoading(btn, true, 'Deleting…');

    try {
        await apiFetch('/delete/confirm', {
            method: 'POST',
            body: JSON.stringify({
                request_id: State.deletion.requestId,
                confirmation: typed
            })
        });

        // Clear local user state
        try {
            if (typeof window.clearUserSession === 'function') window.clearUserSession();
        } catch {}

        if (status) {
            status.textContent = 'Account deleted. Signing out…';
            status.className = 'twofa-status-text success';
            status.style.display = 'block';
        }

        setTimeout(() => {
            if (typeof window.doUserLogout === 'function') window.doUserLogout();
            else window.location.replace('/login.html');
        }, 1800);
    } catch (err) {
        State.deletion.submitting = false;
        setLoading(btn, false);
        if (status) {
            status.textContent = err.message || 'Could not delete account.';
            status.className = 'twofa-status-text error';
            status.style.display = 'block';
        }
    }
}

async function deleteStepResendCode() {
    if (!State.deletion.requestId) return;
    const btn = document.getElementById('deleteResendBtn');
    setLoading(btn, true, 'Sending…');
    try {
        const res = await apiFetch('/delete/request', { method: 'POST' });
        const requestId = (res.data && res.data.request_id) || null;
        const masked    = (res.data && res.data.masked_email) || 'your email';
        if (requestId) State.deletion.requestId = requestId;
        document.getElementById('deleteCodeInput').value = '';
        document.getElementById('deleteCodeInput').focus();
        const emailEl = document.getElementById('deleteEmailDisplay');
        if (emailEl) emailEl.textContent = masked;
        showToast('New code sent to ' + masked, 'success');
    } catch (err) {
        showToast(err.message || 'Could not resend code', 'error');
    } finally {
        setLoading(btn, false);
    }
}

// ─── EVENT BINDING ────────────────────────────────────────────────
function bindEvents() {
    document.getElementById('darkToggle')?.addEventListener('click', toggleTheme);
    document.getElementById('refreshBtn')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const icon = btn.querySelector('i') || btn;
        icon.classList.add('fa-spin');
        Promise.allSettled([loadSettings(), loadActivity(1), loadAlerts()])
            .finally(() => setTimeout(() => icon.classList.remove('fa-spin'), 400));
    });

    document.getElementById('copyReferralBtn')?.addEventListener('click', async () => {
        const code = (document.getElementById('referralCode').textContent || '').trim();
        if (!code || code === 'N/A') return;
        try {
            await navigator.clipboard.writeText(code);
            showToast('Referral code copied', 'success');
        } catch {
            showToast('Could not copy', 'error');
        }
    });

    document.querySelectorAll('.settings-card-header[data-toggle]').forEach((h) => {
        h.addEventListener('click', () => toggleSection(h));
    });

    document.getElementById('changeEmailBtn')?.addEventListener('click', () => openModal('emailModal'));
    document.getElementById('changePhoneBtn')?.addEventListener('click', () => openModal('phoneModal'));
    document.getElementById('changePasswordBtn')?.addEventListener('click', () => openModal('passwordModal'));
    document.getElementById('changePinBtn')?.addEventListener('click', openPinModal);
    document.getElementById('forgotPinBtn')?.addEventListener('click', openForgotPinModal);
    document.getElementById('setupPinBannerBtn')?.addEventListener('click', openPinModal);

    document.getElementById('enable2faBtn')?.addEventListener('click', () => {
        document.getElementById('twofaEmailDisplay').textContent = (State.profile && State.profile.email) || 'your email';
        document.getElementById('twofaSetupStep').style.display = 'block';
        document.getElementById('twofaVerifyStep').style.display = 'none';
        document.getElementById('twofaSuccessStep').style.display = 'none';
        openModal('twofaModal');
    });
    document.getElementById('disable2faBtn')?.addEventListener('click', requestDisable2fa);

    document.querySelectorAll('.modal-close[data-modal]').forEach((btn) => {
        btn.addEventListener('click', () => closeModal(btn.dataset.modal));
    });
    document.querySelectorAll('.modal-overlay').forEach((ov) => {
        ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(ov.id); });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.open').forEach((m) => closeModal(m.id));
        }
    });

    document.getElementById('sendOtpBtn')?.addEventListener('click', sendEmailChangeOtp);
    document.getElementById('verifyOtpBtn')?.addEventListener('click', verifyEmailChange);
    document.getElementById('savePhoneBtn')?.addEventListener('click', savePhone);
    document.getElementById('savePasswordBtn')?.addEventListener('click', changePassword);
    document.getElementById('savePinBtn')?.addEventListener('click', submitPin);

    document.getElementById('forgotPinSendBtn')?.addEventListener('click', forgotPinSendCode);
    document.getElementById('forgotPinVerifyBtn')?.addEventListener('click', forgotPinVerifyCode);
    document.getElementById('forgotPinResendBtn')?.addEventListener('click', forgotPinResendCode);
    document.getElementById('forgotPinResetBtn')?.addEventListener('click', forgotPinResetPin);

    document.getElementById('twofaSendBtn')?.addEventListener('click', start2faSetup);
    document.getElementById('twofaVerifyBtn')?.addEventListener('click', verify2faSetup);
    document.getElementById('twofaResendBtn')?.addEventListener('click', resend2fa);
    document.getElementById('twofaDoneBtn')?.addEventListener('click', () => closeModal('twofaModal'));
    document.getElementById('disable2faConfirmBtn')?.addEventListener('click', confirmDisable2fa);

    document.getElementById('saveNotifBtn')?.addEventListener('click', saveNotificationPreferences);
    document.getElementById('logoutAllBtn')?.addEventListener('click', logoutAllOthers);
    document.getElementById('deactivateBtn')?.addEventListener('click', deactivateAccount);
    document.getElementById('loadMoreActivityBtn')?.addEventListener('click', () => loadActivity(State.activityPage + 1));

    // Deletion
    document.getElementById('deleteAccountBtn')?.addEventListener('click', openDeleteAccountModal);
    document.getElementById('deleteSendBtn')?.addEventListener('click', deleteStepSendCode);
    document.getElementById('deleteVerifyBtn')?.addEventListener('click', deleteStepVerifyCode);
    document.getElementById('deleteResendBtn')?.addEventListener('click', deleteStepResendCode);
    document.getElementById('deleteConfirmBtn')?.addEventListener('click', deleteStepConfirm);
}

// ─── BOOT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    bindEvents();

    await new Promise((r) => setTimeout(r, 0));
    if (!getCurrentUser()) {
        setTimeout(() => { if (!getCurrentUser()) redirectToLogin(); }, 1500);
        return;
    }

    await Promise.allSettled([ loadSettings(), loadActivity(1), loadAlerts() ]);
});

// Expose for inline onclick fallbacks in error states.
window.loadSettings = loadSettings;
window.loadActivity = loadActivity;
window.loadAlerts   = loadAlerts;