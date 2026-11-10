import { pinMcpDiagnosticsReporter } from "../../shared/node/mcp/mcp-diagnostics.ts"
import { HostExtensions } from "../extensions/extension-ids.generated.ts"
import type { McpHostService } from "./mcp-service.ts"
import { startPluginSkillsWhenAuthenticated } from "./plugin-skills-lifecycle.ts"
import type { AuthRenewalPort, McpPluginSkillsService, PollingPort } from "./plugin-skills-lifecycle.ts"

export { startPluginSkillsWhenAuthenticated } from "./plugin-skills-lifecycle.ts"
export type { AuthRenewalPort, McpPluginSkillsService, PollingPort } from "./plugin-skills-lifecycle.ts"

export type McpAuthCleanupOutcome = "not_found" | "error" | "deleted"

export interface McpExtensionContext {
  deps: {
    auth: AuthRenewalPort
    telemetry: {
      logs: {
        reportHostExtensionDiagnostic(event: unknown): void
        reportMcpAuthCleanup(outcome: "ok" | "error", removedCount: number): void
      }
    }
  }
  createPluginSkills(): McpPluginSkillsService
  createPolling(): PollingPort
  createService(pluginSkills: McpPluginSkillsService): McpHostService
  createSkillPublish(pluginSkills: McpPluginSkillsService): unknown
  cleanupLegacyAuth?(): Promise<{ outcome: McpAuthCleanupOutcome; removedCount: number }>
  sweepLegacyReferences?(): Promise<void>
  onStop(fn: () => void | Promise<void>): void
}

export const mcpExtension = {
  id: HostExtensions.Mcp,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.ForeverBox, HostExtensions.Settings, HostExtensions.Telemetry] as const,
  async start(context: McpExtensionContext) {
    pinMcpDiagnosticsReporter((failure) =>
      context.deps.telemetry.logs.reportHostExtensionDiagnostic({ extension: HostExtensions.Mcp, ...failure }),
    )

    try {
      const cleanup = await context.cleanupLegacyAuth?.()
      if (cleanup != null) {
        const outcome = cleanup.outcome === "error" ? "error" : "ok"
        context.deps.telemetry.logs.reportMcpAuthCleanup(outcome, cleanup.removedCount)
      }
    } catch {
      // Legacy cleanup is housekeeping and does not block the live host service.
    }

    const pluginSkills = context.createPluginSkills()
    const stopStartup = startPluginSkillsWhenAuthenticated({
      auth: context.deps.auth,
      service: pluginSkills,
      polling: context.createPolling(),
      onStartupSyncSucceeded: () => {
        void context.sweepLegacyReferences?.()
      },
    })
    const service = context.createService(pluginSkills)
    const skillPublish = context.createSkillPublish(pluginSkills)
    context.onStop(async () => {
      stopStartup()
      pluginSkills.dispose()
      await service.dispose()
    })
    return { ...service.api, skillPublish }
  },
}
