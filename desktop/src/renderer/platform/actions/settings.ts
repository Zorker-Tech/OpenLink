import type {
  AiProviderConfigurationSummary,
  EmbeddingProviderConfigurationSummary,
  FetchProviderModelsResult,
} from '@/lib/desktop-api/action-types'

import { callDesktopAction } from '../api'

function formDataInput(formData: FormData): Record<string, string> {
  const input: Record<string, string> = {}
  formData.forEach((value, key) => {
    if (typeof value === 'string') input[key] = value
  })
  return input
}

export async function saveUserPreferencesAction(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await callDesktopAction<{ ok: true } | { ok: false; error: string }>(
    'settings.savePreferences',
    input,
  )
  const locale =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as { locale?: unknown }).locale
      : undefined
  if (result?.ok && typeof locale === 'string') {
    window.dispatchEvent(new CustomEvent('openlink:locale', { detail: locale }))
  }
  return result
}

export async function saveAiProviderConfigurationAction(
  input: unknown,
): Promise<
  | { ok: true; configuration: AiProviderConfigurationSummary }
  | { ok: false; error: string }
> {
  return callDesktopAction<
    | { ok: true; configuration: AiProviderConfigurationSummary }
    | { ok: false; error: string }
  >('settings.saveProvider', input)
}

export async function saveEmbeddingProviderConfigurationAction(
  input: unknown,
): Promise<
  | { ok: true; configuration: EmbeddingProviderConfigurationSummary }
  | { ok: false; error: string }
> {
  return callDesktopAction<
    | { ok: true; configuration: EmbeddingProviderConfigurationSummary }
    | { ok: false; error: string }
  >('settings.saveEmbeddingProvider', input)
}

export async function toggleAiProviderEnabledAction(
  providerId: string,
  enabled: boolean,
): Promise<
  | { ok: true; configuration: AiProviderConfigurationSummary }
  | { ok: false; error: string }
> {
  return callDesktopAction<
    | { ok: true; configuration: AiProviderConfigurationSummary }
    | { ok: false; error: string }
  >('settings.toggleProvider', { providerId, enabled })
}

export async function checkAiProviderConfigurationAction(
  providerId: string,
  modelId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return callDesktopAction<{ ok: true } | { ok: false; error: string }>('settings.checkProvider', { providerId, modelId })
}

export async function fetchProviderModelsAction(
  input: unknown,
): Promise<FetchProviderModelsResult> {
  return callDesktopAction<FetchProviderModelsResult>('settings.fetchProviderModels', input)
}

export { formDataInput }
