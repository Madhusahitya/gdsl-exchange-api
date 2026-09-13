import { env } from './env'

function devBypassDefaultOn(v: string | undefined): boolean {
  if (v === undefined) return true
  const x = v.trim().toLowerCase()
  if (x === '0' || x === 'false' || x === 'no' || x === 'off') return false
  if (x === '1' || x === 'true' || x === 'yes' || x === 'on') return true
  return true
}

/**
 * Development only: unauthenticated HTTP + Socket resolve to the global paper user
 * (`GLOBAL_PAPER_EMAIL`) unless `DEV_AUTH_BYPASS=0`. Never active when `NODE_ENV=production`.
 */
export function isDevAuthBypassActive(): boolean {
  if (env.NODE_ENV === 'production') return false
  return devBypassDefaultOn(process.env.DEV_AUTH_BYPASS)
}
