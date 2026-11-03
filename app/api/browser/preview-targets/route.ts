import { listBrowserPreviewTargets } from '@/lib/browser-preview-targets.server'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const chatSessionId = url.searchParams.get('chatSessionId') ?? ''
  const result = await listBrowserPreviewTargets(chatSessionId)
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status })
  return Response.json({
    version: 1,
    targets: result.targets,
    sessionId: chatSessionId,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
