require('dotenv').config();
const ws = require('ws');
const { createClient } = require('@supabase/supabase-js');

console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_ANON_KEY present:', !!process.env.SUPABASE_ANON_KEY);
console.log('SUPABASE_ANON_KEY length:', process.env.SUPABASE_ANON_KEY?.length);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws }
});

const TEST_TOKEN = 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImNlYzJkZGVlLTg3ZmQtNDY2Mi1hYjE5LTczMjBhMTBjN2E0NCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2JzdnJzaGp0YWN1emNxZWJqeG9wLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJmYjA2MWFmYy1kZTM1LTRiODktOWNhMy0xOGJlMDY1Y2U0NzgiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg0NzU0MTMyLCJpYXQiOjE3ODQ3NTA1MzIsImVtYWlsIjoibHVrQGguY29tIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJlbWFpbCIsInByb3ZpZGVycyI6WyJlbWFpbCJdfSwidXNlcl9tZXRhZGF0YSI6eyJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwidXNlcm5hbWUiOiJsdWsifSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJwYXNzd29yZCIsInRpbWVzdGFtcCI6MTc4NDc1MDUzMn1dLCJzZXNzaW9uX2lkIjoiYWM4NWVjMzktNTlkNS00NThlLThhYWEtMjhmY2JiMGQ4YjU0IiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.hln-Eo685suqCuKXoL8P6EAnuwK-ahSDMfWAQMKy43FA_0vSu1f1K8ZB0shb1lCgg2Pe6PHKM7wa1qybjq_HxQ';

async function main() {
  console.log('\n--- Testing basic reachability ---');
  const start1 = Date.now();
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY }
    });
    console.log(`Health check status: ${res.status} (${Date.now() - start1}ms)`);
    const body = await res.text();
    console.log('Health check body:', body);
  } catch (e) {
    console.error('❌ Health check FAILED:', e.message);
  }

  console.log('\n--- Testing supabase.auth.getUser(token) ---');
  const start2 = Date.now();
  try {
    const result = await Promise.race([
      supabase.auth.getUser(TEST_TOKEN),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT after 8s')), 8000))
    ]);
    console.log(`Completed in ${Date.now() - start2}ms`);
    console.log('Error:', result.error);
    console.log('User email:', result.data?.user?.email);
  } catch (e) {
    console.error(`❌ getUser FAILED after ${Date.now() - start2}ms:`, e.message);
  }

  console.log('\n--- Testing service-role client ---');
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      realtime: { transport: ws }
    });
    const start3 = Date.now();
    try {
      const { data, error } = await Promise.race([
        supabaseAdmin.from('profiles').select('id').limit(1),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT after 8s')), 8000))
      ]);
      console.log(`Completed in ${Date.now() - start3}ms`);
      console.log('Error:', error);
      console.log('Row returned:', data);
    } catch (e) {
      console.error(`❌ profiles query FAILED after ${Date.now() - start3}ms:`, e.message);
    }
  } else {
    console.log('SUPABASE_SERVICE_ROLE_KEY not set — skipping');
  }

  process.exit(0);
}

main();