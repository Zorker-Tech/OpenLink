import 'server-only'

import { createHash, randomBytes, webcrypto } from 'node:crypto'
import type { Session } from '@supabase/supabase-js'

const GRANT_VERSION = 1
const GRANT_TTL_MS = 90_000
const MAX_GRANT_LENGTH = 8_192

export const crossAppStateCookie = 'openlink-cross-app-state'

interface CrossAppGrant {
  accessToken: string
  audience: 'openlink' | 'zorker'
  expiresAt: number
  refreshToken: string
  version: number
}

function getOrigin(value: string, name: string) {
  const url = new URL(value)
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'

  if (url.protocol !== 'https:' && !isLocal) {
    throw new Error(`${name} must use HTTPS outside local development.`)
  }

  return url.origin
}

function requireEnv(name: 'CROSS_APP_AUTH_SECRET' | 'OPENLINK_APP_URL' | 'ZORKER_APP_URL') {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required configuration: ${name}`)
  return value
}

function getSecret() {
  const secret = requireEnv('CROSS_APP_AUTH_SECRET')
  if (secret.length < 32) throw new Error('CROSS_APP_AUTH_SECRET must contain at least 32 characters.')
  return secret
}

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array) {
  return Buffer.from(bytes instanceof Uint8Array ? toArrayBuffer(bytes) : bytes).toString('base64url')
}

function fromBase64Url(value: string) {
  return Buffer.from(value, 'base64url')
}

async function getEncryptionKey() {
  const hash = createHash('sha256').update(getSecret()).digest()
  return webcrypto.subtle.importKey('raw', toArrayBuffer(hash), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export function getOpenLinkOrigin() {
  return getOrigin(requireEnv('OPENLINK_APP_URL'), 'OPENLINK_APP_URL')
}

export function getZorkerOrigin() {
  return getOrigin(requireEnv('ZORKER_APP_URL'), 'ZORKER_APP_URL')
}

export function getZorkerOrigins() {
  const configuredOrigin = getZorkerOrigin()
  if (process.env.NODE_ENV === 'production') return [configuredOrigin]

  // The standalone Zorker Console preview uses 3004 while the legacy local
  // workspace may still use 3002. Keep both explicit and development-only.
  return [...new Set([configuredOrigin, 'http://127.0.0.1:3004', 'http://localhost:3004'])]
}

export function getZorkerOriginForContinuation(value: string | null) {
  if (!value) return getZorkerOrigin()

  try {
    const origin = new URL(value).origin
    return getZorkerOrigins().includes(origin) ? origin : getZorkerOrigin()
  } catch {
    return getZorkerOrigin()
  }
}

export function safeInternalPath(value: string | null | undefined, fallback = '/app') {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : fallback
}

export function createCrossAppState() {
  return randomBytes(32).toString('base64url')
}

export function stateCookieOptions() {
  return {
    httpOnly: true,
    maxAge: 5 * 60,
    path: '/auth/sso/callback',
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
  }
}

export function validatePeerCallback(value: string | null, peerOrigin: string | string[]) {
  if (!value || value.length > 4_096) return null
  try {
    const url = new URL(value)
    const state = url.searchParams.get('state')
    const allowedOrigins = Array.isArray(peerOrigin) ? peerOrigin : [peerOrigin]
    if (!allowedOrigins.includes(url.origin) || url.pathname !== '/auth/sso/callback' || !state || state.length < 32) return null
    return url
  } catch {
    return null
  }
}

export function validateContinuation(value: string | null, sourceOrigin: string | string[]) {
  if (!value || value.length > 2_048) return null
  try {
    const url = new URL(value)
    const allowedOrigins = Array.isArray(sourceOrigin) ? sourceOrigin : [sourceOrigin]
    return allowedOrigins.includes(url.origin) ? url : null
  } catch {
    return null
  }
}

export async function sealCrossAppSession(session: Session) {
  const payload: CrossAppGrant = {
    accessToken: session.access_token,
    audience: 'zorker',
    expiresAt: Date.now() + GRANT_TTL_MS,
    refreshToken: session.refresh_token,
    version: GRANT_VERSION,
  }
  const iv = randomBytes(12)
  const encrypted = await webcrypto.subtle.encrypt(
    { iv: toArrayBuffer(iv), name: 'AES-GCM' },
    await getEncryptionKey(),
    toArrayBuffer(Buffer.from(JSON.stringify(payload), 'utf8')),
  )
  return `${toBase64Url(iv)}.${toBase64Url(encrypted)}`
}

export async function openCrossAppSession(grant: string | null) {
  if (!grant || grant.length > MAX_GRANT_LENGTH) return null
  const [encodedIv, encodedPayload, ...rest] = grant.split('.')
  if (!encodedIv || !encodedPayload || rest.length) return null

  try {
    const decrypted = await webcrypto.subtle.decrypt(
      { iv: toArrayBuffer(fromBase64Url(encodedIv)), name: 'AES-GCM' },
      await getEncryptionKey(),
      toArrayBuffer(fromBase64Url(encodedPayload)),
    )
    const payload = JSON.parse(Buffer.from(decrypted).toString('utf8')) as Partial<CrossAppGrant>
    if (
      payload.version !== GRANT_VERSION
      || payload.audience !== 'openlink'
      || typeof payload.expiresAt !== 'number'
      || payload.expiresAt < Date.now()
      || typeof payload.accessToken !== 'string'
      || typeof payload.refreshToken !== 'string'
      || !payload.accessToken
      || !payload.refreshToken
    ) return null

    return { accessToken: payload.accessToken, refreshToken: payload.refreshToken }
  } catch {
    return null
  }
}
