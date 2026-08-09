// server.js - Complete with all authentication routes integrated
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

require('dotenv').config();

// ─── IMPORT SUPABASE + SHARED AUTH MIDDLEWARE ───
// authMiddleware/optionalAuth now live in ONE place: middleware/auth.js
// (that version has proper timeout handling — see that file)
const { authMiddleware, optionalAuth } = require('./middleware/auth');
const { supabase, supabaseAdmin } = require('./db/supabase');

// ─── ENVIRONMENT CHECK ───
const requiredEnvVars = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'JWT_SECRET'
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
    console.error('\n❌ CRITICAL: Missing required environment variables:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error('\n💡 Please add them to your .env file and restart the server.\n');
    process.exit(1);
}

console.log('✅ All required environment variables are set');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'miles-exchange-secret-key-2024';

// ─── CORS ───
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// ─── BODY PARSING ───
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── STATIC FILES ───
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════
// 🔐 AUTHENTICATION MIDDLEWARE
// ═══════════════════════════════════════════════════════
//
// NOTE: The plain "authMiddleware" (for regular user routes) is now
// imported from ./middleware/auth.js — it has timeout handling so a
// slow Supabase call returns 503, not a false 401. See that file if
// you need to tweak timeout behavior.
//
// adminAuth / superAdminAuth are ADMIN-only, so they still live here
// since middleware/auth.js only exports the user-facing ones.

// ─── ADMIN AUTH MIDDLEWARE ───
const adminAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    let user, error;
    try {
      const result = await Promise.race([
        supabase.auth.getUser(token),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Token verification timeout')), 5000)
        )
      ]);
      user = result.data?.user;
      error = result.error;
    } catch (timeoutError) {
      console.warn('⚠️ Admin token verification timeout');
      return res.status(503).json({
        success: false,
        error: 'Authentication service unavailable. Please try again.',
        code: 'AUTH_SERVICE_UNAVAILABLE'
      });
    }

    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    // 🔒 CHECK: User must be admin or super_admin
    if (profile.role !== 'admin' && profile.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    if (profile.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'Account suspended' });
    }

    req.user = { ...user, ...profile, id: profile.id, isAdmin: true };
    req.token = token;
    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(500).json({ success: false, error: 'Authentication error' });
  }
};

// ─── SUPER ADMIN AUTH ───
const superAdminAuth = async (req, res, next) => {
  try {
    await adminAuth(req, res, () => {
      if (req.user.role !== 'super_admin') {
        return res.status(403).json({ success: false, error: 'Super admin privileges required' });
      }
      next();
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Authentication error' });
  }
};

// ─── HELPER FUNCTIONS ───
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateReferralCode() {
  return 'MX' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function isUsernameTaken(username) {
  if (!username) return false;
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('username')
    .eq('username', username)
    .maybeSingle();
  return !!data;
}

async function isEmailTaken(email) {
  if (!email) return false;
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('email')
    .eq('email', email)
    .maybeSingle();
  return !!data;
}

// ─── PENDING REGISTRATIONS CACHE ───
const pendingRegistrations = {};

// ═══════════════════════════════════════════════════════
// 🔐 AUTHENTICATION ROUTES
// ═══════════════════════════════════════════════════════

// ─── USER REGISTER — Step 1 ───
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username, phone } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ success: false, error: 'Email, username, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    if (username.length < 3) {
      return res.status(400).json({ success: false, error: 'Username must be at least 3 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ success: false, error: 'Username can only contain letters, numbers, and underscores' });
    }

    const usernameTaken = await isUsernameTaken(username);
    if (usernameTaken) {
      return res.status(400).json({ success: false, error: 'Username is already taken' });
    }

    const emailTaken = await isEmailTaken(email);
    if (emailTaken) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }

    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const tempId = 'reg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

    pendingRegistrations[tempId] = { 
      email, password, username, phone: phone || null, code, expiresAt 
    };

    console.log(`📝 Register: ${email} | Username: ${username} | Code: ${code}`);

    res.json({ 
      success: true, 
      message: 'Verification code sent', 
      requires_2fa: true, 
      user_id: tempId,
      debug_code: process.env.NODE_ENV === 'development' ? code : undefined
    });

  } catch (error) {
    console.error('❌ Register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ success: false, error: 'Refresh token required' });
    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error || !data?.session) {
      return res.status(401).json({ success: false, error: 'Session expired. Please login again.' });
    }
    res.json({ success: true, data: { token: data.session.access_token, refresh_token: data.session.refresh_token } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── USER REGISTER — Step 2 ───
app.post('/api/auth/verify-registration', async (req, res) => {
  try {
    const { user_id, code } = req.body;
    
    if (!user_id || !code) {
      return res.status(400).json({ success: false, error: 'User ID and code required' });
    }

    const data = pendingRegistrations[user_id];
    if (!data) {
      return res.status(400).json({ success: false, error: 'Session expired. Please register again.' });
    }

    if (new Date(data.expiresAt) < new Date()) {
      delete pendingRegistrations[user_id];
      return res.status(400).json({ success: false, error: 'Code expired. Please register again.' });
    }

    if (data.code !== code) {
      return res.status(400).json({ success: false, error: 'Invalid code. Please try again.' });
    }

    const { email, password, username, phone } = data;

    const usernameTaken = await isUsernameTaken(username);
    if (usernameTaken) {
      delete pendingRegistrations[user_id];
      return res.status(400).json({ success: false, error: 'Username was taken. Please register again.' });
    }

    const emailTaken = await isEmailTaken(email);
    if (emailTaken) {
      delete pendingRegistrations[user_id];
      return res.status(400).json({ success: false, error: 'Email was registered. Please login.' });
    }

    // ─── CREATE USER IN SUPABASE AUTH ───
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, 
      password, 
      email_confirm: true,
      user_metadata: { username },
    });

    if (authError) {
      console.error('❌ Auth create error:', authError.message);
      return res.status(400).json({ success: false, error: 'Could not create account. Try again.' });
    }

    const userId = authUser.user.id;
    console.log('✅ Auth user created:', userId);

    // ─── CREATE PROFILE ───
    const refCode = generateReferralCode();
    const { error: profileError } = await supabaseAdmin.from('profiles').insert({
      id: userId, 
      email, 
      username, 
      phone: phone || null,
      wallet_ngn: 0, 
      wallet_usd: 0, 
      role: 'user',
      status: 'active',
      referral_code: refCode,
      created_at: new Date().toISOString()
    });

    if (profileError) {
      console.error('❌ Profile create error:', profileError);
      try {
        await supabaseAdmin.auth.admin.deleteUser(userId);
      } catch (e) {}
      return res.status(500).json({ success: false, error: 'Failed to create profile.' });
    }

    console.log('✅ Profile created for:', userId);
    delete pendingRegistrations[user_id];

    // ─── AUTO LOGIN ───
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (signInError) {
      return res.status(201).json({
        success: true, 
        message: 'Account created! Please login.',
        data: { user: { id: userId, email, username, role: 'user' } }
      });
    }

    res.status(201).json({
      success: true, 
      message: 'Account created and logged in!',
      data: {
        user: { 
          id: userId, 
          email, 
          username, 
          role: 'user',
          wallet_ngn: 0, 
          wallet_usd: 0, 
          referral_code: refCode 
        },
        token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token
      },
    });

  } catch (error) {
    console.error('❌ Verify register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── USER LOGIN ───
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (signInError) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const user = signInData.user;

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    // 🔒 BLOCK ADMIN LOGIN ON USER PAGE
    if (profile.role === 'admin' || profile.role === 'super_admin') {
      return res.status(403).json({ 
        success: false, 
        error: 'This is a user login page. Admins must use the admin login.' 
      });
    }

    if (profile.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'Account suspended.' });
    }

    res.json({
      success: true,
      data: {
        user: {
          id: profile.id,
          email: profile.email,
          username: profile.username,
          role: profile.role,
          wallet_ngn: parseFloat(profile.wallet_ngn || 0),
          wallet_usd: parseFloat(profile.wallet_usd || 0),
          referral_code: profile.referral_code || '',
        },
        token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token
      },
    });

  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── ADMIN LOGIN ───
app.post('/api/auth/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (signInError) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const user = signInData.user;

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    // 🔒 CHECK: User must be admin or super_admin
    if (profile.role !== 'admin' && profile.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Access denied. Admin privileges required.' });
    }

    if (profile.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'Account suspended.' });
    }

    console.log(`✅ Admin login: ${email} (${profile.role})`);

    res.json({
      success: true,
      message: 'Admin login successful',
      data: {
        user: {
          id: profile.id,
          email: profile.email,
          username: profile.username,
          role: profile.role,
          isAdmin: true,
          isSuperAdmin: profile.role === 'super_admin'
        },
        token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token
      },
    });

  } catch (error) {
    console.error('❌ Admin login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET CURRENT USER ───
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();
      
    if (!profile) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // ✅ Check if user is admin and send appropriate response
    const isAdmin = profile.role === 'admin' || profile.role === 'super_admin';

    res.json({
      success: true,
      data: {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        role: profile.role || 'user',
        isAdmin: isAdmin,
        isSuperAdmin: profile.role === 'super_admin',
        wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
        wallet_usd: parseFloat(profile.wallet_usd) || 0,
        referral_code: profile.referral_code || '',
        status: profile.status || 'active',
        // ✅ Tell frontend where to redirect
        dashboard_url: isAdmin ? '/admin/dashboard' : '/dashboard'
      },
    });

  } catch (error) {
    console.error('Me error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET ADMIN PROFILE ───
app.get('/api/auth/admin/me', adminAuth, async (req, res) => {
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();
      
    if (!profile) {
      return res.status(404).json({ success: false, error: 'Admin not found' });
    }

    res.json({
      success: true,
      data: {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        role: profile.role,
        isAdmin: true,
        isSuperAdmin: profile.role === 'super_admin',
        status: profile.status,
        created_at: profile.created_at
      },
    });

  } catch (error) {
    console.error('Admin profile error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── LOGOUT ───
app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  try {
    await supabase.auth.signOut();
    res.json({ success: true, message: 'Logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── ADMIN LOGOUT ───
app.post('/api/auth/admin/logout', adminAuth, async (req, res) => {
  try {
    await supabase.auth.signOut();
    res.json({ success: true, message: 'Admin logged out' });
  } catch (error) {
    console.error('Admin logout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════
// 🛠️ OTHER API ROUTES (Your existing routes)
// ═══════════════════════════════════════════════════════

console.log('📦 Loading routes...');

// ─── HELPER: Safe require ───
// ─── HELPER: Safe require ───
function safeRequire(modulePath) {
    try {
        const mod = require(modulePath);
        if (mod && typeof mod === 'object' && mod.router) {
            return mod.router;
        }
        if (mod && typeof mod === 'function') {
            return mod;
        }
        return mod;
    } catch (error) {
        console.warn(`⚠️ Failed to load ${modulePath}:`, error.message);
        return null;
    }
}
// ─── IMPORT YOUR EXISTING ROUTES ───
const authRoutes = require('./routes/authRoutes');
const productRoutes = safeRequire('./routes/marketRoutes');
const boostRoutes = safeRequire('./routes/boostRoutes');
const smsRoutes = safeRequire('./routes/smsRoutes');
const transactionRoutes = safeRequire('./routes/transactionRoutes');
const notificationRoutes = safeRequire('./routes/notificationRoutes');
const profileRoutes = safeRequire('./routes/profileRoutes');
const marketRoutes = safeRequire('./routes/marketRoutes');
const virtualsmsRoutes = safeRequire('./routes/virtual-router');
const giftCardRoutes = safeRequire('./routes/giftCardRoutes');
const giftRoutes = safeRequire('./routes/giftRoutes');
const ratesRoutes = safeRequire('./routes/ratesRoutes');
const socialAdsRoutes = safeRequire('./routes/socialAds');
const presenceRoutes = safeRequire('./routes/presenceRoutes');
const walletRoutes = safeRequire('./routes/wallet/index');
const bankRoutes = safeRequire('./routes/bankRoutes');  
const nowPaymentsRoutes = safeRequire('./routes/wallet/nowpayments');
const paystackRoutes = safeRequire('./routes/wallet/paystack');
const withdrawals = safeRequire('./routes/wallet/withdrawals');
const beneficiaryRoutes = require('./routes/wallet/beneficiaries');
const bushaRoutes = safeRequire('./routes/busha');
const cashbackRoutes = require('./routes/cashback');
const walletChecker = require('./routes/walletChecker');
const utilsRoutes = require('./routes/utils');
const supportRoutes = require('./routes/support');
// ─── ADMIN ROUTES ───
const adminLoginRoutes = safeRequire('./routes/admin');
const adminRoutes = safeRequire('./routes/adminRoutes');
const adminDashboardRoutes = safeRequire('./routes/admin/dashboardRoutes');
const adminUserRoutes = safeRequire('./routes/admin/userRoutes');
const adminTransactionRoutes = safeRequire('./routes/admin/transactionRoutes');
const adminAuditRoutes = safeRequire('./routes/admin/auditRoutes');
const adminIntelligenceRoutes = safeRequire('./routes/admin/intelligenceRoutes');
const presenceAdminRoutes = safeRequire('./routes/admin/presenceAdminRoutes');
const messageRoutes = safeRequire('./routes/messages');
const giftAdminRoutes = safeRequire('./routes/admin/giftAdminRoutes');
const marketplaceRoutes = safeRequire('./routes/admin/marketplaceRoutes');
const cryptoRoutes = safeRequire('./routes/admin/cryptoRoutes');
const giftcardAdminRoutes = require('./routes/admin/giftcardAdminRoutes');


// ─── DEBUG: Show loaded routes ───
console.log('🔍 Route status:');
console.log(`  ✅ smsRoutes: ${smsRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ marketRoutes: ${marketRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ boostRoutes: ${boostRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ walletRoutes: ${walletRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ transactionRoutes: ${transactionRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ giftRoutes: ${giftRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ giftCardRoutes: ${giftCardRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ messageRoutes: ${messageRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ adminLoginRoutes: ${adminLoginRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ adminDashboardRoutes: ${adminDashboardRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ adminUserRoutes: ${adminUserRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ adminTransactionRoutes: ${adminTransactionRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ adminAuditRoutes: ${adminAuditRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ adminIntelligenceRoutes: ${adminIntelligenceRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ presenceAdminRoutes: ${presenceAdminRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ giftAdminRoutes: ${giftAdminRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ marketplaceRoutes: ${marketplaceRoutes ? 'loaded' : '❌'}`);
console.log(`  ✅ cryptoRoutes: ${cryptoRoutes ? 'loaded' : '❌'}`);

// ─── MOUNT OTHER API ROUTES ───
if (smsRoutes) app.use('/api/sms', smsRoutes);
if (marketRoutes) app.use('/api/market', marketRoutes);
if (boostRoutes) app.use('/api/boost', boostRoutes);
if (giftcardAdminRoutes) app.use('/api', giftcardAdminRoutes);     
if (walletRoutes) app.use('/api/wallet', walletRoutes);
if (transactionRoutes) app.use('/api/transactions', transactionRoutes);
if (notificationRoutes) app.use('/api/notifications', notificationRoutes);
if (profileRoutes) app.use('/api/profile', profileRoutes);
if (productRoutes) app.use('/api/products', productRoutes);
if (virtualsmsRoutes) app.use('/api/virtual', virtualsmsRoutes);
if (giftCardRoutes) app.use('/api/giftcards', giftCardRoutes);
if (giftRoutes) app.use('/api/gifts', giftRoutes);
if (socialAdsRoutes) app.use('/api/ads', socialAdsRoutes);
if (messageRoutes) app.use('/api/messages', messageRoutes);
if (ratesRoutes) app.use('/api/rates', ratesRoutes);
if (presenceRoutes) app.use('/api/presence', presenceRoutes);  
if (bankRoutes) app.use('/api/banks', bankRoutes);
if (withdrawals) app.use('/api/wallet/withdraw', withdrawals);
if (nowPaymentsRoutes) app.use('/api/wallet/nowpayments', nowPaymentsRoutes);
if (paystackRoutes) app.use('/api/wallet/paystack', paystackRoutes);
if (bushaRoutes) app.use('/api/busha', bushaRoutes);
if(cashbackRoutes)app.use('/api/cashback', cashbackRoutes);
if(walletChecker)app.use('/api/wallet-checker',walletChecker);
if (beneficiaryRoutes)app.use('/api/wallet/beneficiaries', beneficiaryRoutes);
if (utilsRoutes) app.use('/api/utils', utilsRoutes);
app.use('/api/support', supportRoutes);
app.use('/uploads', express.static('uploads'));
    
// ─── Mount authentication routes ───
app.use('/api/auth', authRoutes);
// ─── Mount Gift Card Admin Routes ───
 // For admin routes


// ─── ADMIN ROUTES ───
if (adminLoginRoutes) app.use('/api/admin', adminLoginRoutes);
if (giftcardAdminRoutes) app.use('/api/admin', giftcardAdminRoutes); 
if (adminDashboardRoutes) app.use('/api/admin', adminDashboardRoutes);
if (adminRoutes) app.use('/api/admin', adminRoutes);
if (adminUserRoutes) app.use('/api/admin', adminUserRoutes);
if (adminTransactionRoutes) app.use('/api/admin', adminTransactionRoutes);
if (adminAuditRoutes) app.use('/api/admin', adminAuditRoutes);
if (adminIntelligenceRoutes) app.use('/api/admin', adminIntelligenceRoutes);
if (presenceAdminRoutes) app.use('/api/admin/presence', presenceAdminRoutes);
if (messageRoutes) app.use('/api/admin/messages', messageRoutes);
if (giftAdminRoutes) app.use('/api/admin', giftAdminRoutes);
if (marketplaceRoutes) app.use('/api/admin/marketplace', marketplaceRoutes);
if (cryptoRoutes) app.use('/api/admin/crypto', cryptoRoutes);

console.log('✅ All routes mounted successfully');

// ═══════════════════════════════════════════════════════
// 📄 HEALTH CHECK
// ═══════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── DOWNLOAD ROUTE ───
app.get('/api/download/:token', async (req, res) => {
  try {
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('download_token', req.params.token)
      .single();

    if (error || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await supabaseAdmin
      .from('orders')
      .update({
        download_count: (order.download_count || 0) + 1,
        last_download_at: new Date().toISOString()
      })
      .eq('id', order.id);

    const log = order.delivered_data || {};
    const content = [
      '═══════════════════════════════════════════════',
      '  📦 MILESPACE ORDER DETAILS',
      '═══════════════════════════════════════════════',
      '',
      `Order ID:    ${order.order_ref}`,
      `Product:     ${order.product_title}`,
      `Date:        ${new Date(order.created_at).toLocaleString()}`,
      `Wallet:      ${order.wallet_used || 'NGN'}`,
      `Amount:      ${order.wallet_used === 'USD' ? '$' : '₦'}${(order.wallet_used === 'USD' ? order.price_usd : order.price_ngn).toFixed(2)}`,
      `Downloads:   ${(order.download_count || 0) + 1}`,
      '',
      '────────── ACCOUNT LOGIN DETAILS ──────────',
      '',
      `Format:      ${log.login_format || 'N/A'}`,
      '',
      'Instructions:',
      log.login_instructions || 'No instructions provided.',
      '',
      '───────────────────────────────────────────',
      `Downloaded:  ${new Date().toISOString()}`,
      '═══════════════════════════════════════════════'
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="order_${order.order_ref}.txt"`);
    res.send(content);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

// ═══════════════════════════════════════════════════════
// 🖥️ FRONTEND ROUTES
// ═══════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/market', (req, res) => res.sendFile(path.join(__dirname, 'public', 'market.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/fund', (req, res) => res.sendFile(path.join(__dirname, 'public', 'fund.html')));
app.get('/boost', (req, res) => res.sendFile(path.join(__dirname, 'public', 'boost.html')));
app.get('/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));
app.get('/notifications', (req, res) => res.sendFile(path.join(__dirname, 'public', 'notifications.html')));
app.get('/virtual', (req, res) => res.sendFile(path.join(__dirname, 'public', 'virtual.html')));
app.get('/sellgift', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sellgift.html')));
app.get('/sendgift', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sendgift.html')));
app.get('/cashback', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cashback.html')));
// app.get('/checker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chec.html')));
app.get('/login', (req, res) => res.redirect('/signup'));

// ─── ADMIN PAGES ───\
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html')));
app.get('/admin/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html')));
app.get('/admin/campaigns', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'campaigns.html')));
app.get('/admin/sellgift', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'sellgift.html')));
app.get('/admin/marketplace-products', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'marketplace-products.html')));
app.get('/admin/wallet-deposits', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'wallet-deposits.html')));
app.get('/admin/virtual-sms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'virtual-sms.html')));
app.get('/admin/users', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'users.html')));
app.get('/admin/reports', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'reports.html')));
app.get('/admin/support', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'support.html')));
app.get('/admin/notifications', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'notifications.html')));
app.get('/admin/ticker-manager', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'ticker-manager.html')));
app.get('/admin/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'settings.html')));
app.get('/admin/crypto', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'crypto.html')));
app.get('/admin/messages', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'messages.html')));

// ─── CATCH-ALL ADMIN ───
app.get(/^\/admin\/(.+)$/, (req, res) => {
  const requestedPath = req.params[0] || '';
  if (requestedPath && requestedPath.includes('.')) {
    const fullPath = path.join(__dirname, 'public', 'admin', requestedPath);
    if (fs.existsSync(fullPath)) {
      return res.sendFile(fullPath);
    }
  }
  res.redirect('/admin/dashboard');
});

// ═══════════════════════════════════════════════════════
// 🚫 404 HANDLER
// ═══════════════════════════════════════════════════════

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: `API endpoint ${req.method} ${req.path} not found` });
  }
  if (!req.path.includes('.')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.status(404).send('File not found');
});

// ─── ERROR HANDLER ───
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({ error: err.message || 'Something went wrong!' });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: `API endpoint ${req.method} ${req.path} not found` });
  }});

// ═══════════════════════════════════════════════════════
// 🔌 SOCKET.IO SERVER
// ═══════════════════════════════════════════════════════

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.userEmail = decoded.email;
    socket.userRole = decoded.role || 'user';
    next();
  } catch (error) {
    return next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.userId} (${socket.userEmail})`);
  socket.join(`user:${socket.userId}`);
  socket.join('online_users');
  
  socket.broadcast.emit('user:online', {
    userId: socket.userId,
    email: socket.userEmail,
    role: socket.userRole,
    connectedAt: new Date().toISOString()
  });
  
  const onlineCount = io.sockets.adapter.rooms.get('online_users')?.size || 0;
  io.emit('users:online-count', { count: onlineCount });

  socket.on('page:change', (data) => {
    const { page, action, metadata } = data;
    socket.currentPage = page;
    socket.currentAction = action || 'viewing';
    socket.broadcast.emit('user:activity', {
      userId: socket.userId,
      email: socket.userEmail,
      page: page,
      action: action || 'viewing',
      timestamp: new Date().toISOString(),
      metadata: metadata || {}
    });
  });

  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${socket.userId}`);
    socket.broadcast.emit('user:offline', {
      userId: socket.userId,
      email: socket.userEmail,
      disconnectedAt: new Date().toISOString()
    });
    const onlineCount = io.sockets.adapter.rooms.get('online_users')?.size || 0;
    io.emit('users:online-count', { count: onlineCount });
  });
});

function emitAdminNotification(title, message, type = 'info', link = null) {
  if (io) {
    io.emit('notification:receive', {
      title: title,
      message: message,
      type: type,
      link: link,
      timestamp: new Date().toISOString()
    });
  }
}

const socketHelpers = { io, emitAdminNotification, getIO: () => io };

// ═══════════════════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔌 Socket.IO enabled`);
  console.log(`\n📄 Frontend URLs:`);
  console.log(`   → Landing Page: http://localhost:${PORT}/`);
  console.log(`   → Signup/Login: http://localhost:${PORT}/signup`);
  console.log(`   → Dashboard:    http://localhost:${PORT}/dashboard`);
  console.log(`\n🔗 API Base: http://localhost:${PORT}/api`);
  console.log(`   → User Login:   POST /api/auth/login`);
  console.log(`   → Admin Login:  POST /api/auth/admin/login`);
  console.log(`   → Register:     POST /api/auth/register`);
  console.log(`   → Verify:       POST /api/auth/verify-registration`);
  console.log(`\n🔐 Admin URLs:`);
  console.log(`   → Admin:        http://localhost:${PORT}/admin`);
  console.log(`   → Admin Login:  http://localhost:${PORT}/admin/login`);
  console.log(`   → Dashboard:    http://localhost:${PORT}/admin/dashboard`);
  console.log(`   → Crypto:       http://localhost:${PORT}/admin/crypto`);
  console.log(`   → Messages:     http://localhost:${PORT}/admin/messages`);
  console.log(`   → Notifications: http://localhost:${PORT}/admin/notifications`);
  console.log(`   → Settings:     http://localhost:${PORT}/admin/settings\n`);
});

module.exports = socketHelpers;