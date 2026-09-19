import rateLimit from 'express-rate-limit'
import { env } from '../lib/env'

/** In development, skip strict login/register limits so local testing is not blocked after a few tries. */
const skipAuthLimitInDev = (): boolean => env.NODE_ENV === 'development'

/**
 * Login/register brute-force cap per IP. Only FAILED attempts count — a
 * successful login must never push a user into the 429 window (previously a
 * few typos followed by the right password still locked the IP for 15 min).
 * `AUTH_RATE_LIMIT_MAX` lets staging use a looser cap than production.
 */
const authLimitMax = Number(process.env.AUTH_RATE_LIMIT_MAX) > 0 ? Number(process.env.AUTH_RATE_LIMIT_MAX) : 5

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: authLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts, please try again later' },
  skip: skipAuthLimitInDev,
})

/**
 * Cap on verification-code submissions per IP. Per-user wrong-attempt counter
 * still applies on top (5 wrong codes invalidates the OTP), but this prevents
 * one IP from grinding through codes against many email addresses.
 */
export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts, please try again later' },
  skip: skipAuthLimitInDev,
})

/**
 * Cap on resend-OTP requests per IP. Each user also has a 60 s cooldown server-side;
 * this limiter stops one IP from triggering email sends across many addresses (cost
 * control + deliverability hygiene).
 */
export const otpResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many resend requests, please try again later' },
  skip: skipAuthLimitInDev,
})

/**
 * Global cap on **all** `/api/*` HTTP requests per client IP (per window).
 * Keep high enough for SPA dashboards (many parallel GETs + Socket.IO
 * reconnects) but low enough to blunt abuse.
 *
 * **Critical behind nginx:** set `TRUST_PROXY=true` on the API so each real
 * client IP is taken from `X-Forwarded-For`. If trust proxy is off, every
 * user appears as the proxy → they **share one bucket** → 429 for everyone
 * after a few minutes (investor demos look like “server too weak”).
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === 'development' ? 8000 : 4000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
})

export const botLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bot actions, please slow down' },
})

/** On-chain delegated swaps — stricter than generic API (real funds). */
export const delegateSwapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.NODE_ENV === 'development' ? 30 : 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many delegated swap requests, please slow down' },
})
