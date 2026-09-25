// middleware/auth.js
// ─────────────────────────────────────────────────────────────────
// User authentication middleware.
//
// Responsibilities:
//   - Verify the Bearer JWT (signature + expiry)
//   - Load the profile from Supabase (with retry on transient
//     network errors — so brief outages don't return 503s)
//   - Enforce deleted_at / suspended / session rules
//   - Populate req.user / req.userId / req.sessionId
//
// Resilience:
//   - Every response is written via a defensive helper that checks
//     `res.status` exists and `res.headersSent` is false. This
//     prevents the "res.status is not a function" crash when a
//     caller (e.g. middleware/adminAuth.js) passes a shim res.
//   - The final catch block falls back to next(err) if it can't
//     write a response at all, and never throws.
// ─────────────────────────────────────────────────────────────────

const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../db/supabase');

// ─── JWT Secret ──────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ CRITICAL: JWT_SECRET environment variable is required');
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    } else {
        console.warn('⚠️ Using fallback secret in development only!');
    }
}
const JWT_SECRET_FALLBACK =
    process.env.NODE_ENV === 'production' ? null : 'dev-secret-do-not-use-in-production';
const ACTIVE_JWT_SECRET = JWT_SECRET || JWT_SECRET_FALLBACK;

// ─── AUTH CODES ──────────────────────────────────────────────────
const AUTH_CODES = {
    NO_TOKEN: 'NO_TOKEN',
    UNAUTHORIZED: 'UNAUTHORIZED',
    INVALID_TOKEN: 'INVALID_TOKEN',
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    SESSION_REVOKED: 'SESSION_REVOKED',
    INVALID_SESSION: 'INVALID_SESSION',
    USER_NOT_FOUND: 'USER_NOT_FOUND',
    ACCOUNT_DELETED: 'ACCOUNT_DELETED',
    ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
    AUTH_SERVICE_UNAVAILABLE: 'AUTH_SERVICE_UNAVAILABLE',
    ADMIN_REQUIRED: 'ADMIN_REQUIRED',
    SUPER_ADMIN_REQUIRED: 'SUPER_ADMIN_REQUIRED'
};

// ─── Retry helper for transient Supabase network failures ────────
async function withRetry(fn, retries = 3, delayMs = 400) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const isNetwork =
                err?.message?.includes('fetch failed') ||
                err?.cause?.code === 'ECONNRESET' ||
                err?.cause?.code === 'ETIMEDOUT' ||
                err?.cause?.code === 'EAI_AGAIN' ||
                err?.cause?.code === 'ENOTFOUND' ||
                err?.cause?.code === 'ECONNREFUSED';

            if (!isNetwork || i === retries - 1) throw err;
            await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, i)));
        }
    }
    throw lastError;
}

// ─── Defensive response writer ───────────────────────────────────
// Writes to `res` only if it looks like a real Express response.
// Returns true if the write succeeded, false if we had to skip it
// (which happens when a caller passed a shim res, or res was already
// used). Never throws.
function trySendJson(res, status, body) {
    try {
        if (!res) return false;
        if (typeof res.status !== 'function') return false;
        if (res.headersSent) return false;
        res.status(status).json(body);
        return true;
    } catch (e) {
        console.error('[AUTH] trySendJson failed (non-fatal):', e.message);
        return false;
    }
}

// ─── Main Authentication Middleware ──────────────────────────────
async function authMiddleware(req, res, next) {
    try {
        const authHeader = req.headers?.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            trySendJson(res, 401, {
                success: false,
                code: AUTH_CODES.NO_TOKEN,
                message: 'Authentication required.'
            });
            return;
        }

        const token = authHeader.substring(7);
        if (!token || token.length < 10) {
            trySendJson(res, 401, {
                success: false,
                code: AUTH_CODES.INVALID_TOKEN,
                message: 'Invalid authentication token.'
            });
            return;
        }

        // ─── Verify JWT ────────────────────────────────────────────
        let decoded;
        try {
            decoded = jwt.verify(token, ACTIVE_JWT_SECRET);
        } catch (jwtError) {
            if (jwtError.name === 'TokenExpiredError') {
                trySendJson(res, 401, {
                    success: false,
                    code: AUTH_CODES.SESSION_EXPIRED,
                    message: 'Your session has expired. Please sign in again.'
                });
                return;
            }
            console.error('JWT verification error:', jwtError.message);
            trySendJson(res, 401, {
                success: false,
                code: AUTH_CODES.INVALID_TOKEN,
                message: 'Invalid or expired token.'
            });
            return;
        }

        // ─── Validate session ID exists in JWT ──────────────────────
        if (!decoded.sid) {
            trySendJson(res, 401, {
                success: false,
                code: AUTH_CODES.INVALID_SESSION,
                message: 'Invalid session. Please sign in again.'
            });
            return;
        }

        // ─── Get profile from database (with retry) ─────────────────
        let profileResult;
        try {
            profileResult = await withRetry(() =>
                supabaseAdmin
                    .from('profiles')
                    .select(`
                        id,
                        email,
                        username,
                        role,
                        status,
                        deleted_at,
                        wallet_ngn,
                        wallet_usd,
                        referral_code,
                        is_verified,
                        transaction_pin_hash,
                        current_session_id,
                        session_created_at,
                        session_expires_at,
                        avatar_url,
                        phone
                    `)
                    .eq('id', decoded.id)
                    .single()
            );
        } catch (dbError) {
            // Network exhaustion after retries — 503, never crash.
            console.error('❌ [AUTH] Profile query failed:', dbError.message || dbError);
            trySendJson(res, 503, {
                success: false,
                code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                message: 'Authentication service temporarily unavailable.'
            });
            return;
        }

        const profile = profileResult?.data;
        const profileError = profileResult?.error;

        if (profileError) {
            console.error('❌ [AUTH] Profile query error:', profileError.message || profileError);
            trySendJson(res, 503, {
                success: false,
                code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                message: 'Authentication service temporarily unavailable.'
            });
            return;
        }

        if (!profile) {
            console.error('❌ [AUTH] Profile not found for user:', decoded.id);
            trySendJson(res, 404, {
                success: false,
                code: AUTH_CODES.USER_NOT_FOUND,
                message: 'User profile not found.'
            });
            return;
        }

        // ─── Account state checks ──────────────────────────────────
        if (profile.deleted_at) {
            trySendJson(res, 403, {
                success: false,
                code: AUTH_CODES.ACCOUNT_DELETED,
                message: 'This account has been deleted.'
            });
            return;
        }

        if (profile.status === 'suspended') {
            trySendJson(res, 403, {
                success: false,
                code: AUTH_CODES.ACCOUNT_SUSPENDED,
                message: 'Your account has been suspended.'
            });
            return;
        }

        // ─── Session validation with graceful fallback ─────────────
        if (!profile.current_session_id) {
            console.log(`⚠️ [AUTH] User ${decoded.id} has no current_session_id, fixing…`);
            try {
                await withRetry(() =>
                    supabaseAdmin
                        .from('profiles')
                        .update({
                            current_session_id: decoded.sid,
                            session_created_at: new Date().toISOString(),
                            session_expires_at: new Date(
                                Date.now() + 8 * 60 * 60 * 1000
                            ).toISOString()
                        })
                        .eq('id', decoded.id)
                );
            } catch (e) {
                console.warn('⚠️ [AUTH] Failed to fix session record (non-fatal):', e.message);
            }

            req.user = buildUserObject(profile, decoded);
            req.userId = profile.id;
            req.sessionId = decoded.sid;
            return next();
        }

        // ─── Session ID mismatch ───────────────────────────────────
        if (profile.current_session_id !== decoded.sid) {
            console.log(
                `🔐 [SESSION] Session mismatch for user ${decoded.id}: JWT=${decoded.sid}, DB=${profile.current_session_id}`
            );

            let sessionData = null;
            try {
                const sessionResult = await withRetry(() =>
                    supabaseAdmin
                        .from('user_sessions')
                        .select('is_active, expires_at')
                        .eq('user_id', decoded.id)
                        .eq('session_id', decoded.sid)
                        .maybeSingle()
                );
                sessionData = sessionResult?.data;
            } catch (e) {
                console.warn('⚠️ [AUTH] user_sessions lookup failed:', e.message);
            }

            if (sessionData && sessionData.is_active !== false) {
                console.log(
                    `🔄 [SESSION] Session ${decoded.sid} is still active, re-syncing profile…`
                );
                try {
                    await withRetry(() =>
                        supabaseAdmin
                            .from('profiles')
                            .update({
                                current_session_id: decoded.sid,
                                session_created_at: new Date().toISOString(),
                                session_expires_at:
                                    sessionData.expires_at ||
                                    new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
                            })
                            .eq('id', decoded.id)
                    );
                } catch (e) {
                    console.warn('⚠️ [AUTH] Re-sync failed (non-fatal):', e.message);
                }

                req.user = buildUserObject(profile, decoded);
                req.userId = profile.id;
                req.sessionId = decoded.sid;
                return next();
            }

            trySendJson(res, 401, {
                success: false,
                code: AUTH_CODES.SESSION_REVOKED,
                message:
                    'Your session has been ended because your account was signed in on another device.'
            });
            return;
        }

        // ─── Session expiry check ──────────────────────────────────
        if (profile.session_expires_at) {
            const expiryDate = new Date(profile.session_expires_at);
            if (expiryDate < new Date()) {
                trySendJson(res, 401, {
                    success: false,
                    code: AUTH_CODES.SESSION_EXPIRED,
                    message: 'Your session has expired. Please sign in again.',
                    canRefresh: true
                });
                return;
            }
        } else {
            console.log(`⚠️ [AUTH] User ${decoded.id} has no session_expires_at, setting default…`);
            const defaultExpiry = new Date(Date.now() + 8 * 60 * 60 * 1000);
            try {
                await withRetry(() =>
                    supabaseAdmin
                        .from('profiles')
                        .update({ session_expires_at: defaultExpiry.toISOString() })
                        .eq('id', decoded.id)
                );
            } catch (e) {
                console.warn('⚠️ [AUTH] Failed to set default expiry (non-fatal):', e.message);
            }
        }

        // ─── Attach user to request ────────────────────────────────
        req.user = buildUserObject(profile, decoded);
        req.userId = profile.id;
        req.sessionId = decoded.sid;

        return next();
    } catch (error) {
        // Last-resort catch. Never throws.
        console.error('❌ [AUTH] Authentication error:', error.message || error);

        const wrote = trySendJson(res, 503, {
            success: false,
            code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
            message: 'Authentication service temporarily unavailable.'
        });

        if (!wrote && typeof next === 'function') {
            // Couldn't write to res — let Express' error handler
            // take over. This is the case where a shim res was passed.
            return next(error);
        }
        return;
    }
}

// ─── Build user object helper ─────────────────────────────────────
function buildUserObject(profile, decoded) {
    return {
        id: profile.id,
        email: profile.email,
        username: profile.username || profile.email?.split('@')[0] || 'User',
        role: profile.role || 'user',
        isAdmin: profile.role === 'admin' || profile.role === 'super_admin',
        isSuperAdmin: profile.role === 'super_admin',
        status: profile.status || 'active',
        wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
        wallet_usd: parseFloat(profile.wallet_usd) || 0,
        referral_code: profile.referral_code || '',
        is_verified: profile.is_verified || false,
        has_transaction_pin: !!profile.transaction_pin_hash,
        session_id: decoded.sid,
        avatar_url: profile.avatar_url || null,
        phone: profile.phone || null
    };
}

// ─── Admin Authentication Middleware ─────────────────────────────
// Legacy helper kept for backwards compatibility. New code should
// use `adminAuth` / `requirePermission` from ./adminAuth.js.
function adminAuthMiddleware(req, res, next) {
    try {
        authMiddleware(req, res, (err) => {
            if (err) {
                console.error('❌ [ADMIN AUTH] Error:', err);
                trySendJson(res, 503, {
                    success: false,
                    code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                    message: 'Authentication service temporarily unavailable.'
                });
                return;
            }

            if (!req.user || !req.user.isAdmin) {
                trySendJson(res, 403, {
                    success: false,
                    code: AUTH_CODES.ADMIN_REQUIRED,
                    message:
                        'Admin access required. You do not have permission to access this resource.'
                });
                return;
            }

            next();
        });
    } catch (error) {
        console.error('❌ [ADMIN AUTH] Exception:', error);
        const wrote = trySendJson(res, 500, {
            success: false,
            code: 'SERVER_ERROR',
            message: 'Authentication error occurred.'
        });
        if (!wrote && typeof next === 'function') return next(error);
    }
}

// ─── Super Admin Authentication Middleware ───────────────────────
// Legacy helper kept for backwards compatibility.
function superAdminAuthMiddleware(req, res, next) {
    try {
        authMiddleware(req, res, (err) => {
            if (err) {
                console.error('❌ [SUPER ADMIN AUTH] Error:', err);
                trySendJson(res, 503, {
                    success: false,
                    code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                    message: 'Authentication service temporarily unavailable.'
                });
                return;
            }

            if (!req.user || !req.user.isSuperAdmin) {
                trySendJson(res, 403, {
                    success: false,
                    code: AUTH_CODES.SUPER_ADMIN_REQUIRED,
                    message: 'Super admin privileges required.'
                });
                return;
            }

            next();
        });
    } catch (error) {
        console.error('❌ [SUPER ADMIN AUTH] Exception:', error);
        const wrote = trySendJson(res, 500, {
            success: false,
            code: 'SERVER_ERROR',
            message: 'Authentication error occurred.'
        });
        if (!wrote && typeof next === 'function') return next(error);
    }
}

// ─── Permission-based authorization ──────────────────────────────
// Delegates to adminAuth.js so permission resolution is identical.
// Kept here for backwards compatibility with routes that still
// import requirePermission from this file.
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
    withRetry,
    buildUserObject,
    trySendJson
};