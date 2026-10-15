// db/sessionService.js
// Atomic session + refresh-token operations.
// All timestamps are UTC. The database is the source of truth.

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');

// ─── CONFIG ────────────────────────────────────────────────────────
const ACCESS_TOKEN_TTL_MS  = 15 * 60 * 1000;       // 15 minutes
const REFRESH_TOKEN_TTL_MS = 15 * 60 * 1000;       // 15 minutes
const SESSION_TTL_MS       = 15 * 60 * 1000;       // 15 minutes

// ─── HELPERS ───────────────────────────────────────────────────────
function generateSessionId() {
    return crypto.randomUUID();
}

function generateRefreshToken() {
    return crypto.randomBytes(48).toString('base64url');
}

function hashRefreshToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// ─── CREATE SESSION (atomic) ───────────────────────────────────────
async function createSessionAtomic({
    userId, deviceInfo, ipAddress
}) {
    const sessionId    = generateSessionId();
    const refreshToken = generateRefreshToken();
    const refreshHash  = hashRefreshToken(refreshToken);
    const expiresAt    = new Date(Date.now() + SESSION_TTL_MS);

    const { error } = await supabaseAdmin.rpc('create_session_atomic', {
        p_user_id:      userId,
        p_session_id:   sessionId,
        p_refresh_hash: refreshHash,
        p_device_name:  deviceInfo?.device || 'Unknown Device',
        p_browser:      deviceInfo?.browser || 'Unknown',
        p_os:           deviceInfo?.os || 'Unknown',
        p_device_type:  deviceInfo?.device || 'Desktop',
        p_ip_address:   ipAddress || 'unknown',
        p_expires_at:   expiresAt.toISOString()
    });

    if (error) {
        console.error('[SESSION] create_session_atomic failed:', error);
        throw new Error('Failed to create session');
    }

    return {
        sessionId,
        refreshToken,
        refreshHash,
        expiresAt
    };
}

// ─── ROTATE REFRESH TOKEN (atomic) ─────────────────────────────────
async function rotateRefreshTokenAtomic(sessionId, oldRefreshToken) {
    const oldHash     = hashRefreshToken(oldRefreshToken);
    const newToken    = generateRefreshToken();
    const newHash     = hashRefreshToken(newToken);
    const expiresAt   = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    const { data, error } = await supabaseAdmin.rpc('rotate_refresh_token', {
        p_session_id:     sessionId,
        p_old_hash:       oldHash,
        p_new_hash:       newHash,
        p_new_expires_at: expiresAt.toISOString()
    });

    if (error) {
        console.error('[SESSION] rotate_refresh_token RPC failed:', error);
        throw new Error('Failed to rotate refresh token');
    }

    if (!data) {
        return { ok: false };
    }

    return {
        ok: true,
        refreshToken: newToken,
        expiresAt
    };
}

// ─── REVOKE SESSION (atomic) ───────────────────────────────────────
async function revokeSessionAtomic(sessionId) {
    const { error } = await supabaseAdmin.rpc('revoke_session', {
        p_session_id: sessionId
    });
    if (error) {
        console.error('[SESSION] revoke_session RPC failed:', error);
        throw new Error('Failed to revoke session');
    }
}

// ─── LOOKUP ────────────────────────────────────────────────────────
async function findSessionByRefreshHash(refreshHash) {
    const { data, error } = await supabaseAdmin
        .from('user_sessions')
        .select('*')
        .eq('refresh_token_hash', refreshHash)
        .eq('is_active', true)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

    if (error) {
        console.error('[SESSION] findSessionByRefreshHash error:', error);
        return null;
    }
    return data;
}

module.exports = {
    ACCESS_TOKEN_TTL_MS,
    REFRESH_TOKEN_TTL_MS,
    SESSION_TTL_MS,
    generateSessionId,
    generateRefreshToken,
    hashRefreshToken,
    createSessionAtomic,
    rotateRefreshTokenAtomic,
    revokeSessionAtomic,
    findSessionByRefreshHash
};