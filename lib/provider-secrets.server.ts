import 'server-only'

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface EncryptedProviderSecret {
  ciphertext: string
  iv: string
  tag: string
  version: 1
}

function decodeConfiguredKey(value: string): Buffer {
  const trimmed = value.trim()
  const key = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64')
  if (key.length !== 32) throw new Error('OPENLINK_PROVIDER_SECRET_KEY must decode to exactly 32 bytes')
  return key
}

function encryptionKey(): Buffer {
  const configured = process.env.OPENLINK_PROVIDER_SECRET_KEY
  if (configured) return decodeConfiguredKey(configured)

  // Local full-stack development already creates a high-entropy Agent Host
  // token and passes it only to server processes. Deriving a separate key
  // keeps local setup zero-config without introducing a checked-in secret.
  if (process.env.NODE_ENV !== 'production' && process.env.OPENLINK_AGENT_API_TOKEN) {
    return createHash('sha256')
      .update('openlink/provider-settings/v1\0')
      .update(process.env.OPENLINK_AGENT_API_TOKEN)
      .digest()
  }

  throw new Error('OPENLINK_PROVIDER_SECRET_KEY is required to store AI provider credentials')
}

function associatedData(userId: string, providerId: string) {
  return Buffer.from(`openlink:provider:${userId}:${providerId}:v1`, 'utf8')
}

export function encryptProviderSecret(secret: string, userId: string, providerId: string): EncryptedProviderSecret {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(associatedData(userId, providerId))
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    version: 1,
  }
}

export function decryptProviderSecret(
  encrypted: Pick<EncryptedProviderSecret, 'ciphertext' | 'iv' | 'tag' | 'version'>,
  userId: string,
  providerId: string,
) {
  if (encrypted.version !== 1) throw new Error('Unsupported provider secret encryption version')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(encrypted.iv, 'base64'))
  decipher.setAAD(associatedData(userId, providerId))
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function providerSecretHint(secret: string) {
  const suffix = secret.slice(-4)
  return suffix ? `••••${suffix}` : '••••'
}
