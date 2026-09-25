// services/adminMfaService.js
// ─────────────────────────────────────────────────────────────────
// Admin MFA state + session stamping.
// Reads/writes ONLY the encrypted columns (mfa_secret_encrypted,
// mfa_pending_secret_encrypted). No plaintext secret anywhere.
// ─────────────────────────────────────────────────────────────────

'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 chars.');
}

const MFA_CHALLENGE_SECRET = process.env.ADMIN_MFA_CHALLENGE_SECRET
    || crypto.createHmac('sha256', JWT_SECRET).update('admin-mfa-challenge-v1').digest('hex');

const CHALLENGE_EXPIRY_SECONDS = 180;

function issueChallengeToken(adminId, sessionId) {
    return jwt.sign(
        { id: adminId, sid: sessionId, type: 'mfa_challenge' },
        MFA_CHALLENGE_SECRET,
        { expiresIn: `${CHALLENGE_EXPIRY_SECONDS}s` }
    );
}

function verifyChallengeToken(token) {
    try {
        const decoded = jwt.verify(token, MFA_CHALLENGE_SECRET);
        if (decoded.type !== 'mfa_challenge') return null;
        return decoded;
    } catch {
        return null;
    }
}

async function getAdminMfaState(adminId) {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select([
            'id', 'email', 'username', 'role',
            'two_factor_enabled',
            'mfa_secret_encrypted',
            'mfa_enabled_at',
            'mfa_recovery_codes_hash',
            'mfa_pending_secret_encrypted',
            'mfa_pending_created_at'
        ].join(', '))
        .eq('id', adminId)
        .maybeSingle();
    if (error || !data) return null;
    return {
        ...data,
        mfaEnabled: !!data.two_factor_enabled
            && !!data.mfa_secret_encrypted
            && !!data.mfa_enabled_at
    };
}

async function stampSessionVerified(sessionId, adminId, method = 'totp') {
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
        .from('user_sessions')
        .update({
            mfa_verified: true,
            mfa_verified_at: now,
            mfa_method: method
        })
        .eq('session_id', sessionId)
        .eq('user_id', adminId);
    if (error) throw error;
    return now;
}

async function clearSessionVerified(sessionId, adminId) {
    await supabaseAdmin
        .from('user_sessions')
        .update({ mfa_verified: false, mfa_verified_at: null, mfa_method: null })
        .eq('session_id', sessionId)
        .eq('user_id', adminId);
}

async function revokeAllAdminSessions(adminId, reason = 'security') {
    const now = new Date().toISOString();
    await supabaseAdmin
        .from('user_sessions')
        .update({
            is_active: false,
            is_current: false,
            revoked_at: now,
            revoked_reason: reason
        })
        .eq('user_id', adminId)
        .eq('is_admin_session', true)
        .eq('is_active', true);

    await supabaseAdmin
        .from('profiles')
        .update({
            current_session_id: null,
            session_created_at: null,
            session_expires_at: null,
            updated_at: now
        })
        .eq('id', adminId);
}

async function upsertSessionRow({ sessionId, userId, ip, userAgent, expiresAt, isAdminSession = true }) {
    const { error } = await supabaseAdmin
        .from('user_sessions')
        .upsert({
            session_id: sessionId,
            user_id: userId,
            ip_address: ip || null,
            user_agent: userAgent || null,
            is_active: true,
            is_current: true,
            is_admin_session: isAdminSession,
            created_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
            expires_at: expiresAt
        }, { onConflict: 'session_id' });
    if (error) {
        console.warn('[ADMIN MFA] session upsert failed (non-fatal):', error.message);
    }
}

module.exports = {
    issueChallengeToken,
    verifyChallengeToken,
    getAdminMfaState,
    stampSessionVerified,
    clearSessionVerified,
    revokeAllAdminSessions,
    upsertSessionRow,
    CHALLENGE_EXPIRY_SECONDS
};