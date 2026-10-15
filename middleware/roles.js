// middleware/roles.js
// Single source of truth for role classification.
'use strict';

const STAFF_ROLES = new Set([
    'admin', 'super_admin',
    'finance', 'operations', 'support', 'auditor', 'read_only'
]);

function classifyRole(role) {
    const r = String(role || 'user').toLowerCase();
    return { role: r, isAdmin: STAFF_ROLES.has(r) };
}
function isStaff(role) { return STAFF_ROLES.has(String(role || '').toLowerCase()); }
function isFullAdmin(role) { return ['admin', 'super_admin'].includes(String(role || '').toLowerCase()); }

module.exports = { STAFF_ROLES, classifyRole, isStaff, isFullAdmin };