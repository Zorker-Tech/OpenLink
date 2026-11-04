import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PLUGIN_MCP_CONFIG_FILE_NAMES,
  resolvePluginMcpConfigFromReader,
  resolvePluginMcpConfigPaths,
  resolvePluginMcpConfigWithManifestLookup,
} from "../../source/packages/plugin-install/mcp-parser.ts";
import type { PluginMetricsLogger } from "../../source/packages/plugin-install/types.ts";

function memoryReader(files: Readonly<Record<string, string>>, reads: string[] = []) {
  return async (path: string): Promise<string | null> => {
    reads.push(path);
    return files[path] ?? null;
  };
}

function loggerWithWarnings(warnings: string[]): PluginMetricsLogger {
  return {
    log: (level, message) => { if (level === "warn") warnings.push(message); },
    increment: () => {},
    distribution: () => {},
    captureException: () => {},
  };
}

test("plugin MCP config paths keep the shared file order and trim only trailing separators", () => {
  assert.deepEqual(PLUGIN_MCP_CONFIG_FILE_NAMES, [".mcp.json", "mcp.json"]);
  assert.deepEqual(resolvePluginMcpConfigPaths("/plugins/one///"), ["/plugins/one/.mcp.json", "/plugins/one/mcp.json"]);
  assert.deepEqual(resolvePluginMcpConfigPaths(""), [".mcp.json", "mcp.json"]);
  assert.deepEqual(resolvePluginMcpConfigPaths(), [".mcp.json", "mcp.json"]);
});

test("MCP files accept JSONC, retain only schema fields, and load the wrapped server map", async () => {
  const resolved = await resolvePluginMcpConfigFromReader(memoryReader({
    ".mcp.json": `{
      // A plugin can annotate its own configuration.
      "mcpServers": { "search": { "command": "node", "args": ["serve"], "ignoredBySlate": true } }
    }`,
  }), undefined, undefined, { parserOptions: { skipExpansion: true } });

  assert.deepEqual(resolved?.mcpServers, { search: { command: "node", args: ["serve"] } });
  assert.equal(resolved?.mcpServerSourcePaths?.search, ".mcp.json");
});

test("older root-level server maps exclude metadata and require a server-shaped valid entry", async () => {
  const resolved = await resolvePluginMcpConfigFromReader(memoryReader({
    "mcp.json": JSON.stringify({
      search: { command: "node", args: ["search"] },
      author: { name: "Slate" },
      source: { repo: "team/plugin" },
      metadata: { version: "1" },
      arbitrary: { enabled: true },
    }),
  }), undefined, undefined, { fallbackFileNames: ["mcp.json"], parserOptions: { skipExpansion: true } });

  assert.deepEqual(resolved?.mcpServers, { search: { command: "node", args: ["search"] } });
  assert.equal(resolved?.mcpServerSourcePaths?.search, "mcp.json");
  assert.equal(await resolvePluginMcpConfigFromReader(memoryReader({
    "mcp.json": JSON.stringify({ search: { command: "node" }, malformed: { command: "node", args: "not-a-list" } }),
  }), undefined, undefined, { fallbackFileNames: ["mcp.json"], parserOptions: { skipExpansion: true } }), null,
  "one invalid legacy entry rejects the complete source instead of returning a partial map");
});

test("fallback files are read in order and the first declaration owns a duplicate", async () => {
  const reads: string[] = [];
  const resolved = await resolvePluginMcpConfigFromReader(memoryReader({
    ".mcp.json": JSON.stringify({ mcpServers: { shared: { command: "first" }, early: { command: "one" } } }),
    "mcp.json": JSON.stringify({ mcpServers: { shared: { command: "second" }, late: { command: "two" } } }),
  }, reads), undefined, undefined, { parserOptions: { skipExpansion: true } });

  assert.deepEqual(reads, [".mcp.json", "mcp.json"]);
  assert.deepEqual(resolved?.mcpServers, {
    shared: { command: "first" },
    early: { command: "one" },
    late: { command: "two" },
  });
  assert.deepEqual(resolved?.mcpServerSourcePaths, { shared: ".mcp.json", early: ".mcp.json", late: "mcp.json" });
});

test("manifest file references are normalized and safe paths are the only ones read", async () => {
  const reads: string[] = [];
  const resolved = await resolvePluginMcpConfigFromReader(memoryReader({
    "team/mcp.json": JSON.stringify({ mcpServers: { fromFile: { command: "run" } } }),
    "escape.json": JSON.stringify({ mcpServers: { unsafe: { command: "run" } } }),
  }, reads), ["./team/mcp.json", "../escape.json"], ".plugin/plugin.json", {
    toSourcePath: (path) => `/installed/${path}`,
    parserOptions: { skipExpansion: true },
  });

  assert.deepEqual(reads, [".mcp.json", "mcp.json", "team/mcp.json"]);
  assert.deepEqual(resolved?.mcpServers, { fromFile: { command: "run" } });
  assert.deepEqual(resolved?.mcpServerSourcePaths, { fromFile: "/installed/team/mcp.json" });
});

test("manifest arrays and inline maps merge in order and report the manifest source", async () => {
  const resolved = await resolvePluginMcpConfigFromReader(memoryReader({
    "first.json": JSON.stringify({ mcpServers: { same: { command: "file" }, fromFile: { command: "one" } } }),
  }), [
    "first.json",
    { same: { command: "inline-one" }, inline: { command: "two" } },
    { same: { command: "inline-two" } },
  ], ".plugin/plugin.json", { parserOptions: { skipExpansion: true } });

  assert.deepEqual(resolved?.mcpServers, {
    same: { command: "inline-two" },
    fromFile: { command: "one" },
    inline: { command: "two" },
  });
  assert.deepEqual(resolved?.mcpServerSourcePaths, {
    same: ".plugin/plugin.json",
    fromFile: "first.json",
    inline: ".plugin/plugin.json",
  });
});

test("manifest precedence can either replace fallback servers or fill only missing names", async () => {
  const files = {
    ".mcp.json": JSON.stringify({ mcpServers: { shared: { command: "file" }, keep: { command: "file-only" } } }),
  };
  const manifest = { shared: { command: "manifest" }, add: { command: "manifest-only" } };
  const options = { fallbackFileNames: [".mcp.json"], parserOptions: { skipExpansion: true } } as const;

  const override = await resolvePluginMcpConfigFromReader(memoryReader(files), manifest, "plugin.json", options);
  const fill = await resolvePluginMcpConfigFromReader(memoryReader(files), manifest, "plugin.json", { ...options, manifestPrecedence: "fill" });

  assert.deepEqual(override?.mcpServers, {
    shared: { command: "manifest" }, keep: { command: "file-only" }, add: { command: "manifest-only" },
  });
  assert.deepEqual(fill?.mcpServers, {
    shared: { command: "file" }, keep: { command: "file-only" }, add: { command: "manifest-only" },
  });
  assert.equal(override?.mcpServerSourcePaths?.shared, "plugin.json");
  assert.equal(fill?.mcpServerSourcePaths?.shared, ".mcp.json");
});

test("plugin root and environment placeholders expand in server values with explicit lookup precedence", async () => {
  const previous = process.env.SLATE_MCP_PARSER_TOKEN;
  process.env.SLATE_MCP_PARSER_TOKEN = "process-token";
  try {
    const resolved = await resolvePluginMcpConfigFromReader(memoryReader({
      ".mcp.json": JSON.stringify({ mcpServers: { local: {
        command: "${CLAUDE_PLUGIN_ROOT}/bin/${SLATE_MCP_PARSER_TOKEN}",
        args: ["${CURSOR_PLUGIN_ROOT}/arg", "${MISSING:-fallback}"],
        cwd: "${CLAUDE_PLUGIN_ROOT}/work",
        env: { TOKEN: "${SLATE_MCP_PARSER_TOKEN}", UNRESOLVED: "${NOT_SET}" },
        headers: { Authorization: "Bearer ${SLATE_MCP_PARSER_TOKEN}" },
      } } }),
    }), undefined, undefined, {
      installPathForExpansion: "/plugin/root",
      parserOptions: { configuredVariables: { SLATE_MCP_PARSER_TOKEN: "configured-token" } },
    });

    assert.deepEqual(resolved?.mcpServers.local, {
      command: "/plugin/root/bin/process-token",
      args: ["/plugin/root/arg", "fallback"],
      cwd: "/plugin/root/work",
      env: { TOKEN: "process-token", UNRESOLVED: "${NOT_SET}" },
      headers: { Authorization: "Bearer process-token" },
    });
  } finally {
    if (previous === undefined) delete process.env.SLATE_MCP_PARSER_TOKEN;
    else process.env.SLATE_MCP_PARSER_TOKEN = previous;
  }
});

test("cloud lookup replaces process and configured values; skipExpansion leaves source text alone", async () => {
  const content = JSON.stringify({ mcpServers: { local: {
    command: "${CLAUDE_PLUGIN_ROOT}/bin/${TOKEN}", args: ["${TOKEN:-default}"], env: { TOKEN: "${TOKEN}" },
  } } });
  const cloud = await resolvePluginMcpConfigFromReader(memoryReader({ ".mcp.json": content }), undefined, undefined, {
    installPathForExpansion: "/plugin",
    parserOptions: { configuredVariables: { TOKEN: "configured" }, cloudAgentEnvLookup: (key) => key === "TOKEN" ? "cloud" : undefined },
  });
  const untouched = await resolvePluginMcpConfigFromReader(memoryReader({ ".mcp.json": content }), undefined, undefined, {
    installPathForExpansion: "/plugin", parserOptions: { skipExpansion: true, configuredVariables: { TOKEN: "configured" } },
  });

  assert.deepEqual(cloud?.mcpServers.local, {
    command: "/plugin/bin/cloud", args: ["cloud"], env: { TOKEN: "cloud" },
  });
  assert.deepEqual(untouched?.mcpServers.local, {
    command: "${CLAUDE_PLUGIN_ROOT}/bin/${TOKEN}", args: ["${TOKEN:-default}"], env: { TOKEN: "${TOKEN}" },
  });
});

test("malformed, empty, and schema-invalid MCP files resolve to no config without partial reads", async () => {
  for (const body of ["{ not json", "{}", JSON.stringify({ mcpServers: {} }), JSON.stringify({ mcpServers: { bad: { args: "no" } } })]) {
    assert.equal(await resolvePluginMcpConfigFromReader(memoryReader({ ".mcp.json": body }), undefined, undefined), null, body);
  }
  assert.equal(await resolvePluginMcpConfigFromReader(async () => null, undefined, undefined), null);
});

test("schema declarations warn but do not block loading a valid MCP config", async () => {
  const warnings: string[] = [];
  const resolved = await resolvePluginMcpConfigFromReader(memoryReader({
    ".mcp.json": JSON.stringify({ $schema: "https://schemas.example/unknown.json", mcpServers: { one: { command: "run" } } }),
  }), undefined, undefined, { parserOptions: { pluginSchemaId: "https://schemas.example/plugin.json", log: loggerWithWarnings(warnings), skipExpansion: true } });

  assert.equal(resolved?.mcpServers.one?.command, "run");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /unrecognized \$schema/);
});

test("manifest lookup uses the first parseable plugin manifest and carries its source", async () => {
  const reads: string[] = [];
  const warnings: string[] = [];
  const files: Record<string, string> = {
    ".cursor-plugin/plugin.json": "{ broken",
    ".claude-plugin/plugin.json": JSON.stringify({
      $schema: "https://schemas.example/v1.0/plugin.json",
      name: "plugin",
      mcpServers: { fromManifest: { command: "${CLAUDE_PLUGIN_ROOT}/run" } },
    }),
    "plugin.json": JSON.stringify({ name: "later", mcpServers: { ignored: { command: "later" } } }),
    ".mcp.json": JSON.stringify({ $schema: "https://schemas.example/v2.0/mcp.json", mcpServers: { fromFile: { command: "file" } } }),
  };
  const resolved = await resolvePluginMcpConfigWithManifestLookup(memoryReader(files, reads), {
    installPathForExpansion: "/plugin",
    parserOptions: { pluginSchemaId: "https://schemas.example/other/plugin.json", log: loggerWithWarnings(warnings) },
  });

  assert.deepEqual(reads, [".cursor-plugin/plugin.json", ".claude-plugin/plugin.json", ".mcp.json", "mcp.json"]);
  assert.deepEqual(resolved?.mcpServers, { fromManifest: { command: "/plugin/run" }, fromFile: { command: "file" } });
  assert.equal(resolved?.mcpServerSourcePaths?.fromManifest, ".claude-plugin/plugin.json");
  assert.equal(warnings.some((warning) => warning.includes("unrecognized $schema")), true);
});

test("the last readable manifest schema still informs MCP diagnostics when that manifest fails validation", async () => {
  const warnings: string[] = [];
  const files: Record<string, string> = {
    ".cursor-plugin/plugin.json": JSON.stringify({ $schema: "https://schemas.example/v2.0/plugin.json", invalid: true }),
    ".mcp.json": JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { one: { command: "run" } },
    }),
  };
  const resolved = await resolvePluginMcpConfigWithManifestLookup(memoryReader(files), {
    parserOptions: { log: loggerWithWarnings(warnings) },
  });

  assert.equal(resolved?.mcpServers.one?.command, "run");
  assert.equal(warnings.some((warning) => warning.includes("disagrees with plugin.json")), true);
});

test("a rejected source read remains an error for its caller", async () => {
  await assert.rejects(
    () => resolvePluginMcpConfigFromReader(async () => { throw new Error("reader unavailable"); }, undefined, undefined),
    /reader unavailable/,
  );
});
