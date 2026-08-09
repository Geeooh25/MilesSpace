// services/aiService.js
// Complete OpenRouter integration with prompt building, caching, and context management

const axios = require('axios');
const { supabaseAdmin } = require('../db/supabase');

class AIService {
    constructor() {
        this.apiKey = process.env.OPENROUTER_API_KEY;
        this.model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3';
        this.siteUrl = process.env.SITE_URL || 'https://milesspace.com';
        this.siteName = process.env.SITE_NAME || 'MilesSpace';
        this.timeout = 15000;
        this.maxTokens = 500;
        this.temperature = 0.7;
        
        // Cache settings
        this.cacheTTL = 3600; // 1 hour
        this.enableCache = true;
        
        // Rate limiting
        this.maxRequestsPerMinute = 10;
        this.requestCounts = new Map();
        
        // Token tracking
        this.totalTokensUsed = 0;
        this.totalRequests = 0;
        
        console.log(`🤖 AI Service initialized with model: ${this.model}`);
    }

    // ─── MAIN AI REQUEST ───
    async getAIResponse(userId, question, context, conversationHistory = []) {
        try {
            // 1. Check cache first
            if (this.enableCache) {
                const cached = await this.getCachedResponse(question);
                if (cached) {
                    console.log('📦 AI cache hit');
                    return cached;
                }
            }

            // 2. Check rate limit
            if (!this.checkRateLimit(userId)) {
                return {
                    success: false,
                    error: 'Rate limit exceeded. Please wait a moment.',
                    shouldEscalate: false
                };
            }

            // 3. Build prompt
            const prompt = this.buildPrompt(question, context, conversationHistory);

            // 4. Call OpenRouter
            const response = await this.callOpenRouter(prompt);

            // 5. Process response
            const processed = this.processResponse(response, context);

            // 6. Save to cache
            if (this.enableCache && processed.confidence > 0.7) {
                await this.saveCachedResponse(question, processed);
            }

            // 7. Track usage
            this.trackUsage(response);

            return {
                success: true,
                message: processed.message,
                confidence: processed.confidence,
                shouldEscalate: processed.confidence < 0.6,
                escalationReason: processed.confidence < 0.6 ? 'Low confidence response' : null,
                tokensUsed: response.data?.usage?.total_tokens || 0,
                modelUsed: this.model
            };

        } catch (error) {
            console.error('AI response error:', error);
            
            // Fallback response
            return {
                success: false,
                message: "I'm having trouble processing your request. Please try again or contact support.",
                confidence: 0,
                shouldEscalate: true,
                escalationReason: 'AI error',
                error: error.message
            };
        }
    }

    // ─── BUILD PROMPT ───
    buildPrompt(question, context, conversationHistory = []) {
        // System prompt
        let systemPrompt = `You are Miles AI, the intelligent support assistant for MilesSpace.

You help users with:
- Wallet balances (NGN, USD)
- Transaction history
- Withdrawal status
- Crypto purchases (BTC, USDT, USDC)
- Gift orders (sending products to anyone in the world)
- Gift card orders
- Marketplace transactions
- Account security
- Cashback rewards

**IMPORTANT RULES:**
1. ONLY use the provided context data. NEVER invent or guess information.
2. If information is not in the context, say: "I don't have that information. Would you like me to escalate this to support?"
3. Keep responses helpful, professional, and concise (under 150 words).
4. NEVER perform actions (withdraw, transfer, change settings).
5. If user is upset, offer to escalate to a human agent.
6. For financial disputes or fraud, ALWAYS escalate.

**YOUR PERSONALITY:**
- Friendly and professional
- Clear and straightforward
- Helpful without being wordy
- Empathetic when users have problems

**RESPONSE FORMAT:**
- Use **bold** for important information
- Use bullet points for lists
- Keep paragraphs short`;

        // Add context if available
        let contextString = '';
        if (context) {
            contextString = `\n\n**USER CONTEXT:**\n${JSON.stringify(context, null, 2)}`;
        }

        // Add conversation history (last 5 messages)
        let historyString = '';
        if (conversationHistory && conversationHistory.length > 0) {
            const lastMessages = conversationHistory.slice(-5);
            historyString = `\n\n**RECENT CONVERSATION:**\n`;
            lastMessages.forEach(msg => {
                const sender = msg.sender_type === 'user' ? 'User' : 'Assistant';
                historyString += `${sender}: ${msg.message}\n`;
            });
        }

        const fullPrompt = systemPrompt + contextString + historyString + `\n\n**USER QUESTION:** ${question}\n\n**RESPONSE:**`;

        return fullPrompt;
    }

    // ─── CALL OPENROUTER ───
    async callOpenRouter(prompt) {
        try {
            const response = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                    model: this.model,
                    messages: [
                        { role: 'system', content: prompt },
                        { role: 'user', content: 'Please provide a helpful response based on the context provided.' }
                    ],
                    max_tokens: this.maxTokens,
                    temperature: this.temperature,
                    top_p: 0.9,
                    frequency_penalty: 0.3,
                    presence_penalty: 0.3
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
                // API returned error
                console.error('OpenRouter error details:', error.response.data);
                throw new Error(`OpenRouter API error: ${error.response.data?.error || error.response.status}`);
            }
            
            throw error;
        }
    }

    // ─── PROCESS RESPONSE ───
    processResponse(response, context) {
        const message = response.data?.choices?.[0]?.message?.content || '';
        
        // Calculate confidence based on various factors
        let confidence = 0.7; // Default
        
        // If message contains "I don't have" or "I don't know", lower confidence
        if (message.includes("I don't have") || 
            message.includes("I don't know") || 
            message.includes("I'm not sure") ||
            message.includes("I cannot")) {
            confidence = Math.min(confidence, 0.5);
        }
        
        // If message contains "escalate" or "support", lower confidence
        if (message.includes("escalate") || 
            message.includes("contact support") || 
            message.includes("human agent")) {
            confidence = Math.min(confidence, 0.4);
        }
        
        // If message is very short, lower confidence
        if (message.length < 20) {
            confidence = Math.min(confidence, 0.5);
        }
        
        // If context was provided and message references it, increase confidence
        if (context && message.includes("wallet") || message.includes("order") || message.includes("transaction")) {
            confidence = Math.min(confidence + 0.1, 1);
        }

        return {
            message: message,
            confidence: Math.round(confidence * 100) / 100
        };
    }

    // ─── CACHE FUNCTIONS ───
    async getCachedResponse(question) {
        try {
            // Simple exact match cache
            const { data, error } = await supabaseAdmin
                .from('ai_response_cache')
                .select('response_data')
                .eq('question_hash', this.hashQuestion(question))
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

    async saveCachedResponse(question, response) {
        try {
            const { error } = await supabaseAdmin
                .from('ai_response_cache')
                .insert({
                    question_hash: this.hashQuestion(question),
                    question: question,
                    response_data: response,
                    expires_at: new Date(Date.now() + this.cacheTTL * 1000).toISOString(),
                    created_at: new Date().toISOString(),
                    hit_count: 0
                });

            if (error) console.error('Cache save error:', error);
        } catch (error) {
            console.error('Cache save error:', error);
        }
    }

    hashQuestion(question) {
        const crypto = require('crypto');
        return crypto.createHash('md5').update(question.toLowerCase().trim()).digest('hex');
    }

    // ─── RATE LIMITING ───
    checkRateLimit(userId) {
        const now = Date.now();
        const window = 60000; // 1 minute
        
        if (!this.requestCounts.has(userId)) {
            this.requestCounts.set(userId, { count: 0, resetTime: now + window });
        }
        
        const userData = this.requestCounts.get(userId);
        
        // Reset if window expired
        if (now > userData.resetTime) {
            userData.count = 0;
            userData.resetTime = now + window;
        }
        
        // Check limit
        if (userData.count >= this.maxRequestsPerMinute) {
            return false;
        }
        
        userData.count++;
        return true;
    }

    // ─── TRACK USAGE ───
    trackUsage(response) {
        const tokens = response.data?.usage?.total_tokens || 0;
        this.totalTokensUsed += tokens;
        this.totalRequests++;
        
        console.log(`📊 AI Usage: ${this.totalRequests} requests, ${this.totalTokensUsed} tokens used`);
    }

    // ─── GET USAGE STATS ───
    getUsageStats() {
        return {
            totalRequests: this.totalRequests,
            totalTokensUsed: this.totalTokensUsed,
            modelUsed: this.model,
            estimatedCost: this.totalTokensUsed * 0.000002 // Rough estimate
        };
    }
}

module.exports = new AIService();