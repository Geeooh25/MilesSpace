// services/airtimeProviders/dtoneAdapter.js
// ─────────────────────────────────────────────────────────────────
// DT One — Global Airtime adapter.
//
// Uses the existing services/dtoneService.js. Does NOT reimplement
// any of the DT One HTTP/status/redaction logic.
//
// The only translation this file performs is:
//   DT One's status model → the three-state classification the
//   airtime service uses for retry decisions:
//      CONFIRMED_FULFILLED
//      CONFIRMED_NOT_FULFILLED
//      UNKNOWN
//
// Nothing else. No wallet, no DB, no order state.
// ─────────────────────────────────────────────────────────────────

'use strict';

const dtone = require('../dtoneService');
const { AirTimeProviderError } = require('./airtimeProviderInterface');

const NAME = 'dtone';

// ─── purchase ────────────────────────────────────────────────────

async function purchase({ order, attempt, callbackUrl }) {
    if (!order.provider_product_id) {
        throw new AirTimeProviderError('Missing provider_product_id for DT One purchase.', {
            code: 'MISSING_PRODUCT_ID',
            definitiveRejection: false
        });
    }

    const externalId = attempt.provider_reference;
    if (!externalId) {
        throw new AirTimeProviderError('Missing provider_reference for DT One purchase.', {
            code: 'MISSING_EXTERNAL_ID'
        });
    }

    // DT One products can be RANGED_SOURCE or FIXED. The airtime service
    // resolves the mode from the product descriptor and passes it in
    // `order.product_mode`.
    const mode = order.product_mode;
    if (!mode) {
        throw new AirTimeProviderError('Missing product_mode for DT One purchase.', {
            code: 'MISSING_PRODUCT_MODE'
        });
    }

    try {
        const result = await dtone.createQuote({
            productId: order.provider_product_id,
            phone: order.phone_number,
            mode,
            sourceAmount: mode === 'RANGED_SOURCE' ? order.wholesale_amount : undefined,
            sourceCurrency: mode === 'RANGED_SOURCE' ? order.wholesale_currency : undefined,
            destinationAmount: mode === 'RANGED_DESTINATION' ? order.wholesale_amount : undefined,
            destinationCurrency: mode === 'RANGED_DESTINATION' ? order.wholesale_currency : undefined,
            callbackUrl,
            orderReference: externalId
        });

        const normalized = result.normalizedStatus || {};

        // Immediate definitive rejection surfaces here.
        if (normalized.final && normalized.status === 'failed') {
            throw new AirTimeProviderError(
                normalized.code || 'DT_ONE_REJECTED',
                {
                    code: normalized.code || 'DT_ONE_REJECTED',
                    definitiveRejection: true,
                    providerData: result.raw || null
                }
            );
        }

        return {
            providerTransactionId: String(result.transactionId || ''),
            providerReference:     String(result.externalId || externalId),
            providerStatus:        normalized.code || 'SUBMITTED',
            statusClassId:         normalized.statusClassId || null,
            statusId:              normalized.statusId || null,
            rawResponse:           result.raw || null
        };
    } catch (e) {
        if (e instanceof AirTimeProviderError) throw e;

        // Map dtoneService errors to the adapter error shape.
        if (e.definitiveRejection) {
            throw new AirTimeProviderError(e.message, {
                code: e.normalized?.code || 'DT_ONE_REJECTED',
                definitiveRejection: true,
                providerData: e.providerData || null
            });
        }
        if (e.code === 'PROVIDER_UNKNOWN') {
            throw new AirTimeProviderError(e.message, {
                code: 'PROVIDER_UNKNOWN',
                ambiguous: true
            });
        }
        throw new AirTimeProviderError(e.message || 'DT One purchase failed.', {
            code: 'PROVIDER_ERROR',
            ambiguous: true,
            providerData: e.providerData || null
        });
    }
}

// ─── getStatus ───────────────────────────────────────────────────
//
// The three-state classification is the ONLY correct answer to
// "should we retry?". Never return UNKNOWN as NOT_FULFILLED.

async function getStatus({ providerTransactionId, providerReference }) {
    let query = null;

    if (providerTransactionId) {
        try {
            query = await dtone.queryTransaction(providerTransactionId);
        } catch (e) {
            throw new AirTimeProviderError(
                `DT One status query failed: ${e.message}`,
                { code: 'PROVIDER_QUERY_FAILED', ambiguous: true }
            );
        }
    }

    if ((!query || query.notFound || query.status === 'not_found') && providerReference) {
        try {
            const byExternal = await dtone.getTransactionByExternalId(providerReference, { rich: true });
            if (byExternal?.found && byExternal.transaction) {
                const statusObj = byExternal.transaction.status || {};
                const normalized = dtone.normalizeStatus(statusObj);
                query = {
                    status: normalized.status,
                    providerStatus: normalized.code,
                    isFinal: normalized.final,
                    code: normalized.code,
                    statusId: normalized.statusId,
                    statusClassId: normalized.statusClassId,
                    notFound: false,
                    transactionId: byExternal.transaction.id,
                    externalId: byExternal.transaction.external_id || providerReference,
                    definitiveRejection: normalized.definitiveRejection,
                    raw: byExternal.transaction
                };
            } else {
                query = {
                    status: 'not_found',
                    providerStatus: 'NOT_FOUND',
                    isFinal: false,
                    code: 'NOT_FOUND',
                    statusId: null,
                    statusClassId: null,
                    notFound: true,
                    transactionId: providerTransactionId || null,
                    externalId: providerReference,
                    definitiveRejection: false,
                    raw: null
                };
            }
        } catch (e) {
            throw new AirTimeProviderError(
                `DT One external_id query failed: ${e.message}`,
                { code: 'PROVIDER_QUERY_FAILED', ambiguous: true }
            );
        }
    }

    if (!query) {
        return {
            classification: 'UNKNOWN',
            providerStatus: 'NO_REFERENCE',
            statusClassId: null,
            statusId: null,
            providerTransactionId: providerTransactionId || null,
            rawResponse: null
        };
    }

    const code = String(query.code || query.providerStatus || '').toUpperCase();

    // ── CONFIRMED_FULFILLED ─────────────────────────────────────
    if (code === 'COMPLETED' || query.status === 'completed') {
        return {
            classification: 'CONFIRMED_FULFILLED',
            providerStatus: code || 'COMPLETED',
            statusClassId: query.statusClassId || null,
            statusId: query.statusId || null,
            providerTransactionId: query.transactionId || providerTransactionId || null,
            rawResponse: query.raw || null
        };
    }

    // ── CONFIRMED_NOT_FULFILLED — explicit rejections only ─────
    // Not a bare NOT_FOUND.
    if (
        code === 'REJECTED' ||
        code === 'DECLINED' ||
        code === 'CANCELLED' ||
        code === 'CANCELED' ||
        code.startsWith('REJECTED-') ||
        query.status === 'failed' ||
        query.status === 'cancelled' ||
        query.status === 'reversed'
    ) {
        return {
            classification: 'CONFIRMED_NOT_FULFILLED',
            providerStatus: code || query.status.toUpperCase(),
            statusClassId: query.statusClassId || null,
            statusId: query.statusId || null,
            providerTransactionId: query.transactionId || providerTransactionId || null,
            rawResponse: query.raw || null
        };
    }

    // ── UNKNOWN — including NOT_FOUND, timeouts, processing ────
    return {
        classification: 'UNKNOWN',
        providerStatus: code || 'UNKNOWN',
        statusClassId: query.statusClassId || null,
        statusId: query.statusId || null,
        providerTransactionId: query.transactionId || providerTransactionId || null,
        rawResponse: query.raw || null
    };
}

// ─── getProducts ─────────────────────────────────────────────────
//
// DT One exposes airtime products per operator. This adapter reshapes
// the dtoneService output into the airtime service's product shape.

async function getProducts({ countryIso3 }) {
    const country = String(countryIso3 || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(country)) {
        throw new AirTimeProviderError(`Invalid country code: ${countryIso3}`, {
            code: 'INVALID_COUNTRY'
        });
    }

    const operators = await dtone.getOperators(country, 'AIRTIME');
    const out = [];

    for (const op of operators) {
        if (op.availability !== 'available') continue;

        const ranged = op.products.rangedSource[0] || op.products.rangedDestination[0];
        const fixed  = op.products.fixed || [];

        if (ranged) {
            out.push({
                providerProductId: String(ranged.productId),
                brand:             op.name,
                networkCode:       op.shortName || op.name,
                countryIso3:       country,
                faceValue:         null,
                faceCurrency:      ranged.destination?.unit || null,
                wholesaleAmount:   null,
                wholesaleCurrency: ranged.source?.unit || ranged.destination?.unit || null,
                description:       ranged.name || op.name,
                productMode:
                    op.products.rangedSource[0] ? 'RANGED_SOURCE' : 'RANGED_DESTINATION',
                operatorId:        op.id
            });
        }

        for (const f of fixed) {
            out.push({
                providerProductId: String(f.productId),
                brand:             op.name,
                networkCode:       op.shortName || op.name,
                countryIso3:       country,
                faceValue:         f.destination?.min ?? null,
                faceCurrency:      f.destination?.unit || null,
                wholesaleAmount:   f.wholesale ?? null,
                wholesaleCurrency: f.wholesaleCurrency || null,
                description:       f.name || op.name,
                productMode:       'FIXED',
                operatorId:        op.id
            });
        }
    }

    return out;
}

// ─── healthCheck ─────────────────────────────────────────────────

async function healthCheck() {
    const configured = Boolean(process.env.DTONE_API_KEY && process.env.DTONE_API_SECRET);
    if (!configured) {
        return { configured: false, reachable: false, lastError: 'Missing credentials' };
    }

    try {
        const r = await dtone.getBalances();
        return {
            configured: true,
            reachable: !!r.success,
            lastError: r.success ? null : (r.error || 'Unknown error')
        };
    } catch (e) {
        return { configured: true, reachable: false, lastError: e.message };
    }
}

module.exports = { name: NAME, purchase, getStatus, getProducts, healthCheck };