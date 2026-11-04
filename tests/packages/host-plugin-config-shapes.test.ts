import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { externalPluginMcpConfigSchema as mcpConfigSchema, externalPluginMcpServerConfigSchema as mcpServerConfigSchema } from "../../source/adapters/interop/plugin-marketplace/plugin-mcp-config-adapter.ts";
import { noopPluginMetricsLogger } from "../../source/packages/plugin-install/types.ts";

describe("the shapes a plugin's MCP configuration takes", () => {
  it("takes a server that is a command, with what it needs around it", () => {
    const parsed = mcpServerConfigSchema.safeParse({ command: "npx", args: ["-y", "thing"], env: { A: "1" }, cwd: "/tmp", envFile: ".env", enabledTools: ["read"] });
    assert.equal(parsed.success, true);
  });

  it("takes a server that is a URL, with its headers", () => {
    assert.equal(mcpServerConfigSchema.safeParse({ url: "https://mcp.example", headers: { Authorization: "x" } }).success, true);
  });

  it("takes the credentials a server authenticates with, and refuses them without a client id", () => {
    assert.equal(mcpServerConfigSchema.safeParse({ command: "x", auth: { CLIENT_ID: "id" } }).success, true);
    assert.equal(mcpServerConfigSchema.safeParse({ command: "x", auth: { CLIENT_ID: "id", CLIENT_SECRET: "s", scopes: ["a"] } }).success, true);
    assert.equal(mcpServerConfigSchema.safeParse({ command: "x", auth: { CLIENT_SECRET: "s" } }).success, false);
  });

  it("refuses a field that is not the type it says", () => {
    assert.equal(mcpServerConfigSchema.safeParse({ command: 5 }).success, false);
    assert.equal(mcpServerConfigSchema.safeParse({ env: { A: 5 } }).success, false, "an environment is text to text");
    assert.equal(mcpServerConfigSchema.safeParse({ headers: { A: 5 } }).success, false);
    assert.equal(mcpServerConfigSchema.safeParse({ args: "not a list" }).success, false);
  });

  it("reads a whole file of servers, and takes one without any", () => {
    assert.equal(mcpConfigSchema.safeParse({ mcpServers: { one: { command: "x" }, two: { url: "u" } } }).success, true);
    assert.equal(mcpConfigSchema.safeParse({}).success, true);
    assert.equal(mcpConfigSchema.safeParse({ mcpServers: { one: { command: 5 } } }).success, false);
    assert.equal(mcpConfigSchema.safeParse({ mcpServers: "no" }).success, false);
  });
});

describe("the logger a loader is handed when it wants none", () => {
  it("does nothing and answers nothing, for every method it has", () => {
    for (const method of ["log", "increment", "distribution", "captureException"] as const) {
      const call = (noopPluginMetricsLogger as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!;
      assert.equal(call("anything", 1, {}), undefined, method);
    }
    assert.equal(Object.isFrozen(noopPluginMetricsLogger), true);
  });
});
