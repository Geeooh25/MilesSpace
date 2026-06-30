const express = require('express');
const { supabase, supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const multer = require('multer');

const router = express.Router();

// Multer setup for avatar upload
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, WEBP and GIF allowed'), false);
    }
  }
});

// ============ GET PROFILE ============
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('📖 Fetching profile for user:', userId);

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Profile fetch error:', error);
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    res.json({
      success: true,
      data: {
        id: data.id,
        email: data.email,
        username: data.username,
        phone: data.phone || '',
        avatar_url: data.avatar_url || null,
        wallet_ngn: parseFloat(data.wallet_ngn) || 0,
        wallet_usd: parseFloat(data.wallet_usd) || 0,
        total_orders: parseInt(data.total_orders) || 0,
        completed_orders: parseInt(data.completed_orders) || 0,
        total_spent_usd: parseFloat(data.total_spent_usd) || 0,
        referral_code: data.referral_code || '',
        created_at: data.created_at
      }
    });
  } catch (error) {
    console.error('Profile route error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============ UPDATE PROFILE ============
router.put('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { full_name, username, phone } = req.body;

    console.log('📝 Updating profile for user:', userId, { full_name, username, phone });

    const updates = {};
    if (username !== undefined && username !== '') updates.username = username;
    if (phone !== undefined) updates.phone = phone;
    updates.updated_at = new Date().toISOString();

    // If updating username, check if it's taken
    if (updates.username) {
      const { data: existingUser, error: checkError } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', updates.username)
        .neq('id', userId)
        .single();

      if (existingUser) {
        return res.status(400).json({ success: false, error: 'Username already taken' });
      }
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      console.error('Profile update error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ 
      success: true, 
      message: 'Profile updated successfully', 
      data: {
        id: data.id,
        email: data.email,
        username: data.username,
        phone: data.phone,
        avatar_url: data.avatar_url
      }
    });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============ UPLOAD AVATAR ============
router.post('/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const userId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const avatarUrl = `data:${req.file.mimetype};base64,${base64Image}`;

    const { error } = await supabase
      .from('profiles')
      .update({ avatar_url: avatarUrl })
      .eq('id', userId);

    if (error) throw error;

    res.json({ success: true, message: 'Avatar updated', avatar_url: avatarUrl });
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({ success: false, error: 'Failed to upload avatar' });
  }
});

// ============ DELETE AVATAR ============
router.delete('/avatar', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { error } = await supabase
      .from('profiles')
      .update({ avatar_url: null })
      .eq('id', userId);

    if (error) throw error;

    res.json({ success: true, message: 'Avatar removed successfully' });
  } catch (error) {
    console.error('Avatar delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to remove avatar' });
  }
});

// ============ CHANGE PASSWORD ============
router.put('/password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const userEmail = req.user.email;

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, error: 'Current and new password required' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });
    }

    // Verify current password using Supabase Auth
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: userEmail,
      password: current_password
    });

    if (signInError) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }

    // Update password using supabaseAdmin (more reliable)
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      req.user.id,
      { password: new_password }
    );

    if (updateError) {
      console.error('Password update error:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to update password' });
    }

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ success: false, error: 'Failed to change password' });
  }
});

// ============ DELETE ACCOUNT ============
router.delete('/delete', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    console.log('🗑️ Deleting account for user:', userId);

    // Delete in correct order to avoid foreign key violations
    // 1. Delete sessions
    await supabase.from('sessions').delete().eq('user_id', userId);
    
    // 2. Delete from profiles
    const { error: profileError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', userId);

    if (profileError) throw profileError;

    // 3. Delete from Auth (using supabaseAdmin to bypass RLS)
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (authError) throw authError;

    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
});

// ============ GET USER STATS ============
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('wallet_ngn, wallet_usd, total_orders, completed_orders, total_spent_usd')
      .eq('id', userId)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: {
        wallet_ngn: parseFloat(profile.wallet_ngn) || 0,
        wallet_usd: parseFloat(profile.wallet_usd) || 0,
        total_orders: parseInt(profile.total_orders) || 0,
        completed_orders: parseInt(profile.completed_orders) || 0,
        total_spent_usd: parseFloat(profile.total_spent_usd) || 0
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

module.exports = router;