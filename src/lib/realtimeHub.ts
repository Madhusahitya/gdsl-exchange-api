import type { Server } from 'socket.io'
import { pubsub } from './pubsub'

/** Lets routes and background microservices emit Socket.IO events without importing index.ts */
let ioSingleton: Server | null = null

export function registerSocketIo(io: Server): void {
  ioSingleton = io
}

export type CrossContainerRoomPayload = {
  room: string
  event: string
  data: unknown
}

export type CrossContainerGlobalPayload = {
  event: string
  data: unknown
}

/**
 * Emit an event to a user's private room (`user:${userId}`).
 * Works seamlessly in monolith, multi-container Docker, and independent microservices.
 */
export function emitToUser(userId: string, event: string, data?: unknown): void {
  const room = `user:${userId}`
  if (ioSingleton) {
    ioSingleton.to(room).emit(event, data)
  } else {
    // Isolated container (tradingEngine, worker, etc.) — publish to Redis Pub/Sub
    pubsub.publish<CrossContainerRoomPayload>('socket:room-emit', { room, event, data })
  }
}

/**
 * Emit an event to all connected clients globally.
 * Works across all containers via Redis Pub/Sub.
 */
export function emitGlobal(event: string, data?: unknown): void {
  if (ioSingleton) {
    ioSingleton.emit(event, data)
  } else {
    pubsub.publish<CrossContainerGlobalPayload>('socket:global-emit', { event, data })
  }
}

/**
 * Smart Socket.IO accessor:
 * Returns the local Socket.IO Server if initialized in this process.
 * If running in a separate worker/trading microservice, returns a proxy that
 * transparently forwards `.to(room).emit(event, data)` and `.emit(event, data)`
 * to Redis Pub/Sub so notifications are NEVER silently lost across containers.
 */
export function getSocketIo(): Server | any {
  if (ioSingleton) return ioSingleton

  return {
    to: (room: string) => ({
      emit: (event: string, data?: unknown) => {
        pubsub.publish<CrossContainerRoomPayload>('socket:room-emit', { room, event, data })
      },
    }),
    emit: (event: string, data?: unknown) => {
      pubsub.publish<CrossContainerGlobalPayload>('socket:global-emit', { event, data })
    },
  }
}
