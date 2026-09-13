/**
 * Live execution is handled by liveTradingBot (Binance).
 * This module documents the optional placeholder path when disabling real orders.
 */
export const LIVE_EXECUTION_DISABLED =
  process.env.LIVE_EXECUTION_DISABLED === '1' || process.env.LIVE_EXECUTION_DISABLED === 'true'
