import { env } from '../lib/env'

/**
 * Production: FRONTEND_URL when set.
 * Development: localhost + optional ngrok / tunneling hostnames for investor demos.
 */
const allowTunnelHosts = env.NODE_ENV === 'development' || process.env.ALLOW_TUNNEL_CORS === '1'

export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const u = new URL(origin)
    const h = u.hostname
    if (h === 'localhost' || h === '127.0.0.1') return true
    if (allowTunnelHosts) {
      if (
        h.endsWith('.ngrok-free.app') ||
        h.endsWith('.ngrok-free.dev') ||
        h.endsWith('.ngrok.io') ||
        h.endsWith('.ngrok.app')
      ) {
        return true
      }
      if (h.endsWith('.loca.lt') || h.endsWith('.trycloudflare.com')) return true
    }
    if (env.FRONTEND_URL && origin === env.FRONTEND_URL) return true
    if (env.allowedCorsOrigins.includes(origin)) return true
    return false
  } catch {
    return false
  }
}

export const corsOriginHandler = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
  callback(null, isAllowedCorsOrigin(origin))
}
