'use strict';

const dtoneService = require('../dtoneService');
const {
    withTimeout, TIMEOUTS, HEALTH_STRATEGY,
    shapeProviderError, sanitizeProviderError
} = require('./providerBase');

const NAME = 'dtone';
const LABEL = 'DT One';

function isConfigured() {
    return Boolean(process.env.DTONE_API_KEY && process.env.DTONE_API_SECRET);
}

function envValid() {
    const env = String(process.env.DTONE_ENV || '').toLowerCase();
    return env === 'preprod' || env === 'production';
}

function environment() {
    return String(process.env.DTONE_ENV || 'preprod').toLowerCase();
}

async function healthCheck() {
    if (!isConfigured()) {
        return {
            configured: false, reachable: false, authenticated: false, functional: false,
            healthStrategy: HEALTH_STRATEGY.BALANCE,
            errorCode: 'NOT_CONFIGURED', errorCategory: 'CONFIGURATION',
            errorMessage: 'DT One credentials missing'
        };
    }
    if (!envValid()) {
        return {
            configured: false, reachable: false, authenticated: false, functional: false,
            healthStrategy: HEALTH_STRATEGY.BALANCE,
            environment: environment(),
            errorCode: 'INVALID_ENV', errorCategory: 'CONFIGURATION',
            errorMessage: 'DTONE_ENV must be "preprod" or "production"'
        };
    }
    const started = Date.now();
    try {
        const result = await withTimeout(() => dtoneService.getBalances(), TIMEOUTS.HEALTH, 'dtone.healthCheck');
        const reachable = !!result.success;
        return {
            configured: true,
            reachable,
            authenticated: reachable,
            functional: reachable,
            latencyMs: Date.now() - started,
            environment: environment(),
            healthStrategy: HEALTH_STRATEGY.BALANCE,
            errorCode: reachable ? null : 'HEALTH_FAILED',
            errorCategory: reachable ? null : 'UNKNOWN',
            errorMessage: reachable ? null : sanitizeProviderError(result.error || 'DT One health check failed', 300),
            diagnostics: { balanceCount: Array.isArray(result.balances) ? result.balances.length : 0 }
        };
    } catch (e) {
        const shaped = shapeProviderError(e);
        return {
            configured: true, reachable: false, authenticated: false, functional: false,
            latencyMs: Date.now() - started,
            environment: environment(),
            healthStrategy: HEALTH_STRATEGY.BALANCE,
            errorCode: shaped.code,
            errorCategory: shaped.category,
            errorMessage: sanitizeProviderError(shaped.message, 300)
        };
    }
}

async function getBalance() {
    const res = await dtoneService.getBalances();
    if (!res.success) return { supported: false, error: sanitizeProviderError(res.error, 200) };
    return { supported: true, raw: res.balances };
}

module.exports = {
    name: NAME, label: LABEL, isConfigured, healthCheck,
    healthStrategy: HEALTH_STRATEGY.BALANCE,
    environment,
    getBalance,
    service: dtoneService
};