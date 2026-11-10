/**
 * Tracing a prompt through the chain.
 *
 * A span is opened for the prompt and for each middleware it passes through, so a slow chain can be read as the
 * sequence it was rather than as one opaque call.
 */
import { createCounter, createHistogram } from "../../metrics/index.ts";
import { BaseMiddleware, type PromptExecutor } from "../base.ts";
import type { Context } from "../../context/context.ts";

type LooseRecord = Record<string, any>;

interface TracedPromptStream {
  readonly fullStream: AsyncIterable<LooseRecord>;
  readonly response: Promise<LooseRecord>;
  readonly usage: Promise<unknown>;
  readonly providerMetadata: Promise<unknown>;
  readonly extendedUsage: Promise<unknown>;
  readonly invocationId: Promise<unknown>;
}

function messageTextOf(message: LooseRecord): string {
  if (message.role === "user" || message.role === "assistant") {
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content.map((event: LooseRecord) => {
        if (event.type === "text" && "text" in event) {
          return event.text;
        }
        return "";
      }).join("");
    }
  }
  if (message.role === "tool") {
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content.map((event: LooseRecord) => {
        if (event.type === "tool-result" && "result" in event) {
          return typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        }
        return "";
      }).join("");
    }
  }
  return "";
}

function summarizeMessages(messages: readonly LooseRecord[]) {
  const stats = {
    userMessages: 0,
    assistantMessages: 0,
    toolMessages: 0,
    userCharacters: 0,
    assistantCharacters: 0,
    toolCharacters: 0,
  };
  for (const message of messages) {
    const messageText = messageTextOf(message);
    const characterCount = messageText.length;
    switch (message.role) {
      case "user":
        stats.userMessages++;
        stats.userCharacters += characterCount;
        break;
      case "assistant":
        stats.assistantMessages++;
        stats.assistantCharacters += characterCount;
        break;
      case "tool":
        stats.toolMessages++;
        stats.toolCharacters += characterCount;
        break;
    }
  }
  return stats;
}

const chainDurationHistogram = createHistogram("agent.ttft.middlewareChainMs", {
  description: "Total synchronous time inside the middleware chain from tracing middleware entry to inner stream() returning (may exclude async preprocessing done by middleware wrappers)",
});
const firstTokenHistogram = createHistogram("chat_inference.ttft_ms", {
  description: "Time to first token in milliseconds",
  labelNames: ["outcome"],
});
const firstToolCallHistogram = createHistogram("chat_inference.ttf_toolcall_ms", {
  description: "Time to first tool call in milliseconds",
  labelNames: ["outcome"],
});
const endToEndHistogram = createHistogram("chat_inference.e2e_latency_ms", {
  description: "End-to-end latency in milliseconds",
  labelNames: ["outcome"],
});
const messageCountHistogram = createHistogram("chat_inference.input_messages", {
  description: "Distribution of input message counts per request",
  labelNames: ["message_type"],
});
const characterCountHistogram = createHistogram("chat_inference.input_characters", {
  description: "Distribution of input character counts per request",
  labelNames: ["message_type"],
});
const outcomeCounter = createCounter("chat_inference.request_outcome", {
  description: "Count of request outcomes",
  labelNames: ["outcome"],
});

export class TracingMiddleware extends BaseMiddleware<LooseRecord> {
  override stream(ctx: Context, invocationId?: string, tools?: readonly LooseRecord[], options?: LooseRecord): TracedPromptStream {
    const chainStart = performance.now();
    let firstTokenAt: number | null = null;
    let tokenSeen = false;
    let firstToolCallAt: number | null = null;
    let toolCallSeen = false;
    const messages = this.innerExecutor.getMessages();
    const stats = summarizeMessages(messages);
    messageCountHistogram.histogram(ctx, stats.userMessages, { message_type: "user" });
    messageCountHistogram.histogram(ctx, stats.assistantMessages, { message_type: "assistant" });
    messageCountHistogram.histogram(ctx, stats.toolMessages, { message_type: "tool" });
    characterCountHistogram.histogram(ctx, stats.userCharacters, { message_type: "user" });
    characterCountHistogram.histogram(ctx, stats.assistantCharacters, { message_type: "assistant" });
    characterCountHistogram.histogram(ctx, stats.toolCharacters, { message_type: "tool" });
    const innerResult = this.innerExecutor.stream(ctx, invocationId, tools, options) as TracedPromptStream;
    chainDurationHistogram.histogram(ctx, performance.now() - chainStart);

    const tracedFullStream = async function*(): AsyncGenerator<LooseRecord> {
      try {
        for await (const event of innerResult.fullStream) {
          if (!tokenSeen) {
            firstTokenAt = performance.now();
            tokenSeen = true;
            const timeToFirstToken = firstTokenAt - chainStart;
            firstTokenHistogram.histogram(ctx, timeToFirstToken, { outcome: "success" });
          }
          if (!toolCallSeen && (event.type === "tool-call" || event.type === "tool-call-delta")) {
            firstToolCallAt = performance.now();
            toolCallSeen = true;
            const timeToFirstToolCall = firstToolCallAt - chainStart;
            firstToolCallHistogram.histogram(ctx, timeToFirstToolCall, { outcome: "success" });
          }
          yield event;
        }
      } catch (cause) {
        if (!tokenSeen) {
          firstTokenHistogram.histogram(ctx, performance.now() - chainStart, { outcome: "failure" });
        }
        throw cause;
      }
    };

    const tracedResponse = innerResult.response.then((answer) => {
      const finishedAt = performance.now();
      const elapsed = finishedAt - chainStart;
      endToEndHistogram.histogram(ctx, elapsed, { outcome: "success" });
      if (answer.error) {
        outcomeCounter.increment(ctx, 1, { outcome: "failure" });
      } else {
        outcomeCounter.increment(ctx, 1, { outcome: "success" });
      }
      return answer;
    }).catch((cause: unknown) => {
      const finishedAt = performance.now();
      const elapsed = finishedAt - chainStart;
      endToEndHistogram.histogram(ctx, elapsed, { outcome: "failure" });
      outcomeCounter.increment(ctx, 1, { outcome: "failure" });
      throw cause;
    });

    return {
      fullStream: tracedFullStream(),
      response: tracedResponse,
      usage: innerResult.usage,
      providerMetadata: innerResult.providerMetadata,
      extendedUsage: innerResult.extendedUsage,
      invocationId: innerResult.invocationId,
    };
  }
}

export const createTracingMiddleware = () => {
  return (executor: PromptExecutor<LooseRecord>): TracingMiddleware => new TracingMiddleware(executor);
};

export const tracingMiddleware = createTracingMiddleware();
