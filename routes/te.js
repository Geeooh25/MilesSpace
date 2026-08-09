
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');
const { supabaseAdmin } = require('../db/supabase');

const BUSHA_SECRET_KEY = process.env.BUSHA_SECRET_KEY;
const BUSHA_API_URL = process.env.BUSHA_API_URL || 'https://api.busha.co/v1';
const BUSHA_TIMEOUT = 30000; // 30s
const BUSHA_RETRY_DELAY = 1000;

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

// ─── BUSHA API CALL WITH RETRY ───
async function bushaRequest(method, endpoint, data = null, retries = 2) {
  const url = `${BUSHA_API_URL}${endpoint}`;
  const headers = { Authorization: `Bearer ${BUSHA_SECRET_KEY}` };
  if (data) headers['Content-Type'] = 'application/json';

  for (let i = 0; i <= retries; i++) {
    try {
      const config = { headers, timeout: BUSHA_TIMEOUT };
      const response = method === 'GET'
        ? await axios.get(url, config)
        : await axios.post(url, data, config);
      return response.data;
    } catch (error) {
      console.warn(`⚠️ Busha request failed (attempt ${i+1}/${retries+1}): ${error.message}`);
      if (i === retries) throw error;
      await new Promise(r => setTimeout(r, BUSHA_RETRY_DELAY * (i + 1)));
    }
  }
}

// ─── GET /api/busha/test ───
router.get('/test', authMiddleware, async (req, res) => {
  try {
    const data = await bushaRequest('GET', '/pairs', null, 1);
    res.json({
      success: true,
      message: `Connected to Busha ${BUSHA_API_URL.includes('sandbox') ? 'Sandbox' : 'Production'}`,
      pairs: data.data?.length || 0
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /api/busha/rates ───
router.get('/rates', authMiddleware, async (req, res) => {
  try {
    const { vs = 'NGN' } = req.query;
    console.log(`📡 Fetching Busha rates for ${vs}...`);

    const data = await bushaRequest('GET', '/pairs', null, 2);
    const suffix = vs === 'NGN' ? 'NGN' : 'USDT';
    const pairs = data.data.filter(p => p.id.endsWith(suffix));
    const rates = {};
    pairs.forEach(p => {
      const coin = p.base;
      const rate = parseFloat(p.sell_price?.amount) || 0;
      if (rate > 0) rates[coin] = rate;
    });

    console.log(`✅ Busha rates fetched: ${Object.keys(rates).length} coins (${vs})`);
    res.json({ success: true, data: rates });
  } catch (error) {
    console.error('❌ Busha rates error:', error.message);
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message || 'Failed to fetch rates';
    res.status(status).json({ success: false, error: message });
  }
});

// ─── POST /api/busha/quote ───
router.post('/quote', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { coin, amount, network, address } = req.body;

    if (!coin || !amount || amount < 1000) {
      return res.status(400).json({ success: false, error: 'Valid amount and coin required' });
    }

    console.log(`📡 Creating Busha quote for ${coin}, amount ${amount} NGN`);

    // 1. Get rate from Busha (use pair endpoint)
    const pair = `${coin}NGN`;
    const rateData = await bushaRequest('GET', `/pairs/${pair}`, null, 2);
    const rate = parseFloat(rateData.data.sell_price.amount);
    if (!rate) throw new Error('Could not fetch rate');

    // 2. Create quote
    const quotePayload = {
      source_currency: 'NGN',
      target_currency: coin,
      source_amount: amount.toString(),
    };
    const quoteData = await bushaRequest('POST', '/quotes', quotePayload, 2);
    const quoteId = quoteData.data.id;

    // 3. Create transfer to get bank details
    const transferPayload = { quote_id: quoteId };
    const transferData = await bushaRequest('POST', '/transfers', transferPayload, 2);
    const transfer = transferData.data;

    // 4. Save order in database
    const { data: order, error: dbError } = await supabaseAdmin
      .from('crypto_purchases')
      .insert({
        user_id: userId,
        coin,
        amount_ngn: amount,
        rate,
        crypto_amount: amount / rate,
        wallet_address: address || '',
        network: network || 'BTC',
        quote_id: quoteId,
        transfer_id: transfer.id,
        status: 'pending',
        bank_name: transfer.bank_name,
        bank_account: transfer.account_number,
        account_name: transfer.account_name,
        reference: transfer.reference || quoteId,
        expires_at: new Date(Date.now() + 120 * 1000).toISOString(),
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (dbError) throw dbError;

    // Return bank details to frontend
    res.json({
      success: true,
      data: {
        quote_id: quoteId,
        order_id: order.id,
        bank_name: transfer.bank_name,
        account_number: transfer.account_number,
        account_name: transfer.account_name,
        amount_to_send: amount + 1000, // service fee
        reference: transfer.reference || quoteId,
        expires_in: 120
      }
    });
  } catch (error) {
    console.error('❌ Busha quote error:', error.message);
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message || 'Failed to create quote';
    res.status(status).json({ success: false, error: message });
  }
});

// ─── POST /api/busha/order ───
router.post('/order', authMiddleware, async (req, res) => {
  try {
    const { quote_id, address, network } = req.body;
    if (!quote_id) return res.status(400).json({ success: false, error: 'quote_id required' });

    const { data: order, error } = await supabaseAdmin
      .from('crypto_purchases')
      .select('*')
      .eq('quote_id', quote_id)
      .eq('status', 'pending')
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found or already processed' });
    }

    const updates = {};
    if (address) updates.wallet_address = address;
    if (network) updates.network = network;

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('crypto_purchases')
      .update(updates)
      .eq('id', order.id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({
      success: true,
      data: { order_id: order.id, status: 'pending' }
    });
  } catch (error) {
    console.error('❌ Busha order error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /api/busha/confirm/:orderId ───
router.post('/confirm/:orderId', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    const { data: order, error } = await supabaseAdmin
      .from('crypto_purchases')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Order already processed' });
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('crypto_purchases')
      .update({ status: 'processing' })
      .eq('id', order.id)
      .select()
      .single();

    if (updateError) throw updateError;

    await createNotification(
      userId,
      'Payment Confirmed',
      `Your purchase of ${order.coin} is being processed. You'll receive it shortly.`,
      'info',
      '/buy-crypto'
    );

    res.json({
      success: true,
      data: { order_id: order.id, status: 'processing' }
    });
  } catch (error) {
    console.error('❌ Busha confirm error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /api/busha/status/:orderId ───
router.get('/status/:orderId', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    const { data: order, error } = await supabaseAdmin
      .from('crypto_purchases')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({
      success: true,
      data: {
        order_id: order.id,
        status: order.status,
        tx_hash: order.tx_hash || null
      }
    });
  } catch (error) {
    console.error('❌ Busha status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Webhook ───
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = req.body;
    console.log('📩 Busha webhook received:', event.type);

    if (event.type === 'transfer.succeeded') {
      const transferId = event.data.id;
      const { data: order, error } = await supabaseAdmin
        .from('crypto_purchases')
        .select('*')
        .eq('transfer_id', transferId)
        .single();

      if (error || !order) {
        console.warn('Order not found for transfer_id:', transferId);
        return res.status(404).json({ error: 'Order not found' });
      }

      await supabaseAdmin
        .from('crypto_purchases')
        .update({
          status: 'completed',
          tx_hash: event.data.tx_hash || null,
          completed_at: new Date().toISOString()
        })
        .eq('id', order.id);

      await createNotification(
        order.user_id,
        'Crypto Purchase Completed ✅',
        `Your ${order.coin} has been sent to your wallet.`,
        'deposit_completed',
        '/buy-crypto'
      );
    }
    if (event.type === 'transfer.failed') {
      const transferId = event.data.id;
      const { data: order, error } = await supabaseAdmin
        .from('crypto_purchases')
        .select('*')
        .eq('transfer_id', transferId)
        .single();

      if (!error && order) {
        await supabaseAdmin
          .from('crypto_purchases')
          .update({ status: 'failed' })
          .eq('id', order.id);

        await createNotification(
          order.user_id,
          'Crypto Purchase Failed ❌',
          `Your purchase of ${order.coin} could not be completed. Please contact support.`,
          'deposit_failed',
          '/buy-crypto'
        );
      }
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Busha webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});
