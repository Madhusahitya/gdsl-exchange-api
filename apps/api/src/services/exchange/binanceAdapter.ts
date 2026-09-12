import crypto from 'crypto'
import { OrderSide, OrderType, TimeInForce } from '@cryptoflow/db'

/** Same as `strictExecutor` / `binance-executor`: override for Spot testnet keys (`https://testnet.binance.vision`). */
const BINANCE_BASE_URL = (process.env.BINANCE_BASE_URL ?? 'https://api.binance.com').replace(/\/$/, '')

function formatBinanceHttpError(status: number, body: string): string {
  let hint = ''
  try {
    const j = JSON.parse(body) as { code?: number; msg?: string }
    if (j.code === -2015) {
      hint =
        ' — Binance -2015: wrong API secret, key disabled, IP not whitelisted (add the "Outbound IP" from the Exchange page if you use IP restrictions), missing "Enable Reading", or this app is on MAINNET (`api.binance.com`) while the key is for TESTNET (set BINANCE_BASE_URL=https://testnet.binance.vision in apps/api `.env` and restart).'
    }
  } catch {
    /* body not JSON */
  }
  return `Binance request failed: ${status} ${body}${hint}`
}

type PlaceOrderInput = {
  apiKey: string
  apiSecret: string
  symbol: string
  side: OrderSide
  type: OrderType
  /** Base asset qty (MARKET SELL / MARKET BUY when not using quote) */
  quantity?: string
  /** Quote qty (USDT) for MARKET BUY — Binance prefers this for buy-with-USDT */
  quoteOrderQty?: string
  price?: string
  timeInForce?: TimeInForce
  clientOrderId: string
}

function signQuery(query: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(query).digest('hex')
}

async function signedRequest<T>(path: string, apiKey: string, apiSecret: string, params: URLSearchParams, method = 'GET'): Promise<T> {
  params.set('timestamp', String(Date.now()))
  params.set('recvWindow', '10000')
  const query = params.toString()
  const signature = signQuery(query, apiSecret)
  const url = `${BINANCE_BASE_URL}${path}?${query}&signature=${signature}`
  const response = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(formatBinanceHttpError(response.status, text))
  }
  return response.json() as Promise<T>
}

export class BinanceAdapter {
  async testConnection(apiKey: string, apiSecret: string) {
    return signedRequest('/api/v3/account', apiKey, apiSecret, new URLSearchParams())
  }

  async getBalances(apiKey: string, apiSecret: string) {
    const account = await signedRequest<{ balances: Array<{ asset: string; free: string; locked: string }> }>(
      '/api/v3/account',
      apiKey,
      apiSecret,
      new URLSearchParams()
    )
    return account.balances.filter((b) => Number(b.free) > 0 || Number(b.locked) > 0)
  }

  async placeOrder(input: PlaceOrderInput) {
    const params = new URLSearchParams({
      symbol: input.symbol,
      side: input.side,
      type: input.type === 'LIMIT' ? 'LIMIT' : 'MARKET',
      newClientOrderId: input.clientOrderId,
    })
    if (input.type === 'LIMIT') {
      params.set('timeInForce', input.timeInForce ?? 'GTC')
      if (!input.price) throw new Error('Price is required for LIMIT orders')
      params.set('price', input.price)
      if (!input.quantity) throw new Error('Quantity is required for LIMIT orders')
      params.set('quantity', input.quantity)
    } else {
      // MARKET: either quantity (base) or quoteOrderQty (quote, typically USDT for BUY)
      if (input.quoteOrderQty) {
        params.set('quoteOrderQty', input.quoteOrderQty)
      } else if (input.quantity) {
        params.set('quantity', input.quantity)
      } else {
        throw new Error('MARKET order requires quantity or quoteOrderQty')
      }
    }
    return signedRequest('/api/v3/order', input.apiKey, input.apiSecret, params, 'POST')
  }

  async cancelOrder(apiKey: string, apiSecret: string, symbol: string, orderId: string) {
    return signedRequest(
      '/api/v3/order',
      apiKey,
      apiSecret,
      new URLSearchParams({ symbol, orderId }),
      'DELETE'
    )
  }

  async getOrder(apiKey: string, apiSecret: string, symbol: string, orderId: string) {
    return signedRequest(
      '/api/v3/order',
      apiKey,
      apiSecret,
      new URLSearchParams({ symbol, orderId })
    )
  }
}

export const binanceAdapter = new BinanceAdapter()
