// middleware/auth.js - COMPLETE FIXED VERSION
// Uses YOUR OWN JWT verification - NO Supabase Auth calls
// Enforces single session per user via current_session_id

const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../db/supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// ─── AUTH CODES ──────────────────────────────────────────────
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
    AUTH_SERVICE_UNAVAILABLE: 'AUTH_SERVICE_UNAVAILABLE'
};

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

        // ─── VERIFY JWT WITH YOUR OWN SECRET ───
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
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

        // ─── Validate session ID exists in JWT ──────────────────
        if (!decoded.sid) {
            return res.status(401).json({
                success: false,
                code: AUTH_CODES.INVALID_SESSION,
                message: 'Invalid session. Please sign in again.'
            });
        }

        // ─── Get profile from database with session info ─────────
        const { data: profile, error: profileError } = await supabaseAdmin
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
                session_expires_at
            `)
            .eq('id', decoded.id)
            .single();

        if (profileError || !profile) {
            console.error('❌ [AUTH] Profile not found for user:', decoded.id);
            return res.status(404).json({
                success: false,
                code: AUTH_CODES.USER_NOT_FOUND,
                message: 'User profile not found.'
            });
        }

        if (profile.deleted_at) {
            return res.status(403).json({
                success: false,
                code: AUTH_CODES.ACCOUNT_DELETED,
                message: 'This account has been deleted.'
            });
        }

        if (profile.status === 'suspended') {
            return res.status(403).json({
                success: false,
                code: AUTH_CODES.ACCOUNT_SUSPENDED,
                message: 'Your account has been suspended.'
            });
        }

        // ─── ENFORCE SINGLE SESSION ──────────────────────────────
        // Check if the session ID in the JWT matches the current session in the database
        if (!profile.current_session_id || profile.current_session_id !== decoded.sid) {
            console.log(`🔐 [SESSION REVOKED] User ${decoded.id}: JWT sid ${decoded.sid}, DB sid ${profile.current_session_id}`);
            return res.status(401).json({
                success: false,
                code: AUTH_CODES.SESSION_REVOKED,
                message: 'Your session has been ended because your account was signed in on another device.'
            });
        }

        // ─── Check if session has expired ─────────────────────────
        if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
            return res.status(401).json({
                success: false,
                code: AUTH_CODES.SESSION_EXPIRED,
                message: 'Your session has expired. Please sign in again.'
            });
        }

        // ─── Attach user to request ──────────────────────────────
        req.user = {
            id: profile.id,
            email: profile.email,
            username: profile.username,
            role: profile.role || 'user',
            isAdmin: profile.role === 'admin' || profile.role === 'super_admin',
            isSuperAdmin: profile.role === 'super_admin',
            status: profile.status || 'active',
            wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
            wallet_usd: parseFloat(profile.wallet_usd) || 0,
            referral_code: profile.referral_code || '',
            is_verified: profile.is_verified || false,
            has_transaction_pin: !!profile.transaction_pin_hash,
            session_id: decoded.sid
        };

        req.userId = profile.id;

        next();

    } catch (error) {
        console.error('❌ [AUTH] Authentication error:', error);
        return res.status(503).json({
            success: false,
            code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
            message: 'Authentication service temporarily unavailable.'
        });
    }
}

async function adminAuthMiddleware(req, res, next) {
    try {
        // Call authMiddleware first
        await new Promise((resolve, reject) => {
            authMiddleware(req, res, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        if (!req.user || !req.user.isAdmin) {
            return res.status(403).json({
                success: false,
                code: 'ADMIN_REQUIRED',
                message: 'Admin access required.'
            });
        }

        next();

    } catch (error) {
        console.error('❌ [ADMIN AUTH] Error:', error);
        if (!res.headersSent) {
            return res.status(503).json({
                success: false,
                code: AUTH_CODES.AUTH_SERVICE_UNAVAILABLE,
                message: 'Authentication service temporarily unavailable.'
            });
        }
    }
}
// =============================================
// FILE: middleware/auth.js - ADD DEBUG LOGGING
// =============================================

// Add this to the authMiddleware function right after decoding the token:

console.log(`🔐 [AUTH DEBUG] Request: ${req.method} ${req.path}`);
console.log(`🔐 [AUTH DEBUG] JWT decoded:`, { id: decoded.id, sid: decoded.sid });
console.log(`🔐 [AUTH DEBUG] JWT exp: ${new Date(decoded.exp * 1000).toISOString()}`);

// Then after getting profile:
console.log(`🔐 [AUTH DEBUG] Profile current_session_id: ${profile.current_session_id}`);
console.log(`🔐 [AUTH DEBUG] JWT sid: ${decoded.sid}`);
console.log(`🔐 [AUTH DEBUG] Match: ${profile.current_session_id === decoded.sid}`);

module.exports = { authMiddleware, adminAuthMiddleware, AUTH_CODES };