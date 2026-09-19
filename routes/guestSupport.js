// routes/guestSupport.js - Guest support with verification
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../db/supabase');
const emailService = require('../services/emailService');
const { createNotification } = require('../services/notificationService');

// ─── RATE LIMITING ────────────────────────────────────────────────────
const guestTicketLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Too many guest ticket requests. Please wait 15 minutes.',
    },
});

const guestVerifyLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Too many verification attempts. Please wait 5 minutes.',
    },
});

// ─── HELPERS ──────────────────────────────────────────────────────────

function generateGuestToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateOTP() {
    return crypto.randomInt(100000, 1000000).toString().padStart(6, '0');
}

// ─── 1. CREATE GUEST TICKET ─────────────────────────────────────────

router.post('/public/tickets', guestTicketLimiter, async (req, res) => {
    try {
        const { name, email, category, subject, message } = req.body;

        if (!name || !email || !subject || !message) {
            return res.status(400).json({
                success: false,
                code: 'MISSING_FIELDS',
                error: 'All fields are required',
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_EMAIL',
                error: 'Invalid email address',
            });
        }

        // Check for existing guest tickets from this email
        const { count, error: countError } = await supabaseAdmin
            .from('support_tickets')
            .select('*', { count: 'exact', head: true })
            .eq('guest_email', email)
            .in('status', ['open', 'assigned', 'in_progress', 'waiting_user']);

        if (countError) throw countError;

        if (count && count >= 3) {
            return res.status(429).json({
                success: false,
                code: 'TOO_MANY_TICKETS',
                error: 'You have too many open guest tickets. Please close or resolve existing tickets first.',
            });
        }

        // Generate OTP and token
        const otp = generateOTP();
        const token = generateGuestToken();
        const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

        // Create ticket
        const ticketNumber = `GST-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

        const { data: ticket, error: ticketError } = await supabaseAdmin
            .from('support_tickets')
            .insert({
                guest_name: name,
                guest_email: email,
                guest_token: token,
                ticket_number: ticketNumber,
                category: category || 'general',
                subject: subject,
                description: message,
                status: 'waiting_verification',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (ticketError) throw ticketError;

        // Store verification
        await supabaseAdmin
            .from('guest_verifications')
            .insert({
                ticket_id: ticket.id,
                email: email,
                otp_hash: otpHash,
                expires_at: expiresAt.toISOString(),
                created_at: new Date().toISOString(),
            });

        // Send verification email
        await emailService.sendVerificationEmail(email, name, otp);

        res.json({
            success: true,
            message: 'Ticket created. Please check your email for verification.',
            data: {
                ticket_number: ticketNumber,
                ticket_id: ticket.id,
                requires_verification: true,
            },
        });
    } catch (error) {
        console.error('Guest ticket error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 2. VERIFY GUEST ─────────────────────────────────────────────────

router.post('/public/verify', guestVerifyLimiter, async (req, res) => {
    try {
        const { ticket_id, otp } = req.body;

        if (!ticket_id || !otp) {
            return res.status(400).json({
                success: false,
                code: 'MISSING_FIELDS',
                error: 'Ticket ID and OTP are required',
            });
        }

        // Get verification record
        const { data: verification, error: vError } = await supabaseAdmin
            .from('guest_verifications')
            .select('*')
            .eq('ticket_id', ticket_id)
            .eq('verified', false)
            .single();

        if (vError || !verification) {
            return res.status(404).json({
                success: false,
                code: 'VERIFICATION_NOT_FOUND',
                error: 'Invalid or expired verification request',
            });
        }

        if (new Date(verification.expires_at) < new Date()) {
            return res.status(400).json({
                success: false,
                code: 'VERIFICATION_EXPIRED',
                error: 'Verification code has expired. Please request a new one.',
            });
        }

        if (verification.attempts >= 5) {
            return res.status(429).json({
                success: false,
                code: 'TOO_MANY_ATTEMPTS',
                error: 'Too many verification attempts. Please request a new code.',
            });
        }

        // Verify OTP
        const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
        if (otpHash !== verification.otp_hash) {
            await supabaseAdmin
                .from('guest_verifications')
                .update({ attempts: verification.attempts + 1 })
                .eq('id', verification.id);

            return res.status(400).json({
                success: false,
                code: 'INVALID_OTP',
                error: 'Invalid verification code',
                remaining_attempts: 4 - verification.attempts,
            });
        }

        // Mark as verified
        await supabaseAdmin
            .from('guest_verifications')
            .update({ verified: true })
            .eq('id', verification.id);

        // Update ticket status
        const { data: ticket, error: ticketError } = await supabaseAdmin
            .from('support_tickets')
            .update({
                status: 'open',
                verified_at: new Date().toISOString(),
            })
            .eq('id', ticket_id)
            .select()
            .single();

        if (ticketError) throw ticketError;

        // Generate secure guest session token
        const sessionToken = crypto.randomBytes(32).toString('hex');

        await supabaseAdmin
            .from('guest_sessions')
            .insert({
                ticket_id: ticket.id,
                token: sessionToken,
                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
                created_at: new Date().toISOString(),
            });

        res.json({
            success: true,
            message: 'Verification successful',
            data: {
                ticket: ticket,
                session_token: sessionToken,
                expires_in: '7 days',
            },
        });
    } catch (error) {
        console.error('Guest verification error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 3. GET GUEST TICKET ────────────────────────────────────────────

router.get('/public/tickets/:token', async (req, res) => {
    try {
        const { token } = req.params;

        // Verify guest session
        const { data: session, error: sError } = await supabaseAdmin
            .from('guest_sessions')
            .select('ticket_id, expires_at')
            .eq('token', token)
            .single();

        if (sError || !session) {
            return res.status(401).json({
                success: false,
                code: 'INVALID_SESSION',
                error: 'Invalid or expired session',
            });
        }

        if (new Date(session.expires_at) < new Date()) {
            return res.status(401).json({
                success: false,
                code: 'SESSION_EXPIRED',
                error: 'Session has expired',
            });
        }

        // Get ticket with messages
        const { data: ticket, error: ticketError } = await supabaseAdmin
            .from('support_tickets')
            .select(`
                *,
                messages:ticket_messages (
                    id,
                    message,
                    created_at,
                    sender_type,
                    attachments
                )
            `)
            .eq('id', session.ticket_id)
            .single();

        if (ticketError || !ticket) {
            return res.status(404).json({
                success: false,
                code: 'TICKET_NOT_FOUND',
                error: 'Ticket not found',
            });
        }

        res.json({
            success: true,
            data: ticket,
        });
    } catch (error) {
        console.error('Get guest ticket error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── 4. GUEST REPLY ──────────────────────────────────────────────────

router.post('/public/tickets/:token/messages', async (req, res) => {
    try {
        const { token } = req.params;
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({
                success: false,
                code: 'MISSING_MESSAGE',
                error: 'Message is required',
            });
        }

        // Verify guest session
        const { data: session, error: sError } = await supabaseAdmin
            .from('guest_sessions')
            .select('ticket_id, expires_at')
            .eq('token', token)
            .single();

        if (sError || !session) {
            return res.status(401).json({
                success: false,
                code: 'INVALID_SESSION',
                error: 'Invalid or expired session',
            });
        }

        if (new Date(session.expires_at) < new Date()) {
            return res.status(401).json({
                success: false,
                code: 'SESSION_EXPIRED',
                error: 'Session has expired',
            });
        }

        // Get ticket
        const { data: ticket, error: ticketError } = await supabaseAdmin
            .from('support_tickets')
            .select('*')
            .eq('id', session.ticket_id)
            .single();

        if (ticketError || !ticket) {
            return res.status(404).json({
                success: false,
                code: 'TICKET_NOT_FOUND',
                error: 'Ticket not found',
            });
        }

        if (ticket.status === 'closed' || ticket.status === 'resolved') {
            return res.status(400).json({
                success: false,
                code: 'TICKET_CLOSED',
                error: 'This ticket is closed and cannot be replied to.',
            });
        }

        // Add message
        const { data: msg, error: msgError } = await supabaseAdmin
            .from('ticket_messages')
            .insert({
                ticket_id: ticket.id,
                sender_type: 'guest',
                message: message,
                created_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (msgError) throw msgError;

        // Update ticket
        await supabaseAdmin
            .from('support_tickets')
            .update({
                updated_at: new Date().toISOString(),
                last_message_at: new Date().toISOString(),
                last_user_message_at: new Date().toISOString(),
            })
            .eq('id', ticket.id);

        // Notify admins
        if (global.io) {
            global.io.to('admins').emit('support:message', {
                ticket_id: ticket.id,
                ticket_number: ticket.ticket_number,
                message: msg,
                sender: 'guest',
                guest_email: ticket.guest_email,
            });
        }

        res.json({
            success: true,
            message: 'Reply sent',
            data: msg,
        });
    } catch (error) {
        console.error('Guest reply error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;