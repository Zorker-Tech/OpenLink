'use server'

import { cloudProjectLinksForRequest } from '@/lib/platform-cloud-project.server'
import { CloudProjectLinkError } from '@/lib/platform-cloud-project'
import { CloudConnectionError } from '@/lib/platform-cloud-connection.server'
import { getCloudComputerInfo } from '@/lib/platform-cloud-host.server'
import { ensureDraftProject } from '@/lib/projects'
import { getCloudConnection } from '@/lib/platform-cloud-connection.server'
import { completeOrganizationOnboarding, ensureWorkspace, getDefaultNickname } from '@/lib/workspaces'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { createClient } from '@/utils/supabase/server'
import { getT } from '@/lib/i18n/server'
import type { Translator } from '@/lib/i18n/messages'
import { redirect } from 'next/navigation'

export interface SelectCloudProjectActionState {
  error: string | null
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function withPrompt(path: string, prompt: string) {
  return prompt ? `${path}?prompt=${encodeURIComponent(prompt)}` : path
}

function cloudProjectErrorMessage(error: unknown, t: Translator) {
  if (error instanceof CloudConnectionError && error.message === 'CLOUD_COMPUTER_UNAVAILABLE') {
    return t('已连接 VTSLX 账号，但暂时无法访问所选项目的 Computer，请刷新后重试。')
  }
  if (error instanceof CloudProjectLinkError) {
    if (error.status === 403) return t('该 Studio 项目当前账号不可访问，请刷新列表后重试。')
    if (error.status === 409) return t('项目关联状态已变化，请刷新页面后重试。')
  }
  return t('暂时无法关联该 Studio 项目，请稍后重试。')
}

export async function selectCloudProjectAction(
  _previousState: SelectCloudProjectActionState,
  formData: FormData,
): Promise<SelectCloudProjectActionState> {
  const { t } = await getT()
  if (getRuntimeMode() !== 'cloud') return { error: t('此项目选择仅适用于 Cloud 模式。') }

  const connectionId = String(formData.get('connectionId') ?? '').trim()
  const platformProjectRef = String(formData.get('platformProjectRef') ?? '').trim()
  const prompt = String(formData.get('prompt') ?? '').trim()
  if (!uuid.test(connectionId) || !uuid.test(platformProjectRef))
    return { error: t('请选择一个有效的 Studio 项目。') }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent('/app/onboarding?step=project')}`)

  try {
    // Validate the user's current SDK grant and selected project before
    // creating any OpenLink workspace/project rows. The link write below
    // repeats this visibility check to close the race with membership changes.
    const connection = await getCloudConnection(connectionId)
    if (!['active', 'refreshing'].includes(connection.state)) {
      throw new CloudProjectLinkError(409, 'CLOUD_CONNECTION_INACTIVE')
    }
    const visibleProjects = await connection.sdk.listProjects()
    if (!visibleProjects.some((project) => project.id.toLowerCase() === platformProjectRef.toLowerCase())) {
      throw new CloudProjectLinkError(403, 'CLOUD_PROJECT_NOT_ACCESSIBLE')
    }

    const { data: profile, error: profileError } = await supabase
      .schema('openlink')
      .from('profiles')
      .select('nickname, nickname_confirmed')
      .eq('user_id', user.id)
      .maybeSingle()
    if (profileError) throw profileError
    const typedProfile = profile as { nickname?: string | null; nickname_confirmed?: boolean } | null
    if (!typedProfile?.nickname_confirmed) redirect('/app/onboarding')

    const workspace = await ensureWorkspace(
      supabase,
      user,
      typedProfile.nickname?.trim() || getDefaultNickname(user),
    )
    const project = await ensureDraftProject(supabase, user.id, workspace)
    const links = await cloudProjectLinksForRequest()
    const current = await links.read(project.id)

    if (current.link?.platform_project_ref !== platformProjectRef) {
      await links.set(
        project.id,
        connectionId,
        platformProjectRef,
        current.link?.revision ?? 0,
      )
    }
    // Confirm the Cloud SDK Host can reach the user's selected Studio
    // Computer before completing onboarding. The project link itself remains
    // metadata only; this read check does not provision or mutate a runtime.
    await getCloudComputerInfo(project.id, connectionId)

    await completeOrganizationOnboarding(supabase, user.id)
    redirect(withPrompt(`/app/${workspace.slug}`, prompt))
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error
    return { error: cloudProjectErrorMessage(error, t) }
  }
}
