// routes/authRoutes.js - COMPLETE FIXED VERSION
// With proper rate limiters only on sensitive endpoints

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { supabase, supabaseAdmin, withRetry } = require('../db/supabase');
const { authMiddleware, AUTH_CODES } = require('../middleware/auth');
const emailService = require('../services/emailService');
const { getClientIP, getLocationFromIP } = require('../utils/ipUtils');

// ─── IMPORT RATE LIMITERS ──────────────────────────────────────────
const {
    loginLimiter,
    registerLimiter,
    otpLimiter,
    resendOtpLimiter,
    refreshLimiter,
    passwordResetLimiter
} = require('../middleware/rateLimiter');

const router = express.Router();

// ─── CONFIG ──────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ CRITICAL: JWT_SECRET environment variable is required');
    if (process.env.NODE_ENV === 'production') process.exit(1);
}

const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '1h';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';
const SESSION_DURATION = 8 * 60 * 60 * 1000;
const OTP_EXPIRY_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';

// ─── PARSE DURATION HELPER ─────────────────────────────────────────
function parseDurationToMs(value) {
    const match = String(value).trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
    if (!match) {
        console.warn(`⚠️ Invalid duration format: ${value}, using default 7d`);
        return 7 * 24 * 60 * 60 * 1000;
    }
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multipliers = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000
    };
    return amount * multipliers[unit];
}

const REFRESH_TOKEN_DURATION_MS = parseDurationToMs(REFRESH_TOKEN_EXPIRES_IN);

// ─── OTP SECRET ─────────────────────────────────────────────────────
const OTP_SECRET = process.env.OTP_SECRET || 'milesspace-otp-secret-change-in-production';

function hashValue(value) {
    return crypto.createHmac('sha256', OTP_SECRET).update(String(value)).digest('hex');
}

function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
        return false;
    }
}

// ─── IN-MEMORY STORE ──────────────────────────────────────────────
const stores = {
    failedAttempts: new Map(),
    pending2FA: new Map(),
    refreshTokens: new Map(),
    usedRefreshTokens: new Map()
};

// ─── CLEANUP INTERVAL ──────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of stores.pending2FA.entries()) {
        if (data.expires_at && now > data.expires_at) {
            stores.pending2FA.delete(key);
        }
    }
    for (const [key, data] of stores.refreshTokens.entries()) {
        if (data.expires_at && now > data.expires_at) {
            stores.refreshTokens.delete(key);
        }
    }
    for (const [key, data] of stores.usedRefreshTokens.entries()) {
        if (data.expires_at && now > data.expires_at) {
            stores.usedRefreshTokens.delete(key);
        }
    }
}, 60 * 1000);

// ─── HELPERS ──────────────────────────────────────────────────────

function normalizeEmail(email) {
    return email ? String(email).trim().toLowerCase() : '';
}

function validatePassword(password) {
    const errors = [];
    if (!password || password.length < 8) errors.push('at least 8 characters');
    if (!/[A-Z]/.test(password)) errors.push('one uppercase letter');
    if (!/[a-z]/.test(password)) errors.push('one lowercase letter');
    if (!/[0-9]/.test(password)) errors.push('one number');
    return errors;
}

function validateUsername(username) {
    if (!username || username.length < 3) {
        return 'Username must be at least 3 characters';
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return 'Username can only contain letters, numbers, and underscores';
    }
    return null;
}

function generateSecureOTP() {
    return crypto.randomInt(100000, 1000000).toString().padStart(6, '0');
}

function generateReferralCode() {
    return 'MX' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function generateRefreshToken() {
    return crypto.randomBytes(40).toString('hex');
}

function generateSessionId() {
    return crypto.randomUUID();
}

function generateAccessToken(userId, sessionId, role = 'user') {
    return jwt.sign(
        { id: userId, sid: sessionId, role: role },
        JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
    );
}

function getUserAgentInfo(req) {
    const ua = req.headers['user-agent'] || 'Unknown';
    let browser = 'Unknown', os = 'Unknown', device = 'Desktop';
    const rawUserAgent = ua;
    
    if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
    else if (ua.includes('Firefox')) browser = 'Firefox';
    else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
    else if (ua.includes('Edg')) browser = 'Edge';
    else if (ua.includes('OPR') || ua.includes('Opera')) browser = 'Opera';
    else if (ua.includes('Brave')) browser = 'Brave';
    else if (ua.includes('UCBrowser')) browser = 'UC Browser';
    else if (ua.includes('SamsungBrowser')) browser = 'Samsung Internet';
    
    if (ua.includes('Android')) {
        os = 'Android';
    } else if (ua.includes('iPhone') || ua.includes('iPad')) {
        os = 'iOS';
    } else if (ua.includes('Windows')) {
        os = 'Windows';
    } else if (ua.includes('Mac OS X') || ua.includes('Macintosh')) {
        os = 'macOS';
    } else if (ua.includes('Linux')) {
        os = 'Linux';
    } else if (ua.includes('Chrome OS')) {
        os = 'Chrome OS';
    }
    
    if (ua.includes('Mobile')) {
        device = 'Mobile';
    } else if (ua.includes('Tablet')) {
        device = 'Tablet';
    } else if (ua.includes('Windows') || ua.includes('Mac') || ua.includes('Linux')) {
        device = 'Desktop';
    }
    
    return { 
        browser, 
        os, 
        device, 
        userAgent: ua,
        rawUserAgent: rawUserAgent
    };
}

// ─── SESSION MANAGEMENT ──────────────────────────────────────────

async function revokeUserSessions(userId, excludeSessionId = null) {
    console.log(`🔐 [SESSION] Revoking sessions for user ${userId}`);
    
    try {
        let query = supabaseAdmin
            .from('user_sessions')
            .update({
                is_current: false,
                is_active: false,
                revoked_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('is_active', true);

        if (excludeSessionId) {
            query = query.neq('session_id', excludeSessionId);
        }

        await query;
        
        if (!excludeSessionId) {
            await supabaseAdmin
                .from('profiles')
                .update({
                    current_session_id: null,
                    session_created_at: null,
                    session_expires_at: null
                })
                .eq('id', userId);
        }
        
        const tokensToDelete = [];
        for (const [token, data] of stores.refreshTokens.entries()) {
            if (data.user_id === userId) {
                if (!excludeSessionId || data.session_id !== excludeSessionId) {
                    tokensToDelete.push(token);
                }
            }
        }
        for (const token of tokensToDelete) {
            stores.refreshTokens.delete(token);
            stores.usedRefreshTokens.set(token, {
                user_id: userId,
                session_id: excludeSessionId || 'unknown',
                expires_at: Date.now() + 24 * 60 * 60 * 1000
            });
        }
        
    } catch (error) {
        console.error('❌ Error revoking sessions:', error);
    }
}

async function createSession(userId, req, deviceInfo) {
    const sessionId = generateSessionId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_DURATION);
    
    const ip = getClientIP(req);
    const device = deviceInfo || getUserAgentInfo(req);
    
    const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({
            current_session_id: sessionId,
            session_created_at: now.toISOString(),
            session_expires_at: expiresAt.toISOString()
        })
        .eq('id', userId);
    
    if (updateError) {
        console.error('❌ Failed to update profile session:', updateError);
        throw new Error('Failed to create session');
    }
    
    const { error: insertError } = await supabaseAdmin
        .from('user_sessions')
        .insert({
            user_id: userId,
            session_id: sessionId,
            device_name: device.device || 'Unknown Device',
            browser: device.browser || 'Unknown',
            os: device.os || 'Unknown',
            device_type: device.device || 'Desktop',
            ip_address: ip,
            created_at: now.toISOString(),
            last_activity_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
            is_current: true,
            is_active: true
        });
    
    if (insertError) {
        console.error('❌ Failed to insert user_session:', insertError);
        await supabaseAdmin
            .from('profiles')
            .update({
                current_session_id: null,
                session_created_at: null,
                session_expires_at: null
            })
            .eq('id', userId);
        throw new Error('Failed to create session');
    }
    
    return {
        sessionId,
        expiresAt,
        device
    };
}

function generateRefreshTokenPair(userId, sessionId) {
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DURATION_MS);
    
    stores.refreshTokens.set(refreshToken, {
        user_id: userId,
        session_id: sessionId,
        expires_at: expiresAt.getTime(),
        created_at: Date.now()
    });
    
    return { refreshToken, expiresAt };
}

// ─── ACTIVITY LOGGING ────────────────────────────────────────────

async function logSecurityActivity({ userId, eventType, description, ip, userAgent, deviceInfo, location, metadata }) {
    try {
        await supabaseAdmin
            .from('account_activity')
            .insert({
                user_id: userId,
                activity_type: eventType,
                description: description || eventType,
                ip_address: ip || 'unknown',
                location: location || null,
                user_agent: userAgent || 'unknown',
                device_info: deviceInfo || {},
                metadata: metadata || {},
                created_at: new Date().toISOString()
            });
    } catch (error) {
        console.error('Failed to log security activity:', error);
    }
}

// ─── GET USER SETTINGS ───────────────────────────────────────────

async function getUserSettings(userId) {
    try {
        const { data, error } = await supabaseAdmin
            .from('user_settings')
            .select('email_2fa_enabled')
            .eq('user_id', userId)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') throw error;

        if (!data) {
            const defaultSettings = {
                user_id: userId,
                email_2fa_enabled: false,
                notification_preferences: {
                    transaction_completed: true,
                    deposit_received: true,
                    withdrawal_completed: true,
                    crypto_purchase_completed: true,
                    gift_order_update: true,
                    marketplace_order_update: true,
                    security_alerts: true,
                    milesspace_updates: true
                },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            const { data: inserted, error: insertError } = await supabaseAdmin
                .from('user_settings')
                .insert(defaultSettings)
                .select()
                .single();

            if (insertError) {
                console.error('❌ Failed to create user settings:', insertError);
                return { email_2fa_enabled: false };
            }
            return inserted;
        }

        return data;
    } catch (error) {
        console.error('❌ Error getting user settings:', error);
        return { email_2fa_enabled: false };
    }
}

// ═══════════════════════════════════════════════════════════════════
//  REGISTER - With Rate Limiter
// ═══════════════════════════════════════════════════════════════════

router.post('/register', registerLimiter, async (req, res) => {
    try {
        const { email, password, username } = req.body;
        const normalizedEmail = normalizeEmail(email);

        if (!normalizedEmail || !password || !username) {
            return res.status(400).json({
                success: false,
                code: 'MISSING_FIELDS',
                message: 'Email, password, and username are required.'
            });
        }

        const usernameError = validateUsername(username);
        if (usernameError) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_USERNAME',
                message: usernameError
            });
        }

        const pwErrors = validatePassword(password);
        if (pwErrors.length > 0) {
            return res.status(400).json({
                success: false,
                code: 'PASSWORD_WEAK',
                message: `Password must have: ${pwErrors.join(', ')}`
            });
        }

        const { data: existingUser } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('username', username)
            .maybeSingle();

        if (existingUser) {
            return res.status(400).json({
                success: false,
                code: 'USERNAME_TAKEN',
                message: 'Username is already taken. Please choose another.'
            });
        }

        const { data: existingEmail } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('email', normalizedEmail)
            .maybeSingle();

        if (existingEmail) {
            return res.status(400).json({
                success: false,
                code: 'EMAIL_TAKEN',
                message: 'Email is already registered. Please sign in instead.'
            });
        }

        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email: normalizedEmail,
            password: password,
            email_confirm: true,
            user_metadata: { username }
        });

        if (authError) {
            console.error('Auth creation error:', authError);
            return res.status(400).json({
                success: false,
                code: 'REGISTRATION_FAILED',
                message: authError.message || 'Failed to create account. Please try again.'
            });
        }

        const userId = authData.user.id;
        const referralCode = generateReferralCode();

        const { error: profileError } = await supabaseAdmin
            .from('profiles')
            .insert({
                id: userId,
                email: normalizedEmail,
                username: username,
                referral_code: referralCode,
                status: 'active',
                is_verified: true,
                role: 'user',
                wallet_ngn: 0,
                wallet_usd: 0,
                created_at: new Date().toISOString()
            });

        if (profileError) {
            console.error('Profile creation error:', profileError);
            await supabaseAdmin.auth.admin.deleteUser(userId);
            return res.status(500).json({
                success: false,
                code: 'PROFILE_CREATION_FAILED',
                message: 'Failed to create profile. Please try again.'
            });
        }

        // ─── 2FA DISABLED BY DEFAULT ──────────────────────────────
        const { error: settingsError } = await supabaseAdmin
            .from('user_settings')
            .insert({
                user_id: userId,
                email_2fa_enabled: false,
                notification_preferences: {
                    transaction_completed: true,
                    deposit_received: true,
                    withdrawal_completed: true,
                    crypto_purchase_completed: true,
                    gift_order_update: true,
                    marketplace_order_update: true,
                    security_alerts: true,
                    milesspace_updates: true
                },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

        if (settingsError) {
            console.error('Settings creation error:', settingsError);
        }

        await emailService.sendWelcomeEmail(normalizedEmail, username);

        console.log(`✅ User registered: ${normalizedEmail} (2FA disabled by default)`);

        res.status(201).json({
            success: true,
            message: 'Account created successfully! You can now sign in.',
            data: {
                user: {
                    id: userId,
                    email: normalizedEmail,
                    username: username,
                    referral_code: referralCode
                }
            }
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  LOGIN - With Rate Limiter
// ═══════════════════════════════════════════════════════════════════

router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = normalizeEmail(email);
        const ip = getClientIP(req);
        const deviceInfo = getUserAgentInfo(req);

        console.log(`🔐 [LOGIN ATTEMPT] ${normalizedEmail} from IP: ${ip}`);

        if (!normalizedEmail || !password) {
            return res.status(400).json({
                success: false,
                code: 'EMAIL_PASSWORD_REQUIRED',
                message: 'Please enter your email and password.'
            });
        }

        // ─── Account lockout check ──────────────────────────────────
        const lockKey = `login_${normalizedEmail}`;
        if (stores.failedAttempts.has(lockKey)) {
            const lockData = stores.failedAttempts.get(lockKey);
            if (lockData.locked && Date.now() < lockData.lockedUntil) {
                const remaining = Math.ceil((lockData.lockedUntil - Date.now()) / 60000);
                return res.status(403).json({
                    success: false,
                    code: 'ACCOUNT_LOCKED',
                    message: `Too many sign-in attempts. Please wait ${remaining} minute${remaining > 1 ? 's' : ''}.`
                });
            }
            if (lockData.locked && Date.now() >= lockData.lockedUntil) {
                stores.failedAttempts.delete(lockKey);
            }
        }

        // ─── Authenticate with Supabase ──────────────────────────
        let signInData, signInError;
        try {
            const result = await withRetry(
                () => supabase.auth.signInWithPassword({
                    email: normalizedEmail,
                    password
                }),
                2,
                1000
            );
            signInData = result.data;
            signInError = result.error;
        } catch (error) {
            console.error('Supabase auth error:', error);
            return res.status(503).json({
                success: false,
                code: 'SERVICE_UNAVAILABLE',
                message: 'Authentication service is temporarily unavailable.'
            });
        }

        if (signInError) {
            const attempts = stores.failedAttempts.get(lockKey) || { count: 0, locked: false };
            attempts.count += 1;

            if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
                attempts.locked = true;
                attempts.lockedUntil = Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000;
                attempts.count = 0;
                stores.failedAttempts.set(lockKey, attempts);
                console.log(`🔒 Account locked: ${normalizedEmail}`);
                
                return res.status(403).json({
                    success: false,
                    code: 'ACCOUNT_LOCKED',
                    message: `Too many incorrect attempts. Please try again in ${LOGIN_LOCKOUT_MINUTES} minutes.`
                });
            }

            stores.failedAttempts.set(lockKey, attempts);

            return res.status(401).json({
                success: false,
                code: 'INVALID_CREDENTIALS',
                message: 'Incorrect email or password. Please try again.'
            });
        }

        stores.failedAttempts.delete(lockKey);

        const user = signInData.user;

        // ─── Get user profile ────────────────────────────────────
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, status, deleted_at, wallet_ngn, wallet_usd, referral_code, is_verified, transaction_pin_hash, current_session_id, login_count')
            .eq('id', user.id)
            .single();

        if (profileError) {
            console.error('❌ Profile query error:', profileError);
            return res.status(503).json({
                success: false,
                code: 'SERVICE_UNAVAILABLE',
                message: 'Unable to retrieve profile. Please try again.'
            });
        }

        if (!profile) {
            console.error('❌ Profile not found for user:', user.id);
            return res.status(404).json({
                success: false,
                code: 'ACCOUNT_NOT_FOUND',
                message: 'Account not found.'
            });
        }

        if (profile.deleted_at) {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_DELETED',
                message: 'This account has been deleted.'
            });
        }

        if (profile.role === 'admin' || profile.role === 'super_admin') {
            return res.status(403).json({
                success: false,
                code: 'ADMIN_LOGIN_REQUIRED',
                message: 'Please use the admin sign-in page.'
            });
        }

        if (profile.status === 'suspended') {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_SUSPENDED',
                message: 'Your account has been suspended.'
            });
        }

        let location = 'Unknown';
        if (!IS_DEVELOPMENT) {
            try {
                location = await getLocationFromIP(ip);
            } catch (locError) {
                console.warn('⚠️ Location lookup failed:', locError.message);
                location = 'Unknown';
            }
        } else {
            location = 'Development Environment';
        }

        // ─── CHECK email_2fa_enabled ──────────────────────────────
        let email2faEnabled = false;
        try {
            const userSettings = await getUserSettings(profile.id);
            email2faEnabled = userSettings?.email_2fa_enabled || false;
        } catch (settingsError) {
            console.warn('⚠️ Could not get user settings, defaulting 2FA to disabled:', settingsError.message);
            email2faEnabled = false;
        }

        console.log(`🔐 [LOGIN] ${normalizedEmail} - email_2fa_enabled: ${email2faEnabled ? 'YES' : 'NO'}`);

        // ─── IF email_2fa_enabled - Require email OTP ──────────────
        if (email2faEnabled) {
            console.log(`📧 [2FA] email_2fa_enabled is true for ${normalizedEmail}, requiring email OTP`);

            const otp = generateSecureOTP();
            const otpHash = hashValue(otp);
            const challengeId = '2fa_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

            stores.pending2FA.set(challengeId, {
                user_id: profile.id,
                email: profile.email,
                username: profile.username,
                otp_hash: otpHash,
                device_info: deviceInfo,
                ip: ip,
                location: location,
                expires_at: Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000,
                attempts: 0,
                max_attempts: MAX_OTP_ATTEMPTS,
                email_2fa_enabled: true,
                created_at: Date.now()
            });

            const emailResult = await emailService.send2FAEmail(
                profile.email,
                profile.username || 'User',
                otp,
                deviceInfo,
                location,
                ip
            );

            if (!emailResult.success) {
                stores.pending2FA.delete(challengeId);
                console.error(`❌ [2FA] Email failed for ${profile.email}`);
                return res.status(503).json({
                    success: false,
                    code: 'EMAIL_FAILED',
                    message: 'We could not send the verification code. Please try again.'
                });
            }

            console.log(`✅ [2FA] Code sent to ${profile.email}`);

            return res.json({
                success: true,
                requires_2fa: true,
                challenge_id: challengeId,
                message: 'A verification code has been sent to your email.',
                expires_in: OTP_EXPIRY_MINUTES
            });
        }

        // ─── 2FA DISABLED - Complete login ──────────────────────────

        const session = await createSession(profile.id, req, deviceInfo);
        await revokeUserSessions(profile.id, session.sessionId);

        const accessToken = generateAccessToken(profile.id, session.sessionId, profile.role);
        const { refreshToken, expiresAt } = generateRefreshTokenPair(profile.id, session.sessionId);

        await supabaseAdmin
            .from('profiles')
            .update({
                last_login: new Date().toISOString(),
                last_ip: ip,
                last_seen: new Date().toISOString(),
                last_login_browser: deviceInfo.browser || 'Unknown',
                last_login_os: deviceInfo.os || 'Unknown',
                last_login_device: deviceInfo.device || 'Unknown',
                last_login_location: location || 'Unknown',
                last_location: location || 'Unknown',
                login_count: (profile.login_count || 0) + 1,
                updated_at: new Date().toISOString()
            })
            .eq('id', profile.id);

        await logSecurityActivity({
            userId: profile.id,
            eventType: 'login',
            description: 'Successful login',
            ip,
            userAgent: req.headers['user-agent'],
            deviceInfo,
            location,
            metadata: { 
                email_2fa_enabled: false,
                session_id: session.sessionId 
            }
        });

        const hasPin = !!profile.transaction_pin_hash;

        console.log(`✅ [LOGIN SUCCESS] ${normalizedEmail} (2FA disabled)`);

        res.json({
            success: true,
            message: 'Sign in successful! 🎉',
            data: {
                user: {
                    id: profile.id,
                    email: profile.email,
                    username: profile.username,
                    role: profile.role,
                    wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
                    wallet_usd: parseFloat(profile.wallet_usd) || 0,
                    referral_code: profile.referral_code || '',
                    has_transaction_pin: hasPin,
                    is_verified: profile.is_verified || false,
                    email_2fa_enabled: false,
                    last_login: new Date().toISOString()
                },
                access_token: accessToken,
                refresh_token: refreshToken,
                refresh_expires_in: Math.floor(REFRESH_TOKEN_DURATION_MS / 1000),
                expires_in: 3600,
                session_id: session.sessionId
            }
        });

    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'We could not sign you in. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  VERIFY 2FA - With OTP Rate Limiter
// ═══════════════════════════════════════════════════════════════════

router.post('/login/verify-2fa', otpLimiter, async (req, res) => {
    try {
        const { challenge_id, code } = req.body;

        if (!challenge_id || !code) {
            return res.status(400).json({
                success: false,
                code: 'VERIFICATION_REQUIRED',
                message: 'Please enter the verification code.'
            });
        }

        const submittedCode = String(code).trim();
        if (!/^\d{6}$/.test(submittedCode)) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_CODE_FORMAT',
                message: 'Please enter the 6-digit verification code.'
            });
        }

        const data = stores.pending2FA.get(challenge_id);
        if (!data) {
            return res.status(400).json({
                success: false,
                code: 'SESSION_EXPIRED',
                message: 'Verification session expired. Please try logging in again.'
            });
        }

        if (Date.now() > data.expires_at) {
            stores.pending2FA.delete(challenge_id);
            return res.status(400).json({
                success: false,
                code: 'CODE_EXPIRED',
                message: 'Verification code expired. Please try logging in again.'
            });
        }

        data.attempts = (data.attempts || 0) + 1;
        if (data.attempts > data.max_attempts) {
            stores.pending2FA.delete(challenge_id);
            return res.status(400).json({
                success: false,
                code: 'TOO_MANY_ATTEMPTS',
                message: 'Too many incorrect attempts. Please try logging in again.'
            });
        }

        const submittedHash = hashValue(submittedCode);
        if (!safeCompare(submittedHash, data.otp_hash)) {
            const remaining = data.max_attempts - data.attempts;
            return res.status(400).json({
                success: false,
                code: 'INVALID_CODE',
                message: `Incorrect code. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`
            });
        }

        stores.pending2FA.delete(challenge_id);
        console.log(`✅ [2FA VERIFIED] ${data.email}`);

        const session = await createSession(data.user_id, req, data.device_info);
        await revokeUserSessions(data.user_id, session.sessionId);

        const accessToken = generateAccessToken(data.user_id, session.sessionId);
        const { refreshToken, expiresAt } = generateRefreshTokenPair(data.user_id, session.sessionId);

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, status, wallet_ngn, wallet_usd, referral_code, is_verified, transaction_pin_hash, login_count')
            .eq('id', data.user_id)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({
                success: false,
                code: 'USER_NOT_FOUND',
                message: 'User not found.'
            });
        }

        await supabaseAdmin
            .from('profiles')
            .update({
                last_login: new Date().toISOString(),
                last_ip: data.ip,
                last_seen: new Date().toISOString(),
                last_login_browser: data.device_info?.browser || 'Unknown',
                last_login_os: data.device_info?.os || 'Unknown',
                last_login_device: data.device_info?.device || 'Unknown',
                last_login_location: data.location || 'Unknown',
                last_location: data.location || 'Unknown',
                login_count: (profile.login_count || 0) + 1,
                updated_at: new Date().toISOString()
            })
            .eq('id', data.user_id);

        await logSecurityActivity({
            userId: data.user_id,
            eventType: 'login',
            description: 'Successful login (2FA verified)',
            ip: data.ip,
            userAgent: req.headers['user-agent'],
            deviceInfo: data.device_info,
            location: data.location,
            metadata: { email_2fa_enabled: true }
        });

        const hasPin = !!profile.transaction_pin_hash;

        console.log(`✅ [LOGIN SUCCESS] ${profile.email} (via 2FA)`);

        res.json({
            success: true,
            message: 'Device verified successfully! 🎉',
            data: {
                user: {
                    id: profile.id,
                    email: profile.email,
                    username: profile.username,
                    role: profile.role,
                    wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
                    wallet_usd: parseFloat(profile.wallet_usd) || 0,
                    referral_code: profile.referral_code || '',
                    has_transaction_pin: hasPin,
                    is_verified: profile.is_verified || false,
                    email_2fa_enabled: true,
                    last_login: new Date().toISOString()
                },
                access_token: accessToken,
                refresh_token: refreshToken,
                refresh_expires_in: Math.floor(REFRESH_TOKEN_DURATION_MS / 1000),
                expires_in: 3600,
                session_id: session.sessionId,
                verified: true
            }
        });

    } catch (error) {
        console.error('❌ [2FA VERIFY] Error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  RESEND OTP - SILENT RATE LIMITER
// ═══════════════════════════════════════════════════════════════════

router.post('/login/resend-otp', resendOtpLimiter, async (req, res) => {
    try {
        const { challenge_id } = req.body;

        if (!challenge_id) {
            return res.status(400).json({
                success: false,
                code: 'CHALLENGE_ID_REQUIRED',
                message: 'Challenge ID required.'
            });
        }

        const data = stores.pending2FA.get(challenge_id);
        if (!data) {
            return res.status(400).json({
                success: false,
                code: 'SESSION_EXPIRED',
                message: 'Verification session expired. Please try logging in again.'
            });
        }

        const newOtp = generateSecureOTP();
        data.otp_hash = hashValue(newOtp);
        data.expires_at = Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000;
        data.attempts = 0;

        stores.pending2FA.set(challenge_id, data);

        // ─── If rate limited, resendOtpLimiter will intercept and return success ───
        // So this code only runs when NOT rate limited
        const emailResult = await emailService.send2FAEmail(
            data.email,
            data.username || 'User',
            newOtp,
            data.device_info,
            data.location,
            data.ip
        );

        if (!emailResult.success) {
            return res.status(503).json({
                success: false,
                code: 'EMAIL_FAILED',
                message: 'We could not send the verification code. Please try again.'
            });
        }

        console.log(`✅ [2FA EMAIL] Resent to ${data.email}`);

        res.json({
            success: true,
            message: 'A new verification code has been sent to your email.',
            expires_in: OTP_EXPIRY_MINUTES
        });

    } catch (error) {
        console.error('❌ Resend OTP error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  REFRESH TOKEN - With Rate Limiter
// ═══════════════════════════════════════════════════════════════════

router.post('/refresh', refreshLimiter, async (req, res) => {
    try {
        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({
                success: false,
                code: 'REFRESH_TOKEN_REQUIRED',
                message: 'Refresh token required.'
            });
        }

        if (stores.usedRefreshTokens.has(refresh_token)) {
            console.warn(`⚠️ [REFRESH] Reuse detected for token: ${refresh_token.slice(0, 8)}...`);
            
            const tokenData = stores.usedRefreshTokens.get(refresh_token);
            if (tokenData) {
                await revokeUserSessions(tokenData.user_id);
                for (const [token, data] of stores.refreshTokens.entries()) {
                    if (data.user_id === tokenData.user_id) {
                        stores.refreshTokens.delete(token);
                        stores.usedRefreshTokens.set(token, {
                            user_id: data.user_id,
                            session_id: data.session_id,
                            expires_at: Date.now() + 24 * 60 * 60 * 1000
                        });
                    }
                }
            }
            
            return res.status(401).json({
                success: false,
                code: 'REFRESH_TOKEN_REUSE',
                message: 'Security violation detected. Please sign in again.'
            });
        }

        const storedToken = stores.refreshTokens.get(refresh_token);
        if (!storedToken) {
            return res.status(401).json({
                success: false,
                code: 'INVALID_REFRESH_TOKEN',
                message: 'Invalid refresh token. Please sign in again.'
            });
        }

        if (Date.now() > storedToken.expires_at) {
            stores.refreshTokens.delete(refresh_token);
            return res.status(401).json({
                success: false,
                code: 'REFRESH_TOKEN_EXPIRED',
                message: 'Refresh token expired. Please sign in again.'
            });
        }

        stores.usedRefreshTokens.set(refresh_token, {
            user_id: storedToken.user_id,
            session_id: storedToken.session_id,
            expires_at: Date.now() + 24 * 60 * 60 * 1000
        });

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, status, deleted_at, current_session_id')
            .eq('id', storedToken.user_id)
            .single();

        if (profileError || !profile || profile.deleted_at || profile.status === 'suspended') {
            stores.refreshTokens.delete(refresh_token);
            return res.status(401).json({
                success: false,
                code: 'INVALID_USER',
                message: 'User account invalid. Please sign in again.'
            });
        }

        if (!profile.current_session_id) {
            stores.refreshTokens.delete(refresh_token);
            return res.status(401).json({
                success: false,
                code: 'SESSION_INVALID',
                message: 'Session is no longer active. Please sign in again.'
            });
        }

        if (profile.current_session_id !== storedToken.session_id) {
            stores.refreshTokens.delete(refresh_token);
            return res.status(401).json({
                success: false,
                code: 'SESSION_REVOKED',
                message: 'Your session is no longer active. Please sign in again.'
            });
        }

        const newAccessToken = generateAccessToken(profile.id, profile.current_session_id, profile.role);
        stores.refreshTokens.delete(refresh_token);
        const { refreshToken: newRefreshToken, expiresAt } = generateRefreshTokenPair(profile.id, profile.current_session_id);

        await supabaseAdmin
            .from('user_sessions')
            .update({
                last_activity_at: new Date().toISOString()
            })
            .eq('user_id', profile.id)
            .eq('session_id', profile.current_session_id)
            .eq('is_current', true);

        console.log(`🔄 [REFRESH] Token refreshed for ${profile.email}`);

        res.json({
            success: true,
            data: {
                access_token: newAccessToken,
                refresh_token: newRefreshToken,
                refresh_expires_in: Math.floor(REFRESH_TOKEN_DURATION_MS / 1000),
                expires_in: 3600
            }
        });

    } catch (error) {
        console.error('❌ Refresh error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  FORGOT PASSWORD - SILENT RATE LIMITER
// ═══════════════════════════════════════════════════════════════════

router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        const normalizedEmail = normalizeEmail(email);

        if (!normalizedEmail) {
            return res.status(400).json({
                success: false,
                code: 'EMAIL_REQUIRED',
                message: 'Please enter your email address.'
            });
        }

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username')
            .eq('email', normalizedEmail)
            .is('deleted_at', null)
            .maybeSingle();

        if (!profile) {
            console.log(`🔐 [FORGOT] Email not found: ${normalizedEmail}`);
            // Always return success to prevent account enumeration
            return res.json({
                success: true,
                message: 'If an account exists for this email, a reset code has been sent.'
            });
        }

        const resetCode = generateSecureOTP();
        const resetId = 'reset_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

        stores.pending2FA.set(resetId, {
            user_id: profile.id,
            email: profile.email,
            username: profile.username,
            otp_hash: hashValue(resetCode),
            expires_at: Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000,
            attempts: 0,
            max_attempts: MAX_OTP_ATTEMPTS,
            purpose: 'password_reset'
        });

        const emailResult = await emailService.sendPasswordResetOTP(
            profile.email,
            profile.username || 'User',
            resetCode
        );

        if (!emailResult.success) {
            stores.pending2FA.delete(resetId);
            console.error('❌ Password reset email failed:', emailResult.error);
            // Still return success
            return res.json({
                success: true,
                message: 'If an account exists for this email, a reset code has been sent.'
            });
        }

        console.log(`✅ [FORGOT] Reset code sent to ${normalizedEmail}`);

        res.json({
            success: true,
            message: 'If an account exists for this email, a reset code has been sent.',
            reset_id: resetId,
            expires_in: OTP_EXPIRY_MINUTES
        });

    } catch (error) {
        console.error('❌ Forgot password error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  VERIFY RESET CODE - With OTP Rate Limiter
// ═══════════════════════════════════════════════════════════════════

router.post('/verify-reset-code', otpLimiter, async (req, res) => {
    try {
        const { reset_id, code } = req.body;

        if (!reset_id || !code) {
            return res.status(400).json({
                success: false,
                code: 'VERIFICATION_REQUIRED',
                message: 'Please enter the reset code.'
            });
        }

        const submittedCode = String(code).trim();
        if (!/^\d{6}$/.test(submittedCode)) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_CODE_FORMAT',
                message: 'Please enter the 6-digit reset code.'
            });
        }

        const data = stores.pending2FA.get(reset_id);
        if (!data) {
            return res.status(400).json({
                success: false,
                code: 'SESSION_EXPIRED',
                message: 'Your reset session has expired. Please request a new code.'
            });
        }

        if (Date.now() > data.expires_at) {
            stores.pending2FA.delete(reset_id);
            return res.status(400).json({
                success: false,
                code: 'CODE_EXPIRED',
                message: 'This reset code has expired. Please request a new one.'
            });
        }

        data.attempts = (data.attempts || 0) + 1;
        if (data.attempts > data.max_attempts) {
            stores.pending2FA.delete(reset_id);
            return res.status(400).json({
                success: false,
                code: 'TOO_MANY_ATTEMPTS',
                message: 'Too many incorrect attempts. Please request a new code.'
            });
        }

        const submittedHash = hashValue(submittedCode);
        if (!safeCompare(submittedHash, data.otp_hash)) {
            const remaining = data.max_attempts - data.attempts;
            return res.status(400).json({
                success: false,
                code: 'INVALID_CODE',
                message: `Incorrect code. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`
            });
        }

        data.verified = true;
        stores.pending2FA.set(reset_id, data);

        console.log(`✅ [RESET] Code verified for ${data.email}`);

        res.json({
            success: true,
            message: 'Code verified. You can now reset your password.',
            reset_id: reset_id
        });

    } catch (error) {
        console.error('❌ Verify reset code error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  RESET PASSWORD
// ═══════════════════════════════════════════════════════════════════

router.post('/reset-password', async (req, res) => {
    try {
        const { reset_id, new_password } = req.body;

        if (!reset_id || !new_password) {
            return res.status(400).json({
                success: false,
                code: 'RESET_REQUIRED',
                message: 'Please enter your new password.'
            });
        }

        const data = stores.pending2FA.get(reset_id);
        if (!data) {
            return res.status(400).json({
                success: false,
                code: 'SESSION_EXPIRED',
                message: 'Your reset session has expired. Please request a new code.'
            });
        }

        if (!data.verified) {
            return res.status(400).json({
                success: false,
                code: 'CODE_NOT_VERIFIED',
                message: 'Please verify your reset code first.'
            });
        }

        if (Date.now() > data.expires_at) {
            stores.pending2FA.delete(reset_id);
            return res.status(400).json({
                success: false,
                code: 'SESSION_EXPIRED',
                message: 'Your reset session has expired. Please request a new code.'
            });
        }

        const pwErrors = validatePassword(new_password);
        if (pwErrors.length > 0) {
            return res.status(400).json({
                success: false,
                code: 'PASSWORD_WEAK',
                message: `Your password must have: ${pwErrors.join(', ')}`
            });
        }

        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
            data.user_id,
            { password: new_password }
        );

        if (updateError) {
            console.error('❌ Password update error:', updateError);
            return res.status(500).json({
                success: false,
                code: 'PASSWORD_UPDATE_FAILED',
                message: 'We could not update your password. Please try again.'
            });
        }

        await revokeUserSessions(data.user_id);

        await logSecurityActivity({
            userId: data.user_id,
            eventType: 'password_changed',
            description: 'Password reset via forgot password flow',
            metadata: { reset_id }
        });

        stores.pending2FA.delete(reset_id);

        console.log(`✅ [RESET] Password reset successful for ${data.email}`);

        res.json({
            success: true,
            message: 'Password reset successful! You can now sign in with your new password.'
        });

    } catch (error) {
        console.error('❌ Reset password error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  LOGOUT - NO RATE LIMITER
// ═══════════════════════════════════════════════════════════════════

router.post('/logout', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const sessionId = req.user.session_id;
        const refreshToken = req.body.refresh_token;

        if (sessionId) {
            await supabaseAdmin
                .from('user_sessions')
                .update({
                    is_active: false,
                    is_current: false,
                    revoked_at: new Date().toISOString()
                })
                .eq('user_id', userId)
                .eq('session_id', sessionId);

            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('current_session_id')
                .eq('id', userId)
                .single();

            if (profile?.current_session_id === sessionId) {
                await supabaseAdmin
                    .from('profiles')
                    .update({
                        current_session_id: null,
                        session_created_at: null,
                        session_expires_at: null
                    })
                    .eq('id', userId);
            }
        }

        if (refreshToken) {
            stores.refreshTokens.delete(refreshToken);
            stores.usedRefreshTokens.set(refreshToken, {
                user_id: userId,
                session_id: sessionId || 'unknown',
                expires_at: Date.now() + 24 * 60 * 60 * 1000
            });
        }

        const ip = getClientIP(req);
        await logSecurityActivity({
            userId,
            eventType: 'logout',
            description: 'User logged out',
            ip,
            userAgent: req.headers['user-agent'],
            metadata: { session_id: sessionId }
        });

        console.log(`🔐 [LOGOUT] User ${userId} logged out`);

        res.json({
            success: true,
            message: 'You have been signed out successfully.'
        });

    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET SESSION - NO RATE LIMITER
// ═══════════════════════════════════════════════════════════════════

router.get('/session', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const sessionId = req.user.session_id;

        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('current_session_id, session_expires_at, status')
            .eq('id', userId)
            .single();

        if (error || !profile) {
            return res.status(401).json({
                success: false,
                code: 'SESSION_INVALID',
                message: 'Session not found.'
            });
        }

        if (profile.status === 'suspended') {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_SUSPENDED',
                message: 'Your account has been suspended.'
            });
        }

        if (!profile.current_session_id || profile.current_session_id !== sessionId) {
            return res.status(401).json({
                success: false,
                code: 'SESSION_REVOKED',
                message: 'Your session has been ended because your account was signed in on another device.'
            });
        }

        if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
            return res.status(401).json({
                success: false,
                code: 'SESSION_EXPIRED',
                message: 'Your session has expired. Please sign in again.'
            });
        }

        await supabaseAdmin
            .from('user_sessions')
            .update({
                last_activity_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('session_id', sessionId)
            .eq('is_current', true);

        res.json({
            success: true,
            authenticated: true,
            user: {
                id: req.user.id,
                email: req.user.email,
                username: req.user.username,
                role: req.user.role
            },
            session_id: sessionId
        });

    } catch (error) {
        console.error('❌ Session check error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET CURRENT USER - NO RATE LIMITER
// ═══════════════════════════════════════════════════════════════════

router.get('/me', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, status, wallet_ngn, wallet_usd, referral_code, is_verified, transaction_pin_hash, last_login, last_seen, last_login_location, last_ip, last_login_device')
            .eq('id', userId)
            .single();

        if (error || !profile) {
            return res.status(404).json({
                success: false,
                code: 'USER_NOT_FOUND',
                message: 'User not found.'
            });
        }

        const userSettings = await getUserSettings(userId);
        const email2faEnabled = userSettings?.email_2fa_enabled || false;

        const isAdmin = profile.role === 'admin' || profile.role === 'super_admin';
        const lastSeen = profile.last_seen ? new Date(profile.last_seen).getTime() : 0;
        const isOnline = lastSeen > 0 && (Date.now() - lastSeen <= 90 * 1000);

        res.json({
            success: true,
            data: {
                id: profile.id,
                email: profile.email,
                username: profile.username,
                role: profile.role || 'user',
                isAdmin: isAdmin,
                isSuperAdmin: profile.role === 'super_admin',
                wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
                wallet_usd: parseFloat(profile.wallet_usd) || 0,
                referral_code: profile.referral_code || '',
                status: profile.status || 'active',
                has_transaction_pin: !!profile.transaction_pin_hash,
                is_verified: profile.is_verified || false,
                email_2fa_enabled: email2faEnabled,
                dashboard_url: isAdmin ? '/admin/dashboard' : '/dashboard',
                last_login: profile.last_login,
                last_login_location: profile.last_login_location,
                last_login_ip: profile.last_ip,
                last_login_device: profile.last_login_device,
                last_seen: profile.last_seen,
                is_online: isOnline
            }
        });

    } catch (error) {
        console.error('❌ Me error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  HEARTBEAT - NO RATE LIMITER (Infrastructure traffic)
// ═══════════════════════════════════════════════════════════════════

router.post('/heartbeat', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date().toISOString();

        await supabaseAdmin
            .from('profiles')
            .update({ 
                last_seen: now, 
                updated_at: now 
            })
            .eq('id', userId);

        await supabaseAdmin
            .from('user_sessions')
            .update({ 
                last_activity_at: now 
            })
            .eq('user_id', userId)
            .eq('session_id', req.user.session_id)
            .eq('is_current', true);

        res.json({
            success: true,
            last_seen: now,
            message: 'Heartbeat received'
        });

    } catch (error) {
        console.error('❌ Heartbeat error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            message: 'Something went wrong.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  HEALTH CHECK - NO RATE LIMITER
// ═══════════════════════════════════════════════════════════════════

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
                access_token_expires_in: ACCESS_TOKEN_EXPIRES_IN,
                refresh_token_expires_in: REFRESH_TOKEN_EXPIRES_IN
            }
        });
    } catch (error) {
        console.error('Health check error:', error);
        res.status(503).json({
            success: false,
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: 'Database connection failed'
        });
    }
});

module.exports = router;