/**
 * The token-caching client over the store's transport: which target a call mints for, when a token is reused and when
 * it is minted again, what a refusal is remembered for, and what happens to a call that was refused once.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentStoreUnauthorizedError } from "../../source/packages/agent-store-sync/bcs-client.ts";
import { TokenCachingAgentStoreClient } from "../../source/packages/agent-store-sync/token-caching-client.ts";
import type { AgentStoreMintTarget, AgentStoreToken } from "../../source/packages/agent-store-sync/bcs-transport.ts";

const token = (expiresAtMs: number, storeIds: readonly string[] = ["store-1"]): AgentStoreToken => ({ token: "t", expiresAtMs, storeIds });
/** The ids the platform hands out: a store, a bare uuid, a cloud store, a user's store and a team's. */
const STORE_ID = "store-11111111-1111-1111-8111-111111111111";
const OTHER_STORE_ID = "store-44444444-4444-4444-8444-444444444444";
const BARE_UUID = "22222222-2222-2222-8222-222222222222";
const CLOUD_ID = "bc-33333333-3333-3333-8333-333333333333";
const OTHER_CLOUD_ID = "bc-55555555-5555-5555-8555-555555555555";

/** A transport that writes down what it was asked for and answers what the test told it to. */
function clientWorld(options: { now?: () => number; refreshBufferMs?: number; baseMs?: number; maxMs?: number; metrics?: boolean; onSyncDisabledMint?: (event: { agentId: string; message: string }) => void | Promise<void>; without?: Array<"deleteFiles" | "completeMultipartWrites" | "abortMultipartWrites" | "invalidateListCache"> } = {}) {
  let now = 1_000;
  const mints: AgentStoreMintTarget[] = [];
  const calls: Array<[string, Record<string, unknown>]> = [];
  const invalidations: Array<{ storeId: string; shareId?: string }> = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const mintAnswers: Array<AgentStoreToken | Error | Promise<never>> = [];
  const opAnswers: Record<string, Array<unknown>> = {};
  const answerFor = (name: string) => {
    const queue = opAnswers[name];
    if (queue === undefined || queue.length === 0) return {};
    const answer = queue.length === 1 ? queue[0] : queue.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const transport = {
    mintToken: async (target: AgentStoreMintTarget) => {
      mints.push(target);
      const answer = mintAnswers.length === 1 ? mintAnswers[0] : mintAnswers.shift();
      if (answer instanceof Error) throw answer;
      if (answer instanceof Promise) return await answer;
      return answer ?? token(now + 120_000);
    },
    listFiles: async (args: Record<string, unknown>) => (calls.push(["listFiles", args]), answerFor("listFiles")),
    presignReads: async (args: Record<string, unknown>) => (calls.push(["presignReads", args]), answerFor("presignReads")),
    presignWrites: async (args: Record<string, unknown>) => (calls.push(["presignWrites", args]), answerFor("presignWrites")),
    ...(options.without?.includes("deleteFiles") === true ? {} : { deleteFiles: async (args: Record<string, unknown>) => (calls.push(["deleteFiles", args]), answerFor("deleteFiles")) }),
    ...(options.without?.includes("completeMultipartWrites") === true ? {} : { completeMultipartWrites: async (args: Record<string, unknown>) => (calls.push(["completeMultipartWrites", args]), answerFor("completeMultipartWrites")) }),
    ...(options.without?.includes("abortMultipartWrites") === true ? {} : { abortMultipartWrites: async (args: Record<string, unknown>) => (calls.push(["abortMultipartWrites", args]), answerFor("abortMultipartWrites")) }),
    ...(options.without?.includes("invalidateListCache") === true ? {} : { invalidateListCache: (args: { storeId: string; shareId?: string }) => void invalidations.push(args) }),
  };
  const client = new TokenCachingAgentStoreClient(transport, {
    now: options.now ?? (() => now),
    ...(options.refreshBufferMs === undefined ? {} : { refreshBufferMs: options.refreshBufferMs }),
    ...(options.baseMs === undefined ? {} : { mintNegativeCacheBaseMs: options.baseMs }),
    ...(options.maxMs === undefined ? {} : { mintNegativeCacheMaxMs: options.maxMs }),
    ...(options.onSyncDisabledMint === undefined ? {} : { onSyncDisabledMint: options.onSyncDisabledMint }),
    ...(options.metrics === true
      ? {
          metrics: {
            tokenMinted: (event: { agentId: string; reason: string }) => void events.push(["minted", { ...event }]),
            tokenRefreshUnauthorized: (event: { agentId: string; op: string }) => void events.push(["unauthorized", { ...event }]),
            tokenMintNegativeCached: (event: { agentId: string; untilMs: number }) => void events.push(["negative", { ...event }]),
            tokenMintFailureCached: (event: { agentId: string; kind: string }) => void events.push(["failure", { ...event }]),
          },
        }
      : {}),
  });
  return {
    client,
    transport,
    mints,
    calls,
    invalidations,
    events,
    answerMint: (...answers: Array<AgentStoreToken | Error | Promise<never>>) => void (mintAnswers.length = 0, mintAnswers.push(...answers)),
    answerOp: (name: string, ...answers: unknown[]) => void (opAnswers[name] = answers),
    setNow: (next: number) => void (now = next),
  };
}

describe("which target a call mints for", () => {
  it("reads a share, a store, a cloud agent, a bare uuid, a user source and a team source apart", async () => {
    const world = clientWorld();
    await world.client.listFiles({ agentId: STORE_ID, relPath: "" });
    await world.client.listFiles({ agentId: "anything", shareId: "share-1", relPath: "" });
    await world.client.listFiles({ agentId: CLOUD_ID, mintSourceKind: "team", relPath: "" });
    await world.client.listFiles({ agentId: OTHER_CLOUD_ID, relPath: "" });
    await world.client.listFiles({ agentId: BARE_UUID, relPath: "" });
    await world.client.listFiles({ agentId: "u42", relPath: "" });
    await world.client.listFiles({ agentId: "t4-u42", relPath: "" });
    await world.client.listFiles({ agentId: "t4", relPath: "" });
    assert.deepEqual(world.mints, [
      { kind: "store", storeId: STORE_ID },
      { kind: "share", shareId: "share-1" },
      { kind: "source", sourceKind: "team", sourceId: CLOUD_ID },
      { kind: "source", sourceKind: "cloud", sourceId: OTHER_CLOUD_ID },
      { kind: "source", sourceKind: "local", sourceId: BARE_UUID },
      { kind: "source", sourceKind: "user", sourceId: "u42" },
      { kind: "source", sourceKind: "user", sourceId: "t4-u42" },
      { kind: "source", sourceKind: "team", sourceId: "t4" },
    ]);
  });

  it("refuses an id that is not a store or a source at all", async () => {
    const world = clientWorld();
    await assert.rejects(() => world.client.listFiles({ agentId: "not-an-id", relPath: "" }), AgentStoreUnauthorizedError);
    assert.deepEqual(world.mints, []);
  });
});

describe("reusing a token", () => {
  it("mints once for a call, again only when it is near its expiry, and once for two calls at the same time", async () => {
    const world = clientWorld({ metrics: true });
    world.answerMint(token(120_000), token(200_000));
    await world.client.listFiles({ agentId: STORE_ID, relPath: "" });
    assert.deepEqual(world.events, [["minted", { agentId: STORE_ID, reason: "cold" }]]);
    // The same token answers the next call, so nothing is minted.
    world.setNow(2_000);
    await world.client.listFiles({ agentId: STORE_ID, relPath: "" });
    assert.equal(world.mints.length, 1);
    // Within the refresh buffer the token is minted again, and the reason says why.
    world.setNow(70_000);
    await world.client.listFiles({ agentId: STORE_ID, relPath: "" });
    assert.deepEqual([world.mints.length, world.events[1]], [2, ["minted", { agentId: STORE_ID, reason: "near_expiry" }]]);
    // Two calls at once share the one mint that is in flight.
    const shared = clientWorld();
    let release: (() => void) | undefined;
    const held = new Promise<AgentStoreToken>((resolve) => (release = () => resolve(token(120_000))));
    shared.answerMint(held as never);
    const first = shared.client.listFiles({ agentId: STORE_ID, relPath: "" });
    const second = shared.client.listFiles({ agentId: STORE_ID, relPath: "" });
    release!();
    assert.deepEqual([shared.mints.length, ...(await Promise.all([first, second]))], [1, {}, {}]);
  });

  it("keeps a share's token apart from the agent's own, and needs a store id to call with", async () => {
    const world = clientWorld();
    await world.client.listFiles({ agentId: STORE_ID, relPath: "" });
    await world.client.listFiles({ agentId: STORE_ID, shareId: "share-1", relPath: "" });
    assert.equal(world.mints.length, 2);
    // A token that names no store cannot be called with.
    const storeless = clientWorld();
    storeless.answerMint(token(30_000, []));
    await assert.rejects(() => storeless.client.listFiles({ agentId: STORE_ID, relPath: "" }), /did not include a scoped store id/);
  });

  it("calls the store with the token's own store, and with the caller's arguments", async () => {
    const world = clientWorld();
    await world.client.listFiles({ agentId: STORE_ID, relPath: "notes", shareId: "share-1" });
    assert.deepEqual(world.calls[0]![1], { relPath: "notes", shareId: "share-1", storeId: "store-1", token: token(121_000), signal: undefined });
    await world.client.presignWrites({ agentId: STORE_ID, files: [{ relPath: "a.txt", sha: "sha", size: 1 }] });
    assert.deepEqual(world.calls[1]![1], { files: [{ relPath: "a.txt", sha: "sha", size: 1 }], storeId: "store-1", token: token(121_000), signal: undefined });
    await world.client.deleteFiles({ agentId: STORE_ID, files: [{ relPath: "a.txt", baseEtag: "e" }] });
    assert.equal(world.calls[2]![0], "deleteFiles");
    // The two multipart halves go through the same way.
    await world.client.completeMultipartWrites?.({ agentId: STORE_ID, completions: [] });
    await world.client.abortMultipartWrites?.({ agentId: STORE_ID, uploads: [] });
    assert.deepEqual(world.calls.slice(3).map(([name]) => name), ["completeMultipartWrites", "abortMultipartWrites"]);
  });
});

describe("a call that was refused once", () => {
  it("mints again after an unauthorized answer, and calls again with the fresh token", async () => {
    const world = clientWorld({ metrics: true });
    world.answerMint(token(30_000), token(30_000));
    world.answerOp("listFiles", new AgentStoreUnauthorizedError("not yours"), { files: [] });
    assert.deepEqual(await world.client.listFiles({ agentId: STORE_ID, relPath: "" }), { files: [] });
    assert.deepEqual([world.mints.length, world.events, world.calls.length], [2, [["minted", { agentId: STORE_ID, reason: "cold" }], ["unauthorized", { agentId: STORE_ID, op: "listFiles" }], ["minted", { agentId: STORE_ID, reason: "after_unauthorized" }]], 2]);
    // A refusal that is not about the token is the caller's own error, and nothing is minted again.
    const other = clientWorld();
    other.answerOp("presignReads", new Error("the store is busy"));
    await assert.rejects(() => other.client.presignReads({ agentId: STORE_ID, relPaths: [] }), /the store is busy/);
    assert.equal(other.mints.length, 1);
  });

  it("reads a refusal from the shape of the error as well as from its own kind", async () => {
    for (const refusal of [{ status: 401 }, { status: 403 }, { code: 7 }, { code: 16 }, { code: "PermissionDenied" }, { code: "UNAUTHENTICATED" }].map((shape) => Object.assign(new Error("refused"), shape))) {
      const world = clientWorld();
      world.answerOp("listFiles", refusal, {});
      assert.deepEqual(await world.client.listFiles({ agentId: STORE_ID, relPath: "" }), {});
      assert.equal(world.mints.length, 2, JSON.stringify(refusal));
    }
    const notRefused = clientWorld();
    notRefused.answerOp("listFiles", Object.assign(new Error("the store is broken"), { status: 500 }));
    await assert.rejects(() => notRefused.client.listFiles({ agentId: STORE_ID, relPath: "" }));
    assert.equal(notRefused.mints.length, 1);
  });
});

describe("a refusal that is remembered", () => {
  it("stands down for good when the account's sync is disabled, and tells the host once", async () => {
    const told: Array<{ agentId: string; message: string }> = [];
    const world = clientWorld({ metrics: true, onSyncDisabledMint: (event) => void told.push(event) });
    const refusal = Object.assign(new Error("agent store sync is not enabled"), { code: 3 });
    world.answerMint(refusal);
    await assert.rejects(() => world.client.listFiles({ agentId: STORE_ID, relPath: "" }), /sync is not enabled/);
    assert.deepEqual([world.events, told], [[["failure", { agentId: STORE_ID, kind: "stand_down" }]], [{ agentId: STORE_ID, message: "agent store sync is not enabled" }]]);
    // Every call after it is refused with the same error, without asking the store again.
    world.setNow(10_000_000);
    await assert.rejects(() => world.client.listFiles({ agentId: STORE_ID, relPath: "" }), /sync is not enabled/);
    assert.deepEqual([world.mints.length, world.events.length], [1, 2]);
  });

  it("waits out a refusal it may retry, and asks again once it has", async () => {
    const world = clientWorld({ metrics: true, baseMs: 30_000, maxMs: 60_000 });
    const refusal = Object.assign(new Error("bad request"), { code: 3 });
    world.answerMint(refusal, token(30_000));
    await assert.rejects(() => world.client.listFiles({ agentId: STORE_ID, relPath: "" }), /bad request/);
    assert.deepEqual(world.events, [["failure", { agentId: STORE_ID, kind: "backoff" }]]);
    // Before the wait is over the same error is answered from what was remembered, for as long as it was told.
    await assert.rejects(() => world.client.listFiles({ agentId: STORE_ID, relPath: "" }), /bad request/);
    const untilMs = (world.events[1]![1] as { untilMs: number }).untilMs;
    assert.deepEqual([world.mints.length, world.events[1]![0], untilMs > 1_000, untilMs <= 1_000 + 30_000 * 1.2], [1, "negative", true, true]);
    // Once it is over, the store is asked again.
    world.setNow(untilMs);
    assert.deepEqual(await world.client.listFiles({ agentId: STORE_ID, relPath: "" }), {});
    assert.equal(world.mints.length, 2);
    // A refusal that is not one to remember is not remembered.
    const other = clientWorld();
    other.answerMint(new Error("the store is down"));
    await assert.rejects(() => other.client.listFiles({ agentId: STORE_ID, relPath: "" }), /the store is down/);
    await assert.rejects(() => other.client.listFiles({ agentId: STORE_ID, relPath: "" }), /the store is down/);
    assert.equal(other.mints.length, 2);
  });

  it("does not let a host that could not be told stop the stand-down", async () => {
    const world = clientWorld({
      onSyncDisabledMint: () => {
        throw new Error("the host did not answer");
      },
    });
    world.answerMint(Object.assign(new Error("agent store sync is not enabled"), { code: 3 }));
    await assert.rejects(() => world.client.listFiles({ agentId: STORE_ID, relPath: "" }), /sync is not enabled/);
    const asynchronous = clientWorld({ onSyncDisabledMint: async () => Promise.reject(new Error("the host did not answer")) });
    asynchronous.answerMint(Object.assign(new Error("agent store sync is not enabled"), { code: 3 }));
    await assert.rejects(() => asynchronous.client.listFiles({ agentId: STORE_ID, relPath: "" }), /sync is not enabled/);
  });
});

describe("what the client does without a transport part, and what it hands on", () => {
  it("says so when the transport cannot delete, and leaves the halves it has no transport for undefined", async () => {
    const world = clientWorld({ without: ["deleteFiles", "completeMultipartWrites", "abortMultipartWrites"] });
    await assert.rejects(() => world.client.deleteFiles({ agentId: STORE_ID, files: [] }), /does not support deleteFiles/);
    assert.deepEqual([world.client.completeMultipartWrites, world.client.abortMultipartWrites], [undefined, undefined]);
  });

  it("hands an invalidation to the store the token names, and nothing when there is no token", async () => {
    const world = clientWorld();
    world.client.invalidateListCache({ agentId: STORE_ID, shareId: "share-1" });
    assert.deepEqual(world.invalidations, []);
    await world.client.listFiles({ agentId: STORE_ID, relPath: "" });
    world.client.invalidateListCache({ agentId: STORE_ID });
    assert.deepEqual(world.invalidations, [{ storeId: "store-1" }]);
    // A call made through a share is invalidated under the share, which keeps its own token.
    await world.client.listFiles({ agentId: STORE_ID, shareId: "share-1", relPath: "" });
    world.client.invalidateListCache({ agentId: STORE_ID, shareId: "share-1" });
    assert.deepEqual(world.invalidations, [{ storeId: "store-1" }, { storeId: "store-1", shareId: "share-1" }]);
    // A token that names no store has nothing to invalidate either.
    const storeless = clientWorld();
    storeless.answerMint(token(30_000, []));
    await assert.rejects(() => storeless.client.listFiles({ agentId: STORE_ID, relPath: "" }), /did not include a scoped store id/);
    storeless.client.invalidateListCache({ agentId: STORE_ID });
    assert.deepEqual(storeless.invalidations, []);
  });

  it("stops waiting for a token when the caller stops", async () => {
    const world = clientWorld();
    let release: (() => void) | undefined;
    const held = new Promise<AgentStoreToken>((resolve) => (release = () => resolve(token(30_000))));
    world.answerMint(held as never);
    const controller = new AbortController();
    const pending = world.client.listFiles({ agentId: STORE_ID, relPath: "", signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    // A caller who was already stopped is refused at once.
    const stopped = new AbortController();
    stopped.abort();
    const already = clientWorld();
    already.answerMint(held as never);
    await assert.rejects(() => already.client.listFiles({ agentId: STORE_ID, relPath: "", signal: stopped.signal }), (error: unknown) => error instanceof Error && error.name === "AbortError");
    release!();
  });
});
