// ─── services/rewardService.js ───
// Internal reward service for MilesSpace

const { supabaseAdmin } = require('../db/supabase');

class RewardService {
    constructor() {
        this.MIN_REWARD = 1;
        this.MAX_REWARD = 100000;
    }

    async creditReward({ userId, amount, source, metadata = {} }) {
        try {
            if (!userId || !amount || amount <= 0) {
                return { success: false, error: 'Invalid user or amount' };
            }

            if (amount > this.MAX_REWARD) {
                return { success: false, error: `Amount exceeds maximum reward of ${this.MAX_REWARD}` };
            }

            // ─── Check for duplicate reward ───
            if (metadata.reference) {
                const { data: existing } = await supabaseAdmin
                    .from('cashback_transactions')
                    .select('id')
                    .eq('user_id', userId)
                    .eq('metadata->>reference', metadata.reference)
                    .eq('type', 'earned')
                    .maybeSingle();

                if (existing) {
                    return {
                        success: false,
                        error: 'Duplicate reward detected',
                        duplicate: true
                    };
                }
            }

            // ─── Get or create wallet ───
            let { data: wallet, error } = await supabaseAdmin
                .from('cashback_wallet')
                .select('*')
                .eq('user_id', userId)
                .single();

            if (error && error.code === 'PGRST116') {
                const { data: newWallet, error: createError } = await supabaseAdmin
                    .from('cashback_wallet')
                    .insert({
                        user_id: userId,
                        balance: 0,
                        lifetime_earned: 0,
                        lifetime_used: 0,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })
                    .select()
                    .single();

                if (createError) {
                    return { success: false, error: 'Failed to create wallet' };
                }
                wallet = newWallet;
            } else if (error) {
                return { success: false, error: 'Failed to fetch wallet' };
            }

            const currentBalance = parseFloat(wallet.balance) || 0;
            const newBalance = currentBalance + amount;
            const newLifetimeEarned = (parseFloat(wallet.lifetime_earned) || 0) + amount;

            // ─── Atomic update ───
            const { error: updateError } = await supabaseAdmin
                .from('cashback_wallet')
                .update({
                    balance: newBalance,
                    lifetime_earned: newLifetimeEarned,
                    updated_at: new Date().toISOString()
                })
                .eq('id', wallet.id);

            if (updateError) {
                return { success: false, error: 'Failed to update wallet' };
            }

            // ─── Record transaction ───
            const reference = `RWD-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

            const { data: transaction, error: txError } = await supabaseAdmin
                .from('cashback_transactions')
                .insert({
                    user_id: userId,
                    type: 'earned',
                    amount: amount,
                    balance_before: currentBalance,
                    balance_after: newBalance,
                    status: 'success',
                    description: `Cashback earned from ${source}`,
                    reference: reference,
                    metadata: {
                        source: source,
                        ...metadata
                    },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .select()
                .single();

            if (txError) {
                console.error('Transaction record error:', txError);
            }

            return {
                success: true,
                new_balance: newBalance,
                transaction_id: transaction?.id || null,
                reference: reference
            };

        } catch (error) {
            console.error('Credit reward error:', error);
            return { success: false, error: error.message };
        }
    }

    async getRewardBalance(userId) {
        try {
            const { data: wallet, error } = await supabaseAdmin
                .from('cashback_wallet')
                .select('balance')
                .eq('user_id', userId)
                .single();

            if (error) {
                return { success: false, error: 'Wallet not found' };
            }

            return {
                success: true,
                balance: parseFloat(wallet.balance) || 0
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async getRewardHistory(userId, limit = 50) {
        try {
            const { data, error } = await supabaseAdmin
                .from('cashback_transactions')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) {
                return { success: false, error: 'Failed to fetch history' };
            }

            return {
                success: true,
                data: data || []
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = new RewardService();