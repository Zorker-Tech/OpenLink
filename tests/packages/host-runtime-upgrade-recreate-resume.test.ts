/**
 * Resuming what an update interrupted: what is marked, what is carried across a rebuild, and what each conversation is
 * told when it comes back.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UpgradeRecreateResume, buildUpgradeResumePrompt, type UpgradeResumeMarker } from "../../source/host/transcript/upgrade-recreate-resume.ts";
import type { DurablePendingWakeMarker } from "../../source/host/transcript/slate-pending-wake-store.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };

const markerFor = (agentId: string, overrides: Partial<UpgradeResumeMarker> = {}): UpgradeResumeMarker => ({
  agentId,
  markedAtMs: 1_000,
  ...overrides,
});
const wakeFor = (agentId: string, overrides: Partial<DurablePendingWakeMarker> = {}): DurablePendingWakeMarker => ({
  agentId,
  kind: "cloud-agent",
  workId: "work-1",
  markedAtMs: 900,
  ...overrides,
});

/** A transcript manager with the run surface, stores and runners an upgrade reaches for. */
function world(
  options: {
    inFlight?: string[];
    running?: string[];
    sources?: Record<string, string>;
    pendingMarkers?: UpgradeResumeMarker[];
    pendingWakes?: DurablePendingWakeMarker[];
    canExecute?: boolean;
    gone?: string[];
    group?: boolean;
    groupAgent?: boolean;
    sessionError?: Error;
    runError?: Error;
    automations?: Record<string, { id: string; name: string }>;
    liveRunning?: string[];
    revivingSubagents?: string[];
    revivingShells?: string[];
    runningShellWork?: boolean;
    hasStore?: boolean;
    hasWakeStore?: boolean;
    markPendingResult?: boolean;
    hasPendingLocally?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const session = { id: "agent-1", automations: { get: (id: string) => options.automations?.[id] ?? null } };
  const runner = {
    requestQuiesceForUpgrade: () => record("requestQuiesceForUpgrade"),
    cancelQuiesceForUpgrade: () => record("cancelQuiesceForUpgrade"),
    run: async (prompt: string, runOptions: Record<string, unknown>) => {
      record("run", prompt, runOptions);
      if (options.runError !== undefined) throw options.runError;
      return { sentMessageCount: 1, reacted: false, aborted: false };
    },
  };
  const groupRunner = { requestQuiesceForUpgrade: () => record("groupQuiesce"), cancelQuiesceForUpgrade: () => record("groupCancelQuiesce") };
  let pending = [...(options.pendingMarkers ?? [])];
  const upgradeResumeStore = {
    markPending: (marker: UpgradeResumeMarker) => {
      record("markPending", marker);
      pending.push(marker);
    },
    listPending: () => [...pending],
    clear: (agentId: string) => {
      record("clear", agentId);
      pending = pending.filter((marker) => marker.agentId !== agentId);
    },
    clearAll: () => {
      record("clearAll");
      pending = [];
    },
  };
  const pendingWakeStore = {
    listPending: () => options.pendingWakes ?? [],
    hasPending: (agentId: string, kind: string, workId: string) => {
      record("hasPending", agentId, kind, workId);
      return options.hasPendingLocally === true;
    },
    markPending: (marker: DurablePendingWakeMarker) => {
      record("markPendingWake", marker);
      return options.markPendingResult !== false;
    },
  };
  const tm = {
    execution: { canExecute: options.canExecute !== false },
    traceFlusher: () => record("traceFlusher"),
    upgradeResumeStore: options.hasStore === false ? undefined : upgradeResumeStore,
    pendingWakeStore: options.hasWakeStore === false ? undefined : pendingWakeStore,
    runLifecycle: {
      inFlightRunCounts: new Map((options.inFlight ?? []).map((id) => [{ id }, 1])),
      runningAgentIds: () => new Set<string>(options.running ?? []),
      lastRequestIdBySession: new Map<string, string>([["agent-1", "req-7"]]),
      beginSessionRun: (target: unknown) => record("beginSessionRun"),
      endSessionRun: (target: unknown) => record("endSessionRun"),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => {
        record("enqueueExclusiveRun", id, meta);
        return await work();
      },
    },
    runnerRegistry: {
      runners: new Map([[session.id, runner]]),
      activeGroupMemberRunners: new Map([[session.id, groupRunner]]),
      getRunner: (target: unknown) => {
        record("getRunner");
        return runner;
      },
    },
    turnRuntime: { activeRequestSources: new Map(Object.entries(options.sources ?? {})) },
    sessions: {
      isAgentGone: (agentId: string) => (options.gone ?? []).includes(agentId),
      resolveBackgroundSession: async (agentId: string) => {
        record("resolveBackgroundSession", agentId);
        if (options.sessionError !== undefined) throw options.sessionError;
        return session;
      },
    },
    groupChat: { isGroupSession: () => options.group === true, isGroupAgentId: () => options.groupAgent === true },
    ackObligations: {
      mintAckRunToken: (agentId: string) => {
        record("mintAckRunToken", agentId);
        return "ack-token-1";
      },
      retireAckRunToken: (agentId: string, token: string | undefined) => record("retireAckRunToken", agentId, token),
    },
    roster: { emitAgentUpdate: async (agentId: string) => record("emitAgentUpdate", agentId) },
    automationRuntime: { emitAutomations: (target: unknown) => record("emitAutomations") },
    telemetry: {
      reportAgentError: (report: unknown) => record("reportAgentError", report),
      reportPendingWake: (report: unknown) => record("reportPendingWake", report),
    },
    trayErrors: { pushError: (error: unknown) => record("pushError", error) },
    backgroundWakes: {
      revivingSubagentAgentIds: new Set<string>(options.revivingSubagents ?? []),
      revivingShellAgentIds: new Set<string>(options.revivingShells ?? []),
      handleBackgroundShellCompletion: (completion: unknown) => record("handleBackgroundShellCompletion", completion),
    },
    pendingWakes: { rearmPendingWake: (marker: unknown, now: number, opts: unknown) => record("rearmPendingWake", marker, now, opts) },
    liveRunningAgentIds: () => options.liveRunning ?? [],
    hasRunningBackgroundShellWork: () => options.runningShellWork === true,
    quiesceForUpgrade: async () => {
      record("quiesceForUpgrade");
      return { quiescing: true };
    },
  };
  const resume = new UpgradeRecreateResume(tm);
  return {
    resume, tm, session, runner, groupRunner, calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    pendingMarkers: () => pending,
    lastRun: () => calls.filter((call) => call.name === "run").at(-1)?.args ?? null,
  };
}

describe("what a resumed conversation is told", () => {
  it("says what interrupted it and what may be left unsaid", () => {
    const plain = buildUpgradeResumePrompt("turn");
    assert.match(plain, /interrupted you mid-task/);
    assert.match(plain, /full conversation intact/);
    assert.match(plain, /do NOT repeat it/);
    assert.equal(plain.includes("nobody is waiting"), false);
    const automation = buildUpgradeResumePrompt("automation");
    assert.match(automation, /interrupted a scheduled routine run mid-task/);
    assert.match(automation, /still that routine's own run/);
    assert.match(automation, /ending with no SendMessage remains a valid outcome/);
    const revival = buildUpgradeResumePrompt("background-revival");
    assert.match(revival, /interrupted one of your background-work follow-ups mid-delivery/);
    assert.match(revival, /ending with no SendMessage remains a valid outcome/);
    // Any other source is treated as a plain interrupt.
    assert.equal(buildUpgradeResumePrompt("handoff-resume"), plain);
  });
});

describe("asking the runs to stop for an update", () => {
  it("quiesces every in-flight conversation, including its group members", async () => {
    const world1 = world({ inFlight: ["agent-1", "agent-2"], running: ["agent-1", "agent-2", "agent-3"] });
    assert.deepEqual(await world1.resume.quiesceForUpgrade(), { quiescing: true, runningTurns: 3 });
    assert.equal(world1.resume.isQuiescingForUpgrade(), true);
    assert.equal(world1.named("traceFlusher").length, 1);
    // The in-flight conversation's runners were asked to quiesce, its group member included; a conversation with no
    // runner of its own is skipped rather than treated as a failure.
    assert.deepEqual(
      [world1.named("requestQuiesceForUpgrade").length, world1.named("groupQuiesce").length],
      [1, 1],
    );
  });

  it("marks what each in-flight conversation was doing, and the source it was doing it under", () => {
    const world1 = world({ inFlight: ["agent-1", "agent-2"], sources: { "agent-2": "automation" } });
    world1.resume.markAllRunningAgentsForUpgradeResume();
    const markers = world1.pendingMarkers();
    assert.deepEqual(markers.map((marker) => [marker.agentId, marker.source]), [["agent-1", "turn"], ["agent-2", "automation"]]);
    assert.equal(typeof markers[0]?.markedAtMs, "number");
    // A wake that was reviving is marked as a revival, and only once.
    const revival = world({ inFlight: ["agent-1"], sources: { "agent-1": "background-revival" } });
    revival.resume.markAllRunningAgentsForUpgradeResume();
    revival.resume.markAllRunningAgentsForUpgradeResume();
    assert.deepEqual(revival.pendingMarkers().map((marker) => marker.source), ["background-revival"]);
    // An automation's own run carries the automation it belongs to.
    const withAutomation = world({ inFlight: ["agent-1"] });
    withAutomation.resume.markAgentResumePending(withAutomation.session, "automation", { automationId: "auto-1", automationRunId: "run-1" });
    assert.deepEqual(withAutomation.pendingMarkers()[0], { agentId: "agent-1", markedAtMs: withAutomation.pendingMarkers()[0]?.markedAtMs, source: "automation", automationId: "auto-1", automationRunId: "run-1" });
  });

  it("brings the marked conversations back, skipping the ones whose agent is gone", async () => {
    const world1 = world({ pendingMarkers: [markerFor("agent-1"), markerFor("gone-1")], gone: ["gone-1"] });
    await world1.resume.resumeInterruptedUpgradeTurns();
    // The ledger is emptied up front, so a crash mid-resume does not resume everything twice.
    assert.deepEqual(world1.named("clearAll").length, 1);
    assert.deepEqual(world1.named("resolveBackgroundSession").map((call) => call.args[0]), ["agent-1"]);
    const world2 = world({ pendingMarkers: [markerFor("agent-1")], canExecute: false });
    await world2.resume.resumeInterruptedUpgradeTurns();
    const world3 = world({ hasStore: false });
    await world3.resume.resumeInterruptedUpgradeTurns();
    const world4 = world({ pendingMarkers: [] });
    await world4.resume.resumeInterruptedUpgradeTurns();
    assert.deepEqual([world2.calls.length, world3.calls.length, world4.calls.length], [0, 0, 0]);
  });
});

describe("resuming one conversation", () => {
  it("runs the continuation hidden, under the source it was interrupted in", async () => {
    const world1 = world({ pendingMarkers: [markerFor("agent-1", { source: "handoff-resume" })] });
    await world1.resume.resumeUpgradeAgent(world1.pendingMarkers()[0] as UpgradeResumeMarker);
    assert.deepEqual(world1.named("enqueueExclusiveRun")[0]?.args[1], { lane: "background", source: "upgrade-resume", ackToken: "ack-token-1" });
    const [prompt, runOptions] = world1.lastRun() as [string, Record<string, unknown>];
    assert.match(prompt, /interrupted you mid-task/);
    assert.deepEqual([runOptions.hidden, runOptions.requestSource, runOptions.ackToken, runOptions.isSilenceAllowed], [true, "handoff-resume", "ack-token-1", false]);
    assert.equal(world1.tm.turnRuntime.activeRequestSources.get("agent-1"), "handoff-resume");
    assert.deepEqual(world1.named("emitAgentUpdate")[0]?.args, ["agent-1"]);
    assert.equal(world1.named("emitAutomations").length, 1);
    assert.deepEqual(world1.named("retireAckRunToken")[0]?.args, ["agent-1", "ack-token-1"]);
    assert.equal(world1.named("endSessionRun").length, 1);
    // A notice is not a handoff: it comes back as a background revival and may end silently.
    const notification = world({ pendingMarkers: [markerFor("agent-1", { source: "notification" })] });
    await notification.resume.resumeUpgradeAgent(notification.pendingMarkers()[0] as UpgradeResumeMarker);
    assert.equal(notification.named("mintAckRunToken").length, 0);
    const [revivalPrompt, revivalOptions] = notification.lastRun() as [string, Record<string, unknown>];
    assert.match(revivalPrompt, /background-work follow-ups/);
    assert.deepEqual([revivalOptions.requestSource, revivalOptions.isSilenceAllowed, revivalOptions.ackToken], ["background-revival", true, undefined]);
  });

  it("carries the automation a scheduled run belongs to", async () => {
    const world1 = world({ pendingMarkers: [markerFor("agent-1", { source: "automation", automationId: "auto-1" })], automations: { "auto-1": { id: "auto-1", name: "Morning report" } } });
    await world1.resume.resumeUpgradeAgent(world1.pendingMarkers()[0] as UpgradeResumeMarker);
    const [prompt, runOptions] = world1.lastRun() as [string, Record<string, unknown>];
    assert.match(prompt, /scheduled routine run/);
    assert.deepEqual(runOptions.automationWake, { id: "auto-1", name: "Morning report" });
    assert.equal(runOptions.isSilenceAllowed, true);
    assert.equal(runOptions.ackToken, undefined);
    // An automation that is no longer there is resumed without one.
    const gone = world({ pendingMarkers: [markerFor("agent-1", { source: "automation", automationId: "auto-9" })] });
    await gone.resume.resumeUpgradeAgent(gone.pendingMarkers()[0] as UpgradeResumeMarker);
    assert.equal((gone.lastRun()?.[1] as Record<string, unknown>).automationWake, undefined);
  });

  it("skips a conversation that cannot be opened or that lives in a group", async () => {
    const unopenable = world({ pendingMarkers: [markerFor("agent-1")], sessionError: new Error("no session") });
    await unopenable.resume.resumeUpgradeAgent(unopenable.pendingMarkers()[0] as UpgradeResumeMarker);
    assert.equal(unopenable.named("run").length, 0);
    const group = world({ pendingMarkers: [markerFor("agent-1")], group: true });
    await group.resume.resumeUpgradeAgent(group.pendingMarkers()[0] as UpgradeResumeMarker);
    assert.equal(group.named("run").length, 0);
    assert.equal(group.named("beginSessionRun").length, 0);
  });

  it("reports a continuation that failed, as both telemetry and a tray error", async () => {
    const world1 = world({ pendingMarkers: [markerFor("agent-1")], runError: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    await world1.resume.resumeUpgradeAgent(world1.pendingMarkers()[0] as UpgradeResumeMarker);
    const report = world1.named("reportAgentError")[0]?.args[0] as Record<string, unknown>;
    assert.equal(report.source, "resume");
    assert.equal(report.requestId, "req-7");
    assert.deepEqual(report.error, { code: SlateError.streamReset()["code"], connectCode: undefined, errno: "ECONNRESET" });
    const pushed = world1.named("pushError")[0]?.args[0] as Record<string, unknown>;
    assert.equal(pushed.title, "Agent failed to resume after host update");
    assert.equal(pushed.detail, "socket hang up");
    assert.deepEqual(world1.named("endSessionRun").length, 1);
    assert.equal(world1.pendingMarkers().length, 1);
  });
});

describe("a rebuild that recreates the agents", () => {
  it("counts what is still running, without counting the same agent twice", async () => {
    const world1 = world({
      liveRunning: ["agent-1", "agent-2"],
      revivingSubagents: ["agent-2"],
      revivingShells: ["agent-3"],
      runningShellWork: true,
      pendingMarkers: [markerFor("agent-1")],
      pendingWakes: [wakeFor("agent-1"), wakeFor("agent-2", { kind: "subagent" })],
    });
    assert.deepEqual(await world1.resume.quiesceForRecreate(), {
      quiescing: true,
      runningTurns: 4,
      resumeAgentIds: ["agent-1"],
      resumePendingWakes: [wakeFor("agent-1")],
    });
    assert.equal(world1.resume.hasMidDrainRevival(), true);
    assert.equal(world1.resume.hasCarryablePendingWake(), true);
    // Nothing running and nothing carried is reported as such.
    const quiet = world();
    assert.deepEqual(await quiet.resume.quiesceForRecreate(), { quiescing: true, runningTurns: 0, resumeAgentIds: [], resumePendingWakes: [] });
    assert.deepEqual([quiet.resume.hasMidDrainRevival(), quiet.resume.hasCarryablePendingWake()], [false, false]);
  });

  it("brings the given agents and the locally marked ones back, and lets the runners off quiescing", async () => {
    const world1 = world({ pendingMarkers: [markerFor("agent-1"), markerFor("agent-2")], gone: ["agent-2"] });
    // The update quiesces first; bringing the agents back is what lets the runners go again.
    await world1.resume.quiesceForUpgrade();
    assert.equal(world1.resume.isQuiescingForUpgrade(), true);
    const resumed = await world1.resume.resumeAfterRecreate(["agent-1", "agent-3"], []);
    // agent-1 is named twice (given and local) and resumed once; the gone one is skipped; the given one with no marker
    // is still resumed, from a marker made on the spot.
    assert.deepEqual(resumed, { resumed: 2 });
    assert.deepEqual(world1.named("resolveBackgroundSession").map((call) => call.args[0]), ["agent-1", "agent-3"]);
    assert.equal(world1.resume.isQuiescingForUpgrade(), false);
    assert.equal(world1.named("cancelQuiesceForUpgrade").length, 1);
    assert.equal(world1.named("groupCancelQuiesce").length, 1);
    const synthesized = world1.pendingMarkers().find((marker) => marker.agentId === "agent-1");
    assert.equal(synthesized, undefined);
    // The agents whose markers were used are forgotten, and the agents that were only named get their own.
    assert.deepEqual(world1.named("clear").map((call) => call.args[0]), ["agent-1", "agent-3"]);
  });

  it("carries the wakes that were waiting across the rebuild, and says what happened to each", () => {
    const world1 = world({ pendingWakes: [] });
    const now = Date.now();
    world1.resume.restoreCarriedPendingWakes([
      { ...wakeFor("agent-1"), markedAtMs: now - 500 },
      { ...wakeFor("agent-2", { kind: "subagent" }) },
      wakeFor("agent-3"),
    ]);
    // A carried wake is written to the ledger and rearmed; a kind that is not carried is left out entirely.
    assert.deepEqual(world1.named("markPendingWake").map((call) => (call.args[0] as DurablePendingWakeMarker).agentId), ["agent-1", "agent-3"]);
    const outcomes = world1.named("reportPendingWake").map((call) => call.args[0] as Record<string, unknown>);
    assert.deepEqual(outcomes.map((report) => [report.outcome, report.kind, report.reason]), [["carried", "cloud-agent", undefined], ["carried", "cloud-agent", undefined]]);
    assert.equal(outcomes[0]?.isQuietOrigin, false);
    assert.equal(typeof outcomes[0]?.ageMs, "number");
    assert.deepEqual(world1.named("rearmPendingWake").map((call) => (call.args[2] as { successReason: string }).successReason), ["recreate_carry", "recreate_carry"]);
  });

  it("skips a wake the ledger already has, one whose agent is gone, and one inside a group", () => {
    const already = world({ hasPendingLocally: true });
    already.resume.restoreCarriedPendingWakes([wakeFor("agent-1")]);
    assert.deepEqual(already.named("reportPendingWake").map((call) => (call.args[0] as Record<string, unknown>).reason), ["locally_owned"]);
    assert.equal(already.named("markPendingWake").length, 0);
    assert.deepEqual(already.named("reportPendingWake")[0]?.args[0], { conversationId: "agent-1", outcome: "rearm_skipped", kind: "cloud-agent", workId: "work-1", ageMs: (already.named("reportPendingWake")[0]?.args[0] as { ageMs: number }).ageMs, reason: "locally_owned", isQuietOrigin: false });
    const gone = world({ gone: ["agent-1"] });
    gone.resume.restoreCarriedPendingWakes([wakeFor("agent-1")]);
    assert.deepEqual(gone.named("reportPendingWake").map((call) => (call.args[0] as Record<string, unknown>).reason), ["agent_gone"]);
    const group = world({ groupAgent: true });
    group.resume.restoreCarriedPendingWakes([wakeFor("agent-1")]);
    assert.deepEqual(group.named("reportPendingWake").map((call) => (call.args[0] as Record<string, unknown>).reason), ["group_session"]);
    // Nothing to carry, nothing to do.
    const quiet = world();
    quiet.resume.restoreCarriedPendingWakes([]);
    quiet.resume.restoreCarriedPendingWakes(undefined);
    const cannotRun = world({ canExecute: false });
    cannotRun.resume.restoreCarriedPendingWakes([wakeFor("agent-1")]);
    assert.deepEqual([quiet.calls.length, cannotRun.calls.length], [0, 0]);
  });

  it("turns a carried shell into a notice the agent can act on", () => {
    const world1 = world();
    world1.resume.restoreCarriedPendingWakes([{ ...wakeFor("agent-1", { kind: "shell", title: "npm test", quietOrigin: { automation: { id: "a", name: "n" } } }) }]);
    // A shell cannot survive the rebuild, so its marker is marked as interrupted and a completion says so.
    assert.deepEqual(world1.named("markPendingWake")[0]?.args[0], { ...wakeFor("agent-1", { kind: "shell", title: "npm test", quietOrigin: { automation: { id: "a", name: "n" } } }), interruptedByRecreate: true });
    assert.deepEqual(world1.named("reportPendingWake").map((call) => (call.args[0] as Record<string, unknown>).outcome), ["carried", "dropped_with_notice"]);
    const notice = world1.named("handleBackgroundShellCompletion")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([notice.agentId, notice.shellId, notice.title, notice.status], ["agent-1", "work-1", "npm test", "aborted"]);
    assert.match(String(notice.detail), /did not survive the update/);
    assert.deepEqual(notice.quietOrigin, { automation: { id: "a", name: "n" } });
    assert.equal(world1.named("rearmPendingWake").length, 0);
    // A shell with no title of its own still gets one.
    const untitled = world();
    untitled.resume.restoreCarriedPendingWakes([wakeFor("agent-1", { kind: "shell" })]);
    assert.equal((untitled.named("handleBackgroundShellCompletion")[0]?.args[0] as { title: string }).title, "Background command work-1");
    // A ledger that refused the write is reported as a failure rather than carried.
    const refused = world({ markPendingResult: false });
    refused.resume.restoreCarriedPendingWakes([wakeFor("agent-1")]);
    assert.deepEqual(refused.named("reportPendingWake").map((call) => (call.args[0] as Record<string, unknown>).outcome), ["persist_failed", "carried"]);
  });
});
