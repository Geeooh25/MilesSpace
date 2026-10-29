// services/emailService.js
// ─────────────────────────────────────────────────────────────────
// MilesSpace transactional email.
//
// SCOPE — this file sends:
//   • Registration OTP         → sendRegistrationOTP
//   • Login 2FA OTP            → send2FAEmail (aliases: sendOTPEmail, sendLoginOTP)
//   • Email verification       → sendVerificationEmail
//   • Password reset OTP       → sendPasswordResetOTP
//   • Login alert              → sendLoginAlert
//   • Deposit / payment        → sendDepositConfirmation
//   • eSIM delivery/failure    → sendEsimDeliveryEmail / sendEsimFailureEmail
//   • Gift card delivery/fail  → sendGiftCardDeliveryEmail / sendGiftCardFailureEmail
//   • Admin security alert     → sendAdminSecurityAlert
//   • Support ticket updates   → sendSupportTicketUpdate
// ─────────────────────────────────────────────────────────────────

'use strict';

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const adminSettings = require('./adminSettingsService');

// ═══ BRANDING CACHE ═══
// We cache the brand settings for 60 seconds to avoid hammering the
// database on every single email sent during a bulk operation.
let _brandCache = null;
let _brandCacheAt = 0;
const BRAND_CACHE_MS = 60 * 1000;

async function getBrandConfig() {
    if (_brandCache && (Date.now() - _brandCacheAt) < BRAND_CACHE_MS) {
        return _brandCache;
    }

    let platformName = 'MilesSpace';
    let supportEmail = process.env.SUPPORT_EMAIL || 'support@milesspace.com';
    let siteUrl      = (process.env.SITE_URL || 'https://milesspace-public.vercel.app').replace(/\/+$/, '');

    try {
        const name = await adminSettings.getRaw('platform_name');
        if (name) platformName = String(name);

        const email = await adminSettings.getRaw('support_email');
        if (email) supportEmail = String(email);

        const url = await adminSettings.getRaw('website_url');
        if (url) siteUrl = String(url).replace(/\/+$/, '');
    } catch (e) {
        console.warn('[EMAIL] Failed to read brand settings, using fallbacks:', e.message);
    }

    _brandCache = { platformName, supportEmail, siteUrl };
    _brandCacheAt = Date.now();
    return _brandCache;
}

// ═══ CONFIG (read once) ═══
const EMAIL_USER      = process.env.EMAIL_USER || '';
const EMAIL_PASS      = process.env.EMAIL_PASS || '';
const EMAIL_FROM      = process.env.EMAIL_FROM || EMAIL_USER;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'MilesSpace';
const IS_DEVELOPMENT  = process.env.NODE_ENV === 'development';

// ═══ CLOUDINARY LOGO CONFIG ═══
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';

function getCloudinaryEmailLogo() {
    if (process.env.LOGO_URL) return process.env.LOGO_URL;
    if (CLOUDINARY_CLOUD_NAME) {
        return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/f_auto,q_auto,w_150/v1/milespace-logo.png`;
    }
    return `https://milesspace-public.vercel.app/images/miles.png`; // Static fallback
}

const LOGO_URL = getCloudinaryEmailLogo();

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
// ═══════════════════════════════════════════════════════════════════

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'emails');

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

    const required = REQUIRED_VARS[templateName] || [];
    const missing = required.filter((k) => data[k] == null || data[k] === '');
    if (missing.length) {
        console.warn(`[EMAIL] template "${templateName}" missing vars:`, missing);
    }

    html = html.replace(
        /{{#if\s+(\w+)\s*}}([\s\S]*?){{\/if}}/g,
        (_, key, body) => (data[key] ? body : '')
    );

    html = html.replace(/{{\s*(\w+)\s*}}/g, (match, key) => {
        if (!(key in data)) return match;
        return escapeHtml(data[key]);
    });

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
// ═══════════════════════════════════════════════════════════════════

function generateFallbackTemplate(type, data) {
    const safeTitle = escapeHtml(data.title || 'Notification');
    const safeBody  = escapeHtml(data.message || 'Please check your account.');

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6f8;padding:40px 20px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:40px 32px;">
    <img src="${LOGO_URL}" alt="Logo" style="height:40px;margin-bottom:20px;display:block;" />
    <h2 style="color:#0c3d4a;margin:0 0 12px;font-size:20px;font-weight:700;">${safeTitle}</h2>
    <p style="color:#4a6070;font-size:15px;line-height:1.6;margin:0 0 20px;">${safeBody}</p>
    ${data.otp ? `
      <div style="background:#e8f4f7;border-radius:10px;padding:20px;text-align:center;margin:20px 0;">
        <div style="font-size:34px;font-weight:800;color:#0c3d4a;letter-spacing:10px;">${escapeHtml(data.otp)}</div>
        <div style="font-size:12px;color:#8a99a3;margin-top:8px;">Expires in ${escapeHtml(data.otpExpiryMinutes || 10)} minutes</div>
      </div>
    ` : ''}
    <p style="color:#92a8b4;font-size:12px;text-align:center;margin:24px 0 0;">
      © ${new Date().getFullYear()} ${escapeHtml(data.platformName || 'MilesSpace')}
    </p>
  </div>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
//  AUTH EMAILS
// ═══════════════════════════════════════════════════════════════════

async function sendRegistrationOTP(email, username, otp) {
    const brand = await getBrandConfig();
    
    const html = loadTemplate('verification', {
        userName: username || 'there',
        otp: otp,
        verificationUrl: `${brand.siteUrl}/verify`,
        logoUrl: LOGO_URL,
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `🔐 Verify your ${brand.platformName} account`, html);
}

async function send2FAEmail(email, username, otp, deviceInfo = {}, location = 'Unknown', ipAddress = 'Unknown') {
    const brand = await getBrandConfig();
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
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `🔐 Verification Needed — ${brand.platformName}`, html);
}

async function sendVerificationEmail(email, username, code) {
    const brand = await getBrandConfig();
    
    const html = loadTemplate('verification', {
        userName: username || 'there',
        otp: code,
        verificationUrl: `${brand.siteUrl}/verify`,
        logoUrl: LOGO_URL,
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `Verify Your Email — ${brand.platformName}`, html);
}

async function sendPasswordResetOTP(email, username, code) {
    const brand = await getBrandConfig();
    
    const html = loadTemplate('password-reset', {
        userName: username || 'User',
        otp: code,
        otpExpiryMinutes: 10,
        logoUrl: LOGO_URL,
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `Reset Your Password — ${brand.platformName}`, html);
}

async function sendLoginAlert(email, username, deviceInfo = {}, location = 'Unknown', ipAddress = 'Unknown', occurredAt = null) {
    const brand = await getBrandConfig();
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
        secureAccountUrl: `${brand.siteUrl}/settings`,
        logoUrl: LOGO_URL,
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `🛡️ New Login Detected — ${brand.platformName}`, html);
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
    const brand = await getBrandConfig();
    
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
        viewTransactionUrl: `${brand.siteUrl}/history`,
        logoUrl: LOGO_URL,
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `💰 Deposit received — ${creditedStr}`, html);
}

// ═══════════════════════════════════════════════════════════════════
//  eSIM
// ═══════════════════════════════════════════════════════════════════

async function sendEsimDeliveryEmail(data) {
    const brand = await getBrandConfig();
    
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
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `📱 Your eSIM is Ready — ${countryName || ''}`.trim(), html);
}

async function sendEsimFailureEmail(data) {
    const brand = await getBrandConfig();
    
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
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `⚠️ eSIM Order Failed — ${countryName || ''}`.trim(), html);
}

// ═══════════════════════════════════════════════════════════════════
//  GIFT CARDS
// ═══════════════════════════════════════════════════════════════════

async function sendGiftCardDeliveryEmail(data) {
    const brand = await getBrandConfig();
    
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
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `🎁 Your ${cardName || 'Gift Card'} is Ready`, html);
}

async function sendGiftCardFailureEmail(data) {
    const brand = await getBrandConfig();
    
    const { email, username, reference, cardName, faceValue, currency, reason, refunded } = data;

    const html = loadTemplate('giftcard-failure', {
        userName: username || 'Customer',
        reference: reference || '—',
        cardName: cardName || 'Gift Card',
        faceValue: faceValue != null ? `${currency || ''} ${faceValue}` : '—',
        reason: reason || 'The provider declined this purchase.',
        refunded: refunded ? '1' : '',
        logoUrl: LOGO_URL,
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `⚠️ Gift Card Order Failed — ${reference || ''}`.trim(), html);
}

// ═══════════════════════════════════════════════════════════════════
//  SUPPORT TICKET
// ═══════════════════════════════════════════════════════════════════

async function sendSupportTicketUpdate(data) {
    const brand = await getBrandConfig();
    
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
        viewTicketUrl: `${brand.siteUrl}/support`,
        logoUrl: LOGO_URL,
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `Support ticket ${action || 'updated'} — ${brand.platformName}`, html);
}

// ═══════════════════════════════════════════════════════════════════
//  ADMIN
// ═══════════════════════════════════════════════════════════════════

async function sendAdminSecurityAlert({
    email, username, action, targetType = null, targetId = null,
    detail = null, ipAddress = null, userAgent = null, when = null
}) {
    if (!email) return { success: false, error: 'No email provided' };
    const brand = await getBrandConfig();

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
        settingsUrl: `${brand.siteUrl}/admin/settings`,
        logoUrl: LOGO_URL,
        supportEmail: brand.supportEmail,
        platformName: brand.platformName,
        siteUrl: brand.siteUrl,
        currentYear: new Date().getFullYear()
    });

    return sendEmail(email, `🔐 ${title} — ${brand.platformName} Admin`, html);
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
        logoUrl: LOGO_URL, 
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
    sendOTPEmail: send2FAEmail,   // alias
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
};