/*!
 * Miles AI — MilesSpace Support Widget
 * ------------------------------------
 * Fully responsive - works on all devices
 * Auto-detects user session
 * One file, drop-in anywhere
 */

(function() {
    'use strict';

    // ─── CONFIGURATION ───
    const CONFIG = {
        API_URL: '/api/support',
        WIDGET_ID: 'miles-widget-root',
        LAUNCHER_ID: 'miles-launcher',
        PANEL_ID: 'miles-panel',
        DEFAULT_USERNAME: 'there',
        MAX_HISTORY: 50,
        POLL_INTERVAL: 5000,
        TYPING_DELAY: 800,
        MOBILE_BREAKPOINT: 480,
        TABLET_BREAKPOINT: 768
    };

    // ─── STYLES ───
    const styles = `
        /* ─── ROOT ─── */
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
            --miles-border: rgba(12, 61, 74, 0.08);
            --miles-success: #16a34a;
            --miles-danger: #dc2626;
            --miles-warning: #f59e0b;
            --miles-shadow: 0 8px 32px rgba(8, 42, 51, 0.16);
            --miles-radius: 16px;
            --miles-transition: 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            position: relative;
            z-index: 99999;
        }

        /* ─── LAUNCHER BUTTON ─── */
        #miles-launcher {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--miles-primary), var(--miles-primary-light));
            color: #fff;
            border: none;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(12, 61, 74, 0.35);
            transition: transform var(--miles-transition), box-shadow var(--miles-transition);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            z-index: 99999;
            position: fixed;
            padding: 0;
            overflow: hidden;
        }

        #miles-launcher img {
            width: 32px;
            height: 32px;
            object-fit: contain;
            border-radius: 4px;
        }

        #miles-launcher:hover {
            transform: scale(1.05);
            box-shadow: 0 6px 28px rgba(12, 61, 74, 0.45);
        }

        #miles-launcher .label {
            position: absolute;
            right: 72px;
            background: var(--miles-primary);
            color: #fff;
            padding: 6px 14px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            white-space: nowrap;
            opacity: 0;
            transform: translateX(8px);
            transition: all var(--miles-transition);
            pointer-events: none;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }

        #miles-launcher:hover .label {
            opacity: 1;
            transform: translateX(0);
        }

        #miles-launcher .badge {
            position: absolute;
            top: -4px;
            right: -4px;
            background: var(--miles-danger);
            color: #fff;
            font-size: 11px;
            font-weight: 700;
            min-width: 22px;
            height: 22px;
            border-radius: 99px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0 6px;
            border: 2px solid #fff;
            animation: milesBadgePop 0.3s ease;
        }

        .miles-pulse {
            animation: milesPulse 2s ease-in-out infinite;
        }

        @keyframes milesPulse {
            0%, 100% { box-shadow: 0 4px 20px rgba(12, 61, 74, 0.35); }
            50% { box-shadow: 0 4px 30px rgba(12, 61, 74, 0.55); }
        }

        @keyframes milesBadgePop {
            0% { transform: scale(0); }
            60% { transform: scale(1.3); }
            100% { transform: scale(1); }
        }

        /* ─── PANEL ─── */
        #miles-panel {
            position: fixed;
            bottom: 96px;
            right: 24px;
            width: 420px;
            height: 600px;
            max-height: calc(100vh - 130px);
            background: var(--miles-white);
            border-radius: var(--miles-radius);
            box-shadow: var(--miles-shadow);
            display: none;
            flex-direction: column;
            overflow: hidden;
            border: 1px solid var(--miles-border);
            animation: milesSlideUp 0.35s cubic-bezier(0.4, 0, 0.2, 1);
            transition: width 0.3s ease, height 0.3s ease, right 0.3s ease, bottom 0.3s ease;
        }

        #miles-panel.open {
            display: flex;
        }

        @keyframes milesSlideUp {
            from {
                opacity: 0;
                transform: translateY(20px) scale(0.96);
            }
            to {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
        }

        /* ─── MOBILE RESPONSIVE ─── */
        @media (max-width: 520px) {
            #miles-launcher {
                bottom: 16px;
                right: 16px;
                width: 56px;
                height: 56px;
            }

            #miles-launcher img {
                width: 28px;
                height: 28px;
            }

            #miles-launcher .label {
                display: none;
            }

            #miles-panel {
                position: fixed;
                inset: 0;
                width: 100% !important;
                height: 100% !important;
                max-height: 100vh !important;
                border-radius: 0 !important;
                bottom: 0 !important;
                right: 0 !important;
                animation: milesSlideUpMobile 0.35s cubic-bezier(0.4, 0, 0.2, 1);
            }

            @keyframes milesSlideUpMobile {
                from {
                    opacity: 0;
                    transform: translateY(30px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }

            .miles-tabs .tab {
                padding: 12px 8px;
                font-size: 11px;
                flex: 1;
                justify-content: center;
            }

            .miles-tabs .tab span {
                display: none;
            }

            .miles-input-area {
                padding: 10px 12px;
            }

            .miles-input-area textarea {
                font-size: 16px !important;
                min-height: 44px;
                padding: 10px 12px;
            }

            .miles-suggestions {
                grid-template-columns: 1fr 1fr;
                gap: 6px;
            }

            .miles-suggestion {
                padding: 10px 8px;
                font-size: 12px;
            }

            .miles-header {
                padding: 12px 16px;
            }

            .miles-header-left .info h3 {
                font-size: 15px;
            }

            .miles-tab-content {
                padding: 12px 14px;
            }

            .miles-msg {
                font-size: 14px;
                padding: 10px 12px;
                max-width: 88%;
            }

            .miles-snapshot {
                padding: 6px 12px;
                font-size: 10px;
            }
        }

        @media (min-width: 521px) and (max-width: 768px) {
            #miles-panel {
                width: 380px;
                right: 16px;
                bottom: 88px;
                height: 520px;
            }

            #miles-launcher {
                bottom: 20px;
                right: 20px;
                width: 56px;
                height: 56px;
            }

            #miles-launcher img {
                width: 28px;
                height: 28px;
            }

            .miles-suggestions {
                grid-template-columns: 1fr 1fr;
                gap: 8px;
            }
        }

        @media (max-width: 380px) {
            .miles-suggestions {
                grid-template-columns: 1fr 1fr;
                gap: 4px;
            }

            .miles-suggestion {
                padding: 8px 6px;
                font-size: 11px;
            }

            .miles-msg {
                font-size: 13px;
                padding: 8px 10px;
                max-width: 90%;
            }
        }

        /* ─── HEADER ─── */
        .miles-header {
            padding: 16px 20px;
            background: linear-gradient(135deg, var(--miles-primary), var(--miles-primary-light));
            color: #fff;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 68px;
        }

        .miles-header-left {
            display: flex;
            align-items: center;
            gap: 12px;
            flex: 1;
            min-width: 0;
        }

        .miles-header-left .logo {
            width: 36px;
            height: 36px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.15);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            padding: 4px;
        }

        .miles-header-left .logo img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            border-radius: 4px;
        }

        .miles-header-left .info {
            flex: 1;
            min-width: 0;
        }

        .miles-header-left .info h3 {
            font-size: 16px;
            font-weight: 700;
            margin: 0;
            white-space: nowrap;
        }

        .miles-header-left .info .status {
            font-size: 11px;
            opacity: 0.8;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .miles-header-left .info .status .dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            display: inline-block;
            background: #22c55e;
            animation: milesDotPulse 1.5s infinite;
        }

        @keyframes milesDotPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .miles-header-actions {
            display: flex;
            gap: 6px;
            flex-shrink: 0;
        }

        .miles-header-actions button {
            width: 32px;
            height: 32px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.1);
            border: none;
            color: #fff;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .miles-header-actions button:hover {
            background: rgba(255, 255, 255, 0.2);
        }

        /* ─── SNAPSHOT ─── */
        .miles-snapshot {
            display: flex;
            justify-content: space-around;
            padding: 6px 16px;
            background: rgba(255,255,255,0.05);
            border-top: 1px solid rgba(255,255,255,0.08);
            font-size: 10px;
            color: rgba(255,255,255,0.7);
            flex-shrink: 0;
        }

        .miles-snapshot .snapshot-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 1px;
        }

        .miles-snapshot .snapshot-label {
            font-size: 8px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            opacity: 0.6;
        }

        .miles-snapshot .snapshot-value {
            font-weight: 600;
            font-size: 11px;
            color: #fff;
        }

        /* ─── TABS ─── */
        .miles-tabs {
            display: flex;
            border-bottom: 1px solid var(--miles-border);
            background: var(--miles-bg);
            flex-shrink: 0;
            padding: 0 12px;
            min-height: 48px;
        }

        .miles-tabs .tab {
            padding: 10px 16px;
            font-size: 13px;
            font-weight: 600;
            color: var(--miles-text-dim);
            cursor: pointer;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
            background: none;
            border-top: none;
            border-left: none;
            border-right: none;
            font-family: inherit;
            display: flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
        }

        .miles-tabs .tab:hover {
            color: var(--miles-primary);
        }

        .miles-tabs .tab.active {
            color: var(--miles-primary);
            border-bottom-color: var(--miles-primary);
        }

        .miles-tabs .tab .tab-badge {
            background: var(--miles-danger);
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            padding: 1px 7px;
            border-radius: 99px;
            min-width: 18px;
            text-align: center;
        }

        /* ─── CONTENT ─── */
        .miles-content {
            flex: 1;
            overflow: hidden;
            position: relative;
            background: var(--miles-bg);
        }

        .miles-tab-content {
            display: none;
            height: 100%;
            overflow-y: auto;
            padding: 16px 20px;
            background: var(--miles-bg);
            -webkit-overflow-scrolling: touch;
        }

        .miles-tab-content.active {
            display: block;
        }

        .miles-tab-content::-webkit-scrollbar {
            width: 6px;
        }

        .miles-tab-content::-webkit-scrollbar-thumb {
            background: #d1d9e0;
            border-radius: 99px;
        }

        /* ─── HOME TAB ─── */
        .miles-welcome {
            text-align: center;
            padding: 8px 0 16px;
        }

        .miles-welcome .greeting {
            font-size: 20px;
            font-weight: 700;
            color: var(--miles-text);
            margin-bottom: 4px;
        }

        .miles-welcome .sub {
            font-size: 14px;
            color: var(--miles-text-dim);
        }

        .miles-suggestions {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            margin-top: 16px;
        }

        .miles-suggestion {
            padding: 12px 14px;
            background: var(--miles-white);
            border: 1px solid var(--miles-border);
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s;
            text-align: center;
            font-size: 13px;
            font-weight: 500;
            color: var(--miles-text);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            font-family: inherit;
            -webkit-tap-highlight-color: transparent;
            touch-action: manipulation;
        }

        .miles-suggestion:active {
            transform: scale(0.96);
        }

        .miles-suggestion:hover {
            border-color: var(--miles-primary);
            background: #f0f7fa;
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
        }

        .miles-suggestion .icon {
            font-size: 16px;
        }

        /* ─── MESSAGES TAB ─── */
        .miles-messages {
            display: flex;
            flex-direction: column;
            height: 100%;
        }

        .miles-message-list {
            flex: 1;
            overflow-y: auto;
            padding: 4px 0;
            display: flex;
            flex-direction: column;
            gap: 8px;
            -webkit-overflow-scrolling: touch;
        }

        .miles-msg {
            max-width: 85%;
            padding: 10px 14px;
            border-radius: 12px;
            animation: milesMsgIn 0.3s ease;
            word-wrap: break-word;
            line-height: 1.5;
            font-size: 13px;
        }

        .miles-msg.user {
            align-self: flex-end;
            background: var(--miles-primary);
            color: #fff;
            border-bottom-right-radius: 4px;
        }

        .miles-msg.miles {
            align-self: flex-start;
            background: var(--miles-white);
            color: var(--miles-text);
            border: 1px solid var(--miles-border);
            border-bottom-left-radius: 4px;
        }

        .miles-msg.system {
            align-self: center;
            background: #f1f3f5;
            color: var(--miles-text-dim);
            font-size: 12px;
            max-width: 90%;
            border-radius: 20px;
            padding: 6px 16px;
        }

        .miles-msg .time {
            font-size: 10px;
            opacity: 0.6;
            margin-top: 4px;
            text-align: right;
        }

        .miles-msg.user .time {
            color: rgba(255, 255, 255, 0.6);
        }

        .miles-empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--miles-text-dim);
            text-align: center;
            padding: 40px 20px;
        }

        .miles-empty-state .icon {
            font-size: 48px;
            margin-bottom: 16px;
            opacity: 0.4;
        }

        .miles-empty-state h4 {
            font-size: 16px;
            font-weight: 700;
            color: var(--miles-text);
            margin: 0 0 4px;
        }

        .miles-empty-state p {
            font-size: 13px;
            margin: 0;
            color: var(--miles-text-faint);
        }

        @keyframes milesMsgIn {
            from {
                opacity: 0;
                transform: translateY(8px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        /* ─── TYPING INDICATOR ─── */
        .miles-typing {
            display: none;
            align-items: center;
            gap: 8px;
            padding: 8px 14px;
            background: var(--miles-white);
            border: 1px solid var(--miles-border);
            border-radius: 12px;
            align-self: flex-start;
            max-width: 70px;
        }

        .miles-typing.active {
            display: flex;
        }

        .miles-typing .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--miles-text-dim);
            animation: milesTypingDot 1.4s infinite;
        }

        .miles-typing .dot:nth-child(2) {
            animation-delay: 0.2s;
        }
        .miles-typing .dot:nth-child(3) {
            animation-delay: 0.4s;
        }

        @keyframes milesTypingDot {
            0%, 60%, 100% {
                transform: translateY(0);
                opacity: 0.3;
            }
            30% {
                transform: translateY(-6px);
                opacity: 1;
            }
        }

        /* ─── INPUT AREA ─── */
        .miles-input-area {
            padding: 12px 16px;
            border-top: 1px solid var(--miles-border);
            background: var(--miles-white);
            display: flex;
            gap: 10px;
            align-items: flex-end;
            flex-shrink: 0;
        }

        .miles-input-area textarea {
            flex: 1;
            padding: 8px 12px;
            border: 1px solid var(--miles-border);
            border-radius: 10px;
            resize: none;
            font-family: inherit;
            font-size: 13px;
            outline: none;
            min-height: 40px;
            max-height: 100px;
            background: var(--miles-bg);
            transition: border-color 0.2s;
            line-height: 1.4;
        }

        .miles-input-area textarea:focus {
            border-color: var(--miles-primary);
            background: var(--miles-white);
        }

        .miles-input-area .send-btn {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: var(--miles-primary);
            color: #fff;
            border: none;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            touch-action: manipulation;
        }

        .miles-input-area .send-btn:active {
            transform: scale(0.92);
        }

        .miles-input-area .send-btn:hover {
            background: var(--miles-primary-light);
            transform: scale(1.05);
        }

        .miles-input-area .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        /* ─── HELP TAB ─── */
        .miles-help-search {
            margin-bottom: 16px;
            position: relative;
        }

        .miles-help-search input {
            width: 100%;
            padding: 10px 14px 10px 40px;
            border: 1px solid var(--miles-border);
            border-radius: 10px;
            font-size: 13px;
            outline: none;
            background: var(--miles-white);
            font-family: inherit;
            -webkit-appearance: none;
            appearance: none;
        }

        .miles-help-search input:focus {
            border-color: var(--miles-primary);
        }

        .miles-help-search .icon {
            position: absolute;
            left: 12px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--miles-text-dim);
            font-size: 14px;
        }

        .miles-help-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .miles-help-item {
            padding: 12px 14px;
            background: var(--miles-white);
            border: 1px solid var(--miles-border);
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 10px;
            touch-action: manipulation;
        }

        .miles-help-item:active {
            transform: scale(0.98);
        }

        .miles-help-item:hover {
            border-color: var(--miles-primary);
            background: #f0f7fa;
        }

        .miles-help-item .icon {
            font-size: 16px;
            width: 28px;
            text-align: center;
            flex-shrink: 0;
        }

        .miles-help-item .text {
            flex: 1;
            font-size: 13px;
            font-weight: 500;
            color: var(--miles-text);
        }

        .miles-help-item .text .sub {
            font-size: 11px;
            font-weight: 400;
            color: var(--miles-text-dim);
            display: block;
            margin-top: 2px;
        }

        /* ─── ESCALATION ─── */
        .miles-escalation {
            background: #fef3d9;
            border: 1px solid var(--miles-warning);
            border-radius: 12px;
            padding: 12px 16px;
            margin: 8px 0;
            text-align: center;
            font-size: 13px;
            color: #b3720a;
        }

        .miles-escalation .btn-continue {
            margin-top: 8px;
            padding: 8px 20px;
            background: var(--miles-primary);
            color: #fff;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            font-size: 12px;
            transition: background 0.2s;
            font-family: inherit;
            touch-action: manipulation;
        }

        .miles-escalation .btn-continue:active {
            transform: scale(0.96);
        }

        .miles-escalation .btn-continue:hover {
            background: var(--miles-primary-light);
        }

        /* ─── SAFE AREA FOR NOTCH PHONES ─── */
        @supports (padding: max(0px)) {
            #miles-panel {
                padding-bottom: env(safe-area-inset-bottom, 0px);
            }
        }

        /* ─── DARK MODE SUPPORT ─── */
        @media (prefers-color-scheme: dark) {
            #miles-widget-root.dark {
                --miles-bg: #0f1a24;
                --miles-white: #1a2a33;
                --miles-text: #e8f0f5;
                --miles-text-dim: #8fa3ab;
                --miles-text-faint: #5b7480;
                --miles-border: rgba(255,255,255,0.06);
            }
        }
    `;

    // ─── HTML TEMPLATE ───
    const template = `
        <button id="miles-launcher" class="miles-pulse" aria-label="Open Miles support">
            <span class="badge" id="milesBadge" style="display:none;">0</span>
            <span class="label">Miles AI</span>
            <img src="/images/miles-logo.png" alt="Miles" id="milesLogo" onerror="this.style.display='none';this.parentElement.textContent='💬'">
        </button>

        <div id="miles-panel">
            <!-- Header -->
            <div class="miles-header">
                <div class="miles-header-left">
                    <div class="logo">
                        <img src="/images/miles-logo.png" alt="MilesSpace" onerror="this.parentElement.textContent='🤖'">
                    </div>
                    <div class="info">
                        <h3>Miles AI</h3>
                        <div class="status">
                            <span class="dot"></span>
                            <span id="milesStatusText">Ready to help</span>
                        </div>
                    </div>
                </div>
                <div class="miles-header-actions">
                    <button id="milesMinimize" title="Minimize" aria-label="Minimize">−</button>
                    <button id="milesClose" title="Close" aria-label="Close">✕</button>
                </div>
            </div>

            <!-- Snapshot -->
            <div class="miles-snapshot">
                <div class="snapshot-item">
                    <span class="snapshot-label">Wallet</span>
                    <span class="snapshot-value" id="milesSnapWallet">—</span>
                </div>
                <div class="snapshot-item">
                    <span class="snapshot-label">Orders</span>
                    <span class="snapshot-value" id="milesSnapOrders">—</span>
                </div>
                <div class="snapshot-item">
                    <span class="snapshot-label">Status</span>
                    <span class="snapshot-value" id="milesSnapStatus">● Online</span>
                </div>
            </div>

            <!-- Tabs -->
            <div class="miles-tabs">
                <button class="tab active" data-tab="home" aria-label="Home">
                    🏠 <span>Home</span>
                </button>
                <button class="tab" data-tab="messages" aria-label="Messages">
                    💬 <span>Messages</span>
                    <span class="tab-badge" id="milesTabBadge" style="display:none;">0</span>
                </button>
                <button class="tab" data-tab="help" aria-label="Help">
                    ❓ <span>Help</span>
                </button>
            </div>

            <!-- Content -->
            <div class="miles-content">
                <!-- HOME TAB -->
                <div class="miles-tab-content active" id="tab-home">
                    <div class="miles-welcome">
                        <div class="greeting" id="milesGreeting">👋 Hi there!</div>
                        <div class="sub">How can Miles help you today?</div>
                    </div>
                    <div class="miles-suggestions" id="milesSuggestions">
                        <button class="miles-suggestion" data-query="wallet balance">
                            <span class="icon">💰</span> Wallet
                        </button>
                        <button class="miles-suggestion" data-query="crypto orders">
                            <span class="icon">🪙</span> Crypto
                        </button>
                        <button class="miles-suggestion" data-query="gift card orders">
                            <span class="icon">🎁</span> Gift Cards
                        </button>
                        <button class="miles-suggestion" data-query="send gift">
                            <span class="icon">🎁</span> Send Gift
                        </button>
                        <button class="miles-suggestion" data-query="marketplace orders">
                            <span class="icon">🛒</span> Marketplace
                        </button>
                        <button class="miles-suggestion" data-query="withdrawals">
                            <span class="icon">📤</span> Withdrawals
                        </button>
                        <button class="miles-suggestion" data-query="account verification">
                            <span class="icon">🔐</span> Account
                        </button>
                        <button class="miles-suggestion" data-query="talk to support">
                            <span class="icon">👨‍💻</span> Support
                        </button>
                    </div>
                </div>

                <!-- MESSAGES TAB -->
                <div class="miles-tab-content" id="tab-messages">
                    <div class="miles-messages">
                        <div class="miles-message-list" id="milesMessageList">
                            <!-- Empty state will be rendered by JS -->
                        </div>
                        <div class="miles-typing" id="milesTyping">
                            <span class="dot"></span>
                            <span class="dot"></span>
                            <span class="dot"></span>
                        </div>
                        <div class="miles-input-area">
                            <textarea id="milesInput" placeholder="Ask Miles anything..." rows="1"></textarea>
                            <button class="send-btn" id="milesSendBtn" aria-label="Send message">➤</button>
                        </div>
                    </div>
                </div>

                <!-- HELP TAB -->
                <div class="miles-tab-content" id="tab-help">
                    <div class="miles-help-search">
                        <span class="icon">🔍</span>
                        <input type="text" id="milesHelpSearch" placeholder="Search help articles..." autocomplete="off">
                    </div>
                    <div class="miles-help-list" id="milesHelpList"></div>
                </div>
            </div>
        </div>
    `;

    // ─── WIDGET CLASS ───
    class MilesWidget {
        constructor(config = {}) {
            this.apiUrl = config.apiUrl || '/api/support';
            this.userId = config.userId || null;
            this.token = config.token || null;
            this.username = config.username || 'there';
            this.conversationId = config.conversationId || null;
            this.isOpen = false;
            this.messages = [];
            this.pollingInterval = null;
            this.currentTab = 'home';
            this.isProcessing = false;
            this.escalationPending = false;
            this.widgetReady = false;
            this.isMobile = window.innerWidth <= 520;
            this.hasLoadedHistory = false;

            this.init();
        }

        init() {
            // Check if user is logged in
            this.getUserData();

            // Inject styles and markup
            this.injectStyles();
            this.injectMarkup();

            // Setup after DOM is ready
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.setupWidget());
            } else {
                this.setupWidget();
            }

            // Handle resize for mobile detection
            window.addEventListener('resize', () => {
                this.isMobile = window.innerWidth <= 520;
            });
        }

        getUserData() {
            try {
                // Check window.__MILES_USER
                if (window.__MILES_USER) {
                    this.userId = window.__MILES_USER.id || null;
                    this.token = window.__MILES_USER.token || null;
                    this.username = window.__MILES_USER.username || 'there';
                    return;
                }

                // Check localStorage
                const stored = localStorage.getItem('miles_user');
                if (stored) {
                    const data = JSON.parse(stored);
                    this.userId = data.id || null;
                    this.token = data.token || null;
                    this.username = data.username || 'there';
                    return;
                }

                // Check sessionStorage
                const session = sessionStorage.getItem('miles_user');
                if (session) {
                    const data = JSON.parse(session);
                    this.userId = data.id || null;
                    this.token = data.token || null;
                    this.username = data.username || 'there';
                    return;
                }

                // Try Supabase session
                try {
                    const supabaseSession = JSON.parse(sessionStorage.getItem('supabase.auth.token'));
                    if (supabaseSession?.currentSession?.user) {
                        this.userId = supabaseSession.currentSession.user.id;
                        this.token = supabaseSession.currentSession.access_token;
                        this.username = supabaseSession.currentSession.user.user_metadata?.username || 'there';
                    }
                } catch (e) {}
            } catch (e) {
                console.warn('Miles: Could not get user data', e);
            }
        }

        injectStyles() {
            if (document.getElementById('miles-widget-styles')) return;
            const style = document.createElement('style');
            style.id = 'miles-widget-styles';
            style.textContent = styles;
            document.head.appendChild(style);
        }

        injectMarkup() {
            if (document.getElementById('miles-widget-root')) return;
            const root = document.createElement('div');
            root.id = 'miles-widget-root';
            root.innerHTML = template;
            document.body.appendChild(root);

            // Check for dark mode preference
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                root.classList.add('dark');
            }
        }

        setupWidget() {
            if (this.widgetReady) return;
            this.widgetReady = true;

            // Get elements
            this.root = document.getElementById('miles-widget-root');
            this.launcher = document.getElementById('miles-launcher');
            this.panel = document.getElementById('miles-panel');
            this.badge = document.getElementById('milesBadge');
            this.tabBadge = document.getElementById('milesTabBadge');
            this.messageList = document.getElementById('milesMessageList');
            this.input = document.getElementById('milesInput');
            this.sendBtn = document.getElementById('milesSendBtn');
            this.typingIndicator = document.getElementById('milesTyping');
            this.statusText = document.getElementById('milesStatusText');
            this.greeting = document.getElementById('milesGreeting');
            this.helpList = document.getElementById('milesHelpList');
            this.helpSearch = document.getElementById('milesHelpSearch');
            this.snapWallet = document.getElementById('milesSnapWallet');
            this.snapOrders = document.getElementById('milesSnapOrders');
            this.snapStatus = document.getElementById('milesSnapStatus');

            // Set greeting
            this.setGreeting();

            // Setup event listeners
            this.setupEventListeners();

            // Load initial data
            this.loadHelpArticles();
            this.getSnapshot();

            // Load conversation history if user is logged in
            if (this.userId && this.token) {
                this.loadConversationHistory();
                this.startPolling();
            } else {
                this.showEmptyState('No messages', 'Messages from the team will be shown here.');
            }

            console.log('🤖 Miles AI Widget ready');
        }

        setGreeting() {
            const hour = new Date().getHours();
            let greeting = '👋 Hi there!';
            if (hour < 12) greeting = '🌅 Good morning!';
            else if (hour < 17) greeting = '☀️ Good afternoon!';
            else greeting = '🌙 Good evening!';

            this.greeting.textContent = `${greeting} ${this.username}!`;
        }

        showEmptyState(title, message) {
            if (!this.messageList) return;
            this.messageList.innerHTML = `
                <div class="miles-empty-state">
                    <div class="icon">💬</div>
                    <h4>${title || 'No messages'}</h4>
                    <p>${message || 'Messages from the team will be shown here.'}</p>
                </div>
            `;
        }

        setupEventListeners() {
            // Launcher click - only opens when clicked
            this.launcher.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggle();
            });

            // Close button
            document.getElementById('milesClose').addEventListener('click', () => this.close());

            // Minimize button
            document.getElementById('milesMinimize').addEventListener('click', () => this.minimize());

            // Tab switching
            document.querySelectorAll('.miles-tabs .tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    this.switchTab(tab.dataset.tab);
                });
            });

            // Send message
            this.sendBtn.addEventListener('click', () => this.sendMessage());

            // Enter key
            this.input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });

            // Auto-resize textarea
            this.input.addEventListener('input', () => {
                this.input.style.height = 'auto';
                this.input.style.height = Math.min(this.input.scrollHeight, 100) + 'px';
            });

            // Suggestions
            document.querySelectorAll('.miles-suggestion').forEach(el => {
                el.addEventListener('click', (e) => {
                    const query = el.dataset.query;
                    if (query === 'talk to support') {
                        this.requestHumanSupport();
                        return;
                    }
                    this.input.value = query;
                    this.switchTab('messages');
                    setTimeout(() => this.sendMessage(), 300);
                });
            });

            // Help search
            this.helpSearch.addEventListener('input', () => {
                this.searchHelp(this.helpSearch.value);
            });

            // Close on escape
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.isOpen) {
                    this.close();
                }
            });

            // Handle swipe down to close on mobile
            let startY = 0;
            this.panel.addEventListener('touchstart', (e) => {
                startY = e.touches[0].clientY;
            });

            this.panel.addEventListener('touchmove', (e) => {
                const deltaY = e.touches[0].clientY - startY;
                if (deltaY > 100 && this.panel.scrollTop === 0) {
                    this.close();
                }
            });
        }

        toggle() {
            if (this.isOpen) {
                this.close();
            } else {
                this.open();
            }
        }

        open() {
            this.isOpen = true;
            this.panel.classList.add('open');
            this.launcher.classList.remove('miles-pulse');
            this.badge.style.display = 'none';
            this.tabBadge.style.display = 'none';
            this.switchTab('messages');
            setTimeout(() => {
                this.input.focus();
                this.scrollToBottom();
            }, 100);
            this.markAsRead();
        }

        close() {
            this.isOpen = false;
            this.panel.classList.remove('open');
            this.launcher.classList.add('miles-pulse');
            this.stopPolling();
        }

        minimize() {
            if (this.panel.classList.contains('minimized')) {
                this.panel.classList.remove('minimized');
                this.panel.style.height = '';
                this.panel.style.overflow = '';
                document.querySelector('.miles-content').style.display = '';
                document.querySelector('.miles-input-area').style.display = '';
            } else {
                this.panel.classList.add('minimized');
                this.panel.style.height = '60px';
                this.panel.style.overflow = 'hidden';
                document.querySelector('.miles-content').style.display = 'none';
                document.querySelector('.miles-input-area').style.display = 'none';
            }
        }

        switchTab(tabName) {
            this.currentTab = tabName;
            
            document.querySelectorAll('.miles-tabs .tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.tab === tabName);
            });

            document.querySelectorAll('.miles-tab-content').forEach(content => {
                content.classList.toggle('active', content.id === `tab-${tabName}`);
            });

            if (tabName === 'messages') {
                setTimeout(() => {
                    this.scrollToBottom();
                    this.markAsRead();
                }, 100);
            }
        }

        // ─── MESSAGE FUNCTIONS ───
        async sendMessage() {
            const message = this.input.value.trim();
            if (!message || this.isProcessing) return;

            // If no token, show login prompt
            if (!this.token) {
                this.addMessage({
                    sender_type: 'system',
                    message: '👋 Please log in to send messages. <a href="/login" style="color:var(--miles-primary);font-weight:600;">Login here</a>',
                    created_at: new Date().toISOString()
                });
                return;
            }

            this.isProcessing = true;
            this.input.value = '';
            this.input.disabled = true;
            this.sendBtn.disabled = true;

            // Remove empty state if present
            this.messageList.innerHTML = '';

            this.addMessage({
                sender_type: 'user',
                message: message,
                created_at: new Date().toISOString()
            });

            this.showTyping();

            try {
                const response = await fetch(`${this.apiUrl}/ask`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({
                        message: message,
                        conversation_id: this.conversationId,
                        user_id: this.userId
                    })
                });

                const data = await response.json();
                this.hideTyping();

                if (data.success) {
                    this.conversationId = data.data.conversation_id;
                    this.hasLoadedHistory = true;
                    
                    this.addMessage({
                        sender_type: data.data.response_type === 'system' ? 'system' : 'miles',
                        message: data.data.response,
                        created_at: new Date().toISOString()
                    });

                    if (data.data.escalation_needed) {
                        this.escalationPending = true;
                        this.showEscalationNotice();
                    }

                    this.updateStatus(data.data.status);

                    if (this.conversationId) {
                        localStorage.setItem('miles_conversation', this.conversationId);
                    }
                } else {
                    this.addMessage({
                        sender_type: 'system',
                        message: '❌ ' + (data.error || 'Something went wrong. Please try again.'),
                        created_at: new Date().toISOString()
                    });
                }
            } catch (error) {
                console.error('Send message error:', error);
                this.hideTyping();
                this.addMessage({
                    sender_type: 'system',
                    message: '❌ Connection error. Please check your internet connection.',
                    created_at: new Date().toISOString()
                });
            }

            this.isProcessing = false;
            this.input.disabled = false;
            this.sendBtn.disabled = false;
            this.input.focus();
            this.scrollToBottom();
        }

        addMessage(msg) {
            this.messages.push(msg);
            this.renderMessages();
            this.updateBadge();
        }

        renderMessages() {
            if (!this.messageList) return;

            // If no messages and not loaded yet, show empty state
            if (this.messages.length === 0 && !this.hasLoadedHistory) {
                this.showEmptyState('No messages', 'Messages from the team will be shown here.');
                return;
            }

            if (this.messages.length === 0) {
                this.showEmptyState('No messages', 'Start a conversation by typing a question below.');
                return;
            }

            this.messageList.innerHTML = this.messages.map(msg => {
                const isUser = msg.sender_type === 'user';
                const isSystem = msg.sender_type === 'system';
                const senderClass = isUser ? 'user' : (isSystem ? 'system' : 'miles');
                const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const formatted = this.formatMessage(msg.message);

                return `
                    <div class="miles-msg ${senderClass}">
                        ${formatted}
                        <div class="time">${time}</div>
                    </div>
                `;
            }).join('');

            this.scrollToBottom();
            this.updateBadge();
        }

        formatMessage(message) {
            return message
                .replace(/\n/g, '<br>')
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/g, '<em>$1</em>');
        }

        showTyping() {
            this.typingIndicator.classList.add('active');
            this.statusText.textContent = 'Miles is typing...';
            this.scrollToBottom();
        }

        hideTyping() {
            this.typingIndicator.classList.remove('active');
            this.statusText.textContent = 'Ready to help';
        }

        scrollToBottom() {
            if (this.messageList) {
                setTimeout(() => {
                    this.messageList.scrollTop = this.messageList.scrollHeight;
                }, 50);
            }
        }

        updateStatus(status) {
            const statusMap = {
                'active': 'Ready to help',
                'ai_handling': 'Miles is thinking...',
                'waiting_admin': 'Waiting for agent...',
                'admin_handling': 'Agent online',
                'resolved': 'Resolved',
                'closed': 'Closed'
            };
            this.statusText.textContent = statusMap[status] || 'Ready to help';
            if (this.snapStatus) {
                this.snapStatus.textContent = statusMap[status] || '● Online';
            }
        }

        updateBadge() {
            const unread = this.messages.filter(m => 
                m.sender_type !== 'user' && !m.is_read
            ).length;

            if (unread > 0 && !this.isOpen) {
                this.badge.style.display = 'flex';
                this.badge.textContent = unread;
                this.tabBadge.style.display = 'flex';
                this.tabBadge.textContent = unread;
            } else {
                this.badge.style.display = 'none';
                this.tabBadge.style.display = 'none';
            }
        }

        markAsRead() {
            if (!this.conversationId || !this.token) return;
            fetch(`${this.apiUrl}/conversations/${this.conversationId}/read`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` }
            }).catch(() => {});
        }

        // ─── LOAD CONVERSATION HISTORY ───
        async loadConversationHistory() {
            if (!this.token) {
                this.showEmptyState('No messages', 'Messages from the team will be shown here.');
                return;
            }

            try {
                // Get user's conversations
                const response = await fetch(`${this.apiUrl}/conversations?limit=10`, {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });

                const data = await response.json();

                if (data.success && data.data && data.data.length > 0) {
                    // Load the most recent conversation
                    const latest = data.data[0];
                    this.conversationId = latest.id;
                    
                    // Load messages for this conversation
                    const msgResponse = await fetch(`${this.apiUrl}/conversations/${this.conversationId}`, {
                        headers: { 'Authorization': `Bearer ${this.token}` }
                    });

                    const msgData = await msgResponse.json();
                    if (msgData.success && msgData.data?.messages) {
                        this.messages = msgData.data.messages;
                        this.hasLoadedHistory = true;
                        this.renderMessages();
                        this.scrollToBottom();
                    } else {
                        this.showEmptyState('No messages', 'Start a conversation by typing a question below.');
                    }
                } else {
                    this.showEmptyState('No messages', 'Messages from the team will be shown here.');
                }
            } catch (error) {
                console.error('Load conversation history error:', error);
                this.showEmptyState('No messages', 'Messages from the team will be shown here.');
            }
        }

        // ─── POLLING ───
        startPolling() {
            if (this.pollingInterval) return;
            this.pollingInterval = setInterval(() => {
                this.checkForUpdates();
            }, CONFIG.POLL_INTERVAL);
        }

        stopPolling() {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
            }
        }

        async checkForUpdates() {
            if (!this.conversationId || !this.isOpen || !this.token) return;

            try {
                const response = await fetch(`${this.apiUrl}/conversations/${this.conversationId}`, {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });

                const data = await response.json();
                if (data.success && data.data?.messages) {
                    const newMessages = data.data.messages.slice(this.messages.length);
                    if (newMessages.length > 0) {
                        newMessages.forEach(msg => {
                            if (msg.sender_type !== 'user') {
                                this.addMessage(msg);
                            }
                        });
                    }
                }
            } catch (error) {
                // Silent fail
            }
        }

        // ─── HELP ARTICLES ───
        async loadHelpArticles() {
            try {
                const response = await fetch(`${this.apiUrl}/faq?limit=10`);
                const data = await response.json();
                if (data.success) {
                    this.renderHelpArticles(data.data || []);
                }
            } catch (error) {
                console.error('Load help articles error:', error);
                this.renderFallbackArticles();
            }
        }

        renderFallbackArticles() {
            const fallback = [
                { question: 'How do I fund my wallet?', category: { name: 'Wallet' } },
                { question: 'How do I buy crypto?', category: { name: 'Crypto' } },
                { question: 'How do I send a gift?', category: { name: 'Gifts' } },
                { question: 'How do I withdraw funds?', category: { name: 'Withdrawals' } }
            ];
            this.renderHelpArticles(fallback);
        }

        renderHelpArticles(articles) {
            if (!this.helpList) return;

            if (!articles || articles.length === 0) {
                this.helpList.innerHTML = `
                    <div style="text-align:center;padding:40px 0;color:var(--miles-text-dim);">
                        <div style="font-size:32px;margin-bottom:8px;">📚</div>
                        <p>No help articles found.</p>
                    </div>
                `;
                return;
            }

            this.helpList.innerHTML = articles.map(article => `
                <div class="miles-help-item" onclick="window.MilesWidget?.askQuestion('${article.question.replace(/'/g, "\\'")}')">
                    <span class="icon">📌</span>
                    <div class="text">
                        ${article.question}
                        <span class="sub">${article.category?.name || 'General'}</span>
                    </div>
                </div>
            `).join('');
        }

        searchHelp(query) {
            if (!query.trim()) {
                this.loadHelpArticles();
                return;
            }

            fetch(`${this.apiUrl}/faq?q=${encodeURIComponent(query)}&limit=10`)
                .then(res => res.json())
                .then(data => {
                    if (data.success) {
                        this.renderHelpArticles(data.data || []);
                    }
                })
                .catch(() => {});
        }

        askQuestion(question) {
            this.input.value = question;
            this.switchTab('messages');
            setTimeout(() => this.sendMessage(), 300);
        }

        // ─── SNAPSHOT ───
        async getSnapshot() {
            if (!this.token) return;

            try {
                // Try to get wallet balance
                const response = await fetch('/api/wallet/balance', {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                const data = await response.json();
                if (data.success && data.data) {
                    this.snapWallet.textContent = data.data.balance || '—';
                }
            } catch (error) {
                // Silent fail
            }
        }

        // ─── ESCALATION ───
        async requestHumanSupport() {
            if (!this.token) {
                this.addMessage({
                    sender_type: 'system',
                    message: '👋 Please log in to request support. <a href="/login" style="color:var(--miles-primary);font-weight:600;">Login here</a>',
                    created_at: new Date().toISOString()
                });
                return;
            }

            if (!this.conversationId) {
                await this.startConversation();
            }

            try {
                const response = await fetch(`${this.apiUrl}/escalate`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({
                        conversation_id: this.conversationId,
                        reason: 'User requested human support'
                    })
                });

                const data = await response.json();
                if (data.success) {
                    this.escalationPending = true;
                    this.addMessage({
                        sender_type: 'system',
                        message: '🔴 A support agent has been notified. They will join shortly.',
                        created_at: new Date().toISOString()
                    });
                    this.updateStatus('waiting_admin');
                }
            } catch (error) {
                console.error('Request support error:', error);
            }
        }

        async startConversation() {
            try {
                const response = await fetch(`${this.apiUrl}/start`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({ user_id: this.userId })
                });

                const data = await response.json();
                if (data.success) {
                    this.conversationId = data.data.conversation_id;
                }
            } catch (error) {
                console.error('Start conversation error:', error);
            }
        }

        showEscalationNotice() {
            const notice = document.createElement('div');
            notice.className = 'miles-escalation';
            notice.innerHTML = `
                🔴 Escalated to support.
                <br>
                <button class="btn-continue" onclick="window.MilesWidget?.continueWithSupport()">
                    Continue with Admin
                </button>
            `;
            this.messageList.appendChild(notice);
            this.scrollToBottom();
        }

        continueWithSupport() {
            this.escalationPending = false;
            this.updateStatus('admin_handling');
            this.addMessage({
                sender_type: 'system',
                message: '👨‍💻 Support agent is now in the conversation.',
                created_at: new Date().toISOString()
            });
            this.renderMessages();
        }
    }

    // ─── INITIALIZE ───
    function initMilesWidget() {
        if (window.MilesWidget) return;

        window.MilesWidget = new MilesWidget({
            apiUrl: '/api/support'
        });

        console.log('🤖 Miles AI Widget loaded');
    }

    // ─── BOOT ───
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMilesWidget);
    } else {
        initMilesWidget();
    }

})();