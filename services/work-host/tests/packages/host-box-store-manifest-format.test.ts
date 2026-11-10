import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOX_STORE_BLOBS_PREFIX,
  BOX_STORE_LEGACY_MANIFEST_VERSION,
  BOX_STORE_MANIFEST_REL_PATH,
  BOX_STORE_MANIFEST_VERSION,
  SLATE_MANIFEST_V2_ENV,
  boxStoreManifestEntriesEqual,
  isBoxStoreManifestFileEntry,
  isBoxStoreManifestSymlinkEntry,
  isSymlinkManifestValue,
  legacyManifestFileEntrySchema,
  manifestEntrySchema,
  manifestFileEntrySchema,
  manifestSchema,
  manifestSymlinkEntrySchema,
  type BoxStoreManifestEntry,
} from "../../source/host/boxes/box-store-sync/box-store-manifest-format.ts";

const fileEntry = (overrides: Record<string, unknown> = {}): BoxStoreManifestEntry =>
  ({ kind: "file", sha: "abc", size: 12, mode: 0o644, ...overrides }) as BoxStoreManifestEntry;
const symlinkEntry = (overrides: Record<string, unknown> = {}): BoxStoreManifestEntry =>
  ({ kind: "symlink", target: "/somewhere/else", ...overrides }) as BoxStoreManifestEntry;

describe("the values a box store's manifest is written with", () => {
  it("are the names and numbers the stored files carry", () => {
    assert.equal(BOX_STORE_MANIFEST_REL_PATH, "manifest.json");
    assert.equal(BOX_STORE_BLOBS_PREFIX, "blobs");
    assert.equal(BOX_STORE_LEGACY_MANIFEST_VERSION, 1);
    assert.equal(BOX_STORE_MANIFEST_VERSION, 2);
    assert.equal(SLATE_MANIFEST_V2_ENV, "SLATE_MANIFEST_V2");
  });
});

describe("a manifest entry", () => {
  it("is a file when it names a kind, a sha, a size, and a mode inside the permission bits", () => {
    const entry = { kind: "file", sha: "abc", size: 12, mode: 0o644 } as const;
    assert.deepEqual(manifestFileEntrySchema.parse(entry), entry);
    assert.equal(manifestFileEntrySchema.safeParse(fileEntry({ mode: 0o777 })).success, true);
    for (const mode of [0o1000, -1, 420.5]) {
      assert.equal(manifestFileEntrySchema.safeParse(fileEntry({ mode })).success, false, String(mode));
    }
    for (const size of [-1, 1.5, "1"]) {
      assert.equal(manifestFileEntrySchema.safeParse(fileEntry({ size })).success, false, String(size));
    }
    assert.equal(manifestFileEntrySchema.safeParse(fileEntry({ sha: "" })).success, false);
    assert.equal(manifestFileEntrySchema.safeParse(fileEntry({ sha: 7 })).success, false);
  });

  it("is a symlink when it names a non-empty target text", () => {
    assert.deepEqual(manifestSymlinkEntrySchema.parse(symlinkEntry()), { kind: "symlink", target: "/somewhere/else" });
    assert.equal(manifestSymlinkEntrySchema.safeParse(symlinkEntry({ target: "" })).success, false);
    assert.equal(manifestSymlinkEntrySchema.safeParse(symlinkEntry({ target: 7 })).success, false);
    assert.equal(manifestSymlinkEntrySchema.safeParse({ kind: "symlink" }).success, false);
  });

  it("is a legacy file when it names only the sha and the size", () => {
    assert.deepEqual(legacyManifestFileEntrySchema.parse({ sha: "abc", size: 12 }), { sha: "abc", size: 12 });
    assert.equal(legacyManifestFileEntrySchema.safeParse({ sha: "abc", size: 12, kind: undefined, mode: undefined }).success, true);
    assert.equal(legacyManifestFileEntrySchema.safeParse({ sha: "abc", size: 12, kind: "file", mode: 0o644 }).success, false);
  });

  it("takes any of the three shapes, and drops fields it does not know", () => {
    for (const entry of [fileEntry(), symlinkEntry(), { sha: "abc", size: 12 }]) {
      const parsed = manifestEntrySchema.parse({ ...entry, extra: true });
      assert.deepEqual(parsed, entry);
      assert.deepEqual(Object.keys(parsed), Object.keys(entry));
    }
    assert.equal(manifestEntrySchema.safeParse({}).success, false);
    assert.equal(manifestEntrySchema.safeParse({ kind: "directory", sha: "a", size: 1, mode: 0o644 }).success, false);
  });
});

describe("a whole manifest", () => {
  it("is version one with legacy entries, or version two with any entries", () => {
    const legacy = { version: 1, updatedAtMs: 5, entries: { a: { sha: "s", size: 1 } } };
    assert.deepEqual(manifestSchema.parse(legacy), legacy);
    const current = {
      version: 2,
      updatedAtMs: 5,
      writerWindowId: "window",
      fullyHydrated: true,
      entries: { a: { kind: "file", sha: "s", size: 1, mode: 0o644 }, b: { kind: "symlink", target: "c" } },
    };
    assert.deepEqual(manifestSchema.parse(current), current);
  });

  it("is rejected with another version, a version as text, or a bad header", () => {
    for (const document of [
      { version: 3, updatedAtMs: 5, entries: {} },
      { version: "2", updatedAtMs: 5, entries: {} },
      { updatedAtMs: 5, entries: {} },
      { version: 2, entries: {} },
      { version: 2, updatedAtMs: -1, entries: {} },
      { version: 2, updatedAtMs: 1.5, entries: {} },
    ]) {
      assert.equal(manifestSchema.safeParse(document).success, false, JSON.stringify(document));
    }
  });

  it("is version one only with legacy entries", () => {
    assert.equal(
      manifestSchema.safeParse({ version: 1, updatedAtMs: 5, entries: { a: { kind: "file", sha: "s", size: 1, mode: 0o644 } } }).success,
      false,
    );
    assert.equal(
      manifestSchema.safeParse({ version: 2, updatedAtMs: 5, entries: { a: { sha: "s", size: 1 } } }).success,
      true,
      "the current version still reads a legacy-shaped entry",
    );
  });
});

describe("comparing and classifying manifest entries", () => {
  it("tells a file from a symlink, and every legacy entry is a file", () => {
    assert.equal(isBoxStoreManifestFileEntry(fileEntry() as BoxStoreManifestEntry), true);
    assert.equal(isBoxStoreManifestFileEntry(symlinkEntry() as BoxStoreManifestEntry), false);
    assert.equal(isBoxStoreManifestFileEntry({ sha: "a", size: 1 }), true, "a legacy entry meant a file");
    assert.equal(isBoxStoreManifestSymlinkEntry(symlinkEntry() as BoxStoreManifestEntry), true);
    assert.equal(isBoxStoreManifestSymlinkEntry(fileEntry() as BoxStoreManifestEntry), false);
  });

  it("compares links by target and files by identity and mode", () => {
    assert.equal(boxStoreManifestEntriesEqual(fileEntry(), fileEntry()), true);
    assert.equal(boxStoreManifestEntriesEqual(fileEntry({ sha: "other" }), fileEntry()), false);
    assert.equal(boxStoreManifestEntriesEqual(fileEntry({ size: 13 }), fileEntry()), false);
    assert.equal(boxStoreManifestEntriesEqual(fileEntry({ mode: 0o600 }), fileEntry()), false);
    assert.equal(boxStoreManifestEntriesEqual(symlinkEntry(), symlinkEntry()), true);
    assert.equal(boxStoreManifestEntriesEqual(symlinkEntry({ target: "elsewhere" }), symlinkEntry()), false);
    assert.equal(boxStoreManifestEntriesEqual(fileEntry(), symlinkEntry()), false);
    assert.equal(boxStoreManifestEntriesEqual({ sha: "a", size: 1 }, fileEntry({ sha: "a", size: 1 })), false, "a legacy entry and a file entry are not the same entry");
    assert.equal(boxStoreManifestEntriesEqual(fileEntry({ extra: true }), fileEntry()), true, "only the fields that name an entry are compared");
  });

  it("compares absence with absence", () => {
    assert.equal(boxStoreManifestEntriesEqual(null, null), true);
    assert.equal(boxStoreManifestEntriesEqual(undefined, undefined), true);
    assert.equal(boxStoreManifestEntriesEqual(null, undefined), false);
    assert.equal(boxStoreManifestEntriesEqual(null, fileEntry()), false);
    assert.equal(boxStoreManifestEntriesEqual(fileEntry(), undefined), false);
  });

  it("recognizes a stored value that is a symlink entry", () => {
    assert.equal(isSymlinkManifestValue(symlinkEntry()), true);
    assert.equal(isSymlinkManifestValue({ kind: "symlink", target: "x", extra: 1 }), true, "unknown fields do not stop the read");
    assert.equal(isSymlinkManifestValue(symlinkEntry({ target: "" })), false);
    assert.equal(isSymlinkManifestValue(fileEntry()), false);
    assert.equal(isSymlinkManifestValue({ sha: "a", size: 1 }), false);
    for (const value of [null, undefined, 0, "symlink", []]) {
      assert.equal(isSymlinkManifestValue(value), false, String(value));
    }
  });
});