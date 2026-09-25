// services/providers/providerRegistry.js
// ─────────────────────────────────────────────────────────────────
// Provider adapter registry. Adapters implement a small interface:
//
//   getOrderStatus(order)  → { status, raw }
//   verifyWebhook(req)     → { ok, eventId?, fingerprint?, payload }
//   parseWebhook(payload)  → { providerOrderId, status, raw }
//   cancelOrder(order)     → { supported: true, ... } | { supported: false }
//   refundOrder(order)     → { supported: true, ... } | { supported: false }
//
// Anything not implemented returns { supported: false } rather than
// throwing, so the admin UI can hide the corresponding action.
// ─────────────────────────────────────────────────────────────────

'use strict';

const adapters = Object.create(null);

function register(name, adapter) {
    adapters[String(name).toLowerCase()] = adapter;
}
function get(name) {
    return adapters[String(name || '').toLowerCase()] || null;
}
function list() {
    return Object.keys(adapters);
}

// ─── Adapter loader (best-effort) ───────────────────────────────
// Register each provider's adapter if the corresponding service
// module is present. Missing modules are skipped silently, so a
// deployment without a given provider still boots.

const KNOWN = [
    { name: 'smmwiz',       module: './smmwizAdapter' },
    { name: 'dtone',        module: './dtoneAdapter' },
    { name: 'vtpass',       module: './vtpassAdapter' },
    { name: 'korapay',      module: './koraAdapter' },
    { name: 'nowpayments',  module: './nowpaymentsAdapter' }
];

for (const { name, module } of KNOWN) {
    try {
        const adapter = require(module);
        if (adapter && typeof adapter === 'object') register(name, adapter);
    } catch (_) {
        // Adapter not present — skip.
    }
}

module.exports = { register, get, list };