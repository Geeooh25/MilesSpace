// scripts/lib/pgPath.js
// Resolves pg_dump and pg_restore on Windows without requiring PATH setup.
// Prefers an explicit override in env, then walks known install locations.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KNOWN_DIRS = [
    'C:\\Program Files\\PostgreSQL\\17\\bin',
    'C:\\Program Files\\PostgreSQL\\16\\bin',
    'C:\\Program Files\\PostgreSQL\\15\\bin',
    'C:\\Program Files\\PostgreSQL\\14\\bin',
    'C:\\Program Files\\PostgreSQL\\13\\bin'
];

function resolveBinary(name, envOverride) {
    // 1. explicit override
    if (envOverride) {
        if (!fs.existsSync(envOverride)) {
            throw new Error(`${name}: env override "${envOverride}" does not exist`);
        }
        return envOverride;
    }
    // 2. known install dirs — prefer v17, then older
    for (const dir of KNOWN_DIRS) {
        const p = path.join(dir, `${name}.exe`);
        if (fs.existsSync(p)) return p;
    }
    // 3. bare name — will only work if PATH is set
    throw new Error(
        `${name}.exe not found. Install PostgreSQL client tools, or set ` +
        `${name.toUpperCase()}_PATH in .env to the full path. ` +
        `Looked in: ${KNOWN_DIRS.join(', ')}`
    );
}

function pgDumpPath() {
    return resolveBinary('pg_dump', process.env.PG_DUMP_PATH);
}

function pgRestorePath() {
    return resolveBinary('pg_restore', process.env.PG_RESTORE_PATH);
}

module.exports = { pgDumpPath, pgRestorePath };