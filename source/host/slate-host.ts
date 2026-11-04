/**
 * The host process itself.
 *
 * A host is a graph of extensions plus the runtime state around it (health, listeners, roster bookkeeping, the runner
 * composition and the gateway's API). Startup is a sequence with a name for each step, because each one is a thing that
 * can fail and that the desktop reports on:
 *
 *   1. walk the extension graph (`plugin_graph`),
 *   2. resolve the host bundle's identity and tell telemetry (`identity`),
 *   3. load the transcripts (`log_catchup`, then `transcript_read`),
 *   4. finish the background startup and report ready.
 *
 * Two rules keep the class honest:
 *
 * - **nothing is used before it is built** — extensions, roster bookkeeping and the runner composition each have a
 *   `require…` accessor that throws with the step that would have built it, rather than failing later with `undefined`;
 * - **every host-to-extension call is optional** — extensions are separate packages and a missing method means "this build
 *   does not offer that", not a crash. That is what `optionalMethod` is for, and it is why the host can run against a
 *   partially-populated graph.
 */
import { projectGatewayCommandFailure, projectGatewayCommandSuccess } from "../gateway/gateway-command-error.ts";
import { reportBoxReady } from "./box-ready-reporter.ts";
import { bindHostFeeds, type HostFeedBinding } from "./host-event-feeds.ts";
import { readHostActivity, type SlateHostHealth } from "./host-health.ts";
import { createHostGatewayApi, type HostGatewayDependencies } from "../gateway/host-gateway-api.ts";
import { SlateHostEventBus } from "./host-event-bus.ts";
import { loadInitialTranscriptResiliently, type InitialTranscriptLoader } from "./host-initial-transcript-load.ts";
import {
  createHostRosterBookkeeping,
  type FallbackAgentApi,
  type BoxStoreSnapshotApi,
  type BoxBusyApi,
  type HostRosterBookkeeping,
  type AgentSnapshotApi,
  type AgentSourceMapApi,
  type RunningAgentsApi,
} from "./host-roster-bookkeeping.ts";

type DynamicMethod = (...args: any[]) => any;
export type DynamicHostApi = Record<string, any>;

export interface HostExtensionRegistry {
  readonly order: readonly string[];
  api(id: "attachments"): FallbackAgentApi & DynamicHostApi;
  api(id: "transcript"): RunningAgentsApi & DynamicHostApi;
  api(id: "forever-box"): BoxBusyApi & DynamicHostApi;
  api(id: "state-backstop"): AgentSnapshotApi & DynamicHostApi;
  api(id: "box-store-sync"): BoxStoreSnapshotApi & DynamicHostApi;
  api(id: "source-map"): AgentSourceMapApi & DynamicHostApi;
  api(id: string): DynamicHostApi;
  stop(): Promise<void>;
}

export interface HostLifecycleProgress {
  complete(report: Record<string, unknown>): void;
  fail(): void;
}

export interface HostRunnerComposition {
  createRunner(session: unknown, hooks: unknown): unknown;
  createGroupMemberRunner(session: unknown, hooks: unknown, overrides: Record<string, unknown>): unknown;
  canAskLocalToolPermission(agentId: string): boolean;
  forgetLocalToolPermission(agentId: string): void;
  dispose(): Promise<void>;
}

export interface SlateHostRuntime {
  startExtensions(host: {
    log(message: string): void;
    readonly events: SlateHostEventBus<unknown>;
    isIdle(): boolean;
    whenBackgroundWorkReady: Promise<void>;
  }): Promise<HostExtensionRegistry>;
  createRunnerComposition(options: { extensions: HostExtensionRegistry; emitGatewayEvent(event: unknown): void }): HostRunnerComposition;
  resolveMcpAuthCompletion(completion: unknown): void;
  registerConnectorConnectCard(event: unknown): void;
  createGatewayDependencies(options: {
    extensions: HostExtensionRegistry;
    hostEvents: SlateHostEventBus<unknown>;
    rosterBookkeeping: HostRosterBookkeeping;
    getHealth(): SlateHostHealth;
    decorateForeverBoxStatus(status: any): any;
    kickstartIfPending(agentId: string): Promise<boolean>;
    requestDiskSaverAudit(agentId: string): Promise<boolean>;
    releaseAgentBox(agentId: string): Promise<void>;
    forgetLocalToolPermission(agentId: string): void;
  }): HostGatewayDependencies;
  readonly isAgentLimitError?: (error: unknown) => boolean;
  readonly buildIdentityFallback?: string;
  readonly now?: () => number;
  readonly performanceNow?: () => number;
  readonly log?: Pick<Console, "log" | "error">;
  readonly readReadyMarker?: () => Promise<string | null>;
  readonly writeReadyMarker?: (bootId: string) => Promise<void>;
  readonly readyRetryDelay?: (milliseconds: number) => Promise<void>;
  /** The generated/external extension adapters the produced graph reads from its host. */
  readonly extensionHost?: Readonly<object>;
}

export type { SlateHostHealth } from "./host-health.ts";

const EXTENSION_GATEWAY_FEEDS = [
  { extension: "mcp", subscribe: "subscribeToServersUpdated", channel: "mcp-servers" },
  { extension: "cross-user-sharing", subscribe: "subscribe", channel: "sharing" },
  { extension: "settings", subscribe: "subscribeToChanges", channel: "host-settings" },
] as const satisfies readonly HostFeedBinding[];

const EARLY_TRANSCRIPT_FEEDS = [
  { extension: "transcript", subscribe: "subscribe", channel: "transcript" },
  { extension: "transcript", subscribe: "subscribeClientSideToolV2", channel: "client-side-tool-v2" },
] as const satisfies readonly HostFeedBinding[];

const LATE_HOST_FEEDS = [
  { extension: "transcript", subscribe: "subscribeOutline", channel: "outline" },
  { extension: "transcript", subscribe: "subscribeSubagents", channel: "subagents" },
  { extension: "transcript", subscribe: "subscribeAsyncTasks", channel: "async-tasks" },
  { extension: "transcript", subscribe: "subscribeAutomations", channel: "automations" },
  { extension: "transcript", subscribe: "subscribeWorkflows", channel: "workflows" },
  { extension: "memory", subscribe: "subscribe", channel: "memory" },
  { extension: "trays", subscribe: "subscribe", channel: "tray" },
] as const satisfies readonly HostFeedBinding[];

const POST_BOX_HOST_FEEDS = [
  { extension: "teach-recording", subscribe: "subscribe", channel: "teach-recording" },
] as const satisfies readonly HostFeedBinding[];

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A method of an extension API, bound to it — or nothing, when this build's extension does not offer it. */
function optionalMethod(api: DynamicHostApi, name: string): DynamicMethod | undefined {
  const candidate = api[name];
  return typeof candidate === "function" ? candidate.bind(api) : undefined;
}

/** The host: its extension graph, the state the gateway reads, and the lifecycle the desktop reports on. */
export class SlateHost {
  readonly startedAt: number;
  readonly hostEvents: SlateHostEventBus<unknown>;
  readonly listeners = new Set<(event: unknown) => void>();

  private readonly backgroundWorkReady = deferred<void>();
  private activeExtensions: HostExtensionRegistry | undefined;
  private agentRoster: HostRosterBookkeeping | undefined;
  private runnerFactory: HostRunnerComposition | undefined;
  private mostRecentBusyAtMs: number;

  constructor(readonly runtime: SlateHostRuntime) {
    const now = runtime.now ?? Date.now;
    this.startedAt = now();
    this.mostRecentBusyAtMs = this.startedAt;
    this.hostEvents = new SlateHostEventBus((report) => {
      optionalMethod(this.telemetryLogExtension() ?? {}, "reportHostEventBusFailure")?.(report);
    });
  }

  private get hostLog(): Pick<Console, "log" | "error"> {
    return this.runtime.log ?? console;
  }

  private telemetryExtension(): DynamicHostApi | undefined {
    return this.activeExtensions?.api("telemetry");
  }

  private telemetryLogExtension(): DynamicHostApi | undefined {
    return this.telemetryExtension()?.logs as DynamicHostApi | undefined;
  }

  /** Crash and diagnostic reporting is best effort: a reporter that throws must not make the crash worse. */
  reportProcessCrash(error: unknown, kind: string): void {
    try {
      optionalMethod(this.telemetryLogExtension() ?? {}, "reportHostCrash")?.(kind);
    } catch {
      // Reporting a crash must not recursively crash the host.
    }
  }

  reportHostDiagnostic(diagnostic: unknown): void {
    optionalMethod(this.telemetryLogExtension() ?? {}, "reportHostDiagnostic")?.(diagnostic);
  }

  reportInvariantViolation(report: unknown): void {
    optionalMethod(this.telemetryLogExtension() ?? {}, "reportInvariantViolation")?.(report);
  }

  reportGatewayCommandError(report: Record<string, unknown> & { method: string; reason: string; errorClass: string; durationMs: number }): void {
    try {
      const { level, metadata } = projectGatewayCommandFailure(report);
      optionalMethod(this.telemetryLogExtension() ?? {}, "reportGatewayCommandError")?.(level, metadata);
    } catch {
      // A failed report is not a failed command.
    }
  }

  reportGatewayCommandSuccess(report: Record<string, unknown> & { method: string; durationMs: number }): void {
    try {
      const { level, metadata } = projectGatewayCommandSuccess(report);
      optionalMethod(this.telemetryExtension() ?? {}, "reportGatewayCommandTiming")?.(level, metadata);
    } catch {
      // As above.
    }
  }

  /** Startup, in the named phases the desktop reports on. */
  async start(): Promise<void> {
    const lifecycleStartedAt = this.runtime.performanceNow?.() ?? performance.now();
    const activeExtensions = await this.runtime.startExtensions({
      ...(this.runtime.extensionHost ?? {}),
      log: (message) => this.hostLog.log(`[slate-host] ${message}`),
      events: this.hostEvents,
      isIdle: () => {
        const runningTurns = this.agentRoster?.isBusy === true;
        const backgroundShell = this.activeExtensions == null ? false : Boolean(optionalMethod(this.activeExtensions.api("transcript"), "hasRunningBackgroundShellWork")?.());
        return !runningTurns && !backgroundShell;
      },
      whenBackgroundWorkReady: this.backgroundWorkReady.promise,
    });
    this.activeExtensions = activeExtensions;

    const createLifecycle = optionalMethod(activeExtensions.api("telemetry"), "createHostLifecycleProgress");
    if (createLifecycle == null) throw new Error("the telemetry extension does not expose host lifecycle progress");
    const lifecycle: HostLifecycleProgress = createLifecycle(lifecycleStartedAt);
    try {
      await this.startWithLifecycle(lifecycle);
    } catch (error) {
      lifecycle.fail();
      throw error;
    }
  }

  private async startWithLifecycle(lifecycle: HostLifecycleProgress): Promise<void> {
    const extensions = this.extensionsForHostOperation();
    lifecycle.complete({ phase: "plugin_graph", pluginCount: extensions.order.length });
    this.hostLog.log(`[slate-host] host extensions started in graph order: ${extensions.order.join(" -> ")}`);

    this.connectExtensionFeeds(extensions);
    this.connectDiskPressureFeed(extensions.api("forever-box"));
    this.connectHandoffHandlers();

    this.agentRoster = createHostRosterBookkeeping(extensions);
    this.runnerFactory = this.runtime.createRunnerComposition({ extensions, emitGatewayEvent: (event) => this.publishGatewayEvent(event) });
    this.bindExecutionClients();

    const resolveIdentity = optionalMethod(extensions.api("host-upgrade"), "resolveHostBundleIdentityVersion");
    const hostBundleVersion = resolveIdentity == null ? (this.runtime.buildIdentityFallback ?? "unknown") : await resolveIdentity(this.runtime.buildIdentityFallback ?? "unknown");

    let boxStoreId: unknown;
    try {
      boxStoreId = await optionalMethod(extensions.api("box-store-sync"), "getStoreId")?.();
    } catch {
      // A store that cannot name itself is a store this host has none of; the identity is still worth reporting.
      boxStoreId = undefined;
    }

    lifecycle.complete({ phase: "identity" });
    await optionalMethod(extensions.api("telemetry"), "setHostBundleIdentity")?.({
      hostBundleVersion,
      ...(boxStoreId === undefined ? {} : { boxStoreId }),
    });

    lifecycle.complete({ phase: "log_catchup" });
    const entryCount = await this.restoreInitialTranscript();
    lifecycle.complete({ phase: "transcript_read", entryCount });

    this.enablePostStartWork(hostBundleVersion);
    lifecycle.complete({ phase: "ready" });
  }

  private connectExtensionFeeds(extensions: HostExtensionRegistry): void {
    optionalMethod(extensions.api("mcp"), "subscribeToAuthCompletion")?.((completion: unknown) => this.runtime.resolveMcpAuthCompletion(completion));
    bindHostFeeds(extensions, EXTENSION_GATEWAY_FEEDS, (event) => this.publishGatewayEvent(event));
  }

  /**
   * A box handoff is the user taking over the box for a moment: the transcript records that the agent is waiting, and
   * when the handoff ends the agent is resumed with whatever the user did.
   */
  private connectHandoffHandlers(): void {
    this.hostEvents.on("session.box-handoff-started", (payload) => {
      const event = payload as { agentId: string; instruction: string };
      optionalMethod(this.transcriptExtension, "createAwaitingStateSink")?.()?.set(event.agentId, {
        tabId: "box",
        reason: event.instruction,
        since: (this.runtime.now ?? Date.now)(),
      });
    });

    this.hostEvents.on("session.box-handoff-ended", async (payload) => {
      const event = payload as { agentId: string; requestId: string; resolution: unknown; trigger: unknown };
      const pendingApproval = optionalMethod(this.extensionsForHostOperation().api("auto-review"), "pendingAwaitingState")?.(event.agentId);
      const sink = optionalMethod(this.transcriptExtension, "createAwaitingStateSink")?.();
      if (pendingApproval == null) sink?.clear(event.agentId);
      else sink?.set(event.agentId, pendingApproval);
      await optionalMethod(this.transcriptExtension, "resolveBoxRequestEntry")?.(event.agentId, event.requestId, event.resolution);
      await this.publishAgentBoxStatus(event.agentId);
      await optionalMethod(this.transcriptExtension, "resumeAfterBoxHandoff")?.(event.agentId, event.trigger);
    });

    this.hostEvents.on("session.box-handoff-status-changed", (payload) => {
      const event = payload as { agentId: string };
      void this.publishAgentBoxStatus(event.agentId);
    });
  }

  /** The ports the turn executor and the permission surfaces ask the host for. */
  private bindExecutionClients(): void {
    const extensions = this.extensionsForHostOperation();
    const composition = this.runnerForExecution();
    const localToolPermission = extensions.api("local-tool-permission");
    optionalMethod(localToolPermission, "bindAskSurfaces")?.((agentId: string) => composition.canAskLocalToolPermission(agentId));
    optionalMethod(localToolPermission, "bindLiveComputerCheck")?.(
      (agentId: string) => optionalMethod(extensions.api("local-exec"), "checkLiveComputerForAsk")?.(agentId) ?? false,
    );
    optionalMethod(extensions.api("turn-execution"), "bindExecutor")?.({
      createRunner: (session: unknown, hooks: unknown) => composition.createRunner(session, hooks),
      createGroupMemberRunner: (session: unknown, hooks: unknown, overrides: Record<string, unknown>) => composition.createGroupMemberRunner(session, hooks, overrides),
      isInferenceReady: () => optionalMethod(extensions.api("inference"), "isReady")?.() ?? false,
    });
  }

  private async restoreInitialTranscript(): Promise<number> {
    const entryCount = await loadInitialTranscriptResiliently(this.transcriptExtension as InitialTranscriptLoader<unknown>, {
      logError: (message, error) => {
        if (error === undefined) this.hostLog.error(message);
        else this.hostLog.error(message, error);
      },
      ...(this.runtime.isAgentLimitError === undefined ? {} : { isAgentLimitError: this.runtime.isAgentLimitError }),
    });
    this.rosterForHostOperation().apply(optionalMethod(this.transcriptExtension, "getActiveAgentId")?.());
    return entryCount;
  }

  /** What happens after the host is up: the active agent is kicked forward, and the event subscriptions are wired. */
  private enablePostStartWork(hostBundleVersion: string): void {
    const extensions = this.extensionsForHostOperation();
    const transcript = this.transcriptExtension;
    const activeAgentId = optionalMethod(transcript, "getActiveAgentId")?.();
    if (typeof activeAgentId === "string") void this.kickstartIfPending(activeAgentId);

    optionalMethod(transcript, "setAgentForgottenObserver")?.((agentId: string) => {
      void optionalMethod(extensions.api("box-store-sync"), "forgetAgent")?.(agentId);
      optionalMethod((extensions.api("forever-box").diskPressureReminder as DynamicHostApi | undefined) ?? {}, "forgetAgent")?.(agentId);
    });
    optionalMethod(transcript, "setShouldEmitAutomations")?.(() => this.listeners.size > 0);

    this.connectLiveFeeds();
    this.backgroundWorkReady.resolve(undefined);

    optionalMethod(extensions.api("host-upgrade"), "startSharedUpdateWatch")?.({ isBoxAutoUpdateEnabled: false, runRootUpdateTick: async () => {} });
    void optionalMethod(extensions.api("automations"), "reconcileNow")?.();
    optionalMethod(transcript, "setConnectorConnectCardObserver")?.((event: unknown) => this.runtime.registerConnectorConnectCard(event));
    void optionalMethod(extensions.api("host-upgrade"), "resumeInterruptedUpgradeTurns")?.();
    void optionalMethod(transcript, "rearmPendingWakes")?.();
    void optionalMethod(transcript, "redriveUnfulfilledAckObligations")?.();

    optionalMethod(this.telemetryLogExtension() ?? {}, "reportHostStartup")?.({
      auto_update: String(extensions.api("forever-box").isAutoUpdateEnabled ?? false),
      duration_ms: String((this.runtime.now ?? Date.now)() - this.startedAt),
      host_bundle_version: hostBundleVersion,
    });
    optionalMethod(extensions.api("host-upgrade"), "activateAfterHostIdentityReady")?.();
  }

  async kickstartIfPending(agentId: string): Promise<boolean> {
    const inferenceReady = (await optionalMethod(this.extensionsForHostOperation().api("inference"), "isReady")?.()) ?? false;
    return (await optionalMethod(this.transcriptExtension, "kickstartAgent")?.(agentId, inferenceReady)) ?? false;
  }

  async requestDiskSaverAudit(agentId: string): Promise<boolean> {
    const inferenceReady = (await optionalMethod(this.extensionsForHostOperation().api("inference"), "isReady")?.()) ?? false;
    return (await optionalMethod(this.transcriptExtension, "requestDiskSaverAudit")?.(agentId, inferenceReady)) ?? false;
  }

  /** A new event-stream listener gets the current disk-pressure level immediately, then everything else as it happens. */
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    const level = this.extensionsForHostOperation().api("forever-box").diskPressureLevel;
    listener({ channel: "box-disk-pressure", payload: level == null ? null : { level } });
    return () => {
      this.listeners.delete(listener);
    };
  }

  private connectDiskPressureFeed(foreverBox: DynamicHostApi): void {
    optionalMethod(foreverBox, "subscribeToDiskPressure")?.((level: unknown) => {
      if (level != null) {
        foreverBox.diskPressureReminder?.enroll?.(optionalMethod(this.transcriptExtension, "liveRunningAgentIds")?.() ?? []);
      }
      this.publishGatewayEvent({ channel: "box-disk-pressure", payload: level == null ? null : { level } });
      const activeAgentId = optionalMethod(this.transcriptExtension, "getActiveAgentId")?.() ?? this.agentRoster?.latestActiveAgentId;
      if (typeof activeAgentId === "string") void this.publishAgentBoxStatus(activeAgentId);
    });
  }

  noteEventStreamClosed(): void {
    void optionalMethod(this.transcriptExtension, "setWindowFocused")?.(false);
  }

  noteDesktopContact(): void {
    optionalMethod(this.transcriptExtension, "noteDesktopContact")?.();
  }

  getApi(): Record<string, DynamicMethod> {
    const extensions = this.extensionsForHostOperation();
    const roster = this.rosterForHostOperation();
    return createHostGatewayApi(
      this.runtime.createGatewayDependencies({
        extensions,
        hostEvents: this.hostEvents,
        rosterBookkeeping: roster,
        getHealth: () => this.getHealth(),
        decorateForeverBoxStatus: (status) => this.extendBoxStatus(status),
        kickstartIfPending: (agentId) => this.kickstartIfPending(agentId),
        requestDiskSaverAudit: (agentId) => this.requestDiskSaverAudit(agentId),
        releaseAgentBox: (agentId) => this.releaseBox(agentId),
        forgetLocalToolPermission: (agentId) => this.forgetLocalToolPermission(agentId),
      }),
    );
  }

  forgetLocalToolPermission(agentId: string): void {
    this.runnerFactory?.forgetLocalToolPermission(agentId);
  }

  /** Health is about work the user would notice: running turns, background shells, pending wakes, a revival mid-drain. */
  getHealth(): SlateHostHealth {
    const transcript = this.transcriptExtension;
    const runningTurnsBusy = this.agentRoster?.isBusy === true;
    const backgroundWork = Boolean(
      optionalMethod(transcript, "hasRunningBackgroundShellWork")?.() ||
        optionalMethod(transcript, "hasCarryablePendingWake")?.() ||
        optionalMethod(transcript, "hasMidDrainRevival")?.(),
    );
    const health = readHostActivity({
      activeAgentId: this.agentRoster?.latestActiveAgentId ?? null,
      runningTurnsBusy,
      runningAgentIds: optionalMethod(transcript, "liveRunningAgentIds")?.() ?? [],
      approvalAgentIds: optionalMethod(this.extensionsForHostOperation().api("auto-review"), "agentIdsWithPendingApprovals")?.() ?? [],
      hasRunningSubagents: Boolean(optionalMethod(transcript, "hasAgentsWithRunningSubagents")?.()),
      hasBackgroundWork: backgroundWork,
      sampledAtMs: (this.runtime.now ?? Date.now)(),
      lastBusyAtMs: this.mostRecentBusyAtMs,
    });
    this.mostRecentBusyAtMs = health.lastBusyAtMs;
    return health;
  }

  async prepareForUpgrade(): Promise<unknown> {
    return (await optionalMethod(this.extensionsForHostOperation().api("host-upgrade"), "prepareForUpgrade")?.()) ?? {};
  }

  getLocalExecBridge(): unknown {
    return this.extensionsForHostOperation().api("local-exec");
  }

  getWebAuthnBridge(): unknown {
    return this.extensionsForHostOperation().api("webauthn-proxy");
  }

  async dispose(): Promise<void> {
    const extensions = this.activeExtensions;
    if (extensions == null) return;
    if (optionalMethod(this.transcriptExtension, "isQuiescingForUpgrade")?.()) {
      optionalMethod(this.transcriptExtension, "markAllRunningAgentsForUpgradeResume")?.();
    }
    optionalMethod(extensions.api("managed-setup"), "dispose")?.();
    await optionalMethod(extensions.api("automations"), "suspendWakes")?.();
    optionalMethod(extensions.api("cross-user-sharing"), "prepareForUpgrade")?.();
    optionalMethod(extensions.api("auto-review"), "expirePendingApprovals")?.();
    await optionalMethod(this.transcriptExtension, "dispose")?.();
    await this.runnerFactory?.dispose();
    this.runnerFactory = undefined;
    await extensions.stop();
  }

  async flushTelemetryForFatalExit(): Promise<void> {
    try {
      await optionalMethod(this.telemetryExtension() ?? {}, "flushForFatalExit")?.();
    } catch {
      // A fatal exit has nowhere left to report a failed flush.
    }
  }

  /**
   * A box reports that it is ready exactly once per boot: the marker file names the boot that already reported, and a
   * failed report is retried a bounded number of times before the boot is written off.
   */
  async reportBoxReady(): Promise<void> {
    const reportConfirmed = optionalMethod(this.telemetryLogExtension() ?? {}, "reportBoxBootStageConfirmed")
    await reportBoxReady({
      environment: process.env,
      ...(this.runtime.now === undefined ? {} : { now: this.runtime.now }),
      ...(this.runtime.readReadyMarker === undefined ? {} : { readMarker: this.runtime.readReadyMarker }),
      ...(this.runtime.writeReadyMarker === undefined ? {} : { writeMarker: this.runtime.writeReadyMarker }),
      ...(this.runtime.readyRetryDelay === undefined ? {} : { wait: this.runtime.readyRetryDelay }),
      ...(reportConfirmed === undefined ? {} : { reportConfirmed }),
    })
  }

  private extensionsForHostOperation(): HostExtensionRegistry {
    if (this.activeExtensions == null) {
      throw new Error("[slate-host] the host extensions are not started; start() walks the extension graph before any capability is used");
    }
    return this.activeExtensions;
  }

  private rosterForHostOperation(): HostRosterBookkeeping {
    if (this.agentRoster == null) {
      throw new Error("[slate-host] roster bookkeeping is not built; startup builds it before the agent stream is wired");
    }
    return this.agentRoster;
  }

  private runnerForExecution(): HostRunnerComposition {
    if (this.runnerFactory == null) {
      throw new Error("[slate-host] the runner composition is not built; startup binds it before a turn can run");
    }
    return this.runnerFactory;
  }

  private get transcriptExtension(): DynamicHostApi {
    return this.extensionsForHostOperation().api("transcript");
  }

  private async publishAgentBoxStatus(agentId: string): Promise<void> {
    try {
      const status = await optionalMethod(this.extensionsForHostOperation().api("forever-box"), "getStatus")?.({ id: agentId });
      this.publishGatewayEvent({ channel: "forever-box", payload: this.extendBoxStatus(status) });
    } catch {
      // Status pushes are best effort: the next lifecycle event tries again.
    }
  }

  /** A box status plus what only the host knows: a pending handoff, the host version, and the disk-pressure level. */
  private extendBoxStatus(status: any): any {
    const extensions = this.extensionsForHostOperation();
    const versionState = optionalMethod(extensions.api("host-upgrade"), "getVersionState")?.() ?? {};
    const handoff = optionalMethod(extensions.api("session"), "pendingHandoff")?.(status?.agentId);
    const diskPressureLevel = extensions.api("forever-box").diskPressureLevel;
    return {
      ...status,
      handoff,
      ...(versionState.hostVersion == null ? {} : { hostVersion: versionState.hostVersion }),
      ...(versionState.hostUpdateAvailable == null ? {} : { hostUpdateAvailable: versionState.hostUpdateAvailable }),
      ...(diskPressureLevel == null ? {} : { diskPressure: { level: diskPressureLevel } }),
    };
  }

  private async releaseBox(agentId: string): Promise<void> {
    await optionalMethod(this.extensionsForHostOperation().api("forever-box"), "releaseAgent")?.(agentId);
  }

  /** The event subscriptions: transcript and agents first (the roster follows them), then everything else by channel. */
  private connectLiveFeeds(): void {
    const extensions = this.extensionsForHostOperation();
    const transcript = this.transcriptExtension;

    this.hostEvents.emit({ kind: "notification-baseline", agents: optionalMethod(transcript, "listAgentsSync")?.() ?? [] });
    bindHostFeeds(extensions, EARLY_TRANSCRIPT_FEEDS, (event) => this.publishGatewayEvent(event));
    optionalMethod(transcript, "subscribeAgents")?.((payload: any) => {
      this.rosterForHostOperation().apply(payload.activeAgentId);
      this.hostEvents.emit({ kind: "notification-agents", event: payload, presence: { windowFocusedAtMs: optionalMethod(transcript, "getWindowFocusedAtMs")?.() } });
      this.publishGatewayEvent({ channel: "agents", payload });
    });
    optionalMethod(transcript, "subscribeAgentUpserted")?.((payload: any) => {
      this.rosterForHostOperation().apply(payload.activeAgentId);
      this.hostEvents.emit({ kind: "notification-agent-upserted", event: payload, presence: { windowFocusedAtMs: optionalMethod(transcript, "getWindowFocusedAtMs")?.() } });
      this.publishGatewayEvent({ channel: "agent-upserted", payload });
    });

    bindHostFeeds(extensions, LATE_HOST_FEEDS, (event) => this.publishGatewayEvent(event));
    optionalMethod(extensions.api("forever-box"), "subscribe")?.((payload: unknown) => this.publishGatewayEvent({ channel: "forever-box", payload: this.extendBoxStatus(payload) }));
    bindHostFeeds(extensions, POST_BOX_HOST_FEEDS, (event) => this.publishGatewayEvent(event));
  }

  private publishGatewayEvent(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}
