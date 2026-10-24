import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_DIR_MANIFEST_KEY_RE,
  AGENT_STORE_DB_BASENAMES,
  BoxStoreManifestPathConflictError,
  BoxStoreManifestRevisionState,
  BoxStoreManifestStore,
  BoxStoreUnsupportedManifestVersionError,
  STORE_DB_MANIFEST_KEY_RE,
  countAgentDirManifestEntries,
  countStoreDbManifestEntries,
  getStoreDbManifestAgentIds,
  hasManifestPathConflict,
  parseManifest,
} from "../../source/host/boxes/box-store-sync/box-store-manifest.ts";
import { BOX_STORE_MANIFEST_REL_PATH, BOX_STORE_MANIFEST_VERSION } from "../../source/host/boxes/box-store-sync/box-store-manifest-format.ts";
import { BoxStoreCanonicalWriteConflictError } from "../../source/host/boxes/box-store-sync/object-store-port.ts";
import { BoxStoreSyncError } from "../../source/host/boxes/box-store-sync/box-store-sync-error.ts";

const fileEntry = (sha: string, size: number, mode = 0o644) => ({ kind: "file" as const, sha, size, mode });
const legacyEntry = (sha: string, size: number) => ({ sha, size });
const symlinkEntry = (target: string) => ({ kind: "symlink" as const, target });
const documentText = (entries: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, updatedAtMs: 5, writerWindowId: "w", entries, ...extra });
const bytesOf = (text: string) => new TextEncoder().encode(text);
function fakeObjectStore() {
  const store = new Map<string, Uint8Array>();
  const calls: string[] = [];
  let conflict: Error | null = null;
  return {
    store, calls,
    failNextPut(error: Error) { conflict = error; },
    async get(key: string) { calls.push("get"); return store.get(key) ?? null; },
    async put(key: string, content: Uint8Array) { calls.push("put"); if (conflict != null) { const error = conflict; conflict = null; throw error; } store.set(key, content); },
    async list() { return []; },
    async delete(key: string) { store.delete(key); },
  };
}
function makeStore(options: { objectStore?: ReturnType<typeof fakeObjectStore>; markerPath?: string; disposed?: boolean } = {}) {
  const objectStore = options.objectStore ?? fakeObjectStore();
  const logs: string[] = [];
  const conflicts: Array<Record<string, unknown>> = [];
  const store = new BoxStoreManifestStore({
    deps: {
      objectStoreProvider: { forStore: () => objectStore },
      async resolveStoreId() { return "store-1"; },
      manifestRetry: { async runWithRetry(work: (attempt: number) => Promise<unknown>) { return work(1); } },
      manifestV2: false,
      windowId: "w",
      ...(options.markerPath === undefined ? {} : { hydrationHandoffMarkerPath: options.markerPath }),
      onManifestWriteConflict: (info: Record<string, unknown>) => conflicts.push(info),
    } as never,
    now: () => 1000,
    log: (message: string) => logs.push(message),
    isDisposed: () => options.disposed ?? false,
  });
  return { store, objectStore, logs, conflicts };
}

test("the manifest words are the protocol's", () => {
  assert.deepEqual(AGENT_STORE_DB_BASENAMES, ["store.db", "conversation-blobs.db"]);
  assert.match("home/box/slate-data/agents/a/store.db", STORE_DB_MANIFEST_KEY_RE);
  assert.match("home/box/slate-data/agents/a/anything", AGENT_DIR_MANIFEST_KEY_RE);
  assert.equal(BOX_STORE_MANIFEST_VERSION, 2);
});

test("the count helpers see stores, agent directories and symlinks", () => {
  const entries = new Map<string, unknown>([
    ["home/box/slate-data/agents/a/store.db", legacyEntry("s1", 3)],
    ["home/box/slate-data/agents/b/store.db", symlinkEntry("/x")],
    ["home/box/slate-data/agents/a/file.txt", legacyEntry("s2", 4)],
    ["home/box/slate-data/agents/c/nested/store.db", legacyEntry("s3", 5)],
    ["home/box/slate-data/agents/c/other/store.db", legacyEntry("s4", 6)],
  ]);
  assert.equal(countStoreDbManifestEntries(entries), 1);
  assert.equal(countStoreDbManifestEntries(null), 0);
  assert.deepEqual([...getStoreDbManifestAgentIds(entries)], ["a"]);
  assert.equal(countAgentDirManifestEntries(entries), 3);
  assert.equal(countAgentDirManifestEntries(undefined), 0);
});

test("a manifest is refused unless it is a known version with valid paths", () => {
  assert.equal(parseManifest(bytesOf("not json")), null);
  const valid = parseManifest(bytesOf(documentText({ "file.txt": legacyEntry("s", 1) })));
  assert.deepEqual(valid, { version: 1, updatedAtMs: 5, writerWindowId: "w", entries: { "file.txt": legacyEntry("s", 1) } });
  const blocked: string[] = [];
  assert.throws(() => parseManifest(bytesOf(JSON.stringify({ version: 9, entries: {} })), (error) => blocked.push(error instanceof BoxStoreUnsupportedManifestVersionError ? "unsupported" : "other")), BoxStoreUnsupportedManifestVersionError);
  assert.throws(() => parseManifest(bytesOf(documentText({ "a": legacyEntry("s", 1), "a/b": legacyEntry("t", 2) })), (error) => blocked.push(error instanceof BoxStoreManifestPathConflictError ? "conflict" : "other")), (error: unknown) => error instanceof BoxStoreManifestPathConflictError && (error as Error).message === "box store manifest contains conflicting node paths");
  assert.deepEqual(blocked, ["unsupported", "conflict"]);
  assert.equal(hasManifestPathConflict({ "plain": legacyEntry("s", 1) }), false);
});

test("the revision state captures only writes worth making", () => {
  const state = new BoxStoreManifestRevisionState();
  const manifest = new Map([["file", legacyEntry("s", 1)]]);
  assert.equal(state.revision, 0);
  assert.equal(state.snapshotConstructionCount, 0);
  const first = state.capture(manifest, true, false);
  assert.notEqual(first, null);
  assert.equal(first?.revision, 0);
  assert.equal(state.hasPendingWriteForRevision, true);
  // A second capture for the same revision is not worth making while the first is in flight.
  assert.equal(state.capture(manifest, true, false), null);
  // A required write is made anyway.
  assert.notEqual(state.capture(manifest, true, true), null);
  state.markPersisted(first!, true);
  state.release(first!);
  // Once persisted and released, an unchanged capture is a no-op.
  assert.equal(state.capture(manifest, true, false), null);
  assert.equal(state.snapshotConstructionCount, 2);
  state.markChanged();
  assert.equal(state.revision, 1);
  assert.equal(state.persistedRevision, 0);
  state.markFailed();
  assert.equal(state.persistedRevision, undefined);
});

test("entries are configured for the legacy format", () => {
  const { store } = makeStore();
  assert.equal(store.configuredManifestVersion(), 1);
  assert.deepEqual(store.configuredEntry(fileEntry("s", 2, 0o600)), { sha: "s", size: 2 });
  assert.equal(store.configuredEntry(symlinkEntry("/t")), undefined);
  assert.deepEqual(store.configuredEntries({ a: fileEntry("s", 2), b: symlinkEntry("/t") }), { a: { sha: "s", size: 2 } });
  store.enrollManifestV2();
  assert.equal(store.configuredManifestVersion(), 2);
  assert.deepEqual(store.configuredEntry(symlinkEntry("/t")), symlinkEntry("/t"));
});

test("entries are set and conflicting paths removed", () => {
  const { store } = makeStore();
  const manifest = new Map<string, ReturnType<typeof legacyEntry>>();
  store.initializeManifestRevision(manifest);
  assert.equal(store.setManifestEntry(manifest, "dir/file", fileEntry("a", 1)), true);
  assert.deepEqual([...manifest.keys()], ["dir/file"]);
  assert.equal(store.setManifestEntry(manifest, "dir", fileEntry("b", 2)), true);
  assert.deepEqual([...manifest.keys()], ["dir"]);
  assert.equal(store.setManifestEntry(manifest, "dir/sub", fileEntry("c", 3)), true);
  assert.deepEqual([...manifest.keys()], ["dir/sub"]);
  // The same entry again is not a change.
  assert.equal(store.setManifestEntry(manifest, "dir/sub", fileEntry("c", 3)), false);
  assert.equal(store.deleteManifestEntry(manifest, "dir/sub"), true);
  assert.equal(store.deleteManifestEntry(manifest, "missing"), false);
  assert.equal(store.manifestRevisionState(manifest).revision, 6);
});

test("a manifest is loaded, saved once and strictly read", async () => {
  const objectStore = fakeObjectStore();
  objectStore.store.set(BOX_STORE_MANIFEST_REL_PATH, bytesOf(documentText({ "file.txt": legacyEntry("s", 1) })));
  const { store } = makeStore({ objectStore });
  const loaded = await store.loadManifest("store-1");
  assert.deepEqual([...loaded.keys()], ["file.txt"]);
  assert.equal(store.fullyHydrated, undefined);
  loaded.set("second.txt", legacyEntry("t", 2));
  store.manifestRevisionState(loaded).markChanged();
  await store.saveManifest("store-1");
  const writes = objectStore.calls.filter((call) => call === "put").length;
  const saved = JSON.parse(Buffer.from(objectStore.store.get(BOX_STORE_MANIFEST_REL_PATH)!).toString("utf8"));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.entries, { "file.txt": { sha: "s", size: 1 }, "second.txt": { sha: "t", size: 2 } });
  await store.saveManifest("store-1");
  assert.equal(objectStore.calls.filter((call) => call === "put").length, writes);
  const strict = await store.readManifestStrictDetailed();
  assert.deepEqual({ present: strict.present, entries: [...strict.manifest.keys()].sort() }, { present: true, entries: ["file.txt", "second.txt"] });
});

test("a manifest that is not there is absent and one that is unparseable throws", async () => {
  const missing = await makeStore().store.readManifestStrictDetailed();
  assert.deepEqual({ present: missing.present, entries: [...missing.manifest.keys()] }, { present: false, entries: [] });
  const objectStore = fakeObjectStore();
  objectStore.store.set(BOX_STORE_MANIFEST_REL_PATH, bytesOf("not json"));
  await assert.rejects(() => makeStore({ objectStore }).store.readManifestStrict(), (error: unknown) => error instanceof BoxStoreSyncError && /present but unparseable/.test((error as Error).message));
});

test("a lost write race is reported with what the winner wrote", async () => {
  const objectStore = fakeObjectStore();
  const { store, conflicts } = makeStore({ objectStore });
  const manifest = new Map<string, ReturnType<typeof legacyEntry>>();
  store.initializeManifestRevision(manifest);
  store.setManifestEntry(manifest, "file.txt", fileEntry("s", 1));
  store.manifest = manifest;
  objectStore.store.set(BOX_STORE_MANIFEST_REL_PATH, bytesOf(JSON.stringify({ version: 1, updatedAtMs: 1, writerWindowId: "other", entries: { "file.txt": { sha: "other", size: 9 } } })));
  objectStore.failNextPut(new BoxStoreCanonicalWriteConflictError({ key: BOX_STORE_MANIFEST_REL_PATH, conflictRelPath: "lost.json" }));
  await assert.rejects(() => store.saveManifest("store-1", { acceptMatchingCanonicalOnConflict: true, isForced: true }), (error: unknown) => error instanceof BoxStoreCanonicalWriteConflictError && (error as Error).message.includes("lost.json"));
  assert.equal(conflicts.length, 1);
  assert.deepEqual({ accepted: conflicts[0]?.accepted, covered: conflicts[0]?.covered, canonicalMatchesAttempt: conflicts[0]?.canonicalMatchesAttempt, attemptedEntries: conflicts[0]?.attemptedEntries }, { accepted: false, covered: false, canonicalMatchesAttempt: false, attemptedEntries: 1 });
  assert.equal(conflicts[0]?.canonicalEntryCount, 1);
});
test("a missing manifest while a hydration handoff is pending is an error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slate-manifest-handoff-"));
  const markerPath = join(directory, "handoff");
  writeFileSync(markerPath, "");
  try {
    const { store } = makeStore({ markerPath });
    await assert.rejects(() => store.loadManifest("store-1"), (error: unknown) => error instanceof BoxStoreSyncError && /manifest missing while legacy hydration handoff is pending/.test((error as Error).message));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
