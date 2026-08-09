// services/aiOrchestrator.js
// Handles all AI interactions with OpenRouter

const axios = require('axios');

class AIOrchestrator {
    constructor() {
        this.apiKey = process.env.OPENROUTER_API_KEY;
        this.model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3';
        this.siteUrl = process.env.SITE_URL || 'https://milesspace.com';
        this.siteName = process.env.SITE_NAME || 'MilesSpace';
        this.timeout = 15000;
        this.maxTokens = 800;
        this.temperature = 0.7;
        this.cacheEnabled = true;
        this.cacheTTL = 3600;
    }

    async processRequest({ userId, message, context, memory, history, conversationId, user }) {
        const startTime = Date.now();

        try {
            // 1. Check cache for similar questions
            if (this.cacheEnabled) {
                const cached = await this.getCachedResponse(message, context);
                if (cached) {
                    return {
                        ...cached,
                        cached: true,
                        response_time: Date.now() - startTime
                    };
                }
            }

            // 2. Build the prompt
            const prompt = this.buildPrompt(message, context, memory, history, user);

            // 3. Call OpenRouter
            const response = await this.callOpenRouter(prompt);

            // 4. Process response
            const result = this.processResponse(response, context);

            // 5. Cache if confident
            if (this.cacheEnabled && result.confidence > 0.8) {
                await this.cacheResponse(message, context, result);
            }

            // 6. Return result with metadata
            return {
                ...result,
                model: this.model,
                response_time: Date.now() - startTime,
                prompt_tokens: response.data?.usage?.prompt_tokens || 0,
                completion_tokens: response.data?.usage?.completion_tokens || 0,
                total_tokens: response.data?.usage?.total_tokens || 0,
                cached: false
            };

        } catch (error) {
            console.error('AI Orchestrator error:', error);
            
            // Fallback response
            return {
                message: "I'm having trouble processing your request right now. Please try again or contact support.",
                confidence: 0.3,
                escalation_needed: true,
                model: this.model,
                response_time: Date.now() - startTime,
                tokens_used: 0,
                topics: ['error'],
                source: 'fallback'
            };
        }
    }

    buildPrompt(message, context, memory, history, user) {
        const systemPrompt = `
You are Miles, the AI assistant for MilesSpace — a digital marketplace platform in Africa.

You help users with:
- Wallet balances (NGN, USD)
- Transaction history
- Withdrawal status
- Crypto purchases (BTC, USDT, USDC)
- Gift orders (sending products to anyone in the world)
- Gift card orders
- Marketplace transactions
- Account security
- Social boosting
- Virtual numbers

**YOUR PERSONALITY:**
- Professional but warm
- Concise but thorough
- Proactive — anticipate what the user needs
- Empathetic — especially with financial matters
- Never sound robotic

**RULES:**
1. ALWAYS use the provided context data. NEVER invent information.
2. If information is missing, say "I don't have that information" and offer to check or escalate.
3. Keep responses clear and helpful. Use bullet points for lists.
4. For financial matters, be specific: amounts, dates, references.
5. If a transaction is pending, give realistic time estimates.
6. If the user seems frustrated, apologize and offer to escalate to a human agent.
7. NEVER perform actions (withdrawals, transfers, etc.)
8. NEVER guess about money, transactions, or account status.

**CONTEXT:**
User: ${user?.username || 'User'} (${user?.email || 'No email'})
${context ? JSON.stringify(context, null, 2) : 'No specific context available'}

**MEMORY:**
${memory ? JSON.stringify(memory, null, 2) : 'No memory available'}

**RECENT CONVERSATION:**
${history && history.length > 0 ? history.slice(-5).map(h => `${h.sender_type}: ${h.message}`).join('\n') : 'New conversation'}

**USER QUESTION:**
${message}
`;

        return systemPrompt;
    }

    async callOpenRouter(prompt) {
        try {
            const response = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                    model: this.model,
                    messages: [
                        { role: 'system', content: prompt },
                        { role: 'user', content: 'Please provide a helpful, professional response.' }
                    ],
                    max_tokens: this.maxTokens,
                    temperature: this.temperature,
                    top_p: 0.9,
                    frequency_penalty: 0.3,
                    presence_penalty: 0.3,
                    stream: false
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': this.siteUrl,
                        'X-Title': this.siteName
                    },
                    timeout: this.timeout
                }
            );

            return response;
        } catch (error) {
            console.error('OpenRouter API error:', error);
            
            if (error.response) {
                console.error('OpenRouter error details:', error.response.data);
                throw new Error(`OpenRouter API error: ${error.response.data?.error || error.response.status}`);
            }
            
            throw error;
        }
    }

    processResponse(response, context) {
        const message = response.data?.choices?.[0]?.message?.content || '';
        let confidence = 0.8;
        let escalationNeeded = false;
        let topics = ['general'];

        // Analyze response for confidence indicators
        if (message.includes("I don't have") || 
            message.includes("I don't know") || 
            message.includes("I'm not sure") ||
            message.includes("I cannot")) {
            confidence = 0.4;
            escalationNeeded = true;
        }

        if (message.includes("escalate") || 
            message.includes("contact support") || 
            message.includes("human agent") ||
            message.includes("support team")) {
            escalationNeeded = true;
        }

        // Extract topics from response
        const topicKeywords = {
            'wallet': ['wallet', 'balance', 'fund', 'deposit'],
            'crypto': ['btc', 'bitcoin', 'usdt', 'tether', 'crypto'],
            'gift': ['gift', 'send', 'recipient', 'delivery'],
            'marketplace': ['marketplace', 'order', 'purchase', 'buy', 'sell'],
            'withdrawal': ['withdrawal', 'withdraw', 'cash out'],
            'account': ['account', 'verification', 'verify', 'login']
        };

        Object.entries(topicKeywords).forEach(([topic, keywords]) => {
            if (keywords.some(k => message.toLowerCase().includes(k))) {
                topics.push(topic);
            }
        });

        return {
            message: message,
            confidence: Math.round(confidence * 100) / 100,
            escalation_needed: escalationNeeded,
            topics: [...new Set(topics)],
            source: 'ai'
        };
    }

    // ─── CACHE FUNCTIONS ───
    async getCachedResponse(message, context) {
        try {
            const { supabaseAdmin } = require('../db/supabase');
            const crypto = require('crypto');
            
            const hash = crypto.createHash('md5').update(
                message.toLowerCase().trim() + JSON.stringify(context || {}).slice(0, 200)
            ).digest('hex');

            const { data, error } = await supabaseAdmin
                .from('ai_response_cache')
                .select('response_data')
                .eq('question_hash', hash)
                .gte('expires_at', new Date().toISOString())
                .single();

            if (error || !data) return null;

            // Update hit count
            await supabaseAdmin
                .from('ai_response_cache')
                .update({ 
                    hit_count: supabaseAdmin.rpc('increment', { row_id: data.id }),
                    last_accessed: new Date().toISOString()
                })
                .eq('id', data.id);

            return data.response_data;
        } catch (error) {
            console.error('Cache get error:', error);
            return null;
        }
    }

    async cacheResponse(message, context, response) {
        try {
            const { supabaseAdmin } = require('../db/supabase');
            const crypto = require('crypto');
            
            const hash = crypto.createHash('md5').update(
                message.toLowerCase().trim() + JSON.stringify(context || {}).slice(0, 200)
            ).digest('hex');

            await supabaseAdmin
                .from('ai_response_cache')
                .insert({
                    question_hash: hash,
                    question: message.substring(0, 500),
                    response_data: response,
                    expires_at: new Date(Date.now() + this.cacheTTL * 1000).toISOString(),
                    created_at: new Date().toISOString(),
                    hit_count: 0
                });
        } catch (error) {
            console.error('Cache save error:', error);
        }
    }
}

module.exports = new AIOrchestrator();