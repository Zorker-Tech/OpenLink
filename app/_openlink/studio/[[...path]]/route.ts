import { Buffer } from 'node:buffer'
import { cookies } from 'next/headers'
import { localStudioCookieName, verifyLocalStudioSession } from '@/lib/local-studio-proxy.server'
import { isLocalRuntime } from '@/lib/runtime-mode.server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'if-none-match', 'if-modified-since', 'range', 'user-agent', 'x-client-info', 'x-supabase-client', 'x-supabase-client-platform', 'x-supabase-client-version'])
const RESPONSE_HEADERS = new Set(['cache-control', 'content-language', 'content-range', 'content-type', 'etag', 'last-modified', 'location'])
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

function isStudioHost(request: Request): boolean {
  return (request.headers.get('host') ?? new URL(request.url).host).split(':', 1)[0]?.toLowerCase() === 'studio.localhost'
}

function selectedHeaders(request: Request): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of request.headers.entries()) {
    const normalized = name.toLowerCase()
    if (REQUEST_HEADERS.has(normalized) && value.length <= 4_096 && !/[\r\n\u0000]/.test(value)) result[normalized] = value
  }
  return result
}

async function handler(request: Request): Promise<Response> {
  if (!isLocalRuntime() || !isStudioHost(request)) return new Response('Not found', { status: 404 })
  if (!METHODS.has(request.method)) return new Response('Method not allowed', { status: 405 })
  const session = verifyLocalStudioSession((await cookies()).get(localStudioCookieName())?.value)
  if (!session) return new Response('Local Studio session expired. Return to OpenLink and open Studio again.', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  const path = request.headers.get('x-openlink-studio-path')
  if (!path || !path.startsWith('/') || path.length > 12_000 || /[\u0000-\u001f\\]/.test(path)) return new Response('Invalid Studio path', { status: 400 })
  const host = agentHostConfig()
  if (!host) return new Response('Project backend is unavailable', { status: 503 })
  const bytes = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer())
  if (bytes && bytes.length > 4 * 1024 * 1024) return new Response('Request body is too large', { status: 413 })
  let upstream: Response
  try {
    upstream = await fetch(`${host.baseUrl}/v1/projects/${encodeURIComponent(session.projectId)}/supabase/studio-proxy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: request.method, path, headers: selectedHeaders(request), ...(bytes?.length ? { bodyBase64: bytes.toString('base64url') } : {}) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(55_000),
    })
  } catch {
    return new Response('Project backend is unavailable', { status: 503 })
  }
  const payload = await upstream.json().catch(() => null) as { status?: unknown; headers?: unknown; bodyBase64?: unknown } | null
  if (!upstream.ok || !payload || !Number.isInteger(payload.status) || typeof payload.bodyBase64 !== 'string' || !/^[A-Za-z0-9_-]*$/.test(payload.bodyBase64) || !payload.headers || typeof payload.headers !== 'object' || Array.isArray(payload.headers)) {
    return new Response('Project Studio request failed', { status: upstream.status === 400 ? 400 : 503 })
  }
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "frame-ancestors http://localhost:*",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  for (const [name, value] of Object.entries(payload.headers as Record<string, unknown>)) {
    const normalized = name.toLowerCase()
    if (RESPONSE_HEADERS.has(normalized) && typeof value === 'string' && value.length <= 8_192 && !/[\r\n\u0000]/.test(value)) headers.set(name, value)
  }
  return new Response(request.method === 'HEAD' ? null : Buffer.from(payload.bodyBase64, 'base64url'), { status: payload.status, headers })
}

export const GET = handler
export const HEAD = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const OPTIONS = handler
