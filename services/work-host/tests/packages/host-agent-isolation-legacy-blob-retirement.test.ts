/**
 * Whether a conversation's old blob database can be let go of: the order the checks are made in, what each refusal
 * says, and what the old file is counted as before it is retired.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { verifyLegacyBlobRetirement } from "../../source/host/agents/isolation/legacy-blob-retirement.ts";
import { CONVERSATION_BLOB_ADOPTION_COMPLETE, CONVERSATION_BLOB_RECOVERY_REBUILT, CONVERSATION_BLOB_SCHEMA } from "../../source/host/agents/isolation/conversation-blob-db.ts";

/** A workspace with a destination database and an old one beside it. */
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "slate-blob-retirement-"));
  return {
    destinationPath: join(directory, "conversation-blobs.db"),
    legacyPath: join(directory, "legacy-blobs.db"),
  };
}

/** A blob database with the given blobs in it, at the given migration state. */
function writeBlobs(dbPath: string, blobs: Array<[string, number]>, userVersion: number): void {
  const db = new DatabaseSync(dbPath);
  db.exec(CONVERSATION_BLOB_SCHEMA);
  const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
  for (const [id, size] of blobs) insert.run(id, new Uint8Array(size).fill(3));
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
}

/** A database with a table of its own rather than the blobs one. */
function writeForeignKeyTable(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE other (id TEXT PRIMARY KEY) STRICT");
  db.close();
}

describe("what has to be true before the old file is let go", () => {
  it("refuses when there is nothing there to retire", () => {
    const world = workspace();
    const db = new DatabaseSync(world.destinationPath);
    db.exec(CONVERSATION_BLOB_SCHEMA);
    const verdict = verifyLegacyBlobRetirement({ db, legacyBlobDbPath: world.legacyPath, retainedRootIdHex: "root" });
    db.close();
    assert.deepEqual(verdict, { isRetirable: false, reason: "legacy-unreadable", legacyRows: 0, legacyBytes: 0 });
  });

  it("refuses while the destination is unhealthy or has not been adopted yet", () => {
    const world = workspace();
    writeBlobs(world.legacyPath, [["a", 8]], 0);
    // A destination whose integrity check cannot be made is not a place to retire anything into.
    const closed = new DatabaseSync(world.destinationPath);
    closed.close();
    assert.deepEqual(verifyLegacyBlobRetirement({ db: closed, legacyBlobDbPath: world.legacyPath, retainedRootIdHex: "root" }), {
      isRetirable: false,
      reason: "destination-unhealthy",
      legacyRows: 0,
      legacyBytes: 0,
    });
    // A destination that has not been adopted yet, and one that was rebuilt rather than adopted, both hold off.
    for (const [version, reason] of [
      [0, "adoption-incomplete"],
      [CONVERSATION_BLOB_RECOVERY_REBUILT, "recovery-rebuilt"],
      [99, "migration-state-unknown"],
    ] as const) {
      const destinationPath = join(world.destinationPath, `..`, `destination-${version}.db`);
      writeBlobs(destinationPath, [["root", 4]], version);
      const db = new DatabaseSync(destinationPath);
      const verdict = verifyLegacyBlobRetirement({ db, legacyBlobDbPath: world.legacyPath, retainedRootIdHex: "root" });
      db.close();
      assert.deepEqual(verdict, { isRetirable: false, reason, legacyRows: 0, legacyBytes: 0 });
    }
  });

  it("refuses when the blob the conversation is kept by is not in the destination", () => {
    const world = workspace();
    writeBlobs(world.destinationPath, [["another-blob", 4]], CONVERSATION_BLOB_ADOPTION_COMPLETE);
    writeBlobs(world.legacyPath, [["a", 8]], 0);
    const db = new DatabaseSync(world.destinationPath);
    const verdict = verifyLegacyBlobRetirement({ db, legacyBlobDbPath: world.legacyPath, retainedRootIdHex: "root" });
    db.close();
    assert.deepEqual(verdict, { isRetirable: false, reason: "root-missing", legacyRows: 0, legacyBytes: 0 });
  });
});

describe("what is counted before it is let go", () => {
  it("counts the rows and bytes of the old file, and lets go of it", () => {
    const world = workspace();
    writeBlobs(world.destinationPath, [["root", 4]], CONVERSATION_BLOB_ADOPTION_COMPLETE);
    writeBlobs(world.legacyPath, [["a", 10], ["b", 32], ["c", 7]], 0);
    const db = new DatabaseSync(world.destinationPath);
    const verdict = verifyLegacyBlobRetirement({ db, legacyBlobDbPath: world.legacyPath, retainedRootIdHex: "root" });
    // What is retired is what the old file actually holds.
    assert.deepEqual(verdict, { isRetirable: true, legacyRows: 3, legacyBytes: 49 });
    // The old file is detached again rather than left attached to the destination.
    assert.equal(db.prepare("PRAGMA database_list").all().some((row) => (row as { name: string }).name === "legacy"), false);
    // And asking twice is the same answer as asking once.
    assert.deepEqual(verifyLegacyBlobRetirement({ db, legacyBlobDbPath: world.legacyPath, retainedRootIdHex: "root" }), { isRetirable: true, legacyRows: 3, legacyBytes: 49 });
    db.close();
    // An old file with nothing in it is worth retiring too, at nothing.
    const empty = workspace();
    writeBlobs(empty.destinationPath, [["root", 4]], CONVERSATION_BLOB_ADOPTION_COMPLETE);
    writeBlobs(empty.legacyPath, [], 0);
    const emptyDb = new DatabaseSync(empty.destinationPath);
    assert.deepEqual(verifyLegacyBlobRetirement({ db: emptyDb, legacyBlobDbPath: empty.legacyPath, retainedRootIdHex: "root" }), { isRetirable: true, legacyRows: 0, legacyBytes: 0 });
    emptyDb.close();
  });

  it("refuses an old file it cannot read the blobs out of", () => {
    const world = workspace();
    writeBlobs(world.destinationPath, [["root", 4]], CONVERSATION_BLOB_ADOPTION_COMPLETE);
    // A file that is not a database at all.
    writeFileSync(world.legacyPath, Buffer.from("this is not a database", "utf8"));
    const db = new DatabaseSync(world.destinationPath);
    assert.deepEqual(verifyLegacyBlobRetirement({ db, legacyBlobDbPath: world.legacyPath, retainedRootIdHex: "root" }), {
      isRetirable: false,
      reason: "legacy-unreadable",
      legacyRows: 0,
      legacyBytes: 0,
    });
    // A database of its own kind that simply has no blobs in it.
    const other = workspace();
    writeBlobs(other.destinationPath, [["root", 4]], CONVERSATION_BLOB_ADOPTION_COMPLETE);
    writeForeignKeyTable(other.legacyPath);
    const otherDb = new DatabaseSync(other.destinationPath);
    assert.deepEqual(verifyLegacyBlobRetirement({ db: otherDb, legacyBlobDbPath: other.legacyPath, retainedRootIdHex: "root" }), {
      isRetirable: false,
      reason: "legacy-unreadable",
      legacyRows: 0,
      legacyBytes: 0,
    });
    otherDb.close();
    db.close();
  });
});
