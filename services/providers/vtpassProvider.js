'use strict';

const vtpassService = require('../vtpassService');
const { withTimeout, TIMEOUTS, HEALTH_STRATEGY, sanitizeProviderError } = require('./providerBase');

const NAME = 'vtpass';
const LABEL = 'VTPass';

function isConfigured() {
    return typeof vtpassService.isConfigured === 'function'
        ? vtpassService.isConfigured()
        : Boolean(
            process.env.VTPASS_API_KEY &&
            process.env.VTPASS_PUBLIC_KEY &&
            process.env.VTPASS_SECRET_KEY
        );
}

function environment() {
    return String(process.env.VTPASS_ENV || 'sandbox').toLowerCase();
}

async function healthCheck() {
    if (!isConfigured()) {
        return {
            configured: false, reachable: false, authenticated: false, functional: false,
            healthStrategy: HEALTH_STRATEGY.CATALOGUE,
            errorCode: 'NOT_CONFIGURED', errorCategory: 'CONFIGURATION',
            errorMessage: 'VTPass credentials missing'
        };
    }
    try {
        const started = Date.now();
        const result = await withTimeout(
            () => vtpassService.healthCheck(),
            TIMEOUTS.HEALTH,
            'vtpass.healthCheck'
        );
        const reachable = !!result.connectivity;
        return {
            configured: true,
            reachable,
            authenticated: reachable,
            functional: reachable,
            latencyMs: result.responseTime ?? (Date.now() - started),
            environment: result.environment || environment(),
            healthStrategy: HEALTH_STRATEGY.CATALOGUE,
            errorCode: reachable ? null : 'HEALTH_FAILED',
            errorCategory: reachable ? null : 'PROVIDER_4XX',
            errorMessage: reachable ? null : sanitizeProviderError(result.error || 'VTPass health check failed', 300),
            diagnostics: { environment: result.environment, status: result.status }
        };
    } catch (e) {
        return {
            configured: true, reachable: false, authenticated: false, functional: false,
            healthStrategy: HEALTH_STRATEGY.CATALOGUE,
            environment: environment(),
            errorCode: e.code || 'HEALTH_FAILED',
            errorCategory: e.category || 'UNKNOWN',
            errorMessage: sanitizeProviderError(e.message, 300)
        };
    }
}

async function getBalance() {
    return { supported: false, reason: 'VTPASS_HAS_NO_BALANCE_ENDPOINT' };
}

module.exports = {
    name: NAME, label: LABEL, isConfigured, healthCheck,
    healthStrategy: HEALTH_STRATEGY.CATALOGUE,
    environment,
    getBalance,
    service: vtpassService
};