// // services/supportService.js (Updated with AI integration)

// const { supabaseAdmin } = require('../db/supabase');
// const contextService = require('./contextService');
// const faqService = require('./faqService');

// class SupportService {
//     constructor() {
//         this.FAQ_CACHE_TTL = 3600;
//     }

//     // ─── PROCESS SUPPORT REQUEST (UPDATED WITH AI) ───
//     async processSupportRequest(userId, message, conversationId = null) {
//         try {
//             // 1. Get user context
//             const context = await contextService.buildContext(userId, message);

//             // 2. Check FAQ first
//             const faqResults = await faqService.searchFAQ(message);
//             if (faqResults && faqResults.length > 0) {
//                 const faq = faqResults[0];
//                 const response = {
//                     type: 'faq',
//                     message: `📚 **${faq.question}**\n\n${faq.answer}`,
//                     sender_type: 'system',
//                     confidence: 0.9
//                 };

//                 await this.saveConversation(userId, message, response, conversationId);
//                 return {
//                     success: true,
//                     conversation_id: conversationId,
//                     response: response.message,
//                     response_type: 'faq',
//                     escalation_needed: false,
//                     confidence: response.confidence
//                 };
//             }

//             // 3. Check if it's a data query (wallet, transactions, etc.)
//             const dataResponse = await this.handleDataQuery(userId, message, context);
//             if (dataResponse) {
//                 await this.saveConversation(userId, message, dataResponse, conversationId);
//                 return {
//                     success: true,
//                     conversation_id: conversationId,
//                     response: dataResponse.message,
//                     response_type: 'database',
//                     escalation_needed: false,
//                     confidence: 0.95
//                 };
//             }

//             // 4. Use AI
//             const conversationHistory = conversationId ? 
//                 await this.getConversationHistory(conversationId) : [];

//             const aiResponse = await aiService.getAIResponse(
//                 userId,
//                 message,
//                 context,
//                 conversationHistory
//             );

//             if (!aiResponse.success) {
//                 // AI failed, escalate
//                 return {
//                     success: false,
//                     error: aiResponse.error,
//                     escalation_needed: true,
//                     response: "I'm having trouble processing your request. I'll connect you with support."
//                 };
//             }

//             // 5. Save conversation
//             await this.saveConversation(userId, message, {
//                 type: 'ai',
//                 message: aiResponse.message,
//                 sender_type: 'ai',
//                 confidence: aiResponse.confidence
//             }, conversationId);

//             // 6. Check if escalation needed
//             const escalationNeeded = aiResponse.shouldEscalate || 
//                                     (aiResponse.confidence < 0.6);

//             if (escalationNeeded) {
//                 await this.createEscalation(userId, conversationId, 
//                     aiResponse.escalationReason || 'Low confidence response');
//             }

//             return {
//                 success: true,
//                 conversation_id: conversationId,
//                 response: aiResponse.message,
//                 response_type: 'ai',
//                 escalation_needed: escalationNeeded,
//                 confidence: aiResponse.confidence,
//                 tokens_used: aiResponse.tokensUsed
//             };

//         } catch (error) {
//             console.error('Process support request error:', error);
//             return {
//                 success: false,
//                 error: error.message,
//                 escalation_needed: true
//             };
//         }
//     }

//     // ─── HANDLE DATA QUERY ───
//     async handleDataQuery(userId, message, context) {
//         const msg = message.toLowerCase();

//         // Wallet balance
//         if (msg.includes('balance') || msg.includes('wallet') && msg.includes('how much')) {
//             return this.formatWalletBalance(context);
//         }

//         // Transaction history
//         if (msg.includes('transaction') || msg.includes('history')) {
//             return this.formatTransactions(context);
//         }

//         // Withdrawal status
//         if (msg.includes('withdrawal') || msg.includes('withdraw')) {
//             return this.formatWithdrawals(context);
//         }

//         // Crypto orders
//         if (msg.includes('crypto') || msg.includes('btc') || msg.includes('usdt')) {
//             return this.formatCryptoOrders(context);
//         }

//         // Gift orders
//         if (msg.includes('gift') || msg.includes('send') || msg.includes('recipient')) {
//             return this.formatGiftOrders(context);
//         }

//         return null;
//     }

//     // ─── FORMAT HELPERS ───
//     formatWalletBalance(context) {
//         const wallets = context?.wallet || [];
//         if (!wallets.length) {
//             return {
//                 type: 'database',
//                 message: "I couldn't find your wallet information.",
//                 sender_type: 'system',
//                 confidence: 0.95
//             };
//         }

//         const summary = wallets.map(w => {
//             const symbol = w.currency === 'USD' ? '$' : '₦';
//             const balance = w.balance || 0;
//             const available = balance - (w.locked_balance || 0);
//             return `• ${w.currency} Wallet: ${symbol}${balance.toLocaleString()} (Available: ${symbol}${available.toLocaleString()})`;
//         }).join('\n');

//         return {
//             type: 'database',
//             message: `Your current wallet balances:\n\n${summary}`,
//             sender_type: 'system',
//             confidence: 0.95
//         };
//     }

//     formatTransactions(context) {
//         const transactions = context?.transactions || [];
//         if (!transactions.length) {
//             return {
//                 type: 'database',
//                 message: "You don't have any recent transactions.",
//                 sender_type: 'system',
//                 confidence: 0.95
//             };
//         }

//         const summary = transactions.slice(0, 5).map(t => {
//             const symbol = t.currency === 'USD' ? '$' : '₦';
//             const emoji = t.status === 'completed' ? '✅' : 
//                          t.status === 'pending' ? '⏳' : '❌';
//             return `${emoji} ${t.type}: ${symbol}${(t.amount || 0).toLocaleString()} (${t.status}) - ${new Date(t.created_at).toLocaleDateString()}`;
//         }).join('\n');

//         return {
//             type: 'database',
//             message: `Your recent transactions:\n\n${summary}`,
//             sender_type: 'system',
//             confidence: 0.95
//         };
//     }

//     formatWithdrawals(context) {
//         const transactions = context?.transactions || [];
//         const pending = transactions.filter(t => 
//             t.type === 'withdrawal' && (t.status === 'pending' || t.status === 'processing')
//         );

//         if (!pending.length) {
//             return {
//                 type: 'database',
//                 message: "You don't have any pending withdrawals.",
//                 sender_type: 'system',
//                 confidence: 0.95
//             };
//         }

//         const summary = pending.map(w => {
//             const symbol = w.currency === 'USD' ? '$' : '₦';
//             return `• ${symbol}${(w.amount || 0).toLocaleString()} - ${w.status === 'processing' ? 'Processing' : 'Pending'}`;
//         }).join('\n');

//         return {
//             type: 'database',
//             message: `Your pending withdrawals:\n\n${summary}\n\nWithdrawals typically complete within 1-24 hours.`,
//             sender_type: 'system',
//             confidence: 0.95
//         };
//     }

//     formatCryptoOrders(context) {
//         const orders = context?.orders || [];
//         if (!orders.length) {
//             return {
//                 type: 'database',
//                 message: "You don't have any pending crypto orders.",
//                 sender_type: 'system',
//                 confidence: 0.95
//             };
//         }

//         const summary = orders.map(o => {
//             return `• ${o.coin}: ₦${(o.amount_ngn || 0).toLocaleString()} - ${o.status}`;
//         }).join('\n');

//         return {
//             type: 'database',
//             message: `Your crypto orders:\n\n${summary}`,
//             sender_type: 'system',
//             confidence: 0.95
//         };
//     }

//     formatGiftOrders(context) {
//         const gifts = context?.gifts || [];
//         if (!gifts.length) {
//             return {
//                 type: 'database',
//                 message: "You haven't sent any gifts yet. Browse the store to send a gift!",
//                 sender_type: 'system',
//                 confidence: 0.95
//             };
//         }

//         const summary = gifts.map(g => {
//             const emoji = g.status === 'delivered' ? '✅' :
//                          g.status === 'pending' ? '⏳' : '📦';
//             return `${emoji} ${g.product_name} → ${g.recipient_name} (${g.status})`;
//         }).join('\n');

//         return {
//             type: 'database',
//             message: `Your gift orders:\n\n${summary}`,
//             sender_type: 'system',
//             confidence: 0.95
//         };
//     }

//     // ─── CONVERSATION FUNCTIONS ───
//     async saveConversation(userId, userMessage, response, conversationId) {
//         try {
//             if (conversationId) {
//                 // Save to existing conversation
//                 await supabaseAdmin
//                     .from('support_messages')
//                     .insert([
//                         {
//                             conversation_id: conversationId,
//                             sender_type: 'user',
//                             sender_id: userId,
//                             message: userMessage,
//                             created_at: new Date().toISOString()
//                         },
//                         {
//                             conversation_id: conversationId,
//                             sender_type: response.sender_type || 'system',
//                             message: response.message,
//                             metadata: { 
//                                 confidence: response.confidence || 0,
//                                 type: response.type || 'ai'
//                             },
//                             created_at: new Date().toISOString()
//                         }
//                     ]);

//                 await supabaseAdmin
//                     .from('support_conversations')
//                     .update({
//                         last_message_at: new Date().toISOString(),
//                         message_count: supabaseAdmin.rpc('increment', { row_id: conversationId })
//                     })
//                     .eq('id', conversationId);

//             } else {
//                 // Create new conversation
//                 const { data: conv } = await supabaseAdmin
//                     .from('support_conversations')
//                     .insert({
//                         user_id: userId,
//                         status: 'active',
//                         category: 'general',
//                         subject: userMessage.substring(0, 100),
//                         created_at: new Date().toISOString(),
//                         last_message_at: new Date().toISOString(),
//                         message_count: 2
//                     })
//                     .select()
//                     .single();

//                 if (conv) {
//                     await supabaseAdmin
//                         .from('support_messages')
//                         .insert([
//                             {
//                                 conversation_id: conv.id,
//                                 sender_type: 'user',
//                                 sender_id: userId,
//                                 message: userMessage,
//                                 created_at: new Date().toISOString()
//                             },
//                             {
//                                 conversation_id: conv.id,
//                                 sender_type: response.sender_type || 'system',
//                                 message: response.message,
//                                 metadata: { 
//                                     confidence: response.confidence || 0,
//                                     type: response.type || 'ai'
//                                 },
//                                 created_at: new Date().toISOString()
//                             }
//                         ]);
//                 }
//             }
//         } catch (error) {
//             console.error('Save conversation error:', error);
//         }
//     }

//     async getConversationHistory(conversationId) {
//         try {
//             const { data, error } = await supabaseAdmin
//                 .from('support_messages')
//                 .select('sender_type, message, created_at')
//                 .eq('conversation_id', conversationId)
//                 .order('created_at', { ascending: true })
//                 .limit(10);

//             if (error) throw error;
//             return data || [];
//         } catch (error) {
//             console.error('Get conversation history error:', error);
//             return [];
//         }
//     }

//     async createEscalation(userId, conversationId, reason) {
//         try {
//             await supabaseAdmin
//                 .from('support_escalations')
//                 .insert({
//                     conversation_id: conversationId,
//                     user_id: userId,
//                     reason: reason || 'AI escalation',
//                     escalated_by: 'ai',
//                     escalated_at: new Date().toISOString()
//                 });

//             // Update conversation status
//             await supabaseAdmin
//                 .from('support_conversations')
//                 .update({
//                     status: 'waiting_admin',
//                     updated_at: new Date().toISOString()
//                 })
//                 .eq('id', conversationId);
//         } catch (error) {
//             console.error('Create escalation error:', error);
//         }
//     }
// }

// module.exports = new SupportService();