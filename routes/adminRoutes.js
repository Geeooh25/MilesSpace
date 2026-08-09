// routes/adminRoutes.js - USE verifyAdmin from admin.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { verifyAdmin, verifySuperAdmin } = require('./admin');

// ─── TEST ROUTE ───
router.get('/ping', verifyAdmin, (req, res) => {
  res.json({ 
    success: true, 
    message: 'Admin routes working',
    user: {
      id: req.userId,
      email: req.userEmail,
      role: req.userRole
    }
  });
});

// ─── GET STATS ───
router.get('/stats', verifyAdmin, async (req, res) => {
  try {
    const { count: totalUsers } = await supabaseAdmin
      .from('profiles')
      .select('*', { count: 'exact', head: true });

    const { count: newUsersToday } = await supabaseAdmin
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', new Date().toISOString().split('T')[0]);

    const { data: walletData } = await supabaseAdmin
      .from('profiles')
      .select('wallet_ngn, wallet_usd');

    let totalNgn = 0, totalUsd = 0;
    (walletData || []).forEach(w => {
      totalNgn += parseFloat(w.wallet_ngn) || 0;
      totalUsd += parseFloat(w.wallet_usd) || 0;
    });

    const { count: pendingDeposits } = await supabaseAdmin
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('type', 'wallet_funding')
      .eq('status', 'pending');

    const { count: pendingWithdrawals } = await supabaseAdmin
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('type', 'wallet_withdrawal')
      .eq('status', 'pending');

    res.json({
      success: true,
      data: {
        totalUsers: totalUsers || 0,
        newUsersToday: newUsersToday || 0,
        walletBalance: { ngn: totalNgn, usd: totalUsd },
        pending: {
          deposits: pendingDeposits || 0,
          withdrawals: pendingWithdrawals || 0
        }
      }
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET RECENT USERS ───
router.get('/users/recent', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, username, created_at, wallet_ngn, wallet_usd, status')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;
    res.json({ success: true, data: data || [] });

  } catch (error) {
    console.error('Recent users error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET RECENT TRANSACTIONS ───
router.get('/transactions', verifyAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    // Enrich with user details
    let enriched = data || [];
    if (enriched.length > 0) {
      const userIds = enriched.map(t => t.user_id).filter(Boolean);
      if (userIds.length > 0) {
        const { data: users } = await supabaseAdmin
          .from('profiles')
          .select('id, username, email')
          .in('id', userIds);
        
        const userMap = {};
        (users || []).forEach(u => { userMap[u.id] = u; });

        enriched = enriched.map(t => ({
          ...t,
          username: userMap[t.user_id]?.username || 'Unknown'
        }));
      }
    }

    res.json({ success: true, transactions: enriched });

  } catch (error) {
    console.error('Transactions error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── SUPER ADMIN ONLY ───
router.get('/admins', verifySuperAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, username, role, status, created_at')
      .in('role', ['admin', 'super_admin']);

    if (error) throw error;
    res.json({ success: true, data: data || [] });

  } catch (error) {
    console.error('List admins error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;