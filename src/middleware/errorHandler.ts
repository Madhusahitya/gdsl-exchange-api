import { NextFunction, Request, Response } from 'express'
import { logger } from '../lib/logger'
import { env } from '../lib/env'

export class AppError extends Error {
  constructor(public statusCode: number, public override message: string, public code?: string) {
    super(message)
  }
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  logger.error({
    message: err?.message,
    stack: err?.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.userId,
  })

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code })
    return
  }

  if (err?.code === 'P2002') {
    res.status(409).json({ error: 'Resource already exists' })
    return
  }
  if (err?.code === 'P2025') {
    res.status(404).json({ error: 'Resource not found' })
    return
  }

  if (err?.name === 'JsonWebTokenError') {
    res.status(401).json({ error: 'Invalid token' })
    return
  }
  if (err?.name === 'TokenExpiredError') {
    res.status(401).json({ error: 'Token expired' })
    return
  }

  if (env.NODE_ENV === 'production') {
    logger.fatal({
      message: err?.message,
      stack: err?.stack,
      path: req.path,
      method: req.method,
      userId: req.user?.userId,
    }, 'Unhandled server error')
  }

  res.status(500).json({
    error: env.NODE_ENV === 'production' ? 'Internal server error' : err?.message || 'Internal server error',
  })
}
