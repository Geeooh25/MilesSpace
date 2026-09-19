// scripts/test-email.js - Updated with Async Verification
require('dotenv').config();
const emailService = require('../services/emailService');

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

function log(message, color = colors.white) {
    console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message) {
    log(`✅ ${message}`, colors.green);
}

function logError(message) {
    log(`❌ ${message}`, colors.red);
}

function logInfo(message) {
    log(`📌 ${message}`, colors.blue);
}

function logWarn(message) {
    log(`⚠️ ${message}`, colors.yellow);
}

function logSeparator() {
    console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}`);
}

const TEST_EMAIL = process.env.TEST_EMAIL || 'your-email@example.com';

async function runAllTests() {
    logSeparator();
    log('🚀 MilesSpace Email Test Suite (Gmail SMTP)', colors.green);
    logSeparator();
    
    // Wait for transporter to verify
    logInfo('Waiting for email service to initialize...');
    await emailService.verifyTransporter();
    
    const status = emailService.getStatus();
    logInfo(`Email Service Status: ${status.enabled ? '✅ Enabled' : '❌ Disabled'}`);
    logInfo(`Provider: ${status.provider}`);
    logInfo(`From: ${status.from}`);
    logInfo(`Credentials: User ${status.credentials.user}, Pass ${status.credentials.pass}`);
    
    if (!status.enabled) {
        logError('❌ Email service is disabled. Please check your credentials.');
        logInfo('Make sure EMAIL_USER and EMAIL_PASS are set in .env');
        logInfo('EMAIL_PASS should be a 16-character App Password from Google');
        process.exit(1);
    }
    
    logSeparator();
    log('📧 Running Email Tests...', colors.cyan);
    logSeparator();
    
    // Send test email
    logInfo(`Sending test email to: ${TEST_EMAIL}`);
    
    if (TEST_EMAIL === 'your-email@example.com') {
        logWarn('⚠️ TEST_EMAIL is set to example.com');
        logWarn('⚠️ Set TEST_EMAIL=your-real-email@gmail.com in .env');
        process.exit(1);
    }
    
    try {
        const result = await emailService.sendEmail(
            TEST_EMAIL,
            '🧪 MilesSpace Email Test',
            `
            <h1>✅ Email Test Successful!</h1>
            <p>This is a test email from MilesSpace using Gmail SMTP.</p>
            <p>Time: ${new Date().toLocaleString()}</p>
            <p>Your email service is working correctly! 🎉</p>
            <hr>
            <p style="font-size:12px;color:#666;">
                Sent from: ${status.from}<br>
                Provider: ${status.provider}
            </p>
            `
        );
        
        if (result.success) {
            logSuccess('✅ Test email sent successfully!');
            logInfo(`📨 Message ID: ${result.messageId}`);
            logInfo(`📬 Check your inbox (${TEST_EMAIL})`);
        } else {
            logError(`❌ Test email failed: ${result.error}`);
        }
    } catch (error) {
        logError(`❌ Exception: ${error.message}`);
    }
    
    logSeparator();
    log('✨ Test complete', colors.green);
    logSeparator();
}

if (require.main === module) {
    runAllTests()
        .then(() => {
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Fatal error:', error);
            process.exit(1);
        });
}