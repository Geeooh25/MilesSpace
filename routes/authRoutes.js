const express = require('express');
const jwt = require('jsonwebtoken');
const { supabase, supabaseAdmin } = require('../db/supabase');
const { authMiddleware, getUserLocation, getClientIp } = require('../middleware/auth');
const router = express.Router();

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateToken(userId, email) {
  return jwt.sign(
    { userId, email },
    process.env.JWT_SECRET || 'miles-exchange-secret-key-2024',
    { expiresIn: '1d' }
  );
}

// ═══════════════════════════════════════════
// REGISTER — Step 1: Send OTP
// ═══════════════════════════════════════════
router.post('/register', async (req, res) => {
  try {
    const { email, password, username, phone } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ success: false, error: 'Email, username, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    const { data: existing } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    const exists = existing?.users?.some(u => u.email?.toLowerCase() === email.toLowerCase());
    if (exists) {
      return res.status(400).json({ success: false, error: 'Email already registered. Please login.' });
    }

    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const tempId = 'reg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

    if (!global.pendingRegistrations) global.pendingRegistrations = {};
    global.pendingRegistrations[tempId] = { email, password, username, phone: phone || null, code, expiresAt };

    console.log(`📝 Register: ${email} | Code: ${code}`);
    res.json({ success: true, message: 'Verification code sent', requires_2fa: true, user_id: tempId });
  } catch (error) {
    console.error('❌ Register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════
// REGISTER — Step 2: Verify OTP + Create Account
// ═══════════════════════════════════════════
router.post('/verify-registration', async (req, res) => {
  try {
    const { user_id, code } = req.body;
    if (!user_id || !code) return res.status(400).json({ success: false, error: 'User ID and code required' });

    const data = global.pendingRegistrations?.[user_id];
    if (!data) return res.status(400).json({ success: false, error: 'Session expired. Please register again.' });
    if (new Date(data.expiresAt) < new Date()) { delete global.pendingRegistrations[user_id]; return res.status(400).json({ success: false, error: 'Code expired.' }); }
    if (data.code !== code) return res.status(400).json({ success: false, error: 'Invalid code' });

    const { email, password, username, phone } = data;
    console.log('✅ Verified, creating:', email);

    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { username, full_name: username },
    });

    if (authError) {
      console.error('❌ Auth create error:', authError.message);
      return res.status(400).json({ success: false, error: 'Could not create account. Try again.' });
    }

    const userId = authUser.user.id;
    console.log('✅ Auth user:', userId);

    const clientIp = getClientIp(req);
    const location = await getUserLocation(clientIp);
    const refCode = 'MX' + Math.random().toString(36).substring(2, 8).toUpperCase();

    await supabaseAdmin.from('profiles').upsert({
      id: userId, email, username, phone: phone || null,
      wallet_ngn: 0, wallet_usd: 0, total_spent_usd: 0, total_orders: 0, completed_orders: 0,
      referral_code: refCode,
      created_at: new Date().toISOString(), last_login: new Date().toISOString(),
    }, { onConflict: 'id' });

    const token = generateToken(userId, email);
    await supabase.from('sessions').insert({
      user_id: userId, token, ip_address: clientIp,
      location: `${location.city}, ${location.country}`,
      user_agent: req.headers['user-agent'] || '',
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      created_at: new Date().toISOString(),
    });

    delete global.pendingRegistrations[user_id];
    console.log(`✅ Registered: ${email}`);

    res.status(201).json({
      success: true, message: 'Account created!',
      data: {
        user: { id: userId, email, username, wallet_ngn: 0, wallet_usd: 0, referral_code: refCode },
        token,
      },
    });
  } catch (error) {
    console.error('❌ Verify register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════
// LOGIN — Step 1: Password check, send OTP
// ═══════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });

    const { data: auth, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    console.log('✅ Password ok:', email);

    const clientIp = getClientIp(req);
    const location = await getUserLocation(clientIp);
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await supabaseAdmin.from('auth_verifications').delete().eq('user_id', auth.user.id);
    await supabaseAdmin.from('auth_verifications').insert({
      user_id: auth.user.id, code, expires_at: expiresAt.toISOString(),
      ip_address: clientIp, location: `${location.city}, ${location.country}`, created_at: new Date().toISOString(),
    });

    console.log(`🔐 [DEV] Code: ${code} | ${email}`);
    res.json({ success: true, message: 'Verification code sent', requires_2fa: true, user_id: auth.user.id });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════
// VERIFY 2FA — FIXED: Uses actual user email
// ═══════════════════════════════════════════
router.post('/verify-2fa', async (req, res) => {
  try {
    const { user_id, code } = req.body;
    if (!user_id || !code) return res.status(400).json({ success: false, error: 'User ID and code required' });

    const { data: verification } = await supabaseAdmin
      .from('auth_verifications').select('*').eq('user_id', user_id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();

    if (!verification) return res.status(400).json({ success: false, error: 'No code found. Login again.' });
    if (new Date(verification.expires_at) < new Date()) {
      await supabaseAdmin.from('auth_verifications').delete().eq('user_id', user_id);
      return res.status(400).json({ success: false, error: 'Code expired.' });
    }
    if (verification.code !== code) return res.status(400).json({ success: false, error: 'Invalid code' });

    // 🔥 FIXED: Get the actual user email from Supabase Auth
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(user_id);
    const actualEmail = authUser?.user?.email || '';

    // Get or create profile with the REAL email
    let profile = (await supabase.from('profiles').select('*').eq('id', user_id).single()).data;
    
    if (!profile) {
      const refCode = 'MX' + Math.random().toString(36).substring(2, 8).toUpperCase();
      const username = actualEmail ? actualEmail.split('@')[0] : 'user';
      
      const { data: newProf } = await supabaseAdmin.from('profiles').upsert({
        id: user_id,
        email: actualEmail,           // 🔥 USE REAL EMAIL
        username: username,            // 🔥 Derived from real email
        wallet_ngn: 0, wallet_usd: 0,
        total_spent_usd: 0, total_orders: 0, completed_orders: 0,
        referral_code: refCode,
        created_at: new Date().toISOString(),
        last_login: new Date().toISOString(),
      }, { onConflict: 'id' }).select().single();
      
      profile = newProf;
    }

    const clientIp = getClientIp(req);
    const location = await getUserLocation(clientIp);
    const token = generateToken(user_id, profile?.email || actualEmail);

    await supabase.from('sessions').delete().eq('user_id', user_id);
    await supabase.from('sessions').insert({
      user_id, token, ip_address: clientIp,
      location: `${location.city}, ${location.country}`,
      user_agent: req.headers['user-agent'] || '',
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      created_at: new Date().toISOString(),
    });

    if (profile) {
      await supabaseAdmin.from('profiles').update({
        last_login: new Date().toISOString(), last_ip: clientIp,
        last_location: `${location.city}, ${location.country}`
      }).eq('id', user_id);
    }

    await supabaseAdmin.from('auth_verifications').delete().eq('user_id', user_id);
    console.log(`✅ Login: ${profile?.email || actualEmail}`);

    res.json({
      success: true, message: 'Login successful',
      data: {
        user: {
          id: user_id,
          email: profile?.email || actualEmail,
          username: profile?.username || '',
          wallet_ngn: parseFloat(profile?.wallet_ngn || 0),
          wallet_usd: parseFloat(profile?.wallet_usd || 0),
          referral_code: profile?.referral_code || '',
        }, token,
      },
    });
  } catch (error) {
    console.error('❌ 2FA error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════
// SESSION STATUS
// ═══════════════════════════════════════════
router.get('/session-status', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ authenticated: false });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'miles-exchange-secret-key-2024');
    const { data: session } = await supabase.from('sessions').select('*')
      .eq('user_id', decoded.userId).eq('token', token).single();
    if (!session || new Date(session.expires_at) < new Date()) return res.json({ authenticated: false });
    res.json({ authenticated: true, session: { created_at: session.created_at, expires_at: session.expires_at } });
  } catch { res.json({ authenticated: false }); }
});

// ═══════════════════════════════════════════
// LOGOUT
// ═══════════════════════════════════════════
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    if (req.user?.id && req.token) {
      await supabase.from('sessions').delete().eq('user_id', req.user.id).eq('token', req.token);
    }
    res.json({ success: true, message: 'Logged out' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ═══════════════════════════════════════════
// GET CURRENT USER
// ═══════════════════════════════════════════
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });

    res.json({
      success: true,
      data: {
        id: profile.id, email: profile.email, username: profile.username,
        full_name: profile.full_name || profile.username,
        wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
        wallet_usd: parseFloat(profile.wallet_usd) || 0,
        referral_code: profile.referral_code || '',
      },
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ═══════════════════════════════════════════
// UPDATE PROFILE
// ═══════════════════════════════════════════
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { username, phone, avatar_url, full_name } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (username !== undefined) updates.username = username;
    if (phone !== undefined) updates.phone = phone;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (full_name !== undefined) updates.full_name = full_name;
    const { data, error } = await supabaseAdmin.from('profiles').update(updates).eq('id', req.user.id).select().single();
    if (error) throw error;
    res.json({ success: true, message: 'Profile updated', data });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ═══════════════════════════════════════════
// CHANGE PASSWORD
// ═══════════════════════════════════════════
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const { error: signInErr } = await supabase.auth.signInWithPassword({ email: req.user.email, password: current_password });
    if (signInErr) return res.status(401).json({ error: 'Current password is incorrect' });
    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, { password: new_password });
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json({ success: true, message: 'Password changed' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;