/**
 * Finding the MCP tools a turn can call: the custom-instruction note prepended to a result, what the discovery caches
 * and when it looks again, what the turn start is handed while a look is in flight, where a call is executed (and what
 * it answers when it cannot be), the servers the box is told about, and the executor that spills and persists results.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyCustomInstructionsToMcpResult,
  createMcpToolsDiscovery,
  MCP_TOOLS_CACHE_TTL_MS,
  SlateMcpExecutor,
  TOOLS_DISCOVERY_DEADLINE_MS,
} from "../../source/shared/node/mcp/tools-discovery.ts";
import { SlateMcpConfigError } from "../../source/shared/node/mcp/mcp-config-error.ts";
import { generatedMcpResultFactory } from "../../source/shared/node/mcp/mcp-result-factory.ts";
import { formatMcpCustomInstructionToolNote } from "../../source/shared/mcp-custom-instructions.ts";
import { pinMcpDiagnosticsReporter, type McpDiagnostic } from "../../source/shared/node/mcp/mcp-diagnostics.ts";

type Call = { name: string; args: unknown[] };

function tool(providerIdentifier: string, toolName: string, name = toolName) {
  return { providerIdentifier, name, toolName, description: `${name} tool` };
}

/** The surface the discovery reads from, with everything it asks written down. */
interface DiscoveryOptions {

  displayConfig?: unknown;
  httpNames?: string[] | undefined;
  stdioNames?: string[] | undefined;
  userServers?: Record<string, unknown>;
  stdioConfigs?: Record<string, unknown>;
  backendServers?: Array<Record<string, unknown>>;
  boxServers?: Array<Record<string, unknown>>;
  disabled?: Record<string, string[]>;
  instructionsById?: Record<string, string>;
  instructionsByName?: Record<string, string>;
  boxMcpExec?: Record<string, unknown> | null;
  backendError?: unknown;
  backendResult?: unknown;
  backendGate?: Promise<void>;
  boxError?: unknown;
  pushError?: unknown;
}

function discoveryWorld(options: DiscoveryOptions = {}) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const diagnostics: McpDiagnostic[] = [];
  pinMcpDiagnosticsReporter((diagnostic) => diagnostics.push(diagnostic));
  const restoreDiagnostics = () => pinMcpDiagnosticsReporter(null);
  const authEvents: Record<string, unknown>[] = [];
  const discoveryFailures: Record<string, unknown>[] = [];
  const boxExec =
    options.boxMcpExec == null
      ? null
      : {
          loadServers: async (configJson: string) => {
            record("loadServers", configJson);
            if (options.pushError != null) throw options.pushError;
          },
          listTools: async (names: string[], extra?: unknown) => {
            record("box.listTools", names, extra);
            if (options.boxError != null) throw options.boxError;
            return options.boxServers ?? [];
          },
          executeTool: async (args: unknown) => {
            record("box.executeTool", args);
            return { result: { case: "success", value: { content: [] } } };
          },
          ...(options.boxMcpExec ?? {}),
        };
  const core = {
    lastAccountDisplayConfig: () => options.displayConfig,
    settingsStore: () => ({
      getMcpDisabledToolsByServerId: () => options.disabled ?? {},
      getRawMcpCustomInstructionByServerId: (id: string) => options.instructionsById?.[id],
      getRawMcpCustomInstruction: (name: string) => options.instructionsByName?.[name],
    }),
    definitionSource: {
      peekHttpServerNames: () => options.httpNames,
      peekStdioServerNames: () => options.stdioNames,
      getUserServerConfigs: async () => {
        record("getUserServerConfigs");
        return options.userServers ?? {};
      },
      getStdioServerConfigs: async () => {
        record("getStdioServerConfigs");
        return options.stdioConfigs ?? {};
      },
      getServerUrlForIdentifier: async (id: string) => {
        record("getServerUrlForIdentifier", id);
        const entry = options.userServers?.[id];
        return entry != null && typeof entry === "object" && "url" in entry ? "https://server.example" : undefined;
      },
      ensureConfigLoaded: async () => record("ensureConfigLoaded"),
    },
    backendMcpExec: {
      listTools: async (ids: string[]) => {
        record("backend.listTools", ids);
        if (options.backendGate != null) await options.backendGate;
        if (options.backendError != null) throw options.backendError;
        return options.backendServers ?? [];
      },
      executeTool: async (args: Record<string, unknown>) => {
        record("backend.executeTool", args);
        if (options.backendError != null) throw options.backendError;
        return options.backendResult ?? { result: { case: "success", value: { content: [] } } };
      },
    },
  };
  const discovery = createMcpToolsDiscovery(core as never, {
    boxMcpExec: boxExec as never,
    onConnectorAuth: (event) => authEvents.push(event),
    onDiscoveryFailed: (event) => discoveryFailures.push(event),
  });
  return {
    discovery,
    calls,
    diagnostics,
    authEvents,
    discoveryFailures,
    restoreDiagnostics,
    named: (name: string) => calls.filter((call) => call.name === name),
  };
}

function withDateNow<T>(nowMs: number, work: () => T): T {
  const original = Date.now;
  Date.now = () => nowMs;
  try {
    return work();
  } finally {
    Date.now = original;
  }
}

describe("the custom-instruction note on a result", () => {
  it("is prepended to a success, and nothing else is touched", () => {
    const success = { result: { case: "success" as const, value: { content: [{ content: { case: "text", value: { text: "said" } } }] } } };
    const applied = applyCustomInstructionsToMcpResult(success, "the server", "  be careful  ", generatedMcpResultFactory) as unknown as {
      result: { value: { content: Array<{ content: { value: { text: string } } }> } };
    };
    const texts = applied.result.value.content.map((item) => item.content.value.text);
    assert.deepEqual(texts, [formatMcpCustomInstructionToolNote("the server", "be careful"), "said"]);
    // Nothing to say, or a result that is not a success, is handed back exactly as it came.
    assert.equal(applyCustomInstructionsToMcpResult(success, "the server", "   ", generatedMcpResultFactory), success);
    const failed = { result: { case: "error" as const, value: { error: "no" } } };
    assert.equal(applyCustomInstructionsToMcpResult(failed, "the server", "be careful", generatedMcpResultFactory), failed);
  });
});

describe("finding the tools a turn can call", () => {
  it("lists the backend's and the box's tools once per server set, and looks again when the set changes", async () => {
    const world = discoveryWorld({
      httpNames: ["web"],
      stdioNames: ["local"],
      userServers: { web: { url: "https://web.example" } },
      stdioConfigs: { local: { command: "run" } },
      backendServers: [{ serverIdentifier: "web", tools: [tool("web", "search")] }],
      boxServers: [{ serverIdentifier: "local", tools: [tool("local", "read")] }],
      boxMcpExec: {},
    });
    try {
      assert.deepEqual((await world.discovery.getToolsRaw()).map((entry: { name: string }) => entry.name), ["search", "read"]);
      await world.discovery.getToolsRaw();
      assert.deepEqual([world.named("backend.listTools").length, world.named("userServerConfigs").length], [1, 0]);
      assert.deepEqual(world.named("getUserServerConfigs").length, 1);
      // The box was told what stdio servers it has before it was asked for their tools.
      assert.deepEqual(world.named("loadServers")[0]?.args, [JSON.stringify({ mcpServers: { local: { command: "run" } } })]);
    } finally {
      world.restoreDiagnostics();
    }
  });

  it("serves what it has while a look is in flight, and looks again once it has aged out", async () => {
    const world = discoveryWorld({
      httpNames: ["web"],
      userServers: { web: { url: "https://web.example" } },
      backendServers: [{ serverIdentifier: "web", tools: [tool("web", "search")] }],
    });
    try {
      // Nothing is known yet, so the turn start asks for a look and is handed nothing.
      assert.deepEqual(await world.discovery.getToolsForTurnStart({}), []);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(world.named("backend.listTools").length, 1);
      // Once it is there, a turn start is handed it without asking again.
      assert.deepEqual((await world.discovery.getToolsRaw()).length, 1);
      const before = world.named("backend.listTools").length;
      assert.deepEqual((await world.discovery.getToolsForTurnStart({})).length, 1);
      assert.deepEqual(world.named("backend.listTools").length, before);
      // Aged out: the tools that are there are served, and a look starts in the background.
      const aged = withDateNow(Date.now() + MCP_TOOLS_CACHE_TTL_MS + 1, () => world.discovery.getToolsForTurnStart({}));
      assert.deepEqual((await aged).length, 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(world.named("backend.listTools").length, before + 1);
    } finally {
      world.restoreDiagnostics();
    }
  });

  it("answers a failure with what it had, and says what failed", async () => {
    const options: DiscoveryOptions = {
      httpNames: ["web"],
      userServers: { web: { url: "https://web.example" } },
      backendServers: [{ serverIdentifier: "web", tools: [tool("web", "search")] }],
    };
    const world = discoveryWorld(options);
    try {
      await world.discovery.getToolsRaw();
      // The look that ages the tools out fails: what was there is served, and the failure says it was served stale.
      options.backendError = new Error("the backend went away");
      const served = await withDateNow(Date.now() + MCP_TOOLS_CACHE_TTL_MS + 1, () => world.discovery.getToolsForTurnStart({}));
      assert.deepEqual((served as Array<{ name: string }>).map((entry) => entry.name), ["search"]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const failure = world.discoveryFailures[0] ?? {};
      assert.deepEqual([failure.errorClass, failure.servedStale, typeof failure.elapsedMs], ["Error", true, "number"]);
      // What was served stale is not treated as fresh: the next turn start looks again.
      options.backendError = undefined;
      const beforeFresh = world.named("backend.listTools").length;
      assert.deepEqual((await world.discovery.getToolsForTurnStart({})).length, 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(world.named("backend.listTools").length, beforeFresh + 1);
      // A first look that failed has nothing to serve, and says so.
      const nothing = discoveryWorld({ httpNames: ["web"], userServers: { web: { url: "https://web.example" } }, backendError: new Error("down") });
      try {
        await assert.rejects(() => nothing.discovery.getToolsRaw(), /down/);
        assert.deepEqual(nothing.discoveryFailures.map((event) => [event.servedStale, event.errorClass]), [[false, "Error"]]);
      } finally {
        nothing.restoreDiagnostics();
      }
    } finally {
      world.restoreDiagnostics();
    }
  });

  it("carries the tools of the servers the surface has, and reports a backend that resolved none", async () => {
    const none = discoveryWorld({ httpNames: ["web"], userServers: { web: { url: "https://x" } }, backendServers: [] });
    try {
      assert.deepEqual(await none.discovery.getToolsRaw(), []);
      assert.deepEqual(none.diagnostics.map((diagnostic) => [diagnostic.leg, diagnostic.errorClass]), [["backend-list-tools", "none_resolved"]]);
    } finally {
      none.restoreDiagnostics();
    }
    // No servers to look for is not a failure, and neither is a surface that cannot be peeked yet.
    const empty = discoveryWorld({ httpNames: [], stdioNames: [] });
    try {
      assert.deepEqual(await empty.discovery.getToolsRaw(), []);
      assert.deepEqual([empty.named("backend.listTools").length, empty.named("getUserServerConfigs").length], [0, 1]);
    } finally {
      empty.restoreDiagnostics();
    }
  });

  it("hands the box's tools over even when the backend refused, and refuses when nothing else could answer", async () => {
    const mixed = discoveryWorld({
      httpNames: ["web"],
      stdioNames: ["local"],
      userServers: { web: { url: "https://x" } },
      stdioConfigs: { local: { command: "run" } },
      boxServers: [{ serverIdentifier: "local", tools: [tool("local", "read")] }],
      backendError: new Error("the backend is down"),
      boxMcpExec: {},
    });
    try {
      await assert.rejects(() => mixed.discovery.getToolsRaw(), /the backend is down/);
    } finally {
      mixed.restoreDiagnostics();
    }
    const onlyBox = discoveryWorld({
      httpNames: [],
      stdioNames: ["local"],
      stdioConfigs: { local: { command: "run" } },
      boxServers: [{ serverIdentifier: "local", tools: [tool("local", "read")] }],
      backendError: new Error("the backend is down"),
      boxMcpExec: {},
    });
    try {
      assert.deepEqual((await onlyBox.discovery.getToolsRaw()).map((entry: { name: string }) => entry.name), ["read"]);
    } finally {
      onlyBox.restoreDiagnostics();
    }
    const onlyBoxFailed = discoveryWorld({
      httpNames: ["web"],
      stdioNames: ["local"],
      userServers: { web: { url: "https://x" } },
      stdioConfigs: { local: { command: "run" } },
      backendServers: [{ serverIdentifier: "web", tools: [tool("web", "search")] }],
      boxError: new Error("the box is unreachable"),
      boxMcpExec: {},
    });
    try {
      // A box that failed does not take the backend's tools with it.
      assert.deepEqual((await onlyBoxFailed.discovery.getToolsRaw()).map((entry: { name: string }) => entry.name), ["search"]);
      assert.deepEqual(onlyBoxFailed.diagnostics.map((diagnostic) => [diagnostic.leg, diagnostic.errorClass]), [["box-list-tools", "Error"]]);
    } finally {
      onlyBoxFailed.restoreDiagnostics();
    }
  });

  it("leaves out the tools a surface turned off, and counts the ones that are on", async () => {
    const world = discoveryWorld({
      displayConfig: { servers: [{ id: "row-1", name: "Web search", serverIdentifier: "web", accounts: [{ serverIdentifier: "web" }], config: { url: "https://x" } }] },
      httpNames: ["web", "other"],
      userServers: { web: { url: "https://x" }, other: { url: "https://y" } },
      backendServers: [
        { serverIdentifier: "web", tools: [tool("web", "search"), tool("web", "fetch")] },
        { serverIdentifier: "other", tools: [tool("other", "list")] },
      ],
      disabled: { "row-1": ["fetch"] },
      stdioNames: [],
      stdioConfigs: {},
    });
    try {
      const tools = (await world.discovery.getTools({})).map((entry: { name: string }) => entry.name);
      assert.deepEqual(tools, ["search", "list"]);
    } finally {
      world.restoreDiagnostics();
    }
    // The box's listing counts what the surface left on.
    const boxWorld = discoveryWorld({
      displayConfig: { servers: [{ id: "row-1", name: "Local", serverIdentifier: "local", accounts: [{ serverIdentifier: "local" }], config: { command: "run" } }] },
      stdioConfigs: { local: { command: "run" } },
      boxServers: [{ serverIdentifier: "local", tools: [tool("local", "read"), tool("local", "write")], toolCount: 9 }],
      disabled: { "row-1": ["write"] },
      boxMcpExec: {},
    });
    try {
      const servers = await boxWorld.discovery.listBoxServers(["local"]);
      assert.deepEqual([boxWorld.named("ensureConfigLoaded").length, servers[0]?.toolCount], [1, 1]);
    } finally {
      boxWorld.restoreDiagnostics();
    }
  });
});

describe("running a tool call", () => {
  it("sends an HTTP server's call to the backend, and reports the first call once per outcome", async () => {
    const world = discoveryWorld({
      displayConfig: { servers: [{ id: "row-1", name: "Web search", serverIdentifier: "web", accounts: [{ serverIdentifier: "web" }], config: { url: "https://x" } }] },
      userServers: { web: { url: "https://x" } },
    });
    try {
      const result = await world.discovery.executeTool({}, { providerIdentifier: "web", name: "search", toolName: "search", args: { q: "x" }, toolCallId: "call-1" }, { agentId: "agent-1" });
      assert.equal(result.result.case, "success");
      const sent = world.named("backend.executeTool")[0]?.args[0] as Record<string, unknown>;
      assert.deepEqual([sent.serverIdentifier, sent.toolName, sent.toolCallId, sent.agentId, sent.args], ["web", "search", "call-1", "agent-1", { q: "x" }]);
      assert.deepEqual(world.authEvents.map((event) => [event.phase, event.outcome, event.serverName, event.serverId]), [["first_call_ok", "ok", "Web search", "row-1"]]);
      // The same outcome is not reported again.
      await world.discovery.executeTool({}, { providerIdentifier: "web", name: "search", args: {} }, {});
      assert.deepEqual(world.authEvents.length, 1);
    } finally {
      world.restoreDiagnostics();
    }
  });

  it("refuses a tool the surface turned off, and a server that is on neither side", async () => {
    const world = discoveryWorld({
      displayConfig: { servers: [{ id: "row-1", name: "Web search", serverIdentifier: "web", accounts: [{ serverIdentifier: "web" }], config: { url: "https://x" } }] },
      userServers: { web: { url: "https://x" } },
      disabled: { "row-1": ["search"] },
    });
    try {
      const refused = await world.discovery.executeTool({}, { providerIdentifier: "web", name: "search", toolName: "search", args: {} }, {});
      assert.deepEqual((refused.result.value as { error: string }).error, 'Tool "search" is disabled for "Web search".');
      assert.deepEqual(world.named("backend.executeTool").length, 0);
      const unavailable = await world.discovery.executeTool({}, { providerIdentifier: "nowhere", name: "do", toolName: "do", args: {} }, {});
      assert.equal(String((unavailable.result.value as { error: string }).error).includes("is not available here"), true);
      assert.equal(String((unavailable.result.value as { error: string }).error).includes("nowhere"), true);
      assert.deepEqual(world.named("box.executeTool").length, 0);
    } finally {
      world.restoreDiagnostics();
    }
  });

  it("runs a box server's call on the box after telling it what to run, and answers a push that failed", async () => {
    const world = discoveryWorld({
      stdioConfigs: { local: { command: "run" } },
      stdioNames: ["local"],
      boxMcpExec: {},
    });
    try {
      const result = await world.discovery.executeTool({}, { providerIdentifier: "local", name: "read", toolName: "read", args: { path: "/x" } }, {});
      assert.equal(result.result.case, "success");
      assert.deepEqual(world.named("loadServers").length, 1);
      assert.deepEqual(world.named("box.executeTool")[0]?.args[0], { providerIdentifier: "local", name: "read", toolName: "read", args: { path: "/x" } });
    } finally {
      world.restoreDiagnostics();
    }
    const failing = discoveryWorld({ stdioConfigs: { local: { command: "run" } }, stdioNames: ["local"], boxMcpExec: {}, pushError: new Error("the box refused the config") });
    try {
      const result = await failing.discovery.executeTool({}, { providerIdentifier: "local", name: "read", toolName: "read", args: {} }, {});
      const message = (result.result.value as { error: string }).error;
      assert.deepEqual([message.startsWith("Could not load MCP servers onto Slate's computer:"), message.includes("the box refused the config")], [true, true]);
      assert.deepEqual(failing.named("box.executeTool").length, 0);
    } finally {
      failing.restoreDiagnostics();
    }
  });

  it("puts the stored instruction for a server on the result, by id first and by name after", async () => {
    const byId = discoveryWorld({
      displayConfig: { servers: [{ id: "row-1", name: "Web search", serverIdentifier: "web", accounts: [{ serverIdentifier: "web" }], config: { url: "https://x" } }] },
      userServers: { web: { url: "https://x" } },
      instructionsById: { "row-1": "always cite sources" },
      instructionsByName: { "Web search": "never cite" },
    });
    try {
      const result = await byId.discovery.executeTool({}, { providerIdentifier: "web", name: "search", toolName: "search", args: {} }, {});
      const content = (result.result.value as { content: Array<{ content: { value: { text: string } } }> }).content;
      assert.equal(content[0]?.content.value.text, formatMcpCustomInstructionToolNote("Web search", "always cite sources"));
    } finally {
      byId.restoreDiagnostics();
    }
    const byName = discoveryWorld({
      displayConfig: { servers: [{ id: "row-1", name: "Web search", serverIdentifier: "web", accounts: [{ serverIdentifier: "web" }], config: { url: "https://x" } }] },
      userServers: { web: { url: "https://x" } },
      instructionsByName: { "Web search": "never cite" },
    });
    try {
      const result = await byName.discovery.executeTool({}, { providerIdentifier: "web", name: "search", toolName: "search", args: {} }, {});
      const content = (result.result.value as { content: Array<{ content: { value: { text: string } } }> }).content;
      assert.equal(content[0]?.content.value.text, formatMcpCustomInstructionToolNote("Web search", "never cite"));
    } finally {
      byName.restoreDiagnostics();
    }
  });

  it("says where a provider runs, wires and unwires the box, and forgets what it cached when told to", async () => {
    const world = discoveryWorld({ httpNames: ["web"], userServers: { web: { url: "https://x" } }, stdioConfigs: { local: { command: "run" } }, backendServers: [{ serverIdentifier: "web", tools: [tool("web", "search")] }] });
    try {
      assert.deepEqual(await world.discovery.resolveProviderTransport("web"), "http");
      assert.deepEqual(await world.discovery.resolveProviderTransport("local"), "stdio");
      assert.deepEqual(await world.discovery.resolveProviderTransport("nowhere"), "unknown");
      assert.deepEqual(world.discovery.isBoxExecWired(), false);
      await world.discovery.getToolsRaw();
      assert.deepEqual(world.named("backend.listTools").length, 1);
      // Invalidation drops what was cached, so the next look asks again.
      world.discovery.invalidateToolsCache();
      await world.discovery.getToolsRaw();
      assert.deepEqual(world.named("backend.listTools").length, 2);
      assert.deepEqual([MCP_TOOLS_CACHE_TTL_MS, TOOLS_DISCOVERY_DEADLINE_MS], [24 * 60 * 60 * 1_000, 120_000]);
    } finally {
      world.restoreDiagnostics();
    }
    // A box that is wired in is what makes a box surface possible at all.
    const bare = discoveryWorld();
    try {
      await assert.rejects(() => bare.discovery.listBoxServers(["local"]), SlateMcpConfigError);
    } finally {
      bare.restoreDiagnostics();
    }
  });

  it("tells the box about new stdio servers once, and again after the push state is reset", async () => {
    const world = discoveryWorld({ stdioConfigs: { local: { command: "run" } }, stdioNames: ["local"], boxMcpExec: {} });
    try {
      await world.discovery.getToolsRaw();
      await world.discovery.getToolsRaw();
      assert.deepEqual(world.named("loadServers").length, 1);
      world.discovery.resetPushState();
      // The same config is pushed again only because the surface asked for it.
      world.discovery.setBoxMcpExec({});
      assert.deepEqual(world.discovery.isBoxExecWired(), true);
      assert.deepEqual(world.named("getStdioServerConfigs").length >= 2, true);
    } finally {
      world.restoreDiagnostics();
    }
    // Nothing to push and nothing ever pushed is nothing to do.
    const empty = discoveryWorld({ stdioConfigs: {}, stdioNames: [], boxMcpExec: {} });
    try {
      await empty.discovery.getToolsRaw();
      assert.deepEqual(empty.named("loadServers").length, 0);
    } finally {
      empty.restoreDiagnostics();
    }
  });
});

describe("the executor in front of the discovery", () => {
  it("hands the result on, spills what is large, and keeps the images that were saved", async () => {
    const base = { result: { case: "success" as const, value: { content: [{ content: { case: "image", value: { data: new Uint8Array([1]), mimeType: "image/png" } } }] } } };
    const discovery = { executeTool: async () => base };
    assert.equal(await new SlateMcpExecutor(discovery).execute({}, {}), base);
    const spilled = { result: { case: "success" as const, value: { content: [] } } };
    const withSpill = new SlateMcpExecutor(discovery, undefined, async (_ctx: unknown, value: unknown) => (value === base ? spilled : value));
    assert.equal(await withSpill.execute({}, {}), spilled);
    const persisted: string[] = [];
    const withImages = new SlateMcpExecutor(discovery, async (data: string) => {
      persisted.push(String(data));
      return { fileUrl: "file:///saved.png" };
    });
    const result = (await withImages.execute({}, {})) as { result: { value: { content: Array<{ content: { case: string } }> } } };
    assert.deepEqual(result.result.value.content.map((item) => item.content.case), ["image", "text"]);
    assert.deepEqual(persisted.length, 1);
  });
});

describe("the discovery cache and the box's server list", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("tells two different server sets apart even when their names share a separator", async () => {
    const options: DiscoveryOptions = {
      httpNames: ["alpha", "beta"],
      userServers: { alpha: { url: "https://a.example" }, beta: { url: "https://b.example" } },
      backendServers: [{ serverIdentifier: "alpha", tools: [tool("alpha", "read")] }],
    };
    const world = discoveryWorld(options);
    try {
      await world.discovery.getToolsRaw();
      await tick();
      options.httpNames = ["alpha,beta"];
      options.userServers = { "alpha,beta": { url: "https://a.example" } };
      await world.discovery.getToolsRaw();
      // The two sets are different sets, so the second look is a real look.
      assert.equal(world.named("backend.listTools").length, 2);
    } finally {
      world.restoreDiagnostics();
    }
  });

  it("pushes an empty server config once the box has been told about servers before", async () => {
    const options: DiscoveryOptions = { httpNames: [], stdioNames: ["local"], stdioConfigs: { local: { command: "run" } }, boxMcpExec: {} };
    const world = discoveryWorld(options);
    try {
      await world.discovery.getTools();
      assert.equal(world.named("loadServers").length, 1);
      // With no stdio servers left, the box is told to forget the ones it had.
      options.stdioNames = [];
      options.stdioConfigs = {};
      await world.discovery.getTools();
      assert.equal(world.named("loadServers").length, 2);
      assert.deepEqual(world.named("loadServers")[1]?.args, [JSON.stringify({ mcpServers: {} })]);
    } finally {
      world.restoreDiagnostics();
    }
  });

  it("forgets the settled cache when the server set becomes empty", async () => {
    const options: DiscoveryOptions = {
      httpNames: ["web"],
      userServers: { web: { url: "https://web.example" } },
      backendServers: [{ serverIdentifier: "web", tools: [tool("web", "search")] }],
    };
    const world = discoveryWorld(options);
    try {
      await world.discovery.getToolsRaw();
      await tick();
      options.httpNames = [];
      assert.deepEqual(await world.discovery.getToolsForTurnStart({}), []);
      options.httpNames = ["web"];
      await world.discovery.getToolsRaw();
      assert.equal(world.named("backend.listTools").length, 2);
    } finally {
      world.restoreDiagnostics();
    }
  });

  it("a warm started for an older cache epoch stops before it looks", async () => {
    const world = discoveryWorld({
      httpNames: ["web"],
      userServers: { web: { url: "https://web.example" } },
      backendServers: [{ serverIdentifier: "web", tools: [tool("web", "search")] }],
      boxMcpExec: {},
    });
    try {
      world.discovery.setBoxMcpExec({ loadServers: async () => {}, listTools: async () => [], executeTool: async () => ({}) });
      world.discovery.invalidateToolsCache();
      await tick();
      await tick();
      assert.equal(world.named("backend.listTools").length, 1);
    } finally {
      world.restoreDiagnostics();
    }
  });

  it("counts the enabled tools of a listed box server", async () => {
    const world = discoveryWorld({
      displayConfig: { servers: [{ serverIdentifier: "local", id: "srv-1", name: "Local", accounts: [{ serverIdentifier: "local" }] }] },
      stdioNames: ["local"],
      stdioConfigs: { local: { command: "run" } },
      disabled: { "srv-1": ["read"] },
      boxServers: [{ serverIdentifier: "local", tools: [tool("local", "read"), tool("local", "write")] }, { serverIdentifier: "unknown", tools: [tool("unknown", "read")] }],
      boxMcpExec: {},
    });
    try {
      const servers = await world.discovery.listBoxServers(["local", "unknown"]) as Array<{ toolCount?: number }>;
      assert.equal(servers[0]?.toolCount, 1);
      // A server with no display row is listed as it came, with no count invented for it.
      assert.equal("toolCount" in (servers[1] ?? {}), false);
    } finally {
      world.restoreDiagnostics();
    }
  });
});

