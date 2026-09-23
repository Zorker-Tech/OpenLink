'use server'

import {
  createProject,
  type CreateProjectInput,
  type ProjectKind,
  type ProjectDiskMode,
  type ProjectExecutionMode,
  type ProjectSourceType,
} from '@/lib/projects'
import { getAccessibleWorkspace } from '@/lib/workspaces'
import { getT } from '@/lib/i18n/server'
import type { Translator } from '@/lib/i18n/messages'
import { createClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'

export interface CreateProjectActionInput {
  workspaceSlug: string
  name: string
  kind: ProjectKind
  sourceType: ProjectSourceType
  sourceUrl?: string
  description?: string
  diskMode: ProjectDiskMode
  executionMode: ProjectExecutionMode
  sshTarget?: {
    host: string
    port: number
    user: string
    remoteRoot: string
    privateKey: string
    knownHosts: string
  }
}

export type CreateProjectActionResult =
  | { project: Awaited<ReturnType<typeof createProject>>; error: null }
  | { project: null; error: string }

function projectErrorMessage(error: unknown, t: Translator) {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('INVALID_GITHUB_URL') || message.includes('projects_source_shape_check')) {
    return t('请输入有效的 GitHub 仓库地址。')
  }
  if (message.includes('42501') || message.toLowerCase().includes('row-level security')) {
    return t('你没有权限在这个组织工作区创建项目。')
  }
  if (message.includes('PROJECT_SLUG_CONFLICT') || message.includes('23505')) {
    return t('无法生成唯一的项目地址，请换一个名称。')
  }
  if (message.includes('INVALID_SSH_TARGET')) {
    return t('请填写有效的 SSH 主机、用户、绝对工作目录和私钥。')
  }
  return t('暂时无法创建项目，请稍后重试。')
}

export async function createProjectAction(
  input: CreateProjectActionInput,
): Promise<CreateProjectActionResult> {
  const { t } = await getT()
  const name = input.name?.trim() ?? ''
  const workspaceSlug = input.workspaceSlug?.trim() ?? ''
  const description = input.description?.trim() ?? ''
  const allowedKinds: ProjectKind[] = ['code', 'research']
  const allowedSourceTypes: ProjectSourceType[] = ['blank', 'github']
  const allowedDiskModes: ProjectDiskMode[] = ['thin', 'thick']
  const allowedExecutionModes: ProjectExecutionMode[] = ['local', 'ssh']

  if (!workspaceSlug || name.length < 1 || name.length > 100) {
    return { project: null, error: t('项目名称需要包含 1–100 个字符。') }
  }
  if (!allowedKinds.includes(input.kind) || !allowedSourceTypes.includes(input.sourceType) || !allowedDiskModes.includes(input.diskMode) || !allowedExecutionModes.includes(input.executionMode)) {
    return { project: null, error: t('项目类型无效。') }
  }
  if (description.length > 2000) {
    return { project: null, error: t('项目描述不能超过 2000 个字符。') }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { project: null, error: t('登录状态已失效，请重新登录。') }

  const workspace = await getAccessibleWorkspace(supabase, workspaceSlug)
  if (!workspace) return { project: null, error: t('找不到当前工作区。') }

  const projectInput: CreateProjectInput = {
    name,
    kind: input.kind,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
    description,
    diskMode: input.diskMode,
    executionMode: input.executionMode,
    sshTarget: input.sshTarget,
  }

  try {
    const project = await createProject(supabase, user.id, workspace, projectInput)
    revalidatePath(`/app/${workspace.slug}`)
    revalidatePath(`/app/${workspace.slug}/projects`)
    return { project, error: null }
  } catch (error) {
    return { project: null, error: projectErrorMessage(error, t) }
  }
}
