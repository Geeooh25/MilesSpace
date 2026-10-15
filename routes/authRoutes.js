// routes/authRoutes.js
// ─────────────────────────────────────────────────────────────────
// Secure auth: 15-min access JWT + HttpOnly refresh cookie.
// Sessions + OTP challenges live in Postgres.
//
// Security posture:
//   • Account state is checked in ONE place (evaluateAccountAccess).
//   • OTP attempt counter is atomic via RPC when available.
//   • Session is created only after re-verifying account state.
//   • Refresh rotates the token atomically and rejects revoked accounts.
//   • No in-memory session or OTP stores.
//
// NOTE on OTP_SECRET: exits in production if unset.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');

const { supabase, supabaseAdmin, withRetry } = require('../db/supabase');
const { authMiddleware, AUTH_CODES, evaluateAccountAccess } = require('../middleware/auth');
const emailService = require('../services/emailService');
const { getClientIP, getLocationFromIP } = require('../utils/ipUtils');
const sessionService = require('../db/sessionService');

const {
    loginLimiter, registerLimiter, otpLimiter,
    resendOtpLimiter, refreshLimiter, passwordResetLimiter
} = require('../middleware/rateLimiter');

const router = express.Router();

// ═══ CONFIG ═══
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ CRITICAL: JWT_SECRET environment variable is required');
    if (process.env.NODE_ENV === 'production') process.exit(1);
}

const JWT_ISSUER   = process.env.JWT_ISSUER   || 'milesspace';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'milesspace-client';

const ACCESS_TOKEN_TTL_SECONDS  = 15 * 60;           // 15 min
const REFRESH_TOKEN_TTL_SECONDS = 15 * 60;           // 15 min — see H-1
const OTP_EXPIRY_MINUTES        = 10;
const MAX_OTP_ATTEMPTS          = 5;
const IS_DEVELOPMENT            = process.env.NODE_ENV === 'development';

// ─── Cookie ──────────────────────────────────────────────────────
const REFRESH_COOKIE_NAME = 'ms_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';

function refreshCookieOptions() {
    return {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path:     REFRESH_COOKIE_PATH,
        maxAge:   REFRESH_TOKEN_TTL_SECONDS * 1000
    };
}

function setRefreshCookie(res, token) {
    res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions());
}

function clearRefreshCookie(res) {
    const { maxAge, ...opts } = refreshCookieOptions();
    res.clearCookie(REFRESH_COOKIE_NAME, opts);
}

// ─── OTP secret ──────────────────────────────────────────────────
const OTP_SECRET = process.env.OTP_SECRET;
if (!OTP_SECRET) {
    if (process.env.NODE_ENV === 'production') {
        console.error('❌ CRITICAL: OTP_SECRET is required in production.');
        process.exit(1);
    }
    console.warn('⚠️  OTP_SECRET missing — using dev-only fallback.');
}
const ACTIVE_OTP_SECRET = OTP_SECRET || 'milesspace-dev-otp-secret-do-not-use';

function hashOtp(value) {
    return crypto.createHmac('sha256', ACTIVE_OTP_SECRET).update(String(value)).digest('hex');
}

function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
    catch { return false; }
}

function generateSecureOtp()    { return crypto.randomInt(100000, 1000000).toString(); }
function generateChallengeId()  { return crypto.randomBytes(16).toString('hex'); }

// ─── Helpers ─────────────────────────────────────────────────────
function normalizeEmail(e) { return e ? String(e).trim().toLowerCase() : ''; }

function validatePassword(pw) {
    const errs = [];
    if (!pw || pw.length < 8) errs.push('at least 8 characters');
    if (!/[A-Z]/.test(pw))    errs.push('one uppercase letter');
    if (!/[a-z]/.test(pw))    errs.push('one lowercase letter');
    if (!/[0-9]/.test(pw))    errs.push('one number');
    return errs;
}

function validateUsername(u) {
    if (!u || u.length < 3) return 'Username must be at least 3 characters';
    if (!/^[a-zA-Z0-9_]+$/.test(u)) return 'Username can only contain letters, numbers, underscores';
    return null;
}

function generateReferralCode() {
    return 'MX' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function generateAccessToken(userId, sessionId, role) {
    return jwt.sign(
        { id: userId, sid: sessionId, role: role || 'user' },
        JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_TTL_SECONDS, issuer: JWT_ISSUER, audience: JWT_AUDIENCE }
    );
}

function getUserAgentInfo(req) {
    const ua = req.headers['user-agent'] || 'Unknown';
    let browser = 'Unknown', os = 'Unknown', device = 'Desktop';

    if (ua.includes('Edg'))                                   browser = 'Edge';
    else if (ua.includes('Chrome'))                           browser = 'Chrome';
    else if (ua.includes('Firefox'))                          browser = 'Firefox';
    else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
    else if (ua.includes('OPR') || ua.includes('Opera'))      browser = 'Opera';

    if (ua.includes('Android'))                                os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad'))     os = 'iOS';
    else if (ua.includes('Windows'))                           os = 'Windows';
    else if (ua.includes('Mac OS X') || ua.includes('Macintosh')) os = 'macOS';
    else if (ua.includes('Linux'))                             os = 'Linux';

    if (ua.includes('Mobile'))      device = 'Mobile';
    else if (ua.includes('Tablet')) device = 'Tablet';

    return { browser, os, device, userAgent: ua };
}

async function logSecurityActivity({
    userId, eventType, description, ip, userAgent, deviceInfo, location, metadata
}) {
    try {
        await supabaseAdmin.from('account_activity').insert({
            user_id:       userId,
            activity_type: eventType,
            description:   description || eventType,
            ip_address:    ip || 'unknown',
            location:      location || null,
            user_agent:    userAgent || 'unknown',
            device_info:   deviceInfo || {},
            metadata:      metadata || {},
            created_at:    new Date().toISOString()
        });
    } catch (e) {
        console.error('Failed to log security activity:', e);
    }
}

// ─── OTP storage ─────────────────────────────────────────────────
async function saveOtpChallenge({ challengeId, userId, email, purpose, otp, deviceInfo, ip, location }) {
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    const { error } = await supabaseAdmin.from('otp_challenges').insert({
        challenge_id: challengeId,
        user_id:      userId,
        email:        email,
        purpose:      purpose,
        otp_hash:     hashOtp(otp),
        max_attempts: MAX_OTP_ATTEMPTS,
        expires_at:   expiresAt.toISOString(),
        metadata:     { deviceInfo, ip, location }
    });
    if (error) throw error;
    return expiresAt;
}

async function loadOtpChallenge(challengeId, purpose) {
    const { data, error } = await supabaseAdmin
        .from('otp_challenges')
        .select('*')
        .eq('challenge_id', challengeId)
        .eq('purpose', purpose)
        .eq('consumed', false)
        .maybeSingle();
    if (error) throw error;
    return data;
}

// ─── ATOMIC OTP attempt increment ────────────────────────────────
// Uses the `increment_otp_attempts` RPC when present.
// Falls back to read-then-write so the route keeps working on an
// older database, but logs a warning — the fallback is NOT atomic.
//
// Required migration (run once):
//   CREATE OR REPLACE FUNCTION public.increment_otp_attempts(
//       p_challenge_id text
//   ) RETURNS TABLE(attempts integer, max_attempts integer)
//   LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
//   BEGIN
//       RETURN QUERY
//       UPDATE public.otp_challenges
//          SET attempts = otp_challenges.attempts + 1
//        WHERE challenge_id = p_challenge_id
//        RETURNING otp_challenges.attempts, otp_challenges.max_attempts;
//   END;
//   $$;
async function incrementOtpAttempts(challengeId) {
    // Preferred: atomic RPC
    try {
        const { data, error } = await supabaseAdmin.rpc('increment_otp_attempts', {
            p_challenge_id: challengeId
        });
        if (!error) {
            const row = Array.isArray(data) ? data[0] : data;
            if (row && typeof row.attempts === 'number') {
                return { attempts: row.attempts, max_attempts: row.max_attempts };
            }
        }
        // If the RPC exists but returned nothing, fall through.
        if (error && !/function|does not exist|schema cache/i.test(String(error.message))) {
            throw error;
        }
    } catch (rpcErr) {
        // Only log the fallback when it's a real error, not a missing function.
        if (!/function|does not exist|schema cache/i.test(String(rpcErr.message))) {
            console.warn('[OTP] RPC increment failed, using fallback:', rpcErr.message);
        }
    }

    // Fallback: read-then-write. NOT atomic across replicas.
    console.warn('[OTP] Using non-atomic attempt counter — run increment_otp_attempts migration.');
    const { data: current, error: readErr } = await supabaseAdmin
        .from('otp_challenges')
        .select('id, attempts, max_attempts')
        .eq('challenge_id', challengeId)
        .single();
    if (readErr) throw readErr;

    const nextAttempts = (current.attempts || 0) + 1;
    const { error: writeErr } = await supabaseAdmin
        .from('otp_challenges')
        .update({ attempts: nextAttempts })
        .eq('id', current.id);
    if (writeErr) throw writeErr;

    return { attempts: nextAttempts, max_attempts: current.max_attempts };
}

async function consumeOtpChallenge(challengeId, markVerified = false) {
    const { error } = await supabaseAdmin
        .from('otp_challenges')
        .update({
            consumed:    true,
            verified:    markVerified,
            consumed_at: new Date().toISOString()
        })
        .eq('challenge_id', challengeId);
    if (error) console.error('[OTP] consume failed:', error);
}

async function supersedeOldChallenges(email, purpose) {
    const { error } = await supabaseAdmin
        .from('otp_challenges')
        .update({ consumed: true, consumed_at: new Date().toISOString() })
        .eq('email', email)
        .eq('purpose', purpose)
        .eq('consumed', false);
    if (error) console.error('[OTP] supersede failed:', error);
}

// ─── User settings read (NO INSERT ON READ) ─────────────────────
// Registration creates the row. If it's missing here, we simply
// return the safe default rather than performing a write on a GET
// path — writing on read caused a 23505 race under load.
async function getUserSettings(userId) {
    try {
        const { data, error } = await supabaseAdmin
            .from('user_settings')
            .select('email_2fa_enabled')
            .eq('user_id', userId)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            console.warn('[AUTH] getUserSettings error:', error.message);
        }
        if (!data) return { email_2fa_enabled: false };
        return data;
    } catch (e) {
        console.error('[AUTH] getUserSettings threw:', e.message);
        return { email_2fa_enabled: false };
    }
}

// ═════════════════════════════════════════════════════════════════
// REGISTER
// ═════════════════════════════════════════════════════════════════
router.post('/register', registerLimiter, async (req, res) => {
    try {
        const { email, password, username } = req.body || {};
        const normalizedEmail = normalizeEmail(email);

        if (!normalizedEmail || !password || !username) {
            return res.status(400).json({
                success: false, code: 'MISSING_FIELDS',
                message: 'Email, password, and username are required.'
            });
        }

        const usernameError = validateUsername(username);
        if (usernameError) {
            return res.status(400).json({
                success: false, code: 'INVALID_USERNAME', message: usernameError
            });
        }

        const pwErrors = validatePassword(password);
        if (pwErrors.length) {
            return res.status(400).json({
                success: false, code: 'PASSWORD_WEAK',
                message: `Password must have: ${pwErrors.join(', ')}`
            });
        }

        const { data: existingUser } = await supabaseAdmin
            .from('profiles').select('id').eq('username', username).maybeSingle();
        if (existingUser) {
            return res.status(400).json({
                success: false, code: 'USERNAME_TAKEN',
                message: 'Username is already taken.'
            });
        }

        const { data: existingEmail } = await supabaseAdmin
            .from('profiles').select('id').eq('email', normalizedEmail).maybeSingle();
        if (existingEmail) {
            return res.status(400).json({
                success: false, code: 'EMAIL_TAKEN',
                message: 'Email is already registered.'
            });
        }

        const { data: authData, error: authError } =
            await supabaseAdmin.auth.admin.createUser({
                email: normalizedEmail,
                password,
                email_confirm: false,
                user_metadata: { username }
            });

        if (authError) {
            console.error('Auth creation error:', authError);
            return res.status(400).json({
                success: false, code: 'REGISTRATION_FAILED',
                message: authError.message || 'Failed to create account.'
            });
        }

        const userId = authData.user.id;
        const referralCode = generateReferralCode();

        const { error: profileError } = await supabaseAdmin.from('profiles').insert({
            id:            userId,
            email:         normalizedEmail,
            username,
            referral_code: referralCode,
            status:        'active',
            is_verified:   false,
            role:          'user',
            wallet_ngn:    0,
            wallet_usd:    0,
            created_at:    new Date().toISOString()
        });

        if (profileError) {
            console.error('Profile creation error:', profileError);
            await supabaseAdmin.auth.admin.deleteUser(userId);
            return res.status(500).json({
                success: false, code: 'PROFILE_CREATION_FAILED',
                message: 'Failed to create profile.'
            });
        }

        // Create user_settings here — the ONE place this row is created.
        const { error: settingsError } = await supabaseAdmin.from('user_settings').insert({
            user_id:           userId,
            email_2fa_enabled: false,
            created_at:        new Date().toISOString(),
            updated_at:        new Date().toISOString()
        });
        if (settingsError) {
            console.warn('user_settings insert failed (non-fatal):', settingsError.message);
        }

        await supersedeOldChallenges(normalizedEmail, 'registration');
        const otp = generateSecureOtp();
        const challengeId = generateChallengeId();
        const deviceInfo = getUserAgentInfo(req);
        const ip = getClientIP(req);

        await saveOtpChallenge({
            challengeId, userId, email: normalizedEmail,
            purpose: 'registration', otp, deviceInfo, ip, location: null
        });

        const emailResult = await emailService.sendVerificationEmail(
            normalizedEmail, username, otp
        );
        if (!emailResult?.success) {
            console.error('Registration OTP email failed');
            return res.status(503).json({
                success: false, code: 'EMAIL_FAILED',
                message: 'Could not send verification code.'
            });
        }

        return res.status(201).json({
            success: true,
            requires_verification: true,
            challenge_id: challengeId,
            expires_in: OTP_EXPIRY_MINUTES,
            message: 'Account created. Check your email for the verification code.',
            data: { user: { id: userId, email: normalizedEmail, username } }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            success: false, code: 'SERVER_ERROR',
            message: 'Something went wrong. Please try again.'
        });
    }
});

// ═════════════════════════════════════════════════════════════════
// REGISTER VERIFY
// ═════════════════════════════════════════════════════════════════
router.post('/register/verify', otpLimiter, async (req, res) => {
    try {
        const { challenge_id, code } = req.body || {};
        if (!challenge_id || !code) {
            return res.status(400).json({
                success: false, code: 'VERIFICATION_REQUIRED',
                message: 'Please enter the verification code.'
            });
        }

        const submitted = String(code).trim();
        if (!/^\d{6}$/.test(submitted)) {
            return res.status(400).json({
                success: false, code: 'INVALID_CODE_FORMAT',
                message: 'Please enter the 6-digit code.'
            });
        }

        const challenge = await loadOtpChallenge(challenge_id, 'registration');
        if (!challenge) {
            return res.status(400).json({
                success: false, code: 'SESSION_EXPIRED',
                message: 'Verification session expired.'
            });
        }

        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(challenge_id);
            return res.status(400).json({
                success: false, code: 'CODE_EXPIRED',
                message: 'Verification code expired.'
            });
        }

        if (challenge.attempts >= challenge.max_attempts) {
            await consumeOtpChallenge(challenge_id);
            return res.status(400).json({
                success: false, code: 'TOO_MANY_ATTEMPTS',
                message: 'Too many attempts. Please register again.'
            });
        }

        const attempts = await incrementOtpAttempts(challenge_id);
        if (attempts.attempts > attempts.max_attempts) {
            await consumeOtpChallenge(challenge_id);
            return res.status(400).json({
                success: false, code: 'TOO_MANY_ATTEMPTS',
                message: 'Too many attempts. Please register again.'
            });
        }

        if (!safeCompare(hashOtp(submitted), challenge.otp_hash)) {
            const remaining = Math.max(0, challenge.max_attempts - attempts.attempts);
            return res.status(400).json({
                success: false, code: 'INVALID_CODE',
                message: `Incorrect code. ${remaining} attempt(s) remaining.`
            });
        }

        await consumeOtpChallenge(challenge_id, true);

        const { error: updErr } = await supabaseAdmin
            .from('profiles')
            .update({ is_verified: true, updated_at: new Date().toISOString() })
            .eq('id', challenge.user_id);

        if (updErr) {
            console.error('[REGISTER VERIFY] profile update failed:', updErr);
            return res.status(500).json({
                success: false, code: 'SERVER_ERROR',
                message: 'Something went wrong.'
            });
        }

        return res.json({
            success: true,
            message: 'Email verified. You can now sign in.'
        });
    } catch (error) {
        console.error('Register verify error:', error);
        res.status(500).json({
            success: false, code: 'SERVER_ERROR',
            message: 'Something went wrong.'
        });
    }
});

// ═════════════════════════════════════════════════════════════════
// LOGIN
// ═════════════════════════════════════════════════════════════════
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body || {};
        const normalizedEmail = normalizeEmail(email);
        const ip = getClientIP(req);
        const deviceInfo = getUserAgentInfo(req);

        if (!normalizedEmail || !password) {
            return res.status(400).json({
                success: false, code: 'EMAIL_PASSWORD_REQUIRED',
                message: 'Please enter your email and password.'
            });
        }

        let signInData, signInError;
        try {
            const result = await withRetry(
                () => supabase.auth.signInWithPassword({ email: normalizedEmail, password }),
                2, 1000
            );
            signInData  = result.data;
            signInError = result.error;
        } catch (e) {
            return res.status(503).json({
                success: false, code: 'SERVICE_UNAVAILABLE',
                message: 'Authentication service is temporarily unavailable.'
            });
        }

        if (signInError) {
            return res.status(401).json({
                success: false, code: 'INVALID_CREDENTIALS',
                message: 'Incorrect email or password.'
            });
        }

        const user = signInData.user;

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, status, deleted_at, wallet_ngn, wallet_usd, referral_code, is_verified, transaction_pin_hash, login_count')
            .eq('id', user.id)
            .single();

        if (profileError || !profile) {
            return res.status(503).json({
                success: false, code: 'SERVICE_UNAVAILABLE',
                message: 'Unable to retrieve profile.'
            });
        }

        // ─── Central account-state policy (deleted/deactivated/suspended)
        const denied = evaluateAccountAccess(profile);
        if (denied) {
            return res.status(denied.status).json({
                success: false, code: denied.code, message: denied.message
            });
        }

        if (profile.role === 'admin' || profile.role === 'super_admin') {
            return res.status(403).json({
                success: false, code: 'ADMIN_LOGIN_REQUIRED',
                message: 'Please use the admin sign-in page.'
            });
        }

        if (!profile.is_verified) {
            return res.status(403).json({
                success: false, code: 'EMAIL_NOT_VERIFIED',
                message: 'Please verify your email first.'
            });
        }

        let location = 'Unknown';
        if (!IS_DEVELOPMENT) { try { location = await getLocationFromIP(ip); } catch {} }

        const settings = await getUserSettings(profile.id);
        const email2faEnabled = settings?.email_2fa_enabled || false;

        if (email2faEnabled) {
            await supersedeOldChallenges(profile.email, 'login_2fa');
            const otp = generateSecureOtp();
            const challengeId = generateChallengeId();

            await saveOtpChallenge({
                challengeId, userId: profile.id, email: profile.email,
                purpose: 'login_2fa', otp, deviceInfo, ip, location
            });

            const emailResult = await emailService.send2FAEmail(
                profile.email, profile.username || 'User', otp, deviceInfo, location, ip
            );
            if (!emailResult?.success) {
                await consumeOtpChallenge(challengeId);
                return res.status(503).json({
                    success: false, code: 'EMAIL_FAILED',
                    message: 'Could not send verification code.'
                });
            }

            return res.json({
                success: true,
                requires_2fa: true,
                challenge_id: challengeId,
                message: 'A verification code has been sent to your email.',
                expires_in: OTP_EXPIRY_MINUTES
            });
        }

        // ─── No 2FA — establish session directly ────────────────
        const session = await sessionService.createSessionAtomic({
            userId: profile.id, deviceInfo, ipAddress: ip
        });

        const accessToken = generateAccessToken(profile.id, session.sessionId, profile.role);
        setRefreshCookie(res, session.refreshToken);

        await supabaseAdmin.from('profiles').update({
            last_login:          new Date().toISOString(),
            last_ip:             ip,
            last_seen:           new Date().toISOString(),
            last_login_browser:  deviceInfo.browser,
            last_login_os:       deviceInfo.os,
            last_login_device:   deviceInfo.device,
            last_login_location: location,
            last_location:       location,
            login_count:         (profile.login_count || 0) + 1,
            updated_at:          new Date().toISOString()
        }).eq('id', profile.id);

        await logSecurityActivity({
            userId: profile.id, eventType: 'login',
            description: 'Successful login',
            ip, userAgent: req.headers['user-agent'], deviceInfo, location,
            metadata: { email_2fa_enabled: false, session_id: session.sessionId }
        });

        return res.json({
            success: true,
            message: 'Sign in successful!',
            data: {
                user: {
                    id:                  profile.id,
                    email:               profile.email,
                    username:            profile.username,
                    role:                profile.role,
                    wallet_ngn:          parseFloat(profile.wallet_ngn) || 0,
                    wallet_usd:          parseFloat(profile.wallet_usd) || 0,
                    referral_code:       profile.referral_code || '',
                    has_transaction_pin: !!profile.transaction_pin_hash,
                    is_verified:         profile.is_verified || false,
                    email_2fa_enabled:   false,
                    last_login:          new Date().toISOString()
                },
                access_token:       accessToken,
                expires_in:         ACCESS_TOKEN_TTL_SECONDS,
                refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
                session_id:         session.sessionId
                // refresh_token lives in the HttpOnly cookie, not the body.
            }
        });
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({
            success: false, code: 'SERVER_ERROR',
            message: 'We could not sign you in. Please try again.'
        });
    }
});

// ═════════════════════════════════════════════════════════════════
// LOGIN VERIFY 2FA
// ═════════════════════════════════════════════════════════════════
router.post('/login/verify-2fa', otpLimiter, async (req, res) => {
    try {
        const { challenge_id, code } = req.body || {};
        if (!challenge_id || !code) {
            return res.status(400).json({
                success: false, code: 'VERIFICATION_REQUIRED',
                message: 'Please enter the verification code.'
            });
        }

        const submitted = String(code).trim();
        if (!/^\d{6}$/.test(submitted)) {
            return res.status(400).json({
                success: false, code: 'INVALID_CODE_FORMAT',
                message: 'Please enter the 6-digit code.'
            });
        }

        const challenge = await loadOtpChallenge(challenge_id, 'login_2fa');
        if (!challenge) {
            return res.status(400).json({
                success: false, code: 'SESSION_EXPIRED',
                message: 'Verification session expired.'
            });
        }

        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(challenge_id);
            return res.status(400).json({
                success: false, code: 'CODE_EXPIRED',
                message: 'Verification code expired.'
            });
        }

        const attempts = await incrementOtpAttempts(challenge_id);
        if (attempts.attempts > attempts.max_attempts) {
            await consumeOtpChallenge(challenge_id);
            return res.status(400).json({
                success: false, code: 'TOO_MANY_ATTEMPTS',
                message: 'Too many attempts. Please log in again.'
            });
        }

        if (!safeCompare(hashOtp(submitted), challenge.otp_hash)) {
            const remaining = Math.max(0, challenge.max_attempts - attempts.attempts);
            return res.status(400).json({
                success: false, code: 'INVALID_CODE',
                message: `Incorrect code. ${remaining} attempt(s) remaining.`
            });
        }

        await consumeOtpChallenge(challenge_id, true);

        // ─── Re-verify account state immediately before session creation
        const { data: pre } = await supabaseAdmin
            .from('profiles')
            .select('id, status, deleted_at')
            .eq('id', challenge.user_id)
            .single();

        const denied = evaluateAccountAccess(pre);
        if (denied) {
            return res.status(denied.status).json({
                success: false, code: denied.code, message: denied.message
            });
        }

        const deviceInfo = getUserAgentInfo(req);
        const ip = getClientIP(req);

        const session = await sessionService.createSessionAtomic({
            userId: challenge.user_id, deviceInfo, ipAddress: ip
        });

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, wallet_ngn, wallet_usd, referral_code, is_verified, transaction_pin_hash, login_count')
            .eq('id', challenge.user_id)
            .single();

        const accessToken = generateAccessToken(profile.id, session.sessionId, profile.role);
        setRefreshCookie(res, session.refreshToken);

        await supabaseAdmin.from('profiles').update({
            last_login:  new Date().toISOString(),
            last_seen:   new Date().toISOString(),
            login_count: (profile.login_count || 0) + 1,
            updated_at:  new Date().toISOString()
        }).eq('id', profile.id);

        await logSecurityActivity({
            userId: profile.id, eventType: 'login',
            description: 'Successful login (2FA verified)',
            ip, userAgent: req.headers['user-agent'], deviceInfo, location: null,
            metadata: { email_2fa_enabled: true, session_id: session.sessionId }
        });

        return res.json({
            success: true,
            message: 'Verified. Sign-in complete.',
            data: {
                user: {
                    id:                  profile.id,
                    email:               profile.email,
                    username:            profile.username,
                    role:                profile.role,
                    wallet_ngn:          parseFloat(profile.wallet_ngn) || 0,
                    wallet_usd:          parseFloat(profile.wallet_usd) || 0,
                    referral_code:       profile.referral_code || '',
                    has_transaction_pin: !!profile.transaction_pin_hash,
                    is_verified:         profile.is_verified || false,
                    email_2fa_enabled:   true
                },
                access_token:       accessToken,
                expires_in:         ACCESS_TOKEN_TTL_SECONDS,
                refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
                session_id:         session.sessionId,
                verified:           true
            }
        });
    } catch (error) {
        console.error('2FA verify error:', error);
        res.status(500).json({
            success: false, code: 'SERVER_ERROR',
            message: 'Something went wrong.'
        });
    }
});

// ═════════════════════════════════════════════════════════════════
// RESEND OTP
// ═════════════════════════════════════════════════════════════════
router.post('/login/resend-otp', resendOtpLimiter, async (req, res) => {
    try {
        const { challenge_id } = req.body || {};
        if (!challenge_id) {
            return res.status(400).json({
                success: false, code: 'CHALLENGE_ID_REQUIRED',
                message: 'Challenge ID required.'
            });
        }

        const challenge = await loadOtpChallenge(challenge_id, 'login_2fa');
        if (!challenge) {
            return res.status(400).json({
                success: false, code: 'SESSION_EXPIRED',
                message: 'Verification session expired.'
            });
        }

        const newOtp = generateSecureOtp();
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        const { error: updErr } = await supabaseAdmin
            .from('otp_challenges')
            .update({
                otp_hash:   hashOtp(newOtp),
                expires_at: expiresAt.toISOString(),
                attempts:   0
            })
            .eq('challenge_id', challenge_id);
        if (updErr) {
            console.error('[RESEND OTP] update failed:', updErr);
            return res.status(500).json({
                success: false, code: 'SERVER_ERROR',
                message: 'Something went wrong.'
            });
        }

        const emailResult = await emailService.send2FAEmail(
            challenge.email, 'User', newOtp, {}, 'Unknown', 'unknown'
        );
        if (!emailResult?.success) {
            return res.status(503).json({
                success: false, code: 'EMAIL_FAILED',
                message: 'Could not send verification code.'
            });
        }

        return res.json({
            success: true,
            message: 'A new verification code has been sent.',
            expires_in: OTP_EXPIRY_MINUTES
        });
    } catch (error) {
        console.error('Resend OTP error:', error);
        res.status(500).json({
            success: false, code: 'SERVER_ERROR',
            message: 'Something went wrong.'
        });
    }
});

// ═════════════════════════════════════════════════════════════════
// REFRESH — cookie-only, atomic rotation
// ═════════════════════════════════════════════════════════════════
router.post('/refresh', refreshLimiter, async (req, res) => {
    try {
        const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
        if (!rawToken) {
            clearRefreshCookie(res);
            return res.status(401).json({
                success: false, code: 'NO_REFRESH_TOKEN',
                message: 'No active session. Please sign in again.'
            });
        }

        const refreshHash = sessionService.hashRefreshToken(rawToken);
        const session = await sessionService.findSessionByRefreshHash(refreshHash);

        if (!session) {
            clearRefreshCookie(res);
            return res.status(401).json({
                success: false, code: 'SESSION_REVOKED',
                message: 'Your session is no longer active. Please sign in again.'
            });
        }

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, status, deleted_at')
            .eq('id', session.user_id)
            .single();

        // ─── Central account-state policy (deleted/deactivated/suspended)
        const denied = evaluateAccountAccess(profile);
        if (denied) {
            await sessionService.revokeSessionAtomic(session.session_id);
            clearRefreshCookie(res);
            return res.status(denied.status).json({
                success: false, code: denied.code, message: denied.message
            });
        }

        const rotated = await sessionService.rotateRefreshTokenAtomic(session.session_id, rawToken);
        if (!rotated.ok) {
            clearRefreshCookie(res);
            return res.status(401).json({
                success: false, code: 'SESSION_REVOKED',
                message: 'Security violation detected. Please sign in again.'
            });
        }

        const accessToken = generateAccessToken(profile.id, session.session_id, profile.role);
        setRefreshCookie(res, rotated.refreshToken);

        return res.json({
            success: true,
            data: {
                access_token:       accessToken,
                expires_in:         ACCESS_TOKEN_TTL_SECONDS,
                refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS
            }
        });
    } catch (error) {
        console.error('Refresh error:', error);
        clearRefreshCookie(res);
        res.status(500).json({
            success: false, code: 'SERVER_ERROR',
            message: 'Something went wrong.'
        });
    }
});

// ═════════════════════════════════════════════════════════════════
// LOGOUT
// ═════════════════════════════════════════════════════════════════
router.post('/logout', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const sessionId = req.user.session_id;
        if (sessionId) {
            await sessionService.revokeSessionAtomic(sessionId);
        }
        clearRefreshCookie(res);

        await logSecurityActivity({
            userId, eventType: 'logout',
            description: 'User logged out',
            ip: getClientIP(req),
            userAgent: req.headers['user-agent'],
            metadata: { session_id: sessionId }
        });

        return res.json({
            success: true,
            message: 'You have been signed out successfully.'
        });
    } catch (error) {
        console.error('Logout error:', error);
        clearRefreshCookie(res);
        res.status(500).json({
            success: false, code: 'SERVER_ERROR',
            message: 'Something went wrong.'
        });
    }
});

// ═════════════════════════════════════════════════════════════════
// SESSION
// ═════════════════════════════════════════════════════════════════
router.get('/session', authMiddleware, async (req, res) => {
    return res.json({
        success: true,
        authenticated: true,
        user: {
            id:       req.user.id,
            email:    req.user.email,
            username: req.user.username,
            role:     req.user.role
        },
        session_id: req.user.session_id
    });
});

// ═════════════════════════════════════════════════════════════════
// ME
// ═════════════════════════════════════════════════════════════════
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, status, wallet_ngn, wallet_usd, referral_code, is_verified, transaction_pin_hash, last_login, last_seen, last_login_location, last_ip, last_login_device')
            .eq('id', req.user.id)
            .single();

        if (error || !profile) {
            return res.status(404).json({
                success: false, code: 'USER_NOT_FOUND',
                message: 'User not found.'
            });
        }

        const settings = await getUserSettings(req.user.id);
        const email2faEnabled = settings?.email_2fa_enabled || false;
        const isAdmin = profile.role === 'admin' || profile.role === 'super_admin';
        const lastSeen = profile.last_seen ? new Date(profile.last_seen).getTime() : 0;
        const isOnline = lastSeen > 0 && (Date.now() - lastSeen <= 90 * 1000);

        return res.json({
            success: true,
            data: {
                id:                    profile.id,
                email:                 profile.email,
                username:              profile.username,
                role:                  profile.role || 'user',
                isAdmin,
                isSuperAdmin:          profile.role === 'super_admin',
                wallet_ngn:            parseFloat(profile.wallet_ngn) || 0,
                wallet_usd:            parseFloat(profile.wallet_usd) || 0,
                referral_code:         profile.referral_code || '',
                status:                profile.status || 'active',
                has_transaction_pin:   !!profile.transaction_pin_hash,
                is_verified:           profile.is_verified || false,
                email_2fa_enabled:     email2faEnabled,
                dashboard_url:         isAdmin ? '/admin/dashboard' : '/dashboard',
                last_login:            profile.last_login,
                last_login_location:   profile.last_login_location,
                last_login_ip:         profile.last_ip,
                last_login_device:     profile.last_login_device,
                last_seen:             profile.last_seen,
                is_online:             isOnline
            }
        });
    } catch (error) {
        console.error('Me error:', error);
        res.status(500).json({ success: false, code: 'SERVER_ERROR' });
    }
});

// ═════════════════════════════════════════════════════════════════
// FORGOT PASSWORD
// ═════════════════════════════════════════════════════════════════
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
    try {
        const { email } = req.body || {};
        const normalizedEmail = normalizeEmail(email);

        if (!normalizedEmail) {
            return res.status(400).json({
                success: false, code: 'EMAIL_REQUIRED',
                message: 'Please enter your email address.'
            });
        }

        const genericResponse = {
            success: true,
            message: 'If an account exists for this email, a reset code has been sent.'
        };

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, status, deleted_at')
            .eq('email', normalizedEmail)
            .is('deleted_at', null)
            .maybeSingle();

        if (!profile) return res.json(genericResponse);

        // Refuse to send reset codes for accounts that cannot sign in.
        if (profile.status === 'suspended' ||
            profile.status === 'deactivated' ||
            profile.status === 'deleted') {
            return res.json(genericResponse);
        }

        await supersedeOldChallenges(normalizedEmail, 'password_reset');
        const otp = generateSecureOtp();
        const challengeId = generateChallengeId();

        await saveOtpChallenge({
            challengeId, userId: profile.id, email: profile.email,
            purpose: 'password_reset', otp,
            deviceInfo: {}, ip: getClientIP(req), location: null
        });

        const emailResult = await emailService.sendPasswordResetOTP(
            profile.email, profile.username || 'User', otp
        );

        if (!emailResult?.success) {
            await consumeOtpChallenge(challengeId);
            return res.json(genericResponse);
        }

        return res.json({
            ...genericResponse,
            reset_id: challengeId,
            expires_in: OTP_EXPIRY_MINUTES
        });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, code: 'SERVER_ERROR' });
    }
});

// ═════════════════════════════════════════════════════════════════
// VERIFY RESET CODE
// ═════════════════════════════════════════════════════════════════
router.post('/verify-reset-code', otpLimiter, async (req, res) => {
    try {
        const { reset_id, code } = req.body || {};
        if (!reset_id || !code) {
            return res.status(400).json({
                success: false, code: 'VERIFICATION_REQUIRED',
                message: 'Please enter the reset code.'
            });
        }

        const submitted = String(code).trim();
        if (!/^\d{6}$/.test(submitted)) {
            return res.status(400).json({
                success: false, code: 'INVALID_CODE_FORMAT',
                message: 'Please enter the 6-digit reset code.'
            });
        }

        const challenge = await loadOtpChallenge(reset_id, 'password_reset');
        if (!challenge) {
            return res.status(400).json({
                success: false, code: 'SESSION_EXPIRED',
                message: 'Reset session expired.'
            });
        }

        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(reset_id);
            return res.status(400).json({
                success: false, code: 'CODE_EXPIRED',
                message: 'Reset code expired.'
            });
        }

        const attempts = await incrementOtpAttempts(reset_id);
        if (attempts.attempts > attempts.max_attempts) {
            await consumeOtpChallenge(reset_id);
            return res.status(400).json({
                success: false, code: 'TOO_MANY_ATTEMPTS',
                message: 'Too many attempts. Please request a new code.'
            });
        }

        if (!safeCompare(hashOtp(submitted), challenge.otp_hash)) {
            const remaining = Math.max(0, challenge.max_attempts - attempts.attempts);
            return res.status(400).json({
                success: false, code: 'INVALID_CODE',
                message: `Incorrect code. ${remaining} attempt(s) remaining.`
            });
        }

        const { error: verErr } = await supabaseAdmin
            .from('otp_challenges')
            .update({ verified: true })
            .eq('challenge_id', reset_id);
        if (verErr) {
            console.error('[VERIFY RESET] mark verified failed:', verErr);
            return res.status(500).json({ success: false, code: 'SERVER_ERROR' });
        }

        return res.json({
            success: true,
            message: 'Code verified. You can now reset your password.',
            reset_id
        });
    } catch (error) {
        console.error('Verify reset code error:', error);
        res.status(500).json({ success: false, code: 'SERVER_ERROR' });
    }
});

// ═════════════════════════════════════════════════════════════════
// RESET PASSWORD
// ═════════════════════════════════════════════════════════════════
router.post('/reset-password', async (req, res) => {
    try {
        const { reset_id, new_password } = req.body || {};
        if (!reset_id || !new_password) {
            return res.status(400).json({
                success: false, code: 'RESET_REQUIRED',
                message: 'Please enter your new password.'
            });
        }

        const challenge = await loadOtpChallenge(reset_id, 'password_reset');
        if (!challenge || !challenge.verified) {
            return res.status(400).json({
                success: false, code: 'CODE_NOT_VERIFIED',
                message: 'Please verify your reset code first.'
            });
        }

        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(reset_id);
            return res.status(400).json({
                success: false, code: 'SESSION_EXPIRED',
                message: 'Reset session expired.'
            });
        }

        // Refuse to reset the password of a deleted/suspended/deactivated account.
        const { data: preProfile } = await supabaseAdmin
            .from('profiles')
            .select('id, status, deleted_at')
            .eq('id', challenge.user_id)
            .single();
        const denied = evaluateAccountAccess(preProfile);
        if (denied) {
            await consumeOtpChallenge(reset_id);
            return res.status(denied.status).json({
                success: false, code: denied.code, message: denied.message
            });
        }

        const pwErrors = validatePassword(new_password);
        if (pwErrors.length) {
            return res.status(400).json({
                success: false, code: 'PASSWORD_WEAK',
                message: `Your password must have: ${pwErrors.join(', ')}`
            });
        }

        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
            challenge.user_id, { password: new_password }
        );
        if (updateError) {
            return res.status(500).json({
                success: false, code: 'PASSWORD_UPDATE_FAILED',
                message: 'Could not update your password.'
            });
        }

        await consumeOtpChallenge(reset_id, true);

        await supabaseAdmin.from('user_sessions')
            .update({
                is_active:  false,
                is_current: false,
                revoked_at: new Date().toISOString()
            })
            .eq('user_id', challenge.user_id)
            .eq('is_active', true);

        await supabaseAdmin.from('profiles')
            .update({
                current_session_id: null,
                session_created_at: null,
                session_expires_at: null
            })
            .eq('id', challenge.user_id);

        await logSecurityActivity({
            userId: challenge.user_id,
            eventType: 'password_changed',
            description: 'Password reset via forgot password flow'
        });

        return res.json({
            success: true,
            message: 'Password reset successful. Please sign in.'
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, code: 'SERVER_ERROR' });
    }
});

// ═════════════════════════════════════════════════════════════════
// HEARTBEAT
// ═════════════════════════════════════════════════════════════════
router.post('/heartbeat', authMiddleware, async (req, res) => {
    try {
        const now = new Date().toISOString();
        const { error: profileErr } = await supabaseAdmin
            .from('profiles')
            .update({ last_seen: now, updated_at: now })
            .eq('id', req.user.id);
        if (profileErr) console.error('[HEARTBEAT] profile update failed:', profileErr);

        const { error: sessionErr } = await supabaseAdmin
            .from('user_sessions')
            .update({ last_activity_at: now })
            .eq('session_id', req.user.session_id);
        if (sessionErr) console.error('[HEARTBEAT] session update failed:', sessionErr);

        return res.json({ success: true, last_seen: now });
    } catch (error) {
        console.error('Heartbeat error:', error);
        res.status(500).json({ success: false, code: 'SERVER_ERROR' });
    }
});

// ═════════════════════════════════════════════════════════════════
// HEALTH
// ═════════════════════════════════════════════════════════════════
router.get('/health', async (req, res) => {
    try {
        const { error } = await supabaseAdmin.from('profiles').select('id').limit(1);
        if (error) throw error;
        res.json({
            success: true,
            status: 'healthy',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            token_config: {
                access_token_ttl_seconds:  ACCESS_TOKEN_TTL_SECONDS,
                refresh_token_ttl_seconds: REFRESH_TOKEN_TTL_SECONDS
            }
        });
    } catch (error) {
        res.status(503).json({
            success: false, status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: 'Database connection failed'
        });
    }
});

module.exports = router;