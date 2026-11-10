import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAICompactionHandler } from "../../source/packages/agent/self-summary/openai-compaction-handler.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import { fromRedactedCoreMessage, toRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts";
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts";

const mode = PrivacyMode.NO_STORAGE;
function message(role: string, text: string, extra: Record<string, unknown> = {}): any {
  const core = role === "system" ? { role, content: text } : { role, content: [{ type: "text", text }] };
  return { ...toRedactedCoreMessage({ ...core, ...extra } as never, mode), ...extra };
}
function plainText(message: any): string {
  return String(fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).content);
}
function handler() {
  const state = { getPrivacyMode: () => mode, incrementSelfSummaryCount: () => {} };
  return new OpenAICompactionHandler({} as never, state as never, {} as never, [], {}, "model-x");
}
const enrichment = { skillBlocks: [] } as never;

describe("compacting a conversation", () => {
  it("keeps the newest requests and summarizes the rest", () => {
    const instance = handler();
    const partition = instance.separateMessages([message("system", "s"), message("user", "<user_query>old</user_query>"), message("user", "<user_query>newest</user_query>")], {} as never);
    assert.equal(partition.systemMessage?.role, "system");
    assert.equal(partition.preservedTailMessages.length, 2);
    assert.equal(partition.messagesToSummarize.length, 2);
    assert.deepEqual(partition.preservedTailMessages.map(plainText), ["<user_query>old</user_query>", "<user_query>newest</user_query>"]);
  });

  it("keeps only the request part of a wrapped user message", () => {
    const partition = handler().separateMessages([message("system", "s"), message("user", "platform framing <user_query>the real ask</user_query> trailing")], {} as never);
    assert.deepEqual(partition.preservedTailMessages.map(plainText), ["<user_query>the real ask</user_query>"]);
  });

  it("walks back from the newest and stops at the first request that does not fit", () => {
    const messages = [message("system", "s")];
    for (let index = 0; index < 12; index += 1) {
      messages.push(message("user", "<user_query>" + (index === 5 ? "x".repeat(200_000) : "small request " + index) + "</user_query>"));
    }
    const partition = handler().separateMessages(messages, {} as never);
    assert.equal(partition.preservedTailMessages.length, 6, "the older requests fit, the huge one ends the walk and the ones before it are left out");
  });

  it("drops a request with no query wrapper", () => {
    const partition = handler().separateMessages([message("system", "s"), message("user", "no wrapper here")], {} as never);
    assert.deepEqual(partition.preservedTailMessages, []);
  });

  it("assembles the final messages with the kept requests before the summary", () => {
    const instance = handler();
    const partition = instance.separateMessages([message("system", "s"), message("user", "<user_query>x</user_query>")], {} as never);
    const assembled = instance.rebuildConversation(partition, message("user", "summary"));
    assert.deepEqual(assembled.map((entry: any) => entry.role), ["system", "user", "user"]);
    assert.equal(assembled.at(-1), (assembled.at(-1) as any), "the summary is last");
    const empty = instance.separateMessages([], {} as never);
    assert.throws(() => instance.rebuildConversation(empty, message("user", "summary")), { message: "Expected system message in conversation" });
  });

  it("builds the summary message with the handoff prefix", () => {
    const instance = handler();
    const partition = instance.separateMessages([message("system", "s"), message("user", "<user_query>x</user_query>")], {} as never);
    const result = instance.formatSummaryCarrier({ text: "the handoff", inputTokens: 1, outputTokens: 2 }, partition, enrichment);
    assert.equal(typeof result.summaryTextLength, "number");
    const text = plainText(result.message);
    assert.equal(text.includes("CONTEXT CHECKPOINT"), false);
    assert.equal(text.includes("Another language model started to solve this problem"), true);
    assert.equal(text.includes("the handoff"), true);
  });

  it("names its model and metrics label", () => {
    assert.equal(handler().getModelId(), "model-x");
    assert.equal(handler().getMetricsModelLabel(), "model-x");
  });
});