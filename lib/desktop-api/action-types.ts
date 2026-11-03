/**
 * Type-only bridge between the desktop action wrappers and the server action
 * modules. It is imported with `import type`, so Vite erases it completely and
 * the renderer never pulls server-only code into the browser bundle.
 */
export type {
  CreateChatSessionInput,
  CreateChatSessionResult,
  DeleteChatSessionResult,
  PendingAccessWrite,
  UpdateChatSessionAccessModeResult,
  UpdateChatSessionTitleResult,
} from '@/app/chat/actions'
export type { CreateProjectActionInput, CreateProjectActionResult } from '@/app/app/project-actions'
export type { OrganizationActionState } from '@/app/app/organization-actions'
export type { NicknameActionState } from '@/app/app/onboarding/actions'
export type { SelectCloudProjectActionState } from '@/app/app/onboarding/cloud-project-actions'
export type { FetchProviderModelsResult } from '@/app/settings/actions'
export type {
  AiProviderConfigurationSummary,
  EmbeddingProviderConfigurationSummary,
} from '@/lib/ai-provider-types'
