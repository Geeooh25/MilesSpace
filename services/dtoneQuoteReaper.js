// services/dtoneQuoteReaper.js
// Cancels expired quote reservations with DT One and releases held balance.

const { supabaseAdmin } = require('../db/supabase');
const dtoneService = require('./dtoneService');

const REAP_INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 25;

async function reapExpiredQuotes() {
    const nowIso = new Date().toISOString();

    const { data: expired, error } = await supabaseAdmin
        .from('airtime_quotes')
        .select('quote_id, dtone_transaction_id, user_id, created_at, expires_at')
        .eq('status', 'created')
        .lt('expires_at', nowIso)
        .order('expires_at', { ascending: true })
        .limit(BATCH_SIZE);

    if (error) {
        console.error('❌ [REAPER] Query error:', error.message);
        return { processed: 0, cancelled: 0, ambiguous: 0 };
    }

    if (!expired || expired.length === 0) return { processed: 0, cancelled: 0, ambiguous: 0 };

    console.log(`🧹 [REAPER] Found ${expired.length} expired quotes`);

    let cancelled = 0;
    let ambiguous = 0;

    for (const q of expired) {
        let cancelAmbiguous = false;

        if (q.dtone_transaction_id) {
            try {
                const cancelResult = await dtoneService.cancelTransaction(q.dtone_transaction_id);

                if (cancelResult?.ambiguous) {
                    cancelAmbiguous = true;
                    ambiguous++;
                    console.warn(`⚠️ [REAPER] Cancel ambiguous for ${q.quote_id}`);
                } else if (!cancelResult?.success) {
                    console.warn(`⚠️ [REAPER] Cancel failed for ${q.quote_id}: ${cancelResult?.error || 'unknown'}`);
                }
            } catch (cancelError) {
                console.warn(`⚠️ [REAPER] Cancel threw for ${q.quote_id}:`, cancelError.message);
            }
        }

        try {
            const { data: updated } = await supabaseAdmin
                .from('airtime_quotes')
                .update({
                    status: cancelAmbiguous ? 'expired_cancel_ambiguous' : 'expired',
                    updated_at: new Date().toISOString(),
                    metadata: {
                        reaped_at: new Date().toISOString(),
                        cancel_ambiguous: cancelAmbiguous
                    }
                })
                .eq('quote_id', q.quote_id)
                .eq('status', 'created')
                .select()
                .maybeSingle();

            if (updated) cancelled++;
        } catch (e) {
            console.error(`❌ [REAPER] Error marking ${q.quote_id}:`, e.message);
        }
    }

    console.log(`✅ [REAPER] Expired ${cancelled}/${expired.length} (${ambiguous} ambiguous cancels)`);
    return { processed: expired.length, cancelled, ambiguous };
}

let intervalHandle = null;

function startQuoteReaper() {
    if (intervalHandle) return intervalHandle;

    setTimeout(async () => {
        try { await reapExpiredQuotes(); }
        catch (e) { console.error('Reaper initial error:', e); }
    }, 15000);

    intervalHandle = setInterval(async () => {
        try { await reapExpiredQuotes(); }
        catch (e) { console.error('Reaper error:', e); }
    }, REAP_INTERVAL_MS);

    console.log('🚀 [REAPER] DT One quote reaper started');
    return intervalHandle;
}

module.exports = { reapExpiredQuotes, startQuoteReaper };