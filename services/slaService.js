// services/slaService.js - SLA tracking and monitoring
const { supabaseAdmin } = require('../db/supabase');

class SLAService {
    constructor() {
        // Default SLA levels (can be stored in database)
        this.slaLevels = {
            urgent: { response_minutes: 15, resolution_hours: 4 },
            high: { response_minutes: 30, resolution_hours: 8 },
            medium: { response_minutes: 120, resolution_hours: 24 },
            low: { response_minutes: 1440, resolution_hours: 72 }, // 24 hours, 72 hours
        };
    }

    async checkSLA(ticket) {
        const sla = this.slaLevels[ticket.priority];
        if (!sla) return { status: 'ok' };

        const created = new Date(ticket.created_at);
        const now = new Date();

        // Check response SLA
        const responseMinutes = (now - created) / (1000 * 60);
        const isResponseBreached = responseMinutes > sla.response_minutes;
        const isResolutionBreached = false;

        // Check resolution SLA if ticket is resolved
        let resolutionTime = null;
        if (ticket.resolved_at) {
            const resolved = new Date(ticket.resolved_at);
            resolutionTime = (resolved - created) / (1000 * 60 * 60);
            const isResolved = resolutionTime > sla.resolution_hours;
        }

        return {
            priority: ticket.priority,
            response_sla_minutes: sla.response_minutes,
            resolution_sla_hours: sla.resolution_hours,
            response_time_minutes: Math.round(responseMinutes),
            response_breached: isResponseBreached,
            resolution_time_hours: resolutionTime ? Math.round(resolutionTime * 10) / 10 : null,
            resolution_breached: resolutionTime ? resolutionTime > sla.resolution_hours : false,
            status: isResponseBreached ? 'breached' : 'ok',
            remaining_minutes: Math.max(0, sla.response_minutes - responseMinutes),
        };
    }

    async updateAllSLAStatuses() {
        try {
            const { data: tickets, error } = await supabaseAdmin
                .from('support_tickets')
                .select('*')
                .in('status', ['open', 'assigned', 'in_progress', 'waiting_user', 'waiting_support']);

            if (error) throw error;

            let breached = 0;
            for (const ticket of tickets) {
                const sla = await this.checkSLA(ticket);
                if (sla.response_breached) {
                    breached++;
                    await supabaseAdmin
                        .from('support_tickets')
                        .update({ sla_breached: true })
                        .eq('id', ticket.id);
                }
            }

            return { total: tickets.length, breached };
        } catch (error) {
            console.error('SLA update error:', error);
            return { total: 0, breached: 0 };
        }
    }

    getSLAStatus(priority) {
        return this.slaLevels[priority] || this.slaLevels.medium;
    }
}

module.exports = SLAService;