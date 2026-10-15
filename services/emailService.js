// services/emailService.js — COMPLETE
// Handles: 2FA, verification, password reset, welcome, login alerts, gift orders,
// crypto delivery, withdrawals, payments, cashback, eSIM delivery/failure,
// gift card delivery/failure, multi-currency deposit confirmations,
// and registration OTP.
//
// FIX IN THIS REVISION:
//   Added `sendOTPEmail: send2FAEmail` alias so routes that call
//   emailService.sendOTPEmail(...) continue to work. The canonical
//   name is send2FAEmail.

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ─── CONFIGURATION ───
const EMAIL_USER      = process.env.EMAIL_USER || '';
const EMAIL_PASS      = process.env.EMAIL_PASS || '';
const EMAIL_FROM      = process.env.EMAIL_FROM || EMAIL_USER;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'MilesSpace';
const SITE_URL        = process.env.SITE_URL || 'https://milesspace.com';
const LOGO_URL        = process.env.LOGO_URL || `${SITE_URL}/images/miles.png`;
const IS_DEVELOPMENT  = process.env.NODE_ENV === 'development';

// ─── STATE ───
let transporter     = null;
let isEmailEnabled  = false;
let initAttempted   = false;
let initPromise     = null;

// ─── HELPERS ───
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function currencySymbol(code) {
    return code === 'USD' ? '$' : '₦';
}

function formatAmountForCurrency(amount, currency) {
    const sym = currencySymbol(currency);
    const locale = currency === 'USD' ? 'en-US' : 'en-NG';
    const num = Number(amount) || 0;
    return sym + num.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─── CREATE TRANSPORTER ───
function createTransporter() {
    try {
        if (!EMAIL_USER || !EMAIL_PASS) {
            console.warn('⚠️  Email credentials not configured. Email sending disabled.');
            isEmailEnabled = false;
            return null;
        }

        transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: { user: EMAIL_USER, pass: EMAIL_PASS },
            pool: false,
            connectionTimeout: 30000,
            greetingTimeout:   30000,
            socketTimeout:     30000,
            tls: { rejectUnauthorized: true }
        });

        console.log('✅ Email transporter created (Gmail SSL - port 465)');
        return transporter;
    } catch (error) {
        console.error('❌ Email transporter creation error:', error.message);
        isEmailEnabled = false;
        return null;
    }
}

// ─── VERIFY TRANSPORTER ───
async function verifyTransporter() {
    if (initAttempted && initPromise) return initPromise;

    initAttempted = true;
    initPromise = new Promise(async (resolve) => {
        try {
            if (!transporter) createTransporter();
            if (!transporter) { isEmailEnabled = false; resolve(false); return; }

            const verifyPromise = transporter.verify();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('SMTP verification timeout after 15s')), 15000)
            );

            await Promise.race([verifyPromise, timeoutPromise]);
            isEmailEnabled = true;
            console.log('✅ Email transporter verified successfully');
            resolve(true);
        } catch (error) {
            console.error('❌ Email verification failed:', {
                message: error.message, code: error.code, command: error.command
            });
            isEmailEnabled = false;
            resolve(false);
        }
    });

    return initPromise;
}

createTransporter();

// ─── SEND EMAIL ───
async function sendEmail(to, subject, html) {
    if (!initAttempted) await verifyTransporter();

    if (!isEmailEnabled) {
        console.warn(`⚠️  Email service disabled - email not sent to ${to}`);
        return { success: false, disabled: true, message: 'Email service is disabled' };
    }

    if (!transporter) {
        console.warn(`⚠️  No transporter available - email not sent to ${to}`);
        return { success: false, disabled: true, message: 'No email transporter available' };
    }

    try {
        const mailOptions = {
            from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
            to: Array.isArray(to) ? to.join(', ') : to,
            subject,
            html
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Email sent to ${to}: ${info.messageId}`);
        return { success: true, messageId: info.messageId, response: info.response };
    } catch (error) {
        console.error(`❌ Email send error to ${to}:`, {
            message: error.message, code: error.code, command: error.command
        });

        if (error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT') {
            console.log('🔄 Resetting transporter due to connection error...');
            transporter = null;
            isEmailEnabled = false;
            initAttempted = false;
            createTransporter();
        }

        return { success: false, error: error.message, code: error.code };
    }
}

// ─── LOAD TEMPLATE ───
function loadTemplate(templateName, data = {}) {
    try {
        const templatePath = path.join(__dirname, '../templates/emails', `${templateName}.html`);
        let html;

        if (fs.existsSync(templatePath)) {
            html = fs.readFileSync(templatePath, 'utf8');
        } else {
            html = generateFallbackTemplate(templateName, data);
        }

        Object.keys(data).forEach(key => {
            const value = data[key] ?? '';
            html = html.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value);
            html = html.replace(new RegExp(`{\\s*${key}\\s*}`, 'g'), value);
        });

        const leftover = html.match(/{{?\s*\w+\s*}?}/g);
        if (leftover) {
            console.warn(`⚠️  Unreplaced placeholders in "${templateName}":`, leftover);
            leftover.forEach(placeholder => {
                const key = placeholder.replace(/[{}]/g, '').trim();
                html = html.replace(new RegExp(placeholder, 'g'), `[${key} unavailable]`);
            });
        }

        return html;
    } catch (error) {
        console.error('Template error:', error);
        return generateFallbackTemplate(templateName, data);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  FALLBACK TEMPLATES
// ═══════════════════════════════════════════════════════════════════
function generateFallbackTemplate(type, data) {
    const style = `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f4f6f8;padding:40px 20px;margin:0;`;
    const containerStyle = `max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 14px rgba(0,0,0,0.06);`;

    if (type === 'esim-delivery') {
        let html = `
            <!DOCTYPE html>
            <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="${style}">
            <div style="${containerStyle}">
                <div style="text-align:center;margin-bottom:24px;">
                    <div style="display:inline-block;width:56px;height:56px;border-radius:50%;background:#e5f6ee;color:#1c8f63;font-size:24px;line-height:56px;text-align:center;">✓</div>
                </div>
                <h2 style="font-size:22px;font-weight:700;color:#0c3d4a;margin:0 0 8px;text-align:center;">Your eSIM is ready 🎉</h2>
                <p style="color:#4a6070;font-size:14px;margin:0 0 24px;text-align:center;">
                    Hi ${data.userName || 'Traveller'}, your eSIM for <strong>${data.countryName || ''}</strong> has been activated.
                </p>

                <div style="background:#f8fafb;border-radius:10px;padding:18px 20px;margin-bottom:22px;">
                    <p style="font-size:11px;font-weight:700;color:#6b7d8a;margin:0 0 12px;letter-spacing:.08em;">ORDER SUMMARY</p>
                    <table style="width:100%;border-collapse:collapse;font-size:13px;color:#4a6070;">
                        <tr><td style="padding:5px 0;">Reference</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${data.reference || '—'}</td></tr>
                        <tr><td style="padding:5px 0;">Destination</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${data.countryName || '—'}</td></tr>
                        <tr><td style="padding:5px 0;">Plan</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${data.planName || '—'}</td></tr>
                        <tr><td style="padding:5px 0;">Data</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${data.dataDisplay || '—'} · ${data.validityDays || '—'} days</td></tr>
                        <tr><td style="padding:5px 0;">Paid</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${data.totalUsd || '—'} <span style="color:#9298ac;">(${data.totalNgn || '—'})</span></td></tr>
                        <tr><td style="padding:5px 0;">Date</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${data.purchaseDate || '—'} · ${data.purchaseTime || '—'}</td></tr>
                    </table>
                </div>
        `;

        if (data.hasQr === '1') {
            html += `
                <div style="text-align:center;margin:26px 0;">
                    <p style="font-size:13px;color:#4a6070;margin:0 0 14px;font-weight:600;">Scan to install on your phone</p>
                    <img src="${data.qrCodeUrl}" alt="eSIM QR code" style="width:220px;height:220px;border:1px solid #e4e8ec;border-radius:14px;padding:10px;background:#fff;display:inline-block;">
                    <p style="font-size:12px;color:#9298ac;margin:12px 0 0;">Open Settings → Cellular/Mobile Data → Add eSIM → Scan QR</p>
                </div>
            `;
        }

        html += data.manualBlock || '';

        if (data.hasInstructions === '1') {
            html += `<div style="background:#fdf3e8;border-radius:10px;padding:14px 18px;margin:20px 0;color:#7a3517;font-size:13px;line-height:1.65;">${data.instructions}</div>`;
        }

        html += `
                <div style="border-top:1px solid #e4e8ec;padding-top:16px;margin-top:24px;">
                    <p style="color:#92a8b4;font-size:12px;text-align:center;margin:0;">
                        Need help? Reply to this email or contact support.<br>
                        © ${data.currentYear || new Date().getFullYear()} MilesSpace. All rights reserved.
                    </p>
                </div>
            </div>
            </body></html>
        `;
        return html;
    }

    if (type === 'esim-failure') {
        return `
            <!DOCTYPE html>
            <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="${style}">
            <div style="${containerStyle}">
                <div style="text-align:center;margin-bottom:24px;">
                    <div style="display:inline-block;width:56px;height:56px;border-radius:50%;background:#fbeaea;color:#d34848;font-size:24px;line-height:56px;text-align:center;">!</div>
                </div>
                <h2 style="font-size:20px;font-weight:700;color:#0c3d4a;margin:0 0 8px;text-align:center;">Your eSIM order could not be completed</h2>
                <p style="color:#4a6070;font-size:14px;margin:0 0 20px;text-align:center;">
                    Hi ${data.userName || 'User'}, we weren't able to deliver your ${data.countryName || ''} eSIM.
                </p>

                <div style="background:#fbeaea;border-radius:10px;padding:16px 20px;margin:20px 0;">
                    <p style="margin:0 0 6px;color:#d34848;font-size:12px;font-weight:700;letter-spacing:.06em;">REASON</p>
                    <p style="margin:0;color:#7a2b2b;font-size:13px;line-height:1.55;">${data.reason || 'The order could not be completed by the provider.'}</p>
                </div>

                <div style="background:#f8fafb;border-radius:10px;padding:16px 20px;margin:20px 0;">
                    <table style="width:100%;border-collapse:collapse;font-size:13px;color:#4a6070;">
                        <tr><td style="padding:4px 0;">Reference</td><td style="padding:4px 0;text-align:right;font-weight:600;color:#0c3d4a;">${data.reference || '—'}</td></tr>
                        <tr><td style="padding:4px 0;">Plan</td><td style="padding:4px 0;text-align:right;font-weight:600;color:#0c3d4a;">${data.planName || '—'}</td></tr>
                        <tr><td style="padding:4px 0;">Amount</td><td style="padding:4px 0;text-align:right;font-weight:600;color:#0c3d4a;">${data.amountUsd || '—'} <span style="color:#9298ac;">(${data.amountNgn || '—'})</span></td></tr>
                    </table>
                </div>

                ${data.refundBlock || ''}

                <p style="color:#4a6070;font-size:13px;text-align:center;margin-top:22px;">
                    You can try again with a different plan, or reply to this email for assistance.
                </p>

                <div style="border-top:1px solid #e4e8ec;padding-top:16px;margin-top:22px;">
                    <p style="color:#92a8b4;font-size:12px;text-align:center;margin:0;">
                        © ${data.currentYear || new Date().getFullYear()} MilesSpace. All rights reserved.
                    </p>
                </div>
            </div>
            </body></html>
        `;
    }

    // Default fallback (OTP / verification / registration)
    let html = `
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
        <title>${data.subject || 'MilesSpace'}</title></head>
        <body style="${style}">
            <div style="${containerStyle}">
                <h2 style="font-size:20px;font-weight:700;color:#0c3d4a;margin-bottom:12px;">
                    ${data.title || 'Verification Needed'}
                </h2>
                <p style="color:#4a6070;font-size:15px;line-height:1.6;margin-bottom:20px;">
                    ${data.message || 'Please confirm your sign-in request'}
                </p>
    `;

    if (data.userName) {
        html += `<p style="color:#4a6070;font-size:14px;margin:8px 0;"><strong>Hi ${data.userName},</strong></p>`;
    }

    html += `<div style="background:#f8fafb;border-radius:10px;padding:16px 20px;margin:16px 0;">`;
    html += `<p style="font-size:13px;font-weight:600;color:#6b7d8a;margin:0 0 8px;">SIGN-IN DETAILS</p>`;

    if (data.loginDate && data.loginTime) {
        html += `<p style="margin:6px 0;color:#4a6070;font-size:14px;"><strong>Date & Time:</strong> ${data.loginDate} · ${data.loginTime}</p>`;
    } else if (data.when) {
        html += `<p style="margin:6px 0;color:#4a6070;font-size:14px;"><strong>Date & Time:</strong> ${data.when}</p>`;
    }

    if (data.device)    html += `<p style="margin:6px 0;color:#4a6070;font-size:14px;"><strong>Device:</strong> ${data.device}</p>`;
    if (data.browser)   html += `<p style="margin:6px 0;color:#4a6070;font-size:14px;"><strong>Browser:</strong> ${data.browser}</p>`;
    if (data.os)        html += `<p style="margin:6px 0;color:#4a6070;font-size:14px;"><strong>OS:</strong> ${data.os}</p>`;
    if (data.location)  html += `<p style="margin:6px 0;color:#4a6070;font-size:14px;"><strong>Location:</strong> ${data.location}</p>`;
    if (data.ipAddress) html += `<p style="margin:6px 0;color:#4a6070;font-size:14px;"><strong>IP Address:</strong> ${data.ipAddress}</p>`;
    html += `</div>`;

    if (data.otp) {
        html += `
            <div style="background:#e8f4f7;border-radius:10px;padding:20px;text-align:center;margin:20px 0;">
                <p style="font-size:12px;color:#4a6070;margin-bottom:6px;">YOUR VERIFICATION CODE</p>
                <div style="font-size:36px;font-weight:800;color:#0c3d4a;letter-spacing:8px;">${data.otp}</div>
                <p style="font-size:12px;color:#92a8b4;margin-top:6px;">Expires in ${data.otpExpiryMinutes || 10} minutes</p>
            </div>
        `;
    }

    html += `
                <div style="border-top:1px solid #e4e8ec;padding-top:16px;margin-top:16px;">
                    <p style="color:#92a8b4;font-size:12px;text-align:center;margin:0;">
                        © ${new Date().getFullYear()} MilesSpace. All rights reserved.
                    </p>
                </div>
            </div>
        </body></html>
    `;

    return html;
}

// ─── PARSE USER AGENT ───
function parseUserAgentForDisplay(ua) {
    if (!ua || ua === 'Unknown' || ua === 'Unknown Device') return 'Unknown Device';

    let display = ua;
    display = display.replace(/^Mozilla\/\d+\.\d+\s*\(/, '');
    display = display.replace(/\)\s*AppleWebKit\/\d+\.\d+\.\d+\s*\(KHTML, like Gecko\)/, '');
    display = display.replace(/ Version\/\d+\.\d+\s*Safari\/\d+\.\d+$/, '');
    display = display.replace(/ Chrome\/\d+\.\d+\.\d+\.\d+$/, '');
    display = display.replace(/ Safari\/\d+\.\d+$/, '');
    display = display.replace(/ Edg\/\d+\.\d+\.\d+\.\d+$/, '');
    display = display.replace(/ OPR\/\d+\.\d+\.\d+\.\d+$/, '');
    display = display.replace(/ Firefox\/\d+\.\d+$/, '');
    display = display.replace(/ like Mac OS X/, '');
    display = display.replace(/ CPU iPhone OS \d+_\d+/, '');
    display = display.replace(/ CPU OS \d+_\d+/, '');
    display = display.replace(/\s+/g, ' ').trim();

    if (display.length > 200) display = display.substring(0, 200) + '...';
    return display || 'Unknown Device';
}

async function sendAdminSecurityAlert({
    email,
    username,
    action,
    targetType = null,
    targetId = null,
    detail = null,
    ipAddress = null,
    userAgent = null,
    when = null
}) {
    if (!email) {
        return { success: false, error: 'No email provided' };
    }

    const eventTime = when ? new Date(when) : new Date();
    const dateStr = eventTime.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
    const timeStr = eventTime.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: true
    });

    const safe = (v) => escapeHtml(v == null ? '' : String(v));

    const LABELS = {
        ADMIN_LOGIN_NEW_DEVICE:     'New admin sign-in detected',
        MFA_ENABLED:                'Two-factor authentication enabled',
        MFA_DISABLED:               'Two-factor authentication disabled',
        PERMISSION_GRANTED:         'Admin permission granted',
        PERMISSION_REVOKED:         'Admin permission revoked',
        ROLE_CHANGED:               'Admin role changed',
        WALLET_ADJUSTED:            'Customer wallet adjusted',
        WALLET_CREDITED:            'Customer wallet credited',
        WALLET_DEBITED:             'Customer wallet debited',
        REFUND_CREATED:             'Refund issued',
        PROVIDER_CREDENTIAL_CHANGED:'Provider credentials changed',
        ADMIN_CREATED:              'New admin account created',
        ADMIN_DELETED:              'Admin account deleted',
        SECURITY_SETTINGS_CHANGED:  'Security settings changed'
    };
    const title = LABELS[action] || 'Admin security event';

    const html = `
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6f8;padding:40px 20px;margin:0;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 14px rgba(0,0,0,0.06);">
            <div style="text-align:center;margin-bottom:20px;">
                <div style="display:inline-block;width:56px;height:56px;border-radius:50%;background:#fdf3e8;color:#b45309;font-size:24px;line-height:56px;text-align:center;">&#128274;</div>
            </div>
            <h2 style="font-size:20px;font-weight:700;color:#0c3d4a;margin:0 0 8px;text-align:center;">${safe(title)}</h2>
            <p style="color:#4a6070;font-size:14px;margin:0 0 20px;text-align:center;">
                Hi ${safe(username || 'Admin')}, a security event occurred on your MilesSpace admin account.
            </p>

            <div style="background:#f8fafb;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;color:#4a6070;">
                    <tr><td style="padding:5px 0;">Event</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${safe(action)}</td></tr>
                    <tr><td style="padding:5px 0;">When</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${safe(dateStr)} · ${safe(timeStr)}</td></tr>
                    ${targetType ? `<tr><td style="padding:5px 0;">Target type</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${safe(targetType)}</td></tr>` : ''}
                    ${targetId   ? `<tr><td style="padding:5px 0;">Target</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;word-break:break-all;">${safe(targetId)}</td></tr>` : ''}
                    ${ipAddress  ? `<tr><td style="padding:5px 0;">IP address</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${safe(ipAddress)}</td></tr>` : ''}
                </table>
            </div>

            ${detail ? `
                <div style="background:#f8fafb;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
                    <p style="font-size:11px;font-weight:700;color:#6b7d8a;margin:0 0 8px;letter-spacing:.08em;">DETAIL</p>
                    <pre style="margin:0;font-family:'JetBrains Mono',Consolas,monospace;font-size:12px;color:#0c3d4a;white-space:pre-wrap;word-break:break-all;">${safe(JSON.stringify(detail, null, 2))}</pre>
                </div>
            ` : ''}

            ${userAgent ? `
                <p style="color:#92a8b4;font-size:12px;margin:0 0 12px;">
                    Device: ${safe(parseUserAgentForDisplay(userAgent))}
                </p>
            ` : ''}

            <div style="background:#fdf3e8;border-radius:10px;padding:14px 18px;margin:20px 0;">
                <p style="margin:0;color:#7a3517;font-size:13px;line-height:1.6;">
                    If you did not perform this action, sign in immediately and review your
                    active sessions. Contact a super admin if anything looks wrong.
                </p>
            </div>

            <div style="text-align:center;margin-top:22px;">
                <a href="${SITE_URL}/admin/settings"
                   style="display:inline-block;background:#0c3d4a;color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:12px 22px;border-radius:10px;">
                   Review security settings
                </a>
            </div>

            <div style="border-top:1px solid #e4e8ec;padding-top:16px;margin-top:22px;">
                <p style="color:#92a8b4;font-size:12px;text-align:center;margin:0;">
                    © ${new Date().getFullYear()} MilesSpace. All rights reserved.
                </p>
            </div>
        </div>
        </body></html>
    `;

    return sendEmail(email, `🔐 ${title} — MilesSpace Admin`, html);
}

// ═══════════════════════════════════════════════════════════════════
//  AUTH EMAILS
// ═══════════════════════════════════════════════════════════════════

// ─── REGISTRATION OTP ────────────────────────────────────────────
async function sendRegistrationOTP(email, username, otp) {
    const html = `
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Verify your MilesSpace account</title></head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6f8;padding:40px 20px;margin:0;">
            <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 14px rgba(0,0,0,0.06);">
                <div style="text-align:center;margin-bottom:24px;">
                    <div style="display:inline-block;width:56px;height:56px;border-radius:50%;background:#e8f4f7;color:#0c3d4a;font-size:24px;line-height:56px;text-align:center;">✉️</div>
                </div>
                <h2 style="font-size:22px;font-weight:700;color:#0c3d4a;margin:0 0 8px;text-align:center;">Verify your email</h2>
                <p style="color:#4a6070;font-size:14px;margin:0 0 20px;text-align:center;">
                    Hi ${escapeHtml(username || 'there')}, use the code below to finish creating your MilesSpace account.
                </p>
                <div style="background:#e8f4f7;border-radius:12px;padding:24px;text-align:center;margin:24px 0;">
                    <p style="font-size:11px;color:#4a6070;letter-spacing:.08em;font-weight:700;margin:0 0 8px;">YOUR VERIFICATION CODE</p>
                    <div style="font-family:'JetBrains Mono',Consolas,monospace;font-size:36px;font-weight:800;color:#0c3d4a;letter-spacing:10px;">${escapeHtml(otp)}</div>
                    <p style="font-size:12px;color:#92a8b4;margin:10px 0 0;">Expires in 10 minutes</p>
                </div>
                <div style="background:#fdf3e8;border-radius:10px;padding:14px 18px;margin:22px 0;">
                    <p style="margin:0;color:#7a3517;font-size:13px;line-height:1.6;">
                        If you didn't create a MilesSpace account, you can safely ignore this email. Someone may have typed your address by mistake.
                    </p>
                </div>
                <div style="border-top:1px solid #e4e8ec;padding-top:16px;margin-top:22px;">
                    <p style="color:#92a8b4;font-size:12px;text-align:center;margin:0;">
                        © ${new Date().getFullYear()} MilesSpace. All rights reserved.
                    </p>
                </div>
            </div>
        </body></html>
    `;
    return sendEmail(email, '🔐 Verify your MilesSpace account', html);
}

// ─── 2FA EMAIL (canonical name) ──────────────────────────────────
async function send2FAEmail(email, username, otp, deviceInfo, location, ipAddress) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    let deviceDisplay = 'Unknown Device';
    let browserDisplay = 'Unknown';
    let osDisplay = 'Unknown';

    if (deviceInfo) {
        const rawUA = deviceInfo.rawUserAgent || deviceInfo.userAgent || '';
        if (rawUA && rawUA !== 'Unknown') deviceDisplay = parseUserAgentForDisplay(rawUA);
        else if (deviceInfo.device && deviceInfo.device !== 'Unknown') deviceDisplay = deviceInfo.device;
        if (deviceInfo.browser && deviceInfo.browser !== 'Unknown') browserDisplay = deviceInfo.browser;
        if (deviceInfo.os && deviceInfo.os !== 'Unknown') osDisplay = deviceInfo.os;
    }

    let displayLocation = location || 'Unknown';
    if (IS_DEVELOPMENT && ['Localhost', '127.0.0.1', '::1'].includes(location)) displayLocation = 'Development Environment';

    let displayIp = ipAddress || 'Unknown';
    if (IS_DEVELOPMENT && ['::1', '127.0.0.1'].includes(displayIp)) displayIp = '127.0.0.1 (localhost)';

    const html = loadTemplate('2fa-code', {
        userName: username || 'User',
        loginDate: dateStr,
        loginTime: timeStr,
        when: `${dateStr} · ${timeStr}`,
        device: deviceDisplay,
        browser: browserDisplay,
        os: osDisplay,
        rawUserAgent: deviceInfo?.rawUserAgent || deviceInfo?.userAgent || 'Unknown',
        location: displayLocation,
        ipAddress: displayIp,
        otp,
        otpExpiryMinutes: '10',
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        subject: 'Two-Factor Authentication - MilesSpace'
    });

    return sendEmail(email, '🔐 Verification Needed — MilesSpace', html);
}

async function sendVerificationEmail(email, username, code) {
    const html = loadTemplate('verification', {
        userName: username || 'User',
        otp: code,
        title: 'Verify Your Email',
        message: 'Thanks for joining MilesSpace! Please verify your email address to complete your registration.',
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        subject: 'Verify Your Email — MilesSpace'
    });
    return sendEmail(email, 'Verify Your Email — MilesSpace', html);
}

async function sendPasswordResetOTP(email, username, code) {
    const html = loadTemplate('password-reset', {
        userName: username || 'User',
        otp: code,
        title: 'Reset Your Password',
        message: 'We received a request to reset your password for your MilesSpace account.',
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        subject: 'Reset Your Password — MilesSpace'
    });
    return sendEmail(email, 'Reset Your Password — MilesSpace', html);
}

async function sendWelcomeEmail(email, username) {
    const html = loadTemplate('welcome', {
        userName: username || 'User',
        title: 'Welcome to MilesSpace! 🎉',
        message: "We're excited to have you join the MilesSpace community! Start exploring our marketplace, virtual numbers, social boosting, and more.",
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        subject: 'Welcome to MilesSpace! 🎉'
    });
    return sendEmail(email, 'Welcome to MilesSpace! 🎉', html);
}

async function sendLoginAlert(email, username, deviceInfo, location, ipAddress) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    let deviceDisplay = 'Unknown Device';
    if (deviceInfo) {
        const rawUA = deviceInfo.rawUserAgent || deviceInfo.userAgent || '';
        if (rawUA && rawUA !== 'Unknown') deviceDisplay = parseUserAgentForDisplay(rawUA);
        else if (deviceInfo.device) deviceDisplay = deviceInfo.device;
    }

    let displayLocation = location || 'Unknown';
    if (IS_DEVELOPMENT && ['Localhost', '127.0.0.1', '::1'].includes(location)) displayLocation = 'Development Environment';

    let displayIp = ipAddress || 'Unknown';
    if (IS_DEVELOPMENT && ['::1', '127.0.0.1'].includes(displayIp)) displayIp = '127.0.0.1 (localhost)';

    const html = loadTemplate('login-alert', {
        userName: username || 'User',
        loginDate: dateStr,
        loginTime: timeStr,
        device: deviceDisplay,
        browser: deviceInfo?.browser || 'Unknown',
        os: deviceInfo?.os || 'Unknown',
        location: displayLocation,
        ipAddress: displayIp,
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        secureAccountUrl: `${SITE_URL}/profile?tab=security`,
        subject: 'New Login Detected — MilesSpace'
    });
    return sendEmail(email, '🛡️ New Login Detected — MilesSpace', html);
}

// ═══════════════════════════════════════════════════════════════════
//  TRANSACTION EMAILS
// ═══════════════════════════════════════════════════════════════════

async function sendGiftOrderConfirmation(email, username, orderRef, productName, recipientName, amount, currency) {
    const formattedAmount = formatAmountForCurrency(amount, currency);

    const html = loadTemplate('gift-order', {
        userName: username || 'User',
        orderRef: orderRef || 'N/A',
        productName: productName || 'Gift',
        recipientName: recipientName || 'N/A',
        amount: formattedAmount,
        currency: currency || 'NGN',
        title: 'Gift Order Confirmed 🎁',
        message: `Your gift "${productName}" has been ordered and will be delivered to ${recipientName}.`,
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        subject: `Gift Order Confirmed — ${orderRef}`
    });
    return sendEmail(email, `🎁 Gift Order Confirmed — ${orderRef}`, html);
}

async function sendCryptoDeliveryEmail(order) {
    try {
        const email = order.user_email || order.email;
        if (!email) return { success: false, error: 'No email provided' };

        const amount = parseFloat(order.crypto_amount || order.amount || 0).toFixed(8);
        const coin = order.coin || 'BTC';
        const txHash = order.tx_hash || 'N/A';
        const address = order.wallet_address || 'N/A';

        const html = loadTemplate('crypto-delivery', {
            userName: order.user_username || 'User',
            amount, coin, txHash, address,
            title: 'Crypto Delivered! 🚀',
            message: `Your ${amount} ${coin} has been sent to your wallet.`,
            logoUrl: LOGO_URL,
            currentYear: new Date().getFullYear(),
            subject: `✅ ${amount} ${coin} Sent to Your Wallet — MilesSpace`
        });
        return sendEmail(email, `✅ ${amount} ${coin} Sent to Your Wallet — MilesSpace`, html);
    } catch (error) {
        console.error('Crypto delivery email error:', error);
        return { success: false, error: error.message };
    }
}

async function sendWithdrawalConfirmation(email, username, amount, currency, destination, reference) {
    const formattedAmount = formatAmountForCurrency(amount, currency);

    const html = loadTemplate('withdrawal-confirmation', {
        userName: username || 'User',
        amount: formattedAmount,
        currency: currency || 'NGN',
        destination: destination || 'N/A',
        reference: reference || 'N/A',
        title: 'Withdrawal Requested 💸',
        message: `A withdrawal of ${formattedAmount} has been requested from your MilesSpace account.`,
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        subject: `Withdrawal Requested — ${reference || 'MilesSpace'}`
    });
    return sendEmail(email, `💸 Withdrawal Requested — ${reference || 'MilesSpace'}`, html);
}

async function sendPaymentReceived(email, username, amount, currency, reference, source) {
    const formattedAmount = formatAmountForCurrency(amount, currency);
    const walletLabel = currency === 'USD' ? 'USD Wallet' : 'Naira Wallet';

    const html = loadTemplate('payment-received', {
        userName: username || 'User',
        amount: formattedAmount,
        currency: currency || 'NGN',
        reference: reference || 'N/A',
        source: source || 'N/A',
        walletLabel,
        title: 'Payment Received 💰',
        message: `A payment of ${formattedAmount} has been received in your ${walletLabel}.`,
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        subject: `💰 Payment Received — ${reference || 'MilesSpace'}`
    });
    return sendEmail(email, `💰 Payment Received — ${reference || 'MilesSpace'}`, html);
}

async function sendCashbackReward(email, username, amount, source, transactionId) {
    const formattedAmount = '₦' + Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const html = loadTemplate('cashback-reward', {
        userName: username || 'User',
        amount: formattedAmount,
        source: source || 'Cashback Reward',
        transactionId: transactionId || 'N/A',
        title: 'Cashback Reward Earned ⭐',
        message: `You've earned ${formattedAmount} cashback from ${source || 'your purchase'}!`,
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        subject: `⭐ Cashback Reward — ${formattedAmount} Earned!`
    });
    return sendEmail(email, `⭐ Cashback Reward — ${formattedAmount} Earned!`, html);
}

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
    const rateStr     = `1 ${sourceCurrency} = ${targetCurrency === 'USD' ? '$' : '₦'}${Number(fxRate).toFixed(4)}`;
    const dateStr     = completedAt ? new Date(completedAt).toLocaleString('en-NG') : new Date().toLocaleString('en-NG');

    const html = `
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6f8;padding:40px 20px;margin:0;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 14px rgba(0,0,0,0.06);">
            <div style="text-align:center;margin-bottom:24px;">
                <div style="display:inline-block;width:56px;height:56px;border-radius:50%;background:#e5f6ee;color:#1c8f63;font-size:24px;line-height:56px;text-align:center;">✓</div>
            </div>
            <h2 style="font-size:22px;font-weight:700;color:#0c3d4a;margin:0 0 8px;text-align:center;">Wallet funded successfully</h2>
            <p style="color:#4a6070;font-size:14px;margin:0 0 24px;text-align:center;">Hi ${escapeHtml(username || 'there')}, your deposit has been confirmed and your wallet has been credited.</p>

            <div style="background:#e8f4f7;border-radius:12px;padding:22px;text-align:center;margin-bottom:22px;">
                <div style="font-size:11px;color:#4a6070;letter-spacing:.08em;font-weight:700;margin-bottom:6px;">CREDITED TO YOUR WALLET</div>
                <div style="font-size:32px;font-weight:800;color:#0c3d4a;letter-spacing:-0.02em;">${escapeHtml(creditedStr)}</div>
                <div style="font-size:12px;color:#4a6070;margin-top:4px;">from ${escapeHtml(sourceStr)}</div>
            </div>

            <div style="background:#f8fafb;border-radius:10px;padding:18px 20px;margin-bottom:22px;">
                <p style="font-size:11px;font-weight:700;color:#6b7d8a;margin:0 0 12px;letter-spacing:.08em;">TRANSACTION DETAILS</p>
                <table style="width:100%;border-collapse:collapse;font-size:13px;color:#4a6070;">
                    <tr><td style="padding:5px 0;">Reference</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${escapeHtml(internalReference)}</td></tr>
                    <tr><td style="padding:5px 0;">Amount paid</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${escapeHtml(sourceStr)}</td></tr>
                    <tr><td style="padding:5px 0;">Rate used</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${escapeHtml(rateStr)}</td></tr>
                    <tr><td style="padding:5px 0;">Rate source</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${escapeHtml(fxSource || 'MILESSPACE')}</td></tr>
                    <tr><td style="padding:5px 0;">Credited</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${escapeHtml(creditedStr)}</td></tr>
                    <tr><td style="padding:5px 0;">Date</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${escapeHtml(dateStr)}</td></tr>
                </table>
            </div>

            <p style="font-size:12px;color:#92a8b4;text-align:center;margin:22px 0 0;">
                View your wallet: <a href="${SITE_URL}/fund" style="color:#0c3d4a;font-weight:600;">${SITE_URL}/fund</a>
            </p>

            <div style="border-top:1px solid #e4e8ec;padding-top:16px;margin-top:22px;">
                <p style="color:#92a8b4;font-size:12px;text-align:center;margin:0;">© ${new Date().getFullYear()} MilesSpace. All rights reserved.</p>
            </div>
        </div>
        </body></html>
    `;

    return sendEmail(email, `💰 Deposit received — ${creditedStr}`, html);
}

// ═══════════════════════════════════════════════════════════════════
//  eSIM DELIVERY / FAILURE EMAILS
// ═══════════════════════════════════════════════════════════════════
async function sendEsimDeliveryEmail({
    email,
    username,
    reference,
    countryName,
    planName,
    dataDisplay,
    validityDays,
    totalUsd,
    totalNgn,
    debitCurrency,
    debitAmount,
    qrCodeUrl,
    activationCode,
    lpaString,
    smdpAddress,
    matchingId,
    instructions,
}) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    const hasManual = Boolean(lpaString || activationCode || smdpAddress || matchingId);

    let manualBlock = '';
    if (hasManual) {
        manualBlock = `
            <div style="background:#f8fafb;border:1px solid #e4e8ec;border-radius:10px;padding:18px 20px;margin:22px 0;">
                <p style="font-size:11px;font-weight:700;color:#6b7d8a;margin:0 0 14px;letter-spacing:.08em;">MANUAL ACTIVATION (if QR scan fails)</p>
                ${lpaString ? `
                    <p style="margin:0 0 6px;color:#4a6070;font-size:13px;"><strong>LPA String:</strong></p>
                    <code style="display:block;word-break:break-all;background:#fff;border:1px solid #e4e8ec;border-radius:6px;padding:10px 12px;font-size:12px;color:#0c3d4a;margin-bottom:14px;font-family:monospace;">${lpaString}</code>
                ` : ''}
                ${smdpAddress ? `
                    <p style="margin:0 0 6px;color:#4a6070;font-size:13px;"><strong>SM-DP+ Address:</strong></p>
                    <code style="display:block;word-break:break-all;background:#fff;border:1px solid #e4e8ec;border-radius:6px;padding:10px 12px;font-size:12px;color:#0c3d4a;margin-bottom:14px;font-family:monospace;">${smdpAddress}</code>
                ` : ''}
                ${matchingId ? `
                    <p style="margin:0 0 6px;color:#4a6070;font-size:13px;"><strong>Matching ID:</strong></p>
                    <code style="display:block;word-break:break-all;background:#fff;border:1px solid #e4e8ec;border-radius:6px;padding:10px 12px;font-size:12px;color:#0c3d4a;margin-bottom:14px;font-family:monospace;">${matchingId}</code>
                ` : ''}
                ${activationCode ? `
                    <p style="margin:0 0 6px;color:#4a6070;font-size:13px;"><strong>Activation Code:</strong></p>
                    <code style="display:block;word-break:break-all;background:#fff;border:1px solid #e4e8ec;border-radius:6px;padding:10px 12px;font-size:12px;color:#0c3d4a;font-family:monospace;">${activationCode}</code>
                ` : ''}
            </div>
        `;
    }

    const html = loadTemplate('esim-delivery', {
        userName: username || 'Traveller',
        reference: reference || 'N/A',
        countryName: countryName || '—',
        planName: planName || 'eSIM Plan',
        dataDisplay: dataDisplay || '—',
        validityDays: validityDays || '—',
        totalUsd: totalUsd != null ? `$${Number(totalUsd).toFixed(2)}` : '—',
        totalNgn: totalNgn != null ? `₦${Number(totalNgn).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—',
        debitCurrency: debitCurrency || '—',
        debitAmount: debitAmount != null ? Number(debitAmount).toFixed(2) : '—',
        qrCodeUrl: qrCodeUrl || '',
        hasQr: qrCodeUrl ? '1' : '',
        manualBlock,
        instructions: instructions || '',
        hasInstructions: instructions ? '1' : '',
        purchaseDate: dateStr,
        purchaseTime: timeStr,
        title: 'Your eSIM is ready',
        message: `Your ${countryName || ''} eSIM has been activated and is ready to install.`,
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        subject: `📱 Your eSIM is Ready — ${reference}`
    });

    return sendEmail(email, `📱 Your eSIM is Ready — ${countryName || ''}`, html);
}

async function sendEsimFailureEmail({
    email,
    username,
    reference,
    countryName,
    planName,
    amountUsd,
    amountNgn,
    debitCurrency,
    reason,
    refunded,
}) {
    const refundBlock = refunded ? `
        <div style="background:#e5f6ee;border-radius:10px;padding:16px 20px;margin:20px 0;">
            <p style="margin:0;color:#1c8f63;font-size:14px;line-height:1.55;">
                <strong>✅ Refunded.</strong> The full amount has been returned to your MilesSpace wallet.
            </p>
        </div>
    ` : '';

    const html = loadTemplate('esim-failure', {
        userName: username || 'User',
        reference: reference || 'N/A',
        countryName: countryName || '—',
        planName: planName || 'eSIM Plan',
        amountUsd: amountUsd != null ? `$${Number(amountUsd).toFixed(2)}` : '—',
        amountNgn: amountNgn != null ? `₦${Number(amountNgn).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—',
        debitCurrency: debitCurrency || '—',
        reason: reason || 'The order could not be completed by the provider.',
        refundBlock,
        title: 'Your eSIM order could not be completed',
        message: `We weren't able to deliver your ${countryName || ''} eSIM. Here's what happened:`,
        logoUrl: LOGO_URL,
        currentYear: new Date().getFullYear(),
        subject: `⚠️ eSIM Order Failed — ${reference}`
    });

    return sendEmail(email, `⚠️ eSIM Order Failed — ${countryName || ''}`, html);
}

// ═══════════════════════════════════════════════════════════════════
//  GIFT CARD DELIVERY / FAILURE EMAILS
// ═══════════════════════════════════════════════════════════════════
async function sendGiftCardDeliveryEmail(data) {
    const {
        email, username, reference, cardName, faceValue, currency,
        voucherCode, voucherSerial, instructions,
        totalUsd, totalNgn, debitCurrency, debitAmount
    } = data;

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

    const html = `
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6f8;padding:40px 20px;margin:0;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 14px rgba(0,0,0,0.06);">
            <div style="text-align:center;margin-bottom:24px;">
                <div style="display:inline-block;width:56px;height:56px;border-radius:50%;background:#e5f6ee;color:#1c8f63;font-size:24px;line-height:56px;">✓</div>
            </div>
            <h2 style="font-size:22px;font-weight:700;color:#0c3d4a;margin:0 0 8px;text-align:center;">Your gift card is ready 🎁</h2>
            <p style="color:#4a6070;font-size:14px;margin:0 0 24px;text-align:center;">Hi ${escapeHtml(username || 'Customer')}, your ${escapeHtml(cardName || 'gift card')} has been delivered.</p>

            <div style="background:#f8fafb;border-radius:10px;padding:18px 20px;margin-bottom:22px;">
                <p style="font-size:11px;font-weight:700;color:#6b7d8a;margin:0 0 12px;letter-spacing:.08em;">ORDER SUMMARY</p>
                <table style="width:100%;border-collapse:collapse;font-size:13px;color:#4a6070;">
                    <tr><td style="padding:5px 0;">Card</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${escapeHtml(cardName || '—')}</td></tr>
                    <tr><td style="padding:5px 0;">Face value</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${escapeHtml(currency || '')} ${faceValue ?? '—'}</td></tr>
                    <tr><td style="padding:5px 0;">Reference</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${escapeHtml(reference || '—')}</td></tr>
                    <tr><td style="padding:5px 0;">Paid</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${totalUsd != null ? '$' + Number(totalUsd).toFixed(2) : '—'}</td></tr>
                    <tr><td style="padding:5px 0;">Date</td><td style="padding:5px 0;text-align:right;font-weight:600;color:#0c3d4a;">${dateStr}</td></tr>
                </table>
            </div>

            <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:12px;padding:20px;margin-bottom:20px;text-align:center;">
                <p style="font-size:11px;font-weight:700;color:#92400e;margin:0 0 10px;letter-spacing:.08em;">YOUR GIFT CARD CODE</p>
                <p style="font-family:monospace;font-size:18px;font-weight:700;color:#78350f;margin:0;word-break:break-all;letter-spacing:.05em;">${escapeHtml(voucherCode || '—')}</p>
                ${voucherSerial ? `<p style="font-size:12px;color:#92400e;margin-top:10px;">Serial: ${escapeHtml(voucherSerial)}</p>` : ''}
            </div>

            ${instructions ? `<div style="background:#fdf3e8;border-radius:10px;padding:14px 18px;margin:20px 0;color:#7a3517;font-size:13px;line-height:1.65;">${escapeHtml(instructions)}</div>` : ''}

            <div style="border-top:1px solid #e4e8ec;padding-top:16px;margin-top:24px;">
                <p style="color:#92a8b4;font-size:12px;text-align:center;margin:0;">
                    Need help? Reply to this email or contact support.<br>
                    © ${now.getFullYear()} MilesSpace
                </p>
            </div>
        </div>
        </body></html>
    `;

    return sendEmail(email, `🎁 Your ${cardName || 'Gift Card'} is Ready — ${reference || ''}`, html);
}

async function sendGiftCardFailureEmail(data) {
    const { email, username, reference, cardName, faceValue, currency, reason, refunded } = data;
    const now = new Date();

    const refundBlock = refunded ? `
        <div style="background:#e5f6ee;border-radius:10px;padding:16px 20px;margin:20px 0;">
            <p style="margin:0;color:#1c8f63;font-size:14px;line-height:1.55;">
                <strong>✅ Refunded.</strong> The full amount has been returned to your MilesSpace wallet.
            </p>
        </div>
    ` : '';

    const html = `
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"></head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6f8;padding:40px 20px;margin:0;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:40px 32px;">
            <div style="text-align:center;margin-bottom:24px;">
                <div style="display:inline-block;width:56px;height:56px;border-radius:50%;background:#fbeaea;color:#d34848;font-size:24px;line-height:56px;">!</div>
            </div>
            <h2 style="font-size:20px;font-weight:700;color:#0c3d4a;margin:0 0 8px;text-align:center;">Your gift card purchase could not be completed</h2>
            <p style="color:#4a6070;font-size:14px;margin:0 0 20px;text-align:center;">Hi ${escapeHtml(username || 'Customer')}, we couldn't deliver your ${escapeHtml(cardName || 'gift card')}.</p>

            <div style="background:#fbeaea;border-radius:10px;padding:16px 20px;margin:20px 0;">
                <p style="margin:0 0 6px;color:#d34848;font-size:12px;font-weight:700;">REASON</p>
                <p style="margin:0;color:#7a2b2b;font-size:13px;line-height:1.55;">${escapeHtml(reason || 'The provider declined this purchase.')}</p>
            </div>

            <p style="color:#4a6070;font-size:13px;"><strong>Reference:</strong> ${escapeHtml(reference || '—')}</p>
            <p style="color:#4a6070;font-size:13px;"><strong>Card:</strong> ${escapeHtml(cardName || '—')}</p>
            ${faceValue ? `<p style="color:#4a6070;font-size:13px;"><strong>Face value:</strong> ${escapeHtml(currency || '')} ${faceValue}</p>` : ''}

            ${refundBlock}

            <div style="border-top:1px solid #e4e8ec;padding-top:16px;margin-top:24px;">
                <p style="color:#92a8b4;font-size:12px;text-align:center;margin:0;">© ${now.getFullYear()} MilesSpace</p>
            </div>
        </div>
        </body></html>
    `;

    return sendEmail(email, `⚠️ Gift Card Order Failed — ${reference || ''}`, html);
}

// ─── STATUS ───
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
    sendOTPEmail: send2FAEmail,        // ← FIX: alias so routes calling
                                        //   emailService.sendOTPEmail() work.
    sendVerificationEmail,
    sendPasswordResetOTP,
    sendWelcomeEmail,
    sendLoginAlert,

    // Transactions
    sendGiftOrderConfirmation,
    sendCryptoDeliveryEmail,
    sendWithdrawalConfirmation,
    sendPaymentReceived,
    sendCashbackReward,
    sendDepositConfirmation,
    sendAdminSecurityAlert,

    // eSIM
    sendEsimDeliveryEmail,
    sendEsimFailureEmail,
    sendLoginOTP:   send2FAEmail, 

    // Gift cards
    sendGiftCardDeliveryEmail,
    sendGiftCardFailureEmail
};