/**
 * The database a conversation's blobs live in: how it is opened, what a damaged file turns into, how a rebuild that was
 * interrupted is finished, and what is kept aside rather than thrown away.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  CONVERSATION_BLOB_ADOPTION_COMPLETE,
  CONVERSATION_BLOB_RECOVERY_REBUILT,
  CONVERSATION_BLOB_SCHEMA,
  CONVERSATION_BLOB_MIGRATION_UNSTARTED,
  openConfiguredConversationBlobDb,
  openConversationBlobDb,
  readConversationBlobMigrationState,
  removeSqliteSidecars,
  runQuickCheck,
} from "../../source/host/agents/isolation/conversation-blob-db.ts";

/** A directory of its own for one case, and the interesting names left in it. */
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "slate-conversation-blobs-"));
  return {
    directory,
    dbPath: join(directory, "conversation-blobs.db"),
    names: () => readdirSync(directory).sort(),
    leftovers: () => readdirSync(directory).filter((name) => name.endsWith(".pending") || name.endsWith(".replacement") || name.endsWith(".intent")).sort(),
    interesting: () => readdirSync(directory).filter((name) => name.startsWith("conversation-blobs.db")).sort(),
  };
}

/** A conversation's blob database with the given blobs in it, as the platform writes one. */
function writeBlobs(dbPath: string, blobs: Array<[string, number]>, userVersion?: number): void {
  const db = new DatabaseSync(dbPath);
  db.exec(CONVERSATION_BLOB_SCHEMA);
  const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
  for (const [id, size] of blobs) insert.run(id, new Uint8Array(size).fill(7));
  if (userVersion !== undefined) db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
}

/** Zero a file from a fraction of its length onwards, which leaves a database that is recognisably one but damaged. */
function damageFrom(dbPath: string, fraction: number): void {
  const bytes = readFileSync(dbPath);
  const from = Math.max(24, Math.floor(bytes.length * fraction));
  for (let index = from; index < bytes.length; index += 1) bytes[index] = 0;
  writeFileSync(dbPath, bytes);
}

function readIds(db: DatabaseSync): string[] {
  return (db.prepare("SELECT id FROM blobs").all() as Array<{ id: string }>).map((row) => row.id).sort();
}
function readVersion(db: DatabaseSync): unknown {
  return (db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version;
}

/** Open a conversation's blobs the way the platform does, with everything it says written down. */
function open(options: { dbPath: string; agentId?: string; onRecoveryThrows?: boolean }) {
  const seen: string[] = [];
  const recoveries: Array<{ outcome: string; quarantinePath: string | null; salvagedBlobs: number }> = [];
  const db = openConversationBlobDb({
    dbPath: options.dbPath,
    busyTimeoutMs: 250,
    agentId: options.agentId ?? "agent-1",
    log: (message) => seen.push(message),
    onRecovery: (info) => {
      recoveries.push(info);
      if (options.onRecoveryThrows === true) throw new Error("the recovery callback failed");
    },
  });
  return { db, seen, recoveries };
}

describe("what a blob database says about itself", () => {
  it("reads the migration state it was left in", () => {
    const world = workspace();
    writeBlobs(world.dbPath, [["a", 4]]);
    const fresh = new DatabaseSync(world.dbPath);
    assert.equal(readConversationBlobMigrationState(fresh), "unstarted");
    for (const [version, expected] of [
      [CONVERSATION_BLOB_ADOPTION_COMPLETE, "adoption-complete"],
      [CONVERSATION_BLOB_RECOVERY_REBUILT, "recovery-rebuilt"],
      [99, "unknown"],
    ] as const) {
      fresh.exec(`PRAGMA user_version = ${version}`);
      assert.equal(readConversationBlobMigrationState(fresh), expected);
    }
    fresh.close();
    // A database that cannot even be asked is not mistaken for one that has not started.
    assert.equal(readConversationBlobMigrationState(fresh), "unknown");
    assert.deepEqual(
      [CONVERSATION_BLOB_MIGRATION_UNSTARTED, CONVERSATION_BLOB_ADOPTION_COMPLETE, CONVERSATION_BLOB_RECOVERY_REBUILT],
      [0, 1, 2],
    );
  });

  it("opens a database with the settings and the schema it needs", () => {
    const world = workspace();
    const db = openConfiguredConversationBlobDb(world.dbPath, 750);
    assert.equal(db.prepare("PRAGMA busy_timeout").get()?.["timeout"], 750);
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run("blob-1", new Uint8Array([1, 2, 3]));
    assert.equal(runQuickCheck(db), "healthy");
    db.close();
    // The same file opens again with what was written into it.
    const again = openConfiguredConversationBlobDb(world.dbPath, 250);
    assert.deepEqual(readIds(again), ["blob-1"]);
    assert.equal((again.prepare("SELECT data FROM blobs WHERE id = ?").get("blob-1")?.data as Uint8Array).length, 3);
    again.close();
  });

  it("clears the sidecars a database leaves behind, and leaves the database itself", () => {
    const world = workspace();
    writeBlobs(world.dbPath, [["a", 4]]);
    for (const suffix of ["-wal", "-shm", "-journal"]) writeFileSync(`${world.dbPath}${suffix}`, "");
    removeSqliteSidecars(world.dbPath);
    assert.deepEqual(world.names(), ["conversation-blobs.db"]);
  });
});

describe("opening a conversation that is fine", () => {
  it("hands back what was there, and says nothing about recovery", () => {
    const world = workspace();
    writeBlobs(world.dbPath, [["a", 8], ["b", 8]], CONVERSATION_BLOB_ADOPTION_COMPLETE);
    const { db, seen, recoveries } = open({ dbPath: world.dbPath });
    assert.deepEqual(readIds(db), ["a", "b"]);
    assert.equal(readVersion(db), CONVERSATION_BLOB_ADOPTION_COMPLETE);
    db.close();
    assert.deepEqual([seen, recoveries], [[], []]);
    assert.deepEqual(world.interesting(), ["conversation-blobs.db"]);
    // The directory a database belongs in is made when it is not there yet.
    const nested = workspace();
    const { db: fresh } = open({ dbPath: join(nested.directory, "agents", "agent-1", "conversation-blobs.db") });
    assert.deepEqual(readIds(fresh), []);
    fresh.close();
  });
});

describe("opening one whose file is damaged", () => {
  it("keeps what can still be read, keeps the damaged file aside, and reports what it did", () => {
    const world = workspace();
    const blobs = Array.from({ length: 200 }, (_, index): [string, number] => [`row-${index}`, 2_048]);
    writeBlobs(world.dbPath, blobs, CONVERSATION_BLOB_ADOPTION_COMPLETE);
    damageFrom(world.dbPath, 0.6);
    const { db, seen, recoveries } = open({ dbPath: world.dbPath });
    // What survived is a prefix of what was there — some rows are lost, not all of them, and the rest is gone.
    const ids = readIds(db);
    assert.equal(ids.length > 0, true);
    assert.equal(ids.length < blobs.length, true);
    assert.equal(ids.includes("row-0"), true);
    assert.equal(readVersion(db), CONVERSATION_BLOB_RECOVERY_REBUILT);
    db.close();
    assert.deepEqual(recoveries.map((info) => info.outcome), ["recovered"]);
    assert.equal(recoveries[0]?.salvagedBlobs, ids.length);
    const quarantine = recoveries[0]?.quarantinePath ?? "";
    assert.equal(quarantine.includes(".corrupt-"), true);
    assert.equal(existsSync(quarantine), true);
    // The damaged file is what it kept aside, not the healthy one it installed.
    assert.equal(readFileSync(quarantine).includes(Buffer.from("SQLite format 3")), true);
    assert.equal(seen.length, 1);
    assert.match(String(seen[0]), /recovery: outcome=recovered agent=agent-1 quarantine=conversation-blobs\.db\.corrupt-/);
    assert.match(String(seen[0]), new RegExp(`salvaged\\.blobs=${ids.length}`));
    // The conversation is left with a working database, and nothing staging a rebuild is left behind — the damaged
    // file it kept aside is the only other thing in the directory.
    assert.deepEqual(world.leftovers(), []);
    assert.deepEqual(world.names(), ["conversation-blobs.db", String(quarantine).split("/").pop()].sort());
  });

  it("starts over when nothing can be read, and still keeps the damaged file", () => {
    const world = workspace();
    writeBlobs(world.dbPath, [["a", 64]], CONVERSATION_BLOB_ADOPTION_COMPLETE);
    damageFrom(world.dbPath, 0.02);
    const { db, seen, recoveries } = open({ dbPath: world.dbPath });
    assert.deepEqual(readIds(db), []);
    assert.equal(readVersion(db), CONVERSATION_BLOB_RECOVERY_REBUILT);
    db.close();
    assert.deepEqual(recoveries, [{ outcome: "reset", quarantinePath: recoveries[0]?.quarantinePath ?? "", salvagedBlobs: 0 }]);
    assert.equal(existsSync(recoveries[0]?.quarantinePath ?? ""), true);
    assert.match(String(seen[0]), /outcome=reset/);
    assert.deepEqual(world.leftovers(), []);
    // A file that is not a database at all is treated the same way rather than thrown at the caller.
    const garbage = workspace();
    writeFileSync(garbage.dbPath, Buffer.from("this is not a sqlite file at all", "utf8"));
    const reset = open({ dbPath: garbage.dbPath });
    assert.deepEqual([readIds(reset.db), reset.recoveries[0]?.outcome], [[], "reset"]);
    reset.db.close();
    assert.deepEqual(garbage.leftovers(), []);
    assert.equal(garbage.names().length, 2);
  });

  it("installs again without quarantining anything the second time", () => {
    const world = workspace();
    writeBlobs(world.dbPath, [["a", 8]], CONVERSATION_BLOB_ADOPTION_COMPLETE);
    damageFrom(world.dbPath, 0.02);
    const first = open({ dbPath: world.dbPath });
    first.db.close();
    const quarantinesAfterFirst = world.names().filter((name) => name.includes(".corrupt-"));
    const second = open({ dbPath: world.dbPath });
    assert.deepEqual(readIds(second.db), []);
    second.db.close();
    assert.deepEqual([second.seen, second.recoveries, world.names().filter((name) => name.includes(".corrupt-"))], [[], [], quarantinesAfterFirst]);
  });

  it("hands back a working database even when the recovery it reported could not be delivered", () => {
    const world = workspace();
    writeBlobs(world.dbPath, [["a", 64]], CONVERSATION_BLOB_ADOPTION_COMPLETE);
    damageFrom(world.dbPath, 0.02);
    const { db, recoveries } = open({ dbPath: world.dbPath, onRecoveryThrows: true });
    assert.equal(recoveries.length, 1);
    assert.deepEqual(readIds(db), []);
    assert.equal(runQuickCheck(db), "healthy");
    db.close();
  });
});

describe("finishing a rebuild that was interrupted", () => {
  it("takes up the replacement a rebuild left ready", () => {
    const world = workspace();
    writeBlobs(`${world.dbPath}.replacement`, [["completed", 8]], CONVERSATION_BLOB_RECOVERY_REBUILT);
    writeFileSync(`${world.dbPath}.pending`, "");
    const { db, seen, recoveries } = open({ dbPath: world.dbPath });
    assert.deepEqual(readIds(db), ["completed"]);
    assert.equal(readVersion(db), CONVERSATION_BLOB_RECOVERY_REBUILT);
    db.close();
    // Nothing to report: the rebuild had already said what it was doing, and this just finished it.
    assert.deepEqual([seen, recoveries], [[], []]);
    assert.deepEqual(world.interesting(), ["conversation-blobs.db"]);
  });

  it("throws away a replacement no rebuild is waiting for", () => {
    const world = workspace();
    writeBlobs(`${world.dbPath}.replacement`, [["orphan", 8]], CONVERSATION_BLOB_RECOVERY_REBUILT);
    const { db } = open({ dbPath: world.dbPath });
    // The orphan is not installed: a conversation starts empty rather than adopting a file nobody vouched for.
    assert.deepEqual([readIds(db), readVersion(db)], [[], CONVERSATION_BLOB_MIGRATION_UNSTARTED]);
    db.close();
    assert.deepEqual(world.interesting(), ["conversation-blobs.db"]);
  });

  it("does not adopt a replacement whose state nobody recognises", () => {
    const world = workspace();
    writeBlobs(`${world.dbPath}.replacement`, [["carried-over", 8]], CONVERSATION_BLOB_MIGRATION_UNSTARTED);
    writeFileSync(`${world.dbPath}.pending`, "");
    const { db, recoveries } = open({ dbPath: world.dbPath });
    // The row is carried over into a rebuilt database rather than the replacement being taken at its word.
    assert.deepEqual([readIds(db), readVersion(db)], [["carried-over"], CONVERSATION_BLOB_RECOVERY_REBUILT]);
    db.close();
    assert.deepEqual(recoveries.map((info) => [info.outcome, info.salvagedBlobs]), [["recovered", 1]]);
    assert.deepEqual(recoveries[0]?.quarantinePath?.endsWith(".replacement"), true);
    // The file it was salvaged from is what is kept aside, under the name it already had.
    assert.deepEqual(world.names(), ["conversation-blobs.db", "conversation-blobs.db.replacement"]);
  });

  it("recovers the conversation itself when the replacement a rebuild left is no good", () => {
    const world = workspace();
    writeBlobs(world.dbPath, [["survivor", 8]], CONVERSATION_BLOB_ADOPTION_COMPLETE);
    damageFrom(world.dbPath, 0.02);
    writeFileSync(`${world.dbPath}.corrupt-2026-01-01T00-00-00-000Z.pending`, "");
    writeFileSync(`${world.dbPath}.corrupt-2026-01-01T00-00-00-000Z.replacement`, Buffer.from("not a database", "utf8"));
    const { db, recoveries } = open({ dbPath: world.dbPath });
    assert.deepEqual(readIds(db), []);
    assert.equal(readVersion(db), CONVERSATION_BLOB_RECOVERY_REBUILT);
    db.close();
    // The damaged conversation is kept aside under the name the interrupted rebuild had already chosen for it.
    assert.deepEqual(recoveries.map((info) => [info.outcome, info.quarantinePath?.endsWith(".corrupt-2026-01-01T00-00-00-000Z")]), [["reset", true]]);
    assert.deepEqual(world.interesting(), ["conversation-blobs.db", "conversation-blobs.db.corrupt-2026-01-01T00-00-00-000Z"]);
  });
});
