require('dotenv').config();   // ensure env is loaded before anything else

// One-time diagnostic
const DIAGNOSE = {
    SMMWIZ_API_KEY: process.env.SMMWIZ_API_KEY,
    VTPASS_API_KEY: process.env.VTPASS_API_KEY,
    VTPASS_PUBLIC_KEY: process.env.VTPASS_PUBLIC_KEY,
    VTPASS_SECRET_KEY: process.env.VTPASS_SECRET_KEY,
    VTPASS_ENV: process.env.VTPASS_ENV
};
for (const [k, v] of Object.entries(DIAGNOSE)) {
    const present = v && String(v).trim().length > 0;
    console.log(`[ENV] ${k}: ${present ? 'set (' + String(v).length + ' chars)' : 'MISSING'}`);
}