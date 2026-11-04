import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  blobDbPathFor,
  conversationHardLimitBytes,
  conversationSoftLimitBytes,
  ensureConversationCapacityForTurn,
  GC_PENDING_WRITE_RETENTION_MS,
  HARD_LIMIT_DEFAULT_BYTES,
  isConversationGcEnabled,
  measureConversationBlobBytes,
  pinConversationGc,
  pinConversationGcReporter,
  pinConversationSizeLimitsReader,
  reportConversationGcVerdict,
  runConversationGc,
  scheduleConversationSizeMaintenance,
  SOFT_GC_MIN_INTERVAL_MS,
  SOFT_LIMIT_DEFAULT_BYTES,
  SlateConversationTooLargeError,
  type ConversationGcReport,
  type ConversationGcVerdict,
} from "../../source/host/extensions/session/conversation-size-limits.ts";

async function withRoot(run: (rootDir: string) => Promise<void> | void): Promise<void> {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-conversation-limits-"));
  try {
    await run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function withLimitEnvironment(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function configureHost(
  collect: (args: Record<string, unknown>) => Promise<ConversationGcVerdict>,
  calls: Array<Record<string, unknown>> = [],
) {
  return {
    requireWorkerPool() {
      return {
        collectConversationGarbage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return collect(args);
        },
      };
    },
  } as never;
}

function dbRoot(root: Uint8Array = Uint8Array.from([1, 2, 3])) {
  return { get: () => root };
}

describe("conversation storage limits", () => {
  it("keeps the default size limits ordered and the maintenance windows named", () => {
    assert.equal(SOFT_LIMIT_DEFAULT_BYTES, 256 * 1024 * 1024);
    assert.equal(HARD_LIMIT_DEFAULT_BYTES, 1024 * 1024 * 1024);
    assert.equal(conversationSoftLimitBytes({}), SOFT_LIMIT_DEFAULT_BYTES);
    assert.equal(conversationHardLimitBytes({}), HARD_LIMIT_DEFAULT_BYTES);
    assert.equal(GC_PENDING_WRITE_RETENTION_MS, 60_000);
    assert.equal(SOFT_GC_MIN_INTERVAL_MS, 30 * 60_000);
  });

  it("takes valid byte overrides first, then pinned MB limits, and floors both", () => {
    pinConversationSizeLimitsReader(() => ({ soft_limit_mb: 1.25, hard_limit_mb: 2.5 }));
    try {
      assert.equal(conversationSoftLimitBytes({}), Math.floor(1.25 * 1024 * 1024));
      assert.equal(conversationHardLimitBytes({}), Math.floor(2.5 * 1024 * 1024));
      assert.equal(conversationSoftLimitBytes({ SLATE_CONVERSATION_SOFT_LIMIT_BYTES: " 19.9 " }), 19);
      assert.equal(conversationHardLimitBytes({ SLATE_CONVERSATION_HARD_LIMIT_BYTES: "0" }), Math.floor(2.5 * 1024 * 1024));
      assert.equal(conversationHardLimitBytes({ SLATE_CONVERSATION_HARD_LIMIT_BYTES: "Infinity" }), Math.floor(2.5 * 1024 * 1024));
    } finally {
      pinConversationSizeLimitsReader(null);
    }
  });

  it("lets an explicit GC setting override the pinned default", () => {
    pinConversationGc(true);
    try {
      assert.equal(isConversationGcEnabled({}), true);
      assert.equal(isConversationGcEnabled({ SLATE_CONVERSATION_GC: "off" }), false);
      assert.equal(isConversationGcEnabled({ SLATE_CONVERSATION_GC: "YES" }), true);
      pinConversationGc(false);
      assert.equal(isConversationGcEnabled({}), false);
      assert.equal(isConversationGcEnabled({ SLATE_CONVERSATION_GC: "1" }), true);
    } finally {
      pinConversationGc(false);
    }
  });

  it("measures the database together with its WAL and treats missing files as zero", async () => {
    await withRoot(async (rootDir) => {
      const dbPath = join(rootDir, "agents", "agent-a", "conversation.db");
      const blobPath = blobDbPathFor(dbPath);
      await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(blobPath), { recursive: true }));
      writeFileSync(blobPath, Buffer.alloc(7));
      writeFileSync(`${blobPath}-wal`, Buffer.alloc(13));
      assert.equal(await measureConversationBlobBytes(blobPath), 20);
      rmSync(`${blobPath}-wal`);
      assert.equal(await measureConversationBlobBytes(blobPath), 7);
      assert.equal(await measureConversationBlobBytes(join(rootDir, "absent.db")), 0);
    });
  });

  it("maps a nonempty root to the worker pool and skips an empty one", async () => {
    await withRoot(async (rootDir) => {
      const dbPath = join(rootDir, "agents", "agent-a", "conversation.db");
      const calls: Array<Record<string, unknown>> = [];
      const verdict: ConversationGcVerdict = { outcome: "skipped", reason: "unresolved-refs", unresolvedProtoRefs: 2 };
      const host = configureHost(async () => verdict, calls);
      assert.equal(await runConversationGc(host, dbPath, dbRoot(new Uint8Array())), null);
      assert.equal(calls.length, 0);
      assert.deepEqual(await runConversationGc(host, dbPath, dbRoot(Uint8Array.from([1, 2, 255]))), verdict);
      assert.deepEqual(calls, [{
        agentId: "agent-a",
        blobDbPath: blobDbPathFor(dbPath),
        retainedRootIdHex: "0102ff",
        pendingWriteRetentionMs: GC_PENDING_WRITE_RETENTION_MS,
        legacyBlobDbPath: dbPath,
      }]);
    });
  });

  it("reports each GC outcome with its agent id and skip details", async () => {
    const reports: ConversationGcReport[] = [];
    pinConversationGcReporter((report) => reports.push(report));
    try {
      const path = "/data/agents/agent-a/conversation.db";
      reportConversationGcVerdict("scheduled", path, null);
      reportConversationGcVerdict("turn_gate", path, { outcome: "failed" });
      reportConversationGcVerdict("turn_gate", path, { outcome: "skipped", reason: "unresolved-refs", unresolvedProtoRefs: 3 });
      reportConversationGcVerdict("turn_gate", path, {
        outcome: "collected", deletedRows: 2, deletedBytes: 8, liveRows: 4, liveBytes: 20, vacuumed: true,
      }, true);
      assert.deepEqual(reports, [
        { trigger: "scheduled", agentId: "agent-a", outcome: "skipped", skipReason: "no-root" },
        { trigger: "turn_gate", agentId: "agent-a", outcome: "failed" },
        { trigger: "turn_gate", agentId: "agent-a", outcome: "skipped", skipReason: "unresolved-refs", unresolvedProtoRefs: 3 },
        { trigger: "turn_gate", agentId: "agent-a", outcome: "collected", deletedRows: 2, deletedBytes: 8, liveRows: 4, liveBytes: 20, vacuumed: true, stillOverCap: true },
      ]);
    } finally {
      pinConversationGcReporter(null);
    }
  });

  it("does not inspect the store when collection is disabled", async () => {
    await withRoot(async (rootDir) => {
      await withLimitEnvironment({ SLATE_CONVERSATION_GC: "0", SLATE_CONVERSATION_HARD_LIMIT_BYTES: "1" }, async () => {
        const dbPath = join(rootDir, "agents", "agent-a", "conversation.db");
        const blobPath = blobDbPathFor(dbPath);
        await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(blobPath), { recursive: true }));
        writeFileSync(blobPath, Buffer.alloc(2));
        let requestedPool = 0;
        const host = { requireWorkerPool: () => { requestedPool += 1; throw new Error("unexpected pool request"); } } as never;
        await ensureConversationCapacityForTurn(host, dbPath, dbRoot());
        assert.equal(requestedPool, 0);
      });
    });
  });

  it("coalesces soft collection and respects its minimum interval", async () => {
    await withRoot(async (rootDir) => {
      await withLimitEnvironment({ SLATE_CONVERSATION_GC: "true", SLATE_CONVERSATION_SOFT_LIMIT_BYTES: "5", SLATE_CONVERSATION_HARD_LIMIT_BYTES: "100" }, async () => {
        const dbPath = join(rootDir, "agents", "agent-a", "conversation.db");
        const blobPath = blobDbPathFor(dbPath);
        await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(blobPath), { recursive: true }));
        writeFileSync(blobPath, Buffer.alloc(10));
        let finish: ((verdict: ConversationGcVerdict) => void) | undefined;
        const hold = new Promise<ConversationGcVerdict>((resolve) => { finish = resolve; });
        const calls: Array<Record<string, unknown>> = [];
        const reports: ConversationGcReport[] = [];
        pinConversationGcReporter((report) => reports.push(report));
        try {
          let announceStarted: (() => void) | undefined;
          const workStarted = new Promise<void>((resolve) => { announceStarted = resolve; });
          const waitingHost = configureHost(async (args) => {
            calls.push(args);
            announceStarted?.();
            return await hold;
          });
          scheduleConversationSizeMaintenance(waitingHost, dbPath, dbRoot());
          scheduleConversationSizeMaintenance(waitingHost, dbPath, dbRoot());
          await workStarted;
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(calls.length, 1);
          finish?.({ outcome: "collected", deletedRows: 1, deletedBytes: 10, liveRows: 0, liveBytes: 0, vacuumed: false });
          await new Promise((resolve) => setTimeout(resolve, 20));
          scheduleConversationSizeMaintenance(waitingHost, dbPath, dbRoot());
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(calls.length, 1);
          assert.equal(reports[0]?.trigger, "soft_schedule");
        } finally {
          pinConversationGcReporter(null);
        }
      });
    });
  });

  it("schedules soft collection when the measured size reaches the soft limit", async () => {
    await withRoot(async (rootDir) => {
      await withLimitEnvironment({ SLATE_CONVERSATION_GC: "true", SLATE_CONVERSATION_SOFT_LIMIT_BYTES: "5", SLATE_CONVERSATION_HARD_LIMIT_BYTES: "10" }, async () => {
        const dbPath = join(rootDir, "agents", "agent-a", "conversation.db");
        const blobPath = blobDbPathFor(dbPath);
        await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(blobPath), { recursive: true }));
        writeFileSync(blobPath, Buffer.alloc(5));
        let started = false;
        const host = configureHost(async () => {
          started = true;
          return { outcome: "skipped", reason: "unresolved-refs", unresolvedProtoRefs: 1 };
        });
        await ensureConversationCapacityForTurn(host, dbPath, dbRoot());
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(started, true);
      });
    });
  });

  it("runs a hard-limit collection and reports whether the store came back under cap", async () => {
    await withRoot(async (rootDir) => {
      await withLimitEnvironment({ SLATE_CONVERSATION_GC: "1", SLATE_CONVERSATION_SOFT_LIMIT_BYTES: "5", SLATE_CONVERSATION_HARD_LIMIT_BYTES: "10" }, async () => {
        const dbPath = join(rootDir, "agents", "agent-a", "conversation.db");
        const blobPath = blobDbPathFor(dbPath);
        await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(blobPath), { recursive: true }));
        writeFileSync(blobPath, Buffer.alloc(10));
        const reports: ConversationGcReport[] = [];
        pinConversationGcReporter((report) => reports.push(report));
        try {
          const host = configureHost(async () => {
            truncateSync(blobPath, 1);
            return { outcome: "collected", deletedRows: 1, deletedBytes: 9, liveRows: 1, liveBytes: 1, vacuumed: false };
          });
          await assert.doesNotReject(() => ensureConversationCapacityForTurn(host, dbPath, dbRoot()));
          assert.deepEqual(reports.at(-1), { trigger: "turn_gate", agentId: "agent-a", outcome: "collected", deletedRows: 1, deletedBytes: 9, liveRows: 1, liveBytes: 1, vacuumed: false, stillOverCap: false });
        } finally {
          pinConversationGcReporter(null);
        }
      });
    });
  });

  it("throws only when a collected store remains at the hard limit", async () => {
    await withRoot(async (rootDir) => {
      await withLimitEnvironment({ SLATE_CONVERSATION_GC: "true", SLATE_CONVERSATION_SOFT_LIMIT_BYTES: "5", SLATE_CONVERSATION_HARD_LIMIT_BYTES: "10" }, async () => {
        const dbPath = join(rootDir, "agents", "agent-a", "conversation.db");
        const blobPath = blobDbPathFor(dbPath);
        await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(blobPath), { recursive: true }));
        writeFileSync(blobPath, Buffer.alloc(10));
        const reports: ConversationGcReport[] = [];
        pinConversationGcReporter((report) => reports.push(report));
        try {
          const host = configureHost(async () => ({ outcome: "collected", deletedRows: 0, deletedBytes: 0, liveRows: 1, liveBytes: 10, vacuumed: false }));
          await assert.rejects(
            () => ensureConversationCapacityForTurn(host, dbPath, dbRoot()),
            (error: unknown) => error instanceof SlateConversationTooLargeError && error.isConversationTooLarge,
          );
          assert.equal((reports.at(-1) as ConversationGcReport & { stillOverCap?: boolean }).stillOverCap, true);
        } finally {
          pinConversationGcReporter(null);
        }
      });
    });
  });

  it("reports worker failures and skipped collection without treating them as a size exception", async () => {
    await withRoot(async (rootDir) => {
      await withLimitEnvironment({ SLATE_CONVERSATION_GC: "on", SLATE_CONVERSATION_SOFT_LIMIT_BYTES: "1", SLATE_CONVERSATION_HARD_LIMIT_BYTES: "2" }, async () => {
        const dbPath = join(rootDir, "agents", "agent-a", "conversation.db");
        const blobPath = blobDbPathFor(dbPath);
        await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(blobPath), { recursive: true }));
        writeFileSync(blobPath, Buffer.alloc(2));
        const reports: ConversationGcReport[] = [];
        pinConversationGcReporter((report) => reports.push(report));
        try {
          const skipped = configureHost(async () => ({ outcome: "skipped", reason: "unresolved-refs", unresolvedProtoRefs: 1 }));
          await assert.doesNotReject(() => ensureConversationCapacityForTurn(skipped, dbPath, dbRoot()));
          assert.equal(reports.at(-1)?.outcome, "skipped");
          const failed = configureHost(async () => { throw new Error("worker failed"); });
          await assert.doesNotReject(() => ensureConversationCapacityForTurn(failed, dbPath, dbRoot()));
          assert.equal(reports.at(-1)?.outcome, "failed");
        } finally {
          pinConversationGcReporter(null);
        }
      });
    });
  });
});
