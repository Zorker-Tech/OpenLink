/**
 * Sending a message: admitted once, appended to the timeline and the session, dispatched to the agent or fanned out to
 * a room, and recovered rather than half-done when it cannot be accepted.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { getSlateProfilePath, readSlateProfileFile } from "../../source/host/agents/agent-profile.ts";
import { SendPipeline } from "../../source/host/transcript/send-pipeline.ts";
import { appendEntry, getTranscript, setTranscript } from "../../source/host/transcript/transcript-store.ts";
import { RUNNER_UNATTACHED_MESSAGE, type TranscriptEntry } from "../../source/host/transcript/transcript-hub.ts";

type Call = { name: string; args: unknown[] };
type Session = {
  id: string;
  dbPath: string;
  db: {
    getTranscriptEntries: () => TranscriptEntry[];
    appendTranscriptEntry: (entry: TranscriptEntry) => boolean;
    updateTranscriptEntry: (id: string, update: (entry: TranscriptEntry) => TranscriptEntry) => TranscriptEntry | null;
    deleteTranscriptEntry: (id: string) => boolean;
    setIntroductionPending: (value: boolean) => void;
    getAwaitingUserResponse: () => unknown;
    setAwaitingUserResponse: (value: unknown) => void;
  };
};

/**
 * A transcript manager for one conversation, with the store the timeline reads, the session's own entries, and every
 * call the pipeline makes written down. The real helpers around it (entry ids, message shaping, acceptance echoes) are
 * exercised as they are; only the manager is a stand-in.
 */
function world(
  options: {
    entries?: TranscriptEntry[];
    sessionEntries?: TranscriptEntry[];
    onScreen?: boolean;
    sessionId?: string;
    canExecute?: boolean;
    runnerInterrupt?: boolean;
    groupMemberInterrupt?: boolean;
    remote?: boolean;
    group?: boolean;
    admit?: { kind: string; [key: string]: unknown };
    appendsDurable?: boolean;
    persistOutcome?: boolean;
    failAppendOn?: number;
    expand?: (prompt: string) => string;
    decorateMentions?: boolean;
    holdTurn?: Promise<void>;
    runningAgentIds?: string[];
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "slate-send-pipeline-"));
  const storeEntries = structuredClone(options.entries ?? []);
  const sessionEntries = structuredClone(options.sessionEntries ?? options.entries ?? []);
  setTranscript(storeEntries);
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const onScreen = options.onScreen !== false;
  const sessionId = options.sessionId ?? "agent-1";
  let appendCount = 0;
  const session: Session = {
    id: sessionId,
    dbPath: join(directory, "conversation.db"),
    db: {
      getTranscriptEntries: () => sessionEntries,
      appendTranscriptEntry: (entry: TranscriptEntry) => {
        const durable = options.appendsDurable !== false;
        if (durable) sessionEntries.push(entry);
        return durable;
      },
      updateTranscriptEntry: (id: string, update: (entry: TranscriptEntry) => TranscriptEntry) => {
        const index = sessionEntries.findIndex((entry) => entry.id === id);
        if (index < 0) return null;
        const updated = update(sessionEntries[index] as TranscriptEntry);
        sessionEntries[index] = updated;
        return updated;
      },
      deleteTranscriptEntry: (id: string) => {
        const index = sessionEntries.findIndex((entry) => entry.id === id);
        if (index >= 0) sessionEntries.splice(index, 1);
        record("deleteTranscriptEntry", id);
        return index >= 0;
      },
      setIntroductionPending: (value: boolean) => record("setIntroductionPending", value),
      getAwaitingUserResponse: () => null,
      setAwaitingUserResponse: (value: unknown) => record("setAwaitingUserResponse", value),
    },
  };
  const tm = {
    execution: { canExecute: options.canExecute !== false },
    sessions: {
      activeSession: onScreen ? session : null,
      inMemoryTranscriptAgentId: onScreen ? sessionId : undefined,
      liveSessions: new Map<string, unknown>([[sessionId, session]]),
      ensureSession: async () => {
        record("ensureSession");
        return session;
      },
      ensureActionTarget: async (agentId?: string) => record("ensureActionTarget", agentId),
      isAgentGone: () => false,
    },
    sessionStore: {
      markSessionActivity: (target: Session) => record("markSessionActivity", target.id),
      openSession: async () => session,
    },
    groupChat: {
      isGroupSession: () => options.group === true,
      isRemoteRoomSession: () => options.remote === true,
      pinMemberSessionForGroupTurn: async (agentId: string) => {
        record("pinMemberSession", agentId);
        return session;
      },
      runGroupTurn: async (target: Session, epoch: number, traceCtx: unknown, source: string) => {
        record("runGroupTurn", target.id, epoch, traceCtx, source);
      },
      dmPreemptedGroupMemberIds: new Set<string>(),
    },
    sharedRooms: {
      dispatchMirrorRoomSend: async (target: Session, args: unknown) => record("dispatchMirrorRoomSend", target.id, args),
    },
    xuserDelegate: { publishRoomEntry: (roomId: string, entry: TranscriptEntry) => record("publishRoomEntry", roomId, entry.id) },
    runnerRegistry: {
      getRunner: () => ({ interrupt: (reason: string, info?: unknown) => { record("runnerInterrupt", reason, info); return options.runnerInterrupt === true; } }),
      activeGroupMemberRunners: new Map<string, { interrupt: (reason: string) => boolean }>([
        [sessionId, { interrupt: (reason: string) => { record("groupMemberInterrupt", reason); return options.groupMemberInterrupt === true; } }],
      ]),
    },
    backgroundWakes: { dmPreemptedWakeAgentIds: new Set<string>() },
    runLifecycle: {
      runningAgentIds: () => new Set<string>(options.runningAgentIds ?? []),
      beginSessionRun: (target: Session) => record("beginSessionRun", target.id),
      endSessionRun: (target: Session) => record("endSessionRun", target.id),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => {
        record("enqueueExclusiveRun", id, meta);
        return await work();
      },
    },
    telemetry: {
      reportUserMessageReceived: (report: unknown) => record("reportUserMessageReceived", report),
      reportTurnInterrupt: (report: unknown) => record("reportTurnInterrupt", report),
    },
    ackObligations: {
      recordAckObligationSend: (target: Session) => record("recordAckObligationSend", target.id),
      armSendGuard: (target: Session, acceptedAtMs: number, owesAck: boolean) => {
        record("armSendGuard", target.id, owesAck);
        return { disarm: () => record("disarm"), [Symbol.dispose]: () => record("guardDispose") };
      },
      confirmAckObligationAfterInterrupt: (target: Session, acceptedAtMs: number, hadActiveRun: boolean) => record("confirmAckObligationAfterInterrupt", target.id, hadActiveRun),
      mintAckRunToken: (id: string) => {
        record("mintAckRunToken", id);
        return "ack-token-1";
      },
    },
    acceptanceLedger: {
      admitSend: (args: unknown) => {
        record("admitSend", args);
        return options.admit ?? { kind: "accepted" };
      },
      recordPending: (args: unknown) => record("recordPending", args),
      markAccepted: (args: unknown) => record("markAccepted", args),
      clearUnlessAccepted: (args: unknown) => record("clearUnlessAccepted", args),
      lookup: (args: unknown) => {
        record("lookup", args);
        return "acceptance-status";
      },
    },
    turnRuntime: {
      resolveReplyTarget: (entries: readonly TranscriptEntry[], id: string) => (entries.some((entry) => entry.id === id) ? id : undefined),
      buildReplyContext: (entries: readonly TranscriptEntry[], id?: string) => (id == null ? undefined : { replyToId: id }),
      runTurn: async (target: Session, runner: unknown, prompt: string, runOptions: unknown, epoch: number) => {
        record("runTurn", target.id, prompt, runOptions, epoch);
        if (options.holdTurn !== undefined) await options.holdTurn;
      },
      replyThreadTargets: new Map<object, string>(),
    },
    workflowCommands: {
      expandWorkflowReferences: (_target: Session, prompt: string) => {
        record("expandWorkflowReferences", prompt);
        return options.expand === undefined ? prompt : options.expand(prompt);
      },
      withMentionedAgentsContext: (_target: Session, prompt: string, expanded: string) => {
        record("withMentionedAgentsContext", prompt, expanded);
        return options.decorateMentions === true ? `[context]${expanded}` : expanded;
      },
    },
    roster: {
      emit: (event: unknown, agentId?: string) => record("emit", event, agentId),
      emitAgentUpdate: async (agentId: string) => record("emitAgentUpdate", agentId),
      appendOutlineItem: (item: unknown) => record("appendOutlineItem", item),
      lastKnownAgentNames: new Map<string, string>(),
      outlineAgentId: undefined as string | undefined,
      streamingAssistantOutlineId: undefined as string | undefined,
      streamingThinkingOutlineId: undefined as string | undefined,
    },
    trayErrors: {
      clearForAgent: (agentId: string) => record("clearForAgent", agentId),
      pushError: (error: unknown) => record("pushError", error),
    },
    attachments: {
      readImageDimensions: async (path: string) => {
        record("readImageDimensions", path);
        return null;
      },
    },
    appendEntry: (entry: TranscriptEntry, appendOptions?: { persistBeforeEmit?: boolean; deferEmit?: boolean; onPersistOutcome?: (durable: boolean) => void }) => {
      appendCount += 1;
      if (options.failAppendOn === appendCount) throw new Error("the entry could not be appended");
      record("appendEntry", entry.id, appendOptions?.persistBeforeEmit, appendOptions?.deferEmit);
      appendEntry(entry);
      appendOptions?.onPersistOutcome?.(options.persistOutcome !== false);
      return entry;
    },
    resolveBoxRequestEntry: async (agentId: string, requestId: string, resolution: string) => record("resolveBoxRequestEntry", agentId, requestId, resolution),
    createAttachmentIngestor: () => async (path: string) => {
      record("ingest", path);
      return `${path}.ingested`;
    },
  };
  const pipeline = new SendPipeline(tm);
  return {
    pipeline,
    tm,
    session,
    calls,
    directory,
    stored: () => getTranscript(),
    named: (name: string) => calls.filter((call) => call.name === name),
    dispatched: () => {
      const run = calls.filter((call) => call.name === "runTurn").at(-1);
      return run === undefined ? null : { prompt: run.args[1] as string, options: run.args[2] as Record<string, unknown>, epoch: run.args[3] as number };
    },
  };
}

const assistantMessage = (id = "m0"): TranscriptEntry => ({ id, kind: "message", role: "assistant", content: "earlier" });

describe("a send is admitted once", () => {
  it("coalesces a retried nonce onto the attempt still running and skips one already accepted", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = world({ holdTurn: held });
    const first = running.pipeline.sendPrompt("hello", { clientNonce: "nonce-1" });
    const second = running.pipeline.sendPrompt("hello", { clientNonce: "nonce-1" });
    // Both calls were made while the first attempt was still running, and it is the only attempt between them.
    assert.equal(running.pipeline.inFlightSends.size, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(running.named("runTurn").length, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(running.named("runTurn").length, 1);
    assert.equal(running.named("admitSend").length, 1);
    // A nonce the ledger already accepted is an idempotent no-op.
    const duplicate = world({ admit: { kind: "duplicate", existingAgentId: "agent-1" } });
    await duplicate.pipeline.sendPrompt("hello", { clientNonce: "nonce-2" });
    assert.equal(duplicate.named("runTurn").length, 0);
    assert.equal(duplicate.named("appendEntry").length, 0);
    assert.equal(duplicate.named("admitSend").length, 1);
    // A send that fails is cleared from the ledger unless it was accepted, so it can be retried.
    const failing = world();
    failing.tm.turnRuntime.runTurn = async () => {
      throw new Error("dispatch failed");
    };
    await assert.rejects(() => failing.pipeline.sendPrompt("hello", { clientNonce: "nonce-3" }), /dispatch failed/);
    assert.deepEqual(failing.named("clearUnlessAccepted")[0]?.args, [{ accountSlot: "host", clientNonce: "nonce-3" }]);
    // Without a nonce there is nothing to admit or coalesce.
    const plain = world();
    await plain.pipeline.sendPrompt("hello", {});
    assert.equal(plain.named("admitSend").length, 0);
    assert.equal(plain.named("runTurn").length, 1);
  });

  it("digests what was sent, so the same input admits to the same digest and a different one does not", async () => {
    const world1 = world();
    await world1.pipeline.sendPrompt("hello", { clientNonce: "n1", agentId: "agent-1" });
    await world1.pipeline.sendPrompt("hello", { clientNonce: "n2", agentId: "agent-1" });
    await world1.pipeline.sendPrompt("hello there", { clientNonce: "n3", agentId: "agent-1" });
    const digests = world1.named("admitSend").map((call) => (call.args[0] as { inputDigest: string }).inputDigest);
    assert.equal(typeof digests[0], "string");
    assert.equal(digests[0], digests[1]);
    assert.notEqual(digests[0], digests[2]);
    // The message and the ids around it are what go into the ledger's record of a pending send.
    const pending = world1.named("recordPending")[0]?.args[0] as { accountSlot: string; clientNonce: string; agentId: string; echoEntryId: string };
    assert.equal(pending.accountSlot, "host");
    assert.equal(pending.clientNonce, "n1");
    assert.equal(pending.agentId, "agent-1");
    assert.equal(pending.echoEntryId, "t0u");
    // Nothing is recorded when the caller sent no nonce.
    assert.equal(world1.named("recordPending").length, 3);
  });
});

describe("what a send appends", () => {
  it("writes the message to the timeline and the session, then hands the turn to the agent", async () => {
    const world1 = world({ entries: [assistantMessage()] });
    await world1.pipeline.sendPromptOnce("  hello  ", {});
    // The conversation is put in the state a user's message implies.
    assert.deepEqual(world1.named("setIntroductionPending")[0]?.args, [false]);
    assert.deepEqual(world1.named("reportUserMessageReceived")[0]?.args, [{ conversationId: "agent-1", wasInFlight: false }]);
    assert.deepEqual(world1.named("clearForAgent")[0]?.args, ["agent-1"]);
    // The entry is appended with the echo options that make persistence observable, and shipped to the roster.
    assert.deepEqual(world1.named("appendEntry")[0]?.args, ["t0u", true, true]);
    const entry = world1.stored().find((candidate) => candidate.id === "t0u");
    assert.equal(entry?.kind, "message");
    assert.equal(entry?.role, "user");
    assert.equal(entry?.content, "hello");
    assert.deepEqual(world1.named("emit")[0]?.args[0], { type: "appended", entry });
    // What was dispatched is the trimmed prompt, threaded onto the turn's own ids.
    assert.deepEqual(world1.dispatched()?.prompt, "hello");
    const options = world1.dispatched()?.options ?? {};
    assert.equal(options.messageId, "t0u");
    assert.equal(options.isFork, false);
    assert.equal(options.ackToken, "ack-token-1");
    assert.deepEqual(options.selectedImages, []);
    assert.deepEqual(options.attachedFilePaths, []);
    assert.equal(options.attachedFileSizes instanceof Map, true);
    assert.equal(world1.dispatched()?.epoch, 1);
    // The acknowledgement is owed on a one-to-one conversation, and the guard is released when the send is done.
    assert.deepEqual(world1.named("recordAckObligationSend")[0]?.args, ["agent-1"]);
    assert.equal(world1.named("armSendGuard").length, 1);
    assert.equal(world1.named("guardDispose").length, 1);
    assert.deepEqual(world1.named("endSessionRun")[0]?.args, ["agent-1"]);
    // The turn can be recovered from what was sent.
    assert.deepEqual(world1.pipeline.latestRecoverySends.get("agent-1")?.messageId, "t0u");
    assert.deepEqual(world1.pipeline.latestRecoverySends.get("agent-1")?.recentUserMessages, [{ id: "t0u", text: "hello" }]);
    assert.equal(world1.pipeline.recoveryBreakEpochs.size, 0);
    assert.equal(world1.pipeline.currentTurnEpoch({ id: "agent-1" }), 1);
  });

  it("does nothing for a send that carries neither words nor attachments, even with no runner attached", async () => {
    const empty = world({ canExecute: false });
    await empty.pipeline.sendPromptOnce("   ", {});
    assert.equal(empty.calls.length, 0);
    // A send with something in it needs a runner.
    await assert.rejects(() => empty.pipeline.sendPromptOnce("hello", {}), new RegExp(RUNNER_UNATTACHED_MESSAGE));
  });

  it("sends the prompt through the workflow wording and puts an offline note in front of it", async () => {
    const world1 = world({ entries: [assistantMessage()], expand: (prompt) => `${prompt} + work`, decorateMentions: true });
    await world1.pipeline.sendPromptOnce("do it", { richText: "**do it**", composedAtMs: 1_700_000_000_000 });
    assert.deepEqual(world1.named("expandWorkflowReferences")[0]?.args, ["do it"]);
    assert.deepEqual(world1.named("withMentionedAgentsContext")[0]?.args, ["do it", "do it + work"]);
    const expected = `[Composed offline at 2023-11-14T22:13:20.000Z]\n[context]do it + work`;
    assert.equal(world1.dispatched()?.prompt, expected);
    assert.deepEqual(world1.dispatched()?.options.richText, "**do it**");
  });

  it("stamps the reply a fork asked for, and lets the entry carry the thread instead of the recovery path", async () => {
    const forked = world({ entries: [assistantMessage("m1")] });
    await forked.pipeline.sendPromptOnce("branch here", { replyToId: "m1", isFork: true });
    const entry = forked.stored().find((candidate) => candidate.id === "t0u");
    assert.equal(entry?.replyTo, "m1");
    assert.equal(entry?.branched, true);
    assert.equal(forked.dispatched()?.options.isFork, true);
    assert.deepEqual(forked.dispatched()?.options.replyContext, { replyToId: "m1" });
    assert.equal(forked.pipeline.latestRecoverySends.size, 0);
    assert.equal(forked.pipeline.recoveryBreakEpochs.get("agent-1"), 1);
    // A reply target that is no longer there is dropped rather than stamped.
    const gone = world({ entries: [assistantMessage("m1")] });
    await gone.pipeline.sendPromptOnce("hello", { replyToId: "missing", isFork: true });
    assert.equal(gone.stored().find((candidate) => candidate.id === "t0u")?.replyTo, undefined);
    assert.equal(gone.dispatched()?.options.isFork, false);
  });

  it("carries attachments with their sizes and names, and marks the images apart from the files", async () => {
    const world1 = world({ entries: [assistantMessage()] });
    const image = join(world1.directory, "chart.png");
    const notes = join(world1.directory, "notes.txt");
    writeFileSync(image, "not really a png", "utf8");
    writeFileSync(notes, "twelve bytes", "utf8");
    await world1.pipeline.sendPromptOnce("look at these", {
      attachmentPaths: [image, notes],
      attachmentNames: ["chart.png"],
      clientNonce: "nonce-attach",
    });
    const stored = world1.stored();
    const attachment = stored.find((candidate) => candidate.id === "t0ua0");
    assert.equal(attachment?.kind, "user-attachment");
    assert.equal(attachment?.file_path, image);
    assert.equal(attachment?.file_name, "chart.png");
    assert.equal(attachment?.byteSize, 16);
    assert.equal(attachment?.clientNonce, "nonce-attach");
    // Both entries of one send share the batch the attachment was minted under.
    const message = stored.find((candidate) => candidate.id === "t0u");
    assert.equal(typeof message?.batchId, "string");
    assert.equal(message?.batchId, attachment?.batchId);
    assert.deepEqual(world1.named("readImageDimensions")[0]?.args, [image]);
    // The image is loaded for the agent, the file is listed as an attachment, and the sizes travel with it.
    const selected = world1.dispatched()?.options.selectedImages as Array<{ path: string; mimeType: string }>;
    assert.deepEqual(selected.map((input) => [input.path, input.mimeType]), [[image, "image/png"]]);
    assert.deepEqual(world1.dispatched()?.options.attachedFilePaths, [notes]);
    const sizes = world1.dispatched()?.options.attachedFileSizes as Map<string, number>;
    assert.deepEqual([...sizes], [[image, 16], [notes, 12]]);
    // With no user message appended, the attachment stands in as the entry the acceptance ledger records.
    const attachmentOnly = world({ entries: [assistantMessage()] });
    const file = join(attachmentOnly.directory, "only.txt");
    writeFileSync(file, "x", "utf8");
    await attachmentOnly.pipeline.sendPrompt("", { attachmentPaths: [file], clientNonce: "nonce-only", appendUserMessage: false });
    const recorded = attachmentOnly.named("recordPending")[0]?.args[0] as { echoEntryId: string; agentId: string };
    assert.deepEqual([recorded.agentId, recorded.echoEntryId], ["agent-1", "t0ua0"]);
    assert.equal(attachmentOnly.pipeline.latestRecoverySends.size, 0);
  });

  it("puts an entry back when the send could not be appended after all", async () => {
    const world1 = world({ entries: [assistantMessage()], failAppendOn: 2 });
    await assert.rejects(() => world1.pipeline.sendPromptOnce("hello", { attachmentPaths: [join(world1.directory, "a.txt")] }), /could not be appended/);
    // The attachment that did land is removed from both the session and the timeline.
    assert.equal(world1.session.db.getTranscriptEntries().some((entry) => entry.id === "t0ua0"), false);
    assert.equal(world1.stored().some((entry) => entry.id === "t0ua0"), false);
    assert.deepEqual(world1.named("deleteTranscriptEntry")[0]?.args, ["t0ua0"]);
    assert.equal(world1.named("runTurn").length, 0);
  });

  it("carries a send that was only accepted on the session's own entries, and says so when it was not durable", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    let offscreen;
    let nonDurable;
    try {
      offscreen = world({ entries: [assistantMessage()], onScreen: false });
      await offscreen.pipeline.sendPromptOnce("hello", { directAddressedAcceptance: true });
      nonDurable = world({ entries: [assistantMessage()], persistOutcome: false });
      await nonDurable.pipeline.sendPromptOnce("hello", {});
    } finally {
      console.warn = originalWarn;
    }
    // A send to a conversation that is not on screen does not need an action target resolved for it.
    assert.equal(offscreen.named("ensureActionTarget").length, 0);
    assert.equal(offscreen.session.db.getTranscriptEntries().some((entry) => entry.id === "t0u"), true);
    assert.deepEqual(offscreen.named("markSessionActivity")[0]?.args, ["agent-1"]);
    assert.deepEqual(offscreen.named("emit")[0]?.args[1], "agent-1");
    assert.equal(offscreen.named("runTurn").length, 1);
    // A persist that was reported as not durable is called out rather than hidden.
    assert.equal(warnings.some((line) => line.includes("NON-durably")), true);
  });

  it("waits for the turn by default, and hands it off when the caller asks not to wait", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = world({ entries: [assistantMessage()], holdTurn: held });
    let settled = false;
    const pending = waiting.pipeline.sendPromptOnce("hello", {}).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([settled, waiting.named("runTurn").length], [false, 1]);
    release();
    await pending;
    assert.equal(settled, true);
    // A caller that does not wait gets its send accepted while the turn carries on by itself.
    let handOff: () => void = () => {};
    const handOffHeld = new Promise<void>((resolve) => {
      handOff = resolve;
    });
    const detached = world({ entries: [assistantMessage()], holdTurn: handOffHeld });
    await detached.pipeline.sendPromptOnce("hello", { awaitTurn: false });
    assert.equal(detached.named("runTurn").length, 1);
    handOff();
  });

  it("says which agent was interrupted for this message, and which wake was preempted", async () => {
    const interrupted = world({ entries: [assistantMessage()], runnerInterrupt: true, groupMemberInterrupt: true, runningAgentIds: ["agent-1"] });
    await interrupted.pipeline.sendPromptOnce("hello", {});
    assert.deepEqual(interrupted.named("reportUserMessageReceived")[0]?.args, [{ conversationId: "agent-1", wasInFlight: true }]);
    assert.equal(interrupted.named("groupMemberInterrupt")[0]?.args[0], "superseded by a direct user message");
    assert.equal(interrupted.named("runnerInterrupt")[0]?.args[0], "superseded by a new user message");
    assert.deepEqual((interrupted.named("runnerInterrupt")[0]?.args[1] as { carriesRecovery: boolean }).carriesRecovery, true);
    assert.equal(interrupted.tm.groupChat.dmPreemptedGroupMemberIds.has("agent-1"), true);
    assert.equal(interrupted.tm.backgroundWakes.dmPreemptedWakeAgentIds.has("agent-1"), true);
    assert.deepEqual(interrupted.named("reportTurnInterrupt")[0]?.args, [{ conversationId: "agent-1", reason: "superseded", hadActiveRun: true, wasInFlight: true }]);
    assert.deepEqual(interrupted.named("confirmAckObligationAfterInterrupt")[0]?.args, ["agent-1", true]);
  });
});

describe("sends that belong to a room", () => {
  it("mirrors a send into the room it belongs to, without owing an acknowledgement", async () => {
    const mirrored = world({ entries: [assistantMessage()], remote: true, sessionId: "room-1" });
    await mirrored.pipeline.sendPromptOnce("hello room", { clientNonce: "nonce-room" });
    const args = mirrored.named("dispatchMirrorRoomSend")[0]?.args[1] as { text: string; hasNonImageAttachments: boolean; clientNonce: string };
    assert.equal(args.text, "hello room");
    assert.equal(args.hasNonImageAttachments, false);
    assert.equal(args.clientNonce, "nonce-room");
    assert.deepEqual(mirrored.named("markAccepted")[0]?.args, [{ accountSlot: "host", clientNonce: "nonce-room" }]);
    // A room send owes no acknowledgement and is not reported as a one-to-one message.
    assert.equal(mirrored.named("recordAckObligationSend").length, 0);
    assert.deepEqual(mirrored.named("armSendGuard")[0]?.args, ["room-1", false]);
    // Only a group conversation is left out of the user-message report.
    assert.deepEqual(mirrored.named("reportUserMessageReceived")[0]?.args, [{ conversationId: "room-1", wasInFlight: false }]);
    assert.equal(mirrored.named("runTurn").length, 0);
  });

  it("runs a group turn under the group's own epoch", async () => {
    const group = world({ entries: [assistantMessage()], group: true, sessionId: "group-1" });
    await group.pipeline.sendPromptOnce("hello group", { clientNonce: "nonce-group" });
    assert.deepEqual(group.named("runGroupTurn")[0]?.args, ["group-1", 1, undefined, "user"]);
    assert.deepEqual(group.named("enqueueExclusiveRun")[0]?.args, ["group-1", { lane: "user", source: "group", acceptedAtMs: group.named("runGroupTurn").length > 0 ? (group.named("enqueueExclusiveRun")[0]?.args[1] as { acceptedAtMs: number }).acceptedAtMs : 0 }]);
    assert.equal(group.named("markAccepted").length, 1);
    assert.equal(group.named("beginSessionRun").length, 1);
    assert.equal(group.named("runTurn").length, 0);
    assert.equal(group.named("reportUserMessageReceived").length, 0);
    // No shared room was configured for this group, so nothing is published into one.
    assert.equal(group.named("publishRoomEntry").length, 0);
  });
});

describe("what the send leaves for the rest of the host", () => {
  it("seeds a new conversation's name from its first message, and leaves a named agent alone", async () => {
    const fresh = world({ entries: [] });
    await fresh.pipeline.sendPromptOnce("  Fix   the parser  ", {});
    const profilePath = getSlateProfilePath(fresh.directory);
    assert.equal(readSlateProfileFile(profilePath)?.name, "Fix the parser");
    assert.equal(fresh.tm.roster.lastKnownAgentNames.get("agent-1"), "Fix the parser");
    assert.deepEqual(fresh.named("emitAgentUpdate")[0]?.args, ["agent-1"]);
    // An agent that already has a name is not renamed by the message, and the roster is not refreshed for it.
    const named = world({ entries: [] });
    writeFileSync(getSlateProfilePath(named.directory), JSON.stringify({ name: "Careful Bot" }), "utf8");
    await named.pipeline.sendPromptOnce("hello", {});
    assert.equal(named.named("emitAgentUpdate").length, 0);
    assert.equal((named.stored().find((entry) => entry.id === "t0u") as { content: string }).content, "hello");
  });

  it("clears the streaming outline for the agent that is showing this conversation", async () => {
    const world1 = world({ entries: [assistantMessage()] });
    world1.tm.roster.outlineAgentId = "agent-1";
    world1.tm.roster.streamingAssistantOutlineId = "outline-a";
    world1.tm.roster.streamingThinkingOutlineId = "outline-t";
    await world1.pipeline.sendPromptOnce("hello", {});
    assert.equal(world1.tm.roster.streamingAssistantOutlineId, undefined);
    assert.equal(world1.tm.roster.streamingThinkingOutlineId, undefined);
    const item = world1.named("appendOutlineItem")[0]?.args[0] as { kind: string; text: string; id: string; timestampMs: number };
    assert.equal(item.kind, "user");
    assert.equal(item.text, "hello");
    assert.match(item.id, /^[0-9a-f-]{36}$/);
    assert.equal(typeof item.timestampMs, "number");
    // A send that carries no words adds nothing to the outline.
    const silent = world({ entries: [assistantMessage()] });
    silent.tm.roster.outlineAgentId = "agent-1";
    const file = join(silent.directory, "a.txt");
    writeFileSync(file, "x", "utf8");
    await silent.pipeline.sendPromptOnce("", { attachmentPaths: [file], appendUserMessage: false });
    assert.equal(silent.named("appendOutlineItem").length, 0);
    // A conversation that is not the one on screen leaves the outline alone.
    const other = world({ entries: [assistantMessage()] });
    other.tm.roster.outlineAgentId = "someone-else";
    await other.pipeline.sendPromptOnce("hello", {});
    assert.equal(other.named("appendOutlineItem").length, 0);
  });
});

describe("the small errands the pipeline runs", () => {
  it("reports acceptance, counts epochs, mints one attachment batch per conversation, and tracks box requests", async () => {
    const world1 = world({ entries: [assistantMessage()] });
    assert.equal(world1.pipeline.promptAcceptanceStatus({ accountSlot: "host", clientNonce: "n1" }), "acceptance-status");
    assert.deepEqual(world1.named("lookup")[0]?.args, [{ accountSlot: "host", clientNonce: "n1" }]);
    world1.pipeline.markSendAccepted("n1");
    world1.pipeline.markSendAccepted(undefined);
    assert.deepEqual(world1.named("markAccepted")[0]?.args, [{ accountSlot: "host", clientNonce: "n1" }]);
    assert.equal(world1.named("markAccepted").length, 1);
    assert.deepEqual([world1.pipeline.currentTurnEpoch({ id: "a" }), world1.pipeline.nextTurnEpoch({ id: "a" }), world1.pipeline.nextTurnEpoch({ id: "a" }), world1.pipeline.currentTurnEpoch({ id: "a" })], [0, 1, 2, 2]);
    const batch = world1.pipeline.claimSendAttachmentBatchId("a");
    assert.equal(world1.pipeline.claimSendAttachmentBatchId("a"), batch);
    assert.notEqual(world1.pipeline.claimSendAttachmentBatchId("b"), batch);
    // Appending a send-message entry teaches the box-request tracker before the entry reaches the timeline.
    world1.pipeline.appendSendMessageEntry({ id: "s1", kind: "send-message", boxRequestId: "req-1", message: { type: "text", content: "x" } });
    assert.equal(world1.named("appendEntry")[0]?.args[0], "s1");
    assert.equal(world1.pipeline.boxRequests.activeBoxRequest?.requestId, "req-1");
    // Resolving it goes through the same tracker and settles the entry it belongs to.
    world1.tm.sessions.liveSessions.set("agent-1", world1.session);
    world1.session.db.getTranscriptEntries().push({ id: "s1", kind: "send-message", boxRequestId: "req-1", message: { type: "text", content: "x" } });
    await world1.pipeline.resolveBoxRequestEntry("agent-1", "req-1", "approved");
    assert.equal(world1.session.db.getTranscriptEntries().find((entry) => entry.id === "s1")?.boxResolution, "approved");
    assert.equal(world1.pipeline.boxRequests.activeBoxRequest, null);
  });

  it("appends a connector card for the addressed conversation", async () => {
    const world1 = world({ entries: [assistantMessage()] });
    await world1.pipeline.appendConnectorCard({ agentId: "agent-1", connector: "slack", variant: "needs-auth", reason: "the token expired" });
    assert.deepEqual(world1.named("ensureActionTarget")[0]?.args, ["agent-1"]);
    const entry = world1.stored().find((candidate) => candidate.kind === "send-message");
    assert.equal(entry?.id, "tbs0");
    assert.deepEqual(entry?.message, { type: "connector", connector: "slack", variant: "needs-auth", reason: "the token expired" });
    // Without a reason there is no reason field at all.
    await world1.pipeline.appendConnectorCard({ connector: "slack", variant: "ready" });
    assert.deepEqual(world1.stored().find((candidate) => candidate.id === "tbs1")?.message, { type: "connector", connector: "slack", variant: "ready" });
  });

  it("ingests a dev message's attachment before appending it", async () => {
    const world1 = world({ entries: [assistantMessage()] });
    const resolved = await world1.pipeline.resolveDevSendMessage({
      type: "attachment",
      url: `file:///tmp/attachments/cat.png`,
      alt: "a cat",
      channel: "screen",
      width: 10,
      height: 20,
      reply_to: "m0",
    });
    assert.equal(resolved.url, "file:///tmp/attachments/cat.png.ingested");
    assert.deepEqual([resolved.alt, resolved.channel, resolved.width, resolved.height, resolved.reply_to, resolved.file_name], ["a cat", "screen", 10, 20, "m0", "cat.png"]);
    // Anything that is not an attachment, or has no conversation, is handed back untouched.
    const other = world({ entries: [assistantMessage()] });
    assert.deepEqual(await other.pipeline.resolveDevSendMessage({ type: "text", content: "hi" }), { type: "text", content: "hi" });
    const noSession = world({ entries: [assistantMessage()], onScreen: false });
    const untouched = { type: "attachment", url: "file:///tmp/a.txt" };
    assert.deepEqual(await noSession.pipeline.resolveDevSendMessage(untouched), untouched);
    // The appended entry carries the resolved message.
    await other.pipeline.devAppendSendMessage({ type: "attachment", url: "file:///tmp/b.txt" });
    const appended = other.stored().find((candidate) => candidate.kind === "send-message")?.message as Record<string, unknown> | undefined;
    assert.equal(appended?.url, "file:///tmp/b.txt.ingested");
  });
});
