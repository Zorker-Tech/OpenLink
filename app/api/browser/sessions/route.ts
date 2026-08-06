import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function hostConfig() {
  const baseUrl = process.env.OPENLINK_BROWSER_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_BROWSER_API_TOKEN
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

export async function POST(request: Request) {
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
    surface: body.surface,
    viewport: body.viewport,
  }
  if (body.surface === 'native-preview') {
    const targetUrl = process.env.OPENLINK_PREVIEW_TARGET_URL
    if (!targetUrl) return Response.json({ error: { code: 'PREVIEW_NOT_ATTACHED', message: 'This project does not have an attached preview runtime yet', recoverable: true } }, { status: 409 })
    requestBody.preview = {
      targetUrl,
      pathMode: process.env.OPENLINK_PREVIEW_PATH_MODE === 'preserve-session-prefix' ? 'preserve-session-prefix' : 'strip-session-prefix',
    }
  } else {
    const initialUrl = typeof body.initialUrl === 'string' ? body.initialUrl.trim().slice(0, 8192) : 'about:blank'
    requestBody.chromium = {
      initialUrl,
      headless: true,
      networkPolicy: {
        allowedDomains: (process.env.OPENLINK_BROWSER_ALLOWED_DOMAINS || '').split(',').map((value) => value.trim()).filter(Boolean),
        deniedDomains: (process.env.OPENLINK_BROWSER_DENIED_DOMAINS || '').split(',').map((value) => value.trim()).filter(Boolean),
        // The attached local preview is an explicit, user-configured target;
        // permit Chromium to reach only that loopback origin without opening
        // arbitrary localhost access by default.
        allowLoopback: process.env.OPENLINK_BROWSER_ALLOW_LOOPBACK === 'true' || isConfiguredLocalPreviewUrl(initialUrl),
        allowPrivateNetworks: process.env.OPENLINK_BROWSER_ALLOW_PRIVATE_NETWORKS === 'true',
      },
    }
  }

  const response = await fetch(`${config.baseUrl}/v1/browser/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    cache: 'no-store',
  })
  const payload = await response.json() as { connection?: Record<string, unknown>; [key: string]: unknown }
  if (payload.connection) delete payload.connection.controlToken
  return Response.json(payload, { status: response.status })
}
