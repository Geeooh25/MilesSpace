const express = require('express');
const router = express.Router();
const axios = require('axios');

// GET /api/banks - Fetch list of Nigerian banks
router.get('/', async (req, res) => {
    try {
        const response = await axios.get('https://api.paystack.co/bank', {
            params: { country: 'nigeria' }
        });
        if (response.data.status) {
            const banks = response.data.data.map(b => ({
                name: b.name,
                code: b.code,
                slug: b.slug,
                currency: b.currency || 'NGN',
                country: b.country || 'Nigeria'
            }));
            return res.json({ success: true, data: banks });
        } else {
            throw new Error('Paystack API error');
        }
    } catch (error) {
        console.error('Bank fetch error:', error);
        // Fallback static list
        const fallbackBanks = [
            { name: 'Access Bank', code: '044' },
            { name: 'GTBank', code: '058' },
            { name: 'First Bank', code: '011' },
            { name: 'Zenith Bank', code: '057' },
            { name: 'UBA', code: '033' },
            { name: 'Opay', code: '999' },
            { name: 'PalmPay', code: '999' },
            { name: 'Kuda Bank', code: '999' },
            { name: 'Moniepoint', code: '999' }
        ].map(b => ({ name: b.name, code: b.code }));
        res.json({ success: true, data: fallbackBanks, fallback: true });
    }
});

module.exports = router;