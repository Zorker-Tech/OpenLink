import { authenticatedKnowledgeRequest } from '@/lib/knowledge-service.server'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') || undefined
  return (await authenticatedKnowledgeRequest(request, { workspaceId, path: `/v1/knowledge/backends?userId=internal&workspaceId=${encodeURIComponent(workspaceId || '')}` })).response
}
