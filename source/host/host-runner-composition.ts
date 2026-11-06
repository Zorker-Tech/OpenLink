/**
 * The host's runner composition: one place that turns a session into a turn runner.
 *
 * A session is a conversation with a box, a store, a memory, an automation store, a workflow store, a channel store and
 * an Agent store. A turn runner is what the platform's turn loop actually holds. This file connects the two, and its
 * shape follows from one rule: **the host's services are resolved by name at the moment a turn needs them, never cached
 * across turns**. That is why almost everything below is a closure over `extensions.api(...)` rather than a stored
 * reference — an extension that is replaced between turns is picked up by the next turn.
 *
 * The other rule is that **the runner is narrower where the platform is narrower**: a group-member turn gets no private
 * transcript mirror, no memory stores, no image persistence and no local permission surface, and a shared-room turn gets
 * none of the per-conversation stores at all.
 *
 * Since the host's extension APIs are loosely typed by design (they are the seam between extensions), every value that
 * crosses into the runner is checked on the way: a method that is missing is absent rather than a crash later, and a
 * value that is the wrong shape is rejected with a message that names what was expected. Those checks are grouped at the
 * top of the file so the composition itself reads as wiring.
 */
import { dirname } from "node:path";
import { TranscriptMirrorOffloadPool } from "./agents/isolation/transcript-mirror-offload.ts";
import {
  createRunnerToolInputs,
  createProductionTurnToolsetHost,
  type CreateRunnerStep,
  type TurnAutoReviewBinding,
  type CancelTurnExecution,
  type EmitTurnUpdate,
  type TurnAwaitPort,
  type TurnHostServices,
  type TurnHostOverrides,
  type RunnerToolInputs,
  type TurnToolsetHostBinding,
} from "./runner-production-bridge.ts";
import { NoopConversationActionReceiver } from "../packages/agent-core/conversation-actions/remote-receiver.ts";
import { SummarizationHandler, type SummarizationPromptSession } from "../packages/agent-summarization/summarization-handler.ts";
import { getAgentBlobStore, type AgentProfileForRunner } from "./runner/slate-agent-runner.ts";
import type { RunnerServiceBindings } from "./runner/runner-service-bindings.ts";
import type { AutomationRecord, AutomationReview, WorkflowRecord } from "./runner/tools/slate-state-tool.ts";
import type { CloudAgentApi, CloudAgentToolContext, CloudAgentToolDeps } from "./cloud-agents/cloud-agent-tool.ts";
import {
  SLATE_BOX_READ_TOOL_DESCRIPTION,
  SLATE_EXTERNAL_READ_TOOL_DESCRIPTION,
  SLATE_READ_FORMATTING_OPTIONS,
  type TurnAwaitToolFactoryInput,
  type TurnCloudAgentToolFactoryInput,
  type TurnMcpManagementToolFactoryInput,
  type TurnReadToolFactoryInput,
  type TurnShellAutoReviewInput,
  type TurnToolsetHost,
  type TurnToolsetHostFactoryProvider,
  type TurnToolsetTurnInput,
  type TurnWebFetchToolFactoryInput,
  type TurnWebSearchToolFactoryInput,
} from "./runner/tools/turn-toolset.ts";
import type { RemoteResource, ResourceAccessor } from "../packages/agent-exec/resource-provider.ts";
import { subagentExecutorResource } from "../adapters/interop/agent/subagent-exec-adapter.ts";
import { slateSubagentExecutorResource } from "../packages/agent-exec/subagent.ts";
import { slateSubagentBackgroundHandoffExecutorResource } from "../packages/agent-exec/subagent-control.ts";
import { slateSubagentAwaitExecutorResource } from "../packages/agent-exec/subagent-await.ts";
import type { SlateSubagentAwaitRequest, SlateSubagentAwaitResult } from "../packages/agent-exec/subagent-await.ts";
import { requestContextExecutorResource } from "../packages/agent-exec/request-context-operation.ts";
import { subagentRegistryResource } from "../packages/agent/tools/subagent-registry.ts";
import { smartModeClassifierExecutorResource } from "../packages/agent-exec/smart-mode-classifier-operation.ts";
import { mcpExecutorResource, mcpStateExecutorResource } from "../packages/agent-exec/mcp-operations.ts";
import { shellStreamExecutorResource } from "../packages/agent-exec/shell-stream-operation.ts";
import { backgroundShellExecutorResource } from "../packages/agent-exec/background-shell.ts";
import type { RemoteExecManager } from "../packages/agent-exec/executor-resources.ts";
import { SLATE_BOX_AWAIT_SHELL_TOOL_NAME, SLATE_BOX_READ_TOOL_NAME, SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME, SLATE_EXTERNAL_READ_TOOL_NAME } from "./slate-activity.ts";
import { connectorMessageFromEmission } from "./runner/tools/box-help-tool.ts";
import { createAgentPromptSession } from "./extensions/inference/extension.ts";
import { CONNECTOR_MANIFESTS } from "./channels/channels.ts";
import { parseStoredTrigger } from "./automations/automation-trigger.ts";
import { listenerPlatformsInTrigger } from "./automations/listener-platforms.ts";
import { sharedRoomBoxToolsAreEnabled } from "./groups/xuser.ts";
import { boxAgentWindowIndex, boxSupportsMultiWindow } from "./boxes/box-capabilities.ts";
import { createAutoReviewGate } from "./runner/auto-review-gate.ts";
import { slateAutoReviewApprovalExpiryPolicy, SlateAutoReviewController } from "./runner/slate-auto-review.ts";
import { createHostBrowserDriverDependencies, createHostComputerToolDependencies, createHostShellExecutor, type HostBrowserBoxOwner } from "./runner/host-computer-tool-dependencies.ts";
import { createRemoteBoxResourceAccessor, type RemoteBoxResourceHost } from "./runner/remote-box-resources.ts";
import { executeBoxWindowShellCommand } from "../adapters/interop/agent/box-window-shell-result-adapter.ts";
import { createStreamAttempt } from "./runner/stream-attempt.ts";
import { createTurnAgentRunStreamInput, createTurnAgentStreamStart, runnerConversationStateFromStoreCheckpoint, type TurnLocalResourceProjectionInput } from "./runner/turn-agent-composition.ts";
import { createProductionTurnAgentOwner, createProductionTurnAgentRunInput, type ProductionTurnAgentOwnerInput } from "./runner/production-turn-agent-owner.ts";
import { createProductionTurnRunShellHostInput } from "./runner/production-turn-run-shell-adapter.ts";
import { createPromptCollectorGlue, type PromptCollectorHost } from "./runner/prompt-collector-glue.ts";
import { interopTurnPromptOptionsFromRunner } from "../adapters/interop/agent/prompt-action-adapter.ts";
import type { InteropTurnPromptOptions } from "../adapters/interop/agent/prompt-action-adapter.ts";
import type { ShellTerminalWatchHost } from "./runner/shell-terminal-watch.ts";
import { createShellWatchGeneratedStateProjection, createShellWatchReadAccessor } from "../adapters/interop/agent/shell-terminal-watch-adapter.ts";
import { DEFAULT_SLATE_SYSTEM_PROMPT } from "./runner/system-prompt.ts";
import { createSystemPromptAssembly, type PromptSnapshotStore } from "./runner/system-prompt-assembly.ts";
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../packages/redaction/privacy-mode.ts";
import { tryExtractSlateAutoReviewClassifierConversationContext } from "../packages/agent/smart-mode-classifier-context.ts";
import { buildSlateAutomationWriteRiskTarget, reviewSlateAutomationWrite, SLATE_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON } from "./runner/slate-automation-auto-review.ts";
import { runSlateAutoReviewClassifier } from "./runner/slate-auto-review-classifier-run.ts";
import { connectCardsFor } from "./runner/tools/listener-connect-cards.ts";
import {
  buildSlateCloudAgentLifecycleReviewTarget,
  buildSlateCloudAgentReviewTarget,
  buildSlateCloudAgentRiskTarget,
  describeSlateCloudAgentReviewImages,
  reviewSlateCloudAgentAction,
  reviewSlateCloudAgentLifecycleAction,
  SLATE_CLOUD_AGENT_CLASSIFIER_ERROR_REASON,
} from "./runner/slate-cloud-agent-auto-review.ts";
import type { Context } from "../packages/context/context.ts";
import type { TurnSettleHost } from "./runner/turn-settle.ts";
import type { TextExecutor } from "./runner/slate-memory.ts";
import type { AgentProfilePromptSnapshot } from "./runner/slate-agent-profile-prompt.ts";
import type { RunningSubagentInfo, SubagentManagementController } from "./runner/tools/slate-subagent-management-tools.ts";
import type { SubagentSession, SubagentRunOptions } from "./runner/subagent-runtime.ts";
import type { SubagentAdapterArgs } from "./runner/agent-adapters.ts";
import { presentOptions } from "./runner/optional-options.ts";
import { HostRunnerPermissionSurfaces } from "./runner/host-runner-permission-surfaces.ts";
import { deriveHostRunnerScope } from "./runner/host-runner-turn-scope.ts";
import {
  createProductionTurnSettleHost as createProductionTurnSettleHostAdapter,
  type ProductionTurnSettleRunner,
} from "./runner/production-turn-settle-host.ts";
import {
  asCapableTransferBox,
  asPromptUserComputers,
  asRemoteBoxResourceOwner,
  asTransferBox,
  isAgentContext,
} from "./runner/host-runner-capabilities.ts";

export const DEFAULT_SLATE_MODEL = "gpt-5.5-high-fast";
export const SLATE_SUMMARIZATION_MAX_PROMPT_CHARS = 2_800_000;

type DynamicApi = Record<string, any>;

export interface HostRunnerSession {
  readonly id: string;
  readonly dbPath: string;
  readonly agentStore?: DynamicApi;
  readonly memory?: unknown;
  readonly automations?: unknown;
  readonly workflows?: unknown;
  readonly channels?: unknown;
  readonly db?: unknown;
}

export interface HostRunnerHooks {
  readonly transport: {
    onUpdate(update: unknown, cancelThisRun?: CancelTurnExecution): void;
    lastSentMessageId?(): string | undefined;
    lastReactionApplied?(): boolean;
  };
  /** The turn-scoped card emitter; a caller that has none keeps that branch closed. */
  readonly emitUpdate?: EmitTurnUpdate;
  readonly onRunLifecycle?: (event: unknown) => void;
  readonly agentProfileProvider?: () => AgentProfileForRunner | null;
  readonly ingestAttachment?: (sourcePath: string) => Promise<string>;
  readonly persistImage?: (...args: any[]) => unknown;
  readonly persistMediaBytes?: (filename: string, data: Uint8Array) => Promise<string | null>;
}

export interface HostRunnerOverrides {
  readonly groupMemberTurn?: boolean;
  readonly isSharedRoomTurn?: boolean;
  readonly systemPrompt?: unknown;
  readonly [key: string]: unknown;
}

export interface HostRunnerExtensions {
  api(id: string): DynamicApi;
}

/** The box a turn's resources come from; it is asked per turn, and its accessor is never cached between turns. */
export interface ProductionBoxResourceOwner {
  ensureReady(context: unknown, agentId: string): Promise<{ readonly remoteAccessor?: unknown }>;
}

export type ProductionResourceAccessor = ResourceAccessor<RemoteExecManager>;

/** A per-turn accessor: ask the box, check it answers with a real accessor, and hand that on. */
export function createPerTurnResourceAccessor(owner: ProductionBoxResourceOwner, agentId: string): (context: unknown) => Promise<ProductionResourceAccessor> {
  return async (context: unknown): Promise<ProductionResourceAccessor> => {
    const connection = await owner.ensureReady(context, agentId);
    const accessor = connection?.remoteAccessor;
    if (typeof accessor !== "object" || accessor == null || typeof (accessor as { readonly get?: unknown }).get !== "function") {
      throw new TypeError("the production Agent resource accessor is not bound");
    }
    return accessor as ProductionResourceAccessor;
  };
}

/** What the composition needs from a runner, which is the runner's public surface rather than its class. */
export interface ProductionSessionBoundRunner {
  readonly subagents: {
    readonly sessions: Map<string, SubagentSession>;
    isRunning(agentId: string): boolean;
    hasRunningToolCall(toolCallId: string): boolean;
    awaitSubagent(request: SlateSubagentAwaitRequest, signal: AbortSignal): Promise<SlateSubagentAwaitResult>;
    dispatchBackgroundSubagent(input: Parameters<TurnLocalResourceProjectionInput["subagentDispatcher"]["dispatch"]>[0]): void;
  };
  readonly computerUse:
    | {
        allocateWindow(agentId: string): unknown | null;
        freeWindow(agentId: string): void;
      }
    | undefined;
  run(prompt: string, options?: SubagentRunOptions): Promise<unknown>;
  interrupt(reason: string): unknown;
  getResolvedOutline(): Promise<readonly unknown[]>;
  getObservedToolCallCount(): number;
  getActivitySnapshot(): readonly string[];
  getTranscriptPath(): string | null;
  bindSessionServices(bindings: RunnerServiceBindings): void;
}

export interface HostRunnerCompositionDependencies<Runner extends ProductionSessionBoundRunner = ProductionSessionBoundRunner> {
  readonly extensions: HostRunnerExtensions;
  readonly ctx: unknown;
  emitGatewayEvent(event: unknown): void;
  buildRunner(options: Record<string, unknown>): Runner;
  readonly createRunStep?: CreateRunnerStep;
  createRequestContext?(options: {
    transcriptsDir: string;
    getUserTimeZone(): unknown;
    resolveTeamRules(): Promise<unknown>;
    getUserFullName(): Promise<unknown>;
  }): unknown;
  createTranscriptMirror?(options: {
    transcriptsDir: string;
    session: HostRunnerSession;
    pool: () => TranscriptMirrorOffloadPool;
    reportOutcome(report: unknown): void;
    isJournalEnabled(): Promise<boolean>;
  }): unknown;
  decorateActionAuditor?(
    actionAuditor: unknown,
    callbacks: {
      onBotBlock(hit: any, record: any): void;
      onSiteVisit(visit: any, record: any): void;
    },
  ): unknown;
  readonly mirrorPoolFactory?: () => TranscriptMirrorOffloadPool;
}

export interface RecoveredHostRunnerComposition<Runner extends ProductionSessionBoundRunner> {
  createRunner(session: HostRunnerSession, hooks: HostRunnerHooks): Runner;
  createGroupMemberRunner(session: HostRunnerSession, hooks: HostRunnerHooks, overrides: HostRunnerOverrides): Runner;
  canAskLocalToolPermission(agentId: string): boolean;
  forgetLocalToolPermission(agentId: string): void;
  dispose(): Promise<void>;
}

/** A method of an extension API, bound to its object — or nothing, if that extension does not offer it. */
function looseMethod(api: DynamicApi | undefined, name: string): ((...args: any[]) => any) | undefined {
  if (api == null) return undefined;
  const candidate = api[name];
  return typeof candidate === "function" ? candidate.bind(api) : undefined;
}

function asAutoReviewController(value: unknown): SlateAutoReviewController | undefined {
  return value instanceof SlateAutoReviewController ? value : undefined;
}

function asActionAuditor(value: unknown): NonNullable<TurnAutoReviewBinding["actionAuditor"]> | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const record = (value as Record<string, unknown>).record;
  if (typeof record !== "function") return undefined;
  return { record: (entry) => record.call(value, entry) };
}

function asLocalToolPermissionProjection(value: unknown): NonNullable<TurnAutoReviewBinding["localToolPermission"]> | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const awaitDesktopStandingDecision = candidate.awaitDesktopStandingDecision;
  const completeScope = candidate.completeScope;
  if (typeof awaitDesktopStandingDecision !== "function" || typeof completeScope !== "function") return undefined;
  return {
    awaitDesktopStandingDecision: (args) => awaitDesktopStandingDecision.call(value, args),
    completeScope: (scope) => completeScope.call(value, scope),
  };
}

type ProductionClassifierStateHandler = Parameters<typeof tryExtractSlateAutoReviewClassifierConversationContext>[1];

function asClassifierStateHandler(value: unknown): ProductionClassifierStateHandler | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const rootPromptBuilder = candidate.rootPromptBuilder;
  if (!Array.isArray(candidate.turns)) return undefined;
  if (typeof rootPromptBuilder !== "object" || rootPromptBuilder == null) return undefined;
  if (typeof (rootPromptBuilder as Record<string, unknown>).getState !== "function") return undefined;
  return value as ProductionClassifierStateHandler;
}

/** The classifier's view of the conversation, when the host's state handler is one it can read. */
export async function extractProductionTurnAutoReviewConversationContext(context: Context, stateHandler: unknown) {
  const candidate = asClassifierStateHandler(stateHandler);
  if (candidate === undefined) return [];
  return [...(await tryExtractSlateAutoReviewClassifierConversationContext(context, candidate))];
}

/** What the prompt needs from a request context: the environment and the project's rules. */
interface PromptRequestContext {
  resolve(): { readonly osVersion?: string; readonly shell?: string; readonly timeZone?: string; readonly transcriptsFolder?: string; readonly userFullName?: string };
  resolveRules(): Promise<readonly unknown[] | undefined>;
}

/**
 * The box registry as an accessor: a resource the registry does not have is an error that names the resource, because a
 * missing implementation means the composition forgot to register it, not that the turn has nothing to do.
 */
function asProductionResourceAccessor(registry: ReturnType<typeof createRemoteBoxResourceAccessor>): ProductionResourceAccessor {
  return {
    get<Implementation>(resource: RemoteResource<Implementation, RemoteExecManager>): Implementation {
      const value = registry.get({ symbol: resource.symbol, remoteImplementation: resource.remoteImplementation, registerControlledImplementation: () => {} });
      if (value === undefined) {
        const knownResources: ReadonlyArray<readonly [symbol, string]> = [
          [subagentExecutorResource.symbol, "subagentExecutorResource"],
          [slateSubagentExecutorResource.symbol, "slateSubagentExecutorResource"],
          [slateSubagentBackgroundHandoffExecutorResource.symbol, "slateSubagentBackgroundHandoffExecutorResource"],
          [slateSubagentAwaitExecutorResource.symbol, "slateSubagentAwaitExecutorResource"],
          [requestContextExecutorResource.symbol, "requestContextExecutorResource"],
          [subagentRegistryResource.symbol, "subagentRegistryResource"],
          [smartModeClassifierExecutorResource.symbol, "smartModeClassifierExecutorResource"],
          [mcpExecutorResource.symbol, "mcpExecutorResource"],
          [mcpStateExecutorResource.symbol, "mcpStateExecutorResource"],
          [shellStreamExecutorResource.symbol, "shellStreamExecutorResource"],
          [backgroundShellExecutorResource.symbol, "backgroundShellExecutorResource"],
        ];
        const requested = {
          resourceName: knownResources.find(([known]) => known === resource.symbol)?.[1] ?? "unknownResource",
          symbolDescription: resource.symbol.description ?? null,
          symbolRegistryKey: Symbol.keyFor(resource.symbol) ?? null,
          remoteImplementationName: resource.remoteImplementation.name || null,
        };
        const error = new TypeError(`the production remote resource is not registered: ${JSON.stringify(requested)}`);
        Object.defineProperties(error, {
          requestedResourceSymbol: { value: resource.symbol, enumerable: true },
          requestedResourceProvenance: { value: requested, enumerable: true },
        });
        console.error("[slate-host] production resource lookup failed", error);
        throw error;
      }
      return value;
    },
  };
}

function isAgentProfilePromptSnapshot(value: unknown): value is AgentProfilePromptSnapshot {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Record<string, unknown>;
  const identity = (entry: unknown): boolean =>
    typeof entry === "object" && entry != null && typeof (entry as Record<string, unknown>).name === "string" && typeof (entry as Record<string, unknown>).description === "string";
  return (
    candidate.version === 1 &&
    typeof candidate.profileSection === "string" &&
    identity(candidate.systemIdentity) &&
    identity(candidate.announcedIdentity) &&
    typeof candidate.compactionEpoch === "number"
  );
}

function asPromptSnapshotStore(value: unknown): PromptSnapshotStore | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const getSnapshot = candidate.getAgentProfilePromptSnapshot;
  const setSnapshot = candidate.setAgentProfilePromptSnapshot;
  if (typeof getSnapshot !== "function" || typeof setSnapshot !== "function") return undefined;
  return {
    getAgentProfilePromptSnapshot: () => {
      const snapshot = getSnapshot.call(value);
      return isAgentProfilePromptSnapshot(snapshot) ? snapshot : undefined;
    },
    setAgentProfilePromptSnapshot: (snapshot) => {
      setSnapshot.call(value, snapshot);
    },
  };
}

/** The inference port as a turn owner: a session factory, a privacy resolver, and an optional summarization factory. */
function createTypedInferenceOwner(value: DynamicApi): ProductionTurnAgentOwnerInput["inference"] {
  const createSession = looseMethod(value, "createSession");
  const resolvePrivacyMode = looseMethod(value, "resolvePrivacyMode");
  if (createSession === undefined || resolvePrivacyMode === undefined) throw new TypeError("the production inference session/privacy owner is not bound");
  const createSummarizationSession = looseMethod(value, "createSummarizationSession");
  return {
    createSession: (onRequestId, options) => createSession(onRequestId, options),
    resolvePrivacyMode: async (): Promise<PrivacyModeValue> => {
      const resolved = await resolvePrivacyMode();
      const known = [
        PrivacyMode.UNSPECIFIED,
        PrivacyMode.NO_STORAGE,
        PrivacyMode.NO_TRAINING,
        PrivacyMode.USAGE_DATA_TRAINING_ALLOWED,
        PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED,
      ] as readonly unknown[];
      if (known.includes(resolved)) return resolved as PrivacyModeValue;
      throw new TypeError("the production inference returned an invalid privacy mode");
    },
    ...presentOptions({
      createSummarizationSession:
        createSummarizationSession === undefined
          ? undefined
          : (onRequestId: (requestId: string) => void, options?: Readonly<Record<string, unknown>>) => createSummarizationSession(onRequestId, options),
    }),
  };
}

/** A prompt executor as the memory owner's text executor: the stream is checked before it is handed on. */
function createTextExecutor(executor: {
  appendMessages(...args: any[]): void;
  clearMessages(): void;
  getMessages(): readonly unknown[];
  getState(): unknown;
  stream(...args: any[]): unknown;
}): TextExecutor {
  return {
    appendMessages: (messages) => executor.appendMessages(messages),
    clearMessages: () => executor.clearMessages(),
    getMessages: () => executor.getMessages(),
    getState: () => executor.getState(),
    stream: (context, first, second, options) => {
      const result = executor.stream(context, first, second, options);
      if (typeof result !== "object" || result == null) throw new TypeError("the production prompt executor returned no stream");
      const fullStream = (result as Record<string, unknown>).fullStream;
      if (typeof fullStream !== "object" || fullStream == null || typeof (fullStream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
        throw new TypeError("the production prompt executor returned an invalid stream");
      }
      return { fullStream: fullStream as AsyncIterable<{ readonly type: string; readonly textDelta?: string; readonly error?: unknown }> };
    },
  };
}

function isPromptRequestContext(value: unknown): value is PromptRequestContext {
  return typeof value === "object" && value != null && typeof (value as { resolve?: unknown }).resolve === "function" && typeof (value as { resolveRules?: unknown }).resolveRules === "function";
}

/** What a request context says about the machine the turn runs for: the time zone, the folder, the OS. */
function resolveRequestContextEnvironment(requestContext: unknown): { readonly timeZone?: string; readonly projectFolder?: string; readonly osVersion?: string } {
  if (typeof requestContext !== "object" || requestContext == null || typeof (requestContext as { readonly resolve?: unknown }).resolve !== "function") return {};
  const resolved = (requestContext as { resolve(): unknown }).resolve();
  if (typeof resolved !== "object" || resolved == null) return {};
  const candidate = resolved as Record<string, unknown>;
  const environment = typeof candidate.env === "object" && candidate.env != null ? (candidate.env as Record<string, unknown>) : candidate;
  const timeZone = candidate.timeZone ?? environment.timeZone;
  const osVersion = candidate.osVersion ?? environment.osVersion;
  return {
    ...(typeof timeZone === "string" ? { timeZone } : {}),
    ...(typeof environment.projectFolder === "string" ? { projectFolder: environment.projectFolder } : {}),
    ...(typeof osVersion === "string" ? { osVersion } : {}),
  };
}

function isCloudAgentApi(api: DynamicApi): api is CloudAgentApi {
  return ["launch", "list", "listModels", "get", "reply", "rename", "cancel", "setArchived", "delete", "listArtifacts", "getTranscriptDump"].every((name) => typeof api[name] === "function");
}

interface RunnerSubagentOwner {
  listRunningSubagents(): readonly RunningSubagentInfo[];
  getRunningSubagent(id: string): RunningSubagentInfo | null;
  steerSubagent(id: string, message: string): "steered" | "not-running" | string;
  abortSubagent(id: string): "aborted" | "not-running" | string;
}

interface RunnerCloudWatchOwner {
  isCloudWatchReady?(): boolean;
  watchCloudAgent(id: string, options?: { readonly quietOrigin?: string; readonly afterFollowup?: boolean }): void;
}

function isRunnerSubagentOwner(value: unknown): value is RunnerSubagentOwner {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Record<string, unknown>;
  return ["listRunningSubagents", "getRunningSubagent", "steerSubagent", "abortSubagent"].every((name) => typeof candidate[name] === "function");
}

function createRunnerSubagentManagement(value: unknown): SubagentManagementController<unknown> | undefined {
  if (!isRunnerSubagentOwner(value)) return undefined;
  return {
    listRunningSubagents: () => value.listRunningSubagents(),
    getRunningSubagent: (id) => value.getRunningSubagent(id) ?? undefined,
    steerSubagent: (id, message) => value.steerSubagent(id, message),
    abortSubagent: (id) => value.abortSubagent(id),
  };
}

function createRunnerCloudWatch(value: unknown): CloudAgentToolDeps["watch"] | undefined {
  if (typeof value !== "object" || value == null || typeof (value as Record<string, unknown>).watchCloudAgent !== "function") return undefined;
  const owner = value as RunnerCloudWatchOwner;
  if (typeof owner.isCloudWatchReady === "function" && owner.isCloudWatchReady() !== true) return undefined;
  return (id, options) => {
    const quietOrigin = typeof options.quietOrigin === "string" ? options.quietOrigin : undefined;
    owner.watchCloudAgent(id, {
      ...presentOptions({ quietOrigin }),
      ...(options.afterFollowup === undefined ? {} : { afterFollowup: options.afterFollowup }),
    });
  };
}

/** A request id, forwarded to the client so it can follow the request it started. */
function requestIdForwarder(hooks: HostRunnerHooks, source: string) {
  return (requestId: string) => {
    hooks.transport.onUpdate({ type: "request-id", requestId, source });
  };
}

/**
 * A session becomes a runner.
 *
 * The composition keeps one surface per agent for the local permission prompts (so a second turn for the same agent
 * replaces the first subscription rather than stacking on it), tracks every runner it built (so shutdown can interrupt
 * and dispose all of them), and owns the lazy mirror pool (so the pool exists only once something mirrors).
 */
export function createHostRunnerComposition<Runner extends ProductionSessionBoundRunner>(deps: HostRunnerCompositionDependencies<Runner>): RecoveredHostRunnerComposition<Runner> {
  const { extensions, ctx } = deps;
  const auth = extensions.api("auth");
  const localToolPermission = extensions.api("local-tool-permission");
  const subscribePermissionEvents = looseMethod(localToolPermission, "subscribe");
  const localToolPermissionSurfaces = new HostRunnerPermissionSurfaces(
    subscribePermissionEvents === undefined ? undefined : (listener) => subscribePermissionEvents(listener),
  );
  const ownedRunners = new Set<Runner>();
  let mirrorOffloadPool: TranscriptMirrorOffloadPool | null = null;

  const getMirrorOffloadPool = (): TranscriptMirrorOffloadPool => {
    mirrorOffloadPool ??= deps.mirrorPoolFactory?.() ?? new TranscriptMirrorOffloadPool();
    return mirrorOffloadPool;
  };

  const resolveAgentDisplayName = (agentId: string): string | null => {
    const roster = looseMethod(extensions.api("transcript"), "listAgentsSync")?.() ?? [];
    return roster.find((agent: any) => agent.id === agentId && agent.isGroup !== true)?.name ?? null;
  };

  function createRunner(session: HostRunnerSession, hooks: HostRunnerHooks, overrides: HostRunnerOverrides = {}): Runner {
    const scope = deriveHostRunnerScope(overrides);
    const isSharedRoomTurn = scope.sharedRoomTurn;
    const localExec = extensions.api("local-exec");
    const attachments = extensions.api("attachments");
    const memory = extensions.api("memory");
    const transcript = extensions.api("transcript");
    const experiments = extensions.api("experiments");
    const telemetry = extensions.api("telemetry");
    const analytics = telemetry.analytics as DynamicApi | undefined;
    const mcp = extensions.api("mcp");
    const sessionApi = extensions.api("session");
    const settings = extensions.api("settings");
    const cloudAgents = extensions.api("cloud-agents");
    const foreverBox = extensions.api("forever-box");
    const remoteBox = foreverBox.box as DynamicApi;
    const transcriptsDir = looseMethod(sessionApi, "transcriptsDir")?.() ?? dirname(dirname(session.dbPath));

    // What the agent did on the web is audited by the action-audit extension, and the host reports the interesting parts:
    // a blocked bot, a visited site.
    const actionAuditor =
      deps.decorateActionAuditor?.(extensions.api("action-audit"), {
        onBotBlock(hit, record) {
          looseMethod(telemetry.brain ?? {}, "reportBotBlock")?.({
            conversationId: record.agentId,
            family: hit.family,
            confidence: hit.confidence,
            blockedHost: hit.blockedHost,
            blockedUrl: hit.blockedUrl,
          });
          looseMethod(analytics ?? {}, "trackEvent")?.("slate.bot_block", {
            agent_id: record.agentId,
            family: hit.family,
            confidence: hit.confidence,
            blocked_host: hit.blockedHost,
            blocked_url: hit.blockedUrl,
          });
        },
        onSiteVisit(visit, record) {
          looseMethod(analytics ?? {}, "trackEvent")?.("slate.site.visited", { agent_id: record.agentId, host: visit.host });
        },
      }) ?? extensions.api("action-audit");

    const autoReview =
      looseMethod(extensions.api("auto-review"), "bindRunner")?.({
        agentId: session.id,
        approvalsResolvable: scope.approvalsResolvable,
        onUpdate: (update: unknown) => hooks.transport.onUpdate(update),
      }) ?? {};
    const autoReviewController = asAutoReviewController(autoReview.autoReviewController);

    const autoReviewGate = (() => {
      if (autoReviewController == null || autoReview.autoReviewModes == null || typeof autoReview.getAutoReviewModes !== "function") return undefined;
      return createAutoReviewGate({
        baseModes: autoReview.autoReviewModes,
        getModes: () => autoReview.getAutoReviewModes(),
        controller: () => autoReviewController,
        resolveBoxId: () => session.id,
        ...(typeof autoReview.getAutoReviewInstructions === "function" ? { getInstructions: () => autoReview.getAutoReviewInstructions() } : {}),
      });
    })();

    const persistImageForTurn =
      typeof hooks.persistImage === "function"
        ? async (bytes: Uint8Array, mimeType: string) => {
            const result = await hooks.persistImage?.(bytes, mimeType);
            return typeof result === "object" && result != null && "fileUrl" in result && typeof result.fileUrl === "string" ? { fileUrl: result.fileUrl } : undefined;
          }
        : undefined;

    /** The box's own tools this turn may use: computer, screenshot and browser, each under the turn's review identity. */
    const createTurnToolProjections =
      autoReviewGate == null
        ? undefined
        : (input: RunnerToolInputs): TurnHostOverrides => {
            const shell = createHostShellExecutor({
              resourceAccessor: input.resourceAccessor,
              assertNoPendingApproval: autoReviewGate.assertNoPendingApproval,
              auditShellCommand: (command) => {
                looseMethod(actionAuditor as DynamicApi, "record")?.({
                  agentId: session.id,
                  occurredAtMs: Date.now(),
                  action: { kind: "shellCommand", command, shellKind: "foreground", target: "box" },
                });
              },
            });
            const userAutoRunInstructions = autoReviewGate.userInstructions();
            const modes = autoReviewGate.currentModes();
            const boxIdentity = { boxId: session.id, windowGeneration: `${autoReviewController?.hostGeneration ?? "host"}:${session.id}` };
            const resolveDisplayNumber = async (displayContext: unknown) => {
              await looseMethod(remoteBox, "ensureReady")?.(displayContext, session.id);
              const windowIndex = boxAgentWindowIndex(remoteBox as any, session.id);
              return windowIndex ?? (boxSupportsMultiWindow(remoteBox as any) ? undefined : 1);
            };
            const reviewedComputer = {
              mode: modes.computer,
              agentId: session.id,
              boxIdentity,
              ...(autoReviewController === undefined ? {} : { autoReviewController }),
              extractConversationContext: extractProductionTurnAutoReviewConversationContext,
              getApprovalExpiryPolicy: () => slateAutoReviewApprovalExpiryPolicy("turn"),
              resolveDisplayNumber,
              ...(userAutoRunInstructions === undefined ? {} : { userAutoRunInstructions }),
            };
            const unicodeTyping = () => looseMethod(experiments, "isUnicodeTypingEnabled")?.() ?? false;
            return {
              createComputerToolDependencies: () =>
                createHostComputerToolDependencies({
                  resourceAccessor: input.resourceAccessor,
                  autoReview: reviewedComputer,
                  isUnicodeTypingEnabled: unicodeTyping,
                  onComputerAction: (action) => {
                    deps.emitGatewayEvent({ channel: "computer-action", payload: { agentId: session.id, ...action } });
                  },
                  ...(persistImageForTurn === undefined ? {} : { persistImage: persistImageForTurn }),
                }),
              createScreenshotToolDependencies: () =>
                createHostComputerToolDependencies({
                  resourceAccessor: input.resourceAccessor,
                  isUnicodeTypingEnabled: unicodeTyping,
                  ...(persistImageForTurn === undefined ? {} : { persistImage: persistImageForTurn }),
                }),
              createBrowserDriverDependencies: () =>
                createHostBrowserDriverDependencies({
                  resourceAccessor: input.resourceAccessor,
                  box: remoteBox as unknown as HostBrowserBoxOwner<unknown>,
                  getBoxId: () => session.id,
                  getDefaultViewId: () => session.id,
                  executeShell: shell,
                  autoReview: reviewedComputer,
                  ...(persistImageForTurn === undefined ? {} : { getPersistImage: () => persistImageForTurn }),
                }),
              createBoxShellExecutor: () => shell,
            };
          };

    /** The web tools and the await tool: the services come from inference, the context from the request context. */
    const createTurnWebAndAwaitProjections = (input: RunnerToolInputs): TurnHostOverrides => {
      const inference = extensions.api("inference");
      const webSearchService = looseMethod(inference, "createWebSearch")?.({
        modelId: process.env.SLATE_AGENT_MODEL ?? DEFAULT_SLATE_MODEL,
        onRequestId: requestIdForwarder(hooks, "web-search"),
      });
      const webFetchService = looseMethod(inference, "createWebFetch")?.({ onRequestId: requestIdForwarder(hooks, "web-fetch") });
      const environment = webSearchService === undefined && webFetchService === undefined ? {} : resolveRequestContextEnvironment(requestContext);
      const conversationStartedDate =
        webSearchService === undefined ? undefined : looseMethod(input.stateHandler as DynamicApi, "getOrInitializeConversationStartedDate")?.(environment.timeZone);
      const osPlatform = environment.osVersion?.split(" ")[0];
      const terminalsFolder = looseMethod(remoteBox, "getTerminalsFolder");
      return {
        ...presentOptions({
          webSearch:
            webSearchService === undefined
              ? undefined
              : {
                  webSearchService,
                  promptVersion: "latest",
                  resourceAccessor: input.resourceAccessor,
                  ...presentOptions({
                    conversationStartedDate: typeof conversationStartedDate === "string" ? conversationStartedDate : undefined,
                    projectFolder: environment.projectFolder,
                    osPlatform,
                  }),
                },
          webFetch:
            webFetchService === undefined
              ? undefined
              : {
                  webFetchService,
                  promptVersion: "latest",
                  resourceAccessor: input.resourceAccessor,
                  ...presentOptions({ projectFolder: environment.projectFolder, osPlatform }),
                },
          externalAwait:
            terminalsFolder === undefined
              ? undefined
              : {
                  resourceAccessor: input.resourceAccessor,
                  options: {
                    toolName: SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
                    terminalsFolder: () => terminalsFolder() ?? "",
                    enableSubagentAwaiting: false,
                    defaultBlockUntilMs: 30_000,
                    enableJobCompletionNotifications: true,
                  },
                },
        }),
      };
    };

    localToolPermissionSurfaces.bind(session.id, scope.groupMemberTurn, hooks.transport);

    let builtRunner: Runner | undefined;
    let transcriptMirrorForTurn: TurnSettleHost["transcriptMirror"] | undefined;

    // A shared room has no filesystem context of its own: it neither reads nor writes the project's rules.
    const requestContext = scope.hasConversationContext
      ? deps.createRequestContext?.({
          transcriptsDir,
          getUserTimeZone: () => looseMethod(settings, "getUserTimeZone")?.(),
          resolveTeamRules: async () => await looseMethod(extensions.api("managed-setup"), "resolveTeamRules")?.(),
          getUserFullName: async () => await looseMethod(auth, "getUserFullName")?.(),
        })
      : { resolve: () => ({}), resolveRules: async () => [] };

    const resolveCloudAgentTitle = async (_context: unknown, bcId: string) => (await looseMethod(cloudAgents, "get")?.(bcId))?.name;
    const awaitCloudAgent = looseMethod(cloudAgents, "awaitCompletion");
    const sendToAgent = (toAgentId: string, text: string, images: unknown, priority: boolean) =>
      looseMethod(transcript, "sendToAgent")?.(session.id, toAgentId, text, images, priority);
    const agentManagement = {
      create: async (agentInput: { name: string; description: string }) => {
        const result = await looseMethod(transcript, "createBackgroundAgent")?.({ name: agentInput.name, description: agentInput.description }, "user");
        const agent = result.agent;
        return { id: agent.id, name: agent.name, description: agent.description };
      },
      update: async (id: string, patch: { name?: string; description?: string }) => {
        const current = (await looseMethod(transcript, "listAgents")?.())?.find((agent: any) => agent.id === id);
        if (current == null || current.isGroup) return null;
        const summary = await looseMethod(transcript, "updateAgent")?.(id, {
          name: patch.name ?? current.name,
          description: patch.description ?? current.description,
        });
        return summary == null ? null : { id: summary.id, name: summary.name, description: summary.description };
      },
    };
    const agentStateOwner = scope.hasConversationContext
      ? looseMethod(memory, "createAgentState")?.({
          memory: session.memory,
          automations: session.automations,
          workflows: session.workflows,
          channels: session.channels,
          agentDir: dirname(session.dbPath),
          agentId: session.id,
          readBoxFile: (boxPath: string) => looseMethod(remoteBox, "downloadFile")?.(ctx, session.id, boxPath),
        })
      : undefined;

    const productionContext = isAgentContext(ctx) ? ctx : undefined;
    const productionRequestContext = isPromptRequestContext(requestContext) ? requestContext : undefined;
    const readVideoAttachmentBytes = looseMethod(attachments, "readVideoBytes");
    const mcpCustomInstructions = looseMethod(mcp.mcp, "getCustomInstructions");
    let shellWatchWatermark: { readonly turnCount: number; readonly boundaryRef: Uint8Array; readonly lastUserMessageId?: string; readonly hasUserTurn: boolean } | undefined;

    const productionPromptGlue =
      productionContext === undefined || productionRequestContext === undefined
        ? undefined
        : (() => {
            const box = asTransferBox(localExec.box);
            const remoteBoxForPrompt = asCapableTransferBox(remoteBox);
            const userComputers = asPromptUserComputers(localExec.userComputers);
            if (box === undefined || remoteBoxForPrompt === undefined || userComputers === undefined) return undefined;
            const readVideoAttachment =
              readVideoAttachmentBytes === undefined
                ? undefined
                : async (path: string): Promise<Uint8Array | null> => {
                    const value = await readVideoAttachmentBytes(path);
                    return value instanceof Uint8Array ? value : null;
                  };
            const promptHost: PromptCollectorHost = {
              ctx: productionContext,
              box,
              remoteBox: remoteBoxForPrompt,
              remoteBoxHasDesktop: true,
              isSubagentRunner: false,
              isComputerUseSubagent: false,
              isBrowserUseSubagent: false,
              requestContext: productionRequestContext,
              isSpotlightEnabled: () => looseMethod(experiments, "isSpotlightEnabled")?.() ?? false,
              uploadAttachmentsIntoBox: async (paths) => new Map((await looseMethod(attachments, "stageIntoBox")?.(session.id, paths)) ?? []),
              getRemoteBoxAvailable: () => looseMethod(remoteBox, "isAvailable")?.() !== false,
              getConversationId: () => session.id,
              resolveBoxId: () => session.id,
              mcpConnectedServerNamesForTurn: () => [],
              mcpCustomInstructionsForTurn: () => new Map(),
              isMcpDiscoveryUnavailableForTurn: () => false,
              shellWatchHost: () => {
                const store = session.agentStore;
                if (store == null || typeof store.getConversationStateStructure !== "function" || typeof store.getBlobStore !== "function") {
                  throw new TypeError("the production prompt state store is not bound");
                }
                const blobStore = getAgentBlobStore(store as Parameters<typeof getAgentBlobStore>[0]);
                const shellHost: ShellTerminalWatchHost<Context> = {
                  ctx: productionContext,
                  ...createShellWatchGeneratedStateProjection({
                    getConversationState: () => runnerConversationStateFromStoreCheckpoint(store.getConversationStateStructure()),
                    getBlobStore: () => blobStore,
                  }),
                  getConversationId: () => session.id,
                  async ensureBoxReady(pollContext, agentId) {
                    const connection = await remoteBox.ensureReady(pollContext, agentId);
                    return { terminalsFolder: looseMethod(remoteBox, "getTerminalsFolder")?.() ?? "", remoteAccessor: createShellWatchReadAccessor(connection.remoteAccessor) };
                  },
                  getConfirmedUserTurnWatermarkCache: () => shellWatchWatermark,
                  setConfirmedUserTurnWatermarkCache: (cache) => {
                    shellWatchWatermark = cache;
                  },
                };
                return shellHost;
              },
              ...presentOptions({
                agentProfileProvider:
                  typeof hooks.agentProfileProvider === "function"
                    ? () => hooks.agentProfileProvider?.() ?? { name: "", description: "" }
                    : undefined,
                readVideoAttachmentBytes: readVideoAttachment,
                mcp: mcpCustomInstructions === undefined ? undefined : { getCustomInstructions: async (_context: Context) => await mcpCustomInstructions() },
              }),
            };
            return createPromptCollectorGlue(promptHost);
          })();

    const productionSystemPromptAssembly =
      productionContext === undefined || productionRequestContext === undefined
        ? undefined
        : createSystemPromptAssembly({
            basePrompt: typeof overrides.systemPrompt === "string" ? overrides.systemPrompt : DEFAULT_SLATE_SYSTEM_PROMPT,
            isSubagentRunner: false,
            isSharedRoomRunner: isSharedRoomTurn,
            isSystemPromptOverridden: typeof overrides.systemPrompt === "string",
            agentProfileProvider: () => hooks.agentProfileProvider?.() ?? null,
            agentStore: () => {
              const store = session.agentStore;
              return store != null && typeof store.getMetadata === "function" ? { getMetadata: (key: string) => String(store.getMetadata(key)) } : null;
            },
            compactionEpoch: () => 0,
            memoryStore: () => null,
            memorySnapshots: () => null,
            userMemory: () => null,
            projectMemory: () => null,
            isBoxScopedSubagent: () => false,
            requestContext: {
              resolve: () => {
                const resolved = productionRequestContext.resolve();
                return { timeZone: resolved.timeZone ?? "UTC", ...presentOptions({ userFullName: resolved.userFullName }) };
              },
            },
            automationStore: () => null,
            workflowStore: () => null,
            channelStore: () => null,
            connectorManifests: CONNECTOR_MANIFESTS,
            sendToAgentImpl: sendToAgent,
            agentManagement,
            agentDirectory: () => [],
            agentGroups: () => [],
            agentsRootDir: () => dirname(dirname(session.dbPath)),
            isSpotlightEnabled: () => looseMethod(experiments, "isSpotlightEnabled")?.() ?? false,
            isMultitaskEnabled: () => looseMethod(experiments, "isMultitaskEnabled")?.() ?? false,
            mcpManagement: () => mcp.management,
            isMcpMultiAccountEnabled: () => looseMethod(experiments, "isMcpMultiAccountEnabled")?.() ?? false,
            isCloudAgentsDisabledByTeam: () => looseMethod(experiments, "isCloudAgentsDisabledByTeam")?.() ?? false,
            mcpCustomInstructionsSection: () => productionPromptGlue?.getMcpCustomInstructionsSection() ?? null,
            mcpDiscoveryStatusSection: () => productionPromptGlue?.getMcpDiscoveryStatusSection() ?? null,
            remoteBoxSection: () => productionPromptGlue?.getRemoteBoxSection() ?? "",
            computerSection: () => productionPromptGlue?.getComputerSection() ?? null,
          });

    const runnerOptions: Record<string, unknown> = {
      inference: extensions.api("inference").port,
      diskPressureReminder: foreverBox.diskPressureReminder,
      box: localExec.box,
      ctx,
      remoteBox,
      userComputers: localExec.userComputers,
      remoteBoxHasDesktop: true,
      boxHandoff: { requestHelp: (request: unknown) => looseMethod(extensions.api("session"), "startHandoff")?.(request) },
      transport: hooks.transport,
      onRunLifecycle: hooks.onRunLifecycle,
      isSharedRoomTurn,
      isSharedRoomBoxToolsEnabled: () =>
        !Boolean(looseMethod(experiments, "checkFeatureGate")?.("slate_shared_room_box_tools_kill_switch")) &&
        sharedRoomBoxToolsAreEnabled(process.env.SLATE_SHARED_ROOM_BOX_TOOLS),
      getAgentId: () => session.id,
      agentProfileProvider: hooks.agentProfileProvider,
      connectorManifests: CONNECTOR_MANIFESTS,
      ingestAttachment: hooks.ingestAttachment,
      persistImage: hooks.persistImage,
      persistMediaBytes: hooks.persistMediaBytes,
      readVideoAttachmentBytes: looseMethod(attachments, "readVideoBytes"),
      readMediaDimensions: looseMethod(attachments, "readMediaDimensions"),
      requestContext,
      localToolPermission,
      ...autoReview,
      actionAuditor,
      webSearchService: looseMethod(extensions.api("inference"), "createWebSearch")?.({
        modelId: process.env.SLATE_AGENT_MODEL ?? DEFAULT_SLATE_MODEL,
        onRequestId: requestIdForwarder(hooks, "web-search"),
      }),
      webFetchService: looseMethod(extensions.api("inference"), "createWebFetch")?.({ onRequestId: requestIdForwarder(hooks, "web-fetch") }),
      onComputerAction: ({ agentId, action }: any) => {
        deps.emitGatewayEvent({ channel: "computer-action", payload: { agentId, ...action } });
      },
      systemPrompt: overrides.systemPrompt,
      isMultitaskEnabled: () => looseMethod(experiments, "isMultitaskEnabled")?.() ?? false,
      isSendMessageDeliveryOwedEnabled: () => looseMethod(experiments, "isSendMessageDeliveryOwedEnabled")?.() ?? false,
      isDynamicToolsEnabled: () => looseMethod(experiments, "isDynamicToolsEnabled")?.() ?? false,
      isBrowserUseSubagentEnabled: () => looseMethod(experiments, "isBrowserUseSubagentEnabled")?.() ?? false,
      isSpotlightEnabled: () => looseMethod(experiments, "isSpotlightEnabled")?.() ?? false,
      isMcpMultiAccountEnabled: () => looseMethod(experiments, "isMcpMultiAccountEnabled")?.() ?? false,
      isUnicodeTypingEnabled: () => looseMethod(experiments, "isUnicodeTypingEnabled")?.() ?? false,
      platformIsConnected: (platform: string) => looseMethod(extensions.api("automations"), "platformIsConnected")?.(platform) ?? false,
      resolveCloudAgentTitle,
      sendToAgent,
      agentDirectory: () => {
        const roster = looseMethod(transcript, "listAgentsSync")?.() ?? [];
        return roster
          .filter((agent: any) => agent.id !== session.id && !agent.isGroup && agent.remoteRoom == null)
          .map((agent: any) => ({ id: agent.id, name: agent.name, description: agent.description }));
      },
      agentGroups: () => {
        const roster = looseMethod(transcript, "listAgentsSync")?.() ?? [];
        const byId = new Map(roster.map((agent: any) => [agent.id, agent]));
        return roster
          .filter((agent: any) => agent.isGroup && agent.memberIds.includes(session.id))
          .map((group: any) => ({
            id: group.id,
            name: group.name,
            members: group.memberIds
              .filter((memberId: string) => memberId !== session.id)
              .map((memberId: string) => byId.get(memberId))
              .filter((member: any) => member != null)
              .map((member: any) => ({ id: member.id, name: member.name, description: member.description })),
          }));
      },
      agentManagement,
      agentsRootDir: () => dirname(dirname(session.dbPath)),
      ...(awaitCloudAgent === undefined
        ? {}
        : {
            cloudAgentWatcher: {
              awaitCompletion: (id: string, options: { readonly waitForRestart: boolean }) => awaitCloudAgent(id, options),
            },
          }),
    };

    runnerOptions.createPromptSession = (onRequestId: (requestId: string) => void, promptOptions?: Readonly<Record<string, unknown>>) =>
      createAgentPromptSession(extensions.api("inference").port, onRequestId, promptOptions);

    const baseProductionResourceAccessor = createPerTurnResourceAccessor(remoteBox as unknown as ProductionBoxResourceOwner, session.id);
    /**
     * The box's own resources for this turn: when the box can hand over a registry, the remote accessor is used (it knows
     * about terminal folders, computer windows and shell auditing); otherwise the plain per-turn accessor is.
     */
    const productionResourceAccessor = async (context: unknown): Promise<ProductionResourceAccessor> => {
      const owner = asRemoteBoxResourceOwner(remoteBox);
      const runner = builtRunner as
        | {
            readonly computerUse?: RemoteBoxResourceHost["computerUse"];
            setRemoteBoxTerminalsFolder?(folder: string): void;
            probeNavigationAfterComputerUse?(context: Context, connection: { readonly remoteAccessor: unknown }): void;
            auditShellCommand?(shellKind: string, command: string, target: "box" | "user_machine", attribution?: { readonly turnId?: string; readonly boxId?: string }): void;
          }
        | undefined;
      if (
        owner === undefined ||
        autoReviewGate === undefined ||
        runner?.computerUse === undefined ||
        typeof runner.setRemoteBoxTerminalsFolder !== "function" ||
        typeof runner.probeNavigationAfterComputerUse !== "function" ||
        typeof runner.auditShellCommand !== "function" ||
        !isAgentContext(context)
      ) {
        return await baseProductionResourceAccessor(context);
      }
      const accessor = createRemoteBoxResourceAccessor({
        executeWindowCommand: executeBoxWindowShellCommand,
        remoteBox: owner,
        remoteBoxHasDesktop: true,
        resolveBoxId: () => session.id,
        getConversationId: () => session.id,
        setRemoteBoxTerminalsFolder: (folder) => runner.setRemoteBoxTerminalsFolder?.(folder),
        autoReviewGate: {
          assertNoPendingApproval: () => autoReviewGate.assertNoPendingApproval(),
          currentModes: () => ({ ...autoReviewGate.currentModes() }),
        },
        auditShellCommand: (_agentId, kind, command, _target, attribution) => runner.auditShellCommand?.(kind, command, "box", attribution),
        computerUse: runner.computerUse,
        probeNavigationAfterComputerUse: (probeContext, connection) => runner.probeNavigationAfterComputerUse?.(probeContext, connection),
        ...presentOptions({ autoReviewClassifierExecutor: autoReview.autoReviewClassifierExecutor }),
      });
      return asProductionResourceAccessor(accessor);
    };
    const localProductionResourceAccessor = createPerTurnResourceAccessor(localExec.box as ProductionBoxResourceOwner, session.id);
    runnerOptions.createResourceAccessor = productionResourceAccessor;
    runnerOptions.createSummarizationHandler = (summarizationSession: SummarizationPromptSession, summarizationOptions?: { preserveLatestImage?: boolean }) =>
      new SummarizationHandler(summarizationSession, false, {
        enableReduceInputsRetry: true,
        maxPromptChars: SLATE_SUMMARIZATION_MAX_PROMPT_CHARS,
        maxOutputTokens: 32_000,
        preserveLatestImage: summarizationOptions?.preserveLatestImage ?? false,
      });
    runnerOptions.createConversationActionReceiver = () => new NoopConversationActionReceiver();
    // The retry/checkpoint boundary and the redaction projection are handed to the runner as values it may use, instead of
    // the runner importing them: that is what keeps the stream handoff one-way.
    runnerOptions.createStreamAttempt = createStreamAttempt;
    runnerOptions.createTurnAgentRunStreamInput = createTurnAgentRunStreamInput;
    runnerOptions.createTurnAgentStreamStart = createTurnAgentStreamStart;
    runnerOptions.createProductionTurnAgentOwner = (ownerInput: Omit<ProductionTurnAgentOwnerInput, "createResourceAccessor" | "blobStore">) => {
      if (session.agentStore == null || typeof session.agentStore.getBlobStore !== "function") throw new TypeError("the production Agent blob store is not bound");
      return createProductionTurnAgentOwner({
        ...ownerInput,
        createResourceAccessor: localProductionResourceAccessor,
        createRemoteBoxResourceAccessor: productionResourceAccessor,
        blobStore: getAgentBlobStore(session.agentStore as Parameters<typeof getAgentBlobStore>[0]),
      });
    };
    runnerOptions.createProductionTurnAgentRunInput = createProductionTurnAgentRunInput;
    if (session.agentStore != null && typeof session.agentStore.getBlobStore === "function") {
      runnerOptions.blobStore = getAgentBlobStore(session.agentStore as Parameters<typeof getAgentBlobStore>[0]);
    }

    // A shared room keeps no private mirror, memory, image persistence or local permission surface: those belong to the
    // conversation the agent is bound to, not to a room a group is talking in.
    if (scope.hasConversationContext) {
      transcriptMirrorForTurn = deps.createTranscriptMirror?.({
        transcriptsDir,
        session,
        pool: getMirrorOffloadPool,
        reportOutcome: (report) => {
          looseMethod(telemetry.brain ?? {}, "reportJournalOutcome")?.(report);
        },
        isJournalEnabled: async () => (await looseMethod(experiments, "checkGate")?.("slate_new_transcript_journal")) ?? false,
      }) as TurnSettleHost["transcriptMirror"] | undefined;
      Object.assign(runnerOptions, {
        transcriptMirror: transcriptMirrorForTurn,
        mcp: mcp.mcp,
        mcpManagement: mcp.management,
        agentState: agentStateOwner,
        generateImageService: looseMethod(attachments, "createGenerateImageService")?.({
          persistImage: hooks.persistImage,
          onRequestId: requestIdForwarder(hooks, "generate-image"),
        }),
        generateImageResourceAccessor: looseMethod(attachments, "createAgentImageResourcePort")?.(dirname(session.dbPath)),
        getAgentDir: () => dirname(session.dbPath),
        uploadAttachmentsIntoBox: (hostPaths: readonly string[]) => looseMethod(attachments, "stageIntoBox")?.(session.id, hostPaths),
        agentStore: session.agentStore,
        conversationSizeGuard: () => sessionApi.store?.ensureConversationCapacityForTurn?.(session),
        memoryStore: session.memory,
        userMemory: looseMethod(memory, "createUserMemory")?.({ agentId: session.id, resolveAgentName: resolveAgentDisplayName }),
        projectMemory: looseMethod(memory, "createProjectMemory")?.({ agentDir: dirname(session.dbPath), agentId: session.id, resolveAgentName: resolveAgentDisplayName }),
        memorySnapshots: session.db,
        profilePromptSnapshots: session.db,
        episodeProgress: session.db,
        automationStore: session.automations,
        workflowStore: session.workflows,
        channelStore: session.channels,
      });
    }

    const projectedLocalToolPermission = asLocalToolPermissionProjection(localToolPermission);

    /** The host-owned inputs the runner's tools need for this turn: sends, reactions, state, cloud agents, review. */
    const hostDependencies = (): TurnHostServices => {
      const readMediaDimensions = looseMethod(attachments, "readMediaDimensions");
      const uploadFile = looseMethod(remoteBox, "uploadFile");
      const downloadFile = looseMethod(remoteBox, "downloadFile");
      const watchCloudAgent = createRunnerCloudWatch(builtRunner);
      const listenerPlatformConnected = looseMethod(extensions.api("automations"), "platformIsConnected");

      const cloudAgent = (() => {
        const launchedIds = cloudAgents.launchedIds;
        if (!isCloudAgentApi(cloudAgents) || !(launchedIds instanceof Set) || uploadFile === undefined) return undefined;
        const reviewAction: NonNullable<CloudAgentToolDeps["reviewAction"]> | undefined =
          productionContext === undefined || autoReviewGate === undefined
            ? undefined
            : async ({ args, toolCallId, images, signal }) => {
                const instructions = autoReviewGate.userInstructions();
                const reviewOptions = {
                  mode: autoReviewGate.currentModes().cloudAgent,
                  agentId: session.id,
                  getApprovalExpiryPolicy: () => slateAutoReviewApprovalExpiryPolicy("turn"),
                  ...presentOptions({
                    autoReviewController,
                    userAutoRunInstructions: instructions,
                  }),
                };
                const lifecycleTarget = buildSlateCloudAgentLifecycleReviewTarget({
                  action: args.action,
                  ...presentOptions({ agent_id: args.agent_id, title: args.title }),
                });
                if (lifecycleTarget !== undefined) {
                  const result = await reviewSlateCloudAgentLifecycleAction({
                    ctx: productionContext,
                    target: lifecycleTarget,
                    options: reviewOptions,
                    ...presentOptions({ signal }),
                  });
                  return { allowed: result.allowed, reason: result.reason ?? "" };
                }
                const target = buildSlateCloudAgentReviewTarget(args, describeSlateCloudAgentReviewImages(images.map((image) => image.path), images));
                if (target === undefined) return { allowed: true, reason: "" };
                const result = await reviewSlateCloudAgentAction({
                  ctx: productionContext,
                  target,
                  toolCallId,
                  options: {
                    ...reviewOptions,
                    classify: async (classifyContext, classifyTarget, mode, id) =>
                      await runSlateAutoReviewClassifier({
                        ctx: classifyContext,
                        resourceAccessor: await productionResourceAccessor(classifyContext),
                        toolCallId: id,
                        mode,
                        buildTarget: () =>
                          buildSlateCloudAgentRiskTarget({
                            target: classifyTarget,
                            ...presentOptions({ userAutoRunInstructions: instructions }),
                          }),
                        loadConversationContext: async () => await extractProductionTurnAutoReviewConversationContext(classifyContext, agentStateOwner),
                        errorReason: SLATE_CLOUD_AGENT_CLASSIFIER_ERROR_REASON,
                      }),
                  },
                  ...presentOptions({ signal }),
                });
                return { allowed: result.allowed, reason: result.reason ?? "" };
              };
        return {
          api: cloudAgents,
          launchedIds,
          agentDir: dirname(session.dbPath),
          writeBoxFile: async (cloudContext: CloudAgentToolContext, boxPath: string, data: Uint8Array) => await uploadFile(cloudContext, session.id, boxPath, data),
          ...presentOptions({
            readBoxFile:
              downloadFile === undefined
                ? undefined
                : async (cloudContext: CloudAgentToolContext, boxPath: string) => await downloadFile(cloudContext, session.id, boxPath),
            cloudAgentWatcher:
              awaitCloudAgent === undefined
                ? undefined
                : () => ({ awaitCompletion: (id: string, options: { waitForRestart: boolean }) => awaitCloudAgent(id, options) }),
            watch: watchCloudAgent,
            reviewAction,
          }),
        };
      })();

      const sendMessage = {
        getIngestAttachment: () => hooks.ingestAttachment,
        resolveCloudAgentTitle,
        onSendMessage: (message: Record<string, unknown>, timestampMs: number) => {
          hooks.transport.onUpdate({ type: "send-message", message: { ...message, type: String(message.type ?? "text") }, timestampMs });
          return hooks.transport.lastSentMessageId?.();
        },
        ...presentOptions({ readMediaDimensions }),
      };
      const reaction = {
        react: (args: { messageAddress: string; emoji: string }) => {
          hooks.transport.onUpdate({ type: "react-to-message", ...args });
        },
      };
      type StateInputs = NonNullable<TurnHostServices["state"]>;
      const reviewAutomationWrite: StateInputs["reviewAutomationWrite"] =
        productionContext === undefined || autoReviewGate === undefined
          ? undefined
          : async (review: AutomationReview, toolCallId?: string) => {
              if (toolCallId === undefined || toolCallId.length === 0) return { allowed: false, reason: "Auto-review requires a tool call identity." };
              const trigger = parseStoredTrigger(review.spec.trigger);
              if (trigger === null) return { allowed: false, reason: "This routine trigger could not be reviewed." };
              const instructions = autoReviewGate.userInstructions();
              const result = await reviewSlateAutomationWrite({
                ctx: productionContext,
                target: {
                  operation: review.operation,
                  id: review.id ?? review.referencedWorkflows[0]?.id ?? "",
                  spec: { name: review.spec.name, prompt: review.spec.prompt, trigger, isEnabled: review.spec.isEnabled ?? true },
                  referencedWorkflows: review.referencedWorkflows,
                  ...presentOptions({ referencingRoutines: review.referencingRoutines }),
                },
                toolCallId,
                options: {
                  mode: autoReviewGate.currentModes().automationWrite,
                  agentId: session.id,
                  getApprovalExpiryPolicy: () => slateAutoReviewApprovalExpiryPolicy("turn"),
                  ...presentOptions({ autoReviewController, userAutoRunInstructions: instructions }),
                  classify: async (classifyContext, classifyTarget, mode, id) =>
                    await runSlateAutoReviewClassifier({
                      ctx: classifyContext,
                      resourceAccessor: await productionResourceAccessor(classifyContext),
                      toolCallId: id,
                      mode,
                      buildTarget: () =>
                        buildSlateAutomationWriteRiskTarget({
                          target: classifyTarget,
                          ...presentOptions({ userAutoRunInstructions: instructions }),
                        }),
                      loadConversationContext: async () => await extractProductionTurnAutoReviewConversationContext(classifyContext, agentStateOwner),
                      errorReason: SLATE_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON,
                    }),
                },
              });
              return { allowed: result.allowed, reason: result.reason ?? "" };
            };
      const onListenerRoutineSaved: StateInputs["onListenerRoutineSaved"] =
        listenerPlatformConnected === undefined
          ? undefined
          : async (triggerValue) => {
              const trigger = parseStoredTrigger(triggerValue);
              if (trigger === null) return undefined;
              return (
                (await connectCardsFor({
                  trigger,
                  platformsOf: (value) => {
                    const parsed = parseStoredTrigger(value);
                    return parsed === null ? [] : listenerPlatformsInTrigger(parsed);
                  },
                  platformIsConnected: async (platform) => Boolean(await listenerPlatformConnected(platform)),
                  emit: (card) => {
                    hooks.transport.onUpdate({ type: "send-message", message: card, timestampMs: Date.now() });
                  },
                  spokenName: (platform) => (platform === "slack" ? "Slack" : "GitHub"),
                })) ?? undefined
              );
            };
      const state: TurnHostServices["state"] =
        agentStateOwner === undefined
          ? undefined
          : {
              state: agentStateOwner as StateInputs["state"],
              parseTrigger: parseStoredTrigger,
              ...(session.automations != null && typeof (session.automations as { list?: unknown }).list === "function"
                ? { automationStore: session.automations as { list(): readonly AutomationRecord[] } }
                : {}),
              ...(session.workflows != null && typeof (session.workflows as { list?: unknown }).list === "function"
                ? { workflowStore: session.workflows as { list(): readonly WorkflowRecord[] } }
                : {}),
              ...presentOptions({ reviewAutomationWrite, onListenerRoutineSaved }),
            };

      const subagentManagement = createRunnerSubagentManagement(builtRunner);
      const projectedActionAuditor = asActionAuditor(actionAuditor);
      const autoReviewProjection: TurnAutoReviewBinding | undefined =
        autoReviewController === undefined || autoReviewGate === undefined
          ? undefined
          : {
              controller: autoReviewController,
              agentId: session.id,
              getModes: () => autoReviewGate.currentModes(),
              getInstructions: () => autoReviewGate.userInstructions(),
              getApprovalExpiryPolicy: () => slateAutoReviewApprovalExpiryPolicy("turn"),
              smartModeClassifierControls: { automaticModeEnabled: true },
              getShellApprovalState: (surface) => autoReviewGate.shellApprovalState(surface),
              enforceModelFacingShellUiAutomationGuard: autoReviewGate.currentModes().hostShell === "enforce" || autoReviewGate.currentModes().computer === "enforce",
              ...presentOptions({
                actionAuditor: projectedActionAuditor,
                localToolPermission: projectedLocalToolPermission,
                platformIsConnected:
                  listenerPlatformConnected === undefined ? undefined : async (platform: string) => Boolean(await listenerPlatformConnected(platform)),
              }),
            };

      return {
        isMultitaskEnabled: () => looseMethod(experiments, "isMultitaskEnabled")?.() ?? false,
        sendMessage,
        sendToAgent: {
          getSelfAgentId: () => session.id,
          sendToAgent: (targetId: string, text: string, images: unknown, priority: unknown) => sendToAgent(targetId, text, images, priority === true),
        },
        reaction,
        agentManagement,
        ...presentOptions({
          state,
          mcpManagement: scope.hasConversationContext && mcp.management != null && typeof mcp.management.listPlugins === "function" ? mcp.management : undefined,
          cloudAgent,
          subagentManagement,
          autoReview: autoReviewProjection,
        }),
      };
    };

    /** The per-turn factory inputs the tools are built from: the host's identities plus this turn's emitter. */
    type MutableFactoryProvider = { -readonly [K in keyof TurnToolsetHostFactoryProvider]: TurnToolsetHostFactoryProvider[K] };
    const createTurnToolsetFactoryProvider = (dependencies: TurnHostServices, turnInputs?: RunnerToolInputs): TurnToolsetHostFactoryProvider => {
      const cloudAgent = dependencies.cloudAgent;
      const mcpManagement = dependencies.mcpManagement;
      const inference = extensions.api("inference");
      const provider: MutableFactoryProvider = {
        createSendMessageToolInputs: (turn) => ({
          dependencies:
            turn.emitUpdate === undefined
              ? dependencies.sendMessage
              : {
                  ...dependencies.sendMessage,
                  onSendMessage: (message, timestampMs) => {
                    turn.emitUpdate?.({
                      type: "send-message",
                      message: { ...message, type: String(message.type ?? "text") },
                      timestampMs,
                      ...presentOptions({ ackToken: turn.ackToken }),
                    });
                    return hooks.transport.lastSentMessageId?.();
                  },
                },
        }),
        createSendToAgentToolInputs: () => ({ dependencies: dependencies.sendToAgent }),
        createReactionToolInputs: (turn) => ({
          dependencies:
            turn.emitUpdate === undefined ? dependencies.reaction : { ...dependencies.reaction, react: (args) => turn.emitUpdate?.({ type: "react-to-message", ...args }) },
        }),
        createAgentManagementToolInputs: () => ({ dependencies: dependencies.agentManagement }),
        createBoxAwaitToolInputs: (turn): TurnAwaitToolFactoryInput => {
          if (turn.remoteBoxResourceAccessor === undefined) throw new TypeError("the remote box resource accessor is not bound");
          return {
            resourceAccessor: turn.remoteBoxResourceAccessor as unknown as TurnAwaitToolFactoryInput["resourceAccessor"],
            options: {
              toolName: SLATE_BOX_AWAIT_SHELL_TOOL_NAME,
              toolIdentifier: "BOX_AWAIT",
              terminalsFolder: () => looseMethod(remoteBox, "getTerminalsFolder")?.() ?? "",
              enableSubagentAwaiting: false,
              defaultBlockUntilMs: 30_000,
              enableJobCompletionNotifications: true,
            },
          };
        },
        createExternalReadToolInputs: (_turn, props): TurnReadToolFactoryInput => ({
          resourceAccessor: props.resourceAccessor as unknown as TurnReadToolFactoryInput["resourceAccessor"],
          formattingOptions: SLATE_READ_FORMATTING_OPTIONS,
          promptVersion: "latest",
          // The PDF extractor is not part of this build: leaving it out keeps an ordinary Read working and makes the PDF
          // branch fail closed in the tool itself, rather than pretending it can extract.
          options: {
            toolName: SLATE_EXTERNAL_READ_TOOL_NAME,
            toolIdentifier: "EXTERNAL_READ",
            toolDescription: SLATE_EXTERNAL_READ_TOOL_DESCRIPTION,
          },
        }),
        createBoxReadToolInputs: (turn): TurnReadToolFactoryInput => {
          if (turn.remoteBoxResourceAccessor === undefined) throw new TypeError("the remote box resource accessor is not bound");
          return {
            resourceAccessor: turn.remoteBoxResourceAccessor as unknown as TurnReadToolFactoryInput["resourceAccessor"],
            formattingOptions: SLATE_READ_FORMATTING_OPTIONS,
            promptVersion: "latest",
            options: { toolName: SLATE_BOX_READ_TOOL_NAME, toolIdentifier: "READ", toolDescription: SLATE_BOX_READ_TOOL_DESCRIPTION },
          };
        },
      };

      // Each optional factory is added only when this turn can really build it: the web tools need an inference service,
      // the await tool needs a box with a terminals folder, and the cloud-agent tool is not offered in a shared room.
      if (turnInputs?.webSearch !== undefined || looseMethod(inference, "createWebSearch") !== undefined) {
        provider.createWebSearchToolInputs = (_turn, props): TurnWebSearchToolFactoryInput => {
          const webSearch = props.webSearch ?? turnInputs?.webSearch ?? createTurnWebAndAwaitProjections(props).webSearch;
          if (webSearch === undefined) throw new TypeError("the web search service is not bound");
          return { dependencies: webSearch as unknown as TurnWebSearchToolFactoryInput["dependencies"] };
        };
      }
      if (turnInputs?.webFetch !== undefined || looseMethod(inference, "createWebFetch") !== undefined) {
        provider.createWebFetchToolInputs = (_turn, props): TurnWebFetchToolFactoryInput => {
          const webFetch = props.webFetch ?? turnInputs?.webFetch ?? createTurnWebAndAwaitProjections(props).webFetch;
          if (webFetch === undefined) throw new TypeError("the web fetch service is not bound");
          return { dependencies: webFetch as unknown as TurnWebFetchToolFactoryInput["dependencies"] };
        };
      }
      if (turnInputs?.externalAwait !== undefined || looseMethod(remoteBox, "getTerminalsFolder") !== undefined) {
        provider.createExternalAwaitToolInputs = (_turn, props): TurnAwaitToolFactoryInput => {
          const externalAwait = props.externalAwait ?? turnInputs?.externalAwait ?? createTurnWebAndAwaitProjections(props).externalAwait;
          if (externalAwait === undefined) throw new TypeError("the external await service is not bound");
          return {
            resourceAccessor: externalAwait.resourceAccessor as unknown as TurnAwaitToolFactoryInput["resourceAccessor"],
            options: externalAwait.options,
            ...presentOptions({ promptVersion: externalAwait.promptVersion }),
          };
        };
      }
      if (mcpManagement !== undefined) {
        provider.createMcpManagementToolInputs = (): TurnMcpManagementToolFactoryInput => ({
          management: mcpManagement,
          getRequestingAgentId: () => session.id,
          isAwaitingUserSelection: () => (builtRunner as { isRunAwaitingUserSelection?: () => boolean } | undefined)?.isRunAwaitingUserSelection?.() === true,
          isMultiAccountEnabled: () => looseMethod(experiments, "isMcpMultiAccountEnabled")?.() ?? false,
          emitConnectorCard: (emission) => {
            hooks.transport.onUpdate({ type: "send-message", message: connectorMessageFromEmission(emission), timestampMs: Date.now() });
          },
        });
      }
      if (scope.hasConversationContext && cloudAgent !== undefined) {
        provider.createCloudAgentToolInputs = (): TurnCloudAgentToolFactoryInput => ({
          dependencies: {
            api: cloudAgent.api,
            launchedIds: cloudAgent.launchedIds,
            agentDir: cloudAgent.agentDir,
            writeBoxFile: cloudAgent.writeBoxFile,
            ...presentOptions({ readBoxFile: cloudAgent.readBoxFile, watch: cloudAgent.watch, reviewAction: cloudAgent.reviewAction }),
          },
        });
      }
      const state = dependencies.state;
      if (state !== undefined) provider.createStateToolInputs = () => ({ dependencies: state });
      return provider as TurnToolsetHostFactoryProvider;
    };

    /** The turn's tool inputs: what the runner assembled, the host's projections over it, and the host's dependencies. */
    const createTurnToolInputs = (input: RunnerToolInputs) => {
      const dependencies = hostDependencies();
      const projected = createRunnerToolInputs(input, {
        ...(createTurnToolProjections?.(input) ?? {}),
        ...createTurnWebAndAwaitProjections(input),
        ...presentOptions({ emitUpdate: hooks.emitUpdate }),
      });
      return {
        ...projected,
        hostDependencies: dependencies,
        turnToolsetFactoryProvider: createTurnToolsetFactoryProvider(dependencies, projected),
      };
    };

    /** Where a completed turn's checkpoints and final state are kept: the Agent store, with this turn's generation. */
    const createProductionTurnSettleHost = (): TurnSettleHost => createProductionTurnSettleHostAdapter({
      transcriptId: session.id,
      isSharedRoomTurn,
      runner: builtRunner as ProductionTurnSettleRunner | undefined,
      agentStore: session.agentStore,
      ...presentOptions({ transcriptMirror: transcriptMirrorForTurn }),
      persistAnnouncedAgentProfile: (snapshots, snapshot, identity) => {
        productionSystemPromptAssembly?.persistAnnouncedAgentProfile(asPromptSnapshotStore(snapshots), snapshot, identity)
      },
    })

    runnerOptions.createProductionTurnToolsetHost = (input: Omit<TurnToolsetHostBinding, "factoryProvider">) =>
      createProductionTurnToolsetHost({
        ...input,
        factoryProvider: createTurnToolsetFactoryProvider(hostDependencies()),
        ...presentOptions({ localToolPermission: projectedLocalToolPermission }),
      });

    if (productionContext !== undefined && productionPromptGlue !== undefined) {
      const turnRequestContext = productionRequestContext;
      const turnAutoReviewGate = autoReviewGate;
      if (turnRequestContext === undefined || turnAutoReviewGate === undefined) throw new TypeError("the production turn context owners are not bound");
      const autoReviewModes = autoReview.autoReviewModes ?? {
        hostShell: "off",
        boxShell: "off",
        mcp: "off",
        computer: "off",
        automationWrite: "off",
        cloudAgent: "off",
        subagentLaunch: "off",
      };
      const baseTurn: TurnToolsetTurnInput = { autoReviewModes, subagentConfigs: [] };
      const staticModelId = process.env.SLATE_AGENT_MODEL ?? DEFAULT_SLATE_MODEL;
      const lazyToolHost = () =>
        createProductionTurnToolsetHost({
          turn: baseTurn,
          factoryProvider: createTurnToolsetFactoryProvider(hostDependencies()),
          isSubagentRunner: false,
          isSharedRoomRunner: isSharedRoomTurn,
          isBoxScopedSubagent: false,
          isComputerUseSubagent: false,
          isBrowserUseSubagent: false,
          isSystemPromptOverridden: typeof overrides.systemPrompt === "string",
          remoteBoxHasDesktop: true,
          getConversationId: () => session.id,
          getRemoteBoxAvailable: () => looseMethod(remoteBox, "isAvailable")?.() !== false,
          cloudAgentsDisabledByTeam: () => looseMethod(experiments, "isCloudAgentsDisabledByTeam")?.() ?? false,
          spotlightEnabled: () => looseMethod(experiments, "isSpotlightEnabled")?.() ?? false,
          isDynamicToolsEnabled: () => looseMethod(experiments, "isDynamicToolsEnabled")?.() ?? false,
          isMultitaskEnabled: () => looseMethod(experiments, "isMultitaskEnabled")?.() ?? false,
          isSharedRoomBoxToolsEnabled: () => sharedRoomBoxToolsAreEnabled(process.env.SLATE_SHARED_ROOM_BOX_TOOLS),
          ...presentOptions({ localToolPermission: projectedLocalToolPermission }),
        });
      const getProductionConversationState = (): ReturnType<typeof runnerConversationStateFromStoreCheckpoint> => {
        const runner = builtRunner as { getAgentConversationStateStructure?: () => unknown } | undefined;
        if (typeof runner?.getAgentConversationStateStructure === "function") return runnerConversationStateFromStoreCheckpoint(runner.getAgentConversationStateStructure());
        const store = session.agentStore;
        if (store != null && typeof store.getConversationStateStructure === "function") return runnerConversationStateFromStoreCheckpoint(store.getConversationStateStructure());
        throw new TypeError("the production Agent conversation state is not bound");
      };
      /** One shell review identity per surface: the approval, the instructions and the expiry are the turn's own. */
      const shellReviewFor = (mode: TurnShellAutoReviewInput["mode"], surface: TurnShellAutoReviewInput["surface"], approvalSurface: "host_shell" | "box_shell"): TurnShellAutoReviewInput | undefined => {
        if (mode === "off") return undefined;
        const liveModes = turnAutoReviewGate.currentModes();
        const instructions = turnAutoReviewGate.userInstructions();
        return {
          mode,
          agentId: session.id,
          surface,
          smartModeClassifierControls: { automaticModeEnabled: true },
          getApprovalExpiryPolicy: () => slateAutoReviewApprovalExpiryPolicy("turn"),
          smartModeShellApprovalState: turnAutoReviewGate.shellApprovalState(approvalSurface),
          enforceModelFacingShellUiAutomationGuard: liveModes.hostShell === "enforce" || liveModes.computer === "enforce",
          ...presentOptions({
            controller: autoReviewController,
            userAutoRunInstructions:
              instructions === undefined
                ? undefined
                : { allowInstructions: instructions.allowInstructions, blockInstructions: instructions.blockInstructions },
          }),
        };
      };
      runnerOptions.productionTurnRunShell = createProductionTurnRunShellHostInput({
        createAgentOwnerInput: ({ requestId, runOptions, context, cancelThisRun, emitUpdate }) => {
          if (session.agentStore == null || typeof session.agentStore.getBlobStore !== "function") throw new TypeError("the production Agent blob store is not bound");
          const liveModes = turnAutoReviewGate.currentModes();
          const hostShellReview = shellReviewFor(liveModes.hostShell, "host_machine", "host_shell");
          const boxShellReview = shellReviewFor(liveModes.boxShell, "isolated_box", "box_shell");
          const turn: TurnToolsetTurnInput = {
            ...baseTurn,
            emitUpdate,
            cancelThisRun,
            ...presentOptions({ ackToken: runOptions.ackToken }),
            ...(hostShellReview === undefined && boxShellReview === undefined
              ? {}
              : { shellAutoReview: { ...presentOptions({ host: hostShellReview, box: boxShellReview }) } }),
          };
          return {
            context,
            conversationId: session.id,
            requestId,
            inference: createTypedInferenceOwner(extensions.api("inference").port),
            onRequestId: requestIdForwarder(hooks, "agent"),
            isSubagentRunner: false,
            isSilenceAllowed: runOptions.isSilenceAllowed === true,
            canUseSelfSummary: () => true,
            cancelThisRun: (reason) => {
              (builtRunner as { interrupt?: (value: string) => boolean } | undefined)?.interrupt?.(reason.reason);
            },
            createResourceAccessor: localProductionResourceAccessor,
            createRemoteBoxResourceAccessor: productionResourceAccessor,
            createTurnLocalResourceProjectionInput: (baseAccessor) => {
              const runner = builtRunner;
              if (runner === undefined) throw new TypeError("the production turn resource runner is not bound");
              const projectedActionAuditor = asActionAuditor(actionAuditor);
              if (projectedActionAuditor === undefined) throw new TypeError("the production turn action auditor is not bound");
              const createSubagentRunner = (agentId: string, args: SubagentAdapterArgs): SubagentSession => {
                const child = deps.buildRunner({
                  ...runnerOptions,
                  conversationId: agentId,
                  transcriptId: agentId,
                  isSubagent: true,
                  subagentType: args.subagentType,
                  initialState: { turns: [], summaryArchives: [], turnTimings: [] },
                  productionTurnRunShell: undefined,
                });
                bindSessionOwnedRunner(child);
                ownedRunners.add(child);
                return {
                  run: async (prompt, options) => {
                    const result = await child.run(prompt, options);
                    if (typeof result !== "object" || result == null) throw new TypeError("the production subagent result is not bound");
                    const text = Reflect.get(result, "text");
                    const aborted = Reflect.get(result, "aborted");
                    if (typeof text !== "string" || typeof aborted !== "boolean") throw new TypeError("the production subagent result is not bound");
                    return { text, aborted };
                  },
                  interrupt: (reason) => {
                    child.interrupt(reason);
                  },
                  getResolvedOutline: () => child.getResolvedOutline(),
                  getObservedToolCallCount: () => child.getObservedToolCallCount(),
                  getActivitySnapshot: () => child.getActivitySnapshot(),
                  getTranscriptPath: () => child.getTranscriptPath(),
                };
              };
              const computerUse = runner.computerUse;
              return {
                subagentSessions: runner.subagents.sessions,
                createSubagentRunner,
                subagentDispatcher: {
                  isRunning: (agentId) => runner.subagents.isRunning(agentId),
                  hasRunningToolCall: (toolCallId) => runner.subagents.hasRunningToolCall(toolCallId),
                  awaitSubagent: (request, signal) => runner.subagents.awaitSubagent(request, signal),
                  allocateComputerUseWindow: (agentId) => computerUse?.allocateWindow(agentId) ?? null,
                  freeComputerUseWindow: (agentId) => {
                    computerUse?.freeWindow(agentId);
                  },
                  dispatch: (input) => runner.subagents.dispatchBackgroundSubagent(input),
                },
                requestContext: turnRequestContext,
                includeTranscripts: scope.hasConversationContext,
                autoReviewEnforceEnabled: Object.values(autoReviewModes).includes("enforce"),
                shellStreamExecutor: baseAccessor.get(shellStreamExecutorResource),
                backgroundShellExecutor: baseAccessor.get(backgroundShellExecutorResource),
                autoReviewGate: { assertNoPendingApproval: () => turnAutoReviewGate.assertNoPendingApproval() },
                actionAuditor: projectedActionAuditor,
                agentId: session.id,
                ...presentOptions({ smartModeClassifierExecutor: autoReview.autoReviewClassifierExecutor }),
              };
            },
            blobStore: getAgentBlobStore(session.agentStore as Parameters<typeof getAgentBlobStore>[0]),
            toolHost: lazyToolHost(),
            turn,
            staticConfig: {
              modelId: staticModelId,
              agentTokenLimit: 200_000,
              conversationId: session.id,
              isBoxScopedSubagent: false,
              isSubagentRunner: false,
              isSharedRoomRunner: isSharedRoomTurn,
              slateSendMessageDeliveryOwed: looseMethod(experiments, "isSendMessageDeliveryOwedEnabled")?.() ?? false,
              systemPromptGenerator: () => productionSystemPromptAssembly?.getSystemPrompt() ?? DEFAULT_SLATE_SYSTEM_PROMPT,
            },
            emitUpdate,
            interactionObservers: {},
            diskPressureReminder: foreverBox.diskPressureReminder,
            emittedConnectorCards: new Set(),
            ...presentOptions({ profilePromptSnapshotStore: productionSystemPromptAssembly === undefined ? undefined : asPromptSnapshotStore(session.db) }),
          } satisfies ProductionTurnAgentOwnerInput;
        },
        promptOptions: (_prompt, options) => interopTurnPromptOptionsFromRunner(options),
        assembleSlateTurnAction: productionPromptGlue.assembleSlateTurnAction,
        compactionEpoch: () => 0,
        getConversationState: getProductionConversationState,
        createSession: (owner) => ({
          getModelId: () => owner.runContext.sessions.agent.getModelId(),
          getExecutor: () => createTextExecutor(owner.runContext.toolSession.getExecutor()),
        }),
        context: () => productionContext,
        createSettleHost: createProductionTurnSettleHost,
        profilePromptSnapshots: () => session.db,
        isSubagentRunner: false,
        subagents: { sessions: new Map() },
        getConversationId: () => session.id,
        runGeneration: () => (builtRunner as { currentRunGeneration?: number } | undefined)?.currentRunGeneration ?? 0,
        setActiveTurnRequestSource: () => {},
        beginAutoReviewUserMessageEpoch: () => {},
        setActiveRunInterrupted: () => {},
        setAwaitingUserSelection: () => {},
        isAwaitingUserSelection: () => false,
        emitRunLifecycle: (event) => hooks.onRunLifecycle?.(event),
        emitUpdate: (update) => hooks.transport.onUpdate(update),
        cancelThisRun: () => {},
        ...presentOptions({
          mcp:
            mcp.mcp != null && typeof mcp.mcp.getTools === "function"
              ? { getTools: (runContext: Context) => mcp.mcp.getTools(runContext), refreshAccountConfig: () => mcp.mcp.refreshAccountConfig() }
              : undefined,
          lastReactionApplied:
            hooks.transport.lastReactionApplied === undefined ? undefined : () => hooks.transport.lastReactionApplied?.() === true,
        }),
      });
    }

    // A host that has no turn shell runs the step loop instead: one step at a time, stopping on the step that says done.
    if (deps.createRunStep != null && runnerOptions.productionTurnRunShell === undefined) {
      runnerOptions.runStep = deps.createRunStep({ session, hooks, overrides, runnerOptions, createTurnToolInputs });
    }

    /** Everything a runner needs from its session, bound once after construction. */
    function bindSessionOwnedRunner(runner: Runner): void {
      const bindings: RunnerServiceBindings = {
        agentState: { store: session.agentStore, profileProvider: hooks.agentProfileProvider },
        memory: {
          primary: session.memory,
          user: runnerOptions.userMemory,
          project: runnerOptions.projectMemory,
          snapshots: session.db,
          profileSnapshots: session.db,
          episodeProgress: session.db,
        },
        automation: { automations: session.automations, workflows: session.workflows, channels: session.channels },
        toolAccess: { mcp: mcp.mcp, management: mcp.management },
        attachments: {
          ingestor: hooks.ingestAttachment,
          imagePersister: hooks.persistImage,
          mediaPersister: hooks.persistMediaBytes,
        },
      };
      runner.bindSessionServices(bindings);
    }

    const runner = deps.buildRunner(runnerOptions);
    bindSessionOwnedRunner(runner);
    ownedRunners.add(runner);
    builtRunner = runner;
    return runner;
  }

  return {
    createRunner: (session, hooks) => createRunner(session, hooks),
    createGroupMemberRunner: (session, hooks, groupOverrides) => createRunner(session, hooks, { ...groupOverrides, groupMemberTurn: true }),
    canAskLocalToolPermission: (agentId) => localToolPermissionSurfaces.canAsk(agentId),
    forgetLocalToolPermission: (agentId) => {
      localToolPermissionSurfaces.forget(agentId);
      looseMethod(localToolPermission, "forgetAgent")?.(agentId);
    },
    dispose: async () => {
      for (const runner of ownedRunners) {
        const candidate = runner as { interrupt?(reason?: string): unknown; dispose?(): void | Promise<void> };
        candidate.interrupt?.("host shutdown");
        await candidate.dispose?.();
      }
      ownedRunners.clear();
      localToolPermissionSurfaces.dispose();
      await mirrorOffloadPool?.closeAll();
      mirrorOffloadPool = null;
    },
  };
}
