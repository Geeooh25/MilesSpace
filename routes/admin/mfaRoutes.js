// routes/admin/mfaRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin MFA management. All secrets are encrypted at rest.
//
// Setup tokens (type: 'admin_setup') are accepted by /mfa/enroll
// and /mfa/verify-enrollment only. They are identified by their
// `type` claim and NEVER hit the admin_sessions table.
//
// On successful first-time enrollment the response includes a full
// admin session so the client does not need to re-enter credentials.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const totp = require('../../services/totpService');
const mfaSvc = require('../../services/adminMfaService');
const { adminAuth, setupAuth, recordAdminAction } = require('../../middleware/adminAuth');
const emailSvc = require('../../services/emailService');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 chars.');
}

// ─── Hybrid auth for enrollment / verify-enrollment ─────────────
// Accepts either a full admin token OR a setup token.
// Delegates to the appropriate middleware so that:
//   • admin_setup tokens → setupAuth (no session table, no perms)
//   • admin tokens       → adminAuth (full session checks)
function enrollmentAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json({ success: false, code: 'NO_TOKEN', error: 'Authentication required.' });
    }
    const token = authHeader.slice(7);
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET, {
            algorithms: ['HS256'],
            issuer: 'milespace-admin',
            audience: 'milespace-admin-api'
        });
    } catch (err) {
        res.setHeader('Cache-Control', 'no-store');
        const expired = err.name === 'TokenExpiredError';
        return res.status(401).json({
            success: false,
            code: expired ? 'SESSION_EXPIRED' : 'INVALID_TOKEN',
            error: expired ? 'Your session has expired. Please sign in again.' : 'Invalid or expired token.'
        });
    }

    if (decoded.type === 'admin_setup') {
        return setupAuth(req, res, next);
    }
    if (decoded.type === 'admin') {
        return adminAuth(req, res, next);
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(403).json({ success: false, code: 'INVALID_TOKEN_TYPE', error: 'Invalid token type.' });
}

function noStore(res) {
    try { res.setHeader('Cache-Control', 'no-store'); } catch (_) {}
}

function notify(profile, action, detail, req) {
    if (!profile?.email) return;
    Promise.resolve().then(() => {
        emailSvc.sendAdminSecurityAlert({
            email: profile.email,
            username: profile.username || profile.email.split('@')[0],
            action,
            targetType: 'admin', targetId: profile.id,
            detail,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        }).catch(err => console.warn('[MFA ALERT] send failed:', err.message));
    });
}

// ─── GET /api/admin/mfa/status ──────────────────────────────────
router.get('/mfa/status', adminAuth, async (req, res) => {
    noStore(res);
    try {
        const state = await mfaSvc.getAdminMfaState(req.adminContext.id);
        if (!state) {
            return res.status(404).json({ success: false, code: 'ADMIN_NOT_FOUND', error: 'Admin account not found.' });
        }
        const codes = Array.isArray(state.mfa_recovery_codes_hash) ? state.mfa_recovery_codes_hash : [];
        return res.json({
            success: true,
            mfa: {
                enabled: state.mfaEnabled,
                enabled_at: state.mfa_enabled_at || null,
                recovery_codes_remaining: codes.length,
                pending: !!state.mfa_pending_secret_encrypted
            }
        });
    } catch (err) {
        console.error('[ADMIN MFA] status error:', err.message);
        return res.status(500).json({ success: false, code: 'MFA_STATUS_ERROR', error: 'Failed to read MFA status.' });
    }
});

// ─── GET /api/admin/mfa/diagnose ────────────────────────────────
router.get('/mfa/diagnose', adminAuth, async (req, res) => {
    noStore(res);
    try {
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select([
                'id',
                'two_factor_enabled',
                'mfa_secret_encrypted',
                'mfa_enabled_at',
                'mfa_pending_secret_encrypted',
                'mfa_pending_created_at',
                'mfa_recovery_codes_hash'
            ].join(', '))
            .eq('id', req.adminContext.id)
            .maybeSingle();
        if (error || !data) {
            return res.status(404).json({ success: false, code: 'ADMIN_NOT_FOUND', error: 'Not found.' });
        }
        const codes = Array.isArray(data.mfa_recovery_codes_hash) ? data.mfa_recovery_codes_hash : [];
        const healthy = !!data.two_factor_enabled
            && data.mfa_secret_encrypted != null
            && data.mfa_enabled_at != null
            && codes.length > 0;
        return res.json({
            success: true,
            diagnose: {
                two_factor_enabled:       !!data.two_factor_enabled,
                has_encrypted_secret:     data.mfa_secret_encrypted != null,
                has_enabled_at:           data.mfa_enabled_at != null,
                has_pending_encrypted:    data.mfa_pending_secret_encrypted != null,
                pending_age_seconds:      data.mfa_pending_created_at
                    ? Math.floor((Date.now() - new Date(data.mfa_pending_created_at).getTime()) / 1000)
                    : null,
                recovery_codes_remaining: codes.length,
                healthy
            }
        });
    } catch (err) {
        console.error('[ADMIN MFA] diagnose error:', err.message);
        return res.status(500).json({ success: false, code: 'DIAGNOSE_ERROR', error: 'Failed to diagnose MFA.' });
    }
});

// ─── POST /api/admin/mfa/enroll ─────────────────────────────────
router.post('/mfa/enroll', enrollmentAuth, async (req, res) => {
    noStore(res);
    try {
        const ctx = req.adminContext;
        const state = await mfaSvc.getAdminMfaState(ctx.id);
        if (!state) {
            return res.status(404).json({ success: false, code: 'ADMIN_NOT_FOUND', error: 'Admin account not found.' });
        }
        if (state.mfaEnabled) {
            return res.status(409).json({
                success: false, code: 'MFA_ALREADY_ENABLED',
                error: 'Two-factor authentication is already enabled. Disable it first to re-enroll.'
            });
        }

        // Reuse a fresh pending enrollment (< 15 min old).
        if (state.mfa_pending_secret_encrypted && state.mfa_pending_created_at) {
            const ageSec = (Date.now() - new Date(state.mfa_pending_created_at).getTime()) / 1000;
            if (ageSec < 15 * 60) {
                let pendingPlain;
                try {
                    pendingPlain = require('../../services/mfaCrypto').decrypt(state.mfa_pending_secret_encrypted);
                } catch (e) {
                    console.warn('[ADMIN MFA] pending decrypt failed, regenerating:', e.message);
                    pendingPlain = null;
                }
                if (pendingPlain) {
                    const otpauthUrl = totp.authenticator.keyuri(
                        ctx.email || ctx.id, totp.ISSUER, pendingPlain
                    );
                    const qrDataUrl = await totp.generateQrDataUrl(otpauthUrl);
                    return res.json({
                        success: true,
                        reused: true,
                        enrollment: {
                            secret: pendingPlain,
                            otpauth_url: otpauthUrl,
                            qr_data_url: qrDataUrl,
                            issuer: totp.ISSUER
                        }
                    });
                }
            }
        }

        // Fresh enrollment.
        const { secret, secretEncrypted, otpauthUrl } = totp.generateEnrollment(ctx.id, ctx.email);
        const qrDataUrl = await totp.generateQrDataUrl(otpauthUrl);

        const { error } = await supabaseAdmin
            .from('profiles')
            .update({
                mfa_pending_secret_encrypted: secretEncrypted,
                mfa_pending_created_at: new Date().toISOString(),
                mfa_secret_encrypted: null,
                mfa_enabled_at: null,
                mfa_recovery_codes_hash: null,
                two_factor_enabled: false,
                updated_at: new Date().toISOString()
            })
            .eq('id', ctx.id);

        if (error) {
            console.error('[ADMIN MFA] enroll write failed:', error.message);
            return res.status(500).json({
                success: false, code: 'ENROLL_WRITE_FAILED',
                error: 'Failed to start enrollment. Please try again.'
            });
        }

        return res.json({
            success: true,
            enrollment: {
                secret,
                otpauth_url: otpauthUrl,
                qr_data_url: qrDataUrl,
                issuer: totp.ISSUER
            }
        });
    } catch (err) {
        console.error('[ADMIN MFA] enroll error:', err.message);
        return res.status(500).json({ success: false, code: 'ENROLL_ERROR', error: 'Failed to start enrollment.' });
    }
});

// ─── POST /api/admin/mfa/verify-enrollment ──────────────────────
router.post('/mfa/verify-enrollment', enrollmentAuth, async (req, res) => {
    noStore(res);
    try {
        const ctx = req.adminContext;
        const code = String(req.body?.code || '').trim();

        if (!/^\d{6}$/.test(code)) {
            return res.status(422).json({
                success: false, code: 'INVALID_CODE_SHAPE',
                error: 'Enter the 6-digit code from your authenticator app.'
            });
        }

        const state = await mfaSvc.getAdminMfaState(ctx.id);
        if (!state || !state.mfa_pending_secret_encrypted) {
            return res.status(409).json({
                success: false, code: 'NO_PENDING_ENROLLMENT',
                error: 'No enrollment in progress. Click Start enrollment first.'
            });
        }

        const pendingAt = state.mfa_pending_created_at
            ? new Date(state.mfa_pending_created_at).getTime()
            : 0;
        if (Date.now() - pendingAt > 15 * 60 * 1000) {
            await supabaseAdmin
                .from('profiles')
                .update({
                    mfa_pending_secret_encrypted: null,
                    mfa_pending_created_at: null
                })
                .eq('id', ctx.id);
            return res.status(409).json({
                success: false, code: 'ENROLLMENT_EXPIRED',
                error: 'Enrollment window expired. Click Start enrollment again.'
            });
        }

        const ok = totp.verifyCode({
            secretEncrypted: state.mfa_pending_secret_encrypted,
            code
        });
        if (!ok) {
            return res.status(401).json({
                success: false, code: 'INVALID_CODE',
                error: 'Incorrect code. Check your authenticator app and try again.'
            });
        }

        const { plaintext, hashed } = totp.generateRecoveryCodes();
        const now = new Date().toISOString();

        const { error } = await supabaseAdmin
            .from('profiles')
            .update({
                mfa_secret_encrypted: state.mfa_pending_secret_encrypted,
                mfa_enabled_at: now,
                mfa_recovery_codes_hash: hashed,
                two_factor_enabled: true,
                mfa_pending_secret_encrypted: null,
                mfa_pending_created_at: null,
                updated_at: now
            })
            .eq('id', ctx.id);

        if (error) {
            console.error('[ADMIN MFA] activate write failed:', error.message);
            return res.status(500).json({
                success: false, code: 'ACTIVATE_WRITE_FAILED',
                error: 'Failed to enable MFA.'
            });
        }

        // ── Upgrade setup session to a full admin session ─────
        let finalSessionData = null;
        if (ctx.authType === 'admin_setup') {
            const { createAdminSession } = require('../admin');
            const session = await createAdminSession({
                profile: {
                    id: ctx.id,
                    email: ctx.email,
                    username: ctx.username,
                    role: ctx.role,
                    status: 'active'
                },
                role: ctx.role,
                ip: req.ip,
                userAgent: req.headers['user-agent']
            });
            finalSessionData = {
                token: session.accessToken,
                refreshToken: session.refreshToken,
                expiresIn: '1h',
                sessionId: session.sessionId,
                user: {
                    id: ctx.id,
                    email: ctx.email,
                    username: ctx.username,
                    role: ctx.role,
                    isSuperAdmin: ctx.isSuperAdmin
                }
            };
        }

        await recordAdminAction({
            adminId: ctx.id, adminEmail: ctx.email,
            action: 'MFA_ENABLED',
            targetType: 'admin', targetId: ctx.id,
            reason: 'Admin enabled MFA',
            req
        });
        notify({ id: ctx.id, email: ctx.email, username: ctx.username }, 'MFA_ENABLED', {}, req);

        return res.json({
            success: true,
            message: 'Two-factor authentication is now enabled.',
            recovery_codes: plaintext,
            session: finalSessionData
        });
    } catch (err) {
        console.error('[ADMIN MFA] verify-enrollment error:', err.message);
        return res.status(500).json({ success: false, code: 'VERIFY_ENROLLMENT_ERROR', error: 'Verification failed.' });
    }
});

// ─── POST /api/admin/mfa/disable ────────────────────────────────
router.post('/mfa/disable', adminAuth, async (req, res) => {
    noStore(res);
    try {
        const ctx = req.adminContext;
        const code = String(req.body?.code || '').trim();
        const reason = String(req.body?.reason || '').trim();

        if (!/^\d{6}$/.test(code)) {
            return res.status(422).json({
                success: false, code: 'INVALID_CODE_SHAPE',
                error: 'Enter your current 6-digit code.'
            });
        }
        if (reason.length < 4) {
            return res.status(422).json({
                success: false, code: 'REASON_REQUIRED',
                error: 'A reason is required (min 4 chars).'
            });
        }

        const state = await mfaSvc.getAdminMfaState(ctx.id);
        if (!state || !state.mfaEnabled) {
            return res.status(409).json({
                success: false, code: 'MFA_NOT_ENABLED',
                error: 'Two-factor authentication is not enabled.'
            });
        }

        const ok = totp.verifyCode({ secretEncrypted: state.mfa_secret_encrypted, code });
        if (!ok) {
            return res.status(401).json({ success: false, code: 'INVALID_CODE', error: 'Incorrect code.' });
        }

        const { error } = await supabaseAdmin
            .from('profiles')
            .update({
                mfa_secret_encrypted: null,
                mfa_enabled_at: null,
                mfa_recovery_codes_hash: null,
                two_factor_enabled: false,
                mfa_pending_secret_encrypted: null,
                mfa_pending_created_at: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', ctx.id);

        if (error) {
            return res.status(500).json({ success: false, code: 'DISABLE_WRITE_FAILED', error: 'Failed to disable MFA.' });
        }

        await recordAdminAction({
            adminId: ctx.id, adminEmail: ctx.email,
            action: 'MFA_DISABLED',
            targetType: 'admin', targetId: ctx.id,
            reason, req
        });
        notify({ id: ctx.id, email: ctx.email, username: ctx.username }, 'MFA_DISABLED', { reason }, req);

        return res.json({ success: true, message: 'MFA disabled.' });
    } catch (err) {
        console.error('[ADMIN MFA] disable error:', err.message);
        return res.status(500).json({ success: false, code: 'DISABLE_ERROR', error: 'Failed to disable MFA.' });
    }
});

// ─── POST /api/admin/mfa/recovery-codes/regenerate ──────────────
router.post('/mfa/recovery-codes/regenerate', adminAuth, async (req, res) => {
    noStore(res);
    try {
        const ctx = req.adminContext;
        const code = String(req.body?.code || '').trim();
        const reason = String(req.body?.reason || '').trim() || 'Recovery codes regenerated';

        const state = await mfaSvc.getAdminMfaState(ctx.id);
        if (!state || !state.mfaEnabled) {
            return res.status(409).json({ success: false, code: 'MFA_NOT_ENABLED', error: 'Enable MFA first.' });
        }
        if (!/^\d{6}$/.test(code) || !totp.verifyCode({ secretEncrypted: state.mfa_secret_encrypted, code })) {
            return res.status(401).json({ success: false, code: 'INVALID_CODE', error: 'Incorrect code.' });
        }

        const { plaintext, hashed } = totp.generateRecoveryCodes();
        const { error } = await supabaseAdmin
            .from('profiles')
            .update({
                mfa_recovery_codes_hash: hashed,
                updated_at: new Date().toISOString()
            })
            .eq('id', ctx.id);

        if (error) {
            return res.status(500).json({ success: false, code: 'RECOVERY_WRITE_FAILED', error: 'Failed to regenerate recovery codes.' });
        }

        await recordAdminAction({
            adminId: ctx.id, adminEmail: ctx.email,
            action: 'RECOVERY_CODES_REGENERATED',
            targetType: 'admin', targetId: ctx.id,
            reason, req
        });
        notify({ id: ctx.id, email: ctx.email, username: ctx.username }, 'RECOVERY_CODES_REGENERATED', { reason }, req);

        return res.json({ success: true, recovery_codes: plaintext });
    } catch (err) {
        console.error('[ADMIN MFA] regenerate error:', err.message);
        return res.status(500).json({ success: false, code: 'REGENERATE_ERROR', error: 'Failed to regenerate recovery codes.' });
    }
});

// ─── POST /api/admin/mfa/step-up ────────────────────────────────
router.post('/mfa/step-up', adminAuth, async (req, res) => {
    noStore(res);
    try {
        const ctx = req.adminContext;
        const code = String(req.body?.code || '').trim();
        const scope = String(req.body?.scope || 'default').slice(0, 60);

        if (!/^\d{6}$/.test(code)) {
            return res.status(422).json({
                success: false, code: 'INVALID_CODE_SHAPE',
                error: 'Enter the 6-digit code.'
            });
        }

        const state = await mfaSvc.getAdminMfaState(ctx.id);
        if (!state || !state.mfaEnabled || !state.mfa_secret_encrypted) {
            return res.json({ success: true, step_up: true, mfa_enabled: false });
        }

        const ok = totp.verifyCode({ secretEncrypted: state.mfa_secret_encrypted, code });
        if (!ok) {
            return res.status(401).json({
                success: false, code: 'INVALID_CODE',
                error: 'Incorrect code.'
            });
        }

        const { markStepUp } = require('../../middleware/stepUp');
        markStepUp(ctx.id, scope);

        return res.json({ success: true, step_up: true, ttl_seconds: 300, scope });
    } catch (err) {
        console.error('[ADMIN MFA] step-up error:', err.message);
        return res.status(500).json({ success: false, code: 'STEP_UP_ERROR', error: 'Step-up failed.' });
    }
});

module.exports = router;