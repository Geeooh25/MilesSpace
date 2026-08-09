// db/supabase.js - FIXED WebSocket Error
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ Missing Supabase credentials in .env');
  process.exit(1);
}

console.log('🔗 Connecting to Supabase:', supabaseUrl);

// ✅ FIX: Provide WebSocket transport for Node.js 20+
const wsOptions = {
  realtime: {
    transport: WebSocket
  }
};

// Public client (for frontend)
const supabase = createClient(supabaseUrl, supabaseAnonKey, wsOptions);

// Admin client (for backend operations)
let supabaseAdmin = supabase;
if (supabaseServiceKey) {
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    ...wsOptions,
    auth: { autoRefreshToken: false, persistSession: false }
  });
  console.log('✅ Supabase Admin client initialized');
}

console.log('✅ Supabase clients created successfully');

module.exports = { supabase, supabaseAdmin };