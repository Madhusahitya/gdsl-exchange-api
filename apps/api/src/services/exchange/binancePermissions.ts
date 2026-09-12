/**
 * Derive API-key trading / withdraw flags from GET /api/v3/account.
 *
 * Important: Binance returns BOTH:
 *   - account-level `canTrade` / `canWithdraw` / `canDeposit` (user account status)
 *   - API-key `permissions` array (e.g. ["SPOT"])
 *
 * We must NOT block keys using account-level `canWithdraw` — almost every real
 * Binance account can withdraw funds via the website, even when the API key
 * has withdrawals disabled. That was falsely rejecting trade-only keys.
 */

export function inferBinanceCanTrade(account: unknown): boolean {
  if (!account || typeof account !== 'object') return false
  const raw = (account as { permissions?: unknown }).permissions
  if (!Array.isArray(raw)) {
    // Older responses or proxies that omit `permissions` — do not block trading.
    return true
  }
  if (raw.length === 0) return false

  const upper = raw.map((p) => String(p).toUpperCase())

  const impliesTrading = (p: string) =>
    p === 'SPOT' ||
    p === 'MARGIN' ||
    p === 'LEVERAGED' ||
    p.startsWith('TRD_GRP_') ||
    p === 'OPTIONS' ||
    p === 'FUTURES' ||
    p === 'DELIVERY'

  if (upper.some(impliesTrading)) return true
  if (upper.some((p) => p === 'READ_ONLY')) return false
  return false
}

/** True only when the API key itself grants withdraw (not the account flag). */
export function inferBinanceApiKeyCanWithdraw(account: unknown): boolean {
  if (!account || typeof account !== 'object') return false
  const raw = (account as { permissions?: unknown }).permissions
  if (!Array.isArray(raw)) {
    // No permissions array → cannot prove key-level withdraw; do not block.
    return false
  }
  return raw.some((p) => {
    const u = String(p).toUpperCase()
    return u === 'WITHDRAW' || u === 'WITHDRAWALS' || u.includes('WITHDRAW')
  })
}

export type BinancePermissionState = {
  canTrade: boolean
  canRead: boolean
  /** API-key withdraw capability (NOT account.canWithdraw). */
  canWithdraw: boolean
  permissions: string[] | null
  /** Account-level flag from Binance — informational only. */
  accountCanWithdraw: boolean | null
}

/**
 * Normalize permission fields from Binance `/api/v3/account` payload.
 */
export function getBinancePermissionState(account: unknown): BinancePermissionState {
  const raw = account && typeof account === 'object'
    ? (account as { permissions?: unknown }).permissions
    : undefined

  const permissions = Array.isArray(raw) ? raw.map((p) => String(p).toUpperCase()) : null
  const canTrade = inferBinanceCanTrade(account)
  const canWithdraw = inferBinanceApiKeyCanWithdraw(account)

  const accountCanWithdrawRaw =
    account && typeof account === 'object'
      ? (account as { canWithdraw?: unknown }).canWithdraw
      : undefined
  const accountCanWithdraw =
    typeof accountCanWithdrawRaw === 'boolean' ? accountCanWithdrawRaw : null

  return {
    canTrade,
    canRead: true,
    canWithdraw,
    permissions,
    accountCanWithdraw,
  }
}

/** Strip copy/paste junk from Binance key/secret fields. */
export function sanitizeBinanceCredential(value: string): string {
  return value.trim().replace(/^["']+|["']+$/g, '').replace(/:+$/g, '').trim()
}
