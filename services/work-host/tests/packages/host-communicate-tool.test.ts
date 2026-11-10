import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  buildErrorResult,
  buildSuccessResult,
  completedToolCall,
  emptyToolCall,
  encodeError,
  encodeSlateStep,
  encodeSuccess,
  toolCallWrapper,
  SLATE_TOOL_MARKER,
} from "../../source/adapters/interop/agent/communicate-tool-protocol-adapter.ts";
import {
  defineCommunicateTool,
  makeCommunicateRender as makeRender,
  type CommunicateInteractionHandler,
} from "../../source/host/runner/tools/communicate-tool.ts";
import { createContext } from "../../source/packages/context/context.ts";

const argsOf = (call: { tool: { value?: { args?: { currentStep?: string } } } }) => JSON.parse((call.tool.value?.args?.currentStep ?? "null") as string);
const textOf = (result: { content: Array<{ text?: string }> }) => result.content.map((part) => part.text ?? "").join("");

test("a step is a marked json payload", () => {
  const encoded = encodeSlateStep({ phase: "executing", tool: "demo" });
  assert.deepEqual(JSON.parse(encoded), { __slate_tool__: true, phase: "executing", tool: "demo" });
  assert.equal(SLATE_TOOL_MARKER, "__slate_tool__");
  const errorArgs = encodeError("it broke");
  assert.deepEqual(JSON.parse(errorArgs.currentStep ?? ""), { __slate_tool__: true, error: "it broke" });
  const successArgs = encodeSuccess("it worked");
  assert.deepEqual(JSON.parse(successArgs.currentStep ?? ""), { __slate_tool__: true, result: "it worked" });
});

test("an initial tool call names the tool and its activity", () => {
  const call = toolCallWrapper({ phase: "executing", tool: "demo", detail: "doing it", target: "the room" });
  assert.equal(call.tool.case, "communicateUpdateToolCall");
  assert.deepEqual(argsOf(call as never), { __slate_tool__: true, phase: "executing", tool: "demo", detail: "doing it", target: "the room" });
  const empty = emptyToolCall();
  assert.equal(empty.tool.case, "communicateUpdateToolCall");
  assert.equal((empty.tool.value as { args?: unknown }).args, undefined);
});

test("a result carries either success or error", () => {
  const success = buildSuccessResult("the answer");
  assert.equal(success.result.case, "success");
  assert.equal(success.result.value.currentStep, "the answer");
  const failure = buildErrorResult("the reason");
  assert.equal(failure.result.case, "error");
  assert.equal(failure.result.value.error, "the reason");
});

test("a completed call echoes the result into its step", () => {
  const success = completedToolCall(buildSuccessResult("the answer"));
  assert.equal(success.tool.case, "communicateUpdateToolCall");
  assert.deepEqual(argsOf(success as never), { __slate_tool__: true, result: "the answer" });
  assert.deepEqual(success.toJson(), { communicateUpdateToolCall: { args: { currentStep: JSON.stringify({ __slate_tool__: true, result: "the answer" }) }, result: { success: { currentStep: "the answer" } } } });
  const failure = completedToolCall(buildErrorResult(""));
  assert.deepEqual(argsOf(failure as never), { __slate_tool__: true, error: "Tool failed." });
  assert.deepEqual(failure.toJson(), { communicateUpdateToolCall: { args: { currentStep: JSON.stringify({ __slate_tool__: true, error: "Tool failed." }) }, result: { error: {} } } });
});

test("a rendered result says what happened", async () => {
  const render = makeRender();
  const context = createContext();
  assert.equal(textOf(await render(context, buildSuccessResult("the answer"))), "the answer");
  assert.equal(textOf(await render(context, buildSuccessResult(""))), "Tool completed.");
  assert.equal(textOf(await render(context, buildErrorResult("the reason"))), "Error: the reason");
  assert.equal(textOf(await render(context, { result: { case: undefined } } as never)), "Tool completed.");
});

function interactionCapture() {
  const seen: Array<{ initial: unknown; toolCallId: string; completed: unknown }> = [];
  const handler: CommunicateInteractionHandler = {
    async executeToolCall(context, initial, toolCallId, execute, complete) {
      const result = await execute(context);
      const completed = complete(result);
      seen.push({ initial, toolCallId, completed });
      return result;
    },
  };
  return { handler, seen };
}

const streamOf = async function* (value: unknown) {
  yield JSON.stringify(value);
};

test("a defined tool runs inside the interaction wrapper", async () => {
  const { handler, seen } = interactionCapture();
  const tool = defineCommunicateTool({ extra: "dep" }, {
    id: "demo-id",
    name: "demo",
    description: "a demo tool",
    parameters: z.object({ channel: z.string() }),
    describeActivity: (args: { channel: string }) => ({ detail: "to " + args.channel, target: args.channel }),
    async execute(_context, args, deps) {
      return "said to " + args.channel + " with " + deps.extra + " at " + deps.toolCallId;
    },
  });
  const result = await (tool.execute as Function)(createContext(), handler, streamOf({ channel: "room" }), { toolCallId: "call-7" });
  assert.deepEqual(result.toJson(), { success: { currentStep: "said to room with dep at call-7" } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.toolCallId, "call-7");
  assert.deepEqual(argsOf(seen[0]!.initial as never), { __slate_tool__: true, phase: "executing", tool: "demo", detail: "to room", target: "room" });
  assert.deepEqual((seen[0]!.completed as { toJson(): unknown }).toJson(), { communicateUpdateToolCall: { args: { currentStep: JSON.stringify({ __slate_tool__: true, result: "said to room with dep at call-7" }) }, result: { success: { currentStep: "said to room with dep at call-7" } } } });
});

test("a tool that throws yields an error result in the same wrapper", async () => {
  const { handler, seen } = interactionCapture();
  const tool = defineCommunicateTool({}, {
    id: "fail-id",
    name: "fail",
    description: "fails",
    parameters: z.object({}),
    async execute() { throw new Error("it broke"); },
  });
  const result = await (tool.execute as Function)(createContext(), handler, streamOf({}), { toolCallId: "call-8" });
  assert.deepEqual(result.toJson(), { error: { error: "it broke" } });
  assert.deepEqual((seen[0]!.completed as { toJson(): unknown }).toJson(), { communicateUpdateToolCall: { args: { currentStep: JSON.stringify({ __slate_tool__: true, error: "it broke" }) }, result: { error: { error: "it broke" } } } });
});

test("a tool that throws something other than an error still has a message", async () => {
  const { handler } = interactionCapture();
  const tool = defineCommunicateTool({}, {
    id: "str-fail-id",
    name: "str-fail",
    description: "fails oddly",
    parameters: z.object({}),
    async execute() { throw "plain failure"; },
  });
  const result = await (tool.execute as Function)(createContext(), handler, streamOf({}), { toolCallId: "call-9" });
  assert.deepEqual(result.toJson(), { error: { error: "plain failure" } });
});

test("a serialized error becomes an error tool call", () => {
  const tool = defineCommunicateTool({}, {
    id: "serialize-id",
    name: "serialize",
    description: "serializes",
    parameters: z.object({}),
    async execute() { return "never"; },
  });
  const call = (tool.serializeError as (error: unknown) => { toJson(): unknown })(new Error("bad call"));
  assert.deepEqual(call.toJson(), { communicateUpdateToolCall: { args: { currentStep: JSON.stringify({ __slate_tool__: true, error: "bad call" }) }, result: { error: { error: "bad call" } } } });
});

