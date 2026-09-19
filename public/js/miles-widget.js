/*!
 * Miles Support — MilesSpace Human Support Widget (v14)
 * ------------------------------------------------------
 * v14 FIXES (corrected from v13):
 *  - Widget DOES boot on auth pages (login/signup/verify/forgot/reset)
 *    so guests can contact support before signing in.
 *  - On auth pages, or whenever there is no valid, non-expired session,
 *    the widget renders the GUEST view and makes NO authenticated calls.
 *  - Token-expiry is checked before declaring the session "authenticated".
 *  - Session snapshot is read from session.js first, mx_sess as fallback.
 *  - Authenticated requests are routed through window.userFetch() when
 *    available so single-flight refresh + retry + return-to are handled
 *    by session.js (the single auth authority).
 *  - Cross-tab logout is detected via the storage event.
 *  - No 401 storms on the login page, no SESSION_EXPIRED log spam.
 *
 * All backend contracts unchanged. No API changes. UI unchanged.
 */

(function () {
    'use strict';

    if (window.__MILES_WIDGET_BOOTED__) return;
    window.__MILES_WIDGET_BOOTED__ = true;

    // ─── PAGE DETECTION ──────────────────────────────────────────────
    const _pathname = window.location.pathname;
    const IS_ADMIN_PAGE =
        _pathname === '/admin' ||
        _pathname === '/admin/' ||
        _pathname.startsWith('/admin/');

    // Admin pages have their own presence and support UI.
    if (IS_ADMIN_PAGE) {
        console.log('[MilesWidget] Admin page — skipped');
        window.MilesWidget = null;
        return;
    }

    // Auth pages: widget boots, but ONLY ever shows the guest form.
    // It will NOT attempt any authenticated API calls from here.
    const AUTH_PAGES = new Set([
        '/login.html', '/login',
        '/signup.html', '/signup',
        '/register.html', '/register',
        '/forgot-password.html', '/forgot-password',
        '/reset-password.html', '/reset-password',
        '/verify.html', '/verify'
    ]);
    const IS_AUTH_PAGE = AUTH_PAGES.has(_pathname);

    // ─── CONFIG ───
    const CONFIG = {
        API_URL: '/api/support',
        MOBILE_BREAKPOINT: 520,
        POLL_INTERVAL: 15000,
        GLOBAL_POLL_INTERVAL: 30000,
        MAX_MESSAGE_LENGTH: 5000,
        MAX_SUBJECT_LENGTH: 150,
        MAX_FILE_SIZE: 10 * 1024 * 1024,
        MAX_FILES_PER_MESSAGE: 5,
        ALLOWED_FILE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv'],
        STORAGE_PREFIX: 'miles_widget_',
        DESKTOP_BOTTOM: 24,
        DESKTOP_RIGHT: 24,
        MOBILE_BOTTOM: 16,
        MOBILE_RIGHT: 16,
    };

    // ─── SVG ICONS ───
    const ICONS = {
        wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="14" r="1.1" fill="currentColor" stroke="none"/></svg>',
        deposit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/></svg>',
        withdrawal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M4 4h16"/></svg>',
        giftcard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 12h18"/><path d="M12 8v12"/><path d="M8.5 8a2 2 0 110-4c1.5 0 3.5 2 3.5 4z"/><path d="M15.5 8a2 2 0 100-4c-1.5 0-3.5 2-3.5 4z"/></svg>',
        crypto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.5 8.5h3.2a1.8 1.8 0 010 3.6H9.5m0-3.6v7.2m0-3.6h3.6a1.8 1.8 0 010 3.6H9.5m2-9v1.2m0 8.6V17"/></svg>',
        marketplace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7l1.5-3h15L21 7"/><rect x="4" y="7" width="16" height="13" rx="1"/><path d="M9 11a3 3 0 006 0"/></svg>',
        virtual: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
        boost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19l6-6 4 4 6-8"/><path d="M15 8h5v5"/></svg>',
        account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c1.5-4 4.2-6 7.5-6s6 2 7.5 6"/></svg>',
        other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
        support: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 13a8 8 0 0116 0"/><rect x="2" y="13" width="5" height="6" rx="1.5"/><rect x="17" y="13" width="5" height="6" rx="1.5"/><path d="M20 19a4 4 0 01-4 4h-2"/></svg>',
        chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a8 8 0 01-11.6 7.2L4 20l1.1-4.3A8 8 0 1121 12z"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>',
        send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
        bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 8a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 21a2 2 0 004 0"/></svg>',
        bellOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l18 18"/><path d="M6 8a6 6 0 0110.9-3.4M18 14c0-1 .2-2 0-3"/><path d="M4 14s2-1 2-6"/><path d="M10 21a2 2 0 004 0"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.6" fill="currentColor"/></svg>',
        image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5-5 5-4-4-4 4"/></svg>',
        pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/><path d="M8 12h8"/><path d="M8 16h6"/></svg>',
        file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/></svg>',
        remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>',
        back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 19l-7-7 7-7"/></svg>',
        article: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/><path d="M8 8h8"/><path d="M8 12h6"/><path d="M8 16h4"/></svg>',
        plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
        star: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01z"/></svg>',
        starOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01z"/></svg>'
    };

    function icon(name, cls) {
        return `<span class="miles-icon ${cls || ''}" aria-hidden="true">${ICONS[name] || ICONS.other}</span>`;
    }

    const CATEGORIES = [
        { key: 'wallet', label: 'Wallet' },
        { key: 'deposit', label: 'Funding' },
        { key: 'withdrawal', label: 'Withdrawal' },
        { key: 'giftcard', label: 'Gift Cards' },
        { key: 'crypto', label: 'Crypto' },
        { key: 'marketplace', label: 'Marketplace' },
        { key: 'boost', label: 'Social Boosting' },
        { key: 'virtual', label: 'Virtual Numbers' },
        { key: 'account', label: 'Account & Security' },
        { key: 'other', label: 'Other' }
    ];

    const STATUS_LABELS = {
        open: 'Open',
        assigned: 'Assigned',
        in_progress: 'In Progress',
        waiting_user: 'Waiting on you',
        waiting_support: 'Waiting on support',
        resolved: 'Resolved',
        closed: 'Closed'
    };

    const STATUS = {
        CONNECTING: 'Connecting…',
        AVAILABLE: 'Support available',
        AWAY: 'Support away',
        WAITING: 'Waiting for support',
        AGENT_ONLINE: 'Agent online',
        OFFLINE: 'You appear to be offline',
        SENDING: 'Sending…',
        SENT: 'Message sent',
        FAILED: 'Message failed to send'
    };

    const HELP_ARTICLES = [
        {
            id: 'fund-wallet', title: 'How do I fund my wallet?', category: 'Wallet', categoryKey: 'wallet',
            summary: 'Add money to your MilesSpace wallet via bank transfer, card, or crypto.',
            content: `<p>You can fund your MilesSpace wallet using any of the following methods:</p>
                <ol><li><strong>Bank Transfer:</strong> Use the provided account details to transfer funds</li>
                <li><strong>Card Payment:</strong> Pay securely with your debit/credit card</li>
                <li><strong>Paystack:</strong> Use Paystack for instant funding</li>
                <li><strong>NowPayments:</strong> Fund with crypto via NowPayments</li></ol>
                <p>Funds typically appear in your wallet within 5-15 minutes.</p>`,
            readTime: '3 min read', updatedAt: '2026-08-20'
        },
        {
            id: 'buy-crypto', title: 'How do I buy crypto?', category: 'Crypto', categoryKey: 'crypto',
            summary: 'Buy Bitcoin, USDT, ETH, and other cryptocurrencies.',
            content: `<p>Buying crypto on MilesSpace is simple:</p>
                <ol><li>Go to the <strong>Crypto</strong> section</li>
                <li>Select the coin you want to buy (BTC, USDT, ETH)</li>
                <li>Enter the amount you want to spend in NGN or USD</li>
                <li>Confirm the transaction and complete payment</li></ol>
                <p>Your crypto will be delivered to your wallet within minutes.</p>`,
            readTime: '2 min read', updatedAt: '2026-08-18'
        },
        {
            id: 'gift-cards', title: 'How do I buy gift cards?', category: 'Gift Cards', categoryKey: 'giftcard',
            summary: 'Purchase and receive gift cards from popular retailers.',
            content: `<p>Buying gift cards on MilesSpace is easy:</p>
                <ol><li>Go to the <strong>Gift Cards</strong> section</li>
                <li>Select the card type (Amazon, iTunes, Google Play, etc.)</li>
                <li>Choose the card value</li>
                <li>Complete payment using your wallet balance</li></ol>
                <p>Gift cards are usually delivered instantly.</p>`,
            readTime: '2 min read', updatedAt: '2026-08-15'
        },
        {
            id: 'withdraw-funds', title: 'How do I withdraw funds?', category: 'Withdrawals', categoryKey: 'withdrawal',
            summary: 'Withdraw funds from your MilesSpace wallet to your bank account.',
            content: `<p>Withdrawing funds from MilesSpace is straightforward:</p>
                <ol><li>Go to the <strong>Withdraw</strong> section</li>
                <li>Select your withdrawal method (Bank, Crypto)</li>
                <li>Enter the amount you want to withdraw</li>
                <li>Confirm the transaction with your PIN</li></ol>
                <p>Bank withdrawals typically take 1-3 business days to process.</p>`,
            readTime: '2 min read', updatedAt: '2026-08-10'
        },
        {
            id: 'virtual-numbers', title: 'What is a virtual number?', category: 'Virtual Numbers', categoryKey: 'virtual',
            summary: 'Temporary phone numbers for OTP verification.',
            content: `<p>Virtual numbers are temporary phone numbers that can receive SMS messages.</p>
                <p>They are useful for:</p>
                <ul><li>Account verification</li><li>OTP codes</li><li>Privacy protection</li><li>Testing services</li></ul>
                <p>Numbers are available from 120+ countries.</p>`,
            readTime: '3 min read', updatedAt: '2026-08-08'
        },
        {
            id: 'social-boosting', title: 'How does social boosting work?', category: 'Boost', categoryKey: 'boost',
            summary: 'Increase your social media engagement.',
            content: `<p>Social boosting helps increase your social media engagement:</p>
                <ul><li>Choose the platform (Instagram, TikTok, YouTube)</li>
                <li>Select the service type (followers, likes, views)</li>
                <li>Enter your profile link</li><li>Complete payment</li></ul>
                <p>Boosts start within minutes of order confirmation.</p>`,
            readTime: '3 min read', updatedAt: '2026-08-05'
        },
        {
            id: 'secure-account', title: 'How do I secure my account?', category: 'Account', categoryKey: 'account',
            summary: 'Protect your account with 2FA and other security features.',
            content: `<p>Keep your MilesSpace account secure:</p>
                <ol><li>Enable <strong>2FA</strong> (Two-Factor Authentication)</li>
                <li>Use a <strong>strong password</strong> and change it regularly</li>
                <li>Set a <strong>transaction PIN</strong> for financial actions</li>
                <li>Never share your credentials with anyone</li>
                <li>Be cautious of phishing attempts</li></ol>
                <p>Visit your Settings page to enable these security features.</p>`,
            readTime: '4 min read', updatedAt: '2026-08-01'
        }
    ];

    // ─── STYLES (unchanged) ───
    const styles = `
        #miles-widget-root {
            --miles-primary: #0c3d4a;
            --miles-primary-light: #12556a;
            --miles-primary-dark: #082a33;
            --miles-accent: #f59e0b;
            --miles-bg: #f4f7fb;
            --miles-white: #ffffff;
            --miles-text: #0c1f26;
            --miles-text-dim: #5b7480;
            --miles-text-faint: #8fa3ab;
            --miles-border: rgba(12,61,74,0.10);
            --miles-success: #16a34a;
            --miles-danger: #dc2626;
            --miles-shadow: 0 12px 40px rgba(8,42,51,0.18);
            --miles-radius: 18px;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            position: fixed; inset: auto 0 0 0; width: 0; height: 0;
            z-index: 2147483000; pointer-events: none;
        }
        #miles-widget-root, #miles-widget-root * { box-sizing: border-box; }
        #miles-widget-root .miles-icon { display: inline-flex; width: 18px; height: 18px; flex-shrink: 0; }
        #miles-widget-root .miles-icon svg { width: 100%; height: 100%; }

        #miles-launcher {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 58px;
            height: 58px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--miles-primary), var(--miles-primary-light));
            color: #fff;
            border: none;
            cursor: grab;
            box-shadow: 0 4px 20px rgba(12,61,74,0.35);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2147483001;
            padding: 0;
            touch-action: none;
            user-select: none;
            transition: transform 0.2s, box-shadow 0.2s;
            pointer-events: auto;
            will-change: transform;
        }
        #miles-launcher .miles-icon { width: 26px; height: 26px; }
        #miles-launcher.dragging { transition: none !important; box-shadow: 0 8px 40px rgba(12,61,74,0.6); transform: scale(1.08); cursor: grabbing; }
        #miles-launcher:hover { transform: scale(1.05); }
        #miles-launcher:focus-visible { outline: 3px solid var(--miles-accent); outline-offset: 3px; }
        #miles-launcher .badge {
            position: absolute;
            top: -4px;
            right: -4px;
            background: var(--miles-danger);
            color: #fff;
            font-size: 11px;
            font-weight: 700;
            min-width: 20px;
            height: 20px;
            border-radius: 99px;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 0 5px;
            border: 2px solid #fff;
        }
        #miles-launcher .badge.show { display: flex; }

        #miles-panel {
            position: fixed;
            bottom: 96px;
            right: 24px;
            width: 440px;
            height: 640px;
            max-height: calc(100vh - 130px);
            background: var(--miles-white);
            border-radius: var(--miles-radius);
            box-shadow: var(--miles-shadow);
            display: none;
            flex-direction: column;
            overflow: hidden;
            border: 1px solid var(--miles-border);
            pointer-events: auto;
            z-index: 2147483001;
        }
        #miles-panel.open { display: flex; animation: milesSlideUp 0.22s cubic-bezier(0.4,0,0.2,1); }
        @keyframes milesSlideUp { from { opacity: 0; transform: translateY(16px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

        @media (max-width: 520px) {
            #miles-launcher { bottom: 16px; right: 16px; width: 54px; height: 54px; }
            #miles-panel {
                inset: 0;
                width: 100% !important;
                height: 100% !important;
                max-height: 100vh !important;
                border-radius: 0 !important;
                bottom: 0 !important;
                right: 0 !important;
            }
            .miles-tabs .tab span { display: none; }
            .miles-input-area textarea { font-size: 16px !important; }
            .miles-modal-box { width: 100% !important; height: 100% !important; max-height: 100vh !important; border-radius: 0 !important; }
        }

        .miles-header { padding: 14px 18px; background: linear-gradient(135deg, var(--miles-primary), var(--miles-primary-light)); color: #fff; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; }
        .miles-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .miles-header-left .info h3 { font-size: 15px; font-weight: 700; margin: 0; }
        .miles-header-left .info .status { font-size: 11.5px; opacity: 0.85; display: flex; align-items: center; gap: 6px; }
        .miles-header-left .info .status .dot { width: 6px; height: 6px; border-radius: 50%; background: #22c55e; }
        .miles-header-left .info .status .dot.offline { background: #94a3b8; }
        .miles-header-left .info .status .dot.waiting { background: var(--miles-accent); }
        .miles-header-actions { display: flex; gap: 4px; }
        .miles-header-actions button { width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,0.12); border: none; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .miles-header-actions button:hover { background: rgba(255,255,255,0.22); }
        .miles-header-actions button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .miles-header-actions .miles-icon { width: 16px; height: 16px; }

        .miles-tabs { display: flex; border-bottom: 1px solid var(--miles-border); background: var(--miles-bg); flex-shrink: 0; padding: 0 8px; }
        .miles-tabs .tab { flex: 1; padding: 10px 8px; font-size: 12.5px; font-weight: 600; color: var(--miles-text-dim); cursor: pointer; border-bottom: 2px solid transparent; background: none; border-top: none; border-left: none; border-right: none; font-family: inherit; display: flex; align-items: center; justify-content: center; gap: 6px; position: relative; }
        .miles-tabs .tab.active { color: var(--miles-primary); border-bottom-color: var(--miles-primary); }
        .miles-tabs .tab:focus-visible { outline: 2px solid var(--miles-primary); outline-offset: -2px; }
        .miles-tabs .tab .tab-badge { background: var(--miles-danger); color: #fff; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 99px; display: none; }
        .miles-tabs .tab .tab-badge.show { display: inline-block; }

        .miles-content { flex: 1; overflow: hidden; position: relative; background: var(--miles-bg); }
        .miles-tab-content { display: none; height: 100%; overflow-y: auto; padding: 16px; -webkit-overflow-scrolling: touch; }
        .miles-tab-content.active { display: block; }

        .miles-welcome { padding: 4px 0 12px; }
        .miles-welcome .greeting { font-size: 18px; font-weight: 700; color: var(--miles-text); }
        .miles-welcome .sub { font-size: 13px; color: var(--miles-text-dim); margin-top: 2px; }

        .miles-suggestions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; }
        .miles-suggestion { padding: 12px 10px; background: var(--miles-white); border: 1px solid var(--miles-border); border-radius: 12px; cursor: pointer; text-align: left; font-size: 12.5px; font-weight: 600; color: var(--miles-text); display: flex; align-items: center; gap: 8px; font-family: inherit; }
        .miles-suggestion:hover { border-color: var(--miles-primary); background: #f0f7fa; }
        .miles-suggestion:focus-visible { outline: 2px solid var(--miles-primary); outline-offset: 1px; }
        .miles-suggestion .miles-icon { color: var(--miles-primary); flex-shrink: 0; }

        .miles-contact-btn { width: 100%; margin-top: 14px; padding: 12px; border-radius: 12px; background: var(--miles-primary); color: #fff; border: none; font-weight: 700; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; }
        .miles-contact-btn:hover { background: var(--miles-primary-light); }

        #miles-widget-root #tab-chats { position: relative; overflow: hidden; padding: 0 !important; }
        #miles-widget-root #tab-chats > .miles-conv-list,
        #miles-widget-root #tab-chats > .miles-message-view { position: absolute; inset: 0; width: 100%; height: 100%; }
        #miles-widget-root #tab-chats > .miles-conv-list { display: flex; flex-direction: column; background: var(--miles-white); z-index: 1; }
        #miles-widget-root #tab-chats > .miles-message-view { display: none; flex-direction: column; background: var(--miles-bg); z-index: 2; }
        #miles-widget-root #tab-chats > .miles-message-view.open { display: flex; }

        .miles-conv-list .conv-header { padding: 10px 14px; border-bottom: 1px solid var(--miles-border); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; background: var(--miles-bg); gap: 8px; }
        .miles-conv-list .conv-header h4 { font-size: 13px; font-weight: 700; color: var(--miles-text); }
        .miles-conv-list .conv-header .conv-count { font-size: 11px; color: var(--miles-text-dim); }
        .miles-conv-list .conv-header .new-ticket-btn { display: flex; align-items: center; gap: 4px; padding: 5px 10px; background: var(--miles-primary); color: #fff; border: none; border-radius: 7px; font-size: 11.5px; font-weight: 700; cursor: pointer; font-family: inherit; }
        .miles-conv-list .conv-header .new-ticket-btn:hover { background: var(--miles-primary-light); }
        .miles-conv-list .conv-header .new-ticket-btn .miles-icon { width: 13px; height: 13px; }

        .miles-conv-list .conv-search { padding: 6px 12px; border-bottom: 1px solid var(--miles-border); flex-shrink: 0; }
        .miles-conv-list .conv-search input { width: 100%; padding: 6px 10px 6px 32px; border: 1px solid var(--miles-border); border-radius: 8px; font-size: 12px; outline: none; background: var(--miles-bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%238fa3ab' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='M21 21l-4.3-4.3'/%3E%3C/svg%3E") no-repeat 10px center; font-family: inherit; }
        .miles-conv-list .conv-search input:focus { border-color: var(--miles-primary); }

        .miles-conv-items { flex: 1; overflow-y: auto; padding: 4px 0; }

        .miles-conv-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; cursor: pointer; transition: background 0.15s; width: 100%; border: 0; border-left: 3px solid transparent; background: transparent; color: inherit; font-family: inherit; text-align: left; }
        .miles-conv-item:hover { background: var(--miles-bg); }
        .miles-conv-item:focus-visible { outline: 2px solid var(--miles-primary); outline-offset: -2px; }
        .miles-conv-item.active { background: #fdf3e0; border-left-color: var(--miles-primary); }
        .miles-conv-item.has-unread .subject { font-weight: 800; }
        .miles-conv-item .avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--miles-primary); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; flex-shrink: 0; }
        .miles-conv-item .info { flex: 1; min-width: 0; }
        .miles-conv-item .info .top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
        .miles-conv-item .info .subject { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .miles-conv-item .info .preview { font-size: 11.5px; color: var(--miles-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
        .miles-conv-item .info .meta { font-size: 10px; color: var(--miles-text-faint); margin-top: 3px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .miles-conv-item .info .meta .ticket-no { font-variant-numeric: tabular-nums; }
        .miles-conv-item .status-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
        .miles-conv-item .status-dot.open, .miles-conv-item .status-dot.assigned, .miles-conv-item .status-dot.in_progress,
        .miles-conv-item .status-dot.waiting_support { background: var(--miles-success); }
        .miles-conv-item .status-dot.waiting_user { background: var(--miles-accent); }
        .miles-conv-item .status-dot.resolved { background: var(--miles-text-faint); }
        .miles-conv-item .status-dot.closed { background: #94a3b8; }
        .miles-conv-item .unread-badge { background: var(--miles-danger); color: #fff; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 99px; min-width: 18px; text-align: center; flex-shrink: 0; }
        .miles-conv-item .time-ago { font-size: 10px; color: var(--miles-text-faint); white-space: nowrap; flex-shrink: 0; }

        .miles-conv-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; color: var(--miles-text-faint); text-align: center; height: 100%; }
        .miles-conv-empty .miles-icon { width: 40px; height: 40px; opacity: 0.35; margin-bottom: 12px; }
        .miles-conv-empty h4 { font-size: 15px; font-weight: 700; color: var(--miles-text); margin-bottom: 4px; }
        .miles-conv-empty p { font-size: 12.5px; margin: 0; }
        .miles-conv-empty .btn-primary { margin-top: 12px; padding: 8px 20px; background: var(--miles-primary); color: #fff; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 13px; font-family: inherit; }
        .miles-conv-empty .btn-primary:hover { background: var(--miles-primary-light); }

        .miles-msg-header { padding: 10px 14px; border-bottom: 1px solid var(--miles-border); background: var(--miles-white); display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .miles-msg-header .back-btn { background: none; border: none; cursor: pointer; font-size: 16px; color: var(--miles-primary); padding: 4px; display: flex; align-items: center; justify-content: center; }
        .miles-msg-header .back-btn:hover { color: var(--miles-primary-light); }
        .miles-msg-header .info { flex: 1; min-width: 0; }
        .miles-msg-header .info .subject { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .miles-msg-header .info .status { font-size: 11px; color: var(--miles-text-dim); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .miles-msg-header .info .status .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 4px; }
        .miles-msg-header .info .status .dot.open, .miles-msg-header .info .status .dot.assigned,
        .miles-msg-header .info .status .dot.in_progress, .miles-msg-header .info .status .dot.waiting_support { background: var(--miles-success); }
        .miles-msg-header .info .status .dot.waiting_user { background: var(--miles-accent); }
        .miles-msg-header .info .status .dot.resolved { background: var(--miles-text-faint); }
        .miles-msg-header .info .status .dot.closed { background: #94a3b8; }
        .miles-msg-header-actions { display: flex; gap: 4px; flex-shrink: 0; }
        .miles-msg-header-actions button { padding: 5px 9px; border-radius: 7px; border: 1px solid var(--miles-border); background: var(--miles-white); color: var(--miles-text-dim); font-size: 11px; font-weight: 700; cursor: pointer; font-family: inherit; }
        .miles-msg-header-actions button:hover { border-color: var(--miles-primary); color: var(--miles-primary); }

        .miles-message-list { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
        .miles-msg { max-width: 85%; padding: 10px 13px; border-radius: 12px; word-wrap: break-word; line-height: 1.5; font-size: 13px; animation: fadeIn 0.25s ease; }
        .miles-msg.user { align-self: flex-end; background: var(--miles-primary); color: #fff; border-bottom-right-radius: 4px; }
        .miles-msg.support { align-self: flex-start; background: var(--miles-white); color: var(--miles-text); border: 1px solid var(--miles-border); border-bottom-left-radius: 4px; }
        .miles-msg.system { align-self: center; background: #eef2f5; color: var(--miles-text-dim); font-size: 11.5px; max-width: 92%; border-radius: 20px; padding: 4px 16px; }
        .miles-msg .time { font-size: 10px; opacity: 0.65; margin-top: 4px; text-align: right; }
        .miles-msg.failed { border: 1px solid var(--miles-danger); }
        .miles-msg .retry-btn { display: inline-block; margin-top: 6px; font-size: 11px; font-weight: 700; color: var(--miles-danger); background: none; border: none; cursor: pointer; padding: 0; font-family: inherit; text-decoration: underline; }

        .miles-date-sep { align-self: center; font-size: 10.5px; color: var(--miles-text-faint); padding: 2px 10px; margin: 4px 0; }

        .miles-attachment { margin-top: 6px; border: 1px solid var(--miles-border); border-radius: 8px; overflow: hidden; max-width: 240px; background: var(--miles-bg); cursor: pointer; }
        .miles-attachment img { display: block; max-width: 100%; max-height: 180px; object-fit: cover; width: 100%; }
        .miles-attachment .attachment-info { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 11px; color: var(--miles-text-dim); background: var(--miles-white); }
        .miles-attachment .attachment-info .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .miles-attachment .attachment-info .size { font-size: 10px; color: var(--miles-text-faint); flex-shrink: 0; }
        .miles-msg.user .miles-attachment { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.2); }
        .miles-msg.user .miles-attachment .attachment-info { background: transparent; color: rgba(255,255,255,0.85); }

        .miles-lightbox { position: fixed; inset: 0; background: rgba(8,20,25,0.92); z-index: 2147483005; display: none; align-items: center; justify-content: center; padding: 24px; pointer-events: auto; }
        .miles-lightbox.open { display: flex; }
        .miles-lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; object-fit: contain; }
        .miles-lightbox .lb-close { position: absolute; top: 16px; right: 16px; width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.15); border: none; color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; }
        .miles-lightbox .lb-open-original { position: absolute; bottom: 16px; right: 16px; padding: 8px 14px; border-radius: 8px; background: rgba(255,255,255,0.15); color: #fff; font-size: 12px; font-weight: 700; text-decoration: none; }

        .miles-file-preview { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0 6px 0; }
        .miles-file-preview:empty { display: none; }
        .miles-file-preview .file-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px 5px 6px; background: var(--miles-bg); border: 1px solid var(--miles-border); border-radius: 6px; font-size: 11px; }
        .miles-file-preview .file-item.image-item { padding: 0; overflow: hidden; }
        .miles-file-preview .file-item.image-item img { width: 44px; height: 44px; object-fit: cover; display: block; }
        .miles-file-preview .file-item .file-name { max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .miles-file-preview .file-item .file-size { font-size: 9px; color: var(--miles-text-faint); }
        .miles-file-preview .file-item .remove-file { cursor: pointer; color: var(--miles-danger); background: none; border: none; padding: 4px; font-size: 13px; line-height: 1; font-weight: 700; min-width: 22px; min-height: 22px; }

        .miles-input-area { padding: 10px 14px; border-top: 1px solid var(--miles-border); background: var(--miles-white); display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
        .miles-input-row { display: flex; gap: 8px; align-items: flex-end; }
        .miles-input-area textarea { flex: 1; padding: 8px 12px; border: 1px solid var(--miles-border); border-radius: 10px; resize: none; font-family: inherit; font-size: 13px; outline: none; min-height: 40px; max-height: 100px; background: var(--miles-bg); }
        .miles-input-area textarea:focus { border-color: var(--miles-primary); background: var(--miles-white); }
        .miles-input-area textarea:disabled { opacity: 0.6; }
        .miles-input-area .send-btn { width: 38px; height: 38px; border-radius: 50%; background: var(--miles-primary); color: #fff; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .miles-input-area .send-btn:hover:not(:disabled) { background: var(--miles-primary-light); }
        .miles-input-area .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .miles-input-area .attach-btn { width: 38px; height: 38px; border-radius: 50%; border: 1px solid var(--miles-border); background: var(--miles-bg); cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--miles-text-dim); position: relative; flex-shrink: 0; }
        .miles-input-area .attach-btn:hover { background: var(--miles-white); border-color: var(--miles-primary); color: var(--miles-primary); }
        .miles-input-area .attach-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .miles-input-area .attach-btn input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
        .miles-send-status { font-size: 10.5px; color: var(--miles-text-faint); padding: 0 2px; min-height: 14px; }
        .miles-send-status.error { color: var(--miles-danger); }
        .miles-char-count { font-size: 10px; color: var(--miles-text-faint); text-align: right; }
        .miles-ticket-closed-note { padding: 10px 14px; font-size: 12px; color: var(--miles-text-dim); background: var(--miles-bg); border-top: 1px solid var(--miles-border); text-align: center; flex-shrink: 0; }
        .miles-ticket-closed-note button { margin-left: 6px; color: var(--miles-primary); font-weight: 700; background: none; border: none; cursor: pointer; font-family: inherit; text-decoration: underline; padding: 0; }

        .miles-typing { display: none; align-items: center; gap: 6px; padding: 6px 13px; background: var(--miles-white); border: 1px solid var(--miles-border); border-radius: 12px; align-self: flex-start; font-size: 12px; color: var(--miles-text-dim); }
        .miles-typing.active { display: flex; }
        .miles-typing .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--miles-text-dim); animation: milesTypingDot 1.4s infinite; }
        .miles-typing .dot:nth-child(2) { animation-delay: 0.2s; }
        .miles-typing .dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes milesTypingDot { 0%,60%,100% { transform: translateY(0); opacity: 0.3; } 30% { transform: translateY(-5px); opacity: 1; } }

        .miles-msg-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; color: var(--miles-text-faint); text-align: center; padding: 20px; }
        .miles-msg-empty .miles-icon { width: 40px; height: 40px; opacity: 0.35; margin-bottom: 12px; }

        .miles-rating-box { margin: 10px 14px; padding: 14px; background: var(--miles-white); border: 1px solid var(--miles-border); border-radius: 12px; text-align: center; }
        .miles-rating-box h5 { font-size: 13px; font-weight: 700; color: var(--miles-text); margin-bottom: 8px; }
        .miles-rating-stars { display: flex; justify-content: center; gap: 4px; margin-bottom: 10px; }
        .miles-rating-stars button { background: none; border: none; cursor: pointer; color: var(--miles-text-faint); padding: 2px; }
        .miles-rating-stars button .miles-icon { width: 24px; height: 24px; }
        .miles-rating-stars button.active { color: var(--miles-accent); }
        .miles-rating-box textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--miles-border); border-radius: 8px; font-size: 12px; font-family: inherit; resize: vertical; min-height: 50px; margin-bottom: 8px; }
        .miles-rating-box .submit-rating { padding: 8px 18px; background: var(--miles-primary); color: #fff; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; font-size: 12.5px; }
        .miles-rating-box .submit-rating:disabled { opacity: 0.5; cursor: not-allowed; }
        .miles-rating-done { font-size: 12px; color: var(--miles-success); font-weight: 600; }

        .miles-help-search { margin-bottom: 14px; position: relative; }
        .miles-help-search input { width: 100%; padding: 9px 12px 9px 36px; border: 1px solid var(--miles-border); border-radius: 10px; font-size: 13px; outline: none; background: var(--miles-white); font-family: inherit; }
        .miles-help-search .miles-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--miles-text-dim); }
        .miles-help-list { display: flex; flex-direction: column; gap: 6px; }
        .miles-help-item { padding: 12px 12px; background: var(--miles-white); border: 1px solid var(--miles-border); border-radius: 10px; cursor: pointer; display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; font-family: inherit; }
        .miles-help-item:hover { border-color: var(--miles-primary); background: #f0f7fa; }
        .miles-help-item .icon { width: 26px; text-align: center; flex-shrink: 0; color: var(--miles-primary); }
        .miles-help-item .text { flex: 1; font-size: 12.5px; font-weight: 600; color: var(--miles-text); }
        .miles-help-item .text .sub { font-size: 11px; font-weight: 400; color: var(--miles-text-dim); display: block; margin-top: 2px; }

        .miles-article-view { display: none; flex-direction: column; height: 100%; background: var(--miles-white); }
        .miles-article-view.open { display: flex; }
        .miles-article-header { padding: 10px 14px; border-bottom: 1px solid var(--miles-border); background: var(--miles-white); display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .miles-article-header .back-btn { background: none; border: none; cursor: pointer; font-size: 16px; color: var(--miles-primary); padding: 4px; display: flex; align-items: center; justify-content: center; }
        .miles-article-header .back-btn:hover { color: var(--miles-primary-light); }
        .miles-article-header .info { flex: 1; min-width: 0; }
        .miles-article-header .info .title { font-weight: 700; font-size: 14px; }
        .miles-article-header .info .sub { font-size: 11px; color: var(--miles-text-dim); }
        .miles-article-body { flex: 1; overflow-y: auto; padding: 16px 18px; }
        .miles-article-body h2 { font-size: 18px; font-weight: 700; color: var(--miles-text); margin-bottom: 6px; }
        .miles-article-body .meta { font-size: 11px; color: var(--miles-text-dim); margin-bottom: 12px; }
        .miles-article-body .meta .category { background: var(--miles-bg); padding: 2px 8px; border-radius: 99px; }
        .miles-article-body .content { font-size: 13px; line-height: 1.7; color: var(--miles-text); }
        .miles-article-body .content p { margin-bottom: 10px; }
        .miles-article-body .content ul, .miles-article-body .content ol { padding-left: 20px; margin-bottom: 10px; }
        .miles-article-body .content li { margin-bottom: 4px; }
        .miles-article-body .content strong { color: var(--miles-primary); }
        .miles-article-body .related { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--miles-border); }
        .miles-article-body .related h6 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--miles-text-dim); margin-bottom: 8px; }
        .miles-article-body .related-item { display: block; width: 100%; text-align: left; padding: 8px 10px; background: var(--miles-bg); border: 1px solid var(--miles-border); border-radius: 8px; font-size: 12px; font-weight: 600; color: var(--miles-text); cursor: pointer; margin-bottom: 6px; font-family: inherit; }
        .miles-article-body .related-item:hover { border-color: var(--miles-primary); }
        .miles-article-body .article-actions { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--miles-border); display: flex; flex-direction: column; gap: 8px; }
        .miles-article-body .article-actions .btn-support { padding: 10px; border-radius: 10px; background: var(--miles-primary); color: #fff; border: none; font-weight: 700; cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 8px; font-family: inherit; }
        .miles-article-body .article-actions .btn-support:hover { background: var(--miles-primary-light); }
        .miles-article-body .article-actions .btn-back-help { padding: 8px; border-radius: 10px; background: var(--miles-bg); color: var(--miles-text); border: none; font-weight: 600; cursor: pointer; font-size: 12px; font-family: inherit; }
        .miles-article-body .article-actions .btn-back-help:hover { background: var(--miles-border); }

        .miles-guest-form { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
        .miles-guest-form label { font-size: 11.5px; font-weight: 700; color: var(--miles-text-dim); text-transform: uppercase; letter-spacing: .03em; }
        .miles-guest-form input, .miles-guest-form select, .miles-guest-form textarea { width: 100%; padding: 9px 12px; border: 1px solid var(--miles-border); border-radius: 10px; font-size: 13px; outline: none; background: var(--miles-white); font-family: inherit; }
        .miles-guest-form textarea { min-height: 80px; resize: vertical; }
        .miles-guest-form .submit-btn { padding: 11px; border-radius: 10px; background: var(--miles-primary); color: #fff; border: none; font-weight: 700; cursor: pointer; }
        .miles-guest-form .submit-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .miles-form-error { font-size: 12px; color: var(--miles-danger); min-height: 14px; }
        .miles-form-note { font-size: 11px; color: var(--miles-text-faint); }

        .miles-modal-overlay { position: fixed; inset: 0; background: rgba(8,20,25,0.55); z-index: 2147483003; display: none; align-items: center; justify-content: center; padding: 16px; pointer-events: auto; }
        .miles-modal-overlay.open { display: flex; }
        .miles-modal-box { width: 380px; max-width: 100%; max-height: 88vh; background: var(--miles-white); border-radius: 16px; box-shadow: var(--miles-shadow); display: flex; flex-direction: column; overflow: hidden; }
        .miles-modal-head { padding: 14px 16px; border-bottom: 1px solid var(--miles-border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
        .miles-modal-head h4 { font-size: 15px; font-weight: 700; color: var(--miles-text); }
        .miles-modal-head button { background: none; border: none; cursor: pointer; color: var(--miles-text-dim); padding: 4px; display: flex; }
        .miles-modal-body { padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
        .miles-modal-body label { font-size: 11.5px; font-weight: 700; color: var(--miles-text-dim); text-transform: uppercase; letter-spacing: .03em; display: block; margin-bottom: 5px; }
        .miles-modal-body input, .miles-modal-body select, .miles-modal-body textarea { width: 100%; padding: 9px 12px; border: 1px solid var(--miles-border); border-radius: 10px; font-size: 13px; outline: none; background: var(--miles-bg); font-family: inherit; }
        .miles-modal-body input:focus, .miles-modal-body select:focus, .miles-modal-body textarea:focus { border-color: var(--miles-primary); background: var(--miles-white); }
        .miles-modal-body textarea { min-height: 90px; resize: vertical; }
        .miles-modal-field-error { font-size: 11px; color: var(--miles-danger); margin-top: 4px; display: none; }
        .miles-modal-field-error.show { display: block; }
        .miles-modal-foot { padding: 12px 16px; border-top: 1px solid var(--miles-border); flex-shrink: 0; }
        .miles-modal-foot .submit-ticket-btn { width: 100%; padding: 11px; border-radius: 10px; background: var(--miles-primary); color: #fff; border: none; font-weight: 700; cursor: pointer; font-size: 13px; }
        .miles-modal-foot .submit-ticket-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .miles-modal-error { font-size: 12px; color: var(--miles-danger); text-align: center; }
        .miles-modal-success { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 20px 4px; gap: 6px; }
        .miles-modal-success .miles-icon { width: 40px; height: 40px; color: var(--miles-success); }
        .miles-modal-success h5 { font-size: 15px; font-weight: 700; color: var(--miles-text); }
        .miles-modal-success p { font-size: 12.5px; color: var(--miles-text-dim); }

        @supports (padding: max(0px)) { #miles-panel { padding-bottom: env(safe-area-inset-bottom, 0px); } }
        @media (prefers-color-scheme: dark) {
            #miles-widget-root.dark { --miles-bg: #0f1a24; --miles-white: #1a2a33; --miles-text: #e8f0f5; --miles-text-dim: #8fa3ab; --miles-text-faint: #5b7480; --miles-border: rgba(255,255,255,0.08); }
        }
        @media (prefers-reduced-motion: reduce) { #miles-panel, #miles-panel.open, .miles-typing .dot { animation: none !important; } }

        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    `;

    // ─── MARKUP (unchanged) ───
    function buildTemplate() {
        const suggestions = CATEGORIES.slice(0, 9).map(c =>
            `<button class="miles-suggestion" type="button" data-category="${c.key}">${icon(c.key)} ${c.label}</button>`
        ).join('');

        const categoryOptions = CATEGORIES.map(c => `<option value="${c.key}">${c.label}</option>`).join('');

        return `
        <button id="miles-launcher" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Open support chat">
            <span class="badge" id="milesBadge" aria-hidden="true">0</span>
            ${icon('chat')}
        </button>

        <div id="miles-panel" role="dialog" aria-modal="false" aria-label="MilesSpace Support" aria-hidden="true">
            <div class="miles-header">
                <div class="miles-header-left">
                    <div class="info">
                        <h3>Miles Support</h3>
                        <div class="status" id="milesStatusRow">
                            <span class="dot" id="milesStatusDot"></span>
                            <span id="milesStatusText">${STATUS.CONNECTING}</span>
                        </div>
                    </div>
                </div>
                <div class="miles-header-actions">
                    <button id="milesMuteBtn" type="button" title="Mute notification sound" aria-pressed="false">${icon('bell')}</button>
                    <button id="milesMinimize" type="button" title="Minimize" aria-label="Minimize">${icon('minimize')}</button>
                    <button id="milesClose" type="button" title="Close" aria-label="Close support panel">${icon('close')}</button>
                </div>
            </div>

            <div class="miles-tabs" role="tablist">
                <button class="tab active" data-tab="home" type="button" role="tab" aria-selected="true">Home</button>
                <button class="tab" data-tab="chats" type="button" role="tab" aria-selected="false">
                    Chats <span class="tab-badge" id="milesTabBadge">0</span>
                </button>
                <button class="tab" data-tab="help" type="button" role="tab" aria-selected="false">Help</button>
            </div>

            <div class="miles-content">
                <div class="miles-tab-content active" id="tab-home" role="tabpanel">
                    <div class="miles-welcome">
                        <div class="greeting" id="milesGreeting">Hi there!</div>
                        <div class="sub" id="milesAvailabilityText">Checking support availability…</div>
                    </div>
                    <div class="miles-suggestions" id="milesSuggestions">${suggestions}</div>
                    <button class="miles-contact-btn" id="milesContactSupport" type="button">${icon('support')} Contact human support</button>
                </div>

                <div class="miles-tab-content" id="tab-chats" role="tabpanel">
                    <div class="miles-conv-list" id="milesConvList">
                        <div class="conv-header">
                            <div>
                                <h4>Conversations</h4>
                                <span class="conv-count" id="milesConvCount">0 chats</span>
                            </div>
                            <button class="new-ticket-btn" id="milesNewTicketBtn" type="button">${icon('plus')} New</button>
                        </div>
                        <div class="conv-search">
                            <input type="text" id="milesConvSearch" placeholder="Search conversations..." aria-label="Search conversations" />
                        </div>
                        <div class="miles-conv-items" id="milesConvItems" role="list">
                            <div class="miles-conv-empty">
                                ${icon('chat')}
                                <h4>No conversations</h4>
                                <p>Start a new conversation from the Home tab</p>
                                <button class="btn-primary" id="milesEmptyStartChat" type="button">Start a chat</button>
                            </div>
                        </div>
                    </div>

                    <div class="miles-message-view" id="milesMessageView">
                        <div class="miles-msg-header">
                            <button class="back-btn" id="milesMsgBack" aria-label="Back to conversations">${icon('back')}</button>
                            <div class="info">
                                <div class="subject" id="milesMsgSubject">Conversation</div>
                                <div class="status" id="milesMsgStatus"><span class="dot open"></span> Open</div>
                            </div>
                            <div class="miles-msg-header-actions" id="milesMsgHeaderActions"></div>
                        </div>
                        <div class="miles-message-list" id="milesMessageList">
                            <div class="miles-msg-empty">${icon('chat')}<p>No messages yet</p></div>
                        </div>
                        <div id="milesRatingSlot"></div>
                        <div class="miles-typing" id="milesTyping">
                            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                            <span style="font-size:11px;color:var(--miles-text-dim);">Support is typing…</span>
                        </div>
                        <div class="miles-ticket-closed-note" id="milesClosedNote" style="display:none;">
                            This ticket is closed. <button id="milesReopenBtn" type="button">Reopen it</button> to keep chatting.
                        </div>
                        <div class="miles-input-area" id="milesInputArea">
                            <div class="miles-file-preview" id="milesFilePreview"></div>
                            <div class="miles-input-row">
                                <button class="attach-btn" id="milesAttachBtn" type="button" aria-label="Attach file">
                                    ${icon('image')}
                                    <input type="file" id="milesFileInput" multiple accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv" />
                                </button>
                                <textarea id="milesInput" placeholder="Type a message… (Shift+Enter for new line)" rows="1" maxlength="${CONFIG.MAX_MESSAGE_LENGTH}"></textarea>
                                <button class="send-btn" id="milesSendBtn" type="button" aria-label="Send message">${icon('send')}</button>
                            </div>
                            <div class="miles-send-status" id="milesSendStatus"></div>
                        </div>
                    </div>
                </div>

                <div class="miles-tab-content" id="tab-help" role="tabpanel">
                    <div class="miles-help-search">
                        ${icon('search')}
                        <input type="text" id="milesHelpSearch" placeholder="Search help articles…" autocomplete="off">
                    </div>
                    <div class="miles-help-list" id="milesHelpList"></div>

                    <div class="miles-article-view" id="milesArticleView">
                        <div class="miles-article-header">
                            <button class="back-btn" id="milesArticleBack" aria-label="Back to help">${icon('back')}</button>
                            <div class="info">
                                <div class="title" id="milesArticleTitle">Article</div>
                                <div class="sub" id="milesArticleSub">Loading…</div>
                            </div>
                        </div>
                        <div class="miles-article-body" id="milesArticleBody">
                            <div class="miles-msg-empty">${icon('article')}<p>Article content here</p></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div class="miles-modal-overlay" id="milesModalOverlay" role="presentation">
            <div class="miles-modal-box" role="dialog" aria-modal="true" aria-labelledby="milesModalTitle">
                <div class="miles-modal-head">
                    <h4 id="milesModalTitle">New support ticket</h4>
                    <button id="milesModalClose" type="button" aria-label="Close">${icon('close')}</button>
                </div>
                <div id="milesModalContent">
                    <form id="milesTicketForm" novalidate>
                        <div class="miles-modal-body">
                            <div>
                                <label for="milesTicketCategory">Category</label>
                                <select id="milesTicketCategory" name="category">${categoryOptions}</select>
                            </div>
                            <div>
                                <label for="milesTicketSubject">Subject</label>
                                <input id="milesTicketSubject" name="subject" type="text" maxlength="${CONFIG.MAX_SUBJECT_LENGTH}" required placeholder="Briefly describe your issue">
                                <div class="miles-modal-field-error" id="milesTicketSubjectError">Subject is required.</div>
                            </div>
                            <div>
                                <label for="milesTicketMessage">Message</label>
                                <textarea id="milesTicketMessage" name="message" maxlength="${CONFIG.MAX_MESSAGE_LENGTH}" required placeholder="Tell us what's going on"></textarea>
                                <div class="miles-modal-field-error" id="milesTicketMessageError">Please describe your issue.</div>
                            </div>
                            <div>
                                <label for="milesTicketReference">Related reference <span style="text-transform:none;font-weight:400;">(optional)</span></label>
                                <input id="milesTicketReference" name="reference" type="text" maxlength="50" placeholder="Transaction/order reference, if any">
                            </div>
                            <div class="miles-modal-error" id="milesTicketFormError" role="alert"></div>
                        </div>
                        <div class="miles-modal-foot">
                            <button class="submit-ticket-btn" type="submit" id="milesTicketSubmitBtn">Create ticket</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>

        <div class="miles-lightbox" id="milesLightbox" role="dialog" aria-modal="true" aria-label="Image preview">
            <button class="lb-close" id="milesLightboxClose" aria-label="Close image preview">${icon('close')}</button>
            <img id="milesLightboxImg" src="" alt="">
            <a class="lb-open-original" id="milesLightboxOpen" href="#" target="_blank" rel="noopener noreferrer">Open original</a>
        </div>`;
    }

    function guestFormMarkup() {
        const options = CATEGORIES.map(c => `<option value="${c.key}">${c.label}</option>`).join('');
        return `
        <form class="miles-guest-form" id="milesGuestForm" novalidate>
            <div class="miles-form-note">You're not signed in. Leave your details and a support agent will follow up by email.</div>
            <div><label for="milesGuestName">Name</label><input id="milesGuestName" name="name" type="text" required maxlength="120"></div>
            <div><label for="milesGuestEmail">Email</label><input id="milesGuestEmail" name="email" type="email" required maxlength="180"></div>
            <div><label for="milesGuestCategory">Category</label><select id="milesGuestCategory" name="category">${options}</select></div>
            <div><label for="milesGuestSubject">Subject</label><input id="milesGuestSubject" name="subject" type="text" required maxlength="150"></div>
            <div><label for="milesGuestMessage">Message</label><textarea id="milesGuestMessage" name="message" required maxlength="${CONFIG.MAX_MESSAGE_LENGTH}"></textarea></div>
            <div class="miles-form-error" id="milesGuestFormError" role="alert"></div>
            <button class="submit-btn" type="submit" id="milesGuestSubmit">Send to support</button>
        </form>`;
    }

    // ─── HELPERS ───
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function safeUrl(url) {
        if (!url || typeof url !== 'string') return '';
        const trimmed = url.trim();
        if (/^javascript:/i.test(trimmed)) return '';
        if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('/')) return trimmed;
        return '';
    }

    function formatFileSize(bytes) {
        bytes = Number(bytes) || 0;
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function getFileIcon(mimeType) {
        if (mimeType && mimeType.startsWith('image/')) return 'image';
        if (mimeType === 'application/pdf') return 'pdf';
        return 'file';
    }

    function attMime(att) { return att.mime || att.type || ''; }

    function getTimeAgo(dateStr) {
        if (!dateStr) return '';
        const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
        return Math.floor(diff / 604800) + 'w ago';
    }

    function isSameDay(a, b) {
        const da = new Date(a), db = new Date(b);
        return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
    }

    function formatDateSep(dateStr) {
        const d = new Date(dateStr);
        const today = new Date();
        const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
        if (isSameDay(d, today)) return 'Today';
        if (isSameDay(d, yesterday)) return 'Yesterday';
        return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
    }

    // ─── WIDGET CLASS ───
    class MilesWidget {
        constructor(config) {
            this.apiUrl = (config && config.apiUrl) || CONFIG.API_URL;
            this.root = null;

            this.userId = null;
            this.token = null;
            this.username = 'there';
            this.isAuthenticated = false;

            // ─── KEY: on auth pages, we ALWAYS treat the user as a guest,
            // even if there's a leftover mx_sess in localStorage. This
            // prevents any authenticated request from firing on login/signup.
            this.isAuthPage = IS_AUTH_PAGE;

            this.conversations = [];
            this.unreadByTicket = new Map();
            this.currentConversationId = null;
            this.knownMessageIds = new Set();
            this.messages = [];
            this._isLoadingMessages = false;
            this._currentConvMessages = new Map();
            this._lastFailedSend = null;
            this._lastConvSearch = '';
            this._ratingSubmittedFor = new Set();

            this.isOpen = false;
            this.currentTab = 'home';
            this.isProcessing = false;
            this.pendingFiles = [];
            this.previousUnread = 0;

            this.pollAbortController = null;
            this.pollTimer = null;
            this.globalPollTimer = null;
            this.pollInFlight = false;

            this.hasUserInteracted = false;
            this.audioCtx = null;
            this.muted = this.readMutePref();

            this.isDragging = false;
            this.hasMoved = false;
            this.dragStartX = 0;
            this.dragStartY = 0;
            this.dragOffsetX = 0;
            this.dragOffsetY = 0;
            this._modalTriggerEl = null;

            this._positionInitialized = false;
            this._lastBreakpoint = null;
            this._resizeTimer = null;

            this._boundGlobalKeydown = this.onGlobalKeydown.bind(this);
            this._boundFirstInteraction = this.onFirstInteraction.bind(this);
            this._boundConvClick = this._handleConvClick.bind(this);
            this._boundResize = this.onWindowResize.bind(this);
            this._boundStorage = this.onStorageChange.bind(this);

            this.init();
        }

        init() {
            this.getUserData();
            this.injectStyles();
            this.injectMarkup();

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.setupWidget(), { once: true });
            } else {
                this.setupWidget();
            }
        }

        _isTokenExpired(token) {
            try {
                const parts = token.split('.');
                if (parts.length !== 3) return true;
                let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                while (b64.length % 4) b64 += '=';
                const payload = JSON.parse(atob(b64));
                if (!payload.exp) return false;
                return Date.now() >= payload.exp * 1000;
            } catch {
                return true;
            }
        }

        getUserData() {
            // ─── On auth pages, always treat as guest. ─────────────────
            // The user is literally in the middle of authenticating; we
            // must not fire any authenticated API calls from here.
            if (this.isAuthPage) {
                this.userId = null;
                this.token = null;
                this.username = 'there';
                this.isAuthenticated = false;
                return;
            }

            // ─── Prefer session.js as source of truth. ─────────────────
            if (typeof window.getUser === 'function' && typeof window.getUserToken === 'function') {
                const user = window.getUser();
                const token = window.getUserToken();
                this.userId = (user && user.id) || null;
                this.token = token || null;
                this.username = (user && user.username) || 'there';
                this.isAuthenticated = !!(this.userId && this.token && !this._isTokenExpired(this.token));
                return;
            }

            // ─── Fallback: read mx_sess directly, checking expiry. ─────
            try {
                if (window.__MILES_USER && typeof window.__MILES_USER === 'object') {
                    this.userId = window.__MILES_USER.id || null;
                    this.token = window.__MILES_USER.token || null;
                    this.username = window.__MILES_USER.username || 'there';
                    this.isAuthenticated = !!(this.userId && this.token && !this._isTokenExpired(this.token));
                    return;
                }
                if (window.__MILES_USER_ID && window.__MILES_TOKEN) {
                    this.userId = window.__MILES_USER_ID || null;
                    this.token = window.__MILES_TOKEN || null;
                    this.username = window.__MILES_USERNAME || 'there';
                    this.isAuthenticated = !!(this.userId && this.token && !this._isTokenExpired(this.token));
                    return;
                }
                const stored = localStorage.getItem('mx_sess') || sessionStorage.getItem('mx_sess');
                if (stored) {
                    const data = JSON.parse(stored);
                    this.userId = (data.user && data.user.id) || null;
                    this.token = data.token || null;
                    this.username = (data.user && data.user.username) || 'there';
                    this.isAuthenticated = !!(this.userId && this.token && !this._isTokenExpired(this.token));
                    return;
                }
            } catch (e) {
                console.warn('[MilesWidget] could not read session', e);
            }

            this.isAuthenticated = false;
        }

        injectStyles() {
            if (document.getElementById('miles-widget-styles')) return;
            const style = document.createElement('style');
            style.id = 'miles-widget-styles';
            style.textContent = styles;
            document.head.appendChild(style);
        }

        injectMarkup() {
            if (document.getElementById('miles-widget-root')) {
                this.root = document.getElementById('miles-widget-root');
                return;
            }
            const root = document.createElement('div');
            root.id = 'miles-widget-root';
            root.innerHTML = buildTemplate();
            document.body.appendChild(root);
            this.root = root;

            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                root.classList.add('dark');
            }
        }

        setupWidget() {
            if (!this.root) { console.error('[MilesWidget] root element missing'); return; }
            if (this.root.dataset.milesReady === '1') return;
            this.root.dataset.milesReady = '1';

            const q = (sel) => this.root.querySelector(sel);

            this.launcher = q('#miles-launcher');
            this.panel = q('#miles-panel');
            this.badge = q('#milesBadge');
            this.tabBadge = q('#milesTabBadge');

            this.convItems = q('#milesConvItems');
            this.convSearch = q('#milesConvSearch');
            this.convCount = q('#milesConvCount');
            this.newTicketBtn = q('#milesNewTicketBtn');

            this.messageView = q('#milesMessageView');
            this.messageList = q('#milesMessageList');
            this.msgSubject = q('#milesMsgSubject');
            this.msgStatus = q('#milesMsgStatus');
            this.msgBack = q('#milesMsgBack');
            this.msgHeaderActions = q('#milesMsgHeaderActions');
            this.closedNote = q('#milesClosedNote');
            this.reopenBtn = q('#milesReopenBtn');
            this.ratingSlot = q('#milesRatingSlot');

            this.input = q('#milesInput');
            this.sendBtn = q('#milesSendBtn');
            this.sendStatus = q('#milesSendStatus');
            this.typingIndicator = q('#milesTyping');
            this.inputArea = q('#milesInputArea');

            this.helpList = q('#milesHelpList');
            this.helpSearch = q('#milesHelpSearch');
            this.articleView = q('#milesArticleView');
            this.articleTitle = q('#milesArticleTitle');
            this.articleSub = q('#milesArticleSub');
            this.articleBody = q('#milesArticleBody');
            this.articleBack = q('#milesArticleBack');

            this.statusText = q('#milesStatusText');
            this.statusDot = q('#milesStatusDot');
            this.availabilityText = q('#milesAvailabilityText');
            this.greeting = q('#milesGreeting');
            this.muteBtn = q('#milesMuteBtn');
            this.fileInput = q('#milesFileInput');
            this.attachBtn = q('#milesAttachBtn');
            this.filePreview = q('#milesFilePreview');

            this.modalOverlay = q('#milesModalOverlay');
            this.modalContent = q('#milesModalContent');
            this.modalClose = q('#milesModalClose');
            this.ticketForm = q('#milesTicketForm');
            this.ticketSubmitBtn = q('#milesTicketSubmitBtn');

            this.lightbox = q('#milesLightbox');
            this.lightboxImg = q('#milesLightboxImg');
            this.lightboxOpen = q('#milesLightboxOpen');
            this.lightboxClose = q('#milesLightboxClose');

            if (!this.launcher || !this.panel) { console.error('[MilesWidget] required elements not found'); return; }

            this.setGreeting();
            this.setupDragging();
            this.setupEventListeners();
            this.renderHelpArticles(HELP_ARTICLES);
            this.applyMuteUI();

            this.initializePosition();
            window.addEventListener('resize', this._boundResize);
            window.addEventListener('orientationchange', this._boundResize);
            window.addEventListener('storage', this._boundStorage);

            this.fetchStatus();

            // ─── Branch: authenticated vs guest ────────────────────────
            // On auth pages, isAuthenticated is always false → guest view.
            // On normal pages with a valid session → full widget.
            // On normal pages without a session → guest view (still lets
            // them reach support; they'll be prompted to sign in if they
            // want the full conversation history).
            if (this.isAuthenticated) {
                this.setStatus(STATUS.CONNECTING, 'waiting');
                this.loadConversations();
                this.startGlobalPolling();
            } else {
                this.setStatus(STATUS.AVAILABLE, 'online');
                this.showGuestView();
            }

            this.switchTab('home');
            window.MilesWidget = this;
        }

        onStorageChange(e) {
            if (e.key === 'mx_sess' && !e.newValue) {
                console.log('[MilesWidget] session cleared in another tab — switching to guest');
                this.stopGlobalPolling();
                this.stopPolling();
                this.isAuthenticated = false;
                this.userId = null;
                this.token = null;
                this.conversations = [];
                this.unreadByTicket = new Map();
                this.currentConversationId = null;
                if (this.convItems) this.renderConversationList();
                if (this.badge) this.badge.classList.remove('show');
                if (this.tabBadge) this.tabBadge.classList.remove('show');
                this.showGuestView();
            }
        }

        // ─── BREAKPOINT / POSITION HELPERS (unchanged) ───
        getBreakpoint() {
            return window.innerWidth <= CONFIG.MOBILE_BREAKPOINT ? 'mobile' : 'desktop';
        }

        getPositionStorageKeys(breakpoint) {
            const bp = breakpoint || this.getBreakpoint();
            return {
                left: `${CONFIG.STORAGE_PREFIX}launcher_left_${bp}`,
                top: `${CONFIG.STORAGE_PREFIX}launcher_top_${bp}`
            };
        }

        getDefaultEdgeOffsets(breakpoint) {
            const bp = breakpoint || this.getBreakpoint();
            return bp === 'mobile'
                ? { bottom: CONFIG.MOBILE_BOTTOM, right: CONFIG.MOBILE_RIGHT }
                : { bottom: CONFIG.DESKTOP_BOTTOM, right: CONFIG.DESKTOP_RIGHT };
        }

        applyDefaultLauncherPosition(breakpoint) {
            if (!this.launcher) return;
            const { bottom, right } = this.getDefaultEdgeOffsets(breakpoint);
            this.launcher.style.left = 'auto';
            this.launcher.style.top = 'auto';
            this.launcher.style.right = right + 'px';
            this.launcher.style.bottom = bottom + 'px';
        }

        clearStoredPosition(breakpoint) {
            const keys = this.getPositionStorageKeys(breakpoint);
            try {
                localStorage.removeItem(keys.left);
                localStorage.removeItem(keys.top);
            } catch (e) {}
        }

        applyPositionForBreakpoint(breakpoint) {
            if (!this.launcher) return;
            const bp = breakpoint || this.getBreakpoint();
            const keys = this.getPositionStorageKeys(bp);

            let storedLeft = null, storedTop = null;
            try {
                storedLeft = localStorage.getItem(keys.left);
                storedTop = localStorage.getItem(keys.top);
            } catch (e) {}

            if (storedLeft && storedTop) {
                const w = this.launcher.offsetWidth || (bp === 'mobile' ? 54 : 58);
                const h = this.launcher.offsetHeight || (bp === 'mobile' ? 54 : 58);
                const rawLeft = parseFloat(storedLeft);
                const rawTop = parseFloat(storedTop);

                const isOffScreen = !isFinite(rawLeft) || !isFinite(rawTop) ||
                    rawLeft + w <= 0 || rawTop + h <= 0 ||
                    rawLeft >= window.innerWidth || rawTop >= window.innerHeight;

                if (isOffScreen) {
                    this.applyDefaultLauncherPosition(bp);
                    this.clearStoredPosition(bp);
                } else {
                    const left = Math.max(0, Math.min(rawLeft, window.innerWidth - w));
                    const top = Math.max(0, Math.min(rawTop, window.innerHeight - h));
                    this.launcher.style.left = left + 'px';
                    this.launcher.style.top = top + 'px';
                    this.launcher.style.right = 'auto';
                    this.launcher.style.bottom = 'auto';
                }
            } else {
                this.applyDefaultLauncherPosition(bp);
            }

            this._lastBreakpoint = bp;
        }

        initializePosition() {
            this.applyPositionForBreakpoint(this.getBreakpoint());
            this._positionInitialized = true;
        }

        restorePosition() {
            if (!this._positionInitialized) { this.initializePosition(); return; }
            this.applyPositionForBreakpoint(this.getBreakpoint());
        }

        onWindowResize() {
            clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => {
                if (this.isDragging || !this.launcher) return;

                const bp = this.getBreakpoint();
                if (bp !== this._lastBreakpoint) {
                    this.applyPositionForBreakpoint(bp);
                    return;
                }

                const rect = this.launcher.getBoundingClientRect();
                const w = this.launcher.offsetWidth || 58;
                const h = this.launcher.offsetHeight || 58;
                const offScreen = rect.right <= 0 || rect.bottom <= 0 ||
                    rect.left >= window.innerWidth || rect.top >= window.innerHeight;
                if (offScreen) {
                    this.applyPositionForBreakpoint(bp);
                    return;
                }
                if (this.launcher.style.left && this.launcher.style.left !== 'auto') {
                    const clampedLeft = Math.max(0, Math.min(rect.left, window.innerWidth - w));
                    const clampedTop = Math.max(0, Math.min(rect.top, window.innerHeight - h));
                    this.launcher.style.left = clampedLeft + 'px';
                    this.launcher.style.top = clampedTop + 'px';
                }
            }, 150);
        }

        // ── GREETING / STATUS ──
        setGreeting() {
            const hour = new Date().getHours();
            let g = 'Hi there';
            if (hour < 12) g = 'Good morning';
            else if (hour < 17) g = 'Good afternoon';
            else g = 'Good evening';
            if (this.greeting) this.greeting.textContent = this.isAuthenticated ? `${g}, ${escapeHtml(this.username)}!` : `${g}!`;
        }

        setStatus(text, dotState) {
            if (this.statusText) this.statusText.textContent = text;
            if (this.statusDot) {
                this.statusDot.classList.remove('offline', 'waiting');
                if (dotState === 'offline') this.statusDot.classList.add('offline');
                if (dotState === 'waiting') this.statusDot.classList.add('waiting');
            }
        }

        async fetchStatus() {
            try {
                const res = await fetch(`${this.apiUrl}/status`);
                const data = await res.json().catch(() => ({}));
                if (data.success && data.data) {
                    const d = data.data;
                    if (this.availabilityText) {
                        this.availabilityText.textContent = d.online
                            ? `Support online · avg. reply ~${d.average_response_minutes || 8} min`
                            : 'Our team typically replies within a few hours.';
                    }
                }
            } catch (e) {
                if (this.availabilityText) this.availabilityText.textContent = 'Our team typically replies within a few hours.';
            }
        }

        // ─── Guest view ───
        // Shown on auth pages, when signed out, or when the session just
        // expired. Also shown on protected pages if the user is not yet
        // authenticated for any reason.
        showGuestView() {
            if (!this.messageList) return;
            this.messageList.innerHTML = `
                <div class="miles-msg-empty">
                    ${icon('info')}
                    <h4>Sign in for full support</h4>
                    <p style="font-size:12px;color:var(--miles-text-dim);margin-top:4px;">
                        <a href="/login" style="color:var(--miles-primary);font-weight:700;">Sign in</a> to view your conversations and send messages.
                    </p>
                    <p style="font-size:12px;color:var(--miles-text-dim);margin-top:10px;">
                        Or keep using the chat as a guest below.
                    </p>
                    <button class="btn-primary" id="milesGuestOpenBtn" type="button" style="margin-top:12px;">Continue as guest</button>
                </div>`;
            this.messageList.querySelector('#milesGuestOpenBtn')?.addEventListener('click', () => this.openGuestForm());
        }

        // ── HELP ARTICLES (unchanged) ──
        renderHelpArticles(articles) {
            if (!this.helpList) return;
            if (!articles || articles.length === 0) {
                this.helpList.innerHTML = `<div class="miles-msg-empty"><p>No help articles found.</p></div>`;
                return;
            }

            const grouped = {};
            articles.forEach(a => { (grouped[a.category] = grouped[a.category] || []).push(a); });

            let html = '';
            Object.keys(grouped).forEach(category => {
                html += `<div style="margin-bottom:12px;">`;
                html += `<div style="font-size:11px;font-weight:700;color:var(--miles-text-dim);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">${escapeHtml(category)}</div>`;
                grouped[category].forEach(a => {
                    const globalIndex = HELP_ARTICLES.indexOf(a);
                    html += `
                        <button class="miles-help-item" type="button" data-article-index="${globalIndex}">
                            <span class="icon">${icon(a.categoryKey || 'other')}</span>
                            <span class="text">${escapeHtml(a.title)}<span class="sub">${escapeHtml(a.summary)}</span></span>
                        </button>`;
                });
                html += `</div>`;
            });

            this.helpList.innerHTML = html;
            this.helpList.querySelectorAll('.miles-help-item').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.articleIndex, 10);
                    const article = HELP_ARTICLES[idx];
                    if (article) this.showArticle(article);
                });
            });
        }

        showArticle(article) {
            if (!this.articleView || !this.articleBody) return;

            this.articleTitle.textContent = article.title;
            this.articleSub.textContent = `${article.category} · ${article.readTime}`;

            const related = HELP_ARTICLES.filter(a => a.categoryKey === article.categoryKey && a.id !== article.id).slice(0, 3);
            const relatedHtml = related.length
                ? `<div class="related"><h6>Related articles</h6>${related.map(r => `<button class="related-item" type="button" data-related-id="${escapeHtml(r.id)}">${escapeHtml(r.title)}</button>`).join('')}</div>`
                : '';

            this.articleBody.innerHTML = `
                <h2>${escapeHtml(article.title)}</h2>
                <div class="meta">
                    <span class="category">${escapeHtml(article.category)}</span>
                    <span style="margin-left:8px;">${escapeHtml(article.readTime)}</span>
                    <span style="margin-left:8px;">Updated ${escapeHtml(article.updatedAt)}</span>
                </div>
                <div class="content">${article.content}</div>
                ${relatedHtml}
                <div class="article-actions">
                    <button class="btn-support" type="button" id="milesArticleContactBtn">${icon('chat')} Still need help? Contact support</button>
                    <button class="btn-back-help" type="button" id="milesArticleBackHelp">← Back to help articles</button>
                </div>`;

            this.articleBody.querySelector('#milesArticleBackHelp')?.addEventListener('click', () => this.closeArticleView());
            this.articleBody.querySelector('#milesArticleContactBtn')?.addEventListener('click', () => {
                this.closeArticleView();
                this.openNewTicketModal({ category: article.categoryKey, subject: article.title });
            });
            this.articleBody.querySelectorAll('.related-item').forEach(btn => {
                btn.addEventListener('click', () => {
                    const rel = HELP_ARTICLES.find(a => a.id === btn.dataset.relatedId);
                    if (rel) this.showArticle(rel);
                });
            });

            this.helpList.style.display = 'none';
            this.helpSearch.style.display = 'none';
            this.articleView.classList.add('open');
        }

        closeArticleView() {
            if (!this.articleView) return;
            this.articleView.classList.remove('open');
            this.helpList.style.display = '';
            this.helpSearch.style.display = '';
        }

        // ─── DRAGGING (unchanged) ───
        setupDragging() {
            if (!this.launcher) return;
            const onPointerDown = (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                const rect = this.launcher.getBoundingClientRect();
                this.dragStartX = e.clientX; this.dragStartY = e.clientY;
                this.dragOffsetX = e.clientX - rect.left; this.dragOffsetY = e.clientY - rect.top;
                this.hasMoved = false; this.isDragging = false;
                try { this.launcher.setPointerCapture(e.pointerId); } catch (err) {}
                this.launcher.classList.add('dragging');
            };
            const onPointerMove = (e) => {
                if (e.buttons === 0 && this.isDragging === false && this.dragStartX === 0) return;
                const dx = e.clientX - this.dragStartX, dy = e.clientY - this.dragStartY;
                if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
                    this.isDragging = true; this.hasMoved = true;
                    let newLeft = e.clientX - this.dragOffsetX, newTop = e.clientY - this.dragOffsetY;
                    const w = this.launcher.offsetWidth || 58, h = this.launcher.offsetHeight || 58;
                    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - w));
                    newTop = Math.max(0, Math.min(newTop, window.innerHeight - h));
                    this.launcher.style.left = newLeft + 'px'; this.launcher.style.top = newTop + 'px';
                    this.launcher.style.right = 'auto'; this.launcher.style.bottom = 'auto';
                    e.preventDefault();
                }
            };
            const onPointerUp = (e) => {
                this.launcher.classList.remove('dragging');
                if (this.isDragging) {
                    const left = this.launcher.style.left, top = this.launcher.style.top;
                    if (left && top) {
                        const keys = this.getPositionStorageKeys(this.getBreakpoint());
                        try {
                            localStorage.setItem(keys.left, left);
                            localStorage.setItem(keys.top, top);
                        } catch (err) {}
                    }
                } else if (!this.hasMoved) {
                    this.toggle();
                }
                this.isDragging = false; this.hasMoved = false;
                try { this.launcher.releasePointerCapture(e.pointerId); } catch (err) {}
            };
            this.launcher.addEventListener('pointerdown', onPointerDown);
            this.launcher.addEventListener('pointermove', onPointerMove);
            this.launcher.addEventListener('pointerup', onPointerUp);
            this.launcher.addEventListener('pointercancel', onPointerUp);
        }

        // ─── EVENT LISTENERS (unchanged) ───
        setupEventListeners() {
            const q = (sel) => this.root.querySelector(sel);

            q('#milesClose')?.addEventListener('click', () => this.close());
            q('#milesMinimize')?.addEventListener('click', () => this.minimize());
            this.muteBtn?.addEventListener('click', () => this.toggleMute());

            this.root.querySelector('.miles-tabs')?.addEventListener('click', (e) => {
                const btn = e.target.closest('.tab');
                if (btn) this.switchTab(btn.dataset.tab);
            });

            this.sendBtn?.addEventListener('click', (e) => { e.preventDefault(); this.sendMessage(); });

            if (this.input) {
                this.input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); }
                });
                this.input.addEventListener('input', () => {
                    this.input.style.height = 'auto';
                    this.input.style.height = Math.min(this.input.scrollHeight, 100) + 'px';
                });
            }

            this.fileInput?.addEventListener('change', (e) => { this.handleFiles(e.target.files); e.target.value = ''; });
            this.attachBtn?.addEventListener('click', () => this.fileInput?.click());
            this.msgBack?.addEventListener('click', () => this.closeMessageView());
            this.reopenBtn?.addEventListener('click', () => this.reopenTicket());
            this.articleBack?.addEventListener('click', () => this.closeArticleView());

            q('#milesSuggestions')?.addEventListener('click', (e) => {
                const el = e.target.closest('.miles-suggestion');
                if (el) this.openNewTicketModal({ category: el.dataset.category });
            });

            q('#milesContactSupport')?.addEventListener('click', () => this.requestHumanSupport());
            q('#milesEmptyStartChat')?.addEventListener('click', () => this.requestHumanSupport());
            this.newTicketBtn?.addEventListener('click', () => this.requestHumanSupport());

            this.helpSearch?.addEventListener('input', () => {
                const query = this.helpSearch.value.trim().toLowerCase();
                if (!query) { this.renderHelpArticles(HELP_ARTICLES); return; }
                const filtered = HELP_ARTICLES.filter(a =>
                    a.title.toLowerCase().includes(query) ||
                    a.summary.toLowerCase().includes(query) ||
                    a.category.toLowerCase().includes(query) ||
                    a.content.toLowerCase().includes(query)
                );
                this.renderHelpArticles(filtered);
            });

            let searchDebounce = null;
            this.convSearch?.addEventListener('input', () => {
                clearTimeout(searchDebounce);
                searchDebounce = setTimeout(() => {
                    this._lastConvSearch = this.convSearch.value.trim().toLowerCase();
                    this.filterConversations(this._lastConvSearch);
                }, 150);
            });

            this.convItems?.addEventListener('click', this._boundConvClick);
            this.convItems?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    const item = e.target.closest('.miles-conv-item');
                    if (item) { e.preventDefault(); item.click(); }
                }
            });

            this.modalClose?.addEventListener('click', () => this.closeNewTicketModal());
            this.modalOverlay?.addEventListener('click', (e) => { if (e.target === this.modalOverlay) this.closeNewTicketModal(); });
            this.ticketForm?.addEventListener('submit', (e) => this.submitNewTicketForm(e));

            this.lightboxClose?.addEventListener('click', () => this.closeLightbox());
            this.lightbox?.addEventListener('click', (e) => { if (e.target === this.lightbox) this.closeLightbox(); });

            document.addEventListener('keydown', this._boundGlobalKeydown);
            ['pointerdown', 'keydown'].forEach(evt =>
                document.addEventListener(evt, this._boundFirstInteraction, { once: true, passive: true })
            );
        }

        _handleConvClick(e) {
            const item = e.target.closest('.miles-conv-item');
            if (!item) return;
            const id = item.dataset.id;
            if (!id) return;
            this.convItems.querySelectorAll('.miles-conv-item').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            this.selectConversation(id);
        }

        onGlobalKeydown(e) {
            if (e.key !== 'Escape') return;
            if (this.lightbox?.classList.contains('open')) { this.closeLightbox(); return; }
            if (this.modalOverlay?.classList.contains('open')) { this.closeNewTicketModal(); return; }
            if (this.isOpen) this.close();
        }

        onFirstInteraction() { this.hasUserInteracted = true; }

        // ─── FILE HANDLING ───
        handleFiles(files) {
            const validFiles = [];
            const errors = [];

            for (const file of files) {
                if (file.size > CONFIG.MAX_FILE_SIZE) {
                    errors.push(`${file.name} is too large (max ${formatFileSize(CONFIG.MAX_FILE_SIZE)})`);
                    continue;
                }
                if (!CONFIG.ALLOWED_FILE_TYPES.includes(file.type)) {
                    errors.push(`${file.name} is not a supported file type`);
                    continue;
                }
                validFiles.push(file);
            }

            if (errors.length > 0) {
                this.setSendStatus('⚠️ ' + errors.join(', '), true);
                setTimeout(() => this.setSendStatus(''), 4000);
            }

            const totalFiles = this.pendingFiles.length + validFiles.length;
            if (totalFiles > CONFIG.MAX_FILES_PER_MESSAGE) {
                this.setSendStatus(`Maximum ${CONFIG.MAX_FILES_PER_MESSAGE} files per message.`, true);
                setTimeout(() => this.setSendStatus(''), 3000);
                return;
            }

            this.pendingFiles = [...this.pendingFiles, ...validFiles];
            this.renderFilePreview();
            this.setSendStatus(`${this.pendingFiles.length} file(s) ready to send`);
            setTimeout(() => this.setSendStatus(''), 2000);
        }

        removePendingFile(index) {
            const removed = this.pendingFiles[index];
            if (removed && removed._previewUrl) URL.revokeObjectURL(removed._previewUrl);
            this.pendingFiles.splice(index, 1);
            this.renderFilePreview();
            if (this.pendingFiles.length === 0) this.setSendStatus('');
        }

        renderFilePreview() {
            if (!this.filePreview) return;
            if (this.pendingFiles.length === 0) { this.filePreview.innerHTML = ''; return; }

            this.filePreview.innerHTML = this.pendingFiles.map((file, index) => {
                if (file.type.startsWith('image/')) {
                    if (!file._previewUrl) file._previewUrl = URL.createObjectURL(file);
                    return `
                        <div class="file-item image-item" title="${escapeHtml(file.name)} · ${formatFileSize(file.size)}">
                            <img src="${file._previewUrl}" alt="${escapeHtml(file.name)}">
                            <button class="remove-file" type="button" data-index="${index}" title="Remove" aria-label="Remove ${escapeHtml(file.name)}">✕</button>
                        </div>`;
                }
                return `
                    <div class="file-item">
                        ${icon(getFileIcon(file.type))}
                        <span class="file-name">${escapeHtml(file.name)}</span>
                        <span class="file-size">${formatFileSize(file.size)}</span>
                        <button class="remove-file" type="button" data-index="${index}" title="Remove" aria-label="Remove ${escapeHtml(file.name)}">✕</button>
                    </div>`;
            }).join('');

            this.filePreview.querySelectorAll('.remove-file').forEach(btn => {
                btn.addEventListener('click', () => this.removePendingFile(parseInt(btn.dataset.index, 10)));
            });
        }

        // ─── AUTHENTICATED FETCH ───
        // Routes through session.js's userFetch when available, so refresh
        // + retry + return-to are handled by the single auth authority.
        async request(path, options) {
            options = options || {};
            const url = `${this.apiUrl}${path}`;
            const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});

            let response;

            const canUseUserFetch =
                typeof window.userFetch === 'function' &&
                this.isAuthenticated;

            try {
                if (canUseUserFetch) {
                    response = await window.userFetch(url, { ...options, headers });
                } else {
                    const token = this.getToken();
                    if (token) headers.Authorization = `Bearer ${token}`;
                    response = await fetch(url, { ...options, headers });
                }
            } catch (networkErr) {
                const err = new Error('NETWORK_ERROR');
                err.cause = networkErr;
                throw err;
            }

            if (canUseUserFetch) this.refreshSessionFromStore();

            let data = {};
            try {
                const text = await response.text();
                data = text ? JSON.parse(text) : {};
            } catch (parseErr) { data = {}; }

            if (response.status === 401) {
                const err = new Error('SESSION_EXPIRED');
                err.status = 401;
                err.code = data.code;
                throw err;
            }
            if (response.status === 403) {
                const err = new Error(data.error || 'ACCESS_DENIED');
                err.status = 403;
                err.code = data.code;
                throw err;
            }
            if (response.status === 429) {
                const err = new Error(data.error || 'RATE_LIMITED');
                err.status = 429;
                err.code = data.code;
                throw err;
            }
            if (response.status >= 500) {
                const err = new Error(data.error || 'SERVER_ERROR');
                err.status = response.status;
                throw err;
            }
            if (!response.ok) {
                const err = new Error(data.error || 'REQUEST_FAILED');
                err.status = response.status;
                err.code = data.code;
                throw err;
            }
            return data;
        }

        getToken() {
            if (this.token) return this.token;
            try {
                const stored = localStorage.getItem('mx_sess') || sessionStorage.getItem('mx_sess');
                if (stored) {
                    const data = JSON.parse(stored);
                    this.token = data.token || null;
                    this.userId = (data.user && data.user.id) || null;
                    this.username = (data.user && data.user.username) || 'there';
                }
            } catch (e) {}
            return this.token;
        }

        refreshSessionFromStore() {
            try {
                if (typeof window.getUserToken === 'function') {
                    const t = window.getUserToken();
                    if (t) this.token = t;
                }
                if (typeof window.getUser === 'function') {
                    const u = window.getUser();
                    if (u) {
                        this.userId = u.id || this.userId;
                        this.username = u.username || this.username;
                    }
                }
            } catch (e) {}
        }

        handleRequestError(error, context) {
            console.warn(`[MilesWidget] ${context} failed:`, error && error.message);
            if (error && error.message === 'SESSION_EXPIRED') {
                // session.js's userFetch already handles the authoritative
                // auth flow. We just downgrade to guest mode silently.
                this.isAuthenticated = false;
                this.setStatus(STATUS.AVAILABLE, 'online');
                this.stopGlobalPolling();
                this.stopPolling();
                this.showGuestView();
                return 'SESSION_EXPIRED';
            }
            if (error && error.message === 'NETWORK_ERROR') {
                this.addSystemMessage("You appear to be offline. We'll retry once your connection is back.");
                return 'NETWORK_ERROR';
            }
            if (error && error.status === 429) {
                this.addSystemMessage("You're sending messages too quickly. Please wait a moment.");
                return 'RATE_LIMITED';
            }
            if (error && error.status >= 500) {
                this.addSystemMessage('Support is temporarily unavailable. Please try again shortly.');
                return 'SERVER_ERROR';
            }
            this.addSystemMessage(error && error.message && error.message !== 'REQUEST_FAILED' ? error.message : 'Something went wrong. Please try again.');
            return 'UNKNOWN';
        }

        // ─── CONVERSATIONS ───
        async loadConversations() {
            // Hard guard: never fire an authenticated call unless we're
            // truly authenticated AND we're not on an auth page.
            if (this.isAuthPage) return;
            if (!this.isAuthenticated || !this.getToken()) { this.showGuestView(); return; }

            try {
                const [ticketsRes] = await Promise.all([
                    this.request('/tickets?limit=20'),
                    this.refreshUnreadMap()
                ]);
                if (ticketsRes.success && ticketsRes.data) {
                    this.conversations = ticketsRes.data;
                    this.renderConversationList();

                    if (this.conversations.length === 1 && !this.currentConversationId && this.currentTab === 'chats') {
                        this.selectConversation(this.conversations[0].id);
                    }
                }
            } catch (error) {
                this.handleRequestError(error, 'loadConversations');
            }
        }

        async refreshUnreadMap() {
            if (this.isAuthPage) return;
            if (!this.isAuthenticated || !this.getToken()) return;
            try {
                const data = await this.request('/unread');
                if (data.success && data.data) {
                    const map = new Map();
                    (data.data.tickets || []).forEach(t => map.set(t.ticket_id, t.unread_count));
                    this.unreadByTicket = map;

                    const total = data.data.total_unread || 0;
                    if (total > this.previousUnread) this.playNotification();
                    this.previousUnread = total;

                    const show = total > 0 && !this.isOpen;
                    if (this.badge) { this.badge.textContent = String(total); this.badge.classList.toggle('show', show); }
                    if (this.tabBadge) { this.tabBadge.textContent = String(total); this.tabBadge.classList.toggle('show', total > 0); }
                }
            } catch (e) { /* silent */ }
        }

        renderConversationList() {
            if (!this.convItems) return;

            if (this.conversations.length === 0) {
                this.convItems.innerHTML = `
                    <div class="miles-conv-empty">
                        ${icon('chat')}
                        <h4>No conversations</h4>
                        <p>Start a new conversation from the Home tab</p>
                        <button class="btn-primary" id="milesConvEmptyStart" type="button">Start a chat</button>
                    </div>`;
                this.convItems.querySelector('#milesConvEmptyStart')?.addEventListener('click', () => this.requestHumanSupport());
                if (this.convCount) this.convCount.textContent = '0 chats';
                return;
            }

            const sorted = [...this.conversations].sort((a, b) =>
                new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at)
            );

            this.convItems.innerHTML = sorted.map(conv => {
                const isActive = this.currentConversationId === conv.id;
                const unreadCount = this.unreadByTicket.get(conv.id) || 0;
                const timeAgo = getTimeAgo(conv.last_message_at || conv.created_at);
                const initials = (conv.subject || 'Chat').trim().charAt(0).toUpperCase() || '?';
                const categoryLabel = (CATEGORIES.find(c => c.key === conv.category) || {}).label || conv.category || 'General';
                const assignedName = conv.assigned && conv.assigned.username ? conv.assigned.username : null;
                const statusKey = conv.status || 'open';

                return `
                    <button class="miles-conv-item ${isActive ? 'active' : ''} ${unreadCount > 0 ? 'has-unread' : ''}"
                            data-id="${escapeHtml(conv.id)}" role="listitem" aria-current="${isActive}">
                        <div class="avatar">${escapeHtml(initials)}</div>
                        <div class="info">
                            <div class="top">
                                <span class="subject">${escapeHtml(conv.subject || 'Conversation')}</span>
                                <span class="time-ago">${escapeHtml(timeAgo)}</span>
                            </div>
                            <div class="preview">${escapeHtml(categoryLabel)}${assignedName ? ' · ' + escapeHtml(assignedName) : ''}</div>
                            <div class="meta">
                                <span class="status-dot ${escapeHtml(statusKey)}"></span>
                                <span>${escapeHtml(STATUS_LABELS[statusKey] || statusKey)}</span>
                                <span class="ticket-no">· ${escapeHtml(conv.ticket_number || '')}</span>
                            </div>
                        </div>
                        ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount > 99 ? '99+' : unreadCount}</span>` : ''}
                    </button>`;
            }).join('');

            if (this.convCount) this.convCount.textContent = `${this.conversations.length} chat${this.conversations.length === 1 ? '' : 's'}`;

            if (this._lastConvSearch) this.filterConversations(this._lastConvSearch);
        }

        filterConversations(query) {
            if (!this.convItems) return;
            const items = this.convItems.querySelectorAll('.miles-conv-item');
            if (items.length === 0) return;
            items.forEach(item => {
                const text = item.textContent.toLowerCase();
                const match = !query || text.includes(query);
                item.style.display = match ? '' : 'none';
            });
        }

        async selectConversation(convId) {
            if (this.currentConversationId === convId && this.messageView.classList.contains('open')) return;

            this.currentConversationId = convId;
            this.messageView.classList.add('open');
            this._lastFailedSend = null;

            const conv = this.conversations.find(c => c.id === convId);
            this.renderMessageHeader(conv);

            await this.loadMessages(convId, { force: true });
            this.renderConversationList();
            this.startPollingIfNeeded();
            this.markMessagesRead();
        }

        renderMessageHeader(conv) {
            if (!conv) { this.msgSubject.textContent = 'Conversation'; return; }
            this.msgSubject.textContent = conv.subject || 'Conversation';
            const statusKey = conv.status || 'open';
            const statusText = STATUS_LABELS[statusKey] || statusKey;
            const dotClass = statusKey === 'closed' || statusKey === 'resolved' ? statusKey : statusKey;
            this.msgStatus.innerHTML = `<span class="dot ${escapeHtml(dotClass)}"></span> ${escapeHtml(statusText)} <span>· ${escapeHtml(conv.ticket_number || '')}</span>`;

            const isClosed = statusKey === 'closed';
            if (this.closedNote) this.closedNote.style.display = isClosed ? '' : 'none';
            if (this.input) this.input.disabled = isClosed;
            if (this.sendBtn) this.sendBtn.disabled = isClosed;
            if (this.attachBtn) this.attachBtn.style.display = isClosed ? 'none' : '';

            if (this.msgHeaderActions) {
                this.msgHeaderActions.innerHTML = '';
                if (statusKey !== 'closed' && statusKey !== 'resolved') {
                    const closeBtn = document.createElement('button');
                    closeBtn.type = 'button'; closeBtn.textContent = 'Close';
                    closeBtn.addEventListener('click', () => this.closeCurrentTicket());
                    this.msgHeaderActions.appendChild(closeBtn);
                }
            }

            this.renderRatingIfNeeded(conv);
        }

        renderRatingIfNeeded(conv) {
            if (!this.ratingSlot) return;
            if (!conv || (conv.status !== 'resolved' && conv.status !== 'closed')) { this.ratingSlot.innerHTML = ''; return; }
            if (this._ratingSubmittedFor.has(conv.id)) {
                this.ratingSlot.innerHTML = `<div class="miles-rating-box"><span class="miles-rating-done">✓ Thanks for your feedback!</span></div>`;
                return;
            }
            this.ratingSlot.innerHTML = `
                <div class="miles-rating-box">
                    <h5>How was your support experience?</h5>
                    <div class="miles-rating-stars" id="milesRatingStars">
                        ${[1,2,3,4,5].map(n => `<button type="button" data-star="${n}" aria-label="${n} star${n>1?'s':''}">${icon('starOutline')}</button>`).join('')}
                    </div>
                    <textarea id="milesRatingComment" placeholder="Optional comment…" maxlength="500"></textarea>
                    <button class="submit-rating" id="milesRatingSubmit" disabled>Submit feedback</button>
                </div>`;

            let selected = 0;
            const starsWrap = this.ratingSlot.querySelector('#milesRatingStars');
            const submitBtn = this.ratingSlot.querySelector('#milesRatingSubmit');
            const stars = Array.from(starsWrap.querySelectorAll('button'));
            const paint = () => stars.forEach((s, i) => {
                s.classList.toggle('active', i < selected);
                s.innerHTML = i < selected ? icon('star') : icon('starOutline');
            });
            stars.forEach(s => s.addEventListener('click', () => {
                selected = parseInt(s.dataset.star, 10);
                paint();
                submitBtn.disabled = selected === 0;
            }));
            submitBtn.addEventListener('click', async () => {
                if (selected === 0) return;
                submitBtn.disabled = true;
                submitBtn.textContent = 'Submitting…';
                try {
                    const comment = this.ratingSlot.querySelector('#milesRatingComment').value.trim();
                    const res = await this.request(`/tickets/${conv.id}/rating`, {
                        method: 'POST',
                        body: JSON.stringify({ rating: selected, comment: comment || undefined })
                    });
                    if (res.success) {
                        this._ratingSubmittedFor.add(conv.id);
                        this.renderRatingIfNeeded(conv);
                    }
                } catch (err) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Submit feedback';
                    this.handleRequestError(err, 'submitRating');
                }
            });
        }

        async closeCurrentTicket() {
            if (!this.currentConversationId) return;

            const conversation = this.conversations.find(c => c.id === this.currentConversationId);
            if (conversation && conversation.status === 'closed') {
                this.addSystemMessage('This ticket is already closed.');
                return;
            }

            try {
                const data = await this.request(`/tickets/${this.currentConversationId}/close`, { method: 'POST' });
                if (data.success && data.data) {
                    const idx = this.conversations.findIndex(c => c.id === this.currentConversationId);
                    if (idx !== -1) this.conversations[idx] = data.data;
                    this.addSystemMessage('This ticket has been closed.');
                    this.renderMessageHeader(data.data);
                    this.renderConversationList();
                }
            } catch (error) {
                if (error && error.code === 'TICKET_ALREADY_CLOSED') {
                    this.addSystemMessage('This ticket is already closed.');
                    await this.loadConversations();
                } else {
                    this.handleRequestError(error, 'closeCurrentTicket');
                }
            }
        }

        async reopenTicket() {
            if (!this.currentConversationId) return;

            try {
                const data = await this.request(`/tickets/${this.currentConversationId}/reopen`, { method: 'POST' });
                if (data.success && data.data) {
                    const idx = this.conversations.findIndex(c => c.id === this.currentConversationId);
                    if (idx !== -1) this.conversations[idx] = data.data;
                    this.addSystemMessage('This ticket has been reopened.');
                    this.renderMessageHeader(data.data);
                    this.renderConversationList();
                }
            } catch (error) {
                if (error && error.code === 'TICKET_NOT_CLOSED') {
                    this.addSystemMessage('This ticket cannot be reopened because it is not closed or resolved.');
                } else {
                    this.handleRequestError(error, 'reopenTicket');
                }
            }
        }

        closeMessageView() {
            this.messageView.classList.remove('open');
            this.currentConversationId = null;
            this.stopPolling();
            this.renderConversationList();
        }

        async loadMessages(ticketId, { force = false } = {}) {
            if (!ticketId) return;
            if (this._isLoadingMessages && !force) return;

            const cacheKey = `conv_${ticketId}`;
            if (!force && this._currentConvMessages.has(cacheKey)) {
                this.messages = this._currentConvMessages.get(cacheKey);
                this.renderMessages();
                return;
            }

            this._isLoadingMessages = true;
            if (force) this.messageList.innerHTML = `<div class="miles-msg-empty">${icon('chat')}<p>Loading messages…</p></div>`;

            try {
                const data = await this.request(`/tickets/${ticketId}?messages_limit=50`);
                if (data.success && data.data && data.data.messages) {
                    const incoming = data.data.messages
                        .filter(m => m.is_internal !== true)
                        .map(m => ({ ...m, sender_type: m.sender_type === 'admin' ? 'support' : m.sender_type }));

                    this._currentConvMessages.set(cacheKey, incoming);
                    this.messages = incoming;
                    incoming.forEach(m => this.knownMessageIds.add(m.id));
                    this.renderMessages();
                }
            } catch (error) {
                this.messageList.innerHTML = `
                    <div class="miles-msg-empty">
                        ${icon('info')}
                        <p>Unable to load this conversation.</p>
                        <button class="btn-primary" id="milesMsgRetry" type="button">Retry</button>
                    </div>`;
                this.messageList.querySelector('#milesMsgRetry')?.addEventListener('click', () => this.loadMessages(ticketId, { force: true }));
                this.handleRequestError(error, 'loadMessages');
            } finally {
                this._isLoadingMessages = false;
            }
        }

        renderMessages() {
            if (!this.messageList) return;
            if (this.messages.length === 0) {
                this.messageList.innerHTML = `
                    <div class="miles-msg-empty">
                        ${icon('chat')}
                        <p>No messages yet</p>
                        <p style="font-size:12px;color:var(--miles-text-dim);">Send a message to start the conversation</p>
                    </div>`;
                return;
            }

            let lastDate = null;
            const parts = [];

            this.messages.forEach(msg => {
                if (msg.created_at) {
                    if (!lastDate || !isSameDay(lastDate, msg.created_at)) {
                        parts.push(`<div class="miles-date-sep">${escapeHtml(formatDateSep(msg.created_at))}</div>`);
                        lastDate = msg.created_at;
                    }
                }

                const cls = msg.sender_type === 'user' ? 'user' : (msg.sender_type === 'system' ? 'system' : 'support');
                const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                let attachmentHtml = '';

                if (msg.attachments && msg.attachments.length > 0) {
                    attachmentHtml = msg.attachments.map(att => {
                        const mime = attMime(att);
                        const isImage = mime.startsWith('image/');
                        const iconName = getFileIcon(mime);
                        const url = safeUrl(att.url);
                        if (isImage && url) {
                            return `<div class="miles-attachment" data-att-url="${escapeHtml(url)}" data-att-name="${escapeHtml(att.name || 'image')}" tabindex="0" role="button" aria-label="View image ${escapeHtml(att.name || '')}">
                                <img src="${escapeHtml(url)}" alt="${escapeHtml(att.name || 'Image attachment')}" loading="lazy" />
                                <div class="attachment-info">
                                    ${icon(iconName)}
                                    <span class="name">${escapeHtml(att.name || 'image')}</span>
                                    <span class="size">${formatFileSize(att.size)}</span>
                                </div>
                            </div>`;
                        }
                        return `<div class="miles-attachment">
                            <div class="attachment-info">
                                ${icon(iconName)}
                                <span class="name">${escapeHtml(att.name || 'file')}</span>
                                <span class="size">${formatFileSize(att.size)}</span>
                                ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--miles-primary);text-decoration:none;font-weight:700;">Open</a>` : '<span>Not available</span>'}
                            </div>
                        </div>`;
                    }).join('');
                }

                const failed = msg._failed ? ' failed' : '';
                const retryHtml = msg._failed ? `<button class="retry-btn" data-retry-id="${escapeHtml(msg.id)}" type="button">Retry send</button>` : '';

                parts.push(`<div class="miles-msg ${cls}${failed}">
                    ${this.formatMessage(msg.message)}
                    ${attachmentHtml}
                    <div class="time">${escapeHtml(time)}${msg._failed ? ' · Failed' : ''}</div>
                    ${retryHtml}
                </div>`);
            });

            this.messageList.innerHTML = parts.join('');

            this.messageList.querySelectorAll('.miles-attachment[data-att-url]').forEach(el => {
                const open = () => this.openLightbox(el.dataset.attUrl, el.dataset.attName);
                el.addEventListener('click', open);
                el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
            });
            this.messageList.querySelectorAll('.retry-btn').forEach(btn => {
                btn.addEventListener('click', () => this.retryFailedMessage(btn.dataset.retryId));
            });

            this.scrollToBottom();
        }

        formatMessage(message) {
            const escaped = escapeHtml(message);
            return escaped
                .replace(/\n/g, '<br>')
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/(^|[^*])\*(?!\*)(.*?)\*(?!\*)/g, '$1<em>$2</em>');
        }

        scrollToBottom() {
            if (!this.messageList) return;
            requestAnimationFrame(() => { this.messageList.scrollTop = this.messageList.scrollHeight; });
        }

        openLightbox(url, name) {
            if (!this.lightbox || !url) return;
            this.lightboxImg.src = url;
            this.lightboxImg.alt = name || 'Image attachment';
            this.lightboxOpen.href = url;
            this.lightbox.classList.add('open');
            this._lightboxTrigger = document.activeElement;
            this.lightboxClose.focus();
        }

        closeLightbox() {
            if (!this.lightbox) return;
            this.lightbox.classList.remove('open');
            this.lightboxImg.src = '';
            if (this._lightboxTrigger && this._lightboxTrigger.focus) this._lightboxTrigger.focus();
        }

        async sendMessage() {
            if (!this.isAuthenticated || !this.getToken()) {
                // On auth pages or when not signed in, fall back to the
                // guest contact form instead of erroring.
                const draft = this.input ? this.input.value.trim() : '';
                this.openGuestForm();
                if (draft) {
                    const msgEl = this.messageList.querySelector('#milesGuestMessage');
                    if (msgEl) msgEl.value = draft;
                    if (this.input) this.input.value = '';
                }
                return;
            }
            if (!this.currentConversationId) {
                const draft = this.input.value.trim();
                this.openNewTicketModal(draft ? { message: draft } : {});
                return;
            }

            const message = this.input.value.trim();
            if (!message && this.pendingFiles.length === 0) return;
            if (this.isProcessing) return;

            if (message.length > CONFIG.MAX_MESSAGE_LENGTH) {
                this.setSendStatus(STATUS.FAILED, true);
                this.addSystemMessage(`Message is too long (max ${CONFIG.MAX_MESSAGE_LENGTH} characters).`);
                return;
            }

            const ticketId = this.currentConversationId;
            this.isProcessing = true;
            const msgText = message || '📎 Attachment';
            const filesToSend = this.pendingFiles;
            this.input.value = '';
            this.input.style.height = 'auto';
            this.input.disabled = true;
            if (this.sendBtn) this.sendBtn.disabled = true;
            this.setSendStatus(STATUS.SENDING);

            const localId = `local-${Date.now()}`;
            const localMsg = {
                id: localId,
                sender_type: 'user',
                message: msgText,
                created_at: new Date().toISOString(),
                attachments: filesToSend.map(f => ({ name: f.name, size: f.size, mime: f.type }))
            };
            this.addMessage(localMsg, { silent: true });

            try {
                const formData = new FormData();
                formData.append('message', msgText);
                filesToSend.forEach(file => formData.append('attachments', file));

                const token = this.getToken();
                const response = await fetch(`${this.apiUrl}/tickets/${ticketId}/messages`, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token },
                    body: formData
                });

                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    const err = new Error(data.error || 'Failed to send');
                    err.status = response.status;
                    err.code = data.code;
                    throw err;
                }

                this.pendingFiles.forEach(f => { if (f._previewUrl) URL.revokeObjectURL(f._previewUrl); });
                this.pendingFiles = [];
                this.renderFilePreview();
                this.setSendStatus(STATUS.SENT);
                this.setStatus(STATUS.WAITING, 'waiting');
                this.startPollingIfNeeded();

                this._currentConvMessages.delete(`conv_${ticketId}`);
                await this.loadMessages(ticketId, { force: true });
                await this.loadConversations();

            } catch (error) {
                const idx = this.messages.findIndex(m => m.id === localId);
                if (idx !== -1) this.messages[idx]._failed = true;
                this._lastFailedSend = { ticketId, message: msgText, files: filesToSend, localId };
                this.renderMessages();
                this.setSendStatus(STATUS.FAILED, true);
                this.handleRequestError(error, 'sendMessage');
            }

            this.isProcessing = false;
            this.input.disabled = false;
            if (this.sendBtn) this.sendBtn.disabled = false;
            this.input.focus();
            this.scrollToBottom();
        }

        async retryFailedMessage(localId) {
            if (!this._lastFailedSend || this._lastFailedSend.localId !== localId) return;
            const { ticketId, message, files } = this._lastFailedSend;
            const idx = this.messages.findIndex(m => m.id === localId);
            if (idx !== -1) this.messages.splice(idx, 1);
            this.pendingFiles = files;
            this.input.value = message === '📎 Attachment' ? '' : message;
            await this.sendMessage();
        }

        setSendStatus(text, isError) {
            if (!this.sendStatus) return;
            this.sendStatus.textContent = text;
            this.sendStatus.classList.toggle('error', !!isError);
        }

        addMessage(msg, opts) {
            this.messages.push(msg);
            if (msg.id) this.knownMessageIds.add(msg.id);
            this.renderMessages();
            if (!(opts && opts.silent)) this.updateUnreadCount();
        }

        addSystemMessage(message) {
            this.addMessage({ id: `sys-${Date.now()}`, sender_type: 'system', message, created_at: new Date().toISOString() }, { silent: true });
        }

        async createTicket({ subject, description, category, reference }) {
            const body = {
                subject: subject,
                description: description,
                category: category || 'other',
                priority: 'medium'
            };
            if (reference) body.related_reference = reference;

            const data = await this.request('/tickets', { method: 'POST', body: JSON.stringify(body) });
            if (data.success) return data.data;
            throw new Error(data.error || 'Failed to create ticket');
        }

        openNewTicketModal(prefill) {
            // If not authenticated (e.g. on login page), use the guest form.
            if (!this.isAuthenticated || !this.getToken()) { this.openGuestForm(); return; }
            if (!this.modalOverlay) return;

            prefill = prefill || {};
            this._modalTriggerEl = document.activeElement;

            this.modalContent.innerHTML = `
                <form id="milesTicketForm" novalidate>
                    <div class="miles-modal-body">
                        <div>
                            <label for="milesTicketCategory">Category</label>
                            <select id="milesTicketCategory" name="category">
                                ${CATEGORIES.map(c => `<option value="${c.key}" ${c.key === prefill.category ? 'selected' : ''}>${c.label}</option>`).join('')}
                            </select>
                        </div>
                        <div>
                            <label for="milesTicketSubject">Subject</label>
                            <input id="milesTicketSubject" name="subject" type="text" maxlength="${CONFIG.MAX_SUBJECT_LENGTH}" required
                                   value="${escapeHtml(prefill.subject || '')}" placeholder="Briefly describe your issue">
                            <div class="miles-modal-field-error" id="milesTicketSubjectError">Subject is required.</div>
                        </div>
                        <div>
                            <label for="milesTicketMessage">Message</label>
                            <textarea id="milesTicketMessage" name="message" maxlength="${CONFIG.MAX_MESSAGE_LENGTH}" required placeholder="Tell us what's going on">${escapeHtml(prefill.message || '')}</textarea>
                            <div class="miles-modal-field-error" id="milesTicketMessageError">Please describe your issue.</div>
                        </div>
                        <div>
                            <label for="milesTicketReference">Related reference <span style="text-transform:none;font-weight:400;">(optional)</span></label>
                            <input id="milesTicketReference" name="reference" type="text" maxlength="50" placeholder="Transaction/order reference, if any">
                        </div>
                        <div class="miles-modal-error" id="milesTicketFormError" role="alert"></div>
                    </div>
                    <div class="miles-modal-foot">
                        <button class="submit-ticket-btn" type="submit" id="milesTicketSubmitBtn">Create ticket</button>
                    </div>
                </form>`;

            this.ticketForm = this.modalContent.querySelector('#milesTicketForm');
            this.ticketSubmitBtn = this.modalContent.querySelector('#milesTicketSubmitBtn');
            this.ticketForm.addEventListener('submit', (e) => this.submitNewTicketForm(e));

            this.modalOverlay.classList.add('open');
            requestAnimationFrame(() => {
                const subjectEl = this.modalContent.querySelector('#milesTicketSubject');
                if (subjectEl) subjectEl.focus();
            });
        }

        closeNewTicketModal() {
            if (!this.modalOverlay) return;
            this.modalOverlay.classList.remove('open');
            if (this._modalTriggerEl && this._modalTriggerEl.focus) this._modalTriggerEl.focus();
        }

        async submitNewTicketForm(e) {
            e.preventDefault();
            const form = e.target;
            const subjectEl = form.querySelector('#milesTicketSubject');
            const messageEl = form.querySelector('#milesTicketMessage');
            const categoryEl = form.querySelector('#milesTicketCategory');
            const referenceEl = form.querySelector('#milesTicketReference');
            const subjectError = form.querySelector('#milesTicketSubjectError');
            const messageError = form.querySelector('#milesTicketMessageError');
            const formError = form.querySelector('#milesTicketFormError');
            const submitBtn = form.querySelector('#milesTicketSubmitBtn');

            const subject = subjectEl.value.trim();
            const message = messageEl.value.trim();

            subjectError.classList.toggle('show', !subject);
            messageError.classList.toggle('show', !message);
            formError.textContent = '';
            if (!subject || !message) return;

            if (this.isProcessing) return;
            this.isProcessing = true;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Creating…';

            try {
                const ticket = await this.createTicket({
                    subject,
                    description: message,
                    category: categoryEl.value,
                    reference: referenceEl.value.trim()
                });

                this.modalContent.innerHTML = `
                    <div class="miles-modal-success">
                        ${icon('info')}
                        <h5>Ticket ${escapeHtml(ticket.ticket_number)} created</h5>
                        <p>We'll respond in your conversation shortly.</p>
                    </div>`;

                this.conversations.unshift(ticket);
                this.renderConversationList();

                setTimeout(() => {
                    this.closeNewTicketModal();
                    this.switchTab('chats');
                    this.selectConversation(ticket.id);
                }, 900);

            } catch (error) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create ticket';
                if (error && error.code === 'ACTIVE_TICKET_LIMIT') {
                    formError.textContent = error.message;
                } else if (error && error.message === 'SESSION_EXPIRED') {
                    formError.textContent = 'Your session has expired. Please sign in again.';
                } else {
                    formError.textContent = (error && error.message) || 'Could not create ticket. Please try again.';
                }
            } finally {
                this.isProcessing = false;
            }
        }

        updateUnreadCount() {
            this.refreshUnreadMap();
        }

        markMessagesRead() {
            if (this.isAuthPage) return;
            if (!this.currentConversationId) return;
            const unread = this.messages.filter(m => m.sender_type === 'support' && !m.read_by_user_at);
            if (unread.length > 0) {
                unread.forEach(m => { m.read_by_user_at = new Date().toISOString(); });
                this.renderMessages();
            }
            this.unreadByTicket.set(this.currentConversationId, 0);
            this.renderConversationList();
            this.request(`/tickets/${this.currentConversationId}/read`, { method: 'POST' })
                .then(() => this.refreshUnreadMap())
                .catch(() => {});
        }

        readMutePref() {
            try { return localStorage.getItem(CONFIG.STORAGE_PREFIX + 'muted') === '1'; } catch (e) { return false; }
        }

        toggleMute() {
            this.muted = !this.muted;
            try { localStorage.setItem(CONFIG.STORAGE_PREFIX + 'muted', this.muted ? '1' : '0'); } catch (e) {}
            this.applyMuteUI();
        }

        applyMuteUI() {
            if (!this.muteBtn) return;
            this.muteBtn.innerHTML = this.muted ? icon('bellOff') : icon('bell');
            this.muteBtn.setAttribute('aria-pressed', String(this.muted));
            this.muteBtn.title = this.muted ? 'Unmute notification sound' : 'Mute notification sound';
        }

        playNotification() {
            if (this.muted || !this.hasUserInteracted) return;
            try {
                if (!this.audioCtx) {
                    const Ctx = window.AudioContext || window.webkitAudioContext;
                    if (!Ctx) return;
                    this.audioCtx = new Ctx();
                }
                if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
                const ctx = this.audioCtx;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine'; osc.frequency.value = 720;
                gain.gain.setValueAtTime(0.0001, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
                osc.connect(gain).connect(ctx.destination);
                osc.start(); osc.stop(ctx.currentTime + 0.3);
            } catch (e) {}
        }

        startGlobalPolling() {
            if (this.isAuthPage) return;
            if (this.globalPollTimer) return;
            this.globalPollTimer = setInterval(() => {
                if (!this.isAuthenticated || !this.getToken()) return;
                this.refreshSessionFromStore();
                if (this.isAuthenticated) this.loadConversations();
            }, CONFIG.GLOBAL_POLL_INTERVAL);
        }

        stopGlobalPolling() {
            if (this.globalPollTimer) { clearInterval(this.globalPollTimer); this.globalPollTimer = null; }
        }

        startPollingIfNeeded() {
            if (this.isAuthPage) return;
            if (!this.isOpen || this.currentTab !== 'chats' || !this.currentConversationId) return;
            if (this.pollTimer) return;
            this.pollTimer = setInterval(() => this.pollMessages(), CONFIG.POLL_INTERVAL);
        }

        stopPolling() {
            if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
            if (this.pollAbortController) { this.pollAbortController.abort(); this.pollAbortController = null; }
            this.pollInFlight = false;
        }

        async pollMessages() {
            if (!this.currentConversationId || this.pollInFlight) return;
            if (!this.isOpen || this.currentTab !== 'chats') { this.stopPolling(); return; }

            this.pollInFlight = true;
            this.pollAbortController = new AbortController();
            try {
                const data = await this.request(`/tickets/${this.currentConversationId}?messages_limit=50`, { signal: this.pollAbortController.signal });
                if (data.success && data.data && data.data.messages) {
                    const fresh = data.data.messages.filter(m => !this.knownMessageIds.has(m.id) && m.is_internal !== true);
                    if (fresh.length > 0) {
                        let sawNewSupportMsg = false;
                        fresh.forEach(m => {
                            const mapped = { ...m, sender_type: m.sender_type === 'admin' ? 'support' : m.sender_type };
                            this.knownMessageIds.add(m.id);
                            this.messages.push(mapped);
                            if (mapped.sender_type === 'support') sawNewSupportMsg = true;
                        });
                        this.renderMessages();
                        this.hideTyping();
                        if (sawNewSupportMsg) {
                            this.playNotification();
                            this.setStatus(STATUS.AGENT_ONLINE, 'online');
                            this.markMessagesRead();
                        }
                    }
                    const idx = this.conversations.findIndex(c => c.id === this.currentConversationId);
                    if (idx !== -1 && data.data.status !== this.conversations[idx].status) {
                        this.conversations[idx] = { ...this.conversations[idx], status: data.data.status, assigned_to: data.data.assigned_to, assigned: data.data.assigned };
                        this.renderMessageHeader(this.conversations[idx]);
                        this.renderConversationList();
                    }
                }
            } catch (error) {
                if (error && error.name === 'AbortError') { /* expected */ }
                else console.warn('[MilesWidget] poll failed', error && error.message);
            } finally {
                this.pollInFlight = false;
            }
        }

        hideTyping() {
            if (this.typingIndicator) this.typingIndicator.classList.remove('active');
        }

        // ─── Human support entry point ───
        // Authenticated users get a ticket; guests (including on the login
        // page) get the guest form.
        requestHumanSupport() {
            if (this.isAuthenticated && !this.isAuthPage) {
                if (this.currentConversationId) {
                    this.switchTab('chats');
                    this.input?.focus();
                } else {
                    this.openNewTicketModal();
                }
                return;
            }
            this.openGuestForm();
        }

        openGuestForm() {
            this.switchTab('chats');
            if (!this.messageList || !this.messageView) return;
            this.messageView.classList.add('open');
            this.messageList.innerHTML = guestFormMarkup();
            const form = this.messageList.querySelector('#milesGuestForm');
            if (form) form.addEventListener('submit', (e) => this.submitGuestForm(e));
        }

        async submitGuestForm(e) {
            e.preventDefault();
            const form = e.target;
            const errorEl = form.querySelector('#milesGuestFormError');
            const submitBtn = form.querySelector('#milesGuestSubmit');
            errorEl.textContent = '';

            const name = form.name.value.trim();
            const email = form.email.value.trim();
            const category = form.category.value;
            const subject = form.subject.value.trim();
            const message = form.message.value.trim();

            const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
            if (!name || !emailOk || !subject || !message) {
                errorEl.textContent = 'Please fill in all fields with a valid email address.';
                return;
            }
            if (message.length > CONFIG.MAX_MESSAGE_LENGTH) {
                errorEl.textContent = `Message is too long (max ${CONFIG.MAX_MESSAGE_LENGTH} characters).`;
                return;
            }
            if (this.isProcessing) return;
            this.isProcessing = true;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Sending…';

            try {
                const res = await fetch(`${this.apiUrl}/public/tickets`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, email, category, subject, message })
                });
                const data = await res.json().catch(() => ({}));
                if (res.status === 429) {
                    errorEl.textContent = 'Too many requests. Please wait a moment.';
                    submitBtn.disabled = false; submitBtn.textContent = 'Send to support';
                    this.isProcessing = false;
                    return;
                }
                if (!res.ok || !data.success) {
                    errorEl.textContent = data.error || 'Could not send your request.';
                    submitBtn.disabled = false; submitBtn.textContent = 'Send to support';
                    this.isProcessing = false;
                    return;
                }
                this.messageList.innerHTML = `
                    <div class="miles-msg-empty">
                        ${icon('info')}
                        <h4>Request received</h4>
                        <p>Ticket #${escapeHtml(data.data.ticket_number)} was created. We'll reply to ${escapeHtml(email)}.</p>
                    </div>`;
            } catch (networkErr) {
                errorEl.textContent = 'Network error. Please check your connection.';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Send to support';
            }
            this.isProcessing = false;
        }

        toggle() { this.isOpen ? this.close() : this.open(); }

        open() {
            this.isOpen = true;
            if (this.panel) { this.panel.classList.add('open'); this.panel.setAttribute('aria-hidden', 'false'); }
            if (this.launcher) this.launcher.setAttribute('aria-expanded', 'true');
            if (this.badge) this.badge.classList.remove('show');

            // Refresh session snapshot on open.
            if (!this.isAuthPage) {
                this.refreshSessionFromStore();
                if (!this.isAuthenticated && typeof window.getUserToken === 'function') {
                    this.getUserData();
                }
            }

            if (this.currentConversationId && this.isAuthenticated && !this.isAuthPage) {
                this.markMessagesRead();
                this.loadMessages(this.currentConversationId);
            }
            if (this.isAuthenticated && !this.isAuthPage) {
                this.loadConversations();
            } else {
                this.showGuestView();
            }
            requestAnimationFrame(() => { if (this.currentTab === 'chats' && this.input && !this.input.disabled) this.input.focus(); });
            this.startPollingIfNeeded();
            this.startGlobalPolling();
        }

        close() {
            this.isOpen = false;
            if (this.panel) { this.panel.classList.remove('open'); this.panel.setAttribute('aria-hidden', 'true'); }
            if (this.launcher) { this.launcher.setAttribute('aria-expanded', 'false'); this.launcher.focus(); }
            this.stopPolling();
        }

        minimize() {
            if (!this.panel) return;
            const minimized = this.panel.classList.toggle('minimized');
            if (minimized) {
                this.panel.style.height = '60px';
                this.panel.querySelector('.miles-content').style.display = 'none';
                this.panel.querySelector('.miles-tabs').style.display = 'none';
                this.stopPolling();
            } else {
                this.panel.style.height = '';
                this.panel.querySelector('.miles-content').style.display = '';
                this.panel.querySelector('.miles-tabs').style.display = '';
                this.startPollingIfNeeded();
            }
        }

        switchTab(tabName) {
            this.currentTab = tabName;

            this.root.querySelectorAll('.miles-tabs .tab').forEach(tab => {
                const active = tab.dataset.tab === tabName;
                tab.classList.toggle('active', active);
                tab.setAttribute('aria-selected', String(active));
            });
            this.root.querySelectorAll('.miles-tab-content').forEach(content => {
                content.classList.toggle('active', content.id === `tab-${tabName}`);
            });

            if (tabName === 'chats') {
                if (this.isAuthenticated && !this.isAuthPage) this.loadConversations();
                if (this.currentConversationId && this.isAuthenticated && !this.isAuthPage) {
                    this.loadMessages(this.currentConversationId);
                    this.markMessagesRead();
                }
                this.startPollingIfNeeded();
            } else {
                this.stopPolling();
            }

            this.scrollToBottom();
        }

        destroy() {
            this.stopPolling();
            this.stopGlobalPolling();
            document.removeEventListener('keydown', this._boundGlobalKeydown);
            window.removeEventListener('resize', this._boundResize);
            window.removeEventListener('orientationchange', this._boundResize);
            window.removeEventListener('storage', this._boundStorage);
            clearTimeout(this._resizeTimer);
            this.pendingFiles.forEach(f => { if (f._previewUrl) URL.revokeObjectURL(f._previewUrl); });
            if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
            const styleEl = document.getElementById('miles-widget-styles');
            if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
            window.__MILES_WIDGET_BOOTED__ = false;
            window.MilesWidget = null;
        }
    }

    // ─── BOOT ───
    function initMilesWidget() {
        if (window.MilesWidget instanceof MilesWidget) return;
        try {
            window.MilesWidget = new MilesWidget({ apiUrl: CONFIG.API_URL });
        } catch (err) {
            console.error('[MilesWidget] failed to initialize:', err);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMilesWidget, { once: true });
    } else {
        initMilesWidget();
    }
})();