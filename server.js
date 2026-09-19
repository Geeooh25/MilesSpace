// server.js - COMPLETE FIXED VERSION
// Uses reconciliationService for both cashback and airtime reconciliation

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

require('dotenv').config();

// ─── ENVIRONMENT CHECK ───
const requiredEnvVars = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'JWT_SECRET'
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
    console.error('\n❌ CRITICAL: Missing required environment variables:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error('\n💡 Please add them to your .env file and restart the server.\n');
    process.exit(1);
}

console.log('✅ All required environment variables are set');

const app = express();
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

// ─── TRUST PROXY ───
app.set('trust proxy', 1);

// ─── SECURITY HEADERS ───
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://*.supabase.co", "wss://*.supabase.co", "ws://localhost:*", "http://localhost:*", "https://cdn.jsdelivr.net"],
            frameAncestors: ["'none'"],
            workerSrc: ["'self'", "blob:"]
        }
    }
}));

console.log('✅ Security headers enabled');

// ─── COMPRESSION ───
app.use(compression());
console.log('✅ Compression enabled');

// ─── CORS ───
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:3000',
    'http://localhost:5000',
    'https://milesspace.com',
    'https://www.milesspace.com'
];

app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1 || !isProduction) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Session-Id', 'Idempotency-Key']
}));

console.log('✅ CORS configured');

// ─── BODY PARSING ───
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ─── RATE LIMITING ─────────────────────────────────────────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: {
        success: false,
        error: 'Too many authentication requests from this IP',
        code: 'AUTH_RATE_LIMIT'
    },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/auth', authLimiter);
console.log('✅ Rate limiting enabled (auth routes only)');

// ─── STATIC FILES ───
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════
// 🔐 AUTHENTICATION ROUTES
// ═══════════════════════════════════════════════════════

const authRoutes = require('./routes/authRoutes');
app.use('/api/auth', authRoutes);

// ─── ADMIN AUTH ROUTES ─────────────────────────────────
const adminAuthRoutes = require('./routes/admin');
app.use('/api/admin', adminAuthRoutes);
console.log('✅ Admin auth routes loaded at /api/admin');

// ═══════════════════════════════════════════════════════
// 🛠️ ROUTE LOADER
// ═══════════════════════════════════════════════════════

console.log('📦 Loading routes...');

function safeRequire(modulePath) {
    try {
        const mod = require(modulePath);
        if (mod && typeof mod === 'function') return mod;
        if (mod && typeof mod === 'object' && mod.router) return mod.router;
        return mod;
    } catch (error) {
        console.warn(`⚠️ Failed to load ${modulePath}:`, error.message);
        return null;
    }
}

function safeMount(app, path, route) {
    if (route && typeof route === 'function') {
        try {
            app.use(path, route);
            console.log(`  ✅ ${path} → loaded`);
            return true;
        } catch (error) {
            console.warn(`  ❌ ${path} → ${error.message}`);
            return false;
        }
    }
    console.log(`  ⚠️ ${path} → skipped (not found)`);
    return false;
}

// ─── IMPORT ROUTES ───
const supportRoutes = require('./routes/support');
const cashbackRoutes = require('./routes/cashback');
const transactionRoutes = require('./routes/transactionRoutes');
const bushaRoutes = require('./routes/busha');
const tickerRoutes = require('./routes/tickerRoutes');

// ─── IMPORT RECONCILIATION SERVICE ──────────────────────────────────────
// ✅ Using reconciliationService for both cashback and airtime
const reconciliationService = require('./services/reconciliationService');
const { startQuoteReaper } = require('./services/dtoneQuoteReaper');
startQuoteReaper();

// ─── ADMIN DASHBOARD ROUTES ───
const adminDashboardRoutes = require('./routes/admin/dashboardRoutes');
const adminPresenceRoutes = require('./routes/admin/presenceAdminRoutes');
const adminIntelligenceRoutes = require('./routes/admin/intelligenceRoutes');
const adminGiftRoutes = require('./routes/admin/giftAdminRoutes');
const adminCryptoRoutes = require('./routes/admin/cryptoRoutes');

// ─── MARKETPLACE ROUTES ───
const marketplaceRoutes = safeRequire('./routes/admin/marketplaceRoutes');
// ─── OTHER ADMIN ROUTES ───
const messageRoutes = safeRequire('./routes/messages');
const giftAdminRoutes = safeRequire('./routes/admin/giftAdminRoutes');
const cryptoRoutes = safeRequire('./routes/admin/cryptoRoutes');
const giftcardAdminRoutes = safeRequire('./routes/admin/giftcardAdminRoutes');
const adminUserRoutes = safeRequire('./routes/admin/userRoutes');
const adminTransactionRoutes = safeRequire('./routes/admin/transactionRoutes');
const adminAuditRoutes = safeRequire('./routes/admin/auditRoutes');
const adminSettingsRoutes = require('./routes/admin/adminSettings');
// ─── USER ROUTES ───
const boostRoutes = safeRequire('./routes/boostRoutes');

const smsRoutes = safeRequire('./routes/smsRoutes');
const notificationRoutes = safeRequire('./routes/notificationRoutes');
const profileRoutes = safeRequire('./routes/profileRoutes');
const marketRoutes = safeRequire('./routes/marketRoutes');
const giftCardRoutes = safeRequire('./routes/giftCardRoutes');
const giftRoutes = safeRequire('./routes/giftRoutes');
const presenceRoutes = safeRequire('./routes/presenceRoutes');
const walletRoutes = safeRequire('./routes/wallet/index');
const bankRoutes = safeRequire('./routes/bankRoutes');
const nowPaymentsRoutes = safeRequire('./routes/wallet/nowpayments');
const paystackRoutes = safeRequire('./routes/wallet/paystack');
const withdrawals = safeRequire('./routes/wallet/withdrawals');
const beneficiaryRoutes = require('./routes/wallet/beneficiaries');
const userSettingsRoutes = safeRequire('./routes/userSettingsRoutes');
const virtualRoutes = require('./routes/virtual-router');
const esimRoutes = require('./routes/esimRoutes');
console.log('✅ eBills routes loaded at /api/ebills');
app.use('/api/esim', esimRoutes);
const ratesRoutes = require('./routes/ratesRoutes');
app.use('/api/rates', ratesRoutes);
console.log('✅ Rates routes loaded at /api/rates');
const koraDepositsRoutes = require('./routes/wallet/koraDeposits');
app.use('/api/wallet', koraDepositsRoutes);
console.log('✅ Kora multi-currency deposit routes loaded at /api/wallet');

console.log('\n📦 Mounting routes:');

// ─── CORE ROUTES ───
safeMount(app, '/api/cashback', cashbackRoutes);
safeMount(app, '/api/support', supportRoutes);
safeMount(app, '/api/transactions', transactionRoutes);
safeMount(app, '/api/busha', bushaRoutes);
safeMount(app, '/api/crypto', bushaRoutes);

// ─── USER ROUTES ───
safeMount(app, '/api/boost', boostRoutes);
safeMount(app, '/api/sms', smsRoutes);
safeMount(app, '/api/notifications', notificationRoutes);
safeMount(app, '/api/profile', profileRoutes);
safeMount(app, '/api/market', marketRoutes);
safeMount(app, '/api', giftCardRoutes);
safeMount(app, '/api/gifts', giftRoutes);
safeMount(app, '/api/presence', presenceRoutes);
safeMount(app, '/api/banks', bankRoutes);
safeMount(app, '/api/wallet', walletRoutes);
safeMount(app, '/api/wallet/beneficiaries', beneficiaryRoutes);
safeMount(app, '/api/wallet/withdraw', withdrawals);
safeMount(app, '/api/wallet/nowpayments', nowPaymentsRoutes);
safeMount(app, '/api/wallet/paystack', paystackRoutes);
safeMount(app, '/api/user', userSettingsRoutes);
safeMount(app, '/api/ticker', tickerRoutes);
app.use('/api/virtual', virtualRoutes);

// ─── ADMIN DASHBOARD ROUTES ─────────────────────────────────────
safeMount(app, '/api/admin', adminDashboardRoutes);
safeMount(app, '/api/admin/presence', adminPresenceRoutes);
safeMount(app, '/api/admin', adminIntelligenceRoutes);
safeMount(app, '/api/admin', adminGiftRoutes);
safeMount(app, '/api/admin', adminCryptoRoutes);
app.use('/api/admin', adminSettingsRoutes);

// ─── MARKETPLACE ROUTES ──────────────────────────────────────────
if (marketplaceRoutes) {
    safeMount(app, '/api/admin/marketplace', marketplaceRoutes);
} else {
    console.log('  ⚠️ /api/admin/marketplace → skipped (not found)');
}

// ─── OTHER ADMIN ROUTES ──────────────────────────────────────────
if (messageRoutes) app.use('/api/messages', messageRoutes);
if (giftAdminRoutes) app.use('/api/admin', giftAdminRoutes);
if (cryptoRoutes) app.use('/api/admin/crypto', cryptoRoutes);
if (giftcardAdminRoutes) app.use('/api/admin', giftcardAdminRoutes);
if (adminUserRoutes) app.use('/api/admin', adminUserRoutes);
if (adminTransactionRoutes) app.use('/api/admin', adminTransactionRoutes);
if (adminAuditRoutes) app.use('/api/admin', adminAuditRoutes);

// ─── AIRTIME ROUTES ─────────────────────────────────────────────────────
const airtimeRoutes = require('./routes/airtime');
app.use('/api/airtime', airtimeRoutes);
console.log('✅ Airtime routes loaded at /api/airtime');

// ─── RECONCILIATION ROUTES ─────────────────────────────────────────────
const reconciliationRoutes = require('./routes/reconciliationRoutes');
app.use('/api/reconciliation', reconciliationRoutes);
console.log('✅ Reconciliation routes loaded at /api/reconciliation');
const { startReconciliationScheduler } = require('./services/airtimeReconciliationService');
startReconciliationScheduler();
console.log('\n✅ All routes mounted successfully');

// ─── RECONCILIATION SERVICE ──────────────────────────────────────────────
// ✅ Using reconciliationService for both cashback and airtime

console.log(`📊 Reconciliation service loaded`);

// ─── BILLS ROUTES (Airtime, Data, Electricity, TV, Education) ───
const billsRoutes = require('./routes/billsRoutes');
app.use('/api/bills', billsRoutes);
console.log('✅ Bills routes loaded at /api/bills');

// ─── Start Bills Reconciliation ───
const { startBillsReconciliationScheduler } = require('./services/billsReconciliationService');
startBillsReconciliationScheduler();
console.log('✅ Bills reconciliation scheduler started');

// Run full reconciliation every 5 minutes
setInterval(async () => {
    try {
        console.log('🔄 Running full reconciliation sweep...');
        const result = await reconciliationService.runFullReconciliation();
        if (result) {
            console.log(`✅ Reconciliation complete: Cashback: ${result.cashback?.processed || 0}, Airtime: ${result.airtime?.processed || 0}`);
        }
    } catch (error) {
        console.error('❌ Reconciliation sweep error:', error);
    }
}, 5 * 60 * 1000);

// Run immediately on startup
setTimeout(async () => {
    console.log('🔄 Running initial reconciliation sweep...');
    try {
        const result = await reconciliationService.runFullReconciliation();
        if (result) {
            console.log(`✅ Initial reconciliation complete: Cashback: ${result.cashback?.processed || 0}, Airtime: ${result.airtime?.processed || 0}`);
        }
    } catch (error) {
        console.error('❌ Initial reconciliation error:', error);
    }
}, 10000);

// Every 5 min: look for deposits stuck in 'pending'/'processing' and re-verify.
setInterval(async () => {
    try {
        const { data: stuck } = await supabaseAdmin
            .from('deposit_requests')
            .select('id, provider_reference, merchant_reference')
            .eq('provider', 'korapay')
            .in('status', ['pending', 'processing'])
            .lt('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
            .limit(50);

        for (const dep of stuck || []) {
            const ref = dep.provider_reference || dep.merchant_reference;
            try {
                const verified = await korapayService.verifyTransaction(ref);
                verified._verified = true;
                await depositService.completeKoraDeposit({
                    depositId: dep.id,
                    providerTransaction: verified,
                    source: 'reconciliation'
                });
            } catch (e) {
                // Silently continue
            }
        }
    } catch (e) {
        console.error('[RECONCILE] error:', e.message);
    }
}, 5 * 60 * 1000);

console.log('🔄 Reconciliation service started (runs every 5 minutes)');

// ─── FALLBACK LOGO ───
app.get('/images/miles-logo.png', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
        <circle cx="50" cy="50" r="45" fill="#0c3d4a"/>
        <text x="50" y="65" text-anchor="middle" fill="white" font-size="40" font-weight="bold">M</text>
    </svg>`);
});

// ═══════════════════════════════════════════════════════
// 📄 HEALTH CHECK
// ═══════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ═══════════════════════════════════════════════════════
// 🖥️ FRONTEND ROUTES
// ═══════════════════════════════════════════════════════

// ─── USER FRONTEND ──────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/market', (req, res) => res.sendFile(path.join(__dirname, 'public', 'market.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/fund', (req, res) => res.sendFile(path.join(__dirname, 'public', 'fund.html')));
app.get('/airtime', (req, res) => res.sendFile(path.join(__dirname, 'public', 'airtime.html')));
app.get('/boost', (req, res) => res.sendFile(path.join(__dirname, 'public', 'boost.html')));
app.get('/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));
app.get('/notifications', (req, res) => res.sendFile(path.join(__dirname, 'public', 'notifications.html')));
app.get('/virtual', (req, res) => res.sendFile(path.join(__dirname, 'public', 'virtual.html')));
app.get('/sellgift', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sellgift.html')));
app.get('/sendgift', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sendgift.html')));
app.get('/cashback', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cashback.html')));
app.get('/coin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'coin.html')));
app.get('/buy-crypto', (req, res) => res.sendFile(path.join(__dirname, 'public', 'coin.html')));
app.get('/login', (req, res) => res.redirect('/signup'));
app.get('/usersettings', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'usersettings.html'));
});

// ─── AIRTIME FRONTEND ──────────────────────────────────────────────
app.get('/airtime', (req, res) => res.sendFile(path.join(__dirname, 'public', 'airtime.html')));

// ─── ADMIN FRONTEND ────────────────────────────────────────────────
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

app.get('/admin/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html')));
app.get('/admin/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html')));
app.get('/admin/boost', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'boost.html')));
app.get('/admin/users', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'users.html')));
app.get('/admin/transactions', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'transactions.html')));
app.get('/admin/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'settings.html')));
app.get('/admin/messages', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'messages.html')));
app.get('/admin/notifications', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'notifications.html')));
app.get('/admin/reports', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'reports.html')));
app.get('/admin/support', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'support.html')));
app.get('/admin/ticker-manager', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'ticker-manager.html')));
app.get('/admin/sellgift', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'sellgift.html')));
app.get('/admin/marketplace-products', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'marketplace-products.html')));
app.get('/admin/wallet-deposits', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'wallet-deposits.html')));
app.get('/admin/virtual-sms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'virtual-sms.html')));
app.get('/admin/crypto', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'crypto.html')));

app.get(/^\/admin\/(.+)$/, (req, res) => {
    const requestedPath = req.params[0] || '';
    if (requestedPath && requestedPath.includes('.')) {
        const fullPath = path.join(__dirname, 'public', 'admin', requestedPath);
        if (fs.existsSync(fullPath)) {
            return res.sendFile(fullPath);
        }
    }
    res.redirect('/admin/dashboard.html');
});

// ═══════════════════════════════════════════════════════
// 🚫 404 HANDLER
// ═══════════════════════════════════════════════════════

app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({
            success: false,
            error: `API endpoint ${req.method} ${req.path} not found`,
            code: 'NOT_FOUND'
        });
    }
    if (!req.path.includes('.')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    res.status(404).send('File not found');
});

// ─── ERROR HANDLER ───
app.use((err, req, res, next) => {
    console.error('Server error:', err.stack);
    const message = isProduction ? 'Something went wrong' : err.message;
    res.status(err.status || 500).json({
        success: false,
        error: message,
        code: err.code || 'SERVER_ERROR'
    });
});

// ═══════════════════════════════════════════════════════
// 🔌 SOCKET.IO SERVER WITH PRESENCE
// ═══════════════════════════════════════════════════════

// ─── CREATE HTTP SERVER ──────────────────────────────────────────
const server = http.createServer(app);

// ─── CREATE SOCKET.IO INSTANCE ──────────────────────────────────
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        credentials: true,
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// ─── MAKE IO GLOBALLY AVAILABLE ─────────────────────────────────
global.io = io;

const JWT_SECRET = process.env.JWT_SECRET;

// ─── Built-in Presence Manager ──────────────────────────────────
const presenceManager = {
    users: new Map(),
    admins: new Map(),
    total: 0,
    totalUsers: 0,
    totalAdmins: 0,

    addConnection({ userId, role, socketId, username, email, avatarUrl }) {
        const isAdmin = role === 'admin' || role === 'super_admin';
        const targetMap = isAdmin ? this.admins : this.users;

        if (!targetMap.has(userId)) {
            targetMap.set(userId, { 
                sockets: new Set(), 
                userData: { 
                    username: username || 'User',
                    email: email || '',
                    avatarUrl: avatarUrl || null,
                    role: role || 'user',
                    current_page: '/dashboard',
                    current_action: 'viewing',
                    lastSeen: new Date().toISOString()
                } 
            });
        }
        const entry = targetMap.get(userId);
        entry.sockets.add(socketId);
        entry.userData.lastSeen = new Date().toISOString();

        if (isAdmin) {
            this.totalAdmins = this.admins.size;
        } else {
            this.totalUsers = this.users.size;
        }
        this.total = this.users.size + this.admins.size;
    },

    removeConnection(userId, socketId) {
        const isAdmin = this.admins.has(userId);
        const targetMap = isAdmin ? this.admins : this.users;

        if (targetMap.has(userId)) {
            const entry = targetMap.get(userId);
            entry.sockets.delete(socketId);
            if (entry.sockets.size === 0) {
                targetMap.delete(userId);
            }
        }

        if (isAdmin) {
            this.totalAdmins = this.admins.size;
        } else {
            this.totalUsers = this.users.size;
        }
        this.total = this.users.size + this.admins.size;
        return this.users.has(userId) || this.admins.has(userId);
    },

    updatePage(userId, page, action) {
        const isAdmin = this.admins.has(userId);
        const targetMap = isAdmin ? this.admins : this.users;

        if (targetMap.has(userId)) {
            const entry = targetMap.get(userId);
            entry.userData.current_page = page || '/dashboard';
            entry.userData.current_action = action || 'viewing';
            entry.userData.lastSeen = new Date().toISOString();
        }
    },

    getOnlineUsers() {
        const users = [];
        const admins = [];

        for (const [userId, entry] of this.users) {
            users.push({
                user_id: userId,
                ...entry.userData,
                socketCount: entry.sockets.size,
                is_online: true,
                is_admin: false
            });
        }

        for (const [userId, entry] of this.admins) {
            admins.push({
                user_id: userId,
                ...entry.userData,
                socketCount: entry.sockets.size,
                is_online: true,
                is_admin: true
            });
        }

        return {
            total: this.total,
            totalUsers: this.totalUsers,
            totalAdmins: this.totalAdmins,
            users: users,
            admins: admins
        };
    },

    getUser(userId) {
        if (this.users.has(userId)) {
            const entry = this.users.get(userId);
            return {
                user_id: userId,
                ...entry.userData,
                socketCount: entry.sockets.size,
                is_online: true,
                is_admin: false
            };
        }
        if (this.admins.has(userId)) {
            const entry = this.admins.get(userId);
            return {
                user_id: userId,
                ...entry.userData,
                socketCount: entry.sockets.size,
                is_online: true,
                is_admin: true
            };
        }
        return null;
    }
};

// ─── Socket.IO Authentication ─────────────────────────
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;

        if (!token) {
            return next(new Error('Authentication required'));
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        if (!decoded.id) {
            return next(new Error('Invalid user ID'));
        }

        const { supabaseAdmin } = require('./db/supabase');
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('id, email, username, role, status, avatar_url')
            .eq('id', decoded.id)
            .single();

        if (error || !profile) {
            return next(new Error('User not found'));
        }

        if (profile.status === 'suspended') {
            return next(new Error('Account suspended'));
        }

        socket.userId = profile.id;
        socket.userRole = profile.role || 'user';
        socket.userEmail = profile.email;
        socket.userName = profile.username || profile.email?.split('@')[0] || 'User';
        socket.userAvatar = profile.avatar_url || null;
        socket.sessionId = decoded.sid || null;

        next();

    } catch (error) {
        console.error('❌ Socket auth error:', error.message);
        return next(new Error('Invalid authentication'));
    }
});

// ─── Socket.IO Connection Handler ─────────────────────
io.on('connection', (socket) => {
    const userId = socket.userId;
    const userName = socket.userName;
    const userRole = socket.userRole;

    console.log(`🔌 User connected: ${userName} (${userId}) [${userRole}]`);

    presenceManager.addConnection({
        userId: userId,
        role: userRole,
        socketId: socket.id,
        username: userName,
        email: socket.userEmail,
        avatarUrl: socket.userAvatar
    });

    io.emit('presence:update', presenceManager.getOnlineUsers());

    socket.join(`user:${userId}`);

    if (userRole === 'admin' || userRole === 'super_admin') {
        socket.join('admins');
        console.log(`👑 Admin ${userName} joined admin room`);
    }

    socket.on('page:change', (data) => {
        const { page, action, metadata } = data;

        presenceManager.updatePage(userId, page, action);

        io.to('admins').emit('user:activity', {
            userId: userId,
            username: userName,
            role: userRole,
            page: page,
            action: action || 'viewing',
            timestamp: new Date().toISOString(),
            metadata: metadata || {}
        });

        io.to('admins').emit('presence:update', presenceManager.getOnlineUsers());
    });

    socket.on('ping', () => {
        presenceManager.updatePage(userId, socket.currentPage || '/dashboard');
    });

    socket.on('disconnect', (reason) => {
        console.log(`🔌 User disconnected: ${userName} (${userId}) - ${reason}`);

        const remaining = presenceManager.removeConnection(userId, socket.id);

        if (!remaining) {
            io.emit('presence:update', presenceManager.getOnlineUsers());
            io.to('admins').emit('user:offline', {
                userId: userId,
                username: userName,
                timestamp: new Date().toISOString()
            });
        } else {
            io.to('admins').emit('presence:update', presenceManager.getOnlineUsers());
        }
    });

    socket.on('error', (error) => {
        console.error(`❌ Socket error for ${userName}:`, error);
    });
});

console.log('✅ Socket.IO configured with presence manager');

// ═══════════════════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════════════════

server.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔌 Socket.IO enabled with real-time presence`);
    console.log(`\n📄 Frontend URLs:`);
    console.log(`   → Landing Page: http://localhost:${PORT}/`);
    console.log(`   → Signup/Login: http://localhost:${PORT}/signup`);
    console.log(`   → User Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`   → Airtime: http://localhost:${PORT}/airtime`);
    console.log(`\n🔗 API Base: http://localhost:${PORT}/api`);
    console.log(`\n🔐 Admin URLs:`);
    console.log(`   → Admin Login:  http://localhost:${PORT}/admin/index.html`);
    console.log(`   → Admin Dashboard: http://localhost:${PORT}/admin/dashboard.html`);
    console.log(`   → Admin Users:   http://localhost:${PORT}/admin/users.html`);
    console.log(`   → Admin Transactions: http://localhost:${PORT}/admin/transactions.html`);
    console.log(`   → Admin Settings: http://localhost:${PORT}/admin/settings.html`);
    console.log(`   → Marketplace Products: http://localhost:${PORT}/admin/marketplace-products.html`);
    console.log(`\n🔐 Admin API Endpoints:`);
    console.log(`   → POST   /api/admin/login`);
    console.log(`   → GET    /api/admin/session`);
    console.log(`   → GET    /api/admin/me`);
    console.log(`   → POST   /api/admin/logout`);
    console.log(`   → POST   /api/admin/refresh`);
    console.log(`   → GET    /api/admin/verify`);
    console.log(`   → GET    /api/admin/stats`);
    console.log(`   → GET    /api/admin/recent-activity`);
    console.log(`   → GET    /api/admin/users/recent`);
    console.log(`   → GET    /api/admin/transactions/recent`);
    console.log(`   → GET    /api/admin/presence/online`);
    console.log(`   → GET    /api/admin/charts`);
    console.log(`   → GET    /api/admin/health`);
    console.log(`   → GET    /api/admin/top-customers`);
    console.log(`   → GET    /api/admin/marketplace/products`);
    console.log(`   → GET    /api/admin/marketplace/stats`);
    console.log(`   → GET    /api/admin/marketplace/categories`);
    console.log(`   → GET    /api/admin/marketplace/orders`);
    console.log(`\n🔐 Airtime API Endpoints:`);
    console.log(`   → GET    /api/airtime/countries`);
    console.log(`   → GET    /api/airtime/operators`);
    console.log(`   → POST   /api/airtime/operator-detect`);
    console.log(`   → POST   /api/airtime/quote`);
    console.log(`   → POST   /api/airtime/purchase`);
    console.log(`   → GET    /api/airtime/history`);
    console.log(`   → GET    /api/airtime/:reference`);
    console.log(`   → POST   /api/airtime/webhook`);
    console.log(`   → POST   /api/airtime/admin/reconcile/:reference`);
    console.log(`\n🔐 Reconciliation API Endpoints:`);
    console.log(`   → GET    /api/reconciliation/airtime/pending`);
    console.log(`   → POST   /api/reconciliation/airtime/sweep`);
    console.log(`   → POST   /api/reconciliation/airtime/force/:id`);
    console.log(`   → GET    /api/reconciliation/airtime/stats`);
    console.log(`   → POST   /api/reconciliation/airtime/bulk`);
    console.log(`\n`);
});

module.exports = { server, io, presenceManager };