import { getT } from '@/lib/i18n/server'
import { createClient } from '@/utils/supabase/server'
import { discoverBrowserPreviewTargets, hostConfig, resolveBrowserPreviewScope, type BrowserPreviewTarget } from '@/lib/browser-preview-targets.server'
import { isPreviewTargetId } from '@/lib/browser-preview-target-id'

export const runtime = 'nodejs'

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
  const { t } = await getT()
  const config = hostConfig()
  if (!config) return Response.json({ error: { code: 'BROWSER_HOST_NOT_CONFIGURED', message: 'Browser Host is not configured', recoverable: true } }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED', message: 'Authentication is required' } }, { status: 401 })

  let body: { chatSessionId?: unknown; projectId?: unknown; surface?: unknown; initialUrl?: unknown; viewport?: unknown; previewTargetId?: unknown }
  try { body = await request.json() as typeof body } catch {
    return Response.json({ error: { code: 'INVALID_BODY', message: 'Request body is invalid' } }, { status: 400 })
  }
  const chatSessionId = typeof body.chatSessionId === 'string' ? body.chatSessionId : undefined
  const projectId = typeof body.projectId === 'string' ? body.projectId : undefined
  if (!chatSessionId && !projectId) return Response.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project was not found' } }, { status: 404 })
  if (body.surface !== 'native-preview' && body.surface !== 'chromium-stream') {
    return Response.json({ error: { code: 'INVALID_SURFACE', message: 'Browser surface is invalid' } }, { status: 400 })
  }
  const requestedTargetId = body.previewTargetId === undefined
    ? undefined
    : (isPreviewTargetId(body.previewTargetId) ? body.previewTargetId : '')
  if (requestedTargetId === '') return Response.json({ error: { code: 'INVALID_PREVIEW_TARGET', message: 'Preview target is invalid' } }, { status: 400 })

  const scope = await resolveBrowserPreviewScope(supabase, user.id, { chatSessionId, projectId })
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status })
  const discovered = await discoverBrowserPreviewTargets(scope.project.id, scope.preferredSessionId)
  const targets: BrowserPreviewTarget[] = discovered.ok ? discovered.targets : []
  const discoveryError = discovered.ok ? null : discovered.error.message
  const selected = requestedTargetId
    ? targets.find((target) => target.id === requestedTargetId) ?? null
    : targets[0] ?? null
  if (requestedTargetId && !selected) {
    if (!discovered.ok) return Response.json({ error: discovered.error }, { status: discovered.status })
    return Response.json({ error: { code: 'PREVIEW_TARGET_NOT_FOUND', message: t('所选开发服务器已停止，请刷新预览目标'), recoverable: true } }, { status: 409 })
  }

  const requestBody: Record<string, unknown> = {
    ownerId: user.id,
    workspaceId: scope.workspaceId,
    projectId: scope.project.id,
    // Browser Host sessions are intentionally ephemeral, but a Chromium
    // profile must remain stable when the UI reconnects or switches surface.
    // Keep the key private to the Agent Host/Browser Host boundary.
    profileKey: chatSessionId ?? `preview-${user.id}-${scope.project.id}`,
    surface: body.surface,
    viewport: body.viewport,
    ...(selected ? { previewTargetId: selected.id } : {}),
  }
  if (body.surface === 'native-preview') {
    const targetUrl = process.env.OPENLINK_PREVIEW_TARGET_URL
    if (!selected && !targetUrl) {
      if (discoveryError) return Response.json({ error: { code: 'PREVIEW_DISCOVERY_FAILED', message: discoveryError, recoverable: true } }, { status: 503 })
      return Response.json({ error: { code: 'PREVIEW_NOT_ATTACHED', message: t('未检测到运行中的 Web 服务。请先在项目环境中启动开发服务器。'), recoverable: true } }, { status: 409 })
    }
    requestBody.preview = selected
      ? { targetUrl: '', pathMode: process.env.OPENLINK_PREVIEW_PATH_MODE === 'preserve-session-prefix' ? 'preserve-session-prefix' : 'strip-session-prefix' }
      : {
          targetUrl,
          pathMode: process.env.OPENLINK_PREVIEW_PATH_MODE === 'preserve-session-prefix' ? 'preserve-session-prefix' : 'strip-session-prefix',
        }
  } else {
    const initialUrl = typeof body.initialUrl === 'string' ? body.initialUrl.trim().slice(0, 8192) : 'about:blank'
    requestBody.chromium = {
      // Agent Host replaces this with the authenticated target URL when
      // previewTargetId is present. The browser never sees the proxy URL.
      initialUrl: selected ? 'about:blank' : initialUrl,
      headless: true,
      preserveProfile: true,
      networkPolicy: {
        allowedDomains: (process.env.OPENLINK_BROWSER_ALLOWED_DOMAINS || '').split(',').map((value) => value.trim()).filter(Boolean),
        deniedDomains: (process.env.OPENLINK_BROWSER_DENIED_DOMAINS || '').split(',').map((value) => value.trim()).filter(Boolean),
        allowLoopback: process.env.OPENLINK_BROWSER_ALLOW_LOOPBACK === 'true' || isConfiguredLocalPreviewUrl(initialUrl),
        // The only automatic private target is the Project VM's own
        // OpenSandbox proxy, resolved by authenticated Agent Host discovery.
        allowPrivateNetworks: process.env.OPENLINK_BROWSER_ALLOW_PRIVATE_NETWORKS === 'true' || Boolean(selected),
      },
    }
  }

  const response = await fetch(`${config.baseUrl}/v1/projects/${encodeURIComponent(scope.project.id)}/browser/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    cache: 'no-store',
  })
  const payload = await response.json() as { connection?: Record<string, unknown>; [key: string]: unknown }
  if (payload.connection) delete payload.connection.controlToken
  if (selected) payload.previewTarget = {
    id: selected.id,
    label: selected.label,
    port: selected.port,
  }
  return Response.json(payload, { status: response.status })
}
