import { isSlateAgentModelSelection } from "../../shared/agents/slate-agent-model.ts"
import { normalizeSlateLocalToolPermission } from "../../shared/local-tool-permission.ts"
import { isKnownTimeZone } from "../../shared/timezone.ts"
import type { SlateSettingsStore } from "../../shared/node/settings/slate-settings-store.ts"
import { isSlateInferenceProvider } from "../../shared/inference-router.ts"
import type { HostSettingsUpdate } from "./settings-contracts.ts"

export interface SettingsUpdateEffects {
  readonly changedFields: readonly string[]
  readonly previousUserTimeZone: string | undefined
  readonly userTimeZone: string | undefined
  readonly featureFlagOverrides: Record<string, boolean> | undefined
}

/** Applies only settings with valid values and reports the notifications the service must publish. */
export function applyHostSettingsUpdate(store: SlateSettingsStore, update: HostSettingsUpdate): SettingsUpdateEffects {
  const previousUserTimeZone = store.getUserTimeZone()
  store.setNotificationConfig(update.notifications ?? {})

  if (update.mcpCustomInstructionsAccountScope === null) store.clearAccountScope()
  else if (update.mcpCustomInstructionsAccountScope !== undefined) store.scopeToAccount(update.mcpCustomInstructionsAccountScope)
  if (update.mcpCustomInstructions !== undefined) store.setMcpCustomInstructions(update.mcpCustomInstructions)
  if (update.mcpCustomInstructionsByServerId !== undefined) store.setMcpCustomInstructionsByServerId(update.mcpCustomInstructionsByServerId)
  if (update.mcpDisabledToolsByServerId !== undefined) store.setMcpDisabledToolsByServerId(update.mcpDisabledToolsByServerId)
  if (update.mcpBoxServers !== undefined) store.setMcpBoxServers(update.mcpBoxServers)
  if (update.userTimeZone !== undefined && (update.userTimeZone === "" || isKnownTimeZone(update.userTimeZone))) store.setUserTimeZone(update.userTimeZone)
  if (update.userTimeZoneOverride !== undefined && (update.userTimeZoneOverride === "" || isKnownTimeZone(update.userTimeZoneOverride))) store.setUserTimeZoneOverride(update.userTimeZoneOverride)
  if (update.agentDefaultModel === null) store.setAgentDefaultModel(undefined)
  else if (isSlateAgentModelSelection(update.agentDefaultModel)) store.setAgentDefaultModel(update.agentDefaultModel)
  if (update.autoReviewInstructions !== undefined) store.setAutoReviewInstructions(update.autoReviewInstructions)
  if (update.localToolPermission !== undefined) store.setLocalToolPermission(normalizeSlateLocalToolPermission(update.localToolPermission))
  if (update.webauthnProxyEnabled !== undefined) store.setWebauthnProxyEnabled(update.webauthnProxyEnabled)
  if (update.pinnedAgentIds !== undefined) store.setPinnedAgentIds(update.pinnedAgentIds)
  if (update.sidebarSections !== undefined) store.setSidebarGrouping(update.sidebarSections)
  if (update.hasSeenOnboarding !== undefined) store.setHasSeenOnboarding(update.hasSeenOnboarding)
  if (isSlateInferenceProvider(update.inferenceProvider)) store.setInferenceProvider(update.inferenceProvider)
  if (update.computerUseModel === null) store.setComputerUseModel(undefined)
  else if (isSlateAgentModelSelection(update.computerUseModel)) store.setComputerUseModel(update.computerUseModel)

  return {
    changedFields: Object.keys(update),
    previousUserTimeZone,
    userTimeZone: store.getUserTimeZone(),
    featureFlagOverrides: update.featureFlagOverrides,
  }
}
