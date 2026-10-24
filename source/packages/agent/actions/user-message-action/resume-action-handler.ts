/**
 * Picking a conversation back up.
 *
 * A resume arrives when a turn was interrupted — the app was closed, the stream was cut, the machine
 * restarted — so the tool calls that were admitted and never executed are executed before the loop runs
 * again, and they are executed under the admittedContract they were admitted with: a call whose identity no longer
 * matches what was admitted is refused rather than run, so a resumed turn cannot execute something the user
 * never approved. The rest of the resume is the ordinary loop: the turn that was open is continued, and a
 * conversation with no turns at all has nothing to resume.
 */
import { AgentConversationTurnHandle } from "../../state.ts";
import { InteractionHandler } from "../../interaction-handler.ts";
import { FileOperationLockManager } from "../../tools/core/file-operation-locks.ts";
import { appendToolCallIdTagsToToolResults, shouldTagToolCallIdsForCurrentContext } from "../../tools/tool-call-id-tagging.ts";
import { extractToolMetadataMap, getDirectDynamicToolNames, getExecutableTools } from "../../tools/tool-execution.ts";
import { executeDeferredToolCall } from "../../tool-stream-executor.ts";
import { PrivacyCapability } from "../../../redaction/classification.ts";
import { toRedactedCoreMessages } from "../../../redaction/message-redaction.ts";
import { fromRedactedRequestContext } from "../../../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts";
import { toUnredactedInteractionListener } from "../../../agent-core/redacted-interaction-listener.ts";
import { createSpan } from "../../../context/telemetry.ts";
import type { Context } from "../../../context/context.ts";
import { getInvocationId } from "../../utils/invocation-id.ts";
import { getRequestContext, resolveRequestContext } from "../../utils/request-context.ts";
import { buildRequestContextOptions } from "../meta-agent-notes.ts";
import {
  collectPendingToolAdmission,
  createPendingToolContractMismatchResult,
  readPendingToolExecutionContracts,
  resolveDescriptorForPendingToolCall,
  validatePendingToolContractIdentity,
} from "../../pending-tool-call-contract.ts";
import { AbstractUserMessageActionHandler } from "./abstract-user-message-action-handler.ts";

type Any = any;

export class ResumeActionHandler extends AbstractUserMessageActionHandler {
  async executePendingToolCalls(ctx: Context, stateHandler: Any, mergedTools: Any, requestContext: Any, invocationId: string): Promise<boolean> {
    const queuedMessages = stateHandler.getRawPendingMessages();
    if (queuedMessages.length === 0 || stateHandler.turns.length === 0) return false;
    const newestTurnRef = stateHandler.turns[stateHandler.turns.length - 1];
    const loadedTurn: Any = await newestTurnRef.get(ctx);
    if (!(loadedTurn instanceof AgentConversationTurnHandle)) throw new Error("Expected last turn to be an agent turn");
    const turn: Any = loadedTurn;
    const toolInteractionHandler = new InteractionHandler(
      toUnredactedInteractionListener(this.interactionListener, stateHandler.getPrivacyMode()),
      turn,
      invocationId,
      undefined,
      this.config.thinkingStyle,
      this.config.featureFlags?.nalLoopDetection === true,
    );
    const userMode = (await turn.userMessage.get(ctx)).userMode;
    const fileLocks = new FileOperationLockManager();
    const toolSet = this.config.toolsGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler,
      agentSessionId: this.config.agentSessionId,
      mcpTools: mergedTools,
      repositoryInfos: requestContext.repositoryInfo,
      blobStore: stateHandler.getBlobStore(),
      mode: userMode,
      loggingContext: ctx,
      requestContext,
      fileOperationLockManager: fileLocks,
      smartModeClassifierMode: this.config.smartModeClassifierMode,
      smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
    });
    const messages = queuedMessages.map((message: Any) => JSON.parse(message.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)));
    const assistantMessage = messages.at(-1);
    if (assistantMessage === undefined || assistantMessage.role !== "assistant") throw new Error("No assistant message to resume from");
    const admittedContracts = readPendingToolExecutionContracts(assistantMessage);
    const { allowedToolNames: permittedToolNames, admittedEffectiveToolNames: admittedAliasNames } = collectPendingToolAdmission({ contracts: admittedContracts.values() });
    const staticTools = toolSet.getStaticTools();
    const scopedTools = permittedToolNames === undefined ? staticTools : staticTools.filter((tool: Any) => permittedToolNames.has(tool.name) || admittedAliasNames.has(tool.name));
    const executionSet = toolSet.getToolExecutionSet(scopedTools);
    const runnableTools = getExecutableTools(executionSet);
    const directDynamicNames = getDirectDynamicToolNames(executionSet);
    const toolsByName: Record<string, Any> = {};
    for (const tool of runnableTools) toolsByName[tool.name] = tool;
    const renderParameters = { allTools: extractToolMetadataMap(runnableTools), blobStore: stateHandler.getBlobStore() };
    const callPromises: Promise<Any>[] = [];
    if (Array.isArray(assistantMessage.content)) {
      for (const content of assistantMessage.content) {
        if (content.type !== "tool-call") continue;
        const admittedContract = admittedContracts.get(content.toolCallId);
        const resolvedDescriptor = resolveDescriptorForPendingToolCall({ toolCallId: content.toolCallId, toolName: content.toolName, args: content.args, contract: admittedContract, toolExecutionSet: executionSet });
        const nativeToolName = resolvedDescriptor.effectiveNativeToolCall?.toolName ?? resolvedDescriptor.toolName;
        const tool = toolsByName[nativeToolName];
        if (admittedContract !== undefined && tool !== undefined) {
          const identityCheck = validatePendingToolContractIdentity({ contract: admittedContract, tool, descriptor: resolvedDescriptor, directDynamicToolNames: directDynamicNames });
          if (!identityCheck.ok) {
            callPromises.push(Promise.resolve(createPendingToolContractMismatchResult(resolvedDescriptor, identityCheck.reason)));
            continue;
          }
        }
        const storeConflictNotices = this.config.featureFlags?.enableAgentStoreConflictNotices === true;
        callPromises.push(executeDeferredToolCall(ctx, resolvedDescriptor, toolsByName, toolInteractionHandler, {
          repositoryInfos: requestContext.repositoryInfo,
          stateHandler,
          workspacePaths: requestContext.env?.workspacePaths,
          enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
          enableAgentStoreConflictNoticeCollector: storeConflictNotices,
          enableAgentStoreConflictNotices: storeConflictNotices,
          writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
          onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
        }, async () => {}, renderParameters, undefined, undefined, directDynamicNames));
      }
    }
    const resultMessages = await Promise.all(callPromises);
    messages.push(...resultMessages);
    if (shouldTagToolCallIdsForCurrentContext(ctx)) appendToolCallIdTagsToToolResults(messages);
    turn.appendPromptMessages(toRedactedCoreMessages(messages, stateHandler.getPrivacyMode()));
    return true;
  }

  async handle(parentCtx: Context, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    using executionSpan = createSpan(parentCtx.withName("ResumeActionHandler.handle"));
    const ctx = executionSpan.ctx;
    const invocationId = getInvocationId(ctx);
    executionSpan.span.setAttribute("invocationId", invocationId);
    const requestContext = await getRequestContext(ctx, action.requestContext ? fromRedactedRequestContext(action.requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined) : undefined, this.resourceAccessor, buildRequestContextOptions(this.config));
    const mergedTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
    await this.executePendingToolCalls(ctx, stateHandler, mergedTools, requestContext, invocationId);
    if (stateHandler.turns.length === 0) return await stateHandler.computeNewStructure(ctx);
    const newestTurnRef = stateHandler.turns[stateHandler.turns.length - 1];
    const loadedTurn: Any = await newestTurnRef.get(ctx);
    if (!(loadedTurn instanceof AgentConversationTurnHandle)) throw new Error("Expected last turn to be an agent turn");
    const turn: Any = loadedTurn;
    await this.runTurnLoop(ctx, rootPromptExecutor, stateHandler, turn, this.config.toolsGenerator, mergedTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return await stateHandler.computeNewStructure(ctx);
  }

  async setupResumeStep(ctx: Context, action: Any, stateHandler: Any, mcpTools: Any): Promise<Any> {
    const invocationId = getInvocationId(ctx);
    const { requestContext, provenance: requestContextProvenance } = await resolveRequestContext({
      parentCtx: ctx,
      resources: this.resourceAccessor,
      options: buildRequestContextOptions(this.config),
      ...(action.requestContext ? { maybeRequestContext: fromRedactedRequestContext(action.requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined) } : {}),
    });
    const mergedTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
    await this.executePendingToolCalls(ctx, stateHandler, mergedTools, requestContext, invocationId);
    if (stateHandler.turns.length === 0) return { noTurns: true };
    const newestTurnRef = stateHandler.turns[stateHandler.turns.length - 1];
    const turn: Any = await newestTurnRef.get(ctx);
    if (!(turn instanceof AgentConversationTurnHandle)) throw new Error("Expected last turn to be an agent turn");
    return { turn, mergedTools, requestContext, requestContextProvenance };
  }

  async handleSingleStep(parentCtx: Context, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    using executionSpan = createSpan(parentCtx.withName("ResumeActionHandler.handleSingleStep"));
    const ctx = executionSpan.ctx;
    executionSpan.span.setAttribute("invocationId", getInvocationId(ctx));
    const stepSetup = await this.setupResumeStep(ctx, action, stateHandler, mcpTools);
    if ("noTurns" in stepSetup) return { state: await stateHandler.computeNewStructure(ctx), hasToolCall: false };
    const { turn, mergedTools, requestContext } = stepSetup;
    const { hasToolCall } = await this.runSingleStep(ctx, rootPromptExecutor, stateHandler, turn, this.config.toolsGenerator, mergedTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(ctx), hasToolCall };
  }

  async handleModelStep(parentCtx: Context, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    using executionSpan = createSpan(parentCtx.withName("ResumeActionHandler.handleModelStep"));
    const ctx = executionSpan.ctx;
    executionSpan.span.setAttribute("invocationId", getInvocationId(ctx));
    const stepSetup = await this.setupResumeStep(ctx, action, stateHandler, mcpTools);
    if ("noTurns" in stepSetup) return { state: await stateHandler.computeNewStructure(ctx), toolCallDescriptors: [], splitStepData: { modelResponseMessages: [] } };
    const { turn, mergedTools, requestContext, requestContextProvenance } = stepSetup;
    const { toolCallDescriptors, splitStepData } = await this.runModelStep(ctx, rootPromptExecutor, stateHandler, turn, this.config.toolsGenerator, mergedTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(ctx), toolCallDescriptors, splitStepData: { ...splitStepData, requestContextProvenance } };
  }
}
