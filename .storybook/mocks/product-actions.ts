import { fn } from 'storybook/test'

// These exports are aliased only by Storybook; production actions are unchanged.
export const saveUserPreferencesAction = fn(async (_input: unknown) => ({ ok: true, error: null }))
export const saveAiProviderConfigurationAction = fn(async (_input: unknown) => ({ ok: true, error: null }))
export const saveEmbeddingProviderConfigurationAction = fn(async (_input: unknown) => ({ ok: true, error: null }))
export const toggleAiProviderEnabledAction = fn(async (_id: string, _enabled: boolean) => ({ ok: true, error: null }))
export const checkAiProviderConfigurationAction = fn(async () => ({ ok: true, error: null, latencyMs: 120 }))
export const fetchProviderModelsAction = fn(async () => ({ ok: true, models: [], error: null }))
export const createUserSkillAction = fn(async () => ({ ok: true, skill: { id: 'fixture-skill', slug: 'review', name: 'Review' }, error: null }))
export const saveUserSkillAction = fn(async () => ({ ok: true, error: null }))
export const deleteUserSkillAction = fn(async () => ({ ok: true, error: null }))
export type OrganizationActionState = { error: string | null }
export const createOrganizationAction = fn(async () => ({ error: 'Storybook 演示：不创建真实组织。' }))
export const joinOrganizationAction = fn(async () => ({ error: 'Storybook 演示：不加入真实组织。' }))
export const skipOrganizationAction = fn(async () => undefined)
export const createProjectAction = fn(async () => ({ project: null, error: 'Storybook 演示：不启动真实项目。' }))
