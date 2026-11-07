import { createClient } from '@/utils/supabase/server'
import { resolveBrowserPreviewScope } from '@/lib/browser-preview-targets.server'

export const runtime = 'nodejs'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ browser_session_id: string }> },
) {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  if (!baseUrl || !apiToken) return Response.json({ error: { code: 'BROWSER_HOST_NOT_CONFIGURED' } }, { status: 503 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const query = new URL(request.url).searchParams
  const chatSessionId = query.get('chatSessionId') || undefined
  const projectId = query.get('projectId') || undefined
  const scope = await resolveBrowserPreviewScope(supabase, user.id, { chatSessionId, projectId })
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status })
  const { browser_session_id: browserSessionId } = await params
  const response = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(scope.project.id)}/browser/sessions/${encodeURIComponent(browserSessionId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId: user.id, workspaceId: scope.workspaceId }),
    cache: 'no-store',
  })
  return new Response(response.body, { status: response.status })
}
