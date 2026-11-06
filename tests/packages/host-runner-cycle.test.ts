/**
 * The turn cycle: the projection a stream is started from, the shell around a run, the runner that holds a conversation,
 * and the composition that joins them. Each case pins one decision the platform makes about a turn.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "../../source/packages/context/context.ts";
import type { SlateConversationState } from "../../source/packages/agent/conversation-state.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import { ConversationAction, ConversationStateStructure, ResumeAction, UserMessage, UserMessageAction } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { SlateEmptyPromptError, createTurnRunShell, createTurnAgentRunContext } from "../../source/host/runner/turn-run-shell.ts";
import { RESUME_TURN_ACTION } from "../../source/adapters/interop/agent/turn-resume-action-adapter.ts";
import { createTurnAgentRunInputProjection, createTurnAgentRunStreamInput, createTurnAgentStreamStart, createTurnToolSession } from "../../source/host/runner/turn-agent-composition.ts";
import { cloneTurnState } from "../../source/host/runner/production-turn-agent-owner.ts";
import { projectInteropTurnRun } from "../../source/adapters/interop/agent/turn-agent-run-projection-adapter.ts";
import { SlateAgentRunner } from "../../source/host/runner/slate-agent-runner.ts";
import { presentOptions } from "../../source/host/runner/optional-options.ts";

/** A live-turn context: the review and the resource code only need these three members. */
function fakeContext(overrides: Record<string, unknown> = {}): Context {
  return {
    signal: new AbortController().signal,
    get: () => undefined,
    with: () => fakeContext(overrides),
    withCancel: () => [fakeContext(overrides), () => {}],
    ...overrides,
  } as unknown as Context;
}

function stateWith(turns: number): ConversationStateStructure {
  return new ConversationStateStructure({ turns: Array.from({ length: turns }, () => new Uint8Array()) });
}

function slateStateWith(turns: number): SlateConversationState {
  return {
    privacyMode: PrivacyMode.UNSPECIFIED,
    rootPromptMessagesJson: [],
    turns: Array.from({ length: turns }, () => new Uint8Array()),
    todos: [],
    previousWorkspaceUris: [],
    summaryArchives: [],
    fileStatesV2: new Map(),
    readPaths: [],
  };
}

/** Waits (bounded) until the predicate holds, so a test never hangs on a step the host has not reached yet. */
async function until(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the host never reached the expected step");
}

describe("the state and action a stream starts from", () => {
  it("clones a conversation snapshot without sharing its mutable arrays", () => {
    const original = stateWith(1);
    const copy = cloneTurnState(original);
    assert.notEqual(copy, original);
    copy.turns.push(new Uint8Array());
    assert.equal(original.turns.length, 1);
  });

  it("projects the state and action to their redacted forms, and resumes with the canonical resume action", () => {
    const baseState = stateWith(1);
    // A user message, so a retained action and a resume action are distinguishable.
    const action = new ConversationAction({
      action: { case: "userMessageAction", value: new UserMessageAction({ userMessage: new UserMessage({ text: "hi", messageId: "m1" }), prependUserMessages: [] }) },
    });
    const fresh = projectInteropTurnRun({ baseState, action, resumeAction: RESUME_TURN_ACTION, privacyMode: PrivacyMode.UNSPECIFIED });
    assert.equal(fresh.isResume, false);
    assert.equal(fresh.action.action.case, "userMessageAction");
    // A retry resumes from the accepted checkpoint and sends the empty resume action, not the original request again.
    const resumed = projectInteropTurnRun({ baseState, action, resumeFrom: stateWith(2), resumeAction: RESUME_TURN_ACTION, privacyMode: PrivacyMode.UNSPECIFIED });
    assert.equal(resumed.isResume, true);
    assert.equal(resumed.action.action.case, RESUME_TURN_ACTION.action.case);
  });

  it("produces the action first, then the tools, then a cloned state; a discovery failure is reported, not thrown", async () => {
    const order: string[] = [];
    const source = stateWith(1);
    const failure = new Error("no mcp today");
    let reported: unknown;
    const projection = await createTurnAgentRunInputProjection({
      runCtx: fakeContext(),
      async createAction() {
        order.push("action");
        return { action: { case: "userMessageAction", value: {} } } as never;
      },
      mcp: {
        async getTools() {
          order.push("tools");
          throw failure;
        },
        refreshAccountConfig() {
          order.push("refresh");
        },
      },
      onMcpDiscoveryFailed: (error) => {
        reported = error;
      },
      getConversationState: () => {
        order.push("state");
        return source;
      },
    });
    assert.deepEqual(order, ["action", "tools", "refresh", "state"]);
    assert.equal(reported, failure);
    assert.deepEqual(projection.mcpTools, []);
    // The state handed on is a copy: editing it cannot reach the conversation's own state.
    projection.baseState.turns.push(new Uint8Array());
    assert.equal(source.turns.length, 1);
  });

  it("forwards the checkpoint callback and the projected values to the Agent's stream", async () => {
    const calls: unknown[][] = [];
    const persistCheckpoint = async () => {};
    const start = createTurnAgentStreamStart({
      agent: { agent: { runStream: async (...args: unknown[]) => (calls.push(args), slateStateWith(0)) } as never },
      baseState: stateWith(1),
      action: { action: { case: "resumeAction", value: new ResumeAction() } } as never,
      privacyMode: PrivacyMode.UNSPECIFIED,
      mcpTools: [{ name: "tool" }],
    });
    const result = await start.startStream(fakeContext(), undefined, persistCheckpoint);
    assert.equal(result.turns.length, 0);
    const [, state, action, tools, persisted] = calls[0]!;
    assert.equal((state as { turns: unknown[] }).turns.length, 1);
    assert.equal((state as SlateConversationState).privacyMode, PrivacyMode.UNSPECIFIED);
    assert.equal("_privacyMode" in (state as object), false);
    assert.equal((action as { action: { case: string } }).action.case, "resumeAction");
    assert.deepEqual(tools, [{ name: "tool" }]);
    assert.equal(persisted, persistCheckpoint);
  });

  it("runs a tool message through the reminder chain, and gives a silent turn no reminders", () => {
    const executorOf = (options: { isSubagentRunner: boolean; isSilenceAllowed: boolean; episodeId?: string }) =>
      createTurnToolSession({
        getExecutor: () => ({ executeToolStream: async () => ({ response: Promise.resolve("ok"), toolCallDescriptors: Promise.resolve([]) }) }) as never,
        isSubagentRunner: options.isSubagentRunner,
        isSilenceAllowed: options.isSilenceAllowed,
        ...(options.episodeId === undefined ? {} : { diskPressureReminderEpisodeId: options.episodeId }),
      });
    // Both construct a fresh executor; what differs is which reminders wrap it, which is the identity of the result.
    assert.notEqual(executorOf({ isSubagentRunner: false, isSilenceAllowed: false }).getExecutor(), undefined);
    assert.notEqual(executorOf({ isSubagentRunner: false, isSilenceAllowed: false, episodeId: "episode-1" }).getExecutor(), undefined);
    assert.notEqual(executorOf({ isSubagentRunner: true, isSilenceAllowed: false }).getExecutor(), undefined);
    assert.notEqual(executorOf({ isSubagentRunner: false, isSilenceAllowed: true }).getExecutor(), undefined);
  });
});

describe("the shell around one run", () => {
  /** A host whose prepare step the test controls, so a run can be interrupted at a known point. */
  function shellHost(overrides: Record<string, unknown> = {}) {
    const events: string[] = [];
    const aborted: string[] = [];
    const pending: Array<() => void> = [];
    const host = {
      isSubagentRunner: false,
      subagents: { sessions: new Map<string, { interrupt(reason: string): void }>() },
      getConversationId: () => "agent-1",
      runGeneration: () => 1,
      setActiveTurnRequestSource: () => {},
      beginAutoReviewUserMessageEpoch: () => {},
      setActiveRunInterrupted: (value: boolean) => events.push(`interrupted:${value}`),
      setAwaitingUserSelection: (value: boolean) => events.push(`awaiting:${value}`),
      isAwaitingUserSelection: () => false,
      emitRunLifecycle: (event: { type: string }) => events.push(`lifecycle:${event.type}`),
      async prepareTurn(prompt: string) {
        events.push(`prepare:${prompt}`);
        await new Promise<void>((resolve) => pending.push(resolve));
        return { action: {}, baseState: stateWith(0), transcriptPersistenceEnabled: false, session: { getModelId: () => "model-1", getExecutor: () => ({}) } as never };
      },
      async runPreparedTurn() {
        events.push("run");
        return stateWith(0);
      },
      createSettleHost: () => ({
        isSubagentRunner: false,
        getTranscriptId: () => "agent-1",
        getBlobStore: () => ({}),
        agentStore: () => ({ handleCheckpoint: async () => {}, getMetadata: () => undefined }),
        setLocalState: () => {},
        ownsRunner: () => true,
        isRunSuperseded: () => false,
        latestPromptMessages: () => [],
        persistAnnouncedAgentProfile: () => {},
      }),
      profilePromptSnapshots: () => ({}),
      onRunUnwind: () => aborted.push("unwind"),
      ...overrides,
    };
    return { host, events, pending, aborted };
  }

  it("refuses a prompt with nothing in it", async () => {
    const { host } = shellHost();
    const shell = createTurnRunShell(host);
    await assert.rejects(() => shell.run("   "), (error: unknown) => error instanceof SlateEmptyPromptError);
    // A prompt with an attachment is not empty.
    const { host: attached, pending } = shellHost();
    const attachedShell = createTurnRunShell(attached);
    const run = attachedShell.run("", { selectedImages: [{}] });
    await until(() => pending.length > 0);
    pending.forEach((resolve) => resolve());
    await run;
  });

  it("refuses a superseding request for a run that has not dispatched, unless it carries recovery for a recovered run", async () => {
    const { host, pending, events } = shellHost();
    const shell = createTurnRunShell(host);
    // The user's own message, re-sent unchanged: the one shape a resend is allowed to supersede.
    const run = shell.run("hello", { messageId: "m1", recentUserMessages: [{ id: "m1", text: "hello" }] });
    await until(() => pending.length > 0);
    assert.equal(shell.interrupt("stop", { carriesRecovery: false }), false);
    assert.equal(shell.interrupt("stop", { carriesRecovery: true }), true);
    assert.equal(shell.hasActiveRun(), true);
    assert.equal(shell.activeRequestId() !== undefined, true);
    pending.forEach((resolve) => resolve());
    await run;
    // The run is over: no interrupt can touch it, and the lifecycle was closed exactly once.
    assert.equal(shell.interrupt("stop"), false);
    assert.equal(shell.hasActiveRun(), false);
    assert.equal(events.filter((event) => event.startsWith("lifecycle")).length, 2);
  });

  it("interrupts a dispatched run, and pauses for the user instead of aborting quietly", async () => {
    const { host, pending, events } = shellHost({
      async runPreparedTurn(_prepared: unknown, _context: unknown, callbacks: { noteDispatched(): void; pauseForUser(reason: string): void }) {
        callbacks.noteDispatched();
        callbacks.pauseForUser("waiting for the widget");
        throw new Error("aborted by the pause");
      },
    });
    const shell = createTurnRunShell(host);
    const run = shell.run("hello");
    await until(() => pending.length > 0);
    pending.forEach((resolve) => resolve());
    // A pause aborts the run on purpose: the caller gets a result that says it is awaiting the user, not an error.
    const result = (await run) as { awaitingUserSelection?: boolean; aborted?: boolean };
    assert.equal(result.awaitingUserSelection, true);
    assert.equal(events.includes("awaiting:true"), true);
    assert.equal(shell.isQuiescingForUpgrade(), false);
  });

  it("ends a run for a host upgrade only once, and reports it as quiesced", async () => {
    const { host, pending } = shellHost({
      async runPreparedTurn(_prepared: unknown, _context: unknown, callbacks: { persistCheckpoint(checkpoint: unknown): Promise<void> }) {
        shell.requestQuiesceForUpgrade();
        await callbacks.persistCheckpoint(stateWith(0));
        throw new Error("aborted by the upgrade");
      },
    });
    const shell = createTurnRunShell(host);
    const run = shell.run("hello");
    await until(() => pending.length > 0);
    pending.forEach((resolve) => resolve());
    const result = (await run) as { quiescedForUpgrade?: boolean; aborted?: boolean };
    assert.equal(result.quiescedForUpgrade, true);
    assert.equal(result.aborted, false);
    assert.equal(shell.isQuiescingForUpgrade(), true);
    shell.cancelQuiesceForUpgrade();
    assert.equal(shell.isQuiescingForUpgrade(), false);
  });

  it("interrupts subagents with the run, and exposes the stream path it was given", async () => {
    const interrupted: string[] = [];
    const { host } = shellHost({
      subagents: { sessions: new Map([["child-1", { interrupt: (reason: string) => interrupted.push(reason) }]]) },
    });
    const shell = createTurnRunShell(host);
    assert.equal(shell.interruptAll("host shutdown"), false);
    assert.deepEqual(interrupted, ["host shutdown"]);
    // The shell hands out the path it was built with, and says so when it has none.
    assert.equal(shell.turnStreamPath, undefined);
    await assert.rejects(() => shell.runTurnStream({ runCtx: fakeContext(), persistCheckpoint: async () => {} }), /without a turn stream path/);
  });
});

describe("the runner that holds a conversation", () => {
  function runnerWith(overrides: Partial<ConstructorParameters<typeof SlateAgentRunner>[0]> = {}) {
    const updates: Array<Record<string, unknown>> = [];
    const runner = new SlateAgentRunner({
      conversationId: "agent-1",
      transport: { onUpdate: (update) => updates.push(update as Record<string, unknown>) },
      ...overrides,
    });
    return { runner, updates };
  }

  it("keeps the runner's Agent checkpoint isolated from callers", () => {
    const { runner } = runnerWith();
    const source = new ConversationStateStructure({ turns: [new Uint8Array([1])] });
    runner.setAgentConversationStateStructure(source);
    const snapshot = runner.getAgentConversationStateStructure();
    assert.notEqual(snapshot, source);
    snapshot.turns.push(new Uint8Array([2]));
    assert.equal(runner.getAgentConversationStateStructure().turns.length, 1);
  });

  it("binds the session graph as one snapshot and advances the generation with its Agent owner", () => {
    const { runner } = runnerWith();
    const source = new ConversationStateStructure({ turns: [new Uint8Array([4])] });
    const generation = runner.runGeneration;
    runner.bindSessionServices({
      agentState: { store: { getConversationStateStructure: () => source }, profileProvider: undefined },
      memory: { primary: {}, user: {}, project: {}, snapshots: {}, profileSnapshots: {}, episodeProgress: {} },
      automation: { automations: {}, workflows: {}, channels: {} },
      toolAccess: { mcp: {}, management: {} },
      attachments: { ingestor: () => "", imagePersister: () => undefined, mediaPersister: () => undefined },
    });

    assert.equal(runner.runGeneration, generation + 1);
    assert.equal(runner.getAgentConversationStateStructure().turns.length, 1);

    runner.bindSessionServices({ memory: { primary: { refreshed: true } } });
    assert.equal(runner.runGeneration, generation + 1);
  });

  it("counts what a run produced: streamed text, sent messages, a reaction, and a pause for the user", () => {
    const { runner, updates } = runnerWith();
    (runner as unknown as { emitUpdate(update: unknown): void }).emitUpdate({ type: "text-delta", text: "hello" });
    (runner as unknown as { emitUpdate(update: unknown): void }).emitUpdate({ type: "send-message", message: { type: "text", content: "hi" }, timestampMs: 1 });
    assert.equal(updates.length, 2);
    // A widget-like message pauses the run for the user; the runner is the one that knows it.
    (runner as unknown as { emitUpdate(update: unknown): void }).emitUpdate({ type: "send-message", message: { type: "widget" }, timestampMs: 2 });
    assert.equal(runner.isRunAwaitingUserSelection(), false, "no run is active, so nothing is awaiting inside it");
  });

  it("answers a quiescing host with the empty result instead of running", async () => {
    const { runner } = runnerWith();
    runner.requestQuiesceForUpgrade();
    const result = (await runner.run("hello")) as { quiescedForUpgrade?: boolean; text: string };
    assert.deepEqual(result, { text: "", sentMessageCount: 0, reacted: false, aborted: false, quiescedForUpgrade: true });
  });

  it("aborts only the active attempt and includes its output in the result", async () => {
    let activeSignal: AbortSignal | undefined;
    let enteredStep!: () => void;
    const inStep = new Promise<void>((resolve) => { enteredStep = resolve; });
    const { runner } = runnerWith({
      async runStep(_step, context) {
        activeSignal = context.signal;
        context.emitUpdate({ type: "text-delta", text: "partial" });
        enteredStep();
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { done: true };
      },
    });

    const running = runner.run("hello");
    await inStep;
    assert.equal(runner.interrupt("user stopped"), true);
    const result = await running as { aborted: boolean; text: string };
    assert.equal(activeSignal?.aborted, true);
    assert.equal(result.aborted, true);
    assert.equal(result.text, "partial");
    assert.equal(runner.interrupt("late stop"), false);
  });

  it("allows a pre-dispatch replacement only when the unchanged user message can be recovered", async () => {
    let releasePreparation!: () => void;
    let preparationStarted!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    const { runner } = runnerWith({
      async prepare() {
        preparationStarted();
        await preparation;
      },
      async runStep() {
        return { done: true, value: "should not run" };
      },
    });
    const running = runner.run("same request", {
      messageId: "message-1",
      recentUserMessages: [{ id: "message-1", text: "same request" }],
    });
    await started;

    assert.equal(runner.interrupt("replace", { carriesRecovery: false }), false);
    assert.equal(runner.interrupt("replace", { carriesRecovery: true }), true);
    releasePreparation();
    const result = await running as { aborted: boolean };
    assert.equal(result.aborted, true);
  });

  it("runs a step loop until a step says it is done, and refuses an empty prompt", async () => {
    const steps: number[] = [];
    const { runner } = runnerWith({
      async prepare() {},
      maxSteps: 3,
      async runStep(step) {
        steps.push(step);
        return { done: step === 1, value: "done at 1" };
      },
      async settle(value) {
        assert.equal(value, "done at 1");
      },
    });
    assert.equal(await runner.run("hello"), "done at 1");
    assert.deepEqual(steps, [0, 1]);
    await assert.rejects(() => runner.run("   "), /Prompt cannot be empty/);
  });

  it("derives the box, transcript and browser identities, and records what a shell command did", () => {
    const recorded: unknown[] = [];
    const { runner } = runnerWith({
      boxId: "box-9",
      getBoxWindowIndex: () => 2,
      getTranscriptsFolder: () => "/tmp/transcripts/",
      actionAuditor: { record: (record) => recorded.push(record) },
      now: () => 42,
    });
    assert.equal(runner.resolveBoxId(), "box-9");
    assert.equal(runner.getTranscriptPath(), "/tmp/transcripts/agent-1/agent-1.jsonl");
    assert.deepEqual(runner.resolveBoxBrowser(), { display: ":2", cdpUrl: `http://127.0.0.1:${9_222 + 2}` });
    runner.auditShellCommand("foreground", "ls", "box");
    assert.deepEqual((recorded[0] as { action: unknown; occurredAtMs: number }).occurredAtMs, 42);
    assert.equal((recorded[0] as { action: { command: string } }).action.command, "ls");
    // A discovery failure is remembered apart from an empty listing.
    runner.noteMcpToolDiscoveryFailed(new Error("no"));
    assert.equal(runner.listRunningSubagents().length, 0);
  });

  it("stamps the run's own attributes, and treats an unpainted span as harmless", () => {
    const { runner } = runnerWith({ isSubagent: true, subagentType: "explore" });
    const stamped = runner.stampInheritableRunAttributes({}, "req-1", "user_message");
    assert.deepEqual(stamped.inheritableAttributes["slate.request_id"], "req-1");
    assert.deepEqual(stamped.inheritableAttributes["slate.subagent_type"], "explore");
    // A span that refuses attributes (already ended, or a fake) must not fail the turn.
    runner.stampCallerTurnRootRequestId({ setAttribute: () => { throw new Error("closed"); } }, "req-2");
  });
});

describe("the options helper", () => {
  it("drops what the caller did not give, and keeps what it did", () => {
    assert.deepEqual(presentOptions({ a: undefined, b: 1 }), { b: 1 });
    assert.deepEqual(presentOptions({}), {});
  });
});
