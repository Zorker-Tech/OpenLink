/**
 * Starting a conversation from a plan.
 *
 * The plan the user approved is read from its file, the turn is set up around it — the plan file's path and
 * content, the request context it was planned under, the rules and the tools the plan needs — and the step
 * loop takes it from there. A plan arrives as the first message of a conversation, so the user info that
 * message carries is the only one the session will ever have; when the session has moved on since it was
 * written, the info is re-rendered rather than left to describe a session that no longer exists. What the
 * session has moved on from is read back out of that first message: the request context completeness, the
 * summarization epoch, and whether the cloud procedure was omitted.
 */
import grayMatter from "gray-matter";
import { randomUUID } from "node:crypto";
import {
  createExecutePlanPlanFileIO,
  createPlanExecutionMessage,
  createPlanRegistryEntry,
  decodePlanRequestContext,
  toInteropAgentMode,
  toSlatePlanTodos,
} from "../../../adapters/interop/agent/execute-plan-action-adapter.ts";
import { unavailablePlanDocumentUri } from "../../../adapters/interop/agent/plan-file-uri-adapter.ts";
import { projectBackgroundAgentSource } from "../../../adapters/interop/agent/background-agent-source-adapter.ts";
import type {
  PlanExecutionMode,
  PlanExecutionRequest,
} from "./execute-plan-contracts.ts";
import { isSlateExecutePlanActionPayload, slateModeForPlanExecutionMode } from "./execute-plan-contracts.ts";
import { collectPlanTodoDrafts } from "./execute-plan-frontmatter.ts";
import { fromRedactedCoreMessage, toRedactedCoreMessages } from "../../redaction/message-redaction.ts";
import { createRedactedString } from "../../redaction/create.ts";
import { DataClassification, PrivacyCapability } from "../../redaction/classification.ts";
import { createLogger } from "../../context/logging.ts";
import { createSpan } from "../../context/telemetry.ts";
import { FileOperationLockManager } from "../tools/core/file-operation-locks.ts";
import { extractToolInfo } from "../prompts/tool-info.ts";
import { getBrowserToolNames } from "../browser-tools.ts";
import { getAllRules } from "./common.ts";
import { buildRequestContextOptions } from "./meta-agent-notes.ts";
import { buildUserInfoAgentNotesProps } from "../../../adapters/interop/agent/meta-agent-notes-adapter.ts";
import { adaptInteropCloudTestingModelProfile } from "../../../adapters/interop/agent/testing-prompt-profile-adapter.ts";
import { resolveRequestContext } from "../utils/request-context.ts";
import { isProjectWorkspaceConversation } from "../configs/project-workspace-mcp-tools.ts";
import {
  resolveProjectConversationContextFromInterop,
} from "../../../adapters/interop/agent/project-conversation-adapter.ts";
import { shouldOmitCloudWorkerProcedure } from "../utils/project-conversation.ts";
import { getNamedAgentSessionPromptContext, isNamedAgentHomePromptSession } from "../prompts/cloud-meta-agent/named-agent-sessions.ts";
import { AgentType } from "../utils/agent-config.ts";
import { getCloudTestingSectionsPlacement } from "../prompts/cloud-testing-sections.ts";
import { renderInteropUserInfo as UserInfo } from "../../../adapters/interop/agent/user-info-input-adapter.ts";
import { withToolSetMcpSnapshot } from "../utils/mcp-meta-tool-options.ts";
import { getMcpMetaToolOptionsWithUserDefinedTools } from "../../../adapters/interop/agent/mcp-user-defined-tools-adapter.ts";
import { getRequestContextCompleteness, shouldRerenderUserInfoAfterSummarization, shouldRerenderUserInfoForRequestContextRecovery, parseRequestContextCompletenessMetadata, parseUserInfoSummarizationEpochMetadata, userInfoMatchesAvailableSubagentModels, userInfoMatchesAvailableSubagentTypes, userInfoMatchesDynamicToolSnapshot } from "../prompts/user-info-rerender.ts";
import { getConversationId, getRequestId } from "../utils/request-scope.ts";
import { getAgentEventTracker } from "../utils/event-tracking.ts";
import { getFirstUserInfoCloudTestingSectionsPlacement } from "../prompts/user-info-preparation.ts";
import { resolvePlanFilePath as resolvePlanFilePathHelper } from "./execute-plan-plan-file.ts";
import { AbstractUserMessageActionHandler } from "./user-message-action/abstract-user-message-action-handler.ts";

type Any = any;

const logger64 = createLogger("@slate/agent:execute-plan");

function userMessagePlainText(message: Any): string | undefined {
  const content = message.content;
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.filter((part: Any) => part.type === "text").map((part: Any) => part.text).join("\n");
  return text.length > 0 ? text : undefined;
}

function getRequestContextCompletenessAny(requestContext: Any): Any {
  return getRequestContextCompleteness(requestContext);
}

export class ExecutePlanActionHandler extends AbstractUserMessageActionHandler {
  shouldRerenderUserInfo(priorMessages: readonly Any[], stateHandler: Any, options: Any): boolean {
    if (priorMessages.length === 0) return false;
    const firstMsg = priorMessages[0];
    if (firstMsg.role !== "user") return false;
    const plainFirst = fromRedactedCoreMessage(firstMsg, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    const contentStr = userMessagePlainText(plainFirst);
    if (contentStr?.includes("<user_info>") !== true) return false;
    return stateHandler.hasAgentTypeChangedFromPersistedState() ||
      !userInfoMatchesAvailableSubagentModels(contentStr, options.availableSubagentModelsDescription) ||
      !userInfoMatchesAvailableSubagentTypes(contentStr, options.availableSubagentTypesDescription) ||
      !userInfoMatchesDynamicToolSnapshot(contentStr, options.mcpMetaToolOptions);
  }

  getFirstUserInfoRequestContextCompleteness(priorMessages: readonly Any[]): Any {
    const firstMsg = priorMessages[0];
    if (firstMsg?.role !== "user") return undefined;
    return parseRequestContextCompletenessMetadata(firstMsg.providerOptions?.cursor?.requestContextCompleteness);
  }

  getFirstUserInfoSummarizationEpoch(priorMessages: readonly Any[]): Any {
    const firstMsg = priorMessages[0];
    if (firstMsg?.role !== "user") return undefined;
    return parseUserInfoSummarizationEpochMetadata(firstMsg.providerOptions?.cursor?.userInfoSummarizationEpoch);
  }

  getFirstUserInfoOmitCloudWorkerProcedure(priorMessages: readonly Any[]): boolean {
    return priorMessages[0]?.providerOptions?.cursor?.omitCloudWorkerProcedure === true;
  }

  async resolvePlanFilePath(ctx: Any, requestContext: Any, action: PlanExecutionRequest, planFileContent: string): Promise<Any> {
    const planFileResourceAccessor: Any = this.resourceAccessor;
    return resolvePlanFilePathHelper(
      ctx,
      requestContext,
      createExecutePlanPlanFileIO(planFileResourceAccessor),
      action,
      planFileContent,
    );
  }

  async initializeConversation(ctx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any): Promise<Any> {
    const configAny: Any = this.config;
    const promptBackgroundAgentSource = projectBackgroundAgentSource(configAny.backgroundAgentSource);
    const namedAgentSessionProps = { ...configAny, backgroundAgentSource: promptBackgroundAgentSource };
    if (!isSlateExecutePlanActionPayload(action)) throw new TypeError("Slate execute-plan action payload is invalid");
    const planAction: PlanExecutionRequest = action;
    const executionMode: PlanExecutionMode = planAction.mode;
    const legacyRequestContext = planAction.compatibility?.requestContext;
    const interopMode = toInteropAgentMode(executionMode, planAction.compatibility?.legacyModeCode);
    const slateMode = slateModeForPlanExecutionMode(executionMode);
    const { requestContext, provenance: requestContextProvenance } = await resolveRequestContext({
      parentCtx: ctx,
      ...(legacyRequestContext !== undefined ? { maybeRequestContext: decodePlanRequestContext(legacyRequestContext) } : {}),
      resources: this.resourceAccessor,
      options: buildRequestContextOptions(configAny),
    });
    const unredResolvedPlanContent = planAction.planText ?? (stateHandler.plan ? (await stateHandler.plan.get(ctx)).content : undefined);
    let planMarksProject = false;
    try {
      planMarksProject = unredResolvedPlanContent !== undefined && grayMatter(unredResolvedPlanContent).data.isProject === true;
    } catch {
    }
    let isRootProject = configAny.agentType === AgentType.IDE && await isProjectWorkspaceConversation(ctx, stateHandler);
    isRootProject ||= configAny.agentType === AgentType.IDE && planMarksProject;
    const projectConversationContext = await resolveProjectConversationContextFromInterop(ctx, stateHandler);
    const omitCloudWorkerProcedure = shouldOmitCloudWorkerProcedure({
      gateEnabled: configAny.featureFlags?.projectRootCoordinatorPrompt === true,
      agentType: configAny.agentType,
      mode: slateMode,
      useLocalAgentPrompting: configAny.useLocalAgentPrompting === true,
      isNamedAgentSession: getNamedAgentSessionPromptContext(configAny) !== undefined || isNamedAgentHomePromptSession(namedAgentSessionProps),
      isRootProject: projectConversationContext.hasProjectBoundary ? projectConversationContext.isRootProject : planMarksProject,
    });
    const rules = getAllRules(requestContext, configAny.nonFileRules, configAny.featureFlags);
    const mergedMcpTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
    const toolSetHandle = configAny.toolsGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler,
      agentSessionId: configAny.agentSessionId,
      mcpTools: mergedMcpTools,
      repositoryInfos: requestContext.repositoryInfo,
      blobStore: stateHandler.getBlobStore(),
      mode: slateMode,
      loggingContext: ctx,
      requestContext,
      fileOperationLockManager: new FileOperationLockManager(),
      smartModeClassifierMode: configAny.smartModeClassifierMode,
      smartModeClassifierShadowMode: configAny.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: configAny.autoRejectFirstAskQuestion,
    });
    const toolInfo: Any = extractToolInfo(toolSetHandle);
    const priorMessages = rootPromptExecutor.getMessages().filter((message: Any) => message.role !== "system");
    const hasExistingNonSystemMessages = priorMessages.length > 0;
    const firstUserInfoRequestContextCompleteness = this.getFirstUserInfoRequestContextCompleteness(priorMessages);
    const requestContextCompleteness = getRequestContextCompletenessAny(requestContext);
    const userInfoMcpMetaToolOptions = withToolSetMcpSnapshot(getMcpMetaToolOptionsWithUserDefinedTools(requestContext.mcpMetaToolOptions, mergedMcpTools), toolSetHandle);
    const needsUserInfoRerender = this.shouldRerenderUserInfo(priorMessages, stateHandler, {
      availableSubagentModelsDescription: toolInfo.availableSubagentModelsDescription,
      availableSubagentTypesDescription: toolInfo.availableSubagentTypesDescription,
      mcpMetaToolOptions: userInfoMcpMetaToolOptions,
    });
    const needsRequestContextRecoveryRerender = configAny.featureFlags?.rerenderUserInfoOnRequestContextRecovery === true && shouldRerenderUserInfoForRequestContextRecovery({ previousCompleteness: firstUserInfoRequestContextCompleteness, currentCompleteness: requestContextCompleteness });
    const currentSummarizationEpoch = stateHandler.summaryArchives.length;
    const needsSummarizationRerender = configAny.featureFlags?.rerenderUserInfoOnSummarization === true && shouldRerenderUserInfoAfterSummarization({ previousEpoch: this.getFirstUserInfoSummarizationEpoch(priorMessages), currentEpoch: currentSummarizationEpoch });
    const priorUserInfoCloudTestingSectionsPlacement = getFirstUserInfoCloudTestingSectionsPlacement(priorMessages);
    const userInfoCloudTestingSectionsPlacement = getCloudTestingSectionsPlacement({
      modelInfo: adaptInteropCloudTestingModelProfile(configAny.modelInfo),
      enableComposer2IntelligentTestingPromptSection: configAny.enableComposer2IntelligentTestingPromptSection,
      backgroundAgentSource: promptBackgroundAgentSource,
      agentType: configAny.agentType,
      enableCloudTesting: configAny.enableCloudTesting,
      featureFlags: configAny.featureFlags,
      namedAgentSessionKind: configAny.namedAgentSessionKind,
      isCloudMetaAgentParent: configAny.isCloudMetaAgentParent,
      priorUserInfoCloudTestingSectionsPlacement,
    });
    const needsCloudTestingPlacementRerender = priorUserInfoCloudTestingSectionsPlacement === "system_prompt" && userInfoCloudTestingSectionsPlacement === "user_info";
    const needsOmitCloudWorkerProcedureRerender = hasExistingNonSystemMessages && this.getFirstUserInfoOmitCloudWorkerProcedure(priorMessages) !== omitCloudWorkerProcedure;
    const newMessages: Any[] = [{
      role: "system",
      content: configAny.systemPromptGenerator({ requestContext, cursorRules: rules, env: requestContext.env, cloudRule: requestContext.cloudRule ?? undefined, mode: slateMode, omitCloudWorkerProcedure, priorUserInfoCloudTestingSectionsPlacement }, toolSetHandle),
    }];
    let didReplaceUserInfo = false;
    if ((!hasExistingNonSystemMessages || needsUserInfoRerender || needsRequestContextRecoveryRerender || needsSummarizationRerender || needsCloudTestingPlacementRerender || needsOmitCloudWorkerProcedureRerender) && !configAny.userInfoDisplayOptions?.disable) {
      didReplaceUserInfo = hasExistingNonSystemMessages;
      if (didReplaceUserInfo) {
        const reasons: string[] = [];
        if (needsUserInfoRerender) reasons.push("agent_type_change");
        if (needsRequestContextRecoveryRerender) reasons.push("request_context_recovery");
        if (needsSummarizationRerender) reasons.push("summarization_epoch_advanced");
        if (needsCloudTestingPlacementRerender) reasons.push("cloud_testing_placement_recovery");
        if (needsOmitCloudWorkerProcedureRerender) reasons.push("omit_cloud_worker_procedure_change");
        logger64.info(ctx, "agent.user_info.rerendered", { reasons });
      }
      newMessages.push({
        role: "user",
        content: UserInfo({
          cursorRules: rules,
          agentSkills: requestContext.agentSkills,
          env: requestContext.env,
          cloudRule: requestContext.cloudRule ?? undefined,
          gitRepos: requestContext.gitRepos,
          gitRepoInfoComplete: requestContext.gitRepoInfoComplete,
          isRootProject,
          omitCloudWorkerProcedure,
          isLargeContextModel: stateHandler.usesLargeContextTreatment(),
          displayOptions: configAny.userInfoDisplayOptions,
          mcpInfoComplete: requestContext.mcpInfoComplete,
          mcpInstructions: requestContext.mcpInstructions,
          mcpFileSystemOptions: requestContext.mcpFileSystemOptions,
          mcpMetaToolOptions: userInfoMcpMetaToolOptions,
          userIntentSummary: requestContext.userIntentSummary,
          featureFlags: configAny.featureFlags,
          enableFilterEditToolsInAskMode: configAny.enableFilterEditToolsInAskMode,
          skipMcpInstructions: (requestContext.mcpFileSystemOptions?.enabled ?? false) || (userInfoMcpMetaToolOptions?.enabled ?? false),
          hooksAdditionalContext: requestContext.hooksAdditionalContext,
          automationInstructions: configAny.automationInstructions,
          ...(configAny.enableTerminalFiles !== false ? { terminalsFolder: requestContext.env?.terminalsFolder } : {}),
          ...buildUserInfoAgentNotesProps(configAny, interopMode, requestContext.env),
          designatedBranches: configAny.designatedBranches,
          branchPrefix: configAny.branchPrefix,
          branchSuffix: configAny.branchSuffix,
          preferCurrentBranchInMultiPrMode: configAny.preferCurrentBranchInMultiPrMode,
          toolInfo,
          browserTools: getBrowserToolNames(mcpTools),
          agentType: configAny.agentType,
          backgroundAgentSource: configAny.backgroundAgentSource,
          namedAgentSessionKind: configAny.namedAgentSessionKind,
          enableCloudTesting: configAny.enableCloudTesting,
          useLocalAgentPrompting: configAny.useLocalAgentPrompting,
          isRepoless: configAny.isRepoless,
          modelInfo: configAny.modelInfo,
          agentTokenLimit: configAny.agentTokenLimit,
          enableComposer2IntelligentTestingPromptSection: configAny.enableComposer2IntelligentTestingPromptSection,
          priorUserInfoCloudTestingSectionsPlacement,
        }),
        providerOptions: { cursor: { requestContextCompleteness, userInfoSummarizationEpoch: currentSummarizationEpoch, omitCloudWorkerProcedure, ...(userInfoCloudTestingSectionsPlacement !== undefined ? { composer2CloudTestingSectionsPlacement: userInfoCloudTestingSectionsPlacement } : {}) } },
      });
    }
    const effectivePriorMessages = didReplaceUserInfo ? priorMessages.slice(1) : priorMessages;
    rootPromptExecutor.clearMessages();
    rootPromptExecutor.appendMessages(toRedactedCoreMessages(newMessages, stateHandler.getPrivacyMode()));
    rootPromptExecutor.appendMessages(effectivePriorMessages);
    if (!unredResolvedPlanContent) throw new Error("No plan content available for ExecutePlanAction (missing state and planFileContent)");
    if (stateHandler.todos.length === 0) {
      const todos = toSlatePlanTodos(
        collectPlanTodoDrafts(unredResolvedPlanContent),
        stateHandler.getPrivacyMode(),
      );
      if (todos.length > 0) stateHandler.setTodos(todos);
    }
    const { planFilePath, recreatedPlanFilePath, shouldUpsertPlanRegistryEntry, availability: planFileAvailability } = await this.resolvePlanFilePath(ctx, requestContext, planAction, unredResolvedPlanContent);
    if (requestContext.env?.artifactsFolder !== undefined && planAction.id && planFilePath && shouldUpsertPlanRegistryEntry) stateHandler.upsertPlanEntry(createPlanRegistryEntry(planAction.id, planFilePath));
    const resolvedPlanContent = createRedactedString(unredResolvedPlanContent, DataClassification.CODE, "plan", planAction.privacyMode ?? stateHandler.getPrivacyMode());
    if (stateHandler.plan) stateHandler.setPlan(undefined);
    const planTitle = resolvedPlanContent.safeTransform((content: string) => content.match(/^#\s*(.+)$/m)?.[1]?.trim() ?? "Plan");
    const planFileNote = planFileAvailability === "unavailable" ? "\n\nThe plan file is not available on disk in this environment. The attached plan content above is complete, so work from it directly and do not try to read the plan from a file." : recreatedPlanFilePath !== undefined ? `\n\nThe plan has been moved to ${recreatedPlanFilePath}` : "";
    const planInstruction = planTitle.safeTransform((title: string) => `${title}\n\nImplement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.${planFileNote}\n\nTo-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.`);
    const planFileContent = resolvedPlanContent.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    const selectedPlanPath = (planFileAvailability === "unavailable" ? undefined : planFilePath) ?? planAction.sourceUri ?? unavailablePlanDocumentUri();
    const messageId = planAction.messageId ?? randomUUID();
    const { slateUserMessage, listenerUpdate } = createPlanExecutionMessage({
      text: planInstruction.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      messageId,
      planContent: planFileContent,
      planPath: selectedPlanPath,
      planTitle: planTitle.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      executionMode,
      ...(planAction.compatibility?.legacyModeCode === undefined ? {} : { legacyModeCode: planAction.compatibility.legacyModeCode }),
      rootProject: isRootProject,
      planId: planAction.id,
      listenerPrivacyMode: stateHandler.getPrivacyMode(),
    });
    await this.interactionListener.sendUpdate(ctx, listenerUpdate);
    const turn = await stateHandler.createAgentTurn(ctx, slateUserMessage, requestContext, configAny, this.resourceAccessor);
    stateHandler.setMode(slateMode);
    return { turn, mergedMcpTools, requestContext, requestContextProvenance, planId: planAction.id };
  }

  async handle(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    const configAny: Any = this.config;
    using span = createSpan(parentCtx.withName("ExecutePlanActionHandler.handle"));
    const ctx = span.ctx;
    const { turn, mergedMcpTools, requestContext, planId } = await this.initializeConversation(ctx, action, rootPromptExecutor, stateHandler, mcpTools);
    const planExecutionStartTime = performance.now();
    const initialTurnCount = stateHandler.turns.length;
    const initialTodos = await Promise.all(stateHandler.todos.map((todoRef: Any) => todoRef.get(ctx)));
    const initialTodoIds = initialTodos.map((todo: Any) => todo.id);
    await this.runTurnLoop(ctx, rootPromptExecutor, stateHandler, turn, configAny.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    const finalTodos = await Promise.all(stateHandler.todos.map((todoRef: Any) => todoRef.get(ctx)));
    const finalStatusByTodoId = new Map(finalTodos.map((todo: Any) => [todo.id, todo.status]));
    getAgentEventTracker(ctx).trackPlanModeModelFinished(ctx, { durationInMode: Math.max(0, performance.now() - planExecutionStartTime), todosProposed: initialTodoIds.length, todosCompleted: initialTodoIds.filter((todoId: string) => finalStatusByTodoId.get(todoId) === "completed").length, userMessagesDuringExecution: Math.max(0, stateHandler.turns.length - initialTurnCount), modelName: configAny.modelId, requestId: getRequestId(ctx), conversationId: getConversationId(ctx), planId });
    return await stateHandler.computeNewStructure(ctx);
  }

  async handleSingleStep(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    const configAny: Any = this.config;
    using span = createSpan(parentCtx.withName("ExecutePlanActionHandler.handleSingleStep"));
    const ctx = span.ctx;
    const { turn, mergedMcpTools, requestContext } = await this.initializeConversation(ctx, action, rootPromptExecutor, stateHandler, mcpTools);
    const { hasToolCall } = await this.runSingleStep(ctx, rootPromptExecutor, stateHandler, turn, configAny.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(ctx), hasToolCall };
  }

  async handleModelStep(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    const configAny: Any = this.config;
    using span = createSpan(parentCtx.withName("ExecutePlanActionHandler.handleModelStep"));
    const ctx = span.ctx;
    const { turn, mergedMcpTools, requestContext, requestContextProvenance } = await this.initializeConversation(ctx, action, rootPromptExecutor, stateHandler, mcpTools);
    const { toolCallDescriptors, splitStepData } = await this.runModelStep(ctx, rootPromptExecutor, stateHandler, turn, configAny.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(ctx), toolCallDescriptors, splitStepData: { ...splitStepData, requestContextProvenance } };
  }
}
