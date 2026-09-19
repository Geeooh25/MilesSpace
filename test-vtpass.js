require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.VTPASS_API_KEY;
const PUBLIC_KEY = process.env.VTPASS_PUBLIC_KEY;
const SECRET_KEY = process.env.VTPASS_SECRET_KEY;
const BASE_URL = 'https://sandbox.vtpass.com/api';

const headers = {
  'api-key': API_KEY,
  'secret-key': SECRET_KEY,
  'Content-Type': 'application/json'
};

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  🧪 VTPass Sandbox Test');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Step 1: Get ALL service categories
async function getServiceCategories() {
  console.log('📡 Fetching service categories...\n');
  try {
    const response = await axios.get(
      `${BASE_URL}/service-categories`,
      { headers: { ...headers, 'public-key': PUBLIC_KEY } }
    );
    
    const categories = response.data?.content || response.data || [];
    console.log('✅ Service Categories:');
    categories.forEach(cat => {
      console.log(`   ID: ${cat.identifier || cat.serviceID || 'N/A'}`);
      console.log(`   Name: ${cat.name || cat.category_name || 'N/A'}`);
      console.log('');
    });
    return categories;
  } catch (error) {
    console.error('❌ Categories error:', error.response?.data || error.message);
    return [];
  }
}

// Step 2: Get international airtime services
async function getInternationalAirtime() {
  console.log('📡 Fetching international airtime services...\n');
  try {
    const response = await axios.get(
      `${BASE_URL}/service-categories?identifier=international-airtime`,
      { headers: { ...headers, 'public-key': PUBLIC_KEY } }
    );
    
    console.log('International Airtime Response:');
    console.log(JSON.stringify(response.data, null, 2).substring(0, 2000));
    return response.data;
  } catch (error) {
    console.error('❌ International airtime error:', error.response?.data || error.message);
    return null;
  }
}

// Step 3: Get operators for a specific country code
async function getOperators(billerCode) {
  try {
    const response = await axios.get(
      `${BASE_URL}/operators?identifier=international-airtime&billerCode=${billerCode}`,
      { headers: { ...headers, 'public-key': PUBLIC_KEY } }
    );
    return response.data?.content || [];
  } catch (error) {
    console.error(`  ❌ Operators for ${billerCode}:`, error.response?.data?.response_description || error.message);
    return [];
  }
}

// Step 4: Query product for Afghanistan
async function queryAfghanistan() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🇦🇫 AFGHANISTAN QUERY TEST');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  const billersCodes = ['AF', 'AFG', 'AFGHANISTAN', '93'];
  
  for (const code of billersCodes) {
    console.log(`\n  Testing billersCode: ${code}`);
    const operators = await getOperators(code);
    
    if (operators.length > 0) {
      console.log(`  ✅ Found ${operators.length} operators:`);
      operators.forEach(op => {
        console.log(`     - ${op.name || op.operator_name || 'Unknown'}: ${op.variation_code || op.code || 'N/A'}`);
      });
      break;
    } else {
      console.log(`  ❌ No operators for "${code}"`);
    }
  }
}

// Step 5: Test Nigerian airtime (sandbox usually works for this)
async function testNigeriaAirtime() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🇳🇬 NIGERIA AIRTIME TEST (Sandbox)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  const testNetworks = [
    { serviceID: 'mtn', phone: '08031234567', name: 'MTN' },
    { serviceID: 'glo', phone: '08051234567', name: 'Glo' },
    { serviceID: 'airtel', phone: '08021234567', name: 'Airtel' },
    { serviceID: 'etisalat', phone: '08091234567', name: '9mobile' },
  ];
  
  for (const network of testNetworks) {
    const requestId = 'TEST' + Date.now() + Math.random().toString(36).substring(2, 5);
    
    console.log(`\n  Testing ${network.name} (${network.phone}):`);
    console.log(`  Request ID: ${requestId}`);
    
    try {
      const response = await axios.post(
        `${BASE_URL}/pay`,
        {
          request_id: requestId,
          serviceID: network.serviceID,
          amount: 10,  // ₦10 or $10
          phone: network.phone
        },
        { headers }
      );
      
      const data = response.data;
      console.log(`  Code: ${data.code}`);
      console.log(`  Response: ${data.response_description || data.message || 'N/A'}`);
      console.log(`  Transaction Status: ${data.content?.transactions?.status || 'N/A'}`);
      console.log(`  Recipient Gets: ${data.amount || data.content?.transactions?.amount || 'N/A'}`);
    } catch (error) {
      console.log(`  ❌ Error: ${error.response?.data?.response_description || error.message}`);
    }
  }
}

// Step 6: Get all billers/services
async function getAllServices() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  📋 ALL AVAILABLE SERVICES');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  try {
    const response = await axios.get(
      `${BASE_URL}/services`,
      { headers: { ...headers, 'public-key': PUBLIC_KEY } }
    );
    
    const services = response.data?.content || response.data || [];
    console.log(`Found ${services.length} services:`);
    services.slice(0, 20).forEach(svc => {
      console.log(`   - ${svc.name || svc.service_name || 'Unknown'}: ${svc.serviceID || svc.identifier || 'N/A'}`);
    });
    
    if (services.length > 20) {
      console.log(`   ... and ${services.length - 20} more`);
    }
  } catch (error) {
    console.error('❌ Services error:', error.response?.data || error.message);
  }
}

// Step 7: Try Airtime API directly
async function tryDirectAirtimeQuery() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  💰 DIRECT AIRTIME QUERY TESTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  const tests = [
    { label: 'MTN Nigeria', serviceID: 'mtn', phone: '08031234567' },
    { label: 'International - Afghanistan (try)', serviceID: 'international-airtime', billersCode: 'AF', phone: '+93701234567' },
    { label: 'International - Ghana', serviceID: 'international-airtime', billersCode: 'GH', phone: '+233241234567' },
  ];
  
  for (const test of tests) {
    console.log(`\n  Querying: ${test.label}`);
    
    const payload = {
      request_id: 'QRY' + Date.now(),
      serviceID: test.serviceID,
      phone: test.phone
    };
    
    if (test.billersCode) {
      payload.billersCode = test.billersCode;
      payload.amount = 10;
    }
    
    try {
      const response = await axios.post(`${BASE_URL}/query`, payload, { headers });
      console.log(`  ✅ Response:`, JSON.stringify(response.data).substring(0, 500));
    } catch (error) {
      console.log(`  ❌ Error:`, error.response?.data?.response_description || error.message);
    }
  }
}

async function main() {
  await getServiceCategories();
  await getInternationalAirtime();
  await queryAfghanistan();
  await testNigeriaAirtime();
  await getAllServices();
  await tryDirectAirtimeQuery();
  
  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  📌 NOTES');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  • Sandbox has LIMITED international data');
  console.log('  • Use PRODUCTION API for full country list');
  console.log('  • Sandbox is for testing NIGERIAN services');
  console.log('  • For international rates, switch to live mode');
  console.log('');
}

main().catch(console.error);