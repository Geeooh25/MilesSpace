const express = require('express');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const axios = require('axios');

const router = express.Router();

// SMMWiz Configuration
const SMMWIZ_API_URL = 'https://smmwiz.com/api/v2';
const SMMWIZ_API_KEY = process.env.SMMWIZ_API_KEY;

if (!SMMWIZ_API_KEY) {
  console.warn('⚠️ SMMWIZ_API_KEY is not set in .env');
}

// ─── HELPER: Call SMMWiz ───
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

// ─── HELPER: Create transaction ───
async function createTransaction(userId, orderId, type, description, amountNGN, amountUSD, currency, status, ref, meta = {}) {
  try {
    const isUSD = currency === 'USD';
    const transactionData = {
      user_id: userId,
      order_id: orderId,
      type: type,
      category: 'debit',
      description: description,
      currency: currency,
      status: status,
      ref: ref,
      wallet_used: currency,
      meta: meta,
      created_at: new Date().toISOString()
    };

    if (isUSD) {
      transactionData.amount_ngn = 0;
      transactionData.amount_usd = -amountUSD;
      transactionData.revenue_ngn = 0;
      transactionData.revenue_usd = amountUSD;
    } else {
      transactionData.amount_ngn = -amountNGN;
      transactionData.amount_usd = 0;
      transactionData.revenue_ngn = amountNGN;
      transactionData.revenue_usd = 0;
    }

    const { data, error } = await supabaseAdmin
      .from('transactions')
      .insert(transactionData)
      .select()
      .single();

    if (error) {
      console.error('Transaction creation error:', error);
      return null;
    }
    return data;
  } catch (error) {
    console.error('Transaction error:', error);
    return null;
  }
}

// ─── HELPER: Create notification ───
async function createNotification(userId, title, message, type = 'info', link = null) {
  try {
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .insert({
        user_id: userId,
        title: title,
        message: message,
        type: type,
        icon: getNotificationIcon(type),
        link: link,
        is_read: false,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('Notification creation error:', error);
      return null;
    }
    return data;
  } catch (error) {
    console.error('Notification error:', error);
    return null;
  }
}

function getNotificationIcon(type) {
  const icons = {
    'boost_placed': '📈',
    'boost_completed': '✅',
    'boost_failed': '❌',
    'boost_refunded': '💰',
    'info': '📌',
    'success': '✅',
    'error': '❌',
    'warning': '⚠️'
  };
  return icons[type] || '📌';
}

// =============================================
// GET /api/boost/services
// =============================================
router.get('/services', authMiddleware, async (req, res) => {
  try {
    const data = await callSmmWiz({ action: 'services' });
    res.json({ success: true, services: data });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch services from SMMWiz' });
  }
});

// =============================================
// POST /api/boost/order - FIXED
// ✅ Creates transaction + notification + cache invalidation
// =============================================
router.post('/order', authMiddleware, async (req, res) => {
  try {
    const { service_id, link, quantity, wallet_type = 'NGN' } = req.body;

    if (!service_id || !link || !quantity) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // ─── Get service rate ───
    const services = await callSmmWiz({ action: 'services' });
    const service = services.find(s => String(s.service) === String(service_id));

    if (!service) {
      return res.status(400).json({ success: false, error: 'Invalid service' });
    }

    const rate = parseFloat(service.rate);
    const totalUSD = (rate / 1000) * quantity;
    const USD_TO_NGN = 1620;
    const totalNGN = totalUSD * USD_TO_NGN;

    // ─── Check user balance ───
    const isUSD = wallet_type === 'USD';
    const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';
    const requiredAmount = isUSD ? totalUSD : totalNGN;

    const { data: user, error: userError } = await supabaseAdmin
      .from('profiles')
      .select(`${walletField}, email, username`)
      .eq('id', req.user.id)
      .single();

    if (userError) throw userError;

    const balance = parseFloat(user[walletField]) || 0;
    if (balance < requiredAmount) {
      return res.status(400).json({
        success: false,
        error: `Insufficient ${wallet_type} balance`
      });
    }

    // ─── Place order on SMMWiz ───
    const orderResponse = await callSmmWiz({
      action: 'add',
      service: service_id,
      link: link,
      quantity: quantity
    });

    // ─── Deduct balance ───
    const newBalance = balance - requiredAmount;
    await supabaseAdmin
      .from('profiles')
      .update({ [walletField]: newBalance })
      .eq('id', req.user.id);

    // ─── Generate order ref ───
    const orderRef = 'BOOST-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();

    // ─── Save order locally ───
    const { data: savedOrder, error: orderError } = await supabaseAdmin
      .from('boost_orders')
      .insert({
        user_id: req.user.id,
        order_ref: orderRef,
        service_id: service_id,
        service_name: service.name,
        link: link,
        quantity: quantity,
        total_amount: requiredAmount,
        currency: wallet_type,
        api_order_id: orderResponse.order,
        status: 'pending',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (orderError) {
      console.error('Order save error:', orderError);
      // Refund the user
      await supabaseAdmin
        .from('profiles')
        .update({ [walletField]: balance })
        .eq('id', req.user.id);
      return res.status(500).json({ success: false, error: 'Failed to save order' });
    }

    // ─── ✅ CREATE TRANSACTION ───
    await createTransaction(
      req.user.id,
      savedOrder.id,
      'boost',
      `Social Boost: ${service.name} (${quantity} units)`,
      isUSD ? 0 : requiredAmount,
      isUSD ? requiredAmount : 0,
      wallet_type,
      'completed',
      orderRef,
      {
        service_id: service_id,
        service_name: service.name,
        quantity: quantity,
        link: link,
        api_order_id: orderResponse.order
      }
    );

    // ─── ✅ CREATE NOTIFICATION ───
    await createNotification(
      req.user.id,
      'Boost Order Placed 📈',
      `Your ${service.name} boost order for ${quantity} units has been placed successfully.`,
      'boost_placed',
      `/history`
    );

    // ─── Invalidate dashboard cache ───
    if (global.invalidateDashboardCache) {
      global.invalidateDashboardCache();
    }

    console.log(`✅ Boost order placed: ${orderRef} by user ${req.user.id}`);

    res.json({
      success: true,
      message: 'Order placed successfully',
      order: savedOrder,
      smmwiz_order: orderResponse,
      new_balance: newBalance
    });

  } catch (error) {
    console.error('Order error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// GET /api/boost/orders
// =============================================
router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('boost_orders')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, orders: data || [] });
  } catch (error) {
    console.error('Fetch orders error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

// =============================================
// GET /api/boost/orders/:orderRef - Check status
// =============================================
router.get('/orders/:orderRef', authMiddleware, async (req, res) => {
  try {
    const { orderRef } = req.params;

    const { data: order, error } = await supabaseAdmin
      .from('boost_orders')
      .select('*')
      .eq('order_ref', orderRef)
      .eq('user_id', req.user.id)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Get status from SMMWiz
    try {
      const statusResponse = await callSmmWiz({
        action: 'status',
        order: order.api_order_id
      });
      
      // Update local status if changed
      const apiStatus = statusResponse.status || 'pending';
      if (apiStatus !== order.status) {
        await supabaseAdmin
          .from('boost_orders')
          .update({ 
            status: apiStatus,
            updated_at: new Date().toISOString()
          })
          .eq('id', order.id);
        
        // If completed, send notification
        if (apiStatus === 'completed' || apiStatus === 'finished') {
          await createNotification(
            order.user_id,
            'Boost Order Completed ✅',
            `Your ${order.service_name} boost order is now complete!`,
            'boost_completed',
            `/history`
          );
        }
        
        if (apiStatus === 'failed') {
          // Refund the user
          const isUSD = order.currency === 'USD';
          const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';
          
          const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select(walletField)
            .eq('id', order.user_id)
            .single();
          
          await supabaseAdmin
            .from('profiles')
            .update({ [walletField]: (profile[walletField] || 0) + order.total_amount })
            .eq('id', order.user_id);
          
          await createNotification(
            order.user_id,
            'Boost Order Failed ❌',
            `Your ${order.service_name} boost order failed. You have been refunded.`,
            'boost_failed',
            `/history`
          );
          
          // Update transaction to refunded
          await supabaseAdmin
            .from('transactions')
            .update({ 
              status: 'refunded',
              revenue_ngn: 0,
              revenue_usd: 0,
              description: `Refunded: ${order.service_name} boost order failed`
            })
            .eq('order_id', order.id)
            .eq('type', 'boost');
        }
        
        if (global.invalidateDashboardCache) {
          global.invalidateDashboardCache();
        }
      }
      
      order.api_status = statusResponse;
    } catch (e) {
      order.api_status = { error: 'Could not fetch status' };
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error('Fetch order status error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch order status' });
  }
});

module.exports = router;