import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateMcpDefinitionSource, type McpRuntimeConfig } from "../../source/shared/node/mcp/mcp-definition-source.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve: (value: T) => resolve(value) };
}

describe("MCP definition source behavior", () => {
  it("filters built-ins from account config and exposes only URL-backed definitions", async () => {
    const source = new SlateMcpDefinitionSource(false, async () => ({
      mcpServers: {
        web: { url: "https://mcp.example", type: "sse" },
        local: { command: "node", args: ["server.js"] },
      },
    }));
    assert.deepEqual(await source.getUserServerConfigs(), {
      web: { url: "https://mcp.example", type: "sse" },
      local: { command: "node", args: ["server.js"] },
    });
    assert.deepEqual(await source.getDefinitions(), [{
      identifier: "web",
      serverConfig: { url: "https://mcp.example", type: "sse" },
      source: "account",
    }]);
    assert.deepEqual(await source.getStdioServerConfigs(), { local: { command: "node", args: ["server.js"] } });
    assert.equal(await source.getServerUrlForIdentifier("web"), "https://mcp.example");
    assert.equal(await source.getServerUrlForIdentifier("local"), undefined);
  });

  it("uses the last successful configuration if refreshes fail", async () => {
    let attempt = 0;
    const source = new SlateMcpDefinitionSource(false, async () => {
      attempt += 1;
      return attempt === 1 ? { mcpServers: { retained: { url: "https://retained.example" } } } : null;
    });
    assert.equal(await source.getServerUrlForIdentifier("retained"), "https://retained.example");
    source.clearCache();
    await source.ensureConfigLoaded();
    assert.equal(await source.getServerUrlForIdentifier("retained"), "https://retained.example");
  });

  it("does not let an older provider response overwrite an adopted account config", async () => {
    const pending = deferred<McpRuntimeConfig | null>();
    const source = new SlateMcpDefinitionSource(false, () => pending.promise);
    source.refreshInBackground();
    const adopted = { mcpServers: { current: { url: "https://current.example" } } };
    source.adoptAccountConfig(adopted);
    pending.resolve({ mcpServers: { stale: { url: "https://stale.example" } } });
    await Promise.resolve();
    assert.deepEqual(await source.getUserServerConfigs(), adopted.mcpServers);
    assert.equal(await source.getServerUrlForIdentifier("stale"), undefined);
  });

  it("clears an in-flight account response when told to forget the last known config", async () => {
    const pending = deferred<McpRuntimeConfig | null>();
    const source = new SlateMcpDefinitionSource(false, () => pending.promise);
    source.clearLastKnownAccountConfig();
    pending.resolve({ mcpServers: { late: { url: "https://late.example" } } });
    await Promise.resolve();
    assert.deepEqual(await source.getUserServerConfigs(), {});
    assert.equal(await source.getServerUrlForIdentifier("late"), undefined);
  });
});
