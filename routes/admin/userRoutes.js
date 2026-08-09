// routes/admin/userRoutes.js - FIXED (no external middleware)
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

// ─── GET ALL USERS ───
router.get('/users', verifyAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, search, status } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = supabaseAdmin
            .from('profiles')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false });

        if (search) {
            query = query.or(`username.ilike.%${search}%,email.ilike.%${search}%,full_name.ilike.%${search}%`);
        }

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        query = query.range(offset, offset + parseInt(limit) - 1);

        const { data, error, count } = await query;

        if (error) throw error;

        res.json({
            success: true,
            users: data || [],
            count: count || 0,
            page: parseInt(page),
            totalPages: Math.ceil((count || 0) / parseInt(limit))
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET SINGLE USER ───
router.get('/users/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { data: user, error } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', id)
            .single();

        if (error || !user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // Get user stats
        const [transactions, campaigns, giftOrders, boostOrders, smsOrders] = await Promise.all([
            supabaseAdmin.from('transactions').select('*', { count: 'exact' }).eq('user_id', id),
            supabaseAdmin.from('campaigns').select('*', { count: 'exact' }).eq('user_id', id),
            supabaseAdmin.from('gift_orders').select('*', { count: 'exact' }).eq('user_id', id),
            supabaseAdmin.from('boost_orders').select('*', { count: 'exact' }).eq('user_id', id),
            supabaseAdmin.from('sms_orders').select('*', { count: 'exact' }).eq('user_id', id)
        ]);

        res.json({
            success: true,
            user,
            stats: {
                transactions: transactions.count || 0,
                campaigns: campaigns.count || 0,
                giftOrders: giftOrders.count || 0,
                boostOrders: boostOrders.count || 0,
                smsOrders: smsOrders.count || 0
            }
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── UPDATE USER ───
router.put('/users/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { username, full_name, phone, status, is_verified, role } = req.body;

        const updateData = {};
        if (username !== undefined) updateData.username = username;
        if (full_name !== undefined) updateData.full_name = full_name;
        if (phone !== undefined) updateData.phone = phone;
        if (status !== undefined) updateData.status = status;
        if (is_verified !== undefined) updateData.is_verified = is_verified;
        if (role !== undefined) updateData.role = role;
        updateData.updated_at = new Date().toISOString();

        const { data: user, error } = await supabaseAdmin
            .from('profiles')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, user });
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── UPDATE USER STATUS ───
router.put('/users/:id/status', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!status || !['active', 'suspended', 'banned'].includes(status)) {
            return res.status(400).json({ success: false, error: 'Invalid status' });
        }

        const { data: user, error } = await supabaseAdmin
            .from('profiles')
            .update({
                status: status,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // Create notification for user
        await supabaseAdmin
            .from('notifications')
            .insert({
                user_id: id,
                title: status === 'suspended' ? 'Account Suspended' : 'Account Activated',
                message: status === 'suspended' 
                    ? 'Your account has been suspended. Please contact support for more information.'
                    : 'Your account has been reactivated. You can now access all features.',
                type: status === 'suspended' ? 'warning' : 'success',
                icon: status === 'suspended' ? '⚠️' : '✅',
                is_read: false,
                created_at: new Date().toISOString()
            });

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({ success: true, user, message: `User ${status}` });
    } catch (error) {
        console.error('Update user status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── ADJUST WALLET ───
router.post('/users/:id/wallet', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { currency, amount, reason } = req.body;

        if (!currency || !amount || amount === 0) {
            return res.status(400).json({ success: false, error: 'Currency and non-zero amount required' });
        }

        const isUSD = currency === 'USD';
        const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';

        const { data: user, error: userError } = await supabaseAdmin
            .from('profiles')
            .select(walletField)
            .eq('id', id)
            .single();

        if (userError || !user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const currentBalance = parseFloat(user[walletField] || 0);
        const newBalance = currentBalance + amount;

        if (newBalance < 0) {
            return res.status(400).json({ success: false, error: 'Insufficient balance' });
        }

        const { data: updated, error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({
                [walletField]: newBalance,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (updateError) throw updateError;

        // Create transaction record
        const ref = `ADMIN-${Date.now().toString(36).toUpperCase()}`;
        await supabaseAdmin
            .from('transactions')
            .insert({
                user_id: id,
                type: 'admin_adjustment',
                category: amount > 0 ? 'credit' : 'debit',
                description: `Admin ${amount > 0 ? 'added' : 'removed'} ${Math.abs(amount)} ${currency}${reason ? ` (${reason})` : ''}`,
                amount_ngn: isUSD ? 0 : amount,
                amount_usd: isUSD ? amount : 0,
                revenue_ngn: isUSD ? 0 : (amount > 0 ? amount : 0),
                revenue_usd: isUSD ? (amount > 0 ? amount : 0) : 0,
                currency: currency,
                status: 'completed',
                ref: ref,
                wallet_used: currency,
                meta: { admin_id: req.adminId, reason: reason || 'Admin adjustment' },
                created_at: new Date().toISOString()
            });

        // Create notification
        await supabaseAdmin
            .from('notifications')
            .insert({
                user_id: id,
                title: amount > 0 ? 'Wallet Funded' : 'Wallet Debited',
                message: `${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount)} ${currency} ${reason ? `(${reason})` : ''}`,
                type: amount > 0 ? 'success' : 'warning',
                icon: amount > 0 ? '💰' : '📤',
                is_read: false,
                created_at: new Date().toISOString()
            });

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({
            success: true,
            user: updated,
            new_balance: newBalance,
            currency: currency,
            amount: amount,
            message: `Wallet ${amount > 0 ? 'funded' : 'debited'} successfully`
        });
    } catch (error) {
        console.error('Wallet adjustment error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── RECENT USERS ───
router.get('/users/recent', verifyAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 6;
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, created_at, last_location, wallet_ngn, wallet_usd, is_verified, status, avatar_url')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;

        res.json({ success: true, data: data || [] });
    } catch (error) {
        console.error('Recent users error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── USER STATS ───
router.get('/users/stats', verifyAdmin, async (req, res) => {
    try {
        const [
            totalResult,
            activeResult,
            suspendedResult,
            verifiedResult,
            todayResult,
            weekResult
        ] = await Promise.all([
            supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }),
            supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).eq('status', 'active'),
            supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).eq('status', 'suspended'),
            supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).eq('is_verified', true),
            supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
            supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
        ]);

        const { data: wallets } = await supabaseAdmin
            .from('profiles')
            .select('wallet_ngn, wallet_usd');

        let totalNGN = 0, totalUSD = 0;
        (wallets || []).forEach(w => {
            totalNGN += parseFloat(w.wallet_ngn || 0);
            totalUSD += parseFloat(w.wallet_usd || 0);
        });

        res.json({
            success: true,
            stats: {
                total: totalResult.count || 0,
                active: activeResult.count || 0,
                suspended: suspendedResult.count || 0,
                verified: verifiedResult.count || 0,
                newToday: todayResult.count || 0,
                newThisWeek: weekResult.count || 0,
                wallet_ngn: totalNGN,
                wallet_usd: totalUSD
            }
        });
    } catch (error) {
        console.error('User stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;