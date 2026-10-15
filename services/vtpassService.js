// services/vtpassService.js — PRODUCTION READY (lazy env access)
// Complete VTpass integration for MilesSpace
// Supports: Airtime, Data, Electricity, Cable TV, Education
// Includes: Phone number lookup + sandbox test-number bypass
//
// IMPORTANT — why every credential is a getter:
//   The service is a singleton (module.exports = new VTpassService()).
//   The constructor runs once. If the module is required before
//   dotenv has populated process.env, any field captured in the
//   constructor is frozen to `undefined` forever.
//   Reading process.env in getters on every call makes the module
//   load-order-independent, which is what production needs.

'use strict';

const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

class VTpassService {
    constructor() {
        // ─── HTTP agent with keep-alive ───
        this.httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 50,
            maxFreeSockets: 10
        });

        // ─── Axios instance ───
        this.axiosInstance = axios.create({
            httpsAgent: this.httpsAgent,
            timeout: 30000
        });

        // ─── Catalog cache ───
        this.catalogCache = new Map();
        this.catalogPending = new Map();
        this.CATALOG_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

        // ─── Network prefix map ───
        this.NETWORK_PREFIXES = {
            mtn: [
                '0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814',
                '0903', '0906', '0913', '0916', '0704'
            ],
            glo: [
                '0805', '0807', '0705', '0815', '0811', '0905', '0915'
            ],
            airtel: [
                '0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904',
                '0907', '0912'
            ],
            '9mobile': [
                '0809', '0817', '0818', '0908', '0909'
            ]
        };

        // ─── Service ID map ───
        this.SERVICE_IDS = {
            airtime: {
                mtn: 'mtn',
                glo: 'glo',
                airtel: 'airtel',
                '9mobile': 'etisalat'
            },
            data: {
                mtn: 'mtn-data',
                glo: 'glo-data',
                airtel: 'airtel-data',
                '9mobile': '9mobile-data'
            },
            tv: {
                dstv: 'dstv',
                gotv: 'gotv',
                startimes: 'startimes',
                showmax: 'showmax'
            },
            electricity: {
                'ikeja-electric': 'ikeja-electric',
                'eko-electric': 'eko-electric',
                'abuja-electric': 'abuja-electric',
                'kano-electric': 'kano-electric',
                'portharcourt-electric': 'portharcourt-electric',
                'jos-electric': 'jos-electric',
                'ibadan-electric': 'ibadan-electric',
                'kaduna-electric': 'kaduna-electric',
                'enugu-electric': 'enugu-electric',
                'benin-electric': 'benin-electric',
                'aba-electric': 'aba-electric',
                'yola-electric': 'yola-electric'
            },
            education: {
                waec: 'waec',
                neco: 'neco',
                nabteb: 'nabteb'
            }
        };

        // Log once with whatever is set right now. If dotenv hasn't
        // run yet, this warns — that's fine, because the getters
        // below will pick up the real values on the first API call.
        this._logBootState();
    }

    // ────────────────────────────────────────────────────────────────
    // LAZY ENV ACCESS — the fix
    // ────────────────────────────────────────────────────────────────

    get apiKey()      { return process.env.VTPASS_API_KEY     || null; }
    get publicKey()   { return process.env.VTPASS_PUBLIC_KEY  || null; }
    get secretKey()   { return process.env.VTPASS_SECRET_KEY  || null; }
    get environment() { return (process.env.VTPASS_ENV || 'sandbox').toLowerCase(); }
    get isSandbox()   { return this.environment === 'sandbox'; }
    get baseUrl() {
        return this.isSandbox
            ? 'https://sandbox.vtpass.com/api'
            : 'https://vtpass.com/api';
    }

    _logBootState() {
        const creds = {
            apiKey:    !!this.apiKey,
            publicKey: !!this.publicKey,
            secretKey: !!this.secretKey,
            env:       this.environment
        };
        console.log('[VTPASS] initialized');
        console.log(`   Environment: ${this.environment.toUpperCase()}`);
        console.log(`   Base URL:    ${this.baseUrl}`);
        console.log(`   Credentials: apiKey=${creds.apiKey} publicKey=${creds.publicKey} secretKey=${creds.secretKey}`);
        if (this.isSandbox) {
            console.log('   SANDBOX MODE — test numbers active:');
            console.log('       08011111111  → success');
            console.log('       201000000000 → pending');
            console.log('       500000000000 → unexpected response');
            console.log('       400000000000 → no response');
            console.log('       300000000000 → timeout');
        }
    }

    validateConfiguration() {
        const required = ['VTPASS_API_KEY', 'VTPASS_PUBLIC_KEY', 'VTPASS_SECRET_KEY'];
        const missing = required.filter(key => !process.env[key]);
        if (missing.length) {
            console.warn(`[VTPASS] missing env: ${missing.join(', ')}`);
        }
        return missing.length === 0;
    }

    isConfigured() {
        return !!(this.apiKey && this.publicKey && this.secretKey);
    }

    // ═══════════════════════════════════════════════════════════════════
    // SANDBOX TEST NUMBERS
    // ═══════════════════════════════════════════════════════════════════

    getSandboxTestNumbers() {
        return {
            '08011111111': 'mtn',
            '201000000000': 'mtn',
            '500000000000': 'mtn',
            '400000000000': 'mtn',
            '300000000000': 'mtn'
        };
    }

    isSandboxTestNumber(phone) {
        if (!this.isSandbox) return false;
        const normalized = this.normalizePhone(phone);
        return Object.prototype.hasOwnProperty.call(this.getSandboxTestNumbers(), normalized);
    }

    // ═══════════════════════════════════════════════════════════════════
    // HEADERS
    // ═══════════════════════════════════════════════════════════════════

    getPostHeaders() {
        return {
            'api-key':     this.apiKey,
            'secret-key':  this.secretKey,
            'Content-Type': 'application/json'
        };
    }

    getGetHeaders() {
        return {
            'api-key':     this.apiKey,
            'public-key':  this.publicKey,
            'Content-Type': 'application/json'
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // REQUEST ID
    // ═══════════════════════════════════════════════════════════════════

    generateRequestId() {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Lagos',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(now);

        const values = {};
        for (const part of parts) {
            if (part.type !== 'literal') values[part.type] = part.value;
        }

        const timestamp = `${values.year}${values.month}${values.day}${values.hour}${values.minute}`;
        const random = crypto.randomBytes(6).toString('hex').toUpperCase();
        return `${timestamp}${random}`;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHONE HELPERS
    // ═══════════════════════════════════════════════════════════════════

    normalizePhone(phone) {
        let number = String(phone || '').replace(/\D/g, '');
        if (number.startsWith('234')) {
            number = '0' + number.slice(3);
        } else if (number.startsWith('+234')) {
            number = '0' + number.slice(4);
        }
        return number;
    }

    detectNetwork(phone) {
        const normalized = this.normalizePhone(phone);

        if (this.isSandbox) {
            const sandboxMap = this.getSandboxTestNumbers();
            if (sandboxMap[normalized]) return sandboxMap[normalized];
        }

        if (normalized.length < 4) return null;
        const prefix = normalized.substring(0, 4);

        for (const [network, prefixes] of Object.entries(this.NETWORK_PREFIXES)) {
            if (prefixes.includes(prefix)) return network;
        }
        return null;
    }

    validatePhone(phone) {
        const normalized = this.normalizePhone(phone);

        if (this.isSandbox && this.isSandboxTestNumber(normalized)) {
            const network = this.getSandboxTestNumbers()[normalized];
            return { valid: true, network, phone: normalized, sandbox: true };
        }

        if (!/^0\d{10}$/.test(normalized)) {
            return { valid: false, error: 'Enter a valid Nigerian phone number (e.g. 08012345678)' };
        }

        const network = this.detectNetwork(normalized);
        if (!network) {
            return { valid: false, error: 'Unable to detect network for this number. Please select manually.' };
        }

        return { valid: true, network, phone: normalized };
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHONE LOOKUP
    // ═══════════════════════════════════════════════════════════════════

    async lookupPhoneNetwork(phone) {
        const normalized = this.normalizePhone(phone);

        if (this.isSandbox && this.isSandboxTestNumber(normalized)) {
            const network = this.getSandboxTestNumbers()[normalized];
            const networkMeta = this.getNetworks().find(n => n.id === network);
            return {
                success: true,
                phone: normalized,
                network,
                network_name: networkMeta?.name || network.toUpperCase(),
                detection_source: 'sandbox'
            };
        }

        if (!/^0\d{10}$/.test(normalized)) {
            return {
                success: false,
                error: 'Enter a valid Nigerian phone number',
                phone: normalized,
                network: null,
                detection_source: 'unknown'
            };
        }

        const detected = this.detectNetwork(normalized);
        if (!detected) {
            return {
                success: false,
                error: 'Unable to detect network for this number. Please select manually.',
                phone: normalized,
                network: null,
                detection_source: 'unknown'
            };
        }

        const networkMeta = this.getNetworks().find(n => n.id === detected);
        return {
            success: true,
            phone: normalized,
            network: detected,
            network_name: networkMeta?.name || detected.toUpperCase(),
            detection_source: 'prefix'
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // SERVICE IDS + CATALOGS
    // ═══════════════════════════════════════════════════════════════════

    getServiceID(category, provider) {
        return this.SERVICE_IDS[category]?.[provider] || null;
    }

    getNetworks() {
        return [
            { id: 'mtn',     name: 'MTN',     color: '#F2C500' },
            { id: 'airtel',  name: 'Airtel',  color: '#E4002B' },
            { id: 'glo',     name: 'Glo',     color: '#1AA64A' },
            { id: '9mobile', name: '9mobile', color: '#00A99D' }
        ];
    }

    getElectricityProviders() {
        return [
            { id: 'ikeja-electric',        name: 'Ikeja Electric (IKEDC)' },
            { id: 'eko-electric',          name: 'Eko Electric (EKEDC)' },
            { id: 'abuja-electric',        name: 'Abuja Electric (AEDC)' },
            { id: 'kano-electric',         name: 'Kano Electric (KEDCO)' },
            { id: 'portharcourt-electric', name: 'Port Harcourt Electric (PHED)' },
            { id: 'jos-electric',          name: 'Jos Electric (JED)' },
            { id: 'ibadan-electric',       name: 'Ibadan Electric (IBEDC)' },
            { id: 'kaduna-electric',       name: 'Kaduna Electric (KAEDCO)' },
            { id: 'enugu-electric',        name: 'Enugu Electric (EEDC)' },
            { id: 'benin-electric',        name: 'Benin Electric (BEDC)' },
            { id: 'aba-electric',          name: 'Aba Electric (APLE)' },
            { id: 'yola-electric',         name: 'Yola Electric (YEDC)' }
        ];
    }

    getTvProviders() {
        return [
            { id: 'dstv',      name: 'DStv' },
            { id: 'gotv',      name: 'GOtv' },
            { id: 'startimes', name: 'StarTimes' },
            { id: 'showmax',   name: 'Showmax' }
        ];
    }

    // ═══════════════════════════════════════════════════════════════════
    // STATUS NORMALIZATION
    // ═══════════════════════════════════════════════════════════════════

    normalizeTransactionStatus(data) {
        const code = String(data?.code || '').trim();
        const providerStatus = String(data?.content?.transactions?.status || '').toLowerCase().trim();

        if (providerStatus === 'delivered') {
            return { state: 'completed', providerStatus, code, definitive: true };
        }

        if (['pending', 'initiated', 'processing'].includes(providerStatus)) {
            return { state: 'processing', providerStatus, code, definitive: false };
        }

        const failedCodes = new Set(['010', '011', '013', '014', '015', '016', '017', '018', '091']);
        if (failedCodes.has(code)) {
            return { state: 'failed', providerStatus, code, definitive: true };
        }

        if (code === '099') {
            return { state: 'processing', providerStatus: providerStatus || 'processing', code, definitive: false };
        }

        if (code === '000') {
            return { state: 'processing', providerStatus: providerStatus || 'unknown', code, definitive: false };
        }

        return { state: 'processing', providerStatus: providerStatus || 'unknown', code, definitive: false };
    }

    getFriendlyError(code) {
        const errorMap = {
            '010': 'The selected plan is no longer available. Please select another plan.',
            '011': 'Invalid transaction details. Please check your inputs.',
            '013': 'Amount is below the minimum allowed.',
            '014': 'Duplicate transaction detected. This request was already processed.',
            '015': 'Transaction not found. Please check your reference.',
            '016': 'Transaction failed. Please try again or use a different service.',
            '017': 'Amount exceeds the maximum allowed.',
            '018': 'Insufficient balance. Please fund your wallet and try again.',
            '091': 'Transaction could not be processed. Please try again later.',
            'TIMEOUT': "Provider is taking longer than expected. We'll check and notify you.",
            'CONNECTION_ERROR': 'Network error. Please check your connection and try again.',
            'default': 'Transaction could not be completed. Please try again or contact support.'
        };
        return errorMap[code] || errorMap.default;
    }

    // ═══════════════════════════════════════════════════════════════════
    // VARIATIONS
    // ═══════════════════════════════════════════════════════════════════

    async getVariations(serviceID) {
        const cacheKey = `variations_${serviceID}`;
        const cached = this.catalogCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < this.CATALOG_CACHE_TTL)) {
            return cached.data;
        }

        if (this.catalogPending.has(cacheKey)) {
            return this.catalogPending.get(cacheKey);
        }

        const promise = this._fetchVariations(serviceID);
        this.catalogPending.set(cacheKey, promise);

        try {
            const result = await promise;
            this.catalogCache.set(cacheKey, { data: result, timestamp: Date.now() });
            return result;
        } finally {
            this.catalogPending.delete(cacheKey);
        }
    }

    async _fetchVariations(serviceID) {
        try {
            const response = await this.axiosInstance.get(
                `${this.baseUrl}/service-variations`,
                {
                    params: { serviceID },
                    headers: this.getGetHeaders(),
                    timeout: 15000
                }
            );

            const variations = response.data?.content?.variations || [];

            return {
                success: true,
                serviceID,
                variations: variations.map(v => ({
                    variation_code: v.variation_code,
                    name: v.name || v.variation_name,
                    amount: parseFloat(v.variation_amount) || 0,
                    fixedPrice: v.fixedPrice === 'Yes',
                    description: v.variation_description || ''
                }))
            };
        } catch (error) {
            console.error('VTpass getVariations failed:', {
                serviceID,
                status: error.response?.status,
                message: error.message
            });
            throw error;
        }
    }

    async getDataPlans(network) {
        const serviceID = this.getServiceID('data', network);
        if (!serviceID) throw new Error(`Unsupported network: ${network}`);

        const result = await this.getVariations(serviceID);

        if (!result.success || !result.variations.length) {
            return { success: false, error: 'No data plans available for this network', plans: [] };
        }

        return {
            success: true,
            network,
            serviceID,
            plans: result.variations.map(v => ({
                variation_code: v.variation_code,
                name: v.name,
                amount: v.amount,
                description: v.description
            }))
        };
    }

    async getTvPackages(provider) {
        const serviceID = this.getServiceID('tv', provider);
        if (!serviceID) throw new Error(`Unsupported TV provider: ${provider}`);

        const result = await this.getVariations(serviceID);

        if (!result.success || !result.variations.length) {
            return { success: false, error: 'No packages available for this provider', packages: [] };
        }

        return {
            success: true,
            provider,
            serviceID,
            packages: result.variations.map(v => ({
                variation_code: v.variation_code,
                name: v.name,
                amount: v.amount,
                description: v.description
            }))
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // VERIFICATION
    // ═══════════════════════════════════════════════════════════════════

    async verifyElectricityMeter({ provider, meterNumber, meterType = 'prepaid' }) {
        const serviceID = this.getServiceID('electricity', provider);
        if (!serviceID) return { success: false, error: `Unsupported electricity provider: ${provider}` };

        const requestId = this.generateRequestId();

        try {
            const response = await this.axiosInstance.post(
                `${this.baseUrl}/merchant-verify`,
                { request_id: requestId, serviceID, billersCode: meterNumber, type: meterType },
                { headers: this.getPostHeaders(), timeout: 15000 }
            );

            const data = response.data;
            const code = String(data?.code || '').trim();

            if (code !== '000') {
                return { success: false, error: this.getFriendlyError(code), code, requestId };
            }

            const content = data?.content || {};

            return {
                success: true,
                requestId,
                customerName: content.Customer_Name || content.customerName || null,
                customerAddress: content.Customer_Address || content.address || null,
                meterNumber: content.Meter_Number || meterNumber,
                meterType: content.Meter_Type || meterType,
                minAmount: parseFloat(content.Min_Purchase_Amount) || 0,
                maxAmount: parseFloat(content.Max_Purchase_Amount) || 0,
                canVend: content.Can_Vend !== false,
                raw: content
            };
        } catch (error) {
            console.error('VTpass verifyElectricityMeter failed:', {
                provider,
                meterNumber: meterNumber ? String(meterNumber).slice(0, 4) + '****' : null,
                status: error.response?.status,
                message: error.message
            });
            const apiData = error.response?.data;
            const code = apiData?.code || 'CONNECTION_ERROR';
            return { success: false, error: this.getFriendlyError(code), code, requestId };
        }
    }

    async verifyTvCustomer({ provider, customerId }) {
        const serviceID = this.getServiceID('tv', provider);
        if (!serviceID) return { success: false, error: `Unsupported TV provider: ${provider}` };

        const requestId = this.generateRequestId();

        try {
            const response = await this.axiosInstance.post(
                `${this.baseUrl}/merchant-verify`,
                { request_id: requestId, serviceID, billersCode: customerId },
                { headers: this.getPostHeaders(), timeout: 15000 }
            );

            const data = response.data;
            const code = String(data?.code || '').trim();

            if (code !== '000') {
                return { success: false, error: this.getFriendlyError(code), code, requestId };
            }

            const content = data?.content || {};

            return {
                success: true,
                requestId,
                customerName: content.Customer_Name || content.customerName || null,
                customerNumber: content.Customer_Number || content.customerNumber || customerId,
                currentPackage: content.Current_Bouquet || content.currentBouquet || null,
                renewalAmount: parseFloat(content.Renewal_Amount) || 0,
                dueDate: content.Due_Date || null,
                raw: content
            };
        } catch (error) {
            console.error('VTpass verifyTvCustomer failed:', {
                provider,
                customerId: customerId ? String(customerId).slice(0, 4) + '****' : null,
                status: error.response?.status,
                message: error.message
            });
            const apiData = error.response?.data;
            const code = apiData?.code || 'CONNECTION_ERROR';
            return { success: false, error: this.getFriendlyError(code), code, requestId };
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // PURCHASES
    // ═══════════════════════════════════════════════════════════════════

    async purchaseAirtime({ phone, network, amount }) {
        const startedAt = Date.now();

        const validation = this.validatePhone(phone);
        if (!validation.valid) {
            return {
                success: false, state: 'failed', error: validation.error,
                requestId: null, friendlyError: validation.error
            };
        }

        const finalNetwork = (network || validation.network || '').toLowerCase();
        const serviceID = this.getServiceID('airtime', finalNetwork);

        if (!serviceID) {
            return {
                success: false, state: 'failed',
                error: `Unsupported network: ${finalNetwork}`,
                requestId: null,
                friendlyError: `Unsupported network: ${finalNetwork}`
            };
        }

        const requestId = this.generateRequestId();
        const payload = { request_id: requestId, serviceID, amount, phone: validation.phone };

        try {
            const response = await this.axiosInstance.post(
                `${this.baseUrl}/pay`, payload,
                { headers: this.getPostHeaders(), timeout: 30000 }
            );

            const data = response.data;
            const normalized = this.normalizeTransactionStatus(data);

            console.log('VTpass airtime response:', {
                requestId,
                duration: `${Date.now() - startedAt}ms`,
                code: data?.code,
                providerStatus: data?.content?.transactions?.status,
                state: normalized.state
            });

            return {
                success: normalized.state === 'completed',
                state: normalized.state,
                requestId,
                transactionId: data?.content?.transactions?.transactionId || data?.transactionId || null,
                providerStatus: normalized.providerStatus,
                code: normalized.code,
                message: data?.response_description || null,
                friendlyError: normalized.state === 'failed' ? this.getFriendlyError(normalized.code) : null,
                error: normalized.state === 'failed' ? (data?.response_description || 'Airtime purchase failed') : null,
                data
            };
        } catch (error) {
            const apiData = error.response?.data;
            const isTimeout =
                error.code === 'ECONNABORTED' ||
                error.code === 'ETIMEDOUT' ||
                (error.message || '').toLowerCase().includes('timeout');

            console.error('VTpass airtime request failed:', {
                requestId,
                duration: `${Date.now() - startedAt}ms`,
                status: error.response?.status,
                message: error.message
            });

            if (isTimeout || !error.response) {
                return {
                    success: false, state: 'processing', requestId,
                    transactionId: null, providerStatus: 'unknown', code: 'TIMEOUT',
                    error: 'Provider response not received',
                    friendlyError: this.getFriendlyError('TIMEOUT'),
                    data: apiData || null
                };
            }

            return {
                success: false, state: 'failed', requestId,
                transactionId: null, providerStatus: 'failed',
                code: apiData?.code || 'CONNECTION_ERROR',
                error: apiData?.response_description || error.message || 'VTpass request failed',
                friendlyError: this.getFriendlyError(apiData?.code) || this.getFriendlyError('default'),
                data: apiData || null
            };
        }
    }

    async purchaseData({ phone, network, variationCode }) {
        const startedAt = Date.now();

        const validation = this.validatePhone(phone);
        if (!validation.valid) {
            return {
                success: false, state: 'failed', error: validation.error,
                requestId: null, friendlyError: validation.error
            };
        }

        const finalNetwork = (network || validation.network || '').toLowerCase();
        const serviceID = this.getServiceID('data', finalNetwork);

        if (!serviceID) {
            return {
                success: false, state: 'failed',
                error: `Unsupported network: ${finalNetwork}`,
                requestId: null,
                friendlyError: `Unsupported network: ${finalNetwork}`
            };
        }

        let planData = null;
        try {
            const variations = await this.getVariations(serviceID);
            planData = variations?.variations?.find(v => v.variation_code === variationCode);
        } catch (e) {
            console.error('Failed to fetch plan details:', e.message);
            return {
                success: false, state: 'failed', requestId: null, transactionId: null,
                error: 'Unable to load data plan. Please refresh and try again.',
                friendlyError: 'Unable to load data plan. Please refresh and try again.',
                code: 'PLAN_FETCH_FAILED'
            };
        }

        if (!planData) {
            return {
                success: false, state: 'failed', requestId: null, transactionId: null,
                error: `Data plan "${variationCode}" is unavailable for ${finalNetwork}`,
                friendlyError: 'Selected data plan is no longer available. Please select another plan.',
                code: 'INVALID_PLAN'
            };
        }

        const planAmount = planData.amount || 0;
        if (planAmount <= 0) {
            return {
                success: false, state: 'failed', requestId: null, transactionId: null,
                error: 'Invalid data plan amount',
                friendlyError: 'Invalid data plan. Please select another plan.',
                code: 'INVALID_PLAN_AMOUNT'
            };
        }

        const requestId = this.generateRequestId();
        const payload = {
            request_id: requestId,
            serviceID,
            billersCode: validation.phone,
            variation_code: variationCode,
            amount: planAmount,
            phone: validation.phone
        };

        try {
            const response = await this.axiosInstance.post(
                `${this.baseUrl}/pay`, payload,
                { headers: this.getPostHeaders(), timeout: 30000 }
            );

            const data = response.data;
            const normalized = this.normalizeTransactionStatus(data);

            console.log('VTpass data response:', {
                requestId,
                duration: `${Date.now() - startedAt}ms`,
                code: data?.code,
                providerStatus: data?.content?.transactions?.status,
                state: normalized.state
            });

            return {
                success: normalized.state === 'completed',
                state: normalized.state,
                requestId,
                transactionId: data?.content?.transactions?.transactionId || data?.transactionId || null,
                providerStatus: normalized.providerStatus,
                code: normalized.code,
                message: data?.response_description || null,
                amount: planAmount,
                friendlyError: normalized.state === 'failed' ? this.getFriendlyError(normalized.code) : null,
                error: normalized.state === 'failed' ? (data?.response_description || 'Data purchase failed') : null,
                data
            };
        } catch (error) {
            const apiData = error.response?.data;
            const isTimeout =
                error.code === 'ECONNABORTED' ||
                error.code === 'ETIMEDOUT' ||
                (error.message || '').toLowerCase().includes('timeout');

            console.error('VTpass data request failed:', {
                requestId,
                duration: `${Date.now() - startedAt}ms`,
                status: error.response?.status,
                message: error.message
            });

            if (isTimeout || !error.response) {
                return {
                    success: false, state: 'processing', requestId,
                    transactionId: null, providerStatus: 'unknown', code: 'TIMEOUT',
                    amount: planAmount,
                    error: 'Provider response not received',
                    friendlyError: this.getFriendlyError('TIMEOUT'),
                    data: apiData || null
                };
            }

            return {
                success: false, state: 'failed', requestId,
                transactionId: null, providerStatus: 'failed',
                code: apiData?.code || 'CONNECTION_ERROR',
                amount: planAmount,
                error: apiData?.response_description || error.message || 'VTpass request failed',
                friendlyError: this.getFriendlyError(apiData?.code) || this.getFriendlyError('default'),
                data: apiData || null
            };
        }
    }

    async purchaseElectricity({ provider, meterNumber, meterType, amount, phone }) {
        const startedAt = Date.now();
        const serviceID = this.getServiceID('electricity', provider);
        if (!serviceID) {
            return {
                success: false, state: 'failed',
                error: `Unsupported electricity provider: ${provider}`,
                requestId: null,
                friendlyError: `Unsupported electricity provider: ${provider}`
            };
        }

        const requestId = this.generateRequestId();
        const payload = {
            request_id: requestId,
            serviceID,
            billersCode: meterNumber,
            variation_code: meterType,
            amount,
            phone: phone || '08000000000'
        };

        try {
            const response = await this.axiosInstance.post(
                `${this.baseUrl}/pay`, payload,
                { headers: this.getPostHeaders(), timeout: 30000 }
            );

            const data = response.data;
            const normalized = this.normalizeTransactionStatus(data);

            console.log('VTpass electricity response:', {
                requestId,
                duration: `${Date.now() - startedAt}ms`,
                code: data?.code,
                providerStatus: data?.content?.transactions?.status,
                state: normalized.state
            });

            const token =
                data?.purchased_code ||
                data?.content?.transactions?.product_token ||
                data?.content?.transactions?.token ||
                data?.Token ||
                null;

            return {
                success: normalized.state === 'completed',
                state: normalized.state,
                requestId,
                transactionId: data?.content?.transactions?.transactionId || data?.transactionId || null,
                providerStatus: normalized.providerStatus,
                code: normalized.code,
                token,
                units: data?.content?.transactions?.units || null,
                message: data?.response_description || null,
                friendlyError: normalized.state === 'failed' ? this.getFriendlyError(normalized.code) : null,
                error: normalized.state === 'failed' ? (data?.response_description || 'Electricity payment failed') : null,
                data
            };
        } catch (error) {
            const apiData = error.response?.data;
            const isTimeout =
                error.code === 'ECONNABORTED' ||
                error.code === 'ETIMEDOUT' ||
                (error.message || '').toLowerCase().includes('timeout');

            console.error('VTpass electricity request failed:', {
                requestId,
                duration: `${Date.now() - startedAt}ms`,
                status: error.response?.status,
                message: error.message
            });

            if (isTimeout || !error.response) {
                return {
                    success: false, state: 'processing', requestId,
                    transactionId: null, providerStatus: 'unknown', code: 'TIMEOUT',
                    error: 'Provider response not received',
                    friendlyError: this.getFriendlyError('TIMEOUT'),
                    data: apiData || null
                };
            }

            return {
                success: false, state: 'failed', requestId,
                transactionId: null, providerStatus: 'failed',
                code: apiData?.code || 'CONNECTION_ERROR',
                error: apiData?.response_description || error.message || 'VTpass request failed',
                friendlyError: this.getFriendlyError(apiData?.code) || this.getFriendlyError('default'),
                data: apiData || null
            };
        }
    }

    async purchaseTv({ provider, customerId, variationCode, amount, subscriptionType, phone }) {
        const startedAt = Date.now();
        const serviceID = this.getServiceID('tv', provider);
        if (!serviceID) {
            return {
                success: false, state: 'failed',
                error: `Unsupported TV provider: ${provider}`,
                requestId: null,
                friendlyError: `Unsupported TV provider: ${provider}`
            };
        }

        const requestId = this.generateRequestId();
        const payload = {
            request_id: requestId,
            serviceID,
            billersCode: customerId,
            variation_code: variationCode,
            amount,
            phone: phone || '08000000000',
            subscription_type: subscriptionType || 'renew'
        };

        try {
            const response = await this.axiosInstance.post(
                `${this.baseUrl}/pay`, payload,
                { headers: this.getPostHeaders(), timeout: 30000 }
            );

            const data = response.data;
            const normalized = this.normalizeTransactionStatus(data);

            console.log('VTpass TV response:', {
                requestId,
                duration: `${Date.now() - startedAt}ms`,
                code: data?.code,
                providerStatus: data?.content?.transactions?.status,
                state: normalized.state
            });

            return {
                success: normalized.state === 'completed',
                state: normalized.state,
                requestId,
                transactionId: data?.content?.transactions?.transactionId || data?.transactionId || null,
                providerStatus: normalized.providerStatus,
                code: normalized.code,
                message: data?.response_description || null,
                friendlyError: normalized.state === 'failed' ? this.getFriendlyError(normalized.code) : null,
                error: normalized.state === 'failed' ? (data?.response_description || 'TV subscription failed') : null,
                data
            };
        } catch (error) {
            const apiData = error.response?.data;
            const isTimeout =
                error.code === 'ECONNABORTED' ||
                error.code === 'ETIMEDOUT' ||
                (error.message || '').toLowerCase().includes('timeout');

            console.error('VTpass TV request failed:', {
                requestId,
                duration: `${Date.now() - startedAt}ms`,
                status: error.response?.status,
                message: error.message
            });

            if (isTimeout || !error.response) {
                return {
                    success: false, state: 'processing', requestId,
                    transactionId: null, providerStatus: 'unknown', code: 'TIMEOUT',
                    error: 'Provider response not received',
                    friendlyError: this.getFriendlyError('TIMEOUT'),
                    data: apiData || null
                };
            }

            return {
                success: false, state: 'failed', requestId,
                transactionId: null, providerStatus: 'failed',
                code: apiData?.code || 'CONNECTION_ERROR',
                error: apiData?.response_description || error.message || 'VTpass request failed',
                friendlyError: this.getFriendlyError(apiData?.code) || this.getFriendlyError('default'),
                data: apiData || null
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // REQUERY
    // ═══════════════════════════════════════════════════════════════════

    async queryTransaction(requestId) {
        if (!requestId) {
            return {
                success: false, state: 'failed',
                error: 'No request ID provided',
                friendlyError: 'Transaction reference missing. Please contact support.',
                requestId: null
            };
        }

        try {
            console.log(`Querying transaction: ${requestId}`);

            const response = await this.axiosInstance.post(
                `${this.baseUrl}/requery`,
                { request_id: requestId },
                { headers: this.getPostHeaders(), timeout: 15000 }
            );

            const data = response.data;
            const normalized = this.normalizeTransactionStatus(data);

            console.log('VTpass requery response:', {
                requestId,
                code: data?.code,
                providerStatus: data?.content?.transactions?.status,
                state: normalized.state
            });

            return {
                success: normalized.state === 'completed',
                state: normalized.state,
                requestId,
                providerStatus: normalized.providerStatus,
                code: normalized.code,
                transactionId: data?.content?.transactions?.transactionId || data?.transactionId || null,
                token: data?.purchased_code || data?.content?.transactions?.token || null,
                units: data?.content?.transactions?.units || null,
                customerName: data?.customerName || null,
                friendlyError: normalized.state === 'failed' ? this.getFriendlyError(normalized.code) : null,
                data
            };
        } catch (error) {
            console.error('VTpass requery error:', {
                requestId,
                message: error.message,
                code: error.code,
                status: error.response?.status
            });

            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                return {
                    success: false, state: 'processing', requestId,
                    error: 'Request timed out',
                    friendlyError: this.getFriendlyError('TIMEOUT'),
                    code: 'TIMEOUT'
                };
            }

            return {
                success: false, state: 'failed', requestId,
                error: error.response?.data?.response_description || error.message,
                friendlyError: this.getFriendlyError('default'),
                code: error.response?.data?.code || 'UNKNOWN_ERROR'
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // HEALTH / CACHE
    // ═══════════════════════════════════════════════════════════════════

    async healthCheck() {
        const results = {
            environment: this.environment,
            baseUrl: this.baseUrl,
            configured: this.isConfigured(),
            credentials: {
                apiKey: !!this.apiKey,
                publicKey: !!this.publicKey,
                secretKey: !!this.secretKey
            },
            sandboxNumbers: this.isSandbox ? Object.keys(this.getSandboxTestNumbers()) : [],
            connectivity: false,
            responseTime: null,
            status: null,
            error: null
        };

        try {
            const startedAt = Date.now();
            const response = await this.axiosInstance.get(
                `${this.baseUrl}/service-variations`,
                {
                    params: { serviceID: 'mtn' },
                    headers: this.getGetHeaders(),
                    timeout: 10000
                }
            );
            results.connectivity = true;
            results.responseTime = Date.now() - startedAt;
            results.status = response.status;
        } catch (error) {
            results.connectivity = false;
            results.error = error.response?.data?.response_description || error.message;
            results.status = error.response?.status || 0;
        }

        return results;
    }

    clearCache() {
        this.catalogCache.clear();
        this.catalogPending.clear();
        console.log('VTpass cache cleared');
    }

    getCacheStats() {
        return {
            catalogCacheSize: this.catalogCache.size,
            catalogPendingSize: this.catalogPending.size,
            catalogTTL: this.CATALOG_CACHE_TTL
        };
    }
}

module.exports = new VTpassService();