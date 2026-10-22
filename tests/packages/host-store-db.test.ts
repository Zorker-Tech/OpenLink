import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  bumpDbWriteGeneration,
  checkpointSlateAgentDb,
  DB_BUSY_TIMEOUT_MS,
  deleteSlateAgentDbWriteGeneration,
  getSlateAgentDbWriteGeneration,
  hasLiveSlateAgentDbHandle,
  liveDbHandleCount,
  registerLiveDbHandle,
  releaseLiveDbHandle,
  SQLITE_DB_SIDECAR_SUFFIXES,
  walFramesFullyFolded,
} from "../../source/host/storage/store-db.ts";

/** A directory of its own for one case, removed however the case ends. */
const inTemporaryDirectory = (run: (directory: string) => void): void => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slate-store-db-"));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

describe("the store's database bookkeeping", () => {
  it("names the busy timeout and the sidecar files a database may leave", () => {
    assert.equal(DB_BUSY_TIMEOUT_MS, 5_000);
    assert.deepEqual([...SQLITE_DB_SIDECAR_SUFFIXES], ["-wal", "-shm", "-journal"]);
  });

  it("remembers a write generation per database, by its resolved path", () => {
    const databasePath = path.join(os.tmpdir(), "slate-store-db-generation", `${process.pid}.db`);
    assert.equal(getSlateAgentDbWriteGeneration(databasePath), 0);
    bumpDbWriteGeneration(databasePath);
    assert.equal(getSlateAgentDbWriteGeneration(databasePath), 1);
    bumpDbWriteGeneration(databasePath);
    assert.equal(getSlateAgentDbWriteGeneration(databasePath), 2);
    deleteSlateAgentDbWriteGeneration(databasePath);
    assert.equal(getSlateAgentDbWriteGeneration(databasePath), 0);
    // The same file under another spelling of its path is the same database.
    bumpDbWriteGeneration(path.join(path.dirname(databasePath), "sub", "..", path.basename(databasePath)));
    assert.equal(getSlateAgentDbWriteGeneration(databasePath), 1);
    deleteSlateAgentDbWriteGeneration(databasePath);
  });

  it("counts live handles, and forgets the count when the last one goes", () => {
    const databasePath = path.join(os.tmpdir(), "slate-store-db-handles", `${process.pid}.db`);
    assert.equal(liveDbHandleCount(databasePath), 0);
    assert.equal(hasLiveSlateAgentDbHandle(databasePath), false);
    registerLiveDbHandle(databasePath);
    assert.equal(liveDbHandleCount(databasePath), 1);
    assert.equal(hasLiveSlateAgentDbHandle(databasePath), true);
    registerLiveDbHandle(databasePath);
    assert.equal(liveDbHandleCount(databasePath), 2);
    releaseLiveDbHandle(databasePath);
    assert.equal(liveDbHandleCount(databasePath), 1);
    releaseLiveDbHandle(databasePath);
    assert.equal(liveDbHandleCount(databasePath), 0);
    assert.equal(hasLiveSlateAgentDbHandle(databasePath), false);
    // Releasing a handle that was never taken does not go below zero.
    releaseLiveDbHandle(databasePath);
    assert.equal(liveDbHandleCount(databasePath), 0);
  });

  it("reads a wal_checkpoint row: folded when every frame is checkpointed, unknown when the row is not one", () => {
    assert.equal(walFramesFullyFolded({ log: 5, checkpointed: 5 }), true);
    assert.equal(walFramesFullyFolded({ log: 5, checkpointed: 6 }), true);
    assert.equal(walFramesFullyFolded({ log: 5, checkpointed: 4 }), false);
    assert.equal(walFramesFullyFolded({ log: 0, checkpointed: 0 }), true);
    for (const row of [undefined, null, 0, "row", {}, { log: -1, checkpointed: 0 }, { log: 0, checkpointed: -1 }, { log: "5", checkpointed: 5 }, { log: 5 }]) {
      assert.equal(walFramesFullyFolded(row), undefined, JSON.stringify(row));
    }
  });

  it("is folded when there is no database to fold", () => {
    inTemporaryDirectory((directory) => {
      const missing = path.join(directory, "nested", "missing.db");
      assert.equal(checkpointSlateAgentDb(missing), true);
      assert.equal(fs.existsSync(path.dirname(missing)), false, "a missing database is not created to be checked");
      // A path that is not a database file at all cannot be opened.
      const asDirectory = path.join(directory, "a-directory.db");
      fs.mkdirSync(asDirectory);
      assert.equal(checkpointSlateAgentDb(asDirectory), false);
      const corrupt = path.join(directory, "corrupt.db");
      fs.writeFileSync(corrupt, "this is not a database");
      assert.equal(checkpointSlateAgentDb(corrupt), false);
    });
  });

  it("is folded for an empty database file, and for a plain one with its wal already gone", () => {
    inTemporaryDirectory((directory) => {
      const emptyFile = path.join(directory, "empty.db");
      fs.writeFileSync(emptyFile, "");
      assert.equal(checkpointSlateAgentDb(emptyFile), true);
      const plain = path.join(directory, "plain.db");
      const db = new DatabaseSync(plain);
      db.exec("CREATE TABLE t(x)");
      db.close();
      assert.equal(fs.existsSync(`${plain}-wal`), false);
      assert.equal(checkpointSlateAgentDb(plain), true);
      assert.equal(checkpointSlateAgentDb(plain, 25), true, "a custom busy timeout is accepted");
    });
  });

  it("folds a wal with frames in it, leaving the database readable and its rows intact", () => {
    inTemporaryDirectory((directory) => {
      const walPath = path.join(directory, "wal.db");
      const writer = new DatabaseSync(walPath);
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec("CREATE TABLE t(x)");
      for (let index = 0; index < 50; index += 1) writer.prepare("INSERT INTO t VALUES (?)").run(index);
      assert.equal(checkpointSlateAgentDb(walPath), true);
      assert.equal(fs.existsSync(`${walPath}-wal`) ? fs.statSync(`${walPath}-wal`).size : 0, 0);
      writer.close();
      assert.equal(checkpointSlateAgentDb(walPath), true);
      const reader = new DatabaseSync(walPath);
      assert.equal((reader.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n, 50);
      reader.close();
    });
  });
});