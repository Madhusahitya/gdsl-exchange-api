import crypto from 'crypto'
import { BinanceHttpError, withRetry } from './retry'
import type { ExecutorConfig } from './config'

function signQuery(query: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(query).digest('hex')
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  const method = init.method ?? 'GET'
  const pathOnly = url.split('?')[0] ?? url
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Binance HTTP timeout after ${timeoutMs}ms (${method} ${pathOnly})`, { cause: err })
    }
    if (err instanceof Error) {
      throw err
    }
    throw new Error(String(err), { cause: err })
  } finally {
    clearTimeout(t)
  }
}

export class BinanceHttpClient {
  constructor(private readonly cfg: ExecutorConfig) {}

  async publicGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const q = new URLSearchParams(params).toString()
    const url = `${this.cfg.baseUrl}${path}${q ? `?${q}` : ''}`
    return withRetry(
      `GET ${path}`,
      async () => {
        const res = await fetchWithTimeout(url, { method: 'GET' }, this.cfg.requestTimeoutMs)
        const text = await res.text()
        if (!res.ok) {
          throw new BinanceHttpError(`Binance ${path}: ${res.status} ${text}`, res.status, text)
        }
        return JSON.parse(text) as T
      },
      this.cfg.maxRetries,
      400
    )
  }

  async signedRequest<T>(path: string, params: URLSearchParams, method: 'GET' | 'POST' | 'DELETE' = 'GET'): Promise<T> {
    params.set('timestamp', String(Date.now()))
    params.set('recvWindow', '10000')
    const query = params.toString()
    const signature = signQuery(query, this.cfg.apiSecret)
    const url = `${this.cfg.baseUrl}${path}?${query}&signature=${signature}`

    return withRetry(
      `${method} ${path}`,
      async () => {
        const res = await fetchWithTimeout(
          url,
          {
            method,
            headers: { 'X-MBX-APIKEY': this.cfg.apiKey },
          },
          this.cfg.requestTimeoutMs
        )
        const text = await res.text()
        if (!res.ok) {
          throw new BinanceHttpError(`Binance ${path}: ${res.status} ${text}`, res.status, text)
        }
        return JSON.parse(text) as T
      },
      this.cfg.maxRetries,
      400
    )
  }
}
