// services/memoryService.js
// Stores and retrieves user memory for personalized AI responses

const { supabaseAdmin } = require('../db/supabase');

class MemoryService {
    constructor() {
        this.memoryTTL = 30 * 24 * 60 * 60 * 1000; // 30 days
    }

    async getUserMemory(userId) {
        try {
            const { data, error } = await supabaseAdmin
                .from('support_context_cache')
                .select('context_data, expires_at')
                .eq('user_id', userId)
                .gte('expires_at', new Date().toISOString())
                .single();

            if (error || !data) return null;

            return data.context_data;
        } catch (error) {
            console.error('Get memory error:', error);
            return null;
        }
    }

    async updateMemory(userId, newData) {
        try {
            // Get existing memory
            const existing = await this.getUserMemory(userId);
            
            // Merge with new data
            const merged = {
                ...existing,
                ...newData,
                updated_at: new Date().toISOString()
            };

            // Keep only last 50 interactions
            if (merged.history && merged.history.length > 50) {
                merged.history = merged.history.slice(-50);
            }

            // Save
            const expiresAt = new Date(Date.now() + this.memoryTTL);
            
            const { error } = await supabaseAdmin
                .from('support_context_cache')
                .upsert({
                    user_id: userId,
                    context_data: merged,
                    expires_at: expiresAt.toISOString(),
                    created_at: new Date().toISOString()
                }, {
                    onConflict: 'user_id'
                });

            if (error) throw error;
            return merged;
        } catch (error) {
            console.error('Update memory error:', error);
            return null;
        }
    }

    async addInteraction(userId, question, response, topics = []) {
        try {
            const memory = await this.getUserMemory(userId) || {
                history: [],
                preferences: {},
                topics: []
            };

            memory.history = memory.history || [];
            memory.history.push({
                question: question,
                response: response.substring(0, 200),
                topics: topics,
                timestamp: new Date().toISOString()
            });

            // Track topics
            memory.topics = [...new Set([...(memory.topics || []), ...topics])];

            // Keep only last 50
            if (memory.history.length > 50) {
                memory.history = memory.history.slice(-50);
            }

            return await this.updateMemory(userId, memory);
        } catch (error) {
            console.error('Add interaction error:', error);
            return null;
        }
    }
}

module.exports = new MemoryService();