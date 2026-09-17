/**
 * Transport-agnostic Pub/Sub for real-time event broadcasting.
 *
 * Default: in-process EventEmitter (single instance, zero infra).
 * Scale:   swap to RedisPubSub or KafkaPubSub for multi-instance deployments.
 *
 * Usage:
 *   pubsub.publish('jupiter:overview', payload)
 *   pubsub.subscribe('jupiter:overview', handler)
 */
import EventEmitter from 'events'

// ── Interface ────────────────────────────────────────────────────────

export interface PubSubProvider {
  publish<T>(channel: string, data: T): void
  subscribe<T>(channel: string, handler: (data: T) => void): void
  unsubscribe<T>(channel: string, handler: (data: T) => void): void
}

// ── In-process implementation (single Node.js instance) ──────────────

class InProcessPubSub implements PubSubProvider {
  private emitter = new EventEmitter()

  constructor() {
    // Enough headroom for multiple channels + multiple subscribers per channel
    this.emitter.setMaxListeners(50)
  }

  publish<T>(channel: string, data: T): void {
    this.emitter.emit(channel, data)
  }

  subscribe<T>(channel: string, handler: (data: T) => void): void {
    this.emitter.on(channel, handler)
  }

  unsubscribe<T>(channel: string, handler: (data: T) => void): void {
    this.emitter.off(channel, handler)
  }
}

// ── Future: Redis implementation (uncomment when scaling) ────────────
//
// import { createClient, type RedisClientType } from 'redis'
//
// class RedisPubSub implements PubSubProvider {
//   private pub: RedisClientType
//   private sub: RedisClientType
//   private handlers = new Map<string, Set<(data: unknown) => void>>()
//
//   constructor(redisUrl: string) {
//     this.pub = createClient({ url: redisUrl })
//     this.sub = this.pub.duplicate()
//     void this.pub.connect()
//     void this.sub.connect()
//   }
//
//   publish<T>(channel: string, data: T): void {
//     void this.pub.publish(channel, JSON.stringify(data))
//   }
//
//   subscribe<T>(channel: string, handler: (data: T) => void): void {
//     if (!this.handlers.has(channel)) {
//       this.handlers.set(channel, new Set())
//       void this.sub.subscribe(channel, (message) => {
//         const parsed = JSON.parse(message)
//         for (const h of this.handlers.get(channel) ?? []) h(parsed)
//       })
//     }
//     this.handlers.get(channel)!.add(handler as (data: unknown) => void)
//   }
//
//   unsubscribe<T>(channel: string, handler: (data: T) => void): void {
//     this.handlers.get(channel)?.delete(handler as (data: unknown) => void)
//   }
// }

// ── Singleton — swap InProcessPubSub → RedisPubSub here when needed ──

export const pubsub: PubSubProvider = new InProcessPubSub()
