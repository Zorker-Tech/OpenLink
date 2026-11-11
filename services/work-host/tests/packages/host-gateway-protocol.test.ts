import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_GATEWAY_COMMANDS,
  SLATE_GATEWAY_SLIM_COMMANDS,
  isLoopbackHost,
  stripInlineAvatarsFromEvent,
  stripSummaryRows,
} from "../../source/gateway/gateway-protocol.ts";

/** One api call as the handler made it: the command name and the arguments it was handed. */
type Call = { readonly name: string; readonly args: readonly unknown[] };

function recorder(reply: unknown = { ok: true }): { readonly api: Record<string, unknown>; readonly calls: Call[] } {
  const calls: Call[] = [];
  const api = new Proxy({} as Record<string, unknown>, {
    get: (_target, name: string) => (...args: unknown[]) => {
      calls.push({ name, args });
      return reply;
    },
  });
  return { api, calls };
}

function handlerOf(table: Readonly<Record<string, unknown>>, method: string): (api: unknown, body: string) => unknown {
  const handler = (table as Record<string, ((api: unknown, body: string) => unknown) | undefined>)[method];
  assert.equal(typeof handler, "function", method);
  return handler as (api: unknown, body: string) => unknown;
}

async function dispatch(table: Readonly<Record<string, unknown>>, method: string, body: string): Promise<Call[]> {
  const { api, calls } = recorder();
  await handlerOf(table, method)(api, body);
  return calls;
}

describe("the gateway's command table", () => {
  it("has one handler per command, and every handler calls the api it came from", () => {
    const names = Object.keys(SLATE_GATEWAY_COMMANDS);
    assert.equal(names.length, 125);
    assert.equal(names.at(0), "getTranscript");
    assert.equal(names.at(-1), "listBoxMcpServers");
    for (const name of names) assert.equal(typeof SLATE_GATEWAY_COMMANDS[name as never], "function", name);
  });

  it("hands a command with no arguments to the api with none", async () => {
    const calls = await dispatch(SLATE_GATEWAY_COMMANDS, "listAgents", "");
    assert.deepEqual(calls, [{ name: "listAgents", args: [] }]);
  });

  it("parses the body of a command that takes one, and an empty body is an empty object", async () => {
    assert.deepEqual(await dispatch(SLATE_GATEWAY_COMMANDS, "getAgentThread", '{"agentId":"a1"}'), [{ name: "getAgentThread", args: [{ agentId: "a1" }] }]);
    assert.deepEqual(await dispatch(SLATE_GATEWAY_COMMANDS, "getAgentThread", ""), [{ name: "getAgentThread", args: [{}] }]);
  });

  it("does not claim a method it does not serve", () => {
    assert.equal(Object.hasOwn(SLATE_GATEWAY_COMMANDS, "dropTheDatabase"), false);
    assert.equal(Object.hasOwn(SLATE_GATEWAY_COMMANDS, "toString"), false);
    assert.equal(Object.hasOwn(SLATE_GATEWAY_COMMANDS, "runAgentAutomationNow"), true);
    assert.equal(Object.hasOwn(SLATE_GATEWAY_COMMANDS, "createBackgroundAgent"), true);
    assert.equal(Object.hasOwn(SLATE_GATEWAY_COMMANDS, "appendAgentTranscriptEntries"), true);
    assert.equal(Object.hasOwn(SLATE_GATEWAY_COMMANDS, "replaceAgentTranscriptEntries"), true);
  });

  it("serves the same methods, with the same handling, in its slim form", () => {
    const names = Object.keys(SLATE_GATEWAY_COMMANDS);
    assert.deepEqual(Object.keys(SLATE_GATEWAY_SLIM_COMMANDS), names);
    const stripping = new Set(["listAgents", "updateAgent", "setGroupMembers", "setAgentAvatarBytes", "createAgent", "createGroup", "duplicateAgent"]);
    for (const name of names) {
      const shared = SLATE_GATEWAY_SLIM_COMMANDS[name as never] === SLATE_GATEWAY_COMMANDS[name as never];
      assert.equal(shared, !stripping.has(name), name);
    }
  });
});

describe("the slim replies", () => {
  it("drops the inline avatar from rows without touching the rows it was given", async () => {
    const rows = [{ avatarDataUrl: "data:image/png;base64,aa", id: "a1" }, { avatarDataUrl: null, id: "a2" }];
    const { api, calls } = recorder(rows);
    await handlerOf(SLATE_GATEWAY_SLIM_COMMANDS, "listAgents")(api, "");
    assert.equal(calls.length, 1);
    const slimmed = await Promise.resolve(handlerOf(SLATE_GATEWAY_COMMANDS, "listAgents")({ listAgents: async () => rows }, ""));
    assert.deepEqual(slimmed, rows, "the plain table leaves the reply alone");
    const fromSlim = await Promise.resolve(handlerOf(SLATE_GATEWAY_SLIM_COMMANDS, "listAgents")({ listAgents: async () => rows }, ""));
    assert.deepEqual(fromSlim, [{ avatarDataUrl: null, id: "a1" }, { avatarDataUrl: null, id: "a2" }]);
    assert.equal(rows[0]?.avatarDataUrl, "data:image/png;base64,aa", "the original rows are untouched");
  });

  it("strips an inline avatar from an event only where one can be carried", () => {
    const agents = { channel: "agents", payload: { agents: [{ avatarDataUrl: "data:x", id: "a1" }] } };
    assert.deepEqual(stripInlineAvatarsFromEvent(agents), { channel: "agents", payload: { agents: [{ avatarDataUrl: null, id: "a1" }] } });
    const upserted = { channel: "agent-upserted", payload: { agent: { avatarDataUrl: "data:y", id: "a2" } } };
    assert.deepEqual(stripInlineAvatarsFromEvent(upserted), { channel: "agent-upserted", payload: { agent: { avatarDataUrl: null, id: "a2" } } });
    const other = { channel: "message", payload: { text: "hi" } };
    assert.equal(stripInlineAvatarsFromEvent(other), other);
  });

  it("returns the same rows it was given when there is nothing to strip", () => {
    const rows = [{ avatarDataUrl: null, id: "a1" }];
    assert.equal(stripSummaryRows(rows), rows);
  });
});

describe("the loopback check", () => {
  it("knows the hosts that are this machine and the ones that are not", () => {
    for (const host of ["127.0.0.1", "localhost", "LOCALHOST", " ::1 ", "[::1]"]) assert.equal(isLoopbackHost(host), true, host);
    for (const host of ["example.com", "10.0.0.1", "localhost.example.com"]) assert.equal(isLoopbackHost(host), false, host);
  });
});
