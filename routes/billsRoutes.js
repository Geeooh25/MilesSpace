// routes/billsRoutes.js — COMPLETE BILLS API
// Handles: Airtime, Data, Electricity, TV
// Uses VTpass as provider, normal NGN wallet for payment
//
// BALANCE SOURCE: profiles.wallet_ngn (matches dashboard)
//
// HISTORY: merges three sources:
//   • bill_payment_transactions  (VTpass purchases)
//   • airtime_transactions       (DT One international airtime)
//   • transactions               (unified model — for any legacy rows)

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const vtpassService = require('../services/vtpassService');
const { LedgerService } = require('../services/ledgerService');

// ─── CONFIG ──────────────────────────────────────────────────────────
const MIN_AMOUNT = { airtime: 50, data: 50, electricity: 500, tv: 100 };
const MAX_AMOUNT = { airtime: 50000, data: 100000, electricity: 500000, tv: 100000 };
const VALID_NETWORKS = ['mtn', 'airtel', 'glo', '9mobile'];

const MAX_PIN_ATTEMPTS = 4;
const PIN_LOCK_DURATION = 60 * 60 * 1000;
const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;

// Service types for bill pages.
const BILL_TYPES = ['airtime', 'data', 'electricity', 'tv', 'bills'];

// ─── RATE LIMITING ───────────────────────────────────────────────────
const rateLimitStore = new Map();
function checkRateLimit(key, windowMs, maxRequests) {
    const now = Date.now();
    const record = rateLimitStore.get(key);
    if (!record || now > record.resetAt) {
        rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    if (record.count >= maxRequests) return false;
    record.count++;
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore) {
        if (now > record.resetAt) rateLimitStore.delete(key);
    }
}, 10 * 60 * 1000);

// ─── HELPERS ─────────────────────────────────────────────────────────
function generateReference(prefix = 'BILL') {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
}
function hashString(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}
function createFingerprint(data) {
    const normalized = JSON.stringify(data, Object.keys(data).sort());
    return hashString(normalized);
}
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

async function getUserProfile(userId) {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
    if (error) throw new Error('Failed to fetch user profile');
    if (!data) throw new Error('User not found');
    return data;
}

async function verifyTransactionPin(userId, pin) {
    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
        return { valid: false, error: 'PIN must be exactly 4 digits', code: 'INVALID_FORMAT' };
    }

    const profile = await getUserProfile(userId);

    if (!profile.transaction_pin_hash) {
        return {
            valid: false,
            error: 'PIN not set. Please set a PIN first.',
            code: 'PIN_NOT_SET',
            pinNotSet: true
        };
    }

    if (profile.transaction_pin_locked_until) {
        const lockUntil = new Date(profile.transaction_pin_locked_until);
        const now = new Date();
        if (lockUntil > now) {
            const remaining = Math.ceil((lockUntil - now) / 60000);
            return {
                valid: false,
                error: `PIN is locked. Please wait ${remaining} minute${remaining > 1 ? 's' : ''}.`,
                code: 'PIN_LOCKED',
                remaining_minutes: remaining
            };
        }
    }

    const isValid = await bcrypt.compare(pin, profile.transaction_pin_hash);

    if (!isValid) {
        const attempts = (profile.transaction_pin_attempts || 0) + 1;
        const updates = { transaction_pin_attempts: attempts };

        if (attempts >= MAX_PIN_ATTEMPTS) {
            const lockUntil = new Date(Date.now() + PIN_LOCK_DURATION);
            updates.transaction_pin_locked_until = lockUntil.toISOString();
            updates.transaction_pin_attempts = 0;
        }

        await supabaseAdmin.from('profiles').update(updates).eq('id', userId);

        const remaining = MAX_PIN_ATTEMPTS - attempts;
        return {
            valid: false,
            error: attempts >= MAX_PIN_ATTEMPTS
                ? 'Too many failed attempts. PIN locked for 1 hour.'
                : `Invalid PIN. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`,
            code: attempts >= MAX_PIN_ATTEMPTS ? 'PIN_LOCKED' : 'INVALID_PIN',
            attempts_remaining: remaining,
            remaining_minutes: attempts >= MAX_PIN_ATTEMPTS ? 60 : undefined
        };
    }

    await supabaseAdmin
        .from('profiles')
        .update({ transaction_pin_attempts: 0, transaction_pin_locked_until: null })
        .eq('id', userId);

    return { valid: true };
}

// ═══════════════════════════════════════════════════════════════════
//  BALANCE — reads profiles.wallet_ngn (same as dashboard).
// ═══════════════════════════════════════════════════════════════════
async function getWalletBalance(userId, currency = 'NGN') {
    const ccy = String(currency).toUpperCase();

    const { data: profile, error: profErr } = await supabaseAdmin
        .from('profiles')
        .select('wallet_ngn, wallet_usd')
        .eq('id', userId)
        .maybeSingle();

    if (profErr) {
        console.error('[BILLS] profile balance error:', profErr.message);
    }

    const profileBal = ccy === 'USD'
        ? num(profile?.wallet_usd)
        : num(profile?.wallet_ngn);

    if (profileBal > 0) return profileBal;

    // Ledger fallback only if profiles is zero.
    try {
        const { data: ledger } = await supabaseAdmin
            .from('ledger_accounts')
            .select('available_balance')
            .eq('user_id', userId)
            .eq('currency', ccy)
            .maybeSingle();
        const ledgerBal = num(ledger?.available_balance);
        if (ledgerBal > 0) return ledgerBal;
    } catch (e) { /* non-fatal */ }

    return profileBal;
}

async function createTransaction(data) {
    const transactionData = {
        user_id: data.userId,
        reference: data.reference,
        service_type: data.serviceType,
        service_id: data.serviceId,
        provider: 'vtpass',
        currency: data.currency || 'NGN',
        base_amount: parseFloat(data.baseAmount) || 0,
        provider_amount: parseFloat(data.providerAmount) || 0,
        markup_amount: parseFloat(data.markupAmount) || 0,
        service_fee: parseFloat(data.serviceFee) || 0,
        customer_amount: parseFloat(data.customerAmount) || 0,
        recipient: data.recipient,
        network: data.network || null,
        variation_code: data.variationCode || null,
        status: data.status || 'pending',
        idempotency_key: data.idempotencyKey || null,
        request_fingerprint: data.requestFingerprint || null,
        metadata: data.metadata || {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    const { data: transaction, error } = await supabaseAdmin
        .from('bill_payment_transactions')
        .insert(transactionData)
        .select()
        .single();

    if (error) {
        console.error('❌ Transaction creation error:', error);
        throw new Error(`Failed to create transaction: ${error.message}`);
    }
    return transaction;
}

async function updateTransaction(transactionId, updates) {
    const { data, error } = await supabaseAdmin
        .from('bill_payment_transactions')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', transactionId)
        .select()
        .single();

    if (error) {
        console.error('❌ Transaction update error:', error);
        throw new Error(`Failed to update transaction: ${error.message}`);
    }
    return data;
}

async function createNotification(userId, title, message, type = 'info', link = null) {
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title,
            message,
            type,
            icon: type === 'success' ? '✅' : type === 'error' ? '❌' : '📌',
            link: link || '/bills',
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.error('Notification error:', e);
    }
}

// ─── NETWORK RESOLUTION ─────────────────────────────────────────────
function resolveNetwork(body, detectedNetwork) {
    const candidates = [
        body.network_override,
        body.selected_network,
        body.serviceId,
        detectedNetwork
    ];
    for (const c of candidates) {
        if (!c) continue;
        const normalized = String(c).toLowerCase().trim();
        if (VALID_NETWORKS.includes(normalized)) return normalized;
    }
    return null;
}

// ─── WALLET DEBIT / REFUND HELPERS ─────────────────────────────────
async function debitWalletWithReference({ userId, amount, currency = 'NGN', reference, description, metadata }) {
    return await LedgerService.debitWallet({
        userId,
        amount,
        currency,
        reference,
        description,
        metadata: metadata || {}
    });
}

async function refundWalletByLedgerId({ userId, ledgerTransactionId, reason }) {
    return await LedgerService.refundTransaction({
        userId,
        transactionId: ledgerTransactionId,
        reason: reason || 'Refund'
    });
}

// ═══════════════════════════════════════════════════════════════════
//  REFUND WITH ESCALATION
//  Wraps LedgerService.refundTransaction with:
//    • loud logging on failure
//    • insert into failed_refunds so a reconciler can retry later
//  Returns { success, refund? , error? }.
// ═══════════════════════════════════════════════════════════════════
async function attemptRefund({ userId, ledgerTransactionId, reason, sourceContext }) {
    if (!ledgerTransactionId) {
        return { success: false, error: 'no ledgerTransactionId provided', code: 'NO_LEDGER_ID' };
    }

    try {
        const result = await LedgerService.refundTransaction({
            userId,
            transactionId: ledgerTransactionId,
            reason: reason || 'Refund'
        });

        if (!result || result.success !== true) {
            throw new Error(result?.error || 'refund returned unsuccessful');
        }

        console.log(
            `[BILLS] ✅ Refunded ${result.amount} ${result.currency} ` +
            `(refund_tx=${result.transaction_id}, original=${ledgerTransactionId})`
        );
        return { success: true, refund: result };
    } catch (refundErr) {
        console.error(
            `[BILLS] 🚨 REFUND FAILED — user=${userId}, ledger_tx=${ledgerTransactionId}, ` +
            `reason="${reason}". Manual intervention may be required.`,
            refundErr
        );

        // Persist for later reconciliation / manual audit. Best-effort.
        try {
            await supabaseAdmin.from('failed_refunds').insert({
                user_id: userId,
                ledger_transaction_id: ledgerTransactionId,
                reason: String(reason || 'unknown').slice(0, 500),
                error_message: String(refundErr.message || refundErr).slice(0, 1000),
                context: sourceContext || {},
                status: 'pending',
                attempts: 0,
                created_at: new Date().toISOString()
            });
        } catch (persistErr) {
            console.error('[BILLS] 🚨 Could not persist failed_refunds row:', persistErr.message);
        }

        return { success: false, error: refundErr.message || String(refundErr) };
    }
}

// ─── IDEMPOTENCY ─────────────────────────────────────────────────────
async function checkIdempotency(userId, key, endpoint, fingerprint) {
    const { data, error } = await supabaseAdmin
        .from('idempotency_keys')
        .select('*')
        .eq('user_id', userId)
        .eq('idempotency_key', key)
        .eq('endpoint', endpoint)
        .maybeSingle();

    if (error && error.code !== 'PGRST116') {
        console.error('Idempotency check error:', error);
        return { found: false };
    }
    if (!data) return { found: false };

    if (data.request_fingerprint && fingerprint && data.request_fingerprint !== fingerprint) {
        return { found: true, conflict: true, error: 'This request conflicts with a previous request' };
    }
    return { found: true, status: data.status, response: data.response };
}

async function reserveIdempotencyKey(userId, key, endpoint, fingerprint) {
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL);
    const { data, error } = await supabaseAdmin
        .from('idempotency_keys')
        .insert({
            user_id: userId,
            idempotency_key: key,
            endpoint,
            request_fingerprint: fingerprint,
            status: 'pending',
            expires_at: expiresAt.toISOString(),
            created_at: new Date().toISOString()
        })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') return { reserved: false, reason: 'duplicate' };
        console.error('Idempotency reserve error:', error);
        return { reserved: false, reason: error.message };
    }
    return { reserved: true, id: data.id };
}

async function completeIdempotencyKey(userId, key, endpoint, response) {
    await supabaseAdmin
        .from('idempotency_keys')
        .update({ status: 'completed', response, completed_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('idempotency_key', key)
        .eq('endpoint', endpoint);
}

// ═══════════════════════════════════════════════════════════════════════
// STATIC CATALOG ROUTES
// ═══════════════════════════════════════════════════════════════════════

router.get('/networks', authMiddleware, (req, res) => {
    res.json({ success: true, data: vtpassService.getNetworks() });
});

router.get('/electricity/providers', authMiddleware, (req, res) => {
    res.json({ success: true, data: vtpassService.getElectricityProviders() });
});

router.get('/tv/providers', authMiddleware, (req, res) => {
    res.json({ success: true, data: vtpassService.getTvProviders() });
});

router.post('/phone-lookup', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const { phone } = req.body || {};
        if (!phone) {
            return res.status(400).json({ success: false, error: 'Phone number is required', code: 'MISSING_PHONE' });
        }
        if (!checkRateLimit(`phone_lookup_${userId}`, 60 * 1000, 20)) {
            return res.status(429).json({ success: false, error: 'Too many lookups. Please wait a moment.', code: 'RATE_LIMITED' });
        }

        const result = await vtpassService.lookupPhoneNetwork(phone);
        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error,
                code: 'DETECTION_FAILED',
                data: { phone: result.phone, detection_source: result.detection_source }
            });
        }

        res.json({
            success: true,
            data: {
                phone: result.phone,
                network: result.network,
                network_name: result.network_name,
                detection_source: result.detection_source
            }
        });
    } catch (error) {
        console.error('❌ Phone lookup error:', error);
        res.status(500).json({ success: false, error: 'Phone lookup failed', code: 'SERVER_ERROR' });
    }
});

router.get('/data/variations', authMiddleware, async (req, res) => {
    try {
        const { service_id: network } = req.query;
        if (!network) {
            return res.status(400).json({ success: false, error: 'Network is required', code: 'MISSING_NETWORK' });
        }
        const result = await vtpassService.getDataPlans(network.toLowerCase());
        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error || 'Failed to fetch data plans', code: 'PLANS_UNAVAILABLE' });
        }
        res.json({
            success: true,
            data: result.plans.map(p => ({
                variation_id: p.variation_code,
                variation_code: p.variation_code,
                name: p.name,
                data_plan: p.name,
                price: p.amount,
                variation_amount: p.amount,
                validity: p.description || '30 days'
            }))
        });
    } catch (error) {
        console.error('❌ Data variations error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch data plans', code: 'SERVER_ERROR' });
    }
});

router.get('/tv/variations', authMiddleware, async (req, res) => {
    try {
        const { service_id: provider } = req.query;
        if (!provider) {
            return res.status(400).json({ success: false, error: 'Provider is required', code: 'MISSING_PROVIDER' });
        }
        const result = await vtpassService.getTvPackages(provider.toLowerCase());
        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error || 'Failed to fetch TV packages', code: 'PACKAGES_UNAVAILABLE' });
        }
        res.json({
            success: true,
            data: result.packages.map(p => ({
                variation_id: p.variation_code,
                variation_code: p.variation_code,
                name: p.name,
                package_bouquet: p.name,
                price: p.amount,
                variation_amount: p.amount
            }))
        });
    } catch (error) {
        console.error('❌ TV variations error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch TV packages', code: 'SERVER_ERROR' });
    }
});

router.post('/verify-customer', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const { customerId, serviceId, variationId } = req.body;
        if (!customerId || !serviceId) {
            return res.status(400).json({ success: false, error: 'Customer ID and Service ID are required', code: 'MISSING_PARAMETERS' });
        }
        if (!checkRateLimit(`verify_${userId}`, 60 * 1000, 10)) {
            return res.status(429).json({ success: false, error: 'Too many verification attempts. Please wait.', code: 'RATE_LIMITED' });
        }

        const electricityProviders = vtpassService.getElectricityProviders().map(p => p.id);
        const tvProviders = vtpassService.getTvProviders().map(p => p.id);

        let result;
        if (electricityProviders.includes(serviceId)) {
            result = await vtpassService.verifyElectricityMeter({
                provider: serviceId,
                meterNumber: customerId,
                meterType: variationId || 'prepaid'
            });
        } else if (tvProviders.includes(serviceId)) {
            result = await vtpassService.verifyTvCustomer({ provider: serviceId, customerId });
        } else {
            return res.status(400).json({ success: false, error: 'Unsupported service for verification', code: 'UNSUPPORTED_SERVICE' });
        }

        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error, code: result.code || 'VERIFICATION_FAILED' });
        }

        res.json({
            success: true,
            data: {
                customer_name: result.customerName,
                customerName: result.customerName,
                customer_number: result.customerNumber || customerId,
                customerNumber: result.customerNumber || customerId,
                current_bouquet: result.currentPackage,
                currentBouquet: result.currentPackage,
                renewal_amount: result.renewalAmount,
                renewalAmount: result.renewalAmount,
                meter_number: result.meterNumber || customerId,
                meterNumber: result.meterNumber || customerId,
                meter_type: result.meterType || variationId,
                meterType: result.meterType || variationId,
                min_purchase_amount: result.minAmount,
                minPurchaseAmount: result.minAmount,
                max_purchase_amount: result.maxAmount,
                maxPurchaseAmount: result.maxAmount,
                can_vend: result.canVend,
                canVend: result.canVend,
                address: result.customerAddress
            }
        });
    } catch (error) {
        console.error('❌ Verify customer error:', error);
        res.status(500).json({ success: false, error: 'Verification failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// AIRTIME PURCHASE
// ═══════════════════════════════════════════════════════════════════════
router.post('/airtime/purchase', authMiddleware, async (req, res) => {
    const userId = req.user?.id;
    const idempotencyKey = req.headers['idempotency-key'];

    try {
        const { phone, amount, transaction_pin } = req.body;

        console.log('📝 Airtime purchase request:', {
            hasPhone: !!phone,
            amount,
            hasPin: !!transaction_pin,
            hasIdempotencyKey: !!idempotencyKey
        });

        if (!phone || !amount) {
            return res.status(400).json({ success: false, error: 'Phone and amount are required', code: 'MISSING_PARAMETERS' });
        }

        const numericAmount = parseFloat(amount);
        if (!Number.isFinite(numericAmount) || numericAmount < MIN_AMOUNT.airtime || numericAmount > MAX_AMOUNT.airtime) {
            return res.status(400).json({
                success: false,
                error: `Amount must be between ₦${MIN_AMOUNT.airtime} and ₦${MAX_AMOUNT.airtime}`,
                code: 'INVALID_AMOUNT'
            });
        }

        if (!transaction_pin) {
            return res.status(400).json({ success: false, error: 'Transaction PIN is required', code: 'PIN_REQUIRED', pinRequired: true });
        }

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) {
            return res.status(400).json({
                success: false,
                error: pinResult.error,
                code: pinResult.code,
                attempts_remaining: pinResult.attempts_remaining
            });
        }

        const phoneValidation = vtpassService.validatePhone(phone);
        if (!phoneValidation.valid) {
            return res.status(400).json({ success: false, error: phoneValidation.error, code: 'INVALID_PHONE' });
        }

        const detectedNetwork = phoneValidation.network;
        const finalNetwork = resolveNetwork(req.body, detectedNetwork);
        if (!finalNetwork) {
            return res.status(400).json({ success: false, error: 'Please select a valid network', code: 'INVALID_NETWORK' });
        }

        const manuallyOverridden = !!detectedNetwork && detectedNetwork !== finalNetwork;

        const fingerprint = createFingerprint({
            phone: phoneValidation.phone,
            network: finalNetwork,
            amount: numericAmount
        });

        if (idempotencyKey) {
            const existing = await checkIdempotency(userId, idempotencyKey, '/api/bills/airtime/purchase', fingerprint);
            if (existing.conflict) {
                return res.status(409).json({ success: false, error: 'This request conflicts with a previous request', code: 'IDEMPOTENCY_CONFLICT' });
            }
            if (existing.found && existing.status === 'completed') {
                return res.json({ success: true, already_processed: true, data: existing.response });
            }
            if (existing.found && existing.status === 'pending') {
                return res.status(409).json({ success: false, error: 'This purchase is already being processed', code: 'DUPLICATE_REQUEST' });
            }
            const reserved = await reserveIdempotencyKey(userId, idempotencyKey, '/api/bills/airtime/purchase', fingerprint);
            if (!reserved.reserved && reserved.reason === 'duplicate') {
                return res.status(409).json({ success: false, error: 'This purchase is already being processed', code: 'DUPLICATE_REQUEST' });
            }
        }

        const walletBalance = await getWalletBalance(userId, 'NGN');
        const serviceFee = 0;
        const totalAmount = numericAmount + serviceFee;

        if (walletBalance < totalAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. Available: ₦${walletBalance.toFixed(2)}, Required: ₦${totalAmount.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                data: { balance: walletBalance, required: totalAmount, shortfall: totalAmount - walletBalance }
            });
        }

        const reference = generateReference('AIR');
        const transaction = await createTransaction({
            userId,
            reference,
            serviceType: 'airtime',
            serviceId: finalNetwork,
            provider: 'vtpass',
            currency: 'NGN',
            baseAmount: numericAmount,
            providerAmount: numericAmount,
            markupAmount: 0,
            serviceFee,
            customerAmount: totalAmount,
            recipient: phoneValidation.phone,
            network: finalNetwork,
            status: 'pending',
            idempotencyKey,
            requestFingerprint: fingerprint,
            metadata: {
                network_name: vtpassService.getNetworks().find(n => n.id === finalNetwork)?.name || finalNetwork,
                phone: phoneValidation.phone,
                phone_lookup: {
                    input_phone: phone,
                    normalized_phone: phoneValidation.phone,
                    detected_network: detectedNetwork,
                    selected_network: finalNetwork,
                    detection_source: 'prefix',
                    manually_overridden: manuallyOverridden
                }
            }
        });

        let debitResult;
        try {
            debitResult = await debitWalletWithReference({
                userId,
                amount: totalAmount,
                currency: 'NGN',
                reference: `${reference}-DEBIT`,
                description: `Airtime purchase - ${finalNetwork.toUpperCase()} (${phoneValidation.phone})`,
                metadata: { transaction_id: transaction.id, service: 'airtime' }
            });
        } catch (debitErr) {
            console.error('❌ Airtime debit failed:', debitErr);
            await updateTransaction(transaction.id, {
                status: 'failed',
                failure_reason: `Wallet debit failed: ${debitErr.message}`,
                failed_at: new Date().toISOString()
            });
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }

        if (!debitResult || debitResult.success !== true) {
            await updateTransaction(transaction.id, {
                status: 'failed',
                failure_reason: 'Wallet debit returned unsuccessful',
                failed_at: new Date().toISOString()
            });
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }

        await updateTransaction(transaction.id, {
            status: 'processing',
            ledger_transaction_id: debitResult.transaction_id
        });

        const vtpassResult = await vtpassService.purchaseAirtime({
            phone: phoneValidation.phone,
            network: finalNetwork,
            amount: numericAmount
        });

        let responseData;

        if (vtpassResult.state === 'completed') {
            await updateTransaction(transaction.id, {
                status: 'completed',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                completed_at: new Date().toISOString()
            });

            await createNotification(
                userId,
                'Airtime Purchase Successful',
                `You have successfully purchased ₦${numericAmount.toFixed(2)} airtime for ${phoneValidation.phone}`,
                'success',
                '/bills'
            );

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'completed',
                amount: numericAmount,
                recipient: phoneValidation.phone,
                network: finalNetwork,
                detected_network: detectedNetwork,
                network_override: manuallyOverridden
            };
        } else if (vtpassResult.state === 'processing') {
            await updateTransaction(transaction.id, {
                status: 'processing',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.error || null
            });

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'processing',
                amount: numericAmount,
                recipient: phoneValidation.phone,
                network: finalNetwork,
                detected_network: detectedNetwork,
                network_override: manuallyOverridden,
                message: 'Transaction is being processed'
            };
        } else {
            // ── REFUND (hardened) ────────────────────────────────
            const refundOutcome = await attemptRefund({
                userId,
                ledgerTransactionId: debitResult.transaction_id,
                reason: vtpassResult.friendlyError || vtpassResult.error || 'Provider transaction failed',
                sourceContext: {
                    bill_transaction_id: transaction.id,
                    reference,
                    service: 'airtime',
                    provider_status: vtpassResult.providerStatus,
                    provider_code: vtpassResult.code
                }
            });
            const refundResult = refundOutcome.success
                ? { success: true }
                : { success: false, error: refundOutcome.error };

            await updateTransaction(transaction.id, {
                status: 'failed',
                provider_request_id: vtpassResult.requestId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.friendlyError || vtpassResult.error,
                failed_at: new Date().toISOString(),
                refunded: !!refundResult.success,
                refunded_at: refundResult.success ? new Date().toISOString() : null
            });

            await createNotification(
                userId,
                'Airtime Purchase Failed',
                `Your airtime purchase of ₦${numericAmount.toFixed(2)} for ${phoneValidation.phone} failed. ${refundResult.success ? 'Your wallet has been refunded.' : 'A refund is being processed.'}`,
                'error',
                '/bills'
            );

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'failed',
                amount: numericAmount,
                recipient: phoneValidation.phone,
                network: finalNetwork,
                detected_network: detectedNetwork,
                network_override: manuallyOverridden,
                error: vtpassResult.friendlyError || vtpassResult.error,
                refunded: !!refundResult.success
            };
        }

        if (idempotencyKey) {
            await completeIdempotencyKey(userId, idempotencyKey, '/api/bills/airtime/purchase', responseData);
        }

        const newBalance = await getWalletBalance(userId, 'NGN');
        res.json({ success: true, data: { ...responseData, new_balance: newBalance } });

    } catch (error) {
        console.error('❌ Airtime purchase error:', error);
        res.status(500).json({ success: false, error: error.message || 'Purchase failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// DATA PURCHASE
// ═══════════════════════════════════════════════════════════════════════
router.post('/data/purchase', authMiddleware, async (req, res) => {
    const userId = req.user?.id;
    const idempotencyKey = req.headers['idempotency-key'];

    try {
        const { phone, variationId, transaction_pin } = req.body;

        if (!phone || !variationId) {
            return res.status(400).json({ success: false, error: 'Phone and plan are required', code: 'MISSING_PARAMETERS' });
        }

        if (!transaction_pin) {
            return res.status(400).json({ success: false, error: 'Transaction PIN is required', code: 'PIN_REQUIRED', pinRequired: true });
        }

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) {
            return res.status(400).json({
                success: false,
                error: pinResult.error,
                code: pinResult.code,
                attempts_remaining: pinResult.attempts_remaining
            });
        }

        const phoneValidation = vtpassService.validatePhone(phone);
        if (!phoneValidation.valid) {
            return res.status(400).json({ success: false, error: phoneValidation.error, code: 'INVALID_PHONE' });
        }

        const detectedNetwork = phoneValidation.network;
        const finalNetwork = resolveNetwork(req.body, detectedNetwork);
        if (!finalNetwork) {
            return res.status(400).json({ success: false, error: 'Please select a valid network', code: 'INVALID_NETWORK' });
        }

        const manuallyOverridden = !!detectedNetwork && detectedNetwork !== finalNetwork;

        let planData;
        try {
            const plans = await vtpassService.getDataPlans(finalNetwork);
            planData = plans.plans?.find(p => p.variation_code === variationId);
        } catch (e) {
            console.error('Failed to fetch plan:', e);
        }

        if (!planData) {
            return res.status(400).json({ success: false, error: 'Selected data plan is not available for the chosen network', code: 'INVALID_PLAN' });
        }

        const planAmount = planData.amount;

        const fingerprint = createFingerprint({
            phone: phoneValidation.phone,
            network: finalNetwork,
            variationId
        });

        if (idempotencyKey) {
            const existing = await checkIdempotency(userId, idempotencyKey, '/api/bills/data/purchase', fingerprint);
            if (existing.conflict) {
                return res.status(409).json({ success: false, error: 'This request conflicts with a previous request', code: 'IDEMPOTENCY_CONFLICT' });
            }
            if (existing.found && existing.status === 'completed') {
                return res.json({ success: true, already_processed: true, data: existing.response });
            }
            if (existing.found && existing.status === 'pending') {
                return res.status(409).json({ success: false, error: 'This purchase is already being processed', code: 'DUPLICATE_REQUEST' });
            }
            const reserved = await reserveIdempotencyKey(userId, idempotencyKey, '/api/bills/data/purchase', fingerprint);
            if (!reserved.reserved && reserved.reason === 'duplicate') {
                return res.status(409).json({ success: false, error: 'This purchase is already being processed', code: 'DUPLICATE_REQUEST' });
            }
        }

        const walletBalance = await getWalletBalance(userId, 'NGN');
        const serviceFee = 0;
        const totalAmount = planAmount + serviceFee;

        if (walletBalance < totalAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. Available: ₦${walletBalance.toFixed(2)}, Required: ₦${totalAmount.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                data: { balance: walletBalance, required: totalAmount, shortfall: totalAmount - walletBalance }
            });
        }

        const reference = generateReference('DAT');
        const transaction = await createTransaction({
            userId,
            reference,
            serviceType: 'data',
            serviceId: finalNetwork,
            provider: 'vtpass',
            currency: 'NGN',
            baseAmount: planAmount,
            providerAmount: planAmount,
            markupAmount: 0,
            serviceFee,
            customerAmount: totalAmount,
            recipient: phoneValidation.phone,
            network: finalNetwork,
            variationCode: variationId,
            status: 'pending',
            idempotencyKey,
            requestFingerprint: fingerprint,
            metadata: {
                network_name: vtpassService.getNetworks().find(n => n.id === finalNetwork)?.name || finalNetwork,
                phone: phoneValidation.phone,
                plan_name: planData.name,
                phone_lookup: {
                    input_phone: phone,
                    normalized_phone: phoneValidation.phone,
                    detected_network: detectedNetwork,
                    selected_network: finalNetwork,
                    detection_source: 'prefix',
                    manually_overridden: manuallyOverridden
                }
            }
        });

        let debitResult;
        try {
            debitResult = await debitWalletWithReference({
                userId,
                amount: totalAmount,
                currency: 'NGN',
                reference: `${reference}-DEBIT`,
                description: `Data purchase - ${finalNetwork.toUpperCase()} ${planData.name} (${phoneValidation.phone})`,
                metadata: { transaction_id: transaction.id, service: 'data' }
            });
        } catch (debitErr) {
            console.error('❌ Data debit failed:', debitErr);
            await updateTransaction(transaction.id, {
                status: 'failed',
                failure_reason: `Wallet debit failed: ${debitErr.message}`,
                failed_at: new Date().toISOString()
            });
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }

        if (!debitResult || debitResult.success !== true) {
            await updateTransaction(transaction.id, {
                status: 'failed',
                failure_reason: 'Wallet debit returned unsuccessful',
                failed_at: new Date().toISOString()
            });
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }

        await updateTransaction(transaction.id, {
            status: 'processing',
            ledger_transaction_id: debitResult.transaction_id
        });

        const vtpassResult = await vtpassService.purchaseData({
            phone: phoneValidation.phone,
            network: finalNetwork,
            variationCode: variationId
        });

        let responseData;

        if (vtpassResult.state === 'completed') {
            await updateTransaction(transaction.id, {
                status: 'completed',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                completed_at: new Date().toISOString()
            });

            await createNotification(
                userId,
                'Data Purchase Successful',
                `You have successfully purchased ${planData.name} for ${phoneValidation.phone}`,
                'success',
                '/bills'
            );

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'completed',
                amount: planAmount,
                recipient: phoneValidation.phone,
                network: finalNetwork,
                detected_network: detectedNetwork,
                network_override: manuallyOverridden,
                plan: planData.name
            };
        } else if (vtpassResult.state === 'processing') {
            await updateTransaction(transaction.id, {
                status: 'processing',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.error || null
            });

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'processing',
                amount: planAmount,
                recipient: phoneValidation.phone,
                network: finalNetwork,
                detected_network: detectedNetwork,
                network_override: manuallyOverridden,
                plan: planData.name,
                message: 'Transaction is being processed'
            };
        } else {
            // ── REFUND (hardened) ────────────────────────────────
            const refundOutcome = await attemptRefund({
                userId,
                ledgerTransactionId: debitResult.transaction_id,
                reason: vtpassResult.friendlyError || vtpassResult.error || 'Provider transaction failed',
                sourceContext: {
                    bill_transaction_id: transaction.id,
                    reference,
                    service: 'data',
                    provider_status: vtpassResult.providerStatus,
                    provider_code: vtpassResult.code
                }
            });
            const refundResult = refundOutcome.success
                ? { success: true }
                : { success: false, error: refundOutcome.error };

            await updateTransaction(transaction.id, {
                status: 'failed',
                provider_request_id: vtpassResult.requestId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.friendlyError || vtpassResult.error,
                failed_at: new Date().toISOString(),
                refunded: !!refundResult.success,
                refunded_at: refundResult.success ? new Date().toISOString() : null
            });

            await createNotification(
                userId,
                'Data Purchase Failed',
                `Your data purchase of ${planData.name} for ${phoneValidation.phone} failed. ${refundResult.success ? 'Your wallet has been refunded.' : 'A refund is being processed.'}`,
                'error',
                '/bills'
            );

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'failed',
                amount: planAmount,
                recipient: phoneValidation.phone,
                network: finalNetwork,
                detected_network: detectedNetwork,
                network_override: manuallyOverridden,
                plan: planData.name,
                error: vtpassResult.friendlyError || vtpassResult.error,
                refunded: !!refundResult.success
            };
        }

        if (idempotencyKey) {
            await completeIdempotencyKey(userId, idempotencyKey, '/api/bills/data/purchase', responseData);
        }

        const newBalance = await getWalletBalance(userId, 'NGN');
        res.json({ success: true, data: { ...responseData, new_balance: newBalance } });

    } catch (error) {
        console.error('❌ Data purchase error:', error);
        res.status(500).json({ success: false, error: error.message || 'Purchase failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// ELECTRICITY PURCHASE
// ═══════════════════════════════════════════════════════════════════════
router.post('/electricity/purchase', authMiddleware, async (req, res) => {
    const userId = req.user?.id;
    const idempotencyKey = req.headers['idempotency-key'];

    try {
        const { customerId, serviceId, variationId, amount, transaction_pin } = req.body;

        if (!customerId || !serviceId || !amount) {
            return res.status(400).json({ success: false, error: 'Meter number, provider, and amount are required', code: 'MISSING_PARAMETERS' });
        }

        const numericAmount = parseFloat(amount);
        if (!Number.isFinite(numericAmount) || numericAmount < MIN_AMOUNT.electricity) {
            return res.status(400).json({ success: false, error: `Minimum amount is ₦${MIN_AMOUNT.electricity}`, code: 'INVALID_AMOUNT' });
        }

        if (!transaction_pin) {
            return res.status(400).json({ success: false, error: 'Transaction PIN is required', code: 'PIN_REQUIRED', pinRequired: true });
        }

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) {
            return res.status(400).json({
                success: false,
                error: pinResult.error,
                code: pinResult.code,
                attempts_remaining: pinResult.attempts_remaining
            });
        }

        const verification = await vtpassService.verifyElectricityMeter({
            provider: serviceId,
            meterNumber: customerId,
            meterType: variationId || 'prepaid'
        });

        if (!verification.success) {
            return res.status(400).json({ success: false, error: verification.error || 'Meter verification failed', code: 'VERIFICATION_FAILED' });
        }
        if (!verification.canVend) {
            return res.status(400).json({ success: false, error: 'This meter cannot be vended at the moment', code: 'CANNOT_VEND' });
        }
        if (verification.minAmount && numericAmount < verification.minAmount) {
            return res.status(400).json({ success: false, error: `Minimum amount for this meter is ₦${verification.minAmount}`, code: 'AMOUNT_BELOW_MINIMUM' });
        }
        if (verification.maxAmount && numericAmount > verification.maxAmount) {
            return res.status(400).json({ success: false, error: `Maximum amount for this meter is ₦${verification.maxAmount}`, code: 'AMOUNT_ABOVE_MAXIMUM' });
        }

        const fingerprint = createFingerprint({
            customerId, serviceId, variationId, amount: numericAmount
        });

        if (idempotencyKey) {
            const existing = await checkIdempotency(userId, idempotencyKey, '/api/bills/electricity/purchase', fingerprint);
            if (existing.conflict) {
                return res.status(409).json({ success: false, error: 'This request conflicts with a previous request', code: 'IDEMPOTENCY_CONFLICT' });
            }
            if (existing.found && existing.status === 'completed') {
                return res.json({ success: true, already_processed: true, data: existing.response });
            }
            if (existing.found && existing.status === 'pending') {
                return res.status(409).json({ success: false, error: 'This purchase is already being processed', code: 'DUPLICATE_REQUEST' });
            }
            const reserved = await reserveIdempotencyKey(userId, idempotencyKey, '/api/bills/electricity/purchase', fingerprint);
            if (!reserved.reserved && reserved.reason === 'duplicate') {
                return res.status(409).json({ success: false, error: 'This purchase is already being processed', code: 'DUPLICATE_REQUEST' });
            }
        }

        const walletBalance = await getWalletBalance(userId, 'NGN');
        const serviceFee = 0;
        const totalAmount = numericAmount + serviceFee;

        if (walletBalance < totalAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. Available: ₦${walletBalance.toFixed(2)}, Required: ₦${totalAmount.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                data: { balance: walletBalance, required: totalAmount, shortfall: totalAmount - walletBalance }
            });
        }

        const reference = generateReference('ELC');
        const transaction = await createTransaction({
            userId,
            reference,
            serviceType: 'electricity',
            serviceId,
            provider: 'vtpass',
            currency: 'NGN',
            baseAmount: numericAmount,
            providerAmount: numericAmount,
            markupAmount: 0,
            serviceFee,
            customerAmount: totalAmount,
            recipient: customerId,
            variationCode: variationId,
            status: 'pending',
            idempotencyKey,
            requestFingerprint: fingerprint,
            metadata: {
                meter_number: customerId,
                meter_type: variationId,
                customer_name: verification.customerName,
                customer_address: verification.customerAddress,
                can_vend: verification.canVend
            }
        });

        let debitResult;
        try {
            debitResult = await debitWalletWithReference({
                userId,
                amount: totalAmount,
                currency: 'NGN',
                reference: `${reference}-DEBIT`,
                description: `Electricity payment - ${serviceId} (${customerId})`,
                metadata: { transaction_id: transaction.id, service: 'electricity' }
            });
        } catch (debitErr) {
            await updateTransaction(transaction.id, {
                status: 'failed',
                failure_reason: `Wallet debit failed: ${debitErr.message}`,
                failed_at: new Date().toISOString()
            });
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }

        if (!debitResult || debitResult.success !== true) {
            await updateTransaction(transaction.id, {
                status: 'failed',
                failure_reason: 'Wallet debit returned unsuccessful',
                failed_at: new Date().toISOString()
            });
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }

        await updateTransaction(transaction.id, {
            status: 'processing',
            ledger_transaction_id: debitResult.transaction_id
        });

        const vtpassResult = await vtpassService.purchaseElectricity({
            provider: serviceId,
            meterNumber: customerId,
            meterType: variationId || 'prepaid',
            amount: numericAmount,
            phone: req.user?.phone
        });

        let responseData;

        if (vtpassResult.state === 'completed') {
            await updateTransaction(transaction.id, {
                status: 'completed',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                token: vtpassResult.token,
                units: vtpassResult.units,
                completed_at: new Date().toISOString()
            });

            await createNotification(
                userId,
                'Electricity Payment Successful',
                `You have successfully paid ₦${numericAmount.toFixed(2)} for meter ${customerId}`,
                'success',
                '/bills'
            );

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'completed',
                amount: numericAmount,
                recipient: customerId,
                customerName: verification.customerName,
                token: vtpassResult.token,
                units: vtpassResult.units
            };
        } else if (vtpassResult.state === 'processing') {
            await updateTransaction(transaction.id, {
                status: 'processing',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.error || null
            });

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'processing',
                amount: numericAmount,
                recipient: customerId,
                customerName: verification.customerName,
                message: 'Transaction is being processed'
            };
        } else {
            // ── REFUND (hardened) ────────────────────────────────
            const refundOutcome = await attemptRefund({
                userId,
                ledgerTransactionId: debitResult.transaction_id,
                reason: vtpassResult.friendlyError || vtpassResult.error || 'Provider transaction failed',
                sourceContext: {
                    bill_transaction_id: transaction.id,
                    reference,
                    service: 'electricity',
                    provider_status: vtpassResult.providerStatus,
                    provider_code: vtpassResult.code
                }
            });
            const refundResult = refundOutcome.success
                ? { success: true }
                : { success: false, error: refundOutcome.error };

            await updateTransaction(transaction.id, {
                status: 'failed',
                provider_request_id: vtpassResult.requestId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.friendlyError || vtpassResult.error,
                failed_at: new Date().toISOString(),
                refunded: !!refundResult.success,
                refunded_at: refundResult.success ? new Date().toISOString() : null
            });

            await createNotification(
                userId,
                'Electricity Payment Failed',
                `Your electricity payment of ₦${numericAmount.toFixed(2)} for meter ${customerId} failed. ${refundResult.success ? 'Your wallet has been refunded.' : 'A refund is being processed.'}`,
                'error',
                '/bills'
            );

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'failed',
                amount: numericAmount,
                recipient: customerId,
                customerName: verification.customerName,
                error: vtpassResult.friendlyError || vtpassResult.error,
                refunded: !!refundResult.success
            };
        }

        if (idempotencyKey) {
            await completeIdempotencyKey(userId, idempotencyKey, '/api/bills/electricity/purchase', responseData);
        }

        const newBalance = await getWalletBalance(userId, 'NGN');
        res.json({ success: true, data: { ...responseData, new_balance: newBalance } });

    } catch (error) {
        console.error('❌ Electricity purchase error:', error);
        res.status(500).json({ success: false, error: error.message || 'Purchase failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// TV PURCHASE
// ═══════════════════════════════════════════════════════════════════════
router.post('/tv/purchase', authMiddleware, async (req, res) => {
    const userId = req.user?.id;
    const idempotencyKey = req.headers['idempotency-key'];

    try {
        const { customerId, serviceId, variationId, subscriptionType, transaction_pin } = req.body;

        if (!customerId || !serviceId || !variationId) {
            return res.status(400).json({ success: false, error: 'Smartcard number, provider, and package are required', code: 'MISSING_PARAMETERS' });
        }

        if (!transaction_pin) {
            return res.status(400).json({ success: false, error: 'Transaction PIN is required', code: 'PIN_REQUIRED', pinRequired: true });
        }

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) {
            return res.status(400).json({
                success: false,
                error: pinResult.error,
                code: pinResult.code,
                attempts_remaining: pinResult.attempts_remaining
            });
        }

        const verification = await vtpassService.verifyTvCustomer({ provider: serviceId, customerId });
        if (!verification.success) {
            return res.status(400).json({ success: false, error: verification.error || 'Customer verification failed', code: 'VERIFICATION_FAILED' });
        }

        let packageData;
        try {
            const packages = await vtpassService.getTvPackages(serviceId);
            packageData = packages.packages?.find(p => p.variation_code === variationId);
        } catch (e) {
            console.error('Failed to fetch package:', e);
        }

        if (!packageData) {
            return res.status(400).json({ success: false, error: 'Selected package is no longer available', code: 'INVALID_PACKAGE' });
        }

        const packageAmount = subscriptionType === 'renew' && verification.renewalAmount > 0
            ? verification.renewalAmount
            : packageData.amount;

        const fingerprint = createFingerprint({
            customerId, serviceId, variationId, subscriptionType, amount: packageAmount
        });

        if (idempotencyKey) {
            const existing = await checkIdempotency(userId, idempotencyKey, '/api/bills/tv/purchase', fingerprint);
            if (existing.conflict) {
                return res.status(409).json({ success: false, error: 'This request conflicts with a previous request', code: 'IDEMPOTENCY_CONFLICT' });
            }
            if (existing.found && existing.status === 'completed') {
                return res.json({ success: true, already_processed: true, data: existing.response });
            }
            if (existing.found && existing.status === 'pending') {
                return res.status(409).json({ success: false, error: 'This purchase is already being processed', code: 'DUPLICATE_REQUEST' });
            }
            const reserved = await reserveIdempotencyKey(userId, idempotencyKey, '/api/bills/tv/purchase', fingerprint);
            if (!reserved.reserved && reserved.reason === 'duplicate') {
                return res.status(409).json({ success: false, error: 'This purchase is already being processed', code: 'DUPLICATE_REQUEST' });
            }
        }

        const walletBalance = await getWalletBalance(userId, 'NGN');
        const serviceFee = 0;
        const totalAmount = packageAmount + serviceFee;

        if (walletBalance < totalAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. Available: ₦${walletBalance.toFixed(2)}, Required: ₦${totalAmount.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                data: { balance: walletBalance, required: totalAmount, shortfall: totalAmount - walletBalance }
            });
        }

        const reference = generateReference('TV');
        const transaction = await createTransaction({
            userId,
            reference,
            serviceType: 'tv',
            serviceId,
            provider: 'vtpass',
            currency: 'NGN',
            baseAmount: packageAmount,
            providerAmount: packageAmount,
            markupAmount: 0,
            serviceFee,
            customerAmount: totalAmount,
            recipient: customerId,
            variationCode: variationId,
            status: 'pending',
            idempotencyKey,
            requestFingerprint: fingerprint,
            metadata: {
                customer_number: customerId,
                current_package: verification.currentPackage,
                subscription_type: subscriptionType,
                package_name: packageData.name
            }
        });

        let debitResult;
        try {
            debitResult = await debitWalletWithReference({
                userId,
                amount: totalAmount,
                currency: 'NGN',
                reference: `${reference}-DEBIT`,
                description: `TV subscription - ${serviceId} ${packageData.name} (${customerId})`,
                metadata: { transaction_id: transaction.id, service: 'tv' }
            });
        } catch (debitErr) {
            await updateTransaction(transaction.id, {
                status: 'failed',
                failure_reason: `Wallet debit failed: ${debitErr.message}`,
                failed_at: new Date().toISOString()
            });
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }

        if (!debitResult || debitResult.success !== true) {
            await updateTransaction(transaction.id, {
                status: 'failed',
                failure_reason: 'Wallet debit returned unsuccessful',
                failed_at: new Date().toISOString()
            });
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }

        await updateTransaction(transaction.id, {
            status: 'processing',
            ledger_transaction_id: debitResult.transaction_id
        });

        const vtpassResult = await vtpassService.purchaseTv({
            provider: serviceId,
            customerId,
            variationCode: variationId,
            amount: packageAmount,
            subscriptionType
        });

        let responseData;

        if (vtpassResult.state === 'completed') {
            await updateTransaction(transaction.id, {
                status: 'completed',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                completed_at: new Date().toISOString()
            });

            await createNotification(
                userId,
                'TV Subscription Successful',
                `You have successfully subscribed ${packageData.name} for ${customerId}`,
                'success',
                '/bills'
            );

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'completed',
                amount: packageAmount,
                recipient: customerId,
                customerName: verification.customerName,
                package: packageData.name
            };
        } else if (vtpassResult.state === 'processing') {
            await updateTransaction(transaction.id, {
                status: 'processing',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.error || null
            });

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'processing',
                amount: packageAmount,
                recipient: customerId,
                customerName: verification.customerName,
                package: packageData.name,
                message: 'Transaction is being processed'
            };
        } else {
            // ── REFUND (hardened) ────────────────────────────────
            const refundOutcome = await attemptRefund({
                userId,
                ledgerTransactionId: debitResult.transaction_id,
                reason: vtpassResult.friendlyError || vtpassResult.error || 'Provider transaction failed',
                sourceContext: {
                    bill_transaction_id: transaction.id,
                    reference,
                    service: 'tv',
                    provider_status: vtpassResult.providerStatus,
                    provider_code: vtpassResult.code
                }
            });
            const refundResult = refundOutcome.success
                ? { success: true }
                : { success: false, error: refundOutcome.error };

            await updateTransaction(transaction.id, {
                status: 'failed',
                provider_request_id: vtpassResult.requestId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.friendlyError || vtpassResult.error,
                failed_at: new Date().toISOString(),
                refunded: !!refundResult.success,
                refunded_at: refundResult.success ? new Date().toISOString() : null
            });

            await createNotification(
                userId,
                'TV Subscription Failed',
                `Your TV subscription of ${packageData.name} for ${customerId} failed. ${refundResult.success ? 'Your wallet has been refunded.' : 'A refund is being processed.'}`,
                'error',
                '/bills'
            );

            responseData = {
                transactionId: transaction.id,
                reference,
                status: 'failed',
                amount: packageAmount,
                recipient: customerId,
                customerName: verification.customerName,
                package: packageData.name,
                error: vtpassResult.friendlyError || vtpassResult.error,
                refunded: !!refundResult.success
            };
        }

        if (idempotencyKey) {
            await completeIdempotencyKey(userId, idempotencyKey, '/api/bills/tv/purchase', responseData);
        }

        const newBalance = await getWalletBalance(userId, 'NGN');
        res.json({ success: true, data: { ...responseData, new_balance: newBalance } });

    } catch (error) {
        console.error('❌ TV purchase error:', error);
        res.status(500).json({ success: false, error: error.message || 'Purchase failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════════════
router.get('/status/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        const { data: transaction, error } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        if (!transaction) {
            return res.status(404).json({ success: false, error: 'Transaction not found', code: 'NOT_FOUND' });
        }

        res.json({
            success: true,
            data: {
                transactionId: transaction.id,
                reference: transaction.reference,
                status: transaction.status,
                serviceType: transaction.service_type,
                serviceId: transaction.service_id,
                amount: parseFloat(transaction.customer_amount) || 0,
                recipient: transaction.recipient,
                network: transaction.network,
                providerStatus: transaction.provider_status,
                providerCode: transaction.provider_code,
                failureReason: transaction.failure_reason,
                token: transaction.token || null,
                units: transaction.units || null,
                refunded: transaction.refunded || false,
                createdAt: transaction.created_at,
                completedAt: transaction.completed_at
            }
        });
    } catch (error) {
        console.error('❌ Status error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch status', code: 'SERVER_ERROR' });
    }
});

router.post('/status/:id/refresh', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        if (!checkRateLimit(`refresh_${userId}_${id}`, 60 * 1000, 3)) {
            return res.status(429).json({ success: false, error: 'Too many refresh attempts. Please wait.', code: 'RATE_LIMITED' });
        }

        const { data: transaction, error } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        if (!transaction) {
            return res.status(404).json({ success: false, error: 'Transaction not found', code: 'NOT_FOUND' });
        }

        if (['completed', 'failed', 'refunded', 'cancelled'].includes(transaction.status)) {
            return res.json({
                success: true,
                data: {
                    transactionId: transaction.id,
                    reference: transaction.reference,
                    status: transaction.status,
                    message: 'Transaction is already in terminal state'
                }
            });
        }

        if (transaction.provider_request_id) {
            const requery = await vtpassService.queryTransaction(transaction.provider_request_id);

            if (requery.state === 'completed') {
                await updateTransaction(transaction.id, {
                    status: 'completed',
                    provider_status: requery.providerStatus,
                    provider_code: requery.code,
                    token: requery.token || transaction.token,
                    units: requery.units || transaction.units,
                    completed_at: new Date().toISOString()
                });
                return res.json({
                    success: true,
                    data: {
                        transactionId: transaction.id,
                        reference: transaction.reference,
                        status: 'completed',
                        token: requery.token,
                        units: requery.units
                    }
                });
            }

            if (requery.state === 'failed') {
                // ── REFUND (hardened) ────────────────────────────
                // Only attempt if not already refunded.
                let refundedOk = !!transaction.refunded;

                if (transaction.ledger_transaction_id && !refundedOk) {
                    const refundOutcome = await attemptRefund({
                        userId,
                        ledgerTransactionId: transaction.ledger_transaction_id,
                        reason: requery.friendlyError || 'Provider transaction failed',
                        sourceContext: {
                            bill_transaction_id: transaction.id,
                            reference: transaction.reference,
                            service: transaction.service_type,
                            via: 'status_refresh',
                            provider_status: requery.providerStatus,
                            provider_code: requery.code
                        }
                    });
                    refundedOk = !!refundOutcome.success;
                }

                await updateTransaction(transaction.id, {
                    status: 'failed',
                    provider_status: requery.providerStatus,
                    provider_code: requery.code,
                    failure_reason: requery.friendlyError,
                    failed_at: new Date().toISOString(),
                    refunded: refundedOk,
                    refunded_at: refundedOk ? new Date().toISOString() : (transaction.refunded_at || null)
                });

                return res.json({
                    success: true,
                    data: {
                        transactionId: transaction.id,
                        reference: transaction.reference,
                        status: 'failed',
                        error: requery.friendlyError,
                        refunded: refundedOk
                    }
                });
            }

            await updateTransaction(transaction.id, {
                provider_status: requery.providerStatus,
                provider_code: requery.code
            });
        }

        res.json({
            success: true,
            data: {
                transactionId: transaction.id,
                reference: transaction.reference,
                status: transaction.status,
                message: 'Transaction is still being processed'
            }
        });
    } catch (error) {
        console.error('❌ Refresh error:', error);
        res.status(500).json({ success: false, error: 'Failed to refresh status', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// HISTORY — merges bill_payment_transactions + airtime_transactions
// ═══════════════════════════════════════════════════════════════════════
router.get('/history', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const serviceType = req.query.service_type
            ? String(req.query.service_type).toLowerCase()
            : null;
        const statusFilter = req.query.status
            ? String(req.query.status).toLowerCase()
            : null;

        // ─── 1. Bills (VTpass) ─────────────────────────────────
        let billQuery = supabaseAdmin
            .from('bill_payment_transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(500);

        if (serviceType && BILL_TYPES.includes(serviceType)) {
            billQuery = billQuery.eq('service_type', serviceType);
        }
        if (statusFilter) {
            billQuery = billQuery.eq('status', statusFilter);
        }

        // ─── 2. Airtime (DT One) ───────────────────────────────
        // Only include if no service filter, or filter is 'airtime'.
        let airtimeQuery = null;
        if (!serviceType || serviceType === 'airtime') {
            airtimeQuery = supabaseAdmin
                .from('airtime_transactions')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(500);
            if (statusFilter) {
                airtimeQuery = airtimeQuery.eq('status', statusFilter);
            }
        }

        const [billResult, airtimeResult] = await Promise.all([
            billQuery,
            airtimeQuery || Promise.resolve({ data: [], error: null })
        ]);

        if (billResult.error && billResult.error.code !== '42P01') {
            console.error('❌ Bills history error:', billResult.error.message);
            throw billResult.error;
        }

        const bills = (billResult.data || []).map(mapBillRow);
        const airtime = (airtimeResult.data || []).map(mapAirtimeRow);

        // ─── 3. Merge & sort ───────────────────────────────────
        const merged = [...bills, ...airtime].sort((a, b) => {
            const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
            const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
            return tb - ta;
        });

        const total = merged.length;
        const paged = merged.slice(offset, offset + limit);

        res.json({
            success: true,
            data: paged,
            meta: {
                page,
                limit,
                total,
                hasMore: offset + paged.length < total
            }
        });
    } catch (error) {
        console.error('❌ History error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch history', code: 'SERVER_ERROR' });
    }
});

// ─── Row mappers ────────────────────────────────────────────────────

function mapBillRow(t) {
    const amt = num(t.customer_amount);
    const status = String(t.status || 'pending').toLowerCase();

    return {
        id: t.id,
        source: 'vtpass',
        reference: t.reference,
        service_type: t.service_type,
        service_id: t.service_id,
        status,
        recipient: t.recipient || '—',
        network: t.network || null,
        customer_amount: amt,
        currency: t.currency || 'NGN',
        provider_status: t.provider_status || null,
        provider_code: t.provider_code || null,
        token: t.token || null,
        units: t.units || null,
        refunded: !!t.refunded,
        created_at: t.created_at,
        updated_at: t.updated_at,
        completed_at: t.completed_at,
        failed_at: t.failed_at,
        failure_reason: t.failure_reason || null,
        metadata: t.metadata || {}
    };
}

function mapAirtimeRow(a) {
    // Prefer total_amount_ngn if wallet was NGN, else total_amount.
    const walletType = String(a.wallet_type || 'USD').toUpperCase();
    const amountNGN = num(a.total_amount_ngn);
    const amountUSD = num(a.total_amount);
    const amount = walletType === 'NGN' && amountNGN ? amountNGN : amountUSD;
    const currency = walletType === 'NGN' && amountNGN ? 'NGN' : (a.currency || 'USD');

    return {
        id: a.id,
        source: 'dtone',
        reference: a.reference,
        service_type: 'airtime',
        service_id: a.operator_name || a.operator_id || 'airtime',
        status: String(a.status || 'pending').toLowerCase(),
        recipient: a.phone_number || '—',
        network: a.operator_name || a.operator_id || null,
        customer_amount: amount,
        currency,
        // Destination info — the recipient's local amount
        destination_amount: num(a.destination_amount),
        destination_currency: a.destination_currency || null,
        country_code: a.country_code || null,
        country_name: a.country_name || null,
        provider_status: a.provider_status || null,
        refunded: !!a.refunded || String(a.status).toLowerCase() === 'refunded',
        created_at: a.created_at,
        updated_at: a.updated_at,
        completed_at: a.completed_at,
        failed_at: a.failed_at,
        failure_reason: a.failure_message || null,
        metadata: a.metadata || {}
    };
}

// ═══════════════════════════════════════════════════════════════════════
// WALLET BALANCE
// ═══════════════════════════════════════════════════════════════════════
router.get('/wallet/balance', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const balance = await getWalletBalance(userId, 'NGN');
        res.json({ success: true, data: { currency: 'NGN', balance } });
    } catch (error) {
        console.error('❌ Balance error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch balance', code: 'SERVER_ERROR' });
    }
});

router.get('/health', async (req, res) => {
    try {
        const vtpassHealth = await vtpassService.healthCheck();
        res.json({ success: true, vtpass: vtpassHealth, timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message, code: 'HEALTH_CHECK_FAILED' });
    }
});

module.exports = router;