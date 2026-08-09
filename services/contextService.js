// services/contextBuilder.js
// Builds intelligent context for the AI

const { supabaseAdmin } = require('../db/supabase');

class ContextBuilder {
    async buildContext(userId) {
        try {
            const context = {};

            // 1. Get user profile
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email, role, status, wallet_ngn, wallet_usd')
                .eq('id', userId)
                .single();

            if (profile) {
                context.user = {
                    username: profile.username,
                    email: profile.email,
                    role: profile.role,
                    status: profile.status
                };
            }

            // 2. Get wallet balances
            const { data: wallets } = await supabaseAdmin
                .from('wallets')
                .select('currency, balance, locked_balance')
                .eq('user_id', userId);

            if (wallets && wallets.length > 0) {
                context.wallet = wallets.map(w => ({
                    currency: w.currency,
                    balance: w.balance || 0,
                    available: (w.balance || 0) - (w.locked_balance || 0)
                }));
            }

            // 3. Get recent transactions
            const { data: transactions } = await supabaseAdmin
                .from('transactions')
                .select('id, type, amount, currency, status, description, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(5);

            if (transactions) {
                context.recent_transactions = transactions.map(t => ({
                    type: t.type,
                    amount: t.amount,
                    currency: t.currency,
                    status: t.status,
                    description: t.description,
                    created_at: t.created_at
                }));
            }

            // 4. Get pending crypto orders
            const { data: cryptoOrders } = await supabaseAdmin
                .from('crypto_purchases')
                .select('id, coin, amount_ngn, crypto_amount, status, reference, created_at')
                .eq('user_id', userId)
                .in('status', ['pending', 'processing'])
                .order('created_at', { ascending: false })
                .limit(3);

            if (cryptoOrders) {
                context.pending_orders = cryptoOrders.map(o => ({
                    coin: o.coin,
                    amount_ngn: o.amount_ngn,
                    crypto_amount: o.crypto_amount,
                    status: o.status,
                    reference: o.reference,
                    created_at: o.created_at
                }));
            }

            // 5. Get gift orders
            const { data: giftOrders } = await supabaseAdmin
                .from('gift_orders')
                .select('id, order_number, recipient_name, product_name, amount, status, created_at')
                .eq('sender_id', userId)
                .order('created_at', { ascending: false })
                .limit(5);

            if (giftOrders) {
                context.gift_orders = giftOrders.map(g => ({
                    order_number: g.order_number,
                    recipient_name: g.recipient_name,
                    product_name: g.product_name,
                    amount: g.amount,
                    status: g.status,
                    created_at: g.created_at
                }));
            }

            // 6. Get active support conversations
            const { data: conversations } = await supabaseAdmin
                .from('support_conversations')
                .select('id, status, category, subject, created_at')
                .eq('user_id', userId)
                .in('status', ['active', 'ai_handling', 'waiting_admin'])
                .order('created_at', { ascending: false })
                .limit(1);

            if (conversations && conversations.length > 0) {
                context.active_conversation = {
                    status: conversations[0].status,
                    category: conversations[0].category,
                    subject: conversations[0].subject
                };
            }

            return context;
        } catch (error) {
            console.error('Context build error:', error);
            return null;
        }
    }
}

module.exports = new ContextBuilder();