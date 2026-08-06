import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { BROWSER_PROTOCOL_VERSION } from '@openlink/browser-protocol'
import { BrowserHostError } from './errors.js'

export type BrowserCapabilityScope = 'events' | 'preview' | 'control'

export interface BrowserCapabilityClaims {
  version: typeof BROWSER_PROTOCOL_VERSION
  sessionId: string
  ownerId: string
  scopes: BrowserCapabilityScope[]
  actors: Array<'human' | 'agent'>
  issuedAt: number
  expiresAt: number
  nonce: string
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new BrowserHostError('INVALID_TOKEN', 'Capability token is malformed', 401)
  }
}

function isClaims(value: unknown): value is BrowserCapabilityClaims {
  if (typeof value !== 'object' || value === null) return false
  const claims = value as Partial<BrowserCapabilityClaims>
  return claims.version === BROWSER_PROTOCOL_VERSION
    && typeof claims.sessionId === 'string'
    && typeof claims.ownerId === 'string'
    && Array.isArray(claims.scopes)
    && claims.scopes.every((scope) => scope === 'events' || scope === 'preview' || scope === 'control')
    && Array.isArray(claims.actors)
    && claims.actors.every((actor) => actor === 'human' || actor === 'agent')
    && Number.isSafeInteger(claims.issuedAt)
    && Number.isSafeInteger(claims.expiresAt)
    && typeof claims.nonce === 'string'
}

export class BrowserTokenService {
  constructor(private readonly secret: string, private readonly now: () => number = Date.now) {
    if (secret.length < 32) throw new BrowserHostError('INVALID_CONFIG', 'Token secret must be at least 32 characters')
  }

  issue(input: { sessionId: string; ownerId: string; scopes: BrowserCapabilityScope[]; actors?: Array<'human' | 'agent'>; ttlMs: number }): string {
    const issuedAt = this.now()
    const claims: BrowserCapabilityClaims = {
      version: BROWSER_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      scopes: [...new Set(input.scopes)],
      actors: [...new Set(input.actors ?? [])],
      issuedAt,
      expiresAt: issuedAt + input.ttlMs,
      nonce: randomBytes(16).toString('base64url'),
    }
    const payload = base64url(JSON.stringify(claims))
    const signature = this.sign(payload)
    return `${payload}.${signature}`
  }

  verify(token: string, requiredScope: BrowserCapabilityScope, expectedSessionId?: string): BrowserCapabilityClaims {
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) throw new BrowserHostError('INVALID_TOKEN', 'Capability token is malformed', 401)
    const expected = Buffer.from(this.sign(payload), 'base64url')
    const actual = Buffer.from(signature, 'base64url')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new BrowserHostError('INVALID_TOKEN', 'Capability token signature is invalid', 401)
    }
    const raw = decodeJson(payload)
    if (!isClaims(raw)) throw new BrowserHostError('INVALID_TOKEN', 'Capability token claims are invalid', 401)
    if (raw.expiresAt <= this.now()) throw new BrowserHostError('TOKEN_EXPIRED', 'Capability token expired', 401, true)
    if (!raw.scopes.includes(requiredScope)) throw new BrowserHostError('TOKEN_SCOPE_DENIED', `Capability lacks ${requiredScope} scope`, 403)
    if (expectedSessionId && raw.sessionId !== expectedSessionId) throw new BrowserHostError('TOKEN_SESSION_MISMATCH', 'Capability belongs to another session', 403)
    return raw
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url')
  }
}

export function assertServiceAuthorization(header: string | undefined, expectedToken: string): void {
  const prefix = 'Bearer '
  if (!header?.startsWith(prefix)) throw new BrowserHostError('AUTH_REQUIRED', 'Service authorization is required', 401)
  const supplied = Buffer.from(header.slice(prefix.length))
  const expected = Buffer.from(expectedToken)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new BrowserHostError('AUTH_DENIED', 'Service authorization is invalid', 403)
  }
}
