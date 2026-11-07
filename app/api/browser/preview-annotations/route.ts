import { isPreviewTargetId } from '@/lib/browser-preview-target-id'
import { resolveBrowserPreviewScope } from '@/lib/browser-preview-targets.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 2_900_000

async function readJson(request: Request): Promise<{ value: unknown; tooLarge: boolean }> {
  if (!request.body) return { value: null, tooLarge: false }
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined)
        return { value: null, tooLarge: true }
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return { value: JSON.parse(text) as unknown, tooLarge: false }
  } catch {
    return { value: null, tooLarge: false }
  }
}

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

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rect = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
    && Number(rect.x) >= 0 && Number(rect.y) >= 0 && Number(rect.width) > 0 && Number(rect.height) > 0
}

function isViewport(value: unknown): value is { width: number; height: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const viewport = value as Record<string, unknown>
  return Number.isSafeInteger(viewport.width) && Number(viewport.width) >= 240 && Number(viewport.width) <= 2560
    && Number.isSafeInteger(viewport.height) && Number(viewport.height) >= 240 && Number(viewport.height) <= 4320
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = url.searchParams.get('projectId') ?? ''
  const targetId = url.searchParams.get('targetId') ?? ''
  if (!ID_PATTERN.test(projectId) || !isPreviewTargetId(targetId)) {
    return Response.json({ error: { code: 'INVALID_SCOPE', message: 'Preview annotation scope is invalid' } }, { status: 400 })
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const scope = await resolveBrowserPreviewScope(supabase, user.id, { projectId })
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status })
  const { data, error } = await supabase.schema('openlink')
    .from('preview_annotations')
    .select('id, target_id, page_path, element_selector, element_label, bounds, viewport, comment, created_at')
    .eq('project_id', scope.project.id)
    .eq('target_id', targetId)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) return Response.json({ error: { code: 'PREVIEW_ANNOTATIONS_FAILED' } }, { status: 503 })
  return Response.json({ annotations: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const parsedBody = await readJson(request)
  if (parsedBody.tooLarge) return Response.json({ error: { code: 'BODY_TOO_LARGE' } }, { status: 413 })
  if (!parsedBody.value || typeof parsedBody.value !== 'object' || Array.isArray(parsedBody.value)) {
    return Response.json({ error: { code: 'INVALID_BODY' } }, { status: 400 })
  }
  const body = parsedBody.value as {
    projectId?: unknown
    targetId?: unknown
    pagePath?: unknown
    selector?: unknown
    label?: unknown
    bounds?: unknown
    viewport?: unknown
    comment?: unknown
    screenshotDataUrl?: unknown
  }
  if (typeof body.projectId !== 'string' || !ID_PATTERN.test(body.projectId)
    || !isPreviewTargetId(body.targetId) || !isPagePath(body.pagePath)
    || !isRect(body.bounds) || !isViewport(body.viewport)
    || typeof body.comment !== 'string' || !body.comment.trim() || body.comment.trim().length > 2000
    || typeof body.screenshotDataUrl !== 'string'
    || !body.screenshotDataUrl.startsWith('data:image/jpeg;base64,')
    || body.screenshotDataUrl.length > 2_800_050
    || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.screenshotDataUrl)
    || (body.selector !== undefined && body.selector !== null && (typeof body.selector !== 'string' || body.selector.length > 1000))
    || (body.label !== undefined && body.label !== null && (typeof body.label !== 'string' || body.label.length > 240))) {
    return Response.json({ error: { code: 'INVALID_ANNOTATION', message: 'Preview annotation is invalid' } }, { status: 400 })
  }
  if (body.bounds.x + body.bounds.width > body.viewport.width + 2 || body.bounds.y + body.bounds.height > body.viewport.height + 2) {
    return Response.json({ error: { code: 'INVALID_ANNOTATION', message: 'Annotation bounds exceed the Preview viewport' } }, { status: 400 })
  }
  const scope = await resolveBrowserPreviewScope(supabase, user.id, { projectId: body.projectId })
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status })
  const { data, error } = await supabase.schema('openlink').from('preview_annotations').insert({
    project_id: scope.project.id,
    created_by: user.id,
    target_id: body.targetId,
    page_path: body.pagePath,
    element_selector: typeof body.selector === 'string' ? body.selector : null,
    element_label: typeof body.label === 'string' ? body.label : null,
    bounds: body.bounds,
    viewport: body.viewport,
    comment: body.comment.trim(),
    screenshot_data_url: body.screenshotDataUrl,
  }).select('id, target_id, page_path, element_selector, element_label, bounds, viewport, comment, created_at').single()
  if (error || !data) return Response.json({ error: { code: 'PREVIEW_ANNOTATION_SAVE_FAILED' } }, { status: 503 })
  return Response.json({ annotation: data }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}
