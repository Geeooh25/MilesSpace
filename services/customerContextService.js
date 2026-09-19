// services/customerContextService.js
const { supabaseAdmin } = require('../db/supabase');

class CustomerContextService {
    async getCustomerContext(userId) {
        try {
            const [profile, tickets, transactions, orders, giftCards] = await Promise.all([
                this.getProfile(userId),
                this.getRecentTickets(userId),
                this.getRecentTransactions(userId),
                this.getRecentOrders(userId),
                this.getRecentGiftCards(userId),
            ]);

            return {
                profile,
                recent_tickets: tickets,
                recent_transactions: transactions,
                recent_orders: orders,
                recent_gift_cards: giftCards,
                support_history: {
                    total_tickets: tickets.length,
                    open_tickets: tickets.filter(t => t.status !== 'resolved' && t.status !== 'closed').length,
                    resolved_tickets: tickets.filter(t => t.status === 'resolved').length,
                },
            };
        } catch (error) {
            console.error('Customer context error:', error);
            return null;
        }
    }

    async getProfile(userId) {
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, phone, wallet_ngn, wallet_usd, status, created_at, last_login, avatar_url, referral_code, is_verified')
            .eq('id', userId)
            .single();

        if (error) throw error;
        return {
            ...data,
            wallet_ngn: parseFloat(data.wallet_ngn) || 0,
            wallet_usd: parseFloat(data.wallet_usd) || 0,
        };
    }

    async getRecentTickets(userId, limit = 10) {
        const { data, error } = await supabaseAdmin
            .from('support_tickets')
            .select('id, ticket_number, subject, status, priority, category, created_at, updated_at, resolved_at, assigned_to')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data || [];
    }

    async getRecentTransactions(userId, limit = 10) {
        const { data, error } = await supabaseAdmin
            .from('transactions')
            .select('id, type, amount, currency, status, description, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data || [];
    }

    async getRecentOrders(userId, limit = 5) {
        const { data, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select('id, order_ref, product_title, amount, status, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data || [];
    }

    async getRecentGiftCards(userId, limit = 5) {
        const { data, error } = await supabaseAdmin
            .from('gift_orders')
            .select('id, order_ref, product_name, amount, status, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data || [];
    }

    // ─── GET TICKET WITH FULL CONTEXT ──────────────────────────────
    async getTicketWithContext(ticketId, userId) {
        const { data: ticket, error } = await supabaseAdmin
            .from('support_tickets')
            .select(`
                *,
                user:user_id (id, email, username, wallet_ngn, wallet_usd, status, created_at),
                assigned:assigned_to (id, username, email),
                messages:ticket_messages (
                    *,
                    sender:sender_id (id, username, email, avatar_url)
                )
            `)
            .eq('id', ticketId)
            .single();

        if (error) throw error;

        // Add related transaction context
        let relatedData = null;
        if (ticket.related_type && ticket.related_id) {
            const tableMap = {
                'transaction': 'transactions',
                'deposit': 'deposits',
                'withdrawal': 'withdrawals',
                'gift_order': 'gift_orders',
                'marketplace_order': 'marketplace_orders',
                'boost_order': 'boost_orders',
            };
            const table = tableMap[ticket.related_type];
            if (table) {
                const { data: related, error: relError } = await supabaseAdmin
                    .from(table)
                    .select('*')
                    .eq('id', ticket.related_id)
                    .maybeSingle();

                if (!relError && related) {
                    relatedData = related;
                }
            }
        }

        return {
            ...ticket,
            related_data: relatedData,
        };
    }
}

module.exports = CustomerContextService;