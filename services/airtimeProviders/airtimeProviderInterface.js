// services/airtimeProviders/airtimeProviderInterface.js
// ─────────────────────────────────────────────────────────────────
// The interface every airtime provider adapter must implement.
//
// The airtime service NEVER calls a provider SDK directly. It calls
// one of these methods. Each adapter owns its own auth, request
// format, response format, status mapping, error codes, reference
// format, and currency handling.
//
// The service only knows:
//   • provider names ('dtone', 'vtpass')
//   • the shape of what comes back from these methods
//
// Contract (informational — JavaScript, so nothing enforces this at
// runtime; the airtimeService wraps every call and validates the
// response shape before trusting it):
//
//   async purchase({ order, attempt, callbackUrl })
//     → { providerTransactionId, providerReference,
//         providerStatus, statusClassId, statusId,
//         rawResponse }
//     Throws AirTimeProviderError on failure.
//
//   async getStatus({ providerTransactionId, providerReference })
//     → { classification: 'CONFIRMED_FULFILLED'
//                       | 'CONFIRMED_NOT_FULFILLED'
//                       | 'UNKNOWN',
//         providerStatus, statusClassId, statusId,
//         providerTransactionId, rawResponse }
//
//   async getProducts({ countryIso3, networkCode })
//     → Array of { providerProductId, brand, networkCode,
//                  countryIso3, faceValue, faceCurrency,
//                  wholesaleAmount, wholesaleCurrency,
//                  description }
//
//   async healthCheck()
//     → { configured, reachable, lastError }
//
//   name — string, one of 'dtone' | 'vtpass'
// ─────────────────────────────────────────────────────────────────

'use strict';

class AirTimeProviderError extends Error {
    constructor(message, { code = 'PROVIDER_ERROR', ambiguous = false, definitiveRejection = false, providerData = null } = {}) {
        super(message);
        this.name = 'AirTimeProviderError';
        this.code = code;
        this.ambiguous = ambiguous;
        this.definitiveRejection = definitiveRejection;
        this.providerData = providerData;
    }
}

module.exports = { AirTimeProviderError };