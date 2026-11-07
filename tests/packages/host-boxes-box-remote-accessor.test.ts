import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BoxRemoteExecManager,
  classifyPingFailure,
  createBoxAuthorizationInterceptor,
  createBoxRemoteResourceAccessor,
  createBoxRemoteResourceAccessorFromTransport,
  createBoxTransport,
  pingBox,
  pingBoxTransport,
  pingBoxTransportClassified,
} from "../../source/host/boxes/box-remote-accessor.ts";

describe("reaching a box over the tunnel", () => {
  it("authorizes every request with the box's token and its extra headers, in order", async () => {
    const set: Array<[string, string]> = [];
    const intercepted = createBoxAuthorizationInterceptor({ host: "box", port: 1, authToken: "token", headers: { "X-One": "1" } })(
      async (request: { header: { set(name: string, value: string): void } }) => { request.header.set("Next", "called"); return "answer"; },
    );
    const result = await intercepted({ header: { set: (name: string, value: string) => set.push([name, value]) } });
    assert.equal(result, "answer");
    assert.deepEqual(set, [["Authorization", "Bearer token"], ["X-One", "1"], ["Next", "called"]]);
  });

  it("builds the transport options a box is reached with", () => {
    const calls: any[] = [];
    const transport = createBoxTransport({ host: "127.0.0.1", port: 4_000, authToken: "t" }, (options) => { calls.push(options); return "transport"; });
    assert.equal(transport, "transport");
    assert.equal(calls[0].httpVersion, "1.1");
    assert.equal(calls[0].baseUrl, "http://127.0.0.1:4000");
    assert.equal(calls[0].useBinaryFormat, true);
    assert.equal(calls[0].interceptors.length, 1);
  });

  it("classifies a failed ping as timeout, refused or crash", () => {
    assert.deepEqual(classifyPingFailure({ code: 4 }), { outcome: "timeout", causeSummary: "DeadlineExceeded" });
    assert.deepEqual(classifyPingFailure(new Error("deadline exceeded")), { outcome: "timeout", causeSummary: "unknown" });
    assert.deepEqual(classifyPingFailure(Object.assign(new Error("connect"), { code: "ECONNREFUSED" })), { outcome: "refused", causeSummary: "ECONNREFUSED/ECONNREFUSED" });
    assert.deepEqual(classifyPingFailure({ code: 14 }), { outcome: "crash", causeSummary: "Unavailable" });
    assert.deepEqual(classifyPingFailure("boom"), { outcome: "crash", causeSummary: "unknown" });
  });

  it("pings through a control client and reports how long it took", async () => {
    const calls: any[] = [];
    const times = [10, 15];
    let index = 0;
    const result = await pingBoxTransportClassified("CTX" as never, "transport" as never, (transport) => { calls.push({ controlClientFor: transport }); return { ping: async (ctx, request, options) => { calls.push({ ctx, request, options }); return "pong"; } }; }, 250, () => times[Math.min(index++, 1)] as number);
    assert.deepEqual(result, { outcome: "ok", latencyMs: 5 });
    assert.deepEqual(calls, [{ controlClientFor: "transport" }, { ctx: "CTX", request: {}, options: { timeoutMs: 250 } }]);
    const classified = await pingBoxTransportClassified("CTX" as never, "transport" as never, () => ({ ping: async () => { throw { code: 4 }; } }));
    assert.deepEqual([classified.outcome, typeof classified.latencyMs], ["timeout", "number"]);
  });

  it("answers whether a box answered, through either wrapper", async () => {
    const ok = await pingBoxTransport("CTX" as never, "transport" as never, () => ({ ping: async () => "pong" }), 250 as never);
    assert.equal(ok, true);
    const failed = await pingBox("CTX" as never, { host: "box", port: 3, authToken: "t" }, {
      createTransport: () => "transport",
      createControlClient: () => ({ ping: async () => { throw { code: 4 }; } }),
    }, 250 as never);
    assert.equal(failed, false);
  });

  it("runs a box's exec stream: yields its client messages and throws its control errors", async () => {
    const execCalls: any[] = [];
    const messages = [
      { element: { case: "execClientMessage", value: { kind: "stdout", text: "one" } } },
      { element: { case: "execClientControlMessage", value: { message: { case: "heartbeat", value: { id: 3 } } } } },
      { element: { case: "execClientMessage", value: { kind: "stdout", text: "two" } } },
    ];
    const client = { exec: async function* (ctx: unknown, args: unknown) { execCalls.push({ ctx, args }); for (const message of messages) yield message; } };
    const manager = new BoxRemoteExecManager(client as never);
    const yielded: any[] = [];
    for await (const message of manager.createExecInstance("CTX" as never, (id) => ({ requestId: id } as never))) yielded.push(message);
    assert.deepEqual(yielded, [{ kind: "stdout", text: "one" }, { kind: "stdout", text: "two" }]);
    for await (const message of manager.createExecInstance("CTX" as never, (id) => ({ requestId: id } as never))) void message;
    assert.deepEqual(execCalls, [{ ctx: "CTX", args: { requestId: 0 } }, { ctx: "CTX", args: { requestId: 1 } }], "each instance gets its own request id");
    // A control throw becomes an error carrying the box's message, stack and retry-classification code.
    const throwing = new BoxRemoteExecManager({ exec: async function* () { yield { element: { case: "execClientControlMessage", value: { message: { case: "throw", value: { error: "box failed", stackTrace: "box stack", errorCode: "BOX_EXEC_UNSUPPORTED" } } } } }; } } as never);
    await assert.rejects(
      async () => { for await (const message of throwing.createExecInstance("CTX" as never, () => ({}) as never)) void message; },
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).message, "box failed");
        assert.equal((error as Error).stack, "box stack");
        assert.equal((error as Error & { errorCode?: string }).errorCode, "BOX_EXEC_UNSUPPORTED");
        return true;
      },
    );
  });

  it("wires a resource accessor from a transport or from an endpoint", () => {
    const calls: any[] = [];
    const fromTransport = createBoxRemoteResourceAccessorFromTransport("transport", {
      createExecClient: (transport) => { calls.push({ execClientFor: transport }); return "exec-client" as never; },
      createResourceAccessor: (manager) => { calls.push({ managerHasExec: typeof manager.createExecInstance }); return "accessor" as never; },
    });
    assert.equal(fromTransport, "accessor");
    const fromEndpoint = createBoxRemoteResourceAccessor({ host: "box", port: 8, authToken: "t" }, {
      createTransport: (options) => { calls.push({ baseUrl: options.baseUrl }); return "transport"; },
      createExecClient: () => "exec-client" as never,
      createResourceAccessor: () => "accessor" as never,
    });
    assert.equal(fromEndpoint, "accessor");
    assert.deepEqual(calls, [{ execClientFor: "transport" }, { managerHasExec: "function" }, { baseUrl: "http://box:8" }]);
  });
});
