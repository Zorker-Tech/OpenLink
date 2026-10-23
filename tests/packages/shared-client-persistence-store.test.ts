import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX,
  CLIENT_PERSISTENCE_MAX_TOTAL_BYTES,
  CLIENT_PERSISTENCE_MAX_VALUE_BYTES,
  CLIENT_PERSISTENCE_MIGRATION_MARKER_FILENAME,
  ClientPersistenceCapError,
  SlateClientPersistenceStore,
  clientPersistenceFileNameFor,
  decodeClientPersistenceFileName,
  encodeClientPersistenceFileName,
  type ClientPersistenceFiles,
} from "../../source/shared/client-persistence-store.ts";

class FakeFiles implements ClientPersistenceFiles {
  readonly entries = new Map<string, string>();
  readonly calls: string[] = [];
  failList = false;
  failRead = false;
  failSize = false;
  failRename = false;
  joinPath(dir: string, name: string) { return dir + "/" + name; }
  async ensureDir(dir: string) { this.calls.push("ensure " + dir); }
  async listFiles(dir: string) {
    this.calls.push("list");
    if (this.failList) throw new Error("cannot list");
    return [...this.entries.keys()].filter((path) => path.startsWith(dir + "/")).map((path) => path.slice(dir.length + 1));
  }
  async readTextFile(path: string) {
    this.calls.push("read " + path);
    if (this.failRead) throw new Error("cannot read");
    const value = this.entries.get(path);
    if (value === undefined) throw new Error("missing");
    return value;
  }
  async writeTextFile(path: string, data: string) { this.calls.push("write " + path); this.entries.set(path, data); }
  async rename(from: string, to: string) {
    this.calls.push("rename");
    if (this.failRename) throw new Error("cannot rename");
    const value = this.entries.get(from);
    if (value === undefined) throw new Error("missing");
    this.entries.delete(from);
    this.entries.set(to, value);
  }
  async removeFile(path: string) { this.calls.push("remove " + path); this.entries.delete(path); }
  async fileSize(path: string) {
    if (this.failSize) throw new Error("cannot stat");
    const value = this.entries.get(path);
    return value === undefined ? null : new TextEncoder().encode(value).length;
  }
}
const dirOf = (files: FakeFiles) => files.joinPath("/store", "agent-1");
const makeStore = (files: FakeFiles, caps: { maxValueBytes?: number; maxTotalBytes?: number } = {}) =>
  new SlateClientPersistenceStore(dirOf(files), files, caps);

test("a key is encoded into a file name and decoded back", () => {
  for (const key of ["slate.draft", "slate.layout.panel", "slate.日本語", "slate." + "a".repeat(120)]) {
    const name = encodeClientPersistenceFileName(key);
    assert.equal(name.endsWith(".blob"), true);
    assert.equal(decodeClientPersistenceFileName(name), key);
  }
});

test("a file name that is not one of the store's is refused", () => {
  assert.equal(decodeClientPersistenceFileName("not-a-blob"), null);
  assert.equal(decodeClientPersistenceFileName(".blob"), null);
  assert.equal(decodeClientPersistenceFileName("!!!!.blob"), null);
  assert.equal(decodeClientPersistenceFileName("a.blob"), null);
  assert.equal(decodeClientPersistenceFileName(encodeClientPersistenceFileName("other.key")), null);
});

test("a file name is only offered for a key in the namespace and of a storable length", () => {
  assert.equal(clientPersistenceFileNameFor("slate.draft"), encodeClientPersistenceFileName("slate.draft"));
  assert.equal(clientPersistenceFileNameFor("not-slate.draft"), null);
  assert.equal(clientPersistenceFileNameFor("slate." + "a".repeat(300)), null);
});

test("a value is written, read, listed and removed by key", async () => {
  const files = new FakeFiles();
  const store = makeStore(files);
  assert.equal(await store.read("slate.draft"), null);
  await store.write("slate.draft", "draft text");
  assert.equal(await store.read("slate.draft"), "draft text");
  await store.write("slate.layout", "layout text");
  assert.deepEqual((await store.listKeys("slate.")).sort(), ["slate.draft", "slate.layout"]);
  assert.deepEqual(await store.listKeys("slate.dr"), ["slate.draft"]);
  await store.remove("slate.draft");
  assert.equal(await store.read("slate.draft"), null);
  await store.remove("slate.never-there");
  assert.deepEqual(await store.listKeys("slate."), ["slate.layout"]);
});

test("a key outside the namespace is refused rather than stored", async () => {
  const files = new FakeFiles();
  const store = makeStore(files);
  assert.throws(() => store.read("outside.key"), /outside the "slate." namespace/);
  assert.throws(() => store.write("outside.key", "x"), /outside the "slate." namespace/);
  assert.throws(() => store.remove("outside.key"), /outside the "slate." namespace/);
});

test("a value over the per-key cap is refused", async () => {
  const files = new FakeFiles();
  const store = makeStore(files, { maxValueBytes: 4 });
  await store.write("slate.small", "four");
  await assert.rejects(() => store.write("slate.big", "five!"), (error: unknown) =>
    error instanceof ClientPersistenceCapError && /per-key size cap/.test((error as Error).message));
});

test("the store's total size is capped, and an overwrite does not double-count", async () => {
  const files = new FakeFiles();
  const store = makeStore(files, { maxTotalBytes: 6 });
  await store.write("slate.a", "aaa");
  await store.write("slate.b", "bbb");
  await assert.rejects(() => store.write("slate.c", "c"), ClientPersistenceCapError);
  await store.write("slate.a", "a");
  await store.write("slate.c", "cc");
});

test("the ledger is read once and remembers what it saw", async () => {
  const files = new FakeFiles();
  const store = makeStore(files);
  await store.write("slate.draft", "text");
  const listCalls = files.calls.filter((call) => call === "list").length;
  await store.read("slate.draft");
  await store.listKeys("slate.");
  assert.equal(files.calls.filter((call) => call === "list").length, listCalls);
});

test("temporary files are cleaned away when the ledger is first read", async () => {
  const files = new FakeFiles();
  const name = clientPersistenceFileNameFor("slate.tmp") as string;
  files.entries.set(dirOf(files) + "/" + name + ".tmp", "half");
  const store = makeStore(files);
  assert.deepEqual(await store.listKeys("slate."), []);
  assert.equal(files.entries.has(dirOf(files) + "/" + name + ".tmp"), false);
});

test("an unreadable folder is an empty store and an unreadable file reads as missing", async () => {
  const files = new FakeFiles();
  files.failList = true;
  const empty = makeStore(files);
  assert.deepEqual(await empty.listKeys("slate."), []);
  // A list that failed before the ledger learned of a write stays empty until that write records itself.
  await empty.write("slate.draft", "text");
  assert.equal(await empty.read("slate.draft"), "text");
  const readable = new FakeFiles();
  const store = makeStore(readable);
  await store.write("slate.draft", "text");
  readable.failRead = true;
  assert.equal(await store.read("slate.draft"), null);
});

test("a blob whose size cannot be read is left out of the ledger", async () => {
  const files = new FakeFiles();
  const name = clientPersistenceFileNameFor("slate.draft") as string;
  files.entries.set(dirOf(files) + "/" + name, "text");
  files.failSize = true;
  const store = makeStore(files);
  assert.deepEqual(await store.listKeys("slate."), []);
});

test("a migration runs once and marks itself done", async () => {
  const files = new FakeFiles();
  const store = makeStore(files);
  assert.equal(await store.hasCompletedOneShotMigration(), false);
  const migrated = await store.migrateFromLocalStorage([
    { key: "slate.draft", value: "draft text" },
    { key: "slate.layout", value: "layout text" },
  ]);
  assert.equal(migrated, true);
  assert.equal(await store.read("slate.draft"), "draft text");
  assert.equal(await store.hasCompletedOneShotMigration(), true);
  const markerPath = files.joinPath(dirOf(files), CLIENT_PERSISTENCE_MIGRATION_MARKER_FILENAME);
  assert.equal(typeof files.entries.get(markerPath), "string");
  assert.equal(await store.migrateFromLocalStorage([{ key: "slate.draft", value: "changed" }]), true);
  assert.equal(await store.read("slate.draft"), "draft text");
});

test("a migration skips what cannot be stored and keeps what it can", async () => {
  const files = new FakeFiles();
  const store = makeStore(files, { maxValueBytes: 4 });
  files.entries.set(files.joinPath(dirOf(files), clientPersistenceFileNameFor("slate.present") as string), "old");
  const migrated = await store.migrateFromLocalStorage([
    { key: "slate.present", value: "new" },
    { key: "outside.namespace", value: "x" },
    { key: "slate.too-big", value: "five!" },
    { key: "slate.fine", value: "four" },
  ]);
  assert.equal(migrated, true);
  assert.equal(await store.read("slate.present"), "old");
  assert.equal(await store.read("slate.fine"), "four");
  assert.equal(await store.hasCompletedOneShotMigration(), true);
});

test("a migration that cannot write reports false and leaves no marker", async () => {
  const files = new FakeFiles();
  const store = makeStore(files);
  files.failRename = true;
  assert.equal(await store.migrateFromLocalStorage([{ key: "slate.draft", value: "text" }]), false);
  assert.equal(await store.hasCompletedOneShotMigration(), false);
});

test("writes are serialized behind each other", async () => {
  const files = new FakeFiles();
  const store = makeStore(files);
  await Promise.all([store.write("slate.a", "a"), store.write("slate.b", "b"), store.write("slate.c", "c")]);
  assert.deepEqual((await store.listKeys("slate.")).sort(), ["slate.a", "slate.b", "slate.c"]);
  const cappedStore = makeStore(files, { maxValueBytes: 4 });
  await assert.rejects(() => cappedStore.write("slate.d", "toolong"), ClientPersistenceCapError);
  await cappedStore.write("slate.e", "e");
  assert.equal((await cappedStore.listKeys("slate.")).includes("slate.d"), false);
  assert.equal((await cappedStore.listKeys("slate.")).includes("slate.e"), true);
});

test("the defaults are generous enough to store real slices", () => {
  assert.equal(CLIENT_PERSISTENCE_MAX_VALUE_BYTES, 8 * 1024 * 1024);
  assert.equal(CLIENT_PERSISTENCE_MAX_TOTAL_BYTES, 256 * 1024 * 1024);
  assert.equal(ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX, "slate.");
});


const ALPHABET_FOR_TEST = "abcdefghijklmnopqrstuvwxyz234567";
function encodeBytes(bytes: number[]): string {
  let body = "";
  let carry = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    carry = carry << 8 | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      body += ALPHABET_FOR_TEST[carry >>> bitCount - 5 & 31];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) body += ALPHABET_FOR_TEST[carry << 5 - bitCount & 31];
  return body;
}

test("a known key has a known file name", () => {
  assert.equal(encodeClientPersistenceFileName("slate.a"), "onwgc5dffzqq.blob");
  assert.equal(encodeClientPersistenceFileName("slate.draft"), "onwgc5dffzsheylgoq.blob");
  assert.equal(decodeClientPersistenceFileName("onwgc5dffzqq.blob"), "slate.a");
})

test("a name with the wrong suffix or an unknown symbol is refused", () => {
  assert.equal(decodeClientPersistenceFileName("onwgc5dffzqq"), null);
  assert.equal(decodeClientPersistenceFileName("onwgc5dffzqq!.blob"), null);
  // Any five characters can stand where the suffix belongs; the suffix itself must be the store's.
  assert.equal(decodeClientPersistenceFileName("onwgc5dffzqqxxxxx"), null);
})

test("a non-canonical name is refused", () => {
  // The last character of the real name has one padding bit; setting it must not decode.
  assert.equal(decodeClientPersistenceFileName("onwgc5dffzqr.blob"), null);
  const broken = encodeBytes([115, 108, 97, 116, 101, 46, 255]) + ".blob";
  assert.equal(decodeClientPersistenceFileName(broken), null);
})

test("a file name of a storable length is still offered", () => {
  assert.equal(clientPersistenceFileNameFor("slate." + "a".repeat(200)), null);
})

test("the cap error is named for callers", async () => {
  const store = makeStore(new FakeFiles(), { maxValueBytes: 1 });
  await assert.rejects(() => store.write("slate.x", "xx"), (error: unknown) =>
    error instanceof ClientPersistenceCapError && (error as Error).name === "ClientPersistenceCapError");
})

test("a migration that already ran does not migrate anything new", async () => {
  const files = new FakeFiles();
  const store = makeStore(files);
  assert.equal(await store.migrateFromLocalStorage([{ key: "slate.first", value: "one" }]), true);
  assert.equal(await store.migrateFromLocalStorage([{ key: "slate.second", value: "two" }]), true);
  assert.equal(await store.read("slate.second"), null);
})

test("files that are not the store's blobs are not counted", async () => {
  const files = new FakeFiles();
  files.entries.set(dirOf(files) + "/junk.foo", "junk");
  const store = makeStore(files);
  assert.deepEqual(await store.listKeys("slate."), [])
})

