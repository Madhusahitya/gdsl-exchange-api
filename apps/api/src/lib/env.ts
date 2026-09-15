import { z } from 'zod'

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** Local dev default is 8000; production Docker/nginx uses 4000 (set PORT in .env). */
  PORT: z.coerce.number().default(8000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  FRONTEND_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().optional(),
  ENCRYPTION_KEY: z.string().min(16).optional(),
  APP_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  COOKIE_DOMAIN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  SENTRY_DSN: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  ENABLE_RL_SHADOW: z.string().optional(),
  TRADINGVIEW_WEBHOOK_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  BINANCE_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  BINANCE_API_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  LIVE_AUTOMATION_ENABLED: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  LIVE_AUTOMATION_MAINTENANCE_REASON: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Hard cap (USDT) per Binance live entry. Default 25 — safe for first CEX trials. */
  CEX_LIVE_MAX_ORDER_USDT: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.coerce.number().positive().max(500_000).optional(),
  ),
  /** Binance live take-profit % from entry (default 1.0). */
  CEX_LIVE_TAKE_PROFIT_PCT: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.coerce.number().positive().max(50).optional(),
  ),
  /** Binance live stop-loss % from entry (default 1.0). */
  CEX_LIVE_STOP_LOSS_PCT: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.coerce.number().positive().max(50).optional(),
  ),
  TELEGRAM_BOT_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TELEGRAM_BOT_USERNAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TELEGRAM_WEBHOOK_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TELEGRAM_LINK_CODE_TTL_MIN: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  /** Long-poll Telegram /getUpdates instead of relying on the webhook (use on localhost). */
  TELEGRAM_POLLING_ENABLED: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** 64 hex chars (32 bytes) — used for AES-256-GCM encryption of personal-wallet private keys. */
  WALLET_ENCRYPTION_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Optional override for the BSC RPC used by personal wallets / hot wallet. */
  BSC_RPC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  /**
   * Additional BSC RPC endpoints used as fallbacks when the primary
   * (`BSC_RPC_URL`) returns a rate-limit error (-32007 from QuickNode etc.)
   * or stalls. The server builds an ethers `FallbackProvider` across all
   * configured URLs so trade flows survive a single provider being slow.
   */
  BSC_RPC_URL_FALLBACK_1: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  BSC_RPC_URL_FALLBACK_2: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  BSC_RPC_URL_FALLBACK_3: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  /** Comma-separated extra browser origins for CORS (e.g. `https://app.com,https://www.app.com`). FRONTEND_URL is always allowed. */
  ALLOWED_CORS_ORIGINS: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** When set, GET /metrics requires `Authorization: Bearer <token>`. In production, /metrics is disabled if unset. */
  METRICS_BEARER_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Behind nginx/ALB: set true so Express sees X-Forwarded-* (client IP, proto). */
  TRUST_PROXY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Resend API key for transactional emails (verification OTPs). Required in production for signup. */
  RESEND_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Verified sender, e.g. `Godslandx <noreply@godslandx.com>`. Defaults to Resend sandbox sender. */
  RESEND_FROM_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Product name used in email subject lines / templates. Defaults to "Godslandx". */
  APP_NAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /**
   * When `false` (default), public signup is disabled — only operators can create accounts
   * (via the seed script or DB). Flip to `true` to re-enable the OTP-gated /register flow.
   * Accepts: `1`, `true`, `yes`, `on` (case-insensitive).
   */
  REGISTRATION_OPEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /**
   * When true (default), the API watches OPEN DEX Personal Wallet trades and
   * auto-sells on take-profit, stop-loss, or SELL signal — even if the user
   * is not on the DEX Trading page.
   */
  DEX_SERVER_AUTO_EXIT: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Take-profit % above entry fill (default 1.5 — must clear Pancake fees + gas on small lots). */
  DEX_AUTO_TP_PCT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  /** Stop-loss % below entry fill (default 1.0). */
  DEX_AUTO_SL_PCT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  /** Min Pancake-quoted profit % before signal_sell auto-exit (default 0.5). */
  DEX_SIGNAL_EXIT_MIN_PROFIT_PCT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  DEX_AUTO_EXIT_SLIPPAGE_BPS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  /** Min estimated net USDT profit (after slippage + gas) before auto-exit TP/signal sell. */
  DEX_MIN_NET_PROFIT_USD: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  /** Signal threshold as a fraction (0.0008 = 0.08%), aligned with the web terminal. */
  DEX_SIGNAL_THRESHOLD_PCT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  /** 1inch Classic Swap API key (portal.1inch.dev). Required for DEX 1inch routes. */
  ONEINCH_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Jupiter Swap API v2 key (portal.jup.ag). Required for DEX Jupiter routes. */
  JUPITER_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Optional override, e.g. https://api.jup.ag/swap/v2 */
  JUPITER_API_BASE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Solana JSON-RPC for balance reads (default mainnet-beta public). */
  SOLANA_RPC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Smart router: max bps above Binance mid on BUY at best venue (default 80 = 0.8%). */
  SMART_ROUTER_MAX_BUY_VS_BINANCE_BPS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  SMART_ROUTER_MIN_USDT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  SMART_ROUTER_BINANCE_TAKER_FEE_BPS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  SMART_ROUTER_DEX_GAS_USD_BUY: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  SMART_ROUTER_DEX_GAS_USD_SELL: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
})

function checkBinanceKeys() {
  const key = process.env.BINANCE_API_KEY?.trim()
  const secret = process.env.BINANCE_API_SECRET?.trim()
  if (!key || !secret) {
    console.warn('\n⚠ BINANCE_API_KEY / BINANCE_API_SECRET not in .env — using encrypted keys from Exchange page (DB).\n')
  }
}

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

checkBinanceKeys()

function assertProductionEnvReady(data: z.infer<typeof envSchema>) {
  if (data.NODE_ENV !== 'production') return
  if (!data.ENCRYPTION_KEY) {
    console.error(
      '[FATAL] ENCRYPTION_KEY is required when NODE_ENV=production (encrypts Binance API secrets at rest). Generate: openssl rand -hex 32',
    )
    process.exit(1)
  }
  if (!data.FRONTEND_URL) {
    console.warn(
      '[WARN] FRONTEND_URL unset in production — set your public web app URL (https://…) or browser CORS and cookies may fail.',
    )
  }
  if (!data.RESEND_API_KEY) {
    console.warn(
      '[WARN] RESEND_API_KEY unset in production — new user signups will fail until you set it. Get a key at https://resend.com',
    )
  }
}

assertProductionEnvReady(parsed.data)

const allowedCorsOrigins = (parsed.data.ALLOWED_CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export const env = {
  ...parsed.data,
  JWT_REFRESH_SECRET: parsed.data.JWT_REFRESH_SECRET ?? `${parsed.data.JWT_SECRET}_refresh`,
  LIVE_AUTOMATION_ENABLED: parseBoolean(parsed.data.LIVE_AUTOMATION_ENABLED, true),
  LIVE_AUTOMATION_MAINTENANCE_REASON: parsed.data.LIVE_AUTOMATION_MAINTENANCE_REASON,
  /** Default $25 so first CEX runs cannot empty the account. */
  CEX_LIVE_MAX_ORDER_USDT: parsed.data.CEX_LIVE_MAX_ORDER_USDT ?? 25,
  CEX_LIVE_TAKE_PROFIT_PCT: parsed.data.CEX_LIVE_TAKE_PROFIT_PCT ?? 1.0,
  CEX_LIVE_STOP_LOSS_PCT: parsed.data.CEX_LIVE_STOP_LOSS_PCT ?? 1.0,
  TELEGRAM_BOT_TOKEN: parsed.data.TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME: parsed.data.TELEGRAM_BOT_USERNAME,
  TELEGRAM_WEBHOOK_SECRET: parsed.data.TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_LINK_CODE_TTL_MIN: parsed.data.TELEGRAM_LINK_CODE_TTL_MIN ?? 15,
  TELEGRAM_POLLING_ENABLED: parsed.data.TELEGRAM_POLLING_ENABLED,
  WALLET_ENCRYPTION_KEY: parsed.data.WALLET_ENCRYPTION_KEY,
  BSC_RPC_URL: parsed.data.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org',
  BSC_RPC_URL_FALLBACK_1: parsed.data.BSC_RPC_URL_FALLBACK_1,
  BSC_RPC_URL_FALLBACK_2: parsed.data.BSC_RPC_URL_FALLBACK_2,
  BSC_RPC_URL_FALLBACK_3: parsed.data.BSC_RPC_URL_FALLBACK_3,
  /** Parsed ALLOWED_CORS_ORIGINS */
  allowedCorsOrigins,
  trustProxy: parseBoolean(parsed.data.TRUST_PROXY, false),
  /** Whether public /api/auth/register is enabled. Defaults to false (invite-only). */
  registrationOpen: parseBoolean(parsed.data.REGISTRATION_OPEN, false),
  dexServerAutoExit: parseBoolean(parsed.data.DEX_SERVER_AUTO_EXIT, true),
  dexAutoTakeProfitPct: parsed.data.DEX_AUTO_TP_PCT ?? 1.0,
  dexAutoStopLossPct: parsed.data.DEX_AUTO_SL_PCT ?? 1.0,
  /** Min quoted profit % before signal-based auto-exit (BSC needs ~1%+ to clear fees). */
  dexSignalExitMinProfitPct: parsed.data.DEX_SIGNAL_EXIT_MIN_PROFIT_PCT ?? 1.0,
  dexAutoExitSlippageBps: parsed.data.DEX_AUTO_EXIT_SLIPPAGE_BPS ?? 100,
  dexMinNetProfitUsd: parsed.data.DEX_MIN_NET_PROFIT_USD ?? 0.05,
  /** Fraction passed to `computeTrendRsiSignal` (0.0008 ↔ 0.08% UI threshold). */
  dexSignalThresholdFrac: (parsed.data.DEX_SIGNAL_THRESHOLD_PCT ?? 0.08) / 100,
  ONEINCH_API_KEY: parsed.data.ONEINCH_API_KEY,
  JUPITER_API_KEY: parsed.data.JUPITER_API_KEY,
  JUPITER_API_BASE: parsed.data.JUPITER_API_BASE,
  SOLANA_RPC_URL: parsed.data.SOLANA_RPC_URL,
  smartRouterMaxBuyVsBinanceBps: parsed.data.SMART_ROUTER_MAX_BUY_VS_BINANCE_BPS ?? 80,
  smartRouterMinUsdt: parsed.data.SMART_ROUTER_MIN_USDT ?? 50,
  smartRouterBinanceTakerFeeBps: parsed.data.SMART_ROUTER_BINANCE_TAKER_FEE_BPS ?? 10,
  smartRouterDexGasUsdBuy: parsed.data.SMART_ROUTER_DEX_GAS_USD_BUY ?? 0.12,
  smartRouterDexGasUsdSell: parsed.data.SMART_ROUTER_DEX_GAS_USD_SELL ?? 0.1,
}
