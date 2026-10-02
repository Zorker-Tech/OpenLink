/**
 * Waking a conversation for what happened while nobody was talking to it: the queues for channel messages, delivery
 * failures, broadcasts and timeline events, what each wake is asked to do, and what a wake that failed leaves behind.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BackgroundWakes, distinctChannelAddresses } from "../../source/host/transcript/background-wakes.ts";
import { AgentGoneError } from "../../source/host/transcript/session-runtime.ts";
import { getTranscript, setTranscript } from "../../source/host/transcript/transcript-store.ts";
import { SLATE_DISK_SAVER_KICKSTART_PROMPT } from "../../source/shared/agents/disk-saver.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };

const envelopeOf = (overrides: Record<string, unknown> = {}) => ({
  address: { platform: "slack", chat: "C1" },
  sender: "octocat",
  text: "hello there",
  timestampMs: 1_000,
  ...overrides,
});

/** A session the wakes use, with the little its own database has to answer. */
function fakeSession(id: string, entries: Array<Record<string, unknown>> = []) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  return {
    id,
    dbPath: `/tmp/${id}/store.db`,
    calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    db: {
      getTranscriptEntries: () => entries,
      appendTranscriptEntry: (entry: Record<string, unknown>) => {
        entries.push(entry);
        return true;
      },
      close: () => record("close"),
    },
  };
}

/**
 * A transcript manager for the wakes: the run surface, the channel machinery and the queues they share, with every call
 * written down. The completions and the messages between agents are the real ones, so what they own is exercised too.
 */
function world(
  options: {
    canExecute?: boolean;
    activeSession?: ReturnType<typeof fakeSession> | undefined;
    liveSessions?: Array<[string, ReturnType<typeof fakeSession>]>;
    group?: boolean;
    remoteRoom?: boolean;
    gone?: string[];
    running?: string[];
    runResult?: Record<string, unknown>;
    runError?: Error;
    ensureReply?: boolean;
    enqueueAccepted?: boolean;
    sessionError?: Error;
    agentGoneError?: boolean;
    deliveryError?: Error;
    agentIds?: string[];
    shellWork?: boolean;
    unanswered?: { skippedQuestionPrompts: string[]; dismissedQuestionPrompts: string[] };
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const active = options.activeSession;
  const runner = {
    run: async (prompt: string, runOptions: Record<string, unknown>) => {
      record("run", prompt, runOptions);
      if (options.runError !== undefined) throw options.runError;
      return options.runResult ?? { sentMessageCount: 1, reacted: false, aborted: false };
    },
    hasRunningBackgroundShellWork: () => options.shellWork === true,
  };
  const tm = {
    execution: { canExecute: options.canExecute !== false },
    sessions: {
      activeSession: active,
      liveSessions: new Map<string, unknown>(options.liveSessions ?? []),
      deletedAgentIds: new Set<string>(),
      isAgentGone: (agentId: string) => (options.gone ?? []).includes(agentId),
      resolveBackgroundSession: async (agentId: string) => {
        record("resolveBackgroundSession", agentId);
        if (options.sessionError !== undefined) throw options.sessionError;
        if (options.agentGoneError === true) throw new AgentGoneError("that agent is gone");
        const live = tm.sessions.liveSessions.get(agentId);
        return live ?? fakeSession(agentId);
      },
    },
    sessionStore: {
      listAgentIds: async () => {
        record("listAgentIds");
        return options.agentIds ?? [];
      },
      listAgents: async () => [{ id: "agent-1", name: "Agent one" }],
      markSessionActivity: (target: unknown) => record("markSessionActivity"),
    },
    groupChat: {
      isGroupSession: () => options.group === true,
      isRemoteRoomSession: () => options.remoteRoom === true,
      isRemoteRoomAgentId: () => false,
      isGroupAgentId: () => options.group === true,
      dmPreemptedGroupMemberIds: new Set<string>(),
    },
    runnerRegistry: {
      runners: new Map<string, unknown>([["agent-1", runner]]),
      getRunner: (target: unknown) => {
        record("getRunner");
        return runner;
      },
    },
    runLifecycle: {
      lastRequestIdBySession: new Map<string, string>([["agent-1", "req-3"]]),
      runningAgentIds: () => new Set<string>(options.running ?? []),
      beginSessionRun: (target: unknown) => record("beginSessionRun"),
      endSessionRun: (target: unknown) => record("endSessionRun"),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => {
        record("enqueueExclusiveRun", meta);
        return await work();
      },
    },
    turnRuntime: {
      activeRequestPrompts: new Map<string, string>([["agent-1", "old"]]),
      activeRequestSources: new Map<string, string>(),
    },
    widgetResponses: {
      collectUnansweredQuestionPrompts: (target: unknown) => {
        record("collectUnanswered");
        return options.unanswered ?? { skippedQuestionPrompts: [], dismissedQuestionPrompts: [] };
      },
    },
    automationRuntime: { ensureHiddenTurnReply: async (target: unknown) => { record("ensureHiddenTurnReply"); return options.ensureReply !== false; } },
    roster: { emitAgentUpdate: async (id: string) => record("emitAgentUpdate", id) },
    telemetry: { reportAgentError: (report: unknown) => record("reportAgentError", report) },
    productAnalytics: { trackEvent: (name: string, properties: unknown) => record("trackEvent", name) },
    trayErrors: { pushError: (error: unknown) => record("pushError", error) },
    channelDelivery: async (agentId: string, addressToken: string, outbound: unknown) => {
      record("channelDelivery", agentId, addressToken, outbound);
      if (options.deliveryError !== undefined) throw options.deliveryError;
    },
    channelActivity: (agentId: string, address: string, isActive: boolean) => record("channelActivity", address, isActive),
    pendingWakes: {
      enqueuePendingWake: (queue: unknown, agentId: string, items: unknown[]) => {
        record("enqueuePendingWake", agentId);
        if (options.enqueueAccepted === false) return false;
        const map = queue as Map<string, unknown[]>;
        map.set(agentId, [...(map.get(agentId) ?? []), ...items]);
        return true;
      },
    },
    appendEntry: (entry: Record<string, unknown>) => {
      record("appendEntry", entry);
      setTranscript([...getTranscript(), entry as never]);
    },
  };
  const wakes = new BackgroundWakes(tm);
  return {
    wakes, tm, runner, calls, active,
    named: (name: string) => calls.filter((call) => call.name === name),
    lastRun: () => calls.filter((call) => call.name === "run").at(-1)?.args ?? null,
  };
}

describe("what this layer shares with the machinery under it", () => {
  it("names the channels an envelope came from without repeating one", () => {
    assert.deepEqual(
      distinctChannelAddresses([envelopeOf(), envelopeOf({ address: { platform: "slack", chat: "C2" } }), envelopeOf()]),
      ["slack:C1", "slack:C2"],
    );
  });

  it("hands its own sub-modules the same queues, so one of them sees what the other queued", () => {
    const world1 = world();
    assert.equal(world1.wakes.pendingSubagentCompletions, world1.wakes.completionRevivals.pendingSubagentCompletions);
    assert.equal(world1.wakes.pendingShellCompletions, world1.wakes.completionRevivals.pendingShellCompletions);
    assert.equal(world1.wakes.revivingSubagentAgentIds, world1.wakes.completionRevivals.revivingSubagentAgentIds);
    assert.equal(world1.wakes.revivingShellAgentIds, world1.wakes.completionRevivals.revivingShellAgentIds);
    assert.equal(world1.wakes.pendingAgentInbound, world1.wakes.agentToAgent.pendingAgentInbound);
  });

  it("passes the completions and the messages between agents straight through", async () => {
    const world1 = world({ canExecute: false });
    world1.wakes.handleBackgroundSubagentCompletion({ parentAgentId: "agent-1", subagentAgentId: "sub-1", subagentType: "generalPurpose", title: "t", status: "success", result: "r" } as never);
    assert.equal(world1.wakes.pendingSubagentCompletions.get("agent-1")?.length, 1);
    world1.wakes.handleBackgroundShellCompletion({ agentId: "agent-1", shellId: "sh-1", title: "t", status: "success" } as never);
    assert.equal(world1.wakes.pendingShellCompletions.get("agent-1")?.length, 1);
    assert.equal(typeof (await world1.wakes.sendToAgent("sender", "agent-1", "hello")), "string");
    assert.equal(world1.wakes.pendingAgentInbound.get("agent-1")?.length, 1);
    // Reviving is the sub-module's, and answers the same way (nothing to do without a runner).
    await world1.wakes.reviveForSubagentCompletions("agent-1");
    await world1.wakes.reviveForShellCompletions("agent-1");
    assert.equal(world1.named("run").length, 0);
  });
});

describe("delivering what the agent says into a channel", () => {
  it("sends a message the channel can carry, and says nothing when it cannot", async () => {
    const world1 = world({ activeSession: fakeSession("agent-1") });
    world1.wakes.deliverToChannel({ id: "agent-1" }, { type: "text", content: "hi there" }, "slack:C1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world1.named("channelDelivery")[0]?.args, ["agent-1", "slack:C1", { kind: "text", text: "hi there" }]);
    // A message with nothing a channel can carry is not sent at all.
    const empty = world({ activeSession: fakeSession("agent-1") });
    empty.wakes.deliverToChannel({ id: "agent-1" }, { type: "text", content: "" }, "slack:C1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(empty.named("channelDelivery").length, 0);
    // A delivery with no conversation of its own goes out under the one on screen.
    const onScreen = world({ activeSession: fakeSession("agent-1") });
    onScreen.wakes.deliverToChannel(null, { type: "text", content: "hi" }, "slack:C1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(onScreen.named("channelDelivery")[0]?.args.slice(0, 2), ["agent-1", "slack:C1"]);
    // And nothing is sent for a conversation nobody can name.
    const nameless = world();
    nameless.wakes.deliverToChannel(null, { type: "text", content: "hi" }, "slack:C1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nameless.named("channelDelivery").length, 0);
  });

  it("tells the user and wakes the agent when a delivery fails", async () => {
    const world1 = world({ activeSession: fakeSession("agent-1"), deliveryError: new Error("the channel refused it") });
    world1.wakes.deliverToChannel({ id: "agent-1" }, { type: "text", content: "hi there" }, "slack:C1");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const pushed = world1.named("pushError")[0]?.args[0] as Record<string, unknown>;
    assert.equal(pushed.title, "Message not delivered");
    assert.equal(typeof pushed.detail, "string");
    assert.equal(String(pushed.detail).length > 0, true);
    // The failure was queued and the wake it starts was run under its own source.
    assert.equal(world1.wakes.pendingChannelFailures.size, 0);
    assert.equal(world1.named("run").length, 1);
    assert.deepEqual(world1.named("enqueueExclusiveRun")[0]?.args[0], { lane: "background", source: "channel-failure" });
    assert.equal(world1.tm.turnRuntime.activeRequestSources.get("agent-1"), "connector");
    assert.match(String(world1.lastRun()?.[0]), /could not|not delivered|refused|reach/i);
    assert.deepEqual((world1.lastRun()?.[1] as { hidden: boolean }).hidden, true);
  });

  it("keeps the failures that could not be woken for, and tries them again first", async () => {
    // A wake that cannot run (nothing to execute) leaves what it was given where it was, in front of anything newer.
    const blocked = world({ canExecute: false });
    blocked.wakes.queueChannelDeliveryFailure("agent-1", { addressToken: "slack:C1", reason: "first" });
    assert.equal(blocked.wakes.pendingChannelFailures.get("agent-1")?.length, 1);
    assert.equal(blocked.named("run").length, 0);
    // A queue that is not accepted at all does not even try.
    const refused = world({ enqueueAccepted: false });
    refused.wakes.queueChannelDeliveryFailure("agent-1", { addressToken: "slack:C1", reason: "first" });
    assert.equal(refused.wakes.pendingChannelFailures.size, 0);
    assert.equal(refused.named("getRunner").length, 0);
    // Nothing to wake for, nothing that can run, a conversation that is gone (which is owed nothing back) and one
    // that cannot be opened (which is).
    assert.equal(await blocked.wakes.runChannelFailureWake("agent-1", []), true);
    const cannotRun = world({ canExecute: false });
    assert.equal(await cannotRun.wakes.runChannelFailureWake("agent-1", [{ addressToken: "slack:C1", reason: "x" }]), false);
    const gone = world({ agentGoneError: true });
    assert.equal(await gone.wakes.runChannelFailureWake("agent-1", [{ addressToken: "slack:C1", reason: "x" }]), true);
    const unopenable = world({ sessionError: new Error("no session") });
    assert.equal(await unopenable.wakes.runChannelFailureWake("agent-1", [{ addressToken: "slack:C1", reason: "x" }]), false);
    // Driven through the queue, the failure it could not wake for is put back in front of anything newer.
    const retried = world({ sessionError: new Error("no session") });
    retried.wakes.queueChannelDeliveryFailure("agent-1", { addressToken: "slack:C1", reason: "first" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((retried.wakes.pendingChannelFailures.get("agent-1") ?? []).map((failure) => (failure as { reason: string }).reason), ["first"]);
    assert.equal(retried.named("run").length, 0);
  });
});

describe("waking a conversation for a channel message", () => {
  it("writes what arrived into the conversation and runs a hidden turn about it", async () => {
    const session = fakeSession("agent-1");
    const world1 = world({ activeSession: session, liveSessions: [["agent-1", session]], unanswered: { skippedQuestionPrompts: ["q1"], dismissedQuestionPrompts: [] } });
    world1.wakes.wakeForInbound("agent-1", envelopeOf());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    // The message is in the conversation, from the channel it came from.
    const entry = getTranscript()[0] as Record<string, unknown>;
    assert.deepEqual([entry.kind, entry.role, entry.content, entry.channel, entry.channelSender], ["message", "user", "hello there", "slack:C1", "octocat"]);
    // The turn is hidden, carries the questions nobody answered, and is sourced to the connector.
    const [prompt, runOptions] = world1.lastRun() as [string, Record<string, unknown>];
    assert.equal(typeof prompt, "string");
    assert.equal(String(prompt).length > 0, true);
    assert.deepEqual([runOptions.hidden, (runOptions.skippedQuestionPrompts as string[])[0]], [true, "q1"]);
    assert.deepEqual(runOptions.selectedImages, []);
    assert.equal(world1.tm.turnRuntime.activeRequestPrompts.has("agent-1"), false);
    assert.equal(world1.tm.turnRuntime.activeRequestSources.get("agent-1"), "connector");
    // The channel is shown as busy while the turn runs, and idle again afterwards.
    assert.deepEqual(world1.named("channelActivity").map((call) => call.args), [["slack:C1", true], ["slack:C1", false]]);
    assert.equal(world1.named("endSessionRun").length, 1);
  });

  it("keeps a message that was not shown out of the conversation, and does not wake a room at all", async () => {
    const session = fakeSession("agent-1");
    const world1 = world({ activeSession: session, liveSessions: [["agent-1", session]] });
    // A message the platform already displayed is not written in again, and one that arrives while a turn is running is
    // only asked to be shown once.
    world1.wakes.wakeForInbound("agent-1", envelopeOf({ isDisplayed: true }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(world1.named("appendEntry").length, 0);
    assert.equal(world1.named("run").length, 1);
    const group = world({ group: true, liveSessions: [["agent-1", fakeSession("agent-1")]] });
    group.wakes.wakeForInbound("agent-1", envelopeOf());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(group.named("run").length, 0);
    const room = world({ remoteRoom: true, liveSessions: [["agent-1", fakeSession("agent-1")]] });
    room.wakes.wakeForInbound("agent-1", envelopeOf());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(room.named("run").length, 0);
  });

  it("asks for a hidden reply when a channel message produced none", async () => {
    const world1 = world({ liveSessions: [["agent-1", fakeSession("agent-1")]], runResult: { sentMessageCount: 0, reacted: false, aborted: false } });
    world1.wakes.wakeForInbound("agent-1", envelopeOf());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(world1.named("ensureHiddenTurnReply").length, 1);
  });

  it("writes to a conversation that is not on screen on its own entries, and reports a wake that failed", async () => {
    const side = fakeSession("agent-2");
    const world1 = world({ activeSession: fakeSession("agent-1"), liveSessions: [["agent-2", side]], runError: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    world1.wakes.wakeForInbound("agent-2", envelopeOf());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(world1.named("appendEntry").length, 0);
    assert.equal((side.db.getTranscriptEntries()[0] as Record<string, unknown>).content, "hello there");
    assert.equal(world1.named("markSessionActivity").length, 1);
    const report = world1.named("reportAgentError")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.source, report.conversationId, report.requestId], ["connector", "agent-2", undefined]);
    assert.deepEqual(report.error, { code: SlateError.streamReset()["code"], connectCode: undefined, errno: "ECONNRESET" });
    assert.equal((world1.named("pushError")[0]?.args[0] as Record<string, unknown>).title, "Channel message follow-up failed");
    assert.equal(world1.named("endSessionRun").length, 1);
  });
});

describe("broadcasts and timeline events", () => {
  it("sends a broadcast to the conversations that can take one, and counts what it scheduled", async () => {
    const world1 = world({ liveSessions: [["agent-1", fakeSession("agent-1")], ["agent-2", fakeSession("agent-2")]], agentIds: ["agent-1", "agent-2", "agent-2"] });
    // Asking for everyone asks the roster, and an explicit list is not asked twice for the same agent.
    // "all" takes the roster as the roster gives it, repeated entries included.
    assert.deepEqual(await world1.wakes.broadcastToAgents("all", "  a broadcast  "), { total: 3, scheduled: 3 });
    assert.equal(world1.named("listAgentIds").length, 1);
    // A list the caller named is deduplicated before anything is scheduled.
    const explicit = world({ liveSessions: [["agent-1", fakeSession("agent-1")], ["agent-2", fakeSession("agent-2")]] });
    assert.deepEqual(await explicit.wakes.broadcastToAgents(["agent-1", "agent-1", "agent-2"], "a broadcast"), { total: 2, scheduled: 2 });
    // Nothing to say, or nothing that can run, schedules nothing at all.
    assert.deepEqual(await explicit.wakes.broadcastToAgents("all", "   "), { total: 0, scheduled: 0 });
    // A platform that cannot run turns schedules nothing, even for conversations it could name.
    const cannotRun = world({ canExecute: false, agentIds: ["agent-1"], liveSessions: [["agent-1", fakeSession("agent-1")]] });
    assert.deepEqual(await cannotRun.wakes.broadcastToAgents("all", "a broadcast"), { total: 0, scheduled: 0 });
    // A conversation that is gone, cannot be opened, or is a room is not scheduled for.
    const gone = world({ gone: ["agent-1"] });
    assert.equal(await gone.wakes.scheduleBroadcast("agent-1", "a broadcast"), false);
    const unopenable = world({ sessionError: new Error("no session") });
    assert.equal(await unopenable.wakes.scheduleBroadcast("agent-1", "a broadcast"), false);
    const room = world({ remoteRoom: true, liveSessions: [["agent-1", fakeSession("agent-1")]] });
    assert.equal(await room.wakes.scheduleBroadcast("agent-1", "a broadcast"), false);
  });

  it("asks for a hidden reply when a broadcast reached nobody, and shows a failure", async () => {
    const silent = world({ liveSessions: [["agent-1", fakeSession("agent-1")]], runResult: { sentMessageCount: 0, reacted: false, aborted: false } });
    assert.equal(await silent.wakes.scheduleBroadcast("agent-1", "a broadcast"), true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(silent.named("ensureHiddenTurnReply").length, 1);
    assert.deepEqual(silent.named("enqueueExclusiveRun")[0]?.args[0], { lane: "background", source: "broadcast" });
    assert.equal(typeof silent.lastRun()?.[0], "string");
    const failed = world({ liveSessions: [["agent-1", fakeSession("agent-1")]], runError: new Error("the box is gone") });
    await failed.wakes.scheduleBroadcast("agent-1", "a broadcast");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((failed.named("pushError")[0]?.args[0] as Record<string, unknown>).title, "Broadcast message failed");
  });

  it("records a timeline event in the conversation, and only wakes an idle agent for it", async () => {
    const session = fakeSession("agent-1");
    const world1 = world({ activeSession: session, liveSessions: [["agent-1", session]], running: ["agent-1"] });
    world1.wakes.emitTimelineEvent("agent-1", { kind: "build-finished", ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const entry = world1.named("appendEntry")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([entry.kind, (entry.id as string).startsWith("event-")], ["event", true]);
    assert.deepEqual(entry.event, { kind: "build-finished", ok: true });
    // Nobody is idle here, so the event was recorded without a wake.
    assert.equal(world1.named("run").length, 0);
    // An idle agent is woken for it, under its own source and with silence allowed.
    const idle = world({ liveSessions: [["agent-1", fakeSession("agent-1")]] });
    idle.wakes.emitTimelineEvent("agent-1", { kind: "build-finished" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(idle.named("run").length, 1);
    assert.deepEqual([(idle.lastRun()?.[1] as { hidden: boolean; isSilenceAllowed: boolean }).hidden, (idle.lastRun()?.[1] as { isSilenceAllowed: boolean }).isSilenceAllowed], [true, true]);
    assert.equal(idle.tm.turnRuntime.activeRequestSources.get("agent-1"), "event");
    // An agent that is gone, or a group, is not recorded for at all.
    const gone = world({ gone: ["agent-1"] });
    gone.wakes.emitTimelineEvent("agent-1", { kind: "build-finished" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gone.calls.length, 0);
    const group = world({ group: true, liveSessions: [["agent-1", fakeSession("agent-1")]] });
    await group.wakes.recordTimelineEvent("agent-1", { kind: "build-finished" });
    assert.equal(group.named("run").length, 0);
    assert.equal(group.named("appendEntry").length, 0);
    // The wake itself refuses a group as well, whatever led to it being asked.
    await group.wakes.runEventWake("agent-1", [{ kind: "build-finished" }]);
    assert.equal(group.named("run").length, 0);
  });

  it("does not let an event wake that failed stop the ones behind it", async () => {
    const session = fakeSession("agent-1");
    const world1 = world({ liveSessions: [["agent-1", session]], runError: new Error("the turn broke") });
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(String(args[0]));
    };
    try {
      world1.wakes.queueEventWake("agent-1", { kind: "one" });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = originalError;
    }
    // The wake reported its failure through the tray (the run helper catches it), and the revival finished cleanly.
    assert.equal(world1.wakes.revivingEventAgentIds.size, 0);
    assert.equal(world1.named("pushError").length, 1);
    assert.equal(logged.length, 0);
  });

  it("says whether anything is still running a background command", () => {
    assert.equal(world({ shellWork: true }).wakes.hasRunningBackgroundShellWork(), true);
    assert.equal(world().wakes.hasRunningBackgroundShellWork(), false);
  });
});
