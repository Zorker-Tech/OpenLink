import { ToolErrorClassification } from "./tools/tool-errors.ts";

type ToolResultRecorder = (
  ctx: unknown,
  result: unknown,
  loggedToolName: unknown,
  errorClassification: ToolErrorClassification | undefined,
) => Promise<void>;

interface ToolCountingExecutor {
  appendMessages(messages: unknown): unknown;
  getState(): unknown;
  getMessages(): unknown;
  clearMessages(): unknown;
  executeToolStream(
    ctx: unknown,
    convState: unknown,
    interactionHandler: unknown,
    tools: unknown,
    extraT: unknown,
    recordToolCallResult: ToolResultRecorder,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown;
  executeModelStreamOnly(
    ctx: unknown,
    convState: unknown,
    interactionHandler: unknown,
    tools: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown;
  stream(ctx: unknown, invocationId: unknown, tools: unknown, options: unknown): unknown;
}

const ENVIRONMENT_FAILURES = [
  ToolErrorClassification.TIMEOUT,
  ToolErrorClassification.PROVIDER_ERROR,
  ToolErrorClassification.BAD_USER_DEVICE_STATE,
  ToolErrorClassification.OTHER_ERROR,
] as const;

function addCounts(counts: Iterable<number>): number {
  let total = 0;
  for (const count of counts) total += count;
  return total;
}

function classificationTotal(
  counts: ReadonlyMap<ToolErrorClassification, number>,
  classes: readonly ToolErrorClassification[],
): number {
  return addCounts(classes.map((classification) => counts.get(classification) ?? 0));
}

function flag(value: boolean): "true" | "false" {
  return value ? "true" : "false";
}

export class ToolCountingStateTracker {
  toolCallCount = 0;
  readonly resultClassificationCounts = new Map<ToolErrorClassification, number>();

  getFailedToolCallCount(): number {
    return addCounts(this.resultClassificationCounts.values());
  }

  getUnexpectedToolCallErrorCount(): number {
    return classificationTotal(this.resultClassificationCounts, ENVIRONMENT_FAILURES);
  }

  hasFailedToolCalls(): "true" | "false" {
    return flag(this.getFailedToolCallCount() > 0);
  }

  hasUnexpectedToolCallErrors(): "true" | "false" {
    return flag(this.getUnexpectedToolCallErrorCount() > 0);
  }
}

function countRecordedResult(state: ToolCountingStateTracker, record: ToolResultRecorder): ToolResultRecorder {
  return async (ctx, result, loggedToolName, classification) => {
    await record(ctx, result, loggedToolName, classification);
    state.toolCallCount += 1;

    if (classification === undefined) return;
    const previousCount = state.resultClassificationCounts.get(classification) ?? 0;
    state.resultClassificationCounts.set(classification, previousCount + 1);
  };
}

export function createToolCountingMiddleware(
  state: ToolCountingStateTracker,
): (executor: ToolCountingExecutor) => ToolCountingExecutor {
  return (executor) => ({
    appendMessages(messages) {
      executor.appendMessages(messages);
      return this;
    },
    getState() {
      return executor.getState();
    },
    getMessages() {
      return executor.getMessages();
    },
    clearMessages() {
      executor.clearMessages();
    },
    executeToolStream(ctx, convState, interactionHandler, tools, extraT, recordToolCallResult, descriptionProps, firstToolCallHook) {
      return executor.executeToolStream(
        ctx,
        convState,
        interactionHandler,
        tools,
        extraT,
        countRecordedResult(state, recordToolCallResult),
        descriptionProps,
        firstToolCallHook,
      );
    },
    executeModelStreamOnly(ctx, convState, interactionHandler, tools, descriptionProps, firstToolCallHook) {
      return executor.executeModelStreamOnly(ctx, convState, interactionHandler, tools, descriptionProps, firstToolCallHook);
    },
    stream(ctx, invocationId, tools, options) {
      return executor.stream(ctx, invocationId, tools, options);
    },
  });
}
