import { z } from 'zod'

export const registerSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Must contain uppercase')
    .regex(/[0-9]/, 'Must contain a number'),
})

/**
 * `identifier` can be either an email address (contains `@`) or a username
 * (lowercase alphanumeric, dot, hyphen, underscore — 3-32 chars).
 */
export const loginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, 'Username or email required')
    .max(254, 'Too long'),
  password: z.string().min(1, 'Password required'),
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})

export const verifyEmailSchema = z.object({
  email: z.string().email(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
})

export const resendOtpSchema = z.object({
  email: z.string().email(),
})

export const supportContactSchema = z.object({
  subject: z.string().trim().min(3).max(120),
  message: z.string().trim().min(8).max(4000),
  email: z.string().email().optional(),
})

export const startBotSchema = z
  .object({
    strategyId: z.string().min(1, 'Invalid strategy ID'),
    pair: z
      .enum([
        'BTC/USDT',
        'ETH/USDT',
        'BNB/USDT',
        'SOL/USDT',
        'XRP/USDT',
        'DOGE/USDT',
        'USDC/USDT',
      ])
      .default('BTC/USDT'),
    /** Real-funds-only API modes. */
    mode: z.enum(['wallet', 'live']).default('live'),
    orderSizeUsdt: z.number().positive().min(5).max(500_000).optional(),
    /** Live: % of max per-trade capital (max 20% of book × this / 100) */
    tradeSizePct: z.number().min(10).max(100).optional(),
    /** Required when mode is live */
    exchangeConnectionId: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === 'live' && !data.exchangeConnectionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exchangeConnectionId is required when mode is live',
        path: ['exchangeConnectionId'],
      })
    }
  })

export const engineStartSchema = startBotSchema

/** TradingView and custom alerts send varied keys (`ticker`, `close`, nested JSON) — allow passthrough */
export const webhookSchema = z
  .object({
    symbol: z.string().optional(),
    action: z.string().optional(),
    userId: z.string().optional(),
  })
  .passthrough()

export const withdrawSchema = z.object({
  amount: z.number().positive('Amount must be positive').max(1000000),
  walletAddress: z.string().min(26).max(62),
  network: z.enum(['ERC-20', 'BRC-20', 'Solana']),
})

export const depositSchema = z.object({
  amount: z.number().positive().max(1_000_000),
  reference: z.string().max(128).optional(),
})

export const referralApplySchema = z.object({
  code: z.string().min(4).max(32).transform((s) => s.trim().toLowerCase()),
})

export const tradesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  pair: z.string().optional(),
  status: z.enum(['OPEN', 'CLOSED', 'ALL', 'all', 'open', 'closed']).default('ALL'),
})

export const analyticsQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d', 'all']).default('30d'),
})

export const createExchangeConnectionSchema = z.object({
  exchange: z.enum(['BINANCE']).default('BINANCE'),
  label: z.string().max(64).optional(),
  apiKey: z
    .string()
    .transform((s) => s.trim().replace(/^["']+|["']+$/g, '').replace(/:+$/g, '').trim())
    .pipe(
      z
        .string()
        .min(50, 'Binance API keys are ~64 characters — paste the full key from API Management (not a truncated preview).')
        .max(256),
    ),
  apiSecret: z
    .string()
    .transform((s) => s.trim().replace(/^["']+|["']+$/g, '').replace(/:+$/g, '').trim())
    .pipe(
      z
        .string()
        .min(50, 'Binance API secrets are ~64 characters — paste the full secret shown once when the key was created.')
        .max(512),
    ),
})

export const updateRiskRuleSchema = z.object({
  maxOrderNotional: z.number().positive().max(10_000_000).nullable().optional(),
  maxOpenNotional: z.number().positive().max(10_000_000).nullable().optional(),
  maxDailyLoss: z.number().positive().max(10_000_000).nullable().optional(),
  cooldownMinutes: z.number().int().min(0).max(1440).optional(),
  maxLosingStreak: z.number().int().min(0).max(50).optional(),
  isEnabled: z.boolean().optional(),
})

export const riskEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const SUPPORTED_TRADE_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'USDCUSDT',
] as const

export const createOrderSchema = z.object({
  exchangeConnectionId: z.string().min(1),
  symbol: z.enum(SUPPORTED_TRADE_SYMBOLS),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['MARKET', 'LIMIT']),
  quantity: z.number().positive(),
  price: z.number().positive().optional(),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK']).optional(),
  stopLossPrice: z.number().positive().optional(),
  takeProfitPrice: z.number().positive().optional(),
  trailingPercent: z.number().positive().max(100).optional(),
})

export const listOrdersSchema = z.object({
  status: z.enum(['PENDING_SUBMIT', 'NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'ALL']).default('ALL'),
  symbol: z.enum(SUPPORTED_TRADE_SYMBOLS).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

/** Server-signed Pancake V2 swap via hot wallet (BSC). */
export const hotWalletDelegateSwapSchema = z
  .object({
    direction: z.enum(['buy', 'sell']),
    usdtAmount: z.coerce.number().positive().optional(),
    wbnbAmount: z.coerce.number().positive().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.direction === 'buy' && data.usdtAmount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'usdtAmount is required when direction is buy',
        path: ['usdtAmount'],
      })
    }
  })
