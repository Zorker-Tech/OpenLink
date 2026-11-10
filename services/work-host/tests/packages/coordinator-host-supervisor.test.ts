import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GatewayConnectResolveAbandonedError,
  HEALTH_PROBE_TTL_MS,
  SlateHostSupervisor,
  fetchHealth,
  type GatewayConnection,
  type HealthReachabilityReport,
} from "../../source/coordinator/gateway/host-supervisor.ts";

function fakeTiming(initial = 0) {
  let now = initial;
  return {
    timing: { clock: { monotonicNow: () => now }, healthProbeDeadline: { run: async (fn: (signal: AbortSignal) => Promise<unknown>) => fn(new AbortController().signal) } } as never,
    advance: (delta: number) => { now += delta; },
  };
}
function withFetch(handler: (url: string, init: unknown) => Promise<unknown>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init: unknown) => { calls.push(String(url)); return handler(String(url), init); }) as never;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const reports: HealthReachabilityReport[] = [];
const connection = (baseUrl = "http://127.0.0.1:1234"): GatewayConnection => ({ baseUrl });

describe("probing the host health endpoint", () => {
  it("returns the health payload when the host is healthy", async () => {
    const fake = withFetch(async () => ({ ok: true, json: async () => ({ ok: true, version: 3 }) }));
    try {
      const result = await fetchHealth(fakeTiming().timing as never, "http://127.0.0.1:1", undefined, (report) => reports.push(report));
      assert.deepEqual(result, { ok: true, version: 3 });
      assert.equal(fake.calls[0], "http://127.0.0.1:1/health");
    } finally { fake.restore(); }
  });

  it("reports an unhealthy status and a fetch failure", async () => {
    const collected: HealthReachabilityReport[] = [];
    const unhealthy = withFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    try {
      assert.equal(await fetchHealth(fakeTiming(5).timing as never, "http://127.0.0.1:1", undefined, (report) => collected.push(report)), null);
    } finally { unhealthy.restore(); }
    assert.equal(collected[0]!.httpStatus, 503);
    assert.equal(collected[0]!.latencyMs, 0);
    assert.equal(collected[0]!.baseUrlKind, "loopback");
    const failing = withFetch(async () => { throw new Error("connection refused"); });
    try {
      assert.equal(await fetchHealth(fakeTiming().timing as never, "http://127.0.0.1:1", undefined, (report) => collected.push(report)), null);
    } finally { failing.restore(); }
    assert.equal(collected[1]!.method, "health");
    assert.equal(typeof collected[1]!.causeSummary, "string");
  });
});

describe("the host supervisor", () => {
  it("reuses a live connection and probes it when the transport is not live", async () => {
    const fake = fakeTiming(100);
    let resolves = 0;
    let live = true;
    const supervisor = new SlateHostSupervisor({ timing: fake.timing, resolveGatewayConnection: async () => { resolves += 1; return connection(); }, isTransportLive: () => live });
    const fetchStub = withFetch(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    try {
      const first = await supervisor.ensureConnection();
      const second = await supervisor.ensureConnection();
      assert.equal(first, second);
      assert.equal(resolves, 1);
      live = false;
      fake.advance(HEALTH_PROBE_TTL_MS - 1);
      assert.equal(await supervisor.ensureConnection(), first);
      fake.advance(10);
      assert.equal(await supervisor.ensureConnection(), first);
      assert.equal(fetchStub.calls.length, 1);
    } finally { fetchStub.restore(); }
  });

  it("connects again after the health probe fails", async () => {
    const fake = fakeTiming(0);
    let resolves = 0;
    let live = true;
    const supervisor = new SlateHostSupervisor({ timing: fake.timing, resolveGatewayConnection: async () => { resolves += 1; return connection("http://127.0.0.1:" + resolves); }, isTransportLive: () => live });
    const fetchStub = withFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    try {
      const first = await supervisor.ensureConnection();
      live = false;
      fake.advance(HEALTH_PROBE_TTL_MS + 1);
      const second = await supervisor.ensureConnection();
      assert.notEqual(first, second);
      assert.equal(resolves, 2);
    } finally { fetchStub.restore(); }
  });

  it("reports an aborted connection attempt", async () => {
    const fake = fakeTiming(0);
    const supervisor = new SlateHostSupervisor({ timing: fake.timing, resolveGatewayConnection: () => new Promise<GatewayConnection>(() => {}) });
    const controller = new AbortController();
    const running = supervisor.ensureConnection(controller.signal);
    controller.abort();
    await assert.rejects(running, (error: unknown) => error instanceof GatewayConnectResolveAbandonedError);
  });

  it("abandons a pending attempt when the health cache is invalidated", async () => {
    const fake = fakeTiming(0);
    const pending: Array<(value: GatewayConnection) => void> = [];
    let calls = 0;
    const supervisor = new SlateHostSupervisor({
      timing: fake.timing,
      resolveGatewayConnection: () => {
        calls += 1;
        if (calls === 1) return new Promise<GatewayConnection>((resolve) => pending.push(resolve));
        return Promise.resolve(connection("http://127.0.0.1:2"));
      },
    });
    const running = supervisor.ensureConnection();
    await new Promise((resolve) => setTimeout(resolve, 0));
    supervisor.invalidateHealthCache();
    pending[0]!(connection("http://127.0.0.1:1"));
    const result = await running;
    assert.equal(result.baseUrl, "http://127.0.0.1:2");
    assert.equal(calls, 2);
  });
});
