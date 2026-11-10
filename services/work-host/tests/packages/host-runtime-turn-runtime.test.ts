/**
 * One turn of a conversation: how it is run, what is nudged when the user heard nothing, which failures are worth
 * retrying, and what each update from the agent turns into.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FirstTokenStallError } from "../../source/host/runner/transient-stream-error.ts";
import { getTranscript, setTranscript } from "../../source/host/transcript/transcript-store.ts";
import type { TranscriptEntry } from "../../source/host/transcript/transcript-hub.ts";
import type { LiveTranscriptSession } from "../../source/host/transcript/session-runtime.ts";
import {
  CLOSING_SEND_NUDGE_PROMPT,
  MAX_REPLY_NUDGES,
  REPLY_NUDGE_PROMPT,
  TASK_ERROR_RESULT_CLASS,
  TurnRuntime,
  classifyAgentError,
  connectCodeOf,
  isDeliveryOwed,
  recordTurnQueueWaitSpan,
  setTurnCompletedSpanRecorder,
  type AgentRunner,
  type TurnResult,
} from "../../source/host/transcript/turn-runtime.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };

/** A connect failure the way the backend reports one: an error that can say what went wrong. */
function connectFailure(code: number, details: Array<Record<string, unknown>> = []) {
  return Object.assign(new Error("the backend refused"), { code, findDetails: () => details.map((detail) => ({ details: detail })) });
}

function connectWithDetails(details: Record<string, unknown>) {
  return connectFailure(13, [details]);
}

const delivered: TurnResult = { sentMessageCount: 1, reacted: false, aborted: false };
const silent: TurnResult = { sentMessageCount: 0, reacted: false, aborted: false };
const sessionOf = (id = "agent-1"): LiveTranscriptSession => ({ id, dbPath: `/tmp/${id}`, db: {} });

/** A transcript manager for one turn, with every call the runtime makes written down. */
function world(
  options: {
    turns?: TurnResult[];
    entries?: TranscriptEntry[];
    dbEntries?: TranscriptEntry[];
    session?: LiveTranscriptSession;
    questions?: { skippedQuestionPrompts: string[]; dismissedQuestionPrompts: string[] };
    nudgeError?: Error;
    runError?: Error;
    currentEpoch?: number;
    recovery?: { epoch: number; messageId: string; recentUserMessages: Array<{ id: string; text: string }> } | null;
    recoveryBreakEpoch?: number;
    wouldRecover?: boolean;
    ackOutstanding?: boolean;
    reactionApplied?: { before: TranscriptEntry; isAdding: boolean } | null;
    duringRun?: (runtime: { view?: TurnRuntime }) => void;
    withoutPrepend?: boolean;
  } = {},
) {
  const session = options.session ?? sessionOf();
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const storeEntries = structuredClone(options.entries ?? []);
  const dbEntries = structuredClone(options.dbEntries ?? options.entries ?? []);
  setTranscript(storeEntries);
  const remaining = [...(options.turns ?? [delivered])];
  const runtimeRef: { view?: TurnRuntime } = {};
  const db = {
    getTranscriptEntries: () => dbEntries,
    appendTranscriptEntry: (entry: TranscriptEntry) => {
      dbEntries.push(entry);
      return true;
    },
    updateTranscriptEntry: (id: string, update: (entry: TranscriptEntry) => TranscriptEntry) => {
      const index = dbEntries.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      const updated = update(dbEntries[index] as TranscriptEntry);
      dbEntries[index] = updated;
      return updated;
    },
    getRequestIds: () => options.dbEntries === undefined ? [] : [{ id: "req-last" }],
  };
  (session as { db: unknown }).db = db;
  const turn = {
    setModel: (modelId: string) => record("setModel", modelId),
    setRequestId: (requestId: string) => record("setRequestId", requestId),
    finalize: (status: string, tags?: unknown, detail?: unknown) => record("finalize", status, tags, detail),
  };
  const runner: AgentRunner = {
    run: async (prompt: string, runOptions: Record<string, unknown>) => {
      record("run", prompt, runOptions);
      options.duringRun?.(runtimeRef);
      if (options.runError !== undefined) throw options.runError;
      return remaining.shift() ?? silent;
    },
    ...(options.withoutPrepend === true
      ? {}
      : {
          wouldRecoverViaPrepend: async (recent: readonly unknown[], latestMessageId: string, skippedMessageId: string) => {
            record("wouldRecoverViaPrepend", recent, latestMessageId, skippedMessageId);
            return options.wouldRecover === true;
          },
        }),
    getObservedToolCallCount: () => 7,
  };
  const epoch = options.currentEpoch ?? 1;
  const tm = {
    sendPipeline: {
      currentTurnEpoch: () => epoch,
      latestRecoverySends: new Map(options.recovery == null ? [] : [[session.id, options.recovery]]),
      recoveryBreakEpochs: new Map(options.recoveryBreakEpoch === undefined ? [] : [[session.id, options.recoveryBreakEpoch]]),
      validateAiReplyTarget: (message: unknown, inFlightId: string, entries: readonly TranscriptEntry[]) => {
        record("validateAiReplyTarget", inFlightId, entries.length);
        return message;
      },
      applyAutoReplyThread: (message: unknown) => {
        record("applyAutoReplyThread");
        return message;
      },
      claimSendAttachmentBatchId: (sessionId: string) => {
        record("claimSendAttachmentBatchId", sessionId);
        return "batch-1";
      },
      appendSendMessageEntry: (entry: TranscriptEntry) => record("appendSendMessageEntry", entry),
    },
    sessions: { activeSession: session, liveSessions: new Map([[session.id, session]]) },
    runLifecycle: {
      activeRunSession: session,
      lastRequestIdBySession: new Map<string, string>(),
      trackComposingFromUpdate: (update: unknown, id: string) => record("trackComposing", id),
      trackRetryingFromUpdate: (update: unknown, target: unknown) => record("trackRetrying"),
      trackActivityFromUpdate: (update: unknown, id: string) => record("trackActivity", id),
      trackTurnRequestId: (id: string, requestId: string) => record("trackTurnRequestId", id, requestId),
      recordRequestId: async (requestId: string, target: unknown, source: unknown) => record("recordRequestId", requestId, source),
      reportTurnUsage: (target: unknown, usage: unknown) => record("reportTurnUsage", usage),
      endSessionRun: (target: unknown) => record("endSessionRun"),
    },
    telemetry: {
      startTurn: (args: unknown) => {
        record("startTurn", args);
        return turn;
      },
      reportTurnEmptyDelivery: (report: unknown) => record("reportTurnEmptyDelivery", report),
      reportClosingSendNudge: (report: unknown) => record("reportClosingSendNudge", report),
      reportToolCallStarted: (report: unknown) => record("reportToolCallStarted", report),
      reportToolCallError: (report: unknown) => record("reportToolCallError", report),
      reportToolCallStalled: (report: unknown) => record("reportToolCallStalled", report),
    },
    ackObligations: {
      retireAckRunToken: (id: string, token: string | undefined) => record("retireAckRunToken", id, token),
      fulfillAckObligation: (id: string | undefined, token: unknown) => record("fulfillAckObligation", id, token),
    },
    ackObligationStore: { get: (id: string) => (options.ackOutstanding === true ? { id } : undefined) },
    upgradeResume: { markAgentResumePending: (target: unknown, source: string) => record("markAgentResumePending", source) },
    widgetResponses: {
      collectUnansweredQuestionPrompts: (target: unknown) => {
        record("collectUnansweredQuestionPrompts");
        return options.questions ?? { skippedQuestionPrompts: [], dismissedQuestionPrompts: [] };
      },
      applyReaction: (args: { entryId: string; emoji: string; by: string }) => {
        record("applyReaction", args);
        return options.reactionApplied === undefined ? { before: { id: args.entryId, kind: "message", role: "user" }, isAdding: true } : options.reactionApplied;
      },
    },
    automationRuntime: { emitAutomations: (target: unknown) => record("emitAutomations") },
    roster: {
      emit: (event: unknown, id?: string) => record("emit", event, id),
      emitAgentUpdate: async (id: string) => record("emitAgentUpdate", id),
      applyAgentUpdateToOutline: (update: unknown) => record("applyAgentUpdateToOutline", update),
      emitClientSideToolV2: (event: unknown) => record("emitClientSideToolV2", event),
    },
    trayErrors: { pushError: (error: unknown) => record("pushError", error) },
    backgroundWakes: {
      deliverToChannel: (target: unknown, message: unknown, channel: string) => record("deliverToChannel", channel),
    },
    clientSideToolV2: { publish: (id: string, update: unknown) => { record("publishClientSideToolV2", id, update); return { kind: "v2" }; } },
    sessionStore: { markSessionActivity: (target: unknown) => record("markSessionActivity") },
    traceFlusher: () => record("traceFlusher"),
    onListenerConnectCard: (args: unknown) => record("onListenerConnectCard", args),
    onConnectorConnectCard: (args: unknown) => record("onConnectorConnectCard", args),
  };
  const view = new TurnRuntime(tm);
  runtimeRef.view = view;
  return {
    view, tm, session, turn, runner, calls, dbEntries, storeEntries,
    named: (name: string) => calls.filter((call) => call.name === name),
    stored: (id: string) => getTranscript().find((entry) => entry.id === id),
    persisted: (id: string) => dbEntries.find((entry) => entry.id === id),
  };
}

describe("what a turn decides before it runs", () => {
  it("tells a delivered turn from one the user heard nothing from", () => {
    assert.equal(isDeliveryOwed(delivered), false);
    assert.equal(isDeliveryOwed(silent), true);
    assert.equal(isDeliveryOwed({ sentMessageCount: 0, reacted: true }), false);
  });

  it("classifies what went wrong, from the provider's overload to something nobody recognises", () => {
    const codeOf = (error: unknown) => classifyAgentError(error).code;
    assert.equal(codeOf(new FirstTokenStallError(30_000)), SlateError.firstTokenStall().code);
    assert.equal(codeOf({ name: "InputTokenLimitError" }), SlateError.contextWindowOverflow().code);
    assert.equal(codeOf({ isConversationTooLarge: true }), SlateError.conversationTooLarge().code);
    assert.equal(codeOf({ code: "ECONNRESET" }), SlateError.streamReset().code);
    assert.equal(codeOf({ retryable: true }), SlateError.turnRetryable().code);
    // A connection that was reset carries the errno and the backend's own code along.
    const reset = classifyAgentError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET", cause: connectWithDetails({ title: "t" }) }));
    assert.equal(reset.code, SlateError.streamReset().code);
    assert.equal(reset.errno, "ECONNRESET");
    assert.equal(reset.connectCode, "Internal");
    // A provider that is out of capacity is deferred for as long as it asked, when it said.
    const paced = classifyAgentError({ retryable: true, displayInfo: { connectCode: "Unavailable" }, metadata: new Map([["retry-after", "2"]]) });
    assert.equal(paced.code, SlateError.backendCapacityDeferred().code);
    assert.equal(paced.retryAfterMs, 2_000);
    assert.equal(classifyAgentError({ retryable: true, displayInfo: { connectCode: "Unavailable" } }).code, SlateError.providerOverloaded().code);
    // Something the backend refused without saying it was worth retrying.
    assert.equal(classifyAgentError(connectWithDetails({ title: "Nope" })).code, SlateError.backendRejected().code);
    // A failure that says it is terminal is not retried, even though it looks transient.
    assert.equal(classifyAgentError({ code: "ECONNRESET", terminal: true }).code, SlateError.agentUnclassified().code);
    assert.equal(classifyAgentError(new Error("boom")).code, SlateError.agentUnclassified().code);
    // The backend's own code is only read when there is one.
    assert.equal(connectCodeOf(connectFailure(2)), "Unknown");
    assert.equal(connectCodeOf(new Error("plain")), undefined);
  });

  it("keeps the timings of a turn that had to wait", () => {
    const recorded: Array<{ context: unknown; attributes: Record<string, unknown> }> = [];
    setTurnCompletedSpanRecorder((context, options) => {
      recorded.push({ context, attributes: { ...options.attributes } });
    });
    try {
      const context = { withName: (name: string) => ({ name }) };
      recordTurnQueueWaitSpan({ traceCtx: context, queueStartEpochMs: 1_000, queueStartPerfMs: performance.now() - 5, conversationId: "agent-1", clientNonce: "n1" });
      assert.equal(recorded.length, 1);
      assert.deepEqual(recorded[0]?.context, { name: "turn-queue-wait" });
      assert.deepEqual([recorded[0]?.attributes["slate.conversation_id"], recorded[0]?.attributes["slate.client_nonce"], typeof recorded[0]?.attributes["slate.queue_wait_ms"]], ["agent-1", "n1", "number"]);
      // Nothing is recorded without a start, without a context, or without a recorder.
      recordTurnQueueWaitSpan({ traceCtx: context, conversationId: "agent-1" });
      recordTurnQueueWaitSpan({ traceCtx: null, queueStartEpochMs: 1_000, queueStartPerfMs: 1, conversationId: "agent-1" });
      recordTurnQueueWaitSpan({ traceCtx: {}, queueStartEpochMs: 1_000, queueStartPerfMs: 1, conversationId: "agent-1" });
      assert.equal(recorded.length, 1);
      setTurnCompletedSpanRecorder(undefined);
      recordTurnQueueWaitSpan({ traceCtx: context, queueStartEpochMs: 1_000, queueStartPerfMs: 1, conversationId: "agent-1" });
      assert.equal(recorded.length, 1);
    } finally {
      setTurnCompletedSpanRecorder(undefined);
    }
  });

  it("reports about a tool call once, whatever the agent says about it", () => {
    const runtime = world().view;
    assert.equal(runtime.markReportedOnce({ reported: runtime.reportedToolCallErrors, sessionId: "agent-1", toolCallId: "t1" }), true);
    assert.equal(runtime.markReportedOnce({ reported: runtime.reportedToolCallErrors, sessionId: "agent-1", toolCallId: "t1" }), false);
    assert.equal(runtime.markReportedOnce({ reported: runtime.reportedToolCallErrors, sessionId: "agent-2", toolCallId: "t1" }), true);
    const diagnostics = world({ dbEntries: [] });
    diagnostics.tm.runLifecycle.lastRequestIdBySession.set("agent-1", "req-from-run");
    diagnostics.view.reportToolCallDiagnostic(diagnostics.session, { kind: "error", toolCallId: "t1", toolName: "Shell", connector: "slack", errorClass: "boom", durationMs: 12 });
    diagnostics.view.reportToolCallDiagnostic(diagnostics.session, { kind: "error", toolCallId: "t1", toolName: "Shell" });
    diagnostics.view.reportToolCallDiagnostic(diagnostics.session, { kind: "stalled", toolCallId: "t2", toolName: "Read", elapsedMs: 900 });
    const [error, stalled] = diagnostics.named("reportToolCallError").concat(diagnostics.named("reportToolCallStalled")).map((call) => call.args[0]);
    assert.deepEqual(error, { conversationId: "agent-1", requestId: "req-from-run", toolName: "Shell", toolCallId: "t1", connector: "slack", errorClass: "boom", durationMs: 12 });
    assert.equal(diagnostics.named("reportToolCallError").length, 1);
    assert.deepEqual(stalled, { conversationId: "agent-1", requestId: "req-from-run", toolName: "Read", toolCallId: "t2", connector: undefined, elapsedMs: 900 });
  });

  it("settles a card that was waiting on the agent, in the timeline and on the session", () => {
    const pending: TranscriptEntry = { id: "a1", kind: "send-message", message: { type: "auto-review-approval", approval: { requestId: "r1", status: "pending" } } };
    const world1 = world({ entries: [pending], dbEntries: [pending] });
    const matchesCard = (entry: TranscriptEntry) => (entry.message as { approval?: { requestId?: string } } | undefined)?.approval?.requestId === "r1";
    const applyStatus = (entry: TranscriptEntry): TranscriptEntry => ({ ...entry, message: { ...(entry.message as object), approval: { requestId: "r1", status: "expired" } } });
    world1.view.settleCardStatus({ isForActiveAgent: true, matchesCard, applyStatus });
    assert.equal((world1.stored("a1")?.message as { approval: { status: string } }).approval.status, "expired");
    assert.equal((world1.persisted("a1")?.message as { approval: { status: string } }).approval.status, "expired");
    assert.equal(world1.named("emit").length, 1);
    assert.equal(world1.named("emit")[0]?.args[1], "agent-1");
    assert.equal((world1.named("emit")[0]?.args[0] as { entry: TranscriptEntry }).entry, world1.stored("a1"));
    // A card on a conversation that is not the one on screen is settled on the session only, and what is announced is
    // that session's entry rather than a look-alike in the timeline.
    const side = world({ entries: [pending], dbEntries: [pending], session: sessionOf("agent-2") });
    side.view.settleCardStatus({ isForActiveAgent: false, matchesCard, applyStatus });
    assert.equal(side.named("emit").length, 1);
    assert.equal((side.named("emit")[0]?.args[0] as { entry: TranscriptEntry }).entry, side.persisted("a1"));
    assert.equal((side.persisted("a1")?.message as { approval: { status: string } }).approval.status, "expired");
    // Nothing to settle, nothing to announce.
    const quiet = world({ entries: [], dbEntries: [] });
    quiet.view.settleCardStatus({ isForActiveAgent: true, matchesCard, applyStatus });
    assert.equal(quiet.named("emit").length, 0);
  });

  it("resolves a reply only against what is still there", () => {
    const runtime = world().view;
    const entries: TranscriptEntry[] = [
      { id: "m1", kind: "message", role: "assistant", content: "  the   earlier answer \n " },
      { id: "s1", kind: "send-message", message: { type: "text", content: "from the agent" } },
    ];
    assert.equal(runtime.resolveReplyTarget(entries, "m1"), "m1");
    assert.equal(runtime.resolveReplyTarget(entries, "gone"), undefined);
    assert.deepEqual(runtime.buildReplyContext(entries, "m1"), { targetId: "m1", quote: "the earlier answer" });
    assert.deepEqual(runtime.buildReplyContext(entries, "s1"), { targetId: "s1", quote: "from the agent" });
    assert.equal(runtime.buildReplyContext(entries, undefined), undefined);
    assert.equal(runtime.buildReplyContext(entries, "gone"), undefined);
  });
});

describe("what a turn is nudged into saying", () => {
  it("asks again until the user has heard something, and no more than three times", async () => {
    const world1 = world({ turns: [silent, delivered] });
    const settled = await world1.view.ensureUserReply(world1.runner, silent, world1.session, 1, "ack-1", undefined, undefined, world1.turn);
    assert.equal(settled.result.sentMessageCount, 1);
    assert.equal(settled.replyNudgeAttempts, 2);
    assert.equal(settled.deliveryOwed, false);
    const nudges = world1.named("run");
    assert.equal(nudges.length, 2);
    assert.deepEqual(nudges.map((call) => call.args[0]), [REPLY_NUDGE_PROMPT, REPLY_NUDGE_PROMPT]);
    assert.deepEqual(nudges[0]?.args[1], { hidden: true, ackToken: "ack-1", traceCtx: undefined, onModelResolved: (nudges[0]?.args[1] as { onModelResolved: unknown }).onModelResolved });
    assert.equal(world1.named("setModel").length, 0);
    // A turn that stays silent is only nudged three times, and the fact that nothing was delivered is kept.
    const stuck = world({ turns: [silent, silent, silent, silent, silent] });
    const gaveUp = await stuck.view.ensureUserReply(stuck.runner, silent, stuck.session, 1, undefined, undefined, undefined);
    assert.equal(gaveUp.replyNudgeAttempts, MAX_REPLY_NUDGES);
    assert.equal(gaveUp.deliveryOwed, true);
    assert.equal(stuck.named("run").length, MAX_REPLY_NUDGES);
    // An aborted nudge ends the asking rather than being asked again.
    const aborted = world({ turns: [silent, { sentMessageCount: 0, reacted: false, aborted: true }, delivered] });
    const stopped = await aborted.view.ensureUserReply(aborted.runner, silent, aborted.session, 1, undefined, undefined, undefined);
    assert.equal(stopped.replyNudgeAttempts, 2);
    assert.equal(stopped.result.aborted, true);
    assert.equal(aborted.named("run").length, 2);
    // A turn that is no longer the current one is not nudged at all.
    const stale = world({ turns: [silent, delivered], currentEpoch: 2 });
    const none = await stale.view.ensureUserReply(stale.runner, silent, stale.session, 1, undefined, undefined, undefined);
    assert.equal(none.replyNudgeAttempts, 0);
    assert.equal(stale.named("run").length, 0);
  });

  it("says what the closing-send nudge was worth, and sends it only when the turn went quiet on tool calls", async () => {
    const quietToolCalls: TurnResult = { sentMessageCount: 0, reacted: false, aborted: false, endedOnSilentToolCalls: true };
    const closing = world({ turns: [quietToolCalls, quietToolCalls, quietToolCalls, delivered] });
    const sunk = await closing.view.ensureUserReply(closing.runner, quietToolCalls, closing.session, 1, undefined, undefined, undefined);
    assert.equal(sunk.result.sentMessageCount, 1);
    assert.deepEqual(closing.named("run")[MAX_REPLY_NUDGES]?.args[0], CLOSING_SEND_NUDGE_PROMPT);
    assert.deepEqual(closing.named("reportClosingSendNudge")[0]?.args, [{ conversationId: "agent-1", delivered: true, sentMessageCount: 1, aborted: false }]);
    // A user who is choosing something is not nudged, and neither is an aborted turn.
    const choosing = world({ turns: [] });
    await choosing.view.ensureUserReply(choosing.runner, { sentMessageCount: 1, reacted: false, aborted: false, endedOnSilentToolCalls: true, awaitingUserSelection: true }, choosing.session, 1, undefined, undefined, undefined);
    assert.equal(choosing.named("reportClosingSendNudge").length, 0);
    assert.equal(choosing.named("run").length, 0);
    const abortedRun: TurnResult = { sentMessageCount: 0, reacted: false, aborted: true, endedOnSilentToolCalls: true };
    const abortedTurn = world({ turns: [abortedRun, abortedRun, abortedRun] });
    await abortedTurn.view.ensureUserReply(abortedTurn.runner, abortedRun, abortedTurn.session, 1, undefined, undefined, undefined);
    assert.equal(abortedTurn.named("reportClosingSendNudge").length, 0);
    assert.equal(abortedTurn.named("run").length, 1);
    // A closing nudge that also delivered nothing is reported as such.
    const stillNothing = world({ turns: [quietToolCalls, quietToolCalls, quietToolCalls] });
    await stillNothing.view.ensureUserReply(stillNothing.runner, quietToolCalls, stillNothing.session, 1, undefined, undefined, undefined);
    assert.deepEqual(stillNothing.named("reportClosingSendNudge")[0]?.args, [{ conversationId: "agent-1", delivered: false, sentMessageCount: 0, aborted: false }]);
  });
});

describe("running a turn", () => {
  const turnOptions = (overrides: Record<string, unknown> = {}) => ({ selectedImages: [], isLoading: true, ...overrides });

  it("runs the agent with the context it needs, then says the turn is over", async () => {
    let held: { prompt?: string | undefined; source?: string | undefined; hasTurn?: boolean | undefined; epoch?: number | undefined; lastRequestId?: string | undefined } = {};
    const world1 = world({
      turns: [delivered],
      questions: { skippedQuestionPrompts: ["q1"], dismissedQuestionPrompts: [] },
      duringRun: (runtime) => {
        runtime.view?.handleAgentUpdate({ type: "request-id", requestId: "req-live", source: "turn" });
        held = {
          prompt: runtime.view?.activeRequestPrompts.get("agent-1"),
          source: runtime.view?.activeRequestSources.get("agent-1"),
          hasTurn: runtime.view?.activeTurns.has("agent-1"),
          epoch: runtime.view?.activeTurnEpochs.get("agent-1"),
          lastRequestId: runtime.view?.tm.runLifecycle.lastRequestIdBySession.get("agent-1"),
        };
      },
    });
    await world1.view.runTurn(world1.session, world1.runner, "  hello  ", turnOptions({ messageId: "t0u", clientNonce: "n1" }) as never, 1);
    assert.deepEqual(world1.named("collectUnansweredQuestionPrompts").length, 1);
    const [prompt, runOptions] = world1.named("run")[0]?.args as [string, Record<string, unknown>];
    assert.equal(prompt, "  hello  ");
    assert.equal(runOptions.skippedQuestionPrompts?.toString(), ["q1"].toString());
    assert.equal(runOptions.appendReplyReminder, true);
    assert.equal(runOptions.requestSource, "turn");
    assert.equal(runOptions.traceCtx, undefined);
    assert.equal(typeof runOptions.onModelResolved, "function");
    (runOptions.onModelResolved as (id: string) => void)("model-9");
    assert.deepEqual(world1.named("setModel")[0]?.args, ["model-9"]);
    // The turn is reported as started under the new-turn kind, finalised as a success, and both the roster and the
    // automations are told; the request the turn was asked under is remembered while it runs.
    assert.deepEqual(world1.named("startTurn")[0]?.args, [{ conversationId: "agent-1", turnType: "new" }]);
    assert.deepEqual(held, { prompt: "hello", source: "turn", hasTurn: true, epoch: 1, lastRequestId: "req-live" });
    // The request the agent reports while the turn runs is put on the turn itself, and dropped when it ends.
    assert.deepEqual(world1.named("setRequestId")[0]?.args, ["req-live"]);
    assert.deepEqual(world1.named("finalize")[0]?.args[0], "success");
    assert.deepEqual(world1.named("emitAgentUpdate").map((call) => call.args[0]), ["agent-1"]);
    assert.equal(world1.named("emitAutomations").length, 1);
    assert.equal(world1.tm.runLifecycle.lastRequestIdBySession.has("agent-1"), false);
    assert.equal(world1.view.activeTurns.has("agent-1"), false);
    assert.equal(world1.view.activeRequestPrompts.has("agent-1"), false);
  });

  it("says what a silently finished turn cost, with what was tried against it", async () => {
    const world1 = world({ turns: [silent, silent, silent, silent], ackOutstanding: true });
    await world1.view.runTurn(world1.session, world1.runner, "hello", turnOptions({ messageId: "t0u" }) as never, 1);
    const report = world1.named("reportTurnEmptyDelivery")[0]?.args[0] as Record<string, unknown>;
    assert.deepEqual([report.conversationId, report.source, report.requestSource, report.replyNudgeAttempts, report.toolCallCount], ["agent-1", "turn", "turn", MAX_REPLY_NUDGES, 7]);
    assert.equal(report.ackOutstanding, true);
    assert.equal(report.streamOutputProduced, false);
    assert.equal(typeof report.durationMs, "number");
    // A turn that delivered is not reported as empty, and neither is one that was aborted.
    const spoke = world({ turns: [delivered] });
    await spoke.view.runTurn(spoke.session, spoke.runner, "hello", turnOptions() as never, 1);
    assert.equal(spoke.named("reportTurnEmptyDelivery").length, 0);
    const aborted = world({ turns: [{ sentMessageCount: 0, reacted: false, aborted: true }] });
    await aborted.view.runTurn(aborted.session, aborted.runner, "hello", turnOptions() as never, 1);
    assert.equal(aborted.named("reportTurnEmptyDelivery").length, 0);
    assert.equal(aborted.named("finalize")[0]?.args[0], "cancelled");
  });

  it("hands a turn that was already superseded back to the queue instead of running it", async () => {
    const world1 = world({
      currentEpoch: 2,
      wouldRecover: true,
      recovery: { epoch: 2, messageId: "t9u", recentUserMessages: [{ id: "t9u", text: "hello" }] },
    });
    await world1.view.runTurn(world1.session, world1.runner, "hello", turnOptions({ messageId: "t0u", recentUserMessages: [{ id: "t0u", text: "hello" }], ackToken: "ack-1" }) as never, 3);
    assert.equal(world1.named("run").length, 0);
    assert.deepEqual(world1.named("wouldRecoverViaPrepend")[0]?.args, [[{ id: "t9u", text: "hello" }], "t9u", "t0u"]);
    assert.deepEqual(world1.named("startTurn")[0]?.args, [{ conversationId: "agent-1", turnType: "new" }]);
    assert.deepEqual(world1.named("finalize")[0]?.args[0], "cancelled");
    assert.deepEqual(world1.named("retireAckRunToken").map((call) => call.args), [["agent-1", "ack-1"]]);
    assert.equal(world1.named("endSessionRun").length, 1);
    // Anything the queue cannot prepend is run instead: an attachment, a fork, or a reply.
    for (const overrides of [{ selectedImages: [{ path: "a.png" }] }, { isFork: true }, { replyContext: { targetId: "m1" } }, { messageId: "t1u" }]) {
      const blocked = world({ currentEpoch: 2, wouldRecover: true, recovery: { epoch: 2, messageId: "t9u", recentUserMessages: [{ id: "t9u", text: "hello" }] } });
      await blocked.view.runTurn(blocked.session, blocked.runner, "hello", turnOptions({ messageId: "t0u", recentUserMessages: [{ id: "t0u", text: "hello" }], ...overrides }) as never, 3);
      assert.equal(blocked.named("run").length, 1);
    }
    // A runner that cannot recover, a message that was already broken, or an epoch that is not newer all run.
    const cannot = world({ currentEpoch: 2, recovery: { epoch: 2, messageId: "t9u", recentUserMessages: [] } });
    await cannot.view.runTurn(cannot.session, cannot.runner, "hello", turnOptions({ messageId: "t0u", recentUserMessages: [{ id: "t0u", text: "hello" }] }) as never, 3);
    assert.equal(cannot.named("run").length, 1);
    const broken = world({ currentEpoch: 2, wouldRecover: true, recoveryBreakEpoch: 5, recovery: { epoch: 2, messageId: "t9u", recentUserMessages: [] } });
    await broken.view.runTurn(broken.session, broken.runner, "hello", turnOptions({ messageId: "t0u", recentUserMessages: [{ id: "t0u", text: "hello" }] }) as never, 3);
    assert.equal(broken.named("run").length, 1);
    const noPrepend = world({ currentEpoch: 2, withoutPrepend: true, recovery: { epoch: 2, messageId: "t9u", recentUserMessages: [] } });
    await noPrepend.view.runTurn(noPrepend.session, noPrepend.runner, "hello", turnOptions({ messageId: "t0u", recentUserMessages: [{ id: "t0u", text: "hello" }] }) as never, 3);
    assert.equal(noPrepend.named("run").length, 1);
  });

  it("says a turn failed, and what the agent's error looked like", async () => {
    const world1 = world({ dbEntries: [], runError: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    await world1.view.runTurn(world1.session, world1.runner, "hello", turnOptions() as never, 1);
    const finalize = world1.named("finalize")[0]?.args ?? [];
    assert.equal(finalize[0], "error");
    assert.equal((finalize[1] as { code: string }).code, SlateError.streamReset().code);
    assert.deepEqual(finalize[2], { message: "socket hang up", stack: (world1.named("finalize")[0]?.args[2] as { stack: string }).stack });
    const pushed = world1.named("pushError")[0]?.args[0] as Record<string, unknown>;
    // The error the agent ran into is shown as the platform's description of it, with the last request it made.
    assert.equal(pushed.title, "Agent failed to respond");
    assert.equal(pushed.detail, "socket hang up");
    assert.equal(pushed.requestId, "req-last");
    assert.equal(world1.named("emitAgentUpdate").length, 1);
    assert.equal(world1.named("traceFlusher").length, 1);
    assert.equal(world1.named("endSessionRun").length, 1);
  });

  it("does not treat a completed run as the current one when it is no longer asked for", async () => {
    const world1 = world({ turns: [silent, delivered], currentEpoch: 2 });
    await world1.view.runTurn(world1.session, world1.runner, "hello", turnOptions() as never, 1);
    assert.equal(world1.named("run").length, 1);
    assert.equal(world1.named("reportTurnEmptyDelivery").length, 0);
    assert.equal(world1.named("finalize")[0]?.args[0], "success");
  });
});

describe("what the agent's updates turn into", () => {
  const entries: TranscriptEntry[] = [{ id: "m1", kind: "message", role: "user", content: "hi" }, { id: "s0", kind: "send-message", message: { type: "text", content: "hello" } }];

  it("times a tool call, says when a dual-surface tool was used, and reports one that failed", () => {
    const world1 = world({ entries, dbEntries: entries });
    assert.equal(world1.view.handleAgentUpdate({ type: "tool-call", status: "pending", id: "t1", name: "Shell" }), undefined);
    assert.equal(world1.view.handleAgentUpdate({ type: "tool-call", status: "pending", id: "t1", name: "Shell" }), undefined);
    const started = world1.named("reportToolCallStarted");
    assert.equal(started.length, 1);
    assert.deepEqual(
      [started[0]?.args[0] && (started[0]?.args[0] as Record<string, unknown>).toolName, (started[0]?.args[0] as Record<string, unknown>).surface, (started[0]?.args[0] as Record<string, unknown>).toolCallId],
      ["Shell", "box", "t1"],
    );
    // A tool the platform does not track on both surfaces is not announced as one.
    world1.view.handleAgentUpdate({ type: "tool-call", status: "pending", id: "t2", name: "Edit" });
    assert.equal(world1.named("reportToolCallStarted").length, 1);
    // The failure carries how long the call was pending, when it was seen to start.
    world1.view.handleAgentUpdate({ type: "tool-call", status: "failed", id: "t1", name: "Shell" });
    const error = world1.named("reportToolCallError")[0]?.args[0] as Record<string, unknown>;
    assert.equal(error.errorClass, TASK_ERROR_RESULT_CLASS);
    assert.equal(error.connector, "unknown");
    assert.equal(typeof error.durationMs, "number");
    world1.view.handleAgentUpdate({ type: "tool-call", status: "failed", id: "t2", name: "Edit" });
    assert.equal(world1.named("reportToolCallError").length, 2);
    assert.equal(typeof (world1.named("reportToolCallError")[1]?.args[0] as Record<string, unknown>).durationMs, "number");
    world1.view.handleAgentUpdate({ type: "tool-call", status: "failed", id: "t3", name: "Edit" });
    assert.equal((world1.named("reportToolCallError")[2]?.args[0] as Record<string, unknown>).durationMs, undefined);
  });

  it("remembers the request the turn is running under and what a finished turn used", () => {
    const world1 = world({ entries, dbEntries: entries });
    assert.equal(world1.view.handleAgentUpdate({ type: "request-id", requestId: "req-7", source: "turn" }), undefined);
    assert.equal(world1.named("setRequestId").length, 0);
    assert.equal(world1.tm.runLifecycle.lastRequestIdBySession.get("agent-1"), "req-7");
    assert.deepEqual(world1.named("trackTurnRequestId")[0]?.args, ["agent-1", "req-7"]);
    assert.deepEqual(world1.named("recordRequestId")[0]?.args, ["req-7", "turn"]);
    world1.view.handleAgentUpdate({ type: "turn-ended", usage: { tokens: 5 } });
    assert.deepEqual(world1.named("reportTurnUsage")[0]?.args, [{ tokens: 5 }]);
  });

  it("appends what the agent sent, fulfilling the acknowledgement it owed", () => {
    const world1 = world({ entries, dbEntries: entries });
    const id = world1.view.handleAgentUpdate({ type: "send-message", message: { type: "text", content: "the answer" }, timestampMs: 1_700, ackToken: "ack-1" });
    assert.equal(id, "t0s1");
    const appended = world1.named("appendSendMessageEntry")[0]?.args[0] as TranscriptEntry;
    assert.equal(appended.id, "t0s1");
    assert.equal((appended.message as { content: string }).content, "the answer");
    assert.equal(appended.timestampMs, 1_700);
    assert.deepEqual(world1.named("validateAiReplyTarget")[0]?.args.slice(0, 2), ["t0s1", 2]);
    assert.deepEqual(world1.named("fulfillAckObligation")[0]?.args, ["agent-1", "ack-1"]);
    assert.deepEqual(world1.named("emitAgentUpdate")[0]?.args, ["agent-1"]);
    // An attachment claims the batch its send belongs to, and a forked turn marks its entry as branched.
    world1.view.forkTurnSessions.add(world1.session);
    world1.view.handleAgentUpdate({ type: "send-message", message: { type: "attachment", url: "file:///tmp/a.png" }, timestampMs: 2_000 });
    const forked = world1.named("appendSendMessageEntry")[1]?.args[0] as TranscriptEntry;
    assert.equal(forked.batchId, "batch-1");
    assert.equal(forked.branched, true);
    assert.deepEqual(world1.named("claimSendAttachmentBatchId")[0]?.args, ["agent-1"]);
    // A box handoff stamps the entry it belongs to.
    world1.view.handleAgentUpdate({ type: "send-message", message: { type: "text", content: "box" }, timestampMs: 3_000, boxHandoff: { requestId: "req-b", instruction: "do it" } });
    const stamped = world1.named("appendSendMessageEntry")[2]?.args[0] as TranscriptEntry;
    assert.equal(stamped.boxRequestId, "req-b");
    assert.equal(stamped.boxInstruction, "do it");
  });

  it("keeps a conversation that is not on screen on its own entries, and wakes what a channel send means", () => {
    const world1 = world({ entries: [], dbEntries: [], session: sessionOf("agent-2") });
    (world1.tm.sessions as { activeSession: unknown }).activeSession = undefined;
    const id = world1.view.handleAgentUpdate({ type: "send-message", message: { type: "text", content: "off screen" }, timestampMs: 1 });
    assert.equal(id, "tbs0");
    assert.equal(world1.named("appendSendMessageEntry").length, 0);
    assert.equal((world1.dbEntries[0] as TranscriptEntry).id, "tbs0");
    assert.equal(world1.named("markSessionActivity").length, 1);
    assert.deepEqual(world1.named("fulfillAckObligation")[0]?.args, ["agent-2", undefined]);
    // A send into a channel goes to the wake that is listening on it; a listener or connector card is passed on.
    world1.view.handleAgentUpdate({ type: "send-message", message: { type: "text", content: "hi", channel: "listener-1" }, timestampMs: 2 });
    assert.deepEqual(world1.named("deliverToChannel")[0]?.args, ["listener-1"]);
    world1.view.handleAgentUpdate({ type: "send-message", message: { type: "listener-connect", platform: "slack" }, timestampMs: 3 });
    assert.deepEqual(world1.named("onListenerConnectCard")[0]?.args, [{ agentId: "agent-2", platform: "slack" }]);
    world1.view.handleAgentUpdate({ type: "send-message", message: { type: "connector", variant: "connect", connector: "slack", serverId: "srv-1" }, timestampMs: 4 });
    assert.deepEqual(world1.named("onConnectorConnectCard")[0]?.args, [{ agentId: "agent-2", connector: "slack", serverId: "srv-1" }]);
    // A conversation the platform no longer has anything to say to is left alone.
    const orphan = world({ entries: [], dbEntries: [] });
    (orphan.tm.sessions as { activeSession: unknown }).activeSession = undefined;
    (orphan.tm.runLifecycle as { activeRunSession: unknown }).activeRunSession = undefined;
    orphan.view.handleAgentUpdate({ type: "send-message", message: { type: "listener-connect", platform: "slack" }, timestampMs: 1 });
    assert.equal(orphan.named("onListenerConnectCard").length, 0);
  });

  it("settles the cards the agent says are done, and applies a reaction the agent makes", () => {
    const card: TranscriptEntry = { id: "a1", kind: "send-message", message: { type: "auto-review-approval", approval: { requestId: "r1", status: "pending" } } };
    const ask: TranscriptEntry = { id: "p1", kind: "send-message", message: { type: "local-tool-permission", ask: { requestId: "r2", status: "pending" } } };
    const world1 = world({ entries: [card, ask], dbEntries: [card, ask] });
    world1.view.handleAgentUpdate({ type: "auto-review-status", requestId: "r1", status: "approved" });
    assert.equal((world1.stored("a1")?.message as { approval: { status: string } }).approval.status, "approved");
    world1.view.handleAgentUpdate({ type: "local-tool-permission-status", requestId: "r2", status: "denied" });
    assert.equal((world1.stored("p1")?.message as { ask: { status: string } }).ask.status, "denied");
    assert.equal(world1.named("emit").length, 2);
    // A reaction has to name a message the platform can address, and one the user actually sent.
    const addressable: TranscriptEntry[] = [{ id: "t0u", kind: "message", role: "user", content: "hi" }, { id: "t0s1", kind: "send-message", message: { type: "text", content: "hello" } }];
    const reaction = world({ entries: addressable, dbEntries: addressable });
    assert.equal(reaction.view.handleAgentUpdate({ type: "react-to-message", messageAddress: "t0u", emoji: " 👍 " }), "t0u");
    assert.deepEqual(reaction.named("applyReaction")[0]?.args, [{ session: reaction.session, entryId: "t0u", emoji: "👍", by: "agent-1" }]);
    assert.equal(reaction.view.handleAgentUpdate({ type: "react-to-message", messageAddress: "t0s1", emoji: "👍" }), undefined);
    assert.equal(reaction.view.handleAgentUpdate({ type: "react-to-message", messageAddress: "t9u", emoji: "👍" }), undefined);
    assert.equal(reaction.view.handleAgentUpdate({ type: "react-to-message", messageAddress: "m1", emoji: "👍" }), undefined);
    assert.equal(reaction.view.handleAgentUpdate({ type: "react-to-message", messageAddress: "t0u", emoji: "  " }), undefined);
    // A reaction that could not be applied is not claimed.
    const refused = world({ entries: addressable, dbEntries: addressable, reactionApplied: null });
    assert.equal(refused.view.handleAgentUpdate({ type: "react-to-message", messageAddress: "t0u", emoji: "👍" }), undefined);
    // An update nobody understands is ignored, and the outline is only updated for the conversation on screen.
    const unknown = world({ entries, dbEntries: entries });
    assert.equal(unknown.view.handleAgentUpdate({ type: "something-else" }), undefined);
    assert.equal(unknown.named("emit").length, 0);
  });

  it("publishes a client-side tool update, and lets the outline hear about updates to the active agent", () => {
    const world1 = world({ entries, dbEntries: entries });
    world1.view.handleAgentUpdate({ type: "client-side-tool-v2", update: { kind: "started" } });
    assert.deepEqual(world1.named("publishClientSideToolV2")[0]?.args, ["agent-1", { kind: "started" }]);
    assert.deepEqual(world1.named("emitClientSideToolV2")[0]?.args, [{ kind: "v2" }]);
    assert.equal(world1.named("applyAgentUpdateToOutline").length, 1);
    const side = world({ entries, dbEntries: entries, session: sessionOf("agent-2") });
    (side.tm.sessions as { activeSession: unknown }).activeSession = sessionOf("agent-1");
    side.view.handleAgentUpdate({ type: "turn-ended", usage: {} });
    assert.equal(side.named("applyAgentUpdateToOutline").length, 0);
    assert.equal(side.named("trackActivity").length, 1);
  });

  it("needs a conversation open before a client-side tool update means anything", () => {
    const world1 = world({ entries, dbEntries: entries });
    (world1.tm.runLifecycle as { activeRunSession: unknown }).activeRunSession = undefined;
    (world1.tm.sessions as { activeSession: unknown }).activeSession = undefined;
    assert.equal(world1.view.handleAgentUpdate({ type: "client-side-tool-v2", update: { kind: "started" } }), undefined);
    assert.equal(world1.named("publishClientSideToolV2").length, 0);
    assert.equal(world1.named("emitClientSideToolV2").length, 0);
  });
});
