// public/js/settings.js - COMPLETE FIXED VERSION
// With correct 2FA enable/disable endpoints

'use strict';

// ─── STATE ───
const SettingsState = {
    profile: null,
    settings: null,
    bankAccounts: [],
    cryptoWallets: [],
    sessions: [],
    activity: [],
    securityAlerts: [],
    loading: {
        profile: true,
        settings: true,
        banks: true,
        wallets: true,
        sessions: true,
        activity: true,
        alerts: true
    },
    currentSessionId: null,
    twofaSetupInProgress: false,
    pendingRequests: new Map()
};

// ─── DOM REFS ───
const DOM = {};

function initDOM() {
    DOM.emailDisplay = document.getElementById('emailDisplay');
    DOM.changeEmailBtn = document.getElementById('changeEmailBtn');
    DOM.phoneDisplay = document.getElementById('phoneDisplay');
    DOM.changePhoneBtn = document.getElementById('changePhoneBtn');
    DOM.referralCode = document.getElementById('referralCode');
    DOM.copyReferralBtn = document.getElementById('copyReferralBtn');
    DOM.usernameDisplay = document.getElementById('usernameDisplay');

    DOM.currentPassword = document.getElementById('currentPassword');
    DOM.newPassword = document.getElementById('newPassword');
    DOM.confirmPassword = document.getElementById('confirmPassword');
    DOM.changePasswordBtn = document.getElementById('changePasswordBtn');

    DOM.notifToggles = document.getElementById('notifToggles');
    DOM.saveNotifBtn = document.getElementById('saveNotifBtn');

    DOM.bankList = document.getElementById('bankList');
    DOM.addBankBtn = document.getElementById('addBankBtn');

    DOM.walletList = document.getElementById('walletList');
    DOM.addWalletBtn = document.getElementById('addWalletBtn');

    DOM.pinStatus = document.getElementById('pinStatus');
    DOM.changePinBtn = document.getElementById('changePinBtn');
    DOM.resetPinBtn = document.getElementById('resetPinBtn');

    DOM.twofaStatus = document.getElementById('twofaStatus');
    DOM.enable2faBtn = document.getElementById('enable2faBtn');
    DOM.disable2faBtn = document.getElementById('disable2faBtn');

    DOM.lastLoginInfo = document.getElementById('lastLoginInfo');
    DOM.sessionsList = document.getElementById('sessionsList');
    DOM.logoutAllBtn = document.getElementById('logoutAllBtn');

    DOM.activityList = document.getElementById('activityList');
    DOM.loadMoreActivityBtn = document.getElementById('loadMoreActivityBtn');

    DOM.alertList = document.getElementById('alertList');
    DOM.statusBadge = document.getElementById('statusBadge');
    DOM.deactivateBtn = document.getElementById('deactivateBtn');

    // ─── Email 2FA Modal ──────────────────────────────────────
    DOM.twofaModal = document.getElementById('twofaModal');
    DOM.twofaEmailDisplay = document.getElementById('twofaEmailDisplay');
    DOM.twofaSendBtn = document.getElementById('twofaSendBtn');
    DOM.twofaCodeInput = document.getElementById('twofaCodeInput');
    DOM.twofaVerifyBtn = document.getElementById('twofaVerifyBtn');
    DOM.twofaCancelBtn = document.getElementById('twofaCancelBtn');
    DOM.twofaStatusText = document.getElementById('twofaStatusText');
    DOM.twofaSetupStep = document.getElementById('twofaSetupStep');
    DOM.twofaVerifyStep = document.getElementById('twofaVerifyStep');
    DOM.twofaSuccessStep = document.getElementById('twofaSuccessStep');

    // ─── Disable 2FA Modal ──────────────────────────────────────
    DOM.disable2faModal = document.getElementById('disable2faModal');
    DOM.disable2faOtpInput = document.getElementById('disable2faOtpInput');
    DOM.disable2faConfirmBtn = document.getElementById('disable2faConfirmBtn');
    DOM.disable2faCancelBtn = document.getElementById('disable2faCancelBtn');
    DOM.disable2faStatus = document.getElementById('disable2faStatus');
    
    // ─── PIN Modal ──────────────────────────────────────────────
    DOM.pinModal = document.getElementById('pinModal');
    DOM.currentPinInput = document.getElementById('currentPinInput');
    DOM.newPinInput = document.getElementById('newPinInput');
    DOM.confirmPinInput = document.getElementById('confirmPinInput');
    DOM.savePinBtn = document.getElementById('savePinBtn');
    
    // ─── Email Modal ────────────────────────────────────────────
    DOM.emailModal = document.getElementById('emailModal');
    DOM.newEmailInput = document.getElementById('newEmailInput');
    DOM.sendOtpBtn = document.getElementById('sendOtpBtn');
    DOM.otpInput = document.getElementById('otpInput');
    DOM.verifyOtpBtn = document.getElementById('verifyOtpBtn');
    DOM.emailChangeRequestId = document.getElementById('emailChangeRequestId');
    
    // ─── Phone Modal ────────────────────────────────────────────
    DOM.phoneModal = document.getElementById('phoneModal');
    DOM.newPhoneInput = document.getElementById('newPhoneInput');
    DOM.savePhoneBtn = document.getElementById('savePhoneBtn');
    
    // ─── Bank Modal ─────────────────────────────────────────────
    DOM.bankModal = document.getElementById('bankModal');
    DOM.bankNameInput = document.getElementById('bankNameInput');
    DOM.bankCodeInput = document.getElementById('bankCodeInput');
    DOM.accountNumberInput = document.getElementById('accountNumberInput');
    DOM.accountNameInput = document.getElementById('accountNameInput');
    DOM.saveBankBtn = document.getElementById('saveBankBtn');
    
    // ─── Wallet Modal ────────────────────────────────────────────
    DOM.walletModal = document.getElementById('walletModal');
    DOM.walletCoinInput = document.getElementById('walletCoinInput');
    DOM.walletNetworkInput = document.getElementById('walletNetworkInput');
    DOM.walletAddressInput = document.getElementById('walletAddressInput');
    DOM.walletLabelInput = document.getElementById('walletLabelInput');
    DOM.saveWalletBtn = document.getElementById('saveWalletBtn');
}

// ─── GET USER TOKEN ───
function getUserToken() {
    try {
        const session = localStorage.getItem('mx_sess') || sessionStorage.getItem('mx_sess');
        if (!session) return null;
        const data = JSON.parse(session);
        return data?.token || data?.access_token || null;
    } catch (e) {
        return null;
    }
}

function getRefreshToken() {
    try {
        const session = localStorage.getItem('mx_sess') || sessionStorage.getItem('mx_sess');
        if (!session) return null;
        const data = JSON.parse(session);
        return data?.refreshToken || null;
    } catch (e) {
        return null;
    }
}

function getSessionData() {
    try {
        const session = localStorage.getItem('mx_sess') || sessionStorage.getItem('mx_sess');
        if (!session) return null;
        return JSON.parse(session);
    } catch (e) {
        return null;
    }
}

function saveUserSession(token, user, refreshToken, sessionId) {
    const data = {
        token: token,
        access_token: token,
        refreshToken: refreshToken || null,
        user: user,
        sessionId: sessionId || null,
        loggedAt: Date.now()
    };
    localStorage.setItem('mx_sess', JSON.stringify(data));
    sessionStorage.setItem('mx_sess', JSON.stringify(data));
}

function clearUserSession() {
    localStorage.removeItem('mx_sess');
    sessionStorage.removeItem('mx_sess');
    localStorage.removeItem('miles_token');
    localStorage.removeItem('miles_user');
}

function redirectToUserLogin() {
    clearUserSession();
    window.location.href = '/signup';
}

// ─── API FUNCTIONS WITH DEDUPLICATION ──────────────────────────

async function settingsApiFetch(endpoint, options = {}) {
    const token = getUserToken();
    if (!token) {
        console.error('❌ No user token found, redirecting to login');
        redirectToUserLogin();
        throw new Error('Not authenticated');
    }

    const method = options.method || 'GET';
    const bodyKey = options.body ? JSON.stringify(options.body) : '';
    const requestKey = `${method}:${endpoint}:${bodyKey}`;
    
    if (SettingsState.pendingRequests.has(requestKey)) {
        console.log(`⏳ Request already in progress: ${requestKey}`);
        return SettingsState.pendingRequests.get(requestKey);
    }

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options.headers
    };

    const promise = (async () => {
        try {
            const response = await fetch(`/api/user${endpoint}`, { ...options, headers });

            if (response.status === 401 || response.status === 403) {
                const refreshToken = getRefreshToken();
                if (refreshToken) {
                    try {
                        const refreshResponse = await fetch('/api/auth/refresh', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ refresh_token: refreshToken })
                        });
                        
                        if (refreshResponse.ok) {
                            const refreshData = await refreshResponse.json();
                            if (refreshData.success && refreshData.data?.access_token) {
                                const session = getSessionData();
                                saveUserSession(
                                    refreshData.data.access_token,
                                    session?.user,
                                    refreshData.data.refresh_token,
                                    session?.sessionId
                                );
                                headers['Authorization'] = `Bearer ${refreshData.data.access_token}`;
                                const retryResponse = await fetch(`/api/user${endpoint}`, { ...options, headers });
                                if (retryResponse.ok) {
                                    const retryData = await retryResponse.json();
                                    return retryData;
                                }
                            }
                        }
                    } catch (refreshError) {
                        console.warn('Token refresh failed:', refreshError);
                    }
                }
                const data = await response.json();
                throw new Error(data.error || 'Session expired');
            }

            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'Request failed');
            }
            return data;
        } finally {
            SettingsState.pendingRequests.delete(requestKey);
        }
    })();

    SettingsState.pendingRequests.set(requestKey, promise);
    return promise;
}

// ─── LOAD SETTINGS ──────────────────────────────────────────────

async function loadSettings() {
    try {
        console.log('🔄 Loading user settings...');
        const result = await settingsApiFetch('/settings');
        const data = result.data;

        SettingsState.profile = data.profile;
        SettingsState.settings = data.settings;
        SettingsState.bankAccounts = data.bank_accounts || [];
        SettingsState.cryptoWallets = data.crypto_wallets || [];
        SettingsState.sessions = data.sessions || [];
        SettingsState.activity = data.activity || [];
        SettingsState.securityAlerts = data.security_alerts || [];
        SettingsState.currentSessionId = data.current_session_id;

        renderPersonalInfo();
        renderNotificationPreferences();
        renderBankAccounts();
        renderCryptoWallets();
        renderTransactionPinStatus();
        renderTwoFAStatus();
        renderLoginDetails();
        renderActivity();
        renderSecurityAlerts();
        renderAccountStatus();

        showToast('Settings loaded successfully', 'success');
    } catch (error) {
        console.error('Load settings error:', error);
        if (error.message === 'Not authenticated' || error.message === 'Session expired') {
            redirectToUserLogin();
        } else {
            showToast('Failed to load settings: ' + error.message, 'error');
        }
    }
}

// ─── RENDER FUNCTIONS ──────────────────────────────────────────

function renderPersonalInfo() {
    const profile = SettingsState.profile;
    if (!profile) return;

    DOM.usernameDisplay.textContent = profile.username || 'Not set';
    DOM.emailDisplay.textContent = profile.email;
    DOM.phoneDisplay.textContent = profile.phone || 'Not set';
    DOM.referralCode.textContent = profile.referral_code || 'N/A';
}

function renderNotificationPreferences() {
    const prefs = SettingsState.settings?.notification_preferences || {};
    const toggles = DOM.notifToggles;

    const items = [
        { key: 'transaction_completed', label: 'Transaction completed' },
        { key: 'deposit_received', label: 'Deposit received' },
        { key: 'withdrawal_completed', label: 'Withdrawal completed' },
        { key: 'crypto_purchase_completed', label: 'Crypto purchase completed' },
        { key: 'gift_order_update', label: 'Gift card order update' },
        { key: 'marketplace_order_update', label: 'Marketplace order update' },
        { key: 'security_alerts', label: 'Security alerts', required: true },
        { key: 'milesspace_updates', label: 'MilesSpace updates', required: true }
    ];

    toggles.innerHTML = items.map(item => {
        const isOn = prefs[item.key] !== undefined ? prefs[item.key] : true;
        const disabled = item.required ? 'disabled' : '';
        return `
            <div class="notif-item">
                <span class="notif-label">${escapeHtml(item.label)} ${item.required ? '<span class="required-badge">Required</span>' : ''}</span>
                <label class="toggle-switch">
                    <input type="checkbox" class="notif-checkbox" data-key="${escapeHtml(item.key)}" ${isOn ? 'checked' : ''} ${disabled}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
        `;
    }).join('');
}

function renderBankAccounts() {
    const list = DOM.bankList;
    const accounts = SettingsState.bankAccounts;

    if (!accounts || accounts.length === 0) {
        list.innerHTML = `<div class="empty-state">No bank accounts saved</div>`;
        return;
    }

    list.innerHTML = accounts.map(acc => `
        <div class="saved-item">
            <div class="item-icon">🏦</div>
            <div class="item-info">
                <div class="item-name">${escapeHtml(acc.bank_name)}</div>
                <div class="item-detail">Account: ${escapeHtml(acc.account_number)}</div>
                <div class="item-detail">${escapeHtml(acc.account_name)}</div>
                <div class="item-status ${acc.verified ? 'verified' : 'unverified'}">
                    ${acc.verified ? '✅ Verified' : '⏳ Pending'}
                </div>
            </div>
            <button class="remove-btn" data-id="${escapeHtml(acc.id)}" data-type="bank">✕</button>
        </div>
    `).join('');

    list.querySelectorAll('.remove-btn[data-type="bank"]').forEach(btn => {
        btn.addEventListener('click', () => removeBankAccount(btn.dataset.id));
    });
}

function renderCryptoWallets() {
    const list = DOM.walletList;
    const wallets = SettingsState.cryptoWallets;

    if (!wallets || wallets.length === 0) {
        list.innerHTML = `<div class="empty-state">No crypto wallets saved</div>`;
        return;
    }

    list.innerHTML = wallets.map(w => `
        <div class="saved-item">
            <div class="item-icon">₿</div>
            <div class="item-info">
                <div class="item-name">${escapeHtml(w.coin)} · ${escapeHtml(w.network || 'N/A')}</div>
                <div class="item-detail">${escapeHtml(w.address)}</div>
                ${w.label ? `<div class="item-detail">${escapeHtml(w.label)}</div>` : ''}
            </div>
            <button class="remove-btn" data-id="${escapeHtml(w.id)}" data-type="wallet">✕</button>
        </div>
    `).join('');

    list.querySelectorAll('.remove-btn[data-type="wallet"]').forEach(btn => {
        btn.addEventListener('click', () => removeCryptoWallet(btn.dataset.id));
    });
}

function renderTransactionPinStatus() {
    const hasPin = SettingsState.profile?.has_transaction_pin === true;
    
    DOM.pinStatus.textContent = hasPin ? '✅ Set' : '❌ Not Set';
    DOM.pinStatus.className = `status-badge ${hasPin ? 'set' : 'not-set'}`;
}

function renderTwoFAStatus() {
    const enabled = SettingsState.settings?.email_2fa_enabled || false;
    
    DOM.twofaStatus.textContent = enabled ? '✅ Enabled' : '❌ Disabled';
    DOM.twofaStatus.className = `status-badge ${enabled ? 'enabled' : 'disabled'}`;
    DOM.enable2faBtn.style.display = enabled ? 'none' : 'inline-block';
    DOM.disable2faBtn.style.display = enabled ? 'inline-block' : 'none';
}

function renderLoginDetails() {
    const profile = SettingsState.profile;
    if (profile) {
        const lastLogin = profile.last_login ? new Date(profile.last_login).toLocaleString() : 'Never';
        DOM.lastLoginInfo.innerHTML = `
            <div><strong>Last Login:</strong> ${escapeHtml(lastLogin)}</div>
            <div><strong>Location:</strong> ${escapeHtml(profile.last_login_location || 'Unknown')}</div>
            <div><strong>Device:</strong> ${escapeHtml(profile.last_login_device || 'Unknown')} · ${escapeHtml(profile.last_login_browser || 'Unknown')}</div>
        `;
    }

    const sessions = SettingsState.sessions;
    if (!sessions || sessions.length === 0) {
        DOM.sessionsList.innerHTML = `<div class="empty-state">No active sessions</div>`;
        return;
    }

    DOM.sessionsList.innerHTML = sessions.map(s => {
        const isCurrent = s.session_id === SettingsState.currentSessionId;
        const parsed = parseUserAgent(s);
        return `
            <div class="session-item ${isCurrent ? 'current' : ''}">
                <div class="session-info">
                    <div class="session-device">${escapeHtml(parsed.device || 'Unknown')} · ${escapeHtml(parsed.browser || 'Unknown')}</div>
                    <div class="session-detail">${escapeHtml(s.ip_address || 'Unknown Location')}</div>
                    <div class="session-detail">Last active: ${s.last_activity_at ? timeAgo(s.last_activity_at) : 'Just now'}</div>
                </div>
                <div class="session-status">
                    ${isCurrent ? '<span class="current-badge">Current</span>' : ''}
                    ${!isCurrent ? `<button class="revoke-btn" data-id="${escapeHtml(s.session_id)}">Log Out</button>` : ''}
                </div>
            </div>
        `;
    }).join('');

    DOM.sessionsList.querySelectorAll('.revoke-btn').forEach(btn => {
        btn.addEventListener('click', () => revokeSession(btn.dataset.id));
    });
}

function renderActivity() {
    const activities = SettingsState.activity;
    if (!activities || activities.length === 0) {
        DOM.activityList.innerHTML = `<div class="empty-state">No account activity</div>`;
        return;
    }

    DOM.activityList.innerHTML = activities.slice(0, 10).map(a => {
        const parsed = a.user_agent ? parseUserAgent(a.user_agent) : null;
        return `
            <div class="activity-item">
                <div class="activity-icon">${getActivityIcon(a.activity_type)}</div>
                <div class="activity-info">
                    <div class="activity-desc">${escapeHtml(a.description || a.activity_type)}</div>
                    <div class="activity-meta">
                        <span>${timeAgo(a.created_at)}</span>
                        ${a.location ? `<span>· ${escapeHtml(a.location)}</span>` : ''}
                        ${parsed ? `<span>· ${escapeHtml(parsed.device)} · ${escapeHtml(parsed.browser)}</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    const hasMore = activities.length > 10;
    DOM.loadMoreActivityBtn.style.display = hasMore ? 'inline-block' : 'none';
}

function renderSecurityAlerts() {
    const alerts = SettingsState.securityAlerts;
    if (!alerts || alerts.length === 0) {
        DOM.alertList.innerHTML = `<div class="empty-state">No security alerts</div>`;
        return;
    }

    DOM.alertList.innerHTML = alerts.slice(0, 10).map(a => `
        <div class="alert-item severity-${escapeHtml(a.severity || 'medium')} ${!a.is_read ? 'unread' : ''}">
            <div class="alert-icon">${getAlertIcon(a.alert_type)}</div>
            <div class="alert-info">
                <div class="alert-desc">${escapeHtml(a.description || a.alert_type)}</div>
                <div class="alert-meta">
                    <span>${timeAgo(a.created_at)}</span>
                    <span class="alert-severity ${escapeHtml(a.severity || 'medium')}">${escapeHtml(a.severity || 'medium')}</span>
                </div>
            </div>
            ${!a.is_read ? `<button class="mark-read-btn" data-id="${escapeHtml(a.id)}">✓</button>` : ''}
        </div>
    `).join('');

    DOM.alertList.querySelectorAll('.mark-read-btn').forEach(btn => {
        btn.addEventListener('click', () => markAlertRead(btn.dataset.id));
    });
}

function renderAccountStatus() {
    const status = SettingsState.profile?.status || 'active';
    const statusMap = {
        'active': { label: 'Active', class: 'active' },
        'suspended': { label: 'Suspended', class: 'suspended' },
        'restricted': { label: 'Restricted', class: 'restricted' },
        'pending': { label: 'Pending Verification', class: 'pending' }
    };
    const info = statusMap[status] || statusMap.active;
    DOM.statusBadge.textContent = info.label;
    DOM.statusBadge.className = `status-badge ${info.class}`;
}

// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───
//  ─── 2FA FUNCTIONS - CORRECT ENDPOINTS ──────────────────────
// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───

let enable2faInProgress = false;
let disable2faInProgress = false;

// ─── ENABLE 2FA - Step 1: Request OTP ────────────────────────────
async function enableTwoFA() {
    if (enable2faInProgress) {
        console.log('⏳ 2FA enable already in progress');
        return;
    }
    enable2faInProgress = true;

    try {
        DOM.enable2faBtn.disabled = true;
        DOM.enable2faBtn.textContent = 'Setting up...';

        // ✅ CORRECT endpoint: /2fa/email/setup
        const result = await settingsApiFetch('/2fa/email/setup', {
            method: 'POST'
        });

        DOM.twofaEmailDisplay.textContent = result.data.email || SettingsState.profile?.email || 'your email';
        DOM.twofaSetupStep.style.display = 'block';
        DOM.twofaVerifyStep.style.display = 'none';
        DOM.twofaSuccessStep.style.display = 'none';
        DOM.twofaCodeInput.value = '';
        DOM.twofaStatusText.textContent = '';
        DOM.twofaStatusText.className = '';

        openModal('twofaModal');
        showToast('Verification code sent to your email', 'success');

    } catch (error) {
        console.error('2FA setup error:', error);
        showToast('Failed to setup 2FA: ' + error.message, 'error');
    } finally {
        DOM.enable2faBtn.disabled = false;
        DOM.enable2faBtn.textContent = 'Enable 2FA';
        enable2faInProgress = false;
    }
}

// ─── ENABLE 2FA - Step 2: Verify OTP ──────────────────────────────
async function verifyTwoFAEnable() {
    const code = DOM.twofaCodeInput.value.trim();

    if (!code) {
        showToast('Please enter the verification code', 'warning');
        return;
    }

    if (!/^\d{6}$/.test(code)) {
        showToast('Please enter the 6-digit verification code', 'warning');
        return;
    }

    try {
        DOM.twofaVerifyBtn.disabled = true;
        DOM.twofaVerifyBtn.textContent = 'Verifying...';
        DOM.twofaStatusText.textContent = 'Verifying...';
        DOM.twofaStatusText.className = 'info';

        // ✅ CORRECT endpoint: /2fa/email/verify
        await settingsApiFetch('/2fa/email/verify', {
            method: 'POST',
            body: JSON.stringify({ otp: code })
        });

        DOM.twofaSetupStep.style.display = 'none';
        DOM.twofaVerifyStep.style.display = 'none';
        DOM.twofaSuccessStep.style.display = 'block';

        showToast('2FA enabled successfully!', 'success');

        setTimeout(() => {
            closeModal('twofaModal');
            loadSettings();
        }, 2000);

    } catch (error) {
        console.error('2FA verify error:', error);
        DOM.twofaStatusText.textContent = error.message || 'Verification failed. Please try again.';
        DOM.twofaStatusText.className = 'error';
        showToast('Verification failed: ' + error.message, 'error');
    } finally {
        DOM.twofaVerifyBtn.disabled = false;
        DOM.twofaVerifyBtn.textContent = 'Verify & Enable';
    }
}

// ─── DISABLE 2FA - Step 1: Request OTP ────────────────────────────
async function disableTwoFA() {
    if (disable2faInProgress) {
        console.log('⏳ 2FA disable already in progress');
        return;
    }
    disable2faInProgress = true;

    try {
        DOM.disable2faBtn.disabled = true;
        DOM.disable2faBtn.textContent = 'Requesting code...';

        // ✅ CORRECT endpoint: /2fa/email/disable/request
        const result = await settingsApiFetch('/2fa/email/disable/request', {
            method: 'POST'
        });

        // Show disable modal with OTP input
        DOM.disable2faOtpInput.value = '';
        DOM.disable2faStatus.textContent = 'A verification code has been sent to your email.';
        DOM.disable2faStatus.className = 'info';
        openModal('disable2faModal');

        showToast('Verification code sent to your email', 'success');

    } catch (error) {
        console.error('2FA disable request error:', error);
        showToast('Failed to request 2FA disable: ' + error.message, 'error');
    } finally {
        DOM.disable2faBtn.disabled = false;
        DOM.disable2faBtn.textContent = 'Disable 2FA';
        disable2faInProgress = false;
    }
}

// ─── DISABLE 2FA - Step 2: Verify OTP and Disable ─────────────────
async function verifyTwoFADisable() {
    const otp = DOM.disable2faOtpInput.value.trim();

    if (!otp) {
        showToast('Please enter the verification code', 'warning');
        return;
    }

    if (!/^\d{6}$/.test(otp)) {
        showToast('Please enter the 6-digit verification code', 'warning');
        return;
    }

    try {
        DOM.disable2faConfirmBtn.disabled = true;
        DOM.disable2faConfirmBtn.textContent = 'Disabling...';
        DOM.disable2faStatus.textContent = 'Verifying...';
        DOM.disable2faStatus.className = 'info';

        // ✅ CORRECT endpoint: /2fa/email/disable/verify
        await settingsApiFetch('/2fa/email/disable/verify', {
            method: 'POST',
            body: JSON.stringify({ otp })
        });

        showToast('2FA disabled successfully', 'success');
        closeModal('disable2faModal');
        loadSettings();

    } catch (error) {
        console.error('2FA disable verify error:', error);
        DOM.disable2faStatus.textContent = error.message || 'Failed to disable 2FA';
        DOM.disable2faStatus.className = 'error';
        showToast('Failed to disable 2FA: ' + error.message, 'error');
    } finally {
        DOM.disable2faConfirmBtn.disabled = false;
        DOM.disable2faConfirmBtn.textContent = 'Disable 2FA';
    }
}

// ─── RESEND 2FA OTP ────────────────────────────────────────────────
async function resendTwoFACode() {
    try {
        DOM.twofaSendBtn.disabled = true;
        DOM.twofaSendBtn.textContent = 'Sending...';

        // ✅ CORRECT endpoint: /2fa/email/resend
        await settingsApiFetch('/2fa/email/resend', {
            method: 'POST'
        });

        showToast('A new verification code has been sent to your email', 'success');
        DOM.twofaStatusText.textContent = 'Code sent! Check your email.';
        DOM.twofaStatusText.className = 'info';

    } catch (error) {
        showToast('Failed to send code: ' + error.message, 'error');
        DOM.twofaStatusText.textContent = 'Failed to send code. Please try again.';
        DOM.twofaStatusText.className = 'error';
    } finally {
        DOM.twofaSendBtn.disabled = false;
        DOM.twofaSendBtn.textContent = 'Resend Code';
    }
}

// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───
//  ─── OTHER SETTINGS FUNCTIONS ────────────────────────────────
// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───

// ─── TRANSACTION PIN ──────────────────────────────────────────────

async function changeTransactionPin() {
    const current = DOM.currentPinInput?.value || '';
    const newPin = DOM.newPinInput?.value || '';
    const confirm = DOM.confirmPinInput?.value || '';

    if (!current || !newPin || !confirm) {
        showToast('All PIN fields are required', 'warning');
        return;
    }

    if (!/^\d{4}$/.test(newPin)) {
        showToast('PIN must be 4 digits', 'warning');
        return;
    }

    if (newPin !== confirm) {
        showToast('PINs do not match', 'warning');
        return;
    }

    const commonPins = ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321'];
    if (commonPins.includes(newPin)) {
        showToast('PIN is too common. Please choose a different one.', 'warning');
        return;
    }

    try {
        DOM.savePinBtn.disabled = true;
        DOM.savePinBtn.textContent = 'Changing...';

        await settingsApiFetch('/transaction-pin/change', {
            method: 'POST',
            body: JSON.stringify({
                current_pin: current,
                new_pin: newPin,
                confirm_pin: confirm
            })
        });

        showToast('Transaction PIN changed successfully!', 'success');
        closeModal('pinModal');
        loadSettings();

    } catch (error) {
        showToast('Failed to change PIN: ' + error.message, 'error');
    } finally {
        DOM.savePinBtn.disabled = false;
        DOM.savePinBtn.textContent = 'Change PIN';
    }
}

// ─── FORGOT PIN ────────────────────────────────────────────────────

async function resetTransactionPin() {
    try {
        DOM.resetPinBtn.disabled = true;
        DOM.resetPinBtn.textContent = 'Sending...';

        await settingsApiFetch('/transaction-pin/reset/request', {
            method: 'POST'
        });

        showToast('A reset code has been sent to your email', 'success');

        const otp = prompt('Enter the 6-digit reset code sent to your email:');
        if (!otp) {
            DOM.resetPinBtn.disabled = false;
            DOM.resetPinBtn.textContent = 'Forgot PIN?';
            return;
        }

        const newPin = prompt('Enter your new 4-digit PIN:');
        if (!newPin || !/^\d{4}$/.test(newPin)) {
            showToast('PIN must be 4 digits', 'warning');
            DOM.resetPinBtn.disabled = false;
            DOM.resetPinBtn.textContent = 'Forgot PIN?';
            return;
        }

        const confirmPin = prompt('Confirm your new 4-digit PIN:');
        if (newPin !== confirmPin) {
            showToast('PINs do not match', 'warning');
            DOM.resetPinBtn.disabled = false;
            DOM.resetPinBtn.textContent = 'Forgot PIN?';
            return;
        }

        await settingsApiFetch('/transaction-pin/reset', {
            method: 'POST',
            body: JSON.stringify({
                otp: otp,
                new_pin: newPin,
                confirm_pin: confirmPin
            })
        });

        showToast('PIN reset successfully!', 'success');
        loadSettings();

    } catch (error) {
        showToast('Failed to reset PIN: ' + error.message, 'error');
    } finally {
        DOM.resetPinBtn.disabled = false;
        DOM.resetPinBtn.textContent = 'Forgot PIN?';
    }
}

// ─── DEACTIVATE ACCOUNT ────────────────────────────────────────────

async function deactivateAccount() {
    const password = prompt('Enter your password to deactivate your account:');
    if (!password) return;

    const confirm = prompt('Type "DEACTIVATE" to confirm account deactivation:');
    if (confirm !== 'DEACTIVATE') {
        showToast('Confirmation failed. Type "DEACTIVATE" to confirm.', 'warning');
        return;
    }

    try {
        DOM.deactivateBtn.disabled = true;
        DOM.deactivateBtn.textContent = 'Processing...';

        await settingsApiFetch('/deactivate', {
            method: 'POST',
            body: JSON.stringify({ password, confirm })
        });

        showToast('Account deactivated successfully', 'success');
        clearUserSession();
        window.location.href = '/';

    } catch (error) {
        showToast('Failed to deactivate account: ' + error.message, 'error');
        DOM.deactivateBtn.disabled = false;
        DOM.deactivateBtn.textContent = 'Deactivate Account';
    }
}

// ─── CHANGE EMAIL ──────────────────────────────────────────────────

async function changeEmail() {
    const newEmail = DOM.newEmailInput?.value?.trim() || '';
    if (!newEmail) {
        showToast('Please enter a new email address', 'warning');
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
        showToast('Please enter a valid email address', 'warning');
        return;
    }

    try {
        DOM.sendOtpBtn.disabled = true;
        DOM.sendOtpBtn.textContent = 'Sending...';

        const result = await settingsApiFetch('/email/change/request', {
            method: 'POST',
            body: JSON.stringify({ new_email: newEmail })
        });

        DOM.emailChangeRequestId.value = result.data.request_id;
        DOM.otpInput.disabled = false;
        DOM.verifyOtpBtn.disabled = false;
        DOM.sendOtpBtn.textContent = '✅ Code Sent';
        showToast('Verification code sent to your current email', 'success');

    } catch (error) {
        showToast('Failed to send verification code: ' + error.message, 'error');
        DOM.sendOtpBtn.textContent = 'Resend Code';
        DOM.sendOtpBtn.disabled = false;
    }
}

async function verifyEmailChange() {
    const requestId = DOM.emailChangeRequestId?.value || '';
    const otp = DOM.otpInput?.value?.trim() || '';

    if (!requestId || !otp) {
        showToast('Please enter the verification code', 'warning');
        return;
    }

    try {
        DOM.verifyOtpBtn.disabled = true;
        DOM.verifyOtpBtn.textContent = 'Verifying...';

        await settingsApiFetch('/email/change/verify', {
            method: 'POST',
            body: JSON.stringify({ request_id: requestId, otp })
        });

        showToast('Email changed successfully!', 'success');
        closeModal('emailModal');
        loadSettings();

    } catch (error) {
        showToast('Verification failed: ' + error.message, 'error');
        DOM.verifyOtpBtn.disabled = false;
        DOM.verifyOtpBtn.textContent = 'Verify Code';
    }
}

// ─── CHANGE PHONE ──────────────────────────────────────────────────

async function changePhone() {
    const phone = DOM.newPhoneInput?.value?.trim() || '';
    if (!phone) {
        showToast('Please enter a phone number', 'warning');
        return;
    }

    try {
        DOM.savePhoneBtn.disabled = true;
        DOM.savePhoneBtn.textContent = 'Saving...';

        await settingsApiFetch('/profile/phone', {
            method: 'PATCH',
            body: JSON.stringify({ phone })
        });

        showToast('Phone number updated successfully!', 'success');
        closeModal('phoneModal');
        loadSettings();

    } catch (error) {
        showToast('Failed to update phone: ' + error.message, 'error');
        DOM.savePhoneBtn.disabled = false;
        DOM.savePhoneBtn.textContent = 'Save Phone';
    }
}

// ─── CHANGE PASSWORD ──────────────────────────────────────────────

async function changePassword() {
    const current = DOM.currentPassword?.value || '';
    const newPass = DOM.newPassword?.value || '';
    const confirm = DOM.confirmPassword?.value || '';

    if (!current || !newPass || !confirm) {
        showToast('All password fields are required', 'warning');
        return;
    }

    if (newPass !== confirm) {
        showToast('New passwords do not match', 'warning');
        return;
    }

    if (newPass.length < 8) {
        showToast('Password must be at least 8 characters', 'warning');
        return;
    }

    try {
        DOM.changePasswordBtn.disabled = true;
        DOM.changePasswordBtn.textContent = 'Changing...';

        await settingsApiFetch('/password/change', {
            method: 'POST',
            body: JSON.stringify({
                current_password: current,
                new_password: newPass,
                confirm_password: confirm
            })
        });

        showToast('Password changed successfully!', 'success');
        DOM.currentPassword.value = '';
        DOM.newPassword.value = '';
        DOM.confirmPassword.value = '';

    } catch (error) {
        showToast('Failed to change password: ' + error.message, 'error');
    } finally {
        DOM.changePasswordBtn.disabled = false;
        DOM.changePasswordBtn.textContent = 'Change Password';
    }
}

// ─── NOTIFICATION PREFERENCES ──────────────────────────────────────

async function saveNotificationPreferences() {
    const checkboxes = DOM.notifToggles?.querySelectorAll('.notif-checkbox') || [];
    const preferences = {};

    checkboxes.forEach(cb => {
        preferences[cb.dataset.key] = cb.checked;
    });

    try {
        DOM.saveNotifBtn.disabled = true;
        DOM.saveNotifBtn.textContent = 'Saving...';

        await settingsApiFetch('/notifications', {
            method: 'PATCH',
            body: JSON.stringify(preferences)
        });

        showToast('Notification preferences saved!', 'success');

    } catch (error) {
        showToast('Failed to save preferences: ' + error.message, 'error');
    } finally {
        DOM.saveNotifBtn.disabled = false;
        DOM.saveNotifBtn.textContent = 'Save Preferences';
    }
}

// ─── BANK ACCOUNTS ─────────────────────────────────────────────────

async function removeBankAccount(id) {
    if (!confirm('Are you sure you want to remove this bank account?')) return;

    try {
        await settingsApiFetch(`/withdrawal/bank-accounts/${id}`, {
            method: 'DELETE'
        });

        showToast('Bank account removed successfully', 'success');
        loadSettings();

    } catch (error) {
        showToast('Failed to remove bank account: ' + error.message, 'error');
    }
}

async function addBankAccount() {
    const bankName = DOM.bankNameInput?.value?.trim() || '';
    const bankCode = DOM.bankCodeInput?.value?.trim() || '';
    const accountNumber = DOM.accountNumberInput?.value?.trim() || '';
    const accountName = DOM.accountNameInput?.value?.trim() || '';

    if (!bankName || !accountNumber || !accountName) {
        showToast('All bank account fields are required', 'warning');
        return;
    }

    if (!/^\d{10}$/.test(accountNumber)) {
        showToast('Account number must be 10 digits', 'warning');
        return;
    }

    try {
        DOM.saveBankBtn.disabled = true;
        DOM.saveBankBtn.textContent = 'Adding...';

        await settingsApiFetch('/withdrawal/bank-accounts', {
            method: 'POST',
            body: JSON.stringify({
                bank_name: bankName,
                bank_code: bankCode || null,
                account_number: accountNumber,
                account_name: accountName
            })
        });

        showToast('Bank account added successfully!', 'success');
        closeModal('bankModal');
        loadSettings();

    } catch (error) {
        showToast('Failed to add bank account: ' + error.message, 'error');
    } finally {
        DOM.saveBankBtn.disabled = false;
        DOM.saveBankBtn.textContent = 'Add Bank Account';
    }
}

// ─── CRYPTO WALLETS ────────────────────────────────────────────────

async function removeCryptoWallet(id) {
    if (!confirm('Are you sure you want to remove this crypto wallet?')) return;

    try {
        await settingsApiFetch(`/withdrawal/crypto-wallets/${id}`, {
            method: 'DELETE'
        });

        showToast('Crypto wallet removed successfully', 'success');
        loadSettings();

    } catch (error) {
        showToast('Failed to remove crypto wallet: ' + error.message, 'error');
    }
}

async function addCryptoWallet() {
    const coin = DOM.walletCoinInput?.value?.trim()?.toUpperCase() || '';
    const network = DOM.walletNetworkInput?.value?.trim() || '';
    const address = DOM.walletAddressInput?.value?.trim() || '';
    const label = DOM.walletLabelInput?.value?.trim() || '';

    if (!coin || !network || !address) {
        showToast('Coin, network, and address are required', 'warning');
        return;
    }

    if (address.length < 10) {
        showToast('Invalid wallet address', 'warning');
        return;
    }

    try {
        DOM.saveWalletBtn.disabled = true;
        DOM.saveWalletBtn.textContent = 'Adding...';

        await settingsApiFetch('/withdrawal/crypto-wallets', {
            method: 'POST',
            body: JSON.stringify({ coin, network, address, label })
        });

        showToast('Crypto wallet added successfully!', 'success');
        closeModal('walletModal');
        loadSettings();

    } catch (error) {
        showToast('Failed to add crypto wallet: ' + error.message, 'error');
    } finally {
        DOM.saveWalletBtn.disabled = false;
        DOM.saveWalletBtn.textContent = 'Add Wallet';
    }
}

// ─── SESSIONS ──────────────────────────────────────────────────────

async function revokeSession(sessionId) {
    if (!confirm('Are you sure you want to log out this session?')) return;

    try {
        await settingsApiFetch(`/sessions/${sessionId}`, {
            method: 'DELETE'
        });

        showToast('Session revoked successfully', 'success');
        loadSettings();

    } catch (error) {
        showToast('Failed to revoke session: ' + error.message, 'error');
    }
}

async function logoutAllSessions() {
    if (!confirm('Are you sure you want to log out of all other devices? This will keep your current session active.')) return;

    try {
        DOM.logoutAllBtn.disabled = true;
        DOM.logoutAllBtn.textContent = 'Logging out...';

        await settingsApiFetch('/sessions/logout-all', {
            method: 'POST'
        });

        showToast('All other sessions logged out successfully', 'success');
        loadSettings();

    } catch (error) {
        showToast('Failed to logout sessions: ' + error.message, 'error');
    } finally {
        DOM.logoutAllBtn.disabled = false;
        DOM.logoutAllBtn.textContent = 'Log Out All Other Sessions';
    }
}

// ─── SECURITY ALERTS ──────────────────────────────────────────────

async function markAlertRead(alertId) {
    try {
        await settingsApiFetch(`/security-alerts/${alertId}/read`, {
            method: 'PATCH'
        });

        loadSettings();

    } catch (error) {
        showToast('Failed to mark alert as read: ' + error.message, 'error');
    }
}

// ─── HELPERS ──────────────────────────────────────────────────

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function parseUserAgent(session) {
    const ua = session?.user_agent || session?.browser || 'Unknown';
    let browser = 'Unknown', os = 'Unknown', device = 'Desktop';
    
    if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
    else if (ua.includes('Firefox')) browser = 'Firefox';
    else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
    else if (ua.includes('Edg')) browser = 'Edge';
    else if (ua.includes('OPR')) browser = 'Opera';
    
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac OS X')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
    
    if (ua.includes('Mobile')) device = 'Mobile';
    else if (ua.includes('Tablet')) device = 'Tablet';
    
    return { browser, os, device };
}

function getActivityIcon(type) {
    const icons = {
        'password_changed': '🔐',
        'email_changed': '📧',
        'email_change_requested': '📧',
        'phone_changed': '📱',
        'transaction_pin_changed': '🔢',
        'transaction_pin_reset_requested': '🔢',
        'twofa_enabled': '🔑',
        'twofa_disabled': '🔑',
        'bank_account_added': '🏦',
        'bank_account_removed': '🏦',
        'crypto_wallet_added': '₿',
        'crypto_wallet_removed': '₿',
        'session_revoked': '🚪',
        'all_sessions_revoked': '🚪',
        'notification_preferences_updated': '🔔',
        'login': '🔐',
        'withdrawal': '📤',
        'deposit': '📥'
    };
    return icons[type] || '📌';
}

function getAlertIcon(type) {
    const icons = {
        'password_changed': '🔐',
        'email_changed': '📧',
        'twofa_enabled': '🔑',
        'twofa_disabled': '🔑',
        'bank_account_added': '🏦',
        'bank_account_removed': '🏦',
        'crypto_wallet_added': '₿',
        'crypto_wallet_removed': '₿',
        'all_sessions_revoked': '🚪',
        'transaction_pin_changed': '🔢',
        'new_login': '🖥️',
        'suspicious_activity': '⚠️'
    };
    return icons[type] || '⚠️';
}

function timeAgo(date) {
    if (!date) return 'just now';
    const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return Math.floor(diff / 604800) + 'w ago';
}

function showToast(message, type = 'info') {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${escapeHtml(message)}</span>`;
    stack.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(30px)';
        el.style.transition = 'all .25s ease';
        setTimeout(() => el.remove(), 260);
    }, 3200);
}

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
    const inputs = modal.querySelectorAll('input');
    inputs.forEach(input => {
        if (input.type !== 'hidden') input.value = '';
    });
    if (id === 'twofaModal') {
        DOM.twofaSetupStep.style.display = 'block';
        DOM.twofaVerifyStep.style.display = 'none';
        DOM.twofaSuccessStep.style.display = 'none';
        DOM.twofaStatusText.textContent = '';
        DOM.twofaStatusText.className = '';
        DOM.twofaCodeInput.value = '';
        DOM.twofaSendBtn.textContent = 'Send Code';
        DOM.twofaSendBtn.disabled = false;
        DOM.twofaVerifyBtn.textContent = 'Verify & Enable';
        DOM.twofaVerifyBtn.disabled = false;
    }
    if (id === 'disable2faModal') {
        DOM.disable2faOtpInput.value = '';
        DOM.disable2faStatus.textContent = '';
        DOM.disable2faStatus.className = '';
        DOM.disable2faConfirmBtn.textContent = 'Disable 2FA';
        DOM.disable2faConfirmBtn.disabled = false;
    }
}

// ─── INIT ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    console.log('🔧 Settings page initializing (user mode)...');

    const token = getUserToken();
    if (!token) {
        console.warn('❌ No user token found, redirecting to login');
        redirectToUserLogin();
        return;
    }

    console.log('✅ User token found, loading settings...');

    initDOM();

    // Load data
    loadSettings();

    // ─── EVENT LISTENERS ────────────────────────────────────────

    // Email change
    if (DOM.changeEmailBtn) DOM.changeEmailBtn.addEventListener('click', () => openModal('emailModal'));
    if (DOM.sendOtpBtn) DOM.sendOtpBtn.addEventListener('click', changeEmail);
    if (DOM.verifyOtpBtn) DOM.verifyOtpBtn.addEventListener('click', verifyEmailChange);

    // Phone change
    if (DOM.changePhoneBtn) DOM.changePhoneBtn.addEventListener('click', () => openModal('phoneModal'));
    if (DOM.savePhoneBtn) DOM.savePhoneBtn.addEventListener('click', changePhone);

    // Password change
    if (DOM.changePasswordBtn) DOM.changePasswordBtn.addEventListener('click', changePassword);

    // Notification preferences
    if (DOM.saveNotifBtn) DOM.saveNotifBtn.addEventListener('click', saveNotificationPreferences);

    // Bank accounts
    if (DOM.addBankBtn) DOM.addBankBtn.addEventListener('click', () => openModal('bankModal'));
    if (DOM.saveBankBtn) DOM.saveBankBtn.addEventListener('click', addBankAccount);

    // Crypto wallets
    if (DOM.addWalletBtn) DOM.addWalletBtn.addEventListener('click', () => openModal('walletModal'));
    if (DOM.saveWalletBtn) DOM.saveWalletBtn.addEventListener('click', addCryptoWallet);

    // Transaction PIN
    if (DOM.changePinBtn) DOM.changePinBtn.addEventListener('click', () => openModal('pinModal'));
    if (DOM.savePinBtn) DOM.savePinBtn.addEventListener('click', changeTransactionPin);
    if (DOM.resetPinBtn) DOM.resetPinBtn.addEventListener('click', resetTransactionPin);

    // ─── 2FA - CORRECT EVENT LISTENERS ──────────────────────────
    if (DOM.enable2faBtn) DOM.enable2faBtn.addEventListener('click', enableTwoFA);
    if (DOM.disable2faBtn) DOM.disable2faBtn.addEventListener('click', disableTwoFA);
    if (DOM.twofaSendBtn) DOM.twofaSendBtn.addEventListener('click', resendTwoFACode);
    if (DOM.twofaVerifyBtn) DOM.twofaVerifyBtn.addEventListener('click', verifyTwoFAEnable);
    if (DOM.twofaCancelBtn) DOM.twofaCancelBtn.addEventListener('click', () => closeModal('twofaModal'));
    if (DOM.disable2faConfirmBtn) DOM.disable2faConfirmBtn.addEventListener('click', verifyTwoFADisable);
    if (DOM.disable2faCancelBtn) DOM.disable2faCancelBtn.addEventListener('click', () => closeModal('disable2faModal'));

    // Sessions
    if (DOM.logoutAllBtn) DOM.logoutAllBtn.addEventListener('click', logoutAllSessions);

    // Copy referral code
    if (DOM.copyReferralBtn) {
        DOM.copyReferralBtn.addEventListener('click', () => {
            const code = DOM.referralCode?.textContent || '';
            if (code && code !== 'N/A') {
                navigator.clipboard.writeText(code).then(() => {
                    showToast('Referral code copied!', 'success');
                }).catch(() => {
                    const input = document.createElement('input');
                    input.value = code;
                    document.body.appendChild(input);
                    input.select();
                    document.execCommand('copy');
                    document.body.removeChild(input);
                    showToast('Referral code copied!', 'success');
                });
            }
        });
    }

    // Modal close buttons
    document.querySelectorAll('.modal-close, .modal-overlay').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target === el || e.target.classList.contains('modal-close')) {
                const modal = el.closest('.modal-overlay');
                if (modal) closeModal(modal.id);
            }
        });
    });

    // Deactivate account
    if (DOM.deactivateBtn) DOM.deactivateBtn.addEventListener('click', deactivateAccount);

    console.log('🔧 Settings page loaded (user mode)');
});

// ─── Load more activity ───
if (DOM.loadMoreActivityBtn) {
    DOM.loadMoreActivityBtn.addEventListener('click', () => {
        showToast('Loading more activity...', 'info');
    });
}