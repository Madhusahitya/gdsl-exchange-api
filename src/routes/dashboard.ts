import { Router, Request, Response } from 'express'
import { prisma, TradeStatus } from '@cryptoflow/db'
import { authenticateToken } from '../middleware/authenticateToken'
import { asyncHandler } from '../middleware/asyncHandler'
import { logger } from '../lib/logger'
import {
  computeUserEquity,
  EMPTY_EQUITY_SNAPSHOT,
  reconcilePortfolioTotalValue,
  summarizeLedgerWindow,
  type EquitySnapshot,
  type OpenPositionSnapshot,
} from '../services/portfolio/equityService'
import { env } from '../lib/env'
import {
  getPersonalWalletSummaryForDashboard,
  isPersonalWalletEnabled,
} from '../services/wallet/personalWalletService'
import { cacheGet, cacheSet } from '../lib/redis'

const router = Router()

/** Client-supplied MetaMask/BSC valuation (GET query). Honoured only when walletView=browser. */
function parseBrowserWalletQuery(query: Request['query']): {
  totalUsd: number
  stableUsd: number
  riskUsd: number
  addressTail?: string
} | null {
  const wv = String(query.walletView ?? '').toLowerCase()
  if (wv !== 'browser') return null
  const totalUsd = parseFloat(String(query.bt ?? ''))
  const stableUsd = parseFloat(String(query.bs ?? ''))
  const riskUsdRaw = query.br !== undefined ? parseFloat(String(query.br)) : NaN
  if (!Number.isFinite(totalUsd) || totalUsd < 0 || totalUsd > 50_000_000) return null
  const st = Number.isFinite(stableUsd) && stableUsd >= 0 ? stableUsd : 0
  const rk =
    Number.isFinite(riskUsdRaw) && riskUsdRaw >= 0 ? riskUsdRaw : Math.max(0, totalUsd - st)
  const tailRaw = typeof query.btail === 'string' ? query.btail.replace(/[^a-fA-F0-9]/g, '') : ''
  const addressTail = tailRaw.length > 0 ? tailRaw.slice(-4) : undefined
  return { totalUsd, stableUsd: st, riskUsd: rk, addressTail }
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function safePct(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0
  const value = (numerator / denominator) * 100
  return Number.isFinite(value) ? value : 0
}

type DashboardActiveSession = {
  startedAt: Date
  strategy: { name: string }
} | null

type DashboardLastTrade = {
  createdAt: Date
  pnl: unknown
  pair: string
} | null

router.get('/summary', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId
  const browserSnap = parseBrowserWalletQuery(req.query)
  const isBrowserQuery = Boolean(browserSnap)
  const cacheKey = `dashboard:summary:${userId}`

  if (!isBrowserQuery) {
    const cached = await cacheGet<Record<string, unknown>>(cacheKey)
    if (cached) {
      res.json(cached)
      return
    }
  }

  const now = new Date()
  const dayStart = startOfUtcDay(now)
  const weekStart = new Date(dayStart.getTime() - 6 * 24 * 60 * 60 * 1000)

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      trialBalance: true,
      referralCode: true,
    },
  })
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  const degraded: string[] = []

  const settled = await Promise.allSettled([
    computeUserEquity(userId),
    isPersonalWalletEnabled() ? getPersonalWalletSummaryForDashboard(userId) : Promise.resolve(null),
    summarizeLedgerWindow(userId, dayStart, now),
    summarizeLedgerWindow(userId, weekStart, now),
    prisma.referralReward.aggregate({
      where: { userId },
      _sum: { amount: true },
    }),
    prisma.referralReward.aggregate({
      where: { userId, createdAt: { gte: dayStart } },
      _sum: { amount: true },
    }),
    prisma.user.count({ where: { referredById: userId, createdAt: { gte: dayStart } } }),
    prisma.botSession.findFirst({
      where: { userId, isActive: true },
      include: { strategy: { select: { name: true } } },
    }),
    prisma.trade.groupBy({
      by: ['status'],
      where: { userId },
      _count: { _all: true },
    }),
    prisma.trade.findFirst({
      where: { userId, status: TradeStatus.CLOSED },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, pnl: true, pair: true },
    }),
    prisma.newsEvent.findMany({
      orderBy: { publishedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        title: true,
        url: true,
        source: true,
        publishedAt: true,
        sentimentScore: true,
      },
    }),
  ])

  const pick = <T>(i: number, fallback: T): T => {
    const r = settled[i]
    if (r?.status === 'fulfilled') return r.value as T
    const reason = r?.status === 'rejected' ? r.reason : 'unknown'
    logger.warn({ userId, index: i, err: reason }, '[dashboard] partial summary failure')
    degraded.push(`section_${i}`)
    return fallback
  }

  const equity = pick<EquitySnapshot>(0, EMPTY_EQUITY_SNAPSHOT)
  if (settled[0]?.status === 'rejected') {
    degraded.push('equity_compute_failed')
  }
  const personalWalletSummary = pick(1, null as Awaited<ReturnType<typeof getPersonalWalletSummaryForDashboard>>)
  if (settled[1]?.status === 'rejected') {
    degraded.push('personal_wallet_unavailable')
  }
  const today = pick(2, {
    deposits: 0,
    withdrawals: 0,
    realizedPnl: 0,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    bestTrade: 0,
    worstTrade: 0,
    avgWinUsd: 0,
    avgLossUsd: 0,
    expectancyUsd: 0,
    payoffRatio: 0,
  })
  const week = pick(3, { ...today })
  const referralTotal = pick(4, { _sum: { amount: null } })
  const todayReferralRewards = pick(5, { _sum: { amount: null } })
  const referralCount = pick(6, 0)
  const activeSession = pick<DashboardActiveSession>(7, null)
  const tradeCounts = pick(8, [] as { status: TradeStatus; _count: { _all: number } }[])
  const lastTrade = pick<DashboardLastTrade>(9, null)
  const newsItems = pick(10, [] as Array<{
    id: string
    title: string
    url: string
    source: string
    publishedAt: Date
    sentimentScore: unknown
  }>)

  // Self-heal legacy paper baseline: if the on-row Portfolio.totalValue drifts
  // from the ledger we recompute it asynchronously so the rest of the system
  // converges on the true number. Failures are non-fatal.
  void reconcilePortfolioTotalValue(userId, equity.realizedEquity)

  // "Equity at the start of today" — derived from the ledger so we don't need
  // a snapshot table. Today's equity change = realized PnL today + change in
  // open-position mark value during the day; we approximate the second term
  // as zero (positions taken today contribute zero MTM at open).
  const equityStartOfDay = equity.liveEquity - today.realizedPnl - today.deposits + today.withdrawals
  const equityChangeUsd24h = equity.liveEquity - equityStartOfDay
  const equityChangePct24h = safePct(equityChangeUsd24h, equityStartOfDay)

  const winRateToday = today.tradeCount > 0 ? (today.wins / today.tradeCount) * 100 : 0
  const winRateWeek = week.tradeCount > 0 ? (week.wins / week.tradeCount) * 100 : 0

  const closedAllTime = tradeCounts.find((c) => c.status === TradeStatus.CLOSED)?._count._all ?? 0
  const openAllTime = tradeCounts.find((c) => c.status === TradeStatus.OPEN)?._count._all ?? 0

  const sessionAgeMinutes = activeSession
    ? Math.max(0, Math.floor((Date.now() - activeSession.startedAt.getTime()) / 60_000))
    : 0
  const hashRate = activeSession ? Math.min(99, 5 + sessionAgeMinutes / 10 + today.tradeCount * 1.5) : 0

  // Prefer browser-wallet snapshot when client sends it (user trades via MetaMask).
  // Otherwise prefer Personal Wallet API totals when enabled; fall back to ledger equity.
  const hasLivePersonalWallet = Boolean(personalWalletSummary?.enabled)
  const personalBalances = personalWalletSummary?.balances ?? []
  const personalStableUsd = personalBalances
    .filter((b) => b.asset === 'USDT' || b.asset === 'USDC')
    .reduce((acc, b) => acc + b.usdValue, 0)
  const personalOpenUsd = Math.max(0, (personalWalletSummary?.totalUsdValue ?? 0) - personalStableUsd)

  const useBrowserLive = Boolean(browserSnap)
  const usePersonalLive = !useBrowserLive && hasLivePersonalWallet

  const walletBalance = useBrowserLive
    ? browserSnap!.totalUsd
    : usePersonalLive
      ? personalWalletSummary!.totalUsdValue
      : equity.liveEquity
  const cashEquity = useBrowserLive
    ? browserSnap!.stableUsd
    : usePersonalLive
      ? personalStableUsd
      : equity.realizedEquity
  const openPositionsMarketValue = useBrowserLive
    ? browserSnap!.riskUsd
    : usePersonalLive
      ? personalOpenUsd
      : equity.openPositionsMarketValue
  const openPositionsCostBasis = useBrowserLive
    ? browserSnap!.riskUsd
    : usePersonalLive
      ? personalOpenUsd
      : equity.openPositionsCostBasis
  // Unrealized on OPEN bot positions uses Binance marks (same as signals).
  // Headline wallet MV for personal wallets may still use on-chain totals.
  const unrealizedPnl = useBrowserLive ? 0 : equity.unrealizedPnl
  const personalAnchorUsd =
    usePersonalLive && personalWalletSummary
      ? Math.max(0.01, personalWalletSummary.dayAnchorTotalUsd ?? personalWalletSummary.totalUsdValue)
      : 0

  const walletChangeUsd = useBrowserLive
    ? today.realizedPnl
    : usePersonalLive
      ? personalWalletSummary?.todayChangeUsd ?? 0
      : equityChangeUsd24h
  const walletChangePercent = useBrowserLive
    ? safePct(today.realizedPnl, Math.max(browserSnap!.totalUsd, 0.01))
    : usePersonalLive
      ? safePct(walletChangeUsd, personalAnchorUsd)
      : equityChangePct24h
  // Profit overview uses closed round-trip USDT delta — not wallet anchor drift
  // (open positions mark-to-market can move the wallet without a closed trade).
  const todayProfit = today.realizedPnl

  const equitySource: 'ledger' | 'personal_wallet_live' | 'browser_wallet_live' = useBrowserLive
    ? 'browser_wallet_live'
    : usePersonalLive
      ? 'personal_wallet_live'
      : 'ledger'

  const openPositionsOut: OpenPositionSnapshot[] = useBrowserLive ? [] : equity.positions

  const summaryPayload = {
    email: user.email,
    referralCode: user.referralCode,

    // Headline numbers
    walletBalance,
    walletChangePercent,
    walletChangeUsd,
    cashEquity,
    equitySource,
    walletLastSyncedAt: useBrowserLive
      ? now.toISOString()
      : personalWalletSummary?.lastSyncedAt ?? now.toISOString(),
    walletBrowserTail: useBrowserLive ? browserSnap?.addressTail ?? null : null,

    // Cash-flow ledger
    totalDeposits: equity.totalDeposits,
    totalWithdrawals: equity.totalWithdrawals,
    depositsToday: today.deposits,
    withdrawalsToday: today.withdrawals,
    depositChangePercent: safePct(today.deposits, equity.totalDeposits),
    withdrawChangePercent: safePct(today.withdrawals, equity.totalWithdrawals),

    // Profitability
    todayProfit,
    weekProfit: week.realizedPnl,
    totalProfit: equity.realizedPnlAllTime,
    realizedPnlAllTime: equity.realizedPnlAllTime,

    // Live unrealized
    unrealizedPnl,
    openPositionsMarketValue,
    openPositionsCostBasis,
    openPositions: openPositionsOut,

    // Trade analytics
    tradesToday: today.tradeCount,
    winsToday: today.wins,
    lossesToday: today.losses,
    winRateToday,
    bestTradeToday: today.bestTrade,
    worstTradeToday: today.worstTrade,
    avgWinTodayUsd: today.avgWinUsd,
    avgLossTodayUsd: today.avgLossUsd,
    expectancyTodayUsd: today.expectancyUsd,
    payoffRatioToday: today.payoffRatio,
    tradesThisWeek: week.tradeCount,
    winRateThisWeek: winRateWeek,
    avgWinWeekUsd: week.avgWinUsd,
    avgLossWeekUsd: week.avgLossUsd,
    expectancyWeekUsd: week.expectancyUsd,
    payoffRatioWeek: week.payoffRatio,
    closedTradesAllTime: closedAllTime,
    openTradesAllTime: openAllTime,
    lastTradeAt: lastTrade?.createdAt ?? null,
    lastTradePnl: lastTrade ? Number(lastTrade.pnl ?? 0) : null,
    lastTradePair: lastTrade?.pair ?? null,

    // Referrals & promo
    referralReward: Number(referralTotal._sum.amount ?? 0),
    todayRewards: Number(todayReferralRewards._sum.amount ?? 0),
    todayReferrals: referralCount,
    trialFunds: Number(user.trialBalance),
    activePlans: activeSession ? 1 : 0,

    // Bot card
    bot: activeSession
      ? {
          label: activeSession.strategy.name,
          hashRateLabel: `${hashRate.toFixed(1)} Gh/s`,
          changePercent: equityChangePct24h,
          dollarChange: equityChangeUsd24h,
          startedAt: activeSession.startedAt.toISOString(),
        }
      : {
          label: 'AI trading bot',
          hashRateLabel: '0.0 Gh/s',
          changePercent: 0,
          dollarChange: 0,
          startedAt: null,
        },

    news: newsItems.map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url,
      source: item.source,
      publishedAt: item.publishedAt,
      sentimentScore: Number(item.sentimentScore ?? 0),
    })),
    /** Derived: server time the snapshot was generated (used by clients to display "Last updated"). */
    generatedAt: now.toISOString(),
    /** True when one or more sections used fallbacks — UI can show a soft warning instead of going blank. */
    degraded: degraded.length > 0,
    degradedReasons: degraded,
    dexAutoExit: {
      enabled: env.dexServerAutoExit && isPersonalWalletEnabled(),
      takeProfitPct: env.dexAutoTakeProfitPct,
      stopLossPct: env.dexAutoStopLossPct,
    },
  }

  if (!isBrowserQuery && degraded.length === 0) {
    void cacheSet(cacheKey, summaryPayload, 8)
  }

  res.json(summaryPayload)
}))

export default router
