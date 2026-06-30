const express = require('express');
const { supabase } = require('../db/supabase');

const router = express.Router();

// Temporary middleware for testing (copy from auth.js)
const authMiddleware = async (req, res, next) => {
  try {
    const jwt = require('jsonwebtoken');
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (!decoded || !decoded.userId) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    const { data: user, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    req.user = user;
    req.user.id = user.id;
    req.token = token;
    
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ success: false, error: 'Authentication failed' });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ success: false, error: 'Admin access required' });
  }
};

// ============ ROUTES ============

// Test route
router.get('/test', authMiddleware, adminMiddleware, (req, res) => {
  res.json({ success: true, message: 'Admin access granted', user: req.user.email });
});

// Get all users
router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, username, wallet_ngn, wallet_usd, role, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, users: data || [] });
  } catch (error) {
    console.error('Fetch users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get all orders
router.get('/orders', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('boost_orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      if (error.code === '42P01') {
        return res.json({ success: true, orders: [], stats: { total: 0 } });
      }
      throw error;
    }

    const stats = {
      total: (data || []).length,
      pending: (data || []).filter(o => o.status === 'pending').length,
      completed: (data || []).filter(o => o.status === 'completed').length,
      revenue: (data || [])
        .filter(o => o.status === 'completed')
        .reduce((sum, o) => sum + (o.total_amount || 0), 0)
    };

    res.json({ success: true, orders: data || [], stats });
  } catch (error) {
    console.error('Fetch orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Update order status
router.put('/order/:id/status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'processing', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const { data, error } = await supabase
      .from('boost_orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, message: 'Status updated', order: data });
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// Delete order
router.delete('/order/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('boost_orders')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: 'Order deleted' });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// Get dashboard stats
router.get('/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { count: totalUsers } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true });

    const { data: orders } = await supabase
      .from('boost_orders')
      .select('status, total_amount');

    const stats = {
      total_users: totalUsers || 0,
      total_orders: (orders || []).length,
      pending_orders: (orders || []).filter(o => o.status === 'pending').length,
      completed_orders: (orders || []).filter(o => o.status === 'completed').length,
      total_revenue: (orders || [])
        .filter(o => o.status === 'completed')
        .reduce((sum, o) => sum + (o.total_amount || 0), 0)
    };

    res.json({ success: true, stats });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;