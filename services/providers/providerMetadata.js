'use strict';

// Single source of truth for provider categories, criticality, and
// monitoring policy. Every other module reads from this — nothing
// hardcodes provider lists or intervals.
const PROVIDER_METADATA = Object.freeze({
    korapay: {
        name: 'korapay',
        label: 'KoraPay',
        path: './koraProvider',
        category: 'payment_processing',
        critical: true,
        enabled: true,
        environment: 'live',
        healthStrategy: 'authenticated_read',
        healthIntervalMs: 5 * 60 * 1000,
        balanceIntervalMs: 15 * 60 * 1000,
        supportsWebhook: true,
        supportsBalance: true,
        services: ['deposits', 'payments'],
        serviceAreas: [
            { key: 'deposits',       label: 'Deposits' },
            { key: 'webhooks',       label: 'Webhooks' },
            { key: 'reconciliation', label: 'Reconciliation' }
        ],
        lastSuccessfulOperationLabel: 'Last successful deposit',
        incidentImpact: 'Deposits may be delayed'
    },
    paystack: {
        name: 'paystack',
        label: 'Paystack',
        path: './paystackProvider',
        category: 'payment_processing',
        critical: false,
        enabled: false,
        environment: 'legacy',
        healthStrategy: 'balance',
        healthIntervalMs: 15 * 60 * 1000,
        balanceIntervalMs: 30 * 60 * 1000,
        supportsWebhook: true,
        supportsBalance: true,
        services: ['deposits'],
        serviceAreas: [
            { key: 'deposits', label: 'Deposits' },
            { key: 'webhooks', label: 'Webhooks' }
        ],
        lastSuccessfulOperationLabel: 'Last successful deposit',
        incidentImpact: 'None — not routed'
    },
    nowpayments: {
        name: 'nowpayments',
        label: 'NowPayments',
        path: './nowpaymentsProvider',
        category: 'crypto_payments',
        critical: true,
        enabled: true,
        environment: process.env.NOWPAYMENTS_ENV === 'sandbox' ? 'sandbox' : 'live',
        healthStrategy: 'balance',
        healthIntervalMs: 5 * 60 * 1000,
        balanceIntervalMs: 15 * 60 * 1000,
        supportsWebhook: true,
        supportsBalance: true,
        services: ['crypto_deposits'],
        serviceAreas: [
            { key: 'crypto_deposits', label: 'Crypto deposits' },
            { key: 'webhooks',        label: 'Webhooks' },
            { key: 'reconciliation',  label: 'Reconciliation' }
        ],
        lastSuccessfulOperationLabel: 'Last successful crypto deposit',
        incidentImpact: 'Crypto deposits unavailable'
    },
    vtpass: {
        name: 'vtpass',
        label: 'VTPass',
        path: './vtpassProvider',
        category: 'digital_services',
        critical: true,
        enabled: true,
        environment: process.env.VTPASS_ENV || 'sandbox',
        healthStrategy: 'catalogue',
        healthIntervalMs: 5 * 60 * 1000,
        balanceIntervalMs: null,
        supportsWebhook: false,
        supportsBalance: false,
        services: ['airtime', 'data', 'electricity', 'tv', 'education'],
        serviceAreas: [
            { key: 'airtime',     label: 'Airtime' },
            { key: 'data',        label: 'Data' },
            { key: 'electricity', label: 'Electricity' },
            { key: 'tv',          label: 'TV' }
        ],
        lastSuccessfulOperationLabel: 'Last successful order',
        incidentImpact: 'Airtime, data, bills unavailable'
    },
    dtone: {
        name: 'dtone',
        label: 'DT One',
        path: './dtoneProvider',
        category: 'digital_services',
        critical: true,
        enabled: true,
        environment: process.env.DTONE_ENV || 'preprod',
        healthStrategy: 'balance',
        healthIntervalMs: 5 * 60 * 1000,
        balanceIntervalMs: 15 * 60 * 1000,
        supportsWebhook: true,
        supportsBalance: true,
        services: ['airtime', 'data', 'esim', 'gift_cards'],
        serviceAreas: [
            { key: 'airtime',     label: 'Airtime' },
            { key: 'data',        label: 'Data' },
            { key: 'esim',        label: 'eSIM' },
            { key: 'gift_cards',  label: 'Gift cards' }
        ],
        lastSuccessfulOperationLabel: 'Last successful top-up',
        incidentImpact: 'International top-ups unavailable'
    },
    smmwiz: {
        name: 'smmwiz',
        label: 'SMMWiz',
        path: './smmwizProvider',
        category: 'social_services',
        critical: false,
        enabled: true,
        environment: 'live',
        healthStrategy: 'balance',
        healthIntervalMs: 5 * 60 * 1000,
        balanceIntervalMs: 15 * 60 * 1000,
        supportsWebhook: true,
        supportsBalance: true,
        services: ['boost'],
        serviceAreas: [
            { key: 'boost',    label: 'Boost' },
            { key: 'webhooks', label: 'Webhooks' }
        ],
        lastSuccessfulOperationLabel: 'Last successful boost order',
        incidentImpact: 'Boost orders queued'
    },
    virtualsms: {
        name: 'virtualsms',
        label: 'VirtualSMS',
        path: './virtualSmsProvider',
        category: 'communication',
        critical: false,
        enabled: true,
        environment: 'live',
        healthStrategy: 'balance',
        healthIntervalMs: 5 * 60 * 1000,
        balanceIntervalMs: 15 * 60 * 1000,
        supportsWebhook: false,
        supportsBalance: true,
        services: ['virtual_sms'],
        serviceAreas: [
            { key: 'virtual_sms', label: 'SMS rentals' }
        ],
        lastSuccessfulOperationLabel: 'Last successful SMS rental',
        incidentImpact: 'New SMS rentals unavailable'
    }
});

function listMetadata() { return Object.values(PROVIDER_METADATA); }
function getMetadata(name) { return PROVIDER_METADATA[String(name || '').toLowerCase()] || null; }
function isEnabled(name) { const m = getMetadata(name); return !!(m && m.enabled); }
function isCritical(name) { const m = getMetadata(name); return !!(m && m.critical); }

module.exports = { PROVIDER_METADATA, listMetadata, getMetadata, isEnabled, isCritical };