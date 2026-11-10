/**
 * The live sessions a host keeps: what is appended to a conversation's transcript and where it goes, which session the
 * window is showing, what opening a window for an agent that is not live does, and how a session is booted.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentGoneError, SessionRuntime, type LiveTranscriptSession } from "../../source/host/transcript/session-runtime.ts";
import { getTranscript } from "../../source/host/transcript/transcript-store.ts";
import { SLATE_AGENT_LIMIT_MESSAGE } from "../../source/shared/agents/agents.ts";

/** A transcript manager as the session runtime uses one, with every call written down. */
function harness(options: { agents?: Array<{ id: string }>; recordIds?: string[]; persistedId?: string | null; unopenable?: string[]; existingAgents?: string[]; persistFails?: boolean; coldEntries?: Array<{ id: string }>; unread?: { isManuallyUnread: boolean; lastActivityAt: number; lastViewedAt: number } } = {}) {
  const calls: unknown[][] = [];
  const opened: string[] = [];
  const sessions = new Map<string, LiveTranscriptSession>();
  const makeSession = (id: string): LiveTranscriptSession => ({
    id,
    dbPath: `/tmp/slate-sessions/${id}/db`,
    db: {
      appendTranscriptEntry: () => options.persistFails !== true,
      getTranscriptEntries: () => [{ id: `${id}-e1`, kind: "message" }, { id: `${id}-e2`, kind: "message" }, { id: `${id}-e3`, kind: "message" }],
      getTranscriptWindow: (query: unknown) => ({ from: "live-window", id, query }),
      getTranscriptTail: (query: unknown) => ({ from: "live-tail", id, query }),
      getThread: (rootId: string) => ({ from: "live-thread", id, rootId }),
      getTranscriptPage: (query: unknown) => ({ from: "live-page", id, query }),
      getUnreadState: () => options.unread ?? { isManuallyUnread: false, lastActivityAt: 10, lastViewedAt: 5 },
    },
    automations: { listDefinitions: () => [{ id: "routine-1" }] },
  });
  const sessionStore = {
    getTranscriptEntries: async (session: LiveTranscriptSession) => session.db.getTranscriptEntries() as never,
    getAgentTranscriptEntries: async (agentId: string) => (await sessionStore.openSession(agentId)).db.getTranscriptEntries() as never,
    markSessionActivity: (session: LiveTranscriptSession, at: number) => { calls.push(["activity", session.id, at]); },
    markSessionViewedNow: (session: LiveTranscriptSession, at: number, viewOptions: unknown) => { calls.push(["viewed-now", session.id, viewOptions]); },
    markSessionViewed: async (session: LiveTranscriptSession, at?: number, viewOptions?: unknown) => { calls.push(["viewed", session.id, viewOptions ?? null]); },
    markAgentViewed: (agentId: string) => { calls.push(["agent-viewed", agentId]); },
    readAgentTranscriptWindow: (agentId: string, query: unknown) => ({ from: "store-window", agentId, query, entries: options.coldEntries ?? [{ id: `${agentId}-c1` }, { id: `${agentId}-c2` }] }) as never,
    readAgentTranscriptTail: (agentId: string, query: unknown) => ({ from: "store-tail", agentId, query, entries: [{ id: `${agentId}-c1` }] }) as never,
    readAgentThread: (agentId: string, rootId: string) => ({ from: "store-thread", agentId, rootId }),
    readAgentTranscriptPage: (agentId: string, query: unknown) => ({ from: "store-page", agentId, query }),
    listAgents: async () => options.agents ?? [{ id: "agent-1" }, { id: "agent-2" }],
    listAgentRecordIds: async () => options.recordIds ?? [],
    readActiveAgentId: () => options.persistedId ?? null,
    openSession: async (agentId: string) => {
      opened.push(agentId);
      if ((options.unopenable ?? []).includes(agentId)) throw new Error(`cannot open ${agentId}`);
      const existing = sessions.get(agentId);
      if (existing != null) return existing;
      const session = makeSession(agentId);
      sessions.set(agentId, session);
      return session;
    },
    createFallbackSession: async () => { const session = makeSession("fallback"); sessions.set("fallback", session); return session; },
    agentExists: (agentId: string) => (options.existingAgents == null ? true : options.existingAgents.includes(agentId)),
    writeActiveAgentId: (agentId: string) => { calls.push(["write-active", agentId]); },
  };
  const manager = {
    sessionStore,
    roster: {
      emit: (value: unknown) => { calls.push(["emit", value]); },
      emitAgentUpdate: async (agentId: string) => { calls.push(["roster", agentId]); },
      invalidateActiveOutline: () => { calls.push(["invalidate-outline"]); },
    },
    taskBoundary: { settled: async () => { calls.push(["task-boundary"]); } },
    automationRuntime: {
      lastKnownAutomations: new Map<string, unknown>(),
      enqueueAutomationLifecycleMutation: (args: { agentId: string; mutation: () => void }) => { calls.push(["automation-mutation", args.agentId]); args.mutation(); },
      recordInactiveAutomationChanges: (args: { agentId: string; source: string; before: unknown[]; after: unknown[] }) => { calls.push(["record-inactive", args.agentId, args.source]); },
    },
    runLifecycle: {
      watchActiveSession: (session: LiveTranscriptSession) => { calls.push(["watch", session.id]); },
      retireSession: async (session: LiveTranscriptSession | undefined) => { calls.push(["retire", session?.id ?? null]); },
    },
    switchAgent: async (agentId: string) => { calls.push(["switch", agentId]); },
    disposed: false,
  };
  return { manager, calls, opened, sessions, makeSession };
}

/** The kinds of call the runtime made, in order. */
const kinds = (calls: unknown[][], of: string) => calls.filter((call) => call[0] === of);

describe("the sessions a host keeps", () => {
  it("appends an entry where the caller says, and marks the arrival the user should see", () => {
    const { manager, calls, makeSession } = harness();
    const runtime = new SessionRuntime(manager as never);
    runtime.activeSession = makeSession("agent-1") as LiveTranscriptSession;
    // Written before it is emitted, and not emitted at all when the caller says it will emit it itself.
    const before = getTranscript().length;
    runtime.appendEntry({ id: "entry-1", kind: "send-message" } as never, { persistBeforeEmit: true, deferEmit: true, onPersistOutcome: (durable) => { calls.push(["durable", durable]); } });
    assert.equal(getTranscript().length, before + 1);
    assert.deepEqual(kinds(calls, "durable"), [["durable", true]]);
    assert.deepEqual(kinds(calls, "emit"), []);
    // A message that raises user activity marks the session, and the window is not focused so the roster is told.
    assert.deepEqual(kinds(calls, "activity").map((call) => call[1]), ["agent-1"]);
    assert.deepEqual(kinds(calls, "roster").map((call) => call[1]), ["agent-1"]);

    // Written before it is emitted, and emitted by the runtime when the caller does not defer that.
    calls.length = 0;
    runtime.appendEntry({ id: "entry-1b", kind: "assistant-message" } as never, { persistBeforeEmit: true });
    assert.deepEqual(calls.map((call) => call[0]), ["emit"]);
    assert.deepEqual(kinds(calls, "emit").map((call) => (call[1] as { entry: { id: string } }).entry.id), ["entry-1b"]);

    // Without those options the entry is emitted first and written after.
    calls.length = 0;
    runtime.appendEntry({ id: "entry-2", kind: "assistant-message" } as never);
    assert.deepEqual(calls.map((call) => call[0]), ["emit"]);

    // An entry that came from an agent does not raise the user's own activity.
    calls.length = 0;
    runtime.appendEntry({ id: "entry-3", kind: "message", fromAgent: "another-agent" } as never);
    assert.deepEqual(calls.map((call) => call[0]), ["emit"]);

    // An entry that was not written down says so rather than appearing saved.
    const failing = harness({ persistFails: true });
    const failingRuntime = new SessionRuntime(failing.manager as never);
    failingRuntime.activeSession = failing.makeSession("agent-1") as LiveTranscriptSession;
    const outcomes: boolean[] = [];
    failingRuntime.appendEntry({ id: "entry-4", kind: "assistant-message" } as never, { persistBeforeEmit: true, onPersistOutcome: (durable) => { outcomes.push(durable); } });
    assert.deepEqual(outcomes, [false]);
  });

  it("follows the window: what the user is looking at is seen, and what they look away from is not", async () => {
    const { manager, calls, makeSession } = harness();
    const runtime = new SessionRuntime(manager as never);
    runtime.activeSession = makeSession("agent-1") as LiveTranscriptSession;
    assert.equal(runtime.getWindowFocusedAtMs(), null);
    await runtime.setWindowFocused(true);
    assert.equal(runtime.isWindowFocused, true);
    assert.equal(typeof runtime.getWindowFocusedAtMs(), "number");
    // Focusing again changes nothing, and while focused an arrival is marked as seen.
    calls.length = 0;
    await runtime.setWindowFocused(true);
    assert.deepEqual(calls, []);
    runtime.noteDesktopContact();
    assert.equal(typeof runtime.getWindowFocusedAtMs(), "number");
    calls.length = 0;
    runtime.appendEntry({ id: "entry-1", kind: "message" } as never);
    assert.deepEqual(kinds(calls, "viewed-now").map((call) => call[2]), [{ preserveManualUnread: true }]);
    assert.deepEqual(kinds(calls, "roster"), []);
    // Looking away clears when the window was last focused.
    await runtime.setWindowFocused(false);
    assert.equal(runtime.getWindowFocusedAtMs(), null);
    // Coming back marks what arrived while the user was away as seen — the session says there is activity after the
    // last time it was read.
    calls.length = 0;
    await runtime.setWindowFocused(true);
    assert.deepEqual(calls.map((call) => call[0]), ["viewed", "roster"]);
    assert.deepEqual(kinds(calls, "viewed").map((call) => call[2]), [{ preserveManualUnread: true }]);
    // With nothing new to see, coming back does not mark the session seen at all.
    const quiet = harness({ unread: { isManuallyUnread: false, lastActivityAt: 5, lastViewedAt: 5 } });
    const quietRuntime = new SessionRuntime(quiet.manager as never);
    quietRuntime.activeSession = quiet.makeSession("agent-1") as LiveTranscriptSession;
    await quietRuntime.setWindowFocused(false);
    quiet.calls.length = 0;
    await quietRuntime.setWindowFocused(true);
    assert.deepEqual(quiet.calls, []);
    // A session the user marked unread by hand stays unread until they read it.
    const manual = harness({ unread: { isManuallyUnread: true, lastActivityAt: 10, lastViewedAt: 5 } });
    const manualRuntime = new SessionRuntime(manual.manager as never);
    manualRuntime.activeSession = manual.makeSession("agent-1") as LiveTranscriptSession;
    await manualRuntime.setWindowFocused(true);
    manual.calls.length = 0;
    await manualRuntime.setWindowFocused(false);
    await manualRuntime.setWindowFocused(true);
    assert.deepEqual(manual.calls, []);
  });

  it("loads the transcript once and thereafter answers from memory", async () => {
    const { manager, calls, makeSession } = harness();
    const runtime = new SessionRuntime(manager as never);
    const entries = await runtime.ensureLoaded();
    assert.equal(entries.length, 3);
    assert.equal(runtime.getActiveAgentId(), "agent-1");
    assert.equal(runtime.getActiveAgentDir(), "/tmp/slate-sessions/agent-1");
    assert.deepEqual(kinds(calls, "emit").map((call) => (call[1] as { type: string; activeAgentId: string }).type), ["snapshot"]);
    calls.length = 0;
    assert.equal((await runtime.ensureLoaded()).length, 3);
    assert.deepEqual(calls, []);
    assert.equal(runtime.getEntries().length, 3);
  });

  it("switches to another agent, and says which one the window now shows", async () => {
    const { manager, calls, makeSession } = harness();
    const runtime = new SessionRuntime(manager as never);
    runtime.activeSession = makeSession("agent-1") as LiveTranscriptSession;
    runtime.isWindowFocused = true;
    calls.length = 0;
    const entries = await runtime.switchAgent("agent-2");
    assert.equal(entries.length, 3);
    assert.equal(runtime.getActiveAgentId(), "agent-2");
    // The session left behind is marked seen while the window is focused, the new one is seen, and both are announced.
    assert.deepEqual(kinds(calls, "viewed").map((call) => call[1]), ["agent-1", "agent-2"]);
    assert.deepEqual(kinds(calls, "roster").map((call) => call[1]), ["agent-2", "agent-1"]);
    assert.deepEqual(kinds(calls, "write-active").map((call) => call[1]), ["agent-2"]);
    assert.deepEqual(kinds(calls, "invalidate-outline").length, 1);
    // The agent that was left behind has what it did while it was inactive recorded.
    assert.deepEqual(kinds(calls, "automation-mutation").map((call) => call[1]), ["agent-1"]);
    assert.deepEqual(kinds(calls, "record-inactive"), [["record-inactive", "agent-1", "agent"]]);
    assert.deepEqual(kinds(calls, "retire").map((call) => call[1]), ["agent-1"]);
    assert.deepEqual(kinds(calls, "watch").map((call) => call[1]), ["agent-2"]);
    // Switching to the agent already shown changes nothing.
    calls.length = 0;
    await runtime.switchAgent("agent-2");
    assert.deepEqual(calls, []);
  });

  it("does not activate a session that was superseded while it opened", async () => {
    const { manager, calls, makeSession } = harness();
    const runtime = new SessionRuntime(manager as never);
    let superseded = false;
    const opened = await runtime.activateSession("agent-2", undefined, () => superseded);
    assert.equal(opened?.session.id, "agent-2");
    superseded = true;
    calls.length = 0;
    assert.equal(await runtime.activateSession("agent-3", undefined, () => superseded), undefined);
    // Nothing about the session that arrived too late is announced.
    assert.deepEqual(kinds(calls, "write-active"), []);
    assert.deepEqual(kinds(calls, "roster"), []);
  });

  it("opens a window for an agent that is not live, and catches the transcript up afterwards", async () => {
    const { manager, calls, makeSession } = harness();
    const runtime = new SessionRuntime(manager as never);
    runtime.activeSession = makeSession("agent-1") as LiveTranscriptSession;
    calls.length = 0;
    const cold = await runtime.openAgentWindowed("agent-3", 10) as unknown as { from: string; entries: Array<{ id: string }> };
    // What the store holds is shipped straight away, and the agent is marked seen.
    assert.deepEqual(cold, { from: "store-window", agentId: "agent-3", query: { limit: 10 }, entries: [{ id: "agent-3-c1" }, { id: "agent-3-c2" }] });
    assert.deepEqual(kinds(calls, "agent-viewed").map((call) => call[1]), ["agent-3"]);
    assert.equal(runtime.pendingActivationAgentId, "agent-3");
    // The activation itself waits for a task boundary, then makes the agent the one the window shows.
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.deepEqual(kinds(calls, "task-boundary").length, 1);
    assert.equal(runtime.getActiveAgentId(), "agent-3");
    assert.equal(runtime.pendingActivationAgentId, null);
    // What the cold read had not shipped is emitted as it is caught up.
    calls.length = 0;
    runtime.emitWindowedCatchUp("agent-3-c1", [{ id: "a", kind: "message" }, { id: "agent-3-c1", kind: "message" }, { id: "agent-3-c2", kind: "message" }] as never);
    assert.deepEqual(kinds(calls, "emit").map((call) => (call[1] as { entry: { id: string } }).entry.id), ["agent-3-c2"]);
    calls.length = 0;
    runtime.emitWindowedCatchUp("not-there", [{ id: "a", kind: "message" }] as never);
    assert.deepEqual(calls, []);
    calls.length = 0;
    runtime.emitWindowedCatchUp(undefined, [{ id: "a", kind: "message" }, { id: "b", kind: "message" }] as never);
    assert.deepEqual(kinds(calls, "emit").length, 2);
  });

  it("drops a deferred activation that was cancelled before it ran", async () => {
    const { manager, calls, makeSession } = harness();
    const runtime = new SessionRuntime(manager as never);
    runtime.activeSession = makeSession("agent-1") as LiveTranscriptSession;
    calls.length = 0;
    await runtime.openAgentWindowed("agent-4", 10);
    assert.equal(runtime.pendingActivationAgentId, "agent-4");
    // Something else claimed the window before the activation could run, so it must not take it.
    runtime.invalidateDeferredActivation();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(runtime.getActiveAgentId(), "agent-1");
    assert.equal(runtime.pendingActivationAgentId, null);
    assert.deepEqual(kinds(calls, "write-active"), []);
    assert.deepEqual(kinds(calls, "roster"), [["roster", "agent-4"]]);
  });

  it("reads a live session's window without going to the store", async () => {
    const { manager, calls, makeSession } = harness();
    const runtime = new SessionRuntime(manager as never);
    runtime.activeSession = makeSession("agent-1") as LiveTranscriptSession;
    await runtime.switchAgent("agent-2");
    calls.length = 0;
    // The agent is live but not the one on screen: it is activated first, then read live.
    assert.deepEqual(await runtime.openAgentWindowed("agent-2", 10), { from: "live-window", id: "agent-2", query: { limit: 10 } });
    assert.equal(runtime.getActiveAgentId(), "agent-2");
    calls.length = 0;
    runtime.emitWindowedCatchUp(undefined, []);
    assert.deepEqual(calls, []);
  });

  it("boots the session the platform remembers, skipping what cannot be opened", async () => {
    const { manager, sessions, calls } = harness({ persistedId: "agent-2", agents: [{ id: "agent-1" }, { id: "agent-2" }], unopenable: ["agent-1"] });
    const runtime = new SessionRuntime(manager as never);
    const session = await runtime.ensureSession();
    // The agent the platform remembers is opened first, so the unopenable one is never reached.
    assert.equal(session.id, "agent-2");
    assert.equal(runtime.getActiveAgentId(), "agent-2");
    assert.deepEqual(kinds(calls, "viewed").map((call) => call[1]), ["agent-2"]);
    assert.deepEqual(kinds(calls, "watch").map((call) => call[1]), ["agent-2"]);
    // Asking again answers with the session already open.
    calls.length = 0;
    assert.equal((await runtime.ensureSession()).id, "agent-2");
    assert.deepEqual(calls, []);
    assert.equal(sessions.has("fallback"), false);
  });

  it("falls back to the platform's own session when no agent can be opened", async () => {
    const { manager, calls, makeSession } = harness({ agents: [{ id: "agent-1" }], unopenable: ["agent-1"] });
    const runtime = new SessionRuntime(manager as never);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      const session = await runtime.ensureSession();
      assert.equal(session.id, "fallback");
      assert.equal(runtime.getActiveAgentId(), "fallback");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.startsWith("[slate] skipping unopenable agent agent-1 on boot:"), true);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(kinds(calls, "write-active").map((call) => call[1]), ["fallback"]);
  });

  it("opens one session per agent, and does not keep a failed one as pending", async () => {
    const { manager, opened, calls } = harness({ unopenable: ["agent-1"] });
    const runtime = new SessionRuntime(manager as never);
    const first = runtime.openSessionOnce("agent-1").catch(() => "failed");
    const second = runtime.openSessionOnce("agent-1").catch(() => "failed");
    assert.deepEqual(await Promise.all([first, second]), ["failed", "failed"]);
    // One attempt was made, not two, and the failure is not remembered as an open in flight.
    assert.deepEqual(opened, ["agent-1"]);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    assert.equal(runtime.pendingSessionOpens.size, 0);
    // A session that opens is handed to everyone who asks for it, and kept.
    calls.length = 0;
    const [a, b] = await Promise.all([runtime.openSessionOnce("agent-2"), runtime.openSessionOnce("agent-2")]);
    assert.equal(a, b);
    assert.deepEqual(opened, ["agent-1", "agent-2"]);
  });

  it("says what is stored for an agent that is not on screen", async () => {
    const { manager, makeSession } = harness();
    const runtime = new SessionRuntime(manager as never);
    assert.deepEqual(await runtime.getAgentTranscript("agent-9"), [{ id: "agent-9-e1", kind: "message" }, { id: "agent-9-e2", kind: "message" }, { id: "agent-9-e3", kind: "message" }]);
    assert.deepEqual(runtime.getAgentThread("agent-9", "root-1"), { from: "store-thread", agentId: "agent-9", rootId: "root-1" });
    assert.deepEqual(runtime.getAgentTranscriptPage("agent-9", { limit: 5 }), { from: "store-page", agentId: "agent-9", query: { limit: 5 } });
    assert.deepEqual(runtime.getAgentTranscriptWindow("agent-9", { limit: 2 }), { from: "store-window", agentId: "agent-9", query: { limit: 2 }, entries: [{ id: "agent-9-c1" }, { id: "agent-9-c2" }] });
    assert.deepEqual(runtime.getAgentTranscriptTail("agent-9", { limit: 1 }), { from: "store-tail", agentId: "agent-9", query: { limit: 1 }, entries: [{ id: "agent-9-c1" }] });
    // The transcript already in memory is what the agent on screen is read from.
    runtime.activeSession = makeSession("agent-1") as LiveTranscriptSession;
    runtime.setActiveTranscript("agent-1", [{ id: "in-memory", kind: "message" } as never]);
    assert.deepEqual(await runtime.getAgentTranscript("agent-1"), [{ id: "in-memory", kind: "message" }]);
  });

  it("knows which agents are gone, and refuses to open one", async () => {
    const { manager } = harness({ existingAgents: ["agent-1", "agent-2"] });
    const runtime = new SessionRuntime(manager as never);
    assert.equal(runtime.isAgentGone("agent-1"), false);
    assert.equal(runtime.isAgentGone("missing"), true);
    // An agent the host knows was deleted is gone even while its record is still there.
    runtime.deletedAgentIds.add("agent-1");
    assert.equal(runtime.isAgentGone("agent-1"), true);
    await runtime.resolveBackgroundSession("missing").then(
      () => assert.fail("a session was opened for an agent that is gone"),
      (error: AgentGoneError) => { assert.equal(error instanceof AgentGoneError, true); assert.equal(error.message, "Agent missing no longer exists"); },
    );
    const opened = await runtime.resolveBackgroundSession("agent-2");
    assert.equal(opened.id, "agent-2");
  });

  it("turns an agent limit into nothing rather than an error, and rethrows anything else", async () => {
    const { manager } = harness({ agents: [] });
    const runtime = new SessionRuntime(manager as never);
    manager.sessionStore.listAgents = async () => { throw new Error(SLATE_AGENT_LIMIT_MESSAGE); };
    assert.equal(await runtime.tryEnsureSession(), null);
    manager.sessionStore.listAgents = async () => { throw new Error("something else"); };
    await runtime.tryEnsureSession().then(
      () => assert.fail("an error that is not the agent limit was swallowed"),
      (error: Error) => assert.equal(error.message, "something else"),
    );
  });

  it("switches what an action acts on, and claims the window only while it is pending", async () => {
    const { manager, calls, makeSession } = harness();
    const runtime = new SessionRuntime(manager as never);
    runtime.activeSession = makeSession("agent-5") as LiveTranscriptSession;
    await runtime.ensureActionTarget(undefined);
    await runtime.ensureActionTarget("agent-5");
    // Nothing is switched for the agent already on screen, or for no agent at all.
    assert.deepEqual(calls.filter((call) => call[0] === "switch"), []);
    await runtime.ensureActionTarget("agent-6");
    assert.deepEqual(calls.filter((call) => call[0] === "switch"), [["switch", "agent-6"]]);
    // The window says which agent it is showing, and which one it is about to.
    assert.equal(runtime.getAnnouncedActiveAgentId(), "agent-5");
    const claim = new AbortController();
    runtime.windowedActivationAbort = claim;
    runtime.pendingActivationAgentId = "agent-7";
    assert.equal(runtime.getAnnouncedActiveAgentId(), "agent-7");
    runtime.clearPendingActivationClaim(claim);
    assert.equal(runtime.getAnnouncedActiveAgentId(), "agent-5");
    runtime.pendingActivationAgentId = "agent-8";
    runtime.invalidateDeferredActivation();
    assert.equal(runtime.pendingActivationAgentId, null);
    assert.equal(claim.signal.aborted, true);
    assert.equal(runtime.getAnnouncedActiveAgentId(), "agent-5");
  });
});
