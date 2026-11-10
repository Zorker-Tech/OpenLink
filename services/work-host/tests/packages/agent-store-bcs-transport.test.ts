/**
 * The agent store's BCS transport: what it asks the store's service for, what it makes of the answers, what it keeps
 * for a moment and when it forgets it, and what a flat listing is adapted into.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Code, ConnectError } from "@connectrpc/connect";

import { adaptFlatAgentStoreList } from "../../source/packages/agent-store-sync/bcs-list-adapter.ts";
import { AgentStoreDirectoryListingError, AgentStoreProtocolError, AgentStoreUnauthorizedError } from "../../source/packages/agent-store-sync/bcs-client.ts";
import { BcsAgentStoreTransport, type AgentStoreToken } from "../../source/packages/agent-store-sync/bcs-transport.ts";
import {
  AgentStoreDeleteFileStatus,
  AgentStoreDirectoryListingMode,
  AgentStoreMultipartOperationFailureCode,
  AgentStoreSourceKind,
} from "../../source/adapters/interop/proto/generated/aiserver/v1/background_composer_pb.ts";

const token: AgentStoreToken = { token: "token-1", expiresAtMs: 5_000, storeIds: ["store-1"] };
const file = (relPath: string, extra: Record<string, unknown> = {}) => ({ relPath, etag: `"${relPath}-etag"`, size: 10, serverMtimeMs: 1_000, ...extra });
const multipartContext = (relPath: string) => ({
  uploadId: "upload-1",
  storeId: "store-1",
  relPath,
  sizeBytes: 3_000,
  sha: "sha-1",
  expectedPartCount: 2,
  precondition: { case: "baseEtag" as const, value: "base" },
  sessionId: "session-1",
});

/** A store client that writes down every call and answers what the test told it to. */
function transportWorld(options: { now?: () => number; ttlMs?: number; rpcTimeoutMs?: number } = {}) {
  const requests: Record<string, Array<[any, any]>> = {};
  const queues: Record<string, any[]> = {};
  const record = (name: string) => async (request: unknown, callOptions?: unknown) => {
    (requests[name] ??= []).push([request, callOptions]);
    const queue = queues[name];
    if (queue === undefined || queue.length === 0) return {};
    const next = queue.length === 1 ? queue[0] : queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const client = {
    mintAgentStoreToken: record("mint"),
    listAgentStoreDirectory: record("list"),
    presignAgentStoreReads: record("reads"),
    presignAgentStoreWrites: record("writes"),
    completeAgentStoreMultipartWrites: record("complete"),
    abortAgentStoreMultipartWrites: record("abort"),
    deleteAgentStoreFiles: record("delete"),
  };
  const transport = new BcsAgentStoreTransport({
    client,
    now: options.now ?? (() => 1_000),
    ...(options.ttlMs === undefined ? {} : { flatFileListCacheTtlMs: options.ttlMs }),
    rpcTimeoutMs: options.rpcTimeoutMs ?? 0,
  });
  return {
    transport,
    requests,
    answer: (name: string, ...values: any[]) => void (queues[name] = values),
    calls: (name: string) => (requests[name] ?? []).length,
  };
}

describe("adapting a flat listing", () => {
  it("keeps what is under the requested directory, sorted, and names the directories under it", () => {
    const listing = adaptFlatAgentStoreList({
      relPath: "notes",
      files: [file("notes/b.txt"), file("notes/a.txt"), file("./notes/zeta/c.txt"), file("notes/alpha/c.txt"), file("other/d.txt"), file("notes")],
      tombstones: [{ relPath: "notes/gone.txt", tombstoneEtag: "t", deletedAtMs: 1 }],
      listingComplete: true,
    });
    assert.deepEqual(listing.files.map((entry) => entry.relPath), ["notes/a.txt", "notes/alpha/c.txt", "notes/b.txt", "notes/zeta/c.txt"]);
    assert.deepEqual(listing.subdirs, ["notes/alpha", "notes/zeta"]);
    assert.deepEqual([listing.tombstones.length, listing.listingComplete, listing.skippedUnsafeEntries], [1, true, 0]);
  });

  it("asks for everything when the directory is the root, and for nothing outside it", () => {
    const root = adaptFlatAgentStoreList({ relPath: "", files: [file("a.txt"), file("deep/b.txt")] });
    assert.deepEqual([root.files.map((entry) => entry.relPath), root.subdirs, root.tombstones, root.listingComplete], [["a.txt", "deep/b.txt"], ["deep"], undefined, undefined]);
    // A requested path that leaves the store is not a path the store has, and saying so is an error.
    assert.throws(() => adaptFlatAgentStoreList({ relPath: "../outside", files: [file("a.txt")] }), /must not contain/);
    const cleaned = adaptFlatAgentStoreList({ relPath: "notes/", files: [file("notes/a.txt")] });
    assert.deepEqual(cleaned.files.map((entry) => entry.relPath), ["notes/a.txt"]);
  });

  it("counts the entries it refuses to name rather than passing them on", () => {
    const listing = adaptFlatAgentStoreList({ relPath: "", files: [file("a.txt"), file("../escape.txt"), file("deep/../../escape.txt")] });
    assert.deepEqual([listing.files.map((entry) => entry.relPath), listing.skippedUnsafeEntries], [["a.txt"], 2]);
  });
});

describe("asking the store's service", () => {
  it("needs a client or a transport, and takes the client it was given", () => {
    assert.throws(() => new BcsAgentStoreTransport({}), /requires either `client` or `transport`/);
    const world = transportWorld();
    assert.equal(world.transport instanceof BcsAgentStoreTransport, true);
  });

  it("mints a token for whichever target it was asked about", async () => {
    const world = transportWorld();
    world.answer("mint", { token: "t", expiresAtMs: "7000", storeIds: ["s1"], agentIds: ["a1"] });
    assert.deepEqual(await world.transport.mintToken({ kind: "share", shareId: "share-1" }), { token: "t", expiresAtMs: 7_000, storeIds: ["s1"] });
    assert.equal(world.requests["mint"]![0]![0].shareId, "share-1");
    world.answer("mint", { token: "t", expiresAtMs: 8_000, storeIds: [], agentIds: ["a1", "a2"] });
    await world.transport.mintToken({ kind: "store", storeId: "store-1" });
    assert.equal(world.requests["mint"]![1]![0].storeId, "store-1");
    // With no store ids of its own, the ones the service calls agents are the store ids.
    world.answer("mint", { token: "t", expiresAtMs: 8_000, storeIds: [], agentIds: ["a1", "a2"] });
    assert.deepEqual((await world.transport.mintToken({ kind: "source", sourceKind: "team", sourceId: "team-9" })).storeIds, ["a1", "a2"]);
    const sourceRequest = world.requests["mint"]![2]![0];
    assert.deepEqual([sourceRequest.source.kind, sourceRequest.source.sourceId], [AgentStoreSourceKind.TEAM, "team-9"]);
  });
});

describe("listing a directory", () => {
  it("adapts a complete flat store, and answers the next listing from what it kept", async () => {
    const world = transportWorld({ now: () => 1_000, ttlMs: 500 });
    world.answer("list", { mode: AgentStoreDirectoryListingMode.COMPLETE_FLAT_STORE, files: [file("b.txt"), file("a.txt")], tombstones: [{ relPath: "gone.txt", tombstoneEtag: "t", deletedAtMs: 1 }] });
    const first = await world.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    assert.deepEqual([first.files.map((entry) => entry.relPath), first.listingComplete, first.tombstones.length], [["a.txt", "b.txt"], true, 1]);
    // The flat store is asked for once, and a listing inside it is answered from that.
    await world.transport.listFiles({ token, storeId: "store-1", relPath: "deep" });
    assert.equal(world.calls("list"), 1);
    // A write invalidates what was kept, so the next listing asks again.
    world.transport.invalidateListCache({ storeId: "store-1" });
    world.answer("list", { mode: AgentStoreDirectoryListingMode.COMPLETE_FLAT_STORE, files: [file("c.txt")] });
    assert.deepEqual((await world.transport.listFiles({ token, storeId: "store-1", relPath: "" })).files.map((entry) => entry.relPath), ["c.txt"]);
    assert.equal(world.calls("list"), 2);
    // A listing that answered only with entries the store should never have handed over is not worth keeping either.
    const unsafe = transportWorld({ now: () => 1_000, ttlMs: 500 });
    unsafe.answer("list", { mode: AgentStoreDirectoryListingMode.COMPLETE_FLAT_STORE, files: [file("../escape.txt")], tombstones: [] });
    await unsafe.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    await unsafe.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    assert.equal(unsafe.calls("list"), 2);
    // A write forgets what was kept of the store, so the listing after it is asked for again.
    const afterWrite = transportWorld({ now: () => 1_000, ttlMs: 500 });
    afterWrite.answer("list", { mode: AgentStoreDirectoryListingMode.COMPLETE_FLAT_STORE, files: [file("a.txt")], tombstones: [] });
    afterWrite.answer("writes", { instructions: [] });
    await afterWrite.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    await afterWrite.transport.presignWrites({ token, storeId: "store-1", files: [{ relPath: "a.txt", sha: "sha", size: 1 }] });
    await afterWrite.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    assert.equal(afterWrite.calls("list"), 2);
    // So does finishing a multipart write.
    const afterComplete = transportWorld({ now: () => 1_000, ttlMs: 500 });
    afterComplete.answer("list", { mode: AgentStoreDirectoryListingMode.COMPLETE_FLAT_STORE, files: [file("a.txt")], tombstones: [] });
    afterComplete.answer("complete", { results: [{ inputIndex: 0, relPath: "a.txt", outcome: { case: "success", value: { etag: "e" } } }] });
    await afterComplete.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    await afterComplete.transport.completeMultipartWrites({ token, storeId: "store-1", completions: [{ context: multipartContext("a.txt"), parts: [] }] });
    await afterComplete.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    assert.equal(afterComplete.calls("list"), 2);
  });

  it("keeps a listing only while it is fresh, and forgets a share's listing when the share changes", async () => {
    let now = 1_000;
    const world = transportWorld({ now: () => now, ttlMs: 500 });
    world.answer("list", { mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: [file("a.txt")], subdirs: [], tombstones: [], nextPageToken: "" });
    await world.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    await world.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    assert.equal(world.calls("list"), 1);
    // Once it is old, the store is asked again.
    now = 1_600;
    await world.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    assert.equal(world.calls("list"), 2);
    // A share's listing is kept for the share it was read through, and forgotten when that share changes.
    world.answer("list", { mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: [file("a.txt")], subdirs: [], tombstones: [], nextPageToken: "" });
    await world.transport.listFiles({ token, storeId: "store-1", shareId: "share-1", relPath: "" });
    world.transport.invalidateListCache({ storeId: "store-1", shareId: "share-1" });
    await world.transport.listFiles({ token, storeId: "store-1", shareId: "share-1", relPath: "" });
    assert.equal(world.calls("list"), 4);
  });

  it("walks the pages of a directory listing and sorts what it found", async () => {
    const world = transportWorld();
    world.answer(
      "list",
      { mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: [file("b.txt")], subdirs: ["z"], tombstones: [], nextPageToken: "page-2" },
      { mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: [file("a.txt")], subdirs: ["y"], tombstones: [{ relPath: "gone.txt", tombstoneEtag: '"T"', deletedAtMs: "2" }], nextPageToken: "" },
    );
    const listing = await world.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    assert.deepEqual([listing.files.map((entry) => entry.relPath), listing.subdirs, listing.tombstones.map((entry) => entry.relPath)], [["a.txt", "b.txt"], ["y", "z"], ["gone.txt"]]);
    // The page size is the store's own, and the second page carries the token the first one answered with.
    assert.deepEqual([world.requests["list"]![0]![0].pageSize, world.requests["list"]![0]![0].pageToken, world.requests["list"]![1]![0].pageToken], [1_000, "", "page-2"]);
    // Only the first page asks for the whole store, and the tags and times are read as tags and times.
    assert.deepEqual([world.requests["list"]![1]![0].preferCompleteFlatStore, listing.files[0]!.etag, listing.tombstones[0]!.tombstoneEtag, listing.tombstones[0]!.deletedAtMs], [false, "a.txt-etag", "t", 2]);
  });

  it("refuses a listing that repeats a page, runs past its limits, or grows past what it will hold", async () => {
    const repeated = transportWorld();
    repeated.answer("list", { mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: [], subdirs: [], tombstones: [], nextPageToken: "same" }, { mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: [], subdirs: [], tombstones: [], nextPageToken: "same" });
    await assert.rejects(() => repeated.transport.listFiles({ token, storeId: "store-1", relPath: "" }), /repeated a page token/);
    const tooManyPages = transportWorld();
    tooManyPages.answer("list", ...Array.from({ length: 11 }, (_, index) => ({ mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: [], subdirs: [], tombstones: [], nextPageToken: `page-${index + 2}` })));
    await assert.rejects(() => tooManyPages.transport.listFiles({ token, storeId: "store-1", relPath: "" }), /exceeded 10 pages/);
    const tooManyEntries = transportWorld();
    tooManyEntries.answer("list", { mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: Array.from({ length: 10_001 }, (_, index) => file(`f${index}.txt`)), subdirs: [], tombstones: [], nextPageToken: "" });
    await assert.rejects(() => tooManyEntries.transport.listFiles({ token, storeId: "store-1", relPath: "" }), /exceeded 10000 entries/);
    const tooManyFlatEntries = transportWorld();
    tooManyFlatEntries.answer("list", { mode: AgentStoreDirectoryListingMode.COMPLETE_FLAT_STORE, files: Array.from({ length: 10_001 }, (_, index) => file(`f${index}.txt`)), tombstones: [] });
    await assert.rejects(() => tooManyFlatEntries.transport.listFiles({ token, storeId: "store-1", relPath: "" }), /exceeded 10000 entries/);
  });

  it("stops asking a large store for one flat listing after the first page", async () => {
    const world = transportWorld();
    world.answer(
      "list",
      { mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: [file("a.txt")], subdirs: [], tombstones: [], nextPageToken: "" },
      { mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: [file("a.txt")], subdirs: [], tombstones: [], nextPageToken: "" },
    );
    await world.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    // What was kept is dropped, and the next listing asks the store again — without asking for the whole store.
    world.transport.invalidateListCache({ storeId: "store-1" });
    await world.transport.listFiles({ token, storeId: "store-1", relPath: "" });
    assert.deepEqual([world.requests["list"]![0]![0].preferCompleteFlatStore, world.requests["list"]![1]![0].preferCompleteFlatStore], [true, false]);
  });
});

describe("presigning reads and writes", () => {
  it("asks for the files it was given, with the precondition each one carries", async () => {
    const world = transportWorld();
    world.answer("reads", { instructions: [{ relPath: "a.txt", url: "https://read.invalid/a", expiresAtMs: "9000" }] });
    assert.deepEqual(await world.transport.presignReads({ token, storeId: "store-1", relPaths: ["a.txt"] }), [{ relPath: "a.txt", url: "https://read.invalid/a", expiresAtMs: 9_000 }]);
    assert.deepEqual([world.requests["reads"]![0]![0].storeId, world.requests["reads"]![0]![0].relPaths, world.requests["reads"]![0]![1].headers], ["store-1", ["a.txt"], { "x-agent-store-token": "token-1" }]);
    // A share is asked for by its own id.
    world.answer("reads", { instructions: [] });
    await world.transport.presignReads({ token, storeId: "store-1", shareId: "share-1", relPaths: [] });
    assert.equal(world.requests["reads"]![1]![0].shareId, "share-1");
    world.answer("writes", { instructions: [] });
    await world.transport.presignWrites({ token, storeId: "store-1", files: [{ relPath: "a.txt", sha: "sha", size: 12, baseEtag: '"ETAG"' }, { relPath: "b.txt", sha: "sha", size: 3, expectAbsent: true }] });
    const entries = world.requests["writes"]![0]![0].files;
    assert.deepEqual([entries[0].relPath, entries[0].sizeBytes, entries[0].precondition.case, entries[0].precondition.value], ["a.txt", 12n, "baseEtag", "etag"]);
    assert.deepEqual([entries[1].precondition.case, entries[1].precondition.value], ["expectAbsent", true]);
  });

  it("refuses a write that says two things about the same file, and one with no tag to write against", async () => {
    const world = transportWorld();
    await assert.rejects(() => world.transport.presignWrites({ token, storeId: "store-1", files: [{ relPath: "a.txt", sha: "sha", size: 1, baseEtag: "etag", expectAbsent: true }] }), /mutually exclusive/);
    await assert.rejects(() => world.transport.presignWrites({ token, storeId: "store-1", files: [{ relPath: "a.txt", sha: "sha", size: 1, baseEtag: "" }] }), /empty baseEtag/);
    assert.equal(world.calls("writes"), 0);
  });

  it("makes of a write instruction what the sync engine reads, including its multipart side", async () => {
    const world = transportWorld();
    world.answer("writes", {
      instructions: [{
        relPath: "a.txt",
        url: "https://write.invalid/a",
        headers: { "x-extra": "1" },
        expiresAtMs: "9000",
        multipart: { context: multipartContext("a.txt"), parts: [{ partNumber: 1, url: "https://part.invalid/1", headers: { "x-part": "1" }, offsetBytes: "0", sizeBytes: "1600" }], partUrlsExpiresAtMs: "9500" },
        primaryPreconditionFailed: true,
        lockRedirect: { conflictRelPath: "a.lock", lockExpiresAtMs: "9100" },
        conflict: { relPath: "a (conflict).txt", url: "https://write.invalid/conflict", headers: {}, expiresAtMs: "9200" },
      }],
    });
    const [instruction] = await world.transport.presignWrites({ token, storeId: "store-1", files: [{ relPath: "a.txt", sha: "sha-1", size: 3_000 }] });
    assert.deepEqual(
      [instruction!.relPath, instruction!.url, instruction!.headers, instruction!.expiresAtMs, instruction!.primaryPreconditionFailed, instruction!.lockRedirect, instruction!.conflict?.relPath],
      ["a.txt", "https://write.invalid/a", { "x-extra": "1" }, 9_000, true, { conflictRelPath: "a.lock", lockExpiresAtMs: 9_100 }, "a (conflict).txt"],
    );
    assert.deepEqual(
      [instruction!.multipart!.context.uploadId, instruction!.multipart!.context.sizeBytes, instruction!.multipart!.context.precondition, instruction!.multipart!.parts[0]!.offsetBytes, instruction!.multipart!.partUrlsExpiresAtMs],
      ["upload-1", 3_000, { case: "baseEtag", value: "base" }, 0, 9_500],
    );
  });

  it("refuses a write instruction for a file nobody asked about, and one with no context", async () => {
    const missing = transportWorld();
    missing.answer("writes", { instructions: [{ relPath: "a.txt", url: "u", headers: {}, expiresAtMs: "1" }, { relPath: "nobody-asked.txt", url: "u", headers: {}, expiresAtMs: "1" }] });
    await assert.rejects(() => missing.transport.presignWrites({ token, storeId: "store-1", files: [{ relPath: "a.txt", sha: "sha", size: 1 }] }), /missing requested file/);
    const contextless = transportWorld();
    contextless.answer("writes", { instructions: [{ relPath: "a.txt", url: "u", headers: {}, expiresAtMs: "1", multipart: { parts: [], partUrlsExpiresAtMs: "2" } }] });
    await assert.rejects(() => contextless.transport.presignWrites({ token, storeId: "store-1", files: [{ relPath: "a.txt", sha: "sha", size: 1 }] }), AgentStoreProtocolError);
  });
});

describe("finishing and abandoning multipart writes", () => {
  it("pairs each answer with the write it belongs to, whatever order they came in", async () => {
    const world = transportWorld();
    world.answer("complete", { results: [
      { inputIndex: 1, relPath: "b.txt", outcome: { case: "failure", value: { code: AgentStoreMultipartOperationFailureCode.PRECONDITION_FAILED } } },
      { inputIndex: 0, relPath: "a.txt", outcome: { case: "success", value: { etag: '"ETAG"' } } },
    ] });
    const results = await world.transport.completeMultipartWrites({ token, storeId: "store-1", completions: [{ context: multipartContext("a.txt"), parts: [{ partNumber: 1, etag: "e", checksumSha256: new Uint8Array([1]) }] }, { context: multipartContext("b.txt"), parts: [] }] });
    assert.deepEqual(results, [{ kind: "success", relPath: "a.txt", etag: "etag" }, { kind: "failure", relPath: "b.txt", code: "precondition_failed" }]);
    // The listing that was kept is forgotten before and after a completion, so the next one is fresh.
    assert.equal(world.calls("complete"), 1);
    world.answer("abort", { results: [{ inputIndex: 0, relPath: "a.txt", outcome: { case: "success", value: { alreadyFinished: true } } }] });
    assert.deepEqual(await world.transport.abortMultipartWrites({ token, storeId: "store-1", uploads: [{ context: multipartContext("a.txt") }] }), [{ kind: "success", relPath: "a.txt", alreadyFinished: true }]);
  });

  it("refuses an answer that is out of range, repeated, for another file, or missing", async () => {
    const outOfRange = transportWorld();
    outOfRange.answer("complete", { results: [{ inputIndex: 5, relPath: "a.txt", outcome: { case: "success", value: { etag: "e" } } }] });
    await assert.rejects(() => outOfRange.transport.completeMultipartWrites({ token, storeId: "store-1", completions: [{ context: multipartContext("a.txt"), parts: [] }] }), /out-of-range inputIndex/);
    const repeated = transportWorld();
    repeated.answer("complete", { results: [{ inputIndex: 0, relPath: "a.txt", outcome: { case: "success", value: { etag: "e" } } }, { inputIndex: 0, relPath: "a.txt", outcome: { case: "success", value: { etag: "e" } } }] });
    await assert.rejects(() => repeated.transport.completeMultipartWrites({ token, storeId: "store-1", completions: [{ context: multipartContext("a.txt"), parts: [] }] }), /repeated inputIndex/);
    const mismatched = transportWorld();
    mismatched.answer("abort", { results: [{ inputIndex: 0, relPath: "other.txt", outcome: { case: "success", value: {} } }] });
    await assert.rejects(() => mismatched.transport.abortMultipartWrites({ token, storeId: "store-1", uploads: [{ context: multipartContext("a.txt") }] }), /relPath mismatch/);
    const missing = transportWorld();
    missing.answer("abort", { results: [] });
    await assert.rejects(() => missing.transport.abortMultipartWrites({ token, storeId: "store-1", uploads: [{ context: multipartContext("a.txt") }] }), /missing result/);
  });

  it("names every failure the store can answer with, and calls the unnamed ones internal", async () => {
    const world = transportWorld();
    const codes = [
      AgentStoreMultipartOperationFailureCode.UNSPECIFIED,
      AgentStoreMultipartOperationFailureCode.PRECONDITION_FAILED,
      AgentStoreMultipartOperationFailureCode.UPLOAD_NOT_FOUND,
      AgentStoreMultipartOperationFailureCode.INVALID_PARTS,
      AgentStoreMultipartOperationFailureCode.CHECKSUM_MISMATCH,
      AgentStoreMultipartOperationFailureCode.TRANSIENT,
      AgentStoreMultipartOperationFailureCode.INTERNAL,
      AgentStoreMultipartOperationFailureCode.RESTART_REQUIRED,
      999,
    ];
    world.answer("complete", { results: codes.map((code, index) => ({ inputIndex: index, relPath: `f${index}.txt`, outcome: { case: "failure", value: { code } } })) });
    const results = await world.transport.completeMultipartWrites({ token, storeId: "store-1", completions: codes.map((_, index) => ({ context: multipartContext(`f${index}.txt`), parts: [] })) });
    assert.deepEqual(results.map((result) => result.code), ["internal", "precondition_failed", "upload_not_found", "invalid_parts", "checksum_mismatch", "transient", "internal", "restart_required", "unknown"]);
    // An answer with no outcome at all is an internal failure rather than a silent success.
    const empty = transportWorld();
    empty.answer("complete", { results: [{ inputIndex: 0, relPath: "a.txt", outcome: { case: undefined } }] });
    assert.deepEqual((await empty.transport.completeMultipartWrites({ token, storeId: "store-1", completions: [{ context: multipartContext("a.txt"), parts: [] }] }))[0], { kind: "failure", relPath: "a.txt", code: "internal" });
  });
});

describe("deleting files", () => {
  it("reads each answer as what became of the file", async () => {
    const world = transportWorld();
    world.answer("delete", { results: [
      { relPath: "a.txt", status: AgentStoreDeleteFileStatus.DELETED, tombstoneEtag: '"T1"' },
      { relPath: "b.txt", status: AgentStoreDeleteFileStatus.ALREADY_DELETED, tombstoneEtag: "" },
      { relPath: "c.txt", status: AgentStoreDeleteFileStatus.CONFLICT, currentEtag: '"C1"' },
    ] });
    world.answer("delete", { results: [{ relPath: "/dir\\a.txt", status: AgentStoreDeleteFileStatus.DELETED, tombstoneEtag: '"T1"' }] });
    assert.deepEqual(await world.transport.deleteFiles({ token, storeId: "store-1", files: [{ relPath: "a.txt", baseEtag: "e1" }] }), [{ relPath: "dir/a.txt", status: "deleted", tombstoneEtag: "t1" }]);
    world.answer("delete", { results: [
      { relPath: "a.txt", status: AgentStoreDeleteFileStatus.DELETED, tombstoneEtag: '"T1"' },
      { relPath: "b.txt", status: AgentStoreDeleteFileStatus.ALREADY_DELETED, tombstoneEtag: "" },
      { relPath: "c.txt", status: AgentStoreDeleteFileStatus.CONFLICT, currentEtag: '"C1"' },
    ] });
    assert.deepEqual(await world.transport.deleteFiles({ token, storeId: "store-1", files: [{ relPath: "a.txt", baseEtag: "e1" }, { relPath: "b.txt", baseEtag: "e2" }, { relPath: "c.txt", baseEtag: "e3" }] }), [
      { relPath: "a.txt", status: "deleted", tombstoneEtag: "t1" },
      { relPath: "b.txt", status: "already_deleted" },
      { relPath: "c.txt", status: "conflict", currentEtag: "c1" },
    ]);
    // A delete with no tag to delete against is refused before anything is sent.
    await assert.rejects(() => world.transport.deleteFiles({ token, storeId: "store-1", files: [{ relPath: "a.txt", baseEtag: "" }] }), /empty baseEtag/);
  });

  it("refuses a delete the store did not decide", async () => {
    const unspecified = transportWorld();
    unspecified.answer("delete", { results: [{ relPath: "a.txt", status: AgentStoreDeleteFileStatus.UNSPECIFIED }] });
    await assert.rejects(() => unspecified.transport.deleteFiles({ token, storeId: "store-1", files: [{ relPath: "a.txt", baseEtag: "e1" }] }), /UNSPECIFIED status/);
    const unknown = transportWorld();
    unknown.answer("delete", { results: [{ relPath: "a.txt", status: 99 }] });
    await assert.rejects(() => unknown.transport.deleteFiles({ token, storeId: "store-1", files: [{ relPath: "a.txt", baseEtag: "e1" }] }), /unknown status/);
  });
});

describe("what a failed call means, and what a caller can stop", () => {
  it("raises an unauthorized store as its own error, and leaves the rest as they were", async () => {
    const world = transportWorld();
    world.answer("list", new ConnectError("no token", Code.Unauthenticated));
    await assert.rejects(() => world.transport.listFiles({ token, storeId: "store-1", relPath: "" }), AgentStoreUnauthorizedError);
    const denied = transportWorld();
    denied.answer("reads", new ConnectError("not yours", Code.PermissionDenied));
    await assert.rejects(() => denied.transport.presignReads({ token, storeId: "store-1", relPaths: ["a.txt"] }), AgentStoreUnauthorizedError);
    const other = transportWorld();
    other.answer("mint", new ConnectError("busy", Code.Unavailable));
    await assert.rejects(() => other.transport.mintToken({ kind: "store", storeId: "store-1" }), (error: unknown) => error instanceof ConnectError && error.code === Code.Unavailable);
  });

  it("stops when the caller stops, and times out when the store takes too long", async () => {
    const world = transportWorld();
    world.answer("list", new Promise(() => {}) as never);
    const controller = new AbortController();
    const pending = world.transport.listFiles({ token, storeId: "store-1", relPath: "", signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, (error: unknown) => error instanceof ConnectError && error.code === Code.Canceled);
    // A call already stopped is not sent at all.
    const stopped = new AbortController();
    stopped.abort();
    const already = transportWorld();
    already.answer("list", { mode: AgentStoreDirectoryListingMode.DIRECTORY_PAGE, files: [], subdirs: [], tombstones: [], nextPageToken: "" });
    // A call that was stopped before it was made is refused with the reason the caller stopped it for.
    await assert.rejects(() => already.transport.listFiles({ token, storeId: "store-1", relPath: "", signal: stopped.signal }), (error: unknown) => error instanceof Error && error.name === "AbortError");
    // A store that never answers runs into the transport's own deadline.
    const timed = transportWorld({ rpcTimeoutMs: 5 });
    timed.answer("mint", new Promise(() => {}) as never);
    await assert.rejects(() => timed.transport.mintToken({ kind: "store", storeId: "store-1" }), (error: unknown) => error instanceof ConnectError && error.code === Code.DeadlineExceeded);
    // A call that answers with an abort-shaped error after the deadline is the deadline's, not the store's.
    const late = transportWorld({ rpcTimeoutMs: 5 });
    late.answer("mint", new Promise((_, reject) => setTimeout(() => reject(new ConnectError("canceled", Code.Canceled)), 25)) as never);
    await assert.rejects(() => late.transport.mintToken({ kind: "store", storeId: "store-1" }), (error: unknown) => error instanceof ConnectError && error.code === Code.DeadlineExceeded);
  });
});
