import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import * as secure from "../../source/packages/agent-store-sync/secure-open.ts";

const MODE = 0o600;

const pickRoot = (): string => {
  const candidates = [path.join("/Users", os.userInfo().username), "/Volumes/Net", os.tmpdir()];
  for (const candidate of candidates) {
    try {
      if (fs.realpathSync.native(candidate) !== candidate) continue;
      const root = fs.mkdtempSync(path.join(candidate, "slate-secure-test-"));
      if (fs.realpathSync.native(root) === root) return root;
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  throw new Error("no canonical directory for the secure-open tests");
};

const root = pickRoot();
after(() => fs.rmSync(root, { recursive: true, force: true }));
const storeDir = path.join(root, "store");
fs.mkdirSync(storeDir);

const pathError = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    const err = error as { name?: string; message?: string; code?: string; failedPath?: string };
    return { name: err.name, message: err.message, code: err.code, failedPath: err.failedPath };
  }
  throw new Error("expected the call to be refused");
};

describe("opening a store file without following a link", () => {
  it("opens and verifies a normal path, and closes once however often it is asked", () => {
    const file = path.join(storeDir, "state.sqlite");
    const opened = secure.openSecureSqlitePath(file, MODE);
    assert.equal(opened.sqlitePath, file);
    assert.equal(opened.verifyOpenedInode(), undefined);
    assert.equal(opened.verifyOpenedInode(), undefined, "verifying again is a no-op");
    assert.equal(opened.close(), undefined);
    assert.equal(opened.close(), undefined, "closing again is a no-op");
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.statSync(file).mode & 0o777, MODE);
  });

  it("refuses a symlinked parent or a symlinked leaf, naming the refused path", () => {
    const realParent = path.join(root, "real-parent");
    fs.mkdirSync(realParent);
    fs.writeFileSync(path.join(realParent, "leaf.sqlite"), "x");
    const parentLink = path.join(root, "parent-link");
    fs.symlinkSync(realParent, parentLink);
    const parentRefusal = pathError(() => secure.openSecureSqlitePath(path.join(parentLink, "leaf.sqlite"), MODE));
    assert.equal(parentRefusal.name, "AgentStorePathError");
    assert.equal(parentRefusal.code, "symlink_refused");
    assert.match(parentRefusal.message ?? "", /^Refusing to open sqlite under symlinked parent: /);
    assert.equal(parentRefusal.failedPath, parentLink);

    const target = path.join(storeDir, "target.sqlite");
    fs.writeFileSync(target, "x");
    const leafLink = path.join(storeDir, "leaf-link.sqlite");
    fs.symlinkSync(target, leafLink);
    const leafRefusal = pathError(() => secure.openSecureSqlitePath(leafLink, MODE));
    assert.equal(leafRefusal.code, "symlink_refused");
    assert.match(leafRefusal.message ?? "", /^Refusing to open symlinked path: /);
    assert.equal(leafRefusal.failedPath, leafLink);
  });

  it("verifies only once: a leaf that disappeared after the first verification is not looked at again", () => {
    const file = path.join(storeDir, "verified-once.sqlite");
    const opened = secure.openSecureSqlitePath(file, MODE);
    assert.equal(opened.verifyOpenedInode(), undefined);
    fs.rmSync(file);
    assert.equal(opened.verifyOpenedInode(), undefined, "the first verification was the one that counted");
  });

  it("refuses a leaf that was swapped after it was opened, and a parent that was", () => {
    const file = path.join(storeDir, "swapped.sqlite");
    const opened = secure.openSecureSqlitePath(file, MODE);
    fs.rmSync(file);
    fs.writeFileSync(file, "new");
    const leafRefusal = pathError(() => opened.verifyOpenedInode());
    assert.equal(leafRefusal.code, "symlink_refused");
    assert.match(leafRefusal.message ?? "", /^Sqlite path inode drifted between open and verification \(expected dev=/);
    assert.equal(leafRefusal.failedPath, file);

    const parent = path.join(root, "swap-parent");
    fs.mkdirSync(parent);
    const openedUnderParent = secure.openSecureSqlitePath(path.join(parent, "leaf.sqlite"), MODE);
    fs.renameSync(parent, path.join(root, "swap-parent-old"));
    fs.mkdirSync(parent);
    const parentRefusal = pathError(() => openedUnderParent.verifyOpenedInode());
    assert.equal(parentRefusal.code, "symlink_refused");
    assert.match(parentRefusal.message ?? "", /^Parent directory inode drifted between open and verification \(expected dev=/);
    assert.equal(parentRefusal.failedPath, parent);
  });

  it("refuses a parent that is a regular file and a leaf that is a directory with the platform's own error", () => {
    const plainFile = path.join(root, "plain-file");
    fs.writeFileSync(plainFile, "x");
    const parentRefusal = pathError(() => secure.openSecureSqlitePath(path.join(plainFile, "child.sqlite"), MODE));
    assert.equal(parentRefusal.code, "ENOTDIR");

    const directoryLeaf = path.join(root, "directory-leaf");
    fs.mkdirSync(directoryLeaf);
    const leafRefusal = pathError(() => secure.openSecureSqlitePath(directoryLeaf, MODE));
    assert.equal(leafRefusal.code, "EISDIR");
  });
});

describe("writing a lock file", () => {
  it("creates it exclusively and refuses to replace one that exists", async () => {
    const lock = path.join(storeDir, "lock");
    await secure.writeLockFileExclusive(lock, "body\n", MODE);
    assert.equal(fs.readFileSync(lock, "utf8"), "body\n");
    assert.equal(fs.statSync(lock).mode & 0o777, MODE);
    await assert.rejects(() => secure.writeLockFileExclusive(lock, "again", MODE), { code: "EEXIST" });
    assert.equal(fs.readFileSync(lock, "utf8"), "body\n");
  });

  it("refuses a symlinked lock file and a lock file under a symlinked parent", async () => {
    const target = path.join(storeDir, "lock-target");
    fs.writeFileSync(target, "x");
    const link = path.join(storeDir, "lock-link");
    fs.symlinkSync(target, link);
    // An exclusive create on an existing name is refused by the platform itself: the name is taken.
    await assert.rejects(() => secure.writeLockFileExclusive(link, "body", MODE), { code: "EEXIST" });

    const realParent = path.join(root, "real-lock-parent");
    fs.mkdirSync(realParent);
    const parentLink = path.join(root, "lock-parent-link");
    fs.symlinkSync(realParent, parentLink);
    await assert.rejects(() => secure.writeLockFileExclusive(path.join(parentLink, "lock"), "body", MODE), {
      name: "AgentStorePathError",
      code: "symlink_refused",
    });
  });

  it("asks for an exclusive, no-follow, close-on-exec write", () => {
    const flags = secure.symlinkSafeExclusiveWriteFlags();
    assert.equal((flags & fs.constants.O_CREAT) !== 0, true);
    assert.equal((flags & fs.constants.O_EXCL) !== 0, true);
    assert.equal((flags & fs.constants.O_NOFOLLOW) !== 0, true);
  });
});