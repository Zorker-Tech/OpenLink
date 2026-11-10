import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, it, type TestContext } from "node:test";
import {
  BOX_STORE_PACK_INDEX_KEY,
  BOX_STORE_PACK_RETIRED_KEY,
  BOX_STORE_PACKS_PREFIX,
  PACK_INDEX_MAX_BYTES,
  PACK_INDEX_VERSION,
  PACK_MAX_MEMBER_SIZE_SUM,
  PACK_MEMBER_CLEN_BOUND,
  PACK_MEMBER_MAX_BYTES,
  PACK_OBJECT_MAX_BYTES,
  PACK_RETIRED_VERSION,
  buildPackFile,
  extractPackMembers,
  isBoxStorePackBuildEnabled,
  packEntrySchema,
  packIndexSchema,
  packMemberSchema,
  parsePackIndex,
  parsePackRetired,
  planPackMaintenance,
  serializePackIndex,
  serializePackRetired,
  type PackEntry,
  type PackMember,
  type PackSource,
} from "../../source/host/boxes/box-store-sync/box-store-pack.ts";

function temp(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "slate-pack-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceAt(directory: string, name: string, content: string): PackSource {
  const absPath = join(directory, name);
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, content);
  return { absPath, sha: sha(content), size: Buffer.byteLength(content), vmtime: 10 };
}

function member(overrides: Partial<PackMember> = {}): PackMember {
  return { sha: "a", size: 1, offset: 0, clen: PACK_MEMBER_CLEN_BOUND(1), vmtime: 1, ...overrides };
}

function pack(overrides: Partial<PackEntry> = {}): PackEntry {
  return { id: "pack-a", bytes: 10, members: [member({ clen: 10 })], ...overrides };
}

describe("box store pack contract", () => {
  it("publishes stable pack keys, versions and size bounds", () => {
    assert.equal(BOX_STORE_PACKS_PREFIX, "packs");
    assert.equal(BOX_STORE_PACK_INDEX_KEY, "packs/index.json");
    assert.equal(BOX_STORE_PACK_RETIRED_KEY, "packs/retired.json");
    assert.equal(PACK_INDEX_VERSION, 1);
    assert.equal(PACK_RETIRED_VERSION, 1);
    assert.equal(PACK_MEMBER_MAX_BYTES, 8 * 1024 * 1024);
    assert.equal(PACK_MAX_MEMBER_SIZE_SUM, 256 * 1024 * 1024);
    assert.equal(PACK_OBJECT_MAX_BYTES, 320 * 1024 * 1024);
    assert.equal(PACK_INDEX_MAX_BYTES, 64 * 1024 * 1024);
    assert.equal(PACK_MEMBER_CLEN_BOUND(512), 4_609);
  });

  it("validates member sizes, offsets, gzip bounds and pack object ranges", () => {
    assert.equal(packMemberSchema.safeParse(member()).success, true);
    assert.equal(packMemberSchema.safeParse(member({ size: -1 })).success, false);
    assert.equal(packMemberSchema.safeParse(member({ clen: PACK_MEMBER_CLEN_BOUND(1) + 1 })).success, false);
    assert.equal(packEntrySchema.safeParse(pack()).success, true);
    assert.equal(packEntrySchema.safeParse(pack({ bytes: 2, members: [member({ offset: 1, clen: 2 })] })).success, false);
    assert.equal(packIndexSchema.safeParse({ version: PACK_INDEX_VERSION, maxVmtime: 1, packs: [pack()] }).success, true);
  });

  it("parses index versions defensively and round-trips retired pack ids", () => {
    const index = { version: PACK_INDEX_VERSION, maxVmtime: 8, packs: [pack({ id: "p1" })] };
    assert.deepEqual(parsePackIndex(serializePackIndex(index)), index);
    assert.equal(parsePackIndex("not-json"), null);
    assert.equal(parsePackIndex(JSON.stringify({ ...index, version: PACK_INDEX_VERSION + 1 })), null);
    assert.equal(parsePackIndex(JSON.stringify({ version: PACK_INDEX_VERSION, packs: "bad" })), null);
    assert.deepEqual(parsePackRetired(serializePackRetired(["p1", "p2"])), ["p1", "p2"]);
    assert.equal(parsePackRetired(JSON.stringify({ version: PACK_RETIRED_VERSION + 1, retired: ["p1"] })), null);
  });

  it("enables pack building by default unless a supported off value is set", () => {
    assert.equal(isBoxStorePackBuildEnabled({} as NodeJS.ProcessEnv), true);
    for (const value of ["0", " false ", "NO"]) assert.equal(isBoxStorePackBuildEnabled({ SLATE_BOX_STORE_PACKS: value } as NodeJS.ProcessEnv), false);
    for (const value of ["1", "true", "yes", "off", "unknown"]) assert.equal(isBoxStorePackBuildEnabled({ SLATE_BOX_STORE_PACKS: value } as NodeJS.ProcessEnv), true);
  });

  it("packs only source files whose size and digest still match", async t => {
    const directory = temp(t);
    const good = sourceAt(directory, "good.txt", "reliable bytes");
    const badDigest = { ...sourceAt(directory, "changed.txt", "changed bytes"), sha: "0".repeat(64) };
    const wrongSize = { ...sourceAt(directory, "wrong-size.txt", "short"), size: 100 };
    const missing: PackSource = { absPath: join(directory, "missing.txt"), sha: "a", size: 1, vmtime: 1 };
    mkdirSync(join(directory, "packs"), { recursive: true });
    const output = join(directory, "packs", "pack.bin");
    const built = await buildPackFile(output, [good, badDigest, wrongSize, missing]);
    assert.ok(built);
    assert.equal(built.members.length, 1);
    assert.equal(built.skipped, 3);
    assert.equal(built.fileBytes, readFileSync(output).byteLength);
    assert.deepEqual(built.members[0], { sha: good.sha, size: good.size, offset: 0, clen: built.fileBytes, vmtime: good.vmtime });
  });

  it("returns no pack when cancelled before it reads a member", async t => {
    const directory = temp(t);
    const file = sourceAt(directory, "one.txt", "one");
    const result = await buildPackFile(join(directory, "cancelled.bin"), [file], () => true);
    assert.equal(result, null);
  });

  it("extracts requested members after checking their compressed size and digest", async t => {
    const directory = temp(t);
    const first = sourceAt(directory, "a.txt", "alpha");
    const second = sourceAt(directory, "b.txt", "beta");
    const path = join(directory, "pack.bin");
    const built = await buildPackFile(path, [first, second]);
    assert.ok(built);
    const output = new Map<string, string>();
    const acquired: number[] = [];
    const released: number[] = [];
    const extracted = await extractPackMembers({
      packPath: path,
      members: built.members,
      concurrency: 2,
      wants: () => true,
      admitBytes: async bytes => { acquired.push(bytes); return () => released.push(bytes); },
      async onBlob(item, bytes) { output.set(item.sha, Buffer.from(bytes).toString()); },
    });
    assert.deepEqual(extracted, { extracted: 2, mismatched: 0 });
    assert.deepEqual(output, new Map([[first.sha, "alpha"], [second.sha, "beta"]]));
    assert.deepEqual([...acquired].sort((left, right) => left - right), [...released].sort((left, right) => left - right));
  });

  it("counts truncated and digest-mismatched members without writing their contents", async t => {
    const directory = temp(t);
    const payload = Buffer.from("payload");
    const compressed = gzipSync(payload);
    const filePath = join(directory, "damaged.pack");
    writeFileSync(filePath, compressed.subarray(0, Math.max(1, compressed.length - 2)));
    const records = [
      member({ sha: sha(payload), size: payload.length, clen: compressed.length }),
      member({ sha: "f".repeat(64), size: payload.length, offset: 0, clen: compressed.length }),
    ];
    let writes = 0;
    const result = await extractPackMembers({
      packPath: filePath,
      members: records,
      wants: () => true,
      async onBlob() { writes += 1; },
    });
    assert.deepEqual(result, { extracted: 0, mismatched: 2 });
    assert.equal(writes, 0);
  });

  it("skips unwanted members and releases admitted bytes even when a write fails", async t => {
    const directory = temp(t);
    const source = sourceAt(directory, "one.txt", "value");
    const path = join(directory, "pack.bin");
    const built = await buildPackFile(path, [source]);
    assert.ok(built);
    let admissions = 0;
    let releases = 0;
    const skipped = await extractPackMembers({ packPath: path, members: built.members, wants: () => false, admitBytes: async () => { admissions += 1; return () => { releases += 1; }; }, async onBlob() { assert.fail("an unwanted member was written"); } });
    assert.deepEqual(skipped, { extracted: 0, mismatched: 0 });
    assert.equal(admissions, 0);
    await assert.rejects(extractPackMembers({
      packPath: path,
      members: built.members,
      wants: () => true,
      admitBytes: async () => { admissions += 1; return () => { releases += 1; }; },
      async onBlob() { throw new Error("sink failed"); },
    }), /sink failed/);
    assert.equal(admissions, 1);
    assert.equal(releases, 1);
  });

  it("preserves fully live packs and retires partial packs before planning survivors and new members", () => {
    const kept = pack({ id: "kept", bytes: 8, members: [member({ sha: "a", size: 2, clen: 4, vmtime: 8 }), member({ sha: "b", size: 2, offset: 4, clen: 4, vmtime: 7 })] });
    const partial = pack({ id: "partial", bytes: 8, members: [member({ sha: "c", size: 2, clen: 4, vmtime: 6 }), member({ sha: "d", size: 2, offset: 4, clen: 4, vmtime: 5 })] });
    const plan = planPackMaintenance({
      index: { version: PACK_INDEX_VERSION, maxVmtime: 8, packs: [kept, partial] },
      live: new Map([["a", 2], ["b", 2], ["c", 2]]),
      eligible: new Map([["a", 2], ["c", 2], ["new-z", 1], ["new-a", 1]]),
      maxPackMemberSizeSum: 10,
      minPackMembers: 1,
      minPackBytes: 1,
    });
    assert.deepEqual(plan.keptPacks.map(item => item.id), ["kept"]);
    assert.deepEqual(plan.retiredPackIds, ["partial"]);
    assert.deepEqual(plan.newPacks, [[
      { sha: "c", size: 2, vmtime: 8 },
      { sha: "new-a", size: 1, vmtime: 9 },
      { sha: "new-z", size: 1, vmtime: 10 },
    ]]);
    assert.equal(plan.newMaxVmtime, 10);
  });

  it("splits planned packs at the byte cap and defers a short tail below both floors", () => {
    const plan = planPackMaintenance({
      index: { version: PACK_INDEX_VERSION, maxVmtime: 2, packs: [] },
      live: new Map(),
      eligible: new Map([["a", 4], ["b", 4], ["c", 1]]),
      maxPackMemberSizeSum: 8,
      minPackMembers: 2,
      minPackBytes: 4,
    });
    assert.deepEqual(plan.newPacks, [[
      { sha: "a", size: 4, vmtime: 3 },
      { sha: "b", size: 4, vmtime: 4 },
    ]]);
    assert.equal(plan.deferredMembers, 1);
    assert.equal(plan.newMaxVmtime, 4);
  });

  it("retains a pack only when every listed member is still live", () => {
    const index = { version: PACK_INDEX_VERSION, maxVmtime: 9, packs: [
      pack({ id: "empty", members: [] }),
      pack({ id: "dead", members: [member({ sha: "gone", size: 1 })] }),
    ] };
    const result = planPackMaintenance({ index, live: new Map(), eligible: new Map(), maxPackMemberSizeSum: 10, minPackMembers: 1, minPackBytes: 1 });
    assert.deepEqual(result.keptPacks, []);
    assert.deepEqual(result.retiredPackIds, ["empty", "dead"]);
    assert.deepEqual(result.newPacks, []);
    assert.equal(result.newMaxVmtime, 9);
  });
});
