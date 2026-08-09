// test-openrouter.js
require('dotenv').config();

const axios = require('axios');

async function testOpenRouter() {
    const model = process.env.OPENROUTER_MODEL || 'google/gemma-3-27b-it';
    
    console.log('🔍 Testing OpenRouter API Key...');
    console.log(`   API Key: ${process.env.OPENROUTER_API_KEY ? '✅ Present' : '❌ Missing'}`);
    console.log(`   Model: ${model}`);
    
    if (!process.env.OPENROUTER_API_KEY) {
        console.error('❌ OPENROUTER_API_KEY is not set in .env file');
        return false;
    }

    try {
        console.log('📡 Sending request to OpenRouter...');
        console.log(`   URL: https://openrouter.ai/api/v1/chat/completions`);
        console.log(`   Model: ${model}`);
        
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: model,
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are a helpful assistant.' 
                    },
                    { 
                        role: 'user', 
                        content: 'Say "Hello! MilesSpace AI is working!" in a friendly tone.' 
                    }
                ],
                max_tokens: 50,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'http://localhost:5000',
                    'X-Title': 'MilesSpace'
                },
                timeout: 30000,
                validateStatus: false // Don't throw on any status
            }
        );

        console.log(`   Status: ${response.status}`);
        console.log(`   Status Text: ${response.statusText}`);
        
        if (response.status === 200) {
            console.log('✅ Success!');
            console.log(`   Response: ${response.data.choices[0].message.content}`);
            console.log(`   Model used: ${response.data.model}`);
            console.log(`   Tokens used: ${response.data.usage?.total_tokens || 'N/A'}`);
            return true;
        } else {
            console.error('❌ Error Response:');
            console.error(`   Status: ${response.status}`);
            console.error(`   Data:`, JSON.stringify(response.data, null, 2));
            return false;
        }

    } catch (error) {
        console.error('❌ Catch Block Error:');
        console.error(`   Message: ${error.message}`);
        console.error(`   Code: ${error.code}`);
        
        if (error.response) {
            console.error(`   Response Status: ${error.response.status}`);
            console.error(`   Response Data:`, JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
            console.error(`   Request made but no response received`);
            console.error(`   This could be a network issue or OpenRouter is down`);
            console.error(`   Check: https://status.openrouter.ai/`);
        } else {
            console.error(`   Error details:`, error);
        }
        return false;
    }
}

testOpenRouter();