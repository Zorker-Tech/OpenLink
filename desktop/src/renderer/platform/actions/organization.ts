import type { OrganizationActionState } from '@/lib/desktop-api/action-types'

import { callDesktopAction } from '../api'

function formDataInput(formData: FormData): Record<string, string> {
  const input: Record<string, string> = {}
  formData.forEach((value, key) => {
    if (typeof value === 'string') input[key] = value
  })
  return input
}

async function submit(
  action: string,
  formData: FormData,
): Promise<OrganizationActionState> {
  const result = await callDesktopAction<OrganizationActionState | null>(
    action,
    formDataInput(formData),
  )
  return result ?? { error: null }
}

export async function createOrganizationAction(
  _previousState: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  return submit('organization.create', formData)
}

export async function joinOrganizationAction(
  _previousState: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  return submit('organization.join', formData)
}

export async function skipOrganizationAction(
  _previousState: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  return submit('organization.skip', formData)
}

export type { OrganizationActionState }
