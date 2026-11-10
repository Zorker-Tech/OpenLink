import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  DISK_PRESSURE_HEARTBEAT_MS,
  DISK_PRESSURE_THRESHOLDS,
  GIB,
  diskPressureGuard,
  levelOfVolume,
  sampleVolumes,
  worstLevel,
  type PressureLevel,
  type VolumeSample,
} from "../../source/host/boxes/forever-box/disk-pressure-guard.ts";

const roots: string[] = [];
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "slate-disk-"));
  roots.push(root);
  return root;
};
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const gig = 1024 ** 3;
const volume = (availableGig: number) => ({ totalBytes: 100 * gig, availableBytes: availableGig * gig });

describe("the level a volume is at", () => {
  it("is healthy while there is room, soft when there is less, and hard when there is very little", () => {
    assert.equal(levelOfVolume(volume(50)), "healthy");
    assert.equal(levelOfVolume(volume(10)), "soft");
    assert.equal(levelOfVolume(volume(1)), "hard");
    assert.equal(GIB, gig);
    assert.equal(DISK_PRESSURE_THRESHOLDS.softAvailableBytes, 8 * gig);
  });

  it("stays where it was until the recovery threshold is passed", () => {
    // Both the bytes and the share have to clear the recovery threshold, and the share is the one that binds here.
    assert.equal(levelOfVolume(volume(3), "hard"), "hard");
    assert.equal(levelOfVolume(volume(4), "hard"), "hard", "4% of the volume is still inside the hard recovery share");
    assert.equal(levelOfVolume(volume(9), "hard"), "soft", "9% clears the hard recovery and lands on soft, which the share still calls low");
    assert.equal(levelOfVolume(volume(21), "hard"), "healthy", "21% clears every threshold at once");
    assert.equal(levelOfVolume(volume(11), "soft"), "soft");
    assert.equal(levelOfVolume(volume(21), "soft"), "healthy");
  });

  it("is healthy for a volume this build cannot measure", () => {
    assert.equal(levelOfVolume({ totalBytes: 0, availableBytes: 0 }), "healthy");
  });

  it("judges by the share left as well as by the bytes", () => {
    // 100 GB of room sounds like plenty and is a twentieth of a 2 TB disk, which is hard by the share alone.
    assert.equal(levelOfVolume({ totalBytes: 2000 * gig, availableBytes: 100 * gig }), "hard");
    assert.equal(levelOfVolume({ totalBytes: 2000 * gig, availableBytes: 500 * gig }), "healthy", "a quarter of the volume left is room");
    assert.equal(levelOfVolume({ totalBytes: 100 * gig, availableBytes: 5 * gig }), "hard");
  });
});

describe("the worst level of a set of volumes", () => {
  const state = (level: PressureLevel) => ({ level, lastReportedAtMs: 0 });

  it("is the worst one there is", () => {
    assert.equal(worstLevel(new Map<string, { level: PressureLevel; lastReportedAtMs: number }>()), "healthy");
    assert.equal(worstLevel(new Map([["a", state("healthy")]])), "healthy");
    assert.equal(worstLevel(new Map([["a", state("soft")]])), "soft");
    assert.equal(worstLevel(new Map([["a", state("soft")], ["b", state("hard")]])), "hard");
    assert.equal(worstLevel(new Map([["a", state("soft")], ["b", state("healthy")]])), "soft");
  });
});

describe("reading the volumes a box has", () => {
  it("reads each device once, and says whether every one could be read", async () => {
    const sample = await sampleVolumes([{ volume: "/", path: "/" }]);
    assert.equal(sample.snapshots.length <= 1, true);
    assert.equal(sample.complete, true);
    assert.equal(typeof sample.snapshots[0]?.deviceId, "string");
  });

  it("says a root it could not read was not read, rather than guessing", async () => {
    const sample = await sampleVolumes([{ volume: "gone", path: join(scratch(), "nope") }]);
    assert.deepEqual(sample, { snapshots: [], complete: false });
  });
});

describe("the guard, one tick at a time", () => {
  /** A guard over a scripted set of samples, with what it reported and how. */
  async function ticks(samples: readonly VolumeSample[], ticks = 2) {
    const log: unknown[] = [];
    let index = 0;
    let now = 0;
    const guard = diskPressureGuard({
      readVolumes: async () => samples[Math.min(index++, samples.length - 1)]!,
      report: (report) => log.push({ level: report.level, trigger: report.trigger, usedPercent: Math.round(report.usedPercent) }),
      onPressureChange: (level) => log.push(`change ${String(level)}`),
      onSuccessfulSample: (level, complete) => log.push(`sample ${level} ${String(complete)}`),
      log: (message) => log.push(`log ${message}`),
      clock: { monotonicNow: () => (now += 1) },
    });
    for (let tick = 0; tick < ticks; tick += 1) {
      guard.onTick();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    guard.dispose();
    guard.onTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return log;
  }
  const healthy: VolumeSample = { snapshots: [{ volume: "v", deviceId: "d", ...volume(50) }], complete: true };
  const full: VolumeSample = { snapshots: [{ volume: "v", deviceId: "d", ...volume(1) }], complete: true };

  it("reports a volume that changed level, and says the pressure changed", async () => {
    const log = await ticks([full, healthy]);
    assert.deepEqual(log, [{ level: "hard", trigger: "transition", usedPercent: 99 }, "sample hard true", "change hard", { level: "healthy", trigger: "transition", usedPercent: 50 }, "sample healthy true", "change null"]);
  });

  it("does not report a volume that stayed where it was", async () => {
    const log = await ticks([full, full]);
    assert.deepEqual(log.filter((entry) => typeof entry === "object").length, 1, "one report, then the heartbeat is not due yet");
  });

  it("reports a volume still under pressure once the heartbeat is due", async () => {
    let now = 0;
    const log: unknown[] = [];
    const guard = diskPressureGuard({
      readVolumes: async () => full,
      report: (report) => log.push(report.trigger),
      onPressureChange: () => {},
      log: () => {},
      clock: { monotonicNow: () => (now += DISK_PRESSURE_HEARTBEAT_MS) },
    });
    guard.onTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    guard.onTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(log, ["transition", "heartbeat"]);
  });

  it("logs a reading it could not take, and says nothing else about it", async () => {
    const log = await ticks([{ snapshots: [], complete: false }]);
    assert.deepEqual(log, []);
    const failures: string[] = [];
    const failing = diskPressureGuard({
      readVolumes: async () => {
        throw new Error("no disk");
      },
      report: () => {},
      onPressureChange: () => {},
      log: (message) => failures.push(message),
    });
    failing.onTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(String(failures[0]), /disk-pressure sample failed: Error: no disk/);
  });

  it("keeps a volume under hard pressure until both the bytes and the share clear", () => {
    // 7 GiB and 7%: past the hard entry threshold, inside the hard recovery one.
    assert.equal(levelOfVolume(volume(7), "healthy"), "soft");
    assert.equal(levelOfVolume(volume(7), "hard"), "hard");
  });

  it("reads a device once however many roots point at it", async () => {
    const sample = await sampleVolumes([{ volume: "root", path: "/" }, { volume: "also root", path: "/" }]);
    assert.equal(sample.snapshots.length, 1, "two roots on one device are one volume");
    assert.equal(sample.snapshots[0]?.volume, "root");
  });

  it("keeps ticking when a report cannot be delivered", async () => {
    const log: string[] = [];
    let tick = 0;
    const guard = diskPressureGuard({
      readVolumes: async () => ({ snapshots: [{ volume: "v", deviceId: `d${tick++}`, ...volume(1) }], complete: true }),
      report: () => {
        throw new Error("host is gone");
      },
      onPressureChange: () => {},
      onSuccessfulSample: (level) => log.push(`sample ${level}`),
      log: (message) => log.push(message),
    });
    guard.onTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    guard.onTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(String(log[0]), /disk-pressure report delivery failed: Error: host is gone/);
    assert.equal(log.filter((entry) => entry.startsWith("sample")).length, 2, "the second volume is still read and reported");
  });

  it("says nothing more once it is disposed", async () => {
    const log: string[] = [];
    const guard = diskPressureGuard({
      readVolumes: async () => ({ snapshots: [{ volume: "v", deviceId: "d", ...volume(1) }], complete: true }),
      report: () => {},
      onPressureChange: () => {},
      onSuccessfulSample: (level) => log.push(`sample ${level}`),
      log: () => {},
    });
    guard.onTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    guard.dispose();
    guard.onTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(log, ["sample hard"], "one tick, and nothing after it was disposed");
  });

  it("does not start a reading while one is still running", async () => {
    const log: string[] = [];
    let reads = 0;
    const guard = diskPressureGuard({
      readVolumes: async () => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { snapshots: [{ volume: "v", deviceId: "d", ...volume(1) }], complete: true };
      },
      report: () => {},
      onPressureChange: () => {},
      onSuccessfulSample: (level) => log.push(`sample ${level}`),
      log: () => {},
    });
    guard.onTick();
    guard.onTick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(reads, 1, "the second tick was dropped while the first was still reading");
    assert.deepEqual(log, ["sample hard"]);
  });

  it("forgets a volume only when the reading was complete", async () => {
    const log = await ticks([healthy, { snapshots: [], complete: true }]);
    assert.deepEqual(log.at(-1), "sample healthy true");
    // A reading that could not be taken, and found nothing, says nothing about the sample at all: the volume stays
    // where it was and the host is not told anything it would have to unlearn.
    const partial = await ticks([healthy, { snapshots: [], complete: false }, healthy], 3);
    // The volume was where it was, so the third reading finds no change: the failed reading neither forgot it nor
    // restarted it.
    assert.deepEqual(partial, ["sample healthy true", "sample healthy true"], "the failed reading leaves the volume where it was");
    // A volume that was hard, then unreadable, then hard again is still the same volume: no transition to report.
    const kept: VolumeSample = { snapshots: [{ volume: "v", deviceId: "d", ...volume(1) }], complete: true };
    const steady = await ticks([kept, { snapshots: [], complete: false }, kept], 3);
    assert.deepEqual(steady, [{ level: "hard", trigger: "transition", usedPercent: 99 }, "sample hard true", "change hard", "sample hard true"]);
  });
});
