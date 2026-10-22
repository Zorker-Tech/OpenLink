import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeUnresolvedAccountServers } from "../../source/shared/node/mcp/account-display-cache.ts";

interface Server { readonly id: string; readonly label?: string }
const server = (id: string, label?: string): Server => label === undefined ? { id } : { id, label };

describe("filling in unresolved MCP servers", () => {
  it("leaves the view alone when there is nothing to fill in", () => {
    const view = { servers: [server("a")], unresolvedServerIds: ["a"] };
    assert.equal(mergeUnresolvedAccountServers(view, null), view);
    const noIds = { servers: [server("a")], unresolvedServerIds: [] as string[] };
    assert.equal(mergeUnresolvedAccountServers(noIds, { servers: [server("b")] }), noIds);
  });

  it("carries the unresolved cached servers, replaces the resolved ones, and drops the rest", () => {
    const cached = { servers: [server("a"), server("b", "old-b"), server("c")] };
    const view = { servers: [server("b", "new-b"), server("d")], unresolvedServerIds: ["a", "c"] };
    const merged = mergeUnresolvedAccountServers(view, cached);
    assert.deepEqual(merged.servers, [server("a"), server("b", "new-b"), server("c"), server("d")]);
    assert.equal(merged.servers[0], cached.servers[0], "an unresolved cached server is carried as it is");
    assert.equal(merged.servers[1], view.servers[0], "a resolved one is taken from the refresh");
    assert.equal(merged.servers[2], cached.servers[2], "the other unresolved cached server is carried too");
    assert.equal(merged.servers[3], view.servers[1], "a new one is appended after the carried ones");
  });

  it("answers a new view with a new list and keeps the other fields", () => {
    const cached = { servers: [server("a")] };
    const view = { servers: [] as Server[], unresolvedServerIds: ["a"], extra: "kept" };
    const merged = mergeUnresolvedAccountServers(view, cached);
    assert.notEqual(merged, view);
    assert.notEqual(merged.servers, view.servers);
    assert.equal((merged as { extra?: string }).extra, "kept");
    assert.deepEqual(merged.unresolvedServerIds, ["a"]);
    assert.deepEqual(view.servers, [], "the view it was given is not changed");
  });
});