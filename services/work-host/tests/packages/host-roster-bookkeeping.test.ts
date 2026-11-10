import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHostRosterBookkeeping, type RosterApiLookup } from "../../source/host/host-roster-bookkeeping.ts";

/** A host's extensions, as the roster sees them, with each call written down. */
function hostWith(options: { readonly running?: string[][]; readonly stateBackstop?: boolean; readonly boxStore?: boolean } = {}) {
  const log: string[] = [];
  const readings = options.running ?? [[]];
  let read = 0;
  const extensions: RosterApiLookup = {
    api: ((id: string) => {
      switch (id) {
        case "attachments":
          return { setFallbackAgentId: (agentId: string | null) => log.push(`fallback ${String(agentId)}`) };
        case "transcript":
          return {
            liveRunningAgentIds: () => {
              const ids = readings[Math.min(read, readings.length - 1)] ?? [];
              read += 1;
              return ids;
            },
          };
        case "forever-box":
          return {
            diskPressureReminder: { enroll: (agentIds: ReadonlySet<string>) => log.push(`enroll ${[...agentIds].sort().join(",")}`) },
            setBusy: (busy: boolean) => log.push(`busy ${busy}`),
          };
        case "state-backstop":
          return { isEnabled: options.stateBackstop ?? false, scheduleSnapshot: (agentId: string) => log.push(`snapshot ${agentId}`) };
        case "box-store-sync":
          return { isEnabled: options.boxStore ?? false, scheduleStoreDbSnapshot: (agentId: string) => log.push(`store ${agentId}`) };
        case "source-map":
          return { getOrCreate: (agentId: string) => log.push(`source-map ${agentId}`) };
        default:
          throw new Error(`no such extension: ${id}`);
      }
    }) as RosterApiLookup["api"],
  };
  return { extensions, log };
}

describe("a roster that has not been told anything", () => {
  it("knows nobody, is not busy, and runs nothing", () => {
    const bookkeeping = createHostRosterBookkeeping(hostWith().extensions);
    assert.equal(bookkeeping.latestActiveAgentId, null);
    assert.equal(bookkeeping.isBusy, false);
    assert.deepEqual([...bookkeeping.runningAgentIds], []);
  });
});

describe("being told which agent is active", () => {
  it("keeps the agent, tells the attachments, and opens the agent's source map", () => {
    const { extensions, log } = hostWith();
    const bookkeeping = createHostRosterBookkeeping(extensions);
    bookkeeping.apply("a1");
    assert.equal(bookkeeping.latestActiveAgentId, "a1");
    assert.deepEqual(log, ["fallback a1", "busy false", "source-map a1"]);
  });

  it("treats nothing and an empty name as no agent at all", () => {
    for (const nothing of [null, undefined, ""]) {
      const { extensions, log } = hostWith();
      const bookkeeping = createHostRosterBookkeeping(extensions);
      bookkeeping.apply(nothing);
      assert.equal(bookkeeping.latestActiveAgentId, null, String(nothing));
      assert.deepEqual(log, ["fallback null", "busy false"], String(nothing));
    }
  });
});

describe("being told what is running", () => {
  it("counts the agents that are running, and says the host is busy", () => {
    const { extensions, log } = hostWith({ running: [["a1", "a2"]] });
    const bookkeeping = createHostRosterBookkeeping(extensions);
    bookkeeping.apply(null);
    assert.equal(bookkeeping.isBusy, true);
    assert.deepEqual([...bookkeeping.runningAgentIds].sort(), ["a1", "a2"]);
    assert.deepEqual(log, ["fallback null", "enroll a1,a2", "busy true"]);
  });

  it("tells the box's reminders only about the agents that just started", () => {
    const { extensions, log } = hostWith({ running: [["a1"], ["a1", "a2"]] });
    const bookkeeping = createHostRosterBookkeeping(extensions);
    bookkeeping.apply(null);
    log.length = 0;
    bookkeeping.apply(null);
    assert.deepEqual(log, ["fallback null", "enroll a2", "busy true"], "the agent that was already running is not enrolled again");
  });

  it("stays busy as long as one agent runs, and idle when none does", () => {
    const { extensions } = hostWith({ running: [["a1", "a2"], ["a2"], []] });
    const bookkeeping = createHostRosterBookkeeping(extensions);
    bookkeeping.apply(null);
    assert.equal(bookkeeping.isBusy, true);
    bookkeeping.apply(null);
    assert.equal(bookkeeping.isBusy, true);
    bookkeeping.apply(null);
    assert.equal(bookkeeping.isBusy, false);
  });

  it("hands out a copy, so reading the roster cannot change it", () => {
    const { extensions } = hostWith({ running: [["a1"]] });
    const bookkeeping = createHostRosterBookkeeping(extensions);
    bookkeeping.apply(null);
    (bookkeeping.runningAgentIds as Set<string>).add("ghost");
    assert.deepEqual([...bookkeeping.runningAgentIds], ["a1"]);
  });
});

describe("an agent that stops running", () => {
  it("is snapshotted by both backstops once either of them is on", () => {
    const { extensions, log } = hostWith({ running: [["a1"], []], boxStore: true });
    const bookkeeping = createHostRosterBookkeeping(extensions);
    bookkeeping.apply(null);
    log.length = 0;
    bookkeeping.apply(null);
    assert.deepEqual(log, ["fallback null", "busy false", "snapshot a1", "store a1"]);
  });

  it("is snapshotted by neither when both are off", () => {
    const { extensions, log } = hostWith({ running: [["a1"], []] });
    const bookkeeping = createHostRosterBookkeeping(extensions);
    bookkeeping.apply(null);
    log.length = 0;
    bookkeeping.apply(null);
    assert.deepEqual(log, ["fallback null", "busy false"]);
  });

  it("is not snapshotted while it keeps running", () => {
    const { extensions, log } = hostWith({ running: [["a1"], ["a1"]], stateBackstop: true });
    const bookkeeping = createHostRosterBookkeeping(extensions);
    bookkeeping.apply(null);
    log.length = 0;
    bookkeeping.apply(null);
    assert.deepEqual(log.filter((line) => line.startsWith("snapshot") || line.startsWith("store")), []);
  });

  it("snapshots both agents when both stop at once", () => {
    const { extensions, log } = hostWith({ running: [["a1", "a2"], []], stateBackstop: true });
    const bookkeeping = createHostRosterBookkeeping(extensions);
    bookkeeping.apply(null);
    log.length = 0;
    bookkeeping.apply(null);
    assert.deepEqual(log.filter((line) => line.startsWith("snapshot")), ["snapshot a1", "snapshot a2"]);
  });
});
