/**
 * A conversation's run: the scheduler it goes through, the watchdog that bounds a run nobody finishes, what is counted
 * and reported about a turn, and what the user is shown while it runs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { envPositiveInt, isRunSchedulerDisabled, RUN_WATCHDOG_DEFAULT_MS, RUN_WATCHDOG_GRACE_DEFAULT_MS, RunLifecycle } from "../../source/host/transcript/run-lifecycle.ts";
import { SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME } from "../../source/host/slate-activity.ts";

/** A transcript manager as the run lifecycle uses one, with every call it makes written down. */
function transcriptManager(options: { obligations?: Array<{ agentId: string; createdAtMs: number; coalescedCount: number }>; epoch?: number; subagentParents?: string[]; remoteMembers?: Array<[string, string]> } = {}) {
  const calls: unknown[][] = [];
  const manager = {
    runnerRegistry: {
      runners: new Map<string, { expireAutoReviewApprovals(): void }>([["agent-1", { expireAutoReviewApprovals: () => { calls.push(["expireApprovals"]); } }]]),
      interruptWedgedRunForWatchdog: (agentId: string) => { calls.push(["interrupt", agentId]); return true; },
    },
    telemetry: {
      reportQueueAccepted: (report: Record<string, unknown>) => { calls.push(["accepted", report]); },
      reportQueueDequeued: (report: Record<string, unknown>) => { calls.push(["dequeued", report]); },
      reportQueueWatchdog: (report: Record<string, unknown>) => { calls.push(["watchdog", report]); },
      reportTurnUsage: (report: Record<string, unknown>) => { calls.push(["turnUsage", report]); },
    },
    ackObligations: {
      retireAckRunToken: (agentId: string, token: string) => { calls.push(["retireAck", agentId, token]); },
      scheduleAckRedriveAfterIdle: (sessionId: string) => { calls.push(["redrive", sessionId]); },
    },
    ackObligationStore: { list: () => options.obligations ?? [] },
    sendPipeline: { sendAttachmentBatchIds: new Set<string>(["agent-1"]), currentTurnEpoch: () => options.epoch ?? 1 },
    turnRuntime: { activeRequestPrompts: new Map<string, string>(), activeRequestSources: new Map<string, string>([["agent-1", "user"]]), activeTurnEpochs: new Map<string, number>() },
    roster: {
      emitAgentUpdate: async (sessionId: string) => { calls.push(["roster", sessionId]); },
      liveSubagentParentIds: () => new Set(options.subagentParents ?? []),
      watchSessionProfile: (session: { id: string }) => { calls.push(["watchProfile", session.id]); },
    },
    sessions: {
      liveSessions: new Map<string, unknown>(),
      pendingSessionOpens: new Map<string, { session: unknown }>(),
      activeSession: null as unknown,
      settledOpen: async (pending: { session: unknown }) => pending.session,
    },
    productAnalytics: { trackEvent: (name: string, payload: unknown) => { calls.push(["analytics", name, payload]); } },
    groupChat: { isGroupSession: (session: { id: string }) => session.id === "group-1", remoteTurnMemberIdsByRoom: new Map<string, string>(options.remoteMembers ?? []) },
    memory: { setActiveAgent: (value: unknown) => { calls.push(["setActiveAgent", value]); } },
    automationRuntime: { watchSessionAutomations: (session: { id: string }) => { calls.push(["watchAutomations", session.id]); } },
    workflowCommands: { watchSessionWorkflows: (session: { id: string }) => { calls.push(["watchWorkflows", session.id]); } },
  };
  return { manager, calls };
}

function liveSession(id = "agent-1") {
  const calls: unknown[][] = [];
  return {
    session: {
      id,
      dbPath: `/tmp/slate-transcript/${id}/db`,
      db: { recordRequestId: (...args: unknown[]) => { calls.push(["recordRequestId", ...args]); }, close: () => { calls.push(["close", id]); } },
      memory: { id: `memory-${id}` },
      agentStore: { dispose: () => { calls.push(["dispose", id]); } },
    },
    calls,
  };
}

const until = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe("a conversation's run", () => {
  it("takes its watchdog bounds and its on/off from the environment", () => {
    assert.equal(RUN_WATCHDOG_DEFAULT_MS, 120_000);
    assert.equal(RUN_WATCHDOG_GRACE_DEFAULT_MS, 30_000);
    const remembered = { SLATE_DISABLE_RUN_SCHEDULER: process.env.SLATE_DISABLE_RUN_SCHEDULER, SLATE_POSITIVE_INT: process.env.SLATE_POSITIVE_INT };
    try {
      process.env.SLATE_DISABLE_RUN_SCHEDULER = "1";
      assert.equal(isRunSchedulerDisabled(), true);
      process.env.SLATE_DISABLE_RUN_SCHEDULER = "0";
      assert.equal(isRunSchedulerDisabled(), false);
      delete process.env.SLATE_DISABLE_RUN_SCHEDULER;
      assert.equal(isRunSchedulerDisabled(), false);
      assert.equal(envPositiveInt("SLATE_POSITIVE_INT", 7), 7);
      process.env.SLATE_POSITIVE_INT = "42";
      assert.equal(envPositiveInt("SLATE_POSITIVE_INT", 7), 42);
      // A value that is not a positive count of milliseconds is not a bound.
      process.env.SLATE_POSITIVE_INT = "0";
      assert.equal(envPositiveInt("SLATE_POSITIVE_INT", 7), 7);
      process.env.SLATE_POSITIVE_INT = "abc";
      assert.equal(envPositiveInt("SLATE_POSITIVE_INT", 7), 7);
      process.env.SLATE_POSITIVE_INT = "   ";
      assert.equal(envPositiveInt("SLATE_POSITIVE_INT", 7), 7);
      process.env.SLATE_POSITIVE_INT = "-5";
      assert.equal(envPositiveInt("SLATE_POSITIVE_INT", 7), 7);
    } finally {
      for (const [key, value] of Object.entries(remembered)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("runs one run per agent at a time, and bounds a run nobody finishes", async () => {
    const remembered = { watchdog: process.env.SLATE_RUN_WATCHDOG_MS, grace: process.env.SLATE_RUN_WATCHDOG_GRACE_MS, disabled: process.env.SLATE_DISABLE_RUN_SCHEDULER };
    process.env.SLATE_RUN_WATCHDOG_MS = "60";
    process.env.SLATE_RUN_WATCHDOG_GRACE_MS = "30";
    delete process.env.SLATE_DISABLE_RUN_SCHEDULER;
    const { manager, calls } = transcriptManager();
    try {
      const lifecycle = new RunLifecycle(manager as never);
      assert.equal(lifecycle.runScheduler !== null, true);
      // A run that never finishes is tripped by the watchdog and then escaped, so the run waiting behind it goes.
      let wedgedRan = false;
      const wedged = lifecycle.enqueueExclusiveRun("agent-1", async () => { wedgedRan = true; await new Promise(() => {}); }, { lane: "user", source: "user", ackToken: "ack-1" });
      await until(10);
      let behindRan = false;
      const behind = lifecycle.enqueueExclusiveRun("agent-1", async () => { behindRan = true; }, { lane: "user", source: "user" });
      await until(220);
      assert.equal(wedgedRan, true);
      assert.equal(behindRan, true);
      const accepted = calls.filter((call) => call[0] === "accepted").map((call) => call[1] as Record<string, unknown>);
      assert.deepEqual(accepted.map((report) => ({ lane: report.lane, source: report.source, position: report.position, depthUser: report.depthUser, hasActive: report.hasActive })), [
        { lane: "user", source: "user", position: 0, depthUser: 1, hasActive: false },
        { lane: "user", source: "user", position: 1, depthUser: 1, hasActive: true },
      ]);
      assert.equal(calls.filter((call) => call[0] === "dequeued").length, 2);
      const watchdog = calls.filter((call) => call[0] === "watchdog").map((call) => call[1] as Record<string, unknown>);
      assert.deepEqual(watchdog.map((report) => report.stage), ["trip", "escape"]);
      assert.equal(watchdog.every((report) => report.activeLane === "user" && typeof report.activeRuntimeMs === "number"), true);
      // The wedged run is interrupted, and the acknowledgement it owed is not left outstanding.
      assert.deepEqual(calls.filter((call) => call[0] === "interrupt"), [["interrupt", "agent-1"]]);
      assert.deepEqual(calls.filter((call) => call[0] === "retireAck"), [["retireAck", "agent-1", "ack-1"]]);
      await wedged.catch(() => undefined);
      await behind;
    } finally {
      for (const [key, value] of Object.entries({ SLATE_RUN_WATCHDOG_MS: remembered.watchdog, SLATE_RUN_WATCHDOG_GRACE_MS: remembered.grace, SLATE_DISABLE_RUN_SCHEDULER: remembered.disabled })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("chains the runs itself where the scheduler is turned off", async () => {
    const remembered = process.env.SLATE_DISABLE_RUN_SCHEDULER;
    process.env.SLATE_DISABLE_RUN_SCHEDULER = "1";
    const { manager, calls } = transcriptManager();
    try {
      const lifecycle = new RunLifecycle(manager as never);
      assert.equal(lifecycle.runScheduler, null);
      assert.equal(isRunSchedulerDisabled(), true);
      const order: string[] = [];
      const first = lifecycle.enqueueExclusiveRun("agent-5", async () => { order.push("first:start"); await until(20); order.push("first:end"); }, { lane: "user", source: "user" });
      const second = lifecycle.enqueueExclusiveRun("agent-5", async () => { order.push("second"); }, { lane: "user", source: "user" });
      await Promise.all([first, second]);
      // The second run waits for the first rather than running beside it.
      assert.deepEqual(order, ["first:start", "first:end", "second"]);
      await lifecycle.drainExclusiveRuns("agent-5");
      // With no scheduler there is no queue to report on.
      assert.deepEqual(lifecycle.getRunQueueDiagnostics(), []);
      assert.deepEqual(calls.filter((call) => String(call[0]).startsWith("reportQueue")), []);
    } finally {
      if (remembered === undefined) delete process.env.SLATE_DISABLE_RUN_SCHEDULER; else process.env.SLATE_DISABLE_RUN_SCHEDULER = remembered;
    }
  });

  it("reports what the queue holds, including what is still owed an acknowledgement", () => {
    const now = Date.now();
    const { manager } = transcriptManager({ obligations: [{ agentId: "agent-1", createdAtMs: now - 5_000, coalescedCount: 3 }, { agentId: "agent-9", createdAtMs: now - 1_000, coalescedCount: 1 }] });
    const lifecycle = new RunLifecycle(manager as never);
    const diagnostics = lifecycle.getRunQueueDiagnostics() as Array<Record<string, unknown>>;
    assert.deepEqual(diagnostics.map((entry) => ({ agentId: entry.agentId, ackOutstanding: entry.ackOutstanding, ackCoalescedCount: entry.ackCoalescedCount })), [
      { agentId: "agent-1", ackOutstanding: true, ackCoalescedCount: 3 },
      { agentId: "agent-9", ackOutstanding: true, ackCoalescedCount: 1 },
    ]);
    // An acknowledgement that is owed for a conversation with nothing queued is reported as a queue of its own.
    const waited = diagnostics[0]?.ackAgeMs as number;
    assert.equal(waited >= 5_000, true);
    assert.equal(diagnostics[1]?.depthTotal, 0);
  });

  it("counts a run in and out, and puts the session away once nothing is running", async () => {
    const { manager, calls } = transcriptManager();
    const lifecycle = new RunLifecycle(manager as never);
    const { session, calls: sessionCalls } = liveSession();
    lifecycle.beginSessionRun(session);
    assert.deepEqual({ inFlight: lifecycle.inFlightRunCounts.get(session), started: lifecycle.runWindowStartedAt.has(session), turnWorthy: lifecycle.turnWorthyBeginCounts.get(session), live: manager.sessions.liveSessions.get(session.id) === session, active: lifecycle.activeRunSession === session }, { inFlight: 1, started: true, turnWorthy: 1, live: true, active: true });
    // A turn a guest asked for is a run, but not a turn of the user's own.
    lifecycle.beginSessionRun(session, { isGroupMemberTurn: true });
    assert.deepEqual({ inFlight: lifecycle.inFlightRunCounts.get(session), turnWorthy: lifecycle.turnWorthyBeginCounts.get(session) }, { inFlight: 2, turnWorthy: 1 });
    calls.length = 0;
    lifecycle.endSessionRun(session);
    await until(10);
    // Still one run in flight: the session is kept, and nothing is said about a turn that is not over.
    assert.equal(lifecycle.inFlightRunCounts.get(session), 1);
    assert.deepEqual(calls, []);
    calls.length = 0;
    lifecycle.endSessionRun(session);
    await until(10);
    assert.equal(lifecycle.inFlightRunCounts.has(session), false);
    assert.equal(lifecycle.activeRunSession, null);
    assert.equal(sessionCalls.some(([kind]) => kind === "close"), true);
    assert.equal(sessionCalls.some(([kind]) => kind === "dispose"), true);
    assert.equal(calls.some((call) => call[0] === "expireApprovals"), true);
    assert.deepEqual(calls.filter((call) => call[0] === "redrive"), [["redrive", "agent-1"]]);
    // What the turn cost is reported once, named as ours, with how long it took.
    const turn = (calls.find((call) => call[0] === "analytics") ?? []) as unknown[];
    assert.ok(turn.length > 0);
    assert.equal(turn[1], "slate.turn.completed");
    const payload = turn[2] as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["agent_id", "duration_ms", "is_group", "source"]);
    assert.deepEqual({ agent_id: payload.agent_id, source: payload.source, is_group: payload.is_group, duration: typeof payload.duration_ms }, { agent_id: "agent-1", source: "user", is_group: false, duration: "number" });
    assert.equal(lifecycle.runningAgentIds().size, 0);
  });

  it("says nothing about a turn that never counted as one", () => {
    const { manager, calls } = transcriptManager();
    const lifecycle = new RunLifecycle(manager as never);
    const { session } = liveSession("agent-7");
    // A run that was only a guest's turn is not a turn of the user's, so nothing is reported about it.
    lifecycle.beginSessionRun(session, { isGroupMemberTurn: true });
    lifecycle.recordTurnCompleted(session);
    assert.deepEqual(calls.filter((call) => call[0] === "analytics"), []);
    assert.equal(lifecycle.turnWorthyBeginCounts.has(session), false);
    assert.equal(lifecycle.runWindowStartedAt.has(session), false);
  });

  it("records a request id, tracks the turn's ids, and reports what the turn used", async () => {
    const { manager, calls } = transcriptManager();
    const lifecycle = new RunLifecycle(manager as never);
    const { session, calls: sessionCalls } = liveSession();
    await lifecycle.recordRequestId("request-1", session, "source-x");
    assert.deepEqual(sessionCalls.at(-1)?.slice(0, 2), ["recordRequestId", "request-1"]);
    // The prompt the turn started from is recorded too, and is absent when the session never had one.
    assert.deepEqual(sessionCalls.at(-1)?.slice(3), [undefined, "source-x"]);
    assert.deepEqual(calls.at(-1), ["roster", "agent-1"]);
    // A session that is not there, and one whose store refuses the write, are both passed over.
    await lifecycle.recordRequestId("request-1", null);
    await lifecycle.recordRequestId("request-1", { id: "agent-3", db: { recordRequestId: () => { throw new Error("no store"); } } });
    lifecycle.trackTurnRequestId("agent-1", "  request-2  ");
    lifecycle.trackTurnRequestId("agent-1", "   ");
    lifecycle.trackTurnRequestId("agent-1", "request-3");
    assert.deepEqual([...(lifecycle.turnRequestIdsBySession.get("agent-1") ?? [])], ["request-2", "request-3"]);
    lifecycle.reportTurnUsage(session, { inputTokens: 10 });
    assert.deepEqual(calls.find((call) => call[0] === "turnUsage")?.[1], { conversationId: "agent-1", source: "user", usage: { inputTokens: 10 }, requestId: "request-2", requestIdCount: 2, turnEndedSeq: 1 });
    // Reporting a turn's usage ends that turn: the ids behind it are gone and the next one counts from there.
    assert.equal(lifecycle.turnRequestIdsBySession.has("agent-1"), false);
    lifecycle.reportTurnUsage(session, { inputTokens: 1 });
    assert.equal((calls.at(-1)?.[1] as Record<string, unknown>).requestId, undefined);
    assert.equal((calls.at(-1)?.[1] as Record<string, unknown>).requestIdCount, 0);
    assert.equal((calls.at(-1)?.[1] as Record<string, unknown>).turnEndedSeq, 2);
  });

  it("keeps a session that is still the host's to keep", async () => {
    const { manager, calls } = transcriptManager();
    const lifecycle = new RunLifecycle(manager as never);
    const { session, calls: sessionCalls } = liveSession("agent-1");
    manager.sessions.liveSessions.set(session.id, session);
    // The session the user is looking at is not put away, however idle it is.
    manager.sessions.activeSession = session;
    await lifecycle.retireSession(session);
    assert.deepEqual(sessionCalls, []);
    // Nor is one that still has a run in flight.
    manager.sessions.activeSession = null;
    lifecycle.beginSessionRun(session);
    await lifecycle.retireSession(session);
    assert.deepEqual(sessionCalls, []);
    // Once neither is true, the session is disposed of and its store closed.
    lifecycle.endSessionRun(session);
    await until(10);
    sessionCalls.length = 0;
    manager.sessions.liveSessions.set(session.id, session);
    await lifecycle.retireSession(session);
    assert.deepEqual(sessionCalls.map((call) => call[0]), ["dispose", "close"]);
    assert.equal(manager.sessions.liveSessions.has(session.id), false);
    assert.equal(calls.some((call) => call[0] === "expireApprovals"), true);
    // A session that is not there is nothing to put away.
    await lifecycle.retireSession(null);
    assert.equal(await lifecycle.retireSession(undefined), undefined);
  });

  it("closes a session that is idle, and watches the one that is active", () => {
    const { manager, calls } = transcriptManager();
    const lifecycle = new RunLifecycle(manager as never);
    const { session, calls: sessionCalls } = liveSession("agent-1");
    lifecycle.closeSessionWhenIdle(session);
    assert.deepEqual(sessionCalls.map((call) => call[0]), ["close"]);
    lifecycle.beginSessionRun(session);
    lifecycle.closeSessionWhenIdle(session);
    assert.deepEqual(sessionCalls.map((call) => call[0]), ["close"]);
    lifecycle.watchActiveSession(session);
    assert.deepEqual(calls.filter((call) => call[0] !== "roster").map((call) => call[0]), ["setActiveAgent", "watchAutomations", "watchWorkflows", "watchProfile"]);
    assert.deepEqual(calls.find((call) => call[0] === "setActiveAgent")?.[1], { agentId: "agent-1", store: session.memory });
  });

  it("says which agents are running, and stands in front of what it is shown", () => {
    const { manager } = transcriptManager({ subagentParents: ["agent-4"], remoteMembers: [["agent-1", "member-2"]] });
    const lifecycle = new RunLifecycle(manager as never);
    const { session } = liveSession("agent-1");
    assert.deepEqual([...lifecycle.runningAgentIds()], []);
    assert.deepEqual([...lifecycle.liveRunningAgentIds()], ["agent-4"]);
    lifecycle.beginSessionRun(session);
    assert.deepEqual([...lifecycle.runningAgentIds()], ["agent-1"]);
    assert.deepEqual([...lifecycle.liveRunningAgentIds()].sort(), ["agent-1", "agent-4"]);
    lifecycle.setSessionComposing("agent-1", true);
    lifecycle.setSessionRetrying("agent-1", true);
    lifecycle.setSessionActivity("agent-1", { kind: "tool", tool: "Grep" } as never);
    const [shown] = lifecycle.withRunStates([{ id: "agent-1" }]);
    assert.deepEqual(shown, { id: "agent-1", isRunning: true, isRunningTurn: true, isComposingMessage: true, isRetrying: true, currentActivity: { kind: "tool", tool: "Grep" }, activeRemoteMemberId: "member-2" });
    // An agent that has not changed is handed back as it arrived rather than rebuilt.
    const unchanged = { id: "agent-2", isRunning: false, isRunningTurn: false, isComposingMessage: false, isRetrying: false, currentActivity: undefined, activeRemoteMemberId: undefined };
    assert.equal(lifecycle.withRunStates([unchanged])[0], unchanged);
    // What is said about a subagent's parent counts as running too, and a display that is not running shows nothing.
    const [parent] = lifecycle.withRunStates([{ id: "agent-4" }]);
    assert.equal((parent as Record<string, unknown>).isRunning, true);
    assert.equal((parent as Record<string, unknown>).isRunningTurn, false);
    const [other] = lifecycle.withRunStates([{ id: "agent-9" }]);
    assert.deepEqual(other, { id: "agent-9", isRunning: false, isRunningTurn: false, isComposingMessage: false, isRetrying: false, currentActivity: undefined, activeRemoteMemberId: undefined });
  });

  it("says only once what changed, and follows what the agent is doing", () => {
    const { manager, calls } = transcriptManager();
    const lifecycle = new RunLifecycle(manager as never);
    calls.length = 0;
    lifecycle.setSessionComposing("agent-1", true);
    lifecycle.setSessionComposing("agent-1", true);
    lifecycle.setSessionRetrying("agent-1", true);
    lifecycle.setSessionRetrying("agent-1", true);
    assert.equal(calls.filter((call) => call[0] === "roster").length, 2);
    assert.deepEqual([...lifecycle.composingMessageSessionIds], ["agent-1"]);
    assert.deepEqual([...lifecycle.retryingSessionIds], ["agent-1"]);
    lifecycle.setSessionComposing("agent-1", false);
    lifecycle.setSessionRetrying("agent-1", false);
    assert.deepEqual([...lifecycle.composingMessageSessionIds], []);
    assert.deepEqual([...lifecycle.retryingSessionIds], []);

    // What a run is doing is shown as what it is, and held while the same thing keeps happening.
    lifecycle.trackActivityFromUpdate({ type: "tool-call", name: "Grep", status: "pending" } as never, "agent-1");
    // The tool being used is what the user is shown, with no call behind it yet.
    assert.deepEqual(lifecycle.sessionActivities.get("agent-1"), { kind: "tool", tool: "Grep", callId: undefined });
    assert.equal(lifecycle.sessionActivityHolds.has("agent-1"), true);
    // Sending a message and ending a turn both put the display back to nothing.
    lifecycle.trackActivityFromUpdate({ type: "send-message" } as never, "agent-1");
    assert.equal(lifecycle.sessionActivities.has("agent-1"), false);
    assert.equal(lifecycle.sessionActivityHolds.has("agent-1"), false);

    // Composing follows the outline the agent is filling in, and ends with the message or the turn.
    lifecycle.trackComposingFromUpdate({ type: "tool-call", name: SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME, status: "pending" } as never, "agent-1");
    assert.equal(lifecycle.composingMessageSessionIds.has("agent-1"), true);
    lifecycle.trackComposingFromUpdate({ type: "tool-call", name: SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME, status: "done" } as never, "agent-1");
    assert.equal(lifecycle.composingMessageSessionIds.has("agent-1"), false);

    // A retry from a turn that has already moved on is not what the user is being told about.
    const before = lifecycle.retryingSessionIds.has("agent-1");
    manager.turnRuntime.activeTurnEpochs.set("agent-1", 5);
    manager.sendPipeline.currentTurnEpoch = () => 9;
    lifecycle.trackRetryingFromUpdate({ type: "retrying" } as never, { id: "agent-1" });
    assert.equal(lifecycle.retryingSessionIds.has("agent-1"), before);
    manager.sendPipeline.currentTurnEpoch = () => 5;
    lifecycle.trackRetryingFromUpdate({ type: "retrying" } as never, { id: "agent-1" });
    assert.equal(lifecycle.retryingSessionIds.has("agent-1"), true);
    lifecycle.trackRetryingFromUpdate({ type: "text-delta" } as never, { id: "agent-1" });
    assert.equal(lifecycle.retryingSessionIds.has("agent-1"), false);
  });
});
