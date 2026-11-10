import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  McpOAuthForwarder,
  OAuthPendingRegistry,
} from "../../source/coordinator/oauth/mcp-oauth-forwarder.ts";

const auth = (serverName = "server-1") => ({ serverName, expiry: { dispose: () => {} } });

describe("the pending OAuth registry", () => {
  it("stores, resolves and removes pending authorizations", () => {
    const registry = new OAuthPendingRegistry();
    registry.add("https://a.test", "state-1", auth("server-a"));
    registry.add("https://a.test", "state-2", auth("server-b"));
    registry.add("https://b.test", "state-3", auth("server-a"));
    assert.equal(registry.resolve("https://a.test", "state-1"), "server-a");
    assert.equal(registry.resolve("https://a.test", "missing"), undefined);
    assert.equal(registry.hasPendingFor("https://a.test"), true);
    const removed = registry.remove("https://a.test", "state-1");
    assert.equal(removed?.serverName, "server-a");
    assert.equal(registry.remove("https://a.test", "state-1"), undefined);
    const evicted = registry.removeServer("server-a");
    assert.equal(evicted.length, 1);
    assert.equal(registry.hasPendingFor("https://a.test"), true);
    const all = registry.removeAll();
    assert.equal(all.length, 1);
    assert.equal(registry.hasPendingFor("https://a.test"), false);
  });
});

function harness(options: { failStart?: boolean } = {}) {
  const warnings: any[] = [];
  const completions: any[] = [];
  const disposed: string[] = [];
  const closed: string[] = [];
  const armed: Array<{ key: string; fire: () => void }> = [];
  let subscribe: ((pending: any) => void) | undefined;
  const forwarder = new McpOAuthForwarder({
    completion: { completeMcpOAuth: async (value: any) => { completions.push(value); } },
    log: { warn: (entry: any) => warnings.push(entry) } as never,
    pendingEvents: { subscribe: (listener: any) => { subscribe = listener; return { dispose: () => disposed.push("subscription") }; } },
    pendingExpiry: { arm: (key: string, callback: () => void) => { armed.push({ key, fire: callback }); return { dispose: () => disposed.push(key) }; } } as never,
    startListener: (async (args: any) => {
      if (options.failStart === true) throw new Error("cannot listen");
      listenerArgs = args;
      return { close: () => closed.push(args.redirectUrl) };
    }) as never,
  });
  let listenerArgs: any;
  return { forwarder, warnings, completions, disposed, closed, armed, emit: (pending: any) => subscribe?.(pending), listenerArgs: () => listenerArgs };
}
const pending = (overrides: Record<string, unknown> = {}) => ({ redirectUrl: "https://connector.test/callback", state: "state-1", serverName: "server-1", ...overrides });

describe("the MCP OAuth forwarder", () => {
  it("warns about an unreadable redirect url", async () => {
    const fake = harness();
    fake.emit(pending({ redirectUrl: "not a url" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fake.warnings[0]!.kind, "invalid-redirect-url");
    fake.forwarder.dispose();
  });

  it("starts one listener per origin and tracks the pending state", async () => {
    const fake = harness();
    fake.emit(pending());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fake.armed.length, 1);
    assert.deepEqual(fake.listenerArgs().redirectUrl, "https://connector.test/callback");
    assert.deepEqual(fake.listenerArgs().resolve("state-1"), { serverName: "server-1" });
    fake.emit(pending({ state: "state-2", serverName: "server-2" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fake.closed.length, 0);
    await fake.listenerArgs().onCallback({ code: "code-1", state: "state-1" });
    assert.deepEqual(fake.completions, [{ code: "code-1", state: "state-1" }]);
    fake.listenerArgs().onSettled("state-1");
    fake.listenerArgs().onSettled("state-2");
    assert.equal(fake.closed.length, 1);
    fake.forwarder.dispose();
    assert.equal(fake.disposed.includes("subscription"), true);
  });

  it("reports a listener that cannot start", async () => {
    const fake = harness({ failStart: true });
    fake.emit(pending());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fake.warnings[0]!.kind, "listener-start-failed");
    assert.equal(fake.listenerArgs(), undefined);
    fake.forwarder.dispose();
  });

  it("disposes a superseded pending authorization", async () => {
    const fake = harness();
    fake.emit(pending());
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.emit(pending({ state: "state-2" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fake.disposed.some((entry) => entry.includes("state-1")), true);
    fake.forwarder.dispose();
  });
  it("closes its listeners and pending work on dispose", async () => {
    const fake = harness();
    fake.emit(pending());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fake.closed.length, 0);
    fake.forwarder.dispose();
    assert.equal(fake.closed.length, 1);
    assert.equal(fake.disposed.includes("subscription"), true);
    assert.equal(fake.disposed.some((entry) => entry.includes("state-1")), true);
  });
});
