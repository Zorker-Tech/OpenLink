import { test } from "node:test";
import assert from "node:assert/strict";

import { createWebFetchTool } from "../../source/adapters/interop/agent/web-fetch-tool-adapter.ts";
import type { WebFetchServiceResult } from "../../source/packages/agent/tools/core/web-fetch.ts";
import { createContext, type Context } from "../../source/packages/context/context.ts";
import { ToolCallRejectedError } from "../../source/packages/agent/tools/tool-errors.ts";
import { Responses, type SlateInteractionQuery } from "../../source/packages/agent-core/interaction-queries.ts";
import { WebFetchResult } from "../../source/adapters/interop/proto/generated/agent/v1/web_fetch_tool_pb.ts";

function world(options: { answer?: WebFetchServiceResult; rejectQuery?: string; projectFolder?: string; minimal?: boolean; promptVersion?: string; stripCredentials?: boolean } = {}) {
  const calls: Array<{ toolCall: { toJson(): unknown }; toolCallId: string }> = [];
  const writes: string[] = [];
  const fetched: string[] = [];
  const resourceAccessor = {
    get: () => ({
      async execute(_ctx: Context, args: { path: string; fileText?: string; fileBytes?: Uint8Array }) {
        writes.push(args.path);
        return { result: { case: "success", value: { path: args.path } } };
      },
    }),
  };
  const tool = createWebFetchTool({
    async webFetchService(_ctx, url) { fetched.push(url); return options.answer ?? { content: "# The page" }; },
    ...(options.promptVersion === undefined ? {} : { promptVersion: options.promptVersion }),
    ...(options.minimal === undefined ? {} : { useMinimalHarness: options.minimal }),
    ...(options.projectFolder === undefined ? {} : { projectFolder: options.projectFolder }),
    ...(options.stripCredentials === undefined ? {} : { stripCredentialedUrls: options.stripCredentials }),
    resourceAccessor: resourceAccessor as never,
  });
  const handler = {
    listener: {
      async query(_ctx: Context, query: SlateInteractionQuery) {
        return options.rejectQuery === undefined
          ? Responses.webFetchApproved(query.id)
          : Responses.webFetchRejected(query.id, options.rejectQuery);
      },
    },
    emitPartialToolCall() {},
    async executeToolCall(ctx: Context, call: { toJson(): unknown }, id: string, run: (ctx: Context) => Promise<WebFetchResult>, merge: (result: WebFetchResult) => unknown) {
      calls.push({ toolCall: call, toolCallId: id });
      const result = await run(ctx);
      merge(result);
      return result;
    },
  };
  const argsOf = async function* (value: unknown) { yield JSON.stringify(value); };
  return {
    async run(args: unknown) {
      const result = await (tool as unknown as { execute(ctx: Context, handler: unknown, args: AsyncIterable<string>, meta: unknown): Promise<WebFetchResult> }).execute(createContext(), handler, argsOf(args), { toolCallId: "call-1" });
      return { result, calls, writes, fetched };
    },
    tool,
  };
}

test("the minimal harness keeps its exact one-line description", () => {
  assert.equal((world({ minimal: true }).tool as unknown as { descriptionGenerator(): string }).descriptionGenerator(), "Fetch content from a URL and return it as readable markdown. Prefer this over shell for web content because shell egress is more restricted.");
});

test("the recorded tool call carries the url and the tool call id", async () => {
  const worlded = world();
  const outcome = await worlded.run({ url: "https://example.test/page" });
  const call = outcome.calls[0]?.toolCall.toJson() as { webFetchToolCall?: { args?: { url?: string; toolCallId?: string } } };
  assert.deepEqual({ url: call.webFetchToolCall?.args?.url, toolCallId: call.webFetchToolCall?.args?.toolCallId }, { url: "https://example.test/page", toolCallId: "call-1" });
});

test("a user's refusal carries the reason they gave", async () => {
  const withReason = world({ rejectQuery: "not this one" });
  await assert.rejects(() => withReason.run({ url: "https://example.test/page" }), (error: unknown) => error instanceof ToolCallRejectedError && error.message === "not this one");
  const withoutReason = world({ rejectQuery: "" });
  await assert.rejects(() => withoutReason.run({ url: "https://example.test/page" }), (error: unknown) => error instanceof ToolCallRejectedError && error.message === "User rejected the web fetch");
});

test("a small page stays inline even when a tools folder is available", async () => {
  const worlded = world({ answer: { content: "# Small page\n\nshort" }, projectFolder: "/tmp/project" });
  const result = await worlded.run({ url: "https://example.test/small" });
  assert.equal(result.writes.length, 0);
  const json = result.result.toJson() as { success?: { markdown?: string; outputLocation?: unknown } };
  assert.equal(json.success?.markdown, "# Small page\n\nshort");
  assert.equal(json.success?.outputLocation, undefined);
});

test("a URL without credentials is left exactly as written", async () => {
  const worlded = world({ stripCredentials: true });
  const outcome = await worlded.run({ url: "https://example.test/page?x=1" });
  assert.deepEqual(outcome.fetched, ["https://example.test/page?x=1"]);
});

