// services/pricingService.js
//
// Markup pricing:
//
//   priceNgn = wholesaleNgn × (1 + markupNgn)
//   priceUsd = wholesaleUsd × (1 + markupUsd)
//
// USD and NGN can have different markups.
// wholesaleUsd is derived from wholesaleNgn / usdToNgn when not
// supplied directly.

/**
 * Compute both NGN and USD prices from a wholesale amount.
 *
 * @param {number} wholesaleNgn   What DT One charges, expressed in NGN
 * @param {number} usdToNgn       Admin-configured USD → NGN rate
 * @param {number|{usd:number,ngn:number}} markup
 *        Either a single decimal (legacy) OR a {usd, ngn} pair.
 * @returns {object} { wholesaleNgn, wholesaleUsd, usdToNgn,
 *                     markupUsd, markupNgn,
 *                     priceUsd, priceNgn,
 *                     profitUsd, profitNgn,
 *                     marginUsd, marginNgn }
 */
function computePrice(wholesaleNgn, usdToNgn, markup) {
    const wholesaleNgnNum = Number(wholesaleNgn) || 0;
    const usdToNgnNum     = Number(usdToNgn) > 0 ? Number(usdToNgn) : 1;

    // Normalize markup input
    let markupUsd, markupNgn;
    if (markup && typeof markup === 'object') {
        markupUsd = sanitizeMarkup(markup.usd ?? markup.ngn ?? 0.15);
        markupNgn = sanitizeMarkup(markup.ngn ?? markup.usd ?? 0.15);
    } else {
        const single = sanitizeMarkup(markup ?? 0.15);
        markupUsd = single;
        markupNgn = single;
    }

    const wholesaleUsd = wholesaleNgnNum / usdToNgnNum;

    const priceNgn = +(wholesaleNgnNum * (1 + markupNgn)).toFixed(2);
    const priceUsd = +(wholesaleUsd   * (1 + markupUsd)).toFixed(2);

    const profitNgn = +(priceNgn - wholesaleNgnNum).toFixed(2);
    const profitUsd = +(priceUsd - wholesaleUsd).toFixed(2);

    const marginNgn = priceNgn > 0 ? +((profitNgn / priceNgn) * 100).toFixed(2) : 0;
    const marginUsd = priceUsd > 0 ? +((profitUsd / priceUsd) * 100).toFixed(2) : 0;

    return {
        wholesaleNgn: +wholesaleNgnNum.toFixed(4),
        wholesaleUsd: +wholesaleUsd.toFixed(4),
        usdToNgn: usdToNgnNum,
        markupUsd,
        markupNgn,
        priceNgn,
        priceUsd,
        profitNgn,
        profitUsd,
        marginNgn,
        marginUsd
    };
}

function sanitizeMarkup(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0.15;
    return n;
}

/**
 * Convenience: given a full settings object from adminConfigService,
 * pick the {usd, ngn} markup for the given service key.
 *
 *   pickMarkup(settings, 'giftcard') → { usd: 0.157, ngn: 0.157 }
 */
function pickMarkup(settings, serviceKey) {
    const svc = settings?.markup?.[serviceKey];
    if (svc && typeof svc === 'object') {
        return {
            usd: sanitizeMarkup(svc.usd ?? svc.ngn ?? 0.15),
            ngn: sanitizeMarkup(svc.ngn ?? svc.usd ?? 0.15)
        };
    }
    // Legacy fallback
    const legacy = Number(settings?.[`${serviceKey}_markup_pct`]);
    const single = Number.isFinite(legacy) && legacy >= 0 ? legacy : 0.15;
    return { usd: single, ngn: single };
}

module.exports = { computePrice, pickMarkup };