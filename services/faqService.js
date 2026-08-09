// services/faqService.js
// Intelligent FAQ search with semantic matching

const { supabaseAdmin } = require('../db/supabase');

class FAQService {
    constructor() {
        this.similarityThreshold = 0.7;
    }

    async searchFAQ(question) {
        try {
            const questionLower = question.toLowerCase();
            
            // Try exact keyword matching first
            let { data: exactMatches, error: exactError } = await supabaseAdmin
                .from('faq_items')
                .select(`
                    id,
                    question,
                    answer,
                    category:category_id(name, icon),
                    keywords,
                    views,
                    helpful_count
                `)
                .eq('is_active', true)
                .ilike('question', `%${questionLower}%`)
                .order('helpful_count', { ascending: false })
                .limit(5);

            if (exactError) throw exactError;

            if (exactMatches && exactMatches.length > 0) {
                // Update views
                await this.updateViews(exactMatches[0].id);
                return exactMatches;
            }

            // Try keyword matching
            const keywords = this.extractKeywords(questionLower);
            if (keywords.length > 0) {
                const { data: keywordMatches, error: keywordError } = await supabaseAdmin
                    .from('faq_items')
                    .select(`
                        id,
                        question,
                        answer,
                        category:category_id(name, icon),
                        keywords,
                        views,
                        helpful_count
                    `)
                    .eq('is_active', true)
                    .contains('keywords', keywords.slice(0, 3))
                    .order('helpful_count', { ascending: false })
                    .limit(3);

                if (!keywordError && keywordMatches && keywordMatches.length > 0) {
                    await this.updateViews(keywordMatches[0].id);
                    return keywordMatches;
                }
            }

            return [];
        } catch (error) {
            console.error('FAQ search error:', error);
            return [];
        }
    }

    extractKeywords(text) {
        // Remove common words and extract meaningful keywords
        const commonWords = ['how', 'what', 'why', 'when', 'where', 'who', 'does', 'do', 'is', 'are', 'am', 
                           'can', 'will', 'would', 'should', 'could', 'my', 'your', 'our', 'their', 'i', 'you', 
                           'he', 'she', 'it', 'we', 'they', 'the', 'a', 'an', 'and', 'or', 'but', 'so', 'for', 
                           'nor', 'on', 'at', 'to', 'by', 'in', 'with', 'without', 'of'];
        
        const words = text.split(/\s+/).filter(w => w.length > 2 && !commonWords.includes(w));
        return words;
    }

    async updateViews(faqId) {
        try {
            await supabaseAdmin
                .from('faq_items')
                .update({ views: supabaseAdmin.rpc('increment', { row_id: faqId }) })
                .eq('id', faqId);
        } catch (error) {
            console.error('Update views error:', error);
        }
    }

    async recordFeedback(faqId, helpful) {
        try {
            const field = helpful ? 'helpful_count' : 'unhelpful_count';
            await supabaseAdmin
                .from('faq_items')
                .update({ [field]: supabaseAdmin.rpc('increment', { row_id: faqId }) })
                .eq('id', faqId);
        } catch (error) {
            console.error('Record feedback error:', error);
        }
    }
}

module.exports = new FAQService();