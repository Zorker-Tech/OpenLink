import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dispatchUserTurn } from "../../source/host/transcript/send-turn-dispatch.ts";

function world(options: any = {}) {
  const calls: any[] = [];
  const record = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const session = { id: "conv-1" };
  const runner = { interrupt: (reason: string, info: any) => { record("interrupt", reason, info); return options.runnerInterrupt === true; } };
  const tm = {
    runnerRegistry: { getRunner: () => runner, activeGroupMemberRunners: new Map([[session.id, { interrupt: (reason: string) => { record("groupInterrupt", reason); return options.groupInterrupt === true; } }]]) },
    workflowCommands: {
      withMentionedAgentsContext: (_session: any, prompt: string, expanded: string) => { record("mentions", prompt, expanded); return options.decorate === true ? "[ctx]" + expanded : expanded; },
      expandWorkflowReferences: (_session: any, prompt: string) => { record("expand", prompt); return options.expand === undefined ? prompt : options.expand(prompt); },
    },
    runLifecycle: { beginSessionRun: () => record("beginRun"), enqueueExclusiveRun: (id: string, work: () => Promise<void>, meta: any) => { record("enqueue", id, meta); return work(); } },
    groupChat: { dmPreemptedGroupMemberIds: new Set<string>() },
    backgroundWakes: { dmPreemptedWakeAgentIds: new Set<string>() },
    telemetry: { reportTurnInterrupt: (report: any) => record("reportInterrupt", report) },
    ackObligations: { confirmAckObligationAfterInterrupt: (_session: any, at: number, hadActive: boolean) => record("confirmAck", at, hadActive), mintAckRunToken: () => "token-1" },
    turnRuntime: { runTurn: async (_session: any, _runner: any, prompt: string, runOptions: any, epoch: number) => { record("runTurn", prompt, runOptions, epoch); if (options.turnFailure !== undefined) throw options.turnFailure; } },
  };
  const args = {
    tm, session, trimmedPrompt: "  hello  ", richText: undefined, composedAtMs: options.composedAtMs, enterEpochMs: 10, clientNonce: options.clientNonce,
    awaitTurn: options.awaitTurn !== false, isFork: options.isFork === true, userMessageId: options.userMessageId, replyContext: undefined,
    selectedImages: [], selectedVideos: undefined, fileAttachmentPaths: ["/a"], attachedFileSizes: new Map([["/a", 3]]), traceCtx: undefined,
    acceptedAtMs: 99, wasInFlight: options.wasInFlight === true,
    readAddressedTranscript: () => [{ id: "m1", kind: "message", role: "user", content: "hi", fromAgent: null, channel: null }, { id: "m2", kind: "message", role: "user", content: "skip", fromAgent: "x", channel: null }],
    latestRecoverySends: new Map(), recoveryBreakEpochs: new Map(), nextTurnEpoch: () => 7, markSendAccepted: (nonce: any) => record("accepted", nonce),
    ackGuard: { disarm: () => record("disarm") },
  };
  return { args, calls, tm };
}
const named = (calls: any[], name: string) => calls.filter((call) => call.name === name);
const runOptions = (calls: any[]) => named(calls, "runTurn")[0]!.args[1];

describe("dispatching a user turn", () => {
  it("composes the prompt, queues the run and accepts the send", async () => {
    const worldInstance = world({ decorate: true, expand: (prompt: string) => prompt + "!" });
    await dispatchUserTurn(worldInstance.args as never);
    assert.deepEqual(named(worldInstance.calls, "mentions")[0]!.args, ["  hello  ", "  hello  !"]);
    assert.equal(named(worldInstance.calls, "runTurn")[0]!.args[0], "[ctx]  hello  !");
    const enqueue = named(worldInstance.calls, "enqueue")[0]!;
    assert.equal(enqueue.args[0], "conv-1");
    assert.deepEqual(enqueue.args[1], { lane: "user", source: "turn", acceptedAtMs: 99, ackToken: "token-1" });
    assert.equal(named(worldInstance.calls, "disarm").length, 1);
    assert.deepEqual(named(worldInstance.calls, "accepted")[0]!.args, [undefined]);
    assert.equal((runOptions(worldInstance.calls) as any).ackToken, "token-1");
  });

  it("prefixes the composed offline note", async () => {
    const worldInstance = world({ composedAtMs: 1234 });
    await dispatchUserTurn(worldInstance.args as never);
    assert.equal((named(worldInstance.calls, "runTurn")[0]!.args[0] as string).startsWith("[Composed offline at 1970-01-01T00:00:01.234Z]"), true);
  });

  it("remembers a recovery send and breaks the epoch otherwise", async () => {
    const recovery = world({ userMessageId: "m1" });
    await dispatchUserTurn(recovery.args as never);
    assert.deepEqual([...recovery.args.latestRecoverySends.entries()], [["conv-1", { epoch: 7, messageId: "m1", recentUserMessages: [{ id: "m1", text: "hi" }] }]]);
    const plain = world();
    await dispatchUserTurn(plain.args as never);
    assert.deepEqual([...plain.args.recoveryBreakEpochs.entries()], [["conv-1", 7]]);
    assert.equal((runOptions(plain.calls) as any).recentUserMessages, undefined);
  });

  it("interrupts active runs and records the supersede", async () => {
    const worldInstance = world({ runnerInterrupt: true, groupInterrupt: true, wasInFlight: true });
    await dispatchUserTurn(worldInstance.args as never);
    assert.equal(worldInstance.tm.groupChat.dmPreemptedGroupMemberIds.has("conv-1"), true);
    assert.equal(worldInstance.tm.backgroundWakes.dmPreemptedWakeAgentIds.has("conv-1"), true);
    const report = named(worldInstance.calls, "reportInterrupt")[0]!.args[0] as any;
    assert.deepEqual(report, { conversationId: "conv-1", reason: "superseded", hadActiveRun: true, wasInFlight: true });
    assert.deepEqual(named(worldInstance.calls, "confirmAck")[0]!.args, [99, true]);
  });

  it("does not await a detached turn", async () => {
    const worldInstance = world({ awaitTurn: false });
    await dispatchUserTurn(worldInstance.args as never);
    assert.equal(named(worldInstance.calls, "runTurn").length, 1);
  });

  it("reports a detached failure instead of throwing", async () => {
    const worldInstance = world({ awaitTurn: false, turnFailure: new Error("detached boom") });
    const originalError = console.error;
    const reported: any[][] = [];
    console.error = (...args: unknown[]) => { reported.push(args); };
    try {
      await dispatchUserTurn(worldInstance.args as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      console.error = originalError;
    }
    assert.equal(reported.length >= 1, true);
    assert.equal(String(reported[0]![0]).includes("detached turn failed after send acceptance"), true);
  });
});
