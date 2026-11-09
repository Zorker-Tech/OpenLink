/**
 * Background work that finished while the turn was somewhere else.
 *
 * Each completion is recorded on the session, then written into the conversation as a simulated user
 * message — the message the user would have sent had they been watching — and a follow-up turn is started
 * for it, because a completion nobody reacts to is a completion nobody hears about. Progress reports from a
 * shell are not completions unless the caller asked for them, an empty set is skipped, and a follow-up that
 * was turned off is skipped while the completion is still recorded, so the session keeps the fact even when
 * the conversation does not get a turn out of it. The meta-parent surface is written to in its own words,
 * since it reports to a parent rather than to the user.
 */
import { randomUUID } from "node:crypto";
import {
  createBackgroundCompletionUserMessage,
  projectBackgroundCompletionRequestContext,
} from "../../../adapters/interop/agent/background-task-completion-adapter.ts";
import {
  isSlateBackgroundTaskCompletionActionPayload,
  type SlateBackgroundTaskCompletionActionPayload,
} from "./background-task-completion-contracts.ts";
import { createSpan } from "../../context/telemetry.ts";
import { createLogger } from "../../context/logging.ts";
import { toRedactedCoreMessages } from "../../redaction/message-redaction.ts";
import { AgentType } from "../utils/agent-config.ts";
import { AgentConversationTurnHandle } from "../state.ts";
import { buildRequestContextOptions } from "./meta-agent-notes.ts";
import { getRedactedRequestContext } from "../utils/request-context.ts";
import { canRootConversationSendToProject } from "../../constants/project-send-message.ts";
import { resolveProjectConversationContextFromInterop } from "../../../adapters/interop/agent/project-conversation-adapter.ts";
import { renderIncomingMessageIdTag } from "../state.ts";
import {
  formatBackgroundCompletions,
  formatMetaParentBackgroundCompletions,
  getBackgroundTaskCompletionMetadata,
  getBackgroundTaskCompletionThreadId,
  isShellOutputCompletion,
  summarizeBackgroundTaskCompletions,
} from "./background-task-completion.ts";
import { AbstractUserMessageActionHandler } from "./user-message-action/abstract-user-message-action-handler.ts";

type Any = any;
const logger = createLogger("@slate/agent");

function logBackgroundTaskCompletionOutcome(ctx: Any, outcome: string, summary: Any, extra: Any): void {
  logger.info(ctx, "agent.background_task_completion", { event: "agent.background_task_completion", outcome, ...summary, ...extra });
}

export class BackgroundTaskCompletionActionHandler extends AbstractUserMessageActionHandler {
  async prepareFollowupTurn(ctx: Any, action: SlateBackgroundTaskCompletionActionPayload, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any): Promise<Any> {
    if (!isSlateBackgroundTaskCompletionActionPayload(action)) {
      throw new TypeError("Background task completion action must use the Slate v1 contract");
    }
    const completions = action.completions;
    for (const completion of completions) stateHandler.recordSubagentRunCompletion(completion);
    const isMetaParentAgent = this.config.featureFlags?.glassMetaParentAgent === true;
    if (this.config.featureFlags?.disableBackgroundTaskFollowUp && !isMetaParentAgent) {
      logBackgroundTaskCompletionOutcome(ctx, "skipped_disabled", summarizeBackgroundTaskCompletions(completions), { is_meta_parent: isMetaParentAgent });
      return { kind: "skip", ctx, state: await stateHandler.computeNewStructure(ctx) };
    }
    const followupCompletions = this.config.featureFlags?.enableBackgroundTaskProgress
      ? completions
      : completions.filter(completion => !isShellOutputCompletion(completion));
    const summary = summarizeBackgroundTaskCompletions(followupCompletions);
    if (followupCompletions.length === 0) {
      logBackgroundTaskCompletionOutcome(ctx, "skipped_empty", summary, { is_meta_parent: isMetaParentAgent });
      return { kind: "skip", ctx, state: await stateHandler.computeNewStructure(ctx) };
    }
    const lastTurnRef = stateHandler.turns.at(-1);
    let sourceUserMessage: Any;
    if (lastTurnRef) {
      const lastTurn = await lastTurnRef.get(ctx);
      if (lastTurn instanceof AgentConversationTurnHandle) sourceUserMessage = await lastTurn.userMessage.get(ctx);
    }
    const requestContext = await getRedactedRequestContext(ctx, undefined, this.resourceAccessor, buildRequestContextOptions(this.config));
    const contextProjection = projectBackgroundCompletionRequestContext(requestContext);
    const mergedMcpTools = this.mergeRequestContextTools(mcpTools, contextProjection.tools as Any);
    const repositoryInfos = contextProjection.repositoryInfos;
    const formatOpts: Any = {
      timeZone: contextProjection.timeZone,
      includeTimestamp: this.config.featureFlags?.userMessageTimestamps === true && !stateHandler.usesLargeContextTreatment(),
      parentModelInfo: this.config.modelInfo,
      enableAgentChatLinks: this.config.featureFlags?.enableAgentChatLinks !== false,
      hideAsyncSubagentTaskNotifications: this.config.featureFlags?.hideAsyncSubagentTaskNotifications === true,
      includeCloudSubagentViewLinks: this.config.agentType === AgentType.IDE || this.config.useLocalAgentPrompting === true,
    };
    if (!stateHandler.isRootProjectConversation) stateHandler.isRootProjectConversation = (await resolveProjectConversationContextFromInterop(ctx, stateHandler)).isRootProject;
    const sendMessageEnabled = canRootConversationSendToProject(stateHandler);
    const perCompletionMessages = followupCompletions.map((completion: Any) => {
      const completionMessage = isMetaParentAgent ? formatMetaParentBackgroundCompletions([completion], formatOpts) : formatBackgroundCompletions([completion], formatOpts);
      const messageId = randomUUID();
      const incomingMessageIdTag = sendMessageEnabled ? renderIncomingMessageIdTag(messageId) : undefined;
      return {
        completionMessage,
        completionPromptMessage: incomingMessageIdTag === undefined ? completionMessage : `${incomingMessageIdTag}\n${completionMessage}`,
        completionMetadata: getBackgroundTaskCompletionMetadata([completion]),
        completionThreadId: getBackgroundTaskCompletionThreadId([completion], stateHandler),
        messageId,
      };
    });
    logBackgroundTaskCompletionOutcome(ctx, "ran_followup", summary, { is_meta_parent: isMetaParentAgent, has_source_user_message: sourceUserMessage !== undefined });
    let latestTurn: Any;
    for (const { completionMessage, completionPromptMessage, completionMetadata, completionThreadId, messageId } of perCompletionMessages) {
      const syntheticMessage = createBackgroundCompletionUserMessage({
        text: completionMessage,
        messageId,
        sourceMessage: sourceUserMessage,
        mode: stateHandler.mode,
        metadata: completionMetadata,
        threadId: completionThreadId,
        privacyMode: stateHandler.getPrivacyMode(),
      });
      await this.interactionListener.sendUpdate(ctx, syntheticMessage.listenerUpdate);
      latestTurn = await stateHandler.createAgentTurn(ctx, syntheticMessage.slateUserMessage, contextProjection.promptContext, this.config, this.resourceAccessor);
      rootPromptExecutor.appendMessages(toRedactedCoreMessages([{ role: "user", content: completionPromptMessage }], stateHandler.getPrivacyMode()));
    }
    if (latestTurn === undefined) return { kind: "skip", ctx, state: await stateHandler.computeNewStructure(ctx) };
    return { kind: "ready", ctx, latestTurn, mergedMcpTools, repositoryInfos, requestContext: contextProjection.promptContext };
  }

  async handle(parentCtx: Any, action: SlateBackgroundTaskCompletionActionPayload, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    using span = createSpan(parentCtx.withName("handleBackgroundTaskCompletionAction"));
    const followup = await this.prepareFollowupTurn(span.ctx, action, rootPromptExecutor, stateHandler, mcpTools);
    if (followup.kind === "ready") await this.runTurnLoop(followup.ctx, rootPromptExecutor, stateHandler, followup.latestTurn, this.config.toolsGenerator, followup.mergedMcpTools, followup.repositoryInfos, followup.requestContext, onStateUpdate);
    return await stateHandler.computeNewStructure(followup.ctx);
  }

  async handleSingleStep(ctx: Any, _action: SlateBackgroundTaskCompletionActionPayload, _rootPromptExecutor: Any, stateHandler: Any, _mcpTools: Any, _onStateUpdate: Any): Promise<Any> {
    return { state: await stateHandler.computeNewStructure(ctx), hasToolCall: false };
  }

  async handleModelStep(parentCtx: Any, action: SlateBackgroundTaskCompletionActionPayload, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    using span = createSpan(parentCtx.withName("handleBackgroundTaskCompletionModelStep"));
    const followup = await this.prepareFollowupTurn(span.ctx, action, rootPromptExecutor, stateHandler, mcpTools);
    if (followup.kind === "skip") return { state: followup.state, toolCallDescriptors: [], splitStepData: { modelResponseMessages: [] } };
    const { toolCallDescriptors, splitStepData } = await this.runModelStep(followup.ctx, rootPromptExecutor, stateHandler, followup.latestTurn, this.config.toolsGenerator, followup.mergedMcpTools, followup.repositoryInfos, followup.requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(followup.ctx), toolCallDescriptors, splitStepData };
  }
}
