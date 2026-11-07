import { listBrowserPreviewTargets } from '@/lib/browser-preview-targets.server'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const chatSessionId = url.searchParams.get('chatSessionId') ?? undefined
  const projectId = url.searchParams.get('projectId') ?? undefined
  const result = await listBrowserPreviewTargets({ chatSessionId, projectId })
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status })
  return Response.json({
    version: 1,
    targets: result.targets,
    projectId: result.project.id,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
