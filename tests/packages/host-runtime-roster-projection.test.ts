/**
 * What the platform is told a conversation looks like: the outline a reader follows, how a later update takes its place
 * in the order, what the agent is doing in the background, and which of its subagents are still working.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME } from "../../source/host/runner/conversation-outline.ts";
import { OUTLINE_STREAM_COALESCE_MS, RosterProjection } from "../../source/host/transcript/roster-projection.ts";

/** A transcript manager as the projection uses one, with the pieces it composes around a conversation. */
function harness(options: { runners?: Map<string, unknown>; outlines?: Map<string, unknown[]>; pendingWakes?: unknown[]; resetValue?: unknown; sessionId?: string } = {}) {
  const calls: unknown[][] = [];
  const sessionId = options.sessionId ?? "agent-1";
  const session = { id: sessionId };
  let monotonic = 1_000;
  const meters: Array<{ at: number; callback: () => void; disposed: boolean }> = [];
  const manager = {
    taskBoundary: { settled: async () => { calls.push(["boundary"]); } },
    runLifecycle: { withRunStates: <T>(agents: readonly T[]): T[] => { calls.push(["run-states", agents.length]); return [...agents]; } },
    sessions: {
      activeSession: session,
      inMemoryTranscriptAgentId: sessionId as string | null,
      deletedAgentIds: new Set<string>(),
      tryEnsureSession: async () => session,
      ensureSession: async () => session,
      getAnnouncedActiveAgentId: () => sessionId,
      liveSessions: new Map<string, unknown>([[sessionId, session]]),
    },
    sessionStore: {
      listAgents: async (announcedId: unknown) => { calls.push(["list-agents", announcedId]); return [{ id: sessionId, name: "One" }]; },
      isAgentCapReached: async () => { calls.push(["cap"]); return false; },
      getAgentOutline: async (agentId: string) => { calls.push(["agent-outline", agentId]); if (agentId === "explodes") throw new Error("no outline"); return options.outlines?.get(agentId) ?? []; },
      getSessionOutline: async (target: { id: string }) => { calls.push(["session-outline", target.id]); return options.outlines?.get(target.id) ?? []; },
      getAgentProfileText: () => null,
      getAgentDir: () => "/agents/one",
    },
    runnerRegistry: { runners: options.runners ?? new Map<string, unknown>() },
    pendingWakeStore: options.pendingWakes === undefined ? undefined : { listPending: () => options.pendingWakes },
    clientSideToolV2: { reset: (agentId: string) => { calls.push(["reset", agentId]); return options.resetValue ?? null; } },
    productAnalytics: { trackEvent: (name: string, payload: unknown) => { calls.push(["analytics", name, payload]); } },
    clock: { now: () => monotonic, monotonicNow: () => monotonic, schedule: () => ({ dispose: () => {} }) },
  };
  const projection = new RosterProjection(manager as never);
  return {
    projection, manager, session, calls,
    advance(ms: number) { monotonic += ms; },
    // A debounce policy the test drives itself, so the coalescing is observable.
    coalescing() {
      const armed: Array<{ callback: () => void; disposed: boolean; scheduled: boolean }> = [];
      // A real debounce waits; this one records what was asked for until the test runs it.
      const policy = { name: "outline", wrap: (callback: () => void) => { const entry = { callback, disposed: false, scheduled: false }; armed.push(entry); return Object.assign(() => { entry.scheduled = true; }, { dispose: () => { entry.disposed = true; } }); } };
      projection.setOutlineStreamCoalescing(policy as never, { now: () => monotonic, monotonicNow: () => monotonic, schedule: (delayMs: number, callback: () => void) => { const entry = { at: monotonic + delayMs, callback, disposed: false }; meters.push(entry); return { dispose: () => { entry.disposed = true; } }; } });
      return {
        armed,
        run() { for (const entry of armed) if (!entry.disposed && entry.scheduled) { entry.scheduled = false; entry.callback(); } },
        timers: meters,
      };
    },
    kinds: (of: string) => calls.filter((call) => call[0] === of),
  };
}

describe("the outline a reader follows", () => {
  it("keeps the outline of the conversation on screen, and puts what was already there in front of what just happened", async () => {
    const world = harness({ outlines: new Map([["agent-1", [{ id: "older", kind: "assistant-text", text: "before" }]]]) });
    const events: unknown[] = [];
    world.projection.subscribeOutline((event) => { events.push(event); });
    const items = await world.projection.loadActiveOutline(world.session);
    assert.deepEqual(items.map((item) => item.id), ["older"]);
    assert.equal(world.projection.outlineAgentId, "agent-1");
    // Something happened while the stored outline was being read: it comes after what was already there.
    const world2 = harness({ outlines: new Map([["agent-1", [{ id: "older", kind: "assistant-text", text: "before" }]]]) });
    const loading = world2.projection.loadActiveOutline(world2.session);
    world2.projection.appendOutlineItem({ id: "newer", kind: "assistant-text", text: "after" });
    const loaded = await loading;
    assert.deepEqual(loaded.map((item) => item.id), ["older", "newer"]);
    // Asking again for the same conversation answers with what is already in hand.
    assert.deepEqual((await world2.projection.loadActiveOutline(world2.session)).map((item) => item.id), ["older", "newer"]);
  });

  it("starts the conversation over when the window moves on, and drops what was being read", async () => {
    const world = harness();
    world.projection.appendOutlineItem({ id: "kept", kind: "assistant-text", text: "from the old one" });
    // A load that was overtaken by the window changing is not allowed to put the old outline back.
    const items = await world.projection.loadActiveOutline(world.session);
    assert.deepEqual(items, []);
    world.projection.invalidateActiveOutline();
    assert.deepEqual({ agent: world.projection.outlineAgentId, items: world.projection.outline, assistant: world.projection.streamingAssistantOutlineId }, { agent: null, items: [], assistant: undefined });
  });

  it("follows what the agent is writing, thinking and doing", () => {
    const world = harness();
    const events: unknown[] = [];
    world.projection.subscribeOutline((event) => { events.push(event); });
    // Nothing is projected before a conversation is on screen.
    world.projection.applyAgentUpdateToOutline({ type: "text-delta", text: "hello" });
    assert.deepEqual(events, []);
    world.projection.outlineAgentId = "agent-1";
    // A delta with nothing in it is not worth an item.
    world.projection.applyAgentUpdateToOutline({ type: "text-delta", text: "" });
    assert.deepEqual(events, []);
    // Writing is one item that grows, and thinking after it is its own item.
    world.projection.applyAgentUpdateToOutline({ type: "text-delta", text: "hello " });
    world.projection.applyAgentUpdateToOutline({ type: "text-delta", text: "there" });
    assert.deepEqual(world.projection.outline.map((item) => [item.kind, item.text]), [["assistant-text", "hello there"]]);
    world.projection.applyAgentUpdateToOutline({ type: "thinking-delta", text: "hmm" });
    assert.deepEqual(world.projection.outline.map((item) => item.kind), ["assistant-text", "thinking"]);
    // Writing again after thinking is its own item too, rather than growing from the thinking.
    world.projection.applyAgentUpdateToOutline({ type: "thinking-delta", text: " more" });
    world.projection.applyAgentUpdateToOutline({ type: "text-delta", text: "back" });
    assert.deepEqual(world.projection.outline.map((item) => [item.kind, item.text]), [["assistant-text", "hello there"], ["thinking", "hmm more"], ["assistant-text", "back"]]);
    // The call that puts a message in the room is shown as the message, not as the call behind it.
    const beforeSend = world.projection.outline.length;
    world.projection.applyAgentUpdateToOutline({ type: "tool-call", id: "call-send", name: SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME, status: "pending" });
    assert.equal(world.projection.outline.length, beforeSend);
    // A tool call that is already in the outline is updated rather than added again, and writing again starts fresh.
    world.projection.applyAgentUpdateToOutline({ type: "tool-call", id: "call-1", name: "Shell", status: "pending" });
    world.projection.applyAgentUpdateToOutline({ type: "tool-call", id: "call-1", name: "Shell", status: "done", summary: "listed the files" });
    world.projection.applyAgentUpdateToOutline({ type: "tool-call", id: "task-call-1", name: "Task", status: "pending" });
    const progress = { schemaVersion: 1, kind: "assistant-text", text: "child output", serverNotice: false } as const;
    world.projection.applyAgentUpdateToOutline({ type: "task-progress", toolCallId: "task-call-1", update: progress });
    const pendingTask = world.projection.outline.find((item) => item.id === "task-call-1");
    assert.equal(pendingTask?.kind, "tool-call");
    assert.equal(pendingTask?.status, "pending");
    assert.deepEqual(pendingTask?.progress, progress);
    world.projection.applyAgentUpdateToOutline({ type: "tool-call", id: "task-call-1", name: "Task", status: "done", summary: "completed task" });
    const tools = world.projection.outline.filter((item) => item.kind === "tool-call");
    assert.deepEqual(tools.map((item) => [item.id, item.status, item.summary]), [
      ["call-1", "done", "listed the files"],
      ["task-call-1", "done", "completed task"],
    ]);
    assert.deepEqual((tools[1] as { progress?: unknown }).progress, progress);
    world.projection.applyAgentUpdateToOutline({ type: "text-delta", text: "next" });
    assert.deepEqual(world.projection.outline.at(-1).text, "next");
    // A message the agent sent to the room is its own item, and the end of a turn only stops the streaming.
    world.projection.applyAgentUpdateToOutline({ type: "send-message", message: { type: "text", content: "hi" }, timestampMs: 42 });
    assert.deepEqual(world.projection.outline.at(-1), { kind: "send-message", id: world.projection.outline.at(-1).id, message: { type: "text", content: "hi" }, timestampMs: 42 });
    const before = world.projection.outline.length;
    world.projection.applyAgentUpdateToOutline({ type: "turn-ended" });
    assert.equal(world.projection.outline.length, before);
  });

  it("holds a stream of small changes together and sends them as one", () => {
    const world = harness();
    const { run } = world.coalescing();
    world.projection.outlineAgentId = "agent-1";
    const sent: Array<[string, string, string]> = [];
    world.projection.subscribeOutline((event: { type: string; item: { id: string; text: string } }) => { sent.push([event.type, event.item.id, event.item.text]); });
    // The first update is held: the reader is told once, not on every keystroke.
    const item = { id: "item-1", kind: "assistant-text", text: "" };
    world.projection.appendOutlineItem(item);
    sent.length = 0;
    world.projection.updateOutlineItem("item-1", (held) => ({ ...held, text: "a" }), { coalesce: true });
    world.projection.updateOutlineItem("item-1", (held) => ({ ...held, text: "ab" }), { coalesce: true });
    // Both changes are held, and the reader is told once with what the item now says.
    assert.deepEqual(sent, []);
    run();
    assert.deepEqual(sent, [["updated", "item-1", "ab"]]);
    // An update for something else flushes what was waiting first.
    world.projection.appendOutlineItem({ id: "item-2", kind: "assistant-text", text: "" });
    sent.length = 0;
    world.projection.updateOutlineItem("item-1", (held) => ({ ...held, text: "abc" }), { coalesce: true });
    world.projection.updateOutlineItem("item-2", (held) => ({ ...held, text: "z" }), { coalesce: true });
    assert.deepEqual(sent, [["updated", "item-1", "abc"]]);
    run();
    assert.deepEqual(sent, [["updated", "item-1", "abc"], ["updated", "item-2", "z"]]);
    // Long enough since the last send, the change goes out at once.
    sent.length = 0;
    world.advance(OUTLINE_STREAM_COALESCE_MS);
    world.projection.updateOutlineItem("item-1", (held) => ({ ...held, text: "now" }), { coalesce: true });
    assert.deepEqual(sent, [["updated", "item-1", "now"]]);
    // Stopping leaves nothing waiting to be sent.
    world.projection.stopOutlineStreamCoalescing();
    sent.length = 0;
    world.projection.flushStreamOutlineUpdate();
    assert.deepEqual(sent, []);
  });

  it("gives the platform its own ordering stamp, and says how much of the conversation it covers", () => {
    const world = harness();
    const events: unknown[] = [];
    world.projection.subscribe((event) => { events.push(event); });
    // A snapshot covers the conversation from its first item to what was just sent.
    world.projection.emit({ type: "snapshot", activeAgentId: "agent-1", entries: [] });
    const snapshot = events[0] as { ordered: { replicaKey: string; sequence: number }; coverage: { kind: string; fromSequence: number; throughSequence: number } };
    assert.deepEqual({ key: snapshot.ordered.replicaKey, sequence: snapshot.ordered.sequence, coverage: snapshot.coverage }, { key: "transcript:agent-1", sequence: 1, coverage: { kind: "transcript-live-range", fromSequence: 1, throughSequence: 1 } });
    // Anything else is stamped and told whose conversation it belongs to.
    world.projection.emitOutline({ type: "appended", agentId: "agent-1", item: { id: "i" } });
    world.projection.emit({ type: "appended", entry: { id: "e" } });
    const appended = events.at(-1) as { agentId: string; ordered: { sequence: number } };
    // The stamp follows the conversation it belongs to, one step on from the snapshot.
    assert.deepEqual({ agentId: appended.agentId, sequence: appended.ordered.sequence }, { agentId: "agent-1", sequence: 2 });
    // An event with no conversation to belong to is passed on exactly as it came.
    assert.deepEqual(world.projection.withOrderedStamp({ type: "appended", agentId: "" }), { type: "appended", agentId: "" });
    // Clearing a conversation also clears what the user's surface was holding for it.
    const cleared = harness({ resetValue: { toolCallId: "call-1" } });
    const toolUpdates: unknown[] = [];
    cleared.projection.subscribeClientSideToolV2((value) => { toolUpdates.push(value); });
    cleared.projection.emit({ type: "cleared", agentId: "agent-1" });
    assert.deepEqual(cleared.kinds("reset").map((call) => call[1]), ["agent-1"]);
    assert.deepEqual(toolUpdates, [{ toolCallId: "call-1" }]);
  });
});

describe("what an agent is doing in the background", () => {
  it("says what an agent's subagents are working on, and stops saying it when they are done", () => {
    const world = harness();
    const parents: string[] = [];
    world.projection.subscribeSubagents((event: { parentAgentId: string }) => { parents.push(event.parentAgentId); });
    let running = true;
    const source = { hasRunningSubagents: () => running };
    world.projection.emitSubagents(source, { parentAgentId: "agent-1", subagents: [{ id: "s1" }] });
    assert.deepEqual(parents, ["agent-1"]);
    assert.deepEqual([...world.projection.liveSubagentParentIds()], ["agent-1"]);
    assert.equal(world.projection.reportedSubagentParents.has("agent-1"), true);
    // A second source that is idle does not take the running one away: the agent is still working.
    const idle = { hasRunningSubagents: () => false };
    world.projection.emitSubagents(idle, { parentAgentId: "agent-1", subagents: [] });
    assert.deepEqual([...world.projection.liveSubagentParentIds()], ["agent-1"]);
    // Once nothing it is working on is running, the source is dropped and the platform is told the agent stopped.
    running = false;
    assert.deepEqual([...world.projection.liveSubagentParentIds()], []);
    assert.deepEqual([...world.projection.subagentWorkSources.keys()], []);
    // Forgetting an agent forgets both what it was working on and that it was reported.
    world.projection.emitSubagents(source, { parentAgentId: "agent-2", subagents: [] });
    world.projection.forgetAgentSubagentWork("agent-2");
    assert.equal(world.projection.subagentWorkSources.has("agent-2"), false);
    assert.equal(world.projection.reportedSubagentParents.has("agent-2"), false);
    // A listener that throws is reported rather than breaking the fan-out.
    const failing = harness();
    failing.projection.subscribeSubagents(() => { throw new TypeError("bad listener"); });
    failing.projection.emitSubagents(source, { parentAgentId: "agent-1", subagents: [] });
    assert.deepEqual(failing.kinds("analytics").map((call) => [call[1], (call[2] as { error_type: string }).error_type]), [["slate.subagent.fanout_failed", "TypeError"]]);
  });

  it("keeps what each runner is doing, and merges it into one list per agent", () => {
    const world = harness({ pendingWakes: [{ agentId: "agent-1", kind: "shell", workId: "work-1" }] });
    const events: unknown[] = [];
    world.projection.subscribeAsyncTasks((event) => { events.push(event); });
    const first = { listAsyncTasks: () => [] };
    world.projection.emitAsyncTasks(first, { parentAgentId: "agent-1", tasks: [{ kind: "subagent", id: "s1" }] });
    assert.deepEqual(world.projection.mergedAsyncTasks("agent-1").map((task) => task.id), ["s1", "work-1"]);
    // A runner that has nothing left is forgotten, and the tasks it was holding do not come back.
    world.projection.emitAsyncTasks(first, { parentAgentId: "agent-1", tasks: [] });
    assert.deepEqual(world.projection.mergedAsyncTasks("agent-1").map((task) => task.id), ["work-1"]);
    // An agent the host has forgotten has nothing to report at all.
    world.manager.sessions.deletedAgentIds.add("agent-2");
    const beforeForget = events.length;
    world.projection.emitAsyncTasks(first, { parentAgentId: "agent-2", tasks: [{ kind: "subagent", id: "s2" }] });
    assert.equal(events.length, beforeForget);
    world.projection.emitAsyncTasksForAgent("agent-1");
    assert.deepEqual(events.at(-1), { parentAgentId: "agent-1", tasks: world.projection.mergedAsyncTasks("agent-1") });
  });

  it("answers with a subagent's outline from the runner that has it, and with nothing when nothing does", async () => {
    const subagentId = "slate-subagent-abc";
    const runner = { hasSubagent: (id: string) => id === subagentId, getSubagentOutline: async () => [{ id: "step-1" }] };
    const throwing = { hasSubagent: () => true, getSubagentOutline: async () => { throw new Error("gone"); } };
    const world = harness({ runners: new Map<string, unknown>([["parent", runner]]) });
    const outlines: Array<[string, string]> = [];
    world.projection.subscribeOutline((event: { type: string; agentId: string }) => { outlines.push([event.type, event.agentId]); });
    assert.deepEqual(await world.projection.getConversationOutline(subagentId), [{ id: "step-1" }]);
    assert.deepEqual(outlines, [["snapshot", subagentId]]);
    // A runner that cannot answer for its subagent leaves an empty outline rather than an error.
    const failing = harness({ runners: new Map<string, unknown>([["parent", throwing]]) });
    assert.deepEqual(await failing.projection.getConversationOutline("slate-subagent-xyz"), []);
    // An agent that is not the conversation on screen is read from the store.
    const stored = harness({ outlines: new Map([["agent-9", [{ id: "stored" }]]]) });
    assert.deepEqual(await stored.projection.getConversationOutline("agent-9"), [{ id: "stored" }]);
    assert.deepEqual(stored.kinds("agent-outline").map((call) => call[1]), ["agent-9"]);
    // And one the store cannot read leaves an empty outline too.
    assert.deepEqual(await stored.projection.getConversationOutline("explodes"), []);
  });
});
