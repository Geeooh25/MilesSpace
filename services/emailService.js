// ─── services/emailService.js ───
// Production Email Service - Brevo v6.x Compatible
// No console spam, proper error handling, graceful fallback

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ─── CONFIGURATION ───
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'no-reply@milesspace.com';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'MilesSpace';
const BREVO_TEMPLATE_FOLDER = path.join(__dirname, '../templates/emails');

// ─── STATE ───
let enabled = false;
let initError = null;

// ─── SILENT INITIALIZATION ───
try {
    if (BREVO_API_KEY && BREVO_API_KEY.length > 10) {
        // Check if it's a valid API key format
        if (BREVO_API_KEY.startsWith('xsmtpsib-')) {
            // SMTP key detected - try to use it anyway with direct API
            // Some Brevo accounts allow SMTP keys for API calls
            enabled = true;
        } else if (BREVO_API_KEY.startsWith('xkeysib-') || BREVO_API_KEY.startsWith('xxkeysib-')) {
            enabled = true;
        } else if (BREVO_API_KEY.length > 20) {
            // Could be a valid key in another format
            enabled = true;
        }
    }
    
    if (!enabled) {
        initError = 'Invalid or missing API key';
    }
} catch (e) {
    initError = e.message;
    enabled = false;
}

// ─── SEND EMAIL (Core) ───
async function sendEmail(to, subject, html, textContent = null) {
    // If disabled, return early with success: false
    if (!enabled || !BREVO_API_KEY) {
        return { 
            success: false, 
            disabled: true,
            message: 'Email service is disabled'
        };
    }

    try {
        const url = 'https://api.brevo.com/v3/smtp/email';
        
        const payload = {
            sender: {
                name: BREVO_SENDER_NAME,
                email: BREVO_SENDER_EMAIL
            },
            to: Array.isArray(to) 
                ? to.map(email => ({ email })) 
                : [{ email: to }],
            subject: subject,
            htmlContent: html
        };
        
        if (textContent) {
            payload.textContent = textContent;
        }

        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'api-key': BREVO_API_KEY
            },
            timeout: 15000
        });

        return { 
            success: true, 
            messageId: response.data.messageId || 'sent' 
        };
        
    } catch (error) {
        // Log error details for debugging
        let errorMessage = error.message;
        if (error.response) {
            // If the response has more details, use them
            errorMessage = error.response.data?.message || error.response.statusText || error.message;
        }
        
        return { 
            success: false, 
            error: errorMessage,
            details: error.response?.data || null
        };
    }
}

// ─── TEMPLATE LOADER ───
function loadTemplate(templateName, data = {}) {
    try {
        const templatePath = path.join(BREVO_TEMPLATE_FOLDER, `${templateName}.html`);
        
        if (!fs.existsSync(templatePath)) {
            return generateFallbackTemplate(templateName, data);
        }
        
        let html = fs.readFileSync(templatePath, 'utf8');
        
        // Replace variables
        Object.keys(data).forEach(key => {
            const regex = new RegExp(`{{${key}}}`, 'g');
            html = html.replace(regex, data[key] || '');
        });
        
        return html;
        
    } catch (error) {
        return generateFallbackTemplate(templateName, data);
    }
}

// ─── FALLBACK TEMPLATE ───
function generateFallbackTemplate(type, data) {
    const baseStyle = `
        font-family: 'DM Sans', Arial, sans-serif;
        background: #f4f6f8;
        padding: 40px 20px;
        margin: 0;
    `;
    
    const containerStyle = `
        max-width: 520px;
        margin: 0 auto;
        background: #ffffff;
        border-radius: 16px;
        padding: 40px 32px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.06);
    `;
    
    const headerStyle = `
        text-align: center;
        margin-bottom: 28px;
    `;
    
    const logoStyle = `
        font-family: 'Syne', sans-serif;
        font-weight: 800;
        font-size: 22px;
        color: #0c3d4a;
    `;
    
    const titleStyle = `
        font-family: 'Syne', sans-serif;
        font-size: 20px;
        font-weight: 700;
        color: #0c3d4a;
        margin-bottom: 12px;
    `;
    
    const textStyle = `
        color: #4a6070;
        font-size: 15px;
        line-height: 1.6;
        margin-bottom: 20px;
    `;
    
    const codeStyle = `
        background: #e8f4f7;
        border-radius: 10px;
        padding: 20px;
        text-align: center;
        margin-bottom: 24px;
    `;
    
    const codeTextStyle = `
        font-family: 'Syne', sans-serif;
        font-size: 36px;
        font-weight: 800;
        color: #0c3d4a;
        letter-spacing: 8px;
    `;
    
    const detailsStyle = `
        background: #f8f9fa;
        border-radius: 10px;
        padding: 16px 20px;
        margin-bottom: 24px;
    `;
    
    const detailRowStyle = `
        display: flex;
        justify-content: space-between;
        padding: 6px 0;
        border-bottom: 1px solid #e4e8ec;
    `;
    
    const detailLabelStyle = `
        color: #4a6070;
        font-size: 13px;
    `;
    
    const detailValueStyle = `
        color: #0c3d4a;
        font-weight: 600;
        font-size: 13px;
    `;
    
    const buttonStyle = `
        text-align: center;
        margin-top: 16px;
    `;
    
    const buttonLinkStyle = `
        background: #0c3d4a;
        color: #fff;
        padding: 10px 24px;
        border-radius: 8px;
        text-decoration: none;
        font-weight: 600;
        font-size: 14px;
        display: inline-block;
    `;
    
    const footerStyle = `
        border-top: 1px solid #e4e8ec;
        padding-top: 20px;
        margin-top: 20px;
    `;
    
    const footerTextStyle = `
        color: #92a8b4;
        font-size: 12px;
        text-align: center;
        margin: 0;
    `;
    
    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${data.subject || 'MilesSpace'}</title>
        </head>
        <body style="${baseStyle}">
            <div style="${containerStyle}">
                <div style="${headerStyle}">
                    <div style="${logoStyle}">
                        🏦 MilesSpace
                    </div>
                    <p style="color: #4a6070; font-size: 14px; margin-top: 4px;">
                        Everything Digital. One Trusted Marketplace.
                    </p>
                </div>
                
                <h2 style="${titleStyle}">
                    ${data.title || 'Hello!'}
                </h2>
                
                <p style="${textStyle}">
                    ${data.message || 'Thank you for using MilesSpace.'}
                </p>
    `;
    
    if (data.code) {
        html += `
                <div style="${codeStyle}">
                    <p style="font-size: 12px; color: #4a6070; margin-bottom: 6px;">
                        Your Code
                    </p>
                    <div style="${codeTextStyle}">
                        ${data.code}
                    </div>
                    <p style="font-size: 12px; color: #92a8b4; margin-top: 6px;">
                        This code expires in 10 minutes
                    </p>
                </div>
        `;
    }
    
    if (data.details && Object.keys(data.details).length > 0) {
        html += `
                <div style="${detailsStyle}">
        `;
        Object.entries(data.details).forEach(([key, value]) => {
            html += `
                    <div style="${detailRowStyle}">
                        <span style="${detailLabelStyle}">${key}</span>
                        <span style="${detailValueStyle}">${value}</span>
                    </div>
            `;
        });
        html += `
                </div>
        `;
    }
    
    if (data.button) {
        html += `
                <div style="${buttonStyle}">
                    <a href="${data.buttonUrl || '#'}" style="${buttonLinkStyle}">
                        ${data.buttonText || 'Learn More'}
                    </a>
                </div>
        `;
    }
    
    html += `
                <div style="${footerStyle}">
                    <p style="${footerTextStyle}">
                        © 2024 MilesSpace. All rights reserved.
                    </p>
                </div>
            </div>
        </body>
        </html>
    `;
    
    return html;
}

// ─── EMAIL TEMPLATE FUNCTIONS ───

// 1. Send Verification Email
async function sendVerificationEmail(email, username, code) {
    const html = loadTemplate('verification', {
        username: username || 'User',
        code: code,
        title: 'Verify Your Email',
        message: 'Thanks for joining MilesSpace! Please verify your email address to complete your registration.',
        subject: 'Verify Your Email — MilesSpace'
    });
    return sendEmail(email, 'Verify Your Email — MilesSpace', html);
}

// 2. Send Password Reset OTP
async function sendPasswordResetOTP(email, username, code) {
    const html = loadTemplate('password-reset', {
        username: username || 'User',
        code: code,
        title: 'Reset Your Password',
        message: 'We received a request to reset your password for your MilesSpace account.',
        subject: 'Reset Your Password — MilesSpace'
    });
    return sendEmail(email, 'Reset Your Password — MilesSpace', html);
}

// 3. Send Login Alert
async function sendLoginAlert(email, username, location, device, time) {
    const html = loadTemplate('login-alert', {
        username: username || 'User',
        location: location || 'Unknown Location',
        device: device || 'Unknown Device',
        time: time || new Date().toLocaleString(),
        title: 'New Login Detected',
        message: 'A new login to your MilesSpace account was detected from an unknown location.',
        subject: 'New Login Detected — MilesSpace',
        details: {
            '📍 Location': location || 'Unknown Location',
            '💻 Device': device || 'Unknown Device',
            '🕐 Time': time || new Date().toLocaleString()
        }
    });
    return sendEmail(email, 'New Login Detected — MilesSpace', html);
}

// 4. Send Withdrawal Success
async function sendWithdrawalSuccess(email, username, amount, currency, reference, wallet, date) {
    const isUSD = currency === 'USD';
    const symbol = isUSD ? '$' : '₦';
    const formattedAmount = symbol + Number(amount).toLocaleString('en-NG', { 
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2 
    });
    
    const html = loadTemplate('withdrawal-success', {
        username: username || 'User',
        amount: formattedAmount,
        currency: currency,
        reference: reference || 'N/A',
        wallet: wallet || (isUSD ? 'USD Wallet' : 'NGN Wallet'),
        date: date || new Date().toLocaleString(),
        title: 'Withdrawal Successful',
        message: 'Your funds have been successfully withdrawn from your account.',
        subject: 'Withdrawal Successful — MilesSpace',
        details: {
            'Amount': formattedAmount,
            'Currency': currency,
            'Wallet': wallet || (isUSD ? 'USD Wallet' : 'NGN Wallet'),
            'Reference': reference || 'N/A',
            'Date': date || new Date().toLocaleString()
        }
    });
    return sendEmail(email, 'Withdrawal Successful — MilesSpace', html);
}

// 5. Send Order Status Change
async function sendOrderStatusChange(email, username, orderId, oldStatus, newStatus, productName, amount) {
    const statusLabels = {
        pending: 'Pending',
        processing: 'Processing',
        completed: 'Completed',
        failed: 'Failed',
        cancelled: 'Cancelled'
    };
    
    const html = loadTemplate('order-status', {
        username: username || 'User',
        orderId: orderId || 'N/A',
        productName: productName || 'Product',
        amount: amount || 'N/A',
        oldStatus: oldStatus || 'N/A',
        newStatus: statusLabels[newStatus] || newStatus,
        title: 'Order Status Changed',
        message: 'Your order status has been updated.',
        subject: `Order ${statusLabels[newStatus] || newStatus} — MilesSpace`,
        details: {
            'Order ID': orderId || 'N/A',
            'Product': productName || 'Product',
            'Amount': amount || 'N/A',
            'Previous Status': oldStatus || 'N/A',
            'New Status': statusLabels[newStatus] || newStatus
        }
    });
    return sendEmail(email, `Order ${statusLabels[newStatus] || newStatus} — MilesSpace`, html);
}

// 6. Send Welcome Email
async function sendWelcomeEmail(email, username) {
    const html = loadTemplate('welcome', {
        username: username || 'User',
        title: 'Welcome to MilesSpace!',
        message: "We're excited to have you join the MilesSpace community!",
        subject: 'Welcome to MilesSpace!'
    });
    return sendEmail(email, 'Welcome to MilesSpace!', html);
}

// 7. Send Order Confirmation
async function sendOrderConfirmation(email, username, orderId, productName, amount, status) {
    const html = loadTemplate('order-confirmation', {
        username: username || 'User',
        orderId: orderId || 'N/A',
        productName: productName || 'Product',
        amount: amount || 'N/A',
        status: status || 'Confirmed',
        title: 'Order Confirmed',
        message: 'Your order has been confirmed and is being processed.',
        subject: 'Order Confirmed — MilesSpace',
        details: {
            'Order ID': orderId || 'N/A',
            'Product': productName || 'Product',
            'Amount': amount || 'N/A',
            'Status': status || 'Confirmed'
        }
    });
    return sendEmail(email, 'Order Confirmed — MilesSpace', html);
}

// 8. Send Payment Confirmation
async function sendPaymentConfirmation(email, username, amount, currency, reference, method) {
    const symbol = currency === 'USD' ? '$' : '₦';
    const formattedAmount = symbol + Number(amount).toLocaleString('en-NG', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    
    const html = loadTemplate('payment-confirmation', {
        username: username || 'User',
        amount: formattedAmount,
        currency: currency,
        reference: reference || 'N/A',
        method: method || 'Wallet',
        title: 'Payment Confirmed',
        message: 'Your payment has been successfully processed.',
        subject: 'Payment Confirmed — MilesSpace',
        details: {
            'Amount': formattedAmount,
            'Currency': currency,
            'Reference': reference || 'N/A',
            'Method': method || 'Wallet'
        }
    });
    return sendEmail(email, 'Payment Confirmed — MilesSpace', html);
}

// 9. Send Two-Factor Auth Code
async function sendTwoFactorCode(email, username, code) {
    const html = loadTemplate('2fa-code', {
        username: username || 'User',
        code: code,
        title: 'Two-Factor Authentication',
        message: 'Use this code to complete your two-factor authentication.',
        subject: '2FA Code — MilesSpace'
    });
    return sendEmail(email, '2FA Code — MilesSpace', html);
}

// 10. Send Referral Reward
async function sendReferralReward(email, username, referrerName, amount, currency) {
    const symbol = currency === 'USD' ? '$' : '₦';
    const formattedAmount = symbol + Number(amount).toLocaleString('en-NG', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    
    const html = loadTemplate('referral-reward', {
        username: username || 'User',
        referrerName: referrerName || 'Someone',
        amount: formattedAmount,
        currency: currency,
        title: 'Referral Reward Earned',
        message: `You earned a referral reward from ${referrerName || 'someone'}!`,
        subject: 'Referral Reward — MilesSpace',
        details: {
            'Referrer': referrerName || 'Someone',
            'Amount': formattedAmount,
            'Currency': currency
        }
    });
    return sendEmail(email, 'Referral Reward — MilesSpace', html);
}

// 11. Send Low Balance Alert
async function sendLowBalanceAlert(email, username, balance, currency, threshold) {
    const symbol = currency === 'USD' ? '$' : '₦';
    const formattedBalance = symbol + Number(balance).toLocaleString('en-NG', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    
    const html = loadTemplate('low-balance', {
        username: username || 'User',
        balance: formattedBalance,
        currency: currency,
        threshold: threshold || 'N/A',
        title: 'Low Balance Alert',
        message: 'Your wallet balance is running low. Please fund your account to continue using our services.',
        subject: 'Low Balance Alert — MilesSpace',
        details: {
            'Current Balance': formattedBalance,
            'Currency': currency,
            'Threshold': threshold || 'N/A'
        }
    });
    return sendEmail(email, 'Low Balance Alert — MilesSpace', html);
}

// 12. Send Custom Email
async function sendCustomEmail(email, subject, template, data = {}) {
    const html = loadTemplate(template, data);
    return sendEmail(email, subject, html);
}

// ─── STATUS CHECK ───
function isEnabled() {
    return enabled;
}

function getStatus() {
    return {
        enabled: enabled,
        sender: `${BREVO_SENDER_NAME} <${BREVO_SENDER_EMAIL}>`,
        error: initError || null,
        apiKeyPresent: !!BREVO_API_KEY
    };
}

// ─── EXPORT ───
module.exports = {
    // Core
    sendEmail,
    loadTemplate,
    isEnabled,
    getStatus,
    
    // Email Templates
    sendVerificationEmail,
    sendPasswordResetOTP,
    sendLoginAlert,
    sendWithdrawalSuccess,
    sendOrderStatusChange,
    sendWelcomeEmail,
    sendOrderConfirmation,
    sendPaymentConfirmation,
    sendTwoFactorCode,
    sendReferralReward,
    sendLowBalanceAlert,
    sendCustomEmail,
    
    // Constants
    enabled,
    BREVO_SENDER_EMAIL,
    BREVO_SENDER_NAME
};