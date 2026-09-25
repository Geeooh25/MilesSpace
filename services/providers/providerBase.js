// services/providers/providerBase.js
// ─────────────────────────────────────────────────────────────────
// Interface contract for provider adapters.
//
// Every adapter is a plain object implementing some subset of these
// methods. If a method is not supported, the adapter should either
// omit it or return { supported: false }.
//
// The order-status pipeline checks for existence before calling.
//
//   name           — string identifier
//   getOrderStatus(order)                       → { status, raw }
//   createOrder(params)                         → { providerOrderId, raw }
//   cancelOrder(order)                          → { supported, raw }
//   refundOrder(order, amount)                  → { supported, raw }
//   verifyWebhook({ rawBody, headers, payload })→ { ok, reason, eventId?, fingerprint? }
//   parseWebhook(payload)                       → { providerOrderId, status, eventType, raw }
//   normalizeStatus(providerStatus)             → internal status
//   getBalance()                                → { supported, currency, amount }
//   healthCheck()                               → { configured, reachable, lastError }
// ─────────────────────────────────────────────────────────────────

'use strict';

class ProviderError extends Error {
    constructor(message, { code = 'PROVIDER_ERROR', ambiguous = false, definitive = false, httpStatus = 502, providerData = null } = {}) {
        super(message);
        this.name = 'ProviderError';
        this.code = code;
        this.ambiguous = ambiguous;
        this.definitive = definitive;
        this.status = httpStatus;
        this.providerData = providerData;
    }
}

function notSupported(reason) {
    return { supported: false, reason: reason || 'NOT_SUPPORTED' };
}

module.exports = { ProviderError, notSupported };