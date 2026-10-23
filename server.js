// server.js — MilesSpace backend entry point
// ─────────────────────────────────────────────────────────────────
// Order of routes matters. Reading top to bottom:
//   1. env, security, cors, parsers
//   2. auth + admin auth
//   3. user routes
//   4. admin API routes (transactions → money → dashboard → misc)
//   5. admin page routes (static)
//   6. reconciliation schedulers + background loops
//   7. Socket.IO presence
//   8. HTTP listen
//
// Do not reorder the admin mounts without checking path overlap.
// ─────────────────────────────────────────────────────────────────

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
const cookieParser = require('cookie-parser');

require('dotenv').config();

// ─── SHARED SERVICES (used by background reconciliation loops) ───
const { supabaseAdmin } = require('./db/supabase');
const korapayService    = require('./services/korapayService');
const depositService    = require('./services/depositService');

// ─── ENVIRONMENT CHECK ───────────────────────────────────────────
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

// ─── TRUST PROXY ─────────────────────────────────────────────────
app.set('trust proxy', 1);

// ─── SECURITY HEADERS ────────────────────────────────────────────
// CSP kept functionally identical to what the existing frontend
// requires. connectSrc now includes the Render origin so that
// pages served by Render (admin, fallback index) can open Socket.IO
// to the same origin, and the Vercel frontend's API calls are
// allowed to reach Render from any Render-served page.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com",
                  "https://korablobstorage.blob.core.windows.net"
            ],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://fonts.googleapis.com",
                "https://cdnjs.cloudflare.com"
            ],
            fontSrc: [
                "'self'",
                "https://fonts.gstatic.com",
                "https://cdnjs.cloudflare.com"
            ],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: [
                "'self'",
                "https://*.supabase.co",
                "wss://*.supabase.co",
                "https://milesspace.onrender.com",
                "wss://milesspace.onrender.com",
                "https://milesspace-public.vercel.app",
                "https://milesspace.com",
                "https://www.milesspace.com",
                 "https://www.milesspace.com",
                "https://api.korapay.com",            // <-- ADD THIS (Korapay API calls)
                "https://*.korapay.com", 
                "ws://localhost:*",
                "http://localhost:*",
                "https://cdn.jsdelivr.net",
                
            ],
            frameAncestors: ["'none'"],
            frameSrc: ["'self'", "https://*.korapay.com"], 
            workerSrc: ["'self'", "blob:"]
        }
    }
}));

console.log('✅ Security headers enabled');

// ─── COMPRESSION ─────────────────────────────────────────────────
app.use(compression());
console.log('✅ Compression enabled');

// ─── COOKIE PARSER ───────────────────────────────────────────────
// Required by the HttpOnly refresh-token flow in /api/auth/refresh
// and /api/auth/logout. Does not change any other route behaviour.
app.use(cookieParser());
console.log('✅ Cookie parser enabled');

// ─── CORS ────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:3000',
    'http://localhost:5000',
    'https://milesspace-public.vercel.app',
    'https://milesspace.onrender.com',
    'https://milesspace.com',
    'https://www.milesspace.com'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1 || !isProduction) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'X-Session-Id',
        'Idempotency-Key'
    ]
}));

console.log('✅ CORS configured');

// ═══════════════════════════════════════════════════════════════════
//  KORA WEBHOOK — MOUNTED BEFORE THE GLOBAL JSON PARSER
// ───────────────────────────────────────────────────────────────────
// The Kora webhook route declares its own express.json({verify})
// so it can capture the raw body bytes for signature verification.
// If the global express.json() below runs first, the body is
// already consumed by the time the webhook handler executes and
// req.rawBody is undefined — the signature then has to be verified
// against a re-serialized body, which occasionally fails on
// non-ASCII payloads or unusual numeric formatting.
//
// By mounting the router BEFORE the global parser, the webhook
// path gets its own parser and the raw body. Every other route in
// that router uses Express's default JSON parsing (which the
// router's own express.json({verify}) still provides), so their
// behaviour is unchanged.
//
// IMPORTANT: This router must NOT be mounted again below. See
// the user-routes section where the duplicate was removed.
// ═══════════════════════════════════════════════════════════════════
const koraDepositsRoutes = require('./routes/wallet/koraDeposits');
app.use('/api/wallet', koraDepositsRoutes);
console.log('✅ Kora deposit routes mounted before global JSON parser');

// ─── BODY PARSING (ALL OTHER ROUTES) ─────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ─── RATE LIMITING ───────────────────────────────────────────────
// ── General auth bucket ──────────────────────────────────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: {
        success: false,
        error: 'Too many authentication requests from this IP',
        code: 'AUTH_RATE_LIMIT'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        const p = req.path || '';
        return (
            p === '/refresh' ||
            p === '/session' ||
            p === '/heartbeat'
        );
    }
});

app.use('/api/auth', authLimiter);
console.log('✅ Rate limiting enabled (auth routes, refresh/session/heartbeat exempted)');

// ─── STATIC FILES ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════

const authRoutes = require('./routes/authRoutes');
app.use('/api/auth', authRoutes);

// ─── ADMIN AUTH ROUTES ───────────────────────────────────────────
const adminAuthRoutes = require('./routes/admin');
app.use('/api/admin', adminAuthRoutes);
console.log('✅ Admin auth routes loaded at /api/admin');

// ─── ADMIN LOGIN RATE LIMITING ───────────────────────────────────
const { adminApiLimiter, adminLoginLimiter } = require('./middleware/adminRateLimit');
app.use('/api/admin/login', adminLoginLimiter);
app.use('/api/admin', adminApiLimiter);
console.log('✅ Admin rate limiting enabled');

// ═══════════════════════════════════════════════════════════════════
//  ROUTE LOADER HELPERS
// ═══════════════════════════════════════════════════════════════════

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

function safeMount(app, prefix, route) {
    if (route && typeof route === 'function') {
        try {
            app.use(prefix, route);
            console.log(`  ✅ ${prefix} → loaded`);
            return true;
        } catch (error) {
            console.warn(`  ❌ ${prefix} → ${error.message}`);
            return false;
        }
    }
    console.log(`  ⚠️ ${prefix} → skipped (not found)`);
    return false;
}

// ═══════════════════════════════════════════════════════════════════
//  USER ROUTES
// ═══════════════════════════════════════════════════════════════════

const supportRoutes        = require('./routes/support');
const transactionRoutes    = require('./routes/transactionRoutes');
const tickerRoutes         = require('./routes/tickerRoutes');

const boostRoutes          = safeRequire('./routes/boostRoutes');
const smsRoutes            = safeRequire('./routes/smsRoutes');
const notificationRoutes   = safeRequire('./routes/notificationRoutes');
const profileRoutes        = safeRequire('./routes/profileRoutes');
const marketRoutes         = safeRequire('./routes/marketRoutes');
const giftCardRoutes       = safeRequire('./routes/giftCardRoutes');
const presenceRoutes       = safeRequire('./routes/presenceRoutes');
const walletRoutes         = safeRequire('./routes/wallet/index');
const bankRoutes           = safeRequire('./routes/bankRoutes');
const nowPaymentsRoutes    = safeRequire('./routes/wallet/nowpayments');

const beneficiaryRoutes    = require('./routes/wallet/beneficiaries');
const userSettingsRoutes   = safeRequire('./routes/userSettingsRoutes');
const virtualRoutes        = require('./routes/virtual-router');
const esimRoutes           = require('./routes/esimRoutes');
const ratesRoutes          = require('./routes/ratesRoutes');
const airtimeRoutes        = require('./routes/airtime');
const billsRoutes          = require('./routes/billsRoutes');
const reconciliationRoutes = require('./routes/reconciliationRoutes');

console.log('\n📦 Mounting user routes:');

safeMount(app, '/api/support', supportRoutes);
safeMount(app, '/api/transactions', transactionRoutes);

safeMount(app, '/api/boost', boostRoutes);
safeMount(app, '/api/sms', smsRoutes);
safeMount(app, '/api/notifications', notificationRoutes);
safeMount(app, '/api/profile', profileRoutes);
safeMount(app, '/api/market', marketRoutes);
safeMount(app, '/api', giftCardRoutes);
safeMount(app, '/api/presence', presenceRoutes);
safeMount(app, '/api/banks', bankRoutes);
safeMount(app, '/api/wallet', walletRoutes);
safeMount(app, '/api/wallet/beneficiaries', beneficiaryRoutes);
safeMount(app, '/api/wallet/nowpayments', nowPaymentsRoutes);
safeMount(app, '/api/user', userSettingsRoutes);
safeMount(app, '/api/ticker', tickerRoutes);
// NOTE: koraDepositsRoutes was already mounted ABOVE the global
// express.json() so it gets the raw body. Do NOT mount it here.

app.use('/api/virtual', virtualRoutes);
console.log('  ✅ /api/virtual → loaded');

app.use('/api/esim', esimRoutes);
console.log('  ✅ /api/esim → loaded');

app.use('/api/rates', ratesRoutes);
console.log('  ✅ /api/rates → loaded');

app.use('/api/airtime', airtimeRoutes);
console.log('  ✅ /api/airtime → loaded');

app.use('/api/bills', billsRoutes);
console.log('  ✅ /api/bills → loaded');

app.use('/api/reconciliation', reconciliationRoutes);
console.log('  ✅ /api/reconciliation → loaded');

// ═══════════════════════════════════════════════════════════════════
//  ADMIN API ROUTES
// ═══════════════════════════════════════════════════════════════════

console.log('\n📦 Mounting admin API routes:');

const transactionAdminRoutes = require('./routes/admin/transactionAdminRoutes');
const moneyAdminRoutes       = require('./routes/admin/moneyAdminRoutes');

safeMount(app, '/api/admin', transactionAdminRoutes);
safeMount(app, '/api/admin', moneyAdminRoutes);

const adminDashboardRoutes     = require('./routes/admin/dashboardRoutes');
const adminPresenceRoutes      = require('./routes/admin/presenceAdminRoutes');
const adminIntelligenceRoutes  = require('./routes/admin/intelligenceRoutes');
const adminSettingsRoutes      = require('./routes/admin/adminSettings');
const auditLogRoutes = require('./routes/admin/auditLogRoutes');

safeMount(app, '/api/admin', adminDashboardRoutes);
safeMount(app, '/api/admin/presence', adminPresenceRoutes);
safeMount(app, '/api/admin', adminIntelligenceRoutes);
app.use('/api/admin', adminSettingsRoutes);
console.log('  ✅ /api/admin (settings) → loaded');

// ─── Optional admin routers (loaded only if the file exists) ────
const marketplaceRoutes      = safeRequire('./routes/admin/marketplaceRoutes');

const giftcardAdminRoutes    = safeRequire('./routes/admin/giftcardAdminRoutes');
const adminUserRoutes        = safeRequire('./routes/admin/userRoutes');

app.use('/api/admin/support', require('./routes/admin/supportRoutes'));
app.use('/api/admin', require('./routes/admin/boostAdminRoutes'));
const orderAdminRoutes        = require('./routes/admin/orderRoutes');

app.use('/api/admin', orderAdminRoutes);
app.use('/api/webhooks', require('./routes/webhooks'));

// ─── Admin webhook operations ────────────────────────────────────
app.use('/api/admin', require('./routes/admin/webhookAdminRoutes'));
const messageRoutes          = safeRequire('./routes/messages');
const billsAdminRoutes = require('./routes/admin/billsAdminRoutes');
app.use('/api/admin', billsAdminRoutes);
app.use('/api/admin', require('./routes/admin/revenueAdminRoutes'));
const vsmsAdminRoutes = require('./routes/admin/vsmsAdminRoutes');
app.use('/api/admin', vsmsAdminRoutes);
app.use('/api/admin/notifications', require('./routes/admin/notificationsRoutes'));
const esimAdminRoutes = require('./routes/admin/esimAdminRoutes');
app.use('/api/admin', esimAdminRoutes);
app.use('/api/admin', require('./routes/admin/mfaRoutes'));

const airtimeAdminRoutes = require('./routes/admin/airtimeAdminRoutes');
app.use('/api/admin', airtimeAdminRoutes);
app.use('/api/admin/reports', require('./routes/admin/reportsRoutes'));
app.use('/api/admin', require('./routes/admin/meRoutes'));
app.use('/api/admin', require('./routes/admin/permissionsRoutes'));
app.use('/api/admin', require('./routes/admin/stepUpRoutes'));
console.log('  ✅ /api/admin (me, permissions, step-up) → loaded');

if (marketplaceRoutes)   safeMount(app, '/api/admin', marketplaceRoutes);

if (giftcardAdminRoutes) app.use('/api/admin', giftcardAdminRoutes);
if (adminUserRoutes)     app.use('/api/admin', adminUserRoutes);
if (auditLogRoutes)      app.use('/api/admin', auditLogRoutes);
if (messageRoutes)       app.use('/api/messages', messageRoutes);

console.log('\n✅ All API routes mounted');

// ═══════════════════════════════════════════════════════════════════
//  BACKGROUND RECONCILIATION SCHEDULERS
// ═══════════════════════════════════════════════════════════════════

const reconciliationService = require('./services/reconciliationService');
const { startQuoteReaper } = require('./services/dtoneQuoteReaper');
startQuoteReaper();
console.log('✅ Quote reaper started');

const { startReconciliationScheduler } = require('./services/airtimeReconciliationService');
startReconciliationScheduler();
console.log('✅ Airtime reconciliation scheduler started');

const { startBillsReconciliationScheduler } = require('./services/billsReconciliationService');
startBillsReconciliationScheduler();
console.log('✅ Bills reconciliation scheduler started');

// ─── Full reconciliation sweep: every 5 minutes ─────────────────
setInterval(async () => {
    try {
        console.log('🔄 Running full reconciliation sweep...');
        const result = await reconciliationService.runFullReconciliation();
        if (result) {
            console.log(
                `✅ Reconciliation complete: Cashback: ${result.cashback?.processed || 0}, ` +
                `Airtime: ${result.airtime?.processed || 0}`
            );
        }
    } catch (error) {
        console.error('❌ Reconciliation sweep error:', error);
    }
}, 5 * 60 * 1000);

// ─── Initial sweep, 10s after boot ──────────────────────────────
setTimeout(async () => {
    console.log('🔄 Running initial reconciliation sweep...');
    try {
        const result = await reconciliationService.runFullReconciliation();
        if (result) {
            console.log(
                `✅ Initial reconciliation complete: Cashback: ${result.cashback?.processed || 0}, ` +
                `Airtime: ${result.airtime?.processed || 0}`
            );
        }
    } catch (error) {
        console.error('❌ Initial reconciliation error:', error);
    }
}, 10000);

// ─── Deposit reconciliation: every 5 minutes ────────────────────
// Uses the trusted-verification digest (the same one the webhook
// route builds) so completeKoraDeposit accepts the payload without
// re-verifying with Kora a second time. Every non-completion and
// every failure is logged so silent stalls are visible.
setInterval(async () => {
    try {
        const { data: stuck, error: stuckErr } = await supabaseAdmin
            .from('deposit_requests')
            .select('id, provider_reference, merchant_reference')
            .eq('provider', 'korapay')
            .in('status', ['pending', 'processing'])
            .lt('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
            .limit(50);

        if (stuckErr) {
            console.warn('[RECONCILE] query failed:', stuckErr.message);
            return;
        }

        for (const dep of stuck || []) {
            const ref = dep.provider_reference || dep.merchant_reference;
            if (!ref) {
                console.warn(`[RECONCILE] deposit ${dep.id} has no provider reference — skipping`);
                continue;
            }
            try {
                const verified = await korapayService.verifyTransaction(ref);

                // Build the same trusted payload the webhook route builds.
                const verifiedData = {
                    provider_status: verified.provider_status,
                    amount: verified.amount,
                    currency: verified.currency,
                    reference: verified.reference || verified.payment_reference
                };
                const digest = depositService.computeVerifiedDigest(verifiedData);

                const result = await depositService.completeKoraDeposit({
                    depositId: dep.id,
                    providerTransaction: {
                        ...verifiedData,
                        _trustedVerified: true,
                        _verifiedDigest: digest
                    },
                    source: 'reconciliation'
                });

                if (result.completed) {
                    console.log(`[RECONCILE] deposit ${dep.id} recovered successfully`);
                } else {
                    console.log(`[RECONCILE] deposit ${dep.id} still pending — ${result.reason || 'unknown'}`);
                }
            } catch (e) {
                console.warn(`[RECONCILE] deposit ${dep.id} failed: ${e.message}`);
            }
        }
    } catch (e) {
        console.error('[RECONCILE] outer error:', e.message);
    }
}, 5 * 60 * 1000);

console.log('🔄 Deposit reconciliation service started (runs every 5 minutes)');

// ═══════════════════════════════════════════════════════════════════
//  FALLBACK LOGO
// ═══════════════════════════════════════════════════════════════════

app.get('/images/miles-logo.png', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
        <circle cx="50" cy="50" r="45" fill="#0c3d4a"/>
        <text x="50" y="65" text-anchor="middle" fill="white" font-size="40" font-weight="bold">M</text>
    </svg>`);
});

// ═══════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ═══════════════════════════════════════════════════════════════════
//  FRONTEND PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════

// ─── USER FRONTEND ──────────────────────────────────────────────
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

// ─── ADMIN FRONTEND ─────────────────────────────────────────────
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin/airtime-data', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/airtime-data.html'));
});
app.get('/admin/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html')));
app.get('/admin/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html')));
app.get('/admin/transactions', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'transactions.html')));
app.get('/admin/transactions.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'transactions.html')));
app.get('/admin/deposits', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'deposits.html')));
app.get('/admin/deposits.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'deposits.html')));
app.get('/admin/ledger', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'ledger.html')));
app.get('/admin/ledger.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'ledger.html')));
app.get('/admin/reconciliation', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'reconciliation.html')));
app.get('/admin/reconciliation.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'reconciliation.html')));
app.get('/admin/bills', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/bills.html'));
});

app.get('/admin/webhooks', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/webhooks.html'));
});
app.get('/admin/revenue', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/revenue.html'));
});
app.get('/admin/providers', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/providers.html'));
});
app.get('/admin/users', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'users.html')));
app.get('/admin/users.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'users.html')));
app.get('/admin/support', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'support.html')));
app.get('/admin/messages', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'messages.html')));

app.get('/admin/sellgift', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'sellgift.html')));
app.get('/admin/airtime-data', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'airtime-data.html')));
app.get('/admin/bills', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'bills.html')));
app.get('/admin/esim', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'esim.html')));
app.get('/admin/virtual-sms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'virtual-sms.html')));
app.get('/admin/boost', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'boost.html')));
app.get('/admin/marketplace-products', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'marketplace-products.html')));
app.get('/admin/crypto', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'crypto.html')));

app.get('/admin/orders', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'orders.html')));
app.get('/admin/providers', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'providers.html')));
app.get('/admin/webhooks', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'webhooks.html')));

app.get('/admin/revenue', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'revenue.html')));
app.get('/admin/reports', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'reports.html')));
app.get('/admin/service-performance', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'service-performance.html')));

app.get('/admin/notifications', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'notifications.html')));
app.get('/admin/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'settings.html')));
app.get('/admin/ticker-manager', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'ticker-manager.html')));

// Generic admin fallback.
// Path traversal is now blocked: a request for "/admin/../server.js"
// resolves inside public/admin/ only, never above it.
const ADMIN_PUBLIC_DIR = path.join(__dirname, 'public', 'admin');
app.get(/^\/admin\/(.+)$/, (req, res) => {
    const requestedPath = req.params[0] || '';

    // Reject any traversal attempt outright.
    if (requestedPath.includes('..')) {
        return res.redirect('/admin/dashboard.html');
    }

    if (requestedPath && requestedPath.includes('.')) {
        const fullPath = path.join(ADMIN_PUBLIC_DIR, requestedPath);
        // Confirm the resolved path is still inside public/admin.
        if (fullPath.startsWith(ADMIN_PUBLIC_DIR) && fs.existsSync(fullPath)) {
            return res.sendFile(fullPath);
        }
    }
    res.redirect('/admin/dashboard.html');
});

// ═══════════════════════════════════════════════════════════════════
//  404 HANDLER
// ═══════════════════════════════════════════════════════════════════

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

// ─── ERROR HANDLER ──────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Server error:', err.stack);
    const message = isProduction ? 'Something went wrong' : err.message;
    res.status(err.status || 500).json({
        success: false,
        error: message,
        code: err.code || 'SERVER_ERROR'
    });
});

// ═══════════════════════════════════════════════════════════════════
//  SOCKET.IO SERVER WITH PRESENCE
// ═══════════════════════════════════════════════════════════════════

const server = http.createServer(app);

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

global.io = io;

const JWT_SECRET = process.env.JWT_SECRET;

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

        if (isAdmin) this.totalAdmins = this.admins.size;
        else this.totalUsers = this.users.size;
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

        if (isAdmin) this.totalAdmins = this.admins.size;
        else this.totalUsers = this.users.size;
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
            users,
            admins
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

io.on('connection', (socket) => {
    const userId = socket.userId;
    const userName = socket.userName;
    const userRole = socket.userRole;

    console.log(`🔌 User connected: ${userName} (${userId}) [${userRole}]`);

    presenceManager.addConnection({
        userId,
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
        const { page, action, metadata } = data || {};
        presenceManager.updatePage(userId, page, action);

        io.to('admins').emit('user:activity', {
            userId,
            username: userName,
            role: userRole,
            page,
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
                userId,
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

// ═══════════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔌 Socket.IO enabled with real-time presence`);

    console.log(`\n📄 Frontend URLs:`);
    console.log(`   → Landing Page:    http://localhost:${PORT}/`);
    console.log(`   → Signup/Login:    http://localhost:${PORT}/signup`);
    console.log(`   → User Dashboard:  http://localhost:${PORT}/dashboard`);
    console.log(`   → Airtime:         http://localhost:${PORT}/airtime`);

    console.log(`\n🔗 API Base: http://localhost:${PORT}/api`);

    console.log(`\n🔐 Admin Pages:`);
    console.log(`   → Login:            http://localhost:${PORT}/admin/index.html`);
    console.log(`   → Dashboard:        http://localhost:${PORT}/admin/dashboard.html`);
    console.log(`   → Transactions:     http://localhost:${PORT}/admin/transactions`);
    console.log(`   → Deposits:         http://localhost:${PORT}/admin/deposits`);
    console.log(`   → Ledger:           http://localhost:${PORT}/admin/ledger`);
    console.log(`   → Reconciliation:   http://localhost:${PORT}/admin/reconciliation`);
    console.log(`   → Users:            http://localhost:${PORT}/admin/users`);
    console.log(`   → Settings:         http://localhost:${PORT}/admin/settings`);

    console.log(`\n🔐 Admin API endpoints:`);
    console.log(`   → POST   /api/admin/login`);
    console.log(`   → GET    /api/admin/session`);
    console.log(`   → GET    /api/admin/me`);
    console.log(`   → POST   /api/admin/logout`);
    console.log(`   → POST   /api/admin/refresh`);
    console.log(`   → GET    /api/admin/verify`);
    console.log(`   → GET    /api/admin/stats`);
    console.log(`   → GET    /api/admin/charts`);
    console.log(`   → GET    /api/admin/health`);
    console.log(`   → GET    /api/admin/recent-activity`);
    console.log(`   → GET    /api/admin/users/recent`);
    console.log(`   → GET    /api/admin/transactions`);
    console.log(`   → GET    /api/admin/transactions/summary`);
    console.log(`   → GET    /api/admin/transactions/export`);
    console.log(`   → GET    /api/admin/transactions/:id`);
    console.log(`   → GET    /api/admin/transactions/:id/ledger`);
    console.log(`   → GET    /api/admin/transactions/:id/audit`);
    console.log(`   → PUT    /api/admin/transactions/:id/status`);
    console.log(`   → POST   /api/admin/transactions/:id/refund`);
    console.log(`   → POST   /api/admin/transactions/:id/note`);
    console.log(`   → GET    /api/admin/transactions/recent`);
    console.log(`   → GET    /api/admin/deposits/recent`);
    console.log(`   → GET    /api/admin/deposits/today-summary`);
    console.log(`   → GET    /api/admin/ledger`);
    console.log(`   → GET    /api/admin/ledger/balances`);
    console.log(`   → GET    /api/admin/logins/today`);
    console.log(`   → GET    /api/admin/webhooks/recent`);
    console.log(`   → GET    /api/admin/providers/health`);
    console.log(`   → GET    /api/admin/needs-attention`);
    console.log(`   → GET    /api/admin/orders/failed/recent`);
    console.log(`   → GET    /api/admin/reconciliation/exceptions/count`);

    console.log(`\n🔐 Airtime API endpoints:`);
    console.log(`   → GET    /api/airtime/countries`);
    console.log(`   → GET    /api/airtime/operators`);
    console.log(`   → POST   /api/airtime/purchase`);
    console.log(`   → GET    /api/airtime/history`);

    console.log(`\n🔐 Reconciliation API endpoints:`);
    console.log(`   → GET    /api/reconciliation/airtime/pending`);
    console.log(`   → POST   /api/reconciliation/airtime/sweep`);
    console.log(`   → GET    /api/reconciliation/airtime/stats`);

    console.log('');
});

module.exports = { server, io, presenceManager };