// scripts/lib/redact.js
// Redacts secrets before they hit logs.

'use strict';

function redactUrl(s) {
    if (!s || typeof s !== 'string') return s;
    return s.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:[REDACTED]@');
}

function redactEnvName(name) {
    if (!name) return name;
    const upper = String(name).toUpperCase();
    if (/(PASSWORD|SECRET|KEY|TOKEN|PASSPHRASE)/.test(upper)) {
        return `${name}=[REDACTED]`;
    }
    return name;
}

module.exports = { redactUrl, redactEnvName };