import { isPreviewSourceRevision } from '@/packages/browser-protocol/src/index'
import { createPreviewScreenshotReceipt } from '@/lib/preview-screenshot-receipt.server.mjs'
import { isPreviewTargetId } from '@/lib/browser-preview-target-id'
import { resolveBrowserPreviewScope } from '@/lib/browser-preview-targets.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function isPagePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 2048
    || /[?#\\\u0000-\u001f\u007f]/.test(value)) return false
  return !value.split('/').some((segment) => {
    try {
      const decoded = decodeURIComponent(segment)
      return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')
    } catch {
      return true
    }
  })
}

export async function POST(request: Request) {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  if (!baseUrl || !apiToken) return Response.json({ error: { code: 'BROWSER_HOST_NOT_CONFIGURED' } }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })

  let body: { projectId?: unknown; previewTargetId?: unknown; pagePath?: unknown; viewport?: unknown }
  try { body = await request.json() as typeof body } catch {
    return Response.json({ error: { code: 'INVALID_BODY', message: 'Request body is invalid' } }, { status: 400 })
  }
  if (typeof body.projectId !== 'string' || !isPreviewTargetId(body.previewTargetId) || !isPagePath(body.pagePath)) {
    return Response.json({ error: { code: 'INVALID_BODY', message: 'Preview screenshot request is invalid' } }, { status: 400 })
  }
  const rawViewport = body.viewport && typeof body.viewport === 'object' ? body.viewport as Record<string, unknown> : {}
  const viewport = {
    width: Number(rawViewport.width),
    height: Number(rawViewport.height),
    deviceScaleFactor: rawViewport.deviceScaleFactor === undefined ? 1 : Number(rawViewport.deviceScaleFactor),
  }
  if (!Number.isSafeInteger(viewport.width) || viewport.width < 240 || viewport.width > 2560
    || !Number.isSafeInteger(viewport.height) || viewport.height < 240 || viewport.height > 4320
    || !Number.isFinite(viewport.deviceScaleFactor) || viewport.deviceScaleFactor < 0.5 || viewport.deviceScaleFactor > 3) {
    return Response.json({ error: { code: 'INVALID_VIEWPORT', message: 'Preview viewport is invalid' } }, { status: 400 })
  }

  const scope = await resolveBrowserPreviewScope(supabase, user.id, { projectId: body.projectId })
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status })
  try {
    const response = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(scope.project.id)}/preview-screenshot`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerId: user.id,
        workspaceId: scope.workspaceId,
        previewTargetId: body.previewTargetId,
        pagePath: body.pagePath,
        viewport,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    })
    const payload = await response.json().catch(() => null) as {
      image?: { mimeType?: unknown; data?: unknown }
      targetRevision?: unknown
    } | null
    if (!response.ok || payload?.image?.mimeType !== 'image/jpeg' || typeof payload.image.data !== 'string'
      || payload.image.data.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.image.data)) {
      return Response.json({ error: { code: 'PREVIEW_SCREENSHOT_FAILED', message: 'Could not capture the current Preview target' } }, { status: response.ok ? 502 : response.status })
    }
    const targetRevision = isPreviewSourceRevision(payload.targetRevision) ? payload.targetRevision : null
    const image = Buffer.from(payload.image.data, 'base64')
    const targetRevisionReceipt = targetRevision
      ? createPreviewScreenshotReceipt({
        secret: apiToken,
        userId: user.id,
        projectId: scope.project.id,
        targetId: body.previewTargetId,
        pagePath: body.pagePath,
        viewport: { width: viewport.width, height: viewport.height },
        targetRevision,
        image,
      })
      : null
    return Response.json({
      image: { mimeType: 'image/jpeg', data: payload.image.data },
      targetRevision,
      targetRevisionReceipt,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ error: { code: 'PREVIEW_SCREENSHOT_FAILED', message: 'Could not capture the current Preview target' } }, { status: 503 })
  }
}
