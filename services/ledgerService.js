'use strict';

// services/ledgerService.js
//
// The ledger is the ONLY authority that changes wallet balances.

const { supabaseAdmin } = require('../db/supabase');
const crypto = require('crypto');
const IdempotencyService = require('./idempotencyService');

const DEFAULT_CURRENCY = 'NGN';
const SUPPORTED_CURRENCIES = new Set(['NGN', 'USD']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TYPE_DIRECTION = {
    deposit:       'credit',
    wallet_credit: 'credit',
    refund:        'credit',
    adjustment:    'both',
    wallet_debit:  'debit',
    withdrawal:    'debit',
    fee_revenue:   'credit'
};

const HISTORICAL_TYPES = new Set(['cashback_redeem', 'cashback']);

const ACCOUNT_COLUMNS = 'id, user_id, currency, available_balance, held_balance, created_at, updated_at';
const ENTRY_COLUMNS = 'id, account_id, transaction_id, entry_type, amount, currency, balance_before, balance_after, description, created_at';
const TX_COLUMNS_MIN = 'id, user_id, type, status, currency, amount, reference, source_type, source_id, created_at, completed_at';
const TX_COLUMNS_VERIFY = 'id, user_id, type, status, currency, amount, reference, source_type, source_id, provider, provider_reference, created_at, completed_at';

function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

function assertPrecision(amount, currency) {
    const rounded = round2(amount);
    if (Math.abs(rounded - Number(amount)) > 1e-6) {
        throw new Error(`createTransaction: amount ${amount} has more precision than ${currency} supports`);
    }
    return rounded;
}

class LedgerService {

    static async getOrCreateAccount(userId, currency = DEFAULT_CURRENCY) {
        if (!UUID_RE.test(String(userId || ''))) {
            throw new Error('getOrCreateAccount: userId must be a UUID');
        }
        const ccy = String(currency).toUpperCase();
        if (!SUPPORTED_CURRENCIES.has(ccy)) {
            throw new Error(`getOrCreateAccount: unsupported currency ${ccy}`);
        }

        const { data: account, error: readErr } = await supabaseAdmin
            .from('ledger_accounts')
            .select(ACCOUNT_COLUMNS)
            .eq('user_id', userId)
            .eq('currency', ccy)
            .maybeSingle();

        if (readErr) throw new Error(`Failed to read ledger account: ${readErr.message}`);
        if (account) return account;

        const { data: newAccount, error: insertErr } = await supabaseAdmin
            .from('ledger_accounts')
            .insert({ user_id: userId, currency: ccy, available_balance: 0, held_balance: 0 })
            .select(ACCOUNT_COLUMNS)
            .single();

        if (insertErr) {
            if (insertErr.code === '23505') {
                const { data: reread, error: reErr } = await supabaseAdmin
                    .from('ledger_accounts')
                    .select(ACCOUNT_COLUMNS)
                    .eq('user_id', userId)
                    .eq('currency', ccy)
                    .maybeSingle();
                if (reErr) throw new Error(`Failed to reread ledger account: ${reErr.message}`);
                if (reread) return reread;
            }
            throw new Error(`Failed to create ledger account: ${insertErr.message}`);
        }
        return newAccount;
    }

    static async getBalance(userId, currency = DEFAULT_CURRENCY) {
        const account = await this.getOrCreateAccount(userId, currency);
        return parseFloat(account.available_balance) || 0;
    }

    static async getAllBalances(userId) {
        if (!UUID_RE.test(String(userId || ''))) {
            throw new Error('getAllBalances: userId must be a UUID');
        }
        const { data, error } = await supabaseAdmin
            .from('ledger_accounts')
            .select('currency, available_balance, held_balance')
            .eq('user_id', userId);
        if (error) throw new Error(`Failed to load balances: ${error.message}`);

        const balances = { NGN: 0, USD: 0 };
        (data || []).forEach(a => {
            const ccy = String(a.currency || '').toUpperCase();
            if (ccy === 'NGN' || ccy === 'USD') {
                balances[ccy] = parseFloat(a.available_balance) || 0;
            }
        });
        return balances;
    }

    static async createTransaction({
        userId, type, amount, currency = DEFAULT_CURRENCY, description = '',
        reference = null, sourceType = null, sourceId = null,
        provider = null, providerReference = null,
        metadata = {}, idempotencyKey = null
    }) {
        if (!UUID_RE.test(String(userId || ''))) {
            throw new Error('createTransaction: userId must be a UUID');
        }
        const ccy = String(currency).toUpperCase();
        if (!SUPPORTED_CURRENCIES.has(ccy)) {
            throw new Error(`createTransaction: unsupported currency ${ccy}`);
        }

        if (HISTORICAL_TYPES.has(String(type))) {
            throw new Error(`createTransaction: "${type}" is retired and cannot be created`);
        }

        const rawAmount = parseFloat(amount);
        if (!Number.isFinite(rawAmount) || rawAmount === 0) {
            throw new Error('createTransaction: amount must be a non-zero finite number');
        }
        const amountNum = assertPrecision(Math.abs(rawAmount), ccy);

        const direction = rawAmount > 0 ? 'credit' : 'debit';
        const expectedDirection = TYPE_DIRECTION[type];
        if (!expectedDirection) {
            throw new Error(`createTransaction: unknown or retired transaction type "${type}"`);
        }
        if (expectedDirection !== 'both' && expectedDirection !== direction) {
            throw new Error(`createTransaction: type "${type}" must be ${expectedDirection}, got ${direction}`);
        }

        if (!reference) {
            const prefix = (type || 'TXN').substring(0, 3).toUpperCase();
            const ts = Date.now().toString(36).toUpperCase();
            const rnd = crypto.randomBytes(4).toString('hex').toUpperCase();
            reference = `${prefix}-${ts}-${rnd}`;
        }

        // ── Idempotency ──────────────────────────────────────
        if (idempotencyKey) {
            const existing = await IdempotencyService.check(userId, idempotencyKey, 'transaction');
            if (existing && !existing.__in_flight) return existing;

            const claimed = await IdempotencyService.claim(
                userId, idempotencyKey, 'transaction',
                { type, amount: amountNum, currency: ccy, reference }
            );
            if (!claimed) {
                const inFlight = await IdempotencyService.check(userId, idempotencyKey, 'transaction');
                if (inFlight && !inFlight.__in_flight) return inFlight;
                throw new Error('Duplicate transaction in progress for this idempotency key');
            }
        }

        // ── Account ──────────────────────────────────────────
        let account;
        try {
            account = await this.getOrCreateAccount(userId, ccy);
        } catch (acctErr) {
            if (idempotencyKey) {
                await IdempotencyService.release(userId, idempotencyKey, 'transaction').catch(() => {});
            }
            throw acctErr;
        }

        const nowIso = new Date().toISOString();

        const transactionData = {
            user_id: userId,
            reference,
            type,
            status: 'completed',
            currency: ccy,
            amount: amountNum,
            description: description || type,
            source_type: sourceType,
            source_id: sourceId,
            provider,
            provider_reference: providerReference,
            metadata: { ...metadata, direction, currency_type: ccy },
            created_at: nowIso,
            updated_at: nowIso,
            completed_at: nowIso
        };

        // ── RPC ──────────────────────────────────────────────
        const { data: result, error } = await supabaseAdmin.rpc('process_transaction_v2', {
            p_user_id:          userId,
            p_account_id:       account.id,
            p_transaction_data: transactionData,
            p_entry_type:       direction === 'credit' ? 'CREDIT' : 'DEBIT',
            p_amount:           amountNum,
            p_currency:         ccy
        });

        if (error) {
            if (idempotencyKey) {
                await IdempotencyService.release(userId, idempotencyKey, 'transaction').catch(() => {});
            }

            if (error.code === '23505') {
                const existingTx = await this.getTransactionByReferenceForVerification(reference);
                if (!existingTx) {
                    throw new Error(`Transaction failed: 23505 but no row found for reference ${reference}`);
                }
                const sameUser        = String(existingTx.user_id) === String(userId);
                const sameType        = String(existingTx.type) === String(type);
                const sameCurrency    = String(existingTx.currency).toUpperCase() === ccy;
                const sameAmount      = Math.abs(parseFloat(existingTx.amount) - amountNum) < 0.005;
                const sameSourceType  = String(existingTx.source_type || '') === String(sourceType || '');
                const sameSourceId    = String(existingTx.source_id || '') === String(sourceId || '');
                const sameProviderRef = String(existingTx.provider_reference || '') === String(providerReference || '');

                if (!sameUser || !sameType || !sameCurrency || !sameAmount ||
                    !sameSourceType || !sameSourceId || !sameProviderRef) {
                    throw new Error(
                        `Transaction failed: reference ${reference} exists but does not match the intended operation.`
                    );
                }
                return {
                    success: true,
                    already_exists: true,
                    transaction_id: existingTx.id,
                    reference,
                    amount: amountNum,
                    currency: ccy
                };
            }

            throw new Error(`Transaction failed: ${error.message}`);
        }

        // ── Success ──────────────────────────────────────────
        const payload = Array.isArray(result) ? result[0] : result;
        let transactionId = payload?.transaction_id || payload?.id || null;

        if (!transactionId) {
            const recovered = await this.getTransactionByReferenceForVerification(reference);
            transactionId = recovered?.id || null;
            if (!transactionId) {
                if (idempotencyKey) {
                    await IdempotencyService.release(userId, idempotencyKey, 'transaction').catch(() => {});
                }
                throw new Error(`Transaction failed: RPC returned no transaction_id for ${reference}`);
            }
        }

        const finalResponse = {
            success: true,
            transaction_id: transactionId,
            reference,
            amount: amountNum,
            currency: ccy,
            balance_before: payload?.balance_before ?? null,
            balance_after:  payload?.balance_after  ?? null,
            entry_type: direction === 'credit' ? 'CREDIT' : 'DEBIT'
        };

        if (idempotencyKey) {
            try {
                await IdempotencyService.save(userId, idempotencyKey, 'transaction', finalResponse);
            } catch (saveErr) {
                console.error('[LEDGER] idempotency save failed after ledger write', {
                    userId, idempotencyKey, reference, transactionId,
                    error: saveErr.message
                });
            }
        }

        return finalResponse;
    }

    static async creditWallet(...args) {
        const o = this._normalizeWalletArgs(args, 'credit');
        return await this.createTransaction({
            userId: o.userId, type: o.type || 'wallet_credit', amount: Math.abs(o.amount),
            currency: o.currency, description: o.description, reference: o.reference,
            sourceType: o.sourceType, sourceId: o.sourceId, provider: o.provider || null,
            providerReference: o.providerReference || null, metadata: o.metadata,
            idempotencyKey: o.idempotencyKey || null
        });
    }

    static async debitWallet(...args) {
        const o = this._normalizeWalletArgs(args, 'debit');
        return await this.createTransaction({
            userId: o.userId, type: o.type || 'wallet_debit', amount: -Math.abs(o.amount),
            currency: o.currency, description: o.description, reference: o.reference,
            sourceType: o.sourceType, sourceId: o.sourceId, provider: o.provider || null,
            providerReference: o.providerReference || null, metadata: o.metadata,
            idempotencyKey: o.idempotencyKey || null
        });
    }

    static _normalizeWalletArgs(args, action) {
        const first = args[0];
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
                userId: o.userId, amount, currency: o.currency || DEFAULT_CURRENCY,
                description: o.description || (action === 'credit' ? 'Wallet credit' : 'Wallet debit'),
                reference: o.reference || null,
                sourceType: o.sourceType || null, sourceId: o.sourceId || null,
                provider: o.provider || null, providerReference: o.providerReference || null,
                metadata: o.metadata || {},
                type: o.type || (action === 'credit' ? 'wallet_credit' : 'wallet_debit'),
                idempotencyKey: o.idempotencyKey || null
            };
        }
        const [userId, amount, currency, description, metadata] = args;
        if (!userId || typeof userId !== 'string') throw new Error(`${action}Wallet: missing or invalid userId`);
        const n = parseFloat(amount);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`${action}Wallet: invalid amount (${amount})`);
        return {
            userId, amount: n, currency: currency || DEFAULT_CURRENCY,
            description: description || (action === 'credit' ? 'Wallet credit' : 'Wallet debit'),
            reference: null, sourceType: null, sourceId: null,
            provider: null, providerReference: null,
            metadata: metadata || {},
            type: action === 'credit' ? 'wallet_credit' : 'wallet_debit',
            idempotencyKey: null
        };
    }

    static async getTransactionHistory(userId, limit = 50, offset = 0, filters = {}) {
        const safeLimit  = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

        let q = supabaseAdmin
            .from('transactions')
            .select(TX_COLUMNS_MIN, { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        if (filters.type) q = q.eq('type', filters.type);
        if (filters.status) q = q.eq('status', filters.status);
        if (filters.currency) q = q.eq('currency', filters.currency);
        const { data, error, count } = await q.range(safeOffset, safeOffset + safeLimit - 1);
        if (error) throw error;
        return { transactions: data || [], total: count || 0 };
    }

    static async getTransactionByReference(reference) {
        const { data, error } = await supabaseAdmin
            .from('transactions').select(TX_COLUMNS_MIN).eq('reference', reference).maybeSingle();
        if (error) throw new Error(`getTransactionByReference failed: ${error.message}`);
        return data || null;
    }

    static async getTransactionByReferenceForVerification(reference) {
        const { data, error } = await supabaseAdmin
            .from('transactions').select(TX_COLUMNS_VERIFY).eq('reference', reference).maybeSingle();
        if (error) throw new Error(`getTransactionByReferenceForVerification failed: ${error.message}`);
        return data || null;
    }

    static async getTransactionById(id) {
        const { data, error } = await supabaseAdmin
            .from('transactions').select(TX_COLUMNS_MIN).eq('id', id).maybeSingle();
        if (error) throw new Error(`getTransactionById failed: ${error.message}`);
        return data || null;
    }

    static async getLedgerEntriesByTransaction(transactionId) {
        if (!UUID_RE.test(String(transactionId || ''))) return [];
        const { data, error } = await supabaseAdmin
            .from('ledger_entries').select(ENTRY_COLUMNS)
            .eq('transaction_id', transactionId).order('created_at', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }
}

class AdminConfigService {
    static ALLOWED_KEYS = new Set([
        'usd_to_ngn', 'boost_markup', 'gift_card_markup',
        'virtual_sms_markup', 'marketplace_markup', 'airtime_markup'
    ]);

    static async getSettingsOrNull() {
        const { data, error } = await supabaseAdmin.from('app_config').select('key, value');
        if (error) return null;
        const settings = {};
        (data || []).forEach(item => { settings[item.key] = item.value; });
        return settings;
    }

    static async getSettings() {
        const s = await this.getSettingsOrNull();
        if (s === null) {
            console.error('[ADMIN CONFIG] database read failed');
            throw new Error('Configuration unavailable');
        }
        return s;
    }

    static getDefaultSettings() {
        return {
            usd_to_ngn: '1620', boost_markup: '18', gift_card_markup: '10',
            virtual_sms_markup: '15', marketplace_markup: '20', airtime_markup: '18'
        };
    }

    static async updateSetting(key, value) {
        if (!this.ALLOWED_KEYS.has(key)) {
            throw new Error(`updateSetting: "${key}" is not an editable setting`);
        }
        const n = parseFloat(value);
        if (!Number.isFinite(n) || n <= 0 || n > 1000000) {
            throw new Error(`updateSetting: "${key}" must be a positive finite number`);
        }
        const { error } = await supabaseAdmin
            .from('app_config')
            .upsert({ key, value: String(n), updated_at: new Date().toISOString() }, { onConflict: 'key' });
        if (error) throw new Error(`Failed to update ${key}: ${error.message}`);
        return { success: true, key, value: n };
    }

    static async getExchangeRate() {
        const s = await this.getSettings();
        const n = parseFloat(s.usd_to_ngn);
        if (!Number.isFinite(n) || n <= 0) throw new Error('getExchangeRate: usd_to_ngn is not configured');
        return n;
    }

    static async getMarkup(service) {
        const s = await this.getSettings();
        const raw = s[`${service}_markup`];
        const n = parseFloat(raw);
        if (!Number.isFinite(n) || n < 0) throw new Error(`getMarkup: "${service}_markup" is not configured`);
        return n;
    }
}

module.exports = { LedgerService, AdminConfigService };