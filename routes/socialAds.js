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
// MULTER CONFIG — Memory storage for Cloudinary
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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
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

// =============================================
// DELETE FROM CLOUDINARY HELPER
// =============================================
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

// =============================================
// HELPER: Generate order reference
// =============================================
function generateRef() {
  return 'ADS-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// =============================================
// HELPER: Log audit trail
// =============================================
async function logAudit(userId, action, entityType, entityId, oldData, newData, req) {
  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      old_data: oldData || null,
      new_data: newData || null,
      ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      user_agent: req.headers['user-agent'] || '',
      created_at: new Date().toISOString()
    });
  } catch (e) { console.error('Audit log error:', e.message); }
}

// =============================================
// HELPER: Send notification
// =============================================
async function sendNotification(userId, type, title, message, data = {}) {
  try {
    await supabaseAdmin.from('notifications').insert({
      user_id: userId,
      type,
      title,
      message,
      data,
      created_at: new Date().toISOString()
    });
  } catch (e) { console.error('Notification error:', e.message); }
}

// =============================================
// HELPER: Validate campaign ownership
// =============================================
async function getCampaign(campaignId, userId) {
  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .eq('user_id', userId)
    .single();
  
  if (error || !data) return null;
  return data;
}

// =============================================
// GET /api/ads/wallet/balances — Fast wallet balances
// =============================================
router.get('/wallet/balances', authMiddleware, async (req, res) => {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('wallet_ngn, wallet_usd, email, avatar_url, username, phone')
      .eq('id', req.user.id)
      .maybeSingle();

    if (error) {
      console.error('Profile fetch error:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch profile'
      });
    }

    // If profile doesn't exist, create it
    if (!profile) {
      const username = req.user.email?.split('@')[0] || 'user_' + Math.random().toString(36).substr(2, 6);
      const { data: newProfile, error: createError } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: req.user.id,
          email: req.user.email,
          username: username,
          wallet_ngn: 0,
          wallet_usd: 0,
          created_at: new Date().toISOString(),
          last_login: new Date().toISOString()
        })
        .select('wallet_ngn, wallet_usd, email, avatar_url, username, phone')
        .single();

      if (createError) {
        console.error('Profile creation error:', createError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to create user profile'
        });
      }

      return res.json({
        success: true,
        ngn_balance: parseFloat(newProfile.wallet_ngn || 0),
        usd_balance: parseFloat(newProfile.wallet_usd || 0),
        full_name: newProfile.username || '',
        email: newProfile.email || req.user.email || '',
        avatar_url: newProfile.avatar_url || null,
        username: newProfile.username || ''
      });
    }

    res.json({
      success: true,
      ngn_balance: parseFloat(profile.wallet_ngn || 0),
      usd_balance: parseFloat(profile.wallet_usd || 0),
      full_name: profile.username || '',
      email: profile.email || '',
      avatar_url: profile.avatar_url || null,
      username: profile.username || ''
    });
  } catch (error) {
    console.error('Wallet balances error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch wallet balances'
    });
  }
});

// =============================================
// GET /api/ads/platforms — Available platforms (cached)
// =============================================
const PLATFORMS_CACHE = {
  data: null,
  timestamp: null,
  ttl: 3600000 // 1 hour
};

router.get('/platforms', async (req, res) => {
  try {
    // Check cache
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
// GET /api/ads/estimate — Price estimate
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
    const estimatedClicks = Math.floor(estimatedViews * 0.02);

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
        estimatedClicks,
        estimatedCTR: '2%',
        duration: '3-7 days',
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to calculate estimate' });
  }
});

// =============================================
// POST /api/ads/campaign — Create campaign
// =============================================
router.post('/campaign', authMiddleware, async (req, res) => {
  try {
    const {
      platform, username, goal,
      destination_type, destination_value, destination_message,
      target_country, target_state, target_city,
      target_age_min, target_age_max, target_gender,
      target_interests, target_languages, target_devices, target_placements,
      budget_total, budget_daily, wallet_type, profile_url, campaign_name,
      headline, primary_text, description, call_to_action
    } = req.body;

    if (!platform || !goal || !budget_total) {
      return res.status(400).json({ success: false, error: 'Platform, goal, and budget are required' });
    }

    if (budget_total < 10000) {
      return res.status(400).json({ success: false, error: 'Minimum budget is ₦10,000' });
    }

    const walletField = wallet_type === 'USD' ? 'wallet_usd' : 'wallet_ngn';
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select(walletField)
      .eq('id', req.user.id)
      .single();

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    const balance = parseFloat(profile[walletField] || 0);
    const required = wallet_type === 'USD' ? (budget_total / 1600) : budget_total;

    if (balance < required) {
      return res.status(400).json({
        success: false,
        error: `Insufficient balance. Need ${wallet_type === 'USD' ? '$' : '₦'}${required.toLocaleString()}`,
        balance,
        required
      });
    }

    // Start transaction
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ [walletField]: balance - required })
      .eq('id', req.user.id);

    if (updateError) {
      console.error('Wallet update error:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to update wallet' });
    }

    const orderRef = generateRef();
    const name = campaign_name || `${platform.charAt(0).toUpperCase() + platform.slice(1)} Campaign`;

    // Handle target_interests as array for PostgreSQL
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

    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from('campaigns')
      .insert({
        user_id: req.user.id,
        order_ref: orderRef,
        platform,
        campaign_name: name,
        goal,
        status: 'pending_review',
        destination_type: destination_type || 'profile',
        destination_value: destination_value || null,
        destination_message: destination_message || null,
        target_country: target_country || 'all',
        target_state: target_state || null,
        target_city: target_city || null,
        target_age_min: target_age_min || 18,
        target_age_max: target_age_max || 65,
        target_gender: target_gender || 'all',
        target_interests: interestsArray,
        target_languages: target_languages || [],
        target_devices: target_devices || [],
        target_placements: target_placements || [],
        budget_total,
        budget_daily: budget_daily || Math.floor(budget_total / 7),
        budget_spent: 0,
        wallet_used: wallet_type || 'NGN',
        profile_url: profile_url || null,
        headline: headline || null,
        primary_text: primary_text || null,
        description: description || null,
        call_to_action: call_to_action || 'Learn More',
        start_date: new Date().toISOString().split('T')[0],
        end_date: new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (campaignError) {
      // Refund wallet on error
      await supabaseAdmin.from('profiles')
        .update({ [walletField]: balance })
        .eq('id', req.user.id);
      
      console.error('Campaign creation error:', campaignError);
      return res.status(500).json({ success: false, error: 'Failed to create campaign' });
    }

    // Save transaction asynchronously (don't block response)
    supabaseAdmin.from('transactions').insert({
      user_id: req.user.id,
      type: 'social_ads',
      category: 'debit',
      description: `Ad Campaign: ${name} on ${platform}`,
      amount_ngn: wallet_type === 'NGN' ? -budget_total : -(budget_total),
      amount_usd: wallet_type === 'USD' ? -(budget_total / 1600) : -(budget_total / 1600),
      currency: wallet_type || 'NGN',
      status: 'completed',
      ref: orderRef,
      meta: { campaign_id: campaign.id, platform, goal },
      created_at: new Date().toISOString()
    }).catch(e => console.error('Transaction save error:', e));

    // Log audit asynchronously
    logAudit(req.user.id, 'CREATE', 'campaign', campaign.id, null, { platform, goal, budget_total }, req)
      .catch(e => console.error('Audit log error:', e));

    // Send notification asynchronously
    sendNotification(
      req.user.id, 'campaign_created', 'Campaign Created! 🚀',
      `Your ${platform} campaign "${name}" has been submitted for review.`,
      { campaign_id: campaign.id, order_ref: orderRef }
    ).catch(e => console.error('Notification error:', e));

    res.status(201).json({
      success: true,
      message: 'Campaign created successfully',
      data: {
        campaign,
        order_ref: orderRef,
        new_balance: balance - required
      }
    });

  } catch (error) {
    console.error('Create campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to create campaign' });
  }
});

// =============================================
// GET /api/ads/campaigns — User's campaigns (fast)
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

    // Add pagination
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) throw error;

    // Calculate additional stats per campaign
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
// GET /api/ads/campaign/:id — Single campaign
// =============================================
router.get('/campaign/:id', authMiddleware, async (req, res) => {
  try {
    const campaign = await getCampaign(req.params.id, req.user.id);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    // Get creatives
    const { data: creatives } = await supabaseAdmin
      .from('campaign_creatives')
      .select('*')
      .eq('campaign_id', campaign.id)
      .order('created_at', { ascending: false });

    // Get daily reports (last 30 days)
    const { data: reports } = await supabaseAdmin
      .from('campaign_reports')
      .select('*')
      .eq('campaign_id', campaign.id)
      .order('report_date', { ascending: false })
      .limit(30);

    res.json({
      success: true,
      data: {
        ...campaign,
        creatives: creatives || [],
        reports: reports || []
      }
    });

  } catch (error) {
    console.error('Fetch campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch campaign' });
  }
});

// =============================================
// PUT /api/ads/campaign/:id — Update campaign
// =============================================
router.put('/campaign/:id', authMiddleware, async (req, res) => {
  try {
    const campaign = await getCampaign(req.params.id, req.user.id);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    if (!['pending_review', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ success: false, error: 'Can only update pending or paused campaigns' });
    }

    const allowedFields = [
      'campaign_name', 'target_country', 'target_state', 'target_city',
      'target_age_min', 'target_age_max', 'target_gender',
      'target_interests', 'target_languages', 'target_devices', 'target_placements',
      'destination_type', 'destination_value', 'destination_message',
      'budget_daily', 'headline', 'primary_text', 'description', 'call_to_action'
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

    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .update(updates)
      .eq('id', campaign.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    logAudit(req.user.id, 'UPDATE', 'campaign', campaign.id, campaign, data, req)
      .catch(e => console.error('Audit log error:', e));

    res.json({ success: true, message: 'Campaign updated', data });

  } catch (error) {
    console.error('Update campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to update campaign' });
  }
});

// =============================================
// DELETE /api/ads/campaign/:id — Delete campaign
// =============================================
router.delete('/campaign/:id', authMiddleware, async (req, res) => {
  try {
    const campaign = await getCampaign(req.params.id, req.user.id);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    if (campaign.status !== 'pending_review') {
      return res.status(400).json({ success: false, error: 'Can only delete pending campaigns' });
    }

    // Get creatives to delete from Cloudinary
    const { data: creatives } = await supabaseAdmin
      .from('campaign_creatives')
      .select('file_public_id')
      .eq('campaign_id', campaign.id);

    // Delete from Cloudinary (async, don't block)
    for (const creative of creatives || []) {
      if (creative.file_public_id) {
        deleteFromCloudinary(creative.file_public_id).catch(e => console.error('Cloudinary delete error:', e));
      }
    }

    const walletField = campaign.wallet_used === 'USD' ? 'wallet_usd' : 'wallet_ngn';
    const refundAmount = campaign.wallet_used === 'USD' 
      ? (campaign.budget_total / 1600) 
      : campaign.budget_total;

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select(walletField)
      .eq('id', req.user.id)
      .single();

    // Refund wallet
    await supabaseAdmin.from('profiles')
      .update({ [walletField]: (profile[walletField] || 0) + refundAmount })
      .eq('id', req.user.id);

    // Delete campaign (cascade will delete creatives from DB)
    await supabaseAdmin.from('campaigns').delete().eq('id', campaign.id);

    logAudit(req.user.id, 'DELETE', 'campaign', campaign.id, campaign, null, req)
      .catch(e => console.error('Audit log error:', e));

    res.json({ success: true, message: 'Campaign deleted and refunded' });

  } catch (error) {
    console.error('Delete campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete campaign' });
  }
});

// =============================================
// POST /api/ads/campaign/:id/submit — Submit for review
// =============================================
router.post('/campaign/:id/submit', authMiddleware, async (req, res) => {
  try {
    const campaign = await getCampaign(req.params.id, req.user.id);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    if (campaign.status !== 'pending_review') {
      return res.status(400).json({ success: false, error: 'Campaign already submitted' });
    }

    const { data } = await supabaseAdmin.from('campaigns')
      .update({ 
        status: 'pending_review', 
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString() 
      })
      .eq('id', campaign.id)
      .select()
      .single();

    sendNotification(req.user.id, 'campaign_submitted', 'Campaign Submitted ✅',
      `Your campaign "${campaign.campaign_name}" has been submitted for review.`)
      .catch(e => console.error('Notification error:', e));

    res.json({ success: true, message: 'Campaign submitted for review', data });
  } catch (error) {
    console.error('Submit campaign error:', error);
    res.status(500).json({ success: false, error: 'Failed to submit campaign' });
  }
});

// =============================================
// POST /api/ads/campaign/:id/pause — Pause campaign
// =============================================
router.post('/campaign/:id/pause', authMiddleware, async (req, res) => {
  try {
    const campaign = await getCampaign(req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (campaign.status !== 'running') return res.status(400).json({ success: false, error: 'Only running campaigns can be paused' });

    const { data } = await supabaseAdmin.from('campaigns')
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
// POST /api/ads/campaign/:id/resume — Resume campaign
// =============================================
router.post('/campaign/:id/resume', authMiddleware, async (req, res) => {
  try {
    const campaign = await getCampaign(req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (campaign.status !== 'paused') return res.status(400).json({ success: false, error: 'Only paused campaigns can be resumed' });

    const { data } = await supabaseAdmin.from('campaigns')
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
// POST /api/ads/campaign/:id/upload — Upload creative to Cloudinary
// =============================================
router.post('/campaign/:id/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const campaign = await getCampaign(req.params.id, req.user.id);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    // Determine file type
    const isVideo = req.file.mimetype.startsWith('video');
    const resourceType = isVideo ? 'video' : 'image';
    
    // Upload to Cloudinary
    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: resourceType,
      folder: `milesspace/campaigns/${campaign.id}`,
      public_id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      transformation: isVideo ? [] : [{ quality: 'auto', fetch_format: 'auto' }]
    });

    // Save to database
    const { data, error } = await supabaseAdmin.from('campaign_creatives').insert({
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
      call_to_action: req.body.call_to_action || 'Learn More',
      status: 'active',
      created_at: new Date().toISOString()
    }).select().single();

    if (error) throw error;

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
    res.status(500).json({ 
      success: false, 
      error: 'Failed to upload creative',
      details: error.message 
    });
  }
});

// =============================================
// DELETE /api/ads/creative/:id — Delete creative
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

    // Delete from Cloudinary
    if (creative.file_public_id) {
      await deleteFromCloudinary(creative.file_public_id);
    }

    // Delete from database
    await supabaseAdmin.from('campaign_creatives').delete().eq('id', creative.id);

    res.json({ success: true, message: 'Creative deleted successfully' });
  } catch (error) {
    console.error('Delete creative error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete creative' });
  }
});

// =============================================
// PUT /api/ads/campaign/:id/report — Update campaign stats (manual)
// =============================================
router.put('/campaign/:id/report', authMiddleware, async (req, res) => {
  try {
    const campaign = await getCampaign(req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

    const { impressions, reach, clicks, conversions, spend } = req.body;

    const updates = {
      impressions: (campaign.impressions || 0) + (impressions || 0),
      reach: (campaign.reach || 0) + (reach || 0),
      clicks: (campaign.clicks || 0) + (clicks || 0),
      conversions: (campaign.conversions || 0) + (conversions || 0),
      budget_spent: (campaign.budget_spent || 0) + (spend || 0),
      updated_at: new Date().toISOString()
    };

    if (updates.impressions > 0 && updates.clicks > 0) {
      updates.ctr = +((updates.clicks / updates.impressions) * 100).toFixed(2);
    }
    if (updates.clicks > 0 && updates.budget_spent > 0) {
      updates.cpc = +(updates.budget_spent / updates.clicks).toFixed(2);
    }
    if (updates.impressions > 0 && updates.budget_spent > 0) {
      updates.cpm = +((updates.budget_spent / updates.impressions) * 1000).toFixed(2);
    }

    const { data } = await supabaseAdmin.from('campaigns')
      .update(updates)
      .eq('id', campaign.id)
      .select()
      .single();

    // Save daily report
    await supabaseAdmin.from('campaign_reports').upsert({
      campaign_id: campaign.id,
      user_id: req.user.id,
      report_date: new Date().toISOString().split('T')[0],
      impressions: impressions || 0,
      reach: reach || 0,
      clicks: clicks || 0,
      conversions: conversions || 0,
      spend: spend || 0,
      ctr: updates.ctr || 0,
      cpc: updates.cpc || 0,
      cpm: updates.cpm || 0,
      notes: req.body.notes || '',
      created_at: new Date().toISOString()
    }, { onConflict: 'campaign_id,report_date' });

    res.json({ success: true, message: 'Report updated', data });
  } catch (error) {
    console.error('Update report error:', error);
    res.status(500).json({ success: false, error: 'Failed to update report' });
  }
});

// =============================================
// GET /api/ads/notifications — User notifications
// =============================================
router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    res.json({ success: true, data: data || [] });
  } catch (error) {
    console.error('Fetch notifications error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
  }
});

// =============================================
// PUT /api/ads/notifications/:id/read — Mark notification as read
// =============================================
router.put('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await supabaseAdmin.from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    res.json({ success: true, message: 'Marked as read' });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ success: false, error: 'Failed to update notification' });
  }
});

// =============================================
// GET /api/ads/stats — Dashboard stats (fast)
// =============================================
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Run queries in parallel for speed
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