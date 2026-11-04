import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  HOST_BUNDLE_WATCH_INTERVAL_MS,
  HOST_BUNDLE_WATCH_JITTER_RATIO,
  MAX_FAILED_SWAP_RESTAGE_RETRIES,
  POST_SWAP_CRASH_LOOP_ERROR_CLASS,
  SLATE_SUPERVISOR_ACKS_DIR,
  SLATE_SUPERVISOR_COMMAND_PART_PATH,
  SLATE_SUPERVISOR_COMMAND_PATH,
  SLATE_SUPERVISOR_DIR,
  SLATE_SUPERVISOR_STAGED_BUNDLE_PART_PATH,
  SLATE_SUPERVISOR_STAGED_BUNDLE_PATH,
  buildSlateSupervisorCommand,
  describeHostBundleErrorDetail,
  fetchStageAndReportHostBundle,
  hostBundleWatchInitialDelayMs,
  hostBundleWatchNextDelayMs,
  isHostVersionSwapVetoed,
  isSlateHostUpgradeAvailable,
  noteFailedSwapMarkerForRetry,
  readLocalHostVersion,
  serializeSlateSupervisorCommand,
  stageHostBundleUpgrade,
} from "../../source/host/extensions/host-upgrade/host-bundle-upgrade.ts";
import type { HostBundleUpdateState, SlateSupervisorUpgradeCommand } from "../../source/host/extensions/host-upgrade/host-bundle-upgrade.ts";
import type { HostBundleSource } from "../../source/host/extensions/host-upgrade/host-bundle-source.ts";
import type { HostUpgradeMarker } from "../../source/host/extensions/host-upgrade/host-upgrade-marker.ts";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "slate-host-upgrade-"));
}

function updateState(stagedVersion: string | null = null): HostBundleUpdateState {
  return { stagedVersion, lastFailedVersion: undefined, swapRetryAttempts: new Map() };
}

function bundle(version = "2.0.0", load: () => Promise<Uint8Array> = async () => new Uint8Array([1, 2, 3])): HostBundleSource {
  return { version, loadBundleBytes: load };
}

describe("the supervisor bundle command", () => {
  it("publishes the Slate-owned paths and the retry/watch bounds", () => {
    assert.equal(SLATE_SUPERVISOR_DIR, "/tmp/slate-supervisor");
    assert.equal(SLATE_SUPERVISOR_COMMAND_PATH, `${SLATE_SUPERVISOR_DIR}/command.json`);
    assert.equal(SLATE_SUPERVISOR_COMMAND_PART_PATH, `${SLATE_SUPERVISOR_COMMAND_PATH}.part`);
    assert.equal(SLATE_SUPERVISOR_ACKS_DIR, `${SLATE_SUPERVISOR_DIR}/acks`);
    assert.equal(SLATE_SUPERVISOR_STAGED_BUNDLE_PATH, `${SLATE_SUPERVISOR_DIR}/incoming-host-bundle.tgz`);
    assert.equal(SLATE_SUPERVISOR_STAGED_BUNDLE_PART_PATH, `${SLATE_SUPERVISOR_STAGED_BUNDLE_PATH}.part`);
    assert.equal(MAX_FAILED_SWAP_RESTAGE_RETRIES, 2);
    assert.equal(POST_SWAP_CRASH_LOOP_ERROR_CLASS, "post-swap-crash-loop");
    assert.equal(HOST_BUNDLE_WATCH_INTERVAL_MS, 24 * 60 * 60_000);
    assert.equal(HOST_BUNDLE_WATCH_JITTER_RATIO, 0.5);
  });

  it("builds and serializes only optional command fields that were supplied", () => {
    const command = buildSlateSupervisorCommand({ id: "upgrade-2", kind: "upgrade", nowMs: 42 });
    assert.deepEqual(command, { id: "upgrade-2", kind: "upgrade", issuedAtMs: 42 });
    assert.equal(serializeSlateSupervisorCommand(command), JSON.stringify(command));

    assert.deepEqual(buildSlateSupervisorCommand({
      id: "upgrade-3", kind: "upgrade", nowMs: 43, mode: "bundle", version: "3", bundlePath: "/bundle",
      reason: "idle", forceNow: false,
    }), {
      id: "upgrade-3", kind: "upgrade", issuedAtMs: 43, mode: "bundle", version: "3", bundlePath: "/bundle", reason: "idle",
    });
    assert.equal(buildSlateSupervisorCommand({ id: "upgrade-4", kind: "upgrade", nowMs: 44, forceNow: true }).forceNow, true);
  });

  it("writes bundle and command part files before renaming them into place", async () => {
    const dir = tempDir();
    try {
      const bundlePath = join(dir, "bundle.tgz");
      const bundlePart = `${bundlePath}.part`;
      const commandPath = join(dir, "command.json");
      const commandPart = `${commandPath}.part`;
      const command = await stageHostBundleUpgrade({
        version: "2.0.0", bytes: new Uint8Array([4, 5, 6]), reason: "idle-auto-update", forceNow: false,
        nowMs: 77, dir, stagedBundlePath: bundlePath, stagedBundlePartPath: bundlePart,
        commandPath, commandPartPath: commandPart,
      });

      assert.deepEqual(command, {
        id: "upgrade-2.0.0", kind: "upgrade", issuedAtMs: 77, mode: "bundle", version: "2.0.0",
        bundlePath, reason: "idle-auto-update",
      });
      assert.deepEqual(readFileSync(bundlePath), Buffer.from([4, 5, 6]));
      assert.deepEqual(JSON.parse(readFileSync(commandPath, "utf8")), command);
      assert.equal(exists(dir, "bundle.tgz.part"), false);
      assert.equal(exists(dir, "command.json.part"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks versions without treating missing or empty targets as updates", () => {
    assert.equal(isSlateHostUpgradeAvailable(null, "2"), true);
    assert.equal(isSlateHostUpgradeAvailable("1", "2"), true);
    assert.equal(isSlateHostUpgradeAvailable("2", "2"), false);
    assert.equal(isSlateHostUpgradeAvailable("1", null), false);
    assert.equal(isSlateHostUpgradeAvailable("1", undefined), false);
    assert.equal(isSlateHostUpgradeAvailable("1", ""), false);
  });

  it("reads a trimmed local version and treats empty or unreadable files as absent", async () => {
    const dir = tempDir();
    try {
      const versionPath = join(dir, "version");
      writeFileSync(versionPath, "  1.2.3\n");
      assert.equal(await readLocalHostVersion(versionPath), "1.2.3");
      writeFileSync(versionPath, "  \n");
      assert.equal(await readLocalHostVersion(versionPath), null);
      assert.equal(await readLocalHostVersion(join(dir, "missing")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a matching supervisor acknowledgement as a veto and sanitizes its file name", async () => {
    const dir = tempDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "upgrade-2.0_a"), "done");
      assert.equal(await isHostVersionSwapVetoed({ version: "2.0/a", localVersion: "1.0", acksDir: dir }), true);
      assert.equal(await isHostVersionSwapVetoed({ version: "2.0/a", localVersion: "2.0/a", acksDir: dir }), false);
      assert.equal(await isHostVersionSwapVetoed({ version: "", localVersion: null, acksDir: dir }), false);
      assert.equal(await isHostVersionSwapVetoed({ version: "missing", localVersion: "1.0", acksDir: dir }), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a staged version only after fetching and staging both succeed", async () => {
    const state = updateState("1.0.0");
    state.lastFailedVersion = "2.0.0";
    const reports: Array<Record<string, string | undefined>> = [];
    const logs: Array<[string, string]> = [];
    const staged: Uint8Array[] = [];
    const result = await fetchStageAndReportHostBundle({
      source: bundle(), fromVersion: "1.0.0", trigger: "manual-update-host", state,
      stage: async (bytes) => { staged.push(bytes); },
      reportUpgrade: (metadata) => reports.push(metadata),
      log: (level, message) => logs.push([level, message]),
    });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(staged, [new Uint8Array([1, 2, 3])]);
    assert.equal(state.stagedVersion, "2.0.0");
    assert.equal(state.lastFailedVersion, undefined);
    assert.deepEqual(reports, []);
    assert.equal(logs[0]?.[0], "info");
  });

  it("distinguishes fetch and stage failures and reports each failed version once", async () => {
    const state = updateState("1.0.0");
    const reports: Array<Record<string, string | undefined>> = [];
    const logs: Array<[string, string]> = [];
    const failingSource = bundle("2.0.0", async () => { throw new Error("download unavailable"); });
    const failedFetch = () => fetchStageAndReportHostBundle({
      source: failingSource, fromVersion: "1.0.0", trigger: "idle-auto-update", state,
      stage: async () => {}, reportUpgrade: (metadata) => reports.push(metadata),
      log: (level, message) => logs.push([level, message]),
    });
    assert.deepEqual(await failedFetch(), { ok: false, error: new Error("download unavailable"), phase: "fetch" });
    assert.equal(state.stagedVersion, "1.0.0");
    assert.equal(state.lastFailedVersion, "2.0.0");
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0], {
      outcome: "failed", phase: "fetch", mode: "bundle", trigger: "idle-auto-update",
      from_version: "1.0.0", to_version: "2.0.0", error_class: "Error",
    });
    await failedFetch();
    assert.equal(reports.length, 1, "a repeated failure of one version is not reported twice");
    assert.equal(logs.some(([level]) => level === "warn"), true);

    const stateForStage = updateState();
    const failedStage = await fetchStageAndReportHostBundle({
      source: bundle(), fromVersion: null, trigger: "manual-update-host", state: stateForStage,
      stage: async () => { throw new TypeError("disk full"); }, reportUpgrade: () => {},
    });
    assert.deepEqual(failedStage, { ok: false, error: new TypeError("disk full"), phase: "stage" });
    assert.equal(stateForStage.stagedVersion, null);
  });

  it("retries only matching staged bundle failures and stops at its retry limit", () => {
    const state = updateState("2.0.0");
    const failedMarker = { outcome: "failed", mode: "bundle", toVersion: "2.0.0", swapError: "EPERM" } as HostUpgradeMarker;
    assert.equal(noteFailedSwapMarkerForRetry(state, failedMarker), true);
    assert.equal(state.stagedVersion, null);
    assert.equal(state.swapRetryAttempts.get("2.0.0"), 1);

    state.stagedVersion = "2.0.0";
    assert.equal(noteFailedSwapMarkerForRetry(state, failedMarker), true);
    state.stagedVersion = "2.0.0";
    assert.equal(noteFailedSwapMarkerForRetry(state, failedMarker), false);
    assert.equal(state.swapRetryAttempts.get("2.0.0"), MAX_FAILED_SWAP_RESTAGE_RETRIES);
    assert.equal(state.stagedVersion, "2.0.0");

    assert.equal(noteFailedSwapMarkerForRetry(updateState("2.0.0"), { ...failedMarker, swapError: POST_SWAP_CRASH_LOOP_ERROR_CLASS }), false);
    assert.equal(noteFailedSwapMarkerForRetry(updateState("2.0.0"), { ...failedMarker, mode: "swap" }), false);
    assert.equal(noteFailedSwapMarkerForRetry(updateState("2.0.0"), { ...failedMarker, toVersion: "3.0.0" }), false);
  });

  it("describes nested and aggregate errors with their phase", () => {
    const error = new AggregateError([new Error("chunk missing"), "extra detail"], "bundle failed", {
      cause: new Error("read failed", { cause: "offline" }),
    });
    const detail = describeHostBundleErrorDetail(error, "fetch");
    assert.match(detail, /^@phase:fetch AggregateError: bundle failed \[Error: chunk missing; extra detail\] → Error: read failed → offline$/);
    assert.equal(describeHostBundleErrorDetail("plain failure"), "plain failure");
  });

  it("clamps initial and repeated watch delays to their intended jitter ranges", () => {
    assert.equal(hostBundleWatchInitialDelayMs(100, 0.5, () => 0.25), 25);
    assert.equal(hostBundleWatchInitialDelayMs(100, 0.5, () => -4), 0);
    assert.equal(hostBundleWatchInitialDelayMs(100, 0.5, () => 2), 100);
    assert.equal(hostBundleWatchInitialDelayMs(100, 0, () => 0.5), 0);
    assert.equal(hostBundleWatchInitialDelayMs(-1, 0.5, () => 0.5), 0);

    assert.equal(hostBundleWatchNextDelayMs(100, 0.5, () => 0), 50);
    assert.equal(hostBundleWatchNextDelayMs(100, 0.5, () => 1), 150);
    assert.equal(hostBundleWatchNextDelayMs(100, 3, () => 0.5), 100);
    assert.equal(hostBundleWatchNextDelayMs(100, 3, () => 1), 200);
    assert.equal(hostBundleWatchNextDelayMs(100, -1, () => 0.5), 100);
    assert.equal(hostBundleWatchNextDelayMs(-1, 0.5, () => 0.5), 0);
  });
});

function exists(dir: string, name: string): boolean {
  try { readFileSync(join(dir, name)); return true; } catch { return false; }
}
