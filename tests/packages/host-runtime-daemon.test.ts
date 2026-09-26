/**
 * The host's daemon edges: the automation telemetry, the request coalescer, how the host and the
 * local-exec daemon find each other, and the reference documents a box reads.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { AUTOMATION_FIRE_DROPPED_EVENT, AUTOMATION_LATE_FIRE_THRESHOLD_MS, AUTOMATION_RUN_EVENT, automationFireDroppedTelemetry, automationRunTelemetry } from "../../source/host/telemetry/automation-fire-telemetry.ts";
import { createRequestCoalescer } from "../../source/host/boxes/box-store-sync/request-coalescer.ts";
import { getLocalExecDaemonConnectionPath, getLocalExecDaemonCredentialPath, NO_SUPERVISOR_HEARTBEAT, parseLocalExecConnection } from "../../source/host/local-exec/local-exec-daemon-protocol.ts";
import { LEGACY_SLATE_BOX_REFERENCE_DIR, SLATE_BOX_REFERENCE_DIR } from "../../source/host/runner/box-reference-docs.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-host-runtime-7-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("an automation firing", () => {
  it("reports a run and a dropped fire under our own event names", () => {
    assert.equal(AUTOMATION_RUN_EVENT, "slate.automation.run");
    assert.equal(AUTOMATION_FIRE_DROPPED_EVENT, "slate.automation.fire_dropped");
    assert.equal(AUTOMATION_LATE_FIRE_THRESHOLD_MS, 300_000);
    const run = automationRunTelemetry({ conversationId: "c1", automationId: "a1", trigger: "schedule", outcome: "fired", lateByMs: 10 } as never);
    assert.equal(run.event, "slate.automation.run");
    const dropped = automationFireDroppedTelemetry({ conversationId: "c1", automationId: "a1", trigger: "event", reason: "disabled" } as never);
    assert.equal(dropped.event, "slate.automation.fire_dropped");
    assert.equal(typeof dropped.level, "string");
  });
});

describe("batching the requests a store sync makes", () => {
  it("is a coalescer the store can build", () => {
    assert.equal(typeof createRequestCoalescer, "function");
  });
});

describe("how the host and the local-exec daemon find each other", () => {
  it("keeps the daemon's files under the host's own root, and reads a connection defensively", () => {
    assert.match(getLocalExecDaemonConnectionPath(), /\.slate\/.*local-exec-daemon-connection\.json$/);
    assert.match(getLocalExecDaemonCredentialPath(), /\.slate\/.*local-exec-daemon-credential\.json$/);
    assert.deepEqual(NO_SUPERVISOR_HEARTBEAT, { pid: 0, at: 0 });
    // Nothing that is not a connection is read as one.
    for (const value of [null, "not json", "", {}, '{"port":"1"}']) assert.equal(parseLocalExecConnection(value), null);
  });
});

describe("the reference documents a box reads", () => {
  it("writes into the box's own directory, with the previous one named as legacy", () => {
    assert.equal(SLATE_BOX_REFERENCE_DIR, "/home/box/reference");
    assert.equal(LEGACY_SLATE_BOX_REFERENCE_DIR, "/home/box/slate-reference");
  });
});
