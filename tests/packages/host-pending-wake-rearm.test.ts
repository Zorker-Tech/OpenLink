import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as rearmModule from "../../source/host/transcript/pending-wake-rearm.ts";

const marker = (over: Record<string, unknown> = {}) => ({ agentId: "a1", kind: "shell", workId: "w1", markedAtMs: 100, ...over });

const makeTm = (log: unknown[][], options: Record<string, unknown> = {}) => {
  const state = {
    groupSession: options.groupSession ?? false,
    resolveFails: options.resolveFails ?? false,
    watchArmed: new Set<string>((options.watchArmed as string[]) ?? []),
    watchTakes: options.watchTakes ?? true,
    clearResult: options.clearResult ?? true,
    markResult: options.markResult ?? true,
    failBranch: options.failBranch ?? false,
    canExecute: options.canExecute ?? true,
    session: { id: "session" },
  };
  const runner = {
    getPendingCloudAgentWatchBcIds: () => [...state.watchArmed],
    watchCloudAgent: (workId: string, watchOptions: unknown) => {
      log.push(["watchCloudAgent", workId, watchOptions]);
      if (state.failBranch) throw new Error("watch failed");
      if (state.watchTakes) state.watchArmed.add(workId);
    },
    watchBackgroundShell: (workId: string, shellOptions: unknown) => {
      log.push(["watchBackgroundShell", workId, shellOptions]);
      if (state.failBranch) throw new Error("shell failed");
    },
  };
  const tm = {
    pendingWakeStore: options.storeAbsent
      ? null
      : {
          markPending: (record: unknown) => { log.push(["markPending", record]); return state.markResult; },
          clearOne: (agentId: string, kind: string, workId: string) => { log.push(["clearOne", agentId, kind, workId]); return state.clearResult; },
          pruneStale: (maxAge: number) => { log.push(["pruneStale", maxAge]); return (options.prune as unknown[]) ?? []; },
          listPending: () => (options.list as unknown[]) ?? [],
        },
    sessions: {
      deletedAgentIds: new Set((options.deleted as string[]) ?? []),
      isAgentGone: (agentId: string) => ((options.gone as string[]) ?? []).includes(agentId),
      resolveBackgroundSession: async () => {
        if (state.resolveFails) throw new Error("no session");
        return state.session;
      },
    },
    telemetry: { reportPendingWake: (report: unknown) => log.push(["telemetry", report]) },
    roster: { emitAsyncTasksForAgent: (agentId: string) => log.push(["roster", agentId]) },
    execution: { get canExecute() { return state.canExecute; } },
    groupChat: { isGroupSession: () => state.groupSession },
    runnerRegistry: { getRunner: () => runner },
    upgradeResume: { deliverRecreateInterruptedShellNotice: (record: unknown, report: (outcome: string) => void) => { log.push(["deliverShellNotice", record]); report("rearmed"); } },
    backgroundWakes: { handleBackgroundSubagentCompletion: (args: unknown) => log.push(["backgroundWakes", args]) },
  };
  return { tm: tm as never, state };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("re-arming pending wakes", () => {
  it("carries its stale age and switch", () => {
    assert.equal(rearmModule.PENDING_WAKE_STALE_MAX_AGE_MS, 48 * 60 * 60 * 1_000);
    const previous = process.env.SLATE_DISABLE_RECREATE_WAKE_CARRY;
    process.env.SLATE_DISABLE_RECREATE_WAKE_CARRY = "1";
    assert.equal(rearmModule.isRecreateWakeCarryDisabled(), true);
    process.env.SLATE_DISABLE_RECREATE_WAKE_CARRY = "0";
    assert.equal(rearmModule.isRecreateWakeCarryDisabled(), false);
    if (previous === undefined) delete process.env.SLATE_DISABLE_RECREATE_WAKE_CARRY;
    else process.env.SLATE_DISABLE_RECREATE_WAKE_CARRY = previous;
  });

  it("writes a pending wake down with exactly what it was given, and reports whether it landed", () => {
    const log: unknown[][] = [];
    assert.equal(new rearmModule.PendingWakeRearm(makeTm(log, { storeAbsent: true }).tm).persistPendingWake({ parentAgentId: "a", kind: "shell", workId: "w", title: "t" }), false);
    assert.deepEqual(log, []);

    const deleted: unknown[][] = [];
    assert.equal(new rearmModule.PendingWakeRearm(makeTm(deleted, { deleted: ["gone"] }).tm).persistPendingWake({ parentAgentId: "gone", kind: "shell", workId: "w", title: "t" }), false);
    assert.deepEqual(deleted, []);

    const written: unknown[][] = [];
    assert.equal(new rearmModule.PendingWakeRearm(makeTm(written).tm).persistPendingWake({ parentAgentId: "a", kind: "cloud-agent", workId: "w", title: "t", quietOrigin: { q: 1 }, subagentType: "task" }), true);
    assert.deepEqual(written.map((entry) => entry[0]), ["markPending", "telemetry"]);
    const record = written[0]?.[1] as Record<string, unknown>;
    assert.equal(record.agentId, "a");
    assert.equal(record.kind, "cloud-agent");
    assert.equal(record.workId, "w");
    assert.equal(typeof record.markedAtMs, "number");
    assert.deepEqual(record.quietOrigin, { q: 1 });
    assert.equal(record.title, "t");
    assert.equal(record.subagentType, "task");
    assert.deepEqual(written[1]?.[1], { conversationId: "a", outcome: "persisted", kind: "cloud-agent", workId: "w", isQuietOrigin: true });

    const absent: unknown[][] = [];
    assert.equal(new rearmModule.PendingWakeRearm(makeTm(absent).tm).persistPendingWake({ parentAgentId: "a", kind: "shell", workId: "w", title: "t" }), true);
    const absentRecord = absent[0]?.[1] as Record<string, unknown>;
    assert.equal("quietOrigin" in absentRecord, false, "an absent quiet origin leaves no key");
    assert.equal("subagentType" in absentRecord, false, "an absent subagent type leaves no key");
  });

  it("clears, disarms and reports a wake only when it was there", () => {
    const log: unknown[][] = [];
    const rearm = new rearmModule.PendingWakeRearm(makeTm(log).tm);
    rearm.clearSettledPendingWake({ agentId: "a", kind: "shell", workId: "w" });
    rearm.disarmPendingWake({ parentAgentId: "a", kind: "shell", workId: "w" });
    assert.deepEqual(log.map((entry) => entry[0]), ["clearOne", "telemetry", "roster", "clearOne", "telemetry", "roster"]);
    assert.deepEqual((log[1]?.[1] as Record<string, unknown>).outcome, "settled");
    assert.deepEqual((log[4]?.[1] as Record<string, unknown>).reason, "aborted");

    const silent: unknown[][] = [];
    const rearmSilent = new rearmModule.PendingWakeRearm(makeTm(silent, { clearResult: false }).tm);
    rearmSilent.clearSettledPendingWake({ agentId: "a", kind: "shell", workId: "w" });
    rearmSilent.disarmPendingWake({ parentAgentId: "a", kind: "shell", workId: "w" });
    assert.deepEqual(silent.map((entry) => entry[0]), ["clearOne", "clearOne"]);
  });

  it("prunes the stale wakes and re-arms the rest, leaving gone agents alone", async () => {
    const log: unknown[][] = [];
    const tm = makeTm(log, {
      prune: [marker({ quietOrigin: { x: 1 } })],
      list: [marker({ agentId: "gone" }), marker({ kind: "shell", interruptedByRecreate: true }), marker({ kind: "cloud-agent", workId: "w2" })],
      gone: ["gone"],
      watchArmed: ["w2"],
    }).tm;
    await new rearmModule.PendingWakeRearm(tm).rearmPendingWakes();
    await settle();
    const kinds = log.map((entry) => entry[0]);
    assert.equal(kinds.includes("pruneStale"), true);
    const telemetry = log.filter((entry) => entry[0] === "telemetry").map((entry) => entry[1] as Record<string, unknown>);
    assert.deepEqual(telemetry.map((report) => report.outcome), ["pruned", "rearm_skipped", "rearmed", "persisted", "rearmed"]);
    assert.deepEqual(telemetry[0]?.reason, "stale");
    assert.deepEqual(telemetry[1]?.reason, "agent_gone");
    const cleared = log.filter((entry) => entry[0] === "clearOne").map((entry) => entry[2]);
    assert.deepEqual(cleared, ["cloud-agent"], "the interrupted shell is kept for its notice");
  });

  it("re-arms a cloud agent watch, and reports when the watch did not take", async () => {
    const armedLog: unknown[][] = [];
    await new rearmModule.PendingWakeRearm(makeTm(armedLog, { watchArmed: ["w1"] }).tm).rearmPendingWake(marker({ kind: "cloud-agent" }) as never, 250);
    assert.equal(armedLog.some((entry) => entry[0] === "markPending"), true, "an already-armed watch is written down again");
    assert.equal((armedLog.filter((entry) => entry[0] === "telemetry").pop()?.[1] as Record<string, unknown>).outcome, "rearmed");

    const failedLog: unknown[][] = [];
    await new rearmModule.PendingWakeRearm(makeTm(failedLog, { watchTakes: false }).tm).rearmPendingWake(marker({ kind: "cloud-agent" }) as never, 250);
    const last = failedLog.filter((entry) => entry[0] === "telemetry").pop()?.[1] as Record<string, unknown>;
    assert.equal(last.outcome, "rearm_failed");
    assert.equal(last.reason, "watch_not_armed");
  });

  it("re-arms a shell wake and revives a subagent's parent with the failure it missed", async () => {
    const shellLog: unknown[][] = [];
    await new rearmModule.PendingWakeRearm(makeTm(shellLog).tm).rearmPendingWake(marker({ title: "my shell", quietOrigin: { q: 1 } }) as never, 250);
    assert.deepEqual(shellLog[0], ["watchBackgroundShell", "w1", { title: "my shell", quietOrigin: { q: 1 } }]);

    const subagentLog: unknown[][] = [];
    await new rearmModule.PendingWakeRearm(makeTm(subagentLog).tm).rearmPendingWake(marker({ kind: "subagent", title: "task", subagentType: "explore" }) as never, 250);
    assert.deepEqual(subagentLog[0]?.[0], "markPending");
    const completion = subagentLog.find((entry) => entry[0] === "backgroundWakes")?.[1] as Record<string, unknown>;
    assert.equal(completion.subagentType, "explore");
    assert.equal(completion.status, "error");
    assert.equal(completion.title, "task");
    assert.equal(typeof completion.result, "string");
    const last = subagentLog.filter((entry) => entry[0] === "telemetry").pop()?.[1] as Record<string, unknown>;
    assert.equal(last.outcome, "rearmed");
    assert.equal(last.reason, "interrupted_completion");
  });

  it("skips a group session, an unsupported kind and a re-arm with a success reason, and names a default subagent type", async () => {
    const groupLog: unknown[][] = [];
    await new rearmModule.PendingWakeRearm(makeTm(groupLog, { groupSession: true }).tm).rearmPendingWake(marker({ kind: "shell", interruptedByRecreate: true }) as never, 250);
    assert.equal((groupLog.filter((entry) => entry[0] === "telemetry").pop()?.[1] as Record<string, unknown>).reason, "group_session");
    assert.equal(groupLog.some((entry) => entry[0] === "clearOne"), true, "an interrupted shell is cleared in a group session");

    const unknownLog: unknown[][] = [];
    await new rearmModule.PendingWakeRearm(makeTm(unknownLog).tm).rearmPendingWake(marker({ kind: "weird" }) as never, 250);
    assert.equal((unknownLog.filter((entry) => entry[0] === "telemetry").pop()?.[1] as Record<string, unknown>).reason, "unsupported_kind");

    const reasonLog: unknown[][] = [];
    await new rearmModule.PendingWakeRearm(makeTm(reasonLog).tm).rearmPendingWake(marker() as never, 250, { successReason: "restart" });
    assert.equal((reasonLog.filter((entry) => entry[0] === "telemetry").pop()?.[1] as Record<string, unknown>).reason, "restart");

    const defaultTypeLog: unknown[][] = [];
    await new rearmModule.PendingWakeRearm(makeTm(defaultTypeLog).tm).rearmPendingWake(marker({ kind: "subagent" }) as never, 250);
    const completion = defaultTypeLog.find((entry) => entry[0] === "backgroundWakes")?.[1] as Record<string, unknown>;
    assert.equal(completion.subagentType, "task");
  });

  it("reports a session it cannot resolve or a branch that throws, and queues for present agents only", async () => {
    const resolveLog: unknown[][] = [];
    await new rearmModule.PendingWakeRearm(makeTm(resolveLog, { resolveFails: true }).tm).rearmPendingWake(marker() as never, 250);
    assert.equal((resolveLog.filter((entry) => entry[0] === "telemetry").pop()?.[1] as Record<string, unknown>).reason, "session_unavailable");
    assert.equal(resolveLog.some((entry) => entry[0] === "markPending"), true);

    const throwLog: unknown[][] = [];
    await new rearmModule.PendingWakeRearm(makeTm(throwLog, { failBranch: true }).tm).rearmPendingWake(marker() as never, 250);
    assert.equal((throwLog.filter((entry) => entry[0] === "telemetry").pop()?.[1] as Record<string, unknown>).reason, "error");

    const queue = new Map<string, number[]>();
    const rearm = new rearmModule.PendingWakeRearm(makeTm([], { gone: ["gone"] }).tm);
    assert.equal(rearm.enqueuePendingWake(queue, "gone", [1]), false);
    assert.equal(rearm.enqueuePendingWake(queue, "a", [1, 2]), true);
    assert.equal(rearm.enqueuePendingWake(queue, "a", [3]), true);
    assert.deepEqual([...queue.entries()], [["a", [1, 2, 3]]]);
  });
});