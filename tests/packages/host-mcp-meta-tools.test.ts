import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SlateToolCallExecutionTimeoutError,
  createSlateMcpMetaToolOptions,
  slateToolCallExecutionTimeoutMs,
  wrapDynamicInvocationToolWithTimeout,
} from "../../source/host/runner/tools/mcp-meta-tools.ts";

const streamOf = (...chunks: string[]) => (async function* () { for (const chunk of chunks) yield chunk; })();

describe("the meta-tool execution guards", () => {
  it("resolves a positive execution timeout for tools and subagents", () => {
    assert.equal(slateToolCallExecutionTimeoutMs("McpTool", false) > 0, true);
    assert.equal(slateToolCallExecutionTimeoutMs("McpTool", true) > 0, true);
    assert.equal(typeof slateToolCallExecutionTimeoutMs("McpTool", false), "number");
  });

  it("names the timeout error and carries the call it guarded", () => {
    const failure = new SlateToolCallExecutionTimeoutError("McpTool", 1234);
    assert.equal(failure instanceof Error, true);
    assert.equal(failure.name, "ToolCallExecutionTimeoutError");
    assert.equal(failure.toolName, "McpTool");
    assert.equal(failure.executionTimeoutMs, 1234);
    assert.equal(failure.message.includes("McpTool"), true);
  });
});

describe("wrapping a dynamic invocation tool", () => {
  it("replays the collected arguments into the tool and returns its result", async () => {
    const seen: string[] = [];
    const tool = {
      name: "default-tool",
      async execute(_context: unknown, _handler: unknown, chunks: AsyncIterable<string>) {
        for await (const chunk of chunks) seen.push(chunk);
        return "result-value";
      },
    };
    const wrapped = wrapDynamicInvocationToolWithTimeout(tool as never, { resolveToolName: (raw) => raw.includes("x") ? "resolved-tool" : undefined }, false) as unknown as { name: string; execute: (...args: any[]) => Promise<unknown> };
    assert.equal(wrapped.name, "default-tool");
    const result = await wrapped.execute({}, {}, streamOf("{", "\"x\":1", "}") as never, {} as never);
    assert.equal(result, "result-value");
    assert.deepEqual(seen, ['{"x":1}']);
  });

  it("keeps an unresolved name and propagates a failed execution", async () => {
    const tool = { name: "plain-tool", async execute() { throw new Error("tool failed"); } };
    const wrapped = wrapDynamicInvocationToolWithTimeout(tool as never, { resolveToolName: () => undefined }, true) as unknown as { execute: (...args: any[]) => Promise<unknown> };
    await assert.rejects(wrapped.execute({}, {}, streamOf("{}") as never, {} as never), /tool failed/);
  });
});

describe("building the MCP meta-tool options", () => {
  it("groups tools by server, keeps the first metadata and sorts their names", () => {
    const options = createSlateMcpMetaToolOptions([
      { providerIdentifier: "server-b", toolName: "zeta" },
      { providerIdentifier: "server-a", toolName: "gamma", plugin: "p", marketplace: "m", pluginId: "pid", marketplaceId: "mid" },
      { providerIdentifier: "server-a", toolName: "beta", description: "b" },
      { providerIdentifier: "server-a", toolName: "alpha", inputSchema: { type: "object" } },
    ]);
    assert.equal(options.enabled, true);
    assert.deepEqual(options.mcpDescriptors.map((descriptor) => descriptor.serverIdentifier), ["server-b", "server-a"]);
    const serverA = options.mcpDescriptors[1]!;
    assert.deepEqual(serverA.tools.map((tool) => tool.toolName), ["alpha", "beta", "gamma"]);
    assert.deepEqual(serverA.tools[0]!.inputSchema, { type: "object" });
    assert.equal(serverA.tools[1]!.description, "b");
    assert.equal(serverA.plugin, "p");
    assert.equal(serverA.marketplace, "m");
    assert.equal(serverA.pluginDbId, "pid");
    assert.equal(serverA.marketplaceId, "mid");
    assert.equal(serverA.serverName, "server-a");
  });

  it("returns no descriptors for no tools", () => {
    assert.deepEqual(createSlateMcpMetaToolOptions([]), { enabled: true, mcpDescriptors: [] });
  });
});
