/**
 * Council voter: LLM Strategist (LLM_trader-inspired).
 * Sends a compact market-context JSON to an LLM and expects a structured
 * {vote, confidence, reason} back. Provider fallback chain: Claude (Anthropic)
 * → Gemini → OpenRouter → OpenAI. Fail-soft: with no key configured (or on any
 * error / timeout) the agent reports "offline" and the council votes without it.
 *
 * Claim validation (LLM_trader): the returned confidence is clamped and the
 * vote is only accepted verbatim — free-text numeric claims are ignored in
 * favor of our own computed indicators.
 */
import { logger } from '../../lib/logger'
import type { AgentVote } from './technicalAgent'

export type LlmContext = {
  symbol: string
  priceUsd: number
  change5mPct: number
  change1hPct: number
  change24hPct: number
  liquidityUsd: number
  volume24hUsd: number
  momentumScore: number
  rsi14: number | null
  emaCrossBull: boolean | null
  trendStrength: number
  newsSentiment: number | null
  solSpreadBps: number | null
  orderBookImbalance: number | null
  recentWinRatePct: number | null
  /** Multi-timeframe / 1-year summary from the candle store, when available. */
  marketContext?: string | null
}

export type LlmVote = AgentVote & {
  provider: string | null
  latencyMs: number | null
}

const OFFLINE: LlmVote = {
  vote: 'HOLD',
  confidence: 0,
  reason: 'LLM offline — no provider key configured',
  provider: null,
  latencyMs: null,
}

const SYSTEM_PROMPT = `You are a disciplined crypto risk strategist targeting a 65-70% win rate. You receive a JSON snapshot of a candidate momentum trade. Reply ONLY with minified JSON: {"vote":"BUY"|"HOLD"|"AVOID","confidence":0.0-1.0,"reason":"<max 120 chars>"}. Vote BUY only when momentum, trend and liquidity align and nothing in the data suggests a blow-off top or thin market. Prefer HOLD when uncertain. Vote AVOID on overextension (e.g. >40% daily pump), weak liquidity, or negative sentiment.

When "marketContext" is present it summarises up to a year of stored candles across the 1d/4h/1h/15m timeframes. Weigh it heavily: an entry that fights the higher-timeframe trend needs materially stronger short-term evidence, while an entry aligned with a healthy longer-term uptrend can carry more confidence. Treat a position near 52-week highs in a confirmed uptrend as a breakout rather than automatic overextension, but stay cautious when annualised volatility is extreme.`

function parseVote(raw: string, provider: string, latencyMs: number): LlmVote | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0]) as { vote?: string; confidence?: number; reason?: string }
    const vote = parsed.vote === 'BUY' || parsed.vote === 'AVOID' ? parsed.vote : 'HOLD'
    const confidence = Math.min(0.95, Math.max(0, Number(parsed.confidence) || 0.5))
    return {
      vote,
      confidence,
      reason: String(parsed.reason ?? '').slice(0, 160) || 'No rationale given',
      provider,
      latencyMs,
    }
  } catch {
    return null
  }
}

async function callWithTimeout(url: string, init: RequestInit, timeoutMs = 9000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

async function callAnthropic(key: string, ctx: LlmContext): Promise<LlmVote | null> {
  const model = process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-5'
  const started = Date.now()
  const res = await callWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 150,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Market snapshot:\n${JSON.stringify(ctx)}` }],
    }),
  })
  if (!res.ok) {
    logger.debug({ status: res.status, model }, '[llm-strategist] anthropic call failed')
    return null
  }
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
  const text = data.content?.find((c) => c.type === 'text')?.text ?? data.content?.[0]?.text ?? ''
  return parseVote(text, `anthropic:${model}`, Date.now() - started)
}

async function callGemini(key: string, ctx: LlmContext): Promise<LlmVote | null> {
  const started = Date.now()
  const res = await callWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nMarket snapshot:\n${JSON.stringify(ctx)}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 120 },
      }),
    },
  )
  if (!res.ok) return null
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  return parseVote(text, 'gemini-2.0-flash', Date.now() - started)
}

async function callOpenAiCompatible(
  baseUrl: string,
  key: string,
  model: string,
  providerLabel: string,
  ctx: LlmContext,
): Promise<LlmVote | null> {
  const started = Date.now()
  const res = await callWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 120,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Market snapshot:\n${JSON.stringify(ctx)}` },
      ],
    }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content ?? ''
  return parseVote(text, providerLabel, Date.now() - started)
}

export function isLlmConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.GEMINI_API_KEY?.trim() ||
      process.env.OPENROUTER_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim(),
  )
}

export async function llmStrategistVote(ctx: LlmContext): Promise<LlmVote> {
  const anthropic = process.env.ANTHROPIC_API_KEY?.trim()
  const gemini = process.env.GEMINI_API_KEY?.trim()
  const openrouter = process.env.OPENROUTER_API_KEY?.trim()
  const openai = process.env.OPENAI_API_KEY?.trim()
  if (!anthropic && !gemini && !openrouter && !openai) return OFFLINE

  try {
    if (anthropic) {
      const v = await callAnthropic(anthropic, ctx)
      if (v) return v
    }
    if (gemini) {
      const v = await callGemini(gemini, ctx)
      if (v) return v
    }
    if (openrouter) {
      const model = process.env.OPENROUTER_MODEL?.trim() || 'google/gemini-2.0-flash-001'
      const v = await callOpenAiCompatible('https://openrouter.ai/api/v1', openrouter, model, `openrouter:${model}`, ctx)
      if (v) return v
    }
    if (openai) {
      const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini'
      const v = await callOpenAiCompatible('https://api.openai.com/v1', openai, model, `openai:${model}`, ctx)
      if (v) return v
    }
  } catch (err) {
    logger.debug({ err }, '[llm-strategist] provider call failed')
  }
  return { ...OFFLINE, reason: 'LLM providers unavailable (timeout/error) — council voting without it' }
}
