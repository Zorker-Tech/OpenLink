import { authenticatedKnowledgeRequest } from '@/lib/knowledge-service.server'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ document_id: string }> }) {
  const { document_id: documentId } = await params
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') || undefined
  const query = new URLSearchParams({ userId: 'internal', workspaceId: workspaceId || '' })
  return (await authenticatedKnowledgeRequest(request, { workspaceId, path: `/v1/knowledge/documents/${encodeURIComponent(documentId)}?${query}` })).response
}

export async function DELETE(request: Request, { params }: { params: Promise<{ document_id: string }> }) {
  const { document_id: documentId } = await params
  let body: Record<string, unknown> = {}
  try { body = await request.json() as Record<string, unknown> } catch {
    // Workspace is also accepted through the query string for a body-less
    // DELETE request.
    const workspaceId = new URL(request.url).searchParams.get('workspaceId')
    if (workspaceId) body.workspaceId = workspaceId
  }
  if (typeof body.workspaceId !== 'string') {
    const workspaceId = new URL(request.url).searchParams.get('workspaceId')
    if (workspaceId) body.workspaceId = workspaceId
  }
  return (await authenticatedKnowledgeRequest(request, { body, workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined, path: `/v1/knowledge/documents/${encodeURIComponent(documentId)}`, method: 'DELETE' })).response
}
