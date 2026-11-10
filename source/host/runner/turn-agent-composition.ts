/**
 * The Agent a turn runs on, assembled from the pieces the host already owns.
 *
 * `buildAgentForRun` is the whole point of this file, and it is a chain of small, named handoffs, in this order:
 *
 * 1. **the model projection** — which model this turn runs and what its subagents may choose;
 * 2. **the tools handoff** — a lazy generator: the Agent asks for tools only when it is ready, and the state it is given
 *    at that moment is the turn's state, never a cached one;
 * 3. **the static config** — token limit, summarization, feature flags, the user-info options a subagent or a shared
 *    room switches off, and the prompt/tools generators;
 * 4. **the Agent itself** — built over the redacted interaction listener, the summarization handler, the resource
 *    accessor and the blob store;
 * 5. **the stream start** — one callback the attempt layer calls, which projects the generated state and action into
 *    their redacted forms and forwards the checkpoint persistence untouched.
 *
 * Two rules are worth stating because they are easy to lose in a composition this size:
 *
 * - **a retry resumes, it does not re-send** — when a stream is retried with a checkpoint to resume from, the state
 *   comes from that checkpoint and the action is the canonical empty resume action;
 * - **a tool that needs a resource cannot be offered without it** — the per-turn tool host adds a factory only when its
 *   inputs exist (a computer dependency, a state handler, a shell stream, an MCP projection), and returns the host it
 *   was given when none do.
 */
import {
  buildTurnTools,
  createTurnShellAutoReviewOptions,
  createTurnToolsetFactoriesForTurn,
  resolveTurnShellAutoReviewInputs,
  type TurnMcpMetaToolFactoryInput,
  type TurnMultitaskToolFactoryInput,
  type TurnShellToolFactoryInput,
  type TurnTool,
  type TurnToolsetBuildProps,
  type TurnToolsetHost,
  type TurnToolsetTurnInput,
  type TurnToolsetHostFactoryProvider,
} from "./tools/turn-toolset.ts";
import type { Context } from "../../packages/context/context.ts";
import { requestIdKey } from "../../adapters/interop/chat-inference-proto/client.ts";
import { AgentRoot } from "../../packages/agent/index.ts";
import { createSlateResumeAgentAction, type SlateAgentAction } from "../../packages/agent/agent-action-state.ts";
import type { SlateConversationState } from "../../packages/agent/conversation-state.ts";
import { SimplePromptToolExecutor } from "../../packages/agent/tool-stream-executor.ts";
import { NoopConversationActionReceiver } from "../../packages/agent-core/conversation-actions/remote-receiver.ts";
import { toRedactedInteractionListener } from "../../adapters/interop/agent/redacted-interaction-listener-adapter.ts";
import type { PrivacyMode } from "../../packages/redaction/privacy-mode.ts";
import {
  cloneInteropConversationState,
  projectInteropTurnRun,
  runnerConversationStateFromStoreCheckpoint,
  restoreAgentConversationState,
  restoreSlateConversationState,
  type InteropConversationAction,
  type InteropConversationState,
} from "../../adapters/interop/agent/turn-agent-run-projection-adapter.ts";
import { SLATE_BOX_SHELL_TOOL_NAME, SLATE_EXTERNAL_SHELL_TOOL_NAME } from "../slate-activity.ts";
import type { SummarizationPromptSession } from "../../packages/agent-summarization/summarization-handler.ts";
import type { CloudAgentToolDeps } from "../cloud-agents/cloud-agent-tool.ts";
import type { BackgroundWatchesHost } from "./background-work.ts";
import type { BlobStore } from "../../packages/agent-kv/blob-store.ts";
import { CombinedResourceAccessor, resourceEntry, type RemoteResource, type ResourceAccessor } from "../../packages/agent-exec/resource-provider.ts";
import type { ExecutorOptions, RemoteExecManager } from "../../packages/agent-exec/executor-resources.ts";
import { createInteropSubagentExecutorFromSlate, subagentExecutorResource } from "../../adapters/interop/agent/subagent-exec-adapter.ts";
import { createSubagentExecutor, slateSubagentExecutorResource } from "../../packages/agent-exec/subagent.ts";
import {
  createSlateSubagentBackgroundHandoffExecutor,
  slateSubagentBackgroundHandoffExecutorResource,
} from "../../packages/agent-exec/subagent-control.ts";
import {
  createSlateSubagentAwaitExecutor,
  slateSubagentAwaitExecutorResource,
} from "../../packages/agent-exec/subagent-await.ts";
import { backgroundShellExecutorResource } from "../../packages/agent-exec/background-shell.ts";
import { requestContextExecutorResource } from "../../packages/agent-exec/request-context-operation.ts";
import { shellStreamExecutorResource } from "../../packages/agent-exec/shell-stream-operation.ts";
import { smartModeClassifierExecutorResource, type SmartModeClassifierExecutor } from "../../packages/agent-exec/smart-mode-classifier-operation.ts";
import { mcpExecutorResource, mcpStateExecutorResource } from "../../packages/agent-exec/mcp-operations.ts";
import {
  ForwardingInteractionListener,
  SlateRequestContextExecutor,
  SlateSubagentHostAdapter,
  type ForwardedUpdate,
  type RequestContextProvider,
  type SubagentAdapterArgs,
  type SubagentDispatcher,
} from "./agent-adapters.ts";
import type { SubagentSession } from "./subagent-runtime.ts";
import { SubagentRegistry, subagentRegistryResource } from "../../packages/agent/tools/subagent-registry.ts";
import { NoopDocumentationHydrationService, NoopWebScraperService } from "../../packages/agent/utils/agent-config.ts";
import { createSubagentModels } from "../../packages/agent/tools/core/subagent/models.ts";
import { createSlateSummarizationHandler } from "./conversation-state.ts";
import {
  createDiskPressureReminderMiddleware,
  createSendMessageReminderMiddleware,
  type MessageLike,
  type PromptExecutor as ReminderPromptExecutor,
} from "./send-message-reminder-middleware.ts";
import { createOpeningMessageReminder } from "./start-of-turn-ack-reminder-middleware.ts";
import { buildSlateSubagentConfigsForRun } from "./turn-subagent-configs.ts";
import {
  buildSlateSubagentLaunchReviewTarget,
  buildSlateSubagentRiskTarget,
  reviewSlateSubagentAction,
  SLATE_SUBAGENT_CLASSIFIER_ERROR_REASON,
  type InstructionPermissions,
} from "./slate-subagent-auto-review.ts";
import { runSlateAutoReviewClassifier } from "./slate-auto-review-classifier-run.ts";
import type { SlateAutoReviewController, SlateAutoReviewExpiryPolicy, SlateAutoReviewMode } from "./slate-auto-review.ts";
import type { SlateClassifierConversationMessage } from "../../packages/agent/smart-mode-classifier-context.ts";
import { maybeEntry, presentOptions } from "./optional-options.ts";
import { shellCommandFromInteropRequest } from "../../adapters/interop/agent/local-shell-stream-executor-adapter.ts";
import { turnMcpExecutorPortFromInterop, turnMcpResourceImplementationFromInterop } from "../../adapters/interop/mcp/turn-mcp-executor-adapter.ts";
import type { TurnMcpCall, TurnMcpResultView } from "./turn-mcp-execution-contracts.ts";

export const SLATE_AGENT_MAX_STEPS = 5_000;
export { runnerConversationStateFromStoreCheckpoint };

export interface TurnProfileIdentity {
  readonly name: string;
  readonly description: string;
}

export type TurnProfileUpdateCallback = (identity: TurnProfileIdentity) => void;

export type TurnProfileHistoryAppender = (messages: readonly unknown[], profilePromptSnapshot: unknown, onProfileUpdateAppended: TurnProfileUpdateCallback) => unknown;

export type TurnAgentResourceAccessor = ResourceAccessor<RemoteExecManager>;

export type TurnAgentStateHandler = NonNullable<TurnToolsetBuildProps["stateHandler"]>;

export interface TurnAgentToolSession {
  getExecutor(...args: readonly unknown[]): SimplePromptToolExecutor;
}

export interface TurnAgentToolSessionInput {
  getExecutor(): ReminderPromptExecutor;
  readonly isSubagentRunner: boolean;
  readonly isSilenceAllowed: boolean;
  readonly diskPressureReminderEpisodeId?: string | null;
  readonly onLatestPromptMessages?: (getter: () => readonly MessageLike[]) => void;
}

/**
 * The executor order every tool message passes through: the disk-pressure reminder, then the send-message reminder, then
 * the start-of-turn acknowledgement — and a subagent or a silent turn gets none of the two it cannot use. A fresh
 * executor is asked for on every call; none of them is cached across turns.
 */
export function createTurnToolSession(input: TurnAgentToolSessionInput): TurnAgentToolSession {
  return {
    getExecutor: () => {
      const base = input.getExecutor();
      const withDiskPressure = input.diskPressureReminderEpisodeId == null ? base : createDiskPressureReminderMiddleware(input.diskPressureReminderEpisodeId)(base);
      if (input.isSubagentRunner || input.isSilenceAllowed) return new SimplePromptToolExecutor(withDiskPressure);
      const executor = createOpeningMessageReminder()(createSendMessageReminderMiddleware()(withDiskPressure));
      const toolExecutor = new SimplePromptToolExecutor(executor);
      input.onLatestPromptMessages?.(() => toolExecutor.getMessages());
      return toolExecutor;
    },
  };
}

const DEFAULT_BACKGROUND_SUMMARIZATION = {
  unusedTokensThresholdToStartBackgroundSummarization: 10_000,
  unusedPercentTokensThresholdToStartBackgroundSummarization: 0.1,
  unusedTokensThresholdToPersistBackgroundSummarization: 5_000,
  unusedPercentTokensThresholdToPersistBackgroundSummarization: 0.05,
  discardOnError: true,
  requireTriggerThresholdForMidLoopPersist: true,
} as const;

export interface TurnAgentStaticConfigInputs {
  readonly modelId: string;
  readonly agentTokenLimit: number;
  readonly conversationId: string;
  readonly isBoxScopedSubagent: boolean;
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly slateSendMessageDeliveryOwed: boolean;
  readonly transcriptsFolderAvailable?: boolean;
  readonly backgroundSummarizationPropsOverride?: Partial<typeof DEFAULT_BACKGROUND_SUMMARIZATION>;
  readonly systemPromptGenerator: (...args: readonly unknown[]) => unknown;
  readonly toolsGenerator: (props: TurnToolsetBuildProps) => ReturnType<typeof buildTurnTools>;
  readonly selfSummaryConfig?: unknown;
  readonly attachedMediaUrlProvider?: unknown;
  readonly messageHistoryModifier?: (...args: readonly unknown[]) => unknown;
  readonly profilePromptSnapshot?: unknown;
  readonly onProfileUpdateAppended?: TurnProfileUpdateCallback;
  readonly appendProfileUpdateToHistory?: TurnProfileHistoryAppender;
}

/** Which model this turn runs and which models its subagents may use: one model, seen from both sides. */
export function createSlateTurnModelProjection(modelId: string) {
  return {
    parentModelInfo: createSlatePromptModelInfo(modelId),
    subagentModels: createSubagentModels({ [modelId]: { slug: modelId } }),
  };
}

/**
 * The static half of the Agent's config. It is static in the sense that it does not change during a turn: the limits, the
 * feature flags, the prompt generator, and the user-info options a subagent or a shared room turns off.
 *
 * One subtlety: when the turn has a profile snapshot *and* a way to append a profile update, the history modifier is
 * replaced by that appender; a caller that supplied its own modifier gets it only when there is no update to append.
 */
export function createSlateAgentStaticConfig(input: TurnAgentStaticConfigInputs) {
  const profilePromptSnapshot = input.profilePromptSnapshot;
  const onProfileUpdateAppended = input.onProfileUpdateAppended;
  const appendProfileUpdateToHistory = input.appendProfileUpdateToHistory;
  const messageHistoryModifier =
    profilePromptSnapshot === undefined || onProfileUpdateAppended === undefined || appendProfileUpdateToHistory === undefined
      ? input.messageHistoryModifier
      : (messages: readonly unknown[]) => appendProfileUpdateToHistory(messages, profilePromptSnapshot, onProfileUpdateAppended);
  return {
    maxSteps: SLATE_AGENT_MAX_STEPS,
    modelId: input.modelId,
    agentTokenLimit: input.agentTokenLimit,
    backgroundSummarizationProps: { ...DEFAULT_BACKGROUND_SUMMARIZATION, ...input.backgroundSummarizationPropsOverride },
    featureFlags: {
      enableWatchVideoInIdeSubagent: true,
      slateSendMessageDeliveryOwed: input.slateSendMessageDeliveryOwed,
      userMessageTimestamps: true,
      rerenderUserInfoOnRequestContextRecovery: true,
      rerenderUserInfoOnSummarization: true,
      skipPreTurnStateSnapshot: true,
    },
    agentType: "IDE" as const,
    conversationId: input.conversationId,
    conversationGroupId: input.conversationId,
    systemPromptGenerator: input.systemPromptGenerator,
    toolsGenerator: input.toolsGenerator,
    webScraperService: new NoopWebScraperService(),
    documentationHydrationService: new NoopDocumentationHydrationService(),
    userInfoDisplayOptions: {
      disable: input.isBoxScopedSubagent,
      displayWorkspaceRules: true,
      displaySkills: !input.isSubagentRunner && !input.isSharedRoomRunner,
      excludeAgentTranscripts: input.isSubagentRunner || input.transcriptsFolderAvailable === false,
    },
    enableTerminalFiles: false,
    enableTranscriptInSummary: true,
    ...presentOptions({
      selfSummaryConfig: input.selfSummaryConfig,
      attachedMediaUrlProvider: input.attachedMediaUrlProvider,
      messageHistoryModifier,
    }),
  };
}

export interface TurnAgentToolsHandoff {
  readonly toolsGenerator: (props: TurnToolsetBuildProps) => ReturnType<typeof buildTurnTools>;
  readonly getActiveStateHandler: () => TurnAgentStateHandler | undefined;
}

/**
 * The lazy tools boundary.
 *
 * The Agent asks for tools only when it is ready to run, and at that moment it hands over the state it has. That state is
 * remembered here (for callers that ask for it afterwards) and the props are passed through untouched; nothing about the
 * turn's state or tools is cached between turns.
 *
 * The generator also closes the host gap: props may carry dependencies this turn does not have a provider for (a computer
 * dependency, a state handler, an MCP projection, a shell stream), and each of those becomes a provider for exactly this
 * build. When there is nothing to add, the host the caller gave is returned as it is.
 */
export function createTurnAgentToolsHandoff(input: { readonly toolHost: TurnToolsetHost; readonly turn: TurnToolsetTurnInput; readonly turnScope?: TurnAgentTurnScope }): TurnAgentToolsHandoff {
  let activeStateHandler: TurnAgentStateHandler | undefined;
  const turn: TurnToolsetTurnInput = input.turnScope === undefined ? input.turn : { ...input.turn, ...createTurnScopeToolHooks(input.turnScope) };

  const toolHostWithProps = (props: TurnToolsetBuildProps): TurnToolsetHost => {
    const resolvedShellAutoReview = turn.shellAutoReview === undefined ? resolveTurnShellAutoReviewInputs(turn, props) : undefined;
    const effectiveTurn: TurnToolsetTurnInput = { ...turn, ...presentOptions({ shellAutoReview: resolvedShellAutoReview }) };
    const provider = props.turnToolsetFactoryProvider ?? input.toolHost.factoryProvider;
    // A provider slot the host already filled stays as it is; a slot this build's props can fill is filled for this build
    // only, and a slot neither can fill leaves that tool out.
    const perTurnProvider: Record<string, unknown> = { ...(provider ?? {}) };
    // A slot the host already filled wins; a slot this build's props can fill is filled for this build only; a slot
    // neither can fill leaves its tool out.
    const fill = (key: string, value: unknown): void => {
      if (perTurnProvider[key] === undefined && value !== undefined) perTurnProvider[key] = value;
    };
    fill("createComputerToolInputs", dependenciesFromProps(props, "computer", (current) => current.createComputerToolDependencies));
    fill("createScreenshotToolInputs", dependenciesFromProps(props, "screenshot", (current) => current.createScreenshotToolDependencies));
    fill("createBrowserToolInputs", dependenciesFromProps(props, "browser driver", (current) => current.createBrowserDriverDependencies));
    fill("createMultitaskToolInputs", props.stateHandler === undefined ? undefined : () => multitaskInputFor(props));
    fill("createMcpMetaToolInputs", props.mcp?.mcpMeta === undefined ? undefined : () => mcpMetaInputFor(props));
    fill("createExternalShellToolInputs", hasShellStream(props) ? externalShellInputFor(effectiveTurn) : undefined);
    fill("createBoxShellToolInputs", hasShellStream(props) ? boxShellInputFor(effectiveTurn) : undefined);
    if (provider === undefined && Object.keys(perTurnProvider).length === 0) return input.toolHost;
    const projected = createTurnToolsetFactoriesForTurn(perTurnProvider as TurnToolsetHostFactoryProvider, effectiveTurn, props);
    if (Object.keys(projected).length === 0) return input.toolHost;
    return {
      ...input.toolHost,
      ...presentOptions({ factoryProvider: provider }),
      factories: { ...input.toolHost.factories, ...projected },
    };
  };

  return {
    toolsGenerator: (props) => {
      const enrichedProps: TurnToolsetBuildProps =
        turn.parentModelInfo === undefined && turn.subagentModels === undefined
          ? props
          : { ...props, ...presentOptions({ parentModelInfo: turn.parentModelInfo, subagentModels: turn.subagentModels }) };
      activeStateHandler = enrichedProps.stateHandler;
      return buildTurnTools(toolHostWithProps(enrichedProps), turn, enrichedProps);
    },
    getActiveStateHandler: () => activeStateHandler,
  };
}

/** Whether this turn really has a shell stream to reach: a tool over a stream that is not there is not offered. */
function hasShellStream(props: TurnToolsetBuildProps): boolean {
  try {
    return props.resourceAccessor.get(shellStreamExecutorResource) !== undefined;
  } catch {
    return false;
  }
}

/**
 * A tool whose dependencies live on the props, projected into a provider: the props the build carries win, and a build
 * that somehow arrives without them fails loudly instead of offering a tool that cannot run.
 */
function dependenciesFromProps(
  props: TurnToolsetBuildProps,
  what: string,
  pick: (current: TurnToolsetBuildProps) => ((current: TurnToolsetBuildProps) => unknown) | undefined,
): ((turn: TurnToolsetTurnInput, currentProps: TurnToolsetBuildProps) => { readonly dependencies: unknown }) | undefined {
  if (pick(props) === undefined) return undefined;
  return (_turn, currentProps) => {
    const create = pick(currentProps);
    if (create === undefined) throw new TypeError(`${what} tool dependencies are not bound`);
    return { dependencies: create(currentProps) };
  };
}

function multitaskInputFor(props: TurnToolsetBuildProps): TurnMultitaskToolFactoryInput {
  if (props.stateHandler === undefined) throw new TypeError("the Multitask state handler is not bound");
  return { resourceAccessor: props.resourceAccessor as TurnMultitaskToolFactoryInput["resourceAccessor"], stateHandler: props.stateHandler as unknown as TurnMultitaskToolFactoryInput["stateHandler"] };
}

function mcpMetaInputFor(props: TurnToolsetBuildProps): TurnMcpMetaToolFactoryInput {
  const mcpMeta = props.mcp?.mcpMeta;
  if (mcpMeta === undefined) throw new TypeError("the MCP meta-tool options are not bound");
  return { resourceAccessor: props.resourceAccessor as TurnMcpMetaToolFactoryInput["resourceAccessor"], ...mcpMeta };
}

/** The host machine's shell: it acts on the user's computer, so it carries that surface's review identities. */
function externalShellInputFor(turn: TurnToolsetTurnInput): (providerTurn: TurnToolsetTurnInput, props: TurnToolsetBuildProps) => TurnShellToolFactoryInput | undefined {
  return (_providerTurn, props) => {
    const accessor = props.resourceAccessor;
    if (accessor.get(shellStreamExecutorResource) === undefined) return undefined;
    return {
      resourceAccessor: accessor as TurnShellToolFactoryInput["resourceAccessor"],
      options: createTurnShellAutoReviewOptions({
        resourceAccessor: accessor as TurnShellToolFactoryInput["resourceAccessor"],
        options: {
          surface: "host_machine",
          toolName: SLATE_EXTERNAL_SHELL_TOOL_NAME,
          readToolIdentifier: "EXTERNAL_READ",
          awaitToolIdentifier: "AWAIT",
          enableBlockUntilMs: true,
          defaultBlockUntilMs: 30_000,
        },
        ...presentOptions({ review: turn.shellAutoReview?.host }),
      }),
    };
  };
}

/** The box's shell: the isolated box's own accessor, so a box-shell call never reaches the user's machine. */
function boxShellInputFor(turn: TurnToolsetTurnInput): (providerTurn: TurnToolsetTurnInput, props: TurnToolsetBuildProps) => TurnShellToolFactoryInput | undefined {
  return (_providerTurn, _props) => {
    const accessor = turn.remoteBoxResourceAccessor;
    if (accessor === undefined) throw new TypeError("the remote box resource accessor is not bound");
    if (accessor.get(shellStreamExecutorResource) === undefined) return undefined;
    return {
      resourceAccessor: accessor as TurnShellToolFactoryInput["resourceAccessor"],
      options: createTurnShellAutoReviewOptions({
        resourceAccessor: accessor as TurnShellToolFactoryInput["resourceAccessor"],
        options: {
          surface: "isolated_box",
          toolName: SLATE_BOX_SHELL_TOOL_NAME,
          awaitToolIdentifier: "BOX_AWAIT",
          enableBlockUntilMs: true,
          defaultBlockUntilMs: 30_000,
        },
        ...presentOptions({ review: turn.shellAutoReview?.box }),
      }),
    };
  };
}

export interface TurnAgentConstructorHandoff extends TurnAgentConstructionInputs {
  readonly toolHost: TurnToolsetHost;
  readonly turn: TurnToolsetTurnInput;
  readonly turnScope?: TurnAgentTurnScope;
}

/** The Agent constructor's inputs, with the tools generator already bound into the config. */
export function createTurnAgentConstructorHandoff(input: TurnAgentConstructorHandoff) {
  const tools = createTurnAgentToolsHandoff({ toolHost: input.toolHost, turn: input.turn, ...presentOptions({ turnScope: input.turnScope }) });
  const agent = createTurnAgentForRun({ ...input, config: { ...input.config, toolsGenerator: tools.toolsGenerator } });
  return { agent, toolsGenerator: tools.toolsGenerator, getActiveStateHandler: tools.getActiveStateHandler };
}

export interface TurnAgentBuildForRunInput extends Omit<TurnAgentConstructorHandoff, "config"> {
  readonly staticConfig: Omit<TurnAgentStaticConfigInputs, "toolsGenerator">;
}

export interface BuiltTurnAgentForRun {
  readonly agent: AgentRoot;
  readonly config: ReturnType<typeof createSlateAgentStaticConfig>;
  readonly parentModelInfo: PromptModelInfo;
  readonly subagentModels: ReturnType<typeof createSubagentModels>;
  readonly toolsGenerator: (props: TurnToolsetBuildProps) => ReturnType<typeof buildTurnTools>;
  readonly getActiveStateHandler: () => unknown;
  readonly runStream: (input: TurnAgentRunStreamInput) => Promise<InteropConversationState>;
}

export interface TurnAgentRunStreamInput {
  readonly attemptCtx: Context;
  readonly state: SlateConversationState;
  readonly action: SlateAgentAction;
  readonly mcpTools: readonly unknown[];
  readonly persistCheckpoint: (checkpointCtx: Context, checkpoint: InteropConversationState) => Promise<void> | void;
}

export interface TurnAgentStreamStartInput {
  readonly agent: Pick<BuiltTurnAgentForRun, "agent">;
  readonly baseState: InteropConversationState;
  readonly action: InteropConversationAction | SlateAgentAction;
  readonly privacyMode: PrivacyMode;
  readonly mcpTools: readonly unknown[];
}

export interface TurnAgentStreamStart {
  startStream(attemptCtx: Context, resumeFrom: InteropConversationState | undefined, persistCheckpoint: TurnAgentRunStreamInput["persistCheckpoint"]): Promise<InteropConversationState>;
}

async function runAgentStreamAtInteropBoundary(
  agent: Pick<AgentRoot, "runStream">,
  streamInput: TurnAgentRunStreamInput,
): Promise<InteropConversationState> {
  const slateState = await agent.runStream(
    streamInput.attemptCtx,
    streamInput.state,
    streamInput.action,
    streamInput.mcpTools,
    streamInput.persistCheckpoint,
  );
  return restoreAgentConversationState(slateState);
}

/**
 * The one callback the attempt layer calls: it gives the Agent a Slate state and redacted action, adapts the returned
 * state to the runner's historical checkpoint shape, and hands checkpoint persistence back untouched.
 */
export function createTurnAgentStreamStart(input: TurnAgentStreamStartInput): TurnAgentStreamStart {
  return {
    startStream(attemptCtx, resumeFrom, persistCheckpoint) {
      const streamInput = createTurnAgentRunStreamInput({
        attemptCtx,
        baseState: input.baseState,
        action: input.action,
        privacyMode: input.privacyMode,
        mcpTools: input.mcpTools,
        persistCheckpoint,
        ...presentOptions({ resumeFrom }),
      });
      return runAgentStreamAtInteropBoundary(input.agent.agent, streamInput);
    },
  };
}

export interface TurnAgentMcpTurnProvider {
  getTools(ctx: Context): Promise<readonly unknown[]>;
  refreshAccountConfig(): void;
}

export interface TurnAgentRunInputProjectionFactoryInput {
  readonly runCtx: Context;
  readonly createAction: (runCtx: Context) => Promise<InteropConversationAction | SlateAgentAction>;
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: (error: unknown) => void;
  readonly getConversationState: () => InteropConversationState;
}

export interface TurnAgentRunInputProjection {
  readonly action: InteropConversationAction | SlateAgentAction;
  readonly baseState: InteropConversationState;
  readonly mcpTools: readonly unknown[];
}

/**
 * What the stream is about to run: the action, the MCP tools it may call, and the state to start from.
 *
 * The action is produced first, so a prompt that cannot be assembled fails before anything is discovered. MCP discovery is
 * this turn's own (its failure is reported, not thrown: the turn runs without those tools), the account configuration is
 * refreshed without disposing the manager, and the state is cloned only once discovery is done.
 */
export async function createTurnAgentRunInputProjection(input: TurnAgentRunInputProjectionFactoryInput): Promise<TurnAgentRunInputProjection> {
  const action = await input.createAction(input.runCtx);
  let mcpTools: readonly unknown[] = [];
  if (input.mcp !== undefined) {
    try {
      mcpTools = [...(await input.mcp.getTools(input.runCtx))];
    } catch (error) {
      input.onMcpDiscoveryFailed?.(error);
    }
    input.mcp.refreshAccountConfig();
  }
  const conversationState = input.getConversationState();
  return { action, baseState: cloneInteropConversationState(conversationState), mcpTools };
}

/** The stream's own input: the state and the action projected to their redacted forms, the tools forwarded as they are. */
export function createTurnAgentRunStreamInput(input: {
  readonly attemptCtx: Context;
  readonly baseState: InteropConversationState;
  readonly action: InteropConversationAction | SlateAgentAction;
  readonly resumeFrom?: InteropConversationState;
  readonly privacyMode: PrivacyMode;
  readonly mcpTools: readonly unknown[];
  readonly persistCheckpoint: TurnAgentRunStreamInput["persistCheckpoint"];
}): TurnAgentRunStreamInput {
  const projection = projectInteropTurnRun({
    baseState: input.baseState,
    action: input.action,
    ...presentOptions({ resumeFrom: input.resumeFrom }),
    resumeAction: createSlateResumeAgentAction(),
    privacyMode: input.privacyMode,
  });
  return {
    attemptCtx: input.attemptCtx,
    state: restoreSlateConversationState(projection.state),
    action: projection.action,
    mcpTools: input.mcpTools,
    persistCheckpoint: input.persistCheckpoint,
  };
}

/** The Agent for this turn, with everything it needs already resolved by the caller. */
export function buildAgentForRun(input: TurnAgentBuildForRunInput): BuiltTurnAgentForRun {
  const model = createSlateTurnModelProjection(input.staticConfig.modelId);
  const tools = createTurnAgentToolsHandoff({
    toolHost: input.toolHost,
    turn: { ...input.turn, parentModelInfo: model.parentModelInfo, subagentModels: model.subagentModels },
    ...presentOptions({ turnScope: input.turnScope }),
  });
  const config = createSlateAgentStaticConfig({
    ...input.staticConfig,
    toolsGenerator: tools.toolsGenerator,
    ...presentOptions({
      profilePromptSnapshot: input.turnScope?.profilePromptSnapshot,
      onProfileUpdateAppended: input.turnScope?.onProfileUpdateAppended,
    }),
  });
  const agent = createTurnAgentForRun({
    ...input,
    config,
    preserveLatestImage: input.preserveLatestImage ?? input.staticConfig.isBoxScopedSubagent,
  });
  const runStream = async (streamInput: TurnAgentRunStreamInput): Promise<InteropConversationState> =>
    runAgentStreamAtInteropBoundary(agent, streamInput);
  return {
    agent,
    config,
    parentModelInfo: model.parentModelInfo,
    subagentModels: model.subagentModels,
    toolsGenerator: tools.toolsGenerator,
    getActiveStateHandler: tools.getActiveStateHandler,
    runStream,
  };
}

export type TurnCloudAgentTool = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly execute: (...args: readonly unknown[]) => Promise<unknown>;
};
export type TurnCloudAgentReviewAction = NonNullable<CloudAgentToolDeps["reviewAction"]>;
export type TurnCloudAgentWatch = NonNullable<CloudAgentToolDeps["watch"]>;
export type TurnCloudAgentWatcher = NonNullable<ReturnType<BackgroundWatchesHost["cloudAgentWatcher"]>>;

export interface TurnCloudAgentProjectionInput {
  readonly createCloudAgentTool: (input: { readonly reviewAction?: TurnCloudAgentReviewAction }) => TurnCloudAgentTool;
  readonly watchCloudAgent: TurnCloudAgentWatch;
  readonly cloudAgentWatcher: BackgroundWatchesHost["cloudAgentWatcher"];
}

export interface TurnCloudAgentProjection {
  readonly createCloudAgentTool: TurnCloudAgentProjectionInput["createCloudAgentTool"];
  readonly watchCloudAgent: TurnCloudAgentWatch;
  readonly cloudAgentWatcher: BackgroundWatchesHost["cloudAgentWatcher"];
}

/**
 * The cloud-agent tool and watcher for this turn. The policy fence lives in `buildTurnTools`; here the host's own
 * review action and watcher identities are carried, and nothing is cached.
 */
export function createTurnCloudAgentProjection(input: TurnCloudAgentProjectionInput): TurnCloudAgentProjection {
  return {
    createCloudAgentTool: ({ reviewAction } = {}) => input.createCloudAgentTool(presentOptions({ reviewAction })),
    watchCloudAgent: input.watchCloudAgent,
    cloudAgentWatcher: input.cloudAgentWatcher,
  };
}

export function createTurnCloudAgentFactory(projection: TurnCloudAgentProjection, reviewAction?: TurnCloudAgentReviewAction): () => TurnCloudAgentTool {
  return () => projection.createCloudAgentTool(presentOptions({ reviewAction }));
}

export interface TurnAgentConstructionInputs {
  readonly config: ReturnType<typeof createSlateAgentStaticConfig>;
  readonly toolSession: TurnAgentToolSession;
  readonly emitUpdate: (update: ForwardedUpdate) => void;
  readonly interactionObservers: ConstructorParameters<typeof ForwardingInteractionListener>[1];
  readonly privacyMode: PrivacyMode;
  readonly resourceAccessor: TurnAgentResourceAccessor;
  readonly blobStore: BlobStore<unknown>;
  readonly summarizationSession: SummarizationPromptSession;
  readonly preserveLatestImage?: boolean;
}

/**
 * The Agent itself: its config, the tool session that gives it executors, the redacted interaction listener, the turn's
 * resource accessor, the blob store and the summarization handler. Nothing is defaulted here — a caller that has no
 * resource or blob store cannot build an Agent.
 */
export function createTurnAgentForRun(input: TurnAgentConstructionInputs): AgentRoot {
  const interactionListener = toRedactedInteractionListener(new ForwardingInteractionListener(input.emitUpdate, input.interactionObservers), input.privacyMode);
  const summarizationHandler = createSlateSummarizationHandler(input.summarizationSession, { preserveLatestImage: input.preserveLatestImage ?? false });
  return new AgentRoot(input.config, input.toolSession, interactionListener, input.resourceAccessor, input.blobStore, summarizationHandler, new NoopConversationActionReceiver<SlateAgentAction>());
}

/** What the prompt builder is told about the model: the name, and that it is none of the special cases. */
export interface PromptModelInfo {
  readonly vendor: "openai";
  readonly modelName: string;
  readonly promptVersion: "latest";
  readonly isSonnet45: false;
  readonly isGemini3: false;
  readonly isGpt51: false;
  readonly isGpt52: false;
  readonly isGpt5: false;
  readonly isSonnet4: false;
  readonly isCodexFamily: false;
  readonly isGpt52Codex: false;
  readonly isGpt53Codex: false;
  readonly isClaude4X: false;
  readonly isOpus45: false;
  readonly isOpus46: false;
  readonly isGpt5Family: false;
  readonly isLegacyAgentModel1: false;
  readonly isLegacyAgentModel15: false;
  readonly isLegacyAgentModel2: false;
  readonly isGpt53CodexSpark: false;
}

export function createSlatePromptModelInfo(modelName: string): PromptModelInfo {
  return {
    vendor: "openai",
    modelName,
    promptVersion: "latest",
    isSonnet45: false,
    isGemini3: false,
    isGpt51: false,
    isGpt52: false,
    isGpt5: false,
    isSonnet4: false,
    isCodexFamily: false,
    isGpt52Codex: false,
    isGpt53Codex: false,
    isClaude4X: false,
    isOpus45: false,
    isOpus46: false,
    isGpt5Family: false,
    isLegacyAgentModel1: false,
    isLegacyAgentModel15: false,
    isLegacyAgentModel2: false,
    isGpt53CodexSpark: false,
  };
}

export interface PromptExecutor {
  executeModelStreamOnly(...args: readonly unknown[]): { readonly response: Promise<unknown>; readonly toolCallDescriptors: Promise<unknown>; readonly [key: string]: unknown };
}

/**
 * A tool-stream executor over a model-stream-only one: the response it hands back waits for the tool-call descriptors
 * too, so a caller that only looks at the response still knows the calls were settled.
 */
export class SlateSelfSummaryPromptToolExecutor {
  constructor(readonly executor: PromptExecutor) {}

  executeToolStream(...args: readonly unknown[]): { readonly response: Promise<unknown>; readonly [key: string]: unknown } {
    const { toolCallDescriptors, ...result } = this.executor.executeModelStreamOnly(...args);
    return { ...result, response: Promise.all([result.response, toolCallDescriptors]).then(([response]) => response) };
  }
}

export interface AgentSession {
  getModelId(): string;
  getResolvedModelId?(): string | undefined;
  getExecutor(): unknown;
  getExecutorWithoutResolvedModelTracking?(state: unknown): PromptExecutor;
}

export interface TurnAgentSessions {
  readonly agent: AgentSession;
  /** The summarization owner has its own message-aware executor signature. */
  readonly summarization: AgentSession | SummarizationPromptSession;
  readonly canUseSelfSummary: () => boolean;
}

export interface TurnAgentScope {
  readonly isSilenceAllowed: boolean;
  readonly privacyMode: PrivacyMode;
  readonly quietOrigin?: unknown;
  readonly directionEpoch?: number;
  readonly cancelThisRun: (reason: { intentional: boolean; reason: string }) => void;
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
  readonly profilePromptSnapshot?: unknown;
  readonly onProfileUpdateAppended?: TurnProfileUpdateCallback;
  readonly diskPressureReminderEpisodeId?: string | null;
  readonly emittedConnectorCards: Set<string>;
}

export type TurnAgentTurnScope = Pick<
  TurnAgentScope,
  "cancelThisRun" | "ackToken" | "pauseThisRun" | "isRunAwaitingUserSelection" | "endThisRunAwaitingUser" | "privacyMode" | "profilePromptSnapshot" | "onProfileUpdateAppended"
>;

export interface TurnScopeToolHooks {
  readonly cancelThisRun: TurnAgentScope["cancelThisRun"];
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
}

/** The live turn controls, copied without binding them to a runner: one the host did not supply stays absent. */
export function createTurnScopeToolHooks(
  scope: Pick<TurnAgentScope, "cancelThisRun" | "ackToken" | "pauseThisRun" | "isRunAwaitingUserSelection" | "endThisRunAwaitingUser">,
): TurnScopeToolHooks {
  return {
    cancelThisRun: scope.cancelThisRun,
    ...presentOptions({
      ackToken: scope.ackToken,
      pauseThisRun: scope.pauseThisRun,
      isRunAwaitingUserSelection: scope.isRunAwaitingUserSelection,
      endThisRunAwaitingUser: scope.endThisRunAwaitingUser,
    }),
  };
}

export type TurnAgentInteractionObservers = ConstructorParameters<typeof ForwardingInteractionListener>[1];

export interface TurnAgentScopeProjection {
  readonly toolHooks: TurnScopeToolHooks;
  readonly interactionObservers: TurnAgentInteractionObservers;
  readonly privacyMode: PrivacyMode;
  readonly preserveLatestImage: boolean;
  readonly profilePromptSnapshot?: unknown;
  readonly onProfileUpdateAppended?: TurnProfileUpdateCallback;
}

/** What the Agent takes from the turn's scope: its controls, its observers, its privacy, and whether the image stays. */
export function createTurnAgentScopeProjection(input: {
  readonly scope: Pick<TurnAgentScope, "cancelThisRun" | "ackToken" | "pauseThisRun" | "isRunAwaitingUserSelection" | "endThisRunAwaitingUser" | "privacyMode" | "profilePromptSnapshot" | "onProfileUpdateAppended">;
  readonly interactionObservers: TurnAgentInteractionObservers;
  readonly isBoxScopedSubagent: boolean;
}): TurnAgentScopeProjection {
  return {
    toolHooks: createTurnScopeToolHooks(input.scope),
    interactionObservers: input.interactionObservers,
    privacyMode: input.scope.privacyMode,
    preserveLatestImage: input.isBoxScopedSubagent,
    ...presentOptions({ profilePromptSnapshot: input.scope.profilePromptSnapshot, onProfileUpdateAppended: input.scope.onProfileUpdateAppended }),
  };
}

export interface TurnAgentCompositionHost {
  readonly toolHost: TurnToolsetHost;
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isBoxScopedSubagent: boolean;
  readonly isSystemPromptOverridden?: boolean;
  getConversationId(): string;
  resolveContextWindow(modelId: string): number;
  isSendMessageDeliveryOwedEnabled?(): boolean;
  currentAutoReviewModes(): { hostShell: string; boxShell: string; mcp: string; computer: string; automationWrite: string; cloudAgent: string; subagentLaunch: string };
  getSubagentConfigs?(): readonly unknown[];
  isBrowserUseSubagentEnabled?(): boolean;
  isMultitaskEnabled?(): boolean;
  createExecutorSubagentConfig?(): unknown;
  getSubagentTypeName?(config: unknown): string | undefined;
  transcriptsFolderAvailable?(): boolean;
}

export interface TurnAgentProductionReadiness {
  readonly ready: boolean;
  readonly blockers: readonly ("multitask" | "externalRead")[];
}

export interface TurnAgentProductionReadinessOptions {
  /** The per-turn resource/state projection is available. */
  readonly multitaskPerTurnProjectionAvailable?: boolean;
}

/**
 * Whether the tool set is complete enough to run production traffic: the two owners whose absence would silently remove a
 * capability (multitask planning, reading files) are the only blockers, and a turn that has a per-turn projection for
 * multitask is not blocked by its factory being absent.
 */
export function getTurnAgentProductionReadiness(
  toolHost: Pick<TurnToolsetHost, "factories">,
  options: TurnAgentProductionReadinessOptions = {},
): TurnAgentProductionReadiness {
  const blockers: Array<"multitask" | "externalRead"> = [];
  if (toolHost.factories.multitask === undefined && options.multitaskPerTurnProjectionAvailable !== true) blockers.push("multitask");
  if (toolHost.factories.externalRead === undefined) blockers.push("externalRead");
  return { ready: blockers.length === 0, blockers };
}

export interface ConnectorCardEmission {
  readonly serverId: string;
  readonly variant: string;
  readonly connector?: string;
}

export interface TurnScopedConnectorCardEmission extends ConnectorCardEmission {
  readonly ackToken?: string | undefined;
  readonly cancelThisRun: TurnAgentScope["cancelThisRun"];
}

/**
 * The MCP executor as the turn sees it: every call is observed (so a slow connector is visible), an error result is
 * classified, and a connector that needs authentication gets its connect card emitted once — with a note appended to the
 * error telling the model to end its turn instead of reaching around the auth.
 */
export function createTurnMcpExecutorGuard<ExecContext extends Context>(dependencies: {
  readonly isSubagentRunner: boolean;
  readonly assertNoPendingApproval: () => void;
  readonly execute: (context: ExecContext, call: TurnMcpCall, options?: ExecutorOptions) => Promise<TurnMcpResultView>;
  readonly beginObservation: (args: { toolCallId: string; connector: string; requestId?: string | undefined }) => (errorClass?: string) => void;
  readonly boundedConnectorTag: (providerIdentifier: string) => string;
  readonly mcpErrorClassOf: (error: unknown) => string;
  readonly takeMcpExecErrorClass: (toolCallId: string) => string | undefined;
  readonly resolveNeedsAuthSlot?: ((providerIdentifier: string) => Promise<{ serverName: string; serverId: string } | null>) | undefined;
  readonly emitConnectorCard: (emission: ConnectorCardEmission) => void;
  readonly reportDiagnostic: (event: { kind: "mcp_connect_card_failed"; errorClass: string }) => void;
  readonly errorLogTag: (error: unknown) => string;
}) {
  const connectCardEmittedForServer = new Set<string>();

  async function surfaceNeedsAuthCard(connectorId: string): Promise<string | null> {
    if (dependencies.isSubagentRunner || dependencies.resolveNeedsAuthSlot == null) return null;
    if (connectorId.length === 0 || connectCardEmittedForServer.has(connectorId)) return null;
    const slot = await dependencies.resolveNeedsAuthSlot(connectorId);
    if (slot == null) return null;
    connectCardEmittedForServer.add(connectorId);
    dependencies.emitConnectorCard({ connector: slot.serverName, serverId: slot.serverId, variant: "connect" });
    return `"${slot.serverName}" needs authentication; its connect card is now in the chat. Finish unrelated work, then end your turn \u2014 you're resumed automatically when the user authorizes. Don't call AuthenticateMcpServer, send a link, or reach the service another way meanwhile.`;
  }

  return {
    async execute(context: ExecContext, call: TurnMcpCall, options?: ExecutorOptions): Promise<unknown> {
      dependencies.assertNoPendingApproval();
      const connectorId = call.connectorId.length > 0 ? call.connectorId : call.serverId;
      const settleObservation = dependencies.beginObservation({
        toolCallId: call.callId ?? "",
        connector: dependencies.boundedConnectorTag(connectorId),
        ...presentOptions({ requestId: context.get(requestIdKey) }),
      });
      let result: TurnMcpResultView;
      try {
        result = await dependencies.execute(context, call, options);
      } catch (error) {
        settleObservation(dependencies.mcpErrorClassOf(error));
        throw error;
      }
      if (result.kind !== "error") {
        settleObservation();
        return result.encodedResult;
      }
      settleObservation(dependencies.takeMcpExecErrorClass(call.callId ?? ""));
      try {
        const note = await surfaceNeedsAuthCard(connectorId);
        if (note != null) result.appendAuthenticationNote(note);
      } catch (cardError) {
        // A card that could not be emitted must not turn a tool error into a thrown one: it is reported and the result
        // goes back as the connector answered it.
        dependencies.reportDiagnostic({ kind: "mcp_connect_card_failed", errorClass: dependencies.errorLogTag(cardError) });
      }
      return result.encodedResult;
    },
    surfaceNeedsAuthCard,
  };
}

/** A shell executor that refuses to run while an approval is pending, and writes down what it ran. */
export function wrapTurnShellExecutorForAudit(
  base: unknown,
  dependencies: {
    readonly assertNoPendingApproval: () => void;
    readonly auditShellCommand: (kind: "foreground" | "background", command: string, surface: "user_machine") => void;
  },
  kind: "foreground" | "background",
) {
  const execute = typeof base === "object" && base !== null ? Reflect.get(base, "execute") : undefined;
  if (typeof execute !== "function") throw new TypeError("turn shell executor is not executable");
  return {
    execute(context: unknown, args: unknown, options?: ExecutorOptions): unknown {
      dependencies.assertNoPendingApproval();
      dependencies.auditShellCommand(kind, shellCommandFromInteropRequest(args), "user_machine");
      return execute.call(base, context, args, options);
    },
  };
}

type TurnLocalResourceEntry = readonly [RemoteResource<unknown, RemoteExecManager>, unknown];

function opaqueResourceEntry(resource: unknown, implementation: unknown): TurnLocalResourceEntry {
  if (typeof resource !== "object" || resource === null || typeof Reflect.get(resource, "remoteImplementation") !== "function") {
    throw new TypeError("turn resource descriptor is not remote");
  }
  return [resource as RemoteResource<unknown, RemoteExecManager>, implementation];
}

export interface TurnLocalResourceProjectionInput {
  readonly baseAccessor: ResourceAccessor<RemoteExecManager>;
  readonly subagentSessions: Map<string, SubagentSession>;
  readonly createSubagentRunner: (agentId: string, args: SubagentAdapterArgs) => SubagentSession;
  readonly subagentDispatcher: SubagentDispatcher;
  readonly reviewSubagentLaunch?: (context: unknown, args: SubagentAdapterArgs) => Promise<{ readonly allowed: boolean; readonly reason: string }>;
  /** The launch-review inputs; installed only once the final accessor exists. */
  readonly subagentReview?: TurnSubagentLaunchReviewInput;
  readonly requestContext: RequestContextProvider;
  /** Workflow-derived skills are resolved per request-context execution. */
  readonly resolveAgentSkills?: () => readonly unknown[];
  readonly includeTranscripts: boolean;
  readonly autoReviewEnforceEnabled: boolean;
  readonly smartModeClassifierExecutor?: SmartModeClassifierExecutor;
  readonly shellStreamExecutor: unknown;
  readonly backgroundShellExecutor: unknown;
  readonly autoReviewGate: { readonly assertNoPendingApproval: () => void };
  readonly actionAuditor: { readonly record: (record: unknown) => void };
  readonly agentId: string;
  readonly now?: () => number;
  readonly mcp?: TurnMcpProjectionInput;
}

export interface TurnSubagentLaunchReviewInput {
  readonly isSubagentRunner: boolean;
  readonly mode: SlateAutoReviewMode;
  readonly agentId: string;
  readonly autoReviewGate: { readonly assertNoPendingApproval: () => void };
  readonly autoReviewController?: Pick<SlateAutoReviewController, "requestApproval">;
  readonly getApprovalExpiryPolicy?: () => SlateAutoReviewExpiryPolicy;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
  readonly getActiveStateHandler?: () => unknown;
  readonly extractConversationContext?: (context: Context, stateHandler: unknown) => Promise<SlateClassifierConversationMessage[]>;
  readonly workspacePaths?: readonly string[];
  readonly reportShadowFailure?: (error: unknown) => void;
  readonly suspendToolExecutionTimeout?: <T>(context: Context, operation: () => Promise<T>) => Promise<T>;
}

/** Whether a context is a live turn's: the review needs one to cancel and to record against. */
function isTurnContext(value: unknown): value is Context {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly signal?: unknown; readonly get?: unknown; readonly withCancel?: unknown };
  return typeof candidate.signal === "object" && candidate.signal !== null && typeof candidate.get === "function" && typeof candidate.withCancel === "function";
}

/**
 * The launch review for a subagent: nothing to review when the turn is itself a subagent or auto-review is off, and a
 * launch with no target to review is allowed. Everything the classifier needs — the accessor, the active state, the
 * approval, the expiry, the cancellation — comes from the final accessor, so this callback never outlives the turn.
 */
export function createTurnSubagentLaunchReviewer(
  input: TurnSubagentLaunchReviewInput & { readonly resourceAccessor: ResourceAccessor<RemoteExecManager> },
): ((context: unknown, args: SubagentAdapterArgs) => Promise<{ readonly allowed: boolean; readonly reason: string }>) | undefined {
  if (input.isSubagentRunner || input.mode === "off") return undefined;
  return async (context, args) => {
    if (!isTurnContext(context)) return { allowed: false, reason: "Auto-review requires a live turn context." };
    const target = buildSlateSubagentLaunchReviewTarget({
      prompt: args.prompt,
      subagentType: args.subagentType,
      resume: args.resumeAgentId !== undefined && args.resumeAgentId.length > 0,
      ...presentOptions({ readonly: args.readonly }),
    });
    if (target === undefined) return { allowed: true, reason: "" };
    input.autoReviewGate.assertNoPendingApproval();
    return reviewSlateSubagentAction({
      ctx: context,
      target,
      toolCallId: args.toolCallId,
      signal: context.signal,
      options: {
        mode: input.mode,
        agentId: input.agentId,
        classify: async (classifyContext, classifyTarget, mode, toolCallId) =>
          await runSlateAutoReviewClassifier({
            ctx: classifyContext,
            resourceAccessor: input.resourceAccessor,
            toolCallId,
            mode,
            buildTarget: () =>
              buildSlateSubagentRiskTarget({
                target: classifyTarget,
                ...presentOptions({
                  personalInstructions: input.personalInstructions,
                  userAutoRunInstructions: input.userAutoRunInstructions,
                  projectAutoRunInstructions: input.projectAutoRunInstructions,
                }),
              }),
            loadConversationContext: async () => {
              const stateHandler = input.getActiveStateHandler?.();
              if (stateHandler === undefined || input.extractConversationContext === undefined) return [];
              return input.extractConversationContext(classifyContext, stateHandler);
            },
            errorReason: SLATE_SUBAGENT_CLASSIFIER_ERROR_REASON,
            ...presentOptions({ workspacePaths: input.workspacePaths }),
          }),
        ...presentOptions({
          autoReviewController: input.autoReviewController,
          personalInstructions: input.personalInstructions,
          userAutoRunInstructions: input.userAutoRunInstructions,
          projectAutoRunInstructions: input.projectAutoRunInstructions,
          getApprovalExpiryPolicy: input.getApprovalExpiryPolicy,
          reportShadowFailure: input.reportShadowFailure,
          suspendToolExecutionTimeout: input.suspendToolExecutionTimeout,
        }),
      },
    }).then((result) => ({ allowed: result.allowed, reason: result.reason ?? "" }));
  };
}

export interface TurnMcpForTurn {
  readonly createExecutor: (persistImage: unknown, spillLargeText: unknown, auditIdentity: { readonly agentId: string }) => unknown;
  readonly createStateExecutor: () => unknown;
  readonly resolveNeedsAuthSlot?: (providerIdentifier: string) => Promise<{ readonly serverName: string; readonly serverId: string } | null>;
}

export interface TurnMcpProjectionInput {
  readonly mcpForTurn: TurnMcpForTurn;
  readonly persistImage: unknown;
  readonly textSpiller: unknown;
  readonly isSubagentRunner: boolean;
  readonly beginObservation: (args: { readonly toolCallId: string; readonly connector: string; readonly requestId?: string | undefined }) => (errorClass?: string) => void;
  readonly boundedConnectorTag: (providerIdentifier: string) => string;
  readonly mcpErrorClassOf: (error: unknown) => string;
  readonly takeMcpExecErrorClass: (toolCallId: string) => string | undefined;
  readonly emitConnectorCard: (emission: TurnScopedConnectorCardEmission) => void;
  readonly ackToken?: string | undefined;
  readonly cancelThisRun: TurnAgentScope["cancelThisRun"];
  readonly reportDiagnostic: (event: { readonly kind: "mcp_connect_card_failed"; readonly errorClass: string }) => void;
  readonly errorLogTag: (error: unknown) => string;
  /** The caller's own MCP discovery/call options; none are synthesized here. */
  readonly mcpMeta?: Omit<TurnMcpMetaToolFactoryInput, "resourceAccessor">;
}

export interface TurnLocalResourceProjection {
  readonly adapter: SlateSubagentHostAdapter;
  readonly subagentRegistry: SubagentRegistry;
  readonly localEntries: readonly TurnLocalResourceEntry[];
  readonly resourceAccessor: CombinedResourceAccessor<RemoteExecManager>;
  /** True only when this turn has no MCP projection to add. */
  readonly mcpEntriesPending: boolean;
}

/** What a shell command a turn ran is recorded as, including which surface it ran on and when. */
function createTurnShellAudit(input: Pick<TurnLocalResourceProjectionInput, "actionAuditor" | "agentId" | "now">) {
  return (kind: "foreground" | "background", command: string): void => {
    input.actionAuditor.record({
      agentId: input.agentId,
      occurredAtMs: (input.now ?? Date.now)(),
      action: { kind: "shellCommand", command, shellKind: kind, target: "user_machine" },
    });
  };
}

/**
 * This turn's local resources over the box's own: subagents and their registry, the request-context executor, the shell
 * streams (audited, approval-gated), and — when the turn has one — the MCP executors. Each is keyed by its resource
 * symbol, and the base accessor stays underneath as the fallback.
 */
export function createTurnLocalResourceProjection(input: TurnLocalResourceProjectionInput): TurnLocalResourceProjection {
  const adapter = new SlateSubagentHostAdapter(input.subagentSessions, input.createSubagentRunner, input.subagentDispatcher);
  const subagentExecutor = createSubagentExecutor(adapter);
  const subagentHandoffExecutor = createSlateSubagentBackgroundHandoffExecutor(
    (toolCallId) => adapter.hasRunningToolCall(toolCallId),
  );
  const subagentAwaitExecutor = createSlateSubagentAwaitExecutor(
    (request, signal) => adapter.awaitSubagent(request, signal),
  );
  const requestContextExecutor = new SlateRequestContextExecutor(input.requestContext, input.includeTranscripts, input.autoReviewEnforceEnabled, input.resolveAgentSkills);
  const subagentRegistry = new SubagentRegistry();
  const auditShellCommand = createTurnShellAudit(input);
  const auditDependencies = {
    assertNoPendingApproval: input.autoReviewGate.assertNoPendingApproval,
    auditShellCommand: (kind: "foreground" | "background", command: string) => auditShellCommand(kind, command),
  };
  const localEntries: TurnLocalResourceEntry[] = [
    resourceEntry(slateSubagentExecutorResource, subagentExecutor),
    resourceEntry(subagentExecutorResource, createInteropSubagentExecutorFromSlate(subagentExecutor)),
    resourceEntry(slateSubagentBackgroundHandoffExecutorResource, subagentHandoffExecutor),
    resourceEntry(slateSubagentAwaitExecutorResource, subagentAwaitExecutor),
    resourceEntry(requestContextExecutorResource, requestContextExecutor),
    resourceEntry(subagentRegistryResource, subagentRegistry),
  ];
  if (input.smartModeClassifierExecutor !== undefined) localEntries.push(resourceEntry(smartModeClassifierExecutorResource, input.smartModeClassifierExecutor));
  if (input.mcp !== undefined) {
    const mcpExecutor = turnMcpExecutorPortFromInterop(input.mcp.mcpForTurn.createExecutor(input.mcp.persistImage, input.mcp.textSpiller, { agentId: input.agentId }));
    const guardedMcpExecutor = createTurnMcpExecutorGuard({
      isSubagentRunner: input.mcp.isSubagentRunner,
      assertNoPendingApproval: input.autoReviewGate.assertNoPendingApproval,
      execute: (context, call, options) => mcpExecutor.execute(context, call, options),
      beginObservation: input.mcp.beginObservation,
      boundedConnectorTag: input.mcp.boundedConnectorTag,
      mcpErrorClassOf: input.mcp.mcpErrorClassOf,
      takeMcpExecErrorClass: input.mcp.takeMcpExecErrorClass,
      resolveNeedsAuthSlot: input.mcp.mcpForTurn.resolveNeedsAuthSlot,
      emitConnectorCard: (emission) =>
        input.mcp?.emitConnectorCard({
          ...emission,
          cancelThisRun: input.mcp.cancelThisRun,
          ...presentOptions({ ackToken: input.mcp.ackToken }),
        }),
      reportDiagnostic: input.mcp.reportDiagnostic,
      errorLogTag: input.mcp.errorLogTag,
    });
    const interopMcpExecutor = turnMcpResourceImplementationFromInterop((context, call, options) => guardedMcpExecutor.execute(context as Context, call, options as ExecutorOptions));
    localEntries.push(opaqueResourceEntry(mcpExecutorResource, interopMcpExecutor), opaqueResourceEntry(mcpStateExecutorResource, input.mcp.mcpForTurn.createStateExecutor()));
  }
  localEntries.push(
    opaqueResourceEntry(shellStreamExecutorResource, wrapTurnShellExecutorForAudit(input.shellStreamExecutor, auditDependencies, "foreground")),
    opaqueResourceEntry(backgroundShellExecutorResource, wrapTurnShellExecutorForAudit(input.backgroundShellExecutor, auditDependencies, "background")),
  );
  const resourceAccessor = new CombinedResourceAccessor(input.baseAccessor, localEntries);
  const launchReviewer = input.subagentReview === undefined ? input.reviewSubagentLaunch : createTurnSubagentLaunchReviewer({ ...input.subagentReview, resourceAccessor });
  if (launchReviewer !== undefined) adapter.setLaunchReviewer(launchReviewer);
  return { adapter, subagentRegistry, localEntries, resourceAccessor, mcpEntriesPending: input.mcp === undefined };
}

/**
 * The composition host: the one place that knows which subagent configs this turn may use, and whether the tool set is
 * complete enough for production. The configs are built once per run and remembered by the caller.
 */
export function createTurnAgentComposition(host: TurnAgentCompositionHost) {
  let subagentConfigsForRun: readonly unknown[] | undefined;

  function buildSubagentConfigsForRun(): readonly unknown[] | undefined {
    subagentConfigsForRun = buildSlateSubagentConfigsForRun(host);
    return subagentConfigsForRun;
  }

  return {
    buildAgentForRun: (input: TurnAgentBuildForRunInput): BuiltTurnAgentForRun => buildAgentForRun(input),
    getProductionReadiness: (): TurnAgentProductionReadiness =>
      getTurnAgentProductionReadiness(host.toolHost, { multitaskPerTurnProjectionAvailable: host.isMultitaskEnabled?.() === true }),
    buildSubagentConfigsForRun,
    getSubagentConfigsForRun: (): readonly unknown[] | undefined => subagentConfigsForRun,
  };
}
