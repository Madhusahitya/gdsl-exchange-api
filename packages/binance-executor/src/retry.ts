export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number
): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const retryable = isRetryableError(e)
      if (!retryable || attempt === maxAttempts) {
        throw wrapError(label, e, attempt)
      }
      const delay = baseDelayMs * 2 ** (attempt - 1)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw wrapError(label, last, maxAttempts)
}

function isRetryableError(e: unknown): boolean {
  if (e instanceof BinanceHttpError) {
    if (e.status === 429 || e.status === 418) return true
    if (e.status >= 500) return true
    return false
  }
  if (e instanceof Error) {
    const m = e.message.toLowerCase()
    if (m.includes('fetch failed') || m.includes('network') || m.includes('econnreset')) return true
    if (m.includes('aborted') || m.includes('timeout')) return true
  }
  return false
}

function wrapError(label: string, e: unknown, attempt: number): Error {
  if (e instanceof Error) {
    e.message = `[${label}] attempt ${attempt}: ${e.message}`
    return e
  }
  return new Error(`[${label}] attempt ${attempt}: ${String(e)}`)
}

export class BinanceHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message)
    this.name = 'BinanceHttpError'
  }
}
