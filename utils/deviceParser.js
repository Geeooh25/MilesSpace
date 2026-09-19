// utils/deviceParser.js - Complete Device Detection

function parseDevice(userAgent) {
    if (!userAgent) return { device: 'Unknown Device', browser: 'Unknown', os: 'Unknown', full: 'Unknown Device · Unknown' };

    const ua = userAgent;
    let device = 'Unknown Device';
    let browser = 'Unknown';
    let os = 'Unknown';

    // ─── DETECT OS ──────────────────────────────────────────
    if (ua.includes('Windows NT 10.0')) os = 'Windows 11';
    else if (ua.includes('Windows NT 6.1')) os = 'Windows 7';
    else if (ua.includes('Windows NT 6.2')) os = 'Windows 8';
    else if (ua.includes('Windows NT 6.3')) os = 'Windows 8.1';
    else if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac OS X 10_15')) os = 'macOS Catalina';
    else if (ua.includes('Mac OS X 10_14')) os = 'macOS Mojave';
    else if (ua.includes('Mac OS X')) os = 'macOS';
    else if (ua.includes('Android 14')) os = 'Android 14';
    else if (ua.includes('Android 13')) os = 'Android 13';
    else if (ua.includes('Android 12')) os = 'Android 12';
    else if (ua.includes('Android 11')) os = 'Android 11';
    else if (ua.includes('Android 10')) os = 'Android 10';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone OS 18')) os = 'iOS 18';
    else if (ua.includes('iPhone OS 17')) os = 'iOS 17';
    else if (ua.includes('iPhone OS 16')) os = 'iOS 16';
    else if (ua.includes('iPhone OS')) os = 'iOS';
    else if (ua.includes('iPad')) os = 'iPadOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Chrome OS')) os = 'ChromeOS';

    // ─── DETECT BROWSER ──────────────────────────────────────
    if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('OPR/')) browser = 'Opera';
    else if (ua.includes('Opera')) browser = 'Opera';
    else if (ua.includes('Chrome/') && !ua.includes('Edg') && !ua.includes('OPR')) browser = 'Chrome';
    else if (ua.includes('Firefox/')) browser = 'Firefox';
    else if (ua.includes('Safari/') && !ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Safari';
    else if (ua.includes('Brave/')) browser = 'Brave';
    else if (ua.includes('Vivaldi/')) browser = 'Vivaldi';

    // ─── DETECT DEVICE TYPE ──────────────────────────────────
    if (ua.includes('iPhone')) {
        device = 'iPhone';
        // Don't guess specific model - just say iPhone
    } else if (ua.includes('iPad')) {
        device = 'iPad';
    } else if (ua.includes('Android') && (ua.includes('Mobile') || ua.includes('mobi'))) {
        device = 'Android Phone';
    } else if (ua.includes('Android')) {
        device = 'Android Tablet';
    } else if (ua.includes('Windows') && (ua.includes('Touch') || ua.includes('ARM'))) {
        device = 'Windows Tablet';
    } else if (ua.includes('Windows')) {
        device = 'Windows PC';
    } else if (ua.includes('Macintosh') || ua.includes('Mac OS X')) {
        device = 'Mac';
    } else if (ua.includes('Linux')) {
        device = 'Linux PC';
    }

    const full = `${device} · ${browser}`;

    return { device, browser, os, full };
}

module.exports = { parseDevice };