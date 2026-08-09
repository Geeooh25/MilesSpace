// routes/support.js - Complete with AI Orchestration
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const supportService = require('../services/supportService');
const aiOrchestrator = require('../services/aiOrchestrator');
const contextBuilder = require('../services/contextBuilder');
const memoryService = require('../services/memoryService');

// ─── POST /api/support/ask ───
router.post('/ask', authMiddleware, async (req, res) => {
    try {
        const { message, conversation_id } = req.body;
        const userId = req.user.id;

        if (!message || message.trim().length < 2) {
            return res.status(400).json({
                success: false,
                error: 'Please provide a valid message'
            });
        }

        // 1. Get user context with memory
        const context = await contextBuilder.buildContext(userId);
        const memory = await memoryService.getUserMemory(userId);

        // 2. Check FAQ first (no AI call)
        const faqResult = await supportService.searchFAQ(message);
        if (faqResult && faqResult.length > 0) {
            const response = {
                success: true,
                data: {
                    conversation_id: conversation_id || null,
                    response: faqResult[0].answer,
                    response_type: 'faq',
                    escalation_needed: false,
                    confidence: 0.95,
                    source: 'faq'
                }
            };

            await saveConversation(userId, message, response.data, conversation_id);
            return res.json(response);
        }

        // 3. Check if it's a data query (wallet, transactions, etc.)
        const dataResponse = await handleDataQuery(userId, message, context);
        if (dataResponse) {
            const response = {
                success: true,
                data: {
                    conversation_id: conversation_id || null,
                    response: dataResponse,
                    response_type: 'database',
                    escalation_needed: false,
                    confidence: 0.95,
                    source: 'database'
                }
            };

            await saveConversation(userId, message, response.data, conversation_id);
            return res.json(response);
        }

        // 4. Get conversation history
        let history = [];
        if (conversation_id) {
            history = await supportService.getConversationHistory(conversation_id);
        }

        // 5. Call AI Orchestrator
        const aiResult = await aiOrchestrator.processRequest({
            userId,
            message,
            context,
            memory,
            history,
            conversationId: conversation_id,
            user: {
                id: userId,
                username: req.user.username || 'User',
                email: req.user.email
            }
        });

        // 6. Save conversation
        const conversationResult = await saveConversation(
            userId, 
            message, 
            {
                response: aiResult.message,
                response_type: 'ai',
                confidence: aiResult.confidence,
                escalation_needed: aiResult.escalation_needed
            }, 
            conversation_id
        );

        // 7. Update memory
        await memoryService.updateMemory(userId, {
            last_question: message,
            last_response: aiResult.message,
            last_interaction: new Date().toISOString(),
            topics: aiResult.topics || []
        });

        // 8. Track AI usage
        await trackAIUsage(userId, conversationResult.conversation_id, aiResult);

        res.json({
            success: true,
            data: {
                conversation_id: conversationResult.conversation_id,
                response: aiResult.message,
                response_type: 'ai',
                escalation_needed: aiResult.escalation_needed || false,
                confidence: aiResult.confidence || 0.8,
                status: aiResult.escalation_needed ? 'waiting_admin' : 'active',
                source: 'ai',
                tokens_used: aiResult.tokens_used || 0
            }
        });

    } catch (error) {
        console.error('Support ask error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to process request'
        });
    }
});

// ─── HELPER: Save Conversation ───
async function saveConversation(userId, userMessage, responseData, conversationId = null) {
    try {
        let convId = conversationId;

        if (!convId) {
            // Create new conversation
            const { data: conv, error } = await supabaseAdmin
                .from('support_conversations')
                .insert({
                    user_id: userId,
                    status: responseData.escalation_needed ? 'waiting_admin' : 'active',
                    subject: userMessage.substring(0, 100),
                    last_message_at: new Date().toISOString(),
                    message_count: 2,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .select()
                .single();

            if (error) throw error;
            convId = conv.id;

            // Add user message
            await supabaseAdmin
                .from('support_messages')
                .insert({
                    conversation_id: convId,
                    sender_type: 'user',
                    sender_id: userId,
                    message: userMessage,
                    created_at: new Date().toISOString()
                });

            // Add AI response
            await supabaseAdmin
                .from('support_messages')
                .insert({
                    conversation_id: convId,
                    sender_type: responseData.response_type === 'system' ? 'system' : 'ai',
                    message: responseData.response,
                    metadata: {
                        confidence: responseData.confidence || 0.8,
                        source: responseData.source || 'ai'
                    },
                    created_at: new Date().toISOString()
                });

        } else {
            // Add to existing conversation
            await supabaseAdmin
                .from('support_messages')
                .insert({
                    conversation_id: convId,
                    sender_type: 'user',
                    sender_id: userId,
                    message: userMessage,
                    created_at: new Date().toISOString()
                });

            await supabaseAdmin
                .from('support_messages')
                .insert({
                    conversation_id: convId,
                    sender_type: responseData.response_type === 'system' ? 'system' : 'ai',
                    message: responseData.response,
                    metadata: {
                        confidence: responseData.confidence || 0.8,
                        source: responseData.source || 'ai'
                    },
                    created_at: new Date().toISOString()
                });

            // Update conversation
            await supabaseAdmin
                .from('support_conversations')
                .update({
                    last_message_at: new Date().toISOString(),
                    message_count: supabaseAdmin.rpc('increment', { row_id: convId }),
                    status: responseData.escalation_needed ? 'waiting_admin' : 'active',
                    updated_at: new Date().toISOString()
                })
                .eq('id', convId);
        }

        return { conversation_id: convId };
    } catch (error) {
        console.error('Save conversation error:', error);
        return { conversation_id: null };
    }
}

// ─── HELPER: Handle Data Queries ───
async function handleDataQuery(userId, message, context) {
    const msg = message.toLowerCase();

    // Wallet balance
    if (msg.includes('balance') || (msg.includes('wallet') && msg.includes('how much'))) {
        const wallets = context?.wallet || [];
        if (wallets.length > 0) {
            const summary = wallets.map(w => {
                const symbol = w.currency === 'USD' ? '$' : '₦';
                const available = (w.balance || 0) - (w.locked_balance || 0);
                return `${w.currency}: ${symbol}${available.toLocaleString()}`;
            }).join('\n');
            return `Your current wallet balances:\n\n${summary}`;
        }
        return "I couldn't find your wallet information. Please make sure you have a wallet created.";
    }

    // Transaction history
    if (msg.includes('transaction') || msg.includes('history')) {
        const transactions = context?.recent_transactions || [];
        if (transactions.length > 0) {
            const summary = transactions.slice(0, 5).map(t => {
                const symbol = t.currency === 'USD' ? '$' : '₦';
                const emoji = t.status === 'completed' ? '✅' : t.status === 'pending' ? '⏳' : '❌';
                return `${emoji} ${t.type}: ${symbol}${(t.amount || 0).toLocaleString()} (${t.status})`;
            }).join('\n');
            return `Your recent transactions:\n\n${summary}`;
        }
        return "You don't have any recent transactions.";
    }

    // Crypto orders
    if (msg.includes('crypto') || msg.includes('btc') || msg.includes('usdt')) {
        const orders = context?.pending_orders || [];
        if (orders.length > 0) {
            const summary = orders.map(o => {
                return `• ${o.coin}: ₦${(o.amount_ngn || 0).toLocaleString()} - ${o.status}`;
            }).join('\n');
            return `Your crypto orders:\n\n${summary}`;
        }
        return "You don't have any pending crypto orders.";
    }

    // Gift orders
    if (msg.includes('gift') || msg.includes('send')) {
        const gifts = context?.gift_orders || [];
        if (gifts.length > 0) {
            const summary = gifts.slice(0, 5).map(g => {
                const emoji = g.status === 'delivered' ? '✅' : g.status === 'pending' ? '⏳' : '📦';
                return `${emoji} ${g.product_name} → ${g.recipient_name} (${g.status})`;
            }).join('\n');
            return `Your gift orders:\n\n${summary}`;
        }
        return "You haven't sent any gifts yet. Browse the store to send a gift!";
    }

    return null;
}

// ─── HELPER: Track AI Usage ───
async function trackAIUsage(userId, conversationId, aiResult) {
    try {
        await supabaseAdmin
            .from('ai_sessions')
            .insert({
                conversation_id: conversationId,
                user_id: userId,
                model_used: aiResult.model || 'openrouter/deepseek-chat',
                prompt_tokens: aiResult.prompt_tokens || 0,
                completion_tokens: aiResult.completion_tokens || 0,
                total_tokens: aiResult.total_tokens || 0,
                response_time: aiResult.response_time || 0,
                confidence: aiResult.confidence || 0.8,
                escalated: aiResult.escalation_needed || false,
                created_at: new Date().toISOString()
            });
    } catch (error) {
        console.error('Track AI usage error:', error);
    }
}

module.exports = router;