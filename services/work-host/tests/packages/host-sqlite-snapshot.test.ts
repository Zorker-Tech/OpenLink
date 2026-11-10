import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import {
  LOCKED_DB_COPY_ATTEMPTS,
  classifySqliteSnapshotFailure,
  copyLockedSqliteDb,
  sqliteVacuumInto,
  type SqliteSnapshotFailure,
} from "../../source/host/boxes/box-store-sync/sqlite-snapshot.ts";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sqlite-snapshot-"));
  roots.push(root);
  return root;
}
after(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function makeDb(path: string, rows: string[]): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE items (name TEXT)");
  for (const row of rows) db.prepare("INSERT INTO items(name) VALUES(?)").run(row);
  db.close();
}
const count = (path: string): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("SELECT name FROM items").all();
  db.close();
  return rows.length;
};

describe("taking a consistent copy of a store database", () => {
  it("vacuum-into makes a queryable copy", () => {
    const root = freshRoot();
    const src = join(root, "source.db");
    const dest = join(root, "copy.db");
    makeDb(src, ["a", "b"]);
    sqliteVacuumInto(src, dest);
    assert.equal(count(dest), 2);
  });

  it("copies a database with its sidecars and verifies it", () => {
    const root = freshRoot();
    const src = join(root, "source.db");
    const dest = join(root, "copy.db");
    makeDb(src, ["a"]);
    const failures: SqliteSnapshotFailure[] = [];
    assert.equal(copyLockedSqliteDb({ srcPath: src, destPath: dest, onFailure: (failure) => failures.push(failure) }), true);
    assert.equal(existsSync(dest), true);
    assert.equal(count(dest), 1);
    assert.deepEqual(failures, []);
  });

  it("refuses a source that changed while it was copied", () => {
    const root = freshRoot();
    const src = join(root, "source.db");
    const dest = join(root, "copy.db");
    makeDb(src, ["a"]);
    const bytes = readFileSync(src);
    let call = 0;
    const failures: SqliteSnapshotFailure[] = [];
    const result = copyLockedSqliteDb({
      srcPath: src,
      destPath: dest,
      readFile: () => { call += 1; const copy = Buffer.from(bytes); if (call % 2 === 0) copy[0] = (copy[0]! + 1) % 256; return copy; },
      onFailure: (failure) => failures.push(failure),
    });
    assert.equal(result, false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.cause, "source_changed");
    assert.equal(failures[0]?.errorClass, "none");
  });

  it("retries a changing source up to the attempt limit", () => {
    const root = freshRoot();
    const src = join(root, "source.db");
    const dest = join(root, "copy.db");
    makeDb(src, ["a"]);
    const bytes = readFileSync(src);
    let call = 0;
    let readCalls = 0;
    const failures: SqliteSnapshotFailure[] = [];
    const result = copyLockedSqliteDb({
      srcPath: src,
      destPath: dest,
      readFile: () => { readCalls += 1; call += 1; const copy = Buffer.from(bytes); copy[0] = (call % 250) + 1; return copy; },
      onFailure: (failure) => failures.push(failure),
    });
    assert.equal(result, false);
    assert.equal(failures.length, 1);
    assert.equal(readCalls >= LOCKED_DB_COPY_ATTEMPTS * 2, true);
  });

  it("refuses a copy that does not pass the quick check", () => {
    const root = freshRoot();
    const src = join(root, "source.db");
    const dest = join(root, "copy.db");
    makeDb(src, ["a"]);
    const garbage = Buffer.from("this is not a database");
    const failures: SqliteSnapshotFailure[] = [];
    const result = copyLockedSqliteDb({
      srcPath: src,
      destPath: dest,
      readFile: () => garbage,
      onFailure: (failure) => failures.push(failure),
    });
    assert.equal(result, false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.operation !== undefined, true);
    assert.equal(existsSync(dest), false);
  });
});

describe("classifying a snapshot failure", () => {
  it("names the failure class and cause", () => {
    const plain = classifySqliteSnapshotFailure(new Error("boom"), "vacuum_into", "staged_main");
    assert.equal(plain.errorClass, "Error");
    assert.equal(plain.cause, "error");
    assert.equal(classifySqliteSnapshotFailure(new TypeError("bad"), "vacuum_into", "staged_main").errorClass, "TypeError");
    assert.equal(classifySqliteSnapshotFailure(new RangeError("bad"), "vacuum_into", "staged_main").errorClass, "RangeError");
    assert.equal(classifySqliteSnapshotFailure("nope", "vacuum_into", "staged_main").cause, "unknown");
  });

  it("reads a sqlite errcode and a system errno", () => {
    const capacity = classifySqliteSnapshotFailure(Object.assign(new Error("full"), { errcode: 13 }), "vacuum_into", "source_main");
    assert.equal(capacity.cause, "sqlite");
    assert.equal(capacity.sqliteCode, 13);
    assert.equal(capacity.pathStage, "staged_main");
    const enospc = classifySqliteSnapshotFailure(Object.assign(new Error("full"), { code: "ENOSPC" }), "copy_source_sidecars", "source_main");
    assert.equal(enospc.cause, "system");
    assert.equal(enospc.errno, "ENOSPC");
    assert.equal(enospc.pathStage, "staged_sidecars");
  });
});
