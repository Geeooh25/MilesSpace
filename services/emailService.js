// services/emailService.js
// ─────────────────────────────────────────────────────────────────
// MilesSpace transactional email.
//
// SCOPE — this file sends:
//   • Registration OTP         → sendRegistrationOTP
//   • Login 2FA OTP            → send2FAEmail (aliases: sendOTPEmail, sendLoginOTP)
//   • Email verification       → sendVerificationEmail (same template as registration)
//   • Password reset OTP       → sendPasswordResetOTP
//   • Login alert              → sendLoginAlert
//   • Deposit / payment        → sendDepositConfirmation
//   • eSIM delivery/failure    → sendEsimDeliveryEmail / sendEsimFailureEmail
//   • Gift card delivery/fail  → sendGiftCardDeliveryEmail / sendGiftCardFailureEmail
//   • Admin security alert     → sendAdminSecurityAlert
//   • Support ticket updates   → sendSupportTicketUpdate
//
// NOT SENT (removed from prior versions):
//   • Welcome email
//   • Crypto delivery
//   • Gift order confirmation (superseded by gift card delivery)
//   • Withdrawal confirmation
//   • Cashback reward
//
// If any route still imports a removed function, that route must be updated.
// Search the codebase before deploying.
// ─────────────────────────────────────────────────────────────────

'use strict';

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ═══ CONFIG (read once) ═══
const EMAIL_USER      = process.env.EMAIL_USER || '';
const EMAIL_PASS      = process.env.EMAIL_PASS || '';
const EMAIL_FROM      = process.env.EMAIL_FROM || EMAIL_USER;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'MilesSpace';
const SITE_URL        = (process.env.SITE_URL || 'https://milesspace-public.vercel.app').replace(/\/+$/, '');
const LOGO_URL        = process.env.LOGO_URL || `${SITE_URL}/images/miles.png`;
const SUPPORT_EMAIL   = process.env.SUPPORT_EMAIL || 'support@milesspace.com';
const IS_DEVELOPMENT  = process.env.NODE_ENV === 'development';

// ═══ STATE ═══
let transporter    = null;
let isEmailEnabled = false;
let initAttempted  = false;
let initPromise    = null;

// ═══════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

// Explicit UTC — never rely on the server's local timezone.
function formatUtcTimestamp(timestamp) {
    const date = timestamp ? new Date(timestamp) : new Date();
    if (!Number.isFinite(date.getTime())) return 'Unavailable';

    return new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'UTC',
        timeZoneName: 'short'
    }).format(date);
}

function currencySymbol(code) {
    return String(code || '').toUpperCase() === 'USD' ? '$' : '₦';
}

function formatAmountForCurrency(amount, currency) {
    const sym = currencySymbol(currency);
    const locale = String(currency).toUpperCase() === 'USD' ? 'en-US' : 'en-NG';
    const num = Number(amount) || 0;
    return sym + num.toLocaleString(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

// Readable device string from a user-agent.
function parseUserAgentForDisplay(ua) {
    if (!ua || ua === 'Unknown' || ua === 'Unknown Device') return 'Unknown Device';

    let display = String(ua);
    display = display.replace(/^Mozilla\/\d+\.\d+\s*\(/, '');
    display = display.replace(/\)\s*AppleWebKit\/\d+\.\d+\.\d+\s*\(KHTML, like Gecko\)/, '');
    display = display.replace(/ Version\/\d+\.\d+\s*Safari\/\d+\.\d+$/, '');
    display = display.replace(/ Chrome\/\d+\.\d+\.\d+\.\d+$/, '');
    display = display.replace(/ Safari\/\d+\.\d+$/, '');
    display = display.replace(/ Edg\/\d+\.\d+\.\d+\.\d+$/, '');
    display = display.replace(/ OPR\/\d+\.\d+\.\d+\.\d+$/, '');
    display = display.replace(/ Firefox\/\d+\.\d+$/, '');
    display = display.replace(/\s+/g, ' ').trim();

    if (display.length > 200) display = display.substring(0, 200) + '…';
    return display || 'Unknown Device';
}

// ═══════════════════════════════════════════════════════════════════
//  TRANSPORTER
// ═══════════════════════════════════════════════════════════════════

function createTransporter() {
    try {
        if (!EMAIL_USER || !EMAIL_PASS) {
            console.warn('[EMAIL] credentials missing — service disabled');
            isEmailEnabled = false;
            return null;
        }

        transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: { user: EMAIL_USER, pass: EMAIL_PASS },
            pool: false,
            connectionTimeout: 15000,
            greetingTimeout:   15000,
            socketTimeout:     20000,
            tls: { rejectUnauthorized: true }
        });

        console.log('[EMAIL] transporter created');
        return transporter;
    } catch (e) {
        console.error('[EMAIL] transporter creation failed:', e.message);
        isEmailEnabled = false;
        return null;
    }
}

async function verifyTransporter() {
    if (initAttempted && initPromise) return initPromise;

    initAttempted = true;
    initPromise = (async () => {
        try {
            if (!transporter) createTransporter();
            if (!transporter) { isEmailEnabled = false; return false; }

            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('SMTP verify timeout')), 15000)
            );

            await Promise.race([transporter.verify(), timeout]);
            isEmailEnabled = true;
            console.log('[EMAIL] transporter verified');
            return true;
        } catch (e) {
            console.error('[EMAIL] verification failed:', e.message);
            isEmailEnabled = false;
            return false;
        }
    })();

    return initPromise;
}

createTransporter();

async function sendEmail(to, subject, html) {
    if (!initAttempted) await verifyTransporter();

    if (!isEmailEnabled || !transporter) {
        console.warn(`[EMAIL] disabled — not sent to ${to}`);
        return { success: false, disabled: true, error: 'Email service is disabled' };
    }

    try {
        const info = await transporter.sendMail({
            from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
            to: Array.isArray(to) ? to.join(', ') : to,
            subject,
            html
        });

        console.log(`[EMAIL] sent: ${info.messageId}`);
        return { success: true, messageId: info.messageId, response: info.response };
    } catch (err) {
        console.error('[EMAIL] send failed:', { message: err.message, code: err.code });

        if (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT') {
            transporter = null;
            isEmailEnabled = false;
            initAttempted = false;
            createTransporter();
        }

        return { success: false, error: err.message, code: err.code };
    }
}

// ═══════════════════════════════════════════════════════════════════
//  TEMPLATE LOADER
//
//  Supported syntax:
//    {{ key }}          — replaced with data[key], HTML-escaped
//    {{#if key}} ... {{/if}}   — included only if data[key] is truthy
//
//  Unknown placeholders are left as-is and a warning is logged. The
//  build should fail on this — do not silently ship unresolved keys.
// ═══════════════════════════════════════════════════════════════════

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'emails');

// Declared per-template so the loader can warn about missing variables.
const REQUIRED_VARS = {
    '2fa-code': ['userName', 'loginTimeUtc', 'otp', 'otpExpiryMinutes'],
    'verification': ['userName', 'otp'],
    'password-reset': ['userName', 'otp'],
    'login-alert': ['userName', 'loginTimeUtc'],
    'payment-confirmation': ['userName', 'amount', 'currency'],
    'order-confirmation': ['userName', 'orderId', 'productName', 'amount'],
    'support-ticket': ['userName', 'ticketId', 'subject']
};

function loadTemplate(templateName, data = {}) {
    const templatePath = path.join(TEMPLATE_DIR, `${templateName}.html`);
    let html;

    if (fs.existsSync(templatePath)) {
        html = fs.readFileSync(templatePath, 'utf8');
    } else {
        console.error(`[EMAIL] template missing: ${templateName}.html — using fallback`);
        return generateFallbackTemplate(templateName, data);
    }

    // Warn if a required variable is missing.
    const required = REQUIRED_VARS[templateName] || [];
    const missing = required.filter((k) => data[k] == null || data[k] === '');
    if (missing.length) {
        console.warn(`[EMAIL] template "${templateName}" missing vars:`, missing);
    }

    // 1. Conditionals: {{#if key}}...{{/if}}
    html = html.replace(
        /{{#if\s+(\w+)\s*}}([\s\S]*?){{\/if}}/g,
        (_, key, body) => (data[key] ? body : '')
    );

    // 2. Simple placeholders: {{ key }}
    html = html.replace(/{{\s*(\w+)\s*}}/g, (match, key) => {
        if (!(key in data)) return match; // leave for the check below
        return escapeHtml(data[key]);
    });

    // 3. Any remaining {{ ... }} is an unresolved placeholder.
    const leftover = html.match(/{{\s*\w+\s*}}/g);
    if (leftover) {
        console.warn(`[EMAIL] unresolved placeholders in "${templateName}":`, leftover);
        leftover.forEach((p) => {
            html = html.replace(new RegExp(p.replace(/[{}]/g, '\\$&'), 'g'), '');
        });
    }

    return html;
}

// ═══════════════════════════════════════════════════════════════════
//  FALLBACK TEMPLATES
//
//  Used only when a template file is missing. Kept minimal on purpose:
//  if these fire, the deployment is broken and you should notice.
// ═══════════════════════════════════════════════════════════════════

function generateFallbackTemplate(type, data) {
    const safeTitle = escapeHtml(data.title || 'MilesSpace');
    const safeBody  = escapeHtml(data.message || 'Please check your MilesSpace account.');

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6f8;padding:40px 20px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:40px 32px;">
    <h2 style="color:#0c3d4a;margin:0 0 12px;font-size:20px;font-weight:700;">${safeTitle}</h2>
    <p style="color:#4a6070;font-size:15px;line-height:1.6;margin:0 0 20px;">${safeBody}</p>
    ${data.otp ? `
      <div style="background:#e8f4f7;border-radius:10px;padding:20px;text-align:center;margin:20px 0;">
        <div style="font-size:34px;font-weight:800;color:#0c3d4a;letter-spacing:10px;">${escapeHtml(data.otp)}</div>
        <div style="font-size:12px;color:#8a99a3;margin-top:8px;">Expires in ${escapeHtml(data.otpExpiryMinutes || 10)} minutes</div>
      </div>
    ` : ''}
    <p style="color:#92a8b4;font-size:12px;text-align:center;margin:24px 0 0;">
      © ${new Date().getFullYear()} MilesSpace
    </p>
  </div>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
//  AUTH EMAILS
// ═══════════════════════════════════════════════════════════════════

// Registration OTP uses the same "verification" template as email
// verification. The two features are one contract from the customer's
// point of view: "here is a code to confirm your email".
async function sendRegistrationOTP(email, username, otp) {
    const html = loadTemplate('verification', {
        userName: username || 'there',
        otp: otp,
        verificationUrl: `${SITE_URL}/verify`,
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, '🔐 Verify your MilesSpace account', html);
}

// Canonical 2FA email. Data contract is explicit:
//   userName, loginTimeUtc, device, browser, os, location, ipAddress, otp
async function send2FAEmail(email, username, otp, deviceInfo = {}, location = 'Unknown', ipAddress = 'Unknown') {
    const loginTimeUtc = formatUtcTimestamp(new Date());

    let deviceDisplay  = 'Unknown Device';
    let browserDisplay = 'Unknown';
    let osDisplay      = 'Unknown';

    if (deviceInfo) {
        const rawUA = deviceInfo.rawUserAgent || deviceInfo.userAgent || '';
        if (rawUA && rawUA !== 'Unknown') deviceDisplay = parseUserAgentForDisplay(rawUA);
        else if (deviceInfo.device && deviceInfo.device !== 'Unknown') deviceDisplay = deviceInfo.device;

        if (deviceInfo.browser && deviceInfo.browser !== 'Unknown') browserDisplay = deviceInfo.browser;
        if (deviceInfo.os && deviceInfo.os !== 'Unknown')       osDisplay = deviceInfo.os;
    }

    let displayLocation = location || 'Unknown';
    if (IS_DEVELOPMENT && ['Localhost', '127.0.0.1', '::1'].includes(displayLocation)) {
        displayLocation = 'Development Environment';
    }

    let displayIp = ipAddress || 'Unknown';
    if (IS_DEVELOPMENT && ['::1', '127.0.0.1'].includes(displayIp)) {
        displayIp = '127.0.0.1 (localhost)';
    }

    const html = loadTemplate('2fa-code', {
        userName: username || 'User',
        loginTimeUtc,
        device: deviceDisplay,
        browser: browserDisplay,
        os: osDisplay,
        location: displayLocation,
        ipAddress: displayIp,
        otp,
        otpExpiryMinutes: 10,
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, '🔐 Verification Needed — MilesSpace', html);
}

// Same contract as send2FAEmail. Kept as its own function because some
// callers (registration verification flow) name it differently.
async function sendVerificationEmail(email, username, code) {
    const html = loadTemplate('verification', {
        userName: username || 'there',
        otp: code,
        verificationUrl: `${SITE_URL}/verify`,
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, 'Verify Your Email — MilesSpace', html);
}

async function sendPasswordResetOTP(email, username, code) {
    const html = loadTemplate('password-reset', {
        userName: username || 'User',
        otp: code,
        otpExpiryMinutes: 10,
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, 'Reset Your Password — MilesSpace', html);
}

async function sendLoginAlert(email, username, deviceInfo = {}, location = 'Unknown', ipAddress = 'Unknown', occurredAt = null) {
    const loginTimeUtc = formatUtcTimestamp(occurredAt || new Date());

    let deviceDisplay = 'Unknown Device';
    if (deviceInfo) {
        const rawUA = deviceInfo.rawUserAgent || deviceInfo.userAgent || '';
        if (rawUA && rawUA !== 'Unknown') deviceDisplay = parseUserAgentForDisplay(rawUA);
        else if (deviceInfo.device)       deviceDisplay = deviceInfo.device;
    }

    let displayLocation = location || 'Unknown';
    if (IS_DEVELOPMENT && ['Localhost', '127.0.0.1', '::1'].includes(displayLocation)) {
        displayLocation = 'Development Environment';
    }

    let displayIp = ipAddress || 'Unknown';
    if (IS_DEVELOPMENT && ['::1', '127.0.0.1'].includes(displayIp)) {
        displayIp = '127.0.0.1 (localhost)';
    }

    const html = loadTemplate('login-alert', {
        userName: username || 'User',
        loginTimeUtc,
        device: deviceDisplay,
        browser: deviceInfo?.browser || 'Unknown',
        os: deviceInfo?.os || 'Unknown',
        location: displayLocation,
        ipAddress: displayIp,
        secureAccountUrl: `${SITE_URL}/settings`,
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, '🛡️ New Login Detected — MilesSpace', html);
}

// ═══════════════════════════════════════════════════════════════════
//  DEPOSIT / PAYMENT
// ═══════════════════════════════════════════════════════════════════

async function sendDepositConfirmation({
    email,
    username,
    internalReference,
    sourceCurrency,
    sourceAmount,
    targetCurrency = 'NGN',
    creditedAmount,
    fxRate,
    fxSource,
    completedAt
}) {
    const sourceStr   = `${sourceCurrency} ${Number(sourceAmount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const creditedStr = formatAmountForCurrency(creditedAmount, targetCurrency);
    const rateStr     = `1 ${sourceCurrency} = ${currencySymbol(targetCurrency)}${Number(fxRate).toFixed(4)}`;
    const dateStr     = formatUtcTimestamp(completedAt);

    const html = loadTemplate('payment-confirmation', {
        userName: username || 'there',
        amount: creditedStr,
        currency: targetCurrency,
        method: sourceCurrency,
        fee: '—',
        total: creditedStr,
        reference: internalReference,
        date: dateStr,
        viewTransactionUrl: `${SITE_URL}/history`,
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `💰 Deposit received — ${creditedStr}`, html);
}

// ═══════════════════════════════════════════════════════════════════
//  eSIM
// ═══════════════════════════════════════════════════════════════════

async function sendEsimDeliveryEmail(data) {
    const {
        email, username, reference, countryName, planName,
        dataDisplay, validityDays, totalUsd,
        qrCodeUrl, activationCode, lpaString, smdpAddress, matchingId, instructions
    } = data;

    const html = loadTemplate('esim-delivery', {
        userName: username || 'Traveller',
        reference: reference || '—',
        countryName: countryName || '—',
        planName: planName || 'eSIM Plan',
        dataDisplay: dataDisplay || '—',
        validityDays: validityDays || '—',
        totalUsd: totalUsd != null ? `$${Number(totalUsd).toFixed(2)}` : '—',
        qrCodeUrl: qrCodeUrl || '',
        hasQr: qrCodeUrl ? '1' : '',
        activationCode: activationCode || '',
        lpaString: lpaString || '',
        smdpAddress: smdpAddress || '',
        matchingId: matchingId || '',
        instructions: instructions || '',
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `📱 Your eSIM is Ready — ${countryName || ''}`.trim(), html);
}

async function sendEsimFailureEmail(data) {
    const { email, username, reference, countryName, planName, amountUsd, reason, refunded } = data;

    const html = loadTemplate('esim-failure', {
        userName: username || 'User',
        reference: reference || '—',
        countryName: countryName || '—',
        planName: planName || 'eSIM Plan',
        amountUsd: amountUsd != null ? `$${Number(amountUsd).toFixed(2)}` : '—',
        reason: reason || 'The order could not be completed by the provider.',
        refunded: refunded ? '1' : '',
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `⚠️ eSIM Order Failed — ${countryName || ''}`.trim(), html);
}

// ═══════════════════════════════════════════════════════════════════
//  GIFT CARDS
// ═══════════════════════════════════════════════════════════════════

async function sendGiftCardDeliveryEmail(data) {
    const {
        email, username, reference, cardName,
        faceValue, currency, voucherCode, voucherSerial, instructions
    } = data;

    const html = loadTemplate('giftcard-delivery', {
        userName: username || 'Customer',
        reference: reference || '—',
        cardName: cardName || 'Gift Card',
        faceValue: faceValue != null ? String(faceValue) : '—',
        currency: currency || '',
        voucherCode: voucherCode || '—',
        voucherSerial: voucherSerial || '',
        instructions: instructions || '',
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `🎁 Your ${cardName || 'Gift Card'} is Ready`, html);
}

async function sendGiftCardFailureEmail(data) {
    const { email, username, reference, cardName, faceValue, currency, reason, refunded } = data;

    const html = loadTemplate('giftcard-failure', {
        userName: username || 'Customer',
        reference: reference || '—',
        cardName: cardName || 'Gift Card',
        faceValue: faceValue != null ? `${currency || ''} ${faceValue}` : '—',
        reason: reason || 'The provider declined this purchase.',
        refunded: refunded ? '1' : '',
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `⚠️ Gift Card Order Failed — ${reference || ''}`.trim(), html);
}

// ═══════════════════════════════════════════════════════════════════
//  SUPPORT TICKET
// ═══════════════════════════════════════════════════════════════════

async function sendSupportTicketUpdate(data) {
    const { email, username, action, ticketId, subject, status, category, message } = data;

    const html = loadTemplate('support-ticket', {
        userName: username || 'Customer',
        action: action || 'updated',
        ticketId: ticketId || '—',
        subject: subject || '—',
        status: status || 'open',
        category: category || 'General',
        message: message || '',
        createdAt: formatUtcTimestamp(new Date()),
        viewTicketUrl: `${SITE_URL}/support`,
        logoUrl: LOGO_URL,
        supportEmail: SUPPORT_EMAIL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `Support ticket ${action || 'updated'} — MilesSpace`, html);
}

// ═══════════════════════════════════════════════════════════════════
//  ADMIN
// ═══════════════════════════════════════════════════════════════════

async function sendAdminSecurityAlert({
    email, username, action, targetType = null, targetId = null,
    detail = null, ipAddress = null, userAgent = null, when = null
}) {
    if (!email) return { success: false, error: 'No email provided' };

    const eventTime = formatUtcTimestamp(when || new Date());

    const LABELS = {
        ADMIN_LOGIN_NEW_DEVICE:      'New admin sign-in detected',
        MFA_ENABLED:                 'Two-factor authentication enabled',
        MFA_DISABLED:                'Two-factor authentication disabled',
        PERMISSION_GRANTED:          'Admin permission granted',
        PERMISSION_REVOKED:          'Admin permission revoked',
        ROLE_CHANGED:                'Admin role changed',
        WALLET_ADJUSTED:             'Customer wallet adjusted',
        WALLET_CREDITED:             'Customer wallet credited',
        WALLET_DEBITED:              'Customer wallet debited',
        REFUND_CREATED:              'Refund issued',
        PROVIDER_CREDENTIAL_CHANGED: 'Provider credentials changed',
        ADMIN_CREATED:               'New admin account created',
        ADMIN_DELETED:               'Admin account deleted',
        SECURITY_SETTINGS_CHANGED:   'Security settings changed'
    };
    const title = LABELS[action] || 'Admin security event';

    const html = loadTemplate('admin-security-alert', {
        title,
        action,
        userName: username || 'Admin',
        occurredAtUtc: eventTime,
        targetType: targetType || '',
        targetId: targetId || '',
        detailJson: detail ? JSON.stringify(detail, null, 2) : '',
        ipAddress: ipAddress || '',
        userAgent: userAgent ? parseUserAgentForDisplay(userAgent) : '',
        settingsUrl: `${SITE_URL}/admin/settings`,
        logoUrl: LOGO_URL,
        siteUrl: SITE_URL,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `🔐 ${title} — MilesSpace Admin`, html);
}

// ═══════════════════════════════════════════════════════════════════
//  STATUS
// ═══════════════════════════════════════════════════════════════════

function getStatus() {
    return {
        enabled: isEmailEnabled,
        from: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`,
        provider: 'Gmail SSL (port 465)',
        isDevelopment: IS_DEVELOPMENT,
        credentials: {
            user: EMAIL_USER ? '✅ Set' : '❌ Missing',
            pass: EMAIL_PASS ? '✅ Set' : '❌ Missing'
        }
    };
}

// ═══════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    // Core
    sendEmail,
    loadTemplate,
    getStatus,
    verifyTransporter,
    isEnabled: () => isEmailEnabled,
    parseUserAgentForDisplay,

    // Auth
    sendRegistrationOTP,
    send2FAEmail,
    sendOTPEmail: send2FAEmail,   // alias — callers using this name keep working
    sendLoginOTP: send2FAEmail,   // alias
    sendVerificationEmail,
    sendPasswordResetOTP,
    sendLoginAlert,

    // Transactions
    sendDepositConfirmation,

    // Service delivery
    sendEsimDeliveryEmail,
    sendEsimFailureEmail,
    sendGiftCardDeliveryEmail,
    sendGiftCardFailureEmail,

    // Support
    sendSupportTicketUpdate,

    // Admin
    sendAdminSecurityAlert

    // REMOVED — do not re-add without auditing call sites:
    //   sendWelcomeEmail
    //   sendCryptoDeliveryEmail
    //   sendGiftOrderConfirmation
    //   sendWithdrawalConfirmation
    //   sendCashbackReward
    //   sendPaymentReceived  (superseded by sendDepositConfirmation)
};