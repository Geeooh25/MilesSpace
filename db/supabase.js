// db/supabase.js - PRODUCTION READY
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl) throw new Error('SUPABASE_URL is missing in .env');
if (!supabaseAnonKey) throw new Error('SUPABASE_ANON_KEY is missing in .env');
if (!supabaseServiceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing in .env');

console.log('🔗 Supabase URL:', supabaseUrl);

// ─── SERVER-SIDE CLIENT (for auth verification) ───
// This client is used to verify tokens with Supabase Auth
// It does NOT persist sessions or auto-refresh
const clientOptions = {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
    }
};

// ─── PUBLIC CLIENT ──────────────────────────────────────
// Use this for signIn, signUp, etc. - it talks to Supabase Auth
const supabase = createClient(
    supabaseUrl,
    supabaseAnonKey,
    clientOptions
);

// ─── ADMIN CLIENT ──────────────────────────────────────
// Use this for database operations with service role
// NEVER expose this to the frontend
const supabaseAdmin = createClient(
    supabaseUrl,
    supabaseServiceKey,
    clientOptions
);

// ─── RETRY HELPER ──────────────────────────────────────
async function withRetry(fn, maxRetries = 3, delay = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            console.warn(`⚠️ Supabase retry ${attempt}/${maxRetries}:`, error.message);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, delay * attempt));
            }
        }
    }
    throw lastError;
}

// ─── CONNECTION TEST ───────────────────────────────────
async function testConnection() {
    try {
        const started = Date.now();
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .limit(1);
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

module.exports = {
    supabase,
    supabaseAdmin,
    withRetry,
    testConnection
};