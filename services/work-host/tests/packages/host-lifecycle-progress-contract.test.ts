import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HostStartupProgress,
  SLATE_HOST_LIFECYCLE_PHASES,
} from "../../source/host/telemetry/host-lifecycle-progress.ts";
import type { StartupPhaseReport } from "../../source/host/telemetry/host-lifecycle-progress.ts";

function harness(startedAt = 100) {
  let now = startedAt;
  const reports: StartupPhaseReport[] = [];
  const watchdogs: Array<{ listener: () => void; disposed: boolean }> = [];
  const tracker = new HostStartupProgress({
    startedAt,
    now: () => now,
    report: (report) => reports.push(report),
    watchdog: {
      arm(listener) {
        const handle = { listener, disposed: false };
        watchdogs.push(handle);
        return { dispose: () => { handle.disposed = true; } };
      },
    },
  });
  return { tracker, reports, watchdogs, setNow(value: number) { now = value; } };
}

test("startup phases advance once and report elapsed time with their completion counts", () => {
  const current = harness();
  const firstPhase = SLATE_HOST_LIFECYCLE_PHASES[0];
  const secondPhase = SLATE_HOST_LIFECYCLE_PHASES[1];
  assert.ok(firstPhase && secondPhase);
  assert.equal(current.tracker.activePhase(), firstPhase);
  current.setNow(123.6);
  current.tracker.complete({ phase: firstPhase, pluginCount: 4 });
  assert.deepEqual(current.reports, [{
    phase: firstPhase,
    pluginCount: 4,
    outcome: "completed",
    durationMs: 24,
  }]);
  assert.equal(current.watchdogs[0]?.disposed, true);
  assert.equal(current.tracker.activePhase(), secondPhase);
  assert.throws(() => current.tracker.complete({ phase: firstPhase }), /cannot finish/);
});

test("failure and watchdog outcomes are reported for the active phase", () => {
  const failed = harness();
  failed.setNow(145);
  failed.tracker.fail();
  assert.equal(failed.reports[0]?.outcome, "failed");
  assert.equal(failed.reports[0]?.durationMs, 45);
  assert.equal(failed.watchdogs[0]?.disposed, true);

  const stalled = harness();
  stalled.setNow(170);
  stalled.watchdogs[0]?.listener();
  assert.equal(stalled.reports[0]?.outcome, "stuck");
  assert.equal(stalled.reports[0]?.durationMs, 70);
});

test("elapsed time cannot be negative and a completed lifecycle has no next watchdog", () => {
  const current = harness();
  assert.ok(current.tracker.activePhase());
  current.setNow(50);
  assert.equal(current.tracker.elapsedMilliseconds(), 0);
  for (const phase of SLATE_HOST_LIFECYCLE_PHASES) {
    if (current.tracker.activePhase() === undefined) break;
    current.tracker.complete({ phase });
  }
  assert.equal(current.tracker.activePhase(), undefined);
  assert.equal(current.watchdogs.length, SLATE_HOST_LIFECYCLE_PHASES.length);
});
