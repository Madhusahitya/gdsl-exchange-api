import type express from 'express'
import { isAllowedCorsOrigin } from './cors'

export function readCookie(req: express.Request, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  // Prefer the last matching value — when Domain= and host-only cookies collide,
  // the newest (usually host-only) value is typically listed last.
  let value: string | null = null
  for (const part of raw.split(';')) {
    const v = part.trim()
    if (!v.startsWith(`${name}=`)) continue
    value = v.slice(name.length + 1)
  }
  return value
}

/** CSRF guard for cookie-authenticated mutating API calls. */
export function csrfProtection(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next()
    return
  }
  if (!req.path.startsWith('/api/')) {
    next()
    return
  }
  // logout must be CSRF-exempt so a broken session can still clear cookies
  const csrfExempt = new Set([
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/refresh',
    '/api/auth/logout',
  ])
  if (csrfExempt.has(req.path)) {
    next()
    return
  }
  const hasSessionCookie = Boolean(readCookie(req, 'cf_token') || readCookie(req, 'cf_refresh_token'))
  if (!hasSessionCookie) {
    next()
    return
  }
  const origin = req.headers.origin
  if (origin && !isAllowedCorsOrigin(origin)) {
    res.status(403).json({ error: 'CSRF origin denied' })
    return
  }
  const csrfCookie = readCookie(req, 'cf_csrf')
  const csrfHeader = req.headers['x-csrf-token']
  if (!csrfCookie || typeof csrfHeader !== 'string' || csrfHeader.length < 16 || csrfHeader !== csrfCookie) {
    res.status(403).json({ error: 'CSRF token mismatch' })
    return
  }
  next()
}
