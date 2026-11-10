/**
 * Composes the host-specific services behind the MCP extension ports.
 */
import { createRealPollingPolicy } from "../extensions/scheduling.ts"
import { getSlateInferenceBackendUrl } from "../../adapters/interop/slate-backend/slate-backend-client.ts"
import { cleanupLegacyMcpAuthCredentials } from "../../shared/node/mcp/mcp-auth-cleanup.ts"
import type { McpManagerSettingsPort } from "../../shared/node/mcp/mcp-manager.ts"
import { getSlateRootDir } from "../host-paths.ts"
import type { McpExtensionContext, McpPluginSkillsService } from "./extension.ts"
import { projectPluginSkillsForMcpHost } from "./mcp-production-plugin-skills-port.ts"
import type { McpProductionContext } from "./mcp-production-contracts.ts"
import { createMcpService, type McpHostService } from "./mcp-service.ts"
import { createSharedInstalledPluginsLoader, PLUGIN_SKILLS_REFRESH_INTERVAL_MS, SlatePluginSkillsService } from "../skills/plugin-skills.ts"
import { SkillMarketplacePublisher, type SkillMarketplacePublisherOptions } from "../skills/skill-publish.ts"
import { createSlateSkillPublishClient } from "../../adapters/interop/agent/skill-publish-dashboard-adapter.ts"
import { sweepLegacyPluginSkillReferences } from "./legacy-live-references.ts"

export type { McpProductionAuth } from "./mcp-production-contracts.ts"

export function createMcpProductionExtras(
  context: McpProductionContext,
): Omit<McpExtensionContext, "deps" | "onStop"> {
  const dependencies = context.deps
  const rootDirectory = getSlateRootDir()
  const auth = dependencies.auth
  const writeLog = (message: string): void => context.host.log(message)

  const createPluginSkills = (): McpPluginSkillsService => new SlatePluginSkillsService({
    slateRootDir: rootDirectory,
    load: createSharedInstalledPluginsLoader({
      slateRootDir: rootDirectory,
      auth,
      isSparsePluginClonesEnabled: () => dependencies.experiments.isSparsePluginClonesEnabled(),
      log: writeLog,
    }),
    log: writeLog,
    reportSync: event => dependencies.telemetry.logs.reportPluginSkillsSync(event),
  })

  const createService = (skills: McpPluginSkillsService): McpHostService => createMcpService({
    auth,
    foreverBox: dependencies["forever-box"],
    settings: dependencies.settings as McpManagerSettingsPort,
    pluginSkills: projectPluginSkillsForMcpHost(skills, rootDirectory),
    onDiscoveryFailed: event => dependencies.telemetry.logs.reportMcpDiscoveryFailed(event),
    onConnectorAuth: event => dependencies.telemetry.logs.reportConnectorAuth(event),
    log: writeLog,
  })

  const createSkillPublish = (skills: McpPluginSkillsService) => {
    const options: SkillMarketplacePublisherOptions = {
      slateRootDir: rootDirectory,
      client: createSlateSkillPublishClient({ auth }),
      pluginSkills: skills,
      log: writeLog,
      reportEdgeFailed: event => dependencies.telemetry.logs.reportSkillPublishEdgeFailed(event),
    }
    return new SkillMarketplacePublisher(options)
  }

  return {
    createPluginSkills,
    createPolling: () => createRealPollingPolicy({
      name: "slate-plugin-skills-refresh",
      intervalMs: PLUGIN_SKILLS_REFRESH_INTERVAL_MS,
    }),
    createService,
    createSkillPublish,
    cleanupLegacyAuth: async () => cleanupLegacyMcpAuthCredentials(rootDirectory),
    sweepLegacyReferences: async () => {
      await sweepLegacyPluginSkillReferences({
        slateRootDir: rootDirectory,
        auth,
        backendUrl: getSlateInferenceBackendUrl(),
        log: writeLog,
      })
    },
  }
}
