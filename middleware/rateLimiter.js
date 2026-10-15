// middleware/rateLimiter.js
// ─────────────────────────────────────────────────────────────────
// Rate limiters for sensitive authentication operations only.
// Read-only / infrastructure endpoints have NO limiter.
// ─────────────────────────────────────────────────────────────────

'use strict';

const rateLimit = require('express-rate-limit');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ─── Trust config ────────────────────────────────────────────────
// server.js MUST call app.set('trust proxy', 1) so req.ip is safe.
// Do not parse X-Forwarded-For here — that bypasses trust config.
function getClientIp(req) {
    return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ─── Login ────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        const email = String(req.body?.email || '').toLowerCase();
        return `login:${ip}:${email}`;
    },
    handler: (req, res) => res.status(429).json({
        success: false,
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Too many sign-in attempts. Please wait a few minutes and try again.'
    })
});

// ─── Register ─────────────────────────────────────────────────────
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        const email = String(req.body?.email || '').toLowerCase();
        return `register:${ip}:${email}`;
    },
    handler: (req, res) => res.status(429).json({
        success: false,
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Too many registration attempts. Please try again later.'
    })
});

// ─── OTP verification ─────────────────────────────────────────────
const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        const challenge = req.body?.challenge_id
            || req.body?.reset_id
            || req.body?.user_id
            || 'unknown';
        return `otp:${ip}:${challenge}`;
    },
    handler: (req, res) => res.status(429).json({
        success: false,
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Too many verification attempts. Please try again later.'
    })
});

// ─── Resend OTP (silent failure) ──────────────────────────────────
const resendOtpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        const challenge = req.body?.challenge_id || req.body?.user_id || 'unknown';
        return `resend:${ip}:${challenge}`;
    },
    // Silent failure: returns success but does not send.
    handler: (req, res) => {
        if (!IS_PRODUCTION) {
            console.log('[RATE] Silent resend OTP limit hit');
        }
        return res.json({
            success: true,
            message: 'If your email is registered, a new verification code has been sent.'
        });
    }
});

// ─── Password reset request (silent failure) ──────────────────────
const passwordResetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        const email = String(req.body?.email || '').toLowerCase();
        return `pwreset:${ip}:${email}`;
    },
    handler: (req, res) => {
        if (!IS_PRODUCTION) {
            console.log('[RATE] Silent password reset limit hit');
        }
        return res.json({
            success: true,
            message: 'If an account exists for this email, a reset code has been sent.'
        });
    }
});

// ─── Refresh ──────────────────────────────────────────────────────
const refreshLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `refresh:${getClientIp(req)}`,
    handler: (req, res) => res.status(429).json({
        success: false,
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Please wait a moment.'
    })
});

// ─── Password reset submit ────────────────────────────────────────
const resetPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `resetpw:${getClientIp(req)}`,
    handler: (req, res) => res.status(429).json({
        success: false,
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Please wait a moment.'
    })
});

module.exports = {
    getClientIp,
    loginLimiter,
    registerLimiter,
    otpLimiter,
    resendOtpLimiter,
    passwordResetLimiter,
    refreshLimiter,
    resetPasswordLimiter
};