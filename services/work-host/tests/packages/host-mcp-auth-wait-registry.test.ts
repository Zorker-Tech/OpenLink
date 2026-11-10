import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as waits from "../../source/host/mcp/mcp-auth-wait-registry.ts";
import { DEFAULT_MCP_AUTH_WAIT_TTL_MS, McpAuthWaitRegistry, normalizeConnectorName } from "../../source/host/mcp/mcp-auth-wait-registry.ts";

describe("waiting for a connector to be authorized", () => {
  it("normalizes a connector name to letters and digits, and lives for an hour by default", () => {
    assert.equal(DEFAULT_MCP_AUTH_WAIT_TTL_MS, 3_600_000);
    assert.deepEqual(Object.keys(waits).sort(), ["DEFAULT_MCP_AUTH_WAIT_TTL_MS", "McpAuthWaitRegistry", "normalizeConnectorName"]);
    assert.equal(normalizeConnectorName("Git Hub"), "github");
    assert.equal(normalizeConnectorName("GIT_HUB"), "github");
    assert.equal(normalizeConnectorName("a.b/c"), "abc");
    assert.equal(normalizeConnectorName("A1B2"), "a1b2");
    assert.equal(normalizeConnectorName("代理"), "");
  });

  it("takes a wait by the connector name a completion reports, and only once", () => {
    const registry = new McpAuthWaitRegistry({ now: () => 1_000 });
    registry.register({ agentId: "a1", connector: "Slack" });
    assert.equal(registry.take({ serverId: "s9", serverName: "slack" }), "a1");
    assert.equal(registry.take({ serverId: "s9", serverName: "slack" }), null);
  });

  it("prefers a server-id match over a name match, and takes both", () => {
    const registry = new McpAuthWaitRegistry({ now: () => 1_000 });
    registry.register({ agentId: "by-id", connector: "id connector", serverId: "s2" });
    registry.register({ agentId: "by-name", connector: "by-name" });
    assert.equal(registry.take({ serverId: "s2", serverName: "by-name" }), "by-id");
    assert.equal(registry.take({ serverId: "s2", serverName: "anything" }), null, "the id wait is gone");
    assert.equal(registry.take({ serverId: "x", serverName: "by-name" }), null, "and so is the name wait");
  });

  it("answers the last of several waits for one server id, and replaces a wait under the same key", () => {
    const registry = new McpAuthWaitRegistry({ now: () => 1_000 });
    registry.register({ agentId: "first", connector: "one", serverId: "s3" });
    registry.register({ agentId: "second", connector: "two", serverId: "s3" });
    assert.equal(registry.take({ serverId: "s3", serverName: "one" }), "second");
    registry.register({ agentId: "old", connector: "Dupe", serverId: "s4" });
    registry.register({ agentId: "new", connector: "dupe", serverId: null });
    assert.equal(registry.take({ serverId: "s4", serverName: "DUPE" }), "new", "one key holds one wait");
  });

  it("keeps an unnamed wait by its server id, and keeps no wait at all without one", () => {
    const registry = new McpAuthWaitRegistry({ now: () => 1_000 });
    registry.register({ agentId: "empty-name", connector: "  ", serverId: "s5" });
    assert.equal(registry.take({ serverId: "s5", serverName: "" }), "empty-name");
    registry.register({ agentId: "nothing", connector: "", serverId: null });
    assert.equal(registry.take({ serverId: "", serverName: "" }), null);
    // An empty server id is no id: the wait is keyed by the name.
    registry.register({ agentId: "empty-id", connector: "no id", serverId: "" });
    assert.equal(registry.take({ serverId: "", serverName: "" }), null, "an empty server id on the wait is no id");
    assert.equal(registry.take({ serverId: "x", serverName: "no id" }), "empty-id");
  });

  it("expires a wait exactly at its time to live, and follows a custom ttl and clock", () => {
    let now = 1_000;
    const registry = new McpAuthWaitRegistry({ now: () => now });
    registry.register({ agentId: "living", connector: "living" });
    registry.register({ agentId: "dying", connector: "dying" });
    now += DEFAULT_MCP_AUTH_WAIT_TTL_MS - 1;
    assert.equal(registry.take({ serverId: "x", serverName: "living" }), "living", "one millisecond before the time to live it still answers");
    now += 1;
    assert.equal(registry.take({ serverId: "x", serverName: "dying" }), null, "at the time to live it is already gone");

    let customNow = 50;
    const custom = new McpAuthWaitRegistry({ ttlMs: 10, now: () => customNow });
    custom.register({ agentId: "short", connector: "short" });
    customNow = 59;
    assert.equal(custom.take({ serverId: "x", serverName: "short" }), "short");
    custom.register({ agentId: "short2", connector: "short2" });
    customNow = 69;
    custom.prune();
    assert.equal(custom.take({ serverId: "x", serverName: "short2" }), null);
    assert.equal(custom.take({ serverId: "none", serverName: "none" }), null);
  });
});