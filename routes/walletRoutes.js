const express = require('express');
const { supabase } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService } = require('../services/ledgerService');
const IdempotencyService = require('../services/idempotencyService');

const router = express.Router();

// Get user balance (uses RLS - users can only see their own)
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('wallet_ngn, wallet_usd')
      .eq('id', req.user.id)
      .single();
    
    if (error) throw error;
    
    res.json({
      success: true,
      data: {
        ngn: data.wallet_ngn || 0,
        usd: data.wallet_usd || 0
      }
    });
  } catch (error) {
    console.error('Balance fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// Debit wallet (for purchases)
router.post('/debit', authMiddleware, async (req, res) => {
  try {
    const { amount, currency } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    if (!currency || !['NGN', 'USD'].includes(currency)) {
      return res.status(400).json({ error: 'Invalid currency' });
    }
    
    // Call the secure function
    const { data, error } = await supabase.rpc('secure_update_wallet', {
      p_user_id: req.user.id,
      p_amount: amount,
      p_currency: currency,
      p_operation: 'debit'
    });
    
    if (error) throw error;
    
    res.json({
      success: true,
      message: 'Payment processed successfully',
      data: {
        new_balance: data.new_balance,
        currency: data.currency
      }
    });
    
  } catch (error) {
    if (error.message === 'Insufficient balance') {
      res.status(400).json({ error: 'Insufficient balance' });
    } else {
      console.error('Debit error:', error);
      res.status(500).json({ error: error.message || 'Transaction failed' });
    }
  }
});

// Credit wallet (for deposits - admin only or payment confirmation)
router.post('/credit', authMiddleware, async (req, res) => {
  try {
    const { amount, currency } = req.body;
    
    // Call the secure function
    const { data, error } = await supabase.rpc('secure_update_wallet', {
      p_user_id: req.user.id,
      p_amount: amount,
      p_currency: currency,
      p_operation: 'credit'
    });
    
    if (error) throw error;
    
    res.json({
      success: true,
      message: 'Wallet credited successfully',
      data: {
        new_balance: data.new_balance,
        currency: data.currency
      }
    });
    
  } catch (error) {
    console.error('Credit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update profile (non-wallet fields only - trigger will block wallet updates)
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { username, full_name, phone, avatar_url } = req.body;
    
    const updates = {};
    if (username) updates.username = username;
    if (full_name) updates.full_name = full_name;
    if (phone) updates.phone = phone;
    if (avatar_url) updates.avatar_url = avatar_url;
    
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, message: 'Profile updated', data });
  } catch (error) {
    if (error.message.includes('wallet')) {
      res.status(403).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update profile' });
    }
  }
});

module.exports = router;