import { resolveAppEntry } from '@/lib/workspaces'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { getDefaultProject } from '@/lib/projects'
import { listCloudConnections } from '@/lib/platform-cloud-connection.server'
import { cloudProjectLinksForRequest } from '@/lib/platform-cloud-project.server'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

function withPrompt(path: string, prompt?: string) {
  return prompt ? `${path}?prompt=${encodeURIComponent(prompt)}` : path
}

async function hasAccessibleCloudProject(supabase: Parameters<typeof resolveAppEntry>[0], workspaceId: string) {
  try {
    const project = await getDefaultProject(supabase, workspaceId)
    if (!project) return false
    const connections = await listCloudConnections()
    const connection = connections.find((item) => ['active', 'refreshing'].includes(item.state))
    if (!connection) return false
    const links = await cloudProjectLinksForRequest()
    await links.resolve(project.id, connection.id)
    return true
  } catch {
    return false
  }
}

export default async function AppEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string }>
}) {
  const { prompt } = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(withPrompt('/app', prompt))}`)
  }

  const entry = await resolveAppEntry(supabase, user)

  if (entry.needsOnboarding) {
    redirect(withPrompt('/app/onboarding', prompt))
  }

  if (entry.needsOrganizationOnboarding) {
    const step = getRuntimeMode() === 'cloud' ? 'project' : 'organization'
    const path = `/app/onboarding?step=${step}`
    redirect(prompt ? `${path}&prompt=${encodeURIComponent(prompt)}` : path)
  }

  if (
    getRuntimeMode() === 'cloud' &&
    !(await hasAccessibleCloudProject(supabase, entry.workspace.id))
  ) {
    redirect(withPrompt('/app/onboarding?step=project', prompt))
  }

  redirect(withPrompt(`/app/${entry.workspace.slug}`, prompt))
}
