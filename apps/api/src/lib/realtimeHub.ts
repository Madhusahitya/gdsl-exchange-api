import type { Server } from 'socket.io'

/** Lets routes emit Socket.IO events without importing `index.ts`. */
let ioSingleton: Server | null = null

export function registerSocketIo(io: Server): void {
  ioSingleton = io
}

export function getSocketIo(): Server | null {
  return ioSingleton
}
