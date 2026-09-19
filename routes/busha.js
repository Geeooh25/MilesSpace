// routes/busha.js — Complete Router with PostgreSQL Cache
const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const emailService = require('../services/emailService');
const { authMiddleware } = require('../middleware/auth');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('../services/ledgerService');
const IdempotencyService = require('../services/idempotencyService');
const cacheService = require('../services/cacheService');

// ─── CONFIG ───
const YOUR_MARKUP = 0.03; // 3% markup
const SERVICE_FEE = 1400; // ₦1,400 flat service fee
const RATES_CACHE_TTL = 60; // Cache rates for 60 seconds

console.log('✅ Busha router loaded (PostgreSQL cache)');

// ─── SUPPORTED COINS ───
const COIN_ORDER = ['BTC', 'USDT', 'USDC'];
const COIN_IDS = {
  BTC: 'bitcoin',
  USDT: 'tether',
  USDC: 'usd-coin'
};

// ─── COINGECKO API ───
async function fetchCoinGeckoRates() {
  try {
    const ids = Object.values(COIN_IDS).join(',');
    console.log('📡 Fetching fresh rates from CoinGecko...');
    
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price',
      {
        params: {
          ids: ids,
          vs_currencies: 'usd,ngn'
        },
        timeout: 8000,
        headers: {
          'Accept': 'application/json'
        }
      }
    );

    const data = response.data;
    const rates = {};

    Object.entries(COIN_IDS).forEach(([coin, id]) => {
      if (data[id]) {
        rates[coin] = {
          usd: data[id].usd || 0,
          ngn: data[id].ngn || 0
        };
      }
    });

    let exchangeRate = 1465.56;
    if (rates.USDT && rates.USDT.ngn) {
      exchangeRate = rates.USDT.ngn;
    } else if (rates.BTC && rates.BTC.ngn && rates.BTC.usd) {
      exchangeRate = rates.BTC.ngn / rates.BTC.usd;
    }

    console.log('✅ Fresh rates fetched successfully');
    return { rates, exchangeRate };
  } catch (error) {
    console.error('❌ CoinGecko error:', error.message);
    
    // Return fallback rates
    const fallbackRates = {
      BTC: { usd: 66145, ngn: 94123850 },
      USDT: { usd: 1, ngn: 1465.56 },
      USDC: { usd: 1, ngn: 1465.56 }
    };
    const fallbackRate = 1465.56;
    
    return { rates: fallbackRates, exchangeRate: fallbackRate };
  }
}

// ─── GET RATES WITH CACHE ───
async function getRates() {
  const cacheKey = 'crypto_rates_coingecko';
  
  try {
    // Use cache service
    const result = await cacheService.getOrSet(
      cacheKey,
      fetchCoinGeckoRates,
      RATES_CACHE_TTL
    );
    
    return result;
  } catch (error) {
    console.error('❌ Error getting rates:', error);
    
    // Emergency fallback
    return {
      rates: {
        BTC: { usd: 66145, ngn: 94123850 },
        USDT: { usd: 1, ngn: 1465.56 },
        USDC: { usd: 1, ngn: 1465.56 }
      },
      exchangeRate: 1465.56
    };
  }
}

// ─── HELPERS ───
async function createNotification(userId, title, message, type = 'info', link = null) {
  try {
    const { data, error } = await supabaseAdmin.from('notifications').insert({
      user_id: userId,
      title,
      message,
      type,
      icon: type === 'deposit_completed' ? '✅' : type === 'deposit_failed' ? '❌' : '📌',
      link,
      is_read: false,
      created_at: new Date().toISOString()
    }).select().single();
    
    if (error) console.error('Notification error:', error);
    return data;
  } catch (e) {
    console.error('Create notification error:', e);
    return null;
  }
}

async function sendCryptoDeliveryEmail(order) {
  try {
    // Get user email and username
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('email, username')
      .eq('id', order.user_id)
      .single();

    if (error || !profile) {
      console.error('❌ Could not fetch user profile for email:', error);
      return;
    }

    const email = profile.email;
    const username = profile.username || 'User';
    const coin = order.coin;
    const amount = parseFloat(order.crypto_amount || 0).toFixed(8);
    const txHash = order.tx_hash || 'N/A';
    const network = order.network || 'BTC';
    const address = order.wallet_address || 'N/A';
    const date = new Date().toISOString();

    // Coin symbols and explorer links
    const coinSymbols = {
      BTC: '₿',
      USDT: '💎',
      USDC: '🅤'
    };
    const explorerUrls = {
      BTC: `https://blockchair.com/bitcoin/transaction/${txHash}`,
      USDT: `https://tronscan.org/#/transaction/${txHash}`,
      USDC: `https://etherscan.io/tx/${txHash}`
    };
    
    const symbol = coinSymbols[coin] || '🪙';
    const explorerUrl = explorerUrls[coin] || `https://blockchair.com/search?q=${txHash}`;

    const subject = `✅ ${amount} ${coin} Sent to Your Wallet — MilesSpace`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${subject}</title>
      </head>
      <body style="font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif; background: #f4f6f8; padding: 40px 20px; margin: 0;">
        <div style="max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 40px 32px; box-shadow: 0 4px 14px rgba(0,0,0,0.06);">
          
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 28px;">
            <div style="font-family: 'Syne', sans-serif; font-weight: 800; font-size: 22px; color: #0c3d4a;">
              🏦 MilesSpace
            </div>
            <p style="color: #4a6070; font-size: 14px; margin-top: 4px;">Your crypto has arrived! 🎉</p>
          </div>

          <!-- Success Emoji -->
          <div style="text-align: center; margin-bottom: 20px;">
            <div style="background: #d1fae5; width: 72px; height: 72px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto;">
              <span style="font-size: 36px;">🚀</span>
            </div>
          </div>

          <!-- Main Message -->
          <h2 style="font-family: 'Syne', sans-serif; font-size: 22px; font-weight: 700; color: #0c3d4a; text-align: center; margin-bottom: 8px;">
            Crypto Delivered Successfully! 🎉
          </h2>
          <p style="color: #4a6070; font-size: 15px; line-height: 1.6; text-align: center; margin-bottom: 24px;">
            Your crypto has been sent to your wallet. It's now safely in your hands! 💪
          </p>

          <!-- Transaction Details -->
          <div style="background: #f8f9fa; border-radius: 12px; padding: 20px; margin-bottom: 24px; border: 1px solid #e4e8ec;">
            
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e4e8ec;">
              <span style="color: #4a6070; font-size: 13px; font-weight: 500;">💎 Coin</span>
              <span style="color: #0c3d4a; font-weight: 700; font-size: 14px;">${symbol} ${coin}</span>
            </div>
            
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e4e8ec;">
              <span style="color: #4a6070; font-size: 13px; font-weight: 500;">💰 Amount</span>
              <span style="color: #0c3d4a; font-weight: 700; font-size: 16px;">${amount} ${coin}</span>
            </div>
            
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e4e8ec;">
              <span style="color: #4a6070; font-size: 13px; font-weight: 500;">🌐 Network</span>
              <span style="color: #0c3d4a; font-weight: 600; font-size: 13px;">${network}</span>
            </div>
            
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e4e8ec;">
              <span style="color: #4a6070; font-size: 13px; font-weight: 500;">📍 Wallet Address</span>
              <span style="color: #0c3d4a; font-weight: 500; font-size: 11px; font-family: monospace; word-break: break-all; max-width: 45%; text-align: right;">${address}</span>
            </div>
            
            <div style="display: flex; justify-content: space-between; padding: 8px 0;">
              <span style="color: #4a6070; font-size: 13px; font-weight: 500;">🔗 Transaction Hash</span>
              <span style="color: #0c3d4a; font-weight: 500; font-size: 11px; font-family: monospace; word-break: break-all; max-width: 45%; text-align: right;">${txHash}</span>
            </div>
          </div>

          <!-- What's Next -->
          <div style="background: #e8f4f7; border-radius: 10px; padding: 16px 20px; margin-bottom: 24px;">
            <p style="color: #0c3d4a; font-size: 13px; font-weight: 600; margin-bottom: 6px;">💡 What's Next?</p>
            <p style="color: #4a6070; font-size: 13px; line-height: 1.5; margin: 0;">
              Your crypto is now in your wallet! You can:
            </p>
            <ul style="color: #4a6070; font-size: 13px; line-height: 1.8; margin: 6px 0 0 20px; padding: 0;">
              <li>💎 Hold it as an investment</li>
              <li>🔄 Trade it on exchanges</li>
              <li>💳 Use it for purchases</li>
              <li>📤 Send it to others</li>
            </ul>
          </div>

          <!-- Transaction Link -->
          <div style="text-align: center; margin-bottom: 24px;">
            <a href="${explorerUrl}" target="_blank" style="display: inline-block; background: #0c3d4a; color: #fff; padding: 10px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
              🔍 View on Blockchain Explorer
            </a>
          </div>

          <!-- Footer Message -->
          <div style="border-top: 1px solid #e4e8ec; padding-top: 16px; margin-top: 16px;">
            <p style="color: #4a6070; font-size: 13px; text-align: center; margin: 0 0 4px 0;">
              🌟 Thank you for choosing MilesSpace!
            </p>
            <p style="color: #92a8b4; font-size: 12px; text-align: center; margin: 0;">
              Your crypto is safe and sound. Need help? Contact our support team anytime.
            </p>
            <p style="color: #92a8b4; font-size: 11px; text-align: center; margin-top: 12px;">
              © ${new Date().getFullYear()} MilesSpace. All rights reserved.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    await emailService.sendEmail(email, subject, html);
    console.log(`✅ Crypto delivery email sent to ${email}`);
  } catch (error) {
    console.error('❌ Failed to send crypto delivery email:', error);
  }
}

async function getUserVirtualAccount(userId) {
  try {
    const { data: existing, error } = await supabaseAdmin
      .from('user_virtual_accounts')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (existing) {
      return {
        account_number: existing.account_number,
        bank_name: existing.bank_name,
        account_name: existing.account_name
      };
    }

    const fallbackAccount = {
      account_number: '0123456789',
      bank_name: 'Wema Bank',
      account_name: 'MilesSpace User'
    };

    try {
      const { data: saved, error: saveError } = await supabaseAdmin
        .from('user_virtual_accounts')
        .insert({
          user_id: userId,
          account_number: fallbackAccount.account_number,
          bank_name: fallbackAccount.bank_name,
          account_name: fallbackAccount.account_name,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (!saveError && saved) {
        return {
          account_number: saved.account_number,
          bank_name: saved.bank_name,
          account_name: saved.account_name
        };
      }
    } catch (e) {
      console.warn('Could not save fallback account:', e.message);
    }

    return fallbackAccount;
  } catch (error) {
    console.error('❌ Error getting virtual account:', error);
    return {
      account_number: '0123456789',
      bank_name: 'Wema Bank',
      account_name: 'MilesSpace User'
    };
  }
}

// ─── ROUTES ───

// ─── GET /api/busha/test ───
router.get('/test', authMiddleware, async (req, res) => {
  try {
    const { rates, exchangeRate } = await getRates();
    const virtualAccount = await getUserVirtualAccount(req.user.id);

    res.json({
      success: true,
      message: 'CoinGecko integration working!',
      data: {
        rates: rates,
        source: 'CoinGecko',
        virtual_account: virtualAccount,
        exchange_rate: exchangeRate,
        markup: YOUR_MARKUP * 100 + '%',
        supported_coins: COIN_ORDER,
        cache: {
          ttl: RATES_CACHE_TTL,
          provider: 'PostgreSQL'
        }
      }
    });
  } catch (error) {
    console.error('❌ Test error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── SAVED WALLETS ───

// GET /api/busha/wallets
router.get('/wallets', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('saved_wallets')
      .select('*')
      .eq('user_id', req.user.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
      
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/busha/wallets
router.post('/wallets', authMiddleware, async (req, res) => {
  try {
    const { coin, address, label, network, is_default } = req.body;
    if (!address || address.length < 10) {
      return res.status(400).json({ success: false, error: 'Valid address required' });
    }
    
    const { data, error } = await supabaseAdmin
      .from('saved_wallets')
      .insert({
        user_id: req.user.id,
        coin: coin || 'BTC',
        address: address,
        label: label || address.slice(0, 8) + '…',
        network: network || 'BTC',
        is_default: is_default || false
      })
      .select()
      .single();
      
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/busha/wallets/:id
router.delete('/wallets/:id', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('saved_wallets')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
      
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── TRANSACTION HISTORY ───

// GET /api/busha/history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    
    const { data, error } = await supabaseAdmin
      .from('crypto_purchases')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
      
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── WALLET ANALYTICS ───

// GET /api/busha/analytics
router.get('/analytics', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get deposits (wallet funding)
    const { data: deposits } = await supabaseAdmin
      .from('transactions')
      .select('amount_ngn, amount_usd, created_at')
      .eq('user_id', userId)
      .eq('type', 'deposit')
      .gte('created_at', new Date(new Date().setDate(1)).toISOString());
      
    // Get crypto purchases
    const { data: purchases } = await supabaseAdmin
      .from('crypto_purchases')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'completed');
      
    // Get fees
    const totalFee = purchases?.reduce((sum, p) => sum + (p.amount_ngn * 0.03), 0) || 0;
    
    // Get cashback
    const { data: cashback } = await supabaseAdmin
      .from('cashback_transactions')
      .select('amount')
      .eq('user_id', userId)
      .eq('type', 'earned');
      
    const totalCashback = cashback?.reduce((sum, c) => sum + c.amount, 0) || 0;
    const depositedThisMonth = deposits?.reduce((sum, d) => sum + d.amount_ngn, 0) || 0;
    
    res.json({
      success: true,
      data: {
        deposited_this_month: depositedThisMonth,
        crypto_purchases: purchases?.length || 0,
        fees_paid: totalFee,
        cashback_earned: totalCashback
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /api/busha/rates ───
router.get('/rates', authMiddleware, async (req, res) => {
  try {
    const { vs = 'USD' } = req.query;
    console.log(`📡 Fetching rates for ${vs}...`);

    const { rates, exchangeRate } = await getRates();
    const markedUpRate = exchangeRate * (1 + YOUR_MARKUP);

    const usdRates = {};
    const ngnRates = {};

    COIN_ORDER.forEach((coin) => {
      const data = rates[coin] || { usd: 0, ngn: 0 };
      usdRates[coin] = data.usd || 0;
      ngnRates[coin] = (data.ngn || data.usd * exchangeRate) * (1 + YOUR_MARKUP);
    });

    if (vs === 'NGN') {
      return res.json({
        success: true,
        data: ngnRates,
        currency: 'NGN',
        exchange_rate: markedUpRate,
        source: 'CoinGecko',
        markup: YOUR_MARKUP * 100 + '%',
        cached: true
      });
    }

    return res.json({
      success: true,
      data: usdRates,
      currency: 'USD',
      exchange_rate: markedUpRate,
      source: 'CoinGecko',
      markup: YOUR_MARKUP * 100 + '%',
      cached: true
    });
  } catch (error) {
    console.error('❌ Rates error:', error.message);
    const fallbackRate = 1465.56;
    const markedUpRate = fallbackRate * (1 + YOUR_MARKUP);
    const fallbackUsd = { BTC: 66145, USDT: 1, USDC: 1 };
    const fallbackNgn = {};
    Object.entries(fallbackUsd).forEach(([coin, price]) => {
      fallbackNgn[coin] = price * markedUpRate;
    });

    if (req.query.vs === 'NGN') {
      return res.json({
        success: true,
        data: fallbackNgn,
        currency: 'NGN',
        exchange_rate: markedUpRate,
        source: 'Fallback',
        cached: false
      });
    }

    res.json({
      success: true,
      data: fallbackUsd,
      currency: 'USD',
      exchange_rate: markedUpRate,
      source: 'Fallback',
      cached: false
    });
  }
});

// ─── GET /api/busha/rate/:coin ───
router.get('/rate/:coin', authMiddleware, async (req, res) => {
  try {
    const { coin } = req.params;
    const { rates, exchangeRate } = await getRates();
    const markedUpRate = exchangeRate * (1 + YOUR_MARKUP);

    const data = rates[coin] || { usd: 0, ngn: 0 };
    const usdPrice = data.usd || 0;
    const ngnPrice = (data.ngn || usdPrice * exchangeRate) * (1 + YOUR_MARKUP);

    res.json({
      success: true,
      data: {
        coin,
        usd_price: usdPrice,
        ngn_price: ngnPrice,
        exchange_rate: markedUpRate,
        source: 'CoinGecko',
        markup: YOUR_MARKUP * 100 + '%'
      }
    });
  } catch (error) {
    console.error('❌ Rate error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /api/busha/quote ───
router.post('/quote', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { coin, amount, network, address } = req.body;

    if (!coin || !amount || amount < 500) {
      return res.status(400).json({
        success: false,
        error: 'Valid amount (₦500+) and coin required'
      });
    }

    if (!COIN_ORDER.includes(coin)) {
      return res.status(400).json({
        success: false,
        error: `Coin ${coin} not supported. Only BTC, USDT, USDC available.`
      });
    }

    console.log(`📡 Creating quote for ${coin}, amount ₦${amount}`);

    const virtualAccount = await getUserVirtualAccount(userId);
    const { rates, exchangeRate } = await getRates();
    const markedUpRate = exchangeRate * (1 + YOUR_MARKUP);

    const rateData = rates[coin] || { usd: 0, ngn: 0 };
    const usdPrice = rateData.usd || 0;

    const fallbackPrices = { BTC: 66145, USDT: 1, USDC: 1 };
    const finalUsdPrice = usdPrice || fallbackPrices[coin] || 0;

    const usdAmount = amount / markedUpRate;
    const cryptoAmount = amount / (finalUsdPrice * markedUpRate);
    const totalAmount = amount + SERVICE_FEE;
    const reference = `MILES-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const expiresAt = new Date(Date.now() + 120 * 1000).toISOString();

    const { data: order, error: dbError } = await supabaseAdmin
      .from('crypto_purchases')
      .insert({
        user_id: userId,
        coin: coin,
        amount_ngn: amount,
        rate: markedUpRate,
        crypto_amount: cryptoAmount,
        wallet_address: address || '',
        network: network || 'BTC',
        reference: reference,
        status: 'pending',
        bank_name: virtualAccount.bank_name || 'Wema Bank',
        bank_account: virtualAccount.account_number || '0123456789',
        account_name: virtualAccount.account_name || 'MilesSpace User',
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
        amount_usd: usdAmount,
        price_usd: finalUsdPrice,
        effective_rate: markedUpRate
      })
      .select()
      .single();

    if (dbError) {
      console.error('❌ DB Error:', dbError);
      throw dbError;
    }

    // Create notification
    await createNotification(
      userId,
      'Crypto Quote Created',
      `Your quote for ${cryptoAmount.toFixed(8)} ${coin} is ready. Send ₦${totalAmount} to complete.`,
      'info',
      '/buy-crypto'
    );

    res.json({
      success: true,
      data: {
        quote_id: order.id,
        order_id: order.id,
        bank_name: order.bank_name || 'Wema Bank',
        account_number: order.bank_account || '0123456789',
        account_name: order.account_name || 'MilesSpace User',
        amount_to_send: totalAmount,
        reference: reference,
        expires_in: 120,
        crypto_amount: cryptoAmount,
        coin: coin,
        usd_price: finalUsdPrice,
        rate: markedUpRate,
        service_fee: SERVICE_FEE,
        usd_amount: usdAmount,
        network: network || 'BTC'
      }
    });
  } catch (error) {
    console.error('❌ Quote error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /api/busha/order ───
router.post('/order', authMiddleware, async (req, res) => {
  try {
    const { quote_id, address, network } = req.body;
    if (!quote_id) {
      return res.status(400).json({ success: false, error: 'quote_id required' });
    }

    const { data: order, error } = await supabaseAdmin
      .from('crypto_purchases')
      .select('*')
      .eq('id', quote_id)
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const updates = {};
    if (address) updates.wallet_address = address;
    if (network) updates.network = network;

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('crypto_purchases')
      .update(updates)
      .eq('id', order.id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({
      success: true,
      data: {
        order_id: order.id,
        status: 'pending',
        message: 'Order created successfully'
      }
    });
  } catch (error) {
    console.error('❌ Order error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /api/busha/confirm/:orderId ───
router.post('/confirm/:orderId', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    const { data: order, error } = await supabaseAdmin
      .from('crypto_purchases')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Order already processed' });
    }

    await supabaseAdmin
      .from('crypto_purchases')
      .update({ status: 'processing' })
      .eq('id', order.id);

    await createNotification(
      userId,
      'Payment Confirmed',
      `Your purchase of ${order.crypto_amount} ${order.coin} is being processed.`,
      'info',
      '/buy-crypto'
    );

    res.json({
      success: true,
      data: { 
        order_id: order.id, 
        status: 'processing',
        message: 'Payment confirmed, processing your order'
      }
    });
  } catch (error) {
    console.error('❌ Confirm error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /api/busha/status/:orderId ───
router.get('/status/:orderId', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    const { data: order, error } = await supabaseAdmin
      .from('crypto_purchases')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({
      success: true,
      data: {
        order_id: order.id,
        status: order.status,
        tx_hash: order.tx_hash || null,
        coin: order.coin,
        amount: order.crypto_amount,
        created_at: order.created_at,
        completed_at: order.completed_at
      }
    });
  } catch (error) {
    console.error('❌ Status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /api/busha/webhook ───
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Parse body if it's raw
    let body = req.body;
    if (Buffer.isBuffer(body)) {
      body = JSON.parse(body.toString());
    }
    
    console.log('📩 Webhook received:', JSON.stringify(body, null, 2));

    // Verify signature if provided
    const signature = req.headers['x-bitnob-signature'];
    if (signature) {
      const expectedSignature = crypto
        .createHmac('sha256', process.env.BITNOB_WEBHOOK_SECRET || '')
        .update(JSON.stringify(body))
        .digest('hex');
      
      if (signature !== expectedSignature) {
        console.warn('⚠️ Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { event, data } = body;

    if (event === 'payment.completed' || event === 'deposit.completed') {
      const { reference, transaction_id, tx_hash, amount, coin } = data;

      console.log(`📦 Processing webhook for reference: ${reference}`);

      // Check for duplicate (idempotency)
      const { data: existingOrder, error: checkError } = await supabaseAdmin
        .from('crypto_purchases')
        .select('*')
        .eq('reference', reference)
        .single();

      if (checkError || !existingOrder) {
        console.warn('⚠️ Order not found for webhook:', { reference });
        return res.status(200).json({ success: true, message: 'Order not found' });
      }

      // Prevent duplicate processing
      if (existingOrder.status === 'completed' || existingOrder.status === 'finished') {
        console.log(`✅ Order ${existingOrder.id} already completed, skipping duplicate webhook`);
        return res.status(200).json({ success: true, message: 'Already processed' });
      }

      // Update order status
      const { error: updateError } = await supabaseAdmin
        .from('crypto_purchases')
        .update({
          status: 'completed',
          tx_hash: tx_hash || null,
          transfer_id: transaction_id,
          completed_at: new Date().toISOString()
        })
        .eq('id', existingOrder.id);

      if (updateError) throw updateError;

      // Send notification
      await createNotification(
        existingOrder.user_id,
        'Crypto Purchase Completed ✅',
        `Your ${existingOrder.crypto_amount} ${existingOrder.coin} has been sent to your wallet.`,
        'deposit_completed',
        '/buy-crypto'
      );

      // Send email notification
      await sendCryptoDeliveryEmail(existingOrder);

      console.log(`✅ Order ${existingOrder.id} completed successfully via webhook`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(200).json({ success: false, error: error.message });
  }
});

// ─── POST /api/busha/manual-complete/:orderId ───
router.post('/manual-complete/:orderId', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    const { data: order, error } = await supabaseAdmin
      .from('crypto_purchases')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (order.status === 'completed' || order.status === 'finished') {
      return res.status(400).json({ success: false, error: 'Order already completed' });
    }

    const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;

    await supabaseAdmin
      .from('crypto_purchases')
      .update({
        status: 'completed',
        tx_hash: txHash,
        completed_at: new Date().toISOString()
      })
      .eq('id', order.id);

    await createNotification(
      userId,
      'Crypto Purchase Completed ✅',
      `Your ${order.crypto_amount} ${order.coin} has been sent to your wallet.`,
      'deposit_completed',
      '/buy-crypto'
    );

    await sendCryptoDeliveryEmail(order);

    res.json({
      success: true,
      data: { 
        order_id: order.id, 
        status: 'completed',
        message: 'Order manually completed',
        tx_hash: txHash
      }
    });
  } catch (error) {
    console.error('❌ Manual complete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── CLEAR CACHE ENDPOINT ───
router.post('/clear-cache', authMiddleware, async (req, res) => {
  try {
    await cacheService.delete('crypto_rates_coingecko');
    res.json({ 
      success: true, 
      message: 'Cache cleared successfully',
      stats: await cacheService.getStats()
    });
  } catch (error) {
    console.error('❌ Clear cache error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── CACHE STATS ENDPOINT ───
router.get('/cache-stats', authMiddleware, async (req, res) => {
  try {
    const stats = await cacheService.getStats();
    res.json({ 
      success: true, 
      data: stats
    });
  } catch (error) {
    console.error('❌ Cache stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── REFRESH RATES MANUALLY ───
router.post('/refresh-rates', authMiddleware, async (req, res) => {
  try {
    // Force delete cache
    await cacheService.delete('crypto_rates_coingecko');
    
    // Fetch fresh rates
    const rates = await fetchCoinGeckoRates();
    
    // Store in cache
    await cacheService.set('crypto_rates_coingecko', rates, RATES_CACHE_TTL);
    
    res.json({
      success: true,
      message: 'Rates refreshed successfully',
      data: rates
    });
  } catch (error) {
    console.error('❌ Refresh rates error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;