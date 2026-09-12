/** Re-exports for API modules that reference the shared bot signal engine */
export {
  computeAISignal,
  fetchBinanceKlines,
  scoreSignalFromKlines,
} from '@cryptoflow/bot'
export type { AISignalResult, SignalAction } from '@cryptoflow/bot'
