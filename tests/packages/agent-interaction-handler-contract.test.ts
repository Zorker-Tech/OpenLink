import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InteractionHandler } from "../../source/packages/agent/interaction-handler.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { ToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { EditArgs } from "../../source/adapters/interop/proto/generated/agent/v1/edit_tool_pb.ts";

function harness() {
  const sent: Array<{ kind: string; payload: any }> = [];
  const recorded: Array<{ toolCase?: string; callId: string }> = [];
  const provider = {
    async sendUpdate(_ctx: unknown, update: any) {
      const message = update?.message;
      sent.push({ kind: message?.case ?? update?.kind ?? "unknown", payload: message?.value ?? update });
    },
    async query(_ctx: unknown, query: unknown) {
      return { answered: query };
    },
  };
  const recorder = {
    recordToolCall(call: any, callId: string) { recorded.push({ toolCase: call?.tool?.case, callId }); },
  };
  const handler = new InteractionHandler(provider as never, recorder as never, "invocation-1");
  return { handler, sent, recorded };
}
const readCall = () => new ToolCall({ tool: { case: "readToolCall", value: { args: { path: "/a" } } } as never });
const createCall = (args?: unknown) => new ToolCall({ tool: { case: "createAgentToolCall", value: { args } } as never });

describe("what the handler keeps and what it does not", () => {
  it("carries the remainder of a partial token to the next chunk", async () => {
    const { handler, sent } = harness();
    await handler.emitTokenDeltaFromChars("CTX", "abc");
    assert.equal(sent.length, 0, "three characters are not a token yet");
    assert.equal((handler as any).leftoverTokenCharCount, 3);
    await handler.emitTokenDeltaFromChars("CTX", "de");
    assert.deepEqual(sent.map((update) => update.kind), ["token-delta"], "five characters are one Slate token delta, and the remainder waits");
    assert.equal((handler as any).leftoverTokenCharCount, 1);
  });

  it("knows a failure on the consumer side from the model's own failure", () => {
    const { handler } = harness();
    assert.equal(handler.isConsumerSideError(Object.assign(new Error("x"), { name: "CacheRuntimeError" })), true);
    assert.equal(handler.isConsumerSideError(new Error("could not talk to Redis")), true);
    assert.equal(handler.isConsumerSideError(Object.assign(new Error("x"), { stack: "Error: x\n    at sendUpdate" })), true);
    assert.equal(handler.isConsumerSideError(new Error("the model broke")), false);
    assert.equal(handler.isConsumerSideError("boom"), false);
  });

  it("keeps the latest arguments only for a call marked for preservation", () => {
    const { handler } = harness();
    handler.rememberLatestToolCall("call-1", createCall(new EditArgs()));
    assert.equal(handler.latestToolCallsById.size, 0, "an unmarked call is not remembered");
    handler.markToolCallForArgPreservation("call-1");
    handler.rememberToolCallForArgPreservation("call-1", createCall(new EditArgs()));
    assert.equal(handler.latestToolCallsById.size, 1);
    const merged = handler.applyArgsFromLatestToolCall("call-1", createCall());
    assert.notEqual((merged as any).tool.value.args, undefined, "the preserved arguments are merged back in");
  });

  it("announces the started time it remembered", async () => {
    const { handler, sent, recorded } = harness();
    await handler.executeToolCall(createContext(), readCall(), "call-1", async () => ({ ok: true }), () => readCall());
    const started = sent.find((update) => update.kind === "tool-call-update" && update.payload.phase === "started")?.payload;
    assert.equal(typeof started.toolCall.startedAtMs, "bigint", "the started time is written onto the call");
    const completed = sent.find((update) => update.kind === "tool-call-update" && update.payload.phase === "completed")?.payload;
    assert.equal(typeof completed.toolCall.startedAtMs, "bigint", "the completed call carries the remembered start as well");
    assert.equal((handler as any).toolCallStartedAtMsByCallId.size, 0, "the remembered start is cleared once the call is done");
    assert.deepEqual(recorded, [{ toolCase: "readToolCall", callId: "call-1" }]);
  });

  it("keeps a synthetic update's model-call identity", async () => {
    const { handler, sent } = harness();
    await handler.emitToolCallUpdate(createContext(), "completed", "question-1", readCall(), "synthetic-model-1");
    assert.deepEqual(
      [sent[0]?.payload.kind, sent[0]?.payload.phase, sent[0]?.payload.callId, sent[0]?.payload.modelCallId],
      ["tool-call-update", "completed", "question-1", "synthetic-model-1"],
    );
  });
});
