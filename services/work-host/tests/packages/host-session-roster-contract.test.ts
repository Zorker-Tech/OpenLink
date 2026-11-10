import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { listAgents, summarizeAgentById, type RosterHost } from "../../source/host/extensions/session/session-roster.ts";
import type { DbExtras } from "../../source/host/extensions/session/session-summaries.ts";

function rosterDirectory() {
  const path = mkdtempSync(join(tmpdir(), "slate-session-roster-"));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}

function extras(agentId: string, updatedAt: number): DbExtras {
  return {
    agentId,
    createdAt: updatedAt - 1,
    updatedAt,
    hasTranscript: true,
    lastEntry: null,
    lastMessage: null,
    newestEntryId: null,
    unreadState: { lastActivityAt: 0, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 0 },
    awaitingUserResponse: null,
    origin: "user",
    purpose: null,
    conversationPartnerIds: [],
    legacyAvatarPath: null,
  };
}

function rosterHost(rootDir: string, options: {
  isAgentBeingDeleted?: (id: string) => boolean;
  loadCachedExtras?: (id: string) => Promise<DbExtras | null>;
  recoverAgentWithMissingDb?: RosterHost["recoverAgentWithMissingDb"];
  pruneExtrasCache?: (ids: Set<string>) => void;
} = {}): RosterHost {
  return {
    rootDir,
    isAgentBeingDeleted: options.isAgentBeingDeleted ?? (() => false),
    memory: { agentHasContent: () => false },
    loadCachedExtras: async ({ dirName }) => await options.loadCachedExtras?.(dirName) ?? extras(dirName, 100),
    recoverAgentWithMissingDb: options.recoverAgentWithMissingDb ?? (async () => null),
    pruneExtrasCache: options.pruneExtrasCache ?? (() => {}),
  };
}

describe("session roster behavior", () => {
  it("treats a missing root as empty without pruning cache entries", async () => {
    const fixture = rosterDirectory();
    const missing = join(fixture.path, "not-created");
    let pruned = false;
    try {
      assert.deepEqual(await listAgents(rosterHost(missing, { pruneExtrasCache: () => { pruned = true; } })), []);
      assert.equal(pruned, false);
    } finally {
      fixture.dispose();
    }
  });

  it("skips deleting sessions, detects deletion during summary, sorts the rest and prunes stale extras", async () => {
    const fixture = rosterDirectory();
    const names = ["agent-1", "agent-2", "agent-3", "agent-4"];
    for (const name of names) {
      mkdirSync(join(fixture.path, name));
      writeFileSync(join(fixture.path, name, "store.db"), "store");
    }
    writeFileSync(join(fixture.path, "notes.txt"), "ignored");
    const deletionChecks = new Map<string, number>();
    let pruned: Set<string> | undefined;
    try {
      const host = rosterHost(fixture.path, {
        isAgentBeingDeleted: (id) => {
          if (id === "agent-2") return true;
          if (id !== "agent-3") return false;
          const checks = (deletionChecks.get(id) ?? 0) + 1;
          deletionChecks.set(id, checks);
          return checks > 1;
        },
        loadCachedExtras: async (id) => extras(id, id === "agent-4" ? 400 : 100),
        pruneExtrasCache: (ids) => { pruned = ids; },
      });
      const summaries = await listAgents(host, "agent-1");
      assert.deepEqual(summaries.map((summary) => summary.id), ["agent-4", "agent-1"]);
      assert.equal(summaries[1]?.isActive, true);
      assert.deepEqual([...pruned!].sort(), [...names, "notes.txt"].sort());
    } finally {
      fixture.dispose();
    }
  });

  it("recovers a missing database, falls back to a minimal active row on recovery errors, and respects deletion", async () => {
    const fixture = rosterDirectory();
    mkdirSync(join(fixture.path, "agent-recovered"));
    mkdirSync(join(fixture.path, "agent-fallback"));
    let recoveredActiveAgent: string | undefined;
    try {
      const host = rosterHost(fixture.path, {
        recoverAgentWithMissingDb: async ({ dirName, activeAgentId }) => {
          if (dirName === "agent-fallback") throw new Error("could not recover");
          recoveredActiveAgent = activeAgentId;
          return { id: dirName, name: "Recovered", updatedAt: 30 };
        },
      });
      const summaries = await listAgents(host, "agent-fallback");
      assert.deepEqual(summaries.map((summary) => summary.id), ["agent-recovered", "agent-fallback"]);
      assert.equal(recoveredActiveAgent, "agent-fallback");
      assert.equal(summaries.find((summary) => summary.id === "agent-fallback")?.isActive, true);
      assert.equal(existsSync(join(fixture.path, "agent-fallback", "store.db")), false);

      const deleting = rosterHost(fixture.path, { isAgentBeingDeleted: (id) => id === "agent-recovered" });
      assert.equal(await summarizeAgentById(deleting, "agent-recovered"), null);
    } finally {
      fixture.dispose();
    }
  });
});
