// routes/wallet/index.js
// Wallet balances + destination save. No withdrawals (removed from UI).

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { authMiddleware } = require('../../middleware/auth');

// ─── GET /api/wallet/balances ─────────────────────────────────────────
// Single source of truth for the wallet page's NGN + USD balances.
// Reads from profiles.wallet_ngn / profiles.wallet_usd, which the ledger
// keeps in sync. Returns the SAME shape every time.
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const balances = await LedgerService.getAllBalances(req.user.id);
        res.json({
            success: true,
            data: {
                wallet_ngn: balances.NGN || 0,
                wallet_usd: balances.USD || 0,
                cashback: balances.CASHBACK || 0
            }
        });
    } catch (error) {
        console.error('❌ Balance error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch balances' });
    }
});
// ─── POST /api/wallet/save-destination ────────────────────────────────
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

module.exports = router;