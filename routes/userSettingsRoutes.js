// routes/userSettingsRoutes.js - COMPLETE FIXED VERSION
// Uses existing email templates from templates/emails/
// Proper enable/disable 2FA flow

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const axios = require('axios');
const { supabase, supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const emailService = require('../services/emailService');

// ─── Paystack Configuration ───
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ─── Rate limiting in-memory store ───
const rateLimitStore = {
    pinAttempts: new Map(),
    twofaAttempts: new Map(),
    passwordAttempts: new Map(),
    deactivateAttempts: new Map(),
    emailOtpAttempts: new Map()
};

// ─── OTP Store ───
const otpStore = new Map();

// ─── HELPERS ──────────────────────────────────────────────────────────

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           'unknown';
}

function getUserAgent(req) {
    return req.headers['user-agent'] || 'unknown';
}

function hashValue(value) {
    return crypto.createHmac('sha256', process.env.JWT_SECRET || 'milesspace-secret')
        .update(String(value))
        .digest('hex');
}

function generateOTP() {
    return crypto.randomInt(100000, 1000000).toString().padStart(6, '0');
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function parseUserAgent(ua) {
    if (!ua) return { browser: 'Unknown', os: 'Unknown', device: 'Desktop' };
    
    let browser = 'Unknown', os = 'Unknown', device = 'Desktop';
    
    if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
    else if (ua.includes('Firefox')) browser = 'Firefox';
    else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
    else if (ua.includes('Edg')) browser = 'Edge';
    else if (ua.includes('OPR')) browser = 'Opera';
    
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac OS X')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
    
    if (ua.includes('Mobile')) device = 'Mobile';
    else if (ua.includes('Tablet')) device = 'Tablet';
    
    return { browser, os, device };
}

function generateSecureOTP() {
    return crypto.randomInt(100000, 1000000).toString().padStart(6, '0');
}

// ─── HELPER FUNCTIONS ──────────────────────────────────────────────

async function logAccountActivity({ userId, type, description, ip, userAgent, location, metadata }) {
    try {
        await supabaseAdmin
            .from('account_activity')
            .insert({
                user_id: userId,
                activity_type: type,
                description: description || type,
                ip_address: ip || 'unknown',
                location: location || null,
                user_agent: userAgent || 'unknown',
                metadata: metadata || {},
                created_at: new Date().toISOString()
            });
    } catch (error) {
        console.error('Failed to log account activity:', error);
    }
}

async function createSecurityAlert({ userId, type, severity, description, ip, userAgent, location, metadata }) {
    try {
        await supabaseAdmin
            .from('security_alerts')
            .insert({
                user_id: userId,
                alert_type: type,
                severity: severity || 'medium',
                description: description || type,
                ip_address: ip || 'unknown',
                location: location || null,
                user_agent: userAgent || 'unknown',
                metadata: metadata || {},
                created_at: new Date().toISOString()
            });
    } catch (error) {
        console.error('Failed to create security alert:', error);
    }
}

function getOTPKey(userId, purpose) {
    return `otp_${userId}_${purpose}`;
}

function storeOTP(userId, purpose, otp, expiresInSeconds = 600) {
    const key = getOTPKey(userId, purpose);
    const otpHash = hashValue(otp);
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    
    otpStore.set(key, {
        otp_hash: otpHash,
        expires_at: expiresAt,
        attempts: 0,
        max_attempts: 5,
        verified: false
    });
    
    return true;
}

function verifyOTP(userId, purpose, otp) {
    const key = getOTPKey(userId, purpose);
    const data = otpStore.get(key);
    
    if (!data) return { valid: false, message: 'No OTP found. Please request a new code.' };
    if (Date.now() > data.expires_at) {
        otpStore.delete(key);
        return { valid: false, message: 'OTP has expired. Please request a new code.' };
    }
    
    data.attempts += 1;
    if (data.attempts > data.max_attempts) {
        otpStore.delete(key);
        return { valid: false, message: 'Too many attempts. Please request a new code.' };
    }
    
    const submittedHash = hashValue(otp);
    if (submittedHash !== data.otp_hash) {
        const remaining = data.max_attempts - data.attempts;
        return { valid: false, message: `Invalid OTP. ${remaining} attempts remaining.` };
    }
    
    data.verified = true;
    otpStore.set(key, data);
    
    return { valid: true, message: 'OTP verified successfully.' };
}

function clearOTP(userId, purpose) {
    const key = getOTPKey(userId, purpose);
    otpStore.delete(key);
}

// ─── GET /api/user/settings ──────────────────────────────────────

router.get('/settings', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const { data: profileCheck, error: profileCheckError } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('id', userId)
            .maybeSingle();

        if (profileCheckError || !profileCheck) {
            console.error(`❌ Profile not found for user: ${userId}`);
            return res.status(404).json({
                success: false,
                error: 'User profile not found. Please contact support.'
            });
        }

        const [
            profileResult,
            settingsResult,
            bankResult,
            walletResult,
            sessionsResult,
            activityResult,
            alertsResult
        ] = await Promise.all([
            supabaseAdmin
                .from('profiles')
                .select('id, email, username, phone, referral_code, role, is_verified, created_at, last_login, last_location, last_login_location, last_login_browser, last_login_os, last_login_device, transaction_pin_hash, status')
                .eq('id', userId)
                .single(),
            supabaseAdmin
                .from('user_settings')
                .select('*')
                .eq('user_id', userId)
                .maybeSingle(),
            supabaseAdmin
                .from('saved_bank_accounts')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false }),
            supabaseAdmin
                .from('saved_wallets')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false }),
            supabaseAdmin
                .from('user_sessions')
                .select('*')
                .eq('user_id', userId)
                .eq('is_active', true)
                .order('last_activity_at', { ascending: false }),
            supabaseAdmin
                .from('account_activity')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(50),
            supabaseAdmin
                .from('security_alerts')
                .select('*')
                .eq('user_id', userId)
                .eq('is_read', false)
                .order('created_at', { ascending: false })
        ]);

        if (profileResult.error) {
            console.error('Profile fetch error:', profileResult.error);
            return res.status(404).json({
                success: false,
                error: 'User profile not found'
            });
        }

        const profile = profileResult.data;
        const settings = settingsResult.data || {
            notification_preferences: {
                transaction_completed: true,
                deposit_received: true,
                withdrawal_completed: true,
                crypto_purchase_completed: true,
                gift_order_update: true,
                marketplace_order_update: true,
                security_alerts: true,
                milesspace_updates: true
            },
            email_2fa_enabled: false
        };

        const bankAccounts = bankResult.data || [];
        const cryptoWallets = walletResult.data || [];
        const sessions = sessionsResult.data || [];
        const activity = activityResult.data || [];
        const alerts = alertsResult.data || [];

        const maskedBankAccounts = bankAccounts.map(acc => ({
            ...acc,
            account_number: acc.account_number ? '****' + acc.account_number.slice(-4) : '****'
        }));

        const maskedCryptoWallets = cryptoWallets.map(w => ({
            ...w,
            address: w.address ? w.address.slice(0, 6) + '••••' + w.address.slice(-4) : 'N/A'
        }));

        const hasPin = !!profile.transaction_pin_hash;
        delete profile.transaction_pin_hash;

        res.json({
            success: true,
            data: {
                profile: {
                    ...profile,
                    has_transaction_pin: hasPin
                },
                settings: settings,
                bank_accounts: maskedBankAccounts,
                crypto_wallets: maskedCryptoWallets,
                sessions: sessions,
                activity: activity,
                security_alerts: alerts,
                current_session_id: req.sessionId
            }
        });

    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ success: false, error: 'Failed to load settings' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  EMAIL 2FA SETUP - STEP 1: Request OTP (uses existing template)
// ═══════════════════════════════════════════════════════════════════

router.post('/2fa/email/setup', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('email, username')
            .eq('id', userId)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const { data: settings } = await supabaseAdmin
            .from('user_settings')
            .select('email_2fa_enabled')
            .eq('user_id', userId)
            .maybeSingle();

        if (settings?.email_2fa_enabled) {
            return res.status(400).json({
                success: false,
                error: 'Email 2FA is already enabled'
            });
        }

        const otp = generateSecureOTP();
        const purpose = 'enable_2fa';
        
        storeOTP(userId, purpose, otp, 600);

        // ─── Use existing email template ──────────────────────────
        const emailResult = await emailService.send2FAEmail(
            profile.email,
            profile.username || 'User',
            otp,
            { device: 'Settings', browser: 'Web', os: 'Unknown' },
            'Account Settings',
            getClientIp(req)
        );

        if (!emailResult.success) {
            clearOTP(userId, purpose);
            console.error('❌ Failed to send 2FA setup email:', emailResult.error);
            return res.status(503).json({
                success: false,
                error: 'We could not send the verification code. Please try again.'
            });
        }

        console.log(`✅ [2FA SETUP] OTP sent to ${profile.email}`);

        res.json({
            success: true,
            message: 'Verification code sent to your email',
            data: {
                email: profile.email,
                expires_in: 600
            }
        });

    } catch (error) {
        console.error('2FA setup error:', error);
        res.status(500).json({ success: false, error: 'Failed to setup 2FA' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  EMAIL 2FA SETUP - STEP 2: Verify OTP and Enable
// ═══════════════════════════════════════════════════════════════════

router.post('/2fa/email/verify', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { otp } = req.body;

        if (!otp) {
            return res.status(400).json({
                success: false,
                error: 'Verification code is required'
            });
        }

        if (!/^\d{6}$/.test(otp)) {
            return res.status(400).json({
                success: false,
                error: 'Please enter the 6-digit verification code'
            });
        }

        const purpose = 'enable_2fa';
        const result = verifyOTP(userId, purpose, otp);

        if (!result.valid) {
            return res.status(400).json({
                success: false,
                error: result.message
            });
        }

        const { error: updateError } = await supabaseAdmin
            .from('user_settings')
            .update({
                email_2fa_enabled: true,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId);

        if (updateError) {
            console.error('❌ Failed to enable 2FA:', updateError);
            return res.status(500).json({
                success: false,
                error: 'Failed to enable 2FA'
            });
        }

        clearOTP(userId, purpose);

        await logAccountActivity({
            userId,
            type: 'twofa_enabled',
            description: 'Email 2FA enabled',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        await createSecurityAlert({
            userId,
            type: 'twofa_enabled',
            severity: 'high',
            description: 'Email 2FA was enabled on your account',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        console.log(`✅ [2FA] Enabled for user ${userId}`);

        res.json({
            success: true,
            message: 'Email 2FA enabled successfully!'
        });

    } catch (error) {
        console.error('2FA verify error:', error);
        res.status(500).json({ success: false, error: 'Failed to verify 2FA' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  DISABLE EMAIL 2FA - Step 1: Request OTP
// ═══════════════════════════════════════════════════════════════════

router.post('/2fa/email/disable/request', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const { data: settings } = await supabaseAdmin
            .from('user_settings')
            .select('email_2fa_enabled')
            .eq('user_id', userId)
            .single();

        if (!settings?.email_2fa_enabled) {
            return res.status(400).json({
                success: false,
                error: '2FA is not enabled'
            });
        }

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('email, username')
            .eq('id', userId)
            .single();

        if (!profile) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const otp = generateSecureOTP();
        storeOTP(userId, 'disable_2fa', otp, 600);

        const emailResult = await emailService.send2FAEmail(
            profile.email,
            profile.username || 'User',
            otp,
            { device: 'Settings', browser: 'Web', os: 'Unknown' },
            'Disable 2FA',
            getClientIp(req)
        );

        if (!emailResult.success) {
            clearOTP(userId, 'disable_2fa');
            return res.status(503).json({
                success: false,
                error: 'We could not send the verification code. Please try again.'
            });
        }

        res.json({
            success: true,
            message: 'Verification code sent to your email',
            data: {
                email: profile.email,
                expires_in: 600
            }
        });

    } catch (error) {
        console.error('2FA disable request error:', error);
        res.status(500).json({ success: false, error: 'Failed to request 2FA disable' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  DISABLE EMAIL 2FA - Step 2: Verify OTP and Disable
// ═══════════════════════════════════════════════════════════════════

router.post('/2fa/email/disable/verify', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { otp } = req.body;

        if (!otp) {
            return res.status(400).json({
                success: false,
                error: 'Verification code is required'
            });
        }

        if (!/^\d{6}$/.test(otp)) {
            return res.status(400).json({
                success: false,
                error: 'Please enter the 6-digit verification code'
            });
        }

        const purpose = 'disable_2fa';
        const result = verifyOTP(userId, purpose, otp);

        if (!result.valid) {
            return res.status(400).json({
                success: false,
                error: result.message
            });
        }

        const { error: updateError } = await supabaseAdmin
            .from('user_settings')
            .update({
                email_2fa_enabled: false,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId);

        if (updateError) {
            console.error('❌ Failed to disable 2FA:', updateError);
            return res.status(500).json({
                success: false,
                error: 'Failed to disable 2FA'
            });
        }

        clearOTP(userId, purpose);

        await logAccountActivity({
            userId,
            type: 'twofa_disabled',
            description: 'Email 2FA disabled',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        await createSecurityAlert({
            userId,
            type: 'twofa_disabled',
            severity: 'high',
            description: 'Email 2FA was disabled on your account',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        console.log(`✅ [2FA] Disabled for user ${userId}`);

        res.json({
            success: true,
            message: '2FA disabled successfully'
        });

    } catch (error) {
        console.error('2FA disable verify error:', error);
        res.status(500).json({ success: false, error: 'Failed to disable 2FA' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET EMAIL 2FA STATUS
// ═══════════════════════════════════════════════════════════════════

router.get('/2fa/email/status', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const { data, error } = await supabaseAdmin
            .from('user_settings')
            .select('email_2fa_enabled')
            .eq('user_id', userId)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') throw error;

        res.json({
            success: true,
            data: {
                enabled: data?.email_2fa_enabled || false
            }
        });

    } catch (error) {
        console.error('2FA status error:', error);
        res.status(500).json({ success: false, error: 'Failed to get 2FA status' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  RESEND 2FA SETUP OTP
// ═══════════════════════════════════════════════════════════════════

router.post('/2fa/email/resend', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('email, username')
            .eq('id', userId)
            .single();

        if (!profile) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const otp = generateSecureOTP();
        storeOTP(userId, 'enable_2fa', otp, 600);

        const emailResult = await emailService.send2FAEmail(
            profile.email,
            profile.username || 'User',
            otp,
            { device: 'Settings', browser: 'Web', os: 'Unknown' },
            'Account Settings',
            getClientIp(req)
        );

        if (!emailResult.success) {
            clearOTP(userId, 'enable_2fa');
            return res.status(503).json({
                success: false,
                error: 'We could not send the verification code. Please try again.'
            });
        }

        res.json({
            success: true,
            message: 'A new verification code has been sent to your email.'
        });

    } catch (error) {
        console.error('Resend 2FA OTP error:', error);
        res.status(500).json({ success: false, error: 'Failed to resend code' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  [REST OF ROUTES - Bank, Crypto, Password, PIN, etc.]
// ═══════════════════════════════════════════════════════════════════

// ─── GET BANKS ──────────────────────────────────────────────────────

router.get('/banks', authMiddleware, async (req, res) => {
    try {
        if (!PAYSTACK_SECRET_KEY) {
            return res.status(503).json({
                success: false,
                error: 'Payment service not configured'
            });
        }

        const response = await axios.get(
            'https://api.paystack.co/bank',
            {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                timeout: 10000
            }
        );

        if (!response.data.status) {
            throw new Error(response.data.message || 'Failed to fetch banks');
        }

        const banks = response.data.data.filter(b => b.country === 'Nigeria' && b.code);
        res.json({ success: true, data: banks });

    } catch (error) {
        console.error('Get banks error:', error);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Failed to fetch banks'
        });
    }
});

// ─── VERIFY BANK ACCOUNT ───────────────────────────────────────────

router.post('/bank/verify', authMiddleware, async (req, res) => {
    try {
        const { bank_code, account_number } = req.body;

        if (!bank_code || !account_number) {
            return res.status(400).json({
                success: false,
                error: 'Bank code and account number are required'
            });
        }

        if (!/^\d{10}$/.test(account_number)) {
            return res.status(400).json({
                success: false,
                error: 'Account number must be 10 digits'
            });
        }

        if (!PAYSTACK_SECRET_KEY) {
            return res.status(503).json({
                success: false,
                error: 'Payment service not configured'
            });
        }

        const response = await axios.get(
            `https://api.paystack.co/bank/resolve?bank_code=${bank_code}&account_number=${account_number}`,
            {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                timeout: 15000
            }
        );

        if (!response.data.status) {
            throw new Error(response.data.message || 'Verification failed');
        }

        res.json({
            success: true,
            data: {
                account_name: response.data.data.account_name,
                bank_code: bank_code,
                account_number: account_number
            }
        });

    } catch (error) {
        console.error('Bank verification error:', error);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Verification failed'
        });
    }
});

// ─── ADD BANK ACCOUNT ──────────────────────────────────────────────

router.post('/withdrawal/bank-accounts', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { bank_name, account_number, account_name, bank_code } = req.body;

        if (!bank_name || !account_number || !account_name) {
            return res.status(400).json({ success: false, error: 'All bank account fields are required' });
        }

        if (!/^\d{10}$/.test(account_number)) {
            return res.status(400).json({ success: false, error: 'Account number must be 10 digits' });
        }

        if (PAYSTACK_SECRET_KEY) {
            try {
                const verifyResponse = await axios.get(
                    `https://api.paystack.co/bank/resolve?bank_code=${bank_code}&account_number=${account_number}`,
                    {
                        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                        timeout: 15000
                    }
                );

                if (!verifyResponse.data.status) {
                    return res.status(400).json({
                        success: false,
                        error: 'Bank account verification failed. Please check the account details.'
                    });
                }

                const verifiedName = verifyResponse.data.data.account_name;
                if (account_name.toLowerCase() !== verifiedName.toLowerCase()) {
                    return res.status(400).json({
                        success: false,
                        error: `Account name mismatch. Expected: "${verifiedName}"`
                    });
                }
            } catch (verifyError) {
                console.error('Verification error:', verifyError);
                return res.status(400).json({
                    success: false,
                    error: 'Unable to verify bank account. Please check the details and try again.'
                });
            }
        }

        const { data: existing, error: existError } = await supabaseAdmin
            .from('saved_bank_accounts')
            .select('id')
            .eq('user_id', userId)
            .eq('account_number', account_number)
            .maybeSingle();

        if (existError && existError.code !== 'PGRST116') throw existError;

        if (existing) {
            return res.status(400).json({ success: false, error: 'This bank account is already saved' });
        }

        const { data, error } = await supabaseAdmin
            .from('saved_bank_accounts')
            .insert({
                user_id: userId,
                bank_name: escapeHtml(bank_name),
                bank_code: bank_code || null,
                account_number,
                account_name: escapeHtml(account_name),
                verified: true,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) throw error;

        await logAccountActivity({
            userId,
            type: 'bank_account_added',
            description: `Bank account added: ${bank_name} (****${account_number.slice(-4)})`,
            ip: getClientIp(req),
            userAgent: getUserAgent(req),
            metadata: { bank_name, account_number: account_number.slice(-4) }
        });

        await createSecurityAlert({
            userId,
            type: 'bank_account_added',
            severity: 'medium',
            description: `A new bank account was added: ${bank_name} ending in ${account_number.slice(-4)}`,
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        data.account_number = '****' + data.account_number.slice(-4);

        res.json({
            success: true,
            message: 'Bank account added successfully',
            data
        });

    } catch (error) {
        console.error('Add bank account error:', error);
        res.status(500).json({ success: false, error: 'Failed to add bank account' });
    }
});

// ─── DELETE BANK ACCOUNT ───────────────────────────────────────────

router.delete('/withdrawal/bank-accounts/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { id } = req.params;

        const { data: account, error: getError } = await supabaseAdmin
            .from('saved_bank_accounts')
            .select('bank_name, account_number')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (getError || !account) {
            return res.status(404).json({ success: false, error: 'Bank account not found' });
        }

        const { error } = await supabaseAdmin
            .from('saved_bank_accounts')
            .delete()
            .eq('id', id)
            .eq('user_id', userId);

        if (error) throw error;

        await logAccountActivity({
            userId,
            type: 'bank_account_removed',
            description: `Bank account removed: ${account.bank_name} (****${account.account_number.slice(-4)})`,
            ip: getClientIp(req),
            userAgent: getUserAgent(req),
            metadata: { bank_name: account.bank_name, account_number: account.account_number.slice(-4) }
        });

        await createSecurityAlert({
            userId,
            type: 'bank_account_removed',
            severity: 'medium',
            description: `A bank account was removed: ${account.bank_name} ending in ${account.account_number.slice(-4)}`,
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        res.json({
            success: true,
            message: 'Bank account removed successfully'
        });

    } catch (error) {
        console.error('Remove bank account error:', error);
        res.status(500).json({ success: false, error: 'Failed to remove bank account' });
    }
});

// ─── GET BANK ACCOUNTS ─────────────────────────────────────────────

router.get('/withdrawal/bank-accounts', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const { data, error } = await supabaseAdmin
            .from('saved_bank_accounts')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const masked = (data || []).map(acc => ({
            ...acc,
            account_number: acc.account_number ? '****' + acc.account_number.slice(-4) : '****'
        }));

        res.json({ success: true, data: masked });

    } catch (error) {
        console.error('Get bank accounts error:', error);
        res.status(500).json({ success: false, error: 'Failed to load bank accounts' });
    }
});

// ─── GET CRYPTO WALLETS ────────────────────────────────────────────

router.get('/withdrawal/crypto-wallets', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const { data, error } = await supabaseAdmin
            .from('saved_wallets')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const masked = (data || []).map(w => ({
            ...w,
            address: w.address ? w.address.slice(0, 6) + '••••' + w.address.slice(-4) : 'N/A'
        }));

        res.json({ success: true, data: masked });

    } catch (error) {
        console.error('Get crypto wallets error:', error);
        res.status(500).json({ success: false, error: 'Failed to load crypto wallets' });
    }
});

// ─── ADD CRYPTO WALLET ─────────────────────────────────────────────

router.post('/withdrawal/crypto-wallets', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { coin, address, network, label } = req.body;

        if (!coin || !address || !network) {
            return res.status(400).json({ success: false, error: 'Coin, address, and network are required' });
        }

        if (address.length < 10) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        const { data: existing, error: existError } = await supabaseAdmin
            .from('saved_wallets')
            .select('id')
            .eq('user_id', userId)
            .eq('address', address)
            .maybeSingle();

        if (existError && existError.code !== 'PGRST116') throw existError;

        if (existing) {
            return res.status(400).json({ success: false, error: 'This wallet is already saved' });
        }

        const { data, error } = await supabaseAdmin
            .from('saved_wallets')
            .insert({
                user_id: userId,
                coin: coin.toUpperCase(),
                address: escapeHtml(address),
                network: escapeHtml(network),
                label: label ? escapeHtml(label) : null,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) throw error;

        await logAccountActivity({
            userId,
            type: 'crypto_wallet_added',
            description: `Crypto wallet added: ${coin} on ${network}`,
            ip: getClientIp(req),
            userAgent: getUserAgent(req),
            metadata: { coin, network }
        });

        await createSecurityAlert({
            userId,
            type: 'crypto_wallet_added',
            severity: 'medium',
            description: `A new ${coin} wallet was added on ${network}`,
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        data.address = data.address.slice(0, 6) + '••••' + data.address.slice(-4);

        res.json({
            success: true,
            message: 'Crypto wallet added successfully',
            data
        });

    } catch (error) {
        console.error('Add crypto wallet error:', error);
        res.status(500).json({ success: false, error: 'Failed to add crypto wallet' });
    }
});

// ─── DELETE CRYPTO WALLET ──────────────────────────────────────────

router.delete('/withdrawal/crypto-wallets/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { id } = req.params;

        const { data: wallet, error: getError } = await supabaseAdmin
            .from('saved_wallets')
            .select('coin, network')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (getError || !wallet) {
            return res.status(404).json({ success: false, error: 'Wallet not found' });
        }

        const { error } = await supabaseAdmin
            .from('saved_wallets')
            .delete()
            .eq('id', id)
            .eq('user_id', userId);

        if (error) throw error;

        await logAccountActivity({
            userId,
            type: 'crypto_wallet_removed',
            description: `Crypto wallet removed: ${wallet.coin} on ${wallet.network}`,
            ip: getClientIp(req),
            userAgent: getUserAgent(req),
            metadata: { coin: wallet.coin, network: wallet.network }
        });

        await createSecurityAlert({
            userId,
            type: 'crypto_wallet_removed',
            severity: 'medium',
            description: `A ${wallet.coin} wallet was removed from ${wallet.network}`,
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        res.json({
            success: true,
            message: 'Crypto wallet removed successfully'
        });

    } catch (error) {
        console.error('Remove crypto wallet error:', error);
        res.status(500).json({ success: false, error: 'Failed to remove crypto wallet' });
    }
});

// ─── CHANGE EMAIL - STEP 1 ─────────────────────────────────────────

router.post('/email/change/request', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { new_email } = req.body;

        if (!new_email) {
            return res.status(400).json({ success: false, error: 'New email is required' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(new_email)) {
            return res.status(400).json({ success: false, error: 'Invalid email format' });
        }

        const { data: user, error: userError } = await supabaseAdmin
            .from('profiles')
            .select('email')
            .eq('id', userId)
            .single();

        if (userError) throw userError;

        if (user.email.toLowerCase() === new_email.toLowerCase()) {
            return res.status(400).json({ success: false, error: 'New email must be different from current email' });
        }

        const { data: existing, error: existError } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .ilike('email', new_email)
            .neq('id', userId)
            .maybeSingle();

        if (existError && existError.code !== 'PGRST116') throw existError;

        if (existing) {
            return res.status(400).json({ success: false, error: 'Email is already in use' });
        }

        const otp = generateOTP();
        const otpHash = hashValue(otp);
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        const { data: request, error: requestError } = await supabaseAdmin
            .from('email_change_requests')
            .insert({
                user_id: userId,
                new_email: new_email.toLowerCase(),
                otp_hash: otpHash,
                otp_expires_at: expiresAt.toISOString(),
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (requestError) throw requestError;

        const emailResult = await emailService.sendVerificationEmail(
            user.email,
            'Email Change Verification',
            otp
        );

        if (!emailResult.success) {
            await supabaseAdmin.from('email_change_requests').delete().eq('id', request.id);
            console.error('Email send failed:', emailResult.error);
            return res.status(503).json({
                success: false,
                error: 'We could not send the verification email. Please try again.'
            });
        }

        console.log(`📧 Email change OTP sent to ${user.email}`);

        await logAccountActivity({
            userId,
            type: 'email_change_requested',
            description: 'Email change requested',
            ip: getClientIp(req),
            userAgent: getUserAgent(req),
            metadata: { new_email: new_email.toLowerCase() }
        });

        res.json({
            success: true,
            message: 'Verification code sent to your email',
            data: { request_id: request.id }
        });

    } catch (error) {
        console.error('Email change request error:', error);
        res.status(500).json({ success: false, error: 'Failed to process request' });
    }
});

// ─── CHANGE EMAIL - STEP 2 ─────────────────────────────────────────

router.post('/email/change/verify', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { request_id, otp } = req.body;

        if (!request_id || !otp) {
            return res.status(400).json({ success: false, error: 'Request ID and OTP are required' });
        }

        const { data: request, error: requestError } = await supabaseAdmin
            .from('email_change_requests')
            .select('*')
            .eq('id', request_id)
            .eq('user_id', userId)
            .single();

        if (requestError || !request) {
            return res.status(404).json({ success: false, error: 'Invalid request' });
        }

        if (request.verified) {
            return res.status(400).json({ success: false, error: 'This request has already been verified' });
        }

        if (request.attempts >= 5) {
            return res.status(429).json({ success: false, error: 'Too many attempts. Please request a new code.' });
        }

        if (new Date(request.otp_expires_at) < new Date()) {
            return res.status(400).json({ success: false, error: 'OTP has expired. Please request a new one.' });
        }

        const otpHash = hashValue(otp);
        if (otpHash !== request.otp_hash) {
            await supabaseAdmin
                .from('email_change_requests')
                .update({ attempts: request.attempts + 1 })
                .eq('id', request_id);

            const remaining = 5 - (request.attempts + 1);
            return res.status(400).json({
                success: false,
                error: `Invalid OTP. ${remaining} attempts remaining.`
            });
        }

        const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(
            userId,
            { email: request.new_email }
        );

        if (authUpdateError) {
            console.error('Auth email update failed:', authUpdateError);
            return res.status(500).json({
                success: false,
                error: 'Failed to update email. Please try again.'
            });
        }

        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({
                email: request.new_email,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        if (updateError) {
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('email')
                .eq('id', userId)
                .single();

            if (profile) {
                await supabaseAdmin.auth.admin.updateUserById(userId, { email: profile.email });
            }
            throw updateError;
        }

        await supabaseAdmin
            .from('email_change_requests')
            .update({ verified: true })
            .eq('id', request_id);

        await logAccountActivity({
            userId,
            type: 'email_changed',
            description: 'Email address changed successfully',
            ip: getClientIp(req),
            userAgent: getUserAgent(req),
            metadata: { new_email: request.new_email }
        });

        await createSecurityAlert({
            userId,
            type: 'email_changed',
            severity: 'high',
            description: 'Your email address was changed',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        await supabaseAdmin
            .from('user_sessions')
            .update({ is_active: false })
            .eq('user_id', userId);

        await supabaseAdmin
            .from('profiles')
            .update({
                current_session_id: null,
                session_created_at: null,
                session_expires_at: null
            })
            .eq('id', userId);

        res.json({
            success: true,
            message: 'Email updated successfully. Please sign in again with your new email.'
        });

    } catch (error) {
        console.error('Email change verify error:', error);
        res.status(500).json({ success: false, error: 'Failed to verify email change' });
    }
});

// ─── UPDATE PHONE NUMBER ───────────────────────────────────────────

router.patch('/profile/phone', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({ success: false, error: 'Phone number is required' });
        }

        const phoneRegex = /^\+?[0-9\s\-()]{8,20}$/;
        if (!phoneRegex.test(phone)) {
            return res.status(400).json({ success: false, error: 'Invalid phone number format' });
        }

        const { data: existing, error: existError } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('phone', phone)
            .neq('id', userId)
            .maybeSingle();

        if (existError && existError.code !== 'PGRST116') throw existError;

        if (existing) {
            return res.status(400).json({ success: false, error: 'Phone number already in use' });
        }

        const { data: oldProfile } = await supabaseAdmin
            .from('profiles')
            .select('phone')
            .eq('id', userId)
            .single();

        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({
                phone: escapeHtml(phone),
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        if (updateError) throw updateError;

        await logAccountActivity({
            userId,
            type: 'phone_changed',
            description: 'Phone number updated',
            ip: getClientIp(req),
            userAgent: getUserAgent(req),
            metadata: { old_phone: oldProfile?.phone, new_phone: phone }
        });

        res.json({
            success: true,
            message: 'Phone number updated successfully'
        });

    } catch (error) {
        console.error('Phone update error:', error);
        res.status(500).json({ success: false, error: 'Failed to update phone number' });
    }
});

// ─── CHANGE PASSWORD ───────────────────────────────────────────────

router.post('/password/change', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { current_password, new_password, confirm_password } = req.body;

        if (!current_password || !new_password || !confirm_password) {
            return res.status(400).json({ success: false, error: 'All password fields are required' });
        }

        if (new_password !== confirm_password) {
            return res.status(400).json({ success: false, error: 'New passwords do not match' });
        }

        if (new_password.length < 8) {
            return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
        }

        const attemptKey = `password_${userId}`;
        const attempts = rateLimitStore.passwordAttempts.get(attemptKey) || { count: 0, lockedUntil: 0 };
        
        if (attempts.lockedUntil > Date.now()) {
            const remaining = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
            return res.status(429).json({
                success: false,
                error: `Too many attempts. Please wait ${remaining} minutes.`
            });
        }

        const { data: user, error: userError } = await supabaseAdmin
            .from('profiles')
            .select('email')
            .eq('id', userId)
            .single();

        if (userError) throw userError;

        const { error: authError } = await supabase.auth.signInWithPassword({
            email: user.email,
            password: current_password
        });

        if (authError) {
            attempts.count += 1;
            if (attempts.count >= 5) {
                attempts.lockedUntil = Date.now() + 30 * 60 * 1000;
            }
            rateLimitStore.passwordAttempts.set(attemptKey, attempts);
            return res.status(401).json({ success: false, error: 'Current password is incorrect' });
        }

        rateLimitStore.passwordAttempts.delete(attemptKey);

        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
            userId,
            { password: new_password }
        );

        if (updateError) {
            console.error('Password update error:', updateError);
            return res.status(500).json({ success: false, error: 'Failed to update password' });
        }

        await logAccountActivity({
            userId,
            type: 'password_changed',
            description: 'Password changed successfully',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        await createSecurityAlert({
            userId,
            type: 'password_changed',
            severity: 'high',
            description: 'Your password was changed',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        await supabaseAdmin
            .from('user_sessions')
            .update({ is_active: false })
            .eq('user_id', userId)
            .neq('session_id', req.sessionId);

        res.json({
            success: true,
            message: 'Password changed successfully'
        });

    } catch (error) {
        console.error('Password change error:', error);
        res.status(500).json({ success: false, error: 'Failed to change password' });
    }
});

// ─── CHANGE TRANSACTION PIN ────────────────────────────────────────

router.post('/transaction-pin/change', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { current_pin, new_pin, confirm_pin } = req.body;

        if (!current_pin || !new_pin || !confirm_pin) {
            return res.status(400).json({ success: false, error: 'All PIN fields are required' });
        }

        if (new_pin !== confirm_pin) {
            return res.status(400).json({ success: false, error: 'New PINs do not match' });
        }

        if (!/^\d{4}$/.test(new_pin)) {
            return res.status(400).json({ success: false, error: 'PIN must be 4 digits' });
        }

        const commonPins = ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321'];
        if (commonPins.includes(new_pin)) {
            return res.status(400).json({ success: false, error: 'PIN is too common. Please choose a different one.' });
        }

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('transaction_pin_hash, transaction_pin_locked_until, transaction_pin_attempts')
            .eq('id', userId)
            .single();

        if (profileError) throw profileError;

        if (profile.transaction_pin_locked_until && new Date(profile.transaction_pin_locked_until) > new Date()) {
            return res.status(429).json({
                success: false,
                error: `PIN is locked. Try again after ${new Date(profile.transaction_pin_locked_until).toLocaleTimeString()}`
            });
        }

        if (!profile.transaction_pin_hash) {
            const saltRounds = 10;
            const newPinHash = await bcrypt.hash(new_pin, saltRounds);

            await supabaseAdmin
                .from('profiles')
                .update({
                    transaction_pin_hash: newPinHash,
                    transaction_pin_set_at: new Date().toISOString(),
                    transaction_pin_attempts: 0,
                    transaction_pin_locked_until: null
                })
                .eq('id', userId);

            await logAccountActivity({
                userId,
                type: 'transaction_pin_set',
                description: 'Transaction PIN set',
                ip: getClientIp(req),
                userAgent: getUserAgent(req)
            });

            return res.json({
                success: true,
                message: 'Transaction PIN set successfully'
            });
        }

        const isValid = await bcrypt.compare(current_pin, profile.transaction_pin_hash);
        if (!isValid) {
            const attempts = (profile.transaction_pin_attempts || 0) + 1;
            let updateData = { transaction_pin_attempts: attempts };

            if (attempts >= 5) {
                const lockedUntil = new Date(Date.now() + 60 * 60 * 1000);
                updateData.transaction_pin_locked_until = lockedUntil.toISOString();
            }

            await supabaseAdmin
                .from('profiles')
                .update(updateData)
                .eq('id', userId);

            const remaining = 5 - attempts;
            if (remaining <= 0) {
                return res.status(429).json({
                    success: false,
                    error: 'Too many failed attempts. PIN locked for 1 hour.'
                });
            }

            return res.status(401).json({
                success: false,
                error: `Incorrect PIN. ${remaining} attempts remaining.`
            });
        }

        const saltRounds = 10;
        const newPinHash = await bcrypt.hash(new_pin, saltRounds);

        await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_hash: newPinHash,
                transaction_pin_set_at: new Date().toISOString(),
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null
            })
            .eq('id', userId);

        await logAccountActivity({
            userId,
            type: 'transaction_pin_changed',
            description: 'Transaction PIN changed',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        await createSecurityAlert({
            userId,
            type: 'transaction_pin_changed',
            severity: 'high',
            description: 'Your transaction PIN was changed',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        await supabaseAdmin
            .from('transaction_pin_history')
            .insert({
                user_id: userId,
                action: 'changed',
                ip_address: getClientIp(req),
                user_agent: getUserAgent(req),
                created_at: new Date().toISOString()
            });

        res.json({
            success: true,
            message: 'Transaction PIN changed successfully'
        });

    } catch (error) {
        console.error('PIN change error:', error);
        res.status(500).json({ success: false, error: 'Failed to change PIN' });
    }
});

// ─── FORGOT PIN - Request OTP ──────────────────────────────────────

router.post('/transaction-pin/reset/request', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const { data: user, error: userError } = await supabaseAdmin
            .from('profiles')
            .select('email, username')
            .eq('id', userId)
            .single();

        if (userError) throw userError;

        const otp = generateOTP();
        const otpHash = hashValue(otp);
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        const { error: insertError } = await supabaseAdmin
            .from('pin_reset_requests')
            .insert({
                user_id: userId,
                otp_hash: otpHash,
                expires_at: expiresAt.toISOString(),
                attempts: 0,
                verified: false,
                created_at: new Date().toISOString()
            });

        if (insertError) throw insertError;

        const emailResult = await emailService.sendPasswordResetOTP(
            user.email,
            user.username || 'User',
            otp
        );

        if (!emailResult.success) {
            await supabaseAdmin.from('pin_reset_requests').delete().eq('user_id', userId);
            console.error('PIN reset email failed:', emailResult.error);
            return res.status(503).json({
                success: false,
                error: 'We could not send the verification email. Please try again.'
            });
        }

        console.log(`📧 PIN reset OTP sent to ${user.email}`);

        await logAccountActivity({
            userId,
            type: 'transaction_pin_reset_requested',
            description: 'Transaction PIN reset requested',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        res.json({
            success: true,
            message: 'Verification code sent to your email'
        });

    } catch (error) {
        console.error('PIN reset request error:', error);
        res.status(500).json({ success: false, error: 'Failed to request PIN reset' });
    }
});

// ─── FORGOT PIN - Verify OTP and Reset ─────────────────────────────

router.post('/transaction-pin/reset', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { otp, new_pin, confirm_pin } = req.body;

        if (!otp || !new_pin || !confirm_pin) {
            return res.status(400).json({
                success: false,
                error: 'OTP, new PIN, and confirm PIN are required'
            });
        }

        if (new_pin !== confirm_pin) {
            return res.status(400).json({ success: false, error: 'New PINs do not match' });
        }

        if (!/^\d{4}$/.test(new_pin)) {
            return res.status(400).json({ success: false, error: 'PIN must be 4 digits' });
        }

        const commonPins = ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321'];
        if (commonPins.includes(new_pin)) {
            return res.status(400).json({ success: false, error: 'PIN is too common. Please choose a different one.' });
        }

        const { data: resetRequest, error: requestError } = await supabaseAdmin
            .from('pin_reset_requests')
            .select('*')
            .eq('user_id', userId)
            .eq('verified', false)
            .gt('expires_at', new Date().toISOString())
            .single();

        if (requestError || !resetRequest) {
            return res.status(400).json({
                success: false,
                error: 'No valid PIN reset request found. Please request a new reset code.'
            });
        }

        const otpHash = hashValue(otp);
        if (otpHash !== resetRequest.otp_hash) {
            await supabaseAdmin
                .from('pin_reset_requests')
                .update({ attempts: resetRequest.attempts + 1 })
                .eq('id', resetRequest.id);

            const remaining = 5 - (resetRequest.attempts + 1);
            if (remaining <= 0) {
                await supabaseAdmin
                    .from('pin_reset_requests')
                    .update({ verified: false })
                    .eq('id', resetRequest.id);
                return res.status(429).json({
                    success: false,
                    error: 'Too many attempts. Please request a new reset code.'
                });
            }

            return res.status(400).json({
                success: false,
                error: `Invalid OTP. ${remaining} attempts remaining.`
            });
        }

        await supabaseAdmin
            .from('pin_reset_requests')
            .update({ verified: true })
            .eq('id', resetRequest.id);

        const saltRounds = 10;
        const newPinHash = await bcrypt.hash(new_pin, saltRounds);

        await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_hash: newPinHash,
                transaction_pin_set_at: new Date().toISOString(),
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null
            })
            .eq('id', userId);

        await logAccountActivity({
            userId,
            type: 'transaction_pin_reset',
            description: 'Transaction PIN reset via OTP verification',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        await createSecurityAlert({
            userId,
            type: 'transaction_pin_reset',
            severity: 'high',
            description: 'Your transaction PIN was reset',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        res.json({
            success: true,
            message: 'Transaction PIN reset successfully'
        });

    } catch (error) {
        console.error('PIN reset error:', error);
        res.status(500).json({ success: false, error: 'Failed to reset PIN' });
    }
});

// ─── GET NOTIFICATIONS ─────────────────────────────────────────────

router.get('/notifications', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const { data: settings, error } = await supabaseAdmin
            .from('user_settings')
            .select('notification_preferences')
            .eq('user_id', userId)
            .single();

        if (error && error.code !== 'PGRST116') throw error;

        const defaultPrefs = {
            transaction_completed: true,
            deposit_received: true,
            withdrawal_completed: true,
            crypto_purchase_completed: true,
            gift_order_update: true,
            marketplace_order_update: true,
            security_alerts: true,
            milesspace_updates: true
        };

        const preferences = settings?.notification_preferences || defaultPrefs;

        res.json({
            success: true,
            data: preferences
        });

    } catch (error) {
        console.error('Get notifications error:', error);
        res.status(500).json({ success: false, error: 'Failed to load notification preferences' });
    }
});

// ─── UPDATE NOTIFICATIONS ──────────────────────────────────────────

router.patch('/notifications', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const preferences = req.body;

        const validKeys = [
            'transaction_completed',
            'deposit_received',
            'withdrawal_completed',
            'crypto_purchase_completed',
            'gift_order_update',
            'marketplace_order_update',
            'security_alerts',
            'milesspace_updates'
        ];

        if (preferences.security_alerts === false) {
            return res.status(400).json({
                success: false,
                error: 'Security alerts cannot be disabled'
            });
        }

        if (preferences.milesspace_updates === false) {
            return res.status(400).json({
                success: false,
                error: 'MilesSpace updates cannot be disabled'
            });
        }

        const filtered = {};
        for (const key of validKeys) {
            if (key in preferences) {
                filtered[key] = preferences[key];
            }
        }

        const { data: existing, error: getError } = await supabaseAdmin
            .from('user_settings')
            .select('notification_preferences')
            .eq('user_id', userId)
            .single();

        if (getError && getError.code !== 'PGRST116') throw getError;

        const currentPrefs = existing?.notification_preferences || {};
        const updatedPrefs = { ...currentPrefs, ...filtered };

        const { error: upsertError } = await supabaseAdmin
            .from('user_settings')
            .upsert({
                user_id: userId,
                notification_preferences: updatedPrefs,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });

        if (upsertError) throw upsertError;

        await logAccountActivity({
            userId,
            type: 'notification_preferences_updated',
            description: 'Notification preferences updated',
            ip: getClientIp(req),
            userAgent: getUserAgent(req),
            metadata: { updated: Object.keys(filtered) }
        });

        res.json({
            success: true,
            message: 'Notification preferences updated',
            data: updatedPrefs
        });

    } catch (error) {
        console.error('Update notifications error:', error);
        res.status(500).json({ success: false, error: 'Failed to update notification preferences' });
    }
});

// ─── GET SESSIONS ──────────────────────────────────────────────────

router.get('/sessions', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const currentSessionId = req.sessionId;

        const { data, error } = await supabaseAdmin
            .from('user_sessions')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .order('last_activity_at', { ascending: false });

        if (error) throw error;

        const sessions = (data || []).map(s => {
            const parsed = parseUserAgent(s.browser || s.user_agent || 'Unknown');
            return {
                ...s,
                is_current: s.session_id === currentSessionId,
                ip_display: s.ip_address ? s.ip_address.split('.').slice(0, 3).join('.') + '.*' : 'N/A',
                browser_display: parsed.browser,
                os_display: parsed.os,
                device_display: parsed.device
            };
        });

        res.json({ success: true, data: sessions });

    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({ success: false, error: 'Failed to load sessions' });
    }
});

// ─── REVOKE SESSION ────────────────────────────────────────────────

router.delete('/sessions/:sessionId', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { sessionId } = req.params;

        if (sessionId === req.sessionId) {
            return res.status(400).json({
                success: false,
                error: 'Cannot revoke current session. Use logout instead.'
            });
        }

        const { data: session, error: getError } = await supabaseAdmin
            .from('user_sessions')
            .select('session_id, browser, ip_address')
            .eq('user_id', userId)
            .eq('session_id', sessionId)
            .eq('is_active', true)
            .single();

        if (getError || !session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        const { error } = await supabaseAdmin
            .from('user_sessions')
            .update({
                is_active: false,
                is_current: false,
                revoked_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('session_id', sessionId);

        if (error) throw error;

        await logAccountActivity({
            userId,
            type: 'session_revoked',
            description: 'Active session revoked',
            ip: getClientIp(req),
            userAgent: getUserAgent(req),
            metadata: { revoked_session: session }
        });

        res.json({
            success: true,
            message: 'Session revoked successfully'
        });

    } catch (error) {
        console.error('Revoke session error:', error);
        res.status(500).json({ success: false, error: 'Failed to revoke session' });
    }
});

// ─── LOGOUT ALL OTHER SESSIONS ─────────────────────────────────────

router.post('/sessions/logout-all', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const currentSessionId = req.sessionId;

        await supabaseAdmin
            .from('user_sessions')
            .update({
                is_active: false,
                is_current: false,
                revoked_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .neq('session_id', currentSessionId);

        await logAccountActivity({
            userId,
            type: 'all_sessions_revoked',
            description: 'All other sessions revoked',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        await createSecurityAlert({
            userId,
            type: 'all_sessions_revoked',
            severity: 'medium',
            description: 'All other active sessions were revoked',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        res.json({
            success: true,
            message: 'All other sessions revoked successfully'
        });

    } catch (error) {
        console.error('Logout all sessions error:', error);
        res.status(500).json({ success: false, error: 'Failed to revoke sessions' });
    }
});

// ─── GET ACTIVITY ──────────────────────────────────────────────────

router.get('/activity', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { limit = 50, offset = 0 } = req.query;

        const { data, error, count } = await supabaseAdmin
            .from('account_activity')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (error) throw error;

        const enriched = (data || []).map(a => ({
            ...a,
            parsed_device: a.user_agent ? parseUserAgent(a.user_agent) : null
        }));

        res.json({
            success: true,
            data: enriched,
            count: count || 0,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

    } catch (error) {
        console.error('Get activity error:', error);
        res.status(500).json({ success: false, error: 'Failed to load activity' });
    }
});

// ─── GET SECURITY ALERTS ───────────────────────────────────────────

router.get('/security-alerts', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { limit = 20, offset = 0, unread_only = false } = req.query;

        let query = supabaseAdmin
            .from('security_alerts')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (unread_only === 'true') {
            query = query.eq('is_read', false);
        }

        const { data, error, count } = await query
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (error) throw error;

        res.json({
            success: true,
            data: data || [],
            count: count || 0,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

    } catch (error) {
        console.error('Get security alerts error:', error);
        res.status(500).json({ success: false, error: 'Failed to load security alerts' });
    }
});

// ─── MARK SECURITY ALERT AS READ ──────────────────────────────────

router.patch('/security-alerts/:id/read', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('security_alerts')
            .update({
                is_read: true,
                acknowledged_at: new Date().toISOString()
            })
            .eq('id', id)
            .eq('user_id', userId);

        if (error) throw error;

        res.json({
            success: true,
            message: 'Alert marked as read'
        });

    } catch (error) {
        console.error('Mark alert read error:', error);
        res.status(500).json({ success: false, error: 'Failed to mark alert as read' });
    }
});

// ─── GET ACCOUNT STATUS ────────────────────────────────────────────

router.get('/account-status', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select('status, is_verified, deleted_at')
            .eq('id', userId)
            .single();

        if (error) throw error;

        res.json({
            success: true,
            data: {
                status: data.status || 'active',
                is_verified: data.is_verified || false,
                is_deleted: !!data.deleted_at
            }
        });

    } catch (error) {
        console.error('Get account status error:', error);
        res.status(500).json({ success: false, error: 'Failed to get account status' });
    }
});

// ─── DEACTIVATE ACCOUNT ────────────────────────────────────────────

router.post('/deactivate', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { password, confirm } = req.body;

        if (!password || confirm !== 'DEACTIVATE') {
            return res.status(400).json({
                success: false,
                error: 'Password and confirmation are required. Type "DEACTIVATE" to confirm.'
            });
        }

        const attemptKey = `deactivate_${userId}`;
        const attempts = rateLimitStore.deactivateAttempts.get(attemptKey) || { count: 0, lockedUntil: 0 };
        
        if (attempts.lockedUntil > Date.now()) {
            const remaining = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
            return res.status(429).json({
                success: false,
                error: `Too many attempts. Please wait ${remaining} minutes.`
            });
        }

        const { data: user, error: userError } = await supabaseAdmin
            .from('profiles')
            .select('email')
            .eq('id', userId)
            .single();

        if (userError) throw userError;

        const { error: authError } = await supabase.auth.signInWithPassword({
            email: user.email,
            password: password
        });

        if (authError) {
            attempts.count += 1;
            if (attempts.count >= 3) {
                attempts.lockedUntil = Date.now() + 60 * 60 * 1000;
            }
            rateLimitStore.deactivateAttempts.set(attemptKey, attempts);
            return res.status(401).json({ success: false, error: 'Incorrect password' });
        }

        rateLimitStore.deactivateAttempts.delete(attemptKey);

        await supabaseAdmin
            .from('profiles')
            .update({
                status: 'deactivated',
                updated_at: new Date().toISOString(),
                deleted_at: new Date().toISOString()
            })
            .eq('id', userId);

        await supabaseAdmin
            .from('user_sessions')
            .update({ is_active: false })
            .eq('user_id', userId);

        await supabaseAdmin
            .from('profiles')
            .update({
                current_session_id: null,
                session_created_at: null,
                session_expires_at: null
            })
            .eq('id', userId);

        await logAccountActivity({
            userId,
            type: 'account_deactivated',
            description: 'Account deactivated',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        await createSecurityAlert({
            userId,
            type: 'account_deactivated',
            severity: 'high',
            description: 'Your account was deactivated',
            ip: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        res.json({
            success: true,
            message: 'Account deactivated successfully'
        });

    } catch (error) {
        console.error('Deactivate account error:', error);
        res.status(500).json({ success: false, error: 'Failed to deactivate account' });
    }
});

module.exports = router;