/**
 * MCP, as a host extension.
 *
 * It owns the host's MCP service and the plugin skills behind it, and it decides when the skills are read at all: not
 * before there is a credential to read them with, once when the host is signed in, and again on every poll after that.
 * Two things are written down as it starts — a diagnostic from any of the MCP host's own edges (pinned to the
 * telemetry log, with the extension it came from), and what the cleanup of the old layout's credentials found.
 */

import { pinMcpDiagnosticsReporter } from "../../shared/node/mcp/mcp-diagnostics.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import type { PluginAuthBlock, PluginSkillRecord, PluginSkillsCache } from "../skills/plugin-skills-cache.ts";
import type { McpHostService } from "./mcp-service.ts";

/** The account as this extension reads it: whether there is a credential yet, and when it is renewed. */
export interface AuthRenewalPort {
  getAccessToken?(args: { backendUrl: string }): Promise<string>;
  getMachineId?(): string;
  peekAccessToken(): string | null;
  subscribeToRenewal?(listener: (event: { outcome: string; isFirstCredential?: boolean }) => void): () => void;
  onDidChange?(listener: () => void): () => void;
}

export interface PollingPort {
  start(fn: () => void | Promise<void>): { dispose(): void };
}

/** The plugin skills the extension starts, syncs and lets go of. */
export interface McpPluginSkillsService {
  sync(trigger: string): Promise<PluginSkillRecord[]>;
  handleAuthChange(): void;
  dispose(): void;
  currentIndex(): PluginSkillsCache | null;
  currentAuthBlocked(): PluginAuthBlock[];
}

export type McpAuthCleanupOutcome = "not_found" | "error" | "deleted";

export interface McpExtensionContext {
  deps: {
    auth: AuthRenewalPort;
    telemetry: {
      logs: {
        reportHostExtensionDiagnostic(event: unknown): void;
        reportMcpAuthCleanup(outcome: "ok" | "error", removedCount: number): void;
      };
    };
  };
  createPluginSkills(): McpPluginSkillsService;
  createPolling(): PollingPort;
  createService(pluginSkills: McpPluginSkillsService): McpHostService;
  createSkillPublish(pluginSkills: McpPluginSkillsService): unknown;
  cleanupLegacyAuth?(): Promise<{ outcome: McpAuthCleanupOutcome; removedCount: number }>;
  sweepLegacyReferences?(): Promise<void>;
  onStop(fn: () => void | Promise<void>): void;
}

/**
 * Starts the plugin skills once the host is signed in, and stops them when it is taken down.
 *
 * A credential already in hand starts them at once; otherwise the first renewal that arrives while one is in hand
 * does. From then on the skills are read once (as the startup sync) and again on every poll, a sync that failed is
 * left for the next one, and the first credential after a renewal is what tells the skills the account changed.
 */
export function startPluginSkillsWhenAuthenticated(options: {
  auth: AuthRenewalPort;
  service?: { sync(trigger: string): Promise<unknown>; handleAuthChange?(): void };
  pluginSkills?: { start(): void; handleAuthChange(): void; dispose(): void };
  polling?: PollingPort;
  onStartupSyncSucceeded?: () => void;
}): () => void {
  let started = false;
  let disposed = false;
  let poll: { dispose(): void } | undefined;
  const beginSyncing = (): void => {
    if (options.polling == null) {
      options.pluginSkills?.start();
      return;
    }
    let first = true;
    poll = options.polling.start(async () => {
      const trigger = first ? "startup" : "refresh";
      first = false;
      try {
        await options.service?.sync(trigger);
        // What the host does after the startup sync is only done while it is still up.
        if (trigger === "startup" && !disposed) options.onStartupSyncSucceeded?.();
      } catch {}
    });
  };
  const start = (): void => {
    if (started || disposed) return;
    started = true;
    beginSyncing();
  };
  const onRenewal = (event: { outcome: string; isFirstCredential?: boolean }): void => {
    if (disposed || event.outcome !== "renewed") return;
    // A renewal is also how a host that started signed out learns it can read the skills now.
    if (!started) {
      if (options.auth.peekAccessToken() != null) start();
      return;
    }
    if (event.isFirstCredential === true) {
      const changed = options.service?.handleAuthChange ?? options.pluginSkills?.handleAuthChange;
      changed?.call(options.service ?? options.pluginSkills);
    }
  };
  const unsubscribe = options.auth.subscribeToRenewal?.(onRenewal) ?? options.auth.onDidChange?.(() => onRenewal({ outcome: "renewed", isFirstCredential: true })) ?? (() => {});
  if (options.auth.peekAccessToken() != null) start();
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    poll?.dispose();
    options.pluginSkills?.dispose();
  };
}

export const mcpExtension = {
  id: HostExtensions.Mcp,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.ForeverBox, HostExtensions.Settings, HostExtensions.Telemetry] as const,
  async start(context: McpExtensionContext) {
    // Anything the MCP host's own edges could not do is written down with the extension it came from.
    pinMcpDiagnosticsReporter((failure) => context.deps.telemetry.logs.reportHostExtensionDiagnostic({ extension: HostExtensions.Mcp, ...failure }));
    try {
      const cleanup = await context.cleanupLegacyAuth?.();
      // Credentials the old layout left behind are reported once, in the outcome the log takes.
      if (cleanup != null) context.deps.telemetry.logs.reportMcpAuthCleanup(cleanup.outcome === "error" ? "error" : "ok", cleanup.removedCount);
    } catch {}
    const pluginSkills = context.createPluginSkills();
    const stopStartup = startPluginSkillsWhenAuthenticated({
      auth: context.deps.auth,
      service: pluginSkills,
      polling: context.createPolling(),
      onStartupSyncSucceeded: () => {
        void context.sweepLegacyReferences?.();
      },
    });
    const service = context.createService(pluginSkills);
    const skillPublish = context.createSkillPublish(pluginSkills);
    context.onStop(async () => {
      stopStartup();
      pluginSkills.dispose();
      await service.dispose();
    });
    return { ...service.api, skillPublish };
  },
};
