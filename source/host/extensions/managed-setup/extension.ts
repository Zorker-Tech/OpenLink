import { bestEffortAccessToken, startManagedSkillsWhenAuthenticated } from "./auth-lifecycle.ts"
import type { ManagedSetupContext, RenewalEvent } from "./extension-contracts.ts"

export { bestEffortAccessToken, startManagedSkillsWhenAuthenticated } from "./auth-lifecycle.ts"
export type { ManagedAuthPort, ManagedSetupContext, RenewalEvent } from "./extension-contracts.ts"

export const managedSetupExtension = {
  id: "managed-setup",
  dependencies: ["auth", "telemetry"] as const,
  start(context: ManagedSetupContext) {
    const identity = context.deps.auth
    const reportDiagnostic = (event: unknown) => context.deps.telemetry?.logs.reportHostExtensionDiagnostic(event)
    const accessToken = bestEffortAccessToken(identity)
    const managedSkills = context.createManagedSkills({ getAccessToken: accessToken, report: reportDiagnostic })
    const stopManagingSkills = startManagedSkillsWhenAuthenticated({ auth: identity, service: managedSkills })
    const teamRules = context.createTeamRules({ auth: identity, report: reportDiagnostic })

    const handleRenewal = (event: RenewalEvent): void => {
      if (event.outcome === "renewed" && event.isFirstCredential) teamRules.refresh()
    }
    const stopRenewalListener = identity.subscribeToRenewal?.(handleRenewal) ?? (() => {})
    const dispose = (): void => {
      stopRenewalListener()
      stopManagingSkills()
      managedSkills.dispose()
    }

    context.onStop(dispose)
    const lastRenewal = identity.getLastRenewalEvent?.()
    if (lastRenewal != null) handleRenewal(lastRenewal)
    teamRules.start()

    return {
      dispose,
      skillsCatalog: () => context.fetchSkillCatalog(accessToken),
      ensureManagedSkill: (id: string) => managedSkills.ensureSkillIsCached(id),
      resolveTeamRules: () => teamRules.resolveRules(),
    }
  },
}
