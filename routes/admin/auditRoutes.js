// routes/admin/auditRoutes.js - FIXED (no external middleware)
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');

// ─── ✅ INTERNAL ADMIN VERIFICATION ───
function verifyAdmin(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }
    try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'miles-exchange-secret-key-2024');
        const role = decoded.role || decoded.user?.role;
        if (role !== 'admin' && role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        req.adminId = decoded.userId || decoded.sub || decoded.id || decoded.user?.id;
        req.adminRole = role;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

// ─── GET AUDIT LOGS ───
router.get('/audit', verifyAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;
    const action = req.query.action || '';
    const entity_type = req.query.entity_type || '';
    const user_id = req.query.user_id || '';

    let query = supabaseAdmin
      .from('audit_logs')
      .select('*, profiles!inner(email, username)', { count: 'exact' });

    if (action) query = query.eq('action', action);
    if (entity_type) query = query.eq('entity_type', entity_type);
    if (user_id) query = query.eq('user_id', user_id);

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, count, error } = await query;

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      logs: data,
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });

  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch audit logs' });
  }
});

// ─── GET AUDIT ACTIONS ───
router.get('/audit/actions', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('audit_logs')
      .select('action, count(*)')
      .group('action')
      .order('count', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      actions: data || []
    });

  } catch (error) {
    console.error('Get audit actions error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch audit actions' });
  }
});

module.exports = router;