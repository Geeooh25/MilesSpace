const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const crypto = require('crypto');

// =============================================
// CLOUDINARY CONFIG
// =============================================
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// =============================================
// CLOUDINARY UPLOAD HELPER
// =============================================
const uploadToCloudinary = (fileBuffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'auto',
        folder: 'milesspace/giftcards',
        ...options
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );

    const readableStream = new Readable();
    readableStream.push(fileBuffer);
    readableStream.push(null);
    readableStream.pipe(uploadStream);
  });
};

// =============================================
// MULTER CONFIG
// =============================================
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, GIF, and WebP images are allowed'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter
});

// =============================================
// TEST ROUTE
// =============================================
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Rates router is working!' });
});

// =============================================
// GET /api/rates/giftcards — Public rates
// =============================================
router.get('/giftcards', async (req, res) => {
  try {
    console.log('📡 [GET] /giftcards - Fetching rates');
    const { data, error } = await supabaseAdmin
      .from('gift_card_rates')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) throw error;
    console.log(`✅ [GET] /giftcards - Found ${data?.length || 0} rates`);
    res.json({ success: true, rates: data || [] });
  } catch (error) {
    console.error('❌ GET /api/rates/giftcards error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch gift card rates' });
  }
});

// =============================================
// GET /api/rates/giftcards/:card_name — Single rate by card_name
// =============================================
router.get('/giftcards/:card_name', async (req, res) => {
  try {
    const { card_name } = req.params;
    console.log(`📡 [GET] /giftcards/${card_name} - Fetching rate`);
    
    const { data, error } = await supabaseAdmin
      .from('gift_card_rates')
      .select('*')
      .eq('card_name', card_name)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      console.log(`❌ [GET] /giftcards/${card_name} - Rate not found`);
      return res.status(404).json({ success: false, error: 'Rate not found for this card' });
    }

    console.log(`✅ [GET] /giftcards/${card_name} - Rate found:`, data.rate_ngn);
    res.json({ success: true, rate: data });
  } catch (error) {
    console.error('❌ GET /api/rates/giftcards/:card_name error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch rate' });
  }
});

// =============================================
// GET /api/rates/giftcards/type/:card_type — Rates by card_type
// =============================================
router.get('/giftcards/type/:card_type', async (req, res) => {
  try {
    const { card_type } = req.params;
    console.log(`📡 [GET] /giftcards/type/${card_type} - Fetching rates`);
    
    const { data, error } = await supabaseAdmin
      .from('gift_card_rates')
      .select('*')
      .eq('card_type', card_type)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) throw error;
    console.log(`✅ [GET] /giftcards/type/${card_type} - Found ${data?.length || 0} rates`);
    res.json({ success: true, rates: data || [] });
  } catch (error) {
    console.error('❌ GET /api/rates/giftcards/type/:card_type error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch rates' });
  }
});

// =============================================
// POST /api/rates/giftcards/sell — Sell gift card with FormData
// =============================================
router.post('/giftcards/sell', authMiddleware, upload.array('card_images', 5), async (req, res) => {
  console.log('='.repeat(60));
  console.log('📦 [SELL] Request received');
  console.log('📦 [SELL] Files:', req.files?.length || 0);
  console.log('📦 [SELL] Body:', req.body);
  console.log('👤 [SELL] User:', req.user?.id);
  console.log('='.repeat(60));

  try {
    // Extract from FormData
    const {
      card_name,
      amount_usd,
      country,
      subcategory,
      wallet_type,
      promo_code,
      card_code,
      pin,
      comment
    } = req.body;

    // ── Validation ──
    if (!card_name) {
      return res.status(400).json({ success: false, error: 'Card name is required' });
    }
    
    const amount = parseFloat(amount_usd);
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Valid card amount is required' });
    }
    
    const payoutWallet = wallet_type?.toUpperCase() || 'NGN';
    if (!['NGN', 'USD'].includes(payoutWallet)) {
      return res.status(400).json({ success: false, error: 'Valid payout wallet is required' });
    }

    // ── Get current rate using card_name ──
    console.log('🔍 [SELL] Fetching rate for:', card_name, 'Country:', country || 'any');

    // Try to find rate with matching country first
    let { data: rateData, error: rateError } = await supabaseAdmin
      .from('gift_card_rates')
      .select('*')
      .eq('card_name', card_name)
      .eq('is_active', true);

    // If we have data, try to find matching country
    if (rateData && rateData.length > 0) {
      // Try to find exact country match
      let matchedRate = null;
      if (country && country.trim() !== '') {
        matchedRate = rateData.find(r => r.country === country);
      }
      // If no country match, use the first one (usually Global or US)
      if (!matchedRate) {
        matchedRate = rateData[0];
      }
      rateData = matchedRate;
    } else {
      rateData = null;
    }

    if (!rateData) {
      console.error('❌ [SELL] Rate not found for:', card_name);
      return res.status(404).json({ 
        success: false, 
        error: `No active rate found for: ${card_name}. Please check the card name.` 
      });
    }

    console.log('✅ [SELL] Rate found:', rateData.rate_ngn, 'Country:', rateData.country);

    // ── Calculate payout ──
    const rate = parseFloat(rateData.rate_ngn);
    let payoutAmount = amount * rate;

    let promoDiscount = 0;
    if (promo_code) {
      const { data: promoData } = await supabaseAdmin
        .from('promo_codes')
        .select('*')
        .eq('code', promo_code.toUpperCase())
        .eq('is_active', true)
        .maybeSingle();

      if (promoData) {
        promoDiscount = parseFloat(promoData.discount_percent) || 0;
        payoutAmount = payoutAmount * (1 - promoDiscount / 100);
        console.log('🎫 [SELL] Promo applied:', { promo_code, promoDiscount });
      }
    }

    // ── Get wallet balance ──
    const walletField = payoutWallet === 'USD' ? 'wallet_usd' : 'wallet_ngn';
    console.log('👛 [SELL] Wallet field:', walletField);
    
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .maybeSingle();

    if (profileError || !profile) {
      console.error('❌ [SELL] Profile not found:', profileError);
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    const currentBalance = parseFloat(profile[walletField] || 0);
    console.log('💰 [SELL] Current balance:', currentBalance);

    // ── Upload files to Cloudinary ──
    const files = req.files || [];
    const imageUrls = [];

    if (files.length > 0 && process.env.CLOUDINARY_CLOUD_NAME) {
      for (const file of files) {
        try {
          const result = await uploadToCloudinary(file.buffer, {
            folder: `milesspace/giftcards/${Date.now()}`,
            resource_type: 'image',
            public_id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          });
          imageUrls.push(result.secure_url);
          console.log('✅ [SELL] Uploaded image:', result.secure_url);
        } catch (err) {
          console.error('❌ [SELL] Cloudinary upload error:', err);
        }
      }
    }

    // ── Generate order reference ──
    const orderRef = 'SGC-' + Date.now().toString(36).toUpperCase() + '-' + 
                     Math.random().toString(36).substring(2, 8).toUpperCase();

    // ── Create order in gift_card_orders table ──
    const orderData = {
      user_id: req.user.id,
      order_ref: orderRef,
      card_name: card_name,
      card_subtype: subcategory || null,
      country: country || 'US',
      card_amount: amount,
      currency: 'USD',
      rate: rate,
      payout_amount: payoutAmount,
      payout_wallet: payoutWallet,
      promo_code: promo_code || null,
      promo_discount: promoDiscount,
      comment: comment || null,
      card_code: card_code || null,
      pin: pin || null,
      image_url: imageUrls.length > 0 ? imageUrls.join(',') : null,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    console.log('📦 [SELL] Creating gift card order:', orderData);

    const { data: order, error: orderError } = await supabaseAdmin
      .from('gift_card_orders')
      .insert(orderData)
      .select()
      .maybeSingle();

    if (orderError || !order) {
      console.error('❌ [SELL] Order creation error:', orderError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to create order',
        details: orderError?.message 
      });
    }

    console.log('✅ [SELL] Order created:', order.id);

    // ── Credit wallet ──
    const newBalance = currentBalance + payoutAmount;
    await supabaseAdmin
      .from('profiles')
      .update({ [walletField]: newBalance })
      .eq('id', req.user.id);

    console.log('💰 [SELL] New balance:', newBalance);

    // ── Create transaction ──
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: req.user.id,
        type: 'gift_card_sell',
        category: 'credit',
        description: `Gift card sale: ${card_name}`,
        amount_ngn: payoutWallet === 'NGN' ? payoutAmount : 0,
        amount_usd: payoutWallet === 'USD' ? payoutAmount : 0,
        currency: payoutWallet,
        status: 'completed',
        ref: orderRef,
        meta: {
          card_name: card_name,
          card_amount: amount,
          rate: rate,
          order_id: order.id
        },
        created_at: new Date().toISOString()
      });

    // ── Send notification ──
    await supabaseAdmin
      .from('notifications')
      .insert({
        user_id: req.user.id,
        type: 'gift_card_sell',
        title: 'Gift Card Submitted',
        message: `Your ${card_name} gift card of $${amount} has been submitted for review.`,
        data: { order_id: order.id, order_ref: orderRef },
        created_at: new Date().toISOString()
      });

    console.log('✅ [SELL] Success!');

    res.status(201).json({
      success: true,
      message: 'Gift card submitted successfully',
      data: {
        order: order,
        order_ref: orderRef,
        payout_amount: payoutAmount,
        payout_wallet: payoutWallet,
        new_balance: newBalance,
        rate: rate,
        promo_discount: promoDiscount,
        images_uploaded: imageUrls.length,
        user: {
          id: profile.id,
          email: profile.email,
          username: profile.username,
          wallet_ngn: profile.wallet_ngn,
          wallet_usd: profile.wallet_usd
        }
      }
    });

  } catch (error) {
    console.error('❌ [SELL] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process gift card sale',
      details: error.message 
    });
  }
});

// =============================================
// GET /api/rates/giftcards/orders — User's gift card orders
// =============================================
router.get('/giftcards/orders', authMiddleware, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('gift_card_orders')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      data: data || [],
      count,
      page: parseInt(page),
      totalPages: Math.ceil(count / limit)
    });
  } catch (error) {
    console.error('GET /api/rates/giftcards/orders error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

// =============================================
// GET /api/rates/giftcards/order/:id — Single gift card order
// =============================================
router.get('/giftcards/order/:id', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('gift_card_orders')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/rates/giftcards/order/:id error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch order' });
  }
});

// =============================================
// POST /api/rates/giftcards/order/:id/cancel — Cancel gift card order
// =============================================
router.post('/giftcards/order/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const { data: order, error: findError } = await supabaseAdmin
      .from('gift_card_orders')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (findError || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Only pending orders can be cancelled' });
    }

    // Refund wallet
    if (parseFloat(order.payout_amount) > 0) {
      const walletField = order.payout_wallet === 'USD' ? 'wallet_usd' : 'wallet_ngn';
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select(walletField)
        .eq('id', req.user.id)
        .maybeSingle();

      if (profile) {
        const currentBalance = parseFloat(profile[walletField] || 0);
        await supabaseAdmin
          .from('profiles')
          .update({ [walletField]: currentBalance - parseFloat(order.payout_amount) })
          .eq('id', req.user.id);
      }
    }

    const { data, error } = await supabaseAdmin
      .from('gift_card_orders')
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('id', order.id)
      .select()
      .maybeSingle();

    res.json({ success: true, message: 'Order cancelled', data });
  } catch (error) {
    console.error('POST /api/rates/giftcards/order/:id/cancel error:', error);
    res.status(500).json({ success: false, error: 'Failed to cancel order' });
  }
});

// =============================================
// POST /api/rates/giftcards/order/:id/upload — Upload image for gift card order
// =============================================
router.post('/giftcards/order/:id/upload', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const { data: order, error: findError } = await supabaseAdmin
      .from('gift_card_orders')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (findError || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image uploaded' });
    }

    let imageUrl = null;

    if (process.env.CLOUDINARY_CLOUD_NAME) {
      try {
        const result = await uploadToCloudinary(req.file.buffer, {
          folder: `milesspace/giftcards/${order.id}`,
          resource_type: 'image',
          public_id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        });
        imageUrl = result.secure_url;
      } catch (err) {
        console.error('Cloudinary upload error:', err);
        return res.status(500).json({ success: false, error: 'Failed to upload image' });
      }
    } else {
      imageUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }

    const { data, error } = await supabaseAdmin
      .from('gift_card_orders')
      .update({
        image_url: imageUrl,
        updated_at: new Date().toISOString()
      })
      .eq('id', order.id)
      .select()
      .maybeSingle();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Image uploaded successfully',
      data: {
        ...data,
        image_url: imageUrl
      }
    });
  } catch (error) {
    console.error('POST /api/rates/giftcards/order/:id/upload error:', error);
    res.status(500).json({ success: false, error: 'Failed to upload image' });
  }
});

module.exports = router;