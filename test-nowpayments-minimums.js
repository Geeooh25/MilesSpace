require('dotenv').config();
const axios = require('axios');

const NEW_API_KEY = process.env.NOWPAYMENTS_API_KEY; // set this in .env

(async () => {
  if (!NEW_API_KEY) {
    console.error('❌ Set NOWPAYMENTS_API_KEY_NEW in .env first');
    process.exit(1);
  }

  // Confirm which custody currency this new account uses.
  // There is no direct API for this, but the /min-amount result will
  // tell you indirectly: if the minimum for LTC/TRX is now $2-5, you
  // picked the right custody currency.
  const { data: status } = await axios.get('https://api.nowpayments.io/v1/status', {
    headers: { 'x-api-key': NEW_API_KEY }
  }).catch(e => ({ data: { error: e.response?.data?.message || e.message } }));
  console.log('API status:', JSON.stringify(status));

  const coins = [
    'usdttrc20', 'usdtbsc', 'usdtmatic', 'usdterc20',
    'trx', 'ltc', 'xlm', 'xrp', 'dash', 'dgb',
    'xvg', 'algo', 'atom', 'vet', 'sol', 'ada',
    'btc', 'eth', 'bnb', 'matic'
  ];

  console.log('\nTesting minimums on new account...\n');
  console.log('COIN'.padEnd(14) + 'MIN USD');
  console.log('-'.repeat(30));

  const results = [];
  for (const coin of coins) {
    try {
      const { data } = await axios.get('https://api.nowpayments.io/v1/min-amount', {
        params: {
          currency_from: coin,
          currency_to: 'usd',
          fiat_equivalent: 'usd'
        },
        headers: { 'x-api-key': NEW_API_KEY },
        timeout: 8000
      });
      const usd = parseFloat(data.fiat_equivalent) || 0;
      results.push({ coin, usd });
      console.log(coin.toUpperCase().padEnd(14) + '$' + usd.toFixed(2));
    } catch (e) {
      const msg = e.response?.data?.message || e.message;
      results.push({ coin, usd: Infinity, error: msg });
      console.log(coin.toUpperCase().padEnd(14) + 'ERROR: ' + msg);
    }
    await new Promise(r => setTimeout(r, 250));
  }

  // Summary
  const valid = results.filter(r => Number.isFinite(r.usd));
  valid.sort((a, b) => a.usd - b.usd);

  console.log('\n=== SORTED (cheapest first) ===');
  for (const r of valid) {
    console.log(r.coin.toUpperCase().padEnd(14) + '$' + r.usd.toFixed(2));
  }

  const under5  = valid.filter(r => r.usd <= 5);
  const under3  = valid.filter(r => r.usd <= 3);
  const under2  = valid.filter(r => r.usd <= 2);

  console.log('\n=== COINS UNDER $5 ===');
  if (under5.length === 0) {
    console.log('None. Lowest is $' + valid[0]?.usd.toFixed(2));
  } else {
    for (const r of under5) console.log('✓ ' + r.coin.toUpperCase() + ' — $' + r.usd.toFixed(2));
  }

  console.log('\n=== SUMMARY ===');
  console.log('Under $2:  ' + under2.length + ' coins');
  console.log('Under $3:  ' + under3.length + ' coins');
  console.log('Under $5:  ' + under5.length + ' coins');
  console.log('Lowest:    $' + valid[0]?.usd.toFixed(2) + ' (' + valid[0]?.coin.toUpperCase() + ')');
})();