import type { SelectCloudProjectActionState } from '@/lib/desktop-api/action-types'

import { callDesktopAction } from '../api'

function formDataInput(formData: FormData): Record<string, string> {
  const input: Record<string, string> = {}
  formData.forEach((value, key) => {
    if (typeof value === 'string') input[key] = value
  })
  return input
}

export async function selectCloudProjectAction(
  _previousState: SelectCloudProjectActionState,
  formData: FormData,
): Promise<SelectCloudProjectActionState> {
  const result = await callDesktopAction<SelectCloudProjectActionState | null>(
    'onboarding.selectCloudProject',
    formDataInput(formData),
  )
  return result ?? { error: null }
}

export type { SelectCloudProjectActionState }
