import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  clearLocalExecDaemonDiscovery,
  clearLocalExecDaemonDiscoveryIfMatches,
  getLocalExecDaemonConnectionPath,
  getLocalExecDaemonCredentialPath,
  getLocalExecDaemonDiscoveryPath,
  getLocalExecSupervisorHeartbeatPath,
  NO_SUPERVISOR_HEARTBEAT,
  parseLocalExecConnection,
  parseLocalExecCredential,
  parseLocalExecDiscovery,
  parseLocalExecSupervisorHeartbeat,
  readLocalExecDaemonConnection,
  readLocalExecDaemonCredential,
  readLocalExecDaemonDiscovery,
  readLocalExecSupervisorHeartbeat,
  writeDaemonJsonFile,
  writeLocalExecDaemonConnection,
  writeLocalExecDaemonDiscovery,
} from "../../source/host/local-exec/local-exec-daemon-protocol.ts";
import type { LocalExecConnection } from "../../source/host/local-exec/local-exec-daemon-protocol.ts";
import {
  LOCAL_EXEC_DAEMON_CONNECTION_FILENAME,
  LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME,
  LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME,
  LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME,
} from "../../source/shared/local-exec-daemon.ts";
import { SLATE_DATA_ROOT_ENV } from "../../source/host/host-paths.ts";

async function withRoot(run: (rootDir: string) => Promise<void> | void): Promise<void> {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-local-exec-protocol-"));
  try {
    await run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

describe("local-exec daemon records", () => {
  it("places connection, discovery, credential and heartbeat files under the Slate data root", () => {
    const previous = process.env[SLATE_DATA_ROOT_ENV];
    const rootDir = mkdtempSync(join(tmpdir(), "slate-local-exec-root-"));
    process.env[SLATE_DATA_ROOT_ENV] = rootDir;
    try {
      assert.equal(getLocalExecDaemonConnectionPath(), join(rootDir, LOCAL_EXEC_DAEMON_CONNECTION_FILENAME));
      assert.equal(getLocalExecDaemonDiscoveryPath(), join(rootDir, LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME));
      assert.equal(getLocalExecDaemonCredentialPath(), join(rootDir, LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME));
      assert.equal(getLocalExecSupervisorHeartbeatPath(), join(rootDir, LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME));
    } finally {
      if (previous === undefined) delete process.env[SLATE_DATA_ROOT_ENV];
      else process.env[SLATE_DATA_ROOT_ENV] = previous;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("accepts a connection only with a nonempty base url and string-valued optional fields", () => {
    const headers = { authorization: "Bearer token", "x-slate-host": "local" };
    assert.deepEqual(parseLocalExecConnection({ baseUrl: "http://127.0.0.1:5000", token: "secret", headers }), {
      baseUrl: "http://127.0.0.1:5000", token: "secret", headers,
    });
    assert.deepEqual(parseLocalExecConnection({ baseUrl: "https://host", token: "" }), { baseUrl: "https://host", token: "" });
    assert.deepEqual(parseLocalExecConnection({ baseUrl: "http://host" }), { baseUrl: "http://host" });
    for (const value of [null, [], {}, { baseUrl: "" }, { baseUrl: 3 }, { baseUrl: "http://host", token: null }, { baseUrl: "http://host", headers: null }, { baseUrl: "http://host", headers: { authorization: 3 } }]) {
      assert.equal(parseLocalExecConnection(value), null);
    }
  });

  it("checks discovery identity fields and preserves only optional values of the right shape", () => {
    assert.deepEqual(parseLocalExecDiscovery({ pid: 12, startedAt: 5, entryRealpath: "/daemon/main.js", generationToken: "g-1", inflightCount: 2, extra: true }), {
      pid: 12, startedAt: 5, entryRealpath: "/daemon/main.js", generationToken: "g-1", inflightCount: 2,
    });
    assert.deepEqual(parseLocalExecDiscovery({ pid: 12, startedAt: -5 }), { pid: 12, startedAt: -5 });
    for (const value of [null, { pid: 0, startedAt: 1 }, { pid: 1.5, startedAt: 1 }, { pid: 1, startedAt: Infinity }, { pid: 1, startedAt: 1, inflightCount: -1 }, { pid: 1, startedAt: 1, inflightCount: 0.5 }, { pid: 1, startedAt: 1, entryRealpath: "" }, { pid: 1, startedAt: 1, generationToken: "" }]) {
      assert.equal(parseLocalExecDiscovery(value), null);
    }
  });

  it("validates heartbeat and credential records separately", () => {
    assert.deepEqual(parseLocalExecSupervisorHeartbeat({ pid: 3, at: -10, extra: "ignored" }), { pid: 3, at: -10 });
    assert.equal(parseLocalExecSupervisorHeartbeat({ pid: 0, at: 1 }), null);
    assert.equal(parseLocalExecSupervisorHeartbeat({ pid: 3, at: "1" }), null);
    assert.deepEqual(parseLocalExecCredential({ credential: "secret", backendUrl: "https://backend", expiresAtMs: 12, extra: true }), {
      credential: "secret", backendUrl: "https://backend", expiresAtMs: 12,
    });
    assert.deepEqual(parseLocalExecCredential({ credential: "secret", backendUrl: "https://backend" }), {
      credential: "secret", backendUrl: "https://backend",
    });
    for (const value of [null, { credential: "", backendUrl: "https://backend" }, { credential: "secret", backendUrl: "" }, { credential: "secret", backendUrl: "https://backend", expiresAtMs: "soon" }]) {
      assert.equal(parseLocalExecCredential(value), null);
    }
  });
});

describe("writing and reading daemon files", () => {
  it("writes compact or pretty JSON through a temporary file", async () => {
    await withRoot(async (rootDir) => {
      const compact = join(rootDir, "nested", "compact.json");
      await writeDaemonJsonFile(compact, { one: 1, two: "2" });
      assert.equal(await fs.readFile(compact, "utf8"), '{"one":1,"two":"2"}');
      assert.equal(await fs.stat(`${compact}.${process.pid}.tmp`).then(() => true, () => false), false);

      const pretty = join(rootDir, "pretty.json");
      await writeDaemonJsonFile(pretty, { one: 1 }, { pretty: true });
      assert.equal(await fs.readFile(pretty, "utf8"), '{\n  "one": 1\n}');
    });
  });

  it("writes the connection with private file permissions and reads it back", async () => {
    await withRoot(async (rootDir) => {
      const path = join(rootDir, "connection.json");
      const connection: LocalExecConnection = { baseUrl: "http://127.0.0.1:5000", token: "secret" };
      await writeLocalExecDaemonConnection(connection, path);
      assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
      assert.deepEqual(await readLocalExecDaemonConnection(path), connection);
    });
  });

  it("returns null for missing, malformed and structurally invalid files", async () => {
    await withRoot(async (rootDir) => {
      const path = join(rootDir, "record.json");
      assert.equal(await readLocalExecDaemonConnection(path), null);
      await fs.writeFile(path, "not json");
      assert.equal(await readLocalExecDaemonConnection(path), null);
      await fs.writeFile(path, JSON.stringify({ baseUrl: 42 }));
      assert.equal(await readLocalExecDaemonConnection(path), null);
      await assert.rejects(() => readLocalExecDaemonConnection(rootDir));
    });
  });

  it("writes pretty discovery records and reads credential records through the shared writer", async () => {
    await withRoot(async (rootDir) => {
      const discoveryPath = join(rootDir, "discovery.json");
      const discovery = { pid: 12, startedAt: 456, entryRealpath: "/daemon/entry.js", generationToken: "gen", inflightCount: 2 };
      await writeLocalExecDaemonDiscovery(discovery, discoveryPath);
      assert.equal((await fs.readFile(discoveryPath, "utf8")).includes("\n  \"pid\""), true);
      assert.deepEqual(await readLocalExecDaemonDiscovery(discoveryPath), discovery);

      const credentialPath = join(rootDir, "credential.json");
      await writeDaemonJsonFile(credentialPath, { credential: "secret", backendUrl: "https://backend", expiresAtMs: 100 });
      assert.deepEqual(await readLocalExecDaemonCredential(credentialPath), { credential: "secret", backendUrl: "https://backend", expiresAtMs: 100 });
    });
  });

  it("uses the stable empty heartbeat for missing, malformed, invalid and unreadable files", async () => {
    await withRoot(async (rootDir) => {
      const path = join(rootDir, "heartbeat.json");
      assert.strictEqual(await readLocalExecSupervisorHeartbeat(path), NO_SUPERVISOR_HEARTBEAT);
      await fs.writeFile(path, "{");
      assert.strictEqual(await readLocalExecSupervisorHeartbeat(path), NO_SUPERVISOR_HEARTBEAT);
      await fs.writeFile(path, JSON.stringify({ pid: -1, at: 1 }));
      assert.strictEqual(await readLocalExecSupervisorHeartbeat(path), NO_SUPERVISOR_HEARTBEAT);
      assert.strictEqual(await readLocalExecSupervisorHeartbeat(rootDir), NO_SUPERVISOR_HEARTBEAT);
    });
  });
});

describe("retiring a daemon discovery record", () => {
  it("removes only the record whose process identity still matches", async () => {
    await withRoot(async (rootDir) => {
      const path = join(rootDir, "discovery.json");
      const expected = { pid: 42, startedAt: 100, entryRealpath: "/daemon/entry.js", generationToken: "generation-a", inflightCount: 1 };
      await writeLocalExecDaemonDiscovery(expected, path);
      assert.equal(await clearLocalExecDaemonDiscoveryIfMatches(expected, path), true);
      assert.equal(await fs.stat(path).then(() => true, () => false), false);
      assert.equal(await clearLocalExecDaemonDiscoveryIfMatches(expected, path), false);
    });
  });

  it("restores a discovery record when any ownership field differs", async () => {
    await withRoot(async (rootDir) => {
      const path = join(rootDir, "discovery.json");
      const stored = { pid: 42, startedAt: 100, entryRealpath: "/daemon/entry.js", generationToken: "generation-a", inflightCount: 1 };
      await writeLocalExecDaemonDiscovery(stored, path);
      const before = await fs.readFile(path, "utf8");
      for (const expected of [
        { ...stored, pid: 43 },
        { ...stored, startedAt: 101 },
        { ...stored, entryRealpath: "/daemon/other.js" },
        { ...stored, generationToken: "generation-b" },
      ]) {
        assert.equal(await clearLocalExecDaemonDiscoveryIfMatches(expected, path), false);
        assert.equal(await fs.readFile(path, "utf8"), before);
      }
      assert.equal(await clearLocalExecDaemonDiscoveryIfMatches({ ...stored, inflightCount: 99 }, path), true);
    });
  });

  it("leaves a replacement record in place if another publisher wins the restore race", async () => {
    await withRoot(async (rootDir) => {
      const path = join(rootDir, "discovery.json");
      const stored = { pid: 42, startedAt: 100, entryRealpath: "/daemon/entry.js", generationToken: "generation-a" };
      const replacement = { pid: 99, startedAt: 200, entryRealpath: "/new/entry.js", generationToken: "generation-b" };
      await writeLocalExecDaemonDiscovery(stored, path);
      const originalLink = fs.link;
      (fs as unknown as { link: typeof fs.link }).link = async (_source, destination) => {
        await fs.writeFile(destination, JSON.stringify(replacement));
        throw Object.assign(new Error("replacement already exists"), { code: "EEXIST" });
      };
      try {
        assert.equal(await clearLocalExecDaemonDiscoveryIfMatches({ ...stored, generationToken: "not-current" }, path), false);
        assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), replacement);
        assert.deepEqual(readdirSync(rootDir), ["discovery.json"]);
      } finally {
        (fs as unknown as { link: typeof fs.link }).link = originalLink;
      }
    });
  });

  it("force-clears a missing discovery path without raising", async () => {
    await withRoot(async (rootDir) => {
      await assert.doesNotReject(() => clearLocalExecDaemonDiscovery(join(rootDir, "missing.json")));
    });
  });

  it("propagates discovery rename failures other than a missing file", async () => {
    await withRoot(async (rootDir) => {
      const originalRename = fs.rename;
      (fs as unknown as { rename: typeof fs.rename }).rename = async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      };
      try {
        await assert.rejects(
          () => clearLocalExecDaemonDiscoveryIfMatches({ pid: 1, startedAt: 1 }, join(rootDir, "discovery.json")),
          (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EACCES",
        );
      } finally {
        (fs as unknown as { rename: typeof fs.rename }).rename = originalRename;
      }
    });
  });
});
