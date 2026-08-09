const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { authMiddleware } = require('../../middleware/auth');
const crypto = require('crypto');

// ─── Helper: Create transaction record (SAFE) ───
async function createTransaction(userId, orderId, type, description, amountNGN, amountUSD, currency, status, ref, meta = {}) {
    const isUSD = currency === 'USD';
    
    // ── NEVER set order_id unless it's a valid integer ──
    let orderIdValue = null;
    if (orderId && typeof orderId === 'number' && Number.isInteger(orderId) && orderId > 0) {
        orderIdValue = orderId;
    }

    const transactionData = {
        user_id: userId,
        type: type,
        category: type === 'deposit' ? 'credit' : 'debit',
        description: description,
        currency: currency,
        status: status,
        ref: ref,
        wallet_used: currency,
        meta: meta,
        created_at: new Date().toISOString()
    };
    
    // Only add order_id if we have a valid integer
    if (orderIdValue !== null) {
        transactionData.order_id = orderIdValue;
    }

    if (isUSD) {
        transactionData.amount_ngn = 0;
        transactionData.amount_usd = type === 'deposit' ? amountUSD : -amountUSD;
        transactionData.revenue_ngn = 0;
        transactionData.revenue_usd = type === 'deposit' ? amountUSD : 0;
    } else {
        transactionData.amount_ngn = type === 'deposit' ? amountNGN : -amountNGN;
        transactionData.amount_usd = 0;
        transactionData.revenue_ngn = type === 'deposit' ? amountNGN : 0;
        transactionData.revenue_usd = 0;
    }

    const { data, error } = await supabaseAdmin.from('transactions').insert(transactionData).select().single();
    if (error) {
        console.error('Transaction creation error:', error);
        return null;
    }
    return data;
}

// ─── Helper: Create notification ───
async function createNotification(userId, title, message, type = 'info', link = null) {
    const { data, error } = await supabaseAdmin.from('notifications').insert({
        user_id: userId,
        title: title,
        message: message,
        type: type,
        icon: type === 'deposit_completed' ? '✅' : type === 'deposit_failed' ? '❌' : '📌',
        link: link,
        is_read: false,
        created_at: new Date().toISOString()
    }).select().single();
    if (error) console.error('Notification error:', error);
    return data;
}

// ─── GET /api/wallet/balances ───
router.get('/balances', authMiddleware, async (req, res) => {
    try {
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('wallet_ngn, wallet_usd, email, username')
            .eq('id', req.user.id)
            .single();

        if (error || !profile) {
            return res.json({
                success: true,
                data: {
                    ngn_balance: 0,
                    usd_balance: 0,
                    email: req.user.email || '',
                    username: ''
                }
            });
        }

        res.json({
            success: true,
            data: {
                ngn_balance: parseFloat(profile.wallet_ngn || 0),
                usd_balance: parseFloat(profile.wallet_usd || 0),
                email: profile.email || '',
                username: profile.username || ''
            }
        });
    } catch (error) {
        console.error('Balances error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── POST /api/wallet/save-destination ───
router.post('/save-destination', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { wallet_type, bank_code, account_number, account_name, crypto_address, crypto_network } = req.body;

        const updateData = { updated_at: new Date().toISOString() };

        if (wallet_type === 'NGN') {
            updateData.bank_code = bank_code || null;
            updateData.account_number = account_number || null;
            updateData.account_name = account_name || null;
        } else {
            updateData.crypto_address = crypto_address || null;
            updateData.crypto_network = crypto_network || null;
        }

        const { data, error } = await supabaseAdmin
            .from('profiles')
            .update(updateData)
            .eq('id', userId)
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, message: 'Destination saved successfully', data });
    } catch (error) {
        console.error('Save destination error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── POST /api/wallet/withdraw ───
router.post('/withdraw', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { amount, currency, bank_code, account_number, account_name, crypto_address, crypto_network } = req.body;

        if (!amount || !currency) {
            return res.status(400).json({ success: false, error: 'Amount and currency required' });
        }

        const isUSD = currency === 'USD';
        const walletField = isUSD ? 'wallet_usd' : 'wallet_ngn';
        const minAmount = isUSD ? 20 : 2000;
        const maxAmount = isUSD ? 25000 : 5000000;

        if (amount < minAmount) {
            return res.status(400).json({ success: false, error: `Minimum withdrawal is ${isUSD ? '$' : '₦'}${minAmount}` });
        }
        if (amount > maxAmount) {
            return res.status(400).json({ success: false, error: `Maximum withdrawal is ${isUSD ? '$' : '₦'}${maxAmount.toLocaleString()}` });
        }

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select(`${walletField}, email, username`)
            .eq('id', userId)
            .single();

        if (!profile) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const balance = parseFloat(profile[walletField] || 0);
        if (balance < amount) {
            return res.status(400).json({ success: false, error: `Insufficient ${currency} balance` });
        }

        const orderRef = 'WD-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();

        const { data: withdrawal, error: wdError } = await supabaseAdmin
            .from('withdrawal_requests')
            .insert({
                user_id: userId,
                amount_ngn: isUSD ? 0 : amount,
                amount_usd: isUSD ? amount : 0,
                currency: currency,
                status: 'pending',
                bank_code: bank_code || null,
                account_number: account_number || null,
                account_name: account_name || null,
                crypto_address: crypto_address || null,
                crypto_network: crypto_network || null,
                order_ref: orderRef,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (wdError) throw wdError;

        // ── Create transaction (withdrawal id is UUID, so we pass null for order_id) ──
        await createTransaction(
            userId,
            null, // withdrawal.id is UUID, not integer
            'withdrawal',
            `Withdrawal request: ${isUSD ? '$' : '₦'}${amount.toFixed(2)} ${currency}`,
            isUSD ? 0 : amount,
            isUSD ? amount : 0,
            currency,
            'pending',
            orderRef,
            {
                withdrawal_id: withdrawal.id,
                bank_code: bank_code || null,
                crypto_address: crypto_address || null
            }
        );

        await createNotification(
            userId,
            'Withdrawal Request Submitted 📤',
            `Your withdrawal of ${isUSD ? '$' : '₦'}${amount.toFixed(2)} ${currency} has been submitted for approval.`,
            'withdrawal',
            `/wallet`
        );

        res.json({
            success: true,
            message: 'Withdrawal request submitted for approval',
            data: {
                order_ref: orderRef,
                amount: amount,
                currency: currency,
                status: 'pending'
            }
        });
    } catch (error) {
        console.error('Withdraw error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;