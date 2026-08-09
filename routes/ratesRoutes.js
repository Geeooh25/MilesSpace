const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const crypto = require('crypto');

// ─── CLOUDINARY CONFIG ───
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// ─── CLOUDINARY UPLOAD HELPER ───
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

// ─── MULTER CONFIG ───
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
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: fileFilter
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
// GET /api/rates/giftcards/:card_name — Single rate
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
      return res.status(404).json({ success: false, error: 'Rate not found' });
    }

    console.log(`✅ [GET] /giftcards/${card_name} - Rate found:`, data.rate_ngn);
    res.json({ success: true, rate: data });
  } catch (error) {
    console.error('❌ GET /api/rates/giftcards/:card_name error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch rate' });
  }
});

// =============================================
// POST /api/rates/giftcards/sell — SELL GIFT CARD
// =============================================
router.post('/giftcards/sell', authMiddleware, upload.array('card_images', 5), async (req, res) => {
  console.log('='.repeat(60));
  console.log('📦 [SELL] Request received');
  console.log('📦 [SELL] Files:', req.files?.length || 0);
  console.log('📦 [SELL] Body:', req.body);
  console.log('👤 [SELL] User:', req.user?.id);
  console.log('='.repeat(60));

  try {
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

    // ── Get rate ──
    let { data: rateData, error: rateError } = await supabaseAdmin
      .from('gift_card_rates')
      .select('*')
      .eq('card_name', card_name)
      .eq('is_active', true);

    if (rateError) {
      console.error('Rate fetch error:', rateError);
      return res.status(500).json({ success: false, error: 'Failed to fetch rate' });
    }

    if (!rateData || rateData.length === 0) {
      // Try case-insensitive search
      const { data: fallbackData } = await supabaseAdmin
        .from('gift_card_rates')
        .select('*')
        .ilike('card_name', `%${card_name}%`)
        .eq('is_active', true)
        .limit(1);

      if (fallbackData && fallbackData.length > 0) {
        rateData = fallbackData;
      } else {
        return res.status(404).json({ 
          success: false, 
          error: `No active rate found for: ${card_name}` 
        });
      }
    }

    // Find matching country or use first
    let matchedRate = null;
    if (country && country.trim() !== '') {
      matchedRate = rateData.find(r => r.country === country);
    }
    if (!matchedRate) {
      matchedRate = rateData[0];
    }

    const rate = parseFloat(matchedRate.rate_ngn);
    console.log('✅ [SELL] Rate found:', rate, 'Country:', matchedRate.country);

    // ── Calculate payout ──
    let payoutAmount = amount * rate;

    // ── Promo code ──
    let promoDiscount = 0;
    if (promo_code) {
      try {
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
      } catch (e) { /* ignore */ }
    }

    // ── Get user wallet ──
    const walletField = payoutWallet === 'USD' ? 'wallet_usd' : 'wallet_ngn';
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    const currentBalance = parseFloat(profile[walletField] || 0);

    // ── Upload images ──
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
        } catch (err) {
          console.error('Cloudinary upload error:', err);
        }
      }
    }

    // ── Generate order reference ──
    const orderRef = 'SGC-' + Date.now().toString(36).toUpperCase() + '-' + 
                     Math.random().toString(36).substring(2, 8).toUpperCase();

    // ── Create order ──
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

    const { data: order, error: orderError } = await supabaseAdmin
      .from('gift_card_orders')
      .insert(orderData)
      .select()
      .maybeSingle();

    if (orderError || !order) {
      console.error('Order creation error:', orderError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to create order',
        details: orderError?.message 
      });
    }

    // ── Credit wallet ──
    const newBalance = currentBalance + payoutAmount;
    await supabaseAdmin
      .from('profiles')
      .update({ [walletField]: newBalance })
      .eq('id', req.user.id);

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

    // ── Notification ──
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
        images_uploaded: imageUrls.length
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

module.exports = router;