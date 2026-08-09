const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

/* ─── CACHE ─── */
const statsCache = new Map();
const STATS_CACHE_TTL = 60000;

/* ─── GET /api/transactions - FAST VERSION ─── */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, status, search, page = 1, limit = 20 } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build query with proper indexes
    let query = supabaseAdmin
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)  // Uses idx_transactions_user_id
      .order('created_at', { ascending: false })  // Uses idx_transactions_user_created
      .range(offset, offset + parseInt(limit) - 1);

    if (type && type !== 'all') query = query.eq('type', type);
    if (status && status !== 'all') query = query.eq('status', status);
    if (search) query = query.or(`description.ilike.%${search}%,ref.ilike.%${search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    // ─── Enrich with product details (only for displayed items) ───
    const enriched = await enrichTransactionsWithProducts(data || []);

    // ─── Get stats from cache or calculate ───
    const cacheKey = `stats_${userId}`;
    let stats = statsCache.get(cacheKey);
    if (!stats || Date.now() - stats.timestamp > STATS_CACHE_TTL) {
      stats = { data: await calculateTransactionStats(userId), timestamp: Date.now() };
      statsCache.set(cacheKey, stats);
    }

    res.json({
      success: true,
      data: enriched,
      count: count || 0,
      stats: stats.data,
      page: parseInt(page),
      totalPages: Math.ceil((count || 0) / parseInt(limit))
    });

  } catch (error) {
    console.error('Transaction error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /api/transactions/export/csv ───
router.get('/export/csv', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { currency = 'NGN', from, to } = req.query;

    let query = supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    // Filter by currency if provided (optional)
    if (currency && currency !== 'ALL') {
      if (currency === 'USD') query = query.gt('amount_usd', 0).or('amount_usd.is.not.null');
      else if (currency === 'NGN') query = query.gt('amount_ngn', 0).or('amount_ngn.is.not.null');
    }

    if (from) query = query.gte('created_at', new Date(from).toISOString());
    if (to) {
      const toDate = new Date(to);
      toDate.setDate(toDate.getDate() + 1); // include end day
      query = query.lt('created_at', toDate.toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, error: 'No transactions found for the given period' });
    }

    // ─── Build CSV ───
    const rows = data.map(t => ({
      'Transaction ID': t.ref || t.id,
      'Type': t.type || 'N/A',
      'Description': t.description || 'N/A',
      'Amount (NGN)': t.amount_ngn || 0,
      'Amount (USD)': t.amount_usd || 0,
      'Currency': t.currency || 'NGN',
      'Status': t.status || 'N/A',
      'Date': t.created_at ? new Date(t.created_at).toLocaleString('en-US', { timeZone: 'UTC' }) : 'N/A'
    }));

    // ─── Use the `csv` package or simple join ───
    const csvHeaders = Object.keys(rows[0]);
    const csvRows = [
      csvHeaders.join(','),
      ...rows.map(row => csvHeaders.map(header => `"${String(row[header] || '').replace(/"/g, '""')}"`).join(','))
    ];
    const csv = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=statement_${userId.slice(0,8)}_${Date.now()}.csv`);
    res.send(csv);

  } catch (error) {
    console.error('CSV export error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});



/* ─── ENRICH TRANSACTIONS ─── */
async function enrichTransactionsWithProducts(transactions) {
  if (!transactions || transactions.length === 0) return transactions;

  const orderIds = [];
  const boostIds = [];
  const campaignIds = [];
  const smsIds = [];
  const giftIds = [];

  transactions.forEach(t => {
    if (!t.order_id) return;
    if (t.type === 'marketplace' || t.type === 'purchase') orderIds.push(t.order_id);
    else if (t.type === 'boost') boostIds.push(t.order_id);
    else if (t.type === 'campaign') campaignIds.push(t.order_id);
    else if (t.type === 'virtual_sms') smsIds.push(t.order_id);
    else if (t.type === 'gift' || t.type === 'gift_card') giftIds.push(t.order_id);
  });

  const [orders, boosts, campaigns, smsOrders, gifts] = await Promise.all([
    orderIds.length > 0 ? supabaseAdmin.from('orders').select('*').in('id', orderIds) : { data: [] },
    boostIds.length > 0 ? supabaseAdmin.from('boost_orders').select('*').in('id', boostIds) : { data: [] },
    campaignIds.length > 0 ? supabaseAdmin.from('campaigns').select('*').in('id', campaignIds) : { data: [] },
    smsIds.length > 0 ? supabaseAdmin.from('sms_orders').select('*').in('id', smsIds) : { data: [] },
    giftIds.length > 0 ? supabaseAdmin.from('gift_orders').select('*').in('id', giftIds) : { data: [] }
  ]);

  const orderMap = {}; (orders.data || []).forEach(o => { orderMap[o.id] = o; });
  const boostMap = {}; (boosts.data || []).forEach(b => { boostMap[b.id] = b; });
  const campaignMap = {}; (campaigns.data || []).forEach(c => { campaignMap[c.id] = c; });
  const smsMap = {}; (smsOrders.data || []).forEach(s => { smsMap[s.id] = s; });
  const giftMap = {}; (gifts.data || []).forEach(g => { giftMap[g.id] = g; });

  return transactions.map(t => {
    let productDetails = null;

    if ((t.type === 'marketplace' || t.type === 'purchase') && t.order_id && orderMap[t.order_id]) {
      const o = orderMap[t.order_id];
      productDetails = {
        type: 'marketplace',
        product_name: o.product_title || 'Marketplace Item',
        product_id: o.product_id,
        order_ref: o.order_ref,
        delivered_data: o.delivered_data,
        download_token: o.download_token,
        download_count: o.download_count || 0,
        order_created_at: o.created_at
      };
    }

    if (t.type === 'boost' && t.order_id && boostMap[t.order_id]) {
      const b = boostMap[t.order_id];
      productDetails = {
        type: 'boost',
        service_name: b.service_name || 'Boost Service',
        quantity: b.quantity || 1,
        link: b.link || '',
        order_ref: b.order_ref,
        order_created_at: b.created_at
      };
    }

    if (t.type === 'campaign' && t.order_id && campaignMap[t.order_id]) {
      const c = campaignMap[t.order_id];
      productDetails = {
        type: 'campaign',
        campaign_name: c.campaign_name || 'Campaign',
        platform: c.platform || 'N/A',
        budget_total: c.budget_total || 0,
        status: c.status || 'pending',
        order_ref: c.order_ref,
        order_created_at: c.created_at
      };
    }

    if (t.type === 'virtual_sms' && t.order_id && smsMap[t.order_id]) {
      const s = smsMap[t.order_id];
      productDetails = {
        type: 'sms',
        country: s.country || 'N/A',
        service: s.service || 'SMS',
        phone_number: s.phone_number || 'N/A',
        status: s.status || 'pending',
        order_ref: s.order_ref,
        order_created_at: s.created_at,
        sms_code: s.sms_code || null
      };
    }

    if ((t.type === 'gift' || t.type === 'gift_card') && t.order_id && giftMap[t.order_id]) {
      const g = giftMap[t.order_id];
      productDetails = {
        type: 'gift',
        product_name: g.product_name || 'Gift Item',
        recipient: g.recipient_name || g.recipient_contact || 'N/A',
        destination: g.recipient_country || 'N/A',
        tracking_number: g.tracking_number || 'N/A',
        order_ref: g.order_ref,
        order_created_at: g.created_at,
        status: g.status || 'pending'
      };
    }

    return {
      ...t,
      amount_ngn: Math.abs(parseFloat(t.amount_ngn || 0)),
      amount_usd: Math.abs(parseFloat(t.amount_usd || 0)),
      _original_ngn: parseFloat(t.amount_ngn || 0),
      _original_usd: parseFloat(t.amount_usd || 0),
      product_details: productDetails,
      is_purchase: !!productDetails,
      order_ref: productDetails?.order_ref || t.ref || t.id
    };
  });
}

/* ─── CALCULATE STATS ─── */
async function calculateTransactionStats(userId) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('amount_ngn, amount_usd, type, status')
    .eq('user_id', userId);

  if (error || !data) {
    return {
      totalCreditNGN: 0, totalDebitNGN: 0,
      totalCreditUSD: 0, totalDebitUSD: 0,
      giftOrders: 0, marketOrders: 0,
      boostOrders: 0, campaignOrders: 0,
      smsOrders: 0, totalTransactions: 0
    };
  }

  let totalCreditNGN = 0, totalDebitNGN = 0;
  let totalCreditUSD = 0, totalDebitUSD = 0;
  let giftOrders = 0, marketOrders = 0;
  let boostOrders = 0, campaignOrders = 0, smsOrders = 0;

  data.forEach(t => {
    const ngn = parseFloat(t.amount_ngn || 0);
    const usd = parseFloat(t.amount_usd || 0);

    if (ngn > 0) totalCreditNGN += ngn;
    else if (ngn < 0) totalDebitNGN += Math.abs(ngn);

    if (usd > 0) totalCreditUSD += usd;
    else if (usd < 0) totalDebitUSD += Math.abs(usd);

    if (t.type === 'giftcard' || t.type === 'gift_card' || t.type === 'gift') giftOrders++;
    if (t.type === 'marketplace' || t.type === 'purchase') marketOrders++;
    if (t.type === 'boost') boostOrders++;
    if (t.type === 'campaign') campaignOrders++;
    if (t.type === 'virtual_sms') smsOrders++;
  });

  return {
    totalCreditNGN, totalDebitNGN,
    totalCreditUSD, totalDebitUSD,
    giftOrders, marketOrders,
    boostOrders, campaignOrders,
    smsOrders,
    totalTransactions: data.length
  };
}

/* ─── GET /purchase-map ─── */
router.get('/purchase-map', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const map = {};

    // ─── Marketplace orders ───
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false });

    if (orders) {
      orders.forEach(o => {
        const isUSD = o.wallet_used === 'USD';
        map[o.order_ref] = {
          product_name: o.product_title || 'Marketplace Item',
          display_amount: isUSD ? o.price_usd : o.price_ngn,
          display_currency: o.wallet_used || 'NGN',
          purchased_at: o.created_at,
          status: o.status || 'completed',
          type: 'marketplace',
          download_token: o.download_token,
          download_count: o.download_count || 0,
          wallet_used: o.wallet_used || 'NGN',
          order_ref: o.order_ref,
          delivered_data: o.delivered_data
        };
      });
    }

    // ─── Boost orders ───
    const { data: boosts } = await supabaseAdmin
      .from('boost_orders')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false });

    if (boosts) {
      boosts.forEach(b => {
        const isUSD = b.currency === 'USD';
        map[b.order_ref] = {
          product_name: b.service_name || 'Boost Service',
          display_amount: isUSD ? b.total_amount : b.total_amount,
          display_currency: b.currency || 'NGN',
          purchased_at: b.created_at,
          status: b.status || 'completed',
          type: 'boost',
          order_ref: b.order_ref,
          quantity: b.quantity,
          link: b.link
        };
      });
    }

    // ─── SMS orders ───
    const { data: smsOrders } = await supabaseAdmin
      .from('sms_orders')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false });

    if (smsOrders) {
      smsOrders.forEach(s => {
        const isUSD = s.wallet_used === 'USD';
        map[s.order_ref] = {
          product_name: `${s.country || 'Virtual'} ${s.service || 'SMS'} Number`,
          display_amount: isUSD ? s.price_usd : s.price_ngn,
          display_currency: s.wallet_used || 'NGN',
          purchased_at: s.created_at,
          status: s.status || 'completed',
          type: 'sms',
          order_ref: s.order_ref,
          phone_number: s.phone_number,
          sms_code: s.sms_code || null
        };
      });
    }

    // ─── Gift orders ───
    const { data: gifts } = await supabaseAdmin
      .from('gift_orders')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['completed', 'delivered', 'shipped'])
      .order('created_at', { ascending: false });

    if (gifts) {
      gifts.forEach(g => {
        const isUSD = g.wallet_used === 'USD';
        map[g.order_ref] = {
          product_name: g.product_name || 'Gift Order',
          display_amount: isUSD ? g.price_usd : g.price_ngn,
          display_currency: g.wallet_used || 'NGN',
          purchased_at: g.created_at,
          status: g.status || 'completed',
          type: 'gift',
          tracking_number: g.tracking_number,
          order_ref: g.order_ref,
          recipient: g.recipient_name || g.recipient_contact || 'N/A',
          destination: g.recipient_country || 'N/A'
        };
      });
    }

    res.json({ success: true, map });
  } catch (error) {
    console.error('Purchase map error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ─── GET /stats ─── */
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const stats = await calculateTransactionStats(req.user.id);
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ─── POST /download/:orderRef ─── */
router.post('/download/:orderRef', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { orderRef } = req.params;

    // ─── Try orders table ───
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('id, order_ref, download_token, product_title, download_count, last_download_at, delivered_data')
      .eq('user_id', userId)
      .eq('order_ref', orderRef)
      .single();

    if (error || !order) {
      // ─── Try boost_orders ───
      const { data: boost, error: boostError } = await supabaseAdmin
        .from('boost_orders')
        .select('id, order_ref, download_token, service_name, download_count, last_download_at, link, quantity')
        .eq('user_id', userId)
        .eq('order_ref', orderRef)
        .single();

      if (boostError || !boost) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }

      if (!boost.download_token) {
        return res.status(400).json({ success: false, error: 'No download available for this order' });
      }

      await supabaseAdmin
        .from('boost_orders')
        .update({
          download_count: (boost.download_count || 0) + 1,
          last_download_at: new Date().toISOString()
        })
        .eq('id', boost.id);

      return res.json({
        success: true,
        download_token: boost.download_token,
        product_name: boost.service_name,
        download_count: (boost.download_count || 0) + 1,
        message: 'Download initiated successfully',
        order_type: 'boost',
        data: { service_name: boost.service_name, quantity: boost.quantity, link: boost.link, order_ref: boost.order_ref }
      });
    }

    if (!order.download_token) {
      return res.status(400).json({ success: false, error: 'No download available for this order' });
    }

    await supabaseAdmin
      .from('orders')
      .update({
        download_count: (order.download_count || 0) + 1,
        last_download_at: new Date().toISOString()
      })
      .eq('id', order.id);

    res.json({
      success: true,
      download_token: order.download_token,
      product_name: order.product_title,
      download_count: (order.download_count || 0) + 1,
      delivered_data: order.delivered_data,
      message: 'Download initiated successfully',
      order_type: 'marketplace'
    });
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ success: false, error: error.message || 'Download failed' });
  }
});

module.exports = router;