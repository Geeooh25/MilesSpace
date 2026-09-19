// services/ledgerService.js
// COMPLETE LEDGER SYSTEM WITH MULTI-CURRENCY & CASHBACK SUPPORT
// FIXED: Accepts BOTH positional and object-style calls for wallet ops

const { supabaseAdmin } = require('../db/supabase');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────
const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_CURRENCY = 'NGN';
const CASHBACK_CURRENCY = 'CASHBACK';

// ─── LEDGER SERVICE ──────────────────────────────────────────────────

class LedgerService {

    /**
     * Get or create ledger account for a user.
     * Supports: NGN, USD, CASHBACK
     */
    static async getOrCreateAccount(userId, currency = DEFAULT_CURRENCY) {
        // Validate userId is a UUID-shaped string
        if (!userId || typeof userId !== 'string') {
            throw new Error(`getOrCreateAccount: userId must be a string UUID, got ${typeof userId}`);
        }

        let { data: account, error } = await supabaseAdmin
            .from('ledger_accounts')
            .select('*')
            .eq('user_id', userId)
            .eq('currency', currency)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            console.error('Ledger account lookup error:', error);
        }

        if (account) return account;

        const { data: newAccount, error: createError } = await supabaseAdmin
            .from('ledger_accounts')
            .insert({
                user_id: userId,
                currency: currency,
                available_balance: 0,
                held_balance: 0
            })
            .select()
            .single();

        if (createError) {
            console.error('Failed to create ledger account:', createError);
            throw new Error(`Failed to create ledger account: ${createError.message}`);
        }

        return newAccount;
    }

    /**
     * Get user's balance from ledger (source of truth)
     */
    static async getBalance(userId, currency = DEFAULT_CURRENCY) {
        const account = await this.getOrCreateAccount(userId, currency);
        return parseFloat(account.available_balance) || 0;
    }

    /**
     * Get all balances for a user
     */
    static async getAllBalances(userId) {
        const { data: accounts, error } = await supabaseAdmin
            .from('ledger_accounts')
            .select('currency, available_balance, held_balance')
            .eq('user_id', userId);

        if (error) {
            console.error('Failed to get balances:', error);
            return { NGN: 0, USD: 0, CASHBACK: 0 };
        }

        const balances = { NGN: 0, USD: 0, CASHBACK: 0 };
        (accounts || []).forEach(acc => {
            balances[acc.currency] = parseFloat(acc.available_balance) || 0;
        });

        return balances;
    }

    /**
     * Get cashback balance specifically
     */
    static async getCashbackBalance(userId) {
        return await this.getBalance(userId, CASHBACK_CURRENCY);
    }

    /**
     * Create a transaction with ledger entries (atomic operation)
     * Uses PostgreSQL RPC process_transaction for atomicity.
     */
    static async createTransaction({
        userId,
        type,
        amount,
        currency = DEFAULT_CURRENCY,
        description = '',
        reference = null,
        sourceType = null,
        sourceId = null,
        provider = null,
        providerReference = null,
        metadata = {},
        idempotencyKey = null
    }) {
        if (!userId || typeof userId !== 'string') {
            throw new Error(`createTransaction: userId must be a UUID string, got ${typeof userId}`);
        }

        if (!reference) {
            const prefix = (type || 'TXN').substring(0, 3).toUpperCase();
            const timestamp = Date.now().toString(36).toUpperCase();
            const random = crypto.randomBytes(4).toString('hex').toUpperCase();
            reference = `${prefix}-${timestamp}-${random}`;
        }

        if (idempotencyKey) {
            const existing = await this.checkIdempotency(userId, idempotencyKey, 'transaction');
            if (existing) return existing;
        }

        const account = await this.getOrCreateAccount(userId, currency);
        const currentBalance = parseFloat(account.available_balance) || 0;

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum)) {
            throw new Error('Invalid amount');
        }

        const newBalance = currentBalance + amountNum;
        if (newBalance < 0) {
            throw new Error(`Insufficient ${currency} balance. Available: ${currentBalance}, Required: ${Math.abs(amountNum)}`);
        }

        const transactionData = {
            user_id: userId,
            reference,
            type,
            status: 'completed',
            currency,
            amount: Math.abs(amountNum),
            description: description || type,
            source_type: sourceType,
            source_id: sourceId,
            provider,
            provider_reference: providerReference,
            metadata: {
                ...metadata,
                idempotency_key: idempotencyKey,
                balance_before: currentBalance,
                balance_after: newBalance,
                direction: amountNum >= 0 ? 'credit' : 'debit',
                currency_type: currency
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: new Date().toISOString()
        };

        const { data: result, error } = await supabaseAdmin.rpc('process_transaction', {
            p_user_id: userId,
            p_account_id: account.id,
            p_transaction_data: transactionData,
            p_entry_type: amountNum >= 0 ? 'CREDIT' : 'DEBIT',
            p_amount: Math.abs(amountNum),
            p_currency: currency,
            p_balance_before: currentBalance,
            p_balance_after: newBalance
        });

        if (error) {
            console.error('Transaction processing error:', error);
            throw new Error(`Transaction failed: ${error.message}`);
        }

        // Result can be an object or an array depending on the RPC definition
        const transactionId =
            (Array.isArray(result) ? result[0]?.transaction_id : result?.transaction_id) ||
            result?.id ||
            null;

        if (idempotencyKey) {
            await this.saveIdempotencyKey(userId, idempotencyKey, 'transaction', {
                transaction_id: transactionId,
                reference,
                status: 'completed',
                currency,
                amount: Math.abs(amountNum)
            });
        }

        return {
            success: true,
            transaction_id: transactionId,
            reference,
            amount: Math.abs(amountNum),
            currency,
            balance_before: currentBalance,
            balance_after: newBalance,
            entry_type: amountNum >= 0 ? 'CREDIT' : 'DEBIT'
        };
    }

    /**
     * ─────────────────────────────────────────────────────────────────
     * creditWallet — accepts BOTH call styles:
     *
     *   // Object style (preferred)
     *   LedgerService.creditWallet({ userId, amount, currency, reference, description, metadata })
     *
     *   // Positional style (legacy)
     *   LedgerService.creditWallet(userId, amount, currency, description, metadata)
     * ─────────────────────────────────────────────────────────────────
     */
    static async creditWallet(...args) {
        const opts = this._normalizeWalletArgs(args, 'credit');

        return await this.createTransaction({
            userId: opts.userId,
            type: opts.type || 'wallet_credit',
            amount: Math.abs(opts.amount),
            currency: opts.currency,
            description: opts.description,
            reference: opts.reference,
            sourceType: opts.sourceType,
            sourceId: opts.sourceId,
            metadata: opts.metadata
        });
    }

    /**
     * ─────────────────────────────────────────────────────────────────
     * debitWallet — accepts BOTH call styles:
     *
     *   // Object style (preferred)
     *   LedgerService.debitWallet({ userId, amount, currency, reference, description, metadata })
     *
     *   // Positional style (legacy)
     *   LedgerService.debitWallet(userId, amount, currency, description, metadata)
     * ─────────────────────────────────────────────────────────────────
     */
    static async debitWallet(...args) {
        const opts = this._normalizeWalletArgs(args, 'debit');

        return await this.createTransaction({
            userId: opts.userId,
            type: opts.type || 'wallet_debit',
            amount: -Math.abs(opts.amount),
            currency: opts.currency,
            description: opts.description,
            reference: opts.reference,
            sourceType: opts.sourceType,
            sourceId: opts.sourceId,
            metadata: opts.metadata
        });
    }

    /**
     * Normalizes wallet call arguments from either style.
     * Detects object style by looking for `.userId` on the first argument.
     */
    static _normalizeWalletArgs(args, action) {
        const first = args[0];

        // ─── Object style ───
        if (first && typeof first === 'object' && 'userId' in first) {
            const o = first;
            const amount = parseFloat(o.amount);
            if (!o.userId || typeof o.userId !== 'string') {
                throw new Error(`${action}Wallet: missing or invalid userId`);
            }
            if (!Number.isFinite(amount) || amount <= 0) {
                throw new Error(`${action}Wallet: invalid amount (${o.amount})`);
            }
            return {
                userId: o.userId,
                amount,
                currency: o.currency || DEFAULT_CURRENCY,
                description: o.description || `${action === 'credit' ? 'Wallet credit' : 'Wallet debit'}`,
                reference: o.reference || null,
                sourceType: o.sourceType || null,
                sourceId: o.sourceId || null,
                metadata: o.metadata || {},
                type: o.type || (action === 'credit' ? 'wallet_credit' : 'wallet_debit')
            };
        }

        // ─── Positional style: (userId, amount, currency, description, metadata) ───
        const [userId, amount, currency, description, metadata] = args;
        if (!userId || typeof userId !== 'string') {
            throw new Error(`${action}Wallet: missing or invalid userId`);
        }
        const amountNum = parseFloat(amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            throw new Error(`${action}Wallet: invalid amount (${amount})`);
        }
        return {
            userId,
            amount: amountNum,
            currency: currency || DEFAULT_CURRENCY,
            description: description || `${action === 'credit' ? 'Wallet credit' : 'Wallet debit'}`,
            reference: null,
            sourceType: null,
            sourceId: null,
            metadata: metadata || {},
            type: action === 'credit' ? 'wallet_credit' : 'wallet_debit'
        };
    }

    /**
     * Add cashback to user's cashback balance
     */
    static async addCashback(userId, amount, description = '', sourceType = null, sourceId = null) {
        if (amount <= 0) {
            throw new Error('Cashback amount must be greater than 0');
        }
        return await this.createTransaction({
            userId,
            type: 'cashback_earned',
            amount,
            currency: CASHBACK_CURRENCY,
            description: description || 'Cashback earned',
            sourceType: sourceType || 'cashback',
            sourceId,
            metadata: { cashback_type: 'earned', source: sourceType, source_id: sourceId }
        });
    }

    /**
     * Use cashback (debit from cashback balance)
     */
    static async useCashback(userId, amount, description = '', sourceType = null, sourceId = null) {
        if (amount <= 0) {
            throw new Error('Cashback amount must be greater than 0');
        }
        const balance = await this.getCashbackBalance(userId);
        if (balance < amount) {
            throw new Error(`Insufficient cashback balance. Available: ₦${balance.toFixed(2)}, Required: ₦${amount.toFixed(2)}`);
        }
        return await this.createTransaction({
            userId,
            type: 'cashback_used',
            amount: -amount,
            currency: CASHBACK_CURRENCY,
            description: description || 'Cashback used',
            sourceType: sourceType || 'cashback',
            sourceId,
            metadata: { cashback_type: 'used', source: sourceType, source_id: sourceId }
        });
    }

    /**
     * Check idempotency key
     */
    static async checkIdempotency(userId, idempotencyKey, endpoint) {
        if (!idempotencyKey) return null;

        const { data, error } = await supabaseAdmin
            .from('idempotency_keys')
            .select('response, status, created_at, expires_at')
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .eq('endpoint', endpoint)
            .maybeSingle();

        if (error || !data) return null;
        if (data.expires_at && new Date(data.expires_at) < new Date()) return null;

        return data.response || { already_processed: true };
    }

    /**
     * Save idempotency key
     */
    static async saveIdempotencyKey(userId, idempotencyKey, endpoint, response) {
        try {
            const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL);
            await supabaseAdmin
                .from('idempotency_keys')
                .insert({
                    user_id: userId,
                    idempotency_key: idempotencyKey,
                    endpoint,
                    response,
                    status: 'completed',
                    created_at: new Date().toISOString(),
                    expires_at: expiresAt.toISOString()
                });
        } catch (error) {
            console.warn('Failed to save idempotency key:', error.message);
        }
    }

    /**
     * ─────────────────────────────────────────────────────────────────
     * refundTransaction — accepts BOTH styles:
     *
     *   // Object style (preferred)
     *   LedgerService.refundTransaction({ userId, transactionId, reference, reason })
     *
     *   // Positional style (legacy)
     *   LedgerService.refundTransaction(userId, originalTransactionId, reason)
     * ─────────────────────────────────────────────────────────────────
     */
    static async refundTransaction(...args) {
        let userId, originalTransactionId, reason;

        const first = args[0];
        if (first && typeof first === 'object' && 'userId' in first) {
            userId = first.userId;
            originalTransactionId = first.transactionId || first.originalTransactionId;
            reason = first.reason || 'Refund';
        } else {
            [userId, originalTransactionId, reason] = args;
            reason = reason || 'Refund';
        }

        if (!userId || !originalTransactionId) {
            throw new Error('refundTransaction: userId and transactionId are required');
        }

        console.log(`🔍 [REFUND] Looking for transaction: ${originalTransactionId}`);

        // ─── 1. Find the original transaction by ID ───
        let original = null;

        // Try by UUID
        const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(originalTransactionId));
        if (looksLikeUuid) {
            const { data, error } = await supabaseAdmin
                .from('transactions')
                .select('*')
                .eq('id', originalTransactionId)
                .eq('user_id', userId)
                .maybeSingle();

            if (data) original = data;
            if (error) console.warn('[REFUND] Lookup by id error:', error.message);
        }

        // Fallback: by reference
        if (!original) {
            const { data: byRef } = await supabaseAdmin
                .from('transactions')
                .select('*')
                .eq('reference', originalTransactionId)
                .eq('user_id', userId)
                .maybeSingle();
            if (byRef) {
                console.log(`🔍 [REFUND] Found by reference instead: ${byRef.id}`);
                original = byRef;
            }
        }

        if (!original) {
            throw new Error(`Original transaction not found (ID/ref: ${originalTransactionId})`);
        }

        console.log(`🔍 [REFUND] Found original transaction:`, {
            id: original.id,
            reference: original.reference,
            type: original.type,
            status: original.status,
            amount: original.amount,
            currency: original.currency
        });

        // ─── 2. Only wallet debits can be refunded ───
        if (original.type !== 'wallet_debit' && original.type !== 'cashback_used') {
            throw new Error(`Transaction type "${original.type}" cannot be refunded`);
        }

        // ─── 3. Prevent duplicate refunds ───
        const { data: existingRefund } = await supabaseAdmin
            .from('transactions')
            .select('id, reference, status, amount')
            .eq('user_id', userId)
            .eq('source_id', original.id)
            .eq('type', 'refund')
            .maybeSingle();

        if (existingRefund) {
            console.log('ℹ️ [REFUND] Transaction already refunded:', existingRefund.id);
            return {
                success: true,
                alreadyRefunded: true,
                transaction_id: existingRefund.id,
                reference: existingRefund.reference,
                amount: existingRefund.amount
            };
        }

        if (original.status === 'refunded') {
            throw new Error('Transaction already refunded');
        }

        const refundAmount = parseFloat(original.amount) || 0;
        const currency = original.currency || DEFAULT_CURRENCY;

        if (refundAmount <= 0) {
            throw new Error('Invalid original transaction amount');
        }

        // ─── 4. Create refund transaction (credit back) ───
        console.log(`💸 [REFUND] Creating refund transaction for ${currency} ${refundAmount}`);

        const refundResult = await this.createTransaction({
            userId,
            type: 'refund',
            amount: refundAmount,
            currency,
            description: `${reason}: ${original.description || original.type}`,
            sourceType: 'refund',
            sourceId: original.id,
            metadata: {
                original_transaction_id: original.id,
                original_reference: original.reference,
                original_type: original.type,
                original_amount: original.amount,
                reason
            }
        });

        // ─── 5. Mark original as refunded ───
        const { error: updateError } = await supabaseAdmin
            .from('transactions')
            .update({
                status: 'refunded',
                updated_at: new Date().toISOString()
            })
            .eq('id', original.id)
            .eq('user_id', userId);

        if (updateError) {
            console.warn('⚠️ [REFUND] Failed to mark original as refunded:', updateError.message);
        }

        console.log(`✅ [REFUND] Refund complete: ${refundResult.reference}`);

        return {
            success: true,
            transaction_id: refundResult.transaction_id,
            reference: refundResult.reference,
            amount: refundAmount,
            currency,
            original_transaction_id: original.id,
            original_reference: original.reference
        };
    }

    /**
     * Get transaction history for a user
     */
    static async getTransactionHistory(userId, limit = 50, offset = 0, filters = {}) {
        let query = supabaseAdmin
            .from('transactions')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (filters.type) query = query.eq('type', filters.type);
        if (filters.status) query = query.eq('status', filters.status);
        if (filters.currency) query = query.eq('currency', filters.currency);

        const { data, error, count } = await query.range(offset, offset + limit - 1);

        if (error) throw error;
        return { transactions: data || [], total: count || 0 };
    }

    static async getTransactionByReference(reference) {
        const { data, error } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('reference', reference)
            .maybeSingle();
        if (error) return null;
        return data;
    }

    static async getTransactionById(id) {
        const { data, error } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (error) return null;
        return data;
    }
}

// ─── ADMIN CONFIG SERVICE ───────────────────────────────────────────

class AdminConfigService {
    static async getSettings() {
        const { data, error } = await supabaseAdmin.from('app_config').select('*');
        if (error) {
            console.error('Failed to fetch settings:', error);
            return this.getDefaultSettings();
        }
        const settings = {};
        (data || []).forEach(item => { settings[item.key] = item.value; });
        return settings;
    }

    static getDefaultSettings() {
        return {
            usd_to_ngn: '1620',
            boost_markup: '18',
            gift_card_markup: '10',
            virtual_sms_markup: '15',
            marketplace_markup: '20',
            cashback_rate: '5',
            min_redeem: '50',
            max_redeem: '100000'
        };
    }

    static async updateSetting(key, value) {
        const { error } = await supabaseAdmin
            .from('app_config')
            .upsert({ key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: 'key' });
        if (error) throw new Error(`Failed to update ${key}`);
        return { success: true, key, value };
    }

    static async getExchangeRate() {
        const settings = await this.getSettings();
        return parseFloat(settings.usd_to_ngn) || 1620;
    }

    static async getMarkup(service) {
        const settings = await this.getSettings();
        return parseFloat(settings[`${service}_markup`]) || 18;
    }

    static async getCashbackRate() {
        const settings = await this.getSettings();
        return parseFloat(settings.cashback_rate) || 5;
    }
}

module.exports = {
    LedgerService,
    AdminConfigService,
    CASHBACK_CURRENCY
};