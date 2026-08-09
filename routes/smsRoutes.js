const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

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
    'sms_rented': '📱',
    'sms_cancelled': '🚫',
    'sms_refunded': '💰',
    'otp_received': '📩',
    'otp_failed': '❌',
    'info': '📌',
    'success': '✅',
    'error': '❌',
    'warning': '⚠️'
  };
  return icons[type] || '📌';
}

// ─── GET /api/sms/countries ───
router.get('/countries', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('countries')
      .select('*')
      .order('name');

    if (error) throw error;
    res.json({ success: true, countries: data || [] });
  } catch (error) {
    console.error('Countries error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /api/sms/services ───
router.get('/services', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('sms_services')
      .select('*')
      .order('name');

    if (error) throw error;
    res.json({ success: true, services: data || [] });
  } catch (error) {
    console.error('Services error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /api/sms/rent - FIXED ───
// ✅ Creates transaction + notification + auto-refund on OTP failure
// =============================================
router.post('/rent', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { country_code, service_id, wallet_type = 'NGN' } = req.body;

    if (!country_code || !service_id) {
      return res.status(400).json({ success: false, error: 'Country and service required' });
    }

    // ─── Get service details ───
    const { data: service, error: svcErr } = await supabaseAdmin
      .from('sms_services')
      .select('*')
      .eq('id', service_id)
      .single();

    if (svcErr || !service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    // ─── Get country details ───
    const { data: country, error: countryErr } = await supabaseAdmin
      .from('countries')
      .select('*')
      .eq('code', country_code)
      .single();

    if (countryErr || !country) {
      return res.status(404).json({ success: false, error: 'Country not found' });
    }

    // ─── Determine price ───
    const isUSD = wallet_type === 'USD';
    const currencyLabel = isUSD ? 'USD' : 'NGN';
    const priceNGN = service.price_ngn || 0;
    const priceUSD = service.price_usd || 0;
    const requiredAmount = isUSD ? priceUSD : priceNGN;
    const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';

    // ─── Get user balance ───
    const { data: userData, error: userErr } = await supabaseAdmin
      .from('profiles')
      .select(`${walletField}, email, username`)
      .eq('id', userId)
      .single();

    if (userErr) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const balance = parseFloat(userData?.[walletField] || 0);
    if (balance < requiredAmount) {
      return res.status(400).json({
        success: false,
        error: `Insufficient ${currencyLabel} balance. Need ${isUSD ? '$' : '₦'}${requiredAmount.toFixed(2)}`
      });
    }

    // ─── Generate phone number ───
    const phoneNumber = `+${country.code}${Math.floor(1000000000 + Math.random() * 9000000000)}`;

    // ─── Deduct wallet ───
    const newBalance = balance - requiredAmount;
    await supabaseAdmin
      .from('profiles')
      .update({ [walletField]: newBalance })
      .eq('id', userId);

    // ─── Create SMS order ───
    const orderRef = 'SMS-' + Date.now().toString(36).toUpperCase();

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('sms_orders')
      .insert({
        user_id: userId,
        country: country.name,
        country_code: country.code,
        service: service.name,
        service_id: service.id,
        phone_number: phoneNumber,
        price_ngn: priceNGN,
        price_usd: priceUSD,
        wallet_used: currencyLabel,
        status: 'pending',
        order_ref: orderRef,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (orderErr) {
      console.error('SMS order creation error:', orderErr);
      // Refund on error
      await supabaseAdmin
        .from('profiles')
        .update({ [walletField]: balance })
        .eq('id', userId);
      return res.status(500).json({ success: false, error: 'Failed to create order' });
    }

    // ─── ✅ CREATE TRANSACTION ───
    await createTransaction(
      userId,
      order.id,
      'virtual_sms',
      `Virtual number: ${service.name} (${country.name})`,
      isUSD ? 0 : requiredAmount,
      isUSD ? requiredAmount : 0,
      currencyLabel,
      'completed',
      orderRef,
      {
        country: country.name,
        country_code: country.code,
        service: service.name,
        phone_number: phoneNumber
      }
    );

    // ─── ✅ CREATE NOTIFICATION ───
    await createNotification(
      userId,
      'Virtual Number Rented 📱',
      `Your ${country.name} ${service.name} number (${phoneNumber}) is ready.`,
      'sms_rented',
      `/virtual`
    );

    // ─── Invalidate dashboard cache ───
    if (global.invalidateDashboardCache) {
      global.invalidateDashboardCache();
    }

    // ─── Simulate OTP check (in production, this would call an external API) ───
    // We'll check OTP status in a separate endpoint

    res.json({
      success: true,
      message: 'Virtual number rented successfully!',
      order: {
        id: order.id,
        order_ref: orderRef,
        phone_number: phoneNumber,
        country: country.name,
        service: service.name,
        status: 'pending',
        new_balance: newBalance,
        currency: currencyLabel
      }
    });

  } catch (error) {
    console.error('Rent error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// GET /api/sms/otp/:order_id - CHECK OTP
// ✅ Auto-refunds if no OTP received
// =============================================
router.get('/otp/:order_id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { order_id } = req.params;

    const { data: order, error } = await supabaseAdmin
      .from('sms_orders')
      .select('*')
      .eq('id', order_id)
      .eq('user_id', userId)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // ─── Simulate OTP check ───
    // In production, this would call an external SMS API
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpReceived = Math.random() > 0.3; // 70% chance

    let status = order.status;
    let message = '';

    if (otpReceived) {
      status = 'completed';
      message = 'OTP received successfully!';
      
      // Update order with OTP
      await supabaseAdmin
        .from('sms_orders')
        .update({
          status: 'completed',
          sms_code: otpCode,
          otp_received_at: new Date().toISOString()
        })
        .eq('id', order_id);

      // ✅ Send OTP notification
      await createNotification(
        userId,
        'OTP Received 📩',
        `Your OTP for ${order.service} is: ${otpCode}`,
        'otp_received',
        `/virtual`
      );

    } else {
      // ─── ❌ No OTP - AUTO-REFUND ───
      status = 'refunded';
      message = 'No OTP received. Refund processed.';

      const isUSD = order.wallet_used === 'USD';
      const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';
      const refundAmount = isUSD ? order.price_usd : order.price_ngn;

      // Get current balance
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select(walletField)
        .eq('id', userId)
        .single();

      // Refund wallet
      await supabaseAdmin
        .from('profiles')
        .update({ [walletField]: (profile[walletField] || 0) + refundAmount })
        .eq('id', userId);

      // Update order
      await supabaseAdmin
        .from('sms_orders')
        .update({
          status: 'refunded',
          refunded_at: new Date().toISOString(),
          refund_reason: 'No OTP received'
        })
        .eq('id', order_id);

      // Update transaction - reverse revenue
      await supabaseAdmin
        .from('transactions')
        .update({
          status: 'refunded',
          revenue_ngn: 0,
          revenue_usd: 0,
          description: `Refunded: No OTP received for ${order.service}`
        })
        .eq('order_id', order_id)
        .eq('type', 'virtual_sms');

      // ✅ Send notification about refund
      await createNotification(
        userId,
        'Virtual Number Refunded 💰',
        `No OTP received for ${order.service}. You have been refunded ${isUSD ? '$' : '₦'}${refundAmount.toFixed(2)}.`,
        'sms_refunded',
        `/virtual`
      );

      if (global.invalidateDashboardCache) {
        global.invalidateDashboardCache();
      }
    }

    res.json({
      success: true,
      otp: otpReceived ? otpCode : null,
      status: status,
      message: message,
      order_id: order_id
    });

  } catch (error) {
    console.error('OTP check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /api/sms/cancel - CANCEL ORDER ───
router.post('/cancel', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({ success: false, error: 'Order ID required' });
    }

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('sms_orders')
      .select('*')
      .eq('id', order_id)
      .eq('user_id', userId)
      .single();

    if (orderErr || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (order.status === 'refunded' || order.status === 'completed') {
      return res.status(400).json({ success: false, error: 'Order cannot be cancelled' });
    }

    // ─── Refund wallet ───
    const isUSD = order.wallet_used === 'USD';
    const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';
    const refundAmount = isUSD ? order.price_usd : order.price_ngn;

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select(walletField)
      .eq('id', userId)
      .single();

    await supabaseAdmin
      .from('profiles')
      .update({ [walletField]: (profile[walletField] || 0) + refundAmount })
      .eq('id', userId);

    // ─── Update order ───
    await supabaseAdmin
      .from('sms_orders')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString()
      })
      .eq('id', order_id);

    // ─── Reverse transaction ───
    await supabaseAdmin
      .from('transactions')
      .update({
        status: 'refunded',
        revenue_ngn: 0,
        revenue_usd: 0,
        description: `Refunded: Virtual number cancelled (${order.service})`
      })
      .eq('order_id', order_id)
      .eq('type', 'virtual_sms');

    await createNotification(
      userId,
      'Virtual Number Cancelled 🚫',
      `Your ${order.service} virtual number has been cancelled. Refund processed.`,
      'sms_cancelled',
      `/virtual`
    );

    if (global.invalidateDashboardCache) {
      global.invalidateDashboardCache();
    }

    res.json({
      success: true,
      message: 'Virtual number cancelled. Refund processed.',
      new_balance: (profile[walletField] || 0) + refundAmount,
      currency: order.wallet_used || 'NGN'
    });

  } catch (error) {
    console.error('Cancel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /api/sms/orders ───
router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabaseAdmin
      .from('sms_orders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, orders: data || [] });
  } catch (error) {
    console.error('SMS orders error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;