/**
 * Waking a conversation because something it started in the background finished: the prompts, the queue per
 * conversation, what each outcome is reported as, and what happens to a follow-up that could not run.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CompletionRevivals,
  QUIET_REVIVAL_INSTRUCTION,
  buildShellRevivalPrompt,
  buildSubagentRevivalPrompt,
  describeQuietOriginNote,
  describeShellOutcome,
  isAllQuietOrigin,
  type ShellCompletion,
  type SubagentCompletion,
} from "../../source/host/transcript/completion-revivals.ts";
import type { QuietWakeOrigin } from "../../source/host/transcript/slate-pending-wake-store.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };

const quiet: QuietWakeOrigin = { automation: { id: "daily-report", name: "Daily report" } };
const subagentDone = (overrides: Partial<SubagentCompletion> = {}): SubagentCompletion => ({
  parentAgentId: "agent-1",
  subagentAgentId: "sub-1",
  title: "Find the flaky test",
  subagentType: "generalPurpose",
  status: "success",
  result: "It is the cache test.",
  ...overrides,
});
const shellDone = (overrides: Partial<ShellCompletion> = {}): ShellCompletion => ({
  agentId: "agent-1",
  shellId: "shell-1",
  title: "npm test",
  status: "success",
  ...overrides,
});

/** A transcript manager with the queue, the run surface and the reporting a revival reaches for. */
function world(
  options: {
    canExecute?: boolean;
    gone?: string[];
    sessionError?: Error;
    runResult?: Record<string, unknown>;
    runError?: Error;
    enqueueAccepted?: boolean;
    unanswered?: { skippedQuestionPrompts: string[]; dismissedQuestionPrompts: string[] };
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const session = { id: "agent-1" };
  const runner = {
    run: async (prompt: string, runOptions: Record<string, unknown>) => {
      record("run", prompt, runOptions);
      if (options.runError !== undefined) throw options.runError;
      return options.runResult ?? { sentMessageCount: 2, reacted: false, aborted: false };
    },
  };
  const tm = {
    execution: { canExecute: options.canExecute !== false },
    sessions: {
      deletedAgentIds: new Set<string>(options.gone ?? []),
      resolveBackgroundSession: async (agentId: string) => {
        record("resolveBackgroundSession", agentId);
        if (options.sessionError !== undefined) throw options.sessionError;
        return session;
      },
    },
    runnerRegistry: { getRunner: (target: unknown) => { record("getRunner"); return runner; } },
    runLifecycle: {
      lastRequestIdBySession: new Map<string, string>([["agent-1", "req-5"]]),
      beginSessionRun: (target: unknown) => record("beginSessionRun"),
      endSessionRun: (target: unknown) => record("endSessionRun"),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => {
        record("enqueueExclusiveRun", id, meta);
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
    upgradeResume: { markAgentResumePendingForQuiescedRevival: (target: unknown) => record("markQuiescedRevival") },
    pendingWakes: {
      clearSettledPendingWake: (args: unknown) => record("clearSettledPendingWake", args),
      enqueuePendingWake: (queue: unknown, agentId: string, completions: unknown) => {
        record("enqueuePendingWake", agentId);
        if (options.enqueueAccepted === false) return false;
        const map = queue as Map<string, unknown[]>;
        map.set(agentId, [...(map.get(agentId) ?? []), ...(completions as unknown[])]);
        return true;
      },
    },
    roster: { emitAgentUpdate: async (id: string) => record("emitAgentUpdate", id) },
    telemetry: {
      reportSubagentRevival: (report: unknown) => record("reportSubagentRevival", report),
      reportShellRevival: (report: unknown) => record("reportShellRevival", report),
      reportAgentError: (report: unknown) => record("reportAgentError", report),
    },
    trayErrors: { pushError: (error: unknown) => record("pushError", error) },
  };
  const revivals = new CompletionRevivals(tm);
  return {
    revivals, tm, session, calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    lastRun: () => calls.filter((call) => call.name === "run").at(-1)?.args ?? null,
  };
}

describe("what a revival prompt says", () => {
  it("names the routine a quiet run came from, or says it was self-initiated", () => {
    assert.equal(describeQuietOriginNote(quiet), `(You started this during your routine "Daily report" (folder daily-report) — nobody is waiting on it.)`);
    assert.equal(describeQuietOriginNote({}), "(You started this during one of your own quiet self-initiated runs — nobody is waiting on it.)");
    // Every completion has to be quiet for the quiet instruction to apply; an empty list counts as all quiet.
    assert.deepEqual([isAllQuietOrigin([]), isAllQuietOrigin([{ quietOrigin: quiet }]), isAllQuietOrigin([{ quietOrigin: quiet }, {}])], [true, true, false]);
  });

  it("introduces one finished subagent or several, with what each one produced", () => {
    const one = buildSubagentRevivalPrompt([subagentDone()]);
    assert.match(one, /^\[A background task just completed\] A background task you started has finished\./);
    assert.match(one, /Background task "Find the flaky test" \(generalPurpose\) finished:\nIt is the cache test\./);
    assert.equal(one.includes("nobody is waiting on it"), false);
    assert.match(one, /Lead with the concrete thing that finished, not a bare pronoun like "That"/);
    const many = buildSubagentRevivalPrompt([subagentDone(), subagentDone({ subagentAgentId: "sub-2", title: "Write the report", status: "error", result: "No space left." })]);
    assert.match(many, /2 background tasks you started have finished\./);
    assert.match(many, /Background task "Write the report" \(generalPurpose\) failed:\nNo space left\./);
    // A quiet run carries the note, and a group of only-quiet completions uses the quiet instruction instead.
    const quietRun = buildSubagentRevivalPrompt([subagentDone({ quietOrigin: quiet })]);
    assert.match(quietRun, /\(You started this during your routine "Daily report" \(folder daily-report\) — nobody is waiting on it\.\)/);
    assert.match(quietRun, new RegExp(QUIET_REVIVAL_INSTRUCTION.slice(0, 40)));
    assert.equal(quietRun.includes("Lead with the concrete thing"), false);
    // One quiet and one not: the ordinary instruction governs, but the quiet one is still noted.
    const mixed = buildSubagentRevivalPrompt([subagentDone({ quietOrigin: quiet }), subagentDone({ subagentAgentId: "sub-2" })]);
    assert.match(mixed, /Lead with the concrete thing/);
    assert.match(mixed, /nobody is waiting on it/);
  });

  it("describes how a background command ended and what it left behind", () => {
    assert.deepEqual([describeShellOutcome("success"), describeShellOutcome("aborted"), describeShellOutcome("failed")], ["finished", "was stopped", "failed"]);
    const one = buildShellRevivalPrompt([shellDone({ detail: "exit 1", outputPath: "/tmp/shell-1.log" })]);
    assert.match(one, /^\[A background command just completed\] A command you started in the background has finished\./);
    assert.match(one, /Background command "npm test" finished\.\nexit 1\nFull output: \/tmp\/shell-1\.log/);
    const many = buildShellRevivalPrompt([shellDone({ status: "aborted", quietOrigin: quiet })]);
    assert.match(many, /Background command "npm test" was stopped\./);
    assert.match(many, /nobody is waiting on it/);
    assert.match(many, new RegExp(QUIET_REVIVAL_INSTRUCTION.slice(0, 40)));
    // Without a detail or a path there are no such lines at all.
    const bare = buildShellRevivalPrompt([shellDone()]);
    assert.equal(bare.includes("Full output:"), false);
    assert.match(buildShellRevivalPrompt([shellDone(), shellDone({ shellId: "shell-2" })]), /2 commands you started in the background have finished\./);
  });
});

describe("reviving a conversation for a finished subagent", () => {
  it("drops a completion whose conversation was deleted, and queues a repeated one only once", () => {
    const deleted = world({ gone: ["agent-1"] });
    deleted.revivals.handleBackgroundSubagentCompletion(subagentDone());
    assert.deepEqual(deleted.named("reportSubagentRevival")[0]?.args, [
      { parentAgentId: "agent-1", outcome: "dropped", completionCount: 1, subagentType: "generalPurpose", subagentAgentId: "sub-1", reason: "agent_deleted" },
    ]);
    assert.equal(deleted.revivals.pendingSubagentCompletions.size, 0);
    // The same subagent finishing twice is one completion; a different one joins it.
    const repeated = world({ canExecute: false });
    repeated.revivals.handleBackgroundSubagentCompletion(subagentDone());
    repeated.revivals.handleBackgroundSubagentCompletion(subagentDone());
    repeated.revivals.handleBackgroundSubagentCompletion(subagentDone({ subagentAgentId: "sub-2" }));
    assert.deepEqual(repeated.revivals.pendingSubagentCompletions.get("agent-1")?.map((completion) => completion.subagentAgentId), ["sub-1", "sub-2"]);
  });

  it("clears the wakes that settled, runs the revival, and reports what it came to", async () => {
    const world1 = world();
    world1.revivals.pendingSubagentCompletions.set("agent-1", [subagentDone({ subagentType: "cursor-agent", quietOrigin: quiet }), subagentDone({ subagentAgentId: "sub-2" })]);
    await world1.revivals.reviveForSubagentCompletions("agent-1");
    // A cloud agent's wake is tracked as one; a local subagent's as another.
    assert.deepEqual(world1.named("clearSettledPendingWake").map((call) => (call.args[0] as { kind: string; workId: string })), [
      { agentId: "agent-1", kind: "cloud-agent", workId: "sub-1" },
      { agentId: "agent-1", kind: "subagent", workId: "sub-2" },
    ]);
    assert.deepEqual(world1.named("reportSubagentRevival")[0]?.args, [
      { parentAgentId: "agent-1", outcome: "delivered", sentMessageCount: 2, completionCount: 2, subagentType: "cursor-agent", isQuietOrigin: false },
    ]);
    assert.equal(world1.revivals.pendingSubagentCompletions.size, 0);
    assert.equal(world1.revivals.revivingSubagentAgentIds.size, 0);
    // Nothing to run, or already reviving, and nothing happens.
    const idle = world();
    await idle.revivals.reviveForSubagentCompletions("agent-1");
    const guarded = world();
    guarded.revivals.revivingSubagentAgentIds.add("agent-1");
    guarded.revivals.pendingSubagentCompletions.set("agent-1", [subagentDone()]);
    await guarded.revivals.reviveForSubagentCompletions("agent-1");
    // The wake that is already running keeps its claim: the queue was not drained and the guard was not released.
    assert.deepEqual([guarded.named("run").length, guarded.revivals.revivingSubagentAgentIds.has("agent-1")], [0, true]);
    const cannotRun = world({ canExecute: false });
    cannotRun.revivals.pendingSubagentCompletions.set("agent-1", [subagentDone()]);
    await cannotRun.revivals.reviveForSubagentCompletions("agent-1");
    assert.deepEqual([idle.calls.length, guarded.calls.length, cannotRun.named("run").length], [0, 0, 0]);
  });

  it("runs the follow-up as a hidden background turn and says how it ended", async () => {
    const world1 = world({ runResult: { sentMessageCount: 3, reacted: false, aborted: false }, unanswered: { skippedQuestionPrompts: ["q1"], dismissedQuestionPrompts: [] } });
    assert.deepEqual(await world1.revivals.runSubagentRevival("agent-1", [subagentDone()]), { outcome: "delivered", sentMessageCount: 3 });
    const [prompt, runOptions] = world1.lastRun() as [string, Record<string, unknown>];
    assert.match(prompt, /A background task you started has finished\./);
    assert.deepEqual([runOptions.hidden, runOptions.isSilenceAllowed, runOptions.autoReviewEpoch, runOptions.skippedQuestionPrompts?.toString()], [true, true, "continue", ["q1"].toString()]);
    assert.deepEqual(world1.named("enqueueExclusiveRun")[0]?.args[1], { lane: "background", source: "subagent-revival" });
    assert.equal(world1.tm.turnRuntime.activeRequestSources.get("agent-1"), "background-revival");
    assert.deepEqual(world1.named("emitAgentUpdate")[0]?.args, ["agent-1"]);
    assert.equal(world1.named("endSessionRun").length, 1);
    // An aborted follow-up is superseded; a quiesced one is dropped and marked for the upgrade to resume.
    const aborted = world({ runResult: { sentMessageCount: 0, reacted: false, aborted: true } });
    assert.deepEqual(await aborted.revivals.runSubagentRevival("agent-1", [subagentDone()]), { outcome: "superseded" });
    const quiesced = world({ runResult: { sentMessageCount: 0, reacted: false, aborted: false, quiescedForUpgrade: true } });
    assert.deepEqual(await quiesced.revivals.runSubagentRevival("agent-1", [subagentDone()]), { outcome: "dropped", reason: "quiesced" });
    assert.equal(quiesced.named("markQuiescedRevival").length, 1);
    assert.equal(aborted.named("markQuiescedRevival").length, 0);
  });

  it("says why a follow-up never ran", async () => {
    const world1 = world();
    assert.deepEqual(await world1.revivals.runSubagentRevival("agent-1", []), { outcome: "delivered" });
    assert.equal(world1.calls.length, 0);
    const cannotRun = world({ canExecute: false });
    assert.deepEqual(await cannotRun.revivals.runSubagentRevival("agent-1", [subagentDone()]), { outcome: "dropped", reason: "no_runner" });
    const unopenable = world({ sessionError: new Error("gone") });
    assert.deepEqual(await unopenable.revivals.runSubagentRevival("agent-1", [subagentDone()]), { outcome: "dropped", reason: "session_unavailable" });
    const failed = world({ runError: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    assert.deepEqual(await failed.revivals.runSubagentRevival("agent-1", [subagentDone()]), { outcome: "dropped", reason: "error" });
    const report = failed.named("reportAgentError")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.source, report.conversationId, report.requestId], ["background_followup", "agent-1", "req-5"]);
    assert.deepEqual(report.error, { code: SlateError.streamReset()["code"], connectCode: undefined, errno: "ECONNRESET" });
    assert.equal((failed.named("pushError")[0]?.args[0] as Record<string, unknown>).title, "Background task follow-up failed");
    assert.equal(failed.named("endSessionRun").length, 1);
  });
});

describe("reviving a conversation for a finished command", () => {
  it("queues the completion, or reports it dropped when the agent is gone", async () => {
    const world1 = world();
    world1.revivals.handleBackgroundShellCompletion(shellDone());
    assert.deepEqual(world1.named("enqueuePendingWake")[0]?.args[0], "agent-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(world1.named("run").length, 1);
    const gone = world({ enqueueAccepted: false });
    gone.revivals.handleBackgroundShellCompletion(shellDone({ quietOrigin: quiet }));
    assert.deepEqual(gone.named("reportShellRevival")[0]?.args, [
      { conversationId: "agent-1", outcome: "dropped", completionCount: 1, isQuietOrigin: true, reason: "agent_gone" },
    ]);
    assert.equal(gone.named("run").length, 0);
  });

  it("clears the settled wake and drains the queue one pass at a time", async () => {
    const world1 = world({ runResult: { sentMessageCount: 1, reacted: false, aborted: false } });
    world1.revivals.pendingShellCompletions.set("agent-1", [shellDone()]);
    await world1.revivals.reviveForShellCompletions("agent-1");
    assert.deepEqual(world1.named("clearSettledPendingWake")[0]?.args, [{ agentId: "agent-1", kind: "shell", workId: "shell-1" }]);
    assert.deepEqual(world1.named("reportShellRevival")[0]?.args, [
      { conversationId: "agent-1", outcome: "delivered", completionCount: 1, isQuietOrigin: false, sentMessageCount: 1 },
    ]);
    // The guard keeps a second pass out while one is running.
    const guarded = world();
    guarded.revivals.revivingShellAgentIds.add("agent-1");
    await guarded.revivals.reviveForShellCompletions("agent-1");
    assert.equal(guarded.calls.length, 0);
    const cannotRun = world({ canExecute: false });
    await cannotRun.revivals.reviveForShellCompletions("agent-1");
    assert.equal(cannotRun.calls.length, 0);
  });

  it("runs the command follow-up under its own source and reports how it ended", async () => {
    const world1 = world({ runResult: { sentMessageCount: 4, reacted: false, aborted: false } });
    await world1.revivals.runShellRevival("agent-1", [shellDone({ outputPath: "/tmp/shell-1.log" })]);
    assert.deepEqual(world1.named("enqueueExclusiveRun")[0]?.args[1], { lane: "background", source: "shell-revival" });
    assert.match(String(world1.lastRun()?.[0]), /Full output: \/tmp\/shell-1\.log/);
    assert.deepEqual(world1.named("reportShellRevival")[0]?.args, [
      { conversationId: "agent-1", outcome: "delivered", completionCount: 1, isQuietOrigin: false, sentMessageCount: 4 },
    ]);
    assert.equal(world1.named("endSessionRun").length, 1);
    // Nothing to run, nothing to report.
    const empty = world();
    await empty.revivals.runShellRevival("agent-1", []);
    assert.equal(empty.calls.length, 0);
    // Each way a follow-up can fail is reported as such.
    const cases: Array<[worldReturn, Record<string, unknown>, string]> = [
      [world({ canExecute: false }), { outcome: "dropped", reason: "no_runner" }, "run"],
      [world({ sessionError: new Error("gone") }), { outcome: "dropped", reason: "session_unavailable" }, "run"],
      [world({ runResult: { sentMessageCount: 0, reacted: false, aborted: true } }), { outcome: "superseded" }, "run"],
      [world({ runResult: { sentMessageCount: 0, reacted: false, aborted: false, quiescedForUpgrade: true } }), { outcome: "dropped", reason: "quiesced" }, "run"],
      [world({ runError: new Error("boom") }), { outcome: "dropped", reason: "error" }, "run"],
    ];
    for (const [blocked, expected, _] of cases) {
      await blocked.revivals.runShellRevival("agent-1", [shellDone()]);
      const report = blocked.named("reportShellRevival")[0]?.args[0] as Record<string, unknown>;
      assert.deepEqual([report.outcome, report.reason], [expected.outcome, expected.reason]);
    }
    // The quiesced case leaves a marker for the upgrade to pick the work up again.
    const quiesced = world({ runResult: { sentMessageCount: 0, reacted: false, aborted: false, quiescedForUpgrade: true } });
    await quiesced.revivals.runShellRevival("agent-1", [shellDone()]);
    assert.equal(quiesced.named("markQuiescedRevival").length, 1);
    assert.equal(quiesced.named("reportAgentError").length, 0);
    // A failed follow-up says which one it was about.
    const failed = world({ runError: new Error("boom") });
    await failed.revivals.runShellRevival("agent-1", [shellDone()]);
    assert.equal((failed.named("pushError")[0]?.args[0] as Record<string, unknown>).title, "Background command follow-up failed");
  });
});

type worldReturn = ReturnType<typeof world>;
