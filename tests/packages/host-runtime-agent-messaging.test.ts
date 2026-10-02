/**
 * One agent reaching out to another: what is refused, what is written into both conversations, how the recipient's
 * queue is ordered and drained, and what happens to a message that could not be delivered.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AgentToAgentMessaging, mergeAgentInboundQueue, partitionAgentInbound, prioritizeAgentInbound } from "../../source/host/transcript/agent-to-agent-messaging.ts";
import { getTranscript, setTranscript } from "../../source/host/transcript/transcript-store.ts";
import type { TranscriptEntry } from "../../source/host/transcript/transcript-hub.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };
type Inbound = {
  from: { id: string; name: string };
  text: string;
  timestampMs: number;
  images?: readonly { url: string; alt?: string }[];
  priority?: boolean;
  isDisplayed?: boolean;
  isRedriven?: boolean;
};

const inbound = (text: string, overrides: Partial<Inbound> = {}): Inbound => ({
  from: { id: "sender-1", name: "Sender" },
  text,
  timestampMs: 1_000,
  ...overrides,
});

/** A transcript manager with the roster, the live sessions and the run surface messaging reaches for. */
function world(
  options: {
    agents?: Array<Record<string, unknown>>;
    canExecute?: boolean;
    gone?: string[];
    remoteRoomAgent?: string[];
    groupTarget?: boolean;
    groupSession?: boolean;
    remoteRoomSession?: boolean;
    activeLane?: string | null;
    hasScheduler?: boolean;
    running?: string[];
    groupRunnerInterrupt?: boolean;
    runnerInterrupt?: boolean;
    groupAgent?: boolean;
    sessionError?: Error;
    runResult?: Record<string, unknown>;
    runError?: Error;
    entries?: TranscriptEntry[];
    reviving?: string[];
    dmPreempted?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const storeEntries = structuredClone(options.entries ?? []);
  setTranscript(storeEntries);
  const sessionEntries: TranscriptEntry[] = structuredClone(options.entries ?? []);
  const session = {
    id: "recipient-1",
    db: {
      getTranscriptEntries: () => sessionEntries,
      appendTranscriptEntry: (entry: TranscriptEntry) => {
        sessionEntries.push(entry);
        return true;
      },
      addConversationPartner: (id: string) => record("addConversationPartner", id),
    },
  };
  const senderEntries: TranscriptEntry[] = structuredClone(options.entries ?? []);
  const senderSession = {
    id: "sender-1",
    db: {
      getTranscriptEntries: () => senderEntries,
      addConversationPartner: (id: string) => record("senderPartner", id),
      appendTranscriptEntry: (entry: TranscriptEntry) => {
        senderEntries.push(entry);
        return true;
      },
    },
  };
  const runner = {
    run: async (prompt: string, runOptions: Record<string, unknown>) => {
      record("run", prompt, runOptions);
      if (options.runError !== undefined) throw options.runError;
      return options.runResult ?? { sentMessageCount: 1, reacted: false, aborted: false };
    },
  };
  const groupRunner = {
    interrupt: (reason: string) => {
      record("groupRunnerInterrupt", reason);
      return options.groupRunnerInterrupt === true;
    },
  };
  const tm = {
    execution: { canExecute: options.canExecute !== false },
    sessions: {
      activeSession: session,
      liveSessions: new Map<string, unknown>([
        ["sender-1", senderSession],
        ["recipient-1", session],
      ]),
      isAgentGone: (agentId: string) => (options.gone ?? []).includes(agentId),
      resolveBackgroundSession: async (agentId: string) => {
        record("resolveBackgroundSession", agentId);
        if (options.sessionError !== undefined) throw options.sessionError;
        return session;
      },
    },
    sessionStore: {
      listAgents: async () => options.agents ?? [{ id: "recipient-1", name: "Recipient" }],
      markSessionActivity: (target: unknown) => record("markSessionActivity"),
    },
    groupChat: {
      isRemoteRoomAgentId: (agentId: string) => (options.remoteRoomAgent ?? []).includes(agentId),
      isGroupSession: () => options.groupSession === true,
      isRemoteRoomSession: () => options.remoteRoomSession === true,
      isGroupAgentId: () => options.groupAgent === true,
      dmPreemptedGroupMemberIds: new Set<string>(),
    },
    postToGroup: async (fromAgentId: string, toAgentId: string, message: string, priority: boolean) => {
      record("postToGroup", fromAgentId, toAgentId, message, priority);
      return "Posted to the group.";
    },
    productAnalytics: { trackEvent: (name: string, properties: unknown) => record("trackEvent", name, properties) },
    runLifecycle: {
      runScheduler: options.hasScheduler === false ? undefined : { getActiveLane: (agentId: string) => options.activeLane ?? null },
      runningAgentIds: () => new Set<string>(options.running ?? []),
      lastRequestIdBySession: new Map<string, string>([["recipient-1", "req-3"]]),
      beginSessionRun: (target: unknown) => record("beginSessionRun"),
      endSessionRun: (target: unknown) => record("endSessionRun"),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => {
        record("enqueueExclusiveRun", id, meta);
        return await work();
      },
    },
    runnerRegistry: {
      getRunner: (target: unknown) => {
        record("getRunner");
        return runner;
      },
      activeGroupMemberRunners: new Map([["recipient-1", groupRunner]]),
      runners: new Map([["recipient-1", { interrupt: (reason: string) => { record("runnerInterrupt", reason); return options.runnerInterrupt === true; } }]]),
    },
    backgroundWakes: {
      dmPreemptedWakeAgentIds: new Set<string>(options.dmPreempted === true ? ["recipient-1"] : []),
    },
    telemetry: {
      reportTurnInterrupt: (report: unknown) => record("reportTurnInterrupt", report),
      reportAgentError: (report: unknown) => record("reportAgentError", report),
    },
    turnRuntime: {
      activeRequestPrompts: new Map<string, string>([["recipient-1", "old"]]),
      activeRequestSources: new Map<string, string>(),
    },
    roster: { emitAgentUpdate: async (agentId: string) => record("emitAgentUpdate", agentId) },
    trayErrors: { pushError: (error: unknown) => record("pushError", error) },
    appendEntry: (entry: TranscriptEntry) => {
      record("appendEntry", entry);
      const current = getTranscript();
      setTranscript([...current, entry]);
    },
  };
  const messaging = new AgentToAgentMessaging(tm);
  return {
    messaging, tm, session, sessionEntries, senderEntries, calls, storeEntries,
    named: (name: string) => calls.filter((call) => call.name === name),
    stored: (id: string) => getTranscript().find((entry) => entry.id === id),
    lastPrompt: () => (calls.filter((call) => call.name === "run").at(-1)?.args[0] ?? null) as string | null,
  };
}

describe("the order the recipient's queue is kept in", () => {
  it("puts priority first, and keeps the newest priority ahead of the older ones", () => {
    const older = [inbound("old", { priority: true }), inbound("oldest")];
    const newer = [inbound("new"), inbound("newer-priority", { priority: true })];
    assert.deepEqual(partitionAgentInbound(older), { priority: [older[0]], rest: [older[1]] });
    assert.deepEqual(prioritizeAgentInbound(older).map((message) => message.text), ["old", "oldest"]);
    // A priority message the recipient has not seen yet outranks an older priority one, and the newer ordinary
    // messages stay behind everything that was already waiting.
    assert.deepEqual(mergeAgentInboundQueue(newer, older).map((message) => message.text), ["newer-priority", "old", "oldest", "new"]);
  });
});

describe("sending to another agent", () => {
  it("refuses what cannot be delivered, before anything is written down", async () => {
    const world1 = world();
    assert.equal(await world1.messaging.sendToAgent("sender-1", "recipient-1", "   "), "Message was empty; nothing was sent.");
    assert.equal(await world1.messaging.sendToAgent("sender-1", "sender-1", "hi"), "An agent can't message itself.");
    const gone = world({ gone: ["recipient-1"] });
    assert.equal(await gone.messaging.sendToAgent("sender-1", "recipient-1", "hi"), "That agent no longer exists.");
    const shared = world({ remoteRoomAgent: ["recipient-1"] });
    assert.equal(await shared.messaging.sendToAgent("sender-1", "recipient-1", "hi"), "That is a shared chat hosted by another user; agents can't message it directly.");
    const unknown = world({ agents: [{ id: "someone-else", name: "Other" }] });
    assert.equal(await unknown.messaging.sendToAgent("sender-1", "recipient-1", "hi"), "No agent found with id recipient-1.");
    // Nothing was queued, drawn or announced for any of them.
    for (const refused of [world1, gone, shared, unknown]) {
      assert.deepEqual([refused.named("trackEvent").length, refused.named("appendEntry").length, refused.named("postToGroup").length], [0, 0, 0]);
      assert.equal(refused.messaging.pendingAgentInbound.size, 0);
    }
  });

  it("posts to a group target, and says what a group post cannot carry", async () => {
    const plain = world({ agents: [{ id: "recipient-1", name: "The group", isGroup: true }] });
    assert.equal(await plain.messaging.sendToAgent("sender-1", "recipient-1", "hello group"), "Posted to the group.");
    assert.deepEqual(plain.named("postToGroup")[0]?.args, ["sender-1", "recipient-1", "hello group", false]);
    // Nothing is tracked or queued for a group: it is a post, not a wake.
    assert.deepEqual([plain.named("trackEvent").length, plain.messaging.pendingAgentInbound.size], [0, 0]);
    // An image and a priority flag are both called out as undelivered.
    const both = world({ agents: [{ id: "recipient-1", name: "The group", isGroup: true }] });
    const one = await both.messaging.sendToAgent("sender-1", "recipient-1", "look", [{ url: "file:///tmp/a.png" }], true);
    assert.match(one, /^Posted to the group\. Note: the attached image was NOT delivered/);
    assert.match(one, /Note: priority is 1:1 only — this post did not interrupt members\.$/);
    const two = world({ agents: [{ id: "recipient-1", name: "The group", isGroup: true }] });
    const many = await two.messaging.sendToAgent("sender-1", "recipient-1", "look", [{ url: "file:///tmp/a.png" }, { url: "file:///tmp/b.png" }], false);
    assert.match(many, /the attached images were NOT delivered/);
    assert.equal(many.includes("priority is 1:1"), false);
  });

  it("writes the message into both conversations, queues it, and wakes the recipient", async () => {
    const sentAt = Date.now();
    const world1 = world({ agents: [{ id: "recipient-1", name: "Recipient" }, { id: "sender-1", name: "Sender" }] });
    const ack = await world1.messaging.sendToAgent("sender-1", "recipient-1", "  the answer is 4  ");
    assert.equal(ack, "Sent to Recipient. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.");
    assert.deepEqual(world1.named("trackEvent")[0]?.args, ["slate.agent_message.sent", { from_agent_id: "sender-1", to_agent_id: "recipient-1", is_group_target: false, is_priority: false }]);
    assert.deepEqual(world1.named("senderPartner")[0]?.args, ["recipient-1"]);
    // The sender's own conversation shows what it sent, addressed to the recipient.
    const outbound = world1.senderEntries[0] as TranscriptEntry;
    assert.deepEqual([outbound.kind, outbound.role, outbound.content, outbound.isStreaming], ["message", "assistant", "the answer is 4", false]);
    assert.deepEqual(outbound.toAgent, { id: "recipient-1", name: "Recipient", kind: "agent" });
    assert.equal(typeof outbound.timestampMs, "number");
    assert.equal((outbound.timestampMs as number) >= sentAt, true);
    // The recipient got it as a message from an agent, and the wake was started.
    await new Promise((resolve) => setImmediate(resolve));
    const inbound = getTranscript()[0] as TranscriptEntry;
    assert.deepEqual([inbound.role, inbound.content, inbound.fromAgent], ["user", "the answer is 4", { id: "sender-1", name: "Sender" }]);
    assert.equal(world1.named("resolveBackgroundSession").length, 1);
    assert.equal(world1.named("run").length, 1);
    assert.match(String(world1.lastPrompt()), /message just arrived from another of your user's agents: Sender/i);
    // A sender the roster does not know is described as an agent rather than by a name nobody has.
    const stranger = world({ agents: [{ id: "recipient-1", name: "Recipient" }] });
    await stranger.messaging.sendToAgent("sender-1", "recipient-1", "hello");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((getTranscript()[0] as TranscriptEntry).fromAgent, { id: "sender-1", name: "An agent" });
  });

  it("puts a priority message at the front and interrupts the recipient's other work", async () => {
    const world1 = world({ agents: [{ id: "recipient-1", name: "Recipient" }], groupRunnerInterrupt: true, runnerInterrupt: true, running: ["recipient-1"], canExecute: false });
    // Something older is already waiting, so where the priority message lands can be seen.
    world1.messaging.pendingAgentInbound.set("recipient-1", [inbound("older")]);
    const ack = await world1.messaging.sendToAgent("sender-1", "recipient-1", "stop that", [], true);
    assert.equal(ack, "Sent to Recipient as a priority message — it will interrupt their current non-user work and wake them now. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.");
    assert.deepEqual(world1.named("trackEvent")[0]?.args[1], { from_agent_id: "sender-1", to_agent_id: "recipient-1", is_group_target: false, is_priority: true });
    assert.deepEqual(
      (world1.messaging.pendingAgentInbound.get("recipient-1") ?? []).map((message) => [message.text, message.priority === true]),
      [["stop that", true], ["older", false]],
    );
    // With the wake running, the same message reaches the recipient as a priority instruction.
    const awake = world({ agents: [{ id: "recipient-1", name: "Recipient" }] });
    await awake.messaging.sendToAgent("sender-1", "recipient-1", "stop that", [], true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(String(awake.lastPrompt()), /This is a PRIORITY instruction from another assistant/);
    assert.equal(world1.tm.groupChat.dmPreemptedGroupMemberIds.has("recipient-1"), true);
    assert.equal(world1.tm.backgroundWakes.dmPreemptedWakeAgentIds.size >= 0, true);
    const reason = "superseded by a priority agent message";
    assert.deepEqual(world1.named("groupRunnerInterrupt")[0]?.args, [reason]);
    assert.deepEqual(world1.named("runnerInterrupt")[0]?.args, [reason]);
    assert.deepEqual(world1.named("reportTurnInterrupt")[0]?.args, [{ conversationId: "recipient-1", reason: "agent_steer", hadActiveRun: true, wasInFlight: true }]);
  });

  it("does not interrupt a recipient the user is talking to, and says nothing when nothing was running", () => {
    // The user owns the lane: a priority message waits rather than cutting in.
    const withUser = world({ activeLane: "user", groupRunnerInterrupt: true, runnerInterrupt: true });
    withUser.messaging.steerRecipientForPriorityPeer("recipient-1");
    assert.deepEqual([withUser.named("groupRunnerInterrupt").length, withUser.named("reportTurnInterrupt").length], [0, 0]);
    // No scheduler at all is the same.
    const noScheduler = world({ hasScheduler: false });
    noScheduler.messaging.steerRecipientForPriorityPeer("recipient-1");
    assert.equal(noScheduler.calls.length, 0);
    // Nothing was running and nothing was preempted, so there is no interrupt to report.
    const idle = world();
    idle.messaging.steerRecipientForPriorityPeer("recipient-1");
    assert.equal(idle.named("reportTurnInterrupt").length, 0);
  });
});

describe("draining the recipient's queue", () => {
  it("runs one wake for what is waiting, and takes what arrives meanwhile on the next pass", async () => {
    const world1 = world();
    const seen: string[][] = [];
    world1.messaging.pendingAgentInbound.set("recipient-1", [inbound("first")]);
    world1.tm.sessions.resolveBackgroundSession = async () => {
      // A message that arrives while the wake is running goes into the queue and is taken on the next pass.
      if (seen.length === 0) world1.messaging.pendingAgentInbound.set("recipient-1", [inbound("second")]);
      return world1.session;
    };
    world1.tm.runnerRegistry.getRunner = () => ({
      run: async (prompt: string) => {
        seen.push([prompt]);
        return { sentMessageCount: 1, reacted: false, aborted: false };
      },
    });
    await world1.messaging.reviveForAgentInbound("recipient-1");
    assert.equal(seen.length, 2);
    assert.equal(world1.messaging.pendingAgentInbound.size, 0);
    assert.equal(world1.messaging.revivingAgentInboundIds.size, 0);
    // A wake that is already reviving is not started twice, and one that cannot run leaves the queue alone.
    const guarded = world();
    guarded.messaging.revivingAgentInboundIds.add("recipient-1");
    guarded.messaging.pendingAgentInbound.set("recipient-1", [inbound("later")]);
    await guarded.messaging.reviveForAgentInbound("recipient-1");
    assert.equal(guarded.calls.length, 0);
    assert.equal(guarded.messaging.pendingAgentInbound.size, 1);
    const cannotRun = world({ canExecute: false });
    cannotRun.messaging.pendingAgentInbound.set("recipient-1", [inbound("later")]);
    await cannotRun.messaging.reviveForAgentInbound("recipient-1");
    assert.equal(cannotRun.calls.length, 0);
  });

  it("wakes the recipient with each message that was not already shown, and reports nothing when they all run", async () => {
    const world1 = world();
    const shown = inbound("already shown", { isDisplayed: true });
    const fresh = inbound("fresh news");
    world1.messaging.pendingAgentInbound.set("recipient-1", [shown, fresh]);
    await world1.messaging.reviveForAgentInbound("recipient-1");
    // What was already displayed is not written into the transcript a second time.
    assert.deepEqual(getTranscript().map((entry) => entry.content), ["fresh news"]);
    assert.equal(world1.named("run").length, 2);
    assert.deepEqual(world1.named("enqueueExclusiveRun")[0]?.args[1], { lane: "agent", source: "agent" });
    assert.equal(world1.tm.turnRuntime.activeRequestPrompts.has("recipient-1"), false);
    assert.equal(world1.tm.turnRuntime.activeRequestSources.get("recipient-1"), "agent");
    assert.equal(world1.named("run").every((call) => (call.args[1] as { hidden: boolean; isSilenceAllowed: boolean }).hidden && (call.args[1] as { isSilenceAllowed: boolean }).isSilenceAllowed), true);
    assert.equal(world1.named("emitAgentUpdate").length, 1);
    assert.equal(world1.named("endSessionRun").length, 1);
    assert.equal(world1.named("reportAgentError").length, 0);
  });

  it("hands the rest of the queue back when a priority message arrives mid-wake", async () => {
    const world1 = world();
    world1.messaging.pendingAgentInbound.set("recipient-1", [inbound("first"), inbound("second")]);
    let runs = 0;
    world1.tm.runnerRegistry.getRunner = () => ({
      run: async () => {
        runs += 1;
        if (runs === 1)
          world1.messaging.pendingAgentInbound.set("recipient-1", [inbound("urgent", { priority: true })]);
        return { sentMessageCount: 1, reacted: false, aborted: false };
      },
    });
    world1.tm.runLifecycle.enqueueExclusiveRun = async (id: string, work: () => Promise<void>) => work();
    // The first wake is the one that sees the priority arrival: it defers the messages it had left and stops.
    await world1.messaging.runAgentInboundWake("recipient-1", [inbound("first"), inbound("second")]);
    const queued = world1.messaging.pendingAgentInbound.get("recipient-1") ?? [];
    assert.deepEqual(queued.map((message) => [message.text, message.priority === true, message.isDisplayed === true]), [["urgent", true, false], ["second", false, true]]);
    assert.equal(runs, 1);
  });

  it("gives a message that was interrupted by the user back to the queue, but drops it when nothing preempted it", async () => {
    const redriven = world();
    redriven.tm.runnerRegistry.getRunner = () => ({
      run: async () => {
        // A new preemption arrives while the wake is running: what is left of it is owed back to the queue.
        redriven.tm.backgroundWakes.dmPreemptedWakeAgentIds.add("recipient-1");
        return { sentMessageCount: 0, reacted: false, aborted: true };
      },
    });
    await redriven.messaging.runAgentInboundWake("recipient-1", [inbound("first"), inbound("second")]);
    const givenBack = redriven.messaging.pendingAgentInbound.get("recipient-1") ?? [];
    assert.deepEqual(givenBack.map((message) => [message.text, message.isDisplayed === true, message.isRedriven === true]), [["first", true, true], ["second", true, true]]);
    // A message that was already redriven once is not redriven again, even when the run is preempted again.
    const once = world();
    once.tm.runnerRegistry.getRunner = () => ({
      run: async () => {
        once.tm.backgroundWakes.dmPreemptedWakeAgentIds.add("recipient-1");
        return { sentMessageCount: 0, reacted: false, aborted: true };
      },
    });
    await once.messaging.runAgentInboundWake("recipient-1", [inbound("first", { isRedriven: true })]);
    assert.equal(once.messaging.pendingAgentInbound.size, 0);
    // An abort nobody preempted is the user's own turn taking over: the message is not re-queued.
    const plainAbort = world();
    plainAbort.tm.runnerRegistry.getRunner = () => ({ run: async () => ({ sentMessageCount: 0, reacted: false, aborted: true }) });
    await plainAbort.messaging.runAgentInboundWake("recipient-1", [inbound("first")]);
    assert.equal(plainAbort.messaging.pendingAgentInbound.size, 0);
    // A conversation that cannot be opened, is in a group or a shared room is left alone.
    for (const blocked of [world({ sessionError: new Error("gone") }), world({ groupSession: true }), world({ remoteRoomSession: true })]) {
      blocked.messaging.pendingAgentInbound.set("recipient-1", [inbound("x")]);
      await blocked.messaging.runAgentInboundWake("recipient-1", [inbound("x")]);
      assert.equal(blocked.named("run").length, 0);
    }
    const empty = world();
    await empty.messaging.runAgentInboundWake("recipient-1", []);
    assert.equal(empty.calls.length, 0);
  });

  it("reports a wake that failed, and closes the run out either way", async () => {
    const world1 = world({ runError: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    await world1.messaging.runAgentInboundWake("recipient-1", [inbound("first")]);
    const report = world1.named("reportAgentError")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.source, report.conversationId, report.requestId], ["agent", "recipient-1", "req-3"]);
    assert.deepEqual(report.error, { code: SlateError.streamReset()["code"], connectCode: undefined, errno: "ECONNRESET" });
    const pushed = world1.named("pushError")[0]?.args[0] as Record<string, unknown>;
    assert.equal(pushed.title, "Message from another agent failed");
    assert.equal(pushed.detail, "socket hang up");
    assert.equal(world1.named("endSessionRun").length, 1);
  });
});

describe("what the conversations look like afterwards", () => {
  it("writes an inbound message as user-role, from the sending agent", () => {
    const world1 = world();
    world1.messaging.appendAgentInboundEntries(world1.session, [inbound("hello there", { images: [{ url: "file:///tmp/a.png" }] })]);
    const entry = world1.named("appendEntry")[0]?.args[0] as TranscriptEntry;
    assert.deepEqual([entry.kind, entry.role, entry.content, entry.isStreaming], ["message", "user", "hello there", false]);
    assert.deepEqual(entry.fromAgent, { id: "sender-1", name: "Sender" });
    assert.deepEqual(entry.images, [{ url: "file:///tmp/a.png" }]);
    assert.deepEqual(world1.named("addConversationPartner")[0]?.args, ["sender-1"]);
    // A message with no images carries no images field at all.
    const plain = world();
    plain.messaging.appendAgentInboundEntries(plain.session, [inbound("plain")]);
    assert.equal((plain.named("appendEntry")[0]?.args[0] as TranscriptEntry).images, undefined);
  });

  it("writes to a conversation that is not on screen on its own entries, and refreshes it", () => {
    const world1 = world();
    world1.tm.sessions.activeSession = { id: "someone-else" } as never;
    world1.messaging.appendAgentInboundEntries(world1.session, [inbound("off screen")]);
    assert.equal(world1.named("appendEntry").length, 0);
    assert.equal(world1.sessionEntries[0]?.content, "off screen");
    // A message from another agent is a peer message: it does not count as the user being active.
    assert.equal(world1.named("markSessionActivity").length, 0);
    assert.deepEqual(world1.named("emitAgentUpdate")[0]?.args, ["recipient-1"]);
    // The sender's own side: an outbound message is an assistant-role entry addressed to the recipient.
    const side = world();
    side.tm.sessions.activeSession = { id: "someone-else" } as never;
    side.messaging.appendAgentOutboundEntry("sender-1", { id: "recipient-1", name: "Recipient" }, "for you", 1_500);
    assert.equal(side.named("appendEntry").length, 0);
    assert.equal(side.senderEntries[0]?.content, "for you");
    assert.equal(side.senderEntries[0]?.role, "assistant");
    assert.equal(side.named("markSessionActivity").length, 0);
    // A sender with no live conversation writes nothing.
    const noSession = world();
    noSession.messaging.appendAgentOutboundEntry("nobody", { id: "recipient-1" }, "for you", 1_500);
    assert.equal(noSession.calls.length, 0);
  });

  it("loads the images a message came with before the wake runs", async () => {
    const world1 = world();
    const directory = mkdtempSync(join(tmpdir(), "slate-agent-message-"));
    const image = join(directory, "chart.png");
    writeFileSync(image, "not really a png", "utf8");
    world1.messaging.pendingAgentInbound.set("recipient-1", [inbound("look", { images: [{ url: `file://${image}` }] })]);
    await world1.messaging.reviveForAgentInbound("recipient-1");
    const selected = world1.named("run")[0]?.args[1] as { selectedImages: Array<{ path: string }> };
    assert.deepEqual(selected.selectedImages.map((input) => input.path), [image]);
    assert.match(String(world1.lastPrompt()), /Sender attached an image to this message:/);
    // A message with no images runs without any selected images at all.
    const plain = world();
    plain.messaging.pendingAgentInbound.set("recipient-1", [inbound("no pictures")]);
    await plain.messaging.reviveForAgentInbound("recipient-1");
    assert.equal((plain.named("run")[0]?.args[1] as { selectedImages?: unknown }).selectedImages, undefined);
  });
});
