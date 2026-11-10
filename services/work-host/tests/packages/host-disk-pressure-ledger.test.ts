import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME } from "../../source/host/durable-file-policy.ts";
import {
  createDiskPressureReminderEpisodes,
  SlateDiskPressureLedgerError,
  startDiskPressureWatch,
} from "../../source/host/boxes/forever-box/disk-pressure.ts";

function withRoot(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-disk-pressure-ledger-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function ledgerPath(rootDir: string): string {
  return join(rootDir, SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME);
}

function readLedger(rootDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(ledgerPath(rootDir), "utf8")) as Record<string, unknown>;
}

describe("pressure episodes", () => {
  it("keeps one episode through soft and hard pressure until complete recovery", () => {
    let id = 0;
    const episodes = createDiskPressureReminderEpisodes({ createEpisodeId: () => `episode-${++id}` });
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "before-pressure" }), null);

    episodes.observePressure("soft");
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "claim-a" }), "episode-1");
    episodes.observePressure("hard");
    assert.equal(episodes.claim({ agentId: "agent-b", claimId: "claim-b" }), "episode-1");
    assert.equal(id, 1);

    episodes.observePressure("healthy", true);
    assert.equal(episodes.claim({ agentId: "agent-c", claimId: "claim-c" }), null);
    episodes.observePressure("healthy", true);
    episodes.observePressure("soft");
    assert.equal(episodes.claim({ agentId: "agent-c", claimId: "claim-c" }), "episode-2");
    assert.equal(id, 2);
  });

  it("holds a claim until the matching delivery is released or committed", () => {
    const episodes = createDiskPressureReminderEpisodes({ createEpisodeId: () => "episode-1" });
    episodes.observePressure("soft");
    episodes.enroll(["agent-a", "agent-b"]);

    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "claim-1" }), "episode-1");
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "claim-1" }), "episode-1");
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "claim-2" }), null);
    assert.equal(episodes.commit({ agentId: "agent-a", claimId: "claim-2" }), false);
    episodes.release({ agentId: "agent-a", claimId: "claim-2" });
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "claim-1" }), "episode-1");

    episodes.release({ agentId: "agent-a", claimId: "claim-1" });
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "claim-3" }), "episode-1");
    assert.equal(episodes.commit({ agentId: "agent-a", claimId: "claim-3" }), true);
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "claim-4" }), null);
    assert.equal(episodes.claim({ agentId: "agent-b", claimId: "claim-b" }), "episode-1");
  });

  it("delivers an unclaimed older episode before the one that followed recovery", () => {
    let id = 0;
    const episodes = createDiskPressureReminderEpisodes({ createEpisodeId: () => `episode-${++id}` });
    episodes.observePressure("soft");
    episodes.enroll(["agent-a"]);
    episodes.observePressure("healthy");
    episodes.observePressure("hard");

    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "old" }), "episode-1");
    assert.equal(episodes.commit({ agentId: "agent-a", claimId: "old" }), true);
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "new" }), "episode-2");
    assert.equal(episodes.commit({ agentId: "agent-a", claimId: "new" }), true);
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "again" }), null);
  });

  it("does not mark a newer episode handled when an older claimed reminder commits", () => {
    let id = 0;
    const episodes = createDiskPressureReminderEpisodes({ createEpisodeId: () => `episode-${++id}` });
    episodes.observePressure("soft");
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "old" }), "episode-1");
    episodes.observePressure("healthy");
    episodes.observePressure("hard");

    assert.equal(episodes.commit({ agentId: "agent-a", claimId: "old" }), true);
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "new" }), "episode-2");
  });

  it("restores the pending queue and waits for a complete first healthy sample before recovery", () => {
    withRoot((rootDir) => {
      const first = createDiskPressureReminderEpisodes({ rootDir, createEpisodeId: () => "episode-1" });
      first.observePressure("hard");
      first.enroll(["agent-a", "agent-b"]);
      assert.equal(first.claim({ agentId: "agent-a", claimId: "claim-a" }), "episode-1");

      const restored = createDiskPressureReminderEpisodes({ rootDir, createEpisodeId: () => "episode-2" });
      restored.observePressure("healthy", false);
      assert.equal(restored.claim({ agentId: "agent-c", claimId: "claim-c" }), "episode-1");
      restored.observePressure("healthy", true);
      restored.observePressure("soft");
      assert.equal(restored.claim({ agentId: "agent-d", claimId: "claim-d" }), "episode-2");

      const saved = readLedger(rootDir);
      assert.deepEqual(saved.pending, [
        { agentId: "agent-a", episodeId: "episode-1" },
        { agentId: "agent-b", episodeId: "episode-1" },
        { agentId: "agent-c", episodeId: "episode-1" },
        { agentId: "agent-d", episodeId: "episode-2" },
      ]);
    });
  });

  it("restores handled agents without sending the same active episode again", () => {
    withRoot((rootDir) => {
      const first = createDiskPressureReminderEpisodes({ rootDir, createEpisodeId: () => "episode-1" });
      first.observePressure("soft");
      assert.equal(first.claim({ agentId: "agent-a", claimId: "claim-a" }), "episode-1");
      assert.equal(first.commit({ agentId: "agent-a", claimId: "claim-a" }), true);
      assert.deepEqual(readLedger(rootDir).handledAgentIds, ["agent-a"]);

      const restored = createDiskPressureReminderEpisodes({ rootDir, createEpisodeId: () => "unused" });
      assert.equal(restored.claim({ agentId: "agent-a", claimId: "again" }), null);
      assert.equal(restored.claim({ agentId: "agent-b", claimId: "new-agent" }), "episode-1");
    });
  });

  it("keeps the pending delivery when persistence fails, then commits it after storage recovers", () => {
    withRoot((rootDir) => {
      const blockedPartPath = `${ledgerPath(rootDir)}.part`;
      mkdirSync(blockedPartPath);
      const errors: unknown[] = [];
      const episodes = createDiskPressureReminderEpisodes({
        rootDir,
        createEpisodeId: () => "episode-1",
        onLedgerError: (error) => errors.push(error),
      });
      episodes.observePressure("soft");
      assert.equal(episodes.claim({ agentId: "agent-a", claimId: "claim-a" }), "episode-1");
      assert.equal(episodes.commit({ agentId: "agent-a", claimId: "claim-a" }), false);
      assert.equal(episodes.claim({ agentId: "agent-a", claimId: "claim-a" }), "episode-1");

      rmSync(blockedPartPath, { recursive: true, force: true });
      episodes.observePressure("soft");
      assert.equal(existsSync(ledgerPath(rootDir)), true);
      assert.equal(episodes.commit({ agentId: "agent-a", claimId: "claim-a" }), true);
      assert.deepEqual(readLedger(rootDir).handledAgentIds, ["agent-a"]);
      assert.equal(existsSync(blockedPartPath), false);
      assert.equal(errors.length >= 3, true);
    });
  });

  it("logs an invalid persisted version and starts a fresh ledger", () => {
    withRoot((rootDir) => {
      const errors: unknown[] = [];
      const episodes = createDiskPressureReminderEpisodes({
        rootDir,
        createEpisodeId: () => "episode-1",
        onLedgerError: (error) => errors.push(error),
      });
      assert.equal(errors.length, 0);
      writeFileSync(ledgerPath(rootDir), JSON.stringify({ version: 2, activeEpisodeId: "old" }));

      const recovered = createDiskPressureReminderEpisodes({
        rootDir,
        createEpisodeId: () => "episode-1",
        onLedgerError: (error) => errors.push(error),
      });
      assert.equal(errors.length, 1);
      assert.ok(errors[0] instanceof SlateDiskPressureLedgerError);
      assert.equal(recovered.claim({ agentId: "agent-a", claimId: "before" }), null);
      recovered.observePressure("hard");
      assert.deepEqual(readLedger(rootDir), {
        version: 1,
        activeEpisodeId: "episode-1",
        handledAgentIds: [],
        pending: [],
      });
    });
  });

  it("loads only valid pending ledger entries and deduplicates repeated delivery rows", () => {
    withRoot((rootDir) => {
      writeFileSync(ledgerPath(rootDir), JSON.stringify({
        version: 1,
        activeEpisodeId: null,
        handledAgentIds: ["agent-a"],
        pending: [
          { agentId: "agent-b", episodeId: "older-episode" },
          { agentId: "agent-b", episodeId: "older-episode" },
          { agentId: 5, episodeId: "wrong-agent-type" },
          { agentId: "agent-c", episodeId: 7 },
        ],
      }));
      const episodes = createDiskPressureReminderEpisodes({ rootDir, createEpisodeId: () => "unused" });

      assert.equal(episodes.claim({ agentId: "agent-a", claimId: "not-active" }), null);
      assert.equal(episodes.claim({ agentId: "agent-b", claimId: "valid" }), "older-episode");
      assert.equal(episodes.claim({ agentId: "agent-c", claimId: "bad-episode" }), null);
    });
  });

  it("forgets the handled mark so an agent can receive the current episode again", () => {
    const episodes = createDiskPressureReminderEpisodes({ createEpisodeId: () => "episode-1" });
    episodes.observePressure("soft");
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "leased" }), "episode-1");
    episodes.forgetAgent("agent-a");
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "fresh-lease" }), "episode-1");
    assert.equal(episodes.commit({ agentId: "agent-a", claimId: "fresh-lease" }), true);
    episodes.forgetAgent("agent-a");
    assert.equal(episodes.claim({ agentId: "agent-a", claimId: "after-forget" }), "episode-1");
  });

  it("restores the active episode and handled marks when clearing pressure cannot be persisted", () => {
    withRoot((rootDir) => {
      const episodes = createDiskPressureReminderEpisodes({ rootDir, createEpisodeId: () => "episode-1" });
      episodes.observePressure("soft");
      assert.equal(episodes.claim({ agentId: "agent-a", claimId: "first" }), "episode-1");
      assert.equal(episodes.commit({ agentId: "agent-a", claimId: "first" }), true);
      episodes.enroll(["agent-b"]);

      const blockedPartPath = `${ledgerPath(rootDir)}.part`;
      mkdirSync(blockedPartPath);
      episodes.observePressure("healthy");
      assert.equal(episodes.claim({ agentId: "agent-a", claimId: "again" }), null);
      assert.equal(episodes.claim({ agentId: "agent-b", claimId: "other" }), "episode-1");
      assert.equal(readLedger(rootDir).activeEpisodeId, "episode-1");
      rmSync(blockedPartPath, { recursive: true, force: true });
    });
  });

  it("keeps the active episode in memory when clearing it cannot be persisted", () => {
    withRoot((rootDir) => {
      const episodes = createDiskPressureReminderEpisodes({ rootDir, createEpisodeId: () => "episode-1" });
      episodes.observePressure("soft");
      rmSync(ledgerPath(rootDir));
      mkdirSync(ledgerPath(rootDir));

      episodes.observePressure("healthy");
      rmSync(ledgerPath(rootDir), { recursive: true, force: true });
      assert.equal(episodes.claim({ agentId: "agent-a", claimId: "after-write-error" }), "episode-1");
    });
  });

  it("removes the persisted ledger after recovery has no deliveries left", () => {
    withRoot((rootDir) => {
      const episodes = createDiskPressureReminderEpisodes({ rootDir, createEpisodeId: () => "episode-1" });
      episodes.observePressure("hard");
      assert.equal(existsSync(ledgerPath(rootDir)), true);
      episodes.observePressure("healthy");
      assert.equal(existsSync(ledgerPath(rootDir)), false);
    });
  });
});

describe("the disk-pressure watcher", () => {
  it("polls only in a box and disposes its polling handle once", () => {
    let starts = 0;
    let stops = 0;
    let tick: (() => Promise<void>) | undefined;
    const polling = {
      start(callback: () => Promise<void>) {
        starts += 1;
        tick = callback;
        return { dispose: () => { stops += 1; } };
      },
    };
    const deps = {
      polling,
      report: () => {},
      log: () => {},
    };
    const outside = startDiskPressureWatch({ ...deps, isInBox: false });
    assert.equal(starts, 0);
    assert.equal(outside.level, null);
    outside.dispose();

    const inside = startDiskPressureWatch({ ...deps, isInBox: true });
    assert.equal(starts, 1);
    assert.equal(typeof tick, "function");
    assert.equal(inside.level, null);
    inside.dispose();
    inside.dispose();
    assert.equal(stops, 1);
  });
});
