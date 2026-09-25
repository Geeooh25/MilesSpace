// middleware/adminPermissions.js
'use strict';
const { PERMISSIONS, ADMIN_ROLES, roleHasPermission } = require('./adminAuth');

function can(ctx, permission) {
    if (!ctx) return false;
    if (ctx.isSuperAdmin) return true;
    if (!Array.isArray(ctx.permissions)) return false;
    if (ctx.permissions.includes('*')) return true;
    return ctx.permissions.includes(permission);
}
function canAny(ctx, perms) { return Array.isArray(perms) && perms.some(p => can(ctx, p)); }
function canAll(ctx, perms) { return Array.isArray(perms) && perms.every(p => can(ctx, p)); }
function buildPermissionMap(ctx) {
    const map = {};
    for (const [key, perm] of Object.entries(PERMISSIONS)) map[key] = can(ctx, perm);
    return map;
}
module.exports = { can, canAny, canAll, buildPermissionMap, roleHasPermission };