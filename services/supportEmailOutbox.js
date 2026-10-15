'use strict';

// ═══════════════════════════════════════════════════════════════
//  Email outbox worker
//
//  Picks up to BATCH_SIZE rows from public.email_outbox where
//  status='pending' and attempts < MAX_ATTEMPTS, and sends each
//  via emailService.sendEmail(). Updates status to 'sent' or leaves
//  it 'pending' for retry with exponential backoff. After MAX
//  attempts, marks 'failed'.
//
//  Runs in-process. No Redis, no worker container.
// ═══════════════════════════════════════════════════════════════

const { supabaseAdmin } = require('../db/supabase');
const emailSvc = require('./emailService');

const TICK_MS = 5000;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [0, 30_000, 120_000, 600_000, 1_800_000];

const FAILURE_THRESHOLD = 5;
const FAILURE_COOLDOWN_MS = 60_000;
const _failure = { consecutive: 0, openedAt: 0 };

let _timer = null;
let _running = false;

function _circuitOpen() {
    return _failure.consecutive >= FAILURE_THRESHOLD
        && (Date.now() - _failure.openedAt) < FAILURE_COOLDOWN_MS;
}
function _recordFetchSuccess() {
    _failure.consecutive = 0;
    _failure.openedAt = 0;
}
function _recordFetchFailure() {
    _failure.consecutive++;
    if (_failure.consecutive === FAILURE_THRESHOLD) {
        _failure.openedAt = Date.now();
        console.warn('[EMAIL OUTBOX] backing off for', FAILURE_COOLDOWN_MS / 1000, 's');
    }
}

async function tick() {
    if (_running) return { sent: 0, skipped: 0 };
    if (_circuitOpen()) return { sent: 0, skipped: 0, circuit: true };
    _running = true;
    let sent = 0, skipped = 0;
    try {
        const { data: rows, error } = await supabaseAdmin
            .from('email_outbox')
            .select('id, to_email, subject, html, purpose, attempts, last_attempt_at')
            .eq('status', 'pending')
            .lt('attempts', MAX_ATTEMPTS)
            .order('created_at', { ascending: true })
            .limit(BATCH_SIZE);

        if (error) {
            if (/relation .* does not exist|42P01/.test(String(error.message))) return { sent: 0, skipped: 0 };
            _recordFetchFailure();
            return { sent: 0, skipped: 0 };
        }
        _recordFetchSuccess();
        if (!rows || !rows.length) return { sent: 0, skipped: 0 };

        for (const row of rows) {
            const attempts = row.attempts || 0;
            const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] || 0;
            if (row.last_attempt_at) {
                const since = Date.now() - new Date(row.last_attempt_at).getTime();
                if (since < wait) { skipped++; continue; }
            }

            // Claim the row atomically.
            const { data: claim } = await supabaseAdmin
                .from('email_outbox')
                .update({
                    status: 'sending',
                    last_attempt_at: new Date().toISOString(),
                    attempts: attempts + 1
                })
                .eq('id', row.id)
                .eq('status', 'pending')
                .select('id');
            if (!claim || !claim.length) { skipped++; continue; }

            let result;
            try {
                result = await emailSvc.sendEmail(row.to_email, row.subject, row.html);
            } catch (e) {
                result = { success: false, error: e && e.message };
            }

            const nextAttempt = attempts + 1;
            const terminal = nextAttempt >= MAX_ATTEMPTS;

            if (result && result.success) {
                await supabaseAdmin.from('email_outbox')
                    .update({ status: 'sent', sent_at: new Date().toISOString(), error: null })
                    .eq('id', row.id);
                sent++;
                console.log('[EMAIL OUTBOX] sent →', row.to_email, '(' + (row.purpose || 'generic') + ')');
            } else if (result && result.disabled) {
                // Email service is off. Leave it pending so it sends
                // when credentials arrive.
                await supabaseAdmin.from('email_outbox')
                    .update({ status: 'pending', error: 'email_service_disabled' })
                    .eq('id', row.id);
            } else {
                const errText = String((result && (result.error || result.message)) || 'send failed').slice(0, 500);
                await supabaseAdmin.from('email_outbox')
                    .update({ status: terminal ? 'failed' : 'pending', error: errText })
                    .eq('id', row.id);
                console.warn('[EMAIL OUTBOX] attempt failed →', row.to_email, ':', errText);
            }
        }
    } catch (e) {
        _recordFetchFailure();
    } finally {
        _running = false;
    }
    return { sent, skipped };
}

function start() {
    if (_timer) return;
    _timer = setInterval(function () { tick().catch(function () {}); }, TICK_MS);
    console.log('[EMAIL OUTBOX] scheduler started');
}
function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

async function stats() {
    try {
        const { count: pending } = await supabaseAdmin
            .from('email_outbox')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending');
        const { count: failed } = await supabaseAdmin
            .from('email_outbox')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'failed');
        const { count: sentToday } = await supabaseAdmin
            .from('email_outbox')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'sent')
            .gte('sent_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
        return { pending: pending || 0, failed: failed || 0, sentToday: sentToday || 0 };
    } catch {
        return { pending: 0, failed: 0, sentToday: 0 };
    }
}

module.exports = { start, stop, tick, stats };