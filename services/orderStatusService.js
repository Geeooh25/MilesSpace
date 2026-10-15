// services/orderStatusService.js
// ─────────────────────────────────────────────────────────────────
// Compatibility shim. The real implementation lives in
// services/ordersService.js. This file exists so that legacy
// requires keep working. New code should require ordersService
// directly.
// ─────────────────────────────────────────────────────────────────

'use strict';

const ordersService = require('./ordersService');

module.exports = {
    ALLOWED_TRANSITIONS: ordersService.ALLOWED_TRANSITIONS,
    processProviderUpdate: ordersService.processProviderUpdate,
    refundOrder: ordersService.refundOrder,
    recordOrderEvent: ordersService.recordEvent
};