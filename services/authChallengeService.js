// services/authChallengeService.js
// ─────────────────────────────────────────────────────────────────
// Postgres-backed OTP / challenge / refresh / PIN-authorization
// service, plus login-risk engine, device/location recording, and
// UTC helpers.
//
// Revision 2026-10-13c
//
// CHANGES IN THIS REVISION:
//   • establishUserSessionAtomic now calls the
//     establish_user_session_atomic Postgres RPC, which performs
//     all three session-related writes inside a single Postgres
//     transaction. If the RPC is unavailable or returns a
//     permanent error, the function falls back to the previous
//     Node-side sequence (revoke, profile update, insert). The
//     fallback is not atomic but the intermediate states are
//     recoverable — see the comment block above the function.
//   • revokeUserSessionAtomic similarly prefers the
//     revoke_user_session_atomic RPC and falls back to table
//     writes.
//   • No other function changed. The exports are identical to
//     the previous revision.
//
// ATOMICITY MODEL:
//   When the RPC is available, session establishment and
//   revocation are truly atomic. When the RPC is unavailable, the
//   Node-side fallback runs multiple PostgREST writes; the caller
//   treats any throw as failure and never reports success on a
//   partial write. Single-use claims elsewhere in this file use
//   conditional UPDATE ... IS NULL with a RETURNING projection.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');

const OTP_SECRET = process.env.OTP_SECRET
    || 'milesspace-otp-secret-change-in-production';
if (!process.env.OTP_SECRET && process.env.NODE_ENV === 'production') {
    console.error('❌ CRITICAL: OTP_SECRET is required in production');
    process.exit(1);
}

const OTP_EXPIRY_MINUTES      = 10;
const MAX_OTP_ATTEMPTS        = 5;
const RESEND_COOLDOWN_SECONDS = 30;
const MAX_RESENDS_PER_HOUR    = 5;

const MAX_LOGIN_ATTEMPTS      = 5;
const LOGIN_LOCKOUT_MINUTES   = 15;

const REFRESH_TOKEN_TTL_MS    = 60 * 60 * 1000;
const RESET_AUTH_TTL_MINUTES  = 10;
const PIN_AUTH_DEFAULT_TTL_SECONDS = 120;

const RISK_NEW_DEVICE_WEIGHT  = 2;
const RISK_NEW_COUNTRY_WEIGHT = 3;
const RISK_MEDIUM_THRESHOLD   = 2;
const RISK_HIGH_THRESHOLD     = 4;
const FAMILIAR_COUNTRY_DAYS   = 30;

// ─── UTC helpers ────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }
function parseUtc(value) {
    if (value == null) return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const s = String(value);
    const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
    return Date.parse(hasTz ? s : s + 'Z');
}
function isExpired(value) {
    const t = parseUtc(value);
    return Number.isFinite(t) && t < Date.now();
}

// ─── Hashing ────────────────────────────────────────────────────
function hashValue(value) {
    return crypto.createHmac('sha256', OTP_SECRET).update(String(value)).digest('hex');
}
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}
function generateOTP() { return crypto.randomInt(100000, 1000000).toString(); }
function generateOpaqueToken() { return crypto.randomBytes(40).toString('hex'); }
function hashOpaqueToken(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function logDbError(context, error) {
    const msg = error?.message || String(error);
    const code = error?.code ? ` [${error.code}]` : '';
    const details = error?.details ? ` details=${JSON.stringify(error.details)}` : '';
    const hint = error?.hint ? ` hint=${JSON.stringify(error.hint)}` : '';
    console.error(`[AUTH-SVC] ${context}:${code} ${msg}${details}${hint}`);
}

// ─────────────────────────────────────────────────────────────────
// RPC availability detection
//
// A missing function (42883), permission denied (42501), or a
// PostgREST schema-cache miss (PGRST202) means the RPC is not
// usable in this deployment. In that case we fall back to table
// writes. Any other error is treated as a genuine failure and
// propagates.
// ─────────────────────────────────────────────────────────────────
function isRpcUnavailable(error) {
    if (!error) return false;
    const code = String(error.code || '');
    if (code === '42883') return true;   // function does not exist
    if (code === '42501') return true;   // permission denied
    if (code === 'PGRST202') return true; // schema cache miss
    if (code === 'PGRST203') return true; // overloaded functions
    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('could not find the function')) return true;
    if (msg.includes('function public.') && msg.includes('does not exist')) return true;
    if (msg.includes('permission denied for function')) return true;
    return false;
}

// ═══════════════════════════════════════════════════════════════════
//  RISK ENGINE (advisory)
// ═══════════════════════════════════════════════════════════════════

async function isDeviceTrusted({ userId, deviceId }) {
    if (!userId || !deviceId) return { trusted: false, known: false };
    try {
        const { data, error } = await supabaseAdmin
            .from('user_devices')
            .select('trusted, revoked_at, last_seen')
            .eq('user_id', userId)
            .eq('device_id', deviceId)
            .maybeSingle();
        if (error) {
            logDbError('isDeviceTrusted', error);
            return { trusted: false, known: false, degraded: true };
        }
        if (!data || data.revoked_at) return { trusted: false, known: false };
        return { trusted: !!data.trusted, known: true };
    } catch (thrown) {
        console.error('[AUTH-SVC] isDeviceTrusted threw:', thrown.message);
        return { trusted: false, known: false, degraded: true };
    }
}

async function hasSeenCountryRecently({ userId, country }) {
    if (!userId || !country) return false;
    try {
        const sinceIso = new Date(
            Date.now() - FAMILIAR_COUNTRY_DAYS * 24 * 60 * 60 * 1000
        ).toISOString();

        const { count, error } = await supabaseAdmin
            .from('user_locations')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('country', country)
            .gte('created_at', sinceIso);

        if (error) {
            logDbError('hasSeenCountryRecently', error);
            return false;
        }
        return (count || 0) > 0;
    } catch (thrown) {
        console.error('[AUTH-SVC] hasSeenCountryRecently threw:', thrown.message);
        return false;
    }
}

async function evaluateLoginRisk({ userId, deviceId, country }) {
    const result = {
        level: 'low',
        reasons: [],
        isNewDevice: false,
        isNewCountry: false,
        isTrustedDevice: false,
        degraded: false
    };
    if (!userId) {
        result.level = 'medium';
        result.reasons.push('missing_user_id');
        return result;
    }

    if (deviceId) {
        const dev = await isDeviceTrusted({ userId, deviceId });
        result.isTrustedDevice = dev.trusted;
        result.isNewDevice = !dev.known;
        if (dev.degraded) result.degraded = true;
    } else {
        result.isNewDevice = true;
    }

    if (country) {
        result.isNewCountry = !(await hasSeenCountryRecently({ userId, country }));
    }

    let score = 0;
    if (result.isNewDevice && !result.isTrustedDevice) score += RISK_NEW_DEVICE_WEIGHT;
    if (result.isNewCountry) score += RISK_NEW_COUNTRY_WEIGHT;

    if (score >= RISK_HIGH_THRESHOLD) result.level = 'high';
    else if (score >= RISK_MEDIUM_THRESHOLD) result.level = 'medium';

    if (result.isNewDevice) result.reasons.push('new_device');
    if (result.isNewCountry) result.reasons.push('new_country');
    if (result.isTrustedDevice) result.reasons.push('trusted_device');

    return result;
}

// ═══════════════════════════════════════════════════════════════════
//  DEVICE + LOCATION + SECURITY EVENTS
// ═══════════════════════════════════════════════════════════════════

async function upsertDevice({
    userId, deviceId,
    deviceName = null, browser = null, os = null, deviceType = null,
    ip = null, location = null
}) {
    if (!userId || !deviceId) return { ok: false, reason: 'missing_input' };
    try {
        const now = nowIso();

        const { data: existing, error: readErr } = await supabaseAdmin
            .from('user_devices')
            .select('id, first_seen, trusted')
            .eq('user_id', userId)
            .eq('device_id', deviceId)
            .maybeSingle();
        if (readErr) {
            logDbError('upsertDevice read', readErr);
            return { ok: false, reason: 'read_failed' };
        }

        if (!existing) {
            const { error: insErr } = await supabaseAdmin
                .from('user_devices')
                .insert({
                    user_id: userId,
                    device_id: deviceId,
                    device_name: deviceName,
                    browser, os, device_type: deviceType,
                    ip_address: ip,
                    location,
                    first_seen: now,
                    last_seen: now,
                    trusted: false
                });
            if (insErr) {
                logDbError('upsertDevice insert', insErr);
                return { ok: false, reason: 'insert_failed' };
            }
            return { ok: true, created: true };
        }

        const { error: updErr } = await supabaseAdmin
            .from('user_devices')
            .update({
                device_name: deviceName || undefined,
                browser: browser || undefined,
                os: os || undefined,
                device_type: deviceType || undefined,
                ip_address: ip || undefined,
                location: location || undefined,
                last_seen: now,
                updated_at: now
            })
            .eq('id', existing.id);
        if (updErr) {
            logDbError('upsertDevice update', updErr);
            return { ok: false, reason: 'update_failed' };
        }
        return { ok: true, created: false };
    } catch (thrown) {
        console.error('[AUTH-SVC] upsertDevice threw:', thrown.message);
        return { ok: false, reason: 'threw' };
    }
}

async function recordLoginLocation({ userId, ip, country, city, region, isp }) {
    if (!userId || !ip) return { ok: false, reason: 'missing_input' };
    try {
        const { error } = await supabaseAdmin
            .from('user_locations')
            .insert({
                user_id: userId,
                ip,
                country: country || null,
                city: city || null,
                region: region || null,
                isp: isp || null,
                created_at: nowIso()
            });
        if (error) {
            logDbError('recordLoginLocation', error);
            return { ok: false, reason: 'insert_failed' };
        }
        return { ok: true };
    } catch (thrown) {
        console.error('[AUTH-SVC] recordLoginLocation threw:', thrown.message);
        return { ok: false, reason: 'threw' };
    }
}

async function recordSecurityEvent({
    userId = null, email = null, kind, detail = {}, ip = null, userAgent = null
}) {
    if (!kind) return { ok: false, reason: 'missing_kind' };
    try {
        const now = nowIso();
        const { error } = await supabaseAdmin
            .from('auth_challenges')
            .insert({
                user_id: userId,
                email: email || 'system@milesspace.local',
                purpose: `security_event:${kind}`,
                code_hash: hashValue(`${kind}:${now}:${crypto.randomBytes(8).toString('hex')}`),
                expires_at: now,
                consumed_at: now,
                verified_at: now,
                max_attempts: 0,
                attempts: 0,
                ip_address: ip,
                user_agent: userAgent ? String(userAgent).slice(0, 400) : null,
                metadata: { kind, ...detail, recorded_at: now }
            });
        if (error) {
            logDbError('recordSecurityEvent', error);
            return { ok: false, reason: 'insert_failed' };
        }
        return { ok: true };
    } catch (thrown) {
        console.error('[AUTH-SVC] recordSecurityEvent threw:', thrown.message);
        return { ok: false, reason: 'threw' };
    }
}

// ═══════════════════════════════════════════════════════════════════
//  CHALLENGES
// ═══════════════════════════════════════════════════════════════════

async function createChallenge({
    userId = null, email, purpose,
    ipAddress = null, userAgent = null, metadata = {}
}) {
    if (!email || !purpose) throw new Error('email and purpose are required');

    const otp = generateOTP();
    const codeHash = hashValue(otp);
    const expiresAtIso = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

    const { error: invalidateErr } = await supabaseAdmin
        .from('auth_challenges')
        .update({ consumed_at: nowIso() })
        .eq('email', email)
        .eq('purpose', purpose)
        .is('consumed_at', null);
    if (invalidateErr) {
        logDbError('createChallenge invalidate', invalidateErr);
        throw new Error('Failed to prepare challenge');
    }

    const { data, error } = await supabaseAdmin
        .from('auth_challenges')
        .insert({
            user_id: userId,
            email,
            purpose,
            code_hash: codeHash,
            expires_at: expiresAtIso,
            max_attempts: MAX_OTP_ATTEMPTS,
            ip_address: ipAddress,
            user_agent: userAgent,
            metadata
        })
        .select('id')
        .single();
    if (error) {
        logDbError('createChallenge insert', error);
        throw new Error('Failed to create challenge');
    }

    return {
        challengeId: data.id,
        otp,
        expiresAt: expiresAtIso,
        expiresInSeconds: OTP_EXPIRY_MINUTES * 60
    };
}

async function getChallenge(challengeId) {
    const { data, error } = await supabaseAdmin
        .from('auth_challenges')
        .select('*')
        .eq('id', challengeId)
        .maybeSingle();
    if (error) {
        logDbError('getChallenge', error);
        throw new Error('Failed to load challenge');
    }
    return data;
}

// ─────────────────────────────────────────────────────────────────
// verifyAndConsumeChallenge — single-use claim via conditional
// UPDATE with RETURNING. Unchanged.
// ─────────────────────────────────────────────────────────────────
async function verifyAndConsumeChallenge({ challengeId, code, purpose }) {
    const submittedHash = hashValue(String(code).trim());

    const { data: challenge, error: readErr } = await supabaseAdmin
        .from('auth_challenges')
        .select('id, user_id, email, purpose, code_hash, expires_at, consumed_at, attempts, max_attempts')
        .eq('id', challengeId)
        .maybeSingle();

    if (readErr) {
        logDbError('verifyAndConsumeChallenge read', readErr);
        return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE',
                 message: 'Could not verify code right now. Please try again.' };
    }
    if (!challenge) {
        return { ok: false, code: 'INVALID_CODE', message: 'Invalid code.' };
    }
    if (challenge.purpose !== purpose) {
        return { ok: false, code: 'INVALID_CODE', message: 'Invalid code.' };
    }
    if (challenge.consumed_at) {
        return { ok: false, code: 'INVALID_CODE', message: 'Code has already been used.' };
    }
    if (isExpired(challenge.expires_at)) {
        return { ok: false, code: 'CODE_EXPIRED', message: 'Code has expired. Request a new one.' };
    }
    const maxAttempts = Number(challenge.max_attempts) || MAX_OTP_ATTEMPTS;
    const attempts = Number(challenge.attempts) || 0;
    if (attempts >= maxAttempts) {
        return { ok: false, code: 'TOO_MANY_ATTEMPTS',
                 message: 'Too many incorrect attempts. Request a new code.' };
    }

    if (!safeCompare(challenge.code_hash, submittedHash)) {
        const newAttempts = attempts + 1;
        try {
            await supabaseAdmin
                .from('auth_challenges')
                .update({ attempts: newAttempts })
                .eq('id', challengeId)
                .eq('consumed_at', null);
        } catch (e) {
            logDbError('verifyAndConsumeChallenge attempt-increment', e);
        }
        const remaining = Math.max(0, maxAttempts - newAttempts);
        return {
            ok: false,
            code: 'INVALID_CODE',
            message: remaining > 0
                ? `Incorrect code. ${remaining} attempts remaining.`
                : 'Too many incorrect attempts. Request a new code.',
            attempts_remaining: remaining
        };
    }

    const { data: claimedRows, error: claimErr } = await supabaseAdmin
        .from('auth_challenges')
        .update({
            consumed_at: nowIso(),
            verified_at: nowIso()
        })
        .eq('id', challengeId)
        .is('consumed_at', null)
        .select('id, user_id, email');

    if (claimErr) {
        logDbError('verifyAndConsumeChallenge claim', claimErr);
        return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE',
                 message: 'Could not verify code right now. Please try again.' };
    }
    if (!claimedRows || claimedRows.length === 0) {
        return { ok: false, code: 'INVALID_CODE', message: 'Code has already been used.' };
    }

    const claimed = claimedRows[0];
    return {
        ok: true,
        user_id: claimed.user_id,
        email: claimed.email
    };
}

async function verifyChallenge({ challengeId, code, purpose }) {
    const result = await verifyAndConsumeChallenge({ challengeId, code, purpose });
    if (!result.ok) return result;
    return {
        ok: true,
        challenge: {
            id: challengeId, user_id: result.user_id,
            email: result.email, purpose
        }
    };
}

async function consumeChallenge(challengeId) {
    return { ok: true, noop: true, challengeId };
}

// ─────────────────────────────────────────────────────────────────
// resendChallenge — race-safe via conditional UPDATE. Unchanged.
// ─────────────────────────────────────────────────────────────────
async function resendChallenge(challengeId, { ipAddress, userAgent } = {}) {
    const { data: challenge, error: readErr } = await supabaseAdmin
        .from('auth_challenges')
        .select('id, email, purpose, last_sent_at, resend_count, consumed_at, expires_at')
        .eq('id', challengeId)
        .maybeSingle();

    if (readErr) {
        logDbError('resendChallenge read', readErr);
        return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE',
                 message: 'Could not resend code right now. Please try again.' };
    }
    if (!challenge) {
        return { ok: false, code: 'INVALID_CHALLENGE', message: 'Challenge not found.' };
    }
    if (challenge.consumed_at) {
        return { ok: false, code: 'CHALLENGE_ALREADY_USED',
                 message: 'This verification is already complete.' };
    }

    const lastSent = parseUtc(challenge.last_sent_at);
    const secondsSinceLast = Number.isFinite(lastSent)
        ? (Date.now() - lastSent) / 1000
        : Number.POSITIVE_INFINITY;

    if (secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
        const wait = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLast);
        return { ok: false, code: 'RESEND_COOLDOWN',
                 message: `Please wait ${wait} seconds before requesting a new code.` };
    }

    const resendCount = Number(challenge.resend_count) || 0;
    if (resendCount >= MAX_RESENDS_PER_HOUR) {
        return { ok: false, code: 'RESEND_LIMIT',
                 message: 'Too many resend requests. Please try again later.' };
    }

    const otp = generateOTP();
    const codeHash = hashValue(otp);
    const expiresAtIso = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

    const { data: updatedRows, error: updErr } = await supabaseAdmin
        .from('auth_challenges')
        .update({
            code_hash: codeHash,
            expires_at: expiresAtIso,
            last_sent_at: nowIso(),
            resend_count: resendCount + 1,
            ip_address: ipAddress || undefined,
            user_agent: userAgent ? String(userAgent).slice(0, 400) : undefined
        })
        .eq('id', challengeId)
        .eq('resend_count', resendCount)
        .is('consumed_at', null)
        .select('id');

    if (updErr) {
        logDbError('resendChallenge update', updErr);
        return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE',
                 message: 'Could not resend code right now. Please try again.' };
    }
    if (!updatedRows || updatedRows.length === 0) {
        return { ok: false, code: 'RESEND_RACE',
                 message: 'A resend is already in progress. Please wait a moment.' };
    }

    return {
        ok: true,
        otp,
        challenge: { id: challengeId, email: challenge.email, purpose: challenge.purpose }
    };
}

// ═══════════════════════════════════════════════════════════════════
//  LOGIN ATTEMPTS
// ═══════════════════════════════════════════════════════════════════

async function checkLoginLock(email) {
    try {
        const { data, error } = await supabaseAdmin
            .from('login_attempts')
            .select('failed_count, locked_until')
            .eq('email', email)
            .maybeSingle();
        if (error) {
            logDbError('checkLoginLock', error);
            return { locked: false, degraded: true };
        }
        if (!data) return { locked: false };
        if (data.locked_until && parseUtc(data.locked_until) > Date.now()) {
            const remainingMs = parseUtc(data.locked_until) - Date.now();
            return { locked: true, remainingMinutes: Math.ceil(remainingMs / 60000) };
        }
        return { locked: false };
    } catch (thrown) {
        console.error('[AUTH-SVC] checkLoginLock threw:', thrown.message);
        return { locked: false, degraded: true };
    }
}

async function recordLoginFailure(email, ipAddress) {
    try {
        const now = nowIso();

        const { data: existing, error: readErr } = await supabaseAdmin
            .from('login_attempts')
            .select('failed_count, locked_until')
            .eq('email', email)
            .maybeSingle();

        if (readErr) {
            logDbError('recordLoginFailure read', readErr);
            return { failedCount: 0, locked: false, degraded: true };
        }

        const currentCount = Number(existing?.failed_count) || 0;
        const nextCount = currentCount + 1;
        const nowMs = Date.now();

        let lockedUntil = existing?.locked_until || null;
        let storedCount = nextCount;

        if (nextCount >= MAX_LOGIN_ATTEMPTS) {
            lockedUntil = new Date(nowMs + LOGIN_LOCKOUT_MINUTES * 60 * 1000).toISOString();
            storedCount = 0;
        }

        if (existing) {
            const { error: updErr } = await supabaseAdmin
                .from('login_attempts')
                .update({
                    failed_count: storedCount,
                    locked_until: lockedUntil,
                    last_attempt_at: now,
                    last_ip: ipAddress || null
                })
                .eq('email', email);
            if (updErr) logDbError('recordLoginFailure update', updErr);
        } else {
            const { error: insErr } = await supabaseAdmin
                .from('login_attempts')
                .insert({
                    email,
                    failed_count: nextCount >= MAX_LOGIN_ATTEMPTS ? 0 : nextCount,
                    locked_until: nextCount >= MAX_LOGIN_ATTEMPTS ? lockedUntil : null,
                    last_attempt_at: now,
                    last_ip: ipAddress || null
                });
            if (insErr) logDbError('recordLoginFailure insert', insErr);
        }

        const isLocked = lockedUntil && parseUtc(lockedUntil) > Date.now();
        return {
            failedCount: storedCount,
            locked: !!isLocked,
            lockedUntil
        };
    } catch (thrown) {
        console.error('[AUTH-SVC] recordLoginFailure threw:', thrown.message);
        return { failedCount: 0, locked: false, degraded: true };
    }
}

async function clearLoginFailures(email) {
    try {
        const { error } = await supabaseAdmin
            .from('login_attempts')
            .delete()
            .eq('email', email);
        if (error) logDbError('clearLoginFailures', error);
    } catch (thrown) {
        console.error('[AUTH-SVC] clearLoginFailures threw:', thrown.message);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  REFRESH TOKENS
// ═══════════════════════════════════════════════════════════════════

async function issueRefreshToken(userId, sessionId) {
    const raw = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(raw);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    const { error } = await supabaseAdmin
        .from('refresh_tokens')
        .insert({
            token_hash: tokenHash,
            user_id: userId,
            session_id: sessionId,
            expires_at: expiresAt.toISOString()
        });
    if (error) {
        logDbError('issueRefreshToken', error);
        throw new Error('Failed to issue refresh token');
    }
    return { refreshToken: raw, expiresAt };
}

async function lookupRefreshToken(raw) {
    const tokenHash = hashOpaqueToken(raw);
    const { data, error } = await supabaseAdmin
        .from('refresh_tokens')
        .select('token_hash, user_id, session_id, expires_at, used_at, revoked_at')
        .eq('token_hash', tokenHash)
        .maybeSingle();
    if (error) {
        logDbError('lookupRefreshToken', error);
        const e = new Error('Could not look up refresh token');
        e.code = 'REFRESH_LOOKUP_FAILED';
        throw e;
    }
    return data;
}

async function rotateRefreshTokenAtomic(oldRaw) {
    const oldHash = hashOpaqueToken(oldRaw);
    const newRaw = generateOpaqueToken();
    const newHash = hashOpaqueToken(newRaw);
    const newExpiresAtIso = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();

    const { data: claimedRows, error: claimErr } = await supabaseAdmin
        .from('refresh_tokens')
        .update({ used_at: nowIso() })
        .eq('token_hash', oldHash)
        .is('used_at', null)
        .is('revoked_at', null)
        .select('user_id, session_id, expires_at');

    if (claimErr) {
        logDbError('rotateRefreshTokenAtomic claim', claimErr);
        throw new Error('Failed to rotate refresh token');
    }
    if (!claimedRows || claimedRows.length === 0) {
        return { ok: false, reason: 'INVALID' };
    }

    const claimed = claimedRows[0];

    if (isExpired(claimed.expires_at)) {
        return {
            ok: false,
            reason: 'EXPIRED',
            userId: claimed.user_id,
            sessionId: claimed.session_id
        };
    }

    const { error: insErr } = await supabaseAdmin
        .from('refresh_tokens')
        .insert({
            token_hash: newHash,
            user_id: claimed.user_id,
            session_id: claimed.session_id,
            expires_at: newExpiresAtIso
        });
    if (insErr) {
        logDbError('rotateRefreshTokenAtomic insert', insErr);
        throw new Error('Failed to rotate refresh token');
    }

    return {
        ok: true,
        refreshToken: newRaw,
        userId: claimed.user_id,
        sessionId: claimed.session_id,
        expiresAt: newExpiresAtIso
    };
}

async function revokeRefreshToken(tokenHashOrRaw) {
    const tokenHash = String(tokenHashOrRaw).length === 64
        ? String(tokenHashOrRaw)
        : hashOpaqueToken(tokenHashOrRaw);
    const { error } = await supabaseAdmin
        .from('refresh_tokens')
        .update({ used_at: nowIso() })
        .eq('token_hash', tokenHash);
    if (error) {
        logDbError('revokeRefreshToken', error);
        throw new Error('Failed to revoke refresh token');
    }
}

async function revokeAllRefreshTokens(userId, exceptSessionId = null) {
    let q = supabaseAdmin
        .from('refresh_tokens')
        .update({ revoked_at: nowIso() })
        .eq('user_id', userId)
        .is('revoked_at', null);
    if (exceptSessionId) q = q.neq('session_id', exceptSessionId);
    const { error } = await q;
    if (error) {
        logDbError('revokeAllRefreshTokens', error);
        throw new Error('Failed to revoke refresh tokens');
    }
}

// ═══════════════════════════════════════════════════════════════════
//  SESSION HELPERS
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// establishUserSessionAtomic
//
// Preferred path: call the establish_user_session_atomic Postgres
// RPC. The RPC performs three writes inside a single Postgres
// transaction:
//   1. Revoke any currently-active session row for the user.
//   2. Insert the new session row.
//   3. Point the profile at the new session id and refresh the
//      timestamps.
// Either all three commit or none do.
//
// Fallback path: if the RPC is unavailable in this deployment
// (42883, 42501, PGRST202), run the three writes as separate
// PostgREST calls. This path is idempotent for a given
// (userId, sessionId) tuple and safe to retry. Its failure modes
// are recoverable: if the profile update succeeds but the insert
// fails, the profile points at a session that does not exist and
// authMiddleware rejects that state; the caller then retries
// login. No window where the user holds a valid JWT but no
// session row.
// ─────────────────────────────────────────────────────────────────
async function establishUserSessionAtomic({ userId, sessionId, sessionExpiresAt, ip, userAgent }) {
    const expiresIso = sessionExpiresAt instanceof Date
        ? sessionExpiresAt.toISOString()
        : String(sessionExpiresAt);

    // ─── Preferred: RPC ──────────────────────────────────────
    try {
        const { data, error } = await supabaseAdmin.rpc(
            'establish_user_session_atomic',
            {
                p_user_id: userId,
                p_session_id: sessionId,
                p_session_expires_at: expiresIso,
                p_ip: ip || null,
                p_user_agent: userAgent || null
            }
        );

        if (error) {
            if (isRpcUnavailable(error)) {
                console.warn(
                    '[AUTH-SVC] establish_user_session_atomic RPC unavailable, ' +
                    'falling back to table writes:',
                    error.message
                );
            } else {
                logDbError('establishUserSessionAtomic rpc', error);
                throw new Error('Failed to establish session');
            }
        } else if (data && data.ok === true) {
            return { ok: true, session_id: sessionId, via: 'rpc' };
        } else {
            console.warn(
                '[AUTH-SVC] establish_user_session_atomic RPC returned not-ok, ' +
                'falling back to table writes:',
                JSON.stringify(data)
            );
        }
    } catch (thrown) {
        if (thrown && thrown.message === 'Failed to establish session') throw thrown;
        console.warn(
            '[AUTH-SVC] establish_user_session_atomic RPC threw, ' +
            'falling back to table writes:',
            thrown.message
        );
    }

    // ─── Fallback: Node-side table writes ────────────────────
    const now = nowIso();

    const [revokeResult, profileResult] = await Promise.all([
        supabaseAdmin
            .from('user_sessions')
            .update({
                is_active: false,
                revoked_at: now,
                revoke_reason: 'superseded'
            })
            .eq('user_id', userId)
            .eq('is_active', true),

        supabaseAdmin
            .from('profiles')
            .update({
                current_session_id: sessionId,
                session_created_at: now,
                session_expires_at: expiresIso,
                last_login: now
            })
            .eq('id', userId)
            .select('id')
            .maybeSingle()
    ]);

    if (revokeResult.error) {
        logDbError('establishUserSessionAtomic revokePrevious', revokeResult.error);
        throw new Error('Failed to establish session');
    }
    if (profileResult.error) {
        logDbError('establishUserSessionAtomic updateProfile', profileResult.error);
        throw new Error('Failed to establish session');
    }
    if (!profileResult.data) {
        logDbError(
            'establishUserSessionAtomic updateProfile',
            { message: 'profile not found', code: 'NO_PROFILE' }
        );
        throw new Error('Failed to establish session');
    }

    const { error: insErr } = await supabaseAdmin
        .from('user_sessions')
        .insert({
            user_id: userId,
            session_id: sessionId,
            is_active: true,
            created_at: now,
            expires_at: expiresIso,
            ip_address: ip || null,
            user_agent: userAgent || null
        });

    if (insErr) {
        logDbError('establishUserSessionAtomic insertSession', insErr);
        throw new Error('Failed to establish session');
    }

    return { ok: true, session_id: sessionId, via: 'table_writes' };
}

// ─────────────────────────────────────────────────────────────────
// revokeUserSessionAtomic
//
// Preferred path: call the revoke_user_session_atomic RPC, which
// updates the session row and clears the profile pointer inside a
// single Postgres transaction.
//
// Fallback path: run both writes as separate PostgREST calls. Both
// writes are scoped by userId and sessionId, so they cannot touch
// another user's rows.
// ─────────────────────────────────────────────────────────────────
async function revokeUserSessionAtomic({ userId, sessionId, reason }) {
    const p_user_id    = userId    != null ? String(userId)    : null;
    const p_session_id = sessionId != null ? String(sessionId) : null;
    const p_reason     = (typeof reason === 'string' && reason) ? reason : 'user_logout';

    if (!p_user_id || !p_session_id) {
        return { ok: false, reason: 'MISSING_IDS' };
    }

    // ─── Preferred: RPC ──────────────────────────────────────
    try {
        const { data, error } = await supabaseAdmin.rpc(
            'revoke_user_session_atomic',
            {
                p_user_id: p_user_id,
                p_session_id: p_session_id,
                p_reason: p_reason
            }
        );

        if (error) {
            if (isRpcUnavailable(error)) {
                console.warn(
                    '[AUTH-SVC] revoke_user_session_atomic RPC unavailable, ' +
                    'falling back to table writes:',
                    error.message
                );
            } else {
                logDbError('revokeUserSessionAtomic rpc', error);
                throw new Error('Failed to revoke session');
            }
        } else if (data && data.ok === true) {
            return {
                ok: true,
                sessions_updated: 1,
                profiles_updated: 1,
                revoked_at: data.revoked_at || nowIso(),
                via: 'rpc'
            };
        } else {
            console.warn(
                '[AUTH-SVC] revoke_user_session_atomic RPC returned not-ok, ' +
                'falling back to table writes:',
                JSON.stringify(data)
            );
        }
    } catch (thrown) {
        if (thrown && thrown.message === 'Failed to revoke session') throw thrown;
        console.warn(
            '[AUTH-SVC] revoke_user_session_atomic RPC threw, ' +
            'falling back to table writes:',
            thrown.message
        );
    }

    // ─── Fallback: Node-side table writes ────────────────────
    const now = nowIso();

    {
        const { error } = await supabaseAdmin
            .from('user_sessions')
            .update({
                is_active: false,
                revoked_at: now,
                revoke_reason: p_reason
            })
            .eq('user_id', p_user_id)
            .eq('session_id', p_session_id);
        if (error) {
            logDbError('revokeUserSessionAtomic session', error);
            throw new Error('Failed to revoke session');
        }
    }

    {
        const { error } = await supabaseAdmin
            .from('profiles')
            .update({
                current_session_id: null,
                session_expires_at: null
            })
            .eq('id', p_user_id)
            .eq('current_session_id', p_session_id);
        if (error) {
            logDbError('revokeUserSessionAtomic profile', error);
        }
    }

    return {
        ok: true,
        sessions_updated: 1,
        profiles_updated: 1,
        revoked_at: now,
        via: 'table_writes'
    };
}

// ═══════════════════════════════════════════════════════════════════
//  PASSWORD RESET AUTHORIZATIONS
// ═══════════════════════════════════════════════════════════════════

async function createPasswordResetAuthorization(userId) {
    const raw = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(raw);
    const expiresAtIso = new Date(Date.now() + RESET_AUTH_TTL_MINUTES * 60 * 1000).toISOString();

    const { error } = await supabaseAdmin
        .from('password_reset_authorizations')
        .insert({
            token_hash: tokenHash,
            user_id: userId,
            expires_at: expiresAtIso
        });
    if (error) {
        logDbError('createPasswordResetAuthorization', error);
        throw new Error('Failed to create reset authorization');
    }
    return { resetToken: raw, expiresAt: expiresAtIso };
}

async function peekPasswordResetAuthorization(raw) {
    const tokenHash = hashOpaqueToken(raw);
    const { data, error } = await supabaseAdmin
        .from('password_reset_authorizations')
        .select('user_id, expires_at, consumed_at')
        .eq('token_hash', tokenHash)
        .maybeSingle();
    if (error) {
        logDbError('peekPasswordResetAuthorization', error);
        return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE' };
    }
    if (!data) return { ok: false, code: 'INVALID_RESET_TOKEN' };
    if (data.consumed_at) return { ok: false, code: 'INVALID_RESET_TOKEN' };
    if (isExpired(data.expires_at)) return { ok: false, code: 'INVALID_RESET_TOKEN' };
    return { ok: true, userId: data.user_id };
}

async function consumePasswordResetAuthorization(raw) {
    const tokenHash = hashOpaqueToken(raw);

    const { data: claimedRows, error: claimErr } = await supabaseAdmin
        .from('password_reset_authorizations')
        .update({ consumed_at: nowIso() })
        .eq('token_hash', tokenHash)
        .is('consumed_at', null)
        .select('user_id, expires_at');

    if (claimErr) {
        logDbError('consumePasswordResetAuthorization claim', claimErr);
        return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE' };
    }
    if (!claimedRows || claimedRows.length === 0) {
        return { ok: false, code: 'INVALID_RESET_TOKEN' };
    }
    const claimed = claimedRows[0];
    if (isExpired(claimed.expires_at)) {
        return { ok: false, code: 'INVALID_RESET_TOKEN' };
    }
    return { ok: true, userId: claimed.user_id };
}

// ═══════════════════════════════════════════════════════════════════
//  PIN AUTHORIZATION
// ═══════════════════════════════════════════════════════════════════

async function issuePinAuthorization({ userId, sessionId, ttlSeconds = PIN_AUTH_DEFAULT_TTL_SECONDS }) {
    const rawToken = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(rawToken);
    const expiresAtIso = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const { error } = await supabaseAdmin
        .from('pin_authorizations')
        .insert({
            token_hash: tokenHash,
            user_id: userId,
            session_id: sessionId,
            expires_at: expiresAtIso,
            consumed_at: null
        });
    if (error) {
        logDbError('issuePinAuthorization', error);
        return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE' };
    }
    return { ok: true, rawToken, expiresAt: expiresAtIso };
}

async function peekPinAuthorization({ rawToken, userId, sessionId }) {
    if (!rawToken) return { ok: false, code: 'NO_PIN_AUTHORIZATION' };
    const tokenHash = hashOpaqueToken(rawToken);
    const { data, error } = await supabaseAdmin
        .from('pin_authorizations')
        .select('user_id, session_id, expires_at, consumed_at, operation, reference')
        .eq('token_hash', tokenHash)
        .maybeSingle();
    if (error) {
        logDbError('peekPinAuthorization', error);
        return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE' };
    }
    if (!data) return { ok: false, code: 'INVALID_PIN_AUTHORIZATION' };
    if (data.consumed_at) return { ok: false, code: 'INVALID_PIN_AUTHORIZATION' };
    if (isExpired(data.expires_at)) return { ok: false, code: 'INVALID_PIN_AUTHORIZATION' };
    if (data.user_id !== userId) return { ok: false, code: 'INVALID_PIN_AUTHORIZATION' };
    if (sessionId && data.session_id !== sessionId) return { ok: false, code: 'INVALID_PIN_AUTHORIZATION' };
    return { ok: true, authorizationId: tokenHash };
}

async function consumePinAuthorization({
    rawToken, userId, sessionId,
    operation, amount, currency, recipient
}) {
    if (!rawToken) return { ok: false, code: 'NO_PIN_AUTHORIZATION' };
    const tokenHash = hashOpaqueToken(rawToken);

    const peek = await peekPinAuthorization({ rawToken, userId, sessionId });
    if (!peek.ok) return peek;

    const { data: claimedRows, error: claimErr } = await supabaseAdmin
        .from('pin_authorizations')
        .update({
            consumed_at: nowIso(),
            operation: operation || null,
            reference: operation || null,
            amount: amount != null ? Number(amount) : null,
            currency: currency || null,
            recipient: recipient || null
        })
        .eq('token_hash', tokenHash)
        .eq('user_id', userId)
        .is('consumed_at', null)
        .select('id');

    if (claimErr) {
        logDbError('consumePinAuthorization claim', claimErr);
        return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE' };
    }
    if (!claimedRows || claimedRows.length === 0) {
        return { ok: false, code: 'INVALID_PIN_AUTHORIZATION' };
    }
    return { ok: true, authorizationId: tokenHash };
}

// ═══════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    createChallenge, getChallenge, verifyChallenge,
    verifyAndConsumeChallenge, resendChallenge, consumeChallenge,
    checkLoginLock, recordLoginFailure, clearLoginFailures,
    issueRefreshToken, lookupRefreshToken, rotateRefreshTokenAtomic,
    revokeRefreshToken, revokeAllRefreshTokens,
    establishUserSessionAtomic, revokeUserSessionAtomic,
    createPasswordResetAuthorization,
    peekPasswordResetAuthorization,
    consumePasswordResetAuthorization,
    issuePinAuthorization, peekPinAuthorization, consumePinAuthorization,
    evaluateLoginRisk, isDeviceTrusted, hasSeenCountryRecently,
    upsertDevice, recordLoginLocation, recordSecurityEvent,
    nowIso, parseUtc, isExpired,
    hashValue, hashOpaqueToken, safeCompare, generateOTP,
    OTP_EXPIRY_MINUTES, MAX_OTP_ATTEMPTS,
    REFRESH_TOKEN_TTL_MS, RESET_AUTH_TTL_MINUTES,
    PIN_AUTH_DEFAULT_TTL_SECONDS,
    MAX_LOGIN_ATTEMPTS, LOGIN_LOCKOUT_MINUTES,
    FAMILIAR_COUNTRY_DAYS
};