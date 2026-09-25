// routes/admin/stepUpRoutes.js
'use strict';
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const totp = require('../../services/totpService');
const mfaSvc = require('../../services/adminMfaService');
const { adminAuth, recordAdminAction } = require('../../middleware/adminAuth');

router.post('/step-up/verify', adminAuth, async (req, res) => {
    try {
        const ctx = req.adminContext;
        const { code, recovery_code } = req.body || {};
        if (!code && !recovery_code) {
            return res.status(422).json({ success: false, code: 'MISSING_CODE', error: 'Enter your 6-digit code or a recovery code.' });
        }
        const sessionId = ctx.sessionId;
        if (!sessionId) return res.status(400).json({ success: false, code: 'INVALID_SESSION', error: 'Session identifier missing.' });

        const state = await mfaSvc.getAdminMfaState(ctx.id);
        if (!state || !state.mfaEnabled) {
            return res.status(409).json({ success: false, code: 'MFA_NOT_ENABLED', error: 'MFA is not enabled for this admin.' });
        }

        let verified = false, usedRecovery = false;
        if (recovery_code) {
            const result = totp.verifyRecoveryCode(state.mfa_recovery_codes_hash || [], recovery_code);
            if (result.ok) {
                verified = true; usedRecovery = true;
                await supabaseAdmin
                    .from('profiles')
                    .update({ mfa_recovery_codes_hash: result.remainingHashes, updated_at: new Date().toISOString() })
                    .eq('id', ctx.id);
            }
        } else {
            verified = totp.verifyCode(state.mfa_secret, code);
        }
        if (!verified) return res.status(401).json({ success: false, code: 'INVALID_MFA_CODE', error: 'Incorrect code. Please try again.' });

        const verifiedAt = await mfaSvc.stampSessionVerified(sessionId, ctx.id, usedRecovery ? 'recovery_code' : 'totp');

        await recordAdminAction({
            adminId: ctx.id, adminEmail: ctx.email,
            action: usedRecovery ? 'STEP_UP_RECOVERY_USED' : 'STEP_UP_VERIFIED',
            targetType: 'session', targetId: sessionId,
            reason: usedRecovery ? 'Recovery code used' : 'TOTP verified',
            req
        });

        return res.json({ success: true, verified_at: verifiedAt, method: usedRecovery ? 'recovery_code' : 'totp' });
    } catch (err) {
        console.error('[STEP-UP] verify error:', err.message);
        return res.status(500).json({ success: false, code: 'STEP_UP_ERROR', error: 'Verification failed.' });
    }
});

module.exports = router;