/**
 * Transport-agnostic Pub/Sub for real-time event broadcasting.
 *
 * Automatically connects to Redis if available for multi-instance deployments,
 * with seamless fallback to in-process EventEmitter when Redis is not running.
 *
 * Usage:
 *   pubsub.publish('jupiter:overview', payload)
 *   pubsub.subscribe('jupiter:overview', handler)
 */
import EventEmitter from 'events'
import { getRedisClient, createRedisDuplicate } from './redis'
import { logger } from './logger'

export interface PubSubProvider {
  publish<T>(channel: string, data: T): void
  subscribe<T>(channel: string, handler: (data: T) => void): void
  unsubscribe<T>(channel: string, handler: (data: T) => void): void
  init(): Promise<void>
}

class AutoPubSub implements PubSubProvider {
  private localEmitter = new EventEmitter()
  private redisSubscribedChannels = new Set<string>()
  private isRedisActive = false

  constructor() {
    this.localEmitter.setMaxListeners(100)
    void this.init()
  }

  async init(): Promise<void> {
    try {
      const pubClient = await getRedisClient()
      if (!pubClient) {
        this.isRedisActive = false
        return
      }
      const subClient = await createRedisDuplicate()
      if (!subClient) {
        this.isRedisActive = false
        return
      }

      this.isRedisActive = true
      logger.info('[pubsub] Redis Pub/Sub activated')

      // Re-subscribe to channels if any were registered before connection completed
      for (const channel of this.redisSubscribedChannels) {
        void subClient.subscribe(channel, (message) => {
          try {
            const parsed = JSON.parse(message)
            this.localEmitter.emit(channel, parsed)
          } catch {
            this.localEmitter.emit(channel, message)
          }
        })
      }
    } catch {
      this.isRedisActive = false
    }
  }

  publish<T>(channel: string, data: T): void {
    // Always emit locally for in-process subscribers
    this.localEmitter.emit(channel, data)

    // Also publish to Redis for other processes/containers if Redis is ready
    if (this.isRedisActive) {
      void getRedisClient().then((c) => {
        if (!c) return
        try {
          const payload = typeof data === 'string' ? data : JSON.stringify(data)
          void c.publish(channel, payload)
        } catch {
          /* ignore transient publish errors */
        }
      })
    }
  }

  subscribe<T>(channel: string, handler: (data: T) => void): void {
    this.localEmitter.on(channel, handler)

    if (!this.redisSubscribedChannels.has(channel)) {
      this.redisSubscribedChannels.add(channel)
      if (this.isRedisActive) {
        void createRedisDuplicate().then((sub) => {
          if (!sub) return
          void sub.subscribe(channel, (message) => {
            try {
              const parsed = JSON.parse(message)
              this.localEmitter.emit(channel, parsed)
            } catch {
              this.localEmitter.emit(channel, message)
            }
          })
        })
      }
    }
  }

  unsubscribe<T>(channel: string, handler: (data: T) => void): void {
    this.localEmitter.off(channel, handler)
  }
}

export const pubsub: PubSubProvider = new AutoPubSub()
