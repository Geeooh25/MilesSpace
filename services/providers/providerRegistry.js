// services/providers/providerRegistry.js
// Backward-compat shim. New code should require providerFactory directly.
'use strict';

const factory = require('./providerFactory');

module.exports = {
    register: () => { throw new Error('providerRegistry is deprecated; adapters are auto-registered by providerFactory'); },
    get:      factory.get,
    getOrThrow: factory.getOrThrow,
    list:     factory.list,
    labels:   factory.labels,
    healthOne: factory.healthOne,
    healthAll: factory.healthAll
};