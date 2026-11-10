/**
 * Telling the platform what a conversation looks like now: the roster it keeps, the deltas it sends, and the stamps that
 * let a reader put them back in order.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { RosterEmit } from "../../source/host/transcript/roster-emit.ts";

/** A transcript manager as the roster emitter uses one, with every call written down. */
function harness(options: { disposed?: boolean; noSession?: boolean; summarySessionFails?: boolean; summaryByIdNull?: boolean; runningStates?: boolean; announced?: string } = {}) {
  const calls: unknown[][] = [];
  const activeSession = { id: "agent-1" };
  const manager = {
    disposed: options.disposed ?? false,
    taskBoundary: { settled: async () => { calls.push(["boundary"]); } },
    sessions: {
      activeSession,
      liveSessions: new Map<string, { id: string }>([[activeSession.id, activeSession]]),
      tryEnsureSession: async () => (options.noSession === true ? null : activeSession),
      getAnnouncedActiveAgentId: () => (options.announced === undefined ? activeSession.id : options.announced),
    },
    sessionStore: {
      listAgents: async (announcedId: unknown) => { calls.push(["list-agents", announcedId]); return [{ id: "agent-1", name: "One" }, { id: "agent-2", name: "Two" }]; },
      summarizeSession: async (session: { id: string }, announcedId: unknown) => { calls.push(["summarize-session", session.id, announcedId]); if (options.summarySessionFails === true) throw new Error("no summary"); return { id: session.id, name: "One" }; },
      summarizeAgentById: async (agentId: string, announcedId: unknown) => { calls.push(["summarize-by-id", agentId, announcedId]); return options.summaryByIdNull === true ? null : { id: agentId, name: "ByName" }; },
    },
    runLifecycle: { withRunStates: <T>(list: readonly T[]): T[] => { calls.push(["with-run-states", list.length]); return options.runningStates === true ? list.map((agent) => ({ ...agent, isRunning: true })) : [...list]; } },
  };
  return { manager, calls, kinds: (of: string) => calls.filter((call) => call[0] === of) };
}

const emitterWith = () => {
  const emitter = new EventEmitter();
  const events: Array<[string, Record<string, unknown>]> = [];
  emitter.on("agents", (payload: Record<string, unknown>) => { events.push(["agents", payload]); });
  emitter.on("agent-upserted", (payload: Record<string, unknown>) => { events.push(["agent-upserted", payload]); });
  return { emitter, events };
};

describe("the roster the platform is told about", () => {
  it("stamps what it sends, so a reader can put the news back in order", () => {
    const { manager } = harness();
    const { emitter } = emitterWith();
    const roster = new RosterEmit(manager as never, emitter);
    assert.equal(typeof roster.snapshotEpoch, "string");
    assert.equal(roster.snapshotEpoch.length > 0, true);
    assert.equal(roster.rosterCacheSeeded, false);
    // Every reservation moves the sequence on, under the same epoch.
    const first = roster.reserveSnapshotStamp();
    const second = roster.reserveSnapshotStamp();
    assert.deepEqual({ epoch: second.snapshotEpoch === first.snapshotEpoch, from: first.snapshotSeq, to: second.snapshotSeq }, { epoch: true, from: 1, to: 2 });
    // A stamp is applied to a list without changing what the list held.
    const stamped = roster.applySnapshotStamp([{ id: "agent-1" }], { snapshotEpoch: "epoch-1", snapshotSeq: 7 });
    assert.deepEqual(stamped, [{ id: "agent-1", snapshotEpoch: "epoch-1", snapshotSeq: 7 }]);
  });

  it("sends the whole roster with what the conversation is showing and what order it is in", async () => {
    const { manager, kinds } = harness({ runningStates: true, announced: "agent-2" });
    const { emitter, events } = emitterWith();
    const roster = new RosterEmit(manager as never, emitter);
    await roster.emitAgents();
    // The platform is asked for the roster with the agent the window is showing, and each summary is stamped.
    assert.deepEqual(kinds("list-agents").map((call) => call[1]), ["agent-2"]);
    assert.deepEqual(kinds("boundary").length, 1);
    const payload = events[0]?.[1] as { activeAgentId: string; agents: Array<Record<string, unknown>>; ordered: { replicaKey: string; epoch: string; sequence: number }; coverage: { kind: string } };
    assert.equal(events[0]?.[0], "agents");
    assert.equal(payload.activeAgentId, "agent-2");
    assert.deepEqual(payload.agents.map((agent) => agent.id), ["agent-1", "agent-2"]);
    assert.equal(payload.agents.every((agent) => agent.snapshotEpoch === roster.snapshotEpoch && typeof agent.snapshotSeq === "number"), true);
    // The run states the display needs are part of what is sent.
    assert.equal(payload.agents.every((agent) => agent.isRunning === true), true);
    assert.deepEqual({ key: payload.ordered.replicaKey, epoch: payload.ordered.epoch === roster.snapshotEpoch, sequence: payload.ordered.sequence }, { key: "roster", epoch: true, sequence: 1 });
    assert.deepEqual(payload.coverage, { kind: "complete-roster" });
    // What was sent is remembered, so a later update can be a delta.
    assert.equal(roster.rosterCacheSeeded, true);
    assert.equal(roster.cachedAgentSummaries.length, 2);
  });

  it("sends one agent's news as a delta, and falls back to the whole roster when it cannot", async () => {
    const { manager, kinds } = harness();
    const { emitter, events } = emitterWith();
    const roster = new RosterEmit(manager as never, emitter);
    await roster.emitAgents();
    events.length = 0;
    kinds("boundary").length = 0;
    assert.equal(await roster.runEmitAgentUpdate("agent-2"), "delta");
    assert.deepEqual(events.map((event) => event[0]), ["agent-upserted"]);
    const payload = events[0]?.[1] as { activeAgentId: string; agent: Record<string, unknown>; ordered: { sequence: number } };
    assert.deepEqual({ id: payload.agent.id, active: payload.activeAgentId, running: typeof payload.agent.isRunning }, { id: "agent-2", active: "agent-1", running: "undefined" });
    assert.equal(payload.ordered.sequence, 2);
    // The agent that is live is described through its session; one that is not is described by id.
    assert.deepEqual(kinds("summarize-session").length, 0);
    assert.deepEqual(kinds("summarize-by-id").map((call) => call[1]), ["agent-2"]);

    // Nothing to say about the agent, no session to announce, and a delta that threw all fall back to the whole roster.
    const nothing = harness({ summaryByIdNull: true });
    const nothingRoster = new RosterEmit(nothing.manager as never, emitterWith().emitter);
    assert.equal(await nothingRoster.runEmitAgentUpdate("agent-2"), "full");
    const bare = harness({ noSession: true });
    const bareRoster = new RosterEmit(bare.manager as never, emitterWith().emitter);
    assert.equal(await bareRoster.runEmitAgentUpdate("agent-2"), "full");
    const throwing = harness();
    throwing.manager.sessionStore.listAgents = async () => { throw new Error("the store is gone"); };
    const throwingRoster = new RosterEmit(throwing.manager as never, emitterWith().emitter);
    await throwingRoster.emitAgents();
    throwing.manager.sessionStore.summarizeAgentById = async () => { throw new Error("still gone"); };
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      assert.equal(await throwingRoster.runEmitAgentUpdate("agent-1"), "failed");
    } finally {
      console.error = originalError;
    }
    assert.equal(errors.some((line) => line.includes("incremental emit failed for agent-1")), true);
  });

  it("does not send anything once the host is gone", async () => {
    const { manager } = harness({ disposed: true });
    const { emitter, events } = emitterWith();
    const roster = new RosterEmit(manager as never, emitter);
    await roster.emitAgents();
    assert.deepEqual(events, []);
    assert.equal(await roster.runEmitAgentUpdate("agent-1"), "failed");
    assert.equal(roster.rosterCacheSeeded, false);
  });

  it("coalesces what was asked for while a send was already on its way", async () => {
    const { manager, kinds } = harness();
    const { emitter, events } = emitterWith();
    const roster = new RosterEmit(manager as never, emitter);
    // Three asks at once become one send, and the whole roster is what goes out.
    await Promise.all([roster.emitAgentUpdate("agent-1"), roster.emitAgents(), roster.emitAgentUpdate("agent-2")]);
    assert.deepEqual(kinds("boundary").length, 1);
    assert.deepEqual(kinds("list-agents").length, 1);
    assert.deepEqual(events.map((event) => event[0]), ["agents"]);
    // A later ask sends again.
    events.length = 0;
    await roster.emitAgentUpdate("agent-2");
    assert.deepEqual(events.map((event) => event[0]), ["agent-upserted"]);
    // Work asked for through the chain runs in the order it was asked for, and a failure does not stop the next.
    const order: string[] = [];
    await Promise.all([
      roster.enqueueEmit(async () => { order.push("first"); }),
      roster.enqueueEmit(async () => { order.push("second"); throw new Error("this one fails"); }).catch(() => undefined),
      roster.enqueueEmit(async () => { order.push("third"); }),
    ]);
    assert.deepEqual(order, ["first", "second", "third"]);
  });

  it("describes an agent through its own session when it is live, and by id when it is not", async () => {
    const { manager, kinds } = harness();
    const { emitter } = emitterWith();
    const roster = new RosterEmit(manager as never, emitter);
    // The agent the window is showing is described through the session in memory.
    assert.deepEqual(await roster.buildAgentSummary("agent-1"), { id: "agent-1", name: "One" });
    assert.deepEqual(kinds("summarize-session").map((call) => [call[1], call[2]]), [["agent-1", "agent-1"]]);
    // A session that cannot describe itself is asked about by id instead.
    const fallback = harness({ summarySessionFails: true });
    const fallbackRoster = new RosterEmit(fallback.manager as never, emitter);
    assert.deepEqual(await fallbackRoster.buildAgentSummary("agent-1"), { id: "agent-1", name: "ByName" });
    assert.deepEqual(fallback.kinds("summarize-by-id").map((call) => call[1]), ["agent-1"]);
    // An agent the platform knows nothing about has nothing to send.
    const nothing = harness({ summarySessionFails: true, summaryByIdNull: true });
    assert.equal(await new RosterEmit(nothing.manager as never, emitter).buildAgentSummary("agent-9"), null);
  });

  it("puts what it sends to a caller under the same stamp as the roster", async () => {
    const { manager } = harness({ runningStates: true });
    const { emitter } = emitterWith();
    const roster = new RosterEmit(manager as never, emitter);
    const stamp = roster.reserveSnapshotStamp();
    // What a caller gets back carries the run states the display needs and the stamp the reader orders by.
    assert.deepEqual(roster.finalizeSummaryForRpc({ id: "agent-1" }, stamp), { id: "agent-1", isRunning: true, snapshotEpoch: stamp.snapshotEpoch, snapshotSeq: stamp.snapshotSeq });
  });
});

// ---------------------------------------------------------------------------------------------
// the edges of a roster send
// ---------------------------------------------------------------------------------------------

it("a queued task that fails is reported to its caller and does not stop the queue", async () => {
  const { manager } = harness();
  const { emitter } = emitterWith();
  const roster = new RosterEmit(manager as never, emitter);
  const order: string[] = [];
  await assert.rejects(
    () => roster.enqueueEmit(async () => { order.push("failed"); throw new Error("this one fails"); }),
    /this one fails/,
  );
  await roster.enqueueEmit(async () => { order.push("after"); });
  assert.deepEqual(order, ["failed", "after"]);
});

it("a delta that cannot see a session, a summary or an unchanged sibling sends the whole roster", async () => {
  const noSession = harness({ noSession: true });
  const noSessionEmitter = emitterWith();
  const noSessionRoster = new RosterEmit(noSession.manager as never, noSessionEmitter.emitter);
  await noSessionRoster.emitAgents();
  const noSessionEvents = noSessionEmitter.events.length;
  assert.equal(await noSessionRoster.runEmitAgentUpdate("agent-1"), "full");
  assert.equal(noSessionEmitter.events.length > noSessionEvents, true);
  assert.equal(noSessionEmitter.events.at(-1)?.[0], "agents");

  const noSummary = harness({ summaryByIdNull: true });
  const noSummaryEmitter = emitterWith();
  const noSummaryRoster = new RosterEmit(noSummary.manager as never, noSummaryEmitter.emitter);
  await noSummaryRoster.emitAgents();
  assert.equal(await noSummaryRoster.runEmitAgentUpdate("agent-9"), "full");

  const siblings = harness({ runningStates: true });
  const siblingsEmitter = emitterWith();
  const siblingsRoster = new RosterEmit(siblings.manager as never, siblingsEmitter.emitter);
  await siblingsRoster.emitAgents();
  // The decorated roster gives every sibling a different object, so one agent's delta cannot stand.
  assert.equal(await siblingsRoster.runEmitAgentUpdate("agent-2"), "full");
});

it("a delta keeps the agent it sent in the cache", async () => {
  const { manager } = harness();
  const { emitter, events } = emitterWith();
  const roster = new RosterEmit(manager as never, emitter);
  await roster.emitAgents();
  assert.equal(await roster.runEmitAgentUpdate("agent-2"), "delta");
  const payload = events.at(-1)?.[1] as { agent: { id: string; name: string } };
  assert.equal(payload.agent.id, "agent-2");
  assert.equal(payload.agent.name, "ByName");
  assert.deepEqual(roster.cachedAgentSummaries.find((agent: { id: string }) => agent.id === "agent-2")?.name, "ByName");
});

it("a full roster reached while coalescing stops the remaining deltas", async () => {
  const { manager } = harness();
  const { emitter, events } = emitterWith();
  const roster = new RosterEmit(manager as never, emitter);
  await Promise.all([roster.emitAgentUpdate("agent-1"), roster.emitAgentUpdate("agent-2")]);
  assert.equal(events.length, 1);
});

