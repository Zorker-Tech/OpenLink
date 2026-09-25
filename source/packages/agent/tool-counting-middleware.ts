/**
 * Counting the tool calls a turn made, and how they went.
 *
 * The counts are what the platform reports about a turn — how many tools it used, how many failed, and
 * how many failed in ways that suggest the environment rather than the request — so they have to be
 * taken from the same place the results are recorded, rather than from a second pass that could
 * disagree. That is what the middleware is: the executor wrapped so that every recorded result is
 * counted, with the classification that came with it.
 *
 * The two "unexpected" classifications are separated from the rest because they mean the turn should not
 * be judged on its outcome: a timeout, a provider failure or a device out of space is not the model's
 * mistake.
 */

import { ToolErrorClassification } from "./tools/tool-errors.ts"

type ToolResultRecorder = (
  ctx: unknown,
  result: unknown,
  loggedToolName: unknown,
  errorClassification: ToolErrorClassification | undefined,
) => Promise<void>

interface ToolCountingExecutor {
  appendMessages(messages: unknown): unknown
  getState(): unknown
  getMessages(): unknown
  clearMessages(): unknown
  executeToolStream(
    ctx: unknown,
    convState: unknown,
    interactionHandler: unknown,
    tools: unknown,
    extraT: unknown,
    recordToolCallResult: ToolResultRecorder,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown
  executeModelStreamOnly(
    ctx: unknown,
    convState: unknown,
    interactionHandler: unknown,
    tools: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown
  stream(ctx: unknown, invocationId: unknown, tools: unknown, options: unknown): unknown
}

export class ToolCountingStateTracker {
  toolCallCount = 0
  readonly resultClassificationCounts = new Map<ToolErrorClassification, number>()

  getFailedToolCallCount(): number {
    return Array.from(this.resultClassificationCounts.values()).reduce((sum, count) => sum + count, 0)
  }

  getUnexpectedToolCallErrorCount(): number {
    return (this.resultClassificationCounts.get(ToolErrorClassification.TIMEOUT) ?? 0) +
      (this.resultClassificationCounts.get(ToolErrorClassification.PROVIDER_ERROR) ?? 0) +
      (this.resultClassificationCounts.get(ToolErrorClassification.BAD_USER_DEVICE_STATE) ?? 0) +
      (this.resultClassificationCounts.get(ToolErrorClassification.OTHER_ERROR) ?? 0)
  }

  hasFailedToolCalls(): "true" | "false" {
    return this.getFailedToolCallCount() > 0 ? "true" : "false"
  }

  hasUnexpectedToolCallErrors(): "true" | "false" {
    return this.getUnexpectedToolCallErrorCount() > 0 ? "true" : "false"
  }
}

export function createToolCountingMiddleware(
  state: ToolCountingStateTracker,
): (executor: ToolCountingExecutor) => ToolCountingExecutor {
  return executor => ({
    appendMessages(messages) {
      executor.appendMessages(messages)
      return this
    },
    getState() {
      return executor.getState()
    },
    getMessages() {
      return executor.getMessages()
    },
    clearMessages() {
      executor.clearMessages()
    },
    executeToolStream(ctx, convState, interactionHandler, tools, extraT, recordToolCallResult, descriptionProps, firstToolCallHook) {
      return executor.executeToolStream(
        ctx,
        convState,
        interactionHandler,
        tools,
        extraT,
        async (innerCtx, result, loggedToolName, errorClassification) => {
          await recordToolCallResult(innerCtx, result, loggedToolName, errorClassification)
          state.toolCallCount++
          if (errorClassification !== undefined) {
            state.resultClassificationCounts.set(
              errorClassification,
              (state.resultClassificationCounts.get(errorClassification) ?? 0) + 1,
            )
          }
        },
        descriptionProps,
        firstToolCallHook,
      )
    },
    executeModelStreamOnly(ctx, convState, interactionHandler, tools, descriptionProps, firstToolCallHook) {
      return executor.executeModelStreamOnly(ctx, convState, interactionHandler, tools, descriptionProps, firstToolCallHook)
    },
    stream(ctx, invocationId, tools, options) {
      return executor.stream(ctx, invocationId, tools, options)
    },
  })
}
