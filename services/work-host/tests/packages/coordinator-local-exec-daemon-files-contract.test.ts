import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  LOCAL_EXEC_DAEMON_CONNECTION_FILENAME,
  LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME,
  LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME,
  LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME,
} from "../../source/shared/local-exec-daemon.ts";
import {
  LOCAL_EXEC_DAEMON_LOG_FILENAME,
  parseDiscovery,
  readLocalExecDaemonDiscovery,
  removeLocalExecDaemonDiscoveryIfMatches,
  removeLocalExecDaemonFile,
  resolveLocalExecDaemonPaths,
  writeLocalExecDaemonConnection,
  writeLocalExecDaemonCredential,
  writeLocalExecSupervisorHeartbeat,
  writeSecretJsonFile,
  type LocalExecDaemonDiscovery,
} from "../../source/coordinator/local-exec/daemon-files.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-daemon-files-contract-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const discovery = (overrides: Record<string, unknown> = {}) => ({
  pid: 123,
  startedAt: 10_000,
  entryRealpath: "/opt/slate/daemon.js",
  generationToken: "generation-a",
  inflightCount: 0,
  ...overrides,
});

describe("local-exec daemon file behavior contract", () => {
  it("resolves all daemon control files under the selected data directory", () => {
    assert.deepEqual(resolveLocalExecDaemonPaths("/slate/data"), {
      connectionPath: join("/slate/data", LOCAL_EXEC_DAEMON_CONNECTION_FILENAME),
      discoveryPath: join("/slate/data", LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME),
      credentialPath: join("/slate/data", LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME),
      logPath: join("/slate/data", LOCAL_EXEC_DAEMON_LOG_FILENAME),
      supervisorHeartbeatPath: join("/slate/data", LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME),
    });
  });

  it("accepts valid discovery identity fields and drops unknown fields", () => {
    assert.deepEqual(parseDiscovery({ ...discovery(), extra: "ignored" }), discovery());
    assert.deepEqual(parseDiscovery({ pid: 5, startedAt: 0 }), { pid: 5, startedAt: 0 });
    assert.deepEqual(parseDiscovery({ pid: 5, startedAt: -10, inflightCount: 0 }), { pid: 5, startedAt: -10, inflightCount: 0 });
  });

  it("refuses malformed required and optional discovery values", () => {
    for (const value of [
      null,
      "not an object",
      [],
      discovery({ pid: 0 }),
      discovery({ pid: -1 }),
      discovery({ pid: 1.5 }),
      discovery({ pid: "123" }),
      discovery({ startedAt: Number.NaN }),
      discovery({ startedAt: Number.POSITIVE_INFINITY }),
      discovery({ startedAt: "10000" }),
      discovery({ entryRealpath: "" }),
      discovery({ entryRealpath: 7 }),
      discovery({ generationToken: "" }),
      discovery({ generationToken: false }),
      discovery({ inflightCount: -1 }),
      discovery({ inflightCount: 0.5 }),
      discovery({ inflightCount: "0" }),
    ]) assert.equal(parseDiscovery(value), null);
  });

  it("returns null for missing, corrupt and invalid discovery files but propagates other read failures", async () => {
    const directory = join(scratch, "read-discovery");
    mkdirSync(directory);
    const path = join(directory, "discovery.json");
    assert.equal(await readLocalExecDaemonDiscovery(path), null);
    writeFileSync(path, "not json");
    assert.equal(await readLocalExecDaemonDiscovery(path), null);
    writeFileSync(path, JSON.stringify(discovery({ pid: 0 })));
    assert.equal(await readLocalExecDaemonDiscovery(path), null);
    await assert.rejects(() => readLocalExecDaemonDiscovery(directory));
  });

  it("writes nested JSON atomically with private file permissions", async () => {
    const path = join(scratch, "nested", "state", "secret.json");
    await writeSecretJsonFile(path, { token: "credential", expiresAt: 5 });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { token: "credential", expiresAt: 5 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dirname(path)), ["secret.json"]);
  });

  it("uses the private JSON writer for daemon connection and credential records", async () => {
    const paths = resolveLocalExecDaemonPaths(join(scratch, "control"));
    await writeLocalExecDaemonConnection({ url: "ws://127.0.0.1:4" }, paths.connectionPath);
    await writeLocalExecDaemonCredential({ credential: "secret-value" }, paths.credentialPath);
    assert.deepEqual(JSON.parse(readFileSync(paths.connectionPath, "utf8")), { url: "ws://127.0.0.1:4" });
    assert.deepEqual(JSON.parse(readFileSync(paths.credentialPath, "utf8")), { credential: "secret-value" });
    assert.equal(statSync(paths.connectionPath).mode & 0o777, 0o600);
    assert.equal(statSync(paths.credentialPath).mode & 0o777, 0o600);
  });

  it("writes the supervisor heartbeat with the current process and timestamp", async () => {
    const oldNow = Date.now;
    Date.now = () => 77;
    const path = join(scratch, "heartbeat", LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME);
    try {
      await writeLocalExecSupervisorHeartbeat(path);
    } finally {
      Date.now = oldNow;
    }
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { pid: process.pid, at: 77 });
  });

  it("removes an existing file and treats an already-missing file as removed", async () => {
    const path = join(scratch, "remove", "one.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "value");
    await removeLocalExecDaemonFile(path);
    assert.equal(existsSync(path), false);
    await removeLocalExecDaemonFile(path);
  });

  it("removes discovery only when the PID/start/entry/generation identity matches", async () => {
    const directory = join(scratch, "matching-generation");
    mkdirSync(directory);
    const path = join(directory, "discovery.json");
    writeFileSync(path, JSON.stringify(discovery({ inflightCount: 9 })));
    const expected: LocalExecDaemonDiscovery = {
      pid: 123,
      startedAt: 10_000,
      entryRealpath: "/opt/slate/daemon.js",
      generationToken: "generation-a",
      inflightCount: 0,
    };
    assert.equal(await removeLocalExecDaemonDiscoveryIfMatches(path, expected), true);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(directory), []);
  });

  it("restores a different daemon generation at the original path", async () => {
    const directory = join(scratch, "different-generation");
    mkdirSync(directory);
    const path = join(directory, "discovery.json");
    const other = discovery({ pid: 456, generationToken: "generation-b" });
    writeFileSync(path, JSON.stringify(other));
    const expected: LocalExecDaemonDiscovery = { ...discovery(), inflightCount: 0 };

    assert.equal(await removeLocalExecDaemonDiscoveryIfMatches(path, expected), false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), other);
    assert.deepEqual(readdirSync(directory), ["discovery.json"]);
  });

  it("restores malformed discovery bytes and returns false when no valid identity can be read", async () => {
    const directory = join(scratch, "malformed-generation");
    mkdirSync(directory);
    const path = join(directory, "discovery.json");
    writeFileSync(path, "broken discovery");
    assert.equal(await removeLocalExecDaemonDiscoveryIfMatches(path, { pid: 123, startedAt: 10_000 }), false);
    assert.equal(readFileSync(path, "utf8"), "broken discovery");
    assert.deepEqual(readdirSync(directory), ["discovery.json"]);
  });

  it("returns false when no discovery path exists", async () => {
    const path = join(scratch, "absent", "discovery.json");
    assert.equal(await removeLocalExecDaemonDiscoveryIfMatches(path, { pid: 1, startedAt: 1 }), false);
  });
});
