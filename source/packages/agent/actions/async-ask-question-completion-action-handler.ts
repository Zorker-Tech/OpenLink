import { createSpan } from "../../context/telemetry.ts"
import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/logging.ts"
import { getRedactedRequestContext } from "../utils/request-context.ts"
import { AgentConversationTurnHandle } from "../state.ts"
import { buildRequestContextOptions } from "./meta-agent-notes.ts"
import { applyAskQuestionCompletion, hasAppliedAskQuestionCompletion, isValidAskQuestionCompletion } from "./ask-question-completion.ts"
import { AbstractUserMessageActionHandler } from "./user-message-action/abstract-user-message-action-handler.ts"
import {
  createQuestionnaireContinuation,
  inspectAskQuestionTurn,
  projectTurnRequestContext,
} from "../../../adapters/interop/agent/async-ask-question-completion-adapter.ts"

type Any = any

const logger = createLogger("@slate/agent")

/** Re-attaches a deferred answer to the conversation and resumes whichever turn can accept it. */
export class AsyncAskQuestionCompletionActionHandler extends AbstractUserMessageActionHandler {
  async handle(
    parentCtx: Context,
    action: Any,
    rootPromptExecutor: Any,
    stateHandler: Any,
    mcpTools: Any,
    onStateUpdate: Any,
  ): Promise<Any> {
    const span = createSpan(parentCtx.withName("handleAsyncAskQuestionCompletionAction"))
    const ctx = span.ctx
    try {
      logger.info(ctx, "Handling async ask-question completion", {
        originalToolCallId: action.originalToolCallId,
        resultCase: action.result?.result.case,
        questionsCount: action.originalArgs?.questions.length ?? 0,
      })
      if (!isValidAskQuestionCompletion(action)) {
        logger.warn(ctx, "Skipping invalid async ask-question completion", {
          originalToolCallId: action.originalToolCallId,
          resultCase: action.result?.result.case,
        })
        return await stateHandler.computeNewStructure(ctx)
      }
      if (hasAppliedAskQuestionCompletion(stateHandler, action.originalToolCallId)) {
        logger.info(ctx, "Skipping duplicate async ask-question completion (already applied)", {
          originalToolCallId: action.originalToolCallId,
        })
        return await stateHandler.computeNewStructure(ctx)
      }

      const lastTurnReference = stateHandler.turns.at(-1)
      if (lastTurnReference === undefined) {
        ;(logger.error as Any)(ctx, "No turns available")
        return await stateHandler.computeNewStructure(ctx)
      }
      const lastTurn = await lastTurnReference.get(ctx)
      if (!(lastTurn instanceof AgentConversationTurnHandle)) {
        ;(logger.error as Any)(ctx, "Last turn is not an agent turn")
        return await stateHandler.computeNewStructure(ctx)
      }

      const destination = await inspectAskQuestionTurn(ctx, lastTurn)
      const resourceAccessor = (this as Any).resourceAccessor
      const config = (this as Any).config
      const interactionListener = (this as Any).interactionListener
      const redactedRequestContext = await getRedactedRequestContext(
        ctx,
        undefined,
        resourceAccessor,
        buildRequestContextOptions(config),
      )
      const turnContext = projectTurnRequestContext(redactedRequestContext)
      const mergedTools = this.mergeRequestContextTools(mcpTools, redactedRequestContext.tools)

      let targetTurn: Any = lastTurn
      let continuationMessageId: string | undefined
      if (destination.destination === "new-turn") {
        logger.info(ctx, "Current turn is finished, creating new turn", { lastTurnSteps: destination.stepCount })
        const sourceMessage = await lastTurn.userMessage.get(ctx)
        const continuation = createQuestionnaireContinuation(sourceMessage, stateHandler.getPrivacyMode())
        continuationMessageId = continuation.message.messageId
        await interactionListener.sendUpdate(ctx, continuation.appendedUpdate)
        targetTurn = await stateHandler.createAgentTurn(
          ctx,
          continuation.message,
          turnContext.requestContext,
          config,
          resourceAccessor,
        )
      } else {
        logger.info(ctx, "Current turn is active, appending to existing turn")
      }

      const application = await applyAskQuestionCompletion(ctx, {
        action,
        stateHandler,
        turn: targetTurn,
        rootPromptExecutor,
        resultFormat: "formatted-string",
      })
      if (application.outcome !== "applied") return await stateHandler.computeNewStructure(ctx)

      if (destination.destination === "new-turn") {
        logger.info(ctx, "Created new turn with tool call and result", {
          messageId: continuationMessageId,
          toolCallId: application.recordedToolCallId,
        })
      } else {
        logger.info(ctx, "Appended tool call and result to existing turn")
      }

      await this.runTurnLoop(
        ctx,
        rootPromptExecutor,
        stateHandler,
        targetTurn,
        config.toolsGenerator,
        mergedTools,
        turnContext.repositories,
        turnContext.requestContext,
        onStateUpdate,
      )
      logger.info(ctx, "Async ask-question completion action handled successfully")
      return await stateHandler.computeNewStructure(ctx)
    } finally {
      span[Symbol.dispose]()
    }
  }
}
