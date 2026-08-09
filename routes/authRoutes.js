// ─── routes/authRoutes.js ───
// Complete Authentication Routes with Enhanced Security
// NO router splitting - keeps your existing structure

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { supabase, supabaseAdmin } = require('../db/supabase');
const { authMiddleware, optionalAuth } = require('../middleware/auth');
const emailService = require('../services/emailService');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// ─── RATE LIMITING ───
const limiter = (windowMs = 15 * 60 * 1000, max = 5) => rateLimit({
    windowMs,
    max,
    message: {
        success: false,
        error: 'Too many attempts. Please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => process.env.NODE_ENV === 'development' && req.ip === '::1'
});

// ─── HELPERS ───

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateReferralCode() {
    return 'MX' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function validatePassword(password) {
    const errors = [];
    if (password.length < 8) errors.push('at least 8 characters');
    if (!/[A-Z]/.test(password)) errors.push('one uppercase letter');
    if (!/[a-z]/.test(password)) errors.push('one lowercase letter');
    if (!/[0-9]/.test(password)) errors.push('one number');
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) errors.push('one special character');
    return errors;
}

function validateUsername(username) {
    if (!username || username.length < 3) return 'Username must be at least 3 characters';
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return 'Username can only contain letters, numbers, and underscores';
    return null;
}

async function isUsernameTaken(username) {
    if (!username) return false;
    const { data } = await supabaseAdmin
        .from('profiles')
        .select('username')
        .eq('username', username)
        .maybeSingle();
    return !!data;
}

async function isEmailTaken(email) {
    if (!email) return false;
    const { data } = await supabaseAdmin
        .from('profiles')
        .select('email')
        .eq('email', email)
        .maybeSingle();
    return !!data;
}

function getUserAgentInfo(req) {
    const ua = req.headers['user-agent'] || 'Unknown';
    let browser = 'Unknown', os = 'Unknown', device = 'Desktop';
    
    if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
    else if (ua.includes('Firefox')) browser = 'Firefox';
    else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
    else if (ua.includes('Edg')) browser = 'Edge';
    else if (ua.includes('Opera')) browser = 'Opera';
    
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac OS')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
    
    if (ua.includes('Mobile')) device = 'Mobile';
    else if (ua.includes('Tablet')) device = 'Tablet';
    
    return { browser, os, device };
}

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           'Unknown';
}

async function getLocationFromIP(ip) {
    try {
        if (ip === '::1' || ip === '127.0.0.1') return 'Localhost';
        const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city,regionName`);
        const data = await response.json();
        if (data.status === 'success') {
            return `${data.city || ''}, ${data.regionName || ''}, ${data.country || ''}`.replace(/^,\s*|,\s*$/, '') || 'Unknown';
        }
        return 'Unknown';
    } catch {
        return 'Unknown';
    }
}

function logSecurityEvent(event, userId, details = {}) {
    console.log(`🔐 [SECURITY] ${event} | User: ${userId || 'anonymous'} |`, JSON.stringify(details));
    // Optionally store in database for admin audit
}

// ─── STORAGE ───
const pendingRegistrations = {};
const pendingResets = {};
const loginAttempts = new Map();

// ─── REGISTER — Step 1: Send OTP ───
router.post('/register', limiter(15 * 60 * 1000, 5), async (req, res) => {
    try {
        const { email, password, username, phone } = req.body;

        // ─── Validate ───
        if (!email || !password || !username) {
            return res.status(400).json({
                success: false,
                error: 'Email, username, and password are required'
            });
        }

        // ─── Password validation ───
        const pwErrors = validatePassword(password);
        if (pwErrors.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Password must have: ${pwErrors.join(', ')}`
            });
        }

        // ─── Username validation ───
        const unError = validateUsername(username);
        if (unError) {
            return res.status(400).json({
                success: false,
                error: unError
            });
        }

        // ─── Email format validation ───
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                success: false,
                error: 'Please enter a valid email address'
            });
        }

        // ─── Check taken ───
        const usernameTaken = await isUsernameTaken(username);
        if (usernameTaken) {
            return res.status(400).json({
                success: false,
                error: 'Username is already taken'
            });
        }

        const emailTaken = await isEmailTaken(email);
        if (emailTaken) {
            return res.status(400).json({
                success: false,
                error: 'Email already registered. Please login.'
            });
        }

        // ─── Generate OTP ───
        const code = generateOTP();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
        const tempId = 'reg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

        pendingRegistrations[tempId] = {
            email,
            password,
            username,
            phone: phone || null,
            code,
            expiresAt,
            attempts: 0
        };

        // ─── Send email ───
        const emailResult = await emailService.sendVerificationEmail(email, username, code);
        if (!emailResult.success) {
            console.warn('⚠️ Email send failed for registration:', emailResult.error);
            delete pendingRegistrations[tempId];
            return res.status(500).json({
                success: false,
                error: 'Failed to send verification email. Please try again.'
            });
        }

        logSecurityEvent('REGISTRATION_INITIATED', null, { email, username, ip: getClientIP(req) });

        res.json({
            success: true,
            message: 'Verification code sent to your email',
            requires_2fa: true,
            user_id: tempId,
            debug_code: process.env.NODE_ENV === 'development' ? code : undefined
        });

    } catch (error) {
        console.error('❌ Register error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── REGISTER — Step 2: Verify OTP ───
router.post('/verify-registration', limiter(10 * 60 * 1000, 10), async (req, res) => {
    try {
        const { user_id, code } = req.body;

        if (!user_id || !code) {
            return res.status(400).json({
                success: false,
                error: 'User ID and code required'
            });
        }

        const data = pendingRegistrations[user_id];
        if (!data) {
            return res.status(400).json({
                success: false,
                error: 'Session expired. Please register again.'
            });
        }

        // ─── Check attempts ───
        data.attempts = (data.attempts || 0) + 1;
        if (data.attempts > 5) {
            delete pendingRegistrations[user_id];
            return res.status(400).json({
                success: false,
                error: 'Too many failed attempts. Please register again.'
            });
        }

        // ─── Check expiry ───
        if (new Date(data.expiresAt) < new Date()) {
            delete pendingRegistrations[user_id];
            return res.status(400).json({
                success: false,
                error: 'Code expired. Please register again.'
            });
        }

        // ─── Verify code ───
        if (data.code !== code) {
            return res.status(400).json({
                success: false,
                error: `Invalid code. ${5 - data.attempts} attempts remaining.`
            });
        }

        // ─── Final checks ───
        const { email, password, username, phone } = data;

        const usernameTaken = await isUsernameTaken(username);
        if (usernameTaken) {
            delete pendingRegistrations[user_id];
            return res.status(400).json({
                success: false,
                error: 'Username was taken. Please register again.'
            });
        }

        const emailTaken = await isEmailTaken(email);
        if (emailTaken) {
            delete pendingRegistrations[user_id];
            return res.status(400).json({
                success: false,
                error: 'Email was registered. Please login.'
            });
        }

        // ─── Create user ───
        const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { username },
        });

        if (authError) {
            console.error('❌ Auth create error:', authError.message);
            return res.status(400).json({
                success: false,
                error: 'Could not create account. Try again.'
            });
        }

        const userId = authUser.user.id;
        const refCode = generateReferralCode();

        const { error: profileError } = await supabaseAdmin.from('profiles').insert({
            id: userId,
            email,
            username,
            phone: phone || null,
            wallet_ngn: 0,
            wallet_usd: 0,
            role: 'user',
            status: 'active',
            referral_code: refCode,
            created_at: new Date().toISOString(),
            transaction_pin_hash: null,
            transaction_pin_set_at: null
        });

        if (profileError) {
            console.error('❌ Profile create error:', profileError);
            try { await supabaseAdmin.auth.admin.deleteUser(userId); } catch (e) {}
            return res.status(500).json({
                success: false,
                error: 'Failed to create profile. Please try again.'
            });
        }

        delete pendingRegistrations[user_id];
        logSecurityEvent('REGISTRATION_COMPLETED', userId, { email, username, ip: getClientIP(req) });

        // ─── Send welcome email ───
        await emailService.sendWelcomeEmail(email, username).catch(() => {});

        // ─── Auto-login ───
        const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (signInError) {
            return res.status(201).json({
                success: true,
                message: 'Account created! Please login.',
                data: { user: { id: userId, email, username, role: 'user' } }
            });
        }

        res.status(201).json({
            success: true,
            message: 'Account created and logged in!',
            data: {
                user: {
                    id: userId,
                    email,
                    username,
                    role: 'user',
                    wallet_ngn: 0,
                    wallet_usd: 0,
                    referral_code: refCode,
                    has_transaction_pin: false
                },
                token: signInData.session.access_token,
                refresh_token: signInData.session.refresh_token
            },
        });

    } catch (error) {
        console.error('❌ Verify register error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── FORGOT PASSWORD — Send OTP ───
router.post('/forgot-password', limiter(15 * 60 * 1000, 3), async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                error: 'Email required'
            });
        }

        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username')
            .eq('email', email)
            .single();

        if (error || !profile) {
            // Don't reveal if email exists
            return res.json({
                success: true,
                message: 'If an account exists, a reset code will be sent.'
            });
        }

        const code = generateOTP();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
        const resetId = 'reset_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

        pendingResets[resetId] = {
            user_id: profile.id,
            email,
            code,
            expiresAt,
            attempts: 0
        };

        // ─── Send email ───
        const emailResult = await emailService.sendPasswordResetOTP(email, profile.username || 'User', code);
        if (!emailResult.success) {
            console.warn('⚠️ Password reset email failed:', emailResult.error);
            delete pendingResets[resetId];
            return res.json({
                success: true,
                message: 'If an account exists, a reset code will be sent.'
            });
        }

        logSecurityEvent('PASSWORD_RESET_REQUESTED', profile.id, { email, ip: getClientIP(req) });

        res.json({
            success: true,
            message: 'Password reset code sent to your email',
            reset_id: resetId,
            debug_code: process.env.NODE_ENV === 'development' ? code : undefined
        });

    } catch (error) {
        console.error('❌ Forgot password error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── VERIFY RESET CODE ───
router.post('/verify-reset-code', limiter(10 * 60 * 1000, 5), async (req, res) => {
    try {
        const { reset_id, code } = req.body;

        if (!reset_id || !code) {
            return res.status(400).json({
                success: false,
                error: 'Reset ID and code required'
            });
        }

        const data = pendingResets[reset_id];
        if (!data) {
            return res.status(400).json({
                success: false,
                error: 'Reset session expired. Please request a new code.'
            });
        }

        data.attempts = (data.attempts || 0) + 1;
        if (data.attempts > 5) {
            delete pendingResets[reset_id];
            return res.status(400).json({
                success: false,
                error: 'Too many failed attempts. Please request a new code.'
            });
        }

        if (new Date(data.expiresAt) < new Date()) {
            delete pendingResets[reset_id];
            return res.status(400).json({
                success: false,
                error: 'Code expired. Please request a new code.'
            });
        }

        if (data.code !== code) {
            return res.status(400).json({
                success: false,
                error: `Invalid code. ${5 - data.attempts} attempts remaining.`
            });
        }

        res.json({
            success: true,
            message: 'Code verified successfully'
        });

    } catch (error) {
        console.error('❌ Verify reset code error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── RESET PASSWORD ───
router.post('/reset-password', limiter(10 * 60 * 1000, 3), async (req, res) => {
    try {
        const { email, code, new_password } = req.body;

        if (!email || !code || !new_password) {
            return res.status(400).json({
                success: false,
                error: 'Email, code, and new password required'
            });
        }

        // ─── Validate new password ───
        const pwErrors = validatePassword(new_password);
        if (pwErrors.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Password must have: ${pwErrors.join(', ')}`
            });
        }

        // ─── Find valid reset ───
        let valid = false;
        let userId = null;
        for (const [key, data] of Object.entries(pendingResets)) {
            if (data.email === email && data.code === code && new Date(data.expiresAt) > new Date()) {
                valid = true;
                userId = data.user_id;
                delete pendingResets[key];
                break;
            }
        }

        if (!valid) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired reset code'
            });
        }

        // ─── Update password ───
        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserByEmail(
            email,
            { password: new_password }
        );

        if (updateError) {
            console.error('❌ Password update error:', updateError);
            return res.status(500).json({
                success: false,
                error: 'Failed to reset password. Please try again.'
            });
        }

        logSecurityEvent('PASSWORD_RESET_SUCCESS', userId, { email, ip: getClientIP(req) });

        res.json({
            success: true,
            message: 'Password reset successfully'
        });

    } catch (error) {
        console.error('❌ Reset password error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── USER LOGIN ───
router.post('/login', limiter(15 * 60 * 1000, 10), async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Email and password required'
            });
        }

        // ─── Track login attempts ───
        const ip = getClientIP(req);
        const key = `login_${ip}`;
        if (!loginAttempts.has(key)) {
            loginAttempts.set(key, { count: 0, first: Date.now() });
        }
        const attempt = loginAttempts.get(key);

        // Reset if more than 15 minutes old
        if (Date.now() - attempt.first > 15 * 60 * 1000) {
            loginAttempts.set(key, { count: 0, first: Date.now() });
        }

        if (attempt.count >= 10) {
            return res.status(429).json({
                success: false,
                error: 'Too many login attempts. Please try again later.'
            });
        }

        // ─── Attempt login ───
        const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (signInError) {
            attempt.count += 1;
            loginAttempts.set(key, attempt);
            logSecurityEvent('LOGIN_FAILED', null, { email, ip, reason: signInError.message });
            return res.status(401).json({
                success: false,
                error: 'Invalid email or password'
            });
        }

        // ─── Reset attempts on success ───
        loginAttempts.delete(key);

        const user = signInData.user;

        // ─── Get profile ───
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({
                success: false,
                error: 'Account not found'
            });
        }

        if (profile.role === 'admin' || profile.role === 'super_admin') {
            return res.status(403).json({
                success: false,
                error: 'This is a user login page. Admins must use the admin login.'
            });
        }

        if (profile.status === 'suspended') {
            return res.status(403).json({
                success: false,
                error: 'Account suspended. Please contact support.'
            });
        }

        // ─── Get device info ───
        const uaInfo = getUserAgentInfo(req);
        const location = await getLocationFromIP(ip);

        // ─── Update last login ───
        await supabaseAdmin
            .from('profiles')
            .update({
                last_login_at: new Date().toISOString(),
                last_login_ip: ip,
                last_login_browser: uaInfo.browser,
                last_login_os: uaInfo.os,
                last_login_device: uaInfo.device,
                last_login_location: location
            })
            .eq('id', profile.id);

        logSecurityEvent('LOGIN_SUCCESS', profile.id, {
            email,
            ip,
            browser: uaInfo.browser,
            os: uaInfo.os,
            device: uaInfo.device,
            location
        });

        // ─── Send login alert if new location ───
        // Check if this is a new device/location
        const previousLocation = profile.last_login_location || '';
        const isNewLocation = previousLocation !== location && location !== 'Unknown';

        if (isNewLocation) {
            await emailService.sendLoginAlert(
                email,
                profile.username || 'User',
                location,
                `${uaInfo.browser} on ${uaInfo.os} (${uaInfo.device})`,
                new Date().toLocaleString()
            ).catch(() => {});
        }

        // ─── Check if user has transaction PIN ───
        const hasPin = !!profile.transaction_pin_hash;

        res.json({
            success: true,
            data: {
                user: {
                    id: profile.id,
                    email: profile.email,
                    username: profile.username,
                    role: profile.role,
                    wallet_ngn: parseFloat(profile.wallet_ngn || 0),
                    wallet_usd: parseFloat(profile.wallet_usd || 0),
                    referral_code: profile.referral_code || '',
                    has_transaction_pin: hasPin
                },
                token: signInData.session.access_token,
                refresh_token: signInData.session.refresh_token
            },
        });

    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET CURRENT USER ───
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', req.user.id)
            .single();

        if (!profile) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // ─── Only return safe fields ───
        res.json({
            success: true,
            data: {
                id: profile.id,
                email: profile.email,
                username: profile.username,
                role: profile.role || 'user',
                wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
                wallet_usd: parseFloat(profile.wallet_usd) || 0,
                referral_code: profile.referral_code || '',
                status: profile.status || 'active',
                has_transaction_pin: !!profile.transaction_pin_hash,
                last_login_at: profile.last_login_at,
                last_login_location: profile.last_login_location,
                last_login_device: profile.last_login_device,
                // NEVER expose: password hash, PIN hash, internal IDs
            },
        });

    } catch (error) {
        console.error('Me error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── CREATE TRANSACTION PIN ───
router.post('/create-pin', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { pin } = req.body;

        if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
            return res.status(400).json({
                success: false,
                error: 'PIN must be exactly 4 digits'
            });
        }

        // ─── Check if PIN already exists ───
        const { data: existing } = await supabaseAdmin
            .from('profiles')
            .select('transaction_pin_hash')
            .eq('id', userId)
            .single();

        if (existing?.transaction_pin_hash) {
            return res.status(400).json({
                success: false,
                error: 'PIN already set. Use change-pin endpoint.'
            });
        }

        // ─── Hash PIN ───
        const salt = await bcrypt.genSalt(10);
        const pinHash = await bcrypt.hash(pin, salt);

        // ─── Save PIN ───
        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_hash: pinHash,
                transaction_pin_set_at: new Date().toISOString(),
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        if (updateError) {
            console.error('PIN create error:', updateError);
            return res.status(500).json({
                success: false,
                error: 'Failed to save PIN'
            });
        }

        logSecurityEvent('PIN_CREATED', userId, { ip: getClientIP(req) });

        // ─── Return only boolean ───
        res.json({
            success: true,
            message: 'PIN created successfully',
            data: {
                has_transaction_pin: true
            }
        });

    } catch (error) {
        console.error('Create PIN error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── CHANGE TRANSACTION PIN ───
router.post('/change-pin', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { current_pin, new_pin } = req.body;

        if (!current_pin || !new_pin || new_pin.length !== 4 || !/^\d{4}$/.test(new_pin)) {
            return res.status(400).json({
                success: false,
                error: 'Current PIN and new 4-digit PIN required'
            });
        }

        // ─── Get current hash ───
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('transaction_pin_hash')
            .eq('id', userId)
            .single();

        if (!profile?.transaction_pin_hash) {
            return res.status(400).json({
                success: false,
                error: 'No PIN set. Use create-pin endpoint.'
            });
        }

        // ─── Verify current PIN ───
        const isValid = await bcrypt.compare(current_pin, profile.transaction_pin_hash);
        if (!isValid) {
            logSecurityEvent('PIN_CHANGE_FAILED', userId, { ip: getClientIP(req) });
            return res.status(401).json({
                success: false,
                error: 'Current PIN is incorrect'
            });
        }

        // ─── Hash new PIN ───
        const salt = await bcrypt.genSalt(10);
        const newPinHash = await bcrypt.hash(new_pin, salt);

        // ─── Update PIN ───
        await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_hash: newPinHash,
                transaction_pin_set_at: new Date().toISOString(),
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        logSecurityEvent('PIN_CHANGED', userId, { ip: getClientIP(req) });

        res.json({
            success: true,
            message: 'PIN changed successfully',
            data: { has_transaction_pin: true }
        });

    } catch (error) {
        console.error('Change PIN error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── VERIFY TRANSACTION PIN ───
router.post('/verify-pin', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { pin } = req.body;

        if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
            return res.status(400).json({
                success: false,
                error: 'PIN must be exactly 4 digits'
            });
        }

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('transaction_pin_hash, transaction_pin_attempts, transaction_pin_locked_until')
            .eq('id', userId)
            .single();

        if (!profile?.transaction_pin_hash) {
            return res.status(400).json({
                success: false,
                error: 'PIN not set. Please create a PIN first.',
                code: 'PIN_NOT_SET'
            });
        }

        // ─── Check lock ───
        if (profile.transaction_pin_locked_until && new Date(profile.transaction_pin_locked_until) > new Date()) {
            const remaining = Math.ceil((new Date(profile.transaction_pin_locked_until) - new Date()) / 60000);
            return res.status(403).json({
                success: false,
                error: `PIN locked for ${remaining} minutes`,
                code: 'PIN_LOCKED',
                remaining_minutes: remaining
            });
        }

        // ─── Verify ───
        const isValid = await bcrypt.compare(pin, profile.transaction_pin_hash);

        if (!isValid) {
            const attempts = (profile.transaction_pin_attempts || 0) + 1;
            const updates = { transaction_pin_attempts: attempts };

            if (attempts >= 5) {
                updates.transaction_pin_locked_until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                updates.transaction_pin_attempts = 0;
                await supabaseAdmin.from('profiles').update(updates).eq('id', userId);
                logSecurityEvent('PIN_LOCKED', userId, { ip: getClientIP(req) });
                return res.status(403).json({
                    success: false,
                    error: 'Too many attempts. PIN locked for 1 hour.',
                    code: 'PIN_LOCKED',
                    remaining_minutes: 60
                });
            }

            await supabaseAdmin.from('profiles').update(updates).eq('id', userId);
            return res.status(400).json({
                success: false,
                error: `Invalid PIN. ${5 - attempts} attempts remaining.`,
                code: 'INVALID_PIN',
                attempts_remaining: 5 - attempts
            });
        }

        // ─── Reset attempts ───
        await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null
            })
            .eq('id', userId);

        res.json({
            success: true,
            message: 'PIN verified',
            data: { verified: true }
        });

    } catch (error) {
        console.error('Verify PIN error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── LOGOUT ───
router.post('/logout', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        await supabase.auth.signOut();
        logSecurityEvent('LOGOUT', userId, { ip: getClientIP(req) });
        res.json({ success: true, message: 'Logged out' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── HEALTH CHECK ───
router.get('/health', async (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

module.exports = router;