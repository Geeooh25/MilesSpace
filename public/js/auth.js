// public/js/auth.js - Frontend Authentication Handler

const SESSION_KEY = 'mx_sess';
const USER_KEY = 'mx_user';
const TOKEN_KEY = 'mx_token';

// ─── Get stored token ───
function getToken() {
    try {
        const data = JSON.parse(localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || 'null');
        return data?.token || null;
    } catch (e) {
        return null;
    }
}

// ─── Get stored user ───
function getUser() {
    try {
        const data = JSON.parse(localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || 'null');
        return data?.user || null;
    } catch (e) {
        return null;
    }
}

// ─── Save session ───
function saveSession(token, user, remember = false) {
    const data = JSON.stringify({ token, user, loggedAt: Date.now() });
    if (remember) {
        localStorage.setItem(SESSION_KEY, data);
    } else {
        sessionStorage.setItem(SESSION_KEY, data);
    }
}

// ─── Clear session ───
function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
}

// ─── Check if user is logged in ───
function isLoggedIn() {
    const token = getToken();
    if (!token) return false;
    
    // Check if token is expired (simple check - 1 hour expiry)
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload.exp && Date.now() >= payload.exp * 1000) {
            clearSession();
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

// ─── Handle API response ───
async function handleApiResponse(response) {
    const data = await response.json();
    
    // Check for session expired
    if (response.status === 401 && data.code === 'SESSION_EXPIRED') {
        clearSession();
        // Redirect to login with message
        const currentPath = window.location.pathname;
        if (!currentPath.includes('login') && !currentPath.includes('signup')) {
            window.location.href = `/signup?message=${encodeURIComponent('Session expired. Please login again.')}`;
        }
        return null;
    }
    
    return data;
}

// ─── Fetch with auth ───
async function fetchWithAuth(url, options = {}) {
    const token = getToken();
    
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };
    
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch(url, {
        ...options,
        headers
    });
    
    return handleApiResponse(response);
}

// ─── Check auth on page load ───
function checkAuth() {
    const publicPages = ['/signup', '/login', '/', '/index.html'];
    const currentPath = window.location.pathname;
    
    // Skip check for public pages
    if (publicPages.includes(currentPath) || currentPath.includes('login') || currentPath.includes('signup')) {
        // If logged in and on login page, redirect to dashboard
        if (isLoggedIn() && (currentPath === '/signup' || currentPath === '/login' || currentPath === '/')) {
            window.location.href = '/dashboard';
        }
        return;
    }
    
    // Check if user is logged in
    if (!isLoggedIn()) {
        clearSession();
        window.location.href = `/signup?message=${encodeURIComponent('Please login to continue.')}`;
        return;
    }
    
    // Verify token with server
    verifyTokenWithServer();
}

// ─── Verify token with server ───
async function verifyTokenWithServer() {
    try {
        const token = getToken();
        if (!token) {
            clearSession();
            window.location.href = '/signup';
            return;
        }
        
        const response = await fetch('/api/auth/me', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.status === 401) {
            const data = await response.json();
            if (data.code === 'SESSION_EXPIRED') {
                clearSession();
                window.location.href = `/signup?message=${encodeURIComponent('Session expired. Please login again.')}`;
            } else {
                clearSession();
                window.location.href = `/signup?message=${encodeURIComponent('Please login again.')}`;
            }
        }
    } catch (error) {
        console.error('Token verification error:', error);
    }
}

// ─── Run auth check on page load ───
document.addEventListener('DOMContentLoaded', function() {
    // Check if we should redirect to login
    const publicPages = ['/signup', '/login', '/', '/index.html'];
    const currentPath = window.location.pathname;
    
    if (!publicPages.includes(currentPath) && !currentPath.includes('login') && !currentPath.includes('signup')) {
        checkAuth();
    }
    
    // Check for message parameter
    const urlParams = new URLSearchParams(window.location.search);
    const message = urlParams.get('message');
    if (message) {
        showToast(decodeURIComponent(message), 'info');
    }
});

// ─── Show toast notification ───
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(30px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ─── Export ───
window.Auth = {
    getToken,
    getUser,
    saveSession,
    clearSession,
    isLoggedIn,
    fetchWithAuth,
    checkAuth,
    showToast
};