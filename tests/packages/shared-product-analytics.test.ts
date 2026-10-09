/**
 * The product analytics this host reports: what is deferred until the platform's gate allows it, what is sent once it
 * does, and what is never sent at all.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TrackEventsRequest } from "../../source/packages/proto/generated/aiserver/v1/analytics_pb.ts";
import { SLATE_PRODUCT_ANALYTICS_GATE, SlateProductAnalytics, type ProductAnalyticsClient, type ProductAnalyticsGate } from "../../source/shared/node/analytics/product-analytics.ts";

const account = { getAccessToken: async () => "token", getMachineId: async () => "machine" };

/** The events a flush actually sent, as the client saw them, with each value as the wire carries it. */
function eventWorld(options: { hostInBox?: boolean } = {}) {
  const sent: { name: string; props: Record<string, unknown>; timestamp: string }[] = [];
  const client: ProductAnalyticsClient = {
    trackEvents: async (request: TrackEventsRequest) => {
      for (const event of request.events) {
        const props: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(event.eventData)) props[key] = carriedValue(value);
        sent.push({ name: event.eventName, props, timestamp: String(event.timestamp) });
      }
      return {};
    },
  };
  const named: string[] = [];
  const analytics = new SlateProductAnalytics({
    hostInBox: options.hostInBox ?? false,
    ...account,
    createClient: () => client,
  });
  const gate = (enabled: boolean | "throws", listeners: (() => void)[] = []): ProductAnalyticsGate => ({
    checkGate: async (name) => {
      named.push(name);
      if (enabled === "throws") throw new Error("the gate is unreachable");
      return enabled;
    },
    subscribe: (listener) => {
      listeners.push(listener);
      return () => void listeners.splice(listeners.indexOf(listener), 1);
    },
  });
  return { analytics, sent, named, gate };
}

/** What a property on the wire carries: the oneof as written, however deep it is nested. */
function carriedValue(value: unknown): unknown {
  const record = value as Record<string, unknown> | null;
  if (record == null) return undefined;
  if ("case" in record) return record["value"];
  const only = Object.keys(record)[0];
  return only == null ? undefined : carriedValue(record[only]);
}

/** A flush has to happen for anything to be sent. */
const flushAndRead = async (analytics: SlateProductAnalytics, sent: { name: string }[]) => {
  await analytics.flush();
  return sent.map((event) => event.name);
};

describe("product analytics", () => {
  it("carries what the host is with every event, and the caller's own props over it", async () => {
    const world = eventWorld({ hostInBox: true });
    world.analytics.trackEvent("slate.something", { what: 1, client: "caller" });
    assert.deepEqual(await flushAndRead(world.analytics, world.sent), []);
    await world.analytics.activate(world.gate(true));
    assert.deepEqual(await flushAndRead(world.analytics, world.sent), ["slate.something"]);
    const props = world.sent[0]!.props;
    assert.deepEqual([props["client"], props["host_in_box"], props["what"], props["os"], props["arch"]], ["caller", true, 1, process.platform, process.arch]);
    assert.equal(typeof props["slate_version"], "string");
    // An event with no props of its own says which client it came from.
    world.analytics.trackEvent("slate.plain");
    await world.analytics.flush();
    assert.equal(world.sent[1]!.props["client"], "slate");
    assert.equal(SLATE_PRODUCT_ANALYTICS_GATE, "slate_product_analytics");
  });

  it("defers what happened while the gate was off, and hands it over when it turns on", async () => {
    const world = eventWorld();
    await world.analytics.activate(world.gate(false));
    assert.deepEqual(world.named, [SLATE_PRODUCT_ANALYTICS_GATE]);
    assert.equal(world.analytics.state.kind, "deferred");
    world.analytics.trackEvent("first");
    world.analytics.trackEvent("second");
    assert.equal(world.analytics.canRecordEvents(), true);
    // Nothing goes out while it is deferred.
    assert.deepEqual(await flushAndRead(world.analytics, world.sent), []);
    assert.equal(world.sent.length, 0);
    // A gate that later says yes hands over what was deferred, in the order it happened.
    const listeners: (() => void)[] = [];
    const second = eventWorld();
    await second.analytics.activate(second.gate(false, listeners));
    second.analytics.trackEvent("first");
    second.analytics.trackEvent("second");
    let enabled = true;
    let asked = 0;
    const lateListeners: (() => void)[] = [];
    second.analytics.gate = { checkGate: async () => (asked += 1, enabled), subscribe: (listener) => (lateListeners.push(listener), () => {}) };
    listeners.forEach((listener) => listener());
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(second.analytics.state.kind, "active");
    assert.deepEqual(await flushAndRead(second.analytics, second.sent), ["first", "second"]);
    // The gate subscription is let go once the state settled, so a later refresh is not listened to at all.
    assert.deepEqual([listeners.length, lateListeners.length], [0, 0]);
    // And a settled state does not go through the gate again, even when it is asked to evaluate once more.
    enabled = false;
    const settled = second.analytics.state;
    await (second.analytics as unknown as { evaluateGate(): Promise<void> }).evaluateGate();
    assert.deepEqual([asked, second.analytics.state === settled], [1, true]);
  });

  it("bounds what is deferred", async () => {
    const world = eventWorld();
    await world.analytics.activate(world.gate(false));
    for (let index = 0; index < 300; index += 1) world.analytics.trackEvent(`event-${index}`);
    assert.equal(world.analytics.state.kind, "deferred");
    assert.equal(world.analytics.state.kind === "deferred" ? world.analytics.state.buffer.getEvents().length : -1, 256);
    assert.equal(world.analytics.canRecordEvents(), true);
  });

  it("drops what it had when the account opts out while waiting, and records nothing when it starts opted out", async () => {
    const deferred = eventWorld();
    const deferredListeners: (() => void)[] = [];
    await deferred.analytics.activate(deferred.gate(false, deferredListeners));
    deferred.analytics.trackEvent("while-waiting");
    const heldWhileWaiting = deferred.analytics.state.kind === "deferred" ? deferred.analytics.state.buffer : null;
    assert.equal(heldWhileWaiting?.getEvents().length, 1);
    process.env["SLATE_DISABLE_ANALYTICS"] = "1";
    try {
      deferredListeners.forEach((listener) => listener());
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(deferred.analytics.state.kind, "disabled");
      // What it was holding is let go rather than kept for a state that will never send it.
      assert.deepEqual([deferred.sent, deferred.analytics.canRecordEvents(), heldWhileWaiting?.getEvents().length], [[], false, 0]);
      // An account that starts opted out records nothing at all: no deferral, no gate to watch.
      const optedOut = eventWorld();
      assert.deepEqual([optedOut.analytics.state.kind, optedOut.analytics.canRecordEvents()], ["disabled", false]);
      optedOut.analytics.trackEvent("never");
      optedOut.analytics.markActive("startup");
      await optedOut.analytics.activate(optedOut.gate(true));
      assert.deepEqual([optedOut.named, optedOut.sent], [[], []]);
      assert.equal(optedOut.analytics.state.kind, "disabled");
    } finally {
      delete process.env["SLATE_DISABLE_ANALYTICS"];
    }
  });

  it("treats a gate it could not ask, or one that failed, as an analytics host that is off", async () => {
    const unreachable = eventWorld();
    await unreachable.analytics.activate(unreachable.gate("throws"));
    assert.equal(unreachable.analytics.state.kind, "deferred");
    unreachable.analytics.trackEvent("while-unreachable");
    assert.deepEqual(await flushAndRead(unreachable.analytics, unreachable.sent), []);
    // A buffer that could not be built is a disabled analytics, not a thrown activate.
    const broken = eventWorld();
    broken.analytics.options = { ...broken.analytics.options, createClient: () => { throw new Error("no client"); } };
    await broken.analytics.activate(broken.gate(true));
    assert.equal(broken.analytics.state.kind, "disabled");
    assert.equal(broken.analytics.canRecordEvents(), false);
  });

  it("says the app was used today, once per reason per day, and only while it records", async () => {
    const world = eventWorld();
    // Waiting for the gate is still recording: the day's first use is deferred like anything else, and said once.
    world.analytics.markActive("startup");
    world.analytics.markActive("startup");
    assert.deepEqual(world.analytics.lastActiveDayKeys.size, 1);
    await world.analytics.activate(world.gate(true));
    world.analytics.markActive("startup");
    world.analytics.markActive("resume");
    assert.deepEqual(await flushAndRead(world.analytics, world.sent), ["slate.app.active", "slate.app.active"]);
    assert.deepEqual(world.sent.map((event) => event.props["reason"]), ["startup", "resume"]);
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual([...world.analytics.lastActiveDayKeys.entries()], [["startup", today], ["resume", today]]);
    // Once it is enabled, activating again is nothing, and disposing lets the gate go.
    await world.analytics.activate(world.gate(true));
    assert.deepEqual(world.named.length >= 1, true);
    await world.analytics.dispose();
  });
});
