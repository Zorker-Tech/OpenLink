import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeHostUpgradeMetadata,
  forwardHostUpgradeMarkerWith,
  parseHostUpgradeMarker,
  type HostUpgradeMarker,
} from "../../source/host/extensions/host-upgrade/host-upgrade-marker.ts";

describe("reading an upgrade marker", () => {
  it("keeps the fields that say something and drops the rest", () => {
    const marker = parseHostUpgradeMarker(JSON.stringify({ outcome: "applied", fromVersion: "1.0.0", toVersion: "", mode: "swap", reason: 7, issuedAtMs: 10, appliedAtMs: 1e999, swapMs: -2, swapError: "EPERM", extra: true }));
    assert.deepEqual(marker, { outcome: "applied", fromVersion: "1.0.0", mode: "swap", issuedAtMs: 10, swapMs: -2, swapError: "EPERM" });
    assert.deepEqual(Object.keys(marker ?? {}), ["outcome", "fromVersion", "mode", "issuedAtMs", "swapMs", "swapError"]);
  });

  it("keeps only text and finite numbers, and only the outcomes it knows", () => {
    assert.deepEqual(parseHostUpgradeMarker('{"issuedAtMs":1e999,"appliedAtMs":1e999}'), {}, "an infinite count is not a moment");
    assert.deepEqual(parseHostUpgradeMarker('{"outcome":"failed"}'), { outcome: "failed" });
    assert.deepEqual(parseHostUpgradeMarker('{"outcome":"applied","swapMs":-2.5}'), { outcome: "applied", swapMs: -2.5 });
  });

  it("is no marker at all when the text is not an object of the right shape", () => {
    for (const raw of ["not json", "", "null", "[]", "true", "42", '"text"', "{}"]) {
      const marker = parseHostUpgradeMarker(raw);
      if (raw === "{}") assert.deepEqual(marker, {});
      else assert.equal(marker, null, raw);
    }
    assert.deepEqual(parseHostUpgradeMarker(JSON.stringify({ outcome: "maybe" })), {});
  });
});

describe("the report an upgrade marker computes", () => {
  it("names the timing of an applied upgrade, clamping every duration to zero", () => {
    const applied = { outcome: "applied", fromVersion: "1.0.0", toVersion: "1.1.0", mode: "swap", reason: "schedule", issuedAtMs: 10, appliedAtMs: 25, swapMs: 7 } as HostUpgradeMarker;
    assert.deepEqual(computeHostUpgradeMetadata(applied, 40), {
      from_version: "1.0.0",
      to_version: "1.1.0",
      mode: "swap",
      trigger: "schedule",
      outcome: "applied",
      deliver_to_apply_ms: "15",
      swap_ms: "7",
      total_ms: "30",
    });
    const late = computeHostUpgradeMetadata({ outcome: "applied", issuedAtMs: 30, appliedAtMs: 20 } as HostUpgradeMarker, 10);
    assert.equal(late.deliver_to_apply_ms, "0", "an apply before the hand-off is no negative duration");
    assert.equal(late.total_ms, "0", "a report before the hand-off is no negative duration");
  });

  it("counts from the epoch to a report that happened before it", () => {
    const report = computeHostUpgradeMetadata({ outcome: "applied", issuedAtMs: 10 } as HostUpgradeMarker, 0);
    assert.equal(report.total_ms, "0", "a report at the epoch is no negative duration");
    assert.equal(report.swap_ms, undefined);
  });

  it("leaves timing out when the marker has no moments to time from", () => {
    const report = computeHostUpgradeMetadata({ outcome: "applied", swapMs: 3 } as HostUpgradeMarker, 40);
    assert.equal(Object.hasOwn(report, "deliver_to_apply_ms"), true, "the key is always there");
    assert.equal(report.deliver_to_apply_ms, undefined);
    assert.equal(report.total_ms, undefined);
    assert.equal(report.swap_ms, "3");
    assert.equal(computeHostUpgradeMetadata({ outcome: "applied", issuedAtMs: 0, appliedAtMs: 20 } as HostUpgradeMarker, 40).total_ms, undefined, "the epoch is not a moment to time from");
  });

  it("reports a failed upgrade with its swap error, or the generic class", () => {
    assert.deepEqual(computeHostUpgradeMetadata({ outcome: "failed", fromVersion: "1.0.0", reason: "manual", swapError: "EPERM" } as HostUpgradeMarker, 0), {
      from_version: "1.0.0",
      to_version: undefined,
      mode: undefined,
      trigger: "manual",
      outcome: "failed",
      phase: "swap",
      error_class: "EPERM",
    });
    assert.equal(computeHostUpgradeMetadata({ outcome: "failed" } as HostUpgradeMarker, 0).error_class, "swap-failed");
  });
});

describe("forwarding a marker once", () => {
  function harness(options: { raws: Array<string | null>; forwarded?: boolean; emitOk?: boolean; onForwardedThrows?: boolean }) {
    const events: string[] = [];
    const raws = [...options.raws];
    let reads = 0;
    const deps = {
      async readRaw() { events.push("readRaw"); const value = raws[Math.min(reads, raws.length - 1)] ?? null; reads += 1; return value; },
      async deleteMarker() { events.push("deleteMarker"); },
      async emit() { events.push("emit"); return options.emitOk ?? true; },
      warn(message: string) { events.push("warn:" + message); },
      now() { events.push("now"); return 100; },
      wasForwarded() { events.push("wasForwarded"); return options.forwarded ?? false; },
      markForwarded() { events.push("markForwarded"); },
      onForwarded() { events.push("onForwarded"); if (options.onForwardedThrows === true) throw new Error("listener failed"); },
    };
    return { deps: deps as never, events };
  }

  it("answers absent or skipped without touching the marker", async () => {
    const absent = harness({ raws: [null] });
    assert.equal(await forwardHostUpgradeMarkerWith(absent.deps), "absent");
    assert.deepEqual(absent.events, ["readRaw"]);

    const raw = JSON.stringify({ outcome: "applied" });
    const skipped = harness({ raws: [raw], forwarded: true });
    assert.equal(await forwardHostUpgradeMarkerWith(skipped.deps), "skipped");
    assert.deepEqual(skipped.events, ["readRaw", "wasForwarded"]);
  });

  it("discards an unparseable marker with a warning, and only deletes it when unchanged", async () => {
    const discarded = harness({ raws: ["not json"] });
    assert.equal(await forwardHostUpgradeMarkerWith(discarded.deps), "parse_error");
    assert.deepEqual(discarded.events, ["readRaw", "wasForwarded", "warn:discarding unparseable host-upgrade marker (len=8)", "markForwarded", "readRaw", "deleteMarker"]);

    const changed = harness({ raws: ["not json", "something else"] });
    assert.equal(await forwardHostUpgradeMarkerWith(changed.deps), "parse_error");
    assert.equal(changed.events.includes("deleteMarker"), false);
  });

  it("leaves the marker for another try when it cannot be emitted", async () => {
    const raw = JSON.stringify({ outcome: "applied" });
    const deferred = harness({ raws: [raw], emitOk: false });
    assert.equal(await forwardHostUpgradeMarkerWith(deferred.deps), "deferred");
    assert.deepEqual(deferred.events, ["readRaw", "wasForwarded", "now", "emit"]);
  });

  it("swallows a throwing listener and still finishes the forward", async () => {
    const raw = JSON.stringify({ outcome: "applied" });
    const thrown = harness({ raws: [raw], onForwardedThrows: true });
    assert.equal(await forwardHostUpgradeMarkerWith(thrown.deps), "emitted");
    assert.equal(thrown.events.includes("deleteMarker"), true);
  });

  it("marks, announces and deletes a marker it emitted", async () => {
    const raw = JSON.stringify({ outcome: "applied" });
    const emitted = harness({ raws: [raw] });
    assert.equal(await forwardHostUpgradeMarkerWith(emitted.deps), "emitted");
    assert.deepEqual(emitted.events, ["readRaw", "wasForwarded", "now", "emit", "markForwarded", "onForwarded", "readRaw", "deleteMarker"]);
  });
});