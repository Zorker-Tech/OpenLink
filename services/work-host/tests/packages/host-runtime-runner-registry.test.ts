/**
 * The runner a conversation runs on: how one is made and wired, what it is told about itself, and where every handler
 * it raises ends up.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RUNNER_UNATTACHED_MESSAGE } from "../../source/host/transcript/transcript-hub.ts";
import { RunnerRegistry, SlateRemoteRoomError, coarseErrorTypeAndCode } from "../../source/host/transcript/runner-registry.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };

/** A runner that writes down every handler it is given, so a test can raise them. */
function recordingRunner() {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const runner = {
    calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    set: (name: string, ...args: unknown[]) => record(name, ...args),
    handler: (name: string) => handlers.get(name),
    bindSessionServices: (bindings: unknown) => record("bindSessionServices", bindings),
    setAgentIdProvider: (provider: () => string) => record("setAgentIdProvider", provider),
    requestQuiesceForUpgrade: () => record("requestQuiesceForUpgrade"),
    interrupt: (reason: string) => {
      record("interrupt", reason);
      return true;
    },
    setBackgroundSubagentHandler: (fn: (completion: unknown) => unknown) => handlers.set("backgroundSubagent", fn),
    setBackgroundSubagentDispatchHandler: (fn: (dispatch: unknown) => unknown) => handlers.set("subagentDispatch", fn),
    setComputerUseUsageHandler: (fn: (report: unknown) => unknown) => handlers.set("computerUseUsage", fn),
    setSubagentEventHandler: (fn: (event: unknown) => unknown) => handlers.set("subagentEvent", fn),
    setAsyncTasksEventHandler: (fn: (event: unknown) => unknown) => handlers.set("asyncTasks", fn),
    setBackgroundShellHandler: (fn: (completion: unknown) => unknown) => handlers.set("backgroundShell", fn),
    setPendingWakeArmedHandler: (fn: (event: unknown) => unknown) => handlers.set("wakeArmed", fn),
    setPendingWakeDisarmedHandler: (fn: (event: unknown) => unknown) => handlers.set("wakeDisarmed", fn),
    setTurnAwaitHandler: (fn: (observation: unknown) => unknown) => handlers.set("turnAwait", fn),
    setFirstTokenHandler: (fn: (observation: unknown) => unknown) => handlers.set("firstToken", fn),
    setSendDispatchHandler: (fn: (observation: unknown) => unknown) => handlers.set("sendDispatch", fn),
    setTurnRetryHandler: (fn: (report: unknown) => unknown) => handlers.set("turnRetry", fn),
    setToolCallDiagnosticHandler: (fn: (observation: unknown) => unknown) => handlers.set("toolCallDiagnostic", fn),
  };
  return runner;
}

/** A transcript manager with every collaborator a registry reaches for, each call written down. */
function world(
  options: {
    canExecute?: boolean;
    canExecuteGroupMember?: boolean;
    remoteRoom?: boolean;
    quiescing?: boolean;
    running?: string[];
    execution?: Record<string, unknown>;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const session = {
    id: "agent-1",
    agentStore: { kind: "agent-store" },
    memory: { kind: "memory" },
    db: { kind: "db" },
    automations: { kind: "automations" },
    workflows: { kind: "workflows" },
    channels: { kind: "channels" },
  };
  const tm = {
    execution: {
      canExecute: options.canExecute === true,
      canExecuteGroupMember: options.canExecuteGroupMember === true,
      isRunReady: async () => true,
      createRunner: (target: unknown, hooks: unknown) => {
        record("createRunner", hooks);
        return registry?.getRunner === undefined ? undefined : undefined;
      },
      ...options.execution,
    },
    groupChat: { isRemoteRoomSession: () => options.remoteRoom === true },
    upgradeResume: { quiescingForUpgrade: options.quiescing === true },
    runLifecycle: { runningAgentIds: () => new Set<string>(options.running ?? []) },
    telemetry: {
      reportTurnInterrupt: (report: unknown) => record("reportTurnInterrupt", report),
      reportComputerUseUsage: (report: unknown) => record("reportComputerUseUsage", report),
      reportTurnAwait: (report: unknown) => record("reportTurnAwait", report),
      reportTtft: (report: unknown) => record("reportTtft", report),
      reportSendDispatch: (report: unknown) => record("reportSendDispatch", report),
      reportTurnRetry: (report: unknown) => record("reportTurnRetry", report),
    },
    productAnalytics: { trackEvent: (name: string, properties: unknown) => record("trackEvent", name, properties) },
    backgroundWakes: {
      handleBackgroundSubagentCompletion: (completion: unknown) => record("handleBackgroundSubagentCompletion", completion),
      handleBackgroundShellCompletion: (completion: unknown) => record("handleBackgroundShellCompletion", completion),
    },
    pendingWakes: {
      persistPendingWake: (event: unknown) => record("persistPendingWake", event),
      disarmPendingWake: (event: unknown) => record("disarmPendingWake", event),
    },
    roster: {
      emitSubagents: (runner: unknown, event: unknown) => record("emitSubagents", event),
      emitAsyncTasks: (runner: unknown, event: unknown) => record("emitAsyncTasks", event),
      resolveAgentProfile: (target: unknown) => ({ name: "profile" }),
    },
    turnRuntime: { reportToolCallDiagnostic: (target: unknown, observation: unknown) => record("reportToolCallDiagnostic", observation) },
    handleAgentUpdate: (update: unknown, target: unknown) => {
      record("handleAgentUpdate", update);
      return "assigned-id";
    },
    emitAgentRunLifecycle: (event: unknown) => record("emitAgentRunLifecycle", event),
    createAttachmentIngestor: (target: unknown) => () => record("ingestAttachment"),
    createAssetImagePersister: (target: unknown) => () => record("persistImage"),
    createMediaBytesPersister: (target: unknown) => () => record("persistMediaBytes"),
    setTurnExecution: (execution: Record<string, unknown>) => {
      record("setTurnExecution", execution);
      tm.execution = execution as typeof tm.execution;
    },
    attachRunnerFactory: (factory: (target: unknown, hooks: unknown) => unknown) => record("attachRunnerFactory", factory),
  };
  const registry = new RunnerRegistry(tm);
  return { registry, tm, session, calls, named: (name: string) => calls.filter((call) => call.name === name) };
}

describe("how a failure is described coarsely", () => {
  it("names a backend refusal by its own code and anything else by its own name", () => {
    const connectFailure = Object.assign(new Error("refused"), { code: 13, findDetails: () => [{ details: { title: "t" } }] });
    assert.deepEqual(coarseErrorTypeAndCode(connectFailure), { errorType: "connect_error", errorCode: "Internal" });
    class SpecialError extends Error {}
    Object.defineProperty(SpecialError.prototype, "name", { value: "SpecialError" });
    assert.deepEqual(coarseErrorTypeAndCode(new SpecialError("x")), { errorType: "SpecialError" });
    const nameless = new Error("x");
    nameless.name = "";
    assert.deepEqual(coarseErrorTypeAndCode(nameless), { errorType: "error" });
    assert.deepEqual(coarseErrorTypeAndCode("just a string"), { errorType: "unknown" });
  });
});

describe("the watcher that releases a wedged run", () => {
  it("interrupts whatever is holding the conversation and says it did", () => {
    const world1 = world({ running: ["agent-1"] });
    const member = { interrupt: (reason: string) => { world1.calls.push({ name: "memberInterrupt", args: [reason] }); return true; } };
    const runner = { interrupt: (reason: string) => { world1.calls.push({ name: "runnerInterrupt", args: [reason] }); return false; } };
    world1.registry.activeGroupMemberRunners.set("agent-1", member);
    world1.registry.runners.set("agent-1", runner);
    assert.equal(world1.registry.interruptWedgedRunForWatchdog("agent-1"), true);
    const reason = "run-queue watchdog: releasing a wedged predecessor";
    assert.deepEqual(world1.named("memberInterrupt")[0]?.args, [reason]);
    assert.deepEqual(world1.named("runnerInterrupt")[0]?.args, [reason]);
    assert.deepEqual(world1.named("reportTurnInterrupt")[0]?.args, [{ conversationId: "agent-1", reason: "watchdog", hadActiveRun: true, wasInFlight: true }]);
    // Nothing running means nothing was interrupted, and that is what is reported.
    const idle = world();
    assert.equal(idle.registry.interruptWedgedRunForWatchdog("agent-1"), false);
    assert.deepEqual(idle.named("reportTurnInterrupt")[0]?.args, [{ conversationId: "agent-1", reason: "watchdog", hadActiveRun: false, wasInFlight: false }]);
  });
});

describe("attaching a runner", () => {
  it("hands the runner its stores, its session id and the ways to persist what it makes", () => {
    const world1 = world();
    const attached = recordingRunner();
    world1.registry.attachRunner(attached);
    const factory = world1.named("attachRunnerFactory")[0]?.args[0] as (session: unknown, hooks: Record<string, unknown>) => unknown;
    const hooks = { agentProfileProvider: () => ({ name: "profile" }), ingestAttachment: "ingest", persistImage: "image", persistMediaBytes: "media" };
    assert.equal(factory(world1.session, hooks), attached);
    assert.deepEqual(attached.named("bindSessionServices")[0]?.args, [{
      agentState: { store: world1.session.agentStore, profileProvider: hooks.agentProfileProvider },
      memory: {
        primary: world1.session.memory,
        snapshots: world1.session.db,
        profileSnapshots: world1.session.db,
        episodeProgress: world1.session.db,
      },
      automation: { automations: world1.session.automations, workflows: world1.session.workflows, channels: world1.session.channels },
      attachments: { ingestor: "ingest", imagePersister: "image", mediaPersister: "media" },
    }]);
    const idProvider = attached.named("setAgentIdProvider")[0]?.args[0] as () => string;
    assert.equal(idProvider(), "agent-1");
  });

  it("patches the run surface without dropping what was already there", async () => {
    const world1 = world({ execution: { canExecute: true, createRunner: "previous", marker: "kept" } });
    world1.registry.attachRunnerFactory((session: unknown, hooks: unknown) => "group-runner");
    const execution = world1.tm.execution as unknown as Record<string, unknown>;
    // The factory replaces how a runner is made; everything else on the run surface is left as it was.
    assert.deepEqual([execution.canExecute, execution.marker], [true, "kept"]);
    assert.equal((execution.createRunner as (...args: unknown[]) => unknown)(world1.session, {}), "group-runner");
    assert.equal(world1.named("setTurnExecution").length, 1);
    world1.registry.attachGroupMemberRunnerFactory((session: unknown, hooks: unknown, overrides: unknown) => "member");
    const patched = world1.tm.execution as unknown as Record<string, unknown>;
    assert.equal(patched.canExecuteGroupMember, true);
    assert.equal((patched.createGroupMemberRunner as (...args: unknown[]) => unknown)(world1.session, {}, { model: "m" }), "member");
    world1.registry.attachRunReadinessProbe(async () => false);
    assert.equal(await world1.registry.isRunReady(), false);
    const probe = (world1.tm.execution as unknown as Record<string, unknown>).isRunReady as () => Promise<boolean>;
    assert.equal(await probe(), false);
  });
});

describe("the runner a conversation gets", () => {
  it("refuses a room that has no local agent, and one with nothing attached to run turns", () => {
    const room = world({ remoteRoom: true });
    assert.throws(() => room.registry.getRunner(room.session), SlateRemoteRoomError);
    assert.equal(room.named("createRunner").length, 0);
    const unattached = world();
    assert.throws(() => unattached.registry.getRunner(unattached.session), new RegExp(RUNNER_UNATTACHED_MESSAGE));
    const member = world({ canExecute: true });
    assert.throws(() => member.registry.createGroupMemberRunner(member.session, undefined, undefined), new RegExp(RUNNER_UNATTACHED_MESSAGE));
  });

  it("makes a runner once, wires it, and asks it to quiesce while an upgrade is waiting", () => {
    const world1 = world({ canExecute: true, quiescing: true });
    const created = recordingRunner();
    (world1.tm.execution as unknown as Record<string, unknown>).createRunner = (session: unknown, hooks: unknown) => {
      world1.calls.push({ name: "createRunner", args: [session, hooks] });
      return created;
    };
    const runner = world1.registry.getRunner(world1.session);
    assert.equal(runner, created);
    assert.equal(world1.named("createRunner").length, 1);
    assert.equal(created.named("requestQuiesceForUpgrade").length, 1);
    // The same conversation gets the same runner back, and an upgrade that starts later still reaches it.
    assert.equal(world1.registry.getRunner(world1.session), created);
    assert.equal(world1.named("createRunner").length, 1);
    assert.equal(created.named("requestQuiesceForUpgrade").length, 2);
    // A group member's runner is made through the group surface, with its overrides and transport.
    const member = world({ canExecuteGroupMember: true });
    const memberRunner = recordingRunner();
    (member.tm.execution as unknown as Record<string, unknown>).createGroupMemberRunner = (session: unknown, hooks: unknown, overrides: unknown) => {
      member.calls.push({ name: "createGroupMemberRunner", args: [hooks, overrides] });
      return memberRunner;
    };
    assert.equal(member.registry.createGroupMemberRunner(member.session, "transport", { model: "m" }), memberRunner);
    const [hooks, overrides] = member.named("createGroupMemberRunner")[0]?.args as [Record<string, unknown>, unknown];
    assert.equal(hooks.transport, "transport");
    assert.deepEqual(overrides, { model: "m" });
    assert.equal(memberRunner.handler("subagentEvent") instanceof Function, true);
  });
});

describe("what a wired runner's handlers do", () => {
  it("passes on what the runner wakes, waits for, spends and fails with", () => {
    const world1 = world({ quiescing: true });
    const runner = recordingRunner();
    world1.registry.wireRunnerLifecycle(runner, world1.session, "ttft-conversation");
    assert.equal(runner.named("requestQuiesceForUpgrade").length, 1);
    runner.handler("backgroundSubagent")?.({ id: "sub-1" });
    assert.deepEqual(world1.named("handleBackgroundSubagentCompletion")[0]?.args, [{ id: "sub-1" }]);
    runner.handler("backgroundShell")?.({ id: "shell-1" });
    assert.deepEqual(world1.named("handleBackgroundShellCompletion")[0]?.args, [{ id: "shell-1" }]);
    runner.handler("wakeArmed")?.({ at: 1 });
    runner.handler("wakeDisarmed")?.({ at: 2 });
    assert.deepEqual(world1.named("persistPendingWake")[0]?.args, [{ at: 1 }]);
    assert.deepEqual(world1.named("disarmPendingWake")[0]?.args, [{ at: 2 }]);
    // What the runner says about itself goes to the roster, keyed by the runner it came from.
    runner.handler("subagentEvent")?.({ kind: "started" });
    runner.handler("asyncTasks")?.({ kind: "listed" });
    assert.deepEqual(world1.named("emitSubagents")[0]?.args, [{ kind: "started" }]);
    assert.deepEqual(world1.named("emitAsyncTasks")[0]?.args, [{ kind: "listed" }]);
    // Timings are reported against the conversation, except the first token, which is reported against the id it was
    // wired with.
    runner.handler("turnAwait")?.({ awaitedMs: 5 });
    assert.deepEqual(world1.named("reportTurnAwait")[0]?.args, [{ conversationId: "agent-1", awaitedMs: 5 }]);
    runner.handler("firstToken")?.({ ttftMs: 9 });
    assert.deepEqual(world1.named("reportTtft")[0]?.args, [{ conversationId: "ttft-conversation", ttftMs: 9 }]);
    runner.handler("sendDispatch")?.({ queuedMs: 1 });
    assert.deepEqual(world1.named("reportSendDispatch")[0]?.args, [{ conversationId: "agent-1", queuedMs: 1 }]);
    // A tool call the runner diagnoses is handed to the turn runtime, which owns the reporting-once rule.
    runner.handler("toolCallDiagnostic")?.({ kind: "error", toolCallId: "t1" });
    assert.deepEqual(world1.named("reportToolCallDiagnostic")[0]?.args, [{ kind: "error", toolCallId: "t1" }]);
    // A retry reports what kind of failure caused it, and the platform's own classification behind it.
    runner.handler("turnRetry")?.({ error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), attempt: 2 });
    assert.deepEqual(world1.named("reportTurnRetry")[0]?.args, [
      { conversationId: "agent-1", attempt: 2, errorType: "Error", cause: SlateError.streamReset().code },
    ]);
    const connectFailure = Object.assign(new Error("refused"), { code: 13, findDetails: () => [{ details: { title: "t" } }] });
    runner.handler("turnRetry")?.({ error: connectFailure, attempt: 1 });
    assert.deepEqual(world1.named("reportTurnRetry")[1]?.args, [
      { conversationId: "agent-1", attempt: 1, errorType: "connect_error", errorCode: "Internal", cause: SlateError.backendRejected().code },
    ]);
  });

  it("counts what a subagent and a computer use cost", () => {
    const world1 = world();
    const runner = recordingRunner();
    world1.registry.wireRunnerLifecycle(runner, world1.session, "agent-1");
    runner.handler("subagentDispatch")?.({ parentAgentId: "p", subagentAgentId: "s", subagentType: "general", toolCallId: "t", subagentRequestId: "r" });
    assert.deepEqual(world1.named("trackEvent")[0]?.args, [
      "slate.subagent.dispatched",
      { parent_agent_id: "p", subagent_agent_id: "s", subagent_type: "general", tool_call_id: "t", subagent_request_id: "r" },
    ]);
    // A computer use with usage reports the tokens and asks for nothing it does not have.
    runner.handler("computerUseUsage")?.({
      parentAgentId: "p",
      subagentAgentId: "s",
      subagentType: "computerUse",
      subagentRequestId: "r",
      outcome: "ok",
      durationMs: 1_200,
      toolCallCount: 3,
      turnEndedCount: 1,
      modelId: "model-1",
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3 },
    });
    assert.deepEqual(world1.named("trackEvent")[1]?.args, [
      "slate.computer_use.usage",
      {
        parent_agent_id: "p",
        subagent_agent_id: "s",
        subagent_type: "computerUse",
        subagent_request_id: "r",
        outcome: "ok",
        duration_ms: 1_200,
        tool_call_count: 3,
        turn_ended_count: 1,
        has_usage: true,
        model_id: "model-1",
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 1,
        cache_write_tokens: 2,
        reasoning_tokens: 3,
      },
    ]);
    const report = world1.named("reportComputerUseUsage")[0]?.args[0] as Record<string, unknown>;
    assert.equal(report.outcome, "ok");
    // A computer use that reports nothing still says so, and leaves the model and the tokens out.
    runner.handler("computerUseUsage")?.({ parentAgentId: "p", outcome: "failed" });
    const sparse = world1.named("trackEvent")[2]?.args[1] as Record<string, unknown>;
    assert.deepEqual(Object.entries(sparse).filter(([key]) => key.startsWith("has_") || key === "model_id" || key.endsWith("_tokens")), [["has_usage", false]]);
    assert.equal(world1.named("reportComputerUseUsage").length, 2);
  });

  it("gives the hooks a transport that feeds the conversation's own updates", () => {
    const world1 = world();
    const hooks = world1.registry.runnerHooksFor(world1.session) as Record<string, unknown>;
    const transport = hooks.transport as { onUpdate: (update: unknown) => void; lastSentMessageId: () => string | undefined };
    transport.onUpdate({ type: "send-message" });
    assert.deepEqual(world1.named("handleAgentUpdate")[0]?.args, [{ type: "send-message" }]);
    assert.equal(transport.lastSentMessageId(), "assigned-id");
    // A transport the caller already has is used as it is.
    const given = { onUpdate: () => {} };
    assert.equal((world1.registry.runnerHooksFor(world1.session, given) as Record<string, unknown>).transport, given);
    // The rest of the hooks reach the manager they belong to.
    (hooks.onRunLifecycle as (event: unknown) => void)("event");
    assert.deepEqual(world1.named("emitAgentRunLifecycle")[0]?.args, ["event"]);
    assert.deepEqual((hooks.agentProfileProvider as () => unknown)(), { name: "profile" });
    (hooks.ingestAttachment as () => void)();
    (hooks.persistImage as () => void)();
    (hooks.persistMediaBytes as () => void)();
    assert.deepEqual(
      [world1.named("ingestAttachment").length, world1.named("persistImage").length, world1.named("persistMediaBytes").length],
      [1, 1, 1],
    );
  });
});

describe("the remote room refusal", () => {
  it("tells the caller why there is no local agent", () => {
    const room = world({ remoteRoom: true });
    assert.throws(
      () => room.registry.getRunner(room.session),
      (error: unknown) => error instanceof SlateRemoteRoomError
        && error.message === "This is a shared chat hosted by another user; it has no local agent to run.",
    );
  });
});
