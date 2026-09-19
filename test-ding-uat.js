// test-ding-uat.js
// Complete test script for DingConnect with OAuth2 (Client ID + Secret)
// Run: node test-ding-uat.js [command] [country] [amount]

const axios = require('axios');
const https = require('https');
require('dotenv').config();

// ─── CONFIGURATION ──────────────────────────────────────────────────────

const DING_CONFIG = {
    // UAT Environment
    uat: {
        baseUrl: 'https://api-uat.dingconnect.com',
        authUrl: 'https://api-uat.dingconnect.com/oauth/token',
        clientId: process.env.DINGCONNECT_UAT_CLIENT_ID || process.env.DINGCONNECT_CLIENT_ID,
        clientSecret: process.env.DINGCONNECT_UAT_CLIENT_SECRET || process.env.DINGCONNECT_CLIENT_SECRET,
        // UAT test numbers
        testNumbers: {
            'NG': '2348030000000',  // Nigeria - MTN test number
            'GH': '233240000000',   // Ghana - AirtelTigo test number
            'KE': '254700000000',   // Kenya - Safaricom test number
            'ZA': '27730000000',    // South Africa - Vodacom test number
            'US': '15550000000',    // USA - Test number
            'GB': '447700000000',   // UK - Test number
            'IN': '919999999999',   // India - Test number
            'FR': '33600000000',    // France - Test number
            'DE': '491700000000',   // Germany - Test number
        },
        supportedCountries: ['NG', 'GH', 'KE', 'ZA', 'US', 'GB', 'IN', 'FR', 'DE'],
    },
    // Production Environment
    prod: {
        baseUrl: 'https://api.dingconnect.com',
        authUrl: 'https://api.dingconnect.com/oauth/token',
        clientId: process.env.DINGCONNECT_PROD_CLIENT_ID || process.env.DINGCONNECT_CLIENT_ID,
        clientSecret: process.env.DINGCONNECT_PROD_CLIENT_SECRET || process.env.DINGCONNECT_CLIENT_SECRET,
    },
    // Legacy API Key (fallback)
    legacy: {
        apiKey: process.env.DINGCONNECT_API_KEY || process.env.DINGCONNECT_UAT_API_KEY,
    },
    testAmounts: [1, 5, 10, 25, 50, 100],
    operators: {
        'NG': ['MTN', 'GLO', 'AIRTEL', '9MOBILE'],
        'GH': ['MTN', 'VODAFONE', 'AIRTELTIGO'],
        'KE': ['SAFARICOM', 'AIRTEL', 'TELKOM'],
        'ZA': ['VODACOM', 'MTN', 'CELLC'],
    }
};

// ─── DINGCONNECT UAT CLIENT ────────────────────────────────────────────

class DingConnectUATClient {
    constructor(environment = 'uat') {
        this.environment = environment;
        const config = DING_CONFIG[environment];
        if (!config) {
            throw new Error(`Unknown environment: ${environment}`);
        }
        this.baseUrl = config.baseUrl;
        this.authUrl = config.authUrl;
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.testNumbers = config.testNumbers || {};
        this.accessToken = null;
        this.tokenExpiry = null;
        
        this.httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 50,
            maxFreeSockets: 10,
            timeout: 30000,
        });
        
        this.axios = axios.create({
            httpsAgent: this.httpsAgent,
            timeout: 30000,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            }
        });

        console.log(`🔌 [DingConnect] Initialized ${environment.toUpperCase()} client`);
        console.log(`   Base URL: ${this.baseUrl}`);
        console.log(`   Client ID: ${this.clientId ? '✓ Set' : '✗ Missing'}`);
        console.log(`   Client Secret: ${this.clientSecret ? '✓ Set' : '✗ Missing'}`);
    }

    // ─── GET ACCESS TOKEN (OAuth2) ─────────────────────────────────────

    async getAccessToken() {
        // Check if we have a valid token
        if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        try {
            console.log('🔑 [DingConnect] Getting access token...');

            // Use OAuth2 client credentials flow
            const params = new URLSearchParams();
            params.append('grant_type', 'client_credentials');
            
            // Try both email and client_id formats
            const clientId = this.clientId;
            const clientSecret = this.clientSecret;

            // Some DingConnect endpoints use email as client_id
            const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

            const response = await this.axios.post(
                this.authUrl,
                params.toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': authHeader,
                    }
                }
            );

            if (response.data && response.data.access_token) {
                this.accessToken = response.data.access_token;
                // Token expires in 3600 seconds (1 hour) by default
                const expiresIn = response.data.expires_in || 3600;
                this.tokenExpiry = Date.now() + (expiresIn * 1000) - 60000; // 1 minute buffer
                console.log(`✅ [DingConnect] Access token obtained (expires in ${expiresIn}s)`);
                return this.accessToken;
            }

            throw new Error('No access token in response');

        } catch (error) {
            console.error('❌ [DingConnect] Failed to get access token:', error.message);
            if (error.response) {
                console.error('   Status:', error.response.status);
                console.error('   Data:', error.response.data);
            }
            throw error;
        }
    }

    // ─── MAKE AUTHENTICATED REQUEST ────────────────────────────────────

    async request(method, path, data = null) {
        const token = await this.getAccessToken();
        const url = `${this.baseUrl}${path}`;
        
        try {
            const config = {
                method,
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            };
            
            if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
                config.data = data;
            }

            const response = await this.axios(config);
            return response.data;
        } catch (error) {
            if (error.response) {
                console.error(`❌ [DingConnect] Request failed: ${error.response.status}`);
                console.error('   Data:', error.response.data);
                throw new Error(`DingConnect API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
            }
            throw error;
        }
    }

    // ─── GET AVAILABLE COUNTRIES ──────────────────────────────────────

    async getCountries() {
        return this.request('GET', '/v1/countries');
    }

    // ─── GET OPERATORS FOR COUNTRY ─────────────────────────────────────

    async getOperators(countryCode) {
        return this.request('GET', `/v1/countries/${countryCode}/operators`);
    }

    // ─── GET OPERATOR PRODUCTS ─────────────────────────────────────────

    async getOperatorProducts(countryCode, operatorId) {
        return this.request('GET', `/v1/countries/${countryCode}/operators/${operatorId}/products`);
    }

    // ─── GET QUOTE ─────────────────────────────────────────────────────

    async getQuote({ countryCode, phone, providerCode, skuCode, sendValue, sendCurrency = 'USD' }) {
        const payload = {
            countryCode,
            phone,
            providerCode,
            sendValue,
            sendCurrency,
        };
        
        if (skuCode) {
            payload.skuCode = skuCode;
        }

        return this.request('POST', '/v1/quote', payload);
    }

    // ─── PURCHASE AIRTIME ──────────────────────────────────────────────

    async purchaseAirtime({ countryCode, phone, providerCode, skuCode, sendValue, sendCurrency = 'USD', reference = null }) {
        const payload = {
            countryCode,
            phone,
            providerCode,
            sendValue,
            sendCurrency,
        };
        
        if (skuCode) payload.skuCode = skuCode;
        if (reference) payload.reference = reference;

        return this.request('POST', '/v1/purchase', payload);
    }

    // ─── QUERY TRANSACTION ─────────────────────────────────────────────

    async queryTransaction(transactionId) {
        return this.request('GET', `/v1/transactions/${transactionId}`);
    }

    // ─── GET UAT TEST NUMBER ──────────────────────────────────────────

    getTestNumber(countryCode) {
        const number = this.testNumbers[countryCode];
        if (!number) {
            console.warn(`⚠️ No UAT test number for ${countryCode}, using fallback`);
            return `2348000000000`;
        }
        return number;
    }

    // ─── GENERATE REFERENCE ────────────────────────────────────────────

    generateReference() {
        const timestamp = Date.now().toString(36).toUpperCase();
        const random = Math.random().toString(36).substring(2, 8).toUpperCase();
        return `UAT-${timestamp}-${random}`;
    }
}

// ─── TEST FUNCTIONS ────────────────────────────────────────────────────

async function testCountries(client) {
    console.log('\n📡 [TEST] Getting countries...');
    try {
        const result = await client.getCountries();
        console.log(`✅ [TEST] Got ${result.length || '?'} countries`);
        if (result && result.length > 0) {
            const sample = result.slice(0, 5);
            console.log('   Sample countries:');
            sample.forEach(c => {
                console.log(`     ${c.code}: ${c.name} (${c.dial})`);
            });
        }
        return result;
    } catch (error) {
        console.error('❌ [TEST] Countries test failed:', error.message);
        return null;
    }
}

async function testOperators(client, countryCode) {
    console.log(`\n📡 [TEST] Getting operators for ${countryCode}...`);
    try {
        const result = await client.getOperators(countryCode);
        console.log(`✅ [TEST] Got ${result.length || '?'} operators for ${countryCode}`);
        if (result && result.length > 0) {
            console.log('   Operators:');
            result.slice(0, 5).forEach(op => {
                console.log(`     ${op.code}: ${op.name}`);
            });
        }
        return result;
    } catch (error) {
        console.error(`❌ [TEST] Operators test failed for ${countryCode}:`, error.message);
        return null;
    }
}

async function testQuote(client, countryCode, phone, providerCode, amount) {
    console.log(`\n📡 [TEST] Getting quote for ${countryCode} ${phone} via ${providerCode}...`);
    console.log(`   Amount: $${amount}`);
    try {
        const result = await client.getQuote({
            countryCode,
            phone,
            providerCode,
            sendValue: amount,
            sendCurrency: 'USD',
        });
        console.log(`✅ [TEST] Quote received:`);
        console.log(`   Response:`, JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        console.error(`❌ [TEST] Quote test failed:`, error.message);
        return null;
    }
}

async function testPurchase(client, countryCode, phone, providerCode, amount) {
    console.log(`\n📡 [TEST] Purchasing airtime for ${countryCode} ${phone}...`);
    console.log(`   Amount: $${amount}`);
    const reference = client.generateReference();
    console.log(`   Reference: ${reference}`);
    
    try {
        const result = await client.purchaseAirtime({
            countryCode,
            phone,
            providerCode,
            sendValue: amount,
            sendCurrency: 'USD',
            reference,
        });
        console.log(`✅ [TEST] Purchase response:`);
        console.log(`   Status: ${result.status}`);
        console.log(`   Transaction ID: ${result.transactionId || 'N/A'}`);
        console.log(`   Response:`, JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        console.error(`❌ [TEST] Purchase test failed:`, error.message);
        if (error.response) {
            console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
        }
        return null;
    }
}

// ─── QUICK TEST FOR SINGLE COUNTRY ────────────────────────────────────

async function quickTest(countryCode = 'NG', amount = 5) {
    console.log(`\n🔍 Quick test for ${countryCode} with $${amount}`);
    
    const clientId = process.env.DINGCONNECT_CLIENT_ID;
    const clientSecret = process.env.DINGCONNECT_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
        console.error('❌ DINGCONNECT_CLIENT_ID or DINGCONNECT_CLIENT_SECRET not set in .env');
        console.error('   Please add:');
        console.error('   DINGCONNECT_CLIENT_ID=your-client-id');
        console.error('   DINGCONNECT_CLIENT_SECRET=your-client-secret');
        return;
    }

    const client = new DingConnectUATClient('uat');
    const testNumber = client.getTestNumber(countryCode);
    
    console.log(`📱 Test number: ${testNumber}`);
    
    try {
        // Get countries first to test auth
        const countries = await client.getCountries();
        console.log(`✅ Got ${countries.length} countries`);
        
        // Get operators
        const operators = await client.getOperators(countryCode);
        if (!operators || operators.length === 0) {
            console.error(`❌ No operators found for ${countryCode}`);
            return;
        }

        const operator = operators[0];
        console.log(`📡 Operator: ${operator.code} - ${operator.name}`);

        // Test quote
        const quote = await client.getQuote({
            countryCode,
            phone: testNumber,
            providerCode: operator.code,
            sendValue: amount,
            sendCurrency: 'USD',
        });
        console.log('✅ Quote:', JSON.stringify(quote, null, 2));

        // Test purchase
        const purchase = await client.purchaseAirtime({
            countryCode,
            phone: testNumber,
            providerCode: operator.code,
            sendValue: amount,
            sendCurrency: 'USD',
            reference: client.generateReference(),
        });
        console.log('✅ Purchase:', JSON.stringify(purchase, null, 2));

        if (purchase.transactionId) {
            const query = await client.queryTransaction(purchase.transactionId);
            console.log('✅ Query:', JSON.stringify(query, null, 2));
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('   Response:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

// ─── TEST SPECIFIC COUNTRY WITH ALL OPERATORS ─────────────────────────

async function testCountryAllOperators(countryCode = 'NG', amount = 5) {
    console.log(`\n🔍 Testing ${countryCode} with all operators`);
    
    const clientId = process.env.DINGCONNECT_CLIENT_ID;
    const clientSecret = process.env.DINGCONNECT_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
        console.error('❌ DINGCONNECT_CLIENT_ID or DINGCONNECT_CLIENT_SECRET not set in .env');
        console.error('   Please add:');
        console.error('   DINGCONNECT_CLIENT_ID=your-client-id');
        console.error('   DINGCONNECT_CLIENT_SECRET=your-client-secret');
        return;
    }

    const client = new DingConnectUATClient('uat');
    const testNumber = client.getTestNumber(countryCode);
    
    console.log(`📱 Test number: ${testNumber}`);
    
    try {
        const operators = await client.getOperators(countryCode);
        if (!operators || operators.length === 0) {
            console.error(`❌ No operators found for ${countryCode}`);
            return;
        }

        console.log(`📡 Found ${operators.length} operators for ${countryCode}`);
        
        for (const op of operators.slice(0, 5)) {
            console.log(`\n📡 Testing ${op.code} - ${op.name}...`);
            try {
                const quote = await client.getQuote({
                    countryCode,
                    phone: testNumber,
                    providerCode: op.code,
                    sendValue: amount,
                    sendCurrency: 'USD',
                });
                console.log(`✅ ${op.code} quote successful`);
                console.log(`   Receive: ${quote.receiveValue} ${quote.receiveCurrency}`);
            } catch (error) {
                console.log(`❌ ${op.code} failed:`, error.message);
            }
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

// ─── RUN ────────────────────────────────────────────────────────────────

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'quick';
const country = args[1] || 'NG';
const amount = parseFloat(args[2]) || 5;

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  🧪 DINGCONNECT UAT TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`\n📋 Command: ${command}`);
console.log(`📋 Country: ${country}`);
console.log(`📋 Amount: $${amount}`);

if (command === 'quick' || command === 'q') {
    quickTest(country, amount).catch(console.error);
} else if (command === 'country' || command === 'c') {
    testCountryAllOperators(country, amount).catch(console.error);
} else if (command === 'all') {
    // Test all countries
    (async () => {
        const countries = ['NG', 'GH', 'KE', 'ZA'];
        for (const c of countries) {
            await testCountryAllOperators(c, amount);
        }
    })().catch(console.error);
} else {
    console.log('\nUsage:');
    console.log('  node test-ding-uat.js quick [country] [amount]  - Quick test for one country');
    console.log('  node test-ding-uat.js country [country] [amount] - Test all operators in a country');
    console.log('  node test-ding-uat.js all [amount]               - Test all countries');
    console.log('\nExamples:');
    console.log('  node test-ding-uat.js quick NG 5');
    console.log('  node test-ding-uat.js country NG 10');
    console.log('  node test-ding-uat.js all 5');
}