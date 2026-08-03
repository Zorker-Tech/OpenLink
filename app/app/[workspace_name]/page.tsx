import { AppWorkspace } from '@/components/app-workspace'
import { getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'OpenLink App',
}

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace_name: string }>
  searchParams: Promise<{ prompt?: string }>
}) {
  const [{ workspace_name }, { prompt = '' }] = await Promise.all([params, searchParams])
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const next = `/app/${workspace_name}${prompt ? `?prompt=${encodeURIComponent(prompt)}` : ''}`
    redirect(`/login?next=${encodeURIComponent(next)}`)
  }

  const workspace = await getOwnedWorkspace(supabase, user.id, workspace_name)
  if (!workspace) redirect('/app')

  const { data: profile } = await supabase
    .schema('openlink')
    .from('profiles')
    .select('nickname')
    .eq('user_id', user.id)
    .maybeSingle()

  const nickname = (profile as { nickname?: string } | null)?.nickname ?? workspace.name

  return (
    <AppWorkspace
      avatarUrl={getAvatarUrl(user)}
      email={user.email ?? nickname}
      initialPrompt={prompt}
      nickname={nickname}
      workspaceName={workspace.name}
    />
  )
}
