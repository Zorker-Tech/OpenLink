/**
 * The codebase-telemetry extension: what it declares, what it does when the helper cannot run, and the service it
 * builds (and lets go of) when it can.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { codebaseTelemetryAdapterOptions, codebaseTelemetryExtension, CODEBASE_UUID_STATE_FILENAME, createCodebaseTelemetryPolicies, PRIVACY_REFRESH_INTERVAL_MS, SNAPSHOTS_BASE_DIR, SNAPSHOT_UPLOAD_INTERVAL_MS } from "../../source/host/extensions/codebase-telemetry/extension.ts";
import { resolveCsnapsBinPath, resolveCsnapsCapability } from "../../source/host/extensions/codebase-telemetry/csnaps-capability.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-telemetry-extension-"));
const previousBin = process.env["SLATE_CSNAPS_BIN"];
const previousRoot = process.env["SLATE_DATA_ROOT"];
// The paths the helper is given are read from the platform's own root, so every world lives under one.
const platformRoot = join(scratch, "root");
process.env["SLATE_DATA_ROOT"] = platformRoot;
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (previousBin === undefined) delete process.env["SLATE_CSNAPS_BIN"];
  else process.env["SLATE_CSNAPS_BIN"] = previousBin;
  if (previousRoot === undefined) delete process.env["SLATE_DATA_ROOT"];
  else process.env["SLATE_DATA_ROOT"] = previousRoot;
});

/** A helper that is there and can be executed, and one that is named but is not there. */
const runnableHelper = () => {
  const path = join(scratch, "csnaps");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
};

function extensionWorld() {
  const logged: string[] = [];
  const teardowns: (() => void | Promise<void>)[] = [];
  const topics: string[] = [];
  const host = {
    log: (message: string) => void logged.push(message),
    events: { on: (topic: string, listener: (event: { requestId: string }) => void) => {
      topics.push(topic);
      void listener;
      return () => void topics.push(`${topic}:off`);
    } },
  };
  const deps = {
    auth: { peekAccessToken: () => null, subscribeToRenewal: () => () => {}, getAccessToken: async () => "token", getMachineId: async () => "machine-1" },
    experiments: { checkFeatureGate: () => true, checkGate: async () => true, subscribe: () => () => {} },
  };
  return { host, deps, logged, teardowns, topics };
}

describe("what the helper is started with", () => {
  it("keeps what it knows under the platform's own root, and talks to the platform's own backend", async () => {
    const machineIds: string[] = [];
    const options = codebaseTelemetryAdapterOptions({
      credentials: { authId: "account-1", authToken: "token-1" },
      signal: new AbortController().signal,
      executablePath: "/opt/slate/csnaps",
      auth: { peekAccessToken: () => null, subscribeToRenewal: () => () => {}, getMachineId: async () => (machineIds.push("asked"), "machine-1") },
      logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    });
    assert.deepEqual(options.paths, { codebaseUuidStatePath: join(platformRoot, CODEBASE_UUID_STATE_FILENAME), snapshotsBaseDir: SNAPSHOTS_BASE_DIR });
    assert.equal(options.csnapsBinPath, "/opt/slate/csnaps");
    assert.equal(typeof options.spawnCsnaps, "function");
    assert.equal(typeof options.backendUrl, "string");
    assert.equal(options.uploadPolling.name, "codebase-snapshot-upload");
    assert.equal(options.signal.aborted, false);
    // Every upload carries the account's own token and the headers this host is known by.
    const credentials = (await options.createUploadCredentials()) as { authToken: string; requestHeaders: Record<string, string> };
    assert.equal(credentials.authToken, "token-1");
    assert.equal(typeof credentials.requestHeaders["x-cursor-checksum"], "string");
    assert.equal(credentials.requestHeaders["x-cursor-checksum"]!.length > 0, true);
    assert.equal(credentials.requestHeaders["x-ghost-mode"], "false");
    assert.deepEqual(machineIds, ["asked"]);
  });

  it("runs the service on the platform's own policies", async () => {
    const policies = createCodebaseTelemetryPolicies();
    assert.deepEqual(Object.values(policies).map((policy) => policy.name), [
      "codebase-telemetry-privacy-lookup",
      "codebase-telemetry-privacy-lookup-retry",
      "codebase-telemetry-privacy-refresh",
      "codebase-telemetry-session-restart",
      "codebase-telemetry-shutdown",
    ]);
    // Each one runs the work it is given, and the retry hands out a delay to wait on.
    await assert.doesNotReject(async () => await policies.privacyLookupDeadline.run(async () => "done"));
    await assert.doesNotReject(async () => await policies.shutdownDeadline.run(async () => "done"));
    assert.equal(typeof policies.privacyLookupRetry.schedule(1).elapsed.then, "function");
  });
});

describe("the codebase-telemetry extension", () => {
  it("says what it is, and offers the helper's own paths to whoever asks", () => {
    assert.equal(codebaseTelemetryExtension.kind, "host-extension");
    assert.equal(codebaseTelemetryExtension.id, HostExtensions.CodebaseTelemetry);
    assert.deepEqual(codebaseTelemetryExtension.dependencies, [HostExtensions.Auth, HostExtensions.Experiments]);
    // The two readers the rest of the host uses are re-offered from here.
    assert.equal(typeof resolveCsnapsBinPath, "function");
    assert.equal(typeof resolveCsnapsCapability, "function");
    assert.deepEqual([CODEBASE_UUID_STATE_FILENAME, SNAPSHOTS_BASE_DIR, SNAPSHOT_UPLOAD_INTERVAL_MS, PRIVACY_REFRESH_INTERVAL_MS], ["telemetry/codebase-uuids.json", "/var/lib/slate/telemetry/codebase", 300_000, 300_000]);
  });

  it("says which way the helper is missing, and answers with a surface that has nothing to flush", async () => {
    process.env["SLATE_CSNAPS_BIN"] = join(scratch, "not-there");
    const world = extensionWorld();
    const api = codebaseTelemetryExtension.start({ deps: world.deps, host: world.host, onStop: (teardown: () => void | Promise<void>) => void world.teardowns.push(teardown) } as never);
    assert.deepEqual(world.logged, [`[codebase-telemetry] warn: Codebase Telemetry unavailable: csnaps missing at ${join(scratch, "not-there")}`]);
    assert.deepEqual(world.teardowns, []);
    assert.deepEqual([world.topics, await (api as { flushPendingUploads(): Promise<void> }).flushPendingUploads()], [[], undefined]);
    // A helper that is there but cannot be executed is told apart from one that is not there.
    const readable = join(scratch, "readable-but-not-runnable");
    writeFileSync(readable, "#!/bin/sh\n");
    chmodSync(readable, 0o644);
    process.env["SLATE_CSNAPS_BIN"] = readable;
    const second = extensionWorld();
    codebaseTelemetryExtension.start({ deps: second.deps, host: second.host, onStop: () => {} } as never);
    assert.deepEqual(second.logged, [`[codebase-telemetry] warn: Codebase Telemetry unavailable: csnaps not-executable at ${readable}`]);
  });

  it("builds the service over the host's own account and events when the helper can run", async () => {
    process.env["SLATE_CSNAPS_BIN"] = runnableHelper();
    mkdirSync(platformRoot, { recursive: true });
    const world = extensionWorld();
    const api = codebaseTelemetryExtension.start({ deps: world.deps, host: world.host, onStop: (teardown: () => void | Promise<void>) => void world.teardowns.push(teardown) } as never);
    // Nothing was reported as unavailable, the transcript's two moments are listened to, and the host may flush.
    assert.deepEqual(world.logged, []);
    assert.deepEqual(world.topics, ["transcript.run-started", "transcript.run-ended"]);
    assert.equal(typeof (api as { flushPendingUploads: unknown }).flushPendingUploads, "function");
    assert.equal(world.teardowns.length, 1);
    // With no credential there is no adapter to flush, and that is not an error.
    assert.equal(await (api as { flushPendingUploads(): Promise<void> }).flushPendingUploads(), undefined);
    // Stopping lets the service go, and says nothing about it.
    await world.teardowns[0]!();
    assert.deepEqual(world.logged, []);
    assert.deepEqual(world.topics.slice(2).sort(), ["transcript.run-ended:off", "transcript.run-started:off"]);
  });
});
