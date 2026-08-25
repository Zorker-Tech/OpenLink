import type { ProjectSummary } from '@/lib/projects'
import { ensureDraftProject, listProjects } from '@/lib/projects'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import { listConfiguredModels } from '@/lib/ai-provider-configurations.server'
import { getAccessibleWorkspace, getOwnedWorkspace } from '@/lib/workspaces'
import { listOrganizations } from '@/lib/organizations'
import { createClient } from '@/utils/supabase/server'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

export interface ComposerWorkspace {
  id: string
  slug: string
  name: string
  scopeType: 'personal' | 'organization'
  /** The workspace's default "Draft" project, used when nothing is selected. */
  defaultProject: ProjectSummary
  /** Non-default projects selectable in the composer. */
  projects: ProjectSummary[]
}

export interface ComposerContext {
  models: ConfiguredModelOption[]
  workspaces: ComposerWorkspace[]
}

/**
 * Loads everything the marketing composer needs for a signed-in user: the
 * configured models plus, for every accessible workspace (personal and each
 * organization), the default Draft project and the non-default projects. Kept
 * in one place so the page renders a fully functional composer behind the
 * login gate without extra round-trips.
 */
export async function loadComposerContext(
  supabase: ServerSupabaseClient,
  userId: string,
): Promise<ComposerContext> {
  const [personal, organizations, models] = await Promise.all([
    getOwnedWorkspace(supabase, userId),
    listOrganizations(supabase, userId),
    listConfiguredModels(supabase, userId),
  ])

  const workspaces: ComposerWorkspace[] = []
  const pushWorkspace = async (workspace: Awaited<ReturnType<typeof getOwnedWorkspace>>): Promise<void> => {
    if (!workspace) return
    const [defaultProject, projects] = await Promise.all([
      ensureDraftProject(supabase, userId, workspace),
      listProjects(supabase, workspace.id),
    ])
    workspaces.push({
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      scopeType: workspace.scope_type,
      defaultProject,
      projects,
    })
  }

  await pushWorkspace(personal)
  for (const organization of organizations) {
    await pushWorkspace(await getAccessibleWorkspace(supabase, organization.workspaceSlug))
  }

  return { models, workspaces }
}
