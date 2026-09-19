// find-apple-us.js
require('dotenv').config();
const dtoneService = require('./services/dtoneService');

(async () => {
    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('  FINDING US APPLE GIFT CARDS');
    console.log('══════════════════════════════════════════════════════════════════════\n');

    // Search everywhere for Apple gift cards
    console.log('=== Searching ALL gift cards for "Apple" in the name ===\n');

    const all = await dtoneService.getProductsRaw({ serviceId: '4' });
    console.log(`Total gift card products: ${all.length}\n`);

    const appleCards = all.filter(p =>
        String(p.name || '').toLowerCase().includes('apple') ||
        String(p.description || '').toLowerCase().includes('apple')
    );

    console.log(`Found ${appleCards.length} Apple-named cards:\n`);

    const byCountry = {};
    for (const p of appleCards) {
        const country = p.operator?.country?.iso_code || '?';
        if (!byCountry[country]) byCountry[country] = [];
        byCountry[country].push(p);
    }

    for (const [country, cards] of Object.entries(byCountry).sort()) {
        console.log(`─── ${country} (${cards.length} Apple cards) ───`);
        for (const p of cards) {
            const benefit = Array.isArray(p.benefits) ? p.benefits[0] : null;
            const faceValue = benefit?.amount?.base || '?';
            const faceCurrency = benefit?.unit || '?';
            const wholesale = p.prices?.wholesale?.amount ?? '?';
            const wholesaleCurrency = p.prices?.wholesale?.unit || '?';
            console.log(`  ${p.id}: ${p.name}`);
            console.log(`         Face: ${faceValue} ${faceCurrency}`);
            console.log(`         Wholesale: ${wholesale} ${wholesaleCurrency}`);
        }
        console.log('');
    }

    // Check USA specifically
    console.log('=== USA gift card products ===');
    const usa = all.filter(p => p.operator?.country?.iso_code === 'USA');
    console.log(`USA products count: ${usa.length}`);
    if (usa.length > 0) {
        console.log('Sample USA cards:');
        usa.slice(0, 15).forEach(p => {
            const wholesale = p.prices?.wholesale?.amount;
            const cur = p.prices?.wholesale?.unit;
            console.log(`  ${p.id}: ${p.name} — ${wholesale} ${cur}`);
        });
    } else {
        console.log('  ⚠️ No USA gift cards. Your account lacks the US Pricelist.');
    }

    console.log('\n══════════════════════════════════════════════════════════════════════\n');
})();