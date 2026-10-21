/**
 * Where a box's store lives: the platform's own service (what it presigns, how a multipart write goes up, what a lost
 * race means), the agent store behind it, the plain-directory store, and the policy that picks between them.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
import { BoxStoreCanonicalWriteConflictError } from "../../source/host/boxes/box-store-sync/object-store-port.ts";
import { BoxStoreSyncError } from "../../source/host/boxes/box-store-sync/box-store-sync-error.ts";
import { SlateInvariantViolation } from "../../source/shared/invariant.ts";
import {
  createSlateBoxStoreServiceClient,
  planSlateBoxStoreMultipartParts,
  SlateBoxStoreServiceObjectStore,
  SlateBoxStoreServiceProvider,
  READ_PRESIGN_BATCH_MAX,
  SLATE_BOX_STORE_MULTIPART_PART_SIZE_BYTES,
  type SlateBoxStoreServiceClient,
  type SlateBoxStoreWriteInstruction,
} from "../../source/host/boxes/box-store-sync/slate-box-store-files.ts";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** A loopback object store: it writes down every request and answers the statuses it was told to. */
function objectServer(answers: Array<number | { status: number; etag?: string }>) {
  const requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  let index = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      const answer = answers.length === 0 ? 200 : answers.length === 1 ? answers[0]! : (answers[index++] ?? answers.at(-1)!);
      const status = typeof answer === "number" ? answer : answer.status;
      const etag = typeof answer === "number" ? undefined : answer.etag;
      response.writeHead(status, etag === undefined ? {} : { etag });
      response.end();
    });
  });
  return {
    requests,
    start: async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return `http://127.0.0.1:${port}`;
    },
    stop: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The platform's service, as this box reads it. */
function serviceWorld(options: { reads?: Array<{ relPath: string; url: string; expiresAtMs: number }>; stat?: { exists: boolean; etag: string }; writes?: SlateBoxStoreWriteInstruction[]; complete?: Array<unknown | Error>; list?: Array<{ entries: Array<{ relPath: string }>; truncated: boolean; nextCursor: string }> } = {}) {
  const calls: string[] = [];
  const presignedFiles: unknown[] = [];
  const aborts: unknown[] = [];
  const completions: unknown[] = [];
  const writeQueue = [...(options.writes ?? [])];
  const completeQueue = [...(options.complete ?? [])];
  const listQueue = [...(options.list ?? [])];
  const client: SlateBoxStoreServiceClient = {
    presignSandBoxStoreReads: async (args) => {
      calls.push(`reads:${args.relPaths.join(",")}`);
      return { instructions: options.reads ?? args.relPaths.map((relPath) => ({ relPath, url: `https://object.invalid/${relPath}`, expiresAtMs: Date.now() + 600_000 })) };
    },
    statSandBoxStoreObject: async (args) => {
      calls.push(`stat:${args.relPath}`);
      return options.stat ?? { exists: false, etag: "" };
    },
    presignSandBoxStoreWrites: async (args) => {
      calls.push(`writes:${args.files.length}`);
      presignedFiles.push(...args.files);
      const instructions = args.files.map((file) => (writeQueue.length === 0 ? { relPath: file.relPath, url: `https://object.invalid/${file.relPath}`, headers: { "x-store": "1" } } : writeQueue.length === 1 ? writeQueue[0]! : writeQueue.shift()!));
      return { instructions };
    },
    completeSandBoxStoreMultipartWrites: async (args) => {
      calls.push("complete");
      completions.push(args);
      const answer = completeQueue.length === 0 ? { results: [{ outcome: { case: "success", value: {} } }] } : completeQueue.length === 1 ? completeQueue[0]! : completeQueue.shift()!;
      if (answer instanceof Error) throw answer;
      return answer as never;
    },
    abortSandBoxStoreMultipartWrites: async (args) => {
      calls.push("abort");
      aborts.push(args);
      return {};
    },
    listSandBoxStoreObjects: async (args) => {
      calls.push(`list:${args.prefix}:${args.cursor}`);
      return listQueue.length === 0 ? { entries: [], truncated: false, nextCursor: "" } : listQueue.length === 1 ? listQueue[0]! : listQueue.shift()!;
    },
  };
  return { client, calls, presignedFiles, aborts, completions };
}

describe("planning a file into parts", () => {
  it("hashes every part and the whole file as it reads it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-multipart-"));
    try {
      const srcPath = join(directory, "a.bin");
      writeFileSync(srcPath, "0123456789", "utf8");
      const plan = await planSlateBoxStoreMultipartParts(srcPath, 10, 4);
      assert.deepEqual(plan.parts.map((part) => [part.partNumber, part.offsetBytes, part.sizeBytes, part.sha256]), [
        [1, 0, 4, sha("0123")],
        [2, 4, 4, sha("4567")],
        [3, 8, 2, sha("89")],
      ]);
      assert.equal(plan.wholeSha256, sha("0123456789"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a plan for a size that is not a size, and one whose file changed under it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-multipart-"));
    try {
      const srcPath = join(directory, "a.bin");
      writeFileSync(srcPath, "0123456789", "utf8");
      await assert.rejects(() => planSlateBoxStoreMultipartParts(srcPath, 0, 4), /positive size/);
      await assert.rejects(() => planSlateBoxStoreMultipartParts(srcPath, 10, 0), /positive part size/);
      await assert.rejects(() => planSlateBoxStoreMultipartParts(srcPath, 11, 4), /the file changed under the plan/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the service's client", () => {
  it("takes the client it was given, and has no transport of its own to build", () => {
    const world = serviceWorld();
    assert.equal(createSlateBoxStoreServiceClient({ client: world.client }), world.client);
    assert.throws(() => createSlateBoxStoreServiceClient({ getAccessToken: async () => "t" }), /requires a transport this host does not build yet/);
  });
});

describe("reading through the service", () => {
  it("uses a prefetched url once, and presigns again once it is old", async () => {
    const world = serviceWorld();
    const store = new SlateBoxStoreServiceObjectStore(world.client);
    const fetcher = fetchWorld([{ body: "hello" }, { body: "hello again" }, { body: "fresh" }]);
    try {
      await store.prefetchReads(["a.txt"]);
      assert.deepEqual(await store.get("a.txt"), new TextEncoder().encode("hello"));
      // The url was used once: the next read is presigned for itself.
      assert.deepEqual(await store.get("a.txt"), new TextEncoder().encode("hello again"));
      assert.deepEqual(world.calls.filter((call) => call.startsWith("reads")), ["reads:a.txt", "reads:a.txt"]);
      // A url with no time left on it is not used at all.
      const stale = serviceWorld({ reads: [{ relPath: "b.txt", url: "https://object.invalid/b.txt", expiresAtMs: Date.now() + 1_000 }] });
      const staleStore = new SlateBoxStoreServiceObjectStore(stale.client);
      await staleStore.prefetchReads(["b.txt"]);
      assert.deepEqual(await staleStore.get("b.txt"), new TextEncoder().encode("fresh"));
      assert.deepEqual(stale.calls.filter((call) => call.startsWith("reads")), ["reads:b.txt", "reads:b.txt"]);
      // A prefetched url that failed falls back to a fresh one.
      const failing = serviceWorld();
      const failingStore = new SlateBoxStoreServiceObjectStore(failing.client);
      const flaky = fetchWorld([{ fail: true }, { body: "after the failure" }]);
      try {
        await failingStore.prefetchReads(["c.txt"]);
        assert.deepEqual(await failingStore.get("c.txt"), new TextEncoder().encode("after the failure"));
      } finally {
        flaky.restore();
      }
      // A read the service did not presign for is nothing to read.
      const empty = serviceWorld({ reads: [] });
      assert.equal(await new SlateBoxStoreServiceObjectStore(empty.client).get("d.txt"), null);
    } finally {
      fetcher.restore();
    }
  });

  it("asks for prefetched urls in the batches the service will take", async () => {
    const world = serviceWorld();
    const store = new SlateBoxStoreServiceObjectStore(world.client);
    // 501 keys is one full batch of 500 and one leftover: the service is never asked for more than it takes.
    await store.prefetchReads(Array.from({ length: READ_PRESIGN_BATCH_MAX + 1 }, (_, index) => `k${index}.txt`));
    assert.deepEqual(world.calls.map((call) => call.slice("reads:".length).split(",").length), [READ_PRESIGN_BATCH_MAX, 1]);
  });

  it("reads into a file through the same urls", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-store-read-"));
    const world = serviceWorld();
    const store = new SlateBoxStoreServiceObjectStore(world.client);
    const fetcher = fetchWorld([{ body: "hello there" }]);
    try {
      const destPath = join(directory, "nested", "a.txt");
      assert.equal(await store.getToFile("a.txt", destPath), 11);
      assert.equal(readFileSync(destPath, "utf8"), "hello there");
      await assert.rejects(() => store.getToFile("b.txt", join(directory, "b.txt"), { maxBytes: 4 }), /exceeded 4B/);
    } finally {
      fetcher.restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("writing through the service", () => {
  it("bases a write on what the session knows, or on what the service's stat says", async () => {
    const session = serviceWorld();
    const sessionStore = new SlateBoxStoreServiceObjectStore(session.client);
    const first = fetchWorld([{ status: 200, etag: '"E1"' }]);
    try {
      await sessionStore.put("a.txt", new TextEncoder().encode("one"));
      // The first write had nothing to base itself on, so it asked the service.
      assert.deepEqual(session.presignedFiles[0], { relPath: "a.txt", sha256: sha("one"), sizeBytes: 3n, contentAddressed: false, ifMatchEtag: "", expectAbsent: true });
      // The second one knows the etag the first answered with, so it does not ask again.
      await sessionStore.put("a.txt", new TextEncoder().encode("two"));
      assert.deepEqual([session.presignedFiles[1], session.calls.filter((call) => call.startsWith("stat"))], [{ relPath: "a.txt", sha256: sha("two"), sizeBytes: 3n, contentAddressed: false, ifMatchEtag: "E1", expectAbsent: false }, ["stat:a.txt"]]);
    } finally {
      first.restore();
    }
    // A store that says the object is there is what the write is based on.
    const probed = serviceWorld({ stat: { exists: true, etag: "etag-1" } });
    const second = fetchWorld([{ status: 200, etag: '"E"' }]);
    try {
      await new SlateBoxStoreServiceObjectStore(probed.client).put("a.txt", new TextEncoder().encode("one"));
      assert.deepEqual([probed.presignedFiles[0]!["ifMatchEtag" as never], probed.presignedFiles[0]!["expectAbsent" as never]], ["etag-1", false]);
    } finally {
      second.restore();
    }
    // An object that exists without an etag is no baseline at all.
    const etagless = serviceWorld({ stat: { exists: true, etag: "" } });
    const third = fetchWorld();
    try {
      await assert.rejects(() => new SlateBoxStoreServiceObjectStore(etagless.client).put("a.txt", new TextEncoder().encode("one")), /stat carried no etag/);
      assert.deepEqual(third.calls, []);
    } finally {
      third.restore();
    }
  });

  it("forgets what it knew when a race is lost, and when a write answers with no etag", async () => {
    // A write that answered with an etag is what the next write is based on, until a race is lost: then the next
    // write asks the service again instead of trusting what it knew.
    const world = serviceWorld();
    const store = new SlateBoxStoreServiceObjectStore(world.client);
    const fetcher = fetchWorld([{ status: 200, etag: '"E1"' }, { status: 412 }, { status: 200, etag: '"E3"' }]);
    try {
      await store.put("a.txt", new TextEncoder().encode("one"));
      assert.deepEqual(world.calls.filter((call) => call.startsWith("stat")), ["stat:a.txt"]);
      await assert.rejects(() => store.put("a.txt", new TextEncoder().encode("two")), (error: unknown) => error instanceof BoxStoreCanonicalWriteConflictError);
      await store.put("a.txt", new TextEncoder().encode("three"));
      assert.deepEqual(world.calls.filter((call) => call.startsWith("stat")), ["stat:a.txt", "stat:a.txt"]);
    } finally {
      fetcher.restore();
    }
    // A write that answered with no etag leaves nothing to write against, so the next one probes again.
    const etagless = serviceWorld();
    const second = fetchWorld([{ status: 200 }, { status: 200 }]);
    try {
      const store = new SlateBoxStoreServiceObjectStore(etagless.client);
      await store.put("a.txt", new TextEncoder().encode("one"));
      await store.put("a.txt", new TextEncoder().encode("two"));
      assert.deepEqual(etagless.calls.filter((call) => call.startsWith("stat")), ["stat:a.txt", "stat:a.txt"]);
      assert.deepEqual((etagless.presignedFiles as Array<Record<string, unknown>>).map((file) => [file["ifMatchEtag"], file["expectAbsent"]]), [["", true], ["", true]]);
    } finally {
      second.restore();
    }
  });

  it("calls a lost race a conflict, and forgets what it knew about the file", async () => {
    const world = serviceWorld();
    const store = new SlateBoxStoreServiceObjectStore(world.client);
    const fetcher = fetchWorld([{ status: 412 }, { status: 412 }]);
    try {
      await assert.rejects(
        () => store.put("a.txt", new TextEncoder().encode("one")),
        (error: unknown) => error instanceof BoxStoreCanonicalWriteConflictError && error.key === "a.txt" && error.baseEtag === null && error.baselineSource === "absent",
      );
    } finally {
      fetcher.restore();
    }
    // A write that collided on the object store itself is tried once more before it is called a conflict.
    const retried = serviceWorld();
    const second = fetchWorld([{ status: 409 }, { status: 200, etag: '"E"' }]);
    try {
      await new SlateBoxStoreServiceObjectStore(retried.client).put("a.txt", new TextEncoder().encode("one"));
      assert.deepEqual(second.calls.map((call) => call.method), ["PUT", "PUT"]);
    } finally {
      second.restore();
    }
    // A write the store would not take for another reason is an error, not a conflict.
    const busy = serviceWorld();
    const third = fetchWorld([{ status: 500 }]);
    try {
      await assert.rejects(() => new SlateBoxStoreServiceObjectStore(busy.client).put("a.txt", new TextEncoder().encode("one")), (error: unknown) => error instanceof BoxStoreSyncError && /failed for a.txt: 500/.test(error.message));
    } finally {
      third.restore();
    }
  });

  it("writes an object it names by its content, and takes a refusal that says it is there", async () => {
    const world = serviceWorld();
    const store = new SlateBoxStoreServiceObjectStore(world.client);
    const fetcher = fetchWorld([{ status: 200 }, { status: 412 }]);
    try {
      await store.put("a.txt", new TextEncoder().encode("one"), { contentAddressed: true });
      assert.equal(world.presignedFiles[0]!["contentAddressed" as never], true);
      await store.put("a.txt", new TextEncoder().encode("one"), { contentAddressed: true });
    } finally {
      fetcher.restore();
    }
  });
});

describe("writing a file through the service", () => {
  it("streams a file that is under the threshold, and takes a refusal that says it is there", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-store-put-"));
    const server = objectServer([200, 412, 500]);
    try {
      const base = await server.start();
      const world = serviceWorld({ writes: [{ relPath: "a.txt", url: `${base}/a.txt`, headers: { "x-store": "1" } }] });
      const store = new SlateBoxStoreServiceObjectStore(world.client);
      const srcPath = join(directory, "a.txt");
      writeFileSync(srcPath, "hello", "utf8");
      await store.putFromFile("a.txt", srcPath, sha("hello"), 5);
      assert.deepEqual([server.requests[0]!.method, server.requests[0]!.body, server.requests[0]!.headers["content-length"]], ["PUT", "hello", "5"]);
      await store.putFromFile("a.txt", srcPath, sha("hello"), 5);
      await assert.rejects(() => store.putFromFile("a.txt", srcPath, sha("hello"), 5), /failed for a.txt: 500/);
      // A file past the object store's single-PUT maximum, with a threshold high enough that no multipart write is
      // planned, has nowhere to go.
      const huge = serviceWorld();
      const noMultipart = new SlateBoxStoreServiceObjectStore(huge.client, 6 * 1024 * 1024 * 1024, 4);
      await assert.rejects(() => noMultipart.putFromFile("a.txt", srcPath, sha("hello"), 5 * 1024 * 1024 * 1024 + 1), /over the S3 single-PUT maximum/);
    } finally {
      await server.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uploads a large file in parts, and finishes the upload with a bounded number of attempts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-store-multipart-"));
    const server = objectServer([{ status: 200, etag: '"PART-1"' }, { status: 200, etag: '"PART-2"' }, { status: 200, etag: '"PART-3"' }]);
    try {
      const base = await server.start();
      const srcPath = join(directory, "big.bin");
      writeFileSync(srcPath, "0123456789", "utf8");
      const world = serviceWorld({
        writes: [{ relPath: "big.bin", url: `${base}/big.bin`, headers: {}, multipart: { context: { uploadId: "u1" }, parts: [
          { partNumber: 1, offsetBytes: 0n, sizeBytes: 4n, url: `${base}/part-1`, headers: {} },
          { partNumber: 2, offsetBytes: 4n, sizeBytes: 4n, url: `${base}/part-2`, headers: {} },
          { partNumber: 3, offsetBytes: 8n, sizeBytes: 2n, url: `${base}/part-3`, headers: {} },
        ] } }],
        complete: [{ results: [{ outcome: { case: "failure", value: { code: 5 } } }] }, { results: [{ outcome: { case: "success", value: {} } }] }],
      });
      // The threshold is lowered so a ten-byte file is a multipart upload.
      const store = new SlateBoxStoreServiceObjectStore(world.client, 5, 4);
      await store.putFromFile("big.bin", srcPath, sha("0123456789"), 10);
      // Every part went up from its own range, and the completion was tried again after the transient failure.
      assert.deepEqual(server.requests.map((request) => [request.url, request.body]), [["/part-1", "0123"], ["/part-2", "4567"], ["/part-3", "89"]]);
      assert.deepEqual([world.calls.filter((call) => call === "complete").length, world.aborts.length], [2, 0]);
      // Every part went up with its own length, so the object store never has to guess what a part is.
      assert.deepEqual(server.requests.map((request) => request.headers["content-length"]), ["4", "4", "2"]);
      // The parts the upload named are the ones it uploaded, with the etags the object store answered.
      assert.deepEqual((world.completions[0] as { completions: Array<{ parts: unknown }> }).completions[0]!.parts, [
        { partNumber: 1, etag: "PART-1" },
        { partNumber: 2, etag: "PART-2" },
        { partNumber: 3, etag: "PART-3" },
      ]);
    } finally {
      await server.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tries a refused part once more, and refuses a part that answers with no etag", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-store-multipart-"));
    // The first answer for the part is a refusal and the second one is the part itself.
    const server = objectServer([{ status: 500 }, { status: 200, etag: '"P-1"' }]);
    try {
      const base = await server.start();
      const srcPath = join(directory, "big.bin");
      writeFileSync(srcPath, "0123", "utf8");
      const instruction = { relPath: "big.bin", url: `${base}/big.bin`, headers: {}, multipart: { context: { uploadId: "u1" }, parts: [{ partNumber: 1, offsetBytes: 0n, sizeBytes: 4n, url: `${base}/part-1`, headers: {} }] } };
      const world = serviceWorld({ writes: [instruction] });
      await new SlateBoxStoreServiceObjectStore(world.client, 1, 4).putFromFile("big.bin", srcPath, sha("0123"), 4);
      assert.deepEqual([server.requests.map((request) => request.url), world.completions.length], [["/part-1", "/part-1"], 1]);
    } finally {
      await server.stop();
      rmSync(directory, { recursive: true, force: true });
    }
    // A part the object store accepted but could not name cannot be finished, so the upload is abandoned.
    const secondDirectory = mkdtempSync(join(tmpdir(), "slate-store-multipart-"));
    const etaglessServer = objectServer([{ status: 200 }]);
    try {
      const base = await etaglessServer.start();
      const srcPath = join(secondDirectory, "etagless.bin");
      writeFileSync(srcPath, "0123", "utf8");
      const world = serviceWorld({ writes: [{ relPath: "big.bin", url: `${base}/big.bin`, headers: {}, multipart: { context: { uploadId: "u1" }, parts: [{ partNumber: 1, offsetBytes: 0n, sizeBytes: 4n, url: `${base}/part-1`, headers: {} }] } }] });
      await assert.rejects(() => new SlateBoxStoreServiceObjectStore(world.client, 1, 4).putFromFile("big.bin", srcPath, sha("0123"), 4), /multipart part 1 for big.bin returned no etag/);
      assert.deepEqual([world.calls.filter((call) => call === "complete").length, world.aborts.length], [0, 1]);
    } finally {
      await etaglessServer.stop();
      rmSync(secondDirectory, { recursive: true, force: true });
    }
  });

  it("abandons an upload it cannot finish, and does not let the abandoning hide the failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-store-multipart-"));
    const server = objectServer([{ status: 200, etag: '"P"' }]);
    try {
      const base = await server.start();
      const srcPath = join(directory, "big.bin");
      writeFileSync(srcPath, "0123", "utf8");
      const instruction = { relPath: "big.bin", url: `${base}/big.bin`, headers: {}, multipart: { context: { uploadId: "u1" }, parts: [{ partNumber: 1, offsetBytes: 0n, sizeBytes: 4n, url: `${base}/part-1`, headers: {} }] } };
      // A failure the service does not call transient is not tried again, and the upload is abandoned.
      const refused = serviceWorld({ writes: [instruction], complete: [{ results: [{ outcome: { case: "failure", value: { code: 2 } } }] }] });
      await assert.rejects(() => new SlateBoxStoreServiceObjectStore(refused.client, 1, 4).putFromFile("big.bin", srcPath, sha("0123"), 4), /multipart complete failed for big.bin: UPLOAD_NOT_FOUND/);
      // A failure the service does not call transient is asked about once, not three times.
      assert.deepEqual([refused.aborts.length, refused.calls.filter((call) => call === "complete").length], [1, 1]);
      // An upload the service says is already there is finished as far as this write is concerned.
      const already = serviceWorld({ writes: [instruction], complete: [{ results: [{ outcome: { case: "failure", value: { code: 1 } } }] }] });
      await new SlateBoxStoreServiceObjectStore(already.client, 1, 4).putFromFile("big.bin", srcPath, sha("0123"), 4);
      assert.deepEqual([already.aborts.length, already.calls.filter((call) => call === "complete").length], [0, 1]);
      // An upload that cannot be finished after its attempts is abandoned, and a failing abort is swallowed.
      const exhausted = serviceWorld({ writes: [instruction], complete: [{ results: [{ outcome: { case: "failure", value: { code: 5 } } }] }] });
      (exhausted.client as unknown as { abortSandBoxStoreMultipartWrites: () => Promise<never> }).abortSandBoxStoreMultipartWrites = async () => {
        throw new Error("the service did not answer");
      };
      await assert.rejects(() => new SlateBoxStoreServiceObjectStore(exhausted.client, 1, 4).putFromFile("big.bin", srcPath, sha("0123"), 4), /multipart complete failed for big.bin: TRANSIENT/);
      assert.equal(exhausted.calls.filter((call) => call === "complete").length, 3);
      // An instruction with no upload context has nowhere to finish.
      const contextless = serviceWorld({ writes: [{ relPath: "big.bin", url: `${base}/big.bin`, headers: {}, multipart: { context: null, parts: [] } }] });
      await assert.rejects(() => new SlateBoxStoreServiceObjectStore(contextless.client, 1, 4).putFromFile("big.bin", srcPath, sha("0123"), 4), /carries no upload context/);
      // A plan whose hash is not the caller's means the file is not the one that was asked about.
      const mismatched = serviceWorld({ writes: [instruction] });
      await assert.rejects(() => new SlateBoxStoreServiceObjectStore(mismatched.client, 1, 4).putFromFile("big.bin", srcPath, sha("something else"), 4), /but the caller expected/);
    } finally {
      await server.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a presign that answered about another file", async () => {
    const world = serviceWorld({ writes: [{ relPath: "other.txt", url: "https://object.invalid/other.txt", headers: {} }] });
    const fetcher = fetchWorld();
    try {
      await assert.rejects(() => new SlateBoxStoreServiceObjectStore(world.client).put("a.txt", new TextEncoder().encode("one")), /presign returned other.txt for a.txt/);
    } finally {
      fetcher.restore();
    }
  });
});

describe("listing through the service, and what it never does", () => {
  it("follows a listing that was cut short, and stops when it cannot be followed", async () => {
    const world = serviceWorld({ list: [
      { entries: [{ relPath: "a.txt" }], truncated: true, nextCursor: "cursor-2" },
      { entries: [{ relPath: "b.txt" }], truncated: false, nextCursor: "" },
    ] });
    const store = new SlateBoxStoreServiceObjectStore(world.client);
    assert.deepEqual(await store.list("notes"), ["a.txt", "b.txt"]);
    assert.deepEqual(world.calls.filter((call) => call.startsWith("list")), ["list:notes:", "list:notes:cursor-2"]);
    // A page that says it was cut short but cannot name a cursor is the end of it.
    const stuck = serviceWorld({ list: [{ entries: [{ relPath: "a.txt" }], truncated: true, nextCursor: "" }] });
    assert.deepEqual(await new SlateBoxStoreServiceObjectStore(stuck.client).list(""), ["a.txt"]);
  });

  it("is append-only, and says so", async () => {
    const world = serviceWorld();
    await assert.rejects(() => new SlateBoxStoreServiceObjectStore(world.client).delete("a.txt"), (error: unknown) => error instanceof SlateInvariantViolation);
    // The platform's own store is the one that refuses; a directory store deletes like any directory.
    const directory = mkdtempSync(join(tmpdir(), "slate-append-only-"));
    try {
      const local = new LocalFsObjectStore(directory);
      await local.put("a.txt", new TextEncoder().encode("x"));
      await local.delete("a.txt");
      assert.equal(await local.get("a.txt"), null);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serves one store for every id, and takes the client it was given", () => {
    const world = serviceWorld();
    const provider = new SlateBoxStoreServiceProvider({ client: world.client, multipartThresholdBytes: 5, multipartPartSizeBytes: 4 });
    assert.equal(provider.forStore("store-1"), provider.forStore("store-2"));
  });
});

describe("the agent store behind the service", () => {
  /** The agent store's client, with what each call needs to answer; the object store requests are answered by fetch. */
  function agentWorld(options: { reads?: Array<{ relPath: string; url: string }>; writes?: Array<{ relPath: string; url: string; conflict?: { relPath: string; url: string } }> } = {}) {
    const calls: string[] = [];
    const client = {
      presignReads: async (args: { relPaths: readonly string[] }) => {
        calls.push(`reads:${args.relPaths.join(",")}`);
        return args.relPaths.map((relPath) => ({ relPath, url: `https://object.invalid/${relPath}`, expiresAtMs: Date.now() + 600_000, ...(options.reads?.find((read) => read.relPath === relPath) ?? {}) }));
      },
      presignWrites: async (args: { files: readonly { relPath: string; sha: string }[] }) => {
        calls.push(`writes:${args.files.length}`);
        return args.files.map((file) => ({ relPath: file.relPath, url: `https://agent-stores.s3.us-east-1.amazonaws.com/${file.relPath}`, sha: file.sha, headers: { "if-match": "E1" }, ...(options.writes?.find((write) => write.relPath === file.relPath) ?? {}) }));
      },
      listFiles: async () => ({ files: [] }),
    };
    return { client: client as never, calls };
  }

  it("deletes nothing, and keeps a lost race as the caller's to handle", async () => {
    const world = agentWorld();
    const store = new AgentStoreObjectStore(world.client, "store-1", new AgentStoreMutableWriteEtags());
    await assert.rejects(() => store.delete("a.txt"), (error: unknown) => error instanceof SlateInvariantViolation);
    // A write that lost the race is not swallowed here: the caller is told where its own copy was kept.
    const raced = agentWorld({ writes: [{ relPath: "a.txt", url: "https://agent-stores.s3.us-east-1.amazonaws.com/a.txt", conflict: { relPath: "a.txt.conflict-1", url: "https://agent-stores.s3.us-east-1.amazonaws.com/a.txt.conflict-1" } }] });
    const etags = new AgentStoreMutableWriteEtags();
    // What the session knows is what the write is based on, so nothing is probed first.
    etags.set("store-1", "a.txt", "E1");
    const racyStore = new AgentStoreObjectStore(raced.client, "store-1", etags);
    const fetcher = fetchWorld([{ status: 412 }, { status: 200 }]);
    try {
      await assert.rejects(
        () => racyStore.put("a.txt", new TextEncoder().encode("one")),
        (error: unknown) => error instanceof BoxStoreCanonicalWriteConflictError && error.key === "a.txt" && error.conflictRelPath === "a.txt.conflict-1" && error.baselineSource === "session",
      );
      assert.deepEqual(fetcher.calls.map((call) => call.url), ["https://agent-stores.s3.us-east-1.amazonaws.com/a.txt", "https://agent-stores.s3.us-east-1.amazonaws.com/a.txt.conflict-1"]);
      // The etag that lost the race is forgotten, so the next write probes rather than reusing it.
      assert.equal(etags.get("store-1", "a.txt"), undefined);
    } finally {
      fetcher.restore();
    }
  });

  it("reads a prefetched url only while the file is under the cap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-agent-store-read-"));
    const world = agentWorld();
    const store = new AgentStoreObjectStore(world.client, "store-1", new AgentStoreMutableWriteEtags());
    const fetcher = fetchWorld([{ body: "hello there" }, { body: "hello there" }]);
    try {
      await store.prefetchReads(["a.txt"]);
      // The prefetched url is held to the same cap as a fresh one, and nothing is written past it.
      const capped = join(directory, "capped.txt");
      await assert.rejects(() => store.getToFile("a.txt", capped, { maxBytes: 4 }), /exceeded 4B/);
      // The cap stops the copy before the over-sized answer is written anywhere.
      assert.deepEqual(readFileSync(capped, "utf8"), "");
      // The capped answer falls back to a fresh url, which is held to the same cap.
      assert.deepEqual(world.calls, ["reads:a.txt", "reads:a.txt"]);
    } finally {
      fetcher.restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the store as a plain directory", () => {
  it("writes, reads, lists and deletes files under it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-local-store-"));
    try {
      const store = new LocalFsObjectStore(join(directory, "store-1"));
      await store.put("notes/a.txt", new TextEncoder().encode("hello"));
      await store.put("notes/deep/b.txt", new TextEncoder().encode("there"));
      await store.put("other/c.txt", new TextEncoder().encode("elsewhere"));
      assert.deepEqual(await store.get("notes/a.txt"), new TextEncoder().encode("hello"));
      assert.equal(await store.get("missing.txt"), null);
      // A key is listed in key order, not in the order the walk found it: "notes.txt" sorts before "notes/…".
      await store.put("notes.txt", new TextEncoder().encode("beside"));
      assert.deepEqual(await store.list(""), ["notes.txt", "notes/a.txt", "notes/deep/b.txt", "other/c.txt"]);
      await store.delete("notes.txt");
      assert.deepEqual(await store.list("notes"), ["notes/a.txt", "notes/deep/b.txt"]);
      assert.deepEqual(await store.list(""), ["notes/a.txt", "notes/deep/b.txt", "other/c.txt"]);
      // A prefix names a directory: "not" is not under "notes".
      assert.deepEqual(await store.list("not"), []);
      // Reading to a file counts what it wrote, and refuses one over the cap before copying anything.
      assert.equal(await store.getToFile("notes/a.txt", join(directory, "out.txt")), 5);
      await assert.rejects(() => store.getToFile("notes/a.txt", join(directory, "out2.txt"), { maxBytes: 2 }), /over the 2B cap/);
      assert.equal(await store.getToFile("missing.txt", join(directory, "out3.txt")), null);
      // A file can be copied in from anywhere, and a delete of something that is not there is already done.
      await store.putFromFile("copied.txt", join(directory, "out.txt"), "sha", 5);
      assert.equal(readFileSync(join(directory, "store-1", "copied.txt"), "utf8"), "hello");
      await store.delete("copied.txt");
      await store.delete("copied.txt");
      assert.deepEqual(await store.list(""), ["notes/a.txt", "notes/deep/b.txt", "other/c.txt"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("walks a directory without following links out of it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-walk-"));
    try {
      mkdirSync(join(directory, "nested"));
      writeFileSync(join(directory, "nested", "a.txt"), "a", "utf8");
      symlinkSync(join(directory, "nested"), join(directory, "link"));
      const found: string[] = [];
      await walkFiles(directory, found);
      assert.deepEqual(found.map((path) => path.slice(directory.length + 1)), ["nested/a.txt"]);
      // A directory that is not there holds no files.
      const missing: string[] = [];
      await walkFiles(join(directory, "nowhere"), missing);
      assert.deepEqual(missing, []);
      assert.deepEqual([isUnderPrefix("notes/a.txt", "notes"), isUnderPrefix("notes/a.txt", "notes/"), isUnderPrefix("notes/a.txt", "note"), isUnderPrefix("anything", "")], [true, true, false, true]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the store the platform's policy picks", () => {
  it("picks the directory, the platform's own service or the agent store", () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-policy-"));
    try {
      const local = resolveBoxObjectStoreProvider({ env: { SLATE_BOX_STORE_LOCAL_DIR: directory }, agentStore: {} });
      assert.equal(local instanceof LocalFsObjectStoreProvider, true);
      // The directory the policy read is the one the store is rooted at, not the empty path.
      assert.equal((local as LocalFsObjectStoreProvider).baseDir, directory);
      // The platform's own store needs the backend's credentials to talk to it at all, and a transport this host
      // does not build yet — which is what the policy's own branch says when it is selected.
      assert.throws(() => resolveBoxObjectStoreProvider({ env: { SLATE_BOX_STORE_BACKEND: "v2" }, agentStore: {} }), (error: unknown) => error instanceof SlateInvariantViolation);
      assert.throws(() => resolveBoxObjectStoreProvider({ env: { SLATE_BOX_STORE_BACKEND: "v2" }, agentStore: { getAccessToken: async () => "t", getMachineId: async () => "m" } }), /requires a transport this host does not build yet/);
      assert.equal(new SlateBoxStoreServiceProvider({ client: serviceWorld().client }) instanceof SlateBoxStoreServiceProvider, true);
      assert.equal(resolveBoxObjectStoreProvider({ env: {}, agentStore: {} }) instanceof AgentStoreObjectStoreProvider, true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("hands one store per id over one client, and says so when there is nothing to sign a call with", async () => {
    const provider = new AgentStoreObjectStoreProvider({ client: { presignWrites: async () => [], presignReads: async () => [], listFiles: async () => ({ files: [] }) } as never });
    const first = provider.forStore("store-1");
    assert.notEqual(provider.forStore("store-2"), first);
    // A provider with no client and no credentials still hands out a store; the call that needs a token is what
    // refuses, before anything is sent anywhere.
    const store = new AgentStoreObjectStoreProvider({}).forStore("store-11111111-1111-1111-8111-111111111111");
    assert.equal(typeof store.get, "function");
    // The call that needs a token is what refuses, and it refuses before anything is sent anywhere: the missing
    // credential is raised where the token would have been read, and the transport carries it back as its own error.
    await assert.rejects(() => store.get("a.txt"), (error: unknown) => error instanceof Error && /Invariant violation/.test(error.message));
  });
});

/** A fetch that answers what the test told it to. */
function fetchWorld(answers: Array<{ status?: number; etag?: string; body?: string; fail?: boolean }> = []) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
    const answer = answers.length === 0 ? {} : answers.length === 1 ? answers[0]! : (answers[index++] ?? answers.at(-1)!);
    if (answer.fail === true) throw new Error("the network refused");
    const status = answer.status ?? 200;
    return new Response(status === 404 ? null : (answer.body ?? "payload"), { status, headers: answer.etag === undefined ? {} : { etag: answer.etag } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}
