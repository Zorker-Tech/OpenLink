/**
 * A question the agent asked without waiting, answered afterwards.
 *
 * The answer arrives as its own action, after the turn that asked it is gone, so this is what turns it back
 * into conversation: the call the model made and the result it got are written into the turn that asked —
 * or into a new turn when that one had already finished — and the loop runs again so the model can act on
 * what the user chose. An answer that is not an answer (no id, or a result that means nothing happened), one
 * that was already applied, and one that arrives with no turn to attach to all leave the conversation as it
 * is rather than being written twice.
 */
import { randomUUID } from "node:crypto";

import { UserMessage } from "../../proto/generated/agent/v1/agent_pb.ts";
import { Updates } from "../../agent-core/interaction-updates.ts";
import { createSpan } from "../../context/telemetry.ts";
import type { Context } from "../../context/context.ts";
import { createLogger } from "../../context/logging.ts";
import { PrivacyCapability } from "../../redaction/classification.ts";
import { fromRedactedRequestContext } from "../../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts";
import { fromRedactedRepositoryIndexingInfo } from "../../redacted-protos/generated/agent/v1/repo_redacted.ts";
import { fromRedactedSelectedContext } from "../../redacted-protos/generated/agent/v1/selected_context_redacted.ts";
import { toRedactedInteractionUpdate } from "../../redacted-protos/generated/agent/v1/agent_redacted.ts";
import { getRedactedRequestContext } from "../utils/request-context.ts";
import { AgentConversationTurnHandle } from "../state.ts";
import { buildRequestContextOptions } from "./meta-agent-notes.ts";
import {
  applyAskQuestionCompletion,
  hasAppliedAskQuestionCompletion,
  isValidAskQuestionCompletion,
} from "./ask-question-completion.ts";
import { AbstractUserMessageActionHandler } from "./user-message-action/abstract-user-message-action-handler.ts";

type Any = any;

const logger = createLogger("@slate/agent");

export class AsyncAskQuestionCompletionActionHandler extends AbstractUserMessageActionHandler {
  async handle(
    parentCtx: Context,
    action: Any,
    rootPromptExecutor: Any,
    stateHandler: Any,
    mcpTools: Any,
    onStateUpdate: Any,
  ): Promise<Any> {
    const span = createSpan(parentCtx.withName("handleAsyncAskQuestionCompletionAction"));
    const ctx = span.ctx;
    try {
      logger.info(ctx, "Handling async ask-question completion", {
        originalToolCallId: action.originalToolCallId,
        resultCase: action.result?.result.case,
        questionsCount: action.originalArgs?.questions.length ?? 0,
      });
      if (!isValidAskQuestionCompletion(action)) {
        logger.warn(ctx, "Skipping invalid async ask-question completion", {
          originalToolCallId: action.originalToolCallId,
          resultCase: action.result?.result.case,
        });
        return await stateHandler.computeNewStructure(ctx);
      }
      if (hasAppliedAskQuestionCompletion(stateHandler, action.originalToolCallId)) {
        logger.info(ctx, "Skipping duplicate async ask-question completion (already applied)", { originalToolCallId: action.originalToolCallId });
        return await stateHandler.computeNewStructure(ctx);
      }
      const lastTurnRef = stateHandler.turns.at(-1);
      if (!lastTurnRef) {
        (logger.error as Any)(ctx, "No turns available");
        return await stateHandler.computeNewStructure(ctx);
      }
      const lastTurn: Any = await lastTurnRef.get(ctx);
      if (!(lastTurn instanceof AgentConversationTurnHandle)) {
        (logger.error as Any)(ctx, "Last turn is not an agent turn");
        return await stateHandler.computeNewStructure(ctx);
      }
      const agentTurn: Any = lastTurn;
      const isTurnFinished = agentTurn.steps.length === 0 || await (async () => {
        const lastStepRef = agentTurn.steps.at(-1);
        if (!lastStepRef) return true;
        const lastStep = await lastStepRef.get(ctx);
        return lastStep.message.case !== "toolCall";
      })();
      const resourceAccessor = (this as Any).resourceAccessor;
      const config = (this as Any).config;
      const interactionListener = (this as Any).interactionListener;
      const requestContext = await getRedactedRequestContext(
        ctx,
        undefined,
        resourceAccessor,
        buildRequestContextOptions(config),
      );
      const mergedMcpTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
      if (isTurnFinished) {
        logger.info(ctx, "Current turn is finished, creating new turn", { lastTurnSteps: agentTurn.steps.length });
        const lastUserMessage = await agentTurn.userMessage.get(ctx);
        const syntheticUserMessage = new UserMessage({
          text: "Continue with the questionnaire results.",
          messageId: randomUUID(),
          selectedContext: (lastUserMessage.selectedContext
            ? fromRedactedSelectedContext(lastUserMessage.selectedContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)
            : undefined) as Any,
          mode: lastUserMessage.mode,
          isSimulatedMsg: true,
          bestOfNGroupId: lastUserMessage.bestOfNGroupId,
          tryUseBestOfNPromotion: lastUserMessage.tryUseBestOfNPromotion,
        });
        await interactionListener.sendUpdate(ctx, toRedactedInteractionUpdate(
          Updates.userMessageAppended(syntheticUserMessage),
          stateHandler.getPrivacyMode(),
        ));
        const newTurn = await stateHandler.createAgentTurn(
          ctx,
          syntheticUserMessage,
          fromRedactedRequestContext(requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
          config,
          resourceAccessor,
        );
        const application = await applyAskQuestionCompletion(ctx, {
          action,
          stateHandler,
          turn: newTurn,
          rootPromptExecutor,
          resultFormat: "formatted-string",
        });
        if (application.outcome !== "applied") return await stateHandler.computeNewStructure(ctx);
        logger.info(ctx, "Created new turn with tool call and result", {
          messageId: syntheticUserMessage.messageId,
          toolCallId: application.recordedToolCallId,
        });
        await (this as Any).runTurnLoop(
          ctx,
          rootPromptExecutor,
          stateHandler,
          newTurn,
          config.toolsGenerator,
          mergedMcpTools,
          requestContext.repositoryInfo.map((repositoryInfo: Any) => fromRedactedRepositoryIndexingInfo(repositoryInfo, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)),
          fromRedactedRequestContext(requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
          onStateUpdate,
        );
      } else {
        logger.info(ctx, "Current turn is active, appending to existing turn");
        const application = await applyAskQuestionCompletion(ctx, {
          action,
          stateHandler,
          turn: agentTurn,
          rootPromptExecutor,
          resultFormat: "formatted-string",
        });
        if (application.outcome !== "applied") return await stateHandler.computeNewStructure(ctx);
        logger.info(ctx, "Appended tool call and result to existing turn");
        await (this as Any).runTurnLoop(
          ctx,
          rootPromptExecutor,
          stateHandler,
          agentTurn,
          config.toolsGenerator,
          mergedMcpTools,
          requestContext.repositoryInfo.map((repositoryInfo: Any) => fromRedactedRepositoryIndexingInfo(repositoryInfo, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)),
          fromRedactedRequestContext(requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
          onStateUpdate,
        );
      }
      logger.info(ctx, "Async ask-question completion action handled successfully");
      return await stateHandler.computeNewStructure(ctx);
    } finally {
      span[Symbol.dispose]();
    }
  }
}
