// ─── routes/utils.js ───
// Utility Routes for Phone & Meter Validation

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');

// ─── CONFIG ───
const VT_PASS_API_KEY = process.env.VT_PASS_API_KEY;
const VT_PASS_SECRET = process.env.VT_PASS_SECRET;
const NIBSS_API_KEY = process.env.NIBSS_API_KEY;

// ─── PHONE NUMBER VALIDATION ───
router.post('/validate-phone', authMiddleware, async (req, res) => {
  try {
    const { phone, network } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }

    // ─── Clean phone number ───
    const cleaned = phone.replace(/\s/g, '').replace(/^0/, '234');
    
    // ─── Network detection logic ───
    const networkMap = {
      'mtn': ['0803', '0806', '0810', '0813', '0814', '0816', '0903', '0906', '0913', '0916', '0703', '0706'],
      'glo': ['0805', '0807', '0811', '0815', '0817', '0905', '0915', '0705'],
      'airtel': ['0802', '0808', '0812', '0818', '0902', '0907', '0912', '0701', '0708'],
      '9mobile': ['0809', '0817', '0818', '0909', '0908', '0709']
    };

    const prefix = phone.slice(0, 4);
    let detectedNetwork = null;
    
    for (const [net, prefixes] of Object.entries(networkMap)) {
      if (prefixes.includes(prefix)) {
        detectedNetwork = net;
        break;
      }
    }

    // ─── If network provided, validate against it ───
    if (network && detectedNetwork && detectedNetwork !== network) {
      return res.json({
        success: true,
        data: {
          is_valid: false,
          network: detectedNetwork,
          message: `Number belongs to ${detectedNetwork.toUpperCase()}, not ${network.toUpperCase()}`
        }
      });
    }

    // ─── If no network detected ───
    if (!detectedNetwork) {
      return res.json({
        success: true,
        data: {
          is_valid: false,
          network: null,
          message: 'Could not detect network for this number'
        }
      });
    }

    res.json({
      success: true,
      data: {
        is_valid: true,
        network: detectedNetwork,
        formatted: cleaned,
        message: `Valid ${detectedNetwork.toUpperCase()} number`
      }
    });
  } catch (error) {
    console.error('Phone validation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── METER NUMBER VALIDATION ───
router.post('/validate-meter', authMiddleware, async (req, res) => {
  try {
    const { meterNumber, provider } = req.body;

    if (!meterNumber) {
      return res.status(400).json({ success: false, error: 'Meter number required' });
    }

    // ─── Provider-specific validation ───
    const providerMap = {
      'ikeja': { name: 'IKEDC', prefix: ['IK', 'IKEJA', 'I'] },
      'eko': { name: 'EKEDC', prefix: ['EK', 'EKO', 'E'] },
      'phcn': { name: 'PHCN', prefix: ['PH', 'P'] },
      'abuja': { name: 'AEDC', prefix: ['AB', 'A'] },
      'ibadan': { name: 'IBEDC', prefix: ['IB', 'I'] }
    };

    const providerInfo = providerMap[provider];
    if (!providerInfo) {
      return res.status(400).json({
        success: false,
        error: 'Invalid provider selected'
      });
    }

    // ─── Basic validation ───
    const cleaned = meterNumber.toUpperCase().replace(/\s/g, '');
    
    // Check if meter number exists and is valid (mock validation)
    // In production, integrate with NIBSS or Disco APIs
    const isValid = cleaned.length >= 10 && cleaned.length <= 15;
    
    // Check if it matches provider prefix (if applicable)
    let hasValidPrefix = true;
    if (providerInfo.prefix) {
      hasValidPrefix = providerInfo.prefix.some(p => cleaned.startsWith(p));
    }

    if (!isValid || !hasValidPrefix) {
      return res.json({
        success: true,
        data: {
          is_valid: false,
          message: 'Invalid meter number for ' + providerInfo.name
        }
      });
    }

    // ─── In production, call NIBSS or Disco API here ───
    // For demo, we simulate a successful lookup
    const customerName = `Customer ${cleaned.slice(-4)}`;

    res.json({
      success: true,
      data: {
        is_valid: true,
        customer_name: customerName,
        meter_number: cleaned,
        provider: providerInfo.name,
        message: 'Meter validated successfully'
      }
    });
  } catch (error) {
    console.error('Meter validation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET NETWORK BY PHONE ───
router.post('/network-lookup', authMiddleware, async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }

    const cleaned = phone.replace(/\s/g, '').replace(/^0/, '234');
    const prefix = cleaned.slice(0, 4);

    const networkMap = {
      'MTN': ['0803', '0806', '0810', '0813', '0814', '0816', '0903', '0906', '0913', '0916', '0703', '0706'],
      'Glo': ['0805', '0807', '0811', '0815', '0817', '0905', '0915', '0705'],
      'Airtel': ['0802', '0808', '0812', '0818', '0902', '0907', '0912', '0701', '0708'],
      '9mobile': ['0809', '0817', '0818', '0909', '0908', '0709']
    };

    let network = 'Unknown';
    for (const [net, prefixes] of Object.entries(networkMap)) {
      if (prefixes.includes(prefix)) {
        network = net;
        break;
      }
    }

    res.json({
      success: true,
      data: {
        network: network,
        prefix: prefix,
        formatted: cleaned
      }
    });
  } catch (error) {
    console.error('Network lookup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;