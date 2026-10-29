import type { SlateSettingsStore } from "../../shared/node/settings/slate-settings-store.ts"

/** A renderer snapshot assembled from the store's stable setting boundaries. */
export function projectHostSettings(store: SlateSettingsStore) {
  const userTimeZone = store.getDetectedUserTimeZone()
  const userTimeZoneOverride = store.getUserTimeZoneOverride()
  const agentDefaultModel = store.getAgentDefaultModel()
  const computerUseModel = store.getComputerUseModel()
  const accountScope = store.getMcpCustomInstructionsAccountScope()
  const pinnedAgentIds = store.getPinnedAgentIds()
  const sidebarSections = store.getSidebarGrouping()
  const hasSeenOnboarding = store.getHasSeenOnboarding()

  return {
    notifications: store.getNotificationConfig(),
    mcpCustomInstructions: store.getMcpCustomInstructions(),
    mcpCustomInstructionsByServerId: store.getMcpCustomInstructionsByServerId(),
    mcpDisabledToolsByServerId: store.getMcpDisabledToolsByServerId(),
    ...(accountScope === undefined ? {} : { mcpCustomInstructionsAccountScope: accountScope }),
    mcpBoxServers: store.getMcpBoxServers(),
    autoReviewInstructions: store.getAutoReviewInstructions(),
    localToolPermission: store.getLocalToolPermission(),
    webauthnProxyEnabled: store.getWebauthnProxyEnabled(),
    inferenceProvider: store.getInferenceProvider(),
    inferenceRouterUsage: store.getInferenceRouterUsage(),
    ...(userTimeZone === undefined ? {} : { userTimeZone }),
    ...(userTimeZoneOverride === undefined ? {} : { userTimeZoneOverride }),
    ...(agentDefaultModel === undefined ? {} : { agentDefaultModel }),
    ...(computerUseModel === undefined ? {} : { computerUseModel }),
    ...(pinnedAgentIds === undefined ? {} : { pinnedAgentIds }),
    sidebarSections: sidebarSections ?? [],
    ...(hasSeenOnboarding === undefined ? {} : { hasSeenOnboarding }),
  }
}
