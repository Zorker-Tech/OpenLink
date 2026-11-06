import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, it } from "node:test";

import { agentSettingsAt, getSlateSettingsPath } from "../../source/host/agents/settings-file.ts";
import { getSlateProfilePath, readSlateProfileFile } from "../../source/host/agents/agent-profile.ts";
import {
  DEFAULT_AGENT_AUTOMATIONS,
  MAX_AGENTS_PER_USER,
  SlateAgentLimitError,
  SlateAgentMissingError,
  SlateSessionMaterialization,
  type MaterializationHost,
} from "../../source/host/extensions/session/session-materialization.ts";
import { agentDirectoryIdsFrom } from "../../source/host/extensions/session/session-directory-index.ts";

function withRoot(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "slate-session-materialization-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function createHost(rootDir: string, options: Partial<MaterializationHost> = {}) {
  const calls: unknown[] = [];
  const databases: Array<{ set(key: string, value: unknown): boolean; close(): void }> = [];
  const pools: Array<{ closeAll(): Promise<void> }> = [];
  const reports: Record<string, unknown>[] = [];
  const host: MaterializationHost = {
    ctx: { source: "test" },
    rootDir,
    createBlobWorkerPool: () => {
      const pool = { closeAll: async () => { calls.push("close-pool"); } };
      pools.push(pool);
      return pool as never;
    },
    createAgentStore: ({ agentId, dbPath, db }) => {
      calls.push(["create-agent-store", agentId, dbPath]);
      databases.push(db);
      return {
        resetFromDb: async (ctx: unknown) => { calls.push(["reset-from-db", ctx]); },
        getFullConversation: async () => ({ turns: [], todos: [] }),
        dispose: async () => { calls.push(["dispose-agent-store", agentId]); },
      };
    },
    createMemoryStore: (agentDir) => { calls.push(["create-memory", agentDir]); return { agentDir }; },
    resolveUserTimeZone: () => "UTC",
    agentExists: (agentId) => existsSync(join(rootDir, agentId)),
    getAgentDir: (agentId) => join(rootDir, agentId),
    readActiveAgentId: () => null,
    report: (event) => reports.push(event),
    ...options,
  };
  return { host, calls, databases, pools, reports };
}

describe("the session materializer", () => {
  it("lists only directories in sorted order and treats a missing root as empty", async () => {
    assert.deepEqual(agentDirectoryIdsFrom([
      { name: "agent-z", isDirectory: () => true },
      { name: "notes.txt", isDirectory: () => false },
      { name: "agent-a", isDirectory: () => true },
    ]), ["agent-a", "agent-z"]);
    await withRoot(async (root) => {
      mkdirSync(join(root, "agent-b"));
      mkdirSync(join(root, "agent-a"));
      writeFileSync(join(root, "notes.txt"), "not a session");
      const materializer = new SlateSessionMaterialization(createHost(root).host);
      assert.deepEqual(await materializer.listAgentRecordIds(), ["agent-a", "agent-b"]);
      assert.equal(await materializer.countOwnedAgents(), 2);
      assert.deepEqual(await new SlateSessionMaterialization(createHost(join(root, "missing")).host).listAgentRecordIds(), []);
    });
  });

  it("creates and reuses its worker pool, and closes it only when one exists", async () => {
    await withRoot(async (root) => {
      const fixture = createHost(root);
      const materializer = new SlateSessionMaterialization(fixture.host);
      assert.equal(fixture.pools.length, 0);
      const first = materializer.requireWorkerPool();
      assert.equal(materializer.requireWorkerPool(), first);
      assert.equal(fixture.pools.length, 1);
      await materializer.closeWorkerPool();
      await materializer.closeWorkerPool();
      assert.equal(fixture.calls.filter((call) => call === "close-pool").length, 1);
      assert.notEqual(materializer.requireWorkerPool(), first);
      assert.equal(fixture.pools.length, 2);
    });
  });

  it("drops the old pool reference before waiting for its close", async () => {
    await withRoot(async (root) => {
      let finishClose!: () => void;
      const closing = new Promise<void>((resolve) => { finishClose = resolve; });
      const fixture = createHost(root, {
        createBlobWorkerPool: () => {
          const pool = { closeAll: async () => closing };
          fixturePools.push(pool);
          return pool as never;
        },
      });
      const fixturePools: Array<{ closeAll(): Promise<void> }> = [];
      const materializer = new SlateSessionMaterialization(fixture.host);
      const original = materializer.requireWorkerPool();
      const closeTask = materializer.closeWorkerPool();
      const replacement = materializer.requireWorkerPool();
      finishClose();
      await closeTask;
      assert.notEqual(original, replacement);
      assert.equal(fixturePools.length, 2);
    });
  });

  it("materializes agent metadata, Slate profile/settings files, and related stores", async () => {
    await withRoot(async (root) => {
      const fixture = createHost(root);
      const materializer = new SlateSessionMaterialization(fixture.host);
      const session = await materializer.materializeSession("agent-a", {
        name: "  Agent A  ", description: "  researcher  ", title: " title ", avatarShape: " round ", avatarColor: " blue ",
      }, "dev", "research");
      try {
        assert.equal(session.id, "agent-a");
        assert.equal(session.dbPath, join(root, "agent-a", "store.db"));
        assert.equal(session.db.get("agentId"), "agent-a");
        assert.equal(session.db.getAgentOrigin(), "dev");
        assert.equal(session.db.getAgentPurpose(), "research");
        assert.deepEqual(readSlateProfileFile(getSlateProfilePath(dirname(session.dbPath))), {
          name: "Agent A", description: "researcher", title: "title", avatarShape: "round", avatarColor: "blue",
        });
        assert.deepEqual(agentSettingsAt(getSlateSettingsPath(dirname(session.dbPath))), {
          notifyOnAgentUpdates: true, hiddenFromSidebar: false,
        });
        assert.equal((session.memory as { agentDir: string }).agentDir, dirname(session.dbPath));
        assert.deepEqual(fixture.calls[0], ["create-agent-store", "agent-a", session.dbPath]);
        assert.deepEqual(DEFAULT_AGENT_AUTOMATIONS, []);
      } finally {
        await session.agentStore.dispose();
        session.db.close();
      }
    });
  });

  it("trims/defaults profile fields and omits a null purpose", async () => {
    await withRoot(async (root) => {
      const session = await new SlateSessionMaterialization(createHost(root).host).materializeSession("agent-a", {
        name: " \n ", description: "", title: "", avatarShape: "", avatarColor: "",
      }, "user", null as never);
      try {
        assert.deepEqual(readSlateProfileFile(getSlateProfilePath(dirname(session.dbPath))), {
          name: "New Bot", description: "", title: "", avatarShape: "", avatarColor: "",
        });
        assert.equal(session.db.getAgentPurpose(), null);
        assert.equal(session.db.getAgentOrigin(), "user");
      } finally {
        await session.agentStore.dispose();
        session.db.close();
      }
    });
  });

  it("opens only a known agent, repairs a missing profile, and orders reset before maintenance", async () => {
    await withRoot(async (root) => {
      const fixture = createHost(root);
      fixture.host.runMaintenance = async () => { fixture.calls.push("maintenance"); };
      const materializer = new SlateSessionMaterialization(fixture.host);
      const created = await materializer.materializeSession("agent-a", { name: "Stored name" });
      const dbPath = created.dbPath;
      created.db.set("name", "Stored name");
      created.db.close();
      await created.agentStore.dispose();
      rmSync(getSlateProfilePath(dirname(dbPath)));

      const opened = await materializer.openSession("agent-a");
      try {
        assert.equal(readSlateProfileFile(getSlateProfilePath(dirname(dbPath)))?.name, "Stored name");
        assert.deepEqual(fixture.calls.slice(-4), [
          ["create-agent-store", "agent-a", dbPath],
          ["create-memory", dirname(dbPath)],
          ["reset-from-db", fixture.host.ctx],
          "maintenance",
        ]);
        assert.equal(typeof opened.agentStore.getFullConversation, "function");
      } finally {
        await opened.agentStore.dispose();
        opened.db.close();
      }
      await assert.rejects(() => materializer.openSession("missing"), (error: unknown) =>
        error instanceof SlateAgentMissingError && error.name === "SlateAgentMissingError" && error.message === "Slate agent missing does not exist",
      );
    });
  });

  it("uses the exact agent cap and refuses another mint while all slots are owned", async () => {
    await withRoot(async (root) => {
      for (let index = 0; index < MAX_AGENTS_PER_USER; index += 1) mkdirSync(join(root, `agent-${index}`));
      const fixture = createHost(root);
      const materializer = new SlateSessionMaterialization(fixture.host);
      let minted = false;
      assert.equal(await materializer.isAgentCapReached(), true);
      await assert.rejects(() => materializer.mintAgent(async () => { minted = true; return "minted"; }), (error: unknown) =>
        error instanceof SlateAgentLimitError && error.name === "SlateAgentLimitError",
      );
      assert.equal(minted, false);
    });
  });

  it("reclaims only visible-state placeholders when checking the agent cap", async () => {
    await withRoot(async (root) => {
      const activeId = "agent-active";
      const placeholderId = "agent-pruned";
      for (let index = 0; index < MAX_AGENTS_PER_USER - 1; index += 1) {
        const agentId = index === 0 ? activeId : `agent-${index}`;
        const dir = join(root, agentId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "store.db"), "placeholder");
      }
      const prunedDir = join(root, placeholderId);
      mkdirSync(prunedDir, { recursive: true });
      writeFileSync(join(prunedDir, "store.db"), "placeholder");
      const fixture = createHost(root, {
        readActiveAgentId: () => activeId,
        isVisibleAgent: async (agentId) => agentId !== placeholderId,
      });
      const materializer = new SlateSessionMaterialization(fixture.host);

      assert.equal(await materializer.isPrunedPlaceholder(activeId), false);
      assert.equal(await materializer.isPrunedPlaceholder(placeholderId), true);
      assert.equal(await materializer.isAgentCapReached(), false);
      assert.equal(existsSync(prunedDir), false);
      assert.equal(await materializer.countOwnedAgents(), MAX_AGENTS_PER_USER - 1);
    });
  });

  it("serializes mints and continues the queue after a failed mint", async () => {
    await withRoot(async (root) => {
      const fixture = createHost(root);
      const materializer = new SlateSessionMaterialization(fixture.host);
      let releaseFirst!: () => void;
      const wait = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const order: string[] = [];
      const first = materializer.enqueueMint(async () => { order.push("first-start"); await wait; order.push("first-fail"); throw new Error("mint failed"); });
      const second = materializer.enqueueMint(async () => { order.push("second"); return "done"; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const orderBeforeRelease = [...order];
      const firstOutcome = first.then(() => "resolved", () => "rejected");
      releaseFirst();
      assert.equal(await firstOutcome, "rejected");
      assert.equal(await second, "done");
      assert.deepEqual(orderBeforeRelease, ["first-start"]);
      assert.deepEqual(order, ["first-start", "first-fail", "second"]);
    });
  });

  it("cleans a failed minted agent and reports cleanup failure without replacing the mint error", async () => {
    await withRoot(async (root) => {
      const fixture = createHost(root);
      const materializer = new SlateSessionMaterialization(fixture.host);
      let allocated = "";
      await assert.rejects(() => materializer.mintAgent(async (agentId) => {
        allocated = agentId;
        mkdirSync(join(root, agentId));
        throw new Error("primary failure");
      }), /primary failure/);
      assert.equal(existsSync(join(root, allocated)), false);

      const cleanupFailureHost = createHost(root, { getAgentDir: () => { throw new TypeError("cleanup path failed"); } });
      const cleanupFailure = new SlateSessionMaterialization(cleanupFailureHost.host);
      await assert.rejects(() => cleanupFailure.mintAgent(async () => { throw new Error("mint failed"); }), /mint failed/);
      assert.equal(cleanupFailureHost.reports.length, 1);
      assert.deepEqual(
        Object.fromEntries(Object.entries(cleanupFailureHost.reports[0]!).filter(([key]) => key !== "agentId")),
        { family: "materialize", kind: "mint_cleanup_failed", errorClass: "TypeError" },
      );
      assert.match(String(cleanupFailureHost.reports[0]?.agentId), /^[0-9a-f-]+$/);
    });
  });

  it("adopts the first fallback session that opens and reports earlier failures", async () => {
    await withRoot(async (root) => {
      mkdirSync(join(root, "agent-a"));
      mkdirSync(join(root, "agent-b"));
      const fixture = createHost(root);
      const materializer = new SlateSessionMaterialization(fixture.host);
      materializer.isAgentCapReached = async () => true;
      const attempts: string[] = [];
      const adopted = { id: "agent-b" } as never;
      const result = await materializer.createFallbackSession(async (agentId) => {
        attempts.push(agentId);
        if (agentId === "agent-a") throw new Error("cannot adopt");
        return adopted;
      });
      assert.equal(result, adopted);
      assert.deepEqual(attempts, ["agent-a", "agent-b"]);
      assert.deepEqual(fixture.reports, [{ family: "materialize", kind: "fallback_adopt_failed", agentId: "agent-a", errorClass: "Error" }]);
    });
  });

  it("reports the limit when no existing fallback session can be opened", async () => {
    await withRoot(async (root) => {
      mkdirSync(join(root, "agent-a"));
      const materializer = new SlateSessionMaterialization(createHost(root).host);
      materializer.isAgentCapReached = async () => true;
      await assert.rejects(() => materializer.createFallbackSession(async () => { throw new Error("not openable"); }), SlateAgentLimitError);
    });
  });
});
