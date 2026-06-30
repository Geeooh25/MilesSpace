const express = require('express');
const { supabase } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const axios = require('axios');

const router = express.Router();

// SMMWiz Configuration
const SMMWIZ_API_URL = 'https://smmwiz.com/api/v2';
const SMMWIZ_API_KEY = process.env.SMMWIZ_API_KEY;

if (!SMMWIZ_API_KEY) {
  console.warn('⚠️ SMMWIZ_API_KEY is not set in .env');
}

// Helper to call SMMWiz
async function callSmmWiz(params) {
  try {
    const response = await axios.post(SMMWIZ_API_URL, null, {
      params: {
        key: SMMWIZ_API_KEY,
        ...params
      },
      timeout: 15000
    });

    if (response.data.error) throw new Error(response.data.error);
    return response.data;
  } catch (error) {
    console.error('SmmWiz API Error:', error.message);
    throw error;
  }
}

// ============ GET SERVICES ============
router.get('/services', authMiddleware, async (req, res) => {
  try {
    const data = await callSmmWiz({ action: 'services' });
    res.json({ success: true, services: data });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch services from SMMWiz' });
  }
});

// ============ PLACE ORDER ============
router.post('/order', authMiddleware, async (req, res) => {
  try {
    const { service_id, link, quantity, wallet_type = 'NGN' } = req.body;

    if (!service_id || !link || !quantity) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Get service rate
    const services = await callSmmWiz({ action: 'services' });
    const service = services.find(s => String(s.service) === String(service_id));

    if (!service) {
      return res.status(400).json({ success: false, error: 'Invalid service' });
    }

    const rate = parseFloat(service.rate);
    const totalUSD = (rate / 1000) * quantity;
    const USD_TO_NGN = 1620;
    const totalNGN = totalUSD * USD_TO_NGN;

    // Check user balance
    const walletField = wallet_type === 'USD' ? 'wallet_usd' : 'wallet_ngn';
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select(walletField)
      .eq('id', req.user.id)
      .single();

    if (userError) throw userError;

    const balance = parseFloat(user[walletField]) || 0;
    const required = wallet_type === 'USD' ? totalUSD : totalNGN;

    if (balance < required) {
      return res.status(400).json({
        success: false,
        error: `Insufficient ${wallet_type} balance`
      });
    }

    // Place order on SMMWiz
    const orderResponse = await callSmmWiz({
      action: 'add',
      service: service_id,
      link: link,
      quantity: quantity
    });

    // Deduct balance
    const newBalance = balance - required;
    await supabase
      .from('profiles')
      .update({ [walletField]: newBalance })
      .eq('id', req.user.id);

    // Save order locally
    const { data: savedOrder } = await supabase
      .from('boost_orders')
      .insert({
        user_id: req.user.id,
        service_id: service_id,
        service_name: service.name,
        link: link,
        quantity: quantity,
        total_amount: required,
        currency: wallet_type,
        api_order_id: orderResponse.order,
        status: 'pending'
      })
      .select()
      .single();

    res.json({
      success: true,
      message: 'Order placed successfully',
      order: savedOrder,
      smmwiz_order: orderResponse
    });

  } catch (error) {
    console.error('Order error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ GET USER ORDERS ============
router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('boost_orders')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    res.json({ success: true, orders: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

module.exports = router;