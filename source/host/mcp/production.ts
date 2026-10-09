/**
 * MCP, as the host runs it.
 *
 * The extension's own file says what MCP does; this says what it is made of: the plugin skills service and the loader
 * behind it, the polling that refreshes them, the MCP host service, the skill publish service, and the two pieces of
 * old-layout cleanup. Everything the host reports about these edges goes to the telemetry log it was handed, and the
 * skills are read from (and published to) the host's own root.
 */

import type { HostExtensionContext } from "../extensions/host-extensions.ts";
import { createRealPollingPolicy } from "../extensions/scheduling.ts";
import { getSlateInferenceBackendUrl } from "../../shared/node/cursor-backend/cursor-inference.ts";
import { cleanupLegacyMcpAuthCredentials } from "../../shared/node/mcp/mcp-auth-cleanup.ts";
import type { CapableBox } from "../boxes/box-capabilities.ts";
import { getSlateRootDir } from "../host-paths.ts";
import type { McpExtensionContext, McpPluginSkillsService } from "./extension.ts";
import { removeWorkflowLiveReferences, sweepLegacyPluginSkillReferences } from "./legacy-live-references.ts";
import type { McpManagerSettingsPort } from "../../shared/node/mcp/mcp-manager.ts";
import { createMcpService, type McpHostService, type PluginSkillsPort } from "./mcp-service.ts";
import { createSharedInstalledPluginsLoader, PLUGIN_SKILLS_REFRESH_INTERVAL_MS, SlatePluginSkillsService, toPluginSkillInfo } from "../skills/plugin-skills.ts";
import { createSlateSkillPublishClient, SlateSkillPublishService, type SlateSkillPublishServiceOptions } from "../skills/skill-publish.ts";

export interface McpProductionAuth {
  getAccessToken(args: { backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
  peekAccessToken(): string | null;
  subscribeToRenewal(listener: (event: { outcome: string; isFirstCredential?: boolean }) => void): () => void;
}

interface McpProductionDeps {
  auth: McpProductionAuth;
  experiments: { isSparsePluginClonesEnabled(): boolean };
  "forever-box": { readonly box: CapableBox };
  settings: unknown;
  telemetry: {
    logs: {
      reportMcpDiscoveryFailed(event: unknown): void;
      reportConnectorAuth(event: unknown): void;
      reportPluginSkillsSync(event: unknown): void;
      reportSkillPublishEdgeFailed(event: unknown): void;
    };
  };
}

type ProductionContext = HostExtensionContext<{ log(message: string): void }> & { readonly deps: McpProductionDeps };

export function createMcpProductionExtras(context: ProductionContext): Omit<McpExtensionContext, "deps" | "onStop"> {
  const slateRootDir = getSlateRootDir();
  const auth = context.deps.auth;
  const log = (message: string): void => context.host.log(message);
  /** The plugin skills as the MCP host reads them: a record is named the way the host names a skill. */
  const asPluginSkillsPort = (service: McpPluginSkillsService): PluginSkillsPort => ({
    sync: async (trigger) => (await service.sync(trigger)).map((record) => toPluginSkillInfo(record)),
    status: () => ({ authBlocked: service.currentAuthBlocked() }),
    removeLiveReferences: (sourceUrls) => removeWorkflowLiveReferences(slateRootDir, sourceUrls),
  });

  return {
    createPluginSkills(): McpPluginSkillsService {
      return new SlatePluginSkillsService({
        slateRootDir,
        load: createSharedInstalledPluginsLoader({
          slateRootDir,
          auth,
          isSparsePluginClonesEnabled: () => context.deps.experiments.isSparsePluginClonesEnabled(),
          log,
        }),
        log,
        reportSync: (event) => context.deps.telemetry.logs.reportPluginSkillsSync(event),
      });
    },
    createPolling: () => createRealPollingPolicy({ name: "slate-plugin-skills-refresh", intervalMs: PLUGIN_SKILLS_REFRESH_INTERVAL_MS }),
    createService(pluginSkills: McpPluginSkillsService): McpHostService {
      return createMcpService({
        auth,
        foreverBox: context.deps["forever-box"],
        // The host hands over its own settings object; what the MCP host reads of it is the manager's own port.
        settings: context.deps.settings as McpManagerSettingsPort,
        pluginSkills: asPluginSkillsPort(pluginSkills),
        onDiscoveryFailed: (event) => context.deps.telemetry.logs.reportMcpDiscoveryFailed(event),
        onConnectorAuth: (event) => context.deps.telemetry.logs.reportConnectorAuth(event),
        log,
      });
    },
    createSkillPublish(pluginSkills: McpPluginSkillsService) {
      const options: SlateSkillPublishServiceOptions = {
        slateRootDir,
        client: createSlateSkillPublishClient({ auth }),
        pluginSkills,
        log,
        reportEdgeFailed: (event) => context.deps.telemetry.logs.reportSkillPublishEdgeFailed(event),
      };
      return new SlateSkillPublishService(options);
    },
    cleanupLegacyAuth: async () => await cleanupLegacyMcpAuthCredentials(slateRootDir),
    sweepLegacyReferences: async () => {
      await sweepLegacyPluginSkillReferences({ slateRootDir, auth, backendUrl: getSlateInferenceBackendUrl(), log });
    },
  };
}
