/**
 * Creating, opening, closing and deleting a conversation's agent: what is written down, which stored procedures the
 * steps reach for, what the kickstarts are told, and what a deletion does with everything the agent owned.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AgentLifecycle, SlateAgentLifecycleError } from "../../source/host/transcript/agent-lifecycle.ts";
import { SlateAgentDb } from "../../source/host/extensions/session/agent-db.ts";
import { CANONICAL_AVATAR_FILENAME } from "../../source/host/agents/agent-avatar.ts";
import { getSlateProfilePath, writeSlateProfileFile } from "../../source/host/agents/agent-profile.ts";
import { SLATE_DISK_SAVER_KICKSTART_PROMPT, SLATE_DISK_SAVER_REAUDIT_PROMPT } from "../../source/shared/agents/disk-saver.ts";
import { subscribeTranscriptMutations } from "../../source/host/transcript/transcript-mutation-events.ts";
import { INTRODUCTION_FAILED_TRAY_TITLE, SLATE_ONBOARDING_KICKSTART_PROMPT } from "../../source/shared/agents/onboarding.ts";
import { SLATE_AGENT_LIMIT_MESSAGE } from "../../source/shared/agents/agents.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };

/** A session as the lifecycle uses one, with the little its own database has to answer. */
function fakeSession(id: string, options: { purpose?: string | null; pending?: boolean; entries?: unknown[] } = {}) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  let pending = options.pending === true;
  const entries = options.entries ?? [];
  return {
    id,
    dbPath: `/tmp/${id}/store.db`,
    calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    agentStore: { dispose: async () => record("dispose") },
    db: {
      setIntroductionPending: (value: boolean) => {
        pending = value;
        record("setIntroductionPending", value);
      },
      getIntroductionPending: () => pending,
      getAgentPurpose: () => options.purpose ?? null,
      getTranscriptEntries: () => entries,
      markUnread: (atMs?: number) => record("markUnread", atMs),
      markRead: () => record("markRead"),
      close: () => record("close"),
    },
  };
}

/** A transcript manager with the session store, the roster and the run surface an agent's life reaches for. */
function world(
  options: {
    activeSession?: ReturnType<typeof fakeSession> | undefined;
    liveSessions?: Array<[string, ReturnType<typeof fakeSession>]>;
    canExecute?: boolean;
    runReady?: boolean;
    inFlight?: string[];
    group?: boolean;
    remoteRoom?: boolean;
    runResult?: Record<string, unknown>;
    runError?: Error;
    ensureReply?: boolean;
    summarized?: unknown;
    summarizeFails?: boolean;
    agents?: Array<Record<string, unknown>>;
    recordIds?: string[];
    openFailsFor?: string[];
    fallbackFails?: Error;
    agentLimit?: boolean;
    dirExists?: (id: string) => boolean;
    deleteSessionFails?: boolean;
    avatarSummary?: unknown;
    updateFails?: boolean;
    agentDir?: string;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const runner = {
    run: async (prompt: string, runOptions: Record<string, unknown>) => {
      record("run", prompt, runOptions);
      if (options.runError !== undefined) throw options.runError;
      return options.runResult ?? { sentMessageCount: 1, reacted: false, aborted: false };
    },
  };
  const session = options.activeSession;
  const tm = {
    execution: {
      canExecute: options.canExecute !== false,
      isRunReady: async () => {
        record("isRunReady");
        return options.runReady !== false;
      },
    },
    sessions: {
      activeSession: session,
      liveSessions: new Map<string, unknown>(options.liveSessions ?? []),
      pendingSessionOpens: new Map<string, unknown>(),
      deletedAgentIds: new Set<string>(),
      loaded: false,
      markSessionLeftBehind: async (previous: unknown, now: number) => record("markSessionLeftBehind", now),
      markSessionViewed: async (target: unknown, now: number) => record("markSessionViewed", now),
      invalidateDeferredActivation: () => record("invalidateDeferredActivation"),
      replaceSession: async (target: unknown) => record("replaceSession", (target as { id: string }).id),
      clearActiveTranscript: (id: string | null) => record("clearActiveTranscript", id),
      setActiveTranscript: (id: string, entries: unknown) => record("setActiveTranscript", id),
      setActiveSession: (target: unknown) => record("setActiveSession", (target as { id: string }).id),
      resolveBackgroundSession: async (id: string) => {
        record("resolveBackgroundSession", id);
        const live = tm.sessions.liveSessions.get(id);
        if (live != null) return live;
        if (options.summarizeFails === true) throw new Error("no session");
        return fakeSession(id);
      },
      tryEnsureSession: async () => session,
      openSessionOnce: async (id: string) => {
        record("openSessionOnce", id);
        if ((options.openFailsFor ?? []).includes(id)) throw new Error("cannot open");
        return fakeSession(id);
      },
      closeSessionWhenIdle: async (id: string) => record("closeSessionWhenIdle", id),
    },
    sessionStore: {
      createSession: async (profile: unknown, origin: string, purpose: string | undefined) => {
        record("createSession", origin, purpose);
        const created = fakeSession("created-1");
        tm.sessions.liveSessions.set(created.id, created);
        return created;
      },
      getAgentDir: (id: string) => options.agentDir ?? join(tmpdir(), id),
      markSessionViewed: async (target: unknown) => record("markSessionViewedStore"),
      setSessionUnread: (id: string, isUnread: boolean, atMs?: number) => record("setSessionUnread", id, isUnread, atMs),
      seedSessionActivityFromDbMtime: async (target: unknown) => record("seedSessionActivityFromDbMtime"),
      setSessionNotifyOnUpdates: (id: string, enabled: boolean) => record("setSessionNotifyOnUpdates", id, enabled),
      setSessionHiddenFromSidebar: (id: string, hidden: boolean) => record("setSessionHiddenFromSidebar", id, hidden),
      summarizeOpenSession: async (target: unknown) => {
        record("summarizeOpenSession");
        return options.summarizeFails === true ? null : (options.summarized ?? { id: (target as { id: string }).id, name: "Summarized" });
      },
      listAgents: async (excludeId?: string) => {
        record("listAgents", excludeId);
        return options.agents ?? [];
      },
      listAgentRecordIds: async () => {
        record("listAgentRecordIds");
        return options.recordIds ?? [];
      },
      updateAgentProfile: async (id: string, profile: unknown) => {
        record("updateAgentProfile", id, profile);
        if (options.updateFails === true) return null;
        return options.summarized ?? { id, name: profile && (profile as { name: string }).name };
      },
      writeAgentProfileFile: (id: string, profile: unknown) => record("writeAgentProfileFile", id, profile),
      agentDirExists: (id: string) => options.dirExists?.(id) ?? true,
      deleteSession: async (id: string) => {
        record("deleteSession", id);
        if (options.deleteSessionFails === true) throw new Error("delete failed");
      },
      createFallbackSession: async (open: (id: string) => Promise<unknown>) => {
        record("createFallbackSession");
        if (options.fallbackFails !== undefined) throw options.fallbackFails;
        return fakeSession("fallback-1");
      },
      getTranscriptEntries: async (target: unknown) => {
        record("getTranscriptEntries");
        return (target as { db: { getTranscriptEntries: () => unknown[] } }).db.getTranscriptEntries();
      },
      setAgentAvatarBytes: async (...args: unknown[]) => {
        record("setAgentAvatarBytes");
        return options.avatarSummary === undefined ? { id: "agent-1" } : options.avatarSummary;
      },
      setAgentAvatarBytesById: async (...args: unknown[]) => {
        record("setAgentAvatarBytesById");
        return options.avatarSummary === undefined ? { id: "agent-1" } : options.avatarSummary;
      },
      getAgentAvatar: async (id: string) => {
        record("getAgentAvatar", id);
        return "avatar-bytes";
      },
      openSession: async (id: string) => {
        record("openSession", id);
        return fakeSession(id);
      },
      mintAgent: async (mint: (id: string) => Promise<unknown>) => {
        record("mintAgent");
        return mint("minted-1");
      },
    },
    roster: {
      emit: (event: unknown) => record("emit", event),
      emitAgents: async () => record("emitAgents"),
      emitAgentUpdate: async (id: string) => record("emitAgentUpdate", id),
      emitProfileChanged: (id: string) => record("emitProfileChanged", id),
      reserveSnapshotStamp: () => {
        record("reserveSnapshotStamp");
        return { snapshotEpoch: "epoch", snapshotSeq: 1 };
      },
      finalizeSummaryForRpc: (summary: unknown, stamp: unknown) => {
        record("finalizeSummaryForRpc");
        return { ...(summary as object), ...(stamp as object) };
      },
      forgetAgentSubagentWork: (id: string) => record("forgetAgentSubagentWork", id),
      lastRunnerAsyncTasks: new Map<string, unknown>([["agent-1", []]]),
      emitAsyncTasksForAgent: (id: string) => record("emitAsyncTasksForAgent", id),
    },
    automationRuntime: {
      ensureHiddenTurnReply: async (target: unknown) => {
        record("ensureHiddenTurnReply");
        return options.ensureReply !== false;
      },
    },
    telemetry: {
      reportAgentError: (report: unknown) => record("reportAgentError", report),
      reportTurnInterrupt: (report: unknown) => record("reportTurnInterrupt", report),
    },
    trayErrors: {
      pushError: (error: unknown) => record("pushError", error),
      clearForAgent: (id: string) => record("clearForAgent", id),
    },
    runnerRegistry: {
      getRunner: (target: unknown) => {
        record("getRunner", (target as { id: string }).id);
        return runner;
      },
      runners: new Map<string, unknown>([["agent-1", { interruptAll: (reason: string) => { record("interruptAll", reason); return true; }, cancelBackgroundShellRewatches: () => record("cancelShellRewatches"), drainBackgroundSubagents: async () => record("drainSubagents") }]]),
      activeGroupMemberRunners: new Map<string, unknown>(),
    },
    runLifecycle: {
      inFlightRunCounts: new Map((options.inFlight ?? []).map((id) => [{ id }, 1])),
      lastRequestIdBySession: new Map<string, string>([["agent-1", "req-1"]]),
      runningAgentIds: () => new Set<string>(options.inFlight ?? []),
      beginSessionRun: (target: unknown) => record("beginSessionRun"),
      endSessionRun: (target: unknown) => record("endSessionRun"),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => {
        record("enqueueExclusiveRun", id, meta);
        return await work();
      },
      drainExclusiveRuns: async (id: string) => record("drainExclusiveRuns", id),
      watchActiveSession: (target: unknown) => record("watchActiveSession"),
      closeSessionWhenIdle: async (target: unknown) => record("closeSessionWhenIdleLifecycle", (target as { id: string }).id),
    },
    turnRuntime: { activeRequestSources: new Map<string, string>() },
    upgradeResume: { markAgentResumePending: (target: unknown, source: string) => record("markAgentResumePending", source) },
    groupChat: {
      isGroupSession: () => options.group === true,
      isRemoteRoomSession: () => options.remoteRoom === true,
      dmPreemptedGroupMemberIds: new Set<string>(["agent-1"]),
    },
    ackObligations: {
      markAckObligationLost: (id: string, reason: string) => record("markAckObligationLost", id, reason),
      ackRunTokens: new Map<string, unknown>([["agent-1", new Set(["token"])]]),
    },
    backgroundWakes: {
      pendingSubagentCompletions: new Map<string, unknown>([["agent-1", []]]),
      pendingShellCompletions: new Map<string, unknown>([["agent-1", []]]),
      pendingInbound: new Map<string, unknown>([["agent-1", []]]),
      pendingAgentInbound: new Map<string, unknown>([["agent-1", []]]),
      pendingChannelFailures: new Map<string, unknown>([["agent-1", []]]),
      dmPreemptedWakeAgentIds: new Set<string>(["agent-1"]),
    },
    boxHandoff: {
      boxHandoffs: new Map<string, unknown>([["agent-1", { requestId: "req-box" }]]),
      awaitingSink: { clear: (id: string) => record("awaitingClear", id) },
    },
    pendingWakeStore: { clearAgent: (id: string) => record("clearAgent", id) },
    onAgentForgotten: (id: string) => record("onAgentForgotten", id),
    unwatchActiveSession: () => record("unwatchActiveSession"),
    publishTranscriptMutation: (mutation: unknown) => record("publishTranscriptMutation", mutation),
  };
  const lifecycle = new AgentLifecycle(tm);
  return { lifecycle, tm, runner, calls, named: (name: string) => calls.filter((call) => call.name === name) };
}

describe("creating an agent", () => {
  it("mints a session, puts it in front of the user, and hands back its summary", async () => {
    const world1 = world();
    const result = await world1.lifecycle.createAgent({ name: "New Bot" }, "user", { purpose: "disk-saver" });
    assert.deepEqual(world1.named("createSession")[0]?.args, ["user", "disk-saver"]);
    assert.deepEqual((world1.named("emit")[0]?.args[0] as { type: string }).type, "cleared");
    assert.equal(world1.named("emitAgents").length, 1);
    assert.deepEqual(
      [world1.named("markSessionLeftBehind").length, world1.named("markSessionViewedStore").length, world1.named("invalidateDeferredActivation").length, world1.named("replaceSession").length, world1.named("clearActiveTranscript").length],
      [1, 1, 1, 1, 1],
    );
    assert.deepEqual(result, { agent: { id: "created-1", name: "Summarized", snapshotEpoch: "epoch", snapshotSeq: 1 }, transcript: [] });
    // The opening is only started when it was asked for.
    assert.equal(world1.named("enqueueExclusiveRun").length, 0);
    const asked = world({ runReady: true });
    await asked.lifecycle.createAgent({ name: "New Bot" }, "user", { isKickstartRequested: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(asked.named("isRunReady").length, 1);
    assert.equal(asked.named("run").length, 1);
  });

  it("fails the creation when the new conversation cannot be summarized", async () => {
    const world1 = world({ summarizeFails: true });
    await assert.rejects(() => world1.lifecycle.createAgent({ name: "New Bot" }), SlateAgentLifecycleError);
  });

  it("leaves a background agent's session closed behind it, even when it could not be summarized", async () => {
    const world1 = world();
    const result = await world1.lifecycle.createBackgroundAgent({ name: "New Bot" });
    assert.deepEqual(result.transcript, []);
    assert.equal(world1.named("emitAgents").length, 1);
    const session = world1.tm.sessions.liveSessions.get("created-1") as ReturnType<typeof fakeSession>;
    assert.deepEqual([session.named("dispose").length], [1]);
    const failing = world({ summarizeFails: true });
    await assert.rejects(() => failing.lifecycle.createBackgroundAgent({ name: "New Bot" }), SlateAgentLifecycleError);
    const failingSession = failing.tm.sessions.liveSessions.get("created-1") as ReturnType<typeof fakeSession>;
    assert.equal(failingSession.named("dispose").length, 1);
  });

  it("gives the new agent its directory and an introduction unless that was suppressed", async () => {
    const world1 = world();
    const configured: string[] = [];
    const session = await world1.lifecycle.mintAgentSession({ name: "New Bot" }, "user", { configureAgentDir: (dir) => configured.push(dir) });
    assert.deepEqual(configured, [world1.tm.sessionStore.getAgentDir("created-1")]);
    assert.deepEqual(session.named("setIntroductionPending")[0]?.args, [true]);
    const suppressed = world();
    const quiet = await suppressed.lifecycle.mintAgentSession({ name: "New Bot" }, "user", { isIntroductionSuppressed: true });
    assert.equal(quiet.named("setIntroductionPending").length, 0);
  });
});

describe("starting a new agent off", () => {
  it("says no when the conversation cannot be reached or is not one this applies to", async () => {
    const unreachable = world({ summarizeFails: true });
    assert.equal(await unreachable.lifecycle.kickstartAgent("agent-1", true), false);
    const group = world({ group: true, liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]] });
    assert.equal(await group.lifecycle.kickstartAgent("agent-1", true), false);
    assert.equal(group.named("run").length, 0);
    const room = world({ remoteRoom: true, liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]] });
    assert.equal(await room.lifecycle.kickstartAgent("agent-1", true), false);
    assert.equal(room.named("run").length, 0);
    // Nobody is being introduced when the introduction is no longer pending.
    const settled = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: false })]] });
    assert.equal(await settled.lifecycle.kickstartAgent("agent-1", true), false);
    const notReady = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]], runReady: false });
    assert.equal(await notReady.lifecycle.kickstartAgent("agent-1", false), false);
    const cannotRun = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]], canExecute: false });
    assert.equal(await cannotRun.lifecycle.kickstartAgent("agent-1", true), false);
    assert.equal(cannotRun.named("run").length, 0);
  });

  it("treats a conversation the user has already written in as introduced", async () => {
    const written = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true, entries: [{ id: "t0u", kind: "message", role: "user", content: "hello" }] })]] });
    assert.equal(await written.lifecycle.kickstartAgent("agent-1", true), false);
    const session = written.tm.sessions.liveSessions.get("agent-1") as ReturnType<typeof fakeSession>;
    assert.deepEqual(session.named("setIntroductionPending")[0]?.args, [false]);
    assert.equal(written.named("run").length, 0);
  });

  it("counts a kickstart that is already running as done rather than starting another", async () => {
    const running = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]], inFlight: ["agent-1"] });
    running.tm.runLifecycle.inFlightRunCounts.set(running.tm.sessions.liveSessions.get("agent-1") as never, 1);
    assert.equal(await running.lifecycle.kickstartAgent("agent-1", true), true);
    assert.equal(running.named("run").length, 0);
    assert.equal(running.named("enqueueExclusiveRun").length, 0);
  });

  it("runs the opening the conversation calls for, and stops introducing once something reached the user", async () => {
    const world1 = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]] });
    assert.equal(await world1.lifecycle.kickstartAgent("agent-1", true), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world1.named("run")[0]?.args, [SLATE_ONBOARDING_KICKSTART_PROMPT, { hidden: true }]);
    assert.deepEqual(world1.named("enqueueExclusiveRun")[0]?.args[1], { lane: "user", source: "kickstart" });
    assert.equal(world1.tm.turnRuntime.activeRequestSources.get("agent-1"), "turn");
    const session = world1.tm.sessions.liveSessions.get("agent-1") as ReturnType<typeof fakeSession>;
    assert.deepEqual(session.named("setIntroductionPending")[0]?.args, [false]);
    assert.deepEqual(world1.named("emitAgentUpdate")[0]?.args, ["agent-1"]);
    assert.equal(world1.named("endSessionRun").length, 1);
    // A disk-saving conversation gets its own opening.
    const diskSaver = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true, purpose: "disk-saver" })]] });
    await diskSaver.lifecycle.kickstartAgent("agent-1", true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(diskSaver.named("run")[0]?.args[0], SLATE_DISK_SAVER_KICKSTART_PROMPT);
    // A turn that sent nothing is only introduced once a hidden reply got through.
    const helped = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]], runResult: { sentMessageCount: 0, reacted: false, aborted: false } });
    await helped.lifecycle.kickstartAgent("agent-1", true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(helped.named("ensureHiddenTurnReply").length, 1);
    const helpedSession = helped.tm.sessions.liveSessions.get("agent-1") as ReturnType<typeof fakeSession>;
    assert.deepEqual(helpedSession.named("setIntroductionPending")[0]?.args, [false]);
    // Nothing got through at all: the introduction is still pending.
    const silent = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]], runResult: { sentMessageCount: 0, reacted: false, aborted: false }, ensureReply: false });
    await silent.lifecycle.kickstartAgent("agent-1", true);
    await new Promise((resolve) => setImmediate(resolve));
    const silentSession = silent.tm.sessions.liveSessions.get("agent-1") as ReturnType<typeof fakeSession>;
    assert.equal(silentSession.named("setIntroductionPending").length, 0);
    // An aborted turn leaves it pending; a quiesced one hands the introduction to the upgrade.
    const aborted = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]], runResult: { sentMessageCount: 0, reacted: false, aborted: true } });
    await aborted.lifecycle.kickstartAgent("agent-1", true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((aborted.tm.sessions.liveSessions.get("agent-1") as ReturnType<typeof fakeSession>).named("setIntroductionPending").length, 0);
    const quiesced = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]], runResult: { sentMessageCount: 0, reacted: false, aborted: false, quiescedForUpgrade: true } });
    await quiesced.lifecycle.kickstartAgent("agent-1", true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(quiesced.named("markAgentResumePending")[0]?.args, ["turn"]);
  });

  it("reports an opening that failed, and shows it to the user", async () => {
    const world1 = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true })]], runError: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    await world1.lifecycle.kickstartAgent("agent-1", true);
    await new Promise((resolve) => setImmediate(resolve));
    const report = world1.named("reportAgentError")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.source, report.conversationId, report.requestId], ["onboarding_kickstart", "agent-1", "req-1"]);
    assert.deepEqual(report.error, { code: SlateError.streamReset()["code"], connectCode: undefined, errno: "ECONNRESET" });
    const pushed = world1.named("pushError")[0]?.args[0] as Record<string, unknown>;
    assert.equal(pushed.title, INTRODUCTION_FAILED_TRAY_TITLE);
    assert.equal(String(pushed.dedupeKey).startsWith("introduction-failed"), true);
    assert.equal(pushed.detail, "socket hang up");
    assert.equal(world1.named("endSessionRun").length, 1);
  });

  it("asks a disk-saving conversation to look again, and only when it is one", async () => {
    const other = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: false })]] });
    assert.equal(await other.lifecycle.requestDiskSaverAudit("agent-1", true), false);
    const group = world({ group: true });
    assert.equal(await group.lifecycle.requestDiskSaverAudit("agent-1", true), false);
    // A conversation that has not been introduced yet is introduced instead of audited.
    const pending = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: true, purpose: "disk-saver" })]] });
    assert.equal(await pending.lifecycle.requestDiskSaverAudit("agent-1", true), true);
    assert.deepEqual(pending.named("run")[0]?.args[0], SLATE_DISK_SAVER_KICKSTART_PROMPT);
    // The audit itself runs under its own source.
    const audit = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: false, purpose: "disk-saver" })]] });
    assert.equal(await audit.lifecycle.requestDiskSaverAudit("agent-1", true), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(audit.named("run")[0]?.args, [SLATE_DISK_SAVER_REAUDIT_PROMPT, { hidden: true }]);
    assert.deepEqual(audit.named("enqueueExclusiveRun")[0]?.args[1], { lane: "background", source: "event" });
    assert.equal(audit.tm.turnRuntime.activeRequestSources.get("agent-1"), "event");
    // Nothing to report means a hidden reply is asked for; a silent failure is reported under the audit's own source.
    const silent = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: false, purpose: "disk-saver" })]], runResult: { sentMessageCount: 0, reacted: false, aborted: false } });
    await silent.lifecycle.requestDiskSaverAudit("agent-1", true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(silent.named("ensureHiddenTurnReply").length, 1);
    const failed = world({ liveSessions: [["agent-1", fakeSession("agent-1", { pending: false, purpose: "disk-saver" })]], runError: new Error("boom") });
    await failed.lifecycle.requestDiskSaverAudit("agent-1", true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((failed.named("reportAgentError")[0]?.args[0] as { source: string }).source, "disk_saver_reaudit");
  });
});

describe("cloning an agent", () => {
  it("refuses an agent that is gone, and a group", async () => {
    const world1 = world({ agents: [] });
    await assert.rejects(() => world1.lifecycle.cloneAgent("agent-1"), SlateAgentLifecycleError);
    const grouped = world({ agents: [{ id: "agent-1", name: "A group", isGroup: true }] });
    await assert.rejects(() => grouped.lifecycle.cloneAgent("agent-1"), /Groups can't be duplicated/);
  });

  it("rewrites the copy's identity so it belongs to the new agent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-clone-"));
    const sourceDir = join(directory, "source");
    const copyDir = join(directory, "copy");
    mkdirSync(sourceDir, { recursive: true });
    // A source agent with a store of its own, an avatar and a name to copy from.
    const sourceDb = new SlateAgentDb(join(sourceDir, "store.db"));
    sourceDb.set("agentId", "agent-1");
    sourceDb.setAgentOrigin("dev");
    sourceDb.setAgentPurpose("disk-saver");
    sourceDb.setSlateProfile({ description: "does a thing", avatarPath: null });
    sourceDb.close();
    writeSlateProfileFile(getSlateProfilePath(sourceDir), { name: "Original", description: "does a thing", title: "", avatarShape: "", avatarColor: "" });
    writeFileSync(join(sourceDir, CANONICAL_AVATAR_FILENAME), "png");
    const world1 = world({ agents: [{ id: "agent-1", name: "Original" }] });
    world1.tm.sessionStore.getAgentDir = (id: string) => (id === "agent-1" ? sourceDir : copyDir);
    // The lifecycle clones the directory itself, so the identity rewrite under test is the module's own.
    const result = await world1.lifecycle.cloneAgent("agent-1");
    assert.equal(world1.named("mintAgent").length, 1);
    assert.equal((result.agent as { id: string }).id, "minted-1");
    // The copy's store says it belongs to the new agent, is a user agent again, has no purpose of its own, and keeps
    // the description and the avatar that were copied over.
    const copyDb = new SlateAgentDb(join(copyDir, "store.db"));
    assert.deepEqual([copyDb.get("agentId"), copyDb.getAgentOrigin(), copyDb.getAgentPurpose()], ["minted-1", "user", null]);
    assert.deepEqual(copyDb.getSlateProfile(), { description: "does a thing", avatarPath: join(copyDir, CANONICAL_AVATAR_FILENAME) });
    copyDb.close();
    assert.equal(existsSync(join(copyDir, CANONICAL_AVATAR_FILENAME)), true);
    // A source with no avatar leaves the copy without one.
    const bare = mkdtempSync(join(tmpdir(), "slate-clone-bare-"));
    const bareSource = join(bare, "source");
    const bareCopy = join(bare, "copy");
    mkdirSync(bareSource, { recursive: true });
    const bareDb = new SlateAgentDb(join(bareSource, "store.db"));
    bareDb.set("agentId", "agent-1");
    bareDb.setSlateProfile({ description: "bare", avatarPath: null });
    bareDb.close();
    writeSlateProfileFile(getSlateProfilePath(bareSource), { name: "Original", description: "bare", title: "", avatarShape: "", avatarColor: "" });
    const world2 = world({ agents: [{ id: "agent-1", name: "Original" }] });
    world2.tm.sessionStore.getAgentDir = (id: string) => (id === "agent-1" ? bareSource : bareCopy);
    await world2.lifecycle.cloneAgent("agent-1");
    const bareCopyDb = new SlateAgentDb(join(bareCopy, "store.db"));
    assert.deepEqual(bareCopyDb.getSlateProfile(), { description: "bare", avatarPath: null });
    bareCopyDb.close();
  });

  it("opening a minted agent marks the timeline for reindexing and puts it on screen", async () => {
    const opened = { session: fakeSession("minted-1"), entries: [{ id: "e1" }], agent: { id: "minted-1", name: "Minted" } };
    const world1 = world();
    const published: unknown[] = [];
    const unsubscribe = subscribeTranscriptMutations((mutation) => published.push(mutation));
    let result;
    try {
      result = await world1.lifecycle.commitOpenedSession(opened);
    } finally {
      unsubscribe();
    }
    assert.deepEqual(published[0], { kind: "agent-needs-reindex", agentId: "minted-1" });
    assert.deepEqual((world1.named("emit")[0]?.args[0] as { type: string }).type, "snapshot");
    assert.deepEqual(world1.named("setActiveTranscript")[0]?.args, ["minted-1"]);
    assert.equal(world1.tm.sessions.loaded, true);
    assert.deepEqual(result.agent, { id: "minted-1", name: "Summarized", snapshotEpoch: "epoch", snapshotSeq: 1 });
    // A summary that cannot be refreshed falls back to the one the open produced.
    const unsummarizable = world({ summarizeFails: true });
    const fallback = await unsummarizable.lifecycle.commitOpenedSession(opened);
    assert.equal((fallback.agent as { name: string }).name, "Minted");
  });

  it("puts back what it minted when the new agent cannot be opened", async () => {
    const world1 = world({ summarizeFails: true });
    await assert.rejects(() => world1.lifecycle.openMintedSession("minted-1"), SlateAgentLifecycleError);
    assert.deepEqual(world1.named("deleteSession")[0]?.args, ["minted-1"]);
    // A session that was opened is disposed of before the store is told to forget it.
    const world2 = world();
    (world2.tm.sessionStore as { getTranscriptEntries: unknown }).getTranscriptEntries = async () => {
      throw new Error("cannot read");
    };
    await assert.rejects(() => world2.lifecycle.openMintedSession("minted-1"), /cannot read/);
    assert.equal(world2.named("deleteSession").length, 1);
  });
});

describe("deleting an agent", () => {
  it("stops everything the agent was doing before it is forgotten", async () => {
    const world1 = world({ activeSession: undefined });
    await world1.lifecycle.interruptAgentForDeletion("agent-1");
    assert.equal(world1.tm.sessions.deletedAgentIds.has("agent-1"), true);
    assert.deepEqual(world1.named("markAckObligationLost")[0]?.args, ["agent-1", "agent_deleted"]);
    assert.equal(world1.tm.ackObligations.ackRunTokens.has("agent-1"), false);
    assert.deepEqual(
      [
        world1.tm.backgroundWakes.pendingSubagentCompletions.has("agent-1"),
        world1.tm.backgroundWakes.pendingShellCompletions.has("agent-1"),
        world1.tm.backgroundWakes.pendingInbound.has("agent-1"),
        world1.tm.backgroundWakes.pendingAgentInbound.has("agent-1"),
        world1.tm.backgroundWakes.pendingChannelFailures.has("agent-1"),
      ],
      [false, false, false, false, false],
    );
    assert.deepEqual(world1.named("forgetAgentSubagentWork")[0]?.args, ["agent-1"]);
    assert.equal(world1.tm.roster.lastRunnerAsyncTasks.has("agent-1"), false);
    assert.deepEqual(world1.named("interruptAll")[0]?.args, ["agent deleted"]);
    assert.deepEqual(world1.named("reportTurnInterrupt")[0]?.args, [{ conversationId: "agent-1", reason: "agent_deleted", hadActiveRun: true, wasInFlight: false }]);
    assert.deepEqual([world1.named("cancelShellRewatches").length, world1.named("drainExclusiveRuns").length, world1.named("drainSubagents").length], [1, 1, 1]);
    // An agent with nothing running is still stopped, but not reported as interrupted.
    const quiet = world({ activeSession: undefined });
    quiet.tm.runnerRegistry.runners.clear();
    await quiet.lifecycle.interruptAgentForDeletion("agent-1");
    assert.equal(quiet.named("reportTurnInterrupt").length, 0);
  });

  it("forgets every agent that is not the one on screen, and hands back what is left", async () => {
    const world1 = world({ agents: [{ id: "agent-2" }] });
    const result = await world1.lifecycle.deleteAgents(["agent-1", "agent-9"]);
    assert.deepEqual(world1.named("clearForAgent").map((call) => call.args[0]), ["agent-1", "agent-9"]);
    assert.deepEqual(world1.named("deleteSession").map((call) => call.args[0]), ["agent-1", "agent-9"]);
    assert.deepEqual(world1.named("onAgentForgotten").map((call) => call.args[0]), ["agent-1", "agent-9"]);
    assert.deepEqual(world1.named("clearAgent").map((call) => call.args[0]), ["agent-1", "agent-9"]);
    assert.deepEqual(world1.named("awaitingClear").map((call) => call.args[0]), ["agent-1", "agent-9"]);
    assert.deepEqual(world1.named("emitAsyncTasksForAgent").map((call) => call.args[0]), ["agent-1", "agent-9"]);
    assert.equal(world1.tm.runnerRegistry.runners.has("agent-1"), false);
    assert.equal(world1.tm.boxHandoff.boxHandoffs.has("agent-1"), false);
    assert.equal(world1.named("emitAgents").length, 1);
    assert.deepEqual(result, { transcript: [] });
    // Nothing to delete is not an error, and does not touch anything.
    const none = world({ activeSession: undefined });
    assert.deepEqual(await none.lifecycle.deleteAgents([]), { transcript: [] });
    assert.equal(none.calls.length, 0);
  });

  it("moves the user to another agent when the one on screen is deleted", async () => {
    const active = fakeSession("agent-1");
    const successor = fakeSession("agent-2");
    const world1 = world({ activeSession: active, agents: [{ id: "agent-1", name: "Being deleted" }, { id: "agent-2", name: "Second" }] });
    world1.tm.sessions.liveSessions.set("agent-2", successor);
    await world1.lifecycle.deleteAgents(["agent-1"]);
    // The active agent is closed out only when it is idle, and the next one is put on screen.
    assert.deepEqual(world1.named("deleteSession").map((call) => call.args[0]), ["agent-1"]);
    assert.deepEqual(world1.named("closeSessionWhenIdleLifecycle")[0]?.args, ["agent-1"]);
    assert.deepEqual(world1.named("setActiveSession")[0]?.args, ["agent-2"]);
    assert.deepEqual(world1.named("setActiveTranscript")[0]?.args, ["agent-2"]);
    assert.equal((world1.named("emit")[0]?.args[0] as { type: string }).type, "snapshot");
    // An agent that cannot be opened is skipped rather than taken down with the deletion.
    const unopenable = world({ activeSession: fakeSession("agent-1"), agents: [{ id: "agent-2" }], openFailsFor: ["agent-2"], recordIds: [] });
    const result = await unopenable.lifecycle.runDeleteAgents(new Set(["agent-1"]));
    assert.deepEqual(result, { transcript: [] });
    // The unopenable agent was never put on screen: the platform fell back to a brand new one instead.
    assert.equal(unopenable.named("setActiveSession").some((call) => call.args[0] === "agent-2"), false);
    assert.deepEqual(unopenable.named("setActiveSession")[0]?.args, ["fallback-1"]);
    assert.equal(unopenable.named("createFallbackSession").length, 1);
  });

  it("falls back to a brand new agent when nothing is left to move to", async () => {
    const world1 = world({ activeSession: fakeSession("agent-1"), agents: [], recordIds: [] });
    await world1.lifecycle.runDeleteAgents(new Set(["agent-1"]));
    assert.equal(world1.named("createFallbackSession").length, 1);
    assert.deepEqual(world1.named("setActiveSession")[0]?.args, ["fallback-1"]);
    assert.deepEqual((world1.named("emit")[0]?.args[0] as { type: string }).type, "cleared");
    // When even that is refused, the platform is left with no agent at all rather than a broken one.
    const atLimit = world({ activeSession: fakeSession("agent-1"), agents: [], recordIds: [], fallbackFails: new Error(SLATE_AGENT_LIMIT_MESSAGE) });
    await atLimit.lifecycle.runDeleteAgents(new Set(["agent-1"]));
    assert.equal(atLimit.tm.sessions.activeSession, undefined);
    assert.equal(atLimit.tm.sessions.loaded, false);
    assert.deepEqual(atLimit.named("clearActiveTranscript")[0]?.args, [null]);
    assert.deepEqual(atLimit.named("unwatchActiveSession").length, 1);
    // Any other refusal is a real error.
    const otherFailure = world({ activeSession: fakeSession("agent-1"), agents: [], recordIds: [], fallbackFails: new Error("disk is full") });
    await assert.rejects(() => otherFailure.lifecycle.runDeleteAgents(new Set(["agent-1"])), /disk is full/);
  });

  it("puts the agents back on the list when a deletion could not be carried out", async () => {
    const world1 = world({ activeSession: undefined, dirExists: () => true });
    (world1.tm.sessionStore as { deleteSession: unknown }).deleteSession = async () => {
      throw new Error("delete failed");
    };
    await assert.rejects(() => world1.lifecycle.deleteAgents(["agent-1"]), /delete failed/);
    assert.equal(world1.tm.sessions.deletedAgentIds.has("agent-1"), false);
    // An agent whose directory is already gone stays forgotten.
    const gone = world({ activeSession: undefined, dirExists: () => false });
    (gone.tm.sessionStore as { deleteSession: unknown }).deleteSession = async () => {
      throw new Error("delete failed");
    };
    await assert.rejects(() => gone.lifecycle.deleteAgents(["agent-1"]));
    assert.equal(gone.tm.sessions.deletedAgentIds.has("agent-1"), true);
  });
});

describe("what can be changed about an agent afterwards", () => {
  it("updates the profile, trimming what the user typed", async () => {
    const onScreen = world({ activeSession: fakeSession("agent-1") });
    const summary = await onScreen.lifecycle.updateAgent("agent-1", { name: "  Trimmed  ", description: " does a thing ", title: "  Boss ", avatarShape: " round ", avatarColor: " red " });
    assert.deepEqual(onScreen.named("writeAgentProfileFile")[0]?.args, ["agent-1", { name: "Trimmed", description: "does a thing", title: "Boss", avatarShape: "round", avatarColor: "red" }]);
    assert.deepEqual([onScreen.named("emitAgentUpdate")[0]?.args, onScreen.named("emitProfileChanged")[0]?.args], [["agent-1"], ["agent-1"]]);
    assert.deepEqual(summary, { id: "agent-1", name: "Summarized", snapshotEpoch: "epoch", snapshotSeq: 1 });
    // An agent that is not on screen is updated through the store, and the optional fields stay optional.
    const elsewhere = world({ activeSession: fakeSession("agent-9") });
    await elsewhere.lifecycle.updateAgent("agent-1", { name: "Trimmed", description: "does a thing" });
    assert.deepEqual(elsewhere.named("updateAgentProfile")[0]?.args, ["agent-1", { name: "Trimmed", description: "does a thing" }]);
    assert.equal(elsewhere.named("writeAgentProfileFile").length, 0);
    // A profile the store could not produce is not summarized.
    const unknown = world({ activeSession: fakeSession("agent-9"), updateFails: true });
    assert.equal(await unknown.lifecycle.updateAgent("agent-1", { name: "x", description: "y" }), null);
  });

  it("marks an agent read, unread and how it should be notified", async () => {
    const onScreen = world({ activeSession: fakeSession("agent-1") });
    await onScreen.lifecycle.setAgentUnread("agent-1", true, 500);
    assert.deepEqual(onScreen.named("seedSessionActivityFromDbMtime").length, 1);
    assert.deepEqual((onScreen.tm.sessions.activeSession as ReturnType<typeof fakeSession>).named("markUnread")[0]?.args, [500]);
    await onScreen.lifecycle.setAgentUnread("agent-1", false);
    assert.deepEqual((onScreen.tm.sessions.activeSession as ReturnType<typeof fakeSession>).named("markRead").length, 1);
    assert.equal(onScreen.named("setSessionUnread").length, 0);
    // An agent that is not on screen goes through the store instead.
    const elsewhere = world({ activeSession: fakeSession("agent-9") });
    await elsewhere.lifecycle.setAgentUnread("agent-1", true, 700);
    assert.deepEqual(elsewhere.named("setSessionUnread")[0]?.args, ["agent-1", true, 700]);
    await elsewhere.lifecycle.setAgentNotifyOnUpdates("agent-1", true);
    await elsewhere.lifecycle.setAgentHiddenFromSidebar("agent-1", true);
    assert.deepEqual(elsewhere.named("setSessionNotifyOnUpdates")[0]?.args, ["agent-1", true]);
    assert.deepEqual(elsewhere.named("setSessionHiddenFromSidebar")[0]?.args, ["agent-1", true]);
    assert.equal(elsewhere.named("emitAgentUpdate").length, 3);
  });

  it("sets an avatar for the agent on screen differently from one that is not", async () => {
    const onScreen = world({ activeSession: fakeSession("agent-1") });
    await onScreen.lifecycle.setAgentAvatarBytes("agent-1", new Uint8Array([1]));
    assert.equal(onScreen.named("setAgentAvatarBytes").length, 1);
    assert.equal(onScreen.named("setAgentAvatarBytesById").length, 0);
    assert.deepEqual([onScreen.named("emitAgentUpdate").length, onScreen.named("emitProfileChanged").length], [1, 1]);
    const elsewhere = world({ activeSession: fakeSession("agent-9") });
    await elsewhere.lifecycle.setAgentAvatarBytes("agent-1", new Uint8Array([1]));
    assert.equal(elsewhere.named("setAgentAvatarBytesById").length, 1);
    // Nothing to hand back is handed back as nothing.
    const missing = world({ activeSession: fakeSession("agent-9"), avatarSummary: null });
    assert.equal(await missing.lifecycle.setAgentAvatarBytes("agent-1", new Uint8Array([1])), null);
    assert.deepEqual(await elsewhere.lifecycle.getAgentAvatar("agent-1"), "avatar-bytes");
  });
});
