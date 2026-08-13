import { authenticatedKnowledgeRequest } from '@/lib/knowledge-service.server'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get('workspaceId') || undefined
  const collectionId = url.searchParams.get('collectionId') || undefined
  const query = new URLSearchParams({ userId: 'internal', workspaceId: workspaceId || '' })
  if (collectionId) query.set('collectionId', collectionId)
  return (await authenticatedKnowledgeRequest(request, { workspaceId, path: `/v1/knowledge/documents?${query}` })).response
}

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try { body = await request.json() as Record<string, unknown> } catch { return Response.json({ error: { code: 'INVALID_BODY' } }, { status: 400 }) }
  return (await authenticatedKnowledgeRequest(request, { body, path: '/v1/knowledge/documents', method: 'POST' })).response
}
