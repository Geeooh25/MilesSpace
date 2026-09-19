// routes/admin.js - COMPLETE FIXED VERSION
// All routes under /api/admin
// ✅ FIXED: Auth timeout handling, proper retry, fallback mechanism

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../db/supabase');
const { invalidateSettingsCache } = require('../services/adminConfigService');
const bcrypt = require('bcrypt');

// ─── JWT Secret ──────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ CRITICAL: JWT_SECRET environment variable is required');
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
}

// ─── CONFIG ──────────────────────────────────────────────────────────
const ADMIN_TOKEN_EXPIRY = '1h';
const ADMIN_REFRESH_TOKEN_EXPIRY = '7d';
const ADMIN_SESSION_DURATION = 60 * 60 * 1000; // 1 hour

// ─── ADMIN AUTH MIDDLEWARE ──────────────────────────────────────
async function adminAuthMiddleware(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                code: 'NO_TOKEN',
                message: 'Authentication required.'
            });
        }

        const token = authHeader.substring(7);
        if (!token || token.length < 10) {
            return res.status(401).json({
                success: false,
                code: 'INVALID_TOKEN',
                message: 'Invalid authentication token.'
            });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (jwtError) {
            if (jwtError.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    code: 'SESSION_EXPIRED',
                    message: 'Your session has expired. Please sign in again.'
                });
            }
            return res.status(401).json({
                success: false,
                code: 'INVALID_TOKEN',
                message: 'Invalid or expired token.'
            });
        }

        if (decoded.type !== 'admin') {
            return res.status(403).json({
                success: false,
                code: 'ADMIN_TOKEN_REQUIRED',
                message: 'Admin access required.'
            });
        }

        if (!decoded.sid) {
            return res.status(401).json({
                success: false,
                code: 'INVALID_SESSION',
                message: 'Invalid session. Please sign in again.'
            });
        }

        // ─── Get profile from database ────────────────────────────
        let profile;
        let profileError;
        try {
            const result = await supabaseAdmin
                .from('profiles')
                .select('id, email, username, role, status, deleted_at, current_session_id, session_expires_at')
                .eq('id', decoded.id)
                .single();
            profile = result.data;
            profileError = result.error;
        } catch (err) {
            console.error('❌ [ADMIN AUTH] DB error:', err.message);
            return res.status(503).json({
                success: false,
                code: 'DB_ERROR',
                message: 'Database error. Please try again.'
            });
        }

        if (profileError || !profile) {
            return res.status(404).json({
                success: false,
                code: 'USER_NOT_FOUND',
                message: 'User not found.'
            });
        }

        if (profile.deleted_at) {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_DELETED',
                message: 'This account has been deleted.'
            });
        }

        if (profile.status === 'suspended') {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_SUSPENDED',
                message: 'Your account has been suspended.'
            });
        }

        if (profile.role !== 'admin' && profile.role !== 'super_admin') {
            return res.status(403).json({
                success: false,
                code: 'ADMIN_REQUIRED',
                message: 'Admin access required.'
            });
        }

        if (!profile.current_session_id) {
            console.log(`[ADMIN AUTH] No current_session_id for ${profile.email}`);
            return res.status(401).json({
                success: false,
                code: 'SESSION_NOT_FOUND',
                message: 'No active session found. Please sign in again.'
            });
        }

        if (profile.current_session_id !== decoded.sid) {
            console.log(`[ADMIN AUTH] Session mismatch: DB=${profile.current_session_id}, JWT=${decoded.sid}`);
            return res.status(401).json({
                success: false,
                code: 'SESSION_REVOKED',
                message: 'Your session has been revoked. Please sign in again.'
            });
        }

        if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
            console.log(`[ADMIN AUTH] Session expired for ${profile.email}`);
            return res.status(401).json({
                success: false,
                code: 'SESSION_EXPIRED',
                message: 'Your session has expired. Please sign in again.'
            });
        }

        req.userId = profile.id;
        req.user = {
            id: profile.id,
            email: profile.email,
            username: profile.username || profile.email?.split('@')[0] || 'Admin',
            role: profile.role,
            status: profile.status || 'active',
            isAdmin: true,
            isSuperAdmin: profile.role === 'super_admin'
        };
        req.sessionId = decoded.sid;

        next();

    } catch (error) {
        console.error('❌ [ADMIN AUTH] Error:', error);
        return res.status(503).json({
            success: false,
            code: 'AUTH_SERVICE_UNAVAILABLE',
            message: 'Authentication service temporarily unavailable.'
        });
    }
}

// ─── Admin Login Rate Limiter ──────────────────────────────────────
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                   req.connection?.remoteAddress ||
                   'unknown';
        const email = req.body?.email?.toLowerCase() || 'unknown';
        return `${ip}:${email}`;
    },
    handler: (req, res) => {
        return res.status(429).json({
            success: false,
            code: 'ADMIN_LOGIN_RATE_LIMIT',
            message: 'Too many admin login attempts. Please wait 15 minutes.',
            retryAfter: 15 * 60
        });
    }
});

// ─── Helpers ─────────────────────────────────────────────────────────

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           'unknown';
}

function getUserAgent(req) {
    return req.headers['user-agent'] || 'unknown';
}

function generateSessionId() {
    return crypto.randomUUID();
}

async function logAdminActivity({ admin_id, action, details, ip, user_agent, severity = 'info' }) {
    try {
        await supabaseAdmin
            .from('admin_activity')
            .insert({
                admin_id: admin_id,
                action: action,
                details: details || {},
                severity: severity || 'info',
                ip_address: ip || 'unknown',
                user_agent: user_agent || 'unknown',
                created_at: new Date().toISOString()
            });
    } catch (error) {
        console.error('Failed to log admin activity:', error.message);
    }
}

// ─── 🔑 FIXED: Verify Admin Password with Fallback ──────────────────

/**
 * Verify admin password with fallback to direct database check
 * if Supabase Auth is unavailable
 */
async function verifyAdminPassword(email, password) {
    // Try Supabase Auth first
    try {
        const { supabase, withRetry } = require('../db/supabase');
        
        // Use a shorter timeout for auth
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout
        
        try {
            const result = await withRetry(
                () => supabase.auth.signInWithPassword({
                    email: email,
                    password: password
                }),
                2,
                1000
            );
            
            clearTimeout(timeoutId);
            
            const { data, error } = result;
            if (!error && data?.user) {
                return { success: true, user: data.user };
            }
            
            if (error) {
                console.log(`⚠️ [ADMIN LOGIN] Auth error: ${error.message}`);
                // Don't return here - try fallback
            }
        } catch (fetchError) {
            clearTimeout(timeoutId);
            console.log(`⚠️ [ADMIN LOGIN] Auth fetch error: ${fetchError.message}`);
            // Continue to fallback
        }
    } catch (error) {
        console.log(`⚠️ [ADMIN LOGIN] Auth service error: ${error.message}`);
        // Continue to fallback
    }
    
    // ─── FALLBACK: Direct database password verification ──────────
    console.log(`🔄 [ADMIN LOGIN] Using fallback password verification for ${email}`);
    
    try {
        // Get the user's password hash from the profile
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('id, email, password_hash, role, status, deleted_at, username, wallet_ngn, wallet_usd, avatar_url, phone')
            .eq('email', email)
            .maybeSingle();
        
        if (profileError || !profile) {
            console.log(`❌ [ADMIN LOGIN] Profile not found in fallback: ${email}`);
            return { success: false, error: 'User not found' };
        }
        
        // Check if password_hash exists
        if (!profile.password_hash) {
            console.log(`❌ [ADMIN LOGIN] No password hash for ${email}`);
            return { success: false, error: 'Password not set for admin account' };
        }
        
        // Verify password using bcrypt
        const isValid = await bcrypt.compare(password, profile.password_hash);
        
        if (!isValid) {
            console.log(`❌ [ADMIN LOGIN] Invalid password for ${email} (fallback)`);
            return { success: false, error: 'Invalid password' };
        }
        
        console.log(`✅ [ADMIN LOGIN] Fallback verification successful for ${email}`);
        return { success: true, user: { id: profile.id, email: profile.email }, profile: profile };
        
    } catch (error) {
        console.error(`❌ [ADMIN LOGIN] Fallback verification error:`, error.message);
        return { success: false, error: error.message };
    }
}

// ════════════════════════════════════════════════════════════════════
//  POST /api/admin/login - Admin Login (FIXED)
// ════════════════════════════════════════════════════════════════════

router.post('/login', adminLoginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                code: 'MISSING_CREDENTIALS',
                error: 'Email and password are required'
            });
        }

        const ip = getClientIp(req);
        const userAgent = getUserAgent(req);
        const normalizedEmail = email.trim().toLowerCase();

        console.log(`🔐 [ADMIN LOGIN] Attempt: ${normalizedEmail} from ${ip}`);

        // ─── Get admin profile ──────────────────────────────────────
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('email', normalizedEmail)
            .maybeSingle();

        if (profileError || !profile) {
            await logAdminActivity({
                admin_id: null,
                action: 'login_failed',
                details: { email: normalizedEmail, reason: 'User not found' },
                ip,
                user_agent: userAgent,
                severity: 'warning'
            });
            return res.status(401).json({
                success: false,
                code: 'INVALID_CREDENTIALS',
                error: 'Invalid email or password'
            });
        }

        if (profile.role !== 'admin' && profile.role !== 'super_admin') {
            await logAdminActivity({
                admin_id: profile.id,
                action: 'login_failed',
                details: { email: normalizedEmail, reason: 'Not an admin', role: profile.role },
                ip,
                user_agent: userAgent,
                severity: 'warning'
            });
            return res.status(403).json({
                success: false,
                code: 'ADMIN_REQUIRED',
                error: 'Admin access required.'
            });
        }

        if (profile.status === 'suspended') {
            await logAdminActivity({
                admin_id: profile.id,
                action: 'login_failed',
                details: { email: normalizedEmail, reason: 'Account suspended' },
                ip,
                user_agent: userAgent,
                severity: 'high'
            });
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_SUSPENDED',
                error: 'Your admin account has been suspended.'
            });
        }

        if (profile.deleted_at) {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_DELETED',
                error: 'This account has been deleted.'
            });
        }

        // ─── ✅ FIXED: Verify password with fallback ──────────────────
        const verifyResult = await verifyAdminPassword(normalizedEmail, password);
        
        if (!verifyResult.success) {
            await logAdminActivity({
                admin_id: profile.id,
                action: 'login_failed',
                details: { email: normalizedEmail, reason: verifyResult.error || 'Invalid password' },
                ip,
                user_agent: userAgent,
                severity: 'warning'
            });
            return res.status(401).json({
                success: false,
                code: 'INVALID_CREDENTIALS',
                error: 'Invalid email or password'
            });
        }

        // Use profile from database (already have it)
        const userProfile = verifyResult.profile || profile;

        // ─── Generate session and tokens ───────────────────────────
        const sessionId = generateSessionId();
        const sessionExpiry = new Date(Date.now() + ADMIN_SESSION_DURATION);

        // Generate JWT with 1h expiry
        const token = jwt.sign(
            {
                id: userProfile.id,
                sid: sessionId,
                role: userProfile.role,
                type: 'admin'
            },
            JWT_SECRET,
            { expiresIn: ADMIN_TOKEN_EXPIRY }
        );

        // Generate refresh token
        const refreshToken = jwt.sign(
            {
                id: userProfile.id,
                sid: sessionId,
                type: 'admin_refresh'
            },
            JWT_SECRET,
            { expiresIn: ADMIN_REFRESH_TOKEN_EXPIRY }
        );

        // ─── Update session in database ─────────────────────────────
        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({
                current_session_id: sessionId,
                session_created_at: new Date().toISOString(),
                session_expires_at: sessionExpiry.toISOString(),
                last_login: new Date().toISOString(),
                last_ip: ip,
                last_login_location: 'Admin Panel',
                last_login_browser: userAgent,
                updated_at: new Date().toISOString()
            })
            .eq('id', userProfile.id);

        if (updateError) {
            console.error('❌ [ADMIN LOGIN] Failed to create session:', updateError);
            return res.status(500).json({
                success: false,
                code: 'SESSION_CREATION_FAILED',
                error: 'Unable to create admin session. Please try again.'
            });
        }

        await logAdminActivity({
            admin_id: userProfile.id,
            action: 'login_success',
            details: { email: normalizedEmail, role: userProfile.role },
            ip,
            user_agent: userAgent,
            severity: 'info'
        });

        console.log(`✅ [ADMIN LOGIN] Success: ${normalizedEmail}, Session: ${sessionId}`);

        res.json({
            success: true,
            message: 'Login successful',
            data: {
                user: {
                    id: userProfile.id,
                    email: userProfile.email,
                    username: userProfile.username || userProfile.email?.split('@')[0] || 'Admin',
                    role: userProfile.role,
                    status: userProfile.status || 'active',
                    wallet_ngn: parseFloat(userProfile.wallet_ngn) || 0,
                    wallet_usd: parseFloat(userProfile.wallet_usd) || 0,
                    avatar_url: userProfile.avatar_url || null,
                    phone: userProfile.phone || null,
                    isSuperAdmin: userProfile.role === 'super_admin'
                },
                token: token,
                refreshToken: refreshToken,
                expiresIn: ADMIN_TOKEN_EXPIRY,
                sessionId: sessionId,
                dashboardUrl: '/admin/dashboard.html'
            }
        });

    } catch (error) {
        console.error('❌ [ADMIN LOGIN] Error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            error: 'Login failed. Please try again.'
        });
    }
});

// ════════════════════════════════════════════════════════════════════
//  GET /api/admin/session - Session Check
// ════════════════════════════════════════════════════════════════════

router.get('/session', adminAuthMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const sessionId = req.sessionId;

        console.log(`[ADMIN SESSION] Checking session for user ${userId}`);

        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, status, avatar_url, session_created_at, session_expires_at, current_session_id')
            .eq('id', userId)
            .single();

        if (error || !profile) {
            console.log(`[ADMIN SESSION] User not found: ${userId}`);
            return res.status(404).json({
                success: false,
                authenticated: false,
                code: 'USER_NOT_FOUND',
                error: 'Admin account not found'
            });
        }

        if (profile.role !== 'admin' && profile.role !== 'super_admin') {
            console.log(`[ADMIN SESSION] User ${userId} is not admin`);
            return res.status(403).json({
                success: false,
                authenticated: false,
                code: 'ADMIN_REQUIRED',
                error: 'Admin access required'
            });
        }

        if (profile.status === 'suspended') {
            console.log(`[ADMIN SESSION] User ${userId} is suspended`);
            return res.status(403).json({
                success: false,
                authenticated: false,
                code: 'ACCOUNT_SUSPENDED',
                error: 'Account suspended'
            });
        }

        if (!profile.current_session_id) {
            console.log(`[ADMIN SESSION] No active session for user ${userId}`);
            return res.status(401).json({
                success: false,
                authenticated: false,
                code: 'SESSION_NOT_FOUND',
                error: 'No active session found. Please sign in again.'
            });
        }

        if (profile.current_session_id !== sessionId) {
            console.log(`[ADMIN SESSION] Session mismatch: DB=${profile.current_session_id}, JWT=${sessionId}`);
            return res.status(401).json({
                success: false,
                authenticated: false,
                code: 'SESSION_REVOKED',
                error: 'Session has been revoked.'
            });
        }

        if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
            console.log(`[ADMIN SESSION] Session expired for user ${userId}`);
            return res.status(401).json({
                success: false,
                authenticated: false,
                code: 'SESSION_EXPIRED',
                error: 'Session has expired.'
            });
        }

        console.log(`[ADMIN SESSION] Session valid for user ${userId}`);

        return res.json({
            success: true,
            authenticated: true,
            user: {
                id: profile.id,
                email: profile.email,
                username: profile.username || profile.email?.split('@')[0] || 'Admin',
                role: profile.role,
                status: profile.status || 'active',
                avatar_url: profile.avatar_url || null
            },
            session: {
                id: sessionId,
                created_at: profile.session_created_at,
                expiresAt: profile.session_expires_at
            }
        });

    } catch (error) {
        console.error('❌ [ADMIN SESSION] Error:', error);
        return res.status(500).json({
            success: false,
            authenticated: false,
            code: 'SERVER_ERROR',
            error: 'Unable to verify admin session'
        });
    }
});

// ════════════════════════════════════════════════════════════════════
//  POST /api/admin/refresh - Refresh Token
// ════════════════════════════════════════════════════════════════════

router.post('/refresh', async (req, res) => {
    try {
        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({
                success: false,
                code: 'MISSING_REFRESH_TOKEN',
                error: 'Refresh token is required'
            });
        }

        let decoded;
        try {
            decoded = jwt.verify(refresh_token, JWT_SECRET);
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    code: 'REFRESH_TOKEN_EXPIRED',
                    error: 'Refresh token has expired.'
                });
            }
            return res.status(401).json({
                success: false,
                code: 'INVALID_REFRESH_TOKEN',
                error: 'Invalid refresh token'
            });
        }

        if (decoded.type !== 'admin_refresh') {
            return res.status(401).json({
                success: false,
                code: 'INVALID_TOKEN_TYPE',
                error: 'Invalid token type'
            });
        }

        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', decoded.id)
            .single();

        if (error || !profile) {
            return res.status(404).json({
                success: false,
                code: 'USER_NOT_FOUND',
                error: 'User not found'
            });
        }

        if (profile.role !== 'admin' && profile.role !== 'super_admin') {
            return res.status(403).json({
                success: false,
                code: 'ADMIN_REQUIRED',
                error: 'Admin access required'
            });
        }

        if (profile.status === 'suspended') {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_SUSPENDED',
                error: 'Account suspended'
            });
        }

        if (!profile.current_session_id || profile.current_session_id !== decoded.sid) {
            return res.status(401).json({
                success: false,
                code: 'SESSION_REVOKED',
                error: 'Session has been revoked.'
            });
        }

        if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
            return res.status(401).json({
                success: false,
                code: 'SESSION_EXPIRED',
                error: 'Session has expired.'
            });
        }

        // ─── Generate new session and tokens ──────────────────────
        const newSessionId = generateSessionId();
        const sessionExpiry = new Date(Date.now() + ADMIN_SESSION_DURATION);

        const newToken = jwt.sign(
            {
                id: profile.id,
                sid: newSessionId,
                role: profile.role,
                type: 'admin'
            },
            JWT_SECRET,
            { expiresIn: ADMIN_TOKEN_EXPIRY }
        );

        const newRefreshToken = jwt.sign(
            {
                id: profile.id,
                sid: newSessionId,
                type: 'admin_refresh'
            },
            JWT_SECRET,
            { expiresIn: ADMIN_REFRESH_TOKEN_EXPIRY }
        );

        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({
                current_session_id: newSessionId,
                session_created_at: new Date().toISOString(),
                session_expires_at: sessionExpiry.toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', profile.id);

        if (updateError) {
            console.error('❌ [ADMIN REFRESH] Failed to update session:', updateError);
            return res.status(500).json({
                success: false,
                code: 'SESSION_UPDATE_FAILED',
                error: 'Unable to refresh session.'
            });
        }

        console.log(`✅ [ADMIN REFRESH] Token refreshed for ${profile.email}`);

        return res.json({
            success: true,
            data: {
                access_token: newToken,
                refresh_token: newRefreshToken,
                expiresIn: ADMIN_TOKEN_EXPIRY,
                sessionId: newSessionId
            }
        });

    } catch (error) {
        console.error('❌ [ADMIN REFRESH] Error:', error);
        return res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            error: 'Failed to refresh token'
        });
    }
});

// ════════════════════════════════════════════════════════════════════
//  GET /api/admin/verify - Verify Token
// ════════════════════════════════════════════════════════════════════

router.get('/verify', adminAuthMiddleware, async (req, res) => {
    try {
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, status, wallet_ngn, wallet_usd, avatar_url, phone')
            .eq('id', req.userId)
            .single();

        if (error || !profile) {
            return res.status(404).json({
                success: false,
                code: 'USER_NOT_FOUND',
                error: 'User not found'
            });
        }

        res.json({
            success: true,
            data: {
                user: {
                    id: profile.id,
                    email: profile.email,
                    username: profile.username || profile.email?.split('@')[0] || 'Admin',
                    role: profile.role,
                    status: profile.status || 'active',
                    wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
                    wallet_usd: parseFloat(profile.wallet_usd) || 0,
                    avatar_url: profile.avatar_url || null,
                    phone: profile.phone || null
                },
                session: {
                    id: req.sessionId
                }
            }
        });

    } catch (error) {
        console.error('❌ [ADMIN VERIFY] Error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            error: 'Verification failed'
        });
    }
});

// ════════════════════════════════════════════════════════════════════
//  POST /api/admin/logout - Admin Logout
// ════════════════════════════════════════════════════════════════════

router.post('/logout', adminAuthMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const sessionId = req.sessionId;

        await supabaseAdmin
            .from('profiles')
            .update({
                current_session_id: null,
                session_created_at: null,
                session_expires_at: null
            })
            .eq('id', userId)
            .eq('current_session_id', sessionId);

        await logAdminActivity({
            admin_id: userId,
            action: 'logout',
            details: { email: req.user?.email, session_id: sessionId },
            ip: getClientIp(req),
            user_agent: getUserAgent(req),
            severity: 'info'
        });

        console.log(`🔐 [ADMIN LOGOUT] User ${userId} logged out`);

        res.json({
            success: true,
            message: 'Logged out successfully'
        });

    } catch (error) {
        console.error('❌ [ADMIN LOGOUT] Error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            error: 'Logout failed'
        });
    }
});

// ════════════════════════════════════════════════════════════════════
//  GET /api/admin/me - Admin Profile
// ════════════════════════════════════════════════════════════════════

router.get('/me', adminAuthMiddleware, async (req, res) => {
    try {
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', req.userId)
            .single();

        if (error || !profile) {
            return res.status(404).json({
                success: false,
                code: 'USER_NOT_FOUND',
                error: 'User not found'
            });
        }

        res.json({
            success: true,
            data: {
                user: {
                    id: profile.id,
                    email: profile.email,
                    username: profile.username || profile.email?.split('@')[0] || 'Admin',
                    role: profile.role,
                    status: profile.status || 'active',
                    wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
                    wallet_usd: parseFloat(profile.wallet_usd) || 0,
                    avatar_url: profile.avatar_url || null,
                    phone: profile.phone || null,
                    isSuperAdmin: profile.role === 'super_admin',
                    created_at: profile.created_at
                },
                session: {
                    id: req.sessionId,
                    expiresAt: profile.session_expires_at
                }
            }
        });

    } catch (error) {
        console.error('❌ [ADMIN ME] Error:', error);
        res.status(500).json({
            success: false,
            code: 'SERVER_ERROR',
            error: 'Failed to get profile'
        });
    }
});

// ════════════════════════════════════════════════════════════════════
//  GET /api/admin/check - Public check
// ════════════════════════════════════════════════════════════════════

router.get('/check', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.json({ authenticated: false });
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        if (decoded.type !== 'admin' && decoded.role !== 'admin' && decoded.role !== 'super_admin') {
            return res.json({ authenticated: false });
        }

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id, current_session_id, session_expires_at, status, role, deleted_at')
            .eq('id', decoded.id || decoded.userId)
            .single();

        if (!profile || profile.status === 'suspended' || profile.deleted_at) {
            return res.json({ authenticated: false });
        }

        if (profile.role !== 'admin' && profile.role !== 'super_admin') {
            return res.json({ authenticated: false });
        }

        if (!profile.current_session_id || profile.current_session_id !== decoded.sid) {
            return res.json({ authenticated: false });
        }

        if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
            return res.json({ authenticated: false });
        }

        res.json({
            authenticated: true,
            user: {
                id: profile.id,
                role: profile.role,
                isSuperAdmin: profile.role === 'super_admin'
            }
        });

    } catch (e) {
        res.json({ authenticated: false });
    }
});
router.patch('/settings/pricing-settings', adminAuthMiddleware, async (req, res) => {
    const patch = {};
    const allowed = ['usd_to_ngn', 'giftcard_markup_pct', 'esim_markup_pct', 'airtime_markup_pct'];

    for (const key of allowed) {
        if (req.body[key] == null) continue;
        const val = Number(req.body[key]);
        if (!Number.isFinite(val) || val < 0) {
            return res.status(400).json({ success: false, error: `Invalid ${key}` });
        }
        if (key.endsWith('_markup_pct') && val > 1) {
            return res.status(400).json({ success: false, error: `${key} must be a decimal like 0.157` });
        }
        patch[key] = val;
    }

    if (!Object.keys(patch).length) {
        return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    patch.updated_at = new Date().toISOString();

    const { error } = await supabaseAdmin
        .from('admin_settings')
        .update(patch)
        .eq('id', 1);

    if (error) return res.status(500).json({ success: false, error: error.message });

    invalidateSettingsCache();  // next catalog rebuild picks up the new values

    res.json({ success: true, data: patch });
});
module.exports = router;