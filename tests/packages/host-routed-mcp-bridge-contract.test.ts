import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRoutedMcpBridge } from "../../source/coordinator/routed-mcp-bridge.ts";

type Bridge = Awaited<ReturnType<typeof createRoutedMcpBridge>>;

async function withBridge(
  deps: Parameters<typeof createRoutedMcpBridge>[0],
  run: (bridge: Bridge) => Promise<void>,
): Promise<void> {
  const bridge = await createRoutedMcpBridge(deps);
  try {
    await run(bridge);
  } finally {
    await bridge.close();
  }
}

async function post(bridge: Bridge, body: string, url = bridge.url, method = "POST"): Promise<Response> {
  return fetch(url, { method, headers: { "content-type": "application/json" }, body });
}

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

describe("the routed tool bridge contract", () => {
  it("binds only a loopback address and gives each bridge a private route", async () => {
    await withBridge({ listTools: async () => [], callTool: async () => ({}) }, async (bridge) => {
      assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]{36}$/);
      assert.notEqual(bridge.url, "http://127.0.0.1:0/mcp/");
    });
  });

  it("returns 404 for a different method or an unrecognized route", async () => {
    await withBridge({ listTools: async () => [], callTool: async () => ({}) }, async (bridge) => {
      assert.equal((await fetch(bridge.url, { method: "GET" })).status, 404);
      assert.equal((await post(bridge, "{}", `${bridge.url}/other`)).status, 404);
    });
  });

  it("refuses oversized request bodies before parsing them", async () => {
    await withBridge({ listTools: async () => [], callTool: async () => ({}) }, async (bridge) => {
      const atLimit = await post(bridge, "x".repeat(1_048_576));
      assert.equal(atLimit.status, 400);
      const response = await post(bridge, "x".repeat(1_048_577));
      assert.equal(response.status, 413);
      assert.equal(await response.text(), "");
    });
  });

  it("returns 400 for malformed JSON", async () => {
    await withBridge({ listTools: async () => [], callTool: async () => ({}) }, async (bridge) => {
      const response = await post(bridge, "{broken");
      assert.equal(response.status, 400);
      assert.equal(await response.text(), "");
    });
  });

  it("answers initialization with the supported protocol and Slate server identity", async () => {
    await withBridge({ listTools: async () => [], callTool: async () => ({}) }, async (bridge) => {
      const response = await post(bridge, JSON.stringify(rpc(7, "initialize")));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        jsonrpc: "2.0",
        id: 7,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "slate-plugins", version: "1" },
        },
      });
    });
  });

  it("acknowledges the initialization notification without a response body", async () => {
    await withBridge({ listTools: async () => [], callTool: async () => ({}) }, async (bridge) => {
      const response = await post(bridge, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      assert.equal(response.status, 202);
      assert.equal(await response.text(), "");
    });
  });

  it("lists only complete tool definitions and derives descriptions, schemas and access hints", async () => {
    const definitions = [
      { name: "read-document", providerIdentifier: "files", toolName: "fetch", description: "Read a document", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "change-document", providerIdentifier: "files", toolName: "update", inputSchema: ["invalid"] },
      { name: "missing-provider", toolName: "fetch" },
      { name: "missing-tool", providerIdentifier: "files" },
      "not-a-record",
    ];
    await withBridge({ listTools: async () => definitions, callTool: async () => ({}) }, async (bridge) => {
      const response = await post(bridge, JSON.stringify(rpc(1, "tools/list")));
      const body = await response.json() as { result: { tools: Array<Record<string, unknown>> } };
      assert.deepEqual(body.result.tools, [
        {
          name: "read-document",
          description: "Read a document",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        {
          name: "change-document",
          description: "update via files",
          inputSchema: { type: "object", additionalProperties: true },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
      ]);
    });
  });

  it("refreshes the available tool map on each list request", async () => {
    let current: unknown = [{ name: "first", providerIdentifier: "p", toolName: "read" }];
    const calls: unknown[] = [];
    await withBridge({ listTools: async () => current, callTool: async (args) => { calls.push(args); return { result: { case: "success", value: { content: [] } } }; } }, async (bridge) => {
      await post(bridge, JSON.stringify(rpc(1, "tools/list")));
      current = [];
      await post(bridge, JSON.stringify(rpc(2, "tools/list")));
      const response = await post(bridge, JSON.stringify(rpc(3, "tools/call", { name: "first" })));
      const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
      assert.equal(calls.length, 0);
      assert.deepEqual(body.result, { isError: true, content: [{ type: "text", text: "Unknown Slate plugin tool: first" }] });
    });
  });

  it("maps text and image results, preserves structured content and generates a call id", async () => {
    const calls: Array<{ args: unknown; toolCallId: string; providerIdentifier: string; toolName: string }> = [];
    const tools = [{ name: "inspect", providerIdentifier: "files", toolName: "read", description: "Read a file" }];
    await withBridge({
      listTools: async () => tools,
      callTool: async (args) => {
        calls.push(args);
        return { result: { case: "success", value: {
          content: [
            { content: { case: "text", value: { text: "complete" } } },
            { content: { case: "image", value: { data: "aGVsbG8=", mimeType: "image/png" } } },
            { content: { case: "resource", value: { uri: "resource://ignored" } } },
          ],
          structuredContent: { ok: true },
        } } };
      },
    }, async (bridge) => {
      await post(bridge, JSON.stringify(rpc(1, "tools/list")));
      const response = await post(bridge, JSON.stringify(rpc(2, "tools/call", { name: "inspect", arguments: { path: "a.txt" } })));
      const body = await response.json() as { result: Record<string, unknown> };
      assert.deepEqual(body.result, {
        isError: false,
        content: [{ type: "text", text: "complete" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        structuredContent: { ok: true },
      });
      assert.deepEqual(calls.map(({ args, providerIdentifier, toolName }) => ({ args, providerIdentifier, toolName })), [
        { args: { path: "a.txt" }, providerIdentifier: "files", toolName: "read" },
      ]);
      assert.match(calls[0]!.toolCallId, /^[0-9a-f-]{36}$/);
    });
  });

  it("uses empty arguments when call arguments are absent or not a record", async () => {
    const calls: unknown[] = [];
    await withBridge({
      listTools: async () => [{ name: "read", providerIdentifier: "p", toolName: "read" }],
      callTool: async (args) => { calls.push(args.args); return { result: { case: "success", value: { content: [] } } }; },
    }, async (bridge) => {
      await post(bridge, JSON.stringify(rpc(1, "tools/list")));
      await post(bridge, JSON.stringify(rpc(2, "tools/call", { name: "read" })));
      await post(bridge, JSON.stringify(rpc(3, "tools/call", { name: "read", arguments: ["not", "a", "record"] })));
      assert.deepEqual(calls, [{}, ["not", "a", "record"]]);
    });
  });

  it("maps tool failures to a readable error and serializes unknown result envelopes", async () => {
    const results: unknown[] = [
      { result: { case: "failure", value: { error: "permission denied" } } },
      { result: { case: "failure", value: { code: 7 } } },
    ];
    await withBridge({
      listTools: async () => [{ name: "read", providerIdentifier: "p", toolName: "read" }],
      callTool: async () => results.shift(),
    }, async (bridge) => {
      await post(bridge, JSON.stringify(rpc(1, "tools/list")));
      const first = await post(bridge, JSON.stringify(rpc(2, "tools/call", { name: "read" })));
      const second = await post(bridge, JSON.stringify(rpc(3, "tools/call", { name: "read" })));
      assert.deepEqual((await first.json() as { result: unknown }).result, { isError: true, content: [{ type: "text", text: "permission denied" }] });
      assert.deepEqual((await second.json() as { result: unknown }).result, { isError: true, content: [{ type: "text", text: JSON.stringify({ result: { case: "failure", value: { code: 7 } } }) }] });
    });
  });

  it("serializes a successful result when it has no supported content", async () => {
    await withBridge({
      listTools: async () => [{ name: "read", providerIdentifier: "p", toolName: "read" }],
      callTool: async () => ({ result: { case: "success", value: { content: [{ content: { case: "unknown", value: {} } }], isError: true } } }),
    }, async (bridge) => {
      await post(bridge, JSON.stringify(rpc(1, "tools/list")));
      const response = await post(bridge, JSON.stringify(rpc(2, "tools/call", { name: "read" })));
      const body = await response.json() as { result: unknown };
      assert.deepEqual(body.result, { isError: true, content: [{ type: "text", text: JSON.stringify({ content: [{ content: { case: "unknown", value: {} } }], isError: true }) }] });
    });
  });

  it("converts thrown tool errors to an MCP error result", async () => {
    await withBridge({
      listTools: async () => [{ name: "read", providerIdentifier: "p", toolName: "read" }],
      callTool: async () => { throw new Error("provider unavailable"); },
    }, async (bridge) => {
      await post(bridge, JSON.stringify(rpc(1, "tools/list")));
      const response = await post(bridge, JSON.stringify(rpc(2, "tools/call", { name: "read" })));
      assert.deepEqual((await response.json() as { result: unknown }).result, { isError: true, content: [{ type: "text", text: "provider unavailable" }] });
    });
  });

  it("answers an unknown JSON-RPC method with an empty result", async () => {
    await withBridge({ listTools: async () => [], callTool: async () => ({}) }, async (bridge) => {
      const response = await post(bridge, JSON.stringify(rpc(4, "unknown/method")));
      assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 4, result: {} });
    });
  });
});
