import { getCodeChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { cloudComputerSdkRequest } from '@/lib/platform-cloud-host.server'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

const noStore = { 'Cache-Control': 'no-store' }

function validServiceId(value: unknown): value is string {
  if (value === 'code-server') return true
  if (typeof value !== 'string' || !/^web-\d{1,5}$/.test(value)) return false
  const port = Number(value.slice(4))
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 && port !== 8443 && port !== 8444
}

function publicService(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const service = value as Record<string, unknown>
  if (!validServiceId(service.id)
    || typeof service.name !== 'string' || service.name.length < 1 || service.name.length > 64
    || !Number.isSafeInteger(service.port) || Number(service.port) < 1 || Number(service.port) > 65_535
    || service.protocol !== 'http'
    || !['running', 'stopped', 'unavailable'].includes(String(service.status))
    || typeof service.supportsWebSocket !== 'boolean') return null
  if ((service.id === 'code-server' && service.port !== 8443)
    || (service.id !== 'code-server' && service.id !== `web-${service.port}`)) return null
  return {
    id: service.id,
    name: service.name,
    port: service.port,
    protocol: 'http' as const,
    status: service.status,
    supportsWebSocket: service.supportsWebSocket,
    ...(Number.isSafeInteger(service.httpStatus) && Number(service.httpStatus) >= 100 && Number(service.httpStatus) <= 599
      ? { httpStatus: service.httpStatus }
      : {}),
  }
}

async function authorizedChat(sessionId: string) {
  if (getRuntimeMode() !== 'cloud') return { response: Response.json({ error: { code: 'CLOUD_COMPUTER_UNAVAILABLE' } }, { status: 404, headers: noStore }) }
  if (!isChatSessionId(sessionId)) return { response: Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404, headers: noStore }) }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { response: Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401, headers: noStore }) }
  const session = await getCodeChatSession(supabase, user.id, sessionId)
  if (!session) return { response: Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404, headers: noStore }) }
  return { session }
}

function safeUpstreamError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fallback
  const error = (payload as Record<string, unknown>).error
  const code = typeof error === 'string'
    ? error
    : error && typeof error === 'object' && typeof (error as Record<string, unknown>).code === 'string'
      ? (error as Record<string, string>).code
      : ''
  const allowed = new Set([
    'COMPUTER_SERVICE_NOT_RUNNING',
    'COMPUTER_SERVICE_ZONE_NOT_CONFIGURED',
    'COMPUTER_SERVICE_ZONE_INVALID',
    'CLOUD_CONNECTION_NOT_CONFIGURED',
    'CLOUD_CONNECTION_INACTIVE',
    'CLOUD_CONNECTION_REAUTH_REQUIRED',
    'CLOUD_COMPUTER_PERMISSION_REQUIRED',
    'CLOUD_PROJECT_NOT_LINKED',
    'CLOUD_PROJECT_NOT_ACCESSIBLE',
    'CLOUD_SDK_HOST_NOT_CONFIGURED',
  ])
  return allowed.has(code) ? code : fallback
}

export async function GET(_request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  const access = await authorizedChat(sessionId)
  if ('response' in access) return access.response

  try {
    const upstream = await cloudComputerSdkRequest(
      access.session.project_id,
      '/v1/computer/services',
      {},
      AbortSignal.timeout(55_000),
    )
    const payload = await upstream.json().catch(() => null) as Record<string, unknown> | null
    if (!upstream.ok || !payload) {
      return Response.json({ error: { code: safeUpstreamError(payload, 'CLOUD_COMPUTER_SERVICES_UNAVAILABLE') } }, {
        status: upstream.ok ? 502 : upstream.status,
        headers: noStore,
      })
    }
    const services = Array.isArray(payload.services)
      ? payload.services.flatMap((item) => {
        const service = publicService(item)
        return service ? [service] : []
      })
      : []
    const computerStatus = payload.computerStatus === 'running' || payload.computerStatus === 'sleeping'
      ? payload.computerStatus
      : 'unknown'
    return Response.json({ computerStatus, services }, { headers: noStore })
  } catch {
    return Response.json({ error: { code: 'CLOUD_COMPUTER_SERVICES_UNAVAILABLE' } }, { status: 502, headers: noStore })
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  const access = await authorizedChat(sessionId)
  if ('response' in access) return access.response

  let body: { serviceId?: unknown }
  try {
    body = await request.json() as { serviceId?: unknown }
  } catch {
    return Response.json({ error: { code: 'INVALID_BODY' } }, { status: 400, headers: noStore })
  }
  if (!validServiceId(body.serviceId)) {
    return Response.json({ error: { code: 'INVALID_SERVICE_ID' } }, { status: 400, headers: noStore })
  }

  try {
    const upstream = await cloudComputerSdkRequest(
      access.session.project_id,
      '/v1/computer/services/tunnel',
      { serviceId: body.serviceId },
      AbortSignal.timeout(55_000),
    )
    const payload = await upstream.json().catch(() => null) as Record<string, unknown> | null
    if (!upstream.ok || !payload?.tunnel || typeof payload.tunnel !== 'object' || Array.isArray(payload.tunnel)) {
      return Response.json({ error: { code: safeUpstreamError(payload, 'CLOUD_COMPUTER_TUNNEL_UNAVAILABLE') } }, {
        status: upstream.ok ? 502 : upstream.status,
        headers: noStore,
      })
    }
    const tunnel = payload.tunnel as Record<string, unknown>
    const service = publicService(tunnel.service)
    let url: URL
    try {
      url = new URL(typeof tunnel.url === 'string' ? tunnel.url : '')
    } catch {
      return Response.json({ error: { code: 'CLOUD_COMPUTER_TUNNEL_INVALID' } }, { status: 502, headers: noStore })
    }
    const expiry = typeof tunnel.expiresAt === 'string' ? Date.parse(tunnel.expiresAt) : NaN
    if (!service || service.id !== body.serviceId || service.status !== 'running'
      || url.protocol !== 'https:' || url.username || url.password || url.port
      || url.pathname !== '/' || url.search
      || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 10 * 60_000) {
      return Response.json({ error: { code: 'CLOUD_COMPUTER_TUNNEL_INVALID' } }, { status: 502, headers: noStore })
    }
    return Response.json({ tunnel: { url: url.toString(), expiresAt: tunnel.expiresAt, service } }, { headers: noStore })
  } catch {
    return Response.json({ error: { code: 'CLOUD_COMPUTER_TUNNEL_UNAVAILABLE' } }, { status: 502, headers: noStore })
  }
}
