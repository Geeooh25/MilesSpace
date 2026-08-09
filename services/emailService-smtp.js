// services/emailService-smtp.js
// Use SMTP directly instead of API

const nodemailer = require('nodemailer');

// Create SMTP transporter
const transporter = nodemailer.createTransporter({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false, // TLS
    auth: {
        user: process.env.BREVO_SENDER_EMAIL || 'milesbrain280@gmail.com',
        pass: process.env.BREVO_SMTP_KEY || process.env.BREVO_API_KEY // Use your SMTP key
    },
    tls: {
        rejectUnauthorized: false
    }
});

async function sendEmailViaSMTP(to, subject, html) {
    try {
        const info = await transporter.sendMail({
            from: `"${process.env.BREVO_SENDER_NAME || 'MilesSpace'}" <${process.env.BREVO_SENDER_EMAIL || 'milesbrain280@gmail.com'}>`,
            to: to,
            subject: subject,
            html: html
        });

        return {
            success: true,
            messageId: info.messageId
        };
    } catch (error) {
        console.error('SMTP Error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = { sendEmailViaSMTP };