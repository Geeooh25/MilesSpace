// ─── routes/wallet/withdrawals.js ───
// Complete Withdrawal Routes with PIN System
// PIN verification is separate from authentication
// INVALID_PIN returns 400, NOT 401 - prevents logout

const express = require('express');
const router = express.Router();
const axios = require('axios');
const bcrypt = require('bcrypt');
const emailService = require('../../services/emailService');
const { supabaseAdmin } = require('../../db/supabase');
const { authMiddleware } = require('../../middleware/auth');

// ─── CONFIGURATION ───
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SALT_ROUNDS = 10;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_DURATION = 30 * 60 * 1000; // 30 minutes

// ─── HELPERS ───

/**
 * Verify bank account with Paystack
 */
async function verifyBankAccount(bankCode, accountNumber) {
    try {
        const response = await axios.get(
            `https://api.paystack.co/bank/resolve?bank_code=${bankCode}&account_number=${accountNumber}`,
            {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                timeout: 10000
            }
        );
        
        if (!response.data.status) {
            throw new Error(response.data.message || 'Verification failed');
        }
        
        return {
            success: true,
            account_name: response.data.data.account_name,
            bank_code: bankCode,
            account_number: accountNumber
        };
    } catch (error) {
        return {
            success: false,
            error: error.response?.data?.message || error.message || 'Verification failed'
        };
    }
}

/**
 * Get list of banks from Paystack
 */
async function getBanksList() {
    try {
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
        
        return response.data.data;
    } catch (error) {
        console.error('Get banks error:', error);
        return [];
    }
}

/**
 * Create notification for user
 */
async function createNotification(userId, title, message, type = 'info', link = null) {
    try {
        const iconMap = {
            'withdrawal_completed': '✅',
            'withdrawal_failed': '❌',
            'withdrawal_pending': '⏳',
            'pin_set': '🔐',
            'pin_changed': '🔐',
            'info': '📌'
        };
        
        const { data, error } = await supabaseAdmin
            .from('notifications')
            .insert({
                user_id: userId,
                title: title,
                message: message,
                type: type,
                icon: iconMap[type] || '📌',
                link: link,
                is_read: false,
                created_at: new Date().toISOString()
            })
            .select()
            .single();
            
        if (error) console.error('Notification error:', error);
        return data;
    } catch (e) {
        console.error('Create notification error:', e);
        return null;
    }
}

/**
 * Get user profile with PIN fields
 */
async function getUserProfile(userId) {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select(
            'id, email, username, wallet_ngn, wallet_usd, ' +
            'transaction_pin_hash, transaction_pin_attempts, ' +
            'transaction_pin_locked_until, transaction_pin_set_at'
        )
        .eq('id', userId)
        .single();
    
    if (error) throw new Error('User not found');
    return data;
}

/**
 * Check if PIN is locked
 */
function isPinLocked(profile) {
    if (!profile.transaction_pin_locked_until) return false;
    return new Date(profile.transaction_pin_locked_until) > new Date();
}

/**
 * Get remaining lock time in minutes
 */
function getRemainingLockTime(profile) {
    if (!profile.transaction_pin_locked_until) return 0;
    const lockUntil = new Date(profile.transaction_pin_locked_until);
    const now = new Date();
    if (lockUntil <= now) return 0;
    return Math.ceil((lockUntil - now) / 60000);
}

// ═══════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════

// ─── GET /api/wallet/withdraw/banks ───
router.get('/banks', authMiddleware, async (req, res) => {
    try {
        const banks = await getBanksList();
        res.json({ 
            success: true, 
            banks: banks.map(b => ({
                code: b.code,
                name: b.name,
                slug: b.slug || b.name.toLowerCase().replace(/\s/g, '-')
            }))
        });
    } catch (error) {
        console.error('Get banks error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch banks. Please try again.' 
        });
    }
});

// ─── POST /api/wallet/withdraw/verify-account ───
router.post('/verify-account', authMiddleware, async (req, res) => {
    try {
        const { bank_code, account_number } = req.body;
        
        if (!bank_code || !account_number) {
            return res.status(400).json({ 
                success: false, 
                error: 'Bank code and account number are required' 
            });
        }
        
        if (account_number.length < 10 || account_number.length > 12) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid account number length' 
            });
        }
        
        const result = await verifyBankAccount(bank_code, account_number);
        
        if (!result.success) {
            return res.status(400).json({ 
                success: false, 
                error: result.error || 'Account verification failed' 
            });
        }
        
        res.json({
            success: true,
            data: {
                account_name: result.account_name,
                bank_code: result.bank_code,
                account_number: result.account_number
            }
        });
    } catch (error) {
        console.error('Verify account error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Account verification failed. Please try again.' 
        });
    }
});

// ─── GET /api/wallet/withdraw/pin-status ───
router.get('/pin-status', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const profile = await getUserProfile(userId);
        
        const locked = isPinLocked(profile);
        const remaining = getRemainingLockTime(profile);
        
        res.json({
            success: true,
            data: {
                has_pin: !!profile.transaction_pin_hash,
                set_at: profile.transaction_pin_set_at || null,
                attempts_used: profile.transaction_pin_attempts || 0,
                max_attempts: MAX_PIN_ATTEMPTS,
                is_locked: locked,
                remaining_lock_minutes: remaining,
                attempts_remaining: Math.max(0, MAX_PIN_ATTEMPTS - (profile.transaction_pin_attempts || 0))
            }
        });
    } catch (error) {
        console.error('PIN status error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to check PIN status' 
        });
    }
});

// ─── POST /api/wallet/withdraw/verify-pin ───
router.post('/verify-pin', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { pin } = req.body;
        
        // ─── Validate PIN format ───
        if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
            return res.status(400).json({
                success: false,
                error: 'PIN must be exactly 4 digits',
                code: 'INVALID_FORMAT'
            });
        }
        
        // ─── Get user profile ───
        const profile = await getUserProfile(userId);
        
        // ─── Check if PIN exists ───
        if (!profile.transaction_pin_hash) {
            return res.status(400).json({
                success: false,
                error: 'PIN not set. Please set a PIN first.',
                code: 'PIN_NOT_SET',
                pinNotSet: true
            });
        }
        
        // ─── Check if PIN is locked ───
        if (isPinLocked(profile)) {
            const remaining = getRemainingLockTime(profile);
            return res.status(403).json({
                success: false,
                error: `PIN is locked. Please wait ${remaining} minute${remaining > 1 ? 's' : ''}.`,
                code: 'PIN_LOCKED',
                locked_until: profile.transaction_pin_locked_until,
                remaining_minutes: remaining
            });
        }
        
        // ─── Verify PIN ───
        const isValid = await bcrypt.compare(pin, profile.transaction_pin_hash);
        
        if (!isValid) {
            // ─── Increment attempts ───
            const attempts = (profile.transaction_pin_attempts || 0) + 1;
            const updates = { transaction_pin_attempts: attempts };
            
            // ─── Check if max attempts reached ───
            if (attempts >= MAX_PIN_ATTEMPTS) {
                const lockUntil = new Date(Date.now() + PIN_LOCK_DURATION);
                updates.transaction_pin_locked_until = lockUntil.toISOString();
                updates.transaction_pin_attempts = 0;
                
                await supabaseAdmin
                    .from('profiles')
                    .update(updates)
                    .eq('id', userId);
                
                await createNotification(
                    userId,
                    'PIN Locked 🔒',
                    'Your transaction PIN has been locked due to too many failed attempts. Please wait 30 minutes.',
                    'info',
                    '/wallet'
                );
                
                return res.status(403).json({
                    success: false,
                    error: 'Too many failed attempts. PIN locked for 30 minutes.',
                    code: 'PIN_LOCKED',
                    locked_until: lockUntil.toISOString(),
                    remaining_minutes: 30
                });
            }
            
            // ─── Update attempts ───
            await supabaseAdmin
                .from('profiles')
                .update(updates)
                .eq('id', userId);
            
            const remaining = MAX_PIN_ATTEMPTS - attempts;
            
            // ─── IMPORTANT: Return 400, NOT 401 ───
            // 401 would trigger logout in session.js
            return res.status(400).json({
                success: false,
                error: `Invalid PIN. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`,
                code: 'INVALID_PIN',
                attempts_remaining: remaining
            });
        }
        
        // ─── PIN is valid ───
        await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null
            })
            .eq('id', userId);
        
        res.json({
            success: true,
            message: 'PIN verified successfully'
        });
    } catch (error) {
        console.error('Verify PIN error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'PIN verification failed. Please try again.' 
        });
    }
});

// ─── POST /api/wallet/withdraw/set-pin ───
router.post('/set-pin', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { pin } = req.body;
        
        // ─── Validate PIN format ───
        if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
            return res.status(400).json({
                success: false,
                error: 'PIN must be exactly 4 digits',
                code: 'INVALID_FORMAT'
            });
        }
        
        // ─── Check if PIN already exists ───
        const profile = await getUserProfile(userId);
        
        if (profile.transaction_pin_hash) {
            return res.status(400).json({
                success: false,
                error: 'PIN already set. Use change-pin to update it.',
                code: 'PIN_ALREADY_SET'
            });
        }
        
        // ─── Hash PIN ───
        const salt = await bcrypt.genSalt(SALT_ROUNDS);
        const pinHash = await bcrypt.hash(pin, salt);
        
        // ─── Save PIN ───
        await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_hash: pinHash,
                transaction_pin_set_at: new Date().toISOString(),
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);
        
        // ─── Notify user ───
        await createNotification(
            userId,
            'PIN Set 🔐',
            'Your transaction PIN has been set successfully.',
            'pin_set',
            '/wallet'
        );
        
        res.json({
            success: true,
            message: 'PIN set successfully'
        });
    } catch (error) {
        console.error('Set PIN error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to set PIN. Please try again.' 
        });
    }
});

// ─── POST /api/wallet/withdraw/change-pin ───
router.post('/change-pin', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { current_pin, new_pin } = req.body;
        
        // ─── Validate inputs ───
        if (!current_pin || !new_pin) {
            return res.status(400).json({
                success: false,
                error: 'Current PIN and new PIN are required'
            });
        }
        
        if (!/^\d{4}$/.test(new_pin)) {
            return res.status(400).json({
                success: false,
                error: 'New PIN must be exactly 4 digits',
                code: 'INVALID_FORMAT'
            });
        }
        
        // ─── Get user profile ───
        const profile = await getUserProfile(userId);
        
        if (!profile.transaction_pin_hash) {
            return res.status(400).json({
                success: false,
                error: 'No PIN set. Use set-pin endpoint instead.',
                code: 'PIN_NOT_SET'
            });
        }
        
        // ─── Verify current PIN ───
        const isValid = await bcrypt.compare(current_pin, profile.transaction_pin_hash);
        
        if (!isValid) {
            return res.status(400).json({
                success: false,
                error: 'Current PIN is incorrect',
                code: 'INVALID_PIN'
            });
        }
        
        // ─── Hash new PIN ───
        const salt = await bcrypt.genSalt(SALT_ROUNDS);
        const newPinHash = await bcrypt.hash(new_pin, salt);
        
        // ─── Save new PIN ───
        await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_hash: newPinHash,
                transaction_pin_set_at: new Date().toISOString(),
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);
        
        // ─── Notify user ───
        await createNotification(
            userId,
            'PIN Changed 🔐',
            'Your transaction PIN has been changed successfully.',
            'pin_changed',
            '/wallet'
        );
        
        res.json({
            success: true,
            message: 'PIN changed successfully'
        });
    } catch (error) {
        console.error('Change PIN error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to change PIN. Please try again.' 
        });
    }
});

// ─── POST /api/wallet/withdraw/request ───
router.post('/request', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            amount,
            currency = 'NGN',
            bank_code,
            account_number,
            account_name,
            crypto_address,
            crypto_network,
            crypto_currency,
            notes,
            transaction_pin
        } = req.body;
        
        // ─── Validate amount ───
        if (!amount || amount <= 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid amount' 
            });
        }
        
        // ─── Get user profile ───
        const profile = await getUserProfile(userId);
        
        // ─── Check balance ───
        const isUSD = currency === 'USD';
        const balance = isUSD ? profile.wallet_usd : profile.wallet_ngn;
        
        let fee = 0;
        if (isUSD) {
            fee = amount * 0.02; // 2% fee for USD
        } else {
            fee = 50; // ₦50 flat fee for NGN
        }
        const totalAmount = amount + fee;
        
        if (balance < totalAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. Available: ${isUSD ? '$' : '₦'}${balance.toFixed(2)}`
            });
        }
        
        // ─── Validate withdrawal method ───
        let provider, destination;
        
        if (isUSD) {
            // ─── USD Withdrawal (Crypto) ───
            if (!crypto_address) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Crypto address required for USD withdrawals' 
                });
            }
            provider = 'nowpayments';
            destination = {
                crypto_address: crypto_address,
                crypto_network: crypto_network || 'TRC20',
                crypto_currency: crypto_currency || 'USDT'
            };
        } else {
            // ─── NGN Withdrawal (Bank) ───
            if (!bank_code || !account_number) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Bank details required for NGN withdrawals' 
                });
            }
            
            provider = 'paystack';
            
            let verifiedName = account_name;
            if (!verifiedName) {
                const verifyResult = await verifyBankAccount(bank_code, account_number);
                if (!verifyResult.success) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Could not verify account: ' + verifyResult.error 
                    });
                }
                verifiedName = verifyResult.account_name;
            }
            
            destination = {
                bank_code: bank_code,
                account_number: account_number,
                account_name: verifiedName
            };
        }
        
        // ─── Verify PIN ───
        if (!transaction_pin) {
            return res.status(400).json({
                success: false,
                error: 'Transaction PIN required',
                pinRequired: true,
                code: 'PIN_REQUIRED'
            });
        }
        
        // ─── Check PIN exists ───
        if (!profile.transaction_pin_hash) {
            return res.status(400).json({
                success: false,
                error: 'Transaction PIN not set. Please set a PIN first.',
                code: 'PIN_NOT_SET',
                pinNotSet: true
            });
        }
        
        // ─── Check PIN lock ───
        if (isPinLocked(profile)) {
            const remaining = getRemainingLockTime(profile);
            return res.status(403).json({
                success: false,
                error: `PIN is locked. Please wait ${remaining} minute${remaining > 1 ? 's' : ''}.`,
                code: 'PIN_LOCKED'
            });
        }
        
        // ─── Verify PIN ───
        const isValid = await bcrypt.compare(transaction_pin, profile.transaction_pin_hash);
        
        if (!isValid) {
            const attempts = (profile.transaction_pin_attempts || 0) + 1;
            const updates = { transaction_pin_attempts: attempts };
            
            if (attempts >= MAX_PIN_ATTEMPTS) {
                const lockUntil = new Date(Date.now() + PIN_LOCK_DURATION);
                updates.transaction_pin_locked_until = lockUntil.toISOString();
                updates.transaction_pin_attempts = 0;
                
                await supabaseAdmin
                    .from('profiles')
                    .update(updates)
                    .eq('id', userId);
                
                return res.status(403).json({
                    success: false,
                    error: 'Too many failed attempts. PIN locked for 30 minutes.',
                    code: 'PIN_LOCKED'
                });
            }
            
            await supabaseAdmin
                .from('profiles')
                .update(updates)
                .eq('id', userId);
            
            const remaining = MAX_PIN_ATTEMPTS - attempts;
            
            // ─── IMPORTANT: Return 400, NOT 401 ───
            // 401 would trigger logout in session.js
            return res.status(400).json({
                success: false,
                error: `Invalid PIN. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`,
                code: 'INVALID_PIN',
                attempts_remaining: remaining
            });
        }
        
        // ─── PIN valid, reset attempts ───
        await supabaseAdmin
            .from('profiles')
            .update({
                transaction_pin_attempts: 0,
                transaction_pin_locked_until: null
            })
            .eq('id', userId);
        
        // ─── Create withdrawal ───
        const withdrawalRef = `WTH-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        
        const { data: withdrawal, error: createError } = await supabaseAdmin
            .from('withdrawals')
            .insert({
                user_id: userId,
                amount: amount,
                currency: currency,
                status: 'pending',
                bank_code: destination.bank_code || null,
                bank_name: destination.bank_name || null,
                account_number: destination.account_number || null,
                account_name: destination.account_name || null,
                crypto_address: destination.crypto_address || null,
                crypto_network: destination.crypto_network || null,
                crypto_currency: destination.crypto_currency || null,
                provider: provider,
                provider_reference: withdrawalRef,
                transaction_fee: fee,
                notes: notes || null,
                created_at: new Date().toISOString()
            })
            .select()
            .single();
        
        if (createError) {
            console.error('Withdrawal create error:', createError);
            return res.status(500).json({ 
                success: false, 
                error: 'Failed to create withdrawal request' 
            });
        }
        
        // ─── Deduct balance ───
        const newBalance = balance - totalAmount;
        await supabaseAdmin
            .from('profiles')
            .update({
                [isUSD ? 'wallet_usd' : 'wallet_ngn']: newBalance
            })
            .eq('id', userId);
        
        // ─── Create transaction ───
        await supabaseAdmin
            .from('transactions')
            .insert({
                user_id: userId,
                type: 'withdrawal',
                category: 'debit',
                description: `${isUSD ? 'USD' : 'NGN'} withdrawal - ${withdrawalRef}`,
                amount_ngn: isUSD ? 0 : -amount,
                amount_usd: isUSD ? -amount : 0,
                currency: currency,
                status: 'pending',
                ref: withdrawalRef,
                wallet_used: currency,
                meta: {
                    withdrawal_id: withdrawal.id,
                    provider: provider,
                    fee: fee,
                    fee_currency: isUSD ? 'USD' : 'NGN'
                },
                created_at: new Date().toISOString()
            });
        
        // ─── Notify user ───
        await createNotification(
            userId,
            'Withdrawal Requested 📤',
            `Your ${isUSD ? '$' : '₦'}${amount.toFixed(2)} withdrawal has been requested.`,
            'withdrawal_pending',
            '/wallet'
        );
        
        // ─── Send email confirmation ───
        try {
            await emailService.sendWithdrawalSuccess(
                profile.email,
                profile.username || 'User',
                amount,
                currency,
                withdrawalRef,
                isUSD ? 'USD Wallet' : 'NGN Wallet',
                new Date().toLocaleString()
            );
        } catch (emailError) {
            console.error('Email error:', emailError);
            // Don't fail the request if email fails
        }
        
        res.json({
            success: true,
            data: {
                withdrawal: withdrawal,
                fee: fee,
                total_deducted: totalAmount,
                new_balance: newBalance,
                reference: withdrawalRef,
                message: 'Withdrawal request created successfully.'
            }
        });
    } catch (error) {
        console.error('Withdrawal request error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Withdrawal failed. Please try again.' 
        });
    }
});

// ─── GET /api/wallet/withdraw/withdrawals ───
router.get('/withdrawals', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 20;
        const status = req.query.status || 'all';
        
        let query = supabaseAdmin
            .from('withdrawals')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);
        
        if (status !== 'all') {
            query = query.eq('status', status);
        }
        
        const { data, error } = await query;
        
        if (error) {
            return res.status(500).json({ 
                success: false, 
                error: error.message 
            });
        }
        
        res.json({ 
            success: true, 
            withdrawals: data 
        });
    } catch (error) {
        console.error('Get withdrawals error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch withdrawals' 
        });
    }
});

// ─── POST /api/wallet/withdraw/cancel/:id ───
router.post('/cancel/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        
        // ─── Get withdrawal ───
        const { data: withdrawal, error: findError } = await supabaseAdmin
            .from('withdrawals')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .single();
        
        if (findError || !withdrawal) {
            return res.status(404).json({ 
                success: false, 
                error: 'Withdrawal not found' 
            });
        }
        
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ 
                success: false, 
                error: 'Only pending withdrawals can be cancelled' 
            });
        }
        
        // ─── Refund balance ───
        const isUSD = withdrawal.currency === 'USD';
        const totalAmount = parseFloat(withdrawal.amount) + parseFloat(withdrawal.transaction_fee || 0);
        
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select(isUSD ? 'wallet_usd' : 'wallet_ngn')
            .eq('id', userId)
            .single();
        
        if (profile) {
            const currentBalance = isUSD ? parseFloat(profile.wallet_usd) : parseFloat(profile.wallet_ngn);
            const newBalance = currentBalance + totalAmount;
            await supabaseAdmin
                .from('profiles')
                .update({
                    [isUSD ? 'wallet_usd' : 'wallet_ngn']: newBalance
                })
                .eq('id', userId);
        }
        
        // ─── Update withdrawal status ───
        await supabaseAdmin
            .from('withdrawals')
            .update({
                status: 'cancelled',
                updated_at: new Date().toISOString(),
                notes: `Cancelled by user at ${new Date().toISOString()}`
            })
            .eq('id', id);
        
        // ─── Update transaction ───
        await supabaseAdmin
            .from('transactions')
            .update({ 
                status: 'cancelled',
                updated_at: new Date().toISOString()
            })
            .eq('ref', withdrawal.provider_reference)
            .eq('type', 'withdrawal');
        
        // ─── Notify user ───
        await createNotification(
            userId,
            'Withdrawal Cancelled ❌',
            `Your ${isUSD ? '$' : '₦'}${withdrawal.amount.toFixed(2)} withdrawal has been cancelled. Your funds have been refunded.`,
            'info',
            '/wallet'
        );
        
        res.json({ 
            success: true, 
            message: 'Withdrawal cancelled successfully' 
        });
    } catch (error) {
        console.error('Cancel withdrawal error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to cancel withdrawal' 
        });
    }
});

// ─── GET /api/wallet/withdraw/test ───
router.get('/test', authMiddleware, async (req, res) => {
    res.json({
        success: true,
        message: 'Withdrawal router working!',
        routes: [
            'GET /banks - Get list of banks',
            'POST /verify-account - Verify bank account',
            'GET /pin-status - Check PIN status',
            'POST /verify-pin - Verify PIN',
            'POST /set-pin - Set new PIN',
            'POST /change-pin - Change existing PIN',
            'POST /request - Request withdrawal',
            'GET /withdrawals - List withdrawals',
            'POST /cancel/:id - Cancel withdrawal',
            'GET /test - Test route'
        ],
        pin_config: {
            max_attempts: MAX_PIN_ATTEMPTS,
            lock_duration_minutes: PIN_LOCK_DURATION / 60000,
            pin_length: 4
        }
    });
});

module.exports = router;