// db/supabase.js
// ─────────────────────────────────────────────────────────────────
// Supabase client factory.
//
// REVISION 2026-10-13
//
//   • The global undici Agent and the custom fetch timeout are
//     removed. Under concurrent load, a shared keep-alive pool
//     plus a per-request AbortController caused one of two
//     simultaneous Supabase queries to be silently dropped. The
//     dropped query resolved with an empty body and no error, so
//     callers saw "0 rows" instead of a failure. Removing the
//     pool and the fetch wrapper restores correct concurrency.
//
//   • No custom fetch is passed to createClient. supabase-js
//     builds its own headers and manages its own connection
//     lifecycle. We do not intercept either.
//
//   • A startup verification still runs who_am_i to confirm the
//     service-role key is in effect.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { createClient } = require('@supabase/supabase-js');
const dns = require('node:dns');

try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older Node */ }

// ─── Environment validation ─────────────────────────────────────
const SUPABASE_URL =
    process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL) throw new Error('SUPABASE_URL is missing in .env');
if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_ANON_KEY is missing in .env');
if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing in .env');

function decodeJwtPayload(token) {
    try {
        const parts = String(token).split('.');
        if (parts.length !== 3) return null;
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { return null; }
}

const anonPayload = decodeJwtPayload(SUPABASE_ANON_KEY) || {};
const servicePayload = decodeJwtPayload(SUPABASE_SERVICE_KEY) || {};

if (servicePayload.role !== 'service_role') {
    console.error(
        `❌ SUPABASE_SERVICE_ROLE_KEY decodes to role="${servicePayload.role}", ` +
        'expected "service_role". Requests using this key will be treated as ' +
        'that role by PostgREST and RLS will apply. Check your .env.'
    );
    if (process.env.NODE_ENV === 'production') process.exit(1);
}

console.log('[SUPABASE-DIAG]', {
    host: (() => { try { return new URL(SUPABASE_URL).host; } catch { return 'invalid'; } })(),
    anonRole: anonPayload.role || 'unknown',
    anonRef: anonPayload.ref || 'unknown',
    serviceRole: servicePayload.role || 'unknown',
    serviceRef: servicePayload.ref || 'unknown',
    nodeEnv: process.env.NODE_ENV || 'development',
    customFetch: false,
    undiciAgent: false
});

// ─── Client construction ────────────────────────────────────────
// No custom fetch. No global dispatcher. supabase-js uses Node's
// built-in fetch, which pools connections per origin correctly
// and handles concurrent requests without dropping them.
const clientOptions = {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
    },
    global: {
        headers: {
            'x-application-name': 'milesspace-backend'
        }
    }
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, clientOptions);
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, clientOptions);

// ─── One-time startup verification ──────────────────────────────
// Issue a real request through supabaseAdmin and inspect the role
// that Supabase reports it as. who_am_i returns the Postgres role
// of the current request. If it is not service_role, the client
// is not attaching the key correctly.
async function verifyAdminClient() {
    try {
        const { data, error } = await supabaseAdmin.rpc('who_am_i');
        if (error) {
            console.error(
                '❌ [SUPABASE-VERIFY] who_am_i RPC failed. ' +
                'The admin client may not be able to run RPCs. ' +
                'Error:', error.message
            );
            return false;
        }
        const role = data && (data.current_role || data.role);
        if (role === 'service_role') {
            console.log('✅ [SUPABASE-VERIFY] supabaseAdmin is authenticated as service_role.');
            return true;
        }
        console.error(
            `❌ [SUPABASE-VERIFY] supabaseAdmin is authenticated as "${role}", ` +
            'NOT service_role. Every request will be RLS-filtered. ' +
            'Check that SUPABASE_SERVICE_ROLE_KEY is the service-role key.'
        );
        return false;
    } catch (err) {
        console.error('❌ [SUPABASE-VERIFY] who_am_i threw:', err.message);
        return false;
    }
}

// ─── Retry helpers ──────────────────────────────────────────────
const RETRYABLE_MESSAGES = [
    'fetch failed',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'socket hang up',
    'other side closed',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'ConnectTimeoutError',
    'HeadersTimeoutError',
    'BodyTimeoutError',
    'network',
    'timed out'
];

function isRetryableMessage(msg) {
    if (!msg) return false;
    const m = String(msg).toLowerCase();
    return RETRYABLE_MESSAGES.some((r) => m.includes(r.toLowerCase()));
}

function isRetryableThrown(error) {
    if (!error) return false;
    if (error.name === 'AbortError') return false;
    if (error.status && error.status >= 400 && error.status < 500) return false;
    const msg = String(error.message || '');
    const causeCode = (error.cause && error.cause.code) || error.code || '';
    return isRetryableMessage(msg) || isRetryableMessage(causeCode);
}

async function withSupabaseRetry(fn, { retries = 3, baseDelayMs = 300 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await fn();
            if (!result || !result.error) return result;
            if (!isRetryableMessage(result.error.message)) return result;
            lastError = result.error;
            if (attempt === retries) return result;
            const wait = Math.min(
                baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200,
                5000
            );
            console.warn(
                `⚠️ Supabase retry ${attempt}/${retries} in ${Math.round(wait)}ms — ${result.error.message}`
            );
            await new Promise((r) => setTimeout(r, wait));
        } catch (thrown) {
            lastError = thrown;
            if (!isRetryableThrown(thrown) || attempt === retries) throw thrown;
            const wait = Math.min(
                baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200,
                5000
            );
            console.warn(
                `⚠️ Supabase retry ${attempt}/${retries} in ${Math.round(wait)}ms — ${thrown.message}`
            );
            await new Promise((r) => setTimeout(r, wait));
        }
    }
    throw lastError;
}

async function withRetry(fn, maxRetries = 3, baseDelayMs = 300) {
    return withSupabaseRetry(fn, { retries: maxRetries, baseDelayMs });
}

// ─── Connection test ────────────────────────────────────────────
async function testConnection() {
    try {
        const started = Date.now();
        const { error } = await supabaseAdmin.from('profiles').select('id').limit(1);
        const duration = Date.now() - started;
        if (error) {
            console.error('❌ Supabase health check failed:', error.message);
            return false;
        }
        console.log(`✅ Supabase connection successful (${duration}ms)`);
        return true;
    } catch (error) {
        console.error('❌ Supabase connection error:', error.message);
        return false;
    }
}

console.log('[SUPABASE-LOAD] db/supabase.js loaded from', __filename, 'pid', process.pid);

module.exports = {
    supabase,
    supabaseAdmin,
    withRetry,
    withSupabaseRetry,
    testConnection,
    verifyAdminClient,
    undiciAvailable: false
};