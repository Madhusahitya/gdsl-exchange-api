/**
 * walletCrypto — AES-256-GCM helpers used to encrypt personal-wallet private keys
 * before they are written to the database.
 *
 * Format on disk: base64(iv (12 bytes) || authTag (16 bytes) || ciphertext)
 *
 * The encryption key is sourced from `WALLET_ENCRYPTION_KEY`. Operators
 * should provide a 64-hex-character (32 byte) value; if they instead pass
 * a passphrase we derive a deterministic 32-byte key via SHA-256 so the
 * service still starts in dev environments.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { env } from './env'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

let cachedKey: Buffer | null = null

function getKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = env.WALLET_ENCRYPTION_KEY?.trim()
  if (!raw) {
    throw new Error(
      'WALLET_ENCRYPTION_KEY is not set. Add a 64 hex-char (32 byte) value to your environment to enable personal wallets.',
    )
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex')
  } else {
    // Dev convenience: derive a 32-byte key from any passphrase.
    cachedKey = createHash('sha256').update(raw).digest()
  }
  return cachedKey
}

/** Returns true when an encryption key is available (and decryption can succeed). */
export function isWalletCryptoConfigured(): boolean {
  return Boolean(env.WALLET_ENCRYPTION_KEY?.trim())
}

export function encryptSecret(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

export function decryptSecret(payload: string): string {
  const key = getKey()
  const buf = Buffer.from(payload, 'base64')
  if (buf.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('walletCrypto: ciphertext too short')
  }
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES)
  const dec = createDecipheriv(ALGO, key, iv)
  dec.setAuthTag(tag)
  return Buffer.concat([dec.update(ciphertext), dec.final()]).toString('utf8')
}
