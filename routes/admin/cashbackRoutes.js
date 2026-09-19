// =============================================
// FILE: routes/admin/cashbackRoutes.js
// CASHBACK ADMIN ROUTES - NEW
// =============================================

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { adminAuthMiddleware } = require('../../middleware/auth');

// ─── GET /api/admin/cashback/transactions - Cashback transactions ───
router.get('/cashback/transactions', adminAuthMiddleware, async (req, res) => {
    try {
        const { limit = 100, offset = 0, type, status } = req.query;

        let query = supabaseAdmin
            .from('cashback_transactions')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false });

        if (type) query = query.eq('type', type);
        if (status) query = query.eq('status', status);

        const { data, error, count } = await query
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (error) throw error;

        // Get user names
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
                    username: userMap[t.user_id]?.username || userMap[t.user_id]?.email?.split('@')[0] || 'Unknown'
                }));
            }
        }

        res.json({
            success: true,
            data: enriched,
            count: count || 0,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

    } catch (error) {
        console.error('Cashback transactions error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/admin/cashback/summary - Cashback summary ───
router.get('/cashback/summary', adminAuthMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('cashback_transactions')
            .select('type, amount');

        if (error) throw error;

        let totalEarned = 0, totalUsed = 0, totalExpired = 0;

        (data || []).forEach(t => {
            const amount = parseFloat(t.amount) || 0;
            if (t.type === 'earned') totalEarned += amount;
            else if (t.type === 'used') totalUsed += amount;
            else if (t.type === 'expired') totalExpired += amount;
        });

        // Get total cashback wallet balance
        const { data: walletData } = await supabaseAdmin
            .from('cashback_wallet')
            .select('balance');

        let totalBalance = 0;
        (walletData || []).forEach(w => {
            totalBalance += parseFloat(w.balance) || 0;
        });

        res.json({
            success: true,
            data: {
                totalEarned,
                totalUsed,
                totalExpired,
                totalBalance,
                totalTransactions: data?.length || 0
            }
        });

    } catch (error) {
        console.error('Cashback summary error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;