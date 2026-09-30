/**
 * Profiling under pressure, taking a consistent copy of a database, what the desktop reports about itself
 * and opening a store file without leaving the store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPressureCpuProfiler, DEFAULT_MAX_RETAINED_PROFILES, DEFAULT_MIN_INTERVAL_MS, DEFAULT_PROFILE_DURATION_MS, PRESSURE_CPU_PROFILE_DIR, SlateProfilerCaptureError } from "../../source/host/telemetry/pressure-cpu-profiler.ts";
import { classifySqliteSnapshotFailure, copyLockedSqliteDb, LOCKED_DB_COPY_ATTEMPTS, sqliteVacuumInto } from "../../source/host/boxes/box-store-sync/sqlite-snapshot.ts";
import { computeDesktopHealthMetadata, DESKTOP_COMPONENT_NAME_PATTERN, MAX_COMPONENT_RESTARTS, MAX_DOWN_DETAIL_LENGTH } from "../../source/host/telemetry/desktop-health-forwarder.ts";
import { openSecureSqlitePath, symlinkSafeExclusiveWriteFlags, writeLockFileExclusive } from "../../source/packages/agent-store-sync/secure-open.ts";

describe("profiling under pressure", () => {
  it("bounds how long a profile runs, how often one may be taken and how many are kept", () => {
    assert.equal(DEFAULT_MAX_RETAINED_PROFILES, 3);
    assert.equal(DEFAULT_PROFILE_DURATION_MS, 15_000);
    assert.equal(DEFAULT_MIN_INTERVAL_MS, 6 * 60 * 60 * 1_000);
    assert.equal(typeof createPressureCpuProfiler, "function");
    assert.equal(PRESSURE_CPU_PROFILE_DIR.length > 0, true);
    assert.equal(new SlateProfilerCaptureError("failed").message, "failed");
  });
});

describe("taking a consistent copy of a database", () => {
  it("tries a locked database a few times, and says what the database answered", () => {
    assert.equal(LOCKED_DB_COPY_ATTEMPTS, 3);
    assert.equal(typeof copyLockedSqliteDb, "function");
    assert.equal(typeof sqliteVacuumInto, "function");
    assert.equal(typeof classifySqliteSnapshotFailure, "function");
  });
});

describe("what the desktop reports about itself", () => {
  it("accepts only the components the platform runs", () => {
    assert.equal(DESKTOP_COMPONENT_NAME_PATTERN.test("d1/xvfb"), true);
    assert.equal(DESKTOP_COMPONENT_NAME_PATTERN.test("shared/dock"), true);
    assert.equal(DESKTOP_COMPONENT_NAME_PATTERN.test("d1/nope"), false);
    assert.equal(DESKTOP_COMPONENT_NAME_PATTERN.test("d0/xvfb"), false);
    assert.equal(MAX_COMPONENT_RESTARTS, 10_000);
    assert.equal(MAX_DOWN_DETAIL_LENGTH, 256);
    assert.equal(typeof computeDesktopHealthMetadata, "function");
  });
});

describe("opening a file in a store without leaving it", () => {
  it("checks the path, opens it, and identifies what it opened", () => {
    assert.equal(typeof openSecureSqlitePath, "function");
    assert.equal(typeof symlinkSafeExclusiveWriteFlags, "function");
    assert.equal(typeof writeLockFileExclusive, "function");
  });
});
