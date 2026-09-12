import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from '@cryptoflow/db'
import { authenticateToken, AuthPayload } from '../middleware/authenticateToken'
import { validate } from '../middleware/validate'
import { asyncHandler } from '../middleware/asyncHandler'
import { loginSchema, registerSchema, resendOtpSchema, verifyEmailSchema } from '../validators'
import { env } from '../lib/env'
import { GLOBAL_PAPER_EMAIL } from '../services/bot/globalPaperTrader'
import { sendVerificationEmail } from '../services/email/emailService'
import {
  generateOtpCode,
  hashOtpCode,
  otpExpiresAt,
  verifyOtpCode,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
} from '../services/auth/otpService'

const router = Router()
/** Access JWT lifetime — long enough that background tabs rarely see 401 mid-scroll. */
const ACCESS_TTL_SECONDS = 60 * 60 * 2
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 7
const MAX_FAILED_LOGIN_ATTEMPTS = 5
const LOCKOUT_MINUTES = 15

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeEqualHexHash(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex')
    const b = Buffer.from(bHex, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Domains we may have used historically — clear all so stale Domain= cookies cannot win. */
function cookieDomainVariants(): Array<string | undefined> {
  const variants: Array<string | undefined> = [undefined]
  if (env.COOKIE_DOMAIN) variants.push(env.COOKIE_DOMAIN)
  // Legacy host / parent domains from earlier deploys.
  for (const d of ['trade.godslandx.com', '.godslandx.com', '.trade.godslandx.com']) {
    if (!variants.includes(d)) variants.push(d)
  }
  return variants
}

function appendClearedAuthCookies(res: Response) {
  const secure = env.NODE_ENV === 'production'
  for (const domain of cookieDomainVariants()) {
    const domainFlag = domain ? `Domain=${domain}; ` : ''
    const baseFlags = `Path=/; HttpOnly; SameSite=Lax; ${secure ? 'Secure; ' : ''}${domainFlag}`
    const csrfFlags = `Path=/; SameSite=Lax; ${secure ? 'Secure; ' : ''}${domainFlag}`
    res.append('Set-Cookie', `cf_token=; Max-Age=0; ${baseFlags}`)
    res.append('Set-Cookie', `cf_refresh_token=; Max-Age=0; ${baseFlags}`)
    res.append('Set-Cookie', `cf_csrf=; Max-Age=0; ${csrfFlags}`)
  }
}

function clearAuthCookies(res: Response) {
  appendClearedAuthCookies(res)
}

function setAuthCookies(res: Response, token: string, refreshToken: string) {
  const secure = env.NODE_ENV === 'production'
  // Wipe every historical Domain= variant first so the browser keeps only the new cookies.
  appendClearedAuthCookies(res)
  const domainFlag = env.COOKIE_DOMAIN ? `Domain=${env.COOKIE_DOMAIN}; ` : ''
  const baseFlags = `Path=/; HttpOnly; SameSite=Lax; ${secure ? 'Secure; ' : ''}${domainFlag}`
  const csrfFlags = `Path=/; SameSite=Lax; ${secure ? 'Secure; ' : ''}${domainFlag}`
  const csrf = randomBytes(24).toString('hex')
  res.append('Set-Cookie', `cf_token=${token}; Max-Age=${ACCESS_TTL_SECONDS}; ${baseFlags}`)
  res.append('Set-Cookie', `cf_refresh_token=${refreshToken}; Max-Age=${REFRESH_TTL_SECONDS}; ${baseFlags}`)
  res.append('Set-Cookie', `cf_csrf=${csrf}; Max-Age=${REFRESH_TTL_SECONDS}; ${csrfFlags}`)
}

function signAccess(userId: string, email: string) {
  return jwt.sign({ userId, email }, env.JWT_SECRET, { expiresIn: ACCESS_TTL_SECONDS })
}

function signRefresh(userId: string, email: string) {
  return jwt.sign({ userId, email }, env.JWT_REFRESH_SECRET, { expiresIn: `${REFRESH_TTL_SECONDS}s` })
}

/** Secrets that may have signed refresh JWTs across deploys (explicit + legacy fallback). */
function refreshSecrets(): string[] {
  const secrets = [env.JWT_REFRESH_SECRET, `${env.JWT_SECRET}_refresh`]
  return [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 32))]
}

function verifyRefreshJwt(token: string): AuthPayload | null {
  for (const secret of refreshSecrets()) {
    try {
      return jwt.verify(token, secret) as AuthPayload
    } catch {
      // try next secret
    }
  }
  return null
}

/** All cf_refresh_token values (browsers can send Domain= + host-only duplicates). */
function readAllRefreshTokens(req: Request): string[] {
  const tokens: string[] = []
  const raw = req.headers.cookie
  if (raw) {
    for (const part of raw.split(';')) {
      const v = part.trim()
      if (!v.startsWith('cf_refresh_token=')) continue
      const token = v.slice('cf_refresh_token='.length)
      if (token && !tokens.includes(token)) tokens.push(token)
    }
  }
  const fromBody = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null
  if (fromBody && !tokens.includes(fromBody)) tokens.push(fromBody)
  // Prefer last cookie (usually the newest host-only value after Domain= clears).
  return tokens.reverse()
}

function readRefreshToken(req: Request): string | null {
  return readAllRefreshTokens(req)[0] ?? null
}

async function createRefreshSession(
  userId: string,
  refreshToken: string,
  req: Request,
): Promise<void> {
  await prisma.authSession.create({
    data: {
      userId,
      refreshTokenHash: tokenHash(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
      userAgent: req.headers['user-agent']?.slice(0, 512) ?? null,
      ipAddress: req.ip ?? null,
    },
  })
}

async function revokeRefreshSessionByToken(refreshToken: string): Promise<void> {
  const hash = tokenHash(refreshToken)
  await prisma.authSession.updateMany({
    where: {
      refreshTokenHash: hash,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  })
}

/**
 * Multi-tab refresh race: tab A rotates R1→R2 and revokes R1; tab B still
 * presents R1 a moment later. Without a grace window that becomes a hard
 * logout. Keep R1 redeemable for a short period after rotation.
 */
const REFRESH_GRACE_MS = 45_000
const refreshGraceByHash = new Map<string, { userId: string; email: string; until: number }>()

function rememberRefreshGrace(oldRefreshToken: string, userId: string, email: string): void {
  refreshGraceByHash.set(tokenHash(oldRefreshToken), {
    userId,
    email,
    until: Date.now() + REFRESH_GRACE_MS,
  })
  // Opportunistic cleanup
  if (refreshGraceByHash.size > 500) {
    const now = Date.now()
    for (const [k, v] of refreshGraceByHash) {
      if (v.until < now) refreshGraceByHash.delete(k)
    }
  }
}

function consumeRefreshGrace(
  refreshToken: string,
): { userId: string; email: string } | null {
  const entry = refreshGraceByHash.get(tokenHash(refreshToken))
  if (!entry) return null
  if (entry.until < Date.now()) {
    refreshGraceByHash.delete(tokenHash(refreshToken))
    return null
  }
  return { userId: entry.userId, email: entry.email }
}

async function uniqueReferralCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = randomBytes(4).toString('hex')
    const clash = await prisma.user.findUnique({ where: { referralCode: code } })
    if (!clash) return code
  }
  return randomBytes(8).toString('hex')
}

/**
 * Issue a fresh OTP for `userId`, persist its hash + expiry, and email it.
 * The plaintext code is never stored — only its bcrypt hash. Throws if the
 * email provider is misconfigured in production.
 */
async function issueAndSendOtp(userId: string, email: string): Promise<void> {
  const code = generateOtpCode()
  const codeHash = await hashOtpCode(code)
  await prisma.user.update({
    where: { id: userId },
    data: {
      emailVerificationCodeHash: codeHash,
      emailVerificationExpiresAt: otpExpiresAt(),
      emailVerificationAttempts: 0,
      emailVerificationLastSentAt: new Date(),
    },
  })
  await sendVerificationEmail({ to: email, code, expiresInMinutes: OTP_TTL_MINUTES })
}

/**
 * Public config — what the unauthenticated frontend needs to know before
 * rendering /login or /register. Currently just exposes whether public
 * signup is enabled so the register page can show an invite-only notice.
 */
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    registrationOpen: env.registrationOpen,
    appName: env.APP_NAME || 'koie.fin',
  })
})

router.post('/register', validate(registerSchema), asyncHandler(async (req: Request, res: Response) => {
  if (!env.registrationOpen) {
    res.status(403).json({
      error: 'Registration is currently invite-only. Please contact your administrator.',
      registrationOpen: false,
    })
    return
  }

  const rawEmail = (req as Request & { validated: { email: string; password: string } }).validated.email
  const password = (req as Request & { validated: { email: string; password: string } }).validated.password
  const email = rawEmail.trim().toLowerCase()

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    // Privacy-aware: if the account exists but hasn't verified its email yet, treat the
    // "register" call as a "resume verification" — re-issue the OTP and tell the client
    // to head to the verification page. We never leak password hash material.
    if (!existing.emailVerified) {
      // Honour the resend cooldown so a repeated register spam can't blast emails.
      const sinceLast = existing.emailVerificationLastSentAt
        ? Date.now() - existing.emailVerificationLastSentAt.getTime()
        : Number.POSITIVE_INFINITY
      if (sinceLast < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
        res.status(429).json({
          error: `Please wait ${Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - sinceLast) / 1000)}s before requesting another code.`,
          requiresVerification: true,
          email,
        })
        return
      }
      await issueAndSendOtp(existing.id, email)
      res.status(202).json({ ok: true, requiresVerification: true, email })
      return
    }
    res.status(409).json({ error: 'Email already in use' })
    return
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const referralCode = await uniqueReferralCode()
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({ data: { email, passwordHash, referralCode } })
    // Real-funds-only: equity is derived from the ledger (deposits − withdrawals + realized PnL).
    // The portfolio row is kept for legacy code paths but starts at $0 — no paper baseline.
    await tx.portfolio.create({ data: { userId: created.id, totalValue: 0, pnl: 0 } })
    // Default risk guardrails for new users: safe out-of-the-box live automation.
    await tx.riskRule.create({
      data: {
        userId: created.id,
        maxOrderNotional: 250,
        maxOpenNotional: 1000,
        maxDailyLoss: 100,
        cooldownMinutes: 60,
        maxLosingStreak: 3,
        isEnabled: true,
      },
    })
    return created
  })

  try {
    await issueAndSendOtp(user.id, email)
  } catch (err) {
    // Roll back the half-created account so the user can retry with the same email.
    // We only roll back if email actually failed; we still keep the user otherwise so they
    // can try /resend-otp from the verify page.
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined)
    throw err
  }

  // No JWT issued yet — login is gated on emailVerified.
  res.status(202).json({ ok: true, requiresVerification: true, email })
}))

router.post('/verify-email', validate(verifyEmailSchema), asyncHandler(async (req: Request, res: Response) => {
  const rawEmail = (req as Request & { validated: { email: string; code: string } }).validated.email
  const code = (req as Request & { validated: { email: string; code: string } }).validated.code
  const email = rawEmail.trim().toLowerCase()

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    // Same error shape as bad-code path so we don't leak account existence
    res.status(400).json({ error: 'Invalid or expired verification code.' })
    return
  }

  if (user.emailVerified) {
    res.status(409).json({ error: 'Email is already verified. Please sign in.' })
    return
  }

  if (
    !user.emailVerificationCodeHash ||
    !user.emailVerificationExpiresAt ||
    user.emailVerificationExpiresAt.getTime() < Date.now()
  ) {
    res.status(400).json({ error: 'Verification code has expired. Request a new one.', expired: true })
    return
  }

  if (user.emailVerificationAttempts >= OTP_MAX_ATTEMPTS) {
    res.status(429).json({
      error: 'Too many incorrect attempts. Please request a new verification code.',
      expired: true,
    })
    return
  }

  const matches = await verifyOtpCode(code, user.emailVerificationCodeHash)
  if (!matches) {
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerificationAttempts: { increment: 1 } },
    })
    const remaining = Math.max(0, OTP_MAX_ATTEMPTS - (user.emailVerificationAttempts + 1))
    res.status(400).json({
      error: remaining > 0
        ? `Invalid code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Invalid code. Please request a new verification code.',
    })
    return
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      emailVerificationCodeHash: null,
      emailVerificationExpiresAt: null,
      emailVerificationAttempts: 0,
      // Verified accounts log in clean — reset any prior login lockout.
      failedLoginAttempts: 0,
      lockoutUntil: null,
    },
  })

  // Verification doubles as a successful first sign-in — issue normal session cookies.
  const token = signAccess(user.id, user.email)
  const refreshToken = signRefresh(user.id, user.email)
  await createRefreshSession(user.id, refreshToken, req)
  setAuthCookies(res, token, refreshToken)
  res.json({ ok: true, verified: true })
}))

router.post('/resend-otp', validate(resendOtpSchema), asyncHandler(async (req: Request, res: Response) => {
  const rawEmail = (req as Request & { validated: { email: string } }).validated.email
  const email = rawEmail.trim().toLowerCase()

  const user = await prisma.user.findUnique({ where: { email } })
  // Always return the same success-ish shape so attackers can't enumerate accounts.
  // (We still throttle real sends below.)
  const genericResponse = { ok: true, email }

  if (!user || user.emailVerified) {
    res.json(genericResponse)
    return
  }

  const sinceLast = user.emailVerificationLastSentAt
    ? Date.now() - user.emailVerificationLastSentAt.getTime()
    : Number.POSITIVE_INFINITY
  if (sinceLast < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    const retryAfterSec = Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - sinceLast) / 1000)
    res.status(429).json({
      error: `Please wait ${retryAfterSec}s before requesting another code.`,
      retryAfter: retryAfterSec,
    })
    return
  }

  await issueAndSendOtp(user.id, email)
  res.json(genericResponse)
}))

router.post('/login', validate(loginSchema), asyncHandler(async (req: Request, res: Response) => {
  const rawIdentifier = (req as Request & { validated: { identifier: string; password: string } }).validated.identifier
  const password = (req as Request & { validated: { identifier: string; password: string } }).validated.password
  const identifier = rawIdentifier.trim().toLowerCase()

  // Block login for internal system / paper-trader accounts (still email-shaped).
  if (identifier === GLOBAL_PAPER_EMAIL || identifier === 'system.paperbot@cryptoflow.internal') {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  // Look up by email when the identifier looks like an address, otherwise by username.
  // Both columns have a unique index so this is a single indexed lookup either way.
  const isEmail = identifier.includes('@')
  const user = isEmail
    ? await prisma.user.findUnique({ where: { email: identifier } })
    : await prisma.user.findUnique({ where: { username: identifier } })
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }
  // The user's real email — what we use for OTP delivery if needed.
  const email = user.email

  if (user.lockoutUntil && user.lockoutUntil.getTime() > Date.now()) {
    res.status(429).json({ error: 'Too many failed attempts. Please try again later.' })
    return
  }

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) {
    const failed = user.failedLoginAttempts + 1
    const lockout = failed >= MAX_FAILED_LOGIN_ATTEMPTS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
      : null
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: lockout ? 0 : failed,
        lockoutUntil: lockout,
      },
    })
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  // Password is correct — but block sign-in until the email has been verified.
  // We re-issue a code only if there's no live one (respects the 60 s cooldown so
  // a password-correct attacker can't spam emails either).
  if (!user.emailVerified) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockoutUntil: null },
    })
    const sinceLast = user.emailVerificationLastSentAt
      ? Date.now() - user.emailVerificationLastSentAt.getTime()
      : Number.POSITIVE_INFINITY
    if (sinceLast >= OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      try {
        await issueAndSendOtp(user.id, email)
      } catch {
        // Best-effort — user can still hit "Resend" from the verify page.
      }
    }
    res.status(403).json({
      error: 'Please verify your email to continue.',
      requiresVerification: true,
      email,
    })
    return
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockoutUntil: null,
    },
  })

  const token = signAccess(user.id, user.email)
  const refreshToken = signRefresh(user.id, user.email)
  await createRefreshSession(user.id, refreshToken, req)
  setAuthCookies(res, token, refreshToken)
  // Tokens are set via HttpOnly cookies; do not echo them in the body to reduce XSS surface
  res.json({ ok: true })
}))

router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  const candidates = readAllRefreshTokens(req)
  if (candidates.length === 0) {
    clearAuthCookies(res)
    res.status(401).json({ error: 'Refresh token missing' })
    return
  }

  let matched: { refreshToken: string; user: { id: string; email: string }; fromGrace: boolean } | null =
    null

  for (const refreshToken of candidates) {
    const payload = verifyRefreshJwt(refreshToken)
    if (!payload?.userId) continue

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true },
    })
    if (!user) continue

    // Match THIS cookie's hash — never "latest session for user".
    const currentHash = tokenHash(refreshToken)
    const session = await prisma.authSession.findFirst({
      where: {
        userId: user.id,
        refreshTokenHash: currentHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    })
    if (session && safeEqualHexHash(session.refreshTokenHash, currentHash)) {
      matched = { refreshToken, user, fromGrace: false }
      break
    }

    // Sibling tab already rotated this token — redeem via grace instead of logout.
    const grace = consumeRefreshGrace(refreshToken)
    if (grace && grace.userId === user.id) {
      matched = { refreshToken, user, fromGrace: true }
      break
    }

    // DB grace: session revoked in the last 45s with this hash.
    const recentlyRevoked = await prisma.authSession.findFirst({
      where: {
        userId: user.id,
        refreshTokenHash: currentHash,
        revokedAt: { gte: new Date(Date.now() - REFRESH_GRACE_MS) },
      },
      orderBy: { revokedAt: 'desc' },
    })
    if (recentlyRevoked) {
      matched = { refreshToken, user, fromGrace: true }
      break
    }
  }

  if (!matched) {
    // Stale Domain= cookies / secret rotation — wipe all variants so middleware
    // stops treating the browser as logged-in with a dead refresh token.
    clearAuthCookies(res)
    res.status(401).json({ error: 'Invalid refresh session' })
    return
  }

  if (!matched.fromGrace) {
    rememberRefreshGrace(matched.refreshToken, matched.user.id, matched.user.email)
    await revokeRefreshSessionByToken(matched.refreshToken)
    // Revoke any other duplicate cookie values for this user that we saw.
    for (const other of candidates) {
      if (other !== matched.refreshToken) {
        await revokeRefreshSessionByToken(other)
      }
    }
  }

  const token = signAccess(matched.user.id, matched.user.email)
  const nextRefreshToken = signRefresh(matched.user.id, matched.user.email)
  await createRefreshSession(matched.user.id, nextRefreshToken, req)
  rememberRefreshGrace(matched.refreshToken, matched.user.id, matched.user.email)
  setAuthCookies(res, token, nextRefreshToken)
  res.json({ ok: true })
}))

router.post('/logout', asyncHandler(async (req: Request, res: Response) => {
  for (const refreshToken of readAllRefreshTokens(req)) {
    await revokeRefreshSessionByToken(refreshToken)
  }
  clearAuthCookies(res)
  res.json({ ok: true })
}))

router.get('/me', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const uid = req.user!.userId
  let user = await prisma.user.findUnique({
    where: { id: uid },
    select: { id: true, email: true, createdAt: true, referralCode: true, trialBalance: true },
  })
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  if (!user.referralCode) {
    const code = await uniqueReferralCode()
    user = await prisma.user.update({
      where: { id: uid },
      data: { referralCode: code },
      select: { id: true, email: true, createdAt: true, referralCode: true, trialBalance: true },
    })
  }
  res.json({
    ...user,
    trialBalance: Number(user.trialBalance),
  })
}))

export default router
