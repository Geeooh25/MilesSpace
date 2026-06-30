// db/supabase.js
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

console.log('🔗 Trying to connect to:', supabaseUrl);

// WebSocket fix for Node.js 20
const wsOptions = {
  realtime: {
    transport: WebSocket
  }
};

const supabase = createClient(supabaseUrl, supabaseAnonKey, wsOptions);

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