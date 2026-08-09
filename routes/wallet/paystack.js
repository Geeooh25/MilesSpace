const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { supabaseAdmin } = require('../../db/supabase');
const { authMiddleware } = require('../../middleware/auth');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5000';

console.log('✅ Paystack router loaded');

// ─── HELPERS ───
async function createNotification(userId, title, message, type = 'info', link = null) {
  const { data, error } = await supabaseAdmin.from('notifications').insert({
    user_id: userId,
    title,
    message,
    type,
    icon: type === 'deposit_completed' ? '✅' : type === 'deposit_failed' ? '❌' : '📌',
    link,
    is_read: false,
    created_at: new Date().toISOString()
  }).select().single();
  if (error) console.error('Notification error:', error);
  return data;
}

// ─── ROUTE: POST /api/wallet/paystack/initialize ───
router.post('/initialize', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;

    if (!amount || amount < 500) {
      return res.status(400).json({ success: false, error: 'Minimum deposit is ₦500' });
    }
    if (amount > 10000000) {
      return res.status(400).json({ success: false, error: 'Maximum deposit is ₦10,000,000' });
    }

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .single();

    if (profileErr || !profile) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const reference = `MILES-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const callback_url = `${FRONTEND_URL}/fund?paystack_success=true&reference=${reference}`;

    const payload = {
      email: profile.email,
      amount: Math.round(amount * 100),
      reference,
      callback_url,
      metadata: { user_id: userId }
    };

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      payload,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );

    if (!response.data.status) {
      throw new Error(response.data.message || 'Paystack initialization failed');
    }

    const { authorization_url, access_code, reference: ref } = response.data.data;

    // Save pending deposit
    await supabaseAdmin
      .from('deposit_requests')
      .insert({
        user_id: userId,
        amount_ngn: amount,
        currency: 'NGN',
        status: 'pending',
        provider: 'paystack',
        provider_reference: ref,
        paystack_reference: ref,
        paystack_access_code: access_code,
        paystack_authorization_url: authorization_url,
        created_at: new Date().toISOString()
      });

    // Save pending transaction
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        type: 'deposit',
        category: 'credit',
        description: `NGN Deposit via Paystack - ${ref}`,
        amount_ngn: amount,
        currency: 'NGN',
        status: 'pending',
        ref: ref,
        wallet_used: 'NGN',
        meta: { provider: 'paystack', reference: ref },
        created_at: new Date().toISOString()
      });

    res.json({
      success: true,
      data: { authorization_url, access_code, reference: ref, amount }
    });

  } catch (error) {
    console.error('Paystack initialize error:', error);
    res.status(500).json({ success: false, error: error.response?.data?.message || error.message || 'Payment initialization failed' });
  }
});

// ─── ROUTE: GET /api/wallet/paystack/verify/:reference ───
router.get('/verify/:reference', authMiddleware, async (req, res) => {
  try {
    const { reference } = req.params;
    const { data: deposit, error: depError } = await supabaseAdmin
      .from('deposit_requests')
      .select('*')
      .eq('paystack_reference', reference)
      .maybeSingle();

    if (depError || !deposit) {
      return res.status(404).json({ success: false, error: 'Deposit not found' });
    }

    if (deposit.status === 'completed') {
      return res.json({ success: true, data: { status: 'completed', amount: deposit.amount_ngn } });
    }

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }, timeout: 10000 }
    );

    if (!response.data.status) {
      throw new Error(response.data.message || 'Verification failed');
    }

    const { status, amount } = response.data.data;

    if (status === 'success') {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('wallet_ngn')
        .eq('id', deposit.user_id)
        .single();

      if (profile) {
        const newBalance = parseFloat(profile.wallet_ngn || 0) + parseFloat(deposit.amount_ngn);
        await supabaseAdmin
          .from('profiles')
          .update({ wallet_ngn: newBalance })
          .eq('id', deposit.user_id);

        await supabaseAdmin
          .from('deposit_requests')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('id', deposit.id);

        await supabaseAdmin
          .from('transactions')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('ref', reference)
          .eq('type', 'deposit');

        await createNotification(
          deposit.user_id,
          'Deposit Completed ✅',
          `Your deposit of ₦${parseFloat(deposit.amount_ngn).toFixed(2)} has been credited.`,
          'deposit_completed',
          '/wallet'
        );
      }
    }

    res.json({
      success: true,
      data: { status, amount: deposit.amount_ngn, reference }
    });

  } catch (error) {
    console.error('Paystack verify error:', error);
    res.status(500).json({ success: false, error: error.response?.data?.message || error.message || 'Verification failed' });
  }
});

// ─── ROUTE: POST /api/wallet/paystack/webhook ───
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const body = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha512', PAYSTACK_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('Invalid Paystack webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body;

    if (event.event === 'charge.success') {
      const { reference, amount, metadata, customer } = event.data;
      const amountNGN = amount / 100;

      let userId = metadata?.user_id || null;
      if (!userId) {
        const { data: user } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('email', customer?.email)
          .single();
        if (user) userId = user.id;
      }

      if (!userId) {
        console.error('User not found for Paystack deposit:', customer?.email);
        return res.status(404).json({ error: 'User not found' });
      }

      const { data: existing } = await supabaseAdmin
        .from('deposit_requests')
        .select('status')
        .eq('paystack_reference', reference)
        .maybeSingle();

      if (existing && existing.status === 'completed') {
        return res.status(200).json({ success: true, message: 'Already processed' });
      }

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('wallet_ngn')
        .eq('id', userId)
        .single();

      if (!profile) {
        return res.status(404).json({ error: 'User not found' });
      }

      const newBalance = parseFloat(profile.wallet_ngn || 0) + amountNGN;
      await supabaseAdmin
        .from('profiles')
        .update({ wallet_ngn: newBalance })
        .eq('id', userId);

      await supabaseAdmin
        .from('deposit_requests')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('paystack_reference', reference);

      await supabaseAdmin
        .from('transactions')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('ref', reference)
        .eq('type', 'deposit');

      await createNotification(
        userId,
        'Deposit Completed ✅',
        `Your deposit of ₦${amountNGN.toFixed(2)} has been credited.`,
        'deposit_completed',
        '/wallet'
      );

      console.log(`✅ Paystack deposit ${reference} processed for user ${userId}`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Paystack webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;