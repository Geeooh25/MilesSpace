// Sidebar initialization and management
let currentUserData = null;

async function initSidebar() {
  const sb = document.getElementById('sb');
  const ov = document.getElementById('ov');
  const hbg = document.getElementById('hbg');
  
  // Toggle sidebar on mobile
  if (hbg) {
    hbg.addEventListener('click', () => {
      if (sb) sb.classList.toggle('open');
      if (ov) ov.classList.toggle('on');
    });
  }
  
  if (ov) {
    ov.addEventListener('click', () => {
      if (sb) sb.classList.remove('open');
      ov.classList.remove('on');
    });
  }
  
  // Set active nav item based on current page
  const currentPage = window.location.pathname.split('/').pop();
  document.querySelectorAll('.sb-lnk').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPage) {
      link.classList.add('active');
    }
  });
  
  // Auto-open on desktop
  if (window.innerWidth >= 1025 && sb) {
    sb.classList.add('open');
  }
  
  // Load user data
  await loadUserData();
  
  // Setup logout
  const logoutBtn = document.querySelector('[data-logout]');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await apiCall('/auth/logout', { method: 'POST' });
      } catch(e) {}
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      window.location.href = '/signup';
    });
  }
}

async function loadUserData() {
  try {
    const result = await apiCall('/auth/me');
    if (result.success && result.data) {
      currentUserData = result.data;
      updateSidebarUI();
    }
  } catch (e) {
    console.error('Failed to load user data:', e);
  }
}

function updateSidebarUI() {
  if (!currentUserData) return;
  
  const displayName = currentUserData.username || currentUserData.email?.split('@')[0] || 'User';
  const initial = displayName.charAt(0).toUpperCase();
  
  document.querySelectorAll('[data-uav]').forEach(el => {
    el.textContent = initial;
  });
  
  document.querySelectorAll('[data-uname]').forEach(el => {
    el.textContent = displayName;
  });
  
  document.querySelectorAll('[data-uemail]').forEach(el => {
    el.textContent = currentUserData.email || '';
  });
}

// Helper API call function
async function apiCall(path, opts = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  try {
    const res = await fetch('/api' + path, { ...opts, headers });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } catch (e) {
    console.error('API Error:', e);
    throw e;
  }
}

function getToken() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || 'null');
    return session?.token || '';
  } catch(e) { return ''; }
}

// Call this on page load
document.addEventListener('DOMContentLoaded', initSidebar);