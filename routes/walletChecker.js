// ─── routes/walletChecker.js ───
// Public Wallet Balance Checker - No Auth Required
// Supports: BTC, ETH, LTC, DOGE, SOL, TRX, BNB, USDT, USDC, and more

const express = require('express');
const router = express.Router();
const axios = require('axios');

// ─── CONFIG ───
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const TRON_GRID = 'https://api.trongrid.io';

// ─── CACHE ───
const cache = new Map();

// ─── COIN CONFIG ───
const COINS = {
    btc: { name: 'Bitcoin', symbol: 'BTC', coingeckoId: 'bitcoin', type: 'utxo' },
    eth: { name: 'Ethereum', symbol: 'ETH', coingeckoId: 'ethereum', type: 'evm' },
    ltc: { name: 'Litecoin', symbol: 'LTC', coingeckoId: 'litecoin', type: 'utxo' },
    doge: { name: 'Dogecoin', symbol: 'DOGE', coingeckoId: 'dogecoin', type: 'utxo' },
    sol: { name: 'Solana', symbol: 'SOL', coingeckoId: 'solana', type: 'solana' },
    trx: { name: 'TRON', symbol: 'TRX', coingeckoId: 'tron', type: 'tron' },
    usdt: { name: 'Tether', symbol: 'USDT', coingeckoId: 'tether', type: 'evm' },
    usdc: { name: 'USD Coin', symbol: 'USDC', coingeckoId: 'usd-coin', type: 'evm' },
    bnb: { name: 'BNB', symbol: 'BNB', coingeckoId: 'binancecoin', type: 'evm' },
    xrp: { name: 'XRP', symbol: 'XRP', coingeckoId: 'ripple', type: 'xrp' },
    ada: { name: 'Cardano', symbol: 'ADA', coingeckoId: 'cardano', type: 'cardano' },
    matic: { name: 'Polygon', symbol: 'MATIC', coingeckoId: 'matic-network', type: 'evm' },
    shib: { name: 'Shiba Inu', symbol: 'SHIB', coingeckoId: 'shiba-inu', type: 'evm' },
    dash: { name: 'Dash', symbol: 'DASH', coingeckoId: 'dash', type: 'utxo' },
    zec: { name: 'Zcash', symbol: 'ZEC', coingeckoId: 'zcash', type: 'utxo' }
};

// ─── HELPER: Get price from CoinGecko ───
async function getPrice(coinId) {
    const cacheKey = `price_${coinId}`;
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return cached.data;
    }

    try {
        const response = await axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
            { timeout: 5000 }
        );
        const price = response.data[coinId]?.usd || 0;
        cache.set(cacheKey, { data: price, timestamp: Date.now() });
        return price;
    } catch (error) {
        console.error('Price fetch error:', error);
        return 0;
    }
}

// ─── HELPER: Get BTC balance ───
async function getBtcBalance(address) {
    try {
        const response = await axios.get(
            `https://blockchain.info/balance?active=${address}`,
            { timeout: 10000 }
        );
        if (response.data[address]) {
            return parseFloat(response.data[address].final_balance) / 1e8;
        }
        return 0;
    } catch (error) {
        console.error('BTC balance error:', error);
        return 0;
    }
}

// ─── HELPER: Get ETH balance ───
async function getEthBalance(address) {
    try {
        const response = await axios.get(
            `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${ETHERSCAN_API_KEY}`,
            { timeout: 10000 }
        );
        if (response.data.status === '1') {
            return parseFloat(response.data.result) / 1e18;
        }
        return 0;
    } catch (error) {
        console.error('ETH balance error:', error);
        return 0;
    }
}

// ─── HELPER: Get LTC/DOGE/DASH/ZEC balance ───
async function getBlockchairBalance(address, coin) {
    const chainMap = { ltc: 'litecoin', doge: 'dogecoin', dash: 'dash', zec: 'zcash' };
    const chain = chainMap[coin] || coin;

    try {
        const response = await axios.get(
            `https://api.blockchair.com/${chain}/dashboards/address/${address}`,
            { timeout: 10000 }
        );
        if (response.data.data && response.data.data[address]) {
            const data = response.data.data[address];
            return {
                balance: parseFloat(data.address.balance) / 1e8,
                transactions: data.address.transaction_count || 0,
                totalReceived: parseFloat(data.address.received) / 1e8,
                totalSent: parseFloat(data.address.spent) / 1e8
            };
        }
        return { balance: 0, transactions: 0, totalReceived: 0, totalSent: 0 };
    } catch (error) {
        console.error(`${coin} balance error:`, error);
        return { balance: 0, transactions: 0, totalReceived: 0, totalSent: 0 };
    }
}

// ─── HELPER: Get Solana balance ───
async function getSolanaBalance(address) {
    try {
        const response = await axios.post(
            SOLANA_RPC,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'getBalance',
                params: [address]
            },
            { timeout: 10000 }
        );
        if (response.data.result) {
            return parseFloat(response.data.result.value) / 1e9;
        }
        return 0;
    } catch (error) {
        console.error('Solana balance error:', error);
        return 0;
    }
}

// ─── HELPER: Get Solana transaction count ───
async function getSolanaTxCount(address) {
    try {
        const response = await axios.post(
            SOLANA_RPC,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignaturesForAddress',
                params: [address, { limit: 1 }]
            },
            { timeout: 10000 }
        );
        if (response.data.result) {
            return response.data.result.length;
        }
        return 0;
    } catch (error) {
        console.error('Solana tx count error:', error);
        return 0;
    }
}

// ─── HELPER: Get TRON balance ───
async function getTronBalance(address) {
    try {
        const response = await axios.get(
            `${TRON_GRID}/v1/accounts/${address}`,
            { timeout: 10000 }
        );
        if (response.data.data && response.data.data.length > 0) {
            const account = response.data.data[0];
            const balance = account.balance || 0;
            // TRX has 6 decimal places
            return parseFloat(balance) / 1e6;
        }
        return 0;
    } catch (error) {
        console.error('TRON balance error:', error);
        return 0;
    }
}

// ─── HELPER: Get TRON transaction count ───
async function getTronTxCount(address) {
    try {
        const response = await axios.get(
            `${TRON_GRID}/v1/accounts/${address}/transactions?limit=1`,
            { timeout: 10000 }
        );
        if (response.data.data) {
            return response.data.data.length;
        }
        return 0;
    } catch (error) {
        console.error('TRON tx count error:', error);
        return 0;
    }
}

// ─── MAIN ROUTE: POST /api/wallet-checker/balance ───
router.post('/balance', async (req, res) => {
    console.log('📊 Balance check request received:', req.body);

    try {
        const { address, coin = 'btc' } = req.body;

        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Wallet address is required'
            });
        }

        if (!COINS[coin]) {
            return res.status(400).json({
                success: false,
                error: `Coin '${coin}' not supported`
            });
        }

        const config = COINS[coin];
        const cacheKey = `${coin}_${address}`;
        const cached = cache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            console.log('📦 Returning cached result');
            return res.json({
                success: true,
                data: cached.data,
                cached: true
            });
        }

        let result = {
            address,
            coin,
            symbol: config.symbol,
            balance: 0,
            transactions: 0,
            totalReceived: 0,
            totalSent: 0,
            firstTx: '—',
            status: 'success'
        };

        // ─── Fetch balance based on coin type ───
        try {
            const type = config.type;

            if (type === 'utxo') {
                if (coin === 'btc') {
                    result.balance = await getBtcBalance(address);
                } else {
                    const data = await getBlockchairBalance(address, coin);
                    result.balance = data.balance;
                    result.transactions = data.transactions;
                    result.totalReceived = data.totalReceived;
                    result.totalSent = data.totalSent;
                }
            } else if (type === 'evm') {
                result.balance = await getEthBalance(address);
                result.transactions = 0;
            } else if (type === 'solana') {
                const [balance, txs] = await Promise.all([
                    getSolanaBalance(address),
                    getSolanaTxCount(address)
                ]);
                result.balance = balance;
                result.transactions = txs;
                result.firstTx = txs > 0 ? 'Recent' : '—';
            } else if (type === 'tron') {
                const [balance, txs] = await Promise.all([
                    getTronBalance(address),
                    getTronTxCount(address)
                ]);
                result.balance = balance;
                result.transactions = txs;
                result.firstTx = txs > 0 ? 'Recent' : '—';
            } else {
                result.balance = 0;
                result.status = 'pending';
                result.firstTx = 'Not available';
            }
        } catch (balanceError) {
            console.error('Balance fetch error:', balanceError);
            result.balance = 0;
            result.status = 'error';
        }

        // ─── Get price ───
        try {
            const price = await getPrice(config.coingeckoId);
            result.price = price || 0;
        } catch (priceError) {
            result.price = 0;
        }

        // ─── Format balance for display ───
        const symbol = config.symbol;
        const balanceStr = result.balance.toFixed(symbol === 'BTC' ? 8 : 
                                                   symbol === 'SOL' ? 6 : 
                                                   symbol === 'TRX' ? 2 : 4);
        result.formatted_balance = `${balanceStr} ${symbol}`;
        result.formatted_usd = `$${(result.balance * result.price).toFixed(2)} USD`;

        // ─── Cache ───
        cache.set(cacheKey, { data: result, timestamp: Date.now() });

        console.log(`✅ Balance for ${coin}: ${result.balance}`);
        res.json({
            success: true,
            data: result
        });

    } catch (error) {
        console.error('Balance check error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to check wallet balance'
        });
    }
});

// ─── GET /api/wallet-checker/coins ───
router.get('/coins', async (req, res) => {
    const coins = Object.keys(COINS).map(key => ({
        id: key,
        name: COINS[key].name,
        symbol: COINS[key].symbol,
        type: COINS[key].type
    }));
    res.json({ success: true, coins });
});

// ─── GET /api/wallet-checker/health ───
router.get('/health', async (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        coins: Object.keys(COINS).length,
        cache_size: cache.size,
        timestamp: new Date().toISOString()
    });
});

// ─── TEST ROUTE ───
router.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'Wallet checker route is working!',
        routes: [
            'POST /balance - Check wallet balance',
            'GET /coins - List supported coins',
            'GET /health - Health check',
            'GET /test - Test route'
        ],
        supported_coins: Object.keys(COINS).join(', ')
    });
});

module.exports = router;