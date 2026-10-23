import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CoordinatorGatewayClient,
  GatewayEndpointChangedError,
  createCoordinatorGatewayClientTiming,
  extractGatewayErrorMessage,
  withAuth,
  SlateGatewayCommandError,
  type CoordinatorGatewayClientOptions,
} from "../../source/coordinator/gateway/gateway-client.ts";
import { SlateGatewayUnreachableError } from "../../source/coordinator/gateway/gateway-reachability.ts";

const realFetch = globalThis.fetch;
function response(options: any) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    headers: { get: (name: string) => options.headers?.[name] ?? null },
    async text() { return options.body ?? ""; },
    async json() { return options.json ?? {}; },
    async cancel() { return undefined; },
    body: null,
  };
}
function withFetch(handler: (url: string, init: any) => any, run: () => Promise<unknown>) {
  globalThis.fetch = (async (url: string, init: any) => handler(String(url), init)) as never;
  return run().finally(() => { globalThis.fetch = realFetch; });
}
function client(options: any = {}) {
  const events: any[] = [];
  const reachability: any[] = [];
  const stages: any[] = [];
  let retries = 0;
  const created = new CoordinatorGatewayClient({
    resolveConnection: async () => ({ baseUrl: options.baseUrl ?? "http://gateway.test", token: options.token, headers: options.headers }),
    timing: createCoordinatorGatewayClientTiming(),
    onEvent: (event: any) => events.push(event),
    onTransportRetry: () => { retries += 1; },
    onReachability: (report: any, baseUrl?: string) => reachability.push({ report, baseUrl }),
    recordTransportStage: (report: any) => stages.push(report),
  } as CoordinatorGatewayClientOptions);
  return { created, events, reachability, stages, retries: () => retries };
}

describe("the coordinator's gateway client", () => {
  it("adds the auth and slim-avatar headers", () => {
    assert.deepEqual(withAuth({ "content-type": "application/json" }, { baseUrl: "http://x", token: "secret" } as never), { "content-type": "application/json", authorization: "Bearer secret" });
    assert.deepEqual(withAuth({}, { baseUrl: "http://x", token: "" } as never), {});
  });

  it("extracts the gateway's error message", () => {
    assert.equal(extractGatewayErrorMessage('{"error":"bad args"}'), "bad args");
    assert.equal(extractGatewayErrorMessage('{"error":""}'), null);
    assert.equal(extractGatewayErrorMessage("not json"), null);
  });

  it("sends a command with its deadline and returns the result", async () => {
    const { created } = client();
    const outcome = await withFetch(() => response({ json: { ok: true }, headers: { "x-slate-mint-dedupe": "1" } }), () => created.request("doThing", { a: 1 })) as any;
    assert.deepEqual(outcome.result, { ok: true });
    assert.equal(outcome.connection.baseUrl, "http://gateway.test");
  });

  it("reports a 4xx as a command error and a 5xx as unreachable", async () => {
    const { created, reachability } = client();
    await assert.rejects(withFetch(() => response({ ok: false, status: 400, body: '{"error":"bad args"}' }), () => created.request("doThing", {})), (error: any) => error instanceof SlateGatewayCommandError && /bad args/.test(error.message));
    await assert.rejects(withFetch(() => response({ ok: false, status: 503, body: "down" }), () => created.request("doThing", {})), (error: any) => error instanceof SlateGatewayUnreachableError && error.kind === "http_5xx");
    assert.equal(reachability.length, 1);
  });

  it("reports a network failure as unreachable", async () => {
    const { created, reachability } = client({ baseUrl: "http://net.test" });
    await assert.rejects(withFetch(() => { throw new Error("socket hang up"); }, () => created.request("doThing", {})), (error: any) => error instanceof SlateGatewayUnreachableError);
    assert.equal(reachability.length, 1);
    assert.equal(reachability[0]?.report.outcome === "ok", false);
  });

  it("refuses a gateway whose endpoint changed under it", async () => {
    const { created } = client({ baseUrl: "http://new.test" });
    await assert.rejects(withFetch(() => response({ json: {} }), () => created.request("doThing", {}, { requiredBaseUrl: "http://old.test" })), GatewayEndpointChangedError);
  });

  it("dispatches event blocks with a channel", () => {
    const { created, events } = client();
    created.dispatchEventBlock("event: one\ndata: {\"channel\":\"alpha\",\"payload\":{\"n\":1}}\n", null);
    created.dispatchEventBlock("data: not json\n", null);
    created.dispatchEventBlock("data: {\"channel\":\"\",\"payload\":{}}\n", null);
    created.dispatchEventBlock("data: {\"channel\":\"forever-box\",\"payload\":{\"state\":\"running\"}}\n", { vnc: true } as never);
    assert.deepEqual(events[0], { channel: "alpha", payload: { n: 1 } });
    assert.equal(events[1]?.channel, "forever-box");
  });

  it("fails closed when the dev controls take the client offline", async () => {
    const { created } = client();
    assert.deepEqual(created.setDevInducedOffline(true), { induced: true });
    await assert.rejects(created.resolveConnection(), (error: any) => error instanceof SlateGatewayUnreachableError && /induced by dev controls/.test(error.message));
    created.setDevInducedOffline(false);
    assert.deepEqual(created.setClientPaused(true), { paused: true });
    await assert.rejects(created.resolveConnection(), (error: any) => error instanceof SlateGatewayUnreachableError && /blocked/.test(error.message));
    created.setClientPaused(false);
    assert.equal((await created.resolveConnection()).baseUrl, "http://gateway.test");
  });

  it("routes a legacy command through the command path", async () => {
    const { created } = client();
    assert.deepEqual(await withFetch(() => response({ json: { done: true } }), () => created.dispatchLegacyCommand("legacyThing", {})), undefined);
  });
});
