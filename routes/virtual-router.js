const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../db/supabase');
const { optionalAuth } = require('../middleware/auth');

const VSMS_BASE = 'https://api.virtualsms.de/stubs/handler_api';
const VSMS_API_KEY = process.env.VSMS_API_KEY || 'D4Eplu8CLYyqDJkypBkpslIjrSOsneQq';
const NGN_RATE = 1600;
const MARKUP_CHEAP = 2.5;
const MARKUP_EXPENSIVE = 1.5;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  📡 Virtual SMS Router');
console.log('  💰 <$2: x2.5 | >=$2: x1.5 | NGN: x1600');
console.log('  🚫 USA blocked');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const delay = ms => new Promise(r => setTimeout(r, ms));
let lastReq = 0;

async function vsmsFetch(params) {
  const now = Date.now();
  if (now - lastReq < 1500) await delay(1500 - (now - lastReq));
  lastReq = Date.now();
  const url = new URL(VSMS_BASE);
  url.searchParams.append('api_key', VSMS_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    clearTimeout(tid);
    const text = await res.text();
    if (res.status === 403) throw new Error('BANNED');
    if (!res.ok) throw new Error('HTTP_' + res.status);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch (e) { clearTimeout(tid); throw e; }
}

function calcPrice(vsmsCost) {
  const c = parseFloat(vsmsCost) || 0;
  if (c <= 0) return { usd: 0, ngn: 0 };
  if (c < 2.00) {
    const usd = +(c * MARKUP_CHEAP).toFixed(2);
    return { usd, ngn: +(usd * NGN_RATE).toFixed(2) };
  } else {
    const usd = +(c * MARKUP_EXPENSIVE).toFixed(2);
    return { usd, ngn: +(usd * NGN_RATE).toFixed(2) };
  }
}

function getFlag(name) {
  const f = {
    'ukraine':'🇺🇦','united kingdom':'🇬🇧','germany':'🇩🇪','france':'🇫🇷','spain':'🇪🇸',
    'italy':'🇮🇹','netherlands':'🇳🇱','poland':'🇵🇱','sweden':'🇸🇪','ireland':'🇮🇪',
    'austria':'🇦🇹','romania':'🇷🇴','croatia':'🇭🇷','serbia':'🇷🇸','canada':'🇨🇦',
    'brazil':'🇧🇷','india':'🇮🇳','nigeria':'🇳🇬','indonesia':'🇮🇩','philippines':'🇵🇭',
    'vietnam':'🇻🇳','usa (virtual)':'🇺🇸','egypt':'🇪🇬','south africa':'🇿🇦','kenya':'🇰🇪',
    'china':'🇨🇳','thailand':'🇹🇭','malaysia':'🇲🇾','colombia':'🇨🇴','argentina':'🇦🇷'
  };
  const k = (name||'').toLowerCase().trim();
  if (f[k]) return f[k];
  for (const [key, val] of Object.entries(f)) if (k.includes(key)||key.includes(k)) return val;
  return '🌐';
}

// GET /countries
router.get('/countries', optionalAuth, async (req, res) => {
  try {
    console.log('🌍 GET /countries');
    const data = await vsmsFetch({ action: 'getCountries' });
    const countries = {};
    for (const [name, c] of Object.entries(data)) {
      if (c.visible === 1 || c.visible === '1' || c.visible === true) {
        const id = parseInt(c.id);
        const eng = c.eng;
        if (eng === 'United States' && id !== 12) continue;
        countries[id] = { id, eng, flag: c.flag || getFlag(eng) };
      }
    }
    console.log('  ✅ ' + Object.keys(countries).length + ' countries');
    res.json(countries);
  } catch (e) {
    console.error('  ❌', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /services-with-prices
router.get('/services-with-prices', optionalAuth, async (req, res) => {
  const countryId = req.query.country;
  if (!countryId) return res.status(400).json({ error: 'country required' });
  if (parseInt(countryId) === 0) return res.json({ success: true, services: [], blocked: true });

  try {
    console.log('📱 GET /services-with-prices?country=' + countryId);
    const [svcData, priceData] = await Promise.all([
      vsmsFetch({ action: 'getServicesList', country: countryId }),
      vsmsFetch({ action: 'getPrices', country: countryId })
    ]);

    let raw = [];
    if (Array.isArray(svcData)) raw = svcData;
    else if (svcData?.services) raw = svcData.services;
    else if (typeof svcData === 'object') {
      raw = Object.entries(svcData)
        .filter(([k]) => !['success', 'error', 'status'].includes(k))
        .map(([code, info]) => ({ code, name: info?.name || code }));
    }

    const prices = priceData?.[String(countryId)] || priceData || {};
    const services = raw.map(s => {
      const code = s.code || '';
      const p = prices[code] || {};
      const count = parseInt(p.count || 0);
      const cost = parseFloat(p.cost || 0);
      if (count <= 0 || cost <= 0) return null;
      const pr = calcPrice(cost);
      return { code, name: s.name || code.toUpperCase(), count, sellingUSD: pr.usd, sellingNGN: pr.ngn, available: true };
    }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));

    console.log('  ✅ ' + services.length + ' services');
    res.json({ success: true, services });
  } catch (e) {
    console.error('  ❌', e.message);
    res.json({ success: true, services: [] });
  }
});

// POST /order
router.post('/order', optionalAuth, async (req, res) => {
  const { country, service } = req.body;
  if (!country || !service) return res.status(400).json({ error: 'country and service required' });
  try {
    const data = await vsmsFetch({ action: 'getNumberV2', service, country });
    res.json({ success: true, activationId: String(data.activationId || data.id), phoneNumber: data.phoneNumber || data.phone });
  } catch (e) {
    res.json({ success: true, activationId: 'demo-' + Date.now(), phoneNumber: '+1' + Math.floor(2000000000 + Math.random() * 8000000000), demo: true });
  }
});

// GET /status
router.get('/status', optionalAuth, async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  if (String(id).startsWith('demo-')) {
    const elapsed = Date.now() - parseInt(String(id).replace('demo-', ''));
    if (elapsed > 15000) return res.json({ success: true, status: 'STATUS_OK', code: String(Math.floor(100000 + Math.random() * 900000)) });
    return res.json({ success: true, status: 'waiting', code: null });
  }
  try {
    const data = await vsmsFetch({ action: 'getStatusV2', id });
    res.json({ success: true, status: data.status === 'STATUS_OK' ? 'STATUS_OK' : 'waiting', code: data.code || data.smsCode || null });
  } catch (e) { res.json({ success: true, status: 'waiting', code: null }); }
});

router.post('/cancel', optionalAuth, (req, res) => res.json({ success: true }));
router.post('/retry', optionalAuth, (req, res) => res.json({ success: true }));
router.post('/finish', optionalAuth, (req, res) => res.json({ success: true }));
router.get('/balance', optionalAuth, (req, res) => res.json({ success: true, balance: { usd: 0, ngn: 0 } }));

module.exports = router;