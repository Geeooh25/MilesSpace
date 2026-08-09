// ─── middleware/auth.js ───
// User Authentication Middleware with Timeout Handling
// FIXED: Returns 401 with proper codes instead of 503 on timeout
// Prevents automatic logout on network issues

const jwt = require('jsonwebtoken');
const { supabase, supabaseAdmin } = require('../db/supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'miles-exchange-secret-key-2024';

// ─── Helper: Verify token with timeout ───
async function verifyTokenWithTimeout(token, timeoutMs = 12000) {
    try {
        const result = await Promise.race([
            supabase.auth.getUser(token),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Token verification timeout')), timeoutMs)
            )
        ]);
        return result;
    } catch (error) {
        throw error;
    }
}

/**
 * User Authentication Middleware
 * Verifies Supabase token first, falls back to custom admin JWT.
 * ✅ ALLOWS both users AND admins (but flags if admin)
 */
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'No token provided',
        code: 'NO_TOKEN'
      });
    }

    const token = authHeader.split(' ')[1];

    let user, error;
    let isTimeout = false;

    try {
        const result = await verifyTokenWithTimeout(token, 12000);
        user = result.data?.user;
        error = result.error;
    } catch (timeoutError) {
        console.warn('⚠️ Token verification timeout for user request');
        isTimeout = true;
        // ─── FIXED: Return 401 with specific code instead of 503 ───
        // This tells the frontend "try again" not "logout"
        return res.status(401).json({
          success: false,
          error: 'Authentication service temporarily unavailable. Please try again.',
          code: 'AUTH_SERVICE_UNAVAILABLE'
        });
    }

    let profile, userId, resolvedUser;

    if (!error && user) {
      // ─── Path A: valid Supabase token ───
      const { data: p, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      if (profileError || !p) {
        return res.status(404).json({ 
          success: false, 
          error: 'User profile not found',
          code: 'PROFILE_NOT_FOUND'
        });
      }
      profile = p;
      userId = user.id;
      resolvedUser = user;
    } else {
      // ─── Path B: fallback — custom JWT (issued by /api/admin/login) ───
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const { data: p, error: profileError } = await supabaseAdmin
          .from('profiles')
          .select('*')
          .eq('id', decoded.userId)
          .single();

        if (profileError || !p) {
          return res.status(404).json({ 
            success: false, 
            error: 'User profile not found',
            code: 'PROFILE_NOT_FOUND'
          });
        }
        profile = p;
        userId = decoded.userId;
        resolvedUser = { id: decoded.userId, email: decoded.email };
      } catch (jwtErr) {
        if (jwtErr.name === 'TokenExpiredError') {
          return res.status(401).json({
            success: false,
            error: 'Session expired. Please login again.',
            code: 'SESSION_EXPIRED'
          });
        }
        return res.status(401).json({
          success: false,
          error: 'Invalid or expired token',
          code: 'INVALID_TOKEN'
        });
      }
    }

    if (profile.status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Account suspended. Please contact support.',
        code: 'ACCOUNT_SUSPENDED'
      });
    }

    req.user = {
      ...resolvedUser,
      ...profile,
      id: profile.id,
      isAdmin: profile.role === 'admin' || profile.role === 'super_admin',
      isSuperAdmin: profile.role === 'super_admin'
    };
    req.token = token;

    next();
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    
    // ─── FIXED: Don't return 503 on generic errors ───
    // Return 401 so frontend can handle gracefully
    return res.status(401).json({
      success: false,
      error: 'Authentication failed. Please try again.',
      code: 'AUTH_ERROR'
    });
  }
};

/**
 * Optional Authentication
 * Allows requests without token (for public endpoints)
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(' ')[1];

    try {
        const { data: { user }, error } = await verifyTokenWithTimeout(token, 8000);

        if (!error && user) {
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single();

            if (profile) {
                req.user = { ...user, ...profile, id: profile.id };
                req.token = token;
            }
        } else {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                const { data: profile } = await supabaseAdmin
                    .from('profiles')
                    .select('*')
                    .eq('id', decoded.userId)
                    .single();
                if (profile) {
                    req.user = { id: decoded.userId, email: decoded.email, ...profile };
                    req.token = token;
                }
            } catch (e) {
                req.user = null;
            }
        }
    } catch (timeoutError) {
        // ─── On timeout, continue without user ───
        req.user = null;
    }

    next();
  } catch (error) {
    req.user = null;
    next();
  }
};

module.exports = { authMiddleware, optionalAuth };