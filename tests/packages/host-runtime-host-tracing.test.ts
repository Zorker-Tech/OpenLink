/**
 * The trace a host keeps of itself: the exporter that changes its token, the resource that says where a span came from,
 * and how the whole thing starts, flushes and stops.
 */

import assert from "node:assert/strict";
import { hostname, platform } from "node:os";
import { describe, it } from "node:test";

import { ExportResultCode, initSlateHostTracing, NOOP_HOST_TRACING, resetHostTracingForTests, TokenRefreshingSpanExporter, type SpanExporter } from "../../source/host/telemetry/host-tracing.ts";
import { SLATE_CLIENT_TYPE } from "../../source/shared/node/slate-client-metadata.ts";

/** An exporter the test controls, with every call written down. */
function fakeExporter(behaviour: { failExport?: boolean; failShutdown?: boolean } = {}) {
  const calls: string[] = [];
  const exporter: SpanExporter = {
    export: (_spans, resultCallback) => { calls.push("export"); resultCallback({ code: behaviour.failExport === true ? ExportResultCode.FAILED : ExportResultCode.SUCCESS }); },
    shutdown: async () => { calls.push("shutdown"); if (behaviour.failShutdown === true) throw new Error("no shutdown here"); },
    forceFlush: async () => { calls.push("force-flush"); },
  };
  return { exporter, calls };
}

describe("the exporter that changes its token", () => {
  it("does not send anything without a token it could use", () => {
    const created: unknown[] = [];
    const exporter = new TokenRefreshingSpanExporter("https://collector.invalid/v1/traces", () => null, {}, false, (options) => { created.push(options); return fakeExporter().exporter; });
    const outcomes: number[] = [];
    exporter.export([], (result) => { outcomes.push(result.code); });
    assert.deepEqual({ created: created.length, outcomes }, { created: 0, outcomes: [ExportResultCode.FAILED] });
    // A token that cannot be read at all is the same as no token.
    const throwing = new TokenRefreshingSpanExporter("https://collector.invalid/v1/traces", () => { throw new Error("no store"); }, {});
    throwing.export([], (result) => { outcomes.push(result.code); });
    assert.deepEqual(outcomes, [ExportResultCode.FAILED, ExportResultCode.FAILED]);
    // An empty token is not a token either.
    const empty = new TokenRefreshingSpanExporter("https://collector.invalid/v1/traces", () => "", {});
    empty.export([], (result) => { outcomes.push(result.code); });
    assert.deepEqual(outcomes.length, 3);
  });

  it("keeps one exporter per token, and says which build and machine its spans came from", () => {
    const created: Array<{ url: string; headers: Record<string, string>; httpAgentOptions?: { rejectUnauthorized: boolean } }> = [];
    const made: Array<ReturnType<typeof fakeExporter>> = [];
    let token = "token-1";
    const exporter = new TokenRefreshingSpanExporter("https://collector.invalid/v1/traces", () => token, { "x-cursor-client-type": SLATE_CLIENT_TYPE }, true, (options) => { created.push(options as never); const made_ = fakeExporter(); made.push(made_); return made_.exporter; });
    const outcomes: number[] = [];
    exporter.export([], (result) => { outcomes.push(result.code); });
    assert.deepEqual(created.map((options) => [options.url, options.headers.authorization, options.httpAgentOptions]), [["https://collector.invalid/v1/traces", "Bearer token-1", { rejectUnauthorized: false }]]);
    assert.deepEqual(created[0]?.headers["x-cursor-client-type"], SLATE_CLIENT_TYPE);
    assert.deepEqual(outcomes, [ExportResultCode.SUCCESS]);
    // The same token is the same exporter.
    exporter.export([], () => {});
    assert.equal(created.length, 1);
    // A new token makes a new exporter, and the one it replaced is stopped rather than left running.
    token = "token-2";
    exporter.export([], () => {});
    // The exporter the new token replaced is stopped rather than left running.
    assert.deepEqual({ created: created.length, authorization: created[1]?.headers.authorization, replacedLastCall: made[0]?.calls.at(-1) }, { created: 2, authorization: "Bearer token-2", replacedLastCall: "shutdown" });
    // A token that goes away leaves the last exporter in place rather than dropping the trace.
    token = "";
    exporter.export([], () => {});
    assert.equal(created.length, 2);
  });

  it("reports a failed send rather than throwing at whoever is tracing", () => {
    const failing = fakeExporter({ failExport: true });
    const exporter = new TokenRefreshingSpanExporter("https://collector.invalid/v1/traces", () => "token", {}, false, () => failing.exporter);
    const outcomes: number[] = [];
    exporter.export([], (result) => { outcomes.push(result.code); });
    assert.deepEqual(outcomes, [ExportResultCode.FAILED]);
    // A factory that cannot make an exporter at all is the same story.
    const broken = new TokenRefreshingSpanExporter("https://collector.invalid/v1/traces", () => "token", {}, false, () => { throw new Error("no exporter"); });
    broken.export([], (result) => { outcomes.push(result.code); });
    assert.deepEqual(outcomes, [ExportResultCode.FAILED, ExportResultCode.FAILED]);
    // Stopping and flushing are quiet about a delegate that is not there or that refuses.
    const refusing = fakeExporter({ failShutdown: true });
    const refusingExporter = new TokenRefreshingSpanExporter("https://collector.invalid/v1/traces", () => "token", {}, false, () => refusing.exporter);
    refusingExporter.export([], () => {});
    return Promise.all([refusingExporter.shutdown(), refusingExporter.forceFlush(), new TokenRefreshingSpanExporter("https://collector.invalid/v1/traces", () => null, {}).shutdown()]).then(() => {
      assert.deepEqual(refusing.calls, ["export", "shutdown", "force-flush"]);
    });
  });
});

describe("the trace a host starts for itself", () => {
  function harness(options: { serviceVersion?: string; insecure?: boolean; failProvider?: boolean; noProvider?: boolean } = {}) {
    resetHostTracingForTests();
    const providers: Array<{ resource: Record<string, string>; exporterUrl: string; exporterHeaders: Record<string, string>; sampler: unknown }> = [];
    const calls: string[] = [];
    // The exporter the tracing builds is asked for its own url and headers through the factory seam.
    const created: Array<{ url: string; headers: Record<string, string> }> = [];
    const tracing = initSlateHostTracing({
      backendUrl: "https://backend.invalid/",
      getToken: () => "token-1",
      ...(options.serviceVersion === undefined ? {} : { serviceVersion: options.serviceVersion }),
      ...(options.insecure === undefined ? {} : { insecure: options.insecure }),
      createExporter: (exporterOptions) => { created.push(exporterOptions as never); return fakeExporter().exporter; },
      createProvider: (config) => {
        if (options.failProvider === true) throw new Error("no provider here");
        if (options.noProvider === true) return undefined as never;
        providers.push({ resource: config.resource, exporterUrl: (config.exporter as unknown as { url: string }).url, exporterHeaders: (config.exporter as unknown as { baseHeaders: Record<string, string> }).baseHeaders, sampler: config.sampler });
        return { register: () => { calls.push("register"); }, forceFlush: async () => { calls.push("force-flush"); }, shutdown: async () => { calls.push("shutdown"); } };
      },
    });
    return { tracing, providers, calls, created };
  }

  it("starts once, with the endpoint, the headers and the resource the platform reads", () => {
    const first = harness({ serviceVersion: "1.2.3" });
    assert.deepEqual(first.calls, ["register"]);
    // What the spans are sent to is the platform's own collect endpoint, with the headers this build sends.
    assert.deepEqual(first.providers[0]?.exporterUrl, "https://backend.invalid/v1/traces");
    assert.deepEqual(first.providers[0]?.exporterHeaders, { "x-ghost-mode": "false", "x-cursor-client-type": SLATE_CLIENT_TYPE, "x-cursor-client-version": "slate-host" });
    // Nothing is sent anywhere until a token makes an exporter worth making.
    assert.deepEqual(first.created, []);
    assert.deepEqual(first.providers[0]?.resource, {
      "service.name": "slate-host",
      "service.version": "1.2.3",
      "host.name": hostname(),
      "os.type": platform(),
      "process.runtime.name": "node",
      "process.runtime.version": process.version,
      "deployment.environment": "box",
    });
    // A second start is the same tracing, and nothing is registered twice.
    const again = initSlateHostTracing({ backendUrl: "https://other.invalid", getToken: () => "token-2" });
    assert.equal(again, first.tracing);
    assert.deepEqual(first.calls, ["register"]);
    // A version that was not given is not claimed.
    const bare = harness();
    assert.equal(bare.providers[0]?.resource["service.version"], "unknown");
    return first.tracing.dispose();
  });

  it("says nothing where a provider could not be made, and falls back to the platform's own where none was given", async () => {
    // A factory that could not make a provider leaves the host with nothing to trace rather than half a trace.
    const failing = harness({ failProvider: true });
    assert.equal(failing.tracing, NOOP_HOST_TRACING);
    assert.deepEqual(failing.calls, []);
    failing.tracing.flush();
    await failing.tracing.dispose();
    // A factory that had nothing to give is not an answer: the platform's own provider is used instead, which the
    // harness never sees — what it sees is a tracing that is real rather than the no-op one.
    const none = harness({ noProvider: true });
    assert.equal(none.tracing === NOOP_HOST_TRACING, false);
    assert.deepEqual(none.calls, []);
    assert.equal(typeof none.tracing.flush, "function");
    await none.tracing.dispose();
  });

  it("flushes on the way out, says when a flush failed, and stops only once", async () => {
    const world = harness();
    world.tracing.flush();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    assert.deepEqual(world.calls, ["register", "force-flush"]);
    // A flush that failed is reported to the platform's own log rather than thrown at the caller.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      // A flush that failed is reported rather than thrown at the caller.
      resetHostTracingForTests();
      const broken = { register: () => { calls.push("register"); }, forceFlush: async () => { throw new Error("collector is gone"); }, shutdown: async () => { calls.push("shutdown"); } };
      const calls: string[] = [];
      const tracing = initSlateHostTracing({ backendUrl: "https://backend.invalid", getToken: () => null, createProvider: () => broken });
      tracing.flush();
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      assert.equal(warnings.some((line) => line.startsWith("[slate-tracing] span flush failed (")), true);
      assert.deepEqual(calls, ["register"]);
      await tracing.dispose();
      assert.deepEqual(calls, ["register", "shutdown"]);
    } finally {
      console.warn = originalWarn;
    }
    // Stopping twice stops once, and the host stops listening for signals to stop on.
    const signals = ["SIGTERM", "SIGINT", "beforeExit"] as const;
    const world2 = harness();
    const before = signals.map((signal) => process.listenerCount(signal));
    resetHostTracingForTests();
    const world3 = harness();
    const withHandlers = signals.map((signal) => process.listenerCount(signal));
    await world3.tracing.dispose();
    const afterDispose = signals.map((signal) => process.listenerCount(signal));
    await world3.tracing.dispose();
    assert.deepEqual(world3.calls, ["register", "shutdown"]);
    assert.deepEqual(withHandlers.map((count, index) => count - (afterDispose.at(index) ?? 0)), [1, 1, 1]);
    assert.deepEqual(world3.calls.filter((call) => call === "shutdown").length, 1);
    assert.equal(before.length, 3);
    return world2.tracing.dispose();
  });

  it("stops when the host is asked to stop", async () => {
    const world = harness();
    process.emit("beforeExit", 0);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    assert.deepEqual(world.calls, ["register", "shutdown"]);
  });
});
