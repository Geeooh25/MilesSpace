// services/pricingService.js
//
// Central pricing helper for MilesSpace.
//
// Wholesale prices come from providers (DT One, VTPass, etc.) in whatever
// currency the provider bills us in. Callers are responsible for
// normalising to NGN before invoking computePrice.
//
//   priceNgn = wholesaleNgn * (1 + markupPct)
//   priceUsd = priceNgn / usdToNgn
//
// Both outputs are rounded to 2 decimals. Negative or non-numeric inputs
// are treated as zero so this function never returns NaN.

/**
 * @param {number} wholesaleNgn  What we pay the provider, in NGN.
 * @param {number} usdToNgn      USD→NGN exchange rate used by the platform.
 * @param {number} markupPct     Markup as a decimal (0.1570 = 15.70%).
 * @returns {{ priceNgn: number, priceUsd: number, markupPct: number, usdToNgn: number, wholesaleNgn: number }}
 */
function computePrice(wholesaleNgn, usdToNgn, markupPct) {
    const wNgn = safeNumber(wholesaleNgn, 0);
    const rate = safeNumber(usdToNgn, 1600);
    const markup = safeNumber(markupPct, 0);

    // Clamp negatives to 0
    const wNgnClamped = wNgn > 0 ? wNgn : 0;
    const rateClamped = rate > 0 ? rate : 1600;
    const markupClamped = markup > 0 ? markup : 0;

    const priceNgn = +(wNgnClamped * (1 + markupClamped)).toFixed(2);
    const priceUsd = +(priceNgn / rateClamped).toFixed(2);

    return {
        priceNgn,
        priceUsd,
        markupPct: markupClamped,
        usdToNgn: rateClamped,
        wholesaleNgn: +wNgnClamped.toFixed(4)
    };
}

/**
 * Reverse of computePrice — given a customer-facing price and a markup,
 * figure out the implied wholesale price. Handy for verification and for
 * admin reporting where you want to know the margin on an existing order.
 *
 * @param {number} priceNgn      Customer-facing NGN price.
 * @param {number} markupPct     Markup as a decimal (0.1570 = 15.70%).
 * @returns {{ wholesaleNgn: number, markupPct: number, marginNgn: number }}
 */
function reversePrice(priceNgn, markupPct) {
    const price = safeNumber(priceNgn, 0);
    const markup = safeNumber(markupPct, 0);

    if (price <= 0 || markup <= 0) {
        return { wholesaleNgn: 0, markupPct: 0, marginNgn: 0 };
    }

    const wholesaleNgn = +(price / (1 + markup)).toFixed(4);
    const marginNgn = +(price - wholesaleNgn).toFixed(4);

    return { wholesaleNgn, markupPct: markup, marginNgn };
}

/**
 * Returns the margin (profit) in NGN and USD, given a wholesale and
 * markup. Useful for analytics / dashboards.
 */
function computeMargin(wholesaleNgn, usdToNgn, markupPct) {
    const { priceNgn, priceUsd, wholesaleNgn: w } = computePrice(
        wholesaleNgn,
        usdToNgn,
        markupPct
    );

    const rate = safeNumber(usdToNgn, 1600) || 1600;
    const marginNgn = +(priceNgn - w).toFixed(4);
    const marginUsd = +(marginNgn / rate).toFixed(4);
    const marginPct =
        w > 0 ? +((marginNgn / w) * 100).toFixed(4) : 0;

    return {
        priceNgn,
        priceUsd,
        wholesaleNgn: w,
        marginNgn,
        marginUsd,
        marginPct
    };
}

// ─── Internal helper ──────────────────────────────────────────────────────
function safeNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

module.exports = {
    computePrice,
    reversePrice,
    computeMargin
};