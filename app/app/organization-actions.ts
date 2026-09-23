'use server'

import { createOrganization, joinOrganization } from '@/lib/organizations'
import {
  completeOrganizationOnboarding,
  ensureWorkspace,
  getDefaultNickname,
} from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { getT } from '@/lib/i18n/server'
import type { Translator } from '@/lib/i18n/messages'
import { redirect } from 'next/navigation'

export interface OrganizationActionState {
  error: string | null
}

function withPrompt(path: string, prompt: string) {
  return prompt ? `${path}?prompt=${encodeURIComponent(prompt)}` : path
}

function organizationErrorMessage(error: unknown, t: Translator) {
  const message = error instanceof Error ? error.message : ''

  if (message.includes('INVALID_JOIN_CODE')) return t('邀请码无效，请检查后重试。')
  if (message.includes('ORGANIZATION_SLUG_CONFLICT') || message.includes('23505')) {
    return t('该组织名称已被使用，请换一个名称。')
  }
  if (message.includes('AUTH_REQUIRED') || message.includes('JWT')) return t('登录状态已失效，请重新登录。')
  return t('暂时无法完成操作，请稍后重试。')
}

export async function createOrganizationAction(
  _previousState: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  const { t } = await getT()
  const name = String(formData.get('organizationName') ?? '').trim()
  const prompt = String(formData.get('prompt') ?? '').trim()

  if (!name || name.length > 80) {
    return { error: t('组织名称需要包含 1–80 个字符。') }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/app')

  let result
  try {
    result = await createOrganization(supabase, name, user.id)
  } catch (error) {
    return { error: organizationErrorMessage(error, t) }
  }

  if (!result) return { error: t('组织创建失败，请重试。') }
  redirect(withPrompt(`/app/${result.workspace_slug}`, prompt))
}

export async function joinOrganizationAction(
  _previousState: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  const { t } = await getT()
  const code = String(formData.get('joinCode') ?? '').trim()
  const prompt = String(formData.get('prompt') ?? '').trim()

  if (code.length < 6 || code.length > 32) {
    return { error: t('请输入有效的邀请码。') }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/app')

  let result
  try {
    result = await joinOrganization(supabase, code)
  } catch (error) {
    return { error: organizationErrorMessage(error, t) }
  }

  if (!result) return { error: t('加入组织失败，请重试。') }
  redirect(withPrompt(`/app/${result.workspace_slug}`, prompt))
}

export async function skipOrganizationAction(formData: FormData) {
  const prompt = String(formData.get('prompt') ?? '').trim()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/app')

  const { data: profile } = await supabase
    .schema('openlink')
    .from('profiles')
    .select('nickname')
    .eq('user_id', user.id)
    .maybeSingle()

  const nickname = (profile as { nickname?: string } | null)?.nickname ?? getDefaultNickname(user)
  const workspace = await ensureWorkspace(supabase, user, nickname)
  await completeOrganizationOnboarding(supabase, user.id)
  redirect(withPrompt(`/app/${workspace.slug}`, prompt))
}
