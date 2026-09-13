import { NextFunction, Request, Response } from 'express'
import { z } from 'zod'

export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const payload = req.method === 'GET' ? req.query : req.body
    const result = schema.safeParse(payload)
    if (!result.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      })
      return
    }
    ;(req as Request & { validated?: unknown }).validated = result.data
    next()
  }
}
