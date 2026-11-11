import 'server-only'

import {
  approveAccessWriteAction,
  createChatSessionAction,
  deleteChatSessionAction,
  listPendingAccessWritesAction,
  updateChatSessionTitleAction,
} from '@/app/chat/actions'
import {
  createOrganizationAction,
  joinOrganizationAction,
  skipOrganizationAction,
} from '@/app/app/organization-actions'
import { createProjectAction } from '@/app/app/project-actions'
import { saveNickname } from '@/app/app/onboarding/actions'
import { selectCloudProjectAction } from '@/app/app/onboarding/cloud-project-actions'
import {
  checkAiProviderConfigurationAction,
  fetchProviderModelsAction,
  saveAiProviderConfigurationAction,
  saveEmbeddingProviderConfigurationAction,
  saveUserPreferencesAction,
  toggleAiProviderEnabledAction,
} from '@/app/settings/actions'
import {
  createUserSkillAction,
  deleteUserSkillAction,
  saveUserSkillAction,
} from '@/app/settings/skills/actions'

export type DesktopActionResult =
  | { ok: true; result?: unknown; redirect?: string }
  | { ok: false; status: number; error: string }

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

function asFormData(input: unknown): FormData {
  const formData = new FormData()
  for (const [key, value] of Object.entries(asRecord(input))) {
    if (value === undefined || value === null) continue
    formData.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return formData
}

function sessionIdInput(input: unknown): string {
  if (typeof input === 'string') return input
  const record = asRecord(input)
  return typeof record.sessionId === 'string' ? record.sessionId : ''
}

function redirectPath(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('digest' in error)) return null
  const digest = (error as { digest?: unknown }).digest
  if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT')) return null
  // Next encodes redirects as `NEXT_REDIRECT;<push|replace>;<path>;<status>;`.
  const parts = digest.split(';')
  const path = parts[2]
  return path && path.startsWith('/') ? path : null
}

async function invoke(fn: () => Promise<unknown>): Promise<DesktopActionResult> {
  try {
    return { ok: true, result: await fn() }
  } catch (error) {
    const redirect = redirectPath(error)
    if (redirect) return { ok: true, redirect }
    if (error && typeof error === 'object' && 'digest' in error) {
      const digest = (error as { digest?: unknown }).digest
      if (typeof digest === 'string' && digest.startsWith('NEXT_HTTP_ERROR_FALLBACK;404')) {
        return { ok: false, status: 404, error: 'NOT_FOUND' }
      }
    }
    const message = error instanceof Error ? error.message : 'DESKTOP_ACTION_FAILED'
    return {
      ok: false,
      status: message === 'AUTH_REQUIRED' ? 401 : 500,
      error: message,
    }
  }
}

const handlers: Record<string, (input: unknown) => Promise<DesktopActionResult>> = {
  'chat.create': (input) => invoke(() => createChatSessionAction(asRecord(input))),
  'chat.updateTitle': (input) => {
    const record = asRecord(input)
    return invoke(() =>
      updateChatSessionTitleAction({
        sessionId: String(record.sessionId ?? ''),
        title: String(record.title ?? ''),
      }),
    )
  },
  'chat.listPendingAccessWrites': (input) =>
    invoke(() => listPendingAccessWritesAction(sessionIdInput(input))),
  'chat.approveAccessWrite': (input) => {
    const record = asRecord(input)
    return invoke(() =>
      approveAccessWriteAction(String(record.sessionId ?? ''), String(record.confirmationId ?? '')),
    )
  },
  'chat.delete': (input) => invoke(() => deleteChatSessionAction(sessionIdInput(input))),

  'settings.savePreferences': (input) => invoke(() => saveUserPreferencesAction(input)),
  'settings.saveProvider': (input) => invoke(() => saveAiProviderConfigurationAction(input)),
  'settings.saveEmbeddingProvider': (input) =>
    invoke(() => saveEmbeddingProviderConfigurationAction(input)),
  'settings.toggleProvider': (input) => {
    const record = asRecord(input)
    return invoke(() =>
      toggleAiProviderEnabledAction(String(record.providerId ?? ''), Boolean(record.enabled)),
    )
  },
  'settings.checkProvider': (input) => {
    const record = asRecord(input)
    return invoke(() =>
      checkAiProviderConfigurationAction(
        String(record.providerId ?? ''),
        String(record.modelId ?? ''),
      ),
    )
  },
  'settings.fetchProviderModels': (input) => invoke(() => fetchProviderModelsAction(input)),

  'skills.create': (input) => invoke(() => createUserSkillAction(input)),
  'skills.save': (input) => invoke(() => saveUserSkillAction(input)),
  'skills.delete': (input) => invoke(() => deleteUserSkillAction(sessionIdInput(input))),

  'projects.create': (input) => invoke(() => createProjectAction(input as never)),

  'organization.create': (input) =>
    invoke(() => createOrganizationAction({ error: null }, asFormData(input))),
  'organization.join': (input) =>
    invoke(() => joinOrganizationAction({ error: null }, asFormData(input))),
  'organization.skip': (input) =>
    invoke(() => skipOrganizationAction({ error: null }, asFormData(input))),

  'onboarding.saveNickname': (input) =>
    invoke(() => saveNickname({ error: null }, asFormData(input))),
  'onboarding.selectCloudProject': (input) =>
    invoke(() => selectCloudProjectAction({ error: null }, asFormData(input))),
}

export const DESKTOP_ACTIONS = Object.keys(handlers)

export async function runDesktopAction(
  action: string,
  input: unknown,
): Promise<DesktopActionResult> {
  const handler = handlers[action]
  if (!handler) return { ok: false, status: 404, error: 'ACTION_NOT_FOUND' }
  return handler(input)
}
