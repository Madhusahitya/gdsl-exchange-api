import { config as loadDotenv } from 'dotenv'
import path from 'path'
import fs from 'fs'

function tryLoadEnvFiles(): void {
  const roots = [
    process.cwd(),
    path.resolve(process.cwd(), 'apps/api'),
    path.resolve(process.cwd(), '..'),
  ]
  const names = ['.env', '.env.local']
  for (const root of roots) {
    for (const name of names) {
      const p = path.join(root, name)
      if (fs.existsSync(p)) {
        loadDotenv({ path: p, override: false })
      }
    }
  }
}

tryLoadEnvFiles()

export type ExecutorConfig = {
  apiKey: string
  apiSecret: string
  demoMode: boolean
  baseUrl: string
  requestTimeoutMs: number
  maxRetries: number
  /** Conservative taker fee estimate per fill (basis points), for safety gate */
  estimatedTakerFeeBps: number
}

function parseBool(v: string | undefined, defaultTrue: boolean): boolean {
  if (v === undefined || v === '') return defaultTrue
  const s = v.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return defaultTrue
}

export function loadExecutorConfig(): ExecutorConfig {
  const apiKey = process.env.BINANCE_API_KEY?.trim() ?? ''
  const apiSecret = process.env.BINANCE_API_SECRET?.trim() ?? ''

  if (!apiKey || !apiSecret) {
    throw new Error(
      'Missing BINANCE_API_KEY or BINANCE_API_SECRET. Set them in .env (read-only keys recommended for demo).'
    )
  }

  const feeRaw = process.env.BINANCE_ESTIMATED_TAKER_BPS
  const estimatedTakerFeeBps = feeRaw ? Math.min(1000, Math.max(1, parseInt(feeRaw, 10) || 10)) : 10

  return {
    apiKey,
    apiSecret,
    demoMode: parseBool(process.env.DEMO_MODE, true),
    baseUrl: (process.env.BINANCE_BASE_URL ?? 'https://api.binance.com').replace(/\/$/, ''),
    requestTimeoutMs: Math.min(120_000, Math.max(3000, parseInt(process.env.BINANCE_HTTP_TIMEOUT_MS ?? '15000', 10) || 15_000)),
    /** Total HTTP attempts per call (initial try + retries), clamped to 1–10; default 3. */
    maxRetries: Math.min(10, Math.max(1, parseInt(process.env.BINANCE_HTTP_MAX_RETRIES ?? '3', 10) || 3)),
    estimatedTakerFeeBps,
  }
}
