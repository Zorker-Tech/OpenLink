import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { ConversationStateStructure } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { encodeInteropAgentConversationCheckpoint } from "../../source/adapters/interop/agent/agent-conversation-protobuf-adapter.ts";
import { decodeConversationStateStructure } from "../../source/adapters/interop/local-conversation-state.ts";
import {
  HIDDEN_ENTRY_REPAIR_VERSION,
  LEGACY_BLOB_RETIREMENT_VERSION,
  STALE_ROOT_CLEANUP_VERSION,
  backfillTranscript,
  cleanupLegacyGroupMemberDirs,
  clearStaleCheckpointRootsOnce,
  findLatestDurableRootBlobId,
  isLegacyStoreBlobRetirementEnabled,
  pinLegacyStoreBlobRetirement,
  pinStaleRootGc,
  recoverConversationIfRootMissing,
  repairHiddenTranscriptEntriesOnce,
  retireLegacyStoreBlobsOnce,
  runSessionMaintenance,
  type MaintenanceDb,
  type MaintenanceHost,
  type MaintenanceStore,
} from "../../source/host/extensions/session/session-maintenance.ts";
import { ConversationRecoveryScanError } from "../../source/host/extensions/session/session-recovery.ts";
import { createEmptySlateConversationCheckpointV2 } from "../../source/packages/agent/conversation-checkpoint-state.ts";
import {
  MAX_ROOT_BLOB_BYTES,
  REBUILT_ENTRY_ID_PREFIX,
  conversationStructureFullyResolves,
  findLatestRootBlobIdInDatabase,
  isBetterRoot,
  rebuildTranscriptEntriesFromState,
  scoreRootCandidate,
  selectHiddenArtifactEntryIds,
  type OutlineItem,
} from "../../source/host/extensions/session/conversation-recovery.ts";

interface Harness {
  db: MaintenanceDb;
  store: MaintenanceStore;
  host: MaintenanceHost;
  values: Map<string, unknown>;
  calls: {
    worker: Array<{ name: string; args: Record<string, unknown> }>;
    resets: number;
    reports: Array<Record<string, unknown>>;
    appended: Array<Record<string, unknown>>;
    deleted: string[];
  };
  setGeneration(value: number): void;
  setHandles(value: number): void;
}

function harness(options: {
  dbPath?: string;
  root?: Uint8Array;
  durableRoot?: Uint8Array;
  legacy?: boolean;
  transcriptEntries?: Array<Record<string, unknown>>;
  deleteAllowed?: boolean;
  blob?: Uint8Array | null;
  state?: { turns: readonly { items: readonly OutlineItem[] }[] } | null;
  outline?: readonly OutlineItem[];
} = {}): Harness {
  const values = new Map<string, unknown>([["latestRootBlobId", options.root ?? new Uint8Array()]]);
  const entries = options.transcriptEntries ?? [];
  const calls: Harness["calls"] = { worker: [], resets: 0, reports: [], appended: [], deleted: [] };
  let staleVersion = 0;
  let hiddenVersion = 0;
  let retirementVersion = 0;
  let hasLegacy = options.legacy ?? false;
  let generation = 0;
  let liveHandles = 1;

  const db: MaintenanceDb = {
    get(key) { return values.get(key) as string | Uint8Array ?? new Uint8Array(); },
    set(key, value) { values.set(key, value); return true; },
    compareAndSetLatestRootBlobId({ expectedRoot, nextRoot }) {
      const current = values.get("latestRootBlobId");
      if (!(current instanceof Uint8Array) || !Buffer.from(current).equals(Buffer.from(expectedRoot))) return false;
      values.set("latestRootBlobId", nextRoot);
      return true;
    },
    getTranscriptEntries() { return entries; },
    appendTranscriptEntries(next) { calls.appended.push(...next); entries.push(...next); return next.length; },
    deleteTranscriptEntry(id) {
      calls.deleted.push(id);
      if (options.deleteAllowed === false) return false;
      const index = entries.findIndex(entry => entry.id === id);
      if (index < 0) return false;
      entries.splice(index, 1);
      return true;
    },
    getStaleRootCleanupVersion() { return staleVersion; },
    setStaleRootCleanupVersion(version) { staleVersion = version; return true; },
    getHiddenEntryRepairVersion() { return hiddenVersion; },
    setHiddenEntryRepairVersion(version) { hiddenVersion = version; return true; },
    hasLegacyConversationBlobs() { return hasLegacy; },
    getLegacyBlobRetirementVersion() { return retirementVersion; },
    retireLegacyConversationBlobs(version) { retirementVersion = version; hasLegacy = false; return true; },
  };

  const structure = { ...createEmptySlateConversationCheckpointV2(), turnBlobIds: ["01"] };
  const state = options.state === undefined ? { turns: [{ items: [{ kind: "user", id: "turn-1", text: "recovered" } as OutlineItem] }] } : options.state;
  const worker = {
    async clearStaleCheckpointRoots(agentId: string, blobDbPath: string, rootHex: string, dbPath: string) {
      calls.worker.push({ name: "clearStaleCheckpointRoots", args: { agentId, blobDbPath, rootHex, dbPath } });
      return 2;
    },
    async findLatestRootBlobId(args: { agentId: string; blobDbPath: string; legacyBlobDbPath: string }) {
      calls.worker.push({ name: "findLatestRootBlobId", args });
      return options.durableRoot ?? new Uint8Array([0xaa]);
    },
    async verifyLegacyBlobRetirement(args: { agentId: string; blobDbPath: string; legacyBlobDbPath: string; retainedRootIdHex: string }) {
      calls.worker.push({ name: "verifyLegacyBlobRetirement", args });
      return { isRetirable: true, legacyRows: 1, legacyBytes: 3 };
    },
  };
  const store: MaintenanceStore = {
    getConversationStateStructure: () => structure,
    getBlobStore: () => ({ async getBlob() { return options.blob ?? new Uint8Array([1]); } }),
    async getFullConversation() { return { turns: state?.turns ?? [] }; },
    async resetFromDb() { calls.resets += 1; },
  };
  const dbPath = options.dbPath ?? "/agents/agent-1/conversation.db";
  const host: MaintenanceHost = {
    rootDir: "/root",
    ctx: {},
    liveHandleCount: () => liveHandles,
    writeGeneration: () => generation,
    async resolveConversationState() { return state; },
    deriveOutline: () => options.outline ?? [{ kind: "user", id: "turn-1", text: "recovered", hidden: true }],
    report: event => calls.reports.push(event),
    requireWorkerPool: () => worker,
  };
  return {
    db,
    store,
    host,
    values,
    calls,
    setGeneration: value => { generation = value; },
    setHandles: value => { liveHandles = value; },
  };
}

describe("conversation recovery projections", () => {
  it("publishes the root-size bound and recovered-entry id namespace", () => {
    assert.equal(MAX_ROOT_BLOB_BYTES, 8 * 1024 * 1024);
    assert.equal(REBUILT_ENTRY_ID_PREFIX, "recovered-");
  });

  it("decodes Slate checkpoint references needed by recovery", () => {
    const stored = new ConversationStateStructure({
      turns: [new Uint8Array([1])],
      todos: [new Uint8Array([2])],
      rootPromptMessagesJson: [new Uint8Array([3])],
      summary: new Uint8Array([4]),
    });
    assert.deepEqual(decodeConversationStateStructure(encodeInteropAgentConversationCheckpoint(stored)), {
      turns: [new Uint8Array([1])],
      todos: [new Uint8Array([2])],
      rootPromptMessagesJson: [new Uint8Array([3])],
      summary: new Uint8Array([4]),
    });
  });

  it("continues to decode legacy protobuf snapshots during recovery", () => {
    const stored = new ConversationStateStructure({
      turns: [new Uint8Array([1])],
      todos: [new Uint8Array([2])],
      rootPromptMessagesJson: [new Uint8Array([3])],
      summary: new Uint8Array([4]),
    });
    assert.deepEqual(decodeConversationStateStructure(stored.toBinary()), {
      turns: [new Uint8Array([1])],
      todos: [new Uint8Array([2])],
      rootPromptMessagesJson: [new Uint8Array([3])],
      summary: new Uint8Array([4]),
    });
  });

  it("rebuilds visible user, outbound and tool entries while omitting hidden user entries", () => {
    const entries = rebuildTranscriptEntriesFromState({
      turns: [{ items: [
        { kind: "user", id: "visible", text: "hello", timestampMs: 11 },
        { kind: "user", id: "hidden", text: "secret", hidden: true, timestampMs: 12 },
        { kind: "user", id: "blank" },
        { kind: "send-message", id: "sent", message: { text: "outbound" }, timestampMs: 22 },
        { kind: "tool-call", id: "tool", name: "Search", status: "done", summary: "found", timestampMs: 33 },
        { kind: "tool-call", id: "empty-tool", name: "Other", status: "running" },
      ] }] as const,
    });
    assert.deepEqual(entries, [
      { kind: "message", id: "recovered-visible", role: "user", content: "hello", isStreaming: false, timestampMs: 11 },
      { kind: "message", id: "recovered-blank", role: "user", content: "", isStreaming: false },
      { kind: "send-message", id: "recovered-sent", message: { text: "outbound" }, timestampMs: 22 },
      { kind: "tool-call", id: "recovered-tool", name: "Search", status: "done", summary: "found", timestampMs: 33 },
      { kind: "tool-call", id: "recovered-empty-tool", name: "Other", status: "running" },
    ]);
  });

  it("selects only recovered hidden user artifacts whose text still matches the outline", () => {
    const entries = [
      { kind: "message", id: "recovered-hidden", role: "user", content: "secret" },
      { kind: "message", id: "recovered-changed", role: "user", content: "edited" },
      { kind: "send-message", id: "recovered-hidden", role: "user", content: "secret" },
      { kind: "message", id: "ordinary-hidden", role: "user", content: "secret" },
      { kind: "message", id: "recovered-visible", role: "user", content: "public" },
    ];
    const outline: OutlineItem[] = [
      { kind: "user", id: "hidden", text: "secret", hidden: true },
      { kind: "user", id: "changed", text: "secret", hidden: true },
      { kind: "user", id: "visible", text: "public", hidden: false },
    ];
    assert.deepEqual(selectHiddenArtifactEntryIds(entries, outline), ["recovered-hidden"]);
  });

  it("requires at least one turn and resolves every turn, todo and nonempty summary blob", async () => {
    const calls: string[] = [];
    const blobs = new Map<string, Uint8Array>([
      ["01", new Uint8Array([1])],
      ["02", new Uint8Array([2])],
      ["03", new Uint8Array([3])],
    ]);
    const blobStore = {
      async getBlob(_ctx: unknown, id: Uint8Array) {
        const key = [...id].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        calls.push(key);
        return blobs.get(key) ?? null;
      },
    };
    assert.equal(await conversationStructureFullyResolves({}, { turns: [], todos: [] }, blobStore), false);
    assert.deepEqual(calls, []);
    assert.equal(await conversationStructureFullyResolves({}, {
      turns: [new Uint8Array([1])], todos: [new Uint8Array([2])], summary: new Uint8Array([3]),
    }, blobStore), true);
    assert.deepEqual(calls, ["01", "02", "03"]);
    calls.length = 0;
    assert.equal(await conversationStructureFullyResolves({}, {
      turns: [new Uint8Array([1])], todos: [], summary: new Uint8Array(),
    }, blobStore), true);
    assert.deepEqual(calls, ["01"]);
  });

  it("declines missing or oversized blobs but accepts a blob at the exact size limit", async () => {
    const id = new Uint8Array([7]);
    const blobStore = { async getBlob() { return new Uint8Array(MAX_ROOT_BLOB_BYTES); } };
    assert.equal(await conversationStructureFullyResolves({}, { turns: [id], todos: [] }, blobStore), true);
    const oversized = { async getBlob() { return new Uint8Array(MAX_ROOT_BLOB_BYTES + 1); } };
    assert.equal(await conversationStructureFullyResolves({}, { turns: [id], todos: [] }, oversized), false);
    const missing = { async getBlob() { return null; } };
    assert.equal(await conversationStructureFullyResolves({}, { turns: [id], todos: [] }, missing), false);
  });

  it("scores only parseable roots with turns whose referenced blobs all exist", () => {
    const turnId = new Uint8Array([0x01, 0xab]);
    const bytes = new ConversationStateStructure({
      turns: [turnId],
      rootPromptMessagesJson: [new Uint8Array([1]), new Uint8Array([2])],
    }).toBinary();
    assert.deepEqual(scoreRootCandidate(bytes, new Set(["01ab"])), {
      turns: 1,
      rootPrompts: 2,
      bytes: bytes.byteLength,
    });
    assert.equal(scoreRootCandidate(bytes, new Set()), null);
    assert.equal(scoreRootCandidate(new ConversationStateStructure().toBinary(), new Set()), null);
    assert.equal(scoreRootCandidate(new Uint8Array([0xff]), new Set()), null);
    assert.equal(scoreRootCandidate(new Uint8Array(MAX_ROOT_BLOB_BYTES + 1), new Set()), null);
  });

  it("ranks roots by turn count, prompt count and finally byte length", () => {
    const base = { turns: 1, rootPrompts: 1, bytes: 10 };
    assert.equal(isBetterRoot(base, null), true);
    assert.equal(isBetterRoot({ turns: 2, rootPrompts: 0, bytes: 1 }, base), true);
    assert.equal(isBetterRoot({ turns: 1, rootPrompts: 2, bytes: 1 }, base), true);
    assert.equal(isBetterRoot({ turns: 1, rootPrompts: 1, bytes: 11 }, base), true);
    assert.equal(isBetterRoot(base, base), false);
  });

  it("selects the strongest database root whose turn blobs exist", () => {
    const turnA = new Uint8Array([0x01]);
    const turnB = new Uint8Array([0x02]);
    const turnC = new Uint8Array([0x03]);
    const rootA = new ConversationStateStructure({ turns: [turnA], rootPromptMessagesJson: [new Uint8Array([1])] }).toBinary();
    const rootB = new ConversationStateStructure({ turns: [turnA, turnB] }).toBinary();
    const rootC = new Uint8ClampedArray(new ConversationStateStructure({ turns: [turnA, turnB, turnC] }).toBinary());
    const blobs = [
      { id: "01", data: new Uint8Array([1]) },
      { id: "02", data: new Uint8Array([2]) },
      { id: "03", data: new Uint8Array([3]) },
      { id: "aa", data: rootA },
      { id: "bb", data: rootB },
      { id: "cc", data: new Uint8Array([0xff]) },
      { id: "dd", data: rootC },
    ];
    const queries: string[] = [];
    const db = {
      prepare(sql: string) {
        queries.push(sql);
        return { iterate: () => sql === "SELECT id FROM blobs" ? blobs.map(({ id }) => ({ id })) : blobs };
      },
    };
    assert.deepEqual(findLatestRootBlobIdInDatabase(db), new Uint8Array([0xbb]));
    assert.deepEqual(queries, ["SELECT id FROM blobs", "SELECT id, data FROM blobs"]);
  });
});

describe("session maintenance contract", () => {
  it("publishes version markers for cleanup and repair steps", () => {
    assert.equal(LEGACY_BLOB_RETIREMENT_VERSION, 1);
    assert.equal(STALE_ROOT_CLEANUP_VERSION, 1);
    assert.equal(HIDDEN_ENTRY_REPAIR_VERSION, 1);
  });

  it("uses explicit legacy-retirement environment values before the pinned default", () => {
    pinLegacyStoreBlobRetirement(true);
    assert.equal(isLegacyStoreBlobRetirementEnabled({} as NodeJS.ProcessEnv), true);
    assert.equal(isLegacyStoreBlobRetirementEnabled({ SLATE_RETIRE_LEGACY_STORE_BLOBS: "false" } as NodeJS.ProcessEnv), false);
    assert.equal(isLegacyStoreBlobRetirementEnabled({ SLATE_RETIRE_LEGACY_STORE_BLOBS: " ON " } as NodeJS.ProcessEnv), true);
    assert.equal(isLegacyStoreBlobRetirementEnabled({ SLATE_RETIRE_LEGACY_STORE_BLOBS: "maybe" } as NodeJS.ProcessEnv), true);
    pinLegacyStoreBlobRetirement(false);
    assert.equal(isLegacyStoreBlobRetirementEnabled({ SLATE_RETIRE_LEGACY_STORE_BLOBS: "maybe" } as NodeJS.ProcessEnv), false);
  });

  it("backfills only the missing transcript tail when persisted entries are a matching prefix", () => {
    const entries: Record<string, unknown>[] = [{ kind: "message", id: "recovered-turn-1", role: "user", content: "old" }];
    const appended: Array<Record<string, unknown>> = [];
    const db = {
      getTranscriptEntries: () => entries,
      appendTranscriptEntries: (values: readonly (Record<string, unknown> & { id: string; kind: string })[]) => { appended.push(...values); return true; },
    };
    const state = { turns: [{ items: [
      { kind: "user", id: "turn-1", text: "old" } as OutlineItem,
      { kind: "send-message", id: "turn-2", message: { type: "text", content: "new" } } as OutlineItem,
    ] }] };
    assert.equal(backfillTranscript({}, db, state), 1);
    assert.deepEqual(appended.map(entry => entry.id), ["recovered-turn-2"]);
    assert.equal(backfillTranscript({}, db, [...appended, { kind: "message", id: "bad", role: "user", content: "different" }]), 0);
  });

  it("accepts a complete transcript already written and reports the actual append count", () => {
    const rebuilt = [{ kind: "message", id: "recovered-turn-1", role: "user", content: "hello", isStreaming: false }];
    const db = { getTranscriptEntries: () => rebuilt, appendTranscriptEntries: () => 17 };
    assert.equal(backfillTranscript({}, db, [{ kind: "user", id: "turn-1", text: "hello" } as OutlineItem] as unknown as readonly Record<string, unknown>[]), 0);
    const partial = { getTranscriptEntries: () => [], appendTranscriptEntries: () => 7 };
    assert.equal(backfillTranscript({}, partial, [{ ...rebuilt[0]!, id: "recovered" }] as unknown as readonly Record<string, unknown>[]), 7);
  });

  it("clears stale checkpoint roots once only after the writer and root remain stable", async () => {
    pinStaleRootGc(true);
    const root = new Uint8Array([0x12, 0x34]);
    const h = harness({ root });
    assert.equal(await clearStaleCheckpointRootsOnce(h.host, "/agents/agent-1/conversation.db", h.db, h.store), true);
    assert.deepEqual(h.calls.worker[0], {
      name: "clearStaleCheckpointRoots",
      args: { agentId: "agent-1", blobDbPath: "/agents/agent-1/conversation-blobs.db", rootHex: "1234", dbPath: "/agents/agent-1/conversation.db" },
    });
    assert.equal(await clearStaleCheckpointRootsOnce(h.host, "/agents/agent-1/conversation.db", h.db, h.store), false);
    pinStaleRootGc(false);
  });

  it("skips stale-root cleanup when disabled, already versioned, empty, unused, or concurrently opened", async () => {
    const root = new Uint8Array([1]);
    const disabled = harness({ root });
    pinStaleRootGc(false);
    assert.equal(await clearStaleCheckpointRootsOnce(disabled.host, "/agents/a/db", disabled.db, disabled.store), false);
    const empty = harness({ root: new Uint8Array() });
    pinStaleRootGc(true);
    assert.equal(await clearStaleCheckpointRootsOnce(empty.host, "/agents/a/db", empty.db, empty.store), false);
    const busy = harness({ root });
    busy.setHandles(2);
    assert.equal(await clearStaleCheckpointRootsOnce(busy.host, "/agents/a/db", busy.db, busy.store), false);
    busy.setHandles(1);
    busy.db.setStaleRootCleanupVersion(STALE_ROOT_CLEANUP_VERSION);
    assert.equal(await clearStaleCheckpointRootsOnce(busy.host, "/agents/a/db", busy.db, busy.store), false);
    pinStaleRootGc(false);
  });

  it("declines a stale-root cleanup whose generation or latest root changed during the scan", async () => {
    const root = new Uint8Array([1]);
    const h = harness({ root });
    pinStaleRootGc(true);
    const original = h.host.requireWorkerPool;
    h.host.requireWorkerPool = () => {
      const pool = original();
      return { ...pool, async clearStaleCheckpointRoots(agentId, blobDbPath, rootHex, dbPath) { const result = await pool.clearStaleCheckpointRoots(agentId, blobDbPath, rootHex, dbPath); h.setGeneration(1); return result; } };
    };
    assert.equal(await clearStaleCheckpointRootsOnce(h.host, "/agents/a/db", h.db, h.store), false);
    assert.equal(h.values.get("staleRootCleanupVersion"), undefined);
    pinStaleRootGc(false);
  });

  it("reports stale-root scan errors and leaves the version marker unset", async () => {
    const h = harness({ root: new Uint8Array([3]) });
    pinStaleRootGc(true);
    h.host.requireWorkerPool = () => ({
      async clearStaleCheckpointRoots(_agentId: string, _blobDbPath: string, _rootHex: string, _dbPath: string) { throw new Error("worker offline"); },
      async findLatestRootBlobId() { return null; },
      async verifyLegacyBlobRetirement() { return { isRetirable: false }; },
    });
    assert.equal(await clearStaleCheckpointRootsOnce(h.host, "/agents/a/conversation.db", h.db, h.store), false);
    assert.deepEqual(h.calls.reports.at(-1), { family: "maintenance", kind: "checkpoint_cleanup_failed", agentId: "a", errorClass: "Error" });
    pinStaleRootGc(false);
  });

  it("finds a durable root through the worker and wraps scan failures", async () => {
    const root = new Uint8Array([0xab]);
    const h = harness({ durableRoot: root });
    assert.deepEqual(await findLatestDurableRootBlobId(h.host, { dbPath: "/agents/a/conversation.db", blobsPath: "/agents/a/conversation-blobs.db" }), root);
    assert.deepEqual(h.calls.worker[0], { name: "findLatestRootBlobId", args: { agentId: "a", blobDbPath: "/agents/a/conversation-blobs.db", legacyBlobDbPath: "/agents/a/conversation.db" } });
    h.host.requireWorkerPool = () => ({
      async clearStaleCheckpointRoots() { return 0; },
      async findLatestRootBlobId() { throw new Error("bad schema"); },
      async verifyLegacyBlobRetirement() { return { isRetirable: false }; },
    });
    await assert.rejects(findLatestDurableRootBlobId(h.host, { dbPath: "/agents/a/db", blobsPath: "/agents/a/blobs" }), error => {
      assert.ok(error instanceof ConversationRecoveryScanError);
      assert.equal(error.detail, "Error");
      return true;
    });
  });

  it("recovers a missing root, resets from the recovered state, and backfills transcript entries", async () => {
    const root = new Uint8Array([0xcd]);
    const structure = new ConversationStateStructure({ turns: [new Uint8Array([9])] });
    const h = harness({ blob: structure.toBinary(), root: new Uint8Array(), durableRoot: root, legacy: true, transcriptEntries: [] });
    h.host.resolveConversationState = async received => {
      assert.equal(received instanceof ConversationStateStructure, true);
      return { turns: [{ items: [{ kind: "user", id: "turn-a", text: "restored" } as OutlineItem] }] };
    };
    assert.equal(await recoverConversationIfRootMissing(h.host, "/agents/agent-a/conversation.db", h.db, h.store), true);
    assert.deepEqual(h.values.get("latestRootBlobId"), root);
    assert.equal(h.calls.resets, 1);
    assert.deepEqual(h.calls.appended.map(entry => entry.id), ["recovered-turn-a"]);
  });

  it("does not attempt recovery when a root already exists or no durable data remains", async () => {
    const existing = harness({ root: new Uint8Array([1]) });
    assert.equal(await recoverConversationIfRootMissing(existing.host, "/agents/a/db", existing.db, existing.store), false);
    const missing = harness({ legacy: false, blob: null });
    assert.equal(await recoverConversationIfRootMissing(missing.host, "/agents/a/db", missing.db, missing.store), false);
    assert.deepEqual(missing.calls.worker, []);
  });

  it("reports and rethrows a scan failure when recovering a missing root", async () => {
    const h = harness({ root: new Uint8Array(), legacy: true });
    h.host.requireWorkerPool = () => ({
      async clearStaleCheckpointRoots() { return 0; },
      async findLatestRootBlobId() { throw new Error("worker did not respond"); },
      async verifyLegacyBlobRetirement() { return { isRetirable: false }; },
    });
    await assert.rejects(recoverConversationIfRootMissing(h.host, "/agents/agent-a/conversation.db", h.db, h.store), error => {
      assert.ok(error instanceof ConversationRecoveryScanError);
      assert.equal(error.detail, "Error");
      return true;
    });
    assert.deepEqual(h.calls.reports.at(-1), { family: "maintenance", kind: "recovery_scan_failed", agentId: "agent-a", errorClass: "ConversationRecoveryScanError" });
  });

  it("does not replace the root when recovery loses a compare-and-set race", async () => {
    const root = new Uint8Array([7]);
    const h = harness({ blob: new ConversationStateStructure({ turns: [new Uint8Array([1])] }).toBinary(), root: new Uint8Array(), durableRoot: root, legacy: true });
    h.db.compareAndSetLatestRootBlobId = () => false;
    assert.equal(await recoverConversationIfRootMissing(h.host, "/agents/a/conversation.db", h.db, h.store), false);
    assert.equal(h.calls.resets, 1);
  });

  it("repairs hidden recovered user entries only after the whole stored structure resolves", async () => {
    const h = harness({ transcriptEntries: [
      { id: "recovered-turn-1", kind: "message", role: "user", content: "hidden" },
      { id: "recovered-visible", kind: "message", role: "user", content: "visible" },
      { id: "ordinary", kind: "message", role: "user", content: "ordinary" },
    ], outline: [
      { kind: "user", id: "turn-1", text: "hidden", hidden: true },
      { kind: "user", id: "visible", text: "visible", hidden: false },
    ] });
    assert.equal(await repairHiddenTranscriptEntriesOnce(h.host, "/agents/a/db", h.db, h.store), 1);
    assert.deepEqual(h.calls.deleted, ["recovered-turn-1"]);
    assert.equal(h.db.getHiddenEntryRepairVersion(), HIDDEN_ENTRY_REPAIR_VERSION);
  });

  it("records an empty hidden-repair pass, but leaves partial failures eligible for retry", async () => {
    const empty = harness({ transcriptEntries: [{ id: "normal", kind: "message", role: "user" }] });
    assert.equal(await repairHiddenTranscriptEntriesOnce(empty.host, "/agents/a/db", empty.db, empty.store), 0);
    assert.equal(empty.db.getHiddenEntryRepairVersion(), HIDDEN_ENTRY_REPAIR_VERSION);

    const blocked = harness({
      transcriptEntries: [{ id: "recovered-turn-1", kind: "message", role: "user", content: "hidden" }],
      outline: [{ kind: "user", id: "turn-1", text: "hidden", hidden: true }],
      deleteAllowed: false,
    });
    assert.equal(await repairHiddenTranscriptEntriesOnce(blocked.host, "/agents/a/db", blocked.db, blocked.store), 0);
    assert.equal(blocked.db.getHiddenEntryRepairVersion(), 0);
  });

  it("retires legacy blobs only after verification and leaves failed or disabled stores alone", async () => {
    const h = harness({ root: new Uint8Array([1]), legacy: true });
    pinLegacyStoreBlobRetirement(true);
    assert.equal(await retireLegacyStoreBlobsOnce(h.host, "/agents/a/conversation.db", h.db, h.store), true);
    assert.deepEqual(h.calls.worker.at(-1), {
      name: "verifyLegacyBlobRetirement",
      args: { agentId: "a", blobDbPath: "/agents/a/conversation-blobs.db", legacyBlobDbPath: "/agents/a/conversation.db", retainedRootIdHex: "01" },
    });
    assert.equal(h.db.getLegacyBlobRetirementVersion(), LEGACY_BLOB_RETIREMENT_VERSION);
    assert.equal(await retireLegacyStoreBlobsOnce(h.host, "/agents/a/conversation.db", h.db, h.store), false);
    pinLegacyStoreBlobRetirement(false);
  });

  it("does not retire an unverifiable legacy store and reports worker failures", async () => {
    const h = harness({ root: new Uint8Array([1]), legacy: true });
    pinLegacyStoreBlobRetirement(true);
    h.host.requireWorkerPool = () => ({
      async clearStaleCheckpointRoots() { return 0; },
      async findLatestRootBlobId() { return null; },
      async verifyLegacyBlobRetirement() { return { isRetirable: false, reason: "still referenced" }; },
    });
    assert.equal(await retireLegacyStoreBlobsOnce(h.host, "/agents/a/db", h.db, h.store), false);
    assert.equal(h.db.getLegacyBlobRetirementVersion(), 0);
    pinLegacyStoreBlobRetirement(false);
  });

  it("removes only each agent's legacy members directory", async t => {
    const root = mkdtempSync(join(tmpdir(), "slate-session-maintenance-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "agent-a", "members"), { recursive: true });
    mkdirSync(join(root, "agent-a", "other"), { recursive: true });
    mkdirSync(join(root, "agent-b", "members"), { recursive: true });
    writeFileSync(join(root, "agent-a", "members", "state"), "legacy");
    await cleanupLegacyGroupMemberDirs({ rootDir: root });
    assert.equal(existsSync(join(root, "agent-a", "members")), false);
    assert.equal(existsSync(join(root, "agent-b", "members")), false);
    assert.equal(existsSync(join(root, "agent-a", "other")), true);
  });

  it("runs maintenance tasks in order and continues after a reported failure", async () => {
    const order: number[] = [];
    const failures: Array<{ error: unknown; index: number }> = [];
    await runSessionMaintenance([
      () => { order.push(0); },
      async () => { order.push(1); throw new Error("one task failed"); },
      () => { order.push(2); },
    ], (error, index) => failures.push({ error, index }));
    assert.deepEqual(order, [0, 1, 2]);
    assert.equal((failures[0]?.error as Error).message, "one task failed");
    assert.equal(failures[0]?.index, 1);
  });
});
