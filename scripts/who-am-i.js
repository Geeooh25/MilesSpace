// scripts/who-am-i.js  — delete after use
'use strict';
require('dotenv').config({ path: require('path').resolve(process.cwd(), '.env') });

const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../db/supabase');

(async () => {
    const svc = jwt.decode(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
    console.log('Node process env — service key role:', svc && svc.role);

    const { data, error } = await supabaseAdmin.rpc('who_am_i');
    if (error) {
        console.error('who_am_i error:', error.message);
        process.exit(1);
    }
    console.log('Postgres thinks the caller is:', data);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});