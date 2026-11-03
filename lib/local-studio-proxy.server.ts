import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'openlink_local_studio'
const TICKET_VERSION = 1
export const LOCAL_STUDIO_COOKIE_MAX_AGE_SECONDS = 15 * 60

export interface LocalStudioSession {
  version: number
  projectId: string
  chatSessionId: string
  userId: string
  expiresAt: number
}

function signingKey(): Buffer {
  const token = process.env.OPENLINK_AGENT_API_TOKEN?.trim()
  if (!token || token.length < 16) throw new Error('OPENLINK_AGENT_API_TOKEN is required for the Local Studio proxy')
  return Buffer.from(token, 'utf8')
}

function signature(payload: string): string {
  return createHmac('sha256', signingKey()).update(`openlink:local-studio:v1:${payload}`).digest('base64url')
}

function validId(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}

export function localStudioCookieName(): string {
  return COOKIE_NAME
}

/**
 * Chromium does not send `Domain=localhost` cookies to `studio.localhost`, so
 * the first Studio navigation carries the capability in the query string and
 * the internal route upgrades it to a host-only cookie on the Studio origin.
 */
export const LOCAL_STUDIO_TICKET_PARAM = 'openlink-studio-ticket'

export function createLocalStudioSession(input: Omit<LocalStudioSession, 'version' | 'expiresAt'>): { value: string; maxAge: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + LOCAL_STUDIO_COOKIE_MAX_AGE_SECONDS
  const payload = Buffer.from(JSON.stringify({ version: TICKET_VERSION, ...input, expiresAt }), 'utf8').toString('base64url')
  return { value: `${payload}.${signature(payload)}`, maxAge: LOCAL_STUDIO_COOKIE_MAX_AGE_SECONDS }
}

export function verifyLocalStudioSession(value: string | undefined): LocalStudioSession | null {
  if (!value || value.length > 4_096) return null
  const [payload, supplied, ...extra] = value.split('.')
  if (!payload || !supplied || extra.length) return null
  const expected = signature(payload)
  const suppliedBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) return null
  let candidate: unknown
  try { candidate = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return null }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const valueObject = candidate as Record<string, unknown>
  if (valueObject.version !== TICKET_VERSION
    || !validId(valueObject.projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    || !validId(valueObject.chatSessionId, /^[A-Za-z0-9]{11}$/)
    || !validId(valueObject.userId, /^[0-9a-f-]{8,}$/i)
    || typeof valueObject.expiresAt !== 'number' || !Number.isSafeInteger(valueObject.expiresAt)
    || valueObject.expiresAt < Math.floor(Date.now() / 1000)) return null
  return valueObject as unknown as LocalStudioSession
}

export function localStudioOrigin(request?: Request): string {
  // Studio is served on a second port of the SAME host the user opened. Ports
  // are not part of a cookie's site, so a host-only ticket cookie is shared
  // with the Studio origin while its separate root namespace stays isolated.
  // Deriving the hostname also makes LAN access work; a hard-coded localhost
  // origin is unreachable from another machine.
  const configured = process.env.OPENLINK_STUDIO_ORIGIN || 'http://localhost:3002'
  const configuredUrl = new URL(configured)
  const port = configuredUrl.port || '3002'
  if (!request) return `${configuredUrl.protocol}//${configuredUrl.hostname}:${port}`
  const requestUrl = new URL(request.url)
  const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const hostname = forwardedHost?.split(':')[0]?.trim() || requestUrl.hostname || 'localhost'
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const protocol = forwardedProto === 'https' || requestUrl.protocol === 'https:' ? 'https:' : 'http:'
  return `${protocol}//${hostname}:${port}`
}
