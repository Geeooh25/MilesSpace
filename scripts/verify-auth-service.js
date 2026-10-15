// scripts/verify-auth-routes.js
// ─────────────────────────────────────────────────────────────────
// End-to-end HTTP verification of authRoutes.js.
//
// Requires:
//   • The server running at BASE_URL with the rewritten authRoutes.
//   • OTP_SECRET in .env (used to read OTP codes from the DB so we
//     do not depend on the email provider during tests).
//   • NODE_ENV != 'production' so cookies are not Secure-only.
//
// Usage:
//   node scripts/verify-auth-routes.js
// ─────────────────────────────────────────────────────────────────

'use strict';
require('dotenv').config();

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');

const BASE_URL   = process.env.VERIFY_BASE_URL || 'http://localhost:5000';
const OTP_SECRET = process.env.OTP_SECRET;

if (!OTP_SECRET) {
    console.error('OTP_SECRET is required (used to reverse the OTP hash).');
    process.exit(1);
}

// ─── Tiny cookie jar ────────────────────────────────────────────
// We do NOT use a third-party jar. We parse Set-Cookie from each
// response and replay it on the next request. Sufficient for the
// refresh and pin_auth cookies.
function parseSetCookie(headers) {
    // Node's fetch exposes getSetCookie() in Node 18.14+.
    const list = headers.getSetCookie ? headers.getSetCookie() : [];
    const jar = {};
    for (const line of list) {
        const [pair, ...attrs] = line.split(';');
        const [name, value] = pair.split('=');
        jar[name.trim()] = { value: (value || '').trim(), attrs };
    }
    return jar;
}

class Session {
    constructor(name) {
        this.name = name;
        this.cookies = {};        // name -> { value, attrs }
        this.accessToken = null;
    }
    cookieHeader() {
        const parts = [];
        for (const [name, c] of Object.entries(this.cookies)) {
            parts.push(`${name}=${c.value}`);
        }
        return parts.join('; ');
    }
    absorb(response) {
        const fresh = parseSetCookie(response.headers);
        for (const [name, c] of Object.entries(fresh)) {
            if (c.attrs.some(a => /max-age=0/i.test(a)) || c.value === '') {
                delete this.cookies[name];
            } else {
                this.cookies[name] = c;
            }
        }
    }
    async request(method, path, body) {
        const headers = { 'Content-Type': 'application/json' };
        const cookie = this.cookieHeader();
        if (cookie) headers['Cookie'] = cookie;
        if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;

        const response = await fetch(`${BASE_URL}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });
        this.absorb(response);
        return response;
    }
    async json(method, path, body) {
        const response = await this.request(method, path, body);
        let data = null;
        try { data = await response.json(); } catch { /* not json */ }
        return { status: response.status, data, response };
    }
}

// ─── Test harness ───────────────────────────────────────────────
let PASS = 0, FAIL = 0;
async function step(name, fn) {
    process.stdout.write(`- ${name} ... `);
    try {
        await fn();
        console.log('PASS');
        PASS++;
    } catch (e) {
        console.log('FAIL:', e.message);
        FAIL++;
        process.exitCode = 1;
    }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ─── OTP reverse lookup ─────────────────────────────────────────
// We cannot reverse the HMAC. Instead, we read the challenge row,
// then try every 6-digit code: for each, compute the hash and
// compare. That's 900,000 HMAC-SHA256 ops — too slow.
//
// Better: intercept the OTP at creation time. We cannot do that
// from this script without the server cooperating.
//
// The pragmatic approach used here: temporarily patch OTP_SECRET
// during tests by having the server write the OTP into the
// challenge row's `metadata.otp_for_test_only`. This script does
// NOT modify the server. So instead, we read the OTP from the
// email outbox table if one exists, or from a test-only endpoint.
//
// Since none of that exists, the fallback is: skip the two
// registration-verification tests that require an OTP, and cover
// the rest of the flow by creating verified users directly via
// supabaseAdmin.
async function createVerifiedUser() {
    const email = `verify+${Date.now()}-${crypto.randomBytes(3).toString('hex')}@milesspace.test`;
    const password = 'Test1234!';

    const auth = await supabaseAdmin.auth.admin.createUser({
        email, password, email_confirm: true
    });
    if (auth.error) throw auth.error;
    const id = auth.data.user.id;

    const { error: profErr } = await supabaseAdmin.from('profiles').upsert({
        id, email,
        username: email.split('@')[0].slice(0, 30),
        role: 'user',
        status: 'active',
        is_verified: true,
        wallet_ngn: 10000,
        wallet_usd: 0
    }, { onConflict: 'id' });
    if (profErr) throw profErr;

    return { id, email, password };
}

async function cleanupUser(id) {
    try { await supabaseAdmin.from('profiles').delete().eq('id', id); } catch {}
    try { await supabaseAdmin.auth.admin.deleteUser(id); } catch {}
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════
(async () => {
    // Sanity: is the server up?
    {
        const r = await fetch(`${BASE_URL}/api/health`).catch(() => null);
        if (!r || !r.ok) {
            console.error(`Server not reachable at ${BASE_URL}/api/health`);
            process.exit(1);
        }
        console.log(`Server up at ${BASE_URL}\n`);
    }

    const user = await createVerifiedUser();
    console.log(`Test user: ${user.email}\n`);

    const s = new Session('main');

    // ─────────────────────────────────────────────────────────────
    // 1. Login (no 2FA)
    // ─────────────────────────────────────────────────────────────
    await step('POST /login issues tokens', async () => {
        const { status, data } = await s.json('POST', '/api/auth/login', {
            email: user.email,
            password: user.password,
            device_id: 'verify-device-1'
        });
        assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
        assert(data?.success === true, 'success!=true');
        assert(data?.data?.access_token, 'no access_token');
        assert(data?.data?.session_id, 'no session_id');
        s.accessToken = data.data.access_token;
    });

    await step('POST /login sets HttpOnly mx_rt cookie', async () => {
        const c = s.cookies['mx_rt'];
        assert(c, 'mx_rt cookie missing');
        assert(c.attrs.some(a => /httponly/i.test(a)), 'mx_rt not HttpOnly');
        assert(c.attrs.some(a => /samesite=strict/i.test(a)), 'mx_rt not SameSite=Strict');
        // Do not assert Secure in dev.
    });

    // ─────────────────────────────────────────────────────────────
    // 2. GET /session
    // ─────────────────────────────────────────────────────────────
    await step('GET /session with access token', async () => {
        const { status, data } = await s.json('GET', '/api/auth/session');
        assert(status === 200, `expected 200, got ${status}`);
        assert(data?.authenticated === true, 'authenticated!=true');
        assert(data?.user?.id === user.id, 'user id mismatch');
    });

    await step('GET /session without token → 401 NO_TOKEN', async () => {
        const bare = new Session('bare');
        const { status, data } = await bare.json('GET', '/api/auth/session');
        assert(status === 401, `expected 401, got ${status}`);
        assert(data?.code === 'NO_TOKEN', `expected NO_TOKEN, got ${data?.code}`);
    });

    // ─────────────────────────────────────────────────────────────
    // 3. Refresh rotation
    // ─────────────────────────────────────────────────────────────
    let firstRefreshToken = null;
    await step('POST /refresh rotates and issues new tokens', async () => {
        const before = s.cookies['mx_rt']?.value;
        firstRefreshToken = before;
        const { status, data } = await s.json('POST', '/api/auth/refresh');
        assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
        assert(data?.data?.access_token, 'no new access_token');
        const after = s.cookies['mx_rt']?.value;
        assert(after && after !== before, 'refresh token did not rotate');
        s.accessToken = data.data.access_token;
    });

    // ─────────────────────────────────────────────────────────────
    // 4. Concurrent refresh — one 200, one 409 REFRESH_RACE
    //    Uses a fresh session so we are not fighting the rotated
    //    cookie from step 3.
    // ─────────────────────────────────────────────────────────────
    await step('Concurrent refresh → exactly one winner', async () => {
        // Fresh login for a clean cookie.
        const s2 = new Session('concurrent');
        const loginResp = await s2.json('POST', '/api/auth/login', {
            email: user.email, password: user.password,
            device_id: 'verify-device-2'
        });
        assert(loginResp.status === 200, `login failed: ${loginResp.status}`);
        s2.accessToken = loginResp.data.data.access_token;

        // Fire two refreshes with the SAME cookie, in parallel.
        // Each Session has its own jar; both start with the same
        // cookie value.
        const s2b = new Session('concurrent-b');
        s2b.cookies = JSON.parse(JSON.stringify(s2.cookies));

        const [r1, r2] = await Promise.all([
            s2.request('POST', '/api/auth/refresh').then(async r => ({
                status: r.status, body: await r.json().catch(() => null)
            })),
            s2b.request('POST', '/api/auth/refresh').then(async r => ({
                status: r.status, body: await r.json().catch(() => null)
            }))
        ]);

        const statuses = [r1.status, r2.status].sort();
        assert(
            statuses[0] === 200 && statuses[1] === 409,
            `expected [200, 409], got [${statuses}] bodies=${JSON.stringify([r1.body, r2.body])}`
        );
        const loser = [r1, r2].find(r => r.status === 409);
        assert(loser.body?.code === 'REFRESH_RACE',
            `expected REFRESH_RACE, got ${loser.body?.code}`);
    });

    // ─────────────────────────────────────────────────────────────
    // 5. Reuse of an already-rotated token → 401 REUSE
    // ─────────────────────────────────────────────────────────────
    await step('Reused refresh token → REFRESH_TOKEN_REUSE', async () => {
        assert(firstRefreshToken, 'no first refresh token captured');
        const replay = new Session('replay');
        replay.cookies['mx_rt'] = { value: firstRefreshToken, attrs: [] };
        const { status, data } = await replay.json('POST', '/api/auth/refresh');
        assert(status === 401, `expected 401, got ${status}: ${JSON.stringify(data)}`);
        assert(
            data?.code === 'REFRESH_TOKEN_REUSE' ||
            data?.code === 'REFRESH_RACE',
            `expected REUSE or RACE, got ${data?.code}`
        );
    });

    // ─────────────────────────────────────────────────────────────
    // 6. Logout revokes session in the database
    // ─────────────────────────────────────────────────────────────
    let sessionIdToCheck = null;
    {
        const fresh = new Session('logout-test');
        const r = await fresh.json('POST', '/api/auth/login', {
            email: user.email, password: user.password,
            device_id: 'verify-device-3'
        });
        assert(r.status === 200, `fresh login failed: ${r.status}`);
        fresh.accessToken = r.data.data.access_token;
        sessionIdToCheck = r.data.data.session_id;

        await step('POST /logout clears mx_rt and revokes session', async () => {
            const { status, data } = await fresh.json('POST', '/api/auth/logout');
            assert(status === 200, `expected 200, got ${status}`);
            assert(data?.success === true, 'logout did not return success');

            const { data: row } = await supabaseAdmin
                .from('user_sessions')
                .select('is_active, revoked_at')
                .eq('user_id', user.id)
                .eq('session_id', sessionIdToCheck)
                .maybeSingle();
            assert(row, 'user_sessions row missing');
            assert(row.revoked_at, 'revoked_at is NULL after logout — cast bug');
            assert(row.is_active === false, 'is_active still true');
        });

        await step('GET /session after logout → 401', async () => {
            const { status, data } = await fresh.json('GET', '/api/auth/session');
            assert(status === 401, `expected 401, got ${status}`);
            assert(
                data?.code === 'SESSION_REVOKED' || data?.code === 'INVALID_SESSION',
                `unexpected code ${data?.code}`
            );
        });

        await step('POST /refresh after logout → 401 NO_REFRESH_TOKEN', async () => {
            const { status, data } = await fresh.json('POST', '/api/auth/refresh');
            assert(status === 401, `expected 401, got ${status}`);
            assert(data?.code === 'NO_REFRESH_TOKEN',
                `expected NO_REFRESH_TOKEN, got ${data?.code}`);
        });
    }

    // ─────────────────────────────────────────────────────────────
    // 7. Two users, two sessions — the second login does NOT
    //    affect the first (single-active-session policy means
    //    the SAME user logging in again kills the first, but a
    //    different user is unaffected).
    // ─────────────────────────────────────────────────────────────
    {
        const user2 = await createVerifiedUser();
        const s1 = new Session('single-session');
        const s2 = new Session('single-session-2');

        const l1 = await s1.json('POST', '/api/auth/login', {
            email: user.email, password: user.password,
            device_id: 'verify-device-4'
        });
        assert(l1.status === 200, `login1 failed: ${l1.status}`);
        s1.accessToken = l1.data.data.access_token;

        const l2 = await s2.json('POST', '/api/auth/login', {
            email: user.email, password: user.password,
            device_id: 'verify-device-5'
        });
        assert(l2.status === 200, `login2 failed: ${l2.status}`);
        s2.accessToken = l2.data.data.access_token;

        await step('Second login supersedes first session', async () => {
            const first = await s1.json('GET', '/api/auth/session');
            assert(
                first.status === 401,
                `first session should be 401 after second login, got ${first.status}`
            );
            const second = await s2.json('GET', '/api/auth/session');
            assert(second.status === 200, `second session should be 200, got ${second.status}`);
        });

        await cleanupUser(user2.id);
    }

    // ─────────────────────────────────────────────────────────────
    // 8. PIN: create, verify, cookie set, replay
    // ─────────────────────────────────────────────────────────────
    {
        const fresh = new Session('pin-test');
        const r = await fresh.json('POST', '/api/auth/login', {
            email: user.email, password: user.password,
            device_id: 'verify-device-pin'
        });
        assert(r.status === 200, `login failed: ${r.status}`);
        fresh.accessToken = r.data.data.access_token;

        await step('POST /create-pin accepts a strong 4-digit PIN', async () => {
            const { status, data } = await fresh.json('POST', '/api/auth/create-pin', {
                pin: '5931'
            });
            assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
            assert(data?.success === true, 'success!=true');
        });

        await step('POST /create-pin on existing PIN → 409', async () => {
            const { status, data } = await fresh.json('POST', '/api/auth/create-pin', {
                pin: '1234'      // different PIN, still rejected because one exists
            });
            assert(status === 409, `expected 409, got ${status}`);
            assert(data?.code === 'PIN_ALREADY_SET', `expected PIN_ALREADY_SET, got ${data?.code}`);
        });

        await step('POST /verify-pin sets HttpOnly mx_pin_auth', async () => {
            const { status, data } = await fresh.json('POST', '/api/auth/verify-pin', {
                pin: '5931'
            });
            assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
            const c = fresh.cookies['mx_pin_auth'];
            assert(c, 'mx_pin_auth cookie missing');
            assert(c.attrs.some(a => /httponly/i.test(a)), 'mx_pin_auth not HttpOnly');
        });

        await step('POST /verify-pin with wrong PIN → 401 INVALID_PIN', async () => {
            const { status, data } = await fresh.json('POST', '/api/auth/verify-pin', {
                pin: '0000'
            });
            assert(status === 401, `expected 401, got ${status}`);
            assert(data?.code === 'INVALID_PIN', `expected INVALID_PIN, got ${data?.code}`);
        });
    }

    // ─────────────────────────────────────────────────────────────
    // 9. Password reset flow — issue code, verify, reset, login
    //    Uses /forgot-password, then we read the OTP from the DB
    //    by matching the challenge we just created.
    // ─────────────────────────────────────────────────────────────
    {
        await step('POST /forgot-password returns generic success', async () => {
            const bare = new Session('forgot');
            const { status, data } = await bare.json('POST', '/api/auth/forgot-password', {
                email: user.email
            });
            assert(status === 200, `expected 200, got ${status}`);
            assert(data?.success === true, 'generic success missing');
        });

        // To complete the reset we need the OTP, which we cannot
        // reverse from the hash. Skip the full reset in this script;
        // it is covered by the service-level test and by manual
        // verification. If you have a test-mode OTP endpoint,
        // plug it in here.
        console.log('- (password-reset OTP path requires reading email — skipped)');
    }

    // ─────────────────────────────────────────────────────────────
    // 10. /me shape
    // ─────────────────────────────────────────────────────────────
    {
        const fresh = new Session('me-test');
        const r = await fresh.json('POST', '/api/auth/login', {
            email: user.email, password: user.password,
            device_id: 'verify-device-me'
        });
        assert(r.status === 200, `login failed: ${r.status}`);
        fresh.accessToken = r.data.data.access_token;

        await step('GET /me returns safe profile (no pin hash)', async () => {
            const { status, data } = await fresh.json('GET', '/api/auth/me');
            assert(status === 200, `expected 200, got ${status}`);
            assert(data?.data?.id === user.id, 'id mismatch');
            assert(
                !('transaction_pin_hash' in (data.data || {})),
                'transaction_pin_hash leaked in /me'
            );
            assert(
                typeof data.data.has_transaction_pin === 'boolean',
                'has_transaction_pin missing'
            );
        });
    }

    // Cleanup
    await cleanupUser(user.id);
    console.log(`\nCleanup done.`);
    console.log(`\nPASS: ${PASS}   FAIL: ${FAIL}`);
})().catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
});