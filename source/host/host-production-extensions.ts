/**
 * The real extension table: every extension the host ships, in one place, each bound to what it needs.
 *
 * The table is deliberately explicit rather than discovered. A host that assembles itself from a directory is a host whose
 * dependency graph nobody can read; this file is that graph, in one screen, and the package's own declaration order is
 * what the registry walks.
 *
 * Two kinds of binding appear here, and they differ in when they are resolved:
 *
 * - **extras that depend on nothing** are passed as an object;
 * - **extras that depend on the extension's own context** (the inference production wiring, MCP's production tools, the
 *   session's production extras) are passed as a function of that context, so they are built when the extension starts,
 *   after its dependencies are up.
 *
 * The three things this file cannot invent — the state backstop's store, the local-exec codec, and the secrets context —
 * are handed in by the caller, because they belong to code that lives outside the extension graph.
 */
import { defineHostExtension, type HostExtensionContext, type HostExtensionDeclaration } from "./extensions/host-extensions.ts";
import { actionAuditExtension } from "./extensions/action-audit/extension.ts";
import { attachmentsExtension } from "./attachments/extension.ts";
import { authExtension } from "./auth/extension.ts";
import { autoReviewExtension } from "./extensions/auto-review/extension.ts";
import { automationsExtension } from "./automations/extension.ts";
import { boxLifecycleExtension } from "./boxes/box-lifecycle/extension.ts";
import { boxStoreSyncExtension } from "./boxes/box-store-sync/extension.ts";
import { browserUaExtension } from "./extensions/browser-ua/extension.ts";
import { cloudAgentsExtension } from "./cloud-agents/extension.ts";
import { codebaseTelemetryExtension } from "./extensions/codebase-telemetry/extension.ts";
import { contentSearchExtension } from "./extensions/content-search/extension.ts";
import { crossUserSharingExtension } from "./rooms/extension.ts";
import { experimentsExtension } from "./extensions/experiments/extension.ts";
import { HostExtensions, type HostExtensionId } from "./extensions/extension-ids.generated.ts";
import { foreverBoxExtension } from "./boxes/forever-box/extension.ts";
import { hostUpgradeExtension } from "./extensions/host-upgrade/extension.ts";
import { inferenceExtension } from "./extensions/inference/extension.ts";
import { createInferenceProductionExtras } from "./extensions/inference/production.ts";
import { createLocalExecExtension } from "./local-exec/extension.ts";
import { localToolPermissionExtension } from "./extensions/local-tool-permission/extension.ts";
import { managedSetupExtension } from "./extensions/managed-setup/extension.ts";
import { createManagedSetupProductionExtras } from "./extensions/managed-setup/production.ts";
import { mcpExtension } from "./mcp/extension.ts";
import { createMcpProductionExtras } from "./mcp/production.ts";
import { memoryExtension } from "./memory/extension.ts";
import { createMemoryProductionExtras } from "./memory/production.ts";
import { notificationsExtension } from "./notifications/extension.ts";
import { notifyBusExtension } from "./extensions/notify-bus/extension.ts";
import { createSecretsExtension } from "./extensions/secrets/extension.ts";
import { sessionExtension } from "./extensions/session/extension.ts";
import { createSessionProductionExtras } from "./extensions/session/production.ts";
import { settingsExtension } from "./settings/extension.ts";
import { sourceMapExtension } from "./extensions/source-map/extension.ts";
import { createStateBackstopExtension } from "./extensions/state-backstop/extension.ts";
import { teachRecordingExtension } from "./extensions/teach-recording/extension.ts";
import { telemetryExtension } from "./telemetry/extension.ts";
import { transcriptExtension } from "./transcript/extension.ts";
import { traysExtension } from "./notifications/trays/extension.ts";
import { turnExecutionExtension } from "./extensions/turn-execution/extension.ts";
import { wallpaperExtension } from "./extensions/wallpaper/extension.ts";
import { webauthnProxyExtension } from "./extensions/webauthn-proxy/extension.ts";
import type { ProductionSlateHostPorts } from "./slate-host.ts";

/** The part of an extension declaration this file needs: what it is called, what it needs, and how it starts. */
type DeclarationLike = {
  readonly id: string;
  readonly dependencies: readonly string[];
  start(context: any): unknown;
};

type BoundExtras = Readonly<Record<string, unknown>>;
type BoundExtrasSource<Host> = BoundExtras | ((context: HostExtensionContext<Host>) => BoundExtras);

/**
 * An extension plus what it needs: the extras are merged under the context (so an extension sees its own dispatch and
 * logging), and the start is awaited, because a declaration that starts asynchronously is still a declaration.
 */
function bindDeclaration<Host>(declaration: DeclarationLike, extras: BoundExtrasSource<Host> = {}): HostExtensionDeclaration<unknown, Host> {
  return defineHostExtension({
    id: declaration.id,
    dependencies: declaration.dependencies,
    async start(context: HostExtensionContext<Host>) {
      const bound = typeof extras === "function" ? extras(context) : extras;
      return await declaration.start({ ...bound, ...context });
    },
  });
}

export interface RecoveredProductionExtensionBindings {
  readonly stateBackstop: Parameters<typeof createStateBackstopExtension>[0];
  readonly localExecCodec: Parameters<typeof createLocalExecExtension>[0];
  readonly secretsContext: Parameters<typeof createSecretsExtension>[0];
}

/** The full table: one entry per extension id, each bound to the code that starts it. */
export function createRecoveredProductionExtensionRegistry<Host extends { log(message: string): void }>(
  bindings: RecoveredProductionExtensionBindings,
): Record<HostExtensionId, HostExtensionDeclaration<unknown, Host>> {
  const bind = (declaration: DeclarationLike, extras?: BoundExtrasSource<Host>) => bindDeclaration<Host>(declaration, extras);
  return {
    [HostExtensions.Notifications]: bind(notificationsExtension),
    [HostExtensions.ContentSearch]: bind(contentSearchExtension),
    [HostExtensions.Memory]: bind(memoryExtension, (context) => createMemoryProductionExtras(context as Parameters<typeof createMemoryProductionExtras>[0])),
    [HostExtensions.CrossUserSharing]: bind(crossUserSharingExtension),
    [HostExtensions.StateBackstop]: bind(createStateBackstopExtension(bindings.stateBackstop)),
    [HostExtensions.SourceMap]: bind(sourceMapExtension),
    [HostExtensions.Telemetry]: bind(telemetryExtension),
    [HostExtensions.Trays]: bind(traysExtension),
    [HostExtensions.Auth]: bind(authExtension),
    [HostExtensions.Experiments]: bind(experimentsExtension),
    [HostExtensions.BrowserUa]: bind(browserUaExtension),
    [HostExtensions.Inference]: bind(inferenceExtension, (context) => createInferenceProductionExtras(context as Parameters<typeof createInferenceProductionExtras>[0])),
    [HostExtensions.LocalExec]: bind(createLocalExecExtension(bindings.localExecCodec)),
    [HostExtensions.LocalToolPermission]: bind(localToolPermissionExtension),
    [HostExtensions.Attachments]: bind(attachmentsExtension),
    [HostExtensions.ForeverBox]: bind(foreverBoxExtension),
    [HostExtensions.Secrets]: bind(createSecretsExtension(bindings.secretsContext)),
    [HostExtensions.TurnExecution]: bind(turnExecutionExtension),
    [HostExtensions.Transcript]: bind(transcriptExtension),
    [HostExtensions.Session]: bind(sessionExtension, (context) => createSessionProductionExtras(context as unknown as Parameters<typeof createSessionProductionExtras>[0])),
    [HostExtensions.Automations]: bind(automationsExtension),
    [HostExtensions.Settings]: bind(settingsExtension),
    [HostExtensions.BoxLifecycle]: bind(boxLifecycleExtension),
    [HostExtensions.ManagedSetup]: bind(managedSetupExtension, (context) => createManagedSetupProductionExtras(context as Parameters<typeof createManagedSetupProductionExtras>[0])),
    [HostExtensions.Mcp]: bind(mcpExtension, (context) => createMcpProductionExtras(context as unknown as Parameters<typeof createMcpProductionExtras>[0])),
    [HostExtensions.BoxStoreSync]: bind(boxStoreSyncExtension),
    [HostExtensions.CloudAgents]: bind(cloudAgentsExtension),
    [HostExtensions.ActionAudit]: bind(actionAuditExtension),
    [HostExtensions.HostUpgrade]: bind(hostUpgradeExtension),
    [HostExtensions.AutoReview]: bind(autoReviewExtension),
    [HostExtensions.CodebaseTelemetry]: bind(codebaseTelemetryExtension),
    [HostExtensions.TeachRecording]: bind(teachRecordingExtension),
    [HostExtensions.WebauthnProxy]: bind(webauthnProxyExtension),
    [HostExtensions.NotifyBus]: bind(notifyBusExtension),
    [HostExtensions.Wallpaper]: bind(wallpaperExtension),
  };
}

/** The table, added to the ports the host is built from: the one place a caller gets both. */
export function bindRecoveredProductionExtensions<Ports extends Omit<ProductionSlateHostPorts, "extensionsById">>(
  ports: Ports,
  bindings: RecoveredProductionExtensionBindings,
): Ports & Pick<ProductionSlateHostPorts, "extensionsById"> {
  return { ...ports, extensionsById: createRecoveredProductionExtensionRegistry(bindings) };
}
