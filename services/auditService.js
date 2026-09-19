// services/auditService.js
const { supabaseAdmin } = require('../db/supabase');

class AuditService {
    async log(event, data = {}) {
        try {
            const logEntry = {
                event: event,
                user_id: data.userId || null,
                actor_type: data.actorType || 'user',
                actor_id: data.actorId || data.userId || null,
                transaction_id: data.transactionId || null,
                session_id: data.sessionId || null,
                details: data.details || {},
                ip: data.ip || null,
                user_agent: data.userAgent || null,
                location: data.location || null,
                success: data.success !== undefined ? data.success : true,
                created_at: new Date().toISOString()
            };

            const { error } = await supabaseAdmin
                .from('security_audit_logs')
                .insert(logEntry);

            if (error) {
                console.error('Audit log error:', error);
            }
        } catch (error) {
            console.error('Audit service error:', error);
        }
    }

    async logLogin(userId, req, success = true) {
        await this.log('USER_LOGIN', {
            userId,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            success,
            details: { email: req.user?.email || 'unknown' }
        });
    }

    async logLoginFailed(email, req) {
        await this.log('LOGIN_FAILED', {
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            success: false,
            details: { email }
        });
    }

    async logLogout(userId, req) {
        await this.log('USER_LOGOUT', {
            userId,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            details: { session_id: req.sessionId }
        });
    }

    async logSecurityEvent(event, userId, req, details = {}) {
        await this.log(event, {
            userId,
            ip: req?.ip,
            userAgent: req?.headers?.['user-agent'],
            details
        });
    }

    async logPinVerified(userId, req, action, success = true) {
        await this.log('PIN_VERIFIED', {
            userId,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            success,
            details: { action }
        });
    }

    async logPinChanged(userId, req) {
        await this.log('PIN_CHANGED', {
            userId,
            ip: req.ip,
            userAgent: req.headers['user-agent']
        });
    }
}

module.exports = new AuditService();