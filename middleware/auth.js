// middleware/auth.js - COMPLETE FIXED VERSION
// Adds retry-on-network-failure so brief Supabase outages don't return 503s.

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

// ─── Main Authentication Middleware ──────────────────────────────
async function authMiddleware(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                code: AUTH_CODES.NO_TOKEN,
                message: 'Authentication required.'
            });
        }

        const token = authHeader.substring(7);
        if (!token || token.length < 10) {
            return res.status(401).json({
                success: false,
                code: AUTH_CODES.INVALID_TOKEN,
                message: 'Invalid authentication token.'
            });
        }

        // ─── Verify JWT ────────────────────────────────────────────
        let decoded;
        try {
            decoded = jwt.verify(token, ACTIVE_JWT_SECRET);
        } catch (jwtError) {
            if (jwtError.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    code: AUTH_CODES.SESSION_EXPIRED,
                    message: 'Your session has expired. Please sign in again.'
                });
            }
            console.error('JWT verification error:', jwtError.message);
            return res.status(401).json({
                success: false,
                code: AUTH_CODES.INVALID_TOKEN,
                message: 'Invalid or expired token.'
            });
        }

        // ─── Validate session ID exists in JWT ──────────────────────
        if (!decoded.sid) {
            return res.status(401).json({
                success: false,
                code: AUTH_CODES.INVALID_SESSION,
                message: 'Invalid session. Please sign in again.'
            });
        }

        // ─── Get profile from database (with retry) ──────────────────
        const profileResult = await withRetry(() =>
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

        const profile = profileResult?.data;
        const profileError = profileResult?.error;

        // ─── Handle database errors ─────────────────────────────────
        if (profileError) {
            console.error('❌ [AUTH] Profile query failed:', profileError.message || profileError);
            return res.status(503).json({
                success: false,
                code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                message: 'Authentication service temporarily unavailable.'
            });
        }

        if (!profile) {
            console.error('❌ [AUTH] Profile not found for user:', decoded.id);
            return res.status(404).json({
                success: false,
                code: AUTH_CODES.USER_NOT_FOUND,
                message: 'User profile not found.'
            });
        }

        // ─── Check if account is deleted ─────────────────────────────
        if (profile.deleted_at) {
            return res.status(403).json({
                success: false,
                code: AUTH_CODES.ACCOUNT_DELETED,
                message: 'This account has been deleted.'
            });
        }

        // ─── Check if account is suspended ───────────────────────────
        if (profile.status === 'suspended') {
            return res.status(403).json({
                success: false,
                code: AUTH_CODES.ACCOUNT_SUSPENDED,
                message: 'Your account has been suspended.'
            });
        }

        // ─── Session validation with graceful fallback ──────────────
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

        // Session ID mismatch — check user_sessions table
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

            return res.status(401).json({
                success: false,
                code: AUTH_CODES.SESSION_REVOKED,
                message:
                    'Your session has been ended because your account was signed in on another device.'
            });
        }

        // Session expiry check
        if (profile.session_expires_at) {
            const expiryDate = new Date(profile.session_expires_at);
            if (expiryDate < new Date()) {
                return res.status(401).json({
                    success: false,
                    code: AUTH_CODES.SESSION_EXPIRED,
                    message: 'Your session has expired. Please sign in again.',
                    canRefresh: true
                });
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

        // ─── Attach user to request ──────────────────────────────────
        req.user = buildUserObject(profile, decoded);
        req.userId = profile.id;
        req.sessionId = decoded.sid;

        next();
    } catch (error) {
        console.error('❌ [AUTH] Authentication error:', error.message || error);
        return res.status(503).json({
            success: false,
            code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
            message: 'Authentication service temporarily unavailable.'
        });
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
function adminAuthMiddleware(req, res, next) {
    try {
        authMiddleware(req, res, (err) => {
            if (err) {
                console.error('❌ [ADMIN AUTH] Error:', err);
                if (!res.headersSent) {
                    return res.status(503).json({
                        success: false,
                        code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                        message: 'Authentication service temporarily unavailable.'
                    });
                }
                return;
            }

            if (!req.user || !req.user.isAdmin) {
                if (!res.headersSent) {
                    return res.status(403).json({
                        success: false,
                        code: AUTH_CODES.ADMIN_REQUIRED,
                        message:
                            'Admin access required. You do not have permission to access this resource.'
                    });
                }
                return;
            }

            next();
        });
    } catch (error) {
        console.error('❌ [ADMIN AUTH] Exception:', error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                code: 'SERVER_ERROR',
                message: 'Authentication error occurred.'
            });
        }
    }
}

// ─── Super Admin Authentication Middleware ───────────────────────
function superAdminAuthMiddleware(req, res, next) {
    try {
        authMiddleware(req, res, (err) => {
            if (err) {
                console.error('❌ [SUPER ADMIN AUTH] Error:', err);
                if (!res.headersSent) {
                    return res.status(503).json({
                        success: false,
                        code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                        message: 'Authentication service temporarily unavailable.'
                    });
                }
                return;
            }

            if (!req.user || !req.user.isSuperAdmin) {
                if (!res.headersSent) {
                    return res.status(403).json({
                        success: false,
                        code: AUTH_CODES.SUPER_ADMIN_REQUIRED,
                        message: 'Super admin privileges required.'
                    });
                }
                return;
            }

            next();
        });
    } catch (error) {
        console.error('❌ [SUPER ADMIN AUTH] Exception:', error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                code: 'SERVER_ERROR',
                message: 'Authentication error occurred.'
            });
        }
    }
}

// ─── Permission-based authorization ──────────────────────────────
function requirePermission(permission) {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                code: AUTH_CODES.NO_TOKEN,
                message: 'Authentication required.'
            });
        }

        if (req.user.isSuperAdmin) return next();
        if (req.user.isAdmin) return next();

        try {
            const { data: permissionData } = await withRetry(() =>
                supabaseAdmin
                    .from('user_permissions')
                    .select('permission')
                    .eq('user_id', req.userId)
                    .eq('permission', permission)
                    .maybeSingle()
            );

            if (permissionData) return next();

            return res.status(403).json({
                success: false,
                code: 'PERMISSION_DENIED',
                message: `Insufficient permissions for this action. Required: ${permission}`
            });
        } catch (error) {
            if (req.user.isAdmin || req.user.isSuperAdmin) return next();
            return res.status(403).json({
                success: false,
                code: 'PERMISSION_DENIED',
                message: 'Insufficient permissions for this action.'
            });
        }
    };
}

module.exports = {
    authMiddleware,
    adminAuthMiddleware,
    superAdminAuthMiddleware,
    requirePermission,
    AUTH_CODES
};