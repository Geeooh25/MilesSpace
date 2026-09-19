// utils/ipUtils.js - IP Extraction and Geolocation

const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';

function getClientIP(req) {
    // Trust proxy headers - configure in server.js: app.set('trust proxy', 1)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const ips = forwarded.split(',').map(ip => ip.trim());
        return ips[0] || 'Unknown';
    }

    const realIp = req.headers['x-real-ip'];
    if (realIp) return realIp;

    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp;

    let ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'Unknown';
    if (ip && ip.startsWith('::ffff:')) ip = ip.substring(7);
    if (ip === '::1') ip = '127.0.0.1';

    return ip || 'Unknown';
}

const geoCache = new Map();
const GEO_CACHE_TTL = 24 * 60 * 60 * 1000;

async function getLocationFromIP(ip) {
    // Development mode - return development indicator
    if (IS_DEVELOPMENT) {
        return 'Development Environment';
    }

    if (!ip || ip === '127.0.0.1' || ip === 'localhost' || ip === 'Unknown') {
        return 'Private Network';
    }

    // Check cache
    const cached = geoCache.get(ip);
    if (cached && Date.now() - cached.timestamp < GEO_CACHE_TTL) {
        return cached.data;
    }

    // Check private IPs
    const isPrivate = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(ip);
    if (isPrivate) {
        const result = 'Private Network';
        geoCache.set(ip, { data: result, timestamp: Date.now() });
        return result;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(
            `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
            {
                headers: { 'Accept': 'application/json', 'User-Agent': 'MilesSpace/1.0' },
                signal: controller.signal
            }
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
            const result = 'Location unavailable';
            geoCache.set(ip, { data: result, timestamp: Date.now() });
            return result;
        }

        const data = await response.json();
        if (data.error) {
            const result = 'Location unavailable';
            geoCache.set(ip, { data: result, timestamp: Date.now() });
            return result;
        }

        const parts = [];
        if (data.city) parts.push(data.city);
        if (data.region) parts.push(data.region);
        if (data.country_name) parts.push(data.country_name);

        const result = parts.length > 0 ? parts.join(', ') : (data.country_name || 'Location unavailable');
        geoCache.set(ip, { data: result, timestamp: Date.now() });
        return result;

    } catch (error) {
        return 'Location unavailable';
    }
}

module.exports = { getClientIP, getLocationFromIP };