// routes/userSettingsRoutes.js
// ─────────────────────────────────────────────────────────────────
// Customer account settings + permanent account deletion.
//
// ENDPOINTS (all under /api/user, mount in server.js):
//   GET    /settings
//   PUT    /notifications
//   PUT    /phone
//   PUT    /password
//   PUT    /pin
//   POST   /pin/forgot/request|verify|reset
//   POST   /email/change-request|change-verify
//   POST   /2fa/email/setup|verify|resend
//   POST   /2fa/email/disable/request|verify
//   DELETE /sessions/:sessionId
//   POST   /sessions/logout-others
//   GET    /activity
//   GET    /security-alerts
//   POST   /security-alerts/:id/read
//   POST   /deactivate
//
//   POST   /delete/request        (NEW — starts permanent deletion)
//   POST   /delete/verify         (NEW — verifies OTP)
//   POST   /delete/confirm        (NEW — atomically finalises deletion)
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const router  = express.Router();

const { supabaseAdmin }      = require('../db/supabase');
const { authMiddleware }     = require('../middleware/auth');
const { createNotification } = require('../services/notificationService');
const emailService           = require('../services/emailService');

// ═══ CONSTANTS ═══
const ALLOWED_NOTIF_KEYS = Object.freeze([
    'transaction_completed',
    'deposit_received',
    'gift_order_update',
    'marketplace_order_update',
    'milesspace_updates',
    'security_alerts'
]);
const REQUIRED_NOTIF_KEYS = Object.freeze(['security_alerts']);

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

const WEAK_PINS = new Set([
    '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
    '1234','4321','1212','2121','1122','2211','0123','1230','1010','9090'
]);

const OTP_EXPIRY_MINUTES = 10;
const MAX_OTP_ATTEMPTS   = 5;

const PROFILE_COLUMNS = [
    'id', 'email', 'username', 'phone', 'referral_code',
    'status', 'is_verified', 'created_at', 'last_login',
    'last_login_location', 'last_login_browser', 'last_login_os', 'last_login_device',
    'transaction_pin_hash',
    'transaction_pin_attempts',
    'transaction_pin_locked_until',
    'two_factor_enabled'
].join(', ');

const SESSION_COLUMNS = [
    'session_id', 'browser', 'os', 'ip_address',
    'created_at', 'last_activity_at', 'is_active'
].join(', ');

const ACTIVITY_COLUMNS = [
    'id', 'activity_type', 'description', 'location', 'created_at'
].join(', ');

const ALERT_COLUMNS = [
    'id', 'alert_type', 'severity', 'description', 'is_read', 'created_at'
].join(', ');

// ═══ HELPERS ═══
function nowIso() { return new Date().toISOString(); }

function isValidPin(pin) {
    return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

function safeUserResponse(profile) {
    if (!profile) return null;
    const {
        transaction_pin_hash,
        transaction_pin_attempts,
        transaction_pin_locked_until,
        ...rest
    } = profile;
    return {
        id: rest.id,
        email: rest.email,
        username: rest.username,
        phone: rest.phone,
        referral_code: rest.referral_code,
        status: rest.status,
        is_verified: rest.is_verified,
        created_at: rest.created_at,
        last_login: rest.last_login,
        last_login_location: rest.last_login_location,
        last_login_browser: rest.last_login_browser,
        last_login_os: rest.last_login_os,
        last_login_device: rest.last_login_device,
        has_transaction_pin: !!transaction_pin_hash,
        two_factor_enabled: !!rest.two_factor_enabled
    };
}

function maskEmail(email) {
    if (!email) return 'your email';
    const [local, domain] = String(email).split('@');
    if (!domain) return email;
    if (local.length <= 2) return `**@${domain}`;
    return `${local.slice(0, 2)}***@${domain}`;
}

// ═══ OTP hashing ═══
const OTP_SECRET = process.env.OTP_SECRET;
if (!OTP_SECRET && process.env.NODE_ENV === 'production') {
    console.error('❌ CRITICAL: OTP_SECRET is required in production.');
    process.exit(1);
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

function generateSecureOtp()   { return crypto.randomInt(100000, 1000000).toString(); }
function generateChallengeId() { return crypto.randomBytes(16).toString('hex'); }

// ═══ OTP table operations ═══
async function saveOtpChallenge({ challengeId, userId, email, purpose, otp, ip, userAgent }) {
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    try {
        await supabaseAdmin
            .from('otp_challenges')
            .update({ consumed: true, consumed_at: nowIso() })
            .eq('user_id', userId)
            .eq('purpose', purpose)
            .eq('consumed', false);
    } catch (e) {
        console.warn('[OTP] supersede failed (non-fatal):', e.message);
    }

    const { error } = await supabaseAdmin
        .from('otp_challenges')
        .insert({
            challenge_id: challengeId,
            user_id:      userId,
            email:        email,
            purpose:      purpose,
            otp_hash:     hashOtp(otp),
            max_attempts: MAX_OTP_ATTEMPTS,
            expires_at:   expiresAt.toISOString(),
            metadata:     { ip: ip || null, user_agent: userAgent || null }
        });

    if (error) {
        console.error('[OTP] saveOtpChallenge failed', {
            code: error.code, message: error.message,
            details: error.details, hint: error.hint, purpose, email
        });
        throw error;
    }
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

// Atomic via RPC when available; safe fallback otherwise.
async function incrementOtpAttempts(challengeId) {
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
        if (error && !/function|does not exist|schema cache/i.test(String(error.message))) {
            throw error;
        }
    } catch (rpcErr) {
        if (!/function|does not exist|schema cache/i.test(String(rpcErr.message))) {
            console.warn('[OTP] RPC increment failed, using fallback:', rpcErr.message);
        }
    }

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
    await supabaseAdmin
        .from('otp_challenges')
        .update({
            consumed:    true,
            verified:    markVerified,
            consumed_at: nowIso()
        })
        .eq('challenge_id', challengeId);
}

async function logActivity(userId, activityType, description) {
    try {
        await supabaseAdmin.from('account_activity').insert({
            user_id: userId,
            activity_type: activityType,
            description,
            created_at: nowIso()
        });
    } catch (e) {
        console.warn('[SETTINGS] activity log failed (non-fatal):', e.message);
    }
}

// ═══════════════════════════════════════════════════════════════════
// GET /api/user/settings
// ═══════════════════════════════════════════════════════════════════
router.get('/settings', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const sections = {};

    let profile = null;
    try {
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select(PROFILE_COLUMNS)
            .eq('id', userId)
            .single();
        if (error) throw error;
        profile = data;
        sections.profile = 'ok';
    } catch (e) {
        console.error('[SETTINGS] profile load failed:', e.message);
        sections.profile = 'failed';
    }

    let settings;
    try {
        const { data, error } = await supabaseAdmin
            .from('user_settings')
            .select('notification_preferences, email_2fa_enabled, theme_preference')
            .eq('user_id', userId)
            .maybeSingle();
        if (error) throw error;
        settings = {
            notification_preferences: (data && data.notification_preferences) || {},
            email_2fa_enabled: !!(data && data.email_2fa_enabled),
            theme_preference: (data && data.theme_preference) || 'light'
        };
        sections.settings = 'ok';
    } catch (e) {
        console.error('[SETTINGS] settings load failed:', e.message);
        sections.settings = 'failed';
        settings = { notification_preferences: {}, email_2fa_enabled: false, theme_preference: 'light' };
    }

    let sessions = [];
    const currentSessionId = req.sessionId || null;
    try {
        const { data, error } = await supabaseAdmin
            .from('user_sessions')
            .select(SESSION_COLUMNS)
            .eq('user_id', userId)
            .eq('is_active', true)
            .order('last_activity_at', { ascending: false })
            .limit(20);
        if (error) throw error;
        sessions = data || [];
        sections.sessions = 'ok';
    } catch (e) {
        console.error('[SETTINGS] sessions load failed:', e.message);
        sections.sessions = 'failed';
    }

    return res.json({
        success: true,
        data: {
            profile: safeUserResponse(profile),
            settings,
            sessions,
            current_session_id: currentSessionId
        },
        sections
    });
});

// ═══════════════════════════════════════════════════════════════════
// PUT /api/user/notifications
// ═══════════════════════════════════════════════════════════════════
router.put('/notifications', authMiddleware, async (req, res) => {
    try {
        const incoming = req.body && req.body.notification_preferences;
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
            return res.status(400).json({ success: false, code: 'INVALID_BODY', error: 'notification_preferences must be an object' });
        }

        const cleaned = {};
        for (const [k, v] of Object.entries(incoming)) {
            if (!ALLOWED_NOTIF_KEYS.includes(k)) {
                return res.status(400).json({ success: false, code: 'UNKNOWN_PREFERENCE', error: `Unknown notification preference: ${k}` });
            }
            if (typeof v !== 'boolean') {
                return res.status(400).json({ success: false, code: 'INVALID_PREFERENCE_VALUE', error: `Preference ${k} must be a boolean` });
            }
            cleaned[k] = v;
        }
        for (const key of REQUIRED_NOTIF_KEYS) cleaned[key] = true;

        const { data: existing } = await supabaseAdmin
            .from('user_settings')
            .select('notification_preferences')
            .eq('user_id', req.user.id)
            .maybeSingle();

        const merged = {
            ...((existing && existing.notification_preferences) || {}),
            ...cleaned
        };

        const { error } = await supabaseAdmin
            .from('user_settings')
            .upsert({
                user_id: req.user.id,
                notification_preferences: merged,
                updated_at: nowIso()
            }, { onConflict: 'user_id' });

        if (error) throw error;
        return res.json({ success: true, data: { notification_preferences: merged } });
    } catch (e) {
        console.error('[SETTINGS] notifications update failed:', e.message);
        return res.status(500).json({ success: false, code: 'NOTIFICATIONS_UPDATE_FAILED', error: 'Could not update preferences' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// PUT /api/user/phone
// ═══════════════════════════════════════════════════════════════════
router.put('/phone', authMiddleware, async (req, res) => {
    try {
        const phone = String((req.body && req.body.phone) || '').trim();
        if (!/^\+?\d{7,15}$/.test(phone)) {
            return res.status(400).json({ success: false, code: 'INVALID_PHONE', error: 'Invalid phone number' });
        }

        const { error } = await supabaseAdmin
            .from('profiles')
            .update({ phone, updated_at: nowIso() })
            .eq('id', req.user.id);
        if (error) throw error;

        await logActivity(req.user.id, 'phone_changed', 'Phone number updated');
        return res.json({ success: true });
    } catch (e) {
        console.error('[SETTINGS] phone update failed:', e.message);
        return res.status(500).json({ success: false, code: 'PHONE_UPDATE_FAILED', error: 'Could not update phone' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// PUT /api/user/password
// ═══════════════════════════════════════════════════════════════════
router.put('/password', authMiddleware, async (req, res) => {
    try {
        const { current_password, new_password } = req.body || {};
        if (!current_password || !new_password) {
            return res.status(400).json({ success: false, code: 'MISSING_FIELDS', error: 'Current and new password are required' });
        }
        if (String(new_password).length < 8) {
            return res.status(400).json({ success: false, code: 'WEAK_PASSWORD', error: 'New password must be at least 8 characters' });
        }

        const { data: authResult, error: authErr } = await supabaseAdmin.auth.signInWithPassword({
            email: req.user.email,
            password: String(current_password)
        });
        if (authErr || !authResult || !authResult.user) {
            return res.status(400).json({ success: false, code: 'INCORRECT_PASSWORD', error: 'Current password is incorrect' });
        }

        const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
            password: String(new_password)
        });
        if (updErr) throw updErr;

        await supabaseAdmin
            .from('user_sessions')
            .update({ is_active: false, revoked_at: nowIso(), revoke_reason: 'password_change' })
            .eq('user_id', req.user.id)
            .neq('session_id', req.sessionId);

        await logActivity(req.user.id, 'password_changed', 'Password changed; other sessions signed out');
        return res.json({ success: true });
    } catch (e) {
        console.error('[SETTINGS] password change failed:', e.message);
        return res.status(500).json({ success: false, code: 'PASSWORD_CHANGE_FAILED', error: 'Could not change password' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// PUT /api/user/pin  — change or set for the first time
// ═══════════════════════════════════════════════════════════════════
router.put('/pin', authMiddleware, async (req, res) => {
    try {
        const { current_pin, new_pin } = req.body || {};
        const newPinStr = String(new_pin == null ? '' : new_pin);

        if (!isValidPin(newPinStr)) {
            return res.status(400).json({ success: false, code: 'INVALID_PIN_FORMAT', error: 'New PIN must be exactly 4 digits.' });
        }
        if (WEAK_PINS.has(newPinStr)) {
            return res.status(400).json({ success: false, code: 'WEAK_PIN', error: 'That PIN is too easy to guess. Choose a different one.' });
        }

        const { data: profile, error: readErr } = await supabaseAdmin
            .from('profiles')
            .select('transaction_pin_hash, transaction_pin_attempts, transaction_pin_locked_until')
            .eq('id', req.user.id)
            .maybeSingle();

        if (readErr) {
            console.error('[SETTINGS] pin profile read failed:', readErr.message);
            return res.status(500).json({ success: false, code: 'PIN_UPDATE_FAILED', error: 'Could not read PIN state. Please try again.' });
        }
        if (!profile) {
            return res.status(404).json({ success: false, code: 'PROFILE_NOT_FOUND', error: 'Profile not found.' });
        }

        const hasPin = !!profile.transaction_pin_hash;

        if (hasPin) {
            const lockedUntilMs = profile.transaction_pin_locked_until
                ? Date.parse(profile.transaction_pin_locked_until)
                : 0;

            if (lockedUntilMs && lockedUntilMs > Date.now()) {
                const mins = Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 60000));
                return res.status(429).json({
                    success: false, code: 'PIN_LOCKED',
                    error: `Too many incorrect attempts. Try again in ${mins} minute(s).`,
                    lock_minutes: mins,
                    locked_until: profile.transaction_pin_locked_until
                });
            }

            if (!isValidPin(String(current_pin == null ? '' : current_pin))) {
                return res.status(400).json({ success: false, code: 'CURRENT_PIN_REQUIRED', error: 'Current PIN is required.' });
            }

            const ok = await bcrypt.compare(String(current_pin), profile.transaction_pin_hash);

            if (!ok) {
                const priorAttempts = Number(profile.transaction_pin_attempts) || 0;
                const nextAttempts = priorAttempts + 1;
                const willLock = nextAttempts >= PIN_MAX_ATTEMPTS;

                const lockUntilIso = willLock
                    ? new Date(Date.now() + PIN_LOCK_MINUTES * 60 * 1000).toISOString()
                    : null;

                await supabaseAdmin
                    .from('profiles')
                    .update({
                        transaction_pin_attempts: willLock ? 0 : nextAttempts,
                        transaction_pin_locked_until: lockUntilIso,
                        updated_at: nowIso()
                    })
                    .eq('id', req.user.id);

                if (willLock) {
                    return res.status(429).json({
                        success: false, code: 'PIN_LOCKED',
                        error: `Too many incorrect attempts. Try again in ${PIN_LOCK_MINUTES} minute(s).`,
                        lock_minutes: PIN_LOCK_MINUTES,
                        locked_until: lockUntilIso
                    });
                }

                const remaining = PIN_MAX_ATTEMPTS - nextAttempts;
                return res.status(400).json({
                    success: false, code: 'INCORRECT_PIN',
                    error: remaining === 1
                        ? 'Current PIN is incorrect. 1 attempt remaining before lockout.'
                        : `Current PIN is incorrect. ${remaining} attempts remaining.`,
                    attempts_remaining: remaining
                });
            }
        }

        const hash = await bcrypt.hash(newPinStr, 12);

        const { error: updErr } = await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_hash: hash,
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null,
                updated_at: nowIso()
            })
            .eq('id', req.user.id);

        if (updErr) {
            console.error('[SETTINGS] pin write failed:', updErr.message);
            return res.status(500).json({ success: false, code: 'PIN_UPDATE_FAILED', error: 'Could not save PIN. Please try again.' });
        }

        // ─── H-2: changing the PIN signs out every other device ────
        await supabaseAdmin
            .from('user_sessions')
            .update({
                is_active:  false,
                is_current: false,
                revoked_at: nowIso(),
                revoke_reason: 'pin_change'
            })
            .eq('user_id', req.user.id)
            .neq('session_id', req.sessionId);

        await logActivity(
            req.user.id,
            'transaction_pin_changed',
            hasPin
                ? 'Transaction PIN changed; other sessions signed out'
                : 'Transaction PIN set'
        );

        return res.json({
            success: true,
            data: { has_transaction_pin: true, changed: hasPin }
        });
    } catch (e) {
        console.error('[SETTINGS] pin update threw:', e.message);
        return res.status(500).json({ success: false, code: 'PIN_UPDATE_FAILED', error: 'Could not update PIN. Please try again.' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// FORGOT PIN (3 endpoints)
// ═══════════════════════════════════════════════════════════════════
router.post('/pin/forgot/request', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: profile, error: profileErr } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username')
            .eq('id', userId)
            .maybeSingle();

        if (profileErr || !profile) {
            return res.status(404).json({ success: false, code: 'PROFILE_NOT_FOUND', error: 'Profile not found.' });
        }

        const challengeId = generateChallengeId();
        const otp = generateSecureOtp();

        await saveOtpChallenge({
            challengeId, userId,
            email: profile.email,
            purpose: 'pin_reset',
            otp,
            ip: req.ip,
            userAgent: String(req.headers['user-agent'] || '').slice(0, 400)
        });

        const emailResult = await emailService.sendPasswordResetOTP(
            profile.email, profile.username || 'User', otp
        );

        if (!emailResult || emailResult.success !== true) {
            await consumeOtpChallenge(challengeId);
            console.error('[SETTINGS] pin forgot — email send failed:', emailResult && emailResult.error);
            return res.status(503).json({ success: false, code: 'EMAIL_FAILED', error: 'Could not send verification code. Please try again.' });
        }

        await logActivity(userId, 'pin_reset_requested', 'PIN reset code requested');

        return res.json({
            success: true,
            data: {
                reset_id: challengeId,
                expires_in: OTP_EXPIRY_MINUTES,
                masked_email: maskEmail(profile.email)
            }
        });
    } catch (e) {
        console.error('[SETTINGS] pin forgot request failed:', e.message);
        return res.status(500).json({ success: false, code: 'PIN_RESET_REQUEST_FAILED', error: 'Could not start PIN reset. Please try again.' });
    }
});

router.post('/pin/forgot/verify', authMiddleware, async (req, res) => {
    try {
        const { reset_id, code } = req.body || {};
        if (!reset_id || !code) {
            return res.status(400).json({ success: false, code: 'MISSING_FIELDS', error: 'reset_id and code are required.' });
        }
        const submitted = String(code).trim();
        if (!/^\d{6}$/.test(submitted)) {
            return res.status(400).json({ success: false, code: 'INVALID_CODE_FORMAT', error: 'Please enter the 6-digit code.' });
        }

        const challenge = await loadOtpChallenge(reset_id, 'pin_reset');
        if (!challenge) {
            return res.status(400).json({ success: false, code: 'SESSION_EXPIRED', error: 'Reset session expired. Please request a new code.' });
        }
        if (challenge.user_id !== req.user.id) {
            return res.status(403).json({ success: false, code: 'CHALLENGE_NOT_OWNED', error: 'This reset does not belong to you.' });
        }
        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(reset_id);
            return res.status(400).json({ success: false, code: 'CODE_EXPIRED', error: 'Reset code expired. Please request a new one.' });
        }

        const attempts = await incrementOtpAttempts(reset_id);
        if (attempts.attempts > attempts.max_attempts) {
            await consumeOtpChallenge(reset_id);
            return res.status(400).json({ success: false, code: 'TOO_MANY_ATTEMPTS', error: 'Too many incorrect attempts. Please request a new code.' });
        }

        if (!safeCompare(hashOtp(submitted), challenge.otp_hash)) {
            const remaining = Math.max(0, (challenge.max_attempts || MAX_OTP_ATTEMPTS) - attempts.attempts);
            return res.status(400).json({
                success: false, code: 'INVALID_CODE',
                error: `Incorrect code. ${remaining} attempt(s) remaining.`,
                attempts_remaining: remaining
            });
        }

        await supabaseAdmin
            .from('otp_challenges')
            .update({ verified: true })
            .eq('challenge_id', reset_id);

        return res.json({
            success: true,
            data: { reset_id },
            message: 'Code verified. You can now set a new PIN.'
        });
    } catch (e) {
        console.error('[SETTINGS] pin forgot verify failed:', e.message);
        return res.status(500).json({ success: false, code: 'PIN_RESET_VERIFY_FAILED', error: 'Could not verify code. Please try again.' });
    }
});

router.post('/pin/forgot/reset', authMiddleware, async (req, res) => {
    try {
        const { reset_id, new_pin } = req.body || {};
        if (!reset_id) {
            return res.status(400).json({ success: false, code: 'MISSING_RESET_ID', error: 'reset_id is required.' });
        }
        const newPinStr = String(new_pin == null ? '' : new_pin);
        if (!isValidPin(newPinStr)) {
            return res.status(400).json({ success: false, code: 'INVALID_PIN_FORMAT', error: 'New PIN must be exactly 4 digits.' });
        }
        if (WEAK_PINS.has(newPinStr)) {
            return res.status(400).json({ success: false, code: 'WEAK_PIN', error: 'That PIN is too easy to guess. Choose a different one.' });
        }

        const challenge = await loadOtpChallenge(reset_id, 'pin_reset');
        if (!challenge || !challenge.verified) {
            return res.status(400).json({ success: false, code: 'CODE_NOT_VERIFIED', error: 'Please verify your reset code first.' });
        }
        if (challenge.user_id !== req.user.id) {
            return res.status(403).json({ success: false, code: 'CHALLENGE_NOT_OWNED', error: 'This reset does not belong to you.' });
        }
        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(reset_id);
            return res.status(400).json({ success: false, code: 'SESSION_EXPIRED', error: 'Reset session expired. Please request a new code.' });
        }

        const hash = await bcrypt.hash(newPinStr, 12);

        const { error: updErr } = await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_hash: hash,
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null,
                updated_at: nowIso()
            })
            .eq('id', req.user.id);

        if (updErr) {
            console.error('[SETTINGS] pin forgot write failed:', updErr.message);
            return res.status(500).json({ success: false, code: 'PIN_RESET_FAILED', error: 'Could not save new PIN. Please try again.' });
        }

        await consumeOtpChallenge(reset_id, true);
        await logActivity(req.user.id, 'transaction_pin_changed', 'Transaction PIN reset via email OTP');

        try {
            await supabaseAdmin.from('security_alerts').insert({
                user_id: req.user.id,
                alert_type: 'pin_reset',
                severity: 'high',
                description: 'Your transaction PIN was reset using an email verification code.',
                is_read: false,
                created_at: nowIso()
            });
        } catch (_) { /* non-fatal */ }

        // Session-revoke policy for PIN reset: sign out other devices.
        await supabaseAdmin
            .from('user_sessions')
            .update({ is_active: false, revoked_at: nowIso(), revoke_reason: 'pin_reset' })
            .eq('user_id', req.user.id)
            .neq('session_id', req.sessionId);

        return res.json({
            success: true,
            data: { has_transaction_pin: true },
            message: 'PIN reset successful.'
        });
    } catch (e) {
        console.error('[SETTINGS] pin forgot reset failed:', e.message);
        return res.status(500).json({ success: false, code: 'PIN_RESET_FAILED', error: 'Could not reset PIN. Please try again.' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// EMAIL CHANGE
// ═══════════════════════════════════════════════════════════════════
router.post('/email/change-request', authMiddleware, async (req, res) => {
    try {
        const newEmail = String((req.body && req.body.new_email) || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
            return res.status(400).json({ success: false, code: 'INVALID_EMAIL', error: 'Invalid email address' });
        }
        if (newEmail === req.user.email) {
            return res.status(400).json({ success: false, code: 'SAME_EMAIL', error: 'That is already your email address' });
        }
        const { data: taken } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('email', newEmail)
            .maybeSingle();
        if (taken) {
            return res.status(409).json({ success: false, code: 'EMAIL_IN_USE', error: 'That email is already in use' });
        }

        const challengeId = generateChallengeId();
        const otp = generateSecureOtp();

        await saveOtpChallenge({
            challengeId,
            userId: req.user.id,
            email: newEmail,
            purpose: 'email_change',
            otp,
            ip: req.ip,
            userAgent: String(req.headers['user-agent'] || '').slice(0, 400)
        });

        const emailResult = await emailService.sendVerificationEmail(
            newEmail, req.user.username || 'User', otp
        );
        if (!emailResult || emailResult.success !== true) {
            await consumeOtpChallenge(challengeId);
            return res.status(503).json({ success: false, code: 'EMAIL_FAILED', error: 'Could not send verification code.' });
        }

        return res.json({
            success: true,
            data: { request_id: challengeId, expires_in: OTP_EXPIRY_MINUTES }
        });
    } catch (e) {
        console.error('[SETTINGS] email change request failed:', e.message);
        return res.status(500).json({ success: false, code: 'EMAIL_CHANGE_REQUEST_FAILED', error: 'Could not start email change' });
    }
});

router.post('/email/change-verify', authMiddleware, async (req, res) => {
    try {
        const { request_id, code } = req.body || {};
        if (!request_id || !code) {
            return res.status(400).json({ success: false, code: 'MISSING_FIELDS', error: 'request_id and code are required' });
        }
        const submitted = String(code).trim();
        if (!/^\d{6}$/.test(submitted)) {
            return res.status(400).json({ success: false, code: 'INVALID_CODE_FORMAT', error: 'Please enter the 6-digit code.' });
        }

        const challenge = await loadOtpChallenge(request_id, 'email_change');
        if (!challenge) {
            return res.status(400).json({ success: false, code: 'SESSION_EXPIRED', error: 'Verification session expired.' });
        }
        if (challenge.user_id !== req.user.id) {
            return res.status(403).json({ success: false, code: 'CHALLENGE_NOT_OWNED', error: 'Challenge does not belong to you' });
        }
        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(request_id);
            return res.status(400).json({ success: false, code: 'CODE_EXPIRED', error: 'Verification code expired.' });
        }

        const attempts = await incrementOtpAttempts(request_id);
        if (attempts.attempts > attempts.max_attempts) {
            await consumeOtpChallenge(request_id);
            return res.status(400).json({ success: false, code: 'TOO_MANY_ATTEMPTS', error: 'Too many attempts.' });
        }

        if (!safeCompare(hashOtp(submitted), challenge.otp_hash)) {
            const remaining = Math.max(0, (challenge.max_attempts || MAX_OTP_ATTEMPTS) - attempts.attempts);
            return res.status(400).json({
                success: false, code: 'INVALID_CODE',
                error: `Incorrect code. ${remaining} attempt(s) remaining.`
            });
        }

        const newEmail = challenge.email;
        const oldEmail = req.user.email;

        const { data: taken } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('email', newEmail)
            .neq('id', req.user.id)
            .maybeSingle();
        if (taken) {
            await consumeOtpChallenge(request_id);
            return res.status(409).json({ success: false, code: 'EMAIL_IN_USE', error: 'That email is already in use' });
        }

        // ─── H-4: warn the OLD address BEFORE the switch ─────────
        // Non-fatal: if it fails, log and continue (the user already
        // proved control of the new address).
        try {
            if (typeof emailService.sendEmailChangeNotice === 'function') {
                await emailService.sendEmailChangeNotice(
                    oldEmail,
                    req.user.username || 'User',
                    newEmail
                );
            } else {
                console.warn('[SETTINGS] sendEmailChangeNotice not implemented — skipping old-email notice');
            }
        } catch (notifyErr) {
            console.warn('[SETTINGS] old-email notice failed (non-fatal):', notifyErr.message);
        }

        const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
            email: newEmail,
            email_confirm: true
        });
        if (authErr) throw authErr;

        await supabaseAdmin
            .from('profiles')
            .update({ email: newEmail, updated_at: nowIso() })
            .eq('id', req.user.id);

        await consumeOtpChallenge(request_id, true);
        await logActivity(req.user.id, 'email_changed', `Email changed from ${oldEmail} to ${newEmail}`);

        try {
            await createNotification(
                req.user.id,
                'Email address updated',
                `Your MilesSpace email is now ${newEmail}. If this wasn't you, contact support immediately.`,
                'success',
                '/settings.html'
            );
        } catch (_) {}

        return res.json({ success: true });
    } catch (e) {
        console.error('[SETTINGS] email change verify failed:', e.message);
        return res.status(500).json({ success: false, code: 'EMAIL_CHANGE_VERIFY_FAILED', error: 'Could not verify code' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// 2FA (email)
// ═══════════════════════════════════════════════════════════════════
router.post('/2fa/email/setup', authMiddleware, async (req, res) => {
    try {
        const challengeId = generateChallengeId();
        const otp = generateSecureOtp();

        await saveOtpChallenge({
            challengeId, userId: req.user.id,
            email: req.user.email, purpose: 'twofa_setup', otp,
            ip: req.ip,
            userAgent: String(req.headers['user-agent'] || '').slice(0, 400)
        });

        const emailResult = await emailService.send2FAEmail(
            req.user.email, req.user.username || 'User', otp, {}, 'Unknown', req.ip
        );
        if (!emailResult || emailResult.success !== true) {
            await consumeOtpChallenge(challengeId);
            return res.status(503).json({ success: false, code: 'EMAIL_FAILED', error: 'Could not send verification code.' });
        }

        return res.json({
            success: true,
            data: { masked_email: maskEmail(req.user.email), expires_in: OTP_EXPIRY_MINUTES }
        });
    } catch (e) {
        console.error('[SETTINGS] 2fa setup failed:', e.message);
        return res.status(500).json({ success: false, code: 'TWOFA_SETUP_FAILED', error: 'Could not start 2FA setup' });
    }
});

router.post('/2fa/email/verify', authMiddleware, async (req, res) => {
    try {
        const { code } = req.body || {};
        if (!code) return res.status(400).json({ success: false, code: 'MISSING_CODE', error: 'code is required' });
        const submitted = String(code).trim();
        if (!/^\d{6}$/.test(submitted)) {
            return res.status(400).json({ success: false, code: 'INVALID_CODE_FORMAT', error: 'Please enter the 6-digit code.' });
        }

        const { data: challenge } = await supabaseAdmin
            .from('otp_challenges')
            .select('*')
            .eq('user_id', req.user.id)
            .eq('purpose', 'twofa_setup')
            .eq('consumed', false)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!challenge) {
            return res.status(400).json({ success: false, code: 'NO_ACTIVE_SETUP', error: 'No active 2FA setup session' });
        }
        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(challenge.challenge_id);
            return res.status(400).json({ success: false, code: 'CODE_EXPIRED', error: 'Verification code expired.' });
        }

        const attempts = await incrementOtpAttempts(challenge.challenge_id);
        if (attempts.attempts > attempts.max_attempts) {
            await consumeOtpChallenge(challenge.challenge_id);
            return res.status(400).json({ success: false, code: 'TOO_MANY_ATTEMPTS', error: 'Too many attempts.' });
        }
        if (!safeCompare(hashOtp(submitted), challenge.otp_hash)) {
            const remaining = Math.max(0, (challenge.max_attempts || MAX_OTP_ATTEMPTS) - attempts.attempts);
            return res.status(400).json({ success: false, code: 'INVALID_CODE', error: `Incorrect code. ${remaining} attempt(s) remaining.` });
        }

        await consumeOtpChallenge(challenge.challenge_id, true);

        await supabaseAdmin
            .from('user_settings')
            .upsert({ user_id: req.user.id, email_2fa_enabled: true, updated_at: nowIso() },
                    { onConflict: 'user_id' });

        await supabaseAdmin
            .from('profiles')
            .update({ two_factor_enabled: true, updated_at: nowIso() })
            .eq('id', req.user.id);

        await logActivity(req.user.id, 'twofa_enabled', 'Email 2FA enabled');
        return res.json({ success: true });
    } catch (e) {
        console.error('[SETTINGS] 2fa verify failed:', e.message);
        return res.status(500).json({ success: false, code: 'TWOFA_VERIFY_FAILED', error: 'Could not verify code' });
    }
});

router.post('/2fa/email/resend', authMiddleware, async (req, res) => {
    try {
        const { data: challenge } = await supabaseAdmin
            .from('otp_challenges')
            .select('*')
            .eq('user_id', req.user.id)
            .eq('purpose', 'twofa_setup')
            .eq('consumed', false)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!challenge) {
            return res.status(400).json({ success: false, code: 'NO_ACTIVE_SETUP', error: 'No active setup session. Start over.' });
        }

        const otp = generateSecureOtp();
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        await supabaseAdmin
            .from('otp_challenges')
            .update({
                otp_hash: hashOtp(otp),
                expires_at: expiresAt.toISOString(),
                attempts: 0
            })
            .eq('challenge_id', challenge.challenge_id);

        const emailResult = await emailService.send2FAEmail(
            req.user.email, req.user.username || 'User', otp, {}, 'Unknown', req.ip
        );
        if (!emailResult || emailResult.success !== true) {
            return res.status(503).json({ success: false, code: 'EMAIL_FAILED', error: 'Could not resend code.' });
        }
        return res.json({ success: true });
    } catch (e) {
        console.error('[SETTINGS] 2fa resend failed:', e.message);
        return res.status(500).json({ success: false, code: 'TWOFA_RESEND_FAILED', error: 'Could not resend code' });
    }
});

router.post('/2fa/email/disable/request', authMiddleware, async (req, res) => {
    try {
        const challengeId = generateChallengeId();
        const otp = generateSecureOtp();

        await saveOtpChallenge({
            challengeId, userId: req.user.id,
            email: req.user.email, purpose: 'twofa_disable', otp,
            ip: req.ip,
            userAgent: String(req.headers['user-agent'] || '').slice(0, 400)
        });

        const emailResult = await emailService.send2FAEmail(
            req.user.email, req.user.username || 'User', otp, {}, 'Unknown', req.ip
        );
        if (!emailResult || emailResult.success !== true) {
            await consumeOtpChallenge(challengeId);
            return res.status(503).json({ success: false, code: 'EMAIL_FAILED', error: 'Could not send code.' });
        }
        return res.json({ success: true, data: { expires_in: OTP_EXPIRY_MINUTES } });
    } catch (e) {
        console.error('[SETTINGS] 2fa disable request failed:', e.message);
        return res.status(500).json({ success: false, code: 'TWOFA_DISABLE_REQUEST_FAILED', error: 'Could not start disable flow' });
    }
});

router.post('/2fa/email/disable/verify', authMiddleware, async (req, res) => {
    try {
        const { code } = req.body || {};
        if (!code) return res.status(400).json({ success: false, code: 'MISSING_CODE', error: 'code is required' });
        const submitted = String(code).trim();
        if (!/^\d{6}$/.test(submitted)) {
            return res.status(400).json({ success: false, code: 'INVALID_CODE_FORMAT', error: 'Please enter the 6-digit code.' });
        }

        const { data: challenge } = await supabaseAdmin
            .from('otp_challenges')
            .select('*')
            .eq('user_id', req.user.id)
            .eq('purpose', 'twofa_disable')
            .eq('consumed', false)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!challenge) {
            return res.status(400).json({ success: false, code: 'NO_ACTIVE_DISABLE', error: 'No active disable session' });
        }
        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(challenge.challenge_id);
            return res.status(400).json({ success: false, code: 'CODE_EXPIRED', error: 'Verification code expired.' });
        }

        const attempts = await incrementOtpAttempts(challenge.challenge_id);
        if (attempts.attempts > attempts.max_attempts) {
            await consumeOtpChallenge(challenge.challenge_id);
            return res.status(400).json({ success: false, code: 'TOO_MANY_ATTEMPTS', error: 'Too many attempts.' });
        }
        if (!safeCompare(hashOtp(submitted), challenge.otp_hash)) {
            const remaining = Math.max(0, (challenge.max_attempts || MAX_OTP_ATTEMPTS) - attempts.attempts);
            return res.status(400).json({ success: false, code: 'INVALID_CODE', error: `Incorrect code. ${remaining} attempt(s) remaining.` });
        }

        await consumeOtpChallenge(challenge.challenge_id, true);

        await supabaseAdmin
            .from('user_settings')
            .upsert({ user_id: req.user.id, email_2fa_enabled: false, updated_at: nowIso() },
                    { onConflict: 'user_id' });

        await supabaseAdmin
            .from('profiles')
            .update({ two_factor_enabled: false, updated_at: nowIso() })
            .eq('id', req.user.id);

        await logActivity(req.user.id, 'twofa_disabled', 'Email 2FA disabled');
        return res.json({ success: true });
    } catch (e) {
        console.error('[SETTINGS] 2fa disable verify failed:', e.message);
        return res.status(500).json({ success: false, code: 'TWOFA_DISABLE_VERIFY_FAILED', error: 'Could not disable 2FA' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════════════
router.delete('/sessions/:sessionId', authMiddleware, async (req, res) => {
    try {
        const sessionId = String(req.params.sessionId || '');
        if (!sessionId) return res.status(400).json({ success: false, code: 'MISSING_SESSION_ID', error: 'sessionId required' });
        if (sessionId === req.sessionId) {
            return res.status(400).json({ success: false, code: 'CANNOT_REVOKE_CURRENT', error: 'Cannot revoke the current session here. Use Logout.' });
        }

        const { error } = await supabaseAdmin
            .from('user_sessions')
            .update({
                is_active:  false,
                revoked_at: nowIso(),
                refresh_token_hash: null,
                revoke_reason: 'user_revoked'
            })
            .eq('user_id', req.user.id)
            .eq('session_id', sessionId);
        if (error) throw error;

        await logActivity(req.user.id, 'session_revoked', 'Signed out a device');
        return res.json({ success: true });
    } catch (e) {
        console.error('[SETTINGS] session revoke failed:', e.message);
        return res.status(500).json({ success: false, code: 'SESSION_REVOKE_FAILED', error: 'Could not revoke session' });
    }
});

router.post('/sessions/logout-others', authMiddleware, async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from('user_sessions')
            .update({
                is_active:  false,
                revoked_at: nowIso(),
                refresh_token_hash: null,
                revoke_reason: 'logout_others'
            })
            .eq('user_id', req.user.id)
            .neq('session_id', req.sessionId)
            .eq('is_active', true);
        if (error) throw error;

        await logActivity(req.user.id, 'session_revoked', 'Signed out all other devices');
        return res.json({ success: true });
    } catch (e) {
        console.error('[SETTINGS] logout-others failed:', e.message);
        return res.status(500).json({ success: false, code: 'LOGOUT_OTHERS_FAILED', error: 'Could not sign out other sessions' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// ACTIVITY + ALERTS
// ═══════════════════════════════════════════════════════════════════
router.get('/activity', authMiddleware, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const from  = (page - 1) * limit;
        const to    = from + limit - 1;

        const { data, error, count } = await supabaseAdmin
            .from('account_activity')
            .select(ACTIVITY_COLUMNS, { count: 'exact' })
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .range(from, to);
        if (error) throw error;

        return res.json({
            success: true,
            data: data || [],
            meta: {
                page, limit, total: count || 0,
                has_more: (from + ((data && data.length) || 0)) < (count || 0)
            }
        });
    } catch (e) {
        console.error('[SETTINGS] activity load failed:', e.message);
        return res.status(500).json({ success: false, code: 'ACTIVITY_LOAD_FAILED', error: 'Could not load activity' });
    }
});

router.get('/security-alerts', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('security_alerts')
            .select(ALERT_COLUMNS)
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(30);
        if (error) throw error;
        return res.json({ success: true, data: data || [] });
    } catch (e) {
        console.error('[SETTINGS] alerts load failed:', e.message);
        return res.status(500).json({ success: false, code: 'ALERTS_LOAD_FAILED', error: 'Could not load alerts' });
    }
});

router.post('/security-alerts/:id/read', authMiddleware, async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from('security_alerts')
            .update({ is_read: true, read_at: nowIso() })
            .eq('id', req.params.id)
            .eq('user_id', req.user.id);
        if (error) throw error;
        return res.json({ success: true });
    } catch (e) {
        console.error('[SETTINGS] alert mark-read failed:', e.message);
        return res.status(500).json({ success: false, code: 'ALERT_MARK_FAILED', error: 'Could not mark alert' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// DEACTIVATE (reversible) — distinct from permanent deletion
// ═══════════════════════════════════════════════════════════════════
router.post('/deactivate', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const { error: profileErr } = await supabaseAdmin
            .from('profiles')
            .update({ status: 'deactivated', updated_at: nowIso() })
            .eq('id', userId);
        if (profileErr) throw profileErr;

        // ─── H-3: null refresh hashes so leaked cookies can't refresh ──
        await supabaseAdmin
            .from('user_sessions')
            .update({
                is_active:          false,
                is_current:         false,
                revoked_at:         nowIso(),
                refresh_token_hash: null,
                revoke_reason:      'account_deactivated'
            })
            .eq('user_id', userId);

        await supabaseAdmin
            .from('profiles')
            .update({
                current_session_id: null,
                session_created_at: null,
                session_expires_at: null
            })
            .eq('id', userId);

        await logActivity(userId, 'account_deactivated', 'Account deactivated by user');
        return res.json({ success: true });
    } catch (e) {
        console.error('[SETTINGS] deactivate failed:', e.message);
        return res.status(500).json({ success: false, code: 'DEACTIVATE_FAILED', error: 'Could not deactivate account' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// PERMANENT DELETION (3 endpoints)
// ═══════════════════════════════════════════════════════════════════

// ─── Obligation checks before allowing deletion ────────────────
// Returns { blockers: [{code, label}] } — the frontend displays labels.
async function findDeletionBlockers(userId) {
    const blockers = [];

    // 1. Non-zero ledger balance (either currency).
    try {
        const { data: accounts } = await supabaseAdmin
            .from('ledger_accounts')
            .select('currency, available_balance')
            .eq('user_id', userId);
        for (const acc of accounts || []) {
            const bal = Number(acc.available_balance) || 0;
            if (bal > 0.0001) {
                blockers.push({
                    code: `NONZERO_BALANCE_${String(acc.currency || '').toUpperCase()}`,
                    label: `${acc.currency} wallet has a remaining balance`
                });
            }
        }
    } catch (e) {
        // ledger_accounts may not exist in some environments — treat as non-blocking
        // but log so it can be investigated.
        console.warn('[DELETE] balance check skipped:', e.message);
    }

    // 2. Pending / processing transactions.
    try {
        const { count } = await supabaseAdmin
            .from('transactions')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .in('status', ['pending', 'processing']);
        if (count && count > 0) {
            blockers.push({
                code: 'PENDING_TRANSACTIONS',
                label: `${count} transaction(s) are still pending`
            });
        }
    } catch (e) {
        console.warn('[DELETE] transaction check skipped:', e.message);
    }

    // 3. Pending deposit requests.
    try {
        const { count } = await supabaseAdmin
            .from('deposit_requests')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .in('status', ['pending', 'processing']);
        if (count && count > 0) {
            blockers.push({
                code: 'PENDING_DEPOSITS',
                label: `${count} deposit(s) are still pending`
            });
        }
    } catch (e) {
        console.warn('[DELETE] deposit check skipped:', e.message);
    }

    return blockers;
}

// ─── Step 1: request ─────────────────────────────────────────────
router.post('/delete/request', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const { data: profile, error: profileErr } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, status, deleted_at')
            .eq('id', userId)
            .single();

        if (profileErr || !profile) {
            return res.status(404).json({ success: false, code: 'PROFILE_NOT_FOUND', error: 'Profile not found.' });
        }
        if (profile.deleted_at || profile.status === 'deleted') {
            return res.status(400).json({ success: false, code: 'ALREADY_DELETED', error: 'This account is already deleted.' });
        }

        // Block if there are unsettled obligations.
        const blockers = await findDeletionBlockers(userId);
        if (blockers.length > 0) {
            return res.status(409).json({
                success: false,
                code: 'ACCOUNT_HAS_OBLIGATIONS',
                error: 'Your account has unsettled activity. Please resolve the items below, then try again.',
                data: { blockers }
            });
        }

        const challengeId = generateChallengeId();
        const otp = generateSecureOtp();

        await saveOtpChallenge({
            challengeId,
            userId,
            email: profile.email,
            purpose: 'account_deletion',
            otp,
            ip: req.ip,
            userAgent: String(req.headers['user-agent'] || '').slice(0, 400)
        });

        const emailResult = await emailService.sendPasswordResetOTP(
            profile.email,
            profile.username || 'User',
            otp
        );

        if (!emailResult || emailResult.success !== true) {
            await consumeOtpChallenge(challengeId);
            console.error('[DELETE] OTP email failed:', emailResult && emailResult.error);
            return res.status(503).json({ success: false, code: 'EMAIL_FAILED', error: 'Could not send verification code.' });
        }

        // Log the *request* (not the completion).
        await logActivity(userId, 'account_deletion_requested', 'Account deletion code requested');

        return res.json({
            success: true,
            data: {
                request_id:   challengeId,
                expires_in:   OTP_EXPIRY_MINUTES,
                masked_email: maskEmail(profile.email)
            }
        });
    } catch (e) {
        console.error('[DELETE] request failed:', e.message);
        return res.status(500).json({ success: false, code: 'DELETE_REQUEST_FAILED', error: 'Could not start deletion. Please try again.' });
    }
});

// ─── Step 2: verify OTP ──────────────────────────────────────────
router.post('/delete/verify', authMiddleware, async (req, res) => {
    try {
        const { request_id, code } = req.body || {};
        if (!request_id || !code) {
            return res.status(400).json({ success: false, code: 'MISSING_FIELDS', error: 'request_id and code are required.' });
        }
        const submitted = String(code).trim();
        if (!/^\d{6}$/.test(submitted)) {
            return res.status(400).json({ success: false, code: 'INVALID_CODE_FORMAT', error: 'Please enter the 6-digit code.' });
        }

        const challenge = await loadOtpChallenge(request_id, 'account_deletion');
        if (!challenge) {
            return res.status(400).json({ success: false, code: 'SESSION_EXPIRED', error: 'Deletion session expired. Please start again.' });
        }
        if (challenge.user_id !== req.user.id) {
            return res.status(403).json({ success: false, code: 'CHALLENGE_NOT_OWNED', error: 'This request does not belong to you.' });
        }
        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(request_id);
            return res.status(400).json({ success: false, code: 'CODE_EXPIRED', error: 'Verification code expired. Please start again.' });
        }

        const attempts = await incrementOtpAttempts(request_id);
        if (attempts.attempts > attempts.max_attempts) {
            await consumeOtpChallenge(request_id);
            return res.status(400).json({ success: false, code: 'TOO_MANY_ATTEMPTS', error: 'Too many attempts. Please start again.' });
        }
        if (!safeCompare(hashOtp(submitted), challenge.otp_hash)) {
            const remaining = Math.max(0, (challenge.max_attempts || MAX_OTP_ATTEMPTS) - attempts.attempts);
            return res.status(400).json({
                success: false, code: 'INVALID_CODE',
                error: `Incorrect code. ${remaining} attempt(s) remaining.`,
                attempts_remaining: remaining
            });
        }

        // Mark verified but do NOT consume — /confirm consumes it.
        await supabaseAdmin
            .from('otp_challenges')
            .update({ verified: true })
            .eq('challenge_id', request_id);

        return res.json({
            success: true,
            data: { verified: true },
            message: 'Code verified.'
        });
    } catch (e) {
        console.error('[DELETE] verify failed:', e.message);
        return res.status(500).json({ success: false, code: 'DELETE_VERIFY_FAILED', error: 'Could not verify code.' });
    }
});

// ─── Step 3: confirm (runs the atomic RPC) ───────────────────────
router.post('/delete/confirm', authMiddleware, async (req, res) => {
    try {
        const { request_id, confirmation } = req.body || {};
        if (!request_id || !confirmation) {
            return res.status(400).json({ success: false, code: 'MISSING_FIELDS', error: 'request_id and confirmation are required.' });
        }

        const challenge = await loadOtpChallenge(request_id, 'account_deletion');
        if (!challenge || !challenge.verified) {
            return res.status(400).json({ success: false, code: 'CODE_NOT_VERIFIED', error: 'Please verify your code first.' });
        }
        if (challenge.user_id !== req.user.id) {
            return res.status(403).json({ success: false, code: 'CHALLENGE_NOT_OWNED', error: 'This request does not belong to you.' });
        }
        if (new Date(challenge.expires_at) <= new Date()) {
            await consumeOtpChallenge(request_id);
            return res.status(400).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired. Please start again.' });
        }

        // Require the user to type their username as the final confirmation.
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('username, email')
            .eq('id', req.user.id)
            .single();

        if (!profile) {
            return res.status(404).json({ success: false, code: 'PROFILE_NOT_FOUND', error: 'Profile not found.' });
        }

        const expected = String(profile.username || '').toLowerCase().trim();
        const provided = String(confirmation).toLowerCase().trim();
        if (!expected || provided !== expected) {
            return res.status(400).json({
                success: false, code: 'CONFIRMATION_MISMATCH',
                error: 'Confirmation does not match your username.'
            });
        }

        // Re-check obligations (race-safe: another request might have
        // created a pending transaction between verify and confirm).
        const blockers = await findDeletionBlockers(req.user.id);
        if (blockers.length > 0) {
            return res.status(409).json({
                success: false, code: 'ACCOUNT_HAS_OBLIGATIONS',
                error: 'Your account has unsettled activity that must be resolved first.',
                data: { blockers }
            });
        }

        // Atomically finalise.
        const ip = req.ip || null;
        const ua = String(req.headers['user-agent'] || '').slice(0, 400);

        const { error: rpcErr } = await supabaseAdmin.rpc('finalize_account_deletion', {
            p_user_id:          req.user.id,
            p_actor_ip:         ip,
            p_actor_user_agent: ua,
            p_reason:           'user_requested'
        });

        if (rpcErr) {
            console.error('[DELETE] finalize RPC failed:', rpcErr);
            return res.status(500).json({ success: false, code: 'DELETE_FAILED', error: 'Could not complete deletion. Please contact support.' });
        }

        // Consume the challenge last — if the RPC succeeded, the OTP
        // should be marked used so it can't be replayed.
        await consumeOtpChallenge(request_id, true);

        // Best-effort confirmation email. If it fails, the deletion is
        // still complete — this is only a courtesy.
        try {
            if (typeof emailService.sendAccountDeletedEmail === 'function') {
                await emailService.sendAccountDeletedEmail(
                    profile.email,
                    profile.username || 'User'
                );
            }
        } catch (mailErr) {
            console.warn('[DELETE] confirmation email failed (non-fatal):', mailErr.message);
        }

        return res.json({
            success: true,
            message: 'Your account has been permanently deleted.'
        });
    } catch (e) {
        console.error('[DELETE] confirm failed:', e.message);
        return res.status(500).json({ success: false, code: 'DELETE_FAILED', error: 'Could not complete deletion. Please contact support.' });
    }
});

module.exports = router;