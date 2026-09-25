// middleware/adminStepUp.js
// ─────────────────────────────────────────────────────────────────
// Step-up authentication for sensitive admin operations.
//
// Reads the CURRENT SESSION's MFA verification state from
// user_sessions and enforces a maximum age.
//
// Exports:
//   requireStepUpAuth({ maxAgeSeconds })  — Express middleware
//   assertStepUp({ sessionId, userId, maxAgeSeconds }) — programmatic
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

const DEFAULT_MAX_AGE_SECONDS = 300;   // 5 minutes

function sendStepUpError(res, status, code, message, extra = {}) {
    if (res.headersSent) return;
    res.status(status).json({ success: false, error: message, code, ...extra });
}

function requireStepUpAuth(options = {}) {
    const maxAgeSeconds = Number.isFinite(options.maxAgeSeconds)
        ? Math.max(30, Math.min(3600, options.maxAgeSeconds))
        : DEFAULT_MAX_AGE_SECONDS;

    return async function adminStepUpMiddleware(req, res, next) {
        try {
            const admin = req.adminContext;
            const sessionId = admin?.sessionId || req.user?.session_id;

            if (!admin?.id) {
                return sendStepUpError(res, 401, 'AUTH_REQUIRED', 'Authentication required.');
            }
            if (!sessionId) {
                return sendStepUpError(res, 401, 'INVALID_SESSION', 'Your session is missing an identifier. Please sign in again.');
            }

            let sessionRow, sessionErr;
            try {
                const result = await supabaseAdmin
                    .from('user_sessions')
                    .select('id, mfa_verified, mfa_verified_at, is_active, revoked_at, expires_at')
                    .eq('session_id', sessionId)
                    .eq('user_id', admin.id)
                    .maybeSingle();
                sessionRow = result.data;
                sessionErr = result.error;
            } catch (dbErr) {
                console.error('[STEP-UP] session lookup failed:', dbErr.message);
                return sendStepUpError(res, 503, 'STEP_UP_UNAVAILABLE',
                    'Security verification is temporarily unavailable.');
            }
            if (sessionErr) {
                if (sessionErr.code === '42703' || /column .* does not exist/i.test(sessionErr.message || '')) {
                    console.error('[STEP-UP] user_sessions.mfa_* columns missing. Run the migration.');
                    return sendStepUpError(res, 503, 'STEP_UP_NOT_CONFIGURED',
                        'Security verification is not configured on this server.');
                }
                return sendStepUpError(res, 503, 'STEP_UP_UNAVAILABLE',
                    'Security verification is temporarily unavailable.');
            }
            if (!sessionRow) {
                return sendStepUpError(res, 401, 'SESSION_NOT_FOUND',
                    'Your session could not be found. Please sign in again.');
            }
            if (sessionRow.revoked_at || sessionRow.is_active === false) {
                return sendStepUpError(res, 401, 'SESSION_REVOKED',
                    'Your session has been revoked. Please sign in again.');
            }
            if (sessionRow.expires_at && new Date(sessionRow.expires_at) < new Date()) {
                return sendStepUpError(res, 401, 'SESSION_EXPIRED',
                    'Your session has expired. Please sign in again.');
            }
            if (!sessionRow.mfa_verified || !sessionRow.mfa_verified_at) {
                return sendStepUpError(res, 403, 'MFA_REQUIRED',
                    'Additional verification required to perform this action.',
                    { step_up_endpoint: '/api/admin/step-up/verify' });
            }
            const ageSeconds = (Date.now() - new Date(sessionRow.mfa_verified_at).getTime()) / 1000;
            if (ageSeconds > maxAgeSeconds) {
                return sendStepUpError(res, 403, 'STEP_UP_EXPIRED',
                    'Your verification has expired. Please verify again.',
                    {
                        step_up_endpoint: '/api/admin/step-up/verify',
                        max_age_seconds: maxAgeSeconds,
                        age_seconds: Math.floor(ageSeconds)
                    });
            }

            req.stepUp = {
                verified: true,
                verifiedAt: sessionRow.mfa_verified_at,
                ageSeconds: Math.floor(ageSeconds),
                maxAgeSeconds
            };
            return next();
        } catch (err) {
            console.error('[STEP-UP] unexpected:', err);
            return sendStepUpError(res, 500, 'STEP_UP_ERROR', 'Security verification failed.');
        }
    };
}

async function assertStepUp({ sessionId, userId, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS }) {
    if (!sessionId || !userId) {
        const e = new Error('Session required.'); e.status = 401; e.code = 'AUTH_REQUIRED'; throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('user_sessions')
        .select('mfa_verified, mfa_verified_at, is_active, revoked_at, expires_at')
        .eq('session_id', sessionId)
        .eq('user_id', userId)
        .maybeSingle();
    if (error || !data) {
        const e = new Error('Session not found.'); e.status = 401; e.code = 'SESSION_NOT_FOUND'; throw e;
    }
    if (!data.mfa_verified || !data.mfa_verified_at) {
        const e = new Error('MFA required.'); e.status = 403; e.code = 'MFA_REQUIRED'; throw e;
    }
    const age = (Date.now() - new Date(data.mfa_verified_at).getTime()) / 1000;
    if (age > maxAgeSeconds) {
        const e = new Error('Step-up expired.'); e.status = 403; e.code = 'STEP_UP_EXPIRED'; throw e;
    }
    return { verifiedAt: data.mfa_verified_at, ageSeconds: Math.floor(age) };
}

module.exports = { requireStepUpAuth, assertStepUp, DEFAULT_MAX_AGE_SECONDS };