import assert from "node:assert/strict";
import { lstatSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  AGENT_STORE_CONFLICT_EVENTS_FILE_NAME,
  AGENT_STORE_CONFLICT_PENDING_FILE_NAME,
  AGENT_STORE_SYNC_DIR_NAME,
  AgentStorePathError,
  assertNoSymlinkInPath,
  classifyAgentStoreSourceId,
  ensureSecureDirectoryChain,
  isReservedRelPath,
  isReservedRelPathSegment,
} from "../../source/packages/agent-store-sync/paths.ts";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-store-paths-"));
  roots.push(root);
  return root;
}
after(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("agent store paths", () => {
  it("knows which path segments are reserved for the platform", () => {
    assert.equal(AGENT_STORE_SYNC_DIR_NAME, ".sync");
    assert.equal(AGENT_STORE_CONFLICT_EVENTS_FILE_NAME, "conflict-events.jsonl");
    assert.equal(AGENT_STORE_CONFLICT_PENDING_FILE_NAME, "conflict-events.pending.jsonl");
    assert.equal(isReservedRelPath(".slate/notes.txt"), true);
    assert.equal(isReservedRelPath("a/.SLATE/b"), true);
    assert.equal(isReservedRelPath("a/b"), false);
    assert.equal(isReservedRelPathSegment(".slate"), true);
    assert.equal(isReservedRelPathSegment(".slateless"), true);
    assert.equal(isReservedRelPathSegment(".late"), false);
  });

  it("classifies the source ids a store can be addressed by", () => {
    assert.equal(classifyAgentStoreSourceId("u1"), "user");
    assert.equal(classifyAgentStoreSourceId("t2-u3"), "user");
    assert.equal(classifyAgentStoreSourceId("t4"), "team");
    assert.equal(classifyAgentStoreSourceId("bc-" + UUID), "cloud");
    assert.equal(classifyAgentStoreSourceId(UUID), "local");
    assert.equal(classifyAgentStoreSourceId("store-" + UUID), "store");
    assert.equal(classifyAgentStoreSourceId("store-" + "a".repeat(24)), "store");
    assert.equal(classifyAgentStoreSourceId("nonsense"), "unknown");
  });

  it("describes a refused path with a code and the path it refused", () => {
    const failure = new AgentStorePathError({ code: "not_directory", message: "not a directory", failedPath: "/tmp/x" });
    assert.equal(failure instanceof Error, true);
    assert.equal(failure.name, "AgentStorePathError");
    assert.equal(failure.code, "not_directory");
    assert.equal(failure.failedPath, "/tmp/x");
    assert.equal(failure.message, "not a directory");
  });

  it("accepts a real chain and refuses a symlinked one", () => {
    const root = freshRoot();
    const real = join(root, "real", "dir");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "file.txt"), "x");
    assert.doesNotThrow(() => assertNoSymlinkInPath(join(real, "file.txt")));
    // A path that does not exist yet stops the check at the missing segment.
    assert.doesNotThrow(() => assertNoSymlinkInPath(join(root, "missing", "file.txt")));
    symlinkSync(real, join(root, "link"));
    assert.throws(
      () => assertNoSymlinkInPath(join(root, "link", "file.txt")),
      (failure: unknown) => failure instanceof AgentStorePathError && failure.code === "symlink_refused",
    );
  });

  it("creates a private directory chain under a trusted base", () => {
    const root = freshRoot();
    const base = join(root, "base");
    mkdirSync(base);
    const target = join(base, "one", "two");
    ensureSecureDirectoryChain(target, { trustedBase: base });
    assert.doesNotThrow(() => ensureSecureDirectoryChain(target, { trustedBase: base }));
    assert.equal(statSync(target).mode & 0o777, 0o700);
    // The trusted base itself must already exist and be a directory.
    assert.throws(
      () => ensureSecureDirectoryChain(join(root, "missing-base"), { trustedBase: join(root, "missing-base") }),
      (failure: unknown) => failure instanceof AgentStorePathError && failure.code === "not_directory",
    );
  });

  it("refuses to create outside the trusted base", () => {
    const root = freshRoot();
    const base = join(root, "base");
    mkdirSync(base);
    assert.throws(
      () => ensureSecureDirectoryChain(join(root, "sibling", "child"), { trustedBase: base }),
      (failure: unknown) => failure instanceof AgentStorePathError && failure.code === "invalid_store_base",
    );
    // A file where a directory is needed is refused as well.
    writeFileSync(join(base, "a-file"), "x");
    assert.throws(
      () => ensureSecureDirectoryChain(join(base, "a-file", "child"), { trustedBase: base }),
      (failure: unknown) => failure instanceof AgentStorePathError && failure.code === "not_directory",
    );
  });

  it("refuses a directory that cannot be created", () => {
    const root = freshRoot();
    const base = join(root, "base");
    mkdirSync(base);
    const target = join(base, "would-be");
    const realStat = lstatSync;
    const fakeFs = {
      lstatSync(candidate: string) {
        if (candidate === base) return realStat(base);
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
      mkdirSync() {},
    };
    assert.throws(
      () => ensureSecureDirectoryChain(target, { trustedBase: base, fs: fakeFs as never }),
      (failure: unknown) => failure instanceof AgentStorePathError && failure.code === "not_directory",
    );
  });

  it("refuses a symlink inside the chain to be continued", () => {
    const root = freshRoot();
    const base = join(root, "base");
    const outside = join(root, "outside");
    mkdirSync(base);
    mkdirSync(outside);
    symlinkSync(outside, join(base, "linked"));
    assert.throws(
      () => ensureSecureDirectoryChain(join(base, "linked", "child"), { trustedBase: base }),
      (failure: unknown) => failure instanceof AgentStorePathError && failure.code === "symlink_refused",
    );
  });
});
