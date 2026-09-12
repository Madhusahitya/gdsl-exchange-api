import crypto from 'crypto'

const BASE = process.env.BINANCE_BASE_URL || 'https://api.binance.com'

export type TradeError = {
  type: 'VALIDATION_ERROR' | 'BINANCE_ERROR' | 'NETWORK_ERROR'
  code?: number
  reason?: string
  message: string
}

export type TradeResult =
  | { ok: true; orderId: string; symbol: string; side: string; executedQty: string; cummulativeQuoteQty: string; status: string }
  | { ok: false; error: TradeError }

export type SymbolFilters = {
  minQty: number
  maxQty: number
  stepSize: number
  minNotional: number
}

type BinanceBalance = { asset: string; free: string; locked: string }
type BinanceSymbol = { symbol: string; status: string; filters: Array<Record<string, string>> }

function sign(query: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(query).digest('hex')
}

async function signedGet<T>(path: string, params = new URLSearchParams()): Promise<T> {
  const key = process.env.BINANCE_API_KEY!
  const secret = process.env.BINANCE_API_SECRET!
  params.set('timestamp', String(Date.now()))
  params.set('recvWindow', '10000')
  const q = params.toString()
  const url = `${BASE}${path}?${q}&signature=${sign(q, secret)}`
  const res = await fetch(url, { headers: { 'X-MBX-APIKEY': key } })
  if (!res.ok) {
    const text = await res.text()
    throw parseApiError(res.status, text)
  }
  return res.json() as Promise<T>
}

async function signedPost<T>(path: string, params: URLSearchParams): Promise<T> {
  const key = process.env.BINANCE_API_KEY!
  const secret = process.env.BINANCE_API_SECRET!
  params.set('timestamp', String(Date.now()))
  params.set('recvWindow', '10000')
  const q = params.toString()
  const url = `${BASE}${path}?${q}&signature=${sign(q, secret)}`
  const res = await fetch(url, { method: 'POST', headers: { 'X-MBX-APIKEY': key } })
  if (!res.ok) {
    const text = await res.text()
    throw parseApiError(res.status, text)
  }
  return res.json() as Promise<T>
}

function parseApiError(status: number, body: string): TradeError {
  let code = 0
  let msg = body
  try {
    const j = JSON.parse(body)
    code = j.code ?? 0
    msg = j.msg ?? body
  } catch { /* raw text */ }

  const map: Record<number, { reason: string; message: string }> = {
    [-1013]: { reason: 'MIN_NOTIONAL', message: `Trade rejected: minimum notional not met. ${msg}` },
    [-2010]: { reason: 'INSUFFICIENT_BALANCE', message: `Insufficient balance on Binance. ${msg}` },
    [-1022]: { reason: 'SIGNATURE_ERROR', message: 'API signature invalid — check BINANCE_API_SECRET.' },
    [-2015]: {
      reason: 'INVALID_API_KEY',
      message:
        'Binance rejected the API key (-2015): wrong secret, IP whitelist, disabled key, or testnet vs mainnet (set BINANCE_BASE_URL=https://testnet.binance.vision for Spot testnet).',
    },
    [-1111]: { reason: 'PRECISION', message: `Precision error: ${msg}` },
    [-1021]: { reason: 'TIMESTAMP', message: 'Timestamp out of sync — check system clock.' },
  }

  const mapped = map[code]
  if (mapped) return { type: 'BINANCE_ERROR', code, reason: mapped.reason, message: mapped.message }
  return { type: 'BINANCE_ERROR', code, reason: 'UNKNOWN', message: `Binance error ${code}: ${msg}` }
}

export async function getBalance(asset: string): Promise<number> {
  const acct = await signedGet<{ balances: BinanceBalance[] }>('/api/v3/account')
  const b = acct.balances.find((x) => x.asset === asset)
  return b ? parseFloat(b.free) : 0
}

export async function getPrice(symbol: string): Promise<number> {
  const res = await fetch(`${BASE}/api/v3/ticker/price?symbol=${symbol}`)
  const j = (await res.json()) as { price?: string }
  return parseFloat(j.price ?? '0')
}

export async function getSymbolInfo(symbol: string): Promise<SymbolFilters> {
  const res = await fetch(`${BASE}/api/v3/exchangeInfo?symbol=${symbol}`)
  const j = (await res.json()) as { symbols?: BinanceSymbol[] }
  const sym = j.symbols?.[0]
  if (!sym) throw { type: 'VALIDATION_ERROR', message: `Symbol ${symbol} not found on Binance` } as TradeError

  let minQty = 0, maxQty = 999999, stepSize = 0.00001, minNotional = 10
  for (const f of sym.filters) {
    if (f.filterType === 'LOT_SIZE') {
      minQty = parseFloat(f.minQty ?? '0')
      maxQty = parseFloat(f.maxQty ?? '999999')
      stepSize = parseFloat(f.stepSize ?? '0.00001')
    }
    if (f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') {
      minNotional = parseFloat(f.minNotional ?? '10')
    }
  }
  return { minQty, maxQty, stepSize, minNotional }
}

function roundToStep(qty: number, step: number): number {
  if (step <= 0) return qty
  const precision = Math.max(0, Math.ceil(-Math.log10(step)))
  return parseFloat((Math.floor(qty / step) * step).toFixed(precision))
}

export function validateOrder(
  qty: number,
  price: number,
  filters: SymbolFilters,
): TradeError | null {
  if (qty < filters.minQty) {
    return { type: 'VALIDATION_ERROR', reason: 'LOT_SIZE', message: `Quantity ${qty} is below minimum ${filters.minQty}` }
  }
  if (qty > filters.maxQty) {
    return { type: 'VALIDATION_ERROR', reason: 'LOT_SIZE', message: `Quantity ${qty} exceeds maximum ${filters.maxQty}` }
  }
  const notional = qty * price
  if (notional < filters.minNotional) {
    return { type: 'VALIDATION_ERROR', reason: 'MIN_NOTIONAL', message: `Notional $${notional.toFixed(2)} is below minimum $${filters.minNotional}` }
  }
  return null
}

export async function placeMarketOrder(
  symbol: string,
  side: 'BUY' | 'SELL',
  quoteQtyUsdt?: number,
  baseQty?: number,
): Promise<TradeResult> {
  const params = new URLSearchParams({ symbol, side, type: 'MARKET' })

  if (side === 'BUY' && quoteQtyUsdt) {
    params.set('quoteOrderQty', String(Math.floor(quoteQtyUsdt * 100) / 100))
  } else if (baseQty) {
    const filters = await getSymbolInfo(symbol)
    const rounded = roundToStep(baseQty, filters.stepSize)
    const price = await getPrice(symbol)
    const err = validateOrder(rounded, price, filters)
    if (err) return { ok: false, error: err }
    params.set('quantity', String(rounded))
  } else {
    return { ok: false, error: { type: 'VALIDATION_ERROR', message: 'No quantity provided for order' } }
  }

  try {
    const result = await signedPost<{
      orderId: number
      symbol: string
      side: string
      executedQty: string
      cummulativeQuoteQty: string
      status: string
    }>('/api/v3/order', params)

    return {
      ok: true,
      orderId: String(result.orderId),
      symbol: result.symbol,
      side: result.side,
      executedQty: result.executedQty,
      cummulativeQuoteQty: result.cummulativeQuoteQty,
      status: result.status,
    }
  } catch (e) {
    if ((e as TradeError).type) return { ok: false, error: e as TradeError }
    return { ok: false, error: { type: 'NETWORK_ERROR', message: String(e) } }
  }
}
