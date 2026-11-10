import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import {
  SlateAgentDbIntegrityError,
  initConfiguredDb,
  isStoreDbHealthy,
  openConfiguredDb,
  quarantineCorruptDb,
  recoverCorruptStoreDb,
  salvageStoreDb,
} from "../../source/host/extensions/session/agent-db-recovery.ts";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-db-recovery-"));
  roots.push(root);
  return root;
}
after(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const storePath = () => join(freshRoot(), "store.db");
const countsOf = (db: DatabaseSync, table: string): number => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

describe("opening an agent store", () => {
  it("creates the schema and reports a healthy store", () => {
    const path = storePath();
    const db = initConfiguredDb(path, "agent-1", {});
    try {
      assert.equal(isStoreDbHealthy(db), true);
      const row = db.prepare("PRAGMA busy_timeout").get() as { timeout?: number; busy_timeout?: number };
      assert.equal(typeof (row.timeout ?? row.busy_timeout), "number");
      db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("k", "v");
      assert.equal(countsOf(db, "kv"), 1);
    } finally {
      db.close();
    }
  });

  it("reads an unhealthy store as unhealthy instead of throwing", () => {
    assert.equal(isStoreDbHealthy({ prepare: () => ({ get: () => ({ quick_check: "ok" }) }) } as never), true);
    assert.equal(isStoreDbHealthy({ prepare: () => { throw new Error("broken"); } } as never), false);
    assert.equal(isStoreDbHealthy({ prepare: () => ({ get: () => ({ quick_check: "corrupt" }) }) } as never), false);
  });

  it("throws an integrity error when corruption is refused", () => {
    const path = storePath();
    assert.throws(
      () => openConfiguredDb(path, "agent-2", { recoverOnCorruption: false, rejectIfCorrupt: true }, false, () => ({ close: () => {}, prepare: () => { throw new Error("unhealthy"); } }) as never),
      (error: unknown) => error instanceof SlateAgentDbIntegrityError && String(error.message).includes("agent-2"),
    );
  });
});

describe("recovering a corrupt store", () => {
  it("quarantines the corrupt file aside", () => {
    const path = storePath();
    writeFileSync(path, "this is not a sqlite database");
    const quarantine = quarantineCorruptDb(path, "agent-1");
    assert.equal(quarantine != null && existsSync(quarantine), true);
    assert.equal(existsSync(path), false);
    assert.equal(quarantineCorruptDb(join(freshRoot(), "missing", "store.db"), "agent-1"), null);
  });

  it("salvages the readable rows into a fresh store", () => {
    const root = freshRoot();
    const sourcePath = join(root, "source.db");
    const source = new DatabaseSync(sourcePath);
    source.exec("CREATE TABLE kv (key TEXT, value TEXT); CREATE TABLE blobs (id TEXT, data BLOB); CREATE TABLE transcript_entries (seq INTEGER, id TEXT, entry TEXT)");
    source.prepare("INSERT INTO kv VALUES (?, ?)").run("k1", "v1");
    source.prepare("INSERT INTO blobs VALUES (?, ?)").run("b1", Buffer.from("data"));
    source.prepare("INSERT INTO transcript_entries VALUES (?, ?, ?)").run(1, "t1", "{}");
    source.close();
    const fresh = initConfiguredDb(join(root, "fresh.db"), "agent-1", {});
    try {
      const salvaged = salvageStoreDb(sourcePath, fresh);
      assert.deepEqual(salvaged, { kv: 1, blobs: 1, transcript: 1 });
      assert.equal(countsOf(fresh, "kv"), 1);
      assert.equal(countsOf(fresh, "blobs"), 1);
      assert.equal(countsOf(fresh, "transcript_entries"), 1);
    } finally {
      fresh.close();
    }
    assert.deepEqual(salvageStoreDb(join(root, "missing.db"), initConfiguredDb(join(root, "fresh2.db"), "agent-1", {})), { kv: 0, blobs: 0, transcript: 0 });
  });

  it("rebuilds the store and reports the recovery outcome", () => {
    const path = storePath();
    writeFileSync(path, "this is not a sqlite database");
    const events: unknown[] = [];
    const db = recoverCorruptStoreDb(path, "agent-1", { onCorruptionRecovered: (event) => events.push(event) }, new Error("corrupt"));
    try {
      assert.equal(isStoreDbHealthy(db), true);
    } finally {
      db.close();
    }
    assert.equal(events.length, 1);
    const event = events[0] as { outcome: string; quarantinePath: string | null; salvaged: { kv: number } };
    assert.equal(event.outcome, "reset");
    assert.equal(event.quarantinePath != null, true);
    assert.equal(event.salvaged.kv, 0);
    assert.equal(existsSync(event.quarantinePath!), true);
  });

  it("retries an io failure once before giving up", () => {
    const failures: unknown[] = [];
    const ioFailure = new Error("disk I/O error");
    let attempts = 0;
    assert.throws(() => openConfiguredDb(storePath(), "agent-1", {}, false, () => { attempts += 1; failures.push(ioFailure); throw ioFailure; }), (error: unknown) => error === ioFailure);
    assert.equal(attempts, 2);
  });
});
