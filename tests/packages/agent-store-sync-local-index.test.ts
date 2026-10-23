import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  LocalAgentStoreIndex,
  LocalIndexError,
  META_DELETION_ARMED,
  META_FILES_ROOT_DEV,
  META_FILES_ROOT_INO,
} from "../../source/packages/agent-store-sync/local-index.ts";

// ---------------------------------------------------------------------------------------------
// the real SQLite driver the index talks to
// ---------------------------------------------------------------------------------------------

class NodeSqliteDatabase {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
  }
  close(): void { this.database.close(); }
  exec(sql: string): void { this.database.exec(sql); }
  pragma(sql: string): unknown { this.database.exec("PRAGMA " + sql); return undefined; }
  prepare(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      get: (...params: unknown[]) => { try { return statement.get(...(params as never[])) as never; } catch { return undefined; } },
      all: (...params: unknown[]) => statement.all(...(params as never[])) as never,
      run: (...params: unknown[]) => { const result = statement.run(...(params as never[])); return { changes: Number(result.changes) }; },
    };
  }
  transaction<T>(callback: () => T): () => T {
    return () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = callback();
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    };
  }
}
const driver = { sqlite: NodeSqliteDatabase };

const workRoot = () => mkdtempSync(join(realpathSync(tmpdir()), "local-index-test-"));
function freshStore(): { root: string; indexPath: string } {
  const root = workRoot();
  mkdirSync(join(root, "state"), { recursive: true });
  return { root, indexPath: join(root, "state", "index.sqlite") };
}
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const fileEntry = (overrides: Record<string, unknown> = {}) => ({ relPath: "a/b.txt", lastSyncedSha: "sha-1", size: 12, lastSyncedMs: 1_000, direction: "pulled" as const, ...overrides });
const withIndex = async (run: (index: LocalAgentStoreIndex) => unknown) => {
  const store = freshStore();
  const index = LocalAgentStoreIndex.open(store.indexPath, driver);
  try {
    return await run(index);
  } finally {
    index.close();
    rmSync(store.root, { recursive: true, force: true });
  }
};
const tablesIn = (indexPath: string) => {
  const database = new DatabaseSync(indexPath);
  try {
    return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
  } finally {
    database.close();
  }
};

describe("the local index's values and refusals", () => {
  it("names the meta keys both sides of sync agree on", () => {
    assert.deepEqual([META_DELETION_ARMED, META_FILES_ROOT_DEV, META_FILES_ROOT_INO], ["deletion_armed", "files_root_dev", "files_root_ino"]);
  });

  it("carries the reason it refused an index", () => {
    const error = new LocalIndexError("unsupported_schema_version", "too new");
    assert.equal(error instanceof Error, true);
    assert.deepEqual([error.name, error.message, error.code], ["LocalIndexError", "too new", "unsupported_schema_version"]);
  });
});

describe("opening an index", () => {
  it("creates the current schema privately, with its tables and version", async () => {
    const store = freshStore();
    try {
      const index = LocalAgentStoreIndex.open(store.indexPath, driver);
      try {
        assert.equal(index.getMeta("schema_version"), "3");
        assert.deepEqual(index.listFiles(), []);
        assert.deepEqual(index.listPendingDeletes(), []);
      } finally {
        index.close();
      }
      assert.deepEqual(tablesIn(store.indexPath), ["files", "meta", "pending_deletes"]);
      assert.equal(modeOf(store.indexPath), 0o600, "the index is private");
    } finally {
      rmSync(store.root, { recursive: true, force: true });
    }
  });

  it("opens one instance per path until it is closed, and keeps the data across a reopen", async () => {
    const store = freshStore();
    try {
      const first = LocalAgentStoreIndex.open(store.indexPath, driver);
      const second = LocalAgentStoreIndex.open(store.indexPath, driver);
      assert.equal(second, first, "a second open hands back the live instance");
      first.upsertFile(fileEntry());
      second.close();
      const reopened = LocalAgentStoreIndex.open(store.indexPath, driver);
      assert.notEqual(reopened, first);
      assert.deepEqual(reopened.listFiles().map(entry => entry.relPath), ["a/b.txt"]);
      reopened.close();
      first.close();
    } finally {
      rmSync(store.root, { recursive: true, force: true });
    }
  });

  it("closes idempotently, and answers after close as the driver does", async () => {
    const store = freshStore();
    try {
      const index = LocalAgentStoreIndex.open(store.indexPath, driver);
      index.close();
      index.close();
      assert.throws(() => index.listFiles());
    } finally {
      rmSync(store.root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked index path", () => {
    const store = freshStore();
    try {
      const target = join(store.root, "elsewhere.sqlite");
      writeFileSync(target, "");
      symlinkSync(target, store.indexPath);
      assert.throws(() => LocalAgentStoreIndex.open(store.indexPath, driver), /Refusing to use symlinked agent store path/);
    } finally {
      rmSync(store.root, { recursive: true, force: true });
    }
  });

  it("leaves no handle behind when the driver cannot open, and can be retried", () => {
    const store = freshStore();
    try {
      assert.throws(() => LocalAgentStoreIndex.open(store.indexPath, { sqlite: class { constructor() { throw new Error("sqlite unavailable"); } } } as never), { message: "sqlite unavailable" });
      const index = LocalAgentStoreIndex.open(store.indexPath, driver);
      assert.equal(index.getMeta("schema_version"), "3");
      index.close();
    } finally {
      rmSync(store.root, { recursive: true, force: true });
    }
  });
});

describe("the files an index holds", () => {
  it("round-trips a file's sync state and its optional fields", async () => {
    await withIndex(index => {
      index.upsertFile(fileEntry({ lastSeenEtag: "etag-1" }));
      assert.deepEqual(index.getFile("a/b.txt"), { relPath: "a/b.txt", lastSyncedSha: "sha-1", lastSeenEtag: "etag-1", size: 12, lastSyncedMs: 1_000, direction: "pulled", state: "live" });
      index.upsertFile(fileEntry({ lastSyncedSha: "sha-2", size: 99, direction: "pushed" }));
      assert.deepEqual(index.getFile("a/b.txt")?.lastSyncedSha, "sha-2");
      assert.equal(index.getFile("missing.txt"), undefined);
    });
  });

  it("keeps a tombstone's etag and deletion time only while it is a tombstone", async () => {
    await withIndex(index => {
      index.upsertFile(fileEntry({ state: "tombstoned", tombstoneEtag: "gone", deletedAtMs: 500 }));
      assert.deepEqual(index.getFile("a/b.txt")?.tombstoneEtag, "gone");
      assert.equal(index.getFile("a/b.txt")?.deletedAtMs, 500);
      index.upsertFile(fileEntry({ state: "live", tombstoneEtag: "handed-in", deletedAtMs: 5 }));
      const revived = index.getFile("a/b.txt")!;
      assert.deepEqual([revived.state, revived.tombstoneEtag, revived.deletedAtMs], ["live", undefined, undefined]);
    });
  });

  it("lists files in path order and deletes them", async () => {
    await withIndex(index => {
      for (const relPath of ["b.txt", "a.txt", "c/d.txt"]) index.upsertFile(fileEntry({ relPath }));
      assert.deepEqual(index.listFiles().map(entry => entry.relPath), ["a.txt", "b.txt", "c/d.txt"]);
      assert.equal(index.deleteFile("b.txt"), true);
      assert.equal(index.deleteFile("b.txt"), false);
      assert.deepEqual(index.listFiles().map(entry => entry.relPath), ["a.txt", "c/d.txt"]);
    });
  });
});

describe("what the index owes the counterpart", () => {
  it("round-trips pending deletes, including a mutation id", async () => {
    await withIndex(index => {
      index.upsertPendingDelete({ relPath: "x.txt", baseEtag: "etag-x", requestedAtMs: 10 });
      index.upsertPendingDelete({ relPath: "y.txt", baseEtag: "etag-y", requestedAtMs: 20, mutationId: "mutation-1" });
      index.upsertPendingDelete({ relPath: "x.txt", baseEtag: "etag-x2", requestedAtMs: 30 });
      assert.deepEqual(index.listPendingDeletes(), [
        { relPath: "x.txt", baseEtag: "etag-x2", requestedAtMs: 30 },
        { relPath: "y.txt", baseEtag: "etag-y", requestedAtMs: 20, mutationId: "mutation-1" },
      ]);
      assert.deepEqual([index.hasPendingDelete("x.txt"), index.hasPendingDelete("z.txt")], [true, false]);
      assert.deepEqual([index.removePendingDelete("x.txt"), index.removePendingDelete("x.txt")], [true, false]);
      assert.equal(index.clearPendingDeletes(), 1);
      assert.deepEqual(index.listPendingDeletes(), []);
    });
  });

  it("arms and disarms the deletion marker with the directory identity", async () => {
    await withIndex(index => {
      index.upsertPendingDelete({ relPath: "x.txt", baseEtag: "e", requestedAtMs: 1 });
      index.armDeletionWithIdentity({ dev: 10, ino: 20 });
      assert.deepEqual([index.getMeta(META_DELETION_ARMED), index.getMeta(META_FILES_ROOT_DEV), index.getMeta(META_FILES_ROOT_INO)], ["1", "10", "20"]);
      assert.equal(index.disarmDeletionAndClearPending(), 1);
      assert.deepEqual([index.getMeta(META_DELETION_ARMED), index.getMeta(META_FILES_ROOT_DEV), index.getMeta(META_FILES_ROOT_INO)], ["0", undefined, undefined]);
      assert.deepEqual(index.listPendingDeletes(), []);
    });
  });

  it("reads and writes arbitrary meta values", async () => {
    await withIndex(index => {
      index.setMeta({ key: "k", value: "v" });
      index.setMeta({ key: "k", value: "v2" });
      assert.deepEqual([index.getMeta("k"), index.getMeta("missing")], ["v2", undefined]);
    });
  });
});

describe("bringing an old index forward", () => {
  const seedOldSchema = (indexPath: string, version: 1 | 2 | 3 | 4) => {
    mkdirSync(join(indexPath, ".."), { recursive: true });
    const database = new DatabaseSync(indexPath);
    try {
      database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      if (version === 1) {
        database.exec("CREATE TABLE files (rel_path TEXT PRIMARY KEY, last_seen_sha TEXT NOT NULL, size INTEGER NOT NULL, last_synced_ms INTEGER NOT NULL, direction TEXT NOT NULL)");
        database.exec("INSERT INTO files VALUES ('old.txt', 'sha-old', 7, 42, 'pulled')");
      } else if (version === 2 || version === 3) {
        database.exec("CREATE TABLE files (rel_path TEXT PRIMARY KEY, last_synced_sha TEXT NOT NULL, last_seen_etag TEXT, size INTEGER NOT NULL, last_synced_ms INTEGER NOT NULL, direction TEXT NOT NULL)");
        database.exec("INSERT INTO files VALUES ('old.txt', 'sha-old', 'etag-old', 7, 42, 'pulled')");
      }
      database.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '" + version + "')");
    } finally {
      database.close();
    }
  };

  it("migrates a version 1 index and keeps its rows", () => {
    const store = freshStore();
    try {
      seedOldSchema(store.indexPath, 1);
      const index = LocalAgentStoreIndex.open(store.indexPath, driver);
      try {
        assert.equal(index.getMeta("schema_version"), "3");
        assert.deepEqual(index.getFile("old.txt"), { relPath: "old.txt", lastSyncedSha: "sha-old", size: 7, lastSyncedMs: 42, direction: "pulled", state: "live" });
      } finally {
        index.close();
      }
      assert.deepEqual(tablesIn(store.indexPath), ["files", "meta", "pending_deletes"]);
    } finally {
      rmSync(store.root, { recursive: true, force: true });
    }
  });

  it("migrates a version 2 index and adds tombstones", () => {
    const store = freshStore();
    try {
      seedOldSchema(store.indexPath, 2);
      const index = LocalAgentStoreIndex.open(store.indexPath, driver);
      try {
        assert.equal(index.getMeta("schema_version"), "3");
        assert.deepEqual(index.getFile("old.txt"), { relPath: "old.txt", lastSyncedSha: "sha-old", lastSeenEtag: "etag-old", size: 7, lastSyncedMs: 42, direction: "pulled", state: "live" });
        index.upsertFile(fileEntry({ relPath: "new.txt", state: "tombstoned", deletedAtMs: 9 }));
        assert.equal(index.getFile("new.txt")?.deletedAtMs, 9);
      } finally {
        index.close();
      }
    } finally {
      rmSync(store.root, { recursive: true, force: true });
    }
  });

  it("refuses a schema version this build does not know", () => {
    for (const version of [4, 0] as const) {
      const store = freshStore();
      try {
        seedOldSchema(store.indexPath, version as never);
        assert.throws(
          () => LocalAgentStoreIndex.open(store.indexPath, driver),
          (error: unknown) => error instanceof LocalIndexError && error.code === "unsupported_schema_version" && /Unsupported agent store index schema version/.test(error.message),
          String(version),
        );
      } finally {
        rmSync(store.root, { recursive: true, force: true });
      }
    }
    const store = freshStore();
    try {
      mkdirSync(join(store.indexPath, ".."), { recursive: true });
      const database = new DatabaseSync(store.indexPath);
      database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      database.exec("INSERT INTO meta (key, value) VALUES ('schema_version', 'not-a-number')");
      database.close();
      assert.throws(() => LocalAgentStoreIndex.open(store.indexPath, driver), LocalIndexError);
    } finally {
      rmSync(store.root, { recursive: true, force: true });
    }
  });
});
