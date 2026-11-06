/**
 * The runner: everything one conversation's turn needs to remember, and nothing it does not.
 *
 * The host composes a run out of hosts and services; the runner is what stays between runs. It answers four questions for
 * the rest of the platform:
 *
 * - **what has happened** — the conversation state, the runs, the async work, the observed tool calls, the outline;
 * - **what may happen now** — the subagents, the computer-use coordination, the background shell and cloud-agent watches,
 *   the shell terminal watermark;
 * - **who may interrupt it** — one active run at a time; an interrupt, a quiesce for an upgrade and a pause for the user
 *   all go through it, and a run that is finished cannot be cancelled by a late caller;
 * - **what the host owns** — the prompt session, the resource accessor, the summarization handler, the blob store and the
 *   Agent itself are all handed in. Nothing in this file builds one; a missing binding fails loudly at the point of use
 *   rather than being replaced with something that pretends to work.
 *
 * A run emits through the transport, and the runner decides what a run produced: the text it streamed, the messages it
 * sent, whether it reacted. That accounting belongs here because it is per run, not per update.
 */
import { RunnerTurnAttempt, type RunnerTurnAttemptOptions, type RunnerUpdate, type SlateAgentRunnerResult } from "./runner-turn-attempt.ts";
import type { RunnerServiceBindings } from "./runner-service-bindings.ts";
import { runFallbackStepLoop } from "./runner-fallback-step-loop.ts";
import { RunnerIdentity } from "./runner-identity.ts";
import type { Context } from "../../packages/context/context.ts";
import { CONNECTOR_MANIFESTS, type ConnectorManifest } from "../channels/channels.ts";
import { InMemoryBlobStore } from "../../packages/agent-kv/blob-store.ts";
import type { BlobStore } from "../../packages/agent-kv/blob-store.ts";
import { createBackgroundWatches, type BackgroundWatchesHost } from "./background-work.ts";
import {
  pollShellTerminalFile,
  type ConfirmedUserTurnWatermark,
  type ShellTerminalWatchHost,
} from "./shell-terminal-watch.ts";
import { createShellWatchGeneratedStateProjection, createShellWatchReadAccessor } from "../../adapters/interop/agent/shell-terminal-watch-adapter.ts";
import { cloneInteropRunnerConversationState, type InteropRunnerConversationState } from "../../adapters/interop/agent/runner-conversation-state-adapter.ts";
import { createSubagentRuntime, type BackgroundSubagentCompletion, type RunningSubagentInfo, type SubagentRuntimeHost } from "./subagent-runtime.ts";
import { createToolCallIdentity } from "./tool-call-identity.ts";
import { createComputerUseCoordination } from "./computer-use.ts";
import { createSlateNavigationProbe } from "./slate-action-audit.ts";
import type { TurnUsage } from "./turn-usage.ts";
import { createTurnObservation, type AsyncTask } from "./turn-observation.ts";
import { runnerConversationStateFromStoreCheckpoint, SLATE_AGENT_MAX_STEPS } from "./turn-agent-composition.ts";
import { createProductionTurnRunShellAdapter, type ProductionTurnRunShellAdapterInput } from "./production-turn-run-shell-adapter.ts";
import type { ForwardedUpdate } from "./agent-adapters.ts";
import type { TurnStreamLifecycleInput, TurnStreamPath, TurnStreamStartInput } from "./turn-agent-stream.ts";
import type { SlateAutoReviewController, SlateAutoReviewResolution } from "./slate-auto-review.ts";
import { deriveOutlineFromConversationState, type ConversationState as OutlineConversationState, type OutlineItem } from "./conversation-outline.ts";
import { presentOptions } from "./optional-options.ts";

export interface AgentBlobStoreOwner {
  getBlobStore(): BlobStore<unknown>;
}

export function getAgentBlobStore(owner: AgentBlobStoreOwner): BlobStore<unknown> {
  return owner.getBlobStore();
}

export interface AgentPromptSession {
  getModelId(): string;
  getExecutor(state?: unknown): unknown;
}

export interface AgentResourceAccessor {
  get(resource: unknown): unknown;
}

export interface AgentSummarizationHandler {
  getModelId(): string;
}

export interface AgentMediaDimensions {
  readonly width: number;
  readonly height: number;
}

export interface AgentProfileForRunner {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly settingsFilePath: string;
}

export interface AgentConversationActionReceiver {
  peek(context: unknown): Promise<unknown>;
  pop(context: unknown): Promise<undefined>;
}

interface RunnerShellWatchBox {
  ensureReady(context: Context, agentId: string): Promise<{ readonly remoteAccessor: unknown; readonly terminalsFolder: string }>;
}

type RunnerBackgroundWatches = ReturnType<typeof createBackgroundWatches>;

/** Where a box's browser window can be reached: the display number and the CDP endpoint that follows from it. */
export const BOX_CDP_PORT_BASE = 9_222;

export interface RunnerConversationState extends OutlineConversationState {
  summaryArchives: readonly unknown[];
  turnTimings: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface RunnerTransport {
  onUpdate(update: RunnerUpdate | ForwardedUpdate): void;
  lastReactionApplied?(): boolean;
  lastSentMessageId?(): string | undefined;
}

export type { RunnerUpdate, SlateAgentRunnerResult } from "./runner-turn-attempt.ts";

export interface SlateAgentRunnerOptions<T = unknown> {
  /** The Agent stream path this runner hands the shell; the shell never builds one. */
  readonly turnStreamPath?: TurnStreamPath;
  readonly conversationId?: string;
  readonly ctx?: Context;
  readonly box?: RunnerShellWatchBox;
  readonly cloudAgentWatcher?: NonNullable<ReturnType<BackgroundWatchesHost["cloudAgentWatcher"]>>;
  readonly transcriptId?: string;
  readonly boxId?: string;
  readonly initialState?: RunnerConversationState;
  readonly blobStore?: BlobStore<unknown>;
  readonly createPromptSession?: (onRequestId: (requestId: string) => void, options?: Readonly<Record<string, unknown>>) => AgentPromptSession;
  readonly createResourceAccessor?: (context: unknown) => Promise<AgentResourceAccessor>;
  readonly createSummarizationHandler?: (summarizationSession: unknown, options?: Readonly<{ preserveLatestImage?: boolean }>) => AgentSummarizationHandler;
  readonly createConversationActionReceiver?: () => AgentConversationActionReceiver;
  readonly transport?: RunnerTransport;
  readonly agentProfileProvider?: () => AgentProfileForRunner | null;
  readonly connectorManifests?: readonly ConnectorManifest[];
  readonly ingestAttachment?: (sourcePath: string) => Promise<string>;
  readonly persistImage?: (...args: unknown[]) => unknown;
  readonly persistMediaBytes?: (filename: string, data: Uint8Array) => Promise<string | null>;
  readonly readVideoAttachmentBytes?: (filePath: string) => Promise<Uint8Array | null>;
  readonly readMediaDimensions?: (filePath: string) => Promise<AgentMediaDimensions | null>;
  readonly isSubagent?: boolean;
  readonly isSharedRoomTurn?: boolean;
  readonly isSharedRoomBoxToolsEnabled?: () => boolean;
  readonly subagentType?: string;
  readonly subagentModelId?: string;
  readonly requestSource?: string;
  readonly automationId?: string;
  readonly autoReviewController?: SlateAutoReviewController;
  readonly prepare?: () => Promise<void>;
  readonly runStep?: (
    step: number,
    context: {
      readonly signal: AbortSignal;
      readonly emitUpdate: (update: RunnerUpdate) => void;
      readonly prompt: string;
      readonly runOptions: Readonly<Record<string, unknown>>;
      readonly requestId: string;
      readonly state: RunnerConversationState;
      readonly setState: (state: RunnerConversationState) => void;
    },
  ) => Promise<{ readonly done: boolean; readonly value?: T }>;
  readonly settle?: (value: T | undefined) => Promise<void>;
  readonly maxSteps?: number;
  readonly getBoxId?: () => string;
  readonly getAgentId?: () => string;
  readonly workflowStore?: unknown;
  readonly channelStore?: unknown;
  readonly getTranscriptsFolder?: () => string | undefined;
  readonly getBoxTerminalsFolder?: () => string | undefined;
  readonly getBoxWindowIndex?: (boxId: string) => number | undefined;
  readonly isCloudAgentsDisabledByTeam?: () => boolean;
  readonly getPendingCloudAgentWatchBcIds?: () => readonly string[];
  readonly hasRunningBackgroundShellWork?: () => boolean;
  readonly cancelBackgroundShellRewatches?: () => void;
  readonly getPendingShellRewatchIds?: () => readonly string[];
  readonly getComputerUseUsageSnapshot?: () => { readonly modelId?: string; readonly turnEndedCount: number; readonly usage?: unknown };
  readonly getComputerUseAuditActionCounts?: () => ReadonlyMap<string, number>;
  readonly onRunLifecycle?: (event: { readonly type: "started" | "ended"; readonly requestId: string }) => void;
  readonly onComputerUseUsage?: (event: unknown) => void;
  readonly onPendingWakeArmed?: (event: unknown) => void;
  readonly onPendingWakeDisarmed?: (event: unknown) => void;
  readonly actionAuditor?: { record(record: unknown): void };
  readonly freeComputerUseWindow?: (subagentAgentId: string) => void;
  readonly navigationProbe?: ReturnType<typeof createSlateNavigationProbe<Context>>;
  readonly now?: () => number;
  /** The host's real turn shell; without it this runner falls back to the step loop below. */
  readonly productionTurnRunShell?: Pick<
    ProductionTurnRunShellAdapterInput,
    "createOwner" | "createRunInput" | "promptOptions" | "createSession" | "context" | "createSettleHost" | "profilePromptSnapshots" | "cancelThisRun"
  >;
}

/** One run in flight: what it is, what it may still do, and what it has produced so far. */
function emptyConversationState(): RunnerConversationState {
  return { turns: [], summaryArchives: [], turnTimings: [] };
}

/** A subagent type, compared the way the platform names them: `computer-use`, `computer_use` and `COMPUTERUSE` agree. */
function subagentTypeIs(type: string | undefined, expected: string): boolean {
  return type != null && type.replace(/[-_ ]/g, "").toLowerCase() === expected;
}

function applyRunnerSlotBindings<Group extends object>(
  source: Group | undefined,
  targets: Partial<Record<keyof Group, (value: unknown) => void>>,
): void {
  if (source === undefined) return;
  for (const [key, bind] of Object.entries(targets) as Array<[keyof Group, ((value: unknown) => void) | undefined]>) {
    if (bind !== undefined && Object.prototype.hasOwnProperty.call(source, key)) bind(Reflect.get(source, key));
  }
}

export class SlateAgentRunner<T = unknown> {
  #state: RunnerConversationState;
  #runGeneration = 0;
  readonly #identity: RunnerIdentity;
  #fallbackBlobStore = new InMemoryBlobStore();
  #blobStore: BlobStore<unknown>;
  #productionConversationStateStructure: InteropRunnerConversationState | undefined;
  #currentAttempt: RunnerTurnAttempt | null = null;
  #quiescingForUpgrade = false;
  #awaitingUserSelection = false;
  #runInterrupted = false;
  #activeTurnRequestSource: string | undefined;
  #activeTurnAutomationId: string | undefined;
  #clearFirstTokenDeadline: (() => void) | undefined;
  #resetFirstTokenDeadline: (() => void) | undefined;
  #observeFirstToken: (() => void) | undefined;
  #latestPromptMessagesGetter: (() => readonly unknown[]) | undefined;
  #confirmedUserTurnWatermarkCache: { readonly turnCount: number; readonly messageId: string } | undefined;
  #shellWatchWatermarkCache: ConfirmedUserTurnWatermark | undefined;
  #backgroundWatches: RunnerBackgroundWatches | undefined;
  #disposed = false;
  #productionTurnRunShell?: ReturnType<typeof createProductionTurnRunShellAdapter>;

  #agentStore: unknown;
  #agentProfileProvider: unknown;
  readonly connectorManifests: readonly ConnectorManifest[];
  #attachmentIngestor: unknown;
  #persistImage: unknown;
  #persistMediaBytes: unknown;
  #mcp: unknown;
  #mcpManagement: unknown;
  #memoryStore: unknown;
  #userMemory: unknown;
  #projectMemory: unknown;
  #memorySnapshots: unknown;
  #profilePromptSnapshots: unknown;
  #episodeProgress: unknown;
  #automationStore: unknown;
  #workflowStore: unknown;
  #channelStore: unknown;
  #computerUse: ReturnType<typeof createComputerUseCoordination<Context>> | undefined;

  #onComputerUseUsage: ((event: unknown) => void) | undefined;
  #onBackgroundShellSettled: ((completion: BackgroundSubagentCompletion) => void) | undefined;
  #onPendingWakeArmed: ((event: unknown) => void) | undefined;
  #onPendingWakeDisarmed: ((event: unknown) => void) | undefined;

  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isSharedRoomBoxToolsEnabled: (() => boolean) | undefined;
  readonly subagentType: string | undefined;
  readonly subagentModelId: string | undefined;
  readonly inheritedRequestSource: string | undefined;
  readonly inheritedAutomationId: string | undefined;
  readonly autoReviewController: SlateAutoReviewController | undefined;
  readonly subagentTranscriptId: string | undefined;

  readonly observation;
  readonly subagents;
  readonly toolCallIdentity;

  constructor(readonly options: SlateAgentRunnerOptions<T>) {
    this.#identity = new RunnerIdentity(options);
    this.#state = options.initialState ?? emptyConversationState();
    this.#blobStore = options.blobStore ?? this.#fallbackBlobStore;
    this.isSubagentRunner = options.isSubagent ?? false;
    this.isSharedRoomRunner = options.isSharedRoomTurn ?? false;
    this.isSharedRoomBoxToolsEnabled = options.isSharedRoomBoxToolsEnabled;
    this.subagentType = options.subagentType;
    this.subagentModelId = options.subagentModelId;
    this.inheritedRequestSource = options.requestSource;
    this.inheritedAutomationId = options.automationId;
    this.autoReviewController = options.autoReviewController;
    this.subagentTranscriptId = options.transcriptId;
    this.#onComputerUseUsage = options.onComputerUseUsage;
    this.#onPendingWakeArmed = options.onPendingWakeArmed;
    this.#onPendingWakeDisarmed = options.onPendingWakeDisarmed;
    this.#agentProfileProvider = options.agentProfileProvider;
    this.connectorManifests = options.connectorManifests ?? CONNECTOR_MANIFESTS;
    this.#attachmentIngestor = options.ingestAttachment;
    this.#persistImage = options.persistImage;
    this.#persistMediaBytes = options.persistMediaBytes;
    // A shared room is not a conversation with its own automation history: it neither reads nor writes either store.
    this.#workflowStore = this.isSharedRoomRunner ? undefined : options.workflowStore;
    this.#channelStore = this.isSharedRoomRunner ? undefined : options.channelStore;

    this.observation = createTurnObservation({
      getConversationId: () => this.getConversationId(),
      isActiveRunCanceled: () => this.#currentAttempt?.signal.aborted ?? false,
      isActiveRunInterrupted: () => this.#runInterrupted,
      subagentRegistryEntries: () => this.subagents.registryEntries(),
      isSubagentAborting: (id) => this.subagents.isAborting(id),
      listBackgroundShellWork: () => this.#backgroundWatches?.listRegisteredShellWork({ kind: "shell" }) ?? [],
      shellRewatchEntries: () => this.#backgroundWatches?.shellRewatchEntries() ?? [],
      cloudAgentWatchEntries: () => this.#backgroundWatches?.cloudAgentWatchEntries() ?? [],
      onEvent: () => {},
      ...presentOptions({ now: options.now }),
    });
    this.toolCallIdentity = createToolCallIdentity({
      emitUpdate: (update) =>
        this.emitUpdate({
          type: "tool-call",
          id: typeof update.callId === "string" ? update.callId : "",
          ...(typeof update.name === "string" ? { name: update.name } : {}),
        }),
    });

    if (options.ctx !== undefined && options.box !== undefined) {
      this.#computerUse = createComputerUseCoordination({
        ctx: options.ctx,
        remoteBox: options.box,
        actionAuditor: () => options.actionAuditor,
        getConversationId: () => this.getConversationId(),
        resolveBoxId: () => this.resolveBoxId(),
        ...presentOptions({ initialNavigationProbe: options.navigationProbe }),
      });
      if (this.isComputerUseSubagent && this.subagentModelId !== undefined) this.#computerUse.recordModelId(this.subagentModelId);
    }

    const runtimeHost: SubagentRuntimeHost = {
      getConversationId: () => this.getConversationId(),
      resolveBoxId: () => this.resolveBoxId(),
      emitAsyncTasksChanged: () => this.observation.emitAsyncTasksChanged?.(),
      computerUse: this.#computerUse ?? { freeWindow: (subagentAgentId) => options.freeComputerUseWindow?.(subagentAgentId) },
      isComputerUseSubagentType: (type) => subagentTypeIs(type, "computeruse"),
      ...presentOptions({
        now: options.now,
        actionAuditor: options.actionAuditor,
        onComputerUseUsage: options.onComputerUseUsage === undefined ? undefined : (event: unknown) => this.#onComputerUseUsage?.(event),
        onPendingWakeArmed: options.onPendingWakeArmed === undefined ? undefined : (event: unknown) => this.#onPendingWakeArmed?.(event),
        onPendingWakeDisarmed: options.onPendingWakeDisarmed === undefined ? undefined : (event: unknown) => this.#onPendingWakeDisarmed?.(event),
      }),
    };
    this.subagents = createSubagentRuntime(runtimeHost);

    if (options.productionTurnRunShell !== undefined) {
      this.#productionTurnRunShell = createProductionTurnRunShellAdapter({
        ...options.productionTurnRunShell,
        isSubagentRunner: this.isSubagentRunner,
        subagents: this.subagents,
        getConversationId: () => this.getConversationId(),
        runGeneration: () => this.#runGeneration,
        setActiveTurnRequestSource: (source) => {
          this.#activeTurnRequestSource = source;
        },
        setActiveTurnAutomationId: (automationId) => {
          this.#activeTurnAutomationId = automationId;
        },
        beginAutoReviewUserMessageEpoch: () => this.beginAutoReviewUserMessageEpoch(),
        setActiveRunInterrupted: (value) => {
          this.#runInterrupted = value;
        },
        setAwaitingUserSelection: (value) => {
          this.#awaitingUserSelection = value;
        },
        isAwaitingUserSelection: () => this.#awaitingUserSelection,
        emitRunLifecycle: (event) => this.emitRunLifecycle(event),
        emitUpdate: (update) => this.options.transport?.onUpdate(update),
        onRunUnwind: () => {
          this.#activeTurnRequestSource = undefined;
          this.#activeTurnAutomationId = undefined;
        },
        ...presentOptions({
          subagentType: this.subagentType,
          inheritedRequestSource: this.inheritedRequestSource,
          inheritedAutomationId: this.inheritedAutomationId,
        }),
      });
    }

    // The background watches need a box to watch: without both a live context and a box that can be brought up, there is
    // nothing to poll and nothing to register.
    const context = options.ctx;
    const box = options.box;
    if (context != null && typeof context.with === "function" && box != null && typeof box.ensureReady === "function") {
      const shellHost: ShellTerminalWatchHost<Context> = {
        ctx: context,
        ...createShellWatchGeneratedStateProjection({
          getConversationState: () => this.getAgentConversationStateStructure(),
          getBlobStore: () => this.getBlobStore(),
        }),
        getConversationId: () => this.getConversationId(),
        async ensureBoxReady(pollContext, agentId) {
          const connection = await box.ensureReady(pollContext, agentId);
          return { terminalsFolder: connection.terminalsFolder, remoteAccessor: createShellWatchReadAccessor(connection.remoteAccessor) };
        },
        getConfirmedUserTurnWatermarkCache: () => this.#shellWatchWatermarkCache,
        setConfirmedUserTurnWatermarkCache: (cache) => {
          this.#shellWatchWatermarkCache = cache;
        },
        ...presentOptions({ now: options.now }),
      };
      const watchesHost: BackgroundWatchesHost = {
        getConversationId: () => this.getConversationId(),
        emitAsyncTasksChanged: () => this.observation.emitAsyncTasksChanged?.(),
        pendingWakeArmedHandler: () => this.#onPendingWakeArmed,
        backgroundShellSettledHandler: () => (event) => {
          this.#onBackgroundShellSettled?.(event as unknown as BackgroundSubagentCompletion);
        },
        notifyBackgroundWorkSettled: (completion) => {
          this.subagents.notifyBackgroundWorkSettled(completion as BackgroundSubagentCompletion);
        },
        cloudAgentWatcher: () => options.cloudAgentWatcher ?? null,
        pollShellTerminalFile: (id, cancelled, settle) => {
          void pollShellTerminalFile(shellHost, id, cancelled, settle);
        },
      };
      this.#backgroundWatches = createBackgroundWatches(watchesHost);
    }
  }

  get state(): RunnerConversationState {
    return this.#state;
  }

  get turnStreamPath(): TurnStreamPath | undefined {
    return this.options.turnStreamPath;
  }

  runTurnStream(input: TurnStreamStartInput): Promise<InteropRunnerConversationState> {
    if (this.options.turnStreamPath === undefined) throw new Error("this runner has no turn stream path");
    return this.options.turnStreamPath.startStream(input);
  }

  runTurnStreamLifecycle(input: TurnStreamLifecycleInput, context: Context): Promise<InteropRunnerConversationState> {
    if (this.options.turnStreamPath === undefined) throw new Error("this runner has no turn stream path");
    return this.options.turnStreamPath.createLifecycle(input).run(context);
  }

  get runGeneration(): number {
    return this.#runGeneration;
  }

  /** The generation the settle owner should observe: the active run's, or the runner's when no run is in flight. */
  get currentRunGeneration(): number {
    return this.#currentAttempt?.epoch ?? this.#runGeneration;
  }

  /** The latest prompt messages the active turn session kept, for callers that report on them. */
  getLatestPromptMessages(): readonly unknown[] {
    return this.#latestPromptMessagesGetter?.() ?? [];
  }

  get isComputerUseSubagent(): boolean {
    return this.isSubagentRunner && subagentTypeIs(this.subagentType, "computeruse");
  }

  /** The computer/browser coordination this runner shares with its remote resources. */
  get computerUse(): ReturnType<typeof createComputerUseCoordination<Context>> | undefined {
    return this.#computerUse;
  }

  probeNavigationAfterComputerUse(context: Context, connection: { readonly remoteAccessor: unknown }): void {
    const probe = this.#computerUse?.getOrCreateNavigationProbe();
    if (probe === undefined) return;
    const detached = typeof context.withDetached === "function" ? context.withDetached() : context;
    const windowIndex = this.options.getBoxWindowIndex?.(this.resolveBoxId()) ?? 1;
    void probe.probe(detached, connection.remoteAccessor, windowIndex);
  }

  get isBrowserUseSubagent(): boolean {
    return this.isSubagentRunner && subagentTypeIs(this.subagentType, "browseruse");
  }

  get isBoxScopedSubagent(): boolean {
    return this.isComputerUseSubagent || this.isBrowserUseSubagent;
  }

  resolveAutoReviewApproval(approvalId: string, resolution: SlateAutoReviewResolution): boolean {
    return this.autoReviewController?.resolveApproval(approvalId, resolution) !== undefined;
  }

  beginAutoReviewUserMessageEpoch(): void {
    this.autoReviewController?.beginUserMessageEpoch();
  }

  expireAutoReviewApprovals(): void {
    this.autoReviewController?.expire("session_end");
  }

  bindSessionServices(bindings: RunnerServiceBindings): void {
    const { agentState, memory, automation, toolAccess, attachments } = bindings;
    if (agentState !== undefined) {
      this.#agentStore = agentState.store;
      this.#agentProfileProvider = agentState.profileProvider;
      this.#runGeneration += 1;
    }
    applyRunnerSlotBindings(memory, {
      primary: value => { this.#memoryStore = value },
      user: value => { this.#userMemory = value },
      project: value => { this.#projectMemory = value },
      snapshots: value => { this.#memorySnapshots = value },
      profileSnapshots: value => { this.#profilePromptSnapshots = value },
      episodeProgress: value => { this.#episodeProgress = value },
    });
    applyRunnerSlotBindings(automation, {
      automations: value => { this.#automationStore = value },
      workflows: value => { this.#workflowStore = value },
      channels: value => { this.#channelStore = value },
    });
    applyRunnerSlotBindings(toolAccess, {
      mcp: value => { this.#mcp = value },
      management: value => { this.#mcpManagement = value },
    });
    applyRunnerSlotBindings(attachments, {
      ingestor: value => { this.#attachmentIngestor = value },
      imagePersister: value => { this.#persistImage = value },
      mediaPersister: value => { this.#persistMediaBytes = value },
    });
  }

  setBackgroundSubagentHandler(handler: (completion: BackgroundSubagentCompletion) => void): void {
    this.subagents.setBackgroundSubagentHandler(handler);
  }

  setBackgroundSubagentDispatchHandler(handler: Parameters<typeof this.subagents.setBackgroundSubagentDispatchHandler>[0]): void {
    this.subagents.setBackgroundSubagentDispatchHandler(handler);
  }

  setComputerUseUsageHandler(handler: (event: unknown) => void): void {
    this.#onComputerUseUsage = handler;
  }

  setSubagentEventHandler(handler: Parameters<typeof this.subagents.setSubagentEventHandler>[0]): void {
    this.subagents.setSubagentEventHandler(handler);
  }

  setTurnAwaitHandler(handler: Parameters<typeof this.observation.setTurnAwaitHandler>[0]): void {
    this.observation.setTurnAwaitHandler(handler);
  }

  setTurnRetryHandler(handler: Parameters<typeof this.observation.setTurnRetryHandler>[0]): void {
    this.observation.setTurnRetryHandler(handler);
  }

  setFirstTokenHandler(handler: Parameters<typeof this.observation.setFirstTokenHandler>[0]): void {
    this.observation.setFirstTokenHandler(handler);
  }

  setSendDispatchHandler(handler: Parameters<typeof this.observation.setSendDispatchHandler>[0]): void {
    this.observation.setSendDispatchHandler(handler);
  }

  setToolCallDiagnosticHandler(handler: Parameters<typeof this.observation.setToolCallDiagnosticHandler>[0]): void {
    this.observation.setToolCallDiagnosticHandler(handler);
  }

  setAsyncTasksEventHandler(handler: Parameters<typeof this.observation.setAsyncTasksEventHandler>[0]): void {
    this.observation.setAsyncTasksEventHandler(handler);
  }

  setBackgroundShellHandler(handler: (completion: BackgroundSubagentCompletion) => void): void {
    this.#onBackgroundShellSettled = handler;
  }

  setPendingWakeArmedHandler(handler: (event: unknown) => void): void {
    this.#onPendingWakeArmed = handler;
  }

  setPendingWakeDisarmedHandler(handler: (event: unknown) => void): void {
    this.#onPendingWakeDisarmed = handler;
  }

  listRunningSubagents(): RunningSubagentInfo[] {
    return this.subagents.listRunningSubagents();
  }

  getRunningSubagent(id: string): RunningSubagentInfo | null {
    return this.subagents.getRunningSubagent(id);
  }

  steerSubagent(id: string, message: string) {
    return this.subagents.steerSubagent(id, message);
  }

  abortSubagent(id: string) {
    return this.subagents.abortSubagent(id);
  }

  listSubagents() {
    return this.subagents.listSubagents();
  }

  hasSubagent(id: string): boolean {
    return this.subagents.hasSubagent(id);
  }

  hasRunningSubagents(): boolean {
    return this.subagents.hasRunningSubagents();
  }

  getSubagentOutline(id: string): Promise<readonly unknown[]> {
    return this.subagents.getSubagentOutline(id);
  }

  /** The conversation's outline, as the state itself says it is: a subagent task is an item like any other. */
  async getResolvedOutline(): Promise<readonly OutlineItem[]> {
    return deriveOutlineFromConversationState(this.#state);
  }

  getTranscriptPath(): string | null {
    const folder = this.options.getTranscriptsFolder?.();
    if (folder == null || folder.length === 0) return null;
    const id = this.getTranscriptId();
    const base = folder.endsWith("/") ? folder.slice(0, -1) : folder;
    return `${base}/${id}/${id}.jsonl`;
  }

  getPendingCloudAgentWatchBcIds(): string[] {
    return [...(this.#backgroundWatches?.pendingCloudAgentWatchBcIds() ?? this.options.getPendingCloudAgentWatchBcIds?.() ?? [])];
  }

  hasRunningBackgroundShellWork(): boolean {
    return this.#backgroundWatches?.hasRunningBackgroundShellWork() ?? this.options.hasRunningBackgroundShellWork?.() ?? false;
  }

  cancelBackgroundShellRewatches(): void {
    this.#backgroundWatches?.cancelBackgroundShellRewatches();
    this.options.cancelBackgroundShellRewatches?.();
  }

  getPendingShellRewatchIds(): string[] {
    return [...(this.#backgroundWatches?.pendingShellRewatchIds() ?? this.options.getPendingShellRewatchIds?.() ?? [])];
  }

  isCloudWatchReady(): boolean {
    return this.#backgroundWatches !== undefined && this.options.cloudAgentWatcher !== undefined;
  }

  watchCloudAgent(id: string, options?: { readonly quietOrigin?: string; readonly afterFollowup?: boolean }): void {
    this.#backgroundWatches?.watchCloudAgent(id, options);
  }

  watchBackgroundShell(id: string, options?: { readonly title?: string; readonly quietOrigin?: string }): void {
    this.#backgroundWatches?.watchBackgroundShell(id, options);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#backgroundWatches?.cancelBackgroundWatches();
    this.options.cancelBackgroundShellRewatches?.();
    this.#backgroundWatches = undefined;
  }

  reset(): void {
    this.#backgroundWatches?.cancelBackgroundWatches();
    this.options.cancelBackgroundShellRewatches?.();
    this.#state = emptyConversationState();
    this.#productionConversationStateStructure = undefined;
    if (this.options.blobStore == null) {
      this.#fallbackBlobStore = new InMemoryBlobStore();
      this.#blobStore = this.#fallbackBlobStore;
    }
    this.#confirmedUserTurnWatermarkCache = undefined;
    this.#shellWatchWatermarkCache = undefined;
    this.autoReviewController?.expire("session_end");
    this.#runGeneration += 1;
    this.subagents.reset();
    this.observation.emitAsyncTasksChanged?.();
  }

  listAsyncTasks(): readonly AsyncTask[] {
    return this.observation.listAsyncTasks?.() ?? [];
  }

  getActivitySnapshot(): readonly string[] {
    return this.observation.getActivitySnapshot?.() ?? [];
  }

  getObservedToolCallCount(): number {
    return this.observation.getObservedToolCallCount?.() ?? 0;
  }

  getConversationState(): RunnerConversationState {
    return this.#state;
  }

  /**
   * The generated state, as a copy: a caller that reads it cannot mutate the store's live checkpoint through it, which is
   * what makes it safe to hand to a poll loop.
   */
  getAgentConversationStateStructure(): InteropRunnerConversationState {
    if (this.#productionConversationStateStructure !== undefined) {
      const snapshot = cloneInteropRunnerConversationState(this.#productionConversationStateStructure);
      if (snapshot === undefined) throw new TypeError("the production Agent conversation state is not bound");
      return snapshot;
    }
    const owner = this.#agentStore as { getConversationStateStructure?: () => unknown } | undefined;
    if (typeof owner?.getConversationStateStructure !== "function") throw new TypeError("the production Agent conversation state is not bound");
    const snapshot = cloneInteropRunnerConversationState(runnerConversationStateFromStoreCheckpoint(owner.getConversationStateStructure()));
    if (snapshot === undefined) throw new TypeError("the production Agent conversation state is not bound");
    return snapshot;
  }

  setAgentConversationStateStructure(structure: InteropRunnerConversationState): void {
    const snapshot = cloneInteropRunnerConversationState(structure);
    if (snapshot === undefined) throw new TypeError("the production Agent conversation state is not bound");
    this.#productionConversationStateStructure = snapshot;
  }

  getBlobStore(): BlobStore<unknown> {
    return this.#blobStore;
  }

  createPromptSession(onRequestId: (requestId: string) => void, options?: Readonly<Record<string, unknown>>): AgentPromptSession {
    if (this.options.createPromptSession == null) throw new TypeError("the production Agent prompt session is not bound");
    return this.options.createPromptSession(onRequestId, options);
  }

  createResourceAccessor(context: unknown): Promise<AgentResourceAccessor> {
    if (this.options.createResourceAccessor == null) return Promise.reject(new TypeError("the production Agent resource accessor is not bound"));
    return this.options.createResourceAccessor(context);
  }

  createSummarizationHandler(summarizationSession: unknown, options?: Readonly<{ preserveLatestImage?: boolean }>): AgentSummarizationHandler {
    if (this.options.createSummarizationHandler == null) throw new TypeError("the production Agent summarization handler is not bound");
    return this.options.createSummarizationHandler(summarizationSession, options);
  }

  createConversationActionReceiver(): AgentConversationActionReceiver {
    if (this.options.createConversationActionReceiver == null) throw new TypeError("the production Agent conversation action receiver is not bound");
    return this.options.createConversationActionReceiver();
  }

  setConversationState(state: RunnerConversationState): void {
    this.#state = state;
  }

  /**
   * Whether re-sending a message would recover the turn by prepending it: only when the message is at or before the
   * current one and the user has not confirmed it yet. The watermark is remembered either way, because a recovery that
   * goes ahead has to know which turn count it started from.
   */
  async wouldRecoverViaPrepend(
    recentUserMessages: readonly { readonly id: string; readonly text: string; readonly confirmed?: boolean }[],
    currentMessageId: string,
    messageId: string,
  ): Promise<boolean> {
    const currentIndex = recentUserMessages.findIndex((message) => message.id === currentMessageId);
    const targetIndex = recentUserMessages.findIndex((message) => message.id === messageId);
    if (currentIndex < 0 || targetIndex < 0) return false;
    this.#confirmedUserTurnWatermarkCache = { turnCount: this.#state.turns.length, messageId };
    return targetIndex <= currentIndex && recentUserMessages[targetIndex]?.confirmed !== true;
  }

  getConversationId(): string {
    return this.#identity.getConversationId();
  }

  resolveBoxId(): string {
    return this.#identity.resolveBoxId();
  }

  cloudAgentsDisabledByTeam(): boolean {
    return this.options.isCloudAgentsDisabledByTeam?.() === true;
  }

  isRunAwaitingUserSelection(): boolean {
    return this.#awaitingUserSelection;
  }

  resolveBoxTerminalsFolder(): string | undefined {
    return this.#identity.resolveTerminalsFolder();
  }

  setRemoteBoxTerminalsFolder(folder: string): void {
    this.#identity.setRemoteTerminalsFolder(folder);
  }

  resolveBoxBrowser(): { readonly display: string; readonly cdpUrl: string } | null {
    return this.#identity.resolveBrowserEndpoint(BOX_CDP_PORT_BASE);
  }

  emitRunLifecycle(event: { readonly type: "started" | "ended"; readonly requestId: string }): void {
    this.options.onRunLifecycle?.(event);
  }

  /**
   * One update, three jobs: the first real output of a run retires the first-token deadline, the run's own counters move,
   * and the transport hears about it. A widget, a secret request or an approval also pauses the run for the user.
   */
  emitUpdate(update: RunnerUpdate): void {
    const attempt = this.#currentAttempt;
    const effects = attempt?.observe(update);
    if (effects?.firstVisibleOutput === true) {
      this.#clearFirstTokenDeadline?.();
      this.#clearFirstTokenDeadline = undefined;
      this.#resetFirstTokenDeadline = undefined;
      this.#observeFirstToken?.();
      this.#observeFirstToken = undefined;
    }
    if (effects?.needsUserInput === true) this.#awaitingUserSelection = true;

    if (this.isComputerUseSubagent && update.type === "turn-ended") this.#computerUse?.recordTurnEnded(update.usage as TurnUsage | undefined);

    this.options.transport?.onUpdate(update);
    if (attempt != null && update.type === "react-to-message") {
      attempt.noteReactionApplied(this.options.transport?.lastReactionApplied?.() === true);
    }
  }

  interrupt(reason: string, supersede?: { readonly carriesRecovery: boolean }): boolean {
    if (this.#productionTurnRunShell !== undefined) return this.#productionTurnRunShell.interrupt(reason, supersede);
    const attempt = this.#currentAttempt;
    if (attempt == null) return false;
    if (!attempt.dispatchStarted && supersede != null && (!supersede.carriesRecovery || !attempt.recoverableReplay)) return false;
    this.#runInterrupted = true;
    attempt.cancel({ intentional: true, reason });
    return true;
  }

  requestQuiesceForUpgrade(): void {
    this.#quiescingForUpgrade = true;
    this.#productionTurnRunShell?.requestQuiesceForUpgrade();
    this.#backgroundWatches?.cancelBackgroundWatches();
    this.options.cancelBackgroundShellRewatches?.();
    this.autoReviewController?.expireForQuiesce();
  }

  isQuiescingForUpgrade(): boolean {
    return this.#quiescingForUpgrade;
  }

  cancelQuiesceForUpgrade(): void {
    this.#quiescingForUpgrade = false;
    this.#productionTurnRunShell?.cancelQuiesceForUpgrade();
    this.autoReviewController?.cancelQuiesce();
  }

  interruptAll(reason: string): boolean {
    const interrupted = this.interrupt(reason);
    for (const session of this.subagents.sessions.values()) session.interrupt(reason);
    return interrupted;
  }

  drainBackgroundSubagents(): Promise<void> {
    return this.subagents.drainBackgroundSubagents();
  }

  /**
   * One turn.
   *
   * A turn that arrives while the host is quiescing for an upgrade does not run at all: it answers with the empty result
   * that says so. Otherwise the run becomes the active one, the host's shell is asked to run it, and the shell's result is
   * what comes back. The step loop below is the fallback for a host that has no shell: it asks the host for one step at a
   * time and stops on the step that says it is done.
   */
  async run(
    prompt: string,
    runOptions: {
      readonly inferenceRequestId?: string;
      readonly ackToken?: string;
      readonly messageId?: string;
      readonly recentUserMessages?: readonly { readonly id: string; readonly text: string }[];
      readonly selectedImages?: readonly unknown[];
      readonly attachedFilePaths?: readonly string[];
      readonly selectedVideos?: readonly unknown[];
      readonly replyContext?: unknown;
      readonly requestSource?: string;
    } = {},
  ): Promise<T | SlateAgentRunnerResult | undefined> {
    const trimmed = prompt.trim();
    const hasAttachments = (runOptions.selectedImages?.length ?? 0) > 0 || (runOptions.attachedFilePaths?.length ?? 0) > 0 || (runOptions.selectedVideos?.length ?? 0) > 0;
    if (trimmed.length === 0 && !hasAttachments) throw new Error("Prompt cannot be empty.");
    if (this.#quiescingForUpgrade) return { text: "", sentMessageCount: 0, reacted: false, aborted: false, quiescedForUpgrade: true };
    if (this.#productionTurnRunShell !== undefined) return this.#productionTurnRunShell.run(prompt, runOptions);

    const attempt = this.beginAttempt(runOptions, trimmed);
    this.#currentAttempt = attempt;
    this.emitRunLifecycle({ type: "started", requestId: attempt.runId });
    this.observation.turnStarted();

    try {
      return await runFallbackStepLoop<T, RunnerConversationState, typeof runOptions>({
        attempt,
        prompt: trimmed,
        runOptions,
        maxSteps: this.options.maxSteps ?? SLATE_AGENT_MAX_STEPS,
        state: this.#state,
        setState: (state) => { this.#state = state },
        emitUpdate: (update) => this.emitUpdate(update),
        ...(this.options.prepare !== undefined ? { prepare: this.options.prepare.bind(this.options) } : {}),
        ...(this.options.runStep !== undefined ? { runStep: this.options.runStep.bind(this.options) } : {}),
        ...(this.options.settle !== undefined ? { settle: this.options.settle.bind(this.options) } : {}),
      });
    } finally {
      this.emitRunLifecycle({ type: "ended", requestId: attempt.runId });
      if (this.#currentAttempt === attempt) this.#currentAttempt = null;
      this.#runInterrupted = false;
      this.#activeTurnRequestSource = undefined;
      this.#activeTurnAutomationId = undefined;
      this.#latestPromptMessagesGetter = undefined;
      this.#clearFirstTokenDeadline?.();
      this.#clearFirstTokenDeadline = undefined;
      this.#resetFirstTokenDeadline = undefined;
      this.#observeFirstToken = undefined;
    }
  }

  /** The run as it starts: its identity, its controller, and whether it is the user's own message re-sent unchanged. */
  private beginAttempt(runOptions: RunnerTurnAttemptOptions, trimmed: string): RunnerTurnAttempt {
    this.#runInterrupted = false;
    this.#awaitingUserSelection = false;
    this.#activeTurnRequestSource = runOptions.requestSource ?? this.inheritedRequestSource;
    this.#activeTurnAutomationId = this.inheritedAutomationId;
    return new RunnerTurnAttempt({ generation: this.#runGeneration, prompt: trimmed, runOptions });
  }

  createDeadlineTimer(fire: () => void, milliseconds: number): { cancel(): void; restart(): void } {
    let timer = setTimeout(fire, milliseconds);
    timer.unref?.();
    return {
      cancel: () => clearTimeout(timer),
      restart: () => {
        clearTimeout(timer);
        timer = setTimeout(fire, milliseconds);
        timer.unref?.();
      },
    };
  }

  /** A discovery failure is not an empty listing: it is remembered separately so the turn can say it tried. */
  noteMcpToolDiscoveryFailed(_error: unknown): void {
    this.#mcpManagement = { previous: this.#mcpManagement, discoveryUnavailableForTurn: true };
  }

  stampInheritableRunAttributes<C extends Record<string, unknown>>(context: C, inferenceRequestId: string, turnType: string): C & { inheritableAttributes: Record<string, string> } {
    return this.#identity.stampInheritableAttributes(context, inferenceRequestId, turnType, {
      isSubagentRunner: this.isSubagentRunner,
      ...presentOptions({ subagentType: this.subagentType }),
    });
  }

  stampCallerTurnRootRequestId(span: { setAttribute(key: string, value: string): void }, inferenceRequestId: string): void {
    this.#identity.stampRootRequestId(span, inferenceRequestId);
  }

  getTranscriptId(): string {
    return this.#identity.getTranscriptId();
  }

  getComputerUseUsageSnapshot(): { readonly modelId?: string; readonly turnEndedCount: number; readonly usage?: unknown } {
    const snapshot = this.#computerUse?.usageSnapshot() ?? this.options.getComputerUseUsageSnapshot?.();
    if (snapshot === undefined) return { turnEndedCount: 0 };
    return { turnEndedCount: snapshot.turnEndedCount, ...presentOptions({ modelId: snapshot.modelId, usage: snapshot.usage }) };
  }

  getComputerUseAuditActionCounts(): ReadonlyMap<string, number> {
    return this.#computerUse?.auditActionCounts() ?? this.options.getComputerUseAuditActionCounts?.() ?? new Map();
  }

  auditShellCommand(
    shellKind: string,
    command: string,
    target: "box" | "user_machine",
    attribution: { readonly turnId?: string; readonly boxId?: string } = {},
  ): void {
    this.options.actionAuditor?.record({
      agentId: this.getConversationId(),
      occurredAtMs: (this.options.now ?? Date.now)(),
      action: { kind: "shellCommand", command, shellKind, target },
      ...presentOptions({ turnId: attribution.turnId, boxId: attribution.boxId }),
    });
  }
}
