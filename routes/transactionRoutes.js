// routes/transactionRoutes.js
// COMPLETE PRODUCTION-READY VERSION
// Merges transactions + airtime_transactions + crypto_deposits into a
// unified user-facing history. EVERY deposit shows regardless of status.

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MERGE_CAP = 500;

// ─── HELPERS ──────────────────────────────────────────────────────────

function parseLimit(value) {
    const parsed = parseInt(value);
    if (isNaN(parsed) || parsed < 1) return DEFAULT_LIMIT;
    return Math.min(parsed, MAX_LIMIT);
}

function parsePage(value) {
    const parsed = parseInt(value);
    if (isNaN(parsed) || parsed < 1) return 1;
    return parsed;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function positive(v) {
    return Math.abs(num(v));
}

// ─── Normalize a raw transactions row ────────────────────────────────
// transactions row schema (canonical):
//   ref, reference, category, currency, amount, amount_ngn, amount_usd,
//   fee, revenue_ngn, revenue_usd, wallet_used, description, status,
//   type, source_type, source_id, provider, provider_reference,
//   meta, metadata, idempotency_key, created_at, updated_at,
//   completed_at, failed_at, cancelled_at, refunded_at, reversed_at
function mapTransaction(t) {
    const currency = String(t.currency || t.wallet_used || 'NGN').toUpperCase();
    const isUSD = currency === 'USD';

    // Prefer the currency-specific column when present, else fall back.
    const amountRaw =
        isUSD
            ? (t.amount_usd != null && Number(t.amount_usd) !== 0 ? t.amount_usd : t.amount)
            : (t.amount_ngn != null && Number(t.amount_ngn) !== 0 ? t.amount_ngn : t.amount);

    const amount = num(amountRaw);

    // Fee: prefer explicit `fee`, fall back to the revenue column.
    const feeRaw =
        t.fee != null && Number(t.fee) !== 0
            ? t.fee
            : (isUSD ? t.revenue_usd : t.revenue_ngn);
    const fee = num(feeRaw);

    const meta = t.meta || t.metadata || {};

    return {
        id: t.id,
        reference: t.ref || t.reference || t.id,
        type: t.type || 'deposit',
        status: t.status || 'pending',
        currency,
        wallet_used: t.wallet_used || currency,
        amount,
        fee,
        net_amount: amount - fee,
        description: t.description || t.type || 'Transaction',
        category: t.category || null,
        source_type: t.source_type || null,
        source_id: t.source_id || null,
        provider: t.provider || null,
        provider_reference: t.provider_reference || null,
        metadata: meta,
        created_at: t.created_at,
        updated_at: t.updated_at,
        completed_at: t.completed_at || null,
        failed_at: t.failed_at || null,
        cancelled_at: t.cancelled_at || null,
        refunded_at: t.refunded_at || t.reversed_at || null
    };
}

// ─── Normalize an airtime_transactions row ──────────────────────────
function mapAirtimeToTransaction(a) {
    const currency = String(a.currency || 'USD').toUpperCase();
    const amount = num(a.total_amount);
    const fee = num(a.fee);
    const dest = a.destination_amount
        ? ` · recipient got ${a.destination_amount} ${a.destination_currency || ''}`
        : '';

    return {
        id: a.id,
        reference: a.reference || a.id,
        type: 'airtime',
        status: a.status || 'pending',
        currency,
        wallet_used: currency,
        amount,
        fee,
        net_amount: amount - fee,
        description: `Airtime: ${a.country_code || ''} ${a.phone_number || ''}${dest}`.trim(),
        category: null,
        source_type: 'airtime',
        source_id: a.id,
        provider: a.provider || 'dtone',
        provider_reference: a.provider_transaction_id || null,
        metadata: {
            country_code: a.country_code,
            phone_number: a.phone_number,
            operator_id: a.operator_id,
            operator_name: a.operator_name,
            destination_amount: a.destination_amount,
            destination_currency: a.destination_currency,
            provider_cost: a.provider_cost,
            provider_currency: a.provider_currency,
            product_id: a.product_id,
            quote_id: a.quote_id,
            refunded: a.refunded,
            failure_message: a.failure_message,
            provider_status: a.provider_status,
            ...(a.metadata || {})
        },
        created_at: a.created_at,
        updated_at: a.updated_at,
        completed_at: a.completed_at || null,
        failed_at: a.failed_at || null,
        cancelled_at: null,
        refunded_at: a.refunded ? a.updated_at : null
    };
}

// ─── Normalize a crypto_deposits row (guarantees crypto shows) ─────
function mapCryptoToTransaction(c) {
    const currency = 'USD';
    const requested = num(c.requested_usd ?? c.requested_amount);
    const credited  = num(c.credited_amount);

    // Prefer credited amount when completed; otherwise show the requested
    // amount so the user sees something meaningful while it's pending.
    const amount = credited > 0 ? credited : requested;

    const payCurrency = c.pay_currency || '';

    return {
        id: c.id,
        reference: c.nowpayments_payment_id || c.id,
        type: 'deposit',
        status: c.status || 'pending',
        currency,
        wallet_used: currency,
        amount,
        fee: num(c.fee_usd),
        net_amount: amount,
        description: `Crypto deposit — ${payCurrency}`,
        category: 'credit',
        source_type: 'crypto_deposit',
        source_id: c.id,
        provider: 'nowpayments',
        provider_reference: c.nowpayments_payment_id || null,
        metadata: {
            pay_currency: payCurrency,
            pay_network: c.pay_network || null,
            requested_usd: requested,
            required_usd: num(c.required_usd ?? c.gross_amount),
            fee_percent: num(c.fee_percent),
            credited_usd: credited,
            actually_paid_crypto: c.actually_paid_crypto ?? null,
            outcome_usd: c.outcome_usd ?? null,
            expires_at: c.expires_at || null
        },
        created_at: c.created_at,
        updated_at: c.updated_at,
        completed_at: c.completed_at || null,
        failed_at: c.failed_at || null,
        cancelled_at: c.cancelled_at || null,
        refunded_at: null
    };
}

// ═════════════════════════════════════════════════════════════════════
//  GET /api/transactions — unified user history
// ═════════════════════════════════════════════════════════════════════
router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const page = parsePage(req.query.page);
        const limit = parseLimit(req.query.limit);
        const offset = (page - 1) * limit;
        const type = req.query.type && req.query.type !== 'all' ? req.query.type : null;
        const status = req.query.status && req.query.status !== 'all' ? req.query.status : null;
        const search = req.query.search || null;

        // ─── 1. Main transactions table ──────────────────────────
        let mainQ = supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(MERGE_CAP);

        if (type) mainQ = mainQ.eq('type', type);
        if (status) mainQ = mainQ.eq('status', status);
        if (search) mainQ = mainQ.or(`ref.ilike.%${search}%,reference.ilike.%${search}%,description.ilike.%${search}%`);

        const { data: mainTx, error: mainErr } = await mainQ;
        if (mainErr && mainErr.code !== '42P01') {
            console.error('Main transactions query error:', mainErr);
            throw mainErr;
        }

        // ─── 2. Airtime table (unless filtered out) ──────────────
        let airtimeRows = [];
        const includeAirtime = !type || type === 'airtime';

        if (includeAirtime) {
            let airQ = supabaseAdmin
                .from('airtime_transactions')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(MERGE_CAP);

            if (status) airQ = airQ.eq('status', status);
            if (search) airQ = airQ.or(`reference.ilike.%${search}%,phone_number.ilike.%${search}%`);

            const { data: rows, error: airErr } = await airQ;
            if (airErr && airErr.code !== '42P01') {
                console.error('Airtime query error:', airErr);
            } else {
                airtimeRows = rows || [];
            }
        }

        // ─── 3. Crypto deposits (guarantees crypto is visible) ──
        let cryptoRows = [];
        const includeCrypto = !type || type === 'deposit' || type === 'crypto';

        if (includeCrypto) {
            let cQ = supabaseAdmin
                .from('crypto_deposits')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(MERGE_CAP);

            if (status) cQ = cQ.eq('status', status);
            if (search) cQ = cQ.or(`nowpayments_payment_id.ilike.%${search}%,pay_currency.ilike.%${search}%`);

            const { data: rows, error: cErr } = await cQ;
            if (cErr && cErr.code !== '42P01') {
                console.error('Crypto query error:', cErr);
            } else {
                cryptoRows = rows || [];
            }
        }

        // ─── 4. Merge + map ──────────────────────────────────────
        const mainMapped = (mainTx || []).map(mapTransaction);
        const airMapped  = airtimeRows.map(mapAirtimeToTransaction);
        const cryptoMapped = cryptoRows.map(mapCryptoToTransaction);

        // De-dupe: if a crypto deposit already produced a `transactions` row
        // via `ref = paymentId`, prefer the crypto_deposits row (richer data)
        // and drop the transactions duplicate.
        const seenCryptoRefs = new Set(cryptoMapped.map(c => c.reference));
        const filteredMain = mainMapped.filter(m => {
            if (m.provider === 'nowpayments' && seenCryptoRefs.has(m.reference)) return false;
            return true;
        });

        const merged = [...filteredMain, ...cryptoMapped, ...airMapped]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        const totalCount = merged.length;
        const paged = merged.slice(offset, offset + limit);

        const stats = calculateStats(merged);
        const totalPages = Math.ceil(totalCount / limit) || 1;

        res.json({
            success: true,
            data: paged,
            count: totalCount,
            stats,
            pagination: {
                page,
                limit,
                total: totalCount,
                totalPages,
                hasMore: page < totalPages
            }
        });
    } catch (error) {
        console.error('❌ Transaction error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to load transactions'
        });
    }
});

// ─── GET /api/transactions/stats ─────────────────────────────────────
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const [mainRes, airRes, cryptoRes] = await Promise.all([
            supabaseAdmin.from('transactions').select('*').eq('user_id', userId),
            supabaseAdmin.from('airtime_transactions').select('*').eq('user_id', userId),
            supabaseAdmin.from('crypto_deposits').select('*').eq('user_id', userId)
        ]);

        const merged = [
            ...(mainRes.data || []).map(mapTransaction),
            ...(airRes.data || []).map(mapAirtimeToTransaction),
            ...(cryptoRes.data || []).map(mapCryptoToTransaction)
        ];

        res.json({ success: true, stats: calculateStats(merged) });
    } catch (error) {
        console.error('❌ Stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── GET /api/transactions/purchase-map ─────────────────────────────
router.get('/purchase-map', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const map = {};

        const { data: transactions } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .in('type', ['marketplace', 'gift', 'boost', 'virtual_sms', 'airtime'])
            .in('status', ['completed', 'processing'])
            .order('created_at', { ascending: false })
            .limit(100);

        (transactions || []).forEach(t => {
            const ref = t.ref || t.reference || t.id;
            const meta = t.meta || t.metadata || {};
            map[ref] = {
                transaction_id: t.id,
                reference: ref,
                type: t.type,
                status: t.status,
                amount: positive(t.amount_ngn || t.amount_usd || t.amount),
                currency: t.currency || 'NGN',
                description: t.description || t.type,
                source_type: t.source_type,
                source_id: t.source_id,
                metadata: meta,
                purchased_at: t.created_at,
                download_token: meta.download_token || null,
                download_count: meta.download_count || 0,
                delivered_data: meta.delivered_data || null
            };
        });

        const { data: airtimeRows } = await supabaseAdmin
            .from('airtime_transactions')
            .select('*')
            .eq('user_id', userId)
            .in('status', ['completed', 'processing', 'pending'])
            .order('created_at', { ascending: false })
            .limit(100);

        (airtimeRows || []).forEach(a => {
            const ref = a.reference;
            if (!map[ref]) {
                map[ref] = {
                    transaction_id: a.id,
                    reference: ref,
                    type: 'airtime',
                    status: a.status,
                    amount: positive(a.total_amount),
                    currency: a.currency || 'USD',
                    description: `Airtime: ${a.country_code || ''} ${a.phone_number || ''}`.trim(),
                    purchased_at: a.created_at,
                    metadata: {
                        country_code: a.country_code,
                        phone_number: a.phone_number,
                        operator_id: a.operator_id,
                        operator_name: a.operator_name,
                        destination_amount: a.destination_amount,
                        destination_currency: a.destination_currency
                    }
                };
            }
        });

        res.json({ success: true, map });
    } catch (error) {
        console.error('❌ Purchase map error:', error);
        res.json({ success: true, map: {} });
    }
});

// ─── POST /api/transactions/download/:reference ─────────────────────
router.post('/download/:reference', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { reference } = req.params;

        const { data: tx } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .or(`ref.eq.${reference},reference.eq.${reference}`)
            .eq('user_id', userId)
            .maybeSingle();

        const meta = tx?.meta || tx?.metadata || {};
        if (tx && meta.download_token) {
            const newCount = (meta.download_count || 0) + 1;
            const newMeta = {
                ...meta,
                download_count: newCount,
                last_download_at: new Date().toISOString()
            };
            await supabaseAdmin
                .from('transactions')
                .update({ meta: newMeta, metadata: newMeta })
                .eq('id', tx.id);

            return res.json({
                success: true,
                download_token: meta.download_token,
                product_name: tx.description || 'Product',
                download_count: newCount,
                delivered_data: meta.delivered_data || null,
                message: 'Download initiated successfully'
            });
        }

        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('id, order_ref, download_token, product_title, download_count, delivered_data')
            .eq('order_ref', reference)
            .eq('user_id', userId)
            .maybeSingle();

        if (order && order.download_token) {
            const newCount = (order.download_count || 0) + 1;
            await supabaseAdmin
                .from('orders')
                .update({ download_count: newCount, last_download_at: new Date().toISOString() })
                .eq('id', order.id);

            return res.json({
                success: true,
                download_token: order.download_token,
                product_name: order.product_title || 'Product',
                download_count: newCount,
                delivered_data: order.delivered_data || null,
                message: 'Download initiated successfully',
                order_type: 'marketplace'
            });
        }

        return res.status(404).json({ success: false, error: 'Order not found or no download available' });
    } catch (error) {
        console.error('❌ Download error:', error);
        res.status(500).json({ success: false, error: error.message || 'Download failed' });
    }
});

// ─── GET /api/transactions/export/csv ───────────────────────────────
router.get('/export/csv', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { currency = 'all', from, to } = req.query;

        let q = supabaseAdmin
            .from('transactions')
            .select('ref, reference, type, status, currency, amount, amount_ngn, amount_usd, fee, revenue_ngn, revenue_usd, description, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (currency && currency !== 'all') q = q.eq('currency', currency);
        if (from) q = q.gte('created_at', new Date(from).toISOString());
        if (to) {
            const toDate = new Date(to);
            toDate.setDate(toDate.getDate() + 1);
            q = q.lt('created_at', toDate.toISOString());
        }

        const { data: transactions } = await q;

        let aq = supabaseAdmin
            .from('airtime_transactions')
            .select('reference, status, currency, total_amount, fee, country_code, phone_number, operator_name, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (currency && currency !== 'all') aq = aq.eq('currency', currency);
        if (from) aq = aq.gte('created_at', new Date(from).toISOString());
        if (to) {
            const toDate = new Date(to);
            toDate.setDate(toDate.getDate() + 1);
            aq = aq.lt('created_at', toDate.toISOString());
        }

        const { data: airtimeTx } = await aq;

        const mainRows = (transactions || []).map(t => {
            const isUSD = String(t.currency || '').toUpperCase() === 'USD';
            const amountRaw = isUSD ? (t.amount_usd || t.amount) : (t.amount_ngn || t.amount);
            const feeRaw = t.fee || (isUSD ? t.revenue_usd : t.revenue_ngn);
            return {
                reference: t.ref || t.reference || '',
                type: t.type || '',
                status: t.status || '',
                currency: t.currency || 'NGN',
                amount: positive(amountRaw),
                fee: positive(feeRaw),
                description: t.description || '',
                created_at: t.created_at ? new Date(t.created_at).toISOString() : ''
            };
        });

        const airRows = (airtimeTx || []).map(a => ({
            reference: a.reference || '',
            type: 'airtime',
            status: a.status || '',
            currency: a.currency || 'USD',
            amount: positive(a.total_amount),
            fee: positive(a.fee),
            description: `Airtime: ${a.country_code || ''} ${a.phone_number || ''}`.trim(),
            created_at: a.created_at ? new Date(a.created_at).toISOString() : ''
        }));

        const all = [...mainRows, ...airRows]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        if (all.length === 0) {
            return res.status(404).json({ success: false, error: 'No transactions found for export' });
        }

        const rows = [['Reference', 'Type', 'Status', 'Currency', 'Amount', 'Fee', 'Description', 'Date']];
        all.forEach(t => rows.push([
            t.reference, t.type, t.status, t.currency, t.amount, t.fee, t.description, t.created_at
        ]));

        const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=transactions_${Date.now()}.csv`);
        res.send(csv);
    } catch (error) {
        console.error('❌ CSV export error:', error);
        res.status(500).json({ success: false, error: error.message || 'CSV export failed' });
    }
});

// ─── GET /api/transactions/:id ──────────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

        const { data: transaction } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .maybeSingle();

        if (transaction) {
            return res.json({ success: true, transaction: mapTransaction(transaction) });
        }

        const { data: crypto } = await supabaseAdmin
            .from('crypto_deposits')
            .select('*')
            .eq('nowpayments_payment_id', id)
            .eq('user_id', userId)
            .maybeSingle();

        if (crypto) {
            return res.json({ success: true, transaction: mapCryptoToTransaction(crypto) });
        }

        if (isUuid) {
            const { data: airtime } = await supabaseAdmin
                .from('airtime_transactions')
                .select('*')
                .eq('id', id)
                .eq('user_id', userId)
                .maybeSingle();

            if (airtime) {
                return res.json({ success: true, transaction: mapAirtimeToTransaction(airtime) });
            }
        }

        return res.status(404).json({ success: false, error: 'Transaction not found' });
    } catch (error) {
        console.error('❌ Transaction detail error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to load transaction' });
    }
});

// ─── CALCULATE STATS ────────────────────────────────────────────────
function calculateStats(transactions) {
    let totalCreditNGN = 0, totalDebitNGN = 0;
    let totalCreditUSD = 0, totalDebitUSD = 0;
    let giftOrders = 0, marketOrders = 0, boostOrders = 0, smsOrders = 0, airtimeOrders = 0;
    let totalOrders = 0;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let monthlyCount = 0;

    (transactions || []).forEach(t => {
        const amount = num(t.amount);
        const currency = String(t.currency || 'NGN').toUpperCase();
        const type = String(t.type || '').toLowerCase();
        const status = String(t.status || '').toLowerCase();

        const isCredit = ['deposit', 'credit', 'fund', 'receive', 'cashback', 'referral_bonus', 'refund', 'fee_revenue'].includes(type);
        const isCompleted = ['completed', 'refunded', 'finished'].includes(status);

        if (isCompleted) {
            if (currency === 'USD') {
                if (isCredit) totalCreditUSD += amount;
                else totalDebitUSD += amount;
            } else {
                if (isCredit) totalCreditNGN += amount;
                else totalDebitNGN += amount;
            }
        }

        if (['giftcard', 'gift_card', 'gift'].includes(type)) giftOrders++;
        if (['marketplace', 'purchase'].includes(type)) marketOrders++;
        if (type === 'boost') boostOrders++;
        if (type === 'virtual_sms') smsOrders++;
        if (type === 'airtime') airtimeOrders++;

        if (['giftcard', 'gift_card', 'gift', 'marketplace', 'purchase', 'boost', 'virtual_sms', 'airtime'].includes(type)) {
            totalOrders++;
        }

        if (t.created_at && new Date(t.created_at) >= monthStart) monthlyCount++;
    });

    return {
        totalCreditNGN,
        totalDebitNGN,
        totalCreditUSD,
        totalDebitUSD,
        totalTransactions: (transactions || []).length,
        giftOrders,
        marketOrders,
        boostOrders,
        smsOrders,
        airtimeOrders,
        totalOrders,
        monthlyCount
    };
}

module.exports = router;