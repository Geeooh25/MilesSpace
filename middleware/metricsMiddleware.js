'use strict';

const metrics = require('../services/applicationMetricsService');

module.exports = function metricsMiddleware(req, res, next) {
    const started = process.hrtime.bigint();

    // Only count real API/admin routes. Ignore static assets so the
    // counter reflects business traffic.
    const path = req.path || '';
    const isStatic = /\.(?:js|css|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|ico|map)$/i.test(path);
    if (isStatic || path.startsWith('/_next') || path === '/favicon.ico') {
        return next();
    }

    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        metrics.record({ status: res.statusCode, durationMs });
    });

    next();
};