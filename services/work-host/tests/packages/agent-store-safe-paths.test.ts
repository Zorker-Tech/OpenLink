/**
 * Keeping a store path inside the store: what a segment may be, what a base may be, and what a walk or a stat refuses
 * rather than follows.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertWindowsMaterializableRelPath,
  normalizeRelPath,
  resolveSafeChildPath,
  safeStatChild,
  safeWalk,
  type SafeAgentStoreFileSystem,
} from "../../source/packages/agent-store-sync/safe-paths.ts";

/** A node in the fake tree, or a directory entry list; `lstat` and `readdir` are answered from it. */
type Node =
  | { readonly kind: "file"; readonly size?: number; readonly mtimeMs?: number }
  | { readonly kind: "dir"; readonly children?: Record<string, Node> }
  | { readonly kind: "link" }
  | { readonly kind: "other" };

/**
 * The fake file system: the tree hangs under `base`, inodes are stable per path, and a path can be made to vanish or to
 * change between two calls, which is how a directory gets swapped for a link mid-walk.
 */
function fakeFs(root: Record<string, Node>, options: { readonly base?: string; readonly vanish?: readonly string[]; readonly vanishOnReaddir?: readonly string[] } = {}) {
  const base = options.base ?? "/store";
  const vanish = new Set(options.vanish ?? []);
  const vanishOnReaddir = new Set(options.vanishOnReaddir ?? []);
  const inodeOf = new Map<string, number>();
  const statFor = (target: string, node: Node) => {
    if (!inodeOf.has(target)) inodeOf.set(target, inodeOf.size + 1);
    return {
      dev: 7,
      ino: inodeOf.get(target)!,
      size: node.kind === "file" ? (node.size ?? 3) : 0,
      mtimeMs: node.kind === "file" ? (node.mtimeMs ?? 1_000) : 500,
      isFile: () => node.kind === "file",
      isDirectory: () => node.kind === "dir",
      isSymbolicLink: () => node.kind === "link",
    } as never;
  };
  const lookup = (target: string): Node | undefined => {
    if (vanish.has(target)) return undefined;
    if (target === base) return { kind: "dir", children: root };
    if (!target.startsWith(`${base}/`)) return undefined;
    let node: Node | undefined = { kind: "dir", children: root };
    for (const part of target.slice(base.length + 1).split("/")) {
      if (node?.kind !== "dir") return undefined;
      node = node.children?.[part];
    }
    return node;
  };
  const fsModule: SafeAgentStoreFileSystem = {
    lstatSync(target: unknown) {
      const asString = String(target);
      const node = lookup(asString);
      if (node === undefined) throw Object.assign(new Error(`ENOENT: ${asString}`), { code: "ENOENT" });
      return statFor(asString, node);
    },
    readdirSync(target: unknown) {
      const asString = String(target);
      // A directory that is still there for a stat but gone for a read: it vanished between the two, which is the case a
      // walk has to report rather than throw.
      if (vanishOnReaddir.has(asString)) throw Object.assign(new Error(`ENOENT: ${asString}`), { code: "ENOENT" });
      const node = lookup(asString);
      if (node === undefined) throw Object.assign(new Error(`ENOENT: ${asString}`), { code: "ENOENT" });
      if (node.kind !== "dir") throw Object.assign(new Error(`ENOTDIR: ${asString}`), { code: "ENOTDIR" });
      return Object.entries(node.children ?? {}).map(([name]) => ({ name }) as never);
    },
  };
  return { fsModule, lookup, root, base };
}

const base = () => "/store";

describe("what a relative path may be", () => {
  it("normalizes the harmless spellings and keeps the rest", () => {
    assert.equal(normalizeRelPath("./a//b/./c"), "a/b/c");
    assert.equal(normalizeRelPath("a\\b"), "a/b", "a backslash is a separator on the store's side");
    assert.equal(normalizeRelPath("notes/a.txt"), "notes/a.txt");
  });

  it("refuses every path that is not a place in the store", () => {
    const cases: Array<[unknown, string]> = [
      ["", "empty_path"],
      [undefined, "empty_path"],
      ["a\0b", "invalid_segment"],
      ["/etc/passwd", "invalid_segment"],
      ["C:\\Windows", "invalid_segment"],
      ["a/../b", "invalid_segment"],
      ["./", "empty_path"],
      ["a".repeat(256), "invalid_segment"],
      ["a\u0001b", "invalid_segment"],
      ["a.", "invalid_segment"],
      ["a ", "invalid_segment"],
      ["con", "reserved_name"],
      ["NUL.txt", "reserved_name"],
    ];
    for (const [relPath, code] of cases) {
      assert.throws(() => normalizeRelPath(relPath), (error: unknown) => (error as { code?: string }).code === code, String(relPath));
    }
  });

  it("only refuses Windows-illegal characters on Windows", () => {
    assertWindowsMaterializableRelPath({ relPath: "a<b>.txt", platform: "darwin" });
    assertWindowsMaterializableRelPath({ relPath: "a/b.txt", platform: "win32" });
    assert.throws(() => assertWindowsMaterializableRelPath({ relPath: "a<b>.txt", platform: "win32" }), (error: unknown) => (error as { code?: string }).code === "windows_incompatible");
  });

  it("resolves a child under an absolute base, and refuses a base that is not one", () => {
    assert.equal(resolveSafeChildPath({ base: "/store", relPath: "./notes/a.txt" }), "/store/notes/a.txt");
    assert.throws(() => resolveSafeChildPath({ base: "store", relPath: "a.txt" }), (error: unknown) => (error as { code?: string }).code === "outside_base");
  });
});

describe("walking a store", () => {
  it("walks depth first in directory order, and refuses links and non-files by name", () => {
    const { fsModule } = fakeFs({
      "a.txt": { kind: "file", size: 1 },
      notes: { kind: "dir", children: { "b.txt": { kind: "file", size: 2 }, deep: { kind: "dir", children: { "c.txt": { kind: "file", size: 3 } } } } },
      link: { kind: "link" },
      socket: { kind: "other" },
    });
    const result = safeWalk(base(), { fs: fsModule });
    // The order is the walk's: a directory's contents sit where the directory did.
    assert.deepEqual(result.files.map((file) => [file.relPath, file.size]), [["a.txt", 1], ["notes/b.txt", 2], ["notes/deep/c.txt", 3]]);
    assert.deepEqual(result.refusals, [
      { relPath: "link", reason: "symlink_refused" },
      { relPath: "socket", reason: "not_regular_file" },
    ]);
    assert.deepEqual([result.files[0]!.dev, typeof result.files[0]!.ino, result.files[0]!.mtimeMs], [7, "number", 1_000]);
  });

  it("refuses a name the store cannot hold, and a directory that vanished under it", () => {
    // `bad:name.txt` is legal off Windows; a name ending in a dot is not legal anywhere.
    const named = safeWalk(base(), { fs: fakeFs({ "bad.": { kind: "file" }, good: { kind: "file" } }).fsModule });
    assert.deepEqual(named.refusals, [{ relPath: "bad.", reason: "not_regular_file" }]);
    assert.deepEqual(named.files.map((file) => file.relPath), ["good"]);
    // A directory that is gone when it is read is a refusal for that directory, not the end of the walk.
    const vanished = safeWalk(base(), { fs: fakeFs({ gone: { kind: "dir", children: {} }, good: { kind: "file" } }, { vanishOnReaddir: ["/store/gone"] }).fsModule });
    assert.deepEqual(vanished.refusals, [{ relPath: "gone", reason: "not_regular_file" }]);
    assert.deepEqual(vanished.files.map((file) => file.relPath), ["good"]);
  });

  it("refuses a base that is a link, a file, or relative", () => {
    const world = fakeFs({ store: { kind: "link" }, file: { kind: "file" } }, { base: "/parent" });
    assert.throws(() => safeWalk("/parent/store", { fs: world.fsModule }), (error: unknown) => (error as { code?: string }).code === "symlink_refused");
    assert.throws(() => safeWalk("/parent/file", { fs: world.fsModule }), (error: unknown) => (error as { code?: string }).code === "not_regular_file");
    assert.throws(() => safeWalk("parent/store", { fs: world.fsModule }), (error: unknown) => (error as { code?: string }).code === "outside_base");
    // A base under a symlinked ancestor is refused as well: writing through the link is not what the caller asked for.
    const linkedAncestor = fakeFs({ linkish: { kind: "link" }, "linkish/store": { kind: "dir", children: {} } }, { base: "/parent" });
    assert.throws(() => safeWalk("/parent/linkish/store", { fs: linkedAncestor.fsModule }), (error: unknown) => (error as { code?: string }).code === "symlink_refused");
  });
});

describe("stating one child", () => {
  const world = () =>
    fakeFs({
      notes: { kind: "dir", children: { "a.txt": { kind: "file", size: 4, mtimeMs: 2_000 }, link: { kind: "link" }, dir: { kind: "dir", children: {} } } },
      top: { kind: "file", size: 1 },
      link: { kind: "link" },
    });

  it("answers absent, file or refused — never an error for an ordinary shape", () => {
    const { fsModule } = world();
    assert.deepEqual(safeStatChild({ base: "/store", relPath: "missing.txt", fs: fsModule }), { kind: "absent" });
    assert.deepEqual(safeStatChild({ base: "/store", relPath: "notes/missing/a.txt", fs: fsModule }), { kind: "absent" });
    const file = safeStatChild({ base: "/store", relPath: "./notes/a.txt", fs: fsModule });
    assert.equal(file.kind, "file");
    assert.deepEqual([file.kind === "file" ? file.entry.relPath : "", file.kind === "file" ? file.entry.size : 0], ["notes/a.txt", 4]);
    assert.deepEqual(safeStatChild({ base: "/store", relPath: "notes/link", fs: fsModule }), { kind: "refused", refusal: { relPath: "notes/link", reason: "symlink_refused" } });
    assert.deepEqual(safeStatChild({ base: "/store", relPath: "top/inside", fs: fsModule }), { kind: "refused", refusal: { relPath: "top", reason: "not_regular_file" } });
  });

  it("refuses a directory that was swapped for a link between the pass and the leaf", () => {
    const { fsModule, root } = world();
    let swapped = false;
    const swapping: SafeAgentStoreFileSystem = {
      lstatSync(target: unknown) {
        const asString = String(target);
        // After the directory has been read once, it becomes a link: the second look must catch it.
        if (asString === "/store/notes" && swapped) return { dev: 7, ino: 999, size: 0, mtimeMs: 1, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true } as never;
        if (asString === "/store/notes" && !swapped) {
          swapped = true;
          return fsModule.lstatSync(target as never);
        }
        return fsModule.lstatSync(target as never);
      },
      readdirSync: (target, options) => fsModule.readdirSync(target as never, options),
    };
    const result = safeStatChild({ base: "/store", relPath: "notes/a.txt", fs: swapping });
    assert.equal(result.kind, "refused");
    assert.equal(result.kind === "refused" ? result.refusal.reason : "", "symlink_refused");
    assert.notEqual(root.notes, undefined);
  });

  it("refuses a link at the base, and a base that is a file", () => {
    const { fsModule } = world();
    assert.throws(() => safeStatChild({ base: "/store/link", relPath: "a.txt", fs: fsModule }), (error: unknown) => (error as { code?: string }).code === "symlink_refused");
    assert.throws(() => safeStatChild({ base: "/store/top", relPath: "a.txt", fs: fsModule }), (error: unknown) => (error as { code?: string }).code === "not_regular_file");
  });
});
