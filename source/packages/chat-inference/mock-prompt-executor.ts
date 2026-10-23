/**
 * An executor that answers without a model.
 *
 * It is what the tests and the demo paths use: the answer is built from what was asked, and it goes through the same
 * chain a real answer would.
 */
import { BasePromptBuilder, BasePromptExecutor } from "./base.ts";

type LooseRecord = Record<string, any>;

export interface MockPromptExecutorOptions {
  response?: string;
  toolCalls?: readonly LooseRecord[];
  streamDelay?: number;
  chunkSize?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    maxTokens?: number;
  };
  simulateError?: unknown;
}

interface ResolvedMockOptions {
  response: string;
  toolCalls: readonly LooseRecord[];
  streamDelay: number;
  chunkSize: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    maxTokens: number;
  };
  simulateError?: unknown;
}

export function createMockPromptExecutor(options: () => MockPromptExecutorOptions): MockPromptExecutor {
  return new MockPromptExecutor(() => options(), undefined);
}

export class MockPromptBuilder extends BasePromptBuilder<LooseRecord> {}

export class MockPromptExecutor extends BasePromptExecutor<LooseRecord> {
  readonly options: () => ResolvedMockOptions;

  constructor(options?: () => MockPromptExecutorOptions | undefined, initialMessages?: LooseRecord | readonly LooseRecord[]) {
    super(new MockPromptBuilder(initialMessages));
    this.options = () => {
      const rawOptions = options?.();
      return {
        response: rawOptions?.response ?? "This is a mock response.",
        toolCalls: rawOptions?.toolCalls ?? [],
        streamDelay: rawOptions?.streamDelay ?? 0,
        chunkSize: rawOptions?.chunkSize ?? 1,
        usage: {
          inputTokens: rawOptions?.usage?.inputTokens ?? 10,
          outputTokens: rawOptions?.usage?.outputTokens ?? 20,
          cacheReadTokens: rawOptions?.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: rawOptions?.usage?.cacheWriteTokens ?? 0,
          maxTokens: rawOptions?.usage?.maxTokens ?? 1_000,
        },
        simulateError: rawOptions?.simulateError,
      };
    };
  }

  stream(_ctx: unknown, invocationId?: string, _tools?: readonly LooseRecord[], _options?: LooseRecord) {
    const options = this.options();
    const answerText = options.response;
    const calls = options.toolCalls;
    const chunkLength = options.chunkSize;
    const delayMs = options.streamDelay;
    const failure = options.simulateError;
    const tokenUsage = options.usage;
    const streamParts = (async function*(): AsyncGenerator<LooseRecord> {
      if (answerText) {
        for (let i = 0; i < answerText.length; i += chunkLength) {
          const piece = answerText.slice(i, i + chunkLength);
          if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
          yield { type: "text-delta", textDelta: piece };
        }
      }
      for (const call of calls) {
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        yield {
          type: "tool-call-streaming-start",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        };
        const argumentsJson = JSON.stringify(call.args);
        for (let i = 0; i < argumentsJson.length; i += chunkLength) {
          const piece = argumentsJson.slice(i, i + chunkLength);
          if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
          yield {
            type: "tool-call-delta",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            argsTextDelta: piece,
          };
        }
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        yield {
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.args,
        };
      }
      if (failure) {
        yield { type: "error", error: failure };
        throw failure;
      }
      yield {
        type: "finish",
        finishReason: "stop",
        usage: {
          promptTokens: tokenUsage.inputTokens,
          completionTokens: tokenUsage.outputTokens,
          totalTokens: tokenUsage.inputTokens + tokenUsage.outputTokens,
        },
        logprobs: undefined,
        response: {
          id: "mock-response-id",
          timestamp: new Date(),
          modelId: "mock-model",
        },
      };
    })();

    const response = (async () => {
      const parts: LooseRecord[] = [];
      if (answerText) {
        parts.push({
          type: "text",
          text: failure ? answerText.slice(0, chunkLength) : answerText,
        });
      }
      for (const call of calls) {
        parts.push({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.args,
        });
      }
      const messageList = [{
        role: "assistant",
        content: parts.length > 0 ? parts : "",
        id: "mock-message-id",
      }];
      const answer: LooseRecord = {
        id: "mock-response-id",
        timestamp: new Date(),
        modelId: "mock-model",
        messages: messageList,
      };
      if (failure) {
        answer.error = failure;
      }
      return answer;
    })();
    const usageSummary = Promise.resolve({
      promptTokens: tokenUsage.inputTokens,
      completionTokens: tokenUsage.outputTokens,
      totalTokens: tokenUsage.inputTokens + tokenUsage.outputTokens,
    });
    const detailedUsage = Promise.resolve({
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      cacheReadTokens: tokenUsage.cacheReadTokens,
      cacheWriteTokens: tokenUsage.cacheWriteTokens,
      maxTokens: tokenUsage.maxTokens,
    });
    const metadata = Promise.resolve(undefined);
    return {
      fullStream: streamParts,
      response,
      usage: usageSummary,
      extendedUsage: detailedUsage,
      providerMetadata: metadata,
      invocationId: Promise.resolve(invocationId ?? crypto.randomUUID()),
    };
  }
}
