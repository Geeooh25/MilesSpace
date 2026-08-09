// scripts/test-email.js
// Run with: node scripts/test-email.js

'use strict';

require('dotenv').config();
const emailService = require('../services/emailService');

// ─── COLORS FOR CONSOLE ───
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

// ─── TEST CONFIGURATION ───
const TEST_EMAIL = process.env.TEST_EMAIL || 'your-email@example.com'; // CHANGE THIS!
const TEST_USERNAME = 'TestUser';

// ─── TEST FUNCTIONS ───

async function testBrevoAPIKey() {
    logSeparator();
    logInfo('Testing Brevo API Key...');
    
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    const senderName = process.env.BREVO_SENDER_NAME;
    
    log(`API Key: ${apiKey ? apiKey.substring(0, 10) + '...' : '❌ Missing'}`, colors.cyan);
    log(`Sender Email: ${senderEmail || '❌ Missing'}`, colors.cyan);
    log(`Sender Name: ${senderName || '❌ Missing'}`, colors.cyan);
    
    if (!apiKey) {
        logError('BREVO_API_KEY is missing in .env file');
        return false;
    }
    
    if (apiKey.length < 10) {
        logError('BREVO_API_KEY is too short (should be at least 10 characters)');
        return false;
    }
    
    if (!senderEmail) {
        logError('BREVO_SENDER_EMAIL is missing in .env file');
        return false;
    }
    
    logSuccess('API Key configuration looks valid');
    return true;
}

async function testEmailServiceStatus() {
    logSeparator();
    logInfo('Checking Email Service Status...');
    
    const status = emailService.getStatus();
    log(JSON.stringify(status, null, 2), colors.cyan);
    
    if (status.enabled) {
        logSuccess('Email service is enabled');
    } else {
        logError(`Email service is disabled: ${status.error || 'Unknown reason'}`);
    }
    
    return status.enabled;
}

async function testSendSimpleEmail() {
    logSeparator();
    logInfo('Testing Simple Email Send...');
    log(`Sending to: ${TEST_EMAIL}`, colors.cyan);
    
    try {
        const result = await emailService.sendEmail(
            TEST_EMAIL,
            '🧪 MilesSpace Email Test',
            `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Email Test</title>
            </head>
            <body style="font-family: Arial, sans-serif; padding: 40px; background: #f4f6f8;">
                <div style="max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <h1 style="color: #0c3d4a;">🧪 Email Test</h1>
                    <p style="color: #4a6070; font-size: 16px;">This is a test email from MilesSpace.</p>
                    <p style="color: #4a6070; font-size: 16px;">If you're reading this, your email service is working correctly! 🎉</p>
                    <p style="color: #4a6070; font-size: 14px; margin-top: 20px;">
                        <strong>Test Details:</strong><br>
                        Time: ${new Date().toLocaleString()}<br>
                        User: ${TEST_USERNAME}
                    </p>
                    <hr style="border: 1px solid #e4e8ec; margin: 20px 0;">
                    <p style="color: #92a8b4; font-size: 12px; text-align: center;">
                        © 2024 MilesSpace. All rights reserved.
                    </p>
                </div>
            </body>
            </html>
            `,
            'This is a plain text version of the email.'
        );
        
        log(`Result: ${JSON.stringify(result, null, 2)}`, colors.cyan);
        
        if (result.success) {
            logSuccess(`✅ Simple email sent successfully! Message ID: ${result.messageId}`);
            return true;
        } else {
            logError(`❌ Failed to send simple email: ${result.error}`);
            if (result.details) {
                log(`Details: ${JSON.stringify(result.details, null, 2)}`, colors.red);
            }
            return false;
        }
    } catch (error) {
        logError(`❌ Exception sending email: ${error.message}`);
        console.error(error);
        return false;
    }
}

async function testVerificationEmail() {
    logSeparator();
    logInfo('Testing Verification Email Template...');
    log(`Sending to: ${TEST_EMAIL}`, colors.cyan);
    
    try {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const result = await emailService.sendVerificationEmail(
            TEST_EMAIL,
            TEST_USERNAME,
            code
        );
        
        log(`Result: ${JSON.stringify(result, null, 2)}`, colors.cyan);
        
        if (result.success) {
            logSuccess('✅ Verification email sent successfully!');
            logInfo(`Verification code: ${code}`);
            return true;
        } else {
            logError(`❌ Failed to send verification email: ${result.error}`);
            return false;
        }
    } catch (error) {
        logError(`❌ Exception: ${error.message}`);
        return false;
    }
}

async function testPasswordResetEmail() {
    logSeparator();
    logInfo('Testing Password Reset Email Template...');
    log(`Sending to: ${TEST_EMAIL}`, colors.cyan);
    
    try {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const result = await emailService.sendPasswordResetOTP(
            TEST_EMAIL,
            TEST_USERNAME,
            code
        );
        
        if (result.success) {
            logSuccess('✅ Password reset email sent successfully!');
            logInfo(`Reset code: ${code}`);
            return true;
        } else {
            logError(`❌ Failed to send password reset email: ${result.error}`);
            return false;
        }
    } catch (error) {
        logError(`❌ Exception: ${error.message}`);
        return false;
    }
}

async function testWelcomeEmail() {
    logSeparator();
    logInfo('Testing Welcome Email Template...');
    log(`Sending to: ${TEST_EMAIL}`, colors.cyan);
    
    try {
        const result = await emailService.sendWelcomeEmail(
            TEST_EMAIL,
            TEST_USERNAME
        );
        
        if (result.success) {
            logSuccess('✅ Welcome email sent successfully!');
            return true;
        } else {
            logError(`❌ Failed to send welcome email: ${result.error}`);
            return false;
        }
    } catch (error) {
        logError(`❌ Exception: ${error.message}`);
        return false;
    }
}

async function testCustomEmail() {
    logSeparator();
    logInfo('Testing Custom Email with Template...');
    log(`Sending to: ${TEST_EMAIL}`, colors.cyan);
    
    try {
        const result = await emailService.sendCustomEmail(
            TEST_EMAIL,
            '📧 MilesSpace Custom Email Test',
            'verification',
            {
                username: TEST_USERNAME,
                code: '123456',
                title: 'Custom Test Email',
                message: 'This is a custom test email with a template.'
            }
        );
        
        if (result.success) {
            logSuccess('✅ Custom email sent successfully!');
            return true;
        } else {
            logError(`❌ Failed to send custom email: ${result.error}`);
            return false;
        }
    } catch (error) {
        logError(`❌ Exception: ${error.message}`);
        return false;
    }
}

// ─── MAIN TEST RUNNER ───

async function runAllTests() {
    logSeparator();
    log('🚀 MilesSpace Email Test Suite', colors.green);
    logSeparator();
    
    if (TEST_EMAIL === 'your-email@example.com') {
        logWarn('⚠️ Please set TEST_EMAIL in your .env file or in the script');
        logWarn('⚠️ Current test email: your-email@example.com');
        logWarn('⚠️ Change this to your real email address to receive test emails');
        logSeparator();
    }
    
    const results = {
        apiKey: false,
        serviceStatus: false,
        simpleEmail: false,
        verificationEmail: false,
        passwordResetEmail: false,
        welcomeEmail: false,
        customEmail: false
    };
    
    // Run tests
    results.apiKey = await testBrevoAPIKey();
    results.serviceStatus = await testEmailServiceStatus();
    
    if (results.serviceStatus) {
        results.simpleEmail = await testSendSimpleEmail();
        results.verificationEmail = await testVerificationEmail();
        results.passwordResetEmail = await testPasswordResetEmail();
        results.welcomeEmail = await testWelcomeEmail();
        results.customEmail = await testCustomEmail();
    } else {
        logWarn('⚠️ Skipping email send tests because service is disabled');
    }
    
    // Summary
    logSeparator();
    log('📊 Test Summary', colors.green);
    logSeparator();
    
    const testNames = {
        apiKey: 'API Key Check',
        serviceStatus: 'Service Status',
        simpleEmail: 'Simple Email Send',
        verificationEmail: 'Verification Email',
        passwordResetEmail: 'Password Reset Email',
        welcomeEmail: 'Welcome Email',
        customEmail: 'Custom Email'
    };
    
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    
    Object.entries(results).forEach(([key, value]) => {
        const name = testNames[key] || key;
        if (value === true) {
            logSuccess(`✅ ${name}: PASSED`);
            passed++;
        } else if (value === false && key === 'simpleEmail') {
            logError(`❌ ${name}: FAILED`);
            failed++;
        } else if (value === false) {
            if (results.serviceStatus) {
                logError(`❌ ${name}: FAILED`);
                failed++;
            } else {
                logWarn(`⏭️ ${name}: SKIPPED (service disabled)`);
                skipped++;
            }
        }
    });
    
    logSeparator();
    log(`📈 Results: ${passed} passed, ${failed} failed, ${skipped} skipped`, colors.cyan);
    logSeparator();
    
    if (passed > 0 && failed === 0) {
        log('🎉 All tests passed! Your email service is working correctly!', colors.green);
    } else if (failed > 0) {
        log('❌ Some tests failed. Please check the errors above.', colors.red);
        logInfo('Common issues:');
        log('1. Check your BREVO_API_KEY in .env file', colors.yellow);
        log('2. Verify your BREVO_SENDER_EMAIL is verified in Brevo', colors.yellow);
        log('3. Check your internet connection', colors.yellow);
        log('4. Make sure your Brevo account is active', colors.yellow);
    }
    
    return results;
}

// ─── RUN TESTS ───
if (require.main === module) {
    runAllTests()
        .then(() => {
            console.log('\n✨ Test suite complete');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Fatal error:', error);
            process.exit(1);
        });
}

module.exports = { runAllTests };