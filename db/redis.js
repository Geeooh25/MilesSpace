// db/redis.js - COMPLETE FIXED VERSION
const redis = require('redis');

let redisClient = null;
let isRedisConnected = false;
let redisInitPromise = null;

// ─── MOCK REDIS CLIENT (Fallback) ───
function createMockRedisClient() {
    const store = new Map();
    
    return {
        isReady: true,
        on: () => {},
        connect: async () => {},
        disconnect: async () => {},
        quit: async () => {},
        get: async (key) => {
            const item = store.get(key);
            if (!item) return null;
            if (Date.now() > item.expiresAt) {
                store.delete(key);
                return null;
            }
            return item.value;
        },
        set: async (key, value, options) => {
            let expiresAt = null;
            if (options?.EX) {
                expiresAt = Date.now() + options.EX * 1000;
            }
            store.set(key, { value, expiresAt });
            return 'OK';
        },
        setex: async (key, seconds, value) => {
            store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
            return 'OK';
        },
        del: async (key) => {
            store.delete(key);
            return 1;
        },
        incr: async (key) => {
            const current = store.get(key);
            const val = current ? parseInt(current.value) || 0 : 0;
            const newVal = val + 1;
            store.set(key, { value: String(newVal), expiresAt: null });
            return newVal;
        },
        expire: async (key, seconds) => {
            const item = store.get(key);
            if (item) {
                item.expiresAt = Date.now() + seconds * 1000;
                store.set(key, item);
            }
            return 1;
        },
        flushall: async () => {
            store.clear();
            return 'OK';
        },
        keys: async (pattern) => {
            const results = [];
            for (const key of store.keys()) {
                if (key.includes(pattern.replace('*', ''))) {
                    results.push(key);
                }
            }
            return results;
        }
    };
}

// ─── CONNECT TO REDIS ───
async function connectRedis() {
    try {
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        const redisPassword = process.env.REDIS_PASSWORD;

        const client = redis.createClient({
            url: redisUrl,
            password: redisPassword || undefined,
            socket: {
                reconnectStrategy: (retries) => {
                    const delay = Math.min(retries * 200, 5000);
                    console.log(`⚠️ Redis reconnecting (attempt ${retries}), retrying in ${delay}ms`);
                    return delay;
                },
                connectTimeout: 5000,
            }
        });

        client.on('error', (err) => {
            console.log('⚠️ Redis Client Error:', err.message);
            isRedisConnected = false;
        });

        client.on('connect', () => {
            console.log('✅ Connected to Redis');
            isRedisConnected = true;
        });

        client.on('end', () => {
            console.log('⚠️ Redis connection ended');
            isRedisConnected = false;
        });

        await client.connect();
        redisClient = client;
        isRedisConnected = true;
        return redisClient;
    } catch (error) {
        console.log('⚠️ Redis connection failed, using in-memory fallback:', error.message);
        isRedisConnected = false;
        redisClient = createMockRedisClient();
        return redisClient;
    }
}

// ─── GET REDIS CLIENT ───
async function getRedisClient() {
    if (!redisClient) {
        if (!redisInitPromise) {
            redisInitPromise = connectRedis();
        }
        redisClient = await redisInitPromise;
    }
    return redisClient;
}

// ─── CHECK REDIS AVAILABILITY ───
function isRedisAvailable() {
    return isRedisConnected && redisClient && redisClient.isReady === true;
}

// ─── RATE LIMITING HELPER ───
async function checkRateLimit(key, limit = 20, windowSeconds = 60) {
    try {
        const redis = await getRedisClient();
        const count = await redis.incr(key);
        if (count === 1) {
            await redis.expire(key, windowSeconds);
        }
        return count <= limit;
    } catch (error) {
        console.warn('Rate limit check failed:', error.message);
        return true; // Fail open - allow request
    }
}

module.exports = { 
    getRedisClient, 
    isRedisAvailable,
    checkRateLimit
};