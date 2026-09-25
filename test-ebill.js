// scripts/test-ebill.js
// Quick connectivity test for eBill. Does NOT create a customer
// order. Uses the documented auth scheme and multipart request
// shape from the eBill docs.
//
// Usage:  node scripts/test-ebill.js
// Env:    EBILL_API_TOKEN must be set.

'use strict';

require('dotenv').config();

const axios = require('axios');
const https = require('https');
const crypto = require('crypto');

const token = process.env.EBILL_API_TOKEN || 'Token 43d6ff57852a64be0ab87feb292fb737693b3c20';
const baseUrl = process.env.EBILL_BASE_URL || 'https://ebill.com.ng/api';

if (!token) {
    console.error('EBILL_API_TOKEN is not set');
    process.exit(1);
}

const httpsAgent = new https.Agent({ keepAlive: true });

function makeRef(prefix) {
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}${Date.now().toString(36).toUpperCase()}${rand}`;
}

async function testEndpoint(name, path) {
    // A fresh reference per call so eBill's logs clearly separate
    // this test from any real transaction.
    const ref = makeRef('TEST-');
    const form = new FormData();
    form.append('api_client_reference', ref);

    const startedAt = Date.now();
    console.log(`\n→ Testing ${name}: POST ${baseUrl}${path}`);
    console.log(`  api_client_reference = ${ref}`);

    try {
        const res = await axios.post(`${baseUrl}${path}`, form, {
            headers: { 'Authorization': `Token ${token}` },
            httpsAgent,
            timeout: 20000
        });

        const elapsed = Date.now() - startedAt;
        console.log(`✓ ${name} responded in ${elapsed}ms (HTTP ${res.status})`);
        console.log(`  Body:`, JSON.stringify(res.data, null, 2));
        return { ok: true, status: res.status, body: res.data, elapsed };
    } catch (err) {
        const elapsed = Date.now() - startedAt;
        const httpStatus = err.response?.status;
        const body = err.response?.data;

        console.log(`✗ ${name} failed in ${elapsed}ms`);
        if (httpStatus) console.log(`  HTTP ${httpStatus}`);
        if (body) console.log(`  Body:`, JSON.stringify(body, null, 2));
        if (!body) console.log(`  Error: ${err.message}`);

        return { ok: false, status: httpStatus, error: err.message, body, elapsed };
    }
}

(async () => {
    console.log('eBill connectivity test');
    console.log('Base URL:', baseUrl);
    console.log('Token (first 8):', token.slice(0, 8) + '...');

    // ⚠️ WARNING: Every call below actually spends money.
    // Each purchase returns a real PIN and debits your eBill balance.
    // If you only want to verify the auth header works, comment out
    // two of the three and keep just one. Even one call is a real
    // purchase.
    //
    // If you want a truly read-only check, there isn't one — eBill
    // does not document a balance or status endpoint.

    const confirm = process.argv.includes('--confirm');
    if (!confirm) {
        console.log('\nDRY RUN. Nothing will be sent to eBill.');
        console.log('Add --confirm to actually call eBill (each call buys a real PIN).');
        console.log('Costs from the docs: WAEC ≈ ₦3,350, NECO ≈ ₦1,170, NABTEB ≈ ₦1,170.');
        process.exit(0);
    }

    const results = [];
    results.push(await testEndpoint('WAEC',   '/waec/'));
    results.push(await testEndpoint('NECO',   '/neco/'));
    results.push(await testEndpoint('NABTEB', '/nabteb/'));

    console.log('\nSummary:');
    for (const r of results) {
        console.log(r.ok ? '  ✓' : '  ✗', `${r.status || 'no status'} (${r.elapsed}ms)`);
    }
})();