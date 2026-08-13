import { authenticatedKnowledgeRequest } from '@/lib/knowledge-service.server'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try { body = await request.json() as Record<string, unknown> } catch { return Response.json({ error: { code: 'INVALID_BODY' } }, { status: 400 }) }
  return (await authenticatedKnowledgeRequest(request, { body, path: '/v1/knowledge/search', method: 'POST' })).response
}
