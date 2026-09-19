// test-dingconnect-india-fix.js
// FIXED: Uses correct SKU values for India

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

console.log('═══════════════════════════════════════════════════════════');
console.log('🔌 DINGCONNECT INDIA TEST (FIXED)');
console.log('═══════════════════════════════════════════════════════════');

const CONFIG = {
    baseUrl: process.env.DINGCONNECT_API_URL || 'https://api.dingconnect.com',
    tokenUrl: 'https://idp.ding.com/connect/token',
};

function generateReference() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `UAT-${ts}-${rand}`;
}

// ─── GET OAUTH TOKEN ───────────────────────────────────────────────────

async function getOAuthToken() {
    console.log('\n🔑 Getting OAuth Token...');
    
    const clientId = process.env.DINGCONNECT_CLIENT_ID;
    const clientSecret = process.env.DINGCONNECT_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('❌ Missing OAuth credentials!');
        return null;
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    try {
        const response = await axios.post(CONFIG.tokenUrl, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000
        });

        console.log('   ✅ Token obtained!');
        return response.data.access_token;

    } catch (error) {
        console.error('   ❌ Failed to get token:', error.message);
        return null;
    }
}

// ─── GET PRODUCTS ──────────────────────────────────────────────────────

async function getProducts(token, country) {
    console.log(`\n📦 Getting products for ${country}...`);
    
    const url = `${CONFIG.baseUrl}/api/V1/GetProducts?countryIsos=${country}&benefits=Mobile`;
    
    try {
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const products = response.data?.Items || [];
        console.log(`   Found ${products.length} products`);
        return products;

    } catch (error) {
        console.error('   ❌ Failed:', error.message);
        return [];
    }
}

// ─── EXTRACT VALUE FROM PRODUCT ──────────────────────────────────────

function extractValue(product, type = 'Maximum') {
    const container = product[type] || product.maximum || product.minimum || product;
    
    return {
        sendValue: parseFloat(container.SendValue || container.sendValue || 0),
        sendCurrency: container.SendCurrencyIso || container.sendCurrencyIso || 'USD',
        receiveValue: parseFloat(container.ReceiveValue || container.receiveValue || 0),
        receiveCurrency: container.ReceiveCurrencyIso || container.receiveCurrencyIso || 'INR',
    };
}

// ─── FIND EXACT SKU FOR AMOUNT ────────────────────────────────────────

function findExactSku(products, targetAmount) {
    console.log(`\n🔍 Finding exact SKU for amount: ${targetAmount}...`);
    
    const validProducts = [];
    
    for (const p of products) {
        const sku = p.SkuCode || p.Sku || p.skuCode || p.sku;
        if (!sku) continue;
        
        const max = extractValue(p, 'Maximum');
        const min = extractValue(p, 'Minimum');
        
        if (!max.sendValue || max.sendValue <= 0) continue;
        
        const sendValue = max.sendValue;
        const sendCurrency = max.sendCurrency || 'USD';
        const minValue = min.sendValue || 0;
        const maxValue = max.sendValue || 1000;
        
        // Check if target amount is within range (with small tolerance)
        const inRange = targetAmount >= (minValue - 0.01) && targetAmount <= (maxValue + 0.01);
        
        validProducts.push({
            skuCode: sku,
            name: p.Name || p.name || 'Unknown',
            sendValue: sendValue,
            sendCurrency: sendCurrency,
            minValue: minValue,
            maxValue: maxValue,
            inRange: inRange,
            receiveValue: max.receiveValue || 0,
            receiveCurrency: max.receiveCurrency || 'INR',
        });
    }

    console.log(`   Found ${validProducts.length} valid products`);
    
    // Show all products with their values
    console.log('\n   Available products for India:');
    validProducts.slice(0, 10).forEach((p, i) => {
        console.log(`     ${i+1}. ${p.skuCode} - ${p.sendValue} ${p.sendCurrency} (Range: ${p.minValue}-${p.maxValue}) ${p.inRange ? '✅ IN RANGE' : '⚠️ OUT OF RANGE'}`);
    });

    // Find products that support the target amount
    const inRangeProducts = validProducts.filter(p => p.inRange);
    
    if (inRangeProducts.length > 0) {
        const sorted = inRangeProducts.sort((a, b) => {
            return Math.abs(a.sendValue - targetAmount) - Math.abs(b.sendValue - targetAmount);
        });
        const best = sorted[0];
        console.log(`\n   ✅ Found SKU supporting ${targetAmount} ${best.sendCurrency}`);
        console.log(`      SKU: ${best.skuCode}`);
        console.log(`      Send Value: ${best.sendValue} ${best.sendCurrency}`);
        console.log(`      Receive: ${best.receiveValue} ${best.receiveCurrency}`);
        return best;
    }

    // Find the closest match
    const sorted = validProducts.sort((a, b) => {
        return Math.abs(a.sendValue - targetAmount) - Math.abs(b.sendValue - targetAmount);
    });
    const best = sorted[0];
    console.log(`\n   ⚠️ No exact match for ${targetAmount}`);
    console.log(`   ⚠️ Closest: ${best.skuCode} - ${best.sendValue} ${best.sendCurrency}`);
    console.log(`   💡 Try amount: ${best.sendValue} ${best.sendCurrency}`);
    return best;
}

// ─── SEND TRANSFER ────────────────────────────────────────────────────

async function sendTransfer(token, skuInfo, phoneNumber, amount, scenario = '') {
    console.log(`\n📱 ${scenario} Sending ${amount} USD to ${phoneNumber}`);
    
    if (!skuInfo) {
        console.log('   ❌ No SKU info provided');
        return { success: false, status: 'Failed' };
    }
    
    console.log(`   SKU: ${skuInfo.skuCode} (Value: ${skuInfo.sendValue} ${skuInfo.sendCurrency})`);
    
    const reference = generateReference();
    
    const payload = {
        SkuCode: skuInfo.skuCode,
        SendValue: amount,
        SendCurrencyIso: skuInfo.sendCurrency || 'USD',
        AccountNumber: phoneNumber,
        DistributorRef: `TEST-${reference}`,
        RequestId: `REQ-${reference}`,
        ValidateOnly: false
    };

    console.log('   Payload:', JSON.stringify(payload, null, 2));

    try {
        const response = await axios.post(
            `${CONFIG.baseUrl}/api/V1/SendTransfer`,
            payload,
            {
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 30000
            }
        );

        const data = response.data;
        const record = data?.TransferRecord || data;
        const status = record?.ProcessingState || data?.Status || 'Unknown';

        console.log(`   ✅ Response:`);
        console.log(`   Status: ${status}`);
        console.log(`   TransferRef: ${record?.TransferId?.TransferRef || record?.TransferRef || 'N/A'}`);
        
        return { 
            success: status === 'Complete' || status === 'Completed' || status === 'Success', 
            status, 
            data,
            reference: reference
        };

    } catch (error) {
        console.error(`   ❌ Request failed:`);
        if (error.response) {
            const errorData = error.response.data;
            console.error(`   Status: ${error.response.status}`);
            if (errorData?.ErrorCodes) {
                console.error(`   Errors:`, errorData.ErrorCodes.map(e => `${e.Code}: ${e.Context}`).join(', '));
            }
        } else {
            console.error(`   ${error.message}`);
        }
        return { success: false, status: 'Failed', error: error.message };
    }
}

// ─── MAIN TEST ────────────────────────────────────────────────────────

async function runTests() {
    const token = await getOAuthToken();
    if (!token) {
        console.log('\n❌ Cannot proceed without OAuth token');
        return;
    }

    // ─── TEST INDIA WITH CORRECT AMOUNTS ─────────────────────────────

    console.log('\n' + '═'.repeat(60));
    console.log('🇮🇳 TESTING INDIA (WITH CORRECT AMOUNTS)');
    console.log('═'.repeat(60));

    const inProducts = await getProducts(token, 'IN');
    
    // Find SKU for different amounts
    const testAmounts = [2.71, 4.75, 5.16, 5.57, 5.84, 10.87];
    
    for (const amount of testAmounts) {
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`Testing amount: ${amount} USD`);
        console.log(`${'─'.repeat(40)}`);
        
        const sku = findExactSku(inProducts, amount);
        
        if (sku && sku.inRange) {
            // Test with the exact amount
            const result = await sendTransfer(token, sku, '910000000001', amount, `Amount ${amount}`);
            console.log(`   Result: ${result.status}`);
            
            if (result.success) {
                console.log(`   🎉 SUCCESS with ${amount} USD!`);
                break;
            }
        } else if (sku) {
            // Try with the SKU's default value
            console.log(`\n   Trying with SKU's default value: ${sku.sendValue}`);
            const result = await sendTransfer(token, sku, '910000000001', sku.sendValue, `Default ${sku.sendValue}`);
            console.log(`   Result: ${result.status}`);
            
            if (result.success) {
                console.log(`   🎉 SUCCESS with ${sku.sendValue} USD!`);
                break;
            }
        }
    }

    // ─── TEST INDIA ERROR SCENARIOS ──────────────────────────────────

    console.log('\n' + '═'.repeat(60));
    console.log('🇮🇳 TESTING INDIA ERROR SCENARIOS');
    console.log('═'.repeat(60));

    // Find a specific SKU that works
    const skuForErrors = findExactSku(inProducts, 4.75);
    
    if (skuForErrors && skuForErrors.inRange) {
        console.log('\n📱 Testing Rate Limited...');
        const result1 = await sendTransfer(token, skuForErrors, '910000000001', 4.75, 'Rate Limited');
        console.log(`   Expected: Rate Limited or Failed`);
        console.log(`   Actual: ${result1.status}`);
        
        console.log('\n📱 Testing Provider Timed Out...');
        const result2 = await sendTransfer(token, skuForErrors, '910000000002', 4.75, 'Timeout');
        console.log(`   Expected: Provider Timeout or Failed`);
        console.log(`   Actual: ${result2.status}`);
    }

    // ─── SUMMARY ─────────────────────────────────────────────────────

    console.log('\n' + '═'.repeat(60));
    console.log('📊 INDIA TEST SUMMARY');
    console.log('═'.repeat(60));
    console.log('\n   💡 Key Findings for India:');
    console.log('   - Each SKU supports a specific amount only');
    console.log('   - Available amounts: 2.71, 4.75, 5.16, 5.57, 5.84, 10.87 USD');
    console.log('   - Use the exact amount the SKU expects');
    console.log('   - Error phone numbers simulate different scenarios');
    
    console.log('\n   📋 India Test Numbers:');
    console.log('      Rate Limited:        910000000001');
    console.log('      Insufficient Balance: 910000000007');
    console.log('      Provider Timed Out:   910000000002');
    
    console.log('\n   📋 Available India SKUs:');
    console.log('      2.71 USD  → SKU: AIIN5627');
    console.log('      4.75 USD  → SKU: AIININ55294');
    console.log('      5.16 USD  → SKU: AIIN10736');
    console.log('      5.57 USD  → SKU: AIININ62072');
    console.log('      5.84 USD  → SKU: AIIN33661');
    console.log('      10.87 USD → SKU: RJIN1819');
}

// ─── RUN ──────────────────────────────────────────────────────────────

runTests().catch(error => {
    console.error('❌ Test suite error:', error);
    process.exit(1);
});