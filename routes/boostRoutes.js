// =============================================
// FILE: routes/boost.js
// Complete SMMWiz Boost System with Admin Controls
// =============================================

const express = require('express');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const axios = require('axios');
const { LedgerService } = require('../services/ledgerService');
const IdempotencyService = require('../services/idempotencyService');

const router = express.Router();

// ─── SMMWiz Configuration ───
const SMMWIZ_API_URL = 'https://smmwiz.com/api/v2';
const SMMWIZ_API_KEY = process.env.SMMWIZ_API_KEY;

if (!SMMWIZ_API_KEY) {
  console.warn('⚠️ SMMWIZ_API_KEY is not set in .env');
}

// ─── Transaction Types Constants ───
const TX_TYPES = {
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
  BOOST: 'boost',
  MARKETPLACE: 'marketplace',
  GIFT_CARD: 'gift_card',
  VIRTUAL_SMS: 'virtual_sms',
  CASHBACK: 'cashback',
  CRYPTO: 'crypto',
  TRANSFER: 'transfer',
  REFUND: 'refund',
  FEE: 'fee'
};

// ─── Status Constants ───
const ORDER_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  IN_PROGRESS: 'in_progress',
  PARTIAL: 'partial',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled'
};

// ─── Helper: Get USD to NGN Rate from Config ───
async function getUsdToNgnRate() {
  try {
    // Try to get from database config
    const { data, error } = await supabaseAdmin
      .from('app_config')
      .select('value')
      .eq('key', 'usd_to_ngn_rate')
      .single();

    if (!error && data) {
      return parseFloat(data.value) || 1620;
    }

    // Fallback to env
    return parseFloat(process.env.USD_TO_NGN_RATE) || 1620;
  } catch (error) {
    console.warn('Failed to fetch USD rate from DB, using fallback:', error.message);
    return 1620;
  }
}

// ─── Helper: Get Markup from Config ───
async function getMarkup() {
  try {
    const { data, error } = await supabaseAdmin
      .from('app_config')
      .select('value')
      .eq('key', 'boost_markup_percent')
      .single();

    if (!error && data) {
      return parseFloat(data.value) || 18;
    }
    return 18;
  } catch (error) {
    console.warn('Failed to fetch markup from DB, using fallback:', error.message);
    return 18;
  }
}

// ─── Helper: Call SMMWiz ───
async function callSmmWiz(params) {
  if (!SMMWIZ_API_KEY) {
    throw new Error('SMMWIZ_API_KEY is not configured');
  }

  try {
    const response = await axios.post(SMMWIZ_API_URL, null, {
      params: {
        key: SMMWIZ_API_KEY,
        ...params
      },
      timeout: 15000
    });

    if (response.data.error) {
      throw new Error(response.data.error);
    }

    return response.data;
  } catch (error) {
    if (error.response) {
      console.error('SMMWiz API Response Error:', error.response.data);
      throw new Error(error.response.data?.error || 'SMMWiz API error');
    }
    console.error('SMMWiz API Error:', error.message);
    throw error;
  }
}

// ─── Helper: Create Transaction (Fixed Schema) ───
async function createTransaction({
  userId,
  orderId = null,
  type,
  amount,
  currency,
  status = 'pending',
  reference = null,
  description = '',
  fee = 0,
  idempotencyKey = null,
  metadata = {},
  provider = null,
  providerReference = null
}) {
  try {
    const transactionData = {
      user_id: userId,
      type,
      status,
      currency,
      amount: parseFloat(amount),
      fee: parseFloat(fee) || 0,
      reference,
      idempotency_key: idempotencyKey,
      description,
      metadata: {
        ...metadata,
        ...(orderId && { order_id: orderId })
      },
      order_id: orderId,
      provider,
      provider_reference: providerReference,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Set completion/failure timestamps based on status
    if (status === 'completed' || status === 'refunded') {
      transactionData.completed_at = new Date().toISOString();
    }
    if (status === 'failed') {
      transactionData.failed_at = new Date().toISOString();
    }
    if (status === 'refunded') {
      transactionData.reversed_at = new Date().toISOString();
    }

    const { data, error } = await supabaseAdmin
      .from('transactions')
      .insert(transactionData)
      .select()
      .single();

    if (error) {
      console.error('❌ Transaction creation failed:', error);
      throw new Error(`Transaction creation failed: ${error.message}`);
    }

    console.log(`✅ Transaction created: ${reference || data.id} | ${currency} ${amount}`);
    return data;

  } catch (error) {
    console.error('❌ createTransaction error:', error);
    throw error;
  }
}

// ─── Helper: Create Notification ───
async function createNotification(userId, title, message, type = 'info', link = null) {
  try {
    const icons = {
      'boost_placed': '📈',
      'boost_processing': '⏳',
      'boost_completed': '✅',
      'boost_partial': '⚠️',
      'boost_failed': '❌',
      'boost_refunded': '💰',
      'info': '📌',
      'success': '✅',
      'error': '❌',
      'warning': '⚠️'
    };

    const { data, error } = await supabaseAdmin
      .from('notifications')
      .insert({
        user_id: userId,
        title: title,
        message: message,
        type: type,
        icon: icons[type] || '📌',
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

// ─── Helper: Atomic Wallet Debit ───
async function debitWallet(userId, currency, amount) {
  if (amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }

  const field = currency === 'USD' ? 'wallet_usd' : 'wallet_ngn';

  const { data: result, error } = await supabaseAdmin.rpc('debit_wallet', {
    p_user_id: userId,
    p_currency: currency,
    p_amount: amount
  });

  if (error) {
    console.error('Wallet debit error:', error);
    if (error.message.includes('Insufficient')) {
      throw new Error(`Insufficient ${currency} balance`);
    }
    throw new Error('Failed to debit wallet');
  }

  if (result === null) {
    throw new Error(`Insufficient ${currency} balance`);
  }

  return result;
}

// ─── Helper: Atomic Wallet Credit ───
async function creditWallet(userId, currency, amount) {
  if (amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }

  const field = currency === 'USD' ? 'wallet_usd' : 'wallet_ngn';

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ [field]: supabaseAdmin.raw(`${field} + ?`, amount) })
    .eq('id', userId)
    .select(field)
    .single();

  if (error) {
    console.error('Wallet credit error:', error);
    throw new Error('Failed to credit wallet');
  }

  return data[field];
}

// ─── Helper: Normalize SMMWiz Status ───
function normalizeBoostStatus(status) {
  const value = String(status || '').toLowerCase().trim();

  if (value === 'pending') return ORDER_STATUS.PENDING;
  if (['in progress', 'in_progress', 'processing', 'started'].includes(value)) return ORDER_STATUS.PROCESSING;
  if (value === 'in progress') return ORDER_STATUS.IN_PROGRESS;
  if (value === 'partial') return ORDER_STATUS.PARTIAL;
  if (['completed', 'complete', 'finished', 'done'].includes(value)) return ORDER_STATUS.COMPLETED;
  if (['failed', 'canceled', 'cancelled', 'error'].includes(value)) return ORDER_STATUS.FAILED;
  if (value === 'refunded') return ORDER_STATUS.REFUNDED;

  return ORDER_STATUS.PENDING;
}

// ─── Helper: Get Service Rate ───
async function getServiceRate(serviceId) {
  try {
    const services = await callSmmWiz({ action: 'services' });
    const service = services.find(s => String(s.service) === String(serviceId));
    if (!service) {
      throw new Error('Service not found');
    }
    return {
      service,
      rate: parseFloat(service.rate) || 0,
      name: service.name,
      min: parseInt(service.min) || 0,
      max: parseInt(service.max) || 0
    };
  } catch (error) {
    console.error('Get service rate error:', error);
    throw error;
  }
}

// =============================================
// 🏠 GET /api/boost/config - Public config
// =============================================
router.get('/config', async (req, res) => {
  try {
    const usdRate = await getUsdToNgnRate();
    const markup = await getMarkup();

    res.json({
      success: true,
      config: {
        usd_to_ngn: usdRate,
        markup_percent: markup
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// 📊 GET /api/boost/services - Get all services
// =============================================
router.get('/services', authMiddleware, async (req, res) => {
  try {
    const data = await callSmmWiz({ action: 'services' });
    
    // Add calculated NGN prices
    const usdRate = await getUsdToNgnRate();
    const markup = await getMarkup();
    
    const services = (data || []).map(s => ({
      ...s,
      price_usd: (parseFloat(s.rate) / 1000) * (1 + markup / 100),
      price_ngn: (parseFloat(s.rate) / 1000) * (1 + markup / 100) * usdRate
    }));

    res.json({ success: true, services });
  } catch (error) {
    console.error('Fetch services error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch services from SMMWiz' 
    });
  }
});

// =============================================
// 📦 POST /api/boost/order - Place boost order
// =============================================
router.post('/order', authMiddleware, async (req, res) => {
  try {
    const { service_id, link, quantity, wallet_type = 'NGN' } = req.body;

    // ─── Validation ───
    if (!service_id || !link || !quantity) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: service_id, link, quantity' 
      });
    }

    if (!link.startsWith('http://') && !link.startsWith('https://')) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL must start with http:// or https://' 
      });
    }

    // ─── Get service details ───
    const { service, rate, name, min, max } = await getServiceRate(service_id);
    const markup = await getMarkup();
    const usdRate = await getUsdToNgnRate();

    const totalUSD = (rate / 1000) * quantity * (1 + markup / 100);
    const totalNGN = totalUSD * usdRate;

    // ─── Validate quantity ───
    if (quantity < min) {
      return res.status(400).json({ 
        success: false, 
        error: `Minimum quantity is ${min}` 
      });
    }
    if (quantity > max) {
      return res.status(400).json({ 
        success: false, 
        error: `Maximum quantity is ${max}` 
      });
    }

    // ─── Check wallet balance ───
    const isUSD = wallet_type === 'USD';
    const requiredAmount = isUSD ? totalUSD : totalNGN;

    const { data: user, error: userError } = await supabaseAdmin
      .from('profiles')
      .select('wallet_ngn, wallet_usd, email, username')
      .eq('id', req.user.id)
      .single();

    if (userError) throw userError;

    const balance = isUSD ? parseFloat(user.wallet_usd) || 0 : parseFloat(user.wallet_ngn) || 0;
    if (balance < requiredAmount) {
      return res.status(400).json({
        success: false,
        error: `Insufficient ${wallet_type} balance. Need ${isUSD ? '$' : '₦'}${requiredAmount.toFixed(2)}, have ${isUSD ? '$' : '₦'}${balance.toFixed(2)}`
      });
    }

    // ─── Atomic wallet debit ───
    try {
      await debitWallet(req.user.id, wallet_type, requiredAmount);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    // ─── Place order on SMMWiz ───
    let orderResponse;
    try {
      orderResponse = await callSmmWiz({
        action: 'add',
        service: service_id,
        link: link,
        quantity: quantity
      });
    } catch (error) {
      // Refund wallet if SMMWiz fails
      await creditWallet(req.user.id, wallet_type, requiredAmount);
      return res.status(500).json({
        success: false,
        error: 'Failed to place order with provider. You have been refunded.'
      });
    }

    // ─── Generate order reference ───
    const orderRef = 'BOOST-' + Date.now().toString(36).toUpperCase() + '-' + 
                     Math.random().toString(36).substring(2, 6).toUpperCase();

    // ─── Save order locally ───
    const { data: savedOrder, error: orderError } = await supabaseAdmin
      .from('boost_orders')
      .insert({
        user_id: req.user.id,
        order_ref: orderRef,
        service_id: service_id,
        service_name: name,
        link: link,
        quantity: quantity,
        total_amount: requiredAmount,
        currency: wallet_type,
        api_order_id: orderResponse.order || orderResponse.id,
        status: ORDER_STATUS.PENDING,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (orderError) {
      console.error('Order save error:', orderError);
      // Refund the user
      await creditWallet(req.user.id, wallet_type, requiredAmount);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to save order. You have been refunded.' 
      });
    }

    // ─── Create Transaction ───
    try {
      await createTransaction({
        userId: req.user.id,
        orderId: savedOrder.id,
        type: TX_TYPES.BOOST,
        amount: -requiredAmount,
        currency: wallet_type,
        status: 'completed',
        reference: orderRef,
        description: `Social Boost: ${name} (${quantity} units)`,
        metadata: {
          service_id: service_id,
          service_name: name,
          quantity: quantity,
          link: link,
          api_order_id: orderResponse.order || orderResponse.id,
          rate: rate,
          markup: markup,
          usd_rate: usdRate
        },
        provider: 'smmwiz',
        providerReference: orderResponse.order || orderResponse.id
      });
    } catch (error) {
      console.error('Transaction creation error:', error);
      // We don't refund here because the order succeeded, but log the error
      // An admin can manually fix this transaction
    }

    // ─── Create Notification ───
    await createNotification(
      req.user.id,
      'Boost Order Placed 📈',
      `Your ${name} boost order for ${quantity} units has been placed successfully. Order #${orderRef}`,
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
      provider_order_id: orderResponse.order || orderResponse.id,
      new_balance: balance - requiredAmount
    });

  } catch (error) {
    console.error('Order error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to place order' 
    });
  }
});

// =============================================
// 📋 GET /api/boost/orders - Get user's boost orders
// =============================================
router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0, status = null } = req.query;

    let query = supabaseAdmin
      .from('boost_orders')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data, error, count } = await query;

    if (error) throw error;

    res.json({
      success: true,
      orders: data || [],
      count: count || 0,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Fetch orders error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

// =============================================
// 🔍 GET /api/boost/orders/:orderRef - Get specific order status
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

    // ─── Get status from SMMWiz ───
    let providerStatus = null;
    let didUpdate = false;

    try {
      const statusResponse = await callSmmWiz({
        action: 'status',
        order: order.api_order_id
      });

      providerStatus = statusResponse;

      const apiStatus = normalizeBoostStatus(statusResponse.status);
      
      if (apiStatus !== order.status) {
        // ─── Update local order status ───
        const updateData = { 
          status: apiStatus,
          updated_at: new Date().toISOString()
        };

        if (apiStatus === ORDER_STATUS.COMPLETED) {
          updateData.completed_at = new Date().toISOString();
        }

        await supabaseAdmin
          .from('boost_orders')
          .update(updateData)
          .eq('id', order.id);

        didUpdate = true;

        // ─── Handle status-specific actions ───
        if (apiStatus === ORDER_STATUS.COMPLETED) {
          await createNotification(
            order.user_id,
            'Boost Order Completed ✅',
            `Your ${order.service_name} boost order (${order.order_ref}) is now complete!`,
            'boost_completed',
            `/history`
          );
        } 
        else if (apiStatus === ORDER_STATUS.PROCESSING || apiStatus === ORDER_STATUS.IN_PROGRESS) {
          await createNotification(
            order.user_id,
            'Boost Order Processing ⏳',
            `Your ${order.service_name} boost order (${order.order_ref}) is now processing.`,
            'boost_processing',
            `/history`
          );
        }
        else if (apiStatus === ORDER_STATUS.PARTIAL) {
          await createNotification(
            order.user_id,
            'Boost Order Partial ⚠️',
            `Your ${order.service_name} boost order (${order.order_ref}) is partially delivered.`,
            'boost_partial',
            `/history`
          );
        }
        else if (apiStatus === ORDER_STATUS.FAILED) {
          // ─── Handle failed order: refund user ───
          const isUSD = order.currency === 'USD';
          
          // Credit wallet
          await creditWallet(order.user_id, order.currency, order.total_amount);
          
          // Update order status
          await supabaseAdmin
            .from('boost_orders')
            .update({ 
              status: ORDER_STATUS.FAILED,
              failed_at: new Date().toISOString()
            })
            .eq('id', order.id);

          // Create refund transaction
          await createTransaction({
            userId: order.user_id,
            orderId: order.id,
            type: TX_TYPES.REFUND,
            amount: order.total_amount,
            currency: order.currency,
            status: 'completed',
            reference: `REFUND-${order.order_ref}`,
            description: `Refund for failed boost: ${order.service_name}`,
            metadata: {
              original_reference: order.order_ref,
              original_type: TX_TYPES.BOOST,
              reason: 'provider_failed'
            },
            provider: 'smmwiz',
            providerReference: order.api_order_id
          });

          await createNotification(
            order.user_id,
            'Boost Order Failed ❌',
            `Your ${order.service_name} boost order (${order.order_ref}) failed. ${isUSD ? '$' : '₦'}${order.total_amount.toFixed(2)} has been refunded.`,
            'boost_failed',
            `/history`
          );
        }
        else if (apiStatus === ORDER_STATUS.REFUNDED) {
          await createNotification(
            order.user_id,
            'Boost Order Refunded 💰',
            `Your ${order.service_name} boost order (${order.order_ref}) has been refunded.`,
            'boost_refunded',
            `/history`
          );
        }

        if (global.invalidateDashboardCache) {
          global.invalidateDashboardCache();
        }
      }
    } catch (error) {
      console.error('Failed to fetch provider status:', error.message);
      providerStatus = { error: 'Could not fetch status from provider' };
    }

    // ─── Get transaction reference ───
    let transaction = null;
    try {
      const { data: txData } = await supabaseAdmin
        .from('transactions')
        .select('reference')
        .eq('order_id', order.id)
        .eq('type', TX_TYPES.BOOST)
        .single();
      transaction = txData;
    } catch (e) {
      // Transaction may not exist
    }

    // ─── Get refund transaction if exists ───
    let refund = null;
    if (order.status === ORDER_STATUS.FAILED || order.status === ORDER_STATUS.REFUNDED) {
      try {
        const { data: refundData } = await supabaseAdmin
          .from('transactions')
          .select('amount, currency, reference, created_at')
          .eq('order_id', order.id)
          .eq('type', TX_TYPES.REFUND)
          .single();
        refund = refundData;
      } catch (e) {
        // No refund yet
      }
    }

    res.json({
      success: true,
      order: {
        ...order,
        updated: didUpdate,
        provider_status: providerStatus,
        transaction_reference: transaction?.reference || null,
        refund: refund
      }
    });

  } catch (error) {
    console.error('Fetch order status error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch order status' });
  }
});

// =============================================
// 🔄 POST /api/boost/sync - Sync all pending orders (Admin)
// =============================================
router.post('/sync', adminMiddleware, async (req, res) => {
  try {
    const { status = ORDER_STATUS.PENDING } = req.query;

    const { data: orders, error } = await supabaseAdmin
      .from('boost_orders')
      .select('*')
      .in('status', [ORDER_STATUS.PENDING, ORDER_STATUS.PROCESSING, ORDER_STATUS.IN_PROGRESS, ORDER_STATUS.PARTIAL])
      .order('created_at', { ascending: true });

    if (error) throw error;

    let synced = 0;
    let failed = 0;
    let updated = [];

    for (const order of orders || []) {
      try {
        const statusResponse = await callSmmWiz({
          action: 'status',
          order: order.api_order_id
        });

        const apiStatus = normalizeBoostStatus(statusResponse.status);
        
        if (apiStatus !== order.status) {
          await supabaseAdmin
            .from('boost_orders')
            .update({
              status: apiStatus,
              updated_at: new Date().toISOString(),
              ...(apiStatus === ORDER_STATUS.COMPLETED && { completed_at: new Date().toISOString() })
            })
            .eq('id', order.id);
          
          synced++;
          updated.push({
            order_ref: order.order_ref,
            old_status: order.status,
            new_status: apiStatus
          });

          // Handle failed orders with refund
          if (apiStatus === ORDER_STATUS.FAILED) {
            await creditWallet(order.user_id, order.currency, order.total_amount);
            
            await createTransaction({
              userId: order.user_id,
              orderId: order.id,
              type: TX_TYPES.REFUND,
              amount: order.total_amount,
              currency: order.currency,
              status: 'completed',
              reference: `REFUND-${order.order_ref}`,
              description: `Auto-refund for failed boost: ${order.service_name}`,
              metadata: {
                original_reference: order.order_ref,
                original_type: TX_TYPES.BOOST,
                reason: 'provider_failed_auto'
              },
              provider: 'smmwiz',
              providerReference: order.api_order_id
            });
          }
        }
      } catch (error) {
        failed++;
        console.error(`Failed to sync order ${order.order_ref}:`, error.message);
      }
    }

    if (global.invalidateDashboardCache) {
      global.invalidateDashboardCache();
    }

    res.json({
      success: true,
      message: `Sync complete: ${synced} updated, ${failed} failed`,
      synced,
      failed,
      updated
    });

  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ success: false, error: 'Sync failed' });
  }
});

// =============================================
// 📊 GET /api/boost/stats - Get boost stats
// =============================================
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabaseAdmin
      .from('boost_orders')
      .select('status, total_amount, currency')
      .eq('user_id', userId);

    if (error) throw error;

    let totalOrders = data?.length || 0;
    let completed = 0;
    let pending = 0;
    let failed = 0;
    let processing = 0;
    let totalSpentNGN = 0;
    let totalSpentUSD = 0;

    for (const order of data || []) {
      if (order.status === ORDER_STATUS.COMPLETED) completed++;
      else if (order.status === ORDER_STATUS.PENDING) pending++;
      else if (order.status === ORDER_STATUS.FAILED || order.status === ORDER_STATUS.REFUNDED) failed++;
      else if ([ORDER_STATUS.PROCESSING, ORDER_STATUS.IN_PROGRESS, ORDER_STATUS.PARTIAL].includes(order.status)) processing++;

      if (order.currency === 'NGN') {
        totalSpentNGN += parseFloat(order.total_amount) || 0;
      } else if (order.currency === 'USD') {
        totalSpentUSD += parseFloat(order.total_amount) || 0;
      }
    }

    res.json({
      success: true,
      stats: {
        totalOrders,
        completed,
        pending,
        processing,
        failed,
        totalSpentNGN,
        totalSpentUSD
      }
    });

  } catch (error) {
    console.error('Fetch stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// =============================================
// ⚙️ ADMIN: GET /api/boost/admin/config - Get boost config
// =============================================
router.get('/admin/config', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('app_config')
      .select('*')
      .in('key', ['usd_to_ngn_rate', 'boost_markup_percent']);

    if (error) throw error;

    const config = {};
    (data || []).forEach(item => {
      config[item.key] = parseFloat(item.value);
    });

    // Check if SMMWiz is configured
    const hasSmmWizKey = !!SMMWIZ_API_KEY;

    res.json({
      success: true,
      config: {
        usd_to_ngn: config.usd_to_ngn_rate || 1620,
        markup_percent: config.boost_markup_percent || 18,
        smmwiz_configured: hasSmmWizKey
      }
    });

  } catch (error) {
    console.error('Get admin config error:', error);
    res.status(500).json({ success: false, error: 'Failed to get config' });
  }
});

// =============================================
// ⚙️ ADMIN: PUT /api/boost/admin/config - Update boost config
// =============================================
router.put('/admin/config', adminMiddleware, async (req, res) => {
  try {
    const { usd_to_ngn, markup_percent } = req.body;

    const updates = [];

    if (usd_to_ngn !== undefined && usd_to_ngn > 0) {
      updates.push({
        key: 'usd_to_ngn_rate',
        value: String(usd_to_ngn),
        updated_at: new Date().toISOString()
      });
    }

    if (markup_percent !== undefined && markup_percent >= 0) {
      updates.push({
        key: 'boost_markup_percent',
        value: String(markup_percent),
        updated_at: new Date().toISOString()
      });
    }

    for (const update of updates) {
      const { error } = await supabaseAdmin
        .from('app_config')
        .upsert({
          key: update.key,
          value: update.value,
          updated_at: update.updated_at
        }, { onConflict: 'key' });

      if (error) throw error;
    }

    // Invalidate cache
    if (global.invalidateDashboardCache) {
      global.invalidateDashboardCache();
    }

    // Get updated config
    const { data, error } = await supabaseAdmin
      .from('app_config')
      .select('*')
      .in('key', ['usd_to_ngn_rate', 'boost_markup_percent']);

    if (error) throw error;

    const config = {};
    (data || []).forEach(item => {
      config[item.key] = parseFloat(item.value);
    });

    res.json({
      success: true,
      message: 'Configuration updated',
      config: {
        usd_to_ngn: config.usd_to_ngn_rate || 1620,
        markup_percent: config.boost_markup_percent || 18
      }
    });

  } catch (error) {
    console.error('Update admin config error:', error);
    res.status(500).json({ success: false, error: 'Failed to update config' });
  }
});

// =============================================
// 📋 ADMIN: GET /api/boost/admin/orders - Get all orders
// =============================================
router.get('/admin/orders', adminMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0, status = null, user_id = null } = req.query;

    let query = supabaseAdmin
      .from('boost_orders')
      .select(`
        *,
        profiles:user_id (
          id,
          email,
          username
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    if (user_id) {
      query = query.eq('user_id', user_id);
    }

    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data, error, count } = await query;

    if (error) throw error;

    // Get transaction references
    const orderIds = (data || []).map(o => o.id);
    let transactions = {};
    
    if (orderIds.length > 0) {
      const { data: txData } = await supabaseAdmin
        .from('transactions')
        .select('order_id, reference, amount, currency, status, type')
        .in('order_id', orderIds);
      
      (txData || []).forEach(tx => {
        transactions[tx.order_id] = tx;
      });
    }

    const orders = (data || []).map(o => ({
      ...o,
      transaction: transactions[o.id] || null
    }));

    res.json({
      success: true,
      orders,
      count: count || 0,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

  } catch (error) {
    console.error('Admin fetch orders error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

// =============================================
// 🏷️ ADMIN: PUT /api/boost/admin/order/:orderId - Update order
// =============================================
router.put('/admin/order/:orderId', adminMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, note } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    const { data: order, error: fetchError } = await supabaseAdmin
      .from('boost_orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const updateData = {
      status,
      updated_at: new Date().toISOString()
    };

    if (note) {
      updateData.admin_note = note;
    }

    if (status === ORDER_STATUS.COMPLETED) {
      updateData.completed_at = new Date().toISOString();
    }
    if (status === ORDER_STATUS.FAILED) {
      updateData.failed_at = new Date().toISOString();
    }

    const { data: updatedOrder, error: updateError } = await supabaseAdmin
      .from('boost_orders')
      .update(updateData)
      .eq('id', orderId)
      .select()
      .single();

    if (updateError) throw updateError;

    // If marking as failed, refund user
    if (status === ORDER_STATUS.FAILED && order.status !== ORDER_STATUS.FAILED) {
      await creditWallet(order.user_id, order.currency, order.total_amount);
      
      await createTransaction({
        userId: order.user_id,
        orderId: order.id,
        type: TX_TYPES.REFUND,
        amount: order.total_amount,
        currency: order.currency,
        status: 'completed',
        reference: `REFUND-ADMIN-${order.order_ref}`,
        description: `Admin refund for failed boost: ${order.service_name}`,
        metadata: {
          original_reference: order.order_ref,
          original_type: TX_TYPES.BOOST,
          reason: 'admin_action',
          admin_note: note
        }
      });

      await createNotification(
        order.user_id,
        'Boost Order Failed (Admin) ❌',
        `Your ${order.service_name} boost order (${order.order_ref}) was marked as failed by admin. ${order.currency === 'USD' ? '$' : '₦'}${order.total_amount.toFixed(2)} has been refunded.`,
        'boost_failed',
        `/history`
      );
    }

    if (global.invalidateDashboardCache) {
      global.invalidateDashboardCache();
    }

    res.json({
      success: true,
      message: 'Order updated successfully',
      order: updatedOrder
    });

  } catch (error) {
    console.error('Admin update order error:', error);
    res.status(500).json({ success: false, error: 'Failed to update order' });
  }
});

// =============================================
// 🏷️ ADMIN: GET /api/boost/admin/analytics - Get boost analytics
// =============================================
router.get('/admin/analytics', adminMiddleware, async (req, res) => {
  try {
    const { days = 30 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const { data: orders, error } = await supabaseAdmin
      .from('boost_orders')
      .select('status, total_amount, currency, created_at')
      .gte('created_at', startDate.toISOString());

    if (error) throw error;

    let totalOrders = orders?.length || 0;
    let totalRevenueNGN = 0;
    let totalRevenueUSD = 0;
    let totalRefundedNGN = 0;
    let totalRefundedUSD = 0;
    let statusCounts = {};
    let dailyRevenue = {};

    for (const order of orders || []) {
      const date = order.created_at.split('T')[0];
      const dayKey = date;

      // Status counts
      statusCounts[order.status] = (statusCounts[order.status] || 0) + 1;

      // Revenue
      if (order.status === ORDER_STATUS.COMPLETED || order.status === ORDER_STATUS.PARTIAL) {
        if (order.currency === 'NGN') {
          totalRevenueNGN += parseFloat(order.total_amount) || 0;
        } else if (order.currency === 'USD') {
          totalRevenueUSD += parseFloat(order.total_amount) || 0;
        }
      }

      // Refunds
      if (order.status === ORDER_STATUS.FAILED || order.status === ORDER_STATUS.REFUNDED) {
        if (order.currency === 'NGN') {
          totalRefundedNGN += parseFloat(order.total_amount) || 0;
        } else if (order.currency === 'USD') {
          totalRefundedUSD += parseFloat(order.total_amount) || 0;
        }
      }

      // Daily revenue
      if (!dailyRevenue[dayKey]) {
        dailyRevenue[dayKey] = { NGN: 0, USD: 0, orders: 0 };
      }
      dailyRevenue[dayKey].orders += 1;
      if (order.currency === 'NGN') {
        dailyRevenue[dayKey].NGN += parseFloat(order.total_amount) || 0;
      } else {
        dailyRevenue[dayKey].USD += parseFloat(order.total_amount) || 0;
      }
    }

    // Convert daily revenue to array
    const dailyData = Object.keys(dailyRevenue)
      .sort()
      .map(date => ({
        date,
        ngn: dailyRevenue[date].NGN,
        usd: dailyRevenue[date].USD,
        orders: dailyRevenue[date].orders
      }));

    res.json({
      success: true,
      analytics: {
        totalOrders,
        totalRevenueNGN,
        totalRevenueUSD,
        totalRefundedNGN,
        totalRefundedUSD,
        netRevenueNGN: totalRevenueNGN - totalRefundedNGN,
        netRevenueUSD: totalRevenueUSD - totalRefundedUSD,
        statusCounts,
        daily: dailyData
      }
    });

  } catch (error) {
    console.error('Admin analytics error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
});

// =============================================
// 🏠 GET /api/boost/admin/dashboard - Admin dashboard stats
// =============================================
router.get('/admin/dashboard', adminMiddleware, async (req, res) => {
  try {
    // Get total orders
    const { count: totalOrders } = await supabaseAdmin
      .from('boost_orders')
      .select('*', { count: 'exact', head: true });

    // Get pending orders
    const { count: pendingOrders } = await supabaseAdmin
      .from('boost_orders')
      .select('*', { count: 'exact', head: true })
      .eq('status', ORDER_STATUS.PENDING);

    // Get processing orders
    const { count: processingOrders } = await supabaseAdmin
      .from('boost_orders')
      .select('*', { count: 'exact', head: true })
      .in('status', [ORDER_STATUS.PROCESSING, ORDER_STATUS.IN_PROGRESS, ORDER_STATUS.PARTIAL]);

    // Get completed orders
    const { count: completedOrders } = await supabaseAdmin
      .from('boost_orders')
      .select('*', { count: 'exact', head: true })
      .eq('status', ORDER_STATUS.COMPLETED);

    // Get failed orders
    const { count: failedOrders } = await supabaseAdmin
      .from('boost_orders')
      .select('*', { count: 'exact', head: true })
      .in('status', [ORDER_STATUS.FAILED, ORDER_STATUS.REFUNDED]);

    // Get total revenue
    const { data: revenueData } = await supabaseAdmin
      .from('boost_orders')
      .select('total_amount, currency, status')
      .in('status', [ORDER_STATUS.COMPLETED, ORDER_STATUS.PARTIAL]);

    let totalNGN = 0;
    let totalUSD = 0;
    for (const item of revenueData || []) {
      if (item.currency === 'NGN') {
        totalNGN += parseFloat(item.total_amount) || 0;
      } else {
        totalUSD += parseFloat(item.total_amount) || 0;
      }
    }

    // Get unique customers
    const { data: customerData } = await supabaseAdmin
      .from('boost_orders')
      .select('user_id')
      .order('created_at', { ascending: false });

    const uniqueCustomers = new Set((customerData || []).map(o => o.user_id)).size;

    // Get recent orders (last 10)
    const { data: recentOrders } = await supabaseAdmin
      .from('boost_orders')
      .select(`
        id,
        order_ref,
        service_name,
        total_amount,
        currency,
        status,
        created_at,
        profiles:user_id (email, username)
      `)
      .order('created_at', { ascending: false })
      .limit(10);

    res.json({
      success: true,
      dashboard: {
        totalOrders,
        pendingOrders,
        processingOrders,
        completedOrders,
        failedOrders,
        totalRevenueNGN: totalNGN,
        totalRevenueUSD: totalUSD,
        uniqueCustomers,
        recentOrders: recentOrders || []
      }
    });

  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch dashboard data' });
  }
});

module.exports = router;