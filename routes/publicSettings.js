const express = require('express');
const router = express.Router();
const adminSettings = require('../services/adminSettingsService');

router.get('/public-settings', async (req, res) => {
    try {
        // Only return SAFE, public settings
        const safeKeys = [
            'platform_name', 
            'company_name', 
            'support_email', 
            'support_phone', 
            'website_url'
        ];
        
        const data = {};
        for (const key of safeKeys) {
            data[key] = await adminSettings.getRaw(key);
        }
        
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to load settings' });
    }
});

module.exports = router;