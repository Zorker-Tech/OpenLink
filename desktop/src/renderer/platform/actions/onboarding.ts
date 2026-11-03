import type { NicknameActionState } from '@/lib/desktop-api/action-types'

import { callDesktopAction } from '../api'

function formDataInput(formData: FormData): Record<string, string> {
  const input: Record<string, string> = {}
  formData.forEach((value, key) => {
    if (typeof value === 'string') input[key] = value
  })
  return input
}

export async function saveNickname(
  _previousState: NicknameActionState,
  formData: FormData,
): Promise<NicknameActionState> {
  const result = await callDesktopAction<NicknameActionState | null>(
    'onboarding.saveNickname',
    formDataInput(formData),
  )
  return result ?? { error: null }
}

export type { NicknameActionState }
