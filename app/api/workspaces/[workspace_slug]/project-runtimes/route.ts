import { getDefaultProject, listProjects, type ProjectSummary } from '@/lib/projects'
import { getAccessibleWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function runtimeSnapshot(project: ProjectSummary) {
  return {
    id: project.id,
    status: project.status,
    runtime_status: project.runtime_status,
    runtime_error: project.runtime_error,
    runtime_phase: project.runtime_phase,
    runtime_phase_updated_at: project.runtime_phase_updated_at,
    runtime_provisioning_attempts: project.runtime_provisioning_attempts,
    runtime_provisioning_next_attempt_at: project.runtime_provisioning_next_attempt_at,
    runtime_provisioning_lease_expires_at: project.runtime_provisioning_lease_expires_at,
    runtime_claimed: project.runtime_claimed,
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspace_slug: string }> },
) {
  const { workspace_slug: workspaceSlug } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })

  try {
    const workspace = await getAccessibleWorkspace(supabase, workspaceSlug)
    if (!workspace) return Response.json({ error: 'WORKSPACE_NOT_FOUND' }, { status: 404 })

    const [defaultProject, projects] = await Promise.all([
      getDefaultProject(supabase, workspace.id),
      listProjects(supabase, workspace.id),
    ])
    return Response.json({
      projects: [...(defaultProject ? [defaultProject] : []), ...projects].map(runtimeSnapshot),
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return Response.json({ error: 'PROJECT_RUNTIME_READ_FAILED' }, { status: 500 })
  }
}
