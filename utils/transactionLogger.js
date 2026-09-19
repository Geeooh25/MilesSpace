// utils/transactionLogger.js
// Centralized transaction creation for all financial operations

const { supabaseAdmin } = require('../db/supabase');

async function createTransaction({
  userId,
  type,
  status = 'completed',
  currency,
  amount,
  fee = 0,
  reference,
  description,
  sourceType = null,
  sourceId = null,
  wallet = null,
  balanceBefore = null,
  balanceAfter = null,
  metadata = {}
}) {
  try {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        type,
        status,
        currency,
        amount,
        fee,
        reference,
        description,
        source_type: sourceType,
        source_id: sourceId,
        wallet,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        metadata,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Transaction creation failed:', error);
      throw error;
    }

    return data;
  } catch (error) {
    console.error('❌ Create transaction error:', error);
    throw error;
  }
}

async function invalidateUserCache(userId) {
  // This can be expanded to clear Redis or other caches
  // For now, we just log it
  console.log(`🔄 Invalidating cache for user ${userId}`);
}

module.exports = {
  createTransaction,
  invalidateUserCache
};