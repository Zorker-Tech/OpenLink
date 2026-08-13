import { authenticatedKnowledgeRequest } from '@/lib/knowledge-service.server'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') || undefined
  return (await authenticatedKnowledgeRequest(request, { workspaceId, path: `/v1/knowledge/collections?userId=internal&workspaceId=${encodeURIComponent(workspaceId || '')}` })).response
}

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try { body = await request.json() as Record<string, unknown> } catch { return Response.json({ error: { code: 'INVALID_BODY' } }, { status: 400 }) }
  return (await authenticatedKnowledgeRequest(request, { body, path: '/v1/knowledge/collections', method: 'POST' })).response
}

export async function DELETE(request: Request) {
  let body: Record<string, unknown> = {}
  try { body = await request.json() as Record<string, unknown> } catch {
    const workspaceId = new URL(request.url).searchParams.get('workspaceId')
    if (workspaceId) body.workspaceId = workspaceId
  }
  const collectionId = new URL(request.url).searchParams.get('collectionId')
  if (!collectionId) return Response.json({ error: { code: 'INVALID_BODY', message: 'collectionId is required' } }, { status: 400 })
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : new URL(request.url).searchParams.get('workspaceId') || undefined
  return (await authenticatedKnowledgeRequest(request, { body: { ...body, ...(workspaceId ? { workspaceId } : {}) }, workspaceId, path: `/v1/knowledge/collections/${encodeURIComponent(collectionId)}`, method: 'DELETE' })).response
}
