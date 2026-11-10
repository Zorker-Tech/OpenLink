/**
 * What the shared desktop reports about itself: which components and reasons are accepted, how duplicates are merged, and
 * when a snapshot becomes one telemetry event.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_COMPONENT_RESTARTS,
  MAX_DOWN_DETAIL_LENGTH,
  computeDesktopHealthMetadata,
  decideDesktopHealthForward,
  desktopHealthLevel,
  desktopHealthOverall,
  forwardDesktopHealth,
  mergeDesktopComponentHealth,
  normalizeCount,
  normalizeDesktopComponentName,
  normalizeDesktopDownReason,
  parseDesktopHealthSnapshot,
  type ComponentHealth,
  type DesktopHealth,
} from "../../source/host/telemetry/desktop-health-forwarder.ts";

const component = (overrides: Partial<ComponentHealth> = {}): ComponentHealth => ({
  name: "fork/xvfb",
  up: true,
  crashloop: false,
  restartsInWindow: 0,
  ...overrides,
});
const snapshot = (overrides: Partial<DesktopHealth> = {}): DesktopHealth => ({
  updatedAtMs: 1_000,
  revision: 3,
  supervisionEnabled: true,
  total: 1,
  up: 1,
  down: 0,
  crashlooping: 0,
  restartsInWindow: 0,
  components: [component()],
  ...overrides,
});
const rawSnapshot = (components: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ revision: 3, updatedAtMs: 1_000, supervisionEnabled: true, components, ...extra });

describe("what a component may be called, and why it may be down", () => {
  it("maps a group prefix to the scope the event uses, and refuses anything else", () => {
    assert.equal(normalizeDesktopComponentName("d1/xvfb"), "primary/xvfb");
    assert.equal(normalizeDesktopComponentName("d3/xvfb"), "fork/xvfb");
    assert.equal(normalizeDesktopComponentName("shared/dock"), "shared/dock");
    for (const bad of ["d0/xvfb", "xvfb", "d1/not-a-kind", "d1/xvfb/extra", "", undefined, 7]) {
      assert.equal(normalizeDesktopComponentName(bad), undefined, String(bad));
    }
  });

  it("keeps a known reason, categorizes a signal or an exit status, and calls the rest unknown", () => {
    assert.equal(normalizeDesktopDownReason("oom"), "oom");
    assert.equal(normalizeDesktopDownReason("port-not-listening"), "port-not-listening");
    assert.equal(normalizeDesktopDownReason("signal-SIGKILL"), "signal");
    assert.equal(normalizeDesktopDownReason("exit-137"), "exit");
    assert.equal(normalizeDesktopDownReason("exit--1"), "exit");
    assert.equal(normalizeDesktopDownReason("something else"), "unknown");
    assert.equal(normalizeDesktopDownReason(""), undefined);
    assert.equal(normalizeDesktopDownReason(1), undefined);
  });

  it("treats a count that is not a count as zero, and holds the ceiling", () => {
    assert.equal(normalizeCount(4), 4);
    assert.equal(normalizeCount(MAX_COMPONENT_RESTARTS + 5), MAX_COMPONENT_RESTARTS);
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3", null]) assert.equal(normalizeCount(bad), 0, String(bad));
  });
});

describe("two reports of one component", () => {
  it("is up only if both say so, is crashlooping if either does, and sums the restarts", () => {
    const merged = mergeDesktopComponentHealth(component({ up: true, restartsInWindow: 2 }), component({ up: false, crashloop: true, restartsInWindow: 3, downReason: "oom" }));
    assert.deepEqual(merged, { name: "fork/xvfb", up: false, crashloop: true, restartsInWindow: 5, downReason: "oom" });
    // The ceiling holds across the merge as well.
    assert.equal(mergeDesktopComponentHealth(component({ restartsInWindow: MAX_COMPONENT_RESTARTS }), component({ restartsInWindow: 5 })).restartsInWindow, MAX_COMPONENT_RESTARTS);
    // An up component carries no reason at all.
    assert.equal("downReason" in mergeDesktopComponentHealth(component(), component()), false);
  });

  it("reports the newer reason, the older one when the newer has none, and `multiple` when they disagree", () => {
    assert.equal(mergeDesktopComponentHealth(component({ up: false, downReason: "oom" }), component({ up: false, downReason: "glx" })).downReason, "multiple");
    assert.equal(mergeDesktopComponentHealth(component({ up: false, downReason: "oom" }), component({ up: false })).downReason, "oom");
    assert.equal(mergeDesktopComponentHealth(component({ up: false }), component({ up: false })).downReason, "unknown");
  });
});

describe("reading a snapshot", () => {
  it("keeps the components this platform runs, merges duplicates, and counts from them", () => {
    const parsed = parseDesktopHealthSnapshot(
      rawSnapshot([
        { name: "d1/xvfb", up: true },
        { name: "d3/xvfb", up: false, downReason: "oom", restartsInWindow: 2 },
        { name: "other/xvfb", up: true },
        { name: "d3/xvfb", up: true, crashloop: true },
        "not an object",
      ]),
    );
    assert.notEqual(parsed, null);
    assert.deepEqual(parsed!.components.map((entry) => entry.name), ["primary/xvfb", "fork/xvfb"]);
    assert.deepEqual([parsed!.total, parsed!.up, parsed!.down, parsed!.crashlooping, parsed!.restartsInWindow], [2, 1, 1, 1, 2]);
    // The snapshot's own totals are not trusted: they are not even read.
    const lies = parseDesktopHealthSnapshot(rawSnapshot([{ name: "d1/xvfb", up: true }], { total: 99, up: 0, down: 99 }));
    assert.deepEqual([lies!.total, lies!.up, lies!.down], [1, 1, 0]);
    assert.equal(parseDesktopHealthSnapshot(rawSnapshot([{ name: "d1/xvfb", up: true }], { supervisionEnabled: "yes" }))!.supervisionEnabled, false);
  });

  it("refuses a file that is not a snapshot, and keeps the header it needs", () => {
    for (const bad of ["not json", "[]", "null", JSON.stringify({ components: [] }), JSON.stringify({ revision: -1, updatedAtMs: 1, components: [] }), JSON.stringify({ revision: 1.5, updatedAtMs: 1, components: [] }), JSON.stringify({ revision: 1, updatedAtMs: "now", components: [] }), JSON.stringify({ revision: 1, updatedAtMs: 1, components: {} })]) {
      assert.equal(parseDesktopHealthSnapshot(bad), null, bad);
    }
    const parsed = parseDesktopHealthSnapshot(rawSnapshot([]));
    assert.deepEqual([parsed!.revision, parsed!.updatedAtMs, parsed!.total, parsed!.down], [3, 1_000, 0, 0]);
  });
});

describe("the summary a dashboard reads", () => {
  it("says healthy, degraded or crashloop — and warns unless it is healthy", () => {
    assert.equal(desktopHealthOverall(snapshot()), "healthy");
    assert.equal(desktopHealthOverall(snapshot({ down: 1 })), "degraded");
    assert.equal(desktopHealthOverall(snapshot({ down: 3, crashlooping: 1 })), "crashloop");
    assert.deepEqual([desktopHealthLevel("healthy"), desktopHealthLevel("degraded"), desktopHealthLevel("crashloop")], ["info", "warn", "warn"]);
  });

  it("names the components that are not up, marks the crashlooping ones, and lists their reasons", () => {
    const metadata = computeDesktopHealthMetadata(
      snapshot({
        total: 3,
        up: 1,
        down: 2,
        crashlooping: 1,
        restartsInWindow: 5,
        components: [
          component({ name: "primary/xvfb", up: true }),
          component({ name: "fork/websockify", up: false, downReason: "port-in-use" }),
          component({ name: "fork/egress-proxy", up: false, crashloop: true, downReason: "exit" }),
        ],
      }),
    );
    assert.deepEqual(metadata, {
      supervision_enabled: "true",
      overall: "crashloop",
      total: "3",
      up: "1",
      down: "2",
      crashlooping: "1",
      restarts_window: "5",
      down_detail: "fork/websockify,fork/egress-proxy(crashloop)",
      down_reason: "fork/websockify=port-in-use,fork/egress-proxy=exit",
    });
    // A healthy snapshot has no detail to give.
    const healthy = computeDesktopHealthMetadata(snapshot());
    assert.deepEqual([healthy.down_detail, healthy.down_reason, healthy.overall], [undefined, undefined, "healthy"]);
  });

  it("keeps the detail bounded, however many components are down", () => {
    const many = Array.from({ length: 40 }, (_, index) => component({ name: `fork/websockify${index}` as string, up: false, downReason: "oom" }));
    const metadata = computeDesktopHealthMetadata(snapshot({ down: many.length, components: many }));
    assert.equal(metadata.down_detail!.length, MAX_DOWN_DETAIL_LENGTH);
    assert.equal(metadata.down_reason!.length, MAX_DOWN_DETAIL_LENGTH);
  });
});

describe("when a snapshot is forwarded", () => {
  it("forwards a new revision at once, and the same one only on the heartbeat", () => {
    const decide = (args: Partial<Parameters<typeof decideDesktopHealthForward>[0]>) =>
      decideDesktopHealthForward({ lastForwardedRevision: 3, lastForwardedAtMs: 1_000, revision: 3, nowMs: 1_500, heartbeatMs: 1_000, ...args });
    assert.equal(decide({ lastForwardedRevision: null }), true, "the first snapshot always goes out");
    assert.equal(decide({ lastForwardedAtMs: null }), true);
    assert.equal(decide({ revision: 4 }), true);
    assert.equal(decide({ nowMs: 1_999 }), false);
    assert.equal(decide({ nowMs: 2_000 }), true);
  });

  it("answers absent, parse_error, skipped or emitted, and only remembers what it emitted", async () => {
    const run = async (raw: string | null, last: { revision: number | null; atMs: number | null }, nowMs = 1_000) => {
      const emitted: Array<{ level: string; metadata: unknown }> = [];
      const remembered: Array<[number, number]> = [];
      const outcome = await forwardDesktopHealth({
        readRaw: async () => raw,
        getLast: () => last,
        now: () => nowMs,
        heartbeatMs: 500,
        emit: (level, metadata) => emitted.push({ level, metadata }),
        setLast: (revision, atMs) => remembered.push([revision, atMs]),
      });
      return { outcome, emitted, remembered };
    };
    assert.deepEqual((await run(null, { revision: null, atMs: null })).outcome, "absent");
    assert.deepEqual((await run("not json", { revision: null, atMs: null })).outcome, "parse_error");
    const first = await run(rawSnapshot([{ name: "d1/xvfb", up: false, downReason: "oom" }]), { revision: null, atMs: null });
    assert.deepEqual([first.outcome, first.emitted[0]!.level, first.remembered], ["emitted", "warn", [[3, 1_000]]]);
    const skipped = await run(rawSnapshot([]), { revision: 3, atMs: 900 }, 1_100);
    assert.deepEqual([skipped.outcome, skipped.emitted.length, skipped.remembered.length], ["skipped", 0, 0]);
    // The heartbeat forwards the same revision, and remembers the moment it did.
    const heartbeat = await run(rawSnapshot([]), { revision: 3, atMs: 900 }, 1_500);
    assert.deepEqual([heartbeat.outcome, heartbeat.emitted[0]!.level, heartbeat.remembered], ["emitted", "info", [[3, 1_500]]]);
  });
});
