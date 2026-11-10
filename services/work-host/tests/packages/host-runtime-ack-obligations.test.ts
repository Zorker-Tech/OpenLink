/**
 * The acknowledgement a send is owed: when one is recorded, when it is fulfilled, when it is redriven, and when it is
 * given up on.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACK_REDRIVE_IDLE_DELAY_MS,
  AckObligations,
  MAX_ACK_REDRIVES,
  buildAckRedrivePrompt,
} from "../../source/host/transcript/ack-obligations.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };
type Obligation = { agentId: string; createdAtMs: number; coalescedCount: number; redriveAttempts: number; lastInterruptAtMs?: number };

/** An obligation store that keeps one obligation per agent and writes down every call it receives. */
function obligationStore(initial: Obligation[] = [], options: { failRedriveAttempt?: boolean } = {}) {
  const obligations = new Map(initial.map((obligation) => [obligation.agentId, obligation]));
  const calls: Call[] = [];
  return {
    obligations,
    calls,
    get: (agentId: string) => obligations.get(agentId),
    list: () => [...obligations.values()],
    clear: (agentId: string) => {
      calls.push({ name: "clear", args: [agentId] });
      obligations.delete(agentId);
    },
    recordSend: (agentId: string, args: { atMs: number }) => {
      calls.push({ name: "recordSend", args: [agentId, args] });
      const existing = obligations.get(agentId);
      if (existing != null) {
        existing.coalescedCount += 1;
        return { obligation: existing, created: false };
      }
      const obligation: Obligation = { agentId, createdAtMs: args.atMs, coalescedCount: 0, redriveAttempts: 0 };
      obligations.set(agentId, obligation);
      return { obligation, created: true };
    },
    recordInterrupt: (agentId: string, atMs: number) => {
      calls.push({ name: "recordInterrupt", args: [agentId, atMs] });
      const obligation = obligations.get(agentId);
      if (obligation != null) obligation.lastInterruptAtMs = atMs;
    },
    recordRedriveAttempt: (agentId: string) => {
      calls.push({ name: "recordRedriveAttempt", args: [agentId] });
      if (options.failRedriveAttempt === true) return null;
      const obligation = obligations.get(agentId);
      if (obligation == null) return null;
      obligation.redriveAttempts += 1;
      return obligation;
    },
  };
}

const obligationOf = (overrides: Partial<Obligation> = {}): Obligation => ({
  agentId: "agent-1",
  createdAtMs: 1_000,
  coalescedCount: 0,
  redriveAttempts: 0,
  ...overrides,
});

/** A transcript manager with the store, the scheduler and the run surface an obligation reaches for. */
function world(
  options: {
    obligations?: Obligation[];
    hasStore?: boolean;
    hasScheduler?: boolean;
    canExecute?: boolean;
    disposed?: boolean;
    quiescing?: boolean;
    agentGone?: boolean;
    group?: boolean;
    remoteRoom?: boolean;
    sessionError?: Error;
    runResult?: Record<string, unknown>;
    runError?: Error;
    resolveRedriveAttempt?: boolean;
    lastRequestId?: string;
    entries?: Array<Record<string, unknown>>;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const store = obligationStore(options.obligations ?? [], { failRedriveAttempt: options.resolveRedriveAttempt === false });
  const session = {
    id: "agent-1",
    db: {
      getTranscriptEntries: () =>
        options.entries ?? [
          { id: "t0u", kind: "message", role: "user", content: "hello", richText: "**hello**" },
          { id: "t0a1", kind: "message", role: "assistant", content: "hi" },
          { id: "t0u2", kind: "message", role: "user", content: "from an agent", fromAgent: "other" },
          { id: "t0u3", kind: "message", role: "user", content: "from a channel", channel: "listener-1" },
        ],
    },
  };
  const runner = {
    run: async (prompt: string, runOptions: Record<string, unknown>) => {
      record("run", prompt, runOptions);
      if (options.runError !== undefined) throw options.runError;
      return options.runResult ?? { sentMessageCount: 1, reacted: false, aborted: false };
    },
    getObservedToolCallCount: () => 4,
  };
  const tm = {
    ackObligationStore: options.hasStore === false ? undefined : (store as unknown),
    disposed: options.disposed === true,
    upgradeResume: { quiescingForUpgrade: options.quiescing === true },
    execution: { canExecute: options.canExecute !== false },
    runLifecycle: {
      runScheduler: options.hasScheduler === false ? undefined : {},
      lastRequestIdBySession: new Map(options.lastRequestId === undefined ? [] : [["agent-1", options.lastRequestId]]),
      beginSessionRun: (target: unknown) => record("beginSessionRun"),
      endSessionRun: (target: unknown) => record("endSessionRun"),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => {
        record("enqueueExclusiveRun", id, meta);
        return await work();
      },
    },
    telemetry: {
      reportAckObligation: (report: unknown) => record("reportAckObligation", report),
      reportTurnEmptyDelivery: (report: unknown) => record("reportTurnEmptyDelivery", report),
      reportAgentError: (report: unknown) => record("reportAgentError", report),
    },
    sessions: {
      isAgentGone: () => options.agentGone === true,
      resolveBackgroundSession: async (agentId: string) => {
        record("resolveBackgroundSession", agentId);
        if (options.sessionError !== undefined) throw options.sessionError;
        return session;
      },
    },
    groupChat: { isGroupSession: () => options.group === true, isRemoteRoomSession: () => options.remoteRoom === true },
    runnerRegistry: {
      getRunner: (target: unknown) => {
        record("getRunner");
        return runner;
      },
    },
    turnRuntime: {
      activeRequestPrompts: new Map<string, string>([["agent-1", "old prompt"]]),
      activeRequestSources: new Map<string, string>(),
    },
    roster: { emitAgentUpdate: async (id: string) => record("emitAgentUpdate", id) },
    ackRedrivePolicy: {
      arm: (agentId: string, callback: () => void) => {
        record("arm", agentId, callback);
        return { dispose: () => record("disposeTimer", agentId) };
      },
    },
  };
  const obligations = new AckObligations(tm);
  return {
    obligations, tm, session, runner, store, calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    armedCallback: () => (calls.filter((call) => call.name === "arm").at(-1)?.args[1] ?? null) as (() => void) | null,
  };
}

describe("recording an obligation", () => {
  it("records a send against the conversation, or coalesces it onto the one already owed", () => {
    const world1 = world();
    world1.obligations.recordAckObligationSend(world1.session, 1_500);
    assert.deepEqual(world1.named("reportAckObligation")[0]?.args, [
      { conversationId: "agent-1", outcome: "created", ageMs: 0, coalescedCount: 0 },
    ]);
    world1.obligations.recordAckObligationSend(world1.session, 2_000);
    assert.deepEqual(world1.named("reportAckObligation")[1]?.args, [
      { conversationId: "agent-1", outcome: "coalesced", ageMs: 500, coalescedCount: 1 },
    ]);
    // Recording a send drops any redrive that was waiting, so the redrive cannot fire against a stale obligation.
    const armed = world({ obligations: [obligationOf()] });
    armed.obligations.armAckRedriveTimer("agent-1", "idle");
    armed.obligations.recordAckObligationSend(armed.session, 2_000);
    assert.equal(armed.named("disposeTimer").length, 1);
    assert.equal(armed.obligations.ackRedriveTimers.size, 0);
    // Without the store or the run queue there is nothing to owe against.
    const bare = world({ hasStore: false });
    bare.obligations.recordAckObligationSend(bare.session, 1_500);
    const noScheduler = world({ hasScheduler: false });
    noScheduler.obligations.recordAckObligationSend(noScheduler.session, 1_500);
    assert.deepEqual([bare.calls.length, noScheduler.calls.length], [0, 0]);
  });

  it("arms a guard that records the obligation only if nothing already does when the send is done", () => {
    const world1 = world();
    const guard = world1.obligations.armSendGuard(world1.session, 900, true);
    guard[Symbol.dispose]();
    assert.deepEqual(world1.named("reportAckObligation")[0]?.args, [
      { conversationId: "agent-1", outcome: "created", ageMs: 0, coalescedCount: 0 },
    ]);
    // Nothing was owed, so nothing is recorded.
    const notOwed = world();
    notOwed.obligations.armSendGuard(notOwed.session, 900, false)[Symbol.dispose]();
    assert.equal(notOwed.named("reportAckObligation").length, 0);
    // Disarming before the send is done leaves the obligation alone.
    const disarmed = world();
    const guard2 = disarmed.obligations.armSendGuard(disarmed.session, 900, true);
    guard2.disarm();
    guard2[Symbol.dispose]();
    assert.equal(disarmed.named("reportAckObligation").length, 0);
    // A turn that answered for the send already left an obligation, and the guard does not add a second one.
    const answered = world({ obligations: [obligationOf()] });
    answered.obligations.armSendGuard(answered.session, 900, true)[Symbol.dispose]();
    assert.equal(answered.named("reportAckObligation").length, 0);
  });

  it("confirms the obligation around an interrupt", () => {
    const world1 = world({ obligations: [obligationOf()] });
    world1.obligations.confirmAckObligationAfterInterrupt(world1.session, 1_600, true);
    assert.deepEqual(world1.store.calls.map((call) => call.name), ["recordInterrupt"]);
    assert.deepEqual(world1.named("reportAckObligation").length, 0);
    // With nothing owed, the interrupt records one for the message that was just sent.
    const fresh = world();
    fresh.obligations.confirmAckObligationAfterInterrupt(fresh.session, 1_600, true);
    assert.deepEqual(fresh.named("reportAckObligation")[0]?.args, [
      { conversationId: "agent-1", outcome: "created", ageMs: 0, coalescedCount: 0 },
    ]);
    assert.deepEqual(fresh.store.calls.map((call) => call.name), ["recordSend", "recordInterrupt"]);
    // An interrupt that did not preempt any run is not recorded as one.
    const nothingInterrupted = world();
    nothingInterrupted.obligations.confirmAckObligationAfterInterrupt(nothingInterrupted.session, 1_600, false);
    assert.deepEqual(nothingInterrupted.store.calls.map((call) => call.name), ["recordSend"]);
  });
});

describe("the tokens a run uses to answer for a send", () => {
  it("mints a token per run and only the token that is still live can fulfil the obligation", () => {
    const world1 = world({ obligations: [obligationOf({ coalescedCount: 2, redriveAttempts: 1, lastInterruptAtMs: 1_200 })] });
    const first = world1.obligations.mintAckRunToken("agent-1");
    const second = world1.obligations.mintAckRunToken("agent-1");
    assert.equal(typeof first, "string");
    assert.notEqual(first, second);
    assert.equal(world1.obligations.ackRunTokens.get("agent-1")?.size, 2);
    // A token nobody minted, or one already retired, is not accepted.
    world1.obligations.fulfillAckObligation("agent-1", "made-up");
    world1.obligations.retireAckRunToken("agent-1", second);
    world1.obligations.fulfillAckObligation("agent-1", second);
    assert.equal(world1.named("reportAckObligation").length, 0);
    assert.equal(world1.store.get("agent-1") != null, true);
    // The live token fulfils it, and what it took to get there is reported.
    world1.obligations.fulfillAckObligation("agent-1", first);
    const report = world1.named("reportAckObligation")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.outcome, report.coalescedCount, report.redriveAttempts], ["fulfilled", 2, 1]);
    assert.equal(typeof report.ageMs, "number");
    assert.equal(report.timeToFirstVisibleAckMs, report.ageMs);
    assert.equal(typeof report.interruptToReplacementAckMs, "number");
    assert.equal(world1.store.get("agent-1"), undefined);
    assert.equal(world1.obligations.ackRunTokens.get("agent-1")?.size, 1);
    // Retiring every token forgets the conversation.
    world1.obligations.retireAckRunToken("agent-1", first);
    assert.equal(world1.obligations.ackRunTokens.has("agent-1"), false);
  });

  it("reports an obligation as lost when nobody can answer for it any more", () => {
    assert.equal(MAX_ACK_REDRIVES, 3);
    const world1 = world({ obligations: [obligationOf({ coalescedCount: 1, redriveAttempts: 2 })] });
    world1.obligations.markAckObligationLost("agent-1", "max_redrives");
    const report = world1.named("reportAckObligation")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.outcome, report.reason, report.coalescedCount, report.redriveAttempts], ["lost", "max_redrives", 1, 2]);
    assert.equal(world1.store.get("agent-1"), undefined);
    // Nothing owed means nothing to lose.
    const quiet = world();
    quiet.obligations.markAckObligationLost("agent-1", "agent_deleted");
    assert.equal(quiet.named("reportAckObligation").length, 0);
  });
});

describe("redriving what was never acknowledged", () => {
  it("waits out an idle timer only when there is something to redrive", () => {
    const owed = world({ obligations: [obligationOf()] });
    owed.obligations.scheduleAckRedriveAfterIdle("agent-1");
    assert.equal(owed.named("arm")[0]?.args[0], "agent-1");
    assert.equal(owed.obligations.ackRedriveTimers.size, 1);
    assert.equal(typeof owed.armedCallback(), "function");
    // Nothing owed, nothing to wait for.
    const quiet = world();
    quiet.obligations.scheduleAckRedriveAfterIdle("agent-1");
    assert.equal(quiet.named("arm").length, 0);
    // Nor while the host is on its way down, or the queue is not there, or turns cannot run.
    for (const blocked of [
      world({ obligations: [obligationOf()], disposed: true }),
      world({ obligations: [obligationOf()], quiescing: true }),
      world({ obligations: [obligationOf()], hasStore: false }),
      world({ obligations: [obligationOf()], hasScheduler: false }),
    ]) {
      blocked.obligations.scheduleAckRedriveAfterIdle("agent-1");
      assert.equal(blocked.named("arm").length, 0);
    }
    assert.equal(ACK_REDRIVE_IDLE_DELAY_MS, 5_000);
  });

  it("asks for every unfulfilled obligation on the way back up, when turns can run", async () => {
    const world1 = world({ obligations: [obligationOf(), obligationOf({ agentId: "agent-2" })] });
    await world1.obligations.redriveUnfulfilledAckObligations();
    assert.deepEqual(world1.named("arm").map((call) => call.args[0]), ["agent-1", "agent-2"]);
    // The timer it arms is a boot redrive, which is what the report says when it fires.
    world1.armedCallback()?.();
    await new Promise((resolve) => setImmediate(resolve));
    const triggers = world1.named("reportAckObligation").map((call) => (call.args[0] as { outcome: string; reason?: string })).filter((report) => report.outcome === "redrive").map((report) => report.reason);
    assert.deepEqual(triggers, ["boot"]);
    const cannotRun = world({ obligations: [obligationOf()], canExecute: false });
    await cannotRun.obligations.redriveUnfulfilledAckObligations();
    assert.equal(cannotRun.named("arm").length, 0);
  });

  it("gives up on an obligation whose agent is gone or whose redrives ran out", async () => {
    const gone = world({ obligations: [obligationOf()], agentGone: true });
    await gone.obligations.redriveAckObligation("agent-1", "idle");
    assert.deepEqual((gone.named("reportAckObligation")[0]?.args[0] as { reason: string }).reason, "agent_deleted");
    assert.equal(gone.named("run").length, 0);
    const exhausted = world({ obligations: [obligationOf({ redriveAttempts: MAX_ACK_REDRIVES })] });
    await exhausted.obligations.redriveAckObligation("agent-1", "boot");
    assert.deepEqual((exhausted.named("reportAckObligation")[0]?.args[0] as { reason: string }).reason, "max_redrives");
    assert.equal(exhausted.named("recordRedriveAttempt").length, 0);
    // A store that will not count the attempt stops the redrive rather than running it.
    const refused = world({ obligations: [obligationOf()], resolveRedriveAttempt: false });
    await refused.obligations.redriveAckObligation("agent-1", "idle");
    assert.equal(refused.named("run").length, 0);
    assert.equal(refused.named("reportAckObligation").length, 0);
    // Nothing owed, or no way to run, means nothing happens.
    const quiet = world();
    await quiet.obligations.redriveAckObligation("agent-1", "idle");
    const cannotRun = world({ obligations: [obligationOf()], canExecute: false });
    await cannotRun.obligations.redriveAckObligation("agent-1", "idle");
    const stopping = world({ obligations: [obligationOf()], quiescing: true });
    await stopping.obligations.redriveAckObligation("agent-1", "idle");
    assert.deepEqual([quiet.calls.length, cannotRun.calls.length, stopping.calls.length], [0, 0, 0]);
  });

  it("runs the redrive as a hidden turn with the messages the user sent, and reports what it delivered", async () => {
    const world1 = world({ obligations: [obligationOf({ coalescedCount: 1, lastInterruptAtMs: 1_200 })], lastRequestId: "req-9", runResult: { sentMessageCount: 0, reacted: false, aborted: false, streamOutputProduced: true } });
    await world1.obligations.redriveAckObligation("agent-1", "boot");
    const redrive = world1.named("reportAckObligation")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([redrive.outcome, redrive.reason, redrive.redriveAttempts], ["redrive", "boot", 1]);
    assert.equal(world1.named("beginSessionRun").length, 1);
    const meta = world1.named("enqueueExclusiveRun")[0]?.args[1] as Record<string, unknown>;
    assert.deepEqual([meta.lane, meta.source], ["background", "ack-redrive"]);
    assert.equal(typeof meta.ackToken, "string");
    // The turn it runs is hidden, carries the run's token, and is handed the user's own messages plus its own prompt.
    const [prompt, runOptions] = world1.named("run")[0]?.args as [string, Record<string, unknown>];
    assert.equal(prompt, buildAckRedrivePrompt());
    assert.equal(runOptions.hidden, true);
    assert.equal(runOptions.requestSource, "handoff-resume");
    assert.match(String(runOptions.messageId), /^ack-redrive-[0-9a-f-]{36}$/);
    const recent = runOptions.recentUserMessages as Array<{ id: string; text: string }>;
    assert.deepEqual(recent.map((message) => message.id), ["t0u", runOptions.messageId]);
    assert.equal(recent[0]?.text, "hello");
    assert.equal(world1.tm.turnRuntime.activeRequestPrompts.has("agent-1"), false);
    assert.equal(world1.tm.turnRuntime.activeRequestSources.get("agent-1"), "handoff-resume");
    assert.deepEqual(world1.named("emitAgentUpdate")[0]?.args, ["agent-1"]);
    // A redrive that delivered nothing is reported as an empty delivery, under its own source.
    const empty = world1.named("reportTurnEmptyDelivery")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([empty.source, empty.requestSource, empty.redriveAttempts, empty.toolCallCount, empty.streamOutputProduced, empty.ackOutstanding], ["ack_redrive", "handoff-resume", 1, 4, true, true]);
    assert.deepEqual([world1.named("endSessionRun").length, world1.obligations.ackRunTokens.size], [1, 0]);
  });

  it("waits again when the conversation cannot be opened, and gives up on one inside a room", async () => {
    const unopenable = world({ obligations: [obligationOf()], sessionError: new Error("no session") });
    await unopenable.obligations.redriveAckObligation("agent-1", "boot");
    assert.equal(unopenable.named("run").length, 0);
    assert.equal(unopenable.named("arm")[0]?.args[0], "agent-1");
    for (const inRoom of [world({ obligations: [obligationOf()], group: true }), world({ obligations: [obligationOf()], remoteRoom: true })]) {
      await inRoom.obligations.redriveAckObligation("agent-1", "idle");
      assert.deepEqual(inRoom.store.calls.map((call) => call.name).includes("clear"), true);
      assert.equal(inRoom.named("run").length, 0);
    }
  });

  it("reports a redrive that failed as an agent error, under its own source", async () => {
    const failed = world({ obligations: [obligationOf()], runError: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    await failed.obligations.redriveAckObligation("agent-1", "idle");
    const report = failed.named("reportAgentError")[0]?.args[0] as Record<string, unknown>;
    assert.equal(report.source, "ack_redrive");
    assert.deepEqual(report.error, { code: SlateError.streamReset()["code"], connectCode: undefined, errno: "ECONNRESET" });
    assert.deepEqual(report.detail, { message: "socket hang up", stack: (report.detail as { stack: string }).stack });
    assert.equal(failed.named("endSessionRun").length, 1);
    assert.equal(failed.obligations.ackRunTokens.size, 0);
  });

  it("does not run a redrive for an obligation that was answered while it was waiting its turn", async () => {
    const world1 = world({ obligations: [obligationOf()] });
    world1.obligations.tm.roster.emitAgentUpdate = async () => {};
    // The obligation is cleared between the redrive being queued and the queued work running.
    world1.obligations.tm.runLifecycle.enqueueExclusiveRun = async (id: string, work: () => Promise<void>) => {
      world1.store.clear("agent-1");
      await work();
    };
    await world1.obligations.redriveAckObligation("agent-1", "idle");
    assert.equal(world1.named("run").length, 0);
    // The redrive had already claimed the request source for the conversation before it found nothing to say.
    assert.equal(world1.tm.turnRuntime.activeRequestSources.get("agent-1"), "handoff-resume");
    assert.equal(world1.named("endSessionRun").length, 1);
    assert.equal(world1.obligations.ackRunTokens.size, 0);
  });
});
