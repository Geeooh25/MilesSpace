// services/providers/providerFactory.js
// ─────────────────────────────────────────────────────────────────
// Provider registry. Loads adapters on demand; missing modules are
// skipped so a deployment without a provider still boots.
// ─────────────────────────────────────────────────────────────────

'use strict';

const REGISTRY = Object.create(null);

const KNOWN = [
    { name: 'smmwiz',       path: './smmwizProvider' },
    { name: 'paystack',     path: './paystackProvider' },
    { name: 'korapay',      path: './koraProvider' },
    { name: 'nowpayments',  path: './nowpaymentsProvider' }
];

for (const { name, path } of KNOWN) {
    try {
        const adapter = require(path);
        if (adapter && typeof adapter === 'object') {
            REGISTRY[name] = adapter;
        }
    } catch (e) {
        console.warn(`[providerFactory] ${name} adapter not loaded:`, e.message);
    }
}

function get(name) {
    return REGISTRY[String(name || '').toLowerCase()] || null;
}

function getOrThrow(name) {
    const a = get(name);
    if (!a) {
        const e = new Error(`Unknown provider: ${name}`);
        e.code = 'UNKNOWN_PROVIDER';
        e.status = 400;
        throw e;
    }
    return a;
}

function list() {
    return Object.keys(REGISTRY);
}

async function healthAll() {
    const out = {};
    for (const [name, adapter] of Object.entries(REGISTRY)) {
        try {
            out[name] = await adapter.healthCheck();
        } catch (e) {
            out[name] = { configured: false, reachable: false, lastError: e.message };
        }
    }
    return out;
}

module.exports = { get, getOrThrow, list, healthAll };