// test-email.js
require('dotenv').config();
const emailService = require('./services/emailService');

// ─── CONFIGURATION ────────────────────────────────────────────────
// ⚠️ CHANGE THIS to the exact email address you used to sign up for Resend
const TEST_RECEIVER_EMAIL = 'milesbrain280@gmail.com'; 
// ──────────────────────────────────────────────────────────────────

async function runTest() {
    console.log('--- Starting Resend Test ---');
    console.log(`Checking status...`);

    const status = emailService.getStatus();
    console.log('Email Service Status:', status);

    if (!status.enabled) {
        console.error('\n❌ ERROR: Email service is disabled.');
        console.error('Did you add RESEND_API_KEY to your .env file?');
        process.exit(1);
    }

    console.log(`\nSending test verification email to: ${TEST_RECEIVER_EMAIL}`);
    
    try {
        const result = await emailService.sendVerificationEmail(
            TEST_RECEIVER_EMAIL, 
            'Test User', 
            '123456'
        );

        if (result.success) {
            console.log('\n✅ SUCCESS! Email sent.');
            console.log('Message ID:', result.messageId);
            console.log('Check your inbox (and spam folder).');
        } else {
            console.error('\n❌ FAILED to send email.');
            console.error('Reason:', result.error);
            console.error('Code:', result.code);
            
            if (result.error?.includes('403')) {
                console.error('\n💡 TIP: You are on the free tier without a verified domain.');
                console.error(`You can only send emails to: ${TEST_RECEIVER_EMAIL}`);
            }
        }
    } catch (error) {
        console.error('\n❌ SCRIPT CRASHED:', error);
    }
}

runTest();