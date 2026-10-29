// middleware/maintenanceGuard.js
'use strict';

const adminSettings = require('../services/adminSettingsService');

async function maintenanceGuard(req, res, next) {
    try {
        // Skip admin, auth, and static asset routes
        if (
            req.path.startsWith('/api/admin') ||
            req.path.startsWith('/admin') ||
            req.path.startsWith('/api/auth') ||
            req.path.startsWith('/api/wallet') ||
            req.path.startsWith('/api/public-settings') ||
            req.path.match(/\.(css|js|png|jpg|jpeg|svg|woff|woff2|ttf|eot|ico|json)$/i)
        ) {
            return next();
        }

        const isMaintenance = await adminSettings.getBoolean('maintenance_mode');
        if (!isMaintenance) return next();

        // If this is an API call, return JSON
        if (req.path.startsWith('/api/')) {
            return res.status(503).json({
                success: false,
                code: 'MAINTENANCE_MODE',
                error: 'The platform is currently under maintenance. Please check back later.'
            });
        }

        const msg = await adminSettings.getRaw('maintenance_message') || 'We are currently under maintenance. Please check back later.';
        const platformName = await adminSettings.getRaw('platform_name') || 'MilesSpace';

        res.status(503).send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${platformName} - Maintenance</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f4f7fb;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
        }
        .card {
            background: #fff;
            border-radius: 20px;
            padding: 48px 36px;
            max-width: 480px;
            text-align: center;
            box-shadow: 0 16px 48px -12px rgba(8,42,51,.2);
        }
        .icon {
            width: 64px; height: 64px;
            border-radius: 50%;
            background: #fef3c7;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
            font-size: 28px;
        }
        h1 { color: #0c3d4a; font-size: 22px; margin-bottom: 12px; }
        p { color: #5b7480; font-size: 15px; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">🛠️</div>
        <h1>${platformName} is under maintenance</h1>
        <p>${msg}</p>
    </div>
</body>
</html>`);
    } catch (e) {
        console.error('[MAINTENANCE GUARD] error:', e.message);
        next();
    }
}

module.exports = maintenanceGuard;