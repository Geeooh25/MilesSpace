'use strict';

// Optional audit integrity chain.
//
// When AUDIT_INTEGRITY=enabled, each new audit row stores
// `event_hash` and `previous_event_hash`, forming a chain. A
// separate endpoint can later verify the chain end-to-end without
// touching the main audit write path.
//
// Disabled by default — this costs one extra tiny SELECT per insert
// (the previous hash). If you ever want zero overhead, leave it off.

const crypto = require('crypto');

function enabled() {
    return String(process.env.AUDIT_INTEGRITY || '').toLowerCase() === 'enabled';
}

function hashRow(row, previousHash) {
    const payload = JSON.stringify({
        id: row.id || null,
        action: row.action || null,
        category: row.category || null,
        severity: row.severity || null,
        admin_id: row.admin_id || null,
        target_type: row.target_type || null,
        target_id: row.target_id || null,
        result: row.result || null,
        request_id: row.request_id || null,
        session_id: row.session_id || null,
        created_at: row.created_at || null,
        before: row.before || null,
        after: row.after || null,
        previous: previousHash || null
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

// Compute the hash for the next row. Returns { eventHash, previousHash }.
async function nextHash(supabaseAdmin, row) {
    if (!enabled()) return { eventHash: null, previousHash: null };
    try {
        const { data } = await supabaseAdmin
            .from('admin_audit_logs')
            .select('event_hash')
            .not('event_hash', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        const previousHash = data?.event_hash || null;
        return { eventHash: hashRow(row, previousHash), previousHash };
    } catch {
        return { eventHash: null, previousHash: null };
    }
}

module.exports = { enabled, nextHash, hashRow };