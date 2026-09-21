import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'

/**
 * 6-digit numeric one-time code utilities.
 *
 * Codes are generated with the crypto-grade randomInt() so they're unguessable.
 * We store ONLY a bcrypt hash on the User row — never the plaintext — so a DB
 * leak doesn't expose live verification codes.
 */

/** Length of the OTP. 6 digits = 1,000,000 possibilities; with 5-attempt caps the brute-force odds are 0.0005 %. */
export const OTP_LENGTH = 6

/** How long a code is valid for after issue. */
export const OTP_TTL_MINUTES = 15

/** Wrong-guesses allowed per issued code before we lock the code out and require a resend. */
export const OTP_MAX_ATTEMPTS = 5

/** Min seconds between consecutive resend-OTP requests for the same user (prevents email spam). */
export const OTP_RESEND_COOLDOWN_SECONDS = 60

/** Generate a fresh random 6-digit code as a zero-padded string. */
export function generateOtpCode(): string {
  const n = randomInt(0, 10 ** OTP_LENGTH)
  return n.toString().padStart(OTP_LENGTH, '0')
}

/** Bcrypt hash of an OTP for at-rest storage. */
export async function hashOtpCode(code: string): Promise<string> {
  return bcrypt.hash(code, 10)
}

/** Constant-time-ish comparison via bcrypt of a candidate code against its stored hash. */
export async function verifyOtpCode(candidate: string, hash: string): Promise<boolean> {
  if (!candidate || !hash) return false
  return bcrypt.compare(candidate, hash)
}

/** Compute the expiry timestamp for a freshly issued code. */
export function otpExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + OTP_TTL_MINUTES * 60_000)
}
