// db/redis.js

const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

let redisClient = null;
let isRedisConnected = false;
let redisInitPromise = null;
const isProduction = process.env.NODE_ENV === 'production';

async function connectRedis() {
    try {
        const url = process.env.UPSTASH_REDIS_REST_URL;
        const token = process.env.UPSTASH_REDIS_REST_TOKEN;

        if (!url || !token) {
            if (isProduction) {
                throw new Error('Redis credentials required in production');
            }
            console.warn('⚠️ Redis credentials missing, using in-memory fallback');
            isRedisConnected = false;
            return createMockRedisClient();
        }

        console.log('🔗 Connecting to Upstash Redis...');
        const client = new Redis({ url, token, automaticDeserialization: true });
        await client.ping();
        console.log('✅ Connected to Upstash Redis');
        isRedisConnected = true;
        redisClient = client;
        return client;
    } catch (error) {
        console.error('❌ Redis connection failed:', error.message);
        if (isProduction) throw new Error('Redis unavailable in production');
        isRedisConnected = false;
        return createMockRedisClient();
    }
}

function createMockRedisClient() {
    const store = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [key, item] of store.entries()) {
            if (item.expiresAt && now > item.expiresAt) store.delete(key);
        }
    }, 60000);

    return {
        isReady: true,
        get: async (key) => {
            const item = store.get(key);
            if (!item || (item.expiresAt && Date.now() > item.expiresAt)) return null;
            return item.value;
        },
        set: async (key, value, options) => {
            const expiresAt = options?.ex ? Date.now() + options.ex * 1000 : null;
            store.set(key, { value, expiresAt });
            return 'OK';
        },
        setex: async (key, seconds, value) => {
            store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
            return 'OK';
        },
        setnx: async (key, value, ttlSeconds) => {
            if (store.has(key)) {
                const item = store.get(key);
                if (!item.expiresAt || Date.now() <= item.expiresAt) return 0;
            }
            store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
            return 1;
        },
        del: async (key) => { const d = store.delete(key); return d ? 1 : 0; },
        incr: async (key) => {
            const current = store.get(key);
            const val = current ? parseInt(current.value) || 0 : 0;
            const newVal = val + 1;
            store.set(key, { value: String(newVal), expiresAt: current?.expiresAt || null });
            return newVal;
        },
        expire: async (key, seconds) => {
            const item = store.get(key);
            if (item) { item.expiresAt = Date.now() + seconds * 1000; store.set(key, item); }
            return 1;
        },
        exists: async (key) => {
            const item = store.get(key);
            if (!item || (item.expiresAt && Date.now() > item.expiresAt)) return 0;
            return 1;
        },
        ttl: async (key) => {
            const item = store.get(key);
            if (!item) return -2;
            if (!item.expiresAt) return -1;
            const remaining = Math.ceil((item.expiresAt - Date.now()) / 1000);
            return remaining > 0 ? remaining : -2;
        },
        eval: async (script, keys, args) => {
            // Atomic rate limiting simulation
            const key = keys[0];
            const limit = parseInt(args[0]);
            const windowSeconds = parseInt(args[1]);
            
            const current = await this.get(key);
            const count = current ? parseInt(current) : 0;
            const newCount = count + 1;
            
            if (newCount === 1) {
                await this.setex(key, windowSeconds, String(newCount));
            } else {
                await this.set(key, String(newCount));
            }
            
            return newCount <= limit ? 1 : 0;
        }
    };
}

async function getRedisClient() {
    if (!redisClient) {
        if (!redisInitPromise) redisInitPromise = connectRedis();
        redisClient = await redisInitPromise;
    }
    return redisClient;
}

function isRedisAvailable() { return isRedisConnected && redisClient !== null; }

// ─── ATOMIC RATE LIMITING ───────────────────────────────────
async function checkRateLimit(key, limit = 20, windowSeconds = 60) {
    try {
        const redis = await getRedisClient();
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, windowSeconds);
        const ttl = await redis.ttl(key);
        return {
            allowed: count <= limit,
            remaining: Math.max(0, limit - count),
            reset: ttl > 0 ? ttl : windowSeconds,
            retryAfter: ttl > 0 ? ttl : windowSeconds
        };
    } catch (error) {
        console.warn('Rate limit check failed:', error.message);
        if (isProduction) {
            return { allowed: false, remaining: 0, reset: windowSeconds, retryAfter: windowSeconds };
        }
        return { allowed: true, remaining: limit, reset: windowSeconds, retryAfter: windowSeconds };
    }
}

// ─── LOGIN OTP STORAGE (Redis) ──────────────────────────────
async function storeLoginOTP(verificationId, data, ttlSeconds = 600) {
    try {
        const redis = await getRedisClient();
        const key = `milespace:login_otp:${verificationId}`;
        await redis.setex(key, ttlSeconds, JSON.stringify(data));
        return true;
    } catch (error) {
        console.error('Store OTP error:', error);
        return false;
    }
}

async function getLoginOTP(verificationId) {
    try {
        const redis = await getRedisClient();
        const key = `milespace:login_otp:${verificationId}`;
        const data = await redis.get(key);
        if (!data) return null;
        return JSON.parse(data);
    } catch (error) {
        console.error('Get OTP error:', error);
        return null;
    }
}

async function deleteLoginOTP(verificationId) {
    try {
        const redis = await getRedisClient();
        const key = `milespace:login_otp:${verificationId}`;
        await redis.del(key);
        return true;
    } catch (error) {
        console.error('Delete OTP error:', error);
        return false;
    }
}

// ─── LOGIN ATTEMPTS ──────────────────────────────────────────
function hashIdentifier(identifier) {
    return crypto.createHash('sha256').update(identifier.toLowerCase().trim()).digest('hex');
}

async function getLoginLockStatus(identifier) {
    try {
        const redis = await getRedisClient();
        const key = `milespace:login_attempts:${hashIdentifier(identifier)}`;
        const data = await redis.get(key);
        if (!data) return { attempts: 0, locked: false, lockedUntil: 0 };
        const parsed = JSON.parse(data);
        if (parsed.locked && parsed.lockedUntil && Date.now() > parsed.lockedUntil) {
            await redis.del(key);
            return { attempts: 0, locked: false, lockedUntil: 0 };
        }
        return parsed;
    } catch (error) {
        return { attempts: 0, locked: false, lockedUntil: 0 };
    }
}

async function incrementLoginAttempts(identifier) {
    try {
        const redis = await getRedisClient();
        const key = `milespace:login_attempts:${hashIdentifier(identifier)}`;
        const result = await redis.eval(
            `
            local key = KEYS[1]
            local current = redis.call('get', key)
            local data = current and cjson.decode(current) or { attempts = 0, locked = false, lockedUntil = 0 }
            
            if data.locked and data.lockedUntil and tonumber(data.lockedUntil) > tonumber(ARGV[1]) then
                return cjson.encode(data)
            end
            
            if data.locked and data.lockedUntil and tonumber(data.lockedUntil) <= tonumber(ARGV[1]) then
                data.attempts = 0
                data.locked = false
                data.lockedUntil = 0
            end
            
            data.attempts = data.attempts + 1
            
            if data.attempts >= 10 then
                data.locked = true
                data.lockedUntil = tonumber(ARGV[1]) + 900000
                redis.call('setex', key, 900, cjson.encode(data))
            else
                redis.call('setex', key, 900, cjson.encode(data))
            end
            
            return cjson.encode(data)
            `,
            [key],
            [Date.now()]
        );
        return JSON.parse(result);
    } catch (error) { return { attempts: 0, locked: false, lockedUntil: 0 }; }
}

async function resetLoginAttempts(identifier) {
    try {
        const redis = await getRedisClient();
        await redis.del(`milespace:login_attempts:${hashIdentifier(identifier)}`);
        return true;
    } catch (error) { return false; }
}

// ─── ATOMIC PIN ATTEMPTS ────────────────────────────────────
async function incrementPinAttempts(userId) {
    try {
        const redis = await getRedisClient();
        const key = `milespace:pin_attempts:${userId}`;
        const result = await redis.eval(
            `
            local key = KEYS[1]
            local current = redis.call('get', key)
            local data = current and cjson.decode(current) or { attempts = 0, locked = false, lockedUntil = 0 }
            
            if data.locked and data.lockedUntil and tonumber(data.lockedUntil) > tonumber(ARGV[1]) then
                return cjson.encode(data)
            end
            
            if data.locked and data.lockedUntil and tonumber(data.lockedUntil) <= tonumber(ARGV[1]) then
                data.attempts = 0
                data.locked = false
                data.lockedUntil = 0
            end
            
            data.attempts = data.attempts + 1
            
            if data.attempts >= 5 then
                data.locked = true
                data.lockedUntil = tonumber(ARGV[1]) + 3600000
                redis.call('setex', key, 3600, cjson.encode(data))
            else
                redis.call('setex', key, 3600, cjson.encode(data))
            end
            
            return cjson.encode(data)
            `,
            [key],
            [Date.now()]
        );
        return JSON.parse(result);
    } catch (error) {
        console.warn('Increment PIN attempts failed:', error.message);
        return { attempts: 0, locked: false, lockedUntil: 0 };
    }
}

async function resetPinAttempts(userId) {
    try {
        const redis = await getRedisClient();
        await redis.del(`milespace:pin_attempts:${userId}`);
        return true;
    } catch (error) { return false; }
}

// ─── IDEMPOTENCY ─────────────────────────────────────────────
async function checkIdempotency(userId, idempotencyKey, endpoint, ttlSeconds = 86400) {
    try {
        const redis = await getRedisClient();
        const key = `milespace:idempotency:${userId}:${endpoint}:${idempotencyKey}`;
        const setResult = await redis.setnx(key, JSON.stringify({ status: 'processing' }), ttlSeconds);
        if (setResult === 0) {
            const existing = await redis.get(key);
            if (existing) {
                try { return { isDuplicate: true, result: JSON.parse(existing) }; } catch {}
                return { isDuplicate: true, result: { status: 'processing' } };
            }
            return { isDuplicate: true, result: { status: 'processing' } };
        }
        return { isDuplicate: false, result: null };
    } catch (error) {
        console.warn('Idempotency check failed:', error.message);
        if (isProduction) {
            return { isDuplicate: true, result: { status: 'error', message: 'Idempotency check failed' } };
        }
        return { isDuplicate: false, result: null };
    }
}

async function updateIdempotencyResult(userId, idempotencyKey, endpoint, result, ttlSeconds = 86400) {
    try {
        const redis = await getRedisClient();
        const key = `milespace:idempotency:${userId}:${endpoint}:${idempotencyKey}`;
        await redis.setex(key, ttlSeconds, JSON.stringify(result));
        return true;
    } catch (error) { return false; }
}

module.exports = {
    getRedisClient,
    isRedisAvailable,
    checkRateLimit,
    storeLoginOTP,
    getLoginOTP,
    deleteLoginOTP,
    getLoginLockStatus,
    incrementLoginAttempts,
    resetLoginAttempts,
    incrementPinAttempts,
    resetPinAttempts,
    checkIdempotency,
    updateIdempotencyResult,
    hashIdentifier
};