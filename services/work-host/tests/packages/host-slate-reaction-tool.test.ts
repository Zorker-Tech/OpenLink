import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext, type Context } from "../../source/packages/context/context.ts";
import type { ToolExecutionMetaLike } from "../../source/packages/agent/tools/tool-support.ts";
import {
  createReactToMessageTool,
  reactToMessageParameters,
  SLATE_REACT_TO_MESSAGE_TOOL_NAME,
  type ReactToMessageDependencies,
} from "../../source/host/runner/tools/slate-reaction-tool.ts";
import type { CommunicateInteractionHandler } from "../../source/host/runner/tools/communicate-tool.ts";
import type { CommunicateToolCall } from "../../source/adapters/interop/agent/communicate-tool-protocol-adapter.ts";

interface ReactionToolView {
  readonly name: string;
  readonly toolIdentifier: string;
  readonly descriptionGenerator: () => string;
  readonly execute: (
    context: Context,
    handler: unknown,
    argsStream: AsyncIterable<string>,
    metadata: ToolExecutionMetaLike,
  ) => Promise<unknown>;
}

interface ToolReply {
  readonly case: string | undefined;
  readonly text: string | undefined;
}

async function* streamArguments(value: unknown): AsyncIterable<string> {
  yield JSON.stringify(value);
}

async function invoke(tool: ReactionToolView, args: unknown): Promise<ToolReply> {
  const context = createContext();
  const handler: CommunicateInteractionHandler & {
    emitPartialToolCall(context: Context, callId: string, call: unknown): void;
  } = {
    emitPartialToolCall: () => {},
    async executeToolCall<Result>(
      _context: Context,
      _startedCall: CommunicateToolCall,
      _callId: string,
      execute: (context: Context) => Promise<Result>,
      complete: (outcome: Result) => CommunicateToolCall,
    ): Promise<Result> {
      const outcome = await execute(context);
      complete(outcome);
      return outcome;
    },
  };

  const outcome = await tool.execute(context, handler, streamArguments(args), { toolCallId: "reaction-call" });
  const result = (outcome as { readonly result?: { readonly case?: string; readonly value?: { readonly currentStep?: string } } }).result;
  return { case: result?.case, text: result?.value?.currentStep };
}

function makeTool(calls: Array<{ readonly messageAddress: string; readonly emoji: string }> = []): ReactionToolView {
  const dependencies: ReactToMessageDependencies = {
    react: (request) => calls.push(request),
  };
  return createReactToMessageTool(dependencies) as unknown as ReactionToolView;
}

describe("the message reaction tool", () => {
  it("describes a Slate action without external product wording", () => {
    const tool = makeTool();
    const description = tool.descriptionGenerator();

    assert.equal(tool.name, SLATE_REACT_TO_MESSAGE_TOOL_NAME);
    assert.equal(tool.toolIdentifier, "SEND_TO_USER");
    assert.match(description, /user's own message|message written by the user/i);
    assert.match(description, /reply/i);
    assert.match(description, /same emoji/i);
    assert.match(description, /turn/i);
    assert.match(description, /habits|match|mirror/i);
    assert.doesNotMatch(description, /iMessage/i);
  });

  it("trims both inputs and rejects empty or oversized values", () => {
    const parsed = reactToMessageParameters.safeParse({ message_address: " t3u ", emoji: " 👍 " });
    assert.equal(parsed.success, true);
    if (parsed.success) assert.deepEqual(parsed.data, { message_address: "t3u", emoji: "👍" });

    assert.equal(reactToMessageParameters.safeParse({ message_address: "  ", emoji: "👍" }).success, false);
    assert.equal(reactToMessageParameters.safeParse({ message_address: "t3u", emoji: "  " }).success, false);
    assert.equal(reactToMessageParameters.safeParse({ message_address: "t3u", emoji: "x".repeat(17) }).success, false);
  });

  it("reacts to one valid user-message address and reports the reversible result", async () => {
    const calls: Array<{ readonly messageAddress: string; readonly emoji: string }> = [];
    const result = await invoke(makeTool(calls), { message_address: " t3u ", emoji: " 👍 " });

    assert.deepEqual(calls, [{ messageAddress: "t3u", emoji: "👍" }]);
    assert.equal(result.case, "success");
    assert.match(result.text ?? "", /👍.*t3u/);
    assert.match(result.text ?? "", /again.*remove|toggle/i);
  });

  it("does not call the reaction port when the address is malformed", async () => {
    const calls: Array<{ readonly messageAddress: string; readonly emoji: string }> = [];
    const result = await invoke(makeTool(calls), { message_address: "not-a-message", emoji: "👍" });

    assert.deepEqual(calls, []);
    assert.equal(result.case, "success");
    assert.match(result.text ?? "", /not-a-message/);
    assert.match(result.text ?? "", /message address/i);
  });
});
