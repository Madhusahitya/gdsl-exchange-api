/**
 * Idempotent seed for the 5 pre-provisioned internal operators.
 *
 * Run inside the API container after a deploy:
 *   docker compose exec api node apps/api/dist/scripts/seedInternalUsers.js
 *
 * Passwords come from env — never commit them:
 *   SEED_PASSWORD_godsland100=...
 *   SEED_PASSWORD_godsland101=...
 *   (one var per username)
 *
 * Each entry is skipped if a user with the same username (or synthetic email)
 * already exists, so this is safe to re-run after rebuilds.
 */
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { prisma } from '@cryptoflow/db'

interface InternalUser {
  username: string
  email: string
}

const ROSTER: InternalUser[] = [
  { username: 'godsland100', email: 'godsland100@godslandx.internal' },
  { username: 'godsland101', email: 'godsland101@godslandx.internal' },
  { username: 'godsland102', email: 'godsland102@godslandx.internal' },
  { username: 'godsland103', email: 'godsland103@godslandx.internal' },
  { username: 'godsland104', email: 'godsland104@godslandx.internal' },
]

function passwordFor(username: string): string {
  const key = `SEED_PASSWORD_${username}`
  const value = process.env[key]?.trim()
  if (!value) {
    throw new Error(`Missing ${key} — set operator passwords in env before running seed`)
  }
  return value
}

async function uniqueReferralCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = randomBytes(4).toString('hex')
    const clash = await prisma.user.findUnique({ where: { referralCode: code } })
    if (!clash) return code
  }
  return randomBytes(8).toString('hex')
}

const DEFAULT_RISK_RULE = {
  maxOrderNotional: 250,
  maxOpenNotional: 1000,
  maxDailyLoss: 100,
  cooldownMinutes: 60,
  maxLosingStreak: 3,
  isEnabled: true,
}

async function ensureUser(u: InternalUser): Promise<'created' | 'rotated' | 'unchanged'> {
  const password = passwordFor(u.username)
  const existing = await prisma.user.findFirst({
    where: { OR: [{ username: u.username }, { email: u.email }] },
  })

  const passwordHash = await bcrypt.hash(password, 10)

  if (existing) {
    const matches = await bcrypt.compare(password, existing.passwordHash)
    if (matches && existing.username === u.username && existing.emailVerified) {
      return 'unchanged'
    }
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        username: u.username,
        passwordHash,
        emailVerified: true,
        failedLoginAttempts: 0,
        lockoutUntil: null,
      },
    })
    return 'rotated'
  }

  const referralCode = await uniqueReferralCode()
  await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: u.email,
        username: u.username,
        passwordHash,
        referralCode,
        emailVerified: true,
      },
    })
    await tx.portfolio.create({ data: { userId: created.id, totalValue: 0, pnl: 0 } })
    await tx.riskRule.create({ data: { userId: created.id, ...DEFAULT_RISK_RULE } })
  })
  return 'created'
}

async function main() {
  console.log(`[seed] Provisioning ${ROSTER.length} internal users…`)
  let created = 0
  let rotated = 0
  let unchanged = 0
  for (const u of ROSTER) {
    try {
      const outcome = await ensureUser(u)
      if (outcome === 'created') created++
      else if (outcome === 'rotated') rotated++
      else unchanged++
      console.log(`[seed]   ${u.username.padEnd(14)} → ${outcome}`)
    } catch (err) {
      console.error(`[seed]   ${u.username.padEnd(14)} → ERROR`, err)
      throw err
    }
  }
  console.log(`[seed] Done. created=${created} rotated=${rotated} unchanged=${unchanged}`)
}

main()
  .then(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error('[seed] Fatal:', err)
    await prisma.$disconnect().catch(() => undefined)
    process.exit(1)
  })
