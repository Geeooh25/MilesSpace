const jwt = require('jsonwebtoken');
const { supabase, supabaseAdmin } = require('../db/supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'miles-exchange-secret-key-2024';

async function getUserLocation(ip) {
  try {
    if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return { city: 'Localhost', country: 'Development', isp: 'Local Network' };
    }
    const response = await fetch(`https://ipapi.co/${ip}/json/`, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    return { city: data.city || 'Unknown', country: data.country_name || 'Unknown', isp: data.org || 'Unknown' };
  } catch {
    return { city: 'Unknown', country: 'Unknown', isp: 'Unknown' };
  }
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  if (req.headers['x-real-ip']) return req.headers['x-real-ip'];
  if (req.headers['cf-connecting-ip']) return req.headers['cf-connecting-ip'];
  return req.socket.remoteAddress || 'unknown';
}

// ═══════════════════════════════════════
// AUTH MIDDLEWARE — Required authentication
// ═══════════════════════════════════════
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded || !decoded.userId) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    // Try to get user from profiles
    const { data: user, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      console.log('⚠️ Profile missing for:', decoded.userId, '- upserting...');

      const referralCode = 'MX' + Math.random().toString(36).substring(2, 8).toUpperCase();

      const { data: newProfile, error: upsertError } = await supabaseAdmin
        .from('profiles')
        .upsert(
          {
            id: decoded.userId,
            email: decoded.email || 'user@email.com',
            username: decoded.username || decoded.email?.split('@')[0] || 'user',
            wallet_ngn: 0,
            wallet_usd: 0,
            total_spent_usd: 0,
            total_orders: 0,
            completed_orders: 0,
            referral_code: referralCode,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
          },
          { onConflict: 'id' }
        )
        .select()
        .single();

      if (upsertError) {
        console.error('❌ Upsert failed:', upsertError.message);
        req.user = {
          id: decoded.userId,
          email: decoded.email || 'unknown@email.com',
          username: decoded.username || 'User',
          wallet_ngn: 0,
          wallet_usd: 0,
          full_name: decoded.username || 'User',
        };
      } else {
        console.log('✅ Profile ready for:', decoded.userId);
        req.user = newProfile;
        req.user.id = newProfile.id;
      }
    } else {
      req.user = user;
      req.user.id = user.id;
    }

    req.token = token;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token expired' });
    }
    console.error('Auth middleware error:', error.message);
    res.status(500).json({ success: false, error: 'Authentication error' });
  }
};

// ═══════════════════════════════════════
// OPTIONAL AUTH — For routes that work without login
// ═══════════════════════════════════════
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = {
        id: 'demo-user',
        email: 'demo@miles.com',
        username: 'Demo',
        wallet_usd: 100,
        wallet_ngn: 160000,
      };
      return next();
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded && decoded.userId) {
      const { data: user } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', decoded.userId)
        .single();

      if (user) {
        req.user = user;
        req.user.id = user.id;
      } else {
        req.user = {
          id: decoded.userId,
          email: decoded.email || 'demo@miles.com',
          username: decoded.username || 'User',
          wallet_usd: 100,
          wallet_ngn: 160000,
        };
      }
    } else {
      req.user = {
        id: 'demo-user',
        email: 'demo@miles.com',
        username: 'Demo',
        wallet_usd: 100,
        wallet_ngn: 160000,
      };
    }

    next();
  } catch (error) {
    req.user = {
      id: 'demo-user',
      email: 'demo@miles.com',
      username: 'Demo',
      wallet_usd: 100,
      wallet_ngn: 160000,
    };
    next();
  }
};

module.exports = { authMiddleware, optionalAuth, getUserLocation, getClientIp };