import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MCP_AUTH_VIRTUAL_TOOL_NAME,
  buildMcpCallSchemas,
  indexMcpDescriptors,
} from "../../source/packages/agent/tools/mcp/mcp-call-options.ts";

const tool = (toolName: string, definitionPath?: string) => ({ toolName, ...(definitionPath === undefined ? {} : { definitionPath }) });
const descriptor = (serverIdentifier: string, tools: ReturnType<typeof tool>[]) => ({ serverIdentifier, serverName: serverIdentifier + "-name", tools });

describe("indexing the MCP descriptors", () => {
  it("indexes Slate server descriptors and remembers definition paths", () => {
    const serverA = descriptor("a", [tool("one", "/defs/a/one.json")]);
    const fromMeta = indexMcpDescriptors({ descriptors: [serverA] });
    assert.deepEqual([...fromMeta.serverDescriptors.keys()], ["a"]);
    assert.deepEqual([...fromMeta.toolDefinitionPaths.entries()], [["a:one", "/defs/a/one.json"]]);
    assert.equal(fromMeta.serverDescriptors.get("a")?.serverName, "a-name");
  });

  it("filters the sign-in tool unless the session is interactive", () => {
    const authTool = tool(MCP_AUTH_VIRTUAL_TOOL_NAME, "/defs/auth.json");
    const ordinary = tool("read");
    const server = descriptor("a", [authTool, ordinary]);
    const closed = indexMcpDescriptors({ descriptors: [server] });
    const filtered = closed.serverDescriptors.get("a")!;
    assert.deepEqual(filtered.tools.map((value) => value.toolName), ["read"]);
    assert.equal(filtered.serverIdentifier, "a");
    assert.deepEqual([...closed.toolDefinitionPaths.keys()], []);
    const interactive = indexMcpDescriptors({ descriptors: [server], allowInteractiveMcpAuth: true });
    assert.deepEqual(interactive.serverDescriptors.get("a")!.tools.map((value) => value.toolName), [MCP_AUTH_VIRTUAL_TOOL_NAME, "read"]);
  });
});

const schemas = (overrides: Record<string, unknown> = {}) => buildMcpCallSchemas({ useDynamicToolNamespaces: false, smartModeClassifierMode: false, ...overrides } as never);

describe("normalizing an MCP call", () => {
  it("moves a dynamic namespace onto the server and keeps the identity", () => {
    const dynamic = schemas({ useDynamicToolNamespaces: true });
    assert.deepEqual(dynamic.normalizeInput({ namespace: "srv", toolName: "read", arguments: { path: "/x" } }), { server: "srv", toolName: "read", arguments: { path: "/x" } });
    assert.deepEqual(dynamic.normalizeInput({ server: "srv", toolName: "read" }), { server: "srv", toolName: "read" });
    assert.throws(() => dynamic.normalizeInput({ arguments: { path: "/x" } }), /Missing required fields: namespace, toolName/);
    assert.throws(() => dynamic.normalizeInput({ namespace: "srv" }), /Missing required field: toolName/);
  });

  it("lifts the description side field", () => {
    const staticSchemas = schemas();
    assert.deepEqual(staticSchemas.normalizeInput({ server: "s", toolName: "t", descriptionForMcp: "why" }), { server: "s", toolName: "t", description: "why" });
    assert.deepEqual(staticSchemas.normalizeInput({ server: "s", toolName: "t", description: "kept", descriptionForMcp: "why" }), { server: "s", toolName: "t", description: "kept" });
  });

  it("recovers arguments sent as a JSON string, including folded metadata", () => {
    const staticSchemas = schemas({ smartModeClassifierMode: true });
    const recovered = staticSchemas.normalizeInput({ server: "s", toolName: "t", arguments: JSON.stringify({ path: "/x" }) }) as Record<string, any>;
    assert.deepEqual(recovered.arguments, { path: "/x" });
    const nested = staticSchemas.normalizeInput({ server: "s", toolName: "t", arguments: JSON.stringify({ path: "/x", mcpDetails: { description: "folded" } }) }) as Record<string, any>;
    assert.deepEqual(nested.arguments, { path: "/x", mcpDetails: { description: "folded" } });
    assert.throws(() => staticSchemas.normalizeInput({ server: "s", toolName: "t", arguments: "{not json" }), /Failed to parse arguments string/);
  });

  it("lifts the approval fields out of the arguments", () => {
    const staticSchemas = schemas({ smartModeClassifierMode: true });
    const normalized = staticSchemas.normalizeInput({ server: "s", toolName: "t", arguments: { path: "/x", requestSmartModeApproval: true, smartModeBlockReason: "blocked" } }) as Record<string, any>;
    assert.deepEqual(normalized.arguments, { path: "/x" });
    assert.equal(normalized.requestSmartModeApproval, true);
    assert.equal(normalized.smartModeBlockReason, "blocked");
    const withoutClassifier = schemas();
    const untouched = withoutClassifier.normalizeInput({ server: "s", toolName: "t", arguments: { requestSmartModeApproval: true } }) as Record<string, any>;
    assert.deepEqual(untouched.arguments, { requestSmartModeApproval: true });
  });
});

describe("validating an MCP call", () => {
  it("parses the flat form with its metadata side fields", () => {
    const staticSchemas = schemas({ smartModeClassifierMode: true });
    const parsed = staticSchemas.parsingParametersSchema.parse({ server: "s", toolName: "t", arguments: { path: "/x" }, description: "why", requestSmartModeApproval: true }) as Record<string, unknown>;
    assert.equal(parsed.server, "s");
    assert.equal(parsed.description, "why");
    assert.equal(parsed.requestSmartModeApproval, true);
    assert.throws(() => staticSchemas.parsingParametersSchema.parse({ server: "s", arguments: {} }));
  });

  it("folds the dynamic metadata object into the flat form", () => {
    const dynamic = schemas({ useDynamicToolNamespaces: true, smartModeClassifierMode: true });
    const parsed = dynamic.parsingParametersSchema.parse({
      namespace: "srv",
      toolName: "t",
      arguments: { path: "/x" },
      mcpDetails: { description: "details why", requestSmartModeApproval: true },
    }) as Record<string, unknown>;
    assert.equal(parsed.server, "srv");
    assert.equal(parsed.description, "details why");
    assert.equal(parsed.requestSmartModeApproval, true);
    const declared = dynamic.parametersSchema.parse({ namespace: "srv", toolName: "t", arguments: {} }) as Record<string, unknown>;
    assert.equal(declared.namespace, "srv");
  });
});
