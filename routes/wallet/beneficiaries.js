// ─── routes/wallet/beneficiaries.js ───
// Beneficiary Management Routes - Saved Banks & Crypto Wallets

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { authMiddleware } = require('../../middleware/auth');

// ─── HELPERS ───

/**
 * Get all beneficiaries for a user
 */
async function getUserBeneficiaries(userId) {
    const { data, error } = await supabaseAdmin
        .from('beneficiaries')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return data || [];
}

/**
 * Create notification
 */
async function createNotification(userId, title, message, type = 'info', link = null) {
    try {
        const iconMap = { 'info': '📌', 'success': '✅', 'error': '❌' };
        const { data, error } = await supabaseAdmin
            .from('notifications')
            .insert({
                user_id: userId,
                title: title,
                message: message,
                type: type,
                icon: iconMap[type] || '📌',
                link: link,
                is_read: false,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) console.error('Notification error:', error);
        return data;
    } catch (e) {
        console.error('Create notification error:', e);
        return null;
    }
}

// ─── GET /api/wallet/beneficiaries ───
router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const beneficiaries = await getUserBeneficiaries(userId);

        res.json({
            success: true,
            data: beneficiaries,
            count: beneficiaries.length
        });
    } catch (error) {
        console.error('Get beneficiaries error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch beneficiaries'
        });
    }
});

// ─── POST /api/wallet/beneficiaries ───
router.post('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            type,
            bank_code,
            bank_name,
            account_number,
            account_name,
            coin,
            network,
            wallet_address,
            nickname,
            is_default
        } = req.body;

        console.log('📝 Creating beneficiary:', { userId, type, bank_code, account_number, coin, wallet_address });

        // ─── Validate ───
        if (!type || !['bank', 'crypto'].includes(type)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid type. Must be "bank" or "crypto"'
            });
        }

        // ─── Bank validation ───
        if (type === 'bank') {
            if (!bank_code || !account_number || !account_name) {
                return res.status(400).json({
                    success: false,
                    error: 'Bank code, account number, and account name are required'
                });
            }
        }

        // ─── Crypto validation ───
        if (type === 'crypto') {
            if (!wallet_address) {
                return res.status(400).json({
                    success: false,
                    error: 'Wallet address is required'
                });
            }
            if (!coin) {
                return res.status(400).json({
                    success: false,
                    error: 'Coin is required'
                });
            }
        }

        // ─── Check for duplicates ───
        const existing = await getUserBeneficiaries(userId);
        
        let isDuplicate = false;
        if (type === 'bank') {
            isDuplicate = existing.some(b => 
                b.type === 'bank' && 
                b.account_number === account_number && 
                b.bank_code === bank_code
            );
        } else {
            isDuplicate = existing.some(b => 
                b.type === 'crypto' && 
                b.wallet_address === wallet_address &&
                b.coin === coin
            );
        }

        if (isDuplicate) {
            return res.status(400).json({
                success: false,
                error: 'Beneficiary already exists'
            });
        }

        // ─── Prepare data ───
        const insertData = {
            user_id: userId,
            type: type,
            bank_code: bank_code || null,
            bank_name: bank_name || null,
            account_number: account_number || null,
            account_name: account_name || null,
            coin: coin || null,
            network: network || null,
            wallet_address: wallet_address || null,
            nickname: nickname || null,
            is_default: is_default || false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        console.log('📦 Inserting:', insertData);

        // ─── Create beneficiary ───
        const { data: beneficiary, error } = await supabaseAdmin
            .from('beneficiaries')
            .insert(insertData)
            .select()
            .single();

        if (error) {
            console.error('❌ Insert error:', error);
            throw new Error(error.message);
        }

        // ─── If this is default, unset other defaults ───
        if (is_default) {
            await supabaseAdmin
                .from('beneficiaries')
                .update({ is_default: false })
                .eq('user_id', userId)
                .neq('id', beneficiary.id);
        }

        // ─── Create notification ───
        await createNotification(
            userId,
            'Beneficiary Saved ✅',
            `${type === 'bank' ? 'Bank' : 'Crypto wallet'} saved successfully.`,
            'success',
            '/wallet'
        );

        console.log('✅ Beneficiary created:', beneficiary.id);

        res.status(201).json({
            success: true,
            data: beneficiary,
            message: 'Beneficiary saved successfully'
        });
    } catch (error) {
        console.error('❌ Create beneficiary error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to save beneficiary'
        });
    }
});

// ─── DELETE /api/wallet/beneficiaries/:id ───
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('beneficiaries')
            .delete()
            .eq('id', id)
            .eq('user_id', userId);

        if (error) throw new Error(error.message);

        res.json({
            success: true,
            message: 'Beneficiary deleted successfully'
        });
    } catch (error) {
        console.error('Delete beneficiary error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to delete beneficiary'
        });
    }
});

// ─── GET /api/wallet/beneficiaries/test ───
router.get('/test', authMiddleware, async (req, res) => {
    res.json({
        success: true,
        message: 'Beneficiary router working!',
        routes: [
            'GET / - Get all beneficiaries',
            'POST / - Create beneficiary',
            'DELETE /:id - Delete beneficiary',
            'GET /test - Test route'
        ]
    });
});

module.exports = router;