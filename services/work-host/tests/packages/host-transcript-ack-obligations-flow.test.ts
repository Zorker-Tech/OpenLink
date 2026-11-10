import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACK_REDRIVE_IDLE_DELAY_MS,
  AckObligations,
  MAX_ACK_REDRIVES,
  buildAckRedrivePrompt,
} from "../../source/host/transcript/ack-obligations.ts";

type Call = { name: string; args: unknown[] };
type Owed = { agentId: string; createdAtMs: number; coalescedCount: number; redriveAttempts: number; lastInterruptAtMs?: number };

function obligationStore(initial: Owed[]) {
  const obligations = new Map(initial.map((owed) => [owed.agentId, owed]));
  const calls: Call[] = [];
  return {
    obligations,
    calls,
    get: (agent: string) => obligations.get(agent),
    list: () => [...obligations.values()],
    clear: (agent: string) => { calls.push({ name: "clear", args: [agent] }); obligations.delete(agent); },
    recordSend: (agent: string, args: { atMs: number }) => {
      calls.push({ name: "recordSend", args: [agent, args] });
      const existing = obligations.get(agent);
      if (existing != null) { existing.coalescedCount += 1; return { obligation: existing, created: false }; }
      const owed: Owed = { agentId: agent, createdAtMs: args.atMs, coalescedCount: 0, redriveAttempts: 0 };
      obligations.set(agent, owed);
      return { obligation: owed, created: true };
    },
    recordInterrupt: (agent: string, atMs: number) => { calls.push({ name: "recordInterrupt", args: [agent, atMs] }); const owed = obligations.get(agent); if (owed != null) owed.lastInterruptAtMs = atMs; },
    recordRedriveAttempt: (agent: string) => { calls.push({ name: "recordRedriveAttempt", args: [agent] }); const owed = obligations.get(agent); if (owed == null) return null; owed.redriveAttempts += 1; return owed; },
  };
}

function world(options: { sessionId?: string; lastRequestId?: string; runResult?: Record<string, unknown>; onRun?: (store: ReturnType<typeof obligationStore>) => void; noObligation?: boolean; hasScheduler?: boolean; owedRedrives?: number } = {}) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => { calls.push({ name, args }); };
  const owed = { agentId: "agent-1", createdAtMs: 1_000, coalescedCount: 0, redriveAttempts: options.owedRedrives ?? 0 };
  const store = obligationStore(options.noObligation === true ? [] : [owed]);
  const sessionId = options.sessionId ?? "agent-1";
  const session = { id: sessionId, db: { getTranscriptEntries: () => [{ id: "t0u", kind: "message", role: "user", content: "hello", richText: "**hello**" }, { id: "t0a", kind: "message", role: "assistant", content: "hi" }] } };
  const runner = { run: async (prompt: string, runOptions: Record<string, unknown>) => { record("run", prompt, runOptions); options.onRun?.(store); return options.runResult ?? { sentMessageCount: 0, reacted: false, aborted: false }; }, getObservedToolCallCount: () => 4 };
  const tm: any = {
    ackObligationStore: store, disposed: false, upgradeResume: { quiescingForUpgrade: false }, execution: { canExecute: true },
    runLifecycle: {
      runScheduler: options.hasScheduler === false ? undefined : {},
      lastRequestIdBySession: new Map(options.lastRequestId === undefined ? [] : [[sessionId, options.lastRequestId]]),
      beginSessionRun: (target: unknown) => record("beginSessionRun", target),
      endSessionRun: (target: unknown) => record("endSessionRun", target),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => { record("enqueueExclusiveRun", id, meta); return await work(); },
    },
    telemetry: { reportAckObligation: (report: unknown) => record("reportAckObligation", report), reportTurnEmptyDelivery: (report: unknown) => record("reportTurnEmptyDelivery", report), reportAgentError: (report: unknown) => record("reportAgentError", report) },
    sessions: { isAgentGone: () => false, resolveBackgroundSession: async (agent: string) => { record("resolveBackgroundSession", agent); return session; } },
    groupChat: { isGroupSession: () => false, isRemoteRoomSession: () => false },
    runnerRegistry: { getRunner: () => runner },
    turnRuntime: { activeRequestPrompts: new Map<string, string>([[sessionId, "old"]]), activeRequestSources: new Map<string, string>() },
    roster: { emitAgentUpdate: async (id: string) => record("emitAgentUpdate", id) },
    ackRedrivePolicy: { arm: (agent: string, callback: () => void) => { record("arm", agent, callback); return { dispose: () => record("disposeTimer", agent) }; } },
  };
  const obligations = new AckObligations(tm);
  return { obligations, store, session, calls, named: (name: string) => calls.filter((call) => call.name === name) };
}

describe("the acknowledgement a send is owed", () => {
  it("keeps the redrive prompt and limits it reports", () => {
    assert.equal(MAX_ACK_REDRIVES, 3);
    assert.equal(ACK_REDRIVE_IDLE_DELAY_MS, 5_000);
    assert.equal(buildAckRedrivePrompt().startsWith("[System recovery]"), true);
    assert.equal(buildAckRedrivePrompt().includes("send a brief confirmation with the result"), true);
  });

  it("records a send, or adds it to the obligation already owed", () => {
    const created = world({ noObligation: true });
    created.obligations.recordAckObligationSend(created.session, 1_500);
    assert.deepEqual(created.named("reportAckObligation")[0]?.args, [{ conversationId: "agent-1", outcome: "created", ageMs: 0, coalescedCount: 0 }]);
    const coalesced = world({ owedRedrives: 0 });
    coalesced.obligations.armAckRedriveTimer("agent-1", "idle");
    coalesced.obligations.recordAckObligationSend(coalesced.session, 2_000);
    assert.equal(coalesced.named("disposeTimer").length, 1, "the redrive waiting for the old send is dropped once");
    assert.deepEqual(coalesced.named("reportAckObligation")[0]?.args, [{ conversationId: "agent-1", outcome: "coalesced", ageMs: 1_000, coalescedCount: 1 }]);
  });

  it("fulfils only with a live token, and reports what it took", () => {
    const w = world({ owedRedrives: 1 });
    const token = w.obligations.mintAckRunToken("agent-1");
    w.obligations.fulfillAckObligation("agent-1", "made-up");
    assert.equal(w.named("reportAckObligation").length, 0);
    w.obligations.fulfillAckObligation("agent-1", token);
    const report = w.named("reportAckObligation")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.outcome, report.coalescedCount, report.redriveAttempts], ["fulfilled", 0, 1]);
    assert.equal(w.store.get("agent-1"), undefined);
  });

  it("redrives an obligation: bumps it, runs a hidden turn, and reports an empty delivery", async () => {
    const w = world({ lastRequestId: "req-7" });
    await w.obligations.redriveAckObligation("agent-1", "idle");
    assert.equal(w.named("reportAckObligation")[0]?.args[0] instanceof Object, true);
    const runOptions = w.named("run")[0]?.args[1] as Record<string, unknown>;
    assert.equal(runOptions.hidden, true);
    assert.equal(typeof runOptions.ackToken, "string");
    assert.equal(String(runOptions.messageId).startsWith("ack-redrive-"), true);
    assert.deepEqual((runOptions.recentUserMessages as unknown[]).length, 2, "the user turn and the redrive prompt");
    const redriveReport = w.named("reportAckObligation")[0]?.args[0] as Record<string, unknown>;
    assert.equal(redriveReport.redriveAttempts, 1, "the attempt was recorded before the turn");
    const delivery = w.named("reportTurnEmptyDelivery")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([delivery.source, delivery.requestId, delivery.toolCallCount, delivery.redriveAttempts], ["ack_redrive", "req-7", 4, 1]);
    assert.equal(typeof delivery.durationMs, "number");
    assert.equal(w.obligations.ackRunTokens.size, 0, "the token is retired after the turn");
    assert.equal(w.named("endSessionRun").length, 1, "the session run is closed after the turn");
  });

  it("owes nothing when the host has no run queue", () => {
    const w = world({ hasScheduler: false });
    w.obligations.recordAckObligationSend(w.session, 1_500);
    assert.equal(w.calls.length, 0, "nothing is recorded or reported");
  });

  it("loses an obligation when it can no longer be answered for", () => {
    const w = world({ owedRedrives: 2 });
    w.obligations.markAckObligationLost("agent-1", "max_redrives");
    assert.equal(w.store.get("agent-1"), undefined, "the obligation is gone");
    const report = w.named("reportAckObligation")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.conversationId, report.outcome, report.reason, report.coalescedCount, report.redriveAttempts], ["agent-1", "lost", "max_redrives", 0, 2]);
    assert.equal(typeof report.ageMs, "number");
  });

  it("asks the obligation store about the agent, not the session it resolved", async () => {
    const w = world({ sessionId: "conversation-9" });
    await w.obligations.redriveAckObligation("agent-1", "boot");
    const delivery = w.named("reportTurnEmptyDelivery")[0]?.args[0] as Record<string, unknown>;
    assert.equal(delivery.ackOutstanding, true, "the obligation is keyed by the agent");
  });
});