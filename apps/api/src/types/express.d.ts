import { AuthPayload } from '../middleware/authenticateToken'

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
      validated?: unknown
    }
  }
}

export {}
