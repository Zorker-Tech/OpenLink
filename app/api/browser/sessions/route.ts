import { getT } from '@/lib/i18n/server'
import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function hostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  if (!baseUrl || !apiToken) return null
  return { baseUrl, apiToken }
}

function isConfiguredLocalPreviewUrl(raw: string) {
  const configured = process.env.OPENLINK_PREVIEW_TARGET_URL
  if (!configured) return false
  try {
    const target = new URL(configured)
    const candidate = new URL(raw)
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(candidate.hostname.toLowerCase())
    const hostKey = (hostname: string) => hostname.toLowerCase() === 'localhost' ? '127.0.0.1' : hostname.toLowerCase()
    return localHost
      && candidate.protocol === target.protocol
      && hostKey(candidate.hostname) === hostKey(target.hostname)
      && candidate.port === target.port
  } catch {
    return false
  }
}

type ProjectPreviewTarget = {
  url: string
  headers?: Record<string, string>
  port?: number
}

async function discoverProjectPreviewTarget(config: { baseUrl: string; apiToken: string }, projectId: string): Promise<ProjectPreviewTarget | null> {
  const response = await fetch(`${config.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/preview-target`, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Project preview discovery failed (${response.status})`)
  const payload = await response.json() as { target?: unknown }
  if (!payload.target || typeof payload.target !== 'object') return null
  const target = payload.target as Partial<ProjectPreviewTarget>
  if (typeof target.url !== 'string') return null
  const headers = target.headers && typeof target.headers === 'object'
    ? Object.fromEntries(Object.entries(target.headers).filter(([key, value]) => typeof key === 'string' && typeof value === 'string'))
    : undefined
  return { url: target.url, ...(headers ? { headers } : {}), ...(typeof target.port === 'number' ? { port: target.port } : {}) }
}

export async function POST(request: Request) {
  const { t } = await getT()
  const config = hostConfig()
  if (!config) return Response.json({ error: { code: 'BROWSER_HOST_NOT_CONFIGURED', message: 'Browser Host is not configured', recoverable: true } }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED', message: 'Authentication is required' } }, { status: 401 })

  let body: { chatSessionId?: unknown; surface?: unknown; initialUrl?: unknown; viewport?: unknown }
  try { body = await request.json() as typeof body } catch {
    return Response.json({ error: { code: 'INVALID_BODY', message: 'Request body is invalid' } }, { status: 400 })
  }
  const chatSessionId = typeof body.chatSessionId === 'string' ? body.chatSessionId : ''
  if (!isChatSessionId(chatSessionId)) return Response.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Chat session was not found' } }, { status: 404 })
  const chat = await getChatSession(supabase, user.id, chatSessionId)
  if (!chat) return Response.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Chat session was not found' } }, { status: 404 })
  if (body.surface !== 'native-preview' && body.surface !== 'chromium-stream') {
    return Response.json({ error: { code: 'INVALID_SURFACE', message: 'Browser surface is invalid' } }, { status: 400 })
  }

  const requestBody: Record<string, unknown> = {
    ownerId: user.id,
    workspaceId: chat.workspace_id,
    projectId: chat.project_id,
    // Browser Host sessions are intentionally ephemeral, but a Chromium
    // profile must remain stable when the UI reconnects or switches surface.
    // Keep the key private to the Agent Host/Browser Host boundary.
    profileKey: chatSessionId,
    surface: body.surface,
    viewport: body.viewport,
  }
  let discoveredPreview: ProjectPreviewTarget | null = null
  try {
    discoveredPreview = await discoverProjectPreviewTarget(config, chat.project_id)
  } catch (error) {
    return Response.json({ error: { code: 'PREVIEW_DISCOVERY_FAILED', message: error instanceof Error ? error.message : 'Project preview discovery failed', recoverable: true } }, { status: 503 })
  }
  if (body.surface === 'native-preview') {
    const targetUrl = discoveredPreview?.url || process.env.OPENLINK_PREVIEW_TARGET_URL
    if (!targetUrl) return Response.json({ error: { code: 'PREVIEW_NOT_ATTACHED', message: t('未检测到运行中的 Web 服务。请先在项目环境中启动开发服务器。'), recoverable: true } }, { status: 409 })
    requestBody.preview = {
      targetUrl,
      ...(discoveredPreview?.headers ? { targetHeaders: discoveredPreview.headers } : {}),
      pathMode: process.env.OPENLINK_PREVIEW_PATH_MODE === 'preserve-session-prefix' ? 'preserve-session-prefix' : 'strip-session-prefix',
    }
  } else {
    const initialUrl = discoveredPreview?.url || (typeof body.initialUrl === 'string' ? body.initialUrl.trim().slice(0, 8192) : 'about:blank')
    requestBody.chromium = {
      initialUrl,
      ...(discoveredPreview?.headers ? { initialRequestHeaders: discoveredPreview.headers } : {}),
      headless: true,
      // The browser session is recreated when the chat panel switches surface
      // or the WebSocket reconnects. Keep its project-local Chromium profile
      // so cookies, localStorage, and open-page state survive that lifecycle;
      // the Project VM owns and deletes the profile tree with the project.
      preserveProfile: true,
      networkPolicy: {
        allowedDomains: (process.env.OPENLINK_BROWSER_ALLOWED_DOMAINS || '').split(',').map((value) => value.trim()).filter(Boolean),
        deniedDomains: (process.env.OPENLINK_BROWSER_DENIED_DOMAINS || '').split(',').map((value) => value.trim()).filter(Boolean),
        // The attached local preview is an explicit, user-configured target;
        // permit Chromium to reach only that loopback origin without opening
        // arbitrary localhost access by default.
        allowLoopback: process.env.OPENLINK_BROWSER_ALLOW_LOOPBACK === 'true' || isConfiguredLocalPreviewUrl(initialUrl),
        // The only automatic private target is the Project VM's own
        // OpenSandbox proxy, returned by authenticated Agent Host discovery.
        allowPrivateNetworks: process.env.OPENLINK_BROWSER_ALLOW_PRIVATE_NETWORKS === 'true' || Boolean(discoveredPreview),
      },
    }
  }

  const response = await fetch(`${config.baseUrl}/v1/projects/${encodeURIComponent(chat.project_id)}/browser/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    cache: 'no-store',
  })
  const payload = await response.json() as { connection?: Record<string, unknown>; [key: string]: unknown }
  if (payload.connection) delete payload.connection.controlToken
  return Response.json(payload, { status: response.status })
}
