/**
 * Automations, declared as a host extension.
 *
 * Starting it brings up the four things automations run on: the cloud sync that keeps this host's routines and the
 * backend's in step, the relay and fire consumers that turn backend events and scheduled fires into runs, the hub
 * that reconciles local triggers, and the watcher that resumes an agent once a listener platform it needs is
 * connected. Everything is torn down in the order it was started, and a reconcile is asked for once the host is
 * signed in — never before, because there is nobody to ask yet.
 */

import { join } from "node:path";
import { createRealPollingPolicy } from "../extensions/scheduling.ts";
import { defineHostExtension } from "../extensions/host-extensions.ts";
import { getConfiguredBackendUrl } from "../../shared/node/slate-token.ts";
import { createAutomationCloudSyncClient } from "../../adapters/interop/automation/automations-cloud-sync-client-adapter.ts";
import { getBoxUptimeMs, reconcileWhenAuthenticated } from "./automation-extension-policies.ts";
import { inspectAgentAutomationDefinitions } from "./automation-store.ts";
import { getSlateAgentsRootDir } from "../storage/agent-paths.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { createBackendRelaySources } from "./backend-relay-source.ts";
import { ListenerConnectWatcher } from "./listener-connect-watcher.ts";
import { createListenerIntegrationReads } from "./listener-integrations.automations.ts";
import { SlateAutomationCloudSync, type ScheduledCloudAutomation } from "./slate-automation-cloud-sync.ts";
import { SlateAutomationFireConsumer } from "./slate-automation-fire-consumer.ts";
import { SlateTriggerHub } from "./slate-trigger-hub.ts";

export const HUB_RECONCILE_INTERVAL_MS = 15_000;
export const RELAY_POLL_INTERVAL_MS = 4_000;
export const CONNECT_WATCH_POLL_INTERVAL_MS = 5_000;
export { getBoxUptimeMs, reconcileWhenAuthenticated, SLATE_BOX_BOOT_STARTED_AT_MS_ENV } from "./automation-extension-policies.ts";

interface AutomationTranscript {
  listAgents(): Promise<readonly { id: string }[]>;
  listAllAutomationDefinitions(): Promise<readonly { agentId: string; automation: ScheduledCloudAutomation & { runs?: readonly { id: string; status: string; detail?: string; coalescedRunIds?: readonly string[] }[] } }[]>;
  runAutomationForEvent(agentId: string, automation: ScheduledCloudAutomation, event: Record<string, unknown>): Promise<unknown>;
  runServerScheduledAutomation(args: { agentId: string; automation: ScheduledCloudAutomation; runUuid: string; scheduledForMs?: number }): Promise<string | undefined>;
  runServerAutomationForEvent(args: { agentId: string; automation: ScheduledCloudAutomation; event: Record<string, unknown>; runUuid: string }): Promise<string | undefined>;
  getAgentChannels(agentId: string): Promise<readonly { platform: string; [key: string]: unknown }[]>;
  resumeAfterListenerConnect(agentId: string, platform: string): Promise<void>;
}

interface AutomationAuth {
  getAccessToken(args: { backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
  peekAccessToken(): string | null;
  subscribeToRenewal(listener: () => void): () => void;
}

interface AutomationTelemetry {
  logs: { reportHostExtensionDiagnostic(value: Record<string, unknown>): void; reportAutomationShadowPrune(value: Record<string, unknown>): void };
  brain: { reportAutomationFireDropped(value: Record<string, unknown>): void; reportAgentError?(value: Record<string, unknown>): void };
}

interface AutomationNotifyBus {
  isConnected(): boolean;
  isSafetyPollEnabled(): boolean;
  onNotify(topic: string, listener: () => void): () => void;
}

interface AutomationExtensionDeps {
  auth: AutomationAuth;
  settings: { getUserTimeZone(): string | undefined };
  telemetry: AutomationTelemetry;
  transcript: AutomationTranscript;
  trays: { pushError(value: { agentId: string; title: string; detail: string }): { id: string }; dismiss(value: { id: string }): void };
  "turn-execution": { isRunReady(): boolean };
  "notify-bus": AutomationNotifyBus;
}

interface AutomationExtensionHost {
  log(message: string): void;
  events: { on<Payload>(topic: string, listener: (payload: Payload) => void): () => void };
}

const SYNC_FAILURE_TRAY = {
  title: "Routine Sync Failed",
  detail: "Slate couldn't sync this agent's routines. Event routines keep running locally when safe, but scheduled routines may be delayed while Slate retries.",
};

export const automationsExtension = defineHostExtension({
  id: HostExtensions.Automations,
  dependencies: [HostExtensions.Auth, HostExtensions.Settings, HostExtensions.Telemetry, HostExtensions.Transcript, HostExtensions.Trays, HostExtensions.TurnExecution, HostExtensions.NotifyBus],
  start: (context) => {
    const host = context.host as AutomationExtensionHost;
    const deps = context.deps as unknown as AutomationExtensionDeps;

    // A tray per agent whose routines could not be synced, kept until that agent recovers.
    const syncFailureTrays = new Map<string, string>();
    let schedulingAuthorityChanged = (): void => {};

    const cloudSync = new SlateAutomationCloudSync({
      client: createAutomationCloudSyncClient(deps.auth),
      reportDiagnostic: (diagnostic) => deps.telemetry.logs.reportHostExtensionDiagnostic(diagnostic),
      hasCredential: () => deps.auth.peekAccessToken() != null,
      listAgentIds: async () => (await deps.transcript.listAgents()).map(({ id }) => id),
      listAutomations: () => deps.transcript.listAllAutomationDefinitions(),
      getTimeZone: () => deps.settings.getUserTimeZone(),
      inspectLocalDefinitions: (agentId: string) => inspectAgentAutomationDefinitions(join(getSlateAgentsRootDir(), agentId)),
      reportShadowPrune: (report: Record<string, unknown>) => deps.telemetry.logs.reportAutomationShadowPrune({ ...report, boxUptimeMs: getBoxUptimeMs() }),
      onFailure: ({ agentId }) => {
        if (agentId == null || syncFailureTrays.has(agentId)) return;
        const tray = deps.trays.pushError({ agentId, ...SYNC_FAILURE_TRAY });
        syncFailureTrays.set(agentId, tray.id);
      },
      onRecovery: (agentId) => {
        const trayId = syncFailureTrays.get(agentId);
        if (trayId == null) return;
        deps.trays.dismiss({ id: trayId });
        syncFailureTrays.delete(agentId);
      },
      onSchedulingAuthorityChanged: () => schedulingAuthorityChanged(),
    });

    const relay = createBackendRelaySources({
      getAccessToken: deps.auth.getAccessToken,
      getBackendUrl: () => getConfiguredBackendUrl(),
      polling: createRealPollingPolicy({ name: "automations.relay-poll", intervalMs: RELAY_POLL_INTERVAL_MS }),
      isNotifyConnected: () => deps["notify-bus"].isConnected(),
      isNotifySafetyPollEnabled: () => deps["notify-bus"].isSafetyPollEnabled(),
    });

    const fireConsumer = new SlateAutomationFireConsumer({
      getAccessToken: deps.auth.getAccessToken,
      getBackendUrl: () => getConfiguredBackendUrl(),
      getTimeZone: () => deps.settings.getUserTimeZone(),
      getBoxUptimeMs,
      isReady: () => deps["turn-execution"].isRunReady(),
      listAutomations: () => deps.transcript.listAllAutomationDefinitions(),
      fire: (args) => deps.transcript.runServerScheduledAutomation(args),
      fireForEvent: (args) => deps.transcript.runServerAutomationForEvent(args),
      telemetry: deps.telemetry.brain,
      isNotifyConnected: () => deps["notify-bus"].isConnected(),
      isNotifySafetyPollEnabled: () => deps["notify-bus"].isSafetyPollEnabled(),
    });
    context.onStop(deps["notify-bus"].onNotify("automation-fires", () => fireConsumer.requestDrain()));
    context.onStop(deps["notify-bus"].onNotify("listener-events", () => relay.requestDrain()));

    const hub = new SlateTriggerHub({
      polling: createRealPollingPolicy({ name: "automations.hub-reconcile", intervalMs: HUB_RECONCILE_INTERVAL_MS }),
      sources: [relay.slack, relay.github],
      listAutomations: () => deps.transcript.listAllAutomationDefinitions(),
      fire: (agentId, automation, event) => deps.transcript.runAutomationForEvent(agentId, automation as ScheduledCloudAutomation, event),
      isReady: () => deps["turn-execution"].isRunReady(),
      shouldScheduleLocally: (agentId, automation) => cloudSync.shouldScheduleLocally({ agentId, automation }),
      onReconcile: () => {
        void cloudSync.reconcileNow();
        void fireConsumer.tick();
      },
    });
    schedulingAuthorityChanged = () => void hub.reconcileNow();

    const listenerReads = createListenerIntegrationReads({
      auth: deps.auth,
      transcript: deps.transcript,
      sourceStatuses: () => hub.getSourceStatuses(),
      log: host.log,
    });
    const connectWatcher = new ListenerConnectWatcher({
      polling: createRealPollingPolicy({ name: "automations.connect-watch", intervalMs: CONNECT_WATCH_POLL_INTERVAL_MS }),
      isPlatformConnected: listenerReads.isPlatformConnected,
      onConnected: (agentId, platform) => void deps.transcript.resumeAfterListenerConnect(agentId, platform),
    });

    const stopOnConfigChanged = host.events.on("transcript.automation-config-changed", () => {
      fireConsumer.resetPollDelay();
      void hub.reconcileNow();
    });
    const stopOnConnectCard = host.events.on("transcript.listener-connect-card", ({ agentId, platform }: { agentId: string; platform: "slack" | "github" }) => connectWatcher.watch(agentId, platform));

    hub.start();
    const stopReconcileOnSignIn = reconcileWhenAuthenticated({ auth: deps.auth, reconcile: () => void hub.reconcileNow() });
    context.onStop(async () => {
      stopReconcileOnSignIn();
      stopOnConfigChanged();
      stopOnConnectCard();
      connectWatcher.dispose();
      fireConsumer.stop();
      await hub.stop();
    });

    return {
      sourceStatuses: () => hub.getSourceStatuses(),
      suspendWakes: async () => {
        connectWatcher.suspend();
        fireConsumer.stop();
        await hub.stop();
      },
      resumeWakes: () => {
        connectWatcher.resume();
        hub.start();
        fireConsumer.start();
      },
      deleteAgentSchedules: (agentId: string) => cloudSync.deleteAgent(agentId),
      reconcileNow: () => hub.reconcileNow(),
      getListenerIntegrations: () => listenerReads.getIntegrations(),
      getListenerConnectUrl: (platform: "slack" | "github") => listenerReads.getConnectUrl(platform),
      platformIsConnected: (platform: "slack" | "github") => listenerReads.isPlatformConnected(platform),
      getAgentChannels: (agentId: string) => listenerReads.getAgentChannels(agentId),
    };
  },
});
