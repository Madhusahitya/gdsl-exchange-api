export type TradeLogEvent = 'trade.attempt' | 'trade.validated' | 'trade.rejected' | 'trade.executed'

export function logTrade(
  event: TradeLogEvent,
  payload: Record<string, string | number | boolean | null | undefined>
): void {
  const line = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  })
  console.log(line)
}
