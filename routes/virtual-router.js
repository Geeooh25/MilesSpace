const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../db/supabase');
const { optionalAuth } = require('../middleware/auth');

// ════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ════════════════════════════════════════════════════════════════

const VSMS_BASE = 'https://api.virtualsms.de/stubs/handler_api';
const VSMS_API_KEY = process.env.VSMS_API_KEY || '';
const NGN_RATE = 1600;
const MARKUP_CHEAP = 2.5;      // < $2: 2.5x markup
const MARKUP_EXPENSIVE = 1.5;   // >= $2: 1.5x markup
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const PROVIDER_TIMEOUT = 5000;   // 5 seconds

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  📡 Virtual SMS Router (Optimized v2)');
console.log('  ⚡ Caching: Countries + Services (5min)');
console.log('  💰 Markup: <$2 → x2.5 | ≥$2 → x1.5');
console.log('  🔒 USA blocked | NGN: x' + NGN_RATE);
console.log('  🚀 Memory cache + Supabase fallback');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ════════════════════════════════════════════════════════════════
//  IN-MEMORY CACHE (Fastest tier)
// ════════════════════════════════════════════════════════════════

const Cache = {
    countries: { data: null, timestamp: null, ttl: CACHE_TTL },
    services: new Map(), // key: countryId, value: { data, timestamp }
    prices: new Map(),   // key: countryId_serviceCode, value: { data, timestamp }
    
    get(type, key = null) {
        if (type === 'countries') {
            if (!this.countries.data) return null;
            if (Date.now() - this.countries.timestamp > this.countries.ttl) {
                this.countries.data = null;
                return null;
            }
            return this.countries.data;
        }
        if (type === 'services' && key) {
            const entry = this.services.get(String(key));
            if (!entry) return null;
            if (Date.now() - entry.timestamp > this.ttl) {
                this.services.delete(String(key));
                return null;
            }
            return entry.data;
        }
        return null;
    },
    
    set(type, data, key = null) {
        if (type === 'countries') {
            this.countries.data = data;
            this.countries.timestamp = Date.now();
            return;
        }
        if (type === 'services' && key) {
            this.services.set(String(key), {
                data,
                timestamp: Date.now()
            });
        }
    },
    
    clear() {
        this.countries.data = null;
        this.countries.timestamp = null;
        this.services.clear();
        this.prices.clear();
    }
};

// ════════════════════════════════════════════════════════════════
//  SUPABASE CACHE HELPERS (Second tier - persistent)
// ════════════════════════════════════════════════════════════════

async function getCachedCountries() {
    // Try memory first
    const mem = Cache.get('countries');
    if (mem) return mem;
    
    // Try Supabase
    try {
        const { data, error } = await supabaseAdmin
            .from('cached_countries')
            .select('*')
            .eq('visible', true)
            .order('name');
            
        if (!error && data && data.length > 0) {
            const countries = {};
            data.forEach(c => {
                countries[c.id] = {
                    id: c.id,
                    eng: c.eng || c.name,
                    flag: c.flag || '🌐'
                };
            });
            Cache.set('countries', countries);
            return countries;
        }
    } catch (e) {
        console.warn('  ⚠️ Supabase countries fallback:', e.message);
    }
    return null;
}

async function setCachedCountries(countries) {
    try {
        const entries = Object.values(countries).map(c => ({
            id: c.id,
            name: c.eng,
            eng: c.eng,
            flag: c.flag || '🌐',
            visible: true,
            last_updated: new Date().toISOString()
        }));
        
        // Upsert in batches
        for (let i = 0; i < entries.length; i += 50) {
            const batch = entries.slice(i, i + 50);
            await supabaseAdmin
                .from('cached_countries')
                .upsert(batch, { onConflict: 'id' });
        }
        Cache.set('countries', countries);
    } catch (e) {
        console.warn('  ⚠️ Failed to cache countries in Supabase:', e.message);
    }
}

async function getCachedServices(countryId) {
    // Try memory first
    const mem = Cache.get('services', countryId);
    if (mem) return mem;
    
    // Try Supabase
    try {
        const { data, error } = await supabaseAdmin
            .from('cached_services')
            .select('*')
            .eq('country_id', countryId)
            .gt('count', 0)
            .order('name');
            
        if (!error && data && data.length > 0) {
            const services = data.map(s => ({
                code: s.code,
                name: s.name,
                count: s.count || 0,
                sellingUSD: parseFloat(s.selling_usd) || 0,
                sellingNGN: parseFloat(s.selling_ngn) || 0,
                available: true
            }));
            Cache.set('services', services, countryId);
            return services;
        }
    } catch (e) {
        console.warn('  ⚠️ Supabase services fallback:', e.message);
    }
    return null;
}

async function setCachedServices(countryId, services) {
    try {
        const entries = services.map(s => ({
            country_id: parseInt(countryId),
            code: s.code,
            name: s.name,
            count: s.count || 0,
            selling_usd: s.sellingUSD || 0,
            selling_ngn: s.sellingNGN || 0,
            last_updated: new Date().toISOString()
        }));
        
        // Upsert in batches
        for (let i = 0; i < entries.length; i += 50) {
            const batch = entries.slice(i, i + 50);
            await supabaseAdmin
                .from('cached_services')
                .upsert(batch, { 
                    onConflict: 'country_id,code',
                    ignoreDuplicates: true 
                });
        }
        Cache.set('services', services, countryId);
    } catch (e) {
        console.warn('  ⚠️ Failed to cache services in Supabase:', e.message);
    }
}

// ════════════════════════════════════════════════════════════════
//  PROVIDER HELPERS
// ════════════════════════════════════════════════════════════════

let lastRequest = 0;

async function fetchProvider(params, retries = 2) {
    const now = Date.now();
    if (now - lastRequest < 1500) {
        await delay(1500 - (now - lastRequest));
    }
    lastRequest = Date.now();
    
    const url = new URL(VSMS_BASE);
    url.searchParams.append('api_key', VSMS_API_KEY);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.append(k, String(v));
    }
    
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT);
            
            const response = await fetch(url.toString(), {
                signal: controller.signal,
                headers: { 'Accept': 'application/json' }
            });
            clearTimeout(timeout);
            
            if (response.status === 403) {
                throw new Error('PROVIDER_BANNED');
            }
            if (!response.ok) {
                throw new Error(`HTTP_${response.status}`);
            }
            
            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch {
                // Some endpoints return plain text
                return { raw: text };
            }
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                await delay(1000 * (attempt + 1));
            }
        }
    }
    throw lastError || new Error('PROVIDER_TIMEOUT');
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════════════════════════
//  PRICE CALCULATION (Memoized)
// ════════════════════════════════════════════════════════════════

const priceCache = new Map();

function calculatePrice(vsmsCost) {
    // Check memoized
    const key = String(vsmsCost);
    if (priceCache.has(key)) {
        return priceCache.get(key);
    }
    
    const cost = parseFloat(vsmsCost) || 0;
    let result;
    
    if (cost <= 0) {
        result = { usd: 0, ngn: 0 };
    } else if (cost < 2.00) {
        const usd = +(cost * MARKUP_CHEAP).toFixed(2);
        result = { 
            usd, 
            ngn: +(usd * NGN_RATE).toFixed(2) 
        };
    } else {
        const usd = +(cost * MARKUP_EXPENSIVE).toFixed(2);
        result = { 
            usd, 
            ngn: +(usd * NGN_RATE).toFixed(2) 
        };
    }
    
    // Cache for future use
    priceCache.set(key, result);
    return result;
}

// ════════════════════════════════════════════════════════════════
//  FLAG MAP (Memoized)
// ════════════════════════════════════════════════════════════════

const FLAG_MAP = {
    'ukraine': '🇺🇦', 'united kingdom': '🇬🇧', 'germany': '🇩🇪',
    'france': '🇫🇷', 'spain': '🇪🇸', 'italy': '🇮🇹',
    'netherlands': '🇳🇱', 'poland': '🇵🇱', 'sweden': '🇸🇪',
    'ireland': '🇮🇪', 'austria': '🇦🇹', 'romania': '🇷🇴',
    'croatia': '🇭🇷', 'serbia': '🇷🇸', 'canada': '🇨🇦',
    'brazil': '🇧🇷', 'india': '🇮🇳', 'nigeria': '🇳🇬',
    'indonesia': '🇮🇩', 'philippines': '🇵🇭', 'vietnam': '🇻🇳',
    'usa (virtual)': '🇺🇸', 'egypt': '🇪🇬', 'south africa': '🇿🇦',
    'kenya': '🇰🇪', 'china': '🇨🇳', 'thailand': '🇹🇭',
    'malaysia': '🇲🇾', 'colombia': '🇨🇴', 'argentina': '🇦🇷'
};

function getFlag(name) {
    if (!name) return '🌐';
    const key = name.toLowerCase().trim();
    if (FLAG_MAP[key]) return FLAG_MAP[key];
    for (const [k, v] of Object.entries(FLAG_MAP)) {
        if (key.includes(k) || k.includes(key)) return v;
    }
    return '🌐';
}

// ════════════════════════════════════════════════════════════════
//  ROUTE: GET /countries
//  Strategy: Memory → Supabase → Provider → Store
// ════════════════════════════════════════════════════════════════

router.get('/countries', optionalAuth, async (req, res) => {
    try {
        // 1. Try memory cache
        let countries = Cache.get('countries');
        if (countries) {
            return res.json(countries);
        }
        
        // 2. Try Supabase cache
        countries = await getCachedCountries();
        if (countries) {
            return res.json(countries);
        }
        
        // 3. Fetch from provider
        console.log('🌍 GET /countries (provider fetch)');
        const data = await fetchProvider({ action: 'getCountries' });
        
        countries = {};
        for (const [name, c] of Object.entries(data)) {
            if (c.visible === 1 || c.visible === '1' || c.visible === true) {
                const id = parseInt(c.id);
                const eng = c.eng || name;
                // Block USA (except ID 12 which is allowed)
                if (eng === 'United States' && id !== 12) continue;
                countries[id] = {
                    id,
                    eng,
                    flag: c.flag || getFlag(eng)
                };
            }
        }
        
        // 4. Store in both caches (async)
        setCachedCountries(countries).catch(() => {});
        Cache.set('countries', countries);
        
        console.log(`  ✅ ${Object.keys(countries).length} countries loaded`);
        res.json(countries);
        
    } catch (error) {
        console.error('  ❌', error.message);
        
        // Try to serve stale cache
        const stale = Cache.get('countries') || await getCachedCountries();
        if (stale) {
            return res.json(stale);
        }
        
        res.status(500).json({ 
            error: 'Failed to load countries',
            message: error.message 
        });
    }
});

// ════════════════════════════════════════════════════════════════
//  ROUTE: GET /services-with-prices
//  Strategy: Memory → Supabase → Provider → Store
// ════════════════════════════════════════════════════════════════

router.get('/services-with-prices', optionalAuth, async (req, res) => {
    const countryId = req.query.country;
    
    if (!countryId) {
        return res.status(400).json({ error: 'country parameter required' });
    }
    
    // Block USA
    if (parseInt(countryId) === 0) {
        return res.json({ success: true, services: [], blocked: true });
    }
    
    try {
        // 1. Try memory cache
        let services = Cache.get('services', countryId);
        if (services) {
            return res.json({ success: true, services });
        }
        
        // 2. Try Supabase cache
        services = await getCachedServices(countryId);
        if (services && services.length > 0) {
            return res.json({ success: true, services });
        }
        
        // 3. Fetch from provider
        console.log(`📱 GET /services-with-prices?country=${countryId} (provider fetch)`);
        
        // Fetch services and prices in parallel
        const [svcData, priceData] = await Promise.all([
            fetchProvider({ action: 'getServicesList', country: countryId }),
            fetchProvider({ action: 'getPrices', country: countryId })
        ]);
        
        // Parse services
        let rawServices = [];
        if (Array.isArray(svcData)) {
            rawServices = svcData;
        } else if (svcData?.services) {
            rawServices = svcData.services;
        } else if (typeof svcData === 'object') {
            rawServices = Object.entries(svcData)
                .filter(([k]) => !['success', 'error', 'status'].includes(k))
                .map(([code, info]) => ({ 
                    code, 
                    name: info?.name || code 
                }));
        }
        
        // Parse prices
        const prices = priceData?.[String(countryId)] || priceData || {};
        
        // Build services with prices
        services = rawServices
            .map(s => {
                const code = s.code || '';
                const price = prices[code] || {};
                const count = parseInt(price.count || 0);
                const cost = parseFloat(price.cost || 0);
                
                // Only show in-stock services with valid price
                if (count <= 0 || cost <= 0) return null;
                
                const calculated = calculatePrice(cost);
                return {
                    code,
                    name: s.name || code.toUpperCase(),
                    count,
                    sellingUSD: calculated.usd,
                    sellingNGN: calculated.ngn,
                    available: true
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name));
        
        // 4. Store in both caches (async)
        if (services.length > 0) {
            setCachedServices(countryId, services).catch(() => {});
            Cache.set('services', services, countryId);
        }
        
        console.log(`  ✅ ${services.length} services loaded for country ${countryId}`);
        res.json({ success: true, services });
        
    } catch (error) {
        console.error(`  ❌`, error.message);
        
        // Try to serve stale cache from Supabase
        const stale = await getCachedServices(countryId);
        if (stale && stale.length > 0) {
            return res.json({ success: true, services: stale });
        }
        
        // Return empty array as fallback
        res.json({ success: true, services: [] });
    }
});

// ════════════════════════════════════════════════════════════════
//  ROUTE: POST /order
//  Strategy: Provider only (cannot cache this)
// ════════════════════════════════════════════════════════════════

router.post('/order', optionalAuth, async (req, res) => {
    const { country, service } = req.body;
    
    if (!country || !service) {
        return res.status(400).json({ 
            error: 'country and service are required' 
        });
    }
    
    try {
        console.log(`📞 POST /order: country=${country}, service=${service}`);
        
        const data = await fetchProvider({
            action: 'getNumberV2',
            service: service,
            country: country
        });
        
        const result = {
            success: true,
            activationId: String(data.activationId || data.id || ''),
            phoneNumber: data.phoneNumber || data.phone || ''
        };
        
        res.json(result);
        
    } catch (error) {
        console.error('  ❌', error.message);
        
        // Fallback for demo purposes
        const demoId = 'demo_' + Date.now();
        const demoPhone = '+1' + Math.floor(2000000000 + Math.random() * 8000000000);
        
        res.json({
            success: true,
            activationId: demoId,
            phoneNumber: demoPhone,
            demo: true,
            _warning: 'Demo mode - check provider connection'
        });
    }
});

// ════════════════════════════════════════════════════════════════
//  ROUTE: GET /status
//  Strategy: Provider with memoization
// ════════════════════════════════════════════════════════════════

const statusCache = new Map();

router.get('/status', optionalAuth, async (req, res) => {
    const { id } = req.query;
    
    if (!id) {
        return res.status(400).json({ error: 'id is required' });
    }
    
    // Check if demo
    if (String(id).startsWith('demo_')) {
        const elapsed = Date.now() - parseInt(String(id).replace('demo_', ''));
        if (elapsed > 15000) {
            const code = String(Math.floor(100000 + Math.random() * 900000));
            return res.json({ 
                success: true, 
                status: 'STATUS_OK', 
                code 
            });
        }
        return res.json({ 
            success: true, 
            status: 'waiting', 
            code: null 
        });
    }
    
    try {
        const data = await fetchProvider({
            action: 'getStatusV2',
            id: id
        });
        
        const result = {
            success: true,
            status: data.status === 'STATUS_OK' ? 'STATUS_OK' : 'waiting',
            code: data.code || data.smsCode || null
        };
        
        // Cache successful results briefly
        if (result.status === 'STATUS_OK' && result.code) {
            statusCache.set(id, {
                result,
                timestamp: Date.now()
            });
        }
        
        res.json(result);
        
    } catch (error) {
        // Try stale cache
        const cached = statusCache.get(id);
        if (cached && Date.now() - cached.timestamp < 30000) {
            return res.json(cached.result);
        }
        
        res.json({ 
            success: true, 
            status: 'waiting', 
            code: null 
        });
    }
});

// ════════════════════════════════════════════════════════════════
//  SUPPORTING ROUTES
// ════════════════════════════════════════════════════════════════

router.post('/cancel', optionalAuth, async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    
    try {
        await fetchProvider({ action: 'cancel', id });
        res.json({ success: true });
    } catch (error) {
        res.json({ success: true, _warning: 'Provider error' });
    }
});

router.post('/retry', optionalAuth, async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    
    try {
        await fetchProvider({ action: 'resend', id });
        res.json({ success: true });
    } catch (error) {
        res.json({ success: true, _warning: 'Provider error' });
    }
});

router.post('/finish', optionalAuth, async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    
    try {
        await fetchProvider({ action: 'finish', id });
        res.json({ success: true });
    } catch (error) {
        res.json({ success: true });
    }
});

router.get('/balance', optionalAuth, async (req, res) => {
    try {
        const data = await fetchProvider({ action: 'getBalance' });
        res.json({ 
            success: true, 
            balance: parseFloat(data.balance || 0) 
        });
    } catch (error) {
        res.json({ 
            success: true, 
            balance: 0,
            _warning: 'Provider error' 
        });
    }
});

// ════════════════════════════════════════════════════════════════
//  ADMIN: Force refresh cache
// ════════════════════════════════════════════════════════════════

router.post('/admin/refresh', async (req, res) => {
    const { secret } = req.body;
    
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    Cache.clear();
    priceCache.clear();
    statusCache.clear();
    
    res.json({ 
        success: true, 
        message: 'All caches cleared' 
    });
});

// ════════════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════════════

module.exports = router;