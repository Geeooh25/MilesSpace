// services/presenceManager.js - Real-time presence tracking using Socket.IO

const EventEmitter = require('events');

class PresenceManager extends EventEmitter {
    constructor() {
        super();
        // Store online users with their socket IDs
        // Map: userId -> { userId, role, sockets: Set, currentPage, currentAction, connectedAt, lastActivityAt }
        this.onlineUsers = new Map();
        this.ADMIN_ROLES = ['admin', 'super_admin'];
    }

    /**
     * Add a new socket connection for a user
     */
    addConnection({ userId, role, socketId, username, email, avatarUrl }) {
        if (!userId || !socketId) {
            throw new Error('userId and socketId are required');
        }

        const now = Date.now();
        let user = this.onlineUsers.get(userId);

        if (!user) {
            user = {
                userId,
                role: role || 'user',
                username: username || 'Unknown',
                email: email || '',
                avatarUrl: avatarUrl || null,
                sockets: new Set(),
                connectedAt: now,
                lastActivityAt: now,
                currentPage: null,
                currentAction: null,
                socketCount: 0
            };
            this.onlineUsers.set(userId, user);
        }

        // Add socket to user's set
        user.sockets.add(socketId);
        user.socketCount = user.sockets.size;
        user.lastActivityAt = now;
        user.role = role || user.role;

        this.emit('user:online', { userId, role, username, socketId });
        this.emit('presence:update', this.getOnlineUsers());

        return user;
    }

    /**
     * Remove a socket connection for a user
     */
    removeConnection(userId, socketId) {
        if (!userId || !socketId) return null;

        const user = this.onlineUsers.get(userId);
        if (!user) return null;

        user.sockets.delete(socketId);
        user.socketCount = user.sockets.size;

        // If user has no more sockets, remove them entirely
        if (user.sockets.size === 0) {
            this.onlineUsers.delete(userId);
            this.emit('user:offline', { userId });
            this.emit('presence:update', this.getOnlineUsers());
            return null;
        }

        this.emit('presence:update', this.getOnlineUsers());
        return user;
    }

    /**
     * Update a user's current page/action
     */
    updatePage(userId, page, action = null) {
        const user = this.onlineUsers.get(userId);
        if (!user) return null;

        user.currentPage = page || user.currentPage;
        user.currentAction = action || user.currentAction;
        user.lastActivityAt = Date.now();

        // Don't emit on every page change - the dashboard polls or uses presence:update
        return user;
    }

    /**
     * Get all online users with their details
     */
    getOnlineUsers() {
        const users = [];
        const admins = [];
        const now = Date.now();

        for (const [userId, user] of this.onlineUsers) {
            const data = {
                userId: user.userId,
                username: user.username,
                email: user.email,
                avatarUrl: user.avatarUrl,
                role: user.role,
                isAdmin: this.ADMIN_ROLES.includes(user.role),
                currentPage: user.currentPage || '/dashboard',
                currentAction: user.currentAction || 'viewing',
                connectedAt: user.connectedAt,
                lastActivityAt: user.lastActivityAt,
                socketCount: user.socketCount,
                isOnline: true
            };

            if (this.ADMIN_ROLES.includes(user.role)) {
                admins.push(data);
            } else {
                users.push(data);
            }
        }

        return {
            users,
            admins,
            totalUsers: users.length,
            totalAdmins: admins.length,
            total: users.length + admins.length,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Get a specific user's presence data
     */
    getUser(userId) {
        return this.onlineUsers.get(userId) || null;
    }

    /**
     * Check if a user is online
     */
    isUserOnline(userId) {
        return this.onlineUsers.has(userId);
    }

    /**
     * Get online count
     */
    getOnlineCount() {
        return this.onlineUsers.size;
    }

    /**
     * Get all admin users online
     */
    getOnlineAdmins() {
        const admins = [];
        for (const [userId, user] of this.onlineUsers) {
            if (this.ADMIN_ROLES.includes(user.role)) {
                admins.push({
                    userId: user.userId,
                    username: user.username,
                    email: user.email,
                    currentPage: user.currentPage,
                    currentAction: user.currentAction
                });
            }
        }
        return admins;
    }

    /**
     * Clean up stale connections (called periodically)
     */
    cleanup(maxAge = 24 * 60 * 60 * 1000) {
        const now = Date.now();
        let cleaned = 0;

        for (const [userId, user] of this.onlineUsers) {
            // If user hasn't been active for more than maxAge, remove them
            if (now - user.lastActivityAt > maxAge) {
                this.onlineUsers.delete(userId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.emit('presence:update', this.getOnlineUsers());
        }

        return cleaned;
    }

    /**
     * Get user count by role
     */
    getUserCounts() {
        let adminCount = 0;
        let userCount = 0;

        for (const [userId, user] of this.onlineUsers) {
            if (this.ADMIN_ROLES.includes(user.role)) {
                adminCount++;
            } else {
                userCount++;
            }
        }

        return { adminCount, userCount, total: this.onlineUsers.size };
    }
}

// Singleton instance
const presenceManager = new PresenceManager();

// Cleanup every hour
setInterval(() => {
    presenceManager.cleanup();
}, 60 * 60 * 1000);

module.exports = presenceManager;