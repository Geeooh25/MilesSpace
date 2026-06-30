const express = require('express');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

// GET /api/gifts/products — Returns all active gift products
router.get('/products', async (req, res) => {
  try {
    console.log('🔍 Fetching gift products...');
    
    // Simple query — get all products that are not sold_out
    const { data, error } = await supabaseAdmin
      .from('gift_products')
      .select('*')
      .neq('stock', 'sold_out')
      .order('bestseller', { ascending: false })
      .order('rating', { ascending: false });

    if (error) {
      console.error('❌ Gift products query error:', error.message);
      console.error('Full error:', JSON.stringify(error));
      throw error;
    }

    console.log('✅ Gift products found:', data?.length || 0);
    
    res.json({ success: true, data: data || [] });
  } catch (error) {
    console.error('❌ Gift products error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/gifts/order — Place a gift order
router.post('/order', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      product_id, product_name, image_url,
      recipient_name, recipient_phone, recipient_email,
      recipient_country, recipient_address, recipient_city,
      recipient_state, recipient_zip,
      message, quantity, price_ngn, price_usd,
      wallet_type, delivery_speed, gift_wrap
    } = req.body;

    if (!recipient_name || !recipient_country || !recipient_address) {
      return res.status(400).json({ success: false, error: 'Recipient details required' });
    }

    const walletField = wallet_type === 'ngn' ? 'wallet_ngn' : 'wallet_usd';
    const totalNGN = (price_ngn || 0) * (quantity || 1) + (gift_wrap ? 5000 : 0);
    const totalUSD = (price_usd || 0) * (quantity || 1) + (gift_wrap ? 3 : 0);
    const requiredAmount = wallet_type === 'ngn' ? totalNGN : totalUSD;

    // Get balance
    const { data: userData } = await supabaseAdmin
      .from('profiles')
      .select(walletField)
      .eq('id', userId)
      .single();

    const balance = parseFloat(userData?.[walletField] || 0);
    if (balance < requiredAmount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    // Deduct balance
    await supabaseAdmin.from('profiles').update({ [walletField]: balance - requiredAmount }).eq('id', userId);

    const orderRef = 'GFT-' + Date.now().toString(36).toUpperCase();

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('gift_orders')
      .insert({
        user_id: userId, product_id: product_id || null,
        product_name: product_name || 'Gift', image_url: image_url || null,
        recipient_name, recipient_phone, recipient_email,
        recipient_country, recipient_address, recipient_city,
        recipient_state, recipient_zip,
        message: message || '', quantity: quantity || 1,
        price_ngn: totalNGN, price_usd: totalUSD,
        wallet_used: wallet_type, delivery_speed: delivery_speed || 'standard',
        gift_wrap: gift_wrap || false, status: 'pending',
        order_ref: orderRef, created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (orderErr) throw orderErr;

    // Save transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: userId, type: 'gift', category: 'debit',
      description: `Gift: ${product_name || 'Bundle'} to ${recipient_name}`,
      amount_ngn: -totalNGN, amount_usd: -totalUSD,
      currency: wallet_type, status: 'completed', ref: orderRef,
      created_at: new Date().toISOString()
    });

    res.json({
      success: true, message: 'Gift order placed!',
      order: { id: order.id, order_ref: orderRef, new_balance: balance - requiredAmount }
    });
  } catch (error) {
    console.error('❌ Gift order error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/gifts/orders — User's gift order history
router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('gift_orders')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/gifts/reviews/:productId
router.get('/reviews/:productId', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('gift_reviews')
      .select('*')
      .eq('product_id', req.params.productId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/gifts/reviews
router.post('/reviews', authMiddleware, async (req, res) => {
  try {
    const { product_id, rating, comment } = req.body;
    if (!product_id || !rating) return res.status(400).json({ success: false, error: 'Product and rating required' });

    const { data, error } = await supabaseAdmin
      .from('gift_reviews')
      .insert({
        product_id,
        user_id: req.user.id,
        user_name: req.user.username || req.user.email?.split('@')[0] || 'User',
        rating,
        comment: comment || '',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    // Update product rating
    const { data: allRatings } = await supabaseAdmin
      .from('gift_reviews')
      .select('rating')
      .eq('product_id', product_id);

    const avg = allRatings.reduce((s, r) => s + r.rating, 0) / allRatings.length;

    await supabaseAdmin
      .from('gift_products')
      .update({ rating: Math.round(avg * 10) / 10, review_count: allRatings.length })
      .eq('id', product_id);

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;