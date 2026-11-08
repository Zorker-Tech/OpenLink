import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { cloudComputerSdkRequest } from '@/lib/platform-cloud-host.server'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function codeServerGatewaySession(value: unknown): { sessionId: string; path: string; bootstrapToken: string; expiresAt: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const session = value as Record<string, unknown>
  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : ''
  const rawUrl = typeof session.url === 'string' ? session.url : ''
  const expiresAt = typeof session.expiresAt === 'string' ? session.expiresAt : ''
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !expiresAt) return null
  const url = parseUrl(rawUrl)
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null
  const path = `/v1/code-server/gateway/sessions/${sessionId}`
  if (url.pathname !== `${path}/__openlink_bootstrap` || url.searchParams.getAll('token').length !== 1) return null
  const bootstrapToken = url.searchParams.get('token') || ''
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(bootstrapToken)) return null
  const expires = Date.parse(expiresAt)
  if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 24 * 60 * 60_000) return null
  return { sessionId, path, bootstrapToken, expiresAt: new Date(expires).toISOString() }
}

function codeServerGatewayCookie(sessionId: string, value: string, path: string): string | null {
  const expectedName = `openlink_code_server_gateway_${sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 48)}`
  const prefix = `${expectedName}=`
  const cookieParts = value.split(';').map((part) => part.trim())
  const cookiePath = cookieParts.find((part) => /^Path=/i.test(part))?.slice('Path='.length)
  if (cookiePath !== path && cookiePath !== `${path}/`) return null
  if (!value.startsWith(prefix)
    || !/;\s*HttpOnly(?:;|$)/i.test(value)
    || !/;\s*SameSite=Strict(?:;|$)/i.test(value)
    || /;\s*Domain=/i.test(value)) return null
  // Next.js canonicalizes a trailing slash before applying the gateway
  // rewrite. Normalize both old and new Agent Host cookie paths so the
  // browser sends the cookie after that redirect and on nested assets.
  return value.replace(/;\s*Path=[^;]*/i, `; Path=${path}`)
}

function requestOrigin(request: Request): string | null {
  const origin = request.headers.get('origin') || new URL(request.url).origin
  try {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return null
    return parsed.origin
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  const cloudMode = getRuntimeMode() === 'cloud'
  const host = cloudMode ? null : agentHostConfig()
  if (!cloudMode && !host) return Response.json({ error: { code: 'CODE_SERVER_NOT_CONFIGURED' } }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })

  let body: { chatSessionId?: unknown }
  try {
    body = await request.json() as { chatSessionId?: unknown }
  } catch {
    return Response.json({ error: { code: 'INVALID_BODY' } }, { status: 400 })
  }
  const chatSessionId = typeof body.chatSessionId === 'string' ? body.chatSessionId : ''
  if (!isChatSessionId(chatSessionId)) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })

  // The browser can name any chat id, so derive both Project and Workspace
  // from the authenticated server-side session row instead of trusting it.
  const chat = await getChatSession(supabase, user.id, chatSessionId)
  if (!chat) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })

  const frameAncestorOrigin = requestOrigin(request)
  if (!frameAncestorOrigin || request.headers.get('sec-fetch-site') === 'cross-site') {
    return Response.json({ error: { code: 'ORIGIN_NOT_ALLOWED' } }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }

  if (cloudMode) {
    try {
      const upstream = await cloudComputerSdkRequest(
        chat.project_id,
        '/v1/computer/services/tunnel',
        { serviceId: 'code-server' },
        AbortSignal.timeout(55_000),
      )
      const payload = await upstream.json().catch(() => null) as Record<string, unknown> | null
      const tunnel = payload?.tunnel && typeof payload.tunnel === 'object' && !Array.isArray(payload.tunnel)
        ? payload.tunnel as Record<string, unknown>
        : null
      const service = tunnel?.service && typeof tunnel.service === 'object' && !Array.isArray(tunnel.service)
        ? tunnel.service as Record<string, unknown>
        : null
      const url = parseUrl(tunnel?.url)
      const expiresAt = typeof tunnel?.expiresAt === 'string' ? Date.parse(tunnel.expiresAt) : NaN
      if (!upstream.ok || !url || service?.id !== 'code-server' || service.status !== 'running'
        || url.protocol !== 'https:' || url.username || url.password || url.port
        || url.pathname !== '/' || url.search
        || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 10 * 60_000) {
        const upstreamError = payload?.error
        const code = typeof upstreamError === 'string' && upstreamError === 'COMPUTER_SERVICE_NOT_RUNNING'
          ? 'CODE_SERVER_NOT_RUNNING'
          : typeof upstreamError === 'string' && ['COMPUTER_SERVICE_ZONE_NOT_CONFIGURED', 'COMPUTER_SERVICE_ZONE_INVALID'].includes(upstreamError)
            ? 'CODE_SERVER_NOT_CONFIGURED'
            : 'CODE_SERVER_SESSION_FAILED'
        return Response.json({ error: { code } }, { status: upstream.ok ? 502 : upstream.status, headers: { 'Cache-Control': 'no-store' } })
      }
      return Response.json({ session: { url: url.toString(), expiresAt: tunnel?.expiresAt } }, { headers: { 'Cache-Control': 'no-store' } })
    } catch {
      return Response.json({ error: { code: 'CODE_SERVER_SESSION_FAILED' } }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
    }
  }

  const response = await fetch(`${host!.baseUrl}/v1/projects/${encodeURIComponent(chat.project_id)}/code-server/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${host!.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ownerId: user.id, workspaceId: chat.workspace_id, sessionId: chat.id, frameAncestorOrigin }),
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({ error: { code: 'CODE_SERVER_SESSION_FAILED' } }))
  if (!response.ok) return Response.json(payload, { status: response.status, headers: { 'Cache-Control': 'no-store' } })

  const outer = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null
  const session = codeServerGatewaySession(outer?.session)
  if (!session) return Response.json({ error: { code: 'CODE_SERVER_SESSION_FAILED' } }, { status: 502, headers: { 'Cache-Control': 'no-store' } })

  let bootstrapResponse: Response
  try {
    bootstrapResponse = await fetch(`${host!.baseUrl}${session.path}/__openlink_bootstrap`, {
      method: 'POST',
      headers: {
        Origin: frameAncestorOrigin,
        'X-OpenLink-Code-Server-Bootstrap': session.bootstrapToken,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    return Response.json({ error: { code: 'CODE_SERVER_SESSION_FAILED' } }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }
  const bootstrapCookie = bootstrapResponse.headers.get('set-cookie')
  const gatewayCookie = bootstrapResponse.ok && bootstrapCookie
    ? codeServerGatewayCookie(session.sessionId, bootstrapCookie, session.path)
    : null
  if (!gatewayCookie) {
    return Response.json({ error: { code: 'CODE_SERVER_SESSION_FAILED' } }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }

  const headers = new Headers({ 'Cache-Control': 'no-store' })
  const maxAge = Math.max(1, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000))
  headers.append('Set-Cookie', `${gatewayCookie.replace(/;+\s*$/, '')}; Max-Age=${maxAge}`)

  return Response.json({
    version: outer?.version,
    session: {
      sessionId: session.sessionId,
      url: `${session.path}/`,
      expiresAt: session.expiresAt,
    },
  }, {
    status: response.status,
    headers,
  })
}
