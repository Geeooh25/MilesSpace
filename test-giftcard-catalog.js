// test-giftcard-catalog.js
// Forces a gift card catalog rebuild and reports what's in it.
// Run: node test-giftcard-catalog.js

require('dotenv').config({ path: require('path').resolve(process.cwd(), '.env') });

const dtoneService = require('./services/dtoneService');
const { AdminConfigService } = require('./services/ledgerService');

(async () => {
    console.log('\n════════════════════════════════════════════');
    console.log('  GIFT CARD CATALOG DIAGNOSTIC');
    console.log('════════════════════════════════════════════\n');

    // ── 1. Config check
    console.log('=== 1. Admin config ===');
    try {
        const settings = await AdminConfigService.getSettings();
        console.log('usd_to_ngn          :', settings?.usd_to_ngn);
        console.log('giftcard_markup_pct :', settings?.giftcard_markup_pct);
        console.log('boost_markup_pct    :', settings?.boost_markup_pct);
    } catch (e) {
        console.error('Config load failed:', e.message);
    }

    // ── 2. Raw DT One fetch
    console.log('\n=== 2. Raw DT One fetch ===');
    let raw = [];
    try {
        const t0 = Date.now();
        raw = await dtoneService.getGiftCardProducts(null, {
            productType: 'FIXED_VALUE_PIN_PURCHASE',
            maxPages: 15,
            maxTotalMs: 60000,
            requestTimeoutMs: 12000,
        });
        console.log(`Fetched ${raw.length} products in ${Date.now() - t0}ms`);
    } catch (e) {
        console.error('DT One fetch failed:', e.message);
        process.exit(1);
    }

    if (!raw.length) {
        console.warn('⚠️  DT One returned ZERO products');
        process.exit(0);
    }

    // ── 3. Show first few
    console.log('\n=== 3. Sample products ===');
    raw.slice(0, 5).forEach((p, i) => {
        console.log(`  [${i + 1}] ${p.productId} | ${p.name}`);
        console.log(`        type=${p.productType} | wholesale=${p.wholesaleAmount} ${p.wholesaleCurrency}`);
        console.log(`        country=${p.countryIso || '(none)'} | operator=${p.operatorName || '(none)'}`);
    });

    // ── 4. Brand breakdown
    console.log('\n=== 4. Brand breakdown ===');
    const brands = new Map();
    for (const p of raw) {
        const brand = String(p.name || '').split(/\s+/).slice(0, 2).join(' ');
        brands.set(brand, (brands.get(brand) || 0) + 1);
    }
    const topBrands = [...brands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    topBrands.forEach(([brand, count]) => {
        console.log(`  ${String(count).padStart(4)} × ${brand}`);
    });
    console.log(`  Total unique brands: ${brands.size}`);

    // ── 5. Type breakdown
    console.log('\n=== 5. Product type breakdown ===');
    const types = new Map();
    for (const p of raw) {
        const t = p.productType || 'UNKNOWN';
        types.set(t, (types.get(t) || 0) + 1);
    }
    [...types.entries()].forEach(([type, count]) => {
        console.log(`  ${String(count).padStart(4)} × ${type}`);
    });

    // ── 6. Currency breakdown
    console.log('\n=== 6. Wholesale currency breakdown ===');
    const currencies = new Map();
    for (const p of raw) {
        const c = p.wholesaleCurrency || 'NONE';
        currencies.set(c, (currencies.get(c) || 0) + 1);
    }
    [...currencies.entries()].forEach(([cur, count]) => {
        console.log(`  ${String(count).padStart(4)} × ${cur}`);
    });

    // ── 7. Country breakdown
    console.log('\n=== 7. Country coverage ===');
    const countries = new Set();
    for (const p of raw) {
        if (p.countryIso) countries.add(p.countryIso);
    }
    console.log(`  Countries with products: ${countries.size}`);
    console.log(`  Sample: ${[...countries].sort().slice(0, 15).join(', ')}`);

    console.log('\n════════════════════════════════════════════\n');
})();