/**
 * News ingestion service — self-hosted, no API key required.
 *
 * Polls public RSS feeds from CoinDesk, Cointelegraph, Decrypt, and
 * Bitcoin Magazine every 2 minutes. Scores sentiment via the lexicon
 * scorer and stores results in NewsEvent.
 */
import Parser from 'rss-parser'
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { scoreSentiment } from './sentimentLexicon'

const rss = new Parser({ timeout: 10_000 })

const FEEDS: { name: string; url: string }[] = [
  { name: 'coindesk',       url: 'https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'cointelegraph',  url: 'https://cointelegraph.com/rss' },
  { name: 'decrypt',        url: 'https://decrypt.co/feed' },
  { name: 'bitcoinmagazine', url: 'https://bitcoinmagazine.com/feed' },
]

const REDDIT_SUBREDDITS = [
  'CryptoCurrency',
  'Bitcoin',
  'ethereum',
  'solana',
  'CryptoMarkets',
]
const REDDIT_LIMIT_PER_SUB = 20

const SYMBOL_KEYWORDS: Record<string, string[]> = {
  BTCUSDT: ['BTC', 'bitcoin', 'Bitcoin', 'BITCOIN'],
  ETHUSDT: ['ETH', 'ethereum', 'Ethereum', 'ETHEREUM'],
  SOLUSDT: ['SOL', 'solana', 'Solana', 'SOLANA'],
}

function extractMentions(text: string): string[] {
  const mentioned: string[] = []
  for (const keywords of Object.values(SYMBOL_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      mentioned.push(...keywords)
    }
  }
  return [...new Set(mentioned)]
}

interface NormalisedPost {
  source: string
  externalId: string
  title: string
  url: string
  publishedAt: Date
}

async function fetchFeed(feed: { name: string; url: string }): Promise<NormalisedPost[]> {
  try {
    const parsed = await rss.parseURL(feed.url)
    return (parsed.items ?? [])
      .filter((item) => item.title && item.link)
      .map((item) => ({
        source:      feed.name,
        externalId:  item.guid ?? item.link!,
        title:       item.title!,
        url:         item.link!,
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      }))
  } catch (err) {
    // Many public RSS feeds (CoinDesk, etc.) intermittently 403/timeout from
    // server IPs. The news service is best-effort sentiment data — a missed
    // feed degrades gracefully. Logged at debug so production stays clean.
    logger.debug({ err, feed: feed.name }, '[news] RSS fetch failed (best-effort)')
    return []
  }
}

type RedditListing = {
  data?: {
    children?: Array<{
      data?: {
        id?: string
        title?: string
        selftext?: string
        permalink?: string
        created_utc?: number
        score?: number
        num_comments?: number
      }
    }>
  }
}

function scoreRedditRelevance(title: string, body: string, score: number, comments: number): number {
  const text = `${title} ${body}`.toLowerCase()
  const mentionHits = Object.values(SYMBOL_KEYWORDS)
    .flat()
    .reduce((acc, kw) => acc + (text.includes(kw.toLowerCase()) ? 1 : 0), 0)
  const engagement = Math.log10(Math.max(1, score) + Math.max(1, comments))
  const qualityBonus = /\b(analysis|signal|breakout|risk|macro|etf|fomc|on-chain|whale)\b/i.test(text) ? 0.75 : 0
  return mentionHits * 1.25 + engagement + qualityBonus
}

async function fetchRedditSubreddit(subreddit: string): Promise<NormalisedPost[]> {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=${REDDIT_LIMIT_PER_SUB}`
  try {
    const response = await fetch(url, {
      headers: {
        // Reddit expects a descriptive user-agent for API-style access.
        'User-Agent': 'cryptoflow-news-bot/1.0 (by /u/cryptoflow_bot)',
      },
    })
    if (!response.ok) {
      throw new Error(`Status ${response.status}`)
    }
    const payload = (await response.json()) as RedditListing
    const rows = payload.data?.children ?? []
    return rows
      .map((row) => row.data)
      .filter((item): item is NonNullable<typeof item> => Boolean(item?.id && item?.title))
      .map((item) => {
        const title = item.title ?? ''
        const body = item.selftext ?? ''
        const score = Number(item.score ?? 0)
        const comments = Number(item.num_comments ?? 0)
        const relevance = scoreRedditRelevance(title, body, score, comments)
        // Keep only market-relevant Reddit content.
        if (relevance < 1.5) return null
        const weightedSentiment = scoreSentiment(`${title} ${body}`) * Math.min(2, 1 + relevance / 10)
        return {
          source: 'reddit',
          externalId: `r/${subreddit}/${item.id}`,
          title: `[r/${subreddit}] ${title}`,
          url: item.permalink ? `https://www.reddit.com${item.permalink}` : `https://www.reddit.com/r/${subreddit}`,
          publishedAt: item.created_utc ? new Date(item.created_utc * 1000) : new Date(),
          sentimentOverride: Math.max(-1, Math.min(1, weightedSentiment)),
          rawPayload: {
            subreddit,
            score,
            comments,
            relevance,
          },
        }
      })
      .filter((post): post is NonNullable<typeof post> => post !== null)
  } catch (err) {
    // Reddit blocks anonymous server IPs in waves — degrade gracefully and
    // keep these out of warn-level logs so production isn't noisy.
    logger.debug({ err, subreddit }, '[news] Reddit fetch failed (best-effort)')
    return []
  }
}

type IngestPost = NormalisedPost & {
  sentimentOverride?: number
  rawPayload?: Record<string, unknown>
}

async function fetchAll(): Promise<NormalisedPost[]> {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed))
  const rssPosts = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  const redditResults = await Promise.allSettled(REDDIT_SUBREDDITS.map(fetchRedditSubreddit))
  const redditPosts = redditResults.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  return [...rssPosts, ...redditPosts]
}

async function ingestPosts(posts: IngestPost[]) {
  for (const post of posts) {
    const mentions  = extractMentions(post.title)
    const sentiment = post.sentimentOverride ?? scoreSentiment(post.title)

    try {
      await prisma.newsEvent.upsert({
        where: { source_externalId: { source: post.source, externalId: post.externalId } },
        create: {
          source:           post.source,
          externalId:       post.externalId,
          title:            post.title,
          url:              post.url,
          publishedAt:      post.publishedAt,
          symbolsMentioned: mentions,
          sentimentScore:   sentiment,
          rawPayload:       post.rawPayload ?? (post as unknown as object),
        },
        update: {},
      })
    } catch {
      // dupe or transient — ignore
    }
  }
}

let pollingTimer: ReturnType<typeof setInterval> | null = null

export const newsService = {
  async start() {
    const posts = await fetchAll()
    await ingestPosts(posts)
    logger.info(`[news] Initial ingest: ${posts.length} posts from ${FEEDS.length} feeds`)

    pollingTimer = setInterval(async () => {
      try {
        const fresh = await fetchAll()
        await ingestPosts(fresh)
        if (fresh.length > 0) {
          logger.debug(`[news] Polled ${fresh.length} posts`)
        }
      } catch (err) {
        logger.error({ err }, '[news] Poll error')
      }
    }, 2 * 60 * 1000)

    logger.info('[news] News service started (RSS, no API key needed)')
  },

  stop() {
    if (pollingTimer) clearInterval(pollingTimer)
  },
}
