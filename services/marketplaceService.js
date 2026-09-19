// services/marketplaceService.js
// MilesSpace Marketplace — pricing, sanitizers, IDs, delivery payload.
'use strict';

const crypto = require('crypto');
const { AdminConfigService } = require('./ledgerService');

// ─── PRICING (server-authoritative) ────────────────────────────────
async function computePrice(product, walletType) {
    const usdToNgn = await AdminConfigService.getExchangeRate();
    const markupPct = await AdminConfigService.getMarkup('marketplace');

    const baseUsd = parseFloat(product.price_usd) || 0;
    const markupMultiplier = 1 + (markupPct / 100);

    const finalUsd = +(baseUsd * markupMultiplier).toFixed(2);

    let finalNgn;
    if (product.price_ngn && parseFloat(product.price_ngn) > 0) {
        finalNgn = +(parseFloat(product.price_ngn) * markupMultiplier).toFixed(2);
    } else {
        finalNgn = +(finalUsd * usdToNgn).toFixed(2);
    }

    return {
        usd: finalUsd,
        ngn: finalNgn,
        usdToNgn,
        markupPct,
        chargeUsd: walletType === 'USD' ? finalUsd : null,
        chargeNgn: walletType === 'NGN' ? finalNgn : null,
        charge: walletType === 'USD' ? finalUsd : finalNgn,
    };
}

// ─── SANITIZERS ────────────────────────────────────────────────────
// Products: EVERYTHING the frontend needs — INCLUDING long_description.
function sanitizeProduct(p) {
    if (!p) return null;
    return {
        id: p.id,
        name: p.name || 'Unknown',
        category: p.category_id || 'other',
        categoryName: p.category_name || p.category_id || 'Other',
        description: p.description || '',
        // ─── The fields the frontend modal needs ───
        longDescription: p.long_description || '',
        howToUse: p.how_to_use || '',
        features: p.features || '',
        // ─── Everything else ───
        country: p.country || 'Global',
        price: parseFloat(p.price_usd) || 0,
        priceUsd: parseFloat(p.price_usd) || 0,
        priceNgn: parseFloat(p.price_ngn) || 0,
        stock: parseInt(p.stock) || 0,
        qty: parseInt(p.stock) || 0,
        sold: parseInt(p.sold) || 0,
        deliveryType: p.delivery_type || 'structured',
        status: p.status,
        badge: '',
        tags: [],
    };
}

function sanitizeOrderRow(o) {
    if (!o) return null;
    return {
        id: o.id,
        orderRef: o.order_ref,
        productId: o.product_id,
        productName: o.product_title || o.product_name,
        category: o.category_id || 'other',
        quantity: o.quantity || 1,
        amountUsd: parseFloat(o.price_usd) || 0,
        amountNgn: parseFloat(o.price_ngn) || parseFloat(o.total) || 0,
        currency: o.wallet_used || o.wallet || 'NGN',
        status: o.status,
        transactionId: o.transaction_id || o.unified_transaction_id || null,
        inventoryId: o.inventory_id || null,
        downloadCount: o.download_count || 0,
        lastDownloadAt: o.last_download_at,
        createdAt: o.created_at,
        completedAt: o.completed_at,
        deliveredData: o.delivered_data || null,
    };
}

// ─── IDS / TOKENS ──────────────────────────────────────────────────
function generateOrderId() {
    // UUID — required because ledger's source_id column is UUID
    return crypto.randomUUID();
}

function generateOrderRef() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `ORD-${ts}-${rand}`;
}

function generateDownloadToken() {
    return crypto.randomBytes(32).toString('hex');
}

// ─── DELIVERY FORMATTER ────────────────────────────────────────────
function buildDeliveryPayload(inventoryRow, order, product) {
    let parsedContent = inventoryRow.content;
    let loginFormat = 'N/A';
    let loginInstructions = '';

    try {
        const j = JSON.parse(inventoryRow.content);
        if (j && typeof j === 'object') {
            parsedContent = j;
            loginFormat = j.format || j.login_format || 'N/A';
            loginInstructions = j.instructions || j.login_instructions || '';
        }
    } catch {
        // Plain text; keep as-is
    }

    return {
        inventory_id: inventoryRow.id,
        delivery_type: inventoryRow.delivery_type || 'structured',
        content: parsedContent,
        login_format: loginFormat,
        login_instructions: loginInstructions,
        product_name: product?.name || order.product_title,
        delivered_at: new Date().toISOString(),
    };
}

module.exports = {
    computePrice,
    sanitizeProduct,
    sanitizeOrderRow,
    generateOrderId,
    generateOrderRef,
    generateDownloadToken,
    buildDeliveryPayload,
};