import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateMcpAccountSlotLifecycle } from "../../source/shared/node/mcp/mcp-account-slot-lifecycle.ts";

function harness(options: { withDisplay?: boolean; accounts?: Array<{ accountKey: string; hasToken: boolean }>; stdio?: boolean; withState?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const display = options.withDisplay === false ? null : {
    servers: [{
      id: "11",
      name: "remote",
      serverIdentifier: "mcp-row-11",
      config: options.stdio === true ? { command: "node" } : { url: "https://mcp.example" },
      isTeamServer: false,
      accounts: options.accounts ?? [{ accountKey: "work", hasToken: true }, { accountKey: "home", hasToken: false }],
    }],
  };
  const state = options.withState === false ? null : {
    servers: [
      { id: "11", accountKey: "work", serverIdentifier: "old-work" },
      { id: "11", accountKey: "home", serverIdentifier: "old-home" },
      { id: "12", accountKey: "work", serverIdentifier: "other" },
    ],
  };
  const deps = {
    backendMcpExec: {
      logoutAccount: async (args: unknown) => { calls.push(["logout", args]); },
      renameAccount: async (args: unknown) => { calls.push(["rename", args]); },
      deleteAccount: async (args: unknown) => { calls.push(["delete", args]); },
    },
    resolveDisplayServer: async (id: string) => {
      calls.push(["resolve", id]);
      return display?.servers.find((server) => server.id === id);
    },
    reloadServers: async () => { calls.push(["reload", undefined]); return "reloaded"; },
    clearPendingAuthWatch: (id: string, key: string) => { calls.push(["clear-watch", [id, key]]); return { id, key }; },
    notifyWatchCancelled: (watch: unknown) => { calls.push(["cancel-watch", watch]); },
    lastAccountDisplayConfig: () => display,
    setLastAccountDisplayConfig: (value: unknown) => { calls.push(["display", value]); },
    lastListedState: () => state,
    setLastListedState: (value: unknown) => { calls.push(["state", value]); },
    definitionSource: { adoptAccountConfig: (value: unknown) => { calls.push(["adopt-config", value]); } },
    invalidateToolsCache: () => { calls.push(["invalidate-tools", undefined]); },
    resetPushState: () => { calls.push(["reset-push", undefined]); },
  };
  return { lifecycle: new SlateMcpAccountSlotLifecycle(deps as never), calls, display, state };
}

describe("MCP account-slot lifecycle", () => {
  it("normalizes logout account labels and clears only that pending auth watch", async () => {
    const h = harness();
    assert.equal(await h.lifecycle.logoutAccount("11", " WORK "), "reloaded");
    assert.deepEqual(h.calls.filter(([kind]) => kind === "logout"), [["logout", { serverUrl: "https://mcp.example", accountKey: "work" }]]);
    assert.deepEqual(h.calls.filter(([kind]) => kind === "clear-watch"), [["clear-watch", ["11", "work"]]]);
    assert.equal(h.calls.filter(([kind]) => kind === "cancel-watch").length, 0);
  });

  it("renames a slot in display and listed state, keeps its token flag, and retires its watch", async () => {
    const h = harness();
    const result = await h.lifecycle.renameAccount("11", " WORK ", " Build ") as { servers: Array<Record<string, unknown>> };
    assert.deepEqual(h.calls.find(([kind]) => kind === "rename")?.[1], {
      serverId: 11,
      accountKey: "work",
      newAccountKey: "build",
    });
    const display = h.calls.find(([kind]) => kind === "display")?.[1] as typeof h.display;
    assert.deepEqual(display?.servers[0]?.accounts, [
      { accountKey: "build", hasToken: true },
      { accountKey: "home", hasToken: false },
    ]);
    const state = h.calls.find(([kind]) => kind === "state")?.[1] as { servers: Array<Record<string, unknown>> };
    assert.equal(state.servers[0]?.accountKey, "build");
    assert.equal(state.servers[0]?.serverIdentifier, "mcp-row-11--build");
    assert.equal(state.servers[1]?.accountKey, "home");
    assert.equal(state.servers[2]?.serverIdentifier, "other");
    assert.deepEqual(result, state);
    assert.equal(h.calls.some(([kind]) => kind === "cancel-watch"), true);
    assert.equal(h.calls.some(([kind]) => kind === "adopt-config"), true);
    assert.equal(h.calls.some(([kind]) => kind === "invalidate-tools"), true);
    assert.equal(h.calls.some(([kind]) => kind === "reset-push"), true);
  });

  it("removes the selected account and its summary while cancelling its watch", async () => {
    const h = harness();
    const updated = await h.lifecycle.removeAccount("11", "work") as { servers: Array<Record<string, unknown>> };
    assert.deepEqual(h.calls.find(([kind]) => kind === "delete")?.[1], { serverId: 11, accountKey: "work" });
    const display = h.calls.find(([kind]) => kind === "display")?.[1] as typeof h.display;
    assert.deepEqual(display?.servers[0]?.accounts, [{ accountKey: "home", hasToken: false }]);
    const state = h.calls.find(([kind]) => kind === "state")?.[1] as { servers: Array<Record<string, unknown>> };
    assert.deepEqual(state.servers.map((server) => server.serverIdentifier), ["old-home", "other"]);
    assert.deepEqual(updated, state);
    assert.equal(h.calls.some(([kind]) => kind === "cancel-watch"), true);
  });

  it("reloads instead of committing when there is no prior snapshot or the final slot is removed", async () => {
    const withoutState = harness({ withState: false });
    assert.equal(await withoutState.lifecycle.removeAccount("11", "work"), "reloaded");
    assert.equal(withoutState.calls.some(([kind]) => kind === "display"), false);
    assert.equal(withoutState.calls.at(-1)?.[0], "reload");

    const lastSlot = harness({ accounts: [{ accountKey: "work", hasToken: true }] });
    assert.equal(await lastSlot.lifecycle.removeAccount("11", "work"), "reloaded");
    assert.equal(lastSlot.calls.some(([kind]) => kind === "display"), false);
    assert.equal(lastSlot.calls.at(-1)?.[0], "reload");
  });

  it("rejects malformed ids, missing servers, and servers without OAuth URLs", async () => {
    const h = harness();
    await assert.rejects(() => h.lifecycle.logoutAccount("not-an-id", "work"), /positive decimal string/);
    await assert.rejects(() => h.lifecycle.logoutAccount("99", "work"), /MCP server not found/);
    const local = harness({ stdio: true });
    await assert.rejects(() => local.lifecycle.logoutAccount("11", "work"), /no OAuth accounts/);
  });
});
