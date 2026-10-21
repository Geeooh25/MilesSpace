/* /js/notif-badge.js
   Shared notification badge — works on any page with a bell link.
   Finds <a href*="notifications"> and appends a count badge.
   Polls every 60s. Clears badge when the tab is hidden or when
   the user visits notifications.html. */

(function () {
  'use strict';

  const POLL_MS = 60_000;
  const STORAGE_KEY = 'mx_notif_unread';
  let timer = null;

  /* ── Find the bell ──────────────────────────────────────── */
  function findBells() {
    // Matches tb-icon-btn, tb-btn, mni — anything linking to notifications
    return document.querySelectorAll(
      'a[href*="notifications"], a[href*="notification"]'
    );
  }

  /* ── Render count on every bell ─────────────────────────── */
  function renderCount(n) {
    const bells = findBells();

    bells.forEach(bell => {
      // Remove existing badge
      bell.querySelector('.notif-badge')?.remove();

      // Remove the old dot if it exists (replaced by count)
      bell.querySelector('.notif-dot')?.remove();

      if (n > 0) {
        const badge = document.createElement('span');
        badge.className = 'notif-badge';
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.setAttribute('aria-label', n + ' unread notifications');
        bell.style.position = 'relative';       // ensure anchor
        bell.appendChild(badge);
      }

      // Keep the dot when we can't get a count (loading / error)
      if (n === null) {
        const dot = document.createElement('span');
        dot.className = 'notif-dot';
        bell.appendChild(dot);
      }
    });
  }

  /* ── Inject the badge styles (once) ─────────────────────── */
  function injectStyles() {
    if (document.getElementById('notif-badge-styles')) return;
    const style = document.createElement('style');
    style.id = 'notif-badge-styles';
    style.textContent = `
      .notif-badge {
        position: absolute;
        top: 4px;
        right: 4px;
        min-width: 16px;
        height: 19px;
        padding: 0 2px 4px 2px;
        border-radius: 999px;
        background: #ef4444;
        color: #fff;
        font-family: 'Inter', sans-serif;
        font-size: 9px;
        font-weight: 700;
        line-height: 16px;
        text-align: center;
        border: 2px solid #fff;
        pointer-events: none;
        z-index: 1;
        letter-spacing: -.02em;
      }
    `;
    document.head.appendChild(style);
  }

  /* ── Fetch unread count ─────────────────────────────────── */
  async function fetchCount() {
    try {
      const fetcher = (typeof window.userFetch === 'function')
        ? window.userFetch
        : (url, o) => fetch(url, { ...o, credentials: 'include' });

      const res = await fetcher('/api/notifications/unread-count', {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (res.status === 401) return null;         // not logged in
      if (!res.ok) return null;                     // endpoint missing / error

      const json = await res.json().catch(() => ({}));
      const n = Number(
        json.unread_count ??
        json.count ??
        json.unread ??
        (Array.isArray(json.data) ? json.data.length : null)
      );

      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /* ── Main refresh ───────────────────────────────────────── */
  async function refresh() {
    if (document.hidden) return;               // don't poll hidden tabs
    if (isNotificationsPage()) {
      renderCount(0);                          // clear on the notifications page
      return;
    }

    const n = await fetchCount();

    if (n === null) {
      // Endpoint not available — fall back to the old dot
      renderCount(null);
      return;
    }

    try { localStorage.setItem(STORAGE_KEY, String(n)); } catch {}
    renderCount(n);
  }

  /* ── Where are we? ──────────────────────────────────────── */
  function isNotificationsPage() {
    return /notifications(\.html)?$/i.test(location.pathname);
  }

  /* ── Boot ───────────────────────────────────────────────── */
  function boot() {
    injectStyles();

    // Render immediately from cache so there's no layout shift
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached !== null) renderCount(Number(cached));
    } catch {}

    refresh();
    timer = setInterval(refresh, POLL_MS);

    // Refresh when the tab becomes visible again
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });

    // If the user clicks the bell, clear the badge optimistically
    findBells().forEach(bell => {
      bell.addEventListener('click', () => {
        try { localStorage.setItem(STORAGE_KEY, '0'); } catch {}
        renderCount(0);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();