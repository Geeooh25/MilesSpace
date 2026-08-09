const express = require('express');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const crypto = require('crypto');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

const router = express.Router();

// =============================================
// CLOUDINARY CONFIG
// =============================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// =============================================
// MULTER CONFIG
// =============================================
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  const allowedVideoTypes = ['video/mp4', 'video/mov', 'video/avi', 'video/webm', 'video/quicktime'];
  const allowedMimeTypes = [...allowedImageTypes, ...allowedVideoTypes];
  
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images and videos are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter
});

// =============================================
// CLOUDINARY UPLOAD HELPER
// =============================================
const uploadToCloudinary = (fileBuffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'auto',
        folder: 'milesspace/campaigns',
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

const deleteFromCloudinary = async (publicId) => {
  try {
    if (!publicId) return null;
    const parts = publicId.split('/');
    const filename = parts[parts.length - 1];
    const publicIdWithoutExt = filename.split('.')[0];
    const fullPublicId = `milesspace/campaigns/${publicIdWithoutExt}`;
    
    const result = await cloudinary.uploader.destroy(fullPublicId, {
      resource_type: 'auto'
    });
    return result;
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    return null;
  }
};

function generateRef() {
  return 'ADS-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
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
    'campaign_created': '📢',
    'campaign_submitted': '✅',
    'campaign_approved': '🎯',
    'campaign_rejected': '❌',
    'campaign_completed': '🏆',
    'info': '📌',
    'success': '✅',
    'error': '❌',
    'warning': '⚠️'
  };
  return icons[type] || '📌';
}

// ─── HELPER: Log audit ───
async function logAudit(userId, action, entityType, entityId, oldData, newData, req) {
  try {
    await supabaseAdmin.from('admin_activity').insert({
      user_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      old_data: oldData || null,
      new_data: newData || null,
      ip_address: req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || 'unknown',
      user_agent: req?.headers?.['user-agent'] || '',
      created_at: new Date().toISOString()
    });
  } catch (e) { console.error('Audit log error:', e.message); }
}

// =============================================
// GET /api/ads/wallet/balances
// =============================================
router.get('/wallet/balances', authMiddleware, async (req, res) => {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('wallet_ngn, wallet_usd, email, username')
      .eq('id', req.user.id)
      .maybeSingle();

    if (error || !profile) {
      return res.json({
        success: true,
        ngn_balance: 0,
        usd_balance: 0,
        full_name: '',
        email: req.user.email || '',
        username: ''
      });
    }

    res.json({
      success: true,
      ngn_balance: parseFloat(profile.wallet_ngn || 0),
      usd_balance: parseFloat(profile.wallet_usd || 0),
      full_name: profile.username || '',
      email: profile.email || '',
      username: profile.username || ''
    });
  } catch (error) {
    console.error('Wallet balances error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch wallet balances' });
  }
});

// =============================================
// GET /api/ads/platforms
// =============================================
const PLATFORMS_CACHE = { data: null, timestamp: null, ttl: 3600000 };

router.get('/platforms', async (req, res) => {
  try {
    if (PLATFORMS_CACHE.data && (Date.now() - PLATFORMS_CACHE.timestamp < PLATFORMS_CACHE.ttl)) {
      return res.json({ success: true, data: PLATFORMS_CACHE.data });
    }

    const platforms = [
      { id: 'instagram', name: 'Instagram', icon: 'fab fa-instagram', bg: 'linear-gradient(135deg,#833ab4,#fd1d1d)', desc: 'Promote posts, stories & reels • 2B+ users', urlPrefix: 'https://instagram.com/', minBudget: 10000 },
      { id: 'facebook', name: 'Facebook', icon: 'fab fa-facebook', bg: '#1877f2', desc: 'Reach 3B+ users worldwide • Feed & video ads', urlPrefix: 'https://facebook.com/', minBudget: 10000 },
      { id: 'tiktok', name: 'TikTok', icon: 'fab fa-tiktok', bg: '#000', desc: 'Go viral with Spark Ads • 1.5B+ users', urlPrefix: 'https://tiktok.com/@', minBudget: 10000 },
      { id: 'google', name: 'Google Ads', icon: 'fab fa-google', bg: '#4285f4', desc: 'Search, Display & YouTube • 4B+ searches/day', urlPrefix: 'https://', minBudget: 10000 },
      { id: 'twitter', name: 'Twitter/X', icon: 'fab fa-twitter', bg: '#1da1f2', desc: 'Promoted tweets & trends • 500M+ users', urlPrefix: 'https://twitter.com/', minBudget: 10000 },
      { id: 'youtube', name: 'YouTube', icon: 'fab fa-youtube', bg: '#ff0000', desc: 'Video ads that convert • 2B+ monthly users', urlPrefix: 'https://youtube.com/@', minBudget: 10000 },
    ];

    PLATFORMS_CACHE.data = platforms;
    PLATFORMS_CACHE.timestamp = Date.now();

    res.json({ success: true, data: platforms });
  } catch (error) {
    console.error('Platforms error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch platforms' });
  }
});

// =============================================
// GET /api/ads/estimate
// =============================================
router.get('/estimate', async (req, res) => {
  try {
    const { platform, goal, budget } = req.query;
    const budgetNum = Number(budget) || 10000;

    const costMap = {
      instagram: { views: 200, followers: 300, clicks: 250, whatsapp: 350, sales: 400 },
      facebook: { views: 150, followers: 250, clicks: 200, whatsapp: 300, sales: 350 },
      tiktok: { views: 100, followers: 200, clicks: 150, whatsapp: 250, sales: 300 },
      google: { views: 80, followers: 0, clicks: 100, whatsapp: 0, sales: 200 },
      twitter: { views: 180, followers: 280, clicks: 220, whatsapp: 320, sales: 380 },
      youtube: { views: 250, followers: 350, clicks: 300, whatsapp: 0, sales: 450 },
    };

    const baseCost = (costMap[platform]?.[goal]) || 200;
    const yourPrice = baseCost * 2;
    const estimatedViews = Math.floor((budgetNum / yourPrice) * 1000);

    res.json({
      success: true,
      data: {
        platform,
        goal,
        budget: budgetNum,
        costPer1000: yourPrice,
        platformCost: baseCost,
        markup: '2×',
        estimatedViews,
        estimatedClicks: Math.floor(estimatedViews * 0.02),
        estimatedCTR: '2%',
        duration: '3-7 days',
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to calculate estimate' });
  }
});

// =============================================
// POST /api/ads/campaign - CREATE CAMPAIGN
// ✅ FIXED: Creates transaction + notification
// =============================================
router.post('/campaign', authMiddleware, async (req, res) => {
  try {
    const {
      platform, goal, budget_total, wallet_type = 'NGN',
      campaign_name, profile_url, target_country, target_interests,
      target_age_min, target_age_max, target_gender
    } = req.body;

    if (!platform || !goal || !budget_total) {
      return res.status(400).json({ success: false, error: 'Platform, goal, and budget are required' });
    }

    if (budget_total < 10000) {
      return res.status(400).json({ success: false, error: 'Minimum budget is ₦10,000' });
    }

    const isUSD = wallet_type === 'USD';
    const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';
    const USD_RATE = 1620;
    
    // Convert budget to USD if needed
    const requiredAmount = isUSD ? budget_total / USD_RATE : budget_total;

    // ─── Get user balance ───
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select(`${walletField}, email, username`)
      .eq('id', req.user.id)
      .single();

    if (profileErr) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    const balance = parseFloat(profile[walletField] || 0);
    if (balance < requiredAmount) {
      return res.status(400).json({
        success: false,
        error: `Insufficient balance. Need ${isUSD ? '$' : '₦'}${requiredAmount.toFixed(2)}`
      });
    }

    // ─── Deduct wallet ───
    const newBalance = balance - requiredAmount;
    await supabaseAdmin
      .from('profiles')
      .update({ [walletField]: newBalance })
      .eq('id', req.user.id);

    // ─── Create campaign ───
    const orderRef = generateRef();
    const name = campaign_name || `${platform.charAt(0).toUpperCase() + platform.slice(1)} Campaign`;

    let interestsArray = target_interests;
    if (typeof target_interests === 'string') {
      try {
        interestsArray = JSON.parse(target_interests);
      } catch {
        interestsArray = target_interests.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
    if (!Array.isArray(interestsArray)) {
      interestsArray = [];
    }

    const { data: campaign, error: campaignErr } = await supabaseAdmin
      .from('campaigns')
      .insert({
        user_id: req.user.id,
        order_ref: orderRef,
        platform,
        campaign_name: name,
        goal,
        status: 'pending_review',
        target_country: target_country || 'all',
        target_age_min: target_age_min || 18,
        target_age_max: target_age_max || 65,
        target_gender: target_gender || 'all',
        target_interests: interestsArray,
        budget_total: budget_total,
        budget_spent: 0,
        wallet_used: wallet_type,
        profile_url: profile_url || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (campaignErr) {
      // Refund wallet on error
      await supabaseAdmin
        .from('profiles')
        .update({ [walletField]: balance })
        .eq('id', req.user.id);
      
      console.error('Campaign creation error:', campaignErr);
      return res.status(500).json({ success: false, error: 'Failed to create campaign' });
    }

    // ─── ✅ CREATE TRANSACTION ───
    await createTransaction(
      req.user.id,
      campaign.id,
      'campaign',
      `Ad Campaign: ${name} on ${platform}`,
      isUSD ? 0 : requiredAmount,
      isUSD ? requiredAmount : 0,
      wallet_type,
      'completed',
      orderRef,
      { campaign_id: campaign.id, platform, goal, budget_total }
    );

    // ─── ✅ CREATE NOTIFICATION ───
    await createNotification(
      req.user.id,
      'Campaign Created! 🚀',
      `Your ${platform} campaign "${name}" has been submitted for review.`,
      'campaign_created',
      `/social-ads?campaign=${campaign.id}`
    );

    // ─── Log audit ───
    await logAudit(req.user.id, 'CREATE', 'campaign', campaign.id, null, { platform, goal, budget_total }, req);

    // ─── Invalidate dashboard cache ───
    if (global.invalidateDashboardCache) {
      global.invalidateDashboardCache();
    }

    res.status(201).json({
      success: true,
      message: 'Campaign created successfully',
      data: {
        campaign,
        order_ref: orderRef,
        new_balance: newBalance
      }
    });

  } catch (error) {
    console.error('Create campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to create campaign' });
  }
});

// =============================================
// GET /api/ads/campaigns
// =============================================
router.get('/campaigns', authMiddleware, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('campaigns')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) throw error;

    const enrichedData = (data || []).map(c => ({
      ...c,
      remaining: c.budget_total - (c.budget_spent || 0),
      progress: c.budget_total > 0 ? Math.round(((c.budget_spent || 0) / c.budget_total) * 100) : 0
    }));

    res.json({
      success: true,
      data: enrichedData,
      count,
      page: parseInt(page),
      totalPages: Math.ceil(count / limit)
    });

  } catch (error) {
    console.error('Fetch campaigns error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch campaigns' });
  }
});

// =============================================
// GET /api/ads/campaign/:id
// =============================================
router.get('/campaign/:id', authMiddleware, async (req, res) => {
  try {
    const { data: campaign, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    res.json({ success: true, data: campaign });
  } catch (error) {
    console.error('Fetch campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch campaign' });
  }
});

// =============================================
// PUT /api/ads/campaign/:id
// =============================================
router.put('/campaign/:id', authMiddleware, async (req, res) => {
  try {
    const { data: campaign, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    if (!['pending_review', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ success: false, error: 'Can only update pending or paused campaigns' });
    }

    const allowedFields = [
      'campaign_name', 'target_country', 'target_age_min', 'target_age_max',
      'target_gender', 'target_interests', 'budget_daily',
      'headline', 'primary_text', 'description', 'call_to_action'
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error: updateErr } = await supabaseAdmin
      .from('campaigns')
      .update(updates)
      .eq('id', campaign.id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    await logAudit(req.user.id, 'UPDATE', 'campaign', campaign.id, campaign, data, req);

    res.json({ success: true, message: 'Campaign updated', data });
  } catch (error) {
    console.error('Update campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to update campaign' });
  }
});

// =============================================
// DELETE /api/ads/campaign/:id
// =============================================
router.delete('/campaign/:id', authMiddleware, async (req, res) => {
  try {
    const { data: campaign, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    if (campaign.status !== 'pending_review') {
      return res.status(400).json({ success: false, error: 'Can only delete pending campaigns' });
    }

    // Refund wallet
    const isUSD = campaign.wallet_used === 'USD';
    const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';
    const refundAmount = isUSD ? campaign.budget_total / 1620 : campaign.budget_total;

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select(walletField)
      .eq('id', req.user.id)
      .single();

    await supabaseAdmin
      .from('profiles')
      .update({ [walletField]: (profile[walletField] || 0) + refundAmount })
      .eq('id', req.user.id);

    // Delete campaign
    await supabaseAdmin
      .from('campaigns')
      .delete()
      .eq('id', campaign.id);

    await logAudit(req.user.id, 'DELETE', 'campaign', campaign.id, campaign, null, req);

    if (global.invalidateDashboardCache) {
      global.invalidateDashboardCache();
    }

    res.json({ success: true, message: 'Campaign deleted and refunded' });
  } catch (error) {
    console.error('Delete campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete campaign' });
  }
});

// =============================================
// POST /api/ads/campaign/:id/submit
// =============================================
router.post('/campaign/:id/submit', authMiddleware, async (req, res) => {
  try {
    const { data: campaign, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    if (campaign.status !== 'pending_review') {
      return res.status(400).json({ success: false, error: 'Campaign already submitted' });
    }

    const { data } = await supabaseAdmin
      .from('campaigns')
      .update({ 
        status: 'pending_review', 
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString() 
      })
      .eq('id', campaign.id)
      .select()
      .single();

    await createNotification(
      req.user.id,
      'Campaign Submitted ✅',
      `Your campaign "${campaign.campaign_name}" has been submitted for review.`,
      'campaign_submitted',
      `/social-ads?campaign=${campaign.id}`
    );

    res.json({ success: true, message: 'Campaign submitted for review', data });
  } catch (error) {
    console.error('Submit campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to submit campaign' });
  }
});

// =============================================
// POST /api/ads/campaign/:id/pause
// =============================================
router.post('/campaign/:id/pause', authMiddleware, async (req, res) => {
  try {
    const { data: campaign, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (campaign.status !== 'running') return res.status(400).json({ success: false, error: 'Only running campaigns can be paused' });

    const { data } = await supabaseAdmin
      .from('campaigns')
      .update({ 
        status: 'paused', 
        paused_at: new Date().toISOString(),
        updated_at: new Date().toISOString() 
      })
      .eq('id', campaign.id)
      .select()
      .single();

    res.json({ success: true, message: 'Campaign paused', data });
  } catch (error) {
    console.error('Pause campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to pause campaign' });
  }
});

// =============================================
// POST /api/ads/campaign/:id/resume
// =============================================
router.post('/campaign/:id/resume', authMiddleware, async (req, res) => {
  try {
    const { data: campaign, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (campaign.status !== 'paused') return res.status(400).json({ success: false, error: 'Only paused campaigns can be resumed' });

    const { data } = await supabaseAdmin
      .from('campaigns')
      .update({ 
        status: 'running', 
        resumed_at: new Date().toISOString(),
        updated_at: new Date().toISOString() 
      })
      .eq('id', campaign.id)
      .select()
      .single();

    res.json({ success: true, message: 'Campaign resumed', data });
  } catch (error) {
    console.error('Resume campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to resume campaign' });
  }
});

// =============================================
// POST /api/ads/campaign/:id/upload
// =============================================
router.post('/campaign/:id/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const { data: campaign, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const isVideo = req.file.mimetype.startsWith('video');
    const resourceType = isVideo ? 'video' : 'image';
    
    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: resourceType,
      folder: `milesspace/campaigns/${campaign.id}`,
      public_id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      transformation: isVideo ? [] : [{ quality: 'auto', fetch_format: 'auto' }]
    });

    const { data, error: creativeErr } = await supabaseAdmin
      .from('campaign_creatives')
      .insert({
        campaign_id: campaign.id,
        user_id: req.user.id,
        type: isVideo ? 'video' : 'image',
        title: req.body.title || 'Creative',
        description: req.body.description || '',
        file_url: result.secure_url,
        file_public_id: result.public_id,
        file_size: req.file.size,
        mime_type: req.file.mimetype,
        width: result.width || null,
        height: result.height || null,
        duration: result.duration || null,
        format: result.format || null,
        status: 'active',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (creativeErr) throw creativeErr;

    res.status(201).json({ 
      success: true, 
      message: 'Creative uploaded successfully', 
      data: {
        ...data,
        url: result.secure_url,
        cloudinary_id: result.public_id
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: 'Failed to upload creative' });
  }
});

// =============================================
// DELETE /api/ads/creative/:id
// =============================================
router.delete('/creative/:id', authMiddleware, async (req, res) => {
  try {
    const { data: creative, error } = await supabaseAdmin
      .from('campaign_creatives')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !creative) {
      return res.status(404).json({ success: false, error: 'Creative not found' });
    }

    if (creative.file_public_id) {
      await deleteFromCloudinary(creative.file_public_id);
    }

    await supabaseAdmin.from('campaign_creatives').delete().eq('id', creative.id);

    res.json({ success: true, message: 'Creative deleted successfully' });
  } catch (error) {
    console.error('Delete creative error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete creative' });
  }
});

// =============================================
// GET /api/ads/stats
// =============================================
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const [campaignsResult, balanceResult] = await Promise.all([
      supabaseAdmin
        .from('campaigns')
        .select('status, budget_total, budget_spent, impressions, clicks')
        .eq('user_id', userId),
      supabaseAdmin
        .from('profiles')
        .select('wallet_ngn, wallet_usd')
        .eq('id', userId)
        .single()
    ]);

    const campaigns = campaignsResult.data || [];
    const profile = balanceResult.data || { wallet_ngn: 0, wallet_usd: 0 };

    const stats = {
      total: campaigns.length,
      running: campaigns.filter(c => c.status === 'running').length,
      pending: campaigns.filter(c => c.status === 'pending_review').length,
      completed: campaigns.filter(c => c.status === 'completed').length,
      total_budget: campaigns.reduce((sum, c) => sum + (c.budget_total || 0), 0),
      total_spent: campaigns.reduce((sum, c) => sum + (c.budget_spent || 0), 0),
      total_impressions: campaigns.reduce((sum, c) => sum + (c.impressions || 0), 0),
      total_clicks: campaigns.reduce((sum, c) => sum + (c.clicks || 0), 0),
      wallet_ngn: parseFloat(profile.wallet_ngn || 0),
      wallet_usd: parseFloat(profile.wallet_usd || 0)
    };

    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Fetch stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

module.exports = router;