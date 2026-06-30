// test-europe-prices.js
const API_KEY = 'aZlMe4qgmZln9HTREmKMSx92uT2oVWc5';
const BASE = 'https://api.virtualsms.de/stubs/handler_api';

// Popular services to check
const POPULAR_SERVICES = ['wa', 'tg', 'fb', 'ig', 'go', 'tw', 'tk', 'dc', 'yt', 'am', 'oi', 'bd', 'bn'];

// European country IDs from your test
const EUROPE_COUNTRIES = [
  { id: '16', name: 'United Kingdom' },
  { id: '43', name: 'Germany' },
  { id: '48', name: 'Netherlands' },
  { id: '56', name: 'Spain' },
  { id: '15', name: 'Poland' },
  { id: '23', name: 'Ireland' },
  { id: '29', name: 'Serbia' },
  { id: '32', name: 'Romania' },
  { id: '34', name: 'Estonia' },
  { id: '44', name: 'Lithuania' },
  { id: '45', name: 'Croatia' },
  { id: '46', name: 'Sweden' },
  { id: '49', name: 'Latvia' },
  { id: '50', name: 'Austria' },
  { id: '59', name: 'Slovenia' },
  { id: '33', name: 'Colombia' }, // Non-European comparison
  { id: '6', name: 'Indonesia' },  // Non-European comparison
];

async function fetchPrices(countryId) {
  const url = `${BASE}?api_key=${API_KEY}&action=getPrices&country=${countryId}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    if (res.ok) {
      const data = JSON.parse(text);
      return data[countryId] || data;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  REAL VirtualSMS Prices - European Countries                 ║');
  console.log('║  Format: VirtualSMS_Cost → Your_USD_Price → Your_NGN_Price  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (const country of EUROPE_COUNTRIES) {
    const prices = await fetchPrices(country.id);
    
    if (!prices || Object.keys(prices).length === 0) {
      console.log(`❌ ${country.name} (ID:${country.id}): NO PRICES AVAILABLE`);
      continue;
    }

    console.log(`\n━━━ ${country.name} (ID:${country.id}) ━━━`);
    console.log('Service         VSMS_Cost    Your_USD    Your_NGN');
    console.log('──────────────  ──────────   ────────    ────────');

    for (const svc of POPULAR_SERVICES) {
      const info = prices[svc];
      if (info && info.cost && parseInt(info.count) > 0) {
        const cost = parseFloat(info.cost);
        const usd = (cost * 2.5).toFixed(2);
        const ngn = (usd * 1300).toFixed(2);
        const name = getServiceName(svc);
        const count = parseInt(info.count);
        
        // Highlight high prices
        const marker = cost > 0.50 ? ' ⚠️ HIGH' : cost > 0.30 ? ' 🔶 MED' : ' ✅';
        
        console.log(
          `${name.padEnd(14)}  $${String(cost).padEnd(10)}  $${String(usd).padEnd(10)}  ₦${Number(ngn).toLocaleString('en-NG', {minimumFractionDigits: 2})}${marker}  (${count.toLocaleString()} avail)`
        );
      }
    }
  }

  // Summary comparison
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  PRICE COMPARISON - WhatsApp (wa) Across Countries           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  console.log('Country          VSMS    Your_USD   Your_NGN');
  console.log('───────────────  ──────  ────────   ────────');
  
  for (const country of EUROPE_COUNTRIES) {
    const prices = await fetchPrices(country.id);
    if (prices && prices['wa']) {
      const cost = parseFloat(prices['wa'].cost);
      const usd = (cost * 2.5).toFixed(2);
      const ngn = (usd * 1300).toFixed(2);
      console.log(`${country.name.padEnd(15)}  $${cost.toFixed(2)}    $${usd}      ₦${Number(ngn).toLocaleString()}`);
    } else {
      console.log(`${country.name.padEnd(15)}  NOT AVAILABLE`);
    }
  }
}

function getServiceName(code) {
  const names = {
    'wa': 'WhatsApp', 'tg': 'Telegram', 'fb': 'Facebook', 'ig': 'Instagram',
    'go': 'Google', 'tw': 'Twitter/X', 'tk': 'TikTok', 'dc': 'Discord',
    'yt': 'YouTube', 'am': 'Amazon', 'oi': 'Tinder', 'bd': 'Badoo', 'bn': 'Binance'
  };
  return names[code] || code;
}

main().catch(console.error);