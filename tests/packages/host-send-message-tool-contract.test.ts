import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext, type Context } from "../../source/packages/context/context.ts";
import {
  SLATE_AWAITING_USER_SEND_MESSAGE_BLOCKED,
  buildSlateSendMessage,
  createSendMessageTool,
  type SendMessageDependencies,
} from "../../source/host/runner/tools/send-message-tool.ts";

type WrappedSendTool = {
  descriptionGenerator(): string;
  execute(context: Context, handler: unknown, args: AsyncIterable<string>, meta: { toolCallId: string }): Promise<unknown>;
  render(context: Context, result: unknown, props?: unknown): Promise<unknown>;
};

function dependencies(overrides: Partial<SendMessageDependencies<Context>> = {}): SendMessageDependencies<Context> {
  return {
    getIngestAttachment: () => undefined,
    onSendMessage: () => undefined,
    ...overrides,
  };
}

async function* jsonArgs(value: unknown): AsyncIterable<string> {
  yield JSON.stringify(value);
}

function interactionHandler(options: {
  readonly partials?: unknown[];
  readonly completions?: unknown[];
} = {}) {
  return {
    emitPartialToolCall(_context: Context, _id: string, call: unknown) {
      options.partials?.push(call);
    },
    async executeToolCall(
      context: Context,
      _initial: unknown,
      _id: string,
      execute: (context: Context) => Promise<unknown>,
      complete: (result: unknown) => unknown,
    ) {
      const result = await execute(context);
      options.completions?.push(complete(result));
      return result;
    },
  };
}

describe("SendMessage behavior contract", () => {
  it("describes only Slate-owned message choices and delivery rules", () => {
    const tool = createSendMessageTool(dependencies()) as unknown as WrappedSendTool;
    const description = tool.descriptionGenerator();
    assert.match(description, /SendMessage/);
    assert.match(description, /secret-request/);
    assert.match(description, /widget/);
    assert.equal(/Cursor|Grok/.test(description), false);
  });

  it("resolves text images before measuring them and preserves reply and channel context", async () => {
    const calls: unknown[][] = [];
    const message = await buildSlateSendMessage(createContext(), {
      type: "text",
      content: "  See this  ",
      images: [{ url: "file:///tmp/diagram.png", alt: " diagram " }],
      reply_to: " turn-2 ",
      channel: " room-3 ",
    }, dependencies({
      getIngestAttachment: () => async (sourcePath) => {
        calls.push(["ingest", sourcePath]);
        return "/cache/diagram.png";
      },
      readMediaDimensions: async (sourcePath) => {
        calls.push(["dimensions", sourcePath]);
        return { width: 640, height: 360 };
      },
    }));

    assert.deepEqual(calls, [
      ["ingest", "/tmp/diagram.png"],
      ["dimensions", "/cache/diagram.png"],
    ]);
    assert.deepEqual(message, {
      type: "text",
      content: "See this",
      images: [{ url: "file:///cache/diagram.png", alt: "diagram", width: 640, height: 360 }],
      reply_to: "turn-2",
      channel: "room-3",
    });
  });

  it("keeps widget, remote-agent and secret requests in their own Slate message shapes", async () => {
    const context = createContext();
    const widget = await buildSlateSendMessage(context, {
      type: "widget",
      widget: { prompt: "Continue?", options: [{ label: "Yes" }] },
      reply_to: "turn-1",
    }, dependencies());
    assert.deepEqual(widget, {
      type: "widget",
      widget: { prompt: "Continue?", options: [{ label: "Yes" }] },
      reply_to: "turn-1",
    });

    const remoteAgent = await buildSlateSendMessage(context, { type: "slate-agent", agentId: " bc-7 " }, dependencies({
      resolveCloudAgentTitle: async (_ctx, id) => {
        assert.equal(id, "bc-7");
        return "  Build helper  ";
      },
    }));
    assert.deepEqual(remoteAgent, { type: "slate-agent", agentId: "bc-7", title: "Build helper" });

    const secret = await buildSlateSendMessage(context, {
      type: "secret-request",
      secret: { label: "L".repeat(140), description: "D".repeat(450), connector: "mail", field: "token" },
    }, dependencies());
    assert.equal(secret.type, "secret-request");
    const request = (secret as unknown as { secretRequest: { label: string; description: string; target: unknown } }).secretRequest;
    assert.equal(request.label.length, 120);
    assert.equal(request.description.length, 400);
    assert.deepEqual(request.target, { kind: "channel-credential", platform: "mail", field: "token" });
  });

  it("turns a secure file URL into a text link when the classifier says it is not media", async () => {
    const message = await buildSlateSendMessage(createContext(), {
      type: "attachment",
      url: "https://files.example.test/report.pdf",
      reply_to: "turn-4",
    }, dependencies({ classifyAttachment: () => "file" }));
    assert.deepEqual(message, {
      type: "text",
      content: "https://files.example.test/report.pdf",
      reply_to: "turn-4",
    });
  });

  it("records a completed send once and returns the message identifier", async () => {
    const sent: Array<{ message: unknown; timestamp: number }> = [];
    const partials: unknown[] = [];
    const completions: unknown[] = [];
    const tool = createSendMessageTool(dependencies({
      onSendMessage: (message, timestamp) => {
        sent.push({ message, timestamp });
        return "message-9";
      },
    })) as unknown as WrappedSendTool;

    const result = await tool.execute(
      createContext(),
      interactionHandler({ partials, completions }),
      jsonArgs({ type: "text", content: "Hello" }),
      { toolCallId: "call-9" },
    ) as { result: { case: string; value: { timestamp: bigint; messageId: string } } };

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.message, { type: "text", content: "Hello" });
    assert.equal(result.result.case, "success");
    assert.equal(result.result.value.messageId, "message-9");
    assert.equal(result.result.value.timestamp, BigInt(sent[0]!.timestamp));
    assert.equal(partials.length, 1);
    assert.equal(completions.length, 1);
    assert.equal((completions[0] as { tool: { case: string } }).tool.case, "sendMessageToolCall");
  });

  it("does not send while awaiting the user's answer", async () => {
    let sendCount = 0;
    const tool = createSendMessageTool(dependencies({
      isAwaitingUserSelection: () => true,
      onSendMessage: () => {
        sendCount += 1;
        return "unexpected";
      },
    })) as unknown as WrappedSendTool;

    const result = await tool.execute(
      createContext(),
      interactionHandler(),
      jsonArgs({ type: "text", content: "A second message" }),
      { toolCallId: "call-waiting" },
    ) as { result: { case: string; value: { error: string } } };
    assert.equal(sendCount, 0);
    assert.equal(result.result.case, "error");
    assert.equal(result.result.value.error, SLATE_AWAITING_USER_SEND_MESSAGE_BLOCKED);
  });
});
