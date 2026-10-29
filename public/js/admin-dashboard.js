'use strict';

const API = {
    stats:                    '/api/admin/stats',
    loginsToday:              '/api/admin/logins/today',
    recentUsers:              '/api/admin/users/recent',
    userDetailBase:           '/api/admin/users',
    recentTransactions:       '/api/admin/transactions/recent',
    recentDeposits:           '/api/admin/deposits/recent',
    failedOrders:             '/api/admin/orders/failed/recent',
    webhooks:                 '/api/admin/webhooks/recent',
    servicePerformance:       '/api/admin/services/performance',
    providerHealth:           '/api/admin/providers/health',
    needsAttention:           '/api/admin/needs-attention',
    charts:                   '/api/admin/charts',
    health:                   '/api/admin/health',
    me:                       '/api/admin/me',
    reconciliationExceptions: '/api/admin/reconciliation/exceptions/count'
};

const ROUTES = {
    users:        '/admin/users',
    deposits:     '/admin/deposits',
    transactions: '/admin/transactions',
    failedOrders: '/admin/orders?status=failed',
    orders:       '/admin/orders',
    revenue:      '/admin/revenue',
    ledger:       '/admin/ledger',
    reconciliation: '/admin/reconciliation',
    providers:    '/admin/providers',
    webhooks:     '/admin/webhooks',
    reports:      '/admin/reports',
    giftCards:    '/admin/sellgift',
    airtime:      '/admin/airtime-data',
    esim:         '/admin/esim',
    virtualSms:   '/admin/virtual-sms',
    boost:        '/admin/boost',
    marketplace:  '/admin/marketplace-products',
    bills:        '/admin/bills',
    support:      '/admin/support'
};

const State = {
    range: { key: 'today', from: null, to: null, label: 'Today', detail: '' },
    stats: null,
    chartRefs: { activity: null, revenue: null },
    inFlight: new Set(),
    lastSuccessfulLoadAt: null,
    activeTab: 'tx',
    recentLoaded: { tx: false, dep: false, users: false },
    health: null,
    providers: null,
    recon: null
};

/* ── Formatters ── */
const CURRENCY_SYMBOLS = {
    NGN: '₦', USD: '$', GHS: 'GH₵', KES: 'KSh', ZAR: 'R',
    XOF: 'CFA', XAF: 'FCFA', TZS: 'TSh', EGP: 'E£'
};

function formatMoney(v, c) {
    const ccy = String(c || '').toUpperCase();
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return (CURRENCY_SYMBOLS[ccy] || (ccy ? ccy + ' ' : '')) + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatNumber(n) {
    if (n == null || n === '') return null;
    const x = Number(n);
    return Number.isFinite(x) ? x.toLocaleString('en-US') : null;
}

function getInitials(n) {
    if (!n) return 'U';
    return String(n).split(/\s+/).map(w => w[0]).filter(Boolean).join('').toUpperCase().slice(0, 2) || 'U';
}

function timeAgo(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 0) return 'just now';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return Math.floor(s / 604800) + 'w ago';
}

function formatDateTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

function formatDateShort(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

/* ── Toast ── */
const TOAST_ICONS = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info'
};

function showToast(msg, type = 'info', duration = 3600) {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = `<i class="fas ${TOAST_ICONS[type] || TOAST_ICONS.info} tic" aria-hidden="true"></i><span class="tmsg">${escapeHtml(msg)}</span><button class="tclose" type="button" aria-label="Dismiss"><i class="fas fa-xmark"></i></button>`;
    stack.appendChild(el);
    const t = setTimeout(() => el.remove(), duration);
    el.querySelector('.tclose')?.addEventListener('click', () => { clearTimeout(t); el.remove(); });
    while (stack.children.length > 5) stack.firstElementChild.remove();
}

/* ── Confirm modal ── */
function confirmDialog({
    title = 'Confirm',
    body = '',
    danger = true,
    okText = 'Confirm',
    cancelText = 'Cancel',
    icon = 'fa-triangle-exclamation'
} = {}) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const iconEl = document.getElementById('confirmIcon');
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmBody').textContent = body;
        document.getElementById('confirmOk').textContent = okText;
        document.getElementById('confirmCancel').textContent = cancelText;
        iconEl.innerHTML = `<i class="fas ${icon}"></i>`;
        iconEl.style.background = danger ? 'var(--danger-bg)' : 'var(--info-bg)';
        iconEl.style.color = danger ? 'var(--danger)' : 'var(--info)';
        const ok = document.getElementById('confirmOk');
        const cancel = document.getElementById('confirmCancel');
        ok.classList.toggle('danger', !!danger);
        const cleanup = () => {
            modal.classList.remove('show');
            document.removeEventListener('keydown', onKey);
        };
        const finish = (v) => { cleanup(); resolve(v); };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        };
        document.addEventListener('keydown', onKey);
        modal.classList.add('show');
        setTimeout(() => ok.focus(), 50);
        ok.onclick = () => finish(true);
        cancel.onclick = () => finish(false);
        modal.onclick = (e) => { if (e.target === modal) finish(false); };
    });
}

function toggleNavGroup(head) {
    const g = head.closest('.nav-group');
    g.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!g.classList.contains('collapsed')));
    try {
        localStorage.setItem('navgroup:' + g.dataset.group, g.classList.contains('collapsed') ? 'collapsed' : 'open');
    } catch (e) {}
}

function getTxUser(t) {
    if (!t) return { username: 'Unknown user', email: '', id: null };
    if (t.user && typeof t.user === 'object') {
        const u = t.user;
        const username = u.username || (u.email ? String(u.email).split('@')[0] : null);
        if (username) return { username, email: u.email || '', id: u.id || null };
    }
    if (t.user_name || t.user_email) {
        const username = t.user_name || (t.user_email ? String(t.user_email).split('@')[0] : null) || 'Unknown user';
        return { username, email: t.user_email || '', id: t.user_id || null };
    }
    if (t.profiles && typeof t.profiles === 'object') {
        const p = t.profiles;
        const username = p.username || (p.email ? String(p.email).split('@')[0] : null) || 'Unknown user';
        return { username, email: p.email || '', id: t.user_id || null };
    }
    if (t.user_id) return { username: 'User ' + String(t.user_id).slice(0, 8), email: '', id: t.user_id };
    return { username: 'Unknown user', email: '', id: null };
}

/* ── Date range (WAT) ── */
function rangeFor(key, cf, ct) {
    const now = new Date(), OFF = 3600000;
    const sd = d => {
        const l = new Date(d.getTime() + OFF);
        return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), 0, 0, 0) - OFF);
    };
    const ed = d => new Date(sd(d).getTime() + 86400000 - 1);
    switch (key) {
        case 'today': {
            const f = sd(now), t = ed(now);
            return { from: f.toISOString(), to: t.toISOString(), label: 'Today', detail: formatDateShort(f.toISOString()) };
        }
        case 'yesterday': {
            const y = new Date(now.getTime() - 86400000);
            const f = sd(y), t = ed(y);
            return { from: f.toISOString(), to: t.toISOString(), label: 'Yesterday', detail: formatDateShort(f.toISOString()) };
        }
        case '7d': {
            const f = sd(new Date(now.getTime() - 6 * 86400000)), t = ed(now);
            return { from: f.toISOString(), to: t.toISOString(), label: 'Last 7 days', detail: `${formatDateShort(f.toISOString())} – ${formatDateShort(t.toISOString())}` };
        }
        case '30d': {
            const f = sd(new Date(now.getTime() - 29 * 86400000)), t = ed(now);
            return { from: f.toISOString(), to: t.toISOString(), label: 'Last 30 days', detail: `${formatDateShort(f.toISOString())} – ${formatDateShort(t.toISOString())}` };
        }
        case 'month': {
            const l = new Date(now.getTime() + OFF), y = l.getUTCFullYear(), m = l.getUTCMonth();
            const f = new Date(Date.UTC(y, m, 1, 0, 0, 0) - OFF), t = ed(now);
            return { from: f.toISOString(), to: t.toISOString(), label: 'This month', detail: `${formatDateShort(f.toISOString())} – ${formatDateShort(t.toISOString())}` };
        }
        case 'lastmonth': {
            const l = new Date(now.getTime() + OFF), y = l.getUTCFullYear(), m = l.getUTCMonth();
            const f = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - OFF), t = new Date(Date.UTC(y, m, 1, 0, 0, 0) - OFF - 1);
            return { from: f.toISOString(), to: t.toISOString(), label: 'Last month', detail: `${formatDateShort(f.toISOString())} – ${formatDateShort(t.toISOString())}` };
        }
        case 'custom': {
            if (!cf || !ct) return rangeFor('today');
            const f = sd(new Date(cf)), t = ed(new Date(ct));
            if (f > t) return rangeFor('today');
            return { from: f.toISOString(), to: t.toISOString(), label: 'Custom', detail: `${formatDateShort(f.toISOString())} – ${formatDateShort(t.toISOString())}` };
        }
        default:
            return rangeFor('today');
    }
}

function applyRange(key, opts = {}) {
    const r = rangeFor(key, opts.customFrom, opts.customTo);
    State.range = { key, ...r };
    document.getElementById('datePillText').textContent = r.detail;
    document.querySelectorAll('.range-opt').forEach(b => b.classList.toggle('active', b.dataset.range === key));
    document.getElementById('customRange').classList.toggle('show', key === 'custom');
}

function withRange(url) {
    if (!url) return url;
    const sep = url.includes('?') ? '&' : '?';
    const p = new URLSearchParams();
    if (State.range.from) p.set('from', State.range.from);
    if (State.range.to) p.set('to', State.range.to);
    return url + sep + p.toString();
}

/* ── Safe fetch ── */
async function safeFetch(url, options = {}, key) {
    if (key) {
        if (State.inFlight.has(key)) return { ok: false, reason: 'duplicate' };
        State.inFlight.add(key);
    }
    try {
        const res = await AdminSession.fetch(url, options);
        if (res.status === 404) return { ok: false, reason: 'not_implemented', status: 404 };
        if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized', status: res.status };
        if (!res.ok) return { ok: false, reason: 'http_error', status: res.status };
        let j;
        try { j = await res.json(); } catch (e) { return { ok: false, reason: 'invalid_response' }; }
        if (!j || j.success === false) return { ok: false, reason: 'api_error', error: j?.error };
        return { ok: true, data: (j.data !== undefined ? j.data : j) };
    } catch (e) {
        return { ok: false, reason: 'network_error' };
    } finally {
        if (key) State.inFlight.delete(key);
    }
}

function unavailableMessage(r) {
    switch (r) {
        case 'unauthorized': return 'Your admin session has expired.';
        case 'not_implemented': return 'Endpoint not available on this server.';
        case 'invalid_response': return 'Unexpected response from server.';
        case 'network_error': return 'Network error — check your connection.';
        case 'http_error': return 'Server error. Check the logs.';
        case 'api_error': return 'The API returned an error.';
        default: return 'Data unavailable.';
    }
}

/* ── Render helpers ── */
function renderUnavailable(c, msg, onRetry) {
    if (!c) return;
    const id = 'retry-' + Math.random().toString(36).slice(2, 8);
    c.innerHTML = `<div class="unavailable-box"><i class="fas fa-triangle-exclamation ic" aria-hidden="true"></i><div class="msg">Data unavailable</div><div class="sub">${escapeHtml(msg)}</div>${onRetry ? `<button id="${id}" type="button">Retry</button>` : ''}</div>`;
    if (onRetry) document.getElementById(id)?.addEventListener('click', onRetry);
}

function renderTableSkeleton(tbody, cols, rows = 4) {
    if (!tbody) return;
    let h = '';
    for (let i = 0; i < rows; i++) {
        h += '<tr class="skel-row">' + Array.from({ length: cols }).map(() => `<td><span class="skel skel-line" style="width:${60 + Math.random() * 30}%;display:inline-block;"></span></td>`).join('') + '</tr>';
    }
    tbody.innerHTML = h;
}

function renderTableUnavailable(tbody, cols, msg, onRetry) {
    if (!tbody) return;
    const id = 'retry-' + Math.random().toString(36).slice(2, 8);
    tbody.innerHTML = `<tr><td colspan="${cols}"><div class="unavailable-box"><i class="fas fa-triangle-exclamation ic" aria-hidden="true"></i><div class="msg">Data unavailable</div><div class="sub">${escapeHtml(msg)}</div>${onRetry ? `<button id="${id}" type="button">Retry</button>` : ''}</div></td></tr>`;
    if (onRetry) document.getElementById(id)?.addEventListener('click', onRetry);
}

function renderTableEmpty(tbody, cols, msg) {
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-faint);padding:22px;font-size:12px">${escapeHtml(msg)}</td></tr>`;
}

/* ── Drawer ── */
function openDrawer({ icon, title, sub, bodyHtml }) {
    const iconEl = document.getElementById('ddIcon');
    iconEl.innerHTML = `<i class="fas ${icon || 'fa-file'}"></i>`;
    document.getElementById('ddTitle').textContent = title || 'Detail';
    document.getElementById('ddSub').textContent = sub || '';
    document.getElementById('ddBody').innerHTML = bodyHtml || '';
    document.getElementById('detailDrawer').classList.add('open');
    document.getElementById('drawerScrim').classList.add('show');
}

function closeDrawer() {
    document.getElementById('detailDrawer').classList.remove('open');
    document.getElementById('drawerScrim').classList.remove('show');
}

/* ── KPI cards (5 primary, reference layout) ── */
function kpiCard({ faIcon, color, label, value, currency, desc, route, linkText, onClick, unavailable }) {
    const el = document.createElement('div');
    const clickable = !!(route || onClick);
    el.className = 'kpi-card' + (clickable ? ' clickable' : '');
    if (clickable) {
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', label);
    }
    let valueHtml;
    if (unavailable) {
        valueHtml = `<span class="kpi-value unavailable">Unavailable</span>`;
    } else if (currency) {
        const m = formatMoney(value, currency);
        valueHtml = m ? `<span class="kpi-value">${m}</span>` : `<span class="kpi-value unavailable">—</span>`;
    } else {
        const n = formatNumber(value);
        valueHtml = n !== null ? `<span class="kpi-value">${n}</span>` : `<span class="kpi-value unavailable">—</span>`;
    }
    el.innerHTML = `
        <div class="kpi-top"><div class="kpi-icon ${color}"><i class="fas ${faIcon}" aria-hidden="true"></i></div></div>
        <div>${valueHtml}</div>
        <div class="kpi-label">${escapeHtml(label)}</div>
        <div class="kpi-desc">${escapeHtml(desc || '')}</div>
        ${linkText ? `<a class="kpi-link" href="${escapeHtml(withRange(route || '#'))}" onclick="event.stopPropagation()">${escapeHtml(linkText)} <i class="fas fa-arrow-right" style="font-size:8px"></i></a>` : ''}`;
    if (clickable) {
        const go = () => { if (onClick) onClick(); else window.location.href = withRange(route); };
        el.addEventListener('click', go);
        el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
    return el;
}

function renderKpis(stats) {
    const grid = document.getElementById('kpiGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const s = stats || {}, meta = s._meta || {};
    const cards = [
        kpiCard({ faIcon: 'fa-users', color: 'blue', label: 'Total Users', value: s.totalUsers, desc: "Today's new users", route: ROUTES.users, linkText: 'View users', unavailable: meta.users_total === false }),
        kpiCard({ faIcon: 'fa-chart-line', color: 'purple', label: 'Platform Revenue (NGN)', value: s.revenue?.today?.ngn, currency: 'NGN', desc: "Today's revenue", route: ROUTES.revenue, linkText: 'View revenue', unavailable: meta.revenue_today_ngn === false }),
        kpiCard({ faIcon: 'fa-wallet', color: 'gold', label: 'Wallet Liabilities (NGN)', value: s.walletBalance?.ngn, currency: 'NGN', desc: 'Customer balances (liability)', route: ROUTES.ledger + '?currency=NGN', linkText: 'View ledger', unavailable: meta.wallet_ngn_liability === false }),
        kpiCard({ faIcon: 'fa-arrow-right-arrow-left', color: 'green', label: 'Transactions Today', value: s.transactions?.today?.count, desc: `${s.transactions?.completed ?? '—'} completed · ${s.transactions?.pending ?? '—'} pending · ${s.transactions?.failed ?? '—'} failed`, route: ROUTES.transactions, linkText: 'View transactions', unavailable: meta.transactions_today === false }),
        kpiCard({ faIcon: 'fa-circle-exclamation', color: 'red', label: 'Failed Orders', value: s.transactions?.failed, desc: 'Requires investigation', route: ROUTES.failedOrders, linkText: 'View orders', unavailable: meta.transactions_today === false })
    ];
    cards.forEach(c => grid.appendChild(c));
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v == null ? '0' : String(v); };
    set('usersBadge', formatNumber(s.totalUsers) ?? 0);
    set('supportBadge', s.support?.open ?? 0);
    set('notifCount', s.notifications?.unread ?? 0);
    set('mnavAlertsBadge', s.transactions?.failed ?? 0);
}

function renderKpiSkeleton() {
    const g = document.getElementById('kpiGrid');
    if (!g) return;
    g.innerHTML = Array.from({ length: 5 }).map(() => `<div class="kpi-card skel-kpi"><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line" style="width:50%;"></div></div>`).join('');
}

/* ── Charts ── */
function themeColors() {
    const dark = document.documentElement.classList.contains('dark');
    return {
        grid: dark ? 'rgba(255,255,255,.06)' : 'rgba(15,76,92,.06)',
        text: dark ? '#93aab1' : '#5b7480',
        navy: dark ? '#3fb6d3' : '#0f4c5c',
        gold: '#f5a623',
        teal: '#2a8fa6'
    };
}

function destroyChart(k) {
    if (State.chartRefs[k]) {
        try { State.chartRefs[k].destroy(); } catch (e) {}
        State.chartRefs[k] = null;
    }
}

async function loadCharts() {
    const { ok, data, reason } = await safeFetch(API.charts, {}, 'charts');
    const aw = document.getElementById('chartActivity')?.parentElement;
    const rw = document.getElementById('chartRevenue')?.parentElement;
    if (!ok || !data) {
        if (aw) renderUnavailable(aw, unavailableMessage(reason), loadCharts);
        if (rw) renderUnavailable(rw, unavailableMessage(reason), loadCharts);
        return;
    }
    const tc = themeColors();
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const weekly = data.weeklyRevenue?.data;
    if (Array.isArray(weekly) && weekly.length === 7) {
        destroyChart('activity');
        const cv = document.getElementById('chartActivity');
        if (cv) State.chartRefs.activity = new Chart(cv.getContext('2d'), {
            type: 'bar',
            data: { labels: days, datasets: [{ label: 'Volume (NGN)', data: weekly.map(v => Number(v) || 0), backgroundColor: tc.teal + 'cc', borderColor: tc.teal, borderWidth: 0, borderRadius: 5 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => formatMoney(ctx.parsed.y, 'NGN') || '—' } } }, scales: { x: { grid: { display: false }, ticks: { color: tc.text, font: { size: 10 } } }, y: { grid: { color: tc.grid }, ticks: { color: tc.text, font: { size: 10 } } } } }
        });
    } else if (aw) renderUnavailable(aw, 'Weekly activity not returned.', loadCharts);

    const revNgn = Array.isArray(data.revenue) ? data.revenue : null;
    if (revNgn && revNgn.length === 12) {
        destroyChart('revenue');
        const cv = document.getElementById('chartRevenue');
        if (cv) {
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const now = new Date(), labels = [];
            for (let i = 0; i < 12; i++) {
                const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
                labels.push(months[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2));
            }
            State.chartRefs.revenue = new Chart(cv.getContext('2d'), {
                type: 'line',
                data: { labels, datasets: [{ label: 'Revenue NGN', data: revNgn.map(v => Number(v) || 0), borderColor: tc.gold, backgroundColor: tc.gold + '20', tension: 0.35, fill: true, borderWidth: 2, pointRadius: 2.5, pointBackgroundColor: tc.gold }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => formatMoney(ctx.parsed.y, 'NGN') || '—' } } }, scales: { x: { grid: { display: false }, ticks: { color: tc.text, font: { size: 10 } } }, y: { grid: { color: tc.grid }, ticks: { color: tc.text, font: { size: 10 } } } } }
            });
        }
    } else if (rw) renderUnavailable(rw, 'Revenue series not returned.', loadCharts);
}

/* ── Service performance + Top services ── */
async function loadServicePerformance() {
    const tbody = document.getElementById('servicePerfBody');
    const top = document.getElementById('topServicesBody');
    renderTableSkeleton(tbody, 8);
    if (top) top.innerHTML = `<div class="skel" style="height:36px;border-radius:8px;margin-bottom:6px"></div><div class="skel" style="height:36px;border-radius:8px;margin-bottom:6px"></div><div class="skel" style="height:36px;border-radius:8px"></div>`;
    const { ok, data, reason } = await safeFetch(API.servicePerformance, {}, 'svc');
    if (!ok || !Array.isArray(data)) {
        renderTableUnavailable(tbody, 8, unavailableMessage(reason), loadServicePerformance);
        if (top) renderUnavailable(top, unavailableMessage(reason), loadServicePerformance);
        return;
    }
    if (!data.length) {
        renderTableEmpty(tbody, 8, 'No service activity in this period');
        if (top) top.innerHTML = `<div style="text-align:center;color:var(--text-faint);font-size:11.5px;padding:12px 0">No service activity</div>`;
        return;
    }

    tbody.innerHTML = data.map(r => {
        const route = r.route ? withRange(r.route) : '';
        const attr = route ? ` class="row-clickable" onclick="window.location.href='${escapeHtml(route)}'"` : '';
        return `<tr${attr}>
            <td><strong>${escapeHtml(r.label || r.service || '—')}</strong></td>
            <td>${formatNumber(r.orders) ?? '—'}</td>
            <td>${formatNumber(r.completed) ?? '—'}</td>
            <td>${formatNumber(r.pending) ?? '—'}</td>
            <td>${formatNumber(r.failed) ?? '—'}</td>
            <td>${formatMoney(r.volumeNgn, 'NGN') || '—'} · ${formatMoney(r.volumeUsd, 'USD') || '—'}</td>
            <td>${formatMoney(r.revenueNgn, 'NGN') || '—'} · ${formatMoney(r.revenueUsd, 'USD') || '—'}</td>
            <td>${r.successRate != null ? Number(r.successRate).toFixed(1) + '%' : '—'}</td>
        </tr>`;
    }).join('');

    const topList = data.slice().sort((a, b) => (b.orders || 0) - (a.orders || 0)).slice(0, 5);
    const svcIcon = (lbl) => {
        const s = String(lbl || '').toLowerCase();
        if (s.includes('airtime') || s.includes('data')) return 'fa-signal';
        if (s.includes('gift')) return 'fa-gift';
        if (s.includes('tv') || s.includes('cable')) return 'fa-tv';
        if (s.includes('bill') || s.includes('electric') || s.includes('utilit')) return 'fa-bolt';
        if (s.includes('exam') || s.includes('pin')) return 'fa-graduation-cap';
        if (s.includes('esim')) return 'fa-sim-card';
        if (s.includes('sms')) return 'fa-mobile-screen';
        if (s.includes('market')) return 'fa-box';
        return 'fa-cube';
    };
    if (top) top.innerHTML = topList.map(r => {
        const route = r.route ? withRange(r.route) : '';
        const click = route ? ` onclick="window.location.href='${escapeHtml(route)}'"` : '';
        return `<div class="svc-row"${click}>
            <div class="sic"><i class="fas ${svcIcon(r.label || r.service)}"></i></div>
            <div class="sbody">
                <div class="sname">${escapeHtml(r.label || r.service || '—')}</div>
                <div class="scount">${formatNumber(r.orders) ?? 0} processed</div>
            </div>
            <i class="fas fa-chevron-right sarrow"></i>
        </div>`;
    }).join('');
}

/* ── Provider health ── */
async function loadProviderHealth() {
    const el = document.getElementById('providerList');
    if (!el) return;
    el.innerHTML = Array.from({ length: 6 }).map(() => `<div class="skel" style="height:40px;border-radius:9px;"></div>`).join('');
    const { ok, data, reason } = await safeFetch(API.providerHealth, {}, 'providers');
    if (!ok || !Array.isArray(data) || !data.length) {
        renderUnavailable(el, unavailableMessage(reason), loadProviderHealth);
        return;
    }
    State.providers = data;
    el.innerHTML = data.map(p => {
        const st = String(p.status || 'unknown').toLowerCase();
        const cls = st === 'operational' ? 'healthy' : st === 'degraded' ? 'degraded' : st === 'unavailable' || st === 'failed' ? 'failed' : 'unknown';
        const label = st === 'operational' ? 'Healthy' : st === 'degraded' ? 'Degraded' : st === 'unavailable' || st === 'failed' ? 'Failed' : 'Unknown';
        return `<div class="provider-row">
            <span class="pname">${escapeHtml(p.name || p.key || '')}</span>
            <span class="pill ${cls}">${label}</span>
        </div>`;
    }).join('');
    updateSystemHealth();
}

/* ── System Health ── */
function updateSystemHealth() {
    const body = document.getElementById('systemHealthBody');
    if (!body) return;
    const h = State.health, p = State.providers, r = State.recon;
    let provHealthy = null, provTotal = null;
    if (Array.isArray(p)) {
        provTotal = p.length;
        provHealthy = p.filter(x => x.status === 'operational').length;
    }
    const reconCount = (r && (r.count ?? r.exceptions ?? r)) ?? null;
    const overall = h?.status === 'operational' ? 'operational' : h?.status === 'degraded' ? 'degraded' : h?.status || null;
    const pct = provTotal ? Math.round(provHealthy / provTotal * 100) : 0;
    const fillCls = pct >= 90 ? '' : pct >= 50 ? 'warn' : 'danger';
    const reconPill = reconCount == null ? '<span class="sh-pill neutral">Unknown</span>' : reconCount > 0 ? `<span class="sh-pill bad">${formatNumber(reconCount)} exception${Number(reconCount) === 1 ? '' : 's'}</span>` : '<span class="sh-pill ok">0 exceptions</span>';
    const webhookStatus = h?.webhooks_status || h?.webhook_status || null;
    const webhookPill = webhookStatus == null ? '<span class="sh-pill neutral">Unknown</span>' : String(webhookStatus).toLowerCase() === 'normal' || String(webhookStatus).toLowerCase() === 'operational' ? `<span class="sh-pill ok">${escapeHtml(webhookStatus)}</span>` : `<span class="sh-pill warn">${escapeHtml(webhookStatus)}</span>`;
    body.innerHTML = `
        <div class="sh-badge"><i class="fas fa-circle-check"></i> ${overall === 'operational' ? 'All Systems Operational' : overall ? escapeHtml(overall) : 'Unknown'}</div>
        <div class="sh-row"><span class="k"><i class="fas fa-server"></i> Providers</span><span class="v">${provTotal != null ? `${provHealthy}/${provTotal} healthy` : '—'}</span></div>
        ${provTotal ? `<div class="sh-bar"><div class="fill ${fillCls}" style="width:${pct}%"></div></div>` : ''}
        <div class="sh-row"><span class="k"><i class="fas fa-plug"></i> Webhooks</span><span class="v">${webhookPill}</span></div>
        <div class="sh-row"><span class="k"><i class="fas fa-scale-balanced"></i> Reconciliation</span><span class="v">${reconPill}</span></div>
        <div class="sh-row"><span class="k"><i class="fas fa-clock"></i> Last Updated</span><span class="v">${State.lastSuccessfulLoadAt ? escapeHtml(new Date(State.lastSuccessfulLoadAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })) : '—'}</span></div>`;
}

async function loadSystemHealth() {
    const { ok, data } = await safeFetch(API.health, {}, 'health');
    State.health = ok ? data : null;
    const footer = document.getElementById('footerSystemStatus');
    if (footer) footer.textContent = ok && data?.status ? data.status : 'Unavailable';
    const cache = document.getElementById('footerCache');
    if (cache) cache.textContent = ok ? `${data.database_health || 'unknown'} · ${data.db_latency || '—'}` : '—';
    const rec = await safeFetch(API.reconciliationExceptions, {}, 'recon');
    State.recon = rec.ok ? rec.data : null;
    updateSystemHealth();
}

/* ── Needs Attention ── */
async function loadNeedsAttention() {
    const el = document.getElementById('attnList');
    if (!el) return;
    el.innerHTML = `<div class="skel" style="height:56px;border-radius:10px"></div><div class="skel" style="height:56px;border-radius:10px"></div><div class="skel" style="height:56px;border-radius:10px"></div>`;
    const { ok, data, reason } = await safeFetch(API.needsAttention, {}, 'attn');
    const s = State.stats || {};
    const fallback = [];
    if (s.pending?.deposits != null) fallback.push({ sev: s.pending.deposits > 0 ? 'warn' : 'ok', title: 'Pending Deposits', desc: s.pending.deposits > 0 ? `${s.pending.deposits} awaiting confirmation` : 'None pending', route: ROUTES.deposits + '?status=pending', icon: 'fa-clock' });
    if (s.support?.open != null) fallback.push({ sev: s.support.open > 0 ? 'crit' : 'ok', title: 'Support Tickets', desc: s.support.open > 0 ? `${s.support.open} open` : 'None open', route: ROUTES.support, icon: 'fa-headset' });
    if (s.transactions?.failed != null) fallback.push({ sev: s.transactions.failed > 0 ? 'crit' : 'ok', title: 'Failed Orders', desc: s.transactions.failed > 0 ? `${s.transactions.failed} today` : 'None today', route: ROUTES.failedOrders, icon: 'fa-circle-xmark' });

    let items = null;
    if (ok && Array.isArray(data) && data.length) {
        items = data.map(a => ({
            sev: (a.severity === 'critical' || a.severity === 'crit') ? 'crit' : (a.severity === 'warning' || a.severity === 'warn') ? 'warn' : 'ok',
            title: a.title || '',
            desc: a.description || '',
            route: a.route || '',
            icon: a.icon || 'fa-circle-exclamation'
        }));
    }
    if (!items && fallback.length) items = fallback;
    if (!items) {
        if (!ok) { renderUnavailable(el, unavailableMessage(reason), loadNeedsAttention); return; }
        el.innerHTML = `<div class="attn-empty-strip" style="grid-column:1/-1;text-align:center;color:var(--success);padding:16px;font-size:12.5px;font-weight:600"><i class="fas fa-circle-check"></i> All systems operating normally</div>`;
        document.getElementById('naCount').textContent = '0';
        return;
    }
    document.getElementById('naCount').textContent = items.length;
    el.innerHTML = items.slice(0, 3).map(a => {
        const route = a.route ? withRange(a.route) : '';
        const click = route ? ` onclick="window.location.href='${escapeHtml(route)}'"` : '';
        return `<div class="attn-chip ${a.sev}"${click}>
            <div class="aic"><i class="fas ${a.icon}"></i></div>
            <div class="body"><div class="title">${escapeHtml(a.title)}</div><div class="desc">${escapeHtml(a.desc)}</div></div>
            ${route ? '<i class="fas fa-chevron-right arrow"></i>' : ''}
        </div>`;
    }).join('');
}

/* ── Status badge ── */
function statusBadgeClass(s) {
    const v = String(s || '').toLowerCase();
    if (['completed', 'success', 'successful', 'delivered'].includes(v)) return 'success';
    if (['failed', 'cancelled', 'reversed', 'expired'].includes(v)) return 'danger';
    if (['pending', 'processing', 'confirming', 'partially_paid'].includes(v)) return 'warn';
    if (v === 'manual_review') return 'purple';
    return 'neutral';
}

/* ── Recent tables ── */
async function loadRecentTransactions() {
    const tb = document.getElementById('recentTransactionsBody');
    renderTableSkeleton(tb, 6);
    const { ok, data, reason } = await safeFetch(API.recentTransactions + '?limit=8', {}, 'rx-tx');
    if (!ok) { renderTableUnavailable(tb, 6, unavailableMessage(reason), loadRecentTransactions); return; }
    const rows = Array.isArray(data?.transactions) ? data.transactions : Array.isArray(data) ? data : [];
    if (!rows.length) { renderTableEmpty(tb, 6, 'No transactions yet'); return; }
    tb.innerHTML = rows.map(t => {
        const ccy = (t.currency || '').toUpperCase();
        const amt = formatMoney(t.amount, ccy);
        const who = getTxUser(t);
        const route = withRange(ROUTES.transactions + '?ref=' + encodeURIComponent(t.reference || ''));
        return `<tr class="row-clickable" onclick="window.location.href='${escapeHtml(route)}'">
            <td class="mono" style="font-size:10px;">${escapeHtml(t.reference || '—')}</td>
            <td><div class="cell-user"><div class="av">${escapeHtml(getInitials(who.username))}</div><div class="meta"><strong>${escapeHtml(who.username)}</strong>${who.email ? `<span>${escapeHtml(who.email)}</span>` : ''}</div></div></td>
            <td>${escapeHtml(t.type_label || t.type || '—')}</td>
            <td>${amt || '—'}</td>
            <td><span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status || 'pending')}</span></td>
            <td title="${escapeHtml(formatDateTime(t.created_at))}">${timeAgo(t.created_at)}</td>
        </tr>`;
    }).join('');
}

async function loadRecentDeposits() {
    const tb = document.getElementById('moneyMovementBody');
    renderTableSkeleton(tb, 6);
    const { ok, data, reason } = await safeFetch(API.recentDeposits + '?limit=8', {}, 'rx-dep');
    if (!ok) { renderTableUnavailable(tb, 6, unavailableMessage(reason), loadRecentDeposits); return; }
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) { renderTableEmpty(tb, 6, 'No deposits during this period'); return; }
    tb.innerHTML = rows.map(m => {
        const ccy = (m.walletCurrency || '').toUpperCase();
        const amt = formatMoney(m.walletAmount, ccy) || formatMoney(m.paymentAmount, m.paymentCurrency);
        return `<tr class="row-clickable" onclick="window.location.href='${escapeHtml(withRange(ROUTES.deposits))}'">
            <td>${escapeHtml(m.customer || '—')}</td>
            <td class="mono" style="font-size:10px;">${escapeHtml(m.reference || '—')}</td>
            <td>${amt || '—'}</td>
            <td>${escapeHtml(m.method || '—')}</td>
            <td><span class="badge ${statusBadgeClass(m.status)}">${escapeHtml(m.status || '—')}</span></td>
            <td title="${escapeHtml(formatDateTime(m.created_at))}">${timeAgo(m.created_at)}</td>
        </tr>`;
    }).join('');
}

async function loadRecentUsers() {
    const tb = document.getElementById('recentUsersBody');
    renderTableSkeleton(tb, 4);
    const { ok, data, reason } = await safeFetch(API.recentUsers + '?limit=8', {}, 'rx-users');
    if (!ok) { renderTableUnavailable(tb, 4, unavailableMessage(reason), loadRecentUsers); return; }
    const users = Array.isArray(data) ? data : [];
    if (!users.length) { renderTableEmpty(tb, 4, 'No new users during this period'); return; }
    tb.innerHTML = users.map(u => {
        const name = u.username || u.email || 'User';
        const status = u.status || 'active';
        return `<tr class="row-clickable" onclick="openUserDetailDrawer('${escapeHtml(u.id)}')">
            <td><div class="cell-user"><div class="av">${escapeHtml(getInitials(name))}</div><div class="meta"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(u.email || '')}</span></div></div></td>
            <td>${escapeHtml(u.last_location || 'N/A')}</td>
            <td>${timeAgo(u.created_at)}</td>
            <td><span class="badge ${status === 'active' ? 'success' : status === 'suspended' ? 'danger' : 'warn'}">${escapeHtml(status)}</span></td>
        </tr>`;
    }).join('');
}

async function loadFailedOrders() {
    const tb = document.getElementById('failedOrdersBody');
    renderTableSkeleton(tb, 7);
    const { ok, data, reason } = await safeFetch(API.failedOrders, {}, 'rx-fail');
    if (!ok) { renderTableUnavailable(tb, 7, unavailableMessage(reason), loadFailedOrders); return; }
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) { renderTableEmpty(tb, 7, 'No failed orders'); return; }
    tb.innerHTML = rows.map(o => `<tr class="row-clickable" onclick="window.location.href='${escapeHtml(withRange(ROUTES.failedOrders))}'">
        <td class="mono" style="font-size:10px;">${escapeHtml(o.orderRef || o.id || '—')}</td>
        <td>${escapeHtml(o.customer || '—')}</td>
        <td>${escapeHtml(o.service || '—')}</td>
        <td>${formatMoney(o.amount, o.currency) || '—'}</td>
        <td>${escapeHtml(o.provider || '—')}</td>
        <td style="max-width:180px;font-size:11px">${escapeHtml(o.reason || '—')}</td>
        <td title="${escapeHtml(formatDateTime(o.created_at))}">${timeAgo(o.created_at)}</td>
    </tr>`).join('');
}

async function loadWebhooks() {
    const tb = document.getElementById('webhookBody');
    renderTableSkeleton(tb, 5);
    const { ok, data, reason } = await safeFetch(API.webhooks + '?limit=8', {}, 'rx-wh');
    if (!ok) { renderTableUnavailable(tb, 5, unavailableMessage(reason), loadWebhooks); return; }
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) { renderTableEmpty(tb, 5, 'No webhook activity'); return; }
    tb.innerHTML = rows.map(w => `<tr class="row-clickable" onclick="window.location.href='${escapeHtml(withRange(ROUTES.webhooks))}'">
        <td>${escapeHtml(w.provider || '—')}</td>
        <td>${escapeHtml(w.event || '—')}</td>
        <td><span class="badge ${statusBadgeClass(w.status)}">${escapeHtml(w.status || '—')}</span></td>
        <td class="mono" style="font-size:10px;">${escapeHtml(w.reference || '—')}</td>
        <td title="${escapeHtml(formatDateTime(w.received_at))}">${timeAgo(w.received_at)}</td>
    </tr>`).join('');
}

/* ── Tabs ── */
function switchTab(tab) {
    State.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
    const link = document.getElementById('recentViewAll');
    if (link) link.href = tab === 'tx' ? withRange(ROUTES.transactions) : tab === 'dep' ? withRange(ROUTES.deposits) : withRange(ROUTES.users);
    if (!State.recentLoaded[tab]) {
        State.recentLoaded[tab] = true;
        if (tab === 'tx') loadRecentTransactions();
        else if (tab === 'dep') loadRecentDeposits();
        else loadRecentUsers();
    }
}

/* ── Drawers ── */
async function openLoginsTodayDrawer() {
    openDrawer({ icon: 'fa-right-to-bracket', title: 'Logins Today', sub: 'Distinct users who started a session', bodyHtml: `<div class="dd-empty">Loading…</div>` });
    const { ok, data, reason } = await safeFetch(API.loginsToday + '?limit=100', {}, 'logins');
    if (!ok || !data) {
        document.getElementById('ddBody').innerHTML = `<div class="dd-empty">${escapeHtml(unavailableMessage(reason))}</div>`;
        return;
    }
    const users = Array.isArray(data.users) ? data.users : [];
    const count = data.count ?? users.length;
    const dev = data.deviceBreakdown || {};
    document.getElementById('ddBody').innerHTML = `
        <div class="dd-stat-grid">
            <div class="dd-stat"><div class="k">Unique Users</div><div class="v">${count}</div></div>
            <div class="dd-stat"><div class="k">Window</div><div class="v" style="font-size:12px">${data.from ? escapeHtml(formatDateShort(data.from)) : '—'}</div></div>
        </div>
        <div class="dd-section"><div class="dd-section-title">Device Breakdown</div>
            ${Object.keys(dev).length ? Object.entries(dev).map(([k, v]) => `<div class="dd-field"><span class="k">${escapeHtml(k)}</span><span class="v">${v} session(s)</span></div>`).join('') : '<div class="dd-empty">No device data.</div>'}
        </div>
        <div class="dd-section"><div class="dd-section-title">Users (${users.length})</div>
            ${users.length ? users.map(u => `<div class="dd-user-item" role="button" tabindex="0" onclick="openUserDetailDrawer('${escapeHtml(u.user_id)}')"><div class="av">${escapeHtml(getInitials(u.username || u.email || 'U'))}</div><div class="meta"><strong>${escapeHtml(u.username || u.email || 'User')}</strong><span>${escapeHtml(u.email || '')}</span></div><div class="rt">${escapeHtml(timeAgo(u.first_session_at))}</div></div>`).join('') : '<div class="dd-empty">No logins recorded.</div>'}
        </div>`;
}

async function openUserDetailDrawer(userId) {
    if (!userId) return;
    openDrawer({ icon: 'fa-user', title: 'User Detail', sub: 'Loading…', bodyHtml: `<div class="dd-empty">Loading user…</div>` });
    const { ok, data, reason } = await safeFetch(`${API.userDetailBase}/${encodeURIComponent(userId)}/detail`, {}, 'user-' + userId);
    if (!ok || !data) {
        document.getElementById('ddBody').innerHTML = `<div class="dd-empty">${escapeHtml(unavailableMessage(reason))}</div>`;
        return;
    }
    const u = data.user || data;
    document.getElementById('ddTitle').textContent = u.username || u.email || 'User';
    document.getElementById('ddSub').textContent = u.email || userId;
    const w = data.wallet || {}, st = data.stats || {}, tx = data.recent_transactions || [];
    document.getElementById('ddBody').innerHTML = `
        <div class="dd-stat-grid">
            <div class="dd-stat"><div class="k">NGN Wallet</div><div class="v">${formatMoney(w.ngn, 'NGN') || '—'}</div></div>
            <div class="dd-stat"><div class="k">USD Wallet</div><div class="v">${formatMoney(w.usd, 'USD') || '—'}</div></div>
        </div>
        <div class="dd-section"><div class="dd-section-title">Profile</div>
            <div class="dd-field"><span class="k">Username</span><span class="v">${escapeHtml(u.username || '—')}</span></div>
            <div class="dd-field"><span class="k">Email</span><span class="v">${escapeHtml(u.email || '—')}</span></div>
            <div class="dd-field"><span class="k">Phone</span><span class="v">${escapeHtml(u.phone || '—')}</span></div>
            <div class="dd-field"><span class="k">Role</span><span class="v">${escapeHtml(u.role || 'user')}</span></div>
            <div class="dd-field"><span class="k">Status</span><span class="v"><span class="badge ${statusBadgeClass(u.status)}">${escapeHtml(u.status || 'active')}</span></span></div>
            <div class="dd-field"><span class="k">Registered</span><span class="v">${escapeHtml(formatDateTime(u.created_at))}</span></div>
        </div>
        <div class="dd-section"><div class="dd-section-title">Activity</div>
            <div class="dd-field"><span class="k">Total</span><span class="v">${formatNumber(st.total_transactions) ?? 0}</span></div>
            <div class="dd-field"><span class="k">Completed</span><span class="v">${formatNumber(st.completed) ?? 0}</span></div>
            <div class="dd-field"><span class="k">Pending</span><span class="v">${formatNumber(st.pending) ?? 0}</span></div>
            <div class="dd-field"><span class="k">Failed</span><span class="v">${formatNumber(st.failed) ?? 0}</span></div>
        </div>
        <div class="dd-section"><div class="dd-section-title">Recent Transactions (${tx.length})</div>
            ${tx.length ? tx.slice(0, 6).map(t => `<div class="dd-field"><span class="k">${escapeHtml(t.type_label || t.type || '')}</span><span class="v">${formatMoney(t.amount, t.currency) || '—'} · ${timeAgo(t.created_at)}</span></div>`).join('') : '<div class="dd-empty">No transactions.</div>'}
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
            <button class="modal-btn" onclick="window.location.href='${escapeHtml(ROUTES.users)}?id=${encodeURIComponent(u.id || userId)}'">Open Full Profile</button>
            <button class="modal-btn" onclick="window.location.href='${escapeHtml(ROUTES.transactions)}?user=${encodeURIComponent(u.id || userId)}'">View Transactions</button>
        </div>`;
}

/* ── Quick actions ── */
const QUICK_ACTIONS = [
    { i: 'fa-arrow-right-arrow-left', t: 'Transactions', d: 'All transactions', u: ROUTES.transactions },
    { i: 'fa-wallet', t: 'Deposits', d: 'View deposits', u: ROUTES.deposits },
    { i: 'fa-user', t: 'Users', d: 'Manage users', u: ROUTES.users },
    { i: 'fa-clipboard-list', t: 'Orders', d: 'All orders', u: ROUTES.orders },
    { i: 'fa-rotate', t: 'Reconciliation', d: 'Provider vs ledger', u: ROUTES.reconciliation },
    { i: 'fa-server', t: 'Providers', d: 'Provider health', u: ROUTES.providers },
    { i: 'fa-plug', t: 'Webhooks', d: 'Webhook activity', u: ROUTES.webhooks },
    { i: 'fa-file-lines', t: 'Reports', d: 'Export reports', u: ROUTES.reports }
];

function renderQuickActions() {
    const g = document.getElementById('quickActions');
    if (!g) return;
    g.innerHTML = '';
    QUICK_ACTIONS.forEach(a => {
        const el = document.createElement('div');
        el.className = 'qa-card';
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.innerHTML = `<i class="fas ${a.i} qa-ic" aria-hidden="true"></i><span class="qa-title">${escapeHtml(a.t)}</span><span class="qa-desc">${escapeHtml(a.d)}</span>`;
        const go = () => window.location.href = withRange(a.u);
        el.addEventListener('click', go);
        el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        g.appendChild(el);
    });
}

/* ── Admin profile + greeting ── */
async function loadAdminProfile() {
    const { ok, data } = await safeFetch(API.me, {}, 'me');
    if (!ok || !data?.user) return;
    const user = data.user;
    const name = user.username || (user.email ? user.email.split('@')[0] : 'Admin');
    const role = user.role || 'admin';
    const initials = getInitials(name);
    document.getElementById('adminName').textContent = name;
    document.getElementById('adminRole').textContent = role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, ' ');
    document.getElementById('adminAvatar').textContent = initials;
    document.getElementById('chipName').textContent = name;
    document.getElementById('chipRole').textContent = role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, ' ');
    document.getElementById('chipAvatar').textContent = initials;
    updateGreeting(name);
}

function updateGreeting(name) {
    const h = new Date().getHours();
    const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    const display = name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Admin';
    document.getElementById('greeting').innerHTML = `Good ${part}, ${escapeHtml(display)} <span aria-hidden="true">👋</span>`;
}

function updateLastUpdated() {
    State.lastSuccessfulLoadAt = new Date();
    
    // 1. Update the footer time
    const footer = document.getElementById('footerLastUpdated');
    if (footer) footer.textContent = formatDateTime(State.lastSuccessfulLoadAt.toISOString());
    
    // 2. Update the Live Dot and Label
    const liveDot = document.getElementById('liveDot');
    const liveLabel = document.getElementById('liveDotLabel');
    const lastUpdated = document.getElementById('lastUpdated');
    
    if (liveDot) liveDot.classList.remove('off'); // Re-enable pulsing
    if (liveLabel) liveLabel.textContent = 'Live data';
    if (lastUpdated) lastUpdated.textContent = `Updated ${timeAgo(State.lastSuccessfulLoadAt.toISOString())}`;
    
    // 3. Update System Health card
    updateSystemHealth();
}

function markConnectionIssue() {
    const liveDot = document.getElementById('liveDot');
    const liveLabel = document.getElementById('liveDotLabel');
    
    if (liveDot) liveDot.classList.add('off'); // Stop pulsing, turn red
    if (liveLabel) liveLabel.textContent = 'Unable to update';
    
    const footer = document.getElementById('footerSystemStatus');
    if (footer) footer.textContent = 'Unable to update';
}
/* ── Master load ── */
async function loadAll({ skeletons = true } = {}) {
    if (skeletons) renderKpiSkeleton();
    
    const { ok, data: stats, reason } = await safeFetch(API.stats, {}, 'stats');
    
    if (!ok) {
        markConnectionIssue(); // <── ADDED: Turns the dot red & says "Unable to update"
        renderUnavailable(document.getElementById('kpiGrid'), unavailableMessage(reason), () => loadAll({ skeletons: true }));
        showToast('Unable to load dashboard stats.', 'error');
        return false;
    }
    
    State.stats = stats;
    renderKpis(stats);
    updateLastUpdated(); // <── THIS updates the dot to Green & "Updated just now"
    
    State.recentLoaded.tx = true;
    await Promise.allSettled([
        loadServicePerformance(), loadProviderHealth(), loadNeedsAttention(),
        loadFailedOrders(), loadRecentDeposits(), loadWebhooks(),
        loadRecentTransactions(), loadRecentUsers(), loadCharts()
    ]);
    return true;
}

/* ── Auto-refresh ── */
function setAutoRefresh(ms) {
    State.autoRefreshMs = Number(ms) || 0;
    if (State.autoRefreshHandle) { 
        clearInterval(State.autoRefreshHandle); 
        State.autoRefreshHandle = null; 
    }
    if (State.autoRefreshMs > 0) {
        State.autoRefreshHandle = setInterval(() => {
            if (document.hidden) return;
            loadAll({ skeletons: false });
            loadSystemHealth();
        }, State.autoRefreshMs);
    }
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
    if (!AdminSession.getToken()) { AdminSession.redirectToLogin(); return; }

    applyRange('7d'); // reference shows a 7-day window
    const now = new Date();
    document.getElementById('customFrom').value = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);
    document.getElementById('customTo').value = now.toISOString().slice(0, 10);

    // Greeting fallback until /me returns
    updateGreeting('Miles Admin');

    // Sidebar
    document.getElementById('hamburger')?.addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
        document.getElementById('scrim').classList.toggle('show');
    });
    document.getElementById('scrim')?.addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('scrim').classList.remove('show');
    });
    document.getElementById('mnavMore')?.addEventListener('click', () => {
        document.getElementById('sidebar').classList.add('open');
        document.getElementById('scrim').classList.add('show');
    });
    document.getElementById('sbToggleDesktop')?.addEventListener('click', () => document.getElementById('appRoot').classList.toggle('sb-collapsed'));
    document.getElementById('sbCollapseBtn')?.addEventListener('click', () => document.getElementById('appRoot').classList.toggle('sb-collapsed'));

    // Dark mode
    document.getElementById('darkToggle')?.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        const dark = document.documentElement.classList.contains('dark');
        document.getElementById('darkToggle').innerHTML = dark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
        destroyChart('activity');
        destroyChart('revenue');
        loadCharts();
    });

    // Logout via confirm modal
    document.getElementById('adminChip')?.addEventListener('click', async () => {
        const yes = await confirmDialog({ title: 'Sign out?', body: 'You will be signed out of the admin dashboard and returned to the login page.', danger: true, okText: 'Sign out', icon: 'fa-right-from-bracket' });
        if (yes) await AdminSession.logout();
    });
    document.getElementById('sidebarFoot')?.addEventListener('click', () => document.getElementById('adminChip').click());
    document.getElementById('sidebarFoot')?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('adminChip').click(); } });

    // Date range popover
    const popover = document.getElementById('rangePopover');
    document.getElementById('datePill')?.addEventListener('click', (e) => {
        if (e.target.closest('#datePillDropdown') || e.target.closest('#datePillText') || e.target === e.currentTarget) {
            popover.classList.toggle('show');
        }
    });
    popover?.addEventListener('click', (e) => {
        const btn = e.target.closest('.range-opt');
        if (!btn) return;
        const k = btn.dataset.range;
        popover.classList.remove('show');
        if (k === 'custom') {
            document.getElementById('customRange').classList.add('show');
        } else {
            document.getElementById('customRange').classList.remove('show');
            applyRange(k);
            State.recentLoaded = { tx: true, dep: false, users: false };
            loadAll({ skeletons: true });
            loadSystemHealth();
        }
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#datePill') && !e.target.closest('#rangePopover')) popover?.classList.remove('show');
    });
    document.getElementById('customApply')?.addEventListener('click', () => {
        applyRange('custom', { customFrom: document.getElementById('customFrom').value, customTo: document.getElementById('customTo').value });
        State.recentLoaded = { tx: true, dep: false, users: false };
        loadAll({ skeletons: true });
        loadSystemHealth();
    });

    // Refresh
    document.getElementById('refreshBtn')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        btn.classList.add('spinning');
        Promise.allSettled([loadAll({ skeletons: false }), loadSystemHealth()]).finally(() => {
            btn.disabled = false;
            btn.classList.remove('spinning');
            showToast('Dashboard refreshed.', 'success');
        });
    });

    // Search — routes to /admin/transactions?search=
    document.getElementById('globalSearch')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const q = e.currentTarget.value.trim();
           if (q) window.location.href = '/admin/transactions?search=' + encodeURIComponent(q);
        }
    });


 // ── Auto-Refresh Dropdown ──
const autoBtn = document.getElementById('autoRefreshBtn');
const autoPopover = document.getElementById('autoPopover');

if (autoBtn && autoPopover) {
    // 1. Toggle open/close
    autoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        autoPopover.style.display = autoPopover.style.display === 'flex' ? 'none' : 'flex';
    });

    // 2. Handle selection
    autoPopover.addEventListener('click', (e) => {
        const btn = e.target.closest('.range-opt');
        if (!btn) return;

        const ms = Number(btn.dataset.val) || 0;
        
        // Visual feedback
        autoPopover.querySelectorAll('.range-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // Apply the timer
        setAutoRefresh(ms);
        
        // Close menu
        autoPopover.style.display = 'none';
        
        // Toast feedback so you KNOW it applied
        const label = ms === 0 ? 'Off' : ms === 30000 ? '30 seconds' : ms === 60000 ? '1 minute' : '5 minutes';
        showToast(`Auto-refresh set to ${label}`, 'info');
    });

    // 3. Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!autoPopover.contains(e.target) && e.target !== autoBtn) {
            autoPopover.style.display = 'none';
        }
    });
}

    // Drawer close
    document.getElementById('ddClose')?.addEventListener('click', closeDrawer);
    document.getElementById('drawerScrim')?.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.getElementById('confirmModal').classList.contains('show')) closeDrawer();
    });

    // Needs-attention dismiss
    document.getElementById('naDismiss')?.addEventListener('click', () => document.getElementById('needsAttentionCard').style.display = 'none');

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    switchTab('tx');

    // Restore collapsed nav groups
    try {
        document.querySelectorAll('.nav-group').forEach(g => {
            const s = localStorage.getItem('navgroup:' + g.dataset.group);
            if (s === 'collapsed') g.classList.add('collapsed');
            if (s === 'open') g.classList.remove('collapsed');
        });
    } catch (e) {}

    loadAdminProfile();
    loadAll({ skeletons: true });
    loadSystemHealth();
    renderQuickActions();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAll({ skeletons: false }); });
window.addEventListener('beforeunload', () => { destroyChart('activity'); destroyChart('revenue'); });
window.openUserDetailDrawer = openUserDetailDrawer;
window.openLoginsTodayDrawer = openLoginsTodayDrawer;
window.toggleNavGroup = toggleNavGroup;