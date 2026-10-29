// routes/admin.js
// ─────────────────────────────────────────────────────────────────
// ADMIN AUTHENTICATION ROUTER
//
// Production hardening:
//   • Requires ADMIN_REFRESH_TOKEN_SECRET in production.
//   • jwt.verify() pins issuer, audience, HS256.
//   • Refresh rotation uses a single atomic RPC
//     (admin_rotate_session_atomic).
//   • MFA is required for EVERY admin role.
//   • Cache-Control: no-store on every auth response.
//   • Generic error bodies only — no internal DB errors leaked.
//   • Setup token has NO `sid` and NO `admin_sessions` row.
//   • "Email not confirmed" maps to 403 EMAIL_NOT_VERIFIED.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { supabase, supabaseAdmin, withRetry } = require('../db/supabase');
const totp = require('../services/totpService');
const mfaSvc = require('../services/adminMfaService');
const emailSvc = require('../services/emailService');

// ─── Config ─────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('❌ CRITICAL: JWT_SECRET must be set and at least 32 chars.');
    process.exit(1);
}

let ADMIN_REFRESH_SECRET;
if (process.env.NODE_ENV === 'production') {
    ADMIN_REFRESH_SECRET = process.env.ADMIN_REFRESH_TOKEN_SECRET;
    if (!ADMIN_REFRESH_SECRET || ADMIN_REFRESH_SECRET.length < 32) {
        console.error('❌ CRITICAL: ADMIN_REFRESH_TOKEN_SECRET is required in production.');
        process.exit(1);
    }
} else {
    ADMIN_REFRESH_SECRET = process.env.ADMIN_REFRESH_TOKEN_SECRET
        || crypto.createHmac('sha256', JWT_SECRET).update('admin-refresh-v1').digest('hex');
}

const ADMIN_TOKEN_EXPIRY = process.env.ADMIN_TOKEN_EXPIRY || '1h';
const ADMIN_REFRESH_TOKEN_EXPIRY = process.env.ADMIN_REFRESH_TOKEN_EXPIRY || '7d';
const ADMIN_SESSION_DURATION_MS = 60 * 60 * 1000;
const ADMIN_SETUP_TOKEN_TTL = '15m';

const JWT_ISSUER   = 'milespace-admin';
const JWT_AUDIENCE = 'milespace-admin-api';

// ─── Helpers ────────────────────────────────────────────────────
function getClientIp(req) {
    return req.ip
        || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || (req.socket && req.socket.remoteAddress)
        || 'unknown';
}
function getUserAgent(req) {
    return String(req.headers['user-agent'] || 'unknown').slice(0, 400);
}
function newSessionId() { return crypto.randomUUID(); }

function setNoStore(res) {
    try { res.setHeader('Cache-Control', 'no-store'); } catch (_) {}
}

const PROFILE_AUTH_COLUMNS = [
    'id', 'email', 'username', 'role', 'status', 'deleted_at',
    'avatar_url', 'phone', 'created_at',
    'current_session_id', 'session_created_at', 'session_expires_at',
    'last_login',
    'two_factor_enabled',
    'mfa_secret_encrypted',
    'mfa_enabled_at'
].join(', ');

const ADMIN_ROLES = new Set(['admin', 'super_admin', 'finance', 'operations', 'support', 'auditor', 'read_only']);

async function logAdminActivity({ admin_id, action, details, ip, user_agent, severity = 'info' }) {
    try {
        await supabaseAdmin.from('admin_security_events').insert({
            admin_id: admin_id || null,
            admin_email: (details && details.email) || null,
            event_type: String(action || '').slice(0, 120),
            severity,
            detail: details || {},
            ip_address: ip || null,
            user_agent: user_agent || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[ADMIN AUTH] activity insert failed:', e.message);
    }
}

function notifyAdmin({ profile, action, targetType, targetId, detail, ip, userAgent }) {
    if (!profile || !profile.email) return;
    Promise.resolve().then(function () {
        emailSvc.sendAdminSecurityAlert({
            email: profile.email,
            username: profile.username || profile.email.split('@')[0],
            action: action,
            targetType: targetType,
            targetId: targetId,
            detail: detail,
            ipAddress: ip,
            userAgent: userAgent
        }).catch(function (err) { console.warn('[ADMIN ALERT] send failed:', err.message); });
    });
}

function buildUserShape(profile, role) {
    return {
        id: profile.id,
        email: profile.email,
        username: profile.username || (profile.email ? profile.email.split('@')[0] : 'Admin'),
        role: role,
        status: profile.status || 'active',
        avatar_url: profile.avatar_url || null,
        isSuperAdmin: role === 'super_admin'
    };
}

// ─── JWT sign/verify ────────────────────────────────────────────
function signAccessToken(payload) {
    return jwt.sign(payload, JWT_SECRET, {
        expiresIn: ADMIN_TOKEN_EXPIRY,
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE
    });
}
function signRefreshToken(payload) {
    return jwt.sign(payload, ADMIN_REFRESH_SECRET, {
        expiresIn: ADMIN_REFRESH_TOKEN_EXPIRY,
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE
    });
}
function verifyAccessToken(token) {
    return jwt.verify(token, JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE
    });
}
function verifyRefreshToken(token) {
    return jwt.verify(token, ADMIN_REFRESH_SECRET, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE
    });
}

// ─── Session load + validate ────────────────────────────────────
async function loadAndValidateAdminSession(decoded) {
    if (!decoded || !decoded.id || !decoded.sid) {
        return { ok: false, status: 401, code: 'INVALID_SESSION', message: 'Session is invalid.' };
    }

    let profile;
    try {
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select(PROFILE_AUTH_COLUMNS)
            .eq('id', decoded.id)
            .maybeSingle();
        if (error) {
            console.error('[ADMIN SESSION] profile lookup failed:', error.message);
            return { ok: false, status: 503, code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication service temporarily unavailable.' };
        }
        profile = data;
    } catch (e) {
        console.error('[ADMIN SESSION] profile lookup exception:', e.message);
        return { ok: false, status: 503, code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication service temporarily unavailable.' };
    }

    if (!profile) return { ok: false, status: 404, code: 'USER_NOT_FOUND', message: 'Admin account not found.' };
    if (profile.deleted_at) return { ok: false, status: 403, code: 'ACCOUNT_DELETED', message: 'This account has been deleted.' };
    if (String(profile.status || '').toLowerCase() === 'suspended') {
        return { ok: false, status: 403, code: 'ACCOUNT_SUSPENDED', message: 'Your admin account has been suspended.' };
    }

    const role = String(profile.role || '').toLowerCase();
    if (!ADMIN_ROLES.has(role)) {
        return { ok: false, status: 403, code: 'ADMIN_REQUIRED', message: 'Admin access required.' };
    }

    if (!profile.current_session_id || profile.current_session_id !== decoded.sid) {
        return { ok: false, status: 401, code: 'SESSION_REVOKED', message: 'Session has been revoked.' };
    }
    if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
        return { ok: false, status: 401, code: 'SESSION_EXPIRED', message: 'Session has expired.' };
    }

    return { ok: true, profile, role, sessionId: decoded.sid };
}

// ─── Atomic session creation RPC ────────────────────────────────
async function createAdminSession({ profile, role, ip, userAgent }) {
    const sessionId = newSessionId();
    const now = new Date();
    const sessionExpiresAt = new Date(now.getTime() + ADMIN_SESSION_DURATION_MS);

    const accessToken = signAccessToken({ id: profile.id, sid: sessionId, role: role, type: 'admin' });
    const refreshToken = signRefreshToken({ id: profile.id, sid: sessionId, type: 'admin_refresh' });

    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('admin_create_session_atomic', {
        p_user_id: profile.id,
        p_session_id: sessionId,
        p_ip: ip || null,
        p_user_agent: userAgent || null,
        p_expires_at: sessionExpiresAt.toISOString(),
        p_last_login: now.toISOString()
    });

    if (rpcErr || !rpcData || rpcData.success === false) {
        const msg = (rpcErr && rpcErr.message) || (rpcData && rpcData.error) || 'unknown error';
        console.error('[ADMIN SESSION] atomic create failed:', msg);
        const e = new Error('Unable to create admin session. Please try again.');
        e.status = 500;
        e.code = 'SESSION_CREATION_FAILED';
        throw e;
    }

    return {
        sessionId: sessionId,
        accessToken: accessToken,
        refreshToken: refreshToken,
        sessionExpiresAt: sessionExpiresAt
    };
}

// ─── Rate limiters ──────────────────────────────────────────────
const adminLoginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: function (req) { return 'adminlogin-ip:' + getClientIp(req); },
    handler: function (req, res) {
        res.status(429).json({ success: false, code: 'ADMIN_LOGIN_RATE_LIMIT', error: 'Too many admin login attempts from this IP. Please wait 15 minutes.' });
    }
});
const adminLoginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: function (req) {
        const ip = getClientIp(req);
        const email = String((req.body && req.body.email) || '').trim().toLowerCase() || 'unknown';
        return 'adminlogin-acct:' + ip + ':' + email;
    },
    handler: function (req, res) {
        res.status(429).json({ success: false, code: 'ADMIN_LOGIN_ACCOUNT_RATE_LIMIT', error: 'Too many login attempts for this account. Please wait 15 minutes.' });
    }
});
const adminRefreshLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, max: 30,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: function (req) { return 'adminrefresh:' + getClientIp(req); },
    handler: function (req, res) {
        res.status(429).json({ success: false, code: 'ADMIN_REFRESH_RATE_LIMIT', error: 'Too many refresh attempts. Please try again shortly.' });
    }
});
const adminMfaLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 15,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: function (req) { return 'adminmfa:' + getClientIp(req); },
    handler: function (req, res) {
        res.status(429).json({ success: false, code: 'ADMIN_MFA_RATE_LIMIT', error: 'Too many verification attempts. Please wait and try again.' });
    }
});

// ─── Password verification ──────────────────────────────────────
async function verifyAdminCredentials(email, password) {
    const result = await withRetry(
        function () { return supabase.auth.signInWithPassword({ email: email, password: password }); },
        2, 800
    );
    if (result && result.error) {
        const msg = String(result.error.message || '');
        if (/email not confirmed/i.test(msg)) {
            return { ok: false, reason: 'EMAIL_NOT_CONFIRMED', detail: result.error };
        }
        return { ok: false, reason: 'INVALID_CREDENTIALS', detail: result.error };
    }
    if (!result || !result.data || !result.data.user) return { ok: false, reason: 'AUTH_SERVICE_ERROR' };
    return { ok: true, user: result.data.user };
}

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/login
// ═══════════════════════════════════════════════════════════════
router.post('/login', adminLoginIpLimiter, adminLoginAccountLimiter, async function (req, res) {
    setNoStore(res);

    const ip = getClientIp(req);
    const userAgent = getUserAgent(req);
    const rawEmail = req.body && req.body.email;
    const password = req.body && req.body.password;
    const returnTo = typeof req.body.returnTo === 'string' ? req.body.returnTo : null;

    if (!rawEmail || !password) {
        return res.status(400).json({ success: false, code: 'MISSING_CREDENTIALS', error: 'Email and password are required.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, code: 'INVALID_PASSWORD_SHAPE', error: 'Invalid email or password.' });
    }

    const email = String(rawEmail).trim().toLowerCase();

    try {
        const { data: profile, error: profileErr } = await supabaseAdmin
            .from('profiles')
            .select(PROFILE_AUTH_COLUMNS)
            .eq('email', email)
            .maybeSingle();

        if (profileErr) {
            console.error('[ADMIN LOGIN] profile lookup failed:', profileErr.message);
            return res.status(503).json({ success: false, code: 'AUTH_SERVICE_UNAVAILABLE', error: 'Authentication service temporarily unavailable.' });
        }

        if (!profile) {
            await logAdminActivity({ action: 'login_failed', details: { email: email, reason: 'no_profile' }, ip: ip, user_agent: userAgent, severity: 'warning' });
            await new Promise(function (r) { setTimeout(r, 200); });
            return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', error: 'Invalid email or password.' });
        }
        if (profile.deleted_at) {
            await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: 'deleted' }, ip: ip, user_agent: userAgent, severity: 'warning' });
            return res.status(403).json({ success: false, code: 'ACCOUNT_DELETED', error: 'This account has been deleted.' });
        }
        if (String(profile.status || '').toLowerCase() === 'suspended') {
            await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: 'suspended' }, ip: ip, user_agent: userAgent, severity: 'high' });
            return res.status(403).json({ success: false, code: 'ACCOUNT_SUSPENDED', error: 'Your admin account has been suspended.' });
        }

        const role = String(profile.role || '').toLowerCase();
        if (!ADMIN_ROLES.has(role)) {
            await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: 'not_admin', role: role }, ip: ip, user_agent: userAgent, severity: 'warning' });
            return res.status(403).json({ success: false, code: 'ADMIN_REQUIRED', error: 'Admin access required.' });
        }

        let verify;
        try {
            verify = await verifyAdminCredentials(email, password);
        } catch (e) {
            console.error('[ADMIN LOGIN] auth service error:', e.message);
            await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: 'auth_service_error' }, ip: ip, user_agent: userAgent, severity: 'high' });
            return res.status(503).json({ success: false, code: 'AUTH_SERVICE_UNAVAILABLE', error: 'Authentication service temporarily unavailable. Please try again.' });
        }
        if (!verify.ok) {
            if (verify.reason === 'EMAIL_NOT_CONFIRMED') {
                await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: 'email_not_confirmed' }, ip: ip, user_agent: userAgent, severity: 'warning' });
                return res.status(403).json({
                    success: false,
                    code: 'EMAIL_NOT_VERIFIED',
                    error: 'Your email address has not been confirmed yet. Please contact your administrator.'
                });
            }
            await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: verify.reason }, ip: ip, user_agent: userAgent, severity: 'warning' });
            return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', error: 'Invalid email or password.' });
        }

        const mfaEnabled = !!profile.two_factor_enabled
            && !!profile.mfa_secret_encrypted
            && !!profile.mfa_enabled_at;

        // ─── RESTRICTED SETUP SESSION (MFA not yet enabled) ────
        // The setup token is NOT a session token. It has no `sid`
        // because it does not correspond to a row in admin_sessions.
        // The `type` field is the only thing that distinguishes it.
        if (!mfaEnabled) {
            const setupToken = jwt.sign(
                {
                    id: profile.id,
                    type: 'admin_setup',
                    purpose: 'mfa_enrollment'
                },
                JWT_SECRET,
                {
                    expiresIn: ADMIN_SETUP_TOKEN_TTL,
                    algorithm: 'HS256',
                    issuer: JWT_ISSUER,
                    audience: JWT_AUDIENCE,
                    jwtid: crypto.randomUUID()
                }
            );

            await logAdminActivity({ admin_id: profile.id, action: 'mfa_setup_required', details: { role: role }, ip: ip, user_agent: userAgent, severity: 'info' });

            return res.json({
                success: true,
                message: 'Password accepted. Please set up two-factor authentication.',
                data: {
                    setup_required: true,
                    setup_token: setupToken
                }
            });
        }

        // ─── STANDARD MFA CHALLENGE ───────────────────────────
        const challengeSessionId = newSessionId();
        const mfaToken = mfaSvc.issueChallengeToken(profile.id, challengeSessionId);
        await logAdminActivity({ admin_id: profile.id, action: 'mfa_challenge_issued', details: { role: role }, ip: ip, user_agent: userAgent, severity: 'info' });

        return res.json({
            success: true,
            message: 'Password accepted. Enter your 6-digit code.',
            data: { mfa_required: true, mfa_token: mfaToken }
        });
    } catch (err) {
        console.error('[ADMIN LOGIN] unexpected error:', err);
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'Login failed. Please try again.' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/login/mfa
// ═══════════════════════════════════════════════════════════════
router.post('/login/mfa', adminMfaLimiter, async function (req, res) {
    setNoStore(res);

    const ip = getClientIp(req);
    const userAgent = getUserAgent(req);
    const body = req.body || {};
    const mfa_token = body.mfa_token;
    const code = body.code;
    const recovery_code = body.recovery_code;
    const returnTo = typeof body.returnTo === 'string' ? body.returnTo : null;

    if (!mfa_token) return res.status(400).json({ success: false, code: 'MISSING_MFA_TOKEN', error: 'MFA token is required.' });
    if (!code && !recovery_code) return res.status(400).json({ success: false, code: 'MISSING_CODE', error: 'Enter your 6-digit code or a recovery code.' });

    const decoded = mfaSvc.verifyChallengeToken(mfa_token);
    if (!decoded) {
        return res.status(401).json({ success: false, code: 'INVALID_MFA_TOKEN', error: 'Your verification session has expired. Please sign in again.' });
    }

    try {
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select(PROFILE_AUTH_COLUMNS + ', mfa_recovery_codes_hash')
            .eq('id', decoded.id)
            .maybeSingle();

        if (error) {
            console.error('[ADMIN MFA] profile lookup failed:', error.message);
            return res.status(503).json({ success: false, code: 'AUTH_SERVICE_UNAVAILABLE', error: 'Authentication service temporarily unavailable.' });
        }
        if (!profile) return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', error: 'Admin account not found.' });
        if (profile.deleted_at) return res.status(403).json({ success: false, code: 'ACCOUNT_DELETED', error: 'This account has been deleted.' });
        if (String(profile.status || '').toLowerCase() === 'suspended') return res.status(403).json({ success: false, code: 'ACCOUNT_SUSPENDED', error: 'Your admin account has been suspended.' });

        let verified = false;
        let usedRecovery = false;

        if (recovery_code) {
            const normalized = String(recovery_code).trim();
            const codeHash = totp.hashRecoveryCode(normalized);
            const { data: consumed, error: consumeErr } = await supabaseAdmin.rpc('admin_consume_recovery_code', {
                p_user_id: profile.id,
                p_code_hash: codeHash
            });
            if (consumeErr) {
                console.error('[ADMIN MFA] recovery consume RPC error:', consumeErr.message);
            } else if (consumed === true) {
                verified = true;
                usedRecovery = true;
            }
        } else {
            verified = totp.verifyCode({
                secretEncrypted: profile.mfa_secret_encrypted,
                code: code
            });
        }

        if (!verified) {
            await logAdminActivity({ admin_id: profile.id, action: 'mfa_failed', details: { usedRecovery: !!recovery_code }, ip: ip, user_agent: userAgent, severity: 'warning' });
            return res.status(401).json({ success: false, code: 'INVALID_MFA_CODE', error: 'Incorrect code. Please try again.' });
        }

        const role = String(profile.role || '').toLowerCase();

        let session;
        try {
            session = await createAdminSession({ profile: profile, role: role, ip: ip, userAgent: userAgent });
        } catch (e) {
            console.error('[ADMIN MFA] session persist failed:', e.message);
            return res.status(e.status || 500).json({ success: false, code: e.code || 'SESSION_CREATION_FAILED', error: e.message });
        }

        try {
            await mfaSvc.stampSessionVerified(
                session.sessionId, profile.id,
                usedRecovery ? 'recovery_code' : 'totp'
            );
        } catch (e) {
            console.error('[ADMIN MFA] session stamp failed — revoking session:', e.message);
            try {
                await supabaseAdmin.rpc('admin_revoke_session_atomic', {
                    p_user_id: profile.id,
                    p_session_id: session.sessionId,
                    p_reason: 'mfa_stamp_failed'
                });
            } catch (revokeErr) {
                console.error('[ADMIN MFA] revocation also failed:', revokeErr.message);
            }
            return res.status(503).json({
                success: false,
                code: 'MFA_STAMP_FAILED',
                error: 'Verification could not be recorded. Please sign in again.'
            });
        }

        await logAdminActivity({ admin_id: profile.id, action: usedRecovery ? 'mfa_recovery_used' : 'mfa_success', details: { role: role, usedRecovery: usedRecovery }, ip: ip, user_agent: userAgent, severity: 'info' });
        notifyAdmin({
            profile: profile,
            action: usedRecovery ? 'MFA_RECOVERY_CODE_USED' : 'ADMIN_LOGIN_NEW_DEVICE',
            detail: { role: role, usedRecovery: usedRecovery },
            ip: ip, userAgent: userAgent
        });

        return res.json({
            success: true,
            message: 'Login successful',
            data: {
                user: buildUserShape(profile, role),
                token: session.accessToken,
                refreshToken: session.refreshToken,
                expiresIn: ADMIN_TOKEN_EXPIRY,
                sessionId: session.sessionId,
                dashboardUrl: '/admin/dashboard.html',
                returnTo: returnTo
            }
        });
    } catch (err) {
        console.error('[ADMIN MFA] unexpected error:', err);
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'Verification failed. Please try again.' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/session
// ═══════════════════════════════════════════════════════════════
router.get('/session', async function (req, res) {
    setNoStore(res);
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, authenticated: false, code: 'NO_TOKEN', error: 'Authentication required.' });
        }
        const token = authHeader.slice(7);

        let decoded;
        try {
            decoded = verifyAccessToken(token);
        } catch (e) {
            if (e.name === 'TokenExpiredError') {
                return res.status(401).json({ success: false, authenticated: false, code: 'SESSION_EXPIRED', error: 'Session has expired.' });
            }
            return res.status(401).json({ success: false, authenticated: false, code: 'INVALID_TOKEN', error: 'Invalid or expired token.' });
        }
        if (decoded.type !== 'admin') {
            return res.status(403).json({ success: false, authenticated: false, code: 'ADMIN_TOKEN_REQUIRED', error: 'Admin access required.' });
        }

        const check = await loadAndValidateAdminSession(decoded);
        if (!check.ok) {
            return res.status(check.status).json({ success: false, authenticated: false, code: check.code, error: check.message });
        }

        return res.json({
            success: true,
            authenticated: true,
            user: buildUserShape(check.profile, check.role),
            session: {
                id: check.sessionId,
                created_at: check.profile.session_created_at,
                expiresAt: check.profile.session_expires_at
            }
        });
    } catch (err) {
        console.error('[ADMIN SESSION] unexpected error:', err);
        return res.status(500).json({ success: false, authenticated: false, code: 'SERVER_ERROR', error: 'Unable to verify session.' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/refresh  (atomic rotation)
// ═══════════════════════════════════════════════════════════════
router.post('/refresh', adminRefreshLimiter, async function (req, res) {
    setNoStore(res);
    try {
        const refresh_token = (req.body && req.body.refresh_token) || null;
        if (!refresh_token) {
            return res.status(400).json({ success: false, code: 'MISSING_REFRESH_TOKEN', error: 'Refresh token is required.' });
        }

        let decoded;
        try {
            decoded = verifyRefreshToken(refresh_token);
        } catch (e) {
            if (e.name === 'TokenExpiredError') {
                return res.status(401).json({ success: false, code: 'REFRESH_TOKEN_EXPIRED', error: 'Refresh token has expired.' });
            }
            return res.status(401).json({ success: false, code: 'INVALID_REFRESH_TOKEN', error: 'Invalid refresh token.' });
        }
        if (decoded.type !== 'admin_refresh') {
            return res.status(401).json({ success: false, code: 'INVALID_TOKEN_TYPE', error: 'Invalid token type.' });
        }

        const check = await loadAndValidateAdminSession(decoded);
        if (!check.ok) {
            return res.status(check.status).json({ success: false, code: check.code, error: check.message });
        }

        const role = check.role;
        const profile = check.profile;

        const newSid = newSessionId();
        const now = new Date();
        const sessionExpiresAt = new Date(now.getTime() + ADMIN_SESSION_DURATION_MS);

        const newAccessToken = signAccessToken({ id: profile.id, sid: newSid, role: role, type: 'admin' });
        const newRefreshToken = signRefreshToken({ id: profile.id, sid: newSid, type: 'admin_refresh' });

        const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('admin_rotate_session_atomic', {
            p_user_id: profile.id,
            p_old_session_id: decoded.sid,
            p_new_session_id: newSid,
            p_ip: getClientIp(req),
            p_user_agent: getUserAgent(req),
            p_expires_at: sessionExpiresAt.toISOString(),
            p_last_login: now.toISOString()
        });

        if (rpcErr || !rpcData || rpcData.success === false) {
            const msg = (rpcErr && rpcErr.message) || (rpcData && rpcData.error) || 'unknown error';
            console.error('[ADMIN REFRESH] atomic rotate failed:', msg);
            return res.status(409).json({
                success: false,
                code: 'SESSION_ROTATION_FAILED',
                error: 'Your session could not be refreshed. Please sign in again.'
            });
        }

        await logAdminActivity({
            admin_id: profile.id,
            action: 'session_refreshed',
            details: { role: role, rotated: true },
            ip: getClientIp(req),
            user_agent: getUserAgent(req),
            severity: 'info'
        });

        return res.json({
            success: true,
            data: {
                access_token: newAccessToken,
                refresh_token: newRefreshToken,
                expiresIn: ADMIN_TOKEN_EXPIRY,
                sessionId: newSid
            }
        });
    } catch (err) {
        console.error('[ADMIN REFRESH] unexpected error:', err);
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'Failed to refresh token.' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/logout
// ═══════════════════════════════════════════════════════════════
router.post('/logout', async function (req, res) {
    setNoStore(res);
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.json({ success: true, message: 'Logged out.' });
        }
        const token = authHeader.slice(7);

        let decoded;
        try { decoded = verifyAccessToken(token); }
        catch (e) { return res.json({ success: true, message: 'Logged out.' }); }

        if (decoded.type === 'admin' && decoded.id && decoded.sid) {
            const { error: rpcErr } = await supabaseAdmin.rpc('admin_revoke_session_atomic', {
                p_user_id: decoded.id,
                p_session_id: decoded.sid,
                p_reason: 'logout'
            });
            if (rpcErr) {
                console.warn('[ADMIN LOGOUT] atomic revoke failed:', rpcErr.message);
            }
            await logAdminActivity({
                admin_id: decoded.id,
                action: 'logout',
                details: {},
                ip: getClientIp(req),
                user_agent: getUserAgent(req),
                severity: 'info'
            });
        }

        return res.json({ success: true, message: 'Logged out.' });
    } catch (err) {
        console.error('[ADMIN LOGOUT] unexpected error:', err);
        return res.json({ success: true, message: 'Logged out.' });
    }
});

module.exports = router;
module.exports.createAdminSession = createAdminSession;