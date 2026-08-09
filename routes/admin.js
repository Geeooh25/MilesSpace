// routes/admin.js - COMPLETE FIXED WORKING VERSION
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { supabase, supabaseAdmin } = require('../db/supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'miles-exchange-secret-key-2024';
const ADMIN_TOKEN_EXPIRY = '12h';

// ─── HELPER: Hash token for storage ───
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── ✅ UPDATED: Verify Admin with Supabase support ───
async function verifyAdmin(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }
    
    try {
        // Try Supabase auth first
        const { data: { user }, error } = await supabase.auth.getUser(token);
        
        if (!error && user) {
            // Check if user is admin in database
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single();
            
            if (profile && (profile.role === 'admin' || profile.role === 'super_admin')) {
                req.userId = profile.id;
                req.userEmail = profile.email;
                req.userRole = profile.role;
                req.token = token;
                req.isSupabase = true;
                return next();
            }
        }
        
        // Fallback to custom JWT
        const decoded = jwt.verify(token, JWT_SECRET);
        const role = decoded.role || 'user';
        if (role !== 'admin' && role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        req.userId = decoded.userId;
        req.userEmail = decoded.email;
        req.userRole = role;
        req.token = token;
        req.isSupabase = false;
        next();
    } catch (e) {
        if (e.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, error: 'Token expired' });
        }
        console.error('Admin auth error:', e.message);
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

// ─── SUPER ADMIN AUTH (added) ───
async function verifySuperAdmin(req, res, next) {
    return verifyAdmin(req, res, () => {
        if (req.userRole !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Super admin privileges required' });
        }
        next();
    });
}



// ─── ADMIN LOGIN ───
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email and password required' 
            });
        }

        console.log(`🔐 Admin login attempt: ${email}`);

        // ─── STEP 1: Get admin profile ───
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('email', email)
            .maybeSingle();

        if (profileError) {
            console.error('Profile fetch error:', profileError);
            return res.status(500).json({ 
                success: false, 
                error: 'Database error. Please try again.' 
            });
        }

        if (!profile) {
            console.log(`❌ No profile found for: ${email}`);
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid email or password' 
            });
        }

        // ─── STEP 2: Check if user is admin ───
        if (profile.role !== 'admin' && profile.role !== 'super_admin') {
            console.log(`🚫 User ${email} is not an admin (role: ${profile.role})`);
            return res.status(403).json({ 
                success: false, 
                error: 'Admin access required' 
            });
        }

        if (profile.status === 'suspended') {
            return res.status(403).json({ 
                success: false, 
                error: 'Account suspended. Please contact support.' 
            });
        }

        // ─── STEP 3: Verify password with Supabase ───
        let authSuccess = false;
        let authError = null;

        try {
            const result = await Promise.race([
                supabase.auth.signInWithPassword({ email, password }),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Auth timeout')), 10000)
                )
            ]);

            const { data, error } = result;
            if (!error && data?.user) {
                authSuccess = true;
                console.log(`✅ Supabase auth successful for ${email}`);
            } else if (error) {
                authError = error;
                console.log(`⚠️ Supabase auth error: ${error.message}`);
            }
        } catch (timeoutError) {
            console.log(`⚠️ Supabase auth timeout for ${email}, using fallback`);
            authError = timeoutError;
        }

        // ─── STEP 4: Fallback for development ───
        if (!authSuccess) {
            if (process.env.NODE_ENV === 'development') {
                console.log(`⚠️ DEVELOPMENT MODE: Allowing admin login without Supabase auth`);
                authSuccess = true;
            } else {
                console.log(`❌ Auth failed for ${email}: ${authError?.message || 'Unknown error'}`);
                return res.status(401).json({ 
                    success: false, 
                    error: 'Invalid email or password' 
                });
            }
        }

        // ─── STEP 5: Generate JWT Token ───
        const token = jwt.sign(
            { 
                userId: profile.id, 
                email: profile.email, 
                role: profile.role 
            },
            JWT_SECRET,
            { expiresIn: ADMIN_TOKEN_EXPIRY }
        );

        console.log(`✅ JWT token generated for ${email}`);

        // ─── STEP 6: Create admin session ───
        try {
            const sessionId = crypto.randomUUID();
            const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
            const hashedToken = hashToken(token);

            // Delete old admin sessions
            await supabaseAdmin
                .from('sessions')
                .delete()
                .eq('user_id', profile.id);

            // Create new session
            await supabaseAdmin
                .from('sessions')
                .insert({
                    id: sessionId,
                    user_id: profile.id,
                    token: hashedToken,
                    is_active: true,
                    expires_at: expiresAt,
                    created_at: new Date().toISOString(),
                    last_activity: new Date().toISOString()
                });

            console.log(`✅ Admin session created: ${sessionId}`);
        } catch (sessionError) {
            console.error('Session creation error:', sessionError);
        }

        // ─── STEP 7: Update profile ───
        try {
            await supabaseAdmin
                .from('profiles')
                .update({
                    last_login: new Date().toISOString()
                })
                .eq('id', profile.id);
        } catch (updateError) {
            console.error('Profile update error:', updateError);
        }

        console.log(`✅ Admin login successful: ${email}`);

        // ─── STEP 8: Return success response ───
        res.json({
            success: true,
            message: 'Login successful',
            data: {
                user: {
                    id: profile.id,
                    email: profile.email,
                    username: profile.username || profile.email?.split('@')[0] || 'Admin',
                    role: profile.role,
                    status: profile.status || 'active',
                    wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
                    wallet_usd: parseFloat(profile.wallet_usd) || 0,
                    avatar_url: profile.avatar_url || null
                },
                token,
                expiresIn: ADMIN_TOKEN_EXPIRY
            }
        });

    } catch (error) {
        console.error('❌ Admin login error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Login failed. Please try again.' 
        });
    }
});

// ─── ADMIN VERIFY ───
router.get('/verify', verifyAdmin, async (req, res) => {
    try {
        const { data: session, error } = await supabaseAdmin
            .from('sessions')
            .select('id, is_active, expires_at')
            .eq('user_id', req.userId)
            .eq('token', hashToken(req.token))
            .maybeSingle();

        if (error) {
            console.error('Session verification error:', error);
            return res.status(401).json({ 
                success: false, 
                error: 'Session verification failed' 
            });
        }

        if (!session) {
            return res.status(401).json({ 
                success: false, 
                error: 'No active session found' 
            });
        }

        if (!session.is_active) {
            return res.status(401).json({ 
                success: false, 
                error: 'Session is inactive' 
            });
        }

        if (new Date(session.expires_at) < new Date()) {
            return res.status(401).json({ 
                success: false, 
                error: 'Session expired' 
            });
        }

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', req.userId)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({ 
                success: false, 
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
                    avatar_url: profile.avatar_url || null
                },
                session: {
                    id: session.id,
                    expiresAt: session.expires_at
                }
            }
        });

    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Verification failed' 
        });
    }
});

// ─── ADMIN LOGOUT ───
router.post('/logout', verifyAdmin, async (req, res) => {
    try {
        await supabaseAdmin
            .from('sessions')
            .update({ 
                is_active: false,
                expires_at: new Date().toISOString()
            })
            .eq('user_id', req.userId)
            .eq('token', hashToken(req.token));

        res.json({ 
            success: true, 
            message: 'Logged out successfully' 
        });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Logout failed' 
        });
    }
});

// ─── GET ADMIN PROFILE ───
router.get('/me', verifyAdmin, async (req, res) => {
    try {
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', req.userId)
            .single();

        if (error || !profile) {
            return res.status(404).json({ 
                success: false, 
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
                    avatar_url: profile.avatar_url || null
                }
            }
        });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to get profile' 
        });
    }
});

// ─── ADMIN CHECK ───
router.get('/check', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.json({ authenticated: false });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const role = decoded.role || 'user';
        
        if (role !== 'admin' && role !== 'super_admin') {
            return res.json({ authenticated: false });
        }

        const { data: session } = await supabaseAdmin
            .from('sessions')
            .select('is_active, expires_at')
            .eq('user_id', decoded.userId)
            .eq('token', hashToken(token))
            .maybeSingle();

        if (!session || !session.is_active || new Date(session.expires_at) < new Date()) {
            return res.json({ authenticated: false });
        }

        res.json({ authenticated: true });
    } catch (e) {
        res.json({ authenticated: false });
    }
});


router.verifyAdmin = verifyAdmin;
router.verifySuperAdmin = verifySuperAdmin;

module.exports = router;