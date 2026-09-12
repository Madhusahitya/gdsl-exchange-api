import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '@cryptoflow/db'
import { env } from '../lib/env'
import { isDevAuthBypassActive } from '../lib/devAuth'
import { GLOBAL_PAPER_EMAIL } from '../services/bot/globalPaperTrader'

export interface AuthPayload {
  userId: string
  email: string
}

/* eslint-disable @typescript-eslint/no-namespace -- augment express Request */
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  // Prefer the LAST match — browsers often send Domain= + host-only duplicates;
  // the newest cookie is usually last (same rule as auth refresh / CSRF).
  const matches = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.startsWith(`${name}=`))
  const match = matches[matches.length - 1]
  return match?.split('=').slice(1).join('=')
}

export function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization']
  const token = authHeader?.split(' ')[1] ?? parseCookie(req.headers.cookie, 'cf_token')

  if (token) {
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload
      req.user = payload
      next()
    } catch {
      // Always 401 on bad/expired access JWT so the client refresh interceptor runs.
      res.status(401).json({ error: 'Invalid or expired token' })
    }
    return
  }

  // No access cookie — if a refresh cookie exists, return 401 (not 403) so the
  // browser can silently rotate tokens instead of showing "session expired".
  const hasRefresh = Boolean(parseCookie(req.headers.cookie, 'cf_refresh_token'))
  if (hasRefresh) {
    res.status(401).json({ error: 'Access token expired', code: 'ACCESS_EXPIRED' })
    return
  }

  if (isDevAuthBypassActive()) {
    void prisma.user
      .findFirst({
        where: {
          OR: [
            { email: GLOBAL_PAPER_EMAIL },
            { email: 'system.paperbot@cryptoflow.internal' },
          ],
        },
      })
      .then(async (user) => {
        if (!user) {
          res.status(503).json({
            error:
              'Dev auth bypass: system user not ready yet. Wait a few seconds after API start, or ensure the DB is migrated.',
          })
          return
        }
        if (user.email !== GLOBAL_PAPER_EMAIL) {
          await prisma.user.update({
            where: { id: user.id },
            data: { email: GLOBAL_PAPER_EMAIL },
          })
          user.email = GLOBAL_PAPER_EMAIL
        }
        req.user = { userId: user.id, email: user.email }
        next()
      })
      .catch((err: unknown) => next(err))
    return
  }

  res.status(401).json({ error: 'No token provided', code: 'NO_TOKEN' })
}
