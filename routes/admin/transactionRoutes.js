// routes/admin/transactionRoutes.js - FIXED (no external middleware)
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

// ─── LOG ADMIN ACTION ───
async function logAdminAction(data) {
    try {
        await supabaseAdmin
            .from('admin_activity')
            .insert({
                admin_id: data.user_id,
                action: data.action,
                entity_type: data.entity_type || 'transaction',
                entity_id: data.entity_id,
                details: data.details || {},
                ip_address: data.ip_address || 'unknown',
                created_at: new Date().toISOString()
            });
    } catch (e) {
        console.error('Failed to log admin action:', e.message);
    }
}

// ─── GET ALL TRANSACTIONS ───
router.get('/transactions', verifyAdmin, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const type = req.query.type || '';
        const status = req.query.status || '';
        const currency = req.query.currency || '';

        let query = supabaseAdmin
            .from('transactions')
            .select(`
                *,
                profiles!inner(email, username),
                orders:order_id (
                    id, order_ref, product_title, product_id, delivered_data, download_token, created_at as order_created_at
                ),
                boost_orders:order_id (
                    id, order_ref, service_name, quantity, link, created_at as order_created_at
                ),
                campaigns:order_id (
                    id, order_ref, campaign_name, platform, budget_total, status as campaign_status
                ),
                sms_orders:order_id (
                    id, order_ref, country, service, phone_number, status as sms_status
                )
            `, { count: 'exact' });

        if (search) {
            query = query.or(`ref.ilike.%${search}%,profiles.email.ilike.%${search}%,profiles.username.ilike.%${search}%`);
        }

        if (type) query = query.eq('type', type);
        if (status) query = query.eq('status', status);
        if (currency) query = query.eq('currency', currency);

        query = query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        const { data, count, error } = await query;

        if (error) {
            return res.status(500).json({ success: false, error: error.message });
        }

        // Format with product details
        const formatted = (data || []).map(t => {
            let productDetails = null;
            let productType = null;

            if (t.orders) {
                productType = 'marketplace';
                productDetails = {
                    type: 'marketplace',
                    product_name: t.orders.product_title,
                    product_id: t.orders.product_id,
                    order_ref: t.orders.order_ref,
                    delivered_data: t.orders.delivered_data,
                    download_token: t.orders.download_token,
                    order_created_at: t.orders.order_created_at
                };
            } else if (t.boost_orders) {
                productType = 'boost';
                productDetails = {
                    type: 'boost',
                    service_name: t.boost_orders.service_name,
                    quantity: t.boost_orders.quantity,
                    link: t.boost_orders.link,
                    order_ref: t.boost_orders.order_ref,
                    order_created_at: t.boost_orders.order_created_at
                };
            } else if (t.campaigns) {
                productType = 'campaign';
                productDetails = {
                    type: 'campaign',
                    campaign_name: t.campaigns.campaign_name,
                    platform: t.campaigns.platform,
                    budget_total: t.campaigns.budget_total,
                    order_ref: t.campaigns.order_ref,
                    campaign_status: t.campaigns.campaign_status
                };
            } else if (t.sms_orders) {
                productType = 'sms';
                productDetails = {
                    type: 'sms',
                    country: t.sms_orders.country,
                    service: t.sms_orders.service,
                    phone_number: t.sms_orders.phone_number,
                    order_ref: t.sms_orders.order_ref,
                    sms_status: t.sms_orders.sms_status
                };
            }

            return {
                ...t,
                amount_ngn: Math.abs(Number(t.amount_ngn || 0)),
                amount_usd: Math.abs(Number(t.amount_usd || 0)),
                revenue_ngn: Number(t.revenue_ngn || 0),
                revenue_usd: Number(t.revenue_usd || 0),
                product_type: productType,
                product_details: productDetails
            };
        });

        res.json({
            success: true,
            transactions: formatted,
            pagination: {
                page,
                limit,
                total: count || 0,
                pages: Math.ceil((count || 0) / limit)
            }
        });

    } catch (error) {
        console.error('Get transactions error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch transactions' });
    }
});

// ─── UPDATE TRANSACTION STATUS ───
router.put('/transactions/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, notes } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, error: 'Status is required' });
        }

        const { data: currentTx, error: fetchError } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !currentTx) {
            return res.status(404).json({ success: false, error: 'Transaction not found' });
        }

        // If completing a pending transaction, update wallet balance
        const updates = { status, updated_at: new Date().toISOString() };
        if (notes) updates.notes = notes;

        // Handle pending deposit approval
        if (status === 'completed' && currentTx.status === 'pending' && currentTx.type === 'wallet_funding') {
            const userId = currentTx.user_id;
            const currency = currentTx.currency;
            const amount = currency === 'NGN' ? Number(currentTx.amount_ngn) : Number(currentTx.amount_usd);

            const { data: user } = await supabaseAdmin
                .from('profiles')
                .select('wallet_ngn, wallet_usd')
                .eq('id', userId)
                .single();

            if (user) {
                const walletField = currency === 'NGN' ? 'wallet_ngn' : 'wallet_usd';
                const currentBalance = currency === 'NGN' ? Number(user.wallet_ngn) : Number(user.wallet_usd);
                const newBalance = currentBalance + amount;

                await supabaseAdmin
                    .from('profiles')
                    .update({ [walletField]: newBalance })
                    .eq('id', userId);
            }
        }

        const { data: updatedTx, error: updateError } = await supabaseAdmin
            .from('transactions')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (updateError) {
            return res.status(500).json({ success: false, error: updateError.message });
        }

        await logAdminAction({
            user_id: req.adminId,
            action: 'transaction_update',
            entity_type: 'transaction',
            entity_id: id,
            details: `Updated transaction ${currentTx.ref} status to ${status}`,
            old_data: currentTx,
            new_data: updatedTx
        });

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({
            success: true,
            transaction: updatedTx,
            message: 'Transaction updated successfully'
        });

    } catch (error) {
        console.error('Update transaction error:', error);
        res.status(500).json({ success: false, error: 'Failed to update transaction' });
    }
});

// ─── REFUND TRANSACTION ───
router.post('/transactions/:id/refund', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        const { data: tx, error: fetchError } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !tx) {
            return res.status(404).json({ success: false, error: 'Transaction not found' });
        }

        if (tx.status === 'refunded') {
            return res.status(400).json({ success: false, error: 'Transaction already refunded' });
        }

        if (tx.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Only completed transactions can be refunded' });
        }

        // Create refund transaction
        const refundData = {
            user_id: tx.user_id,
            type: 'refund',
            category: 'debit',
            description: `Refund for ${tx.type} - ${tx.ref || tx.id}`,
            amount_ngn: tx.amount_ngn || 0,
            amount_usd: tx.amount_usd || 0,
            currency: tx.currency,
            status: 'completed',
            ref: `REF-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
            meta: {
                original_transaction_id: tx.id,
                refund_reason: reason || 'Admin requested refund'
            },
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString()
        };

        const { data: refund, error: refundError } = await supabaseAdmin
            .from('transactions')
            .insert(refundData)
            .select()
            .single();

        if (refundError) {
            return res.status(500).json({ success: false, error: refundError.message });
        }

        // Update original transaction
        const { data: updatedTx, error: updateError } = await supabaseAdmin
            .from('transactions')
            .update({
                status: 'refunded',
                refund_id: refund.id,
                refund_reason: reason || 'Admin requested refund',
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (updateError) {
            return res.status(500).json({ success: false, error: updateError.message });
        }

        // Adjust wallet balance
        const currency = tx.currency;
        const amount = currency === 'NGN' ? Number(tx.amount_ngn) : Number(tx.amount_usd);
        const { data: user } = await supabaseAdmin
            .from('profiles')
            .select('wallet_ngn, wallet_usd')
            .eq('id', tx.user_id)
            .single();

        if (user) {
            const walletField = currency === 'NGN' ? 'wallet_ngn' : 'wallet_usd';
            const currentBalance = currency === 'NGN' ? Number(user.wallet_ngn) : Number(user.wallet_usd);
            const newBalance = currentBalance - amount;

            await supabaseAdmin
                .from('profiles')
                .update({ [walletField]: Math.max(0, newBalance) })
                .eq('id', tx.user_id);
        }

        await logAdminAction({
            user_id: req.adminId,
            action: 'transaction_refund',
            entity_type: 'transaction',
            entity_id: id,
            details: `Refunded transaction ${tx.ref}. Reason: ${reason || 'Admin requested refund'}`,
            old_data: tx,
            new_data: updatedTx
        });

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        res.json({
            success: true,
            refund,
            transaction: updatedTx,
            message: 'Transaction refunded successfully'
        });

    } catch (error) {
        console.error('Refund transaction error:', error);
        res.status(500).json({ success: false, error: 'Failed to refund transaction' });
    }
});

module.exports = router;