'use server'

import { getT } from '@/lib/i18n/server'
import { confirmNickname } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export interface NicknameActionState {
  error: string | null
}

export async function saveNickname(
  _previousState: NicknameActionState,
  formData: FormData,
): Promise<NicknameActionState> {
  const nickname = String(formData.get('nickname') ?? '').trim()
  const prompt = String(formData.get('prompt') ?? '').trim()
  const { t } = await getT()

  if (!nickname || nickname.length > 64) {
    return { error: t('昵称需要包含 1–64 个字符。') }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect(`/login?next=${encodeURIComponent('/app/onboarding')}`)
  }

  try {
    await confirmNickname(supabase, user, nickname)
    const target = `/app/onboarding?step=organization${prompt ? `&prompt=${encodeURIComponent(prompt)}` : ''}`
    redirect(target)
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error
    return { error: error instanceof Error ? error.message : t('暂时无法创建工作区，请重试。') }
  }
}
