/**
 * Firing an automation: the gates it goes through, what it is asked to do, what is written back onto its own run ledger,
 * and how a failure is shown to the user once per kind.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AutomationRunPath, type FireAutomationArgs } from "../../source/host/transcript/automation-run-path.ts";
import { routineNoticesToRaise } from "../../source/host/automations/routine-notices.ts";
import { stableAutomationId } from "../../source/host/automations/automation-id.ts";
import { writeSlateGroupConfig } from "../../source/host/groups/group-store.ts";
import { getTranscript, setTranscript } from "../../source/host/transcript/transcript-store.ts";
import type { TranscriptEntry } from "../../source/host/transcript/transcript-hub.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };

const automation = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "auto-1",
    name: "Morning report",
    prompt: "Write the morning report.",
    trigger: { type: "cron", schedule: "0 9 * * *" },
    schedule: "0 9 * * *",
    triggerDescription: "every morning",
    isEnabled: true,
    nextRunAt: null,
    runs: [],
    filePath: "/tmp/auto-1.json",
    raisedNotices: [],
    ...overrides,
  }) as never;

const args = (overrides: Partial<FireAutomationArgs> = {}): FireAutomationArgs => ({
  agentId: "agent-1",
  automation: automation(),
  trigger: "schedule",
  ...overrides,
});

/** A transcript manager with the run surface, the automation ledger and the reporting an automation reaches for. */
function world(
  options: {
    canExecute?: boolean;
    sessionError?: Error;
    group?: boolean;
    activeSession?: boolean;
    paused?: boolean;
    reminder?: string;
    runResult?: Record<string, unknown>;
    runError?: Error;
    notices?: Array<{ id: string }>;
    definitions?: unknown[];
    beginRun?: unknown;
    groupConfig?: Record<string, unknown> | null;
    timeZone?: string;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const directory = mkdtempSync(join(tmpdir(), "slate-automation-"));
  const storeEntries = structuredClone([]) as TranscriptEntry[];
  setTranscript(storeEntries);
  const sessionEntries: TranscriptEntry[] = [];
  const automations = {
    get: (id: string) => automation({ id }),
    listDefinitions: () => options.definitions ?? [],
    markNoticeRaised: (id: string, noticeId: string) => record("markNoticeRaised", id, noticeId),
    recordRunDefinition: (id: string) => record("recordRunDefinition", id),
    beginRun: (runArgs: unknown) => {
      record("beginRun", runArgs);
      if (options.beginRun !== undefined) return options.beginRun;
      return { id: "run-1" };
    },
    finishRunDefinition: (finishArgs: unknown) => record("finishRun", finishArgs),
  };
  const session = {
    id: "agent-1",
    dbPath: join(directory, "conversation.db"),
    automations,
    db: {
      getTranscriptEntries: () => sessionEntries,
      appendTranscriptEntry: (entry: TranscriptEntry) => {
        sessionEntries.push(entry);
        return true;
      },
    },
  };
  if (options.groupConfig != null)
    writeSlateGroupConfig(directory, { version: 1, memberIds: [], ...options.groupConfig });
  const runner = {
    run: async (prompt: string, runOptions: Record<string, unknown>) => {
      record("run", prompt, runOptions);
      if (options.runError !== undefined) throw options.runError;
      return options.runResult ?? { sentMessageCount: 2, reacted: false, aborted: false };
    },
  };
  const groupDeps = {} as Record<string, unknown>;
  const tm = {
    execution: { canExecute: options.canExecute !== false },
    sessions: {
      activeSession: options.activeSession === false ? undefined : session,
      resolveBackgroundSession: async (agentId: string) => {
        record("resolveBackgroundSession", agentId);
        if (options.sessionError !== undefined) throw options.sessionError;
        return session;
      },
    },
    sessionStore: { getUserTimeZone: () => options.timeZone ?? "Europe/Berlin" },
    groupChat: {
      isGroupSession: () => options.group === true,
      groupIdentityFor: (target: unknown) => ({ kind: "group", id: "the-group" }),
      groupOrchestratorDeps: (target: unknown, epoch: number, traceCtx: unknown, lane: string, source: string) => {
        record("groupOrchestratorDeps", epoch, lane, source);
        groupDeps.resolveMembers = async (memberIds: readonly string[]) => {
          record("resolveMembers", memberIds);
          return [];
        };
        return groupDeps;
      },
    },
    sharedRooms: { publishSharedRoomEntryIfNeeded: (target: unknown, entry: TranscriptEntry) => record("publishSharedRoomEntry", entry.id) },
    sendPipeline: { currentTurnEpoch: (target: { id: string }) => { record("currentTurnEpoch", target.id); return 1; } },
    runnerRegistry: { getRunner: (target: unknown) => { record("getRunner"); return runner; } },
    runLifecycle: {
      lastRequestIdBySession: new Map<string, string>([["agent-1", "req-2"]]),
      beginSessionRun: (target: unknown) => record("beginSessionRun"),
      endSessionRun: (target: unknown) => record("endSessionRun"),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => {
        record("enqueueExclusiveRun", id, meta);
        return await work();
      },
    },
    turnRuntime: { activeRequestSources: new Map<string, string>() },
    upgradeResume: { markAgentResumePending: (target: unknown, source: string, opts: unknown) => record("markAgentResumePending", source, opts) },
    automationRuntime: {
      enqueueAutomationLifecycleMutation: async (mutationArgs: { mutation: () => void }) => {
        record("lifecycleMutation");
        mutationArgs.mutation();
      },
      recordAutomationChangeEvents: (target: unknown, source: string) => record("recordAutomationChangeEvents", source),
      recordInactiveAutomationChanges: (changeArgs: unknown) => record("recordInactiveAutomationChanges", changeArgs),
      emitAutomations: (target: unknown) => record("emitAutomations"),
    },
    roster: { emitAgentUpdate: async (id: string) => record("emitAgentUpdate", id) },
    sessionStoreActivity: {},
    telemetry: {
      reportAgentError: (report: unknown) => record("reportAgentError", report),
      reportAutomationRun: (report: unknown) => record("reportAutomationRun", report),
    },
    trayErrors: { pushError: (error: unknown) => record("pushError", error) },
    appendEntry: (entry: TranscriptEntry) => {
      record("appendEntry", entry);
      setTranscript([...getTranscript(), entry]);
    },
  };
  const spendGuard = {
    apply: async (target: unknown, target2: unknown) => {
      record("spendGuard");
      return { paused: options.paused === true, reminder: options.reminder };
    },
  };
  const eventFires = { reportFireDropped: (report: unknown) => record("reportFireDropped", report) };
  const path = new AutomationRunPath(tm, spendGuard, eventFires);
  return {
    path, tm, session, sessionEntries, groupDeps, calls, directory,
    automations,
    named: (name: string) => calls.filter((call) => call.name === name),
    lastRun: () => calls.filter((call) => call.name === "run").at(-1)?.args ?? null,
    notices: () => routineNoticesToRaise(automation()),
    stored: (id: string) => getTranscript().find((entry) => entry.id === id),
  };
}

describe("the retry policy an automation runs under", () => {
  it("reads its bounds from the environment, with sane fallbacks", async () => {
    const defaults = world();
    await defaults.path.fireAutomation(args());
    const policy = (defaults.lastRun()?.[1] as { transientStreamRetry: Record<string, unknown> }).transientStreamRetry;
    assert.deepEqual([policy.maxAttempts, policy.baseDelayMs, policy.maxDelayMs], [4, 1_000, 15_000]);
    assert.equal(typeof (policy as { onRetry?: unknown }).onRetry, "function");
    // Settings that are not usable fall back rather than being taken at face value.
    const configured = world();
    const previous = { ...process.env };
    try {
      process.env.SLATE_AUTOMATION_STREAM_RETRY_ATTEMPTS = "7";
      process.env.SLATE_AUTOMATION_STREAM_RETRY_BASE_MS = "250";
      process.env.SLATE_AUTOMATION_STREAM_RETRY_MAX_MS = "nonsense";
      await configured.path.fireAutomation(args());
      const configuredPolicy = (configured.lastRun()?.[1] as { transientStreamRetry: Record<string, unknown> }).transientStreamRetry;
      assert.deepEqual([configuredPolicy.maxAttempts, configuredPolicy.baseDelayMs, configuredPolicy.maxDelayMs], [7, 250, 15_000]);
      process.env.SLATE_AUTOMATION_STREAM_RETRY_ATTEMPTS = "0";
      process.env.SLATE_AUTOMATION_STREAM_RETRY_BASE_MS = "-5";
      const below = world();
      await below.path.fireAutomation(args());
      const belowPolicy = (below.lastRun()?.[1] as { transientStreamRetry: Record<string, unknown> }).transientStreamRetry;
      assert.deepEqual([belowPolicy.maxAttempts, belowPolicy.baseDelayMs], [4, 1_000]);
    } finally {
      process.env = previous;
    }
  });
});

describe("what stops an automation from firing", () => {
  it("does nothing without a runner attached, or when the conversation cannot be opened", async () => {
    const cannotRun = world({ canExecute: false });
    assert.equal(await cannotRun.path.fireAutomation(args()), undefined);
    assert.equal(cannotRun.calls.length, 0);
    const unopenable = world({ sessionError: new Error("gone") });
    assert.equal(await unopenable.path.fireAutomation(args()), undefined);
    assert.equal(unopenable.named("run").length, 0);
  });

  it("drops a wake that is already firing, and lets an event fire through", async () => {
    const world1 = world();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    world1.tm.runLifecycle.enqueueExclusiveRun = async (id: string, work: () => Promise<void>, meta: unknown) => {
      world1.calls.push({ name: "enqueueExclusiveRun", args: [id, meta] });
      await held;
      return await work();
    };
    const first = world1.path.fireAutomation(args({ runUuid: "run-uuid-1", scheduledForMs: 5_000 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await world1.path.fireAutomation(args({ runUuid: "run-uuid-2", scheduledForMs: 6_000 })), undefined);
    assert.deepEqual(world1.named("reportFireDropped")[0]?.args, [
      { agentId: "agent-1", trigger: "schedule", reason: "duplicate_in_flight", scheduledForMs: 6_000, runUuid: "run-uuid-2" },
    ]);
    // An event fire is not held back by the one already running: both go through.
    const event = { kind: "message" };
    const second = world1.path.fireAutomation(args({ trigger: "event", events: [event] }));
    release();
    await Promise.all([first, second]);
    assert.equal(world1.named("beginRun").length, 2);
    // The key is released when the run is over, so the next scheduled fire goes through.
    assert.equal(world1.path.inFlightAutomationKeys.size, 0);
    assert.equal(await world1.path.fireAutomation(args()), "ok");
    assert.equal(world1.named("beginRun").length, 3);
  });

  it("asks the spend guard before a background wake, and stops when the user is away", async () => {
    const paused = world({ paused: true });
    assert.equal(await paused.path.fireAutomation(args()), undefined);
    assert.equal(paused.named("spendGuard").length, 1);
    assert.deepEqual(paused.named("reportFireDropped")[0]?.args, [{ agentId: "agent-1", trigger: "schedule", reason: "user_away_paused" }]);
    assert.equal(paused.named("run").length, 0);
    // The reminder the guard gives is added to the prompt; a manual fire does not ask the guard at all.
    const reminded = world({ reminder: "Keep an eye on the budget." });
    await reminded.path.fireAutomation(args());
    assert.match(String(reminded.lastRun()?.[0]), /\n\nKeep an eye on the budget\.$/);
    const manual = world();
    await manual.path.fireAutomation(args({ trigger: "manual" }));
    assert.equal(manual.named("spendGuard").length, 0);
  });
});

describe("what a fired automation does", () => {
  it("runs the routine's own wake and writes the run onto its ledger", async () => {
    const world1 = world({ timeZone: "UTC", notices: [{ id: "notice-1" }] });
    assert.equal(await world1.path.fireAutomation(args()), "ok");
    // The automation's definitions are looked at either side of the run, so a change made by running is picked up.
    assert.deepEqual(world1.named("lifecycleMutation").length, 2);
    assert.deepEqual(world1.named("recordAutomationChangeEvents").map((call) => call.args[0]), ["agent", "agent"]);
    // A conversation that is not on screen records a before/after pair, both sides taken around the run.
    const side = world({ activeSession: false, definitions: [{ id: "existing" }] });
    assert.equal(await side.path.fireAutomation(args()), "ok");
    assert.deepEqual(
      side.named("recordInactiveAutomationChanges").map((call) => (call.args[0] as { before: unknown[]; after: unknown[]; source: string }).before),
      [[{ id: "existing" }], [{ id: "existing" }]],
    );
    assert.deepEqual((side.named("recordInactiveAutomationChanges")[1]?.args[0] as { source: string }).source, "agent");
    assert.deepEqual(world1.named("recordRunDefinition")[0]?.args, ["auto-1"]);
    assert.equal(world1.named("beginSessionRun").length, 1);
    assert.deepEqual(world1.named("enqueueExclusiveRun")[0]?.args[1], { lane: "background", source: "automation" });
    assert.deepEqual(world1.named("beginRun")[0]?.args, [{ id: "auto-1", trigger: "schedule" }]);
    assert.match(String(world1.lastRun()?.[0]), /Write the morning report\./);
    const runOptions = world1.lastRun()?.[1] as Record<string, unknown>;
    assert.deepEqual([runOptions.hidden, runOptions.isSilenceAllowed, runOptions.requestSource], [true, true, "automation"]);
    assert.deepEqual(runOptions.automationWake, { id: "auto-1", name: "Morning report" });
    assert.equal(world1.tm.turnRuntime.activeRequestSources.get("agent-1"), "automation");
    // The run is finished as ok, the roster and the automations are told, and the run is reported.
    assert.deepEqual(world1.named("finishRun")[0]?.args, [{ id: "auto-1", runId: "run-1", status: "ok" }]);
    assert.deepEqual(world1.named("emitAgentUpdate")[0]?.args, ["agent-1"]);
    assert.equal(world1.named("emitAutomations").length, 1);
    const report = world1.named("reportAutomationRun")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.conversationId, report.automationId, report.trigger, report.outcome, report.isGroup, report.sentMessageCount], ["agent-1", stableAutomationId({ agentId: "agent-1", localId: "auto-1" }), "schedule", "ok", false, 2]);
    assert.equal(typeof report.durationMs, "number");
    assert.equal(world1.named("endSessionRun").length, 1);
  });

  it("says when a wake was late, and how big an event batch was", async () => {
    const world1 = world();
    await world1.path.fireAutomation(args({ events: [{ kind: "message" }], trigger: "event" }));
    const report = world1.named("reportAutomationRun")[0]?.args[0] as Record<string, unknown>;
    assert.equal(report.eventBatchSize, 1);
    assert.equal(report.scheduledForMs, undefined);
    // The run the ledger begins carries what the batch was about.
    assert.equal(typeof (world1.named("beginRun")[0]?.args[0] as { event: unknown }).event, "string");
    const scheduled = world();
    const firedAt = Date.now() - 2_000;
    await scheduled.path.fireAutomation(args({ scheduledForMs: firedAt }));
    const scheduledReport = scheduled.named("reportAutomationRun")[0]?.args[0] as Record<string, unknown>;
    assert.equal(scheduledReport.scheduledForMs, firedAt);
    assert.equal(typeof scheduledReport.latenessMs, "number");
    assert.equal((scheduledReport.latenessMs as number) >= 2_000, true);
    // An event fire marks the wake as carrying text the agent must not treat as instructions.
    const eventOptions = world1.lastRun()?.[1] as { automationWake: Record<string, unknown> };
    assert.equal(eventOptions.automationWake.containsUntrustedEventText, true);
    assert.deepEqual(
      [(world1.named("beginRun")[0]?.args[0] as { id: string }).id, (world1.named("beginRun")[0]?.args[0] as { trigger: string }).trigger],
      ["auto-1", "event"],
    );
  });

  it("records an interrupted wake as interrupted, and leaves the resumption to the upgrade", async () => {
    const quiesced = world({ runResult: { sentMessageCount: 0, reacted: false, aborted: false, quiescedForUpgrade: true } });
    assert.equal(await quiesced.path.fireAutomation(args()), "interrupted");
    assert.deepEqual(quiesced.named("finishRun")[0]?.args, [{ id: "auto-1", runId: "run-1", status: "error", detail: "Interrupted by a host update; resuming after restart." }]);
    assert.deepEqual(quiesced.named("markAgentResumePending")[0]?.args, ["automation", { automationId: "auto-1", automationRunId: "run-1" }]);
    assert.deepEqual((quiesced.named("reportAutomationRun")[0]?.args[0] as Record<string, unknown>).outcome, "interrupted");
    // An abort by the user is interrupted too, but there is nothing to resume.
    const aborted = world({ runResult: { sentMessageCount: 0, reacted: false, aborted: true } });
    assert.equal(await aborted.path.fireAutomation(args()), "interrupted");
    assert.deepEqual(aborted.named("finishRun")[0]?.args, [{ id: "auto-1", runId: "run-1", status: "error", detail: "Interrupted before it finished." }]);
    assert.equal(aborted.named("markAgentResumePending").length, 0);
  });

  it("reports a failed wake, names what went wrong, and tells the user about it", async () => {
    const world1 = world({ runError: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    assert.equal(await world1.path.fireAutomation(args({ trigger: "manual" })), "error");
    const report = world1.named("reportAgentError")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.source, report.conversationId, report.requestId], ["automation", "agent-1", "req-2"]);
    assert.deepEqual(report.error, { code: SlateError.streamReset()["code"], connectCode: undefined, errno: "ECONNRESET" });
    const finished = world1.named("finishRun")[0]?.args[0] as Record<string, unknown>;
    assert.equal(finished.status, "error");
    assert.match(String(finished.detail), /Lost the connection repeatedly and gave up after retrying: socket hang up/);
    const pushed = world1.named("pushError")[0]?.args[0] as Record<string, unknown>;
    assert.equal(pushed.title, 'Automation "Morning report" failed');
    assert.equal(String(pushed.dedupeKey).startsWith("automation-failure:agent-1:auto-1:"), true);
    assert.equal(pushed.count, 1);
    assert.deepEqual((world1.named("reportAutomationRun")[0]?.args[0] as Record<string, unknown>).outcome, "error");
    assert.equal(world1.named("endSessionRun").length, 1);
  });

  it("only tells the user about a failure the first time and then on a doubling schedule", async () => {
    const world1 = world({ runError: new Error("the model refused") });
    const run = () => world1.path.fireAutomation(args({ trigger: "manual" }));
    for (let attempt = 0; attempt < 5; attempt += 1) await run();
    // Occurrences 1, 2 and 4 are shown; 3 and 5 are counted but not shown again.
    assert.deepEqual(world1.named("pushError").map((call) => (call.args[0] as { count: number }).count), [1, 2, 4]);
    // A run that works forgets the failures, so the next one starts counting again.
    const healthy = world({ runError: new Error("the model refused") });
    await healthy.path.fireAutomation(args({ trigger: "manual" }));
    healthy.tm.runnerRegistry.getRunner = () => ({ run: async () => ({ sentMessageCount: 1, reacted: false, aborted: false }) });
    await healthy.path.fireAutomation(args({ trigger: "manual" }));
    assert.deepEqual([...healthy.path.automationFailureOccurrences.keys()], []);
    assert.equal(healthy.named("pushError").length, 1);
    // A background failure is not shown at all: nobody is waiting on it.
    const background = world({ runError: new Error("boom") });
    await background.path.fireAutomation(args({ trigger: "schedule" }));
    assert.equal(background.named("pushError").length, 0);
    assert.equal(background.named("finishRun").length, 1);
  });
});

describe("an automation that belongs to a group", () => {
  it("seeds the group's own conversation and runs the orchestrator over its members", async () => {
    const world1 = world({ group: true, groupConfig: { memberIds: ["agent-1", "agent-2"], remoteMembers: [{ ownerAuthId: "owner-1", agentId: "agent-9" }] } });
    await world1.path.fireAutomation(args({ trigger: "manual", events: [{ kind: "message" }] }));
    // The seed is a user message the group can act on, and it reaches the shared room.
    const seed = getTranscript()[0] as TranscriptEntry;
    assert.equal(seed.role, "user");
    assert.match(String(seed.content), /Write the morning report\./);
    assert.deepEqual(world1.named("publishSharedRoomEntry")[0]?.args, [seed.id]);
    // The orchestrator is built for a background automation run and asked to run over the members, remote included.
    assert.deepEqual(world1.named("groupOrchestratorDeps")[0]?.args, [1, "background", "automation"]);
    const memberIds = world1.named("resolveMembers")[0]?.args[0] as string[];
    assert.deepEqual(memberIds.slice(0, 2), ["agent-1", "agent-2"]);
    assert.equal(String(memberIds[2]).endsWith("owner-1/agent-9"), true);
    // A group run does not use a runner of its own, and is reported as a group run.
    assert.equal(world1.named("getRunner").length, 0);
    assert.equal((world1.named("reportAutomationRun")[0]?.args[0] as Record<string, unknown>).isGroup, true);
    // A conversation that is not the one on screen gets its entries written and its roster refreshed.
    const side = world({ group: true, groupConfig: { memberIds: ["agent-2"] }, activeSession: false });
    await side.path.fireAutomation(args({ trigger: "manual" }));
    assert.equal(side.named("appendEntry").length, 0);
    assert.equal(side.sessionEntries.length, 1);
    // A conversation with no group configuration is not a group run at all: nothing is seeded and nothing fails.
    const unconfigured = world({ group: true, groupConfig: null });
    assert.equal(await unconfigured.path.fireAutomation(args({ trigger: "manual" })), "ok");
    assert.equal(unconfigured.named("run").length, 0);
    assert.equal(unconfigured.named("appendEntry").length, 0);
    assert.equal(unconfigured.named("reportAgentError").length, 0);
    assert.equal(unconfigured.named("beginRun").length, 1);
  });
});

describe("the small pieces an automation run keeps", () => {
  it("survives a ledger that refuses to record, and forgets a run it never began", async () => {
    const world1 = world({ beginRun: null, definitions: [] });
    assert.equal(await world1.path.fireAutomation(args()), "ok");
    // No run id from the ledger means there is nothing to finish, and that is not an error.
    assert.equal(world1.named("finishRun").length, 0);
    assert.equal(world1.named("reportAutomationRun").length, 1);
    // A ledger that throws on every call is swallowed.
    const throwing = world();
    throwing.session.automations.recordRunDefinition = () => {
      throw new Error("db closed");
    };
    throwing.session.automations.beginRun = () => {
      throw new Error("db closed");
    };
    throwing.session.automations.finishRunDefinition = () => {
      throw new Error("db closed");
    };
    assert.equal(await throwing.path.fireAutomation(args()), "ok");
    assert.equal(throwing.named("finishRun").length, 0);
  });
});
