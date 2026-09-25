// services/airtimeProviders/vtpassAdapter.js
// ─────────────────────────────────────────────────────────────────
// VTpass — Nigeria Airtime adapter.
//
// This is the only file that knows anything about VTpass's API.
// Do not move its logic anywhere else. When VTpass changes its
// request format, this file is the only thing that changes.
//
// Status mapping: VTpass uses a small set of literal strings
// ("delivered", "failed", "pending", "reversed", etc.). This adapter
// maps them onto the same three-state classification DT One uses, so
// the airtime service can make a single retry decision regardless of
// provider.
//
// If the repo already has a VTpass integration, replace the two
// functions marked "REPLACE:" below. Nothing else in this file
// changes.
// ─────────────────────────────────────────────────────────────────

'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { AirTimeProviderError } = require('./airtimeProviderInterface');

const NAME = 'vtpass';

const BASE_URL = process.env.VTPASS_ENV === 'production'
    ? 'https://vtpass.com/api'
    : 'https://sandbox.vtpass.com/api';

// ─── HTTP client ─────────────────────────────────────────────────

const client = axios.create({
    baseURL: BASE_URL,
    timeout: 20000,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

// ─── Request signing / auth ──────────────────────────────────────
//
// VTpass uses API key + public key + secret key headers. We never
// log these. They come from the environment only.

function authHeaders() {
    const apiKey = process.env.VTPASS_API_KEY;
    const publicKey = process.env.VTPASS_PUBLIC_KEY;
    const secretKey = process.env.VTPASS_SECRET_KEY;

    if (!apiKey || !publicKey || !secretKey) {
        throw new AirTimeProviderError(
            'VTpass credentials not configured.',
            { code: 'PROVIDER_NOT_CONFIGURED' }
        );
    }

    return {
        'api-key':     apiKey,
        'public-key':  publicKey,
        'secret-key':  secretKey
    };
}

// ─── purchase ────────────────────────────────────────────────────
//
// VTpass requires a network code (mtn, airtel, glo, etisalat) and a
// phone number. Amount is in NGN.

async function purchase({ order, attempt, callbackUrl }) {
    if (!order.phone_number) {
        throw new AirTimeProviderError('Missing phone_number.', { code: 'MISSING_PHONE' });
    }
    if (!order.network_code) {
        throw new AirTimeProviderError('Missing network_code.', { code: 'MISSING_NETWORK' });
    }
    if (!order.wholesale_amount || Number(order.wholesale_amount) <= 0) {
        throw new AirTimeProviderError('Invalid wholesale_amount.', { code: 'INVALID_AMOUNT' });
    }

    const requestId = attempt.provider_reference;
    if (!requestId) {
        throw new AirTimeProviderError('Missing provider_reference.', { code: 'MISSING_REQUEST_ID' });
    }

    const body = {
        request_id:  requestId,
        serviceID:   order.network_code,       // 'mtn-airtime', 'airtel-airtime', etc.
        amount:      Number(order.wholesale_amount),
        phone:       order.phone_number
    };

    let res;
    try {
        // REPLACE: if the repo has an existing VTpass module, call it
        // instead of raw axios. The response shape stays the same.
        res = await client.post('/pay', body, { headers: authHeaders() });
    } catch (e) {
        const status = e.response?.status;
        const data = e.response?.data || null;

        // Definitive provider rejections from VTpass typically come
        // back as HTTP 200 with a body code. Only network errors are
        // ambiguous.
        const isNetwork =
            !status ||
            status >= 500 ||
            ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(e.code) ||
            String(e.message || '').toLowerCase().includes('timeout');

        throw new AirTimeProviderError(
            `VTpass purchase failed: ${e.message}`,
            {
                code: isNetwork ? 'PROVIDER_NETWORK' : 'PROVIDER_ERROR',
                ambiguous: isNetwork,
                definitiveRejection: false,
                providerData: data
            }
        );
    }

    const data = res.data || {};
    const content = data.content || {};
    const providerStatus = String(
        content.transactions?.status || data.code || ''
    ).toUpperCase();

    // VTpass returns an initial "pending" state. Definitive rejections
    // appear as a non-zero `code` in the top-level body.
    const bodyCode = String(data.code || '').toUpperCase();
    if (bodyCode && bodyCode !== '000' && bodyCode !== '099') {
        throw new AirTimeProviderError(
            data.response_description || `VTpass rejected: ${bodyCode}`,
            {
                code: `VTPASS_${bodyCode}`,
                definitiveRejection: true,
                providerData: data
            }
        );
    }

    return {
        providerTransactionId: String(content.transactions?.transactionId || content.transactions?.transaction_id || ''),
        providerReference:     String(content.transactions?.unique_element || requestId),
        providerStatus:        providerStatus || 'PENDING',
        statusClassId:         null,
        statusId:              null,
        rawResponse:           data
    };
}

// ─── getStatus ───────────────────────────────────────────────────
//
// VTpass exposes a status endpoint by request_id. We classify the
// response into the same three-state model.

const FULFILLED_VTPASS = new Set(['DELIVERED', 'SUCCESS', 'SUCCESSFUL', 'COMPLETED']);
const NOT_FULFILLED_VTPASS = new Set(['FAILED', 'REVERSED', 'CANCELLED', 'CANCELED', 'ABANDONED']);

async function getStatus({ providerTransactionId, providerReference }) {
    const requestId = providerReference || providerTransactionId;
    if (!requestId) {
        return {
            classification: 'UNKNOWN',
            providerStatus: 'NO_REFERENCE',
            statusClassId: null,
            statusId: null,
            providerTransactionId: null,
            rawResponse: null
        };
    }

    let data;
    try {
        const res = await client.get('/requery', {
            params: { request_id: requestId },
            headers: authHeaders()
        });
        data = res.data || {};
    } catch (e) {
        const status = e.response?.status;
        const isNetwork =
            !status ||
            status >= 500 ||
            ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(e.code) ||
            String(e.message || '').toLowerCase().includes('timeout');

        throw new AirTimeProviderError(
            `VTpass status query failed: ${e.message}`,
            {
                code: isNetwork ? 'PROVIDER_NETWORK' : 'PROVIDER_ERROR',
                ambiguous: isNetwork,
                providerData: e.response?.data || null
            }
        );
    }

    const content = data.content || {};
    const tx = content.transactions || {};
    const providerStatus = String(tx.status || '').toUpperCase();

    if (FULFILLED_VTPASS.has(providerStatus)) {
        return {
            classification: 'CONFIRMED_FULFILLED',
            providerStatus,
            statusClassId: null,
            statusId: null,
            providerTransactionId: String(tx.transactionId || tx.transaction_id || requestId),
            rawResponse: data
        };
    }

    if (NOT_FULFILLED_VTPASS.has(providerStatus)) {
        return {
            classification: 'CONFIRMED_NOT_FULFILLED',
            providerStatus,
            statusClassId: null,
            statusId: null,
            providerTransactionId: String(tx.transactionId || tx.transaction_id || requestId),
            rawResponse: data
        };
    }

    return {
        classification: 'UNKNOWN',
        providerStatus: providerStatus || 'UNKNOWN',
        statusClassId: null,
        statusId: null,
        providerTransactionId: String(tx.transactionId || tx.transaction_id || requestId),
        rawResponse: data
    };
}

// ─── getProducts ─────────────────────────────────────────────────
//
// VTpass has a fixed set of Nigerian networks. We return them as
// products for the airtime service to store/route.

async function getProducts({ countryIso3 }) {
    const country = String(countryIso3 || '').toUpperCase();
    if (country !== 'NGA') {
        throw new AirTimeProviderError(
            `VTpass only serves Nigeria (got ${countryIso3}).`,
            { code: 'UNSUPPORTED_COUNTRY' }
        );
    }

    // VTpass service IDs for airtime. These are stable.
    const networks = [
        { code: 'mtn-airtime',     brand: 'MTN' },
        { code: 'airtel-airtime',  brand: 'Airtel' },
        { code: 'glo-airtime',     brand: 'Glo' },
        { code: 'etisalat-airtime', brand: '9mobile' }
    ];

    return networks.map(n => ({
        providerProductId: n.code,
        brand:             n.brand,
        networkCode:       n.code,
        countryIso3:       country,
        faceValue:         null,
        faceCurrency:      'NGN',
        wholesaleAmount:   null,
        wholesaleCurrency: 'NGN',
        description:       `${n.brand} Airtime (NGN)`,
        productMode:       'RANGED_SOURCE',
        operatorId:        null
    }));
}

// ─── healthCheck ─────────────────────────────────────────────────

async function healthCheck() {
    const configured = Boolean(
        process.env.VTPASS_API_KEY &&
        process.env.VTPASS_PUBLIC_KEY &&
        process.env.VTPASS_SECRET_KEY
    );
    if (!configured) {
        return { configured: false, reachable: false, lastError: 'Missing credentials' };
    }

    try {
        // A cheap read against the VTpass service list is enough to
        // confirm connectivity without placing a financial request.
        await client.get('/service-categories', { headers: authHeaders() });
        return { configured: true, reachable: true, lastError: null };
    } catch (e) {
        return { configured: true, reachable: false, lastError: e.message };
    }
}

module.exports = { name: NAME, purchase, getStatus, getProducts, healthCheck };