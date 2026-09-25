/**
 * A user message becoming a turn.
 *
 * The message arrives with the request context it was sent under, and this is what turns that into a turn:
 * the conversation is initialized — the system prompt, the user info, the rules, the tools and the request
 * context the turn will run with — the message is written into the conversation as the turn's own user
 * message, and the step loop takes it from there. A user info is re-rendered only when it has to be, since
 * it is the most expensive part of the prompt and the least likely to have changed. An action that carries
 * no message at all is refused rather than turned into an empty turn.
 */
import { AgentMode } from "../../../proto/generated/agent/v1/agent_pb.ts";
import { fromRedactedRequestContext } from "../../../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts";
import { fromRedactedUserMessage as fromRedactedUserMessage2 } from "../../../redacted-protos/generated/agent/v1/agent_redacted.ts";
import { PrivacyCapability } from "../../../redaction/classification.ts";
import { fromRedactedCoreMessage, toRedactedCoreMessages } from "../../../redaction/message-redaction.ts";
import { createLogger } from "../../../context/logging.ts";
import { createSpan } from "../../../context/telemetry.ts";
import { createHistogram } from "../../../metrics/index.ts";
import { RedactedUpdates } from "../../../agent-core/redacted-interaction-updates.ts";
import { FileOperationLockManager } from "../../tools/core/file-operation-locks.ts";
import { extractToolInfo } from "../../prompts/tool-info.ts";
import { getBrowserToolNames } from "../../browser-tools.ts";
import { resolveCurrentTurnMode } from "../../mode-processing.ts";
import { shouldOmitCloudWorkerProcedure, isRootProjectUserMessage } from "../../utils/project-conversation.ts";
import {
  getNamedAgentSessionPromptContext,
  isNamedAgentHomePromptSession,
  renderCloudMetaParentUserTurnReminder,
  renderNamedAgentHomeUserTurnReminder,
} from "../../prompts/cloud-meta-agent/named-agent-sessions.ts";
import { buildRequestContextOptions, buildUserInfoAgentNotesProps } from "../meta-agent-notes.ts";
import { resolveRequestContext } from "../../utils/request-context.ts";
import { getMcpMetaToolSnapshotToolNames, withToolSetMcpSnapshot } from "../../utils/mcp-meta-tool-options.ts";
import { getMcpMetaToolOptionsWithUserDefinedTools } from "../../utils/mcp-user-defined-tools.ts";
import { getRequiredToolName, getExecutableTools } from "../../tools/tool-execution.ts";
import { getAllRules } from "../common.ts";
import { getCloudTestingSectionsPlacement } from "../../prompts/cloud-testing-sections.ts";
import { getGeneratedUserRulesForModel } from "../../prompts/custom-user-rules.ts";
import { UserInfo } from "../../prompts/user-info.ts";
import { renderMultitaskModeEnterUserReminder } from "../../prompts/multitask-mode-reminders.ts";
import { usesPersistenceInstructions } from "../../prompts/persistence-instructions.ts";
import { getTaskToolName } from "../../tools/task-tool-name.ts";
import { extractNamedAgentSelfDocumentBlock, renderNamedAgentSelfDocumentBlock } from "../../prompts/cloud-meta-agent/self-document.ts";
import { shouldRerenderUserInfoForLocalPrCreationForge, LOCAL_PR_CREATION_FORGE_RULE_PATH } from "../../../utils/pull-request-guidance.ts";
import { getRequestContextCompleteness, shouldRerenderUserInfoAfterSummarization, shouldRerenderUserInfoForRequestContextRecovery } from "../../prompts/user-info-rerender.ts";
import {
  getFirstUserInfoCloudTestingSectionsPlacement,
  getFirstUserInfoMessageContent,
  getFirstUserInfoOmitCloudWorkerProcedure,
  getFirstUserInfoRequestContextCompleteness,
  getFirstUserInfoSummarizationEpoch,
  shouldMigrateMultitaskEnterReminderToUserInfo,
  shouldRerenderUserInfo,
  userInfoHasMultitaskModeEnterReminder,
} from "../../prompts/user-info-preparation.ts";
import { deserializeConversationHistoryMessages } from "./conversation-history.ts";
import { buildInterruptedPendingToolCallMessages } from "./interrupted-tool-reconstruction.ts";
import { reactivatePausedGoalOnUserMessage } from "./reactivate-paused-goal.ts";
import { AbstractUserMessageActionHandler } from "./abstract-user-message-action-handler.ts";

type Any = any;

const logger70 = createLogger("@slate/agent:user-message-action");
const conversationInitDuration = createHistogram("agent.ttft.conversationInitMs", {
  description: "Time for initializeConversation (system prompt, rules, turn creation)",
});
const getRequestContextDuration = createHistogram("agent.ttft.getRequestContextMs", {
  description: "Time to resolve the request context (may call executor)",
});
const prependedMessagesDuration = createHistogram("agent.ttft.prependedMessagesMs", {
  description: "Time to process prepended user messages (sendUpdate + createAgentTurn per message)",
  labelNames: ["count"],
});
const systemPromptGenerationDuration = createHistogram("agent.ttft.systemPromptGenerationMs", {
  description: "Time for system prompt generation, UserInfo, tool generation, and message assembly",
});
const createMainTurnDuration = createHistogram("agent.ttft.createMainTurnMs", {
  description: "Time for the main stateHandler.createAgentTurn call (includes processSelectedContext)",
  labelNames: ["overlap_pre_turn_state_snapshot"],
});
const postTurnStateDuration = createHistogram("agent.ttft.postTurnStateMs", {
  description: "Time for optional computeNewStructure + onStateUpdate after turn creation",
});

function userInfoHasMultitaskEnterReminder(content: string): boolean {
  return userInfoHasMultitaskModeEnterReminder(content);
}

function requiredToolName(allTools: Any, toolId: string): string {
  return getRequiredToolName(allTools, toolId);
}

function getRequestContextCompletenessAny(requestContext: Any): Any {
  return getRequestContextCompleteness(requestContext);
}

export class UserMessageActionHandler extends AbstractUserMessageActionHandler {
  async initializeConversation(ctx: Any, params: Any): Promise<Any> {
    const configAny: Any = this.config;
    const { action, rootPromptExecutor, stateHandler, mcpTools, maxPrependedUserMessages, forcePrependedUserMessages, onStateUpdate } = params;
    if (!action.userMessage) throw new Error("User message is required");
    const userMessage = action.userMessage;
    const resolvedTurnMode = resolveCurrentTurnMode(stateHandler.mode, userMessage.mode);
    const isRootProject = isRootProjectUserMessage(userMessage);
    const omitCloudWorkerProcedure = shouldOmitCloudWorkerProcedure({
      gateEnabled: configAny.featureFlags?.projectRootCoordinatorPrompt === true,
      agentType: configAny.agentType,
      mode: resolvedTurnMode,
      useLocalAgentPrompting: configAny.useLocalAgentPrompting === true,
      isNamedAgentSession: getNamedAgentSessionPromptContext(configAny) !== undefined || isNamedAgentHomePromptSession(configAny),
      isRootProject,
    });
    if (isRootProject) stateHandler.isRootProjectConversation = true;
    const sendToInteractionListener = action.sendToInteractionListener === true;
    const hasExistingNonSystemMessages = rootPromptExecutor.getMessages().some((message: Any) => message.role !== "system");
    const getRequestContextStart = performance.now();
    const { requestContext, provenance: requestContextProvenance } = await resolveRequestContext({
      parentCtx: ctx,
      ...(action.requestContext ? { maybeRequestContext: fromRedactedRequestContext(action.requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined) } : {}),
      resources: this.resourceAccessor,
      options: buildRequestContextOptions(configAny),
    });
    getRequestContextDuration.histogram(ctx, performance.now() - getRequestContextStart);
    stateHandler.getOrInitializeConversationStartedDate(requestContext.env?.timeZone);
    const mergedMcpTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
    const toolSetHandle = configAny.toolsGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler,
      agentSessionId: configAny.agentSessionId,
      mcpTools: mergedMcpTools,
      repositoryInfos: requestContext.repositoryInfo,
      blobStore: stateHandler.getBlobStore(),
      mode: resolvedTurnMode,
      loggingContext: ctx,
      requestContext,
      fileOperationLockManager: new FileOperationLockManager(),
      smartModeClassifierMode: configAny.smartModeClassifierMode,
      smartModeClassifierShadowMode: configAny.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: configAny.autoRejectFirstAskQuestion,
    });
    const dynamicToolCount = toolSetHandle.getDynamicTools().length;
    const mcpMetaToolNames = getMcpMetaToolSnapshotToolNames(toolSetHandle);
    const dynamicToolMetaNames = mcpMetaToolNames !== undefined ? {
      discoveryToolName: mcpMetaToolNames.discoveryToolName,
      invocationToolName: mcpMetaToolNames.invocationToolName,
    } : undefined;
    const dynamicToolTurnOptions = {
      dynamicToolCount,
      ...(dynamicToolMetaNames !== undefined ? { dynamicToolMetaNames } : {}),
    };
    const isProjectKickoffBeforePrepends = userMessage.projectDetails !== undefined && userMessage.projectDetails.sideChat === undefined && stateHandler.turns.length === 0;
    const prependedMessagesStart = performance.now();
    let prependedCount = 0;
    if (configAny.enablePrependedUserActions || forcePrependedUserMessages) {
      const allPrepended = action.prependUserMessages ?? [];
      const droppedCount = Math.max(0, allPrepended.length - maxPrependedUserMessages);
      const prependedMessages = allPrepended.slice(-maxPrependedUserMessages);
      prependedCount = prependedMessages.length;
      if (droppedCount > 0) logger70.warn(ctx, "dropped excess prepended user messages", { droppedCount, totalCount: allPrepended.length, keptCount: prependedMessages.length });
      if (prependedMessages.length > 0) logger70.info(ctx, "prepending user messages", { prependUserMessagesCount: prependedMessages.length });
      const existingUserTurnMessageIds = prependedMessages.length > 0 ? await stateHandler.getUserTurnMessageIdsIndex(ctx) : undefined;
      const prependedNamedAgentUserTurnReminder = prependedMessages.length === 0 ? undefined : isNamedAgentHomePromptSession(configAny) ? renderNamedAgentHomeUserTurnReminder() : configAny.isCloudMetaAgentParent ? renderCloudMetaParentUserTurnReminder(requiredToolName(extractToolInfo(toolSetHandle).allTools, "TASK"), getNamedAgentSessionPromptContext(configAny)) : undefined;
      for (const prependedMessage of prependedMessages) {
        const prependedUserMessage = fromRedactedUserMessage2(prependedMessage, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
        const prependedMessageId = prependedUserMessage.messageId;
        const duplicateByMessageId = prependedMessageId.length > 0 && existingUserTurnMessageIds?.has(prependedMessageId) === true;
        if (duplicateByMessageId) {
          logger70.info(ctx, "skipping duplicate prepended user message", { prependedMessageId, duplicateByMessageId });
          continue;
        }
        if (sendToInteractionListener) await this.interactionListener.sendUpdate(ctx, RedactedUpdates.userMessageAppended(prependedMessage));
        await stateHandler.createAgentTurn(ctx, prependedUserMessage, requestContext, configAny, this.resourceAccessor, {
          additionalUserTurnSystemReminder: prependedNamedAgentUserTurnReminder,
          ...dynamicToolTurnOptions,
        });
      }
    }
    prependedMessagesDuration.histogram(ctx, performance.now() - prependedMessagesStart, { count: String(prependedCount) });
    const systemPromptStart = performance.now();
    const rules = getAllRules(requestContext, configAny.nonFileRules, configAny.featureFlags);
    const priorMessages = rootPromptExecutor.getMessages().filter((message: Any) => message.role !== "system");
    const priorUserInfoCloudTestingSectionsPlacement = getFirstUserInfoCloudTestingSectionsPlacement(priorMessages);
    const userInfoCloudTestingSectionsPlacement = getCloudTestingSectionsPlacement({
      modelInfo: configAny.modelInfo,
      enableComposer2IntelligentTestingPromptSection: configAny.enableComposer2IntelligentTestingPromptSection,
      backgroundAgentSource: configAny.backgroundAgentSource,
      agentType: configAny.agentType,
      enableCloudTesting: configAny.enableCloudTesting,
      featureFlags: configAny.featureFlags,
      namedAgentSessionKind: configAny.namedAgentSessionKind,
      isCloudMetaAgentParent: configAny.isCloudMetaAgentParent,
      priorUserInfoCloudTestingSectionsPlacement,
    });
    const needsCloudTestingPlacementRerender = priorUserInfoCloudTestingSectionsPlacement === "system_prompt" && userInfoCloudTestingSectionsPlacement === "user_info";
    const newMessages: Any[] = [];
    newMessages.unshift({
      role: "system",
      content: configAny.systemPromptGenerator({
        requestContext,
        cursorRules: rules,
        env: requestContext.env,
        browserTools: getBrowserToolNames(mcpTools),
        cloudRule: requestContext.cloudRule,
        mode: resolvedTurnMode,
        omitCloudWorkerProcedure,
        priorUserInfoCloudTestingSectionsPlacement,
      }, toolSetHandle),
    });
    const shouldRenderDsv3UserInfo = stateHandler.isDsv3() || configAny.modelInfo?.isComposerMatterhorn === true;
    const toolInfo: Any = extractToolInfo(toolSetHandle);
    const namedAgentUserTurnReminder = isNamedAgentHomePromptSession(configAny) ? renderNamedAgentHomeUserTurnReminder() : configAny.isCloudMetaAgentParent ? renderCloudMetaParentUserTurnReminder(requiredToolName(toolInfo.allTools, "TASK"), getNamedAgentSessionPromptContext(configAny)) : undefined;
    const toolMetadataMap = toolInfo.allTools;
    const awaitToolName = toolMetadataMap.AWAIT?.name;
    const shellToolName = toolMetadataMap.SHELL?.name;
    const grepToolName = toolMetadataMap.GREP?.name;
    const matterhornCustomUserRuleOptions = { awaitToolName, shellToolName, grepToolName };
    const expectedCustomUserRules = getGeneratedUserRulesForModel(configAny.modelInfo, configAny.featureFlags, matterhornCustomUserRuleOptions);
    const userInfoMcpMetaToolOptions = withToolSetMcpSnapshot(getMcpMetaToolOptionsWithUserDefinedTools(requestContext.mcpMetaToolOptions, mergedMcpTools), toolSetHandle);
    const hidesMcpMetaToolSnapshot = resolvedTurnMode === AgentMode.ASK && (configAny.enableFilterEditToolsInAskMode ?? true) || configAny.modelInfo?.isComposerMatterhorn === true && configAny.modelInfo.isRawTrainingSlug === true;
    const requestContextCompleteness = getRequestContextCompletenessAny(requestContext);
    const firstUserInfoContent = getFirstUserInfoMessageContent(priorMessages);
    const firstUserInfoRequestContextCompleteness = getFirstUserInfoRequestContextCompleteness(priorMessages);
    const needsUserInfoRerender = shouldRerenderUserInfo(hasExistingNonSystemMessages, priorMessages, expectedCustomUserRules, configAny.modelInfo, stateHandler.hasAgentTypeChangedFromPersistedState(), configAny.featureFlags, { ...matterhornCustomUserRuleOptions, availableSubagentModelsDescription: toolInfo.availableSubagentModelsDescription, availableSubagentTypesDescription: toolInfo.availableSubagentTypesDescription, mcpMetaToolOptions: userInfoMcpMetaToolOptions, skipDynamicToolSnapshotCheck: hidesMcpMetaToolSnapshot });
    const needsRequestContextRecoveryRerender = configAny.featureFlags?.rerenderUserInfoOnRequestContextRecovery === true && shouldRerenderUserInfoForRequestContextRecovery({ previousCompleteness: firstUserInfoRequestContextCompleteness, currentCompleteness: requestContextCompleteness });
    const currentSummarizationEpoch = stateHandler.summaryArchives.length;
    const needsSummarizationRerender = configAny.featureFlags?.rerenderUserInfoOnSummarization === true && shouldRerenderUserInfoAfterSummarization({ previousEpoch: getFirstUserInfoSummarizationEpoch(priorMessages), currentEpoch: currentSummarizationEpoch });
    const needsOmitCloudWorkerProcedureRerender = hasExistingNonSystemMessages && firstUserInfoContent !== undefined && getFirstUserInfoOmitCloudWorkerProcedure(priorMessages) !== omitCloudWorkerProcedure;
    const localPrCreationForgeRule = rules.find((rule: Any) => rule.fullPath === LOCAL_PR_CREATION_FORGE_RULE_PATH);
    const needsLocalPrCreationForgeRerender = hasExistingNonSystemMessages && firstUserInfoContent !== undefined && shouldRerenderUserInfoForLocalPrCreationForge({ userInfoContent: firstUserInfoContent, ...(localPrCreationForgeRule?.content !== undefined ? { forgeRuleContent: localPrCreationForgeRule.content } : {}) });
    const userInfoAlreadyHasMultitaskEnterReminder = firstUserInfoContent !== undefined && userInfoHasMultitaskEnterReminder(firstUserInfoContent);
    const shouldMigrateMultitaskEnterReminderInThisTurn = shouldMigrateMultitaskEnterReminderToUserInfo({ hasExistingNonSystemMessages, previousTurnMode: stateHandler.mode, resolvedTurnMode, priorMessages, firstUserInfoContent, userInfoAlreadyHasMultitaskEnterReminder });
    const shouldReplaceUserInfoWithImportedHistory = action.conversationHistory?.replaceUserInfo === true && action.conversationHistory.messages.length > 0;
    const shouldRenderUserInfo = (!hasExistingNonSystemMessages || needsUserInfoRerender || needsRequestContextRecoveryRerender || needsSummarizationRerender || needsLocalPrCreationForgeRerender || needsOmitCloudWorkerProcedureRerender || shouldMigrateMultitaskEnterReminderInThisTurn || needsCloudTestingPlacementRerender) && !configAny.userInfoDisplayOptions?.disable && !shouldReplaceUserInfoWithImportedHistory;
    const isMainTurnStillFirstConversationTurn = stateHandler.turns.length === 0;
    const shouldAppendMultitaskEnterReminderToUserInfo = shouldRenderUserInfo && resolvedTurnMode === AgentMode.MULTITASK && (!hasExistingNonSystemMessages && isMainTurnStillFirstConversationTurn || userInfoAlreadyHasMultitaskEnterReminder || shouldMigrateMultitaskEnterReminderInThisTurn);
    let didReplaceUserInfo = false;
    if (shouldRenderUserInfo) {
      didReplaceUserInfo = hasExistingNonSystemMessages;
      if (didReplaceUserInfo) {
        const reasons: string[] = [];
        if (needsUserInfoRerender) reasons.push("agent_type_or_composer_rules_change");
        if (needsRequestContextRecoveryRerender) reasons.push("request_context_recovery");
        if (needsSummarizationRerender) reasons.push("summarization_epoch_advanced");
        if (needsOmitCloudWorkerProcedureRerender) reasons.push("omit_cloud_worker_procedure_change");
        if (shouldMigrateMultitaskEnterReminderInThisTurn) reasons.push("multitask_reminder_migration");
        if (needsCloudTestingPlacementRerender) reasons.push("cloud_testing_placement_recovery");
        logger70.info(ctx, "agent.user_info.rerendered", { reasons });
      }
      const subagentToolName = configAny.modelInfo !== undefined ? getTaskToolName(configAny.modelInfo) : "Task";
      const multitaskModeEnterReminderOptions = { ignoreGptPersistenceInstructions: usesPersistenceInstructions(configAny.modelInfo), modelInfo: configAny.modelInfo, hideAsyncSubagentTaskNotifications: configAny.featureFlags?.hideAsyncSubagentTaskNotifications };
      let namedAgentSelfDocumentBlock: Any;
      if (configAny.getNamedAgentSelfDocument !== undefined) {
        try {
          namedAgentSelfDocumentBlock = renderNamedAgentSelfDocumentBlock(await configAny.getNamedAgentSelfDocument());
        } catch (error: Any) {
          logger70.warn(ctx, "agent.named_agent_self_document.load_failed", { error });
          namedAgentSelfDocumentBlock = extractNamedAgentSelfDocumentBlock(firstUserInfoContent);
        }
      }
      let userInfoContent = UserInfo({
        cursorRules: rules,
        agentSkills: requestContext.agentSkills,
        env: requestContext.env,
        gitRepos: requestContext.gitRepos,
        gitRepoInfoComplete: requestContext.gitRepoInfoComplete,
        cloudRule: requestContext.cloudRule,
        mode: resolvedTurnMode,
        isRootProject,
        omitCloudWorkerProcedure,
        isLargeContextModel: shouldRenderDsv3UserInfo,
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
        ...buildUserInfoAgentNotesProps(configAny, resolvedTurnMode, requestContext.env),
        designatedBranches: configAny.designatedBranches,
        branchPrefix: configAny.branchPrefix,
        branchSuffix: configAny.branchSuffix,
        preferCurrentBranchInMultiPrMode: configAny.preferCurrentBranchInMultiPrMode,
        toolInfo,
        browserTools: getBrowserToolNames(mcpTools),
        agentType: configAny.agentType,
        backgroundAgentSource: configAny.backgroundAgentSource,
        isCloudMetaAgentParent: configAny.isCloudMetaAgentParent,
        namedAgentSessionKind: configAny.namedAgentSessionKind,
        namedAgentSelfDocumentBlock,
        enableCloudTesting: configAny.enableCloudTesting,
        useLocalAgentPrompting: configAny.useLocalAgentPrompting,
        isRepoless: configAny.isRepoless,
        modelInfo: configAny.modelInfo,
        agentTokenLimit: configAny.agentTokenLimit,
        enableComposer2IntelligentTestingPromptSection: configAny.enableComposer2IntelligentTestingPromptSection,
        priorUserInfoCloudTestingSectionsPlacement,
      });
      if (shouldAppendMultitaskEnterReminderToUserInfo) userInfoContent = `${userInfoContent}\n\n${renderMultitaskModeEnterUserReminder(subagentToolName, multitaskModeEnterReminderOptions)}`;
      newMessages.push({ role: "user", content: userInfoContent, providerOptions: { cursor: { requestContextCompleteness, userInfoSummarizationEpoch: currentSummarizationEpoch, omitCloudWorkerProcedure, ...(userInfoCloudTestingSectionsPlacement !== undefined ? { composer2CloudTestingSectionsPlacement: userInfoCloudTestingSectionsPlacement } : {}) } } });
    }
    const effectivePriorMessages = didReplaceUserInfo ? priorMessages.slice(1) : priorMessages;
    const conversationHistoryMessages = deserializeConversationHistoryMessages(action, stateHandler.getPrivacyMode());
    const interruptedPendingToolCallMessages = buildInterruptedPendingToolCallMessages(stateHandler, getExecutableTools(toolSetHandle.getToolExecutionSet()), action.interruptedPendingToolCallResolutions, requestContext.env?.terminalsFolder);
    rootPromptExecutor.clearMessages();
    rootPromptExecutor.appendMessages(toRedactedCoreMessages(newMessages, stateHandler.getPrivacyMode()));
    rootPromptExecutor.appendMessages([...conversationHistoryMessages, ...effectivePriorMessages, ...interruptedPendingToolCallMessages]);
    systemPromptGenerationDuration.histogram(ctx, performance.now() - systemPromptStart);
    if (sendToInteractionListener) await this.interactionListener.sendUpdate(ctx, RedactedUpdates.userMessageAppended(userMessage));
    const createMainTurnStart = performance.now();
    const turn = await stateHandler.createAgentTurn(ctx, fromRedactedUserMessage2(userMessage, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined), requestContext, configAny, this.resourceAccessor, {
      additionalUserTurnSystemReminder: namedAgentUserTurnReminder,
      ...(isProjectKickoffBeforePrepends ? { isProjectKickoff: true } : {}),
      ...dynamicToolTurnOptions,
    });
    const preTurnAssistantNotice = configAny.preTurnAssistantNotice?.trim() ?? "";
    if (preTurnAssistantNotice !== "") await turn.recordText(ctx, `${preTurnAssistantNotice}\n\n`);
    stateHandler.setMode(resolvedTurnMode);
    createMainTurnDuration.histogram(ctx, performance.now() - createMainTurnStart, { overlap_pre_turn_state_snapshot: configAny.featureFlags?.overlapPreTurnStateSnapshot === true ? "true" : "false" });
    const postTurnStateStart = performance.now();
    if (configAny.immediatelyUpdateStateOnNewTurn) {
      if (configAny.fireAndForgetCheckpoints) {
        void stateHandler.computeNewStructure(ctx).then(async (newState: Any) => { if (onStateUpdate) await onStateUpdate(ctx, newState); }).catch((error: Any) => logger70.error(ctx, "Failed to persist checkpoint for new turn", { error }));
      } else {
        const newState = await stateHandler.computeNewStructure(ctx);
        if (onStateUpdate) await onStateUpdate(ctx, newState);
      }
    }
    postTurnStateDuration.histogram(ctx, performance.now() - postTurnStateStart);
    return { turn, mergedMcpTools, requestContext, requestContextProvenance };
  }

  async handle(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any, options: Any = {}): Promise<Any> {
    const configAny: Any = this.config;
    using span = createSpan(parentCtx.withName("UserMessageActionHandler.handle"));
    const ctx = span.ctx;
    if (options.isSyntheticWakeup !== true) await reactivatePausedGoalOnUserMessage(ctx, stateHandler, onStateUpdate);
    const convInitStart = performance.now();
    const { turn, mergedMcpTools, requestContext } = await this.initializeConversation(ctx, { action, rootPromptExecutor, stateHandler, mcpTools, maxPrependedUserMessages: options.maxPrependedUserMessages ?? 5, forcePrependedUserMessages: options.forcePrependedUserMessages ?? false, onStateUpdate });
    conversationInitDuration.histogram(ctx, performance.now() - convInitStart);
    await this.runTurnLoop(ctx, rootPromptExecutor, stateHandler, turn, configAny.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return await stateHandler.computeNewStructure(ctx);
  }

  async initAndMeasure(ctx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, options: Any, onStateUpdate: Any): Promise<Any> {
    const configAny: Any = this.config;
    const start = performance.now();
    const result = await this.initializeConversation(ctx, { action, rootPromptExecutor, stateHandler, mcpTools, maxPrependedUserMessages: options.maxPrependedUserMessages ?? 5, forcePrependedUserMessages: options.forcePrependedUserMessages ?? false, onStateUpdate });
    conversationInitDuration.histogram(ctx, performance.now() - start);
    return result;
  }

  async handleSingleStep(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any, options: Any = {}): Promise<Any> {
    const configAny: Any = this.config;
    using span = createSpan(parentCtx.withName("UserMessageActionHandler.handleSingleStep"));
    const ctx = span.ctx;
    if (options.isSyntheticWakeup !== true) await reactivatePausedGoalOnUserMessage(ctx, stateHandler, onStateUpdate);
    const { turn, mergedMcpTools, requestContext } = await this.initAndMeasure(ctx, action, rootPromptExecutor, stateHandler, mcpTools, options, onStateUpdate);
    const { hasToolCall } = await this.runSingleStep(ctx, rootPromptExecutor, stateHandler, turn, configAny.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(ctx), hasToolCall };
  }

  async handleModelStep(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any, options: Any = {}): Promise<Any> {
    const configAny: Any = this.config;
    using span = createSpan(parentCtx.withName("UserMessageActionHandler.handleModelStep"));
    const ctx = span.ctx;
    if (options.isSyntheticWakeup !== true) await reactivatePausedGoalOnUserMessage(ctx, stateHandler, onStateUpdate);
    const { turn, mergedMcpTools, requestContext, requestContextProvenance } = await this.initAndMeasure(ctx, action, rootPromptExecutor, stateHandler, mcpTools, options, onStateUpdate);
    const { toolCallDescriptors, splitStepData } = await this.runModelStep(ctx, rootPromptExecutor, stateHandler, turn, configAny.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(ctx), toolCallDescriptors, splitStepData: { ...splitStepData, requestContextProvenance } };
  }
}
