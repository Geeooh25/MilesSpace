// services/emailService-brevo-api.js
// Use Transactional Email API instead of SMTP

const axios = require('axios');

async function sendEmailViaAPI(to, subject, html, textContent = null) {
    try {
        const response = await axios.post(
            'https://api.brevo.com/v3/transactional-emails/emails',
            {
                sender: {
                    name: process.env.BREVO_SENDER_NAME || 'MilesSpace',
                    email: process.env.BREVO_SENDER_EMAIL || 'milesbrain280@gmail.com'
                },
                to: [{ email: to }],
                subject: subject,
                htmlContent: html,
                textContent: textContent || null,
                tags: ['milesspace', 'transactional']
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': process.env.BREVO_API_KEY
                }
            }
        );

        return {
            success: true,
            messageId: response.data.messageId,
            data: response.data
        };
    } catch (error) {
        console.error('Brevo API Error:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message,
            details: error.response?.data
        };
    }
}

module.exports = { sendEmailViaAPI };