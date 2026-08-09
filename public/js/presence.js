// public/js/presence.js - COMPLETE FIXED VERSION
// ✅ Includes fetch interceptor + graceful 401/503 handling

(function() {
  'use strict';

  // ─── GLOBAL FETCH INTERCEPTOR ───
  // This must run BEFORE any fetch calls to prevent false logouts
  if (!window._presenceFetchInterceptor) {
    window._presenceFetchInterceptor = true;
    
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      return originalFetch.apply(this, args).then(async function(response) {
        if (response.status === 401) {
          let code = null;
          let url = '';
          try {
            const clone = response.clone();
            const data = await clone.json();
            code = data.code;
            url = args[0]?.url || args[0] || '';
          } catch (e) {
            // If we can't parse JSON, it might be a network error
            console.warn('⚠️ Fetch: 401 but could not parse response body');
            return response;
          }

          // ─── Only redirect for REAL auth failures ───
          const isPresenceEndpoint = url.includes('/api/presence/');
          
          // Presence endpoints: NEVER redirect — presence is non-critical
          if (isPresenceEndpoint) {
            console.warn('⚠️ Presence endpoint 401, not redirecting (code:', code || 'unknown', ')');
            return response;
          }
          
          // Other endpoints: only redirect on explicit auth failures
          if (code === 'SESSION_EXPIRED' || code === 'INVALID_TOKEN' || code === 'NO_TOKEN') {
            console.warn('🔒 Real auth failure, logging out:', code);
            if (typeof window.redirectToLogin === 'function') {
              window.redirectToLogin();
            } else {
              // Fallback redirect
              localStorage.removeItem('mx_sess');
              localStorage.removeItem('admin_sess');
              sessionStorage.clear();
              window.location.href = 'login.html';
            }
          } else {
            console.warn('⚠️ Got 401 but not a real auth failure, ignoring:', code, 'URL:', url);
          }
        }
        
        // Handle 503 (Service Unavailable) - don't redirect
        if (response.status === 503) {
          console.warn('⚠️ Service unavailable (503), not redirecting');
          return response;
        }
        
        return response;
      }).catch(function(err) {
        // Network errors should never trigger logout
        console.warn('⚠️ Fetch network error (not redirecting):', err.message);
        throw err;
      });
    };
    
    console.log('✅ Fetch interceptor installed (presence.js)');
  }

  // ─── PRESENCE TRACKER CLASS ───
  class PresenceTracker {
    constructor() {
      this.userId = null;
      this.token = null;
      this.heartbeatInterval = null;
      this.pageTrackId = null;
      this.isActive = false;
      this.lastPage = window.location.pathname;
      this.isAdmin = false;
      this.apiBase = '/api/presence';
      this.tabId = this.generateTabId();
      this.isPageVisible = !document.hidden;
      this.offlineSent = false;
      this.isPaused = false;
      this.heartbeatCount = 0;
      this.failedAttempts = 0;
      this.maxFailedAttempts = 3;
    }

    generateTabId() {
      return 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    }

    // ─── SESSION LOOKUP ───
    getActiveSession() {
      if (typeof window.getActiveSession === 'function') {
        return window.getActiveSession();
      }
      // Fallback - direct lookup
      try {
        const user = JSON.parse(localStorage.getItem('mx_sess') || sessionStorage.getItem('mx_sess') || 'null');
        if (user?.token) return { session: user, isAdmin: false };
        const admin = JSON.parse(localStorage.getItem('admin_sess') || 'null');
        if (admin?.token) return { session: admin, isAdmin: true };
      } catch (e) {}
      return null;
    }

    getToken() {
      if (typeof window.getToken === 'function') {
        return window.getToken();
      }
      const active = this.getActiveSession();
      return active?.session?.token || '';
    }

    getUserId() {
      if (typeof window.getUserId === 'function') {
        return window.getUserId();
      }
      const active = this.getActiveSession();
      return active?.session?.userId || active?.session?.user_id || active?.session?.id || active?.session?.user?.id || null;
    }

    // ─── INITIALIZE ───
    init() {
      // Don't re-initialize if already active
      if (this.isActive && this.userId) {
        console.log('🟢 Presence already tracking for', this.userId);
        return;
      }

      // Wait a moment for session.js to load if needed
      const maxAttempts = 5;
      let attempts = 0;
      
      const tryInit = () => {
        attempts++;
        const active = this.getActiveSession();
        const userId = this.getUserId();

        if (!active || !active.session || !userId) {
          if (attempts < maxAttempts) {
            console.log(`⏳ Waiting for session... (attempt ${attempts}/${maxAttempts})`);
            setTimeout(tryInit, 300);
            return;
          }
          console.warn('⚠️ Presence: no user session found after waiting, not tracking');
          return;
        }

        const token = active.session.token || active.session.access_token;
        if (!token) {
          console.warn('⚠️ Presence: session found but missing token');
          return;
        }

        this.userId = userId;
        this.token = token;
        this.isAdmin = active.isAdmin || window.location.pathname.includes('/admin/');
        console.log(`✅ Found ${this.isAdmin ? 'admin' : 'user'} session:`, this.userId);

        this.startTracking();
        this.setupLogoutDetection();
        this.setupVisibilityDetection();
      };

      tryInit();
    }

    // ─── START TRACKING ───
    startTracking() {
      if (!this.userId || !this.token) {
        console.warn('⚠️ Cannot start tracking - missing userId or token');
        return;
      }

      console.log(`🟢 Presence tracking started for ${this.userId}`);
      this.isActive = true;
      this.offlineSent = false;
      this.isPaused = false;
      this.heartbeatCount = 0;
      this.failedAttempts = 0;

      // Send first heartbeat after a short delay
      setTimeout(() => this.sendPresence(), 500);
      this.startHeartbeat();
      this.startPageTracking();

      // Send offline on page unload
      window.addEventListener('pagehide', () => this.sendOffline());
      window.addEventListener('beforeunload', () => this.sendOffline());
    }

    // ─── LOGOUT DETECTION ───
    setupLogoutDetection() {
      const handleStorage = (e) => {
        if ((e.key === 'mx_sess' || e.key === 'admin_sess') && !e.newValue) {
          console.log('🔒 Session cleared from another tab');
          this.sendOffline();
          this.stop();
        }
      };
      window.addEventListener('storage', handleStorage);
      // Store reference for cleanup
      this._storageHandler = handleStorage;
    }

    // ─── VISIBILITY DETECTION ───
    setupVisibilityDetection() {
      const handleVisibility = () => {
        this.isPageVisible = !document.hidden;
        if (document.hidden) {
          console.log('👀 Tab hidden - pausing heartbeats');
          this.isPaused = true;
        } else {
          console.log('👀 Tab visible again - resuming');
          this.isPaused = false;
          this.offlineSent = false;
          // Reset failed attempts on resume
          this.failedAttempts = 0;
          this.sendPresence();
        }
      };
      document.addEventListener('visibilitychange', handleVisibility);
      this._visibilityHandler = handleVisibility;
    }

    // ─── SEND HEARTBEAT ───
    sendPresence(extra = {}) {
      if (this.isPaused || !this.isActive || this.offlineSent) {
        return;
      }

      // Check if we have a token
      const token = this.getToken();
      if (!token) {
        console.log('🔒 No token available — stopping presence');
        this.offlineSent = true;
        this.stop();
        return;
      }

      // Check if we still have a user ID
      const userId = this.getUserId();
      if (!userId) {
        console.log('🔒 No user ID — stopping presence');
        this.offlineSent = true;
        this.stop();
        return;
      }

      const page = window.location.pathname;
      const payload = {
        page: page,
        action: this.getPageAction(page),
        tabId: this.tabId,
        isVisible: this.isPageVisible,
        isAdmin: this.isAdmin,
        ...extra
      };

      this.heartbeatCount++;

      fetch(`${this.apiBase}/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      })
      .then(res => {
        // ✅ Handle 503 (Auth service unavailable) - don't stop tracking
        if (res.status === 503) {
          console.warn('⚠️ Auth service unavailable (503), will retry later');
          this.failedAttempts++;
          return res;
        }

        // ✅ Handle 401 gracefully
        if (res.status === 401) {
          return res.json().then(data => {
            const code = data?.code || '';
            
            // Only stop for explicit auth failures
            if (code === 'SESSION_EXPIRED' || code === 'INVALID_TOKEN' || code === 'NO_TOKEN') {
              console.log('🔒 Token invalid — stopping presence');
              this.offlineSent = true;
              this.stop();
            } else {
              console.warn('⚠️ Presence 401 but not invalid token, continuing');
              this.failedAttempts++;
            }
            return res;
          }).catch(() => {
            // If we can't parse JSON, it's probably a network error
            console.warn('⚠️ Presence 401 with no body, ignoring');
            this.failedAttempts++;
            return res;
          });
        }

        // ✅ Reset failed attempts on success
        if (res.ok) {
          this.failedAttempts = 0;
        }
        return res;
      })
      .catch((err) => {
        // ✅ Network errors should NOT trigger logout
        console.warn('⚠️ Presence network error (will retry):', err.message);
        this.failedAttempts++;
        
        // If too many failures, slow down heartbeats but don't stop
        if (this.failedAttempts > this.maxFailedAttempts) {
          console.warn('⚠️ Too many failed presence attempts, backing off');
        }
      });
    }

    // ─── SEND OFFLINE ───
    sendOffline() {
      if (this.offlineSent || !this.userId) return;
      this.offlineSent = true;
      console.log(`📤 Sending offline signal`);

      const token = this.getToken();
      if (!token) return;

      try {
        fetch(`${this.apiBase}/offline`, {
          method: 'POST',
          keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ tabId: this.tabId })
        }).catch(() => {});
      } catch (e) {
        try {
          const blob = new Blob([JSON.stringify({ tabId: this.tabId })], { type: 'application/json' });
          navigator.sendBeacon(`${this.apiBase}/offline-beacon`, blob);
        } catch (e2) {}
      }
    }

    // ─── HEARTBEAT LOOP ───
    startHeartbeat() {
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      console.log('💓 Heartbeat every 15s');
      
      const heartbeatInterval = 15000;
      let backoff = 1;
      
      this.heartbeatInterval = setInterval(() => {
        // If too many failures, reduce frequency
        if (this.failedAttempts > this.maxFailedAttempts) {
          backoff = Math.min(backoff * 1.5, 4);
          console.log(`⏳ Backing off presence (${backoff}x delay)`);
        } else {
          backoff = 1;
        }
        
        if (!this.offlineSent && !this.isPaused) {
          this.sendPresence();
        }
      }, heartbeatInterval * backoff);
    }

    // ─── PAGE CHANGE TRACKING ───
    startPageTracking() {
      if (this.pageTrackId) clearInterval(this.pageTrackId);
      this.pageTrackId = setInterval(() => {
        const currentPage = window.location.pathname;
        if (currentPage !== this.lastPage) {
          this.lastPage = currentPage;
          if (!this.offlineSent && !this.isPaused) {
            this.sendPresence({ action: this.getPageAction(currentPage) });
          }
        }
      }, 2000);
    }

    getPageAction(page) {
      const actions = {
        '/dashboard': 'viewing dashboard',
        '/admin/dashboard': 'viewing admin dashboard',
        '/admin': 'viewing admin panel',
        '/wallet': 'managing wallet',
        '/fund': 'funding wallet',
        '/market': 'browsing marketplace',
        '/boost': 'browsing boosts',
        '/giftcards': 'browsing gift cards',
        '/gifts': 'browsing gifts',
        '/virtual': 'buying virtual number',
        '/history': 'viewing history',
        '/profile': 'viewing profile',
        '/admin/users': 'viewing users',
        '/admin/reports': 'viewing reports',
        '/admin/support': 'viewing support',
      };
      for (const [path, action] of Object.entries(actions)) {
        if (page === path || page.startsWith(path + '/')) return action;
      }
      return 'viewing page';
    }

    // ─── STOP ───
    stop() {
      this.isActive = false;
      clearInterval(this.heartbeatInterval);
      clearInterval(this.pageTrackId);
      this.heartbeatInterval = null;
      this.pageTrackId = null;
      console.log('⏹️ Presence tracking stopped');
    }

    // ─── RESTART ───
    restart() {
      this.stop();
      this.offlineSent = false;
      this.isPaused = false;
      this.failedAttempts = 0;
      setTimeout(() => this.init(), 100);
    }
  }

  // ─── GLOBAL LOGOUT HOOK ───
  window.logoutPresence = function() {
    if (window.presenceTracker) {
      window.presenceTracker.sendOffline();
      window.presenceTracker.stop();
      delete window.presenceTracker;
    }
  };

  // ─── AUTO-INIT ───
  function bootPresence() {
    if (!window.presenceTracker) {
      const tracker = new PresenceTracker();
      tracker.init();
      window.presenceTracker = tracker;
    }
  }

  // Wait for DOM ready, then boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      // Small delay to let session.js initialize
      setTimeout(bootPresence, 200);
    });
  } else {
    setTimeout(bootPresence, 200);
  }

  // ─── PAGE UNLOAD ───
  window.addEventListener('pagehide', () => {
    if (window.presenceTracker) {
      window.presenceTracker.sendOffline();
    }
  });

  // ─── HANDLE BROWSER BACK/FORWARD ───
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && window.presenceTracker) {
      window.presenceTracker.isPaused = false;
      window.presenceTracker.offlineSent = false;
      window.presenceTracker.failedAttempts = 0;
      setTimeout(() => window.presenceTracker.sendPresence(), 500);
    }
  });

  // ─── DEBUG HELPERS ───
  window.debugPresence = function() {
    const t = window.presenceTracker;
    console.log('🔍 ========== PRESENCE DEBUG ==========');
    console.log('👤 User ID:', t?.userId || 'None');
    console.log('👑 Is Admin:', t?.isAdmin || false);
    console.log('🟢 Is Active:', t?.isActive || false);
    console.log('📤 Offline Sent:', t?.offlineSent || false);
    console.log('📱 Tab ID:', t?.tabId || 'None');
    console.log('👁️ Page Visible:', t?.isPageVisible || false);
    console.log('⏸️ Paused:', t?.isPaused || false);
    console.log('💓 Heartbeat Count:', t?.heartbeatCount || 0);
    console.log('❌ Failed Attempts:', t?.failedAttempts || 0);
    console.log('📄 Current Page:', window.location.pathname);
    console.log('==========================================');
  };

  window.forcePresenceUpdate = function() {
    if (window.presenceTracker) {
      window.presenceTracker.sendPresence();
      console.log('🔄 Forced heartbeat sent');
    }
  };

  window.restartPresence = function() {
    if (window.presenceTracker) {
      window.presenceTracker.restart();
    } else {
      const tracker = new PresenceTracker();
      tracker.init();
      window.presenceTracker = tracker;
    }
    console.log('🔄 Presence tracker restarted');
  };

  console.log('🔧 Presence tracker loaded. Commands:');
  console.log('  debugPresence() - Show current presence state');
  console.log('  forcePresenceUpdate() - Send manual heartbeat');
  console.log('  restartPresence() - Restart presence tracking');
  console.log('  logoutPresence() - Send offline signal and stop tracking');
})();