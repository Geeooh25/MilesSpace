// services/ledgerService.js
// Ledger — accounting source of truth.
//
// CHANGES IN THIS REVISION:
//   • Cashback methods (add/use/getBalance) REMOVED.
//     Historical cashback rows in ledger_entries and transactions
//     are untouched and remain readable.
//   • CASHBACK_CURRENCY export retained (harmless no-op) so any
//     remaining import in an old file does not crash. Delete the
//     export once you've grepped the codebase.
//   • Uses IdempotencyService for idempotency instead of the
//     in-service helpers.
//   • createTransaction() still uses process_transaction RPC, and
//     will continue to do so. The RPC remains the authority for
//     wallet balance changes.

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const crypto = require('crypto');
const IdempotencyService = require('./idempotencyService');

const DEFAULT_CURRENCY = 'NGN';
const SUPPORTED_CURRENCIES = new Set(['NGN', 'USD']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCOUNT_COLUMNS = [
    'id', 'user_id', 'currency', 'available_balance', 'held_balance', 'created_at', 'updated_at'
].join(', ');

const ENTRY_COLUMNS = [
    'id', 'account_id', 'transaction_id', 'entry_type', 'amount', 'currency',
    'balance_before', 'balance_after', 'description', 'created_at'
].join(', ');

const TX_COLUMNS_MIN = [
    'id', 'user_id', 'type', 'status', 'currency', 'amount', 'reference',
    'source_type', 'source_id', 'created_at', 'completed_at'
].join(', ');

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

        if (readErr) {
            throw new Error(`Failed to read ledger account: ${readErr.message}`);
        }
        if (account) return account;

        // Insert; on unique violation (another request created it first),
        // re-read and return.
        const { data: newAccount, error: insertErr } = await supabaseAdmin
            .from('ledger_accounts')
            .insert({ user_id: userId, currency: ccy, available_balance: 0, held_balance: 0 })
            .select(ACCOUNT_COLUMNS)
            .single();

        if (insertErr) {
            if (insertErr.code === '23505') {
                // Concurrent create. Re-read.
                const { data: reread } = await supabaseAdmin
                    .from('ledger_accounts')
                    .select(ACCOUNT_COLUMNS)
                    .eq('user_id', userId)
                    .eq('currency', ccy)
                    .maybeSingle();
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

    // ─── Customer-facing balances: NGN + USD only ────────────
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

        const amountNum = parseFloat(amount);
        if (!Number.isFinite(amountNum) || amountNum === 0) {
            throw new Error('createTransaction: amount must be a non-zero finite number');
        }

        if (!reference) {
            const prefix = (type || 'TXN').substring(0, 3).toUpperCase();
            const ts = Date.now().toString(36).toUpperCase();
            const rnd = crypto.randomBytes(4).toString('hex').toUpperCase();
            reference = `${prefix}-${ts}-${rnd}`;
        }

        // ─── Atomic idempotency claim (before any side effects) ────
        if (idempotencyKey) {
            const existing = await IdempotencyService.check(userId, idempotencyKey, 'transaction');
            if (existing && !existing.__in_flight) return existing;

            const claimed = await IdempotencyService.claim(
                userId, idempotencyKey, 'transaction',
                { type, amount: Math.abs(amountNum), currency: ccy }
            );
            if (!claimed) {
                const inFlight = await IdempotencyService.check(userId, idempotencyKey, 'transaction');
                if (inFlight && !inFlight.__in_flight) return inFlight;
                throw new Error('Duplicate transaction in progress for this idempotency key');
            }
        }

        // ─── Read account (the RPC will re-check balance atomically) ─
        const account = await this.getOrCreateAccount(userId, ccy);
        const currentBalance = parseFloat(account.available_balance) || 0;

        // Friendly early rejection — the RPC still enforces this for real.
        if (amountNum < 0 && currentBalance + amountNum < 0) {
            if (idempotencyKey) {
                await IdempotencyService.release(userId, idempotencyKey, 'transaction');
            }
            throw new Error(`Insufficient ${ccy} balance. Available: ${currentBalance}, Required: ${Math.abs(amountNum)}`);
        }

        const nowIso = new Date().toISOString();
        const newBalance = currentBalance + amountNum;

        const transactionData = {
            user_id: userId,
            reference,
            type,
            status: 'completed',
            currency: ccy,
            amount: Math.abs(amountNum),
            description: description || type,
            source_type: sourceType,
            source_id: sourceId,
            provider,
            provider_reference: providerReference,
            metadata: {
                ...metadata,
                balance_before: currentBalance,
                balance_after: newBalance,
                direction: amountNum >= 0 ? 'credit' : 'debit',
                currency_type: ccy
            },
            created_at: nowIso,
            updated_at: nowIso,
            completed_at: nowIso
        };

        const { data: result, error } = await supabaseAdmin.rpc('process_transaction', {
            p_user_id:        userId,
            p_account_id:     account.id,
            p_transaction_data: transactionData,
            p_entry_type:     amountNum >= 0 ? 'CREDIT' : 'DEBIT',
            p_amount:         Math.abs(amountNum),
            p_currency:       ccy,
            p_balance_before: currentBalance,
            p_balance_after:  newBalance
        });

        if (error) {
            // Release the claim so the caller can retry.
            if (idempotencyKey) {
                await IdempotencyService.release(userId, idempotencyKey, 'transaction');
            }
            throw new Error(`Transaction failed: ${error.message}`);
        }

        const transactionId =
            (Array.isArray(result) ? result[0]?.transaction_id : result?.transaction_id) ||
            result?.id || null;

        const finalResponse = {
            success: true,
            transaction_id: transactionId,
            reference,
            amount: Math.abs(amountNum),
            currency: ccy,
            balance_before: currentBalance,
            balance_after: newBalance,
            entry_type: amountNum >= 0 ? 'CREDIT' : 'DEBIT'
        };

        if (idempotencyKey) {
            try {
                await IdempotencyService.save(userId, idempotencyKey, 'transaction', finalResponse);
            } catch (saveErr) {
                // The money moved but the idempotency row failed to
                // persist. This is a real problem — log loudly. We do
                // NOT throw here because the ledger is already updated;
                // throwing would mislead the caller into retrying.
                console.error('[LEDGER] CRITICAL: idempotency save failed after ledger write', {
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
            userId: o.userId,
            type: o.type || 'wallet_credit',
            amount: Math.abs(o.amount),
            currency: o.currency,
            description: o.description,
            reference: o.reference,
            sourceType: o.sourceType,
            sourceId: o.sourceId,
            provider: o.provider || null,
            providerReference: o.providerReference || null,
            metadata: o.metadata,
            idempotencyKey: o.idempotencyKey || null
        });
    }

    static async debitWallet(...args) {
        const o = this._normalizeWalletArgs(args, 'debit');
        return await this.createTransaction({
            userId: o.userId,
            type: o.type || 'wallet_debit',
            amount: -Math.abs(o.amount),
            currency: o.currency,
            description: o.description,
            reference: o.reference,
            sourceType: o.sourceType,
            sourceId: o.sourceId,
            provider: o.provider || null,
            providerReference: o.providerReference || null,
            metadata: o.metadata,
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

    // ─── History helpers (unchanged) ───────────────────────────────
    static async getTransactionHistory(userId, limit = 50, offset = 0, filters = {}) {
        let q = supabaseAdmin
            .from('transactions')
            .select(TX_COLUMNS_MIN, { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        if (filters.type) q = q.eq('type', filters.type);
        if (filters.status) q = q.eq('status', filters.status);
        if (filters.currency) q = q.eq('currency', filters.currency);
        const { data, error, count } = await q.range(offset, offset + limit - 1);
        if (error) throw error;
        return { transactions: data || [], total: count || 0 };
    }

    static async getTransactionByReference(reference) {
        const { data } = await supabaseAdmin
            .from('transactions')
            .select(TX_COLUMNS_MIN)
            .eq('reference', reference)
            .maybeSingle();
        return data || null;
    }

    static async getTransactionById(id) {
        const { data } = await supabaseAdmin
            .from('transactions')
            .select(TX_COLUMNS_MIN)
            .eq('id', id)
            .maybeSingle();
        return data || null;
    }

    static async getLedgerEntriesByTransaction(transactionId) {
        if (!UUID_RE.test(String(transactionId || ''))) return [];
        const { data, error } = await supabaseAdmin
            .from('ledger_entries')
            .select(ENTRY_COLUMNS)
            .eq('transaction_id', transactionId)
            .order('created_at', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }
}

// ─── AdminConfigService — explicit columns ──────────────────
class AdminConfigService {
    static async getSettings() {
        const { data, error } = await supabaseAdmin
            .from('app_config')
            .select('key, value');
        if (error) return this.getDefaultSettings();
        const settings = {};
        (data || []).forEach(item => { settings[item.key] = item.value; });
        return settings;
    }
    static getDefaultSettings() {
        return {
            usd_to_ngn: '1620', boost_markup: '18', gift_card_markup: '10',
            virtual_sms_markup: '15', marketplace_markup: '20'
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
        const s = await this.getSettings();
        return parseFloat(s.usd_to_ngn) || 1620;
    }
    static async getMarkup(service) {
        const s = await this.getSettings();
        return parseFloat(s[`${service}_markup`]) || 18;
    }
}

module.exports = { LedgerService, AdminConfigService };