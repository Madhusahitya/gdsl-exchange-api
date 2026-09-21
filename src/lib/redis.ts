import { createClient, type RedisClientType } from 'redis'
import { env } from './env'
import { logger } from './logger'

let client: RedisClientType | null = null
let isConnected = false
let connectionAttempted = false

const resolvedRedisUrl = env.REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379'

export function isRedisAvailable(): boolean {
  return isConnected && client !== null
}

let connectPromise: Promise<RedisClientType | null> | null = null

export async function getRedisClient(): Promise<RedisClientType | null> {
  if (client && isConnected) return client
  if (connectPromise) return connectPromise

  connectPromise = (async () => {
    try {
      const c = createClient({
        url: resolvedRedisUrl,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 5) {
              logger.warn({ retries }, '[redis] Max reconnect attempts reached, disabling redis operations')
              isConnected = false
              return new Error('Redis max retries reached')
            }
            return Math.min(retries * 500, 3000)
          },
        },
      }) as RedisClientType

      c.on('error', (err) => {
        if (isConnected) {
          logger.warn({ err: err.message }, '[redis] Redis client error')
        }
        isConnected = false
      })

      c.on('ready', () => {
        isConnected = true
        logger.info({ url: resolvedRedisUrl }, '[redis] Connected and ready')
      })

      c.on('end', () => {
        isConnected = false
      })

      await c.connect()
      client = c
      isConnected = true
      return client
    } catch (err) {
      isConnected = false
      logger.info({ err: err instanceof Error ? err.message : String(err) }, '[redis] Redis connection fallback')
      return null
    } finally {
      connectPromise = null
    }
  })()

  return connectPromise
}

export async function createRedisDuplicate(): Promise<RedisClientType | null> {
  const primary = await getRedisClient()
  if (!primary) return null
  try {
    const duplicate = primary.duplicate() as RedisClientType
    duplicate.on('error', () => {
      /* ignore duplicate error logs */
    })
    await duplicate.connect()
    return duplicate
  } catch {
    return null
  }
}

/** Cache getter with graceful fallback to null on cache miss or Redis offline */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const c = await getRedisClient()
    if (!c || !isConnected) return null
    const raw = await c.get(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Cache setter with TTL in seconds */
export async function cacheSet(key: string, value: unknown, ttlSeconds = 60): Promise<void> {
  try {
    const c = await getRedisClient()
    if (!c || !isConnected) return
    await c.set(key, JSON.stringify(value), { EX: ttlSeconds })
  } catch {
    /* ignore caching errors */
  }
}

/** Cache invalidation helper */
export async function cacheDel(key: string): Promise<void> {
  try {
    const c = await getRedisClient()
    if (!c || !isConnected) return
    await c.del(key)
  } catch {
    /* ignore caching errors */
  }
}
