/**
 * Which message a sent one is threaded under, and what happens when a turn is dispatched into a conversation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyAutoReplyThread, resolveSendReplyThreading, validateAiReplyTarget } from "../../source/host/transcript/send-thread-stamping.ts";
import { dispatchUserTurn, type DispatchUserTurnArgs, type RecoverySend } from "../../source/host/transcript/send-turn-dispatch.ts";

/** The conversation a reply is resolved against. */
const conversationEntries = () => [{ id: "entry-1", kind: "message" }, { id: "entry-2", kind: "message" }] as never[];

describe("which message a sent one is threaded under", () => {
  function runtime(options: { resolves?: Record<string, string | undefined>; threadTarget?: string } = {}) {
    const calls: unknown[][] = [];
    const value = {
      turnRuntime: {
        resolveReplyTarget: (list: readonly unknown[], id: string) => { calls.push(["resolve", list.length, id]); return options.resolves?.[id]; },
        buildReplyContext: (list: readonly unknown[], id?: string) => { calls.push(["context", list.length, id ?? null]); return id == null ? { none: true } : { of: id }; },
        replyThreadTargets: new Map<object, string>(),
      },
    };
    if (options.threadTarget !== undefined) value.turnRuntime.replyThreadTargets.set({}, options.threadTarget);
    return { value, calls };
  }

  it("resolves the reply a caller named, and forks only when it resolved", () => {
    const { value, calls } = runtime({ resolves: { "entry-1": "entry-1", unknown: undefined } });
    // Nothing was named: the conversation is not even read, and the context is built without one.
    assert.deepEqual(resolveSendReplyThreading(value as never, undefined, false, conversationEntries), { replyContext: { none: true }, isFork: false });
    assert.deepEqual(calls.map((call) => call[0]), ["context"]);
    // A reply that resolves is threaded, and a fork needs one.
    calls.length = 0;
    assert.deepEqual(resolveSendReplyThreading(value as never, "entry-1", true, conversationEntries), { replyToId: "entry-1", replyContext: { of: "entry-1" }, isFork: true });
    assert.deepEqual(calls.map((call) => call[0]), ["resolve", "context"]);
    // A reply that does not resolve leaves the message unthreaded and unforked, and one that was already there too.
    assert.deepEqual(resolveSendReplyThreading(value as never, "unknown", true, conversationEntries), { replyContext: { none: true }, isFork: false });
    assert.deepEqual(resolveSendReplyThreading(value as never, "entry-1", false, conversationEntries), { replyToId: "entry-1", replyContext: { of: "entry-1" }, isFork: false });
  });

  it("takes a reply away when it points at something that is not there, or at the message itself", () => {
    // A reply to the message being sent, or to nothing that exists, is not a reply.
    assert.deepEqual(validateAiReplyTarget({ type: "text", reply_to: "in-flight" }, "in-flight", conversationEntries()), { type: "text", content: undefined });
    assert.deepEqual(validateAiReplyTarget({ type: "text", reply_to: "gone" }, "in-flight", conversationEntries()), { type: "text", content: undefined });
    // A reply to something that is there is kept, and so is no reply at all.
    assert.deepEqual(validateAiReplyTarget({ type: "text", reply_to: "entry-2" }, "in-flight", conversationEntries()), { type: "text", reply_to: "entry-2" });
    assert.deepEqual(validateAiReplyTarget({ type: "text", reply_to: "" }, undefined, conversationEntries()), { type: "text", reply_to: "" });
    assert.deepEqual(validateAiReplyTarget({ type: "text" }, undefined, conversationEntries()), { type: "text" });
    // A message this build cannot shape is handed on untouched, reply or no reply.
    assert.deepEqual(validateAiReplyTarget({ type: "mystery", reply_to: "gone", keep: 1 }, undefined, conversationEntries()), { type: "mystery", reply_to: "gone", keep: 1 });
  });

  it("fills in the thread a conversation is already under", () => {
    const session = { id: "session-1" };
    const { value } = runtime();
    value.turnRuntime.replyThreadTargets.set(session, "entry-2");
    // A message with no reply of its own takes the thread the conversation is under, when that thread is there.
    assert.deepEqual(applyAutoReplyThread(value as never, { type: "text", content: "hi" }, session, conversationEntries()), { type: "text", content: "hi", reply_to: "entry-2" });
    // A message that already replies to something keeps its own reply.
    assert.deepEqual(applyAutoReplyThread(value as never, { type: "text", content: "hi", reply_to: "entry-1" }, session, conversationEntries()), { type: "text", content: "hi", reply_to: "entry-1" });
    // Without a conversation, and with a thread that is no longer there, nothing is filled in.
    assert.deepEqual(applyAutoReplyThread(value as never, { type: "text", content: "hi" }, null, conversationEntries()), { type: "text", content: "hi" });
    value.turnRuntime.replyThreadTargets.set(session, "gone");
    assert.deepEqual(applyAutoReplyThread(value as never, { type: "text", content: "hi" }, session, conversationEntries()), { type: "text", content: "hi" });
  });
});

describe("dispatching a turn into a conversation", () => {
  function harness(options: { workflowText?: string; memberInterrupted?: boolean; oneToOneInterrupted?: boolean; ackToken?: string; turnFails?: boolean; runnerFails?: boolean } = {}) {
    const calls: unknown[][] = [];
    const session = { id: "session-1" };
    const latestRecoverySends = new Map<string, RecoverySend>();
    const recoveryBreakEpochs = new Map<string, number>();
    const ackTokens: string[] = [];
    const notes: string[] = [];
    const runner = {
      interrupt: (reason: string, interruptOptions: { carriesRecovery: boolean }) => { calls.push(["interrupt", reason, interruptOptions.carriesRecovery]); return options.oneToOneInterrupted ?? false; },
    };
    const tm = {
      runnerRegistry: {
        getRunner: () => runner,
        activeGroupMemberRunners: new Map<string, { interrupt(reason: string): boolean }>([[session.id, { interrupt: (reason: string) => { calls.push(["interrupt-group", reason]); return options.memberInterrupted ?? false; } }]]),
      },
      workflowCommands: {
        expandWorkflowReferences: (target: unknown, prompt: string) => { calls.push(["expand", prompt]); return options.workflowText ?? `expanded(${prompt})`; },
        withMentionedAgentsContext: (target: unknown, prompt: string, expanded: string) => { calls.push(["mention", expanded]); return `${expanded} +mentioned`; },
      },
      runLifecycle: {
        beginSessionRun: (target: unknown) => { calls.push(["begin-run"]); },
        enqueueExclusiveRun: (agentId: string, task: () => Promise<void>, runOptions: { lane: string; source: string; ackToken?: string }) => { calls.push(["enqueue", agentId, runOptions.lane, runOptions.source, runOptions.ackToken ?? null]); return task(); },
      },
      groupChat: { dmPreemptedGroupMemberIds: new Set<string>() },
      backgroundWakes: { dmPreemptedWakeAgentIds: new Set<string>() },
      telemetry: { reportTurnInterrupt: (report: unknown) => { calls.push(["interrupt-report", report]); } },
      ackObligations: {
        confirmAckObligationAfterInterrupt: (target: unknown, acceptedAtMs: number, hadActiveRun: boolean) => { calls.push(["confirm-ack", acceptedAtMs, hadActiveRun]); },
        mintAckRunToken: (agentId: string) => { calls.push(["mint-ack", agentId]); return options.ackToken; },
      },
      turnRuntime: {
        runTurn: async (target: unknown, runRunner: unknown, prompt: string, runArgs: Record<string, unknown>, epoch: number) => {
          calls.push(["run-turn", prompt, epoch, runArgs.messageId ?? null, runArgs.isFork]);
          notes.push(String(runArgs.replyContext === undefined ? "none" : JSON.stringify(runArgs.replyContext)));
          if (options.turnFails === true) throw new Error("the turn failed");
        },
      },
    };
    return { tm, runner, session, latestRecoverySends, recoveryBreakEpochs, ackTokens, notes, calls, kinds: (of: string) => calls.filter((call) => call[0] === of) };
  }

  /** The arguments a send hands the dispatch, on top of the world it runs in. */
  function send(world: ReturnType<typeof harness>, over: Partial<DispatchUserTurnArgs> = {}): DispatchUserTurnArgs {
    return {
      tm: world.tm as never,
      session: world.session as never,
      trimmedPrompt: "hello there",
      awaitTurn: true,
      isFork: false,
      selectedImages: [],
      fileAttachmentPaths: [],
      attachedFileSizes: new Map(),
      acceptedAtMs: 1_000,
      wasInFlight: false,
      readAddressedTranscript: () => [{ id: "entry-1", kind: "message", role: "user", content: "older" }, { id: "entry-2", kind: "message", role: "user", content: "newer", richText: { blocks: [] } }, { id: "entry-3", kind: "message", role: "agent", content: "reply" }] as never,
      latestRecoverySends: world.latestRecoverySends,
      recoveryBreakEpochs: world.recoveryBreakEpochs,
      nextTurnEpoch: () => { world.calls.push(["next-epoch"]); return 7; },
      markSendAccepted: (clientNonce?: string) => { world.calls.push(["accepted", clientNonce ?? null]); },
      ackGuard: { disarm: () => { world.calls.push(["disarm"]); } },
      ...over,
    };
  }

  it("expands the prompt, dispatches it on the conversation's own queue, and accepts the send", async () => {
    const world = harness();
    await dispatchUserTurn(send(world, { clientNonce: "nonce-1", composedAtMs: 5_000, userMessageId: "entry-9" }));
    // What the agent is asked to do is the expanded prompt with the mention context, under the note that it was
    // written while the host was away.
    assert.deepEqual(world.kinds("expand").map((call) => call[1]), ["hello there"]);
    assert.deepEqual(world.kinds("mention").map((call) => call[1]), ["expanded(hello there)"]);
    const ran = world.kinds("run-turn")[0];
    assert.equal(ran?.[1], "[Composed offline at 1970-01-01T00:00:05.000Z]\nexpanded(hello there) +mentioned");
    assert.equal(ran?.[2], 7);
    // The send is accepted and the guard stands down before the turn is awaited.
    assert.deepEqual(world.kinds("accepted").map((call) => call[1]), ["nonce-1"]);
    assert.deepEqual(world.kinds("disarm").length, 1);
    // The turn belongs to the conversation's own lane and the message it came from is remembered so a retry can carry it.
    assert.deepEqual(world.kinds("enqueue").map((call) => [call[1], call[2], call[3], call[4]]), [["session-1", "user", "turn", null]]);
    assert.deepEqual(world.latestRecoverySends.get("session-1")?.recentUserMessages, [{ id: "entry-1", text: "older" }, { id: "entry-2", text: "newer", richText: { blocks: [] } }]);
    assert.deepEqual([...world.recoveryBreakEpochs], []);
  });

  it("does not carry a recovery when the send is a fork or names no message", async () => {
    // A fork breaks the recovery: what it branched from is not what a retry should carry.
    const forked = harness();
    await dispatchUserTurn(send(forked, { isFork: true, userMessageId: "entry-9" }));
    assert.deepEqual(forked.latestRecoverySends.size, 0);
    assert.deepEqual([...forked.recoveryBreakEpochs], [["session-1", 7]]);
    // So does a send with no message of its own.
    const bare = harness();
    await dispatchUserTurn(send(bare));
    assert.deepEqual(bare.latestRecoverySends.size, 0);
    assert.deepEqual([...bare.recoveryBreakEpochs], [["session-1", 7]]);
  });

  it("interrupts what was running, records the interruption, and confirms or mints the acknowledgement", async () => {
    const interrupted = harness({ oneToOneInterrupted: true, memberInterrupted: true, ackToken: "ack-1" });
    await dispatchUserTurn(send(interrupted, { userMessageId: "entry-9", wasInFlight: true }));
    assert.deepEqual(interrupted.kinds("interrupt").map((call) => [call[1], call[2]]), [["superseded by a new user message", true]]);
    assert.deepEqual(interrupted.kinds("interrupt-group").map((call) => call[1]), ["superseded by a direct user message"]);
    assert.deepEqual([...interrupted.tm.groupChat.dmPreemptedGroupMemberIds], ["session-1"]);
    assert.deepEqual([...interrupted.tm.backgroundWakes.dmPreemptedWakeAgentIds], ["session-1"]);
    // What happened is reported with whether a run was really interrupted, and the acknowledgement that was owed for
    // the run just interrupted is confirmed before a new one is minted.
    assert.deepEqual(interrupted.kinds("interrupt-report").map((call) => [call[1], (call[1] as { hadActiveRun: boolean }).hadActiveRun, (call[1] as { wasInFlight: boolean }).wasInFlight]), [[{ conversationId: "session-1", reason: "superseded", hadActiveRun: true, wasInFlight: true }, true, true]]);
    assert.deepEqual(interrupted.kinds("confirm-ack").map((call) => [call[1], call[2]]), [[1_000, true]]);
    assert.deepEqual(interrupted.kinds("mint-ack").map((call) => call[1]), ["session-1"]);
    // The token travels with the queued run and the acknowledgement waits for it.
    assert.deepEqual(interrupted.kinds("enqueue").map((call) => call[4]), ["ack-1"]);
  });

  it("reports a turn that failed once the send was accepted", async () => {
    const world = harness({ turnFails: true });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      // A send that is accepted and then fails is reported rather than thrown at the sender.
      await dispatchUserTurn(send(world, { awaitTurn: false }));
    } finally {
      console.error = originalError;
    }
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    assert.deepEqual(world.kinds("accepted").length, 1);
    assert.equal(errors.some((line) => line.includes("[slate] detached turn failed after send acceptance:")), true);
    // A send that waits for the turn sees the failure.
    const awaited = harness({ turnFails: true });
    await dispatchUserTurn(send(awaited)).then(
      () => assert.fail("a failed turn was reported as a successful send"),
      (error: Error) => assert.equal(error.message, "the turn failed"),
    );
  });
});
