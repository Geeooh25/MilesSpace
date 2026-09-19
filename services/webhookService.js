// services/webhookService.js
const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');

class WebhookService {
    // ─── VERIFY BITNOB WEBHOOK SIGNATURE ───
    verifyBitnobSignature(payload, signature, secret) {
        try {
            const expected = crypto
                .createHmac('sha256', secret)
                .update(JSON.stringify(payload))
                .digest('hex');
            return crypto.timingSafeEqual(
                Buffer.from(signature),
                Buffer.from(expected)
            );
        } catch (error) {
            console.error('Signature verification error:', error);
            return false;
        }
    }

    // ─── VERIFY PAYSTACK WEBHOOK ───
    verifyPaystackSignature(signature, payload, secret) {
        try {
            const expected = crypto
                .createHmac('sha512', secret)
                .update(JSON.stringify(payload))
                .digest('hex');
            return crypto.timingSafeEqual(
                Buffer.from(signature),
                Buffer.from(expected)
            );
        } catch (error) {
            return false;
        }
    }

    // ─── STORE WEBHOOK EVENT (IDEMPOTENT) ───
    async storeWebhookEvent(provider, eventId, payload, signatureValid = false) {
        try {
            // Check if already processed
            const { data: existing } = await supabaseAdmin
                .from('webhook_events')
                .select('id, processed')
                .eq('provider', provider)
                .eq('provider_event_id', eventId)
                .single();

            if (existing) {
                return { 
                    isDuplicate: true, 
                    processed: existing.processed,
                    eventId: existing.id 
                };
            }

            // Store new event - use string for payload
            const { data, error } = await supabaseAdmin
                .from('webhook_events')
                .insert({
                    provider,
                    provider_event_id: eventId,
                    payload: payload,
                    signature_valid: signatureValid,
                    processed: false,
                    created_at: new Date().toISOString()
                })
                .select()
                .single();

            if (error) throw error;
            return { isDuplicate: false, event: data };
        } catch (error) {
            console.error('Store webhook error:', error);
            throw error;
        }
    }

    // ─── MARK WEBHOOK AS PROCESSED ───
    async markWebhookProcessed(eventId, success = true, error = null) {
        try {
            const { error: updateError } = await supabaseAdmin
                .from('webhook_events')
                .update({
                    processed: true,
                    processed_at: new Date().toISOString(),
                    processing_error: error
                })
                .eq('id', eventId);

            if (updateError) throw updateError;
            return true;
        } catch (error) {
            console.error('Mark webhook processed error:', error);
            return false;
        }
    }

    // ─── PROCESS BITNOB WEBHOOK ───
    async processBitnobWebhook(payload, signature, secret) {
        try {
            // 1. Verify signature
            const signatureValid = this.verifyBitnobSignature(payload, signature, secret);
            if (!signatureValid) {
                return { success: false, error: 'Invalid signature' };
            }

            // 2. Extract event details
            const { event, data } = payload;
            const providerEventId = data?.id || data?.transaction_id || data?.reference;

            if (!providerEventId) {
                return { success: false, error: 'Missing event ID' };
            }

            // 3. Store event (idempotent)
            const storeResult = await this.storeWebhookEvent(
                'bitnob',
                providerEventId,
                payload,
                signatureValid
            );

            if (storeResult.isDuplicate) {
                return { success: true, message: 'Duplicate webhook ignored', processed: storeResult.processed };
            }

            // 4. Process based on event type
            let result = { success: true };
            switch (event) {
                case 'payment.completed':
                case 'deposit.completed':
                    result = await this.handleBitnobPaymentCompleted(data, storeResult.event.id);
                    break;
                case 'payment.failed':
                case 'deposit.failed':
                    result = await this.handleBitnobPaymentFailed(data, storeResult.event.id);
                    break;
                case 'withdrawal.completed':
                    result = await this.handleBitnobWithdrawalCompleted(data, storeResult.event.id);
                    break;
                case 'withdrawal.failed':
                    result = await this.handleBitnobWithdrawalFailed(data, storeResult.event.id);
                    break;
                default:
                    result = { success: true, message: 'Unknown event type' };
            }

            // 5. Mark as processed
            await this.markWebhookProcessed(
                storeResult.event.id,
                result.success,
                result.error || null
            );

            return result;
        } catch (error) {
            console.error('Process Bitnob webhook error:', error);
            return { success: false, error: error.message };
        }
    }

    // ─── HANDLE BITNOB PAYMENT COMPLETED ───
    async handleBitnobPaymentCompleted(data, eventId) {
        try {
            const { reference, amount, currency, transaction_id } = data;

            // Find order by reference
            const { data: order, error: orderError } = await supabaseAdmin
                .from('crypto_purchases')
                .select('*')
                .eq('reference', reference)
                .single();

            if (orderError || !order) {
                return { success: false, error: 'Order not found' };
            }

            // Check if already completed
            if (order.status === 'completed') {
                return { success: true, message: 'Order already completed' };
            }

            // ─── UPDATE ORDER ───
            const { error: updateError } = await supabaseAdmin
                .from('crypto_purchases')
                .update({
                    status: 'completed',
                    tx_hash: transaction_id,
                    completed_at: new Date().toISOString()
                })
                .eq('id', order.id)
                .eq('status', 'pending');

            if (updateError) {
                return { success: false, error: 'Failed to update order' };
            }

            // ─── UPDATE WALLET (separate table) ───
            const { error: walletError } = await supabaseAdmin
                .from('wallet_balances')
                .update({
                    [`${currency.toLowerCase()}_balance`]: supabaseAdmin.rpc('increment_balance', {
                        p_user_id: order.user_id,
                        p_currency: currency.toLowerCase(),
                        p_amount: parseFloat(amount)
                    })
                })
                .eq('user_id', order.user_id);

            if (walletError) {
                console.error('Wallet update error:', walletError);
                // Don't fail the webhook - order is updated
            }

            return { success: true, message: 'Order completed', order_id: order.id };
        } catch (error) {
            console.error('Handle Bitnob payment completed error:', error);
            return { success: false, error: error.message };
        }
    }

    // ─── HANDLE BITNOB PAYMENT FAILED ───
    async handleBitnobPaymentFailed(data, eventId) {
        try {
            const { reference, reason } = data;

            await supabaseAdmin
                .from('crypto_purchases')
                .update({
                    status: 'failed',
                    failure_reason: reason || 'Payment failed',
                    completed_at: new Date().toISOString()
                })
                .eq('reference', reference)
                .eq('status', 'pending');

            return { success: true, message: 'Payment marked as failed' };
        } catch (error) {
            console.error('Handle Bitnob payment failed error:', error);
            return { success: false, error: error.message };
        }
    }

    // ─── HANDLE BITNOB WITHDRAWAL COMPLETED ───
    async handleBitnobWithdrawalCompleted(data, eventId) {
        try {
            const { reference, amount, currency, transaction_id } = data;

            await supabaseAdmin
                .from('withdrawals')
                .update({
                    status: 'completed',
                    tx_hash: transaction_id,
                    completed_at: new Date().toISOString()
                })
                .eq('reference', reference)
                .eq('status', 'pending');

            return { success: true, message: 'Withdrawal completed' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async handleBitnobWithdrawalFailed(data, eventId) {
        try {
            const { reference, reason } = data;

            await supabaseAdmin
                .from('withdrawals')
                .update({
                    status: 'failed',
                    failure_reason: reason || 'Withdrawal failed',
                    completed_at: new Date().toISOString()
                })
                .eq('reference', reference)
                .eq('status', 'pending');

            return { success: true, message: 'Withdrawal marked as failed' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = new WebhookService();