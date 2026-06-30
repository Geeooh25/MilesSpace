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
    // Fetch products
    const { data: products, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Products query error:', error.message);
      throw error;
    }

    // Fetch categories for lookup
    const { data: categories } = await supabaseAdmin
      .from('categories')
      .select('id, name, slug, icon');

    const catMap = {};
    (categories || []).forEach(c => {
      catMap[c.id] = c;
    });

    // Map products to frontend format
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
      };
    });

    console.log('✅ Products returned:', result.length);
    res.json({ success: true, products: result });
  } catch (error) {
    console.error('GET /products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

/* ════════════════════════════════════════════════
   POST /api/market/purchase
════════════════════════════════════════════════ */
router.post('/purchase', authMiddleware, async (req, res) => {
  try {
    const { product_id, wallet_type } = req.body;
    const userId = req.user.id;

    if (!product_id || !wallet_type) {
      return res.status(400).json({ error: 'Product ID and wallet type required' });
    }

    // Get product
    const { data: product, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('id', product_id)
      .eq('status', 'active')
      .single();

    if (prodErr || !product) return res.status(404).json({ error: 'Product not found' });
    if (product.quantity <= 0) return res.status(400).json({ error: 'Out of stock' });

    const costUSD = parseFloat(product.price_usd || 0);
    const costNGN = parseFloat(product.price_ngn || costUSD * USD_NGN);
    const requiredAmount = wallet_type === 'NGN' ? costNGN : costUSD;
    const walletField = wallet_type === 'NGN' ? 'wallet_ngn' : 'wallet_usd';

    // Get balance
    const { data: userData } = await supabaseAdmin
      .from('profiles')
      .select(`${walletField}, total_spent_usd, total_orders, completed_orders`)
      .eq('id', userId)
      .single();

    const balance = parseFloat(userData?.[walletField] || 0);
    if (balance < requiredAmount) {
      return res.status(400).json({
        error: `Insufficient balance. Need ${wallet_type === 'NGN' ? '₦' : '$'}${requiredAmount.toLocaleString()}`
      });
    }

    const orderRef = 'ORD-' + Date.now().toString(36).toUpperCase();
    const downloadToken = crypto.randomBytes(32).toString('hex');

    // Deduct balance
    const newBalance = balance - requiredAmount;
    await supabaseAdmin.from('profiles').update({ [walletField]: newBalance }).eq('id', userId);

    // Create order
    const deliveredData = {
      login_format: product.login_format || '',
      login_instructions: product.login_instructions || '',
      product_title: product.title,
      purchased_at: new Date().toISOString()
    };

    const { data: order } = await supabaseAdmin.from('orders').insert({
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
    }).select().single();

    // Save transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: userId,
      order_id: order.id,
      type: 'purchase',
      category: 'debit',
      description: `Purchased: ${product.title}`,
      amount_ngn: -costNGN,
      amount_usd: -costUSD,
      currency: wallet_type,
      status: 'completed',
      ref: orderRef,
      created_at: new Date().toISOString()
    });

    // Update stock
    await supabaseAdmin.from('products').update({ quantity: product.quantity - 1 }).eq('id', product_id);

    // Update profile stats
    const prevSpent = parseFloat(userData?.total_spent_usd || 0);
    const prevOrders = parseInt(userData?.total_orders || 0);
    const prevCompleted = parseInt(userData?.completed_orders || 0);

    await supabaseAdmin.from('profiles').update({
      total_spent_usd: prevSpent + costUSD,
      total_orders: prevOrders + 1,
      completed_orders: prevCompleted + 1
    }).eq('id', userId);

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
  const { data } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('download_token', req.params.token)
    .single();

  if (!data) return res.status(404).json({ error: 'Not found' });

  const log = data.delivered_data || {};
  const content = `ORDER: ${data.order_ref}\nPRODUCT: ${data.product_title}\nDATE: ${new Date(data.created_at).toLocaleString()}\n\nFORMAT: ${log.login_format || 'N/A'}\n\nINSTRUCTIONS:\n${log.login_instructions || 'N/A'}\n\nThank you for your purchase!`;

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="order_${data.order_ref}.txt"`);
  res.send(content);
});

/* ════════════════════════════════════════════════
   GET /api/market/purchases
════════════════════════════════════════════════ */
router.get('/purchases', authMiddleware, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  res.json({ success: true, purchases: data || [] });
});

module.exports = router;