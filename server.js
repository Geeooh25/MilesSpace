const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

require('dotenv').config();

// ============ CORS CONFIGURATION ============
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ============ IMPORT ROUTES ============
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/marketRoutes');
const boostRoutes = require('./routes/boostRoutes');
const adminRoutes = require('./routes/adminRoutes');
const smsRoutes = require('./routes/smsRoutes');
const walletRoutes = require('./routes/walletRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const profileRoutes = require('./routes/profileRoutes');
const marketRoutes = require('./routes/marketRoutes');
const virtualsmsRoutes = require('./routes/virtual-router');
const ratesRoutes = require('./routes/ratesRoutes');
const giftRoutes = require('./routes/giftRoutes');
const socialAdsRoutes = require('./routes/socialAds');

// ============ API ROUTES ============
app.use('/api/auth', authRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/boost', boostRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/products', productRoutes);
app.use('/api/virtual', virtualsmsRoutes);
app.use('/api/rates', ratesRoutes);
app.use('/api/gifts', giftRoutes);
app.use('/api/ads', socialAdsRoutes); // ← MOVED TO /api/ads

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ FRONTEND ROUTES ============
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/market', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'market.html'));
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.get('/fund', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fund.html'));
});

app.get('/boost', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'boost.html'));
});

app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/notifications', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'notifications.html'));
});

app.get('/virtual', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'virtual.html'));
});

app.get('/giftcards', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'giftcards.html'));
});

app.get('/login', (req, res) => {
  res.redirect('/signup');
});

// ============ 404 HANDLER ============
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: `API endpoint ${req.method} ${req.path} not found` });
  }
  if (!req.path.includes('.')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.status(404).send('File not found');
});

// ============ GLOBAL ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({ error: err.message || 'Something went wrong!' });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`\n📄 Frontend URLs:`);
  console.log(`   → Landing Page: http://localhost:${PORT}/`);
  console.log(`   → Signup/Login: http://localhost:${PORT}/signup`);
  console.log(`   → Dashboard:    http://localhost:${PORT}/dashboard`);
  console.log(`\n🔗 API Base: http://localhost:${PORT}/api`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health\n`);
});

module.exports = app;