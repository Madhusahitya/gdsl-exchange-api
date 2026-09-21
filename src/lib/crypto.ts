import crypto from 'crypto'
import { env } from './env'

const IV_LENGTH = 12

function getKey(): Buffer {
  const raw = env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY is required')
  if (raw.length === 64) return Buffer.from(raw, 'hex')
  return crypto.createHash('sha256').update(raw).digest()
}

export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, encryptedHex] = payload.split(':')
  if (!ivHex || !tagHex || !encryptedHex) throw new Error('Invalid encrypted payload')
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const plain = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()])
  return plain.toString('utf8')
}
