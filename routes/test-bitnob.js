// test-bitnob.js — No external dependencies
const http = require('http');

const BASE_URL = 'http://localhost:5000';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJmYjA2MWFmYy1kZTM1LTRiODktOWNhMy0xOGJlMDY1Y2U0NzgiLCJlbWFpbCI6Imx1a0BoLmNvbSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzg0NjIxMjgwLCJleHAiOjE3ODQ2MjQ4ODB9.26Vdk08w5v-P8qgnptkRNeV4oJAxil2cl9d7KeYz6JY'; // Replace with your actual token

function apiRequest(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${endpoint}`);
    const headers = {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers
    };

    const req = http.request(url, {
      method: options.method || 'GET',
      headers: headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function testBitnob() {
  console.log('🧪 Testing Bitnob Integration\n');
  console.log('─'.repeat(50));

  try {
    // 1. Test Connection
    console.log('🔄 1. Testing connection...');
    const testResult = await apiRequest('/api/busha/test');
    if (testResult.success) {
      console.log('✅ Connection successful!');
      console.log(`   Message: ${testResult.message}\n`);
    } else {
      console.log('❌ Connection failed:', testResult.error);
      return;
    }

    // 2. Get Rates
    console.log('🔄 2. Fetching rates...');
    const rates = await apiRequest('/api/busha/rates?vs=NGN');
    if (rates.success) {
      console.log('✅ Rates fetched:');
      Object.entries(rates.data).forEach(([coin, rate]) => {
        console.log(`   ${coin}: ₦${rate.toLocaleString()}`);
      });
      console.log('');
    } else {
      console.log('❌ Failed to fetch rates:', rates.error);
      return;
    }

    // 3. Create Quote
    console.log('🔄 3. Creating quote...');
    const quote = await apiRequest('/api/busha/quote', {
      method: 'POST',
      body: {
        coin: 'BTC',
        amount: 10000,
        network: 'BTC',
        address: 'bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
      }
    });

    if (quote.success) {
      console.log('✅ Quote created:');
      console.log(`   Order ID: ${quote.data.order_id}`);
      console.log(`   Bank: ${quote.data.bank_name}`);
      console.log(`   Account: ${quote.data.account_number}`);
      console.log(`   Amount to send: ₦${quote.data.amount_to_send.toLocaleString()}`);
      console.log(`   Crypto: ${quote.data.crypto_amount} ${quote.data.coin}`);
      console.log(`   Reference: ${quote.data.reference}\n`);
      
      const orderId = quote.data.order_id;

      // 4. Check Status
      console.log('🔄 4. Checking status...');
      const status = await apiRequest(`/api/busha/status/${orderId}`);
      if (status.success) {
        console.log('✅ Status:');
        console.log(`   Order: ${status.data.order_id}`);
        console.log(`   Status: ${status.data.status}`);
        console.log(`   Coin: ${status.data.coin}`);
        console.log(`   Amount: ${status.data.amount}\n`);
      }

      console.log('🎉 All tests passed! Your Bitnob integration is working.');
    } else {
      console.log('❌ Failed to create quote:', quote.error);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.log('\n💡 Tips:');
    console.log('  1. Make sure your server is running');
    console.log('  2. Check that BITNOB_CLIENT_ID and BITNOB_CLIENT_SECRET are set in .env');
    console.log('  3. Verify your user token is valid');
  }
}

testBitnob();