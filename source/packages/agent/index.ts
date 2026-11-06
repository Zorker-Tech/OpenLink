/**
 * The agent as the rest of the platform holds it.
 *
 * Everything a turn needs is assembled here once: the configuration it runs under, the session that owns the
 * prompt, the listener the user hears through, the resources it reads, the store its conversation is kept
 * in, the summarizer, and the receiver a conversation's own actions come back through. The actions are
 * matched to their handlers by the action's own case, so a new kind of action is a new entry rather than a
 * new branch, and a run is a stream of one action after another: the state is restored from the store, the
 * handler for the action runs, and the updates it produces are written back out.
 *
 * A run can be a whole turn or a single step of one, which is what lets a caller drive the loop itself: the
 * split-step handlers expose the same work one step at a time, and the tool-call and subagent paths are
 * reachable on their own for callers that already know what they want to run.
 */
// the turn plumbing
import { flushPostTurnEndedWork } from "../agent-core/interaction-listener.ts";
import { DeferredInteractionResponseError } from "../agent-core/interaction-queries.ts";
import { Updates } from "../agent-core/interaction-updates.ts";
import { BackgroundSummarizationMode, DISABLED_BACKGROUND_SUMMARIZATION_PROPS } from "../agent-summarization/background-summarization.ts";
import { withLogAttributes, createSpan } from "../context/index.ts";
import { createHistogram } from "../metrics/index.ts";
import { PrivacyMode } from "../redaction/privacy-mode.ts";
import { restoreAgentConversationState } from "../../adapters/interop/agent/redacted-conversation-state-adapter.ts";
import { redactInteractionUpdate } from "../../adapters/interop/agent/redacted-interaction-listener-adapter.ts";
// the session and its state
import { drainPendingWritesOnRunStreamError } from "./abort-drain.ts";
import { normalizeAgentConfig } from "./agent-config-runtime.ts";
import { buildRunStreamStateHandleOptions, shouldTrackAgentTypeChange, createRunStreamStateUpdateWithFlush } from "./run-stream-lifecycle.ts";
import { estimateTokenCount } from "./self-summary/token-estimate.ts";
import { ConversationStateHandle } from "./state.ts";
import type { SlateConversationState } from "./conversation-state.ts";
import type { SlateAgentAction, SlateAgentActionKind } from "./agent-action-state.ts";
import type { AgentActionInbox } from "../agent-core/conversation-actions/action-inbox.ts";
import { SummarizationOrchestrator } from "./summarization-orchestrator.ts";
import { RedactedPromptToolExecutor } from "./tool-stream-executor.ts";
import { conversationGroupIdKey, conversationIdKey, bubbleRetryableTaskErrorsKey } from "./utils/request-scope.ts";
// the actions a turn can take
import { AsyncAskQuestionCompletionActionHandler } from "./actions/async-ask-question-completion-action-handler.ts";
import { BackgroundShellActionHandler } from "./actions/background-shell-action-handler.ts";
import { BackgroundSubagentActionHandler } from "./actions/background-subagent-action-handler.ts";
import { BackgroundTaskCompletionActionHandler } from "./actions/background-task-completion-action-handler.ts";
import { CancelActionHandler } from "./actions/cancel-action-handler.ts";
import { ExecutePlanActionHandler } from "./actions/execute-plan-action-handler.ts";
import { GoalContinuationActionHandler } from "./actions/goal-continuation-action-handler.ts";
import { ShellCommandActionHandler } from "./actions/shell-command-action-handler.ts";
import { SubscriptionWakeupActionHandler } from "./actions/subscription-notification-action-handler.ts";
import { SummarizeActionHandler } from "./actions/summarize-action-handler.ts";
import { AbstractUserMessageActionHandler } from "./actions/user-message-action/abstract-user-message-action-handler.ts";
import { ResumeActionHandler } from "./actions/user-message-action/resume-action-handler.ts";
import { UserMessageActionHandler } from "./actions/user-message-action/user-message-action-handler.ts";

type Any = any;

/** The actions a turn can take, each created once and matched to Slate's action kind. */
function createActionHandlers(input: {
  config: Any;
  resourceAccessor: Any;
  interactionListener: Any;
  summarizationHandler: Any;
  conversationActionReceiver: AgentActionInbox<SlateAgentAction>;
  orchestrator: Any;
}): Map<SlateAgentActionKind, Any> {
  const { config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, orchestrator } = input;
  const handlers = new Map<SlateAgentActionKind, Any>();
  const user = new UserMessageActionHandler(config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, orchestrator);
  handlers.set("user-message", user);
  handlers.set("subscription-notification", new SubscriptionWakeupActionHandler(user));
  handlers.set("goal-continuation", new GoalContinuationActionHandler(user, config.toolsGenerator, resourceAccessor, config.agentSessionId));
  handlers.set("resume", new ResumeActionHandler(config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, orchestrator));
  handlers.set("summarize", new SummarizeActionHandler(config, resourceAccessor, interactionListener, orchestrator, conversationActionReceiver));
  handlers.set("shell-command", new ShellCommandActionHandler(config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver));
  handlers.set("cancel", new CancelActionHandler(config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver));
  handlers.set("execute-plan", new ExecutePlanActionHandler(config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, orchestrator));
  handlers.set("ask-question-completion", new AsyncAskQuestionCompletionActionHandler(config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, orchestrator));
  handlers.set("background-task-completion", new BackgroundTaskCompletionActionHandler(config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, orchestrator));
  handlers.set("background-shell", new BackgroundShellActionHandler());
  handlers.set("background-subagent", new BackgroundSubagentActionHandler());
  return handlers;
}

const MAX_TURN_STEPS = 1_000;
const restoreHistogram = createHistogram("agent.state_deserialization_ms", { description: "State restore duration" });
const handlerHistogram = createHistogram("agent.action_handler_ms", { description: "Action handler duration", labelNames: ["action"] });

export class AgentRoot {
  readonly config: Any;
  readonly promptSession: Any;
  readonly interactionListener: Any;
  readonly resourceAccessor: Any;
  readonly blobStore: Any;
  readonly summarizationHandler: Any;
  readonly conversationActionReceiver: AgentActionInbox<SlateAgentAction>;
  readonly orchestrator: Any;
  readonly actionHandlers: Map<SlateAgentActionKind, Any>;

  shouldTrackAgentTypeChange(actionKind: SlateAgentActionKind | undefined): boolean {
    return shouldTrackAgentTypeChange(actionKind);
  }

  stateHandleOptions(options: Any): Any {
    return buildRunStreamStateHandleOptions(options, this.config.featureFlags);
  }

  constructor(config: Any, promptSession: Any, interactionListener: Any, resourceAccessor: Any, blobStore: Any, summarizationHandler: Any, conversationActionReceiver: AgentActionInbox<SlateAgentAction>) {
    this.promptSession = promptSession;
    this.interactionListener = interactionListener;
    this.resourceAccessor = resourceAccessor;
    this.blobStore = blobStore;
    this.summarizationHandler = summarizationHandler;
    this.conversationActionReceiver = conversationActionReceiver;
    this.config = normalizeAgentConfig(config);
    this.orchestrator = new SummarizationOrchestrator(summarizationHandler, undefined, this.config.backgroundSummarizationProps, this.config.selfSummaryConfig?.tokenLimit, this.config.selfSummaryConfig?.canUseSelfSummary);
    this.actionHandlers = createActionHandlers({
      config: this.config,
      resourceAccessor,
      interactionListener,
      summarizationHandler,
      conversationActionReceiver,
      orchestrator: this.orchestrator,
    });
  }

  async runStream(parentCtx: Any, state: SlateConversationState, action: SlateAgentAction, mcpTools: Any, onStateWrite?: Any, options?: Any): Promise<SlateConversationState> {
    using executionSpan = createSpan(parentCtx.withName("runStream"));
    const actionLabel = action.context.telemetryName ?? action.kind;
    let ctx = withLogAttributes(executionSpan.ctx, { action: actionLabel, modelName: this.config.modelId, ...(this.config.canonicalModelName === undefined ? {} : { canonicalModelName: this.config.canonicalModelName }) });
    if (this.config.conversationGroupId !== undefined) ctx = ctx.with(conversationGroupIdKey, this.config.conversationGroupId);
    if (this.config.conversationId !== undefined) ctx = ctx.with(conversationIdKey, this.config.conversationId);
    if (this.config.isBackground === true) ctx = ctx.with(bubbleRetryableTaskErrorsKey, true);
    const baseExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    let rootPromptImagePresence: Any;
    const restoreStartedAt = performance.now();
    const stateHandler = await ConversationStateHandle.fromSlateConversationState(ctx, this.blobStore, state, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(action.kind), loadRootPromptBlobs: true, ...(options?.onRootPromptImagePresence === undefined ? {} : { onRootPromptImagePresence: (value: Any) => { rootPromptImagePresence = value; } }) }));
    const stateRestoreMs = performance.now() - restoreStartedAt;
    restoreHistogram.histogram(ctx, stateRestoreMs);
    options?.onStateDeserialized?.(stateRestoreMs);
    if (rootPromptImagePresence !== undefined) options?.onRootPromptImagePresence?.(rootPromptImagePresence);
    if (action.kind === "missing") throw new Error("Action is required");
    if (action.kind === "deprecated-plan-start") throw new Error("Plan start is deprecated; submit a user message in Slate plan mode");
    const handler = this.actionHandlers.get(action.kind);
    if (handler === undefined) throw new Error(`Unsupported action type: ${action.compatibility?.sourceKind ?? action.kind}`);
    const writeStateUpdate = createRunStreamStateUpdateWithFlush({ blobStore: this.blobStore, onStateUpdate: onStateWrite });
    let pendingWrites = Promise.resolve();
    let liveState = state;
    const usage: Record<string, number> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    const runAction = async (currentHandler: Any, currentPayload: unknown, currentStateHandler: Any): Promise<void> => {
      const handlerStartedAt = performance.now();
      liveState = currentPayload === action.payload
        ? await currentHandler.handle(ctx, action.payload, baseExecutor, currentStateHandler, mcpTools, writeStateUpdate)
        : await currentHandler.handle(ctx, currentPayload, baseExecutor, currentStateHandler, mcpTools, writeStateUpdate);
      handlerHistogram.histogram(ctx, performance.now() - handlerStartedAt, { action: actionLabel });
      const turnTokens = currentStateHandler.getTurnUsageAndReset?.() ?? {};
      for (const key of Object.keys(usage)) usage[key] += turnTokens[key] ?? 0;
      if (this.config.fireAndForgetCheckpoints) pendingWrites = pendingWrites.then(() => writeStateUpdate(ctx, liveState)).catch(() => undefined);
      else await writeStateUpdate(ctx, liveState);
    };
    try {
      await runAction(handler, action.payload, stateHandler);
      while (true) {
        const nextQueued = await this.conversationActionReceiver.peek(ctx);
        if (nextQueued === undefined || nextQueued.action.kind === "missing") break;
        const queuedActionHandler = this.actionHandlers.get(nextQueued.action.kind);
        await this.conversationActionReceiver.pop(ctx);
        if (queuedActionHandler === undefined) continue;
        baseExecutor.clearMessages();
        const queuedStateKeeper = await ConversationStateHandle.fromSlateConversationState(ctx, this.blobStore, liveState, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(nextQueued.action.kind), loadRootPromptBlobs: true }));
        await runAction(queuedActionHandler, nextQueued.action.payload, queuedStateKeeper);
      }
      if (!options?.skipTurnEndedUpdate) {
        const hasTokenUsage = Object.values(usage).some(value => value > 0);
        await this.interactionListener.sendUpdate(ctx, redactInteractionUpdate(Updates.turnEnded(hasTokenUsage ? usage as Any : undefined), action.context.privacyMode));
      }
      await flushPostTurnEndedWork(ctx, this.interactionListener);
      await pendingWrites;
      await this.blobStore.flush(ctx);
      options?.onTimings?.({ stateRestoreMs, actionHandlerMs: 0 });
      return liveState;
    } catch (error) {
      await drainPendingWritesOnRunStreamError(ctx, { pendingCheckpoints: pendingWrites, flush: () => this.blobStore.flush(ctx) });
      throw error;
    }
  }

  async setupSingleStep(parentCtx: Any, state: SlateConversationState, action: SlateAgentAction, onStateWrite?: Any): Promise<Any> {
    using executionSpan = createSpan(parentCtx.withName("setupSingleStep"));
    const ctx = executionSpan.ctx;
    const baseExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    const stateHandler = await ConversationStateHandle.fromSlateConversationState(ctx, this.blobStore, state, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(action.kind), loadRootPromptBlobs: true }));
    if (action.kind === "missing") throw new Error("Action is required");
    if (action.kind === "deprecated-plan-start") throw new Error("Plan start is deprecated; submit a user message in Slate plan mode");
    const handler = this.actionHandlers.get(action.kind);
    if (handler === undefined) throw new Error(`Unsupported action type: ${action.compatibility?.sourceKind ?? action.kind}`);
    return { ctx, baseExecutor, stateHandler, handler, onStateUpdateWithFlush: createRunStreamStateUpdateWithFlush({ blobStore: this.blobStore, onStateUpdate: onStateWrite }) };
  }

  async runSingleStep(parentCtx: Any, state: SlateConversationState, action: SlateAgentAction, mcpTools: Any, onStateWrite?: Any): Promise<Any> {
    const stepSetup = await this.setupSingleStep(parentCtx, state, action, onStateWrite);
    if (!("handleSingleStep" in stepSetup.handler)) throw new Error(`Action handler for ${action.kind} does not support single-step execution`);
    const result = await stepSetup.handler.handleSingleStep(stepSetup.ctx, action.payload, stepSetup.baseExecutor, stepSetup.stateHandler, mcpTools, stepSetup.onStateUpdateWithFlush);
    await stepSetup.onStateUpdateWithFlush(stepSetup.ctx, result.state);
    return { state: result.state, hasToolCall: result.hasToolCall };
  }

  getSplitStepHandler(actionKind?: SlateAgentActionKind): Any {
    const handler = actionKind === undefined ? [...this.actionHandlers.values()].find(value => value instanceof AbstractUserMessageActionHandler) : this.actionHandlers.get(actionKind);
    if (handler instanceof SubscriptionWakeupActionHandler || handler instanceof GoalContinuationActionHandler) return handler.getUserMessageActionHandler();
    if (handler instanceof AbstractUserMessageActionHandler) return handler;
    throw new Error(`Action handler for ${actionKind ?? "unknown"} does not support split-step execution`);
  }

  async runModelStep(parentCtx: Any, state: SlateConversationState, action: SlateAgentAction, mcpTools: Any, onStateWrite?: Any): Promise<Any> {
    const stepSetup = await this.setupSingleStep(parentCtx, state, action, onStateWrite);
    if (!("handleModelStep" in stepSetup.handler)) throw new Error(`Action handler for ${action.kind} does not support split-step execution`);
    const result = await stepSetup.handler.handleModelStep(stepSetup.ctx, action.payload, stepSetup.baseExecutor, stepSetup.stateHandler, mcpTools, stepSetup.onStateUpdateWithFlush);
    await stepSetup.onStateUpdateWithFlush(stepSetup.ctx, result.state);
    return { state: result.state, toolCallDescriptors: result.toolCallDescriptors, splitStepData: { ...result.splitStepData, actionKind: action.kind } };
  }

  async executeToolCall(parentCtx: Any, state: SlateConversationState, descriptor: Any, mcpTools: Any, splitStepData: Any, fileOperationLockManager: Any, onStateWrite?: Any): Promise<Any> {
    const ctx = parentCtx;
    const baseExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    const stateHandler = await ConversationStateHandle.fromSlateConversationState(ctx, this.blobStore, state, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(splitStepData.actionKind), loadRootPromptBlobs: false }));
    const handler = this.getSplitStepHandler(splitStepData.actionKind);
    try { return await handler.executeToolCall(ctx, descriptor, stateHandler, mcpTools, splitStepData, splitStepData.requestContext ?? {}, fileOperationLockManager); }
    catch (error) { if (error instanceof DeferredInteractionResponseError && onStateWrite !== undefined) await onStateWrite(ctx, restoreAgentConversationState(await stateHandler.computeNewStructure(ctx))); throw error; }
  }

  async prepareSubagent(parentCtx: Any, state: SlateConversationState, descriptor: Any, mcpTools: Any, splitStepData: Any, fileOperationLockManager: Any): Promise<Any> {
    const ctx = parentCtx;
    const baseExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    const stateHandler = await ConversationStateHandle.fromSlateConversationState(ctx, this.blobStore, state, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(splitStepData.actionKind), loadRootPromptBlobs: true }));
    return this.getSplitStepHandler(splitStepData.actionKind).prepareSubagent(ctx, descriptor, stateHandler, mcpTools, splitStepData, splitStepData.requestContext ?? {}, fileOperationLockManager);
  }

  async finalizeStep(parentCtx: Any, state: SlateConversationState, splitStepData: Any, toolCallResults: Any, mcpTools: Any, onStateWrite?: Any): Promise<Any> {
    const ctx = parentCtx;
    const baseExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    const stateHandler = await ConversationStateHandle.fromSlateConversationState(ctx, this.blobStore, state, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(splitStepData.actionKind), loadRootPromptBlobs: true }));
    const update = createRunStreamStateUpdateWithFlush({ blobStore: this.blobStore, onStateUpdate: onStateWrite });
    const result = await this.getSplitStepHandler(splitStepData.actionKind).finalizeStep(ctx, splitStepData, toolCallResults, baseExecutor, stateHandler, mcpTools, splitStepData.requestContext ?? {}, update);
    await update(ctx, result.state);
    return { state: result.state, hasToolCall: result.hasToolCall };
  }

  shouldPrecomputeSummary(tokenDetails: Any): boolean { return this.orchestrator.shouldStartBackgroundSummarization(tokenDetails, []); }

  async computeSummarizedConversationState(parentCtx: Any, state: SlateConversationState, requestContext: Any): Promise<SlateConversationState | undefined> {
    using executionSpan = createSpan(parentCtx.withName("computeSummarizedConversationState"));
    const promptExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    const stateHandler = await ConversationStateHandle.fromSlateConversationState(executionSpan.ctx, this.blobStore, state, promptExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, { shouldTrackAgentTypeChange: false });
    const silentListener = { sendUpdate: async () => {}, query: async () => { throw new Error("Interaction queries are not supported during summarization"); } };
    const summarizedState = await this.orchestrator.handleSummarization(executionSpan.ctx, stateHandler, promptExecutor, silentListener, this.config, requestContext, { backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion, triggerReason: "approaching_token_limit", resourceAccessor: this.resourceAccessor, forceExternalModel: true, currentInvocationId: (stateHandler as Any).lastStepInvocationId });
    if (summarizedState === undefined) return undefined;
    stateHandler.setTokenDetails({
      usedTokens: estimateTokenCount(promptExecutor.getMessages() as Any),
      maximumTokens: stateHandler.tokenDetails.maximumTokens,
    });
    return await stateHandler.computeNewStructure(executionSpan.ctx);
  }

  isSingleStepHandler(handler: Any): boolean { return "handleSingleStep" in handler; }
  isSplitStepHandler(handler: Any): boolean { return "handleModelStep" in handler; }
}

export { ConversationStateHandle } from "./state.ts";
export { UserMessageActionHandler } from "./actions/user-message-action/user-message-action-handler.ts";
export { ExecutePlanActionHandler } from "./actions/execute-plan-action-handler.ts";
export { sanitizePlanFileName, resolvePlanFilePath } from "./actions/execute-plan-plan-file.ts";
