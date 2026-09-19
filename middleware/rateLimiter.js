// middleware/rateLimiter.js - PROFESSIONAL PRODUCTION VERSION
// Rate limits only sensitive operations: login, register, email sending
// Silent failure on email rate limits - user never knows they're being limited

const rateLimit = require('express-rate-limit');

// ─── CONFIG ──────────────────────────────────────────────────────────
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ─── HELPER: Safe IP key generator for IPv6 compatibility ─────────
function getClientIp(req) {
    // Check for proxy headers first
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const ips = forwarded.split(',');
        const firstIp = ips[0].trim();
        if (firstIp === '::1' || firstIp === '::ffff:127.0.0.1') {
            return '127.0.0.1';
        }
        return firstIp;
    }
    
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    
    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
        return '127.0.0.1';
    }
    
    return ip;
}

// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───
//  SECURITY RATE LIMITERS - ONLY FOR SENSITIVE OPERATIONS
// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───

// ─── 1. LOGIN RATE LIMITER ──────────────────────────────────────────
// Protects against credential stuffing and brute force
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per 15 minutes (per IP + email)
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        const email = req.body?.email?.toLowerCase() || 'unknown';
        return `${ip}:${email}`;
    },
    handler: (req, res) => {
        const email = req.body?.email || 'unknown';
        console.log(`🔒 [RATE LIMIT] Login rate exceeded for ${email}`);
        return res.status(429).json({
            success: false,
            code: 'TOO_MANY_ATTEMPTS',
            message: 'Too many sign-in attempts. Please wait a few minutes and try again.'
        });
    }
});

// ─── 2. REGISTRATION RATE LIMITER ──────────────────────────────────
// Protects against account creation abuse
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // 5 attempts per hour (per IP + email)
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        const email = req.body?.email?.toLowerCase() || 'unknown';
        return `${ip}:${email}`;
    },
    handler: (req, res) => {
        return res.status(429).json({
            success: false,
            code: 'TOO_MANY_ATTEMPTS',
            message: 'Too many registration attempts. Please try again later.'
        });
    }
});

// ─── 3. OTP VERIFICATION RATE LIMITER ──────────────────────────────
// Protects against brute forcing OTP codes
const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 5, // 5 attempts per challenge
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const challengeId = req.body?.challenge_id || req.body?.reset_id || 'unknown';
        const ip = getClientIp(req);
        return `${ip}:${challengeId}`;
    },
    handler: (req, res) => {
        return res.status(429).json({
            success: false,
            code: 'TOO_MANY_ATTEMPTS',
            message: 'Too many verification attempts. Please try again later.'
        });
    }
});

// ─── 4. RESEND OTP RATE LIMITER (SILENT FAILURE) ──────────────────
// Protects against email/SMS abuse - user never knows they're limited
const resendOtpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3, // 3 attempts per 5 minutes
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const challengeId = req.body?.challenge_id || 'unknown';
        const ip = getClientIp(req);
        return `${ip}:${challengeId}`;
    },
    // ─── SILENT FAILURE ──────────────────────────────────────────────
    handler: (req, res) => {
        console.log(`🔒 [SILENT] Resend OTP rate limited for ${req.body?.challenge_id || 'unknown'}`);
        // Return SUCCESS even though we didn't send the email
        // This prevents attackers from knowing they've been rate limited
        return res.json({
            success: true,
            message: 'If your email is registered, a new verification code has been sent.'
        });
    }
});

// ─── 5. FORGOT PASSWORD RATE LIMITER (SILENT FAILURE) ──────────────
// Protects against password reset abuse
const passwordResetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // 3 attempts per hour (per IP + email)
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const email = req.body?.email?.toLowerCase() || 'unknown';
        const ip = getClientIp(req);
        return `${ip}:${email}`;
    },
    handler: (req, res) => {
        console.log(`🔒 [SILENT] Password reset rate limited for ${req.body?.email || 'unknown'}`);
        // Return the same message as success to prevent account enumeration
        return res.json({
            success: true,
            message: 'If an account exists for this email, a reset link has been sent.'
        });
    }
});

// ─── 6. REFRESH TOKEN RATE LIMITER ────────────────────────────────
// Protects against token abuse
const refreshLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 attempts per minute
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    handler: (req, res) => {
        return res.status(429).json({
            success: false,
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many requests. Please wait a moment.'
        });
    }
});

// ─── 7. ADMIN LOGIN RATE LIMITER ──────────────────────────────────
// Admin login has stricter limits
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 minutes
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        const email = req.body?.email?.toLowerCase() || 'unknown';
        return `${ip}:${email}`;
    },
    handler: (req, res) => {
        return res.status(429).json({
            success: false,
            code: 'TOO_MANY_ATTEMPTS',
            message: 'Too many sign-in attempts. Please try again later.'
        });
    }
});

// ─── 8. PIN OPERATIONS RATE LIMITER ────────────────────────────────
// Protects PIN brute force
const pinLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 attempts per hour
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const userId = req.user?.id || 'anonymous';
        const ip = getClientIp(req);
        return `${ip}:${userId}`;
    },
    handler: (req, res) => {
        return res.status(429).json({
            success: false,
            code: 'TOO_MANY_ATTEMPTS',
            message: 'Too many PIN attempts. Please wait an hour.'
        });
    }
});

// ─── 9. FINANCIAL OPERATIONS RATE LIMITER ─────────────────────────
// Protects against transaction abuse
const financialLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // 10 operations per 5 minutes
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const userId = req.user?.id || 'anonymous';
        const ip = getClientIp(req);
        return `${ip}:${userId}`;
    },
    skip: (req) => {
        if (req.user?.isAdmin) return true;
        return false;
    },
    handler: (req, res) => {
        return res.status(429).json({
            success: false,
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many financial operations. Please wait a few minutes.'
        });
    }
});

// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───
//  NO RATE LIMITERS FOR:
//  - GET requests (viewing data)
//  - Heartbeat/presence
//  - Dashboard polling
//  - Profile views
//  - Transaction history views
//  - Any read-only operation
// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───

// ─── EXPORT ──────────────────────────────────────────────────────────
module.exports = {
    // Helpers
    getClientIp,
    
    // Security limiters (only for sensitive operations)
    loginLimiter,
    registerLimiter,
    otpLimiter,
    resendOtpLimiter,
    passwordResetLimiter,
    refreshLimiter,
    adminLoginLimiter,
    pinLimiter,
    financialLimiter,
    
    // Utility limiter (for custom use)
    rateLimiter: (limit, windowSeconds, message) => {
        return rateLimit({
            windowMs: windowSeconds * 1000,
            max: limit,
            standardHeaders: true,
            legacyHeaders: false,
            keyGenerator: (req) => getClientIp(req),
            message: message || {
                success: false,
                code: 'RATE_LIMITED',
                message: 'Too many requests. Please try again later.'
            },
            handler: (req, res) => {
                return res.status(429).json({
                    success: false,
                    code: 'RATE_LIMITED',
                    message: message?.message || 'Too many requests. Please try again later.',
                    retryAfter: windowSeconds
                });
            }
        });
    }
};