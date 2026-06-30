const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { optionalAuth } = require('../middleware/auth');

// GET /api/transactions — with search, filter, pagination
router.get('/', optionalAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, status, search, page = 1, limit = 50 } = req.query;

    let query = supabaseAdmin
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (type && type !== 'all') query = query.eq('type', type);
    if (status && status !== 'all') query = query.eq('status', status);
    if (search) query = query.or(`description.ilike.%${search}%,ref.ilike.%${search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    // Calculate totals from ALL transactions (not just current page)
    const { data: allTx } = await supabaseAdmin
      .from('transactions')
      .select('amount_ngn, amount_usd, type, status')
      .eq('user_id', userId);

    let totalCredit = 0, totalDebit = 0;
    (allTx || []).forEach(t => {
      const amt = Number(t.amount_ngn || 0);
      if (amt > 0) totalCredit += amt;
      else totalDebit += Math.abs(amt);
    });

    res.json({
      success: true,
      data: data || [],
      count: count || 0,
      totals: { credit: totalCredit, debit: totalDebit },
      page: parseInt(page),
      totalPages: Math.ceil((count || 0) / limit),
    });
  } catch (error) {
    console.error('Transaction error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/transactions/stats
router.get('/stats', optionalAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: tx } = await supabaseAdmin
      .from('transactions')
      .select('amount_ngn, amount_usd, type, status')
      .eq('user_id', userId);

    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('status')
      .eq('user_id', userId);

    const { data: giftOrders } = await supabaseAdmin
      .from('gift_orders')
      .select('status')
      .eq('user_id', userId);

    const { data: smsOrders } = await supabaseAdmin
      .from('sms_orders')
      .select('status')
      .eq('user_id', userId);

    let credit = 0, debit = 0;
    (tx || []).forEach(t => {
      const a = Number(t.amount_ngn || 0);
      if (a > 0) credit += a;
      else debit += Math.abs(a);
    });

    res.json({
      success: true,
      stats: {
        totalCreditNGN: credit,
        totalDebitNGN: debit,
        totalTransactions: tx?.length || 0,
        successful: (tx || []).filter(t => t.status === 'completed').length,
        pending: (tx || []).filter(t => ['pending', 'processing'].includes(t.status)).length,
        failed: (tx || []).filter(t => ['failed', 'cancelled'].includes(t.status)).length,
        marketOrders: orders?.length || 0,
        marketCompleted: orders?.filter(o => o.status === 'completed').length || 0,
        giftOrders: giftOrders?.length || 0,
        smsOrders: smsOrders?.length || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/transactions/purchase-map — download tokens for marketplace orders
router.get('/purchase-map', optionalAuth, async (req, res) => {
  try {
    // Get marketplace orders
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, order_ref, download_token, product_title, price_ngn, price_usd, wallet_used, purchased_at, created_at')
      .eq('user_id', req.user.id);

    // Get gift orders
    const { data: gifts } = await supabaseAdmin
      .from('gift_orders')
      .select('id, order_ref, product_name, price_ngn, price_usd, wallet_used, created_at')
      .eq('user_id', req.user.id);

    const map = {};

    (orders || []).forEach(o => {
      const ref = o.order_ref || String(o.id);
      map[ref] = {
        download_token: o.download_token,
        product_name: o.product_title || 'Marketplace Item',
        price_ngn: parseFloat(o.price_ngn) || 0,
        price_usd: parseFloat(o.price_usd) || 0,
        wallet_used: o.wallet_used || 'NGN',
        purchased_at: o.purchased_at || o.created_at,
        type: 'marketplace',
      };
    });

    (gifts || []).forEach(g => {
      const ref = g.order_ref || String(g.id);
      map[ref] = {
        download_token: null,
        product_name: g.product_name || 'Gift Order',
        price_ngn: parseFloat(g.price_ngn) || 0,
        price_usd: parseFloat(g.price_usd) || 0,
        wallet_used: g.wallet_used || 'NGN',
        purchased_at: g.created_at,
        type: 'gift',
      };
    });

    res.json({ success: true, map });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;