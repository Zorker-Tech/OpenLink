import { authenticatedKnowledgeRequest } from '@/lib/knowledge-service.server'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ job_id: string }> }) {
  const { job_id: jobId } = await params
  return (await authenticatedKnowledgeRequest(request, { path: `/v1/knowledge/jobs/${encodeURIComponent(jobId)}?userId=internal` })).response
}
