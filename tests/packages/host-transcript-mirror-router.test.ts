/**
 * Which writer a conversation's transcript goes through, and what a checkpoint's four moments mean in each.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MirrorRouter, type JournalPort, type LegacyMirrorPort } from "../../source/host/transcript/mirror/transcript-mirror-router.ts";

type Checkpoint = { readonly id: string };

/** The journal and the older writer, recording what they were asked to do. */
function world(options: { owned?: readonly string[]; enabled?: boolean; legacyFails?: boolean } = {}) {
  const calls: string[] = [];
  const owned = new Set(options.owned ?? []);
  const journal: JournalPort<Checkpoint, string> = {
    async ownsConversation(conversationId) {
      calls.push(`owns:${conversationId}`);
      return owned.has(conversationId);
    },
    async claimConversation(conversationId) {
      calls.push(`claim:${conversationId}`);
      owned.add(conversationId);
    },
    async recover(_ctx, conversationId) {
      calls.push(`recover:${conversationId}`);
    },
    async prepareCheckpoint(_ctx, conversationId, checkpoint, _store, finalize) {
      calls.push(`prepare:${conversationId}:${checkpoint.id}:${String(finalize)}`);
    },
    async commitCheckpoint(_ctx, conversationId) {
      calls.push(`commit:${conversationId}`);
    },
    async abortCheckpoint(_ctx, conversationId) {
      calls.push(`abort:${conversationId}`);
    },
    async skipCheckpoint(_ctx, conversationId, checkpoint) {
      calls.push(`skip:${conversationId}:${checkpoint.id}`);
    },
  };
  const legacy: LegacyMirrorPort<Checkpoint, string> = {
    async write(_ctx, conversationId, checkpoint, _store, stateBlobId) {
      calls.push(`write:${conversationId}:${checkpoint.id}:${[...stateBlobId].join(".")}`);
      if (options.legacyFails === true) throw new Error("the older writer failed");
    },
  };
  let enabled = options.enabled ?? true;
  const router = new MirrorRouter(journal, legacy, async () => enabled);
  return { router, calls, owned, setEnabled: (value: boolean) => (enabled = value), journal };
}

const checkpoint: Checkpoint = { id: "c1" };
const stateBlobId = new Uint8Array([1, 2]);

describe("which writer a conversation gets", () => {
  it("claims a conversation for the journal once, even when two writes arrive together", async () => {
    const { router, calls } = world();
    const [first, second] = await Promise.all([router.route("conv-1"), router.route("conv-1")]);
    assert.deepEqual([first, second], ["journal", "journal"]);
    // Both callers saw the same decision: one ownership question, one claim.
    assert.deepEqual(calls, ["owns:conv-1", "claim:conv-1"]);
    assert.equal(await router.route("conv-1"), "journal");
    assert.deepEqual(calls, ["owns:conv-1", "claim:conv-1"]);
  });

  it("keeps what the journal owns even when the journal is turned off, and sends the rest to the older writer", async () => {
    const owned = world({ owned: ["conv-keep"] });
    owned.setEnabled(false);
    assert.equal(await owned.router.route("conv-keep"), "journal");
    assert.deepEqual(owned.calls, ["owns:conv-keep"]);
    const fresh = world({ enabled: false });
    assert.equal(await fresh.router.route("conv-new"), "legacy");
    assert.deepEqual(fresh.calls, ["owns:conv-new"]);
  });
});

describe("the checkpoint's moments", () => {
  it("recovers and prepares through the journal, and remembers nothing for it", async () => {
    const { router, calls } = world({ owned: ["conv-1"] });
    await router.recover({}, "conv-1", checkpoint, "store");
    await router.prepareCheckpoint({}, "conv-1", checkpoint, "store", true);
    assert.deepEqual(calls, ["owns:conv-1", "recover:conv-1", "prepare:conv-1:c1:true"]);
    assert.equal(router.legacyPending.size, 0);
  });

  it("only remembers what the older writer will be asked to commit", async () => {
    const { router, calls } = world({ enabled: false });
    // A prepare that will not be committed writes nothing and remembers nothing.
    await router.prepareCheckpoint({}, "conv-1", checkpoint, "store", false);
    assert.equal(router.legacyPending.size, 0);
    // A finalize prepare remembers it.
    await router.prepareCheckpoint({}, "conv-1", checkpoint, "store", true);
    assert.equal(router.legacyPending.size, 1);
    // The commit writes it, and forgets it.
    await router.commitCheckpoint({}, "conv-1", stateBlobId);
    assert.deepEqual(calls.filter((call) => call.startsWith("write")), ["write:conv-1:c1:1.2"]);
    assert.equal(router.legacyPending.size, 0);
    // A second commit has nothing left to write.
    await router.commitCheckpoint({}, "conv-1", stateBlobId);
    assert.equal(calls.filter((call) => call.startsWith("write")).length, 1);
  });

  it("treats the older writer's failure as observational", async () => {
    const { router } = world({ enabled: false, legacyFails: true });
    await router.prepareCheckpoint({}, "conv-1", checkpoint, "store", true);
    // The write fails, and the commit still returns: a durable checkpoint is not rolled back by a mirror.
    await router.commitCheckpoint({}, "conv-1", stateBlobId);
    assert.equal(router.legacyPending.size, 0);
  });

  it("aborts the writer that was going to write, and skips through the journal", async () => {
    const legacyAbort = world({ enabled: false });
    await legacyAbort.router.prepareCheckpoint({}, "conv-1", checkpoint, "store", true);
    await legacyAbort.router.abortCheckpoint({}, "conv-1");
    assert.equal(legacyAbort.router.legacyPending.size, 0);
    assert.equal(legacyAbort.calls.some((call) => call.startsWith("abort")), false);
    const journalAbort = world({ owned: ["conv-1"] });
    await journalAbort.router.abortCheckpoint({}, "conv-1");
    assert.deepEqual(journalAbort.calls, ["owns:conv-1", "abort:conv-1"]);
  });

  it("recovers a conversation the journal owns but this router has not routed before skipping it", async () => {
    const { router, calls } = world({ owned: ["conv-1"] });
    await router.skipCheckpoint({}, "conv-1", checkpoint, "store");
    assert.deepEqual(calls, ["owns:conv-1", "recover:conv-1", "skip:conv-1:c1"]);
    // A conversation the journal does not own is not skipped through it.
    const notOwned = world();
    await notOwned.router.skipCheckpoint({}, "conv-2", checkpoint, "store");
    assert.deepEqual(notOwned.calls, ["owns:conv-2"]);
    // A conversation already routed to the older writer drops its pending checkpoint.
    const legacy = world({ enabled: false });
    await legacy.router.prepareCheckpoint({}, "conv-3", checkpoint, "store", true);
    await legacy.router.skipCheckpoint({}, "conv-3", checkpoint, "store");
    assert.equal(legacy.router.legacyPending.size, 0);
    assert.equal(legacy.calls.some((call) => call.startsWith("skip")), false);
  });
});
