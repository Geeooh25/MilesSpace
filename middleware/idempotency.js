// middleware/idempotency.js
const crypto = require('crypto');

function generateIdempotencyKey(prefix = 'ik') {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function validateIdempotencyKey(req, res, next) {
    const key = req.headers['idempotency-key'] || req.body?.idempotency_key;
    
    if (!key) {
        return res.status(400).json({
            success: false,
            error: 'Missing idempotency key'
        });
    }

    // Store the key in the request for later use
    req.idempotencyKey = key;
    next();
}

// ─── CHECK DUPLICATE ───
async function isDuplicateTransaction(idempotencyKey, supabaseAdmin) {
    const { data, error } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

    if (error) return false;
    return !!data;
}

module.exports = {
    generateIdempotencyKey,
    validateIdempotencyKey,
    isDuplicateTransaction
};