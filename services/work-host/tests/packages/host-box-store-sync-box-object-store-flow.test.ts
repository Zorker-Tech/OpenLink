import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  AgentStoreObjectStore,
  AgentStoreObjectStoreProvider,
  LocalFsObjectStore,
  LocalFsObjectStoreProvider,
  isUnderPrefix,
  resolveBoxObjectStoreProvider,
  walkFiles,
} from "../../source/host/boxes/box-store-sync/box-object-store.ts";
import { AgentStoreMutableWriteEtags } from "../../source/host/boxes/box-store-sync/agent-store-slate-files.ts";
import { BoxStoreSyncError } from "../../source/host/boxes/box-store-sync/box-store-sync-error.ts";

const temporaryDirectory = () => mkdtempSync(join(tmpdir(), "box-object-store-"));

describe("a store as a plain directory", () => {
  it("writes and reads bytes, and answers nothing for a missing key", async () => {
    const root = temporaryDirectory();
    try {
      const store = new LocalFsObjectStore(root);
      await store.put("a/b.txt", new Uint8Array([1, 2, 3]));
      assert.deepEqual(Array.from((await store.get("a/b.txt")) ?? []), [1, 2, 3]);
      assert.equal(await store.get("missing.txt"), null);
      assert.equal(store.pathFor("a/b.txt"), join(root, "a", "b.txt"));
      assert.equal(new LocalFsObjectStoreProvider("/tmp/base").forStore("store-1").root, join("/tmp/base", "store-1"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("copies to a file, refusing an object over the cap before reading it", async () => {
    const root = temporaryDirectory();
    try {
      const store = new LocalFsObjectStore(root);
      await store.put("five.bin", new Uint8Array(5));
      const destination = join(root, "out", "five.bin");
      assert.equal(await store.getToFile("five.bin", destination), 5);
      assert.deepEqual(Array.from(readFileSync(destination)), [0, 0, 0, 0, 0]);
      assert.equal(await store.getToFile("missing.bin", join(root, "out", "x")), null);
      assert.equal(await store.getToFile("five.bin", join(root, "out", "y"), { maxBytes: 5 }), 5);
      await assert.rejects(() => store.getToFile("five.bin", join(root, "out", "z"), { maxBytes: 4 }), { name: "BoxStoreSyncError", message: "object five.bin is 5B over the 4B cap" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("lists the files under a prefix, in order, without following links", async () => {
    const root = temporaryDirectory();
    try {
      const store = new LocalFsObjectStore(root);
      await store.put("a/b.txt", new Uint8Array(1));
      await store.put("a/c/d.txt", new Uint8Array(1));
      await store.put("ab.txt", new Uint8Array(1));
      await store.put("z.txt", new Uint8Array(1));
      mkdirSync(join(root, "empty"));
      symlinkSync(join(root, "z.txt"), join(root, "link.txt"));
      assert.deepEqual(await store.list(""), ["a/b.txt", "a/c/d.txt", "ab.txt", "z.txt"]);
      assert.deepEqual(await store.list("a"), ["a/b.txt", "a/c/d.txt"]);
      assert.deepEqual(await store.list("a/"), ["a/b.txt", "a/c/d.txt"]);
      assert.deepEqual(await store.list("ab"), [], "a prefix names a directory, never a partial name");
      assert.deepEqual(await store.list("nothing"), []);
      // Written in reverse so the listing order is only the platform readdir order.
      for (const name of ["z.txt", "y.txt", "x.txt", "w.txt", "v.txt", "u.txt", "t.txt", "s.txt", "r.txt", "q.txt", "p.txt", "o.txt", "n.txt", "m.txt", "l.txt", "k.txt", "j.txt", "i.txt", "h.txt", "g.txt", "f.txt", "e.txt", "d.txt", "c.txt", "b.txt", "a.txt"]) await store.put(name, new Uint8Array(1));
      assert.deepEqual(await store.list(""), ["a.txt", "a/b.txt", "a/c/d.txt", "ab.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt", "h.txt", "i.txt", "j.txt", "k.txt", "l.txt", "m.txt", "n.txt", "o.txt", "p.txt", "q.txt", "r.txt", "s.txt", "t.txt", "u.txt", "v.txt", "w.txt", "x.txt", "y.txt", "z.txt"]);
      const found: string[] = [];
      await walkFiles(root, found);
      assert.equal(found.some((path) => path.endsWith("link.txt")), false, "a link is not followed");
      const missing: string[] = [];
      await walkFiles(join(root, "not-there"), missing);
      assert.deepEqual(missing, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("deletes a key, and a key that is not there is already deleted", async () => {
    const root = temporaryDirectory();
    try {
      const store = new LocalFsObjectStore(root);
      await store.put("gone.txt", new Uint8Array(1));
      await store.delete("gone.txt");
      assert.equal(await store.get("gone.txt"), null);
      await store.delete("never-there.txt");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("matches keys under a directory prefix, never a partial name", () => {
    assert.equal(isUnderPrefix("a/b", ""), true);
    assert.equal(isUnderPrefix("a/b", "a"), true);
    assert.equal(isUnderPrefix("a/b", "a/"), true);
    assert.equal(isUnderPrefix("a/b", "a//"), true);
    assert.equal(isUnderPrefix("ab", "a"), false);
    assert.equal(isUnderPrefix("a", "a"), false);
    assert.equal(isUnderPrefix("a/b", "a/b"), false);
  });
});

describe("the policy that picks a store", () => {
  it("uses a local directory when one is configured", () => {
    const provider = resolveBoxObjectStoreProvider({ env: { SLATE_BOX_STORE_LOCAL_DIR: "/tmp/local-store" }, agentStore: {} });
    assert.equal(provider instanceof LocalFsObjectStoreProvider, true);
    assert.equal((provider as LocalFsObjectStoreProvider).baseDir, "/tmp/local-store");
    assert.equal(resolveBoxObjectStoreProvider({ env: { SLATE_BOX_STORE_LOCAL_DIR: "relative/dir" }, agentStore: {} }) instanceof LocalFsObjectStoreProvider, false, "a relative directory is not a store");
  });

  it("asks the platform's own store for its backend auth, and falls back to the agent store", () => {
    assert.throws(() => resolveBoxObjectStoreProvider({ env: { SLATE_BOX_STORE_BACKEND: "v2" }, agentStore: {} }), { name: "SlateInvariantViolation" });
    assert.throws(() => resolveBoxObjectStoreProvider({ env: { SLATE_BOX_STORE_BACKEND: "v2" }, agentStore: { getAccessToken: () => "token", getMachineId: () => "machine" } }), { name: "BoxStoreSyncError" }, "this host does not build the backend transport yet");
    assert.equal(resolveBoxObjectStoreProvider({ env: {}, agentStore: {} }) instanceof AgentStoreObjectStoreProvider, true);
  });

  it("builds one agent-store client, and shares the write etags across its stores", () => {
    const client = { presignReads: async () => [], presignWrites: async () => [], listFiles: async () => ({ files: [] }) };
    const provider = new AgentStoreObjectStoreProvider({ client: client as never });
    const first = provider.forStore("store-1") as AgentStoreObjectStore;
    const second = provider.forStore("store-2") as AgentStoreObjectStore;
    assert.equal(first.client, client as never);
    assert.deepEqual([first.storeId, second.storeId], ["store-1", "store-2"]);
    assert.equal(first.mutableEtags, second.mutableEtags);
    assert.equal(first.mutableEtags instanceof AgentStoreMutableWriteEtags, true);
  });

  it("refuses to delete from the append-only agent store", async () => {
    const store = new AgentStoreObjectStore({} as never, "store-1", new AgentStoreMutableWriteEtags());
    await assert.rejects(() => store.delete("some/key"), { name: "SlateInvariantViolation" });
  });
});