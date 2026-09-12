/** Multi-agent event bus — PDF architecture adapted to in-process Node */

export type AgentId = 'oracle' | 'quant' | 'risk' | 'executioner'

export type StreamName =
  | 'sentiment:update'
  | 'market:tick'
  | 'risk:signal'
  | 'trade:result'
  | 'agent:heartbeat'

export type AgentEvent<T = unknown> = {
  agentId: AgentId
  stream: StreamName
  payload: T
  ts: number
  ttlMs?: number
}

type CacheEntry = { data: unknown; expiresAt: number }

class AgentBus {
  private listeners = new Map<StreamName, Set<(e: AgentEvent) => void>>()
  private cache = new Map<string, CacheEntry>()

  subscribe(stream: StreamName, handler: (e: AgentEvent) => void): () => void {
    if (!this.listeners.has(stream)) this.listeners.set(stream, new Set())
    this.listeners.get(stream)!.add(handler)
    return () => this.listeners.get(stream)?.delete(handler)
  }

  publish<T>(event: AgentEvent<T>): void {
    if (event.ttlMs && event.ttlMs > 0) {
      const key = `${event.stream}:${event.agentId}`
      this.cache.set(key, { data: event.payload, expiresAt: Date.now() + event.ttlMs })
    }
    const handlers = this.listeners.get(event.stream)
    if (handlers) {
      for (const h of handlers) {
        try {
          h(event as AgentEvent)
        } catch {
          // isolate handler failures
        }
      }
    }
  }

  getCached<T>(stream: StreamName, agentId: AgentId): T | null {
    const key = `${stream}:${agentId}`
    const entry = this.cache.get(key)
    if (!entry || entry.expiresAt < Date.now()) {
      this.cache.delete(key)
      return null
    }
    return entry.data as T
  }

  prune(): void {
    const now = Date.now()
    for (const [k, v] of this.cache) {
      if (v.expiresAt < now) this.cache.delete(k)
    }
  }
}

export const agentBus = new AgentBus()

export type AgentHealth = {
  agentId: AgentId
  status: 'running' | 'idle' | 'error'
  lastTickAt: string | null
  lastError: string | null
  ticks: number
}

export const agentHealth: Record<AgentId, AgentHealth> = {
  oracle: { agentId: 'oracle', status: 'idle', lastTickAt: null, lastError: null, ticks: 0 },
  quant: { agentId: 'quant', status: 'idle', lastTickAt: null, lastError: null, ticks: 0 },
  risk: { agentId: 'risk', status: 'idle', lastTickAt: null, lastError: null, ticks: 0 },
  executioner: { agentId: 'executioner', status: 'idle', lastTickAt: null, lastError: null, ticks: 0 },
}

export function markAgentTick(id: AgentId, err?: string): void {
  const h = agentHealth[id]
  h.ticks += 1
  h.lastTickAt = new Date().toISOString()
  if (err) {
    h.status = 'error'
    h.lastError = err
  } else {
    h.status = 'running'
    h.lastError = null
  }
}
