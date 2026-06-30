const express = require('express');
const crypto = require('crypto');
const { supabase, supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

/* ════════════════════════════════════════════════════════
   FUNDING ROUTES
   - Bank transfer: unique reference + randomized payable amount
     (so each deposit can be matched to exactly one user from
     bank statement, even if two people send the same round number)
   - Crypto: wallet address + QR payload, network-aware
   - Both create a 'pending' transaction row that an admin /
     webhook later marks 'completed' or 'failed'
════════════════════════════════════════════════════════ */

const BANK_DETAILS = {
  bank_name: 'Wema Bank',
  account_name: 'Miles Exchange / John Doe',
  account_number: '8821046573',
};

// Static receive addresses per coin/network — replace with real
// per-user generated addresses if your provider supports it.
const CRYPTO_ADDRESSES = {
  'BTC:BTC':    'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  'USDT:TRC20': 'TXk9q3eR8z1MnY7sJvLpW4cQ2hF6tBdGxa',
  'USDT:ERC20': '0x9F4c2B6a1D38E7F0C5b3A9d1E2f4C8b1A2D3E4F5',
  'USDT:BEP20': '0x9F4c2B6a1D38E7F0C5b3A9d1E2f4C8b1A2D3E4F5',
  'ETH:ERC20':  '0x9F4c2B6a1D38E7F0C5b3A9d1E2f4C8b1A2D3E4F5',
  'ETH:BEP20':  '0x9F4c2B6a1D38E7F0C5b3A9d1E2f4C8b1A2D3E4F5',
  'LTC:LTC':    'ltc1qxk2j8d9hsm3q7n5p4v6r1w0t9y8u7i6o5p4a3',
};

const NGN_RATE = 1620; // USD -> NGN, kept in sync with rest of app

/* ── Helpers ── */
function genReference() {
  // MXB-<timestamp36>-<4 random hex chars>, short but unique enough
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `MXB-${ts}-${rand}`;
}

function genUniquePayableAmount(baseAmount) {
  // Add a small random value (₦1 - ₦99) so bank statement amounts
  // are distinguishable even if multiple users request the same round figure.
  const extra = Math.floor(Math.random() * 99) + 1;
  return Math.round(baseAmount) + extra;
}

/* ════════════════════════════════════
   POST /api/fund/bank/initiate
   Body: { amount_ngn }
   Returns bank details + unique reference + exact payable amount.
   Does NOT create the transaction yet — that happens on /confirm,
   once the user clicks "I Have Paid".
════════════════════════════════════ */
router.post('/bank/initiate', authMiddleware, async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount_ngn);
    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount (minimum ₦100)' });
    }

    const reference = genReference();
    const payableAmount = genUniquePayableAmount(amount);

    res.json({
      success: true,
      data: {
        reference,
        requested_amount: amount,
        payable_amount: payableAmount,
        bank_name: BANK_DETAILS.bank_name,
        account_name: BANK_DETAILS.account_name,
        account_number: BANK_DETAILS.account_number,
      },
    });
  } catch (error) {
    console.error('Bank initiate error:', error);
    res.status(500).json({ success: false, error: 'Could not start bank transfer. Please try again.' });
  }
});

/* ════════════════════════════════════
   POST /api/fund/bank/confirm
   Body: { reference, requested_amount, payable_amount }
   Called when user clicks "I Have Paid" — saves the pending transaction.
════════════════════════════════════ */
router.post('/bank/confirm', authMiddleware, async (req, res) => {
  try {
    const { reference, requested_amount, payable_amount } = req.body;
    if (!reference || !payable_amount) {
      return res.status(400).json({ success: false, error: 'Missing transaction details' });
    }

    const { data, error } = await supabaseAdmin
      .from('wallet_transactions')
      .insert({
        user_id: req.user.id,
        type: 'deposit',
        method: 'bank_transfer',
        currency: 'NGN',
        requested_amount: requested_amount,
        payable_amount: payable_amount,
        reference,
        status: 'pending_verification',
        meta: {
          bank_name: BANK_DETAILS.bank_name,
          account_number: BANK_DETAILS.account_number,
        },
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (error) {
    console.error('Bank confirm error:', error);
    res.status(500).json({ success: false, error: 'Could not save your confirmation. Please contact support with your reference.' });
  }
});

/* ════════════════════════════════════
   POST /api/fund/crypto/initiate
   Body: { amount_usd, coin, network }
   Returns wallet address + amount to send.
════════════════════════════════════ */
router.post('/crypto/initiate', authMiddleware, async (req, res) => {
  try {
    const amountUSD = parseFloat(req.body.amount_usd);
    const coin = (req.body.coin || '').toUpperCase();
    const network = (req.body.network || coin).toUpperCase();

    if (!amountUSD || amountUSD < 1) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount (minimum $1)' });
    }
    const key = `${coin}:${network}`;
    const address = CRYPTO_ADDRESSES[key];
    if (!address) {
      return res.status(400).json({ success: false, error: 'Unsupported coin/network combination' });
    }

    const reference = genReference();

    res.json({
      success: true,
      data: {
        reference,
        coin,
        network,
        address,
        amount_usd: amountUSD,
        amount_ngn_equivalent: Math.round(amountUSD * NGN_RATE),
      },
    });
  } catch (error) {
    console.error('Crypto initiate error:', error);
    res.status(500).json({ success: false, error: 'Could not start crypto deposit. Please try again.' });
  }
});

/* ════════════════════════════════════
   POST /api/fund/crypto/confirm
   Body: { reference, coin, network, address, amount_usd }
   Called when user clicks "I've Sent Payment".
════════════════════════════════════ */
router.post('/crypto/confirm', authMiddleware, async (req, res) => {
  try {
    const { reference, coin, network, address, amount_usd } = req.body;
    if (!reference || !amount_usd) {
      return res.status(400).json({ success: false, error: 'Missing transaction details' });
    }

    const { data, error } = await supabaseAdmin
      .from('wallet_transactions')
      .insert({
        user_id: req.user.id,
        type: 'deposit',
        method: 'crypto',
        currency: 'USD',
        requested_amount: amount_usd,
        payable_amount: amount_usd,
        reference,
        status: 'pending_verification',
        meta: { coin, network, address },
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (error) {
    console.error('Crypto confirm error:', error);
    res.status(500).json({ success: false, error: 'Could not save your confirmation. Please contact support with your reference.' });
  }
});

/* ════════════════════════════════════
   GET /api/fund/transactions
   Returns the user's deposit history, grouped by status.
════════════════════════════════════ */
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('wallet_transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const txs = data || [];
    res.json({
      success: true,
      data: txs,
      summary: {
        pending: txs.filter(t => t.status === 'pending_verification').length,
        completed: txs.filter(t => t.status === 'completed').length,
        failed: txs.filter(t => t.status === 'failed').length,
      },
    });
  } catch (error) {
    console.error('Transactions fetch error:', error);
    res.status(500).json({ success: false, error: 'Could not load transaction history' });
  }
});

module.exports = router;