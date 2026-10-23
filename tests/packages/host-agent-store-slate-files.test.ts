/**
 * The box's own view of the agent store: the presigned urls it will talk to, what it writes and what it makes of a
 * refusal, what it reads and how far it will read, and the etags it keeps between writes.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { pinBoxStoreDiagnosticsReporter } from "../../source/host/boxes/box-store-sync/box-store-diagnostics.ts";
import { BoxStoreSyncError } from "../../source/host/boxes/box-store-sync/box-store-sync-error.ts";
import {
  AgentStoreMutableWriteEtags,
  createAgentStoreClient,
  fetchAgentStoreObjectFromUrl,
  getAgentStoreObject,
  getAgentStoreObjectToFile,
  isConditionalWriteRejection,
  listAgentStoreObjects,
  PRESIGN_READ_BATCH_MAX,
  presignAgentStoreReadBatch,
  putAgentStoreObject,
  putAgentStoreObjectContentAddressed,
  putAgentStoreObjectFromFile,
  type AgentStoreClient,
  type AgentStoreWriteInstruction,
} from "../../source/host/boxes/box-store-sync/agent-store-slate-files.ts";

const SOURCE_ID = "store-11111111-1111-1111-8111-111111111111";
const BUCKET = "https://agent-stores.s3.us-east-1.amazonaws.com";
const writeInstruction = (relPath: string, extra: { url?: string; headers?: Record<string, string> | undefined; conflict?: { relPath: string; url: string; headers?: Record<string, string> } | undefined } = {}): AgentStoreWriteInstruction => ({
  relPath,
  url: extra.url ?? `${BUCKET}/${relPath}`,
  sha: "sha",
  ...(extra.headers === undefined ? { headers: { "x-amz-meta-content-sha256": "sha" } } : { headers: extra.headers }),
  ...(extra.conflict === undefined ? {} : { conflict: extra.conflict }),
});

/** A store client that writes down every call and answers what the test told it to. */
function clientWorld(options: { reads?: Array<{ relPath: string; url: string; expiresAtMs: number }>; writes?: AgentStoreWriteInstruction[]; files?: Array<{ relPath: string }> } = {}) {
  const presigns: Array<{ relPath: string; precondition: unknown }> = [];
  const invalidations: string[] = [];
  const queuedWrites = [...(options.writes ?? [])];
  const client: AgentStoreClient = {
    presignWrites: async (args) => {
      presigns.push({ relPath: args.files[0]!.relPath, precondition: args.files[0]!.baseEtag !== undefined ? { baseEtag: args.files[0]!.baseEtag } : args.files[0]!.expectAbsent === true ? { expectAbsent: true } : undefined });
      if (queuedWrites.length === 0) return [writeInstruction(args.files[0]!.relPath)];
      return [queuedWrites.length === 1 ? queuedWrites[0]! : queuedWrites.shift()!];
    },
    presignReads: async (args) => options.reads ?? args.relPaths.map((relPath) => ({ relPath, url: `${BUCKET}/${relPath}`, expiresAtMs: 1_000 })),
    listFiles: async () => ({ files: options.files ?? [] }),
    invalidateListCache: (args) => void invalidations.push(args.agentId),
  };
  return { client, presigns, invalidations };
}

/** A fetch that writes down every call and answers what the test told it to. */
function fetchWorld(answers: Array<{ status?: number; etag?: string; body?: string; emptyBody?: boolean; fail?: boolean }> = []) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; range?: string }> = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: init?.method ?? "GET", headers, ...(headers["Range"] === undefined ? {} : { range: headers["Range"] }) });
    const answer = answers.length === 0 ? {} : answers.length === 1 ? answers[0]! : (answers[index++] ?? answers.at(-1)!);
    if (answer.fail === true) throw new Error("the network refused");
    const status = answer.status ?? 200;
    const body = answer.emptyBody === true ? null : (answer.body ?? "payload");
    return new Response(status === 404 || status === 416 ? null : body, {
      status,
      headers: answer.etag === undefined ? {} : { etag: answer.etag },
    });
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => void (globalThis.fetch = original),
  };
}

describe("what a presigned url is allowed to be", () => {
  it("refuses a url that is not https, is on another host, or carries credentials", async () => {
    const cases: Array<[string, RegExp]> = [
      [`http://agent-stores.s3.us-east-1.amazonaws.com/a.txt`, /non-https scheme/],
      [`https://evil.invalid/a.txt`, /not in the allowlist/],
      [`https://user:pass@agent-stores.s3.us-east-1.amazonaws.com/a.txt`, /embedded userinfo/],
      [`not a url`, /unparseable presigned URL/],
    ];
    for (const [url, expected] of cases) {
      const world = clientWorld({ reads: [{ relPath: "a.txt", url, expiresAtMs: 1 }] });
      const fetchWorld1 = fetchWorld();
      const etags = new AgentStoreMutableWriteEtags();
      await assert.rejects(() => putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags }), expected, url);
      assert.deepEqual(fetchWorld1.calls, []);
      fetchWorld1.restore();
    }
  });

  it("allows an http url on loopback while the backend itself is on loopback", async () => {
    const previous = process.env["SLATE_BACKEND_URL"];
    process.env["SLATE_BACKEND_URL"] = "http://localhost:61284";
    const world = clientWorld({ reads: [{ relPath: "a.txt", url: "http://127.0.0.1:9000/a.txt", expiresAtMs: 1 }] });
    const fetcher = fetchWorld([{ status: 404 }, { status: 200, etag: '"E"' }]);
    try {
      // The probe is allowed to reach it, a 404 is an absent object, and the write goes to the same loopback host.
      assert.deepEqual(await putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }), { outcome: "written" });
      assert.deepEqual(fetcher.calls.map((call) => call.url), ["http://127.0.0.1:9000/a.txt", "https://agent-stores.s3.us-east-1.amazonaws.com/a.txt"]);
    } finally {
      fetcher.restore();
      if (previous === undefined) delete process.env["SLATE_BACKEND_URL"];
      else process.env["SLATE_BACKEND_URL"] = previous;
    }
  });
});

describe("probing for what the store already has", () => {
  it("asks for one byte first, and asks again without a range when the object is empty", async () => {
    const world = clientWorld();
    const fetcher = fetchWorld([{ status: 416 }, { status: 200, etag: '"ETAG"' }]);
    try {
      const written = await putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() });
      assert.deepEqual([fetcher.calls[0]!.range, fetcher.calls[1]!.range], ["bytes=0-0", undefined]);
      // The etag the store answered with is the precondition the write is presigned against.
      assert.deepEqual(world.presigns[0]!.precondition, { baseEtag: "etag" });
      assert.deepEqual(written, { outcome: "written" });
    } finally {
      fetcher.restore();
    }
  });

  it("takes a store that has nothing there as an absent baseline", async () => {
    const world = clientWorld();
    const fetcher = fetchWorld([{ status: 404 }, { status: 200, etag: '"E"' }]);
    try {
      await putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() });
      assert.deepEqual(world.presigns[0]!.precondition, { expectAbsent: true });
    } finally {
      fetcher.restore();
    }
  });

  it("refuses a probe that answers nothing usable", async () => {
    const withNoEtag = clientWorld();
    const first = fetchWorld([{ status: 200 }]);
    try {
      await assert.rejects(() => putAgentStoreObject({ client: withNoEtag.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }), /no usable etag/);
    } finally {
      first.restore();
    }
    const withAnotherStatus = clientWorld();
    const second = fetchWorld([{ status: 500 }]);
    try {
      await assert.rejects(() => putAgentStoreObject({ client: withAnotherStatus.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }), /baseline probe failed/);
    } finally {
      second.restore();
    }
    // A probe that answers about another file is a store that answered about something else.
    const mismatched = clientWorld({ reads: [{ relPath: "other.txt", url: `${BUCKET}/other.txt`, expiresAtMs: 1 }] });
    const third = fetchWorld();
    try {
      await assert.rejects(() => putAgentStoreObject({ client: mismatched.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }), /relPath mismatch/);
    } finally {
      third.restore();
    }
    // A probe the store answered nothing to is not a probe that found nothing.
    const unpresigned = clientWorld({ reads: [] });
    const fifth = fetchWorld();
    try {
      await assert.rejects(() => putAgentStoreObject({ client: unpresigned.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }), /returned no read for a.txt/);
    } finally {
      fifth.restore();
    }
  });

  it("refuses a probe for a path the store should never have named, rule by rule", async () => {
    const rules: Array<[string, RegExp]> = [
      ["../escape.txt", /must not contain '\.\.'/],
      ["", /must be a non-empty string/],
      ["/absolute.txt", /must not be absolute/],
      ["a\0b.txt", /must not contain NUL bytes/],
      [`${"x".repeat(256)}.txt`, /exceeds 255 bytes/],
      ["a\u0007b.txt", /control character/],
      ["name.", /must not end with/],
      ["name ", /must not end with/],
      ["con.txt", /reserved device name/],
      ["./", /resolved to empty/],
    ];
    for (const [relPath, expected] of rules) {
      const world = clientWorld({ reads: [{ relPath, url: `${BUCKET}/x`, expiresAtMs: 1 }] });
      const fetcher = fetchWorld();
      try {
        await assert.rejects(() => putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }), expected, JSON.stringify(relPath));
      } finally {
        fetcher.restore();
      }
    }
    // A path written with a dot segment and a trailing slash is the same path.
    const cleaned = clientWorld({ reads: [{ relPath: "notes/./a.txt", url: `${BUCKET}/notes/a.txt`, expiresAtMs: 1 }] });
    const fetcher = fetchWorld([{ status: 404 }, { status: 200, etag: '"E"' }]);
    try {
      assert.deepEqual(await putAgentStoreObject({ client: cleaned.client, sourceId: SOURCE_ID, relPath: "notes/a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }), { outcome: "written" });
    } finally {
      fetcher.restore();
    }
  });
});

describe("writing an object", () => {
  it("writes with what the store presigned, keeps the etag it answered with, and uses it next time", async () => {
    const world = clientWorld();
    const fetcher = fetchWorld([{ status: 404 }, { status: 200, etag: '"ETAG-1"' }, { status: 200, etag: '"ETAG-2"' }]);
    const etags = new AgentStoreMutableWriteEtags();
    try {
      await putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1, 2]), etags });
      // The first write probes (404), then writes; the etag it answered with is remembered.
      assert.deepEqual(etags.get(SOURCE_ID, "a.txt"), "etag-1");
      assert.deepEqual([fetcher.calls[1]!.method, fetcher.calls[1]!.headers["x-amz-meta-content-sha256"]], ["PUT", "sha"]);
      await putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([3]), etags });
      // The second write needs no probe: what the first one learned is the baseline.
      assert.deepEqual([world.presigns.length, world.presigns[1]!.precondition, fetcher.calls.length], [2, { baseEtag: "etag-1" }, 3]);
    } finally {
      fetcher.restore();
    }
  });

  it("writes without a header of the store's own by naming the content's hash, and forgets a write that answered with no etag", async () => {
    // A presign that carries no headers at all: the body is described by its own hash instead.
    const world = clientWorld({ writes: [{ relPath: "a.txt", url: `${BUCKET}/a.txt`, sha: "sha" }] });
    const fetcher = fetchWorld([{ status: 404 }, { status: 200, etag: '"E"' }]);
    const etags = new AgentStoreMutableWriteEtags();
    try {
      await putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags });
      assert.deepEqual([fetcher.calls[1]!.headers["x-amz-meta-content-sha256"], etags.get(SOURCE_ID, "a.txt")], ["sha", "e"]);
    } finally {
      fetcher.restore();
    }
    // A write the store accepted without an etag leaves nothing to write against next time.
    const noEtag = clientWorld({ writes: [writeInstruction("a.txt")] });
    const second = fetchWorld([{ status: 200 }]);
    const known = new AgentStoreMutableWriteEtags();
    known.set(SOURCE_ID, "a.txt", "old-etag");
    try {
      await putAgentStoreObject({ client: noEtag.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: known });
      assert.deepEqual([known.get(SOURCE_ID, "a.txt"), noEtag.invalidations], [undefined, [SOURCE_ID]]);
    } finally {
      second.restore();
    }
  });

  it("tries a write that collided on the object store again, and keeps a conflict aside when it collides twice", async () => {
    const world = clientWorld({ writes: [writeInstruction("a.txt", { conflict: { relPath: "a (conflict).txt", url: `${BUCKET}/conflict.txt` } })] });
    const fetcher = fetchWorld([{ status: 404 }, { status: 409 }, { status: 200, etag: '"E"' }]);
    const etags = new AgentStoreMutableWriteEtags();
    try {
      assert.deepEqual(await putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags }), { outcome: "written" });
      assert.deepEqual(fetcher.calls.map((call) => call.url), [`${BUCKET}/a.txt`, `${BUCKET}/a.txt`, `${BUCKET}/a.txt`]);
    } finally {
      fetcher.restore();
    }
    // A conflict against a baseline the session already knew names that etag as the one it collided with.
    const knownBaseline = clientWorld({ writes: [writeInstruction("a.txt", { conflict: { relPath: "a (conflict).txt", url: `${BUCKET}/conflict.txt` } })] });
    const third = fetchWorld([{ status: 412 }, { status: 200 }]);
    const knownEtags = new AgentStoreMutableWriteEtags();
    knownEtags.set(SOURCE_ID, "a.txt", "known-etag");
    try {
      assert.deepEqual(await putAgentStoreObject({ client: knownBaseline.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: knownEtags }), { outcome: "conflict", conflictRelPath: "a (conflict).txt", baseEtag: "known-etag", baselineSource: "session" });
    } finally {
      third.restore();
    }
    // A refusal that will not go away keeps the local copy under the conflict's own name.
    const diagnostics: Array<Record<string, unknown>> = [];
    pinBoxStoreDiagnosticsReporter((diagnostic) => void diagnostics.push(diagnostic));
    const conflicted = clientWorld({ writes: [writeInstruction("a.txt", { conflict: { relPath: "a (conflict).txt", url: `${BUCKET}/conflict.txt` } })] });
    const second = fetchWorld([{ status: 404 }, { status: 412 }, { status: 412 }, { status: 200 }]);
    try {
      const result = await putAgentStoreObject({ client: conflicted.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() });
      assert.deepEqual([result, diagnostics, conflicted.invalidations], [{ outcome: "conflict", conflictRelPath: "a (conflict).txt", baseEtag: null, baselineSource: "absent" }, [{ extension: "box_store", kind: "write_conflict_preserved" }], [SOURCE_ID]]);
      assert.deepEqual(second.calls.map((call) => call.url), [`${BUCKET}/a.txt`, `${BUCKET}/a.txt`, `${BUCKET}/conflict.txt`, `${BUCKET}/conflict.txt`]);
    } finally {
      second.restore();
      pinBoxStoreDiagnosticsReporter(null);
    }
  });

  it("presigns the conflict again when the one it had was refused too", async () => {
    const first = writeInstruction("a.txt", { conflict: { relPath: "a (conflict).txt", url: `${BUCKET}/conflict-1.txt` } });
    const second = writeInstruction("a.txt", { conflict: { relPath: "a (conflict-2).txt", url: `${BUCKET}/conflict-2.txt` } });
    const world = clientWorld({ writes: [first, second] });
    const fetcher = fetchWorld([{ status: 404 }, { status: 412 }, { status: 412 }, { status: 200 }]);
    try {
      const result = await putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() });
      assert.deepEqual([result, fetcher.calls.at(-1)!.url], [{ outcome: "conflict", conflictRelPath: "a (conflict-2).txt", baseEtag: null, baselineSource: "absent" }, `${BUCKET}/conflict-2.txt`]);
    } finally {
      fetcher.restore();
    }
    // A fresh presign that brings no conflict of its own leaves nowhere to keep the copy.
    const nowhere = clientWorld({ writes: [first, writeInstruction("a.txt")] });
    const failing = fetchWorld([{ status: 404 }, { status: 412 }, { status: 412 }, { status: 412 }]);
    try {
      await assert.rejects(() => putAgentStoreObject({ client: nowhere.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }), /returned no conflict instruction/);
    } finally {
      failing.restore();
    }
  });

  it("refuses a write that protects against conflicts one way and not the other, and says so when it protects not at all", async () => {
    const halfProtected = clientWorld({ writes: [writeInstruction("a.txt", { headers: { "if-match": "e" }, conflict: undefined })] });
    const first = fetchWorld([{ status: 404 }]);
    try {
      await assert.rejects(() => putAgentStoreObject({ client: halfProtected.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }), /conditional header but no conflict instruction/);
    } finally {
      first.restore();
    }
    // Nothing conditional at all is a downgrade the host is told about, and the write still goes through.
    const diagnostics: Array<Record<string, unknown>> = [];
    pinBoxStoreDiagnosticsReporter((diagnostic) => void diagnostics.push(diagnostic));
    const unprotected = clientWorld({ writes: [writeInstruction("a.txt", { headers: { "x-amz-meta-content-sha256": "sha" } })] });
    const second = fetchWorld([{ status: 404 }, { status: 200, etag: '"E"' }]);
    try {
      assert.deepEqual(await putAgentStoreObject({ client: unprotected.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }), { outcome: "written" });
      assert.deepEqual(diagnostics, [{ extension: "box_store", kind: "conflict_protection_downgraded" }]);
    } finally {
      second.restore();
      pinBoxStoreDiagnosticsReporter(null);
    }
  });

  it("forgets what it knew about a file the store would not take, and asks again next time", async () => {
    const world = clientWorld({ writes: [writeInstruction("a.txt")] });
    const fetcher = fetchWorld([{ status: 412 }]);
    const etags = new AgentStoreMutableWriteEtags();
    etags.set(SOURCE_ID, "a.txt", "old-etag");
    try {
      // A refusal about the precondition means what was known is no longer what is there.
      await assert.rejects(() => putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags }), /write failed for a.txt: 412/);
      assert.deepEqual([etags.get(SOURCE_ID, "a.txt"), world.invalidations], [undefined, [SOURCE_ID]]);
      // A refusal that was about something else leaves what was known alone.
      const busy = clientWorld({ writes: [writeInstruction("a.txt")] });
      const second = fetchWorld([{ status: 500 }]);
      const kept = new AgentStoreMutableWriteEtags();
      kept.set(SOURCE_ID, "a.txt", "old-etag");
      try {
        await assert.rejects(() => putAgentStoreObject({ client: busy.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: kept }), /write failed for a.txt: 500/);
        assert.deepEqual([kept.get(SOURCE_ID, "a.txt"), busy.invalidations], ["old-etag", []]);
      } finally {
        second.restore();
      }
    } finally {
      fetcher.restore();
    }
  });

  it("writes an object it names by its content, and takes a refusal that says it is already there", async () => {
    const world = clientWorld();
    const fetcher = fetchWorld([{ status: 200 }, { status: 412 }]);
    try {
      await putAgentStoreObjectContentAddressed({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]) });
      assert.deepEqual([world.presigns[0]!.precondition, fetcher.calls[0]!.method], [{ expectAbsent: true }, "PUT"]);
      // A refusal that says the object is already there is not a failure.
      await putAgentStoreObjectContentAddressed({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]) });
      const broken = fetchWorld([{ status: 500 }]);
      try {
        await assert.rejects(() => putAgentStoreObjectContentAddressed({ client: clientWorld({ writes: [writeInstruction("a.txt")] }).client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]) }), /write failed/);
      } finally {
        broken.restore();
      }
    } finally {
      fetcher.restore();
    }
  });
});

describe("reading an object", () => {
  it("reads one into memory, and answers nothing when the store has none", async () => {
    const world = clientWorld();
    const fetcher = fetchWorld([{ status: 200, body: "hello" }]);
    try {
      assert.deepEqual(await getAgentStoreObject(world.client, SOURCE_ID, "a.txt"), new TextEncoder().encode("hello"));
      // A store that has nothing there is not an error.
      const missing = fetchWorld([{ status: 404 }]);
      try {
        assert.equal(await getAgentStoreObject(world.client, SOURCE_ID, "a.txt"), null);
      } finally {
        missing.restore();
      }
      // A store that answered nothing to presign for is nothing to read either.
      const unpresigned = clientWorld({ reads: [] });
      assert.equal(await getAgentStoreObject(unpresigned.client, SOURCE_ID, "a.txt"), null);
      const broken = fetchWorld([{ status: 500 }]);
      try {
        await assert.rejects(() => fetchAgentStoreObjectFromUrl(`${BUCKET}/a.txt`, "a.txt"), (error: unknown) => error instanceof BoxStoreSyncError);
      } finally {
        broken.restore();
      }
    } finally {
      fetcher.restore();
    }
  });

  it("reads one into a file, and stops at the size it was given", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-agent-store-"));
    const world = clientWorld();
    const fetcher = fetchWorld([{ status: 200, body: "hello there" }]);
    try {
      const destPath = join(directory, "nested", "a.txt");
      assert.equal(await getAgentStoreObjectToFile(world.client, SOURCE_ID, "a.txt", destPath), 11);
      assert.equal(readFileSync(destPath, "utf8"), "hello there");
      // An object larger than the caller will hold stops the read.
      await assert.rejects(() => getAgentStoreObjectToFile(world.client, SOURCE_ID, "a.txt", join(directory, "b.txt"), 4), /exceeded 4B/);
      const missing = fetchWorld([{ status: 404 }]);
      try {
        assert.equal(await getAgentStoreObjectToFile(world.client, SOURCE_ID, "a.txt", join(directory, "c.txt")), null);
      } finally {
        missing.restore();
      }
      // A read the store answered with no body at all is not an empty file.
      const empty = fetchWorld([{ status: 200, emptyBody: true }]);
      try {
        await assert.rejects(() => getAgentStoreObjectToFile(world.client, SOURCE_ID, "a.txt", join(directory, "d.txt")), /returned no body/);
      } finally {
        empty.restore();
      }
    } finally {
      fetcher.restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("asks for reads in batches the store will take", async () => {
    const relPaths = Array.from({ length: PRESIGN_READ_BATCH_MAX + 1 }, (_, index) => `f${index}.txt`);
    const batches: number[] = [];
    const client: AgentStoreClient = {
      presignWrites: async () => [],
      presignReads: async (args) => {
        batches.push(args.relPaths.length);
        return args.relPaths.map((relPath) => ({ relPath, url: `${BUCKET}/${relPath}`, expiresAtMs: 5 }));
      },
      listFiles: async () => ({ files: [] }),
    };
    const byRelPath = await presignAgentStoreReadBatch(client, SOURCE_ID, relPaths);
    assert.deepEqual([batches, byRelPath.size, byRelPath.get("f0.txt")], [[500, 1], 501, { url: `${BUCKET}/f0.txt`, expiresAtMs: 5 }]);
  });

  it("lists what the store holds under a prefix", async () => {
    const world = clientWorld({ files: [{ relPath: "notes/a.txt" }, { relPath: "notes/b.txt" }] });
    assert.deepEqual(await listAgentStoreObjects(world.client, SOURCE_ID, "notes"), ["notes/a.txt", "notes/b.txt"]);
  });
});

describe("writing a file the box already has", () => {
  /** A store's object endpoint on loopback, which is what the streaming write talks to. */
  function objectServer(answers: number[]) {
    const requests: Array<{ method: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
    let index = 0;
    const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        requests.push({ method: request.method ?? "", headers: request.headers, body });
        const status = answers.length === 0 ? 200 : answers.length === 1 ? answers[0]! : (answers[index++] ?? answers.at(-1)!);
        response.writeHead(status);
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
      stop: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it("streams a file to the store, and takes a refusal that says it is already there", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-agent-store-put-"));
    const server = objectServer([200, 412, 500]);
    const previous = process.env["SLATE_BACKEND_URL"];
    process.env["SLATE_BACKEND_URL"] = "http://localhost:61284";
    try {
      const base = await server.start();
      const srcPath = join(directory, "a.txt");
      const world = clientWorld({ writes: [writeInstruction("a.txt", { url: `${base}/a.txt` }), writeInstruction("a.txt", { url: `${base}/a.txt` })] });
      writeFileSync(srcPath, "hello", "utf8");
      await putAgentStoreObjectFromFile({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", srcPath, sha: "sha", size: 5 });
      assert.deepEqual([server.requests[0]!.method, server.requests[0]!.body, server.requests[0]!.headers["content-length"]], ["PUT", "hello", "5"]);
      // A refusal that says it is already there is not a failure either.
      await putAgentStoreObjectFromFile({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", srcPath, sha: "sha", size: 5 });
      const failing = clientWorld({ writes: [writeInstruction("a.txt", { url: `${base}/a.txt` })] });
      await assert.rejects(() => putAgentStoreObjectFromFile({ client: failing.client, sourceId: SOURCE_ID, relPath: "a.txt", srcPath, sha: "sha", size: 5 }), /write failed for a.txt: 412|write failed/);
    } finally {
      if (previous === undefined) delete process.env["SLATE_BACKEND_URL"];
      else process.env["SLATE_BACKEND_URL"] = previous;
      await server.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the client the box builds for itself", () => {
  it("takes a client it was given, and builds one over the backend otherwise", () => {
    const world = clientWorld();
    assert.equal(createAgentStoreClient({ client: world.client }), world.client);
    const built = createAgentStoreClient({ getAccessToken: async () => "token", getMachineId: async () => "machine-1" });
    assert.equal(typeof built.presignReads, "function");
    assert.equal(typeof built.presignWrites, "function");
    assert.equal(typeof built.listFiles, "function");
  });

  it("reads a refusal that will not go away as one, and another status as another", () => {
    assert.deepEqual([isConditionalWriteRejection(412), isConditionalWriteRejection(409), isConditionalWriteRejection(500)], [true, true, false]);
  });
});

describe("url and write details the store's own rules decide", () => {
  it("refuses plain http on loopback when the backend is not on loopback", async () => {
    const previous = process.env.SLATE_BACKEND_URL;
    process.env.SLATE_BACKEND_URL = "https://api.slate.invalid";
    const world = clientWorld({ reads: [{ relPath: "a.txt", url: "http://127.0.0.1:9999/a.txt", expiresAtMs: 1 }] });
    const fetcher = fetchWorld([]);
    try {
      await assert.rejects(
        () => putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }),
        /non-https scheme/,
      );
    } finally {
      fetcher.restore();
      if (previous === undefined) delete process.env.SLATE_BACKEND_URL;
      else process.env.SLATE_BACKEND_URL = previous;
    }
  });

  it("uses the playground's own bucket allowlist on the playground backend", async () => {
    const previous = process.env.SLATE_BACKEND_URL;
    process.env.SLATE_BACKEND_URL = "https://playground.cursor.sh";
    const world = clientWorld({ reads: [{ relPath: "a.txt", url: "https://agent-stores-928182716709-us-west-2-an.s3.us-west-2.amazonaws.com/a.txt", expiresAtMs: 1 }] });
    const fetcher = fetchWorld([{ status: 404 }, { status: 200, etag: '"E"' }]);
    try {
      const outcome = await putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() });
      assert.deepEqual(outcome, { outcome: "written" });
    } finally {
      if (previous === undefined) delete process.env.SLATE_BACKEND_URL;
      else process.env.SLATE_BACKEND_URL = previous;
      fetcher.restore();
    }
  });

  it("refuses a presign that answers with no write at all", async () => {
    const world = clientWorld();
    world.client.presignWrites = async () => [];
    const fetcher = fetchWorld([{ status: 404 }]);
    try {
      await assert.rejects(
        () => putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }),
        /agent-store presign returned no write for a\.txt/,
      );
    } finally {
      fetcher.restore();
    }
  });

  it("treats if-none-match as conditional protection", async () => {
    const world = clientWorld({ writes: [writeInstruction("a.txt", { headers: { "If-None-Match": "*" } })] });
    const fetcher = fetchWorld([{ status: 404 }, { status: 200 }]);
    try {
      await assert.rejects(
        () => putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() }),
        /carries a conditional header but no conflict instruction/,
      );
    } finally {
      fetcher.restore();
    }
  });

  it("says nothing about a downgraded protection when the store protected it one way", async () => {
    const diagnostics: unknown[] = [];
    pinBoxStoreDiagnosticsReporter((diagnostic) => diagnostics.push(diagnostic));
    const world = clientWorld({ writes: [writeInstruction("a.txt", { headers: { "If-Match": "x" } })] });
    const fetcher = fetchWorld([{ status: 200 }]);
    try {
      // A content-addressed write has no conflict instruction to fall back on, but its own header is protection.
      await putAgentStoreObjectContentAddressed({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]) });
      assert.deepEqual(diagnostics, []);
    } finally {
      pinBoxStoreDiagnosticsReporter(null);
      fetcher.restore();
    }
  });

  it("sends the headers the store presigned", async () => {
    const world = clientWorld({ writes: [writeInstruction("a.txt", { headers: { "content-type": "text/plain" } })] });
    const fetcher = fetchWorld([{ status: 404 }, { status: 200, etag: '"E"' }]);
    try {
      await putAgentStoreObject({ client: world.client, sourceId: SOURCE_ID, relPath: "a.txt", data: new Uint8Array([1]), etags: new AgentStoreMutableWriteEtags() });
      assert.deepEqual(fetcher.calls[1]!.headers, { "content-type": "text/plain" });
    } finally {
      fetcher.restore();
    }
  });
});

