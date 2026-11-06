/**
 * The tool that hands work to a subagent.
 *
 * A subagent is another agent: its own conversation, its own prompt and its own tools, started for one job and reported
 * back to the parent. The call is resolved into a subagent type and a model; the subagent gets a configuration derived
 * from the parent's (the prompt session and resources are shared, the conversation state and action handlers are its
 * own); and its run is streamed back into the parent's interaction as the calls and results the parent can read. A
 * subagent that runs on the server reports through the parent's interaction listener, so what it does is visible while
 * it runs rather than only at the end.
 *
 * The choice of subagent and model is where most of the policy lives: a model the caller blocks is not chosen, a model
 * the caller requires is forced, a model needing a mode the parent does not have is not chosen, and the cheapest
 * candidate is preferred when the caller asks for a comparison. Inheritance is decided the same way — guidance, model,
 * environment, and whether the subagent may resume the parent's own fork.
 */
import type { Context } from "../../context/context.ts";
import { PrivacyCapability } from "../../redaction/classification.ts";
import type { ResourceAccessor } from "../../agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../agent-exec/executor-resources.ts";
import { createReadonlyResourceAccessor } from "../../agent-exec/readonly-resource-accessor.ts";
import { subagentRegistryResource } from "./subagent-registry.ts";
import {
  createTaskUserMessageActionInterop,
  createTaskToolCallDeltaInterop,
  createTaskToolCallInterop,
  serializeTaskErrorInterop,
  fromInteropTaskResultInterop,
  fromRedactedTaskConversationState,
  normalizePreparedTaskConversationStateInterop,
  slateTaskRequestFromModelArgumentsInterop,
  slateAgentActionFromInterop,
  toInteropTaskResultInterop,
  type TaskResultInterop,
} from "../../../adapters/interop/agent/task-tool-protocol-adapter.ts";
import type { SlateTaskConversationState } from "../subagent-persisted-state.ts";
import type { SlateAgentAction } from "../agent-action-state.ts";
import type { SlatePreparedTask } from "./task-prepared-state.ts";
import { buildSlatePreparedTaskHookInput } from "./task-prepared-state.ts";
import { createSlateTaskErrorResult, type SlateTaskResult } from "./task-result-state.ts";
import { requestModelNameKey, withParentRequestId } from "../utils/request-scope.ts";
import { NoopConversationActionReceiver } from "../../agent-core/conversation-actions/remote-receiver.ts";
import { Responses } from "../../agent-core/interaction-queries.ts";
import type { SlateInteractionQuery, SlateInteractionResponse } from "../../agent-core/interaction-queries.ts";
import { toRedactedInteractionListener } from "../../../adapters/interop/agent/redacted-interaction-listener-adapter.ts";
import { AgentRoot } from "../index.ts";
import { createZodAgentTool, withSafeParsedArgs } from "./tool-support.ts";
import { isPromptVisibleDescription } from "./tool-execution.ts";
import { getTaskToolName } from "./task-tool-name.ts";
import {
  buildTaskParameterSchemas,
  buildTaskToolDescriptionParts,
  type TaskSchemaSubagentConfig,
} from "./task-tool-schema.ts";
import { isComputerUseSubagentType, slateSubagentTypeName } from "../subagent-type.ts";
import {
  assertSlateTaskCloudFieldsAllowed,
  assertSlateTaskPlacementIsUnambiguous,
  type TaskSubagentModelConfig,
} from "./task-runtime.ts";
import {
  prepareTaskSubagent,
  resolveTaskSubagentConfig,
  type TaskResolutionParentState,
  type TaskSubagentResolution,
} from "./task-subagent-preparation.ts";
import type { SlateTaskRequest } from "./task-runtime-types.ts";
import {
  executeClientSideTaskSubagent,
  renderTaskResultToString,
} from "./task-client.ts";
import {
  handleSubagentExecutionError,
  handleSubagentRunStreamError,
  processSubagentIterationSuccess,
  type TaskSubagentCompletionContext,
  type TaskSubagentIterationState,
} from "./task-subagent-completion.ts";
import { createStringResult } from "../../chat-inference/prompt-executor.ts";
import { SubagentModelForcePolicy } from "./subagent-model-policy.ts";

type Any = any;

/** A predicate over model ids, and the async need a model may have for the parent's max mode. */
type ModelFilter = (modelId: string) => boolean;
type ModelMaxModeRequirement = (modelId: string) => Promise<boolean>;

/** How a comparison between a candidate model and the parent's is answered: lower is cheaper. */
type ModelCostComparison = (candidateModelId: string, parentModelId: string) => number;

interface ToolExecutionMetaLike {
  readonly toolCallId: string;
  readonly [key: string]: unknown;
}

/** How a subagent is started: off this machine from the client, by the server, or as a cloud task. */
interface SubagentLaunchOptions {
  readonly enableCloudAsyncSubagents?: boolean;
  readonly useClientSideSubagent?: boolean;
  readonly requireServerSideSubagent?: boolean;
  readonly allowResumeSelfFork?: boolean;
  readonly enableSubagentInterrupt?: boolean;
  readonly defaultSubagentsRunInBackground?: boolean;
}

/** The models a subagent call may choose from, and the policy for choosing one. */
interface SubagentModelOptions {
  readonly subagentModels: Any;
  readonly forceModelId?: string;
  readonly isModelBlocked?: ModelFilter;
  readonly isModelValid?: ModelFilter;
  readonly requiresMaxMode?: ModelMaxModeRequirement;
  readonly parentMaxMode?: boolean;
  readonly compareModelCosts?: ModelCostComparison;
  readonly subagentModelForcePolicy?: Any;
  readonly subagentModelsInUserInfo?: boolean;
  readonly subagentInheritGuidance?: boolean;
  readonly enableExploreParentModelInheritance?: boolean;
  readonly parentRequestedModelName?: string;
  readonly parentModelParameters?: readonly unknown[];
}

/** What the tool tells the model about itself, and what its run is allowed to do. */
interface TaskPresentationOptions {
  readonly enableExecuteHookExec?: boolean;
  readonly readonlyShellEnabled?: boolean;
  readonly configuredSteps?: readonly string[];
  readonly allowCustomModelId?: boolean;
  readonly includeExploreSubagent?: boolean;
  readonly enableMultitaskMode?: boolean;
  readonly enableJobCompletionNotifications?: boolean;
  readonly hideAsyncSubagentTaskNotifications?: boolean;
  readonly enableAgentChatLinks?: boolean;
  readonly environmentParamForSubagent?: boolean;
  readonly requestedEnvironmentBuildParamForSubagent?: boolean;
  readonly cloudSubagentTargeting?: boolean;
  readonly subagentExperimentGroup?: string;
}

/** The credentials and attached media a subagent call may carry. */
interface SubagentMediaOptions {
  readonly subagentCredentials?: unknown;
  readonly attachedMediaUrlProvider?: Any;
  readonly videoReviewAttachedMediaUrlProvider?: Any;
  readonly trustedVideoAttachmentRoots?: readonly string[];
  readonly inlineVideoMaxBytes?: number;
  readonly signedUrlVideoMaxBytes?: number;
}

interface TaskToolOptions extends SubagentLaunchOptions, SubagentModelOptions, TaskPresentationOptions, SubagentMediaOptions {}

interface TaskToolConfig {
  readonly agentConfig: Any;
  readonly promptSession: Any;
  readonly summarizationHandler: Any;
  readonly logSubagentStart?: (args: Any) => unknown;
}

interface ParentStateHandler extends TaskResolutionParentState {
  readonly turns: readonly Any[];
  getBlobStore(): Any;
  getPrivacyMode(): Any;
  persistSubagentState(ctx: Context, subagentId: string, subagentType: Any, state: Any): void;
  computeNewStructure(ctx: Context): Promise<Any>;
}

/** The approvals a streaming subagent's interaction queries are answered with, by the query it asks. */
const INTERACTION_QUERY_APPROVALS: ReadonlyMap<string, (id: number) => SlateInteractionResponse> = new Map([
  ["web-search", id => Responses.webSearchApproved(id)],
  ["web-fetch", id => Responses.webFetchApproved(id)],
  ["generate-image", id => Responses.generateImageApproved(id)],
]);

/** The fields that are set among a group of optional values: an absent option stays absent rather than becoming undefined. */
function presentFields(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const present: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) present[key] = value;
  }
  return present;
}

/** What a subagent's streamed interaction reports to: a tool-call delta on the parent's interaction, and approvals. */
class StreamingTaskInteractionListener {
  constructor(private readonly interactionHandler: Any, private readonly toolCallId: string) {}

  async sendUpdate(ctx: Context, update: Any): Promise<void> {
    await this.interactionHandler.emitToolCallDelta(
      ctx,
      this.toolCallId,
      createTaskToolCallDeltaInterop(update),
    );
  }

  async query(_ctx: Context, query: SlateInteractionQuery): Promise<SlateInteractionResponse> {
    const approve = INTERACTION_QUERY_APPROVALS.get(query.kind);
    if (approve == null) throw new Error("Unhandled interaction query type: " + query.kind);
    return approve(query.id);
  }
}

/** The parent's feature flags, with the subagent's own parent marker turned off. */
function subagentFeatureFlags(featureFlags: Any): Any {
  return featureFlags === undefined ? undefined : { ...featureFlags, glassMetaParentAgent: false };
}

/** How a computerUse subagent's user info is shown: no skills or rules, its own surface, no agent transcripts. */
function subagentUserInfoDisplayOptions(baseOptions: Any, isComputerUse: boolean): Any {
  return isComputerUse
    ? { ...baseOptions, displaySkills: false, displayWorkspaceRules: false, computerUseSubagentSurface: true, excludeAgentTranscripts: true }
    : baseOptions;
}

/** A subagent's base prompt, with whatever reminder its configuration adds placed above it. */
function withSubagentReminder(basePrompt: string, reminder: string | undefined): string {
  return reminder ? `<system_reminder>\n${reminder}\n</system_reminder>\n\n${basePrompt}` : basePrompt;
}

/** The agent configuration a subagent runs with: the parent's, changed where a subagent differs. */
function createSubagentAgentConfig(args: {
  readonly baseAgentConfig: Any;
  readonly subagentConfig: TaskSubagentModelConfig;
  readonly overriddenModelId: string;
  readonly subagentInstanceId: string;
}): Any {
  const { baseAgentConfig, subagentConfig, overriddenModelId, subagentInstanceId } = args;
  const runtimeSubagentConfig = subagentConfig as Any;
  return {
    ...baseAgentConfig,
    modelId: overriddenModelId,
    featureFlags: subagentFeatureFlags(baseAgentConfig.featureFlags),
    isCloudMetaAgentParent: false,
    preTurnAssistantNotice: undefined,
    getNamedAgentSelfDocument: undefined,
    userInfoDisplayOptions: subagentUserInfoDisplayOptions(baseAgentConfig.userInfoDisplayOptions, isComputerUseSubagentType(subagentConfig.subagentType)),
    toolsGenerator: (props: Any) => baseAgentConfig.toolsGenerator({
      ...props,
      isCloudMetaAgentParent: false,
      subagentInstanceId,
      subagentConfig,
    }),
    systemPromptGenerator: (props: Any, toolSet: Any) => {
      const subagentPromptProps = { ...props, isCloudMetaAgentParent: false, subagentType: subagentConfig.subagentType };
      const basePrompt = runtimeSubagentConfig.systemPromptOverride
        ? runtimeSubagentConfig.systemPromptOverride(subagentPromptProps, toolSet, { subagentInstanceId, baseSystemPromptGenerator: baseAgentConfig.systemPromptGenerator })
        : baseAgentConfig.systemPromptGenerator(subagentPromptProps, toolSet);
      return withSubagentReminder(basePrompt, runtimeSubagentConfig.systemReminder?.(toolSet)?.trim());
    },
    messageHistoryModifier: runtimeSubagentConfig.messageHistoryModifier ?? undefined,
  };
}

/** The parent state a subagent is resolved against, read through the parent's handler. */
function createParentStateAccessor(stateHandler: ParentStateHandler): TaskResolutionParentState {
  return {
    restoreSubagentState: (ctx, subagentId) => stateHandler.restoreSubagentState(ctx, subagentId),
    resolveSubagentId: (subagentId) => stateHandler.resolveSubagentId?.(subagentId),
    getSubagentIdToResume: (typeName, mode) => stateHandler.getSubagentIdToResume?.(typeName, mode),
    getConversationState: async (ctx) => fromRedactedTaskConversationState(
      await stateHandler.computeNewStructure(ctx),
    ),
  };
}

/** The completion context a server-side subagent reports its iterations with. */
function createCompletionContext(args: {
  readonly resolved: TaskSubagentResolution;
  readonly prepared: SlatePreparedTask;
  readonly rawArgs: SlateTaskRequest;
  readonly meta: ToolExecutionMetaLike;
  readonly parentModelInfo: Any;
  readonly registrySize: number;
  readonly executionStartTime: number;
}): TaskSubagentCompletionContext {
  const { resolved, prepared, rawArgs, meta, parentModelInfo, registrySize, executionStartTime } = args;
  return {
    toolCallId: meta.toolCallId,
    subagentId: resolved.subagentId,
    subagentRequestId: prepared.requestId,
    typeName: resolved.typeName,
    analyticsSubagentType: resolved.analyticsSubagentType,
    parentModelName: parentModelInfo.modelName,
    isParallel: registrySize > 1,
    executionStartTime,
    initialTurnsCount: prepared.startingTurnCount,
    overriddenModelId: resolved.resolvedModelId,
    effectiveReadonly: resolved.effectiveReadonly,
    useAskModeForSubagent: resolved.useAskModeForSubagent,
    ...presentFields({
      resultSuffix: resolved.subagentConfig.resultSuffix,
      selectedContext: prepared.attachmentSelection,
      plugin: resolved.subagentConfig.plugin,
      marketplace: resolved.subagentConfig.marketplace,
      pluginId: resolved.subagentConfig.pluginId,
      marketplaceId: resolved.subagentConfig.marketplaceId,
    }),
    rawArgsPrompt: rawArgs.prompt,
    rawArgsDescription: rawArgs.description ?? "",
  } as TaskSubagentCompletionContext;
}

async function runServerTaskSubagent(args: {
  readonly ctx: Context;
  readonly interactionHandler: Any;
  readonly meta: ToolExecutionMetaLike;
  readonly rawArgs: SlateTaskRequest;
  readonly resolved: TaskSubagentResolution;
  readonly parentState: TaskResolutionParentState;
  readonly stateHandler: ParentStateHandler;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly getTaskToolConfig: (modelId: string, subagentType: Any) => Promise<TaskToolConfig>;
  readonly parentModelInfo: Any;
  readonly options: TaskToolOptions;
}): Promise<SlateTaskResult> {
  const { options, parentModelInfo, getTaskToolConfig, resourceAccessor, stateHandler, parentState, resolved, rawArgs, meta, interactionHandler, ctx } = args;
  const prepared = await prepareTaskSubagent({
    ctx,
    rawArgs,
    resolved,
    meta,
    parentState,
    parentModelInfo,
    resourceAccessor,
    toolName: getTaskToolName(parentModelInfo),
    privacyMode: stateHandler.getPrivacyMode(),
    enableExecuteHookExec: options.enableExecuteHookExec,
    configuredSteps: options.configuredSteps,
    readonlyShellEnabled: options.readonlyShellEnabled,
    attachedMediaUrlProvider: options.attachedMediaUrlProvider,
    videoReviewAttachedMediaUrlProvider: options.videoReviewAttachedMediaUrlProvider,
    ...(options.subagentCredentials !== undefined ? { subagentCredentials: options.subagentCredentials } : {}),
    ...(options.signedUrlVideoMaxBytes !== undefined ? { signedUrlVideoMaxBytes: options.signedUrlVideoMaxBytes } : {}),
    ...(options.inlineVideoMaxBytes !== undefined ? { inlineVideoMaxBytes: options.inlineVideoMaxBytes } : {}),
  });
  // The model a subagent starts on is the one it resolved to, but its config is fetched after that resolution.
  const taskToolConfig = await getTaskToolConfig(prepared.modelId, resolved.subagentConfig.subagentType);
  const subagentRequestId = prepared.requestId;
  const [subagentCtx, cancelSubagent] = ctx.withDetached().withCancel();
  const registry = resourceAccessor.get(subagentRegistryResource);
  registry.register(resolved.subagentId, { cancel: cancelSubagent }, meta.toolCallId);
  const timeoutMs = (resolved.subagentConfig as Any).executionTimeoutMs as number | undefined;
  const timeout = timeoutMs !== undefined && timeoutMs > 0
    ? setTimeout(() => registry.cancel(resolved.subagentId, { intentional: true, reason: `Subagent exceeded execution timeout of ${timeoutMs}ms` }), timeoutMs)
    : undefined;
  const interactionListener = toRedactedInteractionListener(
    new StreamingTaskInteractionListener(interactionHandler, meta.toolCallId),
    stateHandler.getPrivacyMode(),
  );
  const baseAgentConfig = taskToolConfig.agentConfig;
  const agentConfig = createSubagentAgentConfig({
    baseAgentConfig,
    subagentConfig: resolved.subagentConfig,
    overriddenModelId: resolved.resolvedModelId,
    subagentInstanceId: subagentRequestId,
  });
  const agent = new AgentRoot(
    agentConfig,
    taskToolConfig.promptSession,
    interactionListener,
    resolved.effectiveReadonly
      ? createReadonlyResourceAccessor(resourceAccessor, !(options.readonlyShellEnabled === true))
      : resourceAccessor,
    stateHandler.getBlobStore(),
    taskToolConfig.summarizationHandler,
    new NoopConversationActionReceiver<SlateAgentAction>(),
  );
  const completionCtx = createCompletionContext({
    meta,
    rawArgs,
    prepared,
    resolved,
    parentModelInfo,
    executionStartTime: Date.now(),
    registrySize: registry.size,
  });
  const iterState: TaskSubagentIterationState = { loopCount: 0, runStreamCompleted: false, subagentStopCalled: false };
  const completionHookContext = {
    resourceAccessor,
    toolCallId: meta.toolCallId,
    subagentId: resolved.subagentId,
    subagentType: resolved.typeName,
    overriddenModelId: resolved.resolvedModelId,
    parentCtx: ctx,
  };
  const completionDeps = {
    blobStore: stateHandler.getBlobStore(),
    ctx,
    registry,
    hookContext: completionHookContext,
    postToolUseHookInput: buildSlatePreparedTaskHookInput({ typeName: prepared.typeName, request: prepared.request }),
    toolName: getTaskToolName(parentModelInfo),
    configuredSteps: options.configuredSteps ?? [],
    enableTaskToolHooksExec: options.enableExecuteHookExec === true,
  };
  let message = prepared.firstMessage;
  let state: SlateTaskConversationState = normalizePreparedTaskConversationStateInterop(
    prepared.conversationSnapshot,
    stateHandler.getPrivacyMode(),
  );
  const persist = (persistCtx: Context, persistId: string, _type: Any, persistedState: Any) =>
    stateHandler.persistSubagentState(persistCtx, persistId, resolved.subagentConfig.subagentType, persistedState);
  try {
    for (;;) {
      iterState.runStreamCompleted = false;
      const turnsAtStart = iterState.loopCount === 0 ? prepared.startingTurnCount : state!.turns.length;
      try {
        const updatedState = await agent.runStream(
          withParentRequestId(
            subagentCtx.with(requestModelNameKey, resolved.resolvedModelId),
            resolved.parentRequestId,
          ),
          state,
          slateAgentActionFromInterop(
            createTaskUserMessageActionInterop({ message }),
            stateHandler.getPrivacyMode(),
          ),
          [],
          async () => {},
        );
        state = updatedState;
        iterState.runStreamCompleted = true;
      } catch (error) {
        await handleSubagentRunStreamError(error, state!, iterState, completionCtx, completionDeps, subagentCtx.canceled, registry.lastAbortOptions);
      }
      const iteration = await processSubagentIterationSuccess(
        state!,
        turnsAtStart,
        iterState,
        completionCtx,
        completionDeps,
        persist,
        resolved.subagentConfig.subagentType,
      );
      if (!iteration.shouldContinue) {
        return iteration.finalResult ?? createSlateTaskErrorResult("Subagent completed without a result");
      }
      message = iteration.nextAction as typeof message;
    }
  } catch (error) {
    return await handleSubagentExecutionError(error, state, iterState, completionCtx, completionDeps, subagentCtx.canceled, registry.lastAbortOptions);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function createTaskTool(
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  getTaskToolConfig: (modelId: string, subagentType: Any) => Promise<TaskToolConfig>,
  parentModelInfo: Any,
  stateHandler: ParentStateHandler,
  subagentConfigs: readonly TaskSubagentModelConfig[],
  options: TaskToolOptions,
): Record<string, unknown> {
  const canUseClientSideSubagent = options.useClientSideSubagent === true && options.requireServerSideSubagent !== true;
  const includeRunInBackground = canUseClientSideSubagent || options.enableCloudAsyncSubagents === true;
  const allowResumeSelfFork = (canUseClientSideSubagent || options.enableCloudAsyncSubagents === true) && options.allowResumeSelfFork === true;
  const enableSubagentInterrupt = canUseClientSideSubagent && options.enableSubagentInterrupt === true;
  const defaultRunInBackground = includeRunInBackground && options.defaultSubagentsRunInBackground === true;
  const notificationHints = options.enableJobCompletionNotifications === true && includeRunInBackground;
  const toolName = getTaskToolName(parentModelInfo);
  const schemaSubagentConfigs: TaskSchemaSubagentConfig[] = subagentConfigs.map(config => ({
    typeName: slateSubagentTypeName(config.subagentType),
    resumeModeOverride: config.resumeModeOverride,
  }));
  const { schemaTowardsModel, schemaForParsing, defaultSubagentTypeName } = buildTaskParameterSchemas(schemaSubagentConfigs, {
    subagentModels: options.subagentModels,
    allowCustomModelId: options.allowCustomModelId === true,
    useClientSideSubagent: canUseClientSideSubagent,
    subagentModelsInUserInfo: options.subagentModelsInUserInfo === true,
    subagentInheritGuidance: options.subagentInheritGuidance === true,
    includeRunInBackgroundInTaskSchema: includeRunInBackground,
    defaultSubagentsRunInBackground: defaultRunInBackground,
    enableSubagentInterrupt,
    allowResumeSelfFork,
    cloudSubagentTargeting: options.cloudSubagentTargeting === true,
    environmentParamForSubagent: options.environmentParamForSubagent === true,
    requestedEnvironmentBuildParamForSubagent: options.requestedEnvironmentBuildParamForSubagent === true,
    enableMultitaskMode: options.enableMultitaskMode === true,
    taskToolNotificationHintsEnabled: notificationHints,
    hideAsyncSubagentTaskNotifications: options.hideAsyncSubagentTaskNotifications === true,
    enableAgentChatLinks: options.enableAgentChatLinks === true,
  });

  /** The resolution options the tool's execute path resolves a subagent with. */
  const executeResolutionOptions = () => ({
    subagentModels: options.subagentModels,
    parentMaxMode: options.parentMaxMode === true,
    isModelBlocked: options.isModelBlocked ?? (() => false),
    isModelValid: options.isModelValid ?? (() => true),
    compareModelCosts: options.compareModelCosts ?? (() => 0),
    subagentModelForcePolicy: options.subagentModelForcePolicy ?? SubagentModelForcePolicy.None,
    ...(options.forceModelId !== undefined ? { forceModelId: options.forceModelId } : {}),
    ...(options.requiresMaxMode !== undefined ? { requiresMaxMode: options.requiresMaxMode } : {}),
    ...(options.parentRequestedModelName !== undefined ? { parentRequestedModelName: options.parentRequestedModelName } : {}),
    ...(options.parentModelParameters !== undefined ? { parentModelParameters: options.parentModelParameters } : {}),
    ...(options.enableExploreParentModelInheritance !== undefined ? { enableExploreParentModelInheritance: options.enableExploreParentModelInheritance } : {}),
  });

  /** The resolution options the prepare path resolves a subagent with: it has no model to request or cap yet. */
  const prepareResolutionOptions = () => ({
    isModelBlocked: options.isModelBlocked ?? (() => false),
    isModelValid: options.isModelValid ?? (() => true),
    compareModelCosts: options.compareModelCosts ?? (() => 0),
    subagentModels: options.subagentModels,
    parentMaxMode: options.parentMaxMode === true,
    subagentModelForcePolicy: options.subagentModelForcePolicy ?? SubagentModelForcePolicy.None,
    ...(options.forceModelId !== undefined ? { forceModelId: options.forceModelId } : {}),
  });

  const descriptionCache = new WeakMap<object, Map<boolean, string>>();
  const description = (props: Any, descriptionOptions: Any): string => {
    const catalogsInUserInfo = options.subagentModelsInUserInfo === true || !isPromptVisibleDescription(descriptionOptions);
    let byPlacement = descriptionCache.get(props);
    if (byPlacement?.has(catalogsInUserInfo)) return byPlacement.get(catalogsInUserInfo)!;
    const parts = buildTaskToolDescriptionParts({
      configs: schemaSubagentConfigs,
      defaultResumeMode: "DEFAULT",
      toolLabel: toolName,
      useClientSideSubagent: canUseClientSideSubagent,
      catalogsInUserInfo,
      includeExploreSubagent: options.includeExploreSubagent === true,
      enableSubagentInterrupt,
      allowResumeSelfFork,
      subagentModels: options.subagentModels,
      subagentModelsInUserInfo: options.subagentModelsInUserInfo === true,
      subagentInheritGuidance: options.subagentInheritGuidance === true,
      taskToolNotificationHintsEnabled: notificationHints,
      hideAsyncSubagentTaskNotifications: options.hideAsyncSubagentTaskNotifications === true,
      enableAgentChatLinks: options.enableAgentChatLinks === true,
      readToolName: props.allTools?.READ?.name,
      globToolName: props.allTools?.GLOB?.name,
      ...(options.subagentExperimentGroup !== undefined ? { subagentExperimentGroup: options.subagentExperimentGroup } : {}),
    });
    const full = parts.fullDescription;
    if (byPlacement === undefined) { byPlacement = new Map(); descriptionCache.set(props, byPlacement); }
    byPlacement.set(catalogsInUserInfo, full);
    return full;
  };

  /** The parse failure for a set of invalid arguments, one line per argument. */
  const invalidArguments = (errors: readonly { readonly path: readonly (string | number)[]; readonly message: string }[]): Error => {
    const lines: string[] = [];
    for (const error of errors) lines.push((error.path.length > 0 ? error.path.join(".") : "argument") + ": " + error.message);
    return new Error("Invalid arguments:\n" + lines.join("\n"));
  };

  const parse = (raw: Any): SlateTaskRequest => {
    let parsedJson: Any;
    try { parsedJson = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch (error) { throw new Error(`Invalid arguments:\nargument: ${error instanceof Error ? error.message : "Failed to parse arguments"}`); }
    const result = schemaForParsing.safeParse(parsedJson);
    if (!result.success) throw invalidArguments(result.error.errors);
    const request = slateTaskRequestFromModelArgumentsInterop(result.data, { defaultSubagentTypeName });
    assertSlateTaskPlacementIsUnambiguous(request);
    assertSlateTaskCloudFieldsAllowed(request);
    if (request.resume?.trim().toLowerCase() === "self" && !allowResumeSelfFork) throw new Error('Invalid arguments:\nresume="self" is not available for this Task tool.');
    return request;
  };

  /** What the client-side launch carries besides the resolved call: credentials, media and interrupt wiring. */
  const clientLaunchOptions = () => ({
    enableSubagentInterrupt,
    attachedMediaUrlProvider: options.attachedMediaUrlProvider,
    videoReviewAttachedMediaUrlProvider: options.videoReviewAttachedMediaUrlProvider,
    ...(options.subagentCredentials !== undefined ? { subagentCredentials: options.subagentCredentials } : {}),
    ...(options.trustedVideoAttachmentRoots !== undefined ? { trustedVideoAttachmentRoots: options.trustedVideoAttachmentRoots } : {}),
    ...(options.inlineVideoMaxBytes !== undefined ? { inlineVideoMaxBytes: options.inlineVideoMaxBytes } : {}),
    ...(options.signedUrlVideoMaxBytes !== undefined ? { signedUrlVideoMaxBytes: options.signedUrlVideoMaxBytes } : {}),
  });

  /** Resolves and prepares a subagent launch, before a model is fetched for it. */
  const prepareLaunch = async (ctx: Context, rawArgs: Any, meta: ToolExecutionMetaLike) => {
    const parsed = parse(rawArgs);
    const parentState = createParentStateAccessor(stateHandler);
    const resolved = await resolveTaskSubagentConfig({
      parentModelInfo,
      subagentConfigs,
      parentState,
      meta,
      rawArgs: parsed,
      ctx,
      options: prepareResolutionOptions(),
    });
    const prepareOptions = {
      resolved,
      ctx,
      rawArgs: parsed,
      meta,
      parentState,
      resourceAccessor,
      parentModelInfo,
      toolName,
      privacyMode: stateHandler.getPrivacyMode(),
      ...(options.readonlyShellEnabled !== undefined ? { readonlyShellEnabled: options.readonlyShellEnabled } : {}),
    };
    return await prepareTaskSubagent(prepareOptions);
  };

  /** What the rendered result of a task run says, and whether it is an error. */
  const renderResult = (result: TaskResultInterop) => {
    const slateResult = fromInteropTaskResultInterop(result)
    return createStringResult(
      renderTaskResultToString(slateResult, {
        enableJobCompletionNotifications: notificationHints,
        ...(options.hideAsyncSubagentTaskNotifications !== undefined ? { hideAsyncSubagentTaskNotifications: options.hideAsyncSubagentTaskNotifications } : {}),
        ...(options.enableAgentChatLinks !== undefined ? { enableAgentChatLinks: options.enableAgentChatLinks } : {}),
      }),
      slateResult.kind === "error",
    )
  }

  const execute = async (ctx: Context, interactionHandler: Any, modelArgs: Any, meta: ToolExecutionMetaLike): Promise<TaskResultInterop> => {
    const rawArgs = parse(modelArgs);
    const parentState = createParentStateAccessor(stateHandler);
    const resolved = await resolveTaskSubagentConfig({
      parentModelInfo,
      subagentConfigs,
      parentState,
      meta,
      rawArgs,
      ctx,
      options: executeResolutionOptions(),
    });
    if (canUseClientSideSubagent) {
      const result = await executeClientSideTaskSubagent({
        ctx,
        toolCallId: meta.toolCallId,
        rawArgs,
        resolved,
        resourceAccessor,
        stateHandler,
        parentModelName: parentModelInfo.modelName,
        ...clientLaunchOptions(),
        interrupt: (rawArgs as Any).interrupt,
        contextInjectionSignal: (meta as Any).contextInjectionSignal,
      })
      return toInteropTaskResultInterop(result)
    }
    const serverLaunch = { options, parentModelInfo, getTaskToolConfig, resourceAccessor, stateHandler, parentState, resolved, rawArgs, meta, interactionHandler, ctx };
    try {
      return toInteropTaskResultInterop(await runServerTaskSubagent(serverLaunch));
    } catch (error) {
      return toInteropTaskResultInterop(createSlateTaskErrorResult(error));
    }
  };

  return createZodAgentTool("TASK", {
    name: toolName,
    descriptionGenerator: description,
    parameters: schemaTowardsModel,
    prepareSubagent: prepareLaunch,
    // The wrapper hands the tool's arguments and the orchestrator over untyped, since a tool does not hold the
    // orchestrator's types; the callback's own signature is what it is written against.
    execute: withSafeParsedArgs(schemaForParsing, execute as unknown as Parameters<typeof withSafeParsedArgs>[1], createTaskToolCallInterop()),
    render: async (_ctx: Context, result: TaskResultInterop) => renderResult(result),
    serializeError: serializeTaskErrorInterop,
  });
}
