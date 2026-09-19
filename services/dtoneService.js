// services/dtoneService.js
// COMPLETE DT ONE PROVIDER INFRASTRUCTURE
// Airtime + Data + Bundles + eSIM + Gift Cards + Utilities
//
// PRODUCTION-SAFE DESIGN PRINCIPLES:
//   1. Never blindly retry a financial POST. Use external_id recovery.
//   2. Never use retryRead() for POST endpoints (confirm/cancel).
//   3. Per-page HTTP timeout; truncation is soft for informational
//      catalogs, but strict callers can require a complete fetch.
//   4. Never log un-redacted provider payloads.
//   5. Never invent provider status IDs.
//   6. Validate every ID before it goes into a URL.
//   7. Fail fast when credentials are missing in production.
//   8. Gift cards = FIXED_VALUE_PIN_PURCHASE only (voucher delivery).
//   9. Region matching must match the REQUESTED region, not any region.
//  10. Multi-quantity must throw, not silently downgrade.
//  11. Logging is quiet by default; set DTONE_LOG_VERBOSE=true to trace.
//  12. STATUS_CLASS_MAP takes precedence over STATUS_DETAIL_MAP.
//      DT One returns BOTH:
//         status.class.id  = high-level state (1,2,3,4,5,7,8,9)
//         status.id        = detailed status (10000, 20000, 30500, ...)
//      Without this distinction, insufficient-balance rejections
//      (30500 / class 3) are misclassified as "processing" forever.

const axios = require('axios');
const https = require('https');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════════
// ENVIRONMENT
// ═══════════════════════════════════════════════════════════════════════
const RAW_ENV = String(process.env.DTONE_ENV || '').toLowerCase().trim();

let DTONE_ENV;
if (RAW_ENV === 'production' || RAW_ENV === 'prod') {
    DTONE_ENV = 'production';
} else if (RAW_ENV === 'preprod' || RAW_ENV === 'preproduction' || RAW_ENV === 'sandbox') {
    DTONE_ENV = 'preprod';
} else {
    throw new Error(
        `[DTONE] DTONE_ENV must be explicitly set to "production" or "preprod". Got: "${process.env.DTONE_ENV}"`
    );
}

const BASE_URL = DTONE_ENV === 'production'
    ? 'https://dvs-api.dtone.com/v1'
    : 'https://preprod-dvs-api.dtone.com/v1';

const LOG_VERBOSE = process.env.DTONE_LOG_VERBOSE === 'true';

// ═══════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════
function assertPositiveIntegerId(value, name = 'ID') {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
        const err = new Error(`Invalid ${name}: ${value}`);
        err.code = 'INVALID_ID';
        throw err;
    }
    return id;
}

function validateExternalId(value) {
    const id = String(value || '').trim();
    if (!id || id.length > 40 || /\s/.test(id)) {
        const err = new Error('Invalid DT One external_id (must be 1-40 chars, no whitespace)');
        err.code = 'INVALID_EXTERNAL_ID';
        throw err;
    }
    return id;
}

function isAmbiguousNetworkError(error) {
    if (!error) return false;
    const status = error.response?.status;
    const code = error.code;

    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
        return false;
    }

    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(code)) return true;
    if (error.message?.includes('socket hang up')) return true;
    if (error.message?.includes('timeout')) return true;
    if (error.message?.includes('aborted')) return true;
    if ([429, 500, 502, 503, 504].includes(status)) return true;

    return false;
}

function isPublicHttpsUrl(url) {
    if (!url || typeof url !== 'string') return false;
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol !== 'https:') return false;

    const host = parsed.hostname.toLowerCase();
    if (['localhost', '0.0.0.0', '::1'].includes(host)) return false;
    if (host.endsWith('.local')) return false;
    if (/^127\./.test(host)) return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    return true;
}

// ═══════════════════════════════════════════════════════════════════════
// ISO3 → ISO2 LOOKUP
// ═══════════════════════════════════════════════════════════════════════
const ISO3_TO_ISO2 = {
    USA:'US',GBR:'GB',CAN:'CA',AUS:'AU',DEU:'DE',FRA:'FR',ITA:'IT',ESP:'ES',NLD:'NL',BEL:'BE',
    CHE:'CH',AUT:'AT',SWE:'SE',NOR:'NO',DNK:'DK',FIN:'FI',IRL:'IE',PRT:'PT',POL:'PL',CZE:'CZ',
    GRC:'GR',TUR:'TR',RUS:'RU',UKR:'UA',JPN:'JP',KOR:'KR',CHN:'CN',IND:'IN',IDN:'ID',THA:'TH',
    VNM:'VN',PHL:'PH',MYS:'MY',SGP:'SG',HKG:'HK',TWN:'TW',NZL:'NZ',ZAF:'ZA',NGA:'NG',KEN:'KE',
    GHA:'GH',EGY:'EG',MAR:'MA',TUN:'TN',DZA:'DZ',SEN:'SN',CIV:'CI',CMR:'CM',UGA:'UG',TZA:'TZ',
    ZMB:'ZM',ZWE:'ZW',BWA:'BW',NAM:'NA',MOZ:'MZ',AGO:'AO',BRA:'BR',ARG:'AR',CHL:'CL',COL:'CO',
    PER:'PE',MEX:'MX',VEN:'VE',ECU:'EC',URY:'UY',PRY:'PY',BOL:'BO',CRI:'CR',PAN:'PA',GTM:'GT',
    DOM:'DO',JAM:'JM',TTO:'TT',BRB:'BB',BHS:'BS',ISR:'IL',SAU:'SA',ARE:'AE',QAT:'QA',KWT:'KW',
    BHR:'BH',OMN:'OM',JOR:'JO',LBN:'LB',IRQ:'IQ',IRN:'IR',PAK:'PK',BGD:'BD',LKA:'LK',NPL:'NP',
    KAZ:'KZ',UZB:'UZ',AZE:'AZ',GEO:'GE',ARM:'AM',MDA:'MD',ALB:'AL',MKD:'MK',SRB:'RS',BIH:'BA',
    HRV:'HR',SVN:'SI',SVK:'SK',ROU:'RO',BGR:'BG',HUN:'HU',LTU:'LT',LVA:'LV',EST:'EE',ISL:'IS',
    LUX:'LU',MLT:'MT',CYP:'CY',AND:'AD',MCO:'MC',SMR:'SM',LIE:'LI',VAT:'VA'
};

// ═══════════════════════════════════════════════════════════════════════
// REGION CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════
const GLOBAL_REGION_CODES = new Set(['WWW', 'GLOBAL', 'WORLD']);
const REGIONAL_REGION_CODES = new Set([
    'EXX', 'EUROPE', 'ASI', 'ASIA', 'AFR', 'AFRICA', 'AME', 'AMERICAS',
    'MEA', 'MIDDLE_EAST', 'OCE', 'OCEANIA', 'EU', 'APAC', 'EMEA', 'LATAM', 'NA'
]);

const FALLBACK_COUNTRY_TO_REGIONS = {
    NGA:['AFR'],GHA:['AFR'],KEN:['AFR'],ZAF:['AFR'],EGY:['AFR','MEA'],MAR:['AFR'],TUN:['AFR'],
    DZA:['AFR'],SEN:['AFR'],CIV:['AFR'],CMR:['AFR'],UGA:['AFR'],TZA:['AFR'],ZMB:['AFR'],
    ZWE:['AFR'],BWA:['AFR'],NAM:['AFR'],MOZ:['AFR'],AGO:['AFR'],
    GBR:['EXX'],DEU:['EXX'],FRA:['EXX'],ITA:['EXX'],ESP:['EXX'],NLD:['EXX'],BEL:['EXX'],
    CHE:['EXX'],AUT:['EXX'],SWE:['EXX'],NOR:['EXX'],DNK:['EXX'],FIN:['EXX'],IRL:['EXX'],
    PRT:['EXX'],POL:['EXX'],CZE:['EXX'],GRC:['EXX'],TUR:['EXX','MEA'],RUS:['EXX'],UKR:['EXX'],
    ROU:['EXX'],BGR:['EXX'],HUN:['EXX'],HRV:['EXX'],
    USA:['AME'],CAN:['AME'],MEX:['AME'],BRA:['AME'],ARG:['AME'],CHL:['AME'],COL:['AME'],
    PER:['AME'],VEN:['AME'],ECU:['AME'],
    JPN:['ASI'],KOR:['ASI'],CHN:['ASI'],IND:['ASI'],IDN:['ASI'],THA:['ASI'],VNM:['ASI'],
    PHL:['ASI'],MYS:['ASI'],SGP:['ASI'],HKG:['ASI'],TWN:['ASI'],PAK:['ASI'],BGD:['ASI'],LKA:['ASI'],
    ISR:['MEA'],SAU:['MEA'],ARE:['MEA'],QAT:['MEA'],KWT:['MEA'],
    AUS:['OCE'],NZL:['OCE']
};

// ═══════════════════════════════════════════════════════════════════════
// DT ONE STATUS MODEL
//
// Class IDs (status.class.id) — authoritative high-level state:
//   1 CREATED, 2 CONFIRMED, 3 REJECTED, 4 CANCELLED,
//   5 SUBMITTED, 7 COMPLETED, 8 REVERSED, 9 DECLINED
//
// Detail IDs (status.id) — WHY the state is what it is:
//   10000 CREATED
//   20000 CONFIRMED
//   30000 REJECTED
//   30400 REJECTED-OPERATOR-CURRENTLY-UNAVAILABLE
//   30500 REJECTED-INSUFFICIENT-BALANCE
//   40000 CANCELLED
//   50000 SUBMITTED
//   70000 COMPLETED
//   80000 REVERSED
//   90000 DECLINED
//
// ONLY 3, 4, 7, 9 are terminal.
// ═══════════════════════════════════════════════════════════════════════

const STATUS_CLASS_MAP = {
    1: { status: 'processing', final: false, code: 'CREATED' },
    2: { status: 'processing', final: false, code: 'CONFIRMED' },
    3: { status: 'failed',     final: true,  code: 'REJECTED' },
    4: { status: 'cancelled',  final: true,  code: 'CANCELLED' },
    5: { status: 'processing', final: false, code: 'SUBMITTED' },
    7: { status: 'completed',  final: true,  code: 'COMPLETED' },
    8: { status: 'reversed',   final: true,  code: 'REVERSED' },
    9: { status: 'failed',     final: true,  code: 'DECLINED' }
};

const STATUS_DETAIL_MAP = {
    10000: { status: 'processing', final: false, code: 'CREATED' },
    20000: { status: 'processing', final: false, code: 'CONFIRMED' },
    30000: { status: 'failed',     final: true,  code: 'REJECTED' },
    30400: { status: 'failed',     final: true,  code: 'REJECTED-OPERATOR-CURRENTLY-UNAVAILABLE' },
    30500: { status: 'failed',     final: true,  code: 'REJECTED-INSUFFICIENT-BALANCE' },
    40000: { status: 'cancelled',  final: true,  code: 'CANCELLED' },
    50000: { status: 'processing', final: false, code: 'SUBMITTED' },
    70000: { status: 'completed',  final: true,  code: 'COMPLETED' },
    80000: { status: 'reversed',   final: true,  code: 'REVERSED' },
    90000: { status: 'failed',     final: true,  code: 'DECLINED' }
};

// These detail codes mean "definitive provider rejection" and MUST
// trigger an immediate refund instead of being treated as transient.
const TERMINAL_REJECTION_DETAILS = new Set([
    30000, 30400, 30500,
    40000,
    90000
]);

// ═══════════════════════════════════════════════════════════════════════
// REDACTION
// ═══════════════════════════════════════════════════════════════════════
const REDACT_KEYS = [
    'mobile_number', 'account_number', 'iccid', 'email', 'phone',
    'code', 'pin', 'voucher_code', 'redemption_code', 'serial',
    'lpa', 'activation_code', 'token', 'password', 'secret'
];

function redactForLog(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    let redacted;
    try {
        redacted = JSON.parse(JSON.stringify(obj));
    } catch {
        return '[UNSERIALIZABLE]';
    }

    const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        for (const key of Object.keys(o)) {
            if (REDACT_KEYS.includes(key) && o[key]) {
                const val = String(o[key]);
                o[key] = val.length > 6
                    ? `${val.slice(0, 3)}******${val.slice(-4)}`
                    : '******';
            } else if (typeof o[key] === 'object') {
                walk(o[key]);
            }
        }
    };
    walk(redacted);
    return redacted;
}

function cleanNameForSort(name) {
    return String(name || '').replace(/^[^a-zA-Z]+/, '').toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════
class DTOneService {
    constructor() {
        this.env = DTONE_ENV;
        this.baseUrl = BASE_URL;

        this.apiKey = process.env.DTONE_API_KEY;
        this.apiSecret = process.env.DTONE_API_SECRET;

        if (!this.apiKey || !this.apiSecret) {
            if (this.env === 'production') {
                throw new Error(
                    '[DTONE] DTONE_API_KEY and DTONE_API_SECRET are required in production'
                );
            }
            console.warn('⚠️ [DTONE] Missing credentials in preprod — calls will fail');
        }

        this.auth = Buffer.from(
            `${this.apiKey || ''}:${this.apiSecret || ''}`
        ).toString('base64');

        this.headers = {
            'Authorization': `Basic ${this.auth}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };

        this.httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 50,
            timeout: 60000
        });

        this.client = axios.create({
            httpsAgent: this.httpsAgent,
            timeout: 15000,
            headers: this.headers
        });

        this.SERVICES = {
            AIRTIME:   { service_id: '1',  subservice_id: '11' },
            DATA:      { service_id: '1',  subservice_id: '13' },
            BUNDLE:    { service_id: '1',  subservice_id: '12' },
            ESIM:      { service_id: '13', subservice_id: null },
            GIFT_CARD: {
                service_id: '4',
                subservice_id: null,
                subservices: {
                    RETAIL:        '41',
                    GAMING:        '42',
                    CASH_CARD:     '43',
                    FOOD:          '44',
                    ENTERTAINMENT: '45',
                    TRAVEL:        '46'
                }
            },
            UTILITIES: { service_id: '3',  subservice_id: null },
            TRANSPORT: { service_id: '8',  subservice_id: null }
        };

        this.LOGO_BASE = 'https://operator-logo.dtone.com';
        this.DEFAULT_LOGO = '/images/operators/default.png';

        console.log(
            `📡 [DTONE] Service initialized — ${this.env.toUpperCase()} — ${this.baseUrl}` +
            (LOG_VERBOSE ? ' (verbose logging ON)' : '')
        );
    }

    /* ═══════════════════════════════════════════════════════════════
       TRANSPORT
    ═══════════════════════════════════════════════════════════════ */

    async retryRead(fn, retries = 3, delayMs = 1000) {
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error) {
                const status = error.response?.status;

                if ([404, 400, 401, 403].includes(status)) throw error;

                const retryable = isAmbiguousNetworkError(error);
                if (!retryable || i === retries - 1) throw error;

                const wait = delayMs * Math.pow(2, i);
                console.warn(`⚠️ [DTONE READ] Retry ${i + 1}/${retries} after ${wait}ms — ${error.message}`);
                await new Promise((r) => setTimeout(r, wait));
            }
        }
    }

    async retryFinancialCreate(fn, externalId, retries = 2, delayMs = 2000) {
        const validatedExternalId = validateExternalId(externalId);
        let lastError;

        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                const status = error.response?.status;

                if ([400, 401, 403, 404, 422].includes(status)) throw error;

                if (!isAmbiguousNetworkError(error)) throw error;

                let lookupResult;
                try {
                    lookupResult = await this.getTransactionByExternalId(
                        validatedExternalId,
                        { rich: true }
                    );
                } catch (lookupErr) {
                    console.error(
                        `❌ [DTONE FINANCIAL] Lookup failed for ${validatedExternalId}: ${lookupErr.message}. Marking as AMBIGUOUS.`
                    );
                    const ambigErr = new Error(
                        `Provider outcome unknown for external_id=${validatedExternalId}`
                    );
                    ambigErr.code = 'PROVIDER_UNKNOWN';
                    ambigErr.externalId = validatedExternalId;
                    ambigErr.providerStatus = status;
                    throw ambigErr;
                }

                if (lookupResult?.found && lookupResult.transaction) {
                    console.log(`✅ [DTONE FINANCIAL] Recovered existing transaction for ${validatedExternalId}`);
                    return { recovered: true, transaction: lookupResult.transaction };
                }

                console.log(`⚠️ [DTONE FINANCIAL] external_id=${validatedExternalId} not found. Retrying (${i + 1}/${retries})`);

                if (i === retries - 1) {
                    const finalErr = new Error(
                        `Transaction creation failed after retries: ${error.message}`
                    );
                    finalErr.code = 'PROVIDER_UNKNOWN';
                    finalErr.externalId = validatedExternalId;
                    throw finalErr;
                }

                const wait = delayMs * Math.pow(2, i);
                await new Promise((r) => setTimeout(r, wait));
            }
        }

        throw lastError;
    }

    async executeFinancialAction(fn) {
        try {
            const res = await fn();
            return { success: true, data: res.data };
        } catch (error) {
            if (isAmbiguousNetworkError(error)) {
                return {
                    success: false,
                    ambiguous: true,
                    error: error.message,
                    status: error.response?.status
                };
            }
            throw error;
        }
    }

    /**
     * Paginated GET with per-request timeouts.
     *
     * By default this is soft: returns whatever it collected.
     * Pass { requireComplete: true } to receive a structured envelope:
     *    { items, truncated, truncationReason, pagesFetched }
     * for catalogs that must NOT be cached as complete if truncated.
     */
    async getAllPages(path, params = {}, options = {}) {
        const {
            maxPages = 100,
            perPage = 100,
            dedupeKey = 'id',
            interPageDelayMs = 50,
            maxTotalMs = 60000,
            requestTimeoutMs = 8000,
            onProgress = null,
            requireComplete = false
        } = options;

        const startTs = Date.now();
        const results = [];
        const seen = new Set();
        let page = 1;
        let truncated = false;
        let truncationReason = null;
        let pagesFetched = 0;

        while (page <= maxPages) {
            if (Date.now() - startTs > maxTotalMs) {
                truncated = true;
                truncationReason = `time budget exceeded (${maxTotalMs}ms) at page ${page}`;
                break;
            }

            const query = new URLSearchParams({
                ...params,
                page: String(page),
                per_page: String(perPage)
            });

            let body;
            try {
                const response = await this.retryRead(
                    () => this.client.get(`${this.baseUrl}${path}?${query.toString()}`, {
                        timeout: requestTimeoutMs
                    }),
                    2,
                    500
                );
                body = response.data;
                pagesFetched++;
            } catch (err) {
                console.warn(`⚠️ [DTONE] ${path} page ${page} failed: ${err.message}`);
                truncated = true;
                truncationReason = `page ${page} failed: ${err.message}`;
                break;
            }

            let items = [];
            if (Array.isArray(body)) items = body;
            else if (Array.isArray(body?.items)) items = body.items;
            else if (Array.isArray(body?.data)) items = body.data;
            else if (Array.isArray(body?.results)) items = body.results;

            for (const item of items) {
                const key = dedupeKey ? String(item?.[dedupeKey] ?? '') : null;
                if (key && seen.has(key)) continue;
                if (key) seen.add(key);
                results.push(item);
            }

            if (typeof onProgress === 'function') {
                try { onProgress(page, results.length); } catch {}
            }

            const hasMoreByMeta =
                body?.has_more === true ||
                body?.hasMore === true ||
                (typeof body?.total === 'number' && results.length < body.total);

            if (items.length < perPage && !hasMoreByMeta) break;

            page++;

            if (page > maxPages) {
                truncated = true;
                truncationReason = `page limit (${maxPages}) reached at ${results.length} items`;
                break;
            }

            if (interPageDelayMs > 0) {
                await new Promise((r) => setTimeout(r, interPageDelayMs));
            }
        }

        if (truncated) {
            // Only log when the caller did NOT bound the fetch
            const callerLimited = maxPages <= 1;
            if (!callerLimited) {
                console.warn(
                    `⚠️ [DTONE] ${path} pagination truncated: ${truncationReason}. Returning ${results.length} items.`
                );
            }
        }

        if (requireComplete) {
            return {
                items: results,
                truncated,
                truncationReason,
                pagesFetched
            };
        }

        return results;
    }

    /* ═══════════════════════════════════════════════════════════════
       STATUS NORMALIZATION
       Prefers class.id (high-level) over detail id (specific).
       Never silently treats an unknown terminal state as processing.
    ═══════════════════════════════════════════════════════════════ */
    normalizeStatus(status) {
        if (status == null) {
            return {
                status: 'provider_unknown',
                final: false,
                code: 'UNKNOWN_PROVIDER_STATUS',
                statusId: null,
                statusClassId: null,
                providerMessage: null,
                definitiveRejection: false
            };
        }

        const classId = Number(
            status?.class?.id ??
            status?.class?.status_id ??
            0
        ) || null;

        const detailId = Number(
            status?.id ??
            status?.status_id ??
            0
        ) || null;

        const message = String(
            status?.message ??
            status?.class?.message ??
            ''
        ).toUpperCase().trim();

        // ── 1. Class takes precedence ──────────────────────────────
        if (classId && STATUS_CLASS_MAP[classId]) {
            const base = STATUS_CLASS_MAP[classId];

            // Refine the code if the detail ID gives us more info
            const detail = detailId ? STATUS_DETAIL_MAP[detailId] : null;
            const code = detail?.code || base.code;

            return {
                status: base.status,
                final: base.final,
                code,
                statusId: detailId,
                statusClassId: classId,
                providerMessage: message || null,
                definitiveRejection: base.final && base.status === 'failed'
            };
        }

        // ── 2. Fall back to detail ID ──────────────────────────────
        if (detailId && STATUS_DETAIL_MAP[detailId]) {
            const base = STATUS_DETAIL_MAP[detailId];
            return {
                status: base.status,
                final: base.final,
                code: base.code,
                statusId: detailId,
                statusClassId: classId,
                providerMessage: message || null,
                definitiveRejection: base.final && base.status === 'failed'
            };
        }

        // ── 3. Fall back to message ───────────────────────────────
        switch (message) {
            case 'COMPLETED':
            case 'SUCCESS':
            case 'SUCCESSFUL':
            case 'DONE':
                return {
                    status: 'completed', final: true, code: 'COMPLETED',
                    statusId: detailId, statusClassId: classId,
                    definitiveRejection: false
                };

            case 'REJECTED':
            case 'REJECTED-INSUFFICIENT-BALANCE':
            case 'REJECTED-OPERATOR-CURRENTLY-UNAVAILABLE':
                return {
                    status: 'failed', final: true, code: message,
                    statusId: detailId, statusClassId: classId,
                    definitiveRejection: true
                };

            case 'DECLINED':
                return {
                    status: 'failed', final: true, code: 'DECLINED',
                    statusId: detailId, statusClassId: classId,
                    definitiveRejection: true
                };

            case 'CANCELLED':
            case 'CANCELED':
                return {
                    status: 'cancelled', final: true, code: 'CANCELLED',
                    statusId: detailId, statusClassId: classId,
                    definitiveRejection: false
                };

            case 'REVERSED':
                return {
                    status: 'reversed', final: true, code: 'REVERSED',
                    statusId: detailId, statusClassId: classId,
                    definitiveRejection: false
                };

            case 'CREATED':
            case 'CONFIRMED':
            case 'SUBMITTED':
            case 'PROCESSING':
            case 'PENDING':
            case 'IN_PROGRESS':
                return {
                    status: 'processing', final: false, code: message,
                    statusId: detailId, statusClassId: classId,
                    definitiveRejection: false
                };

            case 'NOT_FOUND':
                return {
                    status: 'not_found', final: false, code: 'NOT_FOUND',
                    statusId: detailId, statusClassId: classId,
                    definitiveRejection: false
                };

            default:
                if (LOG_VERBOSE) {
                    console.warn(
                        `⚠️ [DTONE] Unknown provider status: msg="${message}" detail=${detailId} class=${classId}`
                    );
                }
                // Never default to processing — treat as provider_unknown.
                return {
                    status: 'provider_unknown',
                    final: false,
                    code: 'UNKNOWN_PROVIDER_STATUS',
                    statusId: detailId,
                    statusClassId: classId,
                    providerMessage: message || null,
                    definitiveRejection: false
                };
        }
    }

    extractErrorMessage(errorData) {
        if (!errorData) return null;
        if (Array.isArray(errorData.errors) && errorData.errors.length) {
            return errorData.errors
                .map((e) => e.message || e.description || e.code || JSON.stringify(e))
                .filter(Boolean)
                .join('; ');
        }
        if (errorData.message) return errorData.message;
        if (errorData.error) return errorData.error;
        if (errorData.status?.message) return errorData.status.message;
        if (errorData.errors && typeof errorData.errors === 'object') {
            return JSON.stringify(errorData.errors);
        }
        return null;
    }

    /* ═══════════════════════════════════════════════════════════════
       BALANCES — used for preflight
    ═══════════════════════════════════════════════════════════════ */
    async getBalances() {
        try {
            const res = await this.retryRead(() =>
                this.client.get(`${this.baseUrl}/balances`, { timeout: 10000 })
            );
            const data = res.data;
            const balances = Array.isArray(data)
                ? data
                : (data?.balances || (data ? [data] : []));
            return { success: true, balances, raw: data };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Convenience: returns the available amount for a given currency unit.
     * Example: getAvailableBalance('NGN') → number | null
     */
    async getAvailableBalance(currencyCode) {
        const res = await this.getBalances();
        if (!res.success) return null;
        const cur = String(currencyCode || '').toUpperCase();
        const match = (res.balances || []).find(
            (b) => String(b?.unit || b?.currency || '').toUpperCase() === cur
        );
        if (!match) return null;
        const amount = Number(
            match.amount ?? match.balance ?? match.available ?? match.available_balance ?? 0
        );
        return Number.isFinite(amount) ? amount : null;
    }

    /* ═══════════════════════════════════════════════════════════════
       COUNTRIES
    ═══════════════════════════════════════════════════════════════ */
    async getCountries(serviceKey = 'AIRTIME', subserviceId = null) {
        const svc = this.SERVICES[serviceKey] || this.SERVICES.AIRTIME;
        const params = { service_id: svc.service_id };

        if (subserviceId) params.subservice_id = subserviceId;
        else if (svc.subservice_id) params.subservice_id = svc.subservice_id;

        const raw = await this.getAllPages('/countries', params, {
            dedupeKey: 'iso_code',
            maxPages: 5,
            perPage: 100,
            maxTotalMs: 20000,
            requestTimeoutMs: 8000
        });

        const countries = [];
        const seen = new Set();
        const source = Array.isArray(raw) ? raw : Object.values(raw || {});

        for (const c of source) {
            const iso3 = String(
                c.iso_code || c.iso3 || c.country_iso3 || c.code || ''
            ).toUpperCase();
            const iso2 = String(
                c.iso2 || c.country_iso2 || ISO3_TO_ISO2[iso3] || ''
            ).toUpperCase();
            const name = String(c.name || c.country_name || '').trim();

            if (!iso3 || !name || seen.has(iso3)) continue;
            seen.add(iso3);
            countries.push({ iso2, iso3, name });
        }

        countries.sort((a, b) => a.name.localeCompare(b.name));
        return countries;
    }

    /* ═══════════════════════════════════════════════════════════════
       PRODUCTS — raw fetch
    ═══════════════════════════════════════════════════════════════ */
    async getProductsRaw({ countryIsoCode, operatorId, serviceId, subserviceId, type } = {}) {
        const params = {};
        if (countryIsoCode) params.country_iso_code = String(countryIsoCode).toUpperCase();
        if (operatorId) params.operator_id = assertPositiveIntegerId(operatorId, 'operator ID');
        if (serviceId) params.service_id = serviceId;
        if (subserviceId) params.subservice_id = subserviceId;
        if (type) params.type = type;

        console.log('📡 [DTONE] Fetching products:', params);
        const products = await this.getAllPages('/products', params, { dedupeKey: 'id' });
        console.log(`  ✅ [DTONE] ${products.length} products found`);
        return products;
    }

    async getProductById(productId) {
        const id = assertPositiveIntegerId(productId, 'product ID');
        return await this.retryRead(() =>
            this.client.get(`${this.baseUrl}/products/${id}`).then((r) => r.data)
        );
    }

    /* ═══════════════════════════════════════════════════════════════
       AIRTIME PRODUCT DESCRIPTOR
    ═══════════════════════════════════════════════════════════════ */
    _describeAirtimeProduct(p) {
        if (!p || !p.id) return null;

        const modes = Array.isArray(p.accepted_calculation_modes)
            ? p.accepted_calculation_modes
            : [];

        const sourceUnit = String(p.source?.unit || '').toUpperCase();
        const destinationUnit = String(p.destination?.unit || '').toUpperCase();

        const sourceAmountObj = p.source?.amount || {};
        const destAmountObj = p.destination?.amount || {};

        const descriptor = {
            productId: p.id,
            type: p.type,
            name: p.name || `Product ${p.id}`,
            description: p.description || null,
            acceptedCalculationModes: modes,
            source: {
                unit: sourceUnit || null,
                amount: sourceAmountObj || null,
                min: sourceAmountObj?.min ?? null,
                max: sourceAmountObj?.max ?? null,
                increment: sourceAmountObj?.increment ?? null
            },
            destination: {
                unit: destinationUnit || null,
                amount: destAmountObj || null,
                min: destAmountObj?.min ?? null,
                max: destAmountObj?.max ?? null,
                increment: destAmountObj?.increment ?? null
            },
            wholesale: p.prices?.wholesale?.amount ?? null,
            wholesaleCurrency: String(p.prices?.wholesale?.unit || '').toUpperCase() || null,
            retail: p.prices?.retail?.amount ?? null,
            retailCurrency: String(p.prices?.retail?.unit || '').toUpperCase() || null,
            validity: p.validity || null
        };

        if (p.type === 'FIXED_VALUE_RECHARGE') {
            descriptor.mode = 'FIXED';
        } else if (p.type === 'RANGED_VALUE_RECHARGE') {
            if (modes.includes('SOURCE_AMOUNT')) descriptor.mode = 'RANGED_SOURCE';
            else if (modes.includes('DESTINATION_AMOUNT')) descriptor.mode = 'RANGED_DESTINATION';
            else descriptor.mode = null;
        } else {
            descriptor.mode = null;
        }

        return descriptor;
    }

    /* ═══════════════════════════════════════════════════════════════
       OPERATORS
    ═══════════════════════════════════════════════════════════════ */
    async getOperators(countryIsoCode, serviceKey = 'AIRTIME') {
        const svc = this.SERVICES[serviceKey] || this.SERVICES.AIRTIME;
        const country = String(countryIsoCode).trim().toUpperCase();

        if (!/^[A-Z]{3}$/.test(country)) {
            throw new Error(`Invalid DT One country code: ${country}`);
        }

        console.log(`📡 [DTONE] Fetching operators for ${country} (${serviceKey})...`);

        const operators = await this.getAllPages('/operators', {
            country_iso_code: country,
            service_id: svc.service_id,
            ...(svc.subservice_id && { subservice_id: svc.subservice_id })
        }, { dedupeKey: 'id' });

        if (!operators.length) {
            console.log(`  ⚠️ No operators found for ${country}`);
            return [];
        }

        let allProducts = [];
        try {
            allProducts = await this.getAllPages('/products', {
                country_iso_code: country,
                service_id: svc.service_id,
                ...(svc.subservice_id && { subservice_id: svc.subservice_id })
            }, { dedupeKey: 'id' });
        } catch (e) {
            console.warn(`  ⚠️ Bulk product fetch failed: ${e.message}`);
        }

        const productsByOperator = new Map();
        for (const p of allProducts) {
            const opId = String(p.operator?.id || p.operator_id || '');
            if (!opId) continue;
            if (!productsByOperator.has(opId)) productsByOperator.set(opId, []);
            productsByOperator.get(opId).push(p);
        }

        const results = operators.map((op) => {
            const opId = String(op.id);
            const opProducts = productsByOperator.get(opId) || [];

            const airtime = opProducts.filter((p) =>
                p.type === 'RANGED_VALUE_RECHARGE' || p.type === 'FIXED_VALUE_RECHARGE'
            );

            const described = airtime
                .map((p) => this._describeAirtimeProduct(p))
                .filter(Boolean)
                .filter((d) => d.mode);

            const fixed = described.filter((d) => d.mode === 'FIXED');
            const rangedSource = described.filter((d) => d.mode === 'RANGED_SOURCE');
            const rangedDestination = described.filter((d) => d.mode === 'RANGED_DESTINATION');

            const sourceCurrencies = Array.from(
                new Set(rangedSource.map((p) => p.source.unit).filter(Boolean))
            );

            const usdSourceProduct = rangedSource.find((p) =>
                String(p.source.unit || '').toUpperCase() === 'USD'
            ) || null;

            const destinationCurrency =
                rangedSource[0]?.destination.unit ||
                rangedDestination[0]?.destination.unit ||
                fixed[0]?.destination.unit ||
                null;

            const availability = described.length > 0
                ? 'available'
                : (allProducts.length === 0 ? 'catalog_unavailable' : 'no_usable_products');

            return {
                id: Number(op.id),
                name: op.name || op.short_name || `Operator ${op.id}`,
                shortName: op.short_name || null,
                logo: this.getOperatorLogo(op.id, 1),
                logoMedium: this.getOperatorLogo(op.id, 2),
                logoLarge: this.getOperatorLogo(op.id, 3),
                availability,
                products: { fixed, rangedSource, rangedDestination },
                capabilities: {
                    supportsUsdSource: Boolean(usdSourceProduct),
                    usdSourceProduct,
                    sourceCurrencies,
                    destinationCurrency,
                    productCount: described.length,
                    fixedDenominations: fixed
                        .map((f) => ({
                            productId: f.productId,
                            destinationAmount: f.destination.amount?.min ?? f.destination.min ?? null,
                            destinationCurrency: f.destination.unit,
                            wholesale: f.wholesale,
                            retail: f.retail
                        }))
                        .sort((a, b) => (a.destinationAmount || 0) - (b.destinationAmount || 0))
                }
            };
        });

        const sorted = results.sort((a, b) => {
            if (a.availability !== b.availability) {
                return a.availability === 'available' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

        console.log(`✅ [DTONE] ${sorted.filter((r) => r.availability === 'available').length}/${operators.length} operators with usable products for ${country}`);
        return sorted;
    }

    /* ═══════════════════════════════════════════════════════════════
       eSIM PRODUCTS
    ═══════════════════════════════════════════════════════════════ */
    async getEsimProducts(countryIso3, options = {}) {
        const { includeRegionalAndGlobal = false } = options;

        const key = String(countryIso3 || '').trim().toUpperCase();
        if (!key) throw new Error('countryIso3 is required');

        const normalizedKey = this._normalizeRegionKey(key);
        const isGlobalQuery = GLOBAL_REGION_CODES.has(key) || GLOBAL_REGION_CODES.has(normalizedKey);
        const isRegionalQuery = REGIONAL_REGION_CODES.has(key) || REGIONAL_REGION_CODES.has(normalizedKey);
        const isCountryQuery = /^[A-Z]{3}$/.test(key) && !isGlobalQuery && !isRegionalQuery;

        if (isCountryQuery && !includeRegionalAndGlobal) {
            const rawProducts = await this.getAllPages('/products', {
                country_iso_code: key,
                service_id: '13'
            }, { dedupeKey: 'id' });

            return this._describeEsimProducts(rawProducts);
        }

        if (isGlobalQuery || isRegionalQuery) {
            const rawProducts = await this.getAllPages('/products', {
                service_id: '13'
            }, { dedupeKey: 'id' });

            let filtered;
            if (isGlobalQuery) {
                filtered = rawProducts.filter((p) => {
                    const regions = (p.regions || []).map((r) => String(r.code || '').toUpperCase());
                    return regions.some((c) => GLOBAL_REGION_CODES.has(c));
                });
            } else {
                filtered = rawProducts.filter((p) => {
                    const regions = (p.regions || []).map((r) => String(r.code || '').toUpperCase());
                    return regions.some((c) => c === normalizedKey);
                });
            }

            return this._describeEsimProducts(filtered);
        }

        const [countryProducts, allProducts] = await Promise.all([
            this.getAllPages('/products', { country_iso_code: key, service_id: '13' }, { dedupeKey: 'id' }),
            this.getAllPages('/products', { service_id: '13' }, { dedupeKey: 'id' })
        ]);

        const targetRegions = new Set(FALLBACK_COUNTRY_TO_REGIONS[key] || []);
        targetRegions.add('WWW');

        const regionalGlobal = allProducts.filter((p) => {
            const regions = (p.regions || []).map((r) => String(r.code || '').toUpperCase());
            return regions.some((code) => targetRegions.has(code));
        });

        const merged = new Map();
        for (const p of countryProducts) merged.set(String(p.id), p);
        for (const p of regionalGlobal) if (!merged.has(String(p.id))) merged.set(String(p.id), p);

        return this._describeEsimProducts(Array.from(merged.values()));
    }

    _describeEsimProducts(rawProducts) {
        const filtered = rawProducts.filter((p) =>
            p.type === 'FIXED_VALUE_PIN_PURCHASE' ||
            p.type === 'FIXED_VALUE_RECHARGE' ||
            p.type === 'FIXED_VALUE'
        );

        return filtered
            .map((p) => this._describeEsimProduct(p))
            .filter(Boolean)
            .sort((a, b) => {
                const order = { country: 0, regional: 1, global: 2 };
                const diff = (order[a.coverageType] ?? 0) - (order[b.coverageType] ?? 0);
                if (diff !== 0) return diff;
                return a.wholesaleAmount - b.wholesaleAmount;
            });
    }

    _normalizeRegionKey(key) {
        const map = {
            'EUROPE': 'EXX', 'EU': 'EXX', 'EXX': 'EXX',
            'ASIA': 'ASI', 'APAC': 'ASI', 'ASI': 'ASI',
            'AFRICA': 'AFR', 'AFR': 'AFR',
            'AMERICAS': 'AME', 'AME': 'AME',
            'LATAM': 'LATAM', 'NA': 'NA',
            'MIDDLE_EAST': 'MEA', 'MEA': 'MEA',
            'EMEA': 'EMEA',
            'GLOBAL': 'WWW', 'WORLD': 'WWW', 'WWW': 'WWW'
        };
        return map[key] || key;
    }

    _describeEsimProduct(p) {
        if (!p || !p.id) return null;

        const benefit = Array.isArray(p.benefits)
            ? p.benefits.find((b) => String(b.type || '').toUpperCase() === 'DATA')
            : null;

        const dataUnit = String(benefit?.unit || 'GB').toUpperCase();
        const dataAmountRaw =
            Number(benefit?.amount?.base) ||
            Number(benefit?.amount?.total_including_tax) ||
            Number(benefit?.amount?.total_excluding_tax) ||
            Number(benefit?.amount) || 0;

        let dataMb = 0;
        if (dataUnit === 'GB') dataMb = Math.round(dataAmountRaw * 1024);
        else if (dataUnit === 'MB') dataMb = Math.round(dataAmountRaw);
        else dataMb = Math.round(dataAmountRaw);

        const dataDisplay = dataUnit === 'GB'
            ? `${dataAmountRaw} GB`
            : `${dataAmountRaw} MB`;

        const validityDays = Number(p.validity?.quantity) || 30;
        const validityUnit = String(p.validity?.unit || 'DAY').toUpperCase();

        const wholesaleAmount = Number(p.prices?.wholesale?.amount ?? 0);
        const wholesaleCurrency = String(p.prices?.wholesale?.unit || 'USD').toUpperCase();

        const retailAmount = Number(p.prices?.retail?.amount ?? 0);
        const retailCurrency = String(p.prices?.retail?.unit || wholesaleCurrency).toUpperCase();

        const rawRegions = Array.isArray(p.regions) ? p.regions : [];
        const regions = rawRegions.map((r) => ({
            code: String(r.code || '').toUpperCase(),
            name: r.name || r.code || ''
        }));

        const hasGlobal = regions.some((r) => GLOBAL_REGION_CODES.has(r.code));
        const hasRegional = regions.some((r) => REGIONAL_REGION_CODES.has(r.code));

        let coverageType = 'country';
        let coverageLabel = 'Country-specific';

        if (hasGlobal) {
            coverageType = 'global';
            coverageLabel = 'Global';
        } else if (hasRegional) {
            coverageType = 'regional';
            const reg = regions.find((r) => REGIONAL_REGION_CODES.has(r.code));
            coverageLabel = reg?.name || this._regionFriendlyName(reg?.code) || 'Regional';
        } else if (regions.length === 1) {
            coverageType = 'country';
            coverageLabel = regions[0].name || 'Country-specific';
        }

        const instructions = Array.isArray(p.pin?.usage_info)
            ? p.pin.usage_info.filter(Boolean).join(' ')
            : null;

        return {
            productId: String(p.id),
            planName: p.name || `${dataDisplay} · ${validityDays}d`,
            description: p.description || null,
            dataMb,
            dataDisplay,
            validityDays,
            validityUnit,
            wholesaleAmount,
            wholesaleCurrency,
            retailAmount,
            retailCurrency,
            countryIso: p.operator?.country?.iso_code || null,
            countryName: p.operator?.country?.name || p.operator?.name || null,
            operatorId: p.operator?.id || null,
            operatorName: p.operator?.name || null,
            instructions,
            coverageType,
            coverageLabel,
            coverageRegions: regions,
            regionCodes: regions.map((r) => r.code),
            isGlobal: coverageType === 'global',
            isRegional: coverageType === 'regional'
        };
    }

    _regionFriendlyName(code) {
        const map = {
            'WWW': 'Global', 'EXX': 'Europe', 'ASI': 'Asia', 'AFR': 'Africa',
            'AME': 'Americas', 'MEA': 'Middle East', 'OCE': 'Oceania',
            'LATAM': 'Latin America', 'EMEA': 'Europe, Middle East & Africa'
        };
        return map[code] || null;
    }

    /* ═══════════════════════════════════════════════════════════════
       GIFT CARD PRODUCTS — SERVICE 4
    ═══════════════════════════════════════════════════════════════ */
    async getGiftCardProducts(countryIso3 = null, options = {}) {
        const {
            subserviceKey = null,
            productType = 'FIXED_VALUE_PIN_PURCHASE',
            maxPages = 6,
            maxTotalMs = 20000,
            requestTimeoutMs = 8000,
            requireComplete = false
        } = options;
        const svc = this.SERVICES.GIFT_CARD;

        const params = {
            service_id: svc.service_id,
            type: productType
        };

        if (countryIso3 && /^[A-Z]{3}$/.test(String(countryIso3).toUpperCase())) {
            params.country_iso_code = String(countryIso3).toUpperCase();
        }

        if (subserviceKey && svc.subservices[subserviceKey]) {
            params.subservice_id = svc.subservices[subserviceKey];
        }

        const result = await this.getAllPages('/products', params, {
            dedupeKey: 'id',
            maxPages,
            maxTotalMs,
            requestTimeoutMs,
            requireComplete
        });

        const rawProducts = requireComplete ? result.items : result;
        const truncated = requireComplete ? result.truncated : false;
        const truncationReason = requireComplete ? result.truncationReason : null;

        const described = rawProducts
            .map((p) => this._describeGiftCardProduct(p))
            .filter(Boolean)
            .sort((a, b) => {
                const cleanA = cleanNameForSort(a.name);
                const cleanB = cleanNameForSort(b.name);
                const cmp = cleanA.localeCompare(cleanB, 'en', { sensitivity: 'base', numeric: true });
                if (cmp !== 0) return cmp;

                const cA = String(a.countryName || '').toLowerCase();
                const cB = String(b.countryName || '').toLowerCase();
                const cmpC = cA.localeCompare(cB, 'en', { sensitivity: 'base' });
                if (cmpC !== 0) return cmpC;

                return (a.faceValue || 0) - (b.faceValue || 0);
            });

        if (requireComplete) {
            return { products: described, truncated, truncationReason };
        }

        return described;
    }

    _describeGiftCardProduct(p) {
        if (!p || !p.id) return null;

        let faceValue = 0;
        let currency = 'USD';

        if (Array.isArray(p.benefits) && p.benefits.length) {
            const benefit =
                p.benefits.find((b) =>
                    ['VALUE', 'CURRENCY', 'AMOUNT'].includes(String(b.type || '').toUpperCase())
                ) || p.benefits[0];

            faceValue = Number(
                benefit?.amount?.base ??
                benefit?.amount?.total_including_tax ??
                benefit?.amount?.total_excluding_tax ??
                benefit?.amount ??
                0
            );
            currency = String(benefit?.unit || 'USD').toUpperCase();
        }

        const wholesaleAmount = Number(p.prices?.wholesale?.amount ?? 0);
        const wholesaleCurrency = String(p.prices?.wholesale?.unit || 'USD').toUpperCase();

        const instructions = Array.isArray(p.pin?.usage_info)
            ? p.pin.usage_info.filter(Boolean).join(' ')
            : null;

        const subserviceId = String(p.service?.subservice?.id || p.subservice_id || '');

        const countryIso = String(
            p.operator?.country?.iso_code ||
            p.country?.iso_code ||
            p.country_iso_code ||
            ''
        ).toUpperCase() || null;

        const countryName =
            p.operator?.country?.name ||
            p.country?.name ||
            null;

        const countryIso2 = String(
            p.operator?.country?.iso2 ||
            p.country?.iso2 ||
            (countryIso ? ISO3_TO_ISO2[countryIso] : '') ||
            ''
        ).toUpperCase() || null;

        return {
            productId: String(p.id),
            name: p.name || `Gift Card ${faceValue} ${currency}`,
            productType: p.type || null,
            description: p.description || null,
            faceValue,
            currency,
            wholesaleAmount,
            wholesaleCurrency,
            subserviceId,
            countryIso,
            countryIso2,
            countryName,
            operatorName: p.operator?.name || null,
            operatorId: p.operator?.id || null,
            instructions,
            validity: p.validity || null
        };
    }

    /* ═══════════════════════════════════════════════════════════════
       CREATE QUOTE
    ═══════════════════════════════════════════════════════════════ */
    async createQuote({
        productId,
        phone,
        iccid,
        mode,
        sourceAmount,
        sourceCurrency,
        destinationAmount,
        destinationCurrency,
        callbackUrl,
        orderReference
    }) {
        const externalId = validateExternalId(
            orderReference
                ? `MXQ-${orderReference}`
                : `MXQ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
        );

        const body = {
            external_id: externalId,
            product_id: assertPositiveIntegerId(productId, 'product ID'),
            auto_confirm: false
        };

        if (iccid) {
            body.credit_party_identifier = { account_number: String(iccid) };
        } else if (phone) {
            body.credit_party_identifier = { mobile_number: phone };
        }

        if (callbackUrl) {
            if (isPublicHttpsUrl(callbackUrl)) {
                body.callback_url = callbackUrl;
            } else {
                console.warn(`⚠️ [DTONE] Skipping callback_url — not public HTTPS: ${callbackUrl}`);
            }
        }

        if (mode === 'FIXED') {
            // no calculation_mode
        } else if (mode === 'RANGED_SOURCE') {
            if (sourceAmount == null || !sourceCurrency) {
                throw new Error('sourceAmount and sourceCurrency required for RANGED_SOURCE');
            }
            body.calculation_mode = 'SOURCE_AMOUNT';
            body.source = {
                unit_type: 'CURRENCY',
                unit: sourceCurrency,
                amount: Number(sourceAmount)
            };
        } else if (mode === 'RANGED_DESTINATION') {
            if (destinationAmount == null || !destinationCurrency) {
                throw new Error('destinationAmount and destinationCurrency required');
            }
            body.calculation_mode = 'DESTINATION_AMOUNT';
            body.destination = {
                unit_type: 'CURRENCY',
                unit: destinationCurrency,
                amount: Number(destinationAmount)
            };
        } else {
            throw new Error(`Unsupported DT One product mode: ${mode}`);
        }

        if (LOG_VERBOSE) {
            console.log('📡 [DTONE QUOTE REQUEST]', JSON.stringify(redactForLog(body), null, 2));
        }

        try {
            const response = await this.retryFinancialCreate(
                () => this.client.post(`${this.baseUrl}/async/transactions`, body, { timeout: 30000 }),
                externalId
            );

            if (response?.recovered) {
                const tx = response.transaction;
                const statusObj = tx?.status || {};
                const normalized = this.normalizeStatus(statusObj);

                return {
                    success: true,
                    recovered: true,
                    transactionId: tx.id,
                    externalId: tx.external_id || externalId,
                    source: tx.source || null,
                    destination: tx.destination || null,
                    wholesale: tx.prices?.wholesale || null,
                    retail: tx.prices?.retail || null,
                    status: statusObj,
                    normalizedStatus: normalized,
                    raw: tx
                };
            }

            const data = response.data;
            const statusObj = data?.status || {};
            const normalized = this.normalizeStatus(statusObj);

            if (normalized.final && normalized.status === 'failed') {
                console.error('❌ [DTONE] Transaction rejected at create:', normalized.code);
                const err = new Error(`DT One rejected: ${normalized.code}`);
                err.providerData = redactForLog(data);
                err.providerStatus = 'REJECTED';
                err.normalized = normalized;
                err.definitiveRejection = true;
                throw err;
            }

            const destination = data.adjusted_values?.destination || data.destination || data.product?.destination || null;
            const source = data.adjusted_values?.source || data.source || data.product?.source || null;
            const wholesale = data.prices?.wholesale || data.adjusted_values?.wholesale || null;

            return {
                success: true,
                transactionId: data.id,
                externalId: data.external_id || externalId,
                source,
                destination,
                wholesale,
                retail: data.prices?.retail || null,
                status: statusObj,
                normalizedStatus: normalized,
                raw: data
            };
        } catch (error) {
            if (error.definitiveRejection) throw error;
            if (error.code === 'PROVIDER_UNKNOWN') throw error;

            const errData = error.response?.data;
            const msg = this.extractErrorMessage(errData) || error.message || 'Failed to create quote';

            console.error('❌ [DTONE QUOTE FAILED]', {
                status: error.response?.status,
                message: msg,
                providerData: redactForLog(errData)
            });

            const err = new Error(msg);
            err.providerData = redactForLog(errData);
            err.providerStatus = error.response?.status;
            err.externalId = externalId;
            throw err;
        }
    }

    /* ═══════════════════════════════════════════════════════════════
       GIFT CARD PURCHASE
       Creates the transaction. Auto-confirm is controlled by the caller
       via the `autoConfirm` option.
    ═══════════════════════════════════════════════════════════════ */
    async purchaseGiftCard({
        productId,
        countryIso3,
        quantity = 1,
        externalId,
        callbackUrl,
        autoConfirm = false
    }) {
        if (quantity !== 1) {
            const err = new Error(
                `Multi-quantity gift card purchases are not supported at the DT One layer. ` +
                `Received quantity=${quantity}.`
            );
            err.code = 'MULTI_QUANTITY_NOT_SUPPORTED';
            throw err;
        }

        const validatedExternalId = validateExternalId(externalId);
        const validatedProductId = assertPositiveIntegerId(productId, 'product ID');

        const body = {
            external_id: validatedExternalId,
            product_id: validatedProductId,
            auto_confirm: Boolean(autoConfirm)
        };

        if (callbackUrl && isPublicHttpsUrl(callbackUrl)) {
            body.callback_url = callbackUrl;
        }

        if (LOG_VERBOSE) {
            console.log('📡 [DTONE GIFTCARD PURCHASE]', JSON.stringify(redactForLog(body), null, 2));
        }

        try {
            const response = await this.retryFinancialCreate(
                () => this.client.post(`${this.baseUrl}/async/transactions`, body, { timeout: 30000 }),
                validatedExternalId
            );

            if (response?.recovered) {
                const tx = response.transaction;
                const statusObj = tx?.status || {};
                const normalized = this.normalizeStatus(statusObj);
                return {
                    transactionId: tx.id,
                    externalId: tx.external_id || validatedExternalId,
                    status: statusObj?.message || 'SUBMITTED',
                    statusId: normalized.statusId,
                    statusClassId: normalized.statusClassId,
                    normalized,
                    recovered: true,
                    raw: tx
                };
            }

            const data = response.data;
            const statusObj = data?.status || {};
            const normalized = this.normalizeStatus(statusObj);

            if (normalized.final && normalized.status === 'failed') {
                const err = new Error(`DT One rejected gift card: ${normalized.code}`);
                err.providerData = redactForLog(data);
                err.providerStatus = 'REJECTED';
                err.normalized = normalized;
                err.definitiveRejection = true;
                throw err;
            }

            return {
                transactionId: data.id || data.transaction_id,
                externalId: data.external_id || validatedExternalId,
                status: statusObj?.message || 'SUBMITTED',
                statusId: normalized.statusId,
                statusClassId: normalized.statusClassId,
                normalized,
                raw: data
            };
        } catch (error) {
            if (error.definitiveRejection) throw error;
            if (error.code === 'PROVIDER_UNKNOWN') throw error;

            const errData = error.response?.data;
            const msg = this.extractErrorMessage(errData) || error.message || 'Gift card purchase failed';

            const err = new Error(msg);
            err.providerData = redactForLog(errData);
            err.providerStatus = error.response?.status;
            err.externalId = validatedExternalId;
            throw err;
        }
    }

    /* ═══════════════════════════════════════════════════════════════
       CONFIRM TRANSACTION
       Preserves all provider failure info: code, statusId, statusClassId,
       normalized status, definitiveRejection flag.
    ═══════════════════════════════════════════════════════════════ */
    async confirmTransaction(transactionId) {
        const id = assertPositiveIntegerId(transactionId, 'transaction ID');

        try {
            const res = await this.client.post(
                `${this.baseUrl}/async/transactions/${id}/confirm`,
                {},
                { timeout: 15000 }
            );

            const statusObj = res.data?.status || {};
            const normalized = this.normalizeStatus(statusObj);

            return {
                success: true,
                ambiguous: false,
                definitiveRejection: false,
                status: statusObj?.message || normalized.code,
                statusId: normalized.statusId,
                statusClassId: normalized.statusClassId,
                normalized,
                raw: res.data
            };
        } catch (error) {
            const providerData = error.response?.data || null;

            const providerErrorCode =
                providerData?.errors?.[0]?.code ??
                providerData?.error?.code ??
                null;

            const statusObj = providerData?.status || {};

            const statusId =
                Number(statusObj?.id ?? statusObj?.status_id ?? 0) || null;
            const statusClassId =
                Number(statusObj?.class?.id ?? 0) || null;

            const normalized = this.normalizeStatus(statusObj);

            // ── Definitive detection ──────────────────────────────
            //   1. Explicit provider error code 1006001 (insufficient balance)
            //   2. Detailed status 30500 (insufficient balance)
            //   3. Any terminal rejection detail in TERMINAL_REJECTION_DETAILS
            //   4. Class id 3 (REJECTED)
            //   5. Message text containing REJECTED / DECLINED
            const isInsufficientBalance =
                String(providerErrorCode) === '1006001' ||
                statusId === 30500;

            const isTerminalDetail =
                statusId != null && TERMINAL_REJECTION_DETAILS.has(statusId);

            const isClassRejected = statusClassId === 3;

            const messageUpper = String(
                statusObj?.message ?? statusObj?.class?.message ?? ''
            ).toUpperCase();

            const isMessageRejected =
                messageUpper.includes('REJECTED') ||
                messageUpper.includes('DECLINED') ||
                messageUpper.includes('INSUFFICIENT');

            const definitiveRejection =
                isInsufficientBalance ||
                isTerminalDetail ||
                isClassRejected ||
                isMessageRejected;

            const ambiguous = isAmbiguousNetworkError(error);

            const msg = this.extractErrorMessage(providerData) ||
                error.message ||
                'DT One confirmation failed';

            const err = new Error(msg);
            err.providerData = redactForLog(providerData);
            err.providerErrorCode = providerErrorCode;
            err.statusId = statusId;
            err.statusClassId = statusClassId;
            err.normalized = normalized;
            err.definitiveRejection = definitiveRejection;
            err.ambiguous = ambiguous;

            throw err;
        }
    }

    /* ═══════════════════════════════════════════════════════════════
       QUERY TRANSACTION BY ID
    ═══════════════════════════════════════════════════════════════ */
    async queryTransaction(transactionId) {
        const id = assertPositiveIntegerId(transactionId, 'transaction ID');

        try {
            const res = await this.retryRead(() =>
                this.client.get(`${this.baseUrl}/transactions/${id}`, { timeout: 15000 })
            );

            const data = res.data;
            const statusObj = data?.status || {};

            const providerStatus = String(
                statusObj.message || statusObj.class?.message || ''
            ).toUpperCase();

            const statusId = Number(statusObj.id ?? 0) || null;
            const statusClassId = Number(statusObj.class?.id ?? 0) || null;

            const errorCode =
                data?.error?.code ??
                data?.errors?.[0]?.code ??
                statusObj?.error?.code ??
                statusObj?.class?.error?.code ??
                null;

            const errorMessage =
                data?.error?.message ??
                data?.errors?.[0]?.message ??
                statusObj?.error?.message ??
                statusObj?.class?.error?.message ??
                null;

            const normalized = this.normalizeStatus(statusObj);

            const interesting =
                normalized.final ||
                Boolean(errorCode) ||
                Boolean(errorMessage) ||
                normalized.status === 'provider_unknown';

            if (LOG_VERBOSE || interesting) {
                console.log('════════ DT ONE TRANSACTION ════════');
                console.log(JSON.stringify({
                    id: data?.id,
                    external_id: data?.external_id,
                    statusId,
                    statusClassId,
                    providerStatus,
                    normalizedStatus: normalized.status,
                    normalizedCode: normalized.code,
                    errorCode,
                    errorMessage
                }, null, 2));
                console.log('═══════════════════════════════════');
            }

            return {
                status: normalized.status,
                providerStatus: providerStatus || normalized.code,
                isFinal: normalized.final,
                code: normalized.code,
                statusId,
                statusClassId,
                errorCode,
                errorMessage,
                notFound: false,
                transactionId: data?.id || id,
                externalId: data?.external_id || null,
                definitiveRejection: normalized.definitiveRejection,
                raw: data
            };
        } catch (error) {
            if (error.response?.status === 404) {
                if (LOG_VERBOSE) {
                    console.warn(`⚠️ [DTONE QUERY] ${id} not found at DT One (404)`);
                }
                return {
                    status: 'not_found',
                    providerStatus: 'NOT_FOUND',
                    isFinal: false,
                    code: 'NOT_FOUND',
                    statusId: null,
                    statusClassId: null,
                    errorCode: null,
                    errorMessage: null,
                    notFound: true,
                    transactionId: id,
                    externalId: null,
                    definitiveRejection: false,
                    raw: null
                };
            }

            console.error('❌ [DTONE QUERY FAILED]', {
                transactionId: id,
                status: error.response?.status,
                message: error.message
            });

            throw error;
        }
    }

    /* ═══════════════════════════════════════════════════════════════
       GET TRANSACTION BY EXTERNAL ID
    ═══════════════════════════════════════════════════════════════ */
    async getTransactionByExternalId(externalId, options = {}) {
        const { rich = false } = options;
        const value = validateExternalId(externalId);

        try {
            const res = await this.retryRead(() =>
                this.client.get(`${this.baseUrl}/transactions`, {
                    params: { external_id: value, per_page: 10 },
                    timeout: 15000
                })
            );

            const body = res.data;
            let items = [];
            if (Array.isArray(body)) items = body;
            else if (Array.isArray(body?.items)) items = body.items;
            else if (Array.isArray(body?.data)) items = body.data;
            else if (Array.isArray(body?.results)) items = body.results;

            const transaction = items[0] || null;

            if (rich) {
                return transaction
                    ? { found: true, transaction, notFound: false }
                    : { found: false, transaction: null, notFound: true };
            }
            return transaction;
        } catch (error) {
            if (error.response?.status === 404) {
                if (rich) return { found: false, transaction: null, notFound: true };
                return null;
            }
            throw error;
        }
    }

    /* ═══════════════════════════════════════════════════════════════
       CANCEL TRANSACTION
    ═══════════════════════════════════════════════════════════════ */
    async cancelTransaction(transactionId) {
        const id = assertPositiveIntegerId(transactionId, 'transaction ID');

        const result = await this.executeFinancialAction(() =>
            this.client.post(
                `${this.baseUrl}/async/transactions/${id}/cancel`,
                {},
                { timeout: 15000 }
            )
        );

        if (result.ambiguous) {
            console.warn(`⚠️ [DTONE] Cancel ambiguous for tx=${id}: ${result.error}`);
            return {
                success: false,
                ambiguous: true,
                error: result.error
            };
        }

        return {
            success: true,
            data: result.data
        };
    }

    async getTransactionStatus(transactionId) {
        return await this.queryTransaction(transactionId);
    }

    async getServices() {
        return await this.getAllPages('/services', {}, { dedupeKey: 'id' });
    }

    getOperatorLogo(operatorId, size = 1) {
        if (!operatorId) return this.DEFAULT_LOGO;
        return `${this.LOGO_BASE}/logo-${operatorId}-${size}.png`;
    }

    /* ═══════════════════════════════════════════════════════════════
       eSIM DELIVERY EXTRACTION
    ═══════════════════════════════════════════════════════════════ */
    extractEsimDelivery(transaction) {
        const data = transaction?.raw || transaction || {};
        const pin = data?.pin || {};
        const metadata = data?.metadata || {};

        const profile =
            metadata?.profile ||
            metadata?.esim?.profile ||
            metadata?.esim ||
            {};

        const lpaString = pin?.code || data?.lpa || data?.esim?.lpa || null;
        const activationCode =
            profile?.activation_code ||
            data?.activation_code ||
            data?.esim?.activation_code ||
            null;

        const serial = pin?.serial || profile?.serial || data?.serial || data?.iccid || null;
        const iccid = data?.iccid || pin?.iccid || profile?.iccid || null;
        const installationUrl = profile?.installation_url || data?.esim?.installation_url || null;
        const appleUniversalLink = profile?.apple_universal_link || data?.esim?.apple_universal_link || null;
        const androidUniversalLink = profile?.android_universal_link || data?.esim?.android_universal_link || null;

        let smdpAddress = null;
        let matchingId = null;

        if (lpaString && typeof lpaString === 'string' && lpaString.startsWith('LPA:')) {
            const parts = lpaString.split('$');
            if (parts.length >= 3) {
                smdpAddress = parts[1] || null;
                matchingId = parts[2] || null;
            }
        }

        if (!smdpAddress) {
            smdpAddress = profile?.smdp_address || data?.smdp_address || data?.esim?.smdp_address || null;
        }
        if (!matchingId) {
            matchingId = profile?.matching_id || data?.matching_id || data?.esim?.matching_id || null;
        }

        const instructions =
            data?.redemption_instructions ||
            data?.instructions ||
            data?.esim?.instructions ||
            (Array.isArray(data?.pin?.usage_info) ? data.pin.usage_info.join(' ') : null) ||
            null;

        const qrCodeUrl =
            data?.qr_code_url ||
            data?.esim?.qr_code_url ||
            profile?.qr_code_url ||
            null;

        return {
            lpaString,
            activationCode,
            serial,
            iccid,
            installationUrl,
            appleUniversalLink,
            androidUniversalLink,
            smdpAddress,
            matchingId,
            qrCodeUrl,
            instructions,
            rawPin: pin,
            rawMetadata: metadata
        };
    }

    /* ═══════════════════════════════════════════════════════════════
       GIFT CARD DELIVERY EXTRACTION
    ═══════════════════════════════════════════════════════════════ */
    extractGiftCardDelivery(result) {
        if (!result) return null;

        const tx = result.raw || result;
        const pin = tx?.pin || tx?.voucher || tx?.data?.pin || {};

        const code =
            pin?.code ||
            tx?.voucher_code ||
            tx?.code ||
            tx?.redemption_code ||
            tx?.data?.voucher_code ||
            null;

        const serial =
            pin?.serial ||
            tx?.serial ||
            tx?.voucher_serial ||
            tx?.data?.serial ||
            null;

        const instructions =
            pin?.instructions ||
            tx?.instructions ||
            tx?.redemption_instructions ||
            (Array.isArray(pin?.usage_info) ? pin.usage_info.filter(Boolean).join(' ') : null) ||
            null;

        if (!code) return null;

        return {
            code: String(code),
            serial: serial ? String(serial) : null,
            instructions: instructions ? String(instructions) : null
        };
    }
}

module.exports = new DTOneService();
module.exports.DTOneService = DTOneService;
module.exports.validateExternalId = validateExternalId;
module.exports.assertPositiveIntegerId = assertPositiveIntegerId;
module.exports.redactForLog = redactForLog;