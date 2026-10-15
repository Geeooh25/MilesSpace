// scripts/sync-smmwiz-services.js
// ─────────────────────────────────────────────────────────────────
// Fetches the SMMWiz service catalog and upserts it into
// boost_services. Run once initially, then on a schedule (daily is
// fine — catalogs don't change often).
//
//   node scripts/sync-smmwiz-services.js
//
// Requires:
//   SMMWIZ_API_KEY       in .env
//   SUPABASE_URL         in .env
//   SUPABASE_SERVICE_ROLE_KEY in .env
// ─────────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config({ path: require('path').resolve(process.cwd(), '.env') });

const axios = require('axios');
const { supabaseAdmin } = require('../db/supabase');

const SMMWIZ_API_URL = 'https://smmwiz.com/api/v2';
const DEFAULT_MARKUP_PERCENT = 18; // fallback if app_config is missing

// ─── Platform detection ──────────────────────────────────────────
function detectPlatform(name, category) {
    const n = `${name || ''} ${category || ''}`.toLowerCase();
    if (n.includes('instagram') || n.match(/\big\b/))  return 'instagram';
    if (n.includes('tiktok'))                          return 'tiktok';
    if (n.includes('youtube') || n.match(/\byt\b/))    return 'youtube';
    if (n.includes('facebook') || n.match(/\bfb\b/))   return 'facebook';
    if (n.includes('twitter') || n.includes(' x ') || n.includes('tweet')) return 'twitter';
    if (n.includes('whatsapp'))                        return 'whatsapp';
    if (n.includes('telegram'))                        return 'telegram';
    if (n.includes('discord'))                         return 'discord';
    if (n.includes('spotify'))                         return 'spotify';
    if (n.includes('snapchat'))                        return 'snapchat';
    if (n.includes('linkedin'))                        return 'linkedin';
    if (n.includes('threads'))                         return 'threads';
    return 'other';
}

function detectCategory(name, category) {
    const n = `${name || ''} ${category || ''}`.toLowerCase();
    if (n.includes('follower'))    return 'followers';
    if (n.includes('like'))        return 'likes';
    if (n.includes('view'))        return 'views';
    if (n.includes('comment'))     return 'comments';
    if (n.includes('share'))       return 'shares';
    if (n.includes('subscriber'))  return 'subscribers';
    if (n.includes('member'))      return 'members';
    if (n.includes('stream'))      return 'streams';
    if (n.includes('watch hour'))  return 'watch_hours';
    if (n.includes('impression') || n.includes('reach')) return 'impressions';
    if (n.includes('repost'))      return 'reposts';
    return category ? String(category).toLowerCase() : 'other';
}

// ─── Fetch from SMMWiz ───────────────────────────────────────────
async function fetchSmmWizServices() {
    const key = process.env.SMMWIZ_API_KEY;
    if (!key) {
        throw new Error('SMMWIZ_API_KEY is not set in .env');
    }

    console.log('📡 [SMMWIZ] Fetching catalog…');
    const res = await axios.post(SMMWIZ_API_URL, null, {
        params: { key, action: 'services' },
        timeout: 30000,
    });

    if (res.data?.error) {
        throw new Error(`SMMWiz error: ${res.data.error}`);
    }

    const services = Array.isArray(res.data) ? res.data : [];
    console.log(`✅ [SMMWIZ] Received ${services.length} services`);
    return services;
}

// ─── Map SMMWiz shape → boost_services row ───────────────────────
function mapService(s) {
    const providerServiceId = String(s.service ?? s.id ?? '').trim();
    if (!providerServiceId) return null;

    const name = String(s.name || '').trim();
    if (!name) return null;

    const rate = Number(s.rate ?? 0);
    if (!Number.isFinite(rate) || rate <= 0) return null;

    const min = Number(s.min ?? 1) || 1;
    const max = Number(s.max ?? 1000000) || 1000000;

    return {
        provider_service_id: providerServiceId,
        name,
        description: s.description || null,
        platform: detectPlatform(name, s.category),
        category: detectCategory(name, s.category),
        provider_rate: rate,                       // USD per 1000
        min_quantity: min,
        max_quantity: max,
        refill_allowed: Boolean(s.refill),
        refill_days: s.refill ? 30 : null,
        dripfeed_allowed: Boolean(s.dripfeed),
        average_time: s.average_time || null,
        active: true,
        visible_to_users: true,
        markup_percent: null,                      // uses default
        custom_price: null,
        sort_order: 1000,
        updated_at: new Date().toISOString(),
    };
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
    console.log('🚀 Boost services sync');

    // ── 1. Fetch
    const raw = await fetchSmmWizServices();
    if (!raw.length) {
        console.warn('⚠️  SMMWiz returned zero services — nothing to sync.');
        process.exit(0);
    }

    // ── 2. Map + filter
    const rows = raw.map(mapService).filter(Boolean);
    console.log(`🧮 Mapped ${rows.length} usable services (${raw.length - rows.length} rejected)`);

    if (!rows.length) {
        console.error('❌ Every service was rejected. Check SMMWiz response shape.');
        process.exit(1);
    }

    // ── 3. Upsert in batches of 200
    const BATCH = 200;
    let written = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await supabaseAdmin
            .from('boost_services')
            .upsert(batch, { onConflict: 'provider_service_id' });

        if (error) {
            console.error(`❌ Batch ${i / BATCH + 1} failed:`, error.message);
            console.error('   Sample row:', batch[0]);
            process.exit(1);
        }
        written += batch.length;
        console.log(`   📥 Upserted ${written}/${rows.length}`);
    }

    // ── 4. Report
    const { count: activeCount } = await supabaseAdmin
        .from('boost_services')
        .select('*', { count: 'exact', head: true })
        .eq('active', true)
        .eq('visible_to_users', true);

    console.log(`\n✅ Sync complete`);
    console.log(`   Written:        ${written}`);
    console.log(`   Visible total:  ${activeCount}`);
    console.log(`\nOpen /api/boost/services in your browser to verify.`);
    process.exit(0);
}

main().catch((e) => {
    console.error('❌ Sync failed:', e.message);
    process.exit(1);
});