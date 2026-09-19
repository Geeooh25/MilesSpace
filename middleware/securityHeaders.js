// middleware/securityHeaders.js
const helmet = require('helmet');

const securityHeaders = () => {
    return [
        helmet(),
        helmet.contentSecurityPolicy({
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:", "https:"],
                fontSrc: ["'self'", "https:", "data:"],
                connectSrc: ["'self'", "https://*.supabase.co", "https://*.upstash.io"]
            }
        }),
        helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true }),
        helmet.frameguard({ action: 'deny' }),
        helmet.xssFilter(),
        helmet.noSniff(),
        helmet.referrerPolicy({ policy: 'strict-origin-when-cross-origin' }),
        (req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            next();
        }
    ];
};

module.exports = securityHeaders;