// test-bitnob.js
require('dotenv').config();
const { getUSDNGNRate, getBTCUSDRate, getBalances } = require('./services/bitnob');

async function testBitnob() {
  console.log('🔍 Testing Bitnob API...\n');

  try {
    // 1. Get balances
    console.log('📊 Fetching balances...');
    const balances = await getBalances();
    console.log('✅ Balances:', JSON.stringify(balances, null, 2));
  } catch (e) {
    console.log('❌ Balances error:', e.message);
  }

  try {
    // 2. Get USD/NGN rate
    console.log('\n💱 Fetching USD/NGN rate...');
    const usdNgn = await getUSDNGNRate();
    console.log('✅ USD/NGN:', usdNgn);
  } catch (e) {
    console.log('❌ USD/NGN error:', e.message);
  }

  try {
    // 3. Get BTC/USD rate
    console.log('\n₿ Fetching BTC/USD rate...');
    const btcUsd = await getBTCUSDRate();
    console.log('✅ BTC/USD:', btcUsd);
  } catch (e) {
    console.log('❌ BTC/USD error:', e.message);
  }
}

testBitnob();