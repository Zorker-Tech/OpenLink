import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentToAgentMessaging,
  mergeAgentInboundQueue,
  partitionAgentInbound,
  prioritizeAgentInbound,
} from "../../source/host/transcript/agent-to-agent-messaging.ts";

describe("queueing what one agent says to another", () => {
  it("splits a queue into priority and ordinary messages", () => {
    const messages = [{ id: "a", priority: true }, { id: "b" }, { id: "c", priority: false }];
    assert.deepEqual(partitionAgentInbound(messages), { priority: [messages[0]], rest: [messages[1], messages[2]] });
    assert.deepEqual(prioritizeAgentInbound(messages).map((message) => message.id), ["a", "b", "c"]);
  });

  it("merges a new queue ahead of an old one, keeping both priority orders", () => {
    const merged = mergeAgentInboundQueue([{ id: "q1" }, { id: "q2", priority: true }], [{ id: "d1", priority: true }, { id: "d2" }]);
    assert.deepEqual(merged.map((message) => message.id), ["q2", "d1", "d2", "q1"]);
    assert.deepEqual(mergeAgentInboundQueue([], []), []);
  });
});

function harness(options: any = {}) {
  const log: any[] = [];
  const stored: any[] = [];
  const session = options.session ?? {
    id: "conv-1",
    group: false,
    remote: false,
    db: {
      addConversationPartner: (id: string) => log.push(["partner", id]),
      getTranscriptEntries: () => stored,
      appendTranscriptEntry: (entry: any) => stored.push(entry),
    },
  };
  const runner = options.runner ?? { run: async (...args: any[]) => { log.push(["run", ...args]); return { aborted: false }; } };
  const tm: any = {
    sessions: {
      isAgentGone: (id: string) => (options.gone ?? []).includes(id),
      liveSessions: new Map(options.liveSessions ?? []),
      activeSession: options.activeSession,
      resolveBackgroundSession: async (id: string) => { log.push(["resolve", id]); if (options.sessionError) throw new Error("no session"); return session; },
    },
    groupChat: {
      isRemoteRoomAgentId: (id: string) => (options.remote ?? []).includes(id),
      isGroupSession: (value: any) => value?.group === true,
      isRemoteRoomSession: (value: any) => value?.remote === true,
      dmPreemptedGroupMemberIds: new Set(),
      dmPreemptedWakeAgentIds: new Set(),
    },
    sessionStore: { listAgents: async () => options.agents ?? [], markSessionActivity: (value: any) => log.push(["markActivity", value.id]) },
    postToGroup: async (...args: any[]) => { log.push(["postToGroup", ...args]); return options.groupAck ?? "posted"; },
    productAnalytics: { trackEvent: (name: string, payload: any) => log.push(["track", name, payload]) },
    runnerRegistry: {
      activeGroupMemberRunners: new Map(options.groupRunners ?? []),
      runners: new Map(options.directRunners ?? []),
      getRunner: (value: any) => { log.push(["getRunner", value.id]); return runner; },
    },
    backgroundWakes: { dmPreemptedWakeAgentIds: new Set(options.preemptedWakes ?? []) },
    runLifecycle: {
      runScheduler: options.scheduler ?? null,
      runningAgentIds: () => new Set(options.running ?? []),
      beginSessionRun: (value: any) => log.push(["begin", value.id]),
      enqueueExclusiveRun: async (id: string, work: () => Promise<unknown>, opts: any) => { log.push(["enqueue", id, opts]); return await work(); },
      endSessionRun: (value: any) => log.push(["end", value.id]),
      lastRequestIdBySession: new Map([["conv-1", "req-1"]]),
    },
    turnRuntime: { activeRequestPrompts: new Map([["conv-1", "prompt"]]), activeRequestSources: new Map() },
    telemetry: { reportTurnInterrupt: (payload: any) => log.push(["interrupt", payload]), reportAgentError: (payload: any) => log.push(["agentError", payload]) },
    trayErrors: { pushError: (payload: any) => log.push(["trayError", payload]) },
    roster: { emitAgentUpdate: async (id: string) => log.push(["emit", id]) },
    appendEntry: (entry: any) => log.push(["appendEntry", entry]),
    execution: { canExecute: options.canExecute ?? true },
  };
  return { messaging: new AgentToAgentMessaging(tm), tm, log, session };
}

describe("sending a message to another agent", () => {
  it("refuses what cannot be sent", async () => {
    assert.equal(await harness().messaging.sendToAgent("agent-a", "agent-a", "hi"), "An agent can't message itself.");
    assert.equal(await harness().messaging.sendToAgent("agent-a", "agent-b", "   "), "Message was empty; nothing was sent.");
    assert.equal(await harness({ gone: ["agent-b"] }).messaging.sendToAgent("agent-a", "agent-b", "hi"), "That agent no longer exists.");
    assert.equal(await harness({ remote: ["agent-b"] }).messaging.sendToAgent("agent-a", "agent-b", "hi"), "That is a shared chat hosted by another user; agents can't message it directly.");
    assert.equal(await harness({ agents: [] }).messaging.sendToAgent("agent-a", "agent-b", "hi"), "No agent found with id agent-b.");
  });

  it("posts to a group, noting what a group cannot carry", async () => {
    const plain = harness({ agents: [{ id: "agent-b", name: "B", isGroup: true }], groupAck: "posted" });
    assert.equal(await plain.messaging.sendToAgent("agent-a", "agent-b", "hi"), "posted");
    const noted = harness({ agents: [{ id: "agent-b", name: "B", isGroup: true }], groupAck: "posted", images: [{ url: "https://image/0" }], priority: true });
    const answer = await noted.messaging.sendToAgent("agent-a", "agent-b", "hi", [{ url: "https://image/0" }], true);
    assert.equal(answer, "posted Note: the attached image was NOT delivered — group messages are text-only for now; send images to an agent directly. Note: priority is 1:1 only — this post did not interrupt members.");
  });

  it("writes a direct message into both conversations and queues it", async () => {
    const written: any[] = [];
    const liveSession = { id: "conv-1", db: { addConversationPartner: () => {}, getTranscriptEntries: () => [], appendTranscriptEntry: (entry: any) => written.push(entry) } };
    const { messaging, log } = harness({ agents: [{ id: "agent-a", name: "A" }, { id: "agent-b", name: "B" }], canExecute: false, liveSessions: [["agent-a", liveSession]] });
    const answer = await messaging.sendToAgent("agent-a", "agent-b", "hello");
    assert.match(answer, /^Sent to B\. This is asynchronous/);
    assert.deepEqual(log.filter((entry) => entry[0] === "track"), [["track", "slate.agent_message.sent", { from_agent_id: "agent-a", to_agent_id: "agent-b", is_group_target: false, is_priority: false }]]);
    assert.deepEqual(written.map((entry) => [entry.role, entry.content, entry.toAgent?.id]), [["assistant", "hello", "agent-b"]], "the outbound entry is written to the stored transcript");
    assert.deepEqual([...messaging.pendingAgentInbound.keys()], ["agent-b"]);
    assert.equal(messaging.pendingAgentInbound.get("agent-b")?.length, 1);
    await messaging.sendToAgent("agent-a", "agent-b", "second");
    assert.deepEqual(messaging.pendingAgentInbound.get("agent-b")?.map((message) => message.text), ["hello", "second"], "a later message joins the queue");
    const priority = harness({ agents: [{ id: "agent-a", name: "A" }, { id: "agent-b", name: "B" }], canExecute: false });
    assert.match(await priority.messaging.sendToAgent("agent-a", "agent-b", "now", [], true), /^Sent to B as a priority message/);
  });

  it("interrupts for a priority peer when the scheduler allows it", () => {
    const { messaging, log, tm } = harness({ scheduler: { getActiveLane: () => "agent" }, groupRunners: [["agent-b", { interrupt: () => true }]], running: ["agent-b"] });
    messaging.steerRecipientForPriorityPeer("agent-b");
    assert.deepEqual(log.find((entry) => entry[0] === "interrupt")?.[1], { conversationId: "agent-b", reason: "agent_steer", hadActiveRun: true, wasInFlight: true });
    assert.deepEqual([...tm.groupChat.dmPreemptedGroupMemberIds], ["agent-b"]);
    const userLane = harness({ scheduler: { getActiveLane: () => "user" }, running: ["agent-b"] });
    userLane.messaging.steerRecipientForPriorityPeer("agent-b");
    assert.deepEqual(userLane.log, [], "a user lane is never interrupted");
  });
});

describe("waking the recipient", () => {
  it("drains the queue in priority order", async () => {
    const { messaging, log } = harness({ canExecute: false });
    messaging.pendingAgentInbound.set("agent-b", [{ from: { id: "a", name: "A" }, text: "ordinary", timestampMs: 1 }, { from: { id: "a", name: "A" }, text: "urgent", timestampMs: 2, priority: true }]);
    const wakes: any[] = [];
    messaging.runAgentInboundWake = async (id: string, messages: any[]) => { wakes.push([id, messages.map((message: any) => message.text)]); };
    messaging.tm.execution.canExecute = true;
    await messaging.reviveForAgentInbound("agent-b");
    assert.deepEqual(wakes, [["agent-b", ["urgent", "ordinary"]]]);
    assert.deepEqual([...messaging.pendingAgentInbound.keys()], []);
    assert.equal(log.includes("resolve"), false, "the stubbed wake does not resolve a session");
  });

  it("delivers messages and emits an update", async () => {
    const { messaging, log } = harness();
    await messaging.runAgentInboundWake("agent-b", [{ from: { id: "agent-a", name: "A" }, text: "hello", timestampMs: 1 }]);
    assert.equal(log.filter((entry) => entry[0] === "run").length, 1);
    assert.deepEqual(log.filter((entry) => entry[0] === "emit"), [["emit", "conv-1"], ["emit", "conv-1"]]);
  });

  it("gives the rest of the queue back when a priority message arrives", async () => {
    const { messaging } = harness();
    const messages = [0, 1, 2].map((index) => ({ from: { id: "agent-a", name: "A" }, text: "m" + index, timestampMs: index + 1 }));
    messaging.pendingAgentInbound.set("agent-b", [{ from: { id: "a", name: "A" }, text: "urgent", timestampMs: 9, priority: true }]);
    await messaging.runAgentInboundWake("agent-b", messages);
    const queued = messaging.pendingAgentInbound.get("agent-b") ?? [];
    assert.equal(queued[0]?.priority, true, "the priority message stays first");
    assert.deepEqual(queued.filter((message) => message.isDisplayed === true).map((message) => message.text), ["m1", "m2"]);
  });

  it("does not wake a group session", async () => {
    const { messaging, log } = harness({ session: { id: "conv-1", group: true, remote: false, db: { addConversationPartner: () => {}, getTranscriptEntries: () => [], appendTranscriptEntry: () => {} } } });
    await messaging.runAgentInboundWake("agent-b", [{ from: { id: "agent-a", name: "A" }, text: "hello", timestampMs: 1 }]);
    assert.deepEqual(log, [["resolve", "agent-b"]], "only the session resolution happened");
  });

  it("does not redrive an aborted run that was not preempted", async () => {
    const { messaging } = harness({ runner: { run: async () => ({ aborted: true }) } });
    await messaging.runAgentInboundWake("agent-b", [{ from: { id: "agent-a", name: "A" }, text: "hello", timestampMs: 1 }]);
    assert.deepEqual([...messaging.pendingAgentInbound.entries()], []);
  });

  it("writes an inactive session into the stored transcript", () => {
    const written: any[] = [];
    const session = { id: "conv-1", db: { addConversationPartner: () => {}, getTranscriptEntries: () => [], appendTranscriptEntry: (entry: any) => written.push(entry) } };
    const { messaging, log } = harness({ session });
    messaging.appendAgentInboundEntries(session, [{ from: { id: "agent-a", name: "A" }, text: "hi", timestampMs: 5 }]);
    assert.deepEqual(written.map((entry) => [entry.kind, entry.role, entry.content, entry.fromAgent.id]), [["message", "user", "hi", "agent-a"]]);
    assert.equal(log.some((entry) => entry[0] === "appendEntry"), false, "nothing goes to the live transcript");
  });

  it("reports a failed run where the user can see it", async () => {
    const { messaging, log } = harness({ runner: { run: async () => { throw new Error("run failed"); } } });
    await messaging.runAgentInboundWake("agent-b", [{ from: { id: "agent-a", name: "A" }, text: "hello", timestampMs: 1 }]);
    assert.equal(log.filter((entry) => entry[0] === "trayError").length, 1);
    assert.deepEqual(log.filter((entry) => entry[0] === "trayError")[0][1], { agentId: "conv-1", title: "Message from another agent failed", detail: "run failed" });
    assert.equal(log.at(-1)[0], "end");
  });
});