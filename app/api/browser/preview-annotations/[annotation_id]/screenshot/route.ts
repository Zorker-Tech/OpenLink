import { resolveBrowserPreviewScope } from '@/lib/browser-preview-targets.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function GET(
  request: Request,
  { params }: { params: Promise<{ annotation_id: string }> },
) {
  const { annotation_id: annotationId } = await params
  const projectId = new URL(request.url).searchParams.get('projectId') ?? ''
  if (!ID_PATTERN.test(annotationId) || !ID_PATTERN.test(projectId)) {
    return Response.json({ error: { code: 'INVALID_SCOPE' } }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const scope = await resolveBrowserPreviewScope(supabase, user.id, { projectId })
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status })

  const { data, error } = await supabase.schema('openlink')
    .from('preview_annotations')
    .select('screenshot_data_url')
    .eq('id', annotationId)
    .eq('project_id', scope.project.id)
    .maybeSingle()
  if (error) return Response.json({ error: { code: 'PREVIEW_ANNOTATION_READ_FAILED' } }, { status: 503 })
  if (!data) return Response.json({ error: { code: 'ANNOTATION_NOT_FOUND' } }, { status: 404 })
  return Response.json({ screenshotDataUrl: data.screenshot_data_url }, { headers: { 'Cache-Control': 'no-store' } })
}
