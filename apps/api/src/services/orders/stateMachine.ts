import { OrderStatus } from '@cryptoflow/db'

const transitions: Record<OrderStatus, OrderStatus[]> = {
  /** Binance MARKET orders often skip NEW and return FILLED / PARTIALLY_FILLED on the create response. */
  PENDING_SUBMIT: ['NEW', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELED'],
  NEW: ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'],
  PARTIALLY_FILLED: ['FILLED', 'CANCELED', 'EXPIRED'],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
}

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  return transitions[from].includes(to)
}
