// middleware/auth.js
// STRICT authentication middleware.
// ─────────────────────────────────────────────────────────────────
// Guarantees:
//   • JWT is verified with explicit algorithm, issuer, audience.
//   • The JWT's `sid` MUST match profiles.current_session_id.
//   • The corresponding user_sessions row MUST be active + unexpired.
//   • Account state is checked in ONE place (evaluateAccountAccess)
//     so login, refresh, and every protected route agree.
//   • Fail-closed: DB error → 503, revoked session → 401.
//   • Never repairs or auto-restores a mismatched session.
// ─────────────────────────────────────────────────────────────────

'use strict';

const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../db/supabase');

// ─── JWT config ──────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ CRITICAL: JWT_SECRET environment variable is required');
    if (process.env.NODE_ENV === 'production') process.exit(1);
}

const JWT_ISSUER   = process.env.JWT_ISSUER   || 'milesspace';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'milesspace-client';

// ─── Auth codes (stable strings the frontend can switch on) ──────
const AUTH_CODES = Object.freeze({
    NO_TOKEN:                 'NO_TOKEN',
    INVALID_TOKEN:            'INVALID_TOKEN',
    SESSION_EXPIRED:          'SESSION_EXPIRED',
    SESSION_REVOKED:          'SESSION_REVOKED',
    INVALID_SESSION:          'INVALID_SESSION',
    USER_NOT_FOUND:           'USER_NOT_FOUND',
    ACCOUNT_DELETED:          'ACCOUNT_DELETED',
    ACCOUNT_DEACTIVATED:      'ACCOUNT_DEACTIVATED',
    ACCOUNT_SUSPENDED:        'ACCOUNT_SUSPENDED',
    AUTH_SERVICE_UNAVAILABLE: 'AUTH_SERVICE_UNAVAILABLE',
    ADMIN_REQUIRED:           'ADMIN_REQUIRED',
    SUPER_ADMIN_REQUIRED:     'SUPER_ADMIN_REQUIRED'
});

// ─── Canonical account-state policy ──────────────────────────────
// Used by middleware AND by authRoutes for /login, /refresh, /2fa.
// Return `null` → OK to proceed. Return object → deny.
function evaluateAccountAccess(profile) {
    if (!profile) {
        return { status: 404, code: AUTH_CODES.USER_NOT_FOUND,
                 message: 'User profile not found.' };
    }
    if (profile.deleted_at || profile.status === 'deleted') {
        return { status: 403, code: AUTH_CODES.ACCOUNT_DELETED,
                 message: 'This account has been deleted.' };
    }
    if (profile.status === 'deactivated') {
        return { status: 403, code: AUTH_CODES.ACCOUNT_DEACTIVATED,
                 message: 'This account has been deactivated. Contact support to reactivate.' };
    }
    if (profile.status === 'suspended') {
        return { status: 403, code: AUTH_CODES.ACCOUNT_SUSPENDED,
                 message: 'Your account has been suspended.' };
    }
    return null;
}

// ─── Retry for transient network failures only ───────────────────
async function withRetry(fn, retries = 2, delayMs = 300) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const isNetwork =
                err?.message?.includes('fetch failed') ||
                ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','ECONNREFUSED']
                    .includes(err?.cause?.code);
            if (!isNetwork || i === retries - 1) throw err;
            await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
        }
    }
    throw lastError;
}

// ─── Defensive response writer ───────────────────────────────────
// Never throws. Returns true if the response was written.
function trySendJson(res, status, body) {
    try {
        if (!res || typeof res.status !== 'function') return false;
        if (res.headersSent) return false;
        res.status(status).json(body);
        return true;
    } catch (e) {
        console.error('[AUTH] trySendJson failed:', e.message);
        return false;
    }
}

// ─── Main middleware ─────────────────────────────────────────────
async function authMiddleware(req, res, next) {
    try {
        const header = req.headers?.authorization;
        if (!header || !header.startsWith('Bearer ')) {
            return trySendJson(res, 401, {
                success: false, code: AUTH_CODES.NO_TOKEN,
                message: 'Authentication required.'
            });
        }

        const token = header.substring(7);
        if (!token || token.length < 10) {
            return trySendJson(res, 401, {
                success: false, code: AUTH_CODES.INVALID_TOKEN,
                message: 'Invalid authentication token.'
            });
        }

        // ─── Verify JWT ─────────────────────────────────────────
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET, {
                algorithms: ['HS256'],
                issuer:     JWT_ISSUER,
                audience:   JWT_AUDIENCE
            });
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return trySendJson(res, 401, {
                    success: false, code: AUTH_CODES.SESSION_EXPIRED,
                    message: 'Your session has expired. Please sign in again.',
                    canRefresh: true
                });
            }
            return trySendJson(res, 401, {
                success: false, code: AUTH_CODES.INVALID_TOKEN,
                message: 'Invalid or expired token.'
            });
        }

        if (!decoded.sid || !decoded.id) {
            return trySendJson(res, 401, {
                success: false, code: AUTH_CODES.INVALID_SESSION,
                message: 'Invalid session. Please sign in again.'
            });
        }

        // ─── Load profile ───────────────────────────────────────
        let profileResult;
        try {
            profileResult = await withRetry(() =>
                supabaseAdmin
                    .from('profiles')
                    .select(`
                        id, email, username, role, status, deleted_at,
                        wallet_ngn, wallet_usd, referral_code, is_verified,
                        transaction_pin_hash, current_session_id,
                        session_created_at, session_expires_at,
                        avatar_url, phone
                    `)
                    .eq('id', decoded.id)
                    .single()
            );
        } catch (dbError) {
            console.error('❌ [AUTH] Profile query failed:', dbError.message);
            return trySendJson(res, 503, {
                success: false, code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                message: 'Authentication service temporarily unavailable.'
            });
        }

        const profile = profileResult?.data;
        const profileError = profileResult?.error;

        if (profileError || !profile) {
            return trySendJson(res, 404, {
                success: false, code: AUTH_CODES.USER_NOT_FOUND,
                message: 'User profile not found.'
            });
        }

        // ─── Central account-state policy ───────────────────────
        const denied = evaluateAccountAccess(profile);
        if (denied) {
            return trySendJson(res, denied.status, {
                success: false, code: denied.code, message: denied.message
            });
        }

        // ─── Strict session pointer check ───────────────────────
        if (!profile.current_session_id) {
            return trySendJson(res, 401, {
                success: false, code: AUTH_CODES.SESSION_REVOKED,
                message: 'Your session is no longer active. Please sign in again.'
            });
        }
        if (profile.current_session_id !== decoded.sid) {
            return trySendJson(res, 401, {
                success: false, code: AUTH_CODES.SESSION_REVOKED,
                message: 'Your session has been ended because your account was signed in on another device.'
            });
        }

        // ─── Verify the user_sessions row ────────────────────────
        let sessionRow = null;
        try {
            const sessionResult = await withRetry(() =>
                supabaseAdmin
                    .from('user_sessions')
                    .select('is_active, revoked_at, expires_at')
                    .eq('session_id', decoded.sid)
                    .eq('user_id', profile.id)
                    .maybeSingle()
            );
            sessionRow = sessionResult?.data;
        } catch (e) {
            console.error('❌ [AUTH] user_sessions lookup failed:', e.message);
            return trySendJson(res, 503, {
                success: false, code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                message: 'Authentication service temporarily unavailable.'
            });
        }

        if (!sessionRow || !sessionRow.is_active || sessionRow.revoked_at) {
            return trySendJson(res, 401, {
                success: false, code: AUTH_CODES.SESSION_REVOKED,
                message: 'Your session has been revoked. Please sign in again.'
            });
        }

        if (sessionRow.expires_at && new Date(sessionRow.expires_at) <= new Date()) {
            return trySendJson(res, 401, {
                success: false, code: AUTH_CODES.SESSION_EXPIRED,
                message: 'Your session has expired. Please sign in again.',
                canRefresh: true
            });
        }

        // ─── Attach to request ─────────────────────────────────
        req.user = {
            id:                  profile.id,
            email:               profile.email,
            username:            profile.username || profile.email?.split('@')[0] || 'User',
            role:                profile.role || 'user',
            isAdmin:             profile.role === 'admin' || profile.role === 'super_admin',
            isSuperAdmin:        profile.role === 'super_admin',
            status:              profile.status || 'active',
            wallet_ngn:          parseFloat(profile.wallet_ngn) || 0,
            wallet_usd:          parseFloat(profile.wallet_usd) || 0,
            referral_code:       profile.referral_code || '',
            is_verified:         profile.is_verified || false,
            has_transaction_pin: !!profile.transaction_pin_hash,
            session_id:          decoded.sid,
            avatar_url:          profile.avatar_url || null,
            phone:               profile.phone || null
        };
        req.userId    = profile.id;
        req.sessionId = decoded.sid;

        return next();
    } catch (error) {
        console.error('❌ [AUTH] Unhandled error:', error.message);
        const wrote = trySendJson(res, 503, {
            success: false, code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
            message: 'Authentication service temporarily unavailable.'
        });
        if (!wrote && typeof next === 'function') return next(error);
    }
}

// ─── Admin middleware ────────────────────────────────────────────
function adminAuthMiddleware(req, res, next) {
    authMiddleware(req, res, (err) => {
        if (err) {
            return trySendJson(res, 503, {
                success: false, code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                message: 'Authentication service temporarily unavailable.'
            });
        }
        if (!req.user?.isAdmin) {
            return trySendJson(res, 403, {
                success: false, code: AUTH_CODES.ADMIN_REQUIRED,
                message: 'Admin access required.'
            });
        }
        next();
    });
}

function superAdminAuthMiddleware(req, res, next) {
    authMiddleware(req, res, (err) => {
        if (err) {
            return trySendJson(res, 503, {
                success: false, code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                message: 'Authentication service temporarily unavailable.'
            });
        }
        if (!req.user?.isSuperAdmin) {
            return trySendJson(res, 403, {
                success: false, code: AUTH_CODES.SUPER_ADMIN_REQUIRED,
                message: 'Super admin privileges required.'
            });
        }
        next();
    });
}

function requirePermission(permission) {
    const { requirePermission: realRequire } = require('./adminAuth');
    return realRequire(permission);
}

module.exports = {
    authMiddleware,
    adminAuthMiddleware,
    superAdminAuthMiddleware,
    requirePermission,
    AUTH_CODES,
    evaluateAccountAccess,
    withRetry,
    trySendJson
};