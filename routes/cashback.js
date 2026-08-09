// ─── routes/cashback.js ───
// Cashback Wallet Routes with Transaction PIN Protection
// UPDATED: MIN_REDEEM = 100

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

// ─── CONFIG ───
const MIN_REDEEM = 100; // ─── CHANGED: Minimum ₦100 ───
const CACHE_TTL = 60 * 1000;
const MAX_PIN_ATTEMPTS = 4;
const PIN_LOCK_DURATION = 60 * 60 * 1000; // 1 hour

// ─── IN-MEMORY CACHE ───
const cache = {
  balance: new Map(),
  recent: new Map(),
  timestamp: new Map()
};

// ─── HELPERS ───

async function getOrCreateWallet(userId) {
  let { data: wallet, error } = await supabaseAdmin
    .from('cashback_wallet')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error && error.code === 'PGRST116') {
    const { data: newWallet, error: createError } = await supabaseAdmin
      .from('cashback_wallet')
      .insert({
        user_id: userId,
        balance: 0,
        lifetime_earned: 0,
        lifetime_used: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (createError) throw new Error('Failed to create cashback wallet');
    return newWallet;
  }

  if (error) throw new Error('Failed to fetch cashback wallet');
  return wallet;
}

async function createNotification(userId, title, message, type = 'info', link = null) {
  try {
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .insert({
        user_id: userId,
        title: title,
        message: message,
        type: type,
        icon: type === 'cashback_earned' ? '⭐' : 
              type === 'cashback_used' ? '💰' : 
              type === 'cashback_failed' ? '❌' : '📌',
        link: link || '/cashback',
        is_read: false,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) console.error('Notification error:', error);
    return data;
  } catch (e) {
    console.error('Create notification error:', e);
    return null;
  }
}

async function recordTransaction(userId, type, amount, balanceBefore, balanceAfter, description, metadata = {}) {
  try {
    const { data, error } = await supabaseAdmin
      .from('cashback_transactions')
      .insert({
        user_id: userId,
        type: type,
        amount: amount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        description: description,
        metadata: metadata,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) console.error('Transaction record error:', error);
    return data;
  } catch (e) {
    console.error('Record transaction error:', e);
    return null;
  }
}

function clearUserCache(userId) {
  cache.balance.delete(userId);
  cache.recent.delete(userId);
  cache.timestamp.delete(userId);
}

// ─── PIN HELPERS ───

async function getUserProfile(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, username, email, transaction_pin_hash, transaction_pin_attempts, transaction_pin_locked_until')
    .eq('id', userId)
    .single();

  if (error) throw new Error('User not found');
  return data;
}

function isPinLocked(profile) {
  if (!profile.transaction_pin_locked_until) return false;
  return new Date(profile.transaction_pin_locked_until) > new Date();
}

function getRemainingLockTime(profile) {
  if (!profile.transaction_pin_locked_until) return 0;
  const lockUntil = new Date(profile.transaction_pin_locked_until);
  const now = new Date();
  if (lockUntil <= now) return 0;
  return Math.ceil((lockUntil - now) / 60000);
}

// ─── ROUTES ───

// ─── GET /api/cashback/balance ───
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const cached = cache.balance.get(userId);
    const ts = cache.timestamp.get(userId);
    if (cached && ts && (Date.now() - ts < CACHE_TTL)) {
      return res.json({ success: true, data: cached });
    }

    const wallet = await getOrCreateWallet(userId);

    const data = {
      balance: parseFloat(wallet.balance) || 0,
      lifetime_earned: parseFloat(wallet.lifetime_earned) || 0,
      lifetime_used: parseFloat(wallet.lifetime_used) || 0,
      updated_at: wallet.updated_at
    };

    cache.balance.set(userId, data);
    cache.timestamp.set(userId, Date.now());

    res.json({ success: true, data });
  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch balance' });
  }
});

// ─── POST /api/cashback/purchase ───
router.post('/purchase', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      service,
      amount,
      network,
      phone,
      plan,
      provider,
      meterNumber,
      meterType,
      vtpass_service,
      transaction_pin
    } = req.body;

    // ─── Validate ───
    if (!service || !['airtime', 'data', 'electricity'].includes(service)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid service. Choose: airtime, data, or electricity'
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    // ─── CHANGED: Minimum ₦100 ───
    if (amount < MIN_REDEEM) {
      return res.status(400).json({
        success: false,
        error: `Minimum redemption is ₦${MIN_REDEEM}`
      });
    }

    // ─── Service-specific validation ───
    let description = '';
    let details = '';

    if (service === 'airtime' || service === 'data') {
      if (!phone || phone.length < 10) {
        return res.status(400).json({ success: false, error: 'Valid phone number required' });
      }
      const networkLabels = { mtn: 'MTN', glo: 'Glo', airtel: 'Airtel', '9mobile': '9mobile' };
      const networkName = networkLabels[network] || network;
      
      if (service === 'airtime') {
        description = `Airtime recharge - ${networkName}`;
        details = `${networkName} · ${phone} · ₦${amount}`;
      } else {
        const planLabels = { 
          'mtn-50': '50MB', 'mtn-100': '100MB', 'mtn-200': '200MB', 
          'mtn-350': '350MB', 'mtn-500': '500MB', 'mtn-750': '750MB',
          'mtn-1000': '1GB', 'mtn-1500': '1.5GB', 'mtn-2000': '2GB',
          'mtn-2500': '2.5GB', 'mtn-3000': '3GB', 'mtn-5000': '5GB',
          'airt-50': '25MB', 'airt-100': '75MB', 'airt-200': '200MB',
          'airt-300': '350MB', 'airt-500': '750MB', 'airt-600': '1GB',
          'airt-1000': '1.5GB', 'airt-1500': '3GB', 'airt-2000': '4.5GB',
          'airt-3000': '8GB', 'airt-4000': '11GB', 'airt-5000': '15GB'
        };
        const planName = planLabels[plan] || plan || 'Data';
        description = `Data purchase - ${planName}`;
        details = `${networkName} · ${planName} · ${phone}`;
      }
    }

    if (service === 'electricity') {
      if (!meterNumber || meterNumber.length < 10) {
        return res.status(400).json({ success: false, error: 'Valid meter number required' });
      }
      const providerLabels = {
        ikeja: 'IKEDC',
        eko: 'EKEDC',
        phcn: 'PHCN',
        abuja: 'AEDC',
        ibadan: 'IBEDC'
      };
      const meterTypeLabel = meterType === 'prepaid' ? 'Prepaid' : 'Postpaid';
      description = `Electricity bill payment - ${providerLabels[provider] || provider} (${meterTypeLabel})`;
      details = `${providerLabels[provider] || provider} · Meter: ${meterNumber} · ₦${amount}`;
    }

    // ─── Get wallet ───
    const wallet = await getOrCreateWallet(userId);
    const currentBalance = parseFloat(wallet.balance) || 0;

    if (currentBalance < amount) {
      return res.status(400).json({
        success: false,
        error: `Insufficient cashback. Available: ₦${currentBalance.toFixed(2)}`
      });
    }

    // ─── VERIFY TRANSACTION PIN ───
    if (!transaction_pin) {
      return res.status(400).json({
        success: false,
        error: 'Transaction PIN required',
        pinRequired: true
      });
    }

    if (!/^\d{4}$/.test(transaction_pin)) {
      return res.status(400).json({
        success: false,
        error: 'PIN must be exactly 4 digits',
        code: 'INVALID_FORMAT'
      });
    }

    // ─── Get user profile with PIN ───
    const profile = await getUserProfile(userId);

    // ─── Check if PIN exists ───
    if (!profile.transaction_pin_hash) {
      return res.status(400).json({
        success: false,
        error: 'Transaction PIN not set. Please set a PIN first.',
        code: 'PIN_NOT_SET',
        pinNotSet: true
      });
    }

    // ─── Check PIN lock ───
    if (isPinLocked(profile)) {
      const remaining = getRemainingLockTime(profile);
      return res.status(403).json({
        success: false,
        error: `PIN is locked. Please wait ${remaining} minute${remaining > 1 ? 's' : ''}.`,
        code: 'PIN_LOCKED',
        remaining_minutes: remaining
      });
    }

    // ─── Verify PIN ───
    const isValid = await bcrypt.compare(transaction_pin, profile.transaction_pin_hash);

    if (!isValid) {
      const attempts = (profile.transaction_pin_attempts || 0) + 1;
      const updates = { transaction_pin_attempts: attempts };

      if (attempts >= MAX_PIN_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + PIN_LOCK_DURATION);
        updates.transaction_pin_locked_until = lockUntil.toISOString();
        updates.transaction_pin_attempts = 0;

        await supabaseAdmin
          .from('profiles')
          .update(updates)
          .eq('id', userId);

        await createNotification(
          userId,
          'PIN Locked 🔒',
          'Your transaction PIN has been locked for 1 hour due to too many failed attempts.',
          'info',
          '/cashback'
        );

        return res.status(403).json({
          success: false,
          error: 'Too many failed attempts. PIN locked for 1 hour.',
          code: 'PIN_LOCKED',
          remaining_minutes: 60
        });
      }

      await supabaseAdmin
        .from('profiles')
        .update(updates)
        .eq('id', userId);

      const remaining = MAX_PIN_ATTEMPTS - attempts;

      return res.status(400).json({
        success: false,
        error: `Invalid PIN. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`,
        code: 'INVALID_PIN',
        attempts_remaining: remaining
      });
    }

    // ─── PIN valid, reset attempts ───
    await supabaseAdmin
      .from('profiles')
      .update({
        transaction_pin_attempts: 0,
        transaction_pin_locked_until: null
      })
      .eq('id', userId);

    // ─── Deduct balance ───
    const newBalance = currentBalance - amount;
    const newLifetimeUsed = (parseFloat(wallet.lifetime_used) || 0) + amount;

    const { error: updateError } = await supabaseAdmin
      .from('cashback_wallet')
      .update({
        balance: newBalance,
        lifetime_used: newLifetimeUsed,
        updated_at: new Date().toISOString()
      })
      .eq('id', wallet.id);

    if (updateError) {
      console.error('Update wallet error:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to update wallet' });
    }

    // ─── Record transaction ───
    await recordTransaction(
      userId,
      'used',
      amount,
      currentBalance,
      newBalance,
      description,
      { 
        service, 
        network, 
        phone, 
        plan, 
        provider, 
        meterNumber,
        meterType,
        vtpass_service,
        details 
      }
    );

    // ─── Create notification ───
    await createNotification(
      userId,
      `💰 ${description}`,
      `You used ₦${amount.toFixed(2)} from your cashback wallet for ${description}.`,
      'cashback_used',
      '/cashback'
    );

    // ─── Clear cache ───
    clearUserCache(userId);

    // ─── Process asynchronously (VTpass API call) ───
    setImmediate(async () => {
      try {
        // ─── Call VTpass API here ───
        // This would be a separate service call
        console.log(`✅ ${service} processed for user ${userId}: ${description}`);
        console.log(`   VTpass Service: ${vtpass_service}`);
      } catch (e) {
        console.error('Provider processing error:', e);
        await createNotification(
          userId,
          `⚠️ ${description} - Pending`,
          `Your ${service} purchase is being processed. We'll notify you when complete.`,
          'info',
          '/cashback'
        );
      }
    });

    res.json({
      success: true,
      data: {
        new_balance: newBalance,
        amount_used: amount,
        description: description,
        details: details,
        message: `${description} successful!`
      }
    });
  } catch (error) {
    console.error('Purchase error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Purchase failed'
    });
  }
});

// ─── POST /api/cashback/set-pin ───
router.post('/set-pin', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { pin } = req.body;

    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        error: 'PIN must be exactly 4 digits',
        code: 'INVALID_FORMAT'
      });
    }

    const profile = await getUserProfile(userId);

    if (profile.transaction_pin_hash) {
      return res.status(400).json({
        success: false,
        error: 'PIN already set. Use change-pin to update it.',
        code: 'PIN_ALREADY_SET'
      });
    }

    const salt = await bcrypt.genSalt(10);
    const pinHash = await bcrypt.hash(pin, salt);

    await supabaseAdmin
      .from('profiles')
      .update({
        transaction_pin_hash: pinHash,
        transaction_pin_set_at: new Date().toISOString(),
        transaction_pin_attempts: 0,
        transaction_pin_locked_until: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    await createNotification(
      userId,
      'PIN Set 🔐',
      'Your transaction PIN has been set successfully.',
      'info',
      '/cashback'
    );

    res.json({ success: true, message: 'PIN set successfully' });
  } catch (error) {
    console.error('Set PIN error:', error);
    res.status(500).json({ success: false, error: 'Failed to set PIN' });
  }
});

// ─── POST /api/cashback/verify-pin ───
router.post('/verify-pin', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { pin } = req.body;

    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        error: 'PIN must be exactly 4 digits',
        code: 'INVALID_FORMAT'
      });
    }

    const profile = await getUserProfile(userId);

    if (!profile.transaction_pin_hash) {
      return res.status(400).json({
        success: false,
        error: 'PIN not set. Please set a PIN first.',
        code: 'PIN_NOT_SET',
        pinNotSet: true
      });
    }

    if (isPinLocked(profile)) {
      const remaining = getRemainingLockTime(profile);
      return res.status(403).json({
        success: false,
        error: `PIN is locked. Please wait ${remaining} minute${remaining > 1 ? 's' : ''}.`,
        code: 'PIN_LOCKED',
        remaining_minutes: remaining
      });
    }

    const isValid = await bcrypt.compare(pin, profile.transaction_pin_hash);

    if (!isValid) {
      const attempts = (profile.transaction_pin_attempts || 0) + 1;
      const updates = { transaction_pin_attempts: attempts };

      if (attempts >= MAX_PIN_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + PIN_LOCK_DURATION);
        updates.transaction_pin_locked_until = lockUntil.toISOString();
        updates.transaction_pin_attempts = 0;

        await supabaseAdmin
          .from('profiles')
          .update(updates)
          .eq('id', userId);

        return res.status(403).json({
          success: false,
          error: 'Too many failed attempts. PIN locked for 1 hour.',
          code: 'PIN_LOCKED',
          remaining_minutes: 60
        });
      }

      await supabaseAdmin
        .from('profiles')
        .update(updates)
        .eq('id', userId);

      const remaining = MAX_PIN_ATTEMPTS - attempts;

      return res.status(400).json({
        success: false,
        error: `Invalid PIN. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`,
        code: 'INVALID_PIN',
        attempts_remaining: remaining
      });
    }

    await supabaseAdmin
      .from('profiles')
      .update({
        transaction_pin_attempts: 0,
        transaction_pin_locked_until: null
      })
      .eq('id', userId);

    res.json({ success: true, message: 'PIN verified successfully' });
  } catch (error) {
    console.error('Verify PIN error:', error);
    res.status(500).json({ success: false, error: 'PIN verification failed' });
  }
});

// ─── GET /api/cashback/recent ───
router.get('/recent', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;

    const cached = cache.recent.get(userId);
    const ts = cache.timestamp.get(userId + '_recent');
    if (cached && ts && (Date.now() - ts < CACHE_TTL)) {
      return res.json({ success: true, data: cached });
    }

    const { data, error } = await supabaseAdmin
      .from('cashback_transactions')
      .select('*')
      .eq('user_id', userId)
      .eq('type', 'used')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    const formatted = (data || []).map(t => ({
      id: t.id,
      service: t.metadata?.service || 'unknown',
      amount: parseFloat(t.amount) || 0,
      description: t.description || 'Purchase',
      details: t.metadata?.details || '',
      status: 'success',
      created_at: t.created_at
    }));

    cache.recent.set(userId, formatted);
    cache.timestamp.set(userId + '_recent', Date.now());

    res.json({ success: true, data: formatted });
  } catch (error) {
    console.error('Recent error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch recent purchases' });
  }
});

// ─── GET /api/cashback/history ───
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const type = req.query.type || 'all';

    let query = supabaseAdmin
      .from('cashback_transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type !== 'all') {
      query = query.eq('type', type);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      data: data || [],
      pagination: { total: count || 0, limit, offset }
    });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
});

// ─── POST /api/cashback/earn ───
router.post('/earn', async (req, res) => {
  try {
    const { userId, amount, source, metadata = {} } = req.body;

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'User ID and amount required' });
    }

    const wallet = await getOrCreateWallet(userId);
    const currentBalance = parseFloat(wallet.balance) || 0;
    const newBalance = currentBalance + amount;
    const newLifetimeEarned = (parseFloat(wallet.lifetime_earned) || 0) + amount;

    const { error: updateError } = await supabaseAdmin
      .from('cashback_wallet')
      .update({
        balance: newBalance,
        lifetime_earned: newLifetimeEarned,
        updated_at: new Date().toISOString()
      })
      .eq('id', wallet.id);

    if (updateError) {
      console.error('Update wallet error:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to update wallet' });
    }

    await recordTransaction(
      userId,
      'earned',
      amount,
      currentBalance,
      newBalance,
      `Cashback earned from ${source}`,
      { source, ...metadata }
    );

    await createNotification(
      userId,
      '⭐ Cashback Earned!',
      `You earned ₦${amount.toFixed(2)} cashback from ${source}.`,
      'cashback_earned',
      '/cashback'
    );

    clearUserCache(userId);

    res.json({
      success: true,
      data: { new_balance: newBalance, amount_earned: amount, source }
    });
  } catch (error) {
    console.error('Earn cashback error:', error);
    res.status(500).json({ success: false, error: 'Failed to credit cashback' });
  }
});

// ─── GET /api/cashback/pin-status ───
router.get('/pin-status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await getUserProfile(userId);

    const locked = isPinLocked(profile);
    const remaining = getRemainingLockTime(profile);

    res.json({
      success: true,
      data: {
        has_pin: !!profile.transaction_pin_hash,
        set_at: profile.transaction_pin_set_at || null,
        attempts_used: profile.transaction_pin_attempts || 0,
        max_attempts: MAX_PIN_ATTEMPTS,
        is_locked: locked,
        remaining_lock_minutes: remaining,
        attempts_remaining: Math.max(0, MAX_PIN_ATTEMPTS - (profile.transaction_pin_attempts || 0))
      }
    });
  } catch (error) {
    console.error('PIN status error:', error);
    res.status(500).json({ success: false, error: 'Failed to check PIN status' });
  }
});

// ─── GET /api/cashback/test ───
router.get('/test', authMiddleware, async (req, res) => {
  res.json({
    success: true,
    message: 'Cashback router working!',
    routes: [
      'GET /balance - Get cashback balance',
      'POST /purchase - Use cashback for services (requires PIN)',
      'POST /set-pin - Set transaction PIN',
      'POST /verify-pin - Verify transaction PIN',
      'GET /pin-status - Check PIN status',
      'GET /recent - Get recent purchases',
      'GET /history - Full transaction history',
      'POST /earn - Credit cashback (internal)'
    ],
    config: {
      min_redeem: MIN_REDEEM,
      max_pin_attempts: MAX_PIN_ATTEMPTS,
      pin_lock_duration_minutes: PIN_LOCK_DURATION / 60000,
      cache_ttl_seconds: CACHE_TTL / 1000
    }
  });
});

module.exports = router;