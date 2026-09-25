// routes/admin.js
// ─────────────────────────────────────────────────────────────────
// ADMIN AUTHENTICATION ROUTER
//
//   POST /api/admin/login                (password step)
//   POST /api/admin/login/mfa            (second factor)
//   GET  /api/admin/session
//   POST /api/admin/refresh
//   POST /api/admin/logout
//
// MFA is read from the ENCRYPTED column (mfa_secret_encrypted),
// never the plaintext column. All secret material is handled by
// services/totpService and services/mfaCrypto.
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { supabase, supabaseAdmin, withRetry } = require('../db/supabase');
const totp = require('../services/totpService');
const mfaSvc = require('../services/adminMfaService');
const emailSvc = require('../services/emailService');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('❌ CRITICAL: JWT_SECRET must be set and at least 32 chars.');
    process.exit(1);
}
const ADMIN_REFRESH_SECRET = process.env.ADMIN_REFRESH_TOKEN_SECRET
    || crypto.createHmac('sha256', JWT_SECRET).update('admin-refresh-v1').digest('hex');

const ADMIN_TOKEN_EXPIRY = process.env.ADMIN_TOKEN_EXPIRY || '1h';
const ADMIN_REFRESH_TOKEN_EXPIRY = process.env.ADMIN_REFRESH_TOKEN_EXPIRY || '7d';
const ADMIN_SESSION_DURATION_MS = 60 * 60 * 1000;

function getClientIp(req) {
    return req.ip
        || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || 'unknown';
}
function getUserAgent(req) {
    return String(req.headers['user-agent'] || 'unknown').slice(0, 400);
}
function newSessionId() { return crypto.randomUUID(); }

// NOTE: `mfa_secret_encrypted` is selected, never `mfa_secret`.
// `mfa_secret` is a legacy plaintext column that no longer holds
// the active secret. Reading it always returns null and breaks MFA.
const PROFILE_AUTH_COLUMNS = [
    'id', 'email', 'username', 'role', 'status', 'deleted_at',
    'avatar_url', 'phone', 'created_at',
    'current_session_id', 'session_created_at', 'session_expires_at',
    'last_login',
    'two_factor_enabled',
    'mfa_secret_encrypted',
    'mfa_enabled_at'
].join(', ');

async function logAdminActivity({ admin_id, action, details, ip, user_agent, severity = 'info' }) {
    try {
        await supabaseAdmin.from('admin_security_events').insert({
            admin_id: admin_id || null,
            admin_email: details?.email || null,
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
    if (!profile?.email) return;
    Promise.resolve().then(() => {
        emailSvc.sendAdminSecurityAlert({
            email: profile.email,
            username: profile.username || profile.email.split('@')[0],
            action,
            targetType, targetId, detail,
            ipAddress: ip,
            userAgent
        }).catch(err => console.warn('[ADMIN ALERT] send failed:', err.message));
    });
}

const adminLoginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `adminlogin-ip:${getClientIp(req)}`,
    handler: (req, res) => res.status(429).json({
        success: false, code: 'ADMIN_LOGIN_RATE_LIMIT',
        error: 'Too many admin login attempts from this IP. Please wait 15 minutes.'
    })
});

const adminLoginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        const email = String(req.body?.email || '').trim().toLowerCase() || 'unknown';
        return `adminlogin-acct:${ip}:${email}`;
    },
    handler: (req, res) => res.status(429).json({
        success: false, code: 'ADMIN_LOGIN_ACCOUNT_RATE_LIMIT',
        error: 'Too many login attempts for this account. Please wait 15 minutes.'
    })
});

const adminRefreshLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, max: 30,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `adminrefresh:${getClientIp(req)}`,
    handler: (req, res) => res.status(429).json({
        success: false, code: 'ADMIN_REFRESH_RATE_LIMIT',
        error: 'Too many refresh attempts. Please try again shortly.'
    })
});

const adminMfaLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 15,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `adminmfa:${getClientIp(req)}`,
    handler: (req, res) => res.status(429).json({
        success: false, code: 'ADMIN_MFA_RATE_LIMIT',
        error: 'Too many verification attempts. Please wait and try again.'
    })
});

async function verifyAdminCredentials(email, password) {
    const result = await withRetry(
        () => supabase.auth.signInWithPassword({ email, password }),
        2, 800
    );
    if (result?.error) return { ok: false, reason: 'INVALID_CREDENTIALS' };
    if (!result?.data?.user) return { ok: false, reason: 'AUTH_SERVICE_ERROR' };
    return { ok: true, user: result.data.user };
}

function buildUserShape(profile, role) {
    return {
        id: profile.id,
        email: profile.email,
        username: profile.username || profile.email?.split('@')[0] || 'Admin',
        role,
        status: profile.status || 'active',
        avatar_url: profile.avatar_url || null,
        isSuperAdmin: role === 'super_admin'
    };
}

// Central session creation used by both the no-MFA login path and the
// MFA-verified login path. Returns { accessToken, refreshToken,
// sessionExpiresAt } or throws on persist failure.
async function createAdminSession({ profile, role, ip, userAgent }) {
    const sessionId = newSessionId();
    const now = new Date();
    const sessionExpiresAt = new Date(now.getTime() + ADMIN_SESSION_DURATION_MS);

    const accessToken = jwt.sign(
        { id: profile.id, sid: sessionId, role, type: 'admin' },
        JWT_SECRET,
        { expiresIn: ADMIN_TOKEN_EXPIRY }
    );
    const refreshToken = jwt.sign(
        { id: profile.id, sid: sessionId, type: 'admin_refresh' },
        ADMIN_REFRESH_SECRET,
        { expiresIn: ADMIN_REFRESH_TOKEN_EXPIRY }
    );

    const { error: updErr } = await supabaseAdmin
        .from('profiles')
        .update({
            current_session_id: sessionId,
            session_created_at: now.toISOString(),
            session_expires_at: sessionExpiresAt.toISOString(),
            last_login: now.toISOString(),
            last_ip: ip,
            last_login_browser: userAgent,
            updated_at: now.toISOString()
        })
        .eq('id', profile.id);

    if (updErr) {
        const e = new Error('Unable to create admin session. Please try again.');
        e.status = 500; e.code = 'SESSION_CREATION_FAILED';
        throw e;
    }

    await mfaSvc.upsertSessionRow({
        sessionId, userId: profile.id, ip, userAgent,
        expiresAt: sessionExpiresAt.toISOString()
    });

    return { sessionId, accessToken, refreshToken, sessionExpiresAt };
}

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/login
// ═══════════════════════════════════════════════════════════════
router.post('/login', adminLoginIpLimiter, adminLoginAccountLimiter, async (req, res) => {
    const ip = getClientIp(req);
    const userAgent = getUserAgent(req);
    const rawEmail = req.body?.email;
    const password = req.body?.password;

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
            await logAdminActivity({ action: 'login_failed', details: { email, reason: 'no_profile' }, ip, user_agent: userAgent, severity: 'warning' });
            await new Promise(r => setTimeout(r, 200));
            return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', error: 'Invalid email or password.' });
        }
        if (profile.deleted_at) {
            await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: 'deleted' }, ip, user_agent: userAgent, severity: 'warning' });
            return res.status(403).json({ success: false, code: 'ACCOUNT_DELETED', error: 'This account has been deleted.' });
        }
        if (String(profile.status || '').toLowerCase() === 'suspended') {
            await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: 'suspended' }, ip, user_agent: userAgent, severity: 'high' });
            return res.status(403).json({ success: false, code: 'ACCOUNT_SUSPENDED', error: 'Your admin account has been suspended.' });
        }
        const role = String(profile.role || '').toLowerCase();
        if (role !== 'admin' && role !== 'super_admin') {
            await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: 'not_admin', role }, ip, user_agent: userAgent, severity: 'warning' });
            return res.status(403).json({ success: false, code: 'ADMIN_REQUIRED', error: 'Admin access required.' });
        }

        let verify;
        try {
            verify = await verifyAdminCredentials(email, password);
        } catch (e) {
            console.error('[ADMIN LOGIN] auth service error:', e.message);
            await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: 'auth_service_error' }, ip, user_agent: userAgent, severity: 'high' });
            return res.status(503).json({ success: false, code: 'AUTH_SERVICE_UNAVAILABLE', error: 'Authentication service temporarily unavailable. Please try again.' });
        }
        if (!verify.ok) {
            await logAdminActivity({ admin_id: profile.id, action: 'login_failed', details: { reason: verify.reason }, ip, user_agent: userAgent, severity: 'warning' });
            return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', error: 'Invalid email or password.' });
        }

        // ─── MFA check — reads the ENCRYPTED column ────────────
        const mfaEnabled = !!profile.two_factor_enabled
            && !!profile.mfa_secret_encrypted
            && !!profile.mfa_enabled_at;

        if (mfaEnabled) {
            const challengeSessionId = newSessionId();
            const mfaToken = mfaSvc.issueChallengeToken(profile.id, challengeSessionId);
            await logAdminActivity({ admin_id: profile.id, action: 'mfa_challenge_issued', details: { role }, ip, user_agent: userAgent, severity: 'info' });
            return res.json({
                success: true,
                message: 'Password accepted. Enter your 6-digit code.',
                data: { mfa_required: true, mfa_token: mfaToken }
            });
        }

        // No MFA — create session directly.
        let session;
        try {
            session = await createAdminSession({ profile, role, ip, userAgent });
        } catch (e) {
            console.error('[ADMIN LOGIN] session persist failed:', e.message);
            return res.status(e.status || 500).json({ success: false, code: e.code || 'SESSION_CREATION_FAILED', error: e.message });
        }

        await logAdminActivity({ admin_id: profile.id, action: 'login_success', details: { role, mfa: false }, ip, user_agent: userAgent, severity: 'info' });
        notifyAdmin({ profile, action: 'ADMIN_LOGIN_NEW_DEVICE', detail: { role, mfa: false }, ip, userAgent });

        return res.json({
            success: true,
            message: 'Login successful',
            data: {
                user: buildUserShape(profile, role),
                token: session.accessToken,
                refreshToken: session.refreshToken,
                expiresIn: ADMIN_TOKEN_EXPIRY,
                sessionId: session.sessionId,
                dashboardUrl: '/admin/dashboard.html'
            }
        });
    } catch (err) {
        console.error('[ADMIN LOGIN] unexpected error:', err);
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'Login failed. Please try again.' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/login/mfa
// ═══════════════════════════════════════════════════════════════
router.post('/login/mfa', adminMfaLimiter, async (req, res) => {
    const ip = getClientIp(req);
    const userAgent = getUserAgent(req);
    const { mfa_token, code, recovery_code } = req.body || {};

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

        if (error || !profile) return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', error: 'Admin account not found.' });
        if (profile.deleted_at) return res.status(403).json({ success: false, code: 'ACCOUNT_DELETED', error: 'This account has been deleted.' });
        if (String(profile.status || '').toLowerCase() === 'suspended') return res.status(403).json({ success: false, code: 'ACCOUNT_SUSPENDED', error: 'Your admin account has been suspended.' });

        let verified = false;
        let usedRecovery = false;

        if (recovery_code) {
            const result = totp.verifyRecoveryCode(profile.mfa_recovery_codes_hash || [], recovery_code);
            if (result.ok) {
                verified = true;
                usedRecovery = true;
                await supabaseAdmin
                    .from('profiles')
                    .update({ mfa_recovery_codes_hash: result.remainingHashes, updated_at: new Date().toISOString() })
                    .eq('id', profile.id);
            }
        } else {
            // Verify against the ENCRYPTED secret.
            verified = totp.verifyCode({
                secretEncrypted: profile.mfa_secret_encrypted,
                code
            });
        }

        if (!verified) {
            await logAdminActivity({ admin_id: profile.id, action: 'mfa_failed', details: { usedRecovery: !!recovery_code }, ip, user_agent: userAgent, severity: 'warning' });
            return res.status(401).json({ success: false, code: 'INVALID_MFA_CODE', error: 'Incorrect code. Please try again.' });
        }

        const role = String(profile.role || '').toLowerCase();

        let session;
        try {
            session = await createAdminSession({ profile, role, ip, userAgent });
        } catch (e) {
            console.error('[ADMIN MFA] session persist failed:', e.message);
            return res.status(e.status || 500).json({ success: false, code: e.code || 'SESSION_CREATION_FAILED', error: e.message });
        }

        // Stamp this session as MFA-verified.
        try {
            await mfaSvc.stampSessionVerified(session.sessionId, profile.id, usedRecovery ? 'recovery_code' : 'totp');
        } catch (e) {
            console.warn('[ADMIN MFA] session stamp failed:', e.message);
        }

        await logAdminActivity({ admin_id: profile.id, action: usedRecovery ? 'mfa_recovery_used' : 'mfa_success', details: { role, usedRecovery }, ip, user_agent: userAgent, severity: 'info' });
        notifyAdmin({
            profile,
            action: usedRecovery ? 'MFA_RECOVERY_CODE_USED' : 'ADMIN_LOGIN_NEW_DEVICE',
            detail: { role, usedRecovery },
            ip, userAgent
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
                dashboardUrl: '/admin/dashboard.html'
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
router.get('/session', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, authenticated: false, code: 'NO_TOKEN', error: 'Authentication required.' });
        }
        const token = authHeader.slice(7);
        let decoded;
        try { decoded = jwt.verify(token, JWT_SECRET); }
        catch (e) {
            if (e.name === 'TokenExpiredError') return res.status(401).json({ success: false, authenticated: false, code: 'SESSION_EXPIRED', error: 'Session has expired.' });
            return res.status(401).json({ success: false, authenticated: false, code: 'INVALID_TOKEN', error: 'Invalid or expired token.' });
        }
        if (decoded.type !== 'admin') {
            return res.status(403).json({ success: false, authenticated: false, code: 'ADMIN_TOKEN_REQUIRED', error: 'Admin access required.' });
        }
        const { data: profile, error } = await supabaseAdmin
            .from('profiles').select(PROFILE_AUTH_COLUMNS).eq('id', decoded.id).single();

        if (error || !profile) return res.status(404).json({ success: false, authenticated: false, code: 'USER_NOT_FOUND', error: 'Admin account not found.' });
        if (profile.deleted_at) return res.status(403).json({ success: false, authenticated: false, code: 'ACCOUNT_DELETED', error: 'Account deleted.' });
        if (String(profile.status || '').toLowerCase() === 'suspended') return res.status(403).json({ success: false, authenticated: false, code: 'ACCOUNT_SUSPENDED', error: 'Account suspended.' });

        const role = String(profile.role || '').toLowerCase();
        if (role !== 'admin' && role !== 'super_admin') {
            return res.status(403).json({ success: false, authenticated: false, code: 'ADMIN_REQUIRED', error: 'Admin access required.' });
        }
        if (!profile.current_session_id || profile.current_session_id !== decoded.sid) {
            return res.status(401).json({ success: false, authenticated: false, code: 'SESSION_REVOKED', error: 'Session has been revoked.' });
        }
        if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
            return res.status(401).json({ success: false, authenticated: false, code: 'SESSION_EXPIRED', error: 'Session has expired.' });
        }

        return res.json({
            success: true,
            authenticated: true,
            user: buildUserShape(profile, role),
            session: { id: decoded.sid, created_at: profile.session_created_at, expiresAt: profile.session_expires_at }
        });
    } catch (err) {
        console.error('[ADMIN SESSION] unexpected error:', err);
        return res.status(500).json({ success: false, authenticated: false, code: 'SERVER_ERROR', error: 'Unable to verify session.' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/refresh
// ═══════════════════════════════════════════════════════════════
router.post('/refresh', adminRefreshLimiter, async (req, res) => {
    try {
        const { refresh_token } = req.body || {};
        if (!refresh_token) return res.status(400).json({ success: false, code: 'MISSING_REFRESH_TOKEN', error: 'Refresh token is required.' });

        let decoded;
        try { decoded = jwt.verify(refresh_token, ADMIN_REFRESH_SECRET); }
        catch (e) {
            if (e.name === 'TokenExpiredError') return res.status(401).json({ success: false, code: 'REFRESH_TOKEN_EXPIRED', error: 'Refresh token has expired.' });
            return res.status(401).json({ success: false, code: 'INVALID_REFRESH_TOKEN', error: 'Invalid refresh token.' });
        }
        if (decoded.type !== 'admin_refresh') return res.status(401).json({ success: false, code: 'INVALID_TOKEN_TYPE', error: 'Invalid token type.' });

        const { data: profile, error } = await supabaseAdmin
            .from('profiles').select(PROFILE_AUTH_COLUMNS).eq('id', decoded.id).single();
        if (error || !profile) return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', error: 'User not found.' });
        if (profile.deleted_at) return res.status(403).json({ success: false, code: 'ACCOUNT_DELETED', error: 'Account deleted.' });
        if (String(profile.status || '').toLowerCase() === 'suspended') return res.status(403).json({ success: false, code: 'ACCOUNT_SUSPENDED', error: 'Account suspended.' });
        const role = String(profile.role || '').toLowerCase();
        if (role !== 'admin' && role !== 'super_admin') return res.status(403).json({ success: false, code: 'ADMIN_REQUIRED', error: 'Admin access required.' });
        if (!profile.current_session_id || profile.current_session_id !== decoded.sid) return res.status(401).json({ success: false, code: 'SESSION_REVOKED', error: 'Session has been revoked. Please sign in again.' });
        if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session has expired. Please sign in again.' });

        const newSessionIdValue = newSessionId();
        const now = new Date();
        const newExpiry = new Date(now.getTime() + ADMIN_SESSION_DURATION_MS);

        const newAccess = jwt.sign({ id: profile.id, sid: newSessionIdValue, role, type: 'admin' }, JWT_SECRET, { expiresIn: ADMIN_TOKEN_EXPIRY });
        const newRefresh = jwt.sign({ id: profile.id, sid: newSessionIdValue, type: 'admin_refresh' }, ADMIN_REFRESH_SECRET, { expiresIn: ADMIN_REFRESH_TOKEN_EXPIRY });

        const { error: updErr } = await supabaseAdmin
            .from('profiles')
            .update({
                current_session_id: newSessionIdValue,
                session_created_at: now.toISOString(),
                session_expires_at: newExpiry.toISOString(),
                updated_at: now.toISOString()
            })
            .eq('id', profile.id);
        if (updErr) {
            console.error('[ADMIN REFRESH] session update failed:', updErr.message);
            return res.status(500).json({ success: false, code: 'SESSION_UPDATE_FAILED', error: 'Unable to refresh session.' });
        }

        await mfaSvc.upsertSessionRow({
            sessionId: newSessionIdValue, userId: profile.id,
            ip: getClientIp(req), userAgent: getUserAgent(req),
            expiresAt: newExpiry.toISOString()
        });

        return res.json({
            success: true,
            data: { access_token: newAccess, refresh_token: newRefresh, expiresIn: ADMIN_TOKEN_EXPIRY, sessionId: newSessionIdValue }
        });
    } catch (err) {
        console.error('[ADMIN REFRESH] unexpected error:', err);
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'Failed to refresh token.' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/logout
// ═══════════════════════════════════════════════════════════════
router.post('/logout', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return res.json({ success: true, message: 'Logged out.' });
        const token = authHeader.slice(7);

        let decoded;
        try { decoded = jwt.verify(token, JWT_SECRET); }
        catch { return res.json({ success: true, message: 'Logged out.' }); }

        if (decoded.type === 'admin' && decoded.id && decoded.sid) {
            await supabaseAdmin
                .from('profiles')
                .update({ current_session_id: null, session_created_at: null, session_expires_at: null, updated_at: new Date().toISOString() })
                .eq('id', decoded.id)
                .eq('current_session_id', decoded.sid);

            try {
                await supabaseAdmin
                    .from('user_sessions')
                    .update({ is_active: false, revoked_at: new Date().toISOString(), revoked_reason: 'logout' })
                    .eq('session_id', decoded.sid)
                    .eq('user_id', decoded.id);
            } catch (e) {
                console.warn('[ADMIN LOGOUT] session revoke failed:', e.message);
            }

            await logAdminActivity({ admin_id: decoded.id, action: 'logout', details: {}, ip: getClientIp(req), user_agent: getUserAgent(req), severity: 'info' });
        }

        return res.json({ success: true, message: 'Logged out.' });
    } catch (err) {
        console.error('[ADMIN LOGOUT] unexpected error:', err);
        return res.json({ success: true, message: 'Logged out.' });
    }
});

module.exports = router;