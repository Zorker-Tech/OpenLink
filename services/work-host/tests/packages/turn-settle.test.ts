/**
 * Settling a turn.
 *
 * What is pinned here is what a settled turn carries out: the collectors and the result they build, the token details a
 * checkpoint still has to keep, every path through checkpoint persistence (mirror on and off, a store that answers, is
 * missing or throws, a commit that fails, the root blob), the profile announcement held until the turn is durable, and
 * the completed-turn steps: timing, silent tool calls, post-turn labeling and the memory exchange.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTurnSettle, TranscriptAppendAfterCheckpointError } from "../../source/host/runner/turn-settle.ts";
import { turnEndedOnSilentToolCalls } from "../../source/host/runner/turn-shape.ts";
import { SLATE_SEND_MESSAGE_TOOL_NAME } from "../../source/host/runner/tools/send-message-tool.ts";

// ---------------------------------------------------------------------------------------------
// a recording settler host

interface HostOverrides {
  readonly isSubagentRunner?: boolean;
  readonly ownsRunner?: boolean;
  readonly isRunSuperseded?: boolean;
  readonly mirror?: boolean;
  readonly persistence?: boolean;
  readonly prepareThrows?: boolean;
  readonly abortThrows?: boolean;
  readonly commitThrows?: boolean;
  readonly skipThrows?: boolean;
  readonly rootBlobId?: string | null;
  readonly store?: "present" | "absent" | "throws";
  readonly promptMessages?: readonly unknown[];
  readonly labeling?: "absent" | "records" | "throws";
  readonly labelingMessages?: readonly unknown[];
}

const CONTEXT = { context: true };
const checkpoint = (summaryArchiveCount: number, tokenDetails?: Record<string, unknown>) => ({
  summaryArchives: Array.from({ length: summaryArchiveCount }, (_, index) => ({ archive: index })),
  ...(tokenDetails === undefined ? {} : { tokenDetails }),
  turnTimings: [] as Array<{ timestampMs: bigint; durationMs: bigint }>,
});

function makeHost(overrides: HostOverrides = {}): { calls: unknown[]; host: Record<string, unknown> } {
  const calls: unknown[] = [];
  const host: Record<string, unknown> = {
    isSubagentRunner: overrides.isSubagentRunner ?? false,
    get transcriptMirror() {
      calls.push("transcriptMirror");
      if (overrides.mirror === false) return undefined;
      return {
        async prepareCheckpoint(runContext: unknown, transcriptId: string, state: unknown, blobStore: unknown, isFinal: boolean, isForced: boolean) {
          calls.push(["prepareCheckpoint", runContext, transcriptId, state, blobStore, isFinal, isForced]);
          if (overrides.prepareThrows === true) throw new Error("prepare failed");
        },
        async abortCheckpoint(runContext: unknown, transcriptId: string) {
          calls.push(["abortCheckpoint", runContext, transcriptId]);
          if (overrides.abortThrows === true) throw new Error("abort failed");
        },
        async commitCheckpoint(runContext: unknown, transcriptId: string, ...rest: string[]) {
          calls.push(["commitCheckpoint", runContext, transcriptId, ...rest]);
          if (overrides.commitThrows === true) throw new Error("commit failed");
        },
        async skipCheckpoint(runContext: unknown, transcriptId: string, state: unknown, blobStore: unknown) {
          calls.push(["skipCheckpoint", runContext, transcriptId, state, blobStore]);
          if (overrides.skipThrows === true) throw new Error("skip failed");
        },
      };
    },
    getTranscriptId() {
      calls.push("getTranscriptId");
      return "transcript-1";
    },
    getBlobStore() {
      calls.push("getBlobStore");
      return { blobs: true };
    },
    agentStore() {
      calls.push("agentStore");
      if (overrides.store === "absent" || overrides.store === undefined) return null;
      return {
        async handleCheckpoint(runContext: unknown, state: unknown) {
          calls.push(["handleCheckpoint", runContext, state]);
          if (overrides.store === "throws") throw new Error("store failed");
        },
        getMetadata(key: string) {
          calls.push(["getMetadata", key]);
          return overrides.rootBlobId ?? undefined;
        },
      };
    },
    setLocalState(state: unknown) {
      calls.push(["setLocalState", state]);
    },
    ownsRunner() {
      calls.push("ownsRunner");
      return overrides.ownsRunner ?? true;
    },
    isRunSuperseded() {
      calls.push("isRunSuperseded");
      return overrides.isRunSuperseded ?? false;
    },
    latestPromptMessages() {
      calls.push("latestPromptMessages");
      return overrides.labelingMessages ?? overrides.promptMessages ?? [];
    },
    persistAnnouncedAgentProfile(allSnapshots: unknown, announced: unknown, profile: unknown) {
      calls.push(["persistAnnouncedAgentProfile", allSnapshots, announced, profile]);
    },
  };
  if (overrides.labeling !== "absent") {
    host.recordPostTurnLabeling = (input: unknown) => {
      calls.push(["recordPostTurnLabeling", input]);
      if (overrides.labeling === "throws") throw new Error("labeling failed");
    };
    host.reportDiagnostic = (input: unknown) => {
      calls.push(["reportDiagnostic", input]);
    };
  }
  return { calls, host };
}

const settleFor = (host: Record<string, unknown>, scope: Record<string, unknown> = {}) =>
  createTurnSettle(host as never, { conversationId: "conversation-1", profilePromptSnapshots: null, ...scope } as never);

const SESSION = { getModelId: () => "model-1", getExecutor: () => ({}) };
const completedTurn = (over: Record<string, unknown> = {}) => ({
  finalState: checkpoint(2),
  turnStartedAtMs: Date.now() - 1_000,
  hidden: false,
  trimmedPrompt: "a prompt the user wrote",
  session: SESSION,
  baseContext: { base: true },
  requestId: "request-1",
  ...over,
});

// ---------------------------------------------------------------------------------------------
// the error and the result
// ---------------------------------------------------------------------------------------------

test("a checkpoint without its transcript append says what happened and keeps the cause", () => {
  const cause = new Error("disk full");
  const error = new TranscriptAppendAfterCheckpointError(cause);
  assert.equal(error.name, "TranscriptAppendAfterCheckpointError");
  assert.equal(error.message, "conversation checkpoint persisted but transcript append failed: disk full");
  assert.equal(error.isTranscriptAppendAfterCheckpointError, true);
  assert.equal(error.cause, cause);
  assert.equal(new TranscriptAppendAfterCheckpointError("a string").message.endsWith(": a string"), true);
});

test("the collectors gather what the turn said and did", () => {
  const { host } = makeHost();
  const settle = settleFor(host);
  settle.collectors.collectText("hel");
  settle.collectors.collectText("");
  settle.collectors.collectText("lo");
  settle.collectors.collectSendMessage();
  settle.collectors.collectSendMessage();
  settle.collectors.collectReaction();

  const plain = settle.buildResult({ aborted: false });
  assert.deepEqual({ ...plain }, { text: "hello", sentMessageCount: 2, reacted: true, aborted: false });
  assert.deepEqual(Object.keys(plain), ["text", "sentMessageCount", "reacted", "aborted"]);

  const flagged = settle.buildResult({ aborted: true, quiescedForUpgrade: true, awaitingUserSelection: true, streamOutputProduced: true });
  assert.deepEqual(Object.keys(flagged), ["text", "sentMessageCount", "reacted", "aborted", "quiescedForUpgrade", "awaitingUserSelection", "streamOutputProduced"]);
  // A flag that is false is absent, not false.
  const unflagged = settle.buildResult({ aborted: false, quiescedForUpgrade: false, awaitingUserSelection: false, streamOutputProduced: false });
  assert.deepEqual(Object.keys(unflagged), ["text", "sentMessageCount", "reacted", "aborted"]);
});

// ---------------------------------------------------------------------------------------------
// the token details a checkpoint keeps

test("a checkpoint that arrives with more archives than were written keeps its token details once", () => {
  const { host } = makeHost();
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(2) as never);

  const fewer = checkpoint(1, { usedTokens: 1, maxTokens: 2 });
  settle.prepareCheckpointForPersistence(fewer as never);
  assert.deepEqual(fewer.tokenDetails, { usedTokens: 1, maxTokens: 2 });

  const more = checkpoint(3, { usedTokens: 10, maxTokens: 20 });
  settle.prepareCheckpointForPersistence(more as never);
  assert.equal(more.tokenDetails, undefined);

  // The same counts again are stale, so they stay off.
  const sameAgain = checkpoint(3, { usedTokens: 10, maxTokens: 20 });
  settle.prepareCheckpointForPersistence(sameAgain as never);
  assert.equal(sameAgain.tokenDetails, undefined);

  // New counts make the checkpoint fresh, so they are written.
  const changed = checkpoint(3, { usedTokens: 11, maxTokens: 20 });
  settle.prepareCheckpointForPersistence(changed as never);
  assert.deepEqual(changed.tokenDetails, { usedTokens: 11, maxTokens: 20 });
});

test("a checkpoint can arrive with only one of the token counts", () => {
  const { host } = makeHost();
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never);
  const partial = checkpoint(1, { usedTokens: 5 });
  settle.prepareCheckpointForPersistence(partial as never);
  assert.equal(partial.tokenDetails, undefined);
  const complete = checkpoint(1, { usedTokens: 5, maxTokens: 6 });
  settle.prepareCheckpointForPersistence(complete as never);
  assert.deepEqual(complete.tokenDetails, { usedTokens: 5, maxTokens: 6 });

  // A checkpoint whose written detail had no used-token count stays stale when the count is still absent.
  const onlyMax = checkpoint(3, { maxTokens: 6 });
  settle.prepareCheckpointForPersistence(onlyMax as never);
  assert.equal(onlyMax.tokenDetails, undefined);
  const onlyMaxAgain = checkpoint(3, { maxTokens: 6 });
  settle.prepareCheckpointForPersistence(onlyMaxAgain as never);
  assert.equal(onlyMaxAgain.tokenDetails, undefined);
});

// ---------------------------------------------------------------------------------------------
// checkpoint persistence

test("a step checkpoint is prepared, handed to the store and committed", async () => {
  const { calls, host } = makeHost({ store: "present", rootBlobId: "root-1" });
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never);
  await settle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never);

  // The mirror is read once, then prepared with the transcript, the checkpoint, the blob store and the flags.
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["transcriptMirror", "getTranscriptId", "getBlobStore", "agentStore", "getTranscriptId", "ownsRunner"]);
  assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === "prepareCheckpoint"), ["prepareCheckpoint", CONTEXT, "transcript-1", checkpoint(1), { blobs: true }, false, false]);
  assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === "handleCheckpoint"), ["handleCheckpoint", CONTEXT, checkpoint(1)]);
  assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === "getMetadata"), ["getMetadata", "latestRootBlobId"]);
  assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === "commitCheckpoint"), ["commitCheckpoint", CONTEXT, "transcript-1", "root-1"]);
});

test("a commit without a root blob passes no tap", async () => {
  const { calls, host } = makeHost({ store: "present" });
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never);
  await settle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never);
  const commit = calls.find((call) => Array.isArray(call) && call[0] === "commitCheckpoint");
  assert.deepEqual(commit, ["commitCheckpoint", CONTEXT, "transcript-1"]);
});

test("a subagent's step checkpoint is forced", async () => {
  const { calls, host } = makeHost({ isSubagentRunner: true });
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never);
  await settle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never);
  assert.equal((calls.find((call) => Array.isArray(call) && call[0] === "prepareCheckpoint") as unknown[]).at(-1), true);
});

test("a checkpoint written without a store is kept locally", async () => {
  const { calls, host } = makeHost({ store: "absent" });
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never);
  await settle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "setLocalState"), true);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "handleCheckpoint"), false);
});

test("a store that throws is aborted and the failure is rethrown", async () => {
  const { calls, host } = makeHost({ store: "throws" });
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never);
  await assert.rejects(() => settle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never), (error: unknown) => (error as Error).message === "store failed");
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "abortCheckpoint"), [["abortCheckpoint", CONTEXT, "transcript-1"]]);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "setLocalState"), false);
});

test("a commit that fails becomes a transcript-append failure after the store has kept the checkpoint", async () => {
  const { calls, host } = makeHost({ store: "present", commitThrows: true });
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never);
  await assert.rejects(
    () => settle.persistFinalState(CONTEXT, checkpoint(1) as never),
    (error: unknown) => {
      assert.equal(error instanceof TranscriptAppendAfterCheckpointError, true);
      assert.equal((error as Error).message, "conversation checkpoint persisted but transcript append failed: commit failed");
      return true;
    },
  );
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "handleCheckpoint"), true);
});

test("without a mirror only the conversation's own store is written", async () => {
  const { calls, host } = makeHost({ mirror: false, store: "present" });
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never);
  await settle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never);
  assert.equal(calls.filter((call) => call === "transcriptMirror").length, 1);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "prepareCheckpoint"), false);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "skipCheckpoint"), false);
});

test("a turn with transcript persistence switched off does not prepare or commit, but still skips", async () => {
  const { calls, host } = makeHost({ store: "present" });
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never, false);
  await settle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "prepareCheckpoint"), false);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "commitCheckpoint"), false);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "skipCheckpoint"), [
    ["skipCheckpoint", CONTEXT, "transcript-1", checkpoint(1), { blobs: true }],
  ]);
});

test("a final state that arrives with more archives has its token details taken off before it is written", async () => {
  const { calls, host } = makeHost({ store: "present" });
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never);
  const finalState = checkpoint(2, { usedTokens: 1, maxTokens: 2 });
  await settle.persistFinalState(CONTEXT, finalState as never);
  assert.equal(finalState.tokenDetails, undefined);
  const handled = calls.find((call) => Array.isArray(call) && call[0] === "handleCheckpoint") as unknown[];
  assert.equal((handled[2] as { tokenDetails?: unknown }).tokenDetails, undefined);
});

test("a prepare that fails leaves the store untouched", async () => {
  const { calls, host } = makeHost({ store: "present", prepareThrows: true });
  const settle = settleFor(host);
  settle.noteBaseState(checkpoint(0) as never);
  await assert.rejects(() => settle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never), /prepare failed/);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "handleCheckpoint"), false);
});

// ---------------------------------------------------------------------------------------------
// the profile announcement

test("a profile announcement waits for a snapshot, an identity and a durable turn", async () => {
  const { calls, host } = makeHost();
  const settle = settleFor(host, { profilePromptSnapshots: { all: true } });
  const snapshot = { prompt: "snapshot" };
  const identity = { name: "Name", description: "Description" };
  settle.noteBaseState(checkpoint(0) as never);

  await settle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never);
  settle.setProfileSnapshot(snapshot as never);
  await settle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never);
  settle.noteProfileUpdateAppended(identity as never);
  // Not the owner: the step checkpoint keeps the announcement pending.
  const notOwned = makeHost({ ownsRunner: false });
  const notOwnedSettle = settleFor(notOwned.host, { profilePromptSnapshots: { all: true } });
  notOwnedSettle.noteBaseState(checkpoint(0) as never);
  notOwnedSettle.setProfileSnapshot(snapshot as never);
  notOwnedSettle.noteProfileUpdateAppended(identity as never);
  await notOwnedSettle.persistStepCheckpoint(CONTEXT, checkpoint(1) as never);
  assert.equal(notOwned.calls.some((call) => Array.isArray(call) && call[0] === "persistAnnouncedAgentProfile"), false);

  // An identity with no snapshot has nothing to announce yet.
  const early = makeHost();
  const earlySettle = settleFor(early.host, { profilePromptSnapshots: { all: true } });
  earlySettle.noteBaseState(checkpoint(0) as never);
  earlySettle.noteProfileUpdateAppended(identity as never);
  await earlySettle.persistFinalState(CONTEXT, checkpoint(1) as never);
  assert.equal(early.calls.some((call) => Array.isArray(call) && call[0] === "persistAnnouncedAgentProfile"), false);
  earlySettle.setProfileSnapshot(snapshot as never);
  await earlySettle.persistFinalState(CONTEXT, checkpoint(2) as never);
  assert.equal(early.calls.filter((call) => Array.isArray(call) && call[0] === "persistAnnouncedAgentProfile").length, 1);

  // The owner's announcement is made once the final state is written, and only once.
  await settle.persistFinalState(CONTEXT, checkpoint(2) as never);
  await settle.persistFinalState(CONTEXT, checkpoint(2) as never);
  const announcements = calls.filter((call) => Array.isArray(call) && call[0] === "persistAnnouncedAgentProfile");
  assert.deepEqual(announcements, [["persistAnnouncedAgentProfile", { all: true }, snapshot, identity]]);
});

// ---------------------------------------------------------------------------------------------
// settling a completed turn

test("settling a turn appends one timing for it", async () => {
  const { host } = makeHost();
  const settle = settleFor(host);
  const args = completedTurn();
  const startedAt = Date.now() - 3_600_000;
  args.turnStartedAtMs = startedAt;
  await settle.settleCompletedTurn(args as never);
  assert.equal(args.finalState.turnTimings.length, 1);
  const timing = args.finalState.turnTimings[0]!;
  assert.equal(typeof timing.timestampMs, "bigint");
  assert.equal(Number(timing.timestampMs) > startedAt, true);
  assert.equal(Math.abs(Number(timing.timestampMs) - Date.now()) < 60_000, true);
  assert.equal(Number(timing.durationMs) >= 3_500_000, true);
});

test("a turn that started in the future has no negative duration", async () => {
  const { host } = makeHost();
  const settle = settleFor(host);
  const args = completedTurn({ turnStartedAtMs: Date.now() + 60_000 });
  await settle.settleCompletedTurn(args as never);
  assert.equal(Number(args.finalState.turnTimings[0]!.durationMs), 0);
});

test("a hidden or subagent turn is not read back for its ending", async () => {
  const hidden = makeHost({ promptMessages: [] });
  await settleFor(hidden.host).settleCompletedTurn(completedTurn({ hidden: true }) as never);
  assert.equal(hidden.calls.filter((call) => call === "latestPromptMessages").length, 0);

  const subagent = makeHost({ isSubagentRunner: true, promptMessages: [] });
  await settleFor(subagent.host).settleCompletedTurn(completedTurn() as never);
  assert.equal(subagent.calls.filter((call) => call === "latestPromptMessages").length, 0);
});

test("a turn that ended on silent tool calls says so in its result", async () => {
  const silent = [
    { role: "user", content: "do it" },
    { role: "assistant", content: [{ type: "tool-call", toolName: SLATE_SEND_MESSAGE_TOOL_NAME, toolCallId: "call-1" }] },
    { role: "assistant", content: [{ type: "tool-call", toolName: "Read", toolCallId: "call-2" }] },
  ];
  const { host } = makeHost({ promptMessages: silent });
  const settle = settleFor(host);
  // The shared shape reader is what decides; the result has to agree with it.
  const expected = turnEndedOnSilentToolCalls(silent);
  assert.equal(expected, true);
  await settle.settleCompletedTurn(completedTurn() as never);
  assert.deepEqual(Object.keys(settle.buildResult({ aborted: false })), ["text", "sentMessageCount", "reacted", "aborted", "endedOnSilentToolCalls"]);

  const loud = [{ role: "user", content: "hi" }, { role: "assistant", content: "an answer" }];
  const loudHost = makeHost({ promptMessages: loud });
  const loudSettle = settleFor(loudHost.host);
  await loudSettle.settleCompletedTurn(completedTurn() as never);
  assert.deepEqual(Object.keys(loudSettle.buildResult({ aborted: false })), ["text", "sentMessageCount", "reacted", "aborted"]);
});

test("a visible turn with a name is handed to the post-turn labeler", async () => {
  const messages = [{ role: "user", content: "hi" }];
  const { calls, host } = makeHost({ labeling: "records", labelingMessages: messages });
  await settleFor(host).settleCompletedTurn(completedTurn() as never);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "recordPostTurnLabeling"), [
    ["recordPostTurnLabeling", { conversationId: "conversation-1", requestId: "request-1", modelName: "model-1", messages }],
  ]);
});

test("the post-turn labeler is skipped without a request, without messages, out of sight or when absent", async () => {
  const cases: Array<[string, HostOverrides | null, Record<string, unknown>]> = [
    ["no request id", { labeling: "records", labelingMessages: [{ role: "user", content: "hi" }] }, { requestId: undefined }],
    ["empty request id", { labeling: "records", labelingMessages: [{ role: "user", content: "hi" }] }, { requestId: "" }],
    ["no messages", { labeling: "records" }, {}],
    ["hidden", { labeling: "records", labelingMessages: [{ role: "user", content: "hi" }] }, { hidden: true }],
    ["no labeler", null, {}],
  ];
  for (const [name, overrides, args] of cases) {
    const { calls, host } = makeHost(overrides ?? {});
    await settleFor(host).settleCompletedTurn(completedTurn(args) as never);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "recordPostTurnLabeling"), false, name);
  }
});

test("a labeler that fails is reported without failing the turn", async () => {
  const { calls, host } = makeHost({ labeling: "throws", labelingMessages: [{ role: "user", content: "hi" }] });
  await settleFor(host).settleCompletedTurn(completedTurn() as never);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "reportDiagnostic"), [
    ["reportDiagnostic", { kind: "labeling_failed", stage: "post_turn_record", errorClass: "Error" }],
  ]);
});

test("a memorable exchange is recorded with what the turn said", async () => {
  const memoryCalls: unknown[] = [];
  const episodeCalls: unknown[] = [];
  const scope = {
    memoryStore: {
      recordMemoryEvidence: (input: unknown) => memoryCalls.push(input),
    },
    episodeProgress: {
      clearPendingEpisodeTurns: () => episodeCalls.push("clear"),
      recordEpisodeTurn: () => episodeCalls.push("record"),
      getPendingEpisodeTurns: () => [],
    },
  };
  const { host } = makeHost();
  const settle = settleFor(host, scope);
  settle.collectors.collectText("the answer");
  settle.collectors.collectAgentMessage("first thought");
  settle.collectors.collectAgentMessage("   ");
  settle.collectors.collectAgentMessage("second thought");
  const startedAt = Date.now() - 3_600_000;
  await settle.settleCompletedTurn(completedTurn({ turnStartedAtMs: startedAt }) as never);

  assert.equal(memoryCalls.length, 1);
  const evidence = memoryCalls[0] as { occurredAt: number; user: string; assistant: string };
  assert.equal(evidence.user, "a prompt the user wrote");
  assert.equal(evidence.assistant, "first thought\nsecond thought\nthe answer");
  // The exchange is filed at the turn's own start, not at the time it settled.
  assert.equal(evidence.occurredAt, startedAt);
  assert.deepEqual(episodeCalls, ["clear"]);
});

test("a turn is not remembered when it was superseded, hidden, blank, or the store does not want it", async () => {
  const withStore = () => {
    const memoryCalls: unknown[] = [];
    return { memoryCalls, scope: { memoryStore: { recordMemoryEvidence: (input: unknown) => memoryCalls.push(input) } } };
  };
  const cases: Array<[string, HostOverrides, Record<string, unknown>]> = [
    ["superseded", { isRunSuperseded: true }, {}],
    ["hidden", {}, { hidden: true }],
    ["blank prompt", {}, { trimmedPrompt: "" }],
  ];
  for (const [name, overrides, args] of cases) {
    const { memoryCalls, scope } = withStore();
    const { host } = makeHost(overrides);
    await settleFor(host, scope).settleCompletedTurn(completedTurn(args) as never);
    assert.deepEqual(memoryCalls, [], name);
  }

  // A store that keeps no evidence and a turn that is not memorable is not remembered, and is never read for extraction.
  const extractionCalls: string[] = [];
  const { host, calls } = makeHost({});
  const memorableCalls: string[] = [];
  await settleFor(host, {
    memoryStore: { recall: () => { extractionCalls.push("recall"); return []; }, listMemories: () => { extractionCalls.push("list"); return []; } },
    isMemorableExchange: (prompt: string) => {
      memorableCalls.push(prompt);
      return false;
    },
  }).settleCompletedTurn(completedTurn() as never);
  assert.deepEqual(extractionCalls, []);
  assert.deepEqual(memorableCalls, ["a prompt the user wrote"]);
  assert.equal(calls.some((call) => call === "latestPromptMessages"), true);
});

test("the superseded check comes before the memory store is even looked at", async () => {
  const order: string[] = [];
  // The scope itself remembers when the store is looked at, so the property is defined rather than spread.
  const scope = Object.defineProperty(
    { conversationId: "conversation-1", profilePromptSnapshots: null },
    "memoryStore",
    {
      get() {
        order.push("memoryStore");
        return { recordMemoryEvidence: () => order.push("evidence") };
      },
    },
  );
  const { host } = makeHost();
  const runner = Object.assign(Object.create(host), {
    isRunSuperseded: () => {
      order.push("isRunSuperseded");
      return true;
    },
  });
  await createTurnSettle(runner as never, scope as never).settleCompletedTurn(completedTurn() as never);
  assert.deepEqual(order, ["isRunSuperseded"]);
});

test("a store that keeps no evidence asks the turn whether it is memorable", async () => {
  const memoryCalls: unknown[] = [];
  const memorableCalls: string[] = [];
  const { host } = makeHost({});
  await settleFor(host, {
    memoryStore: { recall: () => [], listMemories: () => [] },
    isMemorableExchange: (prompt: string) => {
      memorableCalls.push(prompt);
      return true;
    },
  }).settleCompletedTurn(completedTurn() as never);
  assert.deepEqual(memorableCalls, ["a prompt the user wrote"]);
  assert.deepEqual(memoryCalls, []);
});