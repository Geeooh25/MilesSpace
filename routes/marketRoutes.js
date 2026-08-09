'use strict';

const express = require('express');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const crypto = require('crypto');

const router = express.Router();
const USD_NGN = 1600;

/* ════════════════════════════════════════════════
   GET /api/market/products
════════════════════════════════════════════════ */
router.get('/products', async (req, res) => {
  try {
    const { data: products, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const { data: categories } = await supabaseAdmin
      .from('categories')
      .select('id, name, slug, icon');

    const catMap = {};
    (categories || []).forEach(c => {
      catMap[c.id] = c;
    });

    const result = (products || []).map(p => {
      const cat = catMap[p.category_id] || {};
      const priceUSD = parseFloat(p.price_usd) || 0;
      const priceNGN = parseFloat(p.price_ngn) || (priceUSD * USD_NGN);

      let tags = [];
      if (Array.isArray(p.tags)) {
        tags = p.tags.map(t => String(t).trim()).filter(Boolean);
      } else if (typeof p.tags === 'string' && p.tags.trim()) {
        tags = p.tags.split(',').map(t => t.trim()).filter(Boolean);
      }

      return {
        id: p.id,
        cat: cat.slug || 'other',
        catName: cat.name || 'Other',
        catIcon: cat.icon || 'fas fa-box',
        name: p.title || 'Unknown',
        price: priceUSD,
        priceNGN: priceNGN,
        qty: parseInt(p.quantity) || 0,
        desc: p.description || '',
        login_format: p.login_format || '',
        login_instructions: p.login_instructions || '',
        country: p.country || '',
        quality: p.quality || '',
        tags,
        guarantee: p.guarantee || '48h',
        badge: p.badge || '',
        delivered_data: p.delivered_data || ''
      };
    });

    res.json({ success: true, products: result });
  } catch (error) {
    console.error('GET /products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

/* ════════════════════════════════════════════════
   POST /api/market/purchase - TRIGGER COMPLIANT
════════════════════════════════════════════════ */
router.post('/purchase', authMiddleware, async (req, res) => {
  try {
    const { product_id, wallet_type } = req.body;
    const userId = req.user.id;

    if (!product_id || !wallet_type) {
      return res.status(400).json({ error: 'Product ID and wallet type required' });
    }

    // ─── Get product ───
    const { data: product, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('id', product_id)
      .eq('status', 'active')
      .single();

    if (prodErr || !product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (product.quantity <= 0) {
      return res.status(400).json({ error: 'Out of stock' });
    }

    // ─── Determine currency and amounts ───
    const isUSD = wallet_type === 'USD';
    const costUSD = parseFloat(product.price_usd || 0);
    const costNGN = parseFloat(product.price_ngn || costUSD * USD_NGN);
    const requiredAmount = isUSD ? costUSD : costNGN;
    const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';

    // ─── Get user balance ───
    const { data: userData } = await supabaseAdmin
      .from('profiles')
      .select(`${walletField}, total_spent_usd, total_orders, completed_orders`)
      .eq('id', userId)
      .single();

    const balance = parseFloat(userData?.[walletField] || 0);
    if (balance < requiredAmount) {
      return res.status(400).json({
        error: `Insufficient balance. Need ${isUSD ? '$' : '₦'}${requiredAmount.toLocaleString()}`
      });
    }

    // ─── Generate order reference and download token ───
    const orderRef = 'ORD-' + Date.now().toString(36).toUpperCase();
    const downloadToken = crypto.randomBytes(32).toString('hex');
    const newBalance = balance - requiredAmount;

    // ─── Deduct wallet ───
    await supabaseAdmin
      .from('profiles')
      .update({ [walletField]: newBalance })
      .eq('id', userId);

    // ─── Prepare delivered data ───
    const deliveredData = {
      login_format: product.login_format || '',
      login_instructions: product.login_instructions || '',
      product_title: product.title,
      purchased_at: new Date().toISOString()
    };

    // ─── Create order ───
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        user_id: userId,
        product_id: product.id,
        product_title: product.title,
        category_name: 'marketplace',
        quantity: 1,
        price_usd: costUSD,
        price_ngn: costNGN,
        wallet_used: wallet_type,
        status: 'completed',
        order_ref: orderRef,
        delivered_data: deliveredData,
        download_token: downloadToken,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (orderError) {
      console.error('Order creation error:', orderError);
      return res.status(500).json({ error: 'Failed to create order' });
    }

    // ─── ✅ FIXED: Create transaction record (TRIGGER COMPLIANT) ───
    // When currency is NGN:
    //   - amount_usd MUST be 0
    //   - revenue_usd MUST be 0
    // When currency is USD:
    //   - amount_ngn MUST be 0
    //   - revenue_ngn MUST be 0
    
    const transactionData = {
      user_id: userId,
      order_id: order.id,
      type: 'marketplace',
      category: 'debit',
      description: `Purchased: ${product.title}`,
      currency: wallet_type,
      status: 'completed',
      ref: orderRef,
      wallet_used: wallet_type,
      meta: {
        product_id: product.id,
        product_name: product.title,
        quantity: 1,
        wallet_balance_before: balance,
        wallet_balance_after: newBalance
      },
      created_at: new Date().toISOString()
    };

    // ✅ Set amounts based on currency (ONLY ONE currency has values)
    if (isUSD) {
      // USD purchase: only USD fields have values
      transactionData.amount_ngn = 0;
      transactionData.amount_usd = -requiredAmount;
      transactionData.revenue_ngn = 0;
      transactionData.revenue_usd = requiredAmount;
    } else {
      // NGN purchase: only NGN fields have values
      transactionData.amount_ngn = -requiredAmount;
      transactionData.amount_usd = 0;
      transactionData.revenue_ngn = requiredAmount;
      transactionData.revenue_usd = 0;
    }

    const { error: txError } = await supabaseAdmin
      .from('transactions')
      .insert(transactionData);

    if (txError) {
      console.error('Transaction creation error:', txError);
      // Don't fail the purchase, but log it
    }

    // ─── Update product stock ───
    await supabaseAdmin
      .from('products')
      .update({ quantity: product.quantity - 1 })
      .eq('id', product_id);

    // ─── Update user stats ───
    const prevSpent = parseFloat(userData?.total_spent_usd || 0);
    const prevOrders = parseInt(userData?.total_orders || 0);
    const prevCompleted = parseInt(userData?.completed_orders || 0);

    await supabaseAdmin
      .from('profiles')
      .update({
        total_spent_usd: prevSpent + costUSD,
        total_orders: prevOrders + 1,
        completed_orders: prevCompleted + 1
      })
      .eq('id', userId);

    // ─── Invalidate dashboard cache ───
    if (global.invalidateDashboardCache) {
      global.invalidateDashboardCache();
    }

    // ─── Return success ───
    res.json({
      success: true,
      purchase: {
        order_ref: orderRef,
        product_name: product.title,
        price: requiredAmount,
        currency: wallet_type,
        new_balance: newBalance,
        download_token: downloadToken,
        delivered_data: deliveredData
      }
    });

  } catch (error) {
    console.error('Purchase error:', error);
    res.status(500).json({ error: error.message || 'Purchase failed' });
  }
});

/* ════════════════════════════════════════════════
   GET /api/market/download/:token
════════════════════════════════════════════════ */
router.get('/download/:token', async (req, res) => {
  try {
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('download_token', req.params.token)
      .single();

    if (error || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update download count
    await supabaseAdmin
      .from('orders')
      .update({
        download_count: (order.download_count || 0) + 1,
        last_download_at: new Date().toISOString()
      })
      .eq('id', order.id);

    const log = order.delivered_data || {};
    const content = [
      '═══════════════════════════════════════════════',
      '  📦 MILESPACE ORDER DETAILS',
      '═══════════════════════════════════════════════',
      '',
      `Order ID:    ${order.order_ref}`,
      `Product:     ${order.product_title}`,
      `Date:        ${new Date(order.created_at).toLocaleString()}`,
      `Wallet:      ${order.wallet_used || 'NGN'}`,
      `Amount:      ${order.wallet_used === 'USD' ? '$' : '₦'}${(order.wallet_used === 'USD' ? order.price_usd : order.price_ngn).toFixed(2)}`,
      `Downloads:   ${(order.download_count || 0) + 1}`,
      '',
      '────────── ACCOUNT LOGIN DETAILS ──────────',
      '',
      `Format:      ${log.login_format || 'N/A'}`,
      '',
      'Instructions:',
      log.login_instructions || 'No instructions provided.',
      '',
      '───────────────────────────────────────────',
      `Downloaded:  ${new Date().toISOString()}`,
      '═══════════════════════════════════════════════'
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="order_${order.order_ref}.txt"`);
    res.send(content);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

module.exports = router;